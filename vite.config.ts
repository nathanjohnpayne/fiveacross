import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execFileSync } from 'node:child_process';

function appVersion(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 40);
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  // Guard: never let a production build ship with a blank Firebase web config.
  // Vite statically inlines import.meta.env.* at build time (see src/firebase.ts),
  // so an empty VITE_FIREBASE_API_KEY compiles into a bundle whose top-level
  // getAuth() throws `auth/invalid-api-key` on load — a blank page for every
  // visitor. That is exactly the 2026-07-09 outage: `npm run deploy:hosting` ran
  // in an environment without the gitignored .env.local, baked in an empty key,
  // and deployed it silently. Fail loudly here instead.
  //
  // Scope: only the real deploy build. The emulator e2e build runs `--mode e2e`
  // (mode !== 'production') and legitimately has no key; app-ci's build step runs
  // without one on purpose (it verifies compilation, never deploys). We key the
  // CI exemption off GITHUB_ACTIONS, not the generic `CI` var: `CI` is set by
  // many tools and a stray `CI=<anything>` (even `CI=false`, a truthy string) in
  // a deploy shell would silently disable the guard, whereas GITHUB_ACTIONS is
  // set only by the runner and never by `npm run deploy` / `deploy:hosting`. What
  // remains is the local/agent production build — exactly the outage vector.
  if (command === 'build' && mode === 'production' && !process.env.GITHUB_ACTIONS) {
    const env = loadEnv(mode, process.cwd(), 'VITE_');
    // `.trim()` so a whitespace-only or leftover-placeholder key is rejected too
    // — it is just as broken as an empty one (still `auth/invalid-api-key`).
    if (!env.VITE_FIREBASE_API_KEY?.trim()) {
      throw new Error(
        'Refusing to build: VITE_FIREBASE_API_KEY is empty, which would ship a ' +
          'blank Firebase config and crash the app on load with ' +
          '`auth/invalid-api-key`. Populate .env.local (regenerate with ' +
          '`firebase apps:sdkconfig WEB --project gaycruisebingo`) before building ' +
          'or deploying. (These web identifiers are client-safe, not secret.)',
      );
    }
  }

  return {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion()),
      // Ordered build stamp for the remote force-reload floor (#342): git SHAs
      // (__APP_VERSION__) identify a build but cannot answer "older than X?",
      // so the floor check compares this ISO timestamp against
      // public/build-floor.json instead.
      __BUILD_STAMP__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [
      react(),
      VitePWA({
        // 'prompt': the new SW installs and WAITS instead of activating under the
        // running page; UpdatePrompt (src/components/UpdatePrompt.tsx, #178) owns
        // telling the player and activating it. 'autoUpdate' would swap the
        // precache out from under a live session with no reload, leaving stale
        // code running (and old hashed chunks 404-able) until a manual restart.
        registerType: 'prompt',
        // #514: `injectManifest` because the worker now carries LOGIC — an
        // install-time build-floor check that can promote itself with no page
        // cooperation, which is the only way to reach a client whose React tree
        // has already crashed (see src/sw.ts and src/sw-rescue.ts). The
        // generated worker had nowhere to put that. Everything generateSW used
        // to do for us is ported verbatim in src/sw.ts, ticket references
        // included, because silently dropping one of those behaviours is the
        // real hazard of hand-rolling this file.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        includeAssets: ['favicon.svg', 'og-default.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'Gay Cruise Bingo',
          // The home-screen label, and Android's only source for it — iOS reads
          // `apple-mobile-web-app-title` from index.html instead, which is why
          // the two platforms can differ here (#364). Kept under the ~12-char
          // truncation point so Android renders it whole; dropping "Cruise"
          // rather than "Gay" is the deliberate trade (#359).
          short_name: 'Gay Bingo',
          description: 'Live multiplayer bingo for the high seas.',
          theme_color: '#07060d',
          background_color: '#07060d',
          display: 'standalone',
          orientation: 'portrait',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
          ]
        },
        // Under `injectManifest` this block only decides WHAT gets precached;
        // the routing that used to live here (navigation fallback + its /__/*
        // denylist #182, and the proof-media CacheFirst #363) now lives in
        // src/sw.ts, which is the file to read and the file to keep in sync.
        //
        // The glob deliberately still excludes `.json`, which is what keeps
        // `/build-floor.json` OUT of the precache: the floor is the one file a
        // stale shell must be able to read fresh, and precaching it would let a
        // stale worker answer its own eviction notice.
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}']
        }
      })
    ],
    // Vitest "app" layer: jsdom so React Testing Library can mount components.
    // Only src/ specs run here — self-contained on ROOT deps alone (CI runs just
    // `npm ci` at the root). The functions specs (tests/functions/) import
    // functions/src, which pulls resend/firebase-admin declared only in
    // functions/package.json, so they run separately via `npm run test:functions`
    // (vitest.functions.config.ts, which installs functions deps first). The
    // emulator rules layer lives in vitest.rules.config.ts and the Playwright e2e
    // layer in playwright.config.ts, so `npm test` never needs a functions
    // install, a running emulator, or a browser.
    test: {
      globals: true,
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts']
    }
  };
});
