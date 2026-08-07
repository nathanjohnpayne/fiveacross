import { describe, it, expect } from 'vitest';
import type { DayDef } from './types';
import { chaosLine, formatUnlockAt, nextChaosBoundary, unlockCaption } from './unlockCopy';

// src/unlockCopy.ts — the one module that renders a Day's `unlockAt` as player-
// facing copy. #669 (the locked-Day caption) and #670 (the warm-up banner) were
// the same bug twice: a hardcoded 8 quoting a schedule that opens at another
// hour. These cover every branch that decides how an hour is spoken.

function day(overrides: Partial<DayDef> & Pick<DayDef, 'index' | 'unlockAt' | 'pool'>): DayDef {
  return {
    date: '2026-08-08',
    place: 'Bodega Bay',
    placeEmoji: '🇺🇸',
    theme: 'get-sporty',
    tonight: [],
    tutorial: false,
    ...overrides,
  };
}

const at = (iso: string) => Date.parse(iso);

describe('formatUnlockAt (the locked-Day badge)', () => {
  it('spells the instant out in the Event timezone with a lowercased meridiem', () => {
    expect(formatUnlockAt(at('2026-08-09T13:00:00Z'), 'America/Los_Angeles')).toBe('6:00 a.m. · Sun, Aug 9');
  });

  it('falls back to UTC before the Event doc resolves', () => {
    expect(formatUnlockAt(at('2026-08-09T13:00:00Z'), undefined)).toBe('1:00 p.m. · Sun, Aug 9');
  });
});

describe('unlockCaption (the locked-Day caption under that badge)', () => {
  it.each([
    ['a morning unlock goes bare and keeps the coffee tail', '2026-08-09T06:00:00Z', '24 fresh squares land at 6. Come back after coffee.'],
    ['an off-the-hour unlock carries its minutes', '2026-08-09T09:30:00Z', '24 fresh squares land at 9:30. Come back after coffee.'],
    ['an evening unlock spells the meridiem and drops the coffee', '2026-08-09T20:00:00Z', '24 fresh squares land at 8 p.m. Come back then.'],
    ['noon is not a morning', '2026-08-09T12:00:00Z', '24 fresh squares land at 12 p.m. Come back then.'],
    // 12:xx a.m. is an `AM` day period to `Intl` but nobody's morning.
    ['midnight is not a morning either', '2026-08-09T00:00:00Z', '24 fresh squares land at 12 a.m. Come back then.'],
    ['the small hours keep their minutes and meridiem', '2026-08-09T00:30:00Z', '24 fresh squares land at 12:30 a.m. Come back then.'],
  ])('%s', (_label, iso, expected) => {
    expect(unlockCaption(at(iso), 'UTC')).toBe(expected);
  });

  it('reads the hour in the Event timezone, never the viewer’s', () => {
    // 13:00Z is 6 a.m. in Bodega Bay and 3 p.m. in Rome — same instant, two
    // different sentences, and each Event gets its own.
    expect(unlockCaption(at('2026-08-09T13:00:00Z'), 'America/Los_Angeles')).toBe(
      '24 fresh squares land at 6. Come back after coffee.',
    );
    expect(unlockCaption(at('2026-08-09T13:00:00Z'), 'Europe/Rome')).toBe(
      '24 fresh squares land at 3 p.m. Come back then.',
    );
  });
});

