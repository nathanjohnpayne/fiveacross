// The post-update deal grace (#519): ONE silent re-deal after a service-worker
// update reload, before the deal error is allowed to surface.
//
// THE BUG THIS EXISTS FOR. `updateServiceWorker(true)` — the update banner's
// Reload, and the #342 build-floor force (src/components/UpdatePrompt.tsx) —
// reloads the page the instant the new worker takes control. The reload lands on
// a brand-new document whose Firebase auth token and Firestore connection are
// still coming up, so the first `joinAndDeal` can fail transiently and hand the
// player the full-screen "check your connection" surface. That is the worst
// possible moment for it: they were just told a fresh build docked and that
// reloading takes two seconds. Tapping Retry succeeds on the spot, which is what
// marks this as a startup race rather than a real connectivity problem (observed
// twice during post-deploy verification on 2026-08-01).
//
// WHY THE ARMING HAS TO CROSS A RELOAD. `controllerchange` IS the update taking
// effect, but it fires in the OUTGOING document — workbox reloads on the same
// event — while the deal that fails runs in the INCOMING one. Module memory does
// not survive that, so the arming is mirrored into sessionStorage and read back
// (and cleared) by the next document. The in-document arming is kept as well, for
// a controller change that does not reload the page.
//
// HONEST LIMIT. A `controllerchange` that never leads to a reload leaves the
// marker behind for the next navigation, which then also starts armed. The cost
// is bounded at one extra silent re-deal on one later load — the same single
// retry a player would have tapped — so the marker is deliberately not given a
// timestamp or any other expiry it would have to be trusted to honour.
//
// Every storage and service-worker touch is guarded the way `src/shellRecovery.ts`
// guards its own: these APIs throw in some privacy modes and are absent under SSR
// and in unit tests, and a recovery path that can itself throw is not a recovery
// path — every failure here degrades to "no grace", never to a new crash.

/** sessionStorage slot marking that a service worker took control just before
 *  this document loaded. Session-scoped, like `gcb:shell-reset-attempted`: a new
 *  tab starts clean rather than inheriting another tab's update. */
const RELOAD_MARKER_KEY = 'gcb:post-update-reload';

function session(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function serviceWorkerContainer(): ServiceWorkerContainer | null {
  try {
    return typeof navigator !== 'undefined' ? (navigator.serviceWorker ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Whether one silent re-deal is still available. Module state, armed only by
 * `watchPostUpdateReload`, and never re-armed from storage once consumed — the
 * grace is one re-deal per document, so it can never turn into a retry loop.
 */
let graceArmed = false;

/** Records the arming so it survives the reload workbox performs on the same
 *  event. An unwritable store costs only the cross-reload half: the in-document
 *  arming below still stands. */
function rememberReload(): void {
  try {
    session()?.setItem(RELOAD_MARKER_KEY, '1');
  } catch {
    /* storage blocked — no cross-reload arming, which is a lost grace, not a bug */
  }
}

/** Reads AND clears the marker: it describes the load that just happened, so
 *  leaving it in place would arm every subsequent load in the session too. */
function takeRememberedReload(): boolean {
  try {
    const store = session();
    if (store?.getItem(RELOAD_MARKER_KEY) !== '1') return false;
    store.removeItem(RELOAD_MARKER_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Arms the grace for this document if a service worker took control just before
 * it loaded, and keeps watching for a controller change during its life. Returns
 * the unsubscribe, so it can be used directly as a `useEffect` body.
 *
 * Arming is one-way — it never disarms — so a double-invoked effect (StrictMode,
 * a remount) cannot silently cancel a grace the first invocation just claimed
 * from storage.
 */
export function watchPostUpdateReload(): () => void {
  if (takeRememberedReload()) graceArmed = true;
  const container = serviceWorkerContainer();
  if (!container?.addEventListener) return () => {};
  const onControllerChange = () => {
    rememberReload();
    graceArmed = true;
  };
  container.addEventListener('controllerchange', onControllerChange);
  return () => container.removeEventListener('controllerchange', onControllerChange);
}

/**
 * Claims the grace, if one is armed. Consuming it is what bounds the mechanism:
 * the first taker gets the silent re-deal and every later failure in this
 * document surfaces normally.
 */
export function consumePostUpdateDealGrace(): boolean {
  if (!graceArmed) return false;
  graceArmed = false;
  return true;
}

/** Test-only reset of the module-level arming, which otherwise outlives a
 *  single test's render tree (the same reason `sessionStorage` is cleared
 *  between tests in `src/test/setup.ts`). */
export function resetPostUpdateDealGraceForTest(): void {
  graceArmed = false;
}
