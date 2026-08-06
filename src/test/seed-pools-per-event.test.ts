import { describe, it, expect } from 'vitest';
import { SEED_EVENTS, PROJECT_DEFAULT_EVENT, resolveSeedEvent } from '../../scripts/seed-data/index.mjs';
import * as med2026 from '../../scripts/seed-data/med-2026.mjs';
import * as bodegaBay2026 from '../../scripts/seed-data/bodega-bay-2026.mjs';
import { seedItemDocId } from '../../scripts/seed-data/item-id.mjs';
import { verifySeedPool } from '../../scripts/seed.mjs';

// Per-Event seed modules (#563): each Event pins ITS OWN pool counts and
// uniqueness, so the drift verifier (`node scripts/seed.mjs --verify`) keeps a
// meaningful canon for BOTH projects — no single global 80 that one Event
// passes and the other fails on contact. The med-2026 content pins live in
// their original suites (w1-event-seed, seed-and-composition,
// d15-tutorial-seed); this file pins the registry contract and the
// bodega-bay-2026 payload.

describe('seed-data registry — Event selection (#563)', () => {
  it('registers exactly the two seedable Events', () => {
    expect(Object.keys(SEED_EVENTS).sort()).toEqual(['bodega-bay-2026', 'med-2026']);
  });

  it('maps each Firebase project to its default Event', () => {
    expect(PROJECT_DEFAULT_EVENT).toEqual({
      gaycruisebingo: 'med-2026',
      fiveacross: 'bodega-bay-2026',
    });
    // Every default points at a registered Event — a rename that breaks the
    // pairing must fail here, not at seed time against a live project.
    for (const eventId of Object.values(PROJECT_DEFAULT_EVENT)) {
      expect(SEED_EVENTS).toHaveProperty(eventId);
    }
  });

  it('resolves a known Event and fails loudly on an unknown one', () => {
    expect(resolveSeedEvent('med-2026')).toBe(med2026);
    expect(resolveSeedEvent('bodega-bay-2026')).toBe(bodegaBay2026);
    expect(() => resolveSeedEvent('typo-2026')).toThrow(/No seed data for event 'typo-2026'/);
  });

  it('every registered Event carries the full module contract', () => {
    for (const [eventId, mod] of Object.entries(SEED_EVENTS)) {
      expect(mod.EVENT_SEED.name, eventId).toBeTruthy();
      expect(mod.EVENT_SEED.status, eventId).toBe('active');
      expect(Array.isArray(mod.EVENT_SEED.days), eventId).toBe(true);
      expect(mod.ALL_ITEMS, eventId).toEqual([
        ...mod.ITEMS,
        ...mod.EASY_ITEMS,
        ...mod.CLOSING_ITEMS,
      ]);
      // ALL_ITEMS must be duplicate-free across the three pools — the doc id
      // is a content hash of `text`, so a duplicate collapses into ONE doc and
      // silently shrinks the seeded pool.
      const counts = new Map<string, number>();
      for (const i of mod.ALL_ITEMS) counts.set(i.text, (counts.get(i.text) ?? 0) + 1);
      const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([t]) => t).sort();
      expect(dups, eventId).toEqual([]);
      // Deal floor: every pool a Day deals a whole card from must clear
      // MIN_POOL (24, src/game/logic.ts).
      expect(mod.ITEMS.length, eventId).toBeGreaterThanOrEqual(24);
      expect(mod.EASY_ITEMS.length, eventId).toBeGreaterThanOrEqual(24);
      expect(mod.CLOSING_ITEMS.length, eventId).toBeGreaterThanOrEqual(24);
    }
  });
});

