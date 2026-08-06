import { describe, it, expect } from 'vitest';
import {
  activeSnapshotIds,
  snapshotPoolsFor,
  stampDaySnapshot,
  resnapshotDayIfNoBoards,
  UnlockPermissionError,
  type AdminFirestore,
  type EventLike,
  type DayLike,
} from '../../functions/src/unlockDay';

// specs/easy-mix.md — the scheduler / snapshot side of the easy mix. A main day's Day
// Snapshot now freezes BOTH the main pool AND the embark pool, so every deal and
// reshuffle inherits the mix from the one frozen list; the guarded re-snapshot is the
// deploy-race fallback. The pure `dealBoard` composition lives in
// src/game/easy-mix.test.ts. Every Firestore seam is an in-memory fake (no live runtime).

// --- In-memory Firestore fake (supports the boards subcollection this ticket reads) ---

interface StoredItem {
  id: string;
  status: string;
  pool?: string;
  isFreeSpace?: boolean;
  reportCount?: number;
  createdBy?: string;
  createdAt?: number;
  approvedAt?: number;
}

function makeDb(seed: {
  eventId: string;
  event: EventLike;
  items?: StoredItem[];
  /** Board docs keyed by dayIndex — presence is all `dayBoardCount` reads. */
  boards?: Record<number, Array<{ id: string }>>;
  beforeTransactionGet?: (path: string, boards: Record<number, Array<{ id: string }>>) => void;
}): AdminFirestore & { readEvent(): EventLike } {
  const docs: Record<string, Record<string, unknown> | undefined> = {
    [`events/${seed.eventId}`]: { ...seed.event } as Record<string, unknown>,
  };
  const items = [...(seed.items ?? [])];
  const boards = seed.boards ?? {};

  const snapshotOf = (path: string) => ({
    exists: docs[path] !== undefined,
    id: path.split('/').pop() as string,
    data: () => docs[path],
  });
  const docRef = (path: string) => ({
    __path: path,
    get: async () => snapshotOf(path),
    set: async (data: Record<string, unknown>) => {
      docs[path] = { ...data };
      return undefined;
    },
  });

  const collectionRef = (path: string) => {
    const filters: Array<[string, unknown]> = [];
    const boardsMatch = path.match(/\/days\/(\d+)\/boards$/);
    const backing = (): Array<Record<string, unknown>> => {
      if (path.endsWith('/items')) return items as Array<Record<string, unknown>>;
      if (boardsMatch) return (boards[Number(boardsMatch[1])] ?? []) as Array<Record<string, unknown>>;
      return [];
    };
    const api: {
      where(field: string, op: string, value: unknown): typeof api;
      get(): Promise<{ docs: Array<{ exists: boolean; id: string; data: () => Record<string, unknown> }> }>;
      doc(id?: string): ReturnType<typeof docRef>;
      __path: string;
    } = {
      __path: path,
      where(field, _op, value) {
        filters.push([field, value]);
        return api;
      },
      async get() {
        const rows = backing().filter((row) => filters.every(([f, v]) => row[f] === v));
        return { docs: rows.map((row) => ({ exists: true, id: row.id as string, data: () => row })) };
      },
      doc(id?: string) {
        return docRef(`${path}/${id}`);
      },
    };
    return api;
  };

  return {
    doc: (path: string) => docRef(path),
    collection: (path: string) => collectionRef(path) as never,
    async runTransaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const tx = {
        get: async (ref: { __path?: string; get(): Promise<unknown> }) => {
          seed.beforeTransactionGet?.(ref.__path ?? '', boards);
          return ref.get();
        },
        update: (_ref: unknown, data: Record<string, unknown>) => {
          const current = (docs[`events/${seed.eventId}`] ?? {}) as Record<string, unknown>;
          docs[`events/${seed.eventId}`] = { ...current, ...data };
        },
      };
      return fn(tx as never);
    },
    readEvent: () => docs[`events/${seed.eventId}`] as unknown as EventLike,
  };
}

