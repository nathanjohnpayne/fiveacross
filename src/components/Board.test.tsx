import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { BoardDoc, Cell, DayDef, EventDoc, PlayerDoc } from '../types';
import { ThemeProvider } from '../theme/ThemeContext';
import { saveCardSnapshot } from '../data/cardCache';

// specs/d15-day-switcher.md: Board mounting the Day switcher (daily-cards-
// spec § "Day switcher") and the locked-Day preview (§ "Locked Day
// preview"). Covers the two invariants the AC section calls out: selecting
// a Day chip retints ONLY the board's own container — never `<html>`, which
// stays on the Player's own app-wide Theme (ThemeContext) — and a locked
// viewed Day renders a themed, blank 5x5 grid (only the free space
// populated) with the Theme's description and an "Unlocks…" badge, with NO
// write path (`setMark`) reachable from any of its Squares.

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
  dayMeta: null as { firstBingo: { uid: string; displayName: string; at: number } } | null,
  boardFromCache: false,
  boardPending: false,
  pinDayFirstBingo: vi.fn((..._args: unknown[]) => Promise.resolve()),
  enqueueHeldHonorPin: vi.fn(),
  takeHeldHonorPins: vi.fn(() => [] as Array<{ uid: string; dayIndex: number; at: number }>),
  dropHeldHonorPins: vi.fn(),
  getDoc: vi.fn(),
  retryDeal: vi.fn(),
}));

vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: H.dayMeta, loading: false, hasServerData: true }),
  isBanned: (uid: string, list: string[]) => list.includes(uid),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useBoard: () => ({
    data: H.board,
    loading: false,
    hasServerData: true,
    fromCache: H.boardFromCache,
    hasPendingWrites: H.boardPending,
  }),
  // In daily mode Board reads the VIEWED Day's board here (#246). The suite's
  // fixtures set `H.board` with a `dayIndex` matching the viewed Day, so returning
  // it for any requested index renders that Day's card exactly as before.
  useDayBoard: () => ({
    data: H.board,
    loading: false,
    hasServerData: true,
    fromCache: H.boardFromCache,
    hasPendingWrites: H.boardPending,
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
  // Lazy per-Day deal (#246): the suite pre-sets `H.board`, so the deal effect's
  // `if (board) return` guard short-circuits and this is never actually invoked;
  // stubbed so the import resolves.
  dealDayCard: vi.fn(() => Promise.resolve(false)),
  // Open-time echo reconcile (specs/echo-marks.md): a no-op stub — the reconcile
  // write path is proven in src/data/echo-marks.test.ts.
  reconcileEchoes: vi.fn(() =>
    Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false }),
  ),
  resolveDisplayName: (
    profile: { displayName?: unknown } | null | undefined,
    fallback: string | null | undefined,
  ) =>
    typeof profile?.displayName === 'string' && profile.displayName.trim().length > 0
      ? profile.displayName
      : (fallback ?? 'Anonymous'),
}));
vi.mock('../data/proofs', () => ({ attachProof: H.attachProof }));
vi.mock('../data/dayMeta', () => ({
  pinDayFirstBingo: H.pinDayFirstBingo,
  enqueueHeldHonorPin: H.enqueueHeldHonorPin,
  takeHeldHonorPins: H.takeHeldHonorPins,
  dropHeldHonorPins: H.dropHeldHonorPins,
}));
vi.mock('../analytics', () => ({ track: H.track }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: H.user,
    loading: false,
    signIn: vi.fn(),
    signOutUser: vi.fn(),
    retryDeal: H.retryDeal,
    dealing: false,
  }),
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
// CoachOverlay (#214) imports EVENT_ID from '../firebase' — mocked so
// mounting Board here never touches the real Firebase app init.
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));

import Board, { shareCardBingoNumber } from './Board';
import { drainRetractions } from '../data/moments';

const DAY_MS = 24 * 60 * 60 * 1000;

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

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

function withMarked(indices: number[]): Cell[] {
  const cells = dealt();
  for (const i of indices) {
    cells[i] = { ...cells[i], marked: true, markedAt: i + 1, status: 'confirmed' };
  }
  return cells;
}

describe('Share Card BINGO number', () => {
  it('uses the current daily board line count when frozen root standings lag the win', () => {
    expect(
      shareCardBingoNumber({
        cells: withMarked([0, 1, 2, 3, 4]),
        rootBingoCount: 0,
        dayBingoCount: 0,
        hasDays: true,
        statsFrozen: true,
      }),
    ).toBe(1);
  });

  it('does not overstate frozen daily cards from stale day standings', () => {
    expect(
      shareCardBingoNumber({
        cells: withMarked([0, 1, 2, 3, 4]),
        rootBingoCount: 3,
        dayBingoCount: 2,
        hasDays: true,
        statsFrozen: true,
      }),
    ).toBe(1);
  });

  it('keeps unfrozen daily cards compatible by falling back to day standings', () => {
    expect(
      shareCardBingoNumber({
        cells: withMarked([0, 1, 2, 3, 4]),
        rootBingoCount: 3,
        dayBingoCount: 2,
        hasDays: true,
        statsFrozen: false,
      }),
    ).toBe(2);
  });

  it('keeps legacy cards compatible by falling back to the root aggregate', () => {
    expect(
      shareCardBingoNumber({
        cells: withMarked([0, 1, 2, 3, 4]),
        rootBingoCount: 2,
        dayBingoCount: undefined,
        hasDays: false,
        statsFrozen: true,
      }),
    ).toBe(2);
  });
});

