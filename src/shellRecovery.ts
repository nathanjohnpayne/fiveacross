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

/** True once this tab has spent its single automatic reset attempt. */
export function resetAttempted(): boolean {
  try {
    return session()?.getItem(ATTEMPT_KEY) === '1';
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
 * swallowed failure is not a harmless best-effort miss: `resetAttempted()` keeps
 * answering false on every load, so each crash re-arms the automatic reset and
 * the "one attempt per tab" bound becomes an unbounded, destructive reload loop
 * — exactly the failure this guard exists to prevent. Hence the read-back: only
 * a value that survives the write counts as an attempt we can actually count.
 */
export function markResetAttempted(): boolean {
  try {
    const store = session();
    if (!store) return false;
    store.setItem(ATTEMPT_KEY, '1');
    return store.getItem(ATTEMPT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * True only when the browser is DEFINITELY offline. `navigator.onLine === true`
 * is famously weak (it means "a link exists", not "the internet is reachable"),
 * but a `false` is trustworthy, and one-directional trust is all this needs.
 */
export function definitelyOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
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
 * OFFLINE IS A HARD SKIP on the teardown (Codex P1 on #513). The precache is
 * the only copy of `index.html` and the bundle a disconnected device has; on a
 * ship, deleting it and reloading does not recover anything — it lands the
 * player on the browser's offline error page and the installed PWA cannot open
 * again until connectivity returns. Reloading onto the SAME cached shell is the
 * strictly better move: worst case the crash simply recurs and the boundary's
 * panel comes back, which keeps a retry path alive instead of destroying it.
 */
export async function resetShell(reload: () => void = () => window.location.reload()): Promise<void> {
  if (!definitelyOffline()) await clearShell();
  reload();
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
  // Only proceed once the attempt is DURABLY recorded — an uncountable attempt
  // is an unbounded reload loop (Codex P1 on #513). The floor stays armed for
  // the next load, so this defers the rescue rather than cancelling it.
  if (!markResetAttempted()) return false;
  await resetShell(reload);
  return true;
}
