import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cell } from '../types';

// specs/d15-scoring-aggregates.md — data-layer unit tests, no Firestore/emulator.
//   1. setMark folds a Mark into `dayStats[dayIndex]` (the marked Board's own
//      dayIndex) and writes the summed cruise-wide root alongside — leaving other
//      Days' buckets untouched (a nested { merge:true } write).
//   2. dayMeta.ts's `pinDayFirstBingo`: the write-once per-Day First to BINGO pin,
//      cache-pre-checked and fire-and-forget (mirroring moments.ts).
//   3. moments.ts's `broadcastBlackout`'s optional `dayIndex`: the per-card
//      blackout Moment that names its Day (fix/d15-blackout-day-naming), same
//      cache-pre-checked, fire-and-forget write as every other Moment.

type FakeSnap = { exists: () => boolean; data: () => unknown };

const { setSpy, commitSpy, getDocFromCacheSpy, setDocSpy } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSpy: vi.fn((..._args: any[]) => {}),
  commitSpy: vi.fn(() => Promise.resolve()),
  getDocFromCacheSpy: vi.fn((): Promise<FakeSnap> => Promise.reject(new Error('no cache'))),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setDocSpy: vi.fn((..._args: any[]): Promise<void> => Promise.resolve()),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026' }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
    writeBatch: () => ({ set: setSpy, commit: commitSpy, delete: vi.fn() }),
    getDocFromCache: getDocFromCacheSpy,
    setDoc: setDocSpy,
    addDoc: vi.fn(),
    runTransaction: vi.fn(),
  };
});

import { setMark } from './api';
import {
  pinDayFirstBingo,
  enqueueHeldHonorPin,
  takeHeldHonorPins,
  dropHeldHonorPins,
  __resetHeldHonorPinsForTests,
} from './dayMeta';
import { broadcastBlackout } from './moments';

const EVENT_ID = 'med-2026';
const flush = () => new Promise((r) => setTimeout(r, 0));

