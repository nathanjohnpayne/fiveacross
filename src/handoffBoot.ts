/**
 * The handoff code captured before ANY of the app's module graph was loaded
 * (#549, Phase 4b P1).
 *
 * WHY THIS MODULE EXISTS AT ALL. Clearing the fragment at the top of
 * `main.tsx`'s module BODY is not early enough, and the reason is ES module
 * semantics rather than anything about this app: a module's static imports are
 * fully evaluated before its own body runs. `main.tsx` transitively imports
 * `firebase.ts`, which initialises GA4 at import time — so by the time any
 * statement in `main.tsx` executed, an analytics SDK was already live on a page
 * whose URL still read `#fa_handoff=<code>`. Line order inside the module could
 * never have fixed that.
 *
 * So the capture happens in `entry.tsx`, which imports only this module and
 * `handoffClient` — both deliberately free of any Firebase, analytics or React
 * import — and only then dynamically imports the application. That import
 * boundary is the guarantee: nothing that could observe a URL is loaded until
 * the code is out of it.
 *
 * This module holds no logic on purpose. It is the seam the two halves share,
 * and keeping it inert is what lets `entry.tsx` stay provably free of side
 * effects that could reach `window.location`.
 */
import { clearHandoffFragment, readHandoffCode } from './auth/handoffClient';

let capturedCode: string | null = null;
let urlSafeForTelemetry = true;
let captured = false;

/**
 * Read the handoff code out of the fragment and clear it. Call EXACTLY once,
 * from `entry.tsx`, before the application is imported.
 *
 * Idempotent because a double call would read an already-cleared URL and
 * overwrite a real capture with `null` — turning a working sign-in into
 * `transaction-missing` for no reason.
 */
export function captureHandoffFromUrl(): void {
  if (captured) return;
  captured = true;
  capturedCode = readHandoffCode(window.location.hash);
  // A clear that throws, is refused, or is accepted and silently no-ops leaves
  // a LIVE code in `window.location`. Whether it actually went is what decides
  // if telemetry may read the URL at all, so it is confirmed, not assumed.
  urlSafeForTelemetry = capturedCode === null || clearHandoffFragment();
}

/** The code this page load arrived with, or `null`. */
export function pendingHandoffCode(): string | null {
  return capturedCode;
}

/**
 * Whether the URL is safe for analytics to observe.
 *
 * `false` only in the narrow case where the fragment could not be removed. The
 * app still boots and sign-in still completes; analytics are suppressed for
 * that one page load, because one lost page view on a handoff return is not
 * comparable to exporting a single-use bearer credential to a telemetry
 * pipeline.
 */
export function isUrlSafeForTelemetry(): boolean {
  return urlSafeForTelemetry;
}