describe('chaosLine (the warm-up banner’s schedule sentence)', () => {
  const TZ = 'America/Los_Angeles';
  // The Bodega Bay schedule as seeded (scripts/seed-data/bodega-bay-2026.mjs):
  // Friday is an easy-pool Day that is NOT tutorial and carries the `unlockAt:
  // 0` open sentinel, then two main Days at 06:00 PDT, then a ceremonial
  // closing Day. The Friday shape is exactly what makes `!tutorial` the wrong
  // predicate.
  const DAYS: DayDef[] = [
    day({ index: 0, pool: 'easy', unlockAt: 0, date: '2026-08-07' }),
    day({ index: 1, pool: 'main', unlockAt: at('2026-08-08T06:00:00-07:00'), date: '2026-08-08' }),
    day({ index: 2, pool: 'main', unlockAt: at('2026-08-09T06:00:00-07:00'), date: '2026-08-09' }),
    day({ index: 3, pool: 'closing', tutorial: true, unlockAt: at('2026-08-09T11:00:00-07:00'), date: '2026-08-09' }),
  ];

  it('names the first MAIN Day’s own unlock hour, not a hardcoded 8', () => {
    // Reading it on the warm-up Day, the evening before.
    expect(chaosLine(DAYS, TZ, at('2026-08-07T20:00:00-07:00'))).toBe(
      'The real chaos starts tomorrow at 6.',
    );
  });

  // Codex P1 on #670: `!tutorial` would select Friday — a competitive EASY
  // card, not tutorial, holding the `unlockAt: 0` open sentinel — read it as
  // long unlocked, and drop the sentence entirely on the one live Edition this
  // whole fix was written for.
  it('skips a non-tutorial easy Day carrying the open sentinel', () => {
    expect(DAYS[0].tutorial).toBe(false); // the trap, pinned
    expect(DAYS[0].unlockAt).toBe(0);
    expect(chaosLine(DAYS, TZ, at('2026-08-07T09:00:00-07:00'))).toBe(
      'The real chaos starts tomorrow at 6.',
    );
  });

  it('says "later today" for an unlock still ahead on the same calendar date', () => {
    expect(chaosLine(DAYS, TZ, at('2026-08-08T05:00:00-07:00'))).toBe(
      'The real chaos starts later today at 6.',
    );
  });

  it('names the weekday when the unlock is further out than tomorrow', () => {
    // Two days ahead — "tomorrow" would be a lie and a bare date is colder.
    expect(chaosLine(DAYS, TZ, at('2026-08-06T09:00:00-07:00'))).toBe(
      'The real chaos starts Saturday at 6.',
    );
  });

  it('falls back to a dated weekday once the weekday alone is ambiguous', () => {
    const far = [DAYS[0], day({ index: 1, pool: 'main', unlockAt: at('2026-08-15T06:00:00-07:00') })];
    expect(chaosLine(far, TZ, at('2026-08-07T09:00:00-07:00'))).toBe(
      'The real chaos starts Sat, Aug 15 at 6.',
    );
  });

  it('keeps the meridiem for a non-morning unlock without doubling the period', () => {
    const evening = [DAYS[0], day({ index: 1, pool: 'main', unlockAt: at('2026-08-08T20:00:00-07:00') })];
    expect(chaosLine(evening, TZ, at('2026-08-07T09:00:00-07:00'))).toBe(
      'The real chaos starts tomorrow at 8 p.m.',
    );
  });

  it('measures "tomorrow" by CALENDAR date in the Event zone, not by elapsed hours', () => {
    // 14 hours out, but the next calendar day in Bodega Bay — "tomorrow", not
    // "later today". The viewer's own clock never enters into it.
    expect(chaosLine(DAYS, TZ, at('2026-08-07T16:00:00-07:00'))).toBe(
      'The real chaos starts tomorrow at 6.',
    );
  });

  it('drops the sentence once the first main Day has unlocked (the mid-event walkthrough replay)', () => {
    expect(chaosLine(DAYS, TZ, at('2026-08-08T06:00:01-07:00'))).toBeNull();
    expect(chaosLine(DAYS, TZ, at('2026-08-09T12:00:00-07:00'))).toBeNull();
  });

  it('drops the sentence when there is no schedule or no main Day to promise', () => {
    expect(chaosLine(undefined, TZ, at('2026-08-07T09:00:00-07:00'))).toBeNull();
    expect(chaosLine([], TZ, at('2026-08-07T09:00:00-07:00'))).toBeNull();
    expect(chaosLine([DAYS[0], DAYS[3]], TZ, at('2026-08-07T09:00:00-07:00'))).toBeNull();
  });

  it('drops the sentence rather than rendering a malformed unlockAt', () => {
    const broken = [DAYS[0], day({ index: 1, pool: 'main', unlockAt: Number.NaN })];
    expect(chaosLine(broken, TZ, at('2026-08-07T09:00:00-07:00'))).toBeNull();
  });

  // Codex P2 on #670: a banner left open goes stale at two boundaries, so it
  // needs to know when the next one is.
  describe('nextChaosBoundary', () => {
    it('lands on the Event zone’s next midnight while that comes first', () => {
      // Friday morning: midnight tonight turns "tomorrow" into "later today",
      // and it arrives before Saturday's 6 a.m. unlock.
      expect(nextChaosBoundary(DAYS, TZ, at('2026-08-07T09:00:00-07:00'))).toBe(
        at('2026-08-08T00:00:00-07:00'),
      );
    });

    it('lands on the unlock itself once midnight is already behind it', () => {
      // Saturday at 05:00 — the next midnight is a day away; the unlock is an
      // hour off, and it is what retires the sentence.
      expect(nextChaosBoundary(DAYS, TZ, at('2026-08-08T05:00:00-07:00'))).toBe(
        at('2026-08-08T06:00:00-07:00'),
      );
    });

    it('reads midnight in the EVENT zone, not the runner’s', () => {
      // 23:00 in Bodega Bay is already 06:00 the next day in Rome — an
      // Event-zone boundary an hour out, not 23 hours.
      const now = at('2026-08-07T23:00:00-07:00');
      expect(nextChaosBoundary(DAYS, TZ, now)).toBe(at('2026-08-08T00:00:00-07:00'));
    });

    it('is null once there is no sentence left to keep fresh', () => {
      expect(nextChaosBoundary(DAYS, TZ, at('2026-08-08T07:00:00-07:00'))).toBeNull();
      expect(nextChaosBoundary(undefined, TZ, at('2026-08-07T09:00:00-07:00'))).toBeNull();
      expect(nextChaosBoundary([DAYS[0]], TZ, at('2026-08-07T09:00:00-07:00'))).toBeNull();
    });

    it('always returns an instant strictly ahead of now, so a re-arm cannot spin', () => {
      for (const iso of ['2026-08-07T00:00:00-07:00', '2026-08-07T23:59:59-07:00', '2026-08-08T05:59:59-07:00']) {
        const now = at(iso);
        const boundary = nextChaosBoundary(DAYS, TZ, now);
        expect(boundary).not.toBeNull();
        expect(boundary as number).toBeGreaterThan(now);
      }
    });
  });
});
