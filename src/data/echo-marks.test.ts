import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cell, ClaimDoc, DayDef } from '../types';

// specs/echo-marks.md — the three propagation write paths (mark-time in
// setMark, deal-time in dealDayCard + reshuffleBoard, open-time in
// reconcileEchoes) plus the confirmClaim echo, the marker-preservation unmark,
// and the no-repeated-Prompts byte-identical regression. Mock-Firestore unit
// tests; the pure math is proven in src/game/echo-marks.test.ts and the rules
// gate in tests/rules/echo-marks.test.ts.

const EVENT_ID = 'test-event';

const H = vi.hoisted(() => ({
  event: null as Record<string, unknown> | null,
  itemsById: new Map<string, Record<string, unknown>>(),
  dayBoards: new Map<number, Record<string, unknown> | null>(),
  player: null as Record<string, unknown> | null,
  batchSet: vi.fn(),
  batchDelete: vi.fn(),
  batchCommit: vi.fn(async () => {}),
  txSet: vi.fn(),
  txDelete: vi.fn(),
  txGet: vi.fn(),
  transactionRunner: null as null | ((fn: (tx: unknown) => Promise<unknown>, tx: unknown) => Promise<unknown>),
  // Returns a real promise: pinDayFirstBingo chains `.catch` onto it, and a
  // bare vi.fn() (undefined return) would throw an unhandled rejection.
  setDoc: vi.fn(async (..._args: unknown[]) => {}),
  // Tally marker CACHE state per itemId: absent → the read REJECTS (not
  // cached, the production common case); `false` → a cached TOMBSTONE (this
  // device deleted it); `true` → a cached live marker.
  markerCache: new Map<string, boolean>(),
  // The default getDocFromCache implementation, exposed so a test that
  // overrides it can restore EXACTLY this (a lookalike without the tally
  // branch would silently change marker-cache semantics for later tests).
  defaultGetDocFromCache: undefined as unknown as (ref: { args?: unknown[] }) => Promise<unknown>,
}));

vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  functions: {},
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));

vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));

vi.mock('firebase/firestore', () => {
  class MockFieldPath {
    segments: string[];
    constructor(...segments: string[]) {
      this.segments = segments;
    }
    isEqual(other: MockFieldPath) {
      return this.segments.join('\u0001') === other.segments.join('\u0001');
    }
  }
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref;
    return ref;
  };
  return {
    FieldPath: MockFieldPath,
    doc: (...args: unknown[]) => makeRef('doc', args),
    collection: (...args: unknown[]) => makeRef('collection', args),
    collectionGroup: (...args: unknown[]) => makeRef('collectionGroup', args),
    query: (...args: unknown[]) => ({ query: args }),
    where: (...args: unknown[]) => ({ where: args }),
    getDoc: vi.fn(async (ref: { args?: unknown[] }) => route(ref)),
    getDocFromCache: vi.fn((ref: { args?: unknown[] }) => H.defaultGetDocFromCache(ref)),
    getDocFromServer: vi.fn(async (ref: { args?: unknown[] }) => route(ref)),
    getDocs: vi.fn(),
    getDocsFromCache: vi.fn(),
    writeBatch: () => ({ set: H.batchSet, delete: H.batchDelete, commit: H.batchCommit }),
    addDoc: vi.fn(),
    increment: vi.fn(),
    deleteField: vi.fn(),
    deleteDoc: vi.fn(),
    updateDoc: vi.fn(),
    arrayUnion: vi.fn(),
    arrayRemove: vi.fn(),
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (ref: { args?: unknown[] }) => {
          H.txGet(ref);
          return route(ref);
        },
        set: H.txSet,
        delete: H.txDelete,
      };
      if (H.transactionRunner) return H.transactionRunner(fn, tx);
      return fn(tx);
    },
    setDoc: H.setDoc,
    onSnapshot: vi.fn(),
    serverTimestamp: vi.fn(),
    getFirestore: vi.fn(),
  };
});

const snap = (exists: boolean, id = '', data: unknown = undefined) => ({
  exists: () => exists,
  id,
  data: () => data,
});

H.defaultGetDocFromCache = async (ref: { args?: unknown[] }) => {
  const a = (ref.args ?? []).filter((x): x is string => typeof x === 'string');
  if (a[2] === 'tally') {
    if (!H.markerCache.has(a[3])) throw new Error('marker not in cache');
    return snap(H.markerCache.get(a[3])!, a[5], { uid: a[5] });
  }
  return route(ref);
};

function route(ref: { args?: unknown[] }) {
  const a = (ref.args ?? []).filter((x): x is string => typeof x === 'string');
  if (a.length === 2 && a[0] === 'events') return H.event ? snap(true, EVENT_ID, H.event) : snap(false);
  if (a[2] === 'items') {
    const item = H.itemsById.get(a[3]);
    return item ? snap(true, a[3], item) : snap(false);
  }
  if (a[2] === 'days' && a[4] === 'boards') {
    const board = H.dayBoards.get(Number(a[3]));
    return board ? snap(true, a[5], board) : snap(false);
  }
  if (a[2] === 'players') return H.player ? snap(true, a[3], H.player) : snap(false);
  return snap(false);
}

/** String segments of a captured write ref. */
const segs = (call: unknown[]): string[] =>
  (((call[0] as { args?: unknown[] }).args ?? []) as unknown[]).filter(
    (x): x is string => typeof x === 'string',
  );
const isDayBoardWrite = (call: unknown[], day: number) => {
  const a = segs(call);
  return a[2] === 'days' && a[3] === String(day) && a[4] === 'boards';
};
const isPlayerWrite = (call: unknown[]) => segs(call)[2] === 'players';
const isMarkerWrite = (call: unknown[]) => segs(call)[2] === 'tally';

