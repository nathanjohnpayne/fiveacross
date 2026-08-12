import { describe, it, expect, vi } from 'vitest';
import {
  ACTIVE_STAMP_URL,
  CLIENT_STAMP_SWEEP_GRACE_MS,
  FORCED_FLAG_URL,
  SHELL_META_CACHE,
  UNKNOWN_ACTIVE_STAMP,
  UNREGISTERED_CLIENT_CONFIRM_MS,
  confirmClientStamps,
  dueForFloorRecheck,
  hasUnregisteredClient,
  fetchFloorInWorker,
  fetchFloorWithRetry,
  isAppShellClientUrl,
  recordFloorCheck,
  markForcedActivation,
  pruneClientStamps,
  readActiveStamp,
  readClientStamps,
  recordClientStamp,
  shouldForceActivate,
  shouldNavigateClient,
  takeForcedActivation,
  writeActiveStamp,
} from './sw-rescue';

// #514. The gap #513 could not close: a client stranded on a pre-#513 shell runs
// neither the ErrorBoundary nor the module-scope floor check, because both ship
// in the bundle it cannot reach, and its newer worker waits forever for a
// `updateServiceWorker(true)` that a dead page will never send. These pin the
// decision the WORKER makes for itself during `install`.

const INERT_FLOOR = '1970-01-01T00:00:00.000Z'; // what public/build-floor.json ships
const ARMED_FLOOR = '2026-07-24T00:00:00.000Z'; // the cells-map migration deploy
const OLD_SHELL = '2026-07-20T14:17:04.539Z'; // the bundle that actually crashed
const NEW_SHELL = '2026-07-28T01:22:17.835Z';

describe('shouldForceActivate', () => {
  it('rescues a shell that is below an armed floor', () => {
    expect(shouldForceActivate({ activeStamp: OLD_SHELL, ownStamp: NEW_SHELL, floor: ARMED_FLOOR })).toBe(true);
  });

  it('rescues a shell that recorded NO stamp — every pre-#514 worker, i.e. the stranded cohort', () => {
    expect(shouldForceActivate({ activeStamp: null, ownStamp: NEW_SHELL, floor: ARMED_FLOOR })).toBe(true);
  });

  it('leaves an up-to-date shell alone under an armed floor', () => {
    expect(shouldForceActivate({ activeStamp: NEW_SHELL, ownStamp: NEW_SHELL, floor: ARMED_FLOOR })).toBe(false);
  });

  it('NEVER forces under the inert shipped floor, even with no recorded stamp', () => {
    // The load-bearing safety property: shipping #514 must force-activate
    // nobody. `UNKNOWN_ACTIVE_STAMP` sits 1ms after the epoch precisely so an
    // unrecorded shell is not "below" the inert floor.
    expect(shouldForceActivate({ activeStamp: null, ownStamp: NEW_SHELL, floor: INERT_FLOOR })).toBe(false);
    expect(shouldForceActivate({ activeStamp: OLD_SHELL, ownStamp: NEW_SHELL, floor: INERT_FLOOR })).toBe(false);
  });

  it('does not force when THIS worker is also below the floor', () => {
    // A floor set past every existing build would otherwise have workers
    // force-activating onto shells the same floor condemns — churn, not rescue.
    expect(shouldForceActivate({ activeStamp: OLD_SHELL, ownStamp: OLD_SHELL, floor: '2026-12-01T00:00:00.000Z' })).toBe(
      false,
    );
  });

  it('fails closed on a missing, malformed, or non-string floor', () => {
    for (const floor of [null, undefined, '', 'not-a-date', 42, {}, []]) {
      expect(shouldForceActivate({ activeStamp: null, ownStamp: NEW_SHELL, floor })).toBe(false);
    }
  });

  it('pins UNKNOWN_ACTIVE_STAMP strictly after the inert floor', () => {
    // If these ever meet, shipping the feature force-activates the whole fleet.
    expect(Date.parse(UNKNOWN_ACTIVE_STAMP)).toBeGreaterThan(Date.parse(INERT_FLOOR));
  });
});

