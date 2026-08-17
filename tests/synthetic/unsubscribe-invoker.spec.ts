import { test } from '@playwright/test';

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
// The scheduled monitor starts running as soon as this change merges, before
// the first Hosting deploy can ship the rewrite. In that unchanged pre-rollout
// state the shell response is ambiguous, so the scheduled run checks the RAW
// function URL for IAM health and records a skip rather than opening a false
// Hosting-outage issue. A deployment check is different evidence: deploy.sh
// marks it with SYNTHETIC_DEPLOYMENT_CHECK=true, so a shell response there is a
// real failed release and must fail immediately. No calendar deadline can
// reliably distinguish these states; the deployment context does.
//
// The raw URL is deliberately limited to this scheduled grace path. Email
// links use the first-party Hosting URL, and a deploy must prove that exact
// address routes correctly. The raw function check merely ensures the grace
// cannot hide a Cloud Run IAM regression while Hosting has not been released.
const DEPLOYMENT_CHECK = process.env.SYNTHETIC_DEPLOYMENT_CHECK === 'true';
const RAW_UNSUBSCRIBE_URL =
  process.env.EMAIL_UNSUBSCRIBE_RAW_URL ?? 'https://us-central1-gaycruisebingo.cloudfunctions.net/emailUnsubscribe';

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
    if (DEPLOYMENT_CHECK) {
      throw new Error(
        `${UNSUBSCRIBE_URL} served the SPA shell, not the opt-out page — Firebase Hosting's ** catch-all ` +
          'answered, so /unsubscribe is not routed to emailUnsubscribe at this origin. Emails already carry ' +
          `this link (EMAIL_UNSUBSCRIBE_URL in functions/src/params.ts), and this deploy's post-release ` +
          `check proves Hosting did not ship the rewrite, so every unsubscribe link opens the app right now.\n\n` +
          'Two causes, both real:\n' +
          '  • Hosting was rolled back, or deployed with a scope that excluded it, after the rewrite shipped.\n' +
          '  • The rewrite never shipped to this origin at all.\n\n' +
          'Either way: confirm the /unsubscribe rewrite is present and ordered BEFORE the ** catch-all in ' +
          'firebase.json, then deploy Hosting (npm run deploy:gaycruisebingo:hosting). ' +
          'Rolling back will not fix this. See docs/app/phase-1-deploy.md § 1a-i.',
      );
    }

    // The scheduled monitor sees the unchanged pre-rollout deployment until
    // Hosting is first released. It must not treat that known baseline as a
    // page, but it also must not let the grace conceal a Cloud Run IAM 403.
    const rawResponse = await request.get(RAW_UNSUBSCRIBE_URL);
    const rawStatus = rawResponse.status();
    if (rawStatus === 403) {
      throw new Error(
        `emailUnsubscribe 403 at ${RAW_UNSUBSCRIBE_URL} — the raw function is blocked at the Cloud Run ` +
          'invoker IAM layer while the scheduled pre-rollout Hosting grace is active. Restore it with ' +
          '`scripts/set-email-unsubscribe-invoker.sh`, then re-run this workflow.',
      );
    }
    if (rawStatus !== 400) {
      throw new Error(
        `emailUnsubscribe probe failed at ${RAW_UNSUBSCRIBE_URL}: expected HTTP 400 from the raw function ` +
          `(endpoint reached, no token supplied); got HTTP ${rawStatus}. The scheduled Hosting grace cannot ` +
          'treat that endpoint failure as healthy.',
      );
    }

    test.skip(
      true,
      `${UNSUBSCRIBE_URL} served the SPA shell in the unchanged scheduled pre-rollout state; the raw function ` +
        `answered HTTP 400, so Cloud Run IAM is healthy. A deploy-time synthetic check does not grant this ` +
        'grace and will fail until Hosting ships the /unsubscribe rewrite.',
    );
    return;
  }

  if (status !== 400) {
    // Keep this marker stable: synthetic-uptime.yml classifies outage advice
    // from the probe's explicit diagnostics. Without it, a 404/429/5xx would
    // fall through to the app-mount remediation even though /unsubscribe—not
    // the rendered client—failed. The status still makes the root symptom
    // visible without guessing whether it is Hosting, Cloud Run, or an app
    // failure behind the endpoint.
    throw new Error(
      `emailUnsubscribe probe failed at ${UNSUBSCRIBE_URL}: expected HTTP 400 ` +
        `(endpoint reached, no token supplied); got HTTP ${status}. Inspect the endpoint and its ` +
        'Hosting rewrite before treating this as an app-mount failure.',
    );
  }
});
