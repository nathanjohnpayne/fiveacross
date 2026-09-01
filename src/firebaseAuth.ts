import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
} from 'firebase/auth';
import { app, firebaseEmulatorsEnabled } from './firebaseCore';
import { fingerprintHandoffSession } from './auth/handoffSessionFingerprint';

/**
 * The page's one primary Auth queue (#1060).
 *
 * Kept out of firebaseCore so a handoff return can prove Worker persistence,
 * exchange its code, and prepare the candidate before this page realm creates
 * an Auth instance. Keep Firebase's browser default persistence hierarchy here:
 * IndexedDB, then localStorage, then sessionStorage. Direct hosts historically
 * relied on those fallbacks. The handoff path proves writable IndexedDB before
 * loading this module, so its page Auth still selects the same IndexedDB slot
 * the Worker commits without narrowing ordinary browser compatibility.
 */
export const auth = getAuth(app);

export const googleProvider = new GoogleAuthProvider();

if (firebaseEmulatorsEnabled()) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}

// Production-bundle browser proof for #1060. Like ShareCard's e2e-only hook,
// this branch is folded out of production builds. It returns only the same
// attempt-bound digest the Worker protocol already exposes, never the bearer
// refresh token. A third, freshly opened page can therefore prove that its own
// primary Auth loaded the exact winning persisted session.
if (import.meta.env.MODE === 'e2e') {
  (
    window as unknown as {
      __authHandoffFingerprintE2E?: (
        ownerNonce: string,
      ) => Promise<{ uid: string; refreshTokenDigest: string } | null>;
    }
  ).__authHandoffFingerprintE2E = async (ownerNonce) => {
    await auth.authStateReady();
    const user = auth.currentUser;
    if (user === null || !user.refreshToken) return null;
    return {
      uid: user.uid,
      refreshTokenDigest: await fingerprintHandoffSession({
        ownerNonce,
        uid: user.uid,
        refreshToken: user.refreshToken,
      }),
    };
  };
}
