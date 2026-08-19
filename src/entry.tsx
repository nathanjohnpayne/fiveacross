/**
 * The application entry point (#549, Phase 4b P1).
 *
 * Deliberately tiny, and deliberately the ONLY thing `index.html` loads. Its
 * whole job is to get the handoff code out of the URL before anything capable
 * of reading a URL exists.
 *
 * The import list below is the security property. ES modules evaluate their
 * static imports before their own body, so any static import of the app here
 * would load `firebase.ts` — and with it GA4 — while `#fa_handoff=<code>` was
 * still in `window.location`. `handoffBoot` and its one dependency are free of
 * Firebase, analytics, and React precisely so that this file can run first with
 * nothing else awake.
 *
 * The application is therefore reached through a DYNAMIC import, which is
 * evaluated only when this line runs — after the capture. Do not convert it to
 * a static import, and do not add a static import of anything from `src/` other
 * than the boot seam: either would reintroduce the leak this file exists to
 * close.
 */
import { captureHandoffFromUrl } from './handoffBoot';

captureHandoffFromUrl();

void import('./main');
