// Auth Emulator sign-in mechanics, shared by every Playwright layer that has to
// get a real signed-in user into the app.
//
// Extracted from tests/e2e/support/join.ts (Codex P1 on #1020). The marketing
// capture harness had copied this wholesale because join.ts's own entry point
// hard-asserts the Gay Cruise Bingo wordmark and the 18+ checkbox, neither of
// which a Vacay / Five Across gate renders. Two copies of a flow this fragile
// is a maintenance trap, and the copies had already drifted — the duplicate
// lacked the per-context route guard and the unreadable-cache cleanup below.
//
// Everything here is EDITION-NEUTRAL on purpose: it drives the emulator widget
// and the network stubs, and knows nothing about which gate rendered. Each
// caller owns its own gate copy (see joinViaSharedLink, joinHero).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page, type Route } from '@playwright/test';

/**
 * Drive the Firebase Auth Emulator's account-chooser popup that
 * `signInWithPopup(auth, googleProvider)` opens once `src/firebase.ts` has
 * connected its `auth` singleton to the Local Emulator Suite (the env-gated
 * `connectAuthEmulator` branch, active for the `demo-` e2e project — see
 * specs/x-e2e-happy-path.md). No real Google OAuth is involved: the emulator
 * widget (node_modules/firebase-tools .../auth/widget_ui.js) lets us add a new
 * auto-generated account and submit it, which resolves the popup and signs the
 * Player in. Selectors are the widget's own stable ids/classes.
 */
export async function completeEmulatorSignIn(popup: Page): Promise<void> {
  // #317: "Add new account" is visible-but-inert until the widget's handlers
  // wire up — its inline <script> (node_modules/firebase-tools .../widget_ui.js)
  // sits immediately after a classic, non-async/non-deferred <script src> that
  // fetches material-components-web from a CDN, so the browser blocks on that
  // fetch+execute before running the inline script that actually attaches
  // `.js-new-account`'s click listener — a click before then is a silent
  // no-op. The CDN requests themselves are stubbed out per-context (see
  // stubAuthWidgetCdn below), so the popup's `load` event — which cannot fire
  // until that whole chain has run — is both DETERMINISTIC and fast: wait for
  // it first. (The previous 15s blind-retry budget fired clicks that were
  // no-ops pre-wiring and could still lose the race under load — the single
  // largest contributor to the union suite's mass sign-in failures.) A short
  // retry stays as a safety net for anything unforeseen once handlers are
  // confirmed wired.
  await popup.waitForLoadState('load', { timeout: 30_000 });
  const autogen = popup.locator('#autogen-button');
  await expect(async () => {
    if (!(await autogen.isVisible())) await popup.locator('.js-new-account').click();
    await expect(autogen).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 10_000 });
  await autogen.click(); // fill a random valid identity
  await popup.locator('#sign-in').click(); // submit → popup closes, sign-in resolves
}

// Contexts whose auth-widget CDN stub is already registered — context.route
// registrations stack, so joining twice from one context must not re-add it.
const cdnStubbedContexts = new WeakSet<object>();

// Disk cache for the gapi scripts the sign-in flow REQUIRES (see
// stubAuthWidgetCdn): keyed by URL hash under node_modules/.cache so it
// survives across tests, runs, and contexts, and never enters version control.
const GAPI_CACHE_DIR = path.join(process.cwd(), 'node_modules', '.cache', 'gcb-e2e-gapi');

