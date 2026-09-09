import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveInstant,
  archiveSnapshotFingerprint,
  buildEventArchive,
  draftEventArchive,
  finaleHasRun,
  isEventArchived,
  isEventArchiving,
  withReadableDayStats,
  MAX_ARCHIVE_NUMBER,
  MAX_ARCHIVED_DISPLAY_NAME,
  MAX_ARCHIVED_EVENT_NAME,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVED_EVENT_BYTES,
  MAX_ARCHIVED_STANDING_ROWS,
  MAX_ARCHIVED_UID,
  writableArchiveRecord,
} from './eventArchive';
import { buildPodium, dayHonorChipLabel, pinnedOrDerivedDailyHonors } from './finale';
import { MAX_DAYS } from './eventLimits';
import { comparePlayers } from '../game/logic';
import { migrateDayFields, playerConverter } from './converters';
import type { DayDef, DayMetaDoc, EventDoc, PlayerDoc } from '../types';

// specs/post-sailing-archive.md, unit layer (#1149 and #1151, epic #134). The
// lifecycle primitive's client half — the quiesce that shuts gameplay, the
// generation that says WHICH quiesce, and the flip bound to it — plus the
// durable record that flip now carries.
//
// The write path's seam (Codex P2 on PR #1139). The freeze is a sequence of
// server reads followed by a transaction over ONE document, so the properties
// that matter are which state each read sees, in what order, and what the
// transaction writes — exactly what a fake Firestore surface can hold and an
// emulator cannot. (The boundary half — that a superseded generation and an
// incomplete record are denied by the RULES too, not only by a client that
// checks — is pinned in `tests/rules/post-sailing-archive.test.ts`.)
const A = vi.hoisted(() => ({
  event: undefined as Record<string, unknown> | undefined,
  claims: [] as Record<string, unknown>[],
  /** Seeded roster rows. `id` is this fake's DOCUMENT-ID channel (#1151, Codex
   *  P1 on PR #1162) — it is not a `PlayerDoc` field, and it defaults to the
   *  row's own stored `uid`, which is what every honest row carries. A row that
   *  sets the two apart is the hostile shape the rules permit: `players/{uid}`
   *  binds the PATH and validates nothing inside the document. */
  players: [] as Array<Record<string, unknown> & { id?: string }>,
  dayMetas: new Map<number, Record<string, unknown>>(),
  /** Field maps handed to `tx.update` — empty means the call wrote nothing. */
  updates: [] as Record<string, unknown>[],
  /** Every server-read path, in order, so "after the close" is provable. */
  serverReads: [] as string[],
  /** Fired as the transaction opens, so a test can move the world underneath a
   *  call that has already decided what it is doing. */
  beforeTx: null as (() => void) | null,
  /** Which SERVER read paths reject, so the freeze can be observed against a read
   *  that does not answer at all (CodeRabbit Major on PR #1162). Every one of them
   *  is taken after the Event is already shut, so the difference between a typed
   *  refusal and a throw is the difference between a console that puts play back
   *  and one that leaves a live Event closed forever. */
  failServerRead: null as ((path: string) => boolean) | null,
  /** The TRANSACTION's own Event read, failed separately: it is the one read whose
   *  rejection has to be told apart from a failed COMMIT, which must keep
   *  surfacing. */
  failTxRead: false,
  /** The COMMIT failing — the control for the line above. */
  failTxWrite: false,
}));

vi.mock('../firebase', () => ({ db: {}, functions: {}, EVENT_ID: 'test-event' }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  // The roster read is the ONE read below that production takes through a
  // CONVERTER-attached reference (`playersCol()`), and that converter is what
  // pins `PlayerDoc.uid` to the document id (#1151, Codex P1 on PR #1162). The
  // fake applies it for the same reason it re-reads the Event raw: otherwise
  // this suite would prove the freeze reads a field the real one never sees.
  const { playerConverter } = await import('./converters');
  type Ref = { path: string; withConverter: () => Ref };
  const ref = (path: string): Ref => {
    const r: Ref = { path, withConverter: () => r };
    return r;
  };
  const dayMetaAt = (path: string): Record<string, unknown> | undefined => {
    const m = /^events\/test-event\/days\/(\d+)\/meta\/\d+$/.exec(path);
    return m ? A.dayMetas.get(Number(m[1])) : undefined;
  };
  const docAt = (path: string) =>
    path === 'events/test-event' ? A.event : dayMetaAt(path);
  const snapOf = (path: string) => {
    const data = docAt(path);
    return { exists: () => data !== undefined, data: () => data, id: path.split('/').pop() ?? '' };
  };
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ref(segments.join('/')),
    collection: (_db: unknown, ...segments: string[]) => ref(segments.join('/')),
    getDocFromServer: async (r: Ref) => {
      A.serverReads.push(r.path);
      if (A.failServerRead?.(r.path)) throw new Error(`read failed: ${r.path}`);
      return snapOf(r.path);
    },
    getDocsFromServer: async (r: Ref) => {
      A.serverReads.push(r.path);
      if (A.failServerRead?.(r.path)) throw new Error(`read failed: ${r.path}`);
      if (r.path.endsWith('/players')) {
        return {
          docs: A.players.map(({ id, ...stored }) => {
            const snap = {
              exists: () => true,
              id: (id ?? stored.uid) as string,
              data: () => stored,
            };
            return { ...snap, data: () => playerConverter.fromFirestore(snap as never) };
          }),
        };
      }
      const rows = r.path.endsWith('/claims') ? A.claims : [];
      return { docs: rows.map((row) => ({ exists: () => true, data: () => row })) };
    },
    runTransaction: async (_db: unknown, fn: (tx: unknown) => unknown) => {
      A.beforeTx?.();
      return fn({
        get: async (r: Ref) => {
          if (A.failTxRead) throw new Error(`transactional read failed: ${r.path}`);
          return snapOf(r.path);
        },
        update: (_r: Ref, data: Record<string, unknown>) => {
          if (A.failTxWrite) throw new Error('commit failed');
          A.updates.push(data);
        },
      });
    },
  };
});

// Imported AFTER the mocks above, which vitest hoists.
import { abandonArchive, archiveEvent, beginArchive } from './admin';

// The failure knobs are cleared for EVERY case in this file, not just the block
// that uses them: a read left rejecting would fail the next suite somewhere far
// from the line that armed it (CodeRabbit Major on PR #1162).
beforeEach(() => {
  A.failServerRead = null;
  A.failTxRead = false;
  A.failTxWrite = false;
});

function mkPlayer(
  over: Partial<PlayerDoc> & Pick<PlayerDoc, 'uid' | 'displayName'>,
): PlayerDoc {
  return {
    photoURL: null,
    joinedAt: 0,
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    reshufflesUsed: 0,
    ...over,
  };
}

function mkDay(index: number, over: Partial<DayDef> = {}): DayDef {
  return {
    index,
    date: `2026-07-${String(15 + index).padStart(2, '0')}`,
    place: 'Somewhere',
    placeEmoji: '🏖️',
    theme: 'neon-playground',
    tonight: [],
    pool: 'main',
    tutorial: false,
    unlockAt: 1000 * (index + 1),
    ...over,
  } as DayDef;
}

const DAYS = [mkDay(0, { tutorial: true }), mkDay(1), mkDay(2)];

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
    archiveToken: 1,
    claimMode: 'honor',
    days: [],
    bannedUids: [],
    ...over,
  });

  beforeEach(() => {
    A.event = closingEvent();
    A.claims = [];
    A.players = [];
    A.dayMetas = new Map();
    A.updates = [];
    A.serverReads = [];
    A.beforeTx = null;
  });

  it('mints generation 1 when it shuts an Event that has never closed, and reports it as CREATED', async () => {
    A.event = { status: 'active', days: [], bannedUids: [] };
    const opened = await beginArchive();
    expect(opened.result).toBe('closing');
    expect(A.updates).toHaveLength(1);
    expect(A.updates[0].archiving).toBe(true);
    expect(A.updates[0].archiveToken).toBe(1);
    // Reported to the caller, because the caller is what has to clean up after
    // a refused freeze — and a cleanup that cannot name the closing state it is
    // lifting can lift somebody else's (Codex P2, PR #1139).
    expect(opened.token).toBe(A.updates[0].archiveToken);
    // …and this call is the one that opened it, so it owns the cleanup.
    expect(opened.created).toBe(true);
  });

  it('mints STORED + 1 on an Event that has closed before, inside the transaction', async () => {
    // Phase 4b P1, PR #1157 run 4. The rules require every shut to install a
    // generation strictly ABOVE the stored one, so the client has to read the
    // stored value to know what to write — and it reads it inside the
    // transaction that writes, which is what serializes two Admins closing at
    // once: the loser re-runs against the winner's value rather than writing
    // the same counter twice.
    A.event = { status: 'active', archiving: false, archiveToken: 7, days: [], bannedUids: [] };
    const opened = await beginArchive();
    expect(A.updates).toEqual([{ archiving: true, archiveToken: 8 }]);
    expect(opened).toEqual({ result: 'closing', token: 8, created: true, eventId: 'test-event' });
  });

  it('keeps the generation id when the Event is already closing, and reports it as JOINED', async () => {
    // The call is idempotent and takes no new snapshot, so re-minting here
    // would abort an in-flight freeze that is still perfectly valid.
    const opened = await beginArchive();
    expect(opened.result).toBe('closing');
    expect(opened.token).toBe(1);
    expect(A.updates[0].archiveToken).toBe(1);
    // #1142 item 6: the token MATCHES, so a conditional reopen keyed on it alone
    // would happily clear a quiesce this call never took. `created` is the half
    // that stops it.
    expect(opened.created).toBe(false);
  });

  it('mints a generation for a closing state that carries none, and OWNS it', async () => {
    // The shape a build older than the counter leaves behind: unidentified, so
    // it gets an identity rather than being bound to by guesswork. Minting one
    // opens a new generation, which is a create rather than a join.
    A.event = closingEvent({ archiveToken: undefined });
    const opened = await beginArchive();
    expect(opened.result).toBe('closing');
    expect(A.updates[0].archiveToken).toBe(1);
    expect(opened.created).toBe(true);
  });

  it('steps PAST a stored value the counter cannot use, rather than restarting under it', async () => {
    // A legacy string, and a hand-written fraction. Neither is a generation the
    // rules can bind a flip to, so both are replaced — but the replacement must
    // still exceed the NUMBER the rules read there, or the repair would hand
    // back generations that had already been passed (Phase 4b P1, run 4).
    A.event = closingEvent({ archiveToken: 'quiesce-1' });
    expect((await beginArchive()).token).toBe(1);
    A.updates = [];
    A.event = closingEvent({ archiveToken: 5.5 });
    expect((await beginArchive()).token).toBe(6);
  });

  it('mints a HIGHER generation for the next quiesce after an abandon', async () => {
    // The whole point of the ABA case: the generation after a reopen must not
    // be mistakable for the one before it — and, since the rules can only
    // compare against the one value the document carries, it must be above it
    // rather than merely different.
    expect(await abandonArchive()).toBe('reopened');
    A.event = closingEvent({ archiving: false });
    const reshut = await beginArchive();
    expect(reshut.created).toBe(true);
    expect(reshut.token).toBe(2);
    expect(A.updates[1].archiveToken).toBe(2);
  });

  it('reports already-archived, and writes nothing, once the freeze has landed', async () => {
    A.event = { status: 'archived', archivedAt: 5, archiving: false };
    const opened = await beginArchive();
    expect(opened).toEqual({
      result: 'already-archived',
      token: null,
      created: false,
      eventId: 'test-event',
    });
    expect(await abandonArchive()).toBe('already-archived');
    expect(A.updates).toEqual([]);
  });

  it('reports no-event, and writes nothing, when there is no Event document', async () => {
    A.event = undefined;
    expect(await beginArchive()).toEqual({
      result: 'no-event',
      token: null,
      created: false,
      // Reported even where nothing was written: the id is what the call LOOKED
      // at, and the caller threads it into the freeze and the cleanup (#1142
      // item 7).
      eventId: 'test-event',
    });
    expect(await abandonArchive()).toBe('no-event');
    expect(await archiveEvent(1)).toBe('no-event');
    expect(A.updates).toEqual([]);
  });

  it('flips, and binds the record to the generation it took, when the quiesce holds', async () => {
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.updates).toEqual([
      {
        status: 'archived',
        archivedAt: 5,
        archiving: false,
        // The BINDING, written to a flip-only field so the RULES can hold the
        // same check this transaction just made (Phase 4b P1 on PR #1157, run
        // 3): a field the document does not carry until the flip cannot be
        // inherited by a write that omits it.
        archivedUnder: 1,
        // …and the durable record, in the SAME update (#1151). One update on one
        // document is the whole atomicity requirement: no reader may ever see an
        // archived Event with no record, or a record on a live one.
        archive: {
          eventName: null,
          standings: [],
          playerCount: 0,
          firstBingo: null,
          firstBingoRow: null,
          dailyHonors: [],
          freezeAt: null,
          // Always equal to the stamp beside it — `firestore.rules` requires the
          // two to agree, and they are written from one value.
          archivedAt: 5,
        },
      },
    ]);
  });

  it('ABORTS, and writes nothing, when play was reopened and shut again underneath it', async () => {
    // A: the quiesce the caller took. B: play reopened, gameplay resumed, a
    // second archive begun. A's transaction sees `archiving: true` either way —
    // only the generation distinguishes them.
    A.beforeTx = () => {
      A.event = closingEvent({ archiveToken: 2 });
    };
    expect(await archiveEvent(1, { now: 5 })).toBe('quiesce-changed');
    expect(A.updates).toEqual([]);
  });

  it('refuses a DELAYED flip carrying a generation two quiesces old', async () => {
    // Phase 4b P1, PR #1157 run 4, the client half of the replay the counter
    // ends. Play was shut as 1, reopened, shut as 2, reopened and shut as 3 —
    // and the caller that took 1 is still holding it. Under an opaque token the
    // rules could only see that 1 was not 3; here the transaction sees that the
    // generation in force is not the one it was handed, and writes nothing.
    A.event = closingEvent({ archiveToken: 3 });
    expect(await archiveEvent(1, { now: 5 })).toBe('quiesce-changed');
    expect(A.updates).toEqual([]);
    // The one actually in force still flips, so the refusal is about the
    // binding rather than about the delay.
    expect(await archiveEvent(3, { now: 5 })).toBe('archived');
  });

  it('refuses a generation it cannot bind to, before opening a transaction at all', async () => {
    // Not a positive integer: not a generation this build can order against,
    // and the rules refuse the flip from an unidentified quiesce besides — so
    // it is refused here rather than attempted on a shut Event. The string is
    // the value an Event shut by a build older than the counter carries, which
    // no type annotation stops arriving at runtime.
    for (const bad of [0, -1, 1.5, Number.NaN, 'quiesce-1' as unknown as number]) {
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
    expect(await archiveEvent(1, { now: 5 })).toBe('not-closing');
    expect(A.updates).toEqual([]);
  });

  it('reports already-archived rather than re-stamping a freeze that already landed', async () => {
    // A double tap, or a second Admin's tap. The rules refuse the rewrite
    // besides; this is the client half of the same one-way property.
    A.event = { status: 'archived', archivedAt: 5, archiving: false, archiveToken: 1 };
    expect(await archiveEvent(1, { now: 9 })).toBe('already-archived');
    expect(A.updates).toEqual([]);
  });

  it('never flips an Event that was never shut', async () => {
    A.event = { status: 'active', days: [], bannedUids: [] };
    expect(await archiveEvent(1, { now: 5 })).toBe('not-closing');
    expect(A.updates).toEqual([]);
  });

  // Codex P2, PR #1139. `archiveEvent` compares the generation inside its own
  // transaction — but the console's cleanup runs AFTER it returns, and
  // everything the ABA case describes can happen in that gap too. An
  // unconditional reopen there clears a later Admin's quiesce out from under
  // their in-flight freeze, which is exactly what `quiesce-changed` refuses to
  // do one step earlier in the same handler.
  it('reopens only the quiesce it was asked to lift', async () => {
    expect(await abandonArchive(1)).toBe('reopened');
    expect(A.updates).toEqual([{ archiving: false }]);
  });

  it('LEAVES a superseded quiesce alone, and writes nothing', async () => {
    // The Event was shut again by somebody else between the failed freeze and
    // this cleanup. Their closing state is theirs.
    A.event = closingEvent({ archiveToken: 2 });
    expect(await abandonArchive(1)).toBe('quiesce-changed');
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
    A.event = closingEvent({ archiveToken: reshut.token as number });
    expect(await abandonArchive(1)).toBe('quiesce-changed');
  });

  it('stays unconditional when no generation is named', async () => {
    // The console's own Reopen play button: a deliberate act on the Event in
    // front of the Admin, not a cleanup of a call that already failed.
    A.event = closingEvent({ archiveToken: 2 });
    expect(await abandonArchive()).toBe('reopened');
    expect(A.updates).toEqual([{ archiving: false }]);
  });
});

