import { describe, it, expect, beforeEach } from 'vitest';
import {
  ApprovalClosedError,
  ApprovalPermissionError,
  approvePromptsCallable,
  approvePromptsCore,
  MAX_APPROVE_PROMPTS_ITEMS,
  parseApprovePromptsRequest,
  type ApprovePromptsDeps,
  type ApprovePromptsItem,
  type ApprovePromptsLogger,
} from '../../functions/src/approvePrompts';
import type { AdminFirestore } from '../../functions/src/unlockDay';

// specs/community-prompt-targeting.md § "The clock routing trusts" and § "Why
// approval runs in a transaction" (#1275, #813, ADR 0015) — the server half of
// Community Prompt approval. Every case that used to pin `approveItems`' client
// transaction (src/data/community-prompt-targeting.test.ts, pre-#1275) lives
// here now, against `approvePromptsCore` with an injected clock, plus what only
// the server side can claim: the clock is the server's, the identity is the
// verified auth uid, and the Event-doc fence is written exactly once per
// writing call.
//
// Every Firestore seam is an in-memory fake (no live runtime, no emulator),
// mirroring tests/functions/community-prompt-targeting-snapshot.test.ts.

const EVENT_ID = 'med-2026';
const ADMIN = 'admin-uid';
const NOW = 1_000_000;
const HOUR = 3_600_000;

/** The `FieldValue.delete()` stand-in the core writes for a cleared field. The
 *  fake applies it the way Firestore would: the key is removed on merge. */
const DELETE = Object.freeze({ __sentinel: 'delete' });

type Doc = Record<string, unknown>;

interface Fake extends AdminFirestore {
  /** Every `tx.update`, in order, with the RAW staged data (sentinel intact). */
  writes(): Array<{ path: string; data: Doc }>;
  /** Only the item writes — the shape the ported client cases assert on. */
  itemWrites(): Array<{ path: string; data: Doc }>;
  read(path: string): Doc | undefined;
  /** How many times the transaction body ran. */
  attempts(): number;
}

function makeDb(seed: { event?: Doc; items?: Record<string, Doc>; docs?: Record<string, Doc> }): Fake {
  const docs = new Map<string, Doc | undefined>();
  const eventPath = `events/${EVENT_ID}`;
  if (seed.event !== undefined) docs.set(eventPath, { ...seed.event });
  for (const [id, data] of Object.entries(seed.items ?? {})) {
    docs.set(`${eventPath}/items/${id}`, { ...data });
  }
  for (const [path, data] of Object.entries(seed.docs ?? {})) docs.set(path, { ...data });
  const writes: Array<{ path: string; data: Doc }> = [];
  let attempts = 0;

  const snapshotOf = (path: string) => {
    const data = docs.get(path);
    return { exists: data !== undefined, id: path.split('/').pop() as string, data: () => data };
  };
  const docRef = (path: string) => ({
    __path: path,
    get: async () => snapshotOf(path),
    set: async (data: Doc) => {
      docs.set(path, { ...data });
      return undefined;
    },
  });
  const apply = (path: string, data: Doc) => {
    const next = { ...(docs.get(path) ?? {}) };
    for (const [key, value] of Object.entries(data)) {
      if (value === DELETE) delete next[key];
      else next[key] = value;
    }
    docs.set(path, next);
  };

  return {
    doc: (path: string) => docRef(path),
    collection: () => {
      throw new Error('approvePromptsCore never queries a collection');
    },
    async runTransaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      attempts += 1;
      const staged: Array<{ path: string; data: Doc }> = [];
      const tx = {
        get: async (ref: { get(): Promise<unknown> }) => ref.get(),
        update: (ref: { __path: string }, data: Doc) => {
          staged.push({ path: ref.__path, data: { ...data } });
        },
        set: (ref: { __path: string }, data: Doc) => {
          staged.push({ path: ref.__path, data: { ...data } });
        },
      };
      const result = await fn(tx as never);
      // Writes land only on a completed callback, as Firestore commits them.
      for (const write of staged) {
        writes.push(write);
        apply(write.path, write.data);
      }
      return result;
    },
    writes: () => writes,
    itemWrites: () => writes.filter((w) => w.path.includes('/items/')),
    read: (path: string) => docs.get(path),
    attempts: () => attempts,
  };
}

const schedule = () => [
  { index: 0, unlockAt: NOW - 2 * HOUR, pool: 'main', snapshotItemIds: ['a'] },
  { index: 1, unlockAt: NOW - HOUR, pool: 'main', snapshotItemIds: [] },
  { index: 2, unlockAt: NOW + 10 * HOUR, pool: 'main' },
  { index: 3, unlockAt: NOW + 20 * HOUR, pool: 'main' },
];

