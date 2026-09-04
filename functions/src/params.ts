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
 * Resend-verified sending domain — the account verifies two, `fiveacross.app`
 * (#1102) and `mail.nathanpayne.com` (#633; the prior apex-domain default was
 * never verified, so Resend rejected every send and `sendEmail` swallowed it
 * into a logged `false`, per ADR 0001's never-throw contract). Override per
 * project in `functions/.env.<projectId>`.
 *
 * STILL REACHED EVEN WITH ALL THREE OVERRIDES SET, which is why its default
 * moved to the platform sender (#1102, Codex P2 on PR #1103). The reachable
 * path is an EDITIONLESS Event, not an unknown one: `resolveEventOrigin`
 * returns `edition: null` for an Event with no active `hostnames` mapping,
 * `fromAddressFor` returns `undefined` for a null Edition (it cannot look up a
 * register that does not exist), and `resolveEmailFrom` therefore lands here.
 * Do not confuse this with the CONTENT register, which does degrade an unknown
 * Edition to `gcb` (`registerFor`, `dailyEmailContent.ts`) — that is a
 * different function answering a different question, and the two are easy to
 * conflate into a false claim that this param is dead code.
 *
 * So the default has to be right for an Event whose brand is UNKNOWN, and
 * `Five Across` is exactly that: the occasion-neutral platform identity
 * (`BRAND.md`), on the verified domain, at an address that receives. The prior
 * default branded such an Event `Gay Cruise Bingo`, which is a specific
 * Edition's identity asserted over an Event that has not claimed one.
 *
 * DEMOTED TO THE FALLBACK (#671). ADR 0008 splits Firebase projects by
 * cohort, not by brand, so one project can serve several brands (a Vacay Bay
 * host and a Five Across host on the SAME `fiveacross` project deployment),
 * and a per-project param cannot express a per-brand sender. The daily email
 * and admin digest now resolve an Edition-aware `From:` first — see the
 * `EMAIL_FROM_*` params below and `fromAddressFor` in `dailyEmailContent.ts`
 * — and reach this param only when no per-Edition override is configured.
 */
export const EMAIL_FROM = defineString('EMAIL_FROM', {
  default: 'Five Across <hello@fiveacross.app>',
});
/**
 * Per-Edition overrides of `EMAIL_FROM` (#671), one per brand in the #608
 * lexicon. Read through `fromAddressFor` (`dailyEmailContent.ts`) once an
 * Event's host resolves an Edition, so a Vacay-branded email can carry a
 * Vacay sender even on a project whose `EMAIL_FROM` default is something else.
 *
 * DEFAULT EMPTY — same convention as `EMAIL_REPLY_TO` below, and for the same
 * reason `EMAIL_FROM` itself must sit on a Resend-VERIFIED domain: an empty
 * value here is the signal that the brand's domain is not verified yet, so
 * the send falls back to `EMAIL_FROM` instead of handing Resend a `From:` it
 * will reject (swallowed into a logged `false`, never a thrown error, per
 * ADR 0001). Set the matching param, per project, only once that brand's
 * domain is verified in Resend.
 *
 * ONE DOMAIN SERVES EVERY EDITION (#1102, owner decision 2026-09-03).
 * `fiveacross.app` is the account's verified sending domain for all three;
 * `gaycruisebingo.com` and `vacaybingo.com` are deliberately NOT verified and
 * are not planned to be. Every Edition of the platform already carries the
 * `· by Five Across` endorsement in its email footer (#616, #698), so a
 * `fiveacross.app` sender agrees with what the message says about itself. The
 * DISPLAY NAME carries the Edition; the DOMAIN carries the platform:
 *
 *   EMAIL_FROM_GCB=Gay Cruise Bingo <hello@fiveacross.app>
 *   EMAIL_FROM_VACAY=Vacay Bingo <hello@fiveacross.app>
 *   EMAIL_FROM_FIVEACROSS=Five Across <hello@fiveacross.app>
 *
 * This supersedes the per-brand addresses previously recommended here (from
 * `plans/daily-cards-wireframes.html` § `#fx-email-registers-tri`), which
 * assumed three verified domains. Three would have meant three DKIM keys,
 * three sender reputations to warm and three inboxes to answer, in exchange
 * for a domain name most recipients never look at.
 */
export const EMAIL_FROM_GCB = defineString('EMAIL_FROM_GCB', { default: '' });
export const EMAIL_FROM_VACAY = defineString('EMAIL_FROM_VACAY', { default: '' });
export const EMAIL_FROM_FIVEACROSS = defineString('EMAIL_FROM_FIVEACROSS', { default: '' });
/**
 * Address replies land in, applied to every transactional send.
 *
 * DEFAULTS TO EMPTY, meaning no `Reply-To` header at all — the pre-existing
 * behaviour, so a project that sets nothing is byte-identical to before. It is
 * a separate param from `EMAIL_FROM` because the two answer different
 * questions: `EMAIL_FROM` must be an address on a Resend-VERIFIED sending
 * domain, while replies want a mailbox a human actually reads.
 *
 * SHOULD NOW BE EMPTY ON EVERY PROJECT (#1102). Once `hello@fiveacross.app` is
 * both the `From:` for every Edition and an address that actually receives, a
 * `Reply-To` has no work left to do — a reply goes to the `From:` by default.
 * Leaving a value here is worse than redundant: this param is PROJECT-wide
 * while ADR 0008 splits projects by COHORT, not by brand, so one value is
 * necessarily wrong for some Edition the project serves. The `fiveacross`
 * project hosts the Bodega Bay Event, which is `vacay`-Edition, so the former
 * `nathanpayne.com` value was inviting replies to a personal domain from
 * Vacay-branded mail. One shared `From:` that receives dissolves the problem
 * instead of managing it.
 */
export const EMAIL_REPLY_TO = defineString('EMAIL_REPLY_TO', { default: '' });
/** Optional shared-inbox override, comma-separated. Empty = roster only. */
export const ADMIN_NOTIFY_EMAIL = defineString('ADMIN_NOTIFY_EMAIL', { default: '' });
/** Base URL for the Admin-console deep link in notification bodies. */
export const APP_BASE_URL = defineString('APP_BASE_URL', { default: 'https://gaycruisebingo.com' });
/** Enforce a valid App Check token on bug intake after #44 enables clients. */
export const BUG_REPORT_APP_CHECK = defineBoolean('BUG_REPORT_APP_CHECK', { default: false });

/**
 * Enforce App Check on the auth-handoff callables (#548).
 *
 * OFF by default, like BUG_REPORT_APP_CHECK, and for the same reason: enforcing
 * attestation before the client attests would lock out the very sign-in flow it
 * protects. Turning it on is a launch prerequisite once #549 initialises App
 * Check on the client — see specs/auth-handoff.md § Deployment.
 *
 * It is the abuse control for `exchangeAuthHandoff`, which is unauthenticated by
 * design. The risk it answers is resource exhaustion, not compromise: the code
 * space is 2^256 so guessing is hopeless, but every well-formed guess still
 * costs a Firestore transaction, and a flood of them can crowd out real
 * sign-ins.
 */
export const AUTH_HANDOFF_APP_CHECK = defineBoolean('AUTH_HANDOFF_APP_CHECK', { default: false });
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
