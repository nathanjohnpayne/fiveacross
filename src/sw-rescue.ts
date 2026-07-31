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

/** Synthetic key carrying "this worker force-activated" from `install` to
 *  `activate`. Same cache, same never-fetched convention. */
export const FORCED_FLAG_URL = '/__gcb-forced-activation';

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
 * Records that this worker force-activated, so `activate` still knows even if
 * the browser tore the worker down in between (Codex P1 on #515).
 *
 * The service-worker lifecycle explicitly permits that teardown, and module
 * state does not survive it. Losing the decision costs the rescue its whole
 * point: `skipWaiting()` has already happened, but without the claim and the
 * navigate, the reload that DISCOVERED the update finishes on the old broken
 * shell — so a stranded player sees the blank screen again and has to reload a
 * second time, which is precisely the dead end they were stuck in.
 */
export async function markForcedActivation(cacheStorage: CacheStorage, ownStamp: string): Promise<void> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    await cache.put(FORCED_FLAG_URL, new Response(JSON.stringify({ stamp: ownStamp })));
  } catch {
    /* storage refused — the caller's in-memory flag is the remaining fallback */
  }
}

/**
 * Drops any marker left by a previous install ATTEMPT of this same worker
 * (Phase 4b P2 on #515).
 *
 * The stamp binding alone cannot cover this: a discarded installation is
 * retried from the identical `sw.js`, so both attempts carry the same
 * `__BUILD_STAMP__` and the marker written by the first is indistinguishable
 * from one written by the second. If the floor is disarmed in between, the
 * retry installs normally, declines to force — and would still inherit the
 * first attempt's marker, turning its ordinary activation into a forced
 * claim-and-navigation of every open tab. So each attempt starts from a clean
 * slate and re-earns the marker.
 */
export async function clearForcedActivation(cacheStorage: CacheStorage): Promise<void> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    await cache.delete(FORCED_FLAG_URL);
  } catch {
    /* nothing to clear, or storage refused */
  }
}

/**
 * Consumes the flag: reports whether a forced activation is pending FOR THIS
 * WORKER, and clears it either way.
 *
 * The stamp binding matters because the marker outlives the worker that wrote
 * it (Phase 4b P2 on #515). This handler can record the flag and then have the
 * whole installation discarded — Workbox's separate precache install listener
 * rejecting on one unavailable asset is enough — while the cache entry
 * survives. Without the binding, some later worker that never chose to force
 * would consume that orphaned boolean and claim-and-navigate every open tab,
 * potentially long after the floor was disarmed. Clearing on mismatch is
 * deliberate: an orphaned marker is garbage, and leaving it would let it
 * ambush a different worker later.
 */
export async function takeForcedActivation(cacheStorage: CacheStorage, ownStamp: string): Promise<boolean> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    const hit = await cache.match(FORCED_FLAG_URL);
    if (!hit) return false;
    await cache.delete(FORCED_FLAG_URL);
    const body: unknown = await hit.json();
    return (body as { stamp?: unknown } | null)?.stamp === ownStamp;
  } catch {
    return false;
  }
}

/**
 * Reads the served floor from inside the worker. Cache-busted and `no-store` so
 * neither the HTTP cache nor this worker's own precache can answer — and
 * `/build-floor.json` is excluded from the precache glob for that reason.
 * Any failure resolves to null, which `shouldForceActivate` reads as "no force".
 *
 * HARDENED LIKE `originReachable` IN src/shellRecovery.ts, and for a worse
 * consequence (Phase 4b P1 on #515). `fetch` follows redirects by default, so a
 * captive portal can answer this request from its own login page with a
 * parseable `{ "floor": ... }` body — and here that is not merely a bad
 * reachability signal, it is an ACTIVATION COMMAND: the worker would
 * `skipWaiting()`, claim every client, and reload every window on a portal's
 * say-so. Same three barriers, since a portal only has to defeat one:
 *   1. `redirect: 'error'` — a portal bounce rejects instead of resolving;
 *   2. the FINAL response URL must still be same-origin, for interceptors that
 *      proxy in place rather than redirect;
 *   3. the body must carry a `floor` string, which no login page will.
 */
/**
 * The floor read as `install` actually uses it: retried, because this worker
 * gets exactly ONE chance at it (Phase 4b P1 on #515).
 *
 * A waiting worker never re-runs `install`. The browser re-fetches `/sw.js` on
 * later navigations, finds it byte-identical, and does nothing — so a floor
 * probe that failed transiently is never retried, the rescue silently never
 * fires, and the dead page still cannot send `SKIP_WAITING`. The failure window
 * is also the worst possible one: the probe happens during a reload on a bad
 * connection, which is the normal state of this app's network.
 *
 * Retries make that single chance count. They cannot make it unconditional —
 * the honest limits are that the marker is armed only while this worker is
 * installing, and that a genuinely offline device recovers on the next
 * navigation after connectivity returns, or when every window closes and the
 * waiting worker activates on its own. Baking the floor into the build was the
 * alternative and is worse: it would tie the emergency lever to a redeploy,
 * which is exactly what #342 built `build-floor.json` to avoid.
 *
 * `sleep` is injected so tests do not spend real time.
 */
export async function fetchFloorWithRetry(
  fetchImpl: typeof fetch,
  now: () => number,
  opts: {
    attempts?: number;
    timeoutMs?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string | null> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 2000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const floor = await fetchFloorInWorker(fetchImpl, now(), opts.timeoutMs);
    if (floor !== null) return floor;
    // Don't sleep after the final attempt — that is pure added install latency
    // for a device that is simply offline.
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return null;
}

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
    const res = await fetchImpl(`/build-floor.json?ts=${timestamp}`, {
      cache: 'no-store',
      signal,
      redirect: 'error',
    });
    if (!res.ok) return null;
    if (res.redirected) return null;
    if (res.url && typeof location !== 'undefined' && new URL(res.url, location.href).origin !== location.origin) {
      return null;
    }
    const body: unknown = await res.json();
    const floor = (body as { floor?: unknown } | null)?.floor;
    return typeof floor === 'string' ? floor : null;
  } catch {
    return null;
  } finally {
    cleanup();
  }
}
