// Shell recovery: the escape hatch for a client whose PRECACHED SHELL can no
// longer run against live data.
//
// THE FAILURE THIS EXISTS FOR (the 2026-07-24 blank-screen incident). The
// cells-map migration (#457) flipped the Board `cells` wire shape from array to
// map. Every client still running a PRE-migration precached shell then threw
// `cells.every is not a function` out of `isPristine` during render. React
// unmounts the WHOLE root when an error escapes with no boundary, so the crash
// took down `UpdatePrompt` — the only thing that ever calls
// `updateServiceWorker(true)`. With `registerType: 'prompt'` (vite.config.ts)
// the newer service worker installs and WAITS for exactly that call, so it
// never activated: the broken shell served itself forever, on every reload, and
// the #342 build-floor lever could not reach those clients either because the
// floor check also lives inside the tree that just died.
//
// The lesson is the invariant this module encodes: RECOVERY MUST NOT DEPEND ON
// THE APP RENDERING. Everything here is framework-free and runs from
// `main.tsx`'s module scope (and from the ErrorBoundary fallback), never from
// inside a component that a crash can take with it.

import { buildBelowFloor, fetchBuildFloor } from './buildFloor';
import { probeTimeoutSignal } from './canonical-redirect';

/**
 * Marks that this tab already spent its ONE automatic reset. A shell reset ends
 * in `location.reload()`, so an unguarded auto-reset on a crash that survives
 * the reset (a genuine app bug, not a stale shell) is an infinite reload loop.
 * Session-scoped, so closing the tab restores the one free attempt.
 */
const ATTEMPT_KEY = 'gcb:shell-reset-attempted';

/** Workbox names the precache `workbox-precache-v2-<origin>` — the prefix is the
 *  stable part of that contract and is what identifies a SHELL cache. */
const PRECACHE_PREFIX = 'workbox-precache';