// ---------------------------------------------------------------------------
// #1151 — the durable record. Everything below is about what the flip CARRIES.
// ---------------------------------------------------------------------------

describe('buildEventArchive — the standings are COPIED, not recomputed', () => {
  it('takes each row straight off the Player-written stats, even when the per-Day buckets disagree', () => {
    // A row whose root totals do not equal the sum of its own `dayStats` is the
    // exact state ADR 0001 refuses to "fix": the Player wrote both, and the
    // archive records what the Leaderboard showed rather than adjudicating.
    const drifted = mkPlayer({
      uid: 'drifted',
      displayName: 'Drifted',
      bingoCount: 3,
      squaresMarked: 20,
      firstBingoAt: 5000,
      blackout: true,
      dayStats: { 1: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 5000 } },
    });
    const archive = buildEventArchive({
      players: [drifted],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 42,
    });
    expect(archive.standings).toEqual([
      {
        uid: 'drifted',
        displayName: 'Drifted',
        bingoCount: 3,
        squaresMarked: 20,
        blackout: true,
        firstBingoAt: 5000,
      },
    ]);
    expect(archive.archivedAt).toBe(42);
    expect(archive.playerCount).toBe(1);
  });

  it('is PURE — the same inputs give a byte-identical record, twice', () => {
    // No clock, no Firestore, no module state: `archivedAt` is supplied, so the
    // console's preview and the writer's commit cannot drift, and a record built
    // twice from one roster is the same record.
    const args = {
      players: [mkPlayer({ uid: 'a', displayName: 'A', squaresMarked: 3 })],
      event: { days: DAYS, bannedUids: [] as string[] },
      archivedAt: 7,
    };
    expect(JSON.stringify(buildEventArchive(args))).toBe(
      JSON.stringify(buildEventArchive(args)),
    );
    // …and it does not mutate its input roster, which the console re-renders.
    const players = [mkPlayer({ uid: 'a', displayName: 'A', squaresMarked: 3 })];
    const before = JSON.stringify(players);
    buildEventArchive({ players, event: { days: DAYS, bannedUids: [] }, archivedAt: 7 });
    expect(JSON.stringify(players)).toBe(before);
  });

  it('ranks the rows itself, so an unsorted roster still freezes in Leaderboard order', () => {
    const top = mkPlayer({ uid: 'top', displayName: 'Top', bingoCount: 3, squaresMarked: 20 });
    const mid = mkPlayer({ uid: 'mid', displayName: 'Mid', bingoCount: 1, squaresMarked: 18 });
    const low = mkPlayer({ uid: 'low', displayName: 'Low', bingoCount: 1, squaresMarked: 9 });
    const archive = buildEventArchive({
      players: [low, top, mid],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['top', 'mid', 'low']);
  });

  it('bounds the retained rows while playerCount records the true roster size', () => {
    const players = Array.from({ length: 5 }, (_, i) =>
      mkPlayer({ uid: `p${i}`, displayName: `P${i}`, squaresMarked: 10 - i }),
    );
    const archive = buildEventArchive({
      players,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      maxRows: 2,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['p0', 'p1']);
    expect(archive.playerCount).toBe(5);
    // The shipped cap is far above any real roster, so nothing is dropped in
    // practice — the bound exists to keep the Event document writable.
    expect(MAX_ARCHIVED_STANDING_ROWS).toBeGreaterThan(100);
  });

  // Codex P2, PR #1139. `EventDoc.name` is outside the write-once clause, so the
  // archived Share Card would rebuild its title from a field an Admin can still
  // edit — the same drift the honour chip labels were frozen to stop.
  it('freezes the Event name the archived card is titled with', () => {
    const archive = buildEventArchive({
      players: [mkPlayer({ uid: 'a', displayName: 'A' })],
      event: { name: '  Med 2026  ', days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    // Trimmed, like every other name the record carries.
    expect(archive.eventName).toBe('Med 2026');
  });

  it('bounds the frozen Event name, and stores null when there is none', () => {
    // `EventDoc.name` is admin-written and unvalidated at the rules boundary, so
    // it lands in the same 1 MiB budget as everything else in the record.
    const long = buildEventArchive({
      players: [],
      event: { name: 'N'.repeat(MAX_ARCHIVED_EVENT_NAME + 40), days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(long.eventName).toHaveLength(MAX_ARCHIVED_EVENT_NAME);

    // No name, or a blank one: `null` rather than a stand-in. The Share Card
    // already falls back to the app's own name for an unnamed Event, and
    // inventing one here would freeze a name nobody chose.
    for (const name of [undefined, '', '   ', 7 as unknown as string]) {
      expect(
        buildEventArchive({
          players: [],
          event: { name, days: DAYS, bannedUids: [] },
          archivedAt: 1,
        }).eventName,
      ).toBeNull();
    }
  });
});

describe('buildEventArchive — the hall of fame', () => {
  const early = mkPlayer({
    uid: 'early',
    displayName: 'Early',
    bingoCount: 1,
    squaresMarked: 5,
    firstBingoAt: 2000,
    dayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 2000 } },
  });
  const tutorialOnly = mkPlayer({
    uid: 'tutorial-only',
    displayName: 'Tutorial Only',
    bingoCount: 1,
    squaresMarked: 4,
    firstBingoAt: 500,
    dayStats: { 0: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 500 } },
  });

  it('never credits a Tutorial Day bingo with the headline honour', () => {
    const archive = buildEventArchive({
      players: [tutorialOnly, early],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    // `tutorialOnly` bingoed earlier in wall-clock terms (500 < 2000) and on a
    // Tutorial Day, so the honour is Early's.
    expect(archive.firstBingo).toEqual({ uid: 'early', displayName: 'Early', at: 2000 });
  });

  it('applies the resolved Standings Freeze as the cutoff', () => {
    const late = mkPlayer({
      uid: 'late',
      displayName: 'Late',
      bingoCount: 1,
      squaresMarked: 3,
      firstBingoAt: 9000,
      dayStats: { 2: { bingoCount: 1, squaresMarked: 3, firstBingoAt: 9000 } },
    });
    const frozen = buildEventArchive({
      players: [late],
      event: { days: DAYS, bannedUids: [], frozenAt: 8000 },
      archivedAt: 1,
    });
    expect(frozen.freezeAt).toBe(8000);
    expect(frozen.firstBingo).toBeNull();
    // Without a freeze there is no cutoff, which is every Event that never had
    // one — the pre-ADR-0011 behaviour, unchanged.
    const open = buildEventArchive({
      players: [late],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(open.freezeAt).toBeNull();
    expect(open.firstBingo?.uid).toBe('late');
  });

  it('prefers a pinned day-meta honour and falls back to the derived one', () => {
    const dayMetas = new Map<number, DayMetaDoc>([
      [1, { firstBingo: { uid: 'pinned', displayName: 'Pinned', at: 1500 } }],
    ]);
    const archive = buildEventArchive({
      players: [
        early,
        mkPlayer({
          uid: 'pinned',
          displayName: 'Pinned',
          bingoCount: 1,
          squaresMarked: 9,
          firstBingoAt: 1500,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 9, firstBingoAt: 1500 } },
        }),
        mkPlayer({
          uid: 'day2',
          displayName: 'Day Two',
          bingoCount: 1,
          squaresMarked: 2,
          firstBingoAt: 7000,
          dayStats: { 2: { bingoCount: 1, squaresMarked: 2, firstBingoAt: 7000 } },
        }),
      ],
      event: { days: DAYS, bannedUids: [] },
      dayMetas,
      archivedAt: 1,
    });
    expect(archive.dailyHonors).toEqual([
      // The chip LABEL is frozen alongside the honour (#1139): the Day's theme
      // emoji plus its ordinal, resolved once from the schedule the record was
      // taken against, so re-theming that Day later cannot re-label it.
      { dayIndex: 1, uid: 'pinned', displayName: 'Pinned', firstBingoAt: 1500, dayLabel: '🌈 D2' },
      { dayIndex: 2, uid: 'day2', displayName: 'Day Two', firstBingoAt: 7000, dayLabel: '🌈 D3' },
    ]);
  });

  // #1146 / #1142 item 8. `pinnedOrDerivedDailyHonors` used to hide a pin whose
  // holder was absent from the supplied roster, which read roster ABSENCE as a
  // ban — so an Admin deleting a Player row left that Player's honour on the
  // live Leaderboard strip (which checks `bannedUids` explicitly) and dropped it
  // from the record PERMANENTLY. The two now share one selection.
  it('KEEPS a pinned honour whose holder no longer has a Player row', () => {
    const archive = buildEventArchive({
      players: [early],
      event: { days: DAYS, bannedUids: [] },
      dayMetas: new Map<number, DayMetaDoc>([
        [1, { firstBingo: { uid: 'departed', displayName: 'Departed', at: 1200 } }],
      ]),
      archivedAt: 1,
    });
    expect(archive.dailyHonors).toEqual([
      {
        dayIndex: 1,
        uid: 'departed',
        displayName: 'Departed',
        firstBingoAt: 1200,
        dayLabel: '🌈 D2',
      },
    ]);
    // The pin still wins over the derived runner-up on the same Day, exactly as
    // the live strip resolves it.
    expect(archive.dailyHonors.map((h) => h.uid)).not.toContain('early');
  });

  it('still hides a pinned honour whose holder is BANNED — the control', () => {
    const archive = buildEventArchive({
      players: [early],
      event: { days: DAYS, bannedUids: ['departed'] },
      dayMetas: new Map<number, DayMetaDoc>([
        [1, { firstBingo: { uid: 'departed', displayName: 'Departed', at: 1200 } }],
      ]),
      archivedAt: 1,
    });
    // Hidden, never reassigned: the Day gets no chip rather than the derived
    // runner-up's name.
    expect(archive.dailyHonors).toEqual([]);
  });

  // Codex P2, PR #1139. The two bounds are independent — `standings` is cut by
  // RANK, the honour is decided by who bingoed EARLIEST — so the holder can fall
  // outside the retained prefix, and the Share Card's pinned eleventh row would
  // then have nothing to build from.
  it('keeps the headline holder’s own row and true rank outside the bounded prefix', () => {
    const players = Array.from({ length: 5 }, (_, i) =>
      mkPlayer({
        uid: `p${i}`,
        displayName: `P${i}`,
        bingoCount: 5 - i,
        squaresMarked: 50 - i,
        // The LAST-ranked Player bingoed first.
        firstBingoAt: 5000 - i,
        dayStats: { 1: { bingoCount: 5 - i, squaresMarked: 50 - i, firstBingoAt: 5000 - i } },
      }),
    );
    const archive = buildEventArchive({
      players,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      maxRows: 2,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['p0', 'p1']);
    expect(archive.firstBingo?.uid).toBe('p4');
    // Rank 5 of 5, not a position inside the two rows that were retained.
    expect(archive.firstBingoRow).toEqual({
      uid: 'p4',
      displayName: 'P4',
      bingoCount: 1,
      squaresMarked: 46,
      blackout: false,
      firstBingoAt: 4996,
      rank: 5,
    });
  });

  it('carries no headline row when there is no headline honour', () => {
    // `firstBingo` and `firstBingoRow` are selected together and neither
    // survives the other — a record naming a holder it cannot print is the
    // half-built map the rules arm refuses.
    const archive = buildEventArchive({
      players: [mkPlayer({ uid: 'nobody', displayName: 'Nobody' })],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(archive.firstBingo).toBeNull();
    expect(archive.firstBingoRow).toBeNull();
  });

  // Codex P2, PR #1139 round 4. The archived honours strip used to look each
  // Day's theme emoji up in the LIVE `EventDoc.days`, which the freeze
  // deliberately leaves editable — so an Admin re-theming a Day after the
  // archive silently re-labelled a frozen honour. The label is resolved once,
  // here, and stored.
  it('freezes the Day chip label each honour renders under', () => {
    const days = [mkDay(0, { theme: 'get-sporty' }), mkDay(1, { theme: 'neon-playground' })];
    const archive = buildEventArchive({
      players: [
        mkPlayer({
          uid: 'd0',
          displayName: 'Day Nought',
          bingoCount: 1,
          squaresMarked: 3,
          firstBingoAt: 500,
          dayStats: { 0: { bingoCount: 1, squaresMarked: 3, firstBingoAt: 500 } },
        }),
        mkPlayer({
          uid: 'd1',
          displayName: 'Day One',
          bingoCount: 1,
          squaresMarked: 4,
          firstBingoAt: 900,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 900 } },
        }),
      ],
      event: { days, bannedUids: [] },
      archivedAt: 1,
    });
    // The live strip's own derivation (`dayHonorChipLabel`), reused rather than
    // restated, so the frozen label IS the label the last live strip rendered.
    expect(archive.dailyHonors.map((h) => h.dayLabel)).toEqual(['🏋️ D1', '🌈 D2']);
    expect(archive.dailyHonors.map((h) => h.dayLabel)).toEqual(
      archive.dailyHonors.map((h) => dayHonorChipLabel(h.dayIndex, days)),
    );
    // Re-theming the Day AFTERWARDS moves the live label and leaves the frozen
    // one exactly where it was: the record is what the archived strip renders.
    const rethemed = [mkDay(0, { theme: 'neon-playground' }), mkDay(1, { theme: 'get-sporty' })];
    expect(dayHonorChipLabel(0, rethemed)).toBe('🌈 D1');
    expect(archive.dailyHonors[0].dayLabel).toBe('🏋️ D1');
  });

  it('labels an honour on a Day the schedule does not carry by its ordinal alone', () => {
    // The derived fallback: with no schedule there is no theme to read, so the
    // chip is the Day's own ordinal — which is what the live strip shows for the
    // same Day, and which nothing can later re-theme.
    const archive = buildEventArchive({
      players: [
        mkPlayer({
          uid: 'orphan',
          displayName: 'Orphan',
          bingoCount: 1,
          squaresMarked: 1,
          firstBingoAt: 100,
          dayStats: { 4: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 100 } },
        }),
      ],
      event: { days: [], bannedUids: [] },
      archivedAt: 1,
    });
    expect(archive.dailyHonors.map((h) => h.dayLabel)).toEqual(['D5']);
  });
});

describe('buildEventArchive — a ban hides, it never reassigns', () => {
  const banned = mkPlayer({
    uid: 'banned',
    displayName: 'Banned',
    bingoCount: 2,
    squaresMarked: 20,
    firstBingoAt: 1000,
    dayStats: { 1: { bingoCount: 2, squaresMarked: 20, firstBingoAt: 1000 } },
  });
  const later = mkPlayer({
    uid: 'later',
    displayName: 'Later',
    bingoCount: 1,
    squaresMarked: 6,
    firstBingoAt: 3000,
    dayStats: { 1: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 3000 } },
  });

  it('drops a banned Player from the standings and from every honour', () => {
    const archive = buildEventArchive({
      players: [banned, later],
      event: { days: DAYS, bannedUids: ['banned'] },
      dayMetas: new Map<number, DayMetaDoc>([
        [1, { firstBingo: { uid: 'banned', displayName: 'Banned', at: 1000 } }],
      ]),
      archivedAt: 1,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['later']);
    expect(archive.playerCount).toBe(1);
    // The headline is selected over the RAW roster and then hidden — so the
    // honour goes to NOBODY rather than being handed to the next Player, who was
    // never first (specs/w2-ban-console.md § Leaderboard, made permanent).
    expect(archive.firstBingo).toBeNull();
    // The kept headline row goes with it: a hidden Player must not be printable
    // from the Share Card's pinned row either.
    expect(archive.firstBingoRow).toBeNull();
    // The pinned Day-1 honour is the banned Player's, so that Day gets no chip
    // rather than the derived runner-up.
    expect(archive.dailyHonors).toEqual([]);
  });
});

// Codex P2, PR #1139. `players/{uid}` is self-written under the honour system
// and its rules arm validates NOTHING — not `uid`, not `displayName`, not the
// two counts — so every row below is a shape a Player can actually produce.
// Before this, each of them made the archive write throw or the Event document
// overflow AFTER the closing write had already shut the Event: every attempt
// closed play and then failed, permanently.
// #1151, Codex P1 on PR #1162. The record's uids come from the roster, and the
// roster is read through `playerConverter` — which is the ONE place the row's
// real identity (its path) is separated from the `uid` FIELD beside it, an
// unvalidated Player-written string the archive would otherwise copy verbatim.
describe('playerConverter — a Player row is identified by its PATH', () => {
  const snapOf = (id: string, data: Record<string, unknown>) =>
    ({ id, data: () => data }) as never;

  it('pins uid to the document id over a 300 KB stored field', () => {
    const row = playerConverter.fromFirestore(
      snapOf('alice', { uid: 'X'.repeat(300 * 1024), displayName: 'Alice', bingoCount: 1 }),
    );
    expect(row.uid).toBe('alice');
  });

  it('pins uid to the document id over another Player’s uid, and over a missing one', () => {
    // The same field is what `isBanned` and every honour match read, so a stored
    // uid naming somebody else is not only an archive hazard.
    expect(
      playerConverter.fromFirestore(snapOf('alice', { uid: 'bob', displayName: 'Alice' })).uid,
    ).toBe('alice');
    expect(playerConverter.fromFirestore(snapOf('alice', { displayName: 'Alice' })).uid).toBe(
      'alice',
    );
  });

  it('leaves an honest row identical, and still defaults the reshuffle counter', () => {
    const row = playerConverter.fromFirestore(
      snapOf('alice', { uid: 'alice', displayName: 'Alice', bingoCount: 2 }),
    );
    expect(row.uid).toBe('alice');
    expect(row.displayName).toBe('Alice');
    expect(row.reshufflesUsed).toBe(0);
  });
});

describe('draftEventArchive — the inputs are validated BEFORE the Event is shut', () => {
  it('skips a row with no usable uid, and counts it', () => {
    const draft = draftEventArchive({
      players: [
        mkPlayer({ uid: 'real', displayName: 'Real', squaresMarked: 5 }),
        // A Player who deleted `uid` from their own row. Firestore refuses to
        // serialize `undefined`, and the row is unmatchable besides — there is
        // nothing to default an identity to.
        { ...mkPlayer({ uid: 'x', displayName: 'Ghost' }), uid: undefined } as unknown as PlayerDoc,
        { ...mkPlayer({ uid: 'x', displayName: 'Blank' }), uid: '   ' } as unknown as PlayerDoc,
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.standings.map((r) => r.uid)).toEqual(['real']);
    expect(draft.archive.playerCount).toBe(1);
    expect(draft.skippedRows).toBe(2);
    expect(draft.refusal).toBeNull();
  });

  it('skips a row whose DOCUMENT ID is longer than a Firebase Auth uid, and counts it', () => {
    // #1151, Codex P1 on PR #1162. The uid every row here carries is its
    // document id (`playerConverter`), and a client write can only ever put
    // `request.auth.uid` there — but an Admin-SDK repair, a seed script or a
    // console hand-edit is bound by nothing, and a path segment may run to
    // Firestore's own 1500-byte limit. Bounded at the longest uid the platform
    // mints, and an id past it takes the SAME route a missing one does: skipped,
    // counted on the confirm row, outside `playerCount`.
    const draft = draftEventArchive({
      players: [
        mkPlayer({ uid: 'real', displayName: 'Real', squaresMarked: 5 }),
        mkPlayer({ uid: 'a'.repeat(MAX_ARCHIVED_UID), displayName: 'Exactly at the bound' }),
        mkPlayer({ uid: 'b'.repeat(MAX_ARCHIVED_UID + 1), displayName: 'One over' }),
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.standings.map((r) => r.uid)).toEqual([
      'real',
      'a'.repeat(MAX_ARCHIVED_UID),
    ]);
    expect(draft.archive.playerCount).toBe(2);
    expect(draft.skippedRows).toBe(1);
    expect(draft.refusal).toBeNull();
  });

  it('never lets an unidentifiable row take the headline honour', () => {
    // Dropped BEFORE the selection, not after: a winner with no uid would be
    // written as `{uid: undefined}` and refuse to serialize.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'x', displayName: 'Ghost', bingoCount: 1, firstBingoAt: 10 }),
          uid: undefined,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 10 } },
        } as unknown as PlayerDoc,
        mkPlayer({
          uid: 'real',
          displayName: 'Real',
          bingoCount: 1,
          squaresMarked: 5,
          firstBingoAt: 900,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 900 } },
        }),
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.firstBingo?.uid).toBe('real');
    expect(draft.archive.firstBingoRow?.uid).toBe('real');
  });

  it('survives a null per-Day bucket rather than throwing out of the draft', () => {
    // `players/{uid}` validates NOTHING, so `dayStats` is a Player-written map
    // that can hold a `null` — and every honour selector dereferences the bucket
    // (`stat.firstBingoAt`). One such row threw out of the builder before any
    // coercion ran, and because `ArchiveEvent` builds this draft during RENDER,
    // the exception took Game settings and its Reopen play control with it — on
    // an Event that may already be shut.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'broken', displayName: 'Broken', bingoCount: 1, squaresMarked: 3 }),
          dayStats: { 1: null },
        } as unknown as PlayerDoc,
        mkPlayer({
          uid: 'real',
          displayName: 'Real',
          bingoCount: 1,
          squaresMarked: 5,
          firstBingoAt: 900,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 900 } },
        }),
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    // The unreadable bucket is dropped, so the Day's honour is decided by the
    // row that actually carries evidence for it — and the broken row's own ROOT
    // totals are still copied verbatim (ADR 0001).
    expect(draft.archive.firstBingo?.uid).toBe('real');
    expect(draft.archive.dailyHonors.map((h) => h.uid)).toEqual(['real']);
    expect(draft.archive.standings.find((r) => r.uid === 'broken')).toMatchObject({
      bingoCount: 1,
      squaresMarked: 3,
    });
    expect(draft.refusal).toBeNull();
  });

  it('drops a NON-OBJECT bucket the same way — a string is not a Day of evidence', () => {
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'junk', displayName: 'Junk' }),
          dayStats: { 1: 'nonsense', 2: 7 },
        } as unknown as PlayerDoc,
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.firstBingo).toBeNull();
    expect(draft.archive.dailyHonors).toEqual([]);
    expect(draft.archive.standings.map((r) => r.uid)).toEqual(['junk']);
  });

  it('coerces a bucket whose fields are MISSING or non-finite rather than ranking them', () => {
    // The bucket is a real object, so it is kept — and every field inside it
    // gets the same coercion the standings rows get. A non-finite instant is the
    // load-bearing half: `NaN` is not `null`, so an uncoerced bucket ENTERS the
    // per-Day comparison and every `<` against it is false, which pins the Day's
    // honour on the row carrying no evidence at all and stores its instant as 0.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'sparse', displayName: 'Sparse' }),
          dayStats: { 1: { firstBingoAt: Number.NaN }, 2: {} },
        } as unknown as PlayerDoc,
        mkPlayer({
          uid: 'real',
          displayName: 'Real',
          bingoCount: 1,
          firstBingoAt: 900,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 900 } },
        }),
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.firstBingo?.uid).toBe('real');
    expect(draft.archive.dailyHonors).toEqual([
      expect.objectContaining({ dayIndex: 1, uid: 'real', firstBingoAt: 900 }),
    ]);
    expect(draft.refusal).toBeNull();
  });

  // #1142 item 9. Sanitising only the per-Day buckets left the one path that
  // does not read them exposed: `effectiveCruiseFirstBingoAt` falls back to the
  // ROOT stamp for a row with NO `dayStats` at all, and the headline selection
  // orders candidates with `<`. Every comparison against `NaN` is false, so the
  // `NaN` row encountered first stayed `best` and was never displaced.
  it('normalises the ROOT firstBingoAt before the headline is selected', () => {
    const draft = draftEventArchive({
      players: [
        // A pre-Day-Cards row (no `dayStats`) whose root stamp is unreadable.
        // Listed FIRST, which is what made it win under the old code.
        {
          ...mkPlayer({ uid: 'nan', displayName: 'Not A Number', bingoCount: 1 }),
          firstBingoAt: Number.NaN,
        } as unknown as PlayerDoc,
        mkPlayer({ uid: 'real', displayName: 'Real', bingoCount: 1, firstBingoAt: 900 }),
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    // The honour goes to the Player who actually bingoed, at their real instant
    // — not to the unreadable row at `at: 0`, permanently.
    expect(draft.archive.firstBingo).toEqual({ uid: 'real', displayName: 'Real', at: 900 });
    expect(draft.archive.firstBingoRow?.uid).toBe('real');
    // The unreadable row is still KEPT in the standings, with a null instant:
    // this normalises the SELECTION, it does not adjudicate a Player away.
    expect(draft.archive.standings.find((r) => r.uid === 'nan')?.firstBingoAt).toBeNull();
  });

  it('normalises every non-finite root stamp, not just NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const draft = draftEventArchive({
        players: [
          {
            ...mkPlayer({ uid: 'bad', displayName: 'Bad', bingoCount: 1 }),
            firstBingoAt: bad,
          } as unknown as PlayerDoc,
          mkPlayer({ uid: 'real', displayName: 'Real', bingoCount: 1, firstBingoAt: 900 }),
        ],
        event: { days: DAYS, bannedUids: [] },
        archivedAt: 1,
      });
      expect(draft.archive.firstBingo?.uid).toBe('real');
    }
    // The coercion itself, stated once: an instant the record can carry, or null.
    expect(archiveInstant(900)).toBe(900);
    expect(archiveInstant(Number.NaN)).toBeNull();
    expect(archiveInstant(Number.POSITIVE_INFINITY)).toBeNull();
    expect(archiveInstant('900')).toBeNull();
    expect(archiveInstant(undefined)).toBeNull();
  });

  // #1151, Codex P1 on PR #1162. The stamp is normalised because the SELECTION
  // reads it; the root counts are normalised because the ORDER reads them, and
  // the order is the other thing the builder decides. Both belong to the same
  // pass for the same reason: `toStandingRow` serialises the malformed row at
  // `0`, so a sort that saw anything else froze an order the record contradicts.
  it('normalises the ROOT COUNTS before the standings are sorted', () => {
    for (const bad of [Number.NaN, undefined, Number.POSITIVE_INFINITY]) {
      const draft = draftEventArchive({
        players: [
          // Listed FIRST, which is what a stable sort over a NaN comparator
          // leaves in place — and what an `Infinity` count wins outright.
          {
            ...mkPlayer({ uid: 'bad', displayName: 'Bad', squaresMarked: 1 }),
            bingoCount: bad,
          } as unknown as PlayerDoc,
          mkPlayer({
            uid: 'champion',
            displayName: 'Champion',
            bingoCount: 4,
            squaresMarked: 20,
            firstBingoAt: 900,
          }),
        ],
        event: { days: DAYS, bannedUids: [] },
        archivedAt: 1,
      });
      // The legitimate champion holds rank 1, and the malformed row is BELOW
      // them — not merely serialised at zero underneath a rank it kept.
      expect(draft.archive.standings.map((r) => r.uid)).toEqual(['champion', 'bad']);
      // …and the row the record prints agrees with the order it was sorted in.
      expect(draft.archive.standings[1].bingoCount).toBe(0);
    }
    // `squaresMarked` is the second key and gets the same treatment: the two
    // rows tie on bingos, so the sort falls through to the count that is junk.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'bad', displayName: 'Bad', bingoCount: 2 }),
          squaresMarked: Number.POSITIVE_INFINITY,
        } as unknown as PlayerDoc,
        mkPlayer({ uid: 'champion', displayName: 'Champion', bingoCount: 2, squaresMarked: 20 }),
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.standings.map((r) => r.uid)).toEqual(['champion', 'bad']);
    expect(draft.archive.standings[1].squaresMarked).toBe(0);
  });

  it('hands the comparator a row it can order, rather than NaN', () => {
    // The mechanism, pinned at the seam: `comparePlayers` SUBTRACTS the counts,
    // so a missing or `NaN` one makes every comparison against that row `NaN` —
    // and `Array.prototype.sort` is free to do anything at all with a `NaN`
    // comparator result. The readable pass is what removes that freedom.
    const bad = {
      ...mkPlayer({ uid: 'bad', displayName: 'Bad' }),
      bingoCount: Number.NaN,
    } as unknown as PlayerDoc;
    const champion = mkPlayer({ uid: 'champion', displayName: 'Champion', bingoCount: 4 });
    expect(comparePlayers(bad, champion)).toBeNaN();
    expect(comparePlayers(withReadableDayStats(bad), champion)).toBeGreaterThan(0);
    expect(comparePlayers(champion, withReadableDayStats(bad))).toBeLessThan(0);
  });

  it('leaves a well-formed row untouched, object identity included', () => {
    // The normalisation must be a no-op on every ordinary roster: the console
    // re-runs this on every render, and copying each row would defeat the
    // reference equality React's memoisation elsewhere relies on.
    const clean = mkPlayer({ uid: 'clean', displayName: 'Clean', firstBingoAt: 900 });
    expect(withReadableDayStats(clean)).toBe(clean);
    const nulled = mkPlayer({ uid: 'nulled', displayName: 'Nulled', firstBingoAt: null });
    expect(withReadableDayStats(nulled)).toBe(nulled);
    // A row with real counts is untouched too — the counts are COPIED, never
    // recomputed (ADR 0001), so only an unreadable one moves.
    const scored = mkPlayer({
      uid: 'scored',
      displayName: 'Scored',
      bingoCount: 3,
      squaresMarked: 17,
      firstBingoAt: 900,
    });
    expect(withReadableDayStats(scored)).toBe(scored);
  });

  it('CLAMPS a finite number the rules would refuse, rather than freezing one the flip cannot write', () => {
    // Codex P1 on PR #1162. `players/{uid}` validates no field at all (ADR
    // 0001), so a Player can self-write `bingoCount: 5e12` on their own row —
    // FINITE, so every coercion here kept it, and outside `finiteArchiveNumber`,
    // so `firestore.rules` refused the record carrying it. That refusal lands on
    // the FLIP, which runs after `beginArchive` has already shut the Event, and
    // a rejected write rejects rather than returning: past `archiveEvent`'s
    // typed refusals, past the console's automatic reopen, and identically on
    // every retry until an admin found and repaired that one row.
    const draft = draftEventArchive({
      players: [
        mkPlayer({
          uid: 'huge',
          displayName: 'Huge',
          bingoCount: 5e12,
          squaresMarked: -5e12,
          firstBingoAt: 5e12,
          dayStats: { 1: { bingoCount: 5e12, squaresMarked: 1, firstBingoAt: 5e12 } },
        }),
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    const row = draft.archive.standings[0];
    expect(row.bingoCount).toBe(MAX_ARCHIVE_NUMBER);
    expect(row.squaresMarked).toBe(-MAX_ARCHIVE_NUMBER);
    expect(row.firstBingoAt).toBe(MAX_ARCHIVE_NUMBER);
    // The First-BINGO pair the rules validate WHOLE carries the same clamped
    // numbers — the holder is exactly the row a `5e12` count strands the archive
    // on, because the honour is what pulls their row into the record twice.
    expect(draft.archive.firstBingo).toEqual({
      uid: 'huge',
      displayName: 'Huge',
      at: MAX_ARCHIVE_NUMBER,
    });
    expect(draft.archive.firstBingoRow?.bingoCount).toBe(MAX_ARCHIVE_NUMBER);
    expect(draft.archive.firstBingoRow?.firstBingoAt).toBe(MAX_ARCHIVE_NUMBER);
    // …and the finished record is one the boundary would take, which is the
    // whole claim: the freeze completes instead of throwing.
    expect(draft.refusal).toBeNull();
  });

  it('CLAMPS the resolved Standings Freeze it stores beside the standings', () => {
    // `freezeAt` resolves from `frozenAt` first, and that field is written by
    // the Admin SDK, which no rules arm constrains — so it is the one instant in
    // the record that can be out of range without any Player doing anything.
    const draft = draftEventArchive({
      players: [mkPlayer({ uid: 'a', displayName: 'A' })],
      event: { days: DAYS, bannedUids: [], frozenAt: 5e12 },
      archivedAt: 1,
    });
    expect(draft.archive.freezeAt).toBe(MAX_ARCHIVE_NUMBER);
    expect(draft.refusal).toBeNull();
    // A stamp that cannot be read at all is NO cutoff, exactly as
    // `standingsFreezeAtFor` already treats a non-finite configured value —
    // rather than a `NaN` cutoff nothing can satisfy and the rules refuse.
    expect(
      draftEventArchive({
        players: [mkPlayer({ uid: 'a', displayName: 'A' })],
        event: { days: DAYS, bannedUids: [], frozenAt: Number.NaN },
        archivedAt: 1,
      }).archive.freezeAt,
    ).toBeNull();
  });

  it('REFUSES a record firestore.rules would not accept, on THIS side of the quiesce', () => {
    // The backstop the clamps above are supposed to make unreachable: the flip
    // is the archive's SECOND write, so a record the boundary refuses is refused
    // with the Event already shut and nothing to show for it. `refusal` asks the
    // boundary's own question here instead, where the caller can still decline.
    const players = [mkPlayer({ uid: 'a', displayName: 'A' })];
    const event = { days: DAYS, bannedUids: [] };
    // The control, at the console preview's own clockless stamp: an ordinary
    // record is writable, and `archivedAt: 0` must not be what refuses it.
    expect(draftEventArchive({ players, event, archivedAt: 0 }).refusal).toBeNull();
    // The stamp is the one number the builder is HANDED rather than coerces, so
    // it is the one a caller can still make unwritable.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(draftEventArchive({ players, event, archivedAt: bad }).refusal).toBe(
        'record-unwritable',
      );
    }
  });

  it('coerces a missing name and missing counts to safe defaults', () => {
    const draft = draftEventArchive({
      players: [
        { uid: 'sparse', joinedAt: 0, reshufflesUsed: 0, photoURL: null } as unknown as PlayerDoc,
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.standings).toEqual([
      {
        uid: 'sparse',
        // The estate's existing stand-in for a nameless Player, not `undefined`.
        displayName: 'Anonymous',
        bingoCount: 0,
        squaresMarked: 0,
        blackout: false,
        firstBingoAt: null,
      },
    ]);
    // The row is KEPT: an identifiable Player belongs in the standings even when
    // every other field of their row is missing.
    expect(draft.skippedRows).toBe(0);
  });

  it('derives no daily honour for a `dayStats` key that is not a Day', () => {
    // A derived honour reads its `dayIndex` off a `dayStats` KEY, and `dayStats`
    // is a Player-written map with no rules validation — so a junk key becomes
    // `Number('abc')`, a chip nothing could label. An Event with no schedule at
    // all renders the derived list straight through, so the record is permanent
    // proof of whatever the derivation produced.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'odd', displayName: 'Odd', bingoCount: 1, squaresMarked: 1 }),
          dayStats: {
            1: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 500 },
            abc: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 600 },
          },
        } as unknown as PlayerDoc,
      ],
      // An Event with no schedule: `pinnedOrDerivedDailyHonors` returns the
      // derived list straight through rather than matching it against Days.
      event: { days: [], bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.dailyHonors.map((h) => h.dayIndex)).toEqual([1]);
    // …and it is refused at DERIVATION now, not carried and then dropped (Codex
    // P2 on PR #1162, round 7). `skippedHonors` exists to remove a SURPRISE — an
    // honour the Admin can see on the preview strip that the record will not
    // keep — and `pinnedOrDerivedDailyHonors` no longer puts this one on the
    // strip either, so there is no discrepancy left to report. The record's own
    // contents are unchanged.
    expect(draft.skippedHonors).toBe(0);
  });

  it('derives no honour for a `dayStats` key OUTSIDE the supported Day range', () => {
    // #1151, Codex P2 on PR #1162 round 7. `Number.isInteger` was the old test,
    // and `-1`, `10` and an unsafe large integer all pass it while naming no Day
    // the `DayDef` contract has (`0 … MAX_DAYS - 1`). On an Event with no
    // schedule the derived list flows straight into `dailyHonors`, so each would
    // have frozen an honour chipped `D0` or `D11` into a list `firestore.rules`
    // cannot look inside to refuse.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'odd', displayName: 'Odd', bingoCount: 1, squaresMarked: 1 }),
          dayStats: {
            '-1': { bingoCount: 1, squaresMarked: 1, firstBingoAt: 400 },
            4: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 500 },
            [MAX_DAYS]: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 600 },
            [Number.MAX_SAFE_INTEGER + 2]: {
              bingoCount: 1,
              squaresMarked: 1,
              firstBingoAt: 700,
            },
          },
        } as unknown as PlayerDoc,
      ],
      event: { days: [], bannedUids: [] },
      archivedAt: 1,
    });
    // THE CONTROL rides in the same fixture: Day 4 is a Day, and a gap below it
    // is not a defect — the whole reason every path keys on `DayDef.index`.
    expect(draft.archive.dailyHonors.map((h) => h.dayIndex)).toEqual([4]);
    // And the live strip agrees, because it is the same selection: the record's
    // promise is that it says what the last live Leaderboard said.
    expect(
      pinnedOrDerivedDailyHonors(
        [
          {
            ...mkPlayer({ uid: 'odd', displayName: 'Odd', bingoCount: 1, squaresMarked: 1 }),
            dayStats: {
              '-1': { bingoCount: 1, squaresMarked: 1, firstBingoAt: 400 },
              4: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 500 },
            },
          } as unknown as PlayerDoc,
        ],
        undefined,
        undefined,
        true,
      ).map((h) => h.dayIndex),
    ).toEqual([4]);
  });

  it('discards a PINNED honour on a Day outside the supported range', () => {
    // The other side of the same predicate (Codex P2 on PR #1162, round 7). A
    // pin arrives off `days/{i}/meta/{i}` rather than off a roster row, so it
    // never goes through the derived filter — and `archiveEvent` refuses such a
    // schedule outright, which makes this the defence in depth for every caller
    // that reaches the builder without the freeze's gate (the console's own
    // preview among them).
    const holder = mkPlayer({ uid: 'pin', displayName: 'Pinned', bingoCount: 1, squaresMarked: 5 });
    const draft = draftEventArchive({
      players: [holder],
      event: { days: [mkDay(0), { ...mkDay(1), index: MAX_DAYS }], bannedUids: [] },
      dayMetas: new Map([
        [0, { firstBingo: { uid: 'pin', displayName: 'Pinned', at: 800 } }],
        [MAX_DAYS, { firstBingo: { uid: 'pin', displayName: 'Pinned', at: 900 } }],
      ]),
      dayMetasLoaded: true,
      archivedAt: 1,
    });
    expect(draft.archive.dailyHonors.map((h) => h.dayIndex)).toEqual([0]);
    // Selected and then not carried, which is exactly the case the count exists
    // for: the preview strip showed it, the record leaves it out, the Admin is
    // told before anything is closed.
    expect(draft.skippedHonors).toBe(1);
    expect(writableArchiveRecord(draft.archive)).toBe(true);
  });

  // Codex P2 on PR #1162. DEFENCE IN DEPTH beside `archiveEvent`'s own refusal:
  // the freeze turns a repeated Day index down before it reads anything
  // (`usableDayIndexes` → `schedule-unusable`) and the console's honour fan asks
  // the same question before it arms, but this builder is also called from
  // surfaces that never went through either gate — and the record is the one
  // write that can never be amended. `pinnedOrDerivedDailyHonors` flat-maps over
  // the schedule's ENTRIES, so without this the same Day's honour is emitted once
  // per entry.
  it('carries ONE honour per Day index even when the schedule names a Day twice', () => {
    const holder = mkPlayer({
      uid: 'pinned',
      displayName: 'Pinned',
      bingoCount: 1,
      squaresMarked: 5,
    });
    const draft = draftEventArchive({
      players: [holder],
      event: { days: [mkDay(1), mkDay(1)], bannedUids: [] },
      dayMetas: new Map([[1, { firstBingo: { uid: 'pinned', displayName: 'Pinned', at: 900 } }]]),
      dayMetasLoaded: true,
      archivedAt: 1,
    });
    // The FIRST entry wins, which is the same entry `dayMetas.get(1)` answered
    // with — so the deduped record is exactly the one a schedule naming that Day
    // once would have produced.
    expect(draft.archive.dailyHonors).toEqual([
      expect.objectContaining({ dayIndex: 1, uid: 'pinned', displayName: 'Pinned' }),
    ]);
    // And the shape the boundary would be asked to accept is still one it can:
    // the duplicate is invisible to `completeArchiveRecord`, which cannot look
    // inside a list, so the builder is the only thing standing between the
    // schedule and a permanent record.
    expect(writableArchiveRecord(draft.archive)).toBe(true);

    // The control: a schedule naming the Day ONCE produces the identical list,
    // which is what makes the dedupe a no-op on every schedule the freeze admits.
    const once = draftEventArchive({
      players: [holder],
      event: { days: [mkDay(1)], bannedUids: [] },
      dayMetas: new Map([[1, { firstBingo: { uid: 'pinned', displayName: 'Pinned', at: 900 } }]]),
      dayMetasLoaded: true,
      archivedAt: 1,
    });
    expect(draft.archive.dailyHonors).toEqual(once.archive.dailyHonors);
  });

  // Codex P2 on PR #1162, round 8. `EventArchive.dailyHonors` declares itself
  // ordered by Day index and every archived surface renders it straight through,
  // so the order is part of the permanent record. `pinnedOrDerivedDailyHonors`
  // flat-maps over the schedule's ENTRIES, and a schedule listing `[4, 1]` is
  // perfectly legitimate — the indexes are unique, `usableDayIndexes` accepts it,
  // and `DayDef.index` is what names a Day — so the honours arrived in schedule
  // order and froze that way.
  it('freezes the daily honours in Day-index order, whatever order the schedule lists', () => {
    const alice = mkPlayer({ uid: 'alice', displayName: 'Alice', bingoCount: 2, squaresMarked: 8 });
    const bob = mkPlayer({ uid: 'bob', displayName: 'Bob', bingoCount: 1, squaresMarked: 5 });
    const metas = new Map<number, DayMetaDoc>([
      [1, { firstBingo: { uid: 'alice', displayName: 'Alice', at: 900 } }],
      [4, { firstBingo: { uid: 'bob', displayName: 'Bob', at: 800 } }],
    ] as unknown as Iterable<[number, DayMetaDoc]>);
    const draftFor = (days: DayDef[]) =>
      draftEventArchive({
        players: [alice, bob],
        event: { days, bannedUids: [] },
        dayMetas: metas,
        dayMetasLoaded: true,
        archivedAt: 1,
      });

    const outOfOrder = draftFor([mkDay(4), mkDay(1)]);
    expect(outOfOrder.archive.dailyHonors.map((h) => h.dayIndex)).toEqual([1, 4]);
    // Ordered, not reassigned: each Day keeps the holder its own pin names, and
    // the chip label still comes off that Day's own schedule entry.
    expect(outOfOrder.archive.dailyHonors.map((h) => h.uid)).toEqual(['alice', 'bob']);
    expect(outOfOrder.archive.dailyHonors.map((h) => h.dayLabel)).toEqual(['🌈 D2', '🌈 D5']);
    // Nothing was DROPPED to achieve the order — the count the console shows the
    // Admin is unmoved.
    expect(outOfOrder.skippedHonors).toBe(0);

    // The PREVIEW and the RECORD are the same expression, so the console cannot
    // show one order and freeze another: the schedule's order and the sorted one
    // produce byte-identical honour lists.
    const inOrder = draftFor([mkDay(1), mkDay(4)]);
    expect(outOfOrder.archive.dailyHonors).toEqual(inOrder.archive.dailyHonors);

    // And the backstop agrees, so a later regression in the sort is refused on
    // the near side of the quiesce rather than frozen. The boundary itself
    // cannot ask this — rules have no iteration, so `completeArchiveRecord` gets
    // no further than `dailyHonors is list`.
    expect(writableArchiveRecord(outOfOrder.archive)).toBe(true);
    expect(
      writableArchiveRecord({
        ...outOfOrder.archive,
        dailyHonors: [...outOfOrder.archive.dailyHonors].reverse(),
      }),
    ).toBe(false);

    // AND THE ORDER IS THE SHARED SELECTION'S, not this builder's alone (Codex
    // P2 on PR #1162, round 9). Sorting only here left the record ordered while
    // the LIVE surfaces were not: `pinnedOrDerivedDailyHonors` flat-maps over the
    // schedule's ENTRIES, and the podium and the Feed's honours line render its
    // result straight through — so they showed D5 ahead of D2 against a record
    // that says `[1, 4]`, and "the frozen record says what the last live display
    // said" stopped being true. The selection is where the order now comes from,
    // so every consumer inherits it.
    const outOfOrderDays = [mkDay(4), mkDay(1)];
    expect(
      pinnedOrDerivedDailyHonors([alice, bob], outOfOrderDays, metas, true).map((h) => h.dayIndex),
    ).toEqual([1, 4]);
    // The podium the farewell view renders — and the finale Moment's own copy of
    // it — consumes exactly that list.
    expect(
      buildPodium([alice, bob], outOfOrderDays, metas, true).dailyHonors.map((h) => h.dayIndex),
    ).toEqual([1, 4]);
    // …and it is the same list the record froze, holder for holder, which is the
    // whole claim: one selection, one order, three surfaces.
    expect(buildPodium([alice, bob], outOfOrderDays, metas, true).dailyHonors.map((h) => h.uid))
      .toEqual(outOfOrder.archive.dailyHonors.map((h) => h.uid));
  });

  // #1151, Codex P2 on PR #1162. The Day-meta arm validates `displayName` and
  // `at` on a pin but NOT `uid` on its ADMIN branch (firestore.rules, the
  // `meta/{metaId}` create), and the Admin SDK beside it is constrained by no arm
  // at all — so a pinned holder is the one uid in the whole record that reaches
  // the builder unvalidated by anything. `completeArchiveRecord` cannot look
  // inside a list, so the flip SUCCEEDED and froze an `ArchivedDayHonor` that
  // violates its own declared shape, permanently.
  it('DISCARDS a pinned honour whose holder has no usable uid, and counts it', () => {
    const holder = mkPlayer({
      uid: 'holder',
      displayName: 'Holder',
      bingoCount: 1,
      squaresMarked: 4,
      firstBingoAt: 1500,
      dayStats: { 1: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 1500 } },
    });
    const draft = draftEventArchive({
      players: [holder],
      event: { days: DAYS, bannedUids: [] },
      dayMetas: new Map<number, DayMetaDoc>([
        // What an admin-written pin can actually carry: a `uid` that is not a
        // string. The rules took the create because that branch never asked.
        [1, { firstBingo: { uid: 42, displayName: 'Pinned', at: 1500 } }],
      ] as unknown as Iterable<[number, DayMetaDoc]>),
      archivedAt: 1,
    });
    // The Day is recorded as having NO honour — the pin is hidden, never
    // reassigned. Derivation is what an UNPINNED Day gets; this Day is pinned,
    // and handing its honour to the roster's runner-up (`holder`, who bingoed on
    // Day 1) would be the one adjudication the archive must never make.
    expect(draft.archive.dailyHonors).toEqual([]);
    expect(draft.skippedHonors).toBe(1);
    // And the record is still writable, so the archive can go ahead: the discard
    // is what keeps the backstop below unreached.
    expect(draft.refusal).toBeNull();
    expect(writableArchiveRecord(draft.archive)).toBe(true);
  });

  it('bounds a pinned holder’s uid exactly as it bounds a roster row’s', () => {
    const pinned = (uid: unknown) =>
      draftEventArchive({
        players: [],
        event: { days: DAYS, bannedUids: [] },
        dayMetas: new Map([
          [1, { firstBingo: { uid, displayName: 'Pinned', at: 1500 } }],
        ] as unknown as Iterable<[number, DayMetaDoc]>),
        archivedAt: 1,
      });
    // The same three questions `usableUid` asks of a Player row's document id.
    for (const bad of [42, null, undefined, {}, '', '   ', 'x'.repeat(MAX_ARCHIVED_UID + 1)]) {
      const draft = pinned(bad);
      expect(draft.archive.dailyHonors).toEqual([]);
      expect(draft.skippedHonors).toBe(1);
    }
    // A legitimate pin is untouched, and counted as nothing — the control. Its
    // holder needs no Player row (#1146), so this is the pin at its thinnest.
    const kept = pinned('x'.repeat(MAX_ARCHIVED_UID));
    expect(kept.skippedHonors).toBe(0);
    expect(kept.archive.dailyHonors).toEqual([
      {
        dayIndex: 1,
        uid: 'x'.repeat(MAX_ARCHIVED_UID),
        displayName: 'Pinned',
        firstBingoAt: 1500,
        dayLabel: '🌈 D2',
      },
    ]);
    expect(kept.refusal).toBeNull();
  });

  // The backstop behind the discard above. It is deliberately UNREACHABLE
  // through the builder — every value in a frozen honour is either filtered
  // (`dayIndex`, `uid`) or coerced (`displayName`, `firstBingoAt`, `dayLabel`) —
  // so it is asked of the predicate directly. A record the flip would take, and
  // whose honours nonetheless violate `ArchivedDayHonor`, is the one shape
  // `completeArchiveRecord` cannot refuse for us: Rules cannot iterate a list.
  it('REFUSES a record whose daily honour violates its own declared shape', () => {
    const wellFormed = draftEventArchive({
      players: [mkPlayer({ uid: 'a', displayName: 'A', bingoCount: 1, squaresMarked: 1 })],
      event: { days: DAYS, bannedUids: [] },
      dayMetas: new Map<number, DayMetaDoc>([
        [1, { firstBingo: { uid: 'pinned', displayName: 'Pinned', at: 1500 } }],
      ]),
      archivedAt: 1,
    }).archive;
    // The control: a record built by the builder is accepted, honours included.
    expect(wellFormed.dailyHonors).toHaveLength(1);
    expect(writableArchiveRecord(wellFormed)).toBe(true);

    const withHonor = (over: Record<string, unknown>) => ({
      ...wellFormed,
      dailyHonors: [{ ...wellFormed.dailyHonors[0], ...over }],
    });
    for (const bad of [
      { uid: 42 },
      { uid: '' },
      { displayName: null },
      { dayIndex: 1.5 },
      { dayIndex: Number.NaN },
      { firstBingoAt: Number.POSITIVE_INFINITY },
      { firstBingoAt: MAX_ARCHIVE_NUMBER + 1 },
      { dayLabel: undefined },
    ]) {
      expect(writableArchiveRecord(withHonor(bad) as typeof wellFormed)).toBe(false);
    }
  });

  // Codex P2 on PR #1162. `standings` and `playerCount` are ONE contract — the
  // bounded prefix in rank order, and the complete ban-filtered cardinality it is
  // a prefix OF — and typing them apart said nothing about each other. An
  // authorized admin flipping directly rather than through this builder could
  // therefore freeze `playerCount: 0` beside a non-empty list, or a list past the
  // bound the Event document's 1 MiB budget depends on; both are permanent, and
  // both are read by every archived surface as if they agreed.
  // `firestore.rules`' `standingsSizeMatches` is the boundary's half of the same
  // clause, and `writableArchiveRecord` is where the writer asks it BEFORE the
  // quiesce.
  it('binds the retained rows to playerCount, and builds exactly that pairing', () => {
    const roster = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        mkPlayer({ uid: `p${i}`, displayName: `P${i}`, squaresMarked: n - i }),
      );
    const build = (n: number) =>
      draftEventArchive({
        players: roster(n),
        event: { days: DAYS, bannedUids: [] },
        archivedAt: 1,
      }).archive;

    // UNDER the bound, every row is retained, so the two are simply equal.
    const small = build(5);
    expect(small.standings).toHaveLength(5);
    expect(small.playerCount).toBe(5);
    expect(writableArchiveRecord(small)).toBe(true);

    // PAST it, the prefix is exactly the bound while the count stays the whole
    // roster — which is the pairing's entire reason for existing.
    const big = build(MAX_ARCHIVED_STANDING_ROWS + 50);
    expect(big.standings).toHaveLength(MAX_ARCHIVED_STANDING_ROWS);
    expect(big.playerCount).toBe(MAX_ARCHIVED_STANDING_ROWS + 50);
    expect(writableArchiveRecord(big)).toBe(true);

    // …and the three shapes a direct flip could otherwise carry, none of which
    // this builder can produce: a count that undercounts its own list, a list
    // that undercounts its own count, and a list past the bound.
    expect(writableArchiveRecord({ ...small, playerCount: 0 })).toBe(false);
    expect(writableArchiveRecord({ ...small, standings: [] })).toBe(false);
    expect(
      writableArchiveRecord({ ...big, standings: [...big.standings, big.standings[0]] }),
    ).toBe(false);
  });

  // Codex P2 on PR #1162, round 9. `rank > 0` says the holder's place is a real
  // ordinal; it says nothing about whether the roster the record declares is that
  // long. So `playerCount: 0` beside `standings: []` — which the pairing above is
  // perfectly happy with, the two agreeing the roster is empty — and a
  // First-BINGO pair ranked first was a record BOTH sides accepted, claiming in
  // one breath that nobody played and that somebody came first. The flip arm's
  // `firstBingoPairComplete` asks it now, and this is the writer's own copy,
  // asked before the quiesce rather than after it.
  it('binds the First-BINGO rank to the roster count, on both ends of the range', () => {
    const roster = Array.from({ length: 3 }, (_, i) =>
      mkPlayer({
        uid: `p${i}`,
        displayName: `P${i}`,
        bingoCount: 1,
        squaresMarked: 3 - i,
        firstBingoAt: 1000 + i,
        dayStats: { 1: { bingoCount: 1, squaresMarked: 3 - i, firstBingoAt: 1000 + i } },
      }),
    );
    const record = draftEventArchive({
      players: roster,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    }).archive;
    // The control: the builder produces `holderAt + 1` over an index into
    // `ranked`, beside `ranked.length`, so the bound holds by construction.
    expect(record.firstBingoRow?.rank).toBe(1);
    expect(record.playerCount).toBe(3);
    expect(writableArchiveRecord(record)).toBe(true);

    const withRank = (rank: number, playerCount = record.playerCount) => ({
      ...record,
      playerCount,
      firstBingoRow: { ...record.firstBingoRow!, rank },
    });
    // LAST place is the boundary, not an exception — the Player who got there
    // first can be bottom of the standings.
    expect(writableArchiveRecord(withRank(3))).toBe(true);
    // One past the roster names nobody.
    expect(writableArchiveRecord(withRank(4))).toBe(false);
    // And the shape the finding names: an empty roster still claiming a first
    // place. `standings` has to empty with it, or the pairing above refuses it
    // for a different reason and this clause is never reached.
    expect(
      writableArchiveRecord({ ...withRank(1, 0), standings: [] }),
    ).toBe(false);
    // A holder ranked PAST the retained prefix is still legitimate: the row is
    // carried outside that prefix precisely so its place can be printed.
    expect(
      writableArchiveRecord({
        ...record,
        standings: Array.from({ length: MAX_ARCHIVED_STANDING_ROWS }, () => record.standings[0]),
        playerCount: MAX_ARCHIVED_STANDING_ROWS + 50,
        firstBingoRow: { ...record.firstBingoRow!, rank: MAX_ARCHIVED_STANDING_ROWS + 50 },
      }),
    ).toBe(true);
  });

  it('bounds a name at the cap the rest of the estate already enforces', () => {
    const draft = draftEventArchive({
      players: [mkPlayer({ uid: 'shouty', displayName: 'A'.repeat(50_000), squaresMarked: 1 })],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.standings[0].displayName).toHaveLength(MAX_ARCHIVED_DISPLAY_NAME);
    // 100 is what `firestore.rules` already caps every OTHER Player-authored
    // display name at, and the profile editor's own limit is 40 — so no name a
    // Player can enter through the app is ever shortened by this.
    expect(MAX_ARCHIVED_DISPLAY_NAME).toBe(100);
    // The row that would have cost fifty kilobytes now costs a hundred bytes,
    // which is the point: the clamp is what keeps the record writable.
    expect(draft.refusal).toBeNull();
  });

  it('REFUSES a record that still would not fit, rather than letting the write throw', () => {
    const draft = draftEventArchive({
      players: Array.from({ length: 40 }, (_, i) =>
        mkPlayer({ uid: `p${i}`, displayName: `P${i}`, squaresMarked: 40 - i }),
      ),
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      // The shipped ceiling is unreachable once the clamps above apply, so the
      // backstop is exercised by tightening it rather than by fabricating a
      // record no clamp would produce.
      maxBytes: 200,
    });
    expect(draft.bytes).toBeGreaterThan(200);
    expect(draft.refusal).toBe('too-large');
    // The margin the shipped ceiling leaves: a quarter of the Event document's
    // 1 MiB budget, three quarters left for the fields it shares.
    expect(MAX_ARCHIVE_BYTES).toBeLessThan(1024 * 1024);
  });

  // #1151, Codex P2 on PR #1162 round 7. THE MEASUREMENT the console's
  // oversized-record copy now rests on, and the tripwire that fires if one of the
  // bounds it depends on moves.
  //
  // The copy tells an Admin that banning a Player cannot help, and until the
  // supported-range filter there was one honest exception to that: on an Event
  // with NO schedule the derived fallback yielded one honour per Day index any
  // Player's `dayStats` mentioned, `players/{uid}` validates nothing inside the
  // document, and one row filled to Firestore's own limit therefore minted tens of
  // thousands of honours — pushing the record past its OWN share, where banning
  // that Player really was the lever. Both halves are pinned here rather than
  // argued: the finding's own fixture, and the largest record the builder can
  // produce at all.
  describe('the record’s own share cannot be filled', () => {
    it('by one Player carrying the maximal `dayStats` the rules admit, with no schedule', () => {
      // `players/{uid}` binds the PATH and validates nothing inside, so the only
      // ceiling on this map is Firestore's 1 MiB document limit. Sixteen thousand
      // buckets clears it.
      const dayStats: Record<string, unknown> = {};
      for (let i = 0; i < 16_000; i++) {
        dayStats[String(i)] = { bingoCount: 1, squaresMarked: 1, firstBingoAt: 1_000 + i };
      }
      expect(JSON.stringify(dayStats).length).toBeGreaterThan(1_000_000);

      const draft = draftEventArchive({
        players: [
          {
            ...mkPlayer({
              uid: 'w'.repeat(MAX_ARCHIVED_UID),
              displayName: 'W'.repeat(MAX_ARCHIVED_DISPLAY_NAME),
              bingoCount: 1,
              squaresMarked: 1,
            }),
            dayStats,
          } as unknown as PlayerDoc,
        ],
        // No schedule: the derived list is what the record carries.
        event: { days: [], bannedUids: [] },
        archivedAt: 1,
      });

      // At most one honour per Day the contract has, so a megabyte of buckets
      // costs a few kilobytes rather than a few hundred.
      expect(draft.archive.dailyHonors).toHaveLength(MAX_DAYS);
      expect(draft.bytes).toBeLessThan(MAX_ARCHIVE_BYTES / 10);
      expect(draft.refusal).toBeNull();
    });

    it('by the largest record the builder can produce at all', () => {
      // Every bound at its maximum simultaneously: more rows than the prefix
      // keeps, each uid at `MAX_ARCHIVED_UID` and each name at
      // `MAX_ARCHIVED_DISPLAY_NAME`, every count and instant at the clamp, an
      // Event name past its own bound, and a full honours strip — plus, on each
      // row, its OWN Day nobody has: a `dayStats` key past the supported range,
      // distinct per Player, which is how a roster of this size would have minted
      // one extra honour per row.
      const players = Array.from({ length: MAX_ARCHIVED_STANDING_ROWS + 50 }, (_, n) => {
        const dayStats: Record<string, unknown> = {};
        for (let d = 0; d < MAX_DAYS; d++) {
          dayStats[String(d)] = { bingoCount: 1, squaresMarked: 1, firstBingoAt: 1_000 + n };
        }
        dayStats[String(MAX_DAYS + n)] = {
          bingoCount: 1,
          squaresMarked: 1,
          firstBingoAt: 1_000 + n,
        };
        return {
          ...mkPlayer({
            uid: `${String(n).padStart(4, '0')}${'u'.repeat(MAX_ARCHIVED_UID - 4)}`,
            displayName: 'N'.repeat(MAX_ARCHIVED_DISPLAY_NAME),
            bingoCount: MAX_ARCHIVE_NUMBER,
            squaresMarked: MAX_ARCHIVE_NUMBER,
            blackout: true,
            firstBingoAt: MAX_ARCHIVE_NUMBER,
          }),
          dayStats,
        } as unknown as PlayerDoc;
      });

      const draft = draftEventArchive({
        players,
        event: { days: [], bannedUids: [], name: 'E'.repeat(500) },
        archivedAt: MAX_ARCHIVE_NUMBER,
      });

      expect(draft.archive.standings).toHaveLength(MAX_ARCHIVED_STANDING_ROWS);
      expect(draft.archive.dailyHonors).toHaveLength(MAX_DAYS);
      // ~74 KiB against a 256 KiB share. The assertion is deliberately a wide
      // margin rather than an exact byte count — what it pins is the CONCLUSION
      // the console's copy states, that no roster can fill the record's own
      // quarter of the budget, so `tooLargeCeiling`'s first sentence is
      // unreachable and "banning does not help" is true without qualification.
      expect(draft.bytes).toBeLessThan(MAX_ARCHIVE_BYTES / 2);
      expect(draft.refusal).toBeNull();
    });
  });

  // Codex P2, PR #1139 round 4. The ceiling above measures the RECORD, and the
  // record is never written to an empty document: `days` carries per-Day
  // snapshot id lists, `bannedUids` holds up to 1000 entries, `mostLovedPhoto`
  // up to 100 winners — all of them already there when the freeze commits. An
  // Event large on its own could pass the record's quarter-budget and still push
  // the document past Firestore's 1 MiB limit, inside the transaction, with
  // gameplay already shut.
  it('REFUSES a perfectly ordinary record the Event document has no room left for', () => {
    const players = [mkPlayer({ uid: 'p0', displayName: 'P0', squaresMarked: 3 })];
    const event = { days: DAYS, bannedUids: [] };
    // The Event is already carrying most of its budget in fields the builder
    // never reads — which is exactly why the check cannot be made on `event`.
    const heavy = {
      ...event,
      days: DAYS.map((d) => ({
        ...d,
        snapshotItemIds: Array.from({ length: 16_000 }, (_, i) => `item-${i}-padding`),
      })),
    };
    const alone = draftEventArchive({ players, event, archivedAt: 1 });
    expect(alone.refusal).toBeNull();
    expect(alone.bytes).toBeLessThan(MAX_ARCHIVE_BYTES);

    const onTheRealDocument = draftEventArchive({ players, event, archivedAt: 1, existing: heavy });
    // The record itself is unchanged and still well inside its own ceiling…
    expect(onTheRealDocument.bytes).toBe(alone.bytes);
    // …and the document it would land on is not.
    expect(onTheRealDocument.projectedBytes).toBeGreaterThan(MAX_ARCHIVED_EVENT_BYTES);
    expect(onTheRealDocument.refusal).toBe('too-large');
  });

  it('measures the document the update PRODUCES, not the one it replaces', () => {
    const players = [mkPlayer({ uid: 'p0', displayName: 'P0', squaresMarked: 3 })];
    // A prior `archive` on the stored document is REPLACED by this write, so
    // counting it would refuse a re-freeze the document has ample room for.
    const stale = { standings: Array.from({ length: 5_000 }, (_, i) => ({ uid: `u${i}` })) };
    const withStale = draftEventArchive({
      players,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      existing: { name: 'Med 2026', days: DAYS, bannedUids: [], archive: stale },
    });
    const withoutStale = draftEventArchive({
      players,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      existing: { name: 'Med 2026', days: DAYS, bannedUids: [] },
    });
    expect(withStale.projectedBytes).toBe(withoutStale.projectedBytes);
    expect(withStale.refusal).toBeNull();
    // The retained fields DO count — the whole point of the projection.
    expect(withStale.projectedBytes).toBeGreaterThan(withStale.bytes);
  });

  it('leaves a real Event nowhere near the ceiling', () => {
    // The bound is a backstop, not a limit any Event is expected to approach: a
    // FULL 200-row record with maximum-length names is still a fraction of it.
    const draft = draftEventArchive({
      players: Array.from({ length: MAX_ARCHIVED_STANDING_ROWS }, (_, i) =>
        mkPlayer({
          uid: `player-uid-${i}`,
          displayName: 'N'.repeat(MAX_ARCHIVED_DISPLAY_NAME),
          bingoCount: 20,
          squaresMarked: 250 - i,
          firstBingoAt: 1_700_000_000_000,
        }),
      ),
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.refusal).toBeNull();
    expect(draft.bytes).toBeLessThan(MAX_ARCHIVE_BYTES / 2);
  });
});

