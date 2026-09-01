/**
 * URL credentials captured before ANY of the app's module graph was loaded.
 *
 * WHY THIS MODULE EXISTS AT ALL. Clearing the fragment at the top of
 * `main.tsx`'s module BODY is not early enough, and the reason is ES module
 * semantics rather than anything about this app: a module's static imports are
 * fully evaluated before its own body runs. `main.tsx` transitively imports
 * `firebase.ts`, which initialises GA4 at import time — so by the time any
 * statement in `main.tsx` executed, an analytics SDK was already live on a page
 * whose URL still held a bearer value. Line order inside the module could never
 * have fixed that.
 *
 * So the capture happens in `entry.tsx`, through modules deliberately free of
 * Firebase, analytics and React, and only then dynamically imports the
 * application. That import boundary is the guarantee: nothing that could
 * observe a URL is loaded until the credentials are out of it.
 *
 * Keeping this seam dependency-free is what lets `entry.tsx` capture and clear
 * the credentials while nothing capable of exporting the URL is awake.
 */
import { readHandoffCode } from './auth/handoffClient';
import {
  capturePendingEventInvitation,
  readEventInvitationCode,
} from './pendingEventInvitation';
import { clearUrlFragmentAndConfirm } from './urlFragment';

let capturedCode: string | null = null;
let urlSafeForTelemetry = true;
let captured = false;

/**
 * Capture every supported URL credential and clear the shared fragment. Call
 * EXACTLY once, from `entry.tsx`, before the application is imported.
 *
 * Idempotent because a double call would read an already-cleared URL and
 * overwrite a real capture with `null` — turning a working sign-in into
 * `transaction-missing` for no reason.
 */
export function captureUrlCredentialsFromUrl(): void {
  if (captured) return;
  captured = true;
  const hash = window.location.hash;
  capturedCode = readHandoffCode(hash);
  const invitationCode = readEventInvitationCode(hash);

  // Persist before clearing. The fragment is the only recoverable copy on
  // arrival, while storage is what carries the invitation through sign-in.
  if (invitationCode !== null) {
    capturePendingEventInvitation({
      hash,
      origin: window.location.origin,
      now: Date.now(),
    });
  }

  // A clear that throws, is refused, or is accepted and silently no-ops leaves
  // a LIVE bearer in `window.location`. Whether every supported credential
  // actually went is what decides if telemetry may read the URL at all.
  const hasCredential = capturedCode !== null || invitationCode !== null;
  urlSafeForTelemetry =
    !hasCredential ||
    clearUrlFragmentAndConfirm(
      (liveHash) =>
        readHandoffCode(liveHash) !== null || readEventInvitationCode(liveHash) !== null,
    );
}

/** The code this page load arrived with, or `null`. */
export function pendingHandoffCode(): string | null {
  return capturedCode;
}

/**
 * Whether the URL is safe for analytics to observe.
 *
 * `false` only in the narrow case where the fragment could not be removed. The
 * app still boots and the captured credential remains usable; analytics are
 * suppressed for that page load, because one lost page view is not comparable
 * to exporting a bearer credential to a telemetry pipeline.
 */
export function isUrlSafeForTelemetry(): boolean {
  return urlSafeForTelemetry;
}

export interface ApplicationBootstrapDependencies {
  code: string | null;
  completeHandoff(code: string): Promise<{ kind: 'continue' } | { kind: 'recover' }>;
  loadMain(): Promise<unknown>;
  renderFailure(kind: BootstrapFailureKind): void;
}

/**
 * Compose the pre-app return with the application import.
 *
 * This lives in the dependency-free boot seam so the fail-closed ordering can
 * be executed in a unit test, rather than inferred from two separately tested
 * modules. A recovery result or unexpected return-module failure is terminal
 * for this document and can never reach `loadMain`.
 */
export async function runApplicationBootstrap(
  dependencies: ApplicationBootstrapDependencies,
): Promise<void> {
  if (dependencies.code !== null) {
    try {
      const result = await dependencies.completeHandoff(dependencies.code);
      if (result.kind === 'recover') {
        dependencies.renderFailure('handoff-recovery');
        return;
      }
    } catch {
      dependencies.renderFailure('handoff-recovery');
      return;
    }
  }

  try {
    await dependencies.loadMain();
  } catch {
    dependencies.renderFailure('app-load');
  }
}

export type BootstrapFailureKind = 'app-load' | 'handoff-recovery';

/**
 * Dependency-free last-resort UI for failures that happen before React exists.
 *
 * The recovery branch deliberately offers one action only. Reloading creates a
 * fresh primary Auth queue that can read whichever durable session won; mounting
 * this document would let an ambiguous Worker commit race the application.
 */
export function renderBootstrapFailure(kind: BootstrapFailureKind): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';
  const wrap = document.createElement('main');
  wrap.setAttribute('role', 'alert');
  wrap.style.cssText =
    'min-height:100dvh;display:grid;place-items:center;padding:2rem 1.5rem;background:#0b0f14;color:#eef2f6;font-family:system-ui,-apple-system,sans-serif;text-align:center';
  const inner = document.createElement('div');
  inner.style.maxWidth = '32rem';
  const h = document.createElement('h1');
  h.style.cssText = 'font-size:1.5rem;line-height:1.25;margin:0 0 0.75rem';
  const p = document.createElement('p');
  p.style.cssText = 'margin:0;line-height:1.55;color:#a9b7c4';

  if (kind === 'handoff-recovery') {
    h.textContent = 'Finish signing in';
    p.textContent =
      'The sign-in may have completed, but this page cannot confirm it safely. Reload once to check the saved session.';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.style.cssText =
      'margin-top:1.25rem;border:0;border-radius:999px;padding:0.75rem 1.25rem;background:#eef2f6;color:#0b0f14;font:600 1rem system-ui,-apple-system,sans-serif;cursor:pointer';
    reload.addEventListener('click', () => window.location.reload());
    inner.append(h, p, reload);
  } else {
    h.textContent = "This didn't load";
    p.textContent =
      'Something went wrong loading the app. Check your connection and reload the page, then tap Sign in again.';
    inner.append(h, p);
  }

  wrap.append(inner);
  root.append(wrap);
}
