/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID: string;
  readonly VITE_EVENT_ID: string;
  // Which Edition this build serves (#555). Optional: absent means the legacy
  // `gcb` Edition, so existing builds and .env files need no change.
  readonly VITE_EDITION?: string;
  readonly VITE_RECAPTCHA_SITE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
// Build-time ISO timestamp (vite.config.ts define) — the ordered counterpart to
// __APP_VERSION__'s git SHA, compared against public/build-floor.json by the
// stale-build force-reload watchdog (src/buildFloor.ts).
declare const __BUILD_STAMP__: string;