const openEvent = (over: Doc = {}): Doc => ({
  status: 'active',
  admins: [ADMIN],
  days: schedule(),
  ...over,
});

/** A stored pending row with its intended Day. */
const pending = (over: Doc = {}): Doc => ({ status: 'pending', pool: 'main', spicy: false, ...over });

function seedItems(): Record<string, Doc> {
  return {
    p1: pending({ targetDayIndex: 2 }),
    legacy: pending(),
    bad: pending({ targetDayIndex: -3 }),
    nulled: pending({ targetDayIndex: null }),
    a: pending({ targetDayIndex: 2 }),
    b: pending({ targetDayIndex: 1 }),
    c: pending({ targetDayIndex: 9 }),
    d: pending(),
  };
}

function deps(db: Fake, over: Partial<ApprovePromptsDeps> = {}): ApprovePromptsDeps {
  return { db, now: () => NOW, deleteField: () => DELETE, ...over };
}

const approve = (db: Fake, items: readonly ApprovePromptsItem[], over: Partial<ApprovePromptsDeps> = {}) =>
  approvePromptsCore(deps(db, over), ADMIN, EVENT_ID, items);

describe('approvePromptsCore — routing an approval into one Day (ported from the client suite)', () => {
  let db: Fake;
  beforeEach(() => {
    db = makeDb({ event: openEvent(), items: seedItems() });
  });

  it('approves a Prompt onto the Day it was submitted for', async () => {
    const placements = await approve(db, [{ id: 'p1' }]);
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: 2, retained: false, outcome: 'placed' }]);
    expect(db.itemWrites()[0].data).toMatchObject({
      status: 'active',
      approvedBy: ADMIN,
      approvedAt: NOW,
      targetDayIndex: 2,
    });
  });

  it('atomically persists the Admin-selected easy classification with approval', async () => {
    db = makeDb({ event: openEvent(), items: { p1: pending({ targetDayIndex: 2, spicy: true }) } });
    await approve(db, [{ id: 'p1', pool: 'easy' }]);
    expect(db.itemWrites()).toHaveLength(1);
    expect(db.itemWrites()[0].data).toMatchObject({
      status: 'active',
      approvedBy: ADMIN,
      targetDayIndex: 2,
      // Writes keep the live documents' transitional persisted spelling.
      pool: 'embark',
      // Easy content is never adult-gated; approval clears a ticked flag in
      // this same write rather than leaking it onto an ungated card.
      spicy: false,
    });
  });

  it.each([
    { stored: false, selected: true },
    { stored: true, selected: false },
  ])('atomically persists an immediate Exploratory spicy choice ($stored -> $selected)', async ({ stored, selected }) => {
    db = makeDb({ event: openEvent(), items: { p1: pending({ targetDayIndex: 2, spicy: stored }) } });
    await approve(db, [{ id: 'p1', pool: 'main', spicy: selected }]);
    expect(db.itemWrites()).toHaveLength(1);
    expect(db.itemWrites()[0].data).toMatchObject({ status: 'active', pool: 'main', spicy: selected });
  });

  // #1070: a classification approval cannot act on is a fact about ONE row.
  it("reports a closing classification as that row's own malformed outcome, writing nothing", async () => {
    const placements = await approve(db, [{ id: 'p1', pool: 'closing' }]);
    expect(placements).toEqual([
      {
        itemId: 'p1',
        dayIndex: null,
        retained: false,
        outcome: 'malformed',
        reason: 'Community Prompt approval requires an easy or exploratory classification.',
      },
    ]);
    expect(db.writes()).toHaveLength(0);
  });

  it('reports a non-boolean spicy choice as malformed too, naming the spicy reason', async () => {
    const placements = await approve(db, [{ id: 'p1', pool: 'main', spicy: 'yes' }]);
    expect(placements).toEqual([
      {
        itemId: 'p1',
        dayIndex: null,
        retained: false,
        outcome: 'malformed',
        reason: 'Community Prompt approval requires a boolean spicy classification.',
      },
    ]);
    expect(db.writes()).toHaveLength(0);
  });

  it('rolls a Prompt approved after its Day closed forward to the next open Day', async () => {
    const placements = await approve(db, [{ id: 'b' }]);
    expect(placements).toEqual([{ itemId: 'b', dayIndex: 2, retained: false, outcome: 'placed' }]);
    expect(db.itemWrites()[0].data).toMatchObject({ status: 'active', targetDayIndex: 2 });
  });

  it('RETAINS a Prompt with nowhere left to go, keeping its original target', async () => {
    const placements = await approve(db, [{ id: 'c' }]);
    expect(placements).toEqual([{ itemId: 'c', dayIndex: null, retained: true, outcome: 'retained' }]);
    const { data } = db.itemWrites()[0];
    expect(data).toMatchObject({ status: 'active', approvedBy: ADMIN, retainedAt: NOW });
    expect(data).not.toHaveProperty('targetDayIndex');
    expect(db.read(`events/${EVENT_ID}/items/c`)).toMatchObject({ targetDayIndex: 9 });
  });

  it('RESOLVES the Day a pending row with no target should have had', async () => {
    const placements = await approve(db, [{ id: 'legacy' }]);
    expect(placements).toEqual([{ itemId: 'legacy', dayIndex: 2, retained: false, outcome: 'placed' }]);
    expect(db.itemWrites()[0].data).toMatchObject({ status: 'active', approvedBy: ADMIN, targetDayIndex: 2 });
    expect(db.itemWrites()[0].data.retainedAt).toBe(DELETE);
  });

  it('RETAINS an untargeted pending row when the schedule has nothing left', async () => {
    db = makeDb({
      event: openEvent({ days: [{ index: 0, unlockAt: NOW - HOUR, pool: 'main', snapshotItemIds: [] }] }),
      items: seedItems(),
    });
    const placements = await approve(db, [{ id: 'legacy' }]);
    expect(placements).toEqual([{ itemId: 'legacy', dayIndex: null, retained: true, outcome: 'retained' }]);
  });

  it('keeps a Prompt UNTARGETED on an Event with no schedule at all', async () => {
    db = makeDb({ event: { status: 'active', admins: [ADMIN] }, items: seedItems() });
    const placements = await approve(db, [{ id: 'legacy' }]);
    expect(placements).toEqual([{ itemId: 'legacy', dayIndex: null, retained: false, outcome: 'untargeted' }]);
    const { data } = db.itemWrites()[0];
    expect(data).toMatchObject({ status: 'active', approvedBy: ADMIN });
    expect(data).not.toHaveProperty('targetDayIndex');
    expect(data.retainedAt).toBe(DELETE);
  });

  it('reports a malformed target as RETAINED — dealt nowhere, so described as nowhere', async () => {
    const placements = await approve(db, [{ id: 'bad' }]);
    expect(placements).toEqual([{ itemId: 'bad', dayIndex: null, retained: true, outcome: 'retained' }]);
    const { data } = db.itemWrites()[0];
    expect(data).toMatchObject({ status: 'active', retainedAt: NOW });
    // The write is a MERGE: the malformed value is left in place, not repaired.
    expect(data).not.toHaveProperty('targetDayIndex');
    expect(db.read(`events/${EVENT_ID}/items/bad`)).toMatchObject({ targetDayIndex: -3 });
  });

  it('reports a stored NULL target as retained too — a null is a value, not an absence', async () => {
    const placements = await approve(db, [{ id: 'nulled' }]);
    expect(placements).toEqual([{ itemId: 'nulled', dayIndex: null, retained: true, outcome: 'retained' }]);
    expect(db.itemWrites()[0].data).toMatchObject({ retainedAt: NOW });
  });

  it('CLEARS a stale retainedAt when it places the Prompt', async () => {
    db = makeDb({ event: openEvent(), items: { p1: pending({ targetDayIndex: 2, retainedAt: 5 }) } });
    await approve(db, [{ id: 'p1' }]);
    expect(db.itemWrites()[0].data.retainedAt).toBe(DELETE);
    expect(db.read(`events/${EVENT_ID}/items/p1`)).not.toHaveProperty('retainedAt');
  });

  it('STAMPS retainedAt as a real instant when it retains — the two paths differ', async () => {
    await approve(db, [{ id: 'c' }]);
    expect(typeof db.itemWrites()[0].data.retainedAt).toBe('number');
  });

  it('REFUSES to re-approve a row that is no longer pending — the double-deal guard', async () => {
    db = makeDb({ event: openEvent(), items: { p1: { status: 'active', targetDayIndex: 2 } } });
    const placements = await approve(db, [{ id: 'p1', pool: 'easy' }]);
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: 2, retained: false, outcome: 'stale' }]);
    expect(db.writes()).toHaveLength(0);
  });

  it('reports an already-RETAINED row as retained, still without writing', async () => {
    db = makeDb({ event: openEvent(), items: { p1: { status: 'active', targetDayIndex: 9, retainedAt: NOW } } });
    const placements = await approve(db, [{ id: 'p1' }]);
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: null, retained: true, outcome: 'stale' }]);
    expect(db.writes()).toHaveLength(0);
  });

  it('never describes a rejected row as scheduled', async () => {
    db = makeDb({ event: openEvent(), items: { p1: { status: 'rejected', targetDayIndex: 2 } } });
    const placements = await approve(db, [{ id: 'p1' }]);
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: null, retained: false, outcome: 'stale' }]);
  });

  it('reports a row that has VANISHED rather than inventing one', async () => {
    db = makeDb({ event: openEvent(), items: {} });
    const placements = await approve(db, [{ id: 'p1' }]);
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: null, retained: false, outcome: 'missing' }]);
    expect(db.writes()).toHaveLength(0);
  });

  it('routes on the STORED target, ignoring anything the caller row carried', async () => {
    db = makeDb({ event: openEvent(), items: { p1: pending({ targetDayIndex: 3 }) } });
    const placements = await approve(db, [{ id: 'p1', targetDayIndex: 2 } as ApprovePromptsItem]);
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: 3, retained: false, outcome: 'placed' }]);
    expect(db.itemWrites()[0].data).toMatchObject({ targetDayIndex: 3 });
  });

  it('is a no-op for an empty list — no transaction is even opened', async () => {
    expect(await approve(db, [])).toEqual([]);
    expect(db.attempts()).toBe(0);
  });

  it('routes every row of a bulk approve, sharing ONE approvedAt instant', async () => {
    const placements = await approve(db, [
      { id: 'a', pool: 'easy' },
      { id: 'b', pool: 'main' },
      { id: 'c', pool: 'easy' },
      { id: 'd', pool: 'main' },
    ]);
    expect(placements).toEqual([
      { itemId: 'a', dayIndex: 2, retained: false, outcome: 'placed' },
      { itemId: 'b', dayIndex: 2, retained: false, outcome: 'placed' },
      { itemId: 'c', dayIndex: null, retained: true, outcome: 'retained' },
      { itemId: 'd', dayIndex: 2, retained: false, outcome: 'placed' },
    ]);
    const stamps = new Set(db.itemWrites().map(({ data }) => data.approvedAt));
    expect(stamps).toEqual(new Set([NOW]));
    expect(db.itemWrites().map(({ data }) => data.pool)).toEqual(['embark', 'main', 'embark', 'main']);
  });

  it('ignores malformed classification hints on stale/missing bulk rows and still approves a valid row', async () => {
    db = makeDb({
      event: openEvent(),
      items: { ...seedItems(), 'stale-classification': { status: 'active', targetDayIndex: 2 } },
    });
    const placements = await approve(db, [
      { id: 'stale-classification', pool: 'closing' },
      { id: 'missing-classification', spicy: 'not-a-boolean' },
      { id: 'p1', pool: 'easy' },
    ]);
    expect(placements).toEqual([
      { itemId: 'stale-classification', dayIndex: 2, retained: false, outcome: 'stale' },
      { itemId: 'missing-classification', dayIndex: null, retained: false, outcome: 'missing' },
      { itemId: 'p1', dayIndex: 2, retained: false, outcome: 'placed' },
    ]);
    expect(db.itemWrites()).toHaveLength(1);
    expect(db.itemWrites()[0]).toMatchObject({
      path: `events/${EVENT_ID}/items/p1`,
      data: { status: 'active', pool: 'embark', spicy: false },
    });
  });

  it('skips ONE malformed row in a bulk approve and still approves the other two (#1070)', async () => {
    const placements = await approve(db, [
      { id: 'a', pool: 'easy' },
      { id: 'b', pool: 'closing' },
      { id: 'd', pool: 'main', spicy: true },
    ]);
    expect(placements).toEqual([
      { itemId: 'a', dayIndex: 2, retained: false, outcome: 'placed' },
      {
        itemId: 'b',
        dayIndex: null,
        retained: false,
        outcome: 'malformed',
        reason: 'Community Prompt approval requires an easy or exploratory classification.',
      },
      { itemId: 'd', dayIndex: 2, retained: false, outcome: 'placed' },
    ]);
    expect(db.itemWrites().map(({ path }) => path)).toEqual([
      `events/${EVENT_ID}/items/a`,
      `events/${EVENT_ID}/items/d`,
    ]);
    expect(new Set(db.itemWrites().map(({ data }) => data.approvedAt))).toEqual(new Set([NOW]));
    expect(db.read(`events/${EVENT_ID}/items/b`)).toMatchObject({ status: 'pending' });
  });
});

