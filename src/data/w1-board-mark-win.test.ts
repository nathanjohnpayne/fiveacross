import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cell } from '../types';

// w1-board-mark-win, unit layer. Three concerns, no Firestore and no emulator:
//   1. computeMark — the pure fold of one Mark toggle into the next Board cells
//      + denormalized Player stats (win detection). Deterministic via injected
//      `now`.
//   2. setMark's write SHAPE — captured through batch spies so we can prove the
//      write set is exactly {board, player} and NOTHING else (no Feed doc, ADR
//      0002) and that it is a plain batch, never a `runTransaction`
//      (offline-queueable, ADR 0006). The durable-across-reload proof is the
//      emulator sibling `tests/offline/w1-board-mark-win.test.ts`.
//   3. setMark's cache-precedence wiring — a caller's `cells` prop can be
//      stale relative to a Mark that already landed in the persistent local
//      cache (two fast taps before the caller's onSnapshot listener has
//      re-rendered it). setMark must fold onto that cache, not the stale
//      prop, or a later write's full-array replacement silently clobbers the
//      earlier Mark. The end-to-end proof against a real emulator + real
//      persistent cache is the same emulator sibling file.

const EVENT_ID = 'med-2026'; // src/firebase.ts default when VITE_EVENT_ID is unset

// A stand-in for the DocumentSnapshot shape setMark actually reads (`exists()`
// + `data()`); typed explicitly so `getDocFromCacheSpy.mockResolvedValueOnce`
// accepts a fake snapshot literal instead of inferring `never` from the
// default rejection below.
type FakeSnap = { exists: () => boolean; data: () => unknown };

const { setSpy, commitSpy, getDocFromCacheSpy, trackSpy } = vi.hoisted(() => ({
  setSpy: vi.fn(),
  commitSpy: vi.fn(() => Promise.resolve()),
  // Rejects by default (nothing cached), matching a fresh test double with no
  // real persistent cache; individual tests override with mockResolvedValueOnce
  // to prove the write folds onto a cached Board instead of a stale `cells` arg.
  getDocFromCacheSpy: vi.fn((): Promise<FakeSnap> => Promise.reject(new Error('no cache in this test double'))),
  // Captures the #387 mark_rejected observability event setMark fires (via a
  // dynamic import of ../analytics) when a commit is rejected online.
  trackSpy: vi.fn(),
}));

// Keep the module graph loadable but the write path inspectable: real
// firebase/firestore except `doc` (→ a bare { path }), `writeBatch` (→ our
// spies), `getDocFromCache` (→ our spy), and the write fns we assert are NEVER
// called.
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026' }));
// The #387 rejection handler dynamically imports ../analytics (whose real
// module drags in the firebase singleton + PostHog); stub it to the spy.
vi.mock('../analytics', () => ({ track: trackSpy }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
    writeBatch: () => ({ set: setSpy, commit: commitSpy }),
    getDocFromCache: getDocFromCacheSpy,
    addDoc: vi.fn(),
    runTransaction: vi.fn(),
  };
});

import { computeMark, setMark } from './api';
import { knownFirstBingoAt } from '../components/Board';
import { addDoc, FieldPath, runTransaction } from 'firebase/firestore';

