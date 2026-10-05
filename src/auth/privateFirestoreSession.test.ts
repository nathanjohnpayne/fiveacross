import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from 'firebase/auth';
import type { FirebaseOptions } from 'firebase/app';

// Named-client lifecycle protocol; real-SDK isolation is covered separately.
// The App Check provider callback is invoked directly so its actual refresh
// schedule and rejection behavior cannot be hidden by a transport mock.
type Subject = { uid: string; token: string };
type App = { name: string; options: FirebaseOptions };
type ClientAuth = { app: App; currentUser: Subject | null };
type ClientDb = { app: App; cache: unknown };
const H = vi.hoisted(() => ({
  primary: { currentUser: { uid: 'alice', token: 'initial' } as Subject | null },
  before: null as ((user: Subject | null) => void) | null,
  abort: null as (() => void) | null,
  idToken: null as ((subject: Subject | null) => void) | null,
  apps: [] as App[], auths: [] as ClientAuth[], dbs: [] as ClientDb[],
  deleted: [] as App[], terminated: [] as ClientDb[],
  clones: [] as Array<{ auth: ClientAuth; subject: Subject }>,
  cloneWaits: [] as Array<() => Promise<void>>,
  terminateWaits: [] as Array<() => Promise<void>>,
  failure: null as 'auth' | 'firestore' | 'app-check' | null,
  providers: [] as Array<{ app: App; getToken: () => Promise<{ token: string; expireTimeMillis: number }>; autoRefresh: boolean }>,
  primaryToken: '', primaryTokenWait: null as Promise<void> | null, recovered: true, online: true, emulators: false,
  tokenCalls: [] as Array<{ app: unknown; force: boolean | undefined }>,
  functionsCalls: [] as Array<{ app: unknown; region: string }>,
}));
vi.mock('firebase/app', () => ({
  initializeApp: (options: FirebaseOptions, name: string) => { const app = { name, options }; H.apps.push(app); return app; },
  deleteApp: async (app: App) => { H.deleted.push(app); },
}));
vi.mock('firebase/auth', () => ({
  inMemoryPersistence: { type: 'NONE' },
  initializeAuth: (app: App, options: { persistence: unknown }) => {
    if (H.failure === 'auth') throw new Error('Auth initialization refused');
    expect(options.persistence).toEqual({ type: 'NONE' });
    const auth = { app, currentUser: null }; H.auths.push(auth); return auth;
  },
  updateCurrentUser: async (auth: ClientAuth, subject: Subject | null) => {
    if (subject) {
      H.clones.push({ auth, subject: { ...subject } });
      const copied = { ...subject };
      await (H.cloneWaits.shift() ?? (() => Promise.resolve()))();
      auth.currentUser = copied;
    } else {
      auth.currentUser = null;
    }
  },
  beforeAuthStateChanged: (_auth: unknown, before: (user: Subject | null) => void, abort: () => void) => {
    H.before = before; H.abort = abort; return vi.fn();
  },
  onIdTokenChanged: (_auth: unknown, callback: (subject: Subject | null) => void) => { H.idToken = callback; return vi.fn(); },
  connectAuthEmulator: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  memoryLocalCache: () => ({ kind: 'memory' }),
  initializeFirestore: (app: App, options: { localCache: unknown }) => {
    if (H.failure === 'firestore') throw new Error('Firestore initialization refused');
    const db = { app, cache: options.localCache }; H.dbs.push(db); return db;
  },
  terminate: async (db: ClientDb) => {
    H.terminated.push(db);
    const wait = H.terminateWaits.shift();
    if (wait) await wait();
  },
  connectFirestoreEmulator: vi.fn(),
}));
vi.mock('firebase/app-check', () => ({
  CustomProvider: class {
    constructor(public options: { getToken: () => Promise<{ token: string; expireTimeMillis: number }> }) {}
  },
  initializeAppCheck: (app: App, options: { provider: { options: { getToken: () => Promise<{ token: string; expireTimeMillis: number }> } }; isTokenAutoRefreshEnabled: boolean }) => {
    if (H.failure === 'app-check') throw new Error('App Check initialization refused');
    H.providers.push({ app, getToken: options.provider.options.getToken, autoRefresh: options.isTokenAutoRefreshEnabled });
  },
  getToken: async (app: unknown, force: boolean | undefined) => { H.tokenCalls.push({ app, force }); if (H.primaryTokenWait) await H.primaryTokenWait; return { token: H.primaryToken }; },
}));
vi.mock('firebase/functions', () => ({
  getFunctions: (app: unknown, region: string) => { H.functionsCalls.push({ app, region }); return { app, region }; },
  connectFunctionsEmulator: vi.fn(),
}));
vi.mock('firebase/storage', () => ({ getStorage: (app: unknown) => ({ app }), connectStorageEmulator: vi.fn() }));
vi.mock('../firebase', () => ({
  auth: H.primary, appCheck: { primary: true }, firebaseConfig: { projectId: 'demo-private', apiKey: 'same-project', appId: 'demo-app' },
  firebaseEmulatorsEnabled: () => H.emulators,
}));
vi.mock('./privateCacheRecoveryMarker', () => ({ privateCacheRecovered: () => H.recovered, privateCacheRecoveryKey: () => 'demo-recovered' }));
import { createPrivateFirestoreSessions } from './privateFirestoreSession';

