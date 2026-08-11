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

/** Synthetic key holding when the ACTIVE worker last re-read the floor. */
export const FLOOR_CHECKED_URL = '/__gcb-floor-checked-at';

/** Synthetic key holding what each OPEN WINDOW is EXECUTING (#516) — a
 *  `clientId -> build stamp` map. Same cache as the records above, so it
 *  survives the worker teardown the lifecycle permits between events. */
export const CLIENT_STAMPS_URL = '/__gcb-client-builds';

/** `clientId -> __BUILD_STAMP__` for every window that has named itself. */
export type ClientStamps = Record<string, string>;

/** How rarely the active worker re-reads the floor. It wakes on ordinary
 *  navigations, so this is the throttle that keeps an emergency lever from
 *  becoming a request on every page load. */
export const FLOOR_RECHECK_INTERVAL_MS = 30 * 60_000;

/** Backoff after a FAILED read, kept short on purpose — see below. */
export const FLOOR_RECHECK_FAILURE_INTERVAL_MS = 60_000;

/**
 * True when the active worker is due another floor read. Read-only: the outcome
 * is recorded separately by `recordFloorCheck`, because a failed probe must not
 * buy the same silence a successful one does (Phase 4b P2 on #515).
 *
 * Persisting the timestamp before knowing the outcome meant one transient
 * ship-Wi-Fi failure on the first navigation of an incident silenced every
 * subsequent reload for the full half hour, even if connectivity returned a
 * second later — the worst possible half hour to be silent in. A failed read
 * now backs off for a minute; only a successful one takes the long interval.
 *
 * Fails to `false` when storage refuses: an un-throttleable check that probes on
 * every navigation is worse than a missed one, since the floor is armed only
 * during an incident anyway.
 */
export async function dueForFloorRecheck(
  cacheStorage: CacheStorage,
  now: number,
  intervalMs = FLOOR_RECHECK_INTERVAL_MS,
  failureIntervalMs = FLOOR_RECHECK_FAILURE_INTERVAL_MS,
): Promise<boolean> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    const hit = await cache.match(FLOOR_CHECKED_URL);
    if (!hit) return true;
    const body = (await hit.json()) as { at?: unknown; ok?: unknown } | null;
    const at = body?.at;
    if (typeof at !== 'number') return true;
    // A record with no explicit `ok` predates this distinction — treat it as a
    // success so an upgrade cannot start probing on every navigation.
    const wait = body?.ok === false ? failureIntervalMs : intervalMs;
    return now - at >= wait;
  } catch {
    return false;
  }
}

/** Records the outcome of a floor read, which is what the throttle keys off. */
export async function recordFloorCheck(cacheStorage: CacheStorage, now: number, ok: boolean): Promise<void> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    await cache.put(FLOOR_CHECKED_URL, new Response(JSON.stringify({ at: now, ok })));
  } catch {
    /* storage refused — `dueForFloorRecheck` fails closed on the same failure */
  }
}

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
  /** False when there is no existing worker at all — a FIRST install. */
  hasActiveWorker?: boolean;
  /** What the open windows are EXECUTING (#516), keyed by the browser's own
   *  client id. Not the same thing as the shell being SERVED — see below. */
  clientStamps?: ClientStamps;
  /** EVERY open window, registered or not, or null when the live set could not
   *  be read. The ids are what make an absence visible — see below. */
  liveClientIds?: readonly string[] | null;
}): boolean {
  // A first install has no shell to rescue (Phase 4b P2 on #515). Without this,
  // `readActiveStamp()` returning null on a brand-new registration is
  // indistinguishable from a legacy pre-#514 worker, so an armed floor would
  // have a fresh client claim and re-navigate a page that is ALREADY running
  // the current build — discarding whatever the player did while the initial
  // precache was still installing, sign-in included.
  if (input.hasActiveWorker === false) return false;
  const active = input.activeStamp ?? UNKNOWN_ACTIVE_STAMP;
  const registry = input.clientStamps ?? {};
  // Decide over EVERY LIVE WINDOW, not merely the registered ones (Codex P1
  // round 2 on #516). Deciding over the registry alone loses the rollout case
  // this ticket exists for: a tab running the build that shipped BEFORE
  // `CLIENT_BUILD` existed cannot register at all, so on the very deploy that
  // introduces the registry every stranded tab is invisible to it. Let another
  // tab reload onto the accepted build — which updates `activeStamp` and adds
  // the only registry entry there is — and the served shell plus every
  // registered stamp are then above the floor, so the next worker declines to
  // force, `activate` never runs the claim, and `shouldNavigateClient` is never
  // reached to notice the unregistered tab at all. Deciding over the live ids
  // instead makes the ABSENCE itself the evidence: an id with no entry stands
  // in as `UNKNOWN_ACTIVE_STAMP`, exactly as an unrecorded shell does, and for
  // the same reason — a client that has not named itself is running a pre-#516
  // build or died before its module scope ran, which is the stranded cohort.
  //
  // A null/absent live set falls back to the registry, because "the windows
  // could not be enumerated" is not evidence that an unregistered one exists;
  // inventing one would force-activate on nothing at all.
  const clients = (input.liveClientIds ?? Object.keys(registry)).map((id) => registry[id] ?? UNKNOWN_ACTIVE_STAMP);
  // The OLDEST of the served shell and those clients is what the floor is
  // tested against (#516). `gcb-shell-meta` records the build that most
  // recently ACTIVATED, so two tabs on build A, one of which reloads onto B,
  // leave the record saying B — and a floor set between A and B would then read
  // "the shell is fine" and never rescue the tab still executing A. A set is
  // below the floor exactly when its minimum is, so `some` IS the oldest test.
  //
  // The inert shipped floor still force-activates nobody: `UNKNOWN_ACTIVE_STAMP`
  // sits one millisecond after the epoch precisely so a stand-in stamp — for an
  // unrecorded shell or now for an unregistered window — is not below it.
  if (![active, ...clients].some((stamp) => buildBelowFloor(stamp, input.floor))) return false;
  if (buildBelowFloor(input.ownStamp, input.floor)) return false;
  return true;
}