// A dealt board: every non-free Square unmarked, the free center (12) "on".
function dealt(): Cell[] {
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `i${index}`,
    text: index === 12 ? 'FREE' : `p${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
}

// A dealt board with `indices` already marked-confirmed.
function withMarked(indices: number[]): Cell[] {
  const cells = dealt();
  for (const i of indices) cells[i] = { ...cells[i], marked: true, markedAt: 1, status: 'confirmed' };
  return cells;
}

describe('computeMark (win detection + stats)', () => {
  it('marks the target Square confirmed and counts it', () => {
    const r = computeMark({
      cells: dealt(),
      index: 0,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      now: 1000,
    });
    expect(r.cells[0]).toMatchObject({ marked: true, markedAt: 1000, status: 'confirmed' });
    expect(r.player).toEqual({ squaresMarked: 1, bingoCount: 0, firstBingoAt: null, blackout: false });
    expect(r.bingo).toBe(false);
  });

  it('completing a line is a BINGO and stamps firstBingoAt with now', () => {
    const r = computeMark({
      cells: withMarked([0, 1, 2, 3]), // top row minus the last Square
      index: 4,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      now: 2000,
    });
    expect(r.bingo).toBe(true);
    expect(r.player.bingoCount).toBe(1);
    expect(r.player.squaresMarked).toBe(5);
    expect(r.player.firstBingoAt).toBe(2000);
  });

  it('preserves an existing firstBingoAt while a BINGO still stands', () => {
    const r = computeMark({
      cells: withMarked([0, 1, 2, 3, 4]), // a standing top-row BINGO
      index: 5,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: 111,
      now: 3000,
    });
    expect(r.bingo).toBe(true);
    expect(r.player.firstBingoAt).toBe(111); // not re-stamped to now
  });

  it('unmarking away the last BINGO clears firstBingoAt', () => {
    const r = computeMark({
      cells: withMarked([0, 1, 2, 3, 4]),
      index: 4,
      nextMarked: false,
      claimMode: 'honor',
      currentFirstBingoAt: 111,
      now: 4000,
    });
    expect(r.cells[4]).toMatchObject({ marked: false, markedAt: null });
    expect(r.player.bingoCount).toBe(0);
    expect(r.player.firstBingoAt).toBeNull();
  });

  it('stamps firstBingoAt when UNKNOWN prior state transitions from no bingo to bingo', () => {
    const r = computeMark({
      cells: withMarked([0, 1, 2, 3]),
      index: 4, // completes the top row
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: undefined,
      now: 2000,
    });
    expect(r.bingo).toBe(true);
    expect(r.player.bingoCount).toBe(1);
    expect(r.player.squaresMarked).toBe(5);
    expect(r.player.firstBingoAt).toBe(2000);
  });

  it('OMITS firstBingoAt when the caller value is UNKNOWN and a bingo already stood', () => {
    // undefined = the player row has not loaded and nothing is cached. Even on a
    // further mark while a bingo stands, firstBingoAt must be left off the
    // payload so the { merge:true } write preserves whatever earlier stamp the
    // server holds, instead of clobbering it with `now` (Codex P2, PR #75). A
    // no-bingo -> bingo transition still stamps in the previous test.
    const r = computeMark({
      cells: withMarked([0, 1, 2, 3, 4]), // top row already complete
      index: 6,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: undefined,
      now: 2000,
    });
    expect(r.bingo).toBe(true);
    expect(r.player.bingoCount).toBe(1);
    expect(r.player.squaresMarked).toBe(6); // non-dependent stats are still written
    expect('firstBingoAt' in r.player).toBe(false); // omitted, not null
  });

  it('knownFirstBingoAt treats a settled-but-unconfirmed absent row as UNKNOWN', () => {
    // Offline reload: the board doc is cached but the player row is not, so
    // useMyPlayer SETTLES (loading=false) with data=null from a cache-only
    // snapshot that merely means "not cached", not "does not exist". Passing
    // that null through as a known none would let a bingo re-stamp
    // firstBingoAt over the server's earlier value (Codex P2, PR #75 round 4).
    expect(knownFirstBingoAt(null, false, false)).toBeUndefined(); // the round-4 case
    expect(knownFirstBingoAt(null, true, false)).toBeUndefined(); // still loading
    expect(knownFirstBingoAt(null, false, true)).toBeNull(); // server-confirmed absent = known none
    expect(knownFirstBingoAt({ firstBingoAt: 111 }, false, false)).toBe(111); // a cached row is real knowledge
    expect(knownFirstBingoAt({ firstBingoAt: null }, false, true)).toBeNull(); // loaded known none
  });

  it('CLEARS firstBingoAt even when the prior value is UNKNOWN, once no bingo stands', () => {
    // Clearing is prior-independent: no bingo in the new state means
    // firstBingoAt must be null regardless of what the server held. Omitting
    // here (the round-2 behavior) left a stale server stamp crediting a
    // non-winner (Codex P2, PR #75 round 3).
    const r = computeMark({
      cells: withMarked([0, 1, 2, 3, 4]), // a standing top-row BINGO
      index: 4,
      nextMarked: false, // unmark removes the last bingo
      claimMode: 'honor',
      currentFirstBingoAt: undefined, // player row still loading, nothing cached
      now: 3000,
    });
    expect(r.bingo).toBe(false);
    expect(r.player.bingoCount).toBe(0);
    expect(r.player.firstBingoAt).toBeNull(); // written as an explicit clear
  });

  it('admin_confirmed marks start pending, so they do not yet count', () => {
    const r = computeMark({
      cells: dealt(),
      index: 0,
      nextMarked: true,
      claimMode: 'admin_confirmed',
      currentFirstBingoAt: null,
      now: 5000,
    });
    expect(r.cells[0].status).toBe('pending');
    expect(r.player.squaresMarked).toBe(0); // pending is excluded from the mask
    expect(r.bingo).toBe(false);
  });

  it('marking the final Square is a Blackout', () => {
    const all = Array.from({ length: 25 }, (_, i) => i).filter((i) => i !== 12 && i !== 0);
    const r = computeMark({
      cells: withMarked(all), // everything but the free center and Square 0
      index: 0,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: 111,
      now: 6000,
    });
    expect(r.blackout).toBe(true);
    expect(r.player.blackout).toBe(true);
  });

  // The win TRANSITION verdict (issue #104): the synchronous edge doMark broadcasts
  // the Feed Moment off — the mark that COMPLETED the win, distinguished from a mark
  // made while a win already stood. `bingo`/`blackout` are the STANDING state;
  // `bingoTransition`/`blackoutTransition` are the rising EDGE.
  it('reports a bingo TRANSITION on the mark that completes the first line, not a further mark', () => {
    const first = computeMark({
      cells: withMarked([0, 1, 2, 3]), // one square shy of the top row
      index: 4, // completes it → the transition into having a bingo
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      now: 1000,
    });
    expect(first.bingo).toBe(true);
    expect(first.bingoTransition).toBe(true); // no-bingo → bingo

    const further = computeMark({
      cells: withMarked([0, 1, 2, 3, 4]), // the line already stands
      index: 5, // a further mark while the bingo holds
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: 111,
      now: 2000,
    });
    expect(further.bingo).toBe(true); // still standing…
    expect(further.bingoTransition).toBe(false); // …but NOT a fresh edge
  });

  it('reports a blackout TRANSITION only on the mark that fills the card', () => {
    const allButOne = Array.from({ length: 25 }, (_, i) => i).filter((i) => i !== 12 && i !== 0);
    const fill = computeMark({
      cells: withMarked(allButOne), // everything but Square 0 (and the free centre)
      index: 0, // the final square → the blackout edge
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: 111,
      now: 6000,
    });
    expect(fill.blackout).toBe(true);
    expect(fill.blackoutTransition).toBe(true);
    // The same fill does not re-report a BINGO edge — a line already stood before it.
    expect(fill.bingoTransition).toBe(false);
  });

  it('an unmark reports NEITHER transition (a mark can only reduce the mask on unmark)', () => {
    const r = computeMark({
      cells: withMarked([0, 1, 2, 3, 4]), // a standing top-row BINGO
      index: 4,
      nextMarked: false, // unmark removes the last line
      claimMode: 'honor',
      currentFirstBingoAt: 111,
      now: 7000,
    });
    expect(r.bingo).toBe(false);
    expect(r.bingoTransition).toBe(false);
    expect(r.blackoutTransition).toBe(false);
  });

  it('an admin_confirmed mark that goes pending crosses no transition (pending does not count)', () => {
    const r = computeMark({
      cells: withMarked([0, 1, 2, 3]), // one square shy of the top row
      index: 4, // would complete it, but admin_confirmed makes it pending
      nextMarked: true,
      claimMode: 'admin_confirmed',
      currentFirstBingoAt: null,
      now: 8000,
    });
    expect(r.cells[4].status).toBe('pending');
    expect(r.bingo).toBe(false); // pending is excluded from the mask, so no line
    expect(r.bingoTransition).toBe(false); // → the confirm-path emission is #41's (deferred)
  });
});

describe('setMark (write shape)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the board + player + Tally-marker docs in one batch — no Feed doc, no transaction', async () => {
    const res = await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 3,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      boardSeed: 42,
    });

    // Three writes now: the board, then the player, then the per-Prompt Tally
    // marker that #31 (specs/w2-tally.md) added to this same batch — the board
    // and player stay partial merges; the marker is a full set at
    // tally/{itemId}/markers/{uid}. Deep marker assertions live in
    // src/data/w2-tally.test.ts; here we only pin that the Tally write rides the
    // SAME offline-queueable batch and is NOT a Feed post.
    expect(setSpy).toHaveBeenCalledTimes(3);
    expect(setSpy.mock.calls[0][0].path).toBe(`events/${EVENT_ID}/boards/u1`);
    expect(setSpy.mock.calls[1][0].path).toBe(`events/${EVENT_ID}/players/u1`);
    expect(setSpy.mock.calls[2][0].path).toBe(`events/${EVENT_ID}/tally/i3/markers/u1`);
    // The board write's mask (#458 round 8): one FieldPath per changed cell
    // (replace-wholesale, so omission-removed fields die) + the extras.
    const boardOpts = setSpy.mock.calls[0][2] as { mergeFields: Array<{ isEqual?: (o: unknown) => boolean }> };
    expect(boardOpts.mergeFields).toHaveLength(2);
    expect(boardOpts.mergeFields[0].isEqual!(new FieldPath('cells', '3'))).toBe(true);
    expect(boardOpts.mergeFields[1]).toBe('markSeed');
    expect(setSpy.mock.calls[1][2]).toEqual({ merge: true });
    expect(setSpy.mock.calls[0][1]).toMatchObject({ markSeed: 42 });
    expect((setSpy.mock.calls[0][1].cells as Cell[])[3].marked).toBe(true);
    expect(setSpy.mock.calls[1][1]).toMatchObject({
      squaresMarked: 1,
      bingoCount: 0,
      firstBingoAt: null,
      blackout: false,
    });
    // The marker carries the attributed shape { uid, displayName, markedAt } and
    // no merge flag (a full set of exactly that doc).
    expect(setSpy.mock.calls[2][1]).toMatchObject({ uid: 'u1', displayName: expect.any(String) });
    expect(typeof setSpy.mock.calls[2][1].markedAt).toBe('number');
    expect(setSpy.mock.calls[2][2]).toBeUndefined();

    // ADR 0002: a bare Mark posts nothing to the Feed (no addDoc to moments/proofs);
    // the Tally marker is a separate surface, not a Feed post.
    expect(addDoc).not.toHaveBeenCalled();
    // ADR 0006: offline-queueable — a batch, never a transaction.
    expect(runTransaction).not.toHaveBeenCalled();
    // Fire-and-forget commit; the win result comes back from the local compute.
    expect(commitSpy).toHaveBeenCalledTimes(1);
    // The return now also carries the win TRANSITION verdict doMark broadcasts the
    // Feed Moment off (issue #104): a bare non-winning Mark crosses neither edge.
    expect(res).toEqual({
      cells: expect.any(Array),
      bingo: false,
      blackout: false,
      bingoTransition: false,
      blackoutTransition: false,
    });
  });
});

describe('setMark (folds onto the freshest cached Board, not a stale cells prop)', () => {
  // Two Marks issued in quick succession (two fast taps, or another of the
  // owner's own tabs) fire before the live listener has re-rendered the
  // caller with the first Mark, so a caller-supplied `cells` prop can be
  // stale relative to a Mark that ALREADY landed in the shared persistent
  // cache. setMark must fold onto that cache, not the stale prop, or the
  // second write's full-array replacement silently clobbers the first Mark.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a cached Board with a newer Mark wins over the caller-supplied stale cells', async () => {
    const cachedCells = dealt();
    cachedCells[5] = { ...cachedCells[5], marked: true, markedAt: 500, status: 'confirmed' };
    getDocFromCacheSpy.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ cells: cachedCells, seed: 99 }),
    });

    await setMark({
      uid: 'u1',
      cells: dealt(), // stale: this caller does not know about index 5 yet
      index: 6,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      boardSeed: 42,
    });

    const boardWrite = setSpy.mock.calls[0][1] as { cells: Record<string, Cell>; markSeed?: number };
    expect(boardWrite.markSeed).toBe(99);
    // #457 per-cell merge: the write PATCHES only this Mark's cell — the
    // cached cell 5 survives by never being written at all, which is the
    // structural form of the no-clobber guarantee this test pins.
    expect(boardWrite.cells['6'].marked).toBe(true); // this Mark
    expect('5' in boardWrite.cells).toBe(false); // untouched → never clobbered
    const playerWrite = setSpy.mock.calls[1][1] as { squaresMarked: number };
    expect(playerWrite.squaresMarked).toBe(2); // both count, not just this call's
  });

  // Overlap, not just staleness: Board.toggle fires doMark without awaiting,
  // so two Marks can BOTH pass getDocFromCache before either has issued its
  // batch — the cache fold alone cannot help if neither write has applied
  // yet. setMark serializes per board (Codex P1, PR #75); this test's fake
  // cache returns whatever the LAST board batch.set wrote (the latency-
  // compensation contract), so an unserialized setMark makes both reads see
  // the pristine board and the final write carries only one Mark.
  it('two unawaited overlapping Marks both land — the second folds onto the first (serialization)', async () => {
    getDocFromCacheSpy.mockImplementation((ref?: unknown) => {
      const path = (ref as { path?: string })?.path ?? '';
      if (path.endsWith('/boards/u1')) {
        const boardWrites = setSpy.mock.calls.filter((c) =>
          (c[0] as { path: string }).path.endsWith('/boards/u1'),
        );
        if (boardWrites.length === 0) return Promise.reject(new Error('not cached'));
        // Latency compensation under the #457 map schema: the cache holds the
        // MERGED doc — the dealt board with every patch written so far merged
        // in, exactly what Firestore's local mutation queue would show.
        const merged = new Map(dealt().map((c) => [String(c.index), c] as const));
        for (const write of boardWrites) {
          const patch = (write[1] as { cells: Record<string, Cell> }).cells;
          for (const [key, value] of Object.entries(patch)) merged.set(key, value);
        }
        return Promise.resolve({
          exists: () => true,
          data: () => ({ cells: Object.fromEntries(merged) }),
        });
      }
      return Promise.reject(new Error('not cached'));
    });

    const common = {
      uid: 'u1',
      cells: dealt(),
      nextMarked: true,
      claimMode: 'honor' as const,
      currentFirstBingoAt: null,
    };
    await Promise.all([setMark({ ...common, index: 3 }), setMark({ ...common, index: 7 })]);

    const boardWrites = setSpy.mock.calls.filter((c) =>
      (c[0] as { path: string }).path.endsWith('/boards/u1'),
    );
    expect(boardWrites).toHaveLength(2);
    // #457 per-cell merge: each write patches ONLY its own cell; the first
    // Mark survives the second write structurally (it is not in its patch).
    expect((boardWrites[0][1] as { cells: Record<string, Cell> }).cells['3'].marked).toBe(true);
    const finalBoard = boardWrites[1][1] as { cells: Record<string, Cell> };
    expect(finalBoard.cells['7'].marked).toBe(true);
    expect('3' in finalBoard.cells).toBe(false); // untouched → never clobbered
    const playerWrites = setSpy.mock.calls.filter((c) =>
      (c[0] as { path: string }).path.endsWith('/players/u1'),
    );
    expect((playerWrites[playerWrites.length - 1][1] as { squaresMarked: number }).squaresMarked).toBe(2);
  });

  it('falls back to the caller-supplied cells when nothing is cached yet', async () => {
    getDocFromCacheSpy.mockRejectedValueOnce(new Error('not cached'));

    await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 4,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
    });

    const boardWrite = setSpy.mock.calls[0][1] as { cells: Cell[] };
    expect(boardWrite.cells[4].marked).toBe(true);
  });

  it('falls back to the caller-supplied cells when the cache has no Board doc yet', async () => {
    getDocFromCacheSpy.mockResolvedValueOnce({ exists: () => false, data: () => undefined });

    await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 8,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
    });

    const boardWrite = setSpy.mock.calls[0][1] as { cells: Cell[] };
    expect(boardWrite.cells[8].marked).toBe(true);
  });

  it('a cached Player firstBingoAt wins over a stale (null) currentFirstBingoAt prop', async () => {
    // A standing top-row BINGO already landed in the cache (from a Mark that
    // stamped firstBingoAt=777), but the caller's own `currentFirstBingoAt`
    // prop is still null -- its onSnapshot listener has not echoed that write
    // back yet. Marking another Square that does not break the standing line
    // must preserve 777, not re-stamp `now`, mirroring the cells fix above.
    getDocFromCacheSpy.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ cells: withMarked([0, 1, 2, 3, 4]) }),
    });
    getDocFromCacheSpy.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ firstBingoAt: 777 }),
    });

    await setMark({
      uid: 'u1',
      cells: dealt(), // stale: does not know about the standing bingo
      index: 6,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null, // stale: does not know firstBingoAt was stamped
    });

    const playerWrite = setSpy.mock.calls[1][1] as { firstBingoAt: number | null };
    expect(playerWrite.firstBingoAt).toBe(777); // preserved from the cache, not re-stamped
  });
});

describe('setMark (preserves firstBingoAt across a player-doc cache miss)', () => {
  // The board can be cached while the player doc is NOT (a fresh reload, before
  // useMyPlayer returns its first snapshot). In that window Board.tsx passes
  // `currentFirstBingoAt: undefined` (UNKNOWN). If setMark treated undefined as
  // a real "no first bingo yet" and the cached board already carried a bingo, a
  // fresh Mark would re-stamp firstBingoAt with `now` and clobber the true
  // earlier server value. The fix: on a player cache MISS + UNKNOWN caller,
  // OMIT firstBingoAt so the merge leaves the server value alone; a KNOWN null
  // (loaded live player) still stamps; a cached value always wins (Codex P2).
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A cache with the board present but the player doc absent.
  function cacheBoardOnly(cells: Cell[]) {
    getDocFromCacheSpy.mockReset();
    getDocFromCacheSpy.mockImplementation((ref?: unknown) => {
      const path = (ref as { path?: string })?.path ?? '';
      if (path.endsWith('/boards/u1')) {
        return Promise.resolve({ exists: () => true, data: () => ({ cells }) });
      }
      return Promise.reject(new Error('player not cached')); // player cache MISS
    });
  }

  it('cache-miss + UNKNOWN caller: omits firstBingoAt on a re-completed bingo (server stamp survives)', async () => {
    cacheBoardOnly(withMarked([0, 1, 2, 3, 4])); // cached board already has a standing bingo

    await setMark({
      uid: 'u1',
      cells: dealt(), // stale prop
      index: 6, // another square while the top-row bingo still stands
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: undefined, // UNKNOWN: player row still loading
    });

    const playerWrite = setSpy.mock.calls[1][1] as { firstBingoAt?: number | null; bingoCount: number };
    expect(playerWrite.bingoCount).toBe(1);
    expect('firstBingoAt' in playerWrite).toBe(false); // omitted → merge preserves the server value
  });

  it('cache-miss + UNKNOWN caller: stamps firstBingoAt on a fresh no-bingo -> bingo transition', async () => {
    cacheBoardOnly(withMarked([0, 1, 2, 3])); // one square shy of the top row

    await setMark({
      uid: 'u1',
      cells: withMarked([0, 1, 2, 3]),
      index: 4, // completes the top row
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: undefined, // UNKNOWN: player row still loading
    });

    const playerWrite = setSpy.mock.calls[1][1] as { firstBingoAt?: number | null; bingoCount: number };
    expect(playerWrite.bingoCount).toBe(1);
    expect(typeof playerWrite.firstBingoAt).toBe('number');
  });

  it('cache-miss + loaded-null caller: stamps firstBingoAt on a fresh bingo (KNOWN "none")', async () => {
    cacheBoardOnly(withMarked([0, 1, 2, 3])); // one square shy of the top row

    await setMark({
      uid: 'u1',
      cells: withMarked([0, 1, 2, 3]),
      index: 4, // completes the top row → first bingo
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null, // KNOWN: player loaded, no prior bingo
    });

    const playerWrite = setSpy.mock.calls[1][1] as { firstBingoAt?: number | null; bingoCount: number };
    expect(playerWrite.bingoCount).toBe(1);
    expect(typeof playerWrite.firstBingoAt).toBe('number'); // stamped with now
  });

  it('a cached player value wins even when the caller is UNKNOWN (undefined)', async () => {
    getDocFromCacheSpy.mockReset();
    getDocFromCacheSpy.mockImplementation((ref?: unknown) => {
      const path = (ref as { path?: string })?.path ?? '';
      if (path.endsWith('/boards/u1')) {
        return Promise.resolve({ exists: () => true, data: () => ({ cells: withMarked([0, 1, 2, 3, 4]) }) });
      }
      if (path.endsWith('/players/u1')) {
        return Promise.resolve({ exists: () => true, data: () => ({ firstBingoAt: 555 }) });
      }
      return Promise.reject(new Error('not cached'));
    });

    await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 6,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: undefined, // UNKNOWN, but the cache holds a real value
    });

    const playerWrite = setSpy.mock.calls[1][1] as { firstBingoAt?: number | null };
    expect(playerWrite.firstBingoAt).toBe(555); // cache wins over the UNKNOWN caller
  });
});

describe('setMark (surfaces a genuine commit failure instead of swallowing it)', () => {
  // Offline, commit() PENDS (never resolves/rejects in this tab), so a rejection
  // is always a real ONLINE failure (permission-denied after an auth change, a
  // malformed update). It must not be silently discarded. setMark logs it via
  // console.error with the Mark context; Firestore's latency compensation rolls
  // the optimistic write back and the live listener un-marks the UI, so the
  // returned optimistic result is deliberately left unchanged (Codex P2, PR #75).
  beforeEach(() => {
    vi.clearAllMocks();
    getDocFromCacheSpy.mockReset();
    getDocFromCacheSpy.mockRejectedValue(new Error('no cache in this test double'));
  });

  it('logs a rejected commit via console.error with the error, and the returned result is unaffected', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('permission-denied');
    commitSpy.mockImplementationOnce(() => Promise.reject(failure));

    const res = await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 3,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
    });

    // Optimistic contract unchanged: setMark still resolves with the locally
    // computed win result (now incl. the transition verdict) even though the
    // write will be rolled back.
    expect(res).toEqual({
      cells: expect.any(Array),
      bingo: false,
      blackout: false,
      bingoTransition: false,
      blackoutTransition: false,
    });

    // commit() is fire-and-forget, so the .catch runs on a later microtask.
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    const call = errorSpy.mock.calls[0];
    expect(call[0]).toEqual(expect.stringContaining('setMark'));
    expect(call).toContain(failure); // the actual error is logged, not swallowed

    errorSpy.mockRestore();
  });

  it('fires the mark_rejected observability event with the error code + Mark context (#387)', async () => {
    // The 2026-07-17 production incident: a rules/stale-bundle skew rejected
    // every mark batch from stale clients with permission-denied, visible only
    // in sampled replay console logs. The rejection handler now also emits a
    // first-class analytics event so the next skew is queryable in PostHog.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = Object.assign(new Error('Missing or insufficient permissions.'), {
      code: 'permission-denied',
    });
    commitSpy.mockImplementationOnce(() => Promise.reject(failure));

    await setMark({
      uid: 'u1',
      cells: dealt(),
      index: 3,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      dayIndex: 2,
      daily: true,
    });

    await vi.waitFor(() =>
      expect(trackSpy).toHaveBeenCalledWith('mark_rejected', {
        code: 'permission-denied',
        index: 3,
        marked: true,
        dayIndex: 2,
        daily: true,
      }),
    );
    errorSpy.mockRestore();
  });
});