// The Bodega Bay Event (plans/bodega-prompt-pools.md, seeded live 2026-08-05,
// texts re-synced the same day to Nathan's edited draft — the live in-place
// data pass). 40 per pool — NOT the GCB 28 (§ "Why 40, not 28"): Friday and
// Sunday are COMPETITIVE Days dealt whole from one pool, and 24-of-28 would
// give any two players ~20.5 shared squares; 40 restores real card variety.
describe('bodega-bay-2026 — pool pins', () => {
  it('pins 40 easy / 40 main / 40 closing rows, every entry tame', () => {
    expect(bodegaBay2026.EASY_ITEMS).toHaveLength(40);
    expect(bodegaBay2026.ITEMS).toHaveLength(40);
    expect(bodegaBay2026.CLOSING_ITEMS).toHaveLength(40);
    expect(bodegaBay2026.ALL_ITEMS).toHaveLength(120);
    // General-audience Event: no spicy entries anywhere, and the Event seeds
    // spicyRatio 0 so the deal never reserves spicy slots.
    expect(bodegaBay2026.ALL_ITEMS.every((i) => i.spicy === false)).toBe(true);
    expect(bodegaBay2026.EVENT_SEED.settings.spicyRatio).toBe(0);
  });

  it('keeps the one intentional source-text quirk documented in the module header', () => {
    const closingTexts = bodegaBay2026.CLOSING_ITEMS.map((i) => i.text);
    expect(new Set(closingTexts).size).toBe(40);
    expect(
      bodegaBay2026.EASY_ITEMS.some((i) => i.text === 'Post of a picture of you and somebody else in your jammies'),
    ).toBe(true);
    // The draft's markdown escape must NOT leak into data: '#hashtag', no backslash.
    expect(bodegaBay2026.CLOSING_ITEMS.some((i) => i.text === 'Give this trip a #hashtag')).toBe(true);
    expect(bodegaBay2026.ALL_ITEMS.some((i) => i.text.includes('\\'))).toBe(false);
  });

  it('tags the curated pools with the persisted LEGACY pool values (#565 transition)', () => {
    // The live Event was seeded with the legacy values, and deployed Cloud
    // Functions + firestore.rules key off them (snapshotPoolsFor,
    // standingsFrozen, validItemPool) — see the module header. Flipping these
    // before the #565 coercion is deployed end-to-end would break Easy Mix and
    // the freeze on the LIVE event.
    expect(bodegaBay2026.EASY_ITEMS.every((i) => i.pool === 'embark')).toBe(true);
    expect(bodegaBay2026.CLOSING_ITEMS.every((i) => i.pool === 'farewell')).toBe(true);
    expect(bodegaBay2026.ITEMS.every((i) => i.pool === undefined)).toBe(true); // defaults to 'main'
  });

  it('has no duplicate text within any pool', () => {
    for (const pool of [bodegaBay2026.EASY_ITEMS, bodegaBay2026.ITEMS, bodegaBay2026.CLOSING_ITEMS]) {
      expect(new Set(pool.map((i) => i.text)).size).toBe(pool.length);
    }
  });

  it('verifies the live in-place-edited pool against its recorded legacy ids', () => {
    // #644 Phase 4b P1: the 2026-08-05 text correction deliberately kept the
    // old ids so Day 0's frozen snapshot and existing cards remain valid. The
    // verifier must accept ONLY this recorded identity generation—not a
    // fabricated arbitrary id—and still enforce every canonical field.
    expect(bodegaBay2026.VERIFY_ITEM_IDS).toHaveLength(bodegaBay2026.ALL_ITEMS.length);
    expect(new Set(bodegaBay2026.VERIFY_ITEM_IDS).size).toBe(bodegaBay2026.ALL_ITEMS.length);
    const live = bodegaBay2026.ALL_ITEMS.map((item, index) => ({
      id: bodegaBay2026.VERIFY_ITEM_IDS[index]!,
      text: item.text,
      spicy: item.spicy,
      pool: item.pool ?? 'main',
      createdBy: 'seed',
      isFreeSpace: false,
      status: 'active',
      reportCount: 0,
    }));
    expect(
      verifySeedPool(
        live,
        bodegaBay2026.ALL_ITEMS,
        bodegaBay2026.EVENT_SEED.settings.reportHideThreshold,
        bodegaBay2026.VERIFY_ITEM_IDS,
      ),
    ).toMatchObject({ ok: true, missing: [], mismatched: [], stale: [] });

    live[0] = { ...live[0]!, text: 'Not Bodega canonical text' };
    expect(
      verifySeedPool(
        live,
        bodegaBay2026.ALL_ITEMS,
        bodegaBay2026.EVENT_SEED.settings.reportHideThreshold,
        bodegaBay2026.VERIFY_ITEM_IDS,
      ),
    ).toMatchObject({ ok: false, mismatched: [{ text: bodegaBay2026.ALL_ITEMS[0]!.text }] });
  });

  it('never carries the 🔞 glyph in display text', () => {
    for (const item of bodegaBay2026.ALL_ITEMS) expect(item.text).not.toContain('🔞');
  });
});

