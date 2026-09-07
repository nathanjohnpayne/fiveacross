import { describe, expect, it } from 'vitest';
import {
  buildEventArchive,
  isEventArchived,
  isEventArchiving,
  MAX_ARCHIVED_STANDING_ROWS,
} from './eventArchive';
import type { DayDef, DayMetaDoc, EventDoc, PlayerDoc } from '../types';

// specs/post-sailing-archive.md, unit layer (#134). `buildEventArchive` is the
// whole freeze: whatever it returns is what the archived Leaderboard renders
// forever, so these tests pin the two properties that make the record
// trustworthy — it COPIES the client-authoritative stats rather than
// recomputing them (ADR 0001), and it reuses the live surfaces' own selectors so
// the frozen answers match the last live ones.

function mkPlayer(
  over: Partial<PlayerDoc> & Pick<PlayerDoc, 'uid' | 'displayName'>,
): PlayerDoc {
  return {
    photoURL: null,
    joinedAt: 0,
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    reshufflesUsed: 0,
    ...over,
  };
}

function mkDay(index: number, over: Partial<DayDef> = {}): DayDef {
  return {
    index,
    date: `2026-07-${String(15 + index).padStart(2, '0')}`,
    place: 'Somewhere',
    placeEmoji: '🏖️',
    theme: 'neon-playground',
    tonight: [],
    pool: 'main',
    tutorial: false,
    unlockAt: 1000 * (index + 1),
    ...over,
  } as DayDef;
}

const DAYS = [mkDay(0, { tutorial: true }), mkDay(1), mkDay(2)];

describe('isEventArchived', () => {
  it('is true only for the literal archived status', () => {
    expect(isEventArchived({ status: 'archived' } as EventDoc)).toBe(true);
    expect(isEventArchived({ status: 'active' } as EventDoc)).toBe(false);
    // Absent means OPEN — every Event document written before #134 has no key.
    expect(isEventArchived({} as EventDoc)).toBe(false);
    expect(isEventArchived(null)).toBe(false);
    expect(isEventArchived(undefined)).toBe(false);
  });
});

describe('isEventArchiving', () => {
  it('is true only for the literal closing flag', () => {
    expect(isEventArchiving({ archiving: true } as EventDoc)).toBe(true);
    expect(isEventArchiving({ archiving: false } as EventDoc)).toBe(false);
    // Absent means OPEN, exactly as an absent `status` does.
    expect(isEventArchiving({} as EventDoc)).toBe(false);
    expect(isEventArchiving(null)).toBe(false);
    expect(isEventArchiving(undefined)).toBe(false);
  });

  it('is independent of `isEventArchived` in both directions', () => {
    // The two states are separate on purpose. A CLOSING Event has no record to
    // render, so the Leaderboard stays live — correctly, because the archive
    // does not exist yet — while the archive write CLEARS the flag as it lands.
    // A surface that treated either as implying the other would render an empty
    // archive during the quiesce, or a live Leaderboard after the freeze.
    const closing = { status: 'active', archiving: true } as EventDoc;
    expect(isEventArchived(closing)).toBe(false);
    expect(isEventArchiving(closing)).toBe(true);

    const archived = { status: 'archived', archiving: false } as EventDoc;
    expect(isEventArchived(archived)).toBe(true);
    expect(isEventArchiving(archived)).toBe(false);
  });
});

