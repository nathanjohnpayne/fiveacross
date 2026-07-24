---
spec_id: w2-ga4-events
status: accepted
---

# GA4 event catalog + 18+ consent notice (`src/analytics.ts`, `src/components/ConsentNotice.tsx`)

`src/analytics.ts` owns the GA4 event catalog and the single `track(name, params?)` entry point every call site uses instead of importing `firebase/analytics` directly. This spec pins the completed 12-event PRD set (10 events already fired at their call sites pre-ticket; this ticket adds `demand_proof` and `install_pwa` to the catalog and type) and the lightweight 18+ analytics disclosure that ships alongside it. It is exercised by `src/w2-ga4-events.test.tsx` (unit + RTL-jsdom, covering both `src/analytics.ts` and `src/components/ConsentNotice.tsx`).

## The catalog is the complete, de-duplicated 12-event PRD set (plus one later operational event)

`GA4_EVENTS` enumerates every catalogued event name in one place, and `track()`'s `name` parameter is typed to that union so a call site can only pass a catalogued name.

- **Given** the exported `GA4_EVENTS` catalog **when** read **then** it contains the 12 PRD events plus the operational `login_failed` (added later by #163, defined below), in order — `login`, `login_failed`, `join_event`, `add_item`, `report_item`, `mark_square`, `attach_proof`, `demand_proof`, `bingo`, `blackout`, `theme_change`, `share_click`, `install_pwa` — with no duplicate names. (Test: "enumerates the 12 PRD events plus the operational login_failed (#163)".)

## `login_failed` — operational sign-in-failure event (#163, post-w2)

`login_failed` is an operational observability event, not one of the 12 PRD events; it was added after this ticket by #163. `track('login')` fires only on a _successful_ Google sign-in, and Firebase handler errors render on the OAuth helper page where PostHog is not loaded — so a failed sign-in was previously invisible in analytics. `signIn()` in `auth/AuthContext.tsx` wraps desktop `signInWithPopup` and mobile `signInWithRedirect` startup in `try`/`catch`; app-owned redirect completion also handles `getRedirectResult` rejection. Each rejection fires `track('login_failed', { method: 'google', code })` with an allowlisted Firebase error code or `auth/unknown`; raw provider messages are never sent. Popup/startup errors are rethrown to preserve the caller contract. The params are PII-free, matching the catalog's privacy posture.

- **Given** a Google sign-in **when** the Firebase popup, redirect startup, or redirect completion rejects **then** `track('login_failed', …)` fires with the Firebase error `code` and the success `login` event does not fire. (Popup regression test: "fires track('login_failed', …) with the Firebase error code and rethrows when the popup rejects (#163)", in `src/auth/AuthContext.test.tsx`.)
- **Known gap:** an error rendered only inside Firebase's helper document can still occur before the app reloads and resumes analytics; the sign-in-screen pageview → `login` funnel remains the secondary signal for that case.

## `demand_proof` and `install_pwa` fire through the existing `track()`, not a second path

Both new events are catalog/type additions only — this ticket does not build the Doubt flow (`demand_proof`'s call site, owned by #33) or the install-prompt flow (`install_pwa`'s call site, owned by #30). Both route through the same `track()` any other event uses.

- **Given** a Doubt is raised **when** `track('demand_proof', params)` is called **then** it invokes the underlying `logEvent` with the `demand_proof` name and those params. (Test: "fires demand_proof through logEvent with its params (10 -> 12)".)
- **Given** the PWA install prompt is accepted **when** `track('install_pwa')` is called **then** it invokes `logEvent` with the `install_pwa` name. (Test: "fires install_pwa through logEvent (10 -> 12)".) Both route through the one `track()` implementation every other catalogued name uses — there is no per-event branch to special-case (verified by reading `track()`'s body, not a dedicated per-name test).

## `track()` never throws

`track()` is the single point every feature calls into for analytics, so it must stay a safe no-op regardless of whether GA4 is available or the underlying SDK call fails.

- **Given** `analytics` is unavailable (`null` — unsupported browser, no measurement id, etc.) **when** `track()` is called **then** it does not throw and does not call `logEvent`. (Test: "never throws and never calls logEvent when analytics is unavailable (null)".) The same guarantee holds if the underlying `logEvent` call itself throws, because the call is wrapped in `track()`'s `try`/`catch` (verified by reading the implementation, not a dedicated test for the SDK-throws case).

## The existing 10 events fire with sensible params (verified by source audit, not a new test)

Pre-ticket call sites already exist for the other 10 events and are unchanged by this ticket: `login` (`auth/AuthContext.tsx`, `{ method: 'google' }`), `join_event` (`App.tsx`, no params), `add_item` (`components/ItemPool.tsx`, no params), `report_item` (`components/ItemPool.tsx` + `components/ProofFeed.tsx`, no params), `mark_square` (`components/Board.tsx`, `{ mode, marked }`), `attach_proof` (`components/ProofSheet.tsx`, `{ type }`), `bingo` / `blackout` (`components/Board.tsx`, no params), `theme_change` (`components/ThemeSwitcher.tsx`, `{ theme }`), `share_click` (`components/Celebration.tsx`, `{ surface }`). Every one of these calls `track()` with a name that is a member of `GA4_EVENTS`, so tightening `track()`'s `name` parameter from `string` to `GA4EventName` type-checks against all ten unchanged (enforced by `npm run typecheck`, not a runtime test — a call site with a name outside the catalog would fail to compile).

## 18+ analytics consent notice

A lightweight, dismissible disclosure — not a full consent-management platform and not a gate on analytics itself (`firebase.ts` already loads GA4 unconditionally when supported) — mounted at `src/main.tsx`, a stable, non-frozen mount point outside the auth-gated tree so it is visible even on the signed-out SignIn screen. Copy and region handling are an open decision (#15); this ships that issue's recommended default: a lightweight in-app notice with no region gating.

- **Given** a device that has not dismissed the notice **when** `ConsentNotice` renders **then** it shows disclosure text mentioning both the 18+ audience and analytics. (Test: "renders the 18+ analytics disclosure on first visit".)
- **Given** the notice is showing **when** the Player dismisses it **then** it stops rendering and the dismissal is persisted to `localStorage` so it does not reappear. (Test: "dismisses on click and persists the dismissal to localStorage".)
- **Given** a device that already dismissed the notice **when** `ConsentNotice` mounts again **then** it does not render. (Test: "does not render on a later mount once dismissed".) Separately, if `localStorage` is unavailable (private browsing, quota, etc.), dismissing still hides the notice for the current session rather than throwing, because both `isDismissed()` and `dismiss()` wrap their storage access in `try`/`catch` (verified by reading the implementation, not a dedicated test for the storage-unavailable case).

## Out of scope

Live GA4 DebugView verification of all 12 events against a deployed Firebase project is a manual step outside this repo's automated gates (app analytics is not CI-run) and is not reproducible in a network-isolated, credential-less environment; see the shipping commit's `Verified:` trailer for exactly what was checked here (unit coverage of `track()` plus a source-level audit of the 10 pre-existing call sites) versus what remains a manual follow-up.
