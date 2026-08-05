import { useState } from 'react';
import { adultContentRequired } from '../adultContent';

// Versioned so a change to the disclosure copy re-shows the notice once to
// everyone: the v1 key was dismissed under the old GA4-only wording, which never
// mentioned PostHog session replay. Bumping to v2 re-surfaces the accurate
// replay disclosure to prior visitors. (Codex P1 on #195.)
const KEY = 'gcb.consent.analytics.v2.dismissedAt';

/** Whether the 18+ analytics disclosure was already dismissed on this device. */
function isDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false; // storage unavailable (private mode, etc.) — show the notice
  }
}

/**
 * A lightweight, dismissible disclosure that this app uses analytics (GA4 and
 * PostHog, including session replay).
 *
 * The "18+" clause is CONDITIONAL as of #608 (Codex P2 on #615). This notice
 * mounts globally, including over the signed-out gate, so on an Event with no
 * adult content it was still making the age claim the sign-in gate had just
 * stopped making — the first screen a wedding party sees, contradicting the
 * screen behind it. The analytics disclosure itself is unconditional; only the
 * age claim follows `hostnames/{host}.adultContent`.
 * This is deliberately NOT a consent-management platform and NOT a gate:
 * `firebase.ts` already loads GA4 unconditionally (when supported + a
 * measurement id is configured), so dismissing this notice does not opt
 * anyone out of analytics — it only stops re-showing the disclosure on this
 * device. Copy and region handling are an open decision (#15); this ships
 * that issue's recommended default (a lightweight in-app notice, no region
 * gating) rather than blocking on it.
 */
export default function ConsentNotice() {
  const [dismissed, setDismissed] = useState(isDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* ignore storage errors — still hides for this session */
    }
    setDismissed(true);
  };

  return (
    <div className="consent-notice" role="note">
      <p>
        {adultContentRequired() ? 'This is an 18+ app. ' : ''}We use analytics&mdash;Google Analytics and PostHog, including
        session replay&mdash;to see what&rsquo;s working and improve the app. Nothing here is sold.
      </p>
      <button className="btn" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
