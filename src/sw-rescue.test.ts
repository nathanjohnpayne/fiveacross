import { describe, it, expect, vi } from 'vitest';
import {
  ACTIVE_STAMP_URL,
  SHELL_META_CACHE,
  UNKNOWN_ACTIVE_STAMP,
  fetchFloorInWorker,
  readActiveStamp,
  shouldForceActivate,
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

function fakeCacheStorage(initial?: unknown) {
  const store = new Map<string, Response>();
  if (initial !== undefined) store.set(ACTIVE_STAMP_URL, new Response(JSON.stringify(initial)));
  const cache = {
    match: vi.fn(async (k: string) => store.get(k)),
    put: vi.fn(async (k: string, v: Response) => {
      store.set(k, v);
    }),
  };
  return { open: vi.fn(async () => cache), _store: store, _cache: cache } as unknown as CacheStorage & {
    _store: Map<string, Response>;
    _cache: typeof cache;
  };
}

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
