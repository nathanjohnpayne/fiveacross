import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isEventArchived, isEventArchiving } from './eventArchive';
import type { EventDoc } from '../types';

// specs/post-sailing-archive.md, unit layer (#1149, epic #134). The lifecycle
// primitive's client half: the quiesce that shuts gameplay, the generation id
// that says WHICH quiesce, and the flip bound to it.
//
// The write path's seam (Codex P2 on PR #1139). Both writes are transactions
// over ONE document, so the properties that matter are which state each read
// sees and what each transaction writes — exactly what a fake Firestore surface
// can hold and an emulator cannot. (The boundary half — that a superseded
// generation is denied by the RULES too, not only by a client that checks — is
// pinned in `tests/rules/post-sailing-archive.test.ts`.)
const A = vi.hoisted(() => ({
  event: undefined as Record<string, unknown> | undefined,
  /** Field maps handed to `tx.update` — empty means the call wrote nothing. */
  updates: [] as Record<string, unknown>[],
  /** Fired as the transaction opens, so a test can move the world underneath a
   *  call that has already decided what it is doing. */
  beforeTx: null as (() => void) | null,
}));

vi.mock('../firebase', () => ({ db: {}, functions: {}, EVENT_ID: 'test-event' }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  type Ref = { path: string; withConverter: () => Ref };
  const ref = (path: string): Ref => {
    const r: Ref = { path, withConverter: () => r };
    return r;
  };
  const snapOf = (path: string) => {
    const data = path === 'events/test-event' ? A.event : undefined;
    return { exists: () => data !== undefined, data: () => data, id: path.split('/').pop() ?? '' };
  };
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ref(segments.join('/')),
    collection: (_db: unknown, ...segments: string[]) => ref(segments.join('/')),
    runTransaction: async (_db: unknown, fn: (tx: unknown) => unknown) => {
      A.beforeTx?.();
      return fn({
        get: async (r: Ref) => snapOf(r.path),
        update: (_r: Ref, data: Record<string, unknown>) => {
          A.updates.push(data);
        },
      });
    },
  };
});

// Imported AFTER the mocks above, which vitest hoists.
import { abandonArchive, archiveEvent, beginArchive } from './admin';

describe('isEventArchived', () => {
  it('is true only for the literal archived status', () => {
    expect(isEventArchived({ status: 'archived' } as EventDoc)).toBe(true);
    expect(isEventArchived({ status: 'active' } as EventDoc)).toBe(false);
    // Absent means OPEN — every Event document written before #134 has no key,
    // and a missing status that read as archived would freeze the estate.
    expect(isEventArchived({} as EventDoc)).toBe(false);
    expect(isEventArchived(null)).toBe(false);
    expect(isEventArchived(undefined)).toBe(false);
  });
});

describe('isEventArchiving', () => {
  it('is true only for the literal closing flag', () => {
    expect(isEventArchiving({ archiving: true } as EventDoc)).toBe(true);
    expect(isEventArchiving({ archiving: false } as EventDoc)).toBe(false);
    expect(isEventArchiving({} as EventDoc)).toBe(false);
    expect(isEventArchiving(null)).toBe(false);
    expect(isEventArchiving(undefined)).toBe(false);
  });

  it('is independent of `isEventArchived` in both directions', () => {
    // A closing Event is shut and REVERSIBLE; an archived one clears the flag
    // and is carried by `status`, which is write-once. Neither implies the
    // other, and the Admin console is the surface that tells them apart.
    const closing = { status: 'active', archiving: true } as EventDoc;
    const archived = { status: 'archived', archiving: false } as EventDoc;
    expect(isEventArchived(closing)).toBe(false);
    expect(isEventArchiving(closing)).toBe(true);
    expect(isEventArchived(archived)).toBe(true);
    expect(isEventArchiving(archived)).toBe(false);
  });
});

