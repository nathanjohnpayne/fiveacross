import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { User } from 'firebase/auth';
import type { BoardDoc, Cell, EventDoc, PlayerDoc } from '../types';

// Regression for #76: a Board renders ProofSheet with the identity a NEW proof
// is attributed to. It must prefer the denormalized player row (which the
// profile editor keeps current) over the Firebase Auth user, so a renamed
// player's proofs carry their saved name/avatar, not the stale Google one.
// ProofSheet passes displayName/photoURL straight into attachProof and renders
// neither, so we stub it to capture the props Board handed it.

const H = vi.hoisted(() => ({
  authUser: null as User | null,
  player: null as PlayerDoc | null,
  board: null as BoardDoc | null,
  event: null as EventDoc | null,
  proofProps: null as { displayName: string; photoURL: string | null } | null,
}));

vi.mock('../firebase', () => ({ db: {}, storage: {}, auth: {}, EVENT_ID: 'test-event', analytics: null }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: H.authUser, loading: false }),
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
  // No cell in this fixture is marked-and-non-free, so Board never renders a
  // TallyBadge and never CALLS useTally — but Board imports it, and a future
  // fixture with a marked Square would hit an undefined hook from this factory
  // mock before reaching any attribution assertion (Codex P2, PR #87 round 2).
  useTally: () => ({ count: 0, markers: [], loading: false }),
  // Board reads the roster for the First-to-BINGO Moment (#34); this fixture
  // never crosses a bingo edge, so an empty roster suffices.
  useLeaderboard: () => ({ players: [], loading: false }),
  // Board subscribes the per-Square Doubt count + the Feed's Proofs (#33); no cell
  // here is marked-and-non-free, so no DoubtBadge mounts, but the factory must
  // export both so Board's module resolves.
  useDoubts: () => ({ doubts: [], count: 0, loading: false, hasServerData: true }),
  // Board reads its viewer-scoped own Proofs for the DoubtBadge (#106 finding 4);
  // no marked-and-non-free cell here mounts one, and the sheet is never opened.
  useMyProofs: () => ({ proofs: [], loading: false, hasServerData: true }),
  useProofsForItemText: () => ({ proofs: [], loading: false, hasServerData: true }),
}));
vi.mock('./ProofSheet', () => ({
  default: (props: { displayName: string; photoURL: string | null }) => {
    H.proofProps = { displayName: props.displayName, photoURL: props.photoURL };
    return <div data-testid="proof-sheet" />;
  },
}));

import Board from './Board';

const GOOGLE_PHOTO = 'https://lh3.example/google.jpg';
const CUSTOM_PHOTO = 'https://cdn.example/custom.jpg';

// 25 cells; the centre (12) is the marked Free Space, everything else an
// unmarked non-free Square. Cell 0 is the one we click to raise a proof.
function dealtCells(): Cell[] {
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    text: index === 12 ? 'Free Space' : `Prompt ${index}`,
    marked: index === 12,
    free: index === 12,
  })) as Cell[];
}

beforeEach(() => {
  H.authUser = { uid: 'sailor-1', displayName: 'Sailor', photoURL: GOOGLE_PHOTO } as unknown as User;
  H.player = null;
  H.board = { uid: 'sailor-1', seed: 1, createdAt: 0, cells: dealtCells() } as BoardDoc;
  // proof_required so clicking an unmarked Square raises ProofSheet instead of
  // marking it directly (honor mode would never open the sheet).
  H.event = { claimMode: 'proof_required' } as EventDoc;
  H.proofProps = null;
});

function openProof() {
  const { container } = render(<Board />);
  // `.cell-claim` is the Square's claim button — the tile div is a positioning
  // shell, so the handler lives on the button that fills it.
  const square = container.querySelectorAll('.grid .cell .cell-claim')[0] as HTMLElement;
  fireEvent.click(square);
}

describe('Board proof attribution (#76)', () => {
  it('attributes a new proof to the saved player identity, not the Google auth profile', () => {
    H.player = {
      displayName: 'Deck Daddy',
      photoURL: CUSTOM_PHOTO,
    } as unknown as PlayerDoc;

    openProof();

    expect(H.proofProps).toEqual({ displayName: 'Deck Daddy', photoURL: CUSTOM_PHOTO });
  });

  it('falls back to the auth identity until the player row has loaded', () => {
    H.player = null; // subscription not yet resolved

    openProof();

    expect(H.proofProps).toEqual({ displayName: 'Sailor', photoURL: GOOGLE_PHOTO });
  });

  it('honors a loaded player with no saved avatar (null) over the stale auth photo', () => {
    // A resolved player row whose photoURL is genuinely null means "no avatar",
    // and must win over the Google auth photo — the `player ? … : …` guard (not
    // a `??` chain) is what keeps a null from falling back to user.photoURL.
    H.player = { displayName: 'Deck Daddy', photoURL: null } as unknown as PlayerDoc;

    openProof();

    expect(H.proofProps).toEqual({ displayName: 'Deck Daddy', photoURL: null });
  });
});
