import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type App = { name: string };
type Snapshot = { uid: string | null; db: { app: App } | null; generation: number; failed: boolean };
const H = vi.hoisted(() => ({
  primary: { currentUser: { uid: 'alice' } as { uid: string } | null },
  snapshot: { uid: 'alice', db: { app: { name: 'memory-alice' } }, generation: 1, failed: false } as Snapshot,
  recovered: true, emulators: false,
  listeners: new Set<() => void>(),
  factory: vi.fn(), captures: vi.fn(), getFunctions: vi.fn(), getStorage: vi.fn(),
  connectFunctions: vi.fn(), connectStorage: vi.fn(),
  refreshRecovery: vi.fn(), refreshConnection: vi.fn(),
}));
vi.mock('./firebase', () => ({
  auth: H.primary, appCheck: null, firebaseConfig: { projectId: 'demo-private' },
  firebaseEmulatorsEnabled: () => H.emulators,
}));
vi.mock('./auth/privateCacheRecoveryMarker', () => ({
  privateCacheRecovered: () => H.recovered, privateCacheRecoveryKey: () => 'recovered',
}));
vi.mock('./auth/privateFirestoreSession', () => ({
  createPrivateFirestoreSessions: (...args: unknown[]) => {
    H.factory(...args);
    return {
      getSnapshot: () => H.snapshot,
      subscribe: (listener: () => void) => { H.listeners.add(listener); return () => H.listeners.delete(listener); },
      refreshRecovery: H.refreshRecovery, refreshConnection: H.refreshConnection,
      capture: (allowRecovery: boolean) => {
        H.captures(allowRecovery);
        const snapshot = H.snapshot;
        const assertCurrent = () => {
          if (!snapshot.db || snapshot.uid !== H.primary.currentUser?.uid || snapshot.generation !== H.snapshot.generation || (!allowRecovery && !H.recovered)) throw new Error('Private session expired');
        };
        assertCurrent();
        return { ...snapshot, assertCurrent, guard: async <T,>(operation: () => Promise<T>) => { assertCurrent(); const value = await operation(); assertCurrent(); return value; } };
      },
    };
  },
}));
vi.mock('firebase/functions', () => ({
  getFunctions: (app: App, region: string) => { H.getFunctions(app, region); return { app, region }; },
  connectFunctionsEmulator: H.connectFunctions,
}));
vi.mock('firebase/storage', () => ({
  getStorage: (app: App) => { H.getStorage(app); return { app }; },
  connectStorageEmulator: H.connectStorage,
}));
vi.mock('firebase/app-check', () => ({ getToken: vi.fn() }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); H.listeners.clear();
  H.primary.currentUser = { uid: 'alice' };
  H.snapshot = { uid: 'alice', db: { app: { name: 'memory-alice' } }, generation: 1, failed: false };
  H.recovered = true; H.emulators = false;
});
afterEach(() => { vi.useRealTimers(); });

