import { describe, it, expect } from 'vitest';
import {
  lastCallStandingsCopy,
  buildPodiumPayload,
  freezePhraseForUnlock,
  normalizeTimezone,
  DEFAULT_FREEZE_PHRASE,
  DEFAULT_TIMEZONE,
  type FinaleDay,
  type FinaleDayHonorDoc,
  type FinalePlayer,
} from '../../functions/src/finaleContent';

// Covers specs/d15-finale.md, functions layer: the pure content the scheduler's
// 20:00-D9 / 08:00-D10 triggers call into. No firebase-admin, no live backend.

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

// A 3-Day cruise: embark (Day 0, tutorial), one main Day (Day 1), farewell
// (Day 2, tutorial). Mirrors the client fixture in src/data/d15-finale.test.ts.
const DAYS: FinaleDay[] = [
  { index: 0, pool: 'embark', tutorial: true },
  { index: 1, pool: 'main' },
  { index: 2, pool: 'farewell', tutorial: true },
];

function player(p: Partial<FinalePlayer> & Pick<FinalePlayer, 'uid'>): FinalePlayer {
  return {
    displayName: p.uid,
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    ...p,
  };
}

describe('lastCallStandingsCopy', () => {
  it('names the leader and their bingo margin (spec example shape)', () => {
    const players = [
      player({ uid: 'Jess', bingoCount: 4, squaresMarked: 30, firstBingoAt: NOW }),
      player({ uid: 'Rex', bingoCount: 2, squaresMarked: 28, firstBingoAt: NOW + HOUR }),
    ];
    expect(lastCallStandingsCopy(players)).toBe(
      `Jess leads by 2 bingos—${DEFAULT_FREEZE_PHRASE}.`,
    );
  });

  it('singularizes a one-bingo margin', () => {
    const players = [
      player({ uid: 'Jess', bingoCount: 2, squaresMarked: 30 }),
      player({ uid: 'Rex', bingoCount: 1, squaresMarked: 28 }),
    ];
    expect(lastCallStandingsCopy(players)).toContain('leads by 1 bingo—');
  });

  it('falls back to a square margin when bingos tie', () => {
    const players = [
      player({ uid: 'Jess', bingoCount: 1, squaresMarked: 22 }),
      player({ uid: 'Rex', bingoCount: 1, squaresMarked: 15 }),
    ];
    expect(lastCallStandingsCopy(players)).toContain('Jess leads by 7 squares—');
  });

  it('degrades to a generic line on a dead heat at the top', () => {
    const players = [
      player({ uid: 'Jess', bingoCount: 2, squaresMarked: 20 }),
      player({ uid: 'Rex', bingoCount: 2, squaresMarked: 20 }),
    ];
    expect(lastCallStandingsCopy(players)).toBe(
      `It's neck and neck at the top going into the final night—${DEFAULT_FREEZE_PHRASE}.`,
    );
  });

  it('degrades to a generic line on an empty board', () => {
    expect(lastCallStandingsCopy([])).toContain('wide open going into the final night');
    expect(lastCallStandingsCopy([player({ uid: 'Ghost' })])).toContain('wide open');
  });

  it('honors an injected freeze phrase', () => {
    const players = [player({ uid: 'Jess', bingoCount: 2 }), player({ uid: 'Rex', bingoCount: 1 })];
    expect(lastCallStandingsCopy(players, { freezePhrase: 'standings freeze at noon' })).toBe(
      'Jess leads by 1 bingo—standings freeze at noon.',
    );
  });
});

