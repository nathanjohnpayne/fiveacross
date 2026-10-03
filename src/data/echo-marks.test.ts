import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cell, ClaimDoc, DayDef } from '../types';
import { MAX_DAYS } from './eventLimits';

// specs/echo-marks.md — the three propagation write paths (mark-time in
// setMark, deal-time in dealDayCard + reshuffleBoard, open-time in
// reconcileEchoes) plus the confirmClaim echo, the marker-preservation unmark,
// and the no-repeated-Prompts byte-identical regression. Mock-Firestore unit
// tests; the pure math is proven in src/game/echo-marks.test.ts and the rules
// gate in tests/rules/echo-marks.test.ts.

const EVENT_ID = 'test-event';

const H = vi.hoisted(() => ({
  eventId: 'test-event',
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
  // #1360: the SERVER's Tally marker docs per itemId (read by the post-ack re-point
  // transaction). Absent means the marker does not exist on the server.
  markerServer: new Map<string, Record<string, unknown>>(),
  // #1367: `waitForPendingWrites` — resolves immediately unless a test holds it.
  waitForPendingWrites: vi.fn(async (..._args: unknown[]) => {}),
  // The default getDocFromCache implementation, exposed so a test that
  // overrides it can restore EXACTLY this (a lookalike without the tally
  // branch would silently change marker-cache semantics for later tests).
  defaultGetDocFromCache: undefined as unknown as (ref: { args?: unknown[] }) => Promise<unknown>,
  // #721: api.ts / admin.ts fire echo_mark / mark_square via a DYNAMIC
  // `import('../analytics')` (mirroring the existing #387 mark_rejected call
  // site) so this Firestore-only module graph stays free of the eager
  // analytics/firebase-singleton dependency — mock the module so the dynamic
  // import resolves to this spy instead of loading the real one.
  track: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: {},
  get EVENT_ID() {
    return H.eventId;
  },
  functions: {},
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));

vi.mock('../analytics', () => ({ track: H.track }));

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
    writeBatch: vi.fn(() => ({ set: H.batchSet, delete: H.batchDelete, commit: H.batchCommit })),
    waitForPendingWrites: (...args: unknown[]) => H.waitForPendingWrites(...args),
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
  if (a[2] === 'claims') return snap(true, a[3], { status: 'pending' });
  if (a[2] === 'players') return H.player ? snap(true, a[3], H.player) : snap(false);
  if (a[2] === 'tally' && a[4] === 'markers') {
    const m = H.markerServer.get(a[3]);
    return m ? snap(true, a[5], m) : snap(false);
  }
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
  retryPendingMarkerRepoints,
  computeMark,
  dealDayCard,
  joinAndDeal,
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
  const release = beginDayBoardSeedWatch('test-event', dayIndex, uid);
  recordDayBoardSeedSnapshot('test-event', dayIndex, uid, {
    metadata: { fromCache: false, hasPendingWrites: false },
    exists: () => true,
    data: () => (typeof seed === 'number' ? { seed } : {}),
  });
  return release;
}

const PAST = Date.now() - 3_600_000;

/** Echo rows are now emitted only after the Functions trigger sees a commit. */
const expectNoClientEchoTrack = () =>
  expect(H.track).not.toHaveBeenCalledWith('echo_mark', expect.anything());

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
    place: 'Split',
    placeEmoji: '🇭🇷',
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
  H.eventId = EVENT_ID;
  resetPendingMoments();
  H.event = { days: [day(0), day(1), day(2), day(3)], settings: { spicyRatio: 0.4 } };
  H.itemsById.clear();
  H.dayBoards = new Map();
  H.markerCache.clear();
  H.markerServer.clear();
  H.player = null;
  H.transactionRunner = null;
  __resetPendingMarkerRepairsForTests();
  __resetBoardFreshnessForTests();
});