describe('approvePromptsCore — the Event-doc fence, the rewritten #557 pin (#813)', () => {
  // The old pin said "an approval touches only the Prompt, never the Event".
  // It now touches the Event on purpose, and this is the exact shape of that
  // touch: every write is an item write except ONE Event update whose only key
  // is `approvalSeq`, and the schedule it carries is byte-identical to before.
  // A frozen Day is still never mutated by an approval.
  it('writes every item, plus exactly one Event update whose keys are exactly [approvalSeq], leaving days unchanged', async () => {
    const before = openEvent();
    const db = makeDb({ event: before, items: seedItems() });
    await approve(db, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const eventWrites = db.writes().filter((w) => w.path === `events/${EVENT_ID}`);
    expect(eventWrites).toHaveLength(1);
    expect(Object.keys(eventWrites[0].data)).toEqual(['approvalSeq']);
    expect(eventWrites[0].data.approvalSeq).toBe(1);
    for (const { path } of db.writes()) {
      expect(path).toMatch(new RegExp(`^events/${EVENT_ID}(/items/|$)`));
    }
    expect(db.read(`events/${EVENT_ID}`)?.days).toEqual(before.days);
  });

  it('bumps from the stored counter, and treats a missing or malformed one as 0', async () => {
    const counted = makeDb({ event: openEvent({ approvalSeq: 41 }), items: seedItems() });
    await approve(counted, [{ id: 'p1' }]);
    expect(counted.read(`events/${EVENT_ID}`)).toMatchObject({ approvalSeq: 42 });

    const garbage = makeDb({ event: openEvent({ approvalSeq: 'nine' }), items: seedItems() });
    await approve(garbage, [{ id: 'p1' }]);
    expect(garbage.read(`events/${EVENT_ID}`)).toMatchObject({ approvalSeq: 1 });
  });

  it('writes the fence for a retention and an untargeted placement too — any row written', async () => {
    const retained = makeDb({ event: openEvent(), items: seedItems() });
    await approve(retained, [{ id: 'c' }]);
    expect(retained.read(`events/${EVENT_ID}`)).toMatchObject({ approvalSeq: 1 });

    const untargeted = makeDb({ event: { status: 'active', admins: [ADMIN] }, items: seedItems() });
    await approve(untargeted, [{ id: 'legacy' }]);
    expect(untargeted.read(`events/${EVENT_ID}`)).toMatchObject({ approvalSeq: 1 });
  });

  it('writes NO fence when every row is stale, missing or malformed', async () => {
    const db = makeDb({
      event: openEvent(),
      items: { ...seedItems(), done: { status: 'active', targetDayIndex: 2 } },
    });
    const placements = await approve(db, [
      { id: 'done' },
      { id: 'gone' },
      { id: 'p1', pool: 'closing' },
    ]);
    expect(placements.map((p) => p.outcome)).toEqual(['stale', 'missing', 'malformed']);
    expect(db.writes()).toHaveLength(0);
    expect(db.read(`events/${EVENT_ID}`)).not.toHaveProperty('approvalSeq');
  });
});

describe('approvePromptsCore — admin and freeze gates run inside the transaction', () => {
  it('refuses a caller who is not on the roster, writing nothing', async () => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    await expect(approvePromptsCore(deps(db), 'stranger', EVENT_ID, [{ id: 'p1' }])).rejects.toBeInstanceOf(
      ApprovalPermissionError,
    );
    expect(db.writes()).toHaveLength(0);
  });

  it('refuses when the Event does not exist, with the SAME error as a non-admin', async () => {
    const db = makeDb({ items: seedItems() });
    await expect(approve(db, [{ id: 'p1' }])).rejects.toBeInstanceOf(ApprovalPermissionError);
  });

  it.each([
    ['archived', { status: 'archived' }],
    ['archiving', { archiving: true }],
  ])('refuses on an %s Event, writing nothing', async (_label, over) => {
    const db = makeDb({ event: openEvent(over), items: seedItems() });
    await expect(approve(db, [{ id: 'p1' }])).rejects.toBeInstanceOf(ApprovalClosedError);
    expect(db.writes()).toHaveLength(0);
  });

  // specs/event-membership.md § The role model: `admins` is client-writable, so
  // on an ENFORCED Event the roster alone does not authorize this Admin-SDK
  // path; the caller's own active membership is conjoined, read in the attempt.
  const membershipOf = (uid: string, status: string): Record<string, Doc> => ({
    [`events/${EVENT_ID}/memberships/${uid}`]: { status },
  });

  it('on an enforced Event, refuses a rostered caller with no membership, writing nothing', async () => {
    const db = makeDb({ event: openEvent({ membershipEnforcement: 'enforced' }), items: seedItems() });
    await expect(approve(db, [{ id: 'p1' }])).rejects.toBeInstanceOf(ApprovalPermissionError);
    expect(db.writes()).toHaveLength(0);
  });

  it('on an enforced Event, refuses a rostered caller whose membership is revoked', async () => {
    const db = makeDb({
      event: openEvent({ membershipEnforcement: 'enforced' }),
      items: seedItems(),
      docs: membershipOf(ADMIN, 'revoked'),
    });
    await expect(approve(db, [{ id: 'p1' }])).rejects.toBeInstanceOf(ApprovalPermissionError);
    expect(db.writes()).toHaveLength(0);
  });

  it('on an enforced Event, approves for a rostered caller holding an active membership', async () => {
    const db = makeDb({
      event: openEvent({ membershipEnforcement: 'enforced' }),
      items: seedItems(),
      docs: membershipOf(ADMIN, 'active'),
    });
    const placements = await approve(db, [{ id: 'p1' }]);
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: 2, retained: false, outcome: 'placed' }]);
  });

  it('on an enforced Event, an active membership never stands in for the roster', async () => {
    const db = makeDb({
      event: openEvent({ membershipEnforcement: 'enforced' }),
      items: seedItems(),
      docs: membershipOf('member-uid', 'active'),
    });
    await expect(approvePromptsCore(deps(db), 'member-uid', EVENT_ID, [{ id: 'p1' }])).rejects.toBeInstanceOf(
      ApprovalPermissionError,
    );
  });

  it.each([
    ['absent', {}],
    ['off', { membershipEnforcement: 'off' }],
    ['malformed', { membershipEnforcement: 'ENFORCED' }],
  ])('on an unenforced Event (%s), the roster authorizes without a membership, as the client rules did', async (_label, over) => {
    const db = makeDb({ event: openEvent(over), items: seedItems() });
    const placements = await approve(db, [{ id: 'p1' }]);
    expect(placements[0].outcome).toBe('placed');
  });

  it('checks the roster before the freeze — a non-admin on a closed Event is told nothing about the Event', async () => {
    const db = makeDb({ event: openEvent({ status: 'archived' }), items: seedItems() });
    await expect(approvePromptsCore(deps(db), 'stranger', EVENT_ID, [{ id: 'p1' }])).rejects.toBeInstanceOf(
      ApprovalPermissionError,
    );
  });
});

