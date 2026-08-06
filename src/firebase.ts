import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
} from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { initializeAnalytics, isSupported, type Analytics } from 'firebase/analytics';
import { isSyntheticProbe } from './synthetic-probe';
import { resolveAuthDomain } from './auth-domain';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: resolveAuthDomain(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, window.location.hostname),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
// ADR 0006: a persistent (IndexedDB) local cache so the last-seen Board/Feed/
// Tally render offline and Marks made in a dead zone queue durably and sync on
// reconnect — not the default in-memory cache, which loses queued writes on
// reload. The multi-tab manager coordinates the shared cache when a Player has
// the PWA open in several tabs. Same `db` symbol, so no call site changes.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const storage = getStorage(app);
export const functions = getFunctions(app, 'us-central1');

// Local Emulator Suite wiring for the Playwright e2e layer
// (specs/x-e2e-happy-path.md). The suite serves a `vite build --mode e2e` +
// `vite preview` of the app rather than `vite dev`, because the ADR 0006
// offline case reloads the page while offline and can only be served by the
// precaching service worker vite-plugin-pwa emits for a build (never for
// `vite dev`). So this gate keys off `import.meta.env.MODE === 'e2e'`, NOT
// `import.meta.env.DEV` (which is `false` in ANY build). `MODE` is a built-in
// Vite env var statically substituted at build time, so the real production
// build (`npm run build`, `MODE === 'production'`) folds this to
// `'production' === 'e2e'` → `false` and dead-code-eliminates the whole branch —
// the shipped bundle carries no emulator import or host string (verified by the
// dist/ grep in specs/x-e2e-happy-path.md's Testing section). The `demo-`
// project-id check is belt-and-suspenders (the same emulator-only convention
// tests/offline and tests/rules use). Ports mirror firebase.json's `emulators`
// block (auth 9099, firestore 8080, storage 9199) and tests/e2e/support/env.ts.
if (import.meta.env.MODE === 'e2e' && import.meta.env.VITE_FIREBASE_PROJECT_ID?.startsWith('demo-')) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}

// App Check (abuse protection). No-op unless a reCAPTCHA Enterprise site key is set.
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

/**
 * Which Event this session is serving.
 *
 * A `let`, not a `const`, because it is resolved from the hostname at startup
 * (#543, ADR 0009) rather than baked at build time. ESM exports are LIVE
 * BINDINGS, so every importer observes the resolved value once
 * `applyResolvedEventId` runs — and that is only safe because no consumer
 * captures it at import time: the seven `src/data/` modules all read `EVENT_ID`
 * INSIDE helper functions, so each call re-reads the binding
 * (`specs/x-multi-event-schema.md` § "Recommended migration seam"). A consumer
 * that ever writes `const id = EVENT_ID` at module scope would silently freeze
 * the pre-resolution value — that is the one way to break this.
 *
 * The initial value is the `VITE_EVENT_ID` fallback, so a single-Event build
 * (Gay Cruise Bingo) is already correct even if resolution never runs.
 */
export let EVENT_ID = import.meta.env.VITE_EVENT_ID || 'med-2026';

/**
 * Install the resolved Event id. Call exactly once, at startup, BEFORE the
 * React tree mounts: every Firestore path derives from this, so changing it
 * under live listeners would leave subscriptions pointed at the previous Event.
 * In-session Event switching is a separate, larger change — it needs the Event
 * id folded into every subscription key first (`useData.ts`).
 */
export function applyResolvedEventId(id: string): void {
  EVENT_ID = id;
}

// Analytics only loads in supported (browser, https) contexts with a measurement
// id — and never for the uptime synthetic (#142), whose load-only probe must not
// emit a GA4 page_view into real product metrics.
//
// `config: { send_page_view: false }` disables gtag's AUTOMATIC config-time
// `page_view` (#611, retro Phase 4b P1 on PR #584 — this reverses the #556
// round-2 rebuttal, at the reviewer's insistence with a concrete path: Nathan
// is the tiebreaker on record for that reversal). The automatic event used to
// fire, unconditionally and undimensioned, as part of `_initializeAnalytics`'s
// own synchronous `gtagCore('config', ...)` call — deterministically BEFORE
// any pending `setDefaultEventParameters` could apply, which is exactly why
// the round-2 rebuttal called it unfixable from the app side. Disabling it
// removes the automatic event entirely, and `emitInitialPageView`
// (src/analytics.ts) fires the equivalent EXPLICIT `page_view` once BOTH
// `analyticsReady` below AND Event resolution have settled (main.tsx), so it
// always carries the registered dimensions.
export let analytics: Analytics | null = null;

/**
 * Resolves once GA4's own support/config check has settled — `analytics`
 * itself (`null` when unsupported, no measurement id, or the synthetic
 * probe) by then. `emitInitialPageView` awaits this so the explicit
 * `page_view` it fires never races `analytics` still being null.
 */
export const analyticsReady: Promise<Analytics | null> = isSupported()
  .then((ok) => {
    if (ok && firebaseConfig.measurementId && !isSyntheticProbe()) {
      analytics = initializeAnalytics(app, { config: { send_page_view: false } });
    }
    return analytics;
  })
  .catch(() => {
    /* analytics unavailable; ignore */
    return null;
  });