// #1151, routed here from #1150's review. The quiesce only DELAYS the finale
// beats; `status: 'archived'` is irreversible, so an Event flipped before its
// Standings Freeze never receives them and nothing else warns the Admin.
describe('finaleHasRun — the finale gate’s own predicate', () => {
  it('is satisfied once the scheduler has stamped the completion marker', () => {
    expect(finaleHasRun({ finaleCompletedAt: 8100, days: DAYS })).toBe(true);
  });

  it('is NOT satisfied by a freeze stamp on its own', () => {
    // #1151, Codex P1 on PR #1162. `runFinaleBeats` writes `frozenAt` in the
    // freeze transaction and posts the podium Moment AFTERWARDS, under its own
    // try/catch and its own retry guard — so an Event carries the stamp and no
    // podium for as long as that beat keeps failing. Archiving there is
    // irreversible and a closed Event's finale is never retried, so the podium
    // would be lost for good. The stamp alone therefore keeps the
    // acknowledgement on screen.
    // Cast, because the predicate's own parameter no longer ADMITS `frozenAt` —
    // which is the type-level half of the same statement.
    expect(finaleHasRun({ frozenAt: 8000, days: DAYS } as Partial<EventDoc>)).toBe(false);
    expect(
      finaleHasRun({ frozenAt: 8000, finaleCompletedAt: 8100, days: DAYS } as Partial<EventDoc>),
    ).toBe(true);
  });

  it('is NOT satisfied while a scheduled freeze is still pending', () => {
    // A schedule with a ceremonial Day resolves a freeze even with no stored
    // `standingsFreezeAt`, so this is the ordinary live Event mid-sailing.
    expect(finaleHasRun({ standingsFreezeAt: 8000, days: DAYS })).toBe(false);
    expect(finaleHasRun({ days: [mkDay(0), mkDay(1, { pool: 'closing', tutorial: true })] })).toBe(
      false,
    );
  });

  it('is satisfied for an Event that has no scheduled freeze at all', () => {
    // The pre-ADR-0011 "legacy Events never freeze" shape. Gating on a finale
    // that can never run would block archiving it forever.
    expect(finaleHasRun({ days: [] })).toBe(true);
    expect(finaleHasRun({})).toBe(true);
    expect(finaleHasRun(null)).toBe(true);
    expect(finaleHasRun(undefined)).toBe(true);
  });
});

