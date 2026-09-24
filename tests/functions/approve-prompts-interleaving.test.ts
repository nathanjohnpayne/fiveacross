import { describe, it, expect } from 'vitest';
import { approvePromptsCore, type ApprovePromptsDeps } from '../../functions/src/approvePrompts';
import { resnapshotDayIfNoBoards, stampDaySnapshot, type AdminFirestore } from '../../functions/src/unlockDay';

// specs/community-prompt-targeting.md § "Why approval runs in a transaction"
// (#813, #1275, ADR 0015) — the phantom ordering, and the Event-doc fence that
// closes it.
//
// THE ORDERING. `stampDaySnapshot` reads its `status == 'active'` item query
// inside its own transaction, so a change to a document that query MATCHED
// forces a retry. A row flipping `pending -> active` is not such a document: it
// was absent from the result, so a transaction whose conflict detection is
// document-level never learns about it. The interleaving that follows commits
// quietly — the scheduler lists the pool (the Prompt is pending, so absent), the
// approval commits and reports "scheduled for Day N", the scheduler stamps the
// list it computed before the approval — and Day N's snapshot never lists the
// Prompt the organiser was told it would.
//
// THE FENCE. `approvePromptsCore` writes `approvalSeq` on the Event doc in the
// same transaction as the item writes. `stampDaySnapshot` reads AND updates that
// same document, so the two now conflict at the document level whichever
// commits first, and the loser re-runs against the state that won.
//
// THE FAKE below is conflict-retrying, extended from `RetryFirestore` in
// event-invitations.test.ts. It snapshots versions at read time, stages writes,
// and re-runs the callback when any READ document changed before commit. Its
// query read records versions ONLY for the documents the query matched — that
// is the phantom, modelled honestly, and it is what lets the negative control
// below reproduce #813 rather than merely asserting the fence is written. The
// production guarantee is Firestore's documented serializable isolation plus
// document-level locking; this suite proves the conflict KEY in a fake.

const EVENT_ID = 'med-2026';
const ADMIN = 'admin-uid';
const HOUR = 3_600_000;
/** Day 0's `unlockAt`: the instant the scheduler is due and the cutoff the
 *  snapshot filters approvals against. */
const U = 10 * HOUR;

type Doc = Record<string, unknown>;
type Stored = { data: Doc; version: number };
type StagedWrite = { path: string; data: Doc };

interface DocRefLike {
  __kind: 'doc';
  __path: string;
  get(): Promise<unknown>;
  set(data: Doc): Promise<unknown>;
}
interface QueryLike {
  __kind: 'query';
  __path: string;
  __filters: Array<[string, unknown]>;
  where(field: string, op: string, value: unknown): QueryLike;
  get(): Promise<unknown>;
  doc(id?: string): DocRefLike;
}

const DELETE = Object.freeze({ __sentinel: 'delete' });

class RetryDb implements AdminFirestore {
  readonly docs = new Map<string, Stored>();
  conflicts = 0;
  /** Fires after each attempt's callback and before its commit check. */
  beforeCommit?: (attempt: number) => Promise<void> | void;
  /** Fires when a transaction is entered, before its first attempt reads
   *  anything: the gap between a caller's pre-transaction reads and the
   *  transaction itself (#1280). */
  beforeTransaction?: () => Promise<void> | void;
  /** The NEGATIVE CONTROL: discard the approval's Event-doc fence write, so the
   *  suite can show what happens without it. Item writes still land. */
  dropApprovalFence = false;

  constructor(seed: Record<string, Doc>) {
    for (const [path, data] of Object.entries(seed)) this.docs.set(path, { data: { ...data }, version: 1 });
  }

  read(path: string): Doc | undefined {
    return this.docs.get(path)?.data;
  }

  private snapshot(path: string, reads?: Map<string, number>) {
    const stored = this.docs.get(path);
    reads?.set(path, stored?.version ?? 0);
    return {
      exists: stored !== undefined,
      id: path.split('/').pop() as string,
      data: () => (stored ? { ...stored.data } : undefined),
    };
  }

