import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cell, ClaimDoc } from '../types';

// specs/w3-claim-modes.md, data layer. Claim Mode is the Event-wide friction knob
// (ADR 0001), NOT a trust level. Three concerns, no emulator:
//
//   1. The three modes at the mark fold (computeMark, src/data/api.ts): Honor marks
//      instantly and counts; admin_confirmed marks start PENDING and are excluded
//      from bingo credit (markedMask ignores status === 'pending') until an Admin
//      confirms. (proof_required's confirmed-on-attach fold is pinned in
//      src/data/w2-proof-capture.test.ts.)
//   2. The admin CONFIRM resolve (confirmClaim, src/data/admin.ts): flipping a
//      pending cell to confirmed credits the square, recomputes the win, and
//      publishes the pending Proof ('active'); rejectClaim unmarks + does not credit.
//   3. The confirm-path Moment DECISION (planConfirmBroadcasts, src/data/moments.ts,
//      issue #41 — the deferred PR #99 finding 6): a confirmed win emits the SAME
//      Moment the live edge would have, with the SAME gates — the ceremonial
//      First-to-BINGO held/decided against a server-confirmed roster (no false
//      singleton), suppressed on a regain by the durable witness, never fired for a
//      vacuous empty board. Exactly-once across the live + confirm paths is
//      structural (deterministic-id, create-only, immutable writers — pinned in
//      src/data/w2-feed-moments.test.ts and tests/rules/w2-feed-moments.test.ts).

const EVENT_ID = 'med-2026'; // src/firebase.ts default when VITE_EVENT_ID is unset

type Ref = { __kind: 'doc' | 'collection'; id?: string; path: string };
type Snap = { data: () => unknown; exists: () => boolean };

const { txGet, txSet, txDelete, runTx } = vi.hoisted(() => ({
  txGet: vi.fn(),
  txSet: vi.fn(),
  txDelete: vi.fn(),
  runTx: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026' }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    collection: (_db: unknown, ...segments: string[]): Ref => ({
      __kind: 'collection',
      path: segments.join('/'),
    }),
    doc: (_a: unknown, ...rest: string[]): Ref => ({
      __kind: 'doc',
      id: rest[rest.length - 1],
      path: rest.join('/'),
    }),
    runTransaction: (_db: unknown, fn: (tx: unknown) => unknown) => runTx(_db, fn),
    getDoc: vi.fn(() =>
      Promise.resolve({
        data: () => ({
          days: [
            {
              index: 0,
              date: '2026-07-16',
              place: 'Split',
              placeEmoji: '🇭🇷',
              theme: 'get-sporty',
              pool: 'main',
              tutorial: false,
              unlockAt: 0,
            },
          ],
        }),
      }),
    ),
    getDocFromCache: vi.fn(() => Promise.reject(new Error('no cache in this test double'))),
    writeBatch: () => ({ set: vi.fn(), commit: () => Promise.resolve() }),
    increment: (n: number) => ({ __inc: n }),
    updateDoc: vi.fn(),
    deleteDoc: vi.fn(),
    setDoc: vi.fn(),
  };
});

import { computeMark } from './api';
import { confirmClaim, rejectClaim } from './admin';
import { planConfirmBroadcasts } from './moments';
import { getDoc } from 'firebase/firestore';

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

// A board with `marked`+confirmed non-free Squares on (plus the always-on centre).
function boardWith(marked: number[]): Cell[] {
  const on = new Set(marked);
  return dealt().map((c) =>
    on.has(c.index) ? { ...c, marked: true, markedAt: 1, status: 'confirmed' as const } : c,
  );
}
const ROW0 = [0, 1, 2, 3, 4]; // a completed line → BINGO
const FULL = Array.from({ length: 25 }, (_, i) => i).filter((i) => i !== 12); // → Blackout

describe('Claim Mode at the mark fold — Honor instant, admin_confirmed pending (specs/w3-claim-modes.md)', () => {
  it('Honor marks INSTANTLY: the square is confirmed and counts toward stats + wins', () => {
    // A fifth mark completing row 0 in honor mode lands confirmed and credited.
    const r = computeMark({
      cells: boardWith([0, 1, 2, 3]),
      index: 4,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      now: 1000,
    });
    expect(r.cells[4]).toMatchObject({ marked: true, status: 'confirmed' });
    expect(r.player.squaresMarked).toBe(5); // all five count
    expect(r.bingo).toBe(true); // the line stands immediately
  });

  it('admin_confirmed marks start PENDING and are excluded from bingo credit until confirmed', () => {
    // The SAME winning tap in admin_confirmed mode: the cell goes pending, so it
    // neither counts nor completes the line — the win is withheld for the Admin.
    const r = computeMark({
      cells: boardWith([0, 1, 2, 3]),
      index: 4,
      nextMarked: true,
      claimMode: 'admin_confirmed',
      currentFirstBingoAt: null,
      now: 1000,
    });
    expect(r.cells[4]).toMatchObject({ marked: true, status: 'pending' });
    expect(r.player.squaresMarked).toBe(4); // the pending square is NOT credited
    expect(r.bingo).toBe(false); // and the line does NOT stand yet
  });
});

