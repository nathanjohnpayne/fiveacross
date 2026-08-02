import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { User } from 'firebase/auth';
import type { BoardDoc, Cell, ClaimDoc, EventDoc, PlayerDoc } from '../types';

// specs/w3-claim-modes.md, component layer (RTL-jsdom). Two surfaces:
//
// Admin — the Claim Mode control reads the Event's current mode and writes the
// chosen one (Honor / Proof-to-mark / Admin-confirmed, NEVER "Verified"), and the
// pending-claims queue confirms / rejects each Claim.
//
// ConfirmWinMoments — the always-mounted, route-independent confirm-path Moment
// emitter (#41, the deferred PR #99 finding 6). When one of the Player's OWN
// pending Marks is CONFIRMED by an Admin and the board write reflects the win, it
// broadcasts the SAME Moment the live edge would have — attributed to the WINNER,
// exactly once, with the SAME first-BINGO roster gate (no false singleton). A win
// that already stood at mount is baseline (history), never re-announced.

const H = vi.hoisted(() => ({
  // shared auth
  user: null as User | null,
  // ConfirmWinMoments inputs
  board: null as BoardDoc | null,
  player: null as PlayerDoc | null,
  playerLoading: false,
  playerConfirmed: true,
  players: [] as PlayerDoc[],
  rosterConfirmed: true,
  claims: [] as ClaimDoc[],
  claimsConfirmed: true,
  // Daily-cards inputs (#274): the Event schedule (read via useEventDoc) and the
  // viewer's day-scoped boards keyed by dayIndex (useMyDayBoards).
  dayBoards: new Map<number, BoardDoc>(),
  // Per-snapshot origin of the claims sub (Codex #116 R2 finding 2): false =
  // server-backed (may seed the freshness witness), true = cache-only (must not).
  claimsFromCache: false,
  // moment writers (stubbed; the real write shape is src/data/w2-feed-moments.test.ts)
  broadcastBingo: vi.fn(),
  broadcastBlackout: vi.fn(),
  broadcastFirstBingo: vi.fn(),
  hasPriorBingoWitness: vi.fn(),
  // Admin inputs
  event: null as Partial<EventDoc> | null,
  pendingClaims: [] as ClaimDoc[],
  setClaimMode: vi.fn(),
  confirmClaim: vi.fn(),
  rejectClaim: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user, loading: false }) }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  // ConfirmWinMoments
  useBoard: () => ({ data: H.board, loading: false, hasServerData: true }),
  useMyDayBoards: () => H.dayBoards,
  useMyPlayer: () => ({ data: H.player, loading: H.playerLoading, hasServerData: H.playerConfirmed }),
  useLeaderboard: () => ({ players: H.players, loading: false, hasServerData: H.rosterConfirmed }),
  useMyClaims: () => ({
    claims: H.claims,
    loading: false,
    hasServerData: H.claimsConfirmed,
    fromCache: H.claimsFromCache,
  }),
  // Admin
  useEventDoc: () => ({ data: H.event, loading: false }),
  usePendingClaims: () => ({ claims: H.pendingClaims, loading: false }),
  useReportedProofs: () => ({ flagged: [], loading: false }),
  useAllItems: () => ({ items: [], loading: false }),
  usePendingItems: () => ({ items: [], loading: false }),
  isReportHidden: () => false,
  // Admin.tsx imports these ban predicates from useData (#108/#122); this mock
  // replaces the whole module, so they must be provided or Admin loads with the
  // names undefined. Mirror src/data/moderation.ts.
  isBanned: (uid: string | null | undefined, banned: readonly string[] | undefined) =>
    !!uid && Array.isArray(banned) && banned.includes(uid),
  isSystemAuthor: (uid: string | null | undefined) => uid === 'seed',
}));
// Keep planConfirmBroadcasts + MomentActor real (the decision under test); stub the
// three writers + the durable-witness read.
vi.mock('../data/moments', async (importOriginal) => {
  // #267: spreads the real module, so the per-card blackout queue reads come
  // through genuinely — no stub needed.
  const actual = await importOriginal<typeof import('../data/moments')>();
  return {
    ...actual,
    broadcastBingo: H.broadcastBingo,
    broadcastBlackout: H.broadcastBlackout,
    broadcastFirstBingo: H.broadcastFirstBingo,
    hasPriorBingoWitness: H.hasPriorBingoWitness,
  };
});
vi.mock('../data/admin', () => ({
  setClaimMode: H.setClaimMode,
  confirmClaim: H.confirmClaim,
  rejectClaim: H.rejectClaim,
  hideProof: vi.fn(),
  restoreProof: vi.fn(),
  clearProofReports: vi.fn(),
  hideItem: vi.fn(),
  restoreItem: vi.fn(),
  deleteItem: vi.fn(),
  clearItemReports: vi.fn(),
  setEventTheme: vi.fn(),
  setDayTheme: vi.fn(),
  // #222 Proof & Claims panel no-op stubs (coverage: Admin.test.tsx).
  setPhotoProofSource: vi.fn(),
  setStripPhotoExif: vi.fn(),
  setVisionGate: vi.fn(),
  setReportHideThreshold: vi.fn(),
  // Admin.tsx imports banUser/unbanUser (#108/#122); provide them so this
  // whole-module mock does not leave the names undefined at import.
  banUser: vi.fn(),
  unbanUser: vi.fn(),
}));
vi.mock('../data/proofs', () => ({ deleteProof: vi.fn() }));

