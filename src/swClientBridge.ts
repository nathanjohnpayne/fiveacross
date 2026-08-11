// The page half of two service-worker contracts (#516, #621), kept out of
// `src/main.tsx` for the same reason `src/updateDismissal.ts` is: main.tsx is a
// side-effecting entrypoint that mounts React, so nothing declared inside it
// can be unit-tested. Both functions are called from main.tsx at MODULE SCOPE,
// before any rendering — a page that crashes on mount must still have named
// itself, and must still be able to notice a deploy.
//
// Every navigator/document touch is guarded the way `src/shellRecovery.ts`
// guards its own: these APIs are absent under jsdom and in a few privacy modes,
// and neither of these behaviours is worth throwing out of module scope for.

/** Message a page posts to name the build it is EXECUTING (#516). Spelled out
 *  again in `src/sw.ts`, which cannot import it: the worker is a separate
 *  typecheck program (`tsconfig.sw.json`, `WebWorker` lib, no DOM) and pulling
 *  this module in would drag DOM-only globals into it. `sw-worker.test.ts`
 *  pins the name from the worker side. */
export const CLIENT_BUILD_MESSAGE = 'CLIENT_BUILD';

function swContainer(): ServiceWorkerContainer | undefined {
  return typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
}

/**
 * Tells the controlling worker which build this window is running (#516) — the
 * evidence `shouldForceActivate` needs to tell the shell being SERVED apart
 * from what each open tab is EXECUTING (`src/sw-rescue.ts` explains why those
 * differ, and what the rescue gets wrong without it).
 *
 * Re-posted on `controllerchange` because an uncontrolled page has nothing to
 * post to: it registers itself the moment a worker takes over.
 */
export function postClientBuild(stamp: string, container = swContainer()): void {
  try {
    if (!container) return;
    const send = () => container.controller?.postMessage({ type: CLIENT_BUILD_MESSAGE, stamp });
    send();
    container.addEventListener('controllerchange', send);
  } catch {
    /* no service worker here — nothing to register with */
  }
}

/** At most one automatic reload per page lifetime. `location.reload()` is not
 *  instantaneous — the page keeps running until the new document commits — and
 *  the deferred path below can be re-entered from a later `visibilitychange`. */
let reloadRequested = false;

/** Test-only: module state does not reset between `it`s in one file. */
export function __resetUpdateReloadForTests(): void {
  reloadRequested = false;
}

/** Whether reloading right now would yank the player out of something. A modal
 *  sheet holding the screen of a VISIBLE tab is the one signal available from
 *  module scope — every sheet in `src/components/**` carries
 *  `role="dialog" aria-modal="true"`. A hidden tab is nobody's foreground, so
 *  it is never mid-interaction. */
function midInteraction(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

function requestReload(reload: () => void): void {
  if (reloadRequested) return;
  if (midInteraction()) {
    // Re-ask the next time the tab's visibility changes. Deferring indefinitely
    // is still strictly better than #621's status quo, which is never.
    document.addEventListener('visibilitychange', () => requestReload(reload), { once: true });
    return;
  }
  reloadRequested = true;
  reload();
}

/**
 * The second reload trigger #621 asks for.
 *
 * `vite-plugin-pwa`'s `registerSW` reloads on `controlling` only when
 * `event.isUpdate`, and workbox-window fixes that flag at REGISTER time from
 * `Boolean(navigator.serviceWorker.controller)`. A page that was uncontrolled
 * when it registered — a first-ever visit, or the load right after
 * `shellRecovery.clearShell()` — therefore has `isUpdate: false` for its whole
 * life. Worse, an uncontrolled page controls nothing, so a worker installed
 * after a deploy does not even stop in `waiting`: it activates straight away,
 * swaps the precache, and leaves this tab executing the previous build with no
 * banner and no reload. That tab stays stale until someone reloads by hand.
 *
 * So this watches the REGISTRATION rather than the controller: a worker that
 * reaches `activated` while another one was already `active` is a deploy taking
 * over underneath us, and the page it is running is now the old one.
 *
 * Deliberately armed ONLY on an uncontrolled page. A controlled page has a live
 * `isUpdate: true`, so vite-plugin-pwa reloads it already and arming here too
 * would reload twice.
 */
export async function armUncontrolledUpdateReload(
  container = swContainer(),
  reload: () => void = () => location.reload(),
): Promise<void> {
  try {
    if (!container || container.controller) return;
    const registration = await container.ready;
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      // No existing active worker means this IS the first one — the page is
      // already running the build it is about to precache, and reloading would
      // discard whatever the player did while that precache was installing.
      if (!installing || !registration.active) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'activated') requestReload(reload);
      });
    });
  } catch {
    /* no service worker, or a registration that never becomes ready */
  }
}
