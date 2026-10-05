import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Subject = { uid: string };
type App = { name: string };
type Database = { app: App };
type Ref = { database: Database; path: string };
type Listener = { target: Ref; next: (snapshot: unknown) => void; error: (error: Error) => void; stop: ReturnType<typeof vi.fn> };
const H = vi.hoisted(() => ({
  primary: { currentUser: { uid: 'alice' } as Subject | null },
  eventId: 'event-a', recovered: true,
  before: null as ((next: Subject | null) => void) | null,
  tokenChanged: null as ((next: Subject | null) => void) | null,
  apps: [] as App[], listeners: [] as Listener[],
  storageRef: vi.fn(), upload: vi.fn(), download: vi.fn(), setDoc: vi.fn(), updateDoc: vi.fn(), getDoc: vi.fn(),
  decode: vi.fn(), finishDecode: null as (() => void) | null,
  drains: vi.fn(), drainSteps: [] as Array<() => Promise<void>>,
}));
vi.mock('../firebase', () => ({
  auth: H.primary, get EVENT_ID() { return H.eventId; }, db: { app: { name: 'persistent' } }, storage: {}, appCheck: null,
  firebaseConfig: { projectId: 'demo-private-retirement', apiKey: 'fixture', appId: 'fixture' }, firebaseEmulatorsEnabled: () => false,
}));
vi.mock('firebase/app', async (original) => ({
  ...await original<typeof import('firebase/app')>(),
  initializeApp: (_options: unknown, name: string) => { const app = { name }; H.apps.push(app); return app; }, deleteApp: vi.fn(async () => {}),
}));
vi.mock('firebase/auth', async (original) => ({
  ...await original<typeof import('firebase/auth')>(),
  initializeAuth: (app: App) => ({ app, currentUser: null }), updateCurrentUser: vi.fn(async () => {}),
  beforeAuthStateChanged: (_auth: unknown, before: (next: Subject | null) => void) => { H.before = before; return vi.fn(); },
  onIdTokenChanged: (_auth: unknown, next: (user: Subject | null) => void) => {
    H.tokenChanged = next; queueMicrotask(() => next(H.primary.currentUser)); return vi.fn();
  },
}));
vi.mock('firebase/firestore', async (original) => ({
  ...await original<typeof import('firebase/firestore')>(),
  initializeFirestore: (app: App) => ({ app }), memoryLocalCache: () => ({ memory: true }), terminate: vi.fn(async () => {}),
  doc: (database: Database, ...parts: string[]) => ({ database, path: parts.join('/'), withConverter() { return this; } }),
  collection: (database: Database, ...parts: string[]) => ({ database, path: parts.join('/'), withConverter() { return this; } }),
  query: (target: Ref) => target, where: vi.fn(),
  waitForPendingWrites: (database: Database) => { H.drains(database); return (H.drainSteps.shift() ?? (() => Promise.resolve()))(); },
  onSnapshot: (target: Ref, _options: unknown, next: Listener['next'], error: Listener['error']) => {
    const stop = vi.fn(); H.listeners.push({ target, next, error, stop }); return stop;
  },
  getDocsFromServer: async () => ({ docs: [] }),
  runTransaction: async (_database: Database, operation: (tx: { delete: (ref: Ref) => void }) => Promise<unknown>) => operation({
    delete: () => { throw Object.assign(new Error('standing direction refuses orphan deletion'), { code: 'permission-denied' }); },
  }),
  setDoc: (...args: unknown[]) => H.setDoc(...args), updateDoc: (...args: unknown[]) => H.updateDoc(...args), getDoc: (...args: unknown[]) => H.getDoc(...args),
}));
vi.mock('firebase/functions', async (original) => ({ ...await original<typeof import('firebase/functions')>(), getFunctions: (app: App) => ({ app }) }));
vi.mock('firebase/storage', async (original) => ({
  ...await original<typeof import('firebase/storage')>(), getStorage: (app: App) => ({ app }),
  ref: (client: { app: App }, path: string) => { H.storageRef(client, path); return { client, path }; },
  uploadBytes: (...args: unknown[]) => H.upload(...args), getDownloadURL: (...args: unknown[]) => H.download(...args),
}));
vi.mock('./privateCacheRecoveryMarker', () => ({ privateCacheRecovered: () => H.recovered, privateCacheRecoveryKey: () => 'fixture-recovery' }));