import Admin from './Admin';
import ConfirmWinMoments from './ConfirmWinMoments';

// The claim-mode control lives in Game settings and the claims queue in the
// Review queue (specs/admin-console-ia.md) — render at the section route.
const renderAdmin = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Admin />
    </MemoryRouter>,
  );
import { resetConfirmStates } from '../data/moments';

// The confirm-path listener state is MODULE-scope + uid-keyed (survives unmounts by
// design), so a couple of microtask rounds drain the async witness→plan chain (incl.
// the drain-until-empty loop), and it MUST be reset between cases.
const flushAsync = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

// A dealt board with the given non-free Squares marked+confirmed; `pending` cells
// carry status 'pending' so they are excluded from the win mask. Each marked
// non-free cell carries a proofId — `proofs[index]` when supplied, else the
// deterministic `proof-<index>` a claim() at that index defaults to — so the
// confirm listener's claim-specific reflection (proofId match, R4 finding 2) sees
// a realistic board: the cell a claim resolves carries THAT claim's proofId.
function cellsWith(confirmed: number[], pending: number[] = [], proofs: Record<number, string> = {}): Cell[] {
  const c = new Set(confirmed);
  const p = new Set(pending);
  return Array.from({ length: 25 }, (_, index) => {
    const marked = index === 12 || c.has(index) || p.has(index);
    const hasProof = index !== 12 && (c.has(index) || p.has(index));
    return {
      index,
      itemId: index === 12 ? null : `i${index}`,
      text: index === 12 ? 'FREE' : `p${index}`,
      free: index === 12,
      marked,
      markedAt: marked ? 1 : null,
      status: p.has(index) ? ('pending' as const) : ('confirmed' as const),
      proofId: hasProof ? (proofs[index] ?? `proof-${index}`) : null,
    };
  });
}
const boardDoc = (cells: Cell[], uid = 'u1'): BoardDoc => ({ uid, dayIndex: 0, seed: 1, createdAt: 0, cells });
const ROW0 = [0, 1, 2, 3, 4];
const claim = (over: Partial<ClaimDoc> = {}): ClaimDoc => {
  const cellIndex = over.cellIndex ?? 4;
  return {
    id: 'c1',
    uid: 'u1',
    displayName: 'Deck Daddy',
    cellIndex,
    itemText: 'Saw a sailor in Speedos',
    // Default proofId matches the cell's default `proof-<index>` so the board
    // reflects this claim's confirm; override it (with a matching board proofId) to
    // exercise the claim-specific match.
    proofId: `proof-${cellIndex}`,
    status: 'confirmed',
    createdAt: 1,
    resolvedBy: 'admin-9',
    ...over,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  resetConfirmStates(); // the listener state is module-scope + uid-keyed — clear it per case
  H.user = { uid: 'u1', displayName: 'Sailor', photoURL: null } as unknown as User;
  H.board = null;
  H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
  H.playerLoading = false;
  H.playerConfirmed = true;
  H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
  H.rosterConfirmed = true;
  H.claims = [];
  H.claimsConfirmed = true;
  H.event = null;
  H.dayBoards = new Map();
  H.claimsFromCache = false; // default: server-backed observations
  H.hasPriorBingoWitness.mockResolvedValue(false);
});

describe('Admin — Claim Mode control (specs/w3-claim-modes.md)', () => {
  beforeEach(() => {
    H.user = { uid: 'admin1' } as unknown as User;
    H.event = {
      claimMode: 'honor',
      admins: ['admin1'],
      defaultTheme: 'neon-playground',
      settings: { reportHideThreshold: 5 },
    } as Partial<EventDoc>;
    H.pendingClaims = [];
  });

  it('labels the three modes Honor / Proof-to-mark / Admin-confirmed — never "Verified" — and marks the active one', () => {
    renderAdmin('/more/admin/settings');
    expect(screen.getByRole('button', { name: 'Honor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Proof-to-mark' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Admin-confirmed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verified/i })).toBeNull();
    // The Event's current mode is reflected as the selected control.
    expect(screen.getByRole('button', { name: 'Honor' }).className).toContain('on');
    expect(screen.getByRole('button', { name: 'Admin-confirmed' }).className).not.toContain('on');
  });

  it('writes the chosen mode when an Admin picks it', () => {
    renderAdmin('/more/admin/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Admin-confirmed' }));
    expect(H.setClaimMode).toHaveBeenCalledWith('admin_confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'Proof-to-mark' }));
    expect(H.setClaimMode).toHaveBeenCalledWith('proof_required');
  });

  it('confirms and rejects a pending Claim as the acting Admin', () => {
    // The claims group renders in admin_confirmed mode only (the one mode where
    // pending claims exist at all) — the Review queue's mode gate.
    H.event = { ...(H.event as object), claimMode: 'admin_confirmed' } as Partial<EventDoc>;
    H.pendingClaims = [claim({ status: 'pending', resolvedBy: null })];
    renderAdmin('/more/admin/queue');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(H.confirmClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'admin1');
    fireEvent.click(screen.getByTitle('Reject'));
    expect(H.rejectClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'admin1');
  });
});