function day(overrides: Partial<DayDef> & Pick<DayDef, 'index' | 'unlockAt' | 'theme'>): DayDef {
  return {
    date: `2026-07-${String(15 + overrides.index).padStart(2, '0')}`,
    port: `Port ${overrides.index}`,
    portEmoji: '🇭🇷',
    tonight: [],
    pool: 'main',
    tutorial: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.dayMeta = null;
  H.boardFromCache = false;
  H.boardPending = false;
  H.user = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null };
  H.event = { claimMode: 'honor', timezone: 'UTC', days: [] } as unknown as EventDoc;
  H.board = null;
  H.player = null;
  H.setMark.mockResolvedValue({ cells: [], bingo: false, blackout: false });
  H.attachProof.mockResolvedValue(undefined);
  H.getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) });
});

describe('published Moment retraction drain gate (#377)', () => {
  it('does not drain from a cache-only board snapshot', async () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'get-sporty', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
    H.boardFromCache = true;

    render(<Board />);
    await act(async () => {});

    expect(drainRetractions).not.toHaveBeenCalled();
  });

  it('does not drain from a board snapshot with pending writes', async () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'get-sporty', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
    H.boardPending = true;

    render(<Board />);
    await act(async () => {});

    expect(drainRetractions).not.toHaveBeenCalled();
  });

  it('drains from a server-committed daily board snapshot with the board state', async () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'get-sporty', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);
    await act(async () => {});

    expect(drainRetractions).toHaveBeenCalledWith('u1', {
      dayIndex: 0,
      bingoStands: false,
      blackoutStands: false,
    });
  });
});

