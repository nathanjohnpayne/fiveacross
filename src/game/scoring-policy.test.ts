import { describe, it, expect } from 'vitest';
import { scoringForDay, isCeremonialDay } from './scoring';
import { ceremonialDayIndexSet, standingsFreezeAtFor, standingsFrozen } from './logic';
import { migrateDayFields } from '../data/converters';
import { normalizePool } from './pool';
import { DAYS as GCB_DAYS } from '../data/seed';
import type { DayDef } from '../types';

// ADR 0011: a Day's Scoring Policy is STATED, and the Standings Freeze is an
// Event setting. The load-bearing promise of this ticket is that stating them
// changes NOTHING for the two live Events, whose docs carry neither field — so
// most of what follows is a regression pin, not a feature test.

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function day(overrides: Partial<DayDef> & Pick<DayDef, 'index'>): DayDef {
  return {
    date: '2026-07-16',
    place: 'Split',
    placeEmoji: '🇭🇷',
    theme: 'neon-playground',
    tonight: [],
    pool: 'main',
    tutorial: false,
    unlockAt: NOW - HOUR,
    ...overrides,
  };
}

describe('scoringForDay — stated, with a pool-derived read default', () => {
  it('derives from pool when no policy is stated (every legacy Day)', () => {
    expect(scoringForDay({ pool: 'main' })).toBe('competitive');
    expect(scoringForDay({ pool: 'easy' })).toBe('competitive');
    expect(scoringForDay({ pool: 'embark' })).toBe('competitive');
    expect(scoringForDay({ pool: 'closing' })).toBe('ceremonial');
    // The legacy persisted spelling resolves the same way — both live Events
    // still store `farewell`, so this IS the production path.
    expect(scoringForDay({ pool: 'farewell' })).toBe('ceremonial');
  });

  it('lets a stated policy beat the pool, in BOTH directions', () => {
    // The shape ADR 0011 exists for: a closing-pool final morning that is real
    // competitive play, ending at check-out rather than at the card's unlock.
    expect(scoringForDay({ pool: 'farewell', scoring: 'competitive' })).toBe('competitive');
    // …and its converse: a main-pool Day an organiser wants to run as pure
    // ceremony. Neither was expressible while the pool decided.
    expect(scoringForDay({ pool: 'main', scoring: 'ceremonial' })).toBe('ceremonial');
  });

  it('falls back to the pool derivation for a malformed stored value', () => {
    // Deliberately NOT fail-closed. `ceremonial` is the standings-INERT state,
    // so reading an unreadable value as ceremonial would silently drop a
    // competitive Day's real play out of the standings; the pool derivation is
    // a known-good answer for every Event that exists.
    for (const bad of ['nonsense', '', null, undefined, 0, 1, {}, []]) {
      expect(scoringForDay({ pool: 'main', scoring: bad })).toBe('competitive');
      expect(scoringForDay({ pool: 'farewell', scoring: bad })).toBe('ceremonial');
    }
  });

  it('defaults an absent/garbage pool to competitive, matching normalizePool', () => {
    expect(scoringForDay({})).toBe('competitive');
    expect(scoringForDay(undefined)).toBe('competitive');
    expect(scoringForDay(null)).toBe('competitive');
    expect(scoringForDay({ pool: 'who-knows' })).toBe('competitive');
  });

  it('isCeremonialDay is scoringForDay === ceremonial', () => {
    expect(isCeremonialDay({ pool: 'farewell' })).toBe(true);
    expect(isCeremonialDay({ pool: 'farewell', scoring: 'competitive' })).toBe(false);
    expect(isCeremonialDay({ pool: 'main' })).toBe(false);
  });
});

