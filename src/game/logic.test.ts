import { describe, it, expect } from 'vitest';
import {
  LINES,
  dealBoard,
  dayDealState,
  hasBingo,
  isBlackout,
  countMarked,
  winningCells,
  bingoLineEdge,
  sortPlayers,
  comparePlayers,
  CENTER,
  type DealItem,
  standingsFrozen,
} from './logic';

const pool: DealItem[] = Array.from({ length: 32 }, (_, i) => ({
  id: `i${i}`,
  text: `prompt ${i}`,
  spicy: false,
}));

describe('LINES', () => {
  it('has 12 winning lines of 5', () => {
    expect(LINES).toHaveLength(12);
    for (const l of LINES) expect(l).toHaveLength(5);
  });
});

describe('dealBoard', () => {
  it('produces 25 cells with a free, pre-marked center', () => {
    const cells = dealBoard(pool, 'FREE', 123);
    expect(cells).toHaveLength(25);
    expect(cells[CENTER].free).toBe(true);
    expect(cells[CENTER].marked).toBe(true);
    expect(cells[CENTER].text).toBe('FREE');
  });

  it('is deterministic for a given seed and varies across seeds', () => {
    const a = dealBoard(pool, 'FREE', 42).map((c) => c.itemId);
    const b = dealBoard(pool, 'FREE', 42).map((c) => c.itemId);
    const c = dealBoard(pool, 'FREE', 43).map((x) => x.itemId);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('draws 24 unique prompts + null center', () => {
    const ids = dealBoard(pool, 'FREE', 7).filter((c) => !c.free).map((c) => c.itemId);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
  });

  it('throws when the active pool has fewer than 24 prompts', () => {
    // Guard at logic.ts: a board needs 24 non-free prompts; a smaller pool would
    // leave blank cells, so dealBoard must fail fast rather than persist a broken
    // board. 23 is the boundary just under the minimum.
    const tooFew = pool.slice(0, 23);
    expect(tooFew).toHaveLength(23);
    expect(() => dealBoard(tooFew, 'FREE', 1)).toThrow(/at least 24 prompts/);
  });
});

describe('dealBoard — per-Day sampling (d15-dealing)', () => {
  // A 60-item mixed pool so exclusion has room to work: 24 spicy + 36 tame.
  const mixed: DealItem[] = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    text: `prompt ${i}`,
    spicy: i < 24,
  }));

  it('draws no id already in excludeIds when the pool has room after exclusion', () => {
    // Exclude the first 20 ids: 40 remain (>= MIN_POOL), so the exclusion holds
    // and none of the 20 can land on the card (no-repeat-across-the-cruise).
    const excludeIds = new Set(mixed.slice(0, 20).map((p) => p.id));
    const ids = dealBoard(mixed, 'FREE', 11, 0.4, { excludeIds })
      .filter((c) => !c.free)
      .map((c) => c.itemId);
    expect(ids).toHaveLength(24);
    for (const id of ids) expect(excludeIds.has(id as string)).toBe(false);
  });

  it('resets the exclusion when honoring it would fall under MIN_POOL', () => {
    // Exclude 40 of 60 → only 20 remain, under MIN_POOL (24). The exclusion must
    // reset to the full pool (pool-exhaustion reset) rather than throwing, so the
    // deal still yields a full 24 — and now excluded ids MAY reappear.
    const excludeIds = new Set(mixed.slice(0, 40).map((p) => p.id));
    const ids = dealBoard(mixed, 'FREE', 12, 0.4, { excludeIds })
      .filter((c) => !c.free)
      .map((c) => c.itemId);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    // With only 20 non-excluded ids, a full 24-card is impossible without reusing
    // excluded ones — proof the exclusion actually reset.
    const reused = ids.filter((id) => excludeIds.has(id as string));
    expect(reused.length).toBeGreaterThan(0);
  });

  it('deals 24 unstratified from an all-tame tutorial pool without starvation', () => {
    // Embark/farewell snapshots are all-tame; stratify:false must not force a
    // spicy target against them. A 30-item all-tame pool deals a full 24.
    const allTame: DealItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      text: `tame ${i}`,
      spicy: false,
    }));
    const ids = dealBoard(allTame, 'FREE', 13, 0.4, { stratify: false })
      .filter((c) => !c.free)
      .map((c) => c.itemId);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
  });
});

describe('dayDealState (d15-dealing deal gate)', () => {
  const base = { unlockAt: 1000, snapshotItemIds: ['a', 'b'], now: 2000, hasBoard: false };

  it('is locked before unlockAt', () => {
    expect(dayDealState({ ...base, now: 500 })).toBe('locked');
  });

  it('is waking only when the snapshot is ABSENT (mirrors isDueForSnapshot)', () => {
    expect(dayDealState({ ...base, snapshotItemIds: undefined })).toBe('waking');
  });

  it('is ready (not waking) when a Day is stamped with an EMPTY pool — no forever-wait', () => {
    // isDueForSnapshot treats [] as already-stamped, so [] must NOT class as
    // waking or the client waits on a scheduler write that never comes; it falls
    // through to the deal path's thin-pool failure instead.
    expect(dayDealState({ ...base, snapshotItemIds: [] })).toBe('ready');
  });

  it('is ready when unlocked and the snapshot is present with no Board yet', () => {
    expect(dayDealState(base)).toBe('ready');
  });

  it('is dealt (a no-op) whenever a Board already exists, regardless of clock', () => {
    expect(dayDealState({ ...base, hasBoard: true })).toBe('dealt');
    // Even a locked, snapshot-less Day reads dealt once a Board exists.
    expect(dayDealState({ ...base, now: 0, snapshotItemIds: undefined, hasBoard: true })).toBe(
      'dealt',
    );
  });
});

