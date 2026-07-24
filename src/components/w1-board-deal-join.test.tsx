import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { User } from 'firebase/auth';
import type { BoardDoc, EventDoc, ItemDoc, PlayerDoc } from '../types';

// Covers specs/w1-board-deal-join.md: Board render (24 sampled Prompts + the
// always-marked "Complain about Circuit Music" Free Space centre, no re-deal /
// Square-swap — ADR 0003), the Board-side pool<MIN_POOL deal guard (ADR 0004),
// `joinAndDeal` freeze-at-join semantics (deal once; re-joining never
// re-deals; a thin pool never persists a blank Board) plus its join-time
// preference for the saved users/{uid} identity over the raw Google one
// (Codex P2 on PR #67, api half, with validation before denormalizing), and
// gating Board's pool listener to the no-board state (Codex P3 on PR #66).
// The thin-pool guard additionally requires server-confirmed snapshots — the
// ADR 0006 persistent cache can cold-start with an empty cache-only view that
// must not flash the alert (Codex P2, round 4). Deal-failure recovery is
// manual by human decision (PR #66 tiebreak).

// Hoisted so the vi.mock factories (Vitest lifts them above the imports) can
// close over the same mutable fixtures and spies the test bodies drive.
const H = vi.hoisted(() => ({
  authUser: null as User | null,
  useItemsSpy: vi.fn(),
  data: {
    board: null as BoardDoc | null,
    boardLoading: false,
    // hasServerData latches (ADR 0006 persistent cache): true = the sub has
    // seen a server-confirmed snapshot. Defaults to true (the pre-cache
    // assumption existing tests encode); the cold-cache tests flip them false.
    boardServer: true,
    player: null as PlayerDoc | null,
    event: null as EventDoc | null,
    items: [] as ItemDoc[],
    poolLoading: false,
    poolServer: true,
  },
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  runTransaction: vi.fn(),
  txGet: vi.fn(),
  txSet: vi.fn(),
  batchSet: vi.fn(),
  batchCommit: vi.fn(async () => {}),
}));

// Neutralize Firebase init (firebase.ts calls initializeApp at import) and the
// Firestore SDK so `../data/api` (real) exercises its freeze/deal logic against
// controllable stubs rather than a live backend.
vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));

vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref; // paths.ts chains .withConverter on refs
    return ref;
  };
  return {
    doc: (...args: unknown[]) => makeRef('doc', args),
    collection: (...args: unknown[]) => makeRef('collection', args),
    query: (...args: unknown[]) => ({ query: args }),
    where: (...args: unknown[]) => ({ where: args }),
    getDoc: H.getDoc,
    getDocFromCache: vi.fn(),
    getDocs: H.getDocs,
    writeBatch: () => ({ set: H.batchSet, commit: H.batchCommit }),
    addDoc: vi.fn(),
    increment: vi.fn(),
    runTransaction: H.runTransaction,
    setDoc: vi.fn(),
    updateDoc: vi.fn(),
    deleteDoc: vi.fn(),
    onSnapshot: vi.fn(),
    serverTimestamp: vi.fn(),
    getFirestore: vi.fn(),
  };
});

vi.mock('../analytics', () => ({ track: vi.fn() }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: H.authUser, loading: false, signIn: vi.fn(), signOutUser: vi.fn() }),
}));