function dealt(): Cell[] {
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `i${index}`,
    text: index === 12 ? 'FREE' : `p${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
}

const snap = (data: unknown): FakeSnap => ({ exists: () => true, data: () => data });

describe('setMark folds into dayStats[dayIndex] and derives the cruise-wide root', () => {
  beforeEach(() => vi.clearAllMocks());

  it("credits the Board's own Day and leaves other Days' buckets untouched", async () => {
    // Cached Board carries dayIndex 3; cached Player already has a Day-2 bucket.
    getDocFromCacheSpy
      .mockResolvedValueOnce(snap({ cells: dealt(), dayIndex: 3 })) // board read
      .mockResolvedValueOnce(
        snap({
          firstBingoAt: 500,
          displayName: 'Marker',
          dayStats: { 2: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 500 } },
        }),
      ); // player read

    await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 3,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
    });

    // Three writes: board, player, Tally marker (same batch as always).
    expect(setSpy.mock.calls[1][0].path).toBe(`events/${EVENT_ID}/players/u1`);
    const playerWrite = setSpy.mock.calls[1][1] as {
      dayStats: Record<number, unknown>;
      bingoCount: number;
      squaresMarked: number;
      firstBingoAt: number | null;
    };
    // Only the marked Day (3) is written — Day 2 is preserved by the nested merge.
    expect(playerWrite.dayStats).toEqual({
      3: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
    });
    // Root re-derives over Day 2 (prior) + Day 3 (this mark): 1 bingo, 6 squares,
    // earliest main-game first-bingo still Day 2's 500.
    expect(playerWrite.bingoCount).toBe(1);
    expect(playerWrite.squaresMarked).toBe(6);
    expect(playerWrite.firstBingoAt).toBe(500);
    expect(setSpy.mock.calls[1][2]).toEqual({ merge: true });
  });

  it('defaults to Day 0 for a legacy single Board with no cached dayIndex', async () => {
    // No cache for either doc (rejections) — the fresh single-Board shape.
    await setMark({
      uid: 'u2',
      cells: dealt(),
      index: 5,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
    });
    const playerWrite = setSpy.mock.calls[1][1] as { dayStats: Record<number, unknown> };
    expect(playerWrite.dayStats).toEqual({
      0: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
    });
  });

  it('excludes the CEREMONIAL (farewell) bucket from the summed root totals while still writing its per-Day bucket (#265)', async () => {
    // Cached Board is the farewell Day (9); the Player already has real Day-2 play.
    getDocFromCacheSpy
      .mockResolvedValueOnce(snap({ cells: dealt(), dayIndex: 9 })) // board read
      .mockResolvedValueOnce(
        snap({
          firstBingoAt: 500,
          displayName: 'Marker',
          dayStats: { 2: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 500 } },
        }),
      ); // player read

    await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 3,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      tutorialDayIndexes: [0, 9],
      ceremonialDayIndexes: [9],
    });

    const playerWrite = setSpy.mock.calls[1][1] as {
      dayStats: Record<number, unknown>;
      bingoCount: number;
      squaresMarked: number;
    };
    // The farewell bucket records (its daily honor still renders)…
    expect(playerWrite.dayStats).toEqual({
      9: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
    });
    // …but the ROOT sums exclude it: only Day 2's real play counts.
    expect(playerWrite.bingoCount).toBe(1);
    expect(playerWrite.squaresMarked).toBe(5);
  });

  it('frozen + CEREMONIAL day: narrows to the bucket-only player write — the farewell honor record survives, the roots never move (#265; Codex P2s on #278)', async () => {
    getDocFromCacheSpy
      .mockResolvedValueOnce(snap({ cells: dealt(), dayIndex: 9 })) // board read (the farewell card)
      .mockResolvedValueOnce(snap({ firstBingoAt: null, displayName: 'Marker' })); // player read

    await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 3,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      statsFrozen: true,
      ceremonialDayIndexes: [9],
    });

    const playerCall = setSpy.mock.calls.find((c) => (c[0] as { path: string }).path.includes('/players/'));
    expect(playerCall).toBeTruthy();
    const write = playerCall![1] as Record<string, unknown>;
    // ONLY the per-Day bucket — no root aggregates, no blackout flag.
    expect(Object.keys(write)).toEqual(['dayStats']);
    expect(write.dayStats).toEqual({ 9: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } });
    const paths = setSpy.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(paths.some((p) => p.includes('/tally/'))).toBe(true);
  });

  it('frozen + MAIN day: writes NO player stats at all — a post-freeze mark cannot drift the settled daily honors (Codex P2 on #278 round 2)', async () => {
    getDocFromCacheSpy
      .mockResolvedValueOnce(snap({ cells: dealt(), dayIndex: 4 })) // board read (a main day)
      .mockResolvedValueOnce(snap({ firstBingoAt: null, displayName: 'Marker' })); // player read

    await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 3,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      statsFrozen: true,
      ceremonialDayIndexes: [9],
    });

    const paths = setSpy.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(paths.some((p) => p.includes('/players/'))).toBe(false);
    expect(paths.some((p) => p.includes('/tally/'))).toBe(true); // the card stays honest
  });
});

describe('dayMeta.pinDayFirstBingo (write-once per-Day honor)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHeldHonorPinsForTests();
  });

  it('creates the day-meta doc with the attributed firstBingo payload on a cache miss', async () => {
    await pinDayFirstBingo(4, { uid: 'u1', displayName: 'Alice', photoURL: null }, 1234);
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(setDocSpy.mock.calls[0][0].path).toBe(`events/${EVENT_ID}/days/4/meta/4`);
    expect(setDocSpy.mock.calls[0][1]).toEqual({
      firstBingo: { uid: 'u1', displayName: 'Alice', at: 1234 },
    });
  });

  it('skips the write when the Day honor is already in the local cache', async () => {
    getDocFromCacheSpy.mockResolvedValueOnce(snap({ firstBingo: { uid: 'x', displayName: 'X', at: 1 } }));
    await pinDayFirstBingo(4, { uid: 'u1', displayName: 'Alice', photoURL: null }, 1234);
    expect(setDocSpy).not.toHaveBeenCalled();
  });

  it('drains only the requested held Day and can drop a fallen held honor', () => {
    enqueueHeldHonorPin('u1', 1, 111);
    enqueueHeldHonorPin('u1', 2, 222);
    enqueueHeldHonorPin('u2', 1, 333);

    expect(takeHeldHonorPins('u1', 1)).toEqual([{ eventId: EVENT_ID, uid: 'u1', dayIndex: 1, at: 111 }]);
    dropHeldHonorPins('u1', 2);

    expect(takeHeldHonorPins('u1')).toEqual([]);
    expect(takeHeldHonorPins('u2')).toEqual([{ eventId: EVENT_ID, uid: 'u2', dayIndex: 1, at: 333 }]);
  });

  it('pins to the Event captured by the operation instead of the ambient Event', async () => {
    await pinDayFirstBingo(4, { uid: 'u1', displayName: 'Alice', photoURL: null }, 1234, 'event-a');

    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(setDocSpy.mock.calls[0][0].path).toBe('events/event-a/days/4/meta/4');
  });

  it('keeps held honors isolated when the same User and Day exist in Events A and B', () => {
    enqueueHeldHonorPin('u1', 1, 111, 'event-a');
    enqueueHeldHonorPin('u1', 1, 222, 'event-b');

    expect(takeHeldHonorPins('u1', 1, 'event-a')).toEqual([{ eventId: 'event-a', uid: 'u1', dayIndex: 1, at: 111 }]);
    dropHeldHonorPins('u1', 1, 'event-a');
    expect(takeHeldHonorPins('u1', 1, 'event-b')).toEqual([{ eventId: 'event-b', uid: 'u1', dayIndex: 1, at: 222 }]);
  });
});

describe('moments.broadcastBlackout — optional dayIndex names the Day (fix/d15-blackout-day-naming)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts a blackout Moment carrying the dayIndex on a cache miss', async () => {
    broadcastBlackout({ uid: 'u1', displayName: 'Alice', photoURL: null }, 4);
    await flush();
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    // Deterministic PER-CARD id ${uid}-blackout-d${dayIndex} (#267): blackout is
    // per-card, so the dedup id scopes to the (Player, Day) pair — a second
    // Day's blackout posts its own Moment; re-marking the same card cannot.
    expect(setDocSpy.mock.calls[0][0].path).toBe(`events/${EVENT_ID}/moments/u1-blackout-d4`);
    expect(setDocSpy.mock.calls[0][1]).toMatchObject({
      kind: 'blackout',
      uid: 'u1',
      displayName: 'Alice',
      dayIndex: 4,
    });
  });

  it('omits dayIndex entirely (never an explicit undefined) when the caller supplies none', async () => {
    broadcastBlackout({ uid: 'u1', displayName: 'Alice', photoURL: null });
    await flush();
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect('dayIndex' in (setDocSpy.mock.calls[0][1] as object)).toBe(false);
  });

  it('skips the broadcast when the Moment is already in the local cache', async () => {
    // Path-aware (#275 round 2): the day-scoped path pre-checks the LEGACY
    // day-less doc first, then its own per-card id — here only the per-card
    // doc is cached, which is what must trigger the skip.
    getDocFromCacheSpy.mockImplementation(((ref: { path: string }) =>
      ref.path.endsWith('u1-blackout-d4')
        ? Promise.resolve(snap({ kind: 'blackout', uid: 'u1' }))
        : Promise.reject(new Error('unavailable'))) as unknown as () => Promise<never>);
    broadcastBlackout({ uid: 'u1', displayName: 'Alice', photoURL: null }, 4);
    await flush();
    expect(setDocSpy).not.toHaveBeenCalled();
  });
});
