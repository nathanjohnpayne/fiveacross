import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Subject = { uid: string; displayName: string; photoURL: null };
type App = { name: string };
type Database = { app: App };
type Ref = { database: Database; path: string };
type TransactionFixture = { get: (ref: Ref) => Promise<ReturnType<typeof snapshot>>; set: (ref: Ref) => void; delete: (ref: Ref) => void };
function snapshot(data: Record<string, unknown> | null) { return { exists: () => data !== null, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } }; }
const H = vi.hoisted(() => ({
  primary: { currentUser: { uid: 'alice', displayName: 'Alice', photoURL: null } as Subject | null },
  eventId: 'event-a', recovered: true,
  before: null as ((next: Subject | null) => void) | null,
  authChanged: null as ((next: Subject | null) => void) | null,
  tokenChanged: null as ((next: Subject | null) => void) | null,
  cloneFailures: 0, cloneSteps: [] as Array<() => Promise<void>>,
  apps: [] as App[], services: [] as App[], profileReads: [] as Ref[], serverReads: [] as Ref[],
  serverFailure: null as Error | null, profileFailure: null as Error | null,
  serverSteps: [] as Array<() => Promise<void>>,
  gameplayTransactions: 0, heldJoin: true, releaseJoin: null as (() => void) | null,
  pairListeners: [] as Array<{ target: Ref; next: (snapshot: unknown) => void; error: (error: Error) => void; stop: ReturnType<typeof vi.fn> }>,
  drains: vi.fn(), writes: [] as Ref[],
}));
vi.mock('../firebase', () => ({
  auth: H.primary, get EVENT_ID() { return H.eventId; }, googleProvider: {},
  db: { app: { name: 'persistent' } }, functions: {}, storage: {}, appCheck: null,
  firebaseConfig: { projectId: 'demo-private-bootstrap', apiKey: 'fixture', appId: 'fixture' },
  firebaseEmulatorsEnabled: () => false,
}));
vi.mock('firebase/app', async (original) => ({
  ...await original<typeof import('firebase/app')>(),
  initializeApp: (_options: unknown, name: string) => { const app = { name }; H.apps.push(app); return app; },
  deleteApp: vi.fn(async () => {}),
}));
vi.mock('firebase/auth', async (original) => ({
  ...await original<typeof import('firebase/auth')>(),
  initializeAuth: (app: App) => ({ app, currentUser: null }),
  updateCurrentUser: async (_auth: unknown, user: Subject | null) => {
    if (!user) return;
    if (H.cloneFailures > 0) { H.cloneFailures--; throw new Error('transient private clone failure'); }
    await (H.cloneSteps.shift() ?? (() => Promise.resolve()))();
  },
  beforeAuthStateChanged: (_auth: unknown, before: (next: Subject | null) => void) => { H.before = before; return vi.fn(); },
  onIdTokenChanged: (_auth: unknown, next: (user: Subject | null) => void) => {
    H.tokenChanged = next;
    queueMicrotask(() => next(H.primary.currentUser)); return vi.fn();
  },
  onAuthStateChanged: (_auth: unknown, next: (user: Subject | null) => void) => { H.authChanged = next; return vi.fn(); },
  getRedirectResult: vi.fn(async () => null),
}));
vi.mock('firebase/firestore', async (original) => {
  const actual = await original<typeof import('firebase/firestore')>();
  return { ...actual,
    initializeFirestore: (app: App) => ({ app }), memoryLocalCache: () => ({ memory: true }), terminate: vi.fn(async () => {}),
    doc: (database: Database, ...parts: string[]) => ({ database, path: parts.join('/'), withConverter() { return this; } }),
    collection: (database: Database, ...parts: string[]) => ({ database, path: parts.join('/'), withConverter() { return this; } }),
    query: (target: Ref) => target, where: vi.fn(),
    runTransaction: async (database: Database, operation: (tx: TransactionFixture) => Promise<unknown>) => {
      if (database.app.name === 'persistent') {
        H.gameplayTransactions++;
        if (H.heldJoin) { H.heldJoin = false; await new Promise<void>((resolve) => { H.releaseJoin = resolve; }); }
      }
      return operation({
        get: async (ref) => {
          if (ref.path.startsWith('users/')) {
            H.profileReads.push(ref);
            if (H.profileFailure) throw H.profileFailure;
            return snapshot({ attestedAdultAt: 123 });
          }
          return snapshot({ joinedAt: 123 });
        },
        set: (ref) => { H.writes.push(ref); },
        delete: () => { throw Object.assign(new Error('standing direction refuses orphan delete'), { code: 'permission-denied' }); },
      });
    },
    getDoc: async (ref: Ref) => snapshot(ref.path.startsWith('users/') ? { attestedAdultAt: 123 } : { days: [{ index: 0 }] }),
    getDocFromCache: async () => snapshot(null),
    getDocFromServer: async (ref: Ref) => {
      expect(ref.database.app.name).not.toBe('persistent'); H.serverReads.push(ref);
      await (H.serverSteps.shift() ?? (() => Promise.resolve()))();
      if (H.serverFailure) throw H.serverFailure;
      return snapshot({ attestedAdultAt: 123 });
    },
    getDocsFromServer: async () => ({ docs: [{ data: () => ({ targetUid: 'blocked' }) }] }),
    waitForPendingWrites: (database: Database) => { H.drains(database); return Promise.resolve(); },
    onSnapshot: (target: Ref, _options: unknown, next: (snapshot: unknown) => void, error: (error: Error) => void) => {
      const stop = vi.fn(); H.pairListeners.push({ target, next, error, stop }); return stop;
    },
  };
});
vi.mock('firebase/functions', async (original) => ({
  ...await original<typeof import('firebase/functions')>(),
  getFunctions: (app: App) => { H.services.push(app); return { app }; },
  httpsCallable: () => vi.fn(),
}));
vi.mock('firebase/storage', async (original) => ({
  ...await original<typeof import('firebase/storage')>(), getStorage: (app: App) => ({ app }),
}));
vi.mock('./privateCacheRecoveryMarker', () => ({ privateCacheRecovered: () => H.recovered, privateCacheRecoveryKey: () => 'fixture-recovery' }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../hooks/useAdultContent', () => ({ useAdultContent: () => true }));
// AuthProvider, profile/attestation, manager/facade, HiddenUidsProvider and
// joinAndDeal remain actual; only SDK transports and unrelated UI watchers are controlled.
vi.mock('../components/ConfirmWinMoments', () => ({ default: () => null }));
vi.mock('../components/RetractWinMoments', () => ({ default: () => null }));
vi.mock('../components/PoolRecoveryWatcher', () => ({ default: () => null }));
vi.mock('../components/AdultContentWatcher', () => ({ default: () => null }));


let sessions: ReturnType<typeof import('../privateFirestore')['privateFirestoreSessions']> | null = null;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear();
  H.primary.currentUser = { uid: 'alice', displayName: 'Alice', photoURL: null };
  H.eventId = 'event-a'; H.recovered = true; H.before = null; H.authChanged = null; H.tokenChanged = null;
  H.cloneFailures = 0; H.cloneSteps = []; H.apps = []; H.services = []; H.profileReads = []; H.serverReads = []; H.serverFailure = null;
  H.profileFailure = null;
  H.serverSteps = []; H.gameplayTransactions = 0; H.heldJoin = true; H.releaseJoin = null; H.pairListeners = []; H.writes = [];
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, callback: (lock: { name: string }) => unknown) => callback({ name: 'fixture' }),
  } });
});
afterEach(async () => { cleanup(); sessions?.stop(); sessions = null; H.releaseJoin?.(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); });