// Every storage/SW touch is guarded exactly like src/data/cardCache.ts's
// `store()`: these APIs throw in some privacy modes and are absent under SSR
// and in unit tests. A recovery path that can itself throw is not a recovery
// path — every failure here degrades to "no recovery", never to a new crash.
function session(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * The one-attempt latch, generalized over its storage key (#722).
 *
 * The shell reset is no longer the only automatic recovery that ends in a
 * `location.reload()` — `src/firestoreRecovery.ts` adds one for a Firestore
 * instance killed by the `b815` poison latch. Both need the identical bound and
 * the identical failure semantics, and the subtle half of this (the read-back
 * below) was only got right after two review rounds on #513. So the primitive is
 * shared rather than re-derived; what is NOT shared is the key, and that is
 * deliberate: separate budgets mean a spent shell reset can never leave a
 * later, unrelated poisoning with no recovery of its own.
 *
 * True once the attempt named by `key` has been spent in this tab.
 */
export function attemptSpent(key: string): boolean {
  try {
    return session()?.getItem(key) === '1';
  } catch {
    // Unreadable store — claim the attempt is already spent. Failing CLOSED is
    // the safe default: it forgoes an automatic recovery (the player still has
    // the manual button) rather than risking a reload loop we cannot count.
    return true;
  }
}

/**
 * Records the automatic attempt BEFORE it runs, and reports whether that record
 * is DURABLE. Callers must not auto-recover on `false` (Codex P1 on #513).
 *
 * A store can be readable but unwritable — quota exhaustion, storage policy,
 * and some private modes accept `setItem` and silently drop it. In that state a
 * swallowed failure is not a harmless best-effort miss: `attemptSpent()` keeps
 * answering false on every load, so each crash re-arms the automatic reset and
 * the "one attempt per tab" bound becomes an unbounded, destructive reload loop
 * — exactly the failure this guard exists to prevent. Hence the read-back: only
 * a value that survives the write counts as an attempt we can actually count.
 */
export function markAttempt(key: string): boolean {
  try {
    const store = session();
    if (!store) return false;
    store.setItem(key, '1');
    return store.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** True once this tab has spent its single automatic SHELL reset attempt. */
export function resetAttempted(): boolean {
  return attemptSpent(ATTEMPT_KEY);
}

/** Records the shell reset attempt; see `markAttempt` for the durability contract. */
export function markResetAttempted(): boolean {
  return markAttempt(ATTEMPT_KEY);
}

/**
 * True only when the browser is DEFINITELY offline. `navigator.onLine === true`
 * is famously weak (it means "a link exists", not "the internet is reachable"),
 * but a `false` is trustworthy, and one-directional trust is all this needs.
 *
 * Note what this is NOT sufficient for: `!definitelyOffline()` is not permission
 * to destroy the shell — see `originReachable` (Phase 4b P1 on #513).
 */
export function definitelyOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

/**
 * POSITIVE proof that a replacement shell can actually be fetched — the only
 * thing that licenses the destructive teardown (Phase 4b P1 on #513).
 *
 * The earlier `!definitelyOffline()` gate was too weak, and on this app's own
 * primary surface: congested venue Wi-Fi and captive portals leave
 * `navigator.onLine` TRUE while the origin is unreachable. In that state the
 * boundary would delete the only precached shell and reload into a browser
 * error page — precisely the stranding this module exists to prevent,
 * re-created by the fix for it.
 *
 * This is a HEADLINE capability, not a cruise footnote (#608). Signal at a
 * crowded event is blocked by network congestion from high user density and by
 * physical barriers — thick concrete, structural steel — and a conference hall
 * or a wedding venue behind both drops signal more reliably than a ship does. A
 * few hundred phones on one cell behind a captive portal IS the case below;
 * "ship Wi-Fi" was only ever the first place this app met it.
 *
 * So we ask the origin directly. `/build-floor.json` is the natural probe: it is
 * tiny, deliberately un-precached (the workbox glob excludes `.json`), and
 * served `no-cache`, so a real 200 proves the ORIGIN answered, not a cache.
 *
 * A bare `res.ok` is NOT enough (Phase 4b P1 on #513): `fetch` follows
 * redirects by default, so a captive portal that bounces this request to its
 * own login page and returns a readable 2xx would have passed — licensing the
 * teardown in the single state it was written to refuse. Three independent
 * barriers now have to hold, because a portal only has to defeat one:
 *   1. `redirect: 'error'` — a portal bounce rejects instead of resolving;
 *   2. the FINAL response URL must still be same-origin, for interceptors that
 *      proxy in place rather than redirect;
 *   3. the body must actually parse as the build-floor document, which no
 *      login page will.
 * Any failure at all — offline, DNS, timeout, interception — reads as "do not
 * destroy anything".
 */
export async function originReachable(fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<boolean> {
  if (definitelyOffline()) return false;
  const { signal, cleanup } = probeTimeoutSignal(timeoutMs);
  try {
    const res = await fetchImpl(`/build-floor.json?ts=${Date.now()}`, {
      cache: 'no-store',
      signal,
      redirect: 'error',
    });
    if (!res.ok) return false;
    if (res.redirected) return false;
    if (res.url && typeof location !== 'undefined' && new URL(res.url, location.href).origin !== location.origin) {
      return false;
    }
    const body: unknown = await res.json();
    return typeof (body as { floor?: unknown } | null)?.floor === 'string';
  } catch {
    return false;
  } finally {
    cleanup();
  }
}

/**
 * Tear down the cached shell: unregister every service worker and delete the
 * workbox PRECACHE. Deliberately leaves the `proof-media` runtime cache alone
 * (src/data/proofMediaCache.ts) — those are immutable Storage objects, are
 * expensive to refetch mid-cruise, and are not what "the shell is broken" means.
 * Never throws; a partial teardown still helps, since the reload that follows
 * re-fetches `index.html` (served `no-cache`, firebase.json) uncontrolled.
 */
export async function clearShell(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister().catch(() => false)));
    }
  } catch {
    /* SW API unavailable or blocked — fall through to the cache sweep */
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith(PRECACHE_PREFIX)).map((k) => caches.delete(k).catch(() => false)),
      );
    }
  } catch {
    /* CacheStorage unavailable or blocked — the reload below is still worth doing */
  }
}

