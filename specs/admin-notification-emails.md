---
spec_id: admin-notification-emails
status: accepted
---

# Admin notification emails (#638)

Admins learn that a community Prompt is waiting for approval, or that content has been reported or hidden, by opening the console and looking. This mails them instead—as **one Theme-styled digest per Event per sweep**, not one email per write.

The design source is `plans/daily-cards-wireframes.html` § "Daily engagement email"—frame `#fx-email-anatomy` (the annotated template anatomy and the per-module email-client constraints). That frame calls the anatomy a platform artifact: "the Editions change the words and the Day changes the palette, but the module order never moves." This is the second family to render it, so the skeleton itself moved into `functions/src/emailShell.ts` and both families compose it. Where this spec and the frame disagree, the frame is the design of record and this file is the bug.

Delivery is the existing transactional stack—Resend via `functions/src/email.ts`, sender identity from `EMAIL_FROM`, which this reads rather than duplicates. The honor system is untouched ([ADR 0001](../docs/adr/0001-honor-system-trust-model.md)): the digest recomputes no stats, gates no play, and a mail failure never blocks the write that queued the alert.

## Why a queue, not a send

Both signals are bursty by nature. A pool import writes eighty `pending` Prompts in a second; a pile-on reports the same Proof five times in a minute. The pre-#638 shape—`notifyAdminsOfModeration`, one email per moderation transition—turns each of those into a mailbox event storm, which is how a moderation notification stops being read at all.

So the delivery shape is a **queue plus a periodic digest**, and burst safety is structural rather than a debounce timer someone can tune wrong:

- **Producers** are the two existing `events/{eventId}/{items,proofs}/{docId}` triggers. They stay cheap and synchronous—`alertsForWrite` is a PURE function of the before/after snapshots, performing no reads—and only APPEND to `events/{eventId}/adminAlerts`.
- **The consumer** is `sendAdminDigestForEvent`, driven by the `adminAlertDigest` sweep. It reads the Event once, resolves the roster once, renders ONE email covering everything queued since the last drain, and stamps each alert `sentAt`.

Eighty seeded Prompts therefore produce one email listing eighty.

**Alerts store raw facts, not rendered sentences.** An alert carries the doc's `status`, `visionFlag` and `reportCount`. Labelling a hide `reports >= threshold` versus `by an admin` needs the Event's `settings.reportHideThreshold`, and reading it in the trigger would cost one Firestore read per moderated write for a string nobody sees until the digest goes out. The digest reads the Event once and calls `deriveReason` there.

- **Given** a burst of writes inside one sweep window **then** exactly one email is sent, listing every alert. (Test: "sends ONE digest for a burst of eighty pending Prompts".)
- **Given** a queue write that fails **then** the triggering moderation write is unaffected and nothing throws. (Test: "never throws when the queue write fails".)

## What earns an alert

`alertsForWrite(collection, docId, before, after)` returns every alert a single write earns—`[]` for the overwhelming majority, which is what keeps the producers cheap enough to sit on a hot trigger path. A single write can legitimately raise more than one (an admin hiding an already-reported Prompt in one update).