describe('open-time reconcile churn gate (#492)', () => {
  const reconcileDays = (now: number) => [
    day({ index: 0, theme: 'get-sporty', unlockAt: now - DAY_MS }),
    day({ index: 1, theme: 'get-sporty', unlockAt: now - DAY_MS }),
  ];

  it('an INCOMPLETE pass retries once per board OPEN, not on every snapshot', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: false }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // Every live snapshot delivers a NEW board object for the SAME card.
      // Pre-#492, the dropped once-per-board key made each one re-run the
      // whole reconcile (N+2 cache reads through markChains, repeated
      // repair-pin denials). Now the incomplete attempt blocks the visit.
      H.board = { ...(H.board as object) } as typeof H.board;
      view.rerender(<Board />);
      await act(async () => {});
      H.board = { ...(H.board as object) } as typeof H.board;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // Opening a DIFFERENT board identity (here: the same Day's replacement
      // card after a reshuffle — a new seed is a new identity, exactly like
      // navigating to another Day) runs its own reconcile and unblocks the
      // first identity…
      H.board = { uid: 'u1', dayIndex: 0, seed: 2, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);

      // …so RETURNING to it (a later open, the contract's retry point)
      // re-runs the incomplete pass with more of the cache populated.
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('a STALE incomplete completion (landing after navigation) does not re-block its board (#498)', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    type ReconcileResult = Awaited<ReturnType<typeof reconcileEchoes>>;
    let resolveSlow: ((value: ReconcileResult) => void) | undefined;
    mocked.mockImplementationOnce(
      () =>
        new Promise<ReconcileResult>((resolve) => {
          resolveSlow = resolve;
        }),
    );
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // Board A's reconcile hangs (a slow cache pass)…
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …the player navigates to board B (new identity) before it settles…
      H.board = { uid: 'u1', dayIndex: 0, seed: 2, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);

      // …and A's INCOMPLETE result lands late, while B is the viewed board.
      await act(async () => {
        resolveSlow!({ changed: false, bingoTransition: false, blackoutTransition: false, complete: false });
      });

      // Returning to A is a later OPEN: the stale completion must not have
      // pinned the visit block, so A retries immediately.
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('an incomplete completion from a PREVIOUS visit (left and returned mid-flight) does not swallow the return visit (#498)', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    type ReconcileResult = Awaited<ReturnType<typeof reconcileEchoes>>;
    let resolveSlow: ((value: ReconcileResult) => void) | undefined;
    mocked.mockImplementationOnce(
      () =>
        new Promise<ReconcileResult>((resolve) => {
          resolveSlow = resolve;
        }),
    );
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // Visit 1 of board A hangs mid-reconcile…
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …the player switches to B and RETURNS to A before it settles (the
      // in-flight guard rightly skips a second attempt)…
      H.board = { uid: 'u1', dayIndex: 0, seed: 2, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2); // B's own pass only

      // …then visit 1's INCOMPLETE result lands. It belongs to the PREVIOUS
      // A visit, so it must not pin the block against the current one.
      await act(async () => {
        resolveSlow!({ changed: false, bingoTransition: false, blackoutTransition: false, complete: false });
      });

      // The next snapshot of the still-viewed A retries.
      H.board = { ...(H.board as object) } as typeof H.board;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('a stale incomplete completion on the CURRENTLY OPEN board schedules the retry itself — no unrelated snapshot needed (#499)', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    type ReconcileResult = Awaited<ReturnType<typeof reconcileEchoes>>;
    let resolveSlow: ((value: ReconcileResult) => void) | undefined;
    mocked.mockImplementationOnce(
      () =>
        new Promise<ReconcileResult>((resolve) => {
          resolveSlow = resolve;
        }),
    );
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // Visit 1 of board A hangs mid-reconcile…
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …the player visits B and RETURNS to A before it settles (the
      // in-flight guard rightly skips the return visit's own attempt)…
      H.board = { uid: 'u1', dayIndex: 0, seed: 2, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2); // B's own pass only

      // …then visit 1's INCOMPLETE result lands while A — its own board — is
      // the one on screen, with all of A's snapshots already delivered. The
      // completion handler must schedule the live visit's retry ITSELF: a
      // ref delete re-runs no effect, and "a later OPEN retries" (spec §
      // Open-time) must not wait for an unrelated snapshot that may never
      // come. NO rerender after this point.
      await act(async () => {
        resolveSlow!({ changed: false, bingoTransition: false, blackoutTransition: false, complete: false });
      });
      expect(mocked).toHaveBeenCalledTimes(3);

      // The retry completed and settled the guard — later snapshots of A do
      // not churn.
      H.board = { ...(H.board as object) } as typeof H.board;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('an interlude with NO attributable board ends the visit — returning to the blocked card is a later OPEN that retries (#500)', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    mocked.mockImplementationOnce(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: false }),
    );
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // Board A's pass comes back incomplete — the visit block pins (#492)…
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);
      H.board = { ...(H.board as object) } as typeof H.board;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1); // pinned — same visit, no churn

      // …the player moves through a state with NO attributable board (a
      // locked/loading Day, or stale account-switch data) — never another
      // VALID board identity…
      H.board = null;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …and returns to the SAME card. That is a later OPEN: the pin from
      // the ended visit must not still block it.
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('a same-card return whose fresh attempt the in-flight guard skipped retries when the stale pass resolves incomplete (#501)', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    type ReconcileResult = Awaited<ReturnType<typeof reconcileEchoes>>;
    let resolveSlow: ((value: ReconcileResult) => void) | undefined;
    mocked.mockImplementationOnce(
      () =>
        new Promise<ReconcileResult>((resolve) => {
          resolveSlow = resolve;
        }),
    );
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // Board A's reconcile hangs…
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …the player dips through a no-board state and returns FAST, while
      // the pass is still in flight — the in-flight guard skips the return
      // visit's own attempt (correctly: one pass per key at a time)…
      H.board = null;
      view.rerender(<Board />);
      await act(async () => {});
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …then the stale pass resolves INCOMPLETE. The current open's promised
      // retry was swallowed by the guard, so the completion must retrigger it
      // explicitly. NO rerender after this point.
      await act(async () => {
        resolveSlow!({ changed: false, bingoTransition: false, blackoutTransition: false, complete: false });
      });
      expect(mocked).toHaveBeenCalledTimes(2);

      // The retry settled complete — no further churn on later snapshots.
      H.board = { ...(H.board as object) } as typeof H.board;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('a player row that turns root-lagged AFTER the board settled re-arms the reconcile without a reload — once per episode, and never on a consistent row (#506)', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // The board settles its complete pass with a CONSISTENT row on screen
      // (buckets sum exactly to the roots).
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 3, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // Consistent-row snapshots never re-arm the settled guard.
      H.player = { ...(H.player as object) } as typeof H.player;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // Another device's acted-day batch understates the roots: the row
      // snapshot now out-sums them (dominated AND strictly exceeding — the
      // same `playerRowRootLag` signal `runReconcileEchoes` heals on). The
      // once-per-board key is retained for the session, so without a re-arm
      // this row would stay unhealed until a reload.
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 5, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);

      // A STILL-inconsistent later snapshot (the heal not yet reflected) is
      // the same episode — no per-snapshot churn.
      H.player = { ...(H.player as object) } as typeof H.player;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);

      // The healed (consistent) row closes the episode; a LATER lag is a new
      // episode and re-arms again.
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 5,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 5, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 5,
        dayStats: { 0: { bingoCount: 1, squaresMarked: 5, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('a row lag surfacing DURING an in-flight pass that settles complete still re-arms — the settle consumes the owed re-arm (#506)', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    type ReconcileResult = Awaited<ReturnType<typeof reconcileEchoes>>;
    let resolveSlow: ((value: ReconcileResult) => void) | undefined;
    mocked.mockImplementationOnce(
      () =>
        new Promise<ReconcileResult>((resolve) => {
          resolveSlow = resolve;
        }),
    );
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // The pass launches against a CONSISTENT row and hangs…
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 3, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …the row turns root-lagged WHILE the pass is in flight (the pass
      // captured the consistent row, so its own predicate will never see the
      // lag). The re-arm must be deferred, not doubled — no second pass yet.
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 5, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …then the raced pass settles COMPLETE. Without consuming the owed
      // re-arm this would settle the guard for the session and the lag would
      // wait on an unguaranteed snapshot. NO rerender after this point.
      await act(async () => {
        resolveSlow!({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true });
      });
      expect(mocked).toHaveBeenCalledTimes(2);

      // The retried pass settled — later snapshots of the still-lagged row
      // are the same episode and do not churn.
      H.player = { ...(H.player as object) } as typeof H.player;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('the owed row-lag heal follows the player to an already-settled board opened before the raced pass settles (#507 round 2)', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    type ReconcileResult = Awaited<ReturnType<typeof reconcileEchoes>>;
    let resolveSlow: ((value: ReconcileResult) => void) | undefined;
    mocked.mockImplementationOnce(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    mocked.mockImplementationOnce(
      () =>
        new Promise<ReconcileResult>((resolve) => {
          resolveSlow = resolve;
        }),
    );
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // Board B settles its complete pass on a consistent row…
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 3, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      H.board = { uid: 'u1', dayIndex: 0, seed: 2, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …the player opens board A, whose pass hangs…
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);

      // …the row turns root-lagged while A's pass is in flight (deferred, not
      // doubled)…
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 5, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);

      // …and the player navigates BACK to the already-settled B before A
      // settles. The heal is row-scoped — any board's pass evaluates the same
      // predicate — so the owed pass must be served on B, the board that is
      // actually open, not left tied to A's key.
      H.board = { uid: 'u1', dayIndex: 0, seed: 2, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);

      // A's raced pass settling later changes nothing — the debt was served.
      await act(async () => {
        resolveSlow!({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true });
      });
      expect(mocked).toHaveBeenCalledTimes(3);
      H.player = { ...(H.player as object) } as typeof H.player;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('the row-lag episode latch is per-account — a switch-back with a lagged row re-arms the returning account (#507 round 2)', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // Account u1 settles its board guard on a consistent row…
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 3, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …switch to account u2 (a stale-board interlude, then u2's data) whose
      // row is LAGGED and whose heal does not converge (the pass completes
      // but the row snapshot stays inconsistent) — u2's episode latches…
      H.user = { uid: 'u2', displayName: 'Second Sailor', photoURL: null };
      view.rerender(<Board />);
      await act(async () => {});
      H.player = {
        uid: 'u2',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 5, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      H.board = { uid: 'u2', dayIndex: 0, seed: 7, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);

      // …then switch back to u1, whose row has ALSO turned lagged meanwhile.
      // The episode latch is per-account: u2's still-active episode must not
      // swallow u1's — u1's settled guard re-arms and the heal runs.
      H.user = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null };
      view.rerender(<Board />);
      await act(async () => {});
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 5, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);

      // Still once per episode: further lagged snapshots do not churn.
      H.player = { ...(H.player as object) } as typeof H.player;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it("a stale previous-account lagged row cannot consume the new account's episode — the real row's lag still heals (#507 4b P1)", async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      // Account u1 plays with a LAGGED row whose heal does not converge —
      // its episode is latched and served…
      H.player = {
        uid: 'u1',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 5, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      // …the user switches to u2, and u2's board turns valid BEFORE the
      // player-row subscription catches up — `player` is still u1's stale
      // lagged row. That stale row must not latch (and consume) u2's
      // episode; u2's board runs its ordinary first pass only.
      H.user = { uid: 'u2', displayName: 'Second Sailor', photoURL: null };
      H.board = { uid: 'u2', dayIndex: 0, seed: 7, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(2);

      // …then u2's REAL row arrives, itself lagged. This is u2's first
      // attributable row signal: the episode must latch NOW and re-arm the
      // already-settled board — a stale-row-consumed episode would suppress
      // this heal for the whole session.
      H.player = {
        uid: 'u2',
        bingoCount: 0,
        squaresMarked: 3,
        dayStats: { 0: { bingoCount: 0, squaresMarked: 5, firstBingoAt: null } },
      } as unknown as PlayerDoc;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);

      // Once per episode, as ever — a further lagged snapshot does not churn.
      H.player = { ...(H.player as object) } as typeof H.player;
      view.rerender(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(3);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });

  it('a COMPLETE pass settles the once-per-board guard — no re-run on a later open of the same card', async () => {
    const { reconcileEchoes } = await import('../data/api');
    const mocked = vi.mocked(reconcileEchoes);
    mocked.mockImplementation(() =>
      Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
    );
    try {
      const now = Date.now();
      H.event = { claimMode: 'honor', timezone: 'UTC', days: reconcileDays(now) } as unknown as EventDoc;
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      const view = render(<Board />);
      await act(async () => {});
      expect(mocked).toHaveBeenCalledTimes(1);

      H.board = { uid: 'u1', dayIndex: 0, seed: 2, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
      view.rerender(<Board />);
      await act(async () => {});
      // The first card settled on its complete pass; only the other identity's
      // own first pass added a call — no retry churn for settled boards.
      expect(mocked).toHaveBeenCalledTimes(2);
    } finally {
      mocked.mockImplementation(() =>
        Promise.resolve({ changed: false, bingoTransition: false, blackoutTransition: false, complete: true }),
      );
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // ThemeProvider (mounted only by the retint test below) writes
  // `<html data-theme>` on mount — this repo's jsdom project leaves
  // `window.localStorage` unset (see src/theme/w1-themes.test.tsx), so
  // ThemeContext's own defensive try/catch handles persistence here; this
  // just resets the DOM side effect between tests.
  delete document.documentElement.dataset.theme;
});

describe('Durable cached-card fallback', () => {
  it('renders a matching Day snapshot when the live board is unavailable', () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    const now = Date.now();
    const cells = dealt('saved');
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({
          index: 0,
          theme: 'welcome-aboard',
          unlockAt: now - DAY_MS,
          tutorial: true,
          pool: 'embark',
          snapshotItemIds: cells.filter((c) => !c.free).map((c) => c.itemId!),
        }),
      ],
    } as unknown as EventDoc;
    saveCardSnapshot({ uid: 'u1', dayIndex: 0, cells, bingoCount: 1, day: null });

    render(<Board />);

    expect(screen.getByText(/Showing your saved card/)).toBeInTheDocument();
    expect(screen.getByText('Prompt saved0')).toBeInTheDocument();
    expect(screen.queryByText(/Dealing your card/)).not.toBeInTheDocument();
  });

  it('does not render a snapshot saved for a different viewed Day', () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    const now = Date.now();
    const cells = dealt('wrong');
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({
          index: 0,
          theme: 'welcome-aboard',
          unlockAt: now - DAY_MS,
          tutorial: true,
          pool: 'embark',
          snapshotItemIds: cells.filter((c) => !c.free).map((c) => c.itemId!),
        }),
      ],
    } as unknown as EventDoc;
    saveCardSnapshot({ uid: 'u1', dayIndex: 1, cells, bingoCount: 1, day: null });

    render(<Board />);

    expect(screen.queryByText(/Showing your saved card/)).not.toBeInTheDocument();
    expect(screen.queryByText('Prompt wrong0')).not.toBeInTheDocument();
    expect(screen.getByText(/Dealing your card/)).toBeInTheDocument();
  });

  it('treats a retained foreign board as unavailable and renders only this user snapshot', () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    const now = Date.now();
    const saved = dealt('mine');
    const foreign = dealt('foreign');
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({
          index: 0,
          theme: 'welcome-aboard',
          unlockAt: now - DAY_MS,
          tutorial: true,
          pool: 'embark',
          snapshotItemIds: saved.filter((c) => !c.free).map((c) => c.itemId!),
        }),
      ],
    } as unknown as EventDoc;
    H.board = { uid: 'someone-else', dayIndex: 0, seed: 1, createdAt: 0, cells: foreign };
    saveCardSnapshot({ uid: 'u1', dayIndex: 0, cells: saved, bingoCount: 1, day: null });

    render(<Board />);

    expect(screen.getByText(/Showing your saved card/)).toBeInTheDocument();
    expect(screen.getByText('Prompt mine0')).toBeInTheDocument();
    expect(screen.queryByText('Prompt foreign0')).not.toBeInTheDocument();
  });
});

describe('Day switcher retint', () => {
  it('selecting a Day chip sets data-theme on the board container only, never on <html> (the app-wide Theme is unchanged)', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({ index: 0, theme: 'welcome-aboard', unlockAt: now - 3 * DAY_MS, tutorial: true, pool: 'embark' }),
        day({ index: 1, theme: 'get-sporty', unlockAt: now - 2 * DAY_MS }),
        day({ index: 2, theme: 'glamiators', unlockAt: now - 1 * DAY_MS }), // today
        day({ index: 3, theme: 'dog-tag', unlockAt: now + 1 * DAY_MS }), // locked
      ],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 2, seed: 1, createdAt: 0, cells: dealt() };

    render(
      <ThemeProvider>
        <Board />
      </ThemeProvider>,
    );

    // App-wide Theme, set by ThemeContext on <html>, defaults to neon-playground.
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon-playground');
    // today's Day (index 2, glamiators) is the default-selected viewed Day.
    expect(document.querySelector('.board-area')?.getAttribute('data-theme')).toBe('glamiators');

    const chips = screen.getAllByRole('tab');
    fireEvent.click(chips[1]); // a past, unlocked Day — get-sporty

    expect(document.querySelector('.board-area')?.getAttribute('data-theme')).toBe('get-sporty');
    // The Player's own app-wide Theme choice never moves with the viewed Day.
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon-playground');
  });
});

describe('Locked-Day preview', () => {
  it('renders a themed blank 5x5 grid (only the free space populated), the Theme description, and an Unlocks badge; a Square tap never calls setMark', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({
          index: 0,
          theme: 'get-sporty',
          unlockAt: now + DAY_MS,
          freeText: 'A per-day free space override',
        }),
      ],
    } as unknown as EventDoc;
    H.board = null; // a locked Day never has a dealt Board

    render(<Board />);

    expect(screen.getByText(/unlocks/i)).toBeInTheDocument();
    // #260: the unlock copy lowercases the meridiem ("8:00 a.m."), never "AM".
    expect(screen.getByText(/unlocks/i).textContent).toMatch(/[ap]\.m\./);
    expect(screen.getByText(/unlocks/i).textContent).not.toMatch(/[AP]M/);
    // #260: the locked preview opens with the daybar — "Day N · Theme" + port.
    expect(document.querySelector('.daybar-name')?.textContent).toContain('Day 1 · Get Sporty');
    // get-sporty's ThemeMeta description (src/theme/themes.ts), verbatim.
    expect(screen.getByText(/locker-room fantasy/i)).toBeInTheDocument();
    expect(screen.getByText('A per-day free space override')).toBeInTheDocument();

    // specs/d15-icons-lucide.md: the unlock badge shows a Lucide `Lock`
    // icon, not the `🔒` emoji.
    const lockBadge = document.querySelector('.day-lock-badge');
    expect(lockBadge?.querySelector('svg.day-lock-icon')).toBeTruthy();
    expect(lockBadge?.textContent).not.toContain('🔒');

    const lockedCells = document.querySelectorAll('.locked-grid .cell');
    expect(lockedCells).toHaveLength(25);
    // Only the center (free space) square carries text; the rest are blank.
    expect(lockedCells[12].textContent).toContain('A per-day free space override');
    expect(lockedCells[0].textContent?.trim()).toBe('');

    fireEvent.click(lockedCells[0]);
    fireEvent.click(lockedCells[12]);
    expect(H.setMark).not.toHaveBeenCalled();
  });
});

