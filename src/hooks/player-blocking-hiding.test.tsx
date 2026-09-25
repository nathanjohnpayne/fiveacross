import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// specs/player-blocking.md § Where hiding applies, hook layer (#689 part 2). The
// REAL public read hooks run with Firestore's onSnapshot stubbed and the
// viewer's hidden set supplied by a stubbed `useHiddenUids`, so what is pinned
// is each hook's filter: a blocked counterpart's content leaves every PUBLIC
// read, a Doubt between the pair is hidden when either party is hidden, the
// raw roster stays raw, and nothing renders before the hidden set is ready.

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

vi.mock('./useBlocks', () => ({ useHiddenUids: () => H.blocks }));

import {
  useAllDoubts,
  useDoubts,
  useLeaderboard,
  useMoments,
  useProofFeed,
  useProofsForItemText,
  useTally,
  useTallyCards,
} from './useData';
import type { DoubtDoc, MomentDoc, PlayerDoc, ProofDoc, TallyEntry } from '../types';

type SnapCb = (snap: unknown) => void;

// Each test mounts ONE hook, so its data stream is the only query, collection or
// collectionGroup open; the Event doc feeds the (empty) ban roster.
function capture() {
  const cbs: { docs: SnapCb[]; data: SnapCb | null } = { docs: [], data: null };
  H.onSnapshot.mockImplementation((target: unknown, optionsOrNext: unknown, maybeNext?: SnapCb) => {
    const onNext = (typeof optionsOrNext === 'function' ? optionsOrNext : maybeNext) as SnapCb;
    if ((target as { kind?: string }).kind === 'doc') cbs.docs.push(onNext);
    else cbs.data = onNext;
    return () => {};
  });
  return {
    fire: (docs: unknown[]) =>
      act(() => {
        cbs.docs.forEach((cb) => cb({ exists: () => true, data: () => ({ admins: [], bannedUids: [] }), metadata: { fromCache: false } }));
        cbs.data?.({ docs, metadata: { fromCache: false, hasPendingWrites: false } });
      }),
  };
}

const row = (d: object) => ({ data: () => d });
const markerRow = (itemId: string, entry: TallyEntry) => ({
  data: () => entry,
  ref: { parent: { parent: { id: itemId, parent: { id: 'tally', parent: { id: 'test-event' } } } } },
});

const TEXT = 'Danced on the lido deck';
const proof = (id: string, uid: string) =>
  ({ id, uid, displayName: uid, type: 'text', itemText: TEXT, createdAt: 1, reportCount: 0, status: 'active' }) as ProofDoc;
const moment = (uid: string): MomentDoc =>
  ({ id: `${uid}-bingo`, kind: 'bingo', uid, displayName: uid, photoURL: null, createdAt: 1 });
const marker = (uid: string, markedAt = 1): TallyEntry => ({ uid, displayName: uid, markedAt, dayIndex: 0, itemText: TEXT });
const doubt = (id: string, fromUid: string, targetUid: string) =>
  ({ id, itemId: 'item-1', fromUid, fromDisplayName: fromUid, targetUid, targetDisplayName: targetUid, createdAt: 1 }) as DoubtDoc;

// The viewer ('me') has blocked 'blocked'; 'friend' and 'third' are unrelated.
beforeEach(() => {
  H.onSnapshot.mockReset();
  H.onSnapshot.mockReturnValue(() => {});
  H.blocks = { hidden: new Set(['blocked']), ready: true };
});

