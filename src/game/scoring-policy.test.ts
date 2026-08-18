import { describe, it, expect } from 'vitest';
import { scoringForDay, isCeremonialDay } from './scoring';
import {
  aggregatePlayerStats,
  ceremonialDayIndexSet,
  eventFirstBingoWinner,
  foldEchoStats,
  playerRowRootLag,
  rankingExcludedDay,
  standingsFreezeAtFor,
  standingsFrozen,
} from './logic';
import { migrateDayFields } from '../data/converters';
import { normalizePool } from './pool';
import { DAYS as GCB_DAYS } from '../data/seed';
import * as BODEGA from '../../scripts/seed-data/bodega-bay-2026.mjs';
import type { DayDef, PlayerDoc } from '../types';

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

// --- The live Event that ALREADY stores both fields -----------------------------
//
// Bodega Bay's seed has written `scoring` on every Day and `standingsFreezeAt`
// on the Event since #787, back when nothing read either. This change is what
// makes them LIVE, so "legacy docs are byte-identical" is not the whole promise
// for that Event — the stated values have to agree with what the pool-scanning
// code inferred, or a real Event's podium moves the day this ships.
//
// The seed says they agree on purpose ("the same instant as the wrap-up Day's
// unlock, so the inferred and stated freeze agree"). This asserts it, so a later
// edit to the seed that breaks the agreement fails here rather than in the Feed.
describe('Bodega Bay stores both fields, and they agree with the derivation', () => {
  const days = BODEGA.EVENT_SEED.days as Array<Record<string, unknown>>;

  it('states a scoring policy on every Day that matches the pool derivation', () => {
    for (const raw of days) {
      expect(raw.scoring).toBeDefined(); // the seed really does write it
      // What the Day states, and what the pool alone would have said.
      const stated = scoringForDay(raw);
      const derived = scoringForDay({ pool: raw.pool });
      expect(stated).toBe(derived);
    }
    // …and the resolved shape is the one the Event actually wants: a
    // competitive easy-pool Friday, and a single ceremonial wrap-up.
    expect(days.map((d) => scoringForDay(d))).toEqual([
      'competitive',
      'competitive',
      'competitive',
      'ceremonial',
    ]);
  });

  it('states a freeze equal to the instant the derivation would have produced', () => {
    const resolved = days.map((d) => migrateDayFields(d));
    const stated = BODEGA.EVENT_SEED.standingsFreezeAt as number;
    const derivedFromSchedule = standingsFreezeAtFor({ frozenAt: undefined, days: resolved });
    expect(typeof stated).toBe('number');
    expect(stated).toBe(derivedFromSchedule);
    // Stated as the wrap-up Day's own unlock — the equality the seed comment
    // promises, spelled out so breaking it is loud.
    expect(stated).toBe(days[3].unlockAt);
  });

  it('freezes at the same instant whether the stored field is honoured or ignored', () => {
    const resolved = days.map((d) => migrateDayFields(d));
    const stated = BODEGA.EVENT_SEED.standingsFreezeAt as number;
    const withField = { frozenAt: undefined, days: resolved, standingsFreezeAt: stated };
    const withoutField = { frozenAt: undefined, days: resolved };
    for (const at of [stated - 1, stated, stated + 1]) {
      expect(standingsFrozen(withField, at)).toBe(standingsFrozen(withoutField, at));
    }
  });
});

// --- The ranking tie-break (Codex P1, round 2) -----------------------------------
describe('rankingExcludedDay — the standings tie-break drops ceremonial Days too', () => {
  const isTutorial = (i: number) => i === 0;
  const isCeremonial = (i: number) => i === 2;

  it('unions the two exclusions', () => {
    const pred = rankingExcludedDay(isTutorial, isCeremonial);
    expect([0, 1, 2, 3].map(pred)).toEqual([true, false, true, false]);
  });

  it('degrades to tutorial-only when no ceremonial predicate is supplied', () => {
    const pred = rankingExcludedDay(isTutorial);
    expect([0, 1, 2, 3].map(pred)).toEqual([true, false, false, false]);
  });

  it('keeps a ceremonial Day out of the aggregated root firstBingoAt', () => {
    // The root is `comparePlayers`' tie-break input, so a ceremonial Mark must
    // not decide the standings while its bingos and squares are excluded.
    const dayStats = {
      1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 500 },
      2: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 10 }, // ceremonial, earliest
    };
    const agg = aggregatePlayerStats(dayStats, isTutorial, isCeremonial);
    expect(agg.firstBingoAt).toBe(500);
    // …and its bingos/squares were already excluded from the sums.
    expect(agg).toMatchObject({ bingoCount: 1, squaresMarked: 10 });
  });

  it('matches what playerRowRootLag already assumes the root contains', () => {
    // The fold that WRITES the root and the predicate that AUDITS it derive the
    // bucket evidence the same way, so a row on a ceremonial+non-tutorial
    // schedule does not read as permanently lagging and re-heal forever.
    const dayStats = {
      1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 500 },
      2: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 10 },
    };
    const agg = aggregatePlayerStats(dayStats, isTutorial, isCeremonial);
    const row = { dayStats, ...agg };
    expect(playerRowRootLag(row, isCeremonial, isTutorial)).toBe(false);
  });
});

