---
spec_id: w2-banned-uids
status: accepted
---

# w2-banned-uids—rules-owned Admin ban (typed contract + event-doc write path)

The Admin ban #37 assumed had no surface anywhere in the repo (`firestore.rules` had no ban write, `src/types.ts` had no ban field, and `users/{uid}` is owner-only). PR #107 deferred it here; #113 lands the **rules + type contract only**—no client consumers (`banUser`/`unbanUser`, the Admin control, and the presentational read-hook filter are the #108 follow-up).

Because `firestore.rules` is a protected path (`.github/review-policy.yml` `external_review_paths`), this follows the #18/#103 convention: rules changes land in their own dedicated, reviewed (`needs-phase-4`) PR—never smuggled into a feature-consumer ticket.

## The approved design (human-decided, overriding #108's subcollection idea)

`bannedUids: string[]` on `EventDoc`—a **presentational, event-scoped hide/mute** roster, **NOT hard access revocation**. Per ADR 0004 the Phase 0 hide is client-side and bypassable by design; a follow-up (#108) will filter a banned Player's content client-side, mirroring the `reportHideThreshold` auto-hide. Server-authoritative enforcement (blocking a banned uid's writes/reads) is a separate #43/#44 problem and is **explicitly out of scope** here.

The ban lives on the **already admin-writable event doc**, deliberately **not** on `users/{uid}`, which stays owner-only. Bolting an admin-writable ban field onto `users/{uid}` (or the untyped `players/{uid}`) would be schema-smuggling—opening a foreign-profile write path—not a real fix. Keeping the roster on the event doc reuses the existing `isAdmin(eventId)` gate and touches no owner-only surface.

## The contract

- `src/types.ts`—`EventDoc.bannedUids: string[]`, **required** so consumers never branch on `undefined`. Documented as presentational event-scoped hide/mute (ADR 0004 Phase 0), maintained admin-side, never a server access gate.
- `src/data/converters.ts`—`eventConverter` defaults a **missing or malformed (non-array)** `bannedUids` to `[]`, so event docs seeded/written before #113—**and every freshly-created event**, since the seed never writes the field (see below)—read as `[]`. Writes only ever emit a real array.
- `scripts/seed.mjs`—**does NOT write `bannedUids`.** The event write is `{ merge: true }` and the seed is documented as safe to re-run (to add admins / refresh prompts), so writing `bannedUids` from the seed would reset a populated ban roster back to `[]` on every reseed once #108 fills it—silent data loss (unbanning everyone) on a routine op (Codex P2, PR #119 round 1). Omitting it means a brand-new event never carries the field and reads `[]` via the converter default above, while a reseed leaves the live `bannedUids` untouched because the merge write never mentions it. `banUser`/`unbanUser` (#108) are the only writers, via `arrayUnion`/`arrayRemove`.

## The rules (firestore.rules—the event doc)

`bannedUids` is validated on any admin `create`/`update` that carries it, composed with the existing `settings.reportHideThreshold` guard on the same `events/{eventId}` rule:

- **Admin-only**—the whole event `create`/`update` is gated by `isAdmin(eventId)` (the event's `admins` membership); non-admins are denied outright, so every other config field stays protected too.
- **is a LIST**—a scalar or map `bannedUids` is rejected.
- **SIZE-CAPPED at 1000**—`bannedUids.size() <= 1000`. The cap is a runaway/abuse guard, not an expected-size limit: `banUser` (#108) appends one uid at a time, and a real event roster is far below 1000. It bounds the single event doc well under Firestore's 1 MiB document limit and keeps every admin config write cheap to validate.
- **DISJOINT from `admins`**—`!bannedUids.hasAny(admins)`: a banned uid may never also be an admin, so a ban cannot silently target a co-admin. `admins` here is the **resulting** roster in the same write.

The rule validates the **resulting** `bannedUids` field state, **not** the diff, so an `arrayUnion`/`arrayRemove` **partial** update—what `banUser`/`unbanUser` (#108) will use so a ban write never clobbers other event config—is accepted without requiring the whole doc be rewritten.

**Residual (accepted):** Firestore rules cannot iterate a list, so **per-element string-typing** of `bannedUids` is not expressible in the rules. The `is list` + size cap + `admins`-disjoint checks bound the abuse surface, and the #108 writer supplies real uids. Like all Phase 0 moderation this is presentational and bypassable by design (ADR 0004); tamper-proof, server-authoritative enforcement is #43/#44.

## Claim → test

Basename-aligned to this spec (`specs/w2-banned-uids.md` → `tests/rules/w2-banned-uids.test.ts`, matched by `check_spec_test_alignment` via `test_globs: tests/**`).

### Rules—the ban surface

Runner: `npm run test:rules` (Firestore emulator). Test: `tests/rules/w2-banned-uids.test.ts`.

- An Admin sets `bannedUids` with a whole-doc update—**allowed**.
- An Admin bans via an **`arrayUnion`**-shaped partial update—**allowed**, and other event config (`name`, `settings`) is left intact (validates the resulting state, not the diff).
- An Admin unbans via an **`arrayRemove`**-shaped partial update—**allowed**.
- A **non-admin** cannot write `bannedUids`—by whole-doc set or `arrayUnion`—**denied**.
- A **non-list** `bannedUids` (a scalar, a map)—**denied**.
- The roster is **capped**: 1000 is allowed, 1001 is **denied**.
- A `bannedUids` that **overlaps `admins`** (a banned uid that is also an admin), by set or `arrayUnion`—**denied**.
- `users/{uid}` stays **owner-only**: an Admin cannot create or update a foreign profile to carry `banned`/`bannedUids`—**denied** (the anti-schema-smuggling guarantee).

### Type contract—the converter default

Runner: `npm test` (Vitest). Test: `src/data/w0-type-contract.test.ts`.

- `eventConverter` defaults a **missing** `bannedUids` (legacy pre-#113 event doc) to `[]`.
- `eventConverter` preserves a present roster and coerces a **malformed** (non-array) value to `[]`.

### Seed—the reseed must never clobber a live ban list

Runner: `npm test` (Vitest). Test: `src/test/w1-event-seed.test.ts`.

- The seed **does NOT write `bannedUids`**—`EVENT_SEED` lacks the field and `eventWritePayload()` (with or without admins) never emits it, so a `{ merge: true }` reseed cannot reset a populated roster to `[]`. A fresh event reads `[]` via the converter default instead (`src/data/w0-type-contract.test.ts`).

## Out of scope (the #108 console follow-up this unblocks)

`banUser`/`unbanUser` in `src/data/admin.ts` (via `arrayUnion`/`arrayRemove`), a ban control in `Admin.tsx`'s report queue, and the presentational banned-content filter in the read hooks (`src/hooks/useData.ts`), mirroring the landed `isReportHidden` auto-hide. No leaderboard/first-bingo change. This PR is the rules + type contract only.

## Acceptance criteria

- `EventDoc.bannedUids: string[]` is a required, documented presentational hide/mute field; the converter defaults a missing legacy value to `[]`—`src/data/w0-type-contract.test.ts`.
- `firestore.rules` lets an Admin write `bannedUids` on the event doc (set and `arrayUnion`/`arrayRemove`), denies non-admins, and validates list / size-cap (`<= 1000`) / `admins`-disjoint—`tests/rules/w2-banned-uids.test.ts`.
- `users/{uid}` stays owner-only; no admin write path was opened into a foreign profile—`tests/rules/w2-banned-uids.test.ts` (and pinned in `tests/rules/w2-admin-console.test.ts`).
- Server-authoritative ban enforcement is deferred to #43/#44; client consumers to #108—this spec.
