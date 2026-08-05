import { describe, it, expect } from 'vitest';
import {
  sumDayStats,
  eventFirstBingoAt,
  aggregatePlayerStats,
  foldDayStat,
  tutorialDayIndexSet,
  perDayHonors,
  effectiveCruiseFirstBingoAt,
  cruiseFirstBingoUid,
  sortPlayers,
  type DayStats,
} from './logic';
import type { DayDef, PlayerDoc } from '../types';

// specs/d15-scoring-aggregates.md — pure unit layer. The cruise-wide scoring
// aggregation is the correctness-critical core this ticket owns: bingos/squares
// summed across every Day Card, First to BINGO restricted to the main-game Days
// (embark/farewell excluded), and the tie-break ORDER left unchanged over those
// aggregated inputs.

// Days 0 (embark) and 9 (farewell) are the tutorial Days for the ten-Day sailing;
// 1..8 are main-game. The exclusion predicate is derived from this schedule.
const days: DayDef[] = Array.from({ length: 10 }, (_, index) => ({
  index,
  date: '2026-07-16',
  port: 'Port',
  portEmoji: '🇭🇷',
  theme: 'neon-playground',
  tonight: [],
  pool: index === 0 ? 'embark' : index === 9 ? 'farewell' : 'main',
  tutorial: index === 0 || index === 9,
  unlockAt: 0,
}));
const isTutorialDay = (i: number) => tutorialDayIndexSet(days).has(i);

function mkPlayer(uid: string, dayStats: DayStats, over: Partial<PlayerDoc> = {}): PlayerDoc {
  const root = aggregatePlayerStats(dayStats, isTutorialDay);
  return {
    uid,
    displayName: uid,
    photoURL: null,
    joinedAt: 0,
    bingoCount: root.bingoCount,
    squaresMarked: root.squaresMarked,
    firstBingoAt: root.firstBingoAt,
    reshufflesUsed: 0,
    dayStats,
    ...over,
  };
}

describe('tutorialDayIndexSet', () => {
  it('collects only the tutorial Day indexes from the schedule', () => {
    expect([...tutorialDayIndexSet(days)].sort((a, b) => a - b)).toEqual([0, 9]);
    expect(tutorialDayIndexSet(undefined).size).toBe(0);
    expect(tutorialDayIndexSet([]).size).toBe(0);
  });
});

describe('sumDayStats (aggregate-sum)', () => {
  it("sums a Player's dayStats across 3 Day Cards into cruise-wide totals", () => {
    const dayStats: DayStats = {
      1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 1000 },
      3: { bingoCount: 2, squaresMarked: 9, firstBingoAt: 2000 },
      7: { bingoCount: 0, squaresMarked: 4, firstBingoAt: null },
    };
    expect(sumDayStats(dayStats)).toEqual({ bingoCount: 3, squaresMarked: 18 });
  });

  it('counts the embark (tutorial) card toward the summed totals', () => {
    const dayStats: DayStats = {
      0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 500 }, // embark
      2: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 3000 },
    };
    // Squares/bingos from the embark card DO count — it is easy but real play.
    expect(sumDayStats(dayStats)).toEqual({ bingoCount: 2, squaresMarked: 18 });
  });

  it('is empty for an absent breakdown', () => {
    expect(sumDayStats(undefined)).toEqual({ bingoCount: 0, squaresMarked: 0 });
  });
});

describe('eventFirstBingoAt (tutorial-exclusion)', () => {
  it('ignores an embark-day (index 0) firstBingoAt even when it is earliest', () => {
    const dayStats: DayStats = {
      0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 }, // earliest, but embark
      2: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 900 },
    };
    expect(eventFirstBingoAt(dayStats, isTutorialDay)).toBe(900);
  });

  it('ignores a farewell-day (index 9) firstBingoAt even when it is earliest', () => {
    const dayStats: DayStats = {
      9: { bingoCount: 1, squaresMarked: 24, firstBingoAt: 50 }, // farewell, ceremonial
      4: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 700 },
    };
    expect(eventFirstBingoAt(dayStats, isTutorialDay)).toBe(700);
  });

  it('a Days-2–9 entry wins normally, taking the earliest across main-game Days', () => {
    const dayStats: DayStats = {
      3: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 800 },
      5: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 400 },
    };
    expect(eventFirstBingoAt(dayStats, isTutorialDay)).toBe(400);
  });

  it('is null when only tutorial Days carry a first bingo', () => {
    const dayStats: DayStats = {
      0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 },
      9: { bingoCount: 1, squaresMarked: 24, firstBingoAt: 200 },
    };
    expect(eventFirstBingoAt(dayStats, isTutorialDay)).toBeNull();
  });
});

describe('aggregatePlayerStats', () => {
  it('is the cruise-wide root shape: summed bingos/squares, tutorial-excluded first-bingo', () => {
    const dayStats: DayStats = {
      0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 }, // embark
      2: { bingoCount: 2, squaresMarked: 9, firstBingoAt: 900 },
    };
    expect(aggregatePlayerStats(dayStats, isTutorialDay)).toEqual({
      bingoCount: 3,
      squaresMarked: 21,
      firstBingoAt: 900, // embark's 100 excluded
    });
  });
});