// Codex P2, PR #1139 round 4. The quiesce shuts GAMEPLAY, not administration —
// deliberately, so an Admin can still moderate and still reopen. That leaves the
// Event's own configuration movable between `archiveEvent`'s pre-read (which the
// drain gate is evaluated against, and which decides which Day honour pins are
// fetched) and its transaction (which the record is built against), so a freeze
// that checked neither would combine reads taken for one configuration with a
// record built for another.
describe('archiveEvent — the snapshot configuration is held across the reads', () => {
  const closingEvent = (over: Record<string, unknown> = {}) => ({
    status: 'active',
    archiving: true,
    archiveToken: 1,
    claimMode: 'honor',
    days: [mkDay(0), mkDay(1)],
    bannedUids: [],
    frozenAt: 50_000,
    // The finale-complete MARKER, not the freeze stamp, is what satisfies the
    // gate (#1151, Codex P1 on PR #1162) — every case in this block is about
    // something other than the finale, so it reads as an ordinary post-finale
    // archive.
    finaleCompletedAt: 50_100,
    ...over,
  });

  beforeEach(() => {
    A.event = closingEvent();
    A.claims = [];
    A.players = [{ uid: 'alice', displayName: 'Alice', bingoCount: 1, squaresMarked: 9 }];
    A.dayMetas = new Map();
    A.updates = [];
    A.serverReads = [];
    A.beforeTx = null;
  });

  it('freezes when the configuration held (the control)', async () => {
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
    expect((A.updates[0].archive as { playerCount: number }).playerCount).toBe(1);
  });

  it('freezes the Event name off the TRANSACTIONAL read', async () => {
    // Deliberately not in the fingerprint: `name` decides nothing about which
    // rows were read, so a rename mid-snapshot must not cost an archive. Taking
    // it from the transaction's own read is what keeps the record
    // self-consistent anyway — it is the document the write lands on.
    A.event = closingEvent({ name: 'Med 2026' });
    A.beforeTx = () => {
      A.event = closingEvent({ name: 'Med 2026 — renamed' });
    };
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect((A.updates[0].archive as { eventName: string | null }).eventName).toBe(
      'Med 2026 — renamed',
    );
  });

  it('ABORTS when Claim Mode flips mid-snapshot, and writes nothing', async () => {
    // The drain gate is scoped to `claimsQueueOpen`, so a queue read on an
    // `honor` Event passes VACUOUSLY. Flipping to `admin_confirmed` afterwards
    // makes every one of those pending Claims blocking — and unresolvable,
    // because the freeze denies both writes their resolution consists of.
    A.claims = [{ status: 'pending' }];
    A.beforeTx = () => {
      A.event = closingEvent({ claimMode: 'admin_confirmed' });
    };
    expect(await archiveEvent(1, { now: 5 })).toBe('config-changed');
    expect(A.updates).toEqual([]);
  });

  it('ABORTS when the schedule is edited mid-snapshot, and writes nothing', async () => {
    // `days` decides which Day honour pins were fetched at all, which Days are
    // Tutorial, where a missing Standings Freeze is derived from, and the label
    // each frozen honour chip carries.
    A.beforeTx = () => {
      A.event = closingEvent({ days: [mkDay(0, { theme: 'get-sporty' }), mkDay(1)] });
    };
    expect(await archiveEvent(1, { now: 5 })).toBe('config-changed');
    expect(A.updates).toEqual([]);
  });

  it('ABORTS when a Day is added or removed mid-snapshot', async () => {
    A.beforeTx = () => {
      A.event = closingEvent({ days: [mkDay(0), mkDay(1), mkDay(2)] });
    };
    expect(await archiveEvent(1, { now: 5 })).toBe('config-changed');
    expect(A.updates).toEqual([]);
  });

  it('ABORTS when the Standings Freeze moves mid-snapshot', async () => {
    A.beforeTx = () => {
      A.event = closingEvent({ standingsFreezeAt: 9_999 });
    };
    expect(await archiveEvent(1, { now: 5 })).toBe('config-changed');
    expect(A.updates).toEqual([]);
  });

  it('ABORTS when the finale lands mid-snapshot', async () => {
    // `frozenAt` is in the fingerprint because it resolves the honour cutoff: a
    // freeze stamped between the pre-read and the commit would leave the record
    // cut on one answer and built against another. (The finale GATE reads
    // `finaleCompletedAt`, which is deliberately outside the fingerprint — it
    // only ever moves from absent to stamped, so it can make the archive more
    // permitted and never less.)
    A.event = closingEvent({ frozenAt: undefined, standingsFreezeAt: 8000 });
    A.beforeTx = () => {
      A.event = closingEvent({ frozenAt: 8000, standingsFreezeAt: 8000 });
    };
    expect(await archiveEvent(1, { now: 5 })).toBe('config-changed');
    expect(A.updates).toEqual([]);
  });

  it('does NOT abort on a ban landing mid-snapshot — moderation stays open', async () => {
    // The one administrative action the spec deliberately keeps available across
    // the quiesce. A ban is applied to the rows the record keeps rather than
    // deciding which rows were read, so it changes what the record CONTAINS in
    // exactly the way it should; aborting would make the freeze race a takedown.
    A.beforeTx = () => {
      A.event = closingEvent({ bannedUids: ['alice'] });
    };
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
    expect((A.updates[0].archive as { standings: unknown[] }).standings).toEqual([]);
  });

  it('does not mistake a re-serialized document for a changed one', () => {
    // The fingerprint sorts object keys, because `JSON.stringify` follows
    // insertion order and the SDK promises nothing about reproducing it across
    // two decodes — a comparison that could report a spurious change would abort
    // archives at random.
    const a = { claimMode: 'honor', days: [{ index: 0, theme: 'x', unlockAt: 1 }] };
    const b = { days: [{ unlockAt: 1, theme: 'x', index: 0 }], claimMode: 'honor' };
    expect(archiveSnapshotFingerprint(a as never)).toBe(archiveSnapshotFingerprint(b as never));
    // …and a real edit still moves it.
    expect(archiveSnapshotFingerprint({ ...a, claimMode: 'admin_confirmed' } as never)).not.toBe(
      archiveSnapshotFingerprint(a as never),
    );
  });

  // Codex P2 on PR #1162. This runs over a RAW document whose `days` no rules arm
  // validates, so an Admin-SDK repair or a console hand edit can leave a native
  // Firestore value in it — and a `DocumentReference` carries an ENUMERABLE
  // `firestore` back-reference pointing at a graph that contains the reference
  // again. A plain recursive walk cycles on it and throws `RangeError: Maximum
  // call stack size exceeded`, after play has closed and outside every
  // `archiveRead` wrapper.
  it('fingerprints a SELF-REFERENCING value without throwing, and stably', () => {
    // A faithful stand-in for the SDK's own shape: `path` is the reference's
    // identity, `withConverter` is the function-valued marker no stored map can
    // present (the modular client dropped `isEqual` at v9), and `firestore` is
    // the handle that makes the graph cyclic.
    const mkRef = (path: string) => {
      const ref: Record<string, unknown> = { path, id: path.split('/').pop(), type: 'document' };
      const firestore: Record<string, unknown> = { app: {} };
      firestore.ref = ref;
      ref.firestore = firestore;
      ref.withConverter = () => ref;
      return ref;
    };
    const withRef = (path: string) => ({
      claimMode: 'honor',
      days: [{ index: 0, theme: 'x', unlockAt: 1, source: mkRef(path) }],
    });

    // It answers rather than throwing…
    expect(() => archiveSnapshotFingerprint(withRef('events/e/items/a') as never)).not.toThrow();
    // …STABLY, which is the property the comparison is built on: two reads of an
    // unchanged document must agree, or the freeze aborts at random.
    expect(archiveSnapshotFingerprint(withRef('events/e/items/a') as never)).toBe(
      archiveSnapshotFingerprint(withRef('events/e/items/a') as never),
    );
    // …and by the reference's PATH, so a reference that actually moved is still
    // seen to have moved rather than collapsing onto a single "some object" tag.
    expect(archiveSnapshotFingerprint(withRef('events/e/items/b') as never)).not.toBe(
      archiveSnapshotFingerprint(withRef('events/e/items/a') as never),
    );

    // A cycle that is NOT one of the known Firestore shapes is tagged rather than
    // walked — the backstop under the four special cases above.
    const looping: Record<string, unknown> = { index: 0 };
    looping.self = looping;
    expect(() =>
      archiveSnapshotFingerprint({ claimMode: 'honor', days: [looping] } as never),
    ).not.toThrow();
  });

  it('reduces each Firestore value to the scalar the SDK round-trips it by', () => {
    // Recognised by SHAPE rather than by `instanceof`: this module is
    // Firestore-free on purpose, and duck-typing also survives two copies of the
    // SDK in one bundle, which `instanceof` does not.
    const fp = (day: unknown) => archiveSnapshotFingerprint({ days: [day] } as never);
    // A Timestamp, by its milliseconds — so two decodes of one stored instant
    // agree even though they are different objects.
    expect(fp({ at: { toMillis: () => 1_700, seconds: 1, nanoseconds: 7 } })).toBe(
      fp({ at: { toMillis: () => 1_700, seconds: 99, nanoseconds: 99 } }),
    );
    expect(fp({ at: { toMillis: () => 1_700 } })).not.toBe(fp({ at: { toMillis: () => 1_701 } }));
    // Bytes, by their base64.
    expect(fp({ b: { toBase64: () => 'AQI=' } })).toBe(fp({ b: { toBase64: () => 'AQI=' } }));
    expect(fp({ b: { toBase64: () => 'AQI=' } })).not.toBe(fp({ b: { toBase64: () => 'AQM=' } }));
    // A GeoPoint, by its coordinates.
    const geo = (lat: number, lng: number) => ({ latitude: lat, longitude: lng, isEqual: () => true });
    expect(fp({ g: geo(1.5, -2.5) })).toBe(fp({ g: geo(1.5, -2.5) }));
    expect(fp({ g: geo(1.5, -2.5) })).not.toBe(fp({ g: geo(1.5, -2.6) }));

    // …and a PLAIN map that merely has coordinates is walked as a map, not
    // reduced to them. `latitude`/`longitude` are ordinary field names a stored
    // Day could carry, and collapsing such a map to its two numbers would drop
    // every other field from the fingerprint — so a change to one of them would
    // read as no change, which is the one direction this comparison must never
    // fail in.
    expect(fp({ g: { latitude: 1.5, longitude: -2.5, place: 'Ibiza' } })).not.toBe(
      fp({ g: { latitude: 1.5, longitude: -2.5, place: 'Mykonos' } }),
    );
  });

  // Codex P2 on PR #1162, round 8. The reference branch is the GeoPoint case
  // again and worse: `path` (a string) and `firestore` (a map) are BOTH shapes a
  // stored Day can hold, so the pair alone reduced an ordinary map to its `path`
  // and dropped every other field from the fingerprint — which is the one
  // direction this comparison must never fail in, because an equal fingerprint
  // is what lets `archiveEvent` skip `config-changed` and freeze pins fetched
  // for a schedule that no longer exists.
  it('walks a plain map carrying `path` and `firestore`, and reduces only a real reference', () => {
    const fp = (day: unknown) => archiveSnapshotFingerprint({ days: [day] } as never);
    // A DAY, not a reference: a stored map that happens to carry both field
    // names. Every field it holds is still fingerprinted, so an edit to any of
    // them is seen.
    const plainDay = (theme: string) => ({
      index: 0,
      theme,
      unlockAt: 1,
      path: 'events/e/days/0',
      firestore: { app: 'x' },
    });
    expect(fp(plainDay('sunset'))).not.toBe(fp(plainDay('neon')));
    expect(fp(plainDay('sunset'))).toBe(fp(plainDay('sunset')));

    // A REAL reference is still reduced to its `path`, by either function-valued
    // marker — `isEqual` on the Admin SDK's, `withConverter` on the modular
    // client's, and no map decoded from Firestore can present either, because
    // none of Firestore's own types is a JS function.
    for (const marker of ['isEqual', 'withConverter'] as const) {
      const ref = (path: string, extra: string) => ({
        path,
        firestore: { app: 'x' },
        [marker]: () => true,
        // Ignored, because the reduction is the point: two references to the
        // same document are equal whatever else hangs off the object.
        converter: extra,
      });
      expect(fp(ref('events/e/items/a', 'one'))).toBe(fp(ref('events/e/items/a', 'two')));
      // …and one that really moved still moves the fingerprint.
      expect(fp(ref('events/e/items/a', 'one'))).not.toBe(fp(ref('events/e/items/b', 'one')));
    }
  });
});

