import {
  clearIndexedDbPersistence, connectFirestoreEmulator, doc, getDocFromServer,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  terminate, waitForPendingWrites,
} from 'firebase/firestore';
import { app, firebaseConfig, firebaseEmulatorsEnabled } from '../firebaseCore';
import { auth } from '../firebaseAuth';
import { applicationAfterRecoveryHref } from './privateCacheRecoveryNavigation';
import { recordPrivateCacheRecovery } from './privateCacheRecoveryMarker';
import { completeLegacyCacheRecovery } from './privateCacheRecovery';

// Loaded by entry.tsx INSTEAD OF main. This document never starts gameplay,
// React effects, analytics or application data writers. No auto-clear on boot.
export function renderPrivateCacheRecovery(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('Recovery root missing.');
  const panel = document.createElement('main');
  panel.style.cssText = 'max-width:38rem;margin:4rem auto;padding:1.5rem;font:1rem/1.5 system-ui;color:#eef2f6;background:#0b0f14';
  const title = document.createElement('h1');
  title.textContent = 'Finish device recovery';
  const explanation = document.createElement('p');
  explanation.textContent = 'Private and admin views are held closed until this device’s old cache is cleared. First return to the app, sign in to every account used here, reconnect, and verify that its queued Marks reached the server. Stay online and close the app in every other tab or window. Clearing early can lose another account’s unsynced Marks.';
  const allAccounts = document.createElement('input');
  allAccounts.type = 'checkbox';
  const tabsClosed = document.createElement('input');
  tabsClosed.type = 'checkbox';
  const accountLabel = document.createElement('label');
  accountLabel.append(allAccounts, ' I recovered and verified queued Marks for every account used on this device.');
  const tabLabel = document.createElement('label');
  tabLabel.append(tabsClosed, ' I closed every other app tab or window on this device.');
  accountLabel.style.display = tabLabel.style.display = 'block';
  const finish = document.createElement('button');
  finish.textContent = 'Clear recovered cache';
  finish.type = 'button';
  finish.disabled = true;
  const back = document.createElement('button');
  back.textContent = 'Return to the app';
  back.type = 'button';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const returnToApp = () => {
    window.location.replace(applicationAfterRecoveryHref(window.location.href));
  };
  back.addEventListener('click', returnToApp);
  const changed = () => { finish.disabled = !allAccounts.checked || !tabsClosed.checked; };
  allAccounts.addEventListener('change', changed);
  tabsClosed.addEventListener('change', changed);
  finish.addEventListener('click', async () => {
    finish.disabled = back.disabled = allAccounts.disabled = tabsClosed.disabled = true;
    status.textContent = 'Finishing recovery…';
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([auth.authStateReady(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Auth recovery timed out.')), 5000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      if (!auth.currentUser || !navigator.onLine) throw new Error('Return to the app and sign in online first.');
      const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
      if (firebaseEmulatorsEnabled()) connectFirestoreEmulator(db, '127.0.0.1', 8080);
      await completeLegacyCacheRecovery({ allAccountsRecovered: allAccounts.checked, otherTabsClosed: tabsClosed.checked }, {
        online: () => navigator.onLine,
        currentUid: () => auth.currentUser?.uid ?? null,
        proveServerAccess: async (uid) => { await getDocFromServer(doc(db, 'users', uid)); },
        drainActiveUser: () => waitForPendingWrites(db),
        terminate: () => terminate(db),
        clear: () => clearIndexedDbPersistence(db),
        recordCompletion: () => recordPrivateCacheRecovery(firebaseConfig.projectId),
      });
      returnToApp();
    } catch {
      status.textContent = 'Recovery did not complete. Private views remain closed. Return to the app, verify every account’s Marks online and close other tabs before trying again.';
      // A terminated SDK instance cannot be reused. A retry must start a fresh
      // document; it may never jump directly to clear after a prior failure.
      back.disabled = false;
    }
  });
  panel.append(title, explanation, accountLabel, tabLabel, finish, back, status);
  root.replaceChildren(panel);
}
