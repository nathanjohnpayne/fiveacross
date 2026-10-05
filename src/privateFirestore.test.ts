import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type App = { name: string };
type Snapshot = { uid: string | null; db: { app: App } | null; generation: number; failed: boolean };
const H = vi.hoisted(() => ({
  primary: { currentUser: { uid: 'alice' } as { uid: string } | null },
  snapshot: { uid: 'alice', db: { app: { name: 'memory-alice' } }, generation: 1, failed: false } as Snapshot,
  recovered: true, emulators: false, divergentLeaseUid: null as string | null,
  listeners: new Set<() => void>(),
  factory: vi.fn(), captures: vi.fn(), getFunctions: vi.fn(), getStorage: vi.fn(),
  connectFunctions: vi.fn(), connectStorage: vi.fn(),
  refreshRecovery: vi.fn(), refreshConnection: vi.fn(), retry: vi.fn(),
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
      refreshRecovery: H.refreshRecovery, refreshConnection: H.refreshConnection, retry: H.retry,
      capture: (allowRecovery: boolean) => {
        H.captures(allowRecovery);
        const snapshot = H.snapshot;
        const assertCurrent = () => {
          if (!snapshot.db || snapshot.uid !== H.primary.currentUser?.uid || snapshot.generation !== H.snapshot.generation || (!allowRecovery && !H.recovered)) throw new Error('Private session expired');
        };
        assertCurrent();
        // Explicit manager-contract violation for the facade's defensive UID check.
        return { ...snapshot, uid: H.divergentLeaseUid ?? snapshot.uid, assertCurrent, guard: async <T,>(operation: () => Promise<T>) => { assertCurrent(); const value = await operation(); assertCurrent(); return value; } };
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
  H.recovered = true; H.emulators = false; H.divergentLeaseUid = null;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
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
    expect(H.getFunctions.mock.calls).toEqual([[lease.db!.app, 'us-central1']]);
    expect(H.getStorage.mock.calls).toEqual([[lease.db!.app]]);
    expect(H.listeners.size).toBe(0);
  });

  it.each([false, true])('a divergent bare bootstrap lease refuses before service binding (emulators=%s)', async (emulators) => {
    H.emulators = emulators; H.recovered = false; H.divergentLeaseUid = 'bob';
    const wrapper = await import('./privateFirestore');
    await expect(wrapper.awaitPrivateFirestore('alice', true)).rejects.toThrow('Private account changed.');
    expect(H.captures.mock.calls).toEqual([[true]]);
    expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
    expect(H.connectFunctions).not.toHaveBeenCalled(); expect(H.connectStorage).not.toHaveBeenCalled();
  });

  it('missing readiness times out without constructing any service or falling back', async () => {
    H.snapshot = { ...H.snapshot, db: null }; const wrapper = await import('./privateFirestore');
    const waiting = wrapper.awaitPrivateFirestore('alice'); const rejection = expect(waiting).rejects.toThrow(/unavailable/);
    await vi.advanceTimersByTimeAsync(5000); await rejection;
    expect(H.listeners.size).toBe(0); expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });

  it('an already-exhausted private bridge rejects immediately without allocating a readiness timer', async () => {
    H.snapshot = { ...H.snapshot, uid: null, db: null, failed: true };
    const wrapper = await import('./privateFirestore');
    const waiting = wrapper.awaitPrivateFirestore('alice');
    const settled = await Promise.race([waiting.then(() => 'resolved', () => 'rejected'), Promise.resolve().then(() => 'pending')]);
    expect(settled).toBe('rejected'); expect(H.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });

  it('exhaustion during an existing readiness wait immediately rejects and removes its timer', async () => {
    H.snapshot = { ...H.snapshot, db: null };
    const wrapper = await import('./privateFirestore'); const waiting = wrapper.awaitPrivateFirestore('alice');
    const rejection = expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
    H.snapshot = { ...H.snapshot, uid: null, failed: true };
    [...H.listeners].forEach((listener) => listener()); await rejection;
    expect(H.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });

  it('failed readiness is transient and explicit retry starts one new episode', async () => {
    H.snapshot = { ...H.snapshot, uid: null, db: null, failed: true };
    const wrapper = await import('./privateFirestore');
    await expect(wrapper.awaitPrivateFirestore('alice')).rejects.toMatchObject({ code: 'unavailable' });
    wrapper.retryPrivateFirestoreSession();
    expect(H.retry).toHaveBeenCalledOnce();
    expect(H.getFunctions).not.toHaveBeenCalled();
  });

  it('timed-out readiness is transient and keeps the captured actor fence', async () => {
    H.snapshot = { ...H.snapshot, db: null };
    const wrapper = await import('./privateFirestore');
    const waiting = wrapper.awaitPrivateFirestore('alice');
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    H.primary.currentUser = { uid: 'bob' };
    await expect(wrapper.awaitPrivateFirestore('alice')).rejects.toThrow(/changed/);
    expect(H.retry).not.toHaveBeenCalled();
  });

  it('a changed actor during bootstrap retires the wait without a new-account service lookup', async () => {
    H.snapshot = { ...H.snapshot, db: null }; const wrapper = await import('./privateFirestore');
    const waiting = wrapper.awaitPrivateFirestore('alice'); const rejection = expect(waiting).rejects.toThrow(/changed/);
    H.primary.currentUser = { uid: 'bob' }; H.snapshot = { ...H.snapshot, uid: 'bob', db: { app: { name: 'memory-bob' } } };
    [...H.listeners].forEach((listener) => listener()); await rejection;
    expect(H.listeners.size).toBe(0); expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });

  it('rechecks the actor after readiness resolves and before constructing services', async () => {
    H.snapshot = { ...H.snapshot, db: null }; const wrapper = await import('./privateFirestore');
    const waiting = wrapper.awaitPrivateFirestore('alice'); const rejection = expect(waiting).rejects.toThrow(/changed/);
    H.snapshot = { ...H.snapshot, db: { app: { name: 'memory-alice' } } };
    [...H.listeners].forEach((listener) => listener());
    // Both publications may precede the async wait continuation.
    H.primary.currentUser = { uid: 'bob' };
    H.snapshot = { ...H.snapshot, uid: 'bob', db: { app: { name: 'memory-bob' } }, generation: 2 };
    [...H.listeners].forEach((listener) => listener());
    await rejection;
    expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });
});


describe('gameplay Retry restarts only an unavailable current-actor bridge (#1687)', () => {
  it('keeps a healthy current actor bridge even while ordinary UI is quarantined for recovery', async () => {
    H.recovered = false;
    const wrapper = await import('./privateFirestore');
    wrapper.retryPrivateFirestoreSession('alice');
    expect(H.retry).not.toHaveBeenCalled(); expect(H.factory).toHaveBeenCalledOnce();
    expect(H.captures).not.toHaveBeenCalled(); expect(H.getFunctions).not.toHaveBeenCalled();
  });

  it.each(['failed', 'initializing', 'wrong-session'] as const)('starts exactly one fresh episode for %s availability', async (state) => {
    if (state === 'failed') H.snapshot = { ...H.snapshot, failed: true, db: null, uid: null };
    if (state === 'initializing') H.snapshot = { ...H.snapshot, db: null };
    if (state === 'wrong-session') H.snapshot = { ...H.snapshot, uid: 'old-actor' };
    const wrapper = await import('./privateFirestore'); wrapper.retryPrivateFirestoreSession('alice');
    expect(H.retry).toHaveBeenCalledOnce(); expect(H.captures).not.toHaveBeenCalled();
    expect(H.getFunctions).not.toHaveBeenCalled(); expect(H.getStorage).not.toHaveBeenCalled();
  });

  it.each(['offline', 'signed-out', 'changed-actor'] as const)('refuses %s gameplay restart before creating a manager', async (state) => {
    if (state === 'offline') Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    if (state === 'signed-out') H.primary.currentUser = null;
    if (state === 'changed-actor') H.primary.currentUser = { uid: 'bob' };
    const wrapper = await import('./privateFirestore'); wrapper.retryPrivateFirestoreSession('alice');
    expect(H.factory).not.toHaveBeenCalled(); expect(H.retry).not.toHaveBeenCalled();
  });
});