describe('buildEventArchive — the standings are COPIED, not recomputed', () => {
  it('takes each row straight off the Player-written stats, even when the per-Day buckets disagree', () => {
    // A row whose root totals do not equal the sum of its own `dayStats` is the
    // exact state ADR 0001 refuses to "fix": the Player wrote both, and the
    // archive records what the Leaderboard showed rather than adjudicating.
    const drifted = mkPlayer({
      uid: 'drifted',
      displayName: 'Drifted',
      bingoCount: 3,
      squaresMarked: 20,
      firstBingoAt: 5000,
      blackout: true,
      dayStats: { 1: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 5000 } },
    });
    const archive = buildEventArchive({
      players: [drifted],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 42,
    });
    expect(archive.standings).toEqual([
      {
        uid: 'drifted',
        displayName: 'Drifted',
        bingoCount: 3,
        squaresMarked: 20,
        blackout: true,
        firstBingoAt: 5000,
      },
    ]);
    expect(archive.archivedAt).toBe(42);
    expect(archive.playerCount).toBe(1);
  });

  it('ranks the rows itself, so an unsorted roster still freezes in Leaderboard order', () => {
    const top = mkPlayer({ uid: 'top', displayName: 'Top', bingoCount: 3, squaresMarked: 20 });
    const mid = mkPlayer({ uid: 'mid', displayName: 'Mid', bingoCount: 1, squaresMarked: 18 });
    const low = mkPlayer({ uid: 'low', displayName: 'Low', bingoCount: 1, squaresMarked: 9 });
    const archive = buildEventArchive({
      players: [low, top, mid],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['top', 'mid', 'low']);
  });

  it('bounds the retained rows while playerCount records the true roster size', () => {
    const players = Array.from({ length: 5 }, (_, i) =>
      mkPlayer({ uid: `p${i}`, displayName: `P${i}`, squaresMarked: 10 - i }),
    );
    const archive = buildEventArchive({
      players,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      maxRows: 2,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['p0', 'p1']);
    expect(archive.playerCount).toBe(5);
    // The shipped cap is far above any real roster, so nothing is dropped in
    // practice — the bound exists to keep the Event document writable.
    expect(MAX_ARCHIVED_STANDING_ROWS).toBeGreaterThan(100);
  });
});

describe('buildEventArchive — the hall of fame', () => {
  const early = mkPlayer({
    uid: 'early',
    displayName: 'Early',
    bingoCount: 1,
    squaresMarked: 5,
    firstBingoAt: 2000,
    dayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 2000 } },
  });
  const tutorialOnly = mkPlayer({
    uid: 'tutorial-only',
    displayName: 'Tutorial Only',
    bingoCount: 1,
    squaresMarked: 4,
    firstBingoAt: 500,
    dayStats: { 0: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 500 } },
  });

  it('never credits a Tutorial Day bingo with the headline honour', () => {
    const archive = buildEventArchive({
      players: [tutorialOnly, early],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    // `tutorialOnly` bingoed earlier in wall-clock terms (500 < 2000) and on a
    // Tutorial Day, so the honour is Early's.
    expect(archive.firstBingo).toEqual({ uid: 'early', displayName: 'Early', at: 2000 });
  });

  it('applies the resolved Standings Freeze as the cutoff', () => {
    const late = mkPlayer({
      uid: 'late',
      displayName: 'Late',
      bingoCount: 1,
      squaresMarked: 3,
      firstBingoAt: 9000,
      dayStats: { 2: { bingoCount: 1, squaresMarked: 3, firstBingoAt: 9000 } },
    });
    const frozen = buildEventArchive({
      players: [late],
      event: { days: DAYS, bannedUids: [], frozenAt: 8000 },
      archivedAt: 1,
    });
    expect(frozen.freezeAt).toBe(8000);
    expect(frozen.firstBingo).toBeNull();
    // Without a freeze there is no cutoff, which is every Event that never had
    // one — the pre-ADR-0011 behaviour, unchanged.
    const open = buildEventArchive({
      players: [late],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(open.freezeAt).toBeNull();
    expect(open.firstBingo?.uid).toBe('late');
  });

  it('prefers a pinned day-meta honour and falls back to the derived one', () => {
    const dayMetas = new Map<number, DayMetaDoc>([
      [1, { firstBingo: { uid: 'pinned', displayName: 'Pinned', at: 1500 } }],
    ]);
    const archive = buildEventArchive({
      players: [
        early,
        mkPlayer({
          uid: 'pinned',
          displayName: 'Pinned',
          bingoCount: 1,
          squaresMarked: 9,
          firstBingoAt: 1500,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 9, firstBingoAt: 1500 } },
        }),
        mkPlayer({
          uid: 'day2',
          displayName: 'Day Two',
          bingoCount: 1,
          squaresMarked: 2,
          firstBingoAt: 7000,
          dayStats: { 2: { bingoCount: 1, squaresMarked: 2, firstBingoAt: 7000 } },
        }),
      ],
      event: { days: DAYS, bannedUids: [] },
      dayMetas,
      archivedAt: 1,
    });
    expect(archive.dailyHonors).toEqual([
      { dayIndex: 1, uid: 'pinned', displayName: 'Pinned', firstBingoAt: 1500 },
      { dayIndex: 2, uid: 'day2', displayName: 'Day Two', firstBingoAt: 7000 },
    ]);
  });
});

describe('buildEventArchive — a ban hides, it never reassigns', () => {
  const banned = mkPlayer({
    uid: 'banned',
    displayName: 'Banned',
    bingoCount: 2,
    squaresMarked: 20,
    firstBingoAt: 1000,
    dayStats: { 1: { bingoCount: 2, squaresMarked: 20, firstBingoAt: 1000 } },
  });
  const later = mkPlayer({
    uid: 'later',
    displayName: 'Later',
    bingoCount: 1,
    squaresMarked: 6,
    firstBingoAt: 3000,
    dayStats: { 1: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 3000 } },
  });

  it('drops a banned Player from the standings and from every honour', () => {
    const archive = buildEventArchive({
      players: [banned, later],
      event: { days: DAYS, bannedUids: ['banned'] },
      dayMetas: new Map<number, DayMetaDoc>([
        [1, { firstBingo: { uid: 'banned', displayName: 'Banned', at: 1000 } }],
      ]),
      archivedAt: 1,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['later']);
    expect(archive.playerCount).toBe(1);
    // The headline is selected over the RAW roster and then hidden — so the
    // honour goes to NOBODY rather than being handed to the next Player, who
    // was never first (specs/w2-ban-console.md § Leaderboard, made permanent).
    expect(archive.firstBingo).toBeNull();
    // The pinned Day-1 honour is the banned Player's, so that Day gets no chip
    // rather than the derived runner-up.
    expect(archive.dailyHonors).toEqual([]);
  });
});
