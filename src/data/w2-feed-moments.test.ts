import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MomentDoc, MomentKind, NoticeDoc, ProofDoc } from '../types';

// specs/w2-feed-moments.md, unit layer. Two Feed halves proven here:
//
// 1. The Moment WRITER (src/data/moments.ts): a first BINGO broadcasts exactly ONE
//    `bingo` Moment, a Blackout exactly one `blackout`, First-to-BINGO exactly one
//    `first_bingo` — each a single offline-queueable setDoc (never addDoc/
//    runTransaction), carrying EXACTLY the MomentDoc fields (ADR 0002: no media,
//    no proofId), attributed + bounded like a Tally marker. Every write goes
//    through the write-once cache pre-check (round 3 finding C): a Moment already
//    in the LOCAL cache is skipped entirely so an optimistic duplicate can never
//    overwrite its own doc and reorder the Feed until the server denies it. The
//    deterministic doc id (per-Player `${uid}-bingo`/`-blackout`; event-singleton
//    `first_bingo`) is what makes the once-only structural — the rules half is
//    tests/rules/w2-feed-moments.test.ts.
// 2. The Feed MERGE (mergeFeed in src/hooks/useData.ts): Proofs + Moments fold into
//    one newest-first, capped stream; a bare Mark (neither a Proof nor a Moment)
//    contributes nothing.

const EVENT_ID = 'med-2026'; // src/firebase.ts default when VITE_EVENT_ID is unset

// Plain vi.fn() so `.mock.calls` stays loosely typed (indexable) like the sibling
// tally suite; the resolved Promise (moments.ts does `setDoc(...).catch(...)`) is
// set in beforeEach so a re-broadcast's .catch has something to attach to.
const {
  setDocSpy,
  getDocSpy,
  getDocFromServerSpy,
  getDocFromCacheSpy,
  writeBatchSpy,
  batchDeleteSpy,
  batchSetSpy,
  batchCommitSpy,
} = vi.hoisted(() => {
  // ONE shared batch handle across calls: the retraction asserts BOTH writes ride
  // the SAME batch (atomic delete + tombstone — #377), so the spies are shared and
  // the call counts on `writeBatchSpy` say how many batches were opened.
  const batchDeleteSpy = vi.fn();
  const batchSetSpy = vi.fn();
  const batchCommitSpy = vi.fn();
  return {
    setDocSpy: vi.fn(),
    getDocSpy: vi.fn(),
    getDocFromServerSpy: vi.fn(),
    getDocFromCacheSpy: vi.fn(),
    batchDeleteSpy,
    batchSetSpy,
    batchCommitSpy,
    writeBatchSpy: vi.fn(() => ({
      delete: batchDeleteSpy,
      set: batchSetSpy,
      commit: batchCommitSpy,
    })),
  };
});

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026' }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
    setDoc: setDocSpy,
    getDoc: getDocSpy,
    getDocFromServer: getDocFromServerSpy,
    getDocFromCache: getDocFromCacheSpy,
    writeBatch: writeBatchSpy,
    addDoc: vi.fn(),
    runTransaction: vi.fn(),
  };
});

import {
  broadcastBingo,
  broadcastBlackout,
  broadcastFirstBingo,
  hasPriorBingoWitness,
  FIRST_BINGO_MOMENT_ID,
  enqueueWinMoments,
  enqueueFirstBingoMoment,
  peekPendingMoments,
  pendingBlackoutDayIndexes,
  pendingBingoDayIndexes,
  pendingFirstBingoDayIndex,
  removePendingBlackoutDay,
  removePendingBingoDay,
  clearPendingMoment,
  dropPendingWins,
  enqueueRetraction,
  drainRetractions,
  peekRetractions,
  resetRetractions,
  pendingActionGeneration,
  firstBingoCandidateCurrent,
  resetPendingMoments,
  __resetPendingMomentsMemoryForTests,
} from './moments';
import { hasCanonicalMomentId, mergeFeed } from '../hooks/useData';
import { addDoc, runTransaction } from 'firebase/firestore';

// Drain the write-once pre-check's microtasks (getDocFromCache → setDoc): the
// broadcasts stay fire-and-forget, so assertions settle the queue first.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  setDocSpy.mockResolvedValue(undefined);
  batchCommitSpy.mockResolvedValue(undefined);
  // The tombstone confirmation read (#377): a CACHED tombstone must be re-read
  // through the normal path before it suppresses a broadcast, so an admin-deleted
  // tombstone stops suppressing. Default: the server agrees the doc is there.
  getDocSpy.mockImplementation((ref: { path: string }) =>
    Promise.resolve({ exists: () => ref.path.includes('/momentRetractions/'), data: () => ({}) }),
  );
  getDocFromServerSpy.mockResolvedValue({ exists: () => false, data: () => ({}) });
  resetRetractions();
  // Cache-miss default: getDocFromCache REJECTS when the doc is not cached, which
  // is the fresh-state norm — the write-once pre-check then lets the write proceed.
  getDocFromCacheSpy.mockRejectedValue(new Error('unavailable'));
  // The pending-Moment queue is MODULE state (it survives unmounts on purpose,
  // issue #104), so reset it between cases for isolation.
  resetPendingMoments();
});