// --- The callable boundary --------------------------------------------------------

interface PublicHttpsError extends Error {
  code: string;
}

type Request = Parameters<typeof approvePromptsCallable>[0];

function request(data: unknown, over: { uid?: string | null; app?: boolean } = {}): Request {
  const uid = over.uid === undefined ? ADMIN : over.uid;
  return {
    data,
    auth: uid === null ? undefined : { uid },
    ...(over.app ? { app: { appId: 'app', token: {} } } : {}),
  } as unknown as Request;
}

async function rejectionOf(work: Promise<unknown>): Promise<PublicHttpsError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('code');
    return error as PublicHttpsError;
  }
  throw new Error('Expected the callable to reject.');
}

function recordingLogger(): { logger: ApprovePromptsLogger; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    logger: {
      warn: (...args) => calls.push(args),
      error: (...args) => calls.push(args),
    },
  };
}

const VALID = { eventId: EVENT_ID, items: [{ id: 'p1' }] };

describe('approvePromptsCallable — identity, clock and payload boundary', () => {
  // The whole reason the approval moved server-side: nothing the client sends
  // about time or identity is read. The same payload, with a bogus approvedAt,
  // now and adminUid, lands wherever the SERVER clock says.
  const forged = {
    eventId: EVENT_ID,
    adminUid: 'forged',
    approvedAt: 0,
    now: 9e15,
    items: [{ id: 'p1', approvedAt: 0, adminUid: 'forged' }],
  };
  // Day 2 unlocks at NOW + 10h; U is that instant.
  const U = NOW + 10 * HOUR;

  it('routes and stamps from deps.now, not the payload: one tick before Day 2 unlocks it lands on Day 2', async () => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    const res = await approvePromptsCallable(request(forged), false, deps(db, { now: () => U - 1 }));
    expect(res.placements).toEqual([{ itemId: 'p1', dayIndex: 2, retained: false, outcome: 'placed' }]);
    expect(db.itemWrites()[0].data).toMatchObject({ approvedAt: U - 1, approvedBy: ADMIN, targetDayIndex: 2 });
  });

  it('… and one tick after, the same payload rolls forward to Day 3 with approvedAt from the server', async () => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    const res = await approvePromptsCallable(request(forged), false, deps(db, { now: () => U + 1 }));
    expect(res.placements).toEqual([{ itemId: 'p1', dayIndex: 3, retained: false, outcome: 'placed' }]);
    expect(db.itemWrites()[0].data).toMatchObject({ approvedAt: U + 1, approvedBy: ADMIN, targetDayIndex: 3 });
  });

  it('… or retains with retainedAt from the server when nothing later is open', async () => {
    const db = makeDb({
      event: openEvent({ days: schedule().slice(0, 3) }),
      items: seedItems(),
    });
    const res = await approvePromptsCallable(request(forged), false, deps(db, { now: () => U + 1 }));
    expect(res.placements).toEqual([{ itemId: 'p1', dayIndex: null, retained: true, outcome: 'retained' }]);
    expect(db.itemWrites()[0].data).toMatchObject({ approvedAt: U + 1, retainedAt: U + 1, approvedBy: ADMIN });
  });

  it('stamps approvedBy from the verified auth uid, never from the payload', async () => {
    const db = makeDb({ event: openEvent({ admins: ['other-admin'] }), items: seedItems() });
    await approvePromptsCallable(request(forged, { uid: 'other-admin' }), false, deps(db));
    expect(db.itemWrites()[0].data).toMatchObject({ approvedBy: 'other-admin' });
    expect(JSON.stringify(db.writes())).not.toContain('forged');
  });

  it('sends only eventId and each row id/pool/spicy into the core', () => {
    const parsed = parseApprovePromptsRequest({
      ...forged,
      items: [{ id: 'p1', pool: 'easy', spicy: false, targetDayIndex: 4, text: 'never read' }],
    });
    expect(parsed).toEqual({ eventId: EVENT_ID, items: [{ id: 'p1', pool: 'easy', spicy: false }] });
  });

  it('returns an empty placements list for an empty items array without opening a transaction', async () => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    await expect(approvePromptsCallable(request({ eventId: EVENT_ID, items: [] }), false, deps(db))).resolves.toEqual({
      placements: [],
    });
    expect(db.attempts()).toBe(0);
  });
});