const OPEN = { cutoff: Number.MAX_SAFE_INTEGER };
const D4_UNLOCK = Date.UTC(2026, 6, 18, 6, 0); // Day 4 08:00 Europe/Rome (summer UTC+2)

function daysWithMain(snapshotItemIds?: string[]): DayLike[] {
  return [{ index: 3, pool: 'main', unlockAt: D4_UNLOCK, snapshotItemIds }];
}

describe('snapshotPoolsFor — which pools a Day freezes', () => {
  it('a main day freezes BOTH the main and easy pools (canonical vocabulary out)', () => {
    expect(snapshotPoolsFor('main')).toEqual(['main', 'easy']);
  });
  it('a curated day freezes only its own pool — legacy persisted values normalize (#565)', () => {
    // BOTH live Events' Day docs still persist the legacy values; the returned
    // set is canonical either way, and activeSnapshotIds normalizes item pools
    // before matching, so the pair keeps working across the rename transition.
    expect(snapshotPoolsFor('embark')).toEqual(['easy']);
    expect(snapshotPoolsFor('farewell')).toEqual(['closing']);
    expect(snapshotPoolsFor('easy')).toEqual(['easy']);
    expect(snapshotPoolsFor('closing')).toEqual(['closing']);
  });
});

describe('activeSnapshotIds — the pools set drives which items are frozen', () => {
  const items = [
    { id: 'm1', pool: 'main' },
    { id: 'e1', pool: 'embark' },
    { id: 'legacy' }, // no pool → main
    { id: 'far', pool: 'farewell' },
  ];

  it('with pools main+embark, keeps main AND embark items (order preserved)', () => {
    expect(activeSnapshotIds(items, { pool: 'main', pools: ['main', 'embark'], ...OPEN })).toEqual([
      'm1',
      'e1',
      'legacy',
    ]);
  });

  it('falls back to the single `pool` when `pools` is absent (pre-easy-mix behavior)', () => {
    expect(activeSnapshotIds(items, { pool: 'main', ...OPEN })).toEqual(['m1', 'legacy']);
  });

  it('matches pools across MIXED vocabularies (#565) — a legacy-persisted item lands in a canonical set and vice versa', () => {
    // The live Events' items persist 'embark'/'farewell' while post-rename code
    // passes canonical sets (and a future flip could mint canonical item
    // values). Membership is normalized on BOTH sides, so a mixed Event never
    // silently splits one pool into two — the failure mode that would drop an
    // admin-added easy Prompt from the next morning's snapshot.
    const mixed = [
      { id: 'e-legacy', pool: 'embark' },
      { id: 'e-new', pool: 'easy' },
      { id: 'c-legacy', pool: 'farewell' },
      { id: 'c-new', pool: 'closing' },
      { id: 'm1', pool: 'main' },
    ];
    expect(activeSnapshotIds(mixed, { pool: 'main', pools: ['main', 'easy'], ...OPEN })).toEqual([
      'e-legacy',
      'e-new',
      'm1',
    ]);
    expect(activeSnapshotIds(mixed, { pool: 'embark', ...OPEN })).toEqual(['e-legacy', 'e-new']);
    expect(activeSnapshotIds(mixed, { pool: 'closing', ...OPEN })).toEqual(['c-legacy', 'c-new']);
  });
});

describe('stampDaySnapshot — a main Day freezes both pools', () => {
  it('includes active embark items alongside main in a main-day snapshot', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: daysWithMain(), settings: { easyMixRatio: 0.25 } },
      items: [
        { id: 'm1', status: 'active', pool: 'main' },
        { id: 'm2', status: 'active', pool: 'main' },
        { id: 'e1', status: 'active', pool: 'embark' },
        { id: 'e2', status: 'active', pool: 'embark' },
      ],
    });
    const result = await stampDaySnapshot(db, 'e1', 3, { now: () => D4_UNLOCK + 1 });
    expect(result).toBe('stamped');
    const day = db.readEvent().days!.find((d) => d.index === 3)!;
    expect(day.snapshotItemIds).toEqual(['m1', 'm2', 'e1', 'e2']);
    expect(day.snapshotEasyMixRatio).toBe(0.25);
  });
});

