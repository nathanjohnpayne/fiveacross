import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { User } from 'firebase/auth';
import type { Cell, DayDef, EventDoc, ItemDoc } from '../types';

// Covers specs/d15-dealing.md — the per-Day deal write path `dealDayCard`. The
// deal is snapshot-gated (drawn ONLY from `DayDef.snapshotItemIds`, never a live
// `status: 'active'` query), lazy (no Board dealt before `unlockAt` or before the
// snapshot is stamped), no-repeat-across-the-cruise (excludes Prompts on the
// Player's earlier Day Cards), and idempotent (re-opening an already-dealt Day
// never re-deals). The sampling/exclusion math itself is proven in
// src/game/logic.test.ts; this file proves the Firestore-facing gate.

const EVENT_ID = 'test-event';

// A single getDoc mock routed by the doc ref's path args (the firebase/firestore
// mock below stamps { kind:'doc', args:[...] } onto every ref). Fixtures are set
// per-test; anything unrouted resolves to a not-exists snapshot.
const H = vi.hoisted(() => ({
  event: null as { days?: DayDef[]; settings?: Partial<EventDoc['settings']> } | null,
  itemsById: new Map<string, Partial<ItemDoc>>(),
  dayBoards: new Map<number, { uid: string; cells: Cell[] } | null>(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  batchSet: vi.fn(),
  batchCommit: vi.fn(async () => {}),
  txSet: vi.fn(),
  txGet: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));

vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref;
    return ref;
  };
  return {
    doc: (...args: unknown[]) => makeRef('doc', args),
    collection: (...args: unknown[]) => makeRef('collection', args),
    query: (...args: unknown[]) => ({ query: args }),
    where: (...args: unknown[]) => ({ where: args }),
    getDoc: H.getDoc,
    getDocFromCache: vi.fn(),
    getDocFromServer: vi.fn(),
    getDocs: H.getDocs,
    writeBatch: () => ({ set: H.batchSet, commit: H.batchCommit }),
    addDoc: vi.fn(),
    increment: vi.fn(),
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (ref: { args?: unknown[] }) => {
          H.txGet(ref);
          return route(ref);
        },
        set: H.txSet,
      };
      return fn(tx);
    },
    setDoc: vi.fn(),
    updateDoc: vi.fn(),
    onSnapshot: vi.fn(),
    serverTimestamp: vi.fn(),
    getFirestore: vi.fn(),
  };
});

import { cellsFromData } from '../game/cells';
import { resetAdultContentForTests, setActiveAdultContent } from '../adultContent';
import { dealDayCard } from './api';

const snap = (exists: boolean, id = '', data: unknown = undefined) => ({
  exists: () => exists,
  id,
  data: () => data,
});

// Route a doc read by its path args to the right fixture. `doc(db, ...segments)`
// carries the leading `db` object, so keep only the string path segments.
function route(ref: { args?: unknown[] }) {
  const a = (ref.args ?? []).filter((x): x is string => typeof x === 'string');
  // events/{EVENT_ID}
  if (a.length === 2 && a[0] === 'events') {
    return H.event ? snap(true, EVENT_ID, H.event) : snap(false);
  }
  // events/{EVENT_ID}/items/{id}
  if (a[2] === 'items') {
    const item = H.itemsById.get(a[3]);
    return item ? snap(true, a[3], item) : snap(false);
  }
  // events/{EVENT_ID}/days/{d}/boards/{uid}
  if (a[2] === 'days' && a[4] === 'boards') {
    const board = H.dayBoards.get(Number(a[3]));
    return board ? snap(true, a[5], board) : snap(false);
  }
  return snap(false);
}

const NOW = Date.now();
const PAST = NOW - 3_600_000;
const FUTURE = NOW + 3_600_000;

const U = { uid: 'sailor-1', displayName: 'Sailor', photoURL: null } as unknown as User;

// A pool of `n` all-tame main-pool items with ids p0..p{n-1}.
function seedPool(n: number, pool: DayDef['pool'] = 'main') {
  H.itemsById.clear();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `p${i}`;
    ids.push(id);
    H.itemsById.set(id, {
      text: `prompt ${i}`,
      isFreeSpace: false,
      status: 'active',
      spicy: false,
      pool,
      reportCount: 0,
    });
  }
  return ids;
}

function mkDay(over: Partial<DayDef>): DayDef {
  return {
    index: 2,
    date: '2026-07-18',
    port: 'Split',
    portEmoji: '🇭🇷',
    theme: 'neon-playground',
    tonight: [],
    pool: 'main',
    tutorial: false,
    unlockAt: PAST,
    ...over,
  };
}

// The dealer indexes `days[dayIndex]` by ARRAY POSITION, so a target Day 2 must
// sit at array index 2. Wrap it behind two past-unlocked filler Days so a
// single-Day scenario still resolves `days[2]`.
function daysWith(target: DayDef): DayDef[] {
  return [
    mkDay({ index: 0, unlockAt: PAST, snapshotItemIds: [] }),
    mkDay({ index: 1, unlockAt: PAST, snapshotItemIds: [] }),
    target,
  ];
}

