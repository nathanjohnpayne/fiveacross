import { describe, it, expect } from 'vitest';
import { createEventDraft } from './eventDraft';
import { FREE_TEXT } from './seed';
import {
  PREVIEW_SEED,
  dealPreviewCard,
  draftFallbackTheme,
  previewCaption,
  previewDayForTheme,
  previewDayLabel,
  previewDays,
  previewTheme,
  squaresTotal,
} from './draftPreview';
import type { DraftCuratedPrompt, DraftDayDef, DraftMainPrompt, EventDraft } from '../types';

function mainPrompts(n: number): DraftMainPrompt[] {
  return Array.from({ length: n }, (_, i) => ({ text: `main prompt ${i}`, spicy: false }));
}

function curatedPrompts(n: number, label: string): DraftCuratedPrompt[] {
  return Array.from({ length: n }, (_, i) => ({ text: `${label} prompt ${i}` }));
}

function day(overrides: Partial<DraftDayDef>): DraftDayDef {
  return {
    index: 0,
    date: '2026-08-07',
    unlockAt: Date.parse('2026-08-07T06:00:00-07:00'),
    place: 'Point Reyes',
    placeEmoji: '🌊',
    theme: null,
    pool: 'main',
    tutorial: false,
    tonight: ['A', 'B'],
    ...overrides,
  };
}

function draftWith(overrides: Partial<EventDraft>): EventDraft {
  return { ...createEventDraft({ now: 0 }), ...overrides };
}

describe('squaresTotal', () => {
  it('sums real entries across all three pools', () => {
    const draft = draftWith({
      prompts: { main: mainPrompts(32), easy: curatedPrompts(28, 'easy'), closing: curatedPrompts(26, 'closing') },
    });
    expect(squaresTotal(draft)).toBe(86);
  });

  it('skips holes rather than counting a sparse array by length', () => {
    const withHole = mainPrompts(3);
    // A sparse array: index 1 is a genuine hole, not `undefined` assigned.
    delete (withHole as unknown[])[1];
    const draft = draftWith({ prompts: { main: withHole, easy: [], closing: [] } });
    expect(squaresTotal(draft)).toBe(2);
  });

  it('is zero for a bare draft', () => {
    expect(squaresTotal(createEventDraft({ now: 0 }))).toBe(0);
  });
});

describe('previewDays', () => {
  it('drops holes and sorts by index, not array position', () => {
    const sparse: (DraftDayDef | null | undefined)[] = [day({ index: 2 }), undefined, day({ index: 0 })];
    const draft = draftWith({ days: sparse as DraftDayDef[] });
    const ordered = previewDays(draft);
    expect(ordered.map((d) => d.index)).toEqual([0, 2]);
  });
});

describe('previewDayForTheme / previewTheme', () => {
  it('returns null when no Day carries a Theme', () => {
    const draft = draftWith({ days: [day({ index: 0, theme: null }), day({ index: 1, theme: null })] });
    expect(previewDayForTheme(draft)).toBeNull();
  });

  it('returns the LAST themed Day by index, not array position', () => {
    const draft = draftWith({
      days: [
        day({ index: 1, theme: 'confetti-hour' }),
        day({ index: 0, theme: 'marquee' }),
      ],
    });
    expect(previewDayForTheme(draft)?.index).toBe(1);
    expect(previewDayForTheme(draft)?.theme).toBe('confetti-hour');
  });

  it('previewTheme prefers the themed Day, then defaultTheme, then the Edition default', () => {
    const themedDayDraft = draftWith({
      edition: 'fiveacross',
      defaultTheme: 'afterglow',
      days: [day({ index: 0, theme: 'marquee' })],
    });
    expect(previewTheme(themedDayDraft)).toBe('marquee');

    const defaultThemeOnly = draftWith({ edition: 'fiveacross', defaultTheme: 'afterglow', days: [] });
    expect(previewTheme(defaultThemeOnly)).toBe('afterglow');

    const bareDraft = draftWith({ edition: 'fiveacross', defaultTheme: null, days: [] });
    expect(previewTheme(bareDraft)).toBe('marquee'); // fiveacross's Edition default
  });
});

describe('draftFallbackTheme', () => {
  it('prefers the draft defaultTheme, then the Edition default — never a cross-Day lookup', () => {
    const withDefault = draftWith({ edition: 'fiveacross', defaultTheme: 'afterglow' });
    expect(draftFallbackTheme(withDefault)).toBe('afterglow');

    const withoutDefault = draftWith({ edition: 'vacay', defaultTheme: null });
    expect(draftFallbackTheme(withoutDefault)).toBe('the-birds'); // vacay's Edition default

    // Unlike previewTheme, a themed Day elsewhere in the schedule must NOT
    // change this result (Codex P2, PR #857 round 2) — this is the SELECTED
    // Day's own fallback, not the collapsed strip's cross-Day pick.
    const withThemedDayElsewhere = draftWith({
      edition: 'fiveacross',
      defaultTheme: 'afterglow',
      days: [day({ index: 0, theme: 'marquee' })],
    });
    expect(draftFallbackTheme(withThemedDayElsewhere)).toBe('afterglow');
  });
});

