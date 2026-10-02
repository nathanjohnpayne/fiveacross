import { describe, it, expect } from 'vitest';
import {
  dealBoard,
  CENTER,
  echoMarksEnabled,
  repeatExclusionTiers,
  repeatWindowFor,
  type DealItem,
} from './logic';
import type { Cell } from '../types';

// specs/easy-mix.md — the main-day easy mix. From Day 4 onward a main-day Board's 24
// non-free Squares are a `settings.easyMixRatio` split: an EASY half sampled from the
// embark pool + a MAIN half dealt exactly as today, with `spicyRatio` applied WITHIN
// the main half. These are pure `dealBoard` unit tests (no Firebase); the snapshot /
// scheduler side lives in tests/functions/easy-mix-snapshot.test.ts.

const FREE = 'FREE';

/** A synthetic main pool: `spicy` spicy + `tame` tame items, ids `m…`. */
function mainPool(spicy: number, tame: number): DealItem[] {
  const out: DealItem[] = [];
  for (let i = 0; i < spicy; i++) out.push({ id: `ms${i}`, text: `main spicy ${i}`, spicy: true, pool: 'main' });
  for (let i = 0; i < tame; i++) out.push({ id: `mt${i}`, text: `main tame ${i}`, spicy: false, pool: 'main' });
  return out;
}

/** A synthetic embark pool (all tame, as seeded), ids `e…`. */
function embarkPool(n: number): DealItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `e${i}`, text: `embark ${i}`, spicy: false, pool: 'easy' as const }));
}

/** Map an id → its pool/spicy, so a dealt Cell (which carries neither) can be classified. */
function classifier(pool: DealItem[]): Map<string, DealItem> {
  return new Map(pool.map((p) => [p.id, p]));
}

function dealtIds(pool: DealItem[], seed: number, opts: Parameters<typeof dealBoard>[4]): (string | null)[] {
  return dealBoard(pool, FREE, seed, 0.4, opts)
    .filter((c) => !c.free)
    .map((c) => c.itemId);
}


describe('easy mix — LEGACY persisted pool spelling (#565; Codex P1 on PR #648)', () => {
  it("deals the 12/12 mix when items carry the live docs' legacy 'embark' value (raw hydration path)", () => {
    // The snapshot deal/reshuffle paths hydrate items WITHOUT the converter,
    // so dealBoard can receive the persisted legacy spelling. normalizePool
    // inside the split (and at the api.ts hydration) must keep the mix whole —
    // a canonical-only comparison would deal an all-main card on the LIVE
    // event.
    const legacyEasy = Array.from({ length: 16 }, (_, i) => ({
      id: `e${i}`,
      text: `legacy easy ${i}`,
      spicy: false,
      pool: 'embark',
    }));
    const pool = [...mainPool(8, 16), ...legacyEasy];
    const cells = dealBoard(pool, FREE, 7, undefined, { easyMixRatio: 0.5 });
    const by = new Map(pool.map((p) => [p.id, p]));
    const ids = cells.filter((c) => !c.free).map((c) => c.itemId);
    const easy = ids.filter((id) => id && by.get(id!)?.pool === 'embark');
    expect(easy).toHaveLength(12);
    expect(ids).toHaveLength(24);
  });
});

