import { describe, it, expect } from 'vitest';
import { buildPodium, finaleDayIndex, finalePinIndex } from './finale';
import type { DayDef, PlayerDoc } from '../types';

// Fixtures (#217, specs/d15-finale.md): a 3-Day cruise — embark (Day 0,
// tutorial), one main Day (Day 1), farewell (Day 2, tutorial). Day indexes
// match array positions here, but the pin/exclusion logic keys on `pool` and
// `DayDef.index`, never the array slot, so the two are exercised independently.
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function day(overrides: Partial<DayDef> & Pick<DayDef, 'index' | 'pool'>): DayDef {
  return {
    date: '2026-07-16',
    place: 'Split',
    placeEmoji: '🇭🇷',
    theme: 'neon-playground',
    tonight: [],
    tutorial: overrides.pool !== 'main',
    unlockAt: NOW - HOUR,
    ...overrides,
  };
}

const DAYS: DayDef[] = [
  day({ index: 0, pool: 'easy' }),
  day({ index: 1, pool: 'main' }),
  day({ index: 2, pool: 'closing' }),
];

function player(overrides: Partial<PlayerDoc> & Pick<PlayerDoc, 'uid'>): PlayerDoc {
  return {
    displayName: overrides.uid,
    photoURL: null,
    joinedAt: NOW,
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    reshufflesUsed: 0,
    ...overrides,
  };
}

// ADR 0011 (Codex P1, PR #841): ONE answer to "which Day is the finale", read
// by both the default-view pin and the podium's mount gate in Board.tsx. Those
// two used to disagree by construction — the pin resolved the closing Day while
// the mount re-inferred it from `viewedDay.pool === 'closing'` — so a schedule
// stating its ceremonial Day on another pool pinned a Player to a Day that then
// rendered no podium at all.
describe('finaleDayIndex — the one definition of the finale Day', () => {
  it('is the first ceremonial Day when the schedule has one', () => {
    expect(finaleDayIndex(DAYS)).toBe(2);
  });

  it('falls back to the LAST Day when no Day is ceremonial', () => {
    expect(finaleDayIndex([DAYS[0], DAYS[1], day({ index: 2, pool: 'main' })])).toBe(2);
  });

  it('follows the stated policy onto a non-closing pool', () => {
    const days = [DAYS[0], day({ index: 1, pool: 'main', scoring: 'ceremonial' }), day({ index: 2, pool: 'main' })];
    expect(finaleDayIndex(days)).toBe(1);
  });

  it('is -1 when there are no Days', () => {
    expect(finaleDayIndex([])).toBe(-1);
    expect(finaleDayIndex(undefined)).toBe(-1);
  });

  it('agrees with finalePinIndex whenever the pin resolves', () => {
    for (const days of [
      DAYS,
      [DAYS[0], DAYS[1], day({ index: 2, pool: 'main' })],
      [DAYS[0], day({ index: 1, pool: 'main', scoring: 'ceremonial' }), day({ index: 2, pool: 'main' })],
    ]) {
      expect(finalePinIndex(days, NOW, NOW)).toBe(finaleDayIndex(days));
    }
  });
});

describe('finalePinIndex — default-view pin (never before the freeze)', () => {
  it('returns null when frozenAt is unset, even with the closing Day unlocked', () => {
    expect(finalePinIndex(DAYS, undefined, NOW)).toBeNull();
    expect(finalePinIndex(DAYS, null, NOW)).toBeNull();
  });

  it('returns null when frozen but the ceremonial Day is still locked', () => {
    const lockedFarewell = [DAYS[0], DAYS[1], day({ index: 2, pool: 'closing', unlockAt: NOW + HOUR })];
    expect(finalePinIndex(lockedFarewell, NOW, NOW)).toBeNull();
  });

  it('pins the ceremonial array index once frozen AND unlocked', () => {
    expect(finalePinIndex(DAYS, NOW, NOW)).toBe(2);
  });

  it('returns null when there are no Days at all', () => {
    expect(finalePinIndex([], NOW, NOW)).toBeNull();
    expect(finalePinIndex(undefined, NOW, NOW)).toBeNull();
  });

  // ADR 0011: an Event whose final morning is real competitive play has no
  // ceremonial card to pin, and falling back to "today" would drop a returning
  // Player onto a Day the schedule no longer has. The podium is posted on the
  // last Day in that shape, so that is where the pin lands.
  it('pins the LAST Day when the schedule is all competitive', () => {
    const allCompetitive = [DAYS[0], DAYS[1], day({ index: 2, pool: 'main' })];
    expect(finalePinIndex(allCompetitive, NOW, NOW)).toBe(2);
  });

  // …and it still respects the unlock gate in that shape.
  it('returns null when the all-competitive last Day is still locked', () => {
    const lockedLast = [DAYS[0], DAYS[1], day({ index: 2, pool: 'main', unlockAt: NOW + HOUR })];
    expect(finalePinIndex(lockedLast, NOW, NOW)).toBeNull();
  });

  // A stated `scoring` beats the pool it deals: a closing-pool Day that is
  // explicitly competitive is not the ceremonial card, so the pin falls through
  // to the last-Day rule (which here is that same Day, by position).
  it('pins by stated scoring, not by pool', () => {
    const competitiveClose = [
      DAYS[0],
      day({ index: 1, pool: 'closing', scoring: 'competitive', unlockAt: NOW - HOUR }),
      day({ index: 2, pool: 'main', unlockAt: NOW - HOUR }),
    ];
    expect(finalePinIndex(competitiveClose, NOW, NOW)).toBe(2);
  });
});