describe('ceremonialDayIndexSet — keyed on scoring, not pool', () => {
  it('reproduces the old closing-pool answer for a schedule that states nothing', () => {
    const days = [day({ index: 0, pool: 'easy' }), day({ index: 1 }), day({ index: 2, pool: 'closing' })];
    expect([...ceremonialDayIndexSet(days)]).toEqual([2]);
  });

  it('excludes nothing when the final Day states that it counts', () => {
    const days = [
      day({ index: 0, pool: 'easy' }),
      day({ index: 1 }),
      day({ index: 2, pool: 'closing', scoring: 'competitive' }),
    ];
    expect([...ceremonialDayIndexSet(days)]).toEqual([]);
  });

  it('admits MORE than one ceremonial Day', () => {
    // The old `farewellDayIndex` resolved a single index, so a second
    // standings-inert Day silently counted. A set has no such ceiling.
    const days = [
      day({ index: 0 }),
      day({ index: 1, scoring: 'ceremonial' }),
      day({ index: 2, pool: 'closing' }),
    ];
    expect([...ceremonialDayIndexSet(days)]).toEqual([1, 2]);
  });

  it('handles an absent or empty schedule', () => {
    expect([...ceremonialDayIndexSet(undefined)]).toEqual([]);
    expect([...ceremonialDayIndexSet([])]).toEqual([]);
  });
});

describe('standingsFreezeAtFor — the Event setting, with a schedule-derived default', () => {
  const days = [day({ index: 0 }), day({ index: 1, pool: 'closing', unlockAt: NOW })];

  it('derives the first ceremonial Day s unlock when nothing is configured', () => {
    expect(standingsFreezeAtFor({ frozenAt: undefined, days })).toBe(NOW);
  });

  it('prefers a configured freeze over the schedule derivation', () => {
    expect(standingsFreezeAtFor({ frozenAt: undefined, days, standingsFreezeAt: NOW + HOUR })).toBe(
      NOW + HOUR,
    );
  });

  it('gives an all-competitive Event its configured freeze and nothing else', () => {
    const competitive = [day({ index: 0 }), day({ index: 1, pool: 'closing', scoring: 'competitive' })];
    expect(standingsFreezeAtFor({ frozenAt: undefined, days: competitive })).toBeNull();
    expect(
      standingsFreezeAtFor({ frozenAt: undefined, days: competitive, standingsFreezeAt: NOW + HOUR }),
    ).toBe(NOW + HOUR);
  });

  it('ignores a non-positive or non-finite stored value rather than honouring it', () => {
    // 0 is the schedule's "always unlocked" sentinel elsewhere in this contract;
    // honouring it as an instant would freeze every Event at the epoch.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(standingsFreezeAtFor({ frozenAt: undefined, days, standingsFreezeAt: bad })).toBe(NOW);
    }
  });

  it('returns null for a legacy Event with no schedule at all', () => {
    expect(standingsFreezeAtFor({ frozenAt: undefined, days: [] })).toBeNull();
    expect(standingsFreezeAtFor(null)).toBeNull();
    expect(standingsFreezeAtFor(undefined)).toBeNull();
  });
});

describe('standingsFrozen — the stamp, then the scheduled freeze', () => {
  const days = [day({ index: 0 }), day({ index: 1, pool: 'closing', unlockAt: NOW })];

  it('is frozen the moment the scheduler stamps frozenAt, whatever the clock says', () => {
    expect(standingsFrozen({ frozenAt: NOW, days }, NOW - 10 * HOUR)).toBe(true);
  });

  it('fails CLOSED at the scheduled freeze even with no stamp (the stale-cache belt)', () => {
    expect(standingsFrozen({ frozenAt: undefined, days }, NOW - 1)).toBe(false);
    expect(standingsFrozen({ frozenAt: undefined, days }, NOW)).toBe(true);
  });

  it('honours a configured freeze that is LATER than the closing Day s unlock', () => {
    // The bug ADR 0011 closes, stated as a test: this Event's final Day deals
    // the closing pool but plays competitively until check-out. Before, the
    // standings froze at that card's unlock and the morning's marks were inert.
    const competitiveClose = [
      day({ index: 0 }),
      day({ index: 1, pool: 'closing', scoring: 'competitive', unlockAt: NOW }),
    ];
    const event = { frozenAt: undefined, days: competitiveClose, standingsFreezeAt: NOW + 4 * HOUR };
    expect(standingsFrozen(event, NOW)).toBe(false); // the card is open and COUNTING
    expect(standingsFrozen(event, NOW + 4 * HOUR)).toBe(true); // check-out
  });

  it('never freezes an Event with no scheduled freeze', () => {
    expect(standingsFrozen({ frozenAt: undefined, days: [] }, NOW)).toBe(false);
    expect(standingsFrozen(null, NOW)).toBe(false);
  });
});

