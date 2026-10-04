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

/**
 * Private reads never share the gameplay app's persistent cache. Each Auth
 * generation gets a fresh named app and memory-only Auth/Firestore. Dropping
 * Auth alone cannot retire a Firestore cache (real-SDK #1411 feasibility test).
 */
export function createPrivateFirestoreSessions(config: SessionOptions) {
  let generation = 0;
  let authGeneration = 0;
  let client: PrivateClient | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  let snapshot: PrivateFirestoreSession = {
    uid: null, db: null, generation, authGeneration, transition: 'auth', recoveryRequired: !config.recovered(), failed: false,
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
    generation += 1;
    if (transition === 'auth') authGeneration += 1;
    const old = client;
    client = null;
    // Retire visible state synchronously, before primary Auth commits a change.
    publish({ uid: config.primaryAuth.currentUser?.uid ?? null, db: null, generation, authGeneration, transition, recoveryRequired: !config.recovered(), failed: false });
    void dispose(old);
  };
  const synchronize = async (user: User | null, transition: NonNullable<PrivateFirestoreSession['transition']> = 'auth', retryIndex = 0) => {
    retire(transition);
    const attempt = generation;
    if (stopped || !user || config.online?.() === false) return;
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
      await updateCurrentUser(privateAuth, user);
      if (stopped || attempt !== generation || config.primaryAuth.currentUser?.uid !== user.uid || config.online?.() === false) {
        await dispose(candidate);
        return;
      }
      client = candidate;
      publish({ uid: user.uid, db: privateDb, generation: attempt, authGeneration, transition, recoveryRequired: !config.recovered(), failed: false });
    } catch {
      await dispose(candidate);
      if (!candidate && candidateApp) await deleteApp(candidateApp).catch(() => {});
      if (!stopped && attempt === generation) {
        publish({ uid: null, db: null, generation: attempt, authGeneration, transition, recoveryRequired: !config.recovered(), failed: true });
        const delay = BRIDGE_RETRY_DELAYS_MS[retryIndex];
        if (delay !== undefined && !stopped && attempt === generation && config.primaryAuth.currentUser === user && config.online?.() !== false) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (stopped || attempt !== generation || config.primaryAuth.currentUser !== user || config.online?.() === false) return;
            // A failed bridge cannot carry a previously confirmed private set,
            // even if React never observed its intermediate failed publication.
            void synchronize(user, 'auth', retryIndex + 1);
          }, delay);
        }
      }
    }
  };
  const stopBefore = beforeAuthStateChanged(config.primaryAuth, () => retire(), () => { void synchronize(config.primaryAuth.currentUser); });
  const stopAuth = onIdTokenChanged(config.primaryAuth, (user) => { void synchronize(user); });
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

