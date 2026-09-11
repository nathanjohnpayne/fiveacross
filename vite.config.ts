import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { assertDeployFirebaseApiKey, resolveAppVersion } from './src/build-config';
// The SAME brand table the app renders the sign-in gate from (#580's one-table
// rule, extended to the browser chrome in #586). Importing it rather than
// restating four strings here is the whole point: a second copy is how the
// wordmark and the tab end up disagreeing. src/editions.ts is kept free of
// module-scope `import.meta.env` / `document` so it can be loaded in this Node
// context — see the note at the top of that file before adding anything to it.
import { brandHtmlIdentity, buildTimeEdition, editionBrand, type EditionBrand } from './src/editions';
// The PWA manifest is built by the SAME module the edge Worker builds it from
// (#546), so `dist/manifest.webmanifest` and a per-hostname edge response are
// the same bytes. This config emits the file itself; `VitePWA` is told
// `manifest: false` below, which is what keeps the entry out of the precache.
import {
  buildWebManifest,
  serializeWebManifest,
  WEB_MANIFEST_FILENAME,
} from './src/web-manifest';
import { precachedUrls } from './src/sw-precache-audit';

function appVersion(): string {
  return resolveAppVersion(process.env, () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }));
}

/**
 * Bake the build's Edition into `index.html`'s static chrome tags (#586).
 *
 * All the substitution and its fail-closed check live in `brandHtmlIdentity`
 * (src/editions.ts), beside the brand table they read, so they are unit-tested
 * without running a build. This is only the Vite seam.
 *
 * A hostname-resolved build has no single Edition to bake; it repairs the same
 * two tags after resolution instead (`applyEditionDocumentIdentity`), and
 * whatever this baked is simply overwritten.
 */
function editionHtmlIdentity(brand: EditionBrand): Plugin {
  return {
    name: 'edition-html-identity',
    // 'pre' so this runs BEFORE Vite's own `%VITE_FOO%` env replacement, which
    // Vite appends to the END of the pre-hook list (in dev and in build alike).
    // Ordering is load-bearing rather than tidy: that hook leaves any `%…%` it
    // does not recognise verbatim in the output, so losing the race would ship
    // the literal placeholder rather than fail.
    enforce: 'pre',
    transformIndexHtml: (html) => brandHtmlIdentity(html, brand),
  };
}

/**
 * Emit `manifest.webmanifest` and link it from the document (#546).
 *
 * This is work `vite-plugin-pwa` used to do, taken over here because its
 * manifest support cannot be separated from the precache entry it appends (see
 * the `manifest: false` note below). Nothing about the artifact changes: the
 * bytes come from `src/web-manifest.ts`, which reproduces the plugin's output
 * member-for-member and in the same order, and the link tag lands in the built
 * document's head exactly where the plugin put it.
 *
 * `apply: 'build'` matches the behaviour it replaces rather than extending it.
 * `devOptions` is not enabled, so `vite dev` served no manifest and injected no
 * link tag before this ticket either; emitting a tag in dev that pointed at a
 * file only the build produces would be a new 404, not a fix.
 *
 * The Worker builds its per-hostname response from the same two functions, so
 * "the file the build ships" and "the file the edge serves" are one definition
 * with two callers rather than two definitions kept in step by review.
 */
function editionWebManifest(brand: EditionBrand): Plugin {
  return {
    name: 'edition-web-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: WEB_MANIFEST_FILENAME,
        source: serializeWebManifest(buildWebManifest(brand)),
      });
    },
    transformIndexHtml: {
      // 'post' so the tag is appended after the app's own markup has been
      // transformed — the position the plugin's injection had.
      order: 'post',
      handler: () => [
        {
          tag: 'link',
          attrs: { rel: 'manifest', href: `/${WEB_MANIFEST_FILENAME}` },
          injectTo: 'head' as const,
        },
      ],
    },
  };
}

/**
 * Fail the BUILD if `manifest.webmanifest` ever re-enters the precache (#546).
 *
 * The exclusion is structural, but it is structural inside a dependency: a
 * `vite-plugin-pwa` upgrade that appends the manifest entry regardless of
 * `manifest: false`, or a later edit that re-enables the plugin's manifest
 * without reading why it is off, would silently restore the defect this ticket
 * exists to remove — and it is invisible in every surface a reviewer looks at.
 * The config would not mention it, and `grep` cannot find it in the emitted
 * worker: `dist/sw.js` is minified past the point where grep classifies it as
 * binary, so a search reports NOTHING and exits 1. That false all-clear is
 * exactly how the entry went unnoticed in the first place.
 *
 * So the emitted worker is parsed here, in the build, and not only in a test:
 * `npm test` runs BEFORE `npm run build` in CI (`.github/workflows/app-ci.yml`),
 * so on the run that matters a test has no built artifact to read. `closeBundle`
 * with `order: 'post'` places this after `vite-plugin-pwa`'s own `closeBundle`,
 * which is where it generates the worker.
 */
