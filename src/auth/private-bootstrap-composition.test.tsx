import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Subject = { uid: string; displayName: string; photoURL: null };
type App = { name: string };
type Database = { app: App };
type Ref = { database: Database; path: string };
const H = vi.hoisted(() => ({
  primary: { currentUser: { uid: 'alice', displayName: 'Alice', photoURL: null } as Subject | null },
  eventId: 'event-a', recovered: true,
  before: null as ((next: Subject | null) => void) | null,
  authChanged: null as ((next: Subject | null) => void) | null,
  tokenChanged: null as ((next: Subject | null) => void) | null,
  cloneFailures: 0, cloneSteps: [] as Array<() => Promise<void>>,
  apps: [] as App[], services: [] as App[], profileReads: [] as Ref[], serverReads: [] as Ref[],
  serverFailure: null as Error | null,
  serverSteps: [] as Array<() => Promise<void>>,
  join: vi.fn(),
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
  const snapshot = { exists: () => true, data: () => ({ attestedAdultAt: 123 }) };
  return { ...actual,
    initializeFirestore: (app: App) => ({ app }), memoryLocalCache: () => ({ memory: true }), terminate: vi.fn(async () => {}),
    doc: (database: Database, ...parts: string[]) => ({ database, path: parts.join('/'), withConverter() { return this; } }),
    runTransaction: async (database: Database, operation: (tx: unknown) => Promise<unknown>) => {
      expect(database.app.name).not.toBe('persistent');
      return operation({ get: async (ref: Ref) => { H.profileReads.push(ref); return snapshot; }, set: vi.fn() });
    },
    getDocFromServer: async (ref: Ref) => {
      expect(ref.database.app.name).not.toBe('persistent'); H.serverReads.push(ref);
      await (H.serverSteps.shift() ?? (() => Promise.resolve()))();
      if (H.serverFailure) throw H.serverFailure;
      return snapshot;
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
// Unrelated content subscriptions are outside this readiness seam. Profile
// bootstrap, server attestation, AuthProvider, facade and manager remain real.
vi.mock('../hooks/useBlocks', () => ({ HiddenUidsProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../components/ConfirmWinMoments', () => ({ default: () => null }));
vi.mock('../components/RetractWinMoments', () => ({ default: () => null }));
vi.mock('../components/PoolRecoveryWatcher', () => ({ default: () => null }));
vi.mock('../components/AdultContentWatcher', () => ({ default: () => null }));

let sessions: ReturnType<typeof import('../privateFirestore')['privateFirestoreSessions']> | null = null;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear();
  // Re-register the partial factory too: resetModules does not clear a mock's
  // exports, and cached real API methods would retain the prior stopped facade.
  vi.doMock('../data/api', async (original) => ({
    ...await original<typeof import('../data/api')>(),
    joinAndDeal: (...args: unknown[]) => H.join(...args),
    hasCachedCard: async () => false, hasCachedBoard: async () => false,
  }));
  H.primary.currentUser = { uid: 'alice', displayName: 'Alice', photoURL: null };
  H.eventId = 'event-a'; H.recovered = true; H.before = null; H.authChanged = null; H.tokenChanged = null;
  H.cloneFailures = 0; H.cloneSteps = []; H.apps = []; H.services = []; H.profileReads = []; H.serverReads = []; H.serverFailure = null;
  H.serverSteps = [];
  H.join.mockResolvedValue(true);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, callback: (lock: { name: string }) => unknown) => callback({ name: 'fixture' }),
  } });
});
afterEach(async () => { cleanup(); sessions?.stop(); sessions = null; await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); });

async function mount() {
  const { AuthProvider, useAuth } = await import('./AuthContext');
  const { privateFirestoreSessions } = await import('../privateFirestore');
  function Probe() {
    const auth = useAuth();
    return <div>
      <output data-testid="status">{auth.loading ? 'loading' : auth.profileReady ? 'profile-ready' : 'waiting'}</output>
      <output data-testid="error">{auth.dealErrorReason ?? 'none'}</output>
      <button onClick={auth.retryDeal}>Retry</button>
    </div>;
  }
  const view = render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { H.authChanged!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0); });
  sessions = privateFirestoreSessions();
  return { ...view, refresh: () => view.rerender(<AuthProvider><Probe /></AuthProvider>) };
}

