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

/**
 * The container, or undefined where there is none — INCLUDING where merely
 * asking is an error (Codex P2 round 3).
 *
 * `navigator.serviceWorker` is not always a plain absent property: in a
 * sandboxed iframe and in a few privacy modes the getter itself throws a
 * `SecurityError`. This function is the DEFAULT ARGUMENT of both exports, so it
 * runs before either of them reaches its own `try` — and `main.tsx` calls
 * `postClientBuild()` synchronously at module scope, so an exception escaping
 * here would abort application startup rather than degrade to the no-op this
 * file promises. Catching at the access is the only place that covers every
 * caller, present and future.
 */
function swContainer(): ServiceWorkerContainer | undefined {
  try {
    return typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tells the worker in charge which build this window is running (#516) — the
 * evidence `shouldForceActivate` needs to tell the shell being SERVED apart
 * from what each open tab is EXECUTING (`src/sw-rescue.ts` explains why those
 * differ, and what the rescue gets wrong without it).
 *
 * THREE DELIVERY ATTEMPTS, because an unregistered window is a CONDEMNED one
 * and the page only gets to be wrong about that once (Codex P2 round 4).
 * `shouldForceActivate` reads a live client id with no registry entry as
 * `UNKNOWN_ACTIVE_STAMP` — deliberately, since that absence is the only way the
 * rollout case can see a pre-#516 tab — so a page that runs this module and
 * still fails to land its record is force-activated and navigated exactly as if
 * it were stranded.
 *
 *  - THE CONTROLLER, when there is one. The ordinary case.
 *  - `controllerchange`, for a page that had none yet.
 *  - `registration.active`, for a page that will never have one. An
 *    UNCONTROLLED page is not a transient state waiting for `controllerchange`:
 *    this worker does not call `clientsClaim()` (src/sw.ts), so a first-ever
 *    visit — and every load of the uptime synthetic, which runs in a fresh
 *    browser profile — stays uncontrolled for its entire life and would never
 *    register at all. `ServiceWorker.postMessage` works from an uncontrolled
 *    window and the worker still sees a `Client` as `event.source`, so the
 *    record lands and it lands under the same client id.
 *
 * All three carry the same payload for the same window, and the worker's write
 * is a single keyed `put` (`src/sw-rescue.ts`), so a duplicate delivery is
 * idempotent rather than a second registration.
 */
export function postClientBuild(stamp: string, container = swContainer()): void {
  try {
    if (!container) return;
    const message = { type: CLIENT_BUILD_MESSAGE, stamp };
    // `send` is isolated in its own `try` (post-review #757): a controller
    // that became redundant between the read and the call throws on
    // `postMessage`, and that throw must not skip registering the other two
    // delivery paths below, or a rare failure here permanently strands this
    // window unregistered.
    const send = () => {
      try {
        container.controller?.postMessage(message);
      } catch {
        /* the controller became redundant; the other two paths still fire */
      }
    };
    try {
      send();
    } finally {
      container.addEventListener('controllerchange', send);
    }
    // Fire-and-forget, and swallowed: this runs at module scope in `main.tsx`,
    // where an unhandled rejection is a console error on every load of a
    // browser that has no worker to become ready.
    void Promise.resolve(container.ready)
      .then((registration) => registration?.active?.postMessage(message))
      .catch(() => {});
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
 * The opt-in marker any surface uses to say "I am holding work that lives
 * nowhere but React state" (Codex P2 round 4).
 *
 * `role="dialog" aria-modal="true"` is a statement about the SCREEN, not about
 * what would be lost, and the two keep coming apart: the claim sheet is
 * destructive and carries neither attribute, while the bug-report flow is
 * destructive for its whole life but only carries them during its dialog phase.
 * Rather than teach this module a third bespoke description of a specific
 * component — a fourth, a fifth — the surfaces declare it themselves and this
 * module asks one question. A new sheet with an unsaved draft joins by adding
 * the attribute; nothing here has to learn its name.
 */
export const UNSAVED_WORK_ATTRIBUTE = 'data-unsaved-work';

/**
 * Whether reloading right now would yank the player out of something, and
 * specifically whether it would DESTROY something (Codex P1 on #621).
 *
 * Three signals, in two tiers. The first two are DESTRUCTIVE and are checked
 * ahead of the visibility gate; the third is merely rude and is not.
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
 *  - ANY SURFACE CARRYING `UNSAVED_WORK_ATTRIBUTE`, likewise ahead of the
 *    visibility gate and for the same reason: a destroyed draft is destroyed
 *    whether or not the player was looking at the tab. `BugReportProvider`
 *    marks its whole flow, dialog phase AND pick phase — the phase where the
 *    reporter is explicitly invited to go navigate the app, and the phase whose
 *    container is a `role="group"` the generic query below cannot see. Matching
 *    only the dialog turned "Capture a different screen" into a reload that ate
 *    the description and the screenshot the reporter had already taken.
 *  - ANY OTHER MODAL SHEET holding the screen of a VISIBLE tab. Those carry
 *    `role="dialog" aria-modal="true"` and hold no unsaved capture, so
 *    interrupting one is rude rather than destructive; a hidden tab is nobody's
 *    foreground, so it is not mid-interaction at all.
 */
function midInteraction(): boolean {
  if (isClaimSheetOpen()) return true;
  if (typeof document === 'undefined') return false;
  if (document.querySelector(`[${UNSAVED_WORK_ATTRIBUTE}]`) !== null) return true;
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
 * Waits for the interaction to actually END, watching every signal that could
 * end one. There is exactly ONE activation event to spend, so a deferral that
 * misses its cue does not merely delay the reload — it loses it, and the tab
 * stays on the old build for the rest of its life.
 *
 * Three signals, because each of the three things `midInteraction` consults
 * ends in its own way:
 *
 *  - VISIBILITY, for a backgrounded tab coming forward;
 *  - THE CLAIM SHEET, which is a module singleton with its own subscription and
 *    touches no DOM this module can watch. Visibility alone is not enough now
 *    that the claim sheet defers a hidden tab too — a player who backgrounds
 *    the app to take the photo and comes back to finish the claim would get one
 *    `visibilitychange`, still be mid-capture, and then wait for another that
 *    may never come;
 *  - THE DOM, for every surface `midInteraction` finds by query — the generic
 *    `role="dialog"` sheets (Codex P2 round 3) and anything carrying
 *    `UNSAVED_WORK_ATTRIBUTE`. The profile, reshuffle, and More sheets close by
 *    unmounting, as does the bug-report flow, which fires neither of the other
 *    two, so a player who opened one while a deploy landed was stranded until
 *    some later visibility change that may never come. Watching the tree is
 *    what closes that class rather than enumerating the sheets one by one: any
 *    surface `midInteraction` can see, this can see leave.
 *
 * The listeners persist and simply re-ask until nothing is in the way, so a
 * signal that fires mid-interaction costs nothing and none of them can stack.
 */
function deferReload(reload: () => void): void {
  const doc = typeof document !== 'undefined' ? document : null;
  const cleanups: Array<() => void> = [];
  let settled = false;
  const recheck = () => {
    if (settled || midInteraction()) return;
    settled = true;
    cleanups.forEach((fn) => fn());
    requestReload(reload);
  };
  doc?.addEventListener('visibilitychange', recheck);
  cleanups.push(() => doc?.removeEventListener('visibilitychange', recheck));
  cleanups.push(subscribeClaimSheetOpen(recheck));
  const root = doc?.body ?? doc?.documentElement;
  if (root && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(recheck);
    // Narrow on purpose: a surface leaves `midInteraction`'s queries either by
    // being removed from the tree or by dropping one of the attributes they
    // match on, and nothing else about the page needs watching.
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'aria-modal', UNSAVED_WORK_ATTRIBUTE],
    });
    cleanups.push(() => observer.disconnect());
  }
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
 * So this watches the REGISTRATION rather than the controller: a worker
 * reaching `activated` is a deploy landing underneath us. Whether THIS page is
 * behind that deploy is a separate question, and it is always asked — see
 * `reloadUnlessPageIsCurrent`.
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
    const watched = new WeakSet<object>();
    const watch = (worker: ServiceWorker | null | undefined) => {
      if (!worker || watched.has(worker)) return;
      watched.add(worker);
      // Read NOW, while the outgoing worker is still the active one: a worker
      // taking over from another IS a deploy landing underneath this page. That
      // says a deploy HAPPENED; it does not say this page is behind it.
      const replacesAnActiveWorker = registration.active !== null && registration.active !== worker;
      worker.addEventListener('statechange', () => {
        if (worker.state !== 'activated') return;
        void reloadUnlessPageIsCurrent(worker, pageStamp, askStamp, reload, replacesAnActiveWorker);
      });
    };
    // ATTACHED BEFORE THE STAMP QUERY BELOW, and that ordering is the point
    // (Codex P2 round 3). That query is a `postMessage` round trip with a
    // timeout, so it can be pending for seconds; a deploy activating inside
    // that window would dispatch `updatefound` to nobody, the old worker would
    // answer with the page's own stamp, and the tab would sit on the dead build
    // for the rest of its life. There is only ever one activation to catch.
    registration.addEventListener('updatefound', () => watch(registration.installing));
    // An update ALREADY in flight when the registration resolved never
    // dispatches `updatefound` to a listener attached now: `container.ready`
    // waits for an ACTIVE worker, which says nothing about whether a
    // replacement started installing first. Pick those up by hand — `watch`
    // dedupes, so a worker that also arrives via the event is only watched once.
    watch(registration.installing);
    watch(registration.waiting);
    // The worker that got here before any of the above could be attached.
    await reloadUnlessPageIsCurrent(registration.active, pageStamp, askStamp, reload, false);
  } catch {
    /* no service worker, or a registration that never becomes ready */
  }
}

/**
 * Reloads only when the worker now in charge is serving a build STRICTLY NEWER
 * than the one this page is executing.
 *
 * ASKED ON EVERY PATH, including the one where a deploy plainly landed (Codex P2
 * round 5). "A worker replaced another" proves an activation happened; it says
 * nothing about which build THIS page loaded, and the two come apart in the
 * exact case the rescue is built for. A forced activation (`src/sw-rescue.ts`)
 * is triggered by the OLDEST open window, so a tab that opened moments earlier
 * on the incoming build is uncontrolled — this worker never calls
 * `clientsClaim()` — watches that worker activate, and used to reload itself
 * unconditionally. The worker had already excluded it by name:
 * `shouldNavigateClient` filters the navigation targets to the clients actually
 * below the floor, precisely so an up-to-date tab keeps its in-progress work.
 * Reloading from the page side reintroduced the harm the worker side had just
 * gone to the trouble of avoiding.
 *
 * Strictly newer, not merely different, because the reload is served by that
 * worker's precache: reloading onto an OLDER worker would walk the player
 * backwards, which is the opposite of the repair. `buildBelowFloor` is the
 * repo's existing "is this stamp older than that one" comparator, fail-open on
 * anything that does not parse (src/buildFloor.ts).
 *
 * `deployIsCertain` decides only what SILENCE means, and it is the one thing the
 * "a worker replaced another" observation is genuinely evidence for. An
 * unanswerable worker — a dropped port, a worker killed mid-question — is not
 * evidence of a mismatch on a FIRST worker, where a needless reload throws away
 * whatever the player did while the initial precache was installing, sign-in
 * included; but where a replacement demonstrably took over, a page that cannot
 * confirm it is current is more likely stale than not, and staying stale for the
 * rest of its life is the bug #621 exists to fix. A stamp that IS named settles
 * it either way, so this only decides the unanswerable case.
 */
async function reloadUnlessPageIsCurrent(
  worker: Pick<ServiceWorker, 'postMessage'> | null,
  pageStamp: string,
  askStamp: (worker: Pick<ServiceWorker, 'postMessage'> | null) => Promise<string | null>,
  reload: () => void,
  deployIsCertain: boolean,
): Promise<void> {
  if (!worker) return;
  const workerStamp = await askStamp(worker);
  if (workerStamp === null) {
    if (deployIsCertain) requestReload(reload);
    return;
  }
  if (!buildBelowFloor(pageStamp, workerStamp)) return;
  requestReload(reload);
}