describe('freezePhraseForUnlock (#800)', () => {
  it('formats the ACTUAL closing-Day unlock in the Event timezone, not a hardcoded 8 a.m.', () => {
    // Bodega's tail: closing Day unlocks at 11:00 America/Los_Angeles.
    const unlockAt = Date.UTC(2026, 6, 25, 18, 0); // 11:00 PDT (UTC-7)
    expect(freezePhraseForUnlock(unlockAt, 'America/Los_Angeles')).toBe('standings freeze at 11 a.m');
  });

  it('keeps the minutes when the unlock is off the hour', () => {
    const unlockAt = Date.UTC(2026, 6, 25, 15, 30); // 8:30 a.m. America/Los_Angeles
    expect(freezePhraseForUnlock(unlockAt, 'America/Los_Angeles')).toBe('standings freeze at 8:30 a.m');
  });

  it('formats a p.m. unlock', () => {
    const unlockAt = Date.UTC(2026, 6, 25, 20, 0); // 1:00 p.m. America/Los_Angeles
    expect(freezePhraseForUnlock(unlockAt, 'America/Los_Angeles')).toBe('standings freeze at 1 p.m');
  });

  it("#800 Codex P2: defaults to 'Europe/Rome' (eventConverter's own legacy default) when no timezone is given, not UTC", () => {
    // 11:00 UTC is 13:00 (1 p.m.) in Europe/Rome (UTC+2, July DST). A raw
    // Firestore Event doc missing `timezone` must land on the SAME zone the
    // client resolves through `eventConverter`, or the two rendering paths
    // disagree again — exactly the bug class #800 exists to close.
    const unlockAt = Date.UTC(2026, 6, 25, 11, 0);
    expect(freezePhraseForUnlock(unlockAt, undefined)).toBe('standings freeze at 1 p.m');
  });

  it('falls back to the historical default phrase when the unlock is missing or invalid', () => {
    expect(freezePhraseForUnlock(undefined, 'America/Los_Angeles')).toBe(DEFAULT_FREEZE_PHRASE);
    expect(freezePhraseForUnlock(Number.NaN, 'America/Los_Angeles')).toBe(DEFAULT_FREEZE_PHRASE);
  });

  it("degrades to 'Europe/Rome' formatting on an unusable timezone, rather than crashing the beat", () => {
    const unlockAt = Date.UTC(2026, 6, 25, 11, 0);
    expect(freezePhraseForUnlock(unlockAt, 'Not/A_Zone')).toBe('standings freeze at 1 p.m');
  });

  it('produces the exact string DEFAULT_FREEZE_PHRASE bakes when the unlock genuinely IS 08:00', () => {
    // Atlantic/Reykjavik: a REAL IANA zone at a fixed UTC+0 offset year-round
    // (no DST) — 'UTC' itself is rejected by normalizeTimezone (#800 Codex P2:
    // it must resolve to a real 'Area/Location' zone, matching the client
    // contract), so this is the honest way to pin an 08:00 UTC unlock.
    const unlockAt = Date.UTC(2026, 6, 25, 8, 0);
    expect(freezePhraseForUnlock(unlockAt, 'Atlantic/Reykjavik')).toBe(DEFAULT_FREEZE_PHRASE);
  });
});

describe('normalizeTimezone (#800 Codex P2)', () => {
  it('passes through a real, canonical IANA zone', () => {
    expect(normalizeTimezone('America/Los_Angeles')).toBe('America/Los_Angeles');
  });

  it('falls back to DEFAULT_TIMEZONE for a missing/blank/non-string value', () => {
    expect(normalizeTimezone(undefined)).toBe(DEFAULT_TIMEZONE);
    expect(normalizeTimezone(null)).toBe(DEFAULT_TIMEZONE);
    expect(normalizeTimezone('')).toBe(DEFAULT_TIMEZONE);
    expect(normalizeTimezone('   ')).toBe(DEFAULT_TIMEZONE);
    expect(normalizeTimezone(42)).toBe(DEFAULT_TIMEZONE);
  });

  it('rejects an offset-style id', () => {
    expect(normalizeTimezone('+02:00')).toBe(DEFAULT_TIMEZONE);
    expect(normalizeTimezone('Etc/GMT+5')).toBe(DEFAULT_TIMEZONE);
  });

  it('rejects a GMT/UTC alias and a separator-less abbreviation', () => {
    expect(normalizeTimezone('UTC')).toBe(DEFAULT_TIMEZONE);
    expect(normalizeTimezone('GMT')).toBe(DEFAULT_TIMEZONE);
    expect(normalizeTimezone('EST')).toBe(DEFAULT_TIMEZONE);
  });

  it('rejects an unresolvable zone id', () => {
    expect(normalizeTimezone('Mars/Olympus')).toBe(DEFAULT_TIMEZONE);
  });

  it('DEFAULT_TIMEZONE is Europe/Rome, matching eventConverter', () => {
    expect(DEFAULT_TIMEZONE).toBe('Europe/Rome');
  });
});