// --- confirmClaim / rejectClaim resolve (src/data/admin.ts) ------------------
let boardState: { cells: Cell[] } | undefined;
let playerState: Record<string, unknown> | undefined;
const getDocMock = vi.mocked(getDoc);

function setPayload(frag: string): Record<string, unknown> | undefined {
  const call = txSet.mock.calls.find((c) => (c[0] as Ref).path.includes(frag));
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

const pendingClaim = (over: Partial<ClaimDoc> = {}): ClaimDoc => ({
  id: 'claim-1',
  uid: 'u1',
  displayName: 'Deck Daddy',
  cellIndex: 4,
  itemText: 'Saw a sailor in Speedos',
  proofId: 'P',
  status: 'pending',
  createdAt: 1,
  resolvedBy: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  getDocMock.mockResolvedValue({
    data: () => ({
      days: [
        {
          index: 0,
          date: '2026-07-16',
          place: 'Split',
          placeEmoji: '🇭🇷',
          theme: 'get-sporty',
          pool: 'main',
          tutorial: false,
          unlockAt: 0,
        },
      ],
    }),
  } as Awaited<ReturnType<typeof getDoc>>);
  boardState = undefined;
  playerState = { firstBingoAt: null };
  runTx.mockImplementation((_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({ get: txGet, set: txSet, delete: txDelete }),
  );
  txGet.mockImplementation((ref: Ref): Promise<Snap> => {
    const exists = () => true;
    if (ref.path.includes('/boards/')) return Promise.resolve({ exists, data: () => boardState });
    if (ref.path.includes('/players/')) return Promise.resolve({ exists, data: () => playerState });
    return Promise.resolve({ exists: () => false, data: () => undefined });
  });
});

describe('confirmClaim — the pending win materializes: credit + publish the Proof (specs/w3-claim-modes.md)', () => {
  it('flips the claim cell pending→confirmed, credits the square, and activates the pending Proof', async () => {
    // cell 4 is the pending claim square backed by proof P; nothing else marked.
    const cells = boardWith([]);
    cells[4] = { ...cells[4], marked: true, markedAt: 9, proofId: 'P', status: 'pending' };
    boardState = { cells };

    await confirmClaim(pendingClaim(), 'admin-1');

    // The board cell is now confirmed (credited by the mask) and the stat rises.
    const board = setPayload('/boards/') as { cells: Cell[] };
    expect(board.cells[4].status).toBe('confirmed');
    expect(board.cells[4].markedAt).toBe(1000);
    expect(setPayload('/players/')).toMatchObject({ squaresMarked: 1 });
    // The pending (admin-only) Proof becomes publicly visible on confirm.
    expect(setPayload('/proofs/')).toMatchObject({ status: 'active' });
    // The claim is stamped resolved.
    expect(setPayload('/claims/')).toMatchObject({ status: 'confirmed', resolvedBy: 'admin-1' });
  });

  it('stamps the cell with the admin confirmation time that makes the square count', async () => {
    const cells = boardWith([]);
    cells[4] = { ...cells[4], marked: true, markedAt: 9, proofId: 'P', status: 'pending' };
    boardState = { cells };

    vi.mocked(Date.now).mockReturnValue(12_000);

    await confirmClaim(pendingClaim(), 'admin-1');

    const board = setPayload('/boards/') as { cells: Cell[] };
    expect(board.cells[4]).toMatchObject({ status: 'confirmed', markedAt: 12_000 });
  });

  it('a confirm that COMPLETES a line credits the bingo and stamps firstBingoAt', async () => {
    // Row 0 has four confirmed marks; cell 4 is the pending claim. Confirming it
    // completes the line — the win the confirm-path Moment celebrates.
    const cells = boardWith([0, 1, 2, 3]);
    cells[4] = { ...cells[4], marked: true, markedAt: 9, proofId: 'P', status: 'pending' };
    boardState = { cells };

    await confirmClaim(pendingClaim(), 'admin-1');

    const player = setPayload('/players/')!;
    expect(player.bingoCount).toBe(1);
    expect(player.squaresMarked).toBe(5);
    expect(typeof player.firstBingoAt).toBe('number'); // a bingo now stands
  });

  it('a daily confirm that COMPLETES a non-tutorial Day line pins the day-meta honor', async () => {
    const cells = boardWith([0, 1, 2, 3]);
    cells[4] = { ...cells[4], marked: true, markedAt: 9, proofId: 'P', status: 'pending' };
    boardState = { cells };

    await confirmClaim(pendingClaim({ dayIndex: 0 }), 'admin-1');

    expect(setPayload('/days/0/meta/0')).toEqual({
      firstBingo: { uid: 'u1', displayName: 'Deck Daddy', at: 1000 },
    });
  });

  it('surfaces event-doc read failures before resolving a daily claim', async () => {
    const err = new Error('event doc unavailable');
    getDocMock.mockRejectedValueOnce(err);

    await expect(confirmClaim(pendingClaim({ dayIndex: 0 }), 'admin-1')).rejects.toThrow(err);

    expect(runTx).not.toHaveBeenCalled();
    expect(txSet).not.toHaveBeenCalled();
  });

  it('rejectClaim unmarks the claim cell and does NOT credit it', async () => {
    const cells = boardWith([]);
    cells[4] = { ...cells[4], marked: true, markedAt: 9, proofId: 'P', status: 'pending' };
    boardState = { cells };

    await rejectClaim(pendingClaim(), 'admin-1');

    const board = setPayload('/boards/') as { cells: Cell[] };
    expect(board.cells[4]).toMatchObject({ marked: false, proofId: null });
    expect(setPayload('/players/')).toMatchObject({ squaresMarked: 0 });
    // A rejected Proof is NOT published — it stays pending/admin-only.
    expect(setPayload('/proofs/')).toBeUndefined();
    expect(setPayload('/claims/')).toMatchObject({ status: 'rejected', resolvedBy: 'admin-1' });
  });
});

describe('planConfirmBroadcasts — TRANSITION-gated, the same as the live edge (issue #41, Codex #116 finding 1)', () => {
  const base = {
    uid: 'u1',
    roster: [{ uid: 'u1', firstBingoAt: null as number | null }],
    rosterConfirmed: true,
    hasPriorBingo: false,
  };

  it('a confirm that COMPLETES the line (no bingo before → bingo after) emits bingo + the ceremonial first_bingo', () => {
    // Row 0 confirmed; cell 4 is the just-confirmed flip. Treating cell 4 as still
    // pending, row 0 is incomplete — so confirming it CROSSES the threshold.
    const plan = planConfirmBroadcasts({ ...base, cells: boardWith(ROW0), confirmedIndexes: [4] });
    expect(plan).toEqual({ bingo: true, blackout: false, firstBingo: true, firstBingoHeld: false });
  });

  it('CORE finding 1 — a standing-BINGO player confirming a DIFFERENT non-completing square emits nothing', () => {
    // Row 0 already stands; cell 10 (row 2) is separately confirmed and completes
    // no new line. With cell 10 forced pending the bingo STILL stands, so there is
    // no transition — the pre-fix code returned bingo: true off hasBingo(cells).
    const plan = planConfirmBroadcasts({
      ...base,
      cells: boardWith([...ROW0, 10]),
      confirmedIndexes: [10],
    });
    expect(plan).toEqual({ bingo: false, blackout: false, firstBingo: false, firstBingoHeld: false });
  });

  it('a confirm that COMPLETES the full card emits blackout; the bingo already stood, so it is NOT re-emitted', () => {
    // Full card, cell 4 the last flip: with cell 4 pending the board is not a
    // blackout (transition) but a bingo already stands via other lines (no bingo
    // transition).
    const plan = planConfirmBroadcasts({ ...base, cells: boardWith(FULL), confirmedIndexes: [4] });
    expect(plan.blackout).toBe(true);
    expect(plan.bingo).toBe(false);
  });

  it('NO false singleton: another Player already bingoed → own bingo posts, ceremony does NOT', () => {
    const plan = planConfirmBroadcasts({
      ...base,
      cells: boardWith(ROW0),
      confirmedIndexes: [4],
      roster: [{ uid: 'someone-else', firstBingoAt: 123 }],
    });
    expect(plan.bingo).toBe(true); // the winner's own BINGO still posts
    expect(plan.firstBingo).toBe(false); // but the event singleton is NOT minted
    expect(plan.firstBingoHeld).toBe(false); // and it is decided (dropped), not held
  });

  it('an UNCONFIRMED roster HOLDS the ceremony (not guessed) while still posting the bingo', () => {
    const plan = planConfirmBroadcasts({
      ...base,
      cells: boardWith(ROW0),
      confirmedIndexes: [4],
      rosterConfirmed: false,
    });
    expect(plan.bingo).toBe(true);
    expect(plan.firstBingo).toBe(false); // never claimed off an unconfirmed roster
    expect(plan.firstBingoHeld).toBe(true); // held for the roster gate to re-decide
  });

  it('a REGAIN with the durable witness posts the plain bingo but never re-mints the singleton', () => {
    const plan = planConfirmBroadcasts({
      ...base,
      cells: boardWith(ROW0),
      confirmedIndexes: [4],
      hasPriorBingo: true,
    });
    expect(plan.bingo).toBe(true);
    expect(plan.firstBingo).toBe(false);
    expect(plan.firstBingoHeld).toBe(false);
  });

  it('an empty / non-attributable board emits NOTHING — isBlackout([]) must not fire vacuously', () => {
    const plan = planConfirmBroadcasts({ ...base, cells: [], confirmedIndexes: [4] });
    expect(plan).toEqual({ bingo: false, blackout: false, firstBingo: false, firstBingoHeld: false });
  });

  it('a confirmed square that completes NO line emits nothing', () => {
    const plan = planConfirmBroadcasts({ ...base, cells: boardWith([0, 1, 2]), confirmedIndexes: [2] });
    expect(plan).toEqual({ bingo: false, blackout: false, firstBingo: false, firstBingoHeld: false });
  });
});