import {
  __resetPendingMarkerRepairsForTests,
  computeMark,
  dealDayCard,
  reconcileEchoes,
  reshuffleBoard,
  setMark,
} from './api';
import { confirmClaim, rejectClaim } from './admin';
import { resetPendingMoments, peekPendingMoments, pendingBingoDayIndexes } from './moments';
import { cellsFromData } from '../game/cells';
import {
  __resetBoardFreshnessForTests,
  beginDayBoardSeedWatch,
  recordDayBoardSeedSnapshot,
} from './board-freshness';

/**
 * #474: latch mark-time echo trust for a Day board the way the production
 * `useMyDayBoards` fan does — a live watch plus one fully server-committed
 * snapshot confirming the seed. Returns the watch's release fn.
 */
function trustDayBoard(dayIndex: number, uid: string, seed: number | undefined): () => void {
  const release = beginDayBoardSeedWatch(dayIndex, uid);
  recordDayBoardSeedSnapshot(dayIndex, uid, {
    metadata: { fromCache: false, hasPendingWrites: false },
    exists: () => true,
    data: () => (typeof seed === 'number' ? { seed } : {}),
  });
  return release;
}

const PAST = Date.now() - 3_600_000;

/** A 25-cell card with explicit per-index item ids and overrides. */
function card(
  idFor: (i: number) => string,
  overrides: Partial<Record<number, Partial<Cell>>> = {},
): Cell[] {
  return Array.from({ length: 25 }, (_, index) => {
    const base: Cell =
      index === 12
        ? { index, itemId: null, text: 'FREE', free: true, marked: true, markedAt: null }
        : { index, itemId: idFor(index), text: `Prompt ${index}`, free: false, marked: false, markedAt: null };
    return { ...base, ...(overrides[index] ?? {}) };
  });
}

const day = (index: number, over: Partial<DayDef> = {}): DayDef =>
  ({
    index,
    date: '2026-07-16',
    port: 'Split',
    portEmoji: '🇭🇷',
    theme: 'get-sporty',
    tonight: ['A', 'B'],
    pool: 'main',
    tutorial: false,
    unlockAt: PAST,
    snapshotItemIds: [],
    ...over,
  }) as DayDef;

beforeEach(() => {
  vi.clearAllMocks();
  resetPendingMoments();
  H.event = { days: [day(0), day(1), day(2), day(3)], settings: { spicyRatio: 0.4 } };
  H.itemsById.clear();
  H.dayBoards = new Map();
  H.markerCache.clear();
  H.player = null;
  H.transactionRunner = null;
  __resetPendingMarkerRepairsForTests();
  __resetBoardFreshnessForTests();
});

describe('computeMark preserves an Echo opt-out on manual unmark (spec § No unmark cascades)', () => {
  it('records an opt-out for unmarked Echoes and sources, and clears it on a manual re-mark', () => {
    const cells = card((i) => `i${i}`, {
      2: { marked: true, markedAt: 5, status: 'confirmed', echo: true },
    });
    const unmarked = computeMark({
      cells,
      index: 2,
      nextMarked: false,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      now: 10,
    });
    expect('echo' in unmarked.cells.find((c) => c.index === 2)!).toBe(false);
    expect(unmarked.cells.find((c) => c.index === 2)?.echoOptOut).toBe(true);
    const remarked = computeMark({
      cells: unmarked.cells,
      index: 2,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      now: 11,
    });
    const cell = remarked.cells.find((c) => c.index === 2)!;
    expect(cell.marked).toBe(true);
    expect('echo' in cell).toBe(false);
    expect('echoOptOut' in cell).toBe(false);

    const sourceUnmarked = computeMark({
      cells: card((i) => `i${i}`, { 3: { marked: true, markedAt: 5, status: 'confirmed' } }),
      index: 3,
      nextMarked: false,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      now: 12,
    });
    expect(sourceUnmarked.cells.find((c) => c.index === 3)?.echoOptOut).toBe(true);
  });
});