describe('real Auth bootstrap across scheduled private retries (#1675)', () => {
  it('a boardless Player recovers from the first bridge failure without pressing Retry', async () => {
    H.cloneFailures = 1; await mount();
    expect(sessions!.getSnapshot().failed).toBe(true);
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    expect(screen.getByTestId('error')).toHaveTextContent('none'); expect(H.join).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByTestId('status')).toHaveTextContent('profile-ready');
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    expect(H.profileReads.map((ref) => ref.path)).toEqual(['users/alice']);
    expect(H.serverReads.map((ref) => ref.path)).toEqual(['users/alice']);
    expect(H.profileReads[0].database).toBe(sessions!.getSnapshot().db);
    expect(H.join).toHaveBeenCalledExactlyOnceWith(H.primary.currentUser, 'event-a');
  });

  it('exhaustion exposes connection Retry and the explicit new episode recovers gameplay', async () => {
    H.cloneFailures = 4; await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_250); });
    expect(screen.getByTestId('error')).toHaveTextContent('connection');
    expect(sessions!.getSnapshot()).toMatchObject({ failed: true, retryPending: false });
    expect(H.join).not.toHaveBeenCalled(); expect(H.profileReads).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    expect(H.join).toHaveBeenCalledExactlyOnceWith(H.primary.currentUser, 'event-a');
    expect(H.apps).toHaveLength(5);
  });

  it('a server denial after bridge recovery remains permanent and never authorizes a deal', async () => {
    H.cloneFailures = 1; H.serverFailure = Object.assign(new Error('denied'), { code: 'permission-denied' });
    await mount(); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByTestId('error')).toHaveTextContent('permanent');
    expect(H.serverReads).toHaveLength(1); expect(H.join).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_250); });
    expect(H.apps).toHaveLength(2); expect(H.join).not.toHaveBeenCalled();
    expect(sessions!.getSnapshot().failed).toBe(false);
  });

  it('retirement after capturing server authority refuses its late stamp rather than acquiring the new client', async () => {
    H.cloneFailures = 1; let release!: () => void;
    H.serverSteps = [() => new Promise<void>((resolve) => { release = resolve; })];
    await mount(); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(H.serverReads).toHaveLength(1);
    const capturedDb = H.serverReads[0].database;
    await act(async () => { sessions!.retry(); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot().db).not.toBe(capturedDb);
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('error')).toHaveTextContent('connection'); expect(H.join).not.toHaveBeenCalled();
    // Profile creation and server attestation each bind Functions once.
    expect(H.services).toHaveLength(2);
    expect(H.services.every((app) => app === capturedDb.app)).toBe(true);
  });

  it('sign-out during a held retry prevents the late old client from bootstrapping or dealing', async () => {
    H.cloneFailures = 1; let release!: () => void;
    H.cloneSteps = [() => new Promise<void>((resolve) => { release = resolve; })];
    await mount(); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => {
      H.before!(null); H.primary.currentUser = null; H.authChanged!(null);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(5_000); });
    expect(H.profileReads).toHaveLength(0); expect(H.serverReads).toHaveLength(0); expect(H.join).not.toHaveBeenCalled();
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  });

  it('the readiness deadline exposes Retry and later bridge success does not replay the timed-out bootstrap', async () => {
    H.cloneFailures = 1; let release!: () => void;
    H.cloneSteps = [() => new Promise<void>((resolve) => { release = resolve; })];
    await mount(); await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByTestId('error')).toHaveTextContent('connection');
    expect(H.profileReads).toHaveLength(0); expect(H.join).not.toHaveBeenCalled();
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(sessions!.getSnapshot().db).not.toBeNull();
    expect(screen.getByTestId('error')).toHaveTextContent('connection');
    expect(H.profileReads).toHaveLength(0); expect(H.join).not.toHaveBeenCalled();
  });

  it('a late old-UID retry cannot authorize the replacement account or erase its denial', async () => {
    H.cloneFailures = 1; let release!: () => void;
    H.cloneSteps = [() => new Promise<void>((resolve) => { release = resolve; })];
    await mount(); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const bob: Subject = { uid: 'bob', displayName: 'Bob', photoURL: null };
    H.serverFailure = Object.assign(new Error('denied'), { code: 'permission-denied' });
    await act(async () => {
      H.before!(bob); H.primary.currentUser = bob; H.tokenChanged!(bob); H.authChanged!(bob);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('error')).toHaveTextContent('permanent');
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(H.profileReads.map((ref) => ref.path)).toEqual(['users/bob']);
    expect(H.serverReads.map((ref) => ref.path)).toEqual(['users/bob']);
    expect(H.join).not.toHaveBeenCalled(); expect(screen.getByTestId('error')).toHaveTextContent('permanent');
  });

  it('an Event change during a held retry admits only the fresh Event bootstrap', async () => {
    H.cloneFailures = 1; let release!: () => void;
    H.cloneSteps = [() => new Promise<void>((resolve) => { release = resolve; })];
    const view = await mount(); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => { H.eventId = 'event-b'; view.refresh(); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(H.join).toHaveBeenCalledExactlyOnceWith(H.primary.currentUser, 'event-b');
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  });
});