/** The real Cache API matches a Request against the url it was stored under;
 *  this fake stores by the path the worker passes, so a Request-shaped lookup
 *  has to come back to that path. */
function storeKey(k: string | { url: string }): string {
  return typeof k === 'string' ? k : new URL(k.url).pathname;
}

function fakeCacheStorage(initial?: unknown) {
  const store = new Map<string, Response>();
  if (initial !== undefined) store.set(ACTIVE_STAMP_URL, new Response(JSON.stringify(initial)));
  const cache = {
    // `.clone()` because a Response body can only be read ONCE, and the real
    // Cache API hands back a fresh Response per `match`. Returning the stored
    // instance made a second read throw on a locked body — a fixture artifact
    // that looked exactly like a storage failure.
    match: vi.fn(async (k: string | { url: string }) => store.get(storeKey(k))?.clone()),
    put: vi.fn(async (k: string, v: Response) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => store.delete(k)),
    // The real API hands back Requests, whose `url` is absolute. Modelled that
    // way so the key parsing is exercised, not bypassed.
    keys: vi.fn(async () => [...store.keys()].map((k) => ({ url: new URL(k, 'https://gcb.test').href }))),
  };
  return { open: vi.fn(async () => cache), _store: store, _cache: cache } as unknown as CacheStorage & {
    _store: Map<string, Response>;
    _cache: typeof cache;
  };
}

describe('fetchFloorWithRetry', () => {
  const ok = () => ({
    ok: true,
    redirected: false,
    url: `${location.origin}/build-floor.json`,
    json: async () => ({ floor: ARMED_FLOOR }),
  });

  it('retries a transient failure — the worker only ever gets ONE install', async () => {
    // Phase 4b P1 on #515. A waiting worker never re-runs `install`, and the
    // browser finds the same `sw.js` byte-identical on later navigations, so a
    // probe lost to a flaky connection is never retried and the rescue silently
    // never fires. The failure window is the worst one available: a reload on a
    // bad connection, which is this app's normal network.
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValue(ok());
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchFloorWithRetry(fetchImpl as unknown as typeof fetch, () => 1, { sleep, delayMs: 5 }),
    ).resolves.toBe(ARMED_FLOOR);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops at the attempt budget and does not sleep after the last one', async () => {
    // Trailing sleep on a genuinely offline device is pure install latency.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchFloorWithRetry(fetchImpl as unknown as typeof fetch, () => 1, { attempts: 3, sleep }),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry once a floor is read — including the inert one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      redirected: false,
      url: `${location.origin}/build-floor.json`,
      json: async () => ({ floor: INERT_FLOOR }),
    });
    const sleep = vi.fn();
    await expect(
      fetchFloorWithRetry(fetchImpl as unknown as typeof fetch, () => 1, { sleep }),
    ).resolves.toBe(INERT_FLOOR);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('cache-busts each attempt separately', async () => {
    // A retry that reuses the first attempt's URL can be answered by whatever
    // intermediary failed it the first time.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    let t = 100;
    await fetchFloorWithRetry(fetchImpl as unknown as typeof fetch, () => (t += 1), {
      attempts: 3,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const urls = fetchImpl.mock.calls.map((c) => c[0] as string);
    expect(new Set(urls).size).toBe(3);
  });
});

describe('the active-stamp record', () => {
  it('round-trips a stamp', async () => {
    const cs = fakeCacheStorage();
    await writeActiveStamp(cs, NEW_SHELL);
    await expect(readActiveStamp(cs)).resolves.toBe(NEW_SHELL);
  });

  it('reads null when nothing was ever recorded (a pre-#514 worker)', async () => {
    await expect(readActiveStamp(fakeCacheStorage())).resolves.toBeNull();
  });

  it('reads null on a malformed record rather than trusting it', async () => {
    await expect(readActiveStamp(fakeCacheStorage({ stamp: 42 }))).resolves.toBeNull();
    await expect(readActiveStamp(fakeCacheStorage({ stamp: '' }))).resolves.toBeNull();
    await expect(readActiveStamp(fakeCacheStorage({}))).resolves.toBeNull();
  });

  it('never throws when the Cache API refuses', async () => {
    const broken = { open: async () => Promise.reject(new Error('blocked')) } as unknown as CacheStorage;
    await expect(readActiveStamp(broken)).resolves.toBeNull();
    await expect(writeActiveStamp(broken, NEW_SHELL)).resolves.toBeUndefined();
  });

  it('uses a dedicated cache the shell teardown does not sweep', () => {
    // src/shellRecovery.ts deletes only `workbox-precache*`, so this record
    // survives a client-side reset — which is what makes it usable as the
    // "what is actually active" marker across a recovery.
    expect(SHELL_META_CACHE.startsWith('workbox-precache')).toBe(false);
  });
});

/** A floor response that clears all three interception barriers. */
function okFloorResponse(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    redirected: false,
    url: `${location.origin}/build-floor.json`,
    json: async () => ({ floor: ARMED_FLOOR }),
    ...over,
  };
}