/**
 * Whether a forced activation should re-navigate THIS window (#516). Only the
 * clients actually below the floor are targeted: reloading a tab that is
 * already running a build the floor accepts discards whatever the player was
 * doing there and rescues nobody.
 *
 * An unregistered client navigates. It is either a page running a build from
 * before this registry existed or one that died before its module scope ran —
 * i.e. precisely the stranded cohort the rescue exists for — so "unknown" has
 * to read as "condemned", the same way `UNKNOWN_ACTIVE_STAMP` does. A floor
 * that is missing or malformed likewise navigates everything, because there is
 * then nothing to filter by and the `shouldForceActivate` decision that got us
 * here was made on other evidence.
 */
export function shouldNavigateClient(stamp: string | undefined, floor: unknown): boolean {
  if (stamp === undefined) return true;
  if (typeof floor !== 'string' || floor.trim() === '') return true;
  return buildBelowFloor(stamp, floor);
}

/** The registry as stored, with non-string entries dropped. Never throws — the
 *  empty map is the safe reading, since an unregistered client navigates. */
export async function readClientStamps(cacheStorage: CacheStorage): Promise<ClientStamps> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    const hit = await cache.match(CLIENT_STAMPS_URL);
    if (!hit) return {};
    const body: unknown = await hit.json();
    if (typeof body !== 'object' || body === null) return {};
    const clean: ClientStamps = {};
    for (const [id, stamp] of Object.entries(body as Record<string, unknown>)) {
      if (typeof stamp === 'string' && stamp !== '') clean[id] = stamp;
    }
    return clean;
  } catch {
    return {};
  }
}

/**
 * Drops entries whose window is gone, so a tab closed weeks ago cannot keep
 * reading as an ancient client and force-activate the fleet forever.
 *
 * `liveIds` of null means the live set could not be read at all. Keeping every
 * entry is the safe answer there: forgetting a tab that is still open costs the
 * rescue its evidence, while remembering a dead one costs at most one
 * force-activation that then navigates nobody (`shouldNavigateClient`).
 */
export function retainLiveClients(stamps: ClientStamps, liveIds: readonly string[] | null): ClientStamps {
  if (!liveIds) return stamps;
  const live = new Set(liveIds);
  return Object.fromEntries(Object.entries(stamps).filter(([id]) => live.has(id)));
}

async function putClientStamps(cacheStorage: CacheStorage, stamps: ClientStamps): Promise<void> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    await cache.put(CLIENT_STAMPS_URL, new Response(JSON.stringify(stamps)));
  } catch {
    /* storage refused — the client reads as unregistered, i.e. as condemned */
  }
}

