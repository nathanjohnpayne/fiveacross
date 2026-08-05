import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { editionBrand } from '../editions';
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
 *
 * Its ONE dependency is the Edition brand (#543, ADR 0009), and it earns the
 * exemption rather than being an exception to the rule: `editionBrand()` is a
 * synchronous table lookup with a `?? BRANDS[DEFAULT_EDITION]` fallback — no
 * hook, no context, no I/O, and no input for which it throws. Its default
 * argument resolves through `activeEdition()`, which by the time anything can
 * crash is the Edition `bootstrapEventResolution` installed, and before that a
 * `VITE_EDITION` literal Vite has already inlined (#586 made that seed lazy so
 * the Vite config could import this table; the laziness is invisible here).
 * `src/editions.ts` is already in the boot graph (`SignIn`, `theme/themes.ts`,
 * `bootstrapEventResolution`), so importing it adds no failure mode that is not
 * already fatal: a module that failed to evaluate would take the bundle down
 * before this boundary existed to render. Holding the strings instead is the
 * thing that actually costs a player something — the wordmark and the offline
 * note here WERE the `gcb` literals, so a Bodega guest whose tree crashed was
 * shown another product's name and told to go find the printed cards for a
 * cruise that is not happening (the #543/#576 defect, on the third and last
 * surface that reuses this shell).
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
    phCapture(
      'app_crash',
      {
        message: error.message,
        build_stamp: __BUILD_STAMP__,
        component_stack: info.componentStack?.slice(0, 2000) ?? null,
        auto_recovering: recovering,
        offline,
      },
      // Beacon, because auto-recovery reloads the page a moment from now and
      // the default batched transport would lose this event on the way out
      // (CodeRabbit on #513). That would be self-defeating: `app_crash` is the
      // signal that makes the NEXT stale-shell wave visible at all — the last
      // one was only diagnosable because the raw throw reached PostHog.
      { transport: 'sendBeacon', send_instantly: true },
    );
    // Keep the raw error on the console for local dev and for a bug report's
    // attached log — `phCapture` is a no-op until PostHog init resolves.
    console.error('App crashed', error);
    if (recovering) void resetShell();
  }

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    // Read at render, not construction: a class component has no hook, and the
    // Edition is installed by `bootstrapEventResolution` before mount anyway.
    const brand = editionBrand();
    return (
      <div className="signin" role="alert">
        <h1>{brand.wordmark}</h1>
        <p className="muted">
          Something went wrong on this device. Your marks are safe&mdash;they live on the server, not in this tab.
        </p>
        <button className="btn primary block" onClick={() => void resetShell()}>
          Reset &amp; reload
        </button>
        <p className="muted" style={{ fontSize: 11 }}>{brand.offlineNote}</p>
      </div>
    );
  }
}