describe('public read hooks drop a blocked counterpart (#689)', () => {
  it('useProofFeed drops their Proofs', () => {
    const cap = capture();
    const { result } = renderHook(() => useProofFeed());
    cap.fire([row(proof('p1', 'blocked')), row(proof('p2', 'friend'))]);
    expect(result.current.proofs.map((p) => p.id)).toEqual(['p2']);
    expect(result.current.loading).toBe(false);
  });

  it('useMoments drops their broadcast beats', () => {
    const cap = capture();
    const { result } = renderHook(() => useMoments());
    cap.fire([row(moment('blocked')), row(moment('friend'))]);
    expect(result.current.moments.map((m) => m.uid)).toEqual(['friend']);
  });

  it('useTally drops their Mark from the who-list AND the count', () => {
    const cap = capture();
    const { result } = renderHook(() => useTally('item-1'));
    cap.fire([row(marker('blocked')), row(marker('friend'))]);
    expect(result.current.markers.map((m) => m.uid)).toEqual(['friend']);
    expect(result.current.count).toBe(1);
  });

  it('useTallyCards drops their Mark from the card and its count, and emits no card they alone marked', () => {
    const cap = capture();
    const { result } = renderHook(() => useTallyCards());
    cap.fire([
      markerRow('item-1', marker('blocked', 1)),
      markerRow('item-1', marker('friend', 2)),
      markerRow('item-2', { ...marker('blocked', 3), itemText: 'Only they got this' }),
    ]);
    expect(result.current.loading).toBe(false);
    expect(result.current.cards).toHaveLength(1);
    expect(result.current.cards[0].itemId).toBe('item-1');
    expect(result.current.cards[0].markers.map((m) => m.uid)).toEqual(['friend']);
    expect(result.current.cards[0].count).toBe(1);
  });

  it('useProofsForItemText drops their Proof, so the Tally sheet never shows it', () => {
    const cap = capture();
    const { result } = renderHook(() => useProofsForItemText('Danced on the lido deck'));
    cap.fire([row(proof('p1', 'blocked')), row(proof('p2', 'friend'))]);
    expect(result.current.proofs.map((p) => p.id)).toEqual(['p2']);
  });
});

describe('Doubts across a block are hidden from both parties, visible to a third (#689 decision 5)', () => {
  const doubts = [
    doubt('me-on-blocked', 'me', 'blocked'),
    doubt('blocked-on-me', 'blocked', 'me'),
    doubt('blocked-on-friend', 'blocked', 'friend'),
    doubt('friend-on-blocked', 'friend', 'blocked'),
    doubt('friend-on-third', 'friend', 'third'),
  ];

  it('useAllDoubts hides every Doubt with either party hidden', () => {
    const cap = capture();
    const { result } = renderHook(() => useAllDoubts('me'));
    cap.fire(doubts.map(row));
    expect(result.current.doubts.map((d) => d.id)).toEqual(['friend-on-third']);
  });

  it('useDoubts applies the same rule on the Board', () => {
    const cap = capture();
    const { result } = renderHook(() => useDoubts('item-1', 'me'));
    cap.fire(doubts.map(row));
    expect(result.current.doubts.map((d) => d.id)).toEqual(['friend-on-third']);
    expect(result.current.count).toBe(1);
  });

  it('a third Player, whose hidden set names neither party, still sees the pair’s Doubts', () => {
    H.blocks = { hidden: new Set(), ready: true };
    const cap = capture();
    const { result } = renderHook(() => useAllDoubts('third'));
    cap.fire(doubts.map(row));
    expect(result.current.doubts.map((d) => d.id)).toEqual(doubts.map((d) => d.id));
  });
});

describe('readiness and the raw roster', () => {
  it('reports loading with no rows until the hidden set is ready, so nobody flashes in', () => {
    H.blocks = { hidden: new Set(), ready: false };
    const cap = capture();
    const { result, rerender } = renderHook(() => useProofFeed());
    cap.fire([row(proof('p1', 'blocked')), row(proof('p2', 'friend'))]);
    expect(result.current.loading).toBe(true);
    expect(result.current.proofs).toEqual([]);

    H.blocks = { hidden: new Set(['blocked']), ready: true };
    rerender();
    expect(result.current.loading).toBe(false);
    expect(result.current.proofs.map((p) => p.id)).toEqual(['p2']);
  });

  it('useTallyCards opens no listener and stays loading until ready', () => {
    H.blocks = { hidden: new Set(['blocked']), ready: false };
    const { result } = renderHook(() => useTallyCards());
    expect(result.current.loading).toBe(true);
    // Only the Event doc's moderation read; no markers collectionGroup query yet.
    expect(H.onSnapshot.mock.calls.filter(([t]) => (t as { kind?: string }).kind === 'query')).toHaveLength(0);
  });

  it('useLeaderboard stays RAW: a block never changes who ranked or bingoed first', () => {
    const cap = capture();
    const { result } = renderHook(() => useLeaderboard());
    const player = (uid: string) =>
      ({ uid, displayName: uid, joinedAt: 1, bingoCount: 1, squaresMarked: 5, firstBingoAt: 1, reshufflesUsed: 0 }) as PlayerDoc;
    cap.fire([row(player('blocked')), row(player('friend'))]);
    expect(result.current.players.map((p) => p.uid).sort()).toEqual(['blocked', 'friend']);
  });
});