describe('bodega-bay-2026 — Event payload pins', () => {
  const { EVENT_SEED } = bodegaBay2026;

  it('pins the Event window, timezone and Easy Mix settings', () => {
    expect(EVENT_SEED.name).toBe('Bodega Bay');
    expect(EVENT_SEED.startsOn).toBe('2026-08-07');
    expect(EVENT_SEED.endsOn).toBe('2026-08-09');
    expect(EVENT_SEED.timezone).toBe('America/Los_Angeles');
    expect(EVENT_SEED.settings).toEqual({
      reportHideThreshold: 4,
      spicyRatio: 0,
      easyMixRatio: 0.5,
    });
    expect(EVENT_SEED.claimMode).toBe('honor');
    expect(EVENT_SEED.defaultTheme).toBe('side-quests');
  });

  it('pins the four-Day shape: competitive Fri/Sat/Sun + the ceremonial wrap-up', () => {
    // Four Days for a three-day trip (plans/bodega-prompt-pools.md § "Why four
    // Days"): a farewell-pool Sunday would freeze the standings at its own
    // 06:00 unlock; keeping Sunday on `main` and adding the 11:00 wrap-up Day
    // makes the wrap-up's unlock BE the freeze.
    expect(EVENT_SEED.days.map((d) => [d.index, d.pool, d.tutorial, d.scoring])).toEqual([
      [0, 'embark', false, 'competitive'],
      [1, 'main', false, 'competitive'],
      [2, 'main', false, 'competitive'],
      [3, 'farewell', true, 'ceremonial'],
    ]);
  });

  it('unlocks Day 0 via the open sentinel and Sat/Sun at 06:00 America/Los_Angeles', () => {
    // Day 0 MUST be the `0` sentinel ("live from event open", #289 fail-open):
    // the snapshot filter admits only Prompts created at or before `unlockAt`,
    // so a real Friday-16:00 unlock on a same-day seed would stamp an EMPTY
    // snapshot — and there is no un-stamp.
    expect(EVENT_SEED.days[0].unlockAt).toBe(0);
    // 06:00 PT, not 08:00 — early-to-rise group; 06:00 PDT is exactly 13:00
    // UTC, so the hourly UTC scheduler tick hits it on the hour.
    expect(EVENT_SEED.days[1].unlockAt).toBe(Date.parse('2026-08-08T06:00:00-07:00'));
    expect(EVENT_SEED.days[2].unlockAt).toBe(Date.parse('2026-08-09T06:00:00-07:00'));
    expect(EVENT_SEED.days[3].unlockAt).toBe(Date.parse('2026-08-09T11:00:00-07:00'));
  });

  it('states the Standings Freeze at check-out — the same instant as the wrap-up unlock', () => {
    expect(EVENT_SEED.standingsFreezeAt).toBe(Date.parse('2026-08-09T11:00:00-07:00'));
    expect(EVENT_SEED.standingsFreezeAt).toBe(EVENT_SEED.days[3].unlockAt);
  });

  it('pre-stamps Day 0 with exactly the easy pool — deterministic Friday card, only on Day 0', () => {
    // The open sentinel disables the timestamp cutoff entirely (fail-open,
    // #289), so without a pre-stamp Friday's card would be whatever is active
    // whenever the scheduler happens to run — avoidable nondeterminism on a
    // competitive Day. The seed fixes the snapshot instead.
    const day0 = EVENT_SEED.days[0];
    const easyIds = bodegaBay2026.EASY_ITEMS.map((i) => seedItemDocId(i.text)).sort();
    expect(day0.snapshotItemIds).toEqual(easyIds);
    for (const day of EVENT_SEED.days.slice(1)) {
      expect(day.snapshotItemIds).toBeUndefined();
    }
  });

  it('carries a freeText override on every Day', () => {
    expect(EVENT_SEED.days.map((d) => d.freeText)).toEqual([
      'The flock has landed',
      'Main character on the coast',
      'One last coastal morning',
      'We did it for the story',
    ]);
  });

  it('dual-writes both field generations so the SHIPPED reader and the live doc shape both render (Codex P1, PR #644)', () => {
    // The live doc was seeded with the neutral names (place/placeEmoji,
    // startsOn/endsOn), but the currently deployed bundle reads the legacy
    // names — so the seed payload persists BOTH pairs with matching values.
    // Drop the legacy pair when the #566 read-coercion is deployed.
    for (const day of EVENT_SEED.days) {
      expect(typeof day.place).toBe('string');
      expect(day.place.length).toBeGreaterThan(0);
      expect(typeof day.placeEmoji).toBe('string');
      expect(day.port).toBe(day.place);
      expect(typeof day.portEmoji).toBe('string');
    }
    // The one deliberate divergence: Nathan set the wrap-up chip's legacy
    // emoji to 👋 live; the neutral field keeps the Theme table's 🌫️.
    expect(EVENT_SEED.days.map((d) => d.portEmoji === d.placeEmoji)).toEqual([true, true, true, false]);
    expect(EVENT_SEED.days[3].portEmoji).toBe('👋');
    expect(EVENT_SEED.sailStart).toBe(EVENT_SEED.startsOn);
    expect(EVENT_SEED.sailEnd).toBe(EVENT_SEED.endsOn);
  });
});
