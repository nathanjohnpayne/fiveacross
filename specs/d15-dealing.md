---
spec_id: d15-dealing
status: accepted
---

# Per-Day dealing from the Day Snapshot: no-repeat-across-Event + stratification + snapshot-gated (`d15-dealing`)

Implements `plans/daily-cards-spec.md` § "Unlock mechanics" and § "Data model" (a `BoardDoc` per Day). Before Phase 1.5 the app dealt exactly one Board per Player for the whole Event, once, at join. This ticket makes dealing per-Day: each Day gets its own Day Card, dealt lazily the first time a Player opens the Day at or after its `unlockAt`, drawn only from that Day's frozen Day Snapshot — never a live query against the pool. A Player's deal excludes Prompts already on their earlier Day Cards until the main pool is exhausted (~3⅓ Days), then the exclusion resets. Guarded by `src/game/logic.test.ts` (sampling), `src/data/d15-dealing.test.ts` (the deal gate), and `tests/rules/d15-dealing.test.ts` (the day-scoped write gate).

## Glossary

- **Day Card**: a Player's Board for one Day — the same 5×5 contract as before, now one per Player per Day. "Board" still names the object; "Day Card" is the player-facing name.
- **Day Snapshot**: the frozen list of approved Prompt ids (`DayDef.snapshotItemIds`) captured at a Day's unlock moment by the scheduler (#202). Every deal for that Day draws from the snapshot, so everyone's card reflects the same pool regardless of when they first open it.

## Contract

- **`dealBoard` gains a per-Day sampling mode** (`src/game/logic.ts`). A new optional `opts: DealOptions` carries `excludeIds` (Prompt ids to keep off the card) and `stratify` (false for all-tame tutorial pools). The exclusion is applied before the `MIN_POOL` guard and RESETS — falls back to the full pool — when honoring it would drop the usable pool below `MIN_POOL` (the pool has cycled; repeats resume rather than starving the card). `stratify: false` shuffles the whole pool and takes 24 with no spicy/tame target. The four-arg call site (`joinAndDeal`) is unchanged.
- **`dayDealState` is the single deal gate** (`src/game/logic.ts`). A pure function of `{ unlockAt, snapshotItemIds, now, hasBoard }` returning `locked | waking | ready | dealt`. Both the deal write path and the client read it, so "when do we deal / what do we render" has one source of truth.
- **`dealDayCard(u, dayIndex)` is the per-Day deal write path** (`src/data/api.ts`). It reads the Day's `snapshotItemIds` — never a live `status: 'active'` query — resolves those ids to Prompt text/spicy, excludes the Prompt ids on the Player's earlier Day Cards, and writes `events/{eventId}/days/{dayIndex}/boards/{uid}` plus a merge into `players/{uid}.dayStats[dayIndex]`. It returns `true` only when it dealt a new Day Card; `locked`, `waking`, and an already-dealt Day are all no-ops.
- **Day-scoped Board wiring** (`src/data/paths.ts`, `src/hooks/useData.ts`). `dayBoardRef(dayIndex, uid)` points at the canonical day-scoped path; `useDayBoard`/`useDayCard` subscribe to it and expose the `dayDealState` so a surface can tell `locked` from `waking` from `ready` from `dealt`. The pre-1.5 `useBoard(uid)` keeps its single-Board callers unchanged.

## Acceptance criteria

- Given a Day with `unlockAt` in the future, when a Player opens it, then no Board is dealt and the locked state renders (`dayDealState` → `locked`; rules test denies the write).
- Given a Day whose `unlockAt` has passed but whose `snapshotItemIds` is not yet stamped, when a Player opens it, then the client shows the "waking up" wait state and does not deal from a live query (`dayDealState` → `waking`; `dealDayCard` no-ops).
- Given a Player whose earlier Day Cards already used some of the still-available main-pool Prompts, when their next Day Card is dealt, then none of those Prompts repeat, until the pool is exhausted and the exclusion resets (`dealBoard` `excludeIds`).
- Given a tutorial Day (easy/closing pool) seeded all-tame, when its Day Card is dealt, then the deal succeeds with no stratification starvation (`stratify: false`).
- A Day Card write path never reads the live `items` collection for its pool — only `snapshotItemIds`.
- Re-opening an already-dealt Day Card is a no-op (no re-deal).
