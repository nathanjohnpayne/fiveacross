import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { User } from 'firebase/auth';
import type { BoardDoc, Cell, MomentDoc, MomentKind, PlayerDoc, ProofDoc } from '../types';
import type { FeedEntry } from '../hooks/useData';

// specs/w2-feed-moments.md, component layer (RTL-jsdom). Two surfaces:
//
// Board — broadcasts a Moment at the EXISTING BINGO/Blackout edge (Board's
// wasBingo/wasBlackout refs + celebrate effect): a first BINGO fires exactly ONE
// bingo Moment on the TRANSITION into having a bingo (not on every completed line
// or every render); a Blackout fires one; First-to-BINGO fires only when the
// known-players roster (the same data the Leaderboard pin reads) shows no other
// Player has bingoed yet; and a bare Mark that completes no line broadcasts
// nothing. The broadcasts themselves are stubbed (the write shape is
// src/data/w2-feed-moments.test.ts); the board updates arrive the way the live
// listener delivers them — a new board snapshot — so we drive them via rerender.
//
// ProofFeed — Proofs and Moments render merged newest-first; a Moment shows as a
// celebratory line with NO media and NO report/delete affordances, a Proof keeps
// them; an empty Feed (what a bare Mark leaves) shows the empty state. The
// newest-first SORT itself is unit-tested on mergeFeed in the data suite; here we
// feed an already-merged list and pin that ProofFeed renders it in order + per kind.

const H = vi.hoisted(() => ({
  user: null as User | null,
  board: null as BoardDoc | null,
  boardConfirmed: true,
  player: null as PlayerDoc | null,
  playerLoading: false,
  playerConfirmed: true,
  players: [] as PlayerDoc[],
  rosterConfirmed: true,
  feedEntries: [] as FeedEntry[],
  bannedUids: [] as string[],
  days: undefined as import('../types').DayDef[] | undefined,
  feedTallyCards: [] as import('../types').TallyCard[],
  // EVERY claim tap opens ProofSheet now (issue #181): in 'honor' the mocked
  // sheet's pledge trigger completes the bare doMark; 'proof_required' uses its
  // submit trigger so the proofed completion path (PR #110 round 2 finding 1)
  // is drivable too.
  claimMode: 'honor' as 'honor' | 'proof_required' | 'admin_confirmed',
  // What the mocked ProofSheet reports via onAttached — the attachProof verdict.
  proofAttachResult: null as unknown,
  setMark: vi.fn(),
  broadcastBingo: vi.fn(),
  broadcastBlackout: vi.fn(),
  broadcastFirstBingo: vi.fn(),
  hasPriorBingoWitness: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
// ProofFeed navigates to the Card tab from Tally Card actions (#261); mock
// the router hook so these router-free renders keep working.
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user, loading: false }) }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useBoard: () => ({ data: H.board, loading: false, hasServerData: H.boardConfirmed }),
  useDayBoard: () => ({ data: H.board, loading: false, hasServerData: H.boardConfirmed }),
  useMyPlayer: () => ({ data: H.player, loading: H.playerLoading, hasServerData: H.playerConfirmed }),
  useEventDoc: () => ({ data: { claimMode: H.claimMode, bannedUids: H.bannedUids, days: H.days }, loading: false }),
  useItems: (enabled = true) => ({ items: [], loading: false, hasServerData: enabled }),
  useTally: () => ({ markers: [], count: 0, loading: false, hasServerData: true }),
  useLeaderboard: () => ({ players: H.players, loading: false, hasServerData: H.rosterConfirmed }),
  useFeed: () => ({ entries: H.feedEntries, tallyCards: H.feedTallyCards, loading: false }),
  useMyDayBoards: () => new Map(),
  useAllDoubts: () => ({ doubts: [], loading: false, hasServerData: true }),
  // specs/feed-hearts.md: the Feed's flat hearts stream — empty here; the
  // hearts surface has its own suite (feed-hearts.test.tsx).
  useAllHearts: () => ({ hearts: [], loading: false, hasServerData: true }),
  // Board subscribes the per-Square Doubt count + the Feed's Proofs for the #33
  // satisfied derivation. These Moment-edge fixtures never open the Tally sheet or
  // assert a Doubt count, so empty streams keep them focused on the edge machinery.
  useDoubts: () => ({ doubts: [], count: 0, loading: false, hasServerData: true }),
  // Board now reads its viewer-scoped own Proofs for the DoubtBadge (#106 finding 4)
  // instead of the Board-wide proof feed; the item-scoped sheet query only mounts
  // with the Tally sheet, which these edge fixtures never open.
  useMyProofs: () => ({ proofs: [], loading: false, hasServerData: true }),
  useProofsForItemText: () => ({ proofs: [], loading: false, hasServerData: true }),
}));
// Keep the REAL resolveDisplayName (Board feeds its resolved output to the actor);
// stub the write path.
vi.mock('../data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/api')>();
  return { ...actual, setMark: H.setMark };
});
// Keep the REAL module-scope pending queue (enqueue/peek/clear/reset) so the tests
// exercise the actual hold→drain machinery that survives unmounts (issue #104);
// stub only the terminal broadcasts + the durable-witness cache read. The queue
// functions are pure module state (no Firestore), so loading the real module is
// safe under the mocked ../firebase.
vi.mock('../data/moments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/moments')>();
  return {
    ...actual,
    broadcastBingo: H.broadcastBingo,
    broadcastBlackout: H.broadcastBlackout,
    broadcastFirstBingo: H.broadcastFirstBingo,
    hasPriorBingoWitness: H.hasPriorBingoWitness,
  };
});
vi.mock('../data/proofs', () => ({
  reportProof: vi.fn(() => Promise.resolve()),
  deleteProof: vi.fn(() => Promise.resolve()),
}));
// The mocked sheet exposes the COMPLETION path (PR #110 round 2 finding 1): its
// submit trigger reports H.proofAttachResult through onAttached — the verdict a
// real attachProof returns — then closes, exactly like the real sheet's submit.
// The real capture/submit flow is w2-proof-capture.test.tsx; here only the
// verdict hand-off to Board matters.
// It also exposes the 🎖️ pledge trigger (issue #181): Board passes onPledge on
// every CLAIM open, and the mock mirrors the real sheet's honor-only gate by
// disabling it in stricter modes (a disabled button swallows the click).
vi.mock('./ProofSheet', () => ({
  default: (props: {
    claimMode: 'honor' | 'proof_required' | 'admin_confirmed';
    onAttached?: (res: unknown) => void;
    onPledge?: () => void;
    onClose: () => void;
  }) => (
    <>
      {props.onPledge && (
        <button disabled={props.claimMode !== 'honor'} onClick={props.onPledge}>
          pledge
        </button>
      )}
      <button
        onClick={() => {
          if (H.proofAttachResult) props.onAttached?.(H.proofAttachResult);
          props.onClose();
        }}
      >
        submit-proof
      </button>
    </>
  ),
}));
vi.mock('./Celebration', () => ({ default: () => null }));

