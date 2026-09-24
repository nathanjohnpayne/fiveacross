import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// specs/community-prompt-targeting.md (#557) — the client half: the pure
// targeting decisions, the submission that records an intended Day, and the
// `approveItems` wrapper that hands the queue rows to the `approvePrompts`
// callable (#1275).
//
// The approval ROUTING — rolling forward past a closed Day, retaining rather
// than dropping a Prompt with nowhere left to go, the stale guard, the #558
// classification and the Event-doc fence — runs on the server now and is pinned
// in tests/functions/approve-prompts.test.ts. The snapshot half — which Prompts
// a Day actually freezes — is pinned in
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

const {
  addDocMock,
  updateMock,
  eventDataMock,
  getDocMock,
  txGetMock,
  itemDocs,
  eventScope,
  transactionGate,
  httpsCallableMock,
  callableMock,
} =
  vi.hoisted(() => ({
  addDocMock: vi.fn((..._args: unknown[]) => Promise.resolve({ id: 'new-item' })),
  updateMock: vi.fn(),
  eventDataMock: vi.fn((): Record<string, unknown> | undefined => ({ days: [] })),
  getDocMock: vi.fn(),
  txGetMock: vi.fn(),
  // The AUTHORITATIVE item state `setItemSpicy`'s transaction reads (approval
  // itself no longer reads items on the client — it is the callable).
  itemDocs: {} as Record<string, Record<string, unknown> | undefined>,
  eventScope: { eventId: 'med-2026' },
  // The transaction lifecycle these tests need to stage: a callback that starts
  // late (`beforeCallback`), one Firestore RETRIES before committing
  // (`attempts`), and one whose transaction is abandoned after running
  // (`failWith`). The last two are the two ways a callback runs without its
  // write landing.
  transactionGate: {
    beforeCallback: null as Promise<void> | null,
    attempts: 1,
    failWith: null as Error | null,
  },
  // `httpsCallable(functions, name)` returns `callableMock`, whose resolved
  // `{ data }` is what the wrapper narrows. Both are reset per test.
  callableMock: vi.fn(),
  httpsCallableMock: vi.fn(),
}));

/** Seed the stored item a later `setItemSpicy` will read. */
const putItem = (id: string, data: Record<string, unknown> = {}) => {
  itemDocs[id] = { status: 'pending', ...data };
};

