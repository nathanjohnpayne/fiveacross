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
    clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => clients) },
    __WB_MANIFEST: [{ url: 'index.html', revision: 'abc' }],
  };
  vi.stubGlobal('self', self);

  const cacheStore = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (k: string) => cacheStore.get(k)),
    put: vi.fn(async (k: string, v: Response) => {
      cacheStore.set(k, v);
    }),
  };
  vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
  return { self, handlers, cacheStore, navigated, clients };
}

function stubFloor(floor: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ floor }) } as unknown as Response),
  );
}

/** Fires a lifecycle handler and awaits whatever it passed to waitUntil. */
async function fire(handlers: Handlers, type: string, data?: unknown) {
  const pending: Promise<unknown>[] = [];
  handlers[type]?.({ waitUntil: (p: Promise<unknown>) => pending.push(p), data });
  await Promise.all(pending);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
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
