/**
 * Functions v2 config for transactional email (issue #101). Only ever
 * lazy-imported by email.ts/notify.ts (never statically, so their unit tests
 * stay free of firebase-functions), plus statically by index.ts to bind the
 * secret. RESEND_API_KEY is a Secret Manager secret (set out of band with
 * `firebase functions:secrets:set RESEND_API_KEY`), NEVER a plain env var.
 */
import { defineBoolean, defineSecret, defineString } from 'firebase-functions/params';

export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
/**
 * Default `from` address for every transactional send. MUST sit on a
 * Resend-verified sending domain — as of 2026-08-05 the account's only
 * verified sending domain is `mail.nathanpayne.com` (see #633; the prior
 * apex-domain default was never verified, so Resend rejected every send and
 * `sendEmail` swallowed it into a logged `false`, per ADR 0001's never-throw
 * contract). Override per project in `functions/.env.<projectId>` — the Five
 * Across deployment already does (`Vacay Bingo <fiveacross@mail.nathanpayne.com>`).
 */
export const EMAIL_FROM = defineString('EMAIL_FROM', {
  default: 'Gay Cruise Bingo <gaycruisebingo@mail.nathanpayne.com>',
});
/**
 * Address replies land in, applied to every transactional send.
 *
 * DEFAULTS TO EMPTY, meaning no `Reply-To` header at all — the pre-existing
 * behaviour, so a project that sets nothing is byte-identical to before. It is
 * a separate param from `EMAIL_FROM` because the two answer different
 * questions: `EMAIL_FROM` must be an address on a Resend-VERIFIED sending
 * domain, while replies want a mailbox a human actually reads. On the Five
 * Across deployment those are deliberately different hosts — mail is sent from
 * the Resend-verified subdomain and replies go to the Google-hosted apex,
 * because the Resend receiving side is switched off.
 */
export const EMAIL_REPLY_TO = defineString('EMAIL_REPLY_TO', { default: '' });
/** Optional shared-inbox override, comma-separated. Empty = roster only. */
export const ADMIN_NOTIFY_EMAIL = defineString('ADMIN_NOTIFY_EMAIL', { default: '' });
/** Base URL for the Admin-console deep link in notification bodies. */
export const APP_BASE_URL = defineString('APP_BASE_URL', { default: 'https://gaycruisebingo.com' });
/** Enforce a valid App Check token on bug intake after #44 enables clients. */
export const BUG_REPORT_APP_CHECK = defineBoolean('BUG_REPORT_APP_CHECK', { default: false });
/**
 * Public URL of the `emailUnsubscribe` endpoint (#616) — the target of every
 * daily email's visible Unsubscribe link and its `List-Unsubscribe` header.
 *
 * A param rather than a derived string because the endpoint's address is a
 * DEPLOYMENT fact, not a code fact: the same source deploys to two Firebase
 * projects (ADR 0008) and may sit behind a hosting rewrite or a custom domain.
 *
 * Reachability is NOT solved by picking this URL over the raw Cloud Functions
 * one. Both addresses hit the SAME backing Cloud Run service, and the
 * `gaycruisebingo` GCP project's Domain Restricted Sharing org policy
 * (`constraints/iam.allowedPolicyMemberDomains`) rejects granting `allUsers`
 * the Cloud Run invoker role on that service either way — a Hosting rewrite
 * FORWARDS the unauthenticated request into the same invoker check, it does
 * not bypass it. What actually makes the endpoint answer is
 * `scripts/set-email-unsubscribe-invoker.sh`, run once after every Functions
 * deploy: it DISABLES the invoker IAM check on the backing service (the exact
 * mechanism `scripts/set-bug-report-invoker.sh` already uses for
 * `submitBugReport`, #158) — see `docs/app/bug-reports.md` § Repeat-deploy
 * hardening and `docs/app/phase-1-deploy.md` § 1a-i. Skip that step and every
 * emailed unsubscribe link 403s, rewrite or no rewrite.
 *
 * Given that, the default still goes through Firebase HOSTING (`/unsubscribe`,
 * rewritten to `emailUnsubscribe` in `firebase.json`) rather than the bare
 * Cloud Functions URL — but that choice is COSMETIC, not load-bearing: a
 * first-party `gaycruisebingo.com` link is materially better for email
 * deliverability and looks less like phishing in a mail client's UI than a
 * raw `*.cloudfunctions.net` URL in a `List-Unsubscribe` header.
 *
 * The default names the `gaycruisebingo` project's own canonical host, so a
 * deployment that sets nothing still mails a link that works (once the
 * invoker script above has run). Any OTHER project MUST set its own hosted
 * `/unsubscribe` URL (its own canonical host plus the same rewrite, deployed
 * from this same `firebase.json`) in `functions/.env.<projectId>` — the
 * default is not portable.
 */
export const EMAIL_UNSUBSCRIBE_URL = defineString('EMAIL_UNSUBSCRIBE_URL', {
  default: 'https://gaycruisebingo.com/unsubscribe',
});
