import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
} from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import { initializeAnalytics, isSupported, type Analytics } from 'firebase/analytics';
import { isSyntheticProbe } from './synthetic-probe';
import { installFirestorePoisonRecovery } from './firestoreRecovery';
import { isUrlSafeForTelemetry } from './handoffBoot';
import { app, firebaseConfig, firebaseEmulatorsEnabled, functions } from './firebaseCore';
import { auth, googleProvider } from './firebaseAuth';

export { app, auth, firebaseEmulatorsEnabled, functions, googleProvider };
// ADR 0006: a persistent (IndexedDB) local cache so the last-seen Board/Feed/
// Tally render offline and Marks made in a dead zone queue durably and sync on
// reconnect — not the default in-memory cache, which loses queued writes on
// reload. The multi-tab manager coordinates the shared cache when a Player has
// the PWA open in several tabs. Same `db` symbol, so no call site changes.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// The watchdog for the instance created on the line above (#722,
// src/firestoreRecovery.ts). A single throw inside Firestore's AsyncQueue
// latches `failure` FOREVER — the SDK never clears it — so from then on every
// operation re-throws `INTERNAL ASSERTION FAILED (ID: b815)` and the tab is
// dead for data purposes until it is reloaded. That is what took out the
// heaviest player of the Bodega Bay POC mid-event.
//
// It is installed HERE, in the module that owns `db`, rather than from
// `main.tsx` module scope where the other out-of-tree rescues live, for two
// reasons. It is where the poisonable object is created, so the watchdog cannot
// drift away from what it watches. And it is provably early enough by
// construction: `initializeFirestore` is lazy, so no AsyncQueue exists — and
// therefore nothing can have poisoned one — until some later call touches `db`.
//
// Skipped for the uptime synthetic (#142), matching `enforceBuildFloor`: a probe
// run must never turn into a page reload.
if (!isSyntheticProbe()) installFirestorePoisonRecovery();

export const storage = getStorage(app);
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
if (firebaseEmulatorsEnabled()) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
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
    // …and never while a bearer credential is still sitting in the URL (#549,
    // #803). Suppressing the explicit page view and dimension registration is
    // not sufficient: `initializeAnalytics` starts GA4, which reads
    // `window.location` on its own, so INITIALISATION itself is the thing that
    // has to be conditional. This is the last analytics entry point in the
    // graph, which is why the check lives here rather than at each call site.
    //
    // `isUrlSafeForTelemetry` is false only in the narrow case where the
    // credential fragment could not actually be removed; `handoffBoot` is
    // deliberately free of Firebase imports, so there is no cycle.
    if (ok && firebaseConfig.measurementId && !isSyntheticProbe() && isUrlSafeForTelemetry()) {
      analytics = initializeAnalytics(app, { config: { send_page_view: false } });
    }
    return analytics;
  })
  .catch(() => {
    /* analytics unavailable; ignore */
    return null;
  });
