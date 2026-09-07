import { EVENT_INVITATION_FRAGMENT_KEY } from './pendingEventInvitation';
const FIREBASE_AUTH_APP_HOST = 'gaycruisebingo.firebaseapp.com';

/**
 * Move a signed-out web.app visitor to the stable Firebase app origin before
 * authentication. firebaseapp.com is already an authorized Google callback and
 * serves both the app and Firebase's helper first-party; other hosts stay put.
 */
export function firebaseAuthOriginRedirectUrl(
  loc: {
    hostname: string;
    pathname: string;
    search: string;
    hash: string;
  },
  carry: { invitationCode: string | null } = { invitationCode: null },
): string | null {
  if (loc.hostname !== 'gaycruisebingo.web.app') return null;
  // A pending Invitation rides in the FRAGMENT, exactly as it arrived (#804,
  // Codex P1 on #1131): `entry.tsx` has already captured and cleared the
  // fragment and the stored record is bound to this origin, so a cross-origin
  // replacement that carried neither would land on firebaseapp.com with no
  // Invitation at all and let that visit deal without redeeming. The fragment
  // never reaches a server, and the destination captures it before its own
  // app boots, the same way the original link was captured here.
  const hash =
    carry.invitationCode === null ? loc.hash : `#${EVENT_INVITATION_FRAGMENT_KEY}=${carry.invitationCode}`;
  return `https://${FIREBASE_AUTH_APP_HOST}${loc.pathname}${loc.search}${hash}`;
}
// Exported for the other transport probes that need the same budget-bounded
// signal (posthog.ts ingest fallback, buildFloor.ts floor fetch — #342).
export function probeTimeoutSignal(timeoutMs: number): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  // Feature-detected (Codex P2 on #341): older Safari/iOS WebViews lack
  // AbortSignal.timeout, and an unconditional call would throw BEFORE fetch.
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(timeoutMs), cleanup: () => {} };
  }
  if (typeof AbortController === 'undefined') return { cleanup: () => {} };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}