describe('previewDayLabel', () => {
  it('formats a real ISO date as its weekday', () => {
    // 2026-08-07 is a Friday.
    expect(previewDayLabel(day({ date: '2026-08-07' }))).toBe('Friday');
  });

  it('falls back to a 1-based ordinal for an unparseable date', () => {
    expect(previewDayLabel(day({ date: '', index: 2 }))).toBe('Day 3');
    expect(previewDayLabel(day({ date: '2026-02-30', index: 0 }))).toBe('Day 1');
  });
});

describe('previewCaption', () => {
  it('is generic before any squares or Theme exist', () => {
    expect(previewCaption(createEventDraft({ now: 0 }))).toBe('Live preview · updates as you build');
  });

  it('reports the squares total once a pack exists but no Day is themed yet', () => {
    const draft = draftWith({
      prompts: { main: mainPrompts(32), easy: curatedPrompts(28, 'easy'), closing: curatedPrompts(26, 'closing') },
      days: [day({ index: 0, theme: null })],
    });
    expect(previewCaption(draft)).toBe('86 squares · deals 24 per day');
  });

  it('reports the themed Day and its label once one is themed, even with squares present', () => {
    const draft = draftWith({
      prompts: { main: mainPrompts(32), easy: [], closing: [] },
      days: [day({ index: 0, date: '2026-08-09', theme: 'the-birds' })],
    });
    expect(previewCaption(draft)).toBe('Sunday preview · The Birds Have Entered the Chat');
  });

  it('reports a one-card-specific line, counting the main pool alone, for a one_card draft', () => {
    // Switching a draft OUT of a one-card occasion leaves easy/closing
    // Prompts authored but unused — squaresTotal would count them, but the
    // launched Board never will (Codex P2, PR #857 round 2).
    const draft = draftWith({
      cardFormat: 'one_card',
      prompts: { main: mainPrompts(40), easy: curatedPrompts(28, 'easy'), closing: curatedPrompts(26, 'closing') },
      days: [],
    });
    expect(previewCaption(draft)).toBe('40 squares · one card');
  });

  it('stays generic for an empty-main one_card draft, even with unused easy/closing Prompts', () => {
    const draft = draftWith({
      cardFormat: 'one_card',
      prompts: { main: [], easy: curatedPrompts(28, 'easy'), closing: [] },
      days: [],
    });
    expect(previewCaption(draft)).toBe('Live preview · updates as you build');
  });
});

