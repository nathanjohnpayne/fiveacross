import { describe, it, expect } from 'vitest';
import { DAYS, EASY_ITEMS, CLOSING_ITEMS, SEED_ITEMS } from './seed';
import { EVENT_SEED, EASY_ITEMS as SCRIPT_EASY_ITEMS, CLOSING_ITEMS as SCRIPT_CLOSING_ITEMS } from '../../scripts/seed-data/med-2026.mjs';

// Covers specs/d15-tutorial-seed.md (#207): the two curated tutorial pools
// (embark/farewell, 28 entries each) and the ten-Day `EventDoc.timezone`/`days[]`
// mapping, per plans/daily-cards-spec.md § "Tutorial item lists", "Itinerary and
// schedule", and "Free space per day".

describe('EASY_ITEMS — the curated Welcome Aboard pool (28)', () => {
  it('has exactly 28 entries, all tame, all tagged pool: easy (canonical, #565)', () => {
    expect(EASY_ITEMS).toHaveLength(28);
    expect(EASY_ITEMS.every((i) => i.spicy === false)).toBe(true);
    expect(EASY_ITEMS.every((i) => i.pool === 'easy')).toBe(true);
  });

  it('has no duplicate text within the pool', () => {
    expect(new Set(EASY_ITEMS.map((i) => i.text)).size).toBe(28);
  });
});

describe('CLOSING_ITEMS — the curated So Long, Farewell pool (28)', () => {
  it('has exactly 28 entries, all tame, all tagged pool: closing (canonical, #565)', () => {
    expect(CLOSING_ITEMS).toHaveLength(28);
    expect(CLOSING_ITEMS.every((i) => i.spicy === false)).toBe(true);
    expect(CLOSING_ITEMS.every((i) => i.pool === 'closing')).toBe(true);
  });

  it('has no duplicate text within the pool', () => {
    expect(new Set(CLOSING_ITEMS.map((i) => i.text)).size).toBe(28);
  });
});

describe('EASY_ITEMS / CLOSING_ITEMS — no cross-pool or main-pool duplicates', () => {
  it('has no duplicate text across the easy and closing pools', () => {
    const combined = [...EASY_ITEMS.map((i) => i.text), ...CLOSING_ITEMS.map((i) => i.text)];
    expect(new Set(combined).size).toBe(56);
  });

  it('has no duplicate text against the frozen main pool (SEED_ITEMS)', () => {
    const mainTexts = new Set(SEED_ITEMS.map((i) => i.text));
    for (const item of [...EASY_ITEMS, ...CLOSING_ITEMS]) {
      expect(mainTexts.has(item.text)).toBe(false);
    }
  });
});

describe('scripts/seed-data/med-2026.mjs — tutorial pool literals stay in sync with src/data/seed.ts', () => {
  // The SCRIPT constants carry the LEGACY persisted pool values
  // ('embark'/'farewell') during the #565 transition — the seed writes what
  // deployed Functions and the live docs speak — while the app-side constants
  // speak the canonical vocabulary. Sync therefore compares text/spicy
  // verbatim and pool through the same mapping `migratePool` applies on read.
  const canonicalized = (items: readonly { text: string; spicy: boolean; pool?: string }[]) =>
    items.map(({ text, spicy, pool }) => ({
      text,
      spicy,
      pool: pool === 'embark' ? 'easy' : pool === 'farewell' ? 'closing' : (pool ?? 'main'),
    }));

  it('exports the same 28-entry EASY_ITEMS as src/data/seed.ts (pool via the legacy mapping)', () => {
    expect(SCRIPT_EASY_ITEMS.length).toBe(28);
    expect(SCRIPT_EASY_ITEMS.every((i) => i.pool === 'embark')).toBe(true); // persisted-legacy, by design
    expect(canonicalized(SCRIPT_EASY_ITEMS)).toEqual(EASY_ITEMS);
  });

  it('exports the same 28-entry CLOSING_ITEMS as src/data/seed.ts (pool via the legacy mapping)', () => {
    expect(SCRIPT_CLOSING_ITEMS.length).toBe(28);
    expect(SCRIPT_CLOSING_ITEMS.every((i) => i.pool === 'farewell')).toBe(true); // persisted-legacy, by design
    expect(canonicalized(SCRIPT_CLOSING_ITEMS)).toEqual(CLOSING_ITEMS);
  });
});

