import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// specs/player-blocking.md — the hidden-set provider (#689). onSnapshot is
// mocked so what is pinned is the listener's lifecycle: when one exists, what
// it queries, how the pending-write and error paths publish, and how an
// account or Event switch resets the set.

type Listener = (snapshot: unknown) => void;
type ErrorListener = (error: unknown) => void;
type Subscription = {
  target: unknown;
  options: unknown;
  listener: Listener;
  onError: ErrorListener;
  unsubscribe: ReturnType<typeof vi.fn>;
};

const H = vi.hoisted(() => ({
  eventId: 'event-a',
  subscriptions: [] as Subscription[],
  // Every server-only pair delete the reconciler sends, by document path.
  reconciled: [] as string[],
}));

vi.mock('../firebase', () => ({
  db: {},
  get EVENT_ID() {
    return H.eventId;
  },
}));
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, ...segments: string[]) => ({ kind: 'collection', path: segments.join('/'), withConverter() { return this; } }),
  doc: (_db: unknown, ...segments: string[]) => ({ kind: 'doc', path: segments.join('/'), withConverter() { return this; } }),
  writeBatch: () => {
    throw new Error('the provider never writes a batch');
  },
  runTransaction: async (_db: unknown, update: (tx: { delete: (ref: { path: string }) => void }) => Promise<void>) => {
    await update({ delete: (ref) => H.reconciled.push(ref.path) });
    // The common outcome: a direction still stands, so the rules deny it.
    throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  },
  query: (...args: unknown[]) => ({ kind: 'query', args }),
  where: (...args: unknown[]) => ({ kind: 'where', args }),
  onSnapshot: (...args: unknown[]) => {
    const hasOptions = typeof args[1] !== 'function';
    const unsubscribe = vi.fn();
    H.subscriptions.push({
      target: args[0],
      options: hasOptions ? args[1] : undefined,
      listener: (hasOptions ? args[2] : args[1]) as Listener,
      onError: ((hasOptions ? args[3] : args[2]) ?? (() => {})) as ErrorListener,
      unsubscribe,
    });
    return unsubscribe;
  },
}));

import {
  HiddenUidsProvider,
  resetReconcileAttemptsForTests,
  useHiddenUids,
  useHiddenUidsSubscription,
  useMyBlocks,
} from './useBlocks';

const pairs = (rows: Array<[string, string]>, hasPendingWrites = false) => ({
  docs: rows.map((uids) => ({ data: () => ({ uids, eventId: H.eventId }) })),
  metadata: { fromCache: false, hasPendingWrites },
});
const whereOf = (sub: Subscription) => (sub.target as { args: unknown[] }).args[1];
const pathOf = (sub: Subscription) => ((sub.target as { args: unknown[] }).args[0] as { path: string }).path;

