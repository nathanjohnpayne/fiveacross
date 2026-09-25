import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { DoubtDoc, HeartDoc, MomentDoc, ProofDoc, TallyEntry } from '../types';

// specs/player-blocking.md § Where hiding applies, Feed layer (#689 part 2).
// The REAL ProofFeed and its read hooks run with Firestore's onSnapshot stubbed
// and the viewer's hidden set supplied by a stubbed `useHiddenUids`: the viewer
// ('viewer') and 'blocked' are hidden from each other, 'friend' is not. Every
// Feed surface must leave the blocked Player out (their Proof, Moment, Tally
// Mark, who-list row and so its Doubt button, Hearts and podium honours) while
// the friend's content renders as it always has.

const H = vi.hoisted(() => ({
  onSnapshot: vi.fn(),
  blocks: { hidden: new Set<string>(), ready: true } as { hidden: ReadonlySet<string>; ready: boolean },
}));

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
    ref.withConverter = () => ref;
    return ref;
  };
  return {
    doc: (...args: unknown[]) => makeRef('doc', args),
    collection: (...args: unknown[]) => makeRef('collection', args),
    collectionGroup: (...args: unknown[]) => makeRef('collectionGroup', args),
    query: (...args: unknown[]) => makeRef('query', args),
    where: (...args: unknown[]) => makeRef('where', args),
    onSnapshot: H.onSnapshot,
  };
});
vi.mock('../data/proofs', () => ({ reportProof: vi.fn(), deleteProof: vi.fn() }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'viewer' } }) }));
vi.mock('../hooks/useBlocks', () => ({ useHiddenUids: () => H.blocks }));

import ProofFeed from './ProofFeed';

type SnapCb = (snap: unknown) => void;
const settled = { fromCache: false, hasPendingWrites: false };
const col = (docs: unknown[]) => ({ docs, metadata: settled });
const row = (d: object) => ({ data: () => d });

// Routes each subscription ProofFeed opens to the stream the test hands it.
function mount(streams: {
  proofs?: object[];
  moments?: object[];
  markers?: { itemId: string; entry: TallyEntry }[];
  doubts?: object[];
  hearts?: object[];
}) {
  const cbs: { docs: SnapCb[]; player: SnapCb | null; byName: Record<string, SnapCb> } = {
    docs: [],
    player: null,
    byName: {},
  };
  H.onSnapshot.mockImplementation((target: unknown, optionsOrNext: unknown, maybeNext?: SnapCb) => {
    const onNext = (typeof optionsOrNext === 'function' ? optionsOrNext : maybeNext) as SnapCb;
    const ref = target as { kind?: string; args?: unknown[] };
    const args = ref.args ?? [];
    const source = ref.kind === 'query' ? (args[0] as { kind?: string; args?: unknown[] }) : undefined;
    if (source?.kind === 'collectionGroup') cbs.byName.markers = onNext;
    else if (ref.kind === 'query') cbs.byName.proofs = onNext;
    else if (ref.kind === 'doc' && args[3] === 'players') cbs.player = onNext;
    else if (ref.kind === 'doc') cbs.docs.push(onNext);
    else cbs.byName[String(args[3])] = onNext;
    return () => {};
  });
  const view = render(<ProofFeed />);
  const deliverMarkers = (markers: { itemId: string; entry: TallyEntry }[]) =>
    cbs.byName.markers?.(
      col(
        markers.map(({ itemId, entry }) => ({
          data: () => entry,
          ref: { parent: { parent: { id: itemId, parent: { id: 'tally', parent: { id: 'test-event' } } } } },
        })),
      ),
    );
  act(() => {
    cbs.docs.forEach((cb) =>
      cb({ exists: () => true, data: () => ({ admins: [], bannedUids: [] }), metadata: settled }),
    );
    cbs.player?.({ exists: () => true, data: () => ({ uid: 'viewer', displayName: 'Vic Viewer' }), metadata: settled });
    cbs.byName.proofs?.(col((streams.proofs ?? []).map(row)));
    cbs.byName.moments?.(col((streams.moments ?? []).map(row)));
    cbs.byName.notices?.(col([]));
    cbs.byName.doubts?.(col((streams.doubts ?? []).map(row)));
    cbs.byName.hearts?.(col((streams.hearts ?? []).map(row)));
    deliverMarkers(streams.markers ?? []);
  });
  return { view, deliverMarkers };
}