// Inject the live data through the hooks so the render tests drive a real
// dealt Board (and the guard's thin-pool path) without a Firestore listener.
// useItems is spied so tests can assert Board threads the `enabled` flag
// (Codex P3: gate the pool listener once a Board exists) without exercising
// the real onSnapshot subscription — that gate is proven directly against the
// real hook in src/hooks/useData.test.ts.
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useBoard: () => ({
    data: H.data.board,
    loading: H.data.boardLoading,
    hasServerData: H.data.boardServer,
  }),
  // Daily-cards day-scoped Board (#246). These fixtures are legacy (no `days[]`),
  // so Board reads `useBoard` above and this stays inert; the factory must still
  // export it so Board's module resolves.
  useDayBoard: () => ({ data: null, loading: false, hasServerData: true }),
  useMyPlayer: () => ({ data: H.data.player, loading: false, hasServerData: true }),
  // Board reads the saved users/{uid} profile to attribute the Tally marker (#31);
  // a null profile falls back to the auth name, which these fixtures don't assert.
  useMyUser: () => ({ data: null, loading: false, hasServerData: true }),
  useEventDoc: () => ({ data: H.data.event, loading: false }),
  useItems: (enabled?: boolean) => {
    H.useItemsSpy(enabled);
    return { items: H.data.items, loading: H.data.poolLoading, hasServerData: H.data.poolServer };
  },
  // The per-Prompt Tally count badge (#31) only mounts on marked, non-free
  // Squares — a freshly dealt card has none, so useTally is not exercised here,
  // but the mock must export it so Board's module resolves.
  useTally: () => ({ markers: [], count: 0, loading: false, hasServerData: true }),
  // Board reads the roster for the First-to-BINGO Moment (#34); no fixture here
  // crosses a bingo edge, so an empty roster suffices.
  useLeaderboard: () => ({ players: [], loading: false }),
  // Board subscribes the per-Square Doubt count + the Feed's Proofs (#33). These
  // deal/join fixtures render only the empty/thin-pool/dealt states with no marked
  // Square, so no DoubtBadge mounts; the factory must still export both.
  useDoubts: () => ({ doubts: [], count: 0, loading: false, hasServerData: true }),
  // Board reads its viewer-scoped own Proofs for the DoubtBadge (#106 finding 4);
  // these deal/join states have no marked Square, so none mounts.
  useMyProofs: () => ({ proofs: [], loading: false, hasServerData: true }),
  useProofsForItemText: () => ({ proofs: [], loading: false, hasServerData: true }),
}));
// CoachOverlay (#214) mounts unconditionally with cells, adding its own CTA
// button — off-topic here (re-deal-affordance assertions), so stub it out.
// Board also reads CoachOverlay's `isCoachOverlayDismissed` export to queue
// LaunchIntro behind it (#378), so the stub must carry that named export — a
// `default`-only mock makes Vitest throw on the missing export.
vi.mock('./CoachOverlay', () => ({ default: () => null, isCoachOverlayDismissed: () => true }));
vi.mock('./LaunchIntro', () => ({ default: () => null }));

// Real modules under test — imported after the mocks are declared.
import Board from './Board';
import { ensureUserProfile, joinAndDeal } from '../data/api';
import { dealBoard, MIN_POOL, CENTER, type DealItem } from '../game/logic';
import { FREE_TEXT, SEED_ITEMS } from '../data/seed';

const SIGNED_IN = { uid: 'sailor-1', displayName: 'Sailor', photoURL: null } as unknown as User;
// joinAndDeal (#246) reads the Event FIRST to pick its mode: a `days[]` schedule ⇒
// day-scoped daily mode (no legacy board), else the pre-1.5 single-board deal these
// legacy tests exercise. A doc that exists with NO `days` selects the legacy path,
// so it leads every sequenced getDoc mock below (event → board → profile). The
// same read supplies threshold/spicyRatio/bannedUids, so those move onto it too.
const EVENT_LEGACY = { exists: () => true, data: () => ({}) };
const SIGNED_IN_WITH_PHOTO = {
  uid: 'sailor-1',
  displayName: 'Sailor',
  photoURL: 'https://lh3.example/google.jpg',
} as unknown as User;

function mkItem(id: string, isFreeSpace = false): ItemDoc {
  return {
    id,
    text: isFreeSpace ? FREE_TEXT : `prompt ${id}`,
    createdBy: 'seed',
    createdAt: 0,
    isFreeSpace,
    status: 'active',
    reportCount: 0,
    spicy: false,
    pool: 'main',
  };
}

const activeItems = (n: number): ItemDoc[] => Array.from({ length: n }, (_, i) => mkItem(`a${i}`));

const dealPool: DealItem[] = SEED_ITEMS.map((it, i) => ({ id: `seed${i}`, text: it.text, spicy: it.spicy }));

