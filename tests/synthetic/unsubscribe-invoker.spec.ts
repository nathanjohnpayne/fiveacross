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
// THE ROLLOUT WINDOW IS TIME-BOXED, NOT PERMANENT (#768 r3 → r4).
//
// This file is matched by `playwright.synthetic.config.ts` (`testDir:
// ./tests/synthetic`), and `.github/workflows/synthetic-uptime.yml` runs `npm
// run test:synthetic` from `main` every 15 minutes — so the assertion goes
// live the moment the commit merges, which is BEFORE the manually-run Hosting
// deploy that ships the `/unsubscribe` rewrite. A bare `expect(400)` would
// page for the whole merge-to-deploy window while the deployed app is
// unchanged and perfectly healthy.
//
// The three observable states are:
//
//   403                  → the Cloud Run invoker check is blocking. Real
//                          regression, fail loudly, always.
//   400                  → healthy: the request reached application code.
//   200 + the SPA shell  → Firebase Hosting's `**` → /index.html catch-all
//                          answered, so `/unsubscribe` is not routed to the
//                          function at this origin.
//
// That third state is genuinely AMBIGUOUS from outside: "the rewrite has not
// been deployed here yet" and "the rewrite was deployed and has since been
// rolled back, dropped from a scoped deploy, or otherwise lost" produce a
// byte-identical response. No header, status, or body distinguishes them —
// which is why r3's unconditional skip was a permanent blind spot: after
// emails start carrying `/unsubscribe` links, every one of them opens the SPA
// instead of the opt-out page and this probe stays green forever.
//
// Since no signal in the RESPONSE separates the two, the separator has to be
// TIME. Before ROLLOUT_ENFORCE_FROM the ambiguity resolves toward "not
// deployed yet" and the probe skips; after it, the shell is a FAILURE naming
// both possible causes, because by then either one is a real problem an
// operator must act on — a rewrite that never shipped is as broken as one that
// regressed. The window is deliberately short and deliberately hard-coded
// rather than env-configurable: an override would be set once during rollout
// and never unset, recreating the permanent skip through a different door.
//
// Once a deploy has been confirmed to serve 400 here, this whole branch can be
// deleted and the probe reduced to `expect(400)`.
//
// `src/recon-share-og.test.ts` remains the structural half — it parses
// firebase.json and fails if the `/unsubscribe` rewrite is missing or ordered
// after the SPA catch-all — but it can only see the SOURCE, never what Hosting
// is actually serving, which is precisely the drift this deadline covers.
const ROLLOUT_ENFORCE_FROM = Date.parse('2026-08-28T00:00:00Z');

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
    const enforceFrom = new Date(ROLLOUT_ENFORCE_FROM).toISOString();

    if (Date.now() >= ROLLOUT_ENFORCE_FROM) {
      throw new Error(
        `${UNSUBSCRIBE_URL} served the SPA shell, not the opt-out page — Firebase Hosting's ** catch-all ` +
          'answered, so /unsubscribe is not routed to emailUnsubscribe at this origin. Emails already carry ' +
          `this link (EMAIL_UNSUBSCRIBE_URL in functions/src/params.ts), and the rollout window closed at ` +
          `${enforceFrom}, so every unsubscribe link opens the app instead of the opt-out page right now.\n\n` +
          'Two causes, both real:\n' +
          '  • Hosting was rolled back, or deployed with a scope that excluded it, after the rewrite shipped.\n' +
          '  • The rewrite never shipped to this origin at all.\n\n' +
          'Either way: confirm the /unsubscribe rewrite is present and ordered BEFORE the ** catch-all in ' +
          'firebase.json, then deploy Hosting (npm run deploy:gaycruisebingo:hosting). ' +
          'Rolling back will not fix this. See docs/app/phase-1-deploy.md § 1a-i.',
      );
    }

    test.skip(
      true,
      `${UNSUBSCRIBE_URL} served the SPA shell, so the /unsubscribe Hosting rewrite is not deployed at this ` +
        `origin yet. This grace lasts until ${enforceFrom}; after that the same response FAILS, because by ` +
        'then a shell here means either the rewrite never shipped or it regressed, and both need a human. ' +
        'Deploy Hosting to clear it.',
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
