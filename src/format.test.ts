import { describe, it, expect } from 'vitest';
import { formatSailRange, eventTitle, segmentEmojiRuns } from './format';

describe('formatSailRange', () => {
  it('collapses a shared month and year to a day range with an en dash', () => {
    // The med-2026 event window.
    expect(formatSailRange('2026-07-15', '2026-07-24')).toBe('July 15–24, 2026');
  });

  it('renders a single-day window as a plain date, not a duplicate range', () => {
    expect(formatSailRange('2026-07-15', '2026-07-15')).toBe('July 15, 2026');
  });

  it('spans two months in the same year', () => {
    expect(formatSailRange('2026-07-28', '2026-08-03')).toBe('July 28 – August 3, 2026');
  });

  it('spans a year boundary', () => {
    expect(formatSailRange('2026-12-30', '2027-01-02')).toBe(
      'December 30, 2026 – January 2, 2027',
    );
  });

  it('does not shift the day across timezones (parses ISO parts directly)', () => {
    // new Date('2026-07-15') is UTC-midnight and would render as the 14th in
    // negative-offset zones; the direct parse keeps the 15th.
    expect(formatSailRange('2026-07-15', '2026-07-15')).toContain('15');
  });

  it('degrades to an empty range for missing or malformed dates (never throws)', () => {
    expect(formatSailRange('', '')).toBe('');
    expect(formatSailRange('', '2026-07-24')).toBe('');
    expect(formatSailRange(undefined as unknown as string, undefined as unknown as string)).toBe('');
    expect(formatSailRange('not-a-date', '2026-07-24')).toBe('');
  });

  it('rejects a numeric but out-of-range date rather than rendering a broken title', () => {
    expect(formatSailRange('2026-13-01', '2026-07-24')).toBe(''); // month 13
    expect(formatSailRange('2026-07-32', '2026-07-24')).toBe(''); // day 32
    expect(formatSailRange('2026-07-15', '2026-00-24')).toBe(''); // month 0
  });

  it('rejects an impossible calendar day (day exceeds the month, leap-year aware)', () => {
    expect(formatSailRange('2026-02-31', '2026-07-24')).toBe(''); // Feb 31
    expect(formatSailRange('2026-04-31', '2026-07-24')).toBe(''); // Apr 31
    expect(formatSailRange('2026-02-29', '2026-07-24')).toBe(''); // 2026 is not a leap year
    // A real leap day is accepted.
    expect(formatSailRange('2028-02-29', '2028-02-29')).toBe('February 29, 2028');
  });

  it('drops a reversed window where the end precedes the start', () => {
    expect(formatSailRange('2026-07-24', '2026-07-15')).toBe(''); // swapped same-month
    expect(formatSailRange('2026-08-01', '2026-07-31')).toBe(''); // swapped across months
  });
});

describe('eventTitle', () => {
  it('joins the event name to its sail range with an em dash (no spaces)', () => {
    expect(eventTitle('Atlantis Med—Trieste to Barcelona', '2026-07-15', '2026-07-24')).toBe(
      'Atlantis Med—Trieste to Barcelona—July 15–24, 2026',
    );
  });

  it('falls back to just the name when the sail range is unavailable', () => {
    expect(eventTitle('Atlantis Med—Trieste to Barcelona', '', '')).toBe(
      'Atlantis Med—Trieste to Barcelona',
    );
  });
});

describe('segmentEmojiRuns', () => {
  it('returns a single non-emoji run for plain text', () => {
    expect(segmentEmojiRuns('Day 10 · Barcelona')).toEqual([
      { text: 'Day 10 · Barcelona', emoji: false },
    ]);
  });

  it('returns [] for the empty string', () => {
    expect(segmentEmojiRuns('')).toEqual([]);
  });

  it('splits a trailing port emoji into its own run', () => {
    expect(segmentEmojiRuns('Day 4 · Valletta 🌊')).toEqual([
      { text: 'Day 4 · Valletta ', emoji: false },
      { text: '🌊', emoji: true },
    ]);
  });

  it('keeps a regional-indicator flag pair as ONE emoji run', () => {
    expect(segmentEmojiRuns('Day 2 · Split 🇭🇷')).toEqual([
      { text: 'Day 2 · Split ', emoji: false },
      { text: '🇭🇷', emoji: true },
    ]);
  });

  it('keeps a ZWJ sequence whole', () => {
    expect(segmentEmojiRuns('crew 👨‍👨‍👦 aboard')).toEqual([
      { text: 'crew ', emoji: false },
      { text: '👨‍👨‍👦', emoji: true },
      { text: ' aboard', emoji: false },
    ]);
  });

  it('handles a leading emoji (Leaderboard day chip shape)', () => {
    expect(segmentEmojiRuns('🚢 D1')).toEqual([
      { text: '🚢', emoji: true },
      { text: ' D1', emoji: false },
    ]);
  });

  it('merges adjacent emoji clusters into one run so flags never split', () => {
    expect(segmentEmojiRuns('🇭🇷🇮🇹 twin ports')).toEqual([
      { text: '🇭🇷🇮🇹', emoji: true },
      { text: ' twin ports', emoji: false },
    ]);
  });

  it('flags a VS16 pictograph and a keycap sequence as emoji runs', () => {
    expect(segmentEmojiRuns('map 🗺️ pin')).toEqual([
      { text: 'map ', emoji: false },
      { text: '🗺️', emoji: true },
      { text: ' pin', emoji: false },
    ]);
    expect(segmentEmojiRuns('cabin 3️⃣')).toEqual([
      { text: 'cabin ', emoji: false },
      { text: '3️⃣', emoji: true },
    ]);
  });

  it('does not flag plain digits or ASCII as emoji', () => {
    expect(segmentEmojiRuns('16 bingos · 124 squares')).toEqual([
      { text: '16 bingos · 124 squares', emoji: false },
    ]);
  });
});
