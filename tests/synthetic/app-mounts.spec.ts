import { test, expect } from '@playwright/test';

// Production synthetic (issue #142): assert the DEPLOYED app actually mounts and
// renders its root — the signal a Hosting-200 check misses. It would have FAILED
// during the 2026-07-09 outage (#141), where the shell returned 200 but the
// client JS threw `auth/invalid-api-key` on init and painted a blank page.
//
// Two assertions, both high-level and flake-resistant:
//   1. The signed-out root renders — the SignIn gate App shows on `!user`
//      (src/components/SignIn.tsx). Its presence proves React mounted AND
//      Firebase init did not throw before first paint.
//   2. No Firebase init error (`auth/invalid-api-key` et al.) and no uncaught
//      exception reached the console during load.
//
// Load-and-assert only: it never signs in or writes, so it creates no Auth /
// Firestore / Storage side effects on the real project.

// Firebase config/init failures that manifest as a blank page. `auth/invalid-api-key`
// is the exact #141 signature; the alternates are the same class (bad/rotated
// key, wrong project, init failure) that also crash the client before first paint.
const FIREBASE_INIT_ERROR = /auth\/invalid-api-key|invalid-api-key|Firebase:[^]*\(auth\/|Failed to initialize Firebase/i;

// The target origin. Navigate to the FULL url rather than `page.goto('/')`,
// which always resolves to the origin root and would silently drop any path in
// a `SYNTHETIC_URL` like https://host/app/. Mirrors the config default.
const SYNTHETIC_URL = process.env.SYNTHETIC_URL ?? 'https://gaycruisebingo.com/';

// The mount signal, deliberately free of marketing copy.
//
// This used to be `getByRole('heading', { name: 'GAY CRUISE BINGO' })` — the
// `gcb` Edition's wordmark. Once Editions shipped (#543, ADR 0009) that string
// became per-host copy: a Vacay host renders `VACAY BINGO`, so the assertion
// could NEVER match there. Reproduced 2026-08-05 deploying the Bodega Bay host
// (https://bodega-bay.vacaybingo.com): the app mounted cleanly — both error
// assertions below passed — and the synthetic still failed, so `scripts/deploy.sh`
// told the operator to roll back a completely healthy release, two days before
// the event it was deployed for.
//
// So the signal must not be brand copy. `src/editions.test.ts` and
// `signin-edition-brand.test.tsx` already guard the copy itself; uptime should
// not. Two accepted forms, whichever the live build carries:
//
//   • `[data-testid="signin-gate"]` — the contract, added alongside this change
//     on the SignIn gate root. Explicit, Edition-free, and visible to anyone
//     editing that component.
//   • `.signin input[type="checkbox"]` — the 18+ acknowledgement, which every
//     build shipped before that testid already renders. Kept ONLY so the window
//     between this merging and each host's next deploy does not turn the
//     scheduled uptime check (.github/workflows/synthetic-uptime.yml) into a
//     false outage against a not-yet-redeployed origin. Drop it once every live
//     host has shipped a build containing the testid.
//
// Both are unique to the signed-out gate: `ErrorBoundary` and `DealError` reuse
// the `.signin` shell but render neither, so a crash screen still reads as
// "did not mount" rather than passing this check.
const MOUNT_SIGNAL = '[data-testid="signin-gate"], .signin input[type="checkbox"]';

test('the deployed app mounts and renders its root', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.goto(SYNTHETIC_URL, { waitUntil: 'domcontentloaded' });

  // A generous window so a slow-but-working cold load still passes; a
  // crashed/blank app never renders it. Errors keep accumulating in the
  // listeners above during this wait, so a crash-on-init is reported by the
  // precise assertions below rather than a bare timeout.
  const rendered = await page
    .locator(MOUNT_SIGNAL)
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  // 1. No Firebase init crash (`auth/invalid-api-key` et al.) — asserted first so
  //    the #141 class produces its precise signature, not a generic mount timeout.
  const firebaseInitErrors = [...consoleErrors, ...pageErrors].filter((m) => FIREBASE_INIT_ERROR.test(m));
  expect(
    firebaseInitErrors,
    `Firebase init error(s) detected during load: ${firebaseInitErrors.join(' | ')}`,
  ).toEqual([]);

  // 2. No uncaught exception at all during load. The app is designed to surface
  //    failures through UI state, never an unhandled throw, so any pageerror is a
  //    real regression.
  expect(pageErrors, `uncaught exception(s) during load: ${pageErrors.join(' | ')}`).toEqual([]);

  // 3. The root actually rendered — the generic "did not mount" signal that
  //    catches a blank page even when nothing threw.
  expect(
    rendered,
    `the sign-in gate never rendered — the app did not mount (blank page). Looked for ${MOUNT_SIGNAL}`,
  ).toBe(true);
});