// Codex P2, PR #1139. `dayHonorChipLabel` resolves the Day's theme emoji out of
// `THEMES`, and every LIVE surface hands it Days that have already been through
// `migrateDayFields` / `normalizeEventTheme` (the Event converter). The WRITER
// reads the stored document, so on a Day whose persisted theme the Edition does
// not carry, the live strip and the permanent record disagreed — which is the
// one thing `dayLabel` was stored to make impossible.
describe('archiveEvent — the frozen Day label is the one the live strip shows', () => {
  const rawDay = (theme: string) => ({
    index: 0,
    date: '2026-07-15',
    place: 'Somewhere',
    placeEmoji: '🏖️',
    theme,
    tonight: [],
    pool: 'main',
    tutorial: false,
    unlockAt: 1,
  });
  const closingWith = (theme: string) => ({
    status: 'active',
    archiving: true,
    archiveToken: 1,
    claimMode: 'honor',
    days: [rawDay(theme)],
    bannedUids: [],
    frozenAt: 50_000,
    // The finale-complete MARKER, not the freeze stamp, is what satisfies the
    // gate (#1151, Codex P1 on PR #1162) — every case in this block is about
    // something other than the finale, so it reads as an ordinary post-finale
    // archive.
    finaleCompletedAt: 50_100,
  });
  /** The label the LIVE honours strip renders, which reads the CONVERTED Days. */
  const liveLabel = (theme: string) => dayHonorChipLabel(0, [migrateDayFields(rawDay(theme))]);

  beforeEach(() => {
    A.claims = [];
    A.players = [
      {
        uid: 'alice',
        displayName: 'Alice',
        bingoCount: 1,
        squaresMarked: 9,
        firstBingoAt: 500,
        dayStats: { 0: { bingoCount: 1, squaresMarked: 9, firstBingoAt: 500 } },
      },
    ];
    A.dayMetas = new Map();
    A.updates = [];
    A.serverReads = [];
    A.beforeTx = null;
  });

  it('freezes the Edition default emoji for a theme this build does not know', async () => {
    // The live strip shows the Edition's default emoji, because the converter
    // resolves an unknown theme to it. The raw read resolved to no theme at all,
    // so the record froze a bare ordinal.
    A.event = closingWith('not-a-real-theme');
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    const honors = (A.updates[0].archive as { dailyHonors: { dayLabel: string }[] }).dailyHonors;
    expect(honors[0].dayLabel).toBe(liveLabel('not-a-real-theme'));
    expect(honors[0].dayLabel).not.toBe('D1');
  });

  it('freezes the Edition default for an OFF-EDITION theme, not that Theme’s own emoji', async () => {
    // A real registered Theme, bound to a different Edition. The picker (and so
    // the converter) resolves it to this Edition's default, while the raw lookup
    // finds the other Theme's emoji — a DIFFERENT emoji frozen, permanently.
    A.event = closingWith('the-birds');
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    const honors = (A.updates[0].archive as { dailyHonors: { dayLabel: string }[] }).dailyHonors;
    expect(honors[0].dayLabel).toBe(liveLabel('the-birds'));
  });

  it('freezes an on-Edition theme exactly as it always did — the control', async () => {
    A.event = closingWith('neon-playground');
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    const honors = (A.updates[0].archive as { dailyHonors: { dayLabel: string }[] }).dailyHonors;
    expect(honors[0].dayLabel).toBe('🌈 D1');
    expect(honors[0].dayLabel).toBe(liveLabel('neon-playground'));
  });
});

