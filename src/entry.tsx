/**
 * The application entry point (#549, Phase 4b P1).
 *
 * Deliberately tiny, and deliberately the ONLY thing `index.html` loads. Its
 * whole job is to get bearer credentials out of the URL before anything
 * capable of reading a URL exists.
 *
 * The import list below is the security property. ES modules evaluate their
 * static imports before their own body, so any static import of the app here
 * would load `firebase.ts` — and with it GA4 — while a credential was still in
 * `window.location`. The boot seam and its dependencies are free of Firebase,
 * analytics, and React precisely so this file can run first with nothing else
 * awake.
 *
 * The application is therefore reached through a DYNAMIC import, which is
 * evaluated only when this line runs — after the capture. Do not convert it to
 * a static import, and do not add a static import of anything from `src/` other
 * than the boot seam: either would reintroduce the leak this file exists to
 * close.
 */
import {
  captureUrlCredentialsFromUrl,
  pendingHandoffCode,
  renderBootstrapFailure,
  runApplicationBootstrap,
} from './handoffBoot';

captureUrlCredentialsFromUrl();

/**
 * A rejection here is unrecoverable for THIS page load and has to say so
 * (Phase 4b P2). By the time this runs the code has already left the URL and
 * exists only in this module's memory, so if the main chunk fails to download
 * or evaluate, a reload cannot get it back — the player would otherwise sit on
 * the static loading screen forever with no hint that anything went wrong.
 *
 * The message is written with raw DOM rather than React, because React lives in
 * the chunk that just failed to load. It is deliberately the only thing this
 * file knows how to render.
 */
void runApplicationBootstrap({
  code: pendingHandoffCode(),
  completeHandoff: async (code) => {
    const { completeHandoffReturn } = await import('./auth/handoffReturn');
    return completeHandoffReturn({ code, origin: window.location.origin });
  },
  loadMain: () => import('./main'),
  // The return module may already have touched primary Auth. The boot seam
  // therefore maps any unexpected return failure to recovery, never app mount.
  renderFailure: renderBootstrapFailure,
});