beforeEach(() => {
  resetAdultContentForTests();
  H.event = null;
  H.itemsById.clear();
  H.dayBoards.clear();
  H.getDoc.mockReset();
  H.getDoc.mockImplementation(async (ref: { args?: unknown[] }) => route(ref));
  H.getDocs.mockReset();
  H.getDocs.mockResolvedValue({ docs: [] });
  H.batchSet.mockReset();
  H.batchCommit.mockReset();
  H.batchCommit.mockResolvedValue(undefined);
  H.txSet.mockReset();
  H.txGet.mockReset();
});

// The last board write's (ref, data) — the day-scoped Board doc, if any.
function writtenBoard(): { ref: { args?: unknown[] }; data: { cells: Cell[]; dayIndex: number; easyMixRatio?: number } } | null {
  for (const call of H.txSet.mock.calls) {
    const ref = call[0] as { args?: unknown[] };
    const a = (ref.args ?? []).filter((x): x is string => typeof x === 'string');
    if (a[2] === 'days' && a[4] === 'boards') {
      const payload = call[1] as { cells: unknown; dayIndex: number; easyMixRatio?: number };
      // The wire shape is the #457 cells MAP; assertions read the app shape.
      return { ref, data: { ...payload, cells: cellsFromData(payload.cells) } };
    }
  }
  return null;
}

