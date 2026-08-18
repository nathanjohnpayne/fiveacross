import { describe, it, expect } from 'vitest';
import {
  tutorialDayIndexes,
  ceremonialDayIndexes,
  buildPodiumPayload,
  type FinaleDay,
  type FinalePlayer,
} from '../../functions/src/finaleContent';
import { scoringForDay as fnsScoringForDay } from '../../functions/src/scoringVocab';
import { tutorialDayIndexSet, ceremonialDayIndexSet } from '../../src/game/logic';
import { scoringForDay } from '../../src/game/scoring';
import { buildPodium } from '../../src/data/finale';
import type { DayDef, PlayerDoc } from '../../src/types';

// Parity guard for the client/functions podium mirror (ADR 0011).
//
// `src/game/logic.ts` + `src/data/finale.ts` and `functions/src/finaleContent.ts`
// are deliberately decoupled packages — the functions side re-implements the
// ranking and exclusion semantics rather than importing them, the same posture
// `autohide.ts` takes toward `moderation.ts`. Decoupling is fine; SILENT
// DIVERGENCE is not.
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

/** ADR 0011's motivating shape: a weekend Event whose FINAL morning is real
 *  competitive play. The closing pool is what that morning deals; `scoring`
 *  says it still counts. Nothing about this schedule was representable before —
 *  the closing pool alone made the Day ceremonial on both sides. */
const COMPETITIVE_CLOSE: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial' | 'scoring'>> = [
  { index: 0, pool: 'easy', tutorial: true },
  { index: 1, pool: 'main', tutorial: false },
  { index: 2, pool: 'closing', tutorial: false, scoring: 'competitive' },
];

const asFinaleDays = (
  days: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'> & { scoring?: string }>,
): FinaleDay[] =>
  days.map((d) => ({
    index: d.index,
    pool: d.pool,
    tutorial: d.tutorial,
    ...(d.scoring === undefined ? {} : { scoring: d.scoring }),
  }));

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

describe('client/functions parity — Scoring Policy resolution (ADR 0011)', () => {
  // The two resolvers are the new mirror pair. Everything downstream — the
  // ceremonial sets, the podium exclusion, the freeze anchor — reads through
  // them, so a divergence HERE is a divergence everywhere.
  const CASES: Array<{ scoring?: unknown; pool?: unknown }> = [
    {}, // legacy: no key at all, the state both live Events are in
    { pool: 'main' },
    { pool: 'embark' },
    { pool: 'easy' },
    { pool: 'farewell' }, // legacy closing spelling → ceremonial
    { pool: 'closing' },
    { scoring: 'competitive', pool: 'farewell' }, // stated beats pool
    { scoring: 'ceremonial', pool: 'main' }, // …in both directions
    { scoring: 'nonsense', pool: 'closing' }, // malformed → pool fallback
    { scoring: null, pool: 'main' },
    { scoring: 'ceremonial' },
  ];

  it.each(CASES)('agrees on %j', (day) => {
    expect(fnsScoringForDay(day)).toBe(scoringForDay(day));
  });

  it('agrees on null/undefined input', () => {
    expect(fnsScoringForDay(undefined)).toBe(scoringForDay(undefined));
    expect(fnsScoringForDay(null)).toBe(scoringForDay(null));
  });

  it('agrees on the ceremonial Day sets for every fixture schedule', () => {
    for (const schedule of [SCHEDULE, CRUISE_SHAPE, COMPETITIVE_CLOSE]) {
      const client = ceremonialDayIndexSet(schedule as DayDef[]);
      const fns = ceremonialDayIndexes(asFinaleDays(schedule));
      expect(sorted(fns)).toEqual(sorted(client));
    }
    // Pin the values, so a symmetric regression on both sides still fails.
    expect(sorted(ceremonialDayIndexSet(SCHEDULE as DayDef[]))).toEqual([3]);
    expect(sorted(ceremonialDayIndexSet(CRUISE_SHAPE as DayDef[]))).toEqual([2]);
    // The whole point of the ADR: a closing-pool Day that STATES it is
    // competitive is not ceremonial, and the Event has no ceremonial Day at all.
    expect(sorted(ceremonialDayIndexSet(COMPETITIVE_CLOSE as DayDef[]))).toEqual([]);
  });
});

// --- The podium parity the PRD asks for -----------------------------------------
//
// One fixture roster + one fixture schedule into BOTH podium builders, asserting
// identical champion and First-to-BINGO output. The tutorial-set comparison
// above pins one input to that computation; this pins the ANSWER, which is what
// the card and the Feed actually print at players.

