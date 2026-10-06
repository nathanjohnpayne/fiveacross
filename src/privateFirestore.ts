import { getToken } from 'firebase/app-check';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { auth, appCheck, firebaseConfig, firebaseEmulatorsEnabled } from './firebase';
import { createPrivateFirestoreSessions } from './auth/privateFirestoreSession';
export { createPrivateFirestoreSessions } from './auth/privateFirestoreSession';
export type { PrivateFirestoreSession } from './auth/privateFirestoreSession';

import { privateCacheRecovered, privateCacheRecoveryKey } from './auth/privateCacheRecoveryMarker';
export { privateCacheRecovered, recordPrivateCacheRecovery } from './auth/privateCacheRecoveryMarker';

let sessions: ReturnType<typeof createPrivateFirestoreSessions> | null = null;
export function privateFirestoreSessions() {
  if (sessions) return sessions;
  const emulators = firebaseEmulatorsEnabled();
  const primaryAppCheck = appCheck;
  sessions = createPrivateFirestoreSessions({
    primaryAuth: auth, options: firebaseConfig,
    recovered: () => privateCacheRecovered(firebaseConfig.projectId),
    online: () => navigator.onLine,
    ...(emulators ? { emulator: { authUrl: 'http://127.0.0.1:9099', firestoreHost: '127.0.0.1', firestorePort: 8080 } } : {}),
    // The primary SDK refreshes its attestation; the named provider preserves
    // JWT expiry as scheduling metadata, with server verification authoritative.
    ...(primaryAppCheck ? { appCheckToken: async () => (await getToken(primaryAppCheck, false)).token } : {}),
  });
  window.addEventListener('storage', (event) => {
    if (event.key === privateCacheRecoveryKey(firebaseConfig.projectId) || event.key === null) sessions?.refreshRecovery();
  });
  window.addEventListener('offline', () => sessions?.refreshConnection());
  window.addEventListener('online', () => sessions?.refreshConnection());
  return sessions;
}

/** A captured SDK read, never a whole profile transaction/write. Its outcome
 * changes only when that exact SDK read settles; success or a terminal authority
 * rejection disarms Retry. */
export type PrivateReadOperation = {
  kind: 'profile-read' | 'attestation-read';
  lease: ReturnType<ReturnType<typeof privateFirestoreSessions>['capture']>;
  outcome: 'pending' | 'failed' | 'succeeded';
  /** A successful SDK read or permanent authority rejection disarms old proof. */
  retryEligible: boolean;
};

/** Explicit private-UI retry starts one fresh bounded bridge episode.
 * Gameplay supplies its actor UID and optional current private-read failure;
 * a healthy current client retains its subscriptions and captured leases unless
 * an explicitly failed/timed-out SDK read still belongs to that client. */
export function retryPrivateFirestoreSession(unavailableForUid?: string, failedRead?: PrivateReadOperation | null): void {
  if (unavailableForUid !== undefined) {
    if (auth.currentUser?.uid !== unavailableForUid || navigator.onLine === false) return;
    const manager = privateFirestoreSessions();
    const snapshot = manager.getSnapshot();
    if (failedRead) {
      if (!failedRead.retryEligible || !['profile-read', 'attestation-read'].includes(failedRead.kind) ||
          !['pending', 'failed'].includes(failedRead.outcome) ||
          failedRead.lease.uid !== unavailableForUid || failedRead.lease.db !== snapshot.db ||
          failedRead.lease.generation !== snapshot.generation) return;
      try { failedRead.lease.assertCurrent(); } catch { return; }
    } else if (snapshot.uid === unavailableForUid && snapshot.db !== null && !snapshot.failed) {
      return;
    }
    manager.retry();
    return;
  }
  privateFirestoreSessions().retry();
}

function privateUnavailable() { return Object.assign(new Error('Private session unavailable.'), { code: 'unavailable' }); }

/** Capture once before awaiting. Gameplay bootstrap may read its own profile and
 * reciprocal block filter in memory during recovery; ordinary private UI
 * and Admin actions remain closed. */
export function capturePrivateFirestore(allowRecovery = false) {
  const lease = privateFirestoreSessions().capture(allowRecovery);
  const functions = getFunctions(lease.db.app, 'us-central1');
  const storage = getStorage(lease.db.app);
  if (firebaseEmulatorsEnabled()) {
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
  }
  return { ...lease, functions, storage };
}

/** One bounded bootstrap wait spans scheduled bridge retries. It never replaces
 * a captured action lease, and no publication resets the absolute deadline. */
export async function awaitPrivateFirestore(uid: string, allowRecovery = false) {
  const manager = privateFirestoreSessions();
  // Exhaustion rejects promptly, including callers arriving after publication.
  // A still-scheduled retry may recover within this same five-second wait.
  if (auth.currentUser?.uid !== uid) throw new Error('Private session changed.');
  if (manager.getSnapshot().failed && !manager.getSnapshot().retryPending) throw privateUnavailable();
  const ready = () => {
    const snapshot = manager.getSnapshot();
    return snapshot.uid === uid && snapshot.db !== null;
  };
  if (!ready()) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(privateUnavailable()); }, 5_000);
    const unsubscribe = manager.subscribe(() => {
      if (auth.currentUser?.uid !== uid || (manager.getSnapshot().failed && !manager.getSnapshot().retryPending)) {
        clearTimeout(timer); unsubscribe(); reject(auth.currentUser?.uid !== uid ? new Error('Private session changed.') : privateUnavailable());
      } else if (ready()) { clearTimeout(timer); unsubscribe(); resolve(); }
    });
  });
  // A ready publication and a primary-account change can both precede this
  // continuation. Refuse before constructing another account's services.
  if (auth.currentUser?.uid !== uid) throw new Error('Private session changed.');
  const lease = capturePrivateFirestore(allowRecovery);
  if (lease.uid !== uid) throw new Error('Private account changed.');
  return lease;
}