async function mount() {
  const { AuthProvider, useAuth } = await import('./AuthContext');
  const { privateFirestoreSessions, capturePrivateFirestore } = await import('../privateFirestore');
  const { useHiddenUids } = await import('../hooks/useBlocks');
  function Probe() {
    const auth = useAuth(); const blocks = useHiddenUids();
    return <div>
      <output data-testid="error">{auth.dealErrorReason ?? 'none'}</output>
      <output data-testid="blocks">{blocks.ready ? [...blocks.hidden].join(',') : 'withheld'}</output>
      <button onClick={auth.retryDeal}>Retry</button>
    </div>;
  }
  const tree = render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { H.authChanged!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0); });
  sessions = privateFirestoreSessions();
  return { capture: () => capturePrivateFirestore(true), rerender: () => tree.rerender(<AuthProvider><Probe /></AuthProvider>) };
}
async function confirmBlocks() {
  expect(H.pairListeners).toHaveLength(1);
  expect(H.pairListeners[0].target.database).toBe(sessions!.getSnapshot().db);
  await act(async () => {
    H.pairListeners[0].next({ docs: [{ data: () => ({ uids: ['alice', 'blocked'] }) }], metadata: { fromCache: false, hasPendingWrites: false } });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByTestId('blocks')).toHaveTextContent('blocked');
}

it('an actual gameplay timeout retries without retiring its healthy private lease or confirmed block answer', async () => {
  const view = await mount(); await confirmBlocks();
  expect(H.gameplayTransactions).toBe(1);
  const before = sessions!.getSnapshot(); const lease = view.capture();
  await act(async () => { H.tokenChanged!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0); });
  expect(sessions!.getSnapshot()).toBe(before);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(screen.getByTestId('error')).toHaveTextContent('connection');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
  expect(H.gameplayTransactions).toBe(2);
  expect(sessions!.getSnapshot()).toBe(before);
  expect(() => lease.assertCurrent()).not.toThrow();
  expect(H.apps).toHaveLength(1); expect(H.drains).toHaveBeenCalledTimes(1);
  expect(H.pairListeners).toHaveLength(1); expect(H.pairListeners[0].stop).not.toHaveBeenCalled();
  expect(screen.getByTestId('blocks')).toHaveTextContent('blocked');
  expect(screen.getByTestId('error')).toHaveTextContent('none');
  // The original SDK operation is uncancelled. Its late same-actor no-op must
  // not replace Retry's current UI or rotate the still-current private client.
  await act(async () => { H.releaseJoin!(); await vi.advanceTimersByTimeAsync(0); });
  expect(sessions!.getSnapshot()).toBe(before);
  expect(screen.getByTestId('error')).toHaveTextContent('none');
  expect(screen.getByTestId('blocks')).toHaveTextContent('blocked');
});


