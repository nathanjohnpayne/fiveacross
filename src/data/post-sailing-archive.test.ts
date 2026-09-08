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
  MAX_ARCHIVED_DISPLAY_NAME,
  MAX_ARCHIVED_EVENT_NAME,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVED_EVENT_BYTES,
  MAX_ARCHIVED_STANDING_ROWS,
} from './eventArchive';
import { dayHonorChipLabel } from './finale';
import { migrateDayFields } from './converters';
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
  players: [] as Record<string, unknown>[],
  dayMetas: new Map<number, Record<string, unknown>>(),
  /** Field maps handed to `tx.update` — empty means the call wrote nothing. */
  updates: [] as Record<string, unknown>[],
  /** Every server-read path, in order, so "after the close" is provable. */
  serverReads: [] as string[],
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
      return snapOf(r.path);
    },
    getDocsFromServer: async (r: Ref) => {
      A.serverReads.push(r.path);
      const rows = r.path.endsWith('/claims')
        ? A.claims
        : r.path.endsWith('/players')
          ? A.players
          : [];
      return { docs: rows.map((row) => ({ exists: () => true, data: () => row })) };
    },
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

  it('leaves a well-formed row untouched, object identity included', () => {
    // The normalisation must be a no-op on every ordinary roster: the console
    // re-runs this on every render, and copying each row would defeat the
    // reference equality React's memoisation elsewhere relies on.
    const clean = mkPlayer({ uid: 'clean', displayName: 'Clean', firstBingoAt: 900 });
    expect(withReadableDayStats(clean)).toBe(clean);
    const nulled = mkPlayer({ uid: 'nulled', displayName: 'Nulled', firstBingoAt: null });
    expect(withReadableDayStats(nulled)).toBe(nulled);
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

  it('drops a daily honour whose Day index is not one', () => {
    // A derived honour reads its `dayIndex` off a `dayStats` KEY, and `dayStats`
    // is a Player-written map with no rules validation — so a junk key becomes
    // `Number('abc')`, a chip nothing could label. The live honours strip drops
    // it by matching against the schedule; the record has to drop it itself,
    // because the record is permanent and an Event with no schedule at all
    // renders the derived list straight through.
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
  it('is satisfied once the scheduler has stamped frozenAt', () => {
    expect(finaleHasRun({ frozenAt: 8000, days: DAYS })).toBe(true);
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
    // `frozenAt` is in the fingerprint because it resolves the honour cutoff AND
    // answers the finale gate: a freeze stamped between the pre-read and the
    // commit would leave the record cut on one answer and gated on another.
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

  it('refuses a record the server re-read makes too large, and writes nothing', async () => {
    // The console checked the record it previewed from its live subscriptions;
    // this is the one built from the roster read after the close, and a Player
    // row is not validated by any rule on the way in.
    const dayStats: Record<number, Record<string, number>> = {};
    for (let i = 0; i < 6_000; i++) {
      dayStats[i] = { bingoCount: 1, squaresMarked: 1, firstBingoAt: 1_000 + i };
    }
    A.players = [{ uid: 'whale', displayName: 'Whale', bingoCount: 1, squaresMarked: 1, dayStats }];
    // An Event with no schedule, so the derived honours flow through
    // unmatched — one per bucket the Player wrote, and `dayStats` is a
    // Player-written map with no rules validation on the way in.
    A.event = closingEvent({ days: [] });
    expect(await archiveEvent(1, { now: 5 })).toBe('too-large');
    expect(A.updates).toEqual([]);
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
    A.event = closingEvent({ frozenAt: 8000 });
    expect(await archiveEvent(1, { now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
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