describe('moments broadcasts — the Feed beat writer (specs/w2-feed-moments.md)', () => {
  it('a first BINGO broadcasts exactly one `bingo` Moment at the per-Player id, no evidence', async () => {
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null });
    await settle();

    expect(setDocSpy).toHaveBeenCalledTimes(1);
    const [ref, payload] = setDocSpy.mock.calls[0];
    // Deterministic per-Player id → once-per-Player is structural (rules: update is denied).
    expect(ref.path).toBe(`events/${EVENT_ID}/moments/u1-bingo`);
    // EXACTLY the MomentDoc fields — no media, mediaURL, storagePath, or proofId (ADR 0002).
    expect(payload).toEqual({
      kind: 'bingo',
      uid: 'u1',
      displayName: 'Alice',
      photoURL: null,
      createdAt: expect.any(Number),
    });
    expect('mediaURL' in payload).toBe(false);
    expect('proofId' in payload).toBe(false);
  });

  it('a legacy (day-less) Blackout broadcasts one `blackout` Moment at the per-Player id', async () => {
    broadcastBlackout({ uid: 'u1', displayName: 'Alice', photoURL: 'https://x/a.jpg' });
    await settle();

    expect(setDocSpy).toHaveBeenCalledTimes(1);
    const [ref, payload] = setDocSpy.mock.calls[0];
    expect(ref.path).toBe(`events/${EVENT_ID}/moments/u1-blackout`);
    expect(payload).toMatchObject({ kind: 'blackout', uid: 'u1', photoURL: 'https://x/a.jpg' });
  });

  it('a per-card Blackout (#267) writes a per-(Player, Day) id — a second Day posts its own Moment, the same Day dedupes', async () => {
    broadcastBlackout({ uid: 'u1', displayName: 'Alice', photoURL: null }, 3);
    broadcastBlackout({ uid: 'u1', displayName: 'Alice', photoURL: null }, 6);
    await settle();

    expect(setDocSpy).toHaveBeenCalledTimes(2);
    expect(setDocSpy.mock.calls[0][0].path).toBe(`events/${EVENT_ID}/moments/u1-blackout-d3`);
    expect(setDocSpy.mock.calls[0][1]).toMatchObject({ kind: 'blackout', uid: 'u1', dayIndex: 3 });
    expect(setDocSpy.mock.calls[1][0].path).toBe(`events/${EVENT_ID}/moments/u1-blackout-d6`);
    expect(setDocSpy.mock.calls[1][1]).toMatchObject({ kind: 'blackout', uid: 'u1', dayIndex: 6 });
  });

  it('a per-card Blackout skips when a LEGACY day-less Moment already covers the SAME Day (Codex P2 on #275 round 2)', async () => {
    // The legacy `${uid}-blackout` doc (the #250-era shape: day-less id, day-
    // stamped payload) is in the local cache for Day 3.
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) =>
      ref.path.endsWith('u1-blackout')
        ? Promise.resolve({ exists: () => true, data: () => ({ dayIndex: 3 }) })
        : Promise.reject(new Error('unavailable')),
    );
    broadcastBlackout({ uid: 'u1', displayName: 'Alice', photoURL: null }, 3);
    await settle();
    expect(setDocSpy).not.toHaveBeenCalled(); // same card — already posted

    // A DIFFERENT Day is a different card: the legacy doc does not cover it.
    broadcastBlackout({ uid: 'u1', displayName: 'Alice', photoURL: null }, 6);
    await settle();
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(setDocSpy.mock.calls[0][0].path).toBe(`events/${EVENT_ID}/moments/u1-blackout-d6`);
  });

  it('a per-card BINGO (#372) writes a per-(Player, Day) id — a second Day posts its own Moment', async () => {
    // THE #372 REGRESSION TEST. Pre-fix both calls targeted `u1-bingo`, so the
    // second was a doc-exists update on an immutable Moment: denied server-side
    // and swallowed as the designed once-only path. The Player saw the
    // celebration on Day 6 and the Feed received nothing.
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null }, 3);
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null }, 6);
    await settle();

    expect(setDocSpy).toHaveBeenCalledTimes(2);
    expect(setDocSpy.mock.calls[0][0].path).toBe(`events/${EVENT_ID}/moments/u1-bingo-d3`);
    expect(setDocSpy.mock.calls[0][1]).toMatchObject({ kind: 'bingo', uid: 'u1', dayIndex: 3 });
    expect(setDocSpy.mock.calls[1][0].path).toBe(`events/${EVENT_ID}/moments/u1-bingo-d6`);
    expect(setDocSpy.mock.calls[1][1]).toMatchObject({ kind: 'bingo', uid: 'u1', dayIndex: 6 });
  });

  it('a legacy (day-less) BINGO still broadcasts at the once-per-Player id', async () => {
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: 'https://x/a.jpg' });
    await settle();

    expect(setDocSpy).toHaveBeenCalledTimes(1);
    const [ref, payload] = setDocSpy.mock.calls[0];
    expect(ref.path).toBe(`events/${EVENT_ID}/moments/u1-bingo`);
    expect(payload).toMatchObject({ kind: 'bingo', uid: 'u1', photoURL: 'https://x/a.jpg' });
    expect('dayIndex' in payload).toBe(false);
  });

  it('a per-card BINGO skips when a LEGACY day-less Moment already covers the SAME Day (#372, mirroring #275 round 2)', async () => {
    // Not hypothetical: every Player who bingoed before #372 shipped owns a
    // `${uid}-bingo` doc (day-less id, day-stamped payload since #262). That
    // Day must not post a second, day-stamped Moment for the same card.
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) =>
      ref.path.endsWith('u1-bingo')
        ? Promise.resolve({ exists: () => true, data: () => ({ dayIndex: 3 }) })
        : Promise.reject(new Error('unavailable')),
    );
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null }, 3);
    await settle();
    expect(setDocSpy).not.toHaveBeenCalled(); // same card — already posted

    // A DIFFERENT Day is a different card: the legacy doc does not cover it.
    // This is the live upgrade path — the Player keeps bingoing on later Days.
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null }, 6);
    await settle();
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(setDocSpy.mock.calls[0][0].path).toBe(`events/${EVENT_ID}/moments/u1-bingo-d6`);
  });

  it('First-to-BINGO broadcasts one `first_bingo` Moment at the EVENT-singleton id', async () => {
    expect(FIRST_BINGO_MOMENT_ID).toBe('first_bingo');
    broadcastFirstBingo({ uid: 'u1', displayName: 'Alice', photoURL: null });
    await settle();

    expect(setDocSpy).toHaveBeenCalledTimes(1);
    const [ref, payload] = setDocSpy.mock.calls[0];
    // A fixed per-Event id → once-per-Event structurally (first create wins; the
    // race's later writers hit the deny-all update rule and are denied).
    expect(ref.path).toBe(`events/${EVENT_ID}/moments/first_bingo`);
    expect(payload).toMatchObject({ kind: 'first_bingo', uid: 'u1' });
  });

  it('bounds an over-long attributed name to the 100-char Moment cap (rules-valid)', async () => {
    broadcastBingo({ uid: 'u1', displayName: 'x'.repeat(140), photoURL: null });
    await settle();
    expect((setDocSpy.mock.calls[0][1].displayName as string).length).toBe(100);
  });

  it('is offline-queueable — a plain setDoc, never addDoc or runTransaction', async () => {
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null });
    await settle();
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(addDoc).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('SKIPS the write when the Moment is already in the local cache (round 3 finding C)', async () => {
    // A duplicate deterministic-id setDoc would be denied server-side, but latency
    // compensation applies it LOCALLY first — the refreshed createdAt would pin the
    // old Moment to the Feed top until the denial (indefinitely offline). The
    // write-once pre-check catches exactly this: doc cached → no write at all.
    getDocFromCacheSpy.mockResolvedValue({ exists: () => true });
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null });
    await settle();
    expect(setDocSpy).not.toHaveBeenCalled();
  });

  it('writes when the cache has no copy — a cached tombstone (exists=false) or a cache miss both proceed', async () => {
    // exists() === false: the cache KNOWS the doc is absent (e.g. deleted) — write.
    getDocFromCacheSpy.mockResolvedValue({ exists: () => false });
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null });
    await settle();
    expect(setDocSpy).toHaveBeenCalledTimes(1);

    // Cache miss (rejection — fresh device): the pre-check cannot protect anything
    // (no cached copy to overwrite), so the write proceeds and any duplicate still
    // resolves server-side via the create-only rule.
    getDocFromCacheSpy.mockRejectedValue(new Error('unavailable'));
    broadcastBlackout({ uid: 'u1', displayName: 'Alice', photoURL: null });
    await settle();
    expect(setDocSpy).toHaveBeenCalledTimes(2);
  });
});

// --- Retract-once (#377) -----------------------------------------------------
//
// The Feed must not keep claiming a win the card no longer supports. Unmarking
// the square that completed a PUBLISHED BINGO/Blackout retracts its Moment —
// DELETE + TOMBSTONE in one atomic batch — and the tombstone SPENDS that
// (Player, Day) win: the rules deny every later create at the same id, so
// mark/unmark/re-mark can never bounce one win back to the top of the Feed. The
// rules half is tests/rules/w2-feed-moments.test.ts.

// The local-cache oracle these cases drive: `byPath` maps a full doc path to its
// payload; everything else REJECTS, which is what `getDocFromCache` really does
// for an uncached doc.
const cacheHolding = (byPath: Record<string, Record<string, unknown>>) =>
  getDocFromCacheSpy.mockImplementation((ref: { path: string }) =>
    byPath[ref.path]
      ? Promise.resolve({ exists: () => true, data: () => byPath[ref.path] })
      : Promise.reject(new Error('unavailable')),
  );
const momentAt = (id: string) => `events/${EVENT_ID}/moments/${id}`;
const tombstoneAt = (id: string) => `events/${EVENT_ID}/momentRetractions/${id}`;
const serverHolding = (
  byPath: Record<string, Record<string, unknown>>,
  existingTombstones = new Set<string>(),
) => {
  getDocFromServerSpy.mockImplementation((ref: { path: string }) =>
    byPath[ref.path]
      ? Promise.resolve({ exists: () => true, data: () => byPath[ref.path] })
      : Promise.resolve({ exists: () => false, data: () => ({}) }),
  );
  getDocSpy.mockImplementation((ref: { path: string }) => {
    if (ref.path.includes('/momentRetractions/')) {
      return Promise.resolve({ exists: () => existingTombstones.has(ref.path), data: () => ({}) });
    }
    return Promise.resolve({ exists: () => false, data: () => ({}) });
  });
};

// A fall observed, then the SERVER-COMMITTED board that adjudicates it. The two
// steps are deliberately separate in the API (Codex P1, round 1 on PR #467): the
// enqueue writes nothing, and only a server-committed board can spend a win.
const fellThenServerSays = (
  uid: string,
  fell: { bingo?: boolean; blackout?: boolean; bingoDayIndex?: number; blackoutDayIndex?: number },
  board: { dayIndex?: number; bingoStands?: boolean; blackoutStands?: boolean } = {},
) => {
  enqueueRetraction(uid, fell);
  drainRetractions(uid, {
    dayIndex: board.dayIndex,
    bingoStands: board.bingoStands ?? false,
    blackoutStands: board.blackoutStands ?? false,
  });
};

// The pre-set tombstone probe (sibling-form spend, Codex round 2 on PR #467):
// `commitRetraction` reads each tombstone id through the normal `getDoc` path and
// skips the set when one already exists — tombstones have NO update path, so a
// blind re-set would be a doc-exists update and deny the whole batch. The
// beforeEach default resolves exists=true (it serves the write-once confirmation
// read), so retraction cases opt into the fresh-state norm: nothing minted yet.
const noTombstonesYet = () =>
  getDocSpy.mockImplementation(() => Promise.resolve({ exists: () => false, data: () => ({}) }));

