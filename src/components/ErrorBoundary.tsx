import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { phCapture } from '../posthog';
import { definitelyOffline, markResetAttempted, resetAttempted, resetShell } from '../shellRecovery';

/**
 * The app's only error boundary (the 2026-07-24 blank-screen incident).
 *
 * WHY THIS IS LOAD-BEARING, not defensive garnish. React unmounts the ENTIRE
 * root when a render error escapes with no boundary — not just the subtree that
 * threw. On 2026-07-24 a stale precached shell threw out of `isPristine` and
 * took the whole root down with it, including the `UpdatePrompt` sibling that
 * is the only caller of `updateServiceWorker(true)`. That is what turned a
 * recoverable "this build is too old" into a PERMANENT blank screen: the app
 * could no longer run the code that replaces the app. See src/shellRecovery.ts.
 *
 * So this boundary does two things, in order of importance:
 *  1. Contains the blast. The siblings mounted alongside the auth-gated tree in
 *     main.tsx — `UpdatePrompt` above all — keep running, so a newer waiting
 *     service worker can still be activated the normal way.
 *  2. Spends ONE automatic shell reset per tab (src/shellRecovery.ts), because
 *     a stale shell is the likeliest cause and self-healing beats a dead end.
 *     If the crash survives that reset it is an app bug, not a stale shell, so
 *     the second pass shows the panel and stops rather than reload-looping.
 *
 * The fallback deliberately reuses `.signin` and touches NOTHING from the app's
 * own context — no auth, no Firestore, no theme, no router. Whatever just broke
 * badly enough to unmount the tree is exactly what a recovery screen must not
 * depend on.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Auto-recovery needs all three (the last two are Codex P1s on #513):
    //  - the tab still has its one attempt;
    //  - we are not definitely offline — tearing the precache down with no
    //    network strands the player on the browser's offline page instead of
    //    this panel, which is worse than the crash (src/shellRecovery.ts);
    //  - the attempt RECORDS durably. A readable-but-unwritable store would
    //    otherwise re-arm the reset on every load: an unbounded reload loop.
    const offline = definitelyOffline();
    const recovering = !resetAttempted() && !offline && markResetAttempted();
    // PostHog's exception autocapture already reports the raw throw; this adds
    // the fact that it reached the BOUNDARY (i.e. it blanked the app rather
    // than being swallowed somewhere harmless) plus the build that did it, so
    // a stale-shell wave is legible as one build going bad in the dashboard.
    phCapture('app_crash', {
      message: error.message,
      build_stamp: __BUILD_STAMP__,
      component_stack: info.componentStack?.slice(0, 2000) ?? null,
      auto_recovering: recovering,
      offline,
    });
    // Keep the raw error on the console for local dev and for a bug report's
    // attached log — `phCapture` is a no-op until PostHog init resolves.
    console.error('App crashed', error);
    if (recovering) void resetShell();
  }

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="signin" role="alert">
        <h1>GAY CRUISE BINGO</h1>
        <p className="muted">
          Something went wrong on this device. Your marks are safe&mdash;they live on the server, not in this tab.
        </p>
        <button className="btn primary block" onClick={() => void resetShell()}>
          Reset &amp; reload
        </button>
        <p className="muted" style={{ fontSize: 11 }}>
          Lost signal at sea? The printed cards and PDF still work.
        </p>
      </div>
    );
  }
}
