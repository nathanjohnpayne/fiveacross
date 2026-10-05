import { deleteApp, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import {
  beforeAuthStateChanged, connectAuthEmulator, inMemoryPersistence, initializeAuth,
  onIdTokenChanged, updateCurrentUser, type Auth, type User,
} from 'firebase/auth';
import { CustomProvider, initializeAppCheck, type AppCheckToken } from 'firebase/app-check';
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, terminate, type Firestore } from 'firebase/firestore';
export interface PrivateFirestoreSession {
  uid: string | null;
  db: Firestore | null;
  generation: number;
  /** Auth retirement stamp retained across later connection publications. */
  authGeneration: number;
  /** Connection transitions may carry confirmed block state online only
   * within its Auth stamp; same-scope offline rendering is a separate exception. */
  transition?: 'auth' | 'connection' | 'recovery';
  recoveryRequired: boolean;
  failed: boolean;
  /** A failed bridge still has a bounded, scheduled fresh-client retry. */
  retryPending: boolean;
}

type PrivateClient = { app: FirebaseApp; auth: Auth; db: Firestore };
export type SessionOptions = {
  primaryAuth: Auth;
  options: FirebaseOptions;
  recovered: () => boolean;
  online?: () => boolean;
  emulator?: { authUrl: string; firestoreHost: string; firestorePort: number };
  /** Forward the already-attested primary app token; never create a second CAPTCHA. */
  appCheckToken?: () => Promise<string>;
};


/** JWT expiry is only a local refresh deadline; the server verifies the token.
 * Reusing the primary token must never extend its signed validity interval. */
function forwardedAppCheckToken(token: string): AppCheckToken {
  let expiresAt: unknown;
  try {
    const segments = token.split('.');
    if (segments.length !== 3 || !segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))) throw new Error();
    const encoded = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)));
    if (typeof claims === 'object' && claims !== null && 'exp' in claims) expiresAt = claims.exp;
  } catch { /* Refuse malformed scheduling metadata below. */ }
  const expireTimeMillis = typeof expiresAt === 'number' ? expiresAt * 1000 : NaN;
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(expireTimeMillis) || expireTimeMillis <= Date.now()) {
    throw new Error('Primary App Check token has no valid future expiration.');
  }
  return { token, expireTimeMillis };
}

let appSequence = 0;
// Initial attempt plus three fresh-client attempts; no timer survives retirement.
const BRIDGE_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;
// The active same-UID copy uses local Auth state, not a network round trip (#1700).
const ACTIVE_AUTH_COPY_TIMEOUT_MS = 5_000;

/**
 * Private reads never share the gameplay app's persistent cache. Each Auth
 * account/retirement generation gets a fresh named app and memory-only Auth/Firestore. Dropping
 * Auth alone cannot retire a Firestore cache (real-SDK #1411 feasibility test).
 */
