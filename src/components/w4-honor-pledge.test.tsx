import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoardDoc, Cell, EventDoc, PlayerDoc } from '../types';

// specs/w4-honor-pledge.md (issue #181), RTL-jsdom. EVERY claim tap opens the
// ProofSheet — honor included, which used to mark instantly — and honor mode
// gets the one-tap 🎖️ Cross My Heart pledge inside it: the same bare setMark
// the honor tap always made (no Proof doc, no Feed entry, offline-durable per
// ADR 0006), so a Proof stays flavour, never enforcement (ADR 0001). Stricter
// modes render the pledge DISABLED (a teaser, not a path); a proof-add open
// (the ＋ on an already-marked Square) hides the row entirely. setMark and
// attachProof are stubbed: the flow is under test, not the writes.

const H = vi.hoisted(() => ({
  user: { uid: 'u1', displayName: 'Deck Daddy', photoURL: null } as {
    uid: string;
    displayName: string | null;
    photoURL: string | null;
  },
  board: null as BoardDoc | null,
  player: null as PlayerDoc | null,
  event: null as EventDoc | null,
  setMark: vi.fn(),
  attachProof: vi.fn(),
  track: vi.fn(),
}));

vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useBoard: () => ({ data: H.board, loading: false, hasServerData: true }),
  useDayBoard: () => ({ data: H.board, loading: false, hasServerData: true }),
  useMyPlayer: () => ({ data: H.player, loading: false, hasServerData: true }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  useItems: () => ({ items: [], loading: false, hasServerData: true }),
  useTally: () => ({ markers: [], count: 0, loading: false, hasServerData: true }),
  useLeaderboard: () => ({ players: [], loading: false }),
  useDoubts: () => ({ doubts: [], count: 0, loading: false, hasServerData: true }),
  useMyProofs: () => ({ proofs: [], loading: false, hasServerData: true }),
  useProofsForItemText: () => ({ proofs: [], loading: false, hasServerData: true }),
}));
// The Moment machinery is inert here (no test crosses a win edge); stubbing the
// module also keeps the prod ../firebase singleton out of this suite — the same
// isolation w2-proof-capture.test.tsx documents.
vi.mock('../data/moments', () => ({
  // #267: the per-card blackout queue reads — inert stubs (empty queue).
  pendingBlackoutDayIndexes: vi.fn(() => []),
  pendingBingoDayIndex: vi.fn(() => undefined),
  pendingFirstBingoDayIndex: vi.fn(() => undefined),
  removePendingBlackoutDay: vi.fn(),
  broadcastBingo: vi.fn(),
  broadcastBlackout: vi.fn(),
  broadcastFirstBingo: vi.fn(),
  hasPriorBingoWitness: vi.fn(() => Promise.resolve(false)),
  enqueueWinMoments: vi.fn(),
  enqueueFirstBingoMoment: vi.fn(),
  peekPendingMoments: vi.fn(() => ({ bingo: false, blackout: false, firstBingo: false })),
  clearPendingMoment: vi.fn(),
  dropPendingWins: vi.fn(),
  enqueueRetraction: vi.fn(),
  drainRetractions: vi.fn(),
  pendingActionGeneration: vi.fn(() => 0),
  firstBingoCandidateCurrent: vi.fn(() => false),
}));
vi.mock('../data/doubts', () => ({
  raiseDoubt: vi.fn(),
  openDoubts: () => [],
  doubtStatusFor: () => 'none',
}));
vi.mock('../data/api', () => ({
  // Reshuffle (#378): Board reads the allowance for the day-bar chip and
  // ReshuffleSheet imports the write; stubbed so the imports resolve. The chip's
  // own behaviour is proven in src/components/reshuffle-chip.test.tsx.
  RESHUFFLE_ALLOWANCE: 3,
  reshuffleBoard: vi.fn(async () => 1),
  setMark: H.setMark,
  dealDayCard: vi.fn(() => Promise.resolve(false)),
  resolveDisplayName: (
    profile: { displayName?: unknown } | null | undefined,
    fallback: string | null | undefined,
  ) =>
    typeof profile?.displayName === 'string' && profile.displayName.trim().length > 0
      ? profile.displayName
      : (fallback ?? 'Anonymous'),
}));
vi.mock('../data/proofs', () => ({ attachProof: H.attachProof }));
vi.mock('../analytics', () => ({ track: H.track }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: H.user, loading: false, signIn: vi.fn(), signOutUser: vi.fn() }),
}));
// CoachOverlay (#214) imports EVENT_ID from '../firebase' — mocked so
// mounting Board here never touches the real Firebase app init.
vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));

import Board from './Board';

