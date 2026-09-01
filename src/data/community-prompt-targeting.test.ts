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

const { addDocMock, updateMock, eventDataMock, getDocMock, itemDocs } = vi.hoisted(() => ({
  addDocMock: vi.fn((..._args: unknown[]) => Promise.resolve({ id: 'new-item' })),
  updateMock: vi.fn(),
  eventDataMock: vi.fn((): Record<string, unknown> | undefined => ({ days: [] })),
  getDocMock: vi.fn(),
  // The AUTHORITATIVE item state the approval transaction reads. Approval routes
  // on what is stored here, never on the queue row the caller passes — that is
  // the stale-approval guard, so these two can deliberately disagree in tests.
  itemDocs: {} as Record<string, Record<string, unknown> | undefined>,
}));

/** Seed the stored item a later `approveItems` will read. */
const putItem = (id: string, data: Record<string, unknown> = {}) => {
  itemDocs[id] = { status: 'pending', ...data };
};

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
    updateDoc: (ref: Ref, data: unknown) => {
      updateMock(ref.path, data);
      return Promise.resolve();
    },
    getDoc: (...args: unknown[]) => {
      getDocMock(...args);
      return Promise.resolve(snap());
    },
    // The transaction seam approval routing depends on: the callback reads the
    // Event through `tx.get` (the schedule read set), reads each ITEM through
    // `tx.get` (the stale guard's authoritative state) and writes only items.
    runTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: (ref: Ref) => {
          const at = ref.path.indexOf('/items/');
          if (at < 0) return Promise.resolve(snap());
          const data = itemDocs[ref.path.slice(at + '/items/'.length)];
          return Promise.resolve({ exists: () => data !== undefined, data: () => data });
        },
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
import { approveItems, approveItem, bulkApproveItems, setItemSpicy } from './admin';

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
  for (const id of Object.keys(itemDocs)) delete itemDocs[id];
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

