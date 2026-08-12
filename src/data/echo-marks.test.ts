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
  // #721: api.ts / admin.ts fire echo_mark / mark_square via a DYNAMIC
  // `import('../analytics')` (mirroring the existing #387 mark_rejected call
  // site) so this Firestore-only module graph stays free of the eager
  // analytics/firebase-singleton dependency — mock the module so the dynamic
  // import resolves to this spy instead of loading the real one.
  track: vi.fn(),
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

/** Every raw delivery carries a stable ID; PostHog reconciliation dedupes it. */
const expectEchoTrack = (trigger: string, dayIndex: number) =>
  expect(H.track).toHaveBeenCalledWith(
    'echo_mark',
    expect.objectContaining({
      trigger,
      uid: 'u1',
      dayIndex,
      count: 1,
      transitionId: expect.any(String),
    }),
  );

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
    // #721: the mark-time cascade fires its own echo_mark, NEVER folded into
    // mark_square — the acted Mark's OWN mark_square is Board.tsx's concern,
    // not setMark's. `dayIndex` (Codex round 1 finding 4) is the RECEIVING
    // Day (3, the carrier), never the acted Day (2) — `squaresMarked`
    // increments on the RECEIVING bucket (specs/w2-ga4-events.md §
    // Reconciliation), so attributing this to the acted Day would make that
    // Day's own reconciliation identity unprovable.
    await vi.waitFor(() =>
      expectEchoTrack('mark', 3),
    );
  });

  it('a Mark that echoes onto TWO siblings fires echo_mark once PER receiving Day (Codex round 1 finding 1, #727)', async () => {
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
    await vi.waitFor(() => {
      expectEchoTrack('mark', 1);
      expectEchoTrack('mark', 3);
    });
    // Never one aggregated event under the acted Day.
    expect(H.track).not.toHaveBeenCalledWith('echo_mark', expect.objectContaining({ dayIndex: 2 }));
  });

  it('replays the same persisted mark-time transition on a later open when only the SIBLING stats continuation stranded (Codex P2 on #727)', async () => {
    // The mark-time cascade's `echo_mark` send and its
    // `reconcileEchoStatsFromServer` player-row write are two INDEPENDENT
    // promises off the SAME batch commit (src/data/api.ts) — a reload can
    // strand one while the other lands. Simulate exactly that: the echo_mark
    // below fires and durably records its report BEFORE any assertion runs,
    // but this mock never mutates `H.player` (the stats continuation's own
    // write target), so the cached player row for Day 3 stays exactly as
    // stale as a genuinely lost continuation would leave it.
    seedBoards();
    await markShared();
    await vi.waitFor(() =>
      expectEchoTrack('mark', 3),
    );
    const transitionId = (H.track.mock.calls.find(
      ([name, payload]) => name === 'echo_mark' && (payload as { trigger?: string }).trigger === 'mark',
    )![1] as { transitionId: string }).transitionId;
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
    // The second delivery is intentionally the SAME durable transition, not a
    // new high-water total. Querying distinct `transitionId` therefore counts
    // it once even when another tab/device performs this recovery.
    await vi.waitFor(() => expectEchoTrack('open_reconcile', 3));
    const replayedId = (H.track.mock.calls.find(
      ([name, payload]) => name === 'echo_mark' && (payload as { trigger?: string }).trigger === 'open_reconcile',
    )![1] as { transitionId: string }).transitionId;
    expect(replayedId).toBe(transitionId);
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
    // #721: the dealt card arrived pre-marked, not tapped — countable via its
    // own echo_mark, never mark_square.
    await vi.waitFor(() =>
      expectEchoTrack('deal', 0),
    );
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

  it('a reshuffle that echoes a GENUINELY new Prompt (the discarded card was echo-free) still fires echo_mark with the real net-new count', async () => {
    seedShuffle({
      // The Day-1 card is pristine and UNMARKED — no echo to trade away.
      day0Overrides: { 0: { marked: true, markedAt: 1, status: 'confirmed' } },
      playerExtra: { dayStats: { 1: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } } },
    });
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
    const playerWrite = H.txSet.mock.calls.find(isPlayerWrite)![1] as Record<string, unknown>;
    expect((playerWrite.dayStats as Record<number, { squaresMarked: number }>)[1].squaresMarked).toBe(1);
    await vi.waitFor(() =>
      expectEchoTrack('reshuffle', 1),
    );
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
    // #721: the open-time backfill heal fires echo_mark for the Square this
    // device never saw committed, on the OPENED board's Day.
    await vi.waitFor(() =>
      expectEchoTrack('open_reconcile', 2),
    );
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
    // #721, Codex round 1 finding 7: the SAME reload that stranded the pin
    // continuation above also stranded the mark-time cascade's OWN
    // `echo_mark` continuation — the cells already carry the echo (drained
    // durably offline) but `res.changed` is false this open, so the ordinary
    // firing site above never ran. The persisted Echo identity is the recovery
    // point: it emits one event for this one Echo, independently of the wider
    // stale stats delta (which also includes three manual Marks).
    await vi.waitFor(() => expectEchoTrack('open_reconcile', 2));
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
    // #721: confirming is the CREDITED transition for an admin_confirmed-mode
    // Square (countMarked excludes `pending`) — fires mark_square{source:
    // 'admin_confirm'}, the second of the two mark_square events this Square
    // produces (the first, source: 'proof', fired at claim-submit time and is
    // not this suite's concern). This is the CLAIM'S OWN Square, a player
    // action, so it fires mark_square — never echo_mark, which is asserted
    // separately below for Day 2's sibling echo.
    // `dayIndex`/`uid` (Codex round 1 findings 2 & 6): the claim's own Day
    // and OWNER — this call runs in the ADMIN's session, so without an
    // explicit `uid` the event would attribute to the admin's distinct id.
    await vi.waitFor(() =>
      expect(H.track).toHaveBeenCalledWith('mark_square', {
        source: 'admin_confirm',
        mode: 'admin_confirmed',
        marked: true,
        dayIndex: 1,
        uid: 'u1',
      }),
    );
    // Round 3 (Codex P2, #727): the sibling echo onto Day 2 (the write
    // asserted above) is its OWN squaresMarked increment with no tap behind
    // it — the same reasoning that gives every other propagation path an
    // `echo_mark`, now extended to this fifth one (admin_confirm). Grouped by
    // the RECEIVING Day (2), never the claim's own acted Day (1).
    await vi.waitFor(() =>
      expectEchoTrack('admin_confirm', 2),
    );
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