describe('fetchFloorInWorker', () => {
  it('reads the floor with no-store so no cache can answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okFloorResponse());
    await expect(fetchFloorInWorker(fetchImpl as unknown as typeof fetch, 1234)).resolves.toBe(ARMED_FLOOR);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/build-floor.json?ts=1234',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('is bounded, so it cannot stall the install it runs inside', async () => {
    // A captive portal that accepts the connection and never answers is exactly
    // this app's environment; an unbounded probe would hang worker install.
    const hang = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      expect(init.signal).toBeDefined();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    await expect(fetchFloorInWorker(hang as unknown as typeof fetch, 1, 10)).resolves.toBeNull();
  });

  it('resolves null when the request fails, 404s, or carries no floor', async () => {
    const reject = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(fetchFloorInWorker(reject as unknown as typeof fetch, 1)).resolves.toBeNull();
    const notOk = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(fetchFloorInWorker(notOk as unknown as typeof fetch, 1)).resolves.toBeNull();
    const noFloor = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(fetchFloorInWorker(noFloor as unknown as typeof fetch, 1)).resolves.toBeNull();
  });

  it('a null floor can never force an activation', async () => {
    expect(shouldForceActivate({ activeStamp: null, ownStamp: NEW_SHELL, floor: null })).toBe(false);
  });

  // Phase 4b P1 on #515. Here a forged floor is not merely a bad reachability
  // signal — it is an ACTIVATION COMMAND. A captive portal answering with a
  // parseable `{ floor }` would have the worker skipWaiting, claim every
  // client, and reload every window. Same three barriers as `originReachable`
  // in src/shellRecovery.ts, because a portal only has to defeat one.
  it('requests with redirect:error so a portal bounce rejects outright', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okFloorResponse());
    await fetchFloorInWorker(fetchImpl as unknown as typeof fetch, 1);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/build-floor.json'),
      expect.objectContaining({ redirect: 'error', cache: 'no-store' }),
    );
  });

  it('rejects a REDIRECTED floor response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okFloorResponse({ redirected: true }));
    await expect(fetchFloorInWorker(fetchImpl as unknown as typeof fetch, 1)).resolves.toBeNull();
  });

  it('rejects a floor whose FINAL url is cross-origin (in-place interception)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okFloorResponse({ url: 'http://portal.ship/login' }));
    await expect(fetchFloorInWorker(fetchImpl as unknown as typeof fetch, 1)).resolves.toBeNull();
  });

  it('a forged floor cannot reach the activation decision at all', async () => {
    // The end-to-end statement of the barrier: a portal's floor resolves to
    // null, and a null floor can never force an activation.
    const fetchImpl = vi.fn().mockResolvedValue(okFloorResponse({ redirected: true }));
    const floor = await fetchFloorInWorker(fetchImpl as unknown as typeof fetch, 1);
    expect(shouldForceActivate({ activeStamp: null, ownStamp: NEW_SHELL, floor })).toBe(false);
  });
});