describe('archiveEvent — the reads are taken from the server AFTER the close', () => {
  const closingEvent = (over: Record<string, unknown> = {}) => ({
    status: 'active',
    archiving: true,
    // The quiesce's own generation: `archiving` alone cannot say WHICH shut the
    // record was read against (#1139).
    archiveToken: 1,
    claimMode: 'admin_confirmed',
    days: [mkDay(0), mkDay(1)],
    bannedUids: [],
    frozenAt: 50_000,
    // The finale-complete MARKER, not the freeze stamp, is what satisfies the
    // gate (#1151, Codex P1 on PR #1162) — every case in this block is about
    // something other than the finale, so it reads as an ordinary post-finale
    // archive.
    finaleCompletedAt: 50_100,
    ...over,
  });

  beforeEach(() => {
    A.event = closingEvent();
    A.claims = [];
    A.players = [{ uid: 'alice', displayName: 'Alice', bingoCount: 1, squaresMarked: 9 }];
    A.dayMetas = new Map();
    A.updates = [];
    A.serverReads = [];
    A.beforeTx = null;
  });

  it('freezes when the queue is genuinely empty (the control)', async () => {
    A.claims = [{ status: 'confirmed' }, { status: 'rejected' }];
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
    expect(A.updates[0].status).toBe('archived');
  });

  it('refuses, and writes nothing, when a Claim is pending after the close', async () => {
    A.claims = [{ status: 'pending' }];
    expect(await archiveEvent(1, { now: 5 })).toBe('claims-pending');
    expect(A.updates).toEqual([]);
  });

  it('takes the queue read AFTER the Event is confirmed shut, and before the roster', async () => {
    // The order is the guarantee: a queue read before the quiesce is confirmed
    // proves nothing, because the collection could still move afterwards.
    await archiveEvent(1, { now: 5 });
    expect(A.serverReads[0]).toBe('events/test-event');
    expect(A.serverReads[1]).toBe('events/test-event/claims');
    expect(A.serverReads).toContain('events/test-event/players');
  });

  it('names ONE Event on every read, even when the hostname binding moves', async () => {
    // #1142 item 7. `EVENT_ID` is a live binding, and this call takes four
    // awaited reads before it writes — so a path helper resolving the binding
    // per read could freeze one Event's roster onto another. The id is captured
    // once and threaded, which is what the caller's own begin/freeze/cleanup
    // sequence relies on too.
    await archiveEvent(1, { now: 5, eventId: 'test-event' });
    for (const path of A.serverReads) expect(path.startsWith('events/test-event')).toBe(true);
    expect(A.updates).toHaveLength(1);

    // An explicit OTHER Event addresses that Event and nothing else — the same
    // threading, observed from the other side. There is no document there, so
    // it reports `no-event` without ever reaching the queue or the roster.
    A.serverReads = [];
    A.updates = [];
    expect(await archiveEvent(1, { now: 5, eventId: 'other-event' })).toBe('no-event');
    expect(A.serverReads).toEqual(['events/other-event']);
    expect(A.updates).toEqual([]);
  });

  it('reads each Day’s honour pin from the server and freezes it', async () => {
    A.dayMetas = new Map([[1, { firstBingo: { uid: 'pin', displayName: 'Pinned', at: 1200 } }]]);
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.serverReads).toContain('events/test-event/days/0/meta/0');
    expect(A.serverReads).toContain('events/test-event/days/1/meta/1');
    expect((A.updates[0].archive as { dailyHonors: { uid: string }[] }).dailyHonors).toEqual([
      expect.objectContaining({ dayIndex: 1, uid: 'pin', displayName: 'Pinned' }),
    ]);
  });

  it('REFUSES an unusable Day entry in the stored schedule, rather than throwing past the cleanup', async () => {
    // Codex P2 on PR #1162. `EventDoc.days` is admin-written with no per-entry
    // validation in its rules arm, and `eventConverter` TOLERATES a `null` entry
    // (`migrateDayFields` reads a nullish entry as `{}`) — so the console renders
    // its preview and arms the Archive control perfectly happily. The raw
    // post-quiesce read then dereferenced `d.index` on that entry and threw,
    // after `beginArchive` had closed play and outside every `archiveRead`
    // wrapper: `archiveEvent` REJECTED instead of returning, so the console's
    // automatic reopen never ran and a live Event was left shut.
    A.event = closingEvent({ days: [mkDay(0), null] });
    expect(await archiveEvent(1, { now: 5 })).toBe('schedule-unusable');
    expect(A.updates).toEqual([]);
    // Refused before the honour pins are addressed at all — there is no index to
    // address one WITH, and `days/undefined` is a path that would read (and
    // freeze) whatever it found there.
    expect(A.serverReads.some((p) => p.includes('/meta/'))).toBe(false);
  });

  it('refuses a Day whose index is not one, and leaves a well-formed schedule alone', async () => {
    // The same question asked of the other shapes an unvalidated `days` entry
    // can take: an entry that is not an object at all, and one whose `index` is
    // present but names no Day.
    for (const days of [
      [mkDay(0), 'nope'],
      [mkDay(0), { ...mkDay(1), index: 1.5 }],
      [{ ...mkDay(0), index: undefined }],
    ]) {
      A.updates = [];
      A.event = closingEvent({ days });
      expect(await archiveEvent(1, { now: 5 })).toBe('schedule-unusable');
      expect(A.updates).toEqual([]);
    }
    // The control: an ordinary schedule is untouched by any of this, and its
    // pins are still read and frozen.
    A.updates = [];
    A.serverReads = [];
    A.event = closingEvent();
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.serverReads).toContain('events/test-event/days/0/meta/0');
    expect(A.serverReads).toContain('events/test-event/days/1/meta/1');
  });

  it('refuses a Day index OUTSIDE the supported range, and reads no pin from it', async () => {
    // #1151, Codex P2 on PR #1162 round 7. `Number.isInteger` was the old gate,
    // and these three all pass it. Each is worse than the unreadable index above
    // rather than milder: `days/-1/meta/-1` is a perfectly addressable path, so
    // the pin fetch SUCCEEDS and the freeze could permanently carry an honour on
    // a Day the `DayDef` contract does not have — chipped `D0` or `D11`, inside
    // a `dailyHonors` list the rules cannot walk.
    for (const index of [-1, MAX_DAYS, Number.MAX_SAFE_INTEGER + 2]) {
      A.updates = [];
      A.serverReads = [];
      A.dayMetas = new Map([
        [index, { firstBingo: { uid: 'pin', displayName: 'Pinned', at: 1200 } }],
      ]);
      A.event = closingEvent({ days: [mkDay(0), { ...mkDay(1), index }] });
      expect(await archiveEvent(1, { now: 5 })).toBe('schedule-unusable');
      expect(A.updates).toEqual([]);
      // Refused BEFORE any pin is addressed, exactly as the repeated index is:
      // the refusal is about the schedule, not about what is stored under it.
      expect(A.serverReads.some((p) => p.includes('/meta/'))).toBe(false);
    }

    // THE CONTROL, at both ends of the range the contract does support.
    A.updates = [];
    A.serverReads = [];
    A.dayMetas = new Map([
      [MAX_DAYS - 1, { firstBingo: { uid: 'pin', displayName: 'Pinned', at: 1200 } }],
    ]);
    A.event = closingEvent({ days: [mkDay(0), { ...mkDay(1), index: MAX_DAYS - 1 }] });
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.serverReads).toContain(`events/test-event/days/${MAX_DAYS - 1}/meta/${MAX_DAYS - 1}`);
    expect((A.updates[0].archive as { dailyHonors: { dayIndex: number }[] }).dailyHonors).toEqual([
      expect.objectContaining({ dayIndex: MAX_DAYS - 1, uid: 'pin' }),
    ]);
  });

  it('refuses a schedule that names one Day TWICE, and still takes a non-contiguous one', async () => {
    // Codex P2 on PR #1162. A repeated integer index is perfectly READABLE —
    // both entries address a real document — which is why the unusable-index
    // check let it through. But the two entries are not two Days: `dayMetas` is
    // keyed by index, so the second snapshot overwrites the first, while
    // `pinnedOrDerivedDailyHonors` flat-maps over the schedule ENTRIES and emits
    // that one Day's honour once per entry. The record would freeze the same
    // `dayIndex` twice, permanently, against a `dailyHonors` contract that is one
    // honour per Day — and `completeArchiveRecord` cannot look inside a list to
    // refuse it.
    A.dayMetas = new Map([[1, { firstBingo: { uid: 'pin', displayName: 'Pinned', at: 1200 } }]]);
    A.event = closingEvent({ days: [mkDay(0), mkDay(1), mkDay(1)] });
    expect(await archiveEvent(1, { now: 5 })).toBe('schedule-unusable');
    expect(A.updates).toEqual([]);
    // Refused BEFORE the pins are addressed, exactly as the unreadable-index
    // case is: the refusal is about the schedule, not about what is stored under
    // it, so there is no reason to spend the reads.
    expect(A.serverReads.some((p) => p.includes('/meta/'))).toBe(false);

    // …and the duplicate need not be adjacent, or the only pair.
    A.updates = [];
    A.event = closingEvent({ days: [mkDay(4), mkDay(7), mkDay(4)] });
    expect(await archiveEvent(1, { now: 5 })).toBe('schedule-unusable');
    expect(A.updates).toEqual([]);

    // THE CONTROL, and the point of keying on `DayDef.index` at all: a UNIQUE
    // non-contiguous schedule is not a broken one. A one-Day Event at index 4 is
    // read at `days/4/meta/4` and frozen, never at `days/0`.
    A.updates = [];
    A.serverReads = [];
    A.dayMetas = new Map([[4, { firstBingo: { uid: 'pin', displayName: 'Pinned', at: 1200 } }]]);
    A.event = closingEvent({ days: [mkDay(4)] });
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.serverReads).toContain('events/test-event/days/4/meta/4');
    expect(A.serverReads.some((p) => p.includes('days/0/meta/0'))).toBe(false);
    expect((A.updates[0].archive as { dailyHonors: { dayIndex: number }[] }).dailyHonors).toEqual([
      expect.objectContaining({ dayIndex: 4, uid: 'pin' }),
    ]);
  });

  it('REPORTS an Event it cannot fingerprint, rather than throwing past the cleanup', async () => {
    // Codex P2 on PR #1162. The canonicaliser is cycle-safe and Firestore-aware
    // now, so the concrete `DocumentReference` cycle cannot reach here — but the
    // fingerprint is taken over a RAW document after play has closed and outside
    // every `archiveRead` wrapper, so ANY throw from it left `archiveEvent`
    // rejecting: the console's automatic reopen never ran and a live Event was
    // stranded shut. A throwing getter stands in for the causes nobody
    // anticipated, all of which are properties of the STORED document and would
    // therefore meet a second attempt too.
    const hostile: Record<string, unknown> = { index: 0 };
    Object.defineProperty(hostile, 'theme', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    A.event = closingEvent({ days: [hostile] });
    expect(await archiveEvent(1, { now: 5 })).toBe('config-unreadable');
    expect(A.updates).toEqual([]);
    // Refused at the PRE-READ, before the queue, the roster or any honour pin is
    // asked for: without a fingerprint there is nothing for the later reads to be
    // compared against.
    expect(A.serverReads).toEqual(['events/test-event']);
  });

  it('never reaches the queue when the Event was not shut at all', async () => {
    // `not-closing` comes first: an Event that was never quiesced has a Claim
    // queue that is still moving, so reading it would answer nothing.
    A.event = closingEvent({ archiving: false });
    expect(await archiveEvent(1, { now: 5 })).toBe('not-closing');
    expect(A.serverReads).toEqual(['events/test-event']);
  });

  it('never reaches the queue when the generation in force is not the one it holds', async () => {
    // The binding is checked before the reads as well as inside the transaction:
    // four round trips spent building a record the commit must refuse anyway is
    // exactly what the pre-check saves.
    A.event = closingEvent({ archiveToken: 2 });
    expect(await archiveEvent(1, { now: 5 })).toBe('quiesce-changed');
    expect(A.serverReads).toEqual(['events/test-event']);
    expect(A.updates).toEqual([]);
  });

  it('ignores a pending Claim outside admin-confirmed mode, which has no drain path', async () => {
    // #269's mode gate, unchanged: outside `admin_confirmed` the Review queue
    // offers no Confirm/Reject, so refusing here would be a dead end rather than
    // a gate. The same `claimsAwaitingAdmin` the console applies decides it.
    A.event = closingEvent({ claimMode: 'honor' });
    A.claims = [{ status: 'pending' }];
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
  });

  it('counts a pending Claim on an Event whose stored Claim Mode is the LEGACY spelling', async () => {
    // Codex P2, PR #1139. This pre-read is deliberately converter-free, but
    // `claimsQueueOpen` compares against the CURRENT contract — and an Event
    // seeded or written before the rename persists `'verified'` for what is now
    // `'admin_confirmed'`. The console gates on the CONVERTED document, so the
    // two halves of one gate read the same queue and disagreed: the console
    // refused to arm while this take passed vacuously and would have frozen the
    // Event over exactly the Claims the gate exists to drain.
    A.event = closingEvent({ claimMode: 'verified' });
    A.claims = [{ status: 'pending' }];
    expect(await archiveEvent(1, { now: 5 })).toBe('claims-pending');
    expect(A.updates).toEqual([]);
  });

  it('still freezes a legacy-spelled Event whose queue is genuinely drained', async () => {
    // The control: the coercion decides which Events HAVE a queue, never that a
    // legacy spelling blocks archival on its own.
    A.event = closingEvent({ claimMode: 'verified' });
    A.claims = [{ status: 'confirmed' }];
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
  });

  it('refuses when the stored Event has no room left for an ordinary record', async () => {
    // Codex P2, PR #1139 round 4. The record is not written to an empty
    // document: the check that matters is on the one the update PRODUCES. The
    // roster here is a single ordinary row — it is the Event's own fields that
    // have no room left — and the refusal still has to come before the write,
    // because gameplay is already shut by the time this runs.
    A.event = closingEvent({
      days: [
        {
          index: 0,
          theme: 'neon-playground',
          snapshotItemIds: Array.from({ length: 60_000 }, (_, i) => `item-${i}-padding`),
        },
      ],
    });
    expect(await archiveEvent(1, { now: 5 })).toBe('too-large');
    expect(A.updates).toEqual([]);
  });

  it('freezes a scheduleless Event whose roster names thousands of Days', async () => {
    // #1151, Codex P2 on PR #1162 round 7. This used to be the `too-large`
    // fixture, and it no longer is: `dayStats` is a Player-written map with no
    // rules validation, an Event with no schedule renders the derived list
    // straight through, and one such row therefore minted one honour per bucket
    // — six thousand of them, past the record's own quarter of the budget. The
    // supported-range filter is what closes it at the source, so the freeze now
    // completes and the record carries at most one honour per Day the contract
    // has.
    const dayStats: Record<number, Record<string, number>> = {};
    for (let i = 0; i < 6_000; i++) {
      dayStats[i] = { bingoCount: 1, squaresMarked: 1, firstBingoAt: 1_000 + i };
    }
    A.players = [{ uid: 'whale', displayName: 'Whale', bingoCount: 1, squaresMarked: 1, dayStats }];
    A.event = closingEvent({ days: [] });
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    const record = A.updates[0].archive as { dailyHonors: { dayIndex: number }[] };
    expect(record.dailyHonors.map((h) => h.dayIndex)).toEqual([
      ...Array.from({ length: MAX_DAYS }, (_, i) => i),
    ]);
    // …and the ceiling itself is unchanged: the refusal above it, taken over the
    // stored Event's own oversized fields, is the route that is still reachable.
  });

  it('freezes a roster whose counts the rules would refuse, because the writer clamps them', async () => {
    // #1151, Codex P1 on PR #1162. The end-to-end shape of the finding: a Player
    // self-writes a finite count far outside `finiteArchiveNumber` and holds the
    // headline honour, so their row reaches the flip TWICE — in `standings` and
    // as `firstBingoRow`, the half the rules validate whole. The freeze
    // completes, with every copy of that number inside the range the boundary
    // accepts.
    A.players = [
      { uid: 'huge', displayName: 'Huge', bingoCount: 5e12, squaresMarked: 5e12, firstBingoAt: 900 },
    ];
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    const record = A.updates[0].archive as {
      standings: { bingoCount: number }[];
      firstBingoRow: { bingoCount: number; squaresMarked: number } | null;
    };
    expect(record.standings[0].bingoCount).toBe(MAX_ARCHIVE_NUMBER);
    expect(record.firstBingoRow?.bingoCount).toBe(MAX_ARCHIVE_NUMBER);
    expect(record.firstBingoRow?.squaresMarked).toBe(MAX_ARCHIVE_NUMBER);
  });

  it('REFUSES a record the boundary would not accept, rather than letting the flip be rejected', async () => {
    // The backstop reported as a refusal like every other one: it writes
    // nothing, and the console reopens play behind it. The stamp is the one
    // number the builder is handed rather than coerces, so it is the one a
    // caller can still make unwritable.
    expect(await archiveEvent(1, { now: Number.NaN })).toBe('record-unwritable');
    expect(A.updates).toEqual([]);
  });

  it('freezes a row whose STORED uid is 300 KB, carrying the document id instead', async () => {
    // #1151, Codex P1 on PR #1162. `players/{uid}`'s rules arm binds the PATH
    // (`isOwner(uid)`) and validates NOTHING inside the document — not the
    // presence of `uid`, not its type, and not its length. So a Player can put
    // 300 KB at `uid` on their own row, and a record that copied it would blow
    // the 256 KiB ceiling on every attempt, permanently, on an Event the closing
    // write has already shut. The freeze reads the roster through
    // `playersCol()`, whose converter pins `uid` to the document id, so the
    // stored field never reaches the record at all.
    A.players = [
      {
        id: 'alice',
        uid: 'X'.repeat(300 * 1024),
        displayName: 'Alice',
        bingoCount: 1,
        squaresMarked: 9,
      },
    ];
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    const archive = A.updates[0].archive as {
      standings: { uid: string }[];
      playerCount: number;
    };
    expect(archive.standings.map((r) => r.uid)).toEqual(['alice']);
    expect(archive.playerCount).toBe(1);
  });
});

