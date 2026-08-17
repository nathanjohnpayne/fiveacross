import { describe, it, expect, vi, beforeEach } from 'vitest';

// specs/community-prompt-targeting.md (#557) — the client half: the pure
// targeting decisions, the submission that records an intended Day, and the
// approval that routes a Prompt to it (rolling forward past a closed Day, and
// retaining rather than dropping a Prompt with nowhere left to go).
//
// The snapshot half — which Prompts a Day actually freezes — is pinned in
// tests/functions/community-prompt-targeting-snapshot.test.ts, and the write
// permissions in tests/rules/community-prompt-targeting.test.ts. No emulator
// here: these are pure decisions plus "what payload did the write receive",
// mirroring src/data/api.test.ts's mocking shape.

// `eventRef()`/`itemsCol()` attach converters, so the stand-in refs have to
// answer `withConverter` — they simply return themselves, since these tests read
// the raw payloads the writes receive rather than converted docs.
type Ref = {
  __kind: 'doc' | 'collection';
  id?: string;
  path: string;
  withConverter: () => Ref;
};

const { addDocMock, updateMock, eventDataMock, getDocMock } = vi.hoisted(() => ({
  addDocMock: vi.fn((..._args: unknown[]) => Promise.resolve({ id: 'new-item' })),
  updateMock: vi.fn(),
  eventDataMock: vi.fn((): Record<string, unknown> | undefined => ({ days: [] })),
  getDocMock: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026', functions: {} }));
vi.mock('firebase/functions', () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  const snap = () => {
    const data = eventDataMock();
    return { exists: () => data !== undefined, data: () => data };
  };
  return {
    ...actual,
    collection: (_db: unknown, ...segments: string[]): Ref => {
      const ref: Ref = {
        __kind: 'collection',
        path: segments.join('/'),
        withConverter: () => ref,
      };
      return ref;
    },
    doc: (_a: unknown, ...rest: string[]): Ref => {
      const ref: Ref = {
        __kind: 'doc',
        id: rest[rest.length - 1],
        path: rest.join('/'),
        withConverter: () => ref,
      };
      return ref;
    },
    addDoc: (...args: unknown[]) => addDocMock(...args),
    getDoc: (...args: unknown[]) => {
      getDocMock(...args);
      return Promise.resolve(snap());
    },
    // The transaction seam approval routing depends on: the callback reads the
    // Event through `tx.get` (the schedule read set) and writes only items.
    runTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: () => Promise.resolve(snap()),
        update: (ref: Ref, data: unknown) => updateMock(ref.path, data),
      }),
  };
});

import {
  isDayTargetable,
  targetableDays,
  defaultTargetDayIndex,
  routeApprovalToDay,
  isUsableTarget,
  type TargetableDay,
} from './communityPrompts';
import { addItem } from './api';
import { approveItems, approveItem, bulkApproveItems } from './admin';

const NOW = 1_000_000;
const HOUR = 3_600_000;

/** A Day that is still ahead of its unlock and unstamped — i.e. targetable. */
const openDay = (index: number, over: Partial<TargetableDay> = {}): TargetableDay => ({
  index,
  unlockAt: NOW + (index + 1) * HOUR,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  eventDataMock.mockReturnValue({ days: [] });
});

describe('isDayTargetable — which Days can still take a Community Prompt', () => {
  it('accepts a Day that is unstamped and still ahead of its unlock', () => {
    expect(isDayTargetable(openDay(3), NOW)).toBe(true);
  });

  it('rejects a Day that has already frozen its snapshot', () => {
    expect(isDayTargetable(openDay(3, { snapshotItemIds: ['a'] }), NOW)).toBe(false);
  });

  it('rejects a Day frozen with an EMPTY snapshot — [] is a real stamp, not "unstamped"', () => {
    // Mirrors isDueForSnapshot's idempotency rule: an empty array is a Day whose
    // pool held nothing at unlock, and it is closed just like any other.
    expect(isDayTargetable(openDay(3, { snapshotItemIds: [] }), NOW)).toBe(false);
  });

  it('rejects a Day whose unlock has passed but which the scheduler has not stamped YET', () => {
    // The cutoff, not the stamp, is the bar. activeSnapshotIds filters as-of
    // day.unlockAt, so a Prompt approved after that instant would be dropped at
    // freeze time — calling this Day targetable would promise a placement that
    // silently never happens.
    expect(isDayTargetable({ index: 3, unlockAt: NOW - 1 }, NOW)).toBe(false);
  });

  it('rejects the unlockAt: 0 "open from the start" sentinel Day', () => {
    expect(isDayTargetable({ index: 0, unlockAt: 0 }, NOW)).toBe(false);
  });
});

