import { describe, it, expect } from 'vitest';
import {
  tutorialDayIndexes,
  ceremonialDayIndexes,
  buildPodiumPayload,
  sanitizeFinaleDayStats,
  standingsFreezeAtFor as fnsStandingsFreezeAtFor,
  withReadableFinaleRanking,
  canonicalDayStatsKey as fnsCanonicalDayStatsKey,
  clampArchiveNumber as fnsClampArchiveNumber,
  clampReaggregatedTotal as fnsClampReaggregatedTotal,
  ARCHIVE_NUMBER_BOUND as FNS_ARCHIVE_NUMBER_BOUND,
  MAX_ARCHIVE_NUMBER as FNS_MAX_ARCHIVE_NUMBER,
  type FinaleDay,
  type FinalePlayer,
} from '../../functions/src/finaleContent';
import { scoringForDay as fnsScoringForDay } from '../../functions/src/scoringVocab';
import {
  eventFirstBingoUid,
  standingsRows,
  standingsThrough,
  type EmailDay,
  type EmailPlayer,
} from '../../functions/src/dailyEmailContent';
import {
  tutorialDayIndexSet,
  ceremonialDayIndexSet,
  cruiseFirstBingoUid,
  sortPlayers,
  standingsFreezeAtFor as clientStandingsFreezeAtFor,
} from '../../src/game/logic';
import { scoringForDay } from '../../src/game/scoring';
import { buildPodium } from '../../src/data/finale';
import { withReadableDayStats } from '../../src/data/eventArchive';
import {
  ARCHIVE_NUMBER_BOUND,
  MAX_ARCHIVE_NUMBER,
  canonicalDayStatsKey,
  clampArchiveNumber,
  clampReaggregatedTotal,
} from '../../src/data/eventLimits';
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

  // Phase 4b P1: the podium is "as of the freeze", not live. The client reads
  // the LIVE roster, and a ceremonial Day deliberately keeps recording Marks
  // after the freeze (its bucket is retained so its own daily honour renders).
  // Without a cutoff, a post-freeze bingo mints a First to BINGO that the
  // scheduler's already-posted, immutable podium Moment does not have — the
  // Card and the Feed naming different winners.
  it('ignores post-freeze Marks on both sides, so the card cannot drift from the Moment', () => {
    const FREEZE = 1_000;
    const days: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'> & { scoring?: string }> = [
      { index: 0, pool: 'main', tutorial: false },
      // Ceremonial but NOT a Tutorial Day, so it stays eligible for the honour
      // — which is exactly what makes the cutoff load-bearing here.
      { index: 1, pool: 'closing', tutorial: false, scoring: 'ceremonial' },
    ];
    // Nobody bingoed before the freeze; one Player does so afterwards on the
    // ceremonial Day. The frozen podium must still report NO First to BINGO.
    const players: PlayerDoc[] = [
      {
        uid: 'late',
        displayName: 'Late',
        photoURL: null,
        joinedAt: 0,
        bingoCount: 1,
        squaresMarked: 10,
        firstBingoAt: FREEZE + 500,
        reshufflesUsed: 0,
        dayStats: {
          0: { bingoCount: 0, squaresMarked: 6, firstBingoAt: null },
          1: { bingoCount: 1, squaresMarked: 4, firstBingoAt: FREEZE + 500 },
        },
      },
    ];

    const frozenClient = buildPodium(players, days as DayDef[], undefined, true, FREEZE);
    const frozenFns = buildPodiumPayload(asFinalePlayers(players), asFinaleDays(days), [], FREEZE);
    expect(frozenClient.firstBingo).toBeNull();
    expect(frozenFns.firstBingo).toEqual(frozenClient.firstBingo);

    // Pin that the cutoff is what does it: with no cutoff the SAME data mints a
    // First to BINGO on both sides, which is the drift being prevented.
    expect(buildPodium(players, days as DayDef[]).firstBingo).toEqual({
      uid: 'late',
      displayName: 'Late',
      at: FREEZE + 500,
    });

    // A PRE-freeze bingo is still reported normally — the cutoff filters, it
    // does not blank the honour outright.
    const early = players.map((p) => ({
      ...p,
      dayStats: { ...p.dayStats, 0: { bingoCount: 1, squaresMarked: 6, firstBingoAt: FREEZE - 100 } },
    }));
    expect(buildPodium(early, days as DayDef[], undefined, true, FREEZE).firstBingo).toEqual({
      uid: 'late',
      displayName: 'Late',
      at: FREEZE - 100,
    });
    expect(
      buildPodiumPayload(asFinalePlayers(early), asFinaleDays(days), [], FREEZE).firstBingo,
    ).toEqual(buildPodium(early, days as DayDef[], undefined, true, FREEZE).firstBingo);
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

// --- One normalisation, three ranking paths (#1152, Codex P2 on PR #1165) -------
//
// `players/{uid}` validates no field (ADR 0001), so a Player can self-write a
// count or an instant far outside the magnitude `firestore.rules` accepts. The
// live board (`useLeaderboard`) and the freeze (`draftEventArchive`) both CLAMP
// those before they rank, through `withReadableDayStats`. The scheduler did not:
// `readFinaleRoster` checked only finiteness and `buildPodiumPayload` compared
// the raw numbers, so two oversized counts collapsed to a tie and reordered on
// squares on the two client paths while the podium Moment — written once, never
// amended — kept their original count order, and an out-of-bound first-bingo
// instant could name a different holder on each side.
//
// So this pins the whole mirror: the bound CONSTANTS, the clamp, the normaliser's
// own output, and then the ANSWER both podium builders reach from one oversized
// roster. Each case also pins what the UNNORMALISED roster produces, so a
// regression that drops the mirror fails here rather than passing symmetrically.

/** A roster row in the client's shape, with only the ranking fields varying. */
const oversized = (
  uid: string,
  displayName: string,
  fields: Partial<Pick<PlayerDoc, 'bingoCount' | 'squaresMarked' | 'firstBingoAt' | 'dayStats'>>,
): PlayerDoc => ({
  uid,
  displayName,
  photoURL: null,
  joinedAt: 0,
  bingoCount: 0,
  squaresMarked: 0,
  firstBingoAt: null,
  reshufflesUsed: 0,
  ...fields,
});

/** No ceremonial Day, no Tutorial Day: nothing is excluded, so the ROOT totals
 *  and the ROOT instant are what both builders rank by. */
const PLAIN_SCHEDULE: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'>> = [
  { index: 0, pool: 'main', tutorial: false },
  { index: 1, pool: 'main', tutorial: false },
];

/** The live path's roster, exactly as `useLeaderboard` prepares it. */
const asLiveRoster = (players: readonly PlayerDoc[]): PlayerDoc[] =>
  players.map((p) => withReadableDayStats(p));

/** The scheduler's roster, exactly as `readFinaleRoster` now prepares it. */
const asNormalisedFinalePlayers = (players: readonly PlayerDoc[]): FinalePlayer[] =>
  asFinalePlayers(players).map(withReadableFinaleRanking);

/** The Functions READ BOUNDARY in one expression: the shared `dayStats`
 *  sanitiser, then the shared normaliser — what `readFinaleRoster`
 *  (`unlockDay.ts`) and `readEmailRosterPage` (`dailyEmail.ts`) each apply to
 *  every row they hand their content builders (#1152). The distinction from
 *  `asNormalisedFinalePlayers` above is the point: the sanitiser is the half a
 *  malformed BUCKET has to survive. */
const asReadFinalePlayers = (players: readonly PlayerDoc[]): FinalePlayer[] =>
  asFinalePlayers(players).map((p) =>
    withReadableFinaleRanking({ ...p, dayStats: sanitizeFinaleDayStats(p.dayStats) }),
  );

