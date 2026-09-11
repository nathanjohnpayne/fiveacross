import { initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  connectAuthEmulator,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  initializeAuth,
  setPersistence,
  signInWithCustomToken,
  updateCurrentUser,
  type Auth,
  type User,
} from 'firebase/auth';
import type { HandoffCommitWorkerAdapter } from './handoffCommitWorker';
import { proveWritableIndexedDb } from './handoffIndexedDbProbe';
import { fingerprintHandoffSession } from './handoffSessionFingerprint';

let isolatedAppSequence = 0;

function isolatedAppName(): string {
  if (typeof crypto?.randomUUID === 'function') return `fa-handoff-worker-${crypto.randomUUID()}`;
  isolatedAppSequence += 1;
  return `fa-handoff-worker-${isolatedAppSequence}`;
}

/** Firebase implementation for the disposable dedicated Worker. */
export function createFirebaseHandoffCommitWorkerAdapter(
  indexedDb: IDBFactory,
): HandoffCommitWorkerAdapter {
  let candidateUser: User | null = null;
  let firebaseOptions: FirebaseOptions | null = null;
  let tenantId: string | null = null;
  let emulatorUrl: string | null = null;
  let initialized = false;
  // Set at the top of `commit()`, before any default-Auth work: the persistent
  // [DEFAULT] app is a one-shot mutation, so a second call is refused by this
  // module itself rather than only by the Worker controller's phase machine
  // (#1077). The flag is also never cleared on failure: a commit that threw
  // part-way may already have initialized [DEFAULT], and `initializeApp` would
  // throw on the retry anyway, so the adapter is disposable after one attempt.
  let committed = false;

  return {
    async initialize(input) {
      // This pre-lock phase proves the platform only. Constructing persistent
      // default Auth is itself a shared mutation: its initialization reads and
      // can rewrite/remove the stored user. An older attempt must not be able
      // to resume that work after a newer winner commits, so every default-Auth
      // operation is deferred to `commit()`, which the page invokes only while
      // holding the final attempt lock.
      await proveWritableIndexedDb(indexedDb);
      if (indexedDBLocalPersistence.type !== 'LOCAL') {
        throw new Error('handoff-worker-indexeddb-unavailable');
      }

      firebaseOptions = input.firebaseOptions;
      tenantId = input.tenantId;
      emulatorUrl = input.emulatorUrl;
      initialized = true;
    },

    async prepare(input) {
      if (!initialized || firebaseOptions === null) {
        throw new Error('handoff-worker-not-initialized');
      }
      const isolatedApp = initializeApp(firebaseOptions, isolatedAppName());
      const isolatedAuth = initializeAuth(isolatedApp, {
        persistence: inMemoryPersistence,
        popupRedirectResolver: undefined,
      });
      isolatedAuth.tenantId = tenantId;
      if (emulatorUrl !== null) {
        connectAuthEmulator(isolatedAuth, emulatorUrl, { disableWarnings: true });
      }
      const credential = await signInWithCustomToken(isolatedAuth, input.customToken);
      if (!credential.user.refreshToken) throw new Error('handoff-worker-token-missing');
      candidateUser = credential.user;
      return {
        uid: credential.user.uid,
        refreshTokenDigest: await fingerprintHandoffSession({
          ownerNonce: input.attempt.ownerNonce,
          uid: credential.user.uid,
          refreshToken: credential.user.refreshToken,
        }),
      };
    },

    async commit() {
      if (!initialized || firebaseOptions === null || candidateUser === null) {
        throw new Error('handoff-worker-not-prepared');
      }
      if (committed) throw new Error('handoff-worker-already-committed');
      committed = true;
      // No name argument: the persistent target MUST be [DEFAULT], matching the
      // page's Firebase Auth persistence key. This entire initialization/read/
      // migration/write sequence runs only after the page has verified fence
      // ownership and while it holds the handoff-commit Web Lock.
      const persistentApp = initializeApp(firebaseOptions);
      const persistentAuth: Auth = initializeAuth(persistentApp, {
        persistence: indexedDBLocalPersistence,
        popupRedirectResolver: undefined,
      });
      persistentAuth.tenantId = tenantId;
      if (emulatorUrl !== null) {
        connectAuthEmulator(persistentAuth, emulatorUrl, { disableWarnings: true });
      }
      await setPersistence(persistentAuth, indexedDBLocalPersistence);
      await persistentAuth.authStateReady();
      await updateCurrentUser(persistentAuth, candidateUser);
    },
  };
}