// #1151, routed here from #1150's review. The quiesce WITHHOLDS the finale beats
// rather than cancelling them — they land at the scheduled cutoff once play
// reopens — but `status: 'archived'` is irreversible, so an Event archived first
// never gets them at all and nothing else says so.
describe('archiveEvent — the finale gate', () => {
  const closingEvent = (over: Record<string, unknown> = {}) => ({
    status: 'active',
    archiving: true,
    archiveToken: 1,
    claimMode: 'honor',
    days: [mkDay(0), mkDay(1)],
    bannedUids: [],
    standingsFreezeAt: 8000,
    ...over,
  });

  beforeEach(() => {
    A.event = closingEvent();
    A.claims = [];
    A.players = [{ uid: 'alice', displayName: 'Alice', bingoCount: 1, squaresMarked: 9 }];
    A.dayMetas = new Map();
    A.updates = [];
    A.serverReads = [];
    A.beforeTx = null;
  });

  it('REFUSES, and writes nothing, while the scheduled Standings Freeze has not run', async () => {
    expect(await archiveEvent(1, { now: 5 })).toBe('finale-pending');
    expect(A.updates).toEqual([]);
  });

  it('freezes once the finale has run — the control', async () => {
    A.event = closingEvent({ frozenAt: 8000, finaleCompletedAt: 8100 });
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
  });

  it('REFUSES on a freeze stamp with no completion marker beside it', async () => {
    // #1151, Codex P1 on PR #1162. The freeze transaction and the podium Moment
    // are separate writes, so this is the real state of an Event whose podium
    // beat has not landed yet — and the flip would forgo it permanently.
    A.event = closingEvent({ frozenAt: 8000 });
    expect(await archiveEvent(1, { now: 5 })).toBe('finale-pending');
    expect(A.updates).toEqual([]);
    // …and the same Event archives once the Admin says so explicitly, which is
    // the whole point of a warning rather than a bar.
    expect(await archiveEvent(1, { now: 5, beforeFinale: true })).toBe('archived');
  });

  it('freezes an Event that has no scheduled finale at all', async () => {
    // A legacy Event with no ceremonial Day and no stored freeze never freezes
    // on its own, so gating on one would strand it closed forever.
    A.event = closingEvent({ standingsFreezeAt: undefined, days: [] });
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
  });

  it('archives BEFORE the finale only when the Admin says so explicitly', async () => {
    // The override the console's own acknowledgement carries. It is a decision
    // an Admin may legitimately take — an Event that will never reach its
    // finale — but never a default.
    expect(await archiveEvent(1, { now: 5, beforeFinale: true })).toBe('archived');
    expect(A.updates).toHaveLength(1);
    // The record still cuts on the resolved freeze, so the standings it keeps
    // are the ones the finale would have settled.
    expect((A.updates[0].archive as { freezeAt: number | null }).freezeAt).toBe(8000);
  });

  it('is decided AFTER the drain gate, so the queue is reported first', async () => {
    // Both are pre-write refusals, and the Admin can only act on one at a time.
    // The Claim queue comes first because it is the one the freeze makes
    // permanently unresolvable.
    A.event = closingEvent({ claimMode: 'admin_confirmed' });
    A.claims = [{ status: 'pending' }];
    expect(await archiveEvent(1, { now: 5 })).toBe('claims-pending');
  });
});