/** A roster whose per-Day buckets decide the outcome — the champion flips on
 *  whether the final Day is excluded, and First to BINGO flips on whether a
 *  curated-pool Day is treated as Tutorial. Both hinges are exercised at once. */
function roster(): PlayerDoc[] {
  return [
    {
      uid: 'ana',
      displayName: 'Ana',
      photoURL: null,
      joinedAt: 0,
      // Roots are the aggregate over every bucket, as `aggregatePlayerStats`
      // would derive them — a realistic row, not a hand-tuned one.
      bingoCount: 3,
      squaresMarked: 30,
      firstBingoAt: 100,
      reshufflesUsed: 0,
      dayStats: {
        0: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 100 },
        1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 300 },
        2: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 500 },
      },
    },
    {
      uid: 'bo',
      displayName: 'Bo',
      photoURL: null,
      joinedAt: 0,
      bingoCount: 3,
      squaresMarked: 29,
      firstBingoAt: 200,
      reshufflesUsed: 0,
      dayStats: {
        0: { bingoCount: 0, squaresMarked: 4, firstBingoAt: null },
        1: { bingoCount: 2, squaresMarked: 20, firstBingoAt: 200 },
        // A big final-Day haul: it wins Bo the lead unless the Day is excluded.
        2: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 900 },
      },
    },
    {
      uid: 'cy',
      displayName: 'Cy',
      photoURL: null,
      joinedAt: 0,
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      reshufflesUsed: 0,
      dayStats: {},
    },
  ];
}

/** The same roster in the functions package's local shape. */
const asFinalePlayers = (players: readonly PlayerDoc[]): FinalePlayer[] =>
  players.map((p) => ({
    uid: p.uid,
    displayName: p.displayName,
    bingoCount: p.bingoCount,
    squaresMarked: p.squaresMarked,
    firstBingoAt: p.firstBingoAt,
    dayStats: p.dayStats,
  }));