import Board from './Board';
import ProofFeed from './ProofFeed';
// Real (importOriginal keeps the actual queue): peekPendingMoments lets these tests
// assert the module queue state directly, alongside the behavioral broadcast spies.
import { resetPendingMoments, peekPendingMoments } from '../data/moments';

// A dealt board with `marked` non-free Squares on (plus the always-on free centre).
function dealtWith(marked: number[]): Cell[] {
  const on = new Set(marked);
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `i${index}`,
    text: index === 12 ? 'FREE' : `p${index}`,
    free: index === 12,
    marked: index === 12 || on.has(index),
    markedAt: index === 12 || on.has(index) ? 1 : null,
  }));
}
// `uid` defaults to u1; the account-switch tests build the OTHER account's board
// (BoardDoc carries its owner's uid — the attribution Board checks, finding B).
const boardWith = (marked: number[], uid = 'u1'): BoardDoc => ({ uid, dayIndex: 0, seed: 1, createdAt: 0, cells: dealtWith(marked) });
const ROW0 = [0, 1, 2, 3, 4]; // a completed line → BINGO
const FULL_CARD = Array.from({ length: 25 }, (_, i) => i).filter((i) => i !== 12); // → Blackout

// Drain microtasks: doMark awaits setMark, then the async durable-witness check
// (hasPriorBingoWitness, finding D), then drains the queue — assertions must let
// that whole chain settle first.
const flushAsync = () => act(async () => {});

// The default (non-winning) setMark verdict; each winning test overrides the win
// transition fields per click. Broadcasts now ride setMark's SYNCHRONOUS verdict
// (issue #104), so tests drive wins by CLICKING a Square with the verdict set.
type Verdict = { bingo: boolean; blackout: boolean; bingoTransition: boolean; blackoutTransition: boolean };
const NO_WIN: Verdict = { bingo: false, blackout: false, bingoTransition: false, blackoutTransition: false };

// Click a Square (honor mode marks straight through to doMark) with a given win
// verdict from setMark. `label` must be an on-screen Square text (`p<index>`); a
// non-marked Square marks, a marked Square unmarks. setMark is stubbed, so the
// board does NOT auto-advance — a test rerenders H.board to simulate the live
// listener's next snapshot, or clicks another Square for a further action.
// `cellsAfter` is the FOLDED post-action board setMark returns (res.cells): the
// drain revalidates the just-enqueued win against it at fire time (PR #110
// finding 3), so a winning click must return cells in which the win stands.
// Defaults to the currently rendered board — adequate for non-winning actions.
async function clickMark(label: string, verdict: Partial<Verdict> = {}, cellsAfter?: Cell[]) {
  H.setMark.mockResolvedValueOnce({ cells: cellsAfter ?? H.board?.cells ?? [], ...NO_WIN, ...verdict });
  await act(async () => {
    fireEvent.click(screen.getByText(label));
  });
  // A CLAIM tap opens the sheet now (issue #181); the 🎖️ pledge completes the
  // honor Mark. An UNMARK tap stays instant — no sheet, so no trigger renders.
  const pledge = screen.queryByText('pledge');
  if (pledge) {
    await act(async () => {
      fireEvent.click(pledge);
    });
  }
  await flushAsync(); // settle doMark's setMark → witness → enqueue → drain chain
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPendingMoments(); // the pending queue is module state that survives unmounts
  H.user = { uid: 'u1', displayName: 'Sailor', photoURL: null } as unknown as User;
  H.board = null;
  H.boardConfirmed = true;
  H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
  H.playerLoading = false;
  H.playerConfirmed = true;
  H.players = [];
  H.rosterConfirmed = true;
  H.feedEntries = [];
  H.bannedUids = [];
  H.days = undefined;
  H.feedTallyCards = [];
  H.claimMode = 'honor';
  H.proofAttachResult = null;
  H.setMark.mockResolvedValue({ cells: [], ...NO_WIN });
  H.hasPriorBingoWitness.mockResolvedValue(false); // fresh device / no prior win
});

// The attachProof verdict the mocked ProofSheet reports on submit (same shape as
// setMark's return — that sameness IS finding 1's fix).
function attachVerdict(cellsAfter: Cell[], verdict: Partial<Verdict> = {}) {
  return { cells: cellsAfter, ...NO_WIN, ...verdict };
}