vi.mock('../firebase', () => ({
  db: {},
  functions: {},
  get EVENT_ID() {
    return eventScope.eventId;
  },
}));
// The approval wire (#1275): `approveItems` is an `httpsCallable` wrapper, so
// the seam under test is the callable factory and the callable it returns.
vi.mock('firebase/functions', () => ({
  httpsCallable: (...args: unknown[]) => httpsCallableMock(...args),
}));
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
    updateDoc: (ref: Ref, data: unknown) => {
      updateMock(ref.path, data);
      return Promise.resolve();
    },
    getDoc: (...args: unknown[]) => {
      getDocMock(...args);
      return Promise.resolve(snap());
    },
    // The transaction seam `setItemSpicy` depends on: the callback reads the
    // ITEM through `tx.get` (its pending-and-main guard's authoritative state)
    // and writes only that item.
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      if (transactionGate.beforeCallback) await transactionGate.beforeCallback;
      const tx = {
        get: (ref: Ref) => txGetMock(ref),
        update: (ref: Ref, data: unknown) => updateMock(ref.path, data),
      };
      let result: unknown;
      for (let attempt = 0; attempt < transactionGate.attempts; attempt += 1) {
        result = await fn(tx);
      }
      if (transactionGate.failWith) throw transactionGate.failWith;
      return result;
    },
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
import { approveItems, approveItem, bulkApproveItems, setItemSpicy, type ApprovableItem } from './admin';

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
  eventScope.eventId = 'med-2026';
  transactionGate.beforeCallback = null;
  transactionGate.attempts = 1;
  transactionGate.failWith = null;
  for (const id of Object.keys(itemDocs)) delete itemDocs[id];
  eventDataMock.mockReturnValue({ days: [] });
  httpsCallableMock.mockImplementation(() => callableMock);
  txGetMock.mockImplementation((ref: Ref) => {
    const at = ref.path.indexOf('/items/');
    const data =
      at < 0 ? eventDataMock() : itemDocs[ref.path.slice(at + '/items/'.length)];
    return Promise.resolve({ exists: () => data !== undefined, data: () => data });
  });
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

  // Codex P1 (PR #812): a curated Day freezes only its OWN pool, and every
  // Community Prompt is a main-pool submission. Aiming one at a Tutorial or
  // closing Day would pass the snapshot's Day and cutoff checks and then be
  // dropped by its POOL filter — a placement promised and silently not kept.
  it('rejects a Day that does NOT deal the main pool', () => {
    expect(isDayTargetable(openDay(3, { pool: 'closing' }), NOW)).toBe(false);
    expect(isDayTargetable(openDay(3, { pool: 'easy' }), NOW)).toBe(false);
  });

  it('rejects a curated Day persisting the LEGACY pool spellings too', () => {
    expect(isDayTargetable(openDay(3, { pool: 'farewell' }), NOW)).toBe(false);
    expect(isDayTargetable(openDay(3, { pool: 'embark' }), NOW)).toBe(false);
  });

  it('accepts a main Day, and a legacy Day with no pool at all (reads as main)', () => {
    expect(isDayTargetable(openDay(3, { pool: 'main' }), NOW)).toBe(true);
    expect(isDayTargetable(openDay(3), NOW)).toBe(true);
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

  it('rolls PAST a curated Day to the next Day that deals the main pool', () => {
    const days = [
      { index: 1, unlockAt: NOW - HOUR, pool: 'main' as const },
      openDay(2, { pool: 'closing' }),
      openDay(3, { pool: 'main' }),
    ];
    expect(routeApprovalToDay(days, 1, NOW)).toBe(3);
  });

  it('RETAINS rather than promising a closing Day when only curated Days remain', () => {
    // The med-2026 shape: a suggestion made in the run-up to the closing Day has
    // nowhere left that can actually deal it, so it is retained for the recap —
    // not reported as scheduled for a Day whose snapshot would drop it.
    const days = [
      { index: 8, unlockAt: NOW - HOUR, pool: 'main' as const },
      openDay(9, { pool: 'farewell' }),
    ];
    expect(routeApprovalToDay(days, 8, NOW)).toBeNull();
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
  const past = (index: number) => ({ index, unlockAt: Date.now() - HOUR, pool: 'main' });
  const future = (index: number) => ({
    index,
    unlockAt: Date.now() + (index + 1) * HOUR,
    pool: 'main',
  });

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

  it('REJECTS an explicit malformed target rather than writing an untargeted row', async () => {
    // An omitted argument means "resolve the default"; a present-but-malformed
    // one is a caller bug. Dropping it would write an UNTARGETED row — every
    // future main Day, the precise failure this feature exists to prevent,
    // arriving through the one path that is supposed to SET the target (Phase 4b
    // P1, PR #812). `NaN`, `-1` and `1.5` are all valid TypeScript `number`s, so
    // only a runtime check catches them.
    eventDataMock.mockReturnValue({ days: [future(1), future(2)] });
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(addItem('u1', 'Malformed target', false, bad)).rejects.toThrow(
        /targetDayIndex/,
      );
    }
    expect(addDocMock).not.toHaveBeenCalled();
  });

  it('OMITS the field entirely when no Day can take one — the untargeted contract', async () => {
    // Absent, not null: absent is what every pre-#557 Prompt already is, so the
    // snapshot filter needs no third state.
    eventDataMock.mockReturnValue({ days: [past(0)] });
    await addItem('u1', 'Too late for this one', false);
    expect(payload()).not.toHaveProperty('targetDayIndex');
  });

  it('OMITS the field when only a curated Day remains — no false promise', async () => {
    eventDataMock.mockReturnValue({
      days: [past(0), { index: 1, unlockAt: Date.now() + HOUR, pool: 'farewell' }],
    });
    await addItem('u1', 'Only the closing Day left', false);
    expect(payload()).not.toHaveProperty('targetDayIndex');
  });

  it('still submits when the Event has no schedule at all', async () => {
    eventDataMock.mockReturnValue({});
    await addItem('u1', 'Legacy event prompt', false);
    expect(addDocMock).toHaveBeenCalledTimes(1);
    expect(payload()).not.toHaveProperty('targetDayIndex');
  });

  it('REFUSES to submit when the schedule read fails — an unknown Day is not every Day', async () => {
    // This was once swallowed as best-effort, on the reasoning that losing the
    // targeting mattered less than refusing a suggestion. That was wrong: an
    // untargeted row does not lose anything, it means EVERY future main Day, so
    // a transient offline blip would have put one suggestion on every card of
    // the cruise (Phase 4b P1, PR #812). Failing closed costs the player a retry
    // with their text still in the box — `ItemPool` only clears the field after
    // a successful write.
    eventDataMock.mockImplementation(() => {
      throw new Error('offline');
    });
    await expect(addItem('u1', 'Read failed', false)).rejects.toThrow('offline');
    expect(addDocMock).not.toHaveBeenCalled();
  });
});

describe('approveItems — a thin approvePrompts wrapper (#1275)', () => {
  // The routing, stale-guard, classification and fence cases that used to live
  // here moved with the transaction to tests/functions/approve-prompts.test.ts.
  // What is left to pin on the client is the WIRE: what the wrapper sends, what
  // it trusts back, and that it adds nothing of its own.
  const placed = (itemId: string, dayIndex: number | null = 2) => ({
    itemId,
    dayIndex,
    retained: false,
    outcome: 'placed',
  });
  const respondWith = (placements: unknown) => {
    callableMock.mockResolvedValue({ data: { placements } });
  };

  it('sends the queue rows to the approvePrompts callable and returns its placements', async () => {
    respondWith([placed('p1')]);
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 2, pool: 'easy', spicy: false }], 'admin-uid');
    expect(httpsCallableMock).toHaveBeenCalledWith({}, 'approvePrompts');
    expect(callableMock).toHaveBeenCalledWith({
      eventId: 'med-2026',
      items: [{ id: 'p1', pool: 'easy', spicy: false }],
    });
    expect(placements).toEqual([placed('p1')]);
    // No client write of any kind: the server owns the transition.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('sends ONLY eventId and each row id/pool/spicy — never the admin uid, a clock, or the rest of the row', async () => {
    respondWith([placed('p1')]);
    await approveItems(
      [
        {
          id: 'p1',
          targetDayIndex: 4,
          text: 'never leaves the client',
          createdBy: 'player',
          approvedAt: 0,
          retainedAt: 5,
        } as unknown as ApprovableItem,
      ],
      'admin-uid',
    );
    const [payload] = callableMock.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toStrictEqual({ eventId: 'med-2026', items: [{ id: 'p1' }] });
    expect(JSON.stringify(payload)).not.toContain('admin-uid');
  });

  it('captures eventId when the call starts, so a mid-flight Event switch cannot re-aim it', async () => {
    let finish!: (value: { data: unknown }) => void;
    callableMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    eventScope.eventId = 'event-a';
    const pending = approveItems([{ id: 'p1' }], 'admin-uid');
    eventScope.eventId = 'event-b';
    finish({ data: { placements: [placed('p1')] } });
    await pending;
    expect(callableMock.mock.calls[0][0]).toMatchObject({ eventId: 'event-a' });
  });

  it('honours an explicit eventId argument', async () => {
    respondWith([placed('p1')]);
    await approveItems([{ id: 'p1' }], 'admin-uid', 'pacific-2026');
    expect(callableMock.mock.calls[0][0]).toMatchObject({ eventId: 'pacific-2026' });
  });

  it('is a no-op for an empty list — no callable is even constructed', async () => {
    expect(await approveItems([], 'admin-uid')).toEqual([]);
    expect(httpsCallableMock).not.toHaveBeenCalled();
    expect(callableMock).not.toHaveBeenCalled();
  });

  it('approveItem takes the queue ROW and returns the first placement', async () => {
    respondWith([placed('p1', 3)]);
    const placement = await approveItem({ id: 'p1', targetDayIndex: 3 }, 'admin-uid');
    expect(placement).toEqual(placed('p1', 3));
    expect(callableMock.mock.calls[0][0]).toMatchObject({ items: [{ id: 'p1' }] });
  });

  it('bulkApproveItems sends every row in ONE call and returns every placement in order', async () => {
    respondWith([
      placed('a'),
      placed('b'),
      { itemId: 'c', dayIndex: null, retained: true, outcome: 'retained' },
      {
        itemId: 'd',
        dayIndex: null,
        retained: false,
        outcome: 'malformed',
        reason: 'Community Prompt approval requires an easy or exploratory classification.',
      },
    ]);
    const placements = await bulkApproveItems(
      [
        { id: 'a', pool: 'easy' },
        { id: 'b', pool: 'main', spicy: true },
        { id: 'c', pool: 'easy' },
        { id: 'd', pool: 'closing' },
      ],
      'admin-uid',
    );
    expect(callableMock).toHaveBeenCalledTimes(1);
    expect(callableMock.mock.calls[0][0]).toStrictEqual({
      eventId: 'med-2026',
      items: [
        { id: 'a', pool: 'easy' },
        { id: 'b', pool: 'main', spicy: true },
        { id: 'c', pool: 'easy' },
        { id: 'd', pool: 'closing' },
      ],
    });
    expect(placements.map((p) => p.outcome)).toEqual(['placed', 'placed', 'retained', 'malformed']);
    expect(placements[3].reason).toMatch(/easy or exploratory/);
  });

  it('passes a callable rejection through as the SAME error, so the queue shows the server message', async () => {
    // A FunctionsError is an Error whose `message` is the fixed server string
    // (permission-denied for a stale bundle, failed-precondition on a closed
    // Event, aborted on contention); AsyncButton surfaces `error.message`.
    const denied = Object.assign(new Error('Only an admin of this Event can approve its Prompts.'), {
      code: 'functions/permission-denied',
    });
    callableMock.mockRejectedValue(denied);
    await expect(approveItems([{ id: 'p1' }], 'admin-uid')).rejects.toBe(denied);
  });

  it.each([
    ['no data', undefined],
    ['no placements', {}],
    ['placements that are not an array', { placements: { itemId: 'p1' } }],
    ['too few placements', { placements: [] }],
    ['too many placements', { placements: [placed('p1'), placed('p2')] }],
    ['a non-object placement', { placements: ['p1'] }],
    ['a missing itemId', { placements: [{ dayIndex: 2, retained: false, outcome: 'placed' }] }],
    ['a string dayIndex', { placements: [{ itemId: 'p1', dayIndex: '2', retained: false, outcome: 'placed' }] }],
    ['a non-boolean retained', { placements: [{ itemId: 'p1', dayIndex: 2, retained: 'no', outcome: 'placed' }] }],
    ['an unknown outcome', { placements: [{ itemId: 'p1', dayIndex: 2, retained: false, outcome: 'approved' }] }],
    ['a non-string reason', { placements: [{ itemId: 'p1', dayIndex: null, retained: false, outcome: 'malformed', reason: 7 }] }],
  ])('throws a fixed error on a response with %s rather than announcing it', async (_label, data) => {
    callableMock.mockResolvedValue({ data });
    await expect(approveItems([{ id: 'p1' }], 'admin-uid')).rejects.toThrow(
      'approvePrompts returned an unexpected response.',
    );
  });

  it('accepts a null dayIndex and an absent reason, and keeps a string reason', async () => {
    respondWith([
      { itemId: 'p1', dayIndex: null, retained: true, outcome: 'retained' },
      { itemId: 'p2', dayIndex: null, retained: false, outcome: 'malformed', reason: 'why' },
    ]);
    const placements = await approveItems([{ id: 'p1' }, { id: 'p2' }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'p1', dayIndex: null, retained: true, outcome: 'retained' },
      { itemId: 'p2', dayIndex: null, retained: false, outcome: 'malformed', reason: 'why' },
    ]);
    expect(placements[0]).not.toHaveProperty('reason');
  });
});

