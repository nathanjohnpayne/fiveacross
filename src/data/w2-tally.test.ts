import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cell, ClaimDoc } from '../types';

// specs/w2-tally.md, unit layer. Proves setMark's per-Prompt Tally extension
// (ADR 0002): every non-free Mark self-publishes an ATTRIBUTED marker at
// tally/{itemId}/markers/{uid} in the SAME batch as the board + player writes
// (never a Feed post, never a transaction); unmarking deletes exactly that
// marker; the free centre never tallies; and the attribution is resolved +
// bounded so the write always satisfies the marker rule. The rules-side proof
// that this shape is accepted/denied is tests/rules/w2-tally.test.ts; the
// offline-durable proof is tests/offline/w2-tally.test.ts.
//
// Also pins the admin-resolve half of the marker symmetry (Codex P2, PR #87):
// rejectClaim (src/data/admin.ts) deletes the rejected cell's marker exactly
// when it flips the cell marked→unmarked — never otherwise. The proofed-attach
// half (attachProof publishes + preserves markedAt) lives in
// src/data/w2-proof-capture.test.ts, alongside that transaction's harness.

const EVENT_ID = 'med-2026'; // src/firebase.ts default when VITE_EVENT_ID is unset

type FakeSnap = { exists: () => boolean; data: () => unknown };

const { setSpy, deleteSpy, commitSpy, getDocFromCacheSpy } = vi.hoisted(() => ({
  setSpy: vi.fn(),
  deleteSpy: vi.fn(),
  commitSpy: vi.fn(() => Promise.resolve()),
  // Rejects by default (nothing cached); individual tests override to seed a
  // cached player row so the attribution-fallback path can be exercised.
  getDocFromCacheSpy: vi.fn((): Promise<FakeSnap> => Promise.reject(new Error('no cache'))),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026' }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
    writeBatch: () => ({ set: setSpy, delete: deleteSpy, commit: commitSpy }),
    getDocFromCache: getDocFromCacheSpy,
    addDoc: vi.fn(),
    runTransaction: vi.fn(),
  };
});

import { setMark } from './api';
import { rejectClaim, confirmClaim } from './admin';
import { addDoc, runTransaction } from 'firebase/firestore';

// A dealt board: every non-free Square carries itemId `i{index}`; the free
// centre (12) is on and carries no itemId.
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

// The marker write is always the LAST batch.set (after board, then player).
const markerWrite = () => setSpy.mock.calls[setSpy.mock.calls.length - 1];

const base = {
  uid: 'u1',
  cells: dealt(),
  claimMode: 'honor' as const,
  currentFirstBingoAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getDocFromCacheSpy.mockReset();
  getDocFromCacheSpy.mockRejectedValue(new Error('no cache'));
});