it('an exhausted bridge Retry still creates one bounded fresh episode and bootstraps the actual join', async () => {
  H.cloneFailures = 4; H.heldJoin = false; await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_250); });
  expect(sessions!.getSnapshot()).toMatchObject({ failed: true, retryPending: false });
  expect(screen.getByTestId('error')).toHaveTextContent('connection');
  expect(H.gameplayTransactions).toBe(0); expect(H.apps).toHaveLength(4);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
  expect(H.apps).toHaveLength(5); expect(H.gameplayTransactions).toBe(1);
  expect(screen.getByTestId('blocks')).toHaveTextContent('withheld');
  await confirmBlocks();
  expect(screen.getByTestId('error')).toHaveTextContent('none');
  expect(H.profileReads[0].database).toBe(sessions!.getSnapshot().db);
  expect(H.serverReads[0].database).toBe(sessions!.getSnapshot().db);
});

it('Retry after timed-out initializing readiness retires that candidate and refuses its late completion', async () => {
  let release!: () => void;
  H.cloneSteps = [() => new Promise<void>((resolve) => { release = resolve; })];
  H.heldJoin = false; await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(sessions!.getSnapshot()).toMatchObject({ failed: false, db: null });
  expect(screen.getByTestId('error')).toHaveTextContent('connection');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
  const recovered = sessions!.getSnapshot(); expect(H.apps).toHaveLength(2); expect(H.gameplayTransactions).toBe(1);
  await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
  expect(sessions!.getSnapshot()).toBe(recovered); expect(H.gameplayTransactions).toBe(1);
  expect(screen.getByTestId('error')).toHaveTextContent('none');
});

