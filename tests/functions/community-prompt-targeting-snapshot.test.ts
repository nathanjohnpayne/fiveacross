import { describe, it, expect } from 'vitest';
import {
  activeSnapshotIds,
  snapshotPoolsFor,
  stampDaySnapshot,
  type AdminFirestore,
  type EventLike,
  type DayLike,
} from '../../functions/src/unlockDay';

// specs/community-prompt-targeting.md (#557) — the snapshot side. A Community
// Prompt names the ONE Day it is meant for, and this is where that name decides
// what a Day freezes. The client half (submission, approval routing,
// roll-forward, retention) is pinned in
// src/data/community-prompt-targeting.test.ts and the write permissions in
// tests/rules/community-prompt-targeting.test.ts.
//
// Every Firestore seam is an in-memory fake (no live runtime), mirroring
// tests/functions/easy-mix-snapshot.test.ts.

interface StoredItem {
  id: string;
  status: string;
  pool?: string;
  createdAt?: number;
  approvedAt?: number;
  targetDayIndex?: unknown;
}

function makeDb(seed: {
  eventId: string;
  event: EventLike;
  items?: StoredItem[];
}): AdminFirestore & { readEvent(): EventLike } {
  const docs: Record<string, Record<string, unknown> | undefined> = {
    [`events/${seed.eventId}`]: { ...seed.event } as Record<string, unknown>,
  };
  const items = [...(seed.items ?? [])];

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
    const api = {
      __path: path,
      where(field: string, _op: string, value: unknown) {
        filters.push([field, value]);
        return api;
      },
      async get() {
        const backing = path.endsWith('/items')
          ? (items as unknown as Array<Record<string, unknown>>)
          : [];
        const rows = backing.filter((row) => filters.every(([f, v]) => row[f] === v));
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
        get: async (ref: { get(): Promise<unknown> }) => ref.get(),
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

const DAY3_UNLOCK = Date.UTC(2026, 6, 18, 6, 0);
const AFTER = DAY3_UNLOCK + 60_000;

/** The filter a main Day passes, with the Day-targeting context #557 adds. */
const mainDayFilter = (dayIndex: number) => ({
  pool: 'main',
  pools: snapshotPoolsFor('main'),
  cutoff: 0, // no cutoff — these cases isolate the targeting predicate
  dayIndex,
});

describe('activeSnapshotIds — Day targeting decides what a Day freezes (#557)', () => {
  const items = [
    { id: 'organiser', pool: 'main' }, // untargeted
    { id: 'for-day-3', pool: 'main', targetDayIndex: 3 },
    { id: 'for-day-4', pool: 'main', targetDayIndex: 4 },
    { id: 'easy-for-day-3', pool: 'embark', targetDayIndex: 3 },
  ];

  it('admits an untargeted Prompt to EVERY Day — the pre-#557 contract, unchanged', () => {
    for (const dayIndex of [0, 3, 4, 9]) {
      expect(activeSnapshotIds(items, mainDayFilter(dayIndex))).toContain('organiser');
    }
  });

  it('admits a targeted Prompt to its OWN Day', () => {
    expect(activeSnapshotIds(items, mainDayFilter(3))).toContain('for-day-3');
  });

  it('admits a targeted Prompt to NO other Day — the whole point of the ticket', () => {
    const day4 = activeSnapshotIds(items, mainDayFilter(4));
    expect(day4).not.toContain('for-day-3');
    expect(day4).toContain('for-day-4');
  });

  it('applies targeting across BOTH pools a main Day freezes (the easy-mix half too)', () => {
    expect(activeSnapshotIds(items, mainDayFilter(3))).toEqual([
      'organiser',
      'for-day-3',
      'easy-for-day-3',
    ]);
  });

  it('excludes a MALFORMED target from every Day rather than failing open to all of them', () => {
    // Deliberately against this module's usual fail-open posture: failing open
    // here would put an unresolvable Prompt on every card, which is the exact
    // bug being fixed. The Prompt is retained, not lost — it stays active and
    // admin-visible, just dealt nowhere.
    const bad = [
      { id: 'nan', pool: 'main', targetDayIndex: Number.NaN },
      { id: 'str', pool: 'main', targetDayIndex: '3' },
      { id: 'frac', pool: 'main', targetDayIndex: 3.5 },
    ];
    for (const dayIndex of [0, 3, 4]) {
      expect(activeSnapshotIds(bad, mainDayFilter(dayIndex))).toEqual([]);
    }
  });

  it('excludes an EXPLICIT null target — a stored null is a value, not an absence', () => {
    // Codex P2 (PR #812). The rules reject null on create, but the admin update
    // arm is deliberately unconstrained and an imported or repaired row can
    // carry one, so this path is reachable. Reading null as "absent" would put
    // that Prompt back on every Day.
    const withNull = [{ id: 'nulled', pool: 'main', targetDayIndex: null }];
    for (const dayIndex of [0, 3, 4]) {
      expect(activeSnapshotIds(withNull, mainDayFilter(dayIndex))).toEqual([]);
    }
  });

  it('excludes a NEGATIVE target even from a matching negative Day index', () => {
    // Phase 4b P2 (PR #812). `>= 0` is part of what well-formed MEANS here —
    // `isUsableTarget` and the rules' `validTargetDayIndex()` both say so — and
    // leaving it out of this mirror made the predicate admit -1 to a Day indexed
    // -1. Unreachable through today's schedule, but a mirror that only
    // accidentally agrees is one refactor away from disagreeing.
    const negative = [{ id: 'neg', pool: 'main', targetDayIndex: -1 }];
    expect(activeSnapshotIds(negative, mainDayFilter(-1))).toEqual([]);
    for (const dayIndex of [0, 3]) {
      expect(activeSnapshotIds(negative, mainDayFilter(dayIndex))).toEqual([]);
    }
  });

  it('excludes a RETAINED Prompt even from a Day its target now matches', () => {
    // Retention used to hold only because the target had become unreachable —
    // true of the schedule as it stood at approval, and false again the moment a
    // Day is added, repaired, or switched to deal the main pool. Any of those
    // would silently resurrect a Prompt the organiser was already told was
    // retained and dealt nowhere (Phase 4b P2, PR #812). The stored marker is
    // what binds now, so the recorded decision survives a schedule change.
    const retained = [{ id: 'kept', pool: 'main', targetDayIndex: 3, retainedAt: 123 }];
    expect(activeSnapshotIds(retained, mainDayFilter(3))).toEqual([]);
    // And an untargeted retained row is excluded from every Day too, rather than
    // falling through the absent-target branch onto all of them.
    const loose = [{ id: 'loose', pool: 'main', retainedAt: 123 }];
    for (const dayIndex of [0, 3, 4]) {
      expect(activeSnapshotIds(loose, mainDayFilter(dayIndex))).toEqual([]);
    }
  });

  it('applies NO targeting filter when the caller omits dayIndex (pre-#557 callers)', () => {
    const { dayIndex: _omitted, ...noTargeting } = mainDayFilter(3);
    expect(activeSnapshotIds(items, noTargeting)).toEqual([
      'organiser',
      'for-day-3',
      'for-day-4',
      'easy-for-day-3',
    ]);
  });

  it('targeting composes with the cutoff — a Prompt must pass BOTH', () => {
    const late = [
      { id: 'in-time', pool: 'main', targetDayIndex: 3, approvedAt: DAY3_UNLOCK - 1 },
      { id: 'too-late', pool: 'main', targetDayIndex: 3, approvedAt: DAY3_UNLOCK + 1 },
    ];
    expect(
      activeSnapshotIds(late, { ...mainDayFilter(3), cutoff: DAY3_UNLOCK }),
    ).toEqual(['in-time']);
  });
});

describe('stampDaySnapshot — the freeze honours targeting end to end', () => {
  const days = (): DayLike[] => [
    { index: 3, pool: 'main', unlockAt: DAY3_UNLOCK },
    { index: 4, pool: 'main', unlockAt: DAY3_UNLOCK + 86_400_000 },
  ];

  const seedItems = (): StoredItem[] => [
    { id: 'organiser', status: 'active', pool: 'main' },
    { id: 'community-3', status: 'active', pool: 'main', targetDayIndex: 3 },
    { id: 'community-4', status: 'active', pool: 'main', targetDayIndex: 4 },
    { id: 'still-pending', status: 'pending', pool: 'main', targetDayIndex: 3 },
  ];

  it("freezes only the Prompts aimed at this Day, plus the untargeted pool", async () => {
    const db = makeDb({ eventId: 'e1', event: { days: days() }, items: seedItems() });
    expect(await stampDaySnapshot(db, 'e1', 3, { now: () => AFTER })).toBe('stamped');
    const stamped = db.readEvent().days?.find((d) => d.index === 3);
    expect(stamped?.snapshotItemIds).toEqual(['organiser', 'community-3']);
  });

  it("a later Day's freeze never picks up the earlier Day's Community Prompt", async () => {
    const db = makeDb({ eventId: 'e1', event: { days: days() }, items: seedItems() });
    const day4Unlock = DAY3_UNLOCK + 86_400_000;
    expect(await stampDaySnapshot(db, 'e1', 4, { now: () => day4Unlock + 60_000 })).toBe('stamped');
    const stamped = db.readEvent().days?.find((d) => d.index === 4);
    expect(stamped?.snapshotItemIds).toEqual(['organiser', 'community-4']);
    expect(stamped?.snapshotItemIds).not.toContain('community-3');
  });

  it('leaves an ALREADY-STAMPED Day untouched — targeting never re-opens a frozen Day', async () => {
    // The hard invariant: an already-snapshotted or dealt Day is never mutated.
    const frozen: DayLike[] = [{ index: 3, pool: 'main', unlockAt: DAY3_UNLOCK, snapshotItemIds: ['old'] }];
    const db = makeDb({ eventId: 'e1', event: { days: frozen }, items: seedItems() });
    expect(await stampDaySnapshot(db, 'e1', 3, { now: () => AFTER })).toBe('already-stamped');
    expect(db.readEvent().days?.[0].snapshotItemIds).toEqual(['old']);
  });

  it('a Prompt retained past the last Day is frozen into NO snapshot and still exists', async () => {
    const retained: StoredItem[] = [
      { id: 'organiser', status: 'active', pool: 'main' },
      // Approved with nowhere to go: its target names a Day that has been and gone.
      { id: 'retained', status: 'active', pool: 'main', targetDayIndex: 0 },
    ];
    const db = makeDb({ eventId: 'e1', event: { days: days() }, items: retained });
    await stampDaySnapshot(db, 'e1', 3, { now: () => AFTER });
    await stampDaySnapshot(db, 'e1', 4, { now: () => DAY3_UNLOCK + 86_400_000 + 60_000 });
    for (const day of db.readEvent().days ?? []) {
      expect(day.snapshotItemIds).not.toContain('retained');
    }
    // Retained means kept, not deleted — the row is still in the pool for the
    // recap or a reusable pack.
    expect(retained.some((it) => it.id === 'retained')).toBe(true);
  });
});
