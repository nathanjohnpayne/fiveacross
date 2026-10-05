import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1725 defensive injected-subscription seam. Installed Firestore AsyncObserver
// dispatches callbacks asynchronously; synchronous controls do NOT reproduce a
// current production SDK leak. Keep this fixture separate from other hot lanes.
type PairSnapshot = { docs: Array<{ data: () => { uids: string[]; eventId: string } }>; metadata: { fromCache: boolean; hasPendingWrites: boolean } };
type Subscription = { next: (snapshot: PairSnapshot) => void; error: (error: Error) => void; unsubscribe: ReturnType<typeof vi.fn> };
const H = vi.hoisted(() => ({
  session: { uid: 'bob', db: { memory: true }, generation: 2, authGeneration: 1, transition: 'auth' as const, recoveryRequired: false, failed: false },
  mode: 'async' as 'async' | 'sync-denied' | 'sync-transient' | 'sync-committed', subscriptions: [] as Subscription[],
  waitPending: vi.fn(), retryBridge: vi.fn(),
}));
vi.mock('../firebase', () => ({ db: { persistent: true }, EVENT_ID: 'event-a', auth: { currentUser: { uid: 'bob' } } }));
vi.mock('./usePrivateFirestore', () => ({ usePrivateFirestore: () => H.session }));
vi.mock('../privateFirestore', () => ({
  retryPrivateFirestoreSession: H.retryBridge,
  capturePrivateFirestore: () => { const { uid, db, generation } = H.session; return { uid, db, assertCurrent: () => { if (db !== H.session.db || generation !== H.session.generation) throw new Error('Retired actor.'); } }; },
}));
vi.mock('../data/blocks', async original => ({
  ...await original<typeof import('../data/blocks')>(),
  reconcileOrphanPair: vi.fn(async () => {}), repairMissingPairs: vi.fn(async () => {}),
}));
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, ...parts: string[]) => ({ path: parts.join('/'), withConverter() { return this; } }),
  query: (...args: unknown[]) => ({ args }), where: (...args: unknown[]) => ({ args }), waitForPendingWrites: H.waitPending,
  onSnapshot: (_query: unknown, _options: unknown, next: Subscription['next'], error: Subscription['error']) => {
    const unsubscribe = vi.fn(); H.subscriptions.push({ next, error, unsubscribe });
    const mode = H.mode; H.mode = 'async';
    if (mode === 'sync-denied') error(Object.assign(new Error('Denied'), { code: 'permission-denied' }));
    if (mode === 'sync-transient') error(Object.assign(new Error('Unavailable'), { code: 'unavailable' }));
    if (mode === 'sync-committed') next({ docs: [{ data: () => ({ uids: ['alice', 'bob'], eventId: 'event-a' }) }], metadata: { fromCache: false, hasPendingWrites: false } });
    return unsubscribe;
  },
}));
import { useHiddenUidsSubscription, resetReconcileAttemptsForTests } from './useBlocks';
const committed: PairSnapshot = { docs: [{ data: () => ({ uids: ['alice', 'bob'], eventId: 'event-a' }) }], metadata: { fromCache: false, hasPendingWrites: false } };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); H.subscriptions = []; H.mode = 'async';
  H.waitPending.mockReset().mockResolvedValue(undefined); resetReconcileAttemptsForTests();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('synchronous subscription-return cleanup', () => {
  it.each(['sync-denied', 'sync-transient'] as const)('detaches a handle returned after injected %s retirement', async mode => {
    H.mode = mode; const view = renderHook(() => useHiddenUidsSubscription('bob', true)); await act(async () => {});
    const old = H.subscriptions[0];
    expect(view.result.current).toMatchObject({ ready: false, failed: true }); expect(old.unsubscribe).toHaveBeenCalledOnce();
    act(() => old.next(committed)); expect(view.result.current.ready).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    if (mode === 'sync-denied') { expect(H.subscriptions).toHaveLength(1); expect(H.waitPending).toHaveBeenCalledOnce(); }
    else {
      expect(H.subscriptions).toHaveLength(2); expect(H.waitPending).toHaveBeenCalledTimes(2);
      act(() => H.subscriptions[1].next(committed)); expect(view.result.current.ready).toBe(true);
    }
    expect(H.retryBridge).not.toHaveBeenCalled(); view.unmount(); expect(old.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not detach a valid injected synchronous answer before later normal cleanup', async () => {
    H.mode = 'sync-committed'; const view = renderHook(() => useHiddenUidsSubscription('bob', true)); await act(async () => {});
    expect(view.result.current).toEqual({ hidden: new Set(['alice']), ready: true });
    expect(H.subscriptions[0].unsubscribe).not.toHaveBeenCalled();
    view.unmount(); expect(H.subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
  });

  it('preserves normal asynchronous failure cleanup and stale-callback refusal', async () => {
    const view = renderHook(() => useHiddenUidsSubscription('bob', true)); await act(async () => {});
    const old = H.subscriptions[0]; act(() => old.next(committed)); expect(view.result.current.ready).toBe(true);
    act(() => old.error(Object.assign(new Error('Denied'), { code: 'permission-denied' })));
    expect(old.unsubscribe).toHaveBeenCalledOnce(); expect(view.result.current).toMatchObject({ ready: false, failed: true });
    act(() => old.next(committed)); expect(view.result.current.ready).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); expect(H.subscriptions).toHaveLength(1);
    view.unmount();
  });
});
