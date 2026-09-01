import {
  browserPopupRedirectResolver,
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
} from 'firebase/auth';
import { app, firebaseEmulatorsEnabled } from './firebaseCore';

/**
 * The page's one primary Auth queue (#1060).
 *
 * Kept out of firebaseCore so a handoff return can prove Worker persistence,
 * exchange its code, and prepare the candidate before this page realm creates
 * an Auth instance. Explicit IndexedDB keeps the page on the same persistence
 * slot the Worker commits; popup/redirect support remains identical to getAuth.
 */
export const auth =
  indexedDBLocalPersistence.type === 'LOCAL'
    ? initializeAuth(app, {
        persistence: indexedDBLocalPersistence,
        popupRedirectResolver: browserPopupRedirectResolver,
      })
    : getAuth(app);

export const googleProvider = new GoogleAuthProvider();

if (firebaseEmulatorsEnabled()) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}