// specs/d15-tutorial-banners.md + #260: Board mounts the tutorial banner
// gated on the VIEWED Day's `tutorial` flag, and the daybar (board-header)
// on EVERY viewed Day — with the tutorial tag ("Warm-up"/"Goodbye") inside
// the daybar's name line on the two tutorial Days only.
describe('Tutorial banner + board header (daybar)', () => {
  it('mounts the embark banner and the "Warm-up" board-header tag on an unlocked Welcome Aboard Day', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'welcome-aboard', unlockAt: now - DAY_MS, tutorial: true, pool: 'embark' })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);

    expect(screen.getByText(/mark what happens/i)).toBeInTheDocument();
    expect(document.querySelector('.board-header')).not.toBeNull();
    expect(document.querySelector('.board-header')?.textContent).toContain('Warm-up');
  });

  it('renders the daybar without a banner or tag on an unlocked main Day (#260)', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 2, theme: 'glamiators', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 2, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);

    expect(screen.queryByText(/mark what happens/i)).not.toBeInTheDocument();
    // The daybar renders on every viewed Day now: "Day N · Theme" + port +
    // dress-code description — but no tutorial tag on a main Day.
    const header = document.querySelector('.board-header');
    expect(header).not.toBeNull();
    expect(header?.querySelector('.daybar-name')?.textContent).toContain('Day 3 · Glamiators');
    expect(header?.querySelector('.daybar-meta')?.textContent).toContain('Port 2');
    expect(header?.textContent).toContain('Roman toga-chic');
    expect(header?.textContent).not.toContain('Warm-up');
    expect(header?.textContent).not.toContain('Goodbye');
  });

  it('tags the farewell Day "Goodbye", not "Warm-up" (#260)', () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 9, theme: 'so-long-farewell', unlockAt: now - DAY_MS, tutorial: true, pool: 'farewell' })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 9, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);

    const header = document.querySelector('.board-header');
    expect(header?.querySelector('.daybar-name')?.textContent).toContain('Day 10 · So Long, Farewell');
    expect(header?.textContent).toContain('Goodbye');
    expect(header?.textContent).not.toContain('Warm-up');
  });
});

