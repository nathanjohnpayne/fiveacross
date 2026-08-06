import { describe, it, expect, vi, afterEach } from 'vitest';

// posthog-js is mocked so no real SDK loads; VITE_POSTHOG_KEY is unset in the
// base test env, so the statically-imported module stays in its disabled state.
vi.mock('posthog-js', () => ({
  default: { init: vi.fn(), capture: vi.fn(), identify: vi.fn(), reset: vi.fn(), register: vi.fn() },
}));

import posthog from 'posthog-js';
import {
  POSTHOG_INIT_OPTIONS,
  POSTHOG_PROXY_HOST,
  POSTHOG_DIRECT_HOST,
  POSTHOG_PERSONAL_PROXY_HOST,
  POSTHOG_INGEST_HOSTS,
  pickIngestHost,
  envHostBypassesProbe,
  ingestHostAlive,
  posthogReady,
  phCapture,
  phIdentify,
  phRegister,
  phReset,
  isLocalDevHost,
  stripUrlSecrets,
  sanitizeUrls,
} from './posthog';
import { applyResolvedCanonicalHost } from './canonicalHost';

describe('URL hygiene — sanitizeUrls / stripUrlSecrets (#195)', () => {
  it('strips query and hash from absolute URLs, keeping origin + path', () => {
    expect(stripUrlSecrets('https://gaycruisebingo.com/__/auth/handler?code=SECRET&state=x')).toBe(
      'https://gaycruisebingo.com/__/auth/handler',
    );
    expect(stripUrlSecrets('https://gaycruisebingo.com/feed#token=abc')).toBe(
      'https://gaycruisebingo.com/feed',
    );
  });

  it('strips query/hash from relative paths and passes non-strings through', () => {
    expect(stripUrlSecrets('/items?t=secret#frag')).toBe('/items');
    expect(stripUrlSecrets(undefined)).toBeUndefined();
    expect(stripUrlSecrets(42)).toBe(42);
  });

  it('before_send scrubs URL properties but leaves other props intact', () => {
    const out = sanitizeUrls({
      uuid: 'u',
      event: '$pageview',
      properties: {
        $current_url: 'https://gcb.com/x?token=secret',
        $pathname: '/x?token=secret',
        $browser: 'Chrome',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.$current_url).toBe('https://gcb.com/x');
    expect(out?.properties.$pathname).toBe('/x');
    expect(out?.properties.$browser).toBe('Chrome');
  });

  it('also scrubs URL person-property bags ($set / $set_once)', () => {
    const out = sanitizeUrls({
      uuid: 'u',
      event: '$pageview',
      properties: { $current_url: 'https://gcb.com/a?x=1' },
      $set: { $initial_current_url: 'https://gcb.com/enter?code=SECRET' },
      $set_once: { $initial_referrer: 'https://ref.com/p?t=secret' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.$current_url).toBe('https://gcb.com/a');
    expect(out?.$set?.$initial_current_url).toBe('https://gcb.com/enter');
    expect(out?.$set_once?.$initial_referrer).toBe('https://ref.com/p');
  });

  it('scrubs rrweb Meta href inside $snapshot replay data (#197)', () => {
    const out = sanitizeUrls({
      uuid: 's',
      event: '$snapshot',
      properties: {
        $snapshot_data: [
          { type: 4, data: { href: 'https://gcb.com/leaderboard?invite=SECRET', width: 390 }, timestamp: 1 },
          { type: 3, data: { source: 2 }, timestamp: 2 },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = out?.properties.$snapshot_data as any[];
    expect(events[0].data.href).toBe('https://gcb.com/leaderboard');
    expect(events[1].data.source).toBe(2); // non-Meta events untouched
  });

  it('scrubs rrweb Custom-event payload href in $snapshot data (#197)', () => {
    const out = sanitizeUrls({
      uuid: 's',
      event: '$snapshot',
      properties: {
        $snapshot_data: [
          { type: 5, data: { tag: '$pageview', payload: { href: 'https://gcb.com/leaderboard?invite=SECRET' } } },
          { type: 5, data: { tag: 'other', payload: { note: 'keep' } } },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = out?.properties.$snapshot_data as any[];
    expect(events[0].data.payload.href).toBe('https://gcb.com/leaderboard');
    expect(events[1].data.payload.note).toBe('keep'); // non-href payload untouched
  });

  it('scrubs rrweb Meta href when $snapshot_data is wrapped under .data (#197)', () => {
    const out = sanitizeUrls({
      uuid: 's',
      event: '$snapshot',
      properties: { $snapshot_data: { data: [{ type: 4, data: { href: 'https://gcb.com/x?t=1#h' } }] } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out?.properties.$snapshot_data as any).data[0].data.href).toBe('https://gcb.com/x');
  });

  it('leaves non-$snapshot events untouched by the snapshot scrub', () => {
    const out = sanitizeUrls({
      uuid: 'p',
      event: '$pageview',
      properties: { $snapshot_data: [{ type: 4, data: { href: 'https://gcb.com/y?t=1' } }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // not a $snapshot event → snapshot data is left as-is
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out?.properties.$snapshot_data as any[])[0].data.href).toBe('https://gcb.com/y?t=1');
  });

  it('does not throw on compressed / malformed $snapshot_data and leaves it unchanged', () => {
    for (const snap of ['gzipped-opaque-string', 123, null, { foo: 'bar' }, { data: 'not-an-array' }]) {
      const ev = {
        uuid: 's',
        event: '$snapshot',
        properties: { $snapshot_data: snap },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      expect(() => sanitizeUrls(ev)).not.toThrow();
      expect(ev.properties.$snapshot_data).toEqual(snap);
    }
  });

  it('leaves Meta events with missing or non-string href untouched', () => {
    const out = sanitizeUrls({
      uuid: 's',
      event: '$snapshot',
      properties: {
        $snapshot_data: [
          { type: 4, data: { width: 390 } }, // no href
          { type: 4, data: { href: 42 } }, // non-string href
          { type: 4 }, // no data
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = out?.properties.$snapshot_data as any[];
    expect(events[0].data.width).toBe(390);
    expect(events[1].data.href).toBe(42);
    expect(events[2].data).toBeUndefined();
  });

  it('is wired as the before_send hook in the init options', () => {
    expect(POSTHOG_INIT_OPTIONS.before_send).toBe(sanitizeUrls);
  });
});

describe('canonicalizeOrigin — sanitizeUrls swaps in the canonical hostname (Codex round 2 on #556)', () => {
  afterEach(() => applyResolvedCanonicalHost(null));

  it('leaves the origin unchanged when no canonical host is resolved (matches today’s behavior exactly)', () => {
    const out = sanitizeUrls({
      uuid: 'u',
      event: '$pageview',
      properties: { $current_url: 'https://gcb.com/x?token=secret' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.$current_url).toBe('https://gcb.com/x');
  });

  it('swaps $current_url / $pathname / $initial_current_url to the canonical origin once resolved', () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    const out = sanitizeUrls({
      uuid: 'u',
      event: '$pageview',
      properties: { $current_url: 'https://bodega-bay.fiveacrossbingo.com/feed?token=secret' },
      $set: { $initial_current_url: 'https://bodega-bay.fiveacrossbingo.com/enter?code=SECRET' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.$current_url).toBe('https://bodega-bay.vacaybingo.com/feed');
    expect(out?.$set?.$initial_current_url).toBe('https://bodega-bay.vacaybingo.com/enter');
  });

  it('never rewrites $referrer / $initial_referrer — a real external referrer is not our own origin', () => {
    // The bug this guards: $referrer is frequently a genuinely EXTERNAL
    // origin (a search engine, a shared link elsewhere). Canonicalizing it
    // would silently overwrite real referrer data with our own hostname.
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    const out = sanitizeUrls({
      uuid: 'u',
      event: '$pageview',
      properties: { $referrer: 'https://www.google.com/search?q=secret' },
      $set_once: { $initial_referrer: 'https://twitter.com/x?ref=1' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.$referrer).toBe('https://www.google.com/search'); // query stripped, origin kept
    expect(out?.$set_once?.$initial_referrer).toBe('https://twitter.com/x');
  });

  it('canonicalizes the rrweb Meta (type 4) and Custom-event (type 5) hrefs in $snapshot data too', () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    const out = sanitizeUrls({
      uuid: 's',
      event: '$snapshot',
      properties: {
        $snapshot_data: [
          { type: 4, data: { href: 'https://bodega-bay.fiveacrossbingo.com/leaderboard?invite=SECRET' } },
          { type: 5, data: { payload: { href: 'https://bodega-bay.fiveacrossbingo.com/feed?t=1' } } },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = out?.properties.$snapshot_data as any[];
    expect(events[0].data.href).toBe('https://bodega-bay.vacaybingo.com/leaderboard');
    expect(events[1].data.payload.href).toBe('https://bodega-bay.vacaybingo.com/feed');
  });

  it('leaves a relative path unchanged — no origin to swap', () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    const out = sanitizeUrls({
      uuid: 'u',
      event: '$pageview',
      properties: { $pathname: '/items?t=secret' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.$pathname).toBe('/items');
  });
});

describe('sanitizeUrls guarantees dimensions on EVERY event, independent of SDK-readiness ordering (Phase 4b P1 on PR #584)', () => {
  // Each test resets modules and imports a fresh `./posthog` instance so
  // `registeredDims` (module state) never leaks into the file's other
  // describe blocks, which use the static top-level import.

  it('merges dimensions into an event captured BEFORE the SDK is ready — the automatic first $pageview included', async () => {
    // The regression this guards (Codex round-2 P2 + Phase 4b P1 on PR
    // #584): a slow hostname-resolved build could let PostHog's own
    // automatic initial $pageview fire before `posthog.register()` had a
    // chance to apply to the real SDK — before_send is the one point every
    // captured event passes through regardless, so merging `registeredDims`
    // here closes the gap no queue-and-replay TIMING fix alone could.
    vi.resetModules();
    const mod = await import('./posthog');
    mod.phRegister({ brand_id: 'five-across', edition_id: 'gcb', event_id: 'bodega-bay-2026' });
    // Simulate the automatic $pageview reaching before_send while the SDK
    // is STILL not ready — posthog.register() has not actually run yet.
    const out = mod.sanitizeUrls({
      uuid: 'p',
      event: '$pageview',
      properties: { $current_url: 'https://gcb.com/x' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties).toMatchObject({
      brand_id: 'five-across',
      edition_id: 'gcb',
      event_id: 'bodega-bay-2026',
    });
  });

  it('OVERRIDES a controlled dimension key even when the event itself already set it (#611 — inverts the round-2 "event wins" posture)', async () => {
    // The controlled dimension keys (brand_id/edition_id/event_id/
    // event_slug/day_index) are system-controlled — nothing legitimate sets
    // them explicitly, and PostHog persists register()'d super-properties
    // across SESSIONS, so a value already sitting on `properties` is more
    // likely a stale cross-session leftover than a genuine per-call
    // override. The current registeredDims value always wins for these
    // five keys specifically (see CONTROLLED_DIMENSION_KEYS's own doc).
    vi.resetModules();
    const mod = await import('./posthog');
    mod.phRegister({ day_index: 1 });
    const out = mod.sanitizeUrls({
      uuid: 'p',
      event: 'custom',
      properties: { day_index: 9 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.day_index).toBe(1);
  });

  it('still lets an event property win for a NON-controlled default (general merge posture preserved)', async () => {
    vi.resetModules();
    const mod = await import('./posthog');
    mod.phRegister({ some_future_default: 'registered' });
    const out = mod.sanitizeUrls({
      uuid: 'p',
      event: 'custom',
      properties: { some_future_default: 'from-the-event' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.some_future_default).toBe('from-the-event');
  });

  it('DELETES a stale controlled dimension inherited from a PRIOR session\'s persisted super-property (#611 regression)', () => {
    // The exact bug: PostHog persists register()'d super-properties to
    // localStorage across sessions/tabs, so the SDK's own automatic capture
    // can embed the PREVIOUS session's event_id/edition_id into
    // event.properties BEFORE before_send ever runs — even before THIS
    // session's phRegister has been called at all (registeredDims is
    // genuinely empty here, unlike the tests above).
    const out = sanitizeUrls({
      uuid: 'p',
      event: '$pageview',
      properties: { event_id: 'stale-prior-session-event', edition_id: 'gcb', $browser: 'Chrome' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.event_id).toBeUndefined();
    expect(out?.properties.edition_id).toBeUndefined();
    expect(out?.properties.$browser).toBe('Chrome'); // non-controlled properties untouched
  });

  it('deletes day_index specifically when it is unavailable this session but was set in a prior one', async () => {
    vi.resetModules();
    const mod = await import('./posthog');
    // brand/edition/event registered (pre-auth), but the Event doc — and so
    // day_index — has not loaded yet THIS session.
    mod.phRegister({ brand_id: 'five-across', edition_id: 'gcb', event_id: 'med-2026' });
    const out = mod.sanitizeUrls({
      uuid: 'p',
      event: '$pageview',
      properties: { day_index: 7 }, // leftover from a prior session/tab
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties.day_index).toBeUndefined();
    expect(out?.properties).toMatchObject({ brand_id: 'five-across', edition_id: 'gcb', event_id: 'med-2026' });
  });

  it('is a no-op when nothing has been registered yet', async () => {
    vi.resetModules();
    const mod = await import('./posthog');
    const out = mod.sanitizeUrls({
      uuid: 'p',
      event: '$pageview',
      properties: { $browser: 'Chrome' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out?.properties).toEqual({ $browser: 'Chrome' });
  });
});

describe('isLocalDevHost (#194 — no capture from local dev)', () => {
  it('is true for localhost, loopback, and .local hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', 'gcb.local', 'my-mac.local']) {
      expect(isLocalDevHost(h)).toBe(true);
    }
  });

  it('is false for production hosts', () => {
    for (const h of ['gaycruisebingo.com', 'www.gaycruisebingo.com', 'gaycruisebingo.web.app']) {
      expect(isLocalDevHost(h)).toBe(false);
    }
  });
});

describe('PostHog client config (full capture, unlocked)', () => {
  it('enables full capture — autocapture, SPA pageviews + pageleave, and session recording', () => {
    expect(POSTHOG_INIT_OPTIONS.autocapture).toBe(true);
    expect(POSTHOG_INIT_OPTIONS.disable_session_recording).toBe(false);
    expect(POSTHOG_INIT_OPTIONS.capture_pageview).toBe('history_change');
    expect(POSTHOG_INIT_OPTIONS.capture_pageleave).toBe(true);
    expect(POSTHOG_INIT_OPTIONS.person_profiles).toBe('identified_only');
  });

  it('records replays fully unmasked (maskAllInputs: false) by owner decision', () => {
    expect(POSTHOG_INIT_OPTIONS.session_recording).toEqual({ maskAllInputs: false });
  });

  it('routes the UI to the PostHog US app while events go through the proxy (#149)', () => {
    // ui_host must stay the real US app so the toolbar / "view in PostHog" links
    // resolve even though ingestion (api_host) points at the reverse proxy.
    expect(POSTHOG_INIT_OPTIONS.ui_host).toBe('https://us.posthog.com');
    expect(POSTHOG_PROXY_HOST).toBe('https://d.gaycruisebingo.com');
  });
});

describe('PostHog init guard', () => {
  it('no-ops without VITE_POSTHOG_KEY (dev/test/CI stay silent)', () => {
    expect(posthogReady()).toBe(false);
    phCapture('login', { method: 'google' });
    phIdentify('u1');
    phRegister({ brand_id: 'five-across' });
    phReset();
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.register).not.toHaveBeenCalled();
  });
});

describe('PostHog init with a key', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    // Guaranteed even when a mid-test assertion fails (CodeRabbit on #342):
    // several tests stub global fetch for the init probe and assert BEFORE
    // their inline unstub; without this, one real failure would leak the stub
    // into later tests and cascade.
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('initializes with the full-capture options + host when a key is present', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    mod.initPostHog();
    expect(ph.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        api_host: 'https://us.i.posthog.com', // US direct-host bypass still overrides
        ui_host: 'https://us.posthog.com',
        autocapture: true,
        disable_session_recording: false,
        capture_pageview: 'history_change',
        person_profiles: 'identified_only',
      }),
    );
    // Once ready, an explicit event is forwarded to the SDK.
    mod.phCapture('bingo', { lines: 1 });
    expect(ph.capture).toHaveBeenCalledWith('bingo', { lines: 1 });
  });

  it('replays a capture that arrived BEFORE init settled (#513 — the startup-crash report)', async () => {
    // Phase 4b P2 on #513. `initPostHog` is fire-and-forget and awaits ingest
    // probes while main.tsx renders synchronously, so a STARTUP crash — the
    // exact case `app_crash` exists to report — lands in the not-ready window
    // and used to be dropped outright, before any transport option could help.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');

    mod.phCapture('app_crash', { message: 'boom' }, { transport: 'sendBeacon', send_instantly: true });
    expect(ph.capture).not.toHaveBeenCalled(); // not ready yet — queued, not lost

    await mod.initPostHog();
    expect(ph.capture).toHaveBeenCalledWith(
      'app_crash',
      { message: 'boom' },
      { transport: 'sendBeacon', send_instantly: true },
    );
  });

  it('replays a queued capture that survived a RECOVERY RELOAD (#513)', async () => {
    // Codex P2 on #513: the queue's main customer reloads the page immediately
    // after queueing, and the same-origin build-floor probe can beat the
    // EXTERNAL ingest probes (the shipboard blocked-proxy case). A memory-only
    // queue dies with that navigation, so the crash would vanish regardless.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');

    // Load 1: crash queues the report, then the page goes away before init.
    const first = await import('./posthog');
    first.phCapture('app_crash', { message: 'boom' }, { transport: 'sendBeacon', send_instantly: true });

    // Load 2: fresh module registry — module memory is gone, sessionStorage is not.
    vi.resetModules();
    const ph = (await import('posthog-js')).default;
    const second = await import('./posthog');
    await second.initPostHog();

    expect(ph.capture).toHaveBeenCalledWith(
      'app_crash',
      { message: 'boom' },
      { transport: 'sendBeacon', send_instantly: true },
    );
  });

  it('sends a pre-init capture EXACTLY ONCE when init settles without a navigation', async () => {
    // Codex P2 on #513: the event lives in both the in-memory queue and its own
    // persisted mirror, so replaying the concatenation double-counted every
    // startup event — inflating `app_crash` counts with phantom crashes.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    mod.phCapture('app_crash', { message: 'boom' });
    await mod.initPostHog();
    expect((ph.capture as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('a second load queuing its own event does not overwrite the first load’s', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    (await import('./posthog')).phCapture('app_crash', { message: 'first' });

    vi.resetModules();
    const second = await import('./posthog');
    second.phCapture('app_crash', { message: 'second' });

    vi.resetModules();
    const ph = (await import('posthog-js')).default;
    vi.clearAllMocks();
    await (await import('./posthog')).initPostHog();
    const names = (ph.capture as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls.map(
      (c) => c[1].message,
    );
    expect(names).toEqual(['first', 'second']);
  });

  it('drains the persisted queue exactly once, so a replay cannot re-send forever', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const first = await import('./posthog');
    first.phCapture('app_crash', { message: 'boom' });

    vi.resetModules();
    await (await import('./posthog')).initPostHog();

    vi.resetModules();
    const ph = (await import('posthog-js')).default;
    vi.clearAllMocks();
    await (await import('./posthog')).initPostHog();
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it('drops persisted entries it cannot durably DELETE, rather than re-sending them forever', async () => {
    // Phase 4b P2 on #513: a readable-but-nonmutating store can accept
    // removeItem and keep the blob, which would violate exactly-once on every
    // future load with no way to stop. Losing the event is the lesser harm.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    vi.stubGlobal('sessionStorage', {
      getItem: () => JSON.stringify([{ name: 'app_crash', params: { message: 'stuck' } }]),
      setItem: () => {},
      removeItem: () => {}, // accepted, but the blob survives
    });
    const ph = (await import('posthog-js')).default;
    await (await import('./posthog')).initPostHog();
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it('replays a queued capture AFTER the pending identify, so it is not orphaned anonymous', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');

    mod.phIdentify('uid-1');
    mod.phCapture('app_crash', { message: 'boom' });
    await mod.initPostHog();

    const identifyOrder = (ph.identify as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const captureOrder = (ph.capture as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(identifyOrder).toBeLessThan(captureOrder);
  });

  it('defaults api_host to the personal proxy (chain primary) when VITE_POSTHOG_HOST is unset (#149/#344)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    // Empty out the override (the repo's .env.local sets one for the loader) so
    // this exercises the in-code default: both proxies answer → the chain
    // primary (personal proxy) wins, and BOTH probes were actually issued.
    vi.stubEnv('VITE_POSTHOG_HOST', '');
    const fetchMock = vi.fn().mockResolvedValue({ type: 'opaque' } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    await mod.initPostHog();
    vi.unstubAllGlobals();
    const probedHosts = fetchMock.mock.calls.map(([url]) => (url as string).split('/?')[0]);
    expect(probedHosts).toEqual(
      expect.arrayContaining(['https://d.nathanpayne.com', 'https://d.gaycruisebingo.com']),
    );
    expect(ph.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        api_host: 'https://d.nathanpayne.com',
        ui_host: 'https://us.posthog.com',
      }),
    );
  });

  it('falls back to the gcb proxy when only the personal proxy is dead (#344)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', '');
    // URL-aware stub: personal proxy dead, gcb proxy answering.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        // Slash-anchored (CodeQL js/incomplete-url-substring-sanitization):
        // the probe URL is always `<host>/?alive=…`, and the anchored form
        // can't match a hostname that merely starts with ours.
        url.startsWith('https://d.nathanpayne.com/')
          ? Promise.reject(new TypeError('Load failed'))
          : Promise.resolve({ type: 'opaque' } as Response),
      ),
    );
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    await mod.initPostHog();
    vi.unstubAllGlobals();
    expect(ph.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({ api_host: 'https://d.gaycruisebingo.com' }),
    );
  });

  it('falls back to direct PostHog Cloud when BOTH proxies are dead (#342/#344)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', '');
    // The #342 incident shape, worst case: every proxy probe rejects.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    await mod.initPostHog();
    vi.unstubAllGlobals();
    expect(ph.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({ api_host: 'https://us.i.posthog.com' }),
    );
  });

  it('replays an identify that arrived during the init probe window (#342)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', '');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ type: 'opaque' } as Response));
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    const initSettled = mod.initPostHog();
    // Firebase restores a cached signed-in user before the probe settles.
    mod.phIdentify('sailor-9');
    expect(ph.identify).not.toHaveBeenCalled();
    await initSettled;
    vi.unstubAllGlobals();
    expect(ph.identify).toHaveBeenCalledWith('sailor-9');
  });

  it('a sign-out during the probe window replays AFTER the identify it followed — the session ends anonymous, in order (#342 → #613)', async () => {
    // Previously the queued reset simply DELETED the pending identify
    // (last-write-wins slots). The FIFO queue (#613, Phase 4b P1) replays
    // both, in arrival order: the identify stitches the probe-window events
    // to the user who really was signed in, and the reset that FOLLOWED it
    // still lands last, so the identity is never resurrected past sign-out.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', '');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ type: 'opaque' } as Response));
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    const initSettled = mod.initPostHog();
    mod.phIdentify('sailor-9');
    mod.phReset();
    await initSettled;
    // Unstub BEFORE asserting (CodeRabbit on #342): an assertion failure here
    // must not leak the stubbed fetch into later tests and cascade.
    vi.unstubAllGlobals();
    expect(ph.identify).toHaveBeenCalledWith('sailor-9');
    expect(ph.reset).toHaveBeenCalledTimes(1);
    const identifyOrder = (ph.identify as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const resetOrder = (ph.reset as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(identifyOrder).toBeLessThan(resetOrder);
  });

  it('a reset requested while SIGNED OUT during the probe window is applied on the real SDK once init settles (#611, retro Phase 4b P1)', async () => {
    // The bug: previously phReset() while `!ready` just cleared
    // pendingIdentifyUid and returned — nothing told initPostHog to actually
    // call posthog.reset() once the SDK came up, so `posthog.init()` loaded
    // whatever identity PostHog had PERSISTED from a PRIOR session and every
    // capture in this signed-out session kept attributing to it.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', '');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ type: 'opaque' } as Response));
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    const initSettled = mod.initPostHog();
    mod.phReset(); // the signed-out ThemedApp effect fires before the probe settles
    expect(ph.reset).not.toHaveBeenCalled(); // not ready yet — queued, not lost
    await initSettled;
    vi.unstubAllGlobals();
    expect(ph.reset).toHaveBeenCalledTimes(1);
  });

  it('the queued reset is applied BEFORE any queued capture, so nothing attributes to a stale persisted identity (#611)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');

    mod.phReset();
    mod.phCapture('app_crash', { message: 'boom' });
    await mod.initPostHog();

    const resetOrder = (ph.reset as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const captureOrder = (ph.capture as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(resetOrder).toBeLessThan(captureOrder);
  });

  it('the queued reset is applied BEFORE the queued dimension registration, so this session\'s dims are not wiped by it (#611)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');

    mod.phReset();
    mod.phRegister({ brand_id: 'five-across' });
    await mod.initPostHog();

    expect(ph.reset).toHaveBeenCalledTimes(1);
    expect(ph.register).toHaveBeenCalledWith({ brand_id: 'five-across' });
    const resetOrder = (ph.reset as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const registerOrder = (ph.register as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(resetOrder).toBeLessThan(registerOrder);
  });

  it('a fast sign-out → sign-in during the probe window replays reset THEN identify — never identify alone (#613, Phase 4b P1)', async () => {
    // The cross-user attribution hazard: posthog.init() loads the PREVIOUS
    // account's persisted distinct_id. The earlier last-write-wins slots let
    // the later queued identify DISCARD the queued reset, so the new uid was
    // identified straight onto the prior user's persisted identity — merging
    // the two accounts. The FIFO queue preserves the reset and executes
    // reset-then-identify for this sequence.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');

    mod.phReset(); // the account switch starts: previous user signs out
    mod.phIdentify('sailor-9'); // the NEW account signs in before init ever settled
    await mod.initPostHog();

    expect(ph.reset).toHaveBeenCalledTimes(1);
    expect(ph.identify).toHaveBeenCalledWith('sailor-9');
    const resetOrder = (ph.reset as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const identifyOrder = (ph.identify as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(resetOrder).toBeLessThan(identifyOrder);
  });

  it('replays a reset-then-identify with the dimension registration BETWEEN them, so the $identify is dimensioned and the dims survive the reset (#613)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');

    mod.phRegister({ brand_id: 'five-across' });
    mod.phReset();
    mod.phIdentify('sailor-9');
    await mod.initPostHog();

    // The reset's own re-register carries the FULL merged set, and it must
    // land after the reset (or the reset would wipe it) and before the
    // identify (or the $identify capture would be undimensioned).
    expect(ph.register).toHaveBeenCalledWith({ brand_id: 'five-across' });
    const resetOrder = (ph.reset as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const registerOrder = (ph.register as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const identifyOrder = (ph.identify as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(resetOrder).toBeLessThan(registerOrder);
    expect(registerOrder).toBeLessThan(identifyOrder);
  });

  it('coalesces adjacent identifies to the latest uid, keeping only actual sign-in/out transitions (#613)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');

    mod.phIdentify('sailor-1');
    mod.phIdentify('sailor-2'); // no reset between — same signed-in run, latest uid wins
    await mod.initPostHog();

    expect(ph.identify).toHaveBeenCalledTimes(1);
    expect(ph.identify).toHaveBeenCalledWith('sailor-2');
  });

  it("applies the queued reset before the SDK's DEFERRED init-time $pageview can capture (#613, Phase 4b P1)", async () => {
    // posthog-js does NOT capture the automatic initial $pageview inside
    // init(): the loaded step of init schedules it one macrotask later via
    // setTimeout(..., 1) (verified in the installed 1.409.5 dist), and the
    // capture computes distinct_id at CAPTURE time. This test mirrors that
    // scheduling in the init mock and pins our side of the contract: the
    // queued reset is applied SYNCHRONOUSLY after posthog.init() returns —
    // no awaits in between — so it always lands before the deferred capture
    // task runs, and the first pageview of a signed-out session can never
    // attribute to a prior session's persisted identity.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    vi.useFakeTimers();
    try {
      const ph = (await import('posthog-js')).default;
      const order: string[] = [];
      vi.mocked(ph.init).mockImplementationOnce(((): void => {
        setTimeout(() => order.push('sdk-initial-pageview'), 1);
      }) as never);
      vi.mocked(ph.reset).mockImplementationOnce(((): void => {
        order.push('reset');
      }) as never);
      const mod = await import('./posthog');
      mod.phReset(); // the signed-out effect fires before init settles
      await mod.initPostHog();
      vi.runAllTimers();
      expect(order).toEqual(['reset', 'sdk-initial-pageview']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards super-properties directly once ready (#556)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    await mod.initPostHog();
    mod.phRegister({ brand_id: 'five-across', edition_id: 'gcb' });
    expect(ph.register).toHaveBeenCalledWith({ brand_id: 'five-across', edition_id: 'gcb' });
  });

  it('queues a registration that arrived during the init probe window and replays it once ready (#556)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', '');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ type: 'opaque' } as Response));
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    const initSettled = mod.initPostHog();
    mod.phRegister({ brand_id: 'five-across' });
    expect(ph.register).not.toHaveBeenCalled(); // not ready yet — queued, not lost
    await initSettled;
    vi.unstubAllGlobals();
    expect(ph.register).toHaveBeenCalledWith({ brand_id: 'five-across' });
  });

  it('merges MULTIPLE pre-init registrations into a single replay (#556)', async () => {
    // brand/edition/Event register at startup; day_index can register
    // separately once the Event doc loads — both must survive to one replay.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', '');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ type: 'opaque' } as Response));
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    const initSettled = mod.initPostHog();
    mod.phRegister({ brand_id: 'five-across', edition_id: 'gcb' });
    mod.phRegister({ day_index: 3 });
    await initSettled;
    vi.unstubAllGlobals();
    expect(ph.register).toHaveBeenCalledTimes(1);
    expect(ph.register).toHaveBeenCalledWith({ brand_id: 'five-across', edition_id: 'gcb', day_index: 3 });
  });

  it('replays a registration BEFORE the queued capture, so a replayed capture carries the new dimensions (#556)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');

    mod.phRegister({ brand_id: 'five-across' });
    mod.phCapture('app_crash', { message: 'boom' });
    await mod.initPostHog();

    const registerOrder = (ph.register as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const captureOrder = (ph.capture as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(registerOrder).toBeLessThan(captureOrder);
  });

  it('replays a registration BEFORE the pending identify, so identify()s own capture is dimensioned too (Codex P2 on #556)', async () => {
    // posthog.identify() itself emits an $identify/$set capture the moment
    // it transitions the anonymous user — that capture must carry
    // brand/edition/Event context too, not just events queued after it.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');

    mod.phRegister({ brand_id: 'five-across' });
    mod.phIdentify('sailor-9');
    await mod.initPostHog();

    const registerOrder = (ph.register as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const identifyOrder = (ph.identify as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(registerOrder).toBeLessThan(identifyOrder);
  });

  it('reapplies registered dimensions after posthog.reset() clears them (Codex P2 on #556)', async () => {
    // reset() clears PostHog's persisted register() state along with the
    // identity — without a reapply, a second Player signing in on the same
    // tab (no full page reload) would send captures with no brand/edition/
    // Event/Day context at all until something called phRegister again.
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    await mod.initPostHog();

    mod.phRegister({ brand_id: 'five-across', edition_id: 'gcb' });
    mod.phRegister({ day_index: 2 });
    vi.mocked(ph.register).mockClear();

    mod.phReset();
    expect(ph.reset).toHaveBeenCalled();
    expect(ph.register).toHaveBeenCalledWith({ brand_id: 'five-across', edition_id: 'gcb', day_index: 2 });
  });

  it('reset() is a no-op on dimensions when nothing was ever registered', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://us.i.posthog.com');
    const ph = (await import('posthog-js')).default;
    const mod = await import('./posthog');
    await mod.initPostHog();

    mod.phReset();
    expect(ph.reset).toHaveBeenCalled();
    expect(ph.register).not.toHaveBeenCalled();
  });
});

describe('ingest-host failover chain (#342/#344 — shipboard SNI filter blocked the gcb proxy)', () => {
  it('the chain is priority-ordered: personal proxy, gcb proxy, direct PostHog Cloud', () => {
    expect(POSTHOG_INGEST_HOSTS).toEqual([
      'https://d.nathanpayne.com',
      'https://d.gaycruisebingo.com',
      'https://us.i.posthog.com',
    ]);
  });

  it('pickIngestHost takes the first alive host in chain order, direct as the unprobed last resort', () => {
    expect(pickIngestHost(true, true)).toBe(POSTHOG_PERSONAL_PROXY_HOST);
    expect(pickIngestHost(true, false)).toBe(POSTHOG_PERSONAL_PROXY_HOST);
    expect(pickIngestHost(false, true)).toBe(POSTHOG_PROXY_HOST);
    expect(pickIngestHost(false, false)).toBe(POSTHOG_DIRECT_HOST);
  });

  it('an override restating a PROXY member does NOT bypass; the direct host and outside hosts do', () => {
    for (const envHost of [
      POSTHOG_PERSONAL_PROXY_HOST,
      `${POSTHOG_PERSONAL_PROXY_HOST}/`,
      POSTHOG_PROXY_HOST,
      `${POSTHOG_PROXY_HOST}/`,
      undefined,
      '',
      '   ',
    ]) {
      expect(envHostBypassesProbe(envHost)).toBe(false);
    }
    // Restating the direct host IS the documented "skip the proxies"
    // diagnostic bypass; hosts outside the chain bypass too.
    expect(envHostBypassesProbe(POSTHOG_DIRECT_HOST)).toBe(true);
    expect(envHostBypassesProbe('https://eu.example.dev')).toBe(true);
  });

  it('ingestHostAlive probes the GIVEN host no-cors/no-store and maps resolve→true, reject→false', async () => {
    const okImpl = vi.fn().mockResolvedValue({ type: 'opaque' } as Response);
    await expect(ingestHostAlive(POSTHOG_PERSONAL_PROXY_HOST, okImpl as unknown as typeof fetch)).resolves.toBe(true);
    const [url, init] = okImpl.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(`${POSTHOG_PERSONAL_PROXY_HOST}/?alive=`)).toBe(true);
    expect(init.mode).toBe('no-cors');
    expect(init.cache).toBe('no-store');

    const deadImpl = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    await expect(ingestHostAlive(POSTHOG_PROXY_HOST, deadImpl as unknown as typeof fetch)).resolves.toBe(false);
  });
});
