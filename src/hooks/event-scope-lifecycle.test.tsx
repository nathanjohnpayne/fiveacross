import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (snapshot: any) => void;
type ErrorListener = (error: unknown) => void;

const H = vi.hoisted(() => ({
  eventId: 'event-a',
  subscriptions: [] as Array<{
    target: { kind?: string; args?: unknown[] };
    listener: Listener;
    onError: ErrorListener;
    unsubscribe: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('../firebase', () => ({
  db: {},
  get EVENT_ID() {
    return H.eventId;
  },
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
    query: (...args: unknown[]) => ({ kind: 'query', args }),
    where: (...args: unknown[]) => ({ kind: 'where', args }),
    onSnapshot: (...args: unknown[]) => {
      const target = args[0] as { kind?: string; args?: unknown[] };
      const listener = (typeof args[1] === 'function' ? args[1] : args[2]) as Listener;
      const onError = (typeof args[1] === 'function' ? args[2] : args[3]) as
        | ErrorListener
        | undefined;
      const unsubscribe = vi.fn();
      H.subscriptions.push({ target, listener, onError: onError ?? (() => {}), unsubscribe });
      return unsubscribe;
    },
  };
});

import { useDayMeta, useDayMetasStatus, useMyDayBoards, useTallyCards } from './useData';
import { trustedDayBoardSeed } from '../data/board-freshness';

const docSnapshot = (value: object | null) => ({
  exists: () => value !== null,
  data: () => value ?? undefined,
  metadata: { fromCache: false, hasPendingWrites: false },
});

const collectionSnapshot = (values: object[]) => ({
  docs: values.map((value) => ({ data: () => value })),
  metadata: { fromCache: false, hasPendingWrites: false },
});

const markerSnapshot = (eventId: string, itemId: string, markedAt = 10) => ({
  docs: [
    {
      data: () => ({
        uid: `${eventId}-uid`,
        eventId,
        displayName: eventId,
        markedAt,
        dayIndex: 0,
        itemText: `${eventId} prompt`,
      }),
      ref: {
        parent: {
          parent: { id: itemId, parent: { id: 'tally', parent: { id: eventId } } },
        },
      },
    },
  ],
  metadata: { fromCache: false, hasPendingWrites: false },
});

beforeEach(() => {
  H.eventId = 'event-a';
  H.subscriptions = [];
});

describe('manual Event-scoped listener lifecycles (#807)', () => {
  it('rekeys one-Day metadata and ignores the old listener after cleanup', () => {
    const view = renderHook(() => useDayMeta(0));
    const a = H.subscriptions[0];
    act(() => a.listener(docSnapshot({ firstBingo: { uid: 'a' } })));
    expect(view.result.current.data).toMatchObject({ firstBingo: { uid: 'a' } });

    H.eventId = 'event-b';
    view.rerender();
    const b = H.subscriptions[1];
    expect(view.result.current.data).toBeNull();
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);
    expect(b.target.args).toContain('event-b');

    act(() => a.listener(docSnapshot({ firstBingo: { uid: 'a-late' } })));
    expect(view.result.current.data).toBeNull();
    act(() => b.listener(docSnapshot({ firstBingo: { uid: 'b' } })));
    expect(view.result.current.data).toMatchObject({ firstBingo: { uid: 'b' } });
  });

  it('clears and rebuilds the all-Day metadata fan for the new Event', () => {
    const view = renderHook(() => useDayMetasStatus(1));
    const a = H.subscriptions[0];
    act(() => a.listener(docSnapshot({ dayIndex: 0, source: 'A' })));
    expect(view.result.current.metas.get(0)).toMatchObject({ source: 'A' });

    H.eventId = 'event-b';
    view.rerender();
    expect(view.result.current.metas.size).toBe(0);
    expect(view.result.current.loaded).toBe(false);
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);

    const b = H.subscriptions[1];
    expect(b.target.args).toContain('event-b');
    act(() => a.onError(new Error('late Event A permission error')));
    expect(view.result.current.loaded).toBe(false);
    act(() => b.listener(docSnapshot({ dayIndex: 0, source: 'B' })));
    act(() => a.listener(docSnapshot({ dayIndex: 0, source: 'A-late' })));
    expect(view.result.current.metas.get(0)).toMatchObject({ source: 'B' });
  });

  it('clears and rebuilds the Player board fan for the new Event', () => {
    const view = renderHook(() => useMyDayBoards('u1', [0]));
    const a = H.subscriptions[0];
    act(() => a.listener(docSnapshot({ uid: 'u1', dayIndex: 0, source: 'A' })));
    expect(view.result.current.get(0)).toMatchObject({ source: 'A' });

    H.eventId = 'event-b';
    view.rerender();
    expect(view.result.current.size).toBe(0);
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);

    const b = H.subscriptions[1];
    expect(b.target.args).toContain('event-b');
    // A fully committed snapshot queued before cleanup must not certify its
    // seed under the live B identity.
    act(() =>
      a.listener(docSnapshot({ uid: 'u1', dayIndex: 0, source: 'A-late', seed: 41 })),
    );
    expect(trustedDayBoardSeed('event-b', 0, 'u1')).toEqual({
      trusted: false,
      seed: undefined,
    });
    act(() => b.listener(docSnapshot({ uid: 'u1', dayIndex: 0, source: 'B' })));
    expect(view.result.current.get(0)).toMatchObject({ source: 'B' });

    H.eventId = 'event-a';
    view.rerender();
    expect(view.result.current.size).toBe(0);
    act(() => a.listener(docSnapshot({ uid: 'u1', dayIndex: 0, source: 'A-stale' })));
    expect(view.result.current.size).toBe(0);
  });

  it('scopes marker delivery by the captured Event while isolating its lifecycle and displayed state', () => {
    const view = renderHook(() => useTallyCards());
    const tallySubs = () =>
      H.subscriptions.filter((sub) => {
        if (sub.target.kind === 'collectionGroup') return sub.target.args?.[1] === 'markers';
        const source = sub.target.args?.[0] as { kind?: string; args?: unknown[] } | undefined;
        return sub.target.kind === 'query' && source?.kind === 'collectionGroup' && source.args?.[1] === 'markers';
      });
    const a = tallySubs()[0];
    expect(a.target.kind).toBe('query');
    expect(a.target.args?.[1]).toEqual({ kind: 'where', args: ['eventId', '==', 'event-a'] });
    act(() => a.listener(markerSnapshot('event-a', 'same-item', 1_000)));
    expect(view.result.current.cards.map((card) => card.itemId)).toEqual(['same-item']);

    H.eventId = 'event-b';
    view.rerender();
    const b = tallySubs()[1];
    expect(view.result.current.cards).toEqual([]);
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);
    expect(b).toBeDefined();
    expect(b.target.args?.[1]).toEqual({ kind: 'where', args: ['eventId', '==', 'event-b'] });

    // Keep the callback guard through the staged migration: even if a malformed
    // or stale SDK snapshot violates the server predicate, its path cannot cross
    // the captured Event boundary.
    act(() => b.listener(markerSnapshot('event-a', 'foreign-item', 1_001)));
    expect(view.result.current.cards).toEqual([]);

    act(() => b.listener(markerSnapshot('event-b', 'same-item', 1_001)));
    expect(view.result.current.cards.map((card) => card.itemId)).toEqual(['same-item']);
    expect(view.result.current.cards[0].displayBump).toBe(1_001);
    act(() => a.listener(markerSnapshot('event-a', 'same-item', 1_002)));
    expect(view.result.current.cards.map((card) => card.itemId)).toEqual(['same-item']);
    expect(view.result.current.cards[0].displayBump).toBe(1_001);
  });
});