// --- Codex round 3: the echo fold uses the same ranking exclusion ----------------
describe('foldEchoStats — the echo path ranks the same way the mark path does', () => {
  it('keeps a ceremonial Day out of the root firstBingoAt it writes', () => {
    // An Echo landing a bingo on a ceremonial (non-Tutorial) Day must not give
    // the row a ceremonial tie-break while that Day's counts are excluded.
    const out = foldEchoStats({
      priorDayStats: { 1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 500 } },
      // `bingoAt` is the echo's cells-derived completion time — the stamp
      // `foldEchoStats` records for this Day's previously unstamped bingo.
      echoes: [{ dayIndex: 2, bingoCount: 1, squaresMarked: 10, blackout: false, bingoAt: 10 }],
      now: 10,
      isTutorialDay: (i: number) => i === 0,
      isCeremonialDay: (i: number) => i === 2,
    });
    expect(out.firstBingoAt).toBe(500);
    // The ceremonial Day's counts are excluded from the roots too…
    expect(out).toMatchObject({ bingoCount: 1, squaresMarked: 10 });
    // …while its own per-Day bucket is still recorded (its daily honour stands).
    expect(out.dayStats[2]).toMatchObject({ bingoCount: 1, squaresMarked: 10 });
  });
});

// --- Phase 4b P1/P2: the shared honour selector and its inclusive boundary -------
describe('eventFirstBingoWinner — one selector, one boundary', () => {
  const isTutorial = (i: number) => i === 0;
  const row = (uid: string, dayIndex: number, at: number): PlayerDoc =>
    ({
      uid,
      displayName: uid,
      photoURL: null,
      joinedAt: 0,
      bingoCount: 1,
      squaresMarked: 5,
      firstBingoAt: at,
      reshufflesUsed: 0,
      dayStats: { [dayIndex]: { bingoCount: 1, squaresMarked: 5, firstBingoAt: at } },
    }) as PlayerDoc;

  it('excludes Tutorial Days regardless of any cutoff', () => {
    expect(eventFirstBingoWinner([row('t', 0, 10), row('c', 1, 50)], isTutorial)?.uid).toBe('c');
  });

  it('ignores bingos at or after the freeze — INCLUSIVE at the instant itself', () => {
    const FREEZE = 1_000;
    // Strictly before: eligible.
    expect(eventFirstBingoWinner([row('a', 1, FREEZE - 1)], isTutorial, FREEZE)?.at).toBe(FREEZE - 1);
    // Exactly AT the freeze: not eligible. `standingsFrozen` is already true at
    // `now >= freezeAt` and the last-call window is half-open at the same
    // boundary, so that millisecond belongs to the frozen side.
    expect(eventFirstBingoWinner([row('a', 1, FREEZE)], isTutorial, FREEZE)).toBeUndefined();
    expect(eventFirstBingoWinner([row('a', 1, FREEZE + 1)], isTutorial, FREEZE)).toBeUndefined();
  });

  it('picks the earliest ELIGIBLE bingo, not the earliest overall', () => {
    const FREEZE = 1_000;
    // The globally earliest is post-freeze; the honour must skip it entirely
    // rather than report nobody.
    const winner = eventFirstBingoWinner(
      [row('late', 1, FREEZE + 5), row('early', 1, FREEZE - 5)],
      isTutorial,
      FREEZE,
    );
    expect(winner?.uid).toBe('early');
  });

  it('applies no cutoff when none is supplied', () => {
    expect(eventFirstBingoWinner([row('a', 1, 9_999)], isTutorial)?.uid).toBe('a');
    expect(eventFirstBingoWinner([row('a', 1, 9_999)], isTutorial, null)?.uid).toBe('a');
  });
});

// A ceremonial Day carrying the `unlockAt: 0` "live from event open" sentinel
// schedules NO freeze, rather than one at the epoch. Caught by the Leaderboard
// suite when the honour cutoff landed: an epoch freeze puts every Mark in the
// Event's history at-or-after the boundary, blanking the podium and the pin
// permanently. Mirrors the snapshot path, where a non-positive cutoff has
// always meant "no cutoff" (#289).
describe('the unlockAt sentinel is not a freeze instant', () => {
  it('schedules no freeze for a ceremonial Day carrying the 0 sentinel', () => {
    const days = [day({ index: 0 }), day({ index: 1, pool: 'closing', unlockAt: 0 })];
    expect(standingsFreezeAtFor({ frozenAt: undefined, days })).toBeNull();
    expect(standingsFrozen({ frozenAt: undefined, days }, NOW)).toBe(false);
  });

  it('falls through the sentinel to a LATER ceremonial Day that carries a real instant', () => {
    const days = [
      day({ index: 0, pool: 'closing', unlockAt: 0 }),
      day({ index: 1, pool: 'closing', unlockAt: NOW }),
    ];
    expect(standingsFreezeAtFor({ frozenAt: undefined, days })).toBe(NOW);
  });

  it('still honours the scheduler stamp even with a sentinel schedule', () => {
    // `frozenAt` is evidence the freeze HAPPENED, independent of derivation.
    const days = [day({ index: 0 }), day({ index: 1, pool: 'closing', unlockAt: 0 })];
    expect(standingsFrozen({ frozenAt: NOW, days }, NOW)).toBe(true);
  });
});