describe('setMark — mark-time propagation (spec § Mark-time)', () => {
  // The acted Day-2 board and a Day-3 sibling SHARING prompt `shared` at
  // different positions; Day 1 shares nothing.
  const actedCells = card((i) => (i === 5 ? 'shared' : `a${i}`));
  const seedBoards = () => {
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2, cells: actedCells });
    H.dayBoards.set(3, { uid: 'u1', seed: 333, dayIndex: 3, cells: card((i) => (i === 8 ? 'shared' : `b${i}`)) });
    H.dayBoards.set(1, { uid: 'u1', seed: 111, dayIndex: 1, cells: card((i) => `c${i}`) });
    // #474: mark-time echo requires each sibling's cached seed to be trusted —
    // simulate the live useMyDayBoards fan that provides it in production.
    trustDayBoard(1, 'u1', 111);
    trustDayBoard(2, 'u1', 222);
    trustDayBoard(3, 'u1', 333);
    H.player = {
      uid: 'u1',
      displayName: 'Alice',
      firstBingoAt: null,
      dayStats: { 2: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } },
    };
  };
  const markShared = (over: Partial<Parameters<typeof setMark>[0]> = {}) =>
    setMark({
      uid: 'u1',
      cells: actedCells,
      index: 5,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      displayName: 'Alice',
      dayIndex: 2,
      daily: true,
      boardSeed: 222,
      echoDayIndexes: [0, 1, 2, 3],
      ...over,
    });

  it('echoes the confirmed Prompt onto the sibling carrier in the SAME batch, with ITS OWN markSeed', async () => {
    seedBoards();
    await markShared();
    const sibWrite = H.batchSet.mock.calls.find((c) => isDayBoardWrite(c, 3));
    expect(sibWrite).toBeDefined();
    const raw = sibWrite![1] as { cells: unknown; markSeed: number };
    const payload = { ...raw, cells: cellsFromData(raw.cells) };
    expect(payload.markSeed).toBe(333); // the SIBLING board's seed, never the acted board's
    const echoed = payload.cells.find((c) => c.index === 8)!;
    expect(echoed).toMatchObject({ marked: true, status: 'confirmed', echo: true, itemId: 'shared' });
    // The non-carrier sibling (Day 1) is untouched.
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 1))).toBe(false);
  });

  it('#474: SKIPS the echo for a sibling with no server-confirmed seed watch — the acted Mark still commits alone', async () => {
    seedBoards();
    // Drop ALL trust: the sibling is cached (seed 333) but nothing live has
    // ever server-confirmed it — the stale-cache poison setup.
    __resetBoardFreshnessForTests();
    await markShared();
    // No echoed sibling write rides the batch...
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 3))).toBe(false);
    // ...but the acted board's own Mark and its player fold still do.
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 2))).toBe(true);
    const playerWrite = H.batchSet.mock.calls.find(isPlayerWrite)![1] as {
      squaresMarked: number;
      dayStats: Record<number, { squaresMarked: number }>;
    };
    expect(playerWrite.squaresMarked).toBe(1); // acted bucket only — no echo fold
    expect(playerWrite.dayStats[3]).toBeUndefined();
    expect(H.batchCommit).toHaveBeenCalledTimes(1);
  });

  it('#474: SKIPS the echo when the server-confirmed seed MISMATCHES the cached one (remote reshuffle)', async () => {
    seedBoards();
    // The live watch has seen the sibling reshuffled to a NEW seed on the
    // server, but this device's cache still holds the OLD card at 333.
    __resetBoardFreshnessForTests();
    trustDayBoard(3, 'u1', 999);
    await markShared();
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 3))).toBe(false);
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 2))).toBe(true);
  });

  it('#474: trust drops fail-closed when the last watch releases', async () => {
    seedBoards();
    __resetBoardFreshnessForTests();
    const release = trustDayBoard(3, 'u1', 333);
    release(); // e.g. sign-out tore the fan down — the seed can go stale unobserved
    await markShared();
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 3))).toBe(false);
  });



  it('#457: the sibling echo write is a PATCH of only the echoed cell — sibling Marks are structurally unclobberable', async () => {
    // The map schema retires the markVersion retry machinery: a concurrent
    // device's Mark on another cell of the sibling board survives because the
    // echo write never carries that cell at all. This is the structural
    // replacement for the retired refresh-and-retry tests.
    seedBoards();
    H.dayBoards.set(3, {
      uid: 'u1',
      seed: 333,
      dayIndex: 3,
      cells: card((i) => (i === 8 ? 'shared' : `b${i}`), {
        9: { marked: true, markedAt: 10, status: 'confirmed' }, // another device's Mark
      }),
    });
    await markShared();
    const sibWrite = H.batchSet.mock.calls.find((c) => isDayBoardWrite(c, 3))!;
    const patch = (sibWrite[1] as { cells: Record<string, Cell> }).cells;
    expect(Object.keys(patch)).toEqual(['8']); // ONLY the echoed cell rides
    expect(patch['8']).toMatchObject({ marked: true, echo: true, itemId: 'shared' });
  });

  it('writes ONE aggregated player doc: acted bucket + echoed bucket + re-derived roots', async () => {
    seedBoards();
    await markShared();
    const playerWrites = H.batchSet.mock.calls.filter(isPlayerWrite);
    expect(playerWrites).toHaveLength(1);
    const write = playerWrites[0][1] as {
      dayStats: Record<number, { bingoCount: number; squaresMarked: number }>;
      bingoCount: number;
      squaresMarked: number;
    };
    expect(write.dayStats[2].squaresMarked).toBe(1); // the acted Mark
    expect(write.dayStats[3].squaresMarked).toBe(1); // the echo
    expect(write.squaresMarked).toBe(2); // the ONE re-summed root
    expect(write.bingoCount).toBe(0);
  });

  it('writes the Tally marker ONCE, for the acted Day — echoes never move the single marker slot', async () => {
    seedBoards();
    await markShared();
    const markerWrites = H.batchSet.mock.calls.filter(isMarkerWrite);
    expect(markerWrites).toHaveLength(1);
    expect((markerWrites[0][1] as { dayIndex: number }).dayIndex).toBe(2);
  });

  it('routes an echo-completed line into the pending-Moment queue under the ECHOED Day', async () => {
    seedBoards();
    // Day 3's row 2 (10..14, crossing the free centre) is one echo short:
    // 10+11+13 manually marked, 14 carries the shared Prompt.
    H.dayBoards.set(3, {
      uid: 'u1',
      seed: 333,
      dayIndex: 3,
      cells: card((i) => (i === 14 ? 'shared' : `b${i}`), {
        10: { marked: true, markedAt: 1 },
        11: { marked: true, markedAt: 1 },
        13: { marked: true, markedAt: 1 },
      }),
    });
    await markShared();
    expect(peekPendingMoments('u1').bingo).toBe(true);
    expect(pendingBingoDayIndexes('u1')).toEqual([3]);
    // The echo-completed first line pins only after the board batch is
    // acknowledged, so a rejected stale-seed batch cannot create the honor.
    await Promise.resolve();
    const pin = H.setDoc.mock.calls.find((call) => {
      const a = segs(call as unknown[]);
      return a[2] === 'days' && a[3] === '3' && a[4] === 'meta';
    });
    expect(pin).toBeDefined();
    expect((pin![1] as { firstBingo: { uid: string; displayName: string } }).firstBingo).toMatchObject({
      uid: 'u1',
      displayName: 'Alice',
    });
  });

  it('does not pin an Echo honor when the board batch is rejected', async () => {
    seedBoards();
    H.dayBoards.set(3, {
      uid: 'u1',
      seed: 333,
      dayIndex: 3,
      cells: card((i) => (i === 14 ? 'shared' : `b${i}`), {
        10: { marked: true, markedAt: 1 },
        11: { marked: true, markedAt: 1 },
        13: { marked: true, markedAt: 1 },
      }),
    });
    H.batchCommit.mockRejectedValueOnce(new Error('stale markSeed'));
    await markShared();
    await Promise.resolve();
    expect(H.setDoc).not.toHaveBeenCalled();
  });

  it('does not pin an Echo honor under the Anonymous fallback', async () => {
    seedBoards();
    H.player = { ...(H.player as Record<string, unknown>), displayName: 'Anonymous' };
    H.dayBoards.set(3, {
      uid: 'u1',
      seed: 333,
      dayIndex: 3,
      cells: card((i) => (i === 14 ? 'shared' : `b${i}`), {
        10: { marked: true, markedAt: 1 },
        11: { marked: true, markedAt: 1 },
        13: { marked: true, markedAt: 1 },
      }),
    });
    await markShared({ displayName: undefined });
    await Promise.resolve();
    expect(H.setDoc).not.toHaveBeenCalled();
  });

  it('does NOT echo a pending (admin_confirmed) Mark', async () => {
    seedBoards();
    await markShared({ claimMode: 'admin_confirmed' });
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 3))).toBe(false);
  });

  it('REGRESSION: with no repeated Prompts the batch is byte-identical to an echo-less call', async () => {
    // Pin the clock: the two runs stamp `markedAt: Date.now()`, and crossing a
    // millisecond boundary between them would fail the byte-identity check for
    // the wrong reason (observed CI-only).
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      seedBoards();
      H.dayBoards.set(3, { uid: 'u1', seed: 333, dayIndex: 3, cells: card((i) => `b${i}`) }); // no overlap
      await markShared();
      const withEchoParam = H.batchSet.mock.calls.map((c) => [segs(c), c[1], c[2]]);
      vi.clearAllMocks();
      await markShared({ echoDayIndexes: undefined });
      const withoutEchoParam = H.batchSet.mock.calls.map((c) => [segs(c), c[1], c[2]]);
      expect(withEchoParam).toEqual(withoutEchoParam);
      expect(withEchoParam.some(([a]) => (a as string[])[2] === 'days' && (a as string[])[3] === '3')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unmark keeps the shared marker while a sibling still holds the Prompt confirmed, deletes when last', async () => {
    seedBoards();
    // The sibling holds `shared` CONFIRMED (an echo) — unmarking the acted copy
    // must NOT strip the marker from under it.
    H.dayBoards.set(3, {
      uid: 'u1',
      seed: 333,
      dayIndex: 3,
      cells: card((i) => (i === 8 ? 'shared' : `b${i}`), {
        8: { marked: true, markedAt: 2, status: 'confirmed', echo: true },
      }),
    });
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 5 ? 'shared' : `a${i}`), { 5: { marked: true, markedAt: 1 } }),
    });
    await markShared({ nextMarked: false });
    expect(H.batchDelete).not.toHaveBeenCalled();

    vi.clearAllMocks();
    // Pending marks publish the same marker before admin confirmation, so they
    // keep it alive just like a confirmed sibling.
    H.dayBoards.set(3, {
      uid: 'u1',
      seed: 333,
      dayIndex: 3,
      cells: card((i) => (i === 8 ? 'shared' : `b${i}`), {
        8: { marked: true, markedAt: 2, status: 'pending' },
      }),
    });
    await markShared({ nextMarked: false });
    expect(H.batchDelete).not.toHaveBeenCalled();

    vi.clearAllMocks();
    // Sibling no longer carries it marked — the last carrier's unmark deletes.
    H.dayBoards.set(3, { uid: 'u1', seed: 333, dayIndex: 3, cells: card((i) => (i === 8 ? 'shared' : `b${i}`)) });
    await markShared({ nextMarked: false });
    expect(H.batchDelete).toHaveBeenCalledTimes(1);
  });

  it('preserves root blackout when an unmark leaves a sibling Echo blacked out', async () => {
    seedBoards();
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 5 ? 'shared' : `a${i}`), { 5: { marked: true, markedAt: 1 } }),
    });
    H.dayBoards.set(3, {
      uid: 'u1',
      seed: 333,
      dayIndex: 3,
      cells: card((i) => (i === 8 ? 'shared' : `b${i}`)).map((cell) =>
        cell.free
          ? cell
          : { ...cell, marked: true, markedAt: 2, status: 'confirmed', ...(cell.index === 8 ? { echo: true } : {}) },
      ),
    });
    H.player = { ...(H.player as Record<string, unknown>), blackout: true };

    await markShared({ nextMarked: false });
    const playerWrite = H.batchSet.mock.calls.find(isPlayerWrite)![1] as { blackout: boolean };
    expect(playerWrite.blackout).toBe(true);
  });
});