async function cacheThroughGapi(route: Route): Promise<void> {
  const request = route.request();
  if (request.method() !== 'GET') return route.fallback();
  const url = request.url();
  const key = createHash('sha1').update(url).digest('hex');
  const file = path.join(GAPI_CACHE_DIR, key);
  if (existsSync(file)) {
    // An unreadable entry falls through to a fresh fetch (and is removed so
    // the next run doesn't trip on it again) rather than failing the sign-in.
    try {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(file) });
    } catch {
      try { rmSync(file, { force: true }); } catch { /* best-effort */ }
    }
  }
  const response = await route.fetch(); // real network — first run only
  const body = await response.body();
  if (response.ok()) {
    try {
      mkdirSync(GAPI_CACHE_DIR, { recursive: true });
      // Atomic publish (CodeRabbit, PR #339): write a private temp file and
      // rename it into place, so an interrupted or concurrent run can never
      // leave a truncated script that every later sign-in would blindly reuse
      // (renames within a directory are atomic on POSIX).
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, body);
      renameSync(tmp, file);
    } catch {
      // Cache write is best-effort — worst case the next run re-fetches.
    }
  }
  return route.fulfill({ response });
}

/**
 * Make the Auth Emulator sign-in flow hermetic-after-warm-up (#317). Two
 * distinct external dependencies stall it when the uplink flakes (observed:
 * repeated TLS handshake failures mid-suite left one popup blank-white and
 * another sign-in's popup never even OPENING, 60–120s test timeouts):
 *
 * 1. The account-chooser widget hard-codes BLOCKING <script>/<link> tags to
 *    unpkg.com / fonts.googleapis.com. Purely cosmetic — the widget's inline
 *    handler-wiring script guards every use with `window.mdc &&` — so those
 *    are fulfilled with empty 200s outright.
 * 2. The emulator's auth relay iframe (firebase-tools handlers.js) REQUIRES
 *    real gapi (`apis.google.com/js/api.js` + the modules gapi.load pulls in)
 *    to deliver the auth event back to the app — signInWithPopup cannot even
 *    open its popup until that iframe initializes, and an empty stub would
 *    break sign-in outright (the emulator itself alerts "check your Internet
 *    connection" on gapi timeout). Those are served through a disk cache:
 *    fetched from the network once ever, then replayed locally forever after.
 */
export async function stubAuthWidgetCdn(page: Page): Promise<void> {
  const ctx = page.context();
  if (cdnStubbedContexts.has(ctx)) return;
  cdnStubbedContexts.add(ctx);
  await ctx.route(/^https:\/\/(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '' }),
  );
  await ctx.route(/^https:\/\/(apis\.google\.com|www\.gstatic\.com)\//, cacheThroughGapi);
}

/** Best-effort dismiss of the analytics disclosure banner — it never blocks
 * the sign-in control, but clearing it keeps the viewport tidy for later

/** Best-effort dismiss of the analytics disclosure banner — it never blocks
 * the sign-in control, but clearing it keeps the viewport tidy for later
 * taps on small/short viewports. */
export async function dismissConsentNotice(page: Page): Promise<void> {
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await gotIt.click();
  }
}

/**
 * The signed-in User's uid, read from the Firebase Auth SDK's own IndexedDB
 * persistence (`firebaseLocalStorageDb` / `firebaseLocalStorage`, the
 * `firebase:authUser:*` entry) in the page under test. Each popup sign-in
 * autogenerates a fresh account, so the uid is only knowable at runtime; the
 * offline case needs it to scope its emulator-observer assertion to THIS
 * Player's board (`events/{eventId}/boards/{uid}`) — a Codex P2 on PR #114:
 * an any-board scan could false-pass on a prompt-text collision with the
 * happy-path Player's already-marked board in the same shared Event.
 */
export async function signedInUid(page: Page): Promise<string> {
  const uid = await page.evaluate(async () => {
    const open = indexedDB.open('firebaseLocalStorageDb');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const store = db
        .transaction('firebaseLocalStorage', 'readonly')
        .objectStore('firebaseLocalStorage');
      const rows = await new Promise<Array<{ fbase_key?: string; value?: { uid?: string } }>>(
        (resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result as never);
          req.onerror = () => reject(req.error);
        },
      );
      return rows.find((r) => r.fbase_key?.startsWith('firebase:authUser:'))?.value?.uid ?? '';
    } finally {
      db.close();
    }
  });
  if (!uid) throw new Error('No signed-in Firebase user found in IndexedDB auth persistence.');
  return uid;
}
