import { describe, it, expect } from 'vitest';
import { FREE_TEXT, SEED_ITEMS } from './seed';
import { dealBoard, CENTER, type DealItem } from '../game/logic';
import { EVENT_SEED, ITEMS as SCRIPT_ITEMS } from '../../scripts/seed-data/med-2026.mjs';

// Covers specs/seed-and-composition.md (#129, refreshed #187): the 80-entry pool
// replacement (24 spicy / 56 tame) and the stratified spicy/tame Board composition rule.

describe('SEED_ITEMS — the canonical 80-entry pool', () => {
  it('has exactly 80 entries: 24 spicy, 56 tame', () => {
    expect(SEED_ITEMS.length).toBe(80);
    expect(SEED_ITEMS.filter((i) => i.spicy).length).toBe(24);
    expect(SEED_ITEMS.filter((i) => !i.spicy).length).toBe(56);
  });

  it('has no duplicate text across the pool', () => {
    expect(new Set(SEED_ITEMS.map((i) => i.text)).size).toBe(80);
  });

  it('never carries the 🔞 glyph in the display text (spicy is a tag, not text content)', () => {
    for (const item of SEED_ITEMS) expect(item.text).not.toContain('🔞');
  });

  it('sets the lowercased FREE_TEXT', () => {
    expect(FREE_TEXT).toBe('Complain about circuit music');
  });
});

// A synthetic pool built from the real 80-entry SEED_ITEMS, with ids assigned
// so each dealt cell's itemId can be traced back to its spicy-ness.
const fullPool: DealItem[] = SEED_ITEMS.map((it, i) => ({
  id: `full${i}`,
  text: it.text,
  spicy: it.spicy,
}));
const spicyById = new Map(fullPool.map((it) => [it.id, it.spicy]));

function nonFreeCells(cells: ReturnType<typeof dealBoard>) {
  return cells.filter((c) => !c.free);
}

describe('dealBoard — stratified composition (default spicyRatio 0.4)', () => {
  it('deals 25 cells: a marked free center + 24 non-free', () => {
    const cells = dealBoard(fullPool, FREE_TEXT, 1);
    expect(cells).toHaveLength(25);
    expect(cells[CENTER].free).toBe(true);
    expect(cells[CENTER].marked).toBe(true);
    expect(nonFreeCells(cells)).toHaveLength(24);
  });

  it('deals exactly 10 spicy / 14 tame among the 24 non-free cells at the default ratio', () => {
    const cells = dealBoard(fullPool, FREE_TEXT, 20260715);
    const nonFree = nonFreeCells(cells);
    const spicyCount = nonFree.filter((c) => c.itemId && spicyById.get(c.itemId)).length;
    expect(spicyCount).toBe(10);
    expect(nonFree.length - spicyCount).toBe(14);
  });

  it('is deterministic per seed and varies across seeds', () => {
    const a = dealBoard(fullPool, FREE_TEXT, 42).map((c) => c.itemId);
    const b = dealBoard(fullPool, FREE_TEXT, 42).map((c) => c.itemId);
    const c = dealBoard(fullPool, FREE_TEXT, 43).map((c) => c.itemId);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('interleaves spicy cells across at least 3 different grid rows (not clustered)', () => {
    const cells = dealBoard(fullPool, FREE_TEXT, 20260715);
    const spicyRows = new Set(
      cells.filter((c) => c.itemId && spicyById.get(c.itemId)).map((c) => Math.floor(c.index / 5)),
    );
    expect(spicyRows.size).toBeGreaterThanOrEqual(3);
  });

  it('does not allow an unlucky seed to cluster all spicy cells into two rows', () => {
    const cells = dealBoard(fullPool, FREE_TEXT, 119985);
    const spicyIndexes = cells.filter((c) => c.itemId && spicyById.get(c.itemId)).map((c) => c.index);
    const spicyRows = new Set(spicyIndexes.map((index) => Math.floor(index / 5)));
    expect(spicyRows.size).toBeGreaterThanOrEqual(4);
    for (let i = 0; i <= spicyIndexes.length - 5; i++) {
      expect(spicyIndexes[i + 4] - spicyIndexes[i]).toBeGreaterThan(4);
    }
  });
});

describe('dealBoard — backfill when a category is short', () => {
  it('backfills tame when spicy is short: 5 spicy + 40 tame -> 5 spicy + 19 tame, no throw', () => {
    const spicy = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      text: `spicy ${i}`,
      spicy: true,
    }));
    const tame = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      text: `tame ${i}`,
      spicy: false,
    }));
    const pool = [...spicy, ...tame];
    const cells = dealBoard(pool, FREE_TEXT, 7);
    const nonFree = nonFreeCells(cells);
    const spicyIds = new Set(spicy.map((s) => s.id));
    expect(nonFree).toHaveLength(24);
    const spicyCount = nonFree.filter((c) => c.itemId && spicyIds.has(c.itemId)).length;
    expect(spicyCount).toBe(5);
    expect(nonFree.length - spicyCount).toBe(19);
    expect(
      new Set(nonFree.filter((c) => c.itemId && spicyIds.has(c.itemId)).map((c) => Math.floor(c.index / 5)))
        .size,
    ).toBe(5);
  });

  it('throws when the active pool has fewer than MIN_POOL (24) prompts, same as the pre-existing guard', () => {
    const pool = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      text: `prompt ${i}`,
      spicy: i < 5,
    }));
    expect(() => dealBoard(pool, FREE_TEXT, 1)).toThrow(/at least 24 prompts/);
  });
});