describe('DAYS — the ten-Day itinerary mapping', () => {
  it('has exactly 10 entries, indexed 0..9 in order', () => {
    expect(DAYS).toHaveLength(10);
    expect(DAYS.map((d) => d.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('matches the itinerary table field-for-field', () => {
    // Corrected itinerary (schedule correction 2026-07-17, daily-cards-spec
    // § Itinerary): Sea Day moved to Day 3, Naples replaces Sorrento on Day 6,
    // Villefranche replaces Nice on Day 8, and each Day carries its unified
    // theme. Dates/pools/tutorial flags are unchanged (the correction is pure
    // relabeling; the migration preserves game state). The two-event `tonight[]`
    // line is asserted in schedule-correction.test.ts.
    const expected = [
      ['2026-07-15', 'Trieste', '🇮🇹', 'welcome-aboard', 'easy', true],
      ['2026-07-16', 'Split', '🇭🇷', 'uniforms-without-borders', 'main', false],
      ['2026-07-17', 'Sea Day', '🌊', 'neon-pink-playground', 'main', false],
      ['2026-07-18', 'Valletta', '🇲🇹', 'sporty-splash', 'main', false],
      ['2026-07-19', 'Palermo (Sicily)', '🇮🇹', 'under-the-stars', 'main', false],
      ['2026-07-20', 'Naples (Pompeii)', '🇮🇹', 'glamiators', 'main', false],
      ['2026-07-21', 'Rome (Civitavecchia)', '🇮🇹', 'atlantis-classics', 'main', false],
      ['2026-07-22', 'Villefranche (Nice)', '🇫🇷', 'summer-white', 'main', false],
      ['2026-07-23', 'Marseille', '🇫🇷', 'revival-disco', 'main', false],
      ['2026-07-24', 'Barcelona', '🇪🇸', 'so-long-farewell', 'closing', true],
    ] as const;

    expected.forEach(([date, port, placeEmoji, theme, pool, tutorial], i) => {
      const day = DAYS[i];
      expect(day.date).toBe(date);
      expect(day.place).toBe(port);
      expect(day.placeEmoji).toBe(placeEmoji);
      expect(day.theme).toBe(theme);
      expect(day.pool).toBe(pool);
      expect(day.tutorial).toBe(tutorial);
    });
  });

  it('unlocks index 0 (embark) via the event-open sentinel and every other Day at 08:00 Europe/Rome on its date', () => {
    // #289: the 0 sentinel is DELIBERATE ("live from event open") and the
    // scheduler fails open on a non-positive cutoff. A positive historical
    // constant would re-starve any fresh seed run after it — seeded items
    // carry `createdAt: Date.now()`, all later than a fixed past instant
    // (Codex P1 on the #289 fix).
    expect(DAYS[0].unlockAt).toBe(0);
    for (let i = 1; i < DAYS.length; i++) {
      const day = DAYS[i];
      expect(day.unlockAt).toBe(Date.parse(`${day.date}T08:00:00+02:00`));
    }
  });

  it('carries the two freeText overrides on exactly Day 0 and Day 9, and none elsewhere', () => {
    expect(DAYS[0].freeText).toBe('You made it aboard');
    expect(DAYS[9].freeText).toBe('We had the best damn time');
    for (let i = 1; i < 9; i++) {
      expect(DAYS[i].freeText).toBeUndefined();
    }
  });
});

describe('scripts/seed-data/med-2026.mjs — EVENT_SEED carries the Phase 1.5 timezone + days[]', () => {
  it('seeds timezone: Europe/Rome', () => {
    expect(EVENT_SEED.timezone).toBe('Europe/Rome');
  });

  it('seeds a 10-entry days[] matching src/data/seed.ts DAYS exactly (pool via the legacy mapping)', () => {
    expect(EVENT_SEED.days).toHaveLength(10);
    // Same transition posture as the pool literals above: the SCRIPT persists
    // the legacy pool values; everything else must match byte-for-byte.
    const canonicalDays = EVENT_SEED.days.map((d) => ({
      ...d,
      pool: d.pool === 'embark' ? 'easy' : d.pool === 'farewell' ? 'closing' : d.pool,
    }));
    expect(canonicalDays).toEqual(DAYS);
  });
});
