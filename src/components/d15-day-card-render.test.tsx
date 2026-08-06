import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { BoardDoc, Cell, DayDef, EventDoc, PlayerDoc } from '../types';

// Integration cover for #246 — the wiring the launch-blocking bug was missing:
// Board must render the VIEWED Day's OWN day-scoped board (so different Days show
// different squares, not one retinted board), deal a ready-but-undealt Day lazily,
// leave a locked future Day at the preview (dealing nothing), and route every Mark
// to the viewed Day (daily + dayIndex) so the leaderboard never double-counts.

const H = vi.hoisted(() => ({
  user: { uid: 'u1', displayName: 'Deck Daddy', photoURL: null } as {
    uid: string;
    displayName: string | null;
    photoURL: string | null;
  },
  // Per-Day boards, keyed by dayIndex — the fixture that proves each Day has its own.
  dayBoards: new Map<number, BoardDoc | null>(),
  player: null as PlayerDoc | null,
  event: null as EventDoc | null,
  setMark: vi.fn(),
  dealDayCard: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useBoard: () => ({ data: null, loading: false, hasServerData: true }),
  // The heart of the fix: Board reads the VIEWED Day's board here. Returning a
  // different board per dayIndex is exactly what "a different card per Day" means.
  useDayBoard: (_uid: string | undefined, dayIndex: number | undefined) => ({
    data: dayIndex === undefined ? null : (H.dayBoards.get(dayIndex) ?? null),
    loading: false,
    hasServerData: true,
  }),
  useMyPlayer: () => ({ data: H.player, loading: false, hasServerData: true }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  useItems: () => ({ items: [], loading: false, hasServerData: true }),
  useTally: () => ({ markers: [], count: 0, loading: false, hasServerData: true }),
  useLeaderboard: () => ({ players: [], loading: false }),
  useDoubts: () => ({ doubts: [], count: 0, loading: false, hasServerData: true }),
  useMyProofs: () => ({ proofs: [], loading: false, hasServerData: true }),
  useProofsForItemText: () => ({ proofs: [], loading: false, hasServerData: true }),
}));
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
vi.mock('../data/doubts', () => ({ raiseDoubt: vi.fn(), openDoubts: () => [], doubtStatusFor: () => 'none' }));
vi.mock('../data/api', () => ({
  // Reshuffle (#378): Board reads the allowance for the day-bar chip and
  // ReshuffleSheet imports the write; stubbed so the imports resolve. The chip's
  // own behaviour is proven in src/components/reshuffle-chip.test.tsx.
  RESHUFFLE_ALLOWANCE: 3,
  reshuffleBoard: vi.fn(async () => 1),
  setMark: H.setMark,
  dealDayCard: H.dealDayCard,
  // Open-time echo reconcile (specs/echo-marks.md): a no-op stub — the write
  // path is proven in src/data/echo-marks.test.ts.
  reconcileEchoes: vi.fn(() =>
    Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false }),
  ),
  resolveDisplayName: (p: { displayName?: unknown } | null | undefined, f: string | null | undefined) =>
    typeof p?.displayName === 'string' && p.displayName.trim().length > 0 ? p.displayName : (f ?? 'Anonymous'),
}));
vi.mock('../data/proofs', () => ({ attachProof: vi.fn() }));
// The live path pins the per-Day honor on a bingo verdict (#264); inert stubs
// keep this suite off the real Firestore write path.
vi.mock('../data/dayMeta', () => ({
  pinDayFirstBingo: vi.fn(() => Promise.resolve()),
  enqueueHeldHonorPin: vi.fn(),
  takeHeldHonorPins: vi.fn(() => []),
  dropHeldHonorPins: vi.fn(),
}));
// EVERY claim tap opens ProofSheet (issue #181); a stub whose 'pledge' button
// reports the one-tap honor mark keeps this suite off the real capture UI
// (mirrors w2-feed-moments.test.tsx).
vi.mock('./ProofSheet', () => ({
  default: (props: { onPledge?: () => void }) => (
    <>{props.onPledge && <button onClick={props.onPledge}>pledge</button>}</>
  ),
}));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: H.user, loading: false, signIn: vi.fn(), signOutUser: vi.fn() }),
}));
vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));

