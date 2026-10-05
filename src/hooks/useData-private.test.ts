import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const H = vi.hoisted(() => ({
  session: { uid: 'alice' as string | null, db: { name: 'private-memory' } as object | null, generation: 1, recoveryRequired: false, failed: false },
  legacyDb: { name: 'legacy-persistent' },
  pendingWrites: vi.fn<() => Promise<void>>(),
  serverRead: vi.fn<() => Promise<ReturnType<typeof snapshot>>>(),
  eventId: 'event',
  subscriptions: [] as { target: unknown; next: (snap: unknown) => void; error: () => void; stop: ReturnType<typeof vi.fn> }[],
}));
vi.mock('./usePrivateFirestore', () => ({ usePrivateFirestore: () => H.session }));
vi.mock('../firebase', () => ({ db: H.legacyDb, get EVENT_ID() { return H.eventId; }, auth: {}, storage: {}, analytics: null }));
vi.mock('firebase/firestore', () => {
  const ref = (...args: unknown[]) => ({ args, firestore: args[0], withConverter() { return this; } });
  return { doc: ref, collection: ref, query: (...args: unknown[]) => ({ args, firestore: H.session.db }),
    waitForPendingWrites: (database: unknown) => { expect(database).toBe(H.session.db); return H.pendingWrites(); },
    getDocsFromServer: () => H.serverRead(), where: (...args: unknown[]) => ({ args }),
    onSnapshot: (target: unknown, _metadata: unknown, next: (snap: unknown) => void, error: () => void) => {
      const stop = vi.fn(); H.subscriptions.push({ target, next, error, stop }); return stop;
    } };
});
import { useAdminEventDoc, useMyUser, usePendingClaims, usePendingItems, useAllItems, useReportedProofs, usePendingItemCount, useMyClaims, useMyPendingItems } from './useData';
const snapshot = (fromCache = false) => ({ docs: [{ id: 'row-alice', data: () => ({ uid: 'alice', status: 'pending', createdAt: 1, reportCount: 1 }) }], metadata: { fromCache, hasPendingWrites: false } });
const docSnapshot = (data: object | null, fromCache = false, hasPendingWrites = false) => ({
  exists: () => data !== null, data: () => data, metadata: { fromCache, hasPendingWrites },
});
const rowsSnapshot = (ids: string[]) => ({ ...snapshot(), docs: ids.map((id) => ({
  id, data: () => ({ uid: id, text: id, status: 'pending', createdAt: 1, reportCount: 1 }),
})) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.useRealTimers(); });
beforeEach(() => {
  H.session = { uid: 'alice', db: { name: 'private-memory' }, generation: 1, recoveryRequired: false, failed: false };
  H.subscriptions = [];
  H.eventId = 'event';
  H.pendingWrites.mockReset().mockResolvedValue(undefined);
  H.serverRead.mockReset().mockImplementation(async () => snapshot());
});
describe('private hook cache and actor boundaries (#1411)', () => {
  it('coalesces a removal burst during drain into one latest-candidate rerun', async () => {
    const view = renderHook(() => useAllItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(rowsSnapshot(['a', 'b', 'c'])));
    const drain = deferred<void>();
    H.pendingWrites.mockReturnValueOnce(drain.promise);
    H.serverRead.mockResolvedValueOnce(rowsSnapshot([]));
    await act(async () => {
      listener.next(rowsSnapshot(['b', 'c']));
      for (let i = 0; i < 20; i += 1) listener.next(rowsSnapshot(['c']));
      listener.next(rowsSnapshot([]));
    });
    expect(H.pendingWrites).toHaveBeenCalledTimes(1);
    expect(H.serverRead).not.toHaveBeenCalled();
    expect(view.result.current.items.map((row) => row.text)).toEqual(['a', 'b', 'c']);
    await act(async () => drain.resolve());
    expect(H.pendingWrites).toHaveBeenCalledTimes(2);
    expect(H.serverRead).toHaveBeenCalledTimes(1);
    expect(view.result.current.items).toEqual([]);
    await act(async () => listener.next(rowsSnapshot([])));
    expect(H.pendingWrites).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst during a server read and never publishes its superseded answer', async () => {
    const view = renderHook(() => usePendingItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(rowsSnapshot(['a', 'b', 'c'])));
    const first = deferred<ReturnType<typeof snapshot>>();
    const latest = deferred<ReturnType<typeof snapshot>>();
    H.serverRead.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    await act(async () => listener.next(rowsSnapshot(['b', 'c'])));
    await act(async () => {
      for (let i = 0; i < 20; i += 1) listener.next(rowsSnapshot(['c']));
    });
    expect(H.serverRead).toHaveBeenCalledTimes(1);
    expect(H.pendingWrites).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(rowsSnapshot(['b', 'c'])));
    expect(view.result.current.items.map((row) => row.text)).toEqual(['a', 'b', 'c']);
    expect(H.pendingWrites).toHaveBeenCalledTimes(2);
    expect(H.serverRead).toHaveBeenCalledTimes(2);
    await act(async () => latest.resolve(rowsSnapshot(['c'])));
    expect(view.result.current.items.map((row) => row.text)).toEqual(['c']);
  });

  it('keeps a later removal queued after a direct non-removal answer supersedes an active read', async () => {
    const view = renderHook(() => usePendingItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(rowsSnapshot(['a'])));
    const first = deferred<ReturnType<typeof snapshot>>();
    H.serverRead.mockReturnValueOnce(first.promise).mockResolvedValueOnce(rowsSnapshot(['b']));
    await act(async () => listener.next(rowsSnapshot([])));
    await act(async () => listener.next(rowsSnapshot(['a', 'b'])));
    expect(view.result.current.items.map((row) => row.text)).toEqual(['a', 'b']);
    await act(async () => listener.next(rowsSnapshot(['b'])));
    await act(async () => first.resolve(rowsSnapshot([])));
    expect(H.pendingWrites).toHaveBeenCalledTimes(2);
    expect(H.serverRead).toHaveBeenCalledTimes(2);
    expect(view.result.current.items.map((row) => row.text)).toEqual(['b']);
  });

  it('a newer pending callback discards the queued removal as well as the active answer', async () => {
    const view = renderHook(() => usePendingItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    const first = deferred<ReturnType<typeof snapshot>>();
    H.serverRead.mockReturnValueOnce(first.promise);
    await act(async () => listener.next(rowsSnapshot([])));
    await act(async () => listener.next(rowsSnapshot([])));
    await act(async () => listener.next({ ...rowsSnapshot([]), metadata: { fromCache: false, hasPendingWrites: true } }));
    await act(async () => first.resolve(rowsSnapshot([])));
    expect(H.pendingWrites).toHaveBeenCalledTimes(1);
    expect(H.serverRead).toHaveBeenCalledTimes(1);
    expect(view.result.current.items).toHaveLength(1);
  });

  it('ignores an older denied read after a newer callback and confirms the queued candidate afresh', async () => {
    const view = renderHook(() => usePendingItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    const first = deferred<ReturnType<typeof snapshot>>();
    const latest = deferred<ReturnType<typeof snapshot>>();
    H.serverRead.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    await act(async () => listener.next(rowsSnapshot([])));
    await act(async () => listener.next(rowsSnapshot([])));
    await act(async () => first.reject(Object.assign(new Error('stale denial'), { code: 'permission-denied' })));
    expect(view.result.current.items).toHaveLength(1);
    expect(view.result.current.failed).toBe(false);
    expect(H.serverRead).toHaveBeenCalledTimes(2);
    await act(async () => latest.resolve(snapshot()));
    expect(view.result.current.items).toHaveLength(1);
  });

  it.each([-60_000, 60_000])('keeps elapsed cooldown unchanged when the wall clock moves by %i ms', async (wallClockChange) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const view = renderHook(() => usePendingItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    H.pendingWrites.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
    await act(async () => listener.next(rowsSnapshot([])));
    expect(H.pendingWrites).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + wallClockChange);
    H.serverRead.mockResolvedValueOnce(rowsSnapshot([]));
    await act(async () => listener.next(rowsSnapshot([])));
    expect(H.pendingWrites).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(H.pendingWrites).toHaveBeenCalledTimes(1);
    expect(view.result.current.items).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(H.pendingWrites).toHaveBeenCalledTimes(2);
    expect(H.serverRead).toHaveBeenCalledTimes(1);
    expect(view.result.current.items).toEqual([]);
  });

  it('caps snapshot-triggered transient backoff and never automatically retries a failed candidate', async () => {
    vi.useFakeTimers();
    const view = renderHook(() => usePendingItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    H.pendingWrites.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
    await act(async () => listener.next(rowsSnapshot([])));
    for (const [index, delay] of [250, 500, 1000, 2000, 2000].entries()) {
      await act(async () => listener.next(rowsSnapshot([])));
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
      expect(H.pendingWrites).toHaveBeenCalledTimes(index + 1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(H.pendingWrites).toHaveBeenCalledTimes(index + 2);
      expect(view.result.current.items).toHaveLength(1);
    }
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(H.pendingWrites).toHaveBeenCalledTimes(6);
    expect(H.serverRead).not.toHaveBeenCalled();
    H.pendingWrites.mockResolvedValue(undefined);
    H.serverRead.mockResolvedValueOnce(rowsSnapshot([]));
    await act(async () => listener.next(rowsSnapshot([])));
    expect(view.result.current.items).toEqual([]);
    // A successful barrier resets the cooldown for subsequent removal work.
    await act(async () => listener.next(snapshot()));
    H.serverRead.mockResolvedValueOnce(rowsSnapshot([]));
    await act(async () => listener.next(rowsSnapshot([])));
    expect(H.pendingWrites).toHaveBeenCalledTimes(8);
    expect(view.result.current.items).toEqual([]);
  });

  it('backs off a superseded transient read and retains only the latest candidate during cooldown', async () => {
    vi.useFakeTimers();
    const view = renderHook(() => useAllItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(rowsSnapshot(['a', 'b', 'c'])));
    const first = deferred<ReturnType<typeof snapshot>>();
    H.serverRead.mockReturnValueOnce(first.promise).mockResolvedValueOnce(rowsSnapshot(['c']));
    await act(async () => listener.next(rowsSnapshot(['b', 'c'])));
    await act(async () => listener.next(rowsSnapshot([])));
    await act(async () => first.reject(Object.assign(new Error('lost connection'), { code: 'unavailable' })));
    await act(async () => listener.next(rowsSnapshot(['c'])));
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(H.pendingWrites).toHaveBeenCalledTimes(1);
    expect(view.result.current.items).toHaveLength(3);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(H.pendingWrites).toHaveBeenCalledTimes(2);
    expect(H.serverRead).toHaveBeenCalledTimes(2);
    expect(view.result.current.items.map((row) => row.text)).toEqual(['c']);
  });

  it('scopes an in-flight barrier and transient cooldown to its own private subscription', async () => {
    vi.useFakeTimers();
    const view = renderHook(() => ({ items: usePendingItems(), claims: usePendingClaims() }));
    const [items, claims] = H.subscriptions;
    await act(async () => { items.next(snapshot()); claims.next(snapshot()); });
    H.pendingWrites.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
    await act(async () => items.next(rowsSnapshot([])));
    await act(async () => items.next(rowsSnapshot([])));
    H.serverRead.mockResolvedValueOnce(rowsSnapshot([]));
    await act(async () => claims.next(rowsSnapshot([])));
    expect(H.pendingWrites).toHaveBeenCalledTimes(2);
    expect(view.result.current.items.items).toHaveLength(1);
    expect(view.result.current.claims.claims).toEqual([]);
    H.serverRead.mockResolvedValueOnce(rowsSnapshot([]));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(H.pendingWrites).toHaveBeenCalledTimes(3);
    expect(view.result.current.items.items).toEqual([]);
  });

  it.each(['pending', 'settled rows', 'cache', 'denial', 'scope', 'unmount'] as const)(
    'discards a cooldown candidate on %s without a delayed private operation', async (retirement) => {
      vi.useFakeTimers();
      const view = renderHook(() => usePendingItems());
      const listener = H.subscriptions[0];
      await act(async () => listener.next(snapshot()));
      H.pendingWrites.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      await act(async () => listener.next(rowsSnapshot([])));
      await act(async () => listener.next(rowsSnapshot([])));
      if (retirement === 'pending') await act(async () => listener.next({ ...snapshot(), metadata: { fromCache: false, hasPendingWrites: true } }));
      if (retirement === 'settled rows') await act(async () => listener.next(snapshot()));
      if (retirement === 'cache') await act(async () => listener.next(snapshot(true)));
      if (retirement === 'denial') await act(async () => listener.error());
      if (retirement === 'scope') { H.session = { ...H.session, generation: 2 }; view.rerender(); }
      if (retirement === 'unmount') view.unmount();
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(H.pendingWrites).toHaveBeenCalledTimes(1);
      expect(H.serverRead).not.toHaveBeenCalled();
      if (retirement === 'pending' || retirement === 'settled rows') expect(view.result.current.items).toHaveLength(1);
      else if (retirement !== 'unmount') expect(view.result.current.items).toEqual([]);
    },
  );

  it.each(['first empty', 'first rows', 'addition', 'modification', 'metadata only'] as const)(
    'narrow barrier: publishes %s without a drain or extra server read', async (kind) => {
      const view = renderHook(() => usePendingItems());
      const listener = H.subscriptions[0];
      if (!kind.startsWith('first')) await act(async () => listener.next(snapshot()));
      const docs = kind === 'first empty' ? [] : snapshot().docs;
      if (kind === 'addition') docs.push({ id: 'row-bob', data: () => ({ uid: 'bob', status: 'pending', createdAt: 2, reportCount: 1 }) });
      if (kind === 'modification') docs[0] = { id: 'row-alice', data: () => ({ uid: 'alice', status: 'pending', createdAt: 3, reportCount: 2 }) };
      await act(async () => listener.next({ docs, metadata: { fromCache: false, hasPendingWrites: false } }));
      expect(view.result.current.items).toHaveLength(docs.length);
      expect(view.result.current.hasServerData).toBe(true);
      expect(H.pendingWrites).not.toHaveBeenCalled();
      expect(H.serverRead).not.toHaveBeenCalled();
    },
  );

  it.each(['drain', 'server read'] as const)(
    'narrow barrier: a non-denial %s failure preserves committed rows and later retries', async (phase) => {
      vi.useFakeTimers();
      const view = renderHook(() => usePendingItems());
      const listener = H.subscriptions[0];
      await act(async () => listener.next(snapshot()));
      const committed = view.result.current.items;
      const error = Object.assign(new Error('connection lost'), { code: 'unavailable' });
      if (phase === 'drain') H.pendingWrites.mockRejectedValueOnce(error);
      else H.serverRead.mockRejectedValueOnce(error);
      const removal = { docs: [], metadata: { fromCache: false, hasPendingWrites: false } };
      await act(async () => listener.next(removal));
      expect(view.result.current.items).toEqual(committed);
      expect(view.result.current.hasServerData).toBe(true);
      expect(view.result.current.failed).toBe(false);
      H.serverRead.mockResolvedValueOnce(removal);
      await act(async () => listener.next(removal));
      expect(view.result.current.items).toEqual(committed);
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(view.result.current.items).toEqual([]);
      expect(view.result.current.hasServerData).toBe(true);
    },
  );

  it.each(['drain', 'server read'] as const)(
    'narrow barrier: a permission-denied %s retires committed rows without first-answer barriers', async (phase) => {
      const view = renderHook(() => usePendingItems());
      const listener = H.subscriptions[0];
      await act(async () => listener.next(snapshot()));
      const error = Object.assign(new Error('access revoked'), { code: 'permission-denied' });
      if (phase === 'drain') H.pendingWrites.mockRejectedValueOnce(error);
      else H.serverRead.mockRejectedValueOnce(error);
      await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
      expect(view.result.current.items).toEqual([]);
      expect(view.result.current.hasServerData).toBe(false);
      expect(view.result.current.failed).toBe(true);
      expect(H.pendingWrites).toHaveBeenCalledTimes(1);
      expect(H.serverRead).toHaveBeenCalledTimes(phase === 'drain' ? 0 : 1);
      await act(async () => listener.next({ ...snapshot(), metadata: { fromCache: false, hasPendingWrites: true } }));
      expect(view.result.current.items).toEqual([]);
      expect(view.result.current.hasServerData).toBe(false);
    },
  );

  it('narrow barrier: uses snapshot document IDs even when mapped rows are identical', async () => {
    const view = renderHook(() => usePendingItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    const committed = view.result.current.items;
    const replacement = { ...snapshot(), docs: [{ ...snapshot().docs[0], id: 'replacement' }] };
    let drain!: () => void;
    H.pendingWrites.mockImplementationOnce(() => new Promise<void>((resolve) => { drain = resolve; }));
    H.serverRead.mockResolvedValueOnce(replacement);
    await act(async () => listener.next(replacement));
    expect(view.result.current.items).toEqual(committed);
    expect(H.pendingWrites).toHaveBeenCalledTimes(1);
    await act(async () => drain());
    expect(H.serverRead).toHaveBeenCalledTimes(1);
    // Repeating the replacement membership must not retain the retired ID.
    await act(async () => listener.next(replacement));
    expect(H.pendingWrites).toHaveBeenCalledTimes(1);
    expect(H.serverRead).toHaveBeenCalledTimes(1);
  });

  it('keeps a real native false-pending query removal until drain and a fresh server answer', async () => {
    const view = renderHook(() => usePendingItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    const committed = view.result.current.items;
    let drain!: () => void;
    let answer!: (value: ReturnType<typeof snapshot>) => void;
    H.pendingWrites.mockImplementationOnce(() => new Promise<void>((resolve) => { drain = resolve; }));
    H.serverRead.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    expect(view.result.current.items).toEqual(committed);
    await act(async () => drain());
    expect(view.result.current.items).toEqual(committed);
    // A rejected write may release the drain before its rollback listener fires.
    // Only the fresh server answer, not the captured empty echo, is publishable.
    await act(async () => answer(snapshot()));
    expect(view.result.current.items).toEqual(committed);
    expect(view.result.current.hasServerData).toBe(true);
  });


  it('publishes a successful removal only after the fresh server read confirms it', async () => {
    const view = renderHook(() => useAllItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    let drain!: () => void;
    H.pendingWrites.mockImplementationOnce(() => new Promise<void>((resolve) => { drain = resolve; }));
    H.serverRead.mockResolvedValueOnce({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } });
    await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    expect(view.result.current.items).toHaveLength(1);
    await act(async () => drain());
    expect(view.result.current.items).toEqual([]);
    expect(view.result.current.hasServerData).toBe(true);
  });

  it('a first settled empty query publishes directly without a queue barrier', async () => {
    const view = renderHook(() => usePendingClaims());
    await act(async () => H.subscriptions[0].next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    expect(view.result.current.claims).toEqual([]);
    expect(view.result.current.hasServerData).toBe(true);
    expect(view.result.current.loading).toBe(false);
    expect(H.pendingWrites).not.toHaveBeenCalled();
    expect(H.serverRead).not.toHaveBeenCalled();
  });

  it('a newer pending callback invalidates an older fresh server-read completion', async () => {
    const view = renderHook(() => usePendingItems());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    let answer!: (value: ReturnType<typeof snapshot>) => void;
    H.serverRead.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: true } }));
    await act(async () => answer({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    expect(view.result.current.items).toHaveLength(1);
    expect(view.result.current.hasServerData).toBe(true);
    await act(async () => listener.next(snapshot()));
    expect(view.result.current.items).toHaveLength(1);
  });

  it.each(['cache', 'denial', 'account', 'incarnation', 'event', 'recovery', 'offline', 'failure'] as const)(
    'retires a held queue barrier on %s without a late private read or publication', async (retirement) => {
      const view = renderHook(() => usePendingClaims());
      const listener = H.subscriptions[0];
      await act(async () => listener.next(snapshot()));
      let drain!: () => void;
      H.pendingWrites.mockImplementationOnce(() => new Promise<void>((resolve) => { drain = resolve; }));
      await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
      // Retirement must also cancel a burst's queued latest candidate.
      await act(async () => { listener.next(rowsSnapshot([])); listener.next(rowsSnapshot([])); });
      const priorReads = H.serverRead.mock.calls.length;
      if (retirement === 'cache') await act(async () => listener.next(snapshot(true)));
      if (retirement === 'denial') await act(async () => listener.error());
      if (retirement === 'account') H.session = { ...H.session, uid: 'bob', generation: 2 };
      if (retirement === 'incarnation') H.session = { ...H.session, generation: 2, db: { name: 'new-memory' } };
      if (retirement === 'event') H.eventId = 'other-event';
      if (retirement === 'recovery') H.session = { ...H.session, recoveryRequired: true };
      if (retirement === 'offline') H.session = { ...H.session, db: null, generation: 2 };
      if (retirement === 'failure') H.session = { ...H.session, failed: true };
      view.rerender();
      await act(async () => drain());
      expect(H.serverRead.mock.calls.length).toBe(priorReads);
      expect(view.result.current.claims).toEqual([]);
      expect(view.result.current.hasServerData).toBe(false);
    },
  );

  it.each(['denial', 'scope', 'unmount'] as const)('ignores a late server read after %s', async (retirement) => {
    const view = renderHook(() => usePendingClaims());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    let answer!: (value: ReturnType<typeof snapshot>) => void;
    H.serverRead.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    if (retirement === 'denial') await act(async () => listener.error());
    if (retirement === 'scope') { H.session = { ...H.session, uid: 'bob', generation: 2 }; view.rerender(); }
    if (retirement === 'unmount') view.unmount();
    await act(async () => answer(snapshot()));
    if (retirement !== 'unmount') {
      expect(view.result.current.claims).toEqual([]);
      expect(view.result.current.hasServerData).toBe(false);
    }
  });

  it.each(['drain', 'server read'] as const)('a failed %s clears private confirmation instead of using cached fallback', async (phase) => {
    const view = renderHook(() => usePendingClaims());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    const error = Object.assign(new Error('access revoked'), { code: 'permission-denied' });
    if (phase === 'drain') H.pendingWrites.mockRejectedValueOnce(error);
    else H.serverRead.mockRejectedValueOnce(error);
    await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    expect(view.result.current.claims).toEqual([]);
    expect(view.result.current.hasServerData).toBe(false);
    expect(view.result.current.failed).toBe(true);
  });

  it.each(['pending', 'cache'] as const)('a %s fresh-read result never becomes new private authority', async (origin) => {
    const view = renderHook(() => usePendingClaims());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    H.serverRead.mockResolvedValueOnce({ docs: [], metadata: { fromCache: origin === 'cache', hasPendingWrites: origin === 'pending' } });
    await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    expect(view.result.current.claims).toHaveLength(origin === 'cache' ? 0 : 1);
    expect(view.result.current.hasServerData).toBe(origin !== 'cache');
  });

  it('retained own claims, submissions and More count never synthesize a local terminal/removal answer', async () => {
    const view = renderHook(() => ({ claims: useMyClaims('alice'), items: useMyPendingItems('alice'), badge: usePendingItemCount() }));
    await act(async () => H.subscriptions.forEach((listener) => listener.next(snapshot())));
    H.pendingWrites.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      H.subscriptions[0].next({ docs: [{ id: 'row-alice', data: () => ({ uid: 'alice', status: 'confirmed', createdAt: 1, reportCount: 1 }) }], metadata: { fromCache: false, hasPendingWrites: true } });
      H.subscriptions.slice(1).forEach((listener) => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    });
    expect(view.result.current.claims.claims[0].status).toBe('pending');
    expect(view.result.current.items.items).toHaveLength(1);
    expect(view.result.current.badge.count).toBe(1);
  });

  it.each([
    ['claims', usePendingClaims], ['approvals', usePendingItems], ['items', useAllItems], ['reports', useReportedProofs],
  ] as const)('exposes confirmed and terminal-failure state for %s', async (_name, hook) => {
    const view = renderHook(() => hook());
    expect(view.result.current.hasServerData).toBe(false);
    expect(view.result.current.failed).toBe(false);
    await act(async () => H.subscriptions[0].next(snapshot(true)));
    expect(view.result.current.hasServerData).toBe(false);
    await act(async () => H.subscriptions[0].next(snapshot()));
    expect(view.result.current.hasServerData).toBe(true);
    await act(async () => H.subscriptions[0].error());
    expect(view.result.current.hasServerData).toBe(false);
    expect(view.result.current.failed).toBe(true);
  });
  it('binds an Admin queue to the private DB and never publishes a cache-only answer', async () => {
    const view = renderHook(() => usePendingClaims());
    expect(JSON.stringify(H.subscriptions[0].target)).toContain('private-memory');
    expect(JSON.stringify(H.subscriptions[0].target)).not.toContain('legacy-persistent');
    await act(async () => H.subscriptions[0].next(snapshot(true)));
    expect(view.result.current.claims).toEqual([]);
    expect(view.result.current.hasServerData).toBe(false);
    await act(async () => H.subscriptions[0].next(snapshot()));
    expect(view.result.current.claims).toHaveLength(1);
    expect(view.result.current.hasServerData).toBe(true);
  });
  it('drops private rows immediately on an account/incarnation switch and ignores a late old callback', async () => {
    const view = renderHook(() => usePendingClaims());
    const old = H.subscriptions[0];
    await act(async () => old.next(snapshot()));
    H.session = { ...H.session, uid: 'bob', generation: 2, db: { name: 'bob-memory' } }; view.rerender();
    expect(view.result.current.claims).toEqual([]);
    expect(old.stop).toHaveBeenCalledOnce();
    await act(async () => old.next(snapshot()));
    expect(view.result.current.claims).toEqual([]);
  });
  it('clears previously served private rows when the listener is denied', async () => {
    const view = renderHook(() => usePendingClaims());
    await act(async () => H.subscriptions[0].next(snapshot()));
    await act(async () => H.subscriptions[0].error());
    expect(view.result.current.claims).toEqual([]);
    expect(view.result.current.hasServerData).toBe(false);
  });
  it('opens no private listener during attended recovery', () => {
    H.session.recoveryRequired = true;
    const view = renderHook(() => usePendingClaims());
    expect(H.subscriptions).toHaveLength(0);
    expect(view.result.current.claims).toEqual([]);
  });
  it('retires the separate More badge listener on an offline transition', async () => {
    const view = renderHook(() => usePendingItemCount());
    await act(async () => H.subscriptions[0].next(snapshot())); expect(view.result.current.count).toBe(1);
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

  it.each([
    ['Admin Event', () => useAdminEventDoc()], ['own profile', () => useMyUser('alice')],
  ] as const)('keeps only the last confirmed %s during a server-backed pending write and rollback', async (_name, hook) => {
    const view = renderHook(() => hook());
    const listener = H.subscriptions[0];
    const committed = { displayName: 'Confirmed', admins: ['alice'] };
    const optimistic = { displayName: 'Uncommitted', admins: ['bob'] };
    await act(async () => listener.next(docSnapshot(optimistic, false, true)));
    expect(view.result.current.data).toBeNull();
    expect(view.result.current.hasServerData).toBe(false);
    await act(async () => listener.next(docSnapshot(committed)));
    expect(view.result.current.data).toEqual(committed);
    await act(async () => listener.next(docSnapshot(optimistic, false, true)));
    expect(view.result.current.data).toEqual(committed);
    expect(view.result.current.hasServerData).toBe(true);
    expect(view.result.current.hasPendingWrites).toBe(true);
    // A denied update rolls back through a fresh server snapshot; no local
    // optimistic value was ever published as private authority or UI data.
    await act(async () => listener.next(docSnapshot(committed)));
    expect(view.result.current.data).toEqual(committed);
    await act(async () => listener.error());
    expect(view.result.current.data).toBeNull();
    expect(view.result.current.hasServerData).toBe(false);
  });

  it.each([
    ['claims', usePendingClaims, 'claims'], ['approvals', usePendingItems, 'items'],
    ['items', useAllItems, 'items'], ['reports', useReportedProofs, 'flagged'],
  ] as const)('keeps only committed %s rows during own pending add/delete and rollback', async (_name, hook, field) => {
    const view = renderHook(() => hook());
    const rows = () => Reflect.get(view.result.current, field);
    const listener = H.subscriptions[0];
    await act(async () => listener.next({ ...snapshot(), metadata: { fromCache: false, hasPendingWrites: true } }));
    expect(rows()).toEqual([]);
    expect(view.result.current.hasServerData).toBe(false);
    await act(async () => listener.next(snapshot()));
    const committed = rows();
    await act(async () => listener.next({ docs: [{ id: 'row-alice', data: () => ({ uid: 'bob', status: 'pending', createdAt: 2, reportCount: 2 }) }], metadata: { fromCache: false, hasPendingWrites: true } }));
    expect(rows()).toEqual(committed);
    await act(async () => listener.next({ docs: [], metadata: { fromCache: false, hasPendingWrites: true } }));
    expect(rows()).toEqual(committed);
    expect(view.result.current.hasServerData).toBe(true);
    await act(async () => listener.next(snapshot()));
    expect(rows()).toEqual(committed);
    await act(async () => listener.error());
    expect(rows()).toEqual([]);
    expect(view.result.current.hasServerData).toBe(false);
  });

  it('cache-only answers retire both private retained values and cannot qualify later pending answers', async () => {
    const view = renderHook(() => ({ event: useAdminEventDoc(), claims: usePendingClaims() }));
    const [event, claims] = H.subscriptions;
    await act(async () => { event.next(docSnapshot({ admins: ['alice'] })); claims.next(snapshot()); });
    await act(async () => { event.next(docSnapshot({ admins: ['bob'] }, true, true)); claims.next(snapshot(true)); });
    expect(view.result.current.event.data).toBeNull();
    expect(view.result.current.claims.claims).toEqual([]);
    await act(async () => {
      event.next(docSnapshot({ admins: ['bob'] }, false, true));
      claims.next({ ...snapshot(), metadata: { fromCache: false, hasPendingWrites: true } });
    });
    expect(view.result.current.event.hasServerData).toBe(false);
    expect(view.result.current.claims.hasServerData).toBe(false);
  });

  it('retains a confirmed absent profile without exposing a pending local create', async () => {
    const view = renderHook(() => useMyUser('alice'));
    await act(async () => H.subscriptions[0].next(docSnapshot(null)));
    expect(view.result.current.hasServerData).toBe(true);
    await act(async () => H.subscriptions[0].next(docSnapshot({ displayName: 'Not committed' }, false, true)));
    expect(view.result.current.data).toBeNull();
    expect(view.result.current.hasServerData).toBe(true);
  });

  it('preserves the global profile across an Event-only change in the same private incarnation', async () => {
    const view = renderHook(() => useMyUser('alice'));
    const committed = { displayName: 'Global identity' };
    await act(async () => H.subscriptions[0].next(docSnapshot(committed)));
    await act(async () => H.subscriptions[0].next(docSnapshot({ displayName: 'Uncommitted' }, false, true)));
    H.eventId = 'other-event'; view.rerender();
    expect(H.subscriptions).toHaveLength(1);
    expect(view.result.current.data).toEqual(committed);
    expect(view.result.current.hasServerData).toBe(true);
  });

  it.each(['account', 'incarnation', 'event', 'recovery', 'offline', 'failure'] as const)('retires retained pending data on %s before old callbacks can publish', async (retirement) => {
    const view = renderHook(() => ({ event: useAdminEventDoc(), claims: usePendingClaims() }));
    const old = [...H.subscriptions];
    await act(async () => { old[0].next(docSnapshot({ admins: ['alice'] })); old[1].next(snapshot()); });
    await act(async () => { old[0].next(docSnapshot({ admins: ['bob'] }, false, true)); old[1].next({ ...snapshot(), metadata: { fromCache: false, hasPendingWrites: true } }); });
    if (retirement === 'account') H.session = { ...H.session, uid: 'bob', generation: 2 };
    if (retirement === 'incarnation') H.session = { ...H.session, generation: 2, db: { name: 'new-memory' } };
    if (retirement === 'event') H.eventId = 'other-event';
    if (retirement === 'recovery') H.session = { ...H.session, recoveryRequired: true };
    if (retirement === 'offline') H.session = { ...H.session, db: null, generation: 2 };
    if (retirement === 'failure') H.session = { ...H.session, failed: true };
    view.rerender();
    await act(async () => { old[0].next(docSnapshot({ admins: ['alice'] })); old[1].next(snapshot()); });
    expect(view.result.current.event.data).toBeNull();
    expect(view.result.current.event.hasServerData).toBe(false);
    expect(view.result.current.claims.claims).toEqual([]);
    expect(view.result.current.claims.hasServerData).toBe(false);
  });
});
