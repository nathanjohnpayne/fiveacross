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

/** Capture once before awaiting. Auth bootstrap may read its own profile in
 * memory during attended recovery; private UI and Admin actions remain closed. */
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

/** A bounded readiness wait for bootstrap, never a lookup after capturing an action. */
export async function awaitPrivateFirestore(uid: string, allowRecovery = false) {
  const manager = privateFirestoreSessions();
  const ready = () => {
    const snapshot = manager.getSnapshot();
    return snapshot.uid === uid && snapshot.db !== null;
  };
  if (!ready()) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Private session unavailable.')); }, 5_000);
    const unsubscribe = manager.subscribe(() => {
      if (auth.currentUser?.uid !== uid || manager.getSnapshot().failed) {
        clearTimeout(timer); unsubscribe(); reject(new Error('Private session changed.'));
      } else if (ready()) { clearTimeout(timer); unsubscribe(); resolve(); }
    });
  });
  const lease = capturePrivateFirestore(allowRecovery);
  if (lease.uid !== uid) throw new Error('Private account changed.');
  return lease;
}