describe('foldDayStat (fold into dayStats[dayIndex])', () => {
  it('writes the marked Day bucket and leaves other Days untouched', () => {
    const prior: DayStats = {
      2: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 500 },
    };
    const folded = foldDayStat({
      priorDayStats: prior,
      dayIndex: 4,
      bucket: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 800 },
      blackout: false,
      isTutorialDay,
    });
    // The write is a nested partial for ONLY the marked Day (a { merge:true }
    // write preserves every other Day server-side).
    expect(folded.dayStats).toEqual({ 4: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 800 } });
    // The root re-derives over the merged view (prior Day 2 + this Day 4).
    expect(folded.bingoCount).toBe(2);
    expect(folded.squaresMarked).toBe(10);
    expect(folded.firstBingoAt).toBe(500);
    expect(folded.blackout).toBe(false);
  });

  it('OMITS firstBingoAt (day + root) when the bucket omitted it and no prior stamp exists', () => {
    // computeMark omits firstBingoAt on an unknown-while-standing further mark
    // (#75); with no prior Day stamp there is nothing to write, so the merge
    // preserves whatever the server holds.
    const folded = foldDayStat({
      priorDayStats: undefined,
      dayIndex: 3,
      bucket: { bingoCount: 1, squaresMarked: 6 }, // no firstBingoAt key
      blackout: false,
      isTutorialDay,
    });
    expect('firstBingoAt' in folded.dayStats[3]).toBe(false);
    expect('firstBingoAt' in folded).toBe(false);
    expect(folded.bingoCount).toBe(1);
    expect(folded.squaresMarked).toBe(6);
  });

  it("keeps a Day's own earlier stamp when the bucket omits firstBingoAt", () => {
    const prior: DayStats = { 3: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 400 } };
    const folded = foldDayStat({
      priorDayStats: prior,
      dayIndex: 3,
      bucket: { bingoCount: 1, squaresMarked: 6 }, // omit — a further mark while the bingo stands
      blackout: false,
      isTutorialDay,
    });
    expect(folded.dayStats[3]).toEqual({ bingoCount: 1, squaresMarked: 6, firstBingoAt: 400 });
    expect(folded.firstBingoAt).toBe(400);
  });

  it('excludes a tutorial Day from the derived root first-bingo while summing its squares', () => {
    const folded = foldDayStat({
      priorDayStats: { 2: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 900 } },
      dayIndex: 0, // embark
      bucket: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 },
      blackout: false,
      isTutorialDay,
    });
    expect(folded.bingoCount).toBe(2);
    expect(folded.squaresMarked).toBe(18);
    expect(folded.firstBingoAt).toBe(900); // embark's 100 excluded from the honor
  });
});

describe('perDayHonors', () => {
  it("pins each Day's earliest-first-bingo Player, sorted by Day, tutorial Days included", () => {
    const a = mkPlayer('a', {
      0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 }, // embark honor
      2: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 900 },
    });
    const b = mkPlayer('b', {
      2: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 500 }, // earlier than a on Day 2
      3: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 700 },
    });
    expect(perDayHonors([a, b])).toEqual([
      { dayIndex: 0, uid: 'a', displayName: 'a', firstBingoAt: 100 },
      { dayIndex: 2, uid: 'b', displayName: 'b', firstBingoAt: 500 },
      { dayIndex: 3, uid: 'b', displayName: 'b', firstBingoAt: 700 },
    ]);
  });

  it('is empty when no Player has bingoed on any Day', () => {
    const a = mkPlayer('a', { 2: { bingoCount: 0, squaresMarked: 3, firstBingoAt: null } });
    expect(perDayHonors([a])).toEqual([]);
  });
});

describe('cruiseFirstBingoUid / effectiveCruiseFirstBingoAt', () => {
  it('never lands the cruise pin on an embark/farewell-only first bingo', () => {
    const early = mkPlayer('early', {
      0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 10 }, // embark only
    });
    const main = mkPlayer('main', {
      4: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 999 },
    });
    // `early` bingoed first in wall-clock terms, but only on the embark card.
    expect(effectiveCruiseFirstBingoAt(early, isTutorialDay)).toBeNull();
    expect(cruiseFirstBingoUid([early, main], isTutorialDay)).toBe('main');
  });

  it('falls back to the legacy root firstBingoAt for a roster with no dayStats', () => {
    const legacy: PlayerDoc = {
      uid: 'legacy',
      displayName: 'Legacy',
      photoURL: null,
      joinedAt: 0,
      bingoCount: 1,
      squaresMarked: 5,
      firstBingoAt: 1234,
      reshufflesUsed: 0,
    };
    expect(effectiveCruiseFirstBingoAt(legacy, isTutorialDay)).toBe(1234);
    expect(cruiseFirstBingoUid([legacy], isTutorialDay)).toBe('legacy');
  });
});

describe('tie-break over aggregated totals (order unchanged)', () => {
  it('orders by bingos desc, then squares desc, then earliest cruise first-bingo', () => {
    // Each Player's root fields are the aggregate over their dayStats (mkPlayer).
    const topBingos = mkPlayer('top', {
      2: { bingoCount: 2, squaresMarked: 10, firstBingoAt: 5000 },
      3: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 6000 },
    }); // 3 bingos
    const moreSquares = mkPlayer('squares', {
      4: { bingoCount: 1, squaresMarked: 20, firstBingoAt: 4000 },
    }); // 1 bingo, 20 squares
    const earlier = mkPlayer('earlier', {
      5: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 1000 }, // earliest first-bingo
    }); // 1 bingo, 6 squares
    const later = mkPlayer('later', {
      6: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 3000 },
    }); // 1 bingo, 6 squares, later
    const ordered = sortPlayers([later, earlier, moreSquares, topBingos]).map((p) => p.uid);
    expect(ordered).toEqual(['top', 'squares', 'earlier', 'later']);
  });
});