describe('Board — broadcasts Moments on the ACTION path (specs/w2-feed-moments.md, issue #104)', () => {
  // Moments now broadcast off setMark's SYNCHRONOUS win-transition verdict, consumed
  // in doMark (a click), NOT off snapshot diffing. So these tests drive wins by
  // CLICKING a Square (with the mocked verdict set) and assert a passive board
  // re-render never broadcasts. The prior snapshot-diff suite drove wins by
  // rerendering H.board; those cases are REPLACED here with click-driven equivalents,
  // or — where the mechanism is gone entirely — with the structural invariant that
  // survived (a passive snapshot is never a broadcast).

  it('broadcasts a first BINGO on the completing MARK — not on init, not on a passive re-render', async () => {
    H.board = boardWith([0, 1, 2, 3]); // row 0 one Square shy
    const { rerender } = render(<Board />);
    // Initialisation (a passive first paint) must NOT broadcast — a returning Player
    // whose bingo already stood mustn't re-announce it.
    expect(H.broadcastBingo).not.toHaveBeenCalled();

    // The player's tap completes the line → setMark's bingoTransition verdict fires it
    // (the folded res.cells carry the standing win the drain revalidates against).
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(
      { uid: 'u1', displayName: 'Deck Daddy', photoURL: null },
      undefined,
      'test-event',
    );

    // A passive snapshot reflecting the mark (the live listener's echo) is NOT a
    // fresh action — it must not re-broadcast.
    H.board = boardWith(ROW0);
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
  });

  it('a bare Mark that completes no line broadcasts nothing (ADR 0002)', async () => {
    H.board = boardWith([]);
    render(<Board />);
    await clickMark('p0'); // NO_WIN verdict: neither transition
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastBlackout).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('claims First-to-BINGO when the roster shows no other Player has bingoed yet — the clean witness path enqueues exactly once (PR #110 finding 1 pair)', async () => {
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    H.board = boardWith([0, 1, 2, 3]);
    render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
    // Legacy (no schedule): no tutorial exclusion rides the witness read (#288).
    expect(H.hasPriorBingoWitness).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        excludeDayIndexes: undefined,
        selfWriteGeneration: expect.any(Number),
        eventId: 'test-event',
      }),
    ); // the witness-gated candidate
  });

  it('does NOT claim First-to-BINGO when another Player already has a firstBingoAt', async () => {
    H.players = [{ uid: 'someone-else', firstBingoAt: 123 } as unknown as PlayerDoc];
    H.board = boardWith([0, 1, 2, 3]);
    render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1); // their own first BINGO still posts
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // but not the ceremonial first
  });

  it('broadcasts a Blackout on the full-card MARK, without re-firing the BINGO', async () => {
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0)); // BINGO edge first
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);

    // The listener echoes the mark, then the player fills the rest of the card.
    H.board = boardWith(FULL_CARD.filter((i) => i !== 24));
    rerender(<Board />);
    await clickMark('p24', { bingo: true, blackout: true, blackoutTransition: true }, dealtWith(FULL_CARD));
    expect(H.broadcastBlackout).toHaveBeenCalledTimes(1);
    // No Day stamped on this LEGACY (non-daily) fixture — `useEventDoc` here
    // carries no `days[]`, so `hasDays` is false and the enqueue passes no
    // dayIndex (fix/d15-blackout-day-naming, Codex finding 1): a legacy Event
    // has no Day schedule to render a chip from, so `board.dayIndex`'s default
    // of 0 must NOT leak in as a misleading "Day 1". The drain's legacy branch
    // (#267: an EMPTY pending-day set) broadcasts day-less — single-arg call,
    // keeping the once-per-Player `${uid}-blackout` id. The daily-cards case
    // (real dayIndexes threaded through) is unit-tested directly at the
    // pending-queue layer — src/data/w2-feed-moments.test.ts's
    // `pendingBlackoutDayIndexes` suite — since this fixture's mocks don't
    // model a Day schedule.
    expect(H.broadcastBlackout).toHaveBeenCalledWith(
      { uid: 'u1', displayName: 'Deck Daddy', photoURL: null },
      undefined,
      'test-event',
    );
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1); // not re-announced (bingoTransition false)
  });

  it('HOLDS a broadcast made while identity is UNKNOWN, then fires it once with the SAVED name (PR #99 finding 1)', async () => {
    // Identity UNKNOWN: the player row is still loading, so `displayName` has fallen
    // back to the auth name — the same window setMark passes `undefined`. A win here
    // must NOT stamp that stale name into an immutable Moment; the queue HOLDS it
    // until identity resolves (and — the #104 fix — the queue is module state, so the
    // hold survives an unmount; see the dedicated remount test below).
    H.playerLoading = true;
    H.player = null;
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);

    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // held — not the stale name

    // The listener echoes the win (the held flag revalidates against these cells
    // when the gate opens — a HELD WIN STILL STANDING drains; PR #110 finding 3).
    H.board = boardWith(ROW0);
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // still held: identity is the gate

    // Identity resolves to the SAVED name → the gate-open drain fires it ONCE.
    H.playerLoading = false;
    H.playerConfirmed = true;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(
      { uid: 'u1', displayName: 'Deck Daddy', photoURL: null },
      undefined,
      'test-event',
    );
  });

  it('the held broadcast SURVIVES a Board unmount and drains on remount — the headline #104 fix', async () => {
    // Win while identity is unknown → held in the MODULE queue…
    H.playerLoading = true;
    H.player = null;
    H.board = boardWith([0, 1, 2, 3]);
    const { unmount } = render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // held

    // …the Player navigates off the Card route: Board UNMOUNTS. The old
    // component-ref queue died here (the bug this issue fixes); the module queue
    // does not.
    unmount();

    // Identity has since resolved; the Player returns to the Card — a fresh Board
    // MOUNT sees the gate open and drains the still-queued win exactly once, with the
    // saved name.
    H.playerLoading = false;
    H.playerConfirmed = true;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    H.board = boardWith(ROW0);
    render(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(
      { uid: 'u1', displayName: 'Deck Daddy', photoURL: null },
      undefined,
      'test-event',
    );
  });

  it('HOLDS First-to-BINGO while the roster is unconfirmed, then does NOT claim it if the confirmed roster shows an earlier bingo (PR #99 finding 2)', async () => {
    // An initial empty roster from a still-loading subscription is NOT proof nobody
    // has bingoed. The player's own BINGO posts (identity is known); the ceremonial
    // First-to-BINGO is held until the roster is server-confirmed.
    H.rosterConfirmed = false;
    H.players = [];
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1); // own BINGO posts
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // ceremonial claim HELD, not guessed

    // The listener echoes the win; the held ceremonial candidate revalidates
    // against these cells when the roster gate opens.
    H.board = boardWith(ROW0);
    rerender(<Board />);

    // Roster confirms — and another Player already had a firstBingoAt: not first.
    H.rosterConfirmed = true;
    H.players = [{ uid: 'someone-else', firstBingoAt: 123 } as unknown as PlayerDoc];
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('HOLDS First-to-BINGO while the roster is unconfirmed, then CLAIMS it once the confirmed roster shows no earlier bingo (PR #99 finding 2)', async () => {
    H.rosterConfirmed = false;
    H.players = [];
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // held while unconfirmed

    H.board = boardWith(ROW0); // the listener echoes the standing win
    rerender(<Board />);

    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc]; // only self
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
  });

  it('a win completed while identity was UNKNOWN, then UNMARKED before it resolves, does NOT post (action-driven falling edge — finding A preserved)', async () => {
    H.playerLoading = true;
    H.player = null;
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);

    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0)); // held
    expect(H.broadcastBingo).not.toHaveBeenCalled();

    // The player unmarks a Square and LOSES the win while still held. The unmark's
    // verdict (no standing bingo) DROPS the queued broadcast — the ACTION-path
    // replacement for PR #99 round 2 finding A's snapshot falling edge — and the
    // queue is verifiably empty afterwards.
    await clickMark('p0', { bingo: false, bingoTransition: false });
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });

    // Identity resolves: the queue is empty, so nothing fires.
    H.playerLoading = false;
    H.playerConfirmed = true;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('a lose-then-REGAIN while held re-queues legitimately — exactly one write once the gate opens (finding A)', async () => {
    H.playerLoading = true;
    H.player = null;
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);

    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0)); // queue while held
    await clickMark('p0', { bingo: false, bingoTransition: false }); // unmark drops it
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0)); // remark re-queues
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // still held (identity unknown)

    H.board = boardWith(ROW0); // the listener echoes the regained win
    rerender(<Board />);

    H.playerLoading = false;
    H.playerConfirmed = true;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1); // the regained win, exactly once
  });

  it('suppresses the ceremonial First-to-BINGO for a REGAINED line when the durable witness exists (round 2 finding D)', async () => {
    // First win: no witness yet — both the bingo and the ceremonial first post.
    H.board = boardWith([0, 1, 2, 3]);
    render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
    expect(H.hasPriorBingoWitness).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        excludeDayIndexes: undefined,
        selfWriteGeneration: expect.any(Number),
        eventId: 'test-event',
      }),
    );

    // The player unmarks the line (firstBingoAt is volatile and clears with it)…
    await clickMark('p0', { bingo: false, bingoTransition: false });
    // …and the broadcast Moment doc is now the durable witness in the local cache.
    H.hasPriorBingoWitness.mockResolvedValue(true);

    // Regaining a line still attempts the plain bingo Moment (skipped by the writer's
    // write-once cache pre-check, or denied server-side on a cold cache — fine), but
    // must NOT re-queue the ceremonial event singleton: the player was not first EVER.
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).toHaveBeenCalledTimes(2); // plain bingo write still attempted
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1); // NOT re-claimed
  });

  it('fires for the player’s OWN mark completing a line on a still-UNCONFIRMED board — the offline win is queued, not swallowed (round 3 finding A, now natural)', async () => {
    // Offline reload: the board hydrates from cache only and never confirms until
    // reconnect. The action path broadcasts off the mark's verdict regardless of
    // board confirmation — the Moment `setDoc` pends offline (ADR 0006). No
    // local-action-vs-hydration disambiguation is needed anymore (finding A moot).
    H.boardConfirmed = false;
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(
      { uid: 'u1', displayName: 'Deck Daddy', photoURL: null },
      undefined,
      'test-event',
    );

    // Reconnect: the server confirmation of the SAME standing win is a PASSIVE
    // snapshot, not a mark — nothing fires twice.
    H.boardConfirmed = true;
    H.board = boardWith(ROW0);
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
  });

  it('each offline mark carries its own verdict — the winning tap fires, the non-winning one does not (round 4 finding A moot)', async () => {
    // Two fast offline taps: the first completes no line, the second completes row 0.
    // With broadcasts on the action path each mark's verdict is independent, so the
    // round-4 "count local snapshots so the winning one is still live" machinery is
    // gone — there is no shared snapshot counter to lose the winning edge to.
    H.boardConfirmed = false;
    H.board = boardWith([0, 1, 2]);
    const { rerender } = render(<Board />);

    await clickMark('p3', { bingo: false, bingoTransition: false }); // non-winning tap
    expect(H.broadcastBingo).not.toHaveBeenCalled();

    H.board = boardWith([0, 1, 2, 3]); // listener echoes the first tap
    rerender(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0)); // the winning tap
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
  });

  it('a passive board snapshot never broadcasts — cache-only → server-confirmed revealing a standing bingo stays silent (finding C, now structural)', async () => {
    // No click anywhere: broadcasts ride the action path, so a board arriving via the
    // listener (cache then server) — even one revealing a standing bingo — is never a
    // broadcast. This structurally subsumes the round-2 cache-hydration baseline and
    // the round-3 passive-unconfirmed-snapshot case.
    H.boardConfirmed = false;
    H.board = boardWith([]);
    const { rerender } = render(<Board />);

    H.boardConfirmed = true;
    H.board = boardWith(ROW0); // server confirmation reveals a standing bingo
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastBlackout).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('an account switch onto a new uid’s standing-bingo board broadcasts nothing (findings 5 + B, now structural)', async () => {
    H.board = boardWith([], 'u1');
    const { rerender } = render(<Board />);
    expect(H.broadcastBingo).not.toHaveBeenCalled();

    // Switch to u2 whose FIRST snapshot already has a standing bingo — a PASSIVE
    // snapshot, not a mark, so nothing fires for u2. (The per-uid queue also keeps a
    // held u1 win from ever draining under u2.)
    H.user = { uid: 'u2', displayName: 'Sailor', photoURL: null } as unknown as User;
    H.player = { displayName: 'Second Sailor', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    H.board = boardWith(ROW0, 'u2');
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('a held blackout with the board GONE at gate-open publishes NOTHING — no vacuous isBlackout([]) adjudication (round 3 finding B, preserved on the drain path — PR #110 finding 3)', async () => {
    // The drain revalidates against the CURRENT attributable cells at fire time and
    // requires a NON-EMPTY board before ANY publish: isBlackout([]) is vacuously
    // TRUE ([].every(Boolean)), so adjudicating an empty board would publish a
    // blackout for a board that no longer exists. A held win with no board is HELD
    // (never fired, never vacuously dropped); it fires only when a board showing
    // the win standing is back.
    H.playerLoading = true;
    H.player = null;
    H.board = boardWith(FULL_CARD.filter((i) => i !== 24));
    const { rerender } = render(<Board />);
    await clickMark('p24', { bingo: true, blackout: true, blackoutTransition: true }, dealtWith(FULL_CARD));
    expect(H.broadcastBlackout).not.toHaveBeenCalled(); // held (identity unknown)

    H.board = null; // the board doc disappears (deleted / not yet delivered)
    rerender(<Board />);

    H.playerLoading = false;
    H.playerConfirmed = true;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);
    await flushAsync();
    // Gate open, but NO attributable board: the drain must neither fire (vacuous
    // isBlackout([])) nor drop (the win may still stand server-side). Nothing posts.
    expect(H.broadcastBlackout).not.toHaveBeenCalled();

    // The board returns with the blackout still standing: the snapshot drain
    // revalidates against real cells and fires exactly once.
    H.board = boardWith(FULL_CARD);
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBlackout).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // no bingo transition was ever queued
  });

  it('does NOT enqueue First-to-BINGO when the win falls while the witness read is in flight — the action generation invalidates the stale continuation (PR #110 finding 1, P1)', async () => {
    // Identity is KNOWN throughout (the drain is live) — the hazard is purely the
    // async gap between `await hasPriorBingoWitness()` and its continuation.
    H.board = boardWith([0, 1, 2, 3]);
    render(<Board />);

    // The witness read HANGS: the winning tap enqueues the bingo and suspends
    // before the ceremonial enqueue AND before doMark's drain.
    let resolveWitness!: (v: boolean) => void;
    H.hasPriorBingoWitness.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveWitness = resolve; }),
    );
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // suspended at the witness read

    // The player unmarks and LOSES the bingo while the read is still in flight:
    // the unmark verdict drops the queued flags and bumps the action generation.
    await clickMark('p0', { bingo: false, bingoTransition: false });

    // The stale continuation resolves (no witness): the generation changed and the
    // pending bingo flag is gone — it must NOT re-enqueue the ceremonial candidate,
    // or a later drain would publish the IMMUTABLE event singleton for a win that
    // no longer stands. (The clean-path pair — witness resolves with no interleaved
    // action → enqueues exactly once — is the "claims First-to-BINGO" test above;
    // the non-falling-unmark pair — round 4 — is the next test.)
    resolveWitness(false);
    await flushAsync();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // the fallen win published nothing
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });

  it('a NON-falling unmark while the witness read is in flight does NOT forfeit the ceremony — the bingo stood the whole time (PR #110 round 4)', async () => {
    // The player has four of row 0 plus an unrelated Square 5 marked; the tap on
    // p4 completes the FIRST bingo and its witness read HANGS.
    H.board = boardWith([0, 1, 2, 3, 5]);
    render(<Board />);
    let resolveWitness!: (v: boolean) => void;
    H.hasPriorBingoWitness.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveWitness = resolve; }),
    );
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith([...ROW0, 5]));
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // suspended at the witness read

    // The player unmarks the UNRELATED Square 5 while the read is in flight: the
    // verdict shows the bingo STILL STANDING (row 0 intact), so nothing fell and
    // nothing was un-witnessed. Before round 4 this unconditional-bumped the
    // generation and the resolving continuation refused the ceremonial — a valid
    // First-to-BINGO lost to an unrelated unmark.
    await clickMark('p5', { bingo: true, bingoTransition: false }, dealtWith(ROW0));

    // The read resolves clean: the generation is unchanged (no bingo fell), so the
    // candidate enqueues, drains, and fires — exactly once, alongside the bingo.
    resolveWitness(false);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });

  it('a tap on a STALE previous-uid board is a NO-OP — no setMark write, no enqueue (PR #110 finding 2)', async () => {
    // u1's board renders under u1…
    H.board = boardWith([0, 1, 2, 3], 'u1');
    const { rerender } = render(<Board />);

    // …then the account switches to u2 while the subscription still exposes u1's
    // board for this render. A tap here would fold u1's cells into u2's board
    // write and feed its verdict into a Moment attributed to u2 — doMark must
    // bail on the shared attribution guard before calling setMark at all.
    H.user = { uid: 'u2', displayName: 'Sailor', photoURL: null } as unknown as User;
    H.player = { displayName: 'Second Sailor', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);

    expect(screen.queryByText('p4')).toBeNull();
    expect(H.setMark).not.toHaveBeenCalled(); // the write itself would be wrong — never issued
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
    expect(peekPendingMoments('u2')).toEqual({ bingo: false, blackout: false, firstBingo: false });
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('a held win unmarked from ANOTHER SOURCE (passive falling-edge snapshot) never publishes — the queued flag is cleared (PR #110 finding 3)', async () => {
    // The win holds behind the identity gate…
    H.playerLoading = true;
    H.player = null;
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // held

    // …the listener echoes the standing win…
    H.board = boardWith(ROW0);
    rerender(<Board />);
    await flushAsync();

    // …then ANOTHER TAB unmarks it: the fall arrives as a PASSIVE snapshot
    // (bingo true→false in listener data) with no local unmark verdict. The
    // falling-edge observer clears the queued flags (and bumps the generation).
    H.board = boardWith([0, 1, 2, 3]);
    rerender(<Board />);
    await flushAsync();
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });

    // Identity resolves: the drain finds nothing — no Moment for a fallen win.
    H.playerLoading = false;
    H.playerConfirmed = true;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
    expect(H.broadcastBlackout).not.toHaveBeenCalled();
  });

  it('a proof_required win broadcasts its Moment from the attach verdict — the proofed path rides the same pipeline (PR #110 round 2 finding 1)', async () => {
    H.claimMode = 'proof_required';
    H.board = boardWith([0, 1, 2, 3]); // row 0 one Square shy
    render(<Board />);

    // Tapping the unmarked fifth Square opens ProofSheet instead of marking — the
    // proof gate means doMark/setMark never run for this win.
    await act(async () => {
      fireEvent.click(screen.getByText('p4'));
    });
    expect(H.setMark).not.toHaveBeenCalled();

    // A successful attach reports the SAME verdict shape setMark returns, and the
    // completion path enqueues + drains exactly like an honor win.
    H.proofAttachResult = attachVerdict(dealtWith(ROW0), { bingo: true, bingoTransition: true });
    await act(async () => {
      fireEvent.click(screen.getByText('submit-proof'));
    });
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(
      { uid: 'u1', displayName: 'Deck Daddy', photoURL: null },
      undefined,
      'test-event',
    );
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1); // witness clean + roster clean
    expect(H.hasPriorBingoWitness).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        excludeDayIndexes: undefined,
        selfWriteGeneration: expect.any(Number),
        eventId: 'test-event',
      }),
    ); // same ceremonial gauntlet
  });

  it('a proofed Mark that completes no line broadcasts nothing (finding 1)', async () => {
    H.claimMode = 'proof_required';
    H.board = boardWith([]);
    render(<Board />);
    await act(async () => {
      fireEvent.click(screen.getByText('p0'));
    });
    H.proofAttachResult = attachVerdict(dealtWith([0])); // no transition in the verdict
    await act(async () => {
      fireEvent.click(screen.getByText('submit-proof'));
    });
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastBlackout).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('an unmark after a proofed win still clears the held broadcast via the verdict path (finding 1)', async () => {
    // The proofed win completes while identity is UNKNOWN → held in the queue.
    H.claimMode = 'proof_required';
    H.playerLoading = true;
    H.player = null;
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    await act(async () => {
      fireEvent.click(screen.getByText('p4'));
    });
    H.proofAttachResult = attachVerdict(dealtWith(ROW0), { bingo: true, bingoTransition: true });
    await act(async () => {
      fireEvent.click(screen.getByText('submit-proof'));
    });
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // held (identity unknown)

    // The listener echoes the proofed win, then the player UNMARKS a marked Square
    // (unmark is instant in every claim mode → doMark) and the win falls: the
    // unmark VERDICT drops the held broadcast — one falling-edge path for both
    // completing paths.
    H.board = boardWith(ROW0);
    rerender(<Board />);
    await flushAsync();
    await clickMark('p0', { bingo: false, bingoTransition: false });
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });

    // Identity resolves: nothing to drain — no Moment for the fallen proofed win.
    H.playerLoading = false;
    H.playerConfirmed = true;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
  });

  it('the ceremonial survives its own plain-bingo drain mid-witness-read — the over-tight flag recheck is gone (PR #110 round 2 finding 2)', async () => {
    // Identity UNKNOWN at the winning tap; the witness read HANGS.
    H.playerLoading = true;
    H.player = null;
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    let resolveWitness!: (v: boolean) => void;
    H.hasPriorBingoWitness.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveWitness = resolve; }),
    );
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).not.toHaveBeenCalled(); // held; witness in flight

    // The gate OPENS while the read is in flight: the echo lands and identity
    // resolves — the gate-open drain legitimately FIRES the plain bingo (clearing
    // its flag) before the ceremonial continuation has run.
    H.board = boardWith(ROW0);
    rerender(<Board />);
    H.playerLoading = false;
    H.playerConfirmed = true;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1); // the plain bingo drained mid-read

    // The witness resolves clean: the win stood the whole time and no prior win
    // exists — the ceremonial must proceed. (Round 1's pending-flag recheck wrongly
    // forfeited it here: the drain-fire clear says the win STOOD, not that it fell.
    // The generation is unchanged — no unmark, no fall — so the candidate enqueues
    // and publishes.)
    resolveWitness(false);
    await flushAsync();
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
  });

  // Latency-compensation-faithful witness (PR #110 round 3): a REAL getDocFromCache
  // sees this tab's own just-written Moments immediately, so the faithful model is
  // "witnessed ⟺ a bingo Moment for that uid was already broadcast". Round 2's
  // stubbed always-false/always-true witness hid finding A; these tests use the
  // faithful model wherever the cache behavior is what is being pinned.
  function useLatencyFaithfulWitness() {
    H.hasPriorBingoWitness.mockImplementation((uid: string) =>
      Promise.resolve(
        H.broadcastBingo.mock.calls.some((c) => (c[0] as { uid: string }).uid === uid),
      ),
    );
  }

  it('a roster-held ORIGINAL win fires its ceremonial once the roster opens — no self-suppression by its own plain bingo (PR #110 round 3 finding A)', async () => {
    useLatencyFaithfulWitness();
    // Identity known, roster UNCONFIRMED: the win passes its BIRTH-TIME witness
    // (nothing posted yet), the plain bingo fires in this earlier drain pass, and
    // the ceremonial candidate holds at the roster gate.
    H.rosterConfirmed = false;
    H.players = [];
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1); // its Moment is now IN THE CACHE
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // roster-held

    // The roster opens with no competitor. Under round 2's drain-time witness
    // re-read, the faithful cache now returned TRUE (this pipeline's own bingo!)
    // and suppressed the original win's ceremony. The prior-win question was
    // answered at BIRTH; the publish decision is synchronous — it must FIRE.
    H.board = boardWith(ROW0);
    rerender(<Board />);
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
  });

  it('a ceremonial candidate surviving an unmount + unobserved fall + same-load regain fires as the ORIGINAL win’s claim (round 2 finding 3, re-analyzed in round 3)', async () => {
    useLatencyFaithfulWitness();
    // Identity known, roster UNCONFIRMED: birth-time witness clean → candidate
    // enqueued; the plain bingo fires and is cached.
    H.rosterConfirmed = false;
    H.players = [];
    H.board = boardWith([0, 1, 2, 3]);
    const { unmount } = render(<Board />);
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // roster-held

    // Unmount; the win falls UNOBSERVED (no snapshot, no bump); the player regains
    // the line in the same page load. The REGAIN mints no fresh candidate — its
    // birth-time witness (faithful cache) sees the posted bingo. The surviving
    // candidate is the ORIGINAL win's claim: in-tab, an unobserved fall is by
    // definition indistinguishable from the win having stood the whole time
    // (finding A), so the claim fires — crediting the same player whose real,
    // birth-witnessed first win raised it; a competing player is still caught by
    // the publish-time roster below, and the singleton create-once backstop holds.
    unmount();
    H.rosterConfirmed = true;
    H.players = [{ uid: 'u1', firstBingoAt: null } as unknown as PlayerDoc];
    H.board = boardWith([0, 1, 2, 3]); // remount pre-regain: no line standing
    const { rerender } = render(<Board />);
    await flushAsync();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // held: no bingo stands yet

    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0)); // the regain
    await flushAsync();
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1); // the original claim, exactly once
    expect(H.hasPriorBingoWitness).toHaveBeenCalledTimes(2); // birth-time only: one per completing mark
    rerender(<Board />);
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });

  it('the publish-time roster gate drops a claim that went stale while the witness read was in flight (PR #110 round 3 finding B)', async () => {
    // Roster UNCONFIRMED at the winning tap; the birth witness read HANGS.
    H.rosterConfirmed = false;
    H.players = [];
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    let resolveWitness!: (v: boolean) => void;
    H.hasPriorBingoWitness.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveWitness = resolve; }),
    );
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));

    // While the read is in flight the leaderboard delivers ANOTHER player's
    // EARLIER firstBingoAt (roster confirms). The decision must be made against
    // THIS roster — at publish time — not the empty one the tap saw.
    H.board = boardWith(ROW0);
    rerender(<Board />);
    H.rosterConfirmed = true;
    H.players = [{ uid: 'someone-else', firstBingoAt: 123 } as unknown as PlayerDoc];
    rerender(<Board />);
    await flushAsync();

    resolveWitness(false); // witness clean — but the ceremony is no longer theirs
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1); // their own bingo still posts
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled(); // decided-and-lost at publish
    expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });

  it('the per-cell ＋ proof button is inert on a STALE previous-uid board (PR #110 round 3 finding C)', async () => {
    // u1's board (with a marked cell, so the ＋ renders) is still exposed for a
    // render after the account switches to u2. The button stops propagation past
    // `toggle`, so it must carry the attribution guard itself.
    H.claimMode = 'proof_required';
    H.board = boardWith([0, 1, 2, 3], 'u1');
    const { rerender } = render(<Board />);
    H.user = { uid: 'u2', displayName: 'Sailor', photoURL: null } as unknown as User;
    H.player = { displayName: 'Second Sailor', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);

    expect(screen.queryAllByTitle('Add proof')).toHaveLength(0);
    // No sheet opened → the mocked sheet's submit trigger is absent, and nothing
    // could attach or broadcast under u2 off u1's card.
    expect(screen.queryByText('submit-proof')).toBeNull();
    expect(peekPendingMoments('u2')).toEqual({ bingo: false, blackout: false, firstBingo: false });
  });

  it('an account switch mid-witness-read loses nothing: the candidate waits, uid-keyed, and drains on the acted account’s return (PR #110 round 3 finding D)', async () => {
    // u1 completes a win; the birth witness read HANGS.
    H.board = boardWith([0, 1, 2, 3]);
    const { rerender } = render(<Board />);
    let resolveWitness!: (v: boolean) => void;
    H.hasPriorBingoWitness.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveWitness = resolve; }),
    );
    await clickMark('p4', { bingo: true, bingoTransition: true }, dealtWith(ROW0));

    // The account switches to u2 while the read is in flight…
    H.user = { uid: 'u2', displayName: 'Sailor', photoURL: null } as unknown as User;
    H.player = { displayName: 'Second Sailor', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    rerender(<Board />);

    // …and the read resolves under u2. The continuation ENQUEUES for u1 (the
    // queue is uid-keyed — nothing can leak to u2) but SKIPS the drain (the
    // current actor/gates belong to u2). Nothing publishes, nothing is lost.
    resolveWitness(false);
    await flushAsync();
    expect(H.broadcastBingo).not.toHaveBeenCalled();
    expect(H.broadcastFirstBingo).not.toHaveBeenCalled();
    expect(peekPendingMoments('u1')).toEqual({ bingo: true, blackout: false, firstBingo: true });
    expect(peekPendingMoments('u2')).toEqual({ bingo: false, blackout: false, firstBingo: false });

    // u1 returns (same page load): the held win drains with u1's own identity.
    H.user = { uid: 'u1', displayName: 'Sailor', photoURL: null } as unknown as User;
    H.player = { displayName: 'Deck Daddy', photoURL: null, firstBingoAt: null } as unknown as PlayerDoc;
    H.board = boardWith(ROW0, 'u1');
    rerender(<Board />);
    await flushAsync();
    expect(H.broadcastBingo).toHaveBeenCalledTimes(1);
    expect(H.broadcastBingo).toHaveBeenCalledWith(
      { uid: 'u1', displayName: 'Deck Daddy', photoURL: null },
      undefined,
      'test-event',
    );
    expect(H.broadcastFirstBingo).toHaveBeenCalledTimes(1);
  });
});

