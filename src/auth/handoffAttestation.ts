import type { User } from 'firebase/auth';

interface AuthSessionIdentity {
  uid: string;
  refreshToken: string;
}

// The return leg completes before AuthProvider exists. Keep the acknowledged
// session in this tab's module memory just long enough for AuthProvider to adopt
// it into its existing optimistic/committed attestation state machine.
let pendingHandoffAttestation: AuthSessionIdentity | null = null;

/** Fixed-text diagnostics only; logging must never become an auth dependency. */
export function debugHandoff(message: string): void {
  try {
    console.debug(`[auth-handoff] ${message}`);
  } catch {
    // Diagnostics never block authentication.
  }
}

function sessionIdentity(user: Pick<User, 'uid' | 'refreshToken'> | null): AuthSessionIdentity | null {
  if (user === null) return null;
  if (typeof user.uid !== 'string' || user.uid.length === 0) return null;
  if (typeof user.refreshToken !== 'string' || user.refreshToken.length === 0) return null;
  return { uid: user.uid, refreshToken: user.refreshToken };
}

/** Stage one checkbox acknowledgement for the exact promoted Auth session. */
export function rememberHandoffAttestation(user: Pick<User, 'uid' | 'refreshToken'>): boolean {
  pendingHandoffAttestation = sessionIdentity(user);
  return pendingHandoffAttestation !== null;
}

/**
 * Consume the staged acknowledgement once, and only for the exact Auth session.
 * A same-uid replacement from another tab is not the transaction that collected
 * the checkbox and must take the ordinary profile/re-prompt path.
 */
export function consumeHandoffAttestation(user: Pick<User, 'uid' | 'refreshToken'> | null): boolean {
  const expected = pendingHandoffAttestation;
  pendingHandoffAttestation = null;
  if (expected === null) return false;
  const actual = sessionIdentity(user);
  return (
    actual !== null &&
    expected.uid === actual.uid &&
    expected.refreshToken === actual.refreshToken
  );
}

/** Test/reset seam; production retirement normally happens through consume. */
export function forgetHandoffAttestation(): void {
  pendingHandoffAttestation = null;
}