/**
 * Full recovery: drop the shell, then reload onto whatever the server is
 * serving now. `reload()` is injected so tests can assert the sequence without
 * a jsdom navigation.
 *
 * THE TEARDOWN REQUIRES POSITIVE PROOF that the origin is reachable (Codex P1
 * and Phase 4b P1 on #513). The precache is the only copy of `index.html` and
 * the bundle a disconnected device has; deleting it without a replacement in
 * reach does not recover anything — it lands the player on the browser's
 * offline error page and the installed PWA cannot open again until
 * connectivity returns. Reloading onto the SAME cached shell is the strictly
 * better move: worst case the crash recurs and the boundary's panel comes back,
 * which keeps a retry path alive instead of destroying it.
 *
 * There is deliberately NO "connectivity already proven" bypass. An earlier
 * revision let `enforceBuildFloor` skip the probe on the grounds that its floor
 * fetch had just reached this origin — but `fetchBuildFloor` applies none of
 * the barriers above, so a portal returning parseable floor JSON re-opened the
 * whole hole through the side door (Phase 4b P1 on #513). One caller, one probe,
 * one set of guarantees: the duplicate request costs ~100 bytes at most once per
 * tab, and only on a path that is about to delete the app's own shell.
 */
export async function resetShell(reload: () => void = () => window.location.reload()): Promise<void> {
  if (await originReachable()) await clearShell();
  try {
    reload();
  } catch {
    // `clearShell` cannot throw but `reload` can — no `window` under SSR/tests,
    // and a blocked navigation throws. Every caller uses `void resetShell()`,
    // so an escaping throw would become an unhandled rejection rather than the
    // contained no-op this module promises (CodeRabbit on #513). The teardown
    // above still stands, so the next navigation lands on a fresh shell anyway.
  }
}

/**
 * The out-of-tree half of the #342 remote force-reload floor.
 *
 * `UpdatePrompt` still owns the FRIENDLY path — a waiting worker, a banner, a
 * player-chosen reload. This is the path for when there is no friendly path
 * left: it runs from `main.tsx` module scope, so it fires even when the React
 * tree never mounts, and it recovers by tearing the shell down directly rather
 * than by asking a waiting service worker to activate (the stranded client's
 * SW is waiting precisely because nothing is alive to tell it to activate).
 *
 * Bounded by the same one-attempt-per-tab guard as the ErrorBoundary's auto
 * recovery, so a floor set newer than every build can never reload-loop.
 */
export async function enforceBuildFloor(
  buildStamp: string,
  reload: () => void = () => window.location.reload(),
): Promise<boolean> {
  if (resetAttempted() || definitelyOffline()) return false;
  const floor = await fetchBuildFloor();
  if (!buildBelowFloor(buildStamp, floor)) return false;
  // Re-check across the await (CodeRabbit on #513). This starts at module scope,
  // so a render crash can spend the attempt from `ErrorBoundary.componentDidCatch`
  // while the floor fetch is still in flight; without this the same page load
  // would tear down and reload twice. The one-attempt latch already bounds it —
  // this makes the second, redundant teardown not happen at all.
  if (resetAttempted()) return false;
  // Only proceed once the attempt is DURABLY recorded — an uncountable attempt
  // is an unbounded reload loop (Codex P1 on #513). The floor stays armed for
  // the next load, so this defers the rescue rather than cancelling it.
  if (!markResetAttempted()) return false;
  // `resetShell` runs its own hardened probe — a successful floor fetch is NOT
  // accepted as proof of reachability, because `fetchBuildFloor` carries none
  // of the redirect/same-origin/payload barriers (Phase 4b P1 on #513).
  await resetShell(reload);
  return true;
}
