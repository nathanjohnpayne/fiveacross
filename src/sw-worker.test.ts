import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Drives the ACTUAL install/activate handlers in src/sw.ts (#514), not just the
// pure decision layer in src/sw-rescue.test.ts. The worker is where the rescue
// either happens or does not: a correct `shouldForceActivate` wired to the wrong
// lifecycle event rescues nobody, and that mistake would pass every test in the
// pure suite. The workbox modules are mocked away — this is about the lifecycle
// wiring and the rescue, not about re-testing workbox's routing.

const precacheAndRoute = vi.hoisted(() => vi.fn());
const cleanupOutdatedCaches = vi.hoisted(() => vi.fn());
const createHandlerBoundToURL = vi.hoisted(() => vi.fn(() => 'handler'));
const registerRoute = vi.hoisted(() => vi.fn());
const NavigationRoute = vi.hoisted(() => vi.fn());

vi.mock('workbox-precaching', () => ({ precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL }));
vi.mock('workbox-routing', () => ({ registerRoute, NavigationRoute }));
vi.mock('workbox-strategies', () => ({ CacheFirst: vi.fn() }));
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: vi.fn() }));
vi.mock('workbox-cacheable-response', () => ({ CacheableResponsePlugin: vi.fn() }));

// An armed floor must sit BETWEEN the shell being condemned and this build:
// newer than the active shell (unrecorded, so `UNKNOWN_ACTIVE_STAMP` at epoch+1ms)
// but not newer than `__BUILD_STAMP__`, which is stamped at build time — i.e.
// "now" for a test run. A floor past this build is the separate condemned-worker
// case below, and it deliberately refuses to force.
const ARMED_FLOOR = '2026-07-24T00:00:00.000Z'; // the cells-map migration deploy
const FLOOR_PAST_THIS_BUILD = '2099-01-01T00:00:00.000Z';
const INERT_FLOOR = '1970-01-01T00:00:00.000Z';

type Handlers = Record<string, (event: unknown) => void>;

/** A minimal ServiceWorkerGlobalScope that records what the worker did. */
function installFakeWorker() {
  const handlers: Handlers = {};
  const navigated: string[] = [];
  const clients = [{ url: 'https://gaycruisebingo.com/more', navigate: vi.fn(async (u: string) => navigated.push(u) )}];
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn;
    },
    skipWaiting: vi.fn(async () => {}),
    registration: {
      active: {} as unknown,        // an existing shell, unless a test says otherwise
      waiting: null as null | { postMessage: (m: unknown) => void },
      unregister: vi.fn(async () => true),
    },
    clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => clients) },
    __WB_MANIFEST: [{ url: 'index.html', revision: 'abc' }],
  };
  vi.stubGlobal('self', self);

  const cache = {
    match: vi.fn(async (k: string) => sharedCacheStore.get(k)),
    put: vi.fn(async (k: string, v: Response) => {
      sharedCacheStore.set(k, v);
    }),
    delete: vi.fn(async (k: string) => sharedCacheStore.delete(k)),
  };
  const deletedCaches: string[] = [];
  vi.stubGlobal('caches', {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ['workbox-precache-v2-x', 'proof-media']),
    delete: vi.fn(async (k: string) => {
      deletedCaches.push(k);
      return true;
    }),
  });
  // The install-time floor probe retries with real delays between attempts, so
  // a failing-probe test would otherwise sit through them. Firing timers
  // immediately keeps the retry LOGIC exercised — the attempts still happen, in
  // order — while costing no wall-clock.
  vi.stubGlobal('setTimeout', ((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
  return { self, handlers, cacheStore: sharedCacheStore, navigated, clients, deletedCaches };
}

// Cache storage OUTLIVES a worker instance in the browser, so the fake must too
// — otherwise a "worker was torn down" test would also wipe the very storage
// the fix relies on, and would pass for the wrong reason. Reset per test.
let sharedCacheStore = new Map<string, Response>();

function stubFloor(floor: string | null) {
  // Shaped like a REAL same-origin answer — `redirected: false` and a
  // same-origin `url` — so these lifecycle tests cannot pass by accident if the
  // interception barriers in `fetchFloorInWorker` regress. A bare
  // `{ ok, json }` would sail through on undefined fields (Phase 4b P1 on #515).
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      redirected: false,
      url: `${location.origin}/build-floor.json`,
      json: async () => ({ floor }),
    } as unknown as Response),
  );
}

