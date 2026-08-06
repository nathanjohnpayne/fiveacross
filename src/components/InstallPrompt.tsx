import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { useHasMarkedSquare, useToastSlot } from '../hooks/useToastStack';
import { editionLexicon } from '../editions';

const DISMISS_KEY = 'gcb.install.dismissedAt';
/** Toggled on <body> while the banner (either variant) is on screen — index.css
 *  keys extra `.app` bottom clearance off it, see specs/w1-pwa.md. */
const VISIBLE_CLASS = 'install-prompt-visible';
/** Toast-stack id (#219, "invitational" priority) — see useToastStack.ts. */
const TOAST_ID = 'install';

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) !== null;
  } catch {
    return false; // storage unavailable (private mode, etc.) — show the banner
  }
}

/**
 * Install-prompt toast (w1-pwa, #30; restyled + retimed by #219): captures
 * `beforeinstallprompt` and offers an in-app Install button (Chromium/Android),
 * or a manual "Add to Home Screen" hint on iOS. Fires `install_pwa` once
 * `userChoice` resolves `accepted`, or once `appinstalled` fires without this
 * button. Capture/tracking lives in `useInstallPrompt` (#208, frozen by #219).
 * Mounted at `main.tsx` alongside `ConsentNotice` (#17).
 *
 * #219 (specs/d15-pwa-toasts.md): the nudge no longer appears on app-load —
 * `useHasMarkedSquare()` gates it, flipping once the Player marks a first
 * Square. Final visibility is then arbitrated by `useToastSlot` alongside the
 * update banner ("urgent" outranks this toast's "invitational" rating).
 */
export default function InstallPrompt() {
  const { standalone, deferred, showIOSHint, install } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(isDismissed);
  // iOS "Show me" (#270): Safari never fires beforeinstallprompt, so the
  // button expands the Share → Add to Home Screen walkthrough in place.
  const [showWalkthrough, setShowWalkthrough] = useState(false);
  const hasMarkedSquare = useHasMarkedSquare();

  const wantsToShow = !standalone && !dismissed && hasMarkedSquare && (!!deferred || showIOSHint);
  const { visible, stackIndex, visibleCount } = useToastSlot(TOAST_ID, 'invitational', wantsToShow);

  useEffect(() => {
    document.body.classList.toggle(VISIBLE_CLASS, visible);
    return () => {
      document.body.classList.remove(VISIBLE_CLASS);
    };
  }, [visible]);

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore storage errors — still hides for this session */
    }
    setDismissed(true);
  };

  return (
    <div
      className="install-prompt"
      role="note"
      style={{ '--toast-index': stackIndex, '--toast-count': visibleCount } as CSSProperties}
    >
      {/* The wireframes' toast lead-in (#308) — emoji, per the spec's
          iconography rule ("toast lead-ins stay emoji"). */}
      <span className="toast-icon" aria-hidden="true">
        📲
      </span>
      {/* The wireframes' toast shape (#270): a title over the cruise-benefit
          line, the platform action (one-tap Install on Android/Chromium;
          "Show me" expanding the Share walkthrough on iOS Safari), and an ✕
          that dismisses forever — the affordance persists in More → Install
          the app, which is what lets this toast afford to be shy. */}
      <div className="install-prompt-body">
        <p className="toast-title">Add me to your Home Screen</p>
        <p>Full screen, works offline {editionLexicon().offlineWhy}.</p>
        {/* The expansion defers while another toast shares the stack (Codex
            P2 on #281 round 2): the slot offset is a fixed height, so a
            three-line toast under the urgent one would overlap — solo, it
            can grow freely. */}
        {!deferred && showWalkthrough && visibleCount === 1 && (
          <p className="install-prompt-steps">
            Tap Share <span aria-hidden="true">(the ⬆︎ square)</span>, then &ldquo;Add to Home
            Screen.&rdquo;
          </p>
        )}
      </div>
      {deferred ? (
        <button className="btn primary" onClick={install}>
          Install
        </button>
      ) : (
        (!showWalkthrough || visibleCount > 1) && (
          <button className="btn primary" onClick={() => setShowWalkthrough(true)}>
            Show me
          </button>
        )
      )}
      <button
        type="button"
        className="iconbtn install-prompt-dismiss"
        aria-label="Dismiss — reopen anytime from More"
        title="Dismiss"
        onClick={dismiss}
      >
        ✕
      </button>
    </div>
  );
}