describe('client/functions parity — podium champion + First to BINGO (ADR 0011)', () => {
  const SHAPES: Array<{
    name: string;
    days: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'> & { scoring?: string }>;
  }> = [
    { name: 'the cruise shape (curated ends, ceremonial close)', days: CRUISE_SHAPE },
    { name: 'a Five Across shape (competitive easy opener)', days: SCHEDULE },
    { name: 'a weekend shape whose final morning still counts', days: COMPETITIVE_CLOSE },
    { name: 'a schedule with no ceremonial Day at all', days: [
      { index: 0, pool: 'main', tutorial: false },
      { index: 1, pool: 'main', tutorial: false },
      { index: 2, pool: 'main', tutorial: false },
    ] },
  ];

  it.each(SHAPES)('agrees on champion and First to BINGO for $name', ({ days }) => {
    const players = roster();
    const client = buildPodium(players, days as DayDef[]);
    const fns = buildPodiumPayload(asFinalePlayers(players), asFinaleDays(days));

    expect(fns.champion).toEqual(client.champion);
    expect(fns.firstBingo).toEqual(client.firstBingo);
  });

  // The parity assertions above would still pass if BOTH sides regressed
  // identically, so pin the two answers that actually differ between shapes.
  it('excludes a ceremonial final Day from the champion, and counts a competitive one', () => {
    const players = roster();

    // Cruise shape: Day 2 is ceremonial, so BOTH players' final-Day buckets are
    // dropped. Over Days 0-1 Bo has 2 bingos / 24 squares to Ana's 2 / 20, so
    // the exclusion hands Bo the championship on the squares tie-break.
    const ceremonialClose = buildPodium(players, CRUISE_SHAPE as DayDef[]);
    expect(ceremonialClose.champion).toEqual({
      uid: 'bo',
      displayName: 'Bo',
      bingoCount: 2,
      squaresMarked: 24,
    });

    // Same roster, same pool on the final Day — but it STATES that it counts,
    // so Bo's Day-2 bingo is back in and the totals are the full aggregate.
    const competitiveClose = buildPodium(players, COMPETITIVE_CLOSE as DayDef[]);
    expect(competitiveClose.champion).toEqual({
      uid: 'ana',
      displayName: 'Ana',
      bingoCount: 3,
      squaresMarked: 30,
    });

    // …and the functions side reaches both of those same answers.
    expect(buildPodiumPayload(asFinalePlayers(players), asFinaleDays(CRUISE_SHAPE)).champion).toEqual(
      ceremonialClose.champion,
    );
    expect(
      buildPodiumPayload(asFinalePlayers(players), asFinaleDays(COMPETITIVE_CLOSE)).champion,
    ).toEqual(competitiveClose.champion);
  });

  it('keeps a competitive curated-pool Day eligible for First to BINGO on both sides', () => {
    const players = roster();
    // Ana's earliest bingo (t=100) is on Day 0, the easy-pool opener. In the
    // Five Across shape that Day is `tutorial: false`, so the honour is hers;
    // in the cruise shape the same Day is flagged and it passes to Bo's t=200.
    const fiveAcross = buildPodium(players, SCHEDULE as DayDef[]);
    expect(fiveAcross.firstBingo).toEqual({ uid: 'ana', displayName: 'Ana', at: 100 });

    const cruise = buildPodium(players, CRUISE_SHAPE as DayDef[]);
    expect(cruise.firstBingo).toEqual({ uid: 'bo', displayName: 'Bo', at: 200 });

    expect(buildPodiumPayload(asFinalePlayers(players), asFinaleDays(SCHEDULE)).firstBingo).toEqual(
      fiveAcross.firstBingo,
    );
    expect(buildPodiumPayload(asFinalePlayers(players), asFinaleDays(CRUISE_SHAPE)).firstBingo).toEqual(
      cruise.firstBingo,
    );
  });

  // Codex P1, round 2: the standings tie-break. `comparePlayers` breaks a
  // bingos+squares tie on the earliest first-bingo, so a first-bingo value that
  // still counts ceremonial Days lets a ceremonial Mark decide the podium —
  // while that same Day's bingos and squares are being excluded. Unreachable on
  // both live Events (their ceremonial Day is also `tutorial: true`); ADR 0011
  // is what makes it reachable, via a ceremonial Day with `tutorial: false`.
  it('never lets a ceremonial Day s bingo win the standings tie-break', () => {
    // A ceremonial Day that is NOT a Tutorial Day — the newly expressible shape.
    const days: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'> & { scoring?: string }> = [
      { index: 0, pool: 'main', tutorial: false },
      { index: 1, pool: 'main', tutorial: false, scoring: 'ceremonial' },
    ];
    // Dead heat on Day 0 — same bingos, same squares. The ONLY thing that can
    // separate them is the first-bingo tie-break.
    const players: PlayerDoc[] = [
      {
        uid: 'early-on-ceremonial',
        displayName: 'Cera',
        photoURL: null,
        joinedAt: 0,
        bingoCount: 2,
        squaresMarked: 20,
        firstBingoAt: 10,
        reshufflesUsed: 0,
        dayStats: {
          0: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 500 },
          // Earliest bingo of anyone — but it happened on a ceremonial Day, so
          // it must not count toward the ranking.
          1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 10 },
        },
      },
      {
        uid: 'early-on-competitive',
        displayName: 'Comp',
        photoURL: null,
        joinedAt: 0,
        bingoCount: 2,
        squaresMarked: 20,
        firstBingoAt: 100,
        reshufflesUsed: 0,
        dayStats: {
          0: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 100 },
          1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 900 },
        },
      },
    ];

    const client = buildPodium(players, days as DayDef[]);
    const fns = buildPodiumPayload(asFinalePlayers(players), asFinaleDays(days));

    // Competitive-Day evidence wins: Comp's t=100 is the earliest that COUNTS.
    expect(client.champion?.uid).toBe('early-on-competitive');
    expect(fns.champion).toEqual(client.champion);

    // The HONOUR is a different question with a different exclusion — it drops
    // Tutorial Days only, so a ceremonial non-Tutorial Day IS still eligible
    // for First to BINGO. Cera's t=10 takes it, and that is correct: the two
    // must not be collapsed into one predicate.
    expect(client.firstBingo).toEqual({ uid: 'early-on-ceremonial', displayName: 'Cera', at: 10 });
    expect(fns.firstBingo).toEqual(client.firstBingo);
  });

  it('agrees on an empty roster and on a schedule-less Event', () => {
    expect(buildPodiumPayload([], asFinaleDays(CRUISE_SHAPE)).champion).toEqual(
      buildPodium([], CRUISE_SHAPE as DayDef[]).champion,
    );
    const players = roster();
    expect(buildPodiumPayload(asFinalePlayers(players), undefined).champion).toEqual(
      buildPodium(players, undefined).champion,
    );
    expect(buildPodiumPayload(asFinalePlayers(players), undefined).firstBingo).toEqual(
      buildPodium(players, undefined).firstBingo,
    );
  });
});