describe('client/functions parity — the archive bound the podium ranks by (#1152)', () => {
  it('mirrors the bound constants exactly', () => {
    expect(FNS_ARCHIVE_NUMBER_BOUND).toBe(ARCHIVE_NUMBER_BOUND);
    expect(FNS_MAX_ARCHIVE_NUMBER).toBe(MAX_ARCHIVE_NUMBER);
    // Pin the values too, so a symmetric edit to both sides still fails: this is
    // `firestore.rules`' `finiteArchiveNumber` magnitude (2100-01-01T00:00:00Z),
    // and the clamp sits one below it because the rules compare with `<`.
    expect(ARCHIVE_NUMBER_BOUND).toBe(4_102_444_800_000);
    expect(MAX_ARCHIVE_NUMBER).toBe(4_102_444_799_999);
  });

  it.each([
    0,
    -0,
    1,
    -1,
    MAX_ARCHIVE_NUMBER,
    -MAX_ARCHIVE_NUMBER,
    ARCHIVE_NUMBER_BOUND,
    -ARCHIVE_NUMBER_BOUND,
    MAX_ARCHIVE_NUMBER + 1,
    -MAX_ARCHIVE_NUMBER - 1,
    5e12,
    -5e12,
    MAX_ARCHIVE_NUMBER - 0.5,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
  ])('clamps %p identically on both sides', (value) => {
    expect(fnsClampArchiveNumber(value)).toBe(clampArchiveNumber(value));
  });

  it('normalises one malformed row to the same numbers on both sides', () => {
    const row = oversized('messy', 'Messy', {
      bingoCount: MAX_ARCHIVE_NUMBER + 5_000,
      squaresMarked: -(MAX_ARCHIVE_NUMBER + 5_000),
      firstBingoAt: MAX_ARCHIVE_NUMBER + 5_000,
      dayStats: {
        0: { bingoCount: MAX_ARCHIVE_NUMBER + 7, squaresMarked: 4, firstBingoAt: -(MAX_ARCHIVE_NUMBER + 7) },
        1: { bingoCount: 2, squaresMarked: 3, firstBingoAt: 900 },
      },
    });
    const client = withReadableDayStats(row);
    const fns = withReadableFinaleRanking(asFinalePlayers([row])[0]);

    expect(fns.bingoCount).toBe(client.bingoCount);
    expect(fns.squaresMarked).toBe(client.squaresMarked);
    expect(fns.firstBingoAt).toBe(client.firstBingoAt);
    expect(fns.dayStats).toEqual(client.dayStats);
    // …and pin the values, so both sides regressing together still fails.
    expect(client.bingoCount).toBe(MAX_ARCHIVE_NUMBER);
    expect(client.squaresMarked).toBe(-MAX_ARCHIVE_NUMBER);
    expect(client.firstBingoAt).toBe(MAX_ARCHIVE_NUMBER);
    expect(client.dayStats).toEqual({
      0: { bingoCount: MAX_ARCHIVE_NUMBER, squaresMarked: 4, firstBingoAt: -MAX_ARCHIVE_NUMBER },
      1: { bingoCount: 2, squaresMarked: 3, firstBingoAt: 900 },
    });
  });

  it('returns an in-bounds row by identity on both sides', () => {
    const row = oversized('ordinary', 'Ordinary', {
      bingoCount: 3,
      squaresMarked: 30,
      firstBingoAt: 100,
      dayStats: { 0: { bingoCount: 3, squaresMarked: 30, firstBingoAt: 100 } },
    });
    expect(withReadableDayStats(row)).toBe(row);
    const finaleRow = asFinalePlayers([row])[0];
    expect(withReadableFinaleRanking(finaleRow)).toBe(finaleRow);
  });

  it('ranks two distinct oversized counts identically — a clamped tie, broken by squares', () => {
    // Both counts are above the bound and clamp to the SAME number, so the
    // bingos tie and squares decide. Unclamped, the bigger raw count wins.
    const players = [
      oversized('more-squares', 'More Squares', {
        bingoCount: MAX_ARCHIVE_NUMBER + 1_000,
        squaresMarked: 999,
      }),
      oversized('bigger-count', 'Bigger Count', {
        bingoCount: MAX_ARCHIVE_NUMBER + 2_000,
        squaresMarked: 1,
      }),
    ];
    const client = buildPodium(asLiveRoster(players), PLAIN_SCHEDULE as DayDef[]);
    const fns = buildPodiumPayload(asNormalisedFinalePlayers(players), asFinaleDays(PLAIN_SCHEDULE));

    expect(fns.champion).toEqual(client.champion);
    expect(client.champion).toEqual({
      uid: 'more-squares',
      displayName: 'More Squares',
      bingoCount: MAX_ARCHIVE_NUMBER,
      squaresMarked: 999,
    });

    // The defect, stated directly: WITHOUT the normalisation the scheduler's
    // podium crowns the other Player — permanently, on a Moment never amended.
    expect(buildPodiumPayload(asFinalePlayers(players), asFinaleDays(PLAIN_SCHEDULE)).champion).toEqual({
      uid: 'bigger-count',
      displayName: 'Bigger Count',
      bingoCount: MAX_ARCHIVE_NUMBER + 2_000,
      squaresMarked: 1,
    });
  });

  it('selects the same First to BINGO holder when both instants are out of bounds', () => {
    // Both stamps clamp to -MAX_ARCHIVE_NUMBER, so the honour ties on the
    // instant and the shared uid tie-break (ascending) decides it. Unclamped,
    // the more negative stamp is "earlier" and takes it instead.
    const players = [
      oversized('zed', 'Zed', {
        bingoCount: 1,
        squaresMarked: 1,
        firstBingoAt: -(MAX_ARCHIVE_NUMBER + 2_000),
        dayStats: {},
      }),
      oversized('ada', 'Ada', {
        bingoCount: 1,
        squaresMarked: 1,
        firstBingoAt: -(MAX_ARCHIVE_NUMBER + 1_000),
        dayStats: {},
      }),
    ];
    const client = buildPodium(asLiveRoster(players), PLAIN_SCHEDULE as DayDef[]);
    const fns = buildPodiumPayload(asNormalisedFinalePlayers(players), asFinaleDays(PLAIN_SCHEDULE));

    expect(fns.firstBingo).toEqual(client.firstBingo);
    expect(client.firstBingo).toEqual({ uid: 'ada', displayName: 'Ada', at: -MAX_ARCHIVE_NUMBER });

    // …and the same defect on the honour: the unnormalised roster names Zed.
    expect(buildPodiumPayload(asFinalePlayers(players), asFinaleDays(PLAIN_SCHEDULE)).firstBingo).toEqual({
      uid: 'zed',
      displayName: 'Zed',
      at: -(MAX_ARCHIVE_NUMBER + 2_000),
    });
  });

  it('selects the same holder when the out-of-bounds instant is in a per-Day bucket', () => {
    // The pin resolves through the per-Day buckets whenever a row carries any,
    // which is why the mirror normalises them too and not only the root.
    const players = [
      oversized('zed', 'Zed', {
        bingoCount: 1,
        squaresMarked: 1,
        firstBingoAt: 10,
        dayStats: { 0: { bingoCount: 1, squaresMarked: 1, firstBingoAt: -(MAX_ARCHIVE_NUMBER + 2_000) } },
      }),
      oversized('ada', 'Ada', {
        bingoCount: 1,
        squaresMarked: 1,
        firstBingoAt: 20,
        dayStats: { 0: { bingoCount: 1, squaresMarked: 1, firstBingoAt: -(MAX_ARCHIVE_NUMBER + 1_000) } },
      }),
    ];
    const client = buildPodium(asLiveRoster(players), PLAIN_SCHEDULE as DayDef[]);
    const fns = buildPodiumPayload(asNormalisedFinalePlayers(players), asFinaleDays(PLAIN_SCHEDULE));

    expect(fns.firstBingo).toEqual(client.firstBingo);
    expect(client.firstBingo).toEqual({ uid: 'ada', displayName: 'Ada', at: -MAX_ARCHIVE_NUMBER });
    expect(buildPodiumPayload(asFinalePlayers(players), asFinaleDays(PLAIN_SCHEDULE)).firstBingo).toEqual({
      uid: 'zed',
      displayName: 'Zed',
      at: -(MAX_ARCHIVE_NUMBER + 2_000),
    });
  });

  it('leaves an ordinary roster untouched, podium and all', () => {
    // The bound is nine orders of magnitude above any real stat, so normalising
    // must be invisible on every roster that was already fine.
    const players = roster();
    for (const shape of [CRUISE_SHAPE, SCHEDULE, COMPETITIVE_CLOSE]) {
      const normalised = buildPodiumPayload(
        asNormalisedFinalePlayers(players),
        asFinaleDays(shape),
      );
      expect(normalised).toEqual(buildPodiumPayload(asFinalePlayers(players), asFinaleDays(shape)));
      expect(normalised.champion).toEqual(buildPodium(asLiveRoster(players), shape as DayDef[]).champion);
    }
  });

  // #1152, CodeRabbit on PR #1165. The SANITISER half of the read boundary. It
  // dropped a bucket outright when either count was non-finite — BEFORE the
  // normaliser could coerce it — while `withReadableDayStats` keeps the bucket,
  // reads each invalid count as 0 and leaves `firstBingoAt` usable. A row whose
  // only bucket was malformed therefore reached both Functions rankers as a row
  // with NO breakdown, and `effectiveFirstBingoAt` falls back to the ROOT for
  // exactly those rows — so the scheduler's podium Moment and the morning email
  // could lose an Event-wide First to BINGO the client still shows.
  it('keeps a malformed BUCKET on both sides, so neither side loses its honour', () => {
    const holderStats = {
      1: { bingoCount: 'lots', squaresMarked: 3, firstBingoAt: 700 },
    } as unknown as PlayerDoc['dayStats'];
    const players = [
      // No root stamp at all: the bucket is this row's only evidence.
      oversized('holder', 'Holder', {
        bingoCount: 1,
        squaresMarked: 3,
        firstBingoAt: null,
        dayStats: holderStats,
      }),
      oversized('later', 'Later', {
        bingoCount: 1,
        squaresMarked: 5,
        firstBingoAt: 900,
        dayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 900 } },
      }),
    ];
    const client = asLiveRoster(players);
    const fns = asReadFinalePlayers(players);

    // The bucket rule, field for field.
    expect(fns[0].dayStats).toEqual(client[0].dayStats);
    expect(client[0].dayStats).toEqual({ 1: { bingoCount: 0, squaresMarked: 3, firstBingoAt: 700 } });

    // …and the answer it decides.
    const clientPodium = buildPodium(client, PLAIN_SCHEDULE as DayDef[]);
    expect(buildPodiumPayload(fns, asFinaleDays(PLAIN_SCHEDULE)).firstBingo).toEqual(
      clientPodium.firstBingo,
    );
    expect(clientPodium.firstBingo).toEqual({ uid: 'holder', displayName: 'Holder', at: 700 });

    // The CHAMPION too, on a schedule that re-aggregates. `podiumStandingRow`
    // passes the roots through only for a row carrying NO breakdown, so a row
    // whose only bucket was dropped answered from roots the client had already
    // stopped reading.
    const ceremonialClose: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'>> = [
      { index: 0, pool: 'main', tutorial: false },
      { index: 1, pool: 'farewell', tutorial: false },
    ];
    expect(buildPodiumPayload(fns, asFinaleDays(ceremonialClose)).champion).toEqual(
      buildPodium(client, ceremonialClose as DayDef[]).champion,
    );
    expect(buildPodium(client, ceremonialClose as DayDef[]).champion).toBeNull();

    // Pin what the DROP produced, so restoring it fails here rather than passing
    // symmetrically: the row loses its only evidence, the honour moves, and the
    // roots it no longer has a breakdown for crown it champion.
    const dropped = asFinalePlayers(players).map((p) =>
      withReadableFinaleRanking(p.uid === 'holder' ? { ...p, dayStats: undefined } : p),
    );
    expect(buildPodiumPayload(dropped, asFinaleDays(PLAIN_SCHEDULE)).firstBingo).toEqual({
      uid: 'later',
      displayName: 'Later',
      at: 900,
    });
    expect(buildPodiumPayload(dropped, asFinaleDays(ceremonialClose)).champion).toMatchObject({
      uid: 'holder',
      bingoCount: 1,
      squaresMarked: 3,
    });
  });
});

