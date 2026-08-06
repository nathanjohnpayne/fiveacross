---
spec_id: w0-type-contract
status: accepted
---

# Domain type contract (`src/types.ts`)

`src/types.ts` is the single shared domain contract: every Firestore document type flows through it into the converters, hooks, and components. This spec pins the Phase-0 reconciliation of that contract to the accepted ADRs and the greenfield social types the Wave-2 tickets consume. It is exercised by `src/data/w0-type-contract.test.ts` (unit) and `npm run typecheck`.

## Claim Mode is a friction/vibe knob, not a trust level (ADR 0001)

The three Claim Modes are a friction/vibe hierarchy, never a trust hierarchy. The mode formerly named `verified` is renamed `admin_confirmed` so the word "verified" stops implying an integrity guarantee the honor-system model does not make. `admin_confirmed` starts a Mark pending until an Admin resolves its Claim—a dispute/ceremony tool, not anti-cheat.

- The `ClaimMode` union is `'honor' | 'proof_required' | 'admin_confirmed'`; no source or comment names the mode "verified". (Enforced by `npm run typecheck` across the type and all seven call sites: `Board.tsx`, `ProofSheet.tsx`, `Admin.tsx`, `data/api.ts`, `data/proofs.ts`, `data/admin.ts`, `game/logic.test.ts`.)

## Legacy Claim Mode reads migrate; writes only emit the current value

Events seeded or written before the rename persist the pre-rename Claim Mode value. Reads must accept it and resolve it to `admin_confirmed` so existing data never hard-breaks; the type no longer admits the old value, so writes can only emit a current one.

- **Given** a raw persisted value of `'verified'` **when** passed through `migrateClaimMode` **then** it resolves to `admin_confirmed`. (Test: "coerces a pre-rename persisted value to admin_confirmed".)
- **Given** a current Claim Mode **when** migrated **then** it passes through unchanged. (Test: "passes current Claim Modes through unchanged".)
- **Given** any input—legacy, current, unknown, or missing—**when** migrated **then** the result is never the legacy value, and unknown/missing inputs default to `honor`. (Test: "never resolves to the legacy value and defaults unknown/missing to honor".)
- **Given** a persisted Event carrying the legacy `claimMode` **when** read through `eventConverter` **then** `claimMode` is `admin_confirmed` and every other field is preserved. (Tests: "reads a persisted Event with the legacy claimMode as admin_confirmed", "preserves every other field while migrating claimMode".)
- **Given** a migrated Event **when** re-serialized through `eventConverter.toFirestore` **then** `claimMode` is still `admin_confirmed`—no write re-introduces the legacy value. (Test: "re-serializing a migrated Event never re-introduces the legacy value".)

## Dead config removed (ADR 0004)

`EventDoc.settings.blackoutEnabled` was dead config and is removed from the type; `reportHideThreshold` stays (it is load-bearing for reactive moderation).

- No TypeScript source references `blackoutEnabled`. (Enforced by `npm run typecheck`; the `baseEvent` fixture in the unit test constructs `settings` without it, so a re-introduction fails to compile. `scripts/seed.mjs` still seeds it and is out of scope here—handled by `w1-event-seed`.)

## Greenfield social types added (ADR 0002)

The Wave-2 tickets import these types rather than editing `src/types.ts`, so the shapes are defined here once.

- `TallyEntry` (uid + displayName + markedAt) and `TallyDoc` (itemId + count + attributed `markers` list) model the public, attributed per-Prompt Tally. (Test: "TallyEntry + TallyDoc model an attributed per-Prompt marker list plus count".)
- `DoubtDoc` models one Player asking another to back up a marked Prompt, with `satisfied*` fields tracking open vs answered without ever gating play. (Test: "DoubtDoc models an ask-for-proof carrying open/answered state".)
- `MomentDoc` carries a `kind` of `'bingo' | 'blackout' | 'first_bingo'` and no attached evidence. (Test: "MomentDoc carries a kind but no attached evidence".)
- `UserDoc.attestedAdultAt?` (ms epoch) records the honor-system 18+ self-attestation. (Test: "UserDoc carries the optional 18+ attestation timestamp".)