describe('resnapshotDayIfNoBoards — the guarded deploy-race fallback', () => {
  const admin = 'admin-1';
  const event = (snapshotItemIds?: string[]): EventLike => ({
    days: daysWithMain(snapshotItemIds),
    admins: [admin],
  });
  const items: StoredItem[] = [
    { id: 'm1', status: 'active', pool: 'main' },
    { id: 'e1', status: 'active', pool: 'embark' },
  ];

  it('OVERWRITES a main-only snapshot with both pools while zero boards exist', async () => {
    // Simulate the deploy race: the pre-easy-mix scheduler stamped main only.
    const db = makeDb({ eventId: 'e1', event: event(['m1']), items });
    const result = await resnapshotDayIfNoBoards(db, admin, 'e1', 3, { now: () => D4_UNLOCK + 1 });
    expect(result).toBe('resnapshotted');
    const day = db.readEvent().days!.find((d) => d.index === 3)!;
    expect(day.snapshotItemIds).toEqual(['m1', 'e1']); // both pools now
    expect(day.snapshotEasyMixRatio).toBe(0.5);
  });

  it('is DENIED once any board exists for the Day (has-boards)', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: event(['m1']),
      items,
      boards: { 3: [{ id: 'player-uid' }] }, // a card is already dealt
    });
    const result = await resnapshotDayIfNoBoards(db, admin, 'e1', 3, { now: () => D4_UNLOCK + 1 });
    expect(result).toBe('has-boards');
    const day = db.readEvent().days!.find((d) => d.index === 3)!;
    expect(day.snapshotItemIds).toEqual(['m1']); // untouched
  });

  it('is DENIED for already-unlocked Days 1-3 even while zero boards exist', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { ...event(['m1']), days: [{ index: 1, pool: 'main', unlockAt: D4_UNLOCK, snapshotItemIds: ['m1'] }] },
      items,
    });

    const result = await resnapshotDayIfNoBoards(db, admin, 'e1', 1, { now: () => D4_UNLOCK + 1 });

    expect(result).toBe('not-recoverable');
    const day = db.readEvent().days!.find((d) => d.index === 1)!;
    expect(day.snapshotItemIds).toEqual(['m1']); // untouched
    expect(day.snapshotEasyMixRatio).toBeUndefined();
  });

  it('is DENIED if a board appears before the transactional overwrite', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: event(['m1']),
      items,
      beforeTransactionGet(path, boards) {
        if (path === 'events/e1/days/3/boards') boards[3] = [{ id: 'racing-player' }];
      },
    });
    const result = await resnapshotDayIfNoBoards(db, admin, 'e1', 3, { now: () => D4_UNLOCK + 1 });
    expect(result).toBe('has-boards');
    const day = db.readEvent().days!.find((d) => d.index === 3)!;
    expect(day.snapshotItemIds).toEqual(['m1']); // untouched
  });

  it('rejects a non-admin caller', async () => {
    const db = makeDb({ eventId: 'e1', event: event(['m1']), items });
    await expect(resnapshotDayIfNoBoards(db, 'not-admin', 'e1', 3, { now: () => D4_UNLOCK + 1 })).rejects.toBeInstanceOf(
      UnlockPermissionError,
    );
  });

  it('is not-due before the Day has unlocked', async () => {
    const db = makeDb({ eventId: 'e1', event: event(['m1']), items });
    const result = await resnapshotDayIfNoBoards(db, admin, 'e1', 3, { now: () => D4_UNLOCK - 1 });
    expect(result).toBe('not-due');
  });

  it('returns no-day for an out-of-range Day', async () => {
    const db = makeDb({ eventId: 'e1', event: event(['m1']), items });
    const result = await resnapshotDayIfNoBoards(db, admin, 'e1', 99, { now: () => D4_UNLOCK + 1 });
    expect(result).toBe('no-day');
  });
});
