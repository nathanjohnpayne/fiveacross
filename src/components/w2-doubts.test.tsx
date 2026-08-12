import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import type { User } from 'firebase/auth';
import type { BoardDoc, Cell, DoubtDoc, PlayerDoc, ProofDoc, TallyEntry } from '../types';

// specs/w2-doubts.md, Board wiring layer (RTL-jsdom). Drives the REAL Board with
// the REAL Doubt derivation (isDoubtSatisfied/openDoubts/doubtStatusFor); only the
// SDK/data boundaries are mocked (useData subscriptions, the raiseDoubt write, and
// setMark). Pins the four #33 surfaces (ADR 0001 — a Doubt is social pressure,
// never a gate, so none of this blocks/unmarks the Square):
//   1. the open-Doubt COUNT renders on a marked, non-free Square (the DoubtBadge),
//      scoped to Doubts AGAINST that Square's own marker only — a Doubt against a
//      different Player who shares the same Prompt (the item pool is shared,
//      ADR 0002) must never bleed onto an un-doubted Player's own Square;
//   2. a Doubt is RAISED from another Player's Tally-sheet entry (never one's own);
//   3. an answered Doubt renders a DISTINCT satisfied state vs an open one.
// Plus the Codex P2 fixes on PR #106 (rounds 1–2):
//   - finding 1: a rapid double-tap raises EXACTLY one Doubt, the affordance
//     disables synchronously on the first tap, and re-enables when a non-persisting
//     write settles;
//   - finding 2: the header's open-Doubt count drops a Doubt whose target is no
//     longer a current marker and restores it when they re-mark;
//   - finding 4: Board opens the VIEWER-scoped own-proofs query and the sheet the
//     ITEM-scoped one — never the Board-wide proof feed;
//   - round 2 finding 2: a marker this Player has ALREADY doubted — open OR
//     satisfied — keeps the affordance disabled (the deterministic doubt slot is
//     once-only; a re-raise in place would only be denied);
//   - round 2 finding 3: the raise affordance is identity-gated — disabled while
//     the player row is loading (a Doubt stores the accuser's name PERMANENTLY),
//     enabled with the SAVED name once identity resolves;
//   - round 6: a Tally sheet whose SOURCE dies under it — the account switches or
//     the source Square unmarks in another tab — closes instead of dangling, and
//     the stale surface never reaches raiseDoubt (the #110 attribution-guard
//     class applied to the permanent Doubt write path).

const H = vi.hoisted(() => ({
  user: null as User | null,
  board: null as BoardDoc | null,
  player: null as PlayerDoc | null,
  // Drives Board's identityKnown tri-state: true models the player-row loading
  // window in which a raise must be gated (round 2 finding 3).
  playerLoading: false,
  markers: [] as TallyEntry[],
  doubts: [] as DoubtDoc[],
  // The viewer's OWN active Proofs (useMyProofs → the DoubtBadge, finding 4).
  myProofs: [] as Array<Pick<ProofDoc, 'uid' | 'itemText' | 'createdAt'>>,
  // The active Proofs for the open sheet's Prompt (useProofsForItemText, finding 4).
  proofs: [] as Array<Pick<ProofDoc, 'uid' | 'itemText' | 'createdAt'>>,
  raiseDoubt: vi.fn(),
  setMark: vi.fn(),
  // Spies so the finding-4 proof scoping is assertable: Board must open useMyProofs,
  // the sheet useProofsForItemText, and NEITHER the Board-wide useProofFeed.
  useMyProofs: vi.fn(),
  useProofsForItemText: vi.fn(),
  useProofFeed: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user, loading: false }) }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useBoard: () => ({ data: H.board, loading: false, hasServerData: true }),
  useDayBoard: () => ({ data: H.board, loading: false, hasServerData: true }),
  useMyPlayer: () => ({ data: H.player, loading: H.playerLoading, hasServerData: true }),
  // honor mode so a tap marks straight through (no ProofSheet detour).
  useEventDoc: () => ({ data: { claimMode: 'honor' }, loading: false }),
  useItems: () => ({ items: [], loading: false, hasServerData: true }),
  useTally: () => ({ markers: H.markers, count: H.markers.length, loading: false, hasServerData: true }),
  useLeaderboard: () => ({ players: [], loading: false }),
  useDoubts: () => ({ doubts: H.doubts, count: H.doubts.length, loading: false, hasServerData: true }),
  // finding 4: the viewer-scoped badge query, the item-scoped sheet query, and the
  // Board-wide feed Board must NO LONGER open — each routed through a spy so the
  // call (and non-call) is assertable, returning the matching fixture stream.
  useMyProofs: (uid?: string) => {
    H.useMyProofs(uid);
    return { proofs: H.myProofs, loading: false, hasServerData: true };
  },
  useProofsForItemText: (itemText?: string) => {
    H.useProofsForItemText(itemText);
    return { proofs: H.proofs, loading: false, hasServerData: true };
  },
  useProofFeed: () => {
    H.useProofFeed();
    return { proofs: [], loading: false };
  },
}));
// Keep the REAL resolveDisplayName (Board feeds its output as the doubter's name);
// stub only the write.
vi.mock('../data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/api')>();
  return { ...actual, setMark: H.setMark };
});
// Keep the REAL Doubt derivation (the component renders open vs satisfied from it);
// stub only the raise write so the click is observable without Firestore.
vi.mock('../data/doubts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/doubts')>();
  return { ...actual, raiseDoubt: H.raiseDoubt };
});
vi.mock('./ProofSheet', () => ({ default: () => null }));
// CoachOverlay (#214) mounts unconditionally with cells and would collide
// with this file's `.sheet-backdrop` queries — stubbed, same as ProofSheet.
// CoachOverlay mounts unconditionally with cells, adding its own CTA. Board also
// reads its `isCoachOverlayDismissed` export to queue LaunchIntro behind it
// (#378), so the stub must carry that named export too — a `default`-only mock
// makes Vitest throw on the missing export. `true` (already dismissed) + the
// LaunchIntro stub below keeps both overlays out of this suite's button queries.
vi.mock('./CoachOverlay', () => ({ default: () => null, isCoachOverlayDismissed: () => true }));
vi.mock('./LaunchIntro', () => ({
  default: () => null,
  // Board reads this to decide whether a scrim is up over the card; the stub
  // reports "already dismissed" so the inert gate stays open here.
  isLaunchIntroDismissed: () => true,
}));

