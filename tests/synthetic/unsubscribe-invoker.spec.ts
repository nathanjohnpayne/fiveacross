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
const SYNTHETIC_URL = process.env.SYNTHETIC_URL ?? 'https://gaycruisebingo.com/';
const UNSUBSCRIBE_URL = new URL('/unsubscribe', SYNTHETIC_URL).toString();

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

  expect(status, `expected HTTP 400 (endpoint reached, no token supplied); got HTTP ${status}`).toBe(400);
});