export function createPrivateFirestoreSessions(config: SessionOptions) {
  let generation = 0;
  let authGeneration = 0;
  let client: PrivateClient | null = null;
  let stopped = false;
  let initializingUid: string | null = null;
  let authRevision = 0;
  let refreshQueue: Promise<void> = Promise.resolve();
  let refreshCopy: { timer: ReturnType<typeof setTimeout>; cancelWait: () => void } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  let snapshot: PrivateFirestoreSession = {
    uid: null, db: null, generation, authGeneration, transition: 'auth', recoveryRequired: !config.recovered(), failed: false, retryPending: false,
  };
  const publish = (value: PrivateFirestoreSession) => {
    snapshot = value;
    listeners.forEach((listener) => listener());
  };
  const dispose = async (old: PrivateClient | null) => {
    if (!old) return;
    await terminate(old.db).catch(() => {});
    await updateCurrentUser(old.auth, null).catch(() => {});
    await deleteApp(old.app).catch(() => {});
  };
  const retire = (transition: NonNullable<PrivateFirestoreSession['transition']> = 'auth') => {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    if (refreshCopy !== null) {
      clearTimeout(refreshCopy.timer);
      refreshCopy.cancelWait();
      refreshCopy = null;
    }
    generation += 1;
    if (transition === 'auth') authGeneration += 1;
    initializingUid = null;
    refreshQueue = Promise.resolve();
    const old = client;
    client = null;
    // Retire visible state synchronously, before primary Auth commits a change.
    publish({ uid: config.primaryAuth.currentUser?.uid ?? null, db: null, generation, authGeneration, transition, recoveryRequired: !config.recovered(), failed: false, retryPending: false });
    void dispose(old);
  };
  const synchronize = async (user: User | null, transition: NonNullable<PrivateFirestoreSession['transition']> = 'auth', retryIndex = 0) => {
    retire(transition);
    const attempt = generation;
    if (stopped || !user || config.online?.() === false) return;
    initializingUid = user.uid;
    let candidate: PrivateClient | null = null;
    let candidateApp: FirebaseApp | null = null;
    try {
      const privateApp = initializeApp(config.options, `fiveacross-private-${++appSequence}`);
      candidateApp = privateApp;
      const privateAuth = initializeAuth(privateApp, { persistence: inMemoryPersistence });
      const privateDb = initializeFirestore(privateApp, { localCache: memoryLocalCache() });
      candidate = { app: privateApp, auth: privateAuth, db: privateDb };
      if (config.emulator) {
        connectAuthEmulator(privateAuth, config.emulator.authUrl, { disableWarnings: true });
        connectFirestoreEmulator(privateDb, config.emulator.firestoreHost, config.emulator.firestorePort);
      }
      if (config.appCheckToken) {
        const token = config.appCheckToken;
        initializeAppCheck(privateApp, {
          provider: new CustomProvider({
            getToken: async () => forwardedAppCheckToken(await token()),
          }),
          isTokenAutoRefreshEnabled: false,
        });
      }
      // Token callbacks can arrive during first bootstrap. Copy the newest
      // same-account subject before publishing, without starting competing apps.
      let copiedUser = user;
      for (;;) {
        const copiedRevision = authRevision;
        await updateCurrentUser(privateAuth, copiedUser);
        const latest = config.primaryAuth.currentUser;
        if (stopped || attempt !== generation || latest?.uid !== user.uid || config.online?.() === false) break;
        if (latest === copiedUser && copiedRevision === authRevision) break;
        copiedUser = latest;
      }
      if (stopped || attempt !== generation || config.primaryAuth.currentUser?.uid !== user.uid || config.online?.() === false) {
        // Release only this attempt before disposal yields to a newer bootstrap.
        if (attempt === generation) initializingUid = null;
        await dispose(candidate);
        return;
      }
      initializingUid = null;
      client = candidate;
      publish({ uid: user.uid, db: privateDb, generation: attempt, authGeneration, transition, recoveryRequired: !config.recovered(), failed: false, retryPending: false });
    } catch {
      await dispose(candidate);
      if (!candidate && candidateApp) await deleteApp(candidateApp).catch(() => {});
      if (!stopped && attempt === generation) {
        initializingUid = null;
        const delay = BRIDGE_RETRY_DELAYS_MS[retryIndex];
        const retryPending = delay !== undefined && config.primaryAuth.currentUser?.uid === user.uid && config.online?.() !== false;
        if (retryPending) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (stopped || attempt !== generation || config.primaryAuth.currentUser?.uid !== user.uid || config.online?.() === false) return;
            // A failed bridge cannot carry a previously confirmed private set,
            // even if React never observed its intermediate failed publication.
            void synchronize(config.primaryAuth.currentUser, 'auth', retryIndex + 1);
          }, delay);
        }
        // Publish failure and its scheduled-retry status together. Readiness
        // waiters must distinguish this episode from exhausted bridge failure.
        publish({ uid: null, db: null, generation: attempt, authGeneration, transition, recoveryRequired: !config.recovered(), failed: true, retryPending });
      }
    }
  };
  const refreshAuth = (user: User | null) => {
    if (stopped) return;
    authRevision += 1;
    const current = client;
    if (user && snapshot.uid === user.uid && config.online?.() === false) return;
    if (user && initializingUid === user.uid) return;
    if (!user || !current || snapshot.uid !== user.uid || snapshot.failed) {
      void synchronize(user);
      return;
    }
    const attempt = generation;
    // The named Auth API copies credentials into the existing memory client.
    // Serialize refreshes: an older delayed copy must not overwrite a newer one.
    // Retirement starts an independent queue; old completions remain fenced.
    refreshQueue = refreshQueue.then(async () => {
      if (stopped || attempt !== generation || client !== current || config.primaryAuth.currentUser?.uid !== user.uid) return;
      let cancelWait!: () => void;
      let timer!: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((resolve, reject) => {
        cancelWait = resolve;
        timer = setTimeout(() => reject(new Error('Private Auth copy timed out.')), ACTIVE_AUTH_COPY_TIMEOUT_MS);
      });
      const copying = { timer, cancelWait };
      refreshCopy = copying;
      try {
        // Race only this active copy. Retirement releases the local waiter;
        // the SDK operation is uncancelled and its late rejection is consumed.
        await Promise.race([updateCurrentUser(current.auth, config.primaryAuth.currentUser), deadline]);
      } catch {
        if (!stopped && attempt === generation && client === current && config.primaryAuth.currentUser?.uid === user.uid) {
          // Failed copying cannot keep authorizing the old client. Start the
          // existing bounded fresh-client recovery episode, never a disk fallback.
          void synchronize(config.primaryAuth.currentUser);
        }
      } finally {
        clearTimeout(copying.timer);
        if (refreshCopy === copying) refreshCopy = null;
      }
    });
  };
  const stopBefore = beforeAuthStateChanged(config.primaryAuth, (nextUser) => {
    if (nextUser?.uid !== config.primaryAuth.currentUser?.uid) {
      retire();
    }
  }, () => {
    // Primary middleware can overlap before its Auth operation queue. Restore
    // the actual current actor after an abort if its bridge remains retired;
    // a shared per-callback flag can be overwritten by another same-UID call.
    if (!stopped && !client && initializingUid === null) void synchronize(config.primaryAuth.currentUser);
  });
  const stopAuth = onIdTokenChanged(config.primaryAuth, refreshAuth);
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshRecovery: () => { void synchronize(config.primaryAuth.currentUser, 'recovery'); },
    refreshConnection: () => { void synchronize(config.primaryAuth.currentUser, 'connection'); },
    // An explicit Retry starts a fresh bounded episode and retires old answers,
    // even when React did not render an intermediate bridge failure.
    retry: () => { void synchronize(config.primaryAuth.currentUser, 'auth'); },
    capture: (allowRecovery = false) => {
      const captured = snapshot;
      const assertCurrent = () => {
        if (stopped || !captured.db || captured.generation !== snapshot.generation || captured.uid !== config.primaryAuth.currentUser?.uid || config.online?.() === false || (!allowRecovery && !config.recovered())) {
          const error = new Error("Private session expired or device recovery is required.");
          // A still-current account may retry a retired/unavailable transport,
          // but the old lease still refuses every read, write and completion.
          if (!stopped && captured.uid === config.primaryAuth.currentUser?.uid && (allowRecovery || config.recovered())) {
            throw Object.assign(error, { code: 'unavailable' });
          }
          throw error;
        }
      };
      assertCurrent();
      return {
        db: captured.db!, uid: captured.uid!, generation: captured.generation, assertCurrent,
        guard: async <T>(operation: () => Promise<T>): Promise<T> => {
          assertCurrent();
          const result = await operation();
          assertCurrent();
          return result;
        },
      };
    },
    stop: () => { stopped = true; stopBefore(); stopAuth(); retire(); listeners.clear(); },
  };
}
