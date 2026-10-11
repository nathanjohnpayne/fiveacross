import {
  clearIndexedDbPersistence, connectFirestoreEmulator, doc, getDocFromServer,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  terminate, waitForPendingWrites, type Firestore,
} from 'firebase/firestore';
import { app, firebaseConfig, firebaseEmulatorsEnabled } from '../firebaseCore';
import { auth } from '../firebaseAuth';
import { applicationAfterRecoveryHref } from './privateCacheRecoveryNavigation';
import { recordPrivateCacheRecovery } from './privateCacheRecoveryMarker';
import { clearLegacyCacheWithoutVerification, completeLegacyCacheRecovery } from './privateCacheRecovery';

const CLEAR_STILL_PENDING = 'Still waiting for cache clearing. Keep this recovery document open; returning or retrying stays unavailable until clearing settles. If it never settles, close the browser rather than reopening the app while this clear is running.';

// Names the failed stage so the operator can fix it before retrying (#1886).
export function recoveryFailureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'failed-precondition') return 'Another tab or window still has the app open, so this device’s cache is in use.';
  if (code === 'unavailable') return 'The server could not be reached.';
  if (code === 'permission-denied') return 'The server refused access for the signed-in account.';
  if (typeof code === 'string') return `The browser reported “${code}”.`;
  if (error instanceof Error && error.message) return error.message;
  return 'An unknown error stopped recovery.';
}

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
  let recovering = false;
  // initializeFirestore may run once per app; the unverified path reuses the
  // instance a failed attended attempt opened (terminate, then clear).
  let legacyDb: Firestore | undefined;
  const openLegacyCache = () => {
    if (legacyDb) return legacyDb;
    legacyDb = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    if (firebaseEmulatorsEnabled()) connectFirestoreEmulator(legacyDb, '127.0.0.1', 8080);
    return legacyDb;
  };
  const returnToApp = () => {
    if (recovering) return;
    window.location.replace(applicationAfterRecoveryHref(window.location.href));
  };
  back.addEventListener('click', returnToApp);
  const changed = () => { finish.disabled = !allAccounts.checked || !tabsClosed.checked; };
  allAccounts.addEventListener('change', changed);
  tabsClosed.addEventListener('change', changed);
  finish.addEventListener('click', async () => {
    if (recovering) return;
    recovering = true;
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
      const db = openLegacyCache();
      await completeLegacyCacheRecovery({ allAccountsRecovered: allAccounts.checked, otherTabsClosed: tabsClosed.checked }, {
        online: () => navigator.onLine,
        currentUid: () => auth.currentUser?.uid ?? null,
        proveServerAccess: async (uid) => { await getDocFromServer(doc(db, 'users', uid)); },
        drainActiveUser: () => waitForPendingWrites(db),
        terminate: () => terminate(db),
        clear: () => clearIndexedDbPersistence(db),
        recordCompletion: () => recordPrivateCacheRecovery(firebaseConfig.projectId),
        clearStillPending: () => { status.textContent = CLEAR_STILL_PENDING; },
      });
      recovering = false;
      returnToApp();
    } catch (error) {
      recovering = false;
      status.textContent = `Recovery did not complete: ${recoveryFailureReason(error)} Private views remain closed. Fix this and try again, or continue without verification below.`;
      // A terminated SDK instance cannot be reused. A verified retry must start
      // a fresh document. Jumping directly to clear is offered only through the
      // separately acknowledged unverified path below.
      back.disabled = false;
      offerFailureOptions();
    }
  });
  // After a failed attempt (#1886): retry in a fresh document, or clear without
  // the verification that protects unsynced Marks, under explicit consent.
  const offerFailureOptions = () => {
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.type = 'button';
    retry.addEventListener('click', () => { if (!recovering) window.location.reload(); });
    const heading = document.createElement('h2');
    heading.textContent = 'Continue without verification';
    const warning = document.createElement('p');
    warning.textContent = 'If recovery keeps failing, you can clear this device’s old cache without checking that queued Marks reached the server. Any Mark not yet synced, for any account used on this device, will be permanently lost. Marks already on the server are kept. Boards need a connection to load again afterwards. Private and admin views open once clearing finishes.';
    const lossAccepted = document.createElement('input');
    lossAccepted.type = 'checkbox';
    const continueTabsClosed = document.createElement('input');
    continueTabsClosed.type = 'checkbox';
    const lossLabel = document.createElement('label');
    lossLabel.append(lossAccepted, ' I understand unsynced Marks for every account on this device will be permanently lost.');
    const continueTabLabel = document.createElement('label');
    continueTabLabel.append(continueTabsClosed, ' I closed every other app tab or window on this device.');
    lossLabel.style.display = continueTabLabel.style.display = 'block';
    const proceed = document.createElement('button');
    proceed.textContent = 'Clear cache without verification';
    proceed.type = 'button';
    proceed.disabled = true;
    const confirmed = () => { proceed.disabled = !lossAccepted.checked || !continueTabsClosed.checked; };
    lossAccepted.addEventListener('change', confirmed);
    continueTabsClosed.addEventListener('change', confirmed);
    proceed.addEventListener('click', async () => {
      if (recovering) return;
      recovering = true;
      proceed.disabled = retry.disabled = back.disabled = lossAccepted.disabled = continueTabsClosed.disabled = true;
      status.textContent = 'Clearing this device’s cache…';
      try {
        const db = openLegacyCache();
        await clearLegacyCacheWithoutVerification({
          unsyncedMarksLossAccepted: lossAccepted.checked, otherTabsClosed: continueTabsClosed.checked,
        }, {
          terminate: () => terminate(db),
          clear: () => clearIndexedDbPersistence(db),
          recordCompletion: () => recordPrivateCacheRecovery(firebaseConfig.projectId),
          clearStillPending: () => { status.textContent = CLEAR_STILL_PENDING; },
        });
        recovering = false;
        returnToApp();
      } catch (error) {
        recovering = false;
        status.textContent = `Clearing did not complete: ${recoveryFailureReason(error)} Private views remain closed. Close every other app tab or window, then try again.`;
        back.disabled = retry.disabled = false;
      }
    });
    back.after(retry);
    panel.append(heading, warning, lossLabel, continueTabLabel, proceed);
  };
  panel.append(title, explanation, accountLabel, tabLabel, finish, back, status);
  root.replaceChildren(panel);
}