describe('retract-once for a PUBLISHED win (#377)', () => {
  it('retracts the per-card BINGO Moment: delete + BOTH tombstone forms, in ONE batch', async () => {
    noTombstonesYet();
    serverHolding({ [momentAt('u1-bingo-d3')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 } });
    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 3 }, { dayIndex: 3 });
    await settle();

    // ONE batch — atomicity is the point (a crash between the writes would
    // leave the win deleted-but-not-spent, i.e. freely repostable).
    expect(writeBatchSpy).toHaveBeenCalledTimes(1);
    expect(batchDeleteSpy).toHaveBeenCalledTimes(1);
    expect(batchCommitSpy).toHaveBeenCalledTimes(1);
    expect(batchDeleteSpy.mock.calls[0][0].path).toBe(momentAt('u1-bingo-d3'));
    // The win is spent under BOTH ids that can address it (Codex round 2 on PR
    // #467): the day-scoped id this bundle writes AND the legacy day-less id a
    // stale pre-#372 bundle would repost the SAME win under. The owner-delete
    // rule enforces the pairing (getAfter on the sibling form), so this is the
    // only batch shape the rules accept.
    expect(batchSetSpy).toHaveBeenCalledTimes(2);
    expect(batchSetSpy.mock.calls[0][0].path).toBe(tombstoneAt('u1-bingo'));
    expect(batchSetSpy.mock.calls[1][0].path).toBe(tombstoneAt('u1-bingo-d3'));
    for (const call of batchSetSpy.mock.calls) {
      expect(call[1]).toEqual({
        uid: 'u1',
        kind: 'bingo',
        dayIndex: 3,
        createdAt: expect.any(Number),
      });
    }
  });

  it('retracts NOTHING when the win never published — a tombstone would spend the slot for free', async () => {
    // The load-bearing guard: minting a tombstone for a Moment that never existed
    // would permanently silence a legitimate FUTURE win for that (Player, Day).
    noTombstonesYet();
    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 3 }, { dayIndex: 3 });
    await settle();
    expect(writeBatchSpy).not.toHaveBeenCalled();
    expect(peekRetractions('u1')).toEqual([]);
  });

  it('NEVER writes at the fall itself — the intent waits for a SERVER-COMMITTED board (Codex P1)', async () => {
    // `setMark` is fire-and-forget: its verdict is a LOCAL fold while its batch is
    // still pending. Spending the win here would irreversibly silence a STANDING
    // win whenever the unmark is later rejected and rolled back.
    noTombstonesYet();
    serverHolding({ [momentAt('u1-bingo-d3')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 } });
    enqueueRetraction('u1', { bingo: true, bingoDayIndex: 3 });
    await settle();
    expect(writeBatchSpy).not.toHaveBeenCalled();
    expect(peekRetractions('u1')).toEqual(['bingo:3']);

    // The server-committed board confirms the fall — now it commits.
    drainRetractions('u1', { dayIndex: 3, bingoStands: false, blackoutStands: false });
    await settle();
    expect(writeBatchSpy).toHaveBeenCalledTimes(1);
    expect(peekRetractions('u1')).toEqual([]);
  });

  it('DROPS the intent when the server says the win still stands — a rejected unmark spends nothing', async () => {
    // The P1 scenario end to end: an unmark denied by the board rule (e.g. a
    // pre-#458 cells-array straggler whose per-cell patch fails the canonical-map
    // gate) is rolled back, so the server-committed board still shows the bingo.
    serverHolding({ [momentAt('u1-bingo-d3')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 } });
    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 3 }, { dayIndex: 3, bingoStands: true });
    await settle();
    expect(writeBatchSpy).not.toHaveBeenCalled();
    expect(peekRetractions('u1')).toEqual([]); // consumed, not left to fire later
  });

  it('holds an intent whose own Day is not the board being adjudicated', async () => {
    // A Day-3 fall while Day 7 renders: this board is not evidence about that
    // card, so the intent survives until its own board arrives server-committed.
    noTombstonesYet();
    serverHolding({ [momentAt('u1-bingo-d3')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 } });
    enqueueRetraction('u1', { bingo: true, bingoDayIndex: 3 });
    drainRetractions('u1', { dayIndex: 7, bingoStands: false, blackoutStands: false });
    await settle();
    expect(writeBatchSpy).not.toHaveBeenCalled();
    expect(peekRetractions('u1')).toEqual(['bingo:3']);

    drainRetractions('u1', { dayIndex: 3, bingoStands: false, blackoutStands: false });
    await settle();
    expect(writeBatchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps intents per-uid and survives across calls — module state, like the pending queue', async () => {
    enqueueRetraction('u1', { bingo: true, bingoDayIndex: 3 });
    enqueueRetraction('u2', { blackout: true, blackoutDayIndex: 5 });
    expect(peekRetractions('u1')).toEqual(['bingo:3']);
    expect(peekRetractions('u2')).toEqual(['blackout:5']);
    resetRetractions();
    expect(peekRetractions('u1')).toEqual([]);
    expect(peekRetractions('u2')).toEqual([]);
  });

  it('retracts only the kind that FELL — a blackout fall leaves a still-standing bingo alone', async () => {
    noTombstonesYet();
    serverHolding({
      [momentAt('u1-bingo-d3')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 },
      [momentAt('u1-blackout-d3')]: { kind: 'blackout', uid: 'u1', dayIndex: 3 },
    });
    // Unmarking one square of a blacked-out card drops the blackout while the
    // lines (and so the bingo) still stand — the common real sequence.
    fellThenServerSays('u1', { blackout: true, blackoutDayIndex: 3 }, { dayIndex: 3, bingoStands: true });
    await settle();

    expect(writeBatchSpy).toHaveBeenCalledTimes(1);
    expect(batchDeleteSpy.mock.calls[0][0].path).toBe(momentAt('u1-blackout-d3'));
    expect(batchSetSpy.mock.calls[0][1]).toMatchObject({ kind: 'blackout', dayIndex: 3 });
  });

  it('requeues a consumed intent when the retraction batch is rejected', async () => {
    noTombstonesYet();
    serverHolding({ [momentAt('u1-bingo-d3')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 } });
    batchCommitSpy.mockRejectedValueOnce(new Error('permission-denied'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 3 }, { dayIndex: 3 });
    await settle();

    expect(consoleError).toHaveBeenCalledWith(
      '[moments] retraction rejected',
      { momentIds: ['u1-bingo-d3'], kind: 'bingo', uid: 'u1' },
      expect.any(Error),
    );
    expect(batchCommitSpy).toHaveBeenCalledTimes(1);
    expect(peekRetractions('u1')).toEqual(['bingo:3']);

    drainRetractions('u1', { dayIndex: 3, bingoStands: false, blackoutStands: false });
    await settle();
    expect(batchCommitSpy).toHaveBeenCalledTimes(2);
    expect(peekRetractions('u1')).toEqual([]);
    consoleError.mockRestore();
  });

  it('keeps the intent when the server Moment probe cannot prove absence', async () => {
    noTombstonesYet();
    getDocFromServerSpy.mockRejectedValueOnce(new Error('unavailable'));

    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 3 }, { dayIndex: 3 });
    await settle();

    expect(writeBatchSpy).not.toHaveBeenCalled();
    expect(peekRetractions('u1')).toEqual(['bingo:3']);
  });

  it('keeps the intent when one sibling form is found but another probe is unknown', async () => {
    noTombstonesYet();
    getDocFromServerSpy.mockImplementation((ref: { path: string }) => {
      if (ref.path === momentAt('u1-bingo-d3')) {
        return Promise.resolve({
          exists: () => true,
          data: () => ({ kind: 'bingo', uid: 'u1', dayIndex: 3 }),
        });
      }
      if (ref.path === momentAt('u1-bingo')) return Promise.reject(new Error('unavailable'));
      return Promise.resolve({ exists: () => false, data: () => ({}) });
    });

    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 3 }, { dayIndex: 3 });
    await settle();

    expect(writeBatchSpy).not.toHaveBeenCalled();
    expect(peekRetractions('u1')).toEqual(['bingo:3']);
  });

  it('retracts a LEGACY day-less Moment that covers the fallen Day — spending BOTH id forms', async () => {
    // Not hypothetical: the writers' legacy same-day dedupe (#267/#372) means a
    // Day's live Moment can genuinely sit at the pre-per-card `${uid}-bingo` id
    // with a day-stamped payload. Retraction has to reach it — and it must spend
    // the DAY-SCOPED sibling too (Codex round 2 on PR #467): a tombstone at only
    // the legacy id left `${uid}-bingo-d3` freely creatable, so a re-mark on the
    // CURRENT bundle reposted the exact win just retracted. Both tombstones carry
    // the Day: on the legacy form it is provenance for WHICH Day spent the slot.
    noTombstonesYet();
    serverHolding({ [momentAt('u1-bingo')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 } });
    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 3 }, { dayIndex: 3 });
    await settle();

    expect(writeBatchSpy).toHaveBeenCalledTimes(1);
    expect(batchDeleteSpy).toHaveBeenCalledTimes(1);
    expect(batchDeleteSpy.mock.calls[0][0].path).toBe(momentAt('u1-bingo'));
    expect(batchSetSpy).toHaveBeenCalledTimes(2);
    expect(batchSetSpy.mock.calls[0][0].path).toBe(tombstoneAt('u1-bingo'));
    expect(batchSetSpy.mock.calls[1][0].path).toBe(tombstoneAt('u1-bingo-d3'));
    for (const call of batchSetSpy.mock.calls) {
      expect(call[1]).toEqual({
        uid: 'u1',
        kind: 'bingo',
        dayIndex: 3,
        createdAt: expect.any(Number),
      });
    }
  });

  it('retracts a win living at BOTH id forms in ONE batch — two deletes, two tombstones', async () => {
    // Possible when a stale bundle posted the legacy id and a current one the
    // per-card id for the same (Player, Day). Two separate batches would race
    // each other's tombstones (no update path), so both docs ride one commit.
    noTombstonesYet();
    serverHolding({
      [momentAt('u1-bingo-d3')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 },
      [momentAt('u1-bingo')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 },
    });
    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 3 }, { dayIndex: 3 });
    await settle();

    expect(writeBatchSpy).toHaveBeenCalledTimes(1);
    expect(batchDeleteSpy).toHaveBeenCalledTimes(2);
    const deleted = batchDeleteSpy.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(deleted).toEqual([momentAt('u1-bingo-d3'), momentAt('u1-bingo')]);
    expect(batchSetSpy).toHaveBeenCalledTimes(2);
    expect(batchSetSpy.mock.calls[0][0].path).toBe(tombstoneAt('u1-bingo'));
    expect(batchSetSpy.mock.calls[1][0].path).toBe(tombstoneAt('u1-bingo-d3'));
  });

  it('skips a tombstone an EARLIER retraction already minted — no doc-exists update in the batch', async () => {
    // A second retraction of the same kind on ANOTHER Day: the legacy form was
    // already spent (tombstones are permanent, no update path), so re-setting it
    // would deny the whole batch. The probe reads through the normal getDoc path
    // — drain fires only after a server-committed snapshot, so the device is
    // online and the answer is authoritative.
    serverHolding(
      { [momentAt('u1-bingo-d5')]: { kind: 'bingo', uid: 'u1', dayIndex: 5 } },
      new Set([tombstoneAt('u1-bingo')]),
    );
    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 5 }, { dayIndex: 5 });
    await settle();

    expect(writeBatchSpy).toHaveBeenCalledTimes(1);
    expect(batchDeleteSpy.mock.calls[0][0].path).toBe(momentAt('u1-bingo-d5'));
    // Only the not-yet-spent day-scoped form is written; the delete rule's
    // getAfter accepts the PRE-EXISTING legacy tombstone.
    expect(batchSetSpy).toHaveBeenCalledTimes(1);
    expect(batchSetSpy.mock.calls[0][0].path).toBe(tombstoneAt('u1-bingo-d5'));
  });

  it('leaves a LEGACY Moment stamped for a DIFFERENT Day standing — it describes another card', async () => {
    serverHolding({ [momentAt('u1-bingo')]: { kind: 'bingo', uid: 'u1', dayIndex: 6 } });
    fellThenServerSays('u1', { bingo: true, bingoDayIndex: 3 }, { dayIndex: 3 });
    await settle();
    expect(writeBatchSpy).not.toHaveBeenCalled();
  });

  it('a LEGACY (day-less) Event retracts its one card’s Moment unconditionally', async () => {
    // One card for the whole Event, so per-Player IS per-card there: there is no
    // Day to scope to, no day-suffixed id to probe — and no sibling form to
    // spend, so exactly ONE day-less tombstone is written.
    noTombstonesYet();
    serverHolding({ [momentAt('u1-blackout')]: { kind: 'blackout', uid: 'u1' } });
    fellThenServerSays('u1', { blackout: true });
    await settle();

    expect(writeBatchSpy).toHaveBeenCalledTimes(1);
    expect(batchDeleteSpy.mock.calls[0][0].path).toBe(momentAt('u1-blackout'));
    expect(batchSetSpy).toHaveBeenCalledTimes(1);
    expect(batchSetSpy.mock.calls[0][0].path).toBe(tombstoneAt('u1-blackout'));
    expect('dayIndex' in (batchSetSpy.mock.calls[0][1] as object)).toBe(false);
    // No day-scoped probe happened at all — there is no Day.
    const probed = getDocFromServerSpy.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(probed.some((p) => p.includes('u1-blackout-d'))).toBe(false);
  });

  it('is a no-op when nothing fell', async () => {
    serverHolding({ [momentAt('u1-bingo-d3')]: { kind: 'bingo', uid: 'u1', dayIndex: 3 } });
    fellThenServerSays('u1', {});
    await settle();
    expect(writeBatchSpy).not.toHaveBeenCalled();
    expect(getDocFromCacheSpy).not.toHaveBeenCalled();
  });

  it('a re-mark after a retraction posts NOTHING locally — the cached tombstone blocks the optimistic write', async () => {
    // The retract-once twin of the write-once pre-check. The rules deny the create
    // server-side, but latency compensation applies it LOCALLY first, so without
    // this the re-marked win would flash back to the TOP of the Feed until the
    // denial — indefinitely while offline, which IS the farming loop the tombstone
    // exists to close.
    cacheHolding({ [tombstoneAt('u1-bingo-d3')]: { uid: 'u1', kind: 'bingo', dayIndex: 3 } });
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null }, 3);
    await settle();
    expect(setDocSpy).not.toHaveBeenCalled();
    // The cached hit was CONFIRMED against the server before it suppressed
    // anything (see the admin-restore case below).
    expect(getDocSpy).toHaveBeenCalledTimes(1);
    expect(getDocSpy.mock.calls[0][0].path).toBe(tombstoneAt('u1-bingo-d3'));

    // A DIFFERENT Day is a different card and is untouched by that tombstone.
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null }, 6);
    await settle();
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(setDocSpy.mock.calls[0][0].path).toBe(momentAt('u1-bingo-d6'));
  });

  it('an ADMIN-DELETED tombstone stops suppressing — the escape hatch works on the retracting device too', async () => {
    // Nothing subscribes to `momentRetractions`, so the device that wrote the
    // tombstone keeps it in its PERSISTENT cache forever — across reloads. Without
    // the confirmation read, an admin correcting an accidental retraction would be
    // silently undone on exactly the device most likely to re-mark (Codex P2,
    // round 1 on PR #467).
    cacheHolding({ [tombstoneAt('u1-bingo-d3')]: { uid: 'u1', kind: 'bingo', dayIndex: 3 } });
    getDocSpy.mockResolvedValue({ exists: () => false }); // the admin deleted it
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null }, 3);
    await settle();
    expect(getDocSpy).toHaveBeenCalledTimes(1);
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(setDocSpy.mock.calls[0][0].path).toBe(momentAt('u1-bingo-d3'));
  });

  it('costs no extra read on the common path — the confirmation fires only on a cached hit', async () => {
    getDocFromCacheSpy.mockRejectedValue(new Error('unavailable')); // no tombstone
    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null }, 3);
    await settle();
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(getDocSpy).not.toHaveBeenCalled();
  });
});