describe('the quiesce is identified, and the flip is bound to the one it took', () => {
  const closingEvent = (over: Record<string, unknown> = {}) => ({
    status: 'active',
    archiving: true,
    archiveToken: 'quiesce-1',
    claimMode: 'honor',
    days: [],
    bannedUids: [],
    ...over,
  });

  beforeEach(() => {
    A.event = closingEvent();
    A.updates = [];
    A.beforeTx = null;
  });

  it('mints a generation id when it shuts the Event, and reports it back as CREATED', async () => {
    A.event = { status: 'active', days: [], bannedUids: [] };
    const opened = await beginArchive();
    expect(opened.result).toBe('closing');
    expect(A.updates).toHaveLength(1);
    expect(A.updates[0].archiving).toBe(true);
    expect(typeof A.updates[0].archiveToken).toBe('string');
    expect(A.updates[0].archiveToken as string).not.toBe('');
    // Reported to the caller, because the caller is what has to clean up after
    // a refused freeze — and a cleanup that cannot name the closing state it is
    // lifting can lift somebody else's (Codex P2, PR #1139).
    expect(opened.token).toBe(A.updates[0].archiveToken);
    // …and this call is the one that opened it, so it owns the cleanup.
    expect(opened.created).toBe(true);
  });

  it('keeps the generation id when the Event is already closing, and reports it as JOINED', async () => {
    // The call is idempotent and takes no new snapshot, so re-minting here
    // would abort an in-flight freeze that is still perfectly valid.
    const opened = await beginArchive();
    expect(opened.result).toBe('closing');
    expect(opened.token).toBe('quiesce-1');
    expect(A.updates[0].archiveToken).toBe('quiesce-1');
    // #1142 item 6: the token MATCHES, so a conditional reopen keyed on it alone
    // would happily clear a quiesce this call never took. `created` is the half
    // that stops it.
    expect(opened.created).toBe(false);
  });

  it('mints a fresh id for a closing state that carries none, and OWNS it', async () => {
    // The shape a pre-token build leaves behind: unidentified, so it gets an
    // identity rather than being bound to by guesswork. Minting one opens a new
    // generation, which is a create rather than a join.
    A.event = closingEvent({ archiveToken: undefined });
    const opened = await beginArchive();
    expect(opened.result).toBe('closing');
    expect(typeof A.updates[0].archiveToken).toBe('string');
    expect(A.updates[0].archiveToken).not.toBe('');
    expect(opened.created).toBe(true);
  });

  it('mints a NEW id for the next quiesce after an abandon', async () => {
    // The whole point of the ABA case: the generation after a reopen must not
    // be mistakable for the one before it.
    expect(await abandonArchive()).toBe('reopened');
    A.event = closingEvent({ archiving: false });
    const reshut = await beginArchive();
    expect(reshut.created).toBe(true);
    expect(A.updates[1].archiveToken).not.toBe('quiesce-1');
  });

  it('reports already-archived, and writes nothing, once the freeze has landed', async () => {
    A.event = { status: 'archived', archivedAt: 5, archiving: false };
    const opened = await beginArchive();
    expect(opened).toEqual({ result: 'already-archived', token: null, created: false });
    expect(await abandonArchive()).toBe('already-archived');
    expect(A.updates).toEqual([]);
  });

  it('reports no-event, and writes nothing, when there is no Event document', async () => {
    A.event = undefined;
    expect(await beginArchive()).toEqual({ result: 'no-event', token: null, created: false });
    expect(await abandonArchive()).toBe('no-event');
    expect(await archiveEvent('quiesce-1')).toBe('no-event');
    expect(A.updates).toEqual([]);
  });

  it('flips, and restates the generation it was bound to, when the quiesce holds', async () => {
    expect(await archiveEvent('quiesce-1', { now: 5 })).toBe('archived');
    expect(A.updates).toEqual([
      {
        status: 'archived',
        archivedAt: 5,
        archiving: false,
        // Restated so the RULES can hold the same binding at the boundary.
        // Writing the value it already has keeps the field out of
        // `affectedKeys()`, so the arm's `hasOnly` guard is unaffected.
        archiveToken: 'quiesce-1',
      },
    ]);
  });

  it('ABORTS, and writes nothing, when play was reopened and shut again underneath it', async () => {
    // A: the quiesce the caller took. B: play reopened, gameplay resumed, a
    // second archive begun. A's transaction sees `archiving: true` either way —
    // only the generation distinguishes them.
    A.beforeTx = () => {
      A.event = closingEvent({ archiveToken: 'quiesce-2' });
    };
    expect(await archiveEvent('quiesce-1', { now: 5 })).toBe('quiesce-changed');
    expect(A.updates).toEqual([]);
  });

  it('refuses a token it cannot bind to, before opening a transaction at all', async () => {
    // Blank or missing: not a generation this build can distinguish from
    // another, and the rules refuse the flip from an unidentified quiesce
    // besides — so it is refused here rather than attempted on a shut Event.
    for (const bad of ['', '   ']) {
      expect(await archiveEvent(bad, { now: 5 })).toBe('quiesce-changed');
    }
    expect(A.updates).toEqual([]);
  });

  it('reports not-closing when the quiesce was simply lifted', async () => {
    // The two failures are distinct: nothing in force at all, versus a
    // DIFFERENT one in force. Only the second must leave the Event shut.
    A.beforeTx = () => {
      A.event = closingEvent({ archiving: false });
    };
    expect(await archiveEvent('quiesce-1', { now: 5 })).toBe('not-closing');
    expect(A.updates).toEqual([]);
  });

  it('reports already-archived rather than re-stamping a freeze that already landed', async () => {
    // A double tap, or a second Admin's tap. The rules refuse the rewrite
    // besides; this is the client half of the same one-way property.
    A.event = { status: 'archived', archivedAt: 5, archiving: false, archiveToken: 'quiesce-1' };
    expect(await archiveEvent('quiesce-1', { now: 9 })).toBe('already-archived');
    expect(A.updates).toEqual([]);
  });

  it('never flips an Event that was never shut', async () => {
    A.event = { status: 'active', days: [], bannedUids: [] };
    expect(await archiveEvent('quiesce-1', { now: 5 })).toBe('not-closing');
    expect(A.updates).toEqual([]);
  });

  // Codex P2, PR #1139. `archiveEvent` compares the generation inside its own
  // transaction — but the console's cleanup runs AFTER it returns, and
  // everything the ABA case describes can happen in that gap too. An
  // unconditional reopen there clears a later Admin's quiesce out from under
  // their in-flight freeze, which is exactly what `quiesce-changed` refuses to
  // do one step earlier in the same handler.
  it('reopens only the quiesce it was asked to lift', async () => {
    expect(await abandonArchive('quiesce-1')).toBe('reopened');
    expect(A.updates).toEqual([{ archiving: false }]);
  });

  it('LEAVES a superseded quiesce alone, and writes nothing', async () => {
    // The Event was shut again by somebody else between the failed freeze and
    // this cleanup. Their closing state is theirs.
    A.event = closingEvent({ archiveToken: 'quiesce-2' });
    expect(await abandonArchive('quiesce-1')).toBe('quiesce-changed');
    expect(A.updates).toEqual([]);
  });

  it('cannot be laundered by an abandon that leaves the old token behind', async () => {
    // `abandonArchive` deliberately does not clear `archiveToken`, so the
    // matching path has to be proof against reopen-then-reshut: `beginArchive`
    // preserves a token only while the Event is STILL closing, and mints a
    // fresh one otherwise — so the stale caller's comparison fails.
    expect(await abandonArchive()).toBe('reopened');
    A.event = closingEvent({ archiving: false });
    const reshut = await beginArchive();
    A.event = closingEvent({ archiveToken: reshut.token as string });
    expect(await abandonArchive('quiesce-1')).toBe('quiesce-changed');
  });

  it('stays unconditional when no generation is named', async () => {
    // The console's own Reopen play button: a deliberate act on the Event in
    // front of the Admin, not a cleanup of a call that already failed.
    A.event = closingEvent({ archiveToken: 'quiesce-2' });
    expect(await abandonArchive()).toBe('reopened');
    expect(A.updates).toEqual([{ archiving: false }]);
  });
});