// specs/d15-text-size.md (#215): the per-Square auto-fit guard always wins
// over the S/M/L base — a long prompt shrinks below the CSS-resolved
// ceiling rather than overflowing or clipping; a short one is left at the
// ceiling. jsdom reports 0x0 for every element and resolves no real
// stylesheet cascade, so both the cell's live box (`getBoundingClientRect`)
// and its CSS-resolved ceiling (`getComputedStyle(...).fontSize`, which
// would otherwise need index.css's `clamp()` + `--text-scale` actually
// applied) are stubbed to realistic values for these tests only.
describe('Text size auto-fit guard (specs/d15-text-size.md)', () => {
  const REALISTIC_CELL_SIZE = 70; // px — a typical on-screen phone Square (5-col grid, ~360px viewport)
  const CEILING_PX = 12; // px — the Large base's CSS-resolved ceiling

  function stubMeasurement() {
    const realGetComputedStyle = window.getComputedStyle;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: REALISTIC_CELL_SIZE,
      height: REALISTIC_CELL_SIZE,
      top: 0,
      left: 0,
      right: REALISTIC_CELL_SIZE,
      bottom: REALISTIC_CELL_SIZE,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      if (el instanceof HTMLElement && el.classList.contains('cell-text')) {
        return { fontSize: `${CEILING_PX}px` } as CSSStyleDeclaration;
      }
      return realGetComputedStyle.call(window, el, pseudo ?? undefined);
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shrinks a maximally long seeded prompt below the Large ceiling rather than overflowing its Square', () => {
    stubMeasurement();
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'glamiators', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    const cells = dealt();
    const longPrompt =
      'Convinced an entire pool deck of strangers to sing a full sea shanty together during the sail-away party while the DJ egged everyone on';
    cells[0] = { ...cells[0], text: longPrompt };
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells };

    render(<Board />);

    const target = document.querySelector('.cell-text');
    expect(target).not.toBeNull();
    expect(target!.textContent).toBe(longPrompt);
    const shrunkSize = parseFloat((target as HTMLElement).style.fontSize);
    expect(shrunkSize).toBeGreaterThan(0);
    expect(shrunkSize).toBeLessThan(CEILING_PX);
  });

  it('leaves a short prompt at the ceiling, unshrunk', () => {
    stubMeasurement();
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'glamiators', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    const cells = dealt();
    cells[0] = { ...cells[0], text: 'Kissed a stranger' };
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells };

    render(<Board />);

    const target = document.querySelector('.cell-text') as HTMLElement;
    expect(target.textContent).toBe('Kissed a stranger');
    expect(parseFloat(target.style.fontSize)).toBe(CEILING_PX);
  });
});

