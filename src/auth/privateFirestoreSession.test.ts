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
  before: null as (() => void) | null,
  abort: null as (() => void) | null,
  idToken: null as ((subject: Subject | null) => void) | null,
  apps: [] as App[], auths: [] as ClientAuth[], dbs: [] as ClientDb[],
  deleted: [] as App[], terminated: [] as ClientDb[],
  clones: [] as Array<{ auth: ClientAuth; subject: Subject }>,
  cloneWaits: [] as Array<() => Promise<void>>,
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
      H.clones.push({ auth, subject });
      await (H.cloneWaits.shift() ?? (() => Promise.resolve()))();
    }
    auth.currentUser = subject;
  },
  beforeAuthStateChanged: (_auth: unknown, before: () => void, abort: () => void) => {
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
  terminate: async (db: ClientDb) => { H.terminated.push(db); },
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
  H.apps = []; H.auths = []; H.dbs = []; H.deleted = []; H.terminated = []; H.clones = []; H.cloneWaits = [];
  H.failure = null; H.providers = []; H.primaryToken = tokenFor(1_700_000_030); H.primaryTokenWait = null;
  H.recovered = true; H.online = true; H.emulators = false; H.tokenCalls = []; H.functionsCalls = [];
});
afterEach(async () => { managers.splice(0).forEach((value) => value.stop()); await settle(); vi.useRealTimers(); });

describe('private named memory lifecycle', () => {
  it('same-UID token refresh rotates the memory app and retires earlier leases', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    const old = sessions.capture();
    const refreshed = { uid: 'alice', token: 'refreshed' }; H.primary.currentUser = refreshed;
    H.idToken!(refreshed); expect(() => old.assertCurrent()).toThrow(/expired/); await settle();
    expect(H.clones.map((clone) => clone.subject.token)).toEqual(['initial', 'refreshed']);
    expect(sessions.capture().db).not.toBe(old.db);
    expect(H.dbs.every((db) => (db.cache as { kind: string }).kind === 'memory')).toBe(true);
    expect(H.auths.every((auth) => auth !== H.primary)).toBe(true);
    expect(H.terminated).toContain(old.db);
  });

  it('keeps an Auth incarnation stamp across offline refresh and reconnect publications', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    const confirmed = sessions.getSnapshot().authGeneration;
    expect(confirmed).toBeGreaterThan(0);
    H.online = false; sessions.refreshConnection();
    expect(sessions.getSnapshot().authGeneration).toBe(confirmed);
    const refreshed = { uid: 'alice', token: 'refreshed' }; H.primary.currentUser = refreshed;
    H.idToken!(refreshed);
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', db: null, transition: 'auth', authGeneration: confirmed + 1 });
    H.online = true; sessions.refreshConnection(); await settle();
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', transition: 'connection', authGeneration: confirmed + 1 });
    expect(sessions.getSnapshot().db).not.toBeNull();
  });

  it('distinguishes reconnect publication from an ordinary same-UID token rotation', async () => {
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    H.online = false; sessions.refreshConnection();
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', db: null, transition: 'connection' });
    H.online = true; sessions.refreshConnection(); await settle();
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', transition: 'connection' });
    H.idToken!(H.primary.currentUser);
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', db: null, transition: 'auth' });
    await settle();
    expect(sessions.getSnapshot()).toMatchObject({ uid: 'alice', transition: 'auth' });
    sessions.refreshRecovery(); await settle();
    expect(sessions.getSnapshot().transition).toBe('recovery');
  });

  it('a delayed old Auth clone cannot replace a newer account session', async () => {
    let release!: () => void; H.cloneWaits = [() => new Promise<void>((resolve) => { release = resolve; })];
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    H.before!(); H.primary.currentUser = { uid: 'bob', token: 'bob-token' }; H.idToken!(H.primary.currentUser); await settle();
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
    H.cloneWaits = [() => Promise.reject(new Error('transient clone'))];
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
    H.failure = 'auth'; H.idToken!(H.primary.currentUser); await settle();
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
    if (reason === 'account') { H.before!(); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser); }
    if (reason === 'offline') { H.online = false; sessions.refreshConnection(); }
    if (reason === 'stop') sessions.stop();
    await settle(); const apps = H.apps.length;
    await vi.advanceTimersByTimeAsync(10_000); expect(H.apps).toHaveLength(apps);
    if (reason === 'account') expect(sessions.capture().uid).toBe('bob');
    else expect(() => sessions.capture()).toThrow(/expired/);
  });

  it('does not retry when the captured User changed without a publication', async () => {
    H.failure = 'auth'; const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    H.failure = null; H.primary.currentUser = { uid: 'alice', token: 'new-token' };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(H.apps).toHaveLength(1); expect(() => sessions.capture()).toThrow(/expired/);
  });

  it('a late failed retry cannot publish failure or schedule work over a newer account', async () => {
    H.cloneWaits = [() => Promise.reject(new Error('transient'))];
    const sessions = manager(); H.idToken!(H.primary.currentUser); await settle();
    let reject!: (error: Error) => void;
    H.cloneWaits = [() => new Promise<void>((_resolve, fail) => { reject = fail; })];
    await vi.advanceTimersByTimeAsync(250);
    H.before!(); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser); await settle();
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
    H.before!(); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser); await settle();
    const bob = sessions.capture(); release(); await settle();
    expect(sessions.capture().db).toBe(bob.db); expect(H.deleted).toContain(H.apps[1]); expect(H.terminated).toContain(H.dbs[1]);
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
    const refreshed = await H.providers[1].getToken();
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
    H.before!(); H.primary.currentUser = { uid: 'bob', token: 'bob' }; H.idToken!(H.primary.currentUser); await settle();
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