  private runQuery(query: QueryLike, reads?: Map<string, number>) {
    const prefix = `${query.__path}/`;
    const docs = [...this.docs.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .filter(([, stored]) => query.__filters.every(([field, value]) => stored.data[field] === value))
      .map(([path, stored]) => {
        // Only the documents the query MATCHED join the read set. A pending row
        // that a later approval flips active is not one of them: the phantom.
        reads?.set(path, stored.version);
        return { exists: true, id: path.slice(prefix.length), data: () => ({ ...stored.data }) };
      });
    return { docs };
  }

  doc(path: string): DocRefLike {
    return {
      __kind: 'doc',
      __path: path,
      get: async () => this.snapshot(path),
      set: async (data: Doc) => {
        const previous = this.docs.get(path);
        this.docs.set(path, { data: { ...data }, version: (previous?.version ?? 0) + 1 });
        return undefined;
      },
    };
  }

  collection(path: string): QueryLike {
    const filters: Array<[string, unknown]> = [];
    const query: QueryLike = {
      __kind: 'query',
      __path: path,
      __filters: filters,
      where(field, _op, value) {
        filters.push([field, value]);
        return query;
      },
      get: async () => this.runQuery(query),
      doc: (id?: string) => this.doc(`${path}/${id}`),
    };
    return query;
  }

  async runTransaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
    await this.beforeTransaction?.();
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const reads = new Map<string, number>();
      const staged: StagedWrite[] = [];
      const tx = {
        get: async (ref: DocRefLike | QueryLike) =>
          ref.__kind === 'query' ? this.runQuery(ref, reads) : this.snapshot(ref.__path, reads),
        update: (ref: DocRefLike, data: Doc) => staged.push({ path: ref.__path, data: { ...data } }),
        set: (ref: DocRefLike, data: Doc) => staged.push({ path: ref.__path, data: { ...data } }),
      };
      const result = await fn(tx as never);
      await this.beforeCommit?.(attempt);
      const conflicted = [...reads].some(([path, version]) => (this.docs.get(path)?.version ?? 0) !== version);
      if (conflicted) {
        this.conflicts += 1;
        continue;
      }
      for (const write of staged) {
        if (this.dropApprovalFence && 'approvalSeq' in write.data) continue;
        const previous = this.docs.get(write.path);
        if (!previous) throw new Error(`not found: ${write.path}`);
        const next = { ...previous.data };
        for (const [key, value] of Object.entries(write.data)) {
          if (value === DELETE) delete next[key];
          else next[key] = value;
        }
        this.docs.set(write.path, { data: next, version: previous.version + 1 });
      }
      return result;
    }
    throw new Error('transaction retry limit exceeded');
  }
}

/** A hook that fires on the FIRST attempt of the FIRST transaction to reach it
 *  and then disarms itself — the nested transaction it runs would otherwise
 *  re-enter the same hook and recurse. */
function once(db: RetryDb, work: () => Promise<void>): void {
  db.beforeCommit = async (attempt) => {
    if (attempt !== 1) return;
    db.beforeCommit = undefined;
    await work();
  };
}

const EVENT_PATH = `events/${EVENT_ID}`;
const P1 = `${EVENT_PATH}/items/p1`;

function seed(days: Doc[]): Record<string, Doc> {
  return {
    [EVENT_PATH]: { status: 'active', admins: [ADMIN], days },
    [P1]: { status: 'pending', pool: 'main', spicy: false, createdBy: 'player', createdAt: 1, reportCount: 0, targetDayIndex: 0 },
  };
}

const day0 = (): Doc => ({ index: 0, pool: 'main', unlockAt: U });
const day1 = (): Doc => ({ index: 1, pool: 'main', unlockAt: U + 24 * HOUR });

function approvalDeps(db: RetryDb, now: number): ApprovePromptsDeps {
  return { db, now: () => now, deleteField: () => DELETE };
}

