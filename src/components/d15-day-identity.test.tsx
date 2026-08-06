import { describe, it, expect, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DayIdentityLines, headerDayIdentity, isoDateInTz } from './dayIdentity';
import { DAYS } from '../data/seed';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';

// Covers #259 (daily-cards-spec § "Header"): the two stacked header lines
// always show TODAY's port and theme, with the spec's pre-cruise and
// post-cruise copy. Pinned against the real seeded 2026 schedule so a seed
// edit that breaks the header states fails here.

const EVENT = { days: DAYS, timezone: 'Europe/Rome' };

afterEach(() => setActiveEdition(DEFAULT_EDITION));

// The sailing is entirely CEST (UTC+2): local wall-clock = UTC + 2h.
const cest = (y: number, m: number, d: number, h = 12, min = 0) => Date.UTC(y, m - 1, d, h - 2, min);

describe('headerDayIdentity — the header is a "where are we" instrument', () => {
  it('pre-cruise reads "Sails Jul 15" / the embark theme line', () => {
    expect(headerDayIdentity(EVENT, cest(2026, 7, 10))).toEqual({
      place: 'Sails Jul 15',
      theme: '🛳️ Welcome Aboard',
    });
  });

  it('the pre-event verb is Edition brand copy: "Starts" on Vacay, not "Sails" (#602)', () => {
    // The regression: a house event's header counted down with nautical copy.
    // "Sails" is `EditionBrand.preEventVerb` on the cruise Edition only; the
    // date and theme resolution are Edition-independent.
    setActiveEdition('vacay');
    expect(headerDayIdentity(EVENT, cest(2026, 7, 10))).toEqual({
      place: 'Starts Jul 15',
      theme: '🛳️ Welcome Aboard',
    });
  });

  it('embark day names the port', () => {
    expect(headerDayIdentity(EVENT, cest(2026, 7, 15))).toEqual({
      place: '🇮🇹 Trieste',
      theme: '🛳️ Welcome Aboard',
    });
  });

  it('mid-cruise names the latest UNLOCKED Day — gated on the 8:00 unlock, in lockstep with the board', () => {
    // Noon on Day 2 (Split, 2026-07-16): its card unlocked at 08:00, so the
    // header names it.
    expect(headerDayIdentity(EVENT, cest(2026, 7, 16))).toEqual({
      place: '🇭🇷 Split',
      theme: '🌍 Uniforms Without Borders',
    });
    // 06:00 on Day 3 (Sea Day, corrected 2026-07-17): its card is still locked
    // (unlocks 08:00), so the header stays on yesterday's unlocked Day (Split)
    // — matching the board's default Day — instead of leading it to the Sea Day
    // at calendar midnight.
    expect(headerDayIdentity(EVENT, cest(2026, 7, 17, 6))).toEqual({
      place: '🇭🇷 Split',
      theme: '🌍 Uniforms Without Borders',
    });
    // 08:00 on the Sea Day: the card unlocks and the header rolls to it in the
    // same beat as the board.
    expect(headerDayIdentity(EVENT, cest(2026, 7, 17, 8))).toEqual({
      place: '🌊 Sea Day',
      theme: '💖 Neon Pink Playground',
    });
  });

  it('sea day and farewell day render their own identities', () => {
    // Sea Day is Day 3 (Jul 17) in the corrected itinerary.
    expect(headerDayIdentity(EVENT, cest(2026, 7, 17))).toEqual({
      place: '🌊 Sea Day',
      theme: '💖 Neon Pink Playground',
    });
    expect(headerDayIdentity(EVENT, cest(2026, 7, 24))).toEqual({
      place: '🇪🇸 Barcelona',
      theme: '👋 So Long, Farewell',
    });
  });

  it('post-cruise reads "Barcelona" / "👋 Until next year"', () => {
    expect(headerDayIdentity(EVENT, cest(2026, 7, 25))).toEqual({
      place: 'Barcelona',
      theme: '👋 Until next year',
    });
    expect(headerDayIdentity(EVENT, cest(2026, 12, 1))).toEqual({
      place: 'Barcelona',
      theme: '👋 Until next year',
    });
  });

  it('resolves the pre-cruise boundary in the EVENT timezone, not UTC', () => {
    // 2026-07-14T22:30Z is already 00:30 on Jul 15 (embark day) in Europe/Rome,
    // so the header has crossed from the pre-cruise "Sails Jul 15" copy into the
    // embark identity (Trieste). A UTC-based resolver would still read Jul 14
    // and show "Sails Jul 15". (The mid-cruise pick is now pure `unlockAt` vs
    // `now` epoch math, so it needs no timezone; only this calendar boundary
    // does.)
    expect(headerDayIdentity(EVENT, Date.UTC(2026, 6, 14, 22, 30))).toEqual({
      place: '🇮🇹 Trieste',
      theme: '🛳️ Welcome Aboard',
    });
  });

  it('degrades to null with no event or no days (the placeholder state)', () => {
    expect(headerDayIdentity(null, cest(2026, 7, 16))).toBeNull();
    expect(headerDayIdentity({ days: [], timezone: 'Europe/Rome' }, cest(2026, 7, 16))).toBeNull();
  });

  it('an invalid timezone degrades to the host zone rather than throwing', () => {
    expect(() => isoDateInTz(cest(2026, 7, 16), 'Not/AZone')).not.toThrow();
    expect(headerDayIdentity({ days: DAYS, timezone: 'Not/AZone' }, cest(2026, 7, 20))).not.toBeNull();
  });
});

describe('DayIdentityLines — presentational states', () => {
  it('renders aria-hidden placeholder dashes with no identity', () => {
    const html = renderToStaticMarkup(<DayIdentityLines identity={null} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('—');
  });

  it('renders the two live lines, port bold-line first', () => {
    const html = renderToStaticMarkup(<DayIdentityLines identity={{ place: '🇭🇷 Split', theme: '🌍 Uniforms Without Borders' }} />);
    expect(html).not.toContain('aria-hidden');
    expect(html).toContain('🇭🇷 Split');
    expect(html).toContain('🌍 Uniforms Without Borders');
    expect(html.indexOf('Split')).toBeLessThan(html.indexOf('Uniforms Without Borders'));
  });
});