/**
 * The tail of the registry's write chain (Codex P2 on #516).
 *
 * Every mutation here is a read-modify-write across four awaits — `open`,
 * `match`, `json`, `put` — and the worker runs each of them on its own
 * microtask. Two tabs posting `CLIENT_BUILD` close together therefore overlap:
 * both handlers read the same old map, each adds only its own entry, and the
 * second `cache.put` silently discards the first. Losing the STALE tab's entry
 * costs the install decision its evidence; losing a CURRENT tab's entry makes
 * that tab look unregistered, so a forced activation navigates it for nothing.
 *
 * One shared chain rather than a per-key lock, because a prune rewrites the
 * whole record too — a prune racing a record is the same lost update.
 *
 * Module state, and deliberately so: it only has to order the writes of ONE
 * worker instance. A torn-down worker has no in-flight writes left to order,
 * and the Cache is the durable record either way.
 */
let registryWrites: Promise<unknown> = Promise.resolve();

function serializeRegistryWrite<T>(op: () => Promise<T>): Promise<T> {
  // `then(op, op)` so a rejected predecessor still runs this one: the chain
  // orders writes, it must never be able to cancel them. Every op below
  // swallows its own storage failures, but the chain cannot assume that.
  const run = registryWrites.then(op, op);
  registryWrites = run.catch(() => undefined);
  return run;
}

/** Records what one window is executing, evicting dead windows in the same
 *  write. Called on every `CLIENT_BUILD`, which is once per page load, so the
 *  registry is swept about as often as it grows. */
export async function recordClientStamp(
  cacheStorage: CacheStorage,
  clientId: string,
  stamp: string,
  liveIds: readonly string[] | null,
): Promise<void> {
  await serializeRegistryWrite(async () => {
    const stamps = retainLiveClients(await readClientStamps(cacheStorage), liveIds);
    stamps[clientId] = stamp;
    await putClientStamps(cacheStorage, stamps);
  });
}

/** Sweeps the registry and returns what survived. */
export async function pruneClientStamps(
  cacheStorage: CacheStorage,
  liveIds: readonly string[] | null,
): Promise<ClientStamps> {
  return serializeRegistryWrite(async () => {
    const stamps = retainLiveClients(await readClientStamps(cacheStorage), liveIds);
    await putClientStamps(cacheStorage, stamps);
    return stamps;
  });
}

/**
 * Should the ACTIVE worker act on a floor it has just re-read? (Phase 4b P1 on
 * #515.)
 *
 * The install-time check alone cannot deliver the lever this feature advertises.
 * A worker installs, reads the floor — inert, which is what it ships as, so this
 * is the NORMAL case for every client — and settles into `waiting`. Arming the
 * floor afterwards changes nothing: later update checks find the same
 * byte-identical `sw.js` and never dispatch `install` again, and the dead page
 * cannot message the waiting worker. The floor would then only ever work when
 * paired with a redeploy, which is precisely the coupling #342 created
 * `build-floor.json` to remove.
 *
 * So the ACTIVE worker re-reads the floor too, on its own wake-ups, and acts
 * when the build it is serving is condemned.
 */
export function shouldActiveWorkerEvict(ownStamp: string, floor: unknown): boolean {
  return buildBelowFloor(ownStamp, floor);
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
export async function markForcedActivation(
  cacheStorage: CacheStorage,
  ownStamp: string,
  // The floor that justified the force, carried alongside the decision (#516)
  // so `activate` can target the clients it actually condemns. `activate` has
  // no way to re-read it: the probe is a network call, and by then the worker
  // is committed either way.
  floor: string | null = null,
): Promise<void> {
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    await cache.put(FORCED_FLAG_URL, new Response(JSON.stringify({ stamp: ownStamp, floor })));
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
export async function takeForcedActivation(
  cacheStorage: CacheStorage,
  ownStamp: string,
): Promise<{ forced: boolean; floor: string | null }> {
  const none = { forced: false, floor: null };
  try {
    const cache = await cacheStorage.open(SHELL_META_CACHE);
    const hit = await cache.match(FORCED_FLAG_URL);
    if (!hit) return none;
    await cache.delete(FORCED_FLAG_URL);
    const body = (await hit.json()) as { stamp?: unknown; floor?: unknown } | null;
    if (body?.stamp !== ownStamp) return none;
    return { forced: true, floor: typeof body.floor === 'string' ? body.floor : null };
  } catch {
    return none;
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
