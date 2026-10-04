import { Suspense, startTransition, useState } from 'react';
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
  session: { uid: 'bob' as string | null, db: { memory: true } as object | null, generation: 0, transition: 'auth' as 'auth' | 'connection' | 'recovery', recoveryRequired: false, failed: false },
  subscriptions: [] as Subscription[],
  // Every server-only pair delete the reconciler sends, by document path.
  reconciled: [] as string[],
  // Every server-only pair re-set the repair sends, and its own-direction listings.
  repaired: [] as string[],
  ownListings: 0,
  ownTargets: [] as string[] | Error,
  blockCommits: [] as Array<() => Promise<void>>,
}));

vi.mock('../firebase', () => ({
  db: {},
  auth: { get currentUser() { return H.session.uid ? { uid: H.session.uid } : null; } },
  get EVENT_ID() {
    return H.eventId;
  },
}));
vi.mock('./usePrivateFirestore', () => ({ usePrivateFirestore: () => H.session }));
vi.mock('../privateFirestore', () => {
  const capture = () => {
    const { uid, db, generation } = H.session;
    const assertCurrent = () => { if (!db || uid !== H.session.uid || generation !== H.session.generation) throw new Error('Private session expired.'); };
    return { uid, db, assertCurrent, guard: async <T,>(op: () => Promise<T>) => { assertCurrent(); const value = await op(); assertCurrent(); return value; } };
  };
  return { capturePrivateFirestore: capture, awaitPrivateFirestore: async (uid: string) => { const lease = capture(); if (lease.uid !== uid) throw new Error('Private account changed.'); lease.assertCurrent(); return lease; } };
});
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, ...segments: string[]) => ({ database: _db, kind: 'collection', path: segments.join('/'), withConverter() { return this; } }),
  doc: (_db: unknown, ...segments: string[]) => ({ kind: 'doc', path: segments.join('/'), withConverter() { return this; } }),
  writeBatch: () => ({ set: vi.fn(), commit: () => (H.blockCommits.shift() ?? (() => Promise.resolve()))() }),
  runTransaction: async (
    _db: unknown,
    update: (tx: { delete: (ref: { path: string }) => void; set: (ref: { path: string }) => void }) => Promise<void>,
  ) => {
    let deleted = false;
    await update({
      delete: (ref) => {
        deleted = true;
        H.reconciled.push(ref.path);
      },
      set: (ref) => H.repaired.push(ref.path),
    });
    // The common reconcile outcome: a direction still stands, so the rules deny it.
    if (deleted) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  },
  getDocsFromServer: async () => {
    H.ownListings += 1;
    if (H.ownTargets instanceof Error) throw H.ownTargets;
    return { docs: H.ownTargets.map((targetUid) => ({ data: () => ({ targetUid }) })) };
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

import { blockPlayer, retirePendingBlocks, pendingBlockTargets } from '../data/blocks';

import {
  HiddenUidsProvider,
  REPAIR_RETRY_ATTEMPTS,
  REPAIR_RETRY_BASE_MS,
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
  H.session = { uid: 'bob', db: { memory: true }, generation: 0, transition: 'auth' as 'auth' | 'connection' | 'recovery', recoveryRequired: false, failed: false };
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  H.subscriptions = [];
  H.reconciled = [];
  H.repaired = [];
  H.ownListings = 0;
  H.ownTargets = []; H.blockCommits = [];
  for (const uid of ['bob', 'carol']) for (const eventId of ['event-a', 'event-b']) retirePendingBlocks(uid, eventId);
  resetReconcileAttemptsForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useHiddenUidsSubscription', () => {
  it('same-scope remount retains pending targets without granting cold readiness', async () => {
    const first = renderHook(() => useHiddenUidsSubscription('bob', true));
    act(() => H.subscriptions[0].listener(pairs([])));
    let release!: () => void;
    H.blockCommits = [() => new Promise<void>(resolve => { release = resolve; })];
    let commit!: Promise<void>;
    act(() => { commit = blockPlayer({ me: 'bob', target: 'alice' }); });
    expect(first.result.current.hidden.has('alice')).toBe(true);
    first.unmount();
    const remounted = renderHook(() => useHiddenUidsSubscription('bob', true));
    expect(remounted.result.current.ready).toBe(false);
    act(() => H.subscriptions[1].listener(pairs([])));
    expect(remounted.result.current).toEqual({ hidden: new Set(['alice']), ready: true });
    await act(async () => { release(); await commit; });
    expect(remounted.result.current.hidden.has('alice')).toBe(true);
    act(() => H.subscriptions[1].listener(pairs([['alice', 'bob']])));
    expect(pendingBlockTargets('bob', H.eventId).size).toBe(0);
    expect(remounted.result.current.hidden.has('alice')).toBe(true);
  });

  it('a committed other scope retires pending intent even between provider mounts', async () => {
    const first = renderHook(() => useHiddenUidsSubscription('bob', true));
    act(() => H.subscriptions[0].listener(pairs([])));
    let release!: () => void;
    H.blockCommits = [() => new Promise<void>(resolve => { release = resolve; })];
    let commit!: Promise<void>;
    act(() => { commit = blockPlayer({ me: 'bob', target: 'alice' }); });
    first.unmount();
    H.session = { ...H.session, uid: 'carol', generation: 1 };
    const other = renderHook(() => useHiddenUidsSubscription('carol', true));
    expect(pendingBlockTargets('bob', H.eventId).size).toBe(0);
    other.unmount();
    H.session = { ...H.session, uid: 'bob', generation: 2 };
    const returned = renderHook(() => useHiddenUidsSubscription('bob', true));
    act(() => H.subscriptions[2].listener(pairs([])));
    await act(async () => { release(); await commit; });
    expect(returned.result.current).toEqual({ hidden: new Set(), ready: true });
  });

  it('a discarded scope render cannot erase the committed offline witness', () => {
    let changeUid!: (uid: string) => void;
    let refresh!: () => void;
    let suspendedRenders = 0;
    const pause = new Promise<never>(() => {});
    function Reader({ uid }: { uid: string }) {
      const value = useHiddenUidsSubscription(uid, true);
      if (uid === 'carol') { suspendedRenders += 1; throw pause; }
      return <output data-testid="committed-hidden">{`${value.ready}:${[...value.hidden].join(',')}`}</output>;
    }
    function Harness() {
      const [uid, setUid] = useState('bob'); changeUid = setUid;
      const [, setTick] = useState(0); refresh = () => setTick(tick => tick + 1);
      return <Suspense fallback={<span>Waiting</span>}><Reader uid={uid} /></Suspense>;
    }
    render(<Harness />);
    act(() => H.subscriptions[0].listener(pairs([['alice', 'bob']])));
    expect(screen.getByTestId('committed-hidden')).toHaveTextContent('true:alice');
    act(() => { startTransition(() => changeUid('carol')); });
    expect(suspendedRenders).toBeGreaterThan(0);
    expect(screen.getByTestId('committed-hidden')).toHaveTextContent('true:alice');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    H.session = { ...H.session, db: null, generation: 1 };
    act(() => { changeUid('bob'); refresh(); });
    expect(screen.getByTestId('committed-hidden')).toHaveTextContent('true:alice');
  });

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
    // A pair that appears later in the subscription (here a new block,
    // or a repair write recreating an orphan) is offered again, even one
    // already offered this session.
    act(() => sub.listener(pairs([['alice', 'bob']])));
    act(() => sub.listener(pairs([['alice', 'bob'], ['bob', 'carol']])));
    await act(async () => {});
    expect(H.reconciled.filter((p) => p.endsWith('bob_carol'))).toHaveLength(2);
    // A remount in the same session does not ask again.
    view.unmount();
    const again = renderHook(() => useHiddenUidsSubscription('bob', true));
    act(() => H.subscriptions[1].listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.reconciled).toHaveLength(3);
    again.unmount();
  });

  it('once per subscription, restores the pair behind an own direction that lost it; an offline listing is retried on the next server snapshot', async () => {
    H.ownTargets = new Error('unavailable');
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const sub = H.subscriptions[0];
    const cached = { ...pairs([['alice', 'bob']]), metadata: { fromCache: true, hasPendingWrites: false } };
    act(() => sub.listener(cached));
    await act(async () => {});
    expect(H.ownListings).toBe(0);
    act(() => sub.listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.ownListings).toBe(1);
    expect(H.repaired).toEqual([]);
    // Back online: Bob's direction toward Dave lost its pair to a concurrent delete.
    H.ownTargets = ['alice', 'dave'];
    act(() => sub.listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.ownListings).toBe(2);
    expect(H.repaired).toEqual(['events/event-a/blockPairs/bob_dave']);
    act(() => sub.listener(pairs([['alice', 'bob'], ['bob', 'dave']])));
    await act(async () => {});
    expect(H.ownListings).toBe(2);
    // Later in the SAME session a concurrent delete drops the Dave pair
    // again: a pair disappearing re-arms the repair at once.
    act(() => sub.listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.ownListings).toBe(3);
    expect(H.repaired).toEqual(['events/event-a/blockPairs/bob_dave', 'events/event-a/blockPairs/bob_dave']);
    // A pending snapshot never lists; a loss seen on one is owed to the next
    // settled snapshot, which lists once; an unchanged settled one does not.
    act(() => sub.listener(pairs([], true)));
    act(() => sub.listener(pairs([['alice', 'bob']], true)));
    await act(async () => {});
    expect(H.ownListings).toBe(3);
    act(() => sub.listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.ownListings).toBe(4);
    act(() => sub.listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.ownListings).toBe(4);
    // An outage (a cache snapshot) and the reconnect: the first server
    // snapshot after it checks again, even with no pair disappearing.
    act(() => sub.listener({ ...pairs([['alice', 'bob']]), metadata: { fromCache: true, hasPendingWrites: false } }));
    await act(async () => {});
    expect(H.ownListings).toBe(4);
    act(() => sub.listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.ownListings).toBe(5);
    view.unmount();
    // A later subscription to the SAME key (after a sign-out or an Event
    // switch) checks again: a pair lost during the gap shows no disappearance.
    H.ownTargets = ['alice', 'erin'];
    const back = renderHook(() => useHiddenUidsSubscription('bob', true));
    act(() => H.subscriptions[1].listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.ownListings).toBe(6);
    expect(H.repaired.at(-1)).toBe('events/event-a/blockPairs/bob_erin');
    back.unmount();
  });

  it('a pair that disappears on a PENDING snapshot is still repaired on the next settled one', async () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const sub = H.subscriptions[0];
    act(() => sub.listener(pairs([['alice', 'bob']])));
    await act(async () => {});
    expect(H.ownListings).toBe(1);
    // Bob blocks Carol (pending) while a concurrent delete drops the Alice
    // pair: the loss shows only on a pending snapshot...
    H.ownTargets = ['alice', 'carol'];
    act(() => sub.listener(pairs([['alice', 'bob'], ['bob', 'carol']], true)));
    act(() => sub.listener(pairs([['bob', 'carol']], true)));
    await act(async () => {});
    expect(H.ownListings).toBe(1);
    // ...and the settled snapshot, where nothing new disappears, still owes it.
    act(() => sub.listener(pairs([['bob', 'carol']])));
    await act(async () => {});
    expect(H.ownListings).toBe(2);
    expect(H.repaired).toEqual(['events/event-a/blockPairs/alice_bob']);
    // Paid once: the next unchanged settled snapshot does not list again.
    act(() => sub.listener(pairs([['bob', 'carol']])));
    await act(async () => {});
    expect(H.ownListings).toBe(2);
    view.unmount();
  });

  it('a failed repair while the listener stays server-backed is retried on a doubling timer, with no new snapshot', async () => {
    vi.useFakeTimers();
    try {
      H.ownTargets = Object.assign(new Error('aborted'), { code: 'aborted' });
      const view = renderHook(() => useHiddenUidsSubscription('bob', true));
      const sub = H.subscriptions[0];
      act(() => sub.listener(pairs([['alice', 'bob']])));
      await act(async () => {});
      expect(H.ownListings).toBe(1);
      // A failed write produces no snapshot; the timer retries it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REPAIR_RETRY_BASE_MS);
      });
      expect(H.ownListings).toBe(2);
      H.ownTargets = ['alice', 'dave'];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REPAIR_RETRY_BASE_MS * 2);
      });
      expect(H.ownListings).toBe(3);
      expect(H.repaired).toEqual(['events/event-a/blockPairs/bob_dave']);
      // Once it lands, nothing further is scheduled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REPAIR_RETRY_BASE_MS * 64);
      });
      expect(H.ownListings).toBe(3);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the repair retry is bounded, never fires while the listener is on cache, and stops at unmount', async () => {
    vi.useFakeTimers();
    try {
      H.ownTargets = Object.assign(new Error('aborted'), { code: 'aborted' });
      const view = renderHook(() => useHiddenUidsSubscription('bob', true));
      act(() => H.subscriptions[0].listener(pairs([['alice', 'bob']])));
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REPAIR_RETRY_BASE_MS * 2 ** (REPAIR_RETRY_ATTEMPTS + 2));
      });
      expect(H.ownListings).toBe(1 + REPAIR_RETRY_ATTEMPTS);
      view.unmount();

      // A cache snapshot after the failure: the reconnection re-runs it, not the timer.
      H.ownListings = 0;
      const cached = renderHook(() => useHiddenUidsSubscription('bob', true));
      const sub = H.subscriptions[1];
      act(() => sub.listener(pairs([['alice', 'bob']])));
      await act(async () => {});
      act(() => sub.listener({ ...pairs([['alice', 'bob']]), metadata: { fromCache: true, hasPendingWrites: false } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REPAIR_RETRY_BASE_MS * 4);
      });
      expect(H.ownListings).toBe(1);
      cached.unmount();

      // Unmounted with a retry pending: it never fires.
      H.ownListings = 0;
      const gone = renderHook(() => useHiddenUidsSubscription('bob', true));
      act(() => H.subscriptions[2].listener(pairs([['alice', 'bob']])));
      await act(async () => {});
      gone.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REPAIR_RETRY_BASE_MS * 4);
      });
      expect(H.ownListings).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
    H.session = { ...H.session, uid: 'carol', generation: 1 };
    view.rerender({ uid: 'carol' });
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    expect(whereOf(H.subscriptions[1])).toEqual({ kind: 'where', args: ['uids', 'array-contains', 'carol'] });
    act(() => first.listener(pairs([['alice', 'bob']])));
    expect(view.result.current.hidden.size).toBe(0);
    H.session = { ...H.session, uid: null, generation: 2 };
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



  it('a newly queued offline block hides immediately only for an already confirmed viewer', async () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    act(() => H.subscriptions[0].listener(pairs([])));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    H.session = { ...H.session, db: null, generation: 1 }; view.rerender();
    let release!: () => void;
    H.blockCommits = [() => new Promise<void>((resolve) => { release = resolve; })];
    let commit!: Promise<void>;
    act(() => { commit = blockPlayer({ me: 'bob', target: 'alice' }); });
    expect(view.result.current).toEqual({ hidden: new Set(['alice']), ready: true });
    // Durable ACK alone cannot reveal the target before named-memory observes it.
    await act(async () => { release(); await commit; });
    expect(view.result.current.hidden.has('alice')).toBe(true);
    view.unmount();
    const cold = renderHook(() => useHiddenUidsSubscription('bob', true));
    expect(cold.result.current).toEqual({ hidden: new Set(), ready: false });
  });

  it('pending block intent never grants a cold online first answer and rejection removes only its overlay', async () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    let reject!: (error: Error) => void;
    H.blockCommits = [() => new Promise<void>((_, fail) => { reject = fail; })];
    let commit!: Promise<void>;
    act(() => { commit = blockPlayer({ me: 'bob', target: 'carol' }); });
    expect(view.result.current.ready).toBe(false);
    act(() => H.subscriptions[0].listener(pairs([['alice', 'bob']])));
    expect(view.result.current.hidden).toEqual(new Set(['alice', 'carol']));
    const denied = new Error('permission-denied');
    const result = expect(commit).rejects.toBe(denied);
    await act(async () => { reject(denied); await result; });
    expect(view.result.current).toEqual({ hidden: new Set(['alice']), ready: true });
  });

  it.each(['ack-first', 'snapshot-first'] as const)('block %s retains visibility until both memory observation and ACK', async (order) => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const sub = H.subscriptions[0]; act(() => sub.listener(pairs([])));
    let release!: () => void;
    H.blockCommits = [() => new Promise<void>((resolve) => { release = resolve; })];
    let commit!: Promise<void>;
    act(() => { commit = blockPlayer({ me: 'bob', target: 'alice' }); });
    if (order === 'ack-first') await act(async () => { release(); await commit; });
    expect(pendingBlockTargets('bob', H.eventId).has('alice')).toBe(true);
    act(() => sub.listener(pairs([['alice', 'bob']])));
    if (order === 'snapshot-first') {
      expect(pendingBlockTargets('bob', H.eventId).has('alice')).toBe(true);
      await act(async () => { release(); await commit; });
    }
    expect(pendingBlockTargets('bob', H.eventId).size).toBe(0);
    expect(view.result.current.hidden.has('alice')).toBe(true);
    act(() => sub.listener(pairs([])));
    expect(view.result.current.hidden.size).toBe(0);
  });

  it('account switches retire pending relay tokens and an old ACK cannot transfer intent back', async () => {
    const view = renderHook(({ uid }) => useHiddenUidsSubscription(uid, true), { initialProps: { uid: 'bob' } });
    act(() => H.subscriptions[0].listener(pairs([])));
    let release!: () => void;
    H.blockCommits = [() => new Promise<void>((resolve) => { release = resolve; })];
    let commit!: Promise<void>;
    act(() => { commit = blockPlayer({ me: 'bob', target: 'alice' }); });
    H.session = { ...H.session, uid: 'carol', generation: 1 }; view.rerender({ uid: 'carol' });
    expect(pendingBlockTargets('bob', H.eventId).size).toBe(0);
    await act(async () => { release(); await commit; });
    H.session = { ...H.session, uid: 'bob', generation: 2 }; view.rerender({ uid: 'bob' });
    act(() => H.subscriptions[2].listener(pairs([])));
    expect(view.result.current).toEqual({ hidden: new Set(), ready: true });
  });
  it('routes pair reads to memory and withholds a cold cache-only or denied answer', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const sub = H.subscriptions[0];
    expect((sub.target as { args: Array<{ database: unknown }> }).args[0].database).toBe(H.session.db);
    act(() => sub.listener({ ...pairs([]), metadata: { fromCache: true, hasPendingWrites: false } }));
    expect(view.result.current.ready).toBe(false);
    act(() => sub.onError(new Error('permission-denied')));
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
  });

  it('cold offline starts and reloads never infer an empty confirmed set', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    H.session = { ...H.session, db: null, generation: 1 };
    const first = renderHook(() => useHiddenUidsSubscription('bob', true));
    expect(first.result.current).toEqual({ hidden: new Set(), ready: false });
    first.unmount();
    const reload = renderHook(() => useHiddenUidsSubscription('bob', true));
    expect(reload.result.current.ready).toBe(false);
    expect(H.subscriptions).toHaveLength(0);
  });

  it('mid-use offline keeps only its confirmed scope and reconnect denial cannot reveal it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const old = H.subscriptions[0];
    act(() => old.listener(pairs([['alice', 'bob']])));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    H.session = { ...H.session, db: null, generation: 1, transition: 'connection' };
    view.rerender();
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(view.result.current).toEqual({ hidden: new Set(['alice']), ready: true });
    act(() => old.listener(pairs([])));
    expect([...view.result.current.hidden]).toEqual(['alice']);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    H.session = { ...H.session, db: { memory: true }, generation: 2, transition: 'connection' };
    view.rerender();
    const fresh = H.subscriptions[1];
    act(() => fresh.listener({ ...pairs([]), metadata: { fromCache: true, hasPendingWrites: false } }));
    act(() => fresh.onError(new Error('permission-denied')));
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    act(() => fresh.listener(pairs([])));
    expect(view.result.current).toEqual({ hidden: new Set(), ready: true });
  });

  it('an online token rotation withholds before the replacement server answer, including its cache and pending answers', () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const old = H.subscriptions[0];
    act(() => old.listener(pairs([['alice', 'bob']])));
    H.session = { ...H.session, db: null, generation: 1, transition: 'auth' };
    view.rerender();
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    H.session = { ...H.session, db: { memory: true } };
    view.rerender();
    const fresh = H.subscriptions[1];
    act(() => old.listener(pairs([])));
    expect(view.result.current.ready).toBe(false);
    act(() => fresh.listener({ ...pairs([]), metadata: { fromCache: true, hasPendingWrites: false } }));
    expect(view.result.current.ready).toBe(false);
    act(() => fresh.listener(pairs([], true)));
    expect(view.result.current.ready).toBe(false);
    act(() => fresh.listener(pairs([])));
    expect(view.result.current).toEqual({ hidden: new Set(), ready: true });
  });

  it('an Auth rotation during reconnect cannot reuse a previous connection carry', () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    act(() => H.subscriptions[0].listener(pairs([['alice', 'bob']])));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    H.session = { ...H.session, db: null, generation: 1, transition: 'connection' };
    view.rerender();
    expect(view.result.current.ready).toBe(true);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    H.session = { ...H.session, db: { memory: true }, generation: 2, transition: 'connection' };
    view.rerender();
    expect(view.result.current).toEqual({ hidden: new Set(['alice']), ready: true });
    H.session = { ...H.session, db: { memory: true }, generation: 3, transition: 'auth' };
    view.rerender();
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
  });

  it.each(['account', 'Event'] as const)('offline %s changes retire the confirmed visibility witness', (scope) => {
    const view = renderHook(({ uid }) => useHiddenUidsSubscription(uid, true), { initialProps: { uid: 'bob' } });
    act(() => H.subscriptions[0].listener(pairs([['alice', 'bob']])));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    H.session = { ...H.session, db: null, generation: 1, uid: scope === 'account' ? 'carol' : 'bob' };
    if (scope === 'Event') H.eventId = 'event-b';
    view.rerender({ uid: H.session.uid! });
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
  });

  it('legacy recovery withholds private visibility despite a previously confirmed answer', () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    act(() => H.subscriptions[0].listener(pairs([['alice', 'bob']])));
    H.session = { ...H.session, recoveryRequired: true, generation: 1 };
    view.rerender();
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    expect(H.subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
  });
  it('a listener denial retires readiness and cannot carry into an offline session', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    const sub = H.subscriptions[0];
    act(() => sub.listener(pairs([['alice', 'bob']])));
    act(() => sub.onError(new Error('permission-denied')));
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    H.session = { ...H.session, db: null, generation: 1 };
    view.rerender();
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
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
  const direction = (targetUid: string, createdAt = 1) => ({ ownerUid: 'bob', targetUid, eventId: 'event-a', createdAt });
  const own = (
    rows: Array<{ row: ReturnType<typeof direction>; pending?: boolean }>,
    fromCache = false,
  ) => ({
    docs: rows.map(({ row, pending = false }) => ({ data: () => row, metadata: { fromCache, hasPendingWrites: pending } })),
    metadata: { fromCache, hasPendingWrites: rows.some((r) => r.pending) },
  });

  it('lists the viewer’s own direction records by ownerUid equality, with metadata changes', () => {
    const view = renderHook(() => useMyBlocks('bob'));
    expect(view.result.current).toEqual({ data: [], loading: true, error: false, confirmed: false, pendingTargets: new Set() });
    const sub = H.subscriptions[0];
    expect(pathOf(sub)).toBe('events/event-a/blocks');
    expect(whereOf(sub)).toEqual({ kind: 'where', args: ['ownerUid', '==', 'bob'] });
    expect(sub.options).toEqual({ includeMetadataChanges: true });
    const row = direction('alice');
    act(() => sub.listener(own([{ row }])));
    expect(view.result.current).toEqual({ data: [row], loading: false, error: false, confirmed: true, pendingTargets: new Set() });
  });



  it('own panel relays pending target identity without synthesizing direction records', async () => {
    const view = renderHook(() => useMyBlocks('bob'));
    act(() => H.subscriptions[0].listener(own([{ row: direction('alice') }])));
    let reject!: (error: Error) => void;
    H.blockCommits = [() => new Promise<void>((_, fail) => { reject = fail; })];
    let commit!: Promise<void>;
    act(() => { commit = blockPlayer({ me: 'bob', target: 'carol' }); });
    expect(view.result.current.data.map((row) => row.targetUid)).toEqual(['alice']);
    expect(view.result.current.pendingTargets.has('carol')).toBe(true);
    const rejected = expect(commit).rejects.toThrow('denied');
    await act(async () => { reject(new Error('denied')); await rejected; });
    expect(view.result.current.pendingTargets.size).toBe(0);
    expect(view.result.current.data.map((row) => row.targetUid)).toEqual(['alice']);
  });
  it('own directions are memory-only and disappear on retirement/recovery', () => {
    const view = renderHook(() => useMyBlocks('bob'));
    const sub = H.subscriptions[0];
    expect((sub.target as { args: Array<{ database: unknown }> }).args[0].database).toBe(H.session.db);
    act(() => sub.listener(own([{ row: direction('alice') }])));
    H.session = { ...H.session, recoveryRequired: true, generation: 1 };
    view.rerender();
    expect(view.result.current.data).toEqual([]);
    expect(view.result.current.confirmed).toBe(false);
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    act(() => sub.listener(own([{ row: direction('alice') }])));
    expect(view.result.current.data).toEqual([]);
  });
  it('an empty cache-only snapshot is not confirmed; the first server snapshot latches it', () => {
    const view = renderHook(() => useMyBlocks('bob'));
    const sub = H.subscriptions[0];
    act(() => sub.listener(own([], true)));
    expect(view.result.current).toMatchObject({ data: [], loading: false, confirmed: false });
    act(() => sub.listener(own([], false)));
    expect(view.result.current.confirmed).toBe(true);
    // A later memory-cache answer within this admitted listener retains its confirmation.
    act(() => sub.listener(own([], true)));
    expect(view.result.current.confirmed).toBe(true);
  });

  it('names the rows that are still an uncommitted local block, until the server commits them', () => {
    const view = renderHook(() => useMyBlocks('bob'));
    const sub = H.subscriptions[0];
    act(() => sub.listener(own([{ row: direction('alice', 2), pending: true }, { row: direction('cara') }])));
    expect(view.result.current.pendingTargets).toEqual(new Set(['alice']));
    act(() => sub.listener(own([{ row: direction('alice', 2) }, { row: direction('cara') }])));
    expect(view.result.current.pendingTargets).toEqual(new Set());
  });

  it('signed out: settled and empty with no listener; an error settles empty and flagged', () => {
    expect(renderHook(() => useMyBlocks(null)).result.current).toEqual({
      data: [],
      loading: false,
      error: false,
      confirmed: true,
      pendingTargets: new Set(),
    });
    expect(H.subscriptions).toHaveLength(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = renderHook(() => useMyBlocks('bob'));
    act(() => H.subscriptions[0].onError(new Error('denied')));
    expect(view.result.current).toEqual({ data: [], loading: false, error: true, confirmed: false, pendingTargets: new Set() });
  });
});