describe('buildPodiumPayload', () => {
  const HONORS: FinaleDayHonorDoc[] = Array.from({ length: 10 }, (_, i) => ({
    dayIndex: i,
    firstBingo: { uid: `w${i}`, displayName: `Winner ${i}`, at: NOW + i },
  }));

  it('crowns the top of the standings as champion', () => {
    const players = [
      player({ uid: 'alice', bingoCount: 3, squaresMarked: 20, firstBingoAt: NOW }),
      player({ uid: 'bob', bingoCount: 1, squaresMarked: 30, firstBingoAt: NOW }),
    ];
    expect(buildPodiumPayload(players, DAYS, HONORS).champion?.uid).toBe('alice');
  });

  it('excludes an embark/farewell-only first-bingo from the cruise-wide honor', () => {
    const players = [
      player({
        uid: 'tammy',
        bingoCount: 1,
        squaresMarked: 24,
        firstBingoAt: NOW,
        dayStats: { 0: { bingoCount: 1, squaresMarked: 24, firstBingoAt: NOW } },
      }),
      player({
        uid: 'gary',
        bingoCount: 1,
        squaresMarked: 10,
        firstBingoAt: NOW + HOUR,
        dayStats: { 1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: NOW + HOUR } },
      }),
    ];
    const payload = buildPodiumPayload(players, DAYS, HONORS);
    expect(payload.firstBingo?.uid).toBe('gary');
  });

  it('freezes out the farewell Day from the champion totals', () => {
    const players = [
      player({
        uid: 'fran',
        bingoCount: 5,
        squaresMarked: 40,
        firstBingoAt: NOW,
        dayStats: {
          1: { bingoCount: 1, squaresMarked: 8, firstBingoAt: NOW },
          2: { bingoCount: 4, squaresMarked: 32, firstBingoAt: NOW + HOUR },
        },
      }),
      player({
        uid: 'ed',
        bingoCount: 2,
        squaresMarked: 20,
        firstBingoAt: NOW + HOUR,
        dayStats: { 1: { bingoCount: 2, squaresMarked: 20, firstBingoAt: NOW + HOUR } },
      }),
    ];
    const payload = buildPodiumPayload(players, DAYS, HONORS);
    expect(payload.champion?.uid).toBe('ed');
    expect(payload.champion?.bingoCount).toBe(2);
  });

  it('includes all ten daily honors when present, sorted by Day index', () => {
    const shuffled = [...HONORS].reverse();
    const payload = buildPodiumPayload([player({ uid: 'a', bingoCount: 1 })], DAYS, shuffled);
    expect(payload.dailyHonors).toHaveLength(10);
    expect(payload.dailyHonors.map((h) => h.dayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('omits Days with no pinned honor', () => {
    const sparse: FinaleDayHonorDoc[] = [
      { dayIndex: 1, firstBingo: { uid: 'w1', displayName: 'W1', at: NOW } },
      { dayIndex: 2, firstBingo: null },
      { dayIndex: 3 },
    ];
    const payload = buildPodiumPayload([player({ uid: 'a', bingoCount: 1 })], DAYS, sparse);
    expect(payload.dailyHonors.map((h) => h.dayIndex)).toEqual([1]);
  });

  it('returns a null champion for an empty board', () => {
    expect(buildPodiumPayload([player({ uid: 'ghost' })], DAYS, []).champion).toBeNull();
  });
});