describe('hasPriorBingoWitness — the durable prior-win witness (PR #99 round 2 finding D)', () => {
  it('reads the player’s OWN bingo Moment doc from the LOCAL cache only', async () => {
    getDocFromCacheSpy.mockResolvedValue({ exists: () => true });
    await expect(hasPriorBingoWitness('u1')).resolves.toBe(true);
    // The witness is the per-Player `${uid}-bingo` doc — the same immutable Moment
    // broadcastBingo writes — so the Moment collection is its own memory.
    expect(getDocFromCacheSpy).toHaveBeenCalledTimes(1);
    expect(getDocFromCacheSpy.mock.calls[0][0].path).toBe(`events/${EVENT_ID}/moments/u1-bingo`);
  });

  it('resolves false when the cached doc does not exist', async () => {
    getDocFromCacheSpy.mockResolvedValue({ exists: () => false });
    await expect(hasPriorBingoWitness('u1')).resolves.toBe(false);
  });

  it('probes the PER-CARD witness ids when given the schedule (#372)', async () => {
    // Per-card bingo means there is no single `${uid}-bingo` doc to read: the
    // witness lives at whichever `${uid}-bingo-d${day}` the Player actually won.
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) =>
      ref.path.endsWith('u1-bingo-d5')
        ? Promise.resolve({ exists: () => true })
        : Promise.reject(new Error('unavailable')),
    );
    await expect(hasPriorBingoWitness('u1', { dayIndexes: [0, 1, 5, 9] })).resolves.toBe(true);
  });

  it('per-card: EXCLUDED (tutorial) Days are never probed, so a warm-up win is not a prior main-game win (#372)', async () => {
    // The day-scoped shape makes the #288 exclusion EXACT rather than
    // inferential: the tutorial win owns its own id, which is simply not read —
    // so none of the first_bingo-singleton fallback the shared id forced is needed.
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) =>
      ref.path.endsWith('u1-bingo-d0')
        ? Promise.resolve({ exists: () => true }) // the embark (tutorial) win
        : Promise.reject(new Error('unavailable')),
    );
    await expect(
      hasPriorBingoWitness('u1', { dayIndexes: [0, 1, 9], excludeDayIndexes: new Set([0, 9]) }),
    ).resolves.toBe(false);
    const probed = getDocFromCacheSpy.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(probed).not.toContain(`events/${EVENT_ID}/moments/u1-bingo-d0`);
    expect(probed).not.toContain(`events/${EVENT_ID}/moments/u1-bingo-d9`);
    expect(probed).toContain(`events/${EVENT_ID}/moments/u1-bingo-d1`);
  });

  it('per-card: the LEGACY day-less witness still counts — pre-#372 winners keep theirs', async () => {
    // Every Player who bingoed before #372 shipped owns a `${uid}-bingo` doc. It
    // is durable proof of a prior win and must keep suppressing a regain.
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) =>
      ref.path.endsWith('u1-bingo')
        ? Promise.resolve({ exists: () => true, data: () => ({ dayIndex: 4 }) })
        : Promise.reject(new Error('unavailable')),
    );
    await expect(hasPriorBingoWitness('u1', { dayIndexes: [0, 1, 4] })).resolves.toBe(true);
  });

  it('resolves false — NEVER rejects — on a cache miss (fresh device / cold cache)', async () => {
    // getDocFromCache rejects when the doc is not in the local cache; the caller
    // (Board) then falls back to the roster check — the narrowed residual the
    // spec documents.
    getDocFromCacheSpy.mockRejectedValue(new Error('unavailable'));
    await expect(hasPriorBingoWitness('u1')).resolves.toBe(false);
  });

  it('a TUTORIAL-Day witness is NOT a prior main-game win when the singleton is unclaimed (Codex P1 on #288)', async () => {
    // The `${uid}-bingo` doc is once-per-Player and a warm-up win writes it too;
    // without the exclusion, everyone who bingoed the embark card would be
    // permanently disqualified from the cruise-wide First to BINGO. The
    // fallback read of the first_bingo singleton finds nothing → clean.
    getDocFromCacheSpy
      .mockResolvedValueOnce({ exists: () => true, data: () => ({ dayIndex: 0 }) })
      .mockResolvedValueOnce({ exists: () => false });
    await expect(hasPriorBingoWitness('u1', { excludeDayIndexes: new Set([0, 9]) })).resolves.toBe(false);
    expect(getDocFromCacheSpy).toHaveBeenCalledTimes(2);
    expect(getDocFromCacheSpy.mock.calls[1][0].path).toBe(`events/${EVENT_ID}/moments/first_bingo`);
  });

  it('a tutorial-stamped witness FALLS BACK to the first_bingo singleton: claimed → still witnessed (round 5)', async () => {
    // The shared `${uid}-bingo` id means a main-game win can never write its
    // own witness after a warm-up win — so a lost-and-regained main-game line
    // must be suppressed by the SINGLETON the earlier ceremony wrote.
    getDocFromCacheSpy
      .mockResolvedValueOnce({ exists: () => true, data: () => ({ dayIndex: 0 }) })
      .mockResolvedValueOnce({ exists: () => true });
    await expect(hasPriorBingoWitness('u1', { excludeDayIndexes: new Set([0]) })).resolves.toBe(true);
  });

  it('a tutorial-stamped witness with the singleton NOT cached resolves clean — the roster gate decides', async () => {
    getDocFromCacheSpy
      .mockResolvedValueOnce({ exists: () => true, data: () => ({ dayIndex: 0 }) })
      .mockRejectedValueOnce(new Error('unavailable'));
    await expect(hasPriorBingoWitness('u1', { excludeDayIndexes: new Set([0]) })).resolves.toBe(false);
  });

  it('a MAIN-GAME-Day witness stays a prior win under the same exclusion set', async () => {
    getDocFromCacheSpy.mockResolvedValue({ exists: () => true, data: () => ({ dayIndex: 3 }) });
    await expect(hasPriorBingoWitness('u1', { excludeDayIndexes: new Set([0, 9]) })).resolves.toBe(true);
  });

  it('a day-LESS witness (pre-#286 data) stays a witness — conservative default', async () => {
    getDocFromCacheSpy.mockResolvedValue({ exists: () => true, data: () => ({}) });
    await expect(hasPriorBingoWitness('u1', { excludeDayIndexes: new Set([0]) })).resolves.toBe(true);
  });
});

