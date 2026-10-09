---
spec_id: w4-app-check
status: proposed
tested: false
reason: Console provisioning, request metrics and deployed-browser acceptance establish enforcement; source tests cannot prove live App Check configuration.
---

# App Check provisioning and enforcement

Ticket #44 adds abuse protection for Cloud Firestore and Cloud Storage. It does not change Membership authority, honor-system Marks or reactive moderation. The owner deferred provisioning until 2026-08-01 in [#44's timing decision](https://github.com/nathanjohnpayne/fiveacross/issues/44#issuecomment-4919347400); that date has passed.

The owner-confirmed scope is both existing Firebase projects, `gaycruisebingo` and `fiveacross`. Inventory each target before changing live configuration. The current source already initializes `ReCaptchaEnterpriseProvider` in `src/firebaseCore.ts` when `VITE_RECAPTCHA_SITE_KEY` is nonempty, with token auto-refresh enabled. The private memory app receives the primary App Check token through its custom provider. No client rewrite is required.

## Provision and distribute, with enforcement off

For each project independently:

1. Inventory its Firebase web-app id, registered App Check provider, existing reCAPTCHA Enterprise website keys, Firestore/Storage enforcement state and deployed client key. Reuse a correctly configured key rather than creating a duplicate. Record identifiers and state, never credentials or App Check tokens.
2. Create or configure the Enterprise website key in that project and register the exact Firebase web app in App Check. Review its allowed domains against [the target inventory](../docs/app/deploy-targets.md), including that project's primary hosts, Firebase aliases, Vercel mirrors and the Five Across handoff origin where applicable. Keep domain validation enabled. Development uses Firebase's debug-provider procedure rather than weakening production domain validation.
3. Set the public site key in the matching `.env.gaycruisebingo` or `.env.fiveacross` file. Named production builds ignore `.env.local`. Set the corresponding Vercel project's Production build environment as well; one project's registration does not attest another project's web app.
4. From a clean, current `main`, use the matching guarded target deploy, then publish and verify its affected mirrors under [the deployment process](../docs/agents/deployment-process.md). Record the Firebase release, mirror deployments and commit. Keep Firestore and Storage enforcement off during this distribution and monitoring stage.
5. Verify the deployed browser successfully exchanges an App Check token without logging it. Exercise sign-in, a legitimate Firestore read/write and a photo/audio Storage upload and authenticated download. Include the primary gameplay app and the named memory transport; source-level provider wiring is insufficient evidence. Check every affected serving origin. Existing mirror sign-in limitations remain explicit and must not be described as a successful smoke check.

The operational sequence follows Firebase's [Enterprise web setup](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider) and [request-metrics guidance](https://firebase.google.com/docs/app-check/monitor-metrics). Provisioning and deployment credentials use the repository's 1Password-backed path. An authentication failure pauses credential-dependent work until attended preflight is restored.

## Monitor, then enforce each service

Record a representative monitoring interval after distribution, with start/end times and the verified, outdated, unknown and invalid request categories for each service and project. Investigate legitimate traffic outside the verified category, including installed clients and origin-specific failures. An elapsed timer, an empty traffic window or one successful token exchange does not establish readiness.

Once observed legitimate usage is healthy, enable enforcement separately for Cloud Firestore and Cloud Storage in the intended project. Read back each service's enforced state, then repeat the legitimate browser read/write/upload/download checks. A named memory client must still work after token refresh and an account transition.

Run a negative probe without an App Check token using an otherwise valid authenticated session and an operation that Security Rules would permit. Compare with the equivalent attested request. Record the App Check rejection without recording Auth tokens, App Check tokens or private payloads; a Rules denial alone does not prove App Check enforcement.

If legitimate requests fail after the flip, return the affected service to unenforced monitoring, verify that readback and repeat the smoke check. Keep the client attestation wiring and investigate the failed cohort before another flip.

Callable-level App Check policy remains #1353. This ticket does not silently change `AUTH_HANDOFF_APP_CHECK`, `BUG_REPORT_APP_CHECK`, `APPROVE_PROMPTS_APP_CHECK` or `SUBMIT_PROMPT_APP_CHECK`, nor does its smoke check satisfy #1411's attended two-account device acceptance.

## Live inventory — 2026-10-09

The project-specific deploy service accounts reached Google APIs using their own 1Password-backed keys. Both projects returned `SERVICE_DISABLED` for Firebase App Check and reCAPTCHA Enterprise. The Gay Cruise Bingo deploy account has App Check config read/update permissions but lacks `serviceusage.services.enable`, `recaptchaenterprise.keys.create` and `recaptchaenterprise.keys.list`. No API was enabled, key created or enforcement changed. Owner console provisioning of both APIs and the two Enterprise website keys is pending; provider registration and monitoring resume afterward.

## Acceptance evidence

Code merge does not establish live enforcement. Keep #44 open until each in-scope project has a completed record:

| Evidence | `gaycruisebingo` | `fiveacross` |
|---|---|---|
| Web-app registration and Enterprise key id | Pending | Pending |
| Allowed serving domains reviewed | Pending | Pending |
| Target and mirror releases with site key | Pending | Pending |
| Monitoring interval and request-category counts | Pending | Pending |
| Firestore and Storage enforced readback | Pending | Pending |
| Attested browser read/write/upload/download, including memory transport | Pending | Pending |
| Otherwise-authorized unattested request rejected by App Check | Pending | Pending |

The runbook is provisioning-only (`tested: false`). Spec alignment and repository checks validate its source integration; the table above carries the separate deployed acceptance proof.
