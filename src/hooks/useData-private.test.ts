import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const snapshot = (fromCache = false) => ({ docs: [{ data: () => ({ uid: 'alice', status: 'pending', createdAt: 1, reportCount: 1 }) }], metadata: { fromCache, hasPendingWrites: false } });
const docSnapshot = (data: object | null, fromCache = false, hasPendingWrites = false) => ({
  exists: () => data !== null, data: () => data, metadata: { fromCache, hasPendingWrites },
});
beforeEach(() => {
  H.session = { uid: 'alice', db: { name: 'private-memory' }, generation: 1, recoveryRequired: false, failed: false };
  H.subscriptions = [];
  H.eventId = 'event';
  H.pendingWrites.mockReset().mockResolvedValue(undefined);
  H.serverRead.mockReset().mockImplementation(async () => snapshot());
});
describe('private hook cache and actor boundaries (#1411)', () => {
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

  it('a first apparently settled empty query cannot qualify before its queue drains', async () => {
    let drain!: () => void;
    H.pendingWrites.mockImplementationOnce(() => new Promise<void>((resolve) => { drain = resolve; }));
    const view = renderHook(() => usePendingClaims());
    await act(async () => H.subscriptions[0].next({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }));
    expect(view.result.current.hasServerData).toBe(false);
    expect(view.result.current.loading).toBe(true);
    expect(H.serverRead).not.toHaveBeenCalled();
    await act(async () => drain());
    expect(view.result.current.claims).toHaveLength(1);
    expect(view.result.current.hasServerData).toBe(true);
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
    if (phase === 'drain') H.pendingWrites.mockRejectedValueOnce(new Error('auth retired'));
    else H.serverRead.mockRejectedValueOnce(new Error('permission denied'));
    await act(async () => listener.next(snapshot()));
    expect(view.result.current.claims).toEqual([]);
    expect(view.result.current.hasServerData).toBe(false);
    expect(view.result.current.failed).toBe(true);
  });

  it.each(['pending', 'cache'] as const)('a %s fresh-read result never becomes new private authority', async (origin) => {
    const view = renderHook(() => usePendingClaims());
    const listener = H.subscriptions[0];
    await act(async () => listener.next(snapshot()));
    H.serverRead.mockResolvedValueOnce({ docs: [], metadata: { fromCache: origin === 'cache', hasPendingWrites: origin === 'pending' } });
    await act(async () => listener.next(snapshot()));
    expect(view.result.current.claims).toHaveLength(origin === 'cache' ? 0 : 1);
    expect(view.result.current.hasServerData).toBe(origin !== 'cache');
  });

  it('retained own claims, submissions and More count never synthesize a local terminal/removal answer', async () => {
    const view = renderHook(() => ({ claims: useMyClaims('alice'), items: useMyPendingItems('alice'), badge: usePendingItemCount() }));
    await act(async () => H.subscriptions.forEach((listener) => listener.next(snapshot())));
    H.pendingWrites.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      H.subscriptions[0].next({ docs: [{ data: () => ({ uid: 'alice', status: 'confirmed', createdAt: 1, reportCount: 1 }) }], metadata: { fromCache: false, hasPendingWrites: true } });
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
    await act(async () => listener.next({ docs: [{ data: () => ({ uid: 'bob', status: 'pending', createdAt: 2, reportCount: 2 }) }], metadata: { fromCache: false, hasPendingWrites: true } }));
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
