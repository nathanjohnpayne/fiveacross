---
spec_id: w1-event-seed
status: accepted
---

# Event/pool seed script (`scripts/seed.mjs`)

`scripts/seed.mjs` is the run-once Admin script that establishes `events/{id}` and the dense Prompt pool the Event opens with. This spec pins the Phase-0 reconciliation of the seeded payload to the accepted ADRs: the ADR 0001 Claim Mode rename, the ADR 0003 pool-density requirement, and the ADR 0004 dead-config removal, plus the `ADMIN_UID` roster flow pending decision #15. The seed payload is exported as import-safe constants—seeding runs only when the script is the entry module, so importing it needs neither Firebase credentials nor the dev-only `firebase-admin` install—and every claim below maps to an assertion in `src/test/w1-event-seed.test.ts` (layer: unit).

## Seeded settings match ADR 0004

`settings.reportHideThreshold` is load-bearing (reactive moderation auto-hides a Prompt at the report threshold) and stays at `4` pending final confirmation via #15. The flag ADR 0004 removed as dead config is not seeded—the type dropped it in `w0-type-contract`, and the static seed payload no longer carries fields the contract does not admit. A Firestore `{ merge: true }` write only touches leaf paths present in the payload, though, so omitting the flag is not enough to remove it from an Event doc a previous seed run already wrote it to—the merge write also carries a Firestore delete sentinel (`FieldValue.delete()`) at `settings.blackoutEnabled`, so reseeding actively deletes the stale field instead of leaving it in place.

- **Given** the seed payload **when** `events/{id}` is written **then** `settings` contains `reportHideThreshold: 4`. (Test: "seeds settings.reportHideThreshold at the load-bearing value 4".)
- **Given** the static seed payload **when** inspected **then** `settings` has exactly the `reportHideThreshold` and `spicyRatio` keys (the latter added by `seed-and-composition`, #129, which absorbed and extended this spec's remaining seed-script scope), and the seed source never assigns the removed ADR 0004 flag a literal value. (Tests: "seeds no blackoutEnabled—ADR 0004 removed it as dead config"; "never seeds a literal value for blackoutEnabled—the seed source references it only as the delete target".)
- **Given** an Event doc a previous seed run already wrote `settings.blackoutEnabled` to **when** the seed reruns its `{ merge: true }` write **then** the write payload carries a Firestore delete sentinel at `settings.blackoutEnabled`, so the stale field is actively removed rather than merely omitted. (Test: "marks settings.blackoutEnabled for deletion in the merge write, so re-seeding an Event doc from the previous seed actually removes the stale field".)

## Claim Mode names the post-rename value (ADR 0001)

The seeded `claimMode` stays `'honor'` (the default friction/vibe mode). The mode set documented alongside it uses the post-rename name `admin_confirmed`; no comment or value in the seed names the pre-rename mode (see `w0-type-contract` for why the old name is banned).

- **Given** the seed payload **when** `events/{id}` is written **then** `claimMode` is `'honor'`. (Test: "seeds claimMode 'honor' (the default)".)
- **Given** the seed source **when** scanned **then** the documented mode set is `'honor' | 'proof_required' | 'admin_confirmed'` and the pre-rename name appears nowhere. (Test: "documents the mode set as honor | proof_required | admin_confirmed, never the pre-rename name".)

## ADMIN_UID roster flow (#15)

Admin is the only privileged role, and `events/{id}.admins` is the roster the app trusts. The `ADMIN_UID` env var takes a comma-separated list of uids; the target roster is 2–4 Admins including Nathan's seed uid, with the concrete co-admin uids blocked on decision #15. Because the event write merges and omits `admins` when the roster is empty, the seed can be re-run with the final roster once #15 lands without ever wiping a granted roster in the meantime.

- **Given** an `ADMIN_UID` value **when** parsed **then** it splits on commas, trims each uid, and drops empties (unset/empty parses to an empty roster). (Test: "parses ADMIN_UID as a comma-separated roster, trimming entries and dropping empties".)
- **Given** a 2–4 uid roster including the seed uid **when** the event payload is built **then** the roster is written to `admins` verbatim. (Test: "writes the roster to events/{id}.admins when set (2–4 Admins incl. the seed uid)".)
- **Given** an empty roster **when** the event payload is built **then** `admins` is omitted entirely, so a `merge: true` re-run never wipes an existing roster. (Test: "omits admins entirely when the roster is empty, so a merge re-run never wipes it".)

## Prompt pool density (ADR 0003)

The seed establishes the Prompt pool before the Event opens: `dealBoard` requires ≥ 24 active Prompts. `seed-and-composition` (#129) superseded the original ~30–50 "dense" band with a canonical 80-entry pool (24 spicy / 56 tame, each entry now a `{ text, spicy }` pair rather than a bare string)—a deliberate, larger-than-planned pool accepted for that ticket, not a regression of the density intent (still comfortably above the 24-Prompt floor). Prompt doc ids are content hashes of `text` alone, so duplicate texts would collapse into one doc and silently shrink the pool—seeded texts must be unique. See `seed-and-composition.md` for the full pool-shape and Board-composition contract.

- **Given** the seeded pool **when** counted **then** it has at least 24 entries. (Test: "seeds at least 24 prompts so dealBoard always has a full sample".)
- **Given** the seeded pool **when** counted **then** it is the canonical 80-entry pool. (Test: "seeds the canonical 80-entry pool (w1-seed-and-composition)".)
- **Given** the seeded pool **when** de-duplicated **then** every `text` is unique and non-empty, and every entry's `spicy` is a boolean. (Test: "seeds unique, non-empty prompt { text, spicy } entries—content-hash doc ids (hashed on text) collapse duplicates".)