import Board from './Board';
// Handles onto the mocked moments module (the vi.mock above replaces it, so
// these bindings ARE the vi.fn()s the component calls).
import * as momentsModule from '../data/moments';
const momentsMocks = momentsModule as unknown as {
  enqueueWinMoments: ReturnType<typeof vi.fn>;
  enqueueFirstBingoMoment: ReturnType<typeof vi.fn>;
  hasPriorBingoWitness: ReturnType<typeof vi.fn>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function day(over: Partial<DayDef> & Pick<DayDef, 'index' | 'unlockAt' | 'theme'>): DayDef {
  return {
    date: `2026-07-${String(15 + over.index).padStart(2, '0')}`,
    place: `Port ${over.index}`,
    placeEmoji: '🇭🇷',
    tonight: [],
    pool: 'main',
    tutorial: false,
    ...over,
  };
}

// A 25-cell board whose non-free squares are labelled with the Day's own tag, so
// "Day 0 vs Day 1 differ" is directly observable in the DOM. `marked` cell 0 lets
// a tap trigger an (unmark) setMark directly, without going through the ProofSheet.
function boardFor(dayIndex: number): BoardDoc {
  const tag = `D${dayIndex}`;
  const cells: Cell[] = Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `${tag}-i${index}`,
    text: index === 12 ? 'FREE' : `${tag} Prompt ${index}`,
    free: index === 12,
    marked: index === 12 || index === 0,
    markedAt: index === 0 ? 1 : null,
  }));
  return { uid: 'u1', dayIndex, seed: dayIndex + 1, createdAt: 0, cells };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null };
  H.dayBoards.clear();
  H.player = null;
  H.event = null;
  H.setMark.mockResolvedValue({ cells: [], bingo: false, blackout: false, bingoTransition: false, blackoutTransition: false });
  H.dealDayCard.mockResolvedValue(true);
});

