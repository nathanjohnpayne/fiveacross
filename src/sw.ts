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
import { fetchFloorInWorker, readActiveStamp, shouldForceActivate, writeActiveStamp } from './sw-rescue';

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
// Set during `install` and read during `activate`. Module state is safe across
// that pair in a single worker lifetime; if the browser tears the worker down
// in between, this resets to false and we simply skip the claim-and-navigate.
// That degrades to "the new shell is active, and the player's next reload lands
// on it" — still a rescue, just not an instant one.
let forcedActivation = false;

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      try {
        const [floor, activeStamp] = await Promise.all([
          fetchFloorInWorker(fetch, Date.now()),
          readActiveStamp(caches),
        ]);
        if (!shouldForceActivate({ activeStamp, ownStamp: __BUILD_STAMP__, floor })) return;
        forcedActivation = true;
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
      // Record what is now in charge, so the NEXT worker can tell whether the
      // shell it is replacing is below a future floor. Written on every
      // activation, not just forced ones — an unrecorded stamp reads as ancient.
      await writeActiveStamp(caches, __BUILD_STAMP__);
      if (!forcedActivation) return;
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