describe('the forced-activation marker', () => {
  const A = '2026-07-28T01:22:17.835Z';
  const B = '2026-07-31T00:00:00.000Z';

  it('is honoured by the worker that wrote it', async () => {
    const cs = fakeCacheStorage();
    await markForcedActivation(cs, A);
    await expect(takeForcedActivation(cs, A)).resolves.toMatchObject({ forced: true });
  });

  it('is consumed on read, so a later activation cannot inherit it', async () => {
    const cs = fakeCacheStorage();
    await markForcedActivation(cs, A);
    await takeForcedActivation(cs, A);
    await expect(takeForcedActivation(cs, A)).resolves.toMatchObject({ forced: false });
  });

  it('is IGNORED by a different worker — an orphaned marker cannot ambush one', async () => {
    // Phase 4b P2 on #515: this handler can record the flag and then have the
    // whole installation discarded (Workbox's precache listener rejecting on one
    // unavailable asset is enough) while the cache entry survives. Without the
    // stamp binding, a later worker that never chose to force would claim and
    // navigate every open tab — possibly long after the floor was disarmed.
    const cs = fakeCacheStorage();
    await markForcedActivation(cs, A);
    await expect(takeForcedActivation(cs, B)).resolves.toMatchObject({ forced: false });
  });

  it('CLEARS an orphaned marker rather than leaving it to ambush a later worker', async () => {
    const cs = fakeCacheStorage();
    await markForcedActivation(cs, A);
    await takeForcedActivation(cs, B); // wrong worker; still clears
    await expect(takeForcedActivation(cs, A)).resolves.toMatchObject({ forced: false });
  });

  it('reports false with no marker, and never throws when storage refuses', async () => {
    await expect(takeForcedActivation(fakeCacheStorage(), A)).resolves.toMatchObject({ forced: false });
    const broken = { open: async () => Promise.reject(new Error('blocked')) } as unknown as CacheStorage;
    await expect(takeForcedActivation(broken, A)).resolves.toMatchObject({ forced: false });
    await expect(markForcedActivation(broken, A)).resolves.toBeUndefined();
  });

  it('uses its own key, distinct from the active-stamp record', () => {
    expect(FORCED_FLAG_URL).not.toBe(ACTIVE_STAMP_URL);
  });

  it('carries the floor that justified the force (#516)', async () => {
    // `activate` cannot re-read it — the probe is a network call and by then
    // the worker is committed — so without this it could only navigate every
    // window, including tabs the floor accepts.
    const cs = fakeCacheStorage();
    await markForcedActivation(cs, A, ARMED_FLOOR);
    await expect(takeForcedActivation(cs, A)).resolves.toEqual({ forced: true, floor: ARMED_FLOOR });
  });
});

