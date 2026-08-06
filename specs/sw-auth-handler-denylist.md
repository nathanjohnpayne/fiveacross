---
spec_id: sw-auth-handler-denylist
status: accepted
---

# Service worker must never intercept Firebase's reserved `/__/*` namespace (`src/sw.ts` navigation-route `denylist`)

Google sign-in was broken for any signed-out visitor whose page was service-worker-controlled (#182): `signInWithPopup` (`src/auth/AuthContext.tsx`) opens a popup at `https://gaycruisebingo.com/__/auth/handler?...`—Firebase Hosting's reserved OAuth helper—and that popup is a same-origin navigation, so Workbox's `navigateFallback: 'index.html'` route intercepted it and served the precached SPA shell instead of the handler. The popup rendered the app's own SignIn screen, the OAuth dance never started, and sign-in silently dead-ended. Reproduced against production in a fresh service-worker-controlled profile; `curl` of the same URL (no service worker) returned the real `fireauth.oauthhelper` page, proving the hosting/proxy posture was fine and the interception was purely client-side.

The fix is the canonical Firebase-on-Workbox exclusion: a `denylist: [/^\/__\//]` on the navigation route, which keeps the navigation-fallback route from ever matching Firebase's reserved `/__/*` paths (`/__/auth/handler`, `/__/auth/iframe`, …). Everything else about the fallback (offline shell for real app routes) is unchanged.

**Moved by #514.** This lived in the `VitePWA` `workbox` block in `vite.config.ts` while the worker was generated. #514 switched to `injectManifest` so the worker could carry install-time rescue logic, which moved the navigation route—denylist included—into the hand-written `src/sw.ts`. The protection is unchanged in substance, but it is now ordinary code rather than a config key, so the guarding test asserts the denylist is attached to the `NavigationRoute` itself and that `vite.config.ts` no longer declares a competing `navigateFallback`.

## Regression guard

- **Given** the service worker source **when** it registers the navigation route **then** that route must carry a `denylist` containing the `/^\/__\//` pattern, so a future edit cannot silently reintroduce the interception. The assertion is scoped to the route's own options, not merely the file, because a `denylist` sitting anywhere else would satisfy a naive substring check while protecting nothing. (Test: `src/sw-auth-handler-denylist.test.ts`—reads `src/sw.ts` the same way `src/data/w4-bug-report-client.test.ts` reads `firebase.json`, because the built `sw.js` only exists post-build and jsdom cannot execute a service worker.)
- **Given** `vite.config.ts` **when** the worker is built **then** it must declare `strategies: 'injectManifest'` and no `navigateFallback`, so a half-finished revert cannot leave both sources in play with the config key silently winning. (Same test.)
- Build-output verification (manual, per fix PR): the built `dist/sw.js` carries the denylist regex on its `NavigationRoute`—checked by grepping the emitted worker after `npm run build`.
- Live verification (manual, post-deploy): with the service worker active, the sign-in popup at `/__/auth/handler` renders Google's account chooser, not the SPA.

## Rollout note

The fix only takes effect once deployed and each installed service worker updates (next `registration.update()`—at most 60s in an open tab via `UpdatePrompt`'s periodic check, `specs/app-update-reload-prompt.md`, or the next full app launch). Until a stale worker updates, sign-in in that profile remains broken; no data migration or cache purge is needed beyond the normal worker swap.