const dayOf = (db: RetryDb, index: number) =>
  (db.read(EVENT_PATH)?.days as Doc[]).find((d) => d.index === index)!;

describe('the phantom ordering — scheduler first, approval lands before its commit', () => {
  it('with the fence, the scheduler retries and Day 0 lists the Prompt the approval reported for it', async () => {
    const db = new RetryDb(seed([day0()]));
    let placement: Awaited<ReturnType<typeof approvePromptsCore>> = [];
    // The approval runs INSIDE the scheduler's first attempt: after the scheduler
    // has listed the (still pending) pool and before it commits the list. Its
    // clock is one tick BEFORE Day 0's unlock, so Day 0 is still targetable and
    // the approval reports "scheduled for Day 0".
    once(db, async () => {
      placement = await approvePromptsCore(approvalDeps(db, U - 1), ADMIN, EVENT_ID, [{ id: 'p1' }]);
    });

    const result = await stampDaySnapshot(db, EVENT_ID, 0, { now: () => U + 1 });

    expect(placement).toEqual([{ itemId: 'p1', dayIndex: 0, retained: false, outcome: 'placed' }]);
    expect(result).toBe('stamped');
    // The scheduler's first attempt read the Event at version 1; the approval's
    // fence moved it, so the attempt was thrown away and re-run.
    expect(db.conflicts).toBe(1);
    // The re-run's query matched the now-active Prompt, and the snapshot names
    // the Day the approval promised.
    expect(dayOf(db, 0).snapshotItemIds).toEqual(['p1']);
    expect(db.read(P1)).toMatchObject({ status: 'active', approvedAt: U - 1, targetDayIndex: 0 });
    expect(db.read(EVENT_PATH)).toMatchObject({ approvalSeq: 1 });
  });

  it('NEGATIVE CONTROL: without the fence the same interleaving commits quietly and reproduces #813', async () => {
    const db = new RetryDb(seed([day0()]));
    db.dropApprovalFence = true;
    let placement: Awaited<ReturnType<typeof approvePromptsCore>> = [];
    once(db, async () => {
      placement = await approvePromptsCore(approvalDeps(db, U - 1), ADMIN, EVENT_ID, [{ id: 'p1' }]);
    });

    const result = await stampDaySnapshot(db, EVENT_ID, 0, { now: () => U + 1 });

    // The approval still reports Day 0, and the item really is active with an
    // approvedAt inside the cutoff …
    expect(placement).toEqual([{ itemId: 'p1', dayIndex: 0, retained: false, outcome: 'placed' }]);
    expect(db.read(P1)).toMatchObject({ status: 'active', approvedAt: U - 1 });
    // … but the scheduler's read set never included the pending row (a phantom),
    // so nothing forced a retry, and Day 0 froze the list computed before the
    // approval. The placement and the snapshot disagree: the misreport.
    expect(result).toBe('stamped');
    expect(db.conflicts).toBe(0);
    expect(dayOf(db, 0).snapshotItemIds).toEqual([]);
    expect(dayOf(db, 0).snapshotItemIds).not.toContain('p1');
    expect(db.read(EVENT_PATH)).not.toHaveProperty('approvalSeq');
  });
});