// #516. The served shell is not what every tab is EXECUTING: two tabs open on
// build A, one of which reloads onto B, leave `gcb-shell-meta` recording B, so
// a floor set between A and B reads "the active shell is fine" and abandons the
// tab still running A.
describe('the client build registry (#516)', () => {
  it('records what a window is running and reads it back', async () => {
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'tab-1', OLD_SHELL, ['tab-1']);
    await recordClientStamp(cs, 'tab-2', NEW_SHELL, ['tab-1', 'tab-2']);
    await expect(readClientStamps(cs)).resolves.toEqual({ 'tab-1': OLD_SHELL, 'tab-2': NEW_SHELL });
  });

  it('evicts windows that are gone, so a closed tab cannot condemn the fleet forever', async () => {
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'tab-1', OLD_SHELL, ['tab-1'], 1_000_000);
    const later = 1_000_000 + CLIENT_STAMP_SWEEP_GRACE_MS + 1;
    await expect(pruneClientStamps(cs, ['tab-2'], later)).resolves.toEqual({});
    await expect(readClientStamps(cs)).resolves.toEqual({});
  });

  it('never sweeps a record younger than the grace, whatever the live set says', async () => {
    // The live ids a sweep runs against are enumerated BEFORE it — matchAll is
    // async — so a window that opened in between is alive and absent from the
    // snapshot. Deleting its record would make an accepted tab read as
    // unregistered and get navigated, which is the harm the per-key records
    // exist to prevent, arriving by a different road.
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'tab-late', NEW_SHELL, null, 1_000_000);
    await expect(pruneClientStamps(cs, ['tab-1'], 1_000_000 + 10)).resolves.toEqual({ 'tab-late': NEW_SHELL });
  });

  it('keeps everything when the live set cannot be read at all', async () => {
    // Null is not "no windows are open": forgetting a tab that is still open
    // costs the rescue its evidence, while remembering a dead one costs at most
    // one force-activation that then navigates nobody.
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'tab-1', OLD_SHELL, null, 1_000_000);
    const later = 1_000_000 + CLIENT_STAMP_SWEEP_GRACE_MS + 1;
    await expect(pruneClientStamps(cs, null, later)).resolves.toEqual({ 'tab-1': OLD_SHELL });
    await expect(pruneClientStamps(cs, [], later)).resolves.toEqual({});
  });

  it('drops malformed records and never throws when storage refuses', async () => {
    const cs = fakeCacheStorage();
    const cache = await cs.open(SHELL_META_CACHE);
    await cache.put('/__gcb-client-build/a', new Response(JSON.stringify({ stamp: 42 })));
    await cache.put('/__gcb-client-build/b', new Response(JSON.stringify({ stamp: '' })));
    await cache.put('/__gcb-client-build/c', new Response(JSON.stringify({ stamp: NEW_SHELL })));
    await expect(readClientStamps(cs)).resolves.toEqual({ c: NEW_SHELL });
    const broken = { open: async () => Promise.reject(new Error('blocked')) } as unknown as CacheStorage;
    await expect(readClientStamps(broken)).resolves.toEqual({});
    await expect(recordClientStamp(broken, 'tab-1', NEW_SHELL, null)).resolves.toBeUndefined();
  });

  it('reads past the OTHER records living in the same cache', async () => {
    // `gcb-shell-meta` also holds the active stamp, the forced-activation
    // marker, and the floor throttle. Enumerating the cache has to tell those
    // apart from a client record rather than treating every key as one.
    const cs = fakeCacheStorage();
    await writeActiveStamp(cs, NEW_SHELL);
    await markForcedActivation(cs, NEW_SHELL, ARMED_FLOOR);
    await recordFloorCheck(cs, 1_000_000, true);
    await recordClientStamp(cs, 'tab-1', OLD_SHELL, ['tab-1']);
    await expect(readClientStamps(cs)).resolves.toEqual({ 'tab-1': OLD_SHELL });
  });

  it('round-trips a client id that is not url-safe', async () => {
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'tab/one?two#three', OLD_SHELL, ['tab/one?two#three']);
    await expect(readClientStamps(cs)).resolves.toEqual({ 'tab/one?two#three': OLD_SHELL });
  });
});