const options: FirebaseOptions = { projectId: 'demo-private', apiKey: 'same-project', appId: 'demo-app' };
const managers: Array<ReturnType<typeof createPrivateFirestoreSessions>> = [];
function manager(appCheck = false) {
  const value = createPrivateFirestoreSessions({
    primaryAuth: H.primary as unknown as Auth, options, recovered: () => H.recovered, online: () => H.online,
    ...(appCheck ? { appCheckToken: async () => H.primaryToken } : {}),
  });
  managers.push(value); return value;
}
const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
const tokenFor = (exp: unknown) => {
  const payload = btoa(JSON.stringify({ exp, iat: 1_700_000_000 })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.fixture-signature`;
};
beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 }); vi.resetModules();
  H.primary.currentUser = { uid: 'alice', token: 'initial' };
  H.before = null; H.abort = null; H.idToken = null;
  H.apps = []; H.auths = []; H.dbs = []; H.deleted = []; H.terminated = []; H.clones = []; H.cloneWaits = []; H.terminateWaits = [];
  H.failure = null; H.providers = []; H.primaryToken = tokenFor(1_700_000_030); H.primaryTokenWait = null;
  H.recovered = true; H.online = true; H.emulators = false; H.tokenCalls = []; H.functionsCalls = [];
});
afterEach(async () => { managers.splice(0).forEach((value) => value.stop()); await settle(); vi.useRealTimers(); });

describe('private named memory lifecycle', () => {
  it('same-UID token refresh updates Auth without replacing the memory app or retiring leases', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    const old = sessions.capture();
    const refreshed = { uid: 'alice', token: 'refreshed' }; H.primary.currentUser = refreshed;
    H.idToken!(refreshed); expect(() => old.assertCurrent()).not.toThrow(); await settle();
    expect(H.clones.map((clone) => clone.subject.token)).toEqual(['initial', 'refreshed']);
    expect(sessions.capture().db).toBe(old.db);
    expect(sessions.getSnapshot().generation).toBe(old.generation);
    expect(H.apps).toHaveLength(1);
    expect(H.dbs.every((db) => (db.cache as { kind: string }).kind === 'memory')).toBe(true);
    expect(H.auths.every((auth) => auth !== H.primary)).toBe(true);
    expect(H.terminated).not.toContain(old.db);
  });

  it('keeps the Auth incarnation across same-UID offline refresh and reconnect publications', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    const confirmed = sessions.getSnapshot().authGeneration;
    expect(confirmed).toBeGreaterThan(0);
    H.online = false; sessions.refreshConnection();
    expect(sessions.getSnapshot().authGeneration).toBe(confirmed);
    const refreshed = { uid: 'alice', token: 'refreshed' }; H.primary.currentUser = refreshed;
    H.idToken!(refreshed);
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', db: null, transition: 'connection', authGeneration: confirmed });
    H.online = true; sessions.refreshConnection(); await settle();
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', transition: 'connection', authGeneration: confirmed });
    expect(sessions.getSnapshot().db).not.toBeNull();
  });

  it('reconnect creates a client while routine same-UID token refresh keeps it', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    H.online = false; sessions.refreshConnection();
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', db: null, transition: 'connection' });
    H.online = true; sessions.refreshConnection(); await settle();
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', transition: 'connection' });
    const reconnected = sessions.getSnapshot();
    H.idToken!(H.primary.currentUser);
    expect(sessions.getSnapshot()).toBe(reconnected);
    await settle();
    expect(sessions.getSnapshot()).toBe(reconnected);
    sessions.refreshRecovery(); await settle();
    expect(sessions.getSnapshot().transition).toBe('recovery');
  });

  it('serializes overlapping same-UID refreshes and keeps the newest credentials', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    const lease = sessions.capture(); const before = sessions.getSnapshot();
    let release!: () => void;
    H.cloneWaits = [() => new Promise<void>((resolve) => { release = resolve; })];
    H.primary.currentUser = { uid: 'alice', token: 'refresh-one' }; H.idToken!(H.primary.currentUser); await settle();
    H.primary.currentUser = { uid: 'alice', token: 'refresh-two' }; H.idToken!(H.primary.currentUser); await settle();
    expect(sessions.getSnapshot()).toBe(before); expect(H.auths).toHaveLength(1);
    release(); await settle();
    expect(H.auths[0].currentUser?.token).toBe('refresh-two');
    expect(sessions.getSnapshot()).toBe(before); expect(() => lease.assertCurrent()).not.toThrow();
  });

  it('retries a failed bootstrap with the latest same-UID subject rather than stranding the bridge', async () => {
    let reject!: (error: Error) => void;
    H.cloneWaits = [() => new Promise<void>((_resolve, fail) => { reject = fail; })];
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    H.primary.currentUser = { uid: 'alice', token: 'latest' }; H.idToken!(H.primary.currentUser);
    reject(new Error('transient first clone')); await settle();
    expect(sessions.getSnapshot().failed).toBe(true);
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(sessions.capture().uid).toBe('alice'); expect(H.auths.at(-1)?.currentUser?.token).toBe('latest');
    expect(H.apps).toHaveLength(2);
  });

  it('copies a mutable primary User token again when a token callback arrives during bootstrap', async () => {
    let release!: () => void;
    H.cloneWaits = [() => new Promise<void>((resolve) => { release = resolve; })];
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    H.primary.currentUser!.token = 'mutated'; H.idToken!(H.primary.currentUser);
    release(); await settle();
    expect(sessions.capture().uid).toBe('alice'); expect(H.auths[0].currentUser?.token).toBe('mutated');
    expect(H.apps).toHaveLength(1); expect(H.clones.map((clone) => clone.subject.token)).toEqual(['initial', 'mutated']);
  });

  it.each([
    ['token', 'offline'], ['abort', 'offline'], ['token', 'UID mismatch'], ['abort', 'UID mismatch'],
  ] as const)('a %s callback restarts a bootstrap refused %s without a transition publication', async (resume, refusal) => {
    let release!: () => void;
    H.cloneWaits = [() => new Promise<void>((resolve) => { release = resolve; })];
    const sessions = manager(); H.idToken!(H.primary.currentUser);
    await vi.waitFor(() => expect(H.clones).toHaveLength(1));
    const refused = sessions.getSnapshot();
    if (refusal === 'offline') H.online = false;
    else H.primary.currentUser = { uid: 'bob', token: 'unpublished' };
    release();
    await vi.waitFor(() => expect(H.deleted).toContain(H.apps[0]));
    expect(sessions.getSnapshot()).toBe(refused);
    expect(sessions.getSnapshot()).toMatchObject({ db: null, failed: false, retryPending: false });
    H.online = true; H.primary.currentUser = { uid: 'alice', token: 'latest' };
    if (resume === 'token') H.idToken!(H.primary.currentUser);
    else H.abort!();
    expect(H.apps).toHaveLength(2);
    await vi.waitFor(() => expect(sessions.getSnapshot().db).toBe(H.dbs[1]));
    expect(sessions.capture().uid).toBe('alice');
    expect(H.auths[1].currentUser?.token).toBe('latest');
  });

  it('old candidate disposal cannot clear a newer held same-UID bootstrap', async () => {
    let releaseOld!: () => void; let releaseNew!: () => void; let disposeOld!: () => void;
    H.cloneWaits = [
      () => new Promise<void>((resolve) => { releaseOld = resolve; }),
      () => new Promise<void>((resolve) => { releaseNew = resolve; }),
    ];
    H.terminateWaits = [() => new Promise<void>((resolve) => { disposeOld = resolve; })];
    const sessions = manager(); H.idToken!(H.primary.currentUser);
    await vi.waitFor(() => expect(H.clones).toHaveLength(1));
    H.online = false; releaseOld();
    await vi.waitFor(() => expect(H.terminated).toContain(H.dbs[0]));
    H.online = true; H.primary.currentUser = { uid: 'alice', token: 'new-bootstrap' };
    H.idToken!(H.primary.currentUser);
    expect(H.apps).toHaveLength(2);
    await vi.waitFor(() => expect(H.clones).toHaveLength(2));
    const initializing = sessions.getSnapshot();
    disposeOld(); await vi.waitFor(() => expect(H.deleted).toContain(H.apps[0]));
    expect(sessions.getSnapshot()).toBe(initializing);
    expect(sessions.getSnapshot().db).toBeNull();
    H.primary.currentUser = { uid: 'alice', token: 'latest' }; H.idToken!(H.primary.currentUser); H.abort!();
    expect(H.apps).toHaveLength(2);
    releaseNew(); await vi.waitFor(() => expect(sessions.getSnapshot().db).toBe(H.dbs[1]));
    expect(sessions.capture().uid).toBe('alice'); expect(H.auths[1].currentUser?.token).toBe('latest');
    expect(H.deleted).toEqual([H.apps[0]]);
  });

  it('superseded bootstrap cleanup cannot clear a newer held account initialization', async () => {
    let releaseOld!: () => void; let releaseNew!: () => void; let disposeOld!: () => void;
    H.cloneWaits = [
      () => new Promise<void>((resolve) => { releaseOld = resolve; }),
      () => new Promise<void>((resolve) => { releaseNew = resolve; }),
    ];
    H.terminateWaits = [() => new Promise<void>((resolve) => { disposeOld = resolve; })];
    const sessions = manager(); H.idToken!(H.primary.currentUser);
    await vi.waitFor(() => expect(H.clones).toHaveLength(1));
    H.before!({ uid: 'bob', token: 'new-bootstrap' });
    H.primary.currentUser = { uid: 'bob', token: 'new-bootstrap' }; H.idToken!(H.primary.currentUser);
    await vi.waitFor(() => expect(H.clones).toHaveLength(2));
    const initializing = sessions.getSnapshot();
    releaseOld(); await vi.waitFor(() => expect(H.terminated).toContain(H.dbs[0]));
    H.idToken!(H.primary.currentUser); H.abort!(); expect(H.apps).toHaveLength(2);
    disposeOld(); await vi.waitFor(() => expect(H.deleted).toContain(H.apps[0]));
    expect(sessions.getSnapshot()).toBe(initializing);
    H.primary.currentUser = { uid: 'bob', token: 'latest' }; H.idToken!(H.primary.currentUser); H.abort!();
    expect(H.apps).toHaveLength(2);
    releaseNew(); await vi.waitFor(() => expect(sessions.getSnapshot().db).toBe(H.dbs[1]));
    expect(sessions.capture().uid).toBe('bob'); expect(H.auths[1].currentUser?.token).toBe('latest');
    expect(H.deleted).toEqual([H.apps[0]]);
  });

  it.each(['copy', 'disposal'] as const)('stop prevents a held %s from reviving bootstrap', async (stage) => {
    let release!: () => void; let disposeOld!: () => void;
    H.cloneWaits = [() => new Promise<void>((resolve) => { release = resolve; })];
    H.terminateWaits = [() => new Promise<void>((resolve) => { disposeOld = resolve; })];
    const sessions = manager(); H.idToken!(H.primary.currentUser);
    await vi.waitFor(() => expect(H.clones).toHaveLength(1));
    if (stage === 'copy') sessions.stop();
    else H.online = false;
    release(); await vi.waitFor(() => expect(H.terminated).toContain(H.dbs[0]));
    if (stage === 'disposal') sessions.stop();
    const stopped = sessions.getSnapshot();
    H.online = true; H.primary.currentUser = { uid: 'alice', token: 'latest' };
    H.idToken!(H.primary.currentUser); H.abort!();
    disposeOld(); await vi.waitFor(() => expect(H.deleted).toContain(H.apps[0]));
    expect(H.apps).toHaveLength(1); expect(sessions.getSnapshot()).toBe(stopped);
    expect(sessions.getSnapshot().db).toBeNull(); expect(() => sessions.capture()).toThrow(/expired/);
  });

  it('a refresh held across account retirement cannot publish into the replacement actor', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    const old = sessions.capture(); let release!: () => void;
    H.cloneWaits = [() => new Promise<void>((resolve) => { release = resolve; })];
    H.primary.currentUser = { uid: 'alice', token: 'refresh' }; H.idToken!(H.primary.currentUser); await settle();
    H.before!({ uid: 'bob', token: 'bob' }); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser); await settle();
    const bob = sessions.getSnapshot(); release(); await settle();
    expect(sessions.getSnapshot()).toBe(bob); expect(sessions.capture().uid).toBe('bob');
    expect(() => old.assertCurrent()).toThrow(/expired/); expect(H.terminated).toContain(old.db);
  });

  it('same-UID before-state acceptance and abort leave a healthy client unchanged', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    const before = sessions.getSnapshot(); const lease = sessions.capture();
    H.before!({ uid: 'alice', token: 'candidate' }); H.abort!(); await settle();
    expect(sessions.getSnapshot()).toBe(before); expect(H.apps).toHaveLength(1);
    expect(() => lease.assertCurrent()).not.toThrow();
  });

  it('restores the current account after overlapping different-UID and same-UID middleware aborts', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    const old = sessions.capture();
    H.before!({ uid: 'bob', token: 'candidate-bob' });
    H.before!(H.primary.currentUser); H.abort!(); await settle();
    expect(sessions.capture().uid).toBe('alice'); expect(H.apps).toHaveLength(2);
    expect(sessions.capture().db).not.toBe(old.db); expect(() => old.assertCurrent()).toThrow(/expired/);
  });

  it('a delayed old Auth clone cannot replace a newer account session', async () => {
    let release!: () => void; H.cloneWaits = [() => new Promise<void>((resolve) => { release = resolve; })];
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    H.before!({ uid: 'bob', token: 'bob' }); H.primary.currentUser = { uid: 'bob', token: 'bob-token' }; H.idToken!(H.primary.currentUser); await settle();
    const current = sessions.capture(); release(); await settle();
    expect(sessions.capture().db).toBe(current.db); expect(sessions.getSnapshot().uid).toBe('bob');
    expect(H.deleted).toContain(H.apps[0]);
  });

  it.each(['auth', 'firestore', 'app-check'] as const)('%s initialization failure publishes no private DB and disposes its app', async (failure) => {
    H.failure = failure; const sessions = manager(true); H.idToken!(H.primary.currentUser); await settle();
    expect(sessions.getSnapshot()).toMatchObject({ db: null, failed: true });
    expect(() => sessions.capture()).toThrow(/expired/); expect(H.deleted).toEqual(H.apps);
  });

  it('Auth clone refusal does not expose a partially initialized memory client', async () => {
    H.cloneWaits = [() => Promise.reject(new Error('invalid-user-token'))];
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    expect(sessions.getSnapshot()).toMatchObject({ db: null, failed: true });
    expect(H.terminated).toEqual(H.dbs); expect(H.deleted).toEqual(H.apps);
  });

  it('offline retains the subject but no DB; a resumed operation rejects on retirement', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle(); const lease = sessions.capture();
    let release!: () => void; const operation = lease.guard(() => new Promise<void>((resolve) => { release = resolve; }));
    const rejection = expect(operation).rejects.toThrow(/expired/);
    H.online = false; sessions.refreshConnection(); expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', db: null });
    release(); await rejection; expect(() => sessions.capture()).toThrow(/expired/);
  });

  it('recovery permits only explicit own-memory bootstrap, never ordinary private UI', async () => {
    H.recovered = false; const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    expect(() => sessions.capture()).toThrow(/recovery/); expect(sessions.capture(true).uid).toBe('alice');
  });
});

describe('bounded private bridge retries', () => {
  it.each(['auth', 'firestore', 'app-check'] as const)('recovers transient %s initialization without a token or connection event', async (failure) => {
    H.failure = failure; const sessions = manager(true); H.idToken!(H.primary.currentUser); await settle();
    expect(sessions.getSnapshot().failed).toBe(true);
    const failedGeneration = sessions.getSnapshot().authGeneration;
    H.failure = null; await vi.advanceTimersByTimeAsync(249);
    expect(sessions.getSnapshot().db).toBeNull();
    await vi.advanceTimersByTimeAsync(1); await settle();
    expect(sessions.getSnapshot().db).not.toBeNull();
    expect(H.apps).toHaveLength(2); expect(H.deleted).toContain(H.apps[0]);
    expect(sessions.getSnapshot().authGeneration).toBeGreaterThan(failedGeneration);
  });

  it('retries a refused Auth clone with a fresh client and permanently expires the earlier lease', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle(); const old = sessions.capture();
    H.cloneWaits = [() => Promise.reject(new Error('transient refresh')), () => Promise.reject(new Error('transient clone'))];
    H.idToken!(H.primary.currentUser); await settle();
    expect(sessions.getSnapshot().failed).toBe(true);
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(sessions.capture().db).not.toBe(old.db); expect(() => old.assertCurrent()).toThrow(/expired/);
    expect(H.apps).toHaveLength(3); expect(H.deleted).toContain(H.apps[1]); expect(H.terminated).toContain(H.dbs[1]);
  });

  it('stops after three backed-off retries until a new connection episode', async () => {
    H.failure = 'auth'; const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    await vi.advanceTimersByTimeAsync(250); expect(H.apps).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999); expect(H.apps).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(H.apps).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2000); expect(H.apps).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000); expect(H.apps).toHaveLength(4);
    expect(sessions.getSnapshot()).toMatchObject({ db: null, failed: true }); expect(H.deleted).toEqual(H.apps);
    H.failure = null; sessions.refreshConnection(); await settle(); expect(sessions.capture().uid).toBe('alice');
    expect(H.apps).toHaveLength(5);
  });

  it('explicit Retry recovers an exhausted bridge with a fresh credential incarnation', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    const old = sessions.capture(); const priorAuth = sessions.getSnapshot().authGeneration;
    H.failure = 'auth'; sessions.retry(); await settle();
    await vi.advanceTimersByTimeAsync(3_250); await settle();
    expect(sessions.getSnapshot().failed).toBe(true);
    const attempts = H.apps.length; H.failure = null; sessions.retry(); await settle();
    expect(H.apps).toHaveLength(attempts + 1);
    expect(sessions.capture().uid).toBe('alice');
    expect(sessions.getSnapshot().authGeneration).toBeGreaterThan(priorAuth);
    expect(() => old.assertCurrent()).toThrow(/expired/);
    let sameAccountError: unknown;
    try { old.assertCurrent(); } catch (error) { sameAccountError = error; }
    expect(sameAccountError).toBeInstanceOf(Error);
    expect(sameAccountError).toMatchObject({ code: 'unavailable' });
    H.primary.currentUser = { uid: 'bob', token: 'changed' };
    let changedAccountError: unknown;
    try { old.assertCurrent(); } catch (error) { changedAccountError = error; }
    expect(changedAccountError).toBeInstanceOf(Error);
    expect(changedAccountError).not.toHaveProperty('code');
  });

  it.each(['account', 'offline', 'stop'] as const)('cancels a pending retry on %s retirement', async (reason) => {
    H.failure = 'auth'; const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    H.failure = null;
    if (reason === 'account') { H.before!({ uid: 'bob', token: 'bob' }); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser); }
    if (reason === 'offline') { H.online = false; sessions.refreshConnection(); }
    if (reason === 'stop') sessions.stop();
    await settle(); const apps = H.apps.length;
    await vi.advanceTimersByTimeAsync(10_000); expect(H.apps).toHaveLength(apps);
    if (reason === 'account') expect(sessions.capture().uid).toBe('bob');
    else expect(() => sessions.capture()).toThrow(/expired/);
  });

  it('does not retry when the captured UID changed without a publication', async () => {
    H.failure = 'auth'; const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    H.failure = null; H.primary.currentUser = { uid: 'bob', token: 'new-token' };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(H.apps).toHaveLength(1); expect(() => sessions.capture()).toThrow(/expired/);
  });

  it('a late failed retry cannot publish failure or schedule work over a newer account', async () => {
    H.cloneWaits = [() => Promise.reject(new Error('transient'))];
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    let reject!: (error: Error) => void;
    H.cloneWaits = [() => new Promise<void>((_resolve, fail) => { reject = fail; })];
    await vi.advanceTimersByTimeAsync(250);
    H.before!({ uid: 'bob', token: 'bob' }); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser); await settle();
    const bob = sessions.capture(); reject(new Error('late old failure')); await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(H.apps).toHaveLength(3); expect(sessions.capture().db).toBe(bob.db);
    expect(sessions.getSnapshot().failed).toBe(false); expect(H.deleted).toContain(H.apps[1]);
  });

  it('rejects a late retry clone after the account changed, even when its old promise succeeds', async () => {
    H.cloneWaits = [() => Promise.reject(new Error('transient'))];
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    let release!: () => void; H.cloneWaits = [() => new Promise<void>((resolve) => { release = resolve; })];
    await vi.advanceTimersByTimeAsync(250); expect(H.apps).toHaveLength(2);
    H.before!({ uid: 'bob', token: 'bob' }); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser); await settle();
    const bob = sessions.capture(); release(); await settle();
    expect(sessions.capture().db).toBe(bob.db); expect(H.deleted).toContain(H.apps[1]); expect(H.terminated).toContain(H.dbs[1]);
  });
});

describe('private facade scheduled bootstrap readiness (#1675)', () => {
  it('keeps gameplay bootstrap waiting through a first clone failure and captures scheduled success once', async () => {
    H.cloneWaits = [() => Promise.reject(new Error('transient first clone'))];
    const wrapper = await import('../privateFirestore');
    const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
    let outcome = 'pending';
    const waiting = wrapper.awaitPrivateFirestore('alice', true);
    void waiting.then(() => { outcome = 'ready'; }, () => { outcome = 'failed'; });
    H.idToken!(H.primary.currentUser);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getSnapshot().failed).toBe(true);
    expect(outcome).toBe('pending');
    expect(H.functionsCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    const lease = await waiting;
    expect(lease.db).toBe(H.dbs[1]);
    expect(lease.uid).toBe('alice');
    expect(H.functionsCalls).toEqual([{ app: H.apps[1], region: 'us-central1' }]);
    expect(outcome).toBe('ready');
  });

  it('also recovers a bootstrap arriving after the failed publication', async () => {
    H.cloneWaits = [() => Promise.reject(new Error('transient first clone'))];
    const wrapper = await import('../privateFirestore');
    const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
    H.idToken!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getSnapshot()).toMatchObject({ failed: true, retryPending: true });
    const waiting = wrapper.awaitPrivateFirestore('alice', true);
    await vi.advanceTimersByTimeAsync(250);
    expect((await waiting).db).toBe(H.dbs[1]);
  });

  it('exhausts the scheduled episode promptly and leaves explicit Retry available', async () => {
    H.failure = 'auth';
    const wrapper = await import('../privateFirestore');
    const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
    const waiting = wrapper.awaitPrivateFirestore('alice', true);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
    H.idToken!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_250); await rejected;
    expect(sessions.getSnapshot()).toMatchObject({ failed: true, retryPending: false });
    expect(H.apps).toHaveLength(4); expect(vi.getTimerCount()).toBe(0);
    expect(H.functionsCalls).toHaveLength(0);
    H.failure = null; wrapper.retryPrivateFirestoreSession();
    await vi.advanceTimersByTimeAsync(0);
    expect((await wrapper.awaitPrivateFirestore('alice', true)).uid).toBe('alice');
  });

  it.each(['offline', 'account'] as const)('a current retry refused by an unannounced %s change exhausts readiness promptly', async (boundary) => {
    const originalOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    try {
      H.failure = 'auth'; const wrapper = await import('../privateFirestore');
      const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
      const waiting = wrapper.awaitPrivateFirestore('alice', true).then(() => null, (error: unknown) => error);
      H.idToken!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0);
      const failed = sessions.getSnapshot();
      expect(failed).toMatchObject({ failed: true, retryPending: true });
      if (boundary === 'offline') Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      else H.primary.currentUser = { uid: 'bob', token: 'bob' };
      // Deliberately omit connection/Auth publication before the scheduled callback.
      await vi.advanceTimersByTimeAsync(250);
      expect(sessions.getSnapshot()).toEqual({ ...failed, retryPending: false });
      if (boundary === 'offline') expect(await waiting).toMatchObject({ code: 'unavailable' });
      else expect(await waiting).toMatchObject({ message: 'Private session changed.' });
      expect(vi.getTimerCount()).toBe(0); expect(H.apps).toHaveLength(1); expect(H.functionsCalls).toHaveLength(0);
      await expect(wrapper.awaitPrivateFirestore(H.primary.currentUser!.uid, true)).rejects.toMatchObject({ code: 'unavailable' });
      expect(vi.getTimerCount()).toBe(0); expect(H.functionsCalls).toHaveLength(0);
      H.failure = null; Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      wrapper.retryPrivateFirestoreSession(); await vi.advanceTimersByTimeAsync(0);
      expect((await wrapper.awaitPrivateFirestore(H.primary.currentUser!.uid, true)).uid).toBe(H.primary.currentUser!.uid);
      expect(H.apps).toHaveLength(2);
    } finally {
      if (originalOnline) Object.defineProperty(navigator, 'onLine', originalOnline);
      else Reflect.deleteProperty(navigator, 'onLine');
    }
  });

  it.each(['failed', 'ready', 'recovery', 'stop'] as const)('an obsolete retry callback cannot change a newer %s scope or its timer', async (state) => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      H.failure = 'auth'; const wrapper = await import('../privateFirestore');
      const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
      H.idToken!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0);
      const oldRetry = timers.mock.calls.find(([, delay]) => delay === 250)?.[0];
      if (typeof oldRetry !== 'function') throw new Error('Scheduled retry was not captured');
      if (state === 'stop') sessions.stop();
      else {
        if (state !== 'failed') H.failure = null;
        if (state === 'recovery') { H.recovered = false; sessions.refreshRecovery(); }
        else sessions.retry();
        await vi.advanceTimersByTimeAsync(0);
      }
      const current = sessions.getSnapshot(); const apps = H.apps.length;
      expect(current.retryPending).toBe(state === 'failed');
      expect(vi.getTimerCount()).toBe(state === 'failed' ? 1 : 0);
      oldRetry(); await vi.advanceTimersByTimeAsync(0);
      expect(sessions.getSnapshot()).toBe(current); expect(H.apps).toHaveLength(apps); expect(H.functionsCalls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(state === 'failed' ? 1 : 0);
      sessions.stop(); expect(vi.getTimerCount()).toBe(0);
    } finally { timers.mockRestore(); }
  });

  it('keeps one absolute five-second deadline and never captures a late successful retry', async () => {
    let release!: () => void;
    H.cloneWaits = [() => Promise.reject(new Error('transient')), () => new Promise<void>((resolve) => { release = resolve; })];
    const wrapper = await import('../privateFirestore');
    const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
    const waiting = wrapper.awaitPrivateFirestore('alice', true);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
    let outcome = 'pending'; void waiting.catch(() => { outcome = 'failed'; });
    H.idToken!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_999); expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1); await rejected;
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getSnapshot().db).toBe(H.dbs[1]);
    expect(H.functionsCalls).toHaveLength(0); expect(outcome).toBe('failed');
  });

  it('rejects an old actor while a retry is held without binding services to the new account', async () => {
    let release!: () => void;
    H.cloneWaits = [() => Promise.reject(new Error('transient')), () => new Promise<void>((resolve) => { release = resolve; })];
    const wrapper = await import('../privateFirestore');
    const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
    const waiting = wrapper.awaitPrivateFirestore('alice', true);
    const rejected = expect(waiting).rejects.toThrow(/changed/);
    H.idToken!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    H.before!({ uid: 'bob', token: 'bob' }); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser);
    await vi.advanceTimersByTimeAsync(0); await rejected;
    const bob = sessions.capture(); release(); await vi.advanceTimersByTimeAsync(0);
    expect(sessions.capture().db).toBe(bob.db); expect(H.functionsCalls).toHaveLength(0);
  });

  it('scheduled success preserves recovery quarantine while own gameplay bootstrap may capture', async () => {
    H.recovered = false; H.cloneWaits = [() => Promise.reject(new Error('transient'))];
    const wrapper = await import('../privateFirestore');
    const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
    const ordinary = wrapper.awaitPrivateFirestore('alice');
    const refused = expect(ordinary).rejects.toThrow(/recovery/);
    const bootstrap = wrapper.awaitPrivateFirestore('alice', true);
    H.idToken!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250); await refused;
    expect((await bootstrap).db).toBe(H.dbs[1]);
    expect(sessions.getSnapshot().recoveryRequired).toBe(true);
    expect(H.functionsCalls).toHaveLength(1);
  });

  it.each(['offline', 'stop'] as const)('%s retirement cancels scheduled work and the bounded wait cannot capture', async (retirement) => {
    const originalOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    try {
      H.failure = 'auth'; const wrapper = await import('../privateFirestore');
      const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
      const waiting = wrapper.awaitPrivateFirestore('alice', true);
      const rejected = expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
      H.idToken!(H.primary.currentUser); await vi.advanceTimersByTimeAsync(0);
      H.failure = null;
      if (retirement === 'offline') {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); sessions.refreshConnection();
      } else sessions.stop();
      await vi.advanceTimersByTimeAsync(5_000); await rejected;
      expect(H.apps).toHaveLength(1); expect(H.functionsCalls).toHaveLength(0);
    } finally {
      if (originalOnline) Object.defineProperty(navigator, 'onLine', originalOnline);
      else Reflect.deleteProperty(navigator, 'onLine');
    }
  });
});

describe('forwarded primary App Check', () => {
  it('preserves the signed token expiration rather than extending it by a minute', async () => {
    const sessions = manager(true); H.idToken!(H.primary.currentUser); await settle();
    expect(H.providers[0].app).toBe(H.apps[0]); expect(H.providers[0].autoRefresh).toBe(false);
    expect(await H.providers[0].getToken()).toEqual({ token: H.primaryToken, expireTimeMillis: 1_700_000_030_000 });
    sessions.stop();
  });

  it.each(['not-a-jwt', 'header.not-json.signature', tokenFor(undefined), tokenFor(1_700_000_000.5), tokenFor(null), tokenFor('1700000030'), tokenFor(1_700_000_000), tokenFor(1_699_999_999), tokenFor(Number.MAX_SAFE_INTEGER)])('refuses malformed or expired scheduling metadata without inventing authority (%s)', async (token) => {
    H.primaryToken = token; manager(true); H.idToken!(H.primary.currentUser); await settle();
    await expect(H.providers[0].getToken()).rejects.toThrow(/App Check/);
  });


  it('a primary token refresh is forwarded with its new deadline on the same UID', async () => {
    const wrapper = await import('../privateFirestore'); const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
    H.idToken!(H.primary.currentUser); await settle();
    const old = await H.providers[0].getToken();
    H.primaryToken = tokenFor(1_700_000_090);
    H.primary.currentUser = { uid: 'alice', token: 'refreshed' }; H.idToken!(H.primary.currentUser); await settle();
    const refreshed = await H.providers[0].getToken();
    expect(H.providers).toHaveLength(1);
    expect(refreshed).toEqual({ token: H.primaryToken, expireTimeMillis: 1_700_000_090_000 });
    expect(refreshed.token).not.toBe(old.token);
    expect(H.tokenCalls.every((call) => call.force === false)).toBe(true);
  });

  it('a delayed attestation cannot acknowledge an operation on a retired named session', async () => {
    const wrapper = await import('../privateFirestore'); const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
    H.idToken!(H.primary.currentUser); await settle(); const lease = wrapper.capturePrivateFirestore();
    let release!: () => void; H.primaryTokenWait = new Promise<void>((resolve) => { release = resolve; });
    const operation = lease.guard(() => H.providers[0].getToken());
    const rejected = expect(operation).rejects.toThrow(/expired/);
    H.before!({ uid: 'bob', token: 'bob' }); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser); await settle();
    release(); await rejected;
    expect(sessions.getSnapshot().uid).toBe('bob');
    // Project attestation is not account authority or cancellation of a sent request.
    expect(H.tokenCalls).toEqual([{ app: { primary: true }, force: false }]);
  });
  it('named Functions transport uses the same memory app and forwards the primary attestation without another CAPTCHA', async () => {
    const wrapper = await import('../privateFirestore'); const sessions = wrapper.privateFirestoreSessions(); managers.push(sessions);
    H.idToken!(H.primary.currentUser); await settle();
    const lease = wrapper.capturePrivateFirestore();
    expect(H.functionsCalls).toEqual([{ app: lease.db.app, region: 'us-central1' }]);
    expect(await H.providers[0].getToken()).toMatchObject({ token: H.primaryToken });
    expect(H.tokenCalls).toEqual([{ app: { primary: true }, force: false }]);
    expect(H.providers).toHaveLength(1);
  });
});