describe('approvePromptsCallable — HttpsError mapping', () => {
  it('unauthenticated when there is no auth', async () => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    const error = await rejectionOf(approvePromptsCallable(request(VALID, { uid: null }), false, deps(db)));
    expect(error.code).toBe('unauthenticated');
    expect(error.message).toBe('Sign in before approving Prompts.');
    expect(db.attempts()).toBe(0);
  });

  it('failed-precondition when App Check is enforced and the request carries no app', async () => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    const error = await rejectionOf(approvePromptsCallable(request(VALID), true, deps(db)));
    expect(error.code).toBe('failed-precondition');
    expect(error.message).toBe('App Check is required.');
    expect(db.attempts()).toBe(0);
  });

  it('proceeds when App Check is enforced and the request carries an app, and when it is not enforced at all', async () => {
    const attested = makeDb({ event: openEvent(), items: seedItems() });
    await expect(approvePromptsCallable(request(VALID, { app: true }), true, deps(attested))).resolves.toEqual({
      placements: [{ itemId: 'p1', dayIndex: 2, retained: false, outcome: 'placed' }],
    });
    const off = makeDb({ event: openEvent(), items: seedItems() });
    await expect(approvePromptsCallable(request(VALID), false, deps(off))).resolves.toMatchObject({
      placements: [{ itemId: 'p1', outcome: 'placed' }],
    });
  });

  it('checks auth before App Check', async () => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    const error = await rejectionOf(approvePromptsCallable(request(VALID, { uid: null }), true, deps(db)));
    expect(error.code).toBe('unauthenticated');
  });

  it.each([
    ['no body', undefined],
    ['a non-object body', 'p1'],
    ['a missing eventId', { items: [] }],
    ['an empty eventId', { eventId: '', items: [] }],
    ['an eventId with a path separator', { eventId: 'a/b', items: [] }],
    ['items that are not an array', { eventId: EVENT_ID, items: { id: 'p1' } }],
    ['more than the cap', { eventId: EVENT_ID, items: Array.from({ length: MAX_APPROVE_PROMPTS_ITEMS + 1 }, (_, i) => ({ id: `i${i}` })) }],
    ['an item without an id', { eventId: EVENT_ID, items: [{ pool: 'main' }] }],
    ['an item with an empty id', { eventId: EVENT_ID, items: [{ id: '' }] }],
    ['an item id with a path separator', { eventId: EVENT_ID, items: [{ id: 'items/../x' }] }],
    ['a non-object item', { eventId: EVENT_ID, items: ['p1'] }],
    ['duplicate ids', { eventId: EVENT_ID, items: [{ id: 'p1' }, { id: 'p1' }] }],
  ])('invalid-argument for %s, before any read', async (_label, data) => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    const error = await rejectionOf(approvePromptsCallable(request(data), false, deps(db)));
    expect(error.code).toBe('invalid-argument');
    expect(db.attempts()).toBe(0);
  });

  it('accepts exactly the cap', async () => {
    const items = Array.from({ length: MAX_APPROVE_PROMPTS_ITEMS }, (_, i) => ({ id: `i${i}` }));
    const db = makeDb({ event: openEvent(), items: {} });
    const res = await approvePromptsCallable(request({ eventId: EVENT_ID, items }), false, deps(db));
    expect(res.placements).toHaveLength(MAX_APPROVE_PROMPTS_ITEMS);
    expect(res.placements.every((p) => p.outcome === 'missing')).toBe(true);
  });

  it('permission-denied for a non-admin, and the same for a missing Event', async () => {
    const stranger = makeDb({ event: openEvent(), items: seedItems() });
    const denied = await rejectionOf(approvePromptsCallable(request(VALID, { uid: 'stranger' }), false, deps(stranger)));
    expect(denied.code).toBe('permission-denied');
    expect(stranger.writes()).toHaveLength(0);

    const missing = makeDb({ items: seedItems() });
    const gone = await rejectionOf(approvePromptsCallable(request(VALID), false, deps(missing)));
    expect(gone.code).toBe('permission-denied');
    expect(gone.message).toBe(denied.message);
  });

  it.each([
    ['archived', { status: 'archived' }],
    ['archiving', { archiving: true }],
  ])('failed-precondition on an %s Event', async (_label, over) => {
    const db = makeDb({ event: openEvent(over), items: seedItems() });
    const error = await rejectionOf(approvePromptsCallable(request(VALID), false, deps(db)));
    expect(error.code).toBe('failed-precondition');
    expect(error.message).toBe('This Event is closed; approvals are frozen.');
    expect(db.writes()).toHaveLength(0);
  });

  it('aborted when Firestore gives up on contention (gRPC 10), in every spelling', async () => {
    for (const code of [10, '10', 'ABORTED', 'aborted']) {
      const db = makeDb({ event: openEvent(), items: seedItems() });
      const failing: AdminFirestore = {
        ...db,
        runTransaction: async () => {
          throw Object.assign(new Error('10 ABORTED: too much contention on these documents'), { code });
        },
      };
      const error = await rejectionOf(approvePromptsCallable(request(VALID), false, deps(db, { db: failing })));
      expect(error.code).toBe('aborted');
      expect(error.message).toBe('Another change collided with this approval; try again.');
    }
  });

  it('internal for anything else, logging the bounded code and never echoing the thrown value', async () => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    const secret = 'projects/p/databases/(default)/documents/events/med-2026/items/p1 is on fire';
    const failing: AdminFirestore = {
      ...db,
      runTransaction: async () => {
        throw Object.assign(new Error(secret), { code: 13 });
      },
    };
    const { logger, calls } = recordingLogger();
    const error = await rejectionOf(
      approvePromptsCallable(request(VALID), false, deps(db, { db: failing, logger })),
    );
    expect(error.code).toBe('internal');
    expect(error.message).toBe('Approval failed; try again.');
    expect(JSON.stringify(error)).not.toContain('on fire');
    expect(calls).toEqual([['approvePrompts failed', { code: 13 }]]);
    expect(JSON.stringify(calls)).not.toContain(secret);
  });

  it('per-row classification failures stay placements, not errors (#1070 row isolation survives the move)', async () => {
    const db = makeDb({ event: openEvent(), items: seedItems() });
    const res = await approvePromptsCallable(
      request({ eventId: EVENT_ID, items: [{ id: 'a', pool: 'easy' }, { id: 'b', pool: 'closing' }] }),
      false,
      deps(db),
    );
    expect(res.placements.map((p) => p.outcome)).toEqual(['placed', 'malformed']);
  });
});