const proof = (id: string, uid: string, displayName: string, createdAt: number) =>
  ({ id, uid, displayName, photoURL: null, type: 'text', cellIndex: 0, itemText: 'Danced on the lido deck', text: `${displayName} wrote this`, createdAt, reportCount: 0, status: 'active' }) as ProofDoc;
const marker = (uid: string, displayName: string, markedAt: number): TallyEntry =>
  ({ uid, displayName, markedAt, dayIndex: 0, itemText: 'Balcony or porthole photo' });
const heart = (uid: string, targetId: string, targetCreatedAt: number) =>
  ({ id: `proof_${targetId}_${uid}`, uid, targetKind: 'proof', targetId, targetCreatedAt, createdAt: 1 }) as HeartDoc;

beforeEach(() => {
  H.onSnapshot.mockReset();
  H.onSnapshot.mockReturnValue(() => {});
  H.blocks = { hidden: new Set(['blocked']), ready: true };
});

describe('the Feed hides a blocked counterpart everywhere (#689)', () => {
  it('drops their Proof and Moment, keeps the friend’s, and leaves their Heart out of the count', () => {
    mount({
      proofs: [proof('p-blocked', 'blocked', 'Blocked Bea', 20), proof('p-friend', 'friend', 'Friend Fin', 10)],
      moments: [
        { id: 'blocked-bingo', kind: 'bingo', uid: 'blocked', displayName: 'Blocked Bea', photoURL: null, createdAt: 30 } satisfies MomentDoc,
        { id: 'friend-bingo', kind: 'bingo', uid: 'friend', displayName: 'Friend Fin', photoURL: null, createdAt: 5 } satisfies MomentDoc,
      ],
      hearts: [heart('blocked', 'p-friend', 10), heart('third', 'p-friend', 10)],
    });
    expect(screen.queryByText(/Blocked Bea/)).toBeNull();
    expect(screen.getByText(/Friend Fin wrote this/)).toBeTruthy();
    expect(document.querySelectorAll('.moment-bingo')).toHaveLength(1);
    // The friend's Proof carries one visible Heart (the third Player's), not two.
    expect(screen.getByLabelText('1 heart')).toBeTruthy();
    expect(screen.queryByLabelText('2 hearts')).toBeNull();
  });

  it('drops their Mark from the Tally Card and the who-list, so there is no Doubt button for them', () => {
    mount({
      markers: [
        { itemId: 'item-1', entry: marker('blocked', 'Blocked Bea', 1) },
        { itemId: 'item-1', entry: marker('friend', 'Friend Fin', 2) },
      ],
    });
    const card = document.querySelector('.tally-card')!;
    expect(card.textContent).not.toContain('Blocked Bea');
    fireEvent.click(card.querySelector('.tally-card-body')!);
    const rows = [...document.querySelectorAll('.sheet .list .row')];
    expect(rows.map((r) => r.querySelector('.name')?.textContent)).toEqual(['Friend Fin']);
    expect(rows[0].querySelector('.doubt-btn')).toBeTruthy();
    expect(screen.getByText(/^1 player/)).toBeTruthy();
  });

  it('does not count a Doubt between the pair in the who-list header', () => {
    const d = (id: string, fromUid: string, targetUid: string) =>
      ({ id, itemId: 'item-1', cellIndex: 0, fromUid, fromDisplayName: fromUid, targetUid, targetDisplayName: targetUid, createdAt: 1 }) as DoubtDoc;
    mount({
      markers: [
        { itemId: 'item-1', entry: marker('viewer', 'Vic Viewer', 1) },
        { itemId: 'item-1', entry: marker('friend', 'Friend Fin', 2) },
      ],
      // The blocked Player's Doubt on the viewer is hidden; a friend's on the viewer shows.
      doubts: [d('blocked_viewer', 'blocked', 'viewer'), d('friend_viewer', 'friend', 'viewer')],
    });
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);
    expect(screen.getByText(/1 open doubt/)).toBeTruthy();
  });

  it('withholds their podium honours without promoting anyone', () => {
    mount({
      moments: [
        {
          id: 'podium',
          kind: 'podium',
          uid: 'system',
          displayName: '',
          photoURL: null,
          createdAt: 40,
          podium: {
            champion: { uid: 'blocked', displayName: 'Blocked Bea', bingoCount: 3, squaresMarked: 20 },
            firstBingo: { uid: 'friend', displayName: 'Friend Fin', at: 1 },
            dailyHonors: [
              { dayIndex: 0, uid: 'blocked', displayName: 'Blocked Bea', at: 1 },
              { dayIndex: 1, uid: 'friend', displayName: 'Friend Fin', at: 2 },
            ],
          },
        } as MomentDoc,
      ],
    });
    const rows = [...document.querySelectorAll('.moment-podium-row')].map((r) => r.textContent ?? '');
    // The champion row is withheld outright (no runner-up is crowned), and so is
    // the hidden Player's Day honour; the friend's honours render unchanged.
    expect(rows.some((t) => t.includes('Blocked Bea') || t.includes('🏆'))).toBe(false);
    expect(rows).toContain('👑 First to BINGO: Friend Fin');
    expect(rows.some((t) => t.includes('D2 Friend Fin') && !t.includes('D1'))).toBe(true);
  });

  it('withholds a last-call line that would name a hidden leader, rather than naming the runner-up', () => {
    const lastCall = {
      id: 'last_call',
      kind: 'last_call',
      uid: 'system',
      displayName: '',
      photoURL: null,
      createdAt: 30,
      line: 'Blocked Bea leads by 1 bingo—standings freeze at 8 a.m.',
      lastCall: {
        freezePhrase: 'standings freeze at 8 a.m',
        players: [
          { uid: 'blocked', displayName: 'Blocked Bea', bingoCount: 3, squaresMarked: 20 },
          { uid: 'friend', displayName: 'Friend Fin', bingoCount: 2, squaresMarked: 15 },
        ],
      },
    } as MomentDoc;
    mount({ moments: [lastCall] });
    const line = document.querySelector('.moment-last_call .moment-line')?.textContent ?? '';
    expect(line).not.toContain('Blocked Bea');
    expect(line).not.toContain('Friend Fin');
    expect(line).toBe('posted the final-night standings!');
  });

  it('keeps the identity-free neck-and-neck line when a hidden Player ties at the top', () => {
    const lastCall = {
      id: 'last_call',
      kind: 'last_call',
      uid: 'system',
      displayName: '',
      photoURL: null,
      createdAt: 30,
      line: '',
      lastCall: {
        freezePhrase: 'standings freeze at 8 a.m',
        players: [
          { uid: 'blocked', displayName: 'Anna Blocked', bingoCount: 2, squaresMarked: 15 },
          { uid: 'friend', displayName: 'Friend Fin', bingoCount: 2, squaresMarked: 15 },
        ],
      },
    } as MomentDoc;
    mount({ moments: [lastCall] });
    expect(document.querySelector('.moment-last_call .moment-line')?.textContent).toBe(
      "It's neck and neck at the top going into the final night—standings freeze at 8 a.m.",
    );
  });

  it('keeps naming an unhidden leader when only the runner-up is hidden', () => {
    const lastCall = {
      id: 'last_call',
      kind: 'last_call',
      uid: 'system',
      displayName: '',
      photoURL: null,
      createdAt: 30,
      line: '',
      lastCall: {
        freezePhrase: 'standings freeze at 8 a.m',
        players: [
          { uid: 'friend', displayName: 'Friend Fin', bingoCount: 3, squaresMarked: 20 },
          { uid: 'blocked', displayName: 'Blocked Bea', bingoCount: 2, squaresMarked: 15 },
        ],
      },
    } as MomentDoc;
    mount({ moments: [lastCall] });
    expect(document.querySelector('.moment-last_call .moment-line')?.textContent).toBe(
      'Friend Fin leads by 1 bingo—standings freeze at 8 a.m.',
    );
  });

  it('closes an open who-list when a block lands on the only Player in it', () => {
    H.blocks = { hidden: new Set(), ready: true };
    const onlyBlocked = [{ itemId: 'item-1', entry: marker('blocked', 'Blocked Bea', 1) }];
    const { view, deliverMarkers } = mount({ markers: onlyBlocked });
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);
    expect(document.querySelector('.sheet')?.textContent).toContain('Blocked Bea');
    H.blocks = { hidden: new Set(['blocked']), ready: true };
    view.rerender(<ProofFeed />);
    act(() => deliverMarkers(onlyBlocked));
    expect(document.querySelector('.sheet')).toBeNull();
    expect(document.body.textContent).not.toContain('Blocked Bea');
  });

  it('keeps an open who-list open when a block empties its snapshot but a later Player is still on the card', () => {
    H.blocks = { hidden: new Set(), ready: true };
    const first = { itemId: 'item-1', entry: marker('blocked', 'Blocked Bea', 1) };
    const later = { itemId: 'item-1', entry: marker('friend', 'Friend Fin', 2) };
    const { view, deliverMarkers } = mount({ markers: [first] });
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);
    H.blocks = { hidden: new Set(['blocked']), ready: true };
    // The Tally stream restarts on the new set. Until it re-answers, the
    // scrubbed carry-over has no card and the tap-time snapshot (Bea only)
    // scrubs to nothing, but neither is proof the card is gone: Fin's Mark
    // reaches only the new listener. The sheet stays mounted, with no rows.
    view.rerender(<ProofFeed />);
    expect(document.querySelector('.sheet')).toBeTruthy();
    expect(document.querySelector('.sheet')?.textContent).not.toContain('Blocked Bea');
    act(() => deliverMarkers([first, later]));
    const rows = [...document.querySelectorAll('.sheet .list .row')];
    expect(rows.map((r) => r.querySelector('.name')?.textContent)).toEqual(['Friend Fin']);
  });

  it('keeps the Feed and an open who-list mounted while the Tally Cards resubscribe on a new set', () => {
    H.blocks = { hidden: new Set(), ready: true };
    const first = { itemId: 'item-1', entry: marker('blocked', 'Blocked Bea', 1) };
    const later = { itemId: 'item-1', entry: marker('friend', 'Friend Fin', 2) };
    const { view } = mount({ markers: [first, later] });
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);
    H.blocks = { hidden: new Set(['blocked']), ready: true };
    // No marker snapshot is delivered after the rerender: the listener is still
    // resubscribing, and the cards already in hand are scrubbed in the meantime.
    view.rerender(<ProofFeed />);
    expect(screen.queryByText('Loading…')).toBeNull();
    const rows = [...document.querySelectorAll('.sheet .list .row')];
    expect(rows.map((r) => r.querySelector('.name')?.textContent)).toEqual(['Friend Fin']);
    expect(document.body.textContent).not.toContain('Blocked Bea');
  });

  it('renders nothing but the loading state until the hidden set is ready', () => {
    H.blocks = { hidden: new Set(), ready: false };
    mount({ proofs: [proof('p-blocked', 'blocked', 'Blocked Bea', 20)] });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(/Blocked Bea/)).toBeNull();
  });
});