describe('dealDayCard — snapshot-gated lazy dealing', () => {
  it('does NOT deal a Day whose unlockAt is in the future (locked)', async () => {
    const ids = seedPool(30);
    H.event = { days: daysWith(mkDay({ index: 2, unlockAt: FUTURE, snapshotItemIds: ids })), settings: {} };

    const dealt = await dealDayCard(U, 2);

    expect(dealt).toBe(false);
    expect(writtenBoard()).toBeNull();
  });

  it('does NOT deal a Day whose unlockAt has passed but whose snapshot is unstamped (waking)', async () => {
    seedPool(30);
    // unlockAt in the past, but snapshotItemIds absent — the "waking up" case.
    H.event = { days: daysWith(mkDay({ index: 2, unlockAt: PAST, snapshotItemIds: undefined })), settings: {} };

    const dealt = await dealDayCard(U, 2);

    expect(dealt).toBe(false);
    expect(writtenBoard()).toBeNull();
  });

  it('deals a Day Card from the snapshot — never a live status query — when ready', async () => {
    const ids = seedPool(30);
    H.event = {
      days: daysWith(mkDay({ index: 2, unlockAt: PAST, snapshotItemIds: ids, snapshotEasyMixRatio: 0.25 })),
      settings: { spicyRatio: 0.4, easyMixRatio: 0.75 },
    };

    const dealt = await dealDayCard(U, 2);

    expect(dealt).toBe(true);
    const board = writtenBoard();
    expect(board).not.toBeNull();
    expect(board!.data.dayIndex).toBe(2);
    expect(board!.data.easyMixRatio).toBe(0.25);
    expect(board!.data.cells).toHaveLength(25);
    // The pool is sourced ONLY from snapshotItemIds — the live `status: active`
    // getDocs query is never used by the deal path.
    expect(H.getDocs).not.toHaveBeenCalled();
    // Every non-free cell id came from the snapshot.
    const nonFree = board!.data.cells.filter((c) => !c.free).map((c) => c.itemId);
    for (const id of nonFree) expect(ids).toContain(id);
  });

  it('withholds explicit snapshot Prompts until the 18+ posture is published', async () => {
    const ids = seedPool(60);
    for (const [i, id] of ids.entries()) {
      H.itemsById.set(id, { ...H.itemsById.get(id), spicy: i >= 24 });
    }
    setActiveAdultContent(false);
    H.event = {
      days: daysWith(mkDay({ index: 2, unlockAt: PAST, snapshotItemIds: ids })),
      settings: { spicyRatio: 0.4 },
    };

    await expect(dealDayCard(U, 2)).resolves.toBe(true);
    const dealt = writtenBoard()!.data.cells
      .filter((cell) => !cell.free)
      .map((cell) => cell.itemId);
    expect(dealt).toHaveLength(24);
    expect(dealt.every((id) => id != null && ids.indexOf(id) < 24)).toBe(true);
  });

  it('is a no-op when a Day Card already exists for this Player+Day (never re-deals)', async () => {
    const ids = seedPool(30);
    H.event = { days: daysWith(mkDay({ index: 2, unlockAt: PAST, snapshotItemIds: ids })), settings: {} };
    // Pre-existing Day-2 board for this uid.
    H.dayBoards.set(2, { uid: U.uid, cells: [] });

    const dealt = await dealDayCard(U, 2);

    expect(dealt).toBe(false);
    expect(writtenBoard()).toBeNull();
  });

  it('refuses the write if the Day snapshot changes before the transactional commit', async () => {
    const originalIds = seedPool(30);
    const changedIds = [...originalIds, 'late-embark'];
    H.itemsById.set('late-embark', {
      text: 'late embark',
      isFreeSpace: false,
      status: 'active',
      spicy: false,
      pool: 'embark',
      reportCount: 0,
    });
    H.event = {
      days: daysWith(mkDay({ index: 2, unlockAt: PAST, snapshotItemIds: originalIds })),
      settings: { spicyRatio: 0.4 },
    };
    H.txGet.mockImplementation((ref: { args?: unknown[] }) => {
      const a = (ref.args ?? []).filter((x): x is string => typeof x === 'string');
      if (a.length === 2 && a[0] === 'events') {
        H.event = {
          days: daysWith(mkDay({ index: 2, unlockAt: PAST, snapshotItemIds: changedIds })),
          settings: { spicyRatio: 0.4 },
        };
      }
    });

    const dealt = await dealDayCard(U, 2);

    expect(dealt).toBe(false);
    expect(writtenBoard()).toBeNull();
  });

  it('excludes Prompts already on the Player’s earlier Day Cards (no repeats across the cruise)', async () => {
    // A 50-item snapshot; earlier Days 0 and 1 already used p0..p23. After
    // exclusion 26 remain (>= MIN_POOL), so the exclusion holds and none of the
    // 24 excluded ids may reappear on the Day-2 card.
    const ids = seedPool(50);
    const usedIds = ids.slice(0, 24);
    const usedCells: Cell[] = usedIds.map((id, i) => ({
      index: i,
      itemId: id,
      text: id,
      free: false,
      marked: false,
      markedAt: null,
    }));
    H.dayBoards.set(0, { uid: U.uid, cells: usedCells });
    H.dayBoards.set(1, { uid: U.uid, cells: usedCells });
    H.event = {
      days: [
        mkDay({ index: 0, unlockAt: PAST, snapshotItemIds: ids }),
        mkDay({ index: 1, unlockAt: PAST, snapshotItemIds: ids }),
        mkDay({ index: 2, unlockAt: PAST, snapshotItemIds: ids }),
      ],
      settings: { spicyRatio: 0.4 },
    };

    const dealt = await dealDayCard(U, 2);

    expect(dealt).toBe(true);
    const board = writtenBoard();
    const nonFree = board!.data.cells.filter((c) => !c.free).map((c) => c.itemId as string);
    for (const id of nonFree) expect(usedIds).not.toContain(id);
  });

  it('excludes Prompts from a LATER Day Card already dealt (out-of-order mid-cruise open)', async () => {
    // A mid-cruise joiner opens the latest unlocked Day (2) first, then opens an
    // EARLIER Day (1). The Day-1 deal must still exclude the Prompts already on
    // the Day-2 card — the no-repeat exclusion spans ALL of the Player's Day
    // Cards, not just lower indexes. On the old lower-index-only read, dealing
    // Day 1 only saw Day 0 and could repeat Day 2's Prompts.
    const ids = seedPool(50);
    const usedIds = ids.slice(0, 24);
    const usedCells: Cell[] = usedIds.map((id, i) => ({
      index: i,
      itemId: id,
      text: id,
      free: false,
      marked: false,
      markedAt: null,
    }));
    // Only the LATER Day (2) has a card so far; Day 1 is being dealt now.
    H.dayBoards.set(2, { uid: U.uid, cells: usedCells });
    H.event = {
      days: [
        mkDay({ index: 0, unlockAt: PAST, snapshotItemIds: ids }),
        mkDay({ index: 1, unlockAt: PAST, snapshotItemIds: ids }),
        mkDay({ index: 2, unlockAt: PAST, snapshotItemIds: ids }),
      ],
      settings: { spicyRatio: 0.4 },
    };

    const dealt = await dealDayCard(U, 1);

    expect(dealt).toBe(true);
    const board = writtenBoard();
    const nonFree = board!.data.cells.filter((c) => !c.free).map((c) => c.itemId as string);
    for (const id of nonFree) expect(usedIds).not.toContain(id);
  });

  it('deals an all-tame tutorial Day unstratified without spicy-ratio starvation', async () => {
    const ids = seedPool(30, 'embark');
    H.event = {
      days: daysWith(mkDay({ index: 2, pool: 'embark', tutorial: true, unlockAt: PAST, snapshotItemIds: ids })),
      // A stray spicyRatio must NOT be forced against the all-tame tutorial pool.
      settings: { spicyRatio: 0.4 },
    };

    const dealt = await dealDayCard(U, 2);

    expect(dealt).toBe(true);
    const board = writtenBoard();
    expect(board!.data.cells.filter((c) => !c.free)).toHaveLength(24);
  });
});