describe('dealBoard — spicyRatio config', () => {
  it('a spicyRatio of 0.25 yields 6 spicy / 18 tame among the 24 non-free cells', () => {
    const cells = dealBoard(fullPool, FREE_TEXT, 20260715, 0.25);
    const nonFree = nonFreeCells(cells);
    const spicyCount = nonFree.filter((c) => c.itemId && spicyById.get(c.itemId)).length;
    expect(spicyCount).toBe(6);
    expect(nonFree.length - spicyCount).toBe(18);
  });
});

describe('dealBoard — clamps a malformed spicyRatio instead of corrupting the slice math (Codex P2, PR #135)', () => {
  it('falls back to the default 0.4 for NaN (e.g. a non-numeric event settings field slipping past the join-side typeof check)', () => {
    const cells = dealBoard(fullPool, FREE_TEXT, 20260715, NaN);
    const nonFree = nonFreeCells(cells);
    expect(nonFree).toHaveLength(24);
    const spicyCount = nonFree.filter((c) => c.itemId && spicyById.get(c.itemId)).length;
    expect(spicyCount).toBe(10);
  });

  it('clamps an out-of-range ratio into 0..1 rather than propagating negative/over-24 slice counts', () => {
    const over = nonFreeCells(dealBoard(fullPool, FREE_TEXT, 20260715, 5));
    expect(over).toHaveLength(24);
    const overSpicy = over.filter((c) => c.itemId && spicyById.get(c.itemId)).length;
    expect(overSpicy).toBe(24); // clamped to 1.0 -> all 24 non-free cells spicy

    const under = nonFreeCells(dealBoard(fullPool, FREE_TEXT, 20260715, -1));
    expect(under).toHaveLength(24);
    const underSpicy = under.filter((c) => c.itemId && spicyById.get(c.itemId)).length;
    expect(underSpicy).toBe(0); // clamped to 0.0 -> all 24 non-free cells tame
  });
});

describe('dealBoard — Community Prompt affordance + attribution stamping (#559)', () => {
  // A synthetic pool with 24 usable non-free draws, exactly two of which
  // carry a Community Prompt's usual shape: a usable `targetDayIndex` plus a
  // `createdBy` uid. `unstratifiedPicks` guards a >MIN_POOL, spicy-agnostic
  // pool here (stratify: false), so every non-community item is deliberately
  // tame and untargeted — nothing to accidentally collide with the two.
  const pool: DealItem[] = [
    { id: 'community-1', text: 'Suggested by a player', spicy: false, targetDayIndex: 2, createdBy: 'u-suggester' },
    { id: 'community-2', text: 'Also suggested', spicy: false, targetDayIndex: 0, createdBy: 'u-other' },
    ...Array.from({ length: 22 }, (_, i) => ({ id: `organiser-${i}`, text: `Organiser prompt ${i}`, spicy: false })),
  ];

  it('stamps communityPrompt + suggestedBy ONLY on cells drawn from a usable-target item', () => {
    const cells = nonFreeCells(dealBoard(pool, FREE_TEXT, 1, 0, { stratify: false }));
    const community = cells.filter((c) => c.itemId === 'community-1' || c.itemId === 'community-2');
    expect(community).toHaveLength(2);
    for (const c of community) {
      expect(c.communityPrompt).toBe(true);
    }
    expect(cells.find((c) => c.itemId === 'community-1')?.suggestedBy).toBe('u-suggester');
    expect(cells.find((c) => c.itemId === 'community-2')?.suggestedBy).toBe('u-other');

    const organiser = cells.filter((c) => c.itemId?.startsWith('organiser-'));
    expect(organiser.length).toBeGreaterThan(0);
    for (const c of organiser) {
      expect(c.communityPrompt).toBeUndefined();
      expect(c.suggestedBy).toBeUndefined();
    }
  });

  it('never stamps the free centre — it has no drawn item to attribute', () => {
    const cells = dealBoard(pool, FREE_TEXT, 1, 0, { stratify: false });
    const free = cells.find((c) => c.free);
    expect(free?.communityPrompt).toBeUndefined();
    expect(free?.suggestedBy).toBeUndefined();
  });

  it('leaves an untargeted item unstamped even when it carries no createdBy at all (synthetic/legacy items)', () => {
    const cells = nonFreeCells(dealBoard(fullPool, FREE_TEXT, 1));
    for (const c of cells) {
      expect(c.communityPrompt).toBeUndefined();
      expect(c.suggestedBy).toBeUndefined();
    }
  });
});

describe('scripts/seed-data/med-2026.mjs — replace semantics (no Firestore/emulator; plain import assertions)', () => {
  it('exports the same 80-entry { text, spicy } pool as src/data/seed.ts SEED_ITEMS', () => {
    expect(SCRIPT_ITEMS.length).toBe(80);
    expect(SCRIPT_ITEMS).toEqual(SEED_ITEMS);
  });

  it('seeds settings.spicyRatio at the dealBoard-matching default 0.4', () => {
    expect(EVENT_SEED.settings.spicyRatio).toBe(0.4);
  });
});
