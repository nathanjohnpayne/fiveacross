---
spec_id: auth-profile-race
status: accepted
---

# Race: AuthContext publishes User before ensureUserProfile settles (#77)

`AuthContext` (`src/auth/AuthContext.tsx`) publishes the signed-in `user`—and the app renders—before it awaits `ensureUserProfile` (`src/data/api.ts`). The issue (#77, split out of PR #67 by human tiebreak on Codex round-3 P2 finding 3542395225) worried that a fast, user-initiated profile save could race that delayed initial create and be clobbered, because `ensureUserProfile`'s create path was a NON-merge `setDoc` that replaced the whole `users/{uid}` row with the Google-sourced defaults.

## Assessment: what already closed, what remained

Two independent hardenings landed after the issue was filed, and each closes one half of the race:

- **The clobber (half a) is closed by the transaction.** `ensureUserProfile` now runs inside a `runTransaction` whose read of `users/{uid}` is create-only: `if (snap.exists()) return;` before `tx.set` (`src/data/api.ts`). Firestore's optimistic concurrency makes this safe even when a save lands mid-flight: the transactional read is part of the commit check, so a save that writes the doc after this read saw it absent invalidates the commit, Firestore re-runs the whole function, and the retry re-reads the now-existing doc and no-ops. The Google-sourced create can therefore never overwrite a save that landed first.
- **The ProfileEditor half (b) is closed by a server-confirmed-snapshot gate.** `ProfileEditor` (merged in #67) does not render its edit trigger until the live `users/{uid}` subscription reports `hasServerData` (a server-backed, non-`fromCache` snapshot—`src/hooks/useData.ts`), and its writes go through `data/profile.ts` merge `setDoc`. So it never seeds or saves the Google-name fallback over a saved custom name that simply had not arrived yet.

What remained is the ordering contract the issue names in its title. `loading` is the only "bootstrap settled" signal AuthContext exposed, and it covers only the FIRST auth callback: on a popup sign-in or an account switch it is already `false` while the newly-published User's `ensureUserProfile` is still in flight. There was no per-auth-change signal a profile-writing consumer could gate on to know the `users/{uid}` bootstrap had settled—the issue's own suggested fix ("AuthContext exposing a profileReady signal"). This spec adds that signal. It does not change `ensureUserProfile`'s logic (the transaction is already correct) and does not gate `ProfileEditor` (its `hasServerData` gate already closes its half; a `profileReady` gate there would be redundant).

## `ensureUserProfile` is create-only and never overwrites an existing row

The create path is pinned so a regression back to a non-merge `setDoc` (the original bug) fails loudly. Tested against a mocked Firestore that models the transactional read + optimistic-concurrency retry.

- **Given** a `users/{uid}` row already exists (a save landed first) **when** `ensureUserProfile` runs **then** the transaction reads existence and no-ops—`tx.set` is never called. (Test: "no-ops when the profile row already exists—a racing save is never clobbered".)
- **Given** no `users/{uid}` row exists yet **when** `ensureUserProfile` runs **then** it creates exactly `{ displayName, photoURL, createdAt }` from the auth User, defaulting a missing name to `Anonymous` and a missing photo to `null`. (Test: "creates the row from the Google-sourced defaults when it is absent".)
- **Given** the create attempt read the row as absent but a user save then lands, forcing Firestore to re-run the transaction **when** the retried attempt reads the now-existing row **then** it no-ops, so the saved row survives. (Test: "no-ops on the optimistic-concurrency retry after a save lands mid-transaction".)

## AuthContext exposes a `profileReady` bootstrap-settled signal

`profileReady` is `false` from the moment a signed-in User is published until THAT User's `ensureUserProfile` settles, and it re-arms on every auth change.

- **Given** a User has just signed in **when** `ensureUserProfile` is still in flight **then** `profileReady` is `false`, and **when** it settles **then** `profileReady` is `true`. (Test: "is false while ensureUserProfile is in flight and true once it settles".)
- **Given** an account switch while the first account's bootstrap is still in flight **when** the retired account's `ensureUserProfile` resolves later **then** it does not flip `profileReady` true for the account that replaced it; only the current account's own settle does. (Test: "re-arms on an account switch and a retired bootstrap cannot settle the new account".)
- **Given** a consumer that gates a profile save on `profileReady` **when** the bootstrap has not settled **then** the save cannot fire, and **when** it settles **then** the save is enabled. (Test: "a consumer gated on profileReady cannot save before the bootstrap settles".)
