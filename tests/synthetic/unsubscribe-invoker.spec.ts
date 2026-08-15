import { test, expect } from '@playwright/test';

// Production synthetic (issue #768): assert the deployed `/unsubscribe`
// endpoint is reachable — the signal a passing app-mount check (app-mounts.spec.ts)
// cannot see at all, since it exercises a completely different code path (a
// server-side Cloud Function, not the client bundle).
//
// docs/app/phase-1-deploy.md § 1a-i documents the mechanism this guards: the
// GCP project's Domain Restricted Sharing org policy rejects an `allUsers`
// Cloud Run invoker binding, so `emailUnsubscribe` only answers once the
// invoker IAM check is explicitly DISABLED on its backing Cloud Run service
// (scripts/set-email-unsubscribe-invoker.sh). `scripts/deploy.sh` now runs
// that reconciliation automatically after every deploy (Step 2.5) — but the
// annotation can also be reset by a `firebase deploy` run OUTSIDE this
// script, so prevention alone is not enough. This is the independent
// detection half: it fails the deploy loudly on a regression regardless of
// why the invoker check reverted, rather than relying on someone to notice a
// player's unsubscribe link silently 403ing.
//
// A GET with NO query params is deliberate. `handleUnsubscribeRequest`
// (functions/src/emailOptOut.ts) reads `e`/`u`/`t` before doing anything
// else and returns HTTP 400 ("That link is incomplete") the instant
// application code runs — so 400 is the HEALTHY signal here (the request
// reached the function). HTTP 403 is what the Cloud Run invoker-IAM layer
// returns instead when it blocks the request BEFORE application code ever
// sees it (Google's own error page, never this app's JSON/HTML). No real
// token is ever sent, so this probe has no side effect on any participant's
// opt-out state.
//
// ROLLOUT-COMPATIBLE BY CONSTRUCTION (#768 r2 review). This file is matched by
// `playwright.synthetic.config.ts` (`testDir: ./tests/synthetic`), and
// `.github/workflows/synthetic-uptime.yml` runs `npm run test:synthetic` from
// `main` every 15 minutes — so the assertion goes live the moment the commit
// merges, which is BEFORE the manually-run Hosting deploy that ships the
// `/unsubscribe` rewrite. A bare `expect(400)` would therefore page for the
// whole merge-to-deploy window (and again on any project whose Hosting has not
// yet received the rewrite) while the deployed app is unchanged and perfectly
// healthy. Rather than gate this behind a flag someone has to remember to flip
// after the rollout — the same remember-to-do-it failure #768 exists to
// delete — the probe reads the rollout state off the response itself:
//
//   200 + the SPA shell → the rewrite is NOT deployed at this origin yet.
//                         Firebase Hosting's `**` → /index.html catch-all
//                         answered instead. Skip: there is no endpoint to
//                         regress, and nothing an operator can act on.
//   403                  → the rewrite IS live and the Cloud Run invoker check
//                         is blocking. Real regression, fail loudly.
//   400                  → healthy: the request reached application code.
//
// The self-healing property is the point: the first deploy that ships the
// rewrite flips this probe from skipping to enforcing with no second commit.
// The cost is that a regression which REMOVED the rewrite would skip rather
// than fail — that case is covered structurally instead, by
// src/recon-share-og.test.ts, which parses firebase.json and fails if the
// `/unsubscribe` rewrite is missing or ordered after the SPA catch-all.
const SYNTHETIC_URL = process.env.SYNTHETIC_URL ?? 'https://gaycruisebingo.com/';
const UNSUBSCRIBE_URL = new URL('/unsubscribe', SYNTHETIC_URL).toString();

// The Vite-built shell always carries the app's mount point. `emailUnsubscribe`
// never renders it — its pages come from `renderPage` in
// functions/src/emailOptOut.ts — so this distinguishes "Hosting served the SPA
// fallback" from "the function answered", without depending on the function
// ever returning 200 to a param-less GET (it does not).
const SPA_SHELL_MARKER = '<div id="root">';

test('the unsubscribe endpoint is reachable (no Cloud Run invoker regression)', async ({ request }) => {
  const response = await request.get(UNSUBSCRIBE_URL);
  const status = response.status();

  if (status === 403) {
    throw new Error(
      `emailUnsubscribe 403 at ${UNSUBSCRIBE_URL} — blocked at the Cloud Run invoker IAM layer, ` +
        'never reaching application code. Every emailed unsubscribe link is broken right now. Restore it with:\n\n' +
        '  scripts/set-email-unsubscribe-invoker.sh\n\n' +
        'scripts/deploy.sh already runs this automatically as Step 2.5 unless --skip-invoker was passed — ' +
        'a failure here after a routine deploy means that reconciliation itself needs a human look ' +
        '(permissions, org policy, wrong project). See docs/app/phase-1-deploy.md § 1a-i.',
    );
  }

  if (status === 200 && (await response.text()).includes(SPA_SHELL_MARKER)) {
    test.skip(
      true,
      `${UNSUBSCRIBE_URL} served the SPA shell, so the /unsubscribe Hosting rewrite is not deployed at this ` +
        'origin yet — there is no endpoint here to regress. This check starts enforcing by itself on the ' +
        'first Hosting deploy that ships the rewrite (firebase.json). If it is STILL skipping well after ' +
        'that deploy, the rewrite did not ship: check firebase.json and re-deploy Hosting.',
    );
    return;
  }

  expect(status, `expected HTTP 400 (endpoint reached, no token supplied); got HTTP ${status}`).toBe(400);
});