describe('easy mix — the 50/50 embark/main split (ratio 0.5)', () => {
  it('deals exactly 12 embark + 12 main, with ≈5 spicy inside the main half', () => {
    const pool = [...mainPool(8, 16), ...embarkPool(16)];
    const by = classifier(pool);
    const ids = dealtIds(pool, 4242, { stratify: true, easyMixRatio: 0.5 });

    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24); // no same-card duplicates
    const embark = ids.filter((id) => id && by.get(id)?.pool === 'easy');
    const main = ids.filter((id) => id && by.get(id)?.pool === 'main');
    expect(embark).toHaveLength(12);
    expect(main).toHaveLength(12);
    // spicyRatio 0.4 applies WITHIN the 12 main squares: round(12 * 0.4) = 5 spicy.
    const spicyMain = main.filter((id) => id && by.get(id)?.spicy);
    expect(spicyMain).toHaveLength(5);
  });

  it('ratio 0.25 deals 6 embark + 18 main', () => {
    const pool = [...mainPool(8, 16), ...embarkPool(16)];
    const by = classifier(pool);
    const ids = dealtIds(pool, 99, { stratify: true, easyMixRatio: 0.25 });
    expect(ids.filter((id) => id && by.get(id)?.pool === 'easy')).toHaveLength(6);
    expect(ids.filter((id) => id && by.get(id)?.pool === 'main')).toHaveLength(18);
  });

  it('is deterministic per seed and varies across seeds', () => {
    const pool = [...mainPool(8, 16), ...embarkPool(16)];
    const a = dealtIds(pool, 7, { stratify: true, easyMixRatio: 0.5 });
    const b = dealtIds(pool, 7, { stratify: true, easyMixRatio: 0.5 });
    const c = dealtIds(pool, 8, { stratify: true, easyMixRatio: 0.5 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('easy mix — ratio 0 is the no-regression proof (byte-for-byte today)', () => {
  it('drops easy entirely and reproduces the main-only stratified deal', () => {
    const main = mainPool(10, 30);
    const combined = [...main, ...embarkPool(16)];
    for (const seed of [1, 42, 1337, 0x9e37]) {
      // Combined pool at ratio 0 must equal dealing the main-only subset as today.
      const mixedZero = dealtIds(combined, seed, { stratify: true, easyMixRatio: 0 });
      const todayMainOnly = dealtIds(main, seed, { stratify: true });
      expect(mixedZero).toEqual(todayMainOnly);
    }
  });

  it('the dealBoard default (no easyMixRatio) is inert — same as ratio 0', () => {
    const combined = [...mainPool(10, 30), ...embarkPool(16)];
    expect(dealtIds(combined, 555, { stratify: true })).toEqual(
      dealtIds(combined, 555, { stratify: true, easyMixRatio: 0 }),
    );
  });

  it('a snapshot with no embark items never mixes, even with easyMixRatio set (Days 1–3 untouched)', () => {
    const main = mainPool(10, 30);
    // Same pool, one with the mix requested, one without — identical, because there
    // are no embark items to mix in (a main-only snapshot).
    expect(dealtIds(main, 321, { stratify: true, easyMixRatio: 0.5 })).toEqual(
      dealtIds(main, 321, { stratify: true }),
    );
  });
});

describe('easy mix — defensive backfill', () => {
  it('backfills the easy half from tame main when the embark pool is short', () => {
    // 3 embark, easyCount 12 → 3 embark squares + 9 tame-main backfilled.
    const pool = [...mainPool(8, 16), ...embarkPool(3)];
    const by = classifier(pool);
    const ids = dealtIds(pool, 202, { stratify: true, easyMixRatio: 0.5 });
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    // Only the 3 embark items exist, so at most 3 squares are embark; the rest main.
    const embark = ids.filter((id) => id && by.get(id)?.pool === 'easy');
    expect(embark).toHaveLength(3);
    expect(ids.filter((id) => id && by.get(id)?.pool === 'main')).toHaveLength(21);
  });

  it('still fills 24 when the MAIN pool is thin (backfills the main half from spare embark)', () => {
    const pool = [...mainPool(1, 3), ...embarkPool(22)]; // 4 main, 22 embark, union 26
    const ids = dealtIds(pool, 17, { stratify: true, easyMixRatio: 0.5 });
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
  });

  it('throws when the combined pool is below MIN_POOL, same as the pre-existing guard', () => {
    const pool = [...mainPool(2, 6), ...embarkPool(10)]; // union 18 < 24
    expect(() => dealBoard(pool, FREE, 1, 0.4, { stratify: true, easyMixRatio: 0.5 })).toThrow(
      /at least 24 prompts/,
    );
  });
});

describe('easy mix — exclusion applies to the MAIN half only', () => {
  it('keeps an excluded MAIN prompt off the card', () => {
    const pool = [...mainPool(10, 30), ...embarkPool(16)];
    const excludeIds = new Set(['mt0', 'mt1', 'ms0']);
    const ids = dealtIds(pool, 71, { stratify: true, easyMixRatio: 0.5, excludeIds });
    for (const id of excludeIds) expect(ids).not.toContain(id);
  });

  it('keeps using unseen MAIN prompts until the main half is exhausted', () => {
    // 12 unseen main prompts remain — enough for a 50/50 card's main half, but below
    // the old 24-prompt reset floor. The exclusion must still hold until this half's
    // own requirement is exhausted, so Day 5 cannot repeat main prompts prematurely.
    const pool = [...mainPool(0, 100), ...embarkPool(20)];
    const by = classifier(pool);
    const unseenMainIds = new Set(Array.from({ length: 12 }, (_, i) => `mt${i}`));
    const excludedMainIds = new Set(Array.from({ length: 88 }, (_, i) => `mt${i + 12}`));

    const ids = dealtIds(pool, 19, { stratify: true, easyMixRatio: 0.5, excludeIds: excludedMainIds });
    const main = ids.filter((id) => id && by.get(id)?.pool === 'main');
    expect(main).toHaveLength(12);
    expect(main.every((id) => id != null && unseenMainIds.has(id))).toBe(true);
    for (const id of excludedMainIds) expect(ids).not.toContain(id);
  });

  it('ignores an excluded EMBARK prompt — easy-half repeats across days are intentional', () => {
    const pool = [...mainPool(10, 30), ...embarkPool(16)];
    // Excluding embark ids must not change the deal at all (embark is never excluded).
    const withEmbarkExcluded = dealtIds(pool, 71, {
      stratify: true,
      easyMixRatio: 0.5,
      excludeIds: new Set(['e0', 'e1', 'e2']),
    });
    const noExclusion = dealtIds(pool, 71, { stratify: true, easyMixRatio: 0.5 });
    expect(withEmbarkExcluded).toEqual(noExclusion);
  });
});

// #1360 — the repeat window. `excludeTiers` is one id set per other card,
// nearest Day first; the union is tried whole and, only when it would starve the
// main half, the FARTHEST card's tier drops off first — a slope, not the old
// all-or-nothing reset.
describe('easy mix — the repeat window (#1360)', () => {
  const ids = (prefix: string, from: number, n: number) =>
    new Set(Array.from({ length: n }, (_, i) => `${prefix}${from + i}`));
  const cellsOf = (set: Set<string>): Cell[] =>
    [...set].map((itemId, index) => ({ index, itemId, text: itemId, marked: false, free: false }) as Cell);

  it('deals byte-identically to the single-set path whenever the full union fits', () => {
    const pool = [...mainPool(0, 100), ...embarkPool(20)];
    const tiers = [ids('mt', 0, 12), ids('mt', 12, 12), ids('mt', 24, 12)];
    const union = new Set(tiers.flatMap((t) => [...t]));
    for (const seed of [3, 19, 71, 404]) {
      expect(dealtIds(pool, seed, { stratify: true, easyMixRatio: 0.5, excludeTiers: tiers })).toEqual(
        dealtIds(pool, seed, { stratify: true, easyMixRatio: 0.5, excludeIds: union }),
      );
    }
  });

  it('drops the FARTHEST card first when the union would starve the main half', () => {
    // 40 main prompts, 12 needed. Four 10-prompt tiers exclude all 40; dropping the
    // farthest tier frees mt30..mt39 — 10, still short — so the next-farthest
    // drops too, freeing mt20..mt29. The two NEAREST cards stay excluded.
    const pool = [...mainPool(0, 40), ...embarkPool(20)];
    const by = classifier(pool);
    const tiers = [ids('mt', 0, 10), ids('mt', 10, 10), ids('mt', 20, 10), ids('mt', 30, 10)];
    const main = dealtIds(pool, 5, { stratify: true, easyMixRatio: 0.5, excludeTiers: tiers }).filter(
      (id) => id && by.get(id)?.pool === 'main',
    );
    expect(main).toHaveLength(12);
    for (const id of [...tiers[0], ...tiers[1]]) expect(main).not.toContain(id);
  });

  it('keeps enough main prompts to backfill a SHORT easy pool before accepting a tier prefix', () => {
    // 40 main + only 6 easy at ratio 0.5: main must supply 18, not 12. Tiers of
    // 14/14/12 exclude everything; dropping the farthest (12) leaves 12 — enough
    // for a 12-square main half but not for the 18 the short easy pool needs —
    // so a second tier drops and only the nearest card (14) stays excluded.
    const pool = [...mainPool(0, 40), ...embarkPool(6)];
    const tiers = [ids('mt', 0, 14), ids('mt', 14, 14), ids('mt', 28, 12)];
    const dealt = dealtIds(pool, 9, { stratify: true, easyMixRatio: 0.5, excludeTiers: tiers });
    expect(dealt).toHaveLength(24);
    for (const id of tiers[0]) expect(dealt).not.toContain(id);
  });

  it('keeps the legacy single-set exclusion as the all-or-nothing reset', () => {
    const pool = [...mainPool(0, 40), ...embarkPool(20)];
    const all = ids('mt', 0, 40);
    // One tier that starves the pool resets to the full pool — the pre-#1360 behaviour.
    expect(dealtIds(pool, 5, { stratify: true, easyMixRatio: 0.5, excludeTiers: [all] })).toEqual(
      dealtIds(pool, 5, { stratify: true, easyMixRatio: 0.5 }),
    );
  });

  it('orders tiers nearest Day first and cuts to the window', () => {
    const other = [0, 1, 2, 3, 4, 5, 7, 9].map((d) => ({ dayIndex: d, cells: cellsOf(ids(`d${d}-`, 0, 1)) }));
    const firstIds = (tiers: Set<string>[]) => tiers.map((t) => [...t][0]);
    // Dealing Day 6: distances 1 (5, 7), 2 (4), 3 (3, 9), … — ties go to the earlier Day.
    expect(firstIds(repeatExclusionTiers(other, 6))).toEqual([
      'd5-0', 'd7-0', 'd4-0', 'd3-0', 'd9-0', 'd2-0', 'd1-0', 'd0-0',
    ]);
    expect(firstIds(repeatExclusionTiers(other, 6, 4))).toEqual(['d5-0', 'd7-0', 'd4-0', 'd3-0']);
  });

  it('reads settings.repeatWindow defensively — only a positive integer is a window', () => {
    expect(repeatWindowFor({ repeatWindow: 4 })).toBe(4);
    for (const bad of [undefined, 0, -1, 2.5, '4', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(repeatWindowFor({ repeatWindow: bad })).toBeUndefined();
    }
    expect(repeatWindowFor(undefined)).toBeUndefined();
  });
});

describe('Echo Marks switch (#1360)', () => {
  it('is ON unless settings.echoMarks is exactly false', () => {
    expect(echoMarksEnabled(undefined)).toBe(true);
    expect(echoMarksEnabled({})).toBe(true);
    expect(echoMarksEnabled({ echoMarks: true })).toBe(true);
    expect(echoMarksEnabled({ echoMarks: 'false' })).toBe(true);
    expect(echoMarksEnabled({ echoMarks: false })).toBe(false);
  });
});

describe('easy mix — the free center is untouched', () => {
  it('still deals 25 cells with a marked free center', () => {
    const pool = [...mainPool(8, 16), ...embarkPool(16)];
    const cells = dealBoard(pool, FREE, 3, 0.4, { stratify: true, easyMixRatio: 0.5 });
    expect(cells).toHaveLength(25);
    expect(cells[CENTER].free).toBe(true);
    expect(cells[CENTER].marked).toBe(true);
  });
});