describe('dealDayCard — deal-time echo (spec § Deal-time)', () => {
  // A 24-Prompt snapshot shared verbatim with the Day-1 card: the no-repeat
  // exclusion would leave 0 < MIN_POOL drawable, so it RESETS and the Day-0
  // deal redraws the same Prompts — the repeat case deal-time echo exists for.
  const SNAP = Array.from({ length: 24 }, (_, i) => `s${i}`);
  const seedDeal = (day1Overrides: Partial<Record<number, Partial<Cell>>> = {}) => {
    for (const id of SNAP) H.itemsById.set(id, { text: `P ${id}`, spicy: false, isFreeSpace: false });
    H.event = {
      days: [day(0, { snapshotItemIds: SNAP }), day(1, { snapshotItemIds: SNAP })],
      settings: { spicyRatio: 0.4 },
    };
    let cursor = 0;
    const ids: (string | null)[] = Array.from({ length: 25 }, (_, i) => (i === 12 ? null : SNAP[cursor++]));
    H.dayBoards.set(1, {
      uid: 'u1',
      seed: 111,
      dayIndex: 1,
      cells: card((i) => ids[i] as string, day1Overrides),
    });
    H.player = { uid: 'u1', dayStats: { 1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } } };
  };
  const u = { uid: 'u1', displayName: 'Alice', photoURL: null } as never;

  it('the new card arrives pre-echoed for an achieved Prompt, with the bucket + roots in the player write', async () => {
    seedDeal({ 0: { marked: true, markedAt: 1, status: 'confirmed' } }); // s0 achieved on Day 1
    await expect(dealDayCard(u, 0)).resolves.toBe(true);
    const boardWrite = H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 0));
    const cells = cellsFromData((boardWrite![1] as { cells: unknown }).cells);
    const echoed = cells.find((c) => c.itemId === 's0')!;
    expect(echoed).toMatchObject({ marked: true, status: 'confirmed', echo: true });
    const playerWrite = H.txSet.mock.calls.find(isPlayerWrite)![1] as {
      dayStats: Record<number, { squaresMarked: number }>;
      squaresMarked: number;
    };
    expect(playerWrite.dayStats[0].squaresMarked).toBe(1);
    expect(playerWrite.squaresMarked).toBe(2); // Day 1 prior bucket + this echo
  });

  it('revalidates achieved prompts inside the deal transaction before it writes Echoes', async () => {
    seedDeal({ 0: { marked: true, markedAt: 1, status: 'confirmed' } });
    H.transactionRunner = async (fn, tx) => {
      const source = H.dayBoards.get(1)!;
      H.dayBoards.set(1, {
        ...source,
        cells: (source.cells as Cell[]).map((cell) =>
          cell.itemId === 's0' ? { ...cell, marked: false, markedAt: null } : cell,
        ),
      });
      return fn(tx);
    };

    await expect(dealDayCard(u, 0)).resolves.toBe(true);
    const cells = cellsFromData((H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 0))![1] as { cells: unknown }).cells);
    expect(cells.find((cell) => cell.itemId === 's0')?.echo).toBeUndefined();
  });

  it('REGRESSION: with nothing achieved the player write is the zeroed seed bucket, exactly as today', async () => {
    seedDeal(); // Day 1 card exists but nothing marked
    await expect(dealDayCard(u, 0)).resolves.toBe(true);
    const playerWrite = H.txSet.mock.calls.find(isPlayerWrite)![1];
    expect(playerWrite).toEqual({ dayStats: { 0: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } } });
    const cells = cellsFromData((H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 0))![1] as { cells: unknown }).cells);
    expect(cells.some((c) => c.echo)).toBe(false);
  });

  it('a POST-FREEZE ceremonial deal records its echoed bucket ONLY — no root fields (Codex P2 #447 round 2)', async () => {
    seedDeal({ 0: { marked: true, markedAt: 1, status: 'confirmed' } });
    // Freeze the standings and make the dealt Day ceremonial (farewell pool).
    H.event = {
      ...(H.event as Record<string, unknown>),
      frozenAt: PAST,
      days: [
        day(0, { snapshotItemIds: SNAP, pool: 'farewell', tutorial: true }),
        day(1, { snapshotItemIds: SNAP }),
      ],
    };
    await expect(dealDayCard(u, 0)).resolves.toBe(true);
    const playerWrite = H.txSet.mock.calls.find(isPlayerWrite)![1] as Record<string, unknown>;
    expect(Object.keys(playerWrite)).toEqual(['dayStats']); // bucket only — no roots move post-freeze
    expect((playerWrite.dayStats as Record<number, { squaresMarked: number }>)[0].squaresMarked).toBe(1);
  });
});