describe('the birth-time-witness race (#332): a concurrent drain must not suppress the ceremony', () => {
  const alice = { uid: 'u1', displayName: 'Alice', photoURL: null };
  const at = (id: string) => `events/${EVENT_ID}/moments/${id}`;
  // PATH-aware cache, not call-ordered mocks (#372): a per-card `broadcastBingo`
  // reads TWICE before writing (the legacy same-day dedupe, then writeMomentOnce's
  // pre-check), so ordinal `mockResolvedValueOnce` chains no longer describe the
  // sequence. `setDoc` seeds the cache, which is exactly the race being modelled:
  // the drain's write lands in the local cache mid-witness-read.
  let cached: Set<string>;
  const seedCache = (payload: Record<string, unknown> = { dayIndex: 3 }) => {
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) =>
      cached.has(ref.path)
        ? Promise.resolve({ exists: () => true, data: () => payload })
        : Promise.reject(new Error('unavailable')),
    );
    setDocSpy.mockImplementation((ref: { path: string }) => {
      cached.add(ref.path);
      return Promise.resolve(undefined);
    });
  };

  beforeEach(() => {
    cached = new Set<string>();
    seedCache();
  });

  it('this win’s own mid-read write reads as SELF-evidence: singleton unclaimed → witness-clean', async () => {
    // The drain broadcasts THIS win's per-card bingo while the witness read is
    // in flight: writeMomentOnce's pre-check misses (first win — nothing
    // cached), stamps the current generation against the doc id, and the doc
    // lands in the cache. The witness read then finds it — and must fall
    // through to the singleton (unclaimed here) instead of reading it as a
    // prior win.
    broadcastBingo(alice, 3);
    await settle();
    expect(cached.has(at('u1-bingo-d3'))).toBe(true); // the drain landed
    const generation = pendingActionGeneration('u1');
    await expect(
      hasPriorBingoWitness('u1', { dayIndexes: [3], selfWriteGeneration: generation, selfWriteDayIndex: 3 }),
    ).resolves.toBe(false);
    // The singleton IS consulted — the self-write did not short-circuit to "prior win".
    expect(getDocFromCacheSpy.mock.calls.some((c) => (c[0] as { path: string }).path === at('first_bingo'))).toBe(true);
  });

  it('self-evidence with the singleton already claimed stays witnessed — no duplicate ceremony', async () => {
    broadcastBingo(alice, 3);
    await settle();
    cached.add(at('first_bingo')); // the headline honor is already claimed
    await expect(
      hasPriorBingoWitness('u1', { dayIndexes: [3], selfWriteGeneration: pendingActionGeneration('u1'), selfWriteDayIndex: 3 }),
    ).resolves.toBe(true);
  });

  it('a stamp from ANOTHER action generation is not self-evidence — the doc stays a prior win', async () => {
    broadcastBingo(alice, 3);
    await settle();
    const stale = pendingActionGeneration('u1') + 1; // a generation this stamp does not belong to
    await expect(
      hasPriorBingoWitness('u1', { dayIndexes: [3], selfWriteGeneration: stale, selfWriteDayIndex: 3 }),
    ).resolves.toBe(true);
  });

  it('a REGAIN leaves no stamp — the pre-check skip means the found doc is genuine prior evidence', async () => {
    // The doc predates the action (prior win), so writeMomentOnce's pre-check
    // FINDS it and skips the write without stamping. The witness read that
    // finds the same doc must keep reading it as a prior win even when the
    // caller passes the current generation.
    cached.add(at('u1-bingo-d3'));
    broadcastBingo(alice, 3);
    await settle();
    expect(setDocSpy).not.toHaveBeenCalled(); // the skip is what withholds the stamp
    await expect(
      hasPriorBingoWitness('u1', { dayIndexes: [3], selfWriteGeneration: pendingActionGeneration('u1'), selfWriteDayIndex: 3 }),
    ).resolves.toBe(true);
  });

  it('callers that pass no generation (confirm pipeline) keep the pre-#332 read', async () => {
    broadcastBingo(alice, 3);
    await settle();
    await expect(hasPriorBingoWitness('u1', { dayIndexes: [3] })).resolves.toBe(true);
  });

  it('self-write detection is bound to the ACTED Day — an earlier Day’s win this device wrote is still prior evidence (Codex P2 on #386)', async () => {
    // The scenario the generation alone cannot distinguish: this device writes a
    // Day-3 bingo, the player never loses that line (so NO fall, so the
    // generation never bumps), then completes Day 5. Both writes are stamped at
    // the SAME generation — so a check on generation alone classifies the
    // genuine Day-3 prior win as the Day-5 action's own write, skips it, and
    // wrongly clears the ceremony gate for a player who is not witness-clean.
    // Binding to the acted Day is what makes it precise: only `u1-bingo-d5` can
    // be the Day-5 action's write.
    broadcastBingo(alice, 3); // an EARLIER action, genuinely written + stamped this session
    await settle();
    broadcastBingo(alice, 5); // this action's own drain
    await settle();
    expect(cached.has(at('u1-bingo-d3'))).toBe(true);
    expect(cached.has(at('u1-bingo-d5'))).toBe(true);
    // Same generation for both (no bingo fall between them) — the exact trap.
    await expect(
      hasPriorBingoWitness('u1', {
        dayIndexes: [3, 5],
        selfWriteGeneration: pendingActionGeneration('u1'),
        selfWriteDayIndex: 5,
      }),
    ).resolves.toBe(true); // Day 3 stands as prior evidence
  });

  it('the acted Day’s OWN doc is still excused — self-evidence detection survives the Day binding', async () => {
    // The complement of the above: bind too tightly and #332 comes back. The
    // acted Day's own mid-read write must still read as self-evidence.
    broadcastBingo(alice, 5);
    await settle();
    await expect(
      hasPriorBingoWitness('u1', {
        dayIndexes: [5],
        selfWriteGeneration: pendingActionGeneration('u1'),
        selfWriteDayIndex: 5,
      }),
    ).resolves.toBe(false); // singleton unclaimed → witness-clean, ceremony survives
  });
});