describe('the reverse ordering — approval first, scheduler stamps before its commit', () => {
  it('the approval retries against the stamped schedule and rolls forward to Day 1', async () => {
    const db = new RetryDb(seed([day0(), day1()]));
    let stamped: Awaited<ReturnType<typeof stampDaySnapshot>> | undefined;
    // The scheduler runs INSIDE the approval's first attempt: after the approval
    // has read the unstamped Day 0 and routed onto it, before it commits.
    once(db, async () => {
      stamped = await stampDaySnapshot(db, EVENT_ID, 0, { now: () => U + 1 });
    });

    const placements = await approvePromptsCore(approvalDeps(db, U - 1), ADMIN, EVENT_ID, [{ id: 'p1' }]);

    expect(stamped).toBe('stamped');
    // Day 0 froze WITHOUT the Prompt (it was pending when the scheduler read the
    // pool), which is the truth, and the approval's first attempt was discarded
    // because the Event it read had moved.
    expect(dayOf(db, 0).snapshotItemIds).toEqual([]);
    expect(db.conflicts).toBe(1);
    // The re-run saw Day 0 stamped, so it rolled the Prompt forward to Day 1 —
    // and said so, rather than reporting Day 0.
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: 1, retained: false, outcome: 'placed' }]);
    expect(db.read(P1)).toMatchObject({ status: 'active', targetDayIndex: 1 });
  });

  it('… or retains, when the stamped Day was the last one that could deal it', async () => {
    const db = new RetryDb(seed([day0()]));
    once(db, async () => {
      await stampDaySnapshot(db, EVENT_ID, 0, { now: () => U + 1 });
    });

    const placements = await approvePromptsCore(approvalDeps(db, U - 1), ADMIN, EVENT_ID, [{ id: 'p1' }]);

    expect(dayOf(db, 0).snapshotItemIds).toEqual([]);
    expect(db.conflicts).toBe(1);
    expect(placements).toEqual([{ itemId: 'p1', dayIndex: null, retained: true, outcome: 'retained' }]);
    expect(db.read(P1)).toMatchObject({ status: 'active', retainedAt: U - 1, targetDayIndex: 0 });
  });

  it('the frozen Day is never mutated by the approval on the way there', async () => {
    const db = new RetryDb(seed([day0(), day1()]));
    once(db, async () => {
      await stampDaySnapshot(db, EVENT_ID, 0, { now: () => U + 1 });
    });
    const frozenBefore = { ...dayOf(db, 0) };
    await approvePromptsCore(approvalDeps(db, U - 1), ADMIN, EVENT_ID, [{ id: 'p1' }]);
    // `frozenBefore` was captured before the hook ran, so re-read the stamp the
    // scheduler wrote and confirm the approval's commit left it exactly there.
    expect(frozenBefore.snapshotItemIds).toBeUndefined();
    expect(dayOf(db, 0)).toMatchObject({ index: 0, snapshotItemIds: [] });
    expect(dayOf(db, 1)).not.toHaveProperty('snapshotItemIds');
  });
});

