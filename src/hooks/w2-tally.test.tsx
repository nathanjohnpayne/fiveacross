import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// specs/w2-tally.md, RTL-jsdom layer. Proves useTally(itemId) reads a Prompt's
// public Tally (ADR 0002): it subscribes to the marker subcollection and returns
// the derived count plus the who-list — every Player who marked the Prompt, no
// anonymity — sorted chronologically by markedAt. A null/undefined itemId (e.g.
// the free centre, which never tallies) opens no subscription.

const H = vi.hoisted(() => ({ onSnapshot: vi.fn() }));

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
    onSnapshot: H.onSnapshot,
  };
});

import { useTally } from './useData';

beforeEach(() => {
  H.onSnapshot.mockReset();
  H.onSnapshot.mockReturnValue(() => {}); // unsubscribe fn
});

// Capture the subscription's onNext so a test can hand it a snapshot. The real
// hook calls onSnapshot(target, options, onNext, onError).
type SnapCb = (snap: unknown) => void;
function captureOnNext(): { fire: (snap: unknown) => void } {
  const captured: { cb: SnapCb | null } = { cb: null };
  H.onSnapshot.mockImplementation((_t: unknown, _o: unknown, onNext: SnapCb) => {
    captured.cb = onNext;
    return () => {};
  });
  return {
    fire: (snap: unknown) => {
      if (!captured.cb) throw new Error('onSnapshot not subscribed');
      act(() => captured.cb!(snap));
    },
  };
}

// A collection snapshot carrying marker docs, in the shape useColSub reads.
const tallySnap = (markers: Array<{ uid: string; displayName: string; markedAt: number }>) => ({
  docs: markers.map((m) => ({ data: () => m })),
  metadata: { fromCache: false },
});

describe('useTally (specs/w2-tally.md)', () => {
  it('returns normalized legacy names rather than only validating their source rows', () => {
    const sub = captureOnNext();
    const { result } = renderHook(() => useTally('i3'));
    sub.fire(tallySnap([{ uid: 'alice', displayName: 'x'.repeat(99) + '😀', markedAt: 1 }]));
    expect(result.current.markers).toEqual([{ uid: 'alice', displayName: 'x'.repeat(99), markedAt: 1 }]);
  });

  it('returns the count and the who-list, sorted chronologically by markedAt', () => {
    const sub = captureOnNext();
    const { result } = renderHook(() => useTally('i3'));

    // Delivered out of order; useTally sorts by markedAt so the list reads
    // earliest-marker-first.
    sub.fire(
      tallySnap([
        { uid: 'bob', displayName: 'Bob', markedAt: 200 },
        { uid: 'alice', displayName: 'Alice', markedAt: 100 },
        { uid: 'carol', displayName: 'Carol', markedAt: 300 },
      ]),
    );

    expect(result.current.count).toBe(3); // the badge count
    expect(result.current.markers.map((m) => m.displayName)).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('opens no subscription for a null/undefined itemId (e.g. the free centre)', () => {
    const { result } = renderHook(() => useTally(null));

    expect(H.onSnapshot).not.toHaveBeenCalled();
    expect(result.current.count).toBe(0);
    expect(result.current.markers).toEqual([]);
  });
});
