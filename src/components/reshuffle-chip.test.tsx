import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { BoardDoc, Cell, DayDef, EventDoc, PlayerDoc } from '../types';

// specs/reshuffle.md — the chip-visibility matrix (#378). The chip is an offer to
// write, and firestore.rules independently re-checks every one of its gates, so a
// chip that renders when a gate is false is a button that offers a write the
// server refuses. Each case below is one of those gates.
//
// Harness mirrors Board.test.tsx (hoisted `H` bag, top-level vi.mock, Board
// imported after).

const H = vi.hoisted(() => ({
  user: { uid: 'u1', displayName: 'Deck Daddy', photoURL: null } as {
    uid: string;
    displayName: string | null;
    photoURL: string | null;
  } | null,
  board: null as BoardDoc | null,
  player: null as PlayerDoc | null,
  event: null as EventDoc | null,
  playerLoading: false,
  playerConfirmed: true,
  online: true,
  reshuffleBoard: vi.fn(async () => 1),
  track: vi.fn(),
  getDoc: vi.fn(),
}));

vi.mock('../hooks/useData', () => ({
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  isBanned: (uid: string, list: string[]) => list.includes(uid),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useBoard: () => ({ data: H.board, loading: false, hasServerData: true }),
  useDayBoard: () => ({ data: H.board, loading: false, hasServerData: true }),
  useMyPlayer: () => ({ data: H.player, loading: H.playerLoading, hasServerData: H.playerConfirmed }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  useItems: () => ({ items: [], loading: false, hasServerData: true }),
  useTally: () => ({ markers: [], count: 0, loading: false, hasServerData: true }),
  useLeaderboard: () => ({ players: [], loading: false }),
  useDoubts: () => ({ doubts: [], count: 0, loading: false, hasServerData: true }),
  useMyProofs: () => ({ proofs: [], loading: false, hasServerData: true }),
  useProofsForItemText: () => ({ proofs: [], loading: false, hasServerData: true }),
}));
vi.mock('../hooks/useOnline', () => ({ useOnline: () => H.online, readOnline: () => H.online }));
vi.mock('../data/moments', () => ({
  broadcastBingo: vi.fn(),
  broadcastBlackout: vi.fn(),
  broadcastFirstBingo: vi.fn(),
  hasPriorBingoWitness: vi.fn(() => false),
  enqueueWinMoments: vi.fn(),
  enqueueFirstBingoMoment: vi.fn(),
  peekPendingMoments: vi.fn(() => []),
  pendingBlackoutDayIndexes: vi.fn(() => []),
  removePendingBlackoutDay: vi.fn(),
  pendingBingoDayIndex: vi.fn(() => null),
  pendingFirstBingoDayIndex: vi.fn(() => null),
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
  setMark: vi.fn(async () => ({ cells: [], bingo: false, blackout: false })),
  dealDayCard: vi.fn(() => Promise.resolve(false)),
  // Open-time echo reconcile (specs/echo-marks.md): a no-op stub — the write
  // path is proven in src/data/echo-marks.test.ts.
  reconcileEchoes: vi.fn(() =>
    Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false }),
  ),
  reshuffleBoard: H.reshuffleBoard,
  RESHUFFLE_ALLOWANCE: 3,
  resolveDisplayName: (profile: { displayName?: unknown } | null, fallback?: string | null) =>
    typeof profile?.displayName === 'string' && profile.displayName.trim().length > 0
      ? profile.displayName
      : (fallback ?? 'Anonymous'),
}));
vi.mock('../data/proofs', () => ({ attachProof: vi.fn() }));
vi.mock('../data/dayMeta', () => ({
  pinDayFirstBingo: vi.fn(() => Promise.resolve()),
  enqueueHeldHonorPin: vi.fn(),
  takeHeldHonorPins: vi.fn(() => []),
  dropHeldHonorPins: vi.fn(),
}));
vi.mock('../analytics', () => ({ track: H.track }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: H.user, loading: false, signIn: vi.fn(), signOutUser: vi.fn() }),
}));
vi.mock('firebase/firestore', () => ({
  getDoc: H.getDoc,
  doc: (...args: unknown[]) => ({
    args,
    withConverter() {
      return this;
    },
  }),
}));
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
// Both overlays self-gate on localStorage and would otherwise add their own CTAs
// to this suite's button queries.
vi.mock('./CoachOverlay', () => ({ default: () => null, isCoachOverlayDismissed: () => true }));
vi.mock('./LaunchIntro', () => ({ default: () => null }));

import Board from './Board';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHIP = '.reshuf';

function dealt(markedIndex?: number): Cell[] {
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `i${index}`,
    text: index === 12 ? 'FREE' : `Prompt ${index}`,
    free: index === 12,
    marked: index === 12 || index === markedIndex,
    markedAt: index === markedIndex ? 1 : null,
  }));
}

function day(over: Partial<DayDef> & Pick<DayDef, 'index' | 'unlockAt' | 'theme'>): DayDef {
  return {
    date: '2026-07-17',
    port: 'Split',
    portEmoji: '🇭🇷',
    pool: 'main',
    tutorial: false,
    ...over,
  } as DayDef;
}

