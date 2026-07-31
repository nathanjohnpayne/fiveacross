import { describe, it, expect, vi, afterEach } from 'vitest';

// posthog-js is mocked so no real SDK loads; VITE_POSTHOG_KEY is unset in the
// base test env, so the statically-imported module stays in its disabled state.
vi.mock('posthog-js', () => ({
  default: { init: vi.fn(), capture: vi.fn(), identify: vi.fn(), reset: vi.fn() },
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
  phReset,
  isLocalDevHost,
  stripUrlSecrets,
  sanitizeUrls,
} from './posthog';

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
    phReset();
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
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

  it('a sign-out during the probe window clears the pending identity — never resurrected after init (#342)', async () => {
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
    expect(ph.identify).not.toHaveBeenCalled();
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