// Actual manager/facade, avatar/profile callers and reciprocal block observer. The controlled boundary
// is the public SDK/browser transport; no lease or generation is synthesized.
let sessions: ReturnType<typeof import('../privateFirestore')['privateFirestoreSessions']> | null = null;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  H.primary.currentUser = { uid: 'alice' }; H.eventId = 'event-a'; H.recovered = true;
  H.before = null; H.tokenChanged = null; H.apps = []; H.listeners = []; H.finishDecode = null; H.drainSteps = [];
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  H.decode.mockImplementation(() => new Promise<never>((_resolve, reject) => {
    H.finishDecode = () => reject(new Error('browser decode fallback'));
  }));
  vi.stubGlobal('createImageBitmap', H.decode);
  H.upload.mockResolvedValue({}); H.download.mockResolvedValue('https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app/o/avatars%2Falice.jpg?alt=media');
  H.setDoc.mockResolvedValue(undefined); H.updateDoc.mockResolvedValue(undefined);
  H.getDoc.mockResolvedValue({ exists: () => true, data: () => ({ status: 'archived' }), metadata: { fromCache: false, hasPendingWrites: false } });
});
afterEach(async () => { cleanup(); sessions?.stop(); sessions = null; H.finishDecode?.(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function ready() {
  const facade = await import('../privateFirestore'); sessions = facade.privateFirestoreSessions();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(sessions.getSnapshot().db).not.toBeNull(); return facade;
}
function expectNoAvatarIo() {
  expect(H.storageRef).not.toHaveBeenCalled(); expect(H.upload).not.toHaveBeenCalled(); expect(H.download).not.toHaveBeenCalled();
  expect(H.setDoc).not.toHaveBeenCalled(); expect(H.updateDoc).not.toHaveBeenCalled(); expect(H.getDoc).not.toHaveBeenCalled();
}

describe('actual manager retirement reaches the avatar caller (#1701)', () => {
  it('explicit manager Retry refuses resumed image preparation before any Storage/profile/mirror IO', async () => {
    const facade = await ready(); const old = sessions!.getSnapshot(); const lease = facade.capturePrivateFirestore();
    const { updateAvatar } = await import('../data/profile');
    const outcome = updateAvatar('alice', new Blob(['image'])).then(() => ({ status: 'completed' }), (error: unknown) => ({ status: 'rejected', error }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(H.decode).toHaveBeenCalledOnce();
    await act(async () => { sessions!.retry(); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot().db).not.toBe(old.db); expect(H.apps).toHaveLength(2);
    expect(() => lease.assertCurrent()).toThrow(/expired/);
    H.finishDecode!(); await expect(outcome).resolves.toMatchObject({ status: 'rejected', error: expect.objectContaining({ message: expect.stringMatching(/expired/) }) }); expectNoAvatarIo();
  });

  it('a healthy same-UID token callback keeps the held avatar lease and named Storage/profile clients', async () => {
    const facade = await ready(); const current = sessions!.getSnapshot(); const lease = facade.capturePrivateFirestore();
    const { updateAvatar } = await import('../data/profile');
    const pending = updateAvatar('alice', new Blob(['image'])).then((value) => ({ status: 'completed' as const, value }), (error: unknown) => ({ status: 'rejected' as const, error }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(H.decode).toHaveBeenCalledOnce();
    await act(async () => { H.tokenChanged!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot()).toBe(current); expect(() => lease.assertCurrent()).not.toThrow(); expect(H.apps).toHaveLength(1);
    H.finishDecode!(); const result = await pending;
    expect(result.status).toBe('completed'); if (result.status !== 'completed') throw result.error; const url = result.value;
    expect(H.storageRef).toHaveBeenCalledExactlyOnceWith(lease.storage, 'avatars/alice.jpg');
    expect(H.upload).toHaveBeenCalledOnce(); expect(H.download).toHaveBeenCalledOnce();
    expect(H.setDoc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ database: lease.db, path: 'users/alice' }), { photoURL: url, customPhoto: true }, { merge: true });
    expect(H.getDoc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ database: expect.objectContaining({ app: { name: 'persistent' } }), path: 'events/event-a' }));
    expect(H.updateDoc).not.toHaveBeenCalled(); expect(lease.storage.app).toBe(current.db!.app);
  });

  it.each(['account', 'recovery', 'stop'] as const)('a real %s retirement refuses resumed avatar preparation before private IO', async (boundary) => {
    const facade = await ready(); const lease = facade.capturePrivateFirestore();
    const { updateAvatar } = await import('../data/profile');
    const outcome = updateAvatar('alice', new Blob(['image'])).then(() => ({ status: 'completed' }), (error: unknown) => ({ status: 'rejected', error }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(H.decode).toHaveBeenCalledOnce();
    await act(async () => {
      if (boundary === 'account') { const bob = { uid: 'bob' }; H.before!(bob); H.primary.currentUser = bob; H.tokenChanged!(bob); }
      if (boundary === 'recovery') { H.recovered = false; sessions!.refreshRecovery(); }
      if (boundary === 'stop') sessions!.stop();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(() => lease.assertCurrent()).toThrow(/expired/);
    H.finishDecode!(); await expect(outcome).resolves.toMatchObject({ status: 'rejected' }); expectNoAvatarIo();
  });

  it('recovery quarantine refuses the real avatar caller before image preparation or private IO', async () => {
    H.recovered = false; await ready(); const { updateAvatar } = await import('../data/profile');
    await expect(updateAvatar('alice', new Blob(['image']))).rejects.toThrow(/recovery/);
    expect(H.decode).not.toHaveBeenCalled(); expectNoAvatarIo();
  });

});


function pairs(uids: string[], fromCache = false, hasPendingWrites = false) {
  return { docs: [{ data: () => ({ uids }) }], metadata: { fromCache, hasPendingWrites } };
}
async function observeBlocks() {
  const facade = await ready(); const { useHiddenUidsSubscription } = await import('../hooks/useBlocks');
  const view = renderHook(() => useHiddenUidsSubscription(H.primary.currentUser?.uid ?? null, true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(H.listeners).toHaveLength(1); expect(H.listeners[0].target.database).toBe(sessions!.getSnapshot().db);
  await act(async () => { H.listeners[0].next(pairs(['alice', 'blocked'])); await vi.advanceTimersByTimeAsync(0); });
  expect(view.result.current).toEqual({ hidden: new Set(['blocked']), ready: true });
  return { view, facade };
}

describe('actual manager publications retire the real reciprocal observer (#1701)', () => {
  it('Retry retires confirmation before a fresh drain and refuses old, cached and pending answers', async () => {
    const { view, facade } = await observeBlocks(); const lease = facade.capturePrivateFirestore(true); const old = H.listeners[0];
    const previous = sessions!.getSnapshot(); let finishDrain!: () => void;
    H.drainSteps = [() => new Promise<void>((resolve) => { finishDrain = resolve; })];
    await act(async () => { sessions!.retry(); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot().db).not.toBe(previous.db); expect(() => lease.assertCurrent()).toThrow(/expired/);
    expect(old.stop).toHaveBeenCalledOnce(); expect(H.drains).toHaveBeenCalledTimes(2); expect(H.listeners).toHaveLength(1);
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    await act(async () => { old.next(pairs(['alice', 'obsolete'])); await vi.advanceTimersByTimeAsync(0); });
    expect(view.result.current.ready).toBe(false);
    await act(async () => { finishDrain(); await vi.advanceTimersByTimeAsync(0); });
    expect(H.listeners).toHaveLength(2); const fresh = H.listeners[1]; expect(fresh.target.database).toBe(sessions!.getSnapshot().db);
    await act(async () => { fresh.next(pairs(['alice', 'fresh'], true)); await vi.advanceTimersByTimeAsync(0); });
    expect(view.result.current.ready).toBe(false);
    await act(async () => { fresh.next(pairs(['alice', 'fresh'], false, true)); await vi.advanceTimersByTimeAsync(0); });
    expect(view.result.current.ready).toBe(false);
    await act(async () => { fresh.next(pairs(['alice', 'fresh'])); await vi.advanceTimersByTimeAsync(0); });
    expect(view.result.current).toEqual({ hidden: new Set(['fresh']), ready: true });
    await act(async () => { old.next(pairs(['alice', 'obsolete'])); await vi.advanceTimersByTimeAsync(0); });
    expect(view.result.current).toEqual({ hidden: new Set(['fresh']), ready: true }); expect(() => lease.assertCurrent()).toThrow(/expired/);
  });

  it('healthy same-UID token refresh keeps confirmation, its private lease and the original subscription', async () => {
    const { view, facade } = await observeBlocks(); const lease = facade.capturePrivateFirestore(true); const current = sessions!.getSnapshot();
    await act(async () => { H.tokenChanged!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot()).toBe(current); expect(() => lease.assertCurrent()).not.toThrow(); expect(H.apps).toHaveLength(1);
    expect(H.drains).toHaveBeenCalledTimes(1); expect(H.listeners).toHaveLength(1); expect(H.listeners[0].stop).not.toHaveBeenCalled();
    expect(view.result.current).toEqual({ hidden: new Set(['blocked']), ready: true });
  });

  it.each(['account', 'Event', 'recovery', 'stop'] as const)('real %s scope retirement refuses the old block callback', async (boundary) => {
    const { view, facade } = await observeBlocks(); const old = H.listeners[0]; const lease = facade.capturePrivateFirestore(true);
    await act(async () => {
      if (boundary === 'account') { const bob = { uid: 'bob' }; H.before!(bob); H.primary.currentUser = bob; H.tokenChanged!(bob); }
      if (boundary === 'Event') { H.eventId = 'event-b'; view.rerender(); }
      if (boundary === 'recovery') { H.recovered = false; sessions!.refreshRecovery(); }
      if (boundary === 'stop') sessions!.stop();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(old.stop).toHaveBeenCalledOnce(); expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    await act(async () => { old.next(pairs(['alice', 'obsolete'])); await vi.advanceTimersByTimeAsync(0); });
    expect(view.result.current).toEqual({ hidden: new Set(), ready: false });
    if (boundary === 'stop') {
      await act(async () => { H.tokenChanged!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0); });
      expect(H.apps).toHaveLength(1); expect(H.listeners).toHaveLength(1); expect(H.drains).toHaveBeenCalledTimes(1);
      expect(() => lease.assertCurrent()).toThrow(/expired/);
    } else {
      expect(H.listeners).toHaveLength(2); expect(H.drains).toHaveBeenCalledTimes(2);
      const fresh = H.listeners[1]; const uid = H.primary.currentUser!.uid;
      expect(fresh.target.path).toBe(`events/${H.eventId}/blockPairs`);
      expect(fresh.target.database).toBe(sessions!.getSnapshot().db);
      await act(async () => { fresh.next(pairs([uid, 'fresh'])); await vi.advanceTimersByTimeAsync(0); });
      expect(view.result.current).toEqual({ hidden: new Set(['fresh']), ready: true });
      if (boundary === 'Event') {
        // Profile leases are global by UID. The Event observer still retires.
        expect(() => lease.assertCurrent()).not.toThrow(); expect(H.apps).toHaveLength(1);
      } else expect(() => lease.assertCurrent()).toThrow(/expired/);
      if (boundary === 'recovery') expect(() => facade.capturePrivateFirestore()).toThrow(/recovery/);
    }
  });

});
