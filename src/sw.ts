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
  dueForFloorRecheck,
  fetchFloorWithRetry,
  recordFloorCheck,
  markForcedActivation,
  pruneClientStamps,
  readActiveStamp,
  recordClientStamp,
  shouldActiveWorkerEvict,
  shouldForceActivate,
  shouldNavigateClient,
  takeForcedActivation,
  writeActiveStamp,
} from './sw-rescue';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// --- The active-worker floor re-check (#515 Phase 4b P1; rewired by #517) ----
//
// REGISTERED BEFORE WORKBOX, AND THAT ORDERING IS THE WHOLE FIX. A `fetch`
// listener added AFTER workbox`s router never receives navigation events at
// all: once the router calls `event.respondWith()`, the browser stops
// dispatching that request to later listeners. Requests workbox does NOT handle
// still arrive, which is why the original placement looked like it worked —
// instrumenting the deployed worker showed it seeing `cors` and `no-cors` and
// never once `navigate`, so the re-check silently never ran in production
// (#517). Moving the registration above `precacheAndRoute` is what makes
// navigations visible; `sw-worker.test.ts` pins the order so it cannot drift.
//
// Why this event at all: a worker has no timers that survive termination, so
// the re-check rides the navigation an ordinary reload already produces. It
// never calls `respondWith`, so routing is untouched — workbox still serves the
// request — and it is throttled by a PERSISTED timestamp, because a worker is
// killed whenever it goes idle and an in-memory throttle would reset constantly.
//
// Why the re-check is needed: without it the floor lever only works paired with
// a redeploy. A worker installs, reads the floor — inert, which is what it ships
// as, so this is the normal case for every client — and settles into `waiting`.
// Arming the floor afterwards changes nothing, because later update checks find
// the same byte-identical `sw.js` and never dispatch `install` again, and a dead
// page cannot message the waiting worker. #342 built `build-floor.json`
// precisely so the emergency lever would NOT require a deploy.
self.addEventListener('fetch', (event: FetchEvent) => {
  if (event.request.mode !== 'navigate') return;
  event.waitUntil(maybeRecheckFloor());
});

async function maybeRecheckFloor(): Promise<void> {
  try {
    if (!(await dueForFloorRecheck(caches, Date.now()))) return;
    const floor = await fetchFloorWithRetry(fetch, () => Date.now(), { attempts: 1 });
    // Record the OUTCOME, not merely the attempt: a failed read backs off for a
    // minute, a successful one for the full interval, so one transient failure
    // on the first navigation of an incident cannot silence every reload for
    // half an hour.
    await recordFloorCheck(caches, Date.now(), floor !== null);
    if (!shouldActiveWorkerEvict(__BUILD_STAMP__, floor)) return;
    try {
      // ALWAYS evict; never promote a waiting worker. This worker cannot read
      // that worker`s build stamp, so a floor newer than both would swap one
      // condemned build for another — and the replacement would inherit the
      // throttle record just written. Going to the network sidesteps the
      // comparison: whatever is deployed is necessarily at or above the floor.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('workbox-precache')).map((k) => caches.delete(k)));
      await self.registration.unregister();
    } catch {
      // Roll the throttle back to the short failure interval so the very next
      // navigation retries, instead of waiting out the success window.
      await recordFloorCheck(caches, Date.now(), false);
    }
  } catch {
    /* a floor re-check must never interfere with serving the page */
  }
}

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
//
// #605 adds the second message: a WAITING worker answers with its own build
// stamp so the page can tell one waiting build from another. Nothing else can
// tell them apart — every worker is served from `/sw.js`, so `scriptURL` is
// identical and the stamp only exists inside the script — and without that
// identity "Not now" could only be a session-long or a permanent dismissal,
// never a per-build one. The reply goes back on the caller's `MessagePort`
// (`event.ports[0]`), so it reaches the asking page and no other client.
//
// The two message names are spelled out here rather than imported from
// `src/updateDismissal.ts` (which holds the page half of this contract) because
// the worker is a SEPARATE typecheck program — `tsconfig.sw.json`, `WebWorker`
// lib, no `localStorage` — so importing that module would drag DOM-only globals
// into a program that cannot type them. `sw-worker.test.ts` pins both names.
//
// #516 adds the third message, in the other direction: a page names the build
// it is EXECUTING, at module scope, before it renders anything. The record this
// keeps is what lets the rescue tell the served shell apart from what each tab
// is actually running — see `shouldForceActivate`. Same spelled-out-name
// convention as above; the page half is `src/swClientBridge.ts`.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: unknown; stamp?: unknown } | null;
  const type = data?.type;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
  else if (type === 'GET_BUILD_STAMP') {
    // Best-effort: a caller that sent no port gets no answer, which the page
    // reads as "unidentifiable" and treats as fail-open (src/updateDismissal.ts).
    event.ports?.[0]?.postMessage({ type: 'BUILD_STAMP', stamp: __BUILD_STAMP__ });
  } else if (type === 'CLIENT_BUILD') {
    const source = event.source;
    const id = source && 'id' in source ? source.id : null;
    const stamp = data?.stamp;
    if (!id || typeof stamp !== 'string' || stamp === '') return;
    event.waitUntil(registerClientBuild(id, stamp));
  }
});