import Board from './Board';

// A dealt board with cell 0 marked and non-free (itemId 'i0', text 'p0') plus the
// free centre — one line short of a bingo, so no Moment edge fires.
function dealt(): Cell[] {
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `i${index}`,
    text: index === 12 ? 'FREE' : `p${index}`,
    free: index === 12,
    marked: index === 12 || index === 0,
    markedAt: index === 0 ? 1 : null,
  }));
}

const mkDoubt = (over: Partial<DoubtDoc>): DoubtDoc => ({
  id: 'd',
  itemId: 'i0',
  cellIndex: 0,
  fromUid: 'u1',
  fromDisplayName: 'Me',
  targetUid: 'bob',
  targetDisplayName: 'Bob',
  createdAt: 100,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // A raise settles to a resolved promise by default (Board `.then(clear, clear)`s
  // it to release its per-target pending state); tests that need a controllable
  // settle override this locally.
  H.raiseDoubt.mockImplementation(() => Promise.resolve());
  H.user = { uid: 'u1', displayName: 'Me', photoURL: null } as unknown as User;
  H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };
  H.player = { uid: 'u1', displayName: 'Me', photoURL: null } as unknown as PlayerDoc;
  H.playerLoading = false;
  H.markers = [];
  H.doubts = [];
  H.myProofs = [];
  H.proofs = [];
});