function player(over: Partial<PlayerDoc> = {}): PlayerDoc {
  return {
    uid: 'u1',
    displayName: 'Deck Daddy',
    photoURL: null,
    joinedAt: 0,
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    reshufflesUsed: 0,
    ...over,
  };
}

/** A live, unlocked Day 2 with a pristine card and an unspent allowance — the
 *  one state in which the chip SHOULD render. Each test below breaks exactly one
 *  gate off this baseline. */
function baseline(now: number) {
  H.event = {
    claimMode: 'honor',
    timezone: 'UTC',
    days: [day({ index: 0, theme: 'welcome-aboard', unlockAt: now - 2 * DAY_MS, tutorial: true }), day({ index: 1, theme: 'get-sporty', unlockAt: now - DAY_MS })],
  } as unknown as EventDoc;
  H.board = { uid: 'u1', dayIndex: 1, seed: 111, createdAt: 0, cells: dealt() };
  H.player = player();
}

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null };
  H.online = true;
  H.playerLoading = false;
  H.playerConfirmed = true;
  H.getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) });
  baseline(Date.now());
});

const chip = () => document.querySelector(CHIP);

describe('the reshuffle chip renders only when every gate holds', () => {
  it('RENDERS on a pristine, unlocked, online card with allowance left', () => {
    render(<Board />);
    expect(chip()).not.toBeNull();
  });

  it('shows the REMAINING cruise-wide count, not the spend', () => {
    H.player = player({ reshufflesUsed: 1 });
    render(<Board />);
    expect(chip()?.textContent).toContain('×2');
  });

  it('shows ×3 for an untouched allowance', () => {
    render(<Board />);
    expect(chip()?.textContent).toContain('×3');
  });

  it('is ABSENT once a single square is marked', () => {
    H.board = { uid: 'u1', dayIndex: 1, seed: 111, createdAt: 0, cells: dealt(0) };
    render(<Board />);
    expect(chip()).toBeNull();
  });

  it('is ABSENT for a card holding a PENDING mark (a queued Claim is still a tap)', () => {
    const cells = dealt();
    cells[0] = { ...cells[0], marked: true, status: 'pending' };
    H.board = { uid: 'u1', dayIndex: 1, seed: 111, createdAt: 0, cells };
    render(<Board />);
    expect(chip()).toBeNull();
  });

  it('RETURNS after the card is unmarked again — the escape hatch', () => {
    H.board = { uid: 'u1', dayIndex: 1, seed: 111, createdAt: 0, cells: dealt(0) };
    const view = render(<Board />);
    expect(chip()).toBeNull();
    // The unmark lands through the live listener, exactly as the real path does.
    H.board = { uid: 'u1', dayIndex: 1, seed: 111, createdAt: 0, cells: dealt() };
    view.rerender(<Board />);
    expect(chip()).not.toBeNull();
  });

  it('is ABSENT once the allowance is spent', () => {
    H.player = player({ reshufflesUsed: 3 });
    render(<Board />);
    expect(chip()).toBeNull();
  });

  it('is ABSENT while OFFLINE — the write must never queue', () => {
    H.online = false;
    render(<Board />);
    expect(chip()).toBeNull();
  });

  // The tri-state trap: an unconfirmed-absent player row reads `null`, and a naive
  // `?? 0` would offer ×3 to someone who has actually spent all three.
  it('is ABSENT while the player row is UNKNOWN (loading, nothing cached)', () => {
    H.player = null;
    H.playerLoading = true;
    H.playerConfirmed = false;
    render(<Board />);
    expect(chip()).toBeNull();
  });

  it('is ABSENT on a card that is not the caller\'s own', () => {
    H.board = { uid: 'someone-else', dayIndex: 1, seed: 111, createdAt: 0, cells: dealt() };
    render(<Board />);
    expect(chip()).toBeNull();
  });
});

describe('the reshuffle chip never appears on a locked Day', () => {
  it('is ABSENT on a locked-Day preview (no board dealt yet)', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'get-sporty', unlockAt: now + DAY_MS })],
    } as unknown as EventDoc;
    H.board = null;
    render(<Board />);
    expect(chip()).toBeNull();
  });
});

describe('the chip opens the confirm sheet', () => {
  it('tapping it reveals the sheet; the sheet writes nothing until confirmed', () => {
    render(<Board />);
    fireEvent.click(chip()!);
    expect(screen.getByText('Reshuffle this card?')).toBeInTheDocument();
    expect(H.reshuffleBoard).not.toHaveBeenCalled();
  });

  it('Keep my card closes the sheet and writes nothing', () => {
    render(<Board />);
    fireEvent.click(chip()!);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my card' }));
    expect(screen.queryByText('Reshuffle this card?')).not.toBeInTheDocument();
    expect(H.reshuffleBoard).not.toHaveBeenCalled();
  });

  // The dangling-sheet close: the sheet is open and a Mark lands from another tab,
  // so the confirm must not outlive its own preconditions.
  it('closes itself if the card stops being eligible while open', () => {
    const view = render(<Board />);
    fireEvent.click(chip()!);
    expect(screen.getByText('Reshuffle this card?')).toBeInTheDocument();
    H.board = { uid: 'u1', dayIndex: 1, seed: 111, createdAt: 0, cells: dealt(0) };
    view.rerender(<Board />);
    expect(screen.queryByText('Reshuffle this card?')).not.toBeInTheDocument();
  });
});