describe('setMark — per-Prompt Tally marker (specs/w2-tally.md)', () => {
  it('marking a non-free Square publishes an attributed marker in the same batch', async () => {
    await setMark({ ...base, index: 3, nextMarked: true, displayName: 'Alice' });

    // Board, then player, then the Tally marker — one batch, three writes.
    expect(setSpy).toHaveBeenCalledTimes(3);
    const [ref, data, mergeOpt] = markerWrite();
    expect(ref.path).toBe(`events/${EVENT_ID}/tally/i3/markers/u1`);
    expect(data).toMatchObject({ uid: 'u1', displayName: 'Alice', eventId: EVENT_ID });
    expect(typeof data.markedAt).toBe('number');
    expect(mergeOpt).toBeUndefined(); // a full set carrying the path Event identity
    expect(deleteSpy).not.toHaveBeenCalled();

    // ADR 0002 / ADR 0006: the Tally is not a Feed post and rides a batch, not a tx.
    expect(addDoc).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('unmarking removes exactly that Player’s marker via batch.delete', async () => {
    await setMark({ ...base, index: 3, nextMarked: false, displayName: 'Alice' });

    // Only the board + player are set; the marker is DELETED, not written.
    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy.mock.calls[0][0].path).toBe(`events/${EVENT_ID}/tally/i3/markers/u1`);
  });

  it('the free centre Square never tallies', async () => {
    await setMark({ ...base, index: 12, nextMarked: true, displayName: 'Alice' });

    // Board + player only — no marker set, no marker delete for the free centre.
    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('attribution falls back to the cached player row name when no displayName is passed', async () => {
    getDocFromCacheSpy.mockImplementation((ref?: unknown) => {
      const path = (ref as { path?: string })?.path ?? '';
      if (path.endsWith('/players/u1')) {
        return Promise.resolve({ exists: () => true, data: () => ({ displayName: 'Deck Daddy' }) });
      }
      return Promise.reject(new Error('not cached'));
    });

    await setMark({ ...base, index: 5, nextMarked: true }); // no displayName param

    expect(markerWrite()[1]).toMatchObject({ uid: 'u1', displayName: 'Deck Daddy' });
  });

  it("falls back to 'Anonymous' when neither a param nor a cached name is available", async () => {
    await setMark({ ...base, index: 5, nextMarked: true }); // no param, no cache

    expect(markerWrite()[1]).toMatchObject({ displayName: 'Anonymous' });
  });

  it('bounds an over-long attributed name to the 100-char marker cap', async () => {
    await setMark({ ...base, index: 5, nextMarked: true, displayName: 'x'.repeat(140) });

    expect((markerWrite()[1].displayName as string).length).toBe(100);
  });
});

describe('rejectClaim / confirmClaim — the admin resolve keeps the marker symmetry (specs/w2-tally.md)', () => {
  // ADR 0002 invariant (Codex P2, PR #87): wherever a write flips a cell
  // marked→unmarked it must delete that cell's Tally marker (setMark's unmark,
  // deleteProof, and — here — rejectClaim), and wherever it flips →marked it must
  // ensure one (setMark, attachProof). Without the rejectClaim delete, a rejected
  // admin_confirmed claim reverses the board + stats but leaves the Player in the
  // Prompt's public count/who-list. These drive the REAL resolve() transaction in
  // src/data/admin.ts with the mocked runTransaction wired to a tx stub.
  const txGet = vi.fn();
  const txSet = vi.fn();
  const txDelete = vi.fn();
  let cells: Cell[];

  const claim = (over: Partial<ClaimDoc> = {}): ClaimDoc => ({
    id: 'c1',
    uid: 'u1',
    displayName: 'Deck Daddy',
    cellIndex: 5,
    itemText: 'p5',
    proofId: 'P',
    status: 'pending',
    createdAt: 0,
    resolvedBy: null,
    ...over,
  });

  const boardWrite = () =>
    txSet.mock.calls.find((c) => (c[0] as { path: string }).path.includes('/boards/'))?.[1] as
      | { cells: Cell[] }
      | undefined;

  beforeEach(() => {
    cells = dealt();
    vi.mocked(runTransaction).mockImplementation(async (_db, fn) =>
      fn({ get: txGet, set: txSet, delete: txDelete } as never),
    );
    txGet.mockImplementation((ref: { path: string }): Promise<FakeSnap> => {
      if (ref.path.includes('/boards/'))
        return Promise.resolve({ exists: () => true, data: () => ({ cells }) });
      if (ref.path.includes('/players/'))
        return Promise.resolve({ exists: () => true, data: () => ({ firstBingoAt: null }) });
      return Promise.resolve({ exists: () => false, data: () => undefined });
    });
  });

  it('rejecting a claim deletes the rejected cell’s marker in the SAME transaction (marked→unmarked symmetry)', async () => {
    cells[5] = { ...cells[5], marked: true, markedAt: 9, proofId: 'P', status: 'pending' };

    await rejectClaim(claim(), 'admin-1');

    // The claim's cell flipped unmarked...
    expect(boardWrite()!.cells[5]).toMatchObject({ marked: false, proofId: null, markedAt: null });
    // ...and exactly that cell's marker went with it — the same path
    // setMark/attachProof write, keyed by the claim owner's uid.
    expect(txDelete).toHaveBeenCalledTimes(1);
    expect((txDelete.mock.calls[0][0] as { path: string }).path).toBe(
      `events/${EVENT_ID}/tally/i5/markers/u1`,
    );
  });

  it('a reject that flips NO cell (the proof’s cell projection was drained away) deletes no marker', async () => {
    // The claim's cell no longer references the proof (a queued bare-Mark drain
    // took the cell over): isClaimCell matches nothing, the transform is a no-op,
    // and the marker — now owned by the live bare Mark — must survive.
    cells[5] = { ...cells[5], marked: true, markedAt: 9, proofId: null, status: 'confirmed' };

    await rejectClaim(claim(), 'admin-1');

    // #457 per-cell merge: a no-op transform writes NO cells field at all —
    // an explicit empty map in a merge would wipe the board's cells, so the
    // payload must omit the key entirely (Phase 4b P1 on #458). The standing
    // Mark survives by never being written.
    expect('cells' in boardWrite()!).toBe(false);
    expect(txDelete).not.toHaveBeenCalled();
  });

  it('confirming a claim never unmarks, so it deletes no marker', async () => {
    cells[5] = { ...cells[5], marked: true, markedAt: 9, proofId: 'P', status: 'pending' };

    await confirmClaim(claim(), 'admin-1');

    expect(boardWrite()!.cells[5]).toMatchObject({ marked: true, status: 'confirmed' });
    expect(txDelete).not.toHaveBeenCalled();
  });
});