describe('defaultTargetDayIndex — "put it on tomorrow\'s card"', () => {
  it('is the earliest Day that can still take one', () => {
    const days = [
      { index: 0, unlockAt: NOW - HOUR, snapshotItemIds: ['x'] },
      openDay(1),
      openDay(2),
    ];
    expect(defaultTargetDayIndex(days, NOW)).toBe(1);
  });

  it('skips a later Day that has somehow already frozen', () => {
    const days = [openDay(1, { snapshotItemIds: [] }), openDay(2)];
    expect(defaultTargetDayIndex(days, NOW)).toBe(2);
  });

  it('is null for a schedule-less Event, and null once every Day has gone', () => {
    expect(defaultTargetDayIndex([], NOW)).toBeNull();
    expect(defaultTargetDayIndex([{ index: 0, unlockAt: NOW - HOUR }], NOW)).toBeNull();
  });

  it('orders by index, not by array position', () => {
    expect(defaultTargetDayIndex([openDay(4), openDay(2), openDay(3)], NOW)).toBe(2);
  });
});

describe('routeApprovalToDay — approval routing and roll-forward', () => {
  const schedule = () => [
    { index: 0, unlockAt: NOW - 2 * HOUR, snapshotItemIds: ['a'] },
    { index: 1, unlockAt: NOW - HOUR, snapshotItemIds: [] },
    openDay(2),
    openDay(3),
  ];

  it('keeps the intended Day when it is still open', () => {
    expect(routeApprovalToDay(schedule(), 2, NOW)).toBe(2);
  });

  it('rolls FORWARD to the next open Day when the intended Day has closed', () => {
    expect(routeApprovalToDay(schedule(), 1, NOW)).toBe(2);
  });

  it('rolls past several closed Days to the first that is open', () => {
    expect(routeApprovalToDay(schedule(), 0, NOW)).toBe(2);
  });

  it('never rolls BACKWARD onto an earlier Day', () => {
    // A Prompt written for Day 5 must not be dealt onto Day 3, even though Day 3
    // is still open — rolling back would place it somewhere it was never meant.
    const days = [openDay(3), { index: 5, unlockAt: NOW - HOUR }];
    expect(routeApprovalToDay(days, 5, NOW)).toBeNull();
  });

  it('returns null — retained — when no Day remains', () => {
    expect(routeApprovalToDay(schedule(), 4, NOW)).toBeNull();
    expect(routeApprovalToDay([], 1, NOW)).toBeNull();
  });
});

describe('isUsableTarget — a malformed target is not a target', () => {
  it('accepts a non-negative integer, including 0', () => {
    expect(isUsableTarget(0)).toBe(true);
    expect(isUsableTarget(7)).toBe(true);
  });

  it('rejects absent, negative, fractional, NaN and non-numeric values', () => {
    for (const bad of [undefined, null, -1, 1.5, Number.NaN, '2', {}]) {
      expect(isUsableTarget(bad)).toBe(false);
    }
  });
});

describe('addItem — a submission records the Day it is meant for', () => {
  const payload = () => (addDocMock.mock.calls[0] as [Ref, Record<string, unknown>])[1];
  // addItem reads the real clock, so these fixtures are wall-clock relative.
  const past = (index: number) => ({ index, unlockAt: Date.now() - HOUR });
  const future = (index: number) => ({ index, unlockAt: Date.now() + (index + 1) * HOUR });

  it('stamps the earliest still-open Day when no target is given', async () => {
    eventDataMock.mockReturnValue({ days: [past(0), future(1)] });
    await addItem('u1', 'Wore Crocs to dinner', false);
    expect(payload()).toMatchObject({ status: 'pending', pool: 'main', targetDayIndex: 1 });
  });

  it('honours an explicit target (the Day-picker seam, #559)', async () => {
    eventDataMock.mockReturnValue({ days: [future(1), future(2)] });
    await addItem('u1', 'Karaoke disaster', false, 2);
    expect(payload()).toMatchObject({ targetDayIndex: 2 });
  });

  it('OMITS the field entirely when no Day can take one — the untargeted contract', async () => {
    // Absent, not null: absent is what every pre-#557 Prompt already is, so the
    // snapshot filter needs no third state.
    eventDataMock.mockReturnValue({ days: [past(0)] });
    await addItem('u1', 'Too late for this one', false);
    expect(payload()).not.toHaveProperty('targetDayIndex');
  });

  it('still submits when the Event has no schedule at all', async () => {
    eventDataMock.mockReturnValue({});
    await addItem('u1', 'Legacy event prompt', false);
    expect(addDocMock).toHaveBeenCalledTimes(1);
    expect(payload()).not.toHaveProperty('targetDayIndex');
  });

  it('still submits when the schedule read FAILS — targeting is best-effort', async () => {
    // Losing the targeting on one suggestion is a far smaller harm than
    // refusing to accept it.
    eventDataMock.mockImplementation(() => {
      throw new Error('offline');
    });
    await addItem('u1', 'Read failed', false);
    expect(addDocMock).toHaveBeenCalledTimes(1);
    expect(payload()).not.toHaveProperty('targetDayIndex');
  });
});

