---
spec_id: d15-scoring-aggregates
status: accepted
---

# Event-wide scoring aggregates + per-day honors (`d15-scoring-aggregates`)

Implements `plans/daily-cards-spec.md` § "Scoring and social surfaces". With ten Day Cards, a Player's `PlayerDoc.bingoCount`/`squaresMarked`/`firstBingoAt` root fields stop being one Board's totals and become Event-wide aggregates over `PlayerDoc.dayStats` (one bucket per Day Card, seeded by `dealDayCard` and folded on each Mark). Each Day keeps its OWN daily honor (per-day First to BINGO), while the Event-wide First to BINGO headline is anchored to non-Tutorial Days only. This ticket owns the aggregation logic and the Leaderboard / day-meta surfaces; the scheduled Function triggers that fire the finale beats belong to `d15-scheduler-unlock`, and the finale copy/UI belongs to `d15-finale`.

Per the ticket's **needs-phase-4** posture (ADR 0001 / `specs/recon-recompute-stats.md`): ranking stays client-authoritative — no server-side player-stats recompute Cloud Function is added, and `functions/src/index.ts` is untouched. The per-Day honor's write-once guarantee is enforced by the EXISTING `firestore.rules` create-only-no-update gate on `days/{dayIndex}/meta/{dayIndex}` (shipped by `d15-firestore-rules`), not by a new trigger.

## Contract

- `src/game/logic.ts` — pure aggregation helpers (framework-free, the correctness-critical core):
  - `sumDayStats(dayStats)` — sums `bingoCount`/`squaresMarked` across EVERY Day Card, tutorial Days included (the opening Day's card is real pre-freeze play).
  - `eventFirstBingoAt(dayStats, isTutorialDay)` — the earliest `firstBingoAt` across non-Tutorial Days only; Tutorial Days are excluded even when numerically earliest.
  - `aggregatePlayerStats(dayStats, isTutorialDay)` — the Event-wide root shape `{ bingoCount, squaresMarked, firstBingoAt }` derived from a Player's `dayStats`.
  - `foldDayStat(...)` — the Mark write-path composition: folds `computeMark`'s per-Board result into `dayStats[dayIndex]` and re-derives the summed root, carrying `computeMark`'s `firstBingoAt` OMIT (the #75 unknown-state preserve) through to the `{ merge: true }` write.
  - `tutorialDayIndexSet(days)`, `perDayHonors(players)`, `effectiveCruiseFirstBingoAt(player, isTutorialDay)`, `cruiseFirstBingoUid(players, isTutorialDay)` — the read-surface derivations for the Leaderboard pin and honors strip, with a legacy fallback to the root `firstBingoAt` for a roster that predates Day Cards (no `dayStats`).
  - **Frozen, unchanged:** `comparePlayers`'s tie-break ORDER (bingos desc → squares desc → earliest first-bingo). Only its inputs change (a sum over Day Cards).
- `src/data/api.ts` — `computeMark`/`setMark` fold a Mark into `dayStats[dayIndex]`, then derive the Event-wide root. The Day is the caller's explicit `dayIndex`, else the cached Board's own `dayIndex`, else Day 0 (the single-Board legacy shape, whose one bucket makes the aggregate equal that Board's totals — no behavior change). `setMark` gains optional `dayIndex`/`tutorialDayIndexes`.
- `src/data/dayMeta.ts` (new) — `pinDayFirstBingo(dayIndex, who, at)`, a write-once per-Day honor at `days/{dayIndex}/meta/{dayIndex}`, mirroring `moments.ts`'s offline-queueable, cache-pre-checked, fire-and-forget writes. The per-card blackout Moment that NAMES its Day (deterministic PER-CARD id `${uid}-blackout-d${dayIndex}` on daily events — #267; the day-less `${uid}-blackout` remains the legacy single-board form — immutable per rules) is `moments.ts`'s `broadcastBlackout(who, dayIndex?)` — an optional `dayIndex` on the SAME writer every blackout already goes through (fix/d15-blackout-day-naming), not a second dayMeta.ts writer.
- `src/components/Leaderboard.tsx` — ranks by the aggregated Event-wide totals; the "1st BINGO" pin is Event-wide-restricted (tutorial Days excluded); a per-Day honors strip renders each Day's own First to BINGO.

## Acceptance criteria

- **Given** a Player has marks on 3 different Day Cards, **when** the Event totals are derived, **then** their `bingoCount`/`squaresMarked` are the sum across all 3 Day Cards. (Test: aggregate-sum.)
- **Given** a Tutorial Day's first bingo is numerically earliest, **when** the Event-wide First to BINGO is computed, **then** that bingo is excluded and the earliest non-Tutorial Day wins the honor; a non-Tutorial Day-only entry wins normally. (Test: tutorial-exclusion.)
- **Given** aggregated totals, **when** the roster is sorted, **then** the tie-break order (bingos → squares → earliest first-bingo) is unchanged over those aggregates. (Test: tiebreak.)
- **Given** a Mark on `dayIndex`, **when** `computeMark`'s result is folded, **then** it writes into `dayStats[dayIndex]` and leaves other Days' entries untouched, and the derived root totals reflect the post-fold sum. (Test: fold-into-dayStats.)
- **Given** a Day Card reaches blackout, **when** the completing Mark commits, **then** a Moment naming that Day posts to the Feed. (Test: day-blackout Moment.)
- **Given** the Leaderboard, **then** the honors strip renders each Day's pinned first-bingo Player, and the Event-wide "1st BINGO" pin never lands on a Tutorial Day's first bingo. (Test: honors strip + restricted pin.)
- **Given** the per-Day honor doc, **then** each Day's `meta.firstBingo` is write-once and independent of every other Day's (enforced by `firestore.rules`; the client writer is cache-pre-checked). No player-stats recompute Cloud Function is added (ADR 0001).

## Test coverage

- `src/game/d15-scoring-aggregates.test.ts` (Vitest unit, pure) — `sumDayStats`, `eventFirstBingoAt`/`aggregatePlayerStats` tutorial-exclusion, `foldDayStat` (fold + #75 omit preserve), `perDayHonors`, `cruiseFirstBingoUid`/`effectiveCruiseFirstBingoAt` legacy fallback, and the tie-break over aggregated totals.
- `src/data/d15-scoring-aggregates.test.ts` (Vitest unit) — `computeMark` → `foldDayStat` writes `dayStats[dayIndex]` and leaves siblings untouched; `setMark`'s player write carries the folded `dayStats` + summed root; `dayMeta.ts` `pinDayFirstBingo` cache-pre-check and payload shape; `moments.ts` `broadcastBlackout`'s optional `dayIndex` cache-pre-check and payload shape.
- `src/components/d15-scoring-aggregates.test.tsx` (RTL/jsdom) — the honors strip renders each Day's pinned Player; the Event-wide "1st BINGO" pin never lands on a Tutorial Day's first bingo.
