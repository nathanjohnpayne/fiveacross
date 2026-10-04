import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const H = vi.hoisted(() => ({
  session: { uid: 'alice' as string | null, db: { name: 'private-memory' } as object | null, generation: 1, recoveryRequired: false, failed: false },
  legacyDb: { name: 'legacy-persistent' },
  subscriptions: [] as { target: unknown; next: (snap: unknown) => void; error: () => void; stop: ReturnType<typeof vi.fn> }[],
}));
vi.mock('./usePrivateFirestore', () => ({ usePrivateFirestore: () => H.session }));
vi.mock('../firebase', () => ({ db: H.legacyDb, EVENT_ID: 'event', auth: {}, storage: {}, analytics: null }));
vi.mock('firebase/firestore', () => {
  const ref = (...args: unknown[]) => ({ args, withConverter() { return this; } });
  return { doc: ref, collection: ref, query: (...args: unknown[]) => ({ args }), where: (...args: unknown[]) => ({ args }),
    onSnapshot: (target: unknown, _metadata: unknown, next: (snap: unknown) => void, error: () => void) => {
      const stop = vi.fn(); H.subscriptions.push({ target, next, error, stop }); return stop;
    } };
});
import { useMyUser, usePendingClaims, usePendingItemCount } from './useData';
const snapshot = (fromCache = false) => ({ docs: [{ data: () => ({ uid: 'alice', status: 'pending', createdAt: 1 }) }], metadata: { fromCache, hasPendingWrites: false } });
beforeEach(() => {
  H.session = { uid: 'alice', db: { name: 'private-memory' }, generation: 1, recoveryRequired: false, failed: false };
  H.subscriptions = [];
});
describe('private hook cache and actor boundaries (#1411)', () => {
  it('binds an Admin queue to the private DB and never publishes a cache-only answer', () => {
    const view = renderHook(() => usePendingClaims());
    expect(JSON.stringify(H.subscriptions[0].target)).toContain('private-memory');
    expect(JSON.stringify(H.subscriptions[0].target)).not.toContain('legacy-persistent');
    act(() => H.subscriptions[0].next(snapshot(true)));
    expect(view.result.current.claims).toEqual([]);
    expect(view.result.current.hasServerData).toBe(false);
    act(() => H.subscriptions[0].next(snapshot()));
    expect(view.result.current.claims).toHaveLength(1);
    expect(view.result.current.hasServerData).toBe(true);
  });
  it('drops private rows immediately on an account/incarnation switch and ignores a late old callback', () => {
    const view = renderHook(() => usePendingClaims());
    const old = H.subscriptions[0];
    act(() => old.next(snapshot()));
    H.session = { ...H.session, uid: 'bob', generation: 2, db: { name: 'bob-memory' } }; view.rerender();
    expect(view.result.current.claims).toEqual([]);
    expect(old.stop).toHaveBeenCalledOnce();
    act(() => old.next(snapshot()));
    expect(view.result.current.claims).toEqual([]);
  });
  it('clears previously served private rows when the listener is denied', () => {
    const view = renderHook(() => usePendingClaims());
    act(() => H.subscriptions[0].next(snapshot()));
    act(() => H.subscriptions[0].error());
    expect(view.result.current.claims).toEqual([]);
    expect(view.result.current.hasServerData).toBe(false);
  });
  it('opens no private listener during attended recovery', () => {
    H.session.recoveryRequired = true;
    const view = renderHook(() => usePendingClaims());
    expect(H.subscriptions).toHaveLength(0);
    expect(view.result.current.claims).toEqual([]);
  });
  it('retires the separate More badge listener on an offline transition', () => {
    const view = renderHook(() => usePendingItemCount());
    act(() => H.subscriptions[0].next(snapshot())); expect(view.result.current.count).toBe(1);
    H.session = { ...H.session, db: null, generation: 2 }; view.rerender();
    expect(view.result.current.count).toBe(0);
    expect(H.subscriptions[0].stop).toHaveBeenCalledOnce();
  });
  it('never requests another account’s private profile through the new session', () => {
    H.session.uid = 'bob';
    const view = renderHook(() => useMyUser('alice'));
    expect(H.subscriptions).toHaveLength(0);
    expect(view.result.current.data).toBeNull();
  });
});