// Pure wrapper transport tests: lifecycle behavior is independently pinned in
// auth/privateFirestoreSession.test.ts, and real-SDK isolation in demo controls.
describe('captured private service transport', () => {
  it('binds Firestore, Functions and Storage to exactly the captured named app', async () => {
    const wrapper = await import('./privateFirestore');
    const lease = wrapper.capturePrivateFirestore();
    expect(H.getFunctions.mock.calls).toEqual([[lease.db!.app, 'us-central1']]);
    expect(H.getStorage.mock.calls).toEqual([[lease.db!.app]]);
    expect(lease.functions.app).toBe(lease.db!.app); expect(lease.storage.app).toBe(lease.db!.app);
    expect(H.connectFunctions).not.toHaveBeenCalled(); expect(H.connectStorage).not.toHaveBeenCalled();
    expect(H.captures).toHaveBeenCalledWith(false);
  });

  it('emulator captures use the same named app on every call with explicit local endpoints', async () => {
    H.emulators = true; const wrapper = await import('./privateFirestore');
    const first = wrapper.capturePrivateFirestore(); const second = wrapper.capturePrivateFirestore(true);
    expect(first.db).toBe(second.db); expect(H.factory).toHaveBeenCalledTimes(1);
    expect(H.factory.mock.calls[0][0]).toMatchObject({ emulator: { authUrl: 'http://127.0.0.1:9099', firestoreHost: '127.0.0.1', firestorePort: 8080 } });
    expect(H.getFunctions.mock.calls).toEqual([[first.db!.app, 'us-central1'], [first.db!.app, 'us-central1']]);
    expect(H.getStorage.mock.calls).toEqual([[first.db!.app], [first.db!.app]]);
    expect(H.connectFunctions.mock.calls).toEqual([[first.functions, '127.0.0.1', 5001], [second.functions, '127.0.0.1', 5001]]);
    expect(H.connectStorage.mock.calls).toEqual([[first.storage, '127.0.0.1', 9199], [second.storage, '127.0.0.1', 9199]]);
  });

  it.each(['account', 'recovery', 'missing-db'] as const)('a refused %s capture cannot fall back to primary services', async (failure) => {
    if (failure === 'account') H.primary.currentUser = { uid: 'bob' };
    if (failure === 'recovery') H.recovered = false;
    if (failure === 'missing-db') H.snapshot = { ...H.snapshot, db: null };
    const wrapper = await import('./privateFirestore');
    expect(() => wrapper.capturePrivateFirestore()).toThrow(/expired/);
    expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });

  it('retired completion refuses acknowledgement and never replaces captured service pointers', async () => {
    const wrapper = await import('./privateFirestore'); const lease = wrapper.capturePrivateFirestore();
    let release!: () => void; const operation = lease.guard(() => new Promise<void>((resolve) => { release = resolve; }));
    const rejection = expect(operation).rejects.toThrow(/expired/);
    H.primary.currentUser = { uid: 'bob' }; H.snapshot = { uid: 'bob', db: { app: { name: 'memory-bob' } }, generation: 2, failed: false };
    release(); await rejection;
    expect(lease.functions.app.name).toBe('memory-alice'); expect(lease.storage.app.name).toBe('memory-alice');
    expect(H.getFunctions).toHaveBeenCalledTimes(1); expect(H.getStorage).toHaveBeenCalledTimes(1);
  });

  it('own bootstrap waits for its exact session then captures all services once', async () => {
    H.snapshot = { ...H.snapshot, db: null }; const wrapper = await import('./privateFirestore');
    const waiting = wrapper.awaitPrivateFirestore('alice', true);
    H.snapshot = { ...H.snapshot, db: { app: { name: 'memory-alice-ready' } } };
    [...H.listeners].forEach((listener) => listener());
    const lease = await waiting;
    expect(lease.db!.app.name).toBe('memory-alice-ready'); expect(H.captures.mock.calls).toEqual([[true]]);
    expect(lease.storage.app).toBe(lease.db!.app); expect(lease.functions.app).toBe(lease.db!.app);
    expect(H.listeners.size).toBe(0);
  });

  it('missing readiness times out without constructing any service or falling back', async () => {
    H.snapshot = { ...H.snapshot, db: null }; const wrapper = await import('./privateFirestore');
    const waiting = wrapper.awaitPrivateFirestore('alice'); const rejection = expect(waiting).rejects.toThrow(/unavailable/);
    await vi.advanceTimersByTimeAsync(5000); await rejection;
    expect(H.listeners.size).toBe(0); expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });

  it('an already-failed private bridge rejects immediately without allocating a readiness timer', async () => {
    H.snapshot = { ...H.snapshot, uid: null, db: null, failed: true };
    const wrapper = await import('./privateFirestore');
    const waiting = wrapper.awaitPrivateFirestore('alice');
    const settled = await Promise.race([waiting.then(() => 'resolved', () => 'rejected'), Promise.resolve().then(() => 'pending')]);
    expect(settled).toBe('rejected'); expect(H.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });

  it('failure during an existing readiness wait immediately rejects and removes its timer', async () => {
    H.snapshot = { ...H.snapshot, db: null };
    const wrapper = await import('./privateFirestore'); const waiting = wrapper.awaitPrivateFirestore('alice');
    const rejection = expect(waiting).rejects.toThrow(/changed/);
    H.snapshot = { ...H.snapshot, uid: null, failed: true };
    [...H.listeners].forEach((listener) => listener()); await rejection;
    expect(H.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });

  it('a changed actor during bootstrap retires the wait without a new-account service lookup', async () => {
    H.snapshot = { ...H.snapshot, db: null }; const wrapper = await import('./privateFirestore');
    const waiting = wrapper.awaitPrivateFirestore('alice'); const rejection = expect(waiting).rejects.toThrow(/changed/);
    H.primary.currentUser = { uid: 'bob' }; H.snapshot = { ...H.snapshot, uid: 'bob', db: { app: { name: 'memory-bob' } } };
    [...H.listeners].forEach((listener) => listener()); await rejection;
    expect(H.listeners.size).toBe(0); expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });
});