describe('ConfirmWinMoments — the confirm-path Moment emitter (issue #41)', () => {
  it('emits the winner-attributed bingo + first_bingo when a confirm completes a line off-route', async () => {
    // Baseline: a pending row-0 tap (cell 4 pending) with no confirmed claim yet.
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]));
    H.claims = [claim({ status: 'pending', resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // nothing confirmed yet

    // The Admin confirms: the claim flips confirmed AND the board write reflects the
    // now-confirmed cell 4, completing row 0 — the win the live edge never saw.
    H.claims = [claim({ status: 'confirmed' })];
    H.board = boardDoc(cellsWith(ROW0));
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // The Moment is attributed to the WINNER (the claim owner / signed-in Player),
    // never the confirming Admin, and fires exactly once.
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    // Legacy single-board event: no Day rides the broadcast (#274).
    expect(H.broadcastBingo).toHaveBeenCalledWith({ uid: 'u1', displayName: 'Deck Daddy', photoURL: null }, undefined);
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledWith({ uid: 'u1', displayName: 'Deck Daddy', photoURL: null }, undefined);
  });

  it('NO false singleton: a confirm racing another Player’s live first-BINGO posts the bingo but not the ceremony', async () => {
    H.players = [{ uid: 'someone-else', firstBingoAt: 123 } as unknown as PlayerDoc];
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]));
    H.claims = [claim({ status: 'pending', resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    H.claims = [claim({ status: 'confirmed' })];
    H.board = boardDoc(cellsWith(ROW0));
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    expect(H.broadcastBingo).toHaveBeenCalledTimes(1); // own BINGO still posts
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // event singleton NOT minted
  });

  it('HOLDS the ceremony while the roster is unconfirmed, then claims it once the roster confirms', async () => {
    H.rosterConfirmed = false;
    H.players = [];
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]));
    H.claims = [claim({ status: 'pending', resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    // Confirm while the roster is unconfirmed: the bingo posts, the ceremony holds.
    H.claims = [claim({ status: 'confirmed' })];
    H.board = boardDoc(cellsWith(ROW0));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // held, not guessed

    // Roster confirms with no earlier bingo → the held ceremony fires once.
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-announce a win that already stood at mount — a confirm predating this session is baseline', async () => {
    // Both the confirmed claim and the completed board are present on first paint:
    // history, not a fresh confirm. Nothing broadcasts.
    H.board = boardDoc(cellsWith(ROW0));
    H.claims = [claim({ status: 'confirmed' })];
    render(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
    expect(H.broadcastBlackout).not.toHaveBeenCalled();
  });

  it('a confirmed square that completes no line emits nothing', async () => {
    H.board = boardDoc(cellsWith([0, 1], [2]));
    H.claims = [claim({ status: 'pending', cellIndex: 2, resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    H.claims = [claim({ status: 'confirmed', cellIndex: 2 })];
    H.board = boardDoc(cellsWith([0, 1, 2]));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('FINDING 1 — a standing-BINGO player: confirming a DIFFERENT non-completing square emits nothing', async () => {
    // Row 0 already stands (history — never seen pending, so never announced). The
    // player has a SEPARATE pending claim on cell 10 (row 2) that completes no line.
    H.board = boardDoc(cellsWith(ROW0, [10]));
    H.claims = [claim({ status: 'pending', cellIndex: 10, resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    // Admin confirms cell 10: the board still holds only row 0 — no NEW line. The
    // pre-fix code posted a BINGO here off hasBingo(cells); the transition gate does not.
    H.claims = [claim({ status: 'confirmed', cellIndex: 10 })];
    H.board = boardDoc(cellsWith([...ROW0, 10]));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('FINDING 2 — a second confirm arriving during the first witness read is NOT stranded (drain-until-empty)', async () => {
    // Controllable witness reads so the second confirm can arrive mid-flight.
    const witnessResolvers: Array<(v: boolean) => void> = [];
    H.hasPriorBingoWitness.mockImplementation(
      () => new Promise<boolean>((res) => witnessResolvers.push(res)),
    );
    // Two pending claims observed: c1 = cell 10 (non-completing), c2 = cell 4 (completes row 0).
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4, 10]));
    H.claims = [
      claim({ id: 'c1', status: 'pending', cellIndex: 10, resolvedBy: null }),
      claim({ id: 'c2', status: 'pending', cellIndex: 4, resolvedBy: null }),
    ];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    // Confirm c1 (cell 10): its witness read goes in flight (unresolved).
    H.claims = [
      claim({ id: 'c1', status: 'confirmed', cellIndex: 10 }),
      claim({ id: 'c2', status: 'pending', cellIndex: 4, resolvedBy: null }),
    ];
    H.board = boardDoc(cellsWith([0, 1, 2, 3, 10], [4]));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(witnessResolvers).toHaveLength(1); // c1 in flight

    // Confirm c2 (cell 4) WHILE c1's witness is still pending — completes row 0.
    H.claims = [
      claim({ id: 'c1', status: 'confirmed', cellIndex: 10 }),
      claim({ id: 'c2', status: 'confirmed', cellIndex: 4 }),
    ];
    H.board = boardDoc(cellsWith([...ROW0, 10]));
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // Settle the witness read(s): the post-await recompute (R4 finding 1) folds BOTH
    // confirms — including c2, which landed mid-read — into one batch, so c2 is never
    // stranded. Drain any further reads the loop may have started.
    for (let i = 0; i < witnessResolvers.length; i++) witnessResolvers[i](false);
    await flushAsync();
    for (let i = 0; i < witnessResolvers.length; i++) witnessResolvers[i](false);
    await flushAsync();
    // Exactly one BINGO (the batch crosses row 0 via c2), never doubled, none stranded.
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
  });

  it('FINDING 3 — offline-BUT-OPEN: a SERVER-observed pending claim CONFIRMED on reconnect still emits (not baselined)', async () => {
    // The app was open and online when it saw the claim PENDING (server-backed), so
    // the freshness witness seeds. It then goes offline; the admin confirms.
    H.claimsFromCache = false;
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]));
    H.claims = [claim({ status: 'pending', resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();

    // Reconnect: the SERVER-backed snapshot shows the claim CONFIRMED and the board
    // reflects it — a genuine in-session pending→confirmed flip, so it emits once.
    H.claims = [claim({ status: 'confirmed' })];
    H.board = boardDoc(cellsWith(ROW0));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
  });

  it('FINDING 4 — an account switch parks a roster-held first_bingo; a switch-back fires it once for the original uid', async () => {
    // u1 crosses a bingo while the roster is UNCONFIRMED → the bingo posts, the
    // ceremonial first_bingo is HELD.
    H.rosterConfirmed = false;
    H.players = [];
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]));
    H.claims = [claim({ status: 'pending', resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    H.claims = [claim({ status: 'confirmed' })];
    H.board = boardDoc(cellsWith(ROW0));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // held (roster unconfirmed)

    // Switch to another account — u1's held ceremony must PARK, not reset.
    H.user = { uid: 'u2', displayName: 'Other', photoURL: null } as unknown as User;
    H.player = { displayName: 'Other', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    H.board = boardDoc(cellsWith([]), 'u2');
    H.claims = [];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();

    // Switch BACK to u1 and confirm the roster with no earlier bingo → the parked
    // ceremony fires exactly once (the pre-fix reset discarded it on switch-away).
    H.user = { uid: 'u1', displayName: 'Sailor', photoURL: null } as unknown as User;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    H.board = boardDoc(cellsWith(ROW0));
    H.claims = [claim({ status: 'confirmed' })];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
  });

  it('R2 FINDING 1 — a held first_bingo whose ORIGINAL win FALLS is dropped; a later regained line does NOT fire it', async () => {
    // Cross a bingo while the roster is UNCONFIRMED → the bingo posts, first_bingo held.
    H.rosterConfirmed = false;
    H.players = [];
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]));
    H.claims = [claim({ status: 'pending', resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    H.claims = [claim({ status: 'confirmed' })];
    H.board = boardDoc(cellsWith(ROW0));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // held (roster unconfirmed)

    // Still within the slow-roster window, the player UNMARKS row 0 — the held win
    // FALLS. This no-bingo snapshot must void the held candidate.
    H.board = boardDoc(cellsWith([0, 1, 2, 3]));
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // Then a DIFFERENT line completes (column 0) — a NEW board, not the held win.
    H.board = boardDoc(cellsWith([0, 5, 10, 15, 20]));
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // The roster finally confirms. The pre-fix code held the stale candidate through
    // the fall and published it against this regained board; fall-clearing dropped it.
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // stale held singleton NEVER fires
  });

  it('R2 FINDING 2 — a CACHE-only pending observation does not seed the witness; a confirm that happened while CLOSED stays baselined', async () => {
    // Fresh reload: the persistent cache replays the last-known rows. The claim was
    // pending at close and the FIRST snapshot is cache-only.
    H.claimsFromCache = true;
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]));
    H.claims = [claim({ status: 'pending', resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    // The server snapshot arrives showing the claim already CONFIRMED (the admin
    // confirmed WHILE the app was closed). Because the pending was cache-only, the
    // witness never seeded → this is baselined as the fully-closed residual, NOT a
    // fresh flip. The pre-fix code seeded from the cache pending and posted a Moment.
    H.claimsFromCache = false;
    H.claims = [claim({ status: 'confirmed' })];
    H.board = boardDoc(cellsWith(ROW0));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('R3 FINDING 1 — a PRIOR account’s stale claim (rendered under the new uid) seeds and broadcasts NOTHING', async () => {
    // The listener now renders under u2, but the claims subscription still exposes the
    // PREVIOUS account (u1)’s rows for a render (useColSub clears them only in an
    // effect). u2’s board has row 0 completed, so a mis-adjudication would broadcast.
    H.user = { uid: 'u2', displayName: 'Second Sailor', photoURL: null } as unknown as User;
    H.player = { displayName: 'Second Sailor', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]), 'u2');
    H.claims = [claim({ id: 'stale', uid: 'u1', status: 'pending', cellIndex: 4, resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    // u1’s stale claim flips confirmed and u2’s board reflects cell 4 — the pre-fix
    // code seeded u2’s witness from u1’s pending row and then broadcast u2’s BINGO
    // from u1’s confirm. The cross-account guard ignores any claim whose uid ≠ u2.
    H.claims = [claim({ id: 'stale', uid: 'u1', status: 'confirmed', cellIndex: 4 })];
    H.board = boardDoc(cellsWith(ROW0), 'u2');
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('R3 FINDING 3 — a confirm reported BEFORE its board write lands HOLDS (no premature emit+delete), then fires once when the mark arrives', async () => {
    // Observe the claim pending in-session (seeds the witness).
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]));
    H.claims = [claim({ status: 'pending', resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    // The claims listener reports CONFIRMED, but the board write has NOT landed: a
    // stale/pre-claim snapshot where cell 4 is unmarked with NO status. The pre-fix
    // `status !== 'pending'` test treated `undefined` as reflected, adjudicated the
    // stale board (no transition), and CONSUMED the awaiting claim — so the real
    // confirm below never posted. Requiring marked+confirmed makes it HOLD instead.
    const staleBoard = cellsWith([0, 1, 2, 3]).map((c) =>
      c.index === 4 ? { ...c, marked: false, markedAt: null, status: undefined } : c,
    );
    H.claims = [claim({ status: 'confirmed' })];
    H.board = boardDoc(staleBoard);
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // held — the board write has not arrived

    // The board catches up: cell 4 is now marked+confirmed and row 0 completes. The
    // still-awaiting claim adjudicates and posts exactly one BINGO.
    H.board = boardDoc(cellsWith(ROW0));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
  });

  it('R4 FINDING 1 — two confirms each completing a DIFFERENT line, the second landing mid-witness-read, are batched — neither masks the other', async () => {
    const witnessResolvers: Array<(v: boolean) => void> = [];
    H.hasPriorBingoWitness.mockImplementation(
      () => new Promise<boolean>((res) => witnessResolvers.push(res)),
    );
    // c1 = cell 4 completes row 0 ([0..4]); c2 = cell 9 completes row 1 ([5..9]).
    H.board = boardDoc(cellsWith([0, 1, 2, 3, 5, 6, 7, 8], [4, 9]));
    H.claims = [
      claim({ id: 'c1', status: 'pending', cellIndex: 4, resolvedBy: null }),
      claim({ id: 'c2', status: 'pending', cellIndex: 9, resolvedBy: null }),
    ];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    // Confirm c1 (cell 4 → row 0): witness read in flight.
    H.claims = [
      claim({ id: 'c1', status: 'confirmed', cellIndex: 4 }),
      claim({ id: 'c2', status: 'pending', cellIndex: 9, resolvedBy: null }),
    ];
    H.board = boardDoc(cellsWith([0, 1, 2, 3, 4, 5, 6, 7, 8], [9]));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(witnessResolvers).toHaveLength(1);

    // Confirm c2 (cell 9 → row 1) WHILE c1's read is pending: both lines now stand.
    H.claims = [
      claim({ id: 'c1', status: 'confirmed', cellIndex: 4 }),
      claim({ id: 'c2', status: 'confirmed', cellIndex: 9 }),
    ];
    H.board = boardDoc(cellsWith([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // Settle the read(s). The pre-fix code adjudicated only the PRE-await snapshot
    // ([c1]) with c2 already standing, so c1's plan saw row 1 as an already-standing
    // bingo and crossed nothing — then c2's rerun saw row 0 standing and also crossed
    // nothing → BOTH masked, no Moment. The post-await recompute batches [c1, c2] with
    // both cells forced pending, so the batch crosses BINGO exactly once.
    for (let i = 0; i < witnessResolvers.length; i++) witnessResolvers[i](false);
    await flushAsync();
    for (let i = 0; i < witnessResolvers.length; i++) witnessResolvers[i](false);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
  });

  it('R4 FINDING 2 — a claim resolved by a proofId the board cell does NOT reflect stays awaiting and emits nothing', async () => {
    // The player has two submissions at cell 4; the NEWER proof ('proof-new') is the
    // one on the board. Observe the OLDER claim (proof 'proof-old') pending in-session.
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4], { 4: 'proof-new' }));
    H.claims = [claim({ id: 'c-old', proofId: 'proof-old', status: 'pending', cellIndex: 4, resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    // confirmClaim resolves by proofId, so confirming the OLDER claim (proof-old) does
    // NOT touch the cell — which carries proof-new — even though the board shows cell 4
    // confirmed (via the newer proof) and row 0 complete. The pre-fix index-only test
    // treated cell 4 as reflected and posted a BINGO for a transition the older claim
    // did not cause; the proofId match holds the older claim instead.
    H.claims = [claim({ id: 'c-old', proofId: 'proof-old', status: 'confirmed', cellIndex: 4 })];
    H.board = boardDoc(cellsWith(ROW0, [], { 4: 'proof-new' }));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });
});

describe('ConfirmWinMoments — daily-cards events adjudicate against the Claim’s own Day board (#274)', () => {
  // A 3-Day schedule; only days.length matters to the component (it bounds the
  // useMyDayBoards subscription in the real hook — here the mock returns H.dayBoards).
  const DAYS = Array.from({ length: 3 }, (_, index) => ({ index })) as unknown as EventDoc['days'];
  const ACTOR = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null };

  beforeEach(() => {
    H.event = { days: DAYS } as Partial<EventDoc>;
    H.board = null; // dealDayCard never writes the legacy path in daily mode
  });

  it('a confirmed daily Claim adjudicates against ITS day board and the Day rides every broadcast + the honor pin', async () => {
    // Day 1's card has row 0 all-but-cell-4; the claim carries dayIndex 1.
    H.dayBoards = new Map([[1, boardDoc(cellsWith([0, 1, 2, 3], [4]))]]);
    H.claims = [claim({ status: 'pending', resolvedBy: null, dayIndex: 1 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();

    // The Admin confirms; the DAY-SCOPED board write reflects it (the legacy board
    // stays null the whole time — pre-#274 this exact flow emitted NOTHING).
    H.claims = [claim({ status: 'confirmed', dayIndex: 1 })];
    H.dayBoards = new Map([[1, boardDoc(cellsWith(ROW0))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, 1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledWith(ACTOR, 1);
  });

  it('a daily blackout confirm broadcasts with its Day (the per-card id contract, #267)', async () => {
    // All 24 squares stand except cell 4, which is pending under the claim.
    const ALL = Array.from({ length: 25 }, (_, index) => index).filter((index) => index !== 12);
    H.dayBoards = new Map([[2, boardDoc(cellsWith(ALL.filter((index) => index !== 4), [4]))]]);
    // A bingo already stood on this card pre-confirm, so ONLY the blackout crosses.
    H.hasPriorBingoWitness.mockResolvedValue(true);
    H.claims = [claim({ status: 'pending', resolvedBy: null, dayIndex: 2 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    H.claims = [claim({ status: 'confirmed', dayIndex: 2 })];
    H.dayBoards = new Map([[2, boardDoc(cellsWith(ALL))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    expect(H.broadcastBlackout).toHaveBeenCalledTimes(1);
    expect(H.broadcastBlackout).toHaveBeenCalledWith(ACTOR, 2);
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('a BATCH of confirms across two Days adjudicates each against its OWN board — never a merged mask', async () => {
    // Day 0: cell 4 completes row 0. Day 1: cell 10 completes NO line. Were the
    // groups merged onto one board, the day-1 confirm would ride day-0's transition.
    H.dayBoards = new Map([
      [0, boardDoc(cellsWith([0, 1, 2, 3], [4]))],
      [1, boardDoc(cellsWith([0, 1], [10]))],
    ]);
    H.claims = [
      claim({ id: 'c-d0', status: 'pending', resolvedBy: null, cellIndex: 4, dayIndex: 0 }),
      claim({ id: 'c-d1', status: 'pending', resolvedBy: null, cellIndex: 10, dayIndex: 1 }),
    ];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    H.claims = [
      claim({ id: 'c-d0', status: 'confirmed', cellIndex: 4, dayIndex: 0 }),
      claim({ id: 'c-d1', status: 'confirmed', cellIndex: 10, dayIndex: 1 }),
    ];
    H.dayBoards = new Map([
      [0, boardDoc(cellsWith(ROW0))],
      [1, boardDoc(cellsWith([0, 1, 10]))],
    ]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // Exactly ONE bingo — day 0's — stamped with ITS day; day 1's non-completing
    // confirm emits nothing.
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, 0);
  });

  it('a confirm whose Day board has not arrived HOLDS, then fires when that board loads', async () => {
    // The claim is observed pending, confirmed — but day 1's board is still absent
    // (a fresh device: the claims sub answered before the board sub).
    H.dayBoards = new Map();
    H.claims = [claim({ status: 'pending', resolvedBy: null, dayIndex: 1 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    H.claims = [claim({ status: 'confirmed', dayIndex: 1 })];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // held — no board to adjudicate against

    // The day board arrives already reflecting the confirm → the held entry drains.
    H.dayBoards = new Map([[1, boardDoc(cellsWith(ROW0))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, 1);
  });

  it('a roster-HELD daily ceremony publishes with its Day — and fall-clears against that Day’s board', async () => {
    H.rosterConfirmed = false;
    H.players = [];
    H.dayBoards = new Map([[1, boardDoc(cellsWith([0, 1, 2, 3], [4]))]]);
    H.claims = [claim({ status: 'pending', resolvedBy: null, dayIndex: 1 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    H.claims = [claim({ status: 'confirmed', dayIndex: 1 })];
    H.dayBoards = new Map([[1, boardDoc(cellsWith(ROW0))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, 1);
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // held at the roster gate

    // Roster confirms → the ceremony publishes carrying the HELD win's Day.
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledWith(ACTOR, 1);
  });

  it('a held daily ceremony whose win FALLS on its own Day board is voided — a later regain never fires it', async () => {
    H.rosterConfirmed = false;
    H.players = [];
    H.dayBoards = new Map([[1, boardDoc(cellsWith([0, 1, 2, 3], [4]))]]);
    H.claims = [claim({ status: 'pending', resolvedBy: null, dayIndex: 1 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    H.claims = [claim({ status: 'confirmed', dayIndex: 1 })];
    H.dayBoards = new Map([[1, boardDoc(cellsWith(ROW0))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // The win falls on DAY 1's board (an unmark) while the roster is still pending.
    H.dayBoards = new Map([[1, boardDoc(cellsWith([0, 1, 2, 3]))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // Roster confirms afterwards: the voided candidate must not fire.
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('a LEGACY Claim (no dayIndex) on the same session still adjudicates the single event board', async () => {
    // Mixed shape safety: an event mid-migration (or a stale claim doc) with no
    // dayIndex keeps the legacy board path, gated on attribution as before.
    H.board = boardDoc(cellsWith([0, 1, 2, 3], [4]));
    H.claims = [claim({ status: 'pending', resolvedBy: null })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    H.claims = [claim({ status: 'confirmed' })];
    H.board = boardDoc(cellsWith(ROW0));
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, undefined);
  });

  it('a TUTORIAL-Day confirm posts its plain bingo but NEVER the cruise-wide first_bingo — fired or parked (Codex P1 on #287)', async () => {
    // Day 0 is the embark tutorial (live pre-cruise, trivially easy by design):
    // spec § "Scoring and social surfaces" anchors the headline honor to
    // main-game Days only.
    H.event = {
      days: [{ index: 0, tutorial: true }, { index: 1 }, { index: 2 }],
    } as unknown as Partial<EventDoc>;
    H.rosterConfirmed = false; // would-be-HELD path: the gate must not even park
    H.players = [];
    H.dayBoards = new Map([[0, boardDoc(cellsWith([0, 1, 2, 3], [4]))]]);
    H.claims = [claim({ status: 'pending', resolvedBy: null, dayIndex: 0 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    H.claims = [claim({ status: 'confirmed', dayIndex: 0 })];
    H.dayBoards = new Map([[0, boardDoc(cellsWith(ROW0))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, 0); // the plain beat still posts
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();

    // The roster confirming later must not release a parked tutorial ceremony —
    // nothing was parked.
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('the drain excludes TUTORIAL Days from the prior-win witness read (Codex P1 on #288)', async () => {
    H.event = {
      days: [{ index: 0, tutorial: true }, { index: 1 }, { index: 2 }],
    } as unknown as Partial<EventDoc>;
    H.dayBoards = new Map([[1, boardDoc(cellsWith([0, 1, 2, 3], [4]))]]);
    H.claims = [claim({ status: 'pending', resolvedBy: null, dayIndex: 1 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    H.claims = [claim({ status: 'confirmed', dayIndex: 1 })];
    H.dayBoards = new Map([[1, boardDoc(cellsWith(ROW0))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    // The witness read carries the schedule's tutorial set, so an admin-approved
    // warm-up bingo (which wrote the legacy once-per-Player `${uid}-bingo` doc)
    // can never disqualify the first MAIN-GAME confirm from the ceremony. It
    // also carries the schedule's Day indexes (#372) so this path probes the
    // per-card witness ids exactly as the live Board path does — without them it
    // would see only the legacy doc and could re-mint a decided ceremony.
    expect(H.hasPriorBingoWitness).toHaveBeenCalledWith('u1', {
      excludeDayIndexes: new Set([0]),
      dayIndexes: [0, 1, 2],
    });
    expect(H.broadcastFirstBingo).toHaveBeenCalledWith(ACTOR, 1);
  });

  it('a BATCH crossing bingos on TWO main-game Days posts a bingo PER Day but claims the event singleton ONCE (#372; Codex P2 on #288)', async () => {
    H.dayBoards = new Map([
      [1, boardDoc(cellsWith([0, 1, 2, 3], [4]))],
      [2, boardDoc(cellsWith([0, 1, 2, 3], [4]))],
    ]);
    H.claims = [
      claim({ id: 'c-d1', status: 'pending', resolvedBy: null, dayIndex: 1 }),
      claim({ id: 'c-d2', status: 'pending', resolvedBy: null, dayIndex: 2 }),
    ];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    H.claims = [
      claim({ id: 'c-d1', status: 'confirmed', dayIndex: 1 }),
      claim({ id: 'c-d2', status: 'confirmed', dayIndex: 2 }),
    ];
    H.dayBoards = new Map([
      [1, boardDoc(cellsWith(ROW0))],
      [2, boardDoc(cellsWith(ROW0))],
    ]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // The bingo Moment is PER CARD since #372, so each confirmed Day posts its
    // OWN Moment — both are valid, distinct `${uid}-bingo-d${day}` creates.
    // Pre-#372 this asserted ONE call: correct then (the second targeted the
    // same once-per-Player id and could only churn the cache before the server
    // denied it), and exactly the #372 bug once the ids went per-card.
    expect(H.broadcastBingo).toHaveBeenCalledTimes(2);
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, 1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, 2);
    // …while the event-singleton ceremony still fires exactly ONCE, for the
    // earliest-claimed group (equal createdAt here → day tiebreak). That gate is
    // what stays once-per-Event; only the plain bingo went per-card.
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledWith(ACTOR, 1);
  });

  it('the batch singleton goes to the EARLIEST-claimed win, not the lowest Day (Codex P3 on #288 round 3)', async () => {
    // The Day-3 claim was raised BEFORE the Day-1 claim: its win crossed
    // first, so the event singleton wears Day 3.
    H.event = { days: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }] } as unknown as Partial<EventDoc>;
    H.dayBoards = new Map([
      [1, boardDoc(cellsWith([0, 1, 2, 3], [4]))],
      [3, boardDoc(cellsWith([0, 1, 2, 3], [4]))],
    ]);
    H.claims = [
      claim({ id: 'c-d3', status: 'pending', resolvedBy: null, dayIndex: 3, createdAt: 100 }),
      claim({ id: 'c-d1', status: 'pending', resolvedBy: null, dayIndex: 1, createdAt: 200 }),
    ];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    H.claims = [
      claim({ id: 'c-d3', status: 'confirmed', dayIndex: 3, createdAt: 100 }),
      claim({ id: 'c-d1', status: 'confirmed', dayIndex: 1, createdAt: 200 }),
    ];
    H.dayBoards = new Map([
      [1, boardDoc(cellsWith(ROW0))],
      [3, boardDoc(cellsWith(ROW0))],
    ]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledWith(ACTOR, 3);
  });

  it('a held daily ceremony is VOIDED when the freeze lands before the roster gate opens (Codex P2 on #288 round 3)', async () => {
    H.rosterConfirmed = false;
    H.players = [];
    H.dayBoards = new Map([[1, boardDoc(cellsWith([0, 1, 2, 3], [4]))]]);
    H.claims = [claim({ status: 'pending', resolvedBy: null, dayIndex: 1 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    H.claims = [claim({ status: 'confirmed', dayIndex: 1 })];
    H.dayBoards = new Map([[1, boardDoc(cellsWith(ROW0))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, 1);
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // parked at the roster gate

    // The finale freeze stamps while the candidate is parked; the roster then
    // confirms — the settled headline honor must NOT be rewritten.
    H.event = { days: DAYS, frozenAt: 1 } as unknown as Partial<EventDoc>;
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('a STALE parked ceremony frees the slot for a fresh win arriving in the same snapshot (Codex P2 on #288 round 4)', async () => {
    // Day-1 ceremony parks at the roster gate; its win then FALLS while a
    // Day-2 confirm becomes reflected in the SAME render. The fall-clear must
    // run before the drain so the fresh win can park — the reverse order
    // consumed the Day-2 confirm ceremony-less and later emitted nothing.
    H.rosterConfirmed = false;
    H.players = [];
    H.dayBoards = new Map([[1, boardDoc(cellsWith([0, 1, 2, 3], [4]))]]);
    H.claims = [claim({ id: 'c-d1', status: 'pending', resolvedBy: null, dayIndex: 1 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();
    H.claims = [claim({ id: 'c-d1', status: 'confirmed', dayIndex: 1 })];
    H.dayBoards = new Map([[1, boardDoc(cellsWith(ROW0))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // day-1 parked

    // Same snapshot: day-1's win falls AND day-2's confirm reflects.
    H.claims = [
      claim({ id: 'c-d1', status: 'confirmed', dayIndex: 1 }),
      claim({ id: 'c-d2', status: 'pending', resolvedBy: null, cellIndex: 4, dayIndex: 2 }),
    ];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    H.claims = [
      claim({ id: 'c-d1', status: 'confirmed', dayIndex: 1 }),
      claim({ id: 'c-d2', status: 'confirmed', cellIndex: 4, dayIndex: 2 }),
    ];
    H.dayBoards = new Map([
      [1, boardDoc(cellsWith([0, 1, 2, 3]))], // day-1 win FELL
      [2, boardDoc(cellsWith(ROW0))], // day-2 win reflected
    ]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();

    // Roster confirms: the FRESH (day-2) candidate publishes; the stale day-1
    // one was voided, never fired.
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledWith(ACTOR, 2);
  });

  it('a POST-FREEZE confirm posts its plain bingo but never mints the ceremony (Codex P1 on #287, mirrors the live verdict-time gate)', async () => {
    // The finale freeze has been stamped: a late admin approval of a main-Day
    // claim must not rewrite the settled headline honor.
    H.event = { days: DAYS, frozenAt: 1 } as unknown as Partial<EventDoc>;
    H.dayBoards = new Map([[1, boardDoc(cellsWith([0, 1, 2, 3], [4]))]]);
    H.claims = [claim({ status: 'pending', resolvedBy: null, dayIndex: 1 })];
    const { rerender } = render(<ConfirmWinMoments />);
    await flushAsync();

    H.claims = [claim({ status: 'confirmed', dayIndex: 1 })];
    H.dayBoards = new Map([[1, boardDoc(cellsWith(ROW0))]]);
    rerender(<ConfirmWinMoments />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledWith(ACTOR, 1); // celebrates, day chip intact
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // the headline honor is settled
  });
});