describe('the pending-Moment queue — module state that survives Board unmounts (issue #104)', () => {
  it('enqueues a bingo/blackout win off the mark transition verdict; peek reads it back', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false });
    expect(peekPendingMoments('u1')).toEqual({ bingo: true, blackout: false, firstBingo: false });

    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true });
    expect(peekPendingMoments('u1')).toEqual({ bingo: true, blackout: true, firstBingo: false });
  });

  it('a no-op enqueue (neither transition) leaves the queue untouched — never resurrects a drained flag', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: false });
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });

  it('enqueues the ceremonial First-to-BINGO candidate separately (Board gates it on the witness first)', () => {
    enqueueFirstBingoMoment('u1');
    expect(peekPendingMoments('u1').firstBingo).toBe(true);
  });

  it('is keyed per-uid: a held win for one account never leaks into another', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false });
    expect(peekPendingMoments('u2')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });

  it('SURVIVES across calls — the state lives in module scope, so an unmount cannot lose it', () => {
    // The headline #104 fix: enqueue is one call (a mark in doMark), peek is a
    // LATER call (a drain from a fresh Board mount). Module state bridges them.
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false });
    enqueueFirstBingoMoment('u1');
    // …a Board unmount / remount happens between enqueue and drain in the app; here
    // the two calls are simply separated, and the flags are still queued.
    expect(peekPendingMoments('u1')).toEqual({ bingo: true, blackout: false, firstBingo: true });
  });

  it('persists an echoed sibling win across a reload until its Day drain consumes it', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    try {
      enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: true, dayIndex: 3 });
      __resetPendingMomentsMemoryForTests();

      expect(peekPendingMoments('u1')).toEqual({ bingo: true, blackout: true, firstBingo: false });
      expect(pendingBingoDayIndexes('u1')).toEqual([3]);
      expect(pendingBlackoutDayIndexes('u1')).toEqual([3]);
    } finally {
      resetPendingMoments();
      vi.unstubAllGlobals();
    }
  });

  it('clears one drained kind and drops the entry once empty', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: true });
    clearPendingMoment('u1', 'bingo');
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: true, firstBingo: false });
    clearPendingMoment('u1', 'blackout');
    // Empty now → peek still returns a stable empty triple (the map entry is gone).
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });

  it('resetPendingMoments drops the whole queue (test-support)', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false });
    enqueueWinMoments({ uid: 'u2', bingoTransition: false, blackoutTransition: true });
    resetPendingMoments();
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
    expect(peekPendingMoments('u2')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });
});

describe('pendingBlackoutDayIndexes — the blackout Day(s) captured at ENQUEUE time (#267, per-card)', () => {
  it('is empty when nothing is queued', () => {
    expect(pendingBlackoutDayIndexes('u1')).toEqual([]);
  });

  it('stamps the Day the enqueue carried, so a later drain (after the Player switches Days) still reads it', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 3 });
    expect(pendingBlackoutDayIndexes('u1')).toEqual([3]);
    // The Player switches the viewed Day before the drain fires — the STORED
    // value (from enqueue time) is what a later drain must read, never a
    // re-derivation from whatever is on screen now. Nothing re-enqueues here;
    // this asserts the getter keeps returning the ORIGINAL stamp.
    expect(pendingBlackoutDayIndexes('u1')).toEqual([3]);
  });

  it('omits the Day entirely (empty) for a legacy, non-daily enqueue — never a misleading "Day 1"', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true }); // no dayIndex
    expect(peekPendingMoments('u1').blackout).toBe(true);
    expect(pendingBlackoutDayIndexes('u1')).toEqual([]);
  });

  it('accumulates one entry per distinct Day (#267 — blackout is per-card), deduping re-enqueues of the same Day', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 2 });
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 5 });
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 5 });
    expect(pendingBlackoutDayIndexes('u1')).toEqual([2, 5]);
  });

  it('clearPendingMoment("blackout") (the drain FIRED it) resets the stamp — nothing left to protect', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 4 });
    clearPendingMoment('u1', 'blackout');
    expect(pendingBlackoutDayIndexes('u1')).toEqual([]);
  });

  it('dropPendingWins({ blackout: true }) (a legacy, day-less fall) resets the whole stamp — the fallen blackout no longer applies', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 4 });
    dropPendingWins('u1', { blackout: true });
    expect(pendingBlackoutDayIndexes('u1')).toEqual([]);
  });

  it('a day-scoped fall drops ONLY the witnessed Day — sibling queued blackouts survive (Codex P2 on #275 round 2)', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 2 });
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 5 });
    dropPendingWins('u1', { blackout: true, blackoutDayIndex: 2 });
    expect(pendingBlackoutDayIndexes('u1')).toEqual([5]);
    expect(peekPendingMoments('u1').blackout).toBe(true); // Day 5 still owed
    dropPendingWins('u1', { blackout: true, blackoutDayIndex: 5 });
    expect(pendingBlackoutDayIndexes('u1')).toEqual([]);
    expect(peekPendingMoments('u1').blackout).toBe(false);
  });

  it('is isolated per-uid', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 1 });
    expect(pendingBlackoutDayIndexes('u2')).toEqual([]);
  });

  it('removePendingBlackoutDay drops ONE fired Day, keeping siblings queued and the flag owed (#267, Codex P2 on #275)', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 2 });
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 5 });
    removePendingBlackoutDay('u1', 2);
    expect(pendingBlackoutDayIndexes('u1')).toEqual([5]);
    expect(peekPendingMoments('u1').blackout).toBe(true); // Day 5 still owed
    removePendingBlackoutDay('u1', 5);
    expect(pendingBlackoutDayIndexes('u1')).toEqual([]);
    expect(peekPendingMoments('u1').blackout).toBe(false); // queue empty — nothing owed
  });

  it('removePendingBlackoutDay is a no-op for a Day not in the queue (and for an empty queue)', () => {
    removePendingBlackoutDay('u1', 3);
    expect(peekPendingMoments('u1').blackout).toBe(false);
    enqueueWinMoments({ uid: 'u1', bingoTransition: false, blackoutTransition: true, dayIndex: 4 });
    removePendingBlackoutDay('u1', 9);
    expect(pendingBlackoutDayIndexes('u1')).toEqual([4]);
    expect(peekPendingMoments('u1').blackout).toBe(true);
  });
});

