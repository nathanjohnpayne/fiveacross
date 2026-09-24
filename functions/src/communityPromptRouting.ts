/**
 * Community Prompt Day routing, Functions mirror (#1275, #557,
 * specs/community-prompt-targeting.md).
 *
 * A PORT of the routing half of `src/data/communityPrompts.ts`: which Days can
 * still accept a Community Prompt, and where an approval routes one whose
 * intended Day has already gone. The `approvePrompts` callable
 * (`./approvePrompts.ts`) routes on the SERVER clock, so it needs these
 * decisions inside the Functions package, which deliberately imports nothing
 * from the app package (the same reason `poolVocab.ts` mirrors `migratePool`).
 * The client keeps its own copy for `addItem`'s default target and for
 * `submitterStatus`.
 *
 * The two copies must agree, or a submission could be aimed at a Day approval
 * then refuses, and a submitter could be told "scheduled" for a Day the
 * callable would have rolled past. `tests/functions/community-prompt-routing-
 * parity.test.ts` feeds one fixture table to both and requires identical
 * answers, so a change to either side fails there until the other follows.
 * Edit the twin in `src/data/communityPrompts.ts` in the same change.
 *
 * Why the eligibility bar is `unlockAt`, not "has a snapshot yet": a Day whose
 * `unlockAt` has passed but which the scheduler has not stamped yet is already
 * PAST its cutoff (`activeSnapshotIds` filters as of `day.unlockAt`), so a
 * Prompt approved after that instant would be dropped at freeze time. A Day is
 * targetable only when it is BOTH unstamped AND still ahead of its unlock.
 */

import { normalizePool } from './poolVocab';

/** The subset of a Day the routing reads. Structural, so a raw Firestore
 *  `DayLike` passes straight through and tests can pass a small literal. */
export interface TargetableDay {
  index: number;
  unlockAt: number;
  /** Legacy persisted spellings ('embark'/'farewell') normalize here. */
  pool?: string;
  snapshotItemIds?: string[];
}

/**
 * Can this Day still accept a Community Prompt? Three halves, all load-bearing:
 * unstamped (`snapshotItemIds == null`; an empty array is a REAL stamp), still
 * ahead of its cutoff (`unlockAt > now`), and dealing the MAIN pool (a curated
 * Day's snapshot would drop a main-pool suggestion by its pool filter). The
 * `unlockAt: 0` "open from the start" sentinel is therefore never targetable.
 */
export function isDayTargetable(day: TargetableDay, now: number): boolean {
  return day.snapshotItemIds == null && day.unlockAt > now && dealsMainPool(day);
}

/** A Day with NO pool reads as main, matching `normalizePool`'s default. */
function dealsMainPool(day: TargetableDay): boolean {
  return normalizePool(day.pool) === 'main';
}

/** Every still-targetable Day, in schedule order. */
export function targetableDays(days: readonly TargetableDay[], now: number): TargetableDay[] {
  return days.filter((d) => isDayTargetable(d, now)).sort((a, b) => a.index - b.index);
}

/**
 * The Day an untargeted pending submission resolves to at approval: the
 * earliest Day that can still accept one, or `null` when none can.
 */
export function defaultTargetDayIndex(days: readonly TargetableDay[], now: number): number | null {
  return targetableDays(days, now)[0]?.index ?? null;
}

/**
 * Where an approval routes a Prompt intended for `intendedDayIndex`: that Day
 * while it is still targetable; otherwise the EARLIEST targetable Day strictly
 * AFTER it (never backwards); otherwise `null`, the retained case.
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
 * Is `targetDayIndex` a usable target at all? Only a non-negative integer is,
 * matching what `firestore.rules` admits on create. A present-but-malformed
 * value is NOT untargeted: "we cannot tell which Day" must never degrade into
 * "every Day". Such a Prompt is retained, dealt nowhere.
 */
export function isUsableTarget(targetDayIndex: unknown): targetDayIndex is number {
  return typeof targetDayIndex === 'number' && Number.isInteger(targetDayIndex) && targetDayIndex >= 0;
}