// --- The dayStats ENTRY rule: keys and bucket shapes (#1168) --------------------
//
// #1165 left two divergences out of scope, and this pins their resolution. The
// client kept a bucket KEY verbatim, junk included — `"7.5"`, `"seven"`, `"07"`,
// `" 7"` — while the Functions read boundary canonicalised every key through
// `Number(key)`: dropping `"7.5"` and `"seven"`, but KEEPING `"07"` and `""` as
// Days 7 and 0, merged over whatever real bucket sat under that Day. And the
// client kept an ARRAY where a bucket was expected, coercing its fields, while
// the Functions side dropped it. Neither shape is one a real client writes, so
// no rendered surface moved — but the mirror's whole promise is that no row
// ranks differently on the two sides, and these could.
//
// Both sides now DROP. An entry survives only under a key `Number(key)`
// round-trips (`canonicalDayStatsKey`, one predicate per package) and only with
// a non-null, non-array object for a bucket — plainness is not asked, so a
// `Date` or a `Timestamp` where a bucket belongs is kept with every field
// unreadable; a map left with nothing — or that was never a non-null, non-array
// object — reads as ABSENT, so the row ranks as a legacy row by its roots
// everywhere. Dropping was chosen over keep-and-coerce because it is the
// stricter contract, the one under which no two entries can collapse into one
// Day, and the one the Functions boundary already promised. The empty-map
// answer is the corollary the alignment surfaced: `podiumStandingRow` re-
// aggregates a `{}` to 0/0 and passes an absent map through to the roots, so
// the client's old `{}` and the Functions side's `undefined` crowned different
// champions from one row. And a map in which nothing had to be dropped or
// coerced passes through by IDENTITY on both sides, a field beyond the three
// ranked ones included; the three-field rebuild happens only around a dropped
// or coerced entry. The Functions sanitiser used to rebuild unconditionally, so
// it stripped a foreign field the client kept (fix round 1) — pinned below.

/** A well-formed bucket, reused across the shapes below. */
const BUCKET = { bingoCount: 1, squaresMarked: 2, firstBingoAt: 3 };

/** A class instance where a bucket belongs — what a Firestore `Timestamp` (or a
 *  `Date`) deserialises to on either SDK. Neither side asks for plainness, so
 *  it is a bucket with no readable field, not a dropped one. */
class TimestampLike {
  constructor(
    readonly _seconds: number,
    readonly _nanoseconds: number,
  ) {}
}

/** A ceremonial final Day, so `podiumStandingRow` RE-AGGREGATES — the path on
 *  which an empty map and an absent one answer differently. */
const CEREMONIAL_CLOSE: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'>> = [
  { index: 0, pool: 'main', tutorial: false },
  { index: 1, pool: 'farewell', tutorial: false },
];

