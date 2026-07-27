import { describe, it, expect } from 'vitest';
import type { Cell } from '../types';
import {
  achievedItemIds,
  applyEchoes,
  firstLineCompletionAt,
  foldEchoStats,
  foldDayStat,
  isPristine,
  completedLines,
} from './logic';

// specs/echo-marks.md — the pure derivation layer: the achieved set, the
// idempotent per-board echo application with its win deltas, the multi-board
// stat fold, and the Reshuffle pristine exemption. No Firebase anywhere.

/** A 25-cell board: free centre at 12, `item-<i>` prompts elsewhere, with
 *  per-index overrides. Ids are per-INDEX so two boards built with different
 *  `idFor` maps can share or not share prompts deliberately. */
function board(
  overrides: Partial<Record<number, Partial<Cell>>> = {},
  idFor: (i: number) => string = (i) => `item-${i}`,
): Cell[] {
  return Array.from({ length: 25 }, (_, index) => {
    const base: Cell =
      index === 12
        ? { index, itemId: null, text: 'FREE', free: true, marked: true, markedAt: null }
        : { index, itemId: idFor(index), text: `Prompt ${index}`, free: false, marked: false, markedAt: null };
    return { ...base, ...(overrides[index] ?? {}) };
  });
}

const NOW = 1_700_000_000_000;

describe('achievedItemIds — the achieved set (spec § Glossary)', () => {
  it('collects confirmed marked prompts across boards; pending and the free centre are excluded', () => {
    const a = board({
      1: { marked: true, markedAt: 1 },
      2: { marked: true, markedAt: 1, status: 'pending' }, // a Claim in flight — NOT achieved
      3: { marked: true, markedAt: 1, status: 'confirmed' },
    });
    const b = board({ 5: { marked: true, markedAt: 1 } }, (i) => `other-${i}`);
    const achieved = achievedItemIds([a, b]);
    expect(achieved).toEqual(new Set(['item-1', 'item-3', 'other-5']));
  });

  it('counts an echoed cell as achieved — an echo IS a confirmed Mark', () => {
    const a = board({ 4: { marked: true, markedAt: 1, status: 'confirmed', echo: true } });
    expect(achievedItemIds([a])).toEqual(new Set(['item-4']));
  });
});

describe('applyEchoes — idempotent per-board application (spec § Contract)', () => {
  it('marks only unmarked carriers, born confirmed with echo: true', () => {
    const cells = board({ 1: { marked: true, markedAt: 5 } });
    const res = applyEchoes(cells, new Set(['item-1', 'item-2', 'missing']), NOW);
    expect(res.changed).toBe(true);
    expect(res.echoedItemIds).toEqual(['item-2']);
    const echoed = res.cells.find((c) => c.index === 2)!;
    expect(echoed).toMatchObject({ marked: true, markedAt: NOW, status: 'confirmed', echo: true });
    // The already-marked source cell is untouched.
    expect(res.cells.find((c) => c.index === 1)).toBe(cells.find((c) => c.index === 1));
  });

  it('never touches a pending Square — the Player has tapped it and a Claim may ride on it', () => {
    const cells = board({ 3: { marked: true, markedAt: 5, status: 'pending' } });
    const res = applyEchoes(cells, new Set(['item-3']), NOW);
    expect(res.changed).toBe(false);
    expect(res.cells).toBe(cells);
  });

  it('does not re-add an Echo the Player explicitly opted out of', () => {
    const cells = board({ 4: { echoOptOut: true } });
    const res = applyEchoes(cells, new Set(['item-4']), NOW);
    expect(res.changed).toBe(false);
    expect(res.cells[4]).toMatchObject({ marked: false, echoOptOut: true });
  });

  it('is idempotent, and a board with no carrier returns the ORIGINAL array reference', () => {
    const cells = board();
    const untouched = applyEchoes(cells, new Set(['not-here']), NOW);
    expect(untouched.changed).toBe(false);
    expect(untouched.cells).toBe(cells); // byte-identical no-repeats regression contract

    const first = applyEchoes(cells, new Set(['item-7']), NOW);
    const second = applyEchoes(first.cells, new Set(['item-7']), NOW + 1);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.cells).toBe(first.cells);
  });

  it('computes the bingo transition for a line the echoes complete (free centre counts)', () => {
    // Row 2 (10..14) crosses the free centre: 10 + 11 manual, 13 + 14 echoed.
    const cells = board({
      10: { marked: true, markedAt: 1 },
      11: { marked: true, markedAt: 1 },
    });
    const res = applyEchoes(cells, new Set(['item-13', 'item-14']), NOW);
    expect(res.bingoTransition).toBe(true);
    expect(res.bingoCount).toBe(1);
    expect(completedLines(res.cells).length).toBe(1);
    expect(res.squaresMarked).toBe(4);
    expect(res.blackout).toBe(false);
    expect(res.blackoutTransition).toBe(false);
  });

  it('computes the blackout transition when the echoes fill the card', () => {
    const everyId = new Set(
      board()
        .filter((c) => c.itemId)
        .map((c) => c.itemId as string),
    );
    const res = applyEchoes(board(), everyId, NOW);
    expect(res.blackout).toBe(true);
    expect(res.blackoutTransition).toBe(true);
    expect(res.squaresMarked).toBe(24);
  });
});