it('a healthy bridge recovered after readiness timeout is retained when gameplay Retry arrives', async () => {
  let release!: () => void;
  H.cloneSteps = [() => new Promise<void>((resolve) => { release = resolve; })];
  H.heldJoin = false; await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); release(); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByTestId('error')).toHaveTextContent('connection');
  const recovered = sessions!.getSnapshot(); expect(recovered.db).not.toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
  expect(sessions!.getSnapshot()).toBe(recovered); expect(H.apps).toHaveLength(1); expect(H.gameplayTransactions).toBe(1);
  expect(screen.getByTestId('error')).toHaveTextContent('none');
});

it('stale Alice UI cannot restart Bob or dispatch another gameplay attempt after an actor change', async () => {
  await mount(); await confirmBlocks();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(screen.getByTestId('error')).toHaveTextContent('connection');
  const bob: Subject = { uid: 'bob', displayName: 'Bob', photoURL: null };
  await act(async () => { H.before!(bob); H.primary.currentUser = bob; H.tokenChanged!(bob); await vi.advanceTimersByTimeAsync(0); });
  const current = sessions!.getSnapshot(); expect(current.uid).toBe('bob');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
  expect(sessions!.getSnapshot()).toBe(current); expect(H.apps).toHaveLength(2);
  expect(H.gameplayTransactions).toBe(1); expect(screen.getByTestId('error')).toHaveTextContent('connection');
});

it('offline Retry cannot restart the bridge or replay the actual join', async () => {
  await mount(); await confirmBlocks();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  const current = sessions!.getSnapshot();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
  expect(sessions!.getSnapshot()).toBe(current); expect(H.apps).toHaveLength(1); expect(H.gameplayTransactions).toBe(1);
});

it('server denial stays permanent through Retry without rotating a healthy bridge or dealing', async () => {
  H.serverFailure = Object.assign(new Error('denied'), { code: 'permission-denied' });
  await mount(); const current = sessions!.getSnapshot();
  expect(screen.getByTestId('error')).toHaveTextContent('permanent'); expect(H.gameplayTransactions).toBe(0);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
  expect(sessions!.getSnapshot()).toBe(current); expect(H.apps).toHaveLength(1); expect(H.gameplayTransactions).toBe(0);
  expect(screen.getByTestId('error')).toHaveTextContent('permanent');
});

it('healthy gameplay Retry retains recovery quarantine for ordinary captures', async () => {
  H.recovered = false; await mount(); await confirmBlocks();
  const facade = await import('../privateFirestore');
  expect(() => facade.capturePrivateFirestore()).toThrow(/recovery/);
  const current = sessions!.getSnapshot();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
  expect(sessions!.getSnapshot()).toBe(current); expect(H.apps).toHaveLength(1); expect(H.gameplayTransactions).toBe(2);
  expect(() => facade.capturePrivateFirestore()).toThrow(/recovery/);
  expect(screen.getByTestId('blocks')).toHaveTextContent('blocked');
});