describe('Board Doubts wiring (specs/w2-doubts.md)', () => {
  it('renders the open-Doubt count on a marked, non-free Square', () => {
    // Two Doubts AGAINST ME (u1, the viewer — Board renders only its own board),
    // no answering Proof → both open → the badge on my own Square shows 2.
    H.doubts = [
      mkDoubt({ id: 'd1', fromUid: 'bob', targetUid: 'u1', createdAt: 100 }),
      mkDoubt({ id: 'd2', fromUid: 'carol', targetUid: 'u1', createdAt: 100 }),
    ];

    const { container } = render(<Board />);
    const badge = container.querySelector('.doubt-badge');
    expect(badge).not.toBeNull();
    // #263: the badge wears the 👀 glyph next to the count, per the wireframe.
    expect(badge!.textContent).toContain('👀');
    expect(badge!.textContent).toContain('2');
  });

  it('does not render a Doubt count on my Square for Doubts against a DIFFERENT Player sharing the same Prompt', () => {
    // The shared item pool (ADR 0002) means Bob and Carol can also hold this same
    // Prompt on their own boards. Both are doubted — but nobody doubts ME — so my
    // OWN marked Square must show nothing, never the Prompt-wide total.
    H.doubts = [
      mkDoubt({ id: 'd1', fromUid: 'u1', targetUid: 'bob', createdAt: 100 }),
      mkDoubt({ id: 'd2', fromUid: 'u1', targetUid: 'carol', createdAt: 100 }),
    ];

    const { container } = render(<Board />);
    expect(container.querySelector('.doubt-badge')).toBeNull();
  });

  it('does not render a Doubt count when every Doubt against me is answered by my own Proof', () => {
    // The one Doubt (against me) is answered — I proofed the Prompt after it was
    // raised — → 0 open → no badge. The answering Proof is MY OWN, which is exactly
    // the viewer-scoped set the badge now reads (finding 4).
    H.doubts = [mkDoubt({ id: 'd1', fromUid: 'bob', targetUid: 'u1', createdAt: 100 })];
    H.myProofs = [{ uid: 'u1', itemText: 'p0', createdAt: 150 }];

    const { container } = render(<Board />);
    expect(container.querySelector('.doubt-badge')).toBeNull();
  });

  it('raises a Doubt from ANOTHER Player’s Tally-sheet entry — never one’s own', () => {
    // The Prompt's markers: me + Bob. No Doubts yet, so the button is enabled.
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];

    const { container } = render(<Board />);
    // Open the who-list sheet via the Tally count badge (no open Doubts yet, so no
    // DoubtBadge is shown to open it).
    fireEvent.click(container.querySelector('.tally-badge')!);

    // Exactly one raise affordance — Bob's; my own row offers none (no self-doubt).
    const doubtButtons = container.querySelectorAll('.doubt-btn');
    expect(doubtButtons.length).toBe(1);

    fireEvent.click(doubtButtons[0]);
    expect(H.raiseDoubt).toHaveBeenCalledTimes(1);
    // The open-Doubt set is threaded to raiseDoubt as the idempotence backstop
    // (finding 1) — empty here since no Doubt has been raised yet.
    expect(H.raiseDoubt).toHaveBeenCalledWith({
      fromUid: 'u1',
      fromDisplayName: 'Me',
      targetUid: 'bob',
      targetDisplayName: 'Bob',
      itemId: 'i0',
      cellIndex: 0,
      currentlyOpen: [],
    });
  });

  it('renders the satisfied state distinctly from an open one in the sheet', () => {
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
      { uid: 'carol', displayName: 'Carol', markedAt: 3 },
    ];
    // Bob's Doubt is answered by his Proof (createdAt 150 ≥ 100); Carol's is open.
    // Neither targets ME, so my own Square shows no badge (the Square badge is
    // scoped to Doubts against its own marker) — open the sheet via the Tally count
    // instead. The sheet's per-marker status reads the item-scoped Proofs (finding
    // 4): Bob's Proof for this Prompt lives there.
    H.doubts = [
      mkDoubt({ id: 'd1', fromUid: 'u1', targetUid: 'bob', createdAt: 100 }),
      mkDoubt({ id: 'd2', fromUid: 'u1', targetUid: 'carol', createdAt: 100 }),
    ];
    H.proofs = [{ uid: 'bob', itemText: 'p0', createdAt: 150 }];

    const { container } = render(<Board />);
    expect(container.querySelector('.doubt-badge')).toBeNull();
    fireEvent.click(container.querySelector('.tally-badge')!);

    // Bob's row reads SATISFIED, Carol's reads OPEN — two distinct states.
    const satisfied = container.querySelector('.doubt-satisfied');
    const open = container.querySelector('.doubt-open');
    expect(satisfied).not.toBeNull();
    expect(open).not.toBeNull();
    expect(satisfied!.className).not.toBe(open!.className);
    // The header summary is the Prompt-wide total (unlike the per-target Square
    // badge) — Carol's is the only Doubt still open.
    expect(container.querySelector('.doubt-summary')!.textContent).toContain('1 open doubt');
    // #263 (wireframe) + Codex P2 on #276: a doubted/answered row shows its
    // right-aligned STATE, and the raise affordance suppresses only for the
    // VIEWER's own involvement. I already doubted BOTH rows here (my slot is
    // spent), so neither offers a button — but that follows from
    // iAlreadyDoubted, never from someone else's state (pinned separately
    // below).
    expect(container.querySelectorAll('.doubt-btn').length).toBe(0);
    expect(open!.textContent).toContain('Doubted · waiting');
    expect(satisfied!.textContent).toContain('✓ Answered');
  });

  it("keeps the raise affordance for an ADDITIONAL doubter — someone else's open Doubt never blocks my own slot (Codex P2 on #276)", () => {
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];
    // Carol (not me) doubted Bob: Bob's row reads OPEN, but MY deterministic
    // slot (u1_bob_p0) is untouched — the button must still offer my raise.
    H.doubts = [mkDoubt({ id: 'd1', fromUid: 'carol', targetUid: 'bob', createdAt: 100 })];

    const { container } = render(<Board />);
    fireEvent.click(container.querySelector('.tally-badge')!);

    expect(container.querySelector('.doubt-open')).not.toBeNull(); // the state renders…
    const btn = container.querySelector('.doubt-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull(); // …and so does my own raise affordance
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(H.raiseDoubt).toHaveBeenCalledTimes(1);
  });

  // ---- PR #106 finding 1: a rapid double-tap must not mint duplicate Doubts ----

  it('raises EXACTLY one Doubt on a rapid double-tap and disables the affordance on the first tap (finding 1)', () => {
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];
    // A never-settling raise freezes the in-flight guard so the disabled state is
    // observable (a real raise clears it on settle).
    H.raiseDoubt.mockImplementation(() => new Promise<void>(() => {}));

    const { container } = render(<Board />);
    fireEvent.click(container.querySelector('.tally-badge')!);
    const btn = container.querySelector('.doubt-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    fireEvent.click(btn); // second, rapid tap

    expect(H.raiseDoubt).toHaveBeenCalledTimes(1); // one write, not two
    expect(btn.disabled).toBe(true); // disabled synchronously on the first tap
  });

  it('re-enables the raise affordance when the write settles without persisting (finding 1)', async () => {
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];
    // The Doubt never echoes into the subscription (H.doubts stays empty), modelling
    // a write that did not persist; raiseDoubt still SETTLES (it resolves even on an
    // online rejection), which must release the pending state.
    let settle: () => void = () => {};
    H.raiseDoubt.mockImplementation(
      () =>
        new Promise<void>((res) => {
          settle = () => res();
        }),
    );

    const { container } = render(<Board />);
    fireEvent.click(container.querySelector('.tally-badge')!);
    const btn = container.querySelector('.doubt-btn') as HTMLButtonElement;

    fireEvent.click(btn);
    expect(btn.disabled).toBe(true); // engaged on the tap

    await act(async () => {
      settle();
    });
    expect(btn.disabled).toBe(false); // pending cleared; no echoed Doubt → re-enabled
  });

  // ---- PR #106 finding 2: a Doubt against an unmarked target goes dormant ----

  it('drops an open Doubt from the header count when its target unmarks, and restores it when they re-mark (finding 2)', () => {
    // Bob has an OPEN Doubt against him, but he is NOT a current marker (he unmarked
    // — his Tally marker is gone, the Doubt doc lingers, never deleted here).
    H.doubts = [mkDoubt({ id: 'd1', fromUid: 'u1', targetUid: 'bob', createdAt: 100 })];
    H.markers = [{ uid: 'u1', displayName: 'Me', markedAt: 1 }]; // only me; Bob unmarked

    const { container, rerender } = render(<Board />);
    fireEvent.click(container.querySelector('.tally-badge')!);
    // Bob's Doubt is dormant — the header (#263: now always naming the player
    // count) shows no open-doubt half.
    expect(container.querySelector('.doubt-summary')!.textContent).not.toContain('open doubt');

    // Bob re-marks: his Tally marker returns, so the dormant Doubt reappears.
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];
    rerender(<Board />);
    expect(container.querySelector('.doubt-summary')!.textContent).toContain('1 open doubt');
  });

  // ---- PR #106 finding 4: scoped proof reads, never the Board-wide feed ----

  it('opens the viewer-scoped own-proofs query on mount and the item-scoped one only with the sheet — never the Board-wide feed (finding 4)', () => {
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];

    const { container } = render(<Board />);
    // Board mounts the viewer-scoped own-proofs query, never the all-Players feed.
    expect(H.useMyProofs).toHaveBeenCalledWith('u1');
    expect(H.useProofFeed).not.toHaveBeenCalled();
    // The item-scoped sheet query is not opened until the sheet is.
    expect(H.useProofsForItemText).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('.tally-badge')!);
    expect(H.useProofsForItemText).toHaveBeenCalledWith('p0');
    expect(H.useProofFeed).not.toHaveBeenCalled();
  });

  // ---- PR #106 round 2 finding 3: no anonymous accusation window ----

  it('gates the raise affordance on a KNOWN identity — disabled while the player row loads, enabled with the saved name after (round 2 finding 3)', () => {
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];
    // The loading window: identityKnown is false, so a tap here would have stored
    // fromDisplayName 'Anonymous' PERMANENTLY — the affordance must be disabled.
    H.playerLoading = true;

    const { container, rerender } = render(<Board />);
    fireEvent.click(container.querySelector('.tally-badge')!);
    expect((container.querySelector('.doubt-btn') as HTMLButtonElement).disabled).toBe(true);

    // The saved row resolves — the gate opens, and the raise carries the SAVED
    // public name (the same resolved identity the Tally marker + Moment carry).
    H.playerLoading = false;
    rerender(<Board />);
    const btn = container.querySelector('.doubt-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(H.raiseDoubt).toHaveBeenCalledTimes(1);
    expect(H.raiseDoubt.mock.calls[0][0]).toMatchObject({
      fromUid: 'u1',
      fromDisplayName: 'Me',
      targetUid: 'bob',
    });
  });

  // ---- PR #106 round 2 finding 2: once-only per (doubter, target, Prompt) ----

  it('keeps the affordance disabled for a marker I already doubted even after their Proof satisfies it (round 2 finding 2)', () => {
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];
    // My Doubt of Bob, ANSWERED by his later Proof: the row reads satisfied, and
    // the once-only slot means re-raising in place is structurally denied — so the
    // affordance stays "Doubted" (settled) instead of offering a doomed write.
    H.doubts = [mkDoubt({ id: 'd1', fromUid: 'u1', targetUid: 'bob', createdAt: 100 })];
    H.proofs = [{ uid: 'bob', itemText: 'p0', createdAt: 150 }];

    const { container } = render(<Board />);
    fireEvent.click(container.querySelector('.tally-badge')!);
    // #263: the answered row shows "✓ Answered" in place of any affordance —
    // structurally nothing to tap, so no doomed duplicate write can happen.
    expect(container.querySelector('.doubt-satisfied')).not.toBeNull(); // answered
    expect(container.querySelector('.doubt-satisfied')!.textContent).toContain('✓ Answered');
    expect(container.querySelector('.doubt-btn')).toBeNull();
    expect(H.raiseDoubt).not.toHaveBeenCalled(); // no doomed duplicate write
  });

  // ---- PR #106 round 6: a stale Tally source must never raise a Doubt ----

  it('closes the sheet when its source Square unmarks under it — a raise from a live source works, a stale one never fires (round 6)', () => {
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];

    const { container, rerender } = render(<Board />);
    fireEvent.click(container.querySelector('.tally-badge')!);
    // Positive pin: the source is LIVE (cell 0 marked on my own board) — the
    // guard does not block a valid raise.
    fireEvent.click(container.querySelector('.doubt-btn')!);
    expect(H.raiseDoubt).toHaveBeenCalledTimes(1);

    // The source Square unmarks in another tab: the snapshot re-renders Board and
    // the sheet must CLOSE (never dangle over a dead source), adding no raise. On
    // 5ac5a49 the sheet stayed open with its stale itemId/cellIndex.
    H.board = {
      uid: 'u1',
      dayIndex: 0,
      seed: 1,
      createdAt: 0,
      cells: dealt().map((c) => (c.index === 0 ? { ...c, marked: false, markedAt: null } : c)),
    };
    rerender(<Board />);
    expect(container.querySelector('.sheet-backdrop')).toBeNull(); // closed
    expect(H.raiseDoubt).toHaveBeenCalledTimes(1); // the stale surface added nothing
  });

  it('closes the sheet on an account switch — the new account can never publish a Doubt from the old account’s sheet (round 6)', () => {
    H.markers = [
      { uid: 'u1', displayName: 'Me', markedAt: 1 },
      { uid: 'bob', displayName: 'Bob', markedAt: 2 },
    ];

    const { container, rerender } = render(<Board />);
    fireEvent.click(container.querySelector('.tally-badge')!);
    expect(container.querySelector('.sheet-backdrop')).not.toBeNull(); // open as u1

    // The account switches while the sheet is open; the subscription still lags
    // with u1's board for this render (the #110 hazard window). A Doubt is a
    // PERMANENT once-only slot, so u2 must never publish one for a Prompt/cell
    // captured from u1's board: the sheet closes on the switch render, and the
    // write-time isSourceLive guard backstops any tap that races the close.
    H.user = { uid: 'u2', displayName: 'Other', photoURL: null } as unknown as User;
    H.player = { uid: 'u2', displayName: 'Other', photoURL: null } as unknown as PlayerDoc;
    rerender(<Board />);
    expect(container.querySelector('.sheet-backdrop')).toBeNull(); // closed
    expect(H.raiseDoubt).not.toHaveBeenCalled();
  });
});
