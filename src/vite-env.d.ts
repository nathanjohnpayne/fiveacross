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
  // Which Edition this build serves (#555): 'gcb' | 'vacay'. Optional: absent
  // means the legacy `gcb` Edition, so existing builds and .env files need no
  // change. Also brands a single-Event build's pre-auth shell
  // (src/editions.ts); hostname-resolved builds take the Edition from
  // `hostnames/{host}.edition` instead (#543).
  readonly VITE_EDITION?: string;
  // The 18+ opt-out for a SINGLE-EVENT build (#608). Only a literal 'false'
  // opts out. A hostname-resolved build ignores it entirely and defers to
  // `hostnames/{host}.adultContent`, which the server derives.
  readonly VITE_ADULT_CONTENT?: string;
  readonly VITE_RECAPTCHA_SITE_KEY: string;
  // Which route sign-in takes (#549, ADR 0010): 'handoff' (the default) or
  // 'same_origin'. OPTIONAL, and deliberately absent from `.env.example`'s
  // parsed keys: `scripts/build-target.mjs` requires every VITE_* key that file
  // DEFINES to exist in each target's env file, so declaring it there would
  // hard-fail every build until the untracked `.env.<target>` files gained it.
  // It is documented as a commented key there instead. See src/auth/authMode.ts.
  readonly VITE_AUTH_MODE?: string;
  // The central auth origin the handoff bounces through, e.g.
  // 'https://auth.fiveacross.app' (#547 provisions it). Optional for the same
  // reason as above. Absent in handoff mode means sign-in is unavailable on any
  // host that is not already registered — reported as its own screen, never as
  // a silent fallback to the same-origin path.
  readonly VITE_AUTH_HANDOFF_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
// Build-time ISO timestamp (vite.config.ts define) — the ordered counterpart to
// __APP_VERSION__'s git SHA, compared against public/build-floor.json by the
// stale-build force-reload watchdog (src/buildFloor.ts).
declare const __BUILD_STAMP__: string;