describe('approveItems — routing an approval into one Day', () => {
  const written = () => updateMock.mock.calls.map(([path, data]) => ({ path, data }));

  beforeEach(() => {
    eventDataMock.mockReturnValue({
      days: [
        { index: 0, unlockAt: NOW - 2 * HOUR, snapshotItemIds: ['a'] },
        { index: 1, unlockAt: NOW - HOUR, snapshotItemIds: [] },
        { index: 2, unlockAt: Date.now() + 10 * HOUR },
        { index: 3, unlockAt: Date.now() + 20 * HOUR },
      ],
    });
  });

  it('approves a Prompt onto the Day it was submitted for', async () => {
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 2 }], 'admin-uid');
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: 2, retained: false }]);
    expect(written()[0].data).toMatchObject({
      status: 'active',
      approvedBy: 'admin-uid',
      targetDayIndex: 2,
    });
  });

  it('rolls a Prompt approved after its Day closed forward to the next open Day', async () => {
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 1 }], 'admin-uid');
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: 2, retained: false }]);
    expect(written()[0].data).toMatchObject({ status: 'active', targetDayIndex: 2 });
  });

  it('RETAINS a Prompt with nowhere left to go, keeping its original target', async () => {
    // Never dropped, never deleted, and never re-aimed at a Day that has dealt:
    // the unreachable target IS the retention, and retainedAt makes it legible.
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 9 }], 'admin-uid');
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: null, retained: true }]);
    const { data } = written()[0];
    expect(data).toMatchObject({ status: 'active', approvedBy: 'admin-uid' });
    expect(data).toHaveProperty('retainedAt');
    expect(data).not.toHaveProperty('targetDayIndex');
  });

  it('leaves an UNTARGETED Prompt untargeted — approval invents no Day', async () => {
    // The organiser pool and every pre-#557 row: eligible for every Day, and
    // narrowing it to one would change behaviour nobody asked to change.
    const placements = await approveItems([{ id: 'legacy' }], 'admin-uid');
    expect(placements).toEqual([{ itemId: 'legacy', dayIndex: null, retained: false }]);
    const { data } = written()[0];
    expect(data).toEqual({
      status: 'active',
      approvedBy: 'admin-uid',
      approvedAt: expect.any(Number),
    });
  });

  it('treats a malformed target as untargeted-and-unroutable rather than re-aiming it', async () => {
    const placements = await approveItems(
      [{ id: 'bad', targetDayIndex: -3 as number }],
      'admin-uid',
    );
    expect(placements).toEqual([{ itemId: 'bad', dayIndex: null, retained: false }]);
    expect(written()[0].data).not.toHaveProperty('targetDayIndex');
  });

  it('never writes to a Day — an approval touches only the Prompt', async () => {
    // The hard invariant: an already-snapshotted or dealt Day is never mutated.
    // Routing is a write to the item, so no Day can be touched by construction.
    await approveItems([{ id: 'p1', targetDayIndex: 1 }], 'admin-uid');
    for (const { path } of written()) {
      expect(path).toMatch(/^events\/med-2026\/items\//);
    }
  });

  it('is a no-op for an empty list', async () => {
    expect(await approveItems([], 'admin-uid')).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('routes every row of a bulk approve, sharing ONE approvedAt instant', async () => {
    const placements = await bulkApproveItems(
      [
        { id: 'a', targetDayIndex: 2 },
        { id: 'b', targetDayIndex: 1 },
        { id: 'c', targetDayIndex: 9 },
        { id: 'd' },
      ],
      'admin-uid',
    );
    expect(placements).toEqual([
      { itemId: 'a', dayIndex: 2, retained: false },
      { itemId: 'b', dayIndex: 2, retained: false },
      { itemId: 'c', dayIndex: null, retained: true },
      { itemId: 'd', dayIndex: null, retained: false },
    ]);
    const stamps = new Set(written().map(({ data }) => (data as { approvedAt: number }).approvedAt));
    expect(stamps.size).toBe(1);
  });

  it('approveItem takes the queue ROW so a target can never be dropped', async () => {
    const placement = await approveItem({ id: 'p1', targetDayIndex: 3 }, 'admin-uid');
    expect(placement).toEqual({ itemId: 'p1', dayIndex: 3, retained: false });
  });
});