describe('the Feed’s block entry points (#689 part 3)', () => {
  it('offers Block on another Player’s Proof beside an unchanged Report, never on the viewer’s own', () => {
    mount({ proofs: [proof('p-friend', 'friend', 'Friend Fin', 20), proof('p-mine', 'viewer', 'Vic Viewer', 10)] });
    const [friends, mine] = [...document.querySelectorAll('.proof')];
    expect(friends.querySelector('button[title="Report"]')).toBeTruthy();
    expect(friends.querySelector('button[title="Block Friend Fin"]')).toBeTruthy();
    expect(mine.querySelector('button[title="Report"]')).toBeTruthy();
    expect(mine.querySelector('.block-trigger')).toBeNull();
    // No Moment carries a per-Moment control.
    expect(document.querySelector('.moment .block-trigger')).toBeNull();
  });

  it('offers Block on every other who-list row, never the viewer’s', () => {
    mount({
      markers: [
        { itemId: 'item-1', entry: marker('viewer', 'Vic Viewer', 1) },
        { itemId: 'item-1', entry: marker('friend', 'Friend Fin', 2) },
      ],
    });
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);
    const rows = [...document.querySelectorAll('.sheet .list .row')];
    expect(rows.map((r) => r.querySelector('.block-trigger')?.getAttribute('aria-label') ?? null)).toEqual([
      null,
      'Block Friend Fin',
    ]);
  });
});