// A dealt board: every non-free Square unmarked, the free centre (12) "on".
// `pool` prefixes the Prompt ids/texts so two accounts' boards genuinely differ
// (a real deal draws each card independently from the pool).
function dealt(pool = 'i'): Cell[] {
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `${pool}${index}`,
    text: index === 12 ? 'FREE' : `Prompt ${pool}${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
}

const PLEDGE = /cross my heart/i;

const clickCell = (index: number) => {
  fireEvent.click(document.querySelectorAll('.grid .cell')[index]);
};

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null };
  H.event = { claimMode: 'honor' } as EventDoc;
  H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
  H.player = null;
  H.setMark.mockResolvedValue({ cells: [], bingo: false, blackout: false });
  H.attachProof.mockResolvedValue(undefined);
});

describe('honor mode — the claim opens the sheet; the pledge IS the claim', () => {
  it('tapping an unmarked Square opens the sheet without marking; the pledge marks in one tap and closes it', async () => {
    const user = userEvent.setup();
    render(<Board />);
    clickCell(0);

    expect(await screen.findByText(/proof for/i)).toBeInTheDocument();
    expect(H.setMark).not.toHaveBeenCalled();

    const pledge = screen.getByRole('button', { name: PLEDGE });
    expect(pledge).toBeEnabled();
    await user.click(pledge);

    await waitFor(() => expect(H.setMark).toHaveBeenCalledTimes(1));
    expect(H.setMark.mock.calls[0][0]).toMatchObject({
      index: 0,
      nextMarked: true,
      claimMode: 'honor',
    });
    // A pledge writes NO Proof doc — no Feed entry, no Doubt satisfaction.
    expect(H.attachProof).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/proof for/i)).toBeNull());
    // #721: the pledge is the 'pledge' source of mark_square, never conflated
    // with a bare boolean — marked: true is explicit and source pins the mode.
    expect(H.track).toHaveBeenCalledWith('mark_square', {
      source: 'pledge',
      mode: 'honor',
      marked: true,
    });
  });

  it('Cancel leaves the Square unmarked; unmarking a marked Square stays instant with no sheet', async () => {
    const user = userEvent.setup();
    const cells = dealt();
    cells[1] = { ...cells[1], marked: true, markedAt: 1, status: 'confirmed' };
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells };
    render(<Board />);

    clickCell(0);
    await screen.findByText(/proof for/i);
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText(/proof for/i)).toBeNull());
    expect(H.setMark).not.toHaveBeenCalled();
    expect(H.attachProof).not.toHaveBeenCalled();

    clickCell(1); // marked → instant unmark, never a sheet
    await waitFor(() => expect(H.setMark).toHaveBeenCalledTimes(1));
    expect(H.setMark.mock.calls[0][0]).toMatchObject({ index: 1, nextMarked: false });
    expect(screen.queryByText(/proof for/i)).toBeNull();
    // #721: an unmark fires the distinct unmark_square event, NEVER
    // mark_square { marked: false } — the fix for the #721 root cause (a raw
    // mark_square count that mixed unmarks in with real marks).
    expect(H.track).toHaveBeenCalledWith('unmark_square', { mode: 'honor' });
    expect(H.track).not.toHaveBeenCalledWith('mark_square', expect.anything());
  });

  it('opens Photo-first (#309) — photo body on first paint, other bodies once chosen — and the pledge row fits one line (nowrap, full width)', async () => {
    const user = userEvent.setup();
    const { container } = render(<Board />);
    clickCell(0);
    await screen.findByText(/proof for/i);

    // Photo-first (#309, the wireframe's claim-sheet frame): the Photo segment
    // opens pre-selected with its capture body — Take photo / Library — on
    // first paint, one less tap on the mainline capture path.
    expect(container.querySelector('.seg-btn.on')).toHaveTextContent('Photo');
    expect(container.querySelector('.proof-body')).not.toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeInTheDocument();
    // The pre-selection never loosens the submit gate: no capture yet, so
    // Mark it cannot submit a nothing-proof.
    expect(screen.getByRole('button', { name: /mark it/i })).toBeDisabled();

    // The pledge is its own full-width, single-line row (specs/w4-honor-pledge.md):
    // .pledge-btn carries width:100% + white-space:nowrap in src/index.css.
    const pledge = screen.getByRole('button', { name: PLEDGE });
    expect(pledge.className).toContain('pledge-btn');

    // The Sound/Callout bodies still mount only once chosen: switching to
    // Callout swaps the photo body's file inputs for the textarea.
    await user.click(screen.getByRole('button', { name: /callout/i }));
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('a REAL proof still works from a claim open — the pledge is optional, not forced', async () => {
    const user = userEvent.setup();
    render(<Board />);
    clickCell(0);
    await screen.findByText(/proof for/i);

    await user.click(screen.getByRole('button', { name: /callout/i }));
    await user.type(screen.getByRole('textbox'), 'saw it myself');
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
    expect(H.attachProof.mock.calls[0][0]).toMatchObject({
      cellIndex: 0,
      claimMode: 'honor',
      proof: { type: 'text', text: 'saw it myself' },
    });
    expect(H.setMark).not.toHaveBeenCalled();
  });
});

describe('pledge race hardening (Codex P2s, PR #184)', () => {
  it('the pledge disables while a REAL proof submit is in flight — no parallel bare mark racing the attach transaction', async () => {
    const user = userEvent.setup();
    // attachProof hangs: the submit is saving for the rest of the test.
    let resolveAttach!: (v: unknown) => void;
    H.attachProof.mockImplementationOnce(() => new Promise((resolve) => (resolveAttach = resolve)));
    render(<Board />);
    clickCell(0);
    await screen.findByText(/proof for/i);

    await user.click(screen.getByRole('button', { name: /callout/i }));
    await user.type(screen.getByRole('textbox'), 'uploading…');
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    const pledge = screen.getByRole('button', { name: PLEDGE });
    expect(pledge).toBeDisabled();
    fireEvent.click(pledge); // swallowed — one in-flight claim per sheet
    expect(H.setMark).not.toHaveBeenCalled();

    resolveAttach(undefined);
    await waitFor(() => expect(screen.queryByText(/proof for/i)).toBeNull());
    expect(H.setMark).not.toHaveBeenCalled();
  });

  it('an account switch under an open claim sheet closes it — the pledge can never mark the captured index on the WRONG card', async () => {
    const { rerender } = render(<Board />);
    clickCell(0);
    await screen.findByText(/proof for/i);

    // The account switches AND the subscription catches up to the NEW uid's
    // board — `cellsAttributable` alone passes now, which is exactly the gap:
    // the captured proofTarget belongs to the previous account's card.
    H.user = { uid: 'u2', displayName: 'Second Sailor', photoURL: null };
    H.board = { uid: 'u2', dayIndex: 0, seed: 2, createdAt: 0, cells: dealt('j') }; // a different dealt card
    rerender(<Board />);

    // The render-time proofSourceLive close unmounts the dangling sheet…
    await waitFor(() => expect(screen.queryByText(/proof for/i)).toBeNull());
    // …so no pledge remains to mark the wrong card, and nothing was written.
    expect(screen.queryByRole('button', { name: PLEDGE })).toBeNull();
    expect(H.setMark).not.toHaveBeenCalled();
  });

  it('a claim sheet whose Square was claimed from ANOTHER TAB closes — its pledge has nothing left to claim', async () => {
    const { rerender } = render(<Board />);
    clickCell(0);
    await screen.findByText(/proof for/i);

    // The same account's listener echoes cell 0 now marked (another tab).
    const cells = dealt();
    cells[0] = { ...cells[0], marked: true, markedAt: 1, status: 'confirmed' };
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells };
    rerender(<Board />);

    await waitFor(() => expect(screen.queryByText(/proof for/i)).toBeNull());
    expect(H.setMark).not.toHaveBeenCalled();
  });
});

describe('stricter modes — the pledge is a disabled teaser', () => {
  it.each(['proof_required', 'admin_confirmed'] as const)(
    '%s: the claim-open sheet renders the pledge DISABLED and pressing it does nothing',
    async (mode) => {
      H.event = { claimMode: mode } as EventDoc;
      render(<Board />);
      clickCell(0);
      await screen.findByText(/proof for/i);

      const pledge = screen.getByRole('button', { name: PLEDGE });
      expect(pledge).toBeDisabled();
      fireEvent.click(pledge); // a disabled control swallows the click
      expect(H.setMark).not.toHaveBeenCalled();
      expect(screen.getByText(/proof for/i)).toBeInTheDocument(); // still open
    },
  );
});

describe('proof-add opens — no pledge on an already-claimed Square', () => {
  it.each(['honor', 'proof_required'] as const)(
    '%s: the ＋ proof-add sheet hides the pledge row entirely',
    async (mode) => {
      H.event = { claimMode: mode } as EventDoc;
      const cells = dealt();
      cells[0] = { ...cells[0], marked: true, markedAt: 1, status: 'confirmed' };
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells };
      render(<Board />);

      fireEvent.click(screen.getAllByTitle('Add proof')[0]);
      await screen.findByText(/proof for/i);

      expect(screen.queryByRole('button', { name: PLEDGE })).toBeNull();
    },
  );
});