it('a failed replacement bridge retires the old lease and blocks until Retry gets a fresh confirmed answer', async () => {
  const view = await mount(); await confirmBlocks(); const oldLease = view.capture();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  H.cloneFailures = 4;
  await act(async () => { sessions!.retry(); await vi.advanceTimersByTimeAsync(3_250); });
  expect(sessions!.getSnapshot()).toMatchObject({ failed: true, retryPending: false });
  expect(() => oldLease.assertCurrent()).toThrow(/expired/);
  expect(screen.getByTestId('blocks')).toHaveTextContent('withheld');
  expect(H.pairListeners[0].stop).toHaveBeenCalledOnce();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
  expect(H.apps).toHaveLength(6); expect(H.gameplayTransactions).toBe(2);
  expect(H.pairListeners).toHaveLength(2); expect(H.drains).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('blocks')).toHaveTextContent('withheld');
  await act(async () => {
    H.pairListeners[0].next({ docs: [{ data: () => ({ uids: ['alice', 'blocked'] }) }], metadata: { fromCache: false, hasPendingWrites: false } });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByTestId('blocks')).toHaveTextContent('withheld');
  await act(async () => {
    H.pairListeners[1].next({ docs: [{ data: () => ({ uids: ['alice', 'new-blocked'] }) }], metadata: { fromCache: false, hasPendingWrites: false } });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByTestId('blocks')).toHaveTextContent('new-blocked');
  expect(() => oldLease.assertCurrent()).toThrow(/expired/);
});

// #1735 pins the current initialized-client contract. Any classified-failure
// rotation change belongs to the pending #1732 decision and its runtime scope.
describe('private reads failing while the bridge remains initialized', () => {
  it.each(['profile', 'attestation'] as const)('gameplay Retry rereads a failing private %s on the same app and lease', async (source) => {
    const error = Object.assign(new Error('controlled private read unavailable'), { code: 'unavailable' });
    if (source === 'profile') H.profileFailure = error; else H.serverFailure = error;
    H.heldJoin = false; const view = await mount();
    const before = sessions!.getSnapshot();
    expect(before).toMatchObject({ uid: 'alice', failed: false });
    expect(before.db).not.toBeNull(); expect(before.db!.app.name).not.toBe('persistent');
    expect(before.db!.app).toBe(H.apps[0]);
    expect(H.profileReads[0].database).toBe(before.db);
    expect(H.profileReads[0].path).toBe('users/alice');
    expect(H.serverReads).toHaveLength(source === 'profile' ? 0 : 1);
    expect(screen.getByTestId('error')).toHaveTextContent('connection');
    expect(H.gameplayTransactions).toBe(0);
    await confirmBlocks(); const lease = view.capture();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot()).toBe(before); expect(H.apps).toHaveLength(1);
    expect(() => lease.assertCurrent()).not.toThrow();
    expect(H.profileReads).toHaveLength(2);
    expect(H.profileReads.every((ref) => ref.database === before.db)).toBe(true);
    expect(H.serverReads).toHaveLength(source === 'profile' ? 0 : 2);
    expect(screen.getByTestId('error')).toHaveTextContent('connection'); expect(H.gameplayTransactions).toBe(0);
    expect(screen.getByTestId('blocks')).toHaveTextContent('blocked');
    expect(H.pairListeners).toHaveLength(1); expect(H.pairListeners[0].stop).not.toHaveBeenCalled();
    expect(H.drains).toHaveBeenCalledTimes(1);
    // Recovery is controlled transport success on this same client, not proof
    // that a native Firestore wedge or a network fault has been repaired.
    H.profileFailure = null; H.serverFailure = null;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot()).toBe(before); expect(H.apps).toHaveLength(1); expect(H.gameplayTransactions).toBe(1);
    expect(H.serverReads.every((ref) => ref.database === before.db)).toBe(true);
    expect(screen.getByTestId('error')).toHaveTextContent('none'); expect(screen.getByTestId('blocks')).toHaveTextContent('blocked');
  });

  it.each(['success', 'denial'] as const)('a private read timeout retains its client and ignores the older %s after Retry succeeds', async (late) => {
    let release!: () => void;
    H.serverSteps = [() => new Promise<void>((resolve, reject) => {
      release = () => late === 'success' ? resolve() : reject(Object.assign(new Error('old private denial'), { code: 'permission-denied' }));
    })];
    H.heldJoin = false; const view = await mount(); const before = sessions!.getSnapshot(); const lease = view.capture();
    expect(before.db).not.toBeNull(); expect(before.failed).toBe(false);
    expect(H.serverReads[0].database).toBe(before.db); expect(H.gameplayTransactions).toBe(0);
    await confirmBlocks();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByTestId('error')).toHaveTextContent('connection'); expect(sessions!.getSnapshot()).toBe(before);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
    expect(H.apps).toHaveLength(1); expect(H.serverReads).toHaveLength(2); expect(H.gameplayTransactions).toBe(1);
    expect(H.serverReads.every((ref) => ref.database === before.db)).toBe(true);
    expect(sessions!.getSnapshot()).toBe(before); expect(() => lease.assertCurrent()).not.toThrow();
    expect(screen.getByTestId('error')).toHaveTextContent('none'); expect(screen.getByTestId('blocks')).toHaveTextContent('blocked');
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot()).toBe(before); expect(H.gameplayTransactions).toBe(1);
    expect(screen.getByTestId('error')).toHaveTextContent('none'); expect(screen.getByTestId('blocks')).toHaveTextContent('blocked');
  });

  it('a late private failure from Alice cannot replace Bob authority or restart his client', async () => {
    let rejectOld!: (error: Error) => void;
    H.serverSteps = [() => new Promise<void>((_resolve, reject) => { rejectOld = reject; })];
    H.heldJoin = false; const view = await mount(); const oldLease = view.capture();
    const bob: Subject = { uid: 'bob', displayName: 'Bob', photoURL: null };
    await act(async () => {
      H.before!(bob); H.primary.currentUser = bob; H.tokenChanged!(bob); H.authChanged!(bob);
      await vi.advanceTimersByTimeAsync(0);
    });
    const current = sessions!.getSnapshot(); const currentLease = view.capture();
    expect(current.uid).toBe('bob'); expect(H.apps).toHaveLength(2); expect(H.gameplayTransactions).toBe(1);
    expect(H.serverReads.at(-1)!.database).toBe(current.db);
    expect(screen.getByTestId('error')).toHaveTextContent('none'); expect(() => oldLease.assertCurrent()).toThrow(/expired/);
    await act(async () => { rejectOld(Object.assign(new Error('late Alice unavailable'), { code: 'unavailable' })); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot()).toBe(current); expect(H.apps).toHaveLength(2); expect(H.gameplayTransactions).toBe(1);
    expect(() => currentLease.assertCurrent()).not.toThrow(); expect(screen.getByTestId('error')).toHaveTextContent('none');
  });

  it('an old Event private completion cannot replace the current Event attempt', async () => {
    let rejectOld!: (error: Error) => void;
    H.serverSteps = [() => new Promise<void>((_resolve, reject) => { rejectOld = reject; })];
    H.heldJoin = false; const view = await mount(); const before = sessions!.getSnapshot();
    await act(async () => { H.eventId = 'event-b'; view.rerender(); await vi.advanceTimersByTimeAsync(0); });
    expect(H.gameplayTransactions).toBe(1); expect(screen.getByTestId('error')).toHaveTextContent('none');
    expect(sessions!.getSnapshot()).toBe(before); expect(H.apps).toHaveLength(1);
    await act(async () => { rejectOld(Object.assign(new Error('late old Event denial'), { code: 'permission-denied' })); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot()).toBe(before); expect(H.apps).toHaveLength(1); expect(H.gameplayTransactions).toBe(1);
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  });

  it('a stale same-UID private completion cannot change the explicitly replaced client or its successful Retry', async () => {
    let rejectOld!: (error: Error) => void;
    H.serverSteps = [() => new Promise<void>((_resolve, reject) => { rejectOld = reject; })];
    H.heldJoin = false; const view = await mount(); const oldLease = view.capture();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const { retryPrivateFirestoreSession } = await import('../privateFirestore');
    // Direct diagnostic invocation of the existing private facade. This does
    // not assert a separate private Retry button exists in the boardless UI.
    await act(async () => { retryPrivateFirestoreSession(); await vi.advanceTimersByTimeAsync(0); });
    const current = sessions!.getSnapshot(); const lease = view.capture();
    expect(current.db).not.toBe(oldLease.db); expect(H.apps).toHaveLength(2);
    expect(() => oldLease.assertCurrent()).toThrow(/expired/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await vi.advanceTimersByTimeAsync(0); });
    expect(H.serverReads.at(-1)!.database).toBe(current.db); expect(H.gameplayTransactions).toBe(1);
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    await act(async () => { rejectOld(Object.assign(new Error('late retired-client denial'), { code: 'permission-denied' })); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot()).toBe(current); expect(H.apps).toHaveLength(2); expect(H.gameplayTransactions).toBe(1);
    expect(() => lease.assertCurrent()).not.toThrow(); expect(screen.getByTestId('error')).toHaveTextContent('none');
  });
});
