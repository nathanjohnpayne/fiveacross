import { describe, it, expect } from 'vitest';
import { tutorialDayIndexes, type FinaleDay } from '../../functions/src/finaleContent';
import { tutorialDayIndexSet } from '../../src/game/logic';
import type { DayDef } from '../../src/types';

// Parity guard for the client/functions podium mirror (ADR 0011).
//
// `src/game/logic.ts` and `functions/src/finaleContent.ts` are deliberately
// decoupled packages — the functions side re-implements the ranking and
// exclusion semantics rather than importing them, the same posture `autohide.ts`
// takes toward `moderation.ts`. Decoupling is fine; SILENT DIVERGENCE is not.
//
// They had diverged: the client excluded only `tutorial` Days from the
// Event-wide First to BINGO, while the functions mirror ALSO excluded the
// `embark` and `farewell` pools. Invisible on Gay Cruise Bingo, whose curated
// Days carry `tutorial: true` anyway — and wrong on any Event where a curated
// pool is competitive play, where the card and the Feed would name different
// players as First to BINGO.
//
// A mirror without a parity test is exactly how that happens, so this feeds one
// fixture schedule to both implementations and asserts identical output. It is
// intended to FAIL if either side changes alone.

/** A schedule shaped like a Five Across Event rather than the cruise: curated
 *  pools that are real competitive play, so pool identity and Tutorial framing
 *  disagree on purpose. This is the case the old divergence got wrong. */
const SCHEDULE: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'>> = [
  // Opens on the easy pool but COUNTS — the exact combination that broke.
  { index: 0, pool: 'embark', tutorial: false },
  { index: 1, pool: 'main', tutorial: false },
  { index: 2, pool: 'main', tutorial: false },
  // Ceremonial wrap-up: curated pool AND flagged, excluded by both sides.
  { index: 3, pool: 'farewell', tutorial: true },
];

/** The cruise's own shape, where pool and flag agree — the case that hid it. */
const CRUISE_SHAPE: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'>> = [
  { index: 0, pool: 'embark', tutorial: true },
  { index: 1, pool: 'main', tutorial: false },
  { index: 2, pool: 'farewell', tutorial: true },
];

const asFinaleDays = (days: typeof SCHEDULE): FinaleDay[] =>
  days.map((d) => ({ index: d.index, pool: d.pool, tutorial: d.tutorial })) as FinaleDay[];

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('client/functions parity — Tutorial Day exclusion (ADR 0011)', () => {
  it('agrees on a schedule whose curated pools are competitive play', () => {
    const client = tutorialDayIndexSet(SCHEDULE as DayDef[]);
    const fns = tutorialDayIndexes(asFinaleDays(SCHEDULE));
    expect(sorted(fns)).toEqual(sorted(client));
    // Pin the value too: a parity test that only compares the two would still
    // pass if BOTH regressed the same way.
    expect(sorted(client)).toEqual([3]);
  });

  it('agrees on the cruise shape, where pool and flag coincide', () => {
    const client = tutorialDayIndexSet(CRUISE_SHAPE as DayDef[]);
    const fns = tutorialDayIndexes(asFinaleDays(CRUISE_SHAPE));
    expect(sorted(fns)).toEqual(sorted(client));
    expect(sorted(client)).toEqual([0, 2]);
  });

  it('does not exclude a competitive Day merely for its pool', () => {
    // The regression, stated directly: an easy-pool Day with tutorial: false is
    // real competitive play and must remain eligible for First to BINGO on BOTH
    // sides. If either implementation reintroduces a pool check, this fails.
    const day0 = [{ index: 0, pool: 'embark' as const, tutorial: false }];
    expect(tutorialDayIndexSet(day0 as DayDef[]).has(0)).toBe(false);
    expect(tutorialDayIndexes(asFinaleDays(day0)).has(0)).toBe(false);
  });

  it('agrees on an empty or absent schedule', () => {
    expect(sorted(tutorialDayIndexes(undefined))).toEqual(sorted(tutorialDayIndexSet(undefined)));
    expect(sorted(tutorialDayIndexes([]))).toEqual(sorted(tutorialDayIndexSet([])));
  });
});