// Codex P2 round 5. An absence is the rescue's strongest evidence — it stands in
// as `UNKNOWN_ACTIVE_STAMP` for the decision and is condemned outright by
// `shouldNavigateClient` — and it is assembled from two reads nothing orders. A
// window posts `CLIENT_BUILD` to the ACTIVE worker while the decision runs in
// the INSTALLING one: separate globals, separate microtask queues. So a tab that
// opened moments ago is enumerable before its record is readable, and the
// five-minute sweep grace cannot help, because that shields records which EXIST.
describe('confirming an absence before believing it (#516)', () => {
  it('takes a second look when a live window has no record, and finds the late arrival', async () => {
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'tab-old', OLD_SHELL, ['tab-old']);
    const first = await readClientStamps(cs);
    // The write that was in flight in the OTHER worker while the decision read.
    const sleep = vi.fn(async () => {
      await recordClientStamp(cs, 'tab-fresh', NEW_SHELL, ['tab-old', 'tab-fresh']);
    });
    await expect(confirmClientStamps(cs, ['tab-old', 'tab-fresh'], first, sleep)).resolves.toEqual({
      'tab-old': OLD_SHELL,
      'tab-fresh': NEW_SHELL,
    });
    expect(sleep).toHaveBeenCalledWith(UNREGISTERED_CLIENT_CONFIRM_MS);
  });

  it('does not wait at all when every live window is already registered', async () => {
    // The ordinary case, on every install of every deploy. Paying a second of
    // latency for it would be a tax on the path that is never in doubt.
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'tab-1', NEW_SHELL, ['tab-1']);
    const first = await readClientStamps(cs);
    const sleep = vi.fn(async () => {});
    await expect(confirmClientStamps(cs, ['tab-1'], first, sleep)).resolves.toEqual(first);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('still reports a window that genuinely never registers — the stranded cohort', async () => {
    // A pre-#516 tab produces no record however long it is given, so the
    // confirmation must not turn the rescue's whole evidence into a no-op.
    const cs = fakeCacheStorage();
    const confirmed = await confirmClientStamps(cs, ['tab-legacy'], {}, async () => {});
    expect(hasUnregisteredClient(['tab-legacy'], confirmed)).toBe(true);
    expect(shouldNavigateClient(confirmed['tab-legacy'], ARMED_FLOOR)).toBe(true);
  });

  it('has nothing to confirm when the live set could not be read', async () => {
    const sleep = vi.fn(async () => {});
    await expect(confirmClientStamps(fakeCacheStorage(), null, {}, sleep)).resolves.toEqual({});
    expect(sleep).not.toHaveBeenCalled();
  });

  it('turns the force decision AROUND once the late record lands', async () => {
    // The end-to-end shape of the finding: an armed floor, a served shell above
    // it, and one live window whose record simply had not been written yet.
    const cs = fakeCacheStorage();
    const live = ['tab-fresh'];
    const decide = (clientStamps: Record<string, string>) =>
      shouldForceActivate({
        activeStamp: NEW_SHELL,
        ownStamp: NEW_SHELL,
        floor: ARMED_FLOOR,
        hasActiveWorker: true,
        clientStamps,
        liveClientIds: live,
      });
    expect(decide({})).toBe(true); // the racy read: absence reads as ancient
    const confirmed = await confirmClientStamps(cs, live, {}, async () => {
      await recordClientStamp(cs, 'tab-fresh', NEW_SHELL, live);
    });
    expect(decide(confirmed)).toBe(false);
  });
});