describe('Board daily-cards wiring (#246)', () => {
  it('renders a DIFFERENT card per Day and routes each Mark to the viewed Day (daily + dayIndex)', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({ index: 0, theme: 'get-sporty', unlockAt: now - 2 * DAY_MS, snapshotItemIds: ['x'] }),
        day({ index: 1, theme: 'glamiators', unlockAt: now - 1 * DAY_MS, snapshotItemIds: ['x'] }), // today (latest unlocked)
      ],
    } as unknown as EventDoc;
    H.dayBoards.set(0, boardFor(0));
    H.dayBoards.set(1, boardFor(1));

    render(<Board />);

    // Default view is today's Day (index 1) → the Day-1 board's squares.
    expect(screen.getByText('D1 Prompt 1')).toBeInTheDocument();
    expect(screen.queryByText('D0 Prompt 1')).not.toBeInTheDocument();

    // Unmark the marked Day-1 square → setMark with the viewed Day's index + daily.
    fireEvent.click(screen.getByText('D1 Prompt 0'));
    expect(H.setMark).toHaveBeenCalledTimes(1);
    expect(H.setMark.mock.calls[0][0]).toMatchObject({ daily: true, dayIndex: 1, nextMarked: false });

    // Switch to Day 0 → the OTHER board's squares, proving it's not one retinted card.
    fireEvent.click(screen.getAllByRole('tab')[0]);
    expect(screen.getByText('D0 Prompt 1')).toBeInTheDocument();
    expect(screen.queryByText('D1 Prompt 1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('D0 Prompt 0'));
    expect(H.setMark).toHaveBeenCalledTimes(2);
    expect(H.setMark.mock.calls[1][0]).toMatchObject({ daily: true, dayIndex: 0, nextMarked: false });
  });

  it('a bingo on a TUTORIAL Day never enqueues the cruise-wide first_bingo candidate; a main-game Day does (Codex P1 on #287)', async () => {
    // Spec § "Scoring and social surfaces": cruise-wide First to BINGO is
    // anchored to MAIN-GAME Days only — the embark card is live pre-cruise and
    // trivially easy by design, so without this gate the first embark bingo
    // would mint the immutable event-level singleton before anyone boards.
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({ index: 0, theme: 'welcome-aboard', unlockAt: now - 2 * DAY_MS, snapshotItemIds: ['x'], tutorial: true, pool: 'embark' }),
        day({ index: 1, theme: 'glamiators', unlockAt: now - 1 * DAY_MS, snapshotItemIds: ['x'] }),
      ],
    } as unknown as EventDoc;
    H.dayBoards.set(0, boardFor(0));
    H.dayBoards.set(1, boardFor(1));
    H.player = { displayName: 'Deck Daddy', photoURL: null } as unknown as PlayerDoc;
    const verdict = (cells: Cell[]) => ({ cells, bingo: true, blackout: false, bingoTransition: true, blackoutTransition: false });
    H.setMark.mockImplementation(({ cells }: { cells: Cell[] }) => Promise.resolve(verdict(cells)));

    render(<Board />);

    // A MARK (not unmark) reaches broadcastWinVerdict: tap an unmarked square,
    // then complete the honor Mark through the sheet's 🎖️ pledge (issue #181).
    const markSquare = async (label: string) => {
      await act(async () => {
        fireEvent.click(screen.getByText(label));
      });
      const pledge = screen.queryByText('pledge');
      if (pledge) {
        await act(async () => {
          fireEvent.click(pledge);
        });
      }
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    // Default view is Day 1 (main game): the SAME verdict enqueues the candidate.
    await markSquare('D1 Prompt 1');
    expect(momentsMocks.enqueueWinMoments).toHaveBeenCalledWith(expect.objectContaining({ bingoTransition: true, dayIndex: 1 }));
    expect(momentsMocks.enqueueFirstBingoMoment).toHaveBeenCalledTimes(1);
    // The prior-win witness excludes tutorial Days (Codex P1 on #288): a
    // warm-up bingo's `${uid}-bingo` doc must not disqualify this candidate.
    // `dayIndexes` (#372) hands over the schedule so the witness can probe the
    // per-card `${uid}-bingo-d${day}` ids, where the tutorial exclusion is exact.
    // `selfWriteGeneration` (#332) keeps the birth-time-witness race closed.
    expect(momentsMocks.hasPriorBingoWitness).toHaveBeenCalledWith('u1', {
      excludeDayIndexes: new Set([0]),
      dayIndexes: [0, 1],
      selfWriteGeneration: expect.any(Number),
      // The acted Day (#372, Codex P2 on #386): only THIS Day's doc may be
      // excused as self-evidence, since the generation alone cannot identify it.
      selfWriteDayIndex: 1,
    });

    // Switch to the embark tutorial Day: a bingo verdict there enqueues the
    // plain win Moment(s) but NEVER the ceremonial event singleton.
    momentsMocks.enqueueFirstBingoMoment.mockClear();
    momentsMocks.enqueueWinMoments.mockClear();
    fireEvent.click(screen.getAllByRole('tab')[0]);
    await markSquare('D0 Prompt 1');
    expect(momentsMocks.enqueueWinMoments).toHaveBeenCalledWith(expect.objectContaining({ bingoTransition: true, dayIndex: 0 }));
    expect(momentsMocks.enqueueFirstBingoMoment).not.toHaveBeenCalled();
  });

  it('lazily deals a ready Day with no card yet, and never deals a locked future Day', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({ index: 0, theme: 'get-sporty', unlockAt: now - DAY_MS, snapshotItemIds: ['x'] }), // ready, no board
        day({ index: 1, theme: 'dog-tag', unlockAt: now + DAY_MS, snapshotItemIds: ['x'] }), // locked future
      ],
    } as unknown as EventDoc;
    // No board for Day 0 yet → the deal effect should fire dealDayCard(user, 0).
    H.dayBoards.set(0, null);

    render(<Board />);

    expect(H.dealDayCard).toHaveBeenCalledWith(H.user, 0);

    // The locked future Day shows the preview and deals nothing.
    H.dealDayCard.mockClear();
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(screen.getByText(/unlocks/i)).toBeInTheDocument();
    expect(H.dealDayCard).not.toHaveBeenCalled();
    expect(H.setMark).not.toHaveBeenCalled();
  });

  it('renders the two-event "Tonight:" line on the dealt day card (schedule correction)', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({
          index: 0,
          theme: 'neon-pink-playground',
          unlockAt: now - DAY_MS,
          snapshotItemIds: ['x'],
          tonight: ['💖 Seriously Pink T-Dance', '🌈 Neon Playground'],
        }),
      ],
    } as unknown as EventDoc;
    H.dayBoards.set(0, boardFor(0));

    render(<Board />);

    const tonight = screen.getByText('Tonight:');
    expect(tonight).toBeInTheDocument();
    // Both events render on the one line, joined by the day-bar separator.
    expect(tonight.parentElement?.textContent).toContain('💖 Seriously Pink T-Dance');
    expect(tonight.parentElement?.textContent).toContain('🌈 Neon Playground');
  });

  it('shows the "Tonight:" tease on the locked-day preview (schedule correction)', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({ index: 0, theme: 'get-sporty', unlockAt: now - DAY_MS, snapshotItemIds: ['x'] }),
        day({
          index: 1,
          theme: 'sporty-splash',
          unlockAt: now + DAY_MS, // locked future
          snapshotItemIds: ['x'],
          tonight: ['💦 Splash T-Dance', '🏋️ Get Sporty'],
        }),
      ],
    } as unknown as EventDoc;
    H.dayBoards.set(0, boardFor(0));

    render(<Board />);

    // Switch to the locked future Day → its preview carries the Tonight tease.
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(screen.getByText(/unlocks/i)).toBeInTheDocument();
    const tonight = screen.getByText('Tonight:');
    expect(tonight.parentElement?.textContent).toContain('💦 Splash T-Dance');
    expect(tonight.parentElement?.textContent).toContain('🏋️ Get Sporty');
  });
});