describe('client/functions parity — the dayStats ENTRY rule (#1168)', () => {
  // Every spelling the rule has to answer, with the answer pinned so a symmetric
  // regression on both predicates still fails here.
  const KEY_SPELLINGS: Array<[key: string, canonical: boolean]> = [
    ['0', true],
    ['1', true],
    ['7', true],
    ['9', true],
    ['10', true],
    ['-1', true],
    [String(Number.MAX_SAFE_INTEGER), true],
    ['07', false],
    [' 7', false],
    ['7 ', false],
    ['+7', false],
    ['7.5', false],
    ['7.0', false],
    ['seven', false],
    ['', false],
    ['-0', false],
    ['1e3', false],
    ['1e+21', false],
    ['0x10', false],
    ['NaN', false],
    ['Infinity', false],
    [String(Number.MAX_SAFE_INTEGER + 2), false],
    ['12345678901234567890', false],
  ];

  it.each(KEY_SPELLINGS)('answers key %j identically on both sides (%s)', (key, canonical) => {
    expect(fnsCanonicalDayStatsKey(key)).toBe(canonicalDayStatsKey(key));
    expect(canonicalDayStatsKey(key)).toBe(canonical);
  });

  /** Every map and entry shape the rule names, each with the ONE answer both
   *  sides must reach. `reads` is `undefined` wherever nothing survives. */
  const SHAPES: Array<{ name: string; dayStats: unknown; reads: PlayerDoc['dayStats'] }> = [
    { name: 'a key that is not a number', dayStats: { seven: BUCKET }, reads: undefined },
    { name: 'a fractional key', dayStats: { '7.5': BUCKET }, reads: undefined },
    {
      name: 'a zero-padded key whose Number() is an integer — dropped, never merged into Day 7',
      dayStats: { 7: BUCKET, '07': { bingoCount: 9, squaresMarked: 9, firstBingoAt: 1 } },
      reads: { 7: BUCKET },
    },
    { name: 'a key with surrounding whitespace', dayStats: { ' 7': BUCKET, '7 ': BUCKET }, reads: undefined },
    { name: 'an empty key, which Number() reads as Day 0', dayStats: { '': BUCKET }, reads: undefined },
    { name: 'a negative-zero key', dayStats: { '-0': BUCKET }, reads: undefined },
    { name: 'an ARRAY bucket', dayStats: { 1: [1, 2, 3] }, reads: undefined },
    { name: 'an empty array bucket', dayStats: { 1: [] }, reads: undefined },
    { name: 'a null bucket', dayStats: { 1: null }, reads: undefined },
    { name: 'a primitive bucket', dayStats: { 1: 'nonsense', 2: 7 }, reads: undefined },
    {
      name: 'a bucket whose FIELDS are arrays — kept, each field unreadable',
      dayStats: { 1: { bingoCount: [1], squaresMarked: [], firstBingoAt: [900] } },
      reads: { 1: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } },
    },
    {
      name: 'a Date, and a Timestamp-shaped instance, where a bucket belongs — kept, every field unreadable',
      dayStats: { 1: new Date(0), 2: new TimestampLike(0, 0) },
      reads: {
        1: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null },
        2: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null },
      },
    },
    {
      name: 'a well-formed bucket carrying a field the rankers never read — kept by identity, field included',
      dayStats: { 1: { ...BUCKET, note: 'x' } },
      reads: { 1: { ...BUCKET, note: 'x' } } as PlayerDoc['dayStats'],
    },
    {
      name: 'that same bucket beside a dropped entry — the map is rebuilt, and the foreign field goes with it',
      dayStats: { 1: { ...BUCKET, note: 'x' }, seven: BUCKET },
      reads: { 1: BUCKET },
    },
    {
      name: 'every shape at once beside one real bucket',
      dayStats: { 2: BUCKET, '7.5': BUCKET, seven: BUCKET, '02': BUCKET, 3: [BUCKET], 4: null, 5: 'x' },
      reads: { 2: BUCKET },
    },
    { name: 'an empty map', dayStats: {}, reads: undefined },
    { name: 'a map that is an ARRAY', dayStats: [BUCKET], reads: undefined },
    { name: 'a map that is a string', dayStats: 'nonsense', reads: undefined },
    { name: 'a null map', dayStats: null, reads: undefined },
  ];

  it.each(SHAPES)('reads $name identically on both sides', ({ dayStats, reads }) => {
    const row = oversized('shape', 'Shape', { dayStats: dayStats as PlayerDoc['dayStats'] });
    const client = withReadableDayStats(row).dayStats;
    // The read boundary (sanitiser, then normaliser), the sanitiser alone, and
    // the normaliser alone: three routes on the Functions side, one answer.
    expect(asReadFinalePlayers([row])[0].dayStats).toEqual(client);
    expect(sanitizeFinaleDayStats(dayStats)).toEqual(client);
    expect(withReadableFinaleRanking(asFinalePlayers([row])[0]).dayStats).toEqual(client);
    expect(client).toEqual(reads);
  });

  it('still returns a well-formed row by identity on both sides', () => {
    const row = oversized('ok', 'Ok', {
      bingoCount: 1,
      squaresMarked: 2,
      firstBingoAt: 3,
      dayStats: { 0: BUCKET, 9: BUCKET, 10: BUCKET },
    });
    expect(withReadableDayStats(row)).toBe(row);
    const fnsRow = asFinalePlayers([row])[0];
    expect(withReadableFinaleRanking(fnsRow)).toBe(fnsRow);
    // …and the boundary hands the very map the Player wrote back, so running
    // both is a round-trip rather than a second opinion — and a well-formed
    // row's buckets keep their identity through the boundary too (fix round 1).
    expect(sanitizeFinaleDayStats(row.dayStats)).toBe(row.dayStats);
    expect(asReadFinalePlayers([row])[0].dayStats).toBe(row.dayStats);
    expect(asReadFinalePlayers([row])[0]).toEqual(fnsRow);
  });

  it('ranks a row whose every bucket is unreadable by its ROOTS on both podiums and in the email', () => {
    // Nothing survives, so the map reads as absent: `podiumStandingRow` passes
    // the roots through on the re-aggregating schedule, exactly as it does for
    // a legacy row, and the effective first-bingo falls back to the root stamp.
    const players = [
      oversized('junk', 'Junk', {
        bingoCount: 3,
        squaresMarked: 9,
        firstBingoAt: 500,
        dayStats: { '7.5': BUCKET, seven: BUCKET, 1: [BUCKET] } as unknown as PlayerDoc['dayStats'],
      }),
      oversized('real', 'Real', {
        bingoCount: 1,
        squaresMarked: 5,
        firstBingoAt: 900,
        dayStats: { 0: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 900 } },
      }),
    ];
    const client = buildPodium(asLiveRoster(players), CEREMONIAL_CLOSE as DayDef[]);
    const fns = buildPodiumPayload(asReadFinalePlayers(players), asFinaleDays(CEREMONIAL_CLOSE));

    expect(fns.champion).toEqual(client.champion);
    expect(fns.firstBingo).toEqual(client.firstBingo);
    expect(client.champion).toEqual({ uid: 'junk', displayName: 'Junk', bingoCount: 3, squaresMarked: 9 });
    expect(client.firstBingo).toEqual({ uid: 'junk', displayName: 'Junk', at: 500 });

    // The email's window fold reads an absent map the same way — roots.
    const email = standingsThrough(
      asReadFinalePlayers(players),
      1,
      new Set(),
      ceremonialDayIndexes(asFinaleDays(CEREMONIAL_CLOSE)),
    );
    expect(email.map((r) => `${r.uid}:${r.bingoCount}/${r.squaresMarked}`)).toEqual(['junk:3/9', 'real:1/5']);

    // The corollary, stated directly: an EMPTY map handed straight to the client
    // builder is a breakdown that sums to nothing, so the row is not a rank and
    // the other Player is crowned — the champion the client used to name here
    // while the Functions side, reading the map as absent, named Junk.
    const emptied = players.map((p) => (p.uid === 'junk' ? { ...p, dayStats: {} } : p));
    expect(buildPodium(emptied, CEREMONIAL_CLOSE as DayDef[]).champion).toEqual({
      uid: 'real',
      displayName: 'Real',
      bingoCount: 1,
      squaresMarked: 5,
    });
  });

  it('never merges a zero-padded key into the real Day beside it, so the honour reads the same', () => {
    // `"07"` carries the EARLIER stamp. Under the old Functions rule it was read
    // as Day 7 and overwrote the real bucket, and under the old client rule it
    // was a second Day-7 bucket the earliest-of fold still saw — so both sides
    // named Zed, by two different mechanisms. Dropped on both, Ada holds it.
    const schedule: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'>> = [
      { index: 7, pool: 'main', tutorial: false },
    ];
    const players = [
      oversized('zed', 'Zed', {
        bingoCount: 2,
        squaresMarked: 2,
        firstBingoAt: 100,
        dayStats: {
          7: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 700 },
          '07': { bingoCount: 1, squaresMarked: 1, firstBingoAt: 100 },
        } as unknown as PlayerDoc['dayStats'],
      }),
      oversized('ada', 'Ada', {
        bingoCount: 1,
        squaresMarked: 1,
        firstBingoAt: 400,
        dayStats: { 7: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 400 } },
      }),
    ];
    const client = buildPodium(asLiveRoster(players), schedule as DayDef[]);
    const fns = buildPodiumPayload(asReadFinalePlayers(players), asFinaleDays(schedule));
    expect(fns.firstBingo).toEqual(client.firstBingo);
    expect(client.firstBingo).toEqual({ uid: 'ada', displayName: 'Ada', at: 400 });
    // …and the UNREAD roster really does name the other Player on both sides.
    expect(buildPodium(players, schedule as DayDef[]).firstBingo?.uid).toBe('zed');
    expect(buildPodiumPayload(asFinalePlayers(players), asFinaleDays(schedule)).firstBingo?.uid).toBe('zed');
  });
});

