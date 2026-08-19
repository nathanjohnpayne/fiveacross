# Phase 1—deploy guide

Phase 1 adds the proof system and moderation. It needs the **Blaze** plan (Functions, Cloud Run, Vision API, outbound networking). Deploys go through `op-firebase-deploy` (1Password-backed)—see the root `DEPLOYMENT.md`; do not run `firebase login` / `firebase deploy` directly.

Client code is already wired (proof capture, feed, admin console, App Check hook). This guide covers the backend + config.

## 0. Enable Blaze + APIs

- Upgrade the `gaycruisebingo` project to Blaze (set a budget alert first).
- Enable APIs: **Cloud Vision**, **Cloud Functions**, **Cloud Run**, **Cloud Build**, **Artifact Registry**.

## 1. Cloud Functions (moderation, thumbnails, notifications)

Build the functions package, then deploy through the wrapper:

```bash
cd functions && npm install && npm run build && cd ..
npm run deploy:<target> -- --only functions
```

Deploys `moderateProof` (Storage trigger → SafeSearch flag + thumbnail) plus the admin-notification family: the three producer triggers `notifyProofModeration`, `notifyItemModeration` (`onDocumentWritten` on `events/{eventId}/proofs/{proofId}` and `.../items/{itemId}`) and `notifyAbuseBugReport` (`onDocumentWritten` on the TOP-LEVEL `bugReports/{reportId}`, #670), the Event-lifecycle trigger `settleAdminAlertsOnArchive` (`onDocumentWritten` on `events/{eventId}`), and the scheduled `adminAlertDigest`. **Since #638 the producer triggers no longer send mail**—they only APPEND to the server-owned `events/{eventId}/adminAlerts` queue. `adminAlertDigest` (`*/5 * * * *` UTC) drains active Events into one Theme-styled email per Event per sweep and is the backstop that settles archived Events; `settleAdminAlertsOnArchive` performs that settlement immediately on the `active` → `archived` edge. Both consumers bind the secret, while the Cloud Scheduler job belongs to the digest; a delivery smoke-test must exercise the digest rather than the producer triggers (§ 1a-ii). Player stats are **not** server-recomputed—they stay client-authoritative by design (ADR 0001).

**`moderateProof` (Cloud Vision) is gated OFF by default (issue #126).** `moderateProof` is a Storage trigger on the project's default bucket (`us-east1`) and is pinned to `region: 'us-east1'` to match it (#132)—resolving the earlier `us-central1`-vs-`us-east1` mismatch that would otherwise fail Firebase's deploy-plan validation and block the whole `functions` package. It stays deferred regardless: the `ENABLE_VISION_MODERATION` flag (in `functions/.env` / `functions/.env.<projectId>`, default `false`) controls whether `moderateProof` is exported at all: off (the default), it is not exported and Firebase never sees or validates it, so this deploy brings up the notifiers (and the #43 threshold-hide function once it lands) but **not** Cloud Vision.

The gate has to be honored at **deploy trigger discovery**—the step where Firebase loads the functions module to decide which functions exist. A subtlety (verified against firebase-tools 15.x): firebase-tools spawns that discovery in a subprocess whose environment it builds explicitly from `FIREBASE_CONFIG` + `GCLOUD_PROJECT` and does **not** load `functions/.env[.<projectId>]` into it—those files are read only *after* discovery, to populate the deployed function's **runtime** env and to resolve `firebase-functions/params`. So a plain `process.env` read at module load (and equally a `defineBoolean(...).value()`, which reads the same `process.env` key) would be `undefined` at discovery no matter what the `.env` file says, and the export would never flip on. What firebase-tools *does* guarantee at discovery is `cwd = the functions source dir` plus `GCLOUD_PROJECT`, so `functions/src/visionGate.ts` reads the `.env`/`.env.<projectId>` file itself at discovery (and short-circuits on `process.env` at runtime, where the platform has already injected the value). That makes `functions/.env.<projectId>` genuinely drive the export at deploy.

To enable Vision later (the region pin is already in place, #132): (1) enable the Cloud Vision API on the project, (2) set `ENABLE_VISION_MODERATION=true` in `functions/.env.<projectId>`, and (3) redeploy `--only functions`.

**The sending functions—`adminAlertDigest`, `settleAdminAlertsOnArchive`, and `dailyEngagementEmail`—need the `RESEND_API_KEY` secret set BEFORE (or they will deploy but fail to send).** Since #638 the queue producers (`notifyProofModeration`, `notifyItemModeration`, and `notifyAbuseBugReport`) are NOT among them: they enqueue only, bind no secret, and are unaffected by a missing key. See § 1a below for the one-time secret + the `EMAIL_FROM` / `ADMIN_NOTIFY_EMAIL` / `APP_BASE_URL` params; after setting the secret, (re)deploy the bound functions so the binding takes effect (`npm run deploy:<target> -- --only functions`).

**If a previously deployed project still carries `recomputeStats` and/or `share`:** this deploy is what deletes them—Firebase discovers exports removed from the source and prompts to confirm deleting each live function. Two exports have been removed since the scaffold: `recomputeStats` (#40, ADR 0001—self-writable player stats need no server recompute) and `share` (#39, ADR 0005—the crawler OG page is replaced by on-device Share Cards). A project deployed before either removal will prompt to delete whichever it still carries. The wrapper always runs `firebase deploy --non-interactive`, which stalls on that prompt, so the one-time cleanup deploy must pass the force flag through: `npm run deploy:<target> -- --only functions --force` (extra args pass straight through to `firebase deploy`). Both deletions are expected and required; do not recreate the function in either case. Deleting `share` from Functions does **not** remove the separate Cloud Run OG renderer—that retirement is step 3 below.

**Moderation note:** SafeSearch is tuned to flag only extreme/violent content, **not** raciness (raciness is expected here). It cannot detect minors—user reporting + the admin console remain the primary control. Flagged proofs appear in **Admin → Flagged**.

### 1a. Email notifications (Resend)—one-time secret + params (#101)

The two notifier functions send transactional email via [Resend](https://resend.com). The API key is a **Google Secret Manager secret**, not a plain env var—set it once (value from the 1Password item **"Resend API Key (gaycruisebingo)"**):

```bash
firebase functions:secrets:set RESEND_API_KEY
# …or pipe from 1Password (confirm the field name when you fetch it):
op read "op://Private/<ITEM-UDID>/<field>" | firebase functions:secrets:set RESEND_API_KEY --data-file -
```

Binding the secret to the functions grants the runtime service account `secretmanager.secretAccessor`; `op-firebase-setup` already grants `roles/secretmanager.viewer` (see `DEPLOYMENT.md`). **After setting the secret, (re)deploy `--only functions`** so the bound senders pick it up, then send a live smoke-test to confirm delivery.

The rest of the email config is **non-secret** `firebase-functions/params` (safe defaults baked in; override only if needed). These load from the **Functions source directory**, not the repo-root `.env`: `firebase.json` sets `functions.source: "functions"`, so Functions v2 reads `functions/.env` (all environments) or `functions/.env.<projectId>` (here `functions/.env.gaycruisebingo`). Setting them in the repo-root `.env` has **no effect** on the deployed functions. A committed template lives at `functions/.env.example`:

- `EMAIL_FROM`—default `Gay Cruise Bingo <gaycruisebingo@mail.nathanpayne.com>`. This is independent of the `gaycruisebingo.com` Hosting domain.

  > ⚠️ **`EMAIL_FROM` MUST sit on a domain verified in Resend.** As of 2026-08-05 the Resend account's only verified sending domain is **`mail.nathanpayne.com`** (verified, sending enabled, receiving disabled), which is what the default above now uses (#633). Resend rejects a send from an unverified domain, and `sendEmail` swallows that into a logged `false` (ADR 0001's never-throw contract)—so an override that lands on an unverified domain fails the same way: quietly, with the moderation notifiers and the daily email both logging and delivering nothing. Confirm any per-project override in `functions/.env.<projectId>` is on `mail.nathanpayne.com` (or another domain re-verified in Resend) before deploying it. The Five Across deployment overrides it to `Vacay Bingo <fiveacross@mail.nathanpayne.com>`.
- `EMAIL_FROM_GCB` / `EMAIL_FROM_VACAY` / `EMAIL_FROM_FIVEACROSS`—Edition-aware overrides of `EMAIL_FROM` (#671): both `dailyEngagementEmail` and `adminAlertDigest` resolve the Event's Edition (gcb / vacay / fiveacross) from its host and use the matching one of these, falling back to `EMAIL_FROM` when it is unset. **All three default empty and MUST STAY THAT WAY until the matching brand's sending domain is verified in Resend**—as of this writing none of `gaycruisebingo.com`, `vacaybingo.com`, or `fiveacross.app` are, so leave them blank. Because § 1a-iii's deploy-time param-coverage guard (#767) requires every declared param to have SOME line in `functions/.env.<projectId>`—an omitted line, not a blank value, is what it rejects—**both existing projects' env files need a blank `EMAIL_FROM_GCB=`, `EMAIL_FROM_VACAY=`, and `EMAIL_FROM_FIVEACROSS=` line added before their next Functions deploy**, or that deploy fails at the coverage-guard step. Run `npm run verify:functions-env:gaycruisebingo` / `:fiveacross` ahead of time to confirm.
- `ADMIN_NOTIFY_EMAIL`—optional comma-separated shared-inbox override; empty ⇒ notify the Event `admins` roster (resolved to verified Google emails) only.
- `APP_BASE_URL`—default `https://gaycruisebingo.com`; base for the Admin-console deep link in the email body, and the fallback origin for the daily email's Feed CTA when an Event has no `hostnames` mapping.
- `EMAIL_REPLY_TO`—default empty, meaning **no `Reply-To` header at all** (unchanged behaviour for any project that does not set it). Applies to every transactional send, not just the daily email. Separate from `EMAIL_FROM` because `EMAIL_FROM` must sit on a Resend-**verified sending domain** while replies want a mailbox a human reads—on the Five Across deployment those are different hosts (sent from the verified subdomain, replies to the Google-hosted apex, since the Resend receiving side is off). Set it in `functions/.env.<projectId>`.
- `EMAIL_UNSUBSCRIBE_URL`—default `https://gaycruisebingo.com/unsubscribe`; the public address of the unsubscribe endpoint, used as both the visible Unsubscribe link and the `List-Unsubscribe` header target in the daily engagement email (#616). `firebase.json` rewrites `/unsubscribe` to the `emailUnsubscribe` function (ordered before the SPA catch-all `**` rewrite, which would otherwise swallow it), so this is a first-party `gaycruisebingo.com` link rather than a raw `*.cloudfunctions.net` one—better for deliverability and less phishing-shaped in a mail client. **The rewrite alone does not make the endpoint reachable.** `gaycruisebingo`'s GCP project enforces Domain Restricted Sharing (`constraints/iam.allowedPolicyMemberDomains`), which rejects granting `allUsers` the Cloud Run invoker role on the backing Cloud Run service—and a Hosting rewrite forwards the unauthenticated request into that SAME service, it does not bypass the check. The endpoint only answers once the invoker IAM check has been disabled post-deploy—`scripts/deploy.sh` now does this automatically (§ Cloud Run invoker reconciliation under 1a-i below; same mechanism as `submitBugReport`, `docs/app/bug-reports.md` § Repeat-deploy hardening). **Any project other than `gaycruisebingo` MUST set this**—the default points at this project's own hosted URL, so leaving it would mail an unsubscribe link that cannot honor the opt-out. Set it in `functions/.env.<projectId>` to that project's own canonical host plus `/unsubscribe`.

### 1a-ii. Admin notification digest (#638)

`adminAlertDigest` (an `onSchedule` trigger, `*/5 * * * *` UTC) and `settleAdminAlertsOnArchive` ship with the same `RESEND_API_KEY` secret above; no additional secret is needed. Both pin the Admin-SDK runtime identity, as do the two `notify*Moderation` triggers now that they write the queue. Full behaviour is in `specs/admin-notification-emails.md`.

Three things to check after the deploy:

1. **The Cloud Scheduler job exists**—the same #318 trap as the daily email, and it bites harder here because a jobless digest means the queue fills and nothing is ever mailed: `gcloud scheduler jobs list --project <projectId>` must show a job for `adminAlertDigest` alongside `dailyEngagementEmail` and `unlockDay`.
2. **A recipient resolves.** Recipients are the Event's `admins` roster (verified Firebase Auth emails only) unioned with `ADMIN_NOTIFY_EMAIL`. If neither resolves, alerts queue and nothing sends—which is logged, not lost, but it is silent from the outside. Populate `ADMIN_NOTIFY_EMAIL` per project unless the roster is known to resolve.
3. **Smoke-test the DIGEST, not the triggers.** Report a Prompt in the app (or submit one as a non-admin, which lands `pending`), then wait for the next five-minute sweep. A queue row appearing under `events/{eventId}/adminAlerts` with no email inside two sweeps means the scheduler job or the recipient list is the problem, in that order.

**THREE one-time Firestore TTL policies, and since #670/#859 they are no longer optional housekeeping.** TTL is scoped to a COLLECTION GROUP, so each collection needs its own policy — enabling one does not reach the others:

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=adminAlerts --enable-ttl --project <projectId>
gcloud firestore fields ttls update expiresAt \
  --collection-group=adminAlertBatches --enable-ttl --project <projectId>
gcloud firestore fields ttls update expiresAt \
  --collection-group=bugReportEscalations --enable-ttl --project <projectId>
```

Run all three commands once with `<projectId>` set to `gaycruisebingo` and once with it set to `fiveacross`. The `bugReportEscalations` policy MUST reach `ACTIVE` before deploying the #859 Functions release, because its pending row temporarily contains a raw reporter uid and the policy is the privacy backstop if the scheduler cannot terminalize it. Verify that policy in each project before release:

```bash
gcloud firestore fields ttls list \
  --collection-group=bugReportEscalations --project <projectId> \
  --filter='name:expiresAt AND ttlConfig.state=ACTIVE' \
  --format='table(name,ttlConfig.state)'
```

An empty result or any state other than `ACTIVE` blocks the Functions deploy; repeat the check for both project ids. The ordinary resolver transaction remains the prompt deletion path, and Firestore TTL remains asynchronous rather than a precise deletion deadline.

`adminAlerts` covers two different things now. A drained row is replaced by a payload-free tombstone (`{ sentAt, expiresAt }`) and an archived uncommitted row by a discard tombstone (`{ discardedAt, expiresAt }`). Either id keeps a delayed trigger redelivery from re-queuing the same transition, seven days out to match the redelivery window; both hold only two numbers and no user content. An UNDRAINED row also carries an `expiresAt` (30 days), and that half is a retention backstop: the archive trigger and scheduled sweep should remove an archived Event's queued copy promptly, while TTL remains the final bound if both cannot complete.

`adminAlertBatches` is the sharper of the two: that document holds the FULLY RENDERED email — every pending and hidden item in the batch at once — and it persists for as long as delivery keeps failing. It expires **37 days after being frozen** — a pending row's 30 days plus a week of slack. It has to outlive every row it claims, and by a margin: TTL deletion is asynchronous and unordered across collection groups, so matching deadlines would let an in-flight freeze be deleted while its claimed rows survive, and the next sweep would re-send a digest that already went out. Without this second policy the field is inert and the rendered copy stays forever.

**Enabling the policies is only half of an UPGRADE.** Firestore TTL only ever looks at documents that already carry a timestamp in `expiresAt`, and it does not reap one that lacks the field — so every row and frozen batch written *before* this deploy is invisible to the policy you just enabled. The new archived-Event backstop settles old pending rows, but legacy frozen batches whose delivery kept failing still need their retention deadline. Leaving them is the worst outcome, because the policy is now configured and reaping nothing.

Run the one-time backfill once per project, after deploying the functions and enabling both policies. It stamps only documents that are missing a usable `expiresAt`, anchors each deadline to that document's own `createdAt` (so an old row is already due rather than granted a fresh 30 days), merges rather than overwrites, and is idempotent — a second run finds nothing:

```bash
node scripts/backfill-alert-ttl.mjs --project <projectId> --dry-run   # inspect first
node scripts/backfill-alert-ttl.mjs --project <projectId>
```

### 1a-i. Daily themed engagement email (#616)

`dailyEngagementEmail` (an `onSchedule` trigger, `*/15 * * * *` UTC) and `emailUnsubscribe` (the HTTP unsubscribe endpoint) ship with the same `RESEND_API_KEY` secret above; no additional secret is needed. Both pin the Admin-SDK runtime identity for their own writes, but `emailUnsubscribe` additionally needs the same post-deploy invoker hardening `submitBugReport` needs (#158)—see § Cloud Run invoker reconciliation below. Full behaviour is in `specs/daily-engagement-email.md`.

Two things to check after the deploy:

1. **The Cloud Scheduler job exists**—per #318 the deployer service account has historically lacked `cloudscheduler.admin`, which deploys an `onSchedule` function with no job behind it and no error: `gcloud scheduler jobs list --project <projectId>` must show a job for `dailyEngagementEmail` alongside `unlockDay`.
2. **The unsubscribe endpoint answers**—`curl -sI "$EMAIL_UNSUBSCRIBE_URL?e=x&u=y&t=z"` should return `200` with an HTML confirmation page (a GET never changes state; only a POST does). A `403` means the Cloud Run invoker reconciliation below hasn't run yet, is scoped to a different project, or failed—that invoker check is the only thing gating this endpoint once the `/unsubscribe` rewrite and `EMAIL_UNSUBSCRIBE_URL` are in place (the structural test in `src/recon-share-og.test.ts` covers those two; `tests/synthetic/unsubscribe-invoker.spec.ts` covers this one on every deploy, see below).

#### Cloud Run invoker reconciliation (#158, #768)

`gaycruisebingo`'s GCP project enforces Domain Restricted Sharing (`constraints/iam.allowedPolicyMemberDomains`), which rejects granting `emailUnsubscribe` (and `submitBugReport`) `allUsers` invoker access directly—and the `/unsubscribe` Hosting rewrite (`firebase.json`, ordered before the SPA catch-all `**` rewrite so it isn't swallowed) does NOT get around that: it forwards the unauthenticated request into the same gated Cloud Run service. The fix is to disable the Cloud Run invoker IAM check on the backing service instead.

**This is now automatic.** `scripts/deploy.sh` reconciles the selected subset of `submitBugReport` and `emailUnsubscribe` as Step 2.5—right after `op-firebase-deploy`, before the Cloudflare purge and the post-deploy synthetic. A full Functions deploy selects both; a scoped deploy for one of those exact endpoint names selects only that endpoint, so a first `--only functions:emailUnsubscribe` deploy never fails on the not-yet-created `submitBugReport` service (and vice versa). Firebase also permits `functions:<selector>` to name a codebase or function group, not only one export; unfamiliar selectors therefore conservatively check both endpoints rather than risking an endpoint that was included in the group remaining 403. If that selector was actually an unrelated Function, either protected service may legitimately remain absent after deploy, so the conservative post-deploy checks tolerate only that missing-service result; exact endpoint scopes remain strict after publish. The underlying scripts are idempotent and no-op when the check is already disabled, so a routine `npm run deploy:gaycruisebingo` needs no separate manual step. It used to need one, and relying on someone to remember it is exactly how this broke twice, at different times, for each endpoint (#158, #768). Skip it with `scripts/deploy.sh --skip-invoker` (or `npm run deploy:gaycruisebingo -- --skip-invoker --`) if you need to. The `fiveacross` target skips it automatically (`skipInvokerReconcile: true` in `scripts/build-target.mjs`)—that project's deploy credential is not provisioned with IAM access to a gaycruisebingo Cloud Run service, so running this unconditionally there would fail on a permissions error rather than a no-op; see the comment on that target for the manual override if fiveacross ever needs the same fix.

**It runs even when Firebase calls the deploy a failure — for *any* reason.** This is the part that makes the automation worth having. When a Functions deploy re-tries the rejected `allUsers` binding, `firebase deploy` reports the whole run as FAILED (`Unable to set the invoker for the IAM policy on the following functions:`) even though the function is published and serving—so a `set -e` script would abort at the deploy and never reach the reconciliation, skipping the recovery in exactly the failure mode it exists for. `scripts/deploy.sh` therefore captures the deploy's exit status instead of aborting on it, reconciles, and only then honours the status. The deploy **still fails** afterwards (a nonzero `firebase deploy` means something missed its intended state, and the Cloudflare purge and synthetic are skipped as before)—but the endpoints are no longer left 403ing while you debug, and a re-run is a cheap idempotent way to finish.

The trigger is deliberately the deploy's *scope*, not its error text. What resets the invoker annotation is a **successful** Functions release, which can complete long before the overall command exits: a multi-surface deploy that releases Functions and then fails on Hosting, or a Functions deploy where `emailUnsubscribe` updates before a different function errors, both end nonzero without the org-policy string anywhere in the output. Keying the recovery on that string therefore skipped it in precisely those states, leaving both endpoints 403ing because something unrelated also failed. So `scripts/deploy.sh` reads `--only` / `--except` off the deploy arguments instead: if Functions could have been released, it reconciles, whatever happened afterwards. An unfamiliar `functions:<selector>` in `--only` conservatively checks both endpoints. This repo's known `functions:default` exclusion removes its sole codebase; other unfamiliar exclusions keep both endpoints selected, because they may name only an unrelated Function while the protected endpoints still release. A `--only hosting` deploy skips both invoker steps entirely—it cannot touch the annotation, so it must not be gated on `gcloud` either.

**Its credential is the deploy's own service-account key, and it is checked before anything is published.** The reconciliation shells out to `gcloud`, which resolves its **own** credential chain. When `GOOGLE_APPLICATION_CREDENTIALS` is absent, `scripts/deploy.sh` materializes the same project Firebase-vault SA key that `op-firebase-deploy` will use and holds it only for the deploy; the invoker helper activates it in an isolated gcloud config. A deploy preflight still avoids that extra vault read and prepares every deploy secret in one burst, but it is no longer required for the ordinary named deploy path. Step 1.6 runs each selected invoker script read-only (`--dry-run`) before `op-firebase-deploy`, and aborts with `NOTHING HAS BEEN PUBLISHED` if its credential or service check fails. `--skip-invoker` skips the check and the reconciliation together.

Deploy preflight exports `GOOGLE_APPLICATION_CREDENTIALS` pointing at the per-project Firebase-vault **service-account** key, and neither `gcloud` path can authenticate from that variable: `scripts/gcloud/gcloud` mints tokens from an `authorized_user` ADC and rejects a service-account file outright (`points to an unusable credential file`), while the real `gcloud` CLI ignores `GOOGLE_APPLICATION_CREDENTIALS` entirely for its own auth—it is an ADC variable for client libraries. Earlier rounds of #768 papered over this by telling the operator to `unset GOOGLE_APPLICATION_CREDENTIALS`, which made every routine preflighted deploy abort at Step 1.6 until they did. `scripts/set-cloud-run-invoker.sh` now consumes that key directly instead, via the one path `gcloud` supports for it—`gcloud auth activate-service-account` against a throwaway `CLOUDSDK_CONFIG` directory it deletes on exit, leaving the machine's own gcloud account selection and ADC untouched. That key is also the *right* identity: `scripts/firebase/op-firebase-setup` grants the `firebase-deployer` SA `roles/run.admin`, so it is the same identity that just deployed these services. No manual `unset` is needed for a deploy; the rule in `docs/agents/deployment-process.md` still applies to broad ad-hoc `gcloud` work.

**Its coordinates are pinned to the selected deploy target.** `scripts/set-bug-report-invoker.sh` and `scripts/set-email-unsubscribe-invoker.sh` honour `BUG_REPORT_*` / `EMAIL_UNSUBSCRIBE_*` overrides so a manual repair can name another project, region, or renamed service—but those exports survive in a shell, and an automatic call that inherited them would reconcile whatever the last repair named. A leftover `EMAIL_UNSUBSCRIBE_PROJECT=fiveacross` during a `gaycruisebingo` deploy would make both prechecks pass against Five Across while the just-reset `gaycruisebingo` services kept 403ing, with every log line reporting success. So the automatic path clears all six variables and re-pins the project from `DEPLOY_TARGET_PROJECT`, which `scripts/deploy-target.mjs` stamps from the selected target. A manual run is unaffected: invoke the scripts directly and the overrides work as documented.

**It is also detected independently, not just prevented.** The annotation can be reset by a `firebase deploy` run outside `scripts/deploy.sh`, so automatic reconciliation alone is not enough. `tests/synthetic/unsubscribe-invoker.spec.ts`—part of the Step 4 post-deploy synthetic gate (`npm run test:synthetic`), and of the every-15-minutes `synthetic-uptime` workflow—sends one unauthenticated GET to `/unsubscribe` with no query params and fails loudly if it gets back `403` (blocked at the Cloud Run invoker layer) instead of the healthy `400` (reached application code, just missing a token). The post-deploy invocation is marked as deployment evidence, so it also fails if `/unsubscribe` serves the SPA shell: a Functions-only release cannot quietly start mailing the hosted URL before Hosting has shipped the rewrite. Before that first Hosting rollout, the scheduled monitor treats the shell as the known baseline only after a raw-function GET returns `400`; it still pages on a raw `403` or other endpoint error, so the rollout grace cannot hide an IAM regression. That grace is bounded to 72 hours from the commit that introduced the probe; after that it fails on the shell too, so a later Hosting rollback or scoped regression cannot remain silently skipped.

A `200` carrying the SPA shell is the third case, and it is **time-boxed, not skipped forever**. That response means Hosting's `**` catch-all answered, which looks identical whether the `/unsubscribe` rewrite has not been deployed to this origin yet or was deployed and has since been rolled back or dropped from a scoped deploy—no header, status, or body separates them. Before `ROLLOUT_ENFORCE_FROM` (a constant in that spec) the probe skips, so the scheduled monitor cannot page during the merge-to-deploy window; from that instant on the same response **fails**, naming both causes, because by then either one means every emailed unsubscribe link opens the app instead of the opt-out page. Once a deploy has been confirmed to serve `400`, that whole branch can be deleted. `src/recon-share-og.test.ts` covers the source side—it fails if the rewrite is missing from `firebase.json` or ordered after the catch-all—but it can only see the repo, never what Hosting is actually serving, which is the drift the deadline covers.

**The manual, break-glass path still exists** for diagnosing a failure or fixing a project the automatic step doesn't cover (e.g. `fiveacross`, via the `*_PROJECT` overrides):

```bash
scripts/set-email-unsubscribe-invoker.sh            # idempotent; no-ops if already disabled
scripts/set-email-unsubscribe-invoker.sh --dry-run   # preview only
```

See `docs/app/bug-reports.md` § Repeat-deploy hardening for the full mechanism; both scripts are thin wrappers over the shared `scripts/set-cloud-run-invoker.sh`.

Nothing sends until an Event admin turns it on: `events/{eventId}.settings.dailyEmailEnabled` is read as OFF unless explicitly `true`.

### 1a-iii. Deploy-time param-coverage guard (#767)

`functions/.env.<projectId>` is hand-maintained and gitignored, with nothing keeping it in sync as `functions/src/params.ts` gains new params over time. That drifted in production on 2026-08-13: `EMAIL_REPLY_TO` (#724) and `EMAIL_UNSUBSCRIBE_URL` (#616) were both declared in `params.ts` but missing from `functions/.env.gaycruisebingo`. `firebase deploy`'s `resolveParams` partitions purely on whether a declared param's **name** is present in the dotenv files it merges (`functions/.env` then `functions/.env.<projectId>`, never `functions/.env.local`—that file is an emulator-only overlay, see `scripts/e2e-functions-env.mjs`). A `default:` in `params.ts` does **not** exempt a param from that partition; it only supplies the interactive prompt's default answer. Since a non-interactive `firebase deploy` cannot answer that prompt, a missing key hard-fails **mid-deploy**—potentially after other targets in the same run (e.g. Hosting) have already published.

`scripts/deploy.sh` now checks this **before build, before anything is published**: it derives the required non-secret param set from `functions/src/params.ts` (reusing the same reachable-module scan `scripts/e2e-functions-env.mjs` built for the identical emulator-side failure, PR #730—see `scripts/validate-functions-env.mjs`) and validates it against the same files `firebase deploy` actually merges for the selected project. A missing key fails loudly, naming every param that needs to be added, rather than letting Firebase's own mid-deploy prompt-that-can't-be-answered do it. `defineSecret` values (`RESEND_API_KEY`) are out of scope—those live in Secret Manager, never in a dotenv file.

The check is skipped automatically for a deploy that does not release Functions (e.g. `--only hosting`), and can be bypassed with `scripts/deploy.sh --skip-env-check` (or `npm run deploy:<target> -- --skip-env-check --`)—break-glass only; skipping it just means the same failure surfaces later, mid-deploy, at Firebase's own param resolution instead. Run it manually any time with `npm run verify:functions-env:gaycruisebingo` / `npm run verify:functions-env:fiveacross`, or directly: `node scripts/validate-functions-env.mjs functions/src/index.ts functions <projectId>`.

### 1b. One-time rollout sweep for the server-authoritative hide (#43)

The threshold auto-hide (`hideItemAtThreshold` / `hideProofAtThreshold`) fires on a **change**—a report crossing the threshold, or the admin lowering the threshold. Content that had ALREADY crossed the threshold under Phase 0 (before these functions existed) never crosses again and never triggers a decrease, so on first deploy it would stay `status: 'active'` and directly readable despite meeting the server-hide bar. Run the one-time rollout sweep **once, right after the first `--only functions` deploy above**, to hide that pre-existing backlog:

```bash
# The functions package must be built + installed (the deploy step above did this).
GOOGLE_CLOUD_PROJECT=gaycruisebingo node scripts/backfill-hide.mjs           # every event
GOOGLE_CLOUD_PROJECT=gaycruisebingo node scripts/backfill-hide.mjs <eventId> # one event
```

`scripts/backfill-hide.mjs` reuses the deployed hide core (`functions/src/autohide.ts`) verbatim—the same active-only gate and the same transactional re-read guard—so it hides only active docs whose `reportCount` meets each Event's current `reportHideThreshold`, skips flagged/pending/already-hidden content, and re-confirms live state per doc (it will not undo an admin Clear-reports mid-sweep). It is **idempotent**—safe to re-run; a second run hides nothing new. Credentials are Application Default Credentials (`gcloud auth application-default login`) or a gitignored `serviceAccountKey.json`, exactly like `scripts/seed.mjs`. This is a rollout-only step: once the functions are live, all new crossings are hidden automatically and the sweep never needs to run again.

## 2. App Check (abuse protection)

1. Google Cloud console → reCAPTCHA Enterprise → create a **Website** key for `gaycruisebingo.com` (+ `localhost` for dev).
2. Firebase console → App Check → register the web app with that site key.
3. Set `VITE_RECAPTCHA_SITE_KEY` in each affected target file (`.env.gaycruisebingo` or `.env.fiveacross`), rebuild, and redeploy that target's hosting. Named production builds deliberately ignore `.env.local`.
4. In App Check, **enforce** on Cloud Firestore and Cloud Storage once traffic looks healthy.

## 3. Retire the old Cloud Run OG renderer (one-time, only if you deployed it before)

The server-side OG renderer was removed (ADR 0005, #39): its source (`cloud-run/og-renderer/`) and the `share` Function that pointed at it are gone from this repo, and Share Cards are now generated on-device. But the renderer was deployed **separately**—a container on Cloud Run via `gcloud run deploy`, **outside** Firebase Hosting/Functions—so deleting the source and running the Firebase deploys above does **not** remove the live service. If you ran the old Phase 1 instructions, the container stays publicly reachable and billable until you delete it explicitly:

```bash
# Service name/region the removed cloud-run/og-renderer/README.md deployed with.
gcloud run services delete og-renderer --region us-central1 --project gaycruisebingo
```

If you deployed it under a different name or region, list your services first and delete the right one:

```bash
gcloud run services list --project gaycruisebingo
gcloud run services delete <service-name> --region <region> --project gaycruisebingo
```

This is a one-time retirement step for anyone who previously stood the renderer up; on a project that never deployed it there is nothing to delete.

## 4. Storage & rules

`storage.rules` already restricts proof/avatar uploads by owner, MIME type, and size. Deploy:

```bash
npm run deploy:<target> -- --only storage,firestore:rules,firestore:indexes
```

**Do not lock player-stat writes—they stay client-authoritative by design (ADR 0001).** The honor system makes `players/{uid}` self-writable: each Player owns its own `bingoCount`, `squaresMarked`, `firstBingoAt`, and `blackout`. There is no server-side stat recompute to make those fields authoritative, so there is nothing to "harden" toward—do **not** tighten the `players/{uid}` rule to profile-fields-only / admins-only. Such a lock has nothing backing it and would break the client stat writes in `joinAndDeal` and `setMark` (`src/data/api.ts`) and in `attachProof` (`src/data/proofs.ts`), making joins and marks **fail** with a permission error.

## 5. What each Phase 1 piece gives you

- **Proof capture** (`ProofSheet`)—photo (camera), audio (MediaRecorder), or a text callout; images are downscaled client-side before upload.
- **Proof Feed**—live activity stream; report/delete.
- **Verified mode**—marks go `pending` and create a claim; admins confirm/reject in the console (stats recompute on resolve).
- **Admin console**—claim mode, default theme, pending claims, flagged/reported proofs, prompt moderation.

Share Cards (BINGO + Leaderboard) are generated on-device and are not part of this backend—see ADR 0005.

## Verification status

The **client** (proof UI, feed, admin, App Check hook) builds with the app. The **functions** package is standalone—install and build it in its own folder (`npm install && npm run build`) before first deploy.