beforeEach(() => {
  H.authUser = SIGNED_IN;
  H.useItemsSpy.mockReset();
  H.data.board = null;
  H.data.boardLoading = false;
  H.data.player = null;
  H.data.event = null;
  H.data.items = [];
  H.data.poolLoading = false;
  H.data.boardServer = true;
  H.data.poolServer = true;
  H.getDoc.mockReset();
  // Default doc reads: no Board yet, no saved users/{uid} profile. Tests that
  // need an existing Board or a saved profile queue overrides with
  // mockResolvedValueOnce in joinAndDeal's read order (board, then profile).
  H.getDoc.mockResolvedValue({ exists: () => false });
  H.getDocs.mockReset();
  H.runTransaction.mockReset();
  H.runTransaction.mockImplementation(async (_db, fn) => fn({ get: H.txGet, set: H.txSet }));
  H.txGet.mockReset();
  // Default transactional read: nothing exists yet. joinAndDeal (#409) re-reads
  // the board (legacy) / player row (daily) INSIDE its transaction; tests that
  // need an existing doc override with mockResolvedValueOnce.
  H.txGet.mockResolvedValue({ exists: () => false });
  H.txSet.mockReset();
  H.batchSet.mockReset();
  H.batchCommit.mockReset();
  H.batchCommit.mockResolvedValue(undefined);
});

describe('ensureUserProfile', () => {
  it('creates the first users/{uid} document inside a transaction', async () => {
    H.txGet.mockResolvedValue({ exists: () => false });

    await ensureUserProfile(SIGNED_IN_WITH_PHOTO);

    expect(H.runTransaction).toHaveBeenCalledWith({}, expect.any(Function));
    expect(H.txSet).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'doc' }),
      expect.objectContaining({
        displayName: 'Sailor',
        photoURL: 'https://lh3.example/google.jpg',
      }),
    );
  });

  it('does not rewrite an existing users/{uid} document', async () => {
    H.txGet.mockResolvedValue({ exists: () => true });

    await ensureUserProfile(SIGNED_IN_WITH_PHOTO);

    expect(H.txSet).not.toHaveBeenCalled();
  });
});

describe('Board render', () => {
  it('renders 25 Squares with the Free Space centre marked and reading the seeded FREE_TEXT', () => {
    const cells = dealBoard(dealPool, FREE_TEXT, 20260707);
    H.data.board = { uid: SIGNED_IN.uid, dayIndex: 0, seed: 20260707, createdAt: 0, cells };

    const { container } = render(<Board />);

    expect(container.querySelectorAll('.cell')).toHaveLength(25);
    const free = container.querySelectorAll('.cell.free');
    expect(free).toHaveLength(1); // exactly one Free Space
    expect(container.querySelectorAll('.grid .cell')[CENTER]).toHaveClass('free');
    // The prompt remains the cell's accessible name, while a separate visual
    // eyebrow makes the special center square immediately identifiable.
    expect(free[0]).toHaveAccessibleName(FREE_TEXT);
    expect(free[0].querySelector('.free-label')).toHaveTextContent('FREE');
    expect(free[0].querySelector('.free-prompt')).toHaveTextContent(FREE_TEXT);
    expect(free[0]).toHaveClass('marked'); // the centre is always marked
  });

  it('acknowledges a Free Space click without unmarking the permanent centre', () => {
    const cells = dealBoard(dealPool, FREE_TEXT, 20260707);
    H.data.board = { uid: SIGNED_IN.uid, dayIndex: 0, seed: 20260707, createdAt: 0, cells };

    render(<Board />);

    const free = screen.getByRole('button', { name: FREE_TEXT });
    fireEvent.click(free);
    expect(free).toHaveClass('free-pulse-a', 'marked');
    fireEvent.animationEnd(free);
    expect(free).not.toHaveClass('free-pulse-a', 'free-pulse-b');
    fireEvent.click(free);
    expect(free).toHaveClass('free-pulse-a', 'marked');
  });

  it('exposes no re-deal / Square-swap affordance (ADR 0003)', () => {
    const cells = dealBoard(dealPool, FREE_TEXT, 11);
    H.data.board = { uid: SIGNED_IN.uid, dayIndex: 0, seed: 11, createdAt: 0, cells };

    render(<Board />);

    const reDeal = /re-?deal|deal again|shuffle|swap|redraw|re-?roll|new card|regenerate/i;
    expect(screen.queryByRole('button', { name: reDeal })).toBeNull();
    expect(screen.queryByText(reDeal)).toBeNull();
    // A freshly dealt card exposes only the permanent Free Space feedback control
    // — no proof buttons, and certainly no re-deal button. The former 18+ ·
    // Guidelines pill in the Board footer (#143) relocated to the More menu as
    // `AcceptableUse variant="row"` (#208, specs/d15-more-menu.md) — Board no
    // longer mounts it, so it's no longer app chrome sharing this surface.
    expect(screen.queryAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: FREE_TEXT })).toBeInTheDocument();
  });
});

