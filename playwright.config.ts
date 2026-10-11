import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, EVENT_ID, PROJECT_ID, STORAGE_BUCKET, WEB_PORT } from './tests/e2e/support/env';

// Playwright e2e layer. `smoke.spec.ts` (w0-test-harness) needs no emulator or
// app server — it drives page content directly. x-e2e-happy-path is the full
// join -> mark -> BINGO -> leaderboard round plus the ADR 0006 offline-mark
// assertion, and needs both: the Firestore/Auth/Storage emulators and the app.
//
// The emulators are NOT a webServer here: `npm run test:e2e` wraps
// `playwright test` in `firebase emulators:exec --only auth,firestore,storage`
// (see package.json), which starts all three and — unlike a single-port
// webServer readiness check — only runs Playwright once EVERY emulator is ready,
// closing the auth-emulator (9099) startup race a Firestore-port (8080) gate
// would miss. The app itself is the webServer below.
//
// Why a build + preview, not `vite dev`: the ADR 0006 offline case reloads the
// page while offline, which only resolves when the precaching service worker
// vite-plugin-pwa emits FOR A BUILD serves the shell — `vite dev` ships no such
// SW. `--mode e2e` sets import.meta.env.MODE === 'e2e', the signal
// `src/firebase.ts`'s emulator branch keys off; the real production build
// (`npm run build`, MODE === 'production') dead-code-eliminates that branch.
//
// The VITE_FIREBASE_* values below (read at BUILD time and baked into the
// bundle) point the served app at a `demo-`-prefixed, emulator-only project id:
// a stray call can never reach a real Firebase project, and the prefix is the
// belt-and-suspenders second half of the emulator branch's gate. So the served
// app's own Firebase client talks to the emulators emulators:exec boots
// (delivered in specs/x-e2e-happy-path.md).
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // Serial, single worker: both x-e2e-happy-path cases join the SAME seeded
  // Event against the SAME shared emulator, and the happy-path case asserts it
  // is the *sole* Player on the leaderboard (Leaderboard.tsx renders one row per
  // joined Player). Running it first and alone keeps that true; serial also
  // sidesteps any emulator/service-worker/port contention between cases. This
  // layer is local-only (a handful of cases), so the serial cost is negligible.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // #317: every spec's FIRST step is join.ts's real sign-in round trip through
  // the Auth Emulator widget, whose handler-wiring waits on an external CDN
  // fetch (unpkg.com/material-components-web) that alone can take several
  // seconds under real machine load, worst-cased at up to 40s inside join.ts's
  // completeEmulatorSignIn — the bare 30s Playwright default left almost no
  // room for a spec's own work after that (the single largest contributor to
  // the union suite's mass sign-in-adjacent failures). Individual heavy specs
  // already opt into much larger budgets (60s–240s) via `test.setTimeout`;
  // this only raises the floor for the many specs that never needed to
  // override it before sign-in itself became the tight part of the budget,
  // leaving them real headroom after a worst-case join.
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    // Failure artifacts (#317): local runs have retries=0, so 'on-first-retry'
    // never captured anything here — a union-run flake left only the aria
    // snapshot, not what the page actually looked like or how it got there.
    // Both settings are free on green tests (screenshot only taken on failure;
    // the recorded trace is discarded on pass).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // Build with `--mode e2e` (activates src/firebase.ts's emulator branch),
      // then serve the built app so a real precaching service worker exists for
      // the ADR 0006 offline-reload case. --host 127.0.0.1 pins the IPv4
      // loopback explicitly: Vite's default `localhost` bind resolves to the
      // IPv6 loopback ONLY on this host, and BASE_URL (env.ts) — and every
      // emulator host constant alongside it — is the literal 127.0.0.1 Chromium
      // then fails to reach.
      command: `npx vite build --mode e2e && npx vite preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      port: WEB_PORT,
      // Never reuse: what this run must serve is the bundle the command above
      // just built. A leftover listener on the dedicated e2e port (5183) would
      // otherwise be silently trusted and could serve a stale — or non-e2e —
      // bundle (Codex P3 on PR #114).
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        // Demo-prefixed per Firebase convention (never resolves to a real
        // Google Cloud project) — read at build time and baked into the bundle.
        VITE_FIREBASE_API_KEY: 'demo-api-key',
        VITE_FIREBASE_AUTH_DOMAIN: `${PROJECT_ID}.firebaseapp.com`,
        VITE_FIREBASE_PROJECT_ID: PROJECT_ID,
        VITE_FIREBASE_STORAGE_BUCKET: STORAGE_BUCKET,
        VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
        VITE_FIREBASE_APP_ID: '1:000000000000:web:0000000000000000000000',
        VITE_EVENT_ID: EVENT_ID,
        // Hermetic build (Codex P2 on PR #114 round 3): explicitly BLANK every
        // optional analytics / App Check var so an e2e build on a real
        // developer checkout can never inherit a live key from `.env.local` or
        // the parent env and initialize real GA4 / PostHog / App Check — which
        // would emit synthetic login/mark/bingo/pageview events or load
        // reCAPTCHA. An already-set (even empty) process-env var wins over
        // `.env*` in Vite, so these win; each gate is `if (measurementId)` /
        // `if (!key) return` / `if (VITE_RECAPTCHA_SITE_KEY)`, so blank = off.
        VITE_FIREBASE_MEASUREMENT_ID: '',
        VITE_POSTHOG_KEY: '',
        VITE_POSTHOG_HOST: '',
        VITE_RECAPTCHA_SITE_KEY: '',
      },
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