// --- The regression pin the ticket asks for -------------------------------------

describe('legacy Gay Cruise Bingo docs read byte-identically (ADR 0011)', () => {
  // The real ten-Day schedule, as it is persisted today: legacy pool spellings,
  // and NO `scoring` key on any Day. If resolving the policy ever changes what
  // this Event does, it changes it here first.
  it('resolves the seeded schedule to exactly the old closing-pool answer', () => {
    const resolved = GCB_DAYS.map((d) => migrateDayFields(d));
    // Day 10 is the only ceremonial Day, exactly as `pool === 'closing'` said.
    expect([...ceremonialDayIndexSet(resolved)]).toEqual([9]);
    // …and every other Day counts, INCLUDING the tutorial embark Day, whose
    // marks were always real pre-freeze play.
    for (const d of resolved) {
      expect(scoringForDay(d)).toBe(d.index === 9 ? 'ceremonial' : 'competitive');
    }
  });

  it('freezes at the same instant the pool-scanning derivation used to', () => {
    const resolved = GCB_DAYS.map((d) => migrateDayFields(d));
    const closingUnlock = GCB_DAYS.find((d) => normalizePool(d.pool) === 'closing')!.unlockAt;
    expect(standingsFreezeAtFor({ frozenAt: undefined, days: resolved })).toBe(closingUnlock);
    // The old rule, restated: frozen at-or-after that instant, not before.
    expect(standingsFrozen({ frozenAt: undefined, days: resolved }, closingUnlock - 1)).toBe(false);
    expect(standingsFrozen({ frozenAt: undefined, days: resolved }, closingUnlock)).toBe(true);
  });

  it('adds `scoring` on read WITHOUT disturbing any authored field', () => {
    for (const raw of GCB_DAYS) {
      const migrated = migrateDayFields(raw);
      // `scoring` is the ONLY field this change adds; every authored field must
      // survive untouched. `pool`/`place`/`placeEmoji` are excluded from the
      // passthrough sweep because the converter already resolves those (#565/#566).
      const { scoring, pool, place, placeEmoji, ...passthrough } = migrated;
      expect(scoring).toBe(normalizePool(raw.pool) === 'closing' ? 'ceremonial' : 'competitive');
      for (const [key, value] of Object.entries(passthrough)) {
        expect(value).toEqual((raw as unknown as Record<string, unknown>)[key]);
      }
      expect(pool).toBe(normalizePool(raw.pool));
      expect(place).toBe(raw.place);
      expect(placeEmoji).toBe(raw.placeEmoji);
    }
  });

  // The seed SOURCE speaks the neutral vocabulary, but the live Firestore docs
  // still persist the pre-#565 spellings (CONTEXT.md § Pool: writes deliberately
  // keep emitting them until the post-Event cleanup). So the production read
  // path is a legacy-spelling doc, and it needs its own pin — resolving the
  // Scoring Policy must survive the vocabulary transition, not just the seed.
  it('resolves a legacy-spelling Event doc exactly as the live one is stored', () => {
    const legacyDays = [
      { index: 0, pool: 'embark', tutorial: true, unlockAt: 0 },
      { index: 1, pool: 'main', tutorial: false, unlockAt: NOW - 2 * HOUR },
      { index: 2, pool: 'farewell', tutorial: true, unlockAt: NOW },
    ];
    const resolved = legacyDays.map((d) => migrateDayFields(d));

    expect(resolved.map((d) => d.scoring)).toEqual(['competitive', 'competitive', 'ceremonial']);
    expect([...ceremonialDayIndexSet(resolved)]).toEqual([2]);
    expect(standingsFreezeAtFor({ frozenAt: undefined, days: resolved })).toBe(NOW);
    expect(standingsFrozen({ frozenAt: undefined, days: resolved }, NOW - 1)).toBe(false);
    expect(standingsFrozen({ frozenAt: undefined, days: resolved }, NOW)).toBe(true);
  });
});