describe('pendingBingoDayIndexes — the bingo Day(s) captured at ENQUEUE time (#262; per-card set #372)', () => {
  it('ACCUMULATES one entry per distinct Day — a second Day queues its own (#372)', () => {
    // Pre-#372 this was first-write-wins ("the FIRST queued bingo's Day"),
    // which matched the once-per-Player `${uid}-bingo` id: a second Day's bingo
    // could never post anyway, so queueing it was pointless. That WAS the bug.
    // Per-card ids mean each Day's win is its own Moment, so each must queue.
    expect(pendingBingoDayIndexes('u1')).toEqual([]);
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 2 });
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 5 });
    expect(pendingBingoDayIndexes('u1')).toEqual([2, 5]);
  });

  it('de-duplicates a repeat enqueue for the SAME Day', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 2 });
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 2 });
    expect(pendingBingoDayIndexes('u1')).toEqual([2]);
  });

  it('empty on a legacy (day-less) enqueue — the flag still owes a day-less broadcast', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false });
    expect(pendingBingoDayIndexes('u1')).toEqual([]);
    expect(peekPendingMoments('u1').bingo).toBe(true);
  });

  it('removePendingBingoDay drops ONE fired Day and leaves siblings owed (#372)', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 2 });
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 5 });
    removePendingBingoDay('u1', 2);
    expect(pendingBingoDayIndexes('u1')).toEqual([5]);
    expect(peekPendingMoments('u1').bingo).toBe(true); // Day 5 still owed
    removePendingBingoDay('u1', 5);
    expect(pendingBingoDayIndexes('u1')).toEqual([]);
    expect(peekPendingMoments('u1').bingo).toBe(false); // queue empty — nothing owed
  });

  it('a day-scoped FALL drops only the fallen Day, leaving a sibling Day still owed (#372)', () => {
    // The regression per-card bingo would otherwise introduce: a Day-2 unmark
    // wiping a still-standing Day-5 bingo out of the queue.
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 2 });
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 5 });
    dropPendingWins('u1', { bingo: true, bingoDayIndex: 2 });
    expect(pendingBingoDayIndexes('u1')).toEqual([5]);
    expect(peekPendingMoments('u1').bingo).toBe(true);
  });

  it('a legacy (day-less) fall still clears the whole bingo queue', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 2 });
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 5 });
    dropPendingWins('u1', { bingo: true });
    expect(pendingBingoDayIndexes('u1')).toEqual([]);
    expect(peekPendingMoments('u1').bingo).toBe(false);
  });

  it('the ceremonial candidate carries ITS OWN Day — the plain-bingo fire cannot strip it (Codex P2 R1 + P3 R2 on #286)', () => {
    // The roster-held path: the plain bingo fires in an EARLIER drain pass than
    // the ceremony, and each kind's Day clears with ITS OWN fire.
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 3 });
    enqueueFirstBingoMoment('u1', 3);
    clearPendingMoment('u1', 'bingo'); // the plain bingo fired; the ceremony holds
    expect(pendingFirstBingoDayIndex('u1')).toBe(3); // the candidate's own stamp survives
    clearPendingMoment('u1', 'firstBingo'); // the ceremony decided
    expect(pendingFirstBingoDayIndex('u1')).toBeUndefined(); // nothing left to protect
  });

  it('R2 P3: the async-witness window — plain bingo fires (entry deleted) BEFORE the candidate enqueues; the ceremony still knows its Day', () => {
    // enqueueWinMoments and enqueueFirstBingoMoment straddle the durable-witness
    // read: a snapshot drain can fire + clear the plain bingo (deleting the
    // whole flags entry) inside that gap. The late candidate stamps its own Day.
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 5 });
    clearPendingMoment('u1', 'bingo'); // fired mid-witness-read; entry deleted
    expect(pendingBingoDayIndexes('u1')).toEqual([]);
    enqueueFirstBingoMoment('u1', 5); // the witness continuation lands after
    expect(pendingFirstBingoDayIndex('u1')).toBe(5);
    expect(peekPendingMoments('u1').firstBingo).toBe(true);
  });

  it('clears with the bingo fire when NO ceremonial candidate is queued', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 3 });
    clearPendingMoment('u1', 'bingo');
    expect(pendingBingoDayIndexes('u1')).toEqual([]);
    // A LATER bingo on a different Day must capture ITS OWN Day, never inherit
    // a stale one.
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 7 });
    expect(pendingBingoDayIndexes('u1')).toEqual([7]);
  });

  it('a bingo FALL drops both Days with the win (dropPendingWins)', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false, dayIndex: 4 });
    enqueueFirstBingoMoment('u1', 4);
    dropPendingWins('u1', { bingo: true });
    expect(pendingBingoDayIndexes('u1')).toEqual([]);
    expect(pendingFirstBingoDayIndex('u1')).toBeUndefined();
  });
});

describe('the action generation + fall-driven drops (Codex P1/P2, PR #110)', () => {
  // The generation is the token Board's witness continuation checks: captured
  // before the async durable-witness read, compared after. It bumps ONLY on an
  // OBSERVED BINGO FALL (round 4 narrowed it): its sole consumers are the
  // ceremonial machinery, and only what changes whether the bingo stands may
  // stale them — a non-falling unmark or a blackout-only fall preserves a
  // legitimate ceremony mid-witness-read.

  it('starts at 0, bumps ONLY on an actual bingo fall — never on a fire-clear, a no-drop unmark, or a blackout-only fall (round 4)', () => {
    expect(pendingActionGeneration('u1')).toBe(0);

    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false });
    clearPendingMoment('u1', 'bingo'); // a drain fired it: the win stood, not a fall
    expect(pendingActionGeneration('u1')).toBe(0); // fires do not invalidate continuations

    // An unmark that dropped NO win (another line still standing) must not stale
    // a ceremony whose bingo stands continuously (the round-4 finding)…
    dropPendingWins('u1', {});
    expect(pendingActionGeneration('u1')).toBe(0);
    // …and a blackout-only fall does not touch whether the BINGO stands either.
    dropPendingWins('u1', { blackout: true });
    expect(pendingActionGeneration('u1')).toBe(0);

    dropPendingWins('u1', { bingo: true }); // an ACTUAL bingo fall
    expect(pendingActionGeneration('u1')).toBe(1);
  });

  it('dropPendingWins clears the fallen kinds — a bingo fall also drops the ceremonial candidate', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: true });
    enqueueFirstBingoMoment('u1');
    dropPendingWins('u1', { bingo: true });
    // The ceremonial candidate cannot outlive the bingo it accompanies.
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: true, firstBingo: false });
    dropPendingWins('u1', { blackout: true });
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });

  it('the generation SURVIVES the flags entry being emptied — a stale continuation cannot false-match a recreated entry', () => {
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false });
    dropPendingWins('u1', { bingo: true }); // empties + deletes the flags entry
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false }); // recreated
    expect(pendingActionGeneration('u1')).toBe(1); // monotonic — not reset by the delete
  });

  it('generations are per-uid; resetPendingMoments clears them (test-support)', () => {
    dropPendingWins('u1', { bingo: true });
    expect(pendingActionGeneration('u1')).toBe(1);
    expect(pendingActionGeneration('u2')).toBe(0); // isolated
    resetPendingMoments();
    expect(pendingActionGeneration('u1')).toBe(0);
  });

  it('a NON-falling drop preserves the candidate as CURRENT; a bingo fall clears it (round 4 corrected round 2 finding 3)', () => {
    enqueueFirstBingoMoment('u1');
    expect(firstBingoCandidateCurrent('u1')).toBe(true);

    // A no-drop unmark and a blackout-only fall leave the candidate BOTH queued
    // and current — the bingo it accompanies still stands, nothing was
    // un-witnessed, and the ceremony must survive (the round-4 finding: the old
    // unconditional bump made exactly this candidate stale).
    dropPendingWins('u1', {});
    dropPendingWins('u1', { blackout: true });
    expect(peekPendingMoments('u1').firstBingo).toBe(true);
    expect(firstBingoCandidateCurrent('u1')).toBe(true);

    // An actual bingo fall clears the candidate outright (and bumps): after it,
    // nothing is queued and nothing is current. Every in-app bump site also
    // clears, so the stamp's stale-kill is belt-and-braces for future bump sites.
    dropPendingWins('u1', { bingo: true });
    expect(peekPendingMoments('u1').firstBingo).toBe(false);
    expect(firstBingoCandidateCurrent('u1')).toBe(false);

    // A fresh re-enqueue at the new generation is current again.
    enqueueFirstBingoMoment('u1');
    expect(firstBingoCandidateCurrent('u1')).toBe(true);
  });

  it('firstBingoCandidateCurrent is false when no candidate is queued', () => {
    expect(firstBingoCandidateCurrent('u1')).toBe(false);
    enqueueWinMoments({ uid: 'u1', bingoTransition: true, blackoutTransition: false });
    expect(firstBingoCandidateCurrent('u1')).toBe(false); // a plain bingo is not a candidate
  });
});