describe('the client build registry, as the decision reads it (#516)', () => {
  it('rescues a tab still EXECUTING an old build behind an up-to-date served shell', () => {
    // The whole ticket, as one assertion: without the client stamps this reads
    // `activeStamp: NEW_SHELL` and declines.
    expect(
      shouldForceActivate({
        activeStamp: NEW_SHELL,
        ownStamp: NEW_SHELL,
        floor: ARMED_FLOOR,
        clientStamps: { 'tab-1': OLD_SHELL, 'tab-2': NEW_SHELL },
        liveClientIds: ['tab-1', 'tab-2'],
      }),
    ).toBe(true);
  });

  it('still declines when every client is at or above the floor', () => {
    expect(
      shouldForceActivate({
        activeStamp: NEW_SHELL,
        ownStamp: NEW_SHELL,
        floor: ARMED_FLOOR,
        clientStamps: { 'tab-1': NEW_SHELL, 'tab-2': NEW_SHELL },
        liveClientIds: ['tab-1', 'tab-2'],
      }),
    ).toBe(false);
  });

  it('rescues an open window that never REGISTERED at all — the rollout case', () => {
    // Codex P1 round 2. On the very deploy that introduces `CLIENT_BUILD`,
    // every tab running the previous build is unregistered by definition. Let
    // one tab reload onto the accepted build and both the served shell and the
    // only registry entry read as current — so deciding over the registry alone
    // declines to force, `activate` never claims, and `shouldNavigateClient`
    // never gets the chance to notice the stranded tab.
    expect(
      shouldForceActivate({
        activeStamp: NEW_SHELL,
        ownStamp: NEW_SHELL,
        floor: ARMED_FLOOR,
        clientStamps: { 'tab-2': NEW_SHELL },
        liveClientIds: ['tab-1', 'tab-2'],
      }),
    ).toBe(true);
  });

  it('does NOT invent a stranded window when the live set could not be read', () => {
    // Null is "the windows could not be enumerated", which is not evidence that
    // an unregistered one exists — the fallback is the registry, unchanged.
    expect(
      shouldForceActivate({
        activeStamp: NEW_SHELL,
        ownStamp: NEW_SHELL,
        floor: ARMED_FLOOR,
        clientStamps: { 'tab-2': NEW_SHELL },
        liveClientIds: null,
      }),
    ).toBe(false);
  });

  it('still forces nobody under the inert floor, unregistered windows included', () => {
    // The safety property that makes shipping this a no-op survives treating an
    // absence as evidence: the stand-in stamp sits 1ms after the epoch, so it
    // is not below the inert floor either.
    expect(
      shouldForceActivate({
        activeStamp: NEW_SHELL,
        ownStamp: NEW_SHELL,
        floor: INERT_FLOOR,
        clientStamps: {},
        liveClientIds: ['tab-1', 'tab-2'],
      }),
    ).toBe(false);
  });

  it('gives every window its OWN record, so no write can reach another window`s', async () => {
    // Codex P2 round 3, and the structural statement of the fix. Round 2
    // ordered the writes with a module-scope promise chain, which is per-GLOBAL
    // state: a page posts `CLIENT_BUILD` to the ACTIVE worker while a
    // replacement worker sweeps the same record from its own `install`, and
    // those two globals hold two separate chains that cannot order each other.
    // Nothing here can be serialized across worker versions, so the fix is to
    // need no serialization: a registration writes exactly one key, its own.
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'tab-1', OLD_SHELL, ['tab-1']);
    cs._cache.put.mockClear();
    await recordClientStamp(cs, 'tab-2', NEW_SHELL, ['tab-1', 'tab-2']);
    const written = cs._cache.put.mock.calls.map((call) => String(call[0]));
    expect(written).toEqual([expect.stringContaining('tab-2')]);
    expect(written[0]).not.toContain('tab-1');
    await expect(readClientStamps(cs)).resolves.toEqual({ 'tab-1': OLD_SHELL, 'tab-2': NEW_SHELL });
  });

  it('loses neither of two windows naming themselves at the same instant', async () => {
    const cs = fakeCacheStorage();
    await Promise.all([
      recordClientStamp(cs, 'tab-1', OLD_SHELL, ['tab-1', 'tab-2']),
      recordClientStamp(cs, 'tab-2', NEW_SHELL, ['tab-1', 'tab-2']),
    ]);
    await expect(readClientStamps(cs)).resolves.toEqual({ 'tab-1': OLD_SHELL, 'tab-2': NEW_SHELL });
  });

  it('loses nothing when a sweep in ANOTHER worker overlaps a write in this one', async () => {
    // The cross-version case in the shape it actually takes: the installing
    // worker's sweep interleaved with the active worker's registration. No
    // shared state is available to order them, and none is needed.
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'tab-1', OLD_SHELL, ['tab-1']);
    const [, swept] = await Promise.all([
      recordClientStamp(cs, 'tab-2', NEW_SHELL, ['tab-1', 'tab-2']),
      pruneClientStamps(cs, ['tab-1', 'tab-2']),
    ]);
    expect(Object.keys(swept).length).toBeGreaterThanOrEqual(1);
    await expect(readClientStamps(cs)).resolves.toEqual({ 'tab-1': OLD_SHELL, 'tab-2': NEW_SHELL });
  });

  it('a sweep deleting a dead window leaves a live one`s record untouched', async () => {
    const cs = fakeCacheStorage();
    await recordClientStamp(cs, 'gone', OLD_SHELL, null, 1_000_000);
    await recordClientStamp(cs, 'here', NEW_SHELL, null, 1_000_000);
    const later = 1_000_000 + CLIENT_STAMP_SWEEP_GRACE_MS + 1;
    await expect(pruneClientStamps(cs, ['here'], later)).resolves.toEqual({ here: NEW_SHELL });
    await expect(readClientStamps(cs)).resolves.toEqual({ here: NEW_SHELL });
  });

  it('does not count a Firebase sign-in popup as one of our windows', () => {
    // Codex P2 round 3. `/__/auth/handler` is a same-origin window that is not
    // our page: it never runs main.tsx, so it never posts `CLIENT_BUILD` and is
    // absent from the registry — the exact shape the rescue reads as "ancient,
    // condemn it". Unfiltered, an open sign-in popup force-activates the fleet
    // on an armed floor with no stale app tab anywhere, and then gets navigated
    // out of the OAuth flow.
    expect(isAppShellClientUrl('https://gaycruisebingo.com/__/auth/handler?apiKey=x')).toBe(false);
    expect(isAppShellClientUrl('https://gaycruisebingo.com/__/auth/iframe')).toBe(false);
    expect(isAppShellClientUrl('https://gaycruisebingo.com/')).toBe(true);
    expect(isAppShellClientUrl('https://gaycruisebingo.com/board?day=3')).toBe(true);
    // A path that merely LOOKS reserved is ours; only the namespace is not.
    expect(isAppShellClientUrl('https://gaycruisebingo.com/__notauth')).toBe(true);
    // Unidentifiable reads as not-ours, so it is left strictly alone.
    expect(isAppShellClientUrl('not a url')).toBe(false);
  });

  it('navigates exactly the windows the floor condemns', () => {
    expect(shouldNavigateClient(OLD_SHELL, ARMED_FLOOR)).toBe(true);
    expect(shouldNavigateClient(NEW_SHELL, ARMED_FLOOR)).toBe(false);
  });

  it('navigates a window that never registered, and every window with no usable floor', () => {
    // An unregistered client is running a pre-#516 build or died before its
    // module scope ran — the stranded cohort — so "unknown" reads as condemned.
    expect(shouldNavigateClient(undefined, ARMED_FLOOR)).toBe(true);
    expect(shouldNavigateClient(NEW_SHELL, null)).toBe(true);
    expect(shouldNavigateClient(NEW_SHELL, '')).toBe(true);
  });
});

