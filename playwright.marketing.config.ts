// Marketing-screenshot capture (docs/app/marketing-screenshots.md). NOT a test
// layer: it drives the real app over an emulator-seeded demo Event and writes
// PNGs for the portfolio site, project pages and blog posts.
//
// Deliberately OUTSIDE `tests/e2e` (playwright.config.ts's testDir) so
// `npm run test:e2e` never picks it up: it asserts nothing and would fail
// against that suite's GCB-edition build.
import { defineConfig, devices } from '@playwright/test';
import {
  HERO_BASE_URL,
  HERO_EDITION,
  HERO_EVENT_ID,
  HERO_PROJECT_ID,
  HERO_WEB_PORT,
} from './tests/marketing/support/fixture';

export default defineConfig({
  testDir: './tests/marketing',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: 'list',
  use: {
    baseURL: HERO_BASE_URL,
    // Pinned so two machines produce byte-comparable captures. Leaderboard
    // formats each seeded `firstBingoAt` with `toLocaleString([], …)`, which
    // otherwise follows the host's locale and zone — identical fixture
    // timestamps would render different visible labels (Codex P2 on #1020).
    // The zone matches the seeded Event's own `timezone`.
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `npx vite build --mode e2e && npx vite preview --port ${HERO_WEB_PORT} --strictPort --host 127.0.0.1`,
      port: HERO_WEB_PORT,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        VITE_FIREBASE_API_KEY: 'demo-api-key',
        VITE_FIREBASE_AUTH_DOMAIN: `${HERO_PROJECT_ID}.firebaseapp.com`,
        VITE_FIREBASE_PROJECT_ID: HERO_PROJECT_ID,
        VITE_FIREBASE_STORAGE_BUCKET: `${HERO_PROJECT_ID}.appspot.com`,
        VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
        VITE_FIREBASE_APP_ID: '1:000000000000:web:0000000000000000000000',
        VITE_EVENT_ID: HERO_EVENT_ID,
        VITE_EDITION: HERO_EDITION,
        VITE_ADULT_CONTENT: 'false',
        VITE_FIREBASE_MEASUREMENT_ID: '',
        VITE_POSTHOG_KEY: '',
        VITE_POSTHOG_HOST: '',
        VITE_RECAPTCHA_SITE_KEY: '',
      },
    },
  ],
  // 2× DPR so the 393pt phone frame lands as a 786×1550 retina asset,
  // matching the other project heroes on nathanpayne.com.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 2 } }],
});