// --- #261: Feed → Board square-opening intent -------------------------------

import { requestOpenSquare, __resetOpenSquareForTests } from '../hooks/useOpenSquare';

describe('Feed → Board square-opening intent (#261)', () => {
  it('switches to the intended Day and opens the sheet on that Prompt, then clears the intent', () => {
    __resetOpenSquareForTests();
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({ index: 0, theme: 'welcome-aboard', unlockAt: now - 2 * DAY_MS, tutorial: true, pool: 'embark' }),
        day({ index: 1, theme: 'get-sporty', unlockAt: now - DAY_MS }),
      ],
    } as unknown as EventDoc;
    // The suite's useDayBoard mock returns H.board for any requested Day; give
    // it the INTENDED Day's index so the switched view renders it.
    H.board = { uid: 'u1', dayIndex: 1, seed: 1, createdAt: 0, cells: dealt() };
    requestOpenSquare({ dayIndex: 1, itemId: 'i5' });

    render(<Board />);

    // The claim sheet opened on the intended Prompt (unmarked → pledge row).
    expect(screen.getByText(/Proof for/)).toBeInTheDocument();
    expect(screen.getByText(/Cross My Heart/)).toBeInTheDocument();
    __resetOpenSquareForTests();
  });

  it('drops the intent without opening anything when the Prompt is no longer on the card', () => {
    __resetOpenSquareForTests();
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'get-sporty', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
    requestOpenSquare({ dayIndex: 0, itemId: 'not-on-this-card' });

    render(<Board />);

    expect(screen.queryByText(/Proof for/)).not.toBeInTheDocument();
    __resetOpenSquareForTests();
  });
});

