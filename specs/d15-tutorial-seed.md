---
spec_id: d15-tutorial-seed
status: accepted
---

# Tutorial pools + itinerary seed (`d15-tutorial-seed`)

Seeds the two curated tutorial pools (embark, farewell) and the ten-Day itinerary mapping that drives the whole daily-cards feature's unlock/theme/pool machinery, implementing `plans/daily-cards-spec.md` § "Tutorial item lists", the `days[]` row of § "Itinerary and schedule", and the per-day override half of § "Free space per day". Depends on `d15-schema-contract` (`ItemDoc.pool`, `DayDef`, `EventDoc.timezone`/`days[]`) — this ticket populates that contract with content, it does not extend it. Guarded by `src/data/d15-tutorial-seed.test.ts` (Vitest unit, pure data) and `tests/rules/w1-seed-and-composition.test.ts` (rules-emulator, live write/read).

## Contract

- `src/data/seed.ts` — adds `EASY_ITEMS` and `CLOSING_ITEMS`, each `{ text: string; spicy: false; pool: 'embark' | 'farewell' }[]`, 28 entries, seeded verbatim in the spec's given order from daily-cards-spec § "Tutorial item lists". Both pools are unstratified (all tame — no spicy split), matching the spec's decision that tutorial pools carry no 🔞 tag. Adds `DAYS: DayDef[]`, the ten-Day itinerary mapping (index 0-based) from daily-cards-spec § "Itinerary and schedule": date, port, portEmoji, theme, pool, tutorial, and `unlockAt` (ms epoch). `unlockAt` is 08:00 Europe/Rome (CEST, UTC+2 for the whole July sailing window) on `date` for every Day except index 0 — the spec's one exception, the embark tutorial Day, which is unlocked "from the moment the Event opens" rather than at a fixed clock time. There is no separate "event open" timestamp in the current data model, so index 0 seeds `unlockAt: 0` (epoch) as the resolved default: `unlockAt <= now` is true for any real clock value, so the Day reads as unlocked immediately, matching "live pre-cruise" without inventing a new field. The two `freeText` overrides (daily-cards-spec § "Free space per day") land on exactly index 0 (`'You made it aboard'`) and index 9 (`'We had the best damn time'`); every other Day has no `freeText` and falls back to the existing global `FREE_TEXT`.
- `scripts/seed.mjs` — mirrors `EASY_ITEMS`/`CLOSING_ITEMS` as separate literals (the same no-cross-module-import convention `ITEMS` already follows for the main pool) and mirrors `DAYS` as `EVENT_SEED.days` plus `EVENT_SEED.timezone: 'Europe/Rome'`. Adds `ALL_ITEMS = [...ITEMS, ...EASY_ITEMS, ...CLOSING_ITEMS]`, the combined write-time pool; `seedItemMutations` now defaults its `pool` parameter to `ALL_ITEMS` (an entry's own `pool` tag wins, an untagged main-pool entry defaults to `'main'`) so a fresh seed writes all three pools with `status: 'active'` in one atomic batch — curated pools have no submission/approval flow (daily-cards-spec § "Item pools and the approval flow"), so they skip the `pending` state entirely. `verifySeedPool` gains the same tag-aware default so the post-seed self-check and `--verify` drift check cover all three pools, not just `main`.
- **Frozen, untouched:** the 80-entry main pool (`SEED_ITEMS`/`ITEMS`) and its content — this ticket adds two pools alongside it, it does not touch the main pool's content or the drift-check contract for `main` specifically (the drift check itself is widened to also cover the two new pools, per the ticket's Tests-to-add).

## Resolved defaults (no open decisions)

- **Index-0 `unlockAt`**: seeded as `0` (epoch), per the "index 0 exception" note above — there is no dedicated "event open" timestamp field to reference, and `0` is the simplest value that always satisfies `unlockAt <= now`.
- **CEST offset**: computed as a fixed `+02:00` for every date in the July 15–24 window (daily-cards-spec § "Itinerary and schedule" confirms every port is CEST for the whole sailing — no ship-clock drift handling needed), rather than deriving the offset from an IANA timezone library at seed time.

## Acceptance criteria

- **Given** the seed script runs on a fresh Event **When** it completes **Then** `events/{id}/items` holds 28 active `embark` Prompts and 28 active `farewell` Prompts, verbatim from the spec, in addition to the existing 80 `main` Prompts — 136 total, none `pending`. (Test: "fresh seed writes exactly 80 active main prompts + 28 active embark + 28 active farewell prompts, all boolean spicy".)
- **Given** the seeded `EventDoc` **When** read **Then** `timezone === 'Europe/Rome'` and `days.length === 10`, each row matching the itinerary table (date, port, portEmoji, theme, pool, tutorial, freeText where specified). (Tests: "matches the itinerary table field-for-field"; "seeds a 10-entry days\[\] matching src/data/seed.ts DAYS exactly".)
- **Given** a pool change to the curated lists lands and is deployed **When** `npm run verify:seed` is run **Then** it reports drift until the seed script is actually re-run against the live project (deploy ≠ reseed). (Covered by the existing `verifySeedPool`/`formatDriftReport` machinery, now scoped to `ALL_ITEMS`.)
- Both curated lists are seeded verbatim, in order, with the correct `pool` tag. (Tests: "has exactly 28 entries, all tame, all tagged pool: embark/farewell".)
- The two `freeText` overrides are seeded on exactly Day 0 and Day 9. (Test: "carries the two freeText overrides on exactly Day 0 and Day 9, and none elsewhere".)
- `scripts/seed.mjs`'s mirrored literals stay in sync with `src/data/seed.ts`, asserted by test. (Tests: "exports the same 28-entry EASY_ITEMS/CLOSING_ITEMS as src/data/seed.ts"; "seeds a 10-entry days\[\] matching src/data/seed.ts DAYS exactly".)

## Test coverage

`src/data/d15-tutorial-seed.test.ts` (Vitest, pure-data unit — no Firebase, no emulator): pool sizes/tagging/no-duplicates for `EASY_ITEMS`/`CLOSING_ITEMS`, no cross-pool or main-pool text collisions, the `DAYS` itinerary field-for-field, the `unlockAt` rule (index 0 = `0`, every other index = 08:00 Europe/Rome on `date`), the two `freeText` overrides, and the `scripts/seed.mjs` mirror/sync checks for both the tutorial pools and `EVENT_SEED.timezone`/`days`.

`tests/rules/w1-seed-and-composition.test.ts` (Vitest + Firestore rules emulator): a fresh seed writes exactly 136 seed-owned docs split 80/28/28 across `main`/`embark`/`farewell`, all `active`, and `verifySeedPool` against the live emulator confirms no drift when run against `ALL_ITEMS`.