describe('the active-worker floor throttle', () => {
  it('is due when nothing has ever been recorded', async () => {
    await expect(dueForFloorRecheck(fakeCacheStorage(), 1_000_000)).resolves.toBe(true);
  });

  it('stays quiet for the full interval after a SUCCESSFUL read', async () => {
    const cs = fakeCacheStorage();
    await recordFloorCheck(cs, 1_000_000, true);
    await expect(dueForFloorRecheck(cs, 1_000_000 + 60_000)).resolves.toBe(false);
    await expect(dueForFloorRecheck(cs, 1_000_000 + 31 * 60_000)).resolves.toBe(true);
  });

  it('backs off only briefly after a FAILED read', async () => {
    // Phase 4b P2 on #515: recording the attempt before knowing the outcome let
    // one transient ship-Wi-Fi failure on the first navigation of an incident
    // silence every subsequent reload for half an hour — the worst possible
    // half hour to be silent in.
    const cs = fakeCacheStorage();
    await recordFloorCheck(cs, 1_000_000, false);
    await expect(dueForFloorRecheck(cs, 1_000_000 + 30_000)).resolves.toBe(false);
    await expect(dueForFloorRecheck(cs, 1_000_000 + 61_000)).resolves.toBe(true);
  });

  it('treats a record with no outcome field as a success, so an upgrade does not probe every navigation', async () => {
    const cs = fakeCacheStorage();
    const cache = await cs.open(SHELL_META_CACHE);
    await cache.put('/__gcb-floor-checked-at', new Response(JSON.stringify({ at: 1_000_000 })));
    await expect(dueForFloorRecheck(cs, 1_000_000 + 60_000)).resolves.toBe(false);
  });

  it('fails closed when storage refuses, rather than probing on every navigation', async () => {
    const broken = { open: async () => Promise.reject(new Error('blocked')) } as unknown as CacheStorage;
    await expect(dueForFloorRecheck(broken, 1)).resolves.toBe(false);
    await expect(recordFloorCheck(broken, 1, true)).resolves.toBeUndefined();
  });
});