// --- The RE-AGGREGATED total shares that bound (#1152, Codex P2 on PR #1165) ----
//
// Clamping each BUCKET is not enough. Two of the three ranking surfaces do not
// rank by the buckets: both `podiumStandingRow` implementations and
// `standingsThrough` ADD the surviving buckets back up, and a sum of bounded
// counts is not itself bounded. `players/{uid}` validates no field (ADR 0001),
// so two buckets at the maximum are reachable — and they gave their row a
// `2 * MAX_ARCHIVE_NUMBER` podium and email score while the live Leaderboard and
// the frozen record read that same row's ROOT as `MAX_ARCHIVE_NUMBER`. Another
// row therefore tied it on the board and lost to it on the podium: one roster,
// four surfaces, two orders.

/** A schedule that RE-AGGREGATES: `podiumStandingRow` passes the roots through
 *  when nothing is ceremonial, so the sum only exists when something is. */
const REAGGREGATING_SCHEDULE: Array<Pick<DayDef, 'index' | 'pool' | 'tutorial'>> = [
  { index: 0, pool: 'main', tutorial: false },
  { index: 1, pool: 'main', tutorial: false },
  { index: 2, pool: 'farewell', tutorial: false },
];

/** Two rows that tie ONLY once the re-aggregated totals are clamped: one carries
 *  two competitive buckets at the maximum, the other reaches the maximum at its
 *  root and on its single bucket, with more squares. Clamped, the bingos tie and
 *  squares crown `root-max`; unclamped, `two-buckets` scores twice the bound and
 *  outranks every clamped row there can be. Each root is the honest aggregate of
 *  that row's buckets, so the live path clamps it to the same number. */
const TWO_MAXED_BUCKETS: PlayerDoc[] = [
  oversized('two-buckets', 'Two Buckets', {
    bingoCount: 2 * MAX_ARCHIVE_NUMBER,
    squaresMarked: 20,
    firstBingoAt: 100,
    dayStats: {
      0: { bingoCount: MAX_ARCHIVE_NUMBER, squaresMarked: 10, firstBingoAt: 100 },
      1: { bingoCount: MAX_ARCHIVE_NUMBER, squaresMarked: 10, firstBingoAt: 300 },
    },
  }),
  oversized('root-max', 'Root Max', {
    bingoCount: MAX_ARCHIVE_NUMBER,
    squaresMarked: 30,
    firstBingoAt: 200,
    dayStats: { 1: { bingoCount: MAX_ARCHIVE_NUMBER, squaresMarked: 30, firstBingoAt: 200 } },
  }),
];

/** The raw re-aggregation the clamp replaces — the buckets a surface counts,
 *  added up and left alone. Written out here so the defect is pinned as a
 *  NUMBER rather than only as an ordering. */
const rawBucketTotal = (player: PlayerDoc, excluded: ReadonlySet<number>): number =>
  Object.entries(player.dayStats ?? {})
    .filter(([key]) => !excluded.has(Number(key)))
    .reduce((sum, [, stat]) => sum + stat.bingoCount, 0);