describe('foldEchoStats — the ONE aggregated player write (spec § Contract)', () => {
  it('folds an echoed bucket over prior days and re-derives the roots', () => {
    const out = foldEchoStats({
      priorDayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 500 } },
      echoes: [{ dayIndex: 3, bingoCount: 1, squaresMarked: 4, blackout: false }],
      now: NOW,
    });
    // The echoed Day's first line stamps `now` (no prior stamp on that Day).
    expect(out.dayStats).toEqual({ 3: { bingoCount: 1, squaresMarked: 4, firstBingoAt: NOW } });
    expect(out.bingoCount).toBe(2);
    expect(out.squaresMarked).toBe(9);
    expect(out.firstBingoAt).toBe(500); // earliest across the merged view
    expect(out.blackout).toBe(false);
  });

  it("keeps an echoed Day's EARLIER stamp and clears a no-bingo Day to null", () => {
    const out = foldEchoStats({
      priorDayStats: { 2: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 300 } },
      echoes: [
        { dayIndex: 2, bingoCount: 2, squaresMarked: 7, blackout: false },
        { dayIndex: 4, bingoCount: 0, squaresMarked: 2, blackout: false },
      ],
      now: NOW,
    });
    expect(out.dayStats[2].firstBingoAt).toBe(300);
    expect(out.dayStats[4].firstBingoAt).toBeNull();
  });

  it('composes with an acted-day foldDayStat base, preserving its firstBingoAt OMISSION (#75)', () => {
    // The acted-day fold with UNKNOWN prior state while a bingo already stood
    // omits firstBingoAt — the echo fold must carry that omission through.
    const base = foldDayStat({
      priorDayStats: undefined,
      dayIndex: 1,
      bucket: { bingoCount: 2, squaresMarked: 8 }, // no firstBingoAt key — the omit case
      blackout: false,
    });
    expect('firstBingoAt' in base).toBe(false);
    const out = foldEchoStats({
      priorDayStats: undefined,
      echoes: [{ dayIndex: 3, bingoCount: 1, squaresMarked: 4, blackout: false }],
      now: NOW,
      base,
    });
    expect('firstBingoAt' in out).toBe(false); // the root omission survives
    expect(out.dayStats[1]).toEqual({ bingoCount: 2, squaresMarked: 8 }); // base bucket intact
    expect(out.dayStats[3]).toEqual({ bingoCount: 1, squaresMarked: 4, firstBingoAt: NOW });
    expect(out.bingoCount).toBe(3);
    expect(out.squaresMarked).toBe(12);
  });

  it('applies the tutorial and ceremonial exclusions to the roots, and ORs blackout', () => {
    const out = foldEchoStats({
      priorDayStats: {},
      echoes: [
        { dayIndex: 0, bingoCount: 1, squaresMarked: 3, blackout: false }, // tutorial
        { dayIndex: 9, bingoCount: 1, squaresMarked: 2, blackout: true }, // ceremonial
        { dayIndex: 4, bingoCount: 1, squaresMarked: 5, blackout: false },
      ],
      now: NOW,
      isTutorialDay: (i) => i === 0,
      isCeremonialDay: (i) => i === 9,
    });
    // Ceremonial Day 9 never enters the sums; tutorial Day 0 still sums.
    expect(out.bingoCount).toBe(2);
    expect(out.squaresMarked).toBe(8);
    // The cruise-wide first bingo excludes the tutorial Day 0 stamp.
    expect(out.firstBingoAt).toBe(NOW); // day 4's (and 9's) stamp, not blocked by day 0
    expect(out.blackout).toBe(true); // any touched board completing sets it
  });

  it('preserves a blackout standing on an UNTOUCHED board (priorBlackout latch — Codex P2 #447)', () => {
    const out = foldEchoStats({
      priorDayStats: { 1: { bingoCount: 3, squaresMarked: 24, firstBingoAt: 100 } },
      echoes: [{ dayIndex: 4, bingoCount: 0, squaresMarked: 1, blackout: false }],
      now: NOW,
      priorBlackout: true, // Day 1 stands blackout; this write touches only Day 4
    });
    expect(out.blackout).toBe(true);
    // And absent the latch, a non-winning echo reports no blackout of its own.
    const bare = foldEchoStats({
      priorDayStats: {},
      echoes: [{ dayIndex: 4, bingoCount: 0, squaresMarked: 1, blackout: false }],
      now: NOW,
    });
    expect(bare.blackout).toBe(false);
  });
});

