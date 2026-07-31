// Service-worker-side build floor (#514) — the rescue path for clients whose
// PAGE can no longer help.
//
// WHY THIS EXISTS. #513 gave the app an in-page recovery path: an ErrorBoundary
// that survives a render crash, and a module-scope floor check that runs even
// when React never mounts. Both ship inside the client bundle, so both are
// useless to a client that is stranded on an OLDER shell — its old bundle has
// neither, its React tree is dead, and the newer worker sits in `waiting`
// forever because `updateServiceWorker(true)` is only ever called by a page
// that is no longer running. That was the 2026-07-24 cohort, and #513 could not
// reach it (Phase 4b P1 on #513).
//
// THE INSIGHT THAT MAKES THIS WORK. A *waiting* worker has already been
// installed — the browser evaluated its script and fired its `install` event.
// So logic placed in `install` runs on a stranded client, in a context the dead
// page cannot affect, and can call `skipWaiting()` to promote ITSELF. No page
// cooperation, no message channel, nothing for the crashed tab to do. The
// browser re-checks `/sw.js` on navigation and it is served `no-cache`
// (firebase.json), so a stranded player merely reloading is enough to deliver
// this code.
//
// Pure and DOM-free on purpose: everything here is unit-tested in
// src/sw-rescue.test.ts without a service-worker environment, and the Cache
// handles are injected rather than reached for globally.

import { buildBelowFloor } from './buildFloor';
import { probeTimeoutSignal } from './canonical-redirect';

/** Where the active shell records its build stamp for the NEXT worker to read. */
export const SHELL_META_CACHE = 'gcb-shell-meta';

/** Synthetic same-origin key for that record — never fetched over the network. */
export const ACTIVE_STAMP_URL = '/__gcb-active-build-stamp';

/**
 * Stand-in stamp for an active shell that recorded none. Every worker built
 * before #514 is in this state, which is exactly the stranded cohort, so
 * "unrecorded" has to read as "ancient" for the rescue to reach them.
 *
 * Deliberately ONE MILLISECOND after the epoch rather than the epoch itself:
 * `public/build-floor.json` ships inert at `1970-01-01T00:00:00.000Z`, and
 * `buildBelowFloor` is a strict `<`. At +1ms an unrecorded shell is NOT below
 * the inert floor — so shipping this feature force-activates nobody — while any
 * real floor an operator sets is far enough in the future to evict it.
 */
export const UNKNOWN_ACTIVE_STAMP = '1970-01-01T00:00:00.001Z';

/**
 * Should a freshly installed worker promote itself instead of waiting to be
 * asked? Both halves must hold:
 *
 *  - the ACTIVE shell is below the served floor (an unrecorded stamp counts as
 *    ancient, per `UNKNOWN_ACTIVE_STAMP`); and
 *  - THIS worker is not itself below that floor — otherwise a floor set past
 *    every existing build would have workers force-activating onto shells the
 *    same floor condemns, which is churn, not rescue.
 *
 * Every doubtful input fails to `false` by way of `buildBelowFloor`, which
 * refuses malformed and missing floors. So a broken `build-floor.json` cannot
 * force-activate anyone, and the inert shipped floor is a no-op for everybody.
 */
export function shouldForceActivate(input: {
  activeStamp: string | null;
  ownStamp: string;
  floor: unknown;
}): boolean {
  const active = input.activeStamp ?? UNKNOWN_ACTIVE_STAMP;
  if (!buildBelowFloor(active, input.floor)) return false;
  if (buildBelowFloor(input.ownStamp, input.floor)) return false;
  return true;
}

/**
 * The build stamp of the shell currently in charge, or null when nothing has
 * recorded one — a pre-#514 worker, a cleared cache, or a storage mode that
 * refuses us. Never throws: a rescue path that can throw during `install`
 * would break the very update it is meant to deliver.
 */
export async function readActiveStamp(cacheStorage: CacheStorage): Promise<string | null> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    const res = await cache.match(ACTIVE_STAMP_URL);
    if (!res) return null;
    const body: unknown = await res.json();
    const stamp = (body as { stamp?: unknown } | null)?.stamp;
    return typeof stamp === 'string' && stamp !== '' ? stamp : null;
  } catch {
    return null;
  }
}

/** Records this worker's stamp as the active shell. Best-effort by design: a
 *  failure here degrades the NEXT worker to "unrecorded", which is the safe
 *  reading (ancient), not a wrong one. */
export async function writeActiveStamp(cacheStorage: CacheStorage, stamp: string): Promise<void> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    await cache.put(ACTIVE_STAMP_URL, new Response(JSON.stringify({ stamp })));
  } catch {
    /* storage refused — the next worker reads null and treats it as ancient */
  }
}

/**
 * Reads the served floor from inside the worker. Cache-busted and `no-store` so
 * neither the HTTP cache nor this worker's own precache can answer — and
 * `/build-floor.json` is excluded from the precache glob for that reason.
 * Any failure resolves to null, which `shouldForceActivate` reads as "no force".
 */
export async function fetchFloorInWorker(
  fetchImpl: typeof fetch,
  timestamp: number,
  timeoutMs = 5000,
): Promise<string | null> {
  // Bounded, because this runs inside `install`'s `waitUntil`: an unbounded
  // request would stall the very worker installation it is meant to accelerate,
  // and a captive portal that accepts connections but never answers is exactly
  // the environment this app lives in.
  const { signal, cleanup } = probeTimeoutSignal(timeoutMs);
  try {
    const res = await fetchImpl(`/build-floor.json?ts=${timestamp}`, { cache: 'no-store', signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const floor = (body as { floor?: unknown } | null)?.floor;
    return typeof floor === 'string' ? floor : null;
  } catch {
    return null;
  } finally {
    cleanup();
  }
}