describe('dealPreviewCard', () => {
  it('deals a full 25-cell card with the free space at center when the main pool is sufficient', () => {
    const draft = draftWith({ prompts: { main: mainPrompts(24), easy: [], closing: [] } });
    const result = dealPreviewCard(draft, day({ index: 0, pool: 'main' }));
    expect('cells' in result).toBe(true);
    if ('cells' in result) {
      expect(result.cells).toHaveLength(25);
      expect(result.cells[12]?.free).toBe(true);
      expect(result.cells[12]?.text).toBe(FREE_TEXT);
      expect(result.cells.filter((c) => !c.free)).toHaveLength(24);
    }
  });

  it('is deterministic across calls — same seed, same draft, same cells', () => {
    const draft = draftWith({ prompts: { main: mainPrompts(24), easy: [], closing: [] } });
    const a = dealPreviewCard(draft, day({ index: 0, pool: 'main' }));
    const b = dealPreviewCard(draft, day({ index: 0, pool: 'main' }));
    expect(a).toEqual(b);
    expect(PREVIEW_SEED).toBeTypeOf('number');
  });

  it('reports a shortfall — never throws — when the assigned pool is below MIN_POOL', () => {
    const draft = draftWith({ prompts: { main: mainPrompts(10), easy: [], closing: [] } });
    const result = dealPreviewCard(draft, day({ index: 0, pool: 'main' }));
    expect('shortfall' in result).toBe(true);
    if ('shortfall' in result) {
      expect(result.shortfall).toMatch(/at least 24 prompts/);
    }
  });

  it("uses the closing pool alone for a closing Day, unstratified, and never throws off an empty main/easy pool", () => {
    const draft = draftWith({
      prompts: { main: [], easy: [], closing: curatedPrompts(26, 'closing') },
    });
    const result = dealPreviewCard(draft, day({ index: 3, pool: 'closing' }));
    expect('cells' in result).toBe(true);
    if ('cells' in result) {
      const texts = result.cells.filter((c) => !c.free).map((c) => c.text);
      expect(texts.every((t) => t.startsWith('closing prompt'))).toBe(true);
    }
  });

  it('mixes the easy pool into a main Day at a 100% easyMixRatio, per specs/easy-mix.md', () => {
    const draft = draftWith({
      prompts: { main: mainPrompts(24), easy: curatedPrompts(24, 'easy'), closing: [] },
      settings: { ...createEventDraft({ now: 0 }).settings, easyMixRatio: 1 },
    });
    const result = dealPreviewCard(draft, day({ index: 0, pool: 'main' }));
    expect('cells' in result).toBe(true);
    if ('cells' in result) {
      const texts = result.cells.filter((c) => !c.free).map((c) => c.text);
      expect(texts.every((t) => t.startsWith('easy prompt'))).toBe(true);
    }
  });

  it("deals from the main pool, unstratified rules, when day is null (one_card / no Days yet)", () => {
    const draft = draftWith({ prompts: { main: mainPrompts(24), easy: [], closing: [] } });
    const result = dealPreviewCard(draft, null);
    expect('cells' in result).toBe(true);
  });

  it('DOES mix the easy pool into a daily_cards draft with no Days yet (day: null, but not one_card)', () => {
    // Custom before Step 4 authors any Days: day is null, cardFormat stays
    // 'daily_cards', and the eventual main Day WILL mix in easy per
    // specs/easy-mix.md — round 2's one-card fix wrongly swept this case up
    // too, since it is also day === null (Codex P2, PR #857 round 3).
    const draft = draftWith({
      cardFormat: 'daily_cards',
      days: [],
      prompts: { main: mainPrompts(24), easy: curatedPrompts(24, 'easy'), closing: [] },
      settings: { ...createEventDraft({ now: 0 }).settings, easyMixRatio: 1 },
    });
    const result = dealPreviewCard(draft, null);
    expect('cells' in result).toBe(true);
    if ('cells' in result) {
      const texts = result.cells.filter((c) => !c.free).map((c) => c.text);
      expect(texts.every((t) => t.startsWith('easy prompt'))).toBe(true);
    }
  });

  it('never mixes the easy pool into a one_card (day: null) deal, even when easy Prompts exist and easyMixRatio is 100%', () => {
    // Reachable when an occasion switch INTO one-card leaves an authored
    // easy pool behind (applyOccasionDefaults preserves Prompts) — the
    // launched one-card Board deals from main ALONE (Codex P2, PR #857
    // round 2), so the preview must too.
    const draft = draftWith({
      cardFormat: 'one_card',
      prompts: { main: mainPrompts(24), easy: curatedPrompts(24, 'easy'), closing: [] },
      settings: { ...createEventDraft({ now: 0 }).settings, easyMixRatio: 1 },
    });
    const result = dealPreviewCard(draft, null);
    expect('cells' in result).toBe(true);
    if ('cells' in result) {
      const texts = result.cells.filter((c) => !c.free).map((c) => c.text);
      expect(texts.every((t) => t.startsWith('main prompt'))).toBe(true);
    }
  });

  it('reports the assigned-pool-alone shortfall even when the COMBINED main+easy pool would let dealBoard itself succeed', () => {
    // 12 main + 12 easy at a 50% mix is 24 drawable — dealBoard alone would
    // deal a full card — but assignedPoolIssues blocks this draft because
    // the ASSIGNED (main) pool alone needs 24, "per pool, never as a total"
    // (specs/event-setup-wizard.md § Validation). The preview must agree
    // (Codex P2, PR #857 round 2).
    const draft = draftWith({
      prompts: { main: mainPrompts(12), easy: curatedPrompts(12, 'easy'), closing: [] },
      settings: { ...createEventDraft({ now: 0 }).settings, easyMixRatio: 0.5 },
    });
    const result = dealPreviewCard(draft, day({ index: 0, pool: 'main' }));
    expect('shortfall' in result).toBe(true);
    if ('shortfall' in result) {
      expect(result.shortfall).toMatch(/at least 24 prompts/);
      expect(result.shortfall).toMatch(/received 12/);
    }
  });

  it("falls back to the seed FREE_TEXT, and honors a Day's own freeText override", () => {
    const draft = draftWith({ prompts: { main: mainPrompts(24), easy: [], closing: [] } });
    const withoutOverride = dealPreviewCard(draft, day({ index: 0, pool: 'main' }));
    if ('cells' in withoutOverride) expect(withoutOverride.cells[12]?.text).toBe(FREE_TEXT);

    const withOverride = dealPreviewCard(draft, day({ index: 0, pool: 'main', freeText: 'The flock has landed' }));
    if ('cells' in withOverride) expect(withOverride.cells[12]?.text).toBe('The flock has landed');
  });
});
