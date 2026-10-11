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
import { RECOVERY_CSS, RECOVERY_STYLE_ID } from './privateCacheRecoveryStyles';

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

type Child = Node | string;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function button(text: string, className: string): HTMLButtonElement {
  const node = el('button', `rec-btn ${className}`.trim(), text);
  node.type = 'button';
  return node;
}

// A real <label> wraps the input so the whole row is the hit target.
function checkRow(text: string, danger = false): { input: HTMLInputElement; row: HTMLLIElement } {
  const input = el('input', 'rec-check-input');
  input.type = 'checkbox';
  const label = el('label', danger ? 'rec-check rec-check--danger' : 'rec-check', input, el('span', 'rec-check-text', text));
  return { input, row: el('li', '', label) };
}

function installRecoveryStyles(): void {
  if (document.getElementById(RECOVERY_STYLE_ID)) return;
  const style = el('style', '', RECOVERY_CSS);
  style.id = RECOVERY_STYLE_ID;
  document.head.append(style);
}

// Loaded by entry.tsx INSTEAD OF main. This document never starts gameplay,
// React effects, analytics or application data writers. No auto-clear on boot.
export function renderPrivateCacheRecovery(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('Recovery root missing.');
  installRecoveryStyles();
  document.body.classList.add('rec-page');
  const header = el('header', 'rec-head',
    el('h1', 'rec-title', 'Finish device recovery'),
    el('p', 'rec-lede', 'Private and admin views are held closed until this device’s old cache is cleared.'),
    el('p', 'rec-steps-title', 'Before you clear'),
    el('ol', 'rec-steps',
      el('li', '', 'Return to the app and sign in to every account used on this device.'),
      el('li', '', 'Reconnect, and verify that each account’s queued Marks reached the server.'),
      el('li', '', 'Stay online, and close the app in every other tab or window.')),
    el('p', 'rec-note', 'Clearing early can lose another account’s unsynced Marks.'));
  const { input: allAccounts, row: accountRow } = checkRow('I recovered and verified queued Marks for every account used on this device.');
  const { input: tabsClosed, row: tabRow } = checkRow('I closed every other app tab or window on this device.');
  const cardTitle = el('h2', 'rec-card-title', 'Confirm to continue');
  cardTitle.id = 'rec-confirm-title';
  const card = el('section', 'rec-card', cardTitle, el('ul', 'rec-checklist', accountRow, tabRow));
  card.setAttribute('aria-labelledby', cardTitle.id);
  const finish = button('Clear recovered cache', 'rec-btn--primary');
  finish.disabled = true;
  const retry = button('Try again', 'rec-btn--primary');
  retry.hidden = true;
  const back = button('Return to the app', '');
  const status = el('p', 'rec-status');
  status.setAttribute('role', 'status');
  const alert = el('div', 'rec-alert');
  alert.setAttribute('role', 'alert');
  const main = el('main', 'rec', header, card, el('div', 'rec-actions', finish, retry, back), status, alert);
  const busy = (text: string, wait = false) => {
    alert.replaceChildren();
    status.classList.toggle('rec-status--wait', wait);
    const dots = el('span', 'rec-dots', el('i'), el('i'), el('i'));
    dots.setAttribute('aria-hidden', 'true');
    status.replaceChildren(dots, text);
  };
  const fail = (title: string, error: unknown, tail: string) => {
    status.replaceChildren();
    status.classList.remove('rec-status--wait');
    alert.replaceChildren(el('strong', 'rec-alert-title', title), el('p', '', recoveryFailureReason(error)), el('p', '', tail));
  };
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
  retry.addEventListener('click', () => { if (!recovering) window.location.reload(); });
  const changed = () => { finish.disabled = !allAccounts.checked || !tabsClosed.checked; };
  allAccounts.addEventListener('change', changed);
  tabsClosed.addEventListener('change', changed);
  finish.addEventListener('click', async () => {
    if (recovering) return;
    recovering = true;
    finish.disabled = back.disabled = allAccounts.disabled = tabsClosed.disabled = true;
    busy('Finishing recovery…');
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
        clearStillPending: () => busy(CLEAR_STILL_PENDING, true),
      });
      recovering = false;
      returnToApp();
    } catch (error) {
      recovering = false;
      fail('Recovery did not complete', error, 'Private views remain closed. Fix this and try again, or continue without verification below.');
      // A terminated SDK instance cannot be reused. A verified retry must start
      // a fresh document. Jumping directly to clear is offered only through the
      // separately acknowledged unverified path below.
      finish.hidden = true;
      retry.hidden = back.disabled = false;
      offerUnverifiedClear();
    }
  });
  // After a failed attempt (#1886): clear without the verification that
  // protects unsynced Marks, under explicit consent. Collapsed by default so
  // Try again stays the obvious path; the warning precedes the button.
  const offerUnverifiedClear = () => {
    const warning = el('p', 'rec-warn',
      'If recovery keeps failing, you can clear this device’s old cache without checking that queued Marks reached the server. Any Mark not yet synced, for any account used on this device, will be ',
      el('b', '', 'permanently lost'),
      '. Marks already on the server are kept. Boards need a connection to load again afterwards. Private and admin views open once clearing finishes.');
    const { input: lossAccepted, row: lossRow } = checkRow('I understand unsynced Marks for every account on this device will be permanently lost.', true);
    const { input: continueTabsClosed, row: continueTabRow } = checkRow('I closed every other app tab or window on this device.', true);
    const proceed = button('Clear cache without verification', 'rec-btn--danger rec-btn--block');
    proceed.disabled = true;
    const hatchBody = el('div', 'rec-hatch-body',
      el('h2', 'rec-hatch-title', 'Continue without verification'),
      warning,
      el('ul', 'rec-checklist', lossRow, continueTabRow),
      el('div', 'rec-actions', proceed));
    const hatch = el('details', 'rec-hatch', el('summary', '', 'Recovery keeps failing?'), hatchBody);
    const confirmed = () => { proceed.disabled = !lossAccepted.checked || !continueTabsClosed.checked; };
    lossAccepted.addEventListener('change', confirmed);
    continueTabsClosed.addEventListener('change', confirmed);
    proceed.addEventListener('click', async () => {
      if (recovering) return;
      recovering = true;
      proceed.disabled = retry.disabled = back.disabled = lossAccepted.disabled = continueTabsClosed.disabled = true;
      // Feedback belongs under the button that was pressed.
      hatchBody.append(status, alert);
      busy('Clearing this device’s cache…');
      try {
        const db = openLegacyCache();
        await clearLegacyCacheWithoutVerification({
          unsyncedMarksLossAccepted: lossAccepted.checked, otherTabsClosed: continueTabsClosed.checked,
        }, {
          terminate: () => terminate(db),
          clear: () => clearIndexedDbPersistence(db),
          recordCompletion: () => recordPrivateCacheRecovery(firebaseConfig.projectId),
          clearStillPending: () => busy(CLEAR_STILL_PENDING, true),
        });
        recovering = false;
        returnToApp();
      } catch (error) {
        recovering = false;
        hatch.open = true;
        fail('Clearing did not complete', error, 'Private views remain closed. Close every other app tab or window, then try again.');
        back.disabled = retry.disabled = false;
      }
    });
    main.append(hatch);
  };
  root.replaceChildren(main);
}