- **`item-created`**—the Prompt is CURRENTLY `pending` and was not before. That is exactly the community-submission signal: `addItem` (the player path) writes `status: 'pending'`, while `adminAddItem` and every seed write `'active'`, so an admin adding their own Prompt correctly notifies nobody. It is also [#533](https://github.com/nathanjohnpayne/gaycruisebingo/issues/533)-proof—community Prompts land in the same `pending` state, so the predicate does not change when they ship. Items only; a Proof has no approval queue.
- **`content-reported`**—`reportCount` strictly ROSE. `reportItem`/`reportProof` increment it, so this is the explicit report action. Deliberately not a bare `reportCount > 0`: an admin Clear-reports (to `0`) is not a rise, and neither is a restore, which leaves the count alone.
- **`moderation`**—`status` CHANGED into `flagged`/`hidden`. The same transition `shouldNotify` has always covered: Cloud Vision flagging a Proof, the threshold auto-hide ([#43](https://github.com/nathanjohnpayne/gaycruisebingo/issues/43)), and a manual admin hide.

A delete (`after` undefined) earns nothing: there is nothing left to review.

- **Given** a player submission landing `pending` **then** one `item-created` alert; **given** an admin create into `active`, a `pending → active` approval, or a delete **then** none. (Tests under "alertsForWrite".)
- **Given** a `reportCount` bump **then** one `content-reported` alert; **given** an admin Clear-reports or a restore **then** none. (Tests under "alertsForWrite".)
- **Given** `active → hidden` or a create straight into `flagged` **then** one `moderation` alert; **given** a same-status re-write **then** none. (Tests under "alertsForWrite".)
- **Given** one write that both raises the count and hides the doc **then** both alerts are queued. (Test: "queues both alerts for a single hide-plus-report write".)

## Who is notified

`resolveAdminEmails` is `notify.ts`'s, unchanged and reused: the Event's `admins` UID roster mapped through Firebase Auth to VERIFIED emails, de-duped, unioned with the comma-separated `ADMIN_NOTIFY_EMAIL` param.

**Both sources stay live**, and #638 kept it that way rather than choosing between them, because they fail in opposite directions. The roster is the per-Event answer and needs no deploy to change, but it yields nothing for an admin whose Auth email is unverified or for a brand-new Event whose roster is empty. `ADMIN_NOTIFY_EMAIL` is the deployment-level shared inbox and is the only source that still resolves in those cases. A union costs one lookup and fails soft both ways.

**The roster half only ever worked on paper before this change.** `resolveAdminEmails` reads `events/{eventId}.admins` through the Admin SDK, but the `notifyProofModeration`/`notifyItemModeration` triggers did not pin `ADMIN_SDK_SERVICE_ACCOUNT`, and the project's default Gen2 compute identity has no Firestore data-plane access ([ADR 0008](../docs/adr/0008-five-across-second-firebase-project.md)). The roster read therefore failed, `resolveAdminEmails` swallowed it into an empty set by design, and only `ADMIN_NOTIFY_EMAIL` ever produced a recipient—which is why an empty `ADMIN_NOTIFY_EMAIL` on the Five Across deploy meant nothing sent at all. Both triggers now pin the identity.

**An unresolvable roster queues rather than drops.** When nothing resolves, the digest logs and returns without stamping, so the alerts stay pending and drain on the first sweep after a recipient exists. Notifications about content nobody can currently be told about are not thrown away.

- **Given** an `admins` roster and an override **then** both union, duplicates collapse, and UIDs without a verified email drop. (Tests under "resolveAdminEmails".)
- **Given** no resolvable recipient **then** nothing is sent AND nothing is stamped. (Test: "leaves alerts queued when no admin email resolves".)

## The digest

Six modules, in the wireframe's fixed order. An empty module is OMITTED rather than rendered empty—the daily email's standings module has a designed empty state because it ships every day either way; a digest with nothing to approve should simply not carry an approvals heading.

1. **Preheader**—how much is waiting, for which Event.
2. **Theme header**—the Day's palette over the two-token gradient band, with the admin brand line and the five-swatch palette strip. The Day supplies the palette so the digest looks like the Event it is about; the HEADLINE states the job ("Needs your eyes") rather than the Theme's name, because an admin opening this is being told there is work, not what today's Theme is. The Theme's own name rides the context line instead.
3. **Awaiting approval**—one row per `pending` Prompt.
4. **Reported & hidden**—one row per piece of CONTENT.
5. **Primary CTA**—one bulletproof button, "Open the Review queue".
6. **Footer**—brand line, why-you-got-this, and the batching note.

**The review module is keyed by content, not by alert.** A report that trips the auto-hide produces two queued alerts—the `reportCount` rise, then the server's `status → hidden` write—and both are true. Rendering them as two rows would tell an admin that two things happened to two things. They collapse to the LATEST alert for that document, which is also the most informative: the hide supersedes the report that caused it and carries the same count. Approvals are not collapsed, because each `pending` Prompt is genuinely its own piece of work.

**The Theme is the most recently unlocked Day's**, so a mid-cruise digest carries the palette of the app the admin is about to open. It falls back to the first Day before the Event starts, and for an Event with no schedule `emailThemeTokens` degrades to that EDITION's default Theme—never to grey, and never to another product's identity ([#623](https://github.com/nathanjohnpayne/gaycruisebingo/issues/623) P2). `unlockAt <= 0` is the live-pre-event sentinel ([#289](https://github.com/nathanjohnpayne/gaycruisebingo/issues/289)), not a real instant, so it never counts as unlocked.

**The render cap is visible, never silent.** At most `ROWS_PER_SECTION` rows are drawn per module; the remainder is stated as "+N more in the Review queue" rather than dropped.

- **Given** alerts of both kinds **then** the digest carries both modules in order, and the subject names both counts. (Test: "renders both modules and names both counts".)
- **Given** alerts of one kind **then** the other module is absent entirely. (Test: "omits a module with no rows".)
- **Given** a report and the hide it caused **then** the review module shows ONE row, carrying the hide. (Test: "collapses a report and its auto-hide into one row".)
- **Given** more rows than the cap **then** the overflow is stated. (Test: "states the overflow rather than truncating silently".)
- **Given** a mid-Event digest **then** the most recently unlocked Day's Theme skins it. (Tests under "currentThemeDay".)

### The detail line

`reviewDetail` is the one place this family makes a causal claim, and it makes only claims the stored facts support. It reuses `notify.ts`'s `deriveReason` rather than re-deriving the same three-way decision: a Vision flag names itself, a hide is `reports >= threshold` only when the count and the Event threshold are both known and the count is at/over it, `by an admin` when both are known and it is under, and nothing at all when either is unknown—so a manual hide of an unreported Prompt is never mislabelled ([#101](https://github.com/nathanjohnpayne/gaycruisebingo/issues/101) Codex R2 F1).

A still-active report additionally shows the distance to the auto-hide bar, which is the number an admin actually acts on.

- **Given** a Vision flag **then** the flag names itself; **given** a hide at/over the threshold **then** `reports >= threshold`; **given** a hide under it **then** `by an admin`; **given** an unknown threshold **then** no causal claim. (Tests under "reviewDetail".)
- **Given** an active report under the threshold **then** the row states how many more reports auto-hide it. (Test: "states the distance to the auto-hide bar".)

## Deep links

The CTA points at `{origin}/more/admin/queue`—the Review queue, which houses reports, pending approvals and claims together (`specs/admin-console-ia.md` § Routes).

**This corrects a dead link.** The pre-#638 notifier linked `{APP_BASE_URL}/admin`, which matches no route in the app: the admin console lives at `/more/admin[/section]`, and `/admin` falls through to the catch-all redirect. Every moderation email ever sent carried a link that did not open the console.

The origin comes from `resolveEventOrigin`—the Event's canonical `hostnames` mapping, then any active mapping, then `APP_BASE_URL` ([#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599)). That function moved to a narrower parameter type (`HostnameSource`) so this family reuses it instead of carrying a second copy of the preference order; `DailyEmailFirestore` satisfies it structurally, so no existing caller changed. A FAILED hostname read is not an absence: it propagates, the per-Event sweep boundary logs and skips, and the next sweep retries—rather than degrading a Vacay/Five Across digest to the legacy Edition's brand line.

- **Given** an Event with a canonical mapping **then** the CTA deep-links that host's Review queue; **given** none **then** `APP_BASE_URL`'s. (Tests under "sendAdminDigestForEvent".)
- **Given** a non-https origin **then** the anchor renders `#` rather than a live hazard. (Test: "refuses a non-https link".)

## Email-safe rendering

Every constraint the daily email asserts holds here, because both families render the same `emailShell.ts` skeleton: a 600px single-column table with no flex/grid, literal hex on `bgcolor`/`style` and never a CSS variable, an explicit background AND ink on every module plus both declared color schemes, display type declared `'Bebas Neue','Arial Narrow',Arial` and designed to survive the fallback, a bulletproof VML+cell CTA with no `<img>` anywhere, and a plain-text mirror in the same module order.

Every interpolated string is escaped and every `href` restricted to `https:`. That matters more here than in the daily email: a row's `label` is a Prompt's own words, written by a participant, and the whole point of the alert is that nobody has approved it yet. The one string in this email most likely to contain markup is the one that arrives straight from an unreviewed user submission.

- **Given** a rendered digest **then** it is a 600px table with no flex/grid, contains no `var(--`, declares both color schemes, includes the VML CTA and no `<img>`. (Tests under "renderAdminDigestHtml".)
- **Given** a Prompt whose text contains markup **then** it is escaped rather than interpolated raw. (Test: "escapes an unapproved Prompt's own words".)
- **Given** a light Theme **then** every module still declares its own background and ink. (Test: "paints every module on a light Theme".)

## No unsubscribe, deliberately

The daily email is opt-in engagement mail to participants and carries a visible link plus `List-Unsubscribe` headers. This is operational mail to the people who administer the Event, about work only they can do. The way to stop receiving it is to stop being an admin, or to clear `ADMIN_NOTIFY_EMAIL`—not a per-message opt-out that would silently suppress moderation notices for an Event that still has moderation to do. There is likewise no Event-level toggle: an Event with no admin recipients already sends nothing.

## Scheduling and runtime identity

`adminAlertDigest` is an `onSchedule` trigger on `*/5 * * * *` UTC. Five minutes is a floor on batching rather than a delay budget, and it is deliberately tighter than `unlockDay`'s and the daily email's quarter-hourly sweep: those wait on a wall-clock moment in the Event's timezone, while this one waits only on work existing—and moderation is the one notification where latency is a real cost. A sweep with nothing queued costs one indexed `sentAt == null` query per active Event and sends nothing.

`sentAt: null` is written EXPLICITLY on every alert rather than left absent, because Firestore's equality filter matches a stored null but not a missing field—an alert without it would sit in the collection forever, invisible to the drain. The filter is a single-field equality with a `limit`, so it rides the automatic index and adds no composite index.

`MAX_ALERTS_PER_DIGEST` is a ceiling, not a batch size: a larger backlog spans consecutive sweeps, because everything drained is stamped and the next run resumes where this one stopped. It bounds a pathological queue, it does not size normal work.

The sweep is scoped to ACTIVE Events, mirroring `runDailyEmailSweep`. An archived Event has no live surface to moderate, and its queue drains the moment it is reactivated rather than being lost.

The trigger pins `ADMIN_SDK_SERVICE_ACCOUNT` (it reads Events, the queue, the roster and `hostnames`, and stamps alerts) and binds `RESEND_API_KEY`—it is now the only admin-notification function that sends. Per [#318](https://github.com/nathanjohnpayne/gaycruisebingo/issues/318): verify the Cloud Scheduler job exists after the deploy (`gcloud scheduler jobs list`)—the deployer service account has historically lacked `cloudscheduler.admin`, which deploys an `onSchedule` function jobless and silently.

**The idempotency key is the drained SET**: `admin-digest/{eventId}/{newestAlertId}/{count}`. A run that sends but fails to stamp leaves the same alerts pending, so the next run rebuilds the same set, produces the same key, and Resend collapses the duplicate inside its 24h window. An alert arriving in between changes the set—a different key, which delivers, because that genuinely is new news.

- **Given** a second sweep after a successful drain **then** nothing is sent. (Test: "is idempotent across sweeps".)
- **Given** a send that fails **then** nothing is stamped and the alerts drain on the next sweep. (Test: "leaves alerts queued when the send fails".)
- **Given** one Event whose sweep throws **then** every other Event still drains. (Test: "one Event's failure never sinks the sweep".)

## The queue is server-owned

`events/{eventId}/adminAlerts/{alertId}` is denied to clients in both directions in `firestore.rules`, each direction for its own reason. **No write**, because a client write path would let any signed-in Player mint arbitrary alerts—flooding an admin's inbox with rows naming content that was never reported, which is both a spam vector and a way to bury a real report under noise. **No read**, because an alert carries the pre-moderation `label` (a Prompt's own words) for content that may be `pending` or `hidden`, states whose whole purpose is that non-admins cannot see them; a readable queue would route around the item/proof visibility rules via a second copy of the same text.

- **Given** any client—owner, participant or Event admin—**then** every read and write of `adminAlerts` is denied. (Tests in `tests/rules/admin-notification-emails.test.ts`.)

## Not in this change

- **Bug reports of type abuse.** [#638](https://github.com/nathanjohnpayne/gaycruisebingo/issues/638) lists them under the abuse signal, but the intake contract has no type at all: `validateClientReportFields` (`functions/src/bugReportContract.cjs`) accepts a free-text description and nothing that distinguishes a bug from an abuse report. Adding one is a client change—a control on `src/components/BugReport.tsx`, a widened shared contract, and a persisted field—with no design behind it in any wireframe, and it would pull this PR into `src/components`, which several in-flight lanes own. The producer seam is ready for it: a `bugReports/{id}` trigger calling `enqueueAdminAlerts` with a fourth kind is the whole integration. Tracked as a follow-up.
- **An in-app admin notification-preferences surface.** Recipients are the roster plus the env override; there is no per-admin mute. An Event with no resolvable recipients already sends nothing.
- **Per-row deep links.** The digest carries one CTA to the Review queue, which lists every queued item; linking each row individually would need a per-content route the console does not have.
