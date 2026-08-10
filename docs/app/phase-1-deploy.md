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

Deploys `moderateProof` (Storage trigger → SafeSearch flag + thumbnail) plus the admin-notification family: the two document triggers `notifyProofModeration` and `notifyItemModeration` (`onDocumentWritten` on `events/{eventId}/proofs/{proofId}` and `.../items/{itemId}`) and the scheduled `adminAlertDigest`. **Since #638 the two document triggers no longer send mail**—they only APPEND to the server-owned `events/{eventId}/adminAlerts` queue, and `adminAlertDigest` (`*/5 * * * *` UTC) drains it into one Theme-styled email per Event per sweep. So the secret binding and the Cloud Scheduler job both belong to the DIGEST, and a delivery smoke-test must exercise the digest rather than the triggers (§ 1a-ii). Player stats are **not** server-recomputed—they stay client-authoritative by design (ADR 0001).

**`moderateProof` (Cloud Vision) is gated OFF by default (issue #126).** `moderateProof` is a Storage trigger on the project's default bucket (`us-east1`) and is pinned to `region: 'us-east1'` to match it (#132)—resolving the earlier `us-central1`-vs-`us-east1` mismatch that would otherwise fail Firebase's deploy-plan validation and block the whole `functions` package. It stays deferred regardless: the `ENABLE_VISION_MODERATION` flag (in `functions/.env` / `functions/.env.<projectId>`, default `false`) controls whether `moderateProof` is exported at all: off (the default), it is not exported and Firebase never sees or validates it, so this deploy brings up the notifiers (and the #43 threshold-hide function once it lands) but **not** Cloud Vision.

The gate has to be honored at **deploy trigger discovery**—the step where Firebase loads the functions module to decide which functions exist. A subtlety (verified against firebase-tools 15.x): firebase-tools spawns that discovery in a subprocess whose environment it builds explicitly from `FIREBASE_CONFIG` + `GCLOUD_PROJECT` and does **not** load `functions/.env[.<projectId>]` into it—those files are read only *after* discovery, to populate the deployed function's **runtime** env and to resolve `firebase-functions/params`. So a plain `process.env` read at module load (and equally a `defineBoolean(...).value()`, which reads the same `process.env` key) would be `undefined` at discovery no matter what the `.env` file says, and the export would never flip on. What firebase-tools *does* guarantee at discovery is `cwd = the functions source dir` plus `GCLOUD_PROJECT`, so `functions/src/visionGate.ts` reads the `.env`/`.env.<projectId>` file itself at discovery (and short-circuits on `process.env` at runtime, where the platform has already injected the value). That makes `functions/.env.<projectId>` genuinely drive the export at deploy.

To enable Vision later (the region pin is already in place, #132): (1) enable the Cloud Vision API on the project, (2) set `ENABLE_VISION_MODERATION=true` in `functions/.env.<projectId>`, and (3) redeploy `--only functions`.

**The sending functions—`adminAlertDigest` and `dailyEngagementEmail`—need the `RESEND_API_KEY` secret set BEFORE (or they will deploy but fail to send).** Since #638 the two `notify*Moderation` triggers are NOT among them: they enqueue only, bind no secret, and are unaffected by a missing key. See § 1a below for the one-time secret + the `EMAIL_FROM` / `ADMIN_NOTIFY_EMAIL` / `APP_BASE_URL` params; after setting the secret, (re)deploy the bound functions so the binding takes effect (`npm run deploy:<target> -- --only functions`).

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

- `EMAIL_FROM`—default `Gay Cruise Bingo <gaycruisebingo@nathanpayne.com>`. This is independent of the `gaycruisebingo.com` Hosting domain.

  > ⚠️ **The default's domain is no longer the verified one.** As of 2026-08-05 the Resend account's only verified sending domain is **`mail.nathanpayne.com`** (verified, sending enabled, receiving disabled)—not the apex `nathanpayne.com` this default uses. Resend rejects a send from an unverified domain, and `sendEmail` swallows that into a logged `false` (ADR 0001's never-throw contract), so the failure is quiet: the moderation notifiers and the daily email would both log and deliver nothing. **Any project that has not overridden `EMAIL_FROM` in `functions/.env.<projectId>` is in that state.** Either set `EMAIL_FROM` to an address on `mail.nathanpayne.com` per project, or re-verify the apex in Resend and leave the default alone. The Five Across deployment already overrides it (`Vacay Bingo <fiveacross@mail.nathanpayne.com>`).
- `ADMIN_NOTIFY_EMAIL`—optional comma-separated shared-inbox override; empty ⇒ notify the Event `admins` roster (resolved to verified Google emails) only.
- `APP_BASE_URL`—default `https://gaycruisebingo.com`; base for the Admin-console deep link in the email body, and the fallback origin for the daily email's Feed CTA when an Event has no `hostnames` mapping.
- `EMAIL_REPLY_TO`—default empty, meaning **no `Reply-To` header at all** (unchanged behaviour for any project that does not set it). Applies to every transactional send, not just the daily email. Separate from `EMAIL_FROM` because `EMAIL_FROM` must sit on a Resend-**verified sending domain** while replies want a mailbox a human reads—on the Five Across deployment those are different hosts (sent from the verified subdomain, replies to the Google-hosted apex, since the Resend receiving side is off). Set it in `functions/.env.<projectId>`.
- `EMAIL_UNSUBSCRIBE_URL`—default `https://us-central1-gaycruisebingo.cloudfunctions.net/emailUnsubscribe`; the public address of the unsubscribe endpoint, used as both the visible Unsubscribe link and the `List-Unsubscribe` header target in the daily engagement email (#616). **Any project other than `gaycruisebingo` MUST set this**—the default points at this project, so leaving it would mail an unsubscribe link that cannot honor the opt-out. Set it in `functions/.env.<projectId>`.

### 1a-ii. Admin notification digest (#638)

`adminAlertDigest` (an `onSchedule` trigger, `*/5 * * * *` UTC) ships with the same `RESEND_API_KEY` secret above; no additional secret is needed. It pins the Admin-SDK runtime identity, as do the two `notify*Moderation` triggers now that they write the queue. Full behaviour is in `specs/admin-notification-emails.md`.

Three things to check after the deploy:

1. **The Cloud Scheduler job exists**—the same #318 trap as the daily email, and it bites harder here because a jobless digest means the queue fills and nothing is ever mailed: `gcloud scheduler jobs list --project <projectId>` must show a job for `adminAlertDigest` alongside `dailyEngagementEmail` and `unlockDay`.
2. **A recipient resolves.** Recipients are the Event's `admins` roster (verified Firebase Auth emails only) unioned with `ADMIN_NOTIFY_EMAIL`. If neither resolves, alerts queue and nothing sends—which is logged, not lost, but it is silent from the outside. Populate `ADMIN_NOTIFY_EMAIL` per project unless the roster is known to resolve.
3. **Smoke-test the DIGEST, not the triggers.** Report a Prompt in the app (or submit one as a non-admin, which lands `pending`), then wait for the next five-minute sweep. A queue row appearing under `events/{eventId}/adminAlerts` with no email inside two sweeps means the scheduler job or the recipient list is the problem, in that order.

One optional one-time setup: a **Firestore TTL policy on `adminAlerts.expiresAt`**. A drained row is replaced by a payload-free tombstone (`{ sentAt, expiresAt }`) whose id is what keeps a delayed trigger redelivery from mailing the same transition twice; `expiresAt` is seven days out, matching the redelivery window. Without the policy the tombstones accumulate—two numbers each, holding no user content, so this is housekeeping rather than a correctness or privacy problem:

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=adminAlerts --enable-ttl --project <projectId>
```

### 1a-i. Daily themed engagement email (#616)

`dailyEngagementEmail` (an `onSchedule` trigger, `*/15 * * * *` UTC) and `emailUnsubscribe` (the HTTP unsubscribe endpoint) ship with the same `RESEND_API_KEY` secret above; no additional secret is needed. Both pin the Admin-SDK runtime identity, so no IAM change is required beyond what the existing functions already have. Full behaviour is in `specs/daily-engagement-email.md`.

Two things to check after the deploy:

1. **The Cloud Scheduler job exists**—per #318 the deployer service account has historically lacked `cloudscheduler.admin`, which deploys an `onSchedule` function with no job behind it and no error: `gcloud scheduler jobs list --project <projectId>` must show a job for `dailyEngagementEmail` alongside `unlockDay`.
2. **The unsubscribe endpoint answers**—`curl -sI "$EMAIL_UNSUBSCRIBE_URL?e=x&u=y&t=z"` should return `200` with an HTML confirmation page (a GET never changes state; only a POST does). If it 403s, the function was deployed without public invoker access.

Nothing sends until an Event admin turns it on: `events/{eventId}.settings.dailyEmailEnabled` is read as OFF unless explicitly `true`.

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
3. Set `VITE_RECAPTCHA_SITE_KEY` in `.env.local`, rebuild, redeploy hosting.
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