describe('reshuffleBoard — the post-Reshuffle re-deal echo (spec § Reshuffle pristine-ness)', () => {
  const SNAP = Array.from({ length: 24 }, (_, i) => `s${i}`);
  const seedShuffle = (params: {
    day1Cells?: Partial<Record<number, Partial<Cell>>>;
    day0Overrides?: Partial<Record<number, Partial<Cell>>>;
    playerExtra?: Record<string, unknown>;
  }) => {
    for (const id of SNAP) H.itemsById.set(id, { text: `P ${id}`, spicy: false, isFreeSpace: false });
    H.event = {
      days: [day(0, { snapshotItemIds: SNAP }), day(1, { snapshotItemIds: SNAP })],
      settings: { spicyRatio: 0.4 },
    };
    let cursor = 0;
    const ids: (string | null)[] = Array.from({ length: 25 }, (_, i) => (i === 12 ? null : SNAP[cursor++]));
    H.dayBoards.set(1, { uid: 'u1', seed: 111, dayIndex: 1, cells: card((i) => ids[i] as string, params.day1Cells) });
    if (params.day0Overrides !== undefined) {
      H.dayBoards.set(0, { uid: 'u1', seed: 100, dayIndex: 0, cells: card((i) => ids[i] as string, params.day0Overrides) });
    }
    H.player = { uid: 'u1', reshufflesUsed: 0, ...params.playerExtra };
  };

  it('an echo-only card is still reshuffleable, and the replacement re-echoes with its bucket re-derived', async () => {
    seedShuffle({
      // The Day-1 card wears an ECHO of s0 (achieved on Day 0) — pristine.
      day1Cells: { 0: { marked: true, markedAt: 1, status: 'confirmed', echo: true } },
      day0Overrides: { 0: { marked: true, markedAt: 1, status: 'confirmed' } },
      playerExtra: { dayStats: { 1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } } },
    });
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
    const rawBoardWrite = H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 1))![1] as { cells: unknown };
    const boardWrite = { ...rawBoardWrite, cells: cellsFromData(rawBoardWrite.cells) };
    // The peer Day-0 card still holds s0 confirmed, so the replacement (same
    // 24-Prompt pool after the exclusion reset) arrives echoing it again.
    const echoed = boardWrite.cells.find((c) => c.itemId === 's0')!;
    expect(echoed).toMatchObject({ marked: true, status: 'confirmed', echo: true });
    const playerWrite = H.txSet.mock.calls.find(isPlayerWrite)![1] as Record<string, unknown>;
    expect(playerWrite.reshufflesUsed).toBe(1);
    // The Day-1 bucket is RE-DERIVED from the replacement's echoes — the
    // discarded card's echo stats never survive as phantoms.
    expect((playerWrite.dayStats as Record<number, { squaresMarked: number }>)[1].squaresMarked).toBe(1);
  });

  it('REGRESSION: a no-echo reshuffle keeps the exact two-write shape — the counter write is bare', async () => {
    seedShuffle({ playerExtra: { dayStats: { 1: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } } } });
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
    expect(H.txSet).toHaveBeenCalledTimes(2);
    expect(H.txSet.mock.calls.find(isPlayerWrite)![1]).toEqual({ reshufflesUsed: 1 });
    expect(H.txDelete).not.toHaveBeenCalled();
  });

  it('deletes the orphaned Tally marker when the LAST carrier of a Prompt is traded away (Codex P2 #447)', async () => {
    // Day 1 wears an echo of s0 whose SOURCE was since unmarked: NO peer board
    // exists, so nothing still confirms s0 — the reshuffle must take the
    // stranded marker with the discarded card.
    seedShuffle({
      day1Cells: { 0: { marked: true, markedAt: 1, status: 'confirmed', echo: true } },
      playerExtra: { dayStats: { 1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } } },
    });
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
    const deleted = H.txDelete.mock.calls.map((c) => segs(c as unknown[]));
    expect(deleted).toContainEqual(['events', EVENT_ID, 'tally', 's0', 'markers', 'u1']);
  });

  it('keeps the marker when a peer board still confirms the Prompt (it re-echoes instead)', async () => {
    seedShuffle({
      day1Cells: { 0: { marked: true, markedAt: 1, status: 'confirmed', echo: true } },
      day0Overrides: { 0: { marked: true, markedAt: 1, status: 'confirmed' } },
      playerExtra: { dayStats: { 1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } } },
    });
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
    expect(H.txDelete).not.toHaveBeenCalled();
  });

  it('does not publish a stale re-deal echo when the transaction reports no committed spend (Phase 4b P1 #447)', async () => {
    const confirmed: Partial<Record<number, Partial<Cell>>> = {};
    for (let index = 0; index < 25; index++) {
      confirmed[index] = { marked: true, markedAt: 1, status: 'confirmed' };
    }
    seedShuffle({
      day0Overrides: confirmed,
      playerExtra: { displayName: 'Alice' },
    });
    H.transactionRunner = async (fn, tx) => {
      await fn(tx); // A discarded attempt derived a full-card echo transition.
      return 0; // The transaction ultimately did not commit a reshuffle.
    };

    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(0);
    await Promise.resolve();
    expect(peekPendingMoments('u1')).toMatchObject({ bingo: false, blackout: false, firstBingo: false });
    expect(H.setDoc).not.toHaveBeenCalled();
  });
});