describe('win detection', () => {
  it('detects a bingo only when a full line (incl. free center) is marked', () => {
    const cells = dealBoard(pool, 'FREE', 1);
    // Middle row is 10,11,12,13,14; center (12) already free.
    expect(hasBingo(cells)).toBe(false);
    for (const i of [10, 11, 13, 14]) cells[i].marked = true;
    expect(hasBingo(cells)).toBe(true);
    expect(winningCells(cells).has(12)).toBe(true);
  });

  it('ignores pending marks in admin-confirmed mode', () => {
    const cells = dealBoard(pool, 'FREE', 2);
    for (const i of [10, 11, 13, 14]) {
      cells[i].marked = true;
      cells[i].status = 'pending';
    }
    expect(hasBingo(cells)).toBe(false);
  });

  it('counts marked squares excluding the free center', () => {
    const cells = dealBoard(pool, 'FREE', 3);
    cells[0].marked = true;
    cells[1].marked = true;
    expect(countMarked(cells)).toBe(2);
  });

  it('recognizes a blackout', () => {
    const cells = dealBoard(pool, 'FREE', 4);
    for (const c of cells) c.marked = true;
    expect(isBlackout(cells)).toBe(true);
  });
});

describe('leaderboard ordering', () => {
  it('ranks by bingos, then squares, then earliest first-bingo', () => {
    const players = [
      { bingoCount: 1, squaresMarked: 5, firstBingoAt: 200 },
      { bingoCount: 2, squaresMarked: 3, firstBingoAt: 300 },
      { bingoCount: 1, squaresMarked: 5, firstBingoAt: 100 },
      { bingoCount: 1, squaresMarked: 9, firstBingoAt: 400 },
    ];
    const sorted = sortPlayers(players);
    expect(sorted[0].bingoCount).toBe(2); // most bingos wins
    expect(sorted[1].squaresMarked).toBe(9); // then most squares
    expect(sorted[2].firstBingoAt).toBe(100); // tie broken by earliest
    expect(sorted[3].firstBingoAt).toBe(200);
  });

  it('treats no-bingo (null) as last among equals', () => {
    expect(
      comparePlayers(
        { bingoCount: 0, squaresMarked: 2, firstBingoAt: null },
        { bingoCount: 0, squaresMarked: 2, firstBingoAt: 500 },
      ),
    ).toBeGreaterThan(0);
  });
});

describe('bingoLineEdge (#176: the celebration re-fires on each NEW line)', () => {
  // A dealt board's center (index 12) is free+marked; marking every non-center
  // cell of a row completes exactly that line (rows share no other line here).
  function boardWithRows(rows: number[]) {
    const cells = dealBoard(pool, 'FREE', 42);
    for (const r of rows) for (const k of [0, 1, 2, 3, 4]) cells[r * 5 + k].marked = true;
    return cells;
  }

  it('no completed lines, previous count 0 → not gained', () => {
    expect(bingoLineEdge(boardWithRows([]), 0)).toEqual({ lines: 0, gained: false });
  });

  it('the first line completing is a rising edge → gained', () => {
    expect(bingoLineEdge(boardWithRows([0]), 0)).toEqual({ lines: 1, gained: true });
  });

  it('the SAME single line on a later snapshot does not re-fire', () => {
    expect(bingoLineEdge(boardWithRows([0]), 1)).toEqual({ lines: 1, gained: false });
  });

  it('a SECOND line re-fires the celebration — the #176 regression', () => {
    expect(bingoLineEdge(boardWithRows([0, 1]), 1)).toEqual({ lines: 2, gained: true });
  });

  it('a THIRD line keeps re-firing', () => {
    expect(bingoLineEdge(boardWithRows([0, 1, 2]), 2)).toEqual({ lines: 3, gained: true });
  });

  it('a line falling away (count decreasing) never fires', () => {
    expect(bingoLineEdge(boardWithRows([0]), 2)).toEqual({ lines: 1, gained: false });
  });
});

describe('standingsFrozen (#265; Codex P2 on #278 — the stale-cache belt)', () => {
  const days = [
    { index: 0, date: '2026-07-15', place: 'Trieste', placeEmoji: '', theme: 'welcome-aboard', pool: 'embark', tutorial: true, unlockAt: 0 },
    { index: 9, date: '2026-07-24', place: 'Barcelona', placeEmoji: '', theme: 'so-long-farewell', pool: 'farewell', tutorial: true, unlockAt: 1000 },
  ] as import('../types').DayDef[];

  it('frozen once the scheduler stamp is present, regardless of the clock', () => {
    expect(standingsFrozen({ frozenAt: 500, days }, 0)).toBe(true);
  });

  it('frozen by the CLOCK once the farewell unlock passes — a stale cache with no stamp still fails closed', () => {
    expect(standingsFrozen({ days }, 999)).toBe(false);
    expect(standingsFrozen({ days }, 1000)).toBe(true);
  });

  it('never frozen on a legacy event (no schedule) or a null event', () => {
    expect(standingsFrozen({ days: [] }, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(standingsFrozen(null, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
