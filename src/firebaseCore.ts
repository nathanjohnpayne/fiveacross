import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { resolveAuthDomain } from './auth-domain';

/**
 * Firebase services safe to initialize before page Auth exists (#1060).
 *
 * The handoff return imports this module before the app graph so it can exchange
 * the one-use code with the existing DOM-backed App Check provider. Keep Auth,
 * Firestore, Storage, Analytics, React, and application data modules out of this
 * boundary: importing any of them would recreate the page Auth queue before the
 * disposable Worker has completed its supervised commit.
 */
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: resolveAuthDomain(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, window.location.hostname),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

export const app = initializeApp(firebaseConfig);
export const functions = getFunctions(app, 'us-central1');

/** The one production/e2e boundary shared by every Firebase service instance. */
export function firebaseEmulatorsEnabled(): boolean {
  return import.meta.env.MODE === 'e2e' && import.meta.env.VITE_FIREBASE_PROJECT_ID?.startsWith('demo-');
}

if (firebaseEmulatorsEnabled()) {
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}

// App Check must exist on the PAGE before exchangeAuthHandoff is called. The
// reCAPTCHA Enterprise provider depends on the DOM and cannot be moved into the
// dedicated commit Worker.
if (import.meta.env.VITE_RECAPTCHA_SITE_KEY) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(import.meta.env.VITE_RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch {
    /* App Check optional in dev */
  }
}