async function registerClientBuild(clientId: string, stamp: string): Promise<void> {
  try {
    await recordClientStamp(caches, clientId, stamp, await liveWindowIds());
  } catch {
    /* an unrecorded client reads as condemned, which is the safe direction */
  }
}

/** Every open window's id, or null when the list cannot be read at all —
 *  `retainLiveClients` treats those two very differently. `includeUncontrolled`
 *  because an installing worker controls nothing yet, and the whole point of
 *  this registry is the tabs it does not yet own. */
async function liveWindowIds(): Promise<string[] | null> {
  try {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return windows.map((client) => client.id);
  } catch {
    return null;
  }
}

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
let forcedActivation: { forced: boolean; floor: string | null } = { forced: false, floor: null };

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
        const [floor, activeStamp, clientStamps] = await Promise.all([
          // Retried: this worker gets exactly one `install`, and a waiting
          // worker never gets another (Phase 4b P1 on #515).
          fetchFloorWithRetry(fetch, () => Date.now()),
          readActiveStamp(caches),
          // Swept here too, so a tab closed long ago cannot keep the decision
          // anchored to a build nothing is running any more (#516).
          liveWindowIds().then((ids) => pruneClientStamps(caches, ids)),
        ]);
        // `registration.active` is null only on a FIRST install, where there
        // is no shell to rescue — without this a fresh client would claim and
        // re-navigate a page already running the current build (Phase 4b P2).
        const hasActiveWorker = self.registration.active !== null;
        const force = shouldForceActivate({
          activeStamp,
          ownStamp: __BUILD_STAMP__,
          floor,
          hasActiveWorker,
          clientStamps: Object.values(clientStamps),
        });
        if (!force) return;
        forcedActivation = { forced: true, floor };
        // Persist BEFORE promoting: once `skipWaiting()` resolves, `activate`
        // can be entered by a worker instance that never ran this handler. The
        // floor rides along so `activate` can tell which windows it condemns.
        await markForcedActivation(caches, __BUILD_STAMP__, floor);
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
      const persisted = await takeForcedActivation(caches, __BUILD_STAMP__);
      const decision = persisted.forced ? persisted : forcedActivation;
      // Record what is now in charge, so the NEXT worker can tell whether the
      // shell it is replacing is below a future floor. Written on every
      // activation, not just forced ones — an unrecorded stamp reads as ancient.
      await writeActiveStamp(caches, __BUILD_STAMP__);
      if (!decision.forced) return;
      try {
        await self.clients.claim();
        // Drive the reload from HERE. The whole point is that the page cannot
        // be asked to do anything — it may be showing a blank screen with its
        // React tree already torn down, which is precisely how clients got
        // stranded in the first place.
        const windows = await self.clients.matchAll({ type: 'window' });
        // Only the windows the floor actually condemns (#516). A tab that has
        // already reloaded onto an accepted build is left alone: navigating it
        // would discard whatever the player is doing there and rescue nobody.
        const stamps = await pruneClientStamps(
          caches,
          windows.map((client) => client.id),
        );
        const targets = windows.filter((client) => shouldNavigateClient(stamps[client.id], decision.floor));
        await Promise.all(
          targets.map(async (client) => {
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