describe('Board deal guard (ADR 0004)', () => {
  it('surfaces the guard, not a blank card, when the active pool is < MIN_POOL', () => {
    H.data.board = null;
    H.data.items = activeItems(MIN_POOL - 1); // 23 — one short
    H.data.poolLoading = false;

    render(<Board />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/not enough prompts/i);
    expect(alert).toHaveTextContent(String(MIN_POOL));
    expect(screen.queryByText(/dealing your card/i)).toBeNull();
  });

  it('excludes the Free Space item when counting the pool against MIN_POOL', () => {
    H.data.board = null;
    // 23 real Prompts + a Free Space item = 24 items, but only 23 count toward
    // the deal floor, so the guard must still fire.
    H.data.items = [...activeItems(MIN_POOL - 1), mkItem('free', true)];
    H.data.poolLoading = false;

    render(<Board />);

    expect(screen.getByRole('alert')).toHaveTextContent(/not enough prompts/i);
  });

  it('suppresses the guard while the board is still loading (returning player, thin pool)', () => {
    // A returning Player who already has a dealt board, fetched while the pool
    // has since gone < MIN_POOL: the board load must win over the thin-pool
    // guard so the guard never flashes before the board resolves.
    H.data.board = null;
    H.data.boardLoading = true;
    H.data.items = activeItems(MIN_POOL - 1);
    H.data.poolLoading = false;

    render(<Board />);

    expect(screen.getByText(/dealing your card/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the neutral dealing state (no guard) while the pool is loading', () => {
    H.data.board = null;
    H.data.items = [];
    H.data.poolLoading = true; // count unknown — must not false-positive the guard

    render(<Board />);

    expect(screen.getByText(/dealing your card/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the neutral dealing state (no guard) for a healthy pool mid-deal', () => {
    H.data.board = null;
    H.data.items = activeItems(MIN_POOL + 6); // healthy — a deal is simply in flight
    H.data.poolLoading = false;

    render(<Board />);

    expect(screen.getByText(/dealing your card/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('suppresses the guard over a cache-only cold start, then fires once the server confirms a thin pool', () => {
    // ADR 0006 persistent cache (Codex P2, round 4): on a new device or a
    // cleared IndexedDB, both listeners can resolve FROM CACHE with board=null
    // and items=[] — loading is false, but nothing is server truth yet. The
    // "0 prompts" alert must not flash in that window.
    H.data.board = null;
    H.data.items = []; // cache-only cold start: empty pool snapshot
    H.data.boardLoading = false;
    H.data.poolLoading = false;
    H.data.boardServer = false;
    H.data.poolServer = false;

    const { rerender } = render(<Board />);
    expect(screen.getByText(/dealing your card/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    // The server confirms: still no board, and the pool is GENUINELY thin —
    // only now may the guard alert.
    H.data.items = activeItems(MIN_POOL - 1);
    H.data.boardServer = true;
    H.data.poolServer = true;
    rerender(<Board />);
    expect(screen.getByRole('alert')).toHaveTextContent(/not enough prompts/i);
  });

  it('renders the board, never the guard, when the server snapshot delivers a board after a cache-only start', () => {
    // Returning player whose board was not cached: the cache phase must stay
    // neutral, and the server phase mounts the real card.
    H.data.board = null;
    H.data.items = [];
    H.data.boardServer = false;
    H.data.poolServer = false;

    const { rerender, container } = render(<Board />);
    expect(screen.queryByRole('alert')).toBeNull();

    const cells = dealBoard(dealPool, FREE_TEXT, 20260707);
    H.data.board = { uid: SIGNED_IN.uid, dayIndex: 0, seed: 20260707, createdAt: 0, cells };
    H.data.boardServer = true;
    rerender(<Board />);

    expect(container.querySelectorAll('.cell')).toHaveLength(25);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// The pool-recovery auto-retry watcher and its tests were removed by human
// decision (PR #66 tiebreak): recovery is manual — the Retry button plus the
// reachable /items Prompts tab. A context-level auto-retry is a tracked
// follow-up, not review accretion on this ticket.

describe('Board pool-listener gate (Codex P3)', () => {
  it('keeps the pool subscription enabled while there is no Board yet', () => {
    H.data.board = null;
    H.data.items = activeItems(MIN_POOL + 3);

    render(<Board />);

    expect(H.useItemsSpy).toHaveBeenCalledWith(true);
  });

  it('opens no pool listener once a Player has a frozen Board', () => {
    const cells = dealBoard(dealPool, FREE_TEXT, 20260707);
    H.data.board = { uid: SIGNED_IN.uid, dayIndex: 0, seed: 20260707, createdAt: 0, cells };

    render(<Board />);

    expect(H.useItemsSpy).toHaveBeenCalledWith(false);
  });
});

describe('joinAndDeal freeze-at-join', () => {
  it('does not re-deal when a Board already exists for the uid', async () => {
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => true }); // Board already exists

    await joinAndDeal(SIGNED_IN);

    expect(H.getDoc).toHaveBeenCalledTimes(2); // event (mode) + board check — no profile read for returning Players
    expect(H.getDocs).not.toHaveBeenCalled(); // never reads the pool
    expect(H.txSet).not.toHaveBeenCalled(); // never re-writes the Board
    expect(H.runTransaction).not.toHaveBeenCalled();
  });

  it('legacy: the transaction RE-CHECKS board existence — a board that appears after the fast-path probe is not re-dealt (#409)', async () => {
    // The timed-out-deal + Retry window: attempt A commits its board AFTER
    // attempt B's plain fast-path probe read "no board". B's transaction must
    // re-read and no-op instead of double-committing (re-stamping joinedAt).
    H.getDocs.mockResolvedValueOnce({
      docs: [...activeItems(30), mkItem('free', true)].map((it) => ({ data: () => it })),
    });
    H.txGet.mockResolvedValueOnce({ exists: () => true }); // the txn's authoritative read: A's board landed

    await expect(joinAndDeal(SIGNED_IN)).resolves.toBe(false); // not an actual join — no duplicate join_event

    expect(H.runTransaction).toHaveBeenCalledTimes(1);
    expect(H.txSet).not.toHaveBeenCalled(); // neither board nor player re-written
  });

  it('daily: alreadyJoined derives from the row read INSIDE the transaction, and the guards degrade to an identity-only merge (#409)', async () => {
    H.getDoc.mockReset();
    H.getDoc.mockResolvedValue({ exists: () => false }); // saved profile: none
    H.getDoc.mockResolvedValueOnce({ exists: () => true, data: () => ({ days: [{ index: 0 }] }) }); // mode: daily
    // The transactional row read sees a join committed by the overlapping
    // attempt — including a spent reshuffle the stale-read code would have
    // rewound to 0 (a write firestore.rules' monotonic counter DENIES).
    H.txGet.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({
        uid: 'sailor-1',
        joinedAt: 111,
        bingoCount: 3,
        squaresMarked: 9,
        firstBingoAt: 222,
        blackout: false,
        reshufflesUsed: 2,
      }),
    });

    await expect(joinAndDeal(SIGNED_IN)).resolves.toBe(false); // the join already happened

    const seed = H.txSet.mock.calls[0][1] as Record<string, unknown>;
    expect(seed).toMatchObject({ uid: 'sailor-1', displayName: 'Sailor' }); // identity still merged
    expect(seed).not.toHaveProperty('joinedAt'); // no re-stamp
    expect(seed).not.toHaveProperty('reshufflesUsed'); // no rules-denied rewind
    expect(seed).not.toHaveProperty('bingoCount'); // aggregates untouched
  });

  it('deals once from the active non-free pool (24 Prompts + marked Free Space)', async () => {
    const docs = [...activeItems(30), mkItem('free', true)].map((it) => ({ data: () => it }));
    H.getDocs.mockResolvedValueOnce({ docs });

    await joinAndDeal(SIGNED_IN);

    expect(H.getDocs).toHaveBeenCalledTimes(1);
    expect(H.runTransaction).toHaveBeenCalledTimes(1);
    const boardWrite = H.txSet.mock.calls[0][1] as BoardDoc;
    expect(boardWrite.cells).toHaveLength(25);
    expect(boardWrite.cells[CENTER]).toMatchObject({ free: true, marked: true, text: FREE_TEXT });
    const dealtIds = boardWrite.cells.filter((c) => !c.free).map((c) => c.itemId);
    expect(dealtIds).toHaveLength(24);
    expect(dealtIds).not.toContain('free'); // the Free Space item is never sampled
  });

  it('deals only from the main pool; embark/farewell tutorial prompts never land on the card', async () => {
    const docs = [
      ...activeItems(24),
      { ...mkItem('embark-1'), pool: 'embark' as const },
      { ...mkItem('farewell-1'), pool: 'farewell' as const },
    ].map((it) => ({ data: () => it }));
    H.getDocs.mockResolvedValueOnce({ docs });

    await joinAndDeal(SIGNED_IN);

    const boardWrite = H.txSet.mock.calls[0][1] as BoardDoc;
    const dealtIds = boardWrite.cells.filter((c) => !c.free).map((c) => c.itemId);
    expect(dealtIds).toHaveLength(24);
    expect(dealtIds).not.toContain('embark-1');
    expect(dealtIds).not.toContain('farewell-1');
  });

  it('propagates the pool<MIN_POOL guard and never persists a blank Board', async () => {
    const docs = activeItems(MIN_POOL - 1).map((it) => ({ data: () => it }));
    H.getDocs.mockResolvedValueOnce({ docs });

    await expect(joinAndDeal(SIGNED_IN)).rejects.toThrow(/at least 24 prompts/);
    expect(H.runTransaction).not.toHaveBeenCalled(); // no broken Board written
  });
});

describe('joinAndDeal community auto-hide at the deal path (specs/w2-admin-console.md, Codex P2 PR #107 finding 1)', () => {
  // joinAndDeal reads the event doc FIRST (the mode decision, #246: event, board,
  // profile) for reportHideThreshold and drops community-hidden Prompts from the deal pool,
  // the SAME predicate useItems applies to the live pool — a new Player's frozen
  // card must not contain a Prompt that is hidden everywhere else.
  const eventThreshold = (threshold: number) => ({
    exists: () => true,
    data: () => ({ settings: { reportHideThreshold: threshold } }),
  });

  it('excludes at/over-threshold Prompts so a frozen card never holds community-hidden content', async () => {
    // 24 clean Prompts + 2 heavily-reported ones (9 over, 4 AT the threshold of 4):
    // both hidden Prompts must be dropped, leaving exactly the 24 clean ones.
    const clean = activeItems(24); // reportCount 0
    const hidden = [
      { ...mkItem('hot-1'), reportCount: 9 }, // over → hidden
      { ...mkItem('hot-2'), reportCount: 4 }, // AT → hidden
    ];
    const docs = [...clean, ...hidden].map((it) => ({ data: () => it }));
    H.getDoc
      .mockResolvedValueOnce(eventThreshold(4)) // event doc → mode (legacy) + threshold 4
      .mockResolvedValueOnce({ exists: () => false }) // no Board yet
      .mockResolvedValueOnce({ exists: () => false }); // no saved profile
    H.getDocs.mockResolvedValueOnce({ docs });

    await joinAndDeal(SIGNED_IN);

    const boardWrite = H.txSet.mock.calls[0][1] as BoardDoc;
    const dealtIds = boardWrite.cells.filter((c) => !c.free).map((c) => c.itemId);
    expect(dealtIds).toHaveLength(24);
    expect(dealtIds).not.toContain('hot-1');
    expect(dealtIds).not.toContain('hot-2');
  });

  it('counts only the community-visible pool against MIN_POOL — reported Prompts do not pad the deal floor', async () => {
    // 23 clean + 5 reported = 28 active rows, but only 23 are community-visible, so
    // the deal must throw exactly like a 23-Prompt pool: the filtered count drives
    // the guard, so a card never deals with squares that hide the moment it renders.
    const clean = activeItems(MIN_POOL - 1); // 23, reportCount 0
    const hidden = Array.from({ length: 5 }, (_, i) => ({ ...mkItem(`hot-${i}`), reportCount: 9 }));
    const docs = [...clean, ...hidden].map((it) => ({ data: () => it }));
    H.getDoc
      .mockResolvedValueOnce(eventThreshold(4))
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({ exists: () => false });
    H.getDocs.mockResolvedValueOnce({ docs });

    await expect(joinAndDeal(SIGNED_IN)).rejects.toThrow(/at least 24 prompts/);
    expect(H.runTransaction).not.toHaveBeenCalled(); // no card dealt from a thin visible pool
  });

  it('with a NON-POSITIVE threshold, deals the full pool — a 0 typo does not empty the board (finding 2)', async () => {
    // Threshold 0 must not hide everything: all 24 Prompts (each reportCount 3)
    // still deal, because a non-positive threshold is inactive.
    const docs = activeItems(24).map((it) => ({ data: () => ({ ...it, reportCount: 3 }) }));
    H.getDoc
      .mockResolvedValueOnce(eventThreshold(0)) // non-positive → inactive
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({ exists: () => false });
    H.getDocs.mockResolvedValueOnce({ docs });

    await joinAndDeal(SIGNED_IN);

    const boardWrite = H.txSet.mock.calls[0][1] as BoardDoc;
    expect(boardWrite.cells.filter((c) => !c.free)).toHaveLength(24); // full deal
    expect(H.runTransaction).toHaveBeenCalledTimes(1);
  });

  it('falls open on a MISSING threshold — a readable event with no settings deals unfiltered', async () => {
    // A readable event doc with no `settings.reportHideThreshold` must fall open to
    // no filtering (not block the deal), exactly like a missing profile falls back
    // to the auth identity. EVENT_LEGACY is readable + has no days → legacy mode.
    const docs = activeItems(24).map((it) => ({ data: () => ({ ...it, reportCount: 50 }) }));
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // readable, no threshold → falls open, legacy mode
      .mockResolvedValueOnce({ exists: () => false }) // no Board yet
      .mockResolvedValueOnce({ exists: () => false }); // no saved profile
    H.getDocs.mockResolvedValueOnce({ docs });

    await joinAndDeal(SIGNED_IN);

    const boardWrite = H.txSet.mock.calls[0][1] as BoardDoc;
    expect(boardWrite.cells.filter((c) => !c.free)).toHaveLength(24); // still deals
    expect(H.runTransaction).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED when the event-mode read errors — never guesses legacy (CodeRabbit #247)', async () => {
    // A genuine event-read failure must propagate (retryable dealError), not be
    // guessed as legacy mode — guessing legacy would misroute a real daily event to
    // the day-scoped-rules-denied legacy board. The read is the FIRST getDoc.
    H.getDoc.mockRejectedValueOnce(new Error('offline'));

    await expect(joinAndDeal(SIGNED_IN)).rejects.toThrow(/offline/);
    expect(H.runTransaction).not.toHaveBeenCalled(); // no board/player written on a mode-read failure
  });
});

describe('joinAndDeal Player-row attribution (Codex P2 on PR #67, api half)', () => {
  // joinAndDeal denormalizes an identity into the public players/{uid} row.
  // It must prefer the Player's SAVED users/{uid} profile — read order in
  // joinAndDeal is board doc first, then profile — so a custom name/avatar is
  // never overwritten by the raw Google identity at join.
  const healthyPoolDocs = () => ({
    docs: activeItems(30).map((it) => ({ data: () => it })),
  });
  const playerWrite = () => H.txSet.mock.calls[1][1] as PlayerDoc;

  it('prefers the saved profile name and custom avatar over the Google identity', async () => {
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false }) // no Board yet
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          displayName: 'Deck Daddy',
          photoURL: 'https://cdn.example/custom.jpg',
          customPhoto: true,
          createdAt: 0,
        }),
      });
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN_WITH_PHOTO);

    expect(playerWrite()).toMatchObject({
      displayName: 'Deck Daddy', // saved name, not the Google "Sailor"
      photoURL: 'https://cdn.example/custom.jpg', // custom avatar wins
    });
  });

  it('keeps the live Google photo when the saved profile has no custom avatar', async () => {
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false }) // no Board yet
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          displayName: 'Deck Daddy',
          photoURL: 'https://stale.example/copied-at-first-signin.jpg',
          createdAt: 0, // no customPhoto flag — profile photo is a stale copy
        }),
      });
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN_WITH_PHOTO);

    expect(playerWrite()).toMatchObject({
      displayName: 'Deck Daddy',
      photoURL: 'https://lh3.example/google.jpg', // live auth photo, not the stale copy
    });
  });

  it('ignores a malformed saved profile: non-string or over-cap names never reach the public row', async () => {
    // users/{uid} is self-writable, so the saved fields must be validated
    // before denormalizing (Codex P2, PR #66 round 3). A non-string
    // displayName falls back to the auth name; same for a >100-char one.
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false }) // no Board yet
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ displayName: 12345, photoURL: 777, customPhoto: true, createdAt: 0 }),
      });
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN_WITH_PHOTO);

    expect(playerWrite()).toMatchObject({
      displayName: 'Sailor', // auth fallback — the numeric junk never flows through
      photoURL: 'https://lh3.example/google.jpg', // non-string saved photo ignored
    });
  });

  it('ignores a saved name longer than the 100-char cap', async () => {
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ displayName: 'x'.repeat(101), createdAt: 0 }),
      });
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN);

    expect(playerWrite()).toMatchObject({ displayName: 'Sailor' });
  });

  it('ignores an empty / whitespace-only saved name', async () => {
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ displayName: '   ', createdAt: 0 }),
      });
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN);

    expect(playerWrite()).toMatchObject({ displayName: 'Sailor' });
  });

  it('rejects a custom photo that is not an https URL (scheme downgrade)', async () => {
    // The photo guard requires the https URL *shape*, not just a string —
    // an http:// (or javascript:/data:) value saved into the self-writable
    // profile must not be denormalized into the public row.
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          displayName: 'Deck Daddy',
          photoURL: 'http://cdn.example/custom.jpg', // string, but not https
          customPhoto: true,
          createdAt: 0,
        }),
      });
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN_WITH_PHOTO);

    expect(playerWrite()).toMatchObject({
      displayName: 'Deck Daddy', // per-field: the valid name still wins
      photoURL: 'https://lh3.example/google.jpg', // auth fallback for the photo
    });
  });

  it('rejects a custom photo that does not parse as a URL at all', async () => {
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ photoURL: 'not a url', customPhoto: true, createdAt: 0 }),
      });
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN_WITH_PHOTO);

    expect(playerWrite()).toMatchObject({ photoURL: 'https://lh3.example/google.jpg' });
  });

  it("ignores a truthy-junk customPhoto (the string 'false') — the flag must be exactly true", async () => {
    // users/{uid} is unvalidated, so customPhoto can hold any type (round 4,
    // Codex P3). A truthy non-boolean must not publish the saved photo.
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          photoURL: 'https://stale.example/copied.jpg', // valid https, but not opted in
          customPhoto: 'false',
          createdAt: 0,
        }),
      });
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN_WITH_PHOTO);

    expect(playerWrite()).toMatchObject({ photoURL: 'https://lh3.example/google.jpg' });
  });

  it('ignores a numeric customPhoto (1) — the flag must be exactly true', async () => {
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          photoURL: 'https://stale.example/copied.jpg',
          customPhoto: 1,
          createdAt: 0,
        }),
      });
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN_WITH_PHOTO);

    expect(playerWrite()).toMatchObject({ photoURL: 'https://lh3.example/google.jpg' });
  });

  it('falls back to the auth identity when no users/{uid} profile exists', async () => {
    // beforeEach default: board missing AND profile missing.
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN);

    expect(playerWrite()).toMatchObject({ displayName: 'Sailor', photoURL: null });
  });

  it('falls back to the auth identity when the profile read fails outright', async () => {
    H.getDoc
      .mockResolvedValueOnce(EVENT_LEGACY) // mode decision → legacy single-board
      .mockResolvedValueOnce({ exists: () => false }) // no Board yet
      .mockRejectedValueOnce(new Error('offline')); // profile read fails — must not block the deal
    H.getDocs.mockResolvedValueOnce(healthyPoolDocs());

    await joinAndDeal(SIGNED_IN_WITH_PHOTO);

    expect(H.runTransaction).toHaveBeenCalledTimes(1); // the deal still lands
    expect(playerWrite()).toMatchObject({
      displayName: 'Sailor',
      photoURL: 'https://lh3.example/google.jpg',
    });
  });
});