describe('Event-scoped mark operation lifecycles (#807)', () => {
  it('keeps a delayed Event A join transaction entirely under Event A', async () => {
    const { getDoc } = await import('firebase/firestore');
    let releaseEventRead!: () => void;
    const eventReadGate = new Promise<void>((resolve) => {
      releaseEventRead = resolve;
    });
    vi.mocked(getDoc).mockImplementationOnce(async (ref) => {
      await eventReadGate;
      return route(ref as { args?: unknown[] }) as never;
    });

    H.eventId = 'event-a';
    const joining = joinAndDeal({
      uid: 'scope-user',
      displayName: 'Scope User',
      photoURL: null,
    } as never);
    await vi.waitFor(() => expect(getDoc).toHaveBeenCalledTimes(1));

    H.eventId = 'event-b';
    releaseEventRead();
    await joining;

    const writtenPaths = H.txSet.mock.calls.map((call) => segs(call));
    expect(writtenPaths).toContainEqual(['events', 'event-a', 'players', 'scope-user']);
    expect(writtenPaths.flat()).not.toContain('event-b');
  });

  it('keeps every queued Event A mark ref pinned to A after the live scope changes to B', async () => {
    const { getDocFromCache } = await import('firebase/firestore');
    const mocked = vi.mocked(getDocFromCache);
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let reads = 0;
    mocked.mockImplementation(async (ref) => {
      reads += 1;
      if (reads === 1) await firstReadGate;
      return H.defaultGetDocFromCache(ref as { args?: unknown[] }) as never;
    });

    const cells = card((i) => `scope-${i}`);
    H.eventId = 'event-a';
    const common = {
      uid: 'scope-user',
      cells,
      nextMarked: true,
      claimMode: 'honor' as const,
      currentFirstBingoAt: null,
      displayName: 'Scope User',
      dayIndex: 0,
      daily: true,
      boardSeed: 1,
    };
    const first = setMark({ ...common, index: 1 });
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(1));
    // This call is queued while A is still selected. Its execution begins only
    // after the scope has changed, so only an entry-time capture can keep it on A.
    const queued = setMark({ ...common, index: 2 });
    H.eventId = 'event-b';
    releaseFirstRead();
    await Promise.all([first, queued]);

    const scopedWrites = H.batchSet.mock.calls.filter((call) => segs(call).includes('scope-user'));
    expect(scopedWrites.length).toBeGreaterThan(0);
    expect(scopedWrites.every((call) => segs(call)[1] === 'event-a')).toBe(true);
    expect(
      mocked.mock.calls
        .filter((call) => ((call[0] as { args?: unknown[] }).args ?? []).includes('scope-user'))
        .every((call) => {
          const strings = ((call[0] as { args?: unknown[] }).args ?? []).filter(
            (value): value is string => typeof value === 'string',
          );
          return strings[1] === 'event-a';
        }),
    ).toBe(true);
  });
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

  it('fails closed above the Event Day maximum before reading cache or constructing a batch', async () => {
    const { getDocFromCache, writeBatch } = await import('firebase/firestore');

    await expect(
      markShared({
        echoDayIndexes: Array.from({ length: MAX_DAYS + 1 }, (_unused, index) => index),
      }),
    ).rejects.toThrow(
      `setMark cannot process ${MAX_DAYS + 1} Day indexes; the Event maximum is ${MAX_DAYS}.`,
    );

    expect(getDocFromCache).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('emits the full supported MAX_DAYS Mark batch: one Board per Day, one Player, and the acted marker', async () => {
    const dayIndexes = Array.from({ length: MAX_DAYS }, (_unused, index) => index);
    const sourceCells = card((index) => (index === 5 ? 'shared' : `day-0-${index}`));
    for (const dayIndex of dayIndexes) {
      const seed = 1_000 + dayIndex;
      H.dayBoards.set(dayIndex, {
        uid: 'u1',
        seed,
        dayIndex,
        cells:
          dayIndex === 0
            ? sourceCells
            : card((index) => (index === 5 ? 'shared' : `day-${dayIndex}-${index}`)),
      });
      trustDayBoard(dayIndex, 'u1', seed);
    }
    H.player = {
      uid: 'u1',
      displayName: 'Alice',
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      dayStats: { 0: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } },
    };
    const { writeBatch } = await import('firebase/firestore');

    const result = await setMark({
      uid: 'u1',
      cells: sourceCells,
      index: 5,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      displayName: 'Alice',
      dayIndex: 0,
      daily: true,
      boardSeed: 1_000,
      echoDayIndexes: dayIndexes,
    });
    await result.committed;

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(H.batchCommit).toHaveBeenCalledTimes(1);
    expect(H.batchDelete).not.toHaveBeenCalled();

    const boardWrites = H.batchSet.mock.calls.filter((call) => {
      const path = segs(call);
      return path[2] === 'days' && path[4] === 'boards';
    });
    expect(boardWrites).toHaveLength(MAX_DAYS);
    expect(boardWrites.map((call) => Number(segs(call)[3])).sort((a, b) => a - b)).toEqual(dayIndexes);
    for (const call of boardWrites) {
      const dayIndex = Number(segs(call)[3]);
      expect(call[1]).toMatchObject({ markSeed: 1_000 + dayIndex });
    }

    expect(H.batchSet.mock.calls.filter(isPlayerWrite)).toHaveLength(1);
    const markerWrites = H.batchSet.mock.calls.filter(isMarkerWrite);
    expect(markerWrites).toHaveLength(1);
    expect(segs(markerWrites[0])).toEqual(['events', EVENT_ID, 'tally', 'shared', 'markers', 'u1']);
    expect(markerWrites[0][1]).toMatchObject({ uid: 'u1', itemText: 'Prompt 5', dayIndex: 0 });
    expect(H.batchSet).toHaveBeenCalledTimes(MAX_DAYS + 2);
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
    expect(echoed).toMatchObject({ echoAnalyticsTrigger: 'mark', echoAnalyticsId: expect.any(String) });
    expectNoClientEchoTrack();
  });

  it('#1360: with Echo switched off the Mark stays on its own card — no sibling write', async () => {
    seedBoards();
    await markShared({ echoMarks: false });
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 2))).toBe(true);
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 3))).toBe(false);
    expectNoClientEchoTrack();
  });

  it('a Mark that echoes onto TWO siblings stamps one durable identity per receiving Day', async () => {
    // Day 2 (acted) carries the shared Prompt; Days 1 AND 3 both carry it too
    // — a Mark on Day 2 must echo onto BOTH, and #721's reconciliation
    // identity requires one echo_mark per RECEIVING Day, not one aggregated
    // event under the acted Day.
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2, cells: actedCells });
    H.dayBoards.set(1, { uid: 'u1', seed: 111, dayIndex: 1, cells: card((i) => (i === 4 ? 'shared' : `c${i}`)) });
    H.dayBoards.set(3, { uid: 'u1', seed: 333, dayIndex: 3, cells: card((i) => (i === 8 ? 'shared' : `b${i}`)) });
    trustDayBoard(1, 'u1', 111);
    trustDayBoard(2, 'u1', 222);
    trustDayBoard(3, 'u1', 333);
    H.player = {
      uid: 'u1',
      displayName: 'Alice',
      firstBingoAt: null,
      dayStats: { 2: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } },
    };
    await markShared();
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 1))).toBe(true);
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 3))).toBe(true);
    for (const day of [1, 3]) {
      const write = H.batchSet.mock.calls.find((c) => isDayBoardWrite(c, day));
      const cells = cellsFromData((write![1] as { cells: unknown }).cells);
      expect(cells.find((cell) => cell.echo)?.echoAnalyticsTrigger).toBe('mark');
      expect(cells.find((cell) => cell.echo)?.echoAnalyticsId).toEqual(expect.any(String));
    }
    expectNoClientEchoTrack();
  });

  it('keeps a committed mark-time identity when only the sibling stats continuation strands', async () => {
    // The listener only delivers after the server trigger writes its immutable
    // row. This fixture therefore proves the durable Board identity survives a
    // reload while the independent stats continuation is still absent.
    seedBoards();
    await markShared();
    const initialWrite = H.batchSet.mock.calls.find((c) => isDayBoardWrite(c, 3));
    const initialCells = cellsFromData((initialWrite![1] as { cells: unknown }).cells);
    const transitionId = initialCells.find((cell) => cell.echo)?.echoAnalyticsId;
    expect(transitionId).toEqual(expect.any(String));
    H.track.mockClear();
    // Also clear the mark-time cascade's OWN `reconcileEchoStatsFromServer`
    // continuation's txSet call (fired off the SAME commit, independently of
    // the echo_mark send above) — it read Day 3's board BEFORE the
    // "next open" update below and would otherwise leave an unrelated
    // squaresMarked:0 call in the mock history ahead of the heal's own
    // write, which is what THIS test's stats assertion below must observe.
    H.txSet.mockClear();

    // "Next open" of Day 3: the echoed cell already drained durably (an
    // offline batch persists regardless of the tab), so the board this
    // device now reads already carries it — matching what the mark-time
    // batch actually wrote.
    H.dayBoards.set(3, {
      uid: 'u1',
      seed: 333,
      dayIndex: 3,
      cells: card((i) => (i === 8 ? 'shared' : `b${i}`), {
        8: {
          marked: true,
          markedAt: 5,
          status: 'confirmed',
          echo: true,
          echoGeneration: 1,
          echoAnalyticsId: transitionId,
          echoAnalyticsTrigger: 'mark',
        },
      }),
    });
    // `H.player.dayStats` still has NO Day-3 bucket (seedBoards only seeded
    // Day 2) — the stranded stats continuation. This is exactly the
    // `bucketLag` heal's trigger condition.
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 3, dayIndexes: [2, 3] });
    expect(res.changed).toBe(false); // nothing NEW to echo — Day 3's own cells already carry it
    // The heal DOES repair the stranded stats write (proving the heal ran,
    // not that it was skipped for some unrelated reason)...
    await vi.waitFor(() => {
      const statsWrite = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
      expect(statsWrite).toBeDefined();
      expect(
        (statsWrite![1] as { dayStats: Record<number, { squaresMarked: number }> }).dayStats[3].squaresMarked,
      ).toBe(1);
    });
    expectNoClientEchoTrack();
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

  it('#491: the batch player write is the ACTED bucket only; the echoed bucket + roots re-derive from SERVER state after the ack', async () => {
    seedBoards();
    // The ack-gated stats reconcile is a TRANSACTION (Codex P1 on #495): its
    // reads see the server's post-commit truth. Model that by swapping H to
    // the post-batch server state at transaction time — the Day-3 sibling with
    // the echo landed, the player row as the batch left it (acted bucket only).
    H.transactionRunner = async (fn, tx) => {
      H.dayBoards.set(3, {
        uid: 'u1',
        seed: 333,
        dayIndex: 3,
        cells: card((i) => (i === 8 ? 'shared' : `b${i}`), {
          8: { marked: true, markedAt: 9, status: 'confirmed', echo: true },
        }),
      });
      H.player = {
        uid: 'u1',
        displayName: 'Alice',
        dayStats: { 2: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } },
      };
      return fn(tx);
    };
    await markShared();
    // The BATCH's player write: the acted Day-2 bucket only — no cache-built
    // sibling bucket can ride a drain and roll back another device's stats.
    const playerWrites = H.batchSet.mock.calls.filter(isPlayerWrite);
    expect(playerWrites).toHaveLength(1);
    const write = playerWrites[0][1] as {
      dayStats: Record<number, { bingoCount: number; squaresMarked: number }>;
      squaresMarked: number;
    };
    expect(write.dayStats[2].squaresMarked).toBe(1); // the acted Mark
    expect(write.dayStats[3]).toBeUndefined(); // NEVER in the batch (#491)
    expect(write.squaresMarked).toBe(1); // acted-day sum only
    // The ack-gated transactional stats write carries the echoed bucket and
    // the re-summed roots.
    await vi.waitFor(() => {
      const statsWrite = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
      expect(statsWrite).toBeDefined();
      const stats = statsWrite![1] as {
        dayStats: Record<number, { squaresMarked: number }>;
        squaresMarked: number;
        bingoCount: number;
      };
      expect(stats.dayStats[3].squaresMarked).toBe(1); // the echo, from server cells
      expect(stats.squaresMarked).toBe(2); // roots re-summed over the server view
      expect(stats.bingoCount).toBe(0);
      expect((statsWrite as unknown[])[2]).toEqual({ merge: true });
    });
  });

  it('#491 REGRESSION: a stale-cache drain never regresses another device’s sibling dayStats or the root totals', async () => {
    // Device A marked TWO squares on sibling Day 3 and the server knows it;
    // device B's persistent cache for Day 3 is STALE (echo-trusted seed, no
    // A-marks) — the #482 trust-latch window. B marks the shared Prompt.
    seedBoards();
    H.transactionRunner = async (fn, tx) => {
      // Server truth at reconcile time (post-drain): A's two Marks (cells 9,
      // 10) AND B's echo (8); A's Day-3 bucket standing on the row (B's batch
      // never touched it) alongside B's acted Day-2 bucket.
      H.dayBoards.set(3, {
        uid: 'u1',
        seed: 333,
        dayIndex: 3,
        cells: card((i) => (i === 8 ? 'shared' : `b${i}`), {
          8: { marked: true, markedAt: 9, status: 'confirmed', echo: true },
          9: { marked: true, markedAt: 5, status: 'confirmed' },
          10: { marked: true, markedAt: 6, status: 'confirmed' },
        }),
      });
      H.player = {
        uid: 'u1',
        displayName: 'Alice',
        dayStats: {
          2: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
          3: { bingoCount: 0, squaresMarked: 2, firstBingoAt: null },
        },
      };
      return fn(tx);
    };
    await markShared();
    // The drain's batch never writes dayStats[3] — A's bucket survives it.
    for (const call of H.batchSet.mock.calls.filter(isPlayerWrite)) {
      expect((call[1] as { dayStats: Record<number, unknown> }).dayStats[3]).toBeUndefined();
    }
    // The server-derived stats write reflects A's Marks PLUS the echo — never
    // the stale cache view (which would have been squaresMarked: 1).
    await vi.waitFor(() => {
      const statsWrite = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
      expect(statsWrite).toBeDefined();
      const stats = statsWrite![1] as {
        dayStats: Record<number, { squaresMarked: number }>;
        squaresMarked: number;
      };
      expect(stats.dayStats[3].squaresMarked).toBe(3); // A's 2 + the echo
      expect(stats.squaresMarked).toBe(4); // roots: Day-2 (1) + Day-3 (3)
    });
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
    // No meta pin write — the (#491) server-derived stats write may still run,
    // so filter to the days/{d}/meta path rather than asserting zero setDoc.
    expect(H.setDoc.mock.calls.some((call) => segs(call as unknown[])[4] === 'meta')).toBe(false);
  });

  it('does NOT echo a pending (admin_confirmed) Mark', async () => {
    seedBoards();
    await markShared({ claimMode: 'admin_confirmed' });
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 3))).toBe(false);
  });

  it('REGRESSION: with no repeated Prompts the batch has the same shape as an echo-less call', async () => {
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
      // A direct toggle always mints a fresh request token for the
      // server-observed analytics trigger. Normalize that intentionally unique
      // value before comparing the no-echo and omitted-param write shapes.
      const normalizeRequestId = (writes: unknown[][]) =>
        writes.map(([path, data, options]) => [
          path,
          typeof data === 'object' && data !== null
            ? {
                ...(data as Record<string, unknown>),
                ...((data as { directAnalyticsRequest?: unknown }).directAnalyticsRequest
                  ? {
                      directAnalyticsRequest: {
                        ...((data as { directAnalyticsRequest: Record<string, unknown> }).directAnalyticsRequest),
                        id: '<request>',
                      },
                    }
                  : {}),
              }
            : data,
          options,
        ]);
      expect(normalizeRequestId(withEchoParam)).toEqual(normalizeRequestId(withoutEchoParam));
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

  const settle = () => new Promise((r) => setTimeout(r, 0));
  const seedRepeats = () => {
    seedBoards();
    // `shared` re-marked by hand on Day 1 (t=20) and Day 3 (t=30); the acted
    // Day 2 copy (t=25) is the one being unmarked.
    H.dayBoards.set(1, {
      uid: 'u1', seed: 111, dayIndex: 1,
      cells: card((i) => (i === 4 ? 'shared' : `c${i}`), { 4: { marked: true, markedAt: 20, status: 'confirmed' } }),
    });
    H.dayBoards.set(3, {
      uid: 'u1', seed: 333, dayIndex: 3,
      cells: card((i) => (i === 8 ? 'shared' : `b${i}`), { 8: { marked: true, markedAt: 30, status: 'confirmed' } }),
    });
    H.dayBoards.set(2, {
      uid: 'u1', seed: 222, dayIndex: 2,
      cells: card((i) => (i === 5 ? 'shared' : `a${i}`), { 5: { marked: true, markedAt: 25 } }),
    });
  };
  // The mocked batch does not apply writes to the fake server, so a test of the
  // post-ack pass applies the committed unmark of the acted Day 2 copy itself.
  const commitDay2Unmark = () => {
    const b = H.dayBoards.get(2)!;
    H.dayBoards.set(2, { ...b, cells: (b.cells as Cell[]).map((c) => (c.index === 5 ? { ...c, marked: false, markedAt: null } : c)) });
  };
  const markerTxWrite = () =>
    H.txSet.mock.calls.find((c) => segs(c)[2] === 'tally' && segs(c)[4] === 'markers');
  const serverMarker = () => ({ uid: 'u1', eventId: EVENT_ID, displayName: 'Alice', dayIndex: 2, markedAt: 25, itemText: 'P' });

  it('#1360: with Echo off an unmark RE-POINTS the marker to the latest remaining week, after the ack', async () => {
    seedRepeats();
    H.markerServer.set('shared', serverMarker());
    await markShared({ nextMarked: false, echoMarks: false });
    // Never inside the offline batch: a queued set could recreate a moderated marker.
    expect(H.batchSet.mock.calls.some((c) => isMarkerWrite(c))).toBe(false);
    expect(H.batchDelete).not.toHaveBeenCalled();
    commitDay2Unmark();
    await settle();
    expect(markerTxWrite()?.[1]).toMatchObject({ uid: 'u1', displayName: 'Alice', dayIndex: 3, markedAt: 30 });
  });

  it('#1360: the re-point never RECREATES a marker the server no longer has (moderation)', async () => {
    seedRepeats();
    // An Admin deleted the marker on the server; this device still caches it.
    H.markerCache.set('shared', true);
    await markShared({ nextMarked: false, echoMarks: false });
    commitDay2Unmark();
    await settle();
    expect(markerTxWrite()).toBeUndefined();
    expect(H.batchSet.mock.calls.some((c) => isMarkerWrite(c))).toBe(false);
  });

  it('#1360: the re-point reads siblings from the SERVER, so an uncached later Mark still wins', async () => {
    seedRepeats();
    // Day 1's real Mark is the latest (t=40), but this device's cache cannot read Day 1.
    H.dayBoards.set(1, {
      uid: 'u1', seed: 111, dayIndex: 1,
      cells: card((i) => (i === 4 ? 'shared' : `c${i}`), { 4: { marked: true, markedAt: 40, status: 'confirmed' } }),
    });
    const { getDocFromCache } = await import('firebase/firestore');
    const cacheRead = vi.mocked(getDocFromCache);
    cacheRead.mockImplementation((async (ref: { args?: unknown[] }) => {
      const a = (ref.args ?? []).filter((x): x is string => typeof x === 'string');
      if (a[2] === 'days' && a[3] === '1') throw new Error('not cached');
      return H.defaultGetDocFromCache(ref);
    }) as never);
    H.markerServer.set('shared', serverMarker());
    try {
      await markShared({ nextMarked: false, echoMarks: false });
      commitDay2Unmark();
      await settle();
      expect(markerTxWrite()?.[1]).toMatchObject({ dayIndex: 1, markedAt: 40 });
    } finally {
      cacheRead.mockImplementation(((ref: { args?: unknown[] }) => H.defaultGetDocFromCache(ref)) as never);
    }
  });

  const withUncachedDay = async <T,>(day: number, run: () => Promise<T>): Promise<T> => {
    const { getDocFromCache } = await import('firebase/firestore');
    const cacheRead = vi.mocked(getDocFromCache);
    cacheRead.mockImplementation((async (ref: { args?: unknown[] }) => {
      const a = (ref.args ?? []).filter((x): x is string => typeof x === 'string');
      if (a[2] === 'days' && a[3] === String(day)) throw new Error('not cached');
      return H.defaultGetDocFromCache(ref);
    }) as never);
    try {
      return await run();
    } finally {
      cacheRead.mockImplementation(((ref: { args?: unknown[] }) => H.defaultGetDocFromCache(ref)) as never);
    }
  };
  const onlyCarrierOnDay1 = (markedOnServer: boolean) => {
    seedBoards();
    H.dayBoards.set(3, { uid: 'u1', seed: 333, dayIndex: 3, cells: card((i) => `b${i}`) });
    H.dayBoards.set(1, {
      uid: 'u1', seed: 111, dayIndex: 1,
      cells: card((i) => (i === 4 ? 'shared' : `c${i}`), markedOnServer ? { 4: { marked: true, markedAt: 40, status: 'confirmed' } } : {}),
    });
    H.dayBoards.set(2, {
      uid: 'u1', seed: 222, dayIndex: 2,
      cells: card((i) => (i === 5 ? 'shared' : `a${i}`), { 5: { marked: true, markedAt: 25 } }),
    });
    H.markerServer.set('shared', serverMarker());
  };

  it('#1360: an uncached ONLY carrier keeps the marker — the server pass re-points it, no in-batch delete', async () => {
    onlyCarrierOnDay1(true);
    await withUncachedDay(1, async () => {
      await markShared({ nextMarked: false, echoMarks: false });
      expect(H.batchDelete).not.toHaveBeenCalled();
      commitDay2Unmark();
      await settle();
    });
    expect(markerTxWrite()?.[1]).toMatchObject({ dayIndex: 1, markedAt: 40 });
    expect(H.txDelete).not.toHaveBeenCalled();
  });

  it('#1360: with no carrier on the server either, the deferred server pass deletes the marker', async () => {
    onlyCarrierOnDay1(false);
    await withUncachedDay(1, async () => {
      await markShared({ nextMarked: false, echoMarks: false });
      expect(H.batchDelete).not.toHaveBeenCalled();
      commitDay2Unmark();
      await settle();
    });
    expect(markerTxWrite()).toBeUndefined();
    expect(H.txDelete.mock.calls.some((c) => segs(c)[2] === 'tally')).toBe(true);
  });

  it('#1414: re-pointing replaces legacy extra fields with the bounded canonical marker', async () => {
    seedRepeats();
    H.markerServer.set('shared', { ...serverMarker(), legacyExtra: 'x'.repeat(2000), displayName: 'N'.repeat(200) });
    await markShared({ nextMarked: false, echoMarks: false });
    commitDay2Unmark();
    await settle();
    const write = markerTxWrite()!;
    expect(write[1]).toEqual({ uid: 'u1', eventId: 'test-event', displayName: 'N'.repeat(100), dayIndex: 3, cellIndex: 8, markedAt: 30, itemText: 'Prompt 8' });
    expect(write[2]).toBeUndefined(); // complete replacement removes unknown fields
  });

  it('#1360: the server pass ignores a board whose stored owner does not match its path', async () => {
    seedRepeats();
    // Day 3 carries the latest Mark but its stored uid is someone else's.
    H.dayBoards.set(3, {
      uid: 'intruder', seed: 333, dayIndex: 3,
      cells: card((i) => (i === 8 ? 'shared' : `b${i}`), { 8: { marked: true, markedAt: 30, status: 'confirmed' } }),
    });
    H.markerServer.set('shared', serverMarker());
    await markShared({ nextMarked: false, echoMarks: false });
    commitDay2Unmark();
    await settle();
    expect(markerTxWrite()?.[1]).toMatchObject({ dayIndex: 1, markedAt: 20 });
  });

  it('#1360: a same-Day re-mark that lands before the server pass wins (the acted Day is scanned too)', async () => {
    onlyCarrierOnDay1(false);
    await withUncachedDay(1, async () => {
      await markShared({ nextMarked: false, echoMarks: false });
      // Before the post-ack pass reads, the Player re-marks the same Day 2 square.
      H.dayBoards.set(2, {
        uid: 'u1', seed: 222, dayIndex: 2,
        cells: card((i) => (i === 5 ? 'shared' : `a${i}`), { 5: { marked: true, markedAt: 50, status: 'confirmed' } }),
      });
      await settle();
    });
    expect(H.txDelete.mock.calls.some((c) => segs(c)[2] === 'tally')).toBe(false);
    expect(markerTxWrite()?.[1]).toMatchObject({ dayIndex: 2, markedAt: 50 });
  });

  it('#1360: an Echo-off no-carrier unmark never deletes in-batch; another device\'s later Mark survives', async () => {
    // Every sibling is cached and none carries the Prompt...
    seedBoards();
    H.dayBoards.set(3, { uid: 'u1', seed: 333, dayIndex: 3, cells: card((i) => (i === 8 ? 'shared' : `b${i}`)) });
    H.dayBoards.set(2, {
      uid: 'u1', seed: 222, dayIndex: 2,
      cells: card((i) => (i === 5 ? 'shared' : `a${i}`), { 5: { marked: true, markedAt: 25 } }),
    });
    H.markerServer.set('shared', serverMarker());
    await markShared({ nextMarked: false, echoMarks: false });
    expect(H.batchDelete).not.toHaveBeenCalled();
    // ...but another device marks it on Day 3 before the server pass reads.
    H.dayBoards.set(3, {
      uid: 'u1', seed: 333, dayIndex: 3,
      cells: card((i) => (i === 8 ? 'shared' : `b${i}`), { 8: { marked: true, markedAt: 60, status: 'confirmed' } }),
    });
    commitDay2Unmark();
    await settle();
    expect(H.txDelete.mock.calls.some((c) => segs(c)[2] === 'tally')).toBe(false);
    expect(markerTxWrite()?.[1]).toMatchObject({ dayIndex: 3, markedAt: 60 });
  });

  it('#1360: an Echo-off unmark of the last carrier deletes the marker in the server pass', async () => {
    seedBoards();
    H.dayBoards.set(3, { uid: 'u1', seed: 333, dayIndex: 3, cells: card((i) => (i === 8 ? 'shared' : `b${i}`)) });
    H.dayBoards.set(2, {
      uid: 'u1', seed: 222, dayIndex: 2,
      cells: card((i) => (i === 5 ? 'shared' : `a${i}`), { 5: { marked: true, markedAt: 25 } }),
    });
    H.markerServer.set('shared', serverMarker());
    await markShared({ nextMarked: false, echoMarks: false });
    expect(H.batchDelete).not.toHaveBeenCalled();
    commitDay2Unmark();
    await settle();
    expect(H.txDelete.mock.calls.some((c) => segs(c)[2] === 'tally')).toBe(true);
  });

  it('#1360: a LEGACY single-board Event with Echo off keeps the atomic in-batch marker delete', async () => {
    seedBoards();
    await markShared({ nextMarked: false, echoMarks: false, daily: false, echoDayIndexes: undefined });
    await settle();
    expect(H.batchDelete.mock.calls.some((c) => segs(c)[2] === 'tally')).toBe(true);
    expect(markerTxWrite()).toBeUndefined();
  });

  it('#1360: a cached carrier unmarked elsewhere before the server pass still lets it delete the orphan marker', async () => {
    seedRepeats();
    H.markerServer.set('shared', serverMarker());
    // Hold this unmark's server ack until the other device has acted.
    let ack: (() => void) | undefined;
    H.batchCommit.mockImplementationOnce(() => new Promise<void>((r) => { ack = r; }));
    await markShared({ nextMarked: false, echoMarks: false });
    // Day 1 and Day 3 were cached carriers, but another device unmarks both first.
    H.dayBoards.set(1, { uid: 'u1', seed: 111, dayIndex: 1, cells: card((i) => (i === 4 ? 'shared' : `c${i}`)) });
    H.dayBoards.set(3, { uid: 'u1', seed: 333, dayIndex: 3, cells: card((i) => (i === 8 ? 'shared' : `b${i}`)) });
    commitDay2Unmark();
    ack!();
    await settle();
    expect(H.txDelete.mock.calls.some((c) => segs(c)[2] === 'tally')).toBe(true);
  });

  // #1367: the post-ack marker pass is an in-memory continuation, so it is backed
  // by a DURABLE record that survives a reload and is retried on the next open.
  // One storage key per record: `...:{itemId}:{token}`.
  const REPOINT_PREFIX = 'gcb:echo-marker-repoint:test-event:u1:shared:';
  const repointKeys = (values: Map<string, string>) => [...values.keys()].filter((k) => k.startsWith(REPOINT_PREFIX));
  const stubStorage = () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size;
      },
      key: (i: number) => [...values.keys()][i] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    return values;
  };

  it('#1367: the pending marker pass is recorded durably before commit and cleared after it succeeds', async () => {
    const values = stubStorage();
    try {
      seedRepeats();
      H.markerServer.set('shared', serverMarker());
      let recordedAtCommit = 0;
      H.batchCommit.mockImplementationOnce(async () => {
        recordedAtCommit = repointKeys(values).length;
      });
      await markShared({ nextMarked: false, echoMarks: false });
      expect(recordedAtCommit).toBe(1);
      commitDay2Unmark();
      await settle();
      expect(markerTxWrite()?.[1]).toMatchObject({ dayIndex: 3 });
      expect(repointKeys(values)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('#1367: a pass lost to a reload is retried on the next open, after queued writes drain', async () => {
    const values = stubStorage();
    try {
      seedRepeats();
      H.markerServer.set('shared', serverMarker());
      // The in-memory continuation never runs (the tab reloads before the ack).
      H.batchCommit.mockImplementationOnce(() => new Promise<void>(() => {}));
      await markShared({ nextMarked: false, echoMarks: false });
      const [persisted] = repointKeys(values);
      expect(persisted).toBeTruthy();

      // "Reload": in-memory state is gone, the durable record survives.
      __resetPendingMarkerRepairsForTests();
      values.set(persisted, '1');
      // The replayed unmark drains; both siblings have been unmarked elsewhere too.
      commitDay2Unmark();
      H.dayBoards.set(1, { uid: 'u1', seed: 111, dayIndex: 1, cells: card((i) => (i === 4 ? 'shared' : `c${i}`)) });
      H.dayBoards.set(3, { uid: 'u1', seed: 333, dayIndex: 3, cells: card((i) => (i === 8 ? 'shared' : `b${i}`)) });
      let drain: (() => void) | undefined;
      H.waitForPendingWrites.mockImplementationOnce(() => new Promise<void>((r) => { drain = r; }));

      // The retry blocks on the held drain, so it is not awaited here.
      void retryPendingMarkerRepoints({ uid: 'u1', dayIndexes: [0, 1, 2, 3] });
      await settle();
      // Nothing runs until this device's queued writes have drained.
      expect(H.txDelete.mock.calls.some((c) => segs(c)[2] === 'tally')).toBe(false);
      expect(repointKeys(values)).toEqual([persisted]);

      drain!();
      await settle();
      expect(H.txDelete.mock.calls.some((c) => segs(c)[2] === 'tally')).toBe(true);
      expect(repointKeys(values)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('#1367: an OLDER pass finishing never clears a NEWER unmark\'s record', async () => {
    const values = stubStorage();
    try {
      seedRepeats();
      H.markerServer.set('shared', serverMarker());
      let ackFirst: (() => void) | undefined;
      let ackSecond: (() => void) | undefined;
      H.batchCommit
        .mockImplementationOnce(() => new Promise<void>((r) => { ackFirst = r; }))
        .mockImplementationOnce(() => new Promise<void>((r) => { ackSecond = r; }));
      await markShared({ nextMarked: false, echoMarks: false });
      const [firstKey] = repointKeys(values);
      await markShared({ nextMarked: false, echoMarks: false });
      const secondKey = repointKeys(values).find((k) => k !== firstKey);
      expect(secondKey).toBeTruthy();

      commitDay2Unmark();
      ackFirst!();
      await settle();
      await settle();
      // The first pass ran and succeeded, but the second unmark's record survives.
      expect(markerTxWrite()).toBeDefined();
      expect(repointKeys(values)).toEqual([secondKey]);

      ackSecond!();
      await settle();
      await settle();
      expect(repointKeys(values)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('#1367: a pass clears only its OWN record, never one another tab wrote for the same Prompt', async () => {
    const values = stubStorage();
    try {
      seedRepeats();
      H.markerServer.set('shared', serverMarker());
      let ack: (() => void) | undefined;
      H.batchCommit.mockImplementationOnce(() => new Promise<void>((r) => { ack = r; }));
      await markShared({ nextMarked: false, echoMarks: false });
      // Another tab records its own pending pass for the same Prompt meanwhile.
      const otherTab = `${REPOINT_PREFIX}othertab.1.abc`;
      values.set(otherTab, '1');
      commitDay2Unmark();
      ack!();
      await settle();
      await settle();
      expect(markerTxWrite()).toBeDefined();
      expect(repointKeys(values)).toEqual([otherTab]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('#1367: a failed pass keeps the durable record for the next open', async () => {
    const values = stubStorage();
    try {
      seedRepeats();
      H.markerServer.set('shared', serverMarker());
      H.transactionRunner = async () => {
        throw new Error('unavailable');
      };
      await markShared({ nextMarked: false, echoMarks: false });
      commitDay2Unmark();
      await settle();
      expect(repointKeys(values)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('#1367: a REJECTED unmark keeps its record; the retry re-points from server truth', async () => {
    const values = stubStorage();
    try {
      seedRepeats();
      H.markerServer.set('shared', serverMarker());
      H.batchCommit.mockImplementationOnce(async () => {
        throw new Error('permission-denied');
      });
      await markShared({ nextMarked: false, echoMarks: false });
      await settle();
      expect(markerTxWrite()).toBeUndefined();
      expect(repointKeys(values)).toHaveLength(1);
      // Next open: the rolled-back Day 2 Mark is still the server's state, so the
      // pass keeps a marker (latest carrier wins) rather than deleting it.
      await retryPendingMarkerRepoints({ uid: 'u1', dayIndexes: [0, 1, 2, 3] });
      await settle();
      expect(markerTxWrite()?.[1]).toMatchObject({ dayIndex: 3 });
      expect(H.txDelete.mock.calls.some((c) => segs(c)[2] === 'tally')).toBe(false);
      expect(repointKeys(values)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('#1367: the open-time retry snapshots its records BEFORE waiting, so a newer unmark is never cleared by it', async () => {
    const values = stubStorage();
    try {
      seedRepeats();
      H.markerServer.set('shared', serverMarker());
      values.set('gcb:echo-marker-repoint:test-event:u1:other:old.1.x', '1');
      let drain: (() => void) | undefined;
      H.waitForPendingWrites.mockImplementationOnce(() => new Promise<void>((r) => { drain = r; }));
      // The retry blocks on the held drain, so it is not awaited here.
      void retryPendingMarkerRepoints({ uid: 'u1', dayIndexes: [0, 1, 2, 3] });
      await settle();
      // A new unmark records `shared` while the retry is still waiting.
      H.batchCommit.mockImplementationOnce(() => new Promise<void>(() => {}));
      await markShared({ nextMarked: false, echoMarks: false });
      const fresh = repointKeys(values);
      expect(fresh).toHaveLength(1);
      drain!();
      await settle();
      await settle();
      expect(repointKeys(values)).toEqual(fresh);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('#1370: reconcileEchoes no longer triggers the marker retry (Board owns it, once per visit)', async () => {
    const values = stubStorage();
    try {
      seedRepeats();
      H.markerServer.set('shared', serverMarker());
      values.set(`${REPOINT_PREFIX}old.1.x`, '1');
      await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2, 3], echoMarks: false });
      await settle();
      expect(H.waitForPendingWrites).not.toHaveBeenCalled();
      expect(repointKeys(values)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('#1360: with Echo ON an unmark keeps the marker exactly as before (no re-point write)', async () => {
    seedBoards();
    H.dayBoards.set(3, {
      uid: 'u1', seed: 333, dayIndex: 3,
      cells: card((i) => (i === 8 ? 'shared' : `b${i}`), { 8: { marked: true, markedAt: 30, status: 'confirmed', echo: true } }),
    });
    H.dayBoards.set(2, {
      uid: 'u1', seed: 222, dayIndex: 2,
      cells: card((i) => (i === 5 ? 'shared' : `a${i}`), { 5: { marked: true, markedAt: 25 } }),
    });
    H.markerServer.set('shared', serverMarker());
    await markShared({ nextMarked: false });
    await settle();
    expect(H.batchDelete).not.toHaveBeenCalled();
    expect(H.batchSet.mock.calls.some((c) => isMarkerWrite(c))).toBe(false);
    expect(markerTxWrite()).toBeUndefined();
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
    // `joinedAt` is the join marker `dealDayCard` fails closed on (#1158, and
    // round 4 moved that guard off the stored `uid` onto this field). This
    // Player has a marked Day-1 card, so their join plainly landed; the stamp
    // just has to be on the fixture for the deal to get past the guard.
    H.player = {
      uid: 'u1',
      joinedAt: 1,
      dayStats: { 1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } },
    };
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
    expect(echoed).toMatchObject({ echoAnalyticsTrigger: 'deal', echoAnalyticsId: expect.any(String) });
    expectNoClientEchoTrack();
  });

  it('#1360: with settings.echoMarks false the repeated Prompt arrives UNMARKED', async () => {
    seedDeal({ 0: { marked: true, markedAt: 1, status: 'confirmed' } }); // s0 achieved on Day 1
    H.event = { ...H.event, settings: { spicyRatio: 0.4, echoMarks: false } };
    await expect(dealDayCard(u, 0)).resolves.toBe(true);
    const boardWrite = H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 0));
    const cells = cellsFromData((boardWrite![1] as { cells: unknown }).cells);
    expect(cells.find((c) => c.itemId === 's0')).toMatchObject({ marked: false });
    expect(cells.some((c) => c.echo)).toBe(false);
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
        day(0, { snapshotItemIds: SNAP, pool: 'closing', tutorial: true }),
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

  it('an echo-only card is still reshuffleable, and the replacement re-echoes with its bucket re-derived — but fires NO echo_mark (net-new is zero, Codex round 1 finding 4, #727)', async () => {
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
    // discarded card's echo stats never survive as phantoms. Before AND
    // after the reshuffle the bucket reads 1 — the discarded card already
    // wore this exact echo (a pristine card can ONLY carry echoes), so the
    // replacement re-landing the SAME Prompt is not a NEW echo.
    expect((playerWrite.dayStats as Record<number, { squaresMarked: number }>)[1].squaresMarked).toBe(1);
    // #721, Codex round 1 finding 4: `echo_mark`'s `count` must be the NET-NEW
    // increase over what this Day's bucket already carried, never the
    // replacement's raw echo total — firing `count: 1` here (as the
    // pre-fix code did) would report an echo the bucket never moved for,
    // breaking the reconciliation identity (specs/w2-ga4-events.md §
    // Reconciliation: `squaresMarked[d] = markCount[d] + echoCount[d]`).
    await new Promise((r) => setTimeout(r, 0)); // let every microtask continuation settle
    expect(H.track).not.toHaveBeenCalledWith('echo_mark', expect.objectContaining({ trigger: 'reshuffle' }));
  });

  it('#1360: with settings.echoMarks false the replacement card re-echoes nothing', async () => {
    seedShuffle({
      day1Cells: { 0: { marked: true, markedAt: 1, status: 'confirmed', echo: true } },
      day0Overrides: { 0: { marked: true, markedAt: 1, status: 'confirmed' } },
      playerExtra: { dayStats: { 1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } } },
    });
    H.event = { ...H.event, settings: { spicyRatio: 0.4, echoMarks: false } };
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
    const raw = H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 1))![1] as { cells: unknown };
    const cells = cellsFromData(raw.cells);
    expect(cells.some((c) => c.echo)).toBe(false);
    expect(cells.find((c) => c.itemId === 's0')).toMatchObject({ marked: false });
  });

  it('a reshuffle that echoes a genuinely new Prompt stamps a server-observed transition', async () => {
    seedShuffle({
      // The Day-1 card is pristine and UNMARKED — no echo to trade away.
      day0Overrides: { 0: { marked: true, markedAt: 1, status: 'confirmed' } },
      playerExtra: { dayStats: { 1: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } } },
    });
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
    const playerWrite = H.txSet.mock.calls.find(isPlayerWrite)![1] as Record<string, unknown>;
    expect((playerWrite.dayStats as Record<number, { squaresMarked: number }>)[1].squaresMarked).toBe(1);
    const boardWrite = H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 1));
    const echoed = cellsFromData((boardWrite![1] as { cells: unknown }).cells).find((cell) => cell.echo);
    expect(echoed).toMatchObject({ echoAnalyticsTrigger: 'reshuffle', echoAnalyticsId: expect.any(String) });
    expectNoClientEchoTrack();
  });

  it('REGRESSION: a no-echo reshuffle keeps the exact three-write shape (board + counter + spend marker, #463) — the counter write is bare', async () => {
    seedShuffle({ playerExtra: { dayStats: { 1: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } } } });
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
    expect(H.txSet).toHaveBeenCalledTimes(3);
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
  it.each([0, 1.5, 1_700_000_060_001, NaN])('normalizes malformed carrier timestamp %s in first and delayed repair chunks', async (badStamp) => {
    const now = 1_700_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const ids = (index: number) => `malformed-repair-${index}`;
    const cells = card(ids, Object.fromEntries(Array.from({ length: 25 }, (_, index) => [index, {
      marked: true, markedAt: index === 0 || index === 20 ? badStamp : 1, status: 'confirmed' as const,
    }])));
    H.dayBoards.set(0, { uid: 'u1', seed: 71, dayIndex: 0, cells });
    H.player = { uid: 'u1', displayName: 'Alice' };
    const itemIds = cells.filter((cell) => !cell.free).map((cell) => cell.itemId!);
    const witnesses = new Map(itemIds.map((id) => [`gcb:echo-marker-repair:${EVENT_ID}:u1:${id}`, '1']));
    itemIds.forEach((id) => H.markerCache.set(id, false));
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => witnesses.get(key) ?? null,
      setItem: (key: string, value: string) => witnesses.set(key, value),
      removeItem: (key: string) => witnesses.delete(key),
    });
    try {
      await reconcileEchoes({ uid: 'u1', dayIndex: 0, dayIndexes: [0], statsFrozen: true });
      await vi.waitFor(() => expect(H.batchSet.mock.calls.filter(isMarkerWrite)).toHaveLength(24));
      const writes = H.batchSet.mock.calls.filter(isMarkerWrite);
      for (const index of [0, 20]) {
        expect(writes.find((call) => segs(call)[3] === ids(index))![1]).toMatchObject({ markedAt: now });
      }
      expect(writes.find((call) => segs(call)[3] === ids(1))![1]).toMatchObject({ markedAt: 1 });
      expect(cells[0].markedAt).toBe(badStamp); // the persisted Board/credit is untouched
      expect(H.batchCommit).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); vi.unstubAllGlobals(); }
  });

  const seedReconcile = () => {
    H.dayBoards.set(1, {
      uid: 'u1',
      seed: 111,
      dayIndex: 1,
      cells: card((i) => (i === 4 ? 'shared' : `c${i}`), { 4: { marked: true, markedAt: 1 } }),
    });
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2, cells: card((i) => (i === 9 ? 'shared' : `d${i}`)) });
    // A CONSISTENT row: the roots ARE the ceremonial-excluded sum of the
    // buckets, which is what `PlayerDoc` requires (both root totals are
    // non-optional) and what every fold writes. #496's root-lag signal reads
    // exactly that invariant, so a fixture omitting the roots would read as a
    // genuinely self-inconsistent row and trigger the heal.
    H.player = {
      uid: 'u1',
      bingoCount: 0,
      squaresMarked: 1,
      dayStats: { 1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } },
    };
  };

  it('fails closed above the Event Day maximum before reading cache or constructing a batch', async () => {
    const { getDocFromCache, writeBatch } = await import('firebase/firestore');

    await expect(
      reconcileEchoes({
        uid: 'u1',
        dayIndex: 2,
        dayIndexes: Array.from({ length: MAX_DAYS + 1 }, (_unused, index) => index),
      }),
    ).rejects.toThrow(
      `reconcileEchoes cannot process ${MAX_DAYS + 1} Day indexes; the Event maximum is ${MAX_DAYS}.`,
    );

    expect(getDocFromCache).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it.each(['complete', 'first-rejected', 'tail-rejected'])('bounds 24 marker repairs, gates acknowledgments and retries partial work: %s', async (outcome) => {
    const dayIndexes = Array.from({ length: MAX_DAYS }, (_unused, index) => index);
    const targetDayIndex = MAX_DAYS - 1;
    const itemIdAt = (index: number) => `max-reconcile-${index}`;
    const markedOverrides: Partial<Record<number, Partial<Cell>>> = {};
    for (let index = 0; index < 25; index += 1) {
      if (index === 0 || index === 12) continue;
      markedOverrides[index] = { marked: true, markedAt: 10 + index, status: 'confirmed' };
    }
    const openedBefore = card(itemIdAt, markedOverrides);
    const openedAfter = card(itemIdAt, {
      ...markedOverrides,
      0: { marked: true, markedAt: 100, status: 'confirmed', echo: true },
    });
    H.dayBoards.set(targetDayIndex, {
      uid: 'u1',
      seed: 909,
      dayIndex: targetDayIndex,
      cells: openedBefore,
    });
    H.dayBoards.set(0, {
      uid: 'u1',
      seed: 100,
      dayIndex: 0,
      cells: card((index) => (index === 1 ? itemIdAt(0) : `source-${index}`), {
        1: { marked: true, markedAt: 1, status: 'confirmed' },
      }),
    });
    H.player = { uid: 'u1', displayName: 'Alice' };

    const carrierItemIds = openedAfter
      .filter((cell) => !cell.free)
      .map((cell) => cell.itemId as string);
    const repairWitnesses = new Map(
      carrierItemIds.map((itemId) => [`gcb:echo-marker-repair:${EVENT_ID}:u1:${itemId}`, '1']),
    );
    for (const itemId of carrierItemIds) H.markerCache.set(itemId, false);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => repairWitnesses.get(key) ?? null,
      setItem: (key: string, value: string) => repairWitnesses.set(key, value),
      removeItem: (key: string) => repairWitnesses.delete(key),
    });
    const { writeBatch } = await import('firebase/firestore');
    let resolveFirst!: () => void;
    let rejectFirst!: (error: Error) => void;
    let resolveTail!: () => void;
    let rejectTail!: (error: Error) => void;
    const first = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    const tail = new Promise<void>((resolve, reject) => { resolveTail = resolve; rejectTail = reject; });
    H.batchCommit.mockImplementationOnce(() => first).mockImplementationOnce(() => tail);
    const flush = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await reconcileEchoes({
        uid: 'u1',
        dayIndex: targetDayIndex,
        dayIndexes,
        statsFrozen: false,
      });

      expect(result).toMatchObject({ changed: true, complete: true });
      expect(writeBatch).toHaveBeenCalledTimes(1);
      expect(H.batchCommit).toHaveBeenCalledTimes(1);
      expect(H.batchDelete).not.toHaveBeenCalled();

      const boardWrites = H.batchSet.mock.calls.filter((call) => isDayBoardWrite(call, targetDayIndex));
      const markerWrites = H.batchSet.mock.calls.filter(isMarkerWrite);
      expect(boardWrites).toHaveLength(1);
      expect(markerWrites).toHaveLength(16);
      expect(markerWrites.map((call) => segs(call)[3]).sort()).toEqual(carrierItemIds.slice(0, 16).sort());
      expect(markerWrites.every((call) => (call[1] as { dayIndex?: number }).dayIndex === targetDayIndex)).toBe(
        true,
      );
      expect(markerWrites.every((call) => (call[1] as { eventId?: string }).eventId === EVENT_ID)).toBe(true);
      expect(H.batchSet).toHaveBeenCalledTimes(17);

      expect([...repairWitnesses.keys()].filter((key) => key.includes(':echo-marker-repair:')).length).toBe(24);
      expect(H.txGet).not.toHaveBeenCalled(); // no stats continuation before all acks
      if (outcome === 'first-rejected') {
        rejectFirst(new Error('stale Board rejected'));
        await flush();
        expect(H.batchCommit).toHaveBeenCalledTimes(1); // tail cannot publish
        expect([...repairWitnesses.keys()].filter((key) => key.includes(':echo-marker-repair:')).length).toBe(24);
        // The unused tail mock belongs to the retired attempt.
        H.batchCommit.mockReset().mockImplementation(async () => {});
      } else {
        resolveFirst();
        await flush();
        expect(H.batchCommit).toHaveBeenCalledTimes(2);
        expect(H.batchSet.mock.calls.filter(isMarkerWrite)).toHaveLength(24);
        expect([...repairWitnesses.keys()].filter((key) => key.includes(':echo-marker-repair:')).length).toBe(24); // not forgotten after just first ack
        expect(H.txGet).not.toHaveBeenCalled();
        H.dayBoards.set(targetDayIndex, { uid: 'u1', seed: 909, dayIndex: targetDayIndex, cells: openedAfter });
        const acknowledgedIds = outcome === 'complete' ? carrierItemIds : carrierItemIds.slice(0, 16);
        for (const itemId of acknowledgedIds) H.markerCache.set(itemId, true);
        if (outcome === 'complete') {
          resolveTail();
          await flush();
          expect([...repairWitnesses.keys()].filter((key) => key.includes(':echo-marker-repair:')).length).toBe(0);
          expect(H.txGet).toHaveBeenCalled();
        } else {
          rejectTail(new Error('tail repair rejected'));
          await flush();
          expect([...repairWitnesses.keys()].filter((key) => key.includes(':echo-marker-repair:')).length).toBe(24);
          expect(H.txGet).not.toHaveBeenCalled();
        }
      }
      vi.clearAllMocks();

      const retry = await reconcileEchoes({
        uid: 'u1',
        dayIndex: targetDayIndex,
        dayIndexes,
        statsFrozen: true,
      });

      await flush();
      expect(retry.complete).toBe(true);
      const retryMarkers = H.batchSet.mock.calls.filter(isMarkerWrite);
      expect(retryMarkers).toHaveLength(outcome === 'complete' ? 0 : outcome === 'first-rejected' ? 24 : 8);
      if (outcome === 'complete') expect(writeBatch).not.toHaveBeenCalled();
      else {
        expect(H.batchCommit).toHaveBeenCalledTimes(outcome === 'first-rejected' ? 2 : 1);
        expect([...repairWitnesses.keys()].filter((key) => key.includes(':echo-marker-repair:')).length).toBe(0);
      }
    } finally {
      H.batchCommit.mockReset().mockImplementation(async () => {});
      errorLog.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each(['unmark', 'direct-mark', 'unknown-marker', 'newer-first-witness'])(
    'refreshes a delayed tail after an intervening %s without overwriting newer intent', async (intervention) => {
      const ids = (index: number) => `tail-race-${index}`;
      const overrides = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [index, { marked: true, markedAt: index + 1, status: 'confirmed' as const }]));
      const cells = card(ids, overrides);
      H.dayBoards.set(0, { uid: 'u1', seed: 71, dayIndex: 0, cells });
      H.player = { uid: 'u1', displayName: 'Alice' };
      const itemIds = cells.filter((cell) => !cell.free).map((cell) => cell.itemId!);
      const witnesses = new Map(itemIds.map((itemId) => [`gcb:echo-marker-repair:${EVENT_ID}:u1:${itemId}`, '1']));
      itemIds.forEach((itemId) => H.markerCache.set(itemId, false));
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => witnesses.get(key) ?? null,
        setItem: (key: string, value: string) => witnesses.set(key, value),
        removeItem: (key: string) => witnesses.delete(key),
      });
      let acknowledge!: () => void;
      H.batchCommit.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
      try {
        await reconcileEchoes({ uid: 'u1', dayIndex: 0, dayIndexes: [0], statsFrozen: true });
        expect(H.batchSet.mock.calls.filter(isMarkerWrite)).toHaveLength(16);
        const targetIndex = intervention === 'newer-first-witness' ? 1 : 24;
        const tailItem = ids(targetIndex);
        if (intervention === 'newer-first-witness') {
          const { getDocFromCache } = await import('firebase/firestore');
          vi.mocked(getDocFromCache).mockImplementation(async (ref) => {
            const segments = (ref as { args?: unknown[] }).args?.filter((value) => typeof value === 'string');
            if (segments?.[2] === 'days' && segments[3] === '1') throw new Error('sibling unknown');
            return H.defaultGetDocFromCache(ref as { args?: unknown[] }) as never;
          });
        }
        if (intervention === 'unknown-marker') H.markerCache.delete(tailItem);
        else {
          // This returns while the repair's first server acknowledgement is
          // held: ordinary Mark interaction and offline enqueue stay live.
          const latest = await setMark({ uid: 'u1', cells, index: targetIndex,
            nextMarked: intervention === 'direct-mark', claimMode: 'honor',
            currentFirstBingoAt: null, dayIndex: 0, daily: true,
            boardSeed: 71, statsFrozen: true,
            ...(intervention === 'newer-first-witness' ? { echoDayIndexes: [0, 1] } : {}) });
          H.dayBoards.set(0, { uid: 'u1', seed: 71, dayIndex: 0, cells: latest.cells });
          H.markerCache.set(tailItem, intervention === 'direct-mark');
          if (intervention === 'unmark' || intervention === 'newer-first-witness') expect(H.batchDelete.mock.calls.some((call) => segs(call)[3] === tailItem)).toBe(true);
        }
        const beforeTail = H.batchSet.mock.calls.length;
        acknowledge();
        await vi.waitFor(() => expect(H.batchCommit).toHaveBeenCalledTimes(intervention === 'unknown-marker' ? 2 : 3));
        const tailWrites = H.batchSet.mock.calls.slice(beforeTail).filter(isMarkerWrite);
        expect(tailWrites).toHaveLength(intervention === 'newer-first-witness' ? 8 : 7);
        expect(tailWrites.some((call) => segs(call)[3] === tailItem)).toBe(false);
        if (intervention === 'unknown-marker' || intervention === 'newer-first-witness') {
          await vi.waitFor(() => expect(witnesses.size).toBe(1));
          expect(witnesses.has(`gcb:echo-marker-repair:${EVENT_ID}:u1:${tailItem}`)).toBe(true);
        }
      } finally {
        const { getDocFromCache } = await import('firebase/firestore');
        vi.mocked(getDocFromCache).mockImplementation((ref) => H.defaultGetDocFromCache(ref as { args?: unknown[] }) as never);
        H.batchCommit.mockReset().mockImplementation(async () => {});
        vi.unstubAllGlobals();
      }
    },
  );

  it('keeps an Event A reconcile pinned to A while its cache reads settle after B is selected', async () => {
    seedReconcile();
    const { getDocFromCache } = await import('firebase/firestore');
    const mocked = vi.mocked(getDocFromCache);
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let reads = 0;
    mocked.mockImplementation(async (ref) => {
      reads += 1;
      if (reads === 1) await firstReadGate;
      return H.defaultGetDocFromCache(ref as { args?: unknown[] }) as never;
    });

    H.eventId = 'event-a';
    const pending = reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [1, 2] });
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(1));
    H.eventId = 'event-b';
    releaseFirstRead();
    await pending;

    const refsForUser = mocked.mock.calls.filter((call) =>
      ((call[0] as { args?: unknown[] }).args ?? []).includes('u1'),
    );
    expect(refsForUser.length).toBeGreaterThan(0);
    expect(
      refsForUser.every((call) => {
        const strings = ((call[0] as { args?: unknown[] }).args ?? []).filter(
          (value): value is string => typeof value === 'string',
        );
        return strings[1] === 'event-a';
      }),
    ).toBe(true);
    expect(
      H.batchSet.mock.calls
        .filter((call) => segs(call).includes('u1'))
        .every((call) => segs(call)[1] === 'event-a'),
    ).toBe(true);
  });

  it('writes the missing echo onto the opened board (its own markSeed); the stats write derives from SERVER state after the ack (#491)', async () => {
    seedReconcile();
    // The ack-gated stats reconcile is a transaction; its reads see the
    // server's post-ack truth (the reconcile's echo landed).
    H.transactionRunner = async (fn, tx) => {
      H.dayBoards.set(2, {
        uid: 'u1',
        seed: 222,
        dayIndex: 2,
        cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
          9: { marked: true, markedAt: 9, status: 'confirmed', echo: true },
        }),
      });
      return fn(tx);
    };
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
    // #491: NO player write rides the batch — a stale cached player row can
    // never be folded back over the server's stats.
    expect(H.batchSet.mock.calls.some(isPlayerWrite)).toBe(false);
    expect(H.batchCommit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      const statsWrite = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
      expect(statsWrite).toBeDefined();
      const stats = statsWrite![1] as {
        dayStats: Record<number, { squaresMarked: number }>;
        squaresMarked: number;
      };
      expect(stats.dayStats[2].squaresMarked).toBe(1);
      expect(stats.squaresMarked).toBe(2); // Day-1 prior bucket + this echo
    });
    expect(boardWrite.cells['9']).toMatchObject({ echoAnalyticsTrigger: 'open_reconcile', echoAnalyticsId: expect.any(String) });
    expectNoClientEchoTrack();
  });

  it('#1360: with Echo switched off the open-time reconcile writes no echo', async () => {
    seedReconcile();
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2], echoMarks: false });
    expect(res.changed).toBe(false);
    expect(H.batchSet.mock.calls.some((c) => isDayBoardWrite(c, 2))).toBe(false);
  });

  it('#491: a stats-lagged board heals on open — cells ahead of the cached bucket trigger a server-derived stats write, stamped from the CELLS and re-pinning the honor', async () => {
    // The reload case: an offline echo drained durably, but the ack-gated
    // stats continuation died with the tab — for a board standing a BINGO the
    // echo completed. The board's cells now EXCEED its cached dayStats bucket;
    // opening the board must re-derive from server, stamp firstBingoAt with
    // the time the LINE COMPLETED per the committed cells (not the heal's
    // clock — Codex P2 on #495), and re-attempt the create-once Day-honor pin
    // that also died with the tab (Codex P1 on #495).
    seedReconcile();
    H.player = { ...(H.player as Record<string, unknown>), displayName: 'Alice' };
    // Row 10..14 (crossing the free centre) stands complete: 10/11/13 manual,
    // 14 the echoed square that completed the line at markedAt 7.
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 14 ? 'shared' : `d${i}`), {
        10: { marked: true, markedAt: 3, status: 'confirmed' },
        11: { marked: true, markedAt: 4, status: 'confirmed' },
        13: { marked: true, markedAt: 5, status: 'confirmed' },
        14: {
          marked: true,
          markedAt: 7,
          status: 'confirmed',
          echo: true,
          echoGeneration: 1,
          echoAnalyticsId: 'echo-v1:test-event:u1:2:222:14:1',
          echoAnalyticsTrigger: 'deal',
        },
      }),
    });
    // The cached player row has NO Day-2 bucket — the lost continuation.
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2] });
    expect(res.changed).toBe(false);
    expect(res.complete).toBe(true); // the heal SUCCEEDED — the guard may settle
    expect(H.batchCommit).not.toHaveBeenCalled(); // no cell writes needed
    const statsWrite = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
    expect(statsWrite).toBeDefined();
    const stats = statsWrite![1] as {
      dayStats: Record<number, { bingoCount: number; squaresMarked: number; firstBingoAt: number | null }>;
      squaresMarked: number;
      bingoCount: number;
    };
    expect(stats.dayStats[2].squaresMarked).toBe(4);
    expect(stats.dayStats[2].bingoCount).toBe(1);
    expect(stats.dayStats[2].firstBingoAt).toBe(7); // cells-derived, not Date.now()
    expect(stats.squaresMarked).toBe(5);
    expect(stats.bingoCount).toBe(1);
    // The lag-heal re-pins the Day honor off the freshly committed stamp.
    await vi.waitFor(() => {
      const pin = H.setDoc.mock.calls.find((call) => {
        const a = segs(call as unknown[]);
        return a[2] === 'days' && a[3] === '2' && a[4] === 'meta';
      });
      expect(pin).toBeDefined();
      expect((pin![1] as { firstBingo: { uid: string; at: number } }).firstBingo).toMatchObject({
        uid: 'u1',
        at: 7,
      });
    });
    // The existing durable identity is consumed from the server-owned record,
    // not replayed from this cached Board snapshot.
    expectNoClientEchoTrack();
  });

  it.each([null, 2])('#1424: a count-consistent missing Day stamp heals from live cells while retaining earlier root %s', async (earlierRoot) => {
    seedReconcile();
    H.dayBoards.set(2, {
      uid: 'u1', seed: 222, dayIndex: 2,
      cells: card((i) => `d${i}`, {
        10: { marked: true, markedAt: 3, status: 'confirmed' },
        11: { marked: true, markedAt: 4, status: 'confirmed' },
        13: { marked: true, markedAt: 5, status: 'confirmed' },
        14: { marked: true, markedAt: 7, status: 'confirmed' },
      }),
    });
    H.player = {
      uid: 'u1', displayName: 'Alice', bingoCount: 1, squaresMarked: 5,
      firstBingoAt: earlierRoot,
      dayStats: {
        1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
        2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: null },
      },
    };
    const result = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [2], echoMarks: false });
    expect(result.complete).toBe(true);
    const call = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
    expect(call).toBeDefined();
    const write = call![1] as { dayStats: Record<number, { firstBingoAt: number }>; firstBingoAt?: number };
    expect(write.dayStats[2].firstBingoAt).toBe(7);
    if (earlierRoot === null) expect(write.firstBingoAt).toBe(7);
    else expect(write).not.toHaveProperty('firstBingoAt');
    expect(H.batchCommit).not.toHaveBeenCalled();
  });

  it('#1424: an open-time echo repair retains earlier root evidence while filling a missing Day stamp', async () => {
    seedReconcile();
    const cells = card((i) => i === 9 ? 'shared' : `d${i}`, {
      10: { marked: true, markedAt: 3, status: 'confirmed' },
      11: { marked: true, markedAt: 4, status: 'confirmed' },
      13: { marked: true, markedAt: 5, status: 'confirmed' },
      14: { marked: true, markedAt: 7, status: 'confirmed' },
    });
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2, cells });
    H.player = { uid: 'u1', displayName: 'Alice', bingoCount: 1, squaresMarked: 5,
      firstBingoAt: 2, dayStats: {
        1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
        2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: null },
      },
    };
    H.transactionRunner = async (fn, tx) => {
      H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2,
        cells: cells.map((c) => c.index === 9 ? { ...c, marked: true, markedAt: 1, status: 'confirmed', echo: true } : c),
      });
      return fn(tx);
    };
    const result = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [1, 2] });
    expect(result.changed).toBe(true);
    await vi.waitFor(() => expect(H.txSet.mock.calls.find(isPlayerWrite)).toBeDefined());
    const write = H.txSet.mock.calls.find(isPlayerWrite)![1] as {
      dayStats: Record<number, { firstBingoAt: number }>; firstBingoAt?: number;
    };
    expect(write.dayStats[2].firstBingoAt).toBe(7);
    expect(write).not.toHaveProperty('firstBingoAt');
  });

  it.each([
    { frozen: false, ceremonial: false, eligible: true },
    { frozen: true, ceremonial: true, eligible: true },
    { frozen: true, ceremonial: false, eligible: false },
  ])('#1424: changed missing-stamp pass retains later-open retry without awaiting ACK (frozen=$frozen ceremonial=$ceremonial)', async ({ frozen, ceremonial, eligible }) => {
    seedReconcile();
    const cells = card((i) => i === 9 ? 'shared' : `d${i}`, {
      10: { marked: true, markedAt: 3, status: 'confirmed' },
      11: { marked: true, markedAt: 4, status: 'confirmed' },
      13: { marked: true, markedAt: 5, status: 'confirmed' },
      14: { marked: true, markedAt: 7, status: 'confirmed' },
    });
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2, cells });
    H.player = { uid: 'u1', bingoCount: 1, squaresMarked: 5, firstBingoAt: 2,
      dayStats: {
        1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
        2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: null },
      },
    };
    let ack!: () => void;
    H.batchCommit.mockImplementationOnce(() => new Promise<void>((resolve) => { ack = resolve; }));
    let repairAttempts = 0;
    H.transactionRunner = async () => { repairAttempts += 1; throw new Error('unavailable'); };
    const params = { uid: 'u1', dayIndex: 2, dayIndexes: [1, 2], statsFrozen: frozen,
      ceremonialDayIndexes: ceremonial ? [2] : [],
    };
    // Resolve before the held queued ACK: neither this call nor the shared
    // Mark chain may wait for the detached server transaction.
    const result = await reconcileEchoes(params);
    expect(result.changed).toBe(true);
    expect(repairAttempts).toBe(0);
    expect(result.complete).toBe(!eligible);
    // A subsequent ordinary Mark shares this chain but queues without
    // waiting for the repair batch's ACK or server transaction.
    H.batchCommit.mockImplementationOnce(() => new Promise<void>(() => {}));
    await setMark({ uid: 'u1', cells: cellsFromData(H.dayBoards.get(1)!.cells),
      index: 0, nextMarked: true, claimMode: 'honor', currentFirstBingoAt: null,
      dayIndex: 1, daily: true, boardSeed: 111, echoDayIndexes: [1, 2], echoMarks: false,
    });
    expect(H.batchCommit).toHaveBeenCalledTimes(2);
    expect(repairAttempts).toBe(0);
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2,
      cells: cells.map((c) => c.index === 9 ? { ...c, marked: true, markedAt: 1, status: 'confirmed', echo: true } : c),
    });
    ack();
    if (eligible) await vi.waitFor(() => expect(repairAttempts).toBe(1));
    else await Promise.resolve();
    // Failed post-ACK stats repair leaves the same missing timestamp. A
    // later open with unchanged cells must take the existing awaited heal.
    H.transactionRunner = null;
    const retry = await reconcileEchoes(params);
    expect(retry.changed).toBe(false);
    expect(retry.complete).toBe(true);
    const write = H.txSet.mock.calls.find(isPlayerWrite)?.[1] as { dayStats?: Record<number, { firstBingoAt: number }> } | undefined;
    if (eligible) expect(write?.dayStats?.[2]?.firstBingoAt).toBe(7);
    else expect(write).toBeUndefined(); // frozen scoring Days cannot converge
  });

  it('#491: a FAILED stats-lag heal reports the pass incomplete so a later open retries (Codex P2 #495)', async () => {
    seedReconcile();
    H.dayBoards.set(2, {
      uid: 'u1',
      seed: 222,
      dayIndex: 2,
      cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
        9: { marked: true, markedAt: 7, status: 'confirmed', echo: true },
      }),
    });
    // The device went offline again: the heal's transaction rejects.
    H.transactionRunner = async () => {
      throw new Error('unavailable');
    };
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2] });
    expect(res.changed).toBe(false);
    expect(res.complete).toBe(false); // Board must drop its once-per-board key
  });

  /**
   * #496 — the ROOT-total half of the stats lag. The per-Day signal (#491) is
   * blind to it: an offline echo overwrote a cell another device had already
   * marked, so every `dayStats[d]` bucket converged, while the acted-day batch
   * wrote roots re-summed from the STALE cached buckets and the post-ack
   * server-derived transaction died in a reload. The tell is row-internal —
   * the buckets out-sum the roots, which no consistent write can produce.
   */
  describe('#496: the row-internal root-lag heal', () => {
    /** A Day-2 board standing a completed row 10..14 (through the free centre). */
    const bingoDay2 = () =>
      H.dayBoards.set(2, {
        uid: 'u1',
        seed: 222,
        dayIndex: 2,
        cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
          10: { marked: true, markedAt: 7, status: 'confirmed' },
          11: { marked: true, markedAt: 7, status: 'confirmed' },
          13: { marked: true, markedAt: 7, status: 'confirmed' },
          14: { marked: true, markedAt: 7, status: 'confirmed' },
        }),
      });

    it('heals understated roots on the open of ANY board, even one whose own bucket is perfectly in step', async () => {
      seedReconcile();
      bingoDay2();
      // Every bucket matches its board's cells — the #491 per-Day signal has
      // nothing to fire on, on Day 1 or anywhere else. The ROOTS still carry
      // the pre-Day-2 sum: understated by that Day's whole bucket.
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 1,
        dayStats: {
          1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
          2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 7 },
        },
      };
      // Opening DAY 1 — not the Day whose bucket the roots are missing.
      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 1, dayIndexes: [0, 1, 2] });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true); // the heal succeeded — the guard may settle
      expect(H.batchCommit).not.toHaveBeenCalled(); // no cell writes needed
      const statsWrite = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
      expect(statsWrite).toBeDefined();
      const stats = statsWrite![1] as {
        dayStats: Record<number, { bingoCount: number; squaresMarked: number }>;
        bingoCount: number;
        squaresMarked: number;
      };
      // Rewritten from SERVER state: the roots now equal the row's own buckets.
      expect(stats.squaresMarked).toBe(5);
      expect(stats.bingoCount).toBe(1);
      // The opened Day's bucket rides along unchanged — the heal never
      // fabricates a bucket from anything but the board's committed cells.
      expect(stats.dayStats[1]).toMatchObject({ bingoCount: 0, squaresMarked: 1 });
      // #721, Codex round 1 finding 7: a ROOT-only lag (this case — Day 1's
      // OWN bucket already matched its board before the heal ran) must fire
      // NO echo_mark: nothing NEW echoed onto Day 1, so reporting one here
      // would claim a count the bucket never actually moved for.
      await new Promise((r) => setTimeout(r, 0));
      expect(H.track).not.toHaveBeenCalledWith('echo_mark', expect.objectContaining({ trigger: 'open_reconcile' }));
    });

    it('ignores the ceremonial Day bucket, which the roots never counted (#265)', async () => {
      seedReconcile();
      bingoDay2();
      // Day 2 is the farewell Day: its bucket is deliberately absent from the
      // roots, so a naive bucket-sum would read this consistent row as lagging
      // by the whole ceremonial bucket and re-heal on every single open.
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 1,
        dayStats: {
          1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
          2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 7 },
        },
      };
      const res = await reconcileEchoes({
        uid: 'u1',
        dayIndex: 1,
        dayIndexes: [0, 1, 2],
        ceremonialDayIndexes: [2],
      });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true);
      expect(H.txSet).not.toHaveBeenCalled();
    });

    it('never heals the other direction: roots ABOVE the bucket sum are a legacy/partial breakdown, not lag', async () => {
      seedReconcile();
      // The pre-Day-Cards roster shape: real root totals, a `dayStats` map
      // that has only started filling in. A heal here would march the roster
      // BACKWARDS — exactly the regression #491 removed.
      H.player = {
        uid: 'u1',
        bingoCount: 3,
        squaresMarked: 40,
        dayStats: { 1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } },
      };
      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 1, dayIndexes: [0, 1, 2] });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true);
      expect(H.txSet).not.toHaveBeenCalled();
    });

    it('never heals a row that is partial in ONE dimension and lagging in the other (Codex P1 on #503)', async () => {
      seedReconcile();
      // Buckets out-sum the SQUARES root but fall short of the BINGO root —
      // a legacy roster whose per-Day breakdown has only partly filled in.
      // The fold rewrites BOTH roots from one merged view, so healing here
      // would march `bingoCount` DOWN from 3 to 0 (and clear the cruise
      // `firstBingoAt` with it). Dominance must hold on every field.
      H.player = {
        uid: 'u1',
        bingoCount: 3,
        squaresMarked: 40,
        dayStats: { 1: { bingoCount: 0, squaresMarked: 45, firstBingoAt: null } },
      };
      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 1, dayIndexes: [0, 1, 2] });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true);
      expect(H.txSet).not.toHaveBeenCalled();
    });

    it('is skipped post-freeze, where the reconcile writes ceremonial buckets only and a root lag could never converge', async () => {
      seedReconcile();
      bingoDay2();
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 1,
        dayStats: {
          1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
          2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 7 },
        },
      };
      // Day 1 is heal-ELIGIBLE for the per-Day signal only pre-freeze; post
      // freeze even a ceremonial open must not re-read the server for roots
      // that the narrowed write can never touch.
      const res = await reconcileEchoes({
        uid: 'u1',
        dayIndex: 1,
        dayIndexes: [0, 1, 2],
        ceremonialDayIndexes: [1],
        statsFrozen: true,
      });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true);
      expect(H.txSet).not.toHaveBeenCalled();
    });
  });

  /**
   * #505 — the `firstBingoAt` dimension of the same root lag. The fold the
   * heal commits rewrites THREE root fields; the #496/#503 gate covered only
   * the two numeric ones, leaving the Leaderboard tie-break stamp
   * (`comparePlayers`' third key) both unhealable when understated and
   * unprotected when a legacy root stamp predates the buckets' evidence.
   */
  describe('#505: the firstBingoAt dimension of the root-lag signal', () => {
    /** A Day-2 board standing a completed row 10..14 (through the free centre). */
    const bingoDay2 = () =>
      H.dayBoards.set(2, {
        uid: 'u1',
        seed: 222,
        dayIndex: 2,
        cells: card((i) => (i === 9 ? 'shared' : `d${i}`), {
          10: { marked: true, markedAt: 7, status: 'confirmed' },
          11: { marked: true, markedAt: 7, status: 'confirmed' },
          13: { marked: true, markedAt: 7, status: 'confirmed' },
          14: { marked: true, markedAt: 7, status: 'confirmed' },
        }),
      });
    /** A row whose numeric roots are exactly in step with its buckets — only
     *  the root stamp varies per test. */
    const rowWithRootStamp = (firstBingoAt?: number | null) => {
      H.player = {
        uid: 'u1',
        bingoCount: 1,
        squaresMarked: 5,
        ...(firstBingoAt === undefined ? {} : { firstBingoAt }),
        dayStats: {
          1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
          2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 7 },
        },
      };
    };

    it('heals a MISSING root firstBingoAt when the buckets carry the stamp, even with both numeric roots in step', async () => {
      seedReconcile();
      bingoDay2();
      rowWithRootStamp(undefined);
      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 1, dayIndexes: [0, 1, 2] });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true);
      expect(H.batchCommit).not.toHaveBeenCalled(); // no cell writes needed
      const statsWrite = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
      expect(statsWrite).toBeDefined();
      const stats = statsWrite![1] as {
        bingoCount: number;
        squaresMarked: number;
        firstBingoAt: number | null;
      };
      // Rewritten from SERVER state: the root stamp now equals the earliest
      // bucket evidence, and the (already-consistent) numeric roots hold.
      expect(stats.firstBingoAt).toBe(7);
      expect(stats.bingoCount).toBe(1);
      expect(stats.squaresMarked).toBe(5);
    });

    it("heals a root firstBingoAt LATER than the buckets' own evidence", async () => {
      seedReconcile();
      bingoDay2();
      rowWithRootStamp(99);
      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 1, dayIndexes: [0, 1, 2] });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true);
      const statsWrite = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
      expect(statsWrite).toBeDefined();
      expect((statsWrite![1] as { firstBingoAt: number | null }).firstBingoAt).toBe(7);
    });

    it('does not churn a row whose root stamp matches the bucket-derived earliest', async () => {
      seedReconcile();
      bingoDay2();
      rowWithRootStamp(7);
      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 1, dayIndexes: [0, 1, 2] });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true);
      expect(H.txSet).not.toHaveBeenCalled();
    });

    it('never regresses: a legacy root stamp EARLIER than every bucket blocks the heal, even with dominating counts', async () => {
      seedReconcile();
      bingoDay2();
      // The #505 legacy/hybrid shape: the buckets dominate BOTH numeric roots
      // (understated counts — the #496 signal alone would heal), but the root
      // stamp predates every populated bucket. The fold derives the root
      // stamp purely from the buckets, so a heal would replace the legitimate
      // earlier honor with 7 — the gate must treat the row as NOT dominated.
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 1,
        firstBingoAt: 3,
        dayStats: {
          1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
          2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 7 },
        },
      };
      const res = await reconcileEchoes({ uid: 'u1', dayIndex: 1, dayIndexes: [0, 1, 2] });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true);
      expect(H.txSet).not.toHaveBeenCalled();
    });

    it("a tutorial Day's stamp is not root-stamp evidence — the fold's root derivation excludes it", async () => {
      seedReconcile();
      bingoDay2();
      // Day 2 is tutorial: its bucket counts toward the sums (embark play is
      // real), but its stamp is excluded from the cruise-wide root, so the
      // app-consistent row carries NO root stamp. Reading the tutorial
      // bucket's stamp as understatement would re-heal on every open.
      H.player = {
        uid: 'u1',
        bingoCount: 1,
        squaresMarked: 5,
        dayStats: {
          1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
          2: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 7 },
        },
      };
      const res = await reconcileEchoes({
        uid: 'u1',
        dayIndex: 1,
        dayIndexes: [0, 1, 2],
        tutorialDayIndexes: [2],
      });
      expect(res.changed).toBe(false);
      expect(res.complete).toBe(true);
      expect(H.txSet).not.toHaveBeenCalled();
    });
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
    // The row's Day-2 bucket already matches the cells, and the roots match
    // the bucket sum — neither stats-lag signal (#491 per-Day, #496 root) has
    // anything to fire on.
    H.player = {
      ...(H.player as Record<string, unknown>),
      bingoCount: 0,
      squaresMarked: 2,
      dayStats: {
        1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
        2: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
      },
    };
    const res = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2] });
    expect(res.changed).toBe(false);
    expect(res.complete).toBe(true);
    expect(H.batchSet).not.toHaveBeenCalled();
    expect(H.batchCommit).not.toHaveBeenCalled();
    // And no #491 server-derived stats write either — the heal is lag-gated
    // and AWAITED inside the reconcile, so this assertion is sound here
    // (CodeRabbit on #495): no transaction ran at all.
    expect(H.txSet).not.toHaveBeenCalled();
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

  it('preserves a blackout standing on an untouched board through the server-derived stats write (Codex P2 #447, #491)', async () => {
    seedReconcile();
    H.player = { ...(H.player as Record<string, unknown>), blackout: true };
    await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [0, 1, 2] });
    // #491: the stats write is post-ack and server-derived; the prior root
    // blackout latches through it exactly as it did through the batch fold.
    await vi.waitFor(() => {
      const statsWrite = H.txSet.mock.calls.find((call) => segs(call as unknown[])[2] === 'players');
      expect(statsWrite).toBeDefined();
      expect((statsWrite![1] as { blackout: boolean }).blackout).toBe(true);
    });
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
    // Row bucket in step with the cells and roots in step with the bucket sum
    // — no #491/#496 stats-lag heal in this test.
    H.player = {
      ...(H.player as Record<string, unknown>),
      bingoCount: 0,
      squaresMarked: 2,
      dayStats: {
        1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
        2: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
      },
    };
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
    // Roots in step with the bucket: this exercises the repair-PIN path, not
    // the #496 root-lag heal (which a rootless fixture would also trigger).
    H.player = {
      uid: 'u1',
      displayName: 'Alice',
      bingoCount: 1,
      squaresMarked: 4,
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
    // And WITHOUT a server-accepted stamp, no pin fires: with the row
    // unstamped the stats-lag heal now runs first (#491/#495), so force it to
    // FAIL — an unhealed, unstamped bingo must never mint the honor.
    vi.clearAllMocks();
    H.player = { uid: 'u1', displayName: 'Alice', dayStats: {} };
    H.transactionRunner = async () => {
      throw new Error('unavailable');
    };
    const failed = await reconcileEchoes({ uid: 'u1', dayIndex: 2, dayIndexes: [2] });
    expect(failed.complete).toBe(false); // the failed heal retries a later open
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
    // The committed claim-board edge is labelled for the server recorder;
    // this administrator browser does not emit a lossy client-side event.
    const claimBoardWrite = H.txSet.mock.calls.find((call) => isDayBoardWrite(call, 1));
    expect(claimBoardWrite![1]).toMatchObject({
      directAnalyticsRequest: {
        cellIndex: 5,
        marked: true,
        mode: 'admin_confirmed',
        source: 'admin_confirm',
        id: expect.any(String),
      },
    });
    const siblingWrite = H.txSet.mock.calls.find((call) => isDayBoardWrite(call, 2));
    const siblingCells = cellsFromData((siblingWrite![1] as { cells: unknown }).cells);
    expect(siblingCells.find((cell) => cell.echo)).toMatchObject({
      echoAnalyticsTrigger: 'admin_confirm',
      echoAnalyticsId: expect.any(String),
    });
    expectNoClientEchoTrack();
  });

  it('#1360: with settings.echoMarks false a confirm resolves its own card only', async () => {
    seedClaim();
    H.event = { ...H.event, settings: { ...(H.event?.settings ?? {}), echoMarks: false } };
    await confirmClaim(claim(), 'admin-1');
    expect(H.txSet.mock.calls.some((c) => isDayBoardWrite(c, 1))).toBe(true);
    expect(H.txSet.mock.calls.some((c) => isDayBoardWrite(c, 2))).toBe(false);
  });

  it('a stale claim (no matching board/cell) resolves without firing mark_square or echo_mark (Codex round 1 finding 3, #727; round 3)', async () => {
    seedClaim();
    // The claim's cellIndex/proofId no longer matches anything on the board —
    // a reshuffle traded the cell away underneath a still-pending claim. With
    // no matching cell, `resolve()`'s `confirmedCell` is never found, so
    // `echoItemId` stays null and no sibling echo — and no `echo_mark` —
    // fires either (round 3, Codex P2, #727).
    await confirmClaim(claim({ cellIndex: 99, proofId: null }), 'admin-1');
    await new Promise((r) => setTimeout(r, 0));
    expect(H.track).not.toHaveBeenCalledWith('mark_square', expect.anything());
    expect(H.track).not.toHaveBeenCalledWith('echo_mark', expect.anything());
  });

  it('a SECOND confirm racing an already-confirmed claim does not double-fire mark_square (Codex round 1 finding 3, #727)', async () => {
    // The board is ALREADY confirmed (a first admin's transaction won the
    // race) — this simulates the loser's transaction replaying against the
    // winner's committed state.
    H.dayBoards.set(1, {
      uid: 'u1',
      seed: 111,
      dayIndex: 1,
      cells: card((i) => (i === 5 ? 'shared' : `a${i}`), {
        5: { marked: true, markedAt: 1, status: 'confirmed' },
      }),
    });
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2, cells: card((i) => (i === 7 ? 'shared' : `b${i}`)) });
    H.player = { uid: 'u1', displayName: 'Alice', dayStats: {} };
    await confirmClaim(claim(), 'admin-2');
    await new Promise((r) => setTimeout(r, 0));
    expect(H.track).not.toHaveBeenCalledWith('mark_square', expect.anything());
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