// --- #264: per-Day First to BINGO — pin write + daybar honor line ------------

describe('per-Day First to BINGO (#264)', () => {
  it('pins the Day honor on a bingo transition, attributed to the achieving Player', async () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'get-sporty', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
    H.player = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null, bingoCount: 0, squaresMarked: 0, firstBingoAt: null, blackout: false } as unknown as PlayerDoc;
    const marked = dealt().map((c, i) =>
      [0, 1, 2, 3, 4].includes(i)
        ? { ...c, marked: true, markedAt: (i + 1) * 10 }
        : i === 6
          ? { ...c, marked: true, markedAt: 999 }
          : c,
    );
    H.setMark.mockResolvedValue({ cells: marked, bingo: true, blackout: false, bingoTransition: true, blackoutTransition: false });

    render(<Board />);
    // Unmarking is instant (no sheet) — but here we tap an UNMARKED cell in
    // honor mode and take the pledge path? Simpler: tap a MARKED cell to
    // trigger doMark directly; the mocked setMark returns the transition.
    const cells = document.querySelectorAll('.grid .cell');
    fireEvent.click(cells[12]); // free cell — no-op sanity
    // Tap the pledge path: cell 3 is unmarked → sheet opens → pledge marks.
    fireEvent.click(cells[3]);
    fireEvent.click(screen.getByText(/Cross My Heart/));
    await act(async () => {});

    expect(H.pinDayFirstBingo).toHaveBeenCalledTimes(1);
    expect(H.pinDayFirstBingo.mock.calls[0][0]).toBe(0); // the VIEWED Day
    expect(H.pinDayFirstBingo.mock.calls[0][1]).toMatchObject({ uid: 'u1', displayName: 'Deck Daddy' });
    expect(H.pinDayFirstBingo.mock.calls[0][2]).toBe(50);
  });

  it('pins tutorial Day honors for finale data while the daybar keeps them hidden', async () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'welcome-aboard', unlockAt: now - DAY_MS, tutorial: true, pool: 'embark' })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
    H.player = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null, bingoCount: 0, squaresMarked: 0, firstBingoAt: null, blackout: false } as unknown as PlayerDoc;
    const marked = dealt().map((c, i) => (i === 3 ? { ...c, marked: true, markedAt: 1 } : c));
    H.setMark.mockResolvedValue({ cells: marked, bingo: true, blackout: false, bingoTransition: true, blackoutTransition: false });

    render(<Board />);
    const cells = document.querySelectorAll('.grid .cell');
    fireEvent.click(cells[3]);
    fireEvent.click(screen.getByText(/Cross My Heart/));
    await act(async () => {});

    expect(H.pinDayFirstBingo).toHaveBeenCalledTimes(1);
    expect(H.pinDayFirstBingo.mock.calls[0][0]).toBe(0);
    expect(H.enqueueHeldHonorPin).not.toHaveBeenCalled();
  });

  it('renders the daybar honor line for a pinned non-tutorial Day, and keeps the port on tutorial Days', () => {
    const now = Date.now();
    H.dayMeta = { firstBingo: { uid: 'u9', displayName: 'Theo', at: Date.UTC(2026, 6, 18, 11, 2) } };
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'glamiators', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);
    const meta = document.querySelector('.daybar-meta');
    expect(meta?.textContent).toContain('First to BINGO: Theo, 11:02');
  });

  it('falls back to the port line when a pinned honor carries an invalid timestamp', () => {
    const now = Date.now();
    H.dayMeta = { firstBingo: { uid: 'u9', displayName: 'Theo', at: 8.64e15 + 1 } };
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'glamiators', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);

    expect(document.querySelector('.daybar-meta')?.textContent).toContain('Port 0');
  });

  it('does not publish a held pin when the saved Day board no longer has BINGO', async () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({ index: 0, theme: 'glamiators', unlockAt: now - DAY_MS }),
        day({ index: 1, theme: 'get-sporty', unlockAt: now - DAY_MS }),
      ],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
    H.player = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null, bingoCount: 0, squaresMarked: 0, firstBingoAt: null } as unknown as PlayerDoc;
    H.takeHeldHonorPins.mockReturnValue([{ uid: 'u1', dayIndex: 1, at: now }]);
    H.getDoc.mockResolvedValue({ exists: () => true, data: () => ({ cells: dealt('held') }) });

    render(<Board />);
    await act(async () => {});

    expect(H.getDoc).toHaveBeenCalledTimes(1);
    expect(H.pinDayFirstBingo).not.toHaveBeenCalled();
  });

  it('requeues a held pin when saved-Day validation cannot read the board', async () => {
    const now = Date.now();
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [
        day({ index: 0, theme: 'glamiators', unlockAt: now - DAY_MS }),
        day({ index: 1, theme: 'get-sporty', unlockAt: now - DAY_MS }),
      ],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
    H.player = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null, bingoCount: 0, squaresMarked: 0, firstBingoAt: null } as unknown as PlayerDoc;
    H.takeHeldHonorPins.mockReturnValue([{ uid: 'u1', dayIndex: 1, at: now }]);
    H.getDoc.mockRejectedValue(new Error('offline'));

    render(<Board />);
    await act(async () => {});

    expect(H.pinDayFirstBingo).not.toHaveBeenCalled();
    expect(H.enqueueHeldHonorPin).toHaveBeenCalledWith('u1', 1, now);
  });

  it('keeps the port in the daybar when the Day has no pinned honor', () => {
    const now = Date.now();
    H.dayMeta = null;
    H.event = {
      claimMode: 'honor',
      timezone: 'UTC',
      days: [day({ index: 0, theme: 'glamiators', unlockAt: now - DAY_MS })],
    } as unknown as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);
    expect(document.querySelector('.daybar-meta')?.textContent).toContain('Port 0');
  });
});