describe('client/functions parity — the bound a RE-AGGREGATED total keeps (#1152)', () => {
  it.each([
    0,
    1,
    -1,
    MAX_ARCHIVE_NUMBER,
    -MAX_ARCHIVE_NUMBER,
    MAX_ARCHIVE_NUMBER + 1,
    -MAX_ARCHIVE_NUMBER - 1,
    2 * MAX_ARCHIVE_NUMBER,
    -2 * MAX_ARCHIVE_NUMBER,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('clamps the re-aggregated total %p identically on both sides', (value) => {
    expect(fnsClampReaggregatedTotal(value)).toBe(clampReaggregatedTotal(value));
  });

  it('pins what the shared re-aggregation clamp answers', () => {
    // Both sides regressing together still has to fail, so the answers are
    // stated as well as compared: the bound in both directions, an ordinary
    // total untouched, and `0` for a total no comparator could subtract.
    expect(clampReaggregatedTotal(2 * MAX_ARCHIVE_NUMBER)).toBe(MAX_ARCHIVE_NUMBER);
    expect(clampReaggregatedTotal(-2 * MAX_ARCHIVE_NUMBER)).toBe(-MAX_ARCHIVE_NUMBER);
    expect(clampReaggregatedTotal(7)).toBe(7);
    expect(clampReaggregatedTotal(Number.NaN)).toBe(0);
  });

  it('ranks two maxed buckets the same on both podiums, the email and the live board', () => {
    const ceremonial = new Set([2]);
    const clientPodium = buildPodium(
      asLiveRoster(TWO_MAXED_BUCKETS),
      REAGGREGATING_SCHEDULE as DayDef[],
    );
    const fnsPodium = buildPodiumPayload(
      asReadFinalePlayers(TWO_MAXED_BUCKETS),
      asFinaleDays(REAGGREGATING_SCHEDULE),
    );
    // The email's window is the whole schedule; the ceremonial Day is excluded
    // by policy exactly as the podium excludes it.
    const emailRows = standingsThrough(
      asReadFinalePlayers(TWO_MAXED_BUCKETS),
      3,
      new Set<number>(),
      ceremonial,
    );
    const board = sortPlayers(asLiveRoster(TWO_MAXED_BUCKETS));

    // ONE order, four surfaces: the bingos tie at the bound and squares decide.
    expect(fnsPodium.champion).toEqual(clientPodium.champion);
    expect(clientPodium.champion).toEqual({
      uid: 'root-max',
      displayName: 'Root Max',
      bingoCount: MAX_ARCHIVE_NUMBER,
      squaresMarked: 30,
    });
    expect(emailRows.map((r) => `${r.uid}:${r.bingoCount}/${r.squaresMarked}`)).toEqual([
      `root-max:${MAX_ARCHIVE_NUMBER}/30`,
      `two-buckets:${MAX_ARCHIVE_NUMBER}/20`,
    ]);
    expect(board.map((p) => `${p.uid}:${p.bingoCount}/${p.squaresMarked}`)).toEqual([
      `root-max:${MAX_ARCHIVE_NUMBER}/30`,
      `two-buckets:${MAX_ARCHIVE_NUMBER}/20`,
    ]);
    expect(clientPodium.runnersUp[0]?.uid).toBe('two-buckets');
    expect(clientPodium.runnersUp[0]?.bingoCount).toBe(MAX_ARCHIVE_NUMBER);

    // The UNCLAMPED answer, pinned beside it: the raw sum of the two maxed
    // buckets is twice the bound, so re-aggregating without the clamp put
    // `two-buckets` first on both podiums and in the email while the live board
    // — which ranks the clamped ROOT — kept `root-max` there. That divergence is
    // the finding; asserting the number states it rather than implying it.
    expect(rawBucketTotal(TWO_MAXED_BUCKETS[0], ceremonial)).toBe(2 * MAX_ARCHIVE_NUMBER);
    expect(rawBucketTotal(TWO_MAXED_BUCKETS[1], ceremonial)).toBe(MAX_ARCHIVE_NUMBER);
    expect(rawBucketTotal(TWO_MAXED_BUCKETS[0], ceremonial)).toBeGreaterThan(
      rawBucketTotal(TWO_MAXED_BUCKETS[1], ceremonial),
    );
    expect(board[0].bingoCount).toBe(MAX_ARCHIVE_NUMBER);
  });

  it('bounds a re-aggregated total in the NEGATIVE direction too, on both sides', () => {
    // Counts go negative for the same reason they go oversized — the rules arm
    // validates no field — and an unclamped negative sum sorts a row BELOW every
    // representable one, which is again not where the clamped root puts it.
    const players: PlayerDoc[] = [
      oversized('two-negatives', 'Two Negatives', {
        bingoCount: -2 * MAX_ARCHIVE_NUMBER,
        squaresMarked: 4,
        firstBingoAt: 100,
        dayStats: {
          0: { bingoCount: -MAX_ARCHIVE_NUMBER, squaresMarked: 2, firstBingoAt: 100 },
          1: { bingoCount: -MAX_ARCHIVE_NUMBER, squaresMarked: 2, firstBingoAt: 300 },
        },
      }),
      oversized('root-negative', 'Root Negative', {
        bingoCount: -MAX_ARCHIVE_NUMBER,
        squaresMarked: 1,
        firstBingoAt: 200,
        dayStats: { 1: { bingoCount: -MAX_ARCHIVE_NUMBER, squaresMarked: 1, firstBingoAt: 200 } },
      }),
    ];
    const ceremonial = new Set([2]);
    const clientPodium = buildPodium(asLiveRoster(players), REAGGREGATING_SCHEDULE as DayDef[]);
    const fnsPodium = buildPodiumPayload(
      asReadFinalePlayers(players),
      asFinaleDays(REAGGREGATING_SCHEDULE),
    );
    const emailRows = standingsThrough(
      asReadFinalePlayers(players),
      3,
      new Set<number>(),
      ceremonial,
    );

    expect(fnsPodium.champion).toEqual(clientPodium.champion);
    // Both rows bottom out at -MAX, so squares decide — and the board agrees.
    expect(clientPodium.champion).toEqual({
      uid: 'two-negatives',
      displayName: 'Two Negatives',
      bingoCount: -MAX_ARCHIVE_NUMBER,
      squaresMarked: 4,
    });
    expect(emailRows.map((r) => r.uid)).toEqual(['two-negatives', 'root-negative']);
    expect(sortPlayers(asLiveRoster(players)).map((p) => p.uid)).toEqual([
      'two-negatives',
      'root-negative',
    ]);
    // Unclamped, `two-negatives` sums to twice the negative bound and sorts
    // LAST — the reverse of what every clamped surface answers.
    expect(rawBucketTotal(players[0], ceremonial)).toBe(-2 * MAX_ARCHIVE_NUMBER);
    expect(rawBucketTotal(players[0], ceremonial)).toBeLessThan(
      rawBucketTotal(players[1], ceremonial),
    );
  });
});

// --- The Standings Freeze, resolved once per package ----------------------------
//
// `standingsFreezeAtFor` is the third member of the ADR 0011 mirror family, and
// the daily email's headline cutoff now reads it — so a drift here would let the
// finale freeze an Event at one instant while the email quoted another.

/** A Day carrying the freeze derivation's inputs on both sides. */
type FreezeFixtureDay = Pick<DayDef, 'index' | 'pool'> & { unlockAt: number; scoring?: string };

const FREEZE_CASES: Array<{ name: string; standingsFreezeAt?: number; days?: FreezeFixtureDay[] }> = [
  { name: 'a configured freeze beats the schedule', standingsFreezeAt: 9_000, days: [
    { index: 0, pool: 'main', unlockAt: 1_000 },
    { index: 1, pool: 'main', unlockAt: 2_000, scoring: 'ceremonial' },
  ] },
  { name: 'no configured freeze derives the FIRST ceremonial Day', days: [
    { index: 0, pool: 'main', unlockAt: 1_000 },
    { index: 1, pool: 'main', unlockAt: 2_000, scoring: 'ceremonial' },
    { index: 2, pool: 'main', unlockAt: 3_000, scoring: 'ceremonial' },
  ] },
  { name: 'a legacy closing-pool Day states the policy by its pool', days: [
    { index: 0, pool: 'main', unlockAt: 1_000 },
    { index: 1, pool: 'farewell', unlockAt: 5_000 },
  ] },
  { name: 'the open sentinel schedules no freeze rather than one at the epoch', days: [
    { index: 0, pool: 'closing', unlockAt: 0 },
  ] },
  { name: 'a non-positive configured value falls through to the schedule', standingsFreezeAt: 0, days: [
    { index: 0, pool: 'closing', unlockAt: 2_000 },
  ] },
  { name: 'an all-competitive schedule never freezes on its own', days: [
    { index: 0, pool: 'main', unlockAt: 1_000 },
    { index: 1, pool: 'closing', unlockAt: 2_000, scoring: 'competitive' },
  ] },
  { name: 'an Event with no schedule at all', days: [] },
  { name: 'an Event with no days key at all' },
];

describe('client/functions parity — the Standings Freeze (ADR 0011)', () => {
  it.each(FREEZE_CASES)('agrees on $name', ({ standingsFreezeAt, days }) => {
    const event = { standingsFreezeAt, days };
    expect(fnsStandingsFreezeAtFor(event)).toEqual(
      clientStandingsFreezeAtFor(event as unknown as Parameters<typeof clientStandingsFreezeAtFor>[0]),
    );
  });

  it('agrees on a null/undefined Event', () => {
    expect(fnsStandingsFreezeAtFor(undefined)).toEqual(clientStandingsFreezeAtFor(undefined));
    expect(fnsStandingsFreezeAtFor(null)).toEqual(clientStandingsFreezeAtFor(null));
  });

  it('pins every answer, so a symmetric regression on both sides still fails', () => {
    const answers = FREEZE_CASES.map(({ standingsFreezeAt, days }) =>
      fnsStandingsFreezeAtFor({ standingsFreezeAt, days }),
    );
    expect(answers).toEqual([
      9_000, // configured wins outright
      2_000, // the FIRST ceremonial Day, not the last
      5_000, // the legacy `farewell` spelling of the closing pool
      null, // the `unlockAt: 0` sentinel schedules nothing
      2_000, // a configured 0 is ignored, so the schedule answers
      null, // a stated-competitive closing Day is not ceremonial
      null, // no schedule
      null, // no days key
    ]);
  });
});

// --- The daily email is a third reader of the same policy (#1052) ---------------
//
// The email prints standings and a First-to-BINGO ⭐ at players every morning,
// which makes it a scoring surface — and sent mail is irreversible. It builds
// its snapshot in `dailyEmailContent.ts` rather than through the podium
// builders, so this pins the ANSWER across all three: the email, the client
// podium the Card renders, and the Functions podium the Feed's Moment carries.

/** The freeze this Event configures. Stated rather than derived, because the
 *  ceremonial Day here is an EARLY one — deriving would pull the freeze to Day 1
 *  and end the Event on its second morning. */
const EMAIL_FREEZE = 4_000;

/** One schedule carrying every distinction ADR 0011 draws: a Tutorial Day that
 *  still scores, an EARLY ceremonial Day that is NOT a Tutorial Day, an ordinary
 *  competitive Day, and a legacy closing-pool Day stating no policy at all. */
const EMAIL_SHAPE: FreezeFixtureDay[] = [
  { index: 0, pool: 'easy', unlockAt: 1_000 },
  { index: 1, pool: 'main', unlockAt: 2_000, scoring: 'ceremonial' },
  { index: 2, pool: 'main', unlockAt: 3_000 },
  { index: 3, pool: 'farewell', unlockAt: EMAIL_FREEZE },
];
const EMAIL_TUTORIAL = [true, false, false, false];

/** The same schedule in each package's local Day shape. */
const emailDays = (): EmailDay[] =>
  EMAIL_SHAPE.map((d, i) => ({ ...d, tutorial: EMAIL_TUTORIAL[i] }));
const emailClientDays = (): DayDef[] => emailDays() as unknown as DayDef[];

/** Marks chosen so each policy rule flips a visible answer: Ana holds the
 *  earliest bingo on the Event but on a Tutorial Day; Cera's whole haul is on
 *  the ceremonial Day, which is inert for score and eligible for the honour;
 *  Late's only bingo lands after the freeze. */
const emailPlayer = (
  uid: string,
  displayName: string,
  bingoCount: number,
  squaresMarked: number,
  firstBingoAt: number | null,
  dayStats: PlayerDoc['dayStats'],
): PlayerDoc => ({
  uid,
  displayName,
  photoURL: null,
  joinedAt: 0,
  bingoCount,
  squaresMarked,
  firstBingoAt,
  reshufflesUsed: 0,
  dayStats,
});

function emailRoster(): PlayerDoc[] {
  const p = emailPlayer;
  return [
    p('ana', 'Ana', 2, 22, 500, {
      0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 },
      2: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 500 },
    }),
    p('cera', 'Cera', 0, 3, null, {
      1: { bingoCount: 5, squaresMarked: 50, firstBingoAt: 200 },
      2: { bingoCount: 0, squaresMarked: 3, firstBingoAt: null },
    }),
    p('bo', 'Bo', 1, 10, 300, { 2: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 300 } }),
    p('dee', 'Dee', 1, 5, 600, { 2: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 600 } }),
    p('late', 'Late', 0, 0, null, {
      3: { bingoCount: 1, squaresMarked: 4, firstBingoAt: EMAIL_FREEZE + 500 },
    }),
  ];
}