// #1360 — the repeat window, end to end through both deal paths. Day 1 (nearest
// to Day 0) holds s0..s23 and Day 2 holds s24..s47; the snapshot is s0..s71.
// With no window the whole history (48) is excluded, which leaves exactly
// s48..s71 — no s24..s47 can appear. A window of ONE card excludes only Day 1,
// so the 48 survivors include s24..s47 and the card draws from them.
describe('the repeat window reaches dealDayCard and reshuffleBoard (#1360)', () => {
  const SNAP = Array.from({ length: 72 }, (_, i) => `s${i}`);
  const cardOf = (ids: string[]) => {
    let cursor = 0;
    return card((i) => (i === 12 ? 'free' : ids[cursor++]));
  };
  const seedWindow = (settings: Record<string, unknown>, withDay0Card: boolean) => {
    for (const id of SNAP) H.itemsById.set(id, { text: `P ${id}`, spicy: false, isFreeSpace: false });
    H.event = {
      days: [0, 1, 2].map((i) => day(i, { snapshotItemIds: SNAP })),
      settings: { spicyRatio: 0.4, ...settings },
    };
    H.dayBoards.set(1, { uid: 'u1', seed: 111, dayIndex: 1, cells: cardOf(SNAP.slice(0, 24)) });
    H.dayBoards.set(2, { uid: 'u1', seed: 222, dayIndex: 2, cells: cardOf(SNAP.slice(24, 48)) });
    if (withDay0Card) {
      H.dayBoards.set(0, { uid: 'u1', seed: 100, dayIndex: 0, cells: cardOf(SNAP.slice(48, 72)) });
    }
    H.player = { uid: 'u1', joinedAt: 1, reshufflesUsed: 0, dayStats: {} };
  };
  const day2Ids = new Set(SNAP.slice(24, 48));
  const dealt = (write: unknown) =>
    cellsFromData((write as { cells: unknown }).cells)
      .filter((c) => !c.free)
      .map((c) => c.itemId as string);
  const u = { uid: 'u1', displayName: 'Alice', photoURL: null } as never;

  it('dealDayCard: no window keeps Day 2 off the card; a 1-card window lets it back', async () => {
    seedWindow({}, false);
    await expect(dealDayCard(u, 0)).resolves.toBe(true);
    const whole = dealt(H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 0))![1]);
    expect(whole.some((id) => day2Ids.has(id))).toBe(false);

    H.txSet.mockClear();
    H.dayBoards.delete(0);
    seedWindow({ repeatWindow: 1 }, false);
    await expect(dealDayCard(u, 0)).resolves.toBe(true);
    const windowed = dealt(H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 0))![1]);
    expect(windowed.some((id) => SNAP.slice(0, 24).includes(id))).toBe(false); // Day 1 still excluded
    expect(windowed.some((id) => day2Ids.has(id))).toBe(true);
  });

  it('reshuffleBoard: the replacement honours the same window over the KEPT cards', async () => {
    seedWindow({}, true);
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 0, expectedSeed: 100 })).resolves.toBe(1);
    const whole = dealt(H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 0))![1]);
    expect(whole.some((id) => day2Ids.has(id))).toBe(false);

    H.txSet.mockClear();
    seedWindow({ repeatWindow: 1 }, true);
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 0, expectedSeed: 100 })).resolves.toBe(1);
    const windowed = dealt(H.txSet.mock.calls.find((c) => isDayBoardWrite(c, 0))![1]);
    expect(windowed.some((id) => SNAP.slice(0, 24).includes(id))).toBe(false);
    expect(windowed.some((id) => day2Ids.has(id))).toBe(true);
  });
});