// Feed-entry builders matching the mergeFeed output shape.
function proofEntry(id: string, createdAt: number, over: Partial<ProofDoc> = {}): FeedEntry {
  return {
    feedKind: 'proof',
    createdAt,
    proof: {
      id,
      createdAt,
      uid: `u-${id}`,
      displayName: 'Someone',
      photoURL: null,
      type: 'text',
      cellIndex: 0,
      itemText: 'a prompt',
      storagePath: null,
      mediaURL: null,
      thumbURL: null,
      text: null,
      reportCount: 0,
      status: 'active',
      visionFlag: null,
      ...over,
    } as ProofDoc,
  };
}
function momentEntry(id: string, createdAt: number, kind: MomentKind, over: Partial<MomentDoc> = {}): FeedEntry {
  return {
    feedKind: 'moment',
    createdAt,
    moment: { id, kind, uid: `u-${id}`, displayName: 'Someone', photoURL: null, createdAt, ...over },
  };
}

describe('ProofFeed — the merged Feed (specs/w2-feed-moments.md)', () => {
  it('renders Moments and Proofs merged newest-first, each distinctly', () => {
    // Delivered already newest-first (mergeFeed's job, unit-tested separately).
    H.feedEntries = [
      momentEntry('m1', 3000, 'bingo', { displayName: 'Deck Daddy' }),
      proofEntry('p1', 2000, { displayName: 'Midge', itemText: 'Ordered a seventh cocktail' }),
      momentEntry('m2', 1000, 'first_bingo', { displayName: 'Barnacle Betty' }),
    ];
    render(<ProofFeed />);

    const cards = document.querySelectorAll('.list > .moment, .list > .proof');
    expect(cards).toHaveLength(3);
    expect(cards[0].className).toContain('moment');
    expect(cards[0]).toHaveTextContent('Deck Daddy');
    expect(cards[0]).toHaveTextContent(/got a BINGO/i);
    expect(cards[1].className).toContain('proof');
    expect(cards[1]).toHaveTextContent('Midge');
    expect(cards[1]).toHaveTextContent(/Ordered a seventh cocktail/);
    expect(cards[2].className).toContain('moment');
    expect(cards[2]).toHaveTextContent('Barnacle Betty');
    expect(cards[2]).toHaveTextContent(/First to BINGO/i);
  });

  it('a Moment carries no media and no report/delete affordances — it is a celebratory line', () => {
    H.feedEntries = [momentEntry('m1', 1, 'blackout', { displayName: 'Deck Daddy' })];
    render(<ProofFeed />);

    const moment = document.querySelector('.moment') as HTMLElement;
    expect(moment).toBeInTheDocument();
    // No attached evidence (ADR 0002) and nothing to dispute.
    expect(moment.querySelector('img.proof-media, audio.proof-media, .proof-quote')).toBeNull();
    // The ONLY affordance is the heart (specs/feed-hearts.md) — a Moment is a
    // post you can cheer, still never one you can report or delete from here.
    const buttons = [...moment.querySelectorAll('button')];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].className).toContain('heartbtn');
    expect(moment).toHaveTextContent(/blacked out the whole card/i);
  });

  it('a blackout Moment NAMES its Day when dayIndex is carried (fix/d15-blackout-day-naming)', () => {
    // The Day must RESOLVE on the Event schedule for the chip to render (Codex
    // P2 on #286); an unknown theme id still degrades the label to a bare
    // "Day N" (dayChipLabel's documented fallback).
    H.days = Array.from({ length: 5 }, (_, index) => ({ index, theme: 'nope' })) as unknown as import('../types').DayDef[];
    H.feedEntries = [momentEntry('m1', 1, 'blackout', { displayName: 'Deck Daddy', dayIndex: 3 })];
    render(<ProofFeed />);

    const moment = document.querySelector('.moment') as HTMLElement;
    expect(moment).toHaveTextContent('Day 4'); // 1-based Day label
  });

  it('a Moment whose dayIndex resolves to NO schedule Day renders no chip (Codex P2 on #286: the rules bind the Day only on day-suffixed blackout ids)', () => {
    H.days = Array.from({ length: 5 }, (_, index) => ({ index, theme: 'nope' })) as unknown as import('../types').DayDef[];
    H.feedEntries = [
      momentEntry('m1', 2, 'bingo', { displayName: 'Deck Daddy', dayIndex: 999 }),
      momentEntry('m2', 1, 'bingo', { displayName: 'Deck Daddy', dayIndex: -1 }),
    ];
    render(<ProofFeed />);
    expect(document.querySelector('.moment-day-chip')).toBeNull();
  });

  it('proof pills derive from the UNCAPPED tally stream — a card that fell outside the Feed cap still counts (Codex P2 on #286)', () => {
    // The Proof's Prompt has a live Tally, but its Tally Card did NOT survive
    // useFeed's 60-entry merge cap: `entries` holds only the Proof, while the
    // uncapped `tallyCards` stream carries the card. The "tally N" pill must
    // read the stream, not the capped entries.
    H.feedEntries = [proofEntry('p1', 1000, { itemText: 'Ordered a seventh cocktail' })];
    H.feedTallyCards = [
      {
        itemId: 'i-cocktail',
        dayIndex: 0,
        itemText: 'Ordered a seventh cocktail',
        count: 4,
        markers: [],
        lastMarkedAt: 900,
        displayBump: 900,
      },
    ];
    render(<ProofFeed />);
    expect(document.querySelector('.proof-foot')).toHaveTextContent('tally 4');
  });

  it('a day-stamped bingo Moment wears the chip when its Day resolves (#262)', () => {
    H.days = Array.from({ length: 5 }, (_, index) => ({ index, theme: 'nope' })) as unknown as import('../types').DayDef[];
    H.feedEntries = [momentEntry('m1', 1, 'bingo', { displayName: 'Deck Daddy', dayIndex: 1 })];
    render(<ProofFeed />);
    const moment = document.querySelector('.moment') as HTMLElement;
    expect(moment.querySelector('.moment-day-chip')).toHaveTextContent('Day 2');
  });

  it('a blackout Moment with no dayIndex (pre-fix data) renders no Day chip', () => {
    H.feedEntries = [momentEntry('m1', 1, 'blackout', { displayName: 'Deck Daddy' })];
    render(<ProofFeed />);

    const moment = document.querySelector('.moment') as HTMLElement;
    expect(moment.querySelector('.moment-day-chip')).toBeNull();
  });

  it('recomputes a structured last-call finale line after filtering currently banned players', () => {
    H.bannedUids = ['bad'];
    H.feedEntries = [
      momentEntry('last_call', 1, 'last_call', {
        line: 'Bad Blair leads by 7 bingos—standings freeze at 8 a.m.',
        lastCall: {
          players: [
            { uid: 'bad', displayName: 'Bad Blair', bingoCount: 9, squaresMarked: 90 },
            { uid: 'good', displayName: 'Good Gail', bingoCount: 2, squaresMarked: 24 },
          ],
        },
      }),
    ];
    render(<ProofFeed />);

    const moment = document.querySelector('.moment') as HTMLElement;
    expect(moment).not.toHaveTextContent('Bad Blair');
    expect(moment).toHaveTextContent('Good Gail has the board to themselves going into the final night—standings freeze at 8 a.m.');
    expect(moment).not.toHaveTextContent('a.m..');
  });

  it('fails closed for legacy string-only last-call finale lines when a ban is active', () => {
    H.bannedUids = ['bad'];
    H.feedEntries = [
      momentEntry('last_call', 1, 'last_call', {
        line: 'Bad Blair leads by 7 bingos—standings freeze at 8 a.m.',
      }),
    ];
    render(<ProofFeed />);

    const moment = document.querySelector('.moment') as HTMLElement;
    expect(moment).not.toHaveTextContent('Bad Blair');
    expect(moment).toHaveTextContent('posted the final-night standings');
  });

  it('filters currently banned players out of embedded podium finale names', () => {
    H.bannedUids = ['bad'];
    H.feedEntries = [
      momentEntry('podium', 1, 'podium', {
        podium: {
          champion: { uid: 'bad', displayName: 'Bad Blair', bingoCount: 9, squaresMarked: 90 },
          firstBingo: { uid: 'good', displayName: 'Good Gail', at: 20 },
          dailyHonors: [
            { dayIndex: 0, uid: 'bad', displayName: 'Bad Blair', at: 10 },
            { dayIndex: 1, uid: 'good', displayName: 'Good Gail', at: 20 },
          ],
        },
      }),
    ];
    render(<ProofFeed />);

    const moment = document.querySelector('.moment') as HTMLElement;
    expect(moment).not.toHaveTextContent('Bad Blair');
    expect(moment).not.toHaveTextContent('Cruise champion');
    expect(moment).toHaveTextContent('First to BINGO: Good Gail');
    expect(moment).toHaveTextContent('D2 Good Gail');
  });

  it('a Proof keeps its report and owner-delete affordances in the Feed', () => {
    H.user = { uid: 'u-p1' } as unknown as User; // the viewer owns this Proof
    H.feedEntries = [proofEntry('p1', 1)]; // proof.uid === 'u-p1'
    render(<ProofFeed />);

    const proof = document.querySelector('.proof') as HTMLElement;
    expect(proof.querySelector('button[title="Report"]')).toBeInTheDocument();
    expect(proof.querySelector('button[title="Delete"]')).toBeInTheDocument();
  });

  it('a bare Mark produces no Feed entry — an empty Feed shows the empty state (ADR 0002)', () => {
    H.feedEntries = []; // a bare Mark writes neither a Proof nor a Moment
    render(<ProofFeed />);
    expect(screen.getByText(/nothing in the feed yet/i)).toBeInTheDocument();
  });
});