const asEmailPlayers = (players: readonly PlayerDoc[]): EmailPlayer[] =>
  players.map((p) => ({
    uid: p.uid,
    displayName: p.displayName,
    bingoCount: p.bingoCount,
    squaresMarked: p.squaresMarked,
    firstBingoAt: p.firstBingoAt,
    dayStats: p.dayStats,
  }));

describe('client/functions parity — the daily email standings and ⭐ (#1052)', () => {
  const days = emailDays();
  const players = emailRoster();
  const email = asEmailPlayers(players);
  // Resolved, never hardcoded: the email reads the Event's freeze through the
  // same function the finale does, and this pins that it lands on the same one.
  const freezeAt = fnsStandingsFreezeAtFor({ standingsFreezeAt: EMAIL_FREEZE, days });
  const tutorial = tutorialDayIndexes(days);
  const ceremonial = ceremonialDayIndexes(days);
  // The email mails Day 3, so its window is Days 0-2 — "through yesterday".
  const ranked = standingsThrough(email, 3, tutorial, ceremonial);
  const starUid = eventFirstBingoUid(email, 3, tutorial, freezeAt);

  it('resolves the same policy sets on both sides of the package boundary', () => {
    expect(freezeAt).toBe(EMAIL_FREEZE);
    expect(sorted(tutorial)).toEqual(sorted(tutorialDayIndexSet(emailClientDays())));
    expect(sorted(ceremonial)).toEqual(sorted(ceremonialDayIndexSet(emailClientDays())));
    expect(sorted(tutorial)).toEqual([0]);
    // Day 1 states it; Day 3 inherits it from the legacy closing pool.
    expect(sorted(ceremonial)).toEqual([1, 3]);
  });

  it('ranks the email standings exactly as both podiums rank them', () => {
    const client = buildPodium(players, emailClientDays(), undefined, true, EMAIL_FREEZE);
    const fns = buildPodiumPayload(
      asFinalePlayers(players),
      emailDays() as unknown as FinaleDay[],
      [],
      EMAIL_FREEZE,
    );
    expect(fns.champion).toEqual(client.champion);

    const podiumTop = [client.champion, ...client.runnersUp].map(
      (r) => `${r?.uid}:${r?.bingoCount}/${r?.squaresMarked}`,
    );
    const emailTop = ranked
      .slice(0, 3)
      .map((r) => `${r.uid}:${r.bingoCount}/${r.squaresMarked}`);
    expect(emailTop).toEqual(podiumTop);
    // Pin the answer too, so a symmetric regression on all three still fails:
    // Cera's 5 ceremonial bingos count nowhere, and Ana's Tutorial-Day bingo
    // and squares count everywhere.
    expect(emailTop).toEqual(['ana:2/22', 'bo:1/10', 'dee:1/5']);
  });

  it('gives the email, the podium and the Leaderboard pin ONE First to BINGO', () => {
    const client = buildPodium(players, emailClientDays(), undefined, true, EMAIL_FREEZE);
    const fns = buildPodiumPayload(
      asFinalePlayers(players),
      emailDays() as unknown as FinaleDay[],
      [],
      EMAIL_FREEZE,
    );
    const pin = cruiseFirstBingoUid(players, (i) => tutorial.has(i), EMAIL_FREEZE);

    expect(fns.firstBingo).toEqual(client.firstBingo);
    expect(starUid).toBe(client.firstBingo?.uid);
    expect(starUid).toBe(pin);
    // The honour belongs to the ceremonial, non-Tutorial Day's bingo — inert for
    // score, eligible for the headline — while Ana's numerically earlier
    // Tutorial-Day bingo takes nothing and Late's post-freeze one is cut off.
    expect(client.firstBingo).toEqual({ uid: 'cera', displayName: 'Cera', at: 200 });
  });

  it('breaks an exact ⭐ tie identically on both sides, whatever order each sees', () => {
    // The one input the two views can never share is roster ORDER: the email
    // resolves the honour over a through-yesterday window, while the in-app pin
    // and the podium resolve it over live root totals that include today's
    // marks. So a Player marking today's card before a delayed or retried send
    // used to flip which of two tied Players each surface starred (Codex P2,
    // #1052). Both selectors now break the tie on uid, ascending.
    //
    // Uids chosen so the stable answer disagrees with every ordering in play:
    // `zed` leads the standings, `ace` sorts first by uid, and Day 2 is the
    // ordinary competitive Day, so both bingos are eligible and pre-freeze.
    const TIE = 250;
    const tied: PlayerDoc[] = [
      emailPlayer('zed', 'Zed', 2, 20, TIE, {
        2: { bingoCount: 2, squaresMarked: 20, firstBingoAt: TIE },
      }),
      emailPlayer('ace', 'Ace', 1, 5, TIE, {
        2: { bingoCount: 1, squaresMarked: 5, firstBingoAt: TIE },
      }),
    ];
    const reversed = [...tied].reverse();
    const isTutorial = (i: number) => tutorial.has(i);

    // Email — either query order, and the standings-ordered rows.
    expect(eventFirstBingoUid(asEmailPlayers(tied), 3, tutorial, freezeAt)).toBe('ace');
    expect(eventFirstBingoUid(asEmailPlayers(reversed), 3, tutorial, freezeAt)).toBe('ace');
    expect(
      eventFirstBingoUid(
        standingsThrough(asEmailPlayers(tied), 3, tutorial, ceremonial),
        3,
        tutorial,
        freezeAt,
      ),
    ).toBe('ace');

    // In-app pin and both podiums, from the same roster in either order.
    expect(cruiseFirstBingoUid(tied, isTutorial, EMAIL_FREEZE)).toBe('ace');
    expect(cruiseFirstBingoUid(reversed, isTutorial, EMAIL_FREEZE)).toBe('ace');
    expect(buildPodium(tied, emailClientDays(), undefined, true, EMAIL_FREEZE).firstBingo).toEqual({
      uid: 'ace',
      displayName: 'Ace',
      at: TIE,
    });
    expect(
      buildPodiumPayload(
        asFinalePlayers(tied),
        emailDays() as unknown as FinaleDay[],
        [],
        EMAIL_FREEZE,
      ).firstBingo,
    ).toEqual({ uid: 'ace', displayName: 'Ace', at: TIE });

    // …while the ranking still puts `zed` first on both sides, which is what
    // proves the honour stopped riding on whatever order it was handed.
    expect(standingsThrough(asEmailPlayers(tied), 3, tutorial, ceremonial).map((r) => r.uid)).toEqual([
      'zed',
      'ace',
    ]);
    expect(buildPodium(tied, emailClientDays(), undefined, true, EMAIL_FREEZE).champion?.uid).toBe('zed');
  });

  // #1152, Codex P2 on PR #1165. The email was the ONE ranking path still reading
  // raw Player-written numbers: `useLeaderboard` and `draftEventArchive` clamp
  // before they rank, `readFinaleRoster` was fixed to, and `standingsThrough` /
  // `headlineFirstBingoAt` still accepted anything FINITE. `players/{uid}`
  // validates no field (ADR 0001), so that is a reachable roster — and sent mail
  // is irreversible. `readEmailRosterPage` now maps every row through the same
  // normaliser, which is what these two compare.
  //
  // The marks sit on Day 2 alone — the ordinary competitive Day — with each row's
  // roots matching its bucket, so the email's summed WINDOW and the podium's
  // root passthrough are answering the same question about the same numbers.
  const OVERSIZED: PlayerDoc[] = [
    emailPlayer('zed', 'Zed', MAX_ARCHIVE_NUMBER + 2_000, 20, -(MAX_ARCHIVE_NUMBER + 2_000), {
      2: {
        bingoCount: MAX_ARCHIVE_NUMBER + 2_000,
        squaresMarked: 20,
        firstBingoAt: -(MAX_ARCHIVE_NUMBER + 2_000),
      },
    }),
    emailPlayer('ace', 'Ace', MAX_ARCHIVE_NUMBER + 1_000, 30, -(MAX_ARCHIVE_NUMBER + 1_000), {
      2: {
        bingoCount: MAX_ARCHIVE_NUMBER + 1_000,
        squaresMarked: 30,
        firstBingoAt: -(MAX_ARCHIVE_NUMBER + 1_000),
      },
    }),
  ];

  it('ranks an oversized roster in the email exactly as both podiums rank it', () => {
    const read = asReadFinalePlayers(OVERSIZED);
    const rows = standingsThrough(read, 3, tutorial, ceremonial);
    const clientPodium = buildPodium(
      asLiveRoster(OVERSIZED),
      emailClientDays(),
      undefined,
      true,
      EMAIL_FREEZE,
    );

    // Both counts clamp to the bound, so the bingos tie and squares decide.
    expect(rows.map((r) => `${r.uid}:${r.bingoCount}/${r.squaresMarked}`)).toEqual([
      `ace:${MAX_ARCHIVE_NUMBER}/30`,
      `zed:${MAX_ARCHIVE_NUMBER}/20`,
    ]);
    expect(clientPodium.champion).toEqual({
      uid: 'ace',
      displayName: 'Ace',
      bingoCount: MAX_ARCHIVE_NUMBER,
      squaresMarked: 30,
    });
    expect(rows[0].uid).toBe(clientPodium.champion?.uid);

    // An unnormalised BUCKET no longer reorders this pair, because the window
    // total is clamped inside `standingsThrough` too (#1152, Codex P2 on PR
    // #1165 round 8) — the second line the function's own contract describes,
    // holding. Pinned so a regression that removes THAT clamp fails here.
    expect(
      standingsThrough(asEmailPlayers(OVERSIZED), 3, tutorial, ceremonial).map((r) => r.uid),
    ).toEqual(['ace', 'zed']);

    // What the read boundary is still the only line for is a row with NO
    // breakdown in the window: `standingsThrough` has nothing to re-aggregate
    // and reports the ROOT it was handed, so dropping the map there leads the
    // email with a count no other surface reads.
    const stripped = (rows: readonly EmailPlayer[]): EmailPlayer[] =>
      rows.map((r) => ({ ...r, dayStats: undefined }));
    expect(
      standingsThrough(stripped(asReadFinalePlayers(OVERSIZED)), 3, tutorial, ceremonial).map(
        (r) => r.uid,
      ),
    ).toEqual(['ace', 'zed']);
    expect(
      standingsThrough(stripped(asEmailPlayers(OVERSIZED)), 3, tutorial, ceremonial).map(
        (r) => r.uid,
      ),
    ).toEqual(['zed', 'ace']);
  });

  it('stars the same Player as the client when both first-bingo stamps are out of bounds', () => {
    const read = asReadFinalePlayers(OVERSIZED);
    const pin = cruiseFirstBingoUid(asLiveRoster(OVERSIZED), (i) => tutorial.has(i), EMAIL_FREEZE);

    // Both stamps clamp to the bound, so the honour ties on the instant and the
    // shared uid key (ascending) decides — on every surface at once.
    expect(eventFirstBingoUid(read, 3, tutorial, freezeAt)).toBe('ace');
    expect(eventFirstBingoUid(read, 3, tutorial, freezeAt)).toBe(pin);
    expect(
      buildPodiumPayload(
        asReadFinalePlayers(OVERSIZED),
        emailDays() as unknown as FinaleDay[],
        [],
        EMAIL_FREEZE,
      ).firstBingo,
    ).toEqual({ uid: 'ace', displayName: 'Ace', at: -MAX_ARCHIVE_NUMBER });

    // Raw, Zed's more-negative stamp reads as "earlier" and the email stars a
    // Player no other surface does.
    expect(eventFirstBingoUid(asEmailPlayers(OVERSIZED), 3, tutorial, freezeAt)).toBe('zed');
  });

  it('keeps the ⭐ holder in the email snapshot at her true rank', () => {
    // Cera ranks 4th precisely BECAUSE her score is ceremonial, so the append is
    // what stops the email claiming there is no First to BINGO while the Card
    // shows one (specs/daily-engagement-email.md § Ranking parity).
    const rows = standingsRows(ranked, starUid);
    expect(rows.map((r) => `${r.rank}:${r.uid}:${r.starred}`)).toEqual([
      '1:ana:false',
      '2:bo:false',
      '3:dee:false',
      '4:cera:true',
    ]);
  });
});
