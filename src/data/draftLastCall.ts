/**
 * The setup wizard's DRAFT last-call mirror (#1378, specs/event-setup-wizard.md
 * § Validation) — the "last call" instant Look (#792) and the Launch checklist
 * (#794) both render, derived from a draft's Days before any Event exists.
 *
 * It is a CLIENT MIRROR of `finaleTimes` in `functions/src/unlockDay.ts`, which
 * is the only place the scheduler decides when the last-call beat posts. The
 * browser cannot import that module at runtime (the packages are deliberately
 * decoupled), so the rule is re-expressed here and
 * `src/draft-last-call-parity.test.ts` pins it to the real `finaleTimes` over a
 * fixture table. A change to the lead or to the derivation in Functions alone
 * fails that test; do not "fix" a failure by editing this file in isolation.
 *
 * REPORTS, NEVER CORRECTS. `fires` is exactly the guard `finaleTimes` logs on
 * (`lastCallAt < standingsFreezeAt`), and `lastCallAt` is the value the
 * scheduler would compute — never an adjusted, clamped or "nicer" one. If a
 * surface wants to warn, it reads `fires`; it must not substitute its own
 * instant, or the page would promise a beat the scheduler never posts.
 *
 * The freeze is resolved through `standingsFreezeAtFor` (src/game/logic.ts),
 * the client twin of the Functions derivation that
 * `tests/functions/finale-parity.test.ts` already pins — so the configured-wins,
 * first-ceremonial-Day, non-positive-sentinel rules are inherited, not copied.
 * The wizard authors no `standingsFreezeAt` (#551), so drafts resolve the
 * derived freeze; the optional argument mirrors `finaleTimes`' own signature.
 *
 * No Firebase, no React, no clock, no zone: every boundary is an absolute
 * instant (#552), so this arithmetic is timezone-free by construction.
 */

import { standingsFreezeAtFor } from '../game/logic';
import type { DayDef, DraftDayDef } from '../types';

/** `LAST_CALL_LEAD_MS` in `functions/src/unlockDay.ts`: the last-call beat posts
 *  this long before the freeze, or this long after the preceding Day's unlock
 *  when that lands before the freeze. Pinned by the parity test. */
export const LAST_CALL_LEAD_MS = 12 * 60 * 60 * 1000;

export interface DraftLastCall {
  /** When the scheduler's last-call beat opens (ms epoch). */
  lastCallAt: number;
  /** The Event's Standings Freeze the draft resolves to (ms epoch). */
  standingsFreezeAt: number;
  /**
   * Which derivation produced `lastCallAt`: `'forward'` is the preceding Day's
   * `unlockAt` + 12h; `'backward'` is `standingsFreezeAt` − 12h, taken when
   * there is no preceding Day or the forward candidate would land at or after
   * the freeze (#784 — a closing Day sharing a calendar date with its
   * predecessor).
   */
  branch: 'forward' | 'backward';
  /** Exactly `lastCallAt < standingsFreezeAt`: whether the half-open
   *  `[lastCallAt, standingsFreezeAt)` posting window is non-empty. */
  fires: boolean;
}

/** The Days exactly as `EventDoc.days` carries them: array order is kept, and a
 *  Day with no ceremonial pool and no stated scoring resolves competitive. */
type ScheduleDay = Pick<DayDef, 'index' | 'unlockAt' | 'pool'>;

/**
 * Resolve the finale clock a draft's Days (and an optional configured freeze)
 * would produce on the scheduler. `null` when there is no finale — no
 * configured freeze and no ceremonial Day, or no Days at all — and ALSO while
 * any Day's unlock is still unset: the derivation reads the freeze Day's and its
 * predecessor's `unlockAt`, so a partial schedule would yield a confident
 * instant computed over a Day that is not there (`firstUnlockIssues` and
 * `dayCompletenessIssues` already report the gap).
 *
 * Holes (a sparse `draft.days` entry) are dropped, and the array is NOT
 * re-sorted: `finaleTimes` reads Days in stored order (first ceremonial Day,
 * first matching index), and a mirror that sorted would answer a question the
 * scheduler never asks.
 */
export function draftLastCall(
  days: ReadonlyArray<DraftDayDef | null | undefined>,
  standingsFreezeAt?: number,
): DraftLastCall | null {
  const schedule: ScheduleDay[] = [];
  for (const d of days) {
    if (d == null) continue;
    if (typeof d.unlockAt !== 'number' || !Number.isFinite(d.unlockAt)) return null;
    schedule.push({ index: d.index, unlockAt: d.unlockAt, pool: d.pool });
  }

  const freezeAt = standingsFreezeAtFor({
    frozenAt: undefined,
    days: schedule as DayDef[],
    standingsFreezeAt,
  });
  if (freezeAt == null) return null;

  // A configured freeze on an Event with no schedule has no Day to file the
  // Moments under (`finaleTimes`): treat it as no finale.
  const lastDayIndex = schedule.reduce((max, d) => (d.index > max ? d.index : max), -1);
  if (lastDayIndex < 0) return null;

  // The podium Day is the LAST Day still open at the freeze; before every Day
  // opens it falls back to the lowest index (a misconfiguration, not a shape).
  const openAtFreeze = schedule.filter((d) => d.unlockAt <= freezeAt).map((d) => d.index);
  const podiumDayIndex = openAtFreeze.length
    ? Math.max(...openAtFreeze)
    : schedule.reduce((min, d) => (d.index < min ? d.index : min), lastDayIndex);

  const priorDay = schedule.find((d) => d.index === podiumDayIndex - 1);
  const forwardLastCallAt = priorDay ? priorDay.unlockAt + LAST_CALL_LEAD_MS : null;
  const forward = forwardLastCallAt !== null && forwardLastCallAt < freezeAt;
  const lastCallAt = forward ? (forwardLastCallAt as number) : freezeAt - LAST_CALL_LEAD_MS;

  return {
    lastCallAt,
    standingsFreezeAt: freezeAt,
    branch: forward ? 'forward' : 'backward',
    fires: lastCallAt < freezeAt,
  };
}