describe('firstLineCompletionAt — the cells-derived bingo stamp (#491/#495)', () => {
  it('returns when the earliest completed line COMPLETED (max markedAt per line, min over lines)', () => {
    // Row 10..14 (free centre at 12): completed when its last cell marked at 7.
    const cells = board({
      10: { marked: true, markedAt: 3 },
      11: { marked: true, markedAt: 4 },
      13: { marked: true, markedAt: 5 },
      14: { marked: true, markedAt: 7 },
    });
    expect(firstLineCompletionAt(cells)).toBe(7);
  });

  it('is undefined with no completed line, or when a completing cell lacks markedAt (legacy data)', () => {
    expect(firstLineCompletionAt(board({ 10: { marked: true, markedAt: 3 } }))).toBeUndefined();
    const legacy = board({
      10: { marked: true, markedAt: 3 },
      11: { marked: true, markedAt: 4 },
      13: { marked: true, markedAt: 5 },
      14: { marked: true, markedAt: null }, // marked, but no usable stamp
    });
    expect(firstLineCompletionAt(legacy)).toBeUndefined();
  });

  it('feeds foldEchoStats: a previously unstamped bingo takes the bucket bingoAt over `now`', () => {
    const write = foldEchoStats({
      priorDayStats: undefined,
      echoes: [{ dayIndex: 3, bingoCount: 1, squaresMarked: 4, blackout: false, bingoAt: 7 }],
      now: NOW,
    });
    expect(write.dayStats[3].firstBingoAt).toBe(7);
    // A prior stamp still wins, and a bucket without bingoAt falls back to now.
    const prior = foldEchoStats({
      priorDayStats: { 3: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 5 } },
      echoes: [{ dayIndex: 3, bingoCount: 1, squaresMarked: 4, blackout: false, bingoAt: 7 }],
      now: NOW,
    });
    expect(prior.dayStats[3].firstBingoAt).toBe(5);
    const fallback = foldEchoStats({
      priorDayStats: undefined,
      echoes: [{ dayIndex: 3, bingoCount: 1, squaresMarked: 4, blackout: false }],
      now: NOW,
    });
    expect(fallback.dayStats[3].firstBingoAt).toBe(NOW);
  });
});

describe('isPristine — the Reshuffle echo exemption (spec § Reshuffle pristine-ness)', () => {
  it('only artifact-free confirmed Echoes stay pristine', () => {
    expect(isPristine(board({ 2: { marked: true, markedAt: NOW, status: 'confirmed', echo: true } }))).toBe(
      true,
    );
    expect(isPristine(board({ 2: { marked: true, markedAt: NOW } }))).toBe(false);
    expect(isPristine(board({ 2: { marked: true, markedAt: NOW, status: 'pending' } }))).toBe(false);
    expect(isPristine(board({ 2: { marked: true, markedAt: NOW, status: 'confirmed', echo: true, proofId: 'p1' } }))).toBe(false);
  });
});
