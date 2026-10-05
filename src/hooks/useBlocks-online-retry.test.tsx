import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1723: actual reciprocal hook and block-set derivations, controlled private
// session + SDK drain/listener transport. This covers online authority, not a
// new offline policy or private manager lifecycle implementation.
type PairSnapshot = { docs: Array<{ data: () => { uids: string[]; eventId: string } }>; metadata: { fromCache: boolean; hasPendingWrites: boolean } };
type Subscription = { query: { args: Array<{ database?: unknown; path?: string; args?: unknown[] }> }; next: (snap: PairSnapshot) => void; fail: (error: Error) => void; stop: ReturnType<typeof vi.fn> };
const H = vi.hoisted(() => ({
  gameplay: { persistent: true }, memory: { memory: true },
  session: { uid: 'bob', db: null as object | null, generation: 7, authGeneration: 3, transition: 'auth' as const, recoveryRequired: false, failed: false },
  waitPending: vi.fn(), retryBridge: vi.fn(), subscriptions: [] as Subscription[],
}));
vi.mock('../firebase', () => ({ db: H.gameplay, EVENT_ID: 'event-a', auth: { currentUser: { uid: 'bob' } } }));
vi.mock('./usePrivateFirestore', () => ({ usePrivateFirestore: () => H.session }));
vi.mock('../privateFirestore', () => ({
  retryPrivateFirestoreSession: H.retryBridge,
  capturePrivateFirestore: () => {
    const { uid, db, generation } = H.session;
    return { uid, db, assertCurrent: () => { if (!db || db !== H.session.db || generation !== H.session.generation || uid !== H.session.uid) throw new Error('Retired actor.'); } };
  },
}));
vi.mock('../data/blocks', async importOriginal => ({
  ...await importOriginal<typeof import('../data/blocks')>(),
  // Pair maintenance is outside this read-admission regression; keep the real
  // hidden-set transforms and pending-target relay, without unrelated SDK writes.
  reconcileOrphanPair: vi.fn(async () => {}), repairMissingPairs: vi.fn(async () => {}),
}));
vi.mock('firebase/firestore', () => ({
  collection: (database: unknown, ...segments: string[]) => ({ database, path: segments.join('/'), withConverter() { return this; } }),
  query: (...args: unknown[]) => ({ args }), where: (...args: unknown[]) => ({ args }),
  waitForPendingWrites: H.waitPending,
  onSnapshot: (query: Subscription['query'], _options: unknown, next: Subscription['next'], fail: Subscription['fail']) => {
    const stop = vi.fn(); H.subscriptions.push({ query, next, fail, stop }); return stop;
  },
}));
import { useHiddenUidsSubscription, resetReconcileAttemptsForTests } from './useBlocks';
const answer = (uids: string[][], fromCache = false, hasPendingWrites = false): PairSnapshot => ({
  docs: uids.map(row => ({ data: () => ({ uids: row, eventId: 'event-a' }) })), metadata: { fromCache, hasPendingWrites },
});
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); H.session = { ...H.session, db: H.memory };
  H.subscriptions = []; H.waitPending.mockReset().mockResolvedValue(undefined); resetReconcileAttemptsForTests();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('confirmed block witness during healthy online Retry', () => {
  it.each(['cache', 'pending'] as const)('withholds through a held drain and a fresh %s answer despite the carried set', async kind => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true));
    await act(async () => {});
    const old = H.subscriptions[0]; act(() => old.next(answer([['alice', 'bob']])));
    expect(view.result.current).toMatchObject({ hidden: new Set(['alice']), ready: true });
    act(() => old.fail(Object.assign(new Error('Unavailable'), { code: 'unavailable' })));
    expect(view.result.current).toMatchObject({ ready: false, failed: true }); expect(old.stop).toHaveBeenCalledOnce();

    let release!: () => void; H.waitPending.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
    act(() => view.result.current.retry!());
    expect(H.waitPending).toHaveBeenCalledTimes(2); expect(H.waitPending).toHaveBeenLastCalledWith(H.gameplay);
    expect(H.subscriptions).toHaveLength(1); expect(H.retryBridge).not.toHaveBeenCalled();
    expect(H.session.db).toBe(H.memory); expect(H.session.generation).toBe(7);
    expect(view.result.current).toMatchObject({ hidden: new Set(['alice']), ready: false });
    act(() => old.next(answer([]))); expect(view.result.current.ready).toBe(false);
    // The original automatic backoff is cancelled; it cannot race the held retry.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(H.waitPending).toHaveBeenCalledTimes(2); expect(H.subscriptions).toHaveLength(1);

    await act(async () => { release(); }); const fresh = H.subscriptions[1];
    expect(fresh.query.args[0]).toMatchObject({ database: H.memory, path: 'events/event-a/blockPairs' });
    expect(fresh.query.args[1].args).toEqual(['uids', 'array-contains', 'bob']);
    expect(view.result.current).toMatchObject({ hidden: new Set(['alice']), ready: false });
    act(() => fresh.next(answer([], kind === 'cache', kind === 'pending')));
    // An empty unconfirmed answer cannot spend the carried offline witness to
    // render online content; lastCommitted still keeps Alice in the hidden set.
    expect(view.result.current).toMatchObject({ hidden: new Set(['alice']), ready: false });
    act(() => fresh.next(answer([])));
    expect(view.result.current).toEqual({ hidden: new Set(), ready: true });
    view.unmount(); expect(fresh.stop).toHaveBeenCalledOnce();
  });
});