// Minimal docs — only the fields mergeFeed reads (createdAt) plus an id for keying.
const proof = (id: string, createdAt: number): ProofDoc =>
  ({ id, createdAt, uid: `u-${id}`, displayName: id, type: 'text', itemText: 't' } as unknown as ProofDoc);
const moment = (id: string, createdAt: number, kind: MomentKind): MomentDoc => ({
  id,
  kind,
  uid: `u-${id}`,
  displayName: id,
  photoURL: null,
  createdAt,
});
const notice = (id: string, createdAt: number, pinned: boolean): NoticeDoc => ({
  id,
  title: id,
  body: `${id} body`,
  uid: `u-${id}`,
  displayName: id,
  createdAt,
  pinned,
});

describe('mergeFeed — Proofs + Moments into one newest-first stream (specs/w2-feed-moments.md)', () => {
  it('interleaves Proofs and Moments strictly newest-first', () => {
    const merged = mergeFeed(
      [proof('a', 2000), proof('b', 500)],
      [moment('c', 3000, 'bingo'), moment('d', 1000, 'first_bingo')],
    );
    expect(merged.map((e) => e.createdAt)).toEqual([3000, 2000, 1000, 500]);
    expect(merged.map((e) => e.feedKind)).toEqual(['moment', 'proof', 'moment', 'proof']);
    expect(merged[0]).toMatchObject({ feedKind: 'moment', moment: { id: 'c' } });
    expect(merged[1]).toMatchObject({ feedKind: 'proof', proof: { id: 'a' } });
  });

  it('keeps the slice cap so the Feed stays light on ship wifi', () => {
    const many = Array.from({ length: 80 }, (_, i) => proof(`p${i}`, i));
    const merged = mergeFeed(many, [], [], [], 60);
    expect(merged).toHaveLength(60);
    expect(merged[0].createdAt).toBe(79); // the newest survives the cap
  });

  it('preserves the legacy fourth-argument cap call shape', () => {
    const many = Array.from({ length: 4 }, (_, i) => proof(`p${i}`, i));
    expect(mergeFeed(many, [], [], 2).map((e) => e.createdAt)).toEqual([3, 2]);
  });

  it('a bare Mark (neither a Proof nor a Moment) yields no Feed entry (ADR 0002)', () => {
    expect(mergeFeed([], [])).toEqual([]);
  });

  // Notices (specs/admin-messages.md) — pinned masthead, unpinned interleave, cap,
  // and the empty-notices regression guard.
  it('a pinned Notice sorts above newer Proofs and Moments regardless of time', () => {
    const merged = mergeFeed(
      [proof('a', 5000)],
      [moment('c', 6000, 'bingo')],
      [],
      [notice('pin', 1000, true)], // OLD but pinned
    );
    expect(merged[0]).toMatchObject({ feedKind: 'notice', notice: { id: 'pin' } });
    expect(merged.map((e) => e.feedKind)).toEqual(['notice', 'moment', 'proof']);
  });

  it('multiple pinned Notices lead the Feed newest-pinned-first', () => {
    const merged = mergeFeed(
      [proof('a', 4000)],
      [],
      [],
      [notice('old-pin', 1000, true), notice('new-pin', 2000, true)],
    );
    expect(merged.slice(0, 2).map((e) => (e.feedKind === 'notice' ? e.notice.id : e.feedKind))).toEqual([
      'new-pin',
      'old-pin',
    ]);
    expect(merged[2]).toMatchObject({ feedKind: 'proof', proof: { id: 'a' } });
  });

  it('caps the pinned Notice masthead without evicting the normal stream', () => {
    const pinnedNotices = Array.from({ length: 8 }, (_, i) => notice(`pin-${i}`, 1000 + i, true));
    const merged = mergeFeed(
      [proof('proof', 9000)],
      [moment('moment', 8000, 'bingo')],
      [],
      pinnedNotices,
      6,
    );
    expect(merged).toHaveLength(6);
    expect(merged.slice(0, 5).map((e) => (e.feedKind === 'notice' ? e.notice.id : e.feedKind))).toEqual([
      'pin-7',
      'pin-6',
      'pin-5',
      'pin-4',
      'pin-3',
    ]);
    expect(merged[5]).toMatchObject({ feedKind: 'proof', proof: { id: 'proof' } });
  });

  it('an unpinned Notice interleaves by createdAt in the newest-first stream', () => {
    const merged = mergeFeed(
      [proof('a', 3000), proof('b', 1000)],
      [moment('c', 500, 'bingo')],
      [],
      [notice('mid', 2000, false)], // unpinned — falls into place by time
    );
    expect(merged.map((e) => e.createdAt)).toEqual([3000, 2000, 1000, 500]);
    expect(merged.map((e) => e.feedKind)).toEqual(['proof', 'notice', 'proof', 'moment']);
  });

  it('an empty notices stream leaves the merge byte-identical to the pre-Notice output', () => {
    const proofs = [proof('a', 3000), proof('b', 1000)];
    const moments = [moment('c', 2000, 'bingo')];
    // The pre-Notice three-arg call and the new four-arg call with [] notices must
    // produce deep-equal output — the regression guard for a Notice-free Feed.
    expect(mergeFeed(proofs, moments, [], [])).toEqual(mergeFeed(proofs, moments, []));
  });
});

describe('hasCanonicalMomentId — read-side singleton/per-player Moment filter', () => {
  it('accepts only the deterministic ids the writer uses for each Moment kind', () => {
    expect(hasCanonicalMomentId({ ...moment('u1-bingo', 1, 'bingo'), uid: 'u1' })).toBe(true);
    expect(hasCanonicalMomentId({ ...moment('u1-blackout', 1, 'blackout'), uid: 'u1' })).toBe(true);
    expect(hasCanonicalMomentId({ ...moment('first_bingo', 1, 'first_bingo'), uid: 'u1' })).toBe(true);

    // Per-card blackout ids (#267): day-stamped, and the id's Day must match
    // the doc's own dayIndex — a forged mismatch (or a day-suffixed id with no
    // dayIndex field) is dropped.
    expect(hasCanonicalMomentId({ ...moment('u1-blackout-d4', 1, 'blackout'), uid: 'u1', dayIndex: 4 })).toBe(true);
    expect(hasCanonicalMomentId({ ...moment('u1-blackout-d4', 1, 'blackout'), uid: 'u1', dayIndex: 5 })).toBe(false);
    expect(hasCanonicalMomentId({ ...moment('u1-blackout-d4', 1, 'blackout'), uid: 'u1' })).toBe(false);
    expect(hasCanonicalMomentId({ ...moment('u2-blackout-d4', 1, 'blackout'), uid: 'u1', dayIndex: 4 })).toBe(false);

    // Per-card bingo ids (#372) — the same contract, now that bingo shares the
    // day-scoped form. Without this the writer's new ids would be filtered out
    // of every Feed on the read side, so the fix would post and never render.
    expect(hasCanonicalMomentId({ ...moment('u1-bingo-d4', 1, 'bingo'), uid: 'u1', dayIndex: 4 })).toBe(true);
    expect(hasCanonicalMomentId({ ...moment('u1-bingo-d4', 1, 'bingo'), uid: 'u1', dayIndex: 5 })).toBe(false);
    expect(hasCanonicalMomentId({ ...moment('u1-bingo-d4', 1, 'bingo'), uid: 'u1' })).toBe(false);
    expect(hasCanonicalMomentId({ ...moment('u2-bingo-d4', 1, 'bingo'), uid: 'u1', dayIndex: 4 })).toBe(false);
    // first_bingo is NOT day-scopable — the event singleton renders only from
    // the literal id, mirroring the create rule.
    expect(hasCanonicalMomentId({ ...moment('first_bingo-d4', 1, 'first_bingo'), uid: 'u1', dayIndex: 4 })).toBe(false);

    expect(hasCanonicalMomentId({ ...moment('spoof-first', 1, 'first_bingo'), uid: 'u1' })).toBe(false);
    expect(hasCanonicalMomentId({ ...moment('u1-first_bingo', 1, 'first_bingo'), uid: 'u1' })).toBe(false);
    expect(hasCanonicalMomentId({ ...moment('spoof-bingo', 1, 'bingo'), uid: 'u1' })).toBe(false);
    expect(hasCanonicalMomentId({ ...moment('u2-bingo', 1, 'bingo'), uid: 'u1' })).toBe(false);
    expect(hasCanonicalMomentId({ ...moment('u1-streak', 1, 'bingo'), kind: 'streak' as MomentKind, uid: 'u1' })).toBe(false);
  });
});