/** Fires a lifecycle handler and awaits whatever it passed to waitUntil. */
async function fire(handlers: Handlers, type: string, data?: unknown) {
  const pending: Promise<unknown>[] = [];
  handlers[type]?.({ waitUntil: (p: Promise<unknown>) => pending.push(p), data });
  await Promise.all(pending);
}

/** Fires a navigation `fetch`, which is what wakes the active worker. */
async function fireNavigation(handlers: Handlers) {
  const pending: Promise<unknown>[] = [];
  handlers.fetch?.({
    request: { mode: 'navigate' },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  } as unknown);
  await Promise.all(pending);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  sharedCacheStore = new Map();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the worker wires up its ported responsibilities', () => {
  it('precaches, cleans outdated caches, and registers its routes on evaluation', async () => {
    installFakeWorker();
    stubFloor(INERT_FLOOR);
    await import('./sw');
    expect(precacheAndRoute).toHaveBeenCalledOnce();
    expect(cleanupOutdatedCaches).toHaveBeenCalledOnce();
    expect(createHandlerBoundToURL).toHaveBeenCalledWith('index.html');
    // The navigation route plus the proof-media route.
    expect(registerRoute).toHaveBeenCalledTimes(2);
  });
});

describe('the friendly path (#178) still works', () => {
  it('skips waiting when the PAGE asks via SKIP_WAITING', async () => {
    const w = installFakeWorker();
    stubFloor(INERT_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'message', { type: 'SKIP_WAITING' });
    expect(w.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it('ignores unrelated messages', async () => {
    const w = installFakeWorker();
    stubFloor(INERT_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'message', { type: 'SOMETHING_ELSE' });
    await fire(w.handlers, 'message', null);
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('the two activation paths cannot conflict — both routed through an idempotent skipWaiting', async () => {
    // The gap called out in the #515 self-review. A forced install-time
    // activation and a page-driven SKIP_WAITING can both land in one worker
    // lifetime; neither is guarded against the other, so this pins that the
    // second one is simply a no-op rather than an error or a double activation.
    const w = installFakeWorker();
    stubFloor(ARMED_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'install');
    expect(w.self.skipWaiting).toHaveBeenCalledOnce(); // the rescue fired
    await fire(w.handlers, 'message', { type: 'SKIP_WAITING' }); // page asks anyway
    expect(w.self.skipWaiting).toHaveBeenCalledTimes(2);
    await fire(w.handlers, 'activate');
    expect(w.self.clients.claim).toHaveBeenCalledOnce(); // still exactly one claim
  });
});

describe('the rescue (#514)', () => {
  it('force-activates on install when the floor condemns the active shell', async () => {
    const w = installFakeWorker(); // no recorded stamp => ancient
    stubFloor(ARMED_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'install');
    expect(w.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it('does NOT force-activate under the inert shipped floor', async () => {
    // The property that makes shipping this safe: nobody is force-activated.
    const w = installFakeWorker();
    stubFloor(INERT_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'install');
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('does NOT force-activate when the floor also condemns THIS build', async () => {
    // Promoting onto a shell the same floor condemns is churn, not rescue —
    // and it is the shape a fat-fingered floor (a far-future date) actually
    // takes, so the worker has to refuse it rather than thrash the fleet.
    const w = installFakeWorker();
    stubFloor(FLOOR_PAST_THIS_BUILD);
    await import('./sw');
    await fire(w.handlers, 'install');
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('does NOT force-activate when the floor cannot be read', async () => {
    const w = installFakeWorker();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await import('./sw');
    await fire(w.handlers, 'install');
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('install NEVER rejects, even when every dependency throws', async () => {
    // A worker that cannot install is a worker that can never rescue anyone.
    const w = installFakeWorker();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    vi.stubGlobal('caches', { open: vi.fn().mockRejectedValue(new Error('blocked')) });
    await import('./sw');
    await expect(fire(w.handlers, 'install')).resolves.toBeUndefined();
  });

  it('records its own stamp on EVERY activation, forced or not', async () => {
    const w = installFakeWorker();
    stubFloor(INERT_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'install'); // no force
    await fire(w.handlers, 'activate');
    const stored = w.cacheStore.get('/__gcb-active-build-stamp');
    expect(stored).toBeDefined();
    await expect(stored!.json()).resolves.toEqual({ stamp: __BUILD_STAMP__ });
  });

  it('claims and NAVIGATES open windows after a forced activation', async () => {
    // The page cannot be asked to reload — it may be a blank tab whose React
    // tree is already gone. The worker drives it.
    const w = installFakeWorker();
    stubFloor(ARMED_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'install');
    await fire(w.handlers, 'activate');
    expect(w.self.clients.claim).toHaveBeenCalledOnce();
    expect(w.navigated).toEqual(['https://gaycruisebingo.com/more']);
  });

  it('still claims and navigates when the worker was TORN DOWN between install and activate', async () => {
    // Codex P1 on #515. The lifecycle permits the browser to discard the worker
    // global between the two events, and module state does not survive it.
    // Losing the decision leaves `skipWaiting()` done but the navigation
    // skipped — so the reload that DISCOVERED the update finishes on the old
    // broken shell and the stranded player must reload a second time, which is
    // the exact dead end this feature exists to end.
    const first = installFakeWorker();
    stubFloor(ARMED_FLOOR);
    await import('./sw');
    await fire(first.handlers, 'install');
    expect(first.self.skipWaiting).toHaveBeenCalledOnce();

    // Worker torn down: fresh module registry, fresh globals — but the same
    // Cache storage, exactly as the browser behaves.
    vi.resetModules();
    const second = installFakeWorker();
    stubFloor(ARMED_FLOOR);
    await import('./sw');
    await fire(second.handlers, 'activate');

    expect(second.self.clients.claim).toHaveBeenCalledOnce();
    expect(second.navigated).toEqual(['https://gaycruisebingo.com/more']);
  });

  it('consumes the persisted decision, so a LATER ordinary activation does not re-navigate', async () => {
    // A stale "force" left in storage would yank the player's windows on some
    // unrelated future activation.
    const first = installFakeWorker();
    stubFloor(ARMED_FLOOR);
    await import('./sw');
    await fire(first.handlers, 'install');
    await fire(first.handlers, 'activate');

    vi.resetModules();
    const later = installFakeWorker();
    stubFloor(INERT_FLOOR);
    await import('./sw');
    await fire(later.handlers, 'activate');
    expect(later.self.clients.claim).not.toHaveBeenCalled();
    expect(later.navigated).toEqual([]);
  });

  it('clears a marker from a PREVIOUS install attempt of the same worker', async () => {
    // Phase 4b P2 on #515. A discarded installation is retried from the
    // IDENTICAL script, so both attempts carry the same `__BUILD_STAMP__` and
    // the stamp binding cannot tell them apart. Attempt 1 forces under an armed
    // floor; the floor is then disarmed and attempt 2 installs normally — it
    // must NOT inherit attempt 1's marker and navigate every open tab.
    const first = installFakeWorker();
    stubFloor(ARMED_FLOOR);
    await import('./sw');
    await fire(first.handlers, 'install');
    expect(first.self.skipWaiting).toHaveBeenCalledOnce();

    vi.resetModules();
    const retry = installFakeWorker();
    stubFloor(INERT_FLOOR); // operator disarmed the floor in between
    await import('./sw');
    await fire(retry.handlers, 'install');
    await fire(retry.handlers, 'activate');

    expect(retry.self.skipWaiting).not.toHaveBeenCalled();
    expect(retry.self.clients.claim).not.toHaveBeenCalled();
    expect(retry.navigated).toEqual([]);
  });

  it('does NOT claim or navigate when activation was not forced', async () => {
    const w = installFakeWorker();
    stubFloor(INERT_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'install');
    await fire(w.handlers, 'activate');
    expect(w.self.clients.claim).not.toHaveBeenCalled();
    expect(w.navigated).toEqual([]);
  });

  it('survives a client that refuses to navigate', async () => {
    const w = installFakeWorker();
    w.clients[0].navigate = vi.fn().mockRejectedValue(new Error('not controlled'));
    stubFloor(ARMED_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'install');
    await expect(fire(w.handlers, 'activate')).resolves.toBeUndefined();
    expect(w.self.clients.claim).toHaveBeenCalledOnce();
  });
});

describe('the ACTIVE worker re-reads the floor (#515 Phase 4b P1)', () => {
  it('EVICTS rather than promoting a waiting worker, whose build it cannot vouch for', async () => {
    // The case the install-time check structurally cannot cover: this worker
    // installed while the floor was inert — the normal state, since that is
    // what it ships as — and is now serving. Arming the floor afterwards never
    // re-fires `install`, because `sw.js` is byte-identical, and the dead page
    // cannot message the waiting worker. Without this the lever would only work
    // alongside a redeploy, which is the coupling #342 exists to remove.
    // Phase 4b P1 on #515: an active worker cannot read a waiting worker's
    // build stamp, so promoting it could swap one condemned build for another —
    // and the replacement would inherit the throttle record just written, so it
    // would not re-evict for the full interval either. Eviction sidesteps the
    // question: the next navigation goes to the network, which serves whatever
    // is deployed, necessarily at or above the floor.
    const w = installFakeWorker();
    const postMessage = vi.fn();
    w.self.registration.waiting = { postMessage };
    stubFloor(FLOOR_PAST_THIS_BUILD); // condemns the build this worker serves
    await import('./sw');
    await fireNavigation(w.handlers);
    expect(postMessage).not.toHaveBeenCalled();
    expect(w.self.registration.unregister).toHaveBeenCalledOnce();
    expect(w.deletedCaches).toEqual(['workbox-precache-v2-x']);
  });

  it('evicts itself when there is no replacement to promote', async () => {
    const w = installFakeWorker();
    stubFloor(FLOOR_PAST_THIS_BUILD);
    await import('./sw');
    await fireNavigation(w.handlers);
    expect(w.deletedCaches).toEqual(['workbox-precache-v2-x']); // proof media spared
    expect(w.self.registration.unregister).toHaveBeenCalledOnce();
  });

  it('does nothing under the inert floor', async () => {
    const w = installFakeWorker();
    stubFloor(INERT_FLOOR);
    await import('./sw');
    await fireNavigation(w.handlers);
    expect(w.deletedCaches).toEqual([]);
    expect(w.self.registration.unregister).not.toHaveBeenCalled();
  });

  it('throttles: a second navigation does not re-read the floor', async () => {
    const w = installFakeWorker();
    stubFloor(INERT_FLOOR);
    await import('./sw');
    await fireNavigation(w.handlers);
    const callsAfterFirst = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await fireNavigation(w.handlers);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsAfterFirst);
  });

  it('ignores non-navigation requests entirely', async () => {
    const w = installFakeWorker();
    stubFloor(FLOOR_PAST_THIS_BUILD);
    await import('./sw');
    const pending: Promise<unknown>[] = [];
    w.handlers.fetch?.({ request: { mode: 'cors' }, waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown);
    await Promise.all(pending);
    expect(w.self.registration.unregister).not.toHaveBeenCalled();
  });
});

describe('a FIRST install is not a stranded shell (#515 Phase 4b P2)', () => {
  it('does not force-activate when there is no existing worker at all', async () => {
    // `readActiveStamp()` returns null both for a legacy pre-#514 worker and
    // for a brand-new registration. Treating the latter as ancient would have a
    // fresh client claim and re-navigate a page already running the current
    // build — discarding whatever the player did while the precache installed.
    const w = installFakeWorker();
    w.self.registration.active = null;
    stubFloor(ARMED_FLOOR);
    await import('./sw');
    await fire(w.handlers, 'install');
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
  });
});
