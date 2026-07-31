/// <reference lib="webworker" />
//
// The app's service worker (#514). Hand-written because it has to carry LOGIC —
// see src/sw-rescue.ts for why a generated worker could not close the gap #513
// left open.
//
// PORTED, NOT REDESIGNED. Everything below the rescue section is a faithful
// port of what `vite-plugin-pwa` previously generated for us in `generateSW`
// mode; the switch to `injectManifest` (vite.config.ts) is what buys the space
// to add an install-time handler at all. Each ported behaviour keeps the ticket
// reference that justified it, because losing one of them silently is the real
// risk of hand-rolling this file:
//   - precache + `cleanupOutdatedCaches` (the stale-shell hygiene whose absence
//     let TWO `/index.html` revisions coexist during the 2026-07-24 incident);
//   - SPA navigation fallback to `index.html`, with `/__/*` denied so the Google
//     sign-in popup reaches Firebase's real OAuth handler instead of the app
//     shell (#182);
//   - CacheFirst for proof media, opaque responses included (#363);
//   - the `SKIP_WAITING` message handler that `registerType: 'prompt'` and
//     `UpdatePrompt`'s Reload button depend on (#178).

import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import {
  PROOF_MEDIA_CACHE_MAX_AGE_SECONDS,
  PROOF_MEDIA_CACHE_MAX_ENTRIES,
  PROOF_MEDIA_CACHE_NAME,
  PROOF_MEDIA_URL_PATTERN,
} from './data/proofMediaCache';
import {
  clearForcedActivation,
  fetchFloorWithRetry,
  markForcedActivation,
  readActiveStamp,
  shouldForceActivate,
  takeForcedActivation,
  writeActiveStamp,
} from './sw-rescue';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    // #182: never intercept Firebase Hosting's reserved /__/* namespace — the
    // Google sign-in popup navigates to /__/auth/handler on this same origin,
    // and serving the SPA shell there dead-ends sign-in for every SW-controlled
    // signed-out client.
    denylist: [/^\/__\//],
  }),
);

// #363: proof media are immutable Storage objects, so CacheFirst. Status 0 is
// allowed because <img> loads are no-cors and those cross-origin responses are
// opaque — omitting it would silently cache nothing.
registerRoute(
  PROOF_MEDIA_URL_PATTERN,
  new CacheFirst({
    cacheName: PROOF_MEDIA_CACHE_NAME,
    plugins: [
      new ExpirationPlugin({
        maxEntries: PROOF_MEDIA_CACHE_MAX_ENTRIES,
        maxAgeSeconds: PROOF_MEDIA_CACHE_MAX_AGE_SECONDS,
        purgeOnQuotaError: true,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// #178: the friendly path. `registerType: 'prompt'` means this worker waits,
// and `UpdatePrompt`'s Reload button is what releases it. Unchanged, and still
// the DEFAULT — the rescue below only ever fires on an armed floor.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: unknown } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// --- The rescue (#514) ------------------------------------------------------
//
// In-memory MIRROR of the persisted decision, not the source of truth (Codex P1
// on #515). The lifecycle permits the browser to tear the worker down between
// `install` and `activate`, and module state does not survive that — losing the
// decision would leave `skipWaiting()` done but the claim-and-navigate skipped,
// so the reload that DISCOVERED the update finishes on the old broken shell and
// the stranded player has to reload a second time. That is the dead end this
// whole PR exists to end, so the decision is persisted in `gcb-shell-meta` and
// this flag only covers the case where storage refused the write.
let forcedActivation = false;

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      try {
        // Start from a clean slate (Phase 4b P2 on #515). A discarded
        // installation is retried from the IDENTICAL script, so a marker left
        // by a previous attempt carries this same `__BUILD_STAMP__` and the
        // stamp binding cannot tell the two apart. If the floor were disarmed
        // in between, this attempt would decline to force and still inherit the
        // earlier marker — turning an ordinary activation into a forced
        // claim-and-navigation of every open tab. Each attempt re-earns it.
        await clearForcedActivation(caches);
        const [floor, activeStamp] = await Promise.all([
          // Retried: this worker gets exactly one `install`, and a waiting
          // worker never gets another (Phase 4b P1 on #515).
          fetchFloorWithRetry(fetch, () => Date.now()),
          readActiveStamp(caches),
        ]);
        if (!shouldForceActivate({ activeStamp, ownStamp: __BUILD_STAMP__, floor })) return;
        forcedActivation = true;
        // Persist BEFORE promoting: once `skipWaiting()` resolves, `activate`
        // can be entered by a worker instance that never ran this handler.
        await markForcedActivation(caches, __BUILD_STAMP__);
        await self.skipWaiting();
      } catch {
        // Install must never fail on account of the rescue: a worker that
        // cannot install is a worker that can never rescue anyone.
      }
    })(),
  );
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      // Consume the persisted decision FIRST — it is the source of truth across
      // a worker teardown, and consuming it clears the flag so a later ordinary
      // activation cannot inherit a stale force and re-navigate the player's
      // windows. The module flag is only a fallback for storage refusing us.
      const forced = (await takeForcedActivation(caches, __BUILD_STAMP__)) || forcedActivation;
      // Record what is now in charge, so the NEXT worker can tell whether the
      // shell it is replacing is below a future floor. Written on every
      // activation, not just forced ones — an unrecorded stamp reads as ancient.
      await writeActiveStamp(caches, __BUILD_STAMP__);
      if (!forced) return;
      try {
        await self.clients.claim();
        // Drive the reload from HERE. The whole point is that the page cannot
        // be asked to do anything — it may be showing a blank screen with its
        // React tree already torn down, which is precisely how clients got
        // stranded in the first place.
        const windows = await self.clients.matchAll({ type: 'window' });
        await Promise.all(
          windows.map(async (client) => {
            try {
              await (client as WindowClient).navigate(client.url);
            } catch {
              /* navigation refused (cross-origin, or not controlled) — the
                 player's own next reload still lands on the new shell */
            }
          }),
        );
      } catch {
        /* claim refused — the new shell is active regardless */
      }
    })(),
  );
});
