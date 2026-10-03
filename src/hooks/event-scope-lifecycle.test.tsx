import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (snapshot: any) => void;
type ErrorListener = (error: unknown) => void;

const H = vi.hoisted(() => ({
  eventId: 'event-a',
  adultRequired: true,
  hidden: new Set<string>(),
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
vi.mock('./useAdultContent', () => ({ useAdultContent: () => H.adultRequired }));
vi.mock('./useBlocks', () => ({ useHiddenUids: () => ({ hidden: H.hidden, ready: true }) }));

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
      id: `${eventId}-uid`,
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
  H.adultRequired = true;
  H.hidden = new Set();
  H.subscriptions = [];
});

describe('manual Event-scoped listener lifecycles (#807)', () => {
  it.each(['adult', 'threshold', 'days', 'threshold-with-hidden-set', 'ban'] as const)('clears Tally cards across a %s policy change before replacement snapshots', (policy) => {
    const view = renderHook(() => useTallyCards());
    const eventSubs = H.subscriptions.filter((s) => s.target.kind === 'doc');
    const event = { days: [{ index: 0 }], bannedUids: [], settings: { reportHideThreshold: 4 } };
    act(() => eventSubs.forEach((s) => s.listener(docSnapshot(event))));
    const current = () => H.subscriptions.filter((s) => !s.unsubscribe.mock.calls.length);
    const prompts = () => current().find((s) => {
      const source = s.target.args?.[0] as { kind?: string; args?: unknown[] } | undefined;
      return source?.kind === 'collection' && source.args?.includes('items');
    })!;
    const markers = () => current().find((s) => {
      const source = s.target.args?.[0] as { kind?: string } | undefined;
      return source?.kind === 'collectionGroup';
    })!;
    const oldPrompts = prompts();
    const oldMarkers = markers();
    const prompt = { docs: [{ id: 'same-item', data: () => ({ status: 'active', text: 'Trusted prompt', reportCount: 3, spicy: true }) }], metadata: { fromCache: false, hasPendingWrites: false } };
    act(() => { oldPrompts.listener(prompt); oldMarkers.listener(markerSnapshot('event-a', 'same-item')); });
    expect(view.result.current.cards).toHaveLength(1);
    if (policy === 'adult') { H.adultRequired = false; view.rerender(); }
    else act(() => {
      if (policy === 'threshold-with-hidden-set') H.hidden = new Set(['unrelated-blocked']);
      eventSubs.forEach((s) => s.listener(docSnapshot(policy.startsWith('threshold')
      ? { ...event, settings: { reportHideThreshold: 3 } }
      : policy === 'ban' ? { ...event, bannedUids: ['event-a-uid'] }
      : { ...event, days: [{ index: 1 }] })));
    });
    expect(view.result.current.cards).toEqual([]);
    expect(view.result.current.loading).toBe(true);
    // Retired policy callbacks cannot restore withheld text.
    act(() => { oldPrompts.listener(prompt); oldMarkers.listener(markerSnapshot('event-a', 'same-item')); });
    expect(view.result.current.cards).toEqual([]);
    act(() => markers().listener(markerSnapshot('event-a', 'same-item')));
    expect(view.result.current.cards).toEqual([]);
    act(() => prompts().listener(prompt));
    expect(view.result.current.cards).toEqual([]);
    expect(view.result.current.loading).toBe(false);
  });

  it('keeps a restored Prompt in Tally cards while requiring strict suppression and active status', () => {
    const view = renderHook(() => useTallyCards());
    act(() => {
      for (const sub of H.subscriptions.filter((s) => s.target.kind === 'doc')) {
        sub.listener(docSnapshot({ days: [{ index: 0 }], bannedUids: [], settings: { reportHideThreshold: 3 } }));
      }
    });
    const current = () => H.subscriptions.filter((s) => !s.unsubscribe.mock.calls.length);
    const promptSub = current().find((sub) => {
      const source = sub.target.args?.[0] as { kind?: string; args?: unknown[] } | undefined;
      return source?.kind === 'collection' && source.args?.includes('items');
    })!;
    const markerSub = current().find((sub) => {
      const source = sub.target.args?.[0] as { kind?: string; args?: unknown[] } | undefined;
      return source?.kind === 'collectionGroup' && source.args?.[1] === 'markers';
    })!;
    const publishPrompt = (reportHideSuppressed: unknown, status = 'active') => act(() => {
      promptSub.listener({ ...collectionSnapshot([]), docs: [{ id: 'same-item', data: () => ({
        status, text: 'Restored trusted prompt', reportCount: 5, reportHideSuppressed,
      }) }] });
    });
    act(() => markerSub.listener(markerSnapshot('event-a', 'same-item')));
    publishPrompt(false);
    expect(view.result.current.cards).toEqual([]);
    publishPrompt(true);
    expect(view.result.current.cards).toHaveLength(1);
    expect(view.result.current.cards[0].itemText).toBe('Restored trusted prompt');
    publishPrompt('true');
    expect(view.result.current.cards).toEqual([]);
    publishPrompt(true, 'hidden');
    expect(view.result.current.cards).toEqual([]);
  });

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
    const view = renderHook(() => useDayMetasStatus([0]));
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
    const seedContext = (eventId: string) => {
      const subs = H.subscriptions.filter((sub) => !sub.unsubscribe.mock.calls.length);
      act(() => {
        for (const sub of subs) {
          if (sub.target.kind === 'doc') sub.listener(docSnapshot({ days: [{ index: 0 }], bannedUids: [] }));
        }
      });
      act(() => {
      for (const sub of H.subscriptions.filter((sub) => !sub.unsubscribe.mock.calls.length)) {
        const source = sub.target.args?.[0] as { kind?: string; args?: unknown[] } | undefined;
        if (source?.kind === 'collection' && source.args?.includes('items'))
          sub.listener({ ...collectionSnapshot([]), docs: [{ id: 'same-item', data: () => ({ status: 'active', text: `${eventId} trusted prompt` }) }] });
      }
      });
    };
    seedContext('event-a');
    const a = tallySubs().at(-1)!;
    expect(a.target.kind).toBe('query');
    expect(a.target.args?.[1]).toEqual({ kind: 'where', args: ['eventId', '==', 'event-a'] });
    act(() => a.listener(markerSnapshot('event-a', 'same-item', 1_000)));
    expect(view.result.current.cards.map((card) => card.itemId)).toEqual(['same-item']);
    expect(view.result.current.cards[0].itemText).toBe('event-a trusted prompt');
    const aPrompts = H.subscriptions.filter((sub) => {
      const source = sub.target.args?.[0] as { kind?: string; args?: unknown[] } | undefined;
      return !sub.unsubscribe.mock.calls.length && source?.kind === 'collection' && source.args?.includes('items');
    }).at(-1)!;

    H.eventId = 'event-b';
    view.rerender();
    seedContext('event-b');
    const b = tallySubs().at(-1)!;
    expect(view.result.current.cards).toEqual([]);
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);
    expect(aPrompts.unsubscribe).toHaveBeenCalledTimes(1);
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
    expect(view.result.current.cards[0].itemText).toBe('event-b trusted prompt');
    act(() => aPrompts.listener(collectionSnapshot([])));
    expect(view.result.current.cards[0].itemText).toBe('event-b trusted prompt');

    const bPrompts = H.subscriptions.filter((sub) => {
      const source = sub.target.args?.[0] as { kind?: string; args?: unknown[] } | undefined;
      return !sub.unsubscribe.mock.calls.length && source?.kind === 'collection' && source.args?.includes('items');
    }).at(-1)!;
    // Prompt removal/moderation drops a Tally without another marker snapshot.
    act(() => bPrompts.listener({ docs: [{ id: 'same-item', data: () => ({ status: 'rejected', text: 'hidden prompt' }) }] }));
    expect(view.result.current.cards).toEqual([]);
    act(() => bPrompts.listener({ docs: [{ id: 'same-item', data: () => ({ status: 'active', text: 'restored trusted prompt' }) }] }));
    expect(view.result.current.cards[0].itemText).toBe('restored trusted prompt');
    act(() => bPrompts.onError(new Error('denied')));
    expect(view.result.current.cards).toEqual([]);
  });
});