beforeEach(() => {
  H.eventId = 'event-a';
  H.subscriptions = [];
  H.reconciled = [];
  resetReconcileAttemptsForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useHiddenUidsSubscription', () => {
  it('signed out: ready with nothing hidden, and no listener', () => {
    const view = renderHook(() => useHiddenUidsSubscription(null, true));
    expect(view.result.current).toEqual({ hidden: new Set(), ready: true });
    expect(H.subscriptions).toHaveLength(0);
  });

  it('signed in but not enabled: NOT ready, nothing hidden, and no listener', () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', false));
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    expect(H.subscriptions).toHaveLength(0);
  });

  it('subscribes once to the array-contains pair query with metadata changes and publishes the counterparts', () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    expect(view.result.current.ready).toBe(false);
    expect(H.subscriptions).toHaveLength(1);
    const sub = H.subscriptions[0];
    expect(pathOf(sub)).toBe('events/event-a/blockPairs');
    expect(whereOf(sub)).toEqual({ kind: 'where', args: ['uids', 'array-contains', 'bob'] });
    expect(sub.options).toEqual({ includeMetadataChanges: true });
    act(() => sub.listener(pairs([['alice', 'bob'], ['bob', 'carol']])));
    expect(view.result.current.ready).toBe(true);
    expect([...view.result.current.hidden].sort()).toEqual(['alice', 'carol']);
  });

  it('a pending-write snapshot keeps the last committed set hidden until a settled one arrives', () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const sub = H.subscriptions[0];
    act(() => sub.listener(pairs([['alice', 'bob']])));
    // A pending block hides immediately...
    act(() => sub.listener(pairs([['alice', 'bob'], ['bob', 'carol']], true)));
    expect([...view.result.current.hidden].sort()).toEqual(['alice', 'carol']);
    // ...a snapshot with pending writes never reveals anyone (defence in
    // depth: unblocks are server-only transactions, so a pair leaves only
    // in a settled snapshot)...
    act(() => sub.listener(pairs([], true)));
    expect([...view.result.current.hidden]).toEqual(['alice']);
    // ...and the settled snapshot is what finally reveals.
    act(() => sub.listener(pairs([])));
    expect([...view.result.current.hidden]).toEqual([]);
  });

  it('offers each server-confirmed pair to the orphan reconciler once per session, never from cache or a pending snapshot', async () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const sub = H.subscriptions[0];
    const cached = { ...pairs([['alice', 'bob']]), metadata: { fromCache: true, hasPendingWrites: false } };
    act(() => sub.listener(cached));
    act(() => sub.listener(pairs([['alice', 'bob'], ['bob', 'carol']], true)));
    expect(H.reconciled).toEqual([]);
    act(() => sub.listener(pairs([['alice', 'bob'], ['bob', 'carol']])));
    act(() => sub.listener(pairs([['alice', 'bob'], ['bob', 'carol']])));
    await act(async () => {});
    expect([...H.reconciled].sort()).toEqual(['events/event-a/blockPairs/alice_bob', 'events/event-a/blockPairs/bob_carol']);
    // A denial (a direction still stands) changes nothing the viewer sees.
    expect([...view.result.current.hidden].sort()).toEqual(['alice', 'carol']);
    // A remount in the same session does not ask again.
    view.unmount();
    const again = renderHook(() => useHiddenUidsSubscription('bob', true));
    act(() => H.subscriptions[1].listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.reconciled).toHaveLength(2);
    again.unmount();
  });

  it('signing in while not yet enabled is NOT ready on the very first render (no signed-out carry-over)', () => {
    const seen: Array<{ ready: boolean }> = [];
    const view = renderHook(
      ({ uid, enabled }) => {
        const value = useHiddenUidsSubscription(uid, enabled);
        seen.push({ ready: value.ready });
        return value;
      },
      { initialProps: { uid: null as string | null, enabled: false } },
    );
    expect(view.result.current.ready).toBe(true);
    const signedOutRenders = seen.length;
    view.rerender({ uid: 'bob', enabled: false });
    expect(seen.slice(signedOutRenders).every((v) => v.ready === false)).toBe(true);
    expect(H.subscriptions).toHaveLength(0);
  });

  it('an account switch drops the old set, resubscribes, and ignores the old listener', () => {
    const view = renderHook(({ uid }) => useHiddenUidsSubscription(uid, true), {
      initialProps: { uid: 'bob' as string | null },
    });
    const first = H.subscriptions[0];
    act(() => first.listener(pairs([['alice', 'bob']])));
    view.rerender({ uid: 'carol' });
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    expect(whereOf(H.subscriptions[1])).toEqual({ kind: 'where', args: ['uids', 'array-contains', 'carol'] });
    act(() => first.listener(pairs([['alice', 'bob']])));
    expect(view.result.current.hidden.size).toBe(0);
    view.rerender({ uid: null });
    expect(H.subscriptions[1].unsubscribe).toHaveBeenCalledTimes(1);
    expect(view.result.current).toEqual({ hidden: new Set(), ready: true });
  });

  it('an Event switch rekeys the listener under the new Event', () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    H.eventId = 'event-b';
    view.rerender();
    expect(H.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(pathOf(H.subscriptions[1])).toBe('events/event-b/blockPairs');
  });

  it('a listener error logs, resolves ready, and keeps the last set rather than blanking the app', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const sub = H.subscriptions[0];
    act(() => sub.listener(pairs([['alice', 'bob']])));
    act(() => sub.onError(new Error('permission-denied')));
    expect(view.result.current.ready).toBe(true);
    expect([...view.result.current.hidden]).toEqual(['alice']);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('HiddenUidsProvider / useHiddenUids', () => {
  function Probe() {
    const { hidden, ready } = useHiddenUids();
    return <output>{`${ready ? 'ready' : 'waiting'}:${[...hidden].join(',')}`}</output>;
  }

  it('without a provider the default is ready and empty, so existing trees render as today', () => {
    render(<Probe />);
    expect(screen.getByRole('status')).toHaveTextContent('ready:');
    expect(H.subscriptions).toHaveLength(0);
  });

  it('with a provider the tree reads the live set', () => {
    render(
      <HiddenUidsProvider uid="bob" enabled>
        <Probe />
      </HiddenUidsProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('waiting:');
    act(() => H.subscriptions[0].listener(pairs([['alice', 'bob']])));
    expect(screen.getByRole('status')).toHaveTextContent('ready:alice');
  });
});

describe('useMyBlocks', () => {
  it('lists the viewer’s own direction records by ownerUid equality', () => {
    const view = renderHook(() => useMyBlocks('bob'));
    expect(view.result.current).toEqual({ data: [], loading: true });
    const sub = H.subscriptions[0];
    expect(pathOf(sub)).toBe('events/event-a/blocks');
    expect(whereOf(sub)).toEqual({ kind: 'where', args: ['ownerUid', '==', 'bob'] });
    const row = { ownerUid: 'bob', targetUid: 'alice', eventId: 'event-a', createdAt: 1 };
    act(() => sub.listener({ docs: [{ data: () => row }], metadata: { fromCache: false, hasPendingWrites: false } }));
    expect(view.result.current).toEqual({ data: [row], loading: false });
  });

  it('signed out: settled and empty with no listener; an error settles empty', () => {
    expect(renderHook(() => useMyBlocks(null)).result.current).toEqual({ data: [], loading: false });
    expect(H.subscriptions).toHaveLength(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = renderHook(() => useMyBlocks('bob'));
    act(() => H.subscriptions[0].onError(new Error('denied')));
    expect(view.result.current).toEqual({ data: [], loading: false });
  });
});