describe('approveItems — routing an approval into one Day', () => {
  const written = () => updateMock.mock.calls.map(([path, data]) => ({ path, data }));

  beforeEach(() => {
    // Every id these tests approve, STORED as still-pending with its intended
    // Day. Routing reads these documents, not the rows the tests pass, so a test
    // that wants the two to disagree seeds a different stored target on purpose.
    putItem('p1', { targetDayIndex: 2 });
    putItem('legacy');
    putItem('bad', { targetDayIndex: -3 });
    putItem('nulled', { targetDayIndex: null });
    putItem('a', { targetDayIndex: 2 });
    putItem('b', { targetDayIndex: 1 });
    putItem('c', { targetDayIndex: 9 });
    putItem('d');
    eventDataMock.mockReturnValue({
      days: [
        { index: 0, unlockAt: NOW - 2 * HOUR, pool: 'main', snapshotItemIds: ['a'] },
        { index: 1, unlockAt: NOW - HOUR, pool: 'main', snapshotItemIds: [] },
        { index: 2, unlockAt: Date.now() + 10 * HOUR, pool: 'main' },
        { index: 3, unlockAt: Date.now() + 20 * HOUR, pool: 'main' },
      ],
    });
  });

  it('approves a Prompt onto the Day it was submitted for', async () => {
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 2 }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'p1', dayIndex: 2, retained: false, outcome: 'placed' },
    ]);
    expect(written()[0].data).toMatchObject({
      status: 'active',
      approvedBy: 'admin-uid',
      targetDayIndex: 2,
    });
  });

  it('atomically persists the Admin-selected easy classification with approval', async () => {
    putItem('p1', { targetDayIndex: 2, pool: 'main', spicy: true });

    await approveItems([{ id: 'p1', targetDayIndex: 2, pool: 'easy' }], 'admin-uid');

    expect(written()).toHaveLength(1);
    expect(written()[0].data).toMatchObject({
      status: 'active',
      approvedBy: 'admin-uid',
      targetDayIndex: 2,
      // Writes keep using the live documents' transitional persisted spelling.
      pool: 'embark',
      // Easy content is never adult-gated; approval clears a stale/ticked flag
      // in this same transaction rather than leaking it onto an ungated card.
      spicy: false,
    });
  });

  it.each([
    { stored: false, selected: true },
    { stored: true, selected: false },
  ])(
    'atomically persists an immediate Exploratory spicy choice ($stored → $selected)',
    async ({ stored, selected }) => {
      putItem('p1', { targetDayIndex: 2, pool: 'main', spicy: stored });

      await approveItems(
        [{ id: 'p1', targetDayIndex: 2, pool: 'main', spicy: selected }],
        'admin-uid',
      );

      expect(written()).toHaveLength(1);
      expect(written()[0].data).toMatchObject({
        status: 'active',
        pool: 'main',
        spicy: selected,
      });
    },
  );

  it('rejects a closing classification before writing a still-pending Prompt', async () => {
    await expect(
      approveItems([{ id: 'p1', targetDayIndex: 2, pool: 'closing' }], 'admin-uid'),
    ).rejects.toThrow(/easy or exploratory classification/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rolls a Prompt approved after its Day closed forward to the next open Day', async () => {
    putItem('p1', { targetDayIndex: 1 });
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 1 }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'p1', dayIndex: 2, retained: false, outcome: 'placed' },
    ]);
    expect(written()[0].data).toMatchObject({ status: 'active', targetDayIndex: 2 });
  });

  it('RETAINS a Prompt with nowhere left to go, keeping its original target', async () => {
    // Never dropped, never deleted, and never re-aimed at a Day that has dealt:
    // the unreachable target IS the retention, and retainedAt makes it legible.
    putItem('p1', { targetDayIndex: 9 });
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 9 }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'p1', dayIndex: null, retained: true, outcome: 'retained' },
    ]);
    const { data } = written()[0];
    expect(data).toMatchObject({ status: 'active', approvedBy: 'admin-uid' });
    expect(data).toHaveProperty('retainedAt');
    expect(data).not.toHaveProperty('targetDayIndex');
  });

  it('RESOLVES the Day a pending row with no target should have had', async () => {
    // A PENDING row is a player submission by construction — organiser and seed
    // Prompts are created `active` and never enter this queue — so an absent
    // target is a gap, not a request for every Day. Leaving it would let a
    // crafted or cached client submit without one and be approved onto EVERY
    // Day, around the create rule (Phase 4b P1, PR #812).
    const placements = await approveItems([{ id: 'legacy' }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'legacy', dayIndex: 2, retained: false, outcome: 'placed' },
    ]);
    const { data } = written()[0];
    expect(data).toMatchObject({ status: 'active', approvedBy: 'admin-uid', targetDayIndex: 2 });
    expect(typeof (data as { retainedAt: unknown }).retainedAt).not.toBe('number');
  });

  it('RETAINS an untargeted pending row when the schedule has nothing left', async () => {
    eventDataMock.mockReturnValue({
      days: [{ index: 0, unlockAt: NOW - HOUR, pool: 'main', snapshotItemIds: [] }],
    });
    const placements = await approveItems([{ id: 'legacy' }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'legacy', dayIndex: null, retained: true, outcome: 'retained' },
    ]);
  });

  it('keeps a Prompt UNTARGETED on an Event with no schedule at all', async () => {
    // The one honest untargeted case: there are no Days, so "every Day" is the
    // single legacy board and narrowing it would mean nothing.
    eventDataMock.mockReturnValue({});
    const placements = await approveItems([{ id: 'legacy' }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'legacy', dayIndex: null, retained: false, outcome: 'untargeted' },
    ]);
    const { data } = written()[0];
    expect(data).toMatchObject({ status: 'active', approvedBy: 'admin-uid' });
    expect(data).not.toHaveProperty('targetDayIndex');
    expect(typeof (data as { retainedAt: unknown }).retainedAt).not.toBe('number');
  });

  it('reports a malformed target as RETAINED — dealt nowhere, so described as nowhere', async () => {
    // The snapshot's `targetsDay` already excludes a malformed row from every
    // Day, so it IS retained; reporting it as ordinary untargeted content would
    // tell the organiser it is live on every Day while it is live on none
    // (Phase 4b P2, PR #812). It is never re-aimed: guessing the intended Day
    // would be inventing one.
    const placements = await approveItems(
      [{ id: 'bad', targetDayIndex: -3 as number }],
      'admin-uid',
    );
    expect(placements).toEqual([
      { itemId: 'bad', dayIndex: null, retained: true, outcome: 'retained' },
    ]);
    const { data } = written()[0];
    expect(data).toMatchObject({ status: 'active', approvedBy: 'admin-uid' });
    expect(data).toHaveProperty('retainedAt');
    // The write is a MERGE, so leaving the field out of it leaves the malformed
    // value on the document — untouched, not repaired and not cleared.
    expect(data).not.toHaveProperty('targetDayIndex');
  });

  it('reports a stored NULL target as retained too — a null is a value, not an absence', async () => {
    // The mirror of `targetsDay`'s strict-`undefined` rule: the rules reject a
    // null on create, but the admin update arm is unconstrained, so an imported
    // or repaired row can carry one. It must not read as untargeted here either.
    const placements = await approveItems(
      [{ id: 'nulled', targetDayIndex: null as unknown as number }],
      'admin-uid',
    );
    expect(placements).toEqual([
      { itemId: 'nulled', dayIndex: null, retained: true, outcome: 'retained' },
    ]);
    expect(written()[0].data).toHaveProperty('retainedAt');
  });

  it('CLEARS a stale retainedAt when it places the Prompt', async () => {
    // A marker left behind would describe an active, DEALT Prompt as one that
    // was retained and dealt nowhere (Phase 4b P1, PR #812). `tx.update` is a
    // merge, so not-writing the field is not the same as clearing it — a
    // placement has to unstamp it explicitly. The rules now refuse a
    // submitter-supplied `retainedAt`, so this is the second line behind that
    // bar rather than the only one.
    await approveItems([{ id: 'p1', targetDayIndex: 2 }], 'admin-uid');
    const { data } = written()[0];
    expect(data).toHaveProperty('retainedAt');
    expect(typeof (data as { retainedAt: unknown }).retainedAt).not.toBe('number');
  });

  it('CLEARS it on a RESOLVED placement too — every placement, not just routed ones', async () => {
    await approveItems([{ id: 'legacy' }], 'admin-uid');
    const { data } = written()[0];
    expect(data).toHaveProperty('retainedAt');
    expect(typeof (data as { retainedAt: unknown }).retainedAt).not.toBe('number');
  });

  it('STAMPS retainedAt as a real instant when it retains — the two paths differ', async () => {
    // The control for the two above: retention is the one outcome that writes a
    // number, so "cleared" and "stamped" can never be confused for each other.
    putItem('p1', { targetDayIndex: 9 });
    await approveItems([{ id: 'p1', targetDayIndex: 9 }], 'admin-uid');
    expect(typeof (written()[0].data as { retainedAt: unknown }).retainedAt).toBe('number');
  });

  it('REFUSES to re-approve a row that is no longer pending — the double-deal guard', async () => {
    // The hazard: two organisers hold the same queue row. The first approval
    // places the Prompt on Day 2 and Day 2 freezes with its id; a second
    // approval of that stale row would find Day 2 closed, roll FORWARD, and
    // rewrite it for Day 3 — which then freezes with it too. The Prompt would be
    // dealt on TWO Days, the one outcome this ticket exists to prevent, and no
    // Day is mutated on the way there so nothing downstream would catch it
    // (Phase 4b P1, PR #812).
    putItem('p1', { status: 'active', targetDayIndex: 2 });
    const placements = await approveItems(
      [{ id: 'p1', targetDayIndex: 2, pool: 'easy' }],
      'admin-uid',
    );
    expect(placements).toEqual([
      { itemId: 'p1', dayIndex: 2, retained: false, outcome: 'stale' },
    ]);
    // Reported where it already stands, and NOT rewritten.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reports an already-RETAINED row as retained, still without writing', async () => {
    putItem('p1', { status: 'active', targetDayIndex: 9, retainedAt: NOW });
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 9 }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'p1', dayIndex: null, retained: true, outcome: 'stale' },
    ]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reports a row that has VANISHED rather than inventing one', async () => {
    delete itemDocs['p1'];
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 2 }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'p1', dayIndex: null, retained: false, outcome: 'missing' },
    ]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('routes on the STORED target, ignoring a stale one on the caller row', async () => {
    // The queue row is a client snapshot and may be out of date; the document is
    // not. An organiser re-aimed this Prompt at Day 3 after the queue rendered.
    putItem('p1', { targetDayIndex: 3 });
    const placements = await approveItems([{ id: 'p1', targetDayIndex: 2 }], 'admin-uid');
    expect(placements).toEqual([
      { itemId: 'p1', dayIndex: 3, retained: false, outcome: 'placed' },
    ]);
    expect(written()[0].data).toMatchObject({ targetDayIndex: 3 });
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
        { id: 'a', targetDayIndex: 2, pool: 'easy' },
        { id: 'b', targetDayIndex: 1, pool: 'main' },
        { id: 'c', targetDayIndex: 9, pool: 'easy' },
        { id: 'd', pool: 'main' },
      ],
      'admin-uid',
    );
    expect(placements).toEqual([
      { itemId: 'a', dayIndex: 2, retained: false, outcome: 'placed' },
      { itemId: 'b', dayIndex: 2, retained: false, outcome: 'placed' },
      { itemId: 'c', dayIndex: null, retained: true, outcome: 'retained' },
      // 'd' has no stored target: a pending row is a player submission, so
      // approval resolves the Day it should have had rather than every Day.
      { itemId: 'd', dayIndex: 2, retained: false, outcome: 'placed' },
    ]);
    const stamps = new Set(written().map(({ data }) => (data as { approvedAt: number }).approvedAt));
    expect(stamps.size).toBe(1);
    expect(written().map(({ data }) => (data as { pool: string }).pool)).toEqual([
      'embark',
      'main',
      'embark',
      'main',
    ]);
  });

  it('ignores malformed classification hints on stale/missing bulk rows and still approves a valid row', async () => {
    putItem('stale-classification', { status: 'active', targetDayIndex: 2 });

    const placements = await bulkApproveItems(
      [
        { id: 'stale-classification', pool: 'closing' },
        { id: 'missing-classification', spicy: 'not-a-boolean' as never },
        { id: 'p1', targetDayIndex: 2, pool: 'easy' },
      ],
      'admin-uid',
    );

    expect(placements).toEqual([
      { itemId: 'stale-classification', dayIndex: 2, retained: false, outcome: 'stale' },
      { itemId: 'missing-classification', dayIndex: null, retained: false, outcome: 'missing' },
      { itemId: 'p1', dayIndex: 2, retained: false, outcome: 'placed' },
    ]);
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({
      path: 'events/med-2026/items/p1',
      data: { status: 'active', pool: 'embark', spicy: false },
    });
  });

  it('approveItem takes the queue ROW so a target can never be dropped', async () => {
    putItem('p1', { targetDayIndex: 3 });
    const placement = await approveItem({ id: 'p1', targetDayIndex: 3 }, 'admin-uid');
    expect(placement).toEqual({ itemId: 'p1', dayIndex: 3, retained: false, outcome: 'placed' });
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

    await setItemSpicy('p1', true);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('still lets the queue correct a pending exploratory Prompt', async () => {
    putItem('p1', {
      status: 'pending',
      pool: 'main',
      spicy: false,
      targetDayIndex: 2,
    });

    await setItemSpicy('p1', true);

    expect(updateMock).toHaveBeenCalledWith('events/med-2026/items/p1', {
      spicy: true,
    });
  });
});
