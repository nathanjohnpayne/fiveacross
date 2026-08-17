/**
 * Community Prompt Day targeting (#557, specs/community-prompt-targeting.md).
 *
 * A Community Prompt names the Day it is meant for. This module owns the two
 * pure decisions that ride on that: which Days can still accept one, and where
 * an approval routes a Prompt whose intended Day has already gone.
 *
 * The whole design rests on one asymmetry. A Day's snapshot is frozen ONCE, at
 * that Day's `unlockAt`, and is never re-opened (`stampDaySnapshot` in
 * `functions/src/unlockDay.ts` refuses to overwrite an existing stamp). So
 * targeting can only ever be a statement about the FUTURE: nothing here mutates
 * a Day, and no decision this module makes can reach backwards into a Day that
 * has already frozen or dealt. Routing a Prompt is a write to the PROMPT — the
 * Day never learns about it until it freezes its own snapshot and reads the pool.
 *
 * The eligibility bar is `unlockAt`, not "has a snapshot yet". A Day whose
 * `unlockAt` has passed but which the scheduler has not stamped yet is already
 * PAST its cutoff: `activeSnapshotIds` filters the frozen pool as-of
 * `day.unlockAt`, so a Prompt approved after that instant would be dropped by the
 * cutoff filter even though the stamp had not landed. Treating such a Day as
 * eligible would therefore promise a placement that silently never happens.
 * Requiring BOTH (unstamped AND still ahead of its unlock) is what makes
 * "scheduled for Day N" a promise the snapshot actually keeps.
 */

import { normalizePool } from '../game/pool';

/** The subset of a `DayDef` targeting reads. Structural on purpose, so callers
 *  can pass a `DayDef` straight through and tests can pass a small literal. */
export interface TargetableDay {
  index: number;
  unlockAt: number;
  /** Which item set the Day deals from. Legacy persisted spellings are
   *  normalized here, so a Day storing 'embark'/'farewell' behaves identically. */
  pool?: string;
  snapshotItemIds?: string[];
}

/**
 * Can this Day still accept a Community Prompt?
 *
 * Three halves, all load-bearing:
 *   - `snapshotItemIds == null` — the Day has not frozen. An empty array is a
 *     REAL stamp (a Day whose pool held nothing at unlock), matching
 *     `isDueForSnapshot`'s idempotency rule; treating `[]` as unstamped would
 *     promise placement into a Day that is already closed.
 *   - `unlockAt > now` — the Day's cutoff is still ahead. See the module note:
 *     a due-but-unstamped Day would drop the Prompt at freeze time.
 *   - the Day deals the MAIN pool. A Community Prompt is always a main-pool
 *     submission — `addItem` writes `pool: 'main'` and `firestore.rules` admits
 *     nothing else from a non-admin — while a curated Day freezes only its own
 *     pool (`snapshotPoolsFor`: main → main+easy, easy → easy, closing →
 *     closing). So a suggestion aimed at a Tutorial or closing Day would be
 *     dropped by the snapshot's POOL filter even though its Day, timing and
 *     moderation state were all fine. Without this check, every suggestion made
 *     during the run-up to a closing Day would be reported as scheduled and
 *     then quietly deal nowhere — the same broken promise the `unlockAt` bar
 *     exists to prevent, arriving by a different route (Codex P1, PR #812).
 *
 * The `unlockAt: 0` "open from the start" sentinel is therefore never targetable,
 * which is correct — that Day is open, not upcoming.
 */
export function isDayTargetable(day: TargetableDay, now: number): boolean {
  return day.snapshotItemIds == null && day.unlockAt > now && dealsMainPool(day);
}

/**
 * Does this Day deal the main pool — the pool every Community Prompt lives in?
 * Normalized, so the legacy persisted spellings ('embark'/'farewell', CONTEXT.md
 * § Pool) resolve the same as the canonical ones. A Day with NO pool reads as
 * main, matching `migratePool`/`normalizePool`'s default for legacy docs.
 */
function dealsMainPool(day: TargetableDay): boolean {
  return normalizePool(day.pool) === 'main';
}

/** Every still-targetable Day, in schedule order. */
export function targetableDays(days: readonly TargetableDay[], now: number): TargetableDay[] {
  return days.filter((d) => isDayTargetable(d, now)).sort((a, b) => a.index - b.index);
}

/**
 * The Day a new submission defaults to — "put it on tomorrow's card": the
 * earliest Day that can still accept one. `null` when the Event has no schedule
 * (a legacy single-board Event) or every Day has gone, in which case the caller
 * writes NO target and the Prompt keeps the untargeted, every-Day behaviour that
 * predates this feature.
 */
export function defaultTargetDayIndex(days: readonly TargetableDay[], now: number): number | null {
  return targetableDays(days, now)[0]?.index ?? null;
}

/**
 * Where an approval routes a Prompt intended for `intendedDayIndex`.
 *
 *   - the intended Day itself, when it is still targetable;
 *   - otherwise the EARLIEST targetable Day AFTER it — the roll-forward. Strictly
 *     after: a Prompt written for Day 7 must never be dealt onto Day 5, so a
 *     still-open earlier Day is not a candidate. (Days are ordered, and an
 *     earlier-indexed Day can outlive a later one only in a mis-ordered
 *     schedule, which this rule tolerates rather than trusts.)
 *   - `null` when nothing remains — the retained case. The caller leaves
 *     `targetDayIndex` where it was and stamps `retainedAt`; it is never dropped,
 *     never deleted, and never silently re-aimed at a Day that has already dealt.
 */
export function routeApprovalToDay(
  days: readonly TargetableDay[],
  intendedDayIndex: number,
  now: number,
): number | null {
  const open = targetableDays(days, now);
  const exact = open.find((d) => d.index === intendedDayIndex);
  if (exact) return exact.index;
  return open.find((d) => d.index > intendedDayIndex)?.index ?? null;
}

/**
 * Is `targetDayIndex` a usable target at all? Only a non-negative integer is —
 * the shape `firestore.rules` admits on create. A present-but-malformed value is
 * NOT treated as untargeted: "we cannot tell which Day this was for" must not
 * degrade into "every Day", which is the exact bug this feature exists to fix.
 * Such a Prompt is simply never admitted to a snapshot (see the snapshot-side
 * mirror of this rule in `functions/src/unlockDay.ts`), which is the retained
 * state — visible to admins, dealt nowhere.
 */
export function isUsableTarget(targetDayIndex: unknown): targetDayIndex is number {
  return typeof targetDayIndex === 'number' && Number.isInteger(targetDayIndex) && targetDayIndex >= 0;
}