// CodeRabbit Major on PR #1162. Every read below is taken AFTER `beginArchive`
// has shut the Event, so a read that does not answer is not a failed call — it is
// a live Event left closed with no record and nothing for the console to clean up
// after. Thrown, it went past every branch of `runArchive` and surfaced as the
// generic `AsyncButton` failure pill; returned, it is the same shape of refusal
// as `claims-pending`, and the automatic reopen puts play back.
describe('archiveEvent — a server read that does not answer is a REFUSAL, not a throw', () => {
  const closingEvent = (over: Record<string, unknown> = {}) => ({
    status: 'active',
    archiving: true,
    archiveToken: 1,
    claimMode: 'admin_confirmed',
    days: [mkDay(0), mkDay(1)],
    bannedUids: [],
    frozenAt: 50_000,
    finaleCompletedAt: 50_100,
    ...over,
  });

  beforeEach(() => {
    A.event = closingEvent();
    A.claims = [];
    A.players = [{ uid: 'alice', displayName: 'Alice', bingoCount: 1, squaresMarked: 9 }];
    A.dayMetas = new Map();
    A.updates = [];
    A.serverReads = [];
    A.beforeTx = null;
  });

  it('freezes when every read answers — the control', async () => {
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
  });

  it('names the EVENT pre-read, and never reaches the queue behind it', async () => {
    // The first read of the four. Nothing after it can be decided — the Day count
    // that says which honour pins to fetch comes off this document — so it refuses
    // here rather than proceeding on a schedule it never saw.
    A.failServerRead = (path) => path === 'events/test-event';
    expect(await archiveEvent(1, { now: 5 })).toBe('read-failed:event');
    expect(A.updates).toEqual([]);
    expect(A.serverReads).toEqual(['events/test-event']);
  });

  it('names the CLAIM QUEUE read, rather than passing a queue it could not see', async () => {
    // The drain gate reads `.docs` off this result, so an unanswered read is the
    // one shape that must never be mistaken for a drained queue: the freeze it
    // would let through makes every Claim in that queue unresolvable forever.
    A.failServerRead = (path) => path.endsWith('/claims');
    expect(await archiveEvent(1, { now: 5 })).toBe('read-failed:claims');
    expect(A.updates).toEqual([]);
    // Refused at the queue, before the roster and the honour pins are asked for.
    expect(A.serverReads).toEqual(['events/test-event', 'events/test-event/claims']);
  });

  it('names the ROSTER read', async () => {
    A.failServerRead = (path) => path.endsWith('/players');
    expect(await archiveEvent(1, { now: 5 })).toBe('read-failed:roster');
    expect(A.updates).toEqual([]);
  });

  it('names the DAY-META read, and is not mistaken for the roster beside it', async () => {
    // The two are issued together, and each is guarded on its own precisely so
    // the refusal can say which of them did not answer.
    A.failServerRead = (path) => path.includes('/days/');
    expect(await archiveEvent(1, { now: 5 })).toBe('read-failed:day-meta');
    expect(A.updates).toEqual([]);
    // The roster was still read — the pair overlaps on the wire, and one wrapper
    // failing must not leave the other's rejection unhandled either.
    expect(A.serverReads).toContain('events/test-event/players');
  });

  it('names the TRANSACTION’s own Event re-read once the transaction gives up', async () => {
    // The one read whose rejection arrives as a rejected `runTransaction`, which
    // is also how a failed COMMIT arrives. It is flagged and RE-THROWN so the SDK
    // still gets to retry it, and classified only out here, where a transaction
    // that has already given up is known to have written nothing.
    A.failTxRead = true;
    expect(await archiveEvent(1, { now: 5 })).toBe('read-failed:event');
    expect(A.updates).toEqual([]);
  });

  it('still THROWS when the write itself fails — the refusal is not a catch-all', async () => {
    // The control for the line above, and the boundary of this whole change: a
    // failed commit is a failed archive, and reporting "nothing was frozen" about
    // one would be a claim this call cannot make.
    A.failTxWrite = true;
    await expect(archiveEvent(1, { now: 5 })).rejects.toThrow('commit failed');
    expect(A.updates).toEqual([]);
  });
});