describe('setItemSpicy — approval-race fence (#558)', () => {
  it('refuses a late stale toggle after Easy approval has made the row active', async () => {
    putItem('p1', {
      status: 'active',
      pool: 'embark',
      spicy: false,
      targetDayIndex: 2,
    });

    const revision = await setItemSpicy('p1', true);

    expect(updateMock).not.toHaveBeenCalled();
    expect(revision).toBeNull();
  });

  it('still lets the queue correct a pending exploratory Prompt', async () => {
    putItem('p1', {
      status: 'pending',
      pool: 'main',
      spicy: false,
      targetDayIndex: 2,
    });

    const revision = await setItemSpicy('p1', true);

    expect(updateMock).toHaveBeenCalledWith('events/med-2026/items/p1', {
      spicy: true,
      spicyRevision: 1,
    });
    expect(revision).toBe(1);
  });

  it('increments the authoritative correction revision in the same transaction', async () => {
    putItem('p1', {
      status: 'pending',
      pool: 'main',
      spicy: true,
      spicyRevision: 7,
    });

    const revision = await setItemSpicy('p1', false);

    expect(updateMock).toHaveBeenCalledWith('events/med-2026/items/p1', {
      spicy: false,
      spicyRevision: 8,
    });
    expect(revision).toBe(8);
  });

  // #1071: `spicyRevision` only ever reaches Firestore through this
  // transaction, one increment at a time, so a value that is STORED and outside
  // the contract is corrupted or hand-edited data. The correction must stay
  // writable, so the fence still restarts at 0 — but that silently re-bases the
  // acknowledgement the queue retires its optimistic overlay on, so it is said
  // out loud, naming the row and the SHAPE of the bad value (never the value,
  // never the row, which holds submitter prose). An ABSENT field is not that:
  // the field is optional, no create path writes it, and starting at 0 is the
  // ordinary opening state of every row — see the legacy/first-toggle case
  // below, which must stay silent.
  describe('an out-of-contract stored revision is logged, not swallowed', () => {
    // Scoped to this block: only these rows expect the warning, so capturing it
    // here keeps a stray warning from any other case visible.
    const spyOnWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warn: ReturnType<typeof spyOnWarn>;

    beforeEach(() => {
      warn = spyOnWarn();
    });

    afterEach(() => {
      warn.mockRestore();
    });

    const outOfContract: Array<[string, unknown, string]> = [
      ['negative', -1, 'negative'],
      ['NaN', Number.NaN, 'NaN'],
      ['fractional', 1.5, 'non-integer'],
      ['a string', '3', 'typeof string'],
    ];

    it.each(outOfContract)(
      'restarts the fence at 0 and warns once when the stored revision is %s',
      async (_label, stored, shape) => {
        putItem('p1', {
          status: 'pending',
          pool: 'main',
          spicy: false,
          spicyRevision: stored,
        });

        const revision = await setItemSpicy('p1', true);

        expect(revision).toBe(1);
        expect(updateMock).toHaveBeenCalledWith('events/med-2026/items/p1', {
          spicy: true,
          spicyRevision: 1,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`item p1 has an out-of-contract spicyRevision (${shape})`),
        );
      },
    );

    // Codex P2 on PR #1201. The restart is a fact about the write that
    // COMMITTED, so the line belongs after settlement rather than inside the
    // callback. Firestore re-runs this callback on contention — the very retry
    // `setItemSpicy` relies on to lose to an approval — and a callback that ran
    // twice is still one admin correcting one row once.
    it('warns ONCE for a correction whose callback Firestore retried before committing', async () => {
      putItem('p1', {
        status: 'pending',
        pool: 'main',
        spicy: false,
        spicyRevision: -1,
      });
      transactionGate.attempts = 2;

      await expect(setItemSpicy('p1', true)).resolves.toBe(1);

      expect(warn).toHaveBeenCalledTimes(1);
    });

    // The other half of the same rule: a callback can also run for a transaction
    // Firestore then abandons. Nothing was re-based, so there is nothing to say
    // — a warning here would report a corruption the queue never acted on.
    it('says nothing when the transaction runs the callback and then fails', async () => {
      putItem('p1', {
        status: 'pending',
        pool: 'main',
        spicy: false,
        spicyRevision: -1,
      });
      transactionGate.failWith = new Error('transaction aborted');

      await expect(setItemSpicy('p1', true)).rejects.toThrow('transaction aborted');

      expect(warn).not.toHaveBeenCalled();
    });

    // The two in-contract shapes, neither of which is a fault to report. The
    // absent case is the one that matters here: `spicyRevision` is optional and
    // written only by this transaction, so EVERY Prompt's first correction
    // arrives with no stored revision. Warning there would put the line on 100%
    // of first toggles and drown the corruption above in routine noise.
    const inContract: Array<[string, number | undefined, number]> = [
      ['a usable one', 4, 5],
      ['absent, as on a legacy row or any first toggle', undefined, 1],
    ];

    it.each(inContract)(
      'says nothing when the stored revision is %s',
      async (_label, stored, expected) => {
        putItem('p1', {
          status: 'pending',
          pool: 'main',
          spicy: false,
          spicyRevision: stored,
        });

        await expect(setItemSpicy('p1', true)).resolves.toBe(expected);
        expect(updateMock).toHaveBeenCalledWith('events/med-2026/items/p1', {
          spicy: true,
          spicyRevision: expected,
        });
        expect(warn).not.toHaveBeenCalled();
      },
    );
  });

  it('keeps a spicy correction in its acted Event when the transaction callback starts after A to B', async () => {
    putItem('p1', {
      status: 'pending',
      pool: 'main',
      spicy: false,
    });
    let releaseTransaction!: () => void;
    transactionGate.beforeCallback = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const correction = setItemSpicy('p1', true, 'med-2026');
    eventScope.eventId = 'pacific-2026';
    releaseTransaction();

    await expect(correction).resolves.toBe(1);
    expect(updateMock).toHaveBeenCalledWith('events/med-2026/items/p1', {
      spicy: true,
      spicyRevision: 1,
    });
  });
});