describe('reconcileEchoes — open-time backfill (spec § Open-time)', () => {
  const seedReconcile = () => {
    H.dayBoards.set(1, {
      uid: 'u1',
      seed: 111,
      dayIndex: 1,
      cells: card((i) => (i === 4 ? 'shared' : `c${i}`), { 4: { marked: true, markedAt: 1 } }),
    });
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2, cells: card((i) => (i === 9 ? 'shared' : `d${i}`)) });
    H.player = { uid: 'u1', dayStats: { 1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } } };
  };

  it('writes the missing echo onto the opened board (its own markSeed) plus the aggregated player write', async () => {
    seedReconcile();
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2] });
    expect(res.changed).toBe(true);
    const boardWrite = H.batchSet.mock.calls.find((c) => isDayBoardWrite(c, 2))![1] as {
      cells: Record<string, Cell>;
      markSeed: number;
    };
    expect(boardWrite.markSeed).toBe(222);
    // #457 per-cell merge: the reconcile patch carries ONLY the missing echo.
    expect(Object.keys(boardWrite.cells)).toEqual(['9']);
    expect(boardWrite.cells['9']).toMatchObject({ marked: true, echo: true });
    const playerWrite = H.batchSet.mock.calls.find(isPlayerWrite)![1] as { squaresMarked: number };
    expect(playerWrite.squaresMarked).toBe(2);
    expect(H.batchCommit).toHaveBeenCalledTimes(1);
  });


  it('is a zero-write no-op on an already-reconciled board', async () => {
    seedReconcile();
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
        9: { marked: true, markedAt: 1, status: 'confirmed', echo: true },
      }),
    });
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2] });
    expect(res.changed).toBe(false);
    expect(res.complete).toBe(true);
    expect(H.batchSet).not.toHaveBeenCalled();
    expect(H.batchCommit).not.toHaveBeenCalled();
  });

  it('reports complete: false when a sibling board is not in the cache (Codex P2 #447)', async () => {
    seedReconcile();
    const { getDocFromCache } = await import('firebase/firestore');
    const mocked = vi.mocked(getDocFromCache);
    try {
      mocked.mockImplementation(async (ref) => {
        const a = ((ref as { args?: unknown[] }).args ?? []).filter((x): x is string => typeof x === 'string');
        if (a[2] === 'days' && a[3] === '1') throw new Error('cache miss'); // the sibling with the source Mark
        return route(ref as { args?: unknown[] }) as never;
      });
      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2] });
      // With Day 1 unknowable, `shared` is not in the derivable achieved set —
      // nothing echoes, and the pass reports itself incomplete so the caller
      // retries on a later open instead of settling the once-per-board guard.
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(false);
    } finally {
      mocked.mockImplementation(((ref: { args?: unknown[] }) => H.defaultGetDocFromCache(ref)) as never);
    }
  });

  it('preserves a blackout standing on an untouched board through the reconcile fold (Codex P2 #447)', async () => {
    seedReconcile();
    H.player = { ...(H.player as Record<string, unknown>), blackout: true };
    await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2] });
    const playerWrite = H.batchSet.mock.calls.find(isPlayerWrite)![1] as { blackout: boolean };
    expect(playerWrite.blackout).toBe(true);
  });

  it('does not repair a cache tombstone without a locally incomplete-unmark record', async () => {
    seedReconcile();
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
        9: { marked: true, markedAt: 7, status: 'confirmed', echo: true },
      }),
    });
    H.markerCache.set('shared', false); // cached tombstone
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2] });
    expect(res.changed).toBe(false);
    expect(H.batchSet.mock.calls.some((c) => isMarkerWrite(c))).toBe(false);
    expect(H.batchCommit).not.toHaveBeenCalled();
  });

  it('repairs only the tombstone created by this device after an incomplete sibling unmark', async () => {
    seedReconcile();
    const { getDocFromCache } = await import('firebase/firestore');
    const mocked = vi.mocked(getDocFromCache);
    try {
      mocked.mockImplementation(async (ref) => {
        const a = ((ref as { args?: unknown[] }).args ?? []).filter((x): x is string => typeof x === 'string');
        if (a[2] === 'days' && a[3] === '2') throw new Error('sibling cache miss');
        return H.defaultGetDocFromCache(ref as { args?: unknown[] }) as never;
      });
      await setMark({
        uid: 'u1',
        cells: (H.dayBoards.get(1)?.cells ?? []) as Cell[],
        index: 4,
        nextMarked: false,
        claimMode: 'honor',
        currentFirstBingoAt: null,
        displayName: 'Alice',
        dayIndex: 1,
        daily: true,
        boardSeed: 111,
        echoDayIndexes: [1, 2],
      });
    } finally {
      mocked.mockImplementation(((ref: { args?: unknown[] }) => H.defaultGetDocFromCache(ref)) as never);
    }
    expect(H.batchDelete).toHaveBeenCalledTimes(1);

    H.dayBoards.set(1, { uid: 'u1', seed: 111, dayIndex: 1, cells: card((i) => (i === 4 ? 'shared' : `c${i}`)) });
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
        9: { marked: true, markedAt: 7, status: 'confirmed', echo: true },
      }),
    });
    H.markerCache.set('shared', false);
    vi.clearAllMocks();
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [1, 2] });
    expect(res.changed).toBe(false);
    const markerWrite = H.batchSet.mock.calls.find(isMarkerWrite);
    expect(markerWrite).toBeDefined();
    expect(markerWrite![1]).toMatchObject({ uid: 'u1', markedAt: 7, dayIndex: 2 });
    expect(H.batchCommit).toHaveBeenCalledTimes(1);
  });

  it('reuses a persisted marker-repair witness after a reload', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    try {
      H.dayBoards.set(2, {
        uid: 'u1',
        seed: 222,
        dayIndex: 2,
        cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
          9: { marked: true, markedAt: 7, status: 'confirmed', echo: true },
        }),
      });
      H.markerCache.set('shared', false);
      values.set('gcb:echo-marker-repair:test-event:u1:shared', '1');

      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [1, 2] });
      expect(res.changed).toBe(false);
      expect(H.batchSet.mock.calls.find(isMarkerWrite)).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a normal re-mark supersedes the repair candidate, so a later ADMIN delete stays deleted (#454 finding 1)', async () => {
    seedReconcile();
    // 1. Unmark with an unknowable sibling — a repair candidate is persisted.
    const { getDocFromCache } = await import('firebase/firestore');
    const mocked = vi.mocked(getDocFromCache);
    try {
      mocked.mockImplementation(async (ref) => {
        const a = ((ref as { args?: unknown[] }).args ?? []).filter((x): x is string => typeof x === 'string');
        if (a[2] === 'days' && a[3] === '2') throw new Error('sibling cache miss');
        return H.defaultGetDocFromCache(ref as { args?: unknown[] }) as never;
      });
      await setMark({
        uid: 'u1',
        cells: (H.dayBoards.get(1)?.cells ?? []) as Cell[],
        index: 4,
        nextMarked: false,
        claimMode: 'honor',
        currentFirstBingoAt: null,
        displayName: 'Alice',
        dayIndex: 1,
        daily: true,
        boardSeed: 111,
        echoDayIndexes: [1, 2],
      });
    } finally {
      mocked.mockImplementation(((ref: { args?: unknown[] }) => H.defaultGetDocFromCache(ref)) as never);
    }
    // 2. A NORMAL re-mark of the same Prompt recreates the marker itself —
    //    the fix makes it supersede (forget) the stale candidate.
    await setMark({
      uid: 'u1',
      cells: (H.dayBoards.get(1)?.cells ?? []) as Cell[],
      index: 4,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      displayName: 'Alice',
      dayIndex: 1,
      daily: true,
      boardSeed: 111,
      echoDayIndexes: [1, 2],
    });
    // 3. An admin then deletes the marker (this device caches the tombstone).
    //    The stale candidate must NOT let the reconcile resurrect it.
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
        9: { marked: true, markedAt: 7, status: 'confirmed', echo: true },
      }),
    });
    H.markerCache.set('shared', false); // the admin delete's tombstone
    vi.clearAllMocks();
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [1, 2] });
    expect(res.changed).toBe(false);
    expect(H.batchSet.mock.calls.some((c) => isMarkerWrite(c))).toBe(false);
    expect(H.batchCommit).not.toHaveBeenCalled();
  });

  it('re-pins a reload-lost Day honor for a standing echo win with a server-accepted stamp (Phase 4b #447 round 5)', async () => {
    // The echoed board already drained (standing bingo, nothing left to write);
    // dayStats carries the accepted stamp, but the ack-gated pin continuation
    // died in a reload. The reconcile re-attempts the CREATE-ONCE pin with the
    // stamp's own time.
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => `d${i}`, {
        10: { marked: true, markedAt: 7, status: 'confirmed' },
        11: { marked: true, markedAt: 7, status: 'confirmed' },
        13: { marked: true, markedAt: 7, status: 'confirmed', echo: true },
        14: { marked: true, markedAt: 7, status: 'confirmed', echo: true },
      }),
    });
    H.player = {
      uid: 'u1',
      displayName: 'Alice',
      dayStats: { 2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 7 } },
    };
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [2] });
    expect(res.changed).toBe(false);
    await new Promise((r) => setTimeout(r, 0)); // the fire-and-forget pin's own awaits
    const pin = H.setDoc.mock.calls.find((call) => {
      const a = segs(call as unknown[]);
      return a[2] === 'days' && a[3] === '2' && a[4] === 'meta';
    });
    expect(pin).toBeDefined();
    expect((pin![1] as { firstBingo: { at: number } }).firstBingo.at).toBe(7);
    // And WITHOUT a server-accepted stamp, no repair-pin fires.
    vi.clearAllMocks();
    H.player = { uid: 'u1', displayName: 'Alice', dayStats: {} };
    await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [2] });
    await new Promise((r) => setTimeout(r, 0));
    expect(
      H.setDoc.mock.calls.some((call) => {
        const a = segs(call as unknown[]);
        return a[2] === 'days' && a[4] === 'meta';
      }),
    ).toBe(false);
  });

  it("repairs a marked PENDING carrier's marker too (#454 finding 2)", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    try {
      // The opened board holds `shared` as a marked PENDING Claim — its marker
      // legitimately existed from pending time and was deleted by an
      // unknowable-sibling unmark (the persisted candidate below).
      H.dayBoards.set(2, {
        uid: 'u1',
        seed: 222,
        dayIndex: 2,
        cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
          9: { marked: true, markedAt: 7, status: 'pending' },
        }),
      });
      H.player = { uid: 'u1', displayName: 'Alice', dayStats: {} };
      H.markerCache.set('shared', false);
      values.set('gcb:echo-marker-repair:test-event:u1:shared', '1');

      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [1, 2] });
      expect(res.changed).toBe(false); // a pending cell echoes nothing — the repair rides alone
      const markerWrite = H.batchSet.mock.calls.find(isMarkerWrite);
      expect(markerWrite).toBeDefined();
      expect(markerWrite![1]).toMatchObject({ uid: 'u1', markedAt: 7, dayIndex: 2 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('confirmClaim — the admin_confirmed echo moment (spec § Contract)', () => {
  const claim = (over: Partial<ClaimDoc> = {}): ClaimDoc => ({
    id: 'claim-1',
    uid: 'u1',
    displayName: 'Alice',
    cellIndex: 5,
    itemText: 'P shared',
    proofId: null,
    status: 'pending',
    createdAt: PAST,
    dayIndex: 1,
    ...over,
  });
  const seedClaim = () => {
    H.dayBoards.set(1, {
      uid: 'u1',
      seed: 111,
      dayIndex: 1,
      cells: card((i) => (i === 5 ? 'shared' : `a${i}`), {
        5: { marked: true, markedAt: 1, status: 'pending' },
      }),
    });
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2, cells: card((i) => (i === 7 ? 'shared' : `b${i}`)) });
    H.player = { uid: 'u1', displayName: 'Alice', dayStats: {} };
  };

  it('confirming echoes the Prompt onto sibling carriers, born confirmed, in the ONE transaction', async () => {
    seedClaim();
    await confirmClaim(claim(), 'admin-1');
    const sibWrite = H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 2));
    expect(sibWrite).toBeDefined();
    const raw = sibWrite![1] as { cells: unknown; markSeed: number };
    const payload = { ...raw, cells: cellsFromData(raw.cells) };
    expect(payload.markSeed).toBe(222);
    expect(payload.cells.find((c) => c.index === 7)).toMatchObject({
      marked: true,
      status: 'confirmed',
      echo: true,
    });
    const playerWrites = H.txSet.mock.calls.filter(isPlayerWrite);
    expect(playerWrites).toHaveLength(1); // ONE aggregated write
    const write = playerWrites[0][1] as {
      dayStats: Record<number, { squaresMarked: number }>;
      squaresMarked: number;
    };
    expect(write.dayStats[1].squaresMarked).toBe(1);
    expect(write.dayStats[2].squaresMarked).toBe(1);
    expect(write.squaresMarked).toBe(2);
  });

  it('rejecting echoes NOTHING', async () => {
    seedClaim();
    await rejectClaim(claim(), 'admin-1');
    expect(H.txSet.mock.calls.some((c) => isDayBoardWrite(c, 2))).toBe(false);
  });

  it('rejecting a repeated Prompt keeps its marker while a confirmed Echo remains', async () => {
    seedClaim();
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 7 ? 'shared' : `b${i}`), {
        7: { marked: true, markedAt: 1, status: 'confirmed', echo: true },
      }),
    });
    await rejectClaim(claim(), 'admin-1');
    expect(H.txDelete).not.toHaveBeenCalled();
  });

  it('rejecting a repeated Prompt keeps its marker while a sibling Claim is pending', async () => {
    seedClaim();
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 7 ? 'shared' : `b${i}`), {
        7: { marked: true, markedAt: 1, status: 'pending' },
      }),
    });
    await rejectClaim(claim(), 'admin-1');
    expect(H.txDelete).not.toHaveBeenCalled();
  });

  it('rejecting a source keeps root blackout while a sibling Echo remains blackout', async () => {
    seedClaim();
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 7 ? 'shared' : `b${i}`)).map((cell) =>
        cell.free
          ? cell
          : { ...cell, marked: true, markedAt: 2, status: 'confirmed', ...(cell.index === 7 ? { echo: true } : {}) },
      ),
    });
    H.player = { ...(H.player as Record<string, unknown>), blackout: true };

    await rejectClaim(claim(), 'admin-1');
    const playerWrite = H.txSet.mock.calls.find(isPlayerWrite)![1] as { blackout: boolean };
    expect(playerWrite.blackout).toBe(true);
  });

  it("pins the echo Day's write-once honor when the echo completes its first line (Codex P2 #447)", async () => {
    seedClaim();
    // Day 2's row 2 (10..14, crossing the free centre) is one echo short:
    // the shared Prompt sits at 14, the rest already confirmed.
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 14 ? 'shared' : `b${i}`), {
        10: { marked: true, markedAt: 1, status: 'confirmed' },
        11: { marked: true, markedAt: 1, status: 'confirmed' },
        13: { marked: true, markedAt: 1, status: 'confirmed' },
      }),
    });
    await confirmClaim(claim(), 'admin-1');
    const metaWrite = H.txSet.mock.calls.find((call) => {
      const a = segs(call as unknown[]);
      return a[2] === 'days' && a[3] === '2' && a[4] === 'meta';
    });
    expect(metaWrite).toBeDefined();
    expect((metaWrite![1] as { firstBingo: { uid: string } }).firstBingo.uid).toBe('u1');
  });
});
