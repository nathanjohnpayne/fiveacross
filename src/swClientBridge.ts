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

import { buildBelowFloor } from './buildFloor';
import { isClaimSheetOpen, subscribeClaimSheetOpen } from './hooks/useToastStack';
import { askWorkerBuildStamp } from './updateDismissal';

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
 *  the deferred path below can be re-entered whenever an interaction ends, as
 *  can the stamp comparison, which resolves on its own schedule. */
let reloadRequested = false;

/** Test-only: module state does not reset between `it`s in one file. */
export function __resetUpdateReloadForTests(): void {
  reloadRequested = false;
}

/**
 * Whether reloading right now would yank the player out of something, and
 * specifically whether it would DESTROY something (Codex P1 on #621).
 *
 * Two signals, because neither covers the other:
 *
 *  - THE CLAIM SHEET, consulted first and deliberately NOT behind the
 *    visibility gate. `ProofSheet` holds a selected photo, a recorded audio
 *    clip, or typed callout text in React state and nowhere else until the
 *    player submits, so an automatic reload does not merely interrupt — it
 *    discards work the player cannot get back. That sheet also renders as
 *    `.sheet.claim-sheet` with no `role="dialog" aria-modal="true"`, so the
 *    generic query below never saw it; asking `isClaimSheetOpen()` uses the
 *    signal `UpdatePrompt` already defers on (`src/hooks/useToastStack.ts`)
 *    rather than a second, drifting description of the same thing. The
 *    visibility gate is skipped because backgrounding the tab is part of
 *    capturing the proof — the camera or the file picker takes the foreground —
 *    and that in-flight capture is exactly what must not be thrown away.
 *  - ANY OTHER MODAL SHEET holding the screen of a VISIBLE tab. Those carry
 *    `role="dialog" aria-modal="true"` and hold no unsaved capture, so
 *    interrupting one is rude rather than destructive; a hidden tab is nobody's
 *    foreground, so it is not mid-interaction at all.
 */
function midInteraction(): boolean {
  if (isClaimSheetOpen()) return true;
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

function requestReload(reload: () => void): void {
  if (reloadRequested) return;
  if (midInteraction()) {
    deferReload(reload);
    return;
  }
  reloadRequested = true;
  reload();
}

/**
 * Re-asks on the next thing that could plausibly have ENDED the interaction:
 * the tab's visibility changing, or the claim sheet closing. Visibility alone
 * is not enough now that the claim sheet defers a hidden tab too — a player who
 * backgrounds the app to take the photo and comes back to finish the claim
 * would otherwise get one `visibilitychange`, still be mid-capture, and then
 * wait for another that may never come.
 *
 * Both listeners are one-shot and tear each other down, so a deferral that
 * re-defers replaces its listeners rather than stacking them.
 */
function deferReload(reload: () => void): void {
  const doc = typeof document !== 'undefined' ? document : null;
  const cleanups: Array<() => void> = [];
  let done = false;
  const retry = () => {
    if (done) return;
    done = true;
    cleanups.forEach((fn) => fn());
    requestReload(reload);
  };
  const onVisibilityChange = () => retry();
  doc?.addEventListener('visibilitychange', onVisibilityChange, { once: true });
  cleanups.push(() => doc?.removeEventListener('visibilitychange', onVisibilityChange));
  cleanups.push(
    subscribeClaimSheetOpen(() => {
      if (!isClaimSheetOpen()) retry();
    }),
  );
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
 *
 * A FIRST worker is not automatically "the build this page is running" (Codex
 * P1 on #621). `UpdatePrompt` does not register until the React tree mounts,
 * and hostname resolution or a slow bundle download leaves room for a deploy to
 * land between this document and the `/sw.js` fetch — so the first worker can
 * be build B while the page executes build A. Whichever way that first worker
 * arrives, the page asks it which build it carries and reloads only on a
 * genuine mismatch. That query is why `container.ready` alone is not the whole
 * story either: `ready` does not resolve until SOME worker is active, so on a
 * first-ever registration the `updatefound` for that worker has already come
 * and gone by the time the listener below attaches, and the stamp comparison is
 * the only thing that can still notice.
 */
export async function armUncontrolledUpdateReload(
  container = swContainer(),
  reload: () => void = () => location.reload(),
  pageStamp: string = __BUILD_STAMP__,
  askStamp: (worker: Pick<ServiceWorker, 'postMessage'> | null) => Promise<string | null> = askWorkerBuildStamp,
): Promise<void> {
  try {
    if (!container || container.controller) return;
    const registration = await container.ready;
    // The worker that got here before the listener could be attached.
    await reloadIfPageIsBehind(registration.active, pageStamp, askStamp, reload);
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      // Read NOW, while the outgoing worker is still the active one: a worker
      // taking over from another IS a deploy landing underneath this page, and
      // needs no stamp query to prove it.
      const replacesAnActiveWorker = registration.active !== null;
      installing.addEventListener('statechange', () => {
        if (installing.state !== 'activated') return;
        if (replacesAnActiveWorker) requestReload(reload);
        else void reloadIfPageIsBehind(installing, pageStamp, askStamp, reload);
      });
    });
  } catch {
    /* no service worker, or a registration that never becomes ready */
  }
}

/**
 * Reloads only when the worker now in charge is serving a build STRICTLY NEWER
 * than the one this page is executing.
 *
 * Strictly newer, not merely different, because the reload is served by that
 * worker's precache: reloading onto an OLDER worker would walk the player
 * backwards, which is the opposite of the repair. `buildBelowFloor` is the
 * repo's existing "is this stamp older than that one" comparator, fail-open on
 * anything that does not parse (src/buildFloor.ts).
 *
 * A null answer changes nothing. An unanswerable worker — a pre-#605 build with
 * no reply handler, a dropped port, a worker killed mid-question — is not
 * evidence of a mismatch, and a needless reload throws away whatever the player
 * did while the first precache was installing, sign-in included.
 */
async function reloadIfPageIsBehind(
  worker: Pick<ServiceWorker, 'postMessage'> | null,
  pageStamp: string,
  askStamp: (worker: Pick<ServiceWorker, 'postMessage'> | null) => Promise<string | null>,
  reload: () => void,
): Promise<void> {
  if (!worker) return;
  const workerStamp = await askStamp(worker);
  if (workerStamp === null || !buildBelowFloor(pageStamp, workerStamp)) return;
  requestReload(reload);
}