describe('buildPodium — champion, First to BINGO, honors', () => {
  it('names the top of the standings as champion', () => {
    const players = [
      player({ uid: 'alice', bingoCount: 3, squaresMarked: 20, firstBingoAt: NOW }),
      player({ uid: 'bob', bingoCount: 1, squaresMarked: 12, firstBingoAt: NOW + HOUR }),
    ];
    const podium = buildPodium(players, DAYS);
    expect(podium.champion?.uid).toBe('alice');
    expect(podium.champion?.bingoCount).toBe(3);
  });

  it('returns a null champion for an empty board (nobody marked anything)', () => {
    const podium = buildPodium([player({ uid: 'ghost' })], DAYS);
    expect(podium.champion).toBeNull();
  });

  it('excludes an embark/farewell-only first-bingo from the cruise-wide honor', () => {
    // Tammy bingoed earliest — but only on the embark (tutorial) Day, so she must
    // NOT win the cruise-wide First to BINGO; Gary's main-game bingo wins.
    const players = [
      player({
        uid: 'tammy',
        bingoCount: 1,
        squaresMarked: 24,
        firstBingoAt: NOW,
        dayStats: { 0: { bingoCount: 1, squaresMarked: 24, firstBingoAt: NOW } },
      }),
      player({
        uid: 'gary',
        bingoCount: 1,
        squaresMarked: 10,
        firstBingoAt: NOW + HOUR,
        dayStats: { 1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: NOW + HOUR } },
      }),
    ];
    const podium = buildPodium(players, DAYS);
    expect(podium.firstBingo?.uid).toBe('gary');
    expect(podium.firstBingo?.at).toBe(NOW + HOUR);
  });

  it('excludes the ceremonial farewell Day from the champion standings', () => {
    // Fran only "leads" on root totals because of a big farewell-Day haul (a
    // post-freeze goodbye card). Excluding the farewell Day, Ed is champion.
    const players = [
      player({
        uid: 'fran',
        bingoCount: 5,
        squaresMarked: 40,
        firstBingoAt: NOW,
        dayStats: {
          1: { bingoCount: 1, squaresMarked: 8, firstBingoAt: NOW },
          2: { bingoCount: 4, squaresMarked: 32, firstBingoAt: NOW + HOUR },
        },
      }),
      player({
        uid: 'ed',
        bingoCount: 2,
        squaresMarked: 20,
        firstBingoAt: NOW + HOUR,
        dayStats: { 1: { bingoCount: 2, squaresMarked: 20, firstBingoAt: NOW + HOUR } },
      }),
    ];
    const podium = buildPodium(players, DAYS);
    expect(podium.champion?.uid).toBe('ed');
    // Fran's farewell haul is frozen out of the standings totals.
    expect(podium.champion?.bingoCount).toBe(2);
  });

  it('lists each Day’s pinned honor, sorted by Day index', () => {
    const players = [
      player({
        uid: 'alice',
        bingoCount: 2,
        squaresMarked: 20,
        firstBingoAt: NOW,
        dayStats: {
          1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: NOW },
          0: { bingoCount: 1, squaresMarked: 10, firstBingoAt: NOW - HOUR },
        },
      }),
    ];
    const podium = buildPodium(players, DAYS);
    expect(podium.dailyHonors.map((h) => h.dayIndex)).toEqual([0, 1]);
    expect(podium.dailyHonors.every((h) => h.displayName === 'alice')).toBe(true);
  });

  it('uses day-meta pinned honors in the farewell podium when available', () => {
    const players = [
      player({
        uid: 'alice',
        bingoCount: 1,
        squaresMarked: 10,
        firstBingoAt: NOW,
        dayStats: { 1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: NOW } },
      }),
    ];
    const metas = new Map([[1, { firstBingo: { uid: 'alice', displayName: 'Pinned Parker', at: NOW + HOUR } }]]);
    const podium = buildPodium(players, DAYS, metas);
    expect(podium.dailyHonors).toEqual([
      { dayIndex: 1, uid: 'alice', displayName: 'Pinned Parker', firstBingoAt: NOW + HOUR },
    ]);
  });

  it('hides a pinned honor whose uid is absent from the filtered podium roster', () => {
    const players = [
      player({
        uid: 'alice',
        bingoCount: 1,
        squaresMarked: 10,
        firstBingoAt: NOW,
        dayStats: { 1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: NOW } },
      }),
    ];
    const metas = new Map([[1, { firstBingo: { uid: 'banned', displayName: 'Banned Blair', at: NOW - HOUR } }]]);
    const podium = buildPodium(players, DAYS, metas);
    expect(podium.dailyHonors).toEqual([]);
  });

  it('does not use derived daily honors while day-meta pins are still loading', () => {
    const players = [
      player({
        uid: 'alice',
        bingoCount: 1,
        squaresMarked: 10,
        firstBingoAt: NOW,
        dayStats: { 1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: NOW } },
      }),
    ];
    const podium = buildPodium(players, DAYS, new Map(), false);
    expect(podium.dailyHonors).toEqual([]);
  });
});