function precacheExclusionGuard(): Plugin {
  let outDir = 'dist';
  return {
    name: 'precache-exclusion-guard',
    apply: 'build',
    configResolved(config) {
      outDir = resolvePath(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const swPath = resolvePath(outDir, 'sw.js');
        // An SSR pass, or a build configuration that emits no worker, has
        // nothing to audit. Absence is not evidence of the defect.
        if (!existsSync(swPath)) return;
        const urls = precachedUrls(readFileSync(swPath, 'utf8'));
        // Positive control FIRST. A reader that has stopped matching returns an
        // empty list, and "the manifest is not in an empty list" is a pass that
        // proves nothing — the same shape of false all-clear as the grep.
        if (urls.length === 0) {
          throw new Error(
            `precache-exclusion-guard: no precache entries found in ${swPath}. Either the ` +
              'service worker precaches nothing (an app shell that cannot load offline) or ' +
              'src/sw-precache-audit.ts no longer understands the emitted format. Either way ' +
              'this guard has stopped checking anything.',
          );
        }
        if (urls.includes(WEB_MANIFEST_FILENAME)) {
          throw new Error(
            `precache-exclusion-guard: ${WEB_MANIFEST_FILENAME} is back in the service-worker ` +
              'precache. Workbox then answers it cache-first, so the edge Worker per-hostname ' +
              'manifest (#546) can never reach a controlled client, and the entry revision is ' +
              'an MD5 of the build-time bytes, so an installed shell never re-fetches it ' +
              'either. See the `manifest: false` note in vite.config.ts.',
          );
        }
      },
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const targetBuild = process.env.DEPLOY_TARGET_BUILD === '1';
  // Normal local builds load their development VITE_* values from env files.
  // A named deploy target instead receives its complete VITE_* environment
  // from scripts/build-target.mjs. It must not reload .env, .env.local, or a
  // mode-specific root file after that wrapper has removed ambient values.
  const env = targetBuild ? process.env : loadEnv(mode, process.cwd(), 'VITE_');
  // `buildTimeEdition` keeps a hostname-resolved bundle independent of stale
  // VITE_EDITION. A named target may carry a trusted static fallback for the
  // static HTML identity the edge cannot yet rewrite per host (#1118) and for
  // the manifest a host serves before the Worker routes are attached. Always
  // an EXPLICIT id, never `editionBrand()`'s default argument: that resolves
  // through `activeEdition()`, which reads `import.meta.env` and does not exist
  // here.
  const brand = editionBrand(
    buildTimeEdition(
      env.VITE_EVENT_ID,
      env.VITE_EDITION,
      targetBuild ? process.env.DEPLOY_TARGET_STATIC_EDITION : undefined,
    ),
  );

  // Guard: never let a production build ship with a blank Firebase web config.
  // Vite statically inlines import.meta.env.* at build time (see src/firebase.ts),
  // so an empty VITE_FIREBASE_API_KEY compiles into a bundle whose top-level
  // getAuth() throws `auth/invalid-api-key` on load — a blank page for every
  // visitor. That is exactly the 2026-07-09 outage: `npm run deploy:hosting` ran
  // in an environment without the gitignored .env.local, baked in an empty key,
  // and deployed it silently. Fail loudly here instead.
  //
  // Scope: only the real deploy build. The emulator e2e build runs `--mode e2e`
  // (mode !== 'production') and legitimately has no key; app-ci's ordinary build
  // runs without one on purpose (it verifies compilation, never deploys). A
  // named target build is always a deploy-shaped production build, even when an
  // operator starts it in GitHub Actions, so it never receives that CI exemption.
  assertDeployFirebaseApiKey({
    command,
    mode,
    githubActions: process.env.GITHUB_ACTIONS,
    targetBuild,
    apiKey: env.VITE_FIREBASE_API_KEY,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
  });

  return {
    // Disable Vite's automatic env-file reload for a named target. The target
    // wrapper supplied every VITE_* value above; allowing another load here
    // could reintroduce stale local Firebase, Event, or Edition values.
    ...(targetBuild ? { envDir: false } : {}),
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
      editionHtmlIdentity(brand),
      editionWebManifest(brand),
      precacheExclusionGuard(),
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
        // og-*.png (the unfurl artwork, #587/#609) is deliberately NOT here —
        // and is excluded from the precache below. The images still ship: they
        // live in public/, so Vite copies every one of them into dist/ and
        // hosting serves them; all three Editions' artwork rides in every
        // bundle so the #546 Worker can point any hostname at its Edition's
        // image without a coordinated redeploy. But they are CRAWLER-facing —
        // the app never renders them — and precaching them (as the *.png glob
        // otherwise would, and historically did for og-default.png) taxes
        // every phone ~1 MB at install time for files no client ever loads.
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        // `false`, and this single word is the load-bearing half of #546.
        //
        // The plugin's manifest support is not just "generate the file": when
        // it is enabled it ALSO appends `{url: 'manifest.webmanifest'}` to
        // `injectManifest.additionalManifestEntries`, unconditionally and
        // downstream of every knob this config exposes. `globPatterns` cannot
        // exclude it (the glob never matched it in the first place — the entry
        // arrives by a different route), and neither can a `manifestTransforms`
        // filter, because Workbox runs `additionalManifestEntriesTransform`
        // strictly LAST, after every user transform has already seen the list.
        //
        // A precached manifest is fatal to this ticket. `precacheAndRoute`
        // answers `/manifest.webmanifest` cache-first, so an edge-served
        // per-hostname manifest never reaches a client the service worker
        // controls; and the entry's `revision` is an MD5 of the BUILD-TIME
        // bytes, so redeploying the same Edition reuses the same hash and the
        // shells real players are already carrying keep their pre-cutover
        // identity indefinitely. Turning the plugin's manifest off removes the
        // entry structurally rather than filtering it after the fact.
        //
        // What this config takes over as a consequence — emitting the file and
        // linking it from the document — is `editionWebManifest` below.
        manifest: false,
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
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // Keep the unfurl artwork out of every client's precache — see the
          // includeAssets note above. Guarded by src/recon-share-og.test.ts.
          globIgnores: ['og-*.png']
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
    //
    // `worker/**` joins this layer rather than getting a runner of its own
    // (#545). The edge router's decision modules import nothing from
    // `worker/package.json` — every platform seam (fetch, cache, clock) is
    // injected, exactly as specs/event-resolution.md requires of the client
    // resolver — so they are self-contained on ROOT deps like `src/**` is, and
    // a separate config would buy nothing but a suite CI could forget to run.
    // Each `worker/` spec opts into the `node` environment with its own
    // `@vitest-environment` docblock: they exercise `Request`/`Response`, which
    // belong to the runtime rather than to jsdom.
    //
    // `router-publisher/**` joins on the same terms (#1135). Its runtime module
    // is a Functions Framework CloudEvent handler, but the half under test —
    // `isRegistryHost`, `validDesired`, `replicaPayloadFromEvent` — is pure
    // string and record validation importing nothing from
    // `router-publisher/package.json`, so it is self-contained on ROOT deps
    // exactly as `worker/**` is. It joins THIS layer rather than getting a
    // runner of its own for the same reason `worker/**` did: a separate config
    // would buy nothing but a step in `.github/workflows/app-ci.yml` that CI
    // could forget, and an unrun suite is exactly the gap #1135 is about. The
    // spec opts into the `node` environment with its own docblock, and is
    // excluded from `router-publisher/tsconfig.json` so the deployed `lib/`
    // artifact stays exactly what it was — `router-publisher/tsconfig.test.json`
    // is the sibling program that typechecks it.
    test: {
      globals: true,
      environment: 'jsdom',
      include: [
        'src/**/*.test.{ts,tsx}',
        'scripts/**/*.test.mjs',
        'worker/**/*.test.ts',
        'router-publisher/**/*.test.ts'
      ],
      // The production-origin integration seam runs a full vite build and has
      // its own layer (`npm run test:origin`, vitest.origin.config.ts, #965).
      // Overriding `exclude` replaces vitest's defaults, so the dependency and
      // build directories are restated here.
      exclude: ['**/node_modules/**', '**/dist/**', 'scripts/fiveacross-origin.integration.test.mjs'],
      setupFiles: ['./src/test/setup.ts']
    }
  };
});
