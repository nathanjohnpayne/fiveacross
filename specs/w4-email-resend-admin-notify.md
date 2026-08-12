---
spec_id: w4-email-resend-admin-notify
status: accepted
---

# Phase 1 email: Resend integration + admin moderation notifications (#101)

> **Superseded in part by [#638](https://github.com/nathanjohnpayne/gaycruisebingo/issues/638) (`admin-notification-emails.md`).** The reusable send wrapper (§ "The reusable email wrapper"), the transition predicate (§ "When a notification fires") and the recipient model (§ "Who is notified") are all still current and are reused unchanged. What moved is DELIVERY: `notifyAdminsOfModeration` and its composed `<table>` body are gone, and a moderation transition is now one of three signals that enqueue an admin alert, drained by a periodic Theme-styled digest. Read § "The composed notification" below as history — where the two files disagree about how a notification is delivered, `admin-notification-emails.md` wins.

Phase 1's server-authoritative moderation backend ([ADR 0004](../docs/adr/0004-reactive-moderation.md)) changes state silently—an admin only learns a Proof was flagged by Cloud Vision, or auto-hidden at `reportHideThreshold`, by opening the Admin console. This adds transactional email via [Resend](https://resend.com) and its first consumer: a decoupled Firestore trigger that emails Event admins when a Proof or Prompt transitions into a moderation state, with a deep link to the Admin console. The honor system stays intact ([ADR 0001](../docs/adr/0001-honor-system-trust-model.md))—this is an out-of-band notification only: it recomputes no stats, gates no play, and a mail failure never blocks the moderation write.

## The reusable email wrapper

`functions/src/email.ts` exposes `sendEmail({ to, subject, html, text?, idempotencyKey })` over the Resend Node SDK, lazily constructing `new Resend(RESEND_API_KEY.value())`. `RESEND_API_KEY` is a Secret Manager secret (`defineSecret`), never an env var; `EMAIL_FROM` is a non-secret `defineString` defaulting to the already-verified `mail.nathanpayne.com` Resend domain—the apex `nathanpayne.com` is NOT verified for this project, and a future edit must not restore it as the default (#633; see `functions/src/params.ts`). Both `from` and the transport are injectable, so the wrapper is unit-testable without a Functions runtime or a live key. The ENTIRE real-path setup—secret/param resolution and Resend construction—runs inside the guarded `try`, so this reusable wrapper never throws for any caller, even when the secret is unresolved.

- **Given** the send returns an `{ error }`, or the transport throws **then** `sendEmail` logs and returns `false`—never throws—and passes the computed `idempotencyKey` through to Resend unchanged. (Test: "surfaces a Resend { error } as false without throwing".)
- **Given** the real-path setup itself throws (e.g. `RESEND_API_KEY` is unresolved) **then** `sendEmail` still resolves `false` rather than rejecting. (Test: "returns false (never rejects) when real-path SETUP throws".)

## When a notification fires

`shouldNotify(before, after)` is a pure predicate—`true` only when `before.status !== after.status` and the new `status` is a moderation state (`flagged`/`hidden`). It reads the transitions `moderateProof` (Vision), the threshold auto-hide (#43), and manual admin hides already write; it edits none of them.

The threshold-hide notification (the flagship "notified on auto-hide" path) rides #43's server-authoritative `status → 'hidden'` transition and is therefore **not yet wired until #43 lands**: today the community-report path only increments `reportCount` and leaves `status` unchanged, so no email fires on a report bump. This is deliberate per ADR 0004 (only the server may set moderation `status`; clients and this notifier must not) and per this ticket's scope ("No edits to `moderateProof` or #43's hide Function: the notifier only reads the `status` transition"). Until #43 merges, the notifier covers Vision `flagged` and manual-admin `hidden` only; once #43 writes the `hidden` transition, the same predicate fires unchanged.

The trigger source is `onDocumentWritten`, so a Proof CREATED already `flagged`—`moderateProof`'s merge-set can create the doc in the upload-before-doc race, never producing an update—still notifies, while a normal create into `active` and any delete do not.

- **Given** `active → flagged`/`active → hidden`, or a create straight into `flagged`/`hidden` **then** `shouldNotify` is `true`; **given** a `reportCount` bump with unchanged status, a `pending → active` claim confirm, a `hidden → active` restore, a same-status re-write, a create into `active`, or a delete **then** it is `false`. (Tests under "shouldNotify".)

## Who is notified

`resolveAdminEmails(eventId)` reads the `events/{eventId}.admins` UID roster and maps each UID through `getAuth().getUser(uid)`, collecting verified `.email`s (de-duped), unioned with any comma-separated `ADMIN_NOTIFY_EMAIL` override. An empty roster resolves to `[]` and never throws.

- **Given** an `admins` roster **then** verified emails are collected, duplicates collapse, UIDs without a verified email drop, and `ADMIN_NOTIFY_EMAIL` entries union in; **given** nothing resolves **then** it returns `[]` without throwing. (Tests under "resolveAdminEmails".)

## The composed notification

`notifyAdminsOfModeration(eventId, collection, docId, after, transitionId)` resolves the admin emails and, when non-empty, sends exactly one email to all of them. The HTML+text body includes the Event id, `collection/docId`, new `status`, `visionFlag`/`reportCount` when present, and a deep link `${APP_BASE_URL}/admin`; all user-supplied text is HTML-escaped. The idempotency key is `moderation-notify/${eventId}/${collection}/${docId}/${after.status}/${transitionId}`, where `transitionId` is the triggering write's CloudEvent id—stable across platform retries of the same delivery but unique per distinct write. So a retry of one transition dedupes, while two distinct transitions into the same status (e.g. a re-hide after a restore, within Resend's 24h window) each deliver.

The subject names the cause from the ACTUAL doc state, never a fabricated one: a Vision flag names itself (`flagged (violence)`); a hide is `(reports >= threshold)` only when `reportCount` and the Event's `settings.reportHideThreshold` are both known and the count is at/over it, `(by an admin)` when both are known and the count is under, and a bare `hidden` when either is unknown. So a manual admin hide of an unreported prompt no longer claims a threshold cause it did not have.

Two triggers in `functions/src/index.ts`, each bound `{ secrets: [RESEND_API_KEY] }`, drive this: `onDocumentWritten('events/{eventId}/proofs/{proofId}', …)` and `onDocumentWritten('events/{eventId}/items/{itemId}', …)`. Each swallows a mail failure. `moderateProof` is unchanged and there is no `firestore.rules` change.

- **Given** a moderation transition with a resolved roster **then** exactly one send is made to all resolved admins, carrying a per-transition idempotency key, a cause derived from the doc state, and the Admin deep link; **given** the same CloudEvent id (a retry) **then** the key is identical (Resend dedupes), and **given** a distinct transition into the same status **then** the key differs (it delivers); **given** no admin email resolves **then** nothing is sent and it returns `false`. (Tests under "notifyAdminsOfModeration".)

These specs run via `npm run test:functions` (they import `functions/src`, whose SDK deps live only in `functions/package.json`; the script runs `npm --prefix functions install` first), keeping the root `npm test` self-contained on root deps. `app-ci.yml` runs `npm run test:functions` as its own CI step, mirroring `test:rules`, so the notifier suite gates every PR.

## Known minor (out of scope)

Firestore triggers carry no actor identity, so an admin who performs a manual hide is also emailed about their own action. Acceptable at this volume.

## Deferred deploy step (human)

Setting `RESEND_API_KEY` in Secret Manager from the 1Password item and redeploying the bound functions is a human finishing step, not part of this code PR. The `mail.nathanpayne.com` Resend domain is already verified—no new DNS. The apex `nathanpayne.com` is NOT verified for this project.