// #1280 — the guarded re-snapshot (`resnapshotDayIfNoBoards`, reached through
// `unlockDayNow` with `resnapshot: true`) is the one path that OVERWRITES a
// Day's snapshot, and it used to compute its item list BEFORE its transaction
// opened. The fence above cannot protect a list computed outside the
// transaction: an approval committing in that gap was simply missing from the
// list the transaction wrote, and a retry forced by the fence re-ran the
// transaction around the same stale list. The list is now read through the
// transaction, beside the Event doc the fence moves, so both orderings below
// land the Prompt the approval reported for the Day.
describe('the guarded re-snapshot computes its list inside its transaction (#1280)', () => {
  /** A recoverable Day (index >= 3) and the Day after it. */
  const day3 = (): Doc => ({ index: 3, pool: 'main', unlockAt: U });
  const day4 = (): Doc => ({ index: 4, pool: 'main', unlockAt: U + 24 * HOUR });
  const M1 = `${EVENT_PATH}/items/m1`;

  function resnapshotSeed(): Record<string, Doc> {
    return {
      [EVENT_PATH]: { status: 'active', admins: [ADMIN], days: [day3(), day4()] },
      // An organiser Prompt already in the pool before the Day opened.
      [M1]: { status: 'active', pool: 'main', createdBy: ADMIN, createdAt: 1, reportCount: 0 },
      [P1]: { status: 'pending', pool: 'main', spicy: false, createdBy: 'player', createdAt: 1, reportCount: 0, targetDayIndex: 3 },
    };
  }

  /** Like `once`, for the gap BEFORE the transaction opens: fires on the first
   *  transaction to be entered and disarms itself first, so the approval's own
   *  transaction does not re-enter it. */
  function onceBeforeTransaction(db: RetryDb, work: () => Promise<void>): void {
    db.beforeTransaction = async () => {
      db.beforeTransaction = undefined;
      await work();
    };
  }

  it('an approval committed after the pre-flight reads and before the transaction opens is in the overwritten list', async () => {
    const db = new RetryDb(resnapshotSeed());
    let placement: Awaited<ReturnType<typeof approvePromptsCore>> = [];
    onceBeforeTransaction(db, async () => {
      placement = await approvePromptsCore(approvalDeps(db, U - 1), ADMIN, EVENT_ID, [{ id: 'p1' }]);
    });

    const result = await resnapshotDayIfNoBoards(db, ADMIN, EVENT_ID, 3, { now: () => U + 1 });

    expect(placement).toEqual([{ itemId: 'p1', dayIndex: 3, retained: false, outcome: 'placed' }]);
    expect(result).toBe('resnapshotted');
    // Nothing had to retry: the approval committed before the transaction read
    // anything. The list is right because the transaction read the pool itself.
    expect(db.conflicts).toBe(0);
    expect(dayOf(db, 3).snapshotItemIds).toEqual(['m1', 'p1']);
    expect(dayOf(db, 4)).not.toHaveProperty('snapshotItemIds');
  });

  it('an approval committed inside the first attempt forces a retry that re-reads the pool', async () => {
    const db = new RetryDb(resnapshotSeed());
    let placement: Awaited<ReturnType<typeof approvePromptsCore>> = [];
    once(db, async () => {
      placement = await approvePromptsCore(approvalDeps(db, U - 1), ADMIN, EVENT_ID, [{ id: 'p1' }]);
    });

    const result = await resnapshotDayIfNoBoards(db, ADMIN, EVENT_ID, 3, { now: () => U + 1 });

    expect(placement).toEqual([{ itemId: 'p1', dayIndex: 3, retained: false, outcome: 'placed' }]);
    expect(result).toBe('resnapshotted');
    // The fence moved the Event the first attempt read, so that attempt was
    // discarded; the re-run's own query now lists the Prompt. A list computed
    // before the transaction would have survived the retry unchanged.
    expect(db.conflicts).toBe(1);
    expect(dayOf(db, 3).snapshotItemIds).toEqual(['m1', 'p1']);
    expect(db.read(EVENT_PATH)).toMatchObject({ approvalSeq: 1 });
  });

  it('filters by the moderation settings of the Event the transaction read, not the pre-flight copy', async () => {
    const db = new RetryDb(resnapshotSeed());
    // The Prompt is already live; its author is banned while the re-snapshot's
    // first attempt is in flight.
    const p1 = db.docs.get(P1)!;
    db.docs.set(P1, { data: { ...p1.data, status: 'active', approvedAt: U - 1 }, version: p1.version });
    once(db, async () => {
      await db.doc(EVENT_PATH).set({ ...db.read(EVENT_PATH)!, bannedUids: ['player'] });
    });

    const result = await resnapshotDayIfNoBoards(db, ADMIN, EVENT_ID, 3, { now: () => U + 1 });

    expect(result).toBe('resnapshotted');
    expect(db.conflicts).toBe(1);
    expect(dayOf(db, 3).snapshotItemIds).toEqual(['m1']);
  });

  it('keeps the zero-boards guard: a dealt card still refuses the overwrite', async () => {
    const db = new RetryDb({
      ...resnapshotSeed(),
      [`${EVENT_PATH}/days/3/boards/someone`]: { dealtAt: U },
    });
    // Stamp Day 3 first so the refusal is visibly a refusal to OVERWRITE.
    const ev = db.docs.get(EVENT_PATH)!;
    db.docs.set(EVENT_PATH, {
      data: { ...ev.data, days: [{ ...day3(), snapshotItemIds: ['m1'] }, day4()] },
      version: ev.version,
    });

    const result = await resnapshotDayIfNoBoards(db, ADMIN, EVENT_ID, 3, { now: () => U + 1 });

    expect(result).toBe('has-boards');
    expect(dayOf(db, 3).snapshotItemIds).toEqual(['m1']);
  });
});
