---
spec_id: admin-notification-emails
status: accepted
---

# Admin notification emails (#638)

Admins learn that a community Prompt is waiting for approval, or that content has been reported or hidden, by opening the console and looking. This mails them instead—as **one Theme-styled digest per Event per sweep**, not one email per write.

The design source is `plans/daily-cards-wireframes.html` § "Daily engagement email"—frame `#fx-email-anatomy` (the annotated template anatomy and the per-module email-client constraints). That frame calls the anatomy a platform artifact: "the Editions change the words and the Day changes the palette, but the module order never moves." This is the second family to render it, so the skeleton itself moved into `functions/src/emailShell.ts` and both families compose it. Where this spec and the frame disagree, the frame is the design of record and this file is the bug.

Delivery is the existing transactional stack—Resend via `functions/src/email.ts`, sender identity resolved by `resolveEmailFrom` (`functions/src/dailyEmail.ts`), which this reads rather than duplicates. That resolution is Edition-aware ([#671](https://github.com/nathanjohnpayne/gaycruisebingo/issues/671)): the Event's Edition (from `resolveEventOrigin`, see § Deep links below) picks the matching `EMAIL_FROM_GCB` / `EMAIL_FROM_VACAY` / `EMAIL_FROM_FIVEACROSS` param, falling back to the project-wide `EMAIL_FROM` param when no override is configured for that Edition. The honor system is untouched ([ADR 0001](../docs/adr/0001-honor-system-trust-model.md)): the digest recomputes no stats, gates no play, and a mail failure never blocks the write that queued the alert.

## Why a queue, not a send

Both signals are bursty by nature. A pool import writes eighty `pending` Prompts in a second; a pile-on reports the same Proof five times in a minute. The pre-#638 shape—`notifyAdminsOfModeration`, one email per moderation transition—turns each of those into a mailbox event storm, which is how a moderation notification stops being read at all.

So the delivery shape is a **queue plus a periodic digest**, and burst safety is structural rather than a debounce timer someone can tune wrong:

- **Producers** are the two existing `events/{eventId}/{items,proofs}/{docId}` triggers. They stay cheap and synchronous—`alertsForWrite` is a PURE function of the before/after snapshots, performing no reads—and only APPEND to `events/{eventId}/adminAlerts`.
- **The consumer** is `sendAdminDigestForEvent`, driven by the `adminAlertDigest` sweep. It reads the Event once, resolves the roster once, renders ONE email covering everything queued since the last drain, and tombstones the queue rows it covered.

Eighty seeded Prompts therefore produce one email listing eighty—structurally, and with a 60-second settling period so the scheduler boundary cannot split the burst (see § The settling period).

**Alerts store raw facts, not rendered sentences.** An alert carries the doc's `status`, `visionFlag` and `reportCount`. Labelling a hide `reports >= threshold` versus `by an admin` needs the Event's `settings.reportHideThreshold`, and reading it in the trigger would cost one Firestore read per moderated write for a string nobody sees until the digest goes out. The digest reads the Event once and calls `deriveReason` there.

- **Given** a burst of writes inside one sweep window **then** exactly one email is sent, listing every alert. (Test: "sends ONE digest for a burst of eighty pending Prompts".)
- **Given** a queue write that fails **then** the triggering moderation write is unaffected and nothing throws. (Test: "never throws when the queue write fails".)

**The enqueue is idempotent under trigger redelivery.** Firestore redelivers a document-write event on retry, and the retry carries the SAME CloudEvent id, so the queue document's id is derived from it (`{transitionId}-{kind}`) and the write is a `create` rather than a `set`. A random id would mint a second alert for one transition: a duplicate row before a drain, and — if the redelivery lands after one — a whole second email whose set, and therefore whose Resend key, differs from the first. This is the guarantee [#101](https://github.com/nathanjohnpayne/gaycruisebingo/issues/101) bought by folding the CloudEvent id into its idempotency key, carried forward. `create` rather than `set` matters for exactly that late-redelivery case: `set` would re-create a row the digest had already cleared. The kind is part of the id because one write can earn more than one alert.

- **Given** the same CloudEvent id twice **then** one alert exists, not two; **given** a distinct id **then** a second alert is queued. (Test: "is idempotent under trigger REDELIVERY".)
- **Given** one write earning two alerts **then** their ids differ. (Test: "gives one write's two alerts distinct ids".)

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

### The fourth kind: `abuse-reported`

A bug report the reporter marked `abuse` earns one `abuse-reported` alert ([#670](https://github.com/nathanjohnpayne/gaycruisebingo/issues/670)). The intake contract carries a `kind` field for exactly this—see `specs/w4-bug-report-inbox.md` § "Bug or abuse" for the field, its normalization, and the reporter control—and a plain `bug` earns nothing, which is the whole reason the field exists: bugs are answered from the inbox, and mailing an admin about each one would make the digest useless for the reports that need eyes now.

It has its own producer, `abuseAlertsForWrite(reportId, before, after)`, rather than a fourth branch of `alertsForWrite`, because its document has none of the `status` / `reportCount` / `visionFlag` vocabulary the other three are read through. The predicate is still a TRANSITION, not a state—the report is CURRENTLY `abuse` and was not before. Every abuse report is a create today (the callable writes the document once and `firestore.rules` denies clients both directions), so the `before` half is not load-bearing yet; it is what keeps a future operator triage write from re-alerting, and it says what it means rather than relying on the collection's current immutability holding forever.

**And the reporter has to belong to the Event.** `eventId` is client-supplied, so an alert keyed on it alone would let any authenticated player name any Event in the project and route arbitrary text into ITS admins' digest—the rate limit caps how much, not who it reaches. The producer therefore also requires `reporterInEvent === true`, a fact the intake callable resolves server-side and persists (`specs/w4-bug-report-inbox.md` § "Bug or abuse"); it cannot be resolved here, because by the time this runs the document carries only an unresolvable `reporterHash`. Compared strictly to `true`, so an absent field, a `'true'` string, or a hand-written document that never went through intake all fail closed.

**Two things follow from `bugReports` being a TOP-LEVEL collection**, and both are the interesting part of this leg.

**The Event is read off the document, never guessed.** A report carries an `eventId` FIELD while the queue is `events/{eventId}/adminAlerts`, so `recordBugReportAlerts` reads it, checks its shape (the intake contract's own `^[A-Za-z0-9_-]{1,100}$`, restated because a stored document may predate that validator and a `/` would silently reparent the queue write), and confirms the Event resolves to an ACTIVE one before enqueuing. It refuses on anything else rather than filing the report against a default Event, which would put a stranger's abuse report in front of the wrong Event's admins. One read per ABUSE report, never per bug: the predicate runs first.

That precondition is written to match the DRAIN's precondition exactly. The sweep finds work with `where('status', '==', 'active')`, so a row under an unresolvable id—or under an archived Event that may never be reactivated—would never be visited, drained or tombstoned: an orphaned copy of a report's words living in Firestore forever, which is the retention outcome the tombstone design exists to avoid. The archived case is genuinely reachable here in a way it is not for the moderation producers, which fire on writes to an Event's own content and therefore stop when the Event does; a player can open the app and file a report against an Event long after it ended. The report still lands in the inbox. Nobody is mailed about an Event that is over.

**Every permanent answer is acknowledged; every transient one is retried.** `notifyAbuseBugReport` is declared `retry: true`, and `recordBugReportAlerts` divides its outcomes accordingly. Returning normally means "handled, do not retry", which is correct for the cases above because retrying changes nothing about them—the write was not an abuse transition, or the document names no usable, existing, active Event. Those are properties of the data. A failed Firestore READ or WRITE is the opposite: nothing about the report is wrong, and swallowing it silently and permanently loses a report of harm, so it propagates. Retrying is safe because the queue's document ids derive from the triggering CloudEvent id—a retry landing after a write already succeeded hits ALREADY_EXISTS and is a no-op, never a duplicate row.

That makes this producer NOT best-effort, unlike `recordAdminAlerts`, and the difference is deliberate rather than an inconsistency: the moderation producers guard a content write that [ADR 0001](../docs/adr/0001-honor-system-trust-model.md) says a queue failure must never fail, and their triggers are not retryable. This trigger writes nothing but the queue row, so there is no other write to protect.

- **Given** a report that became `abuse` **then** one `abuse-reported` alert; **given** a plain `bug`, a report with no `kind` at all, a later write to an already-`abuse` report, or a delete **then** none. (Tests under "abuseAlertsForWrite".)
- **Given** an abuse report whose `reporterInEvent` is false, absent, or not a boolean `true` **then** nothing is enqueued, though the report is still stored. (Test: "refuses to escalate a report whose reporter does not belong to the Event it names".)
- **Given** a description with an embedded newline or over `LABEL_MAX` **then** the label is flattened and clipped like a Prompt's words; **given** a blank description **then** the report id is the label. (Test: "flattens and clips the reporter description into a single-line label".)
- **Given** an `eventId` that is absent, non-string, over-length, or path-shaped **then** nothing is enqueued. (Tests under "bugReportEventId", "refuses to enqueue when the report names no usable Event, rather than guessing one".)
- **Given** an Event that does not resolve or is not `active` **then** nothing is enqueued and the trigger is acknowledged. (Tests: "refuses to enqueue against an Event that does not resolve", "refuses to enqueue against a non-ACTIVE Event, matching the sweep's own precondition".)
- **Given** a FAILED Event read or queue write **then** the failure propagates so the retryable trigger runs again; the moderation producers still swallow theirs. (Tests: "PROPAGATES a failed Event lookup so the retryable trigger can try again", "PROPAGATES a failed queue write, unlike the moderation producers", "does NOT propagate a queue write failure for the moderation producers".)
- **Given** a redelivered trigger **then** the deterministic id keeps it to one row. (Test: "is a no-op on trigger redelivery — the same CloudEvent id writes one row".)

## Who is notified

`resolveAdminEmails` is `notify.ts`'s, unchanged and reused: the Event's `admins` UID roster mapped through Firebase Auth to VERIFIED emails, de-duped, unioned with the comma-separated `ADMIN_NOTIFY_EMAIL` param.

**Both sources stay live**, and #638 kept it that way rather than choosing between them, because they fail in opposite directions. The roster is the per-Event answer and needs no deploy to change, but it yields nothing for an admin whose Auth email is unverified or for a brand-new Event whose roster is empty. `ADMIN_NOTIFY_EMAIL` is the deployment-level shared inbox and is the only source that still resolves in those cases. A union costs one lookup and fails soft both ways.

**The roster half only ever worked on paper before this change.** `resolveAdminEmails` reads `events/{eventId}.admins` through the Admin SDK, but the `notifyProofModeration`/`notifyItemModeration` triggers did not pin `ADMIN_SDK_SERVICE_ACCOUNT`, and the project's default Gen2 compute identity has no Firestore data-plane access ([ADR 0008](../docs/adr/0008-five-across-second-firebase-project.md)). The roster read therefore failed, `resolveAdminEmails` swallowed it into an empty set by design, and only `ADMIN_NOTIFY_EMAIL` ever produced a recipient—which is why an empty `ADMIN_NOTIFY_EMAIL` on the Five Across deploy meant nothing sent at all. Both triggers now pin the identity.

**An unresolvable roster queues rather than drops.** When nothing resolves, the digest logs and returns without clearing anything, so the alerts stay pending and drain on the first sweep after a recipient exists. Notifications about content nobody can currently be told about are not thrown away.

- **Given** an `admins` roster and an override **then** both union, duplicates collapse, and UIDs without a verified email drop. (Tests under "resolveAdminEmails".)
- **Given** no resolvable recipient **then** nothing is sent AND nothing is cleared. (Test: "leaves alerts queued when no admin email resolves".)

## The digest

Seven modules, in the wireframe's fixed order. An empty module is OMITTED rather than rendered empty—the daily email's standings module has a designed empty state because it ships every day either way; a digest with nothing to approve should simply not carry an approvals heading.

1. **Preheader**—how much is waiting, for which Event. Deliberately DESTINATION-NEUTRAL since [#670](https://github.com/nathanjohnpayne/gaycruisebingo/issues/670): it used to say "in the review queue", which is true of approvals and moderation and false of abuse reports, so an abuse-only digest sent an admin to a surface holding none of its work. The count is the useful half; each module names its own home.
2. **Theme header**—the Day's palette over the two-token gradient band, with the admin brand line and the five-swatch palette strip. The Day supplies the palette so the digest looks like the Event it is about; the HEADLINE states the job ("Needs your eyes") rather than the Theme's name, because an admin opening this is being told there is work, not what today's Theme is. The Theme's own name rides the context line instead.
3. **Abuse reports**—one row per report marked `abuse` ([#670](https://github.com/nathanjohnpayne/gaycruisebingo/issues/670)).
4. **Awaiting approval**—one row per `pending` Prompt.
5. **Reported & hidden**—one row per piece of CONTENT.
6. **Primary CTA**—one bulletproof button, "Open the Review queue".
7. **Footer**—brand line, why-you-got-this, and the batching note.

**The review module is keyed by content, not by alert.** A report that trips the auto-hide produces two queued alerts—the `reportCount` rise, then the server's `status → hidden` write—and both are true. Rendering them as two rows would tell an admin that two things happened to two things. They collapse to one row per document. Approvals are not collapsed, because each `pending` Prompt is genuinely its own piece of work.

**Abuse leads, and is one row per REPORT.** The wireframe's module order is fixed for the six modules it designs; this one is NEW rather than moved, and it goes first because it is the only module with no automated backstop behind it. A reported Prompt has the auto-hide threshold, a flagged Proof has Cloud Vision, and both sit in a console queue an admin can open whenever they get to it; an abuse report has none of that—nothing acts on it until a person does—and it is the only module that can be describing harm to a PERSON rather than to content. Two abuse reports stay two rows: the moderation module keys by content because two reports about one Proof are one piece of work, and a bug report has no subject document to collapse toward—only its own text. Each row therefore stands for one report and carries its report ID, which is how an admin tells two rows apart. It deliberately does NOT claim two distinct reporters: intake has no submission idempotency yet, so one reporter retrying after a lost response can file two reports (tracked as a follow-up).

**Its detail line is the report ID**, not a causal claim. `reviewDetail`'s vocabulary (`deriveReason`, the distance to the auto-hide bar) is built out of `status`, `reportCount` and `visionFlag`, and an abuse report has none of them—so the row says `abuse report · <id>`, which is the thing an admin can actually act on: it is what `npm run bugs:pull` and the inbox key on.

**Its overflow line names the inbox, not the Review queue.** Every other module's "+N more" points at the surface the CTA opens; bug reports have no console surface at all, so pointing an admin at the Review queue would send them looking somewhere the rows are not. The CTA itself is unchanged and still opens the Review queue—an abuse digest therefore has no one-click destination for its own rows, which is a known gap rather than an oversight (see § Not in this change).

### Every row is rendered from live state

An alert records what a write looked like; the email claims what is in the review queue NOW, and up to a whole sweep separates the two. So the sender re-reads each referenced document—once per document, however many alerts point at it—and `currentRowFor` decides what the row says, or whether there is a row at all. An approval alert survives only while its Prompt is still `pending`; a report or moderation alert survives only while its content is in a moderation state or still carries reports. Anything else has been handled, and is cleared without a row.

Without this, an admin who approved a Prompt two minutes after it landed would still be mailed "pending approval" for it, and a Prompt reported and then hidden inside one window could appear in both sections at once.

It also removes an ordering hazard rather than papering over it. The report write and the auto-hide write reach two independent trigger invocations whose handler wall-clocks can interleave, so a late report enqueue can carry a NEWER `createdAt` than the hide it preceded—and "latest alert wins" would then render hidden content as merely reported. The document itself cannot be out of order: whatever it says now is what the row says, and the row's KIND follows it. The collapse's moderation-outranks-report precedence remains as the second line, for the fail-open path below.

**A failed re-read is not a resolution.** The stored facts are kept and the row renders from them, because for an admin notification the safe direction is to over-report: a dropped moderation alert is a piece of flagged content nobody is told about.

**An abuse report is exempt from the MODERATION rules, stated rather than implied—but not from existence.** It is a record of a SUBMISSION rather than a state a document is in, and it carries none of the `status` / `reportCount` vocabulary the rules read. Left to the general rule, every liveness answer for it would be "nothing there", so every abuse row would be scored resolved and cleared the moment it was drained: queued, claimed, tombstoned, and never mailed. Nothing an admin does makes it stop being true either. A report was filed, and it stays filed.

Deletion is the one thing that ends it, and the delay can be long: a digest with no resolvable recipient leaves its alerts pending indefinitely, and the documented 90-day retention sweep (`docs/app/bug-reports.md`) can remove the source report meanwhile. Mailing the copied description and a dead report ID after the private source was deliberately deleted is exactly what the queue's tombstones exist to prevent, so an absent report RETIRES the row. A failed read still fails open, like every other kind.

**Every row is re-read at its OWN path.** `livePathFor` exists because `bugReports` is top-level while `items`/`proofs` nest under the Event—looking a report up at `events/{eventId}/bugReports/{id}` would find nothing and retire it as though retention had deleted it, which is the same bug in the opposite direction.

**A FROZEN replay checks the same thing, and abandons rather than re-renders.** The replay path deliberately re-derives nothing (§ The delivery identity is claimed, not derived), so it never passes through `currentRowFor` at all—and a batch that keeps failing to send is retried every sweep for as long as it keeps failing, which is easily long enough for the retention sweep to remove a report the frozen bytes quote. So a deleted bug report joins the changed roster as the second thing a frozen request may not simply trust: the batch is ABANDONED, its freeze dropped and its claim released, and the rows re-batch from scratch where the deleted one is retired on the way past. Re-rendering in place would change the bytes under a key the batch has already used, which is the 409 that strands a batch forever. Scoped to abuse rows deliberately: a deleted Prompt or Proof is ordinary moderation churn and replaying a stale row about one is the trade [#638](https://github.com/nathanjohnpayne/gaycruisebingo/issues/638) made knowingly, while a deleted bug report is a deliberate act of retention on private evidence.

- **Given** a Prompt approved inside the batching window **then** it is not mailed as pending, and its row is cleared. (Test: "does NOT mail a Prompt that was approved inside the batching window".)
- **Given** an abuse alert whose report still exists **then** its row survives whatever the moderation rules would have said, and it is read at the top-level path. (Tests: "survives the moderation liveness rules that would otherwise drop it as resolved", "MAILS an abuse row without re-reading a document that does not live under the Event".)
- **Given** an abuse alert whose source report has been DELETED **then** the row is retired and nothing is sent; **given** a failed read **then** it survives. (Tests: "RETIRES an abuse row whose source report has since been deleted", "sends nothing and clears the row when the source report was deleted before the digest went out".)
- **Given** a FROZEN batch whose abuse source has been deleted **then** it is abandoned and re-batched rather than replayed, and the next sweep retires the row; **given** a source that is still there **then** the frozen bytes replay verbatim under their own key. (Tests: "ABANDONS a frozen batch whose abuse source has been deleted, rather than replaying it", "REPLAYS a frozen abuse batch whose source report is still there".)
- **Given** every queued alert resolved **then** nothing is sent and the queue is still cleared. (Test: "sends nothing at all when every queued alert was resolved".)
- **Given** a report alert whose content is now hidden **then** the row reads as the hide, whatever the alert ordering said. (Test: "takes the KIND from the live document".)
- **Given** a re-read that FAILS **then** the row survives on its stored facts. (Tests: "FAILS OPEN on a read error", "keeps a row on a FAILED content re-read".)

**The Theme is the most recently unlocked Day's**, so a mid-cruise digest carries the palette of the app the admin is about to open. It falls back to the first Day before the Event starts, and for an Event with no schedule `emailThemeTokens` degrades to that EDITION's default Theme—never to grey, and never to another product's identity ([#623](https://github.com/nathanjohnpayne/gaycruisebingo/issues/623) P2). `unlockAt <= 0` is the live-pre-event sentinel ([#289](https://github.com/nathanjohnpayne/gaycruisebingo/issues/289)), not a real instant, so it never counts as unlocked.

**The render cap is visible, never silent.** At most `ROWS_PER_SECTION` rows are drawn per module; the remainder is stated as "+N more in the Review queue" rather than dropped.

- **Given** alerts of both kinds **then** the digest carries both modules in order, and the subject names both counts. (Test: "renders both modules and names both counts".)
- **Given** an abuse alert and an approval **then** "Abuse reports" renders first and the subject names its count first. (Test: "renders abuse in its OWN module, ahead of the moderation ones, and names it in the subject".)
- **Given** two abuse reports **then** two rows, each carrying its own report ID. (Test: "renders one row per REPORT, never collapsing two abuse reports into one".)
- **Given** more abuse rows than the cap **then** the overflow names the bug-report inbox. (Test: "points its overflow at the bug-report inbox, not at the Review queue the CTA opens".)
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

**Escaping is not sufficient for the plain-text part**, because that part has no escaping—its structure IS its punctuation. The item-create rule only requires a non-empty string of at most 80 characters, so a newline inside a Prompt would let an unapproved submission emit unprefixed lines into the text alternative that imitate a section heading or the CTA, complete with a URL the client auto-links, while the HTML consumer still shows one tidy escaped row—which is exactly what makes it easy to miss. `flattenLabel` collapses every C0 control character to a space, applied at BOTH boundaries: when the producer writes the label, and when the digest reads it back, so a row queued before this existed is flattened too.

- **Given** a Prompt containing newlines **then** the plain-text row stays one line. (Tests under "flattenLabel".)
- **Given** a tombstoned row in the claim's read set **then** the claim is refused rather than re-mailing it. (Test: "refuses to claim a TOMBSTONE".)

- **Given** a rendered digest **then** it is a 600px table with no flex/grid, contains no `var(--`, declares both color schemes, includes the VML CTA and no `<img>`. (Tests under "renderAdminDigestHtml".)
- **Given** a Prompt whose text contains markup **then** it is escaped rather than interpolated raw. (Test: "escapes an unapproved Prompt's own words".)
- **Given** a light Theme **then** every module still declares its own background and ink. (Test: "paints every module on a light Theme".)

## No unsubscribe, deliberately

The daily email is opt-in engagement mail to participants and carries a visible link plus `List-Unsubscribe` headers. This is operational mail to the people who administer the Event, about work only they can do. The way to stop receiving it is to stop being an admin, or to clear `ADMIN_NOTIFY_EMAIL`—not a per-message opt-out that would silently suppress moderation notices for an Event that still has moderation to do. There is likewise no Event-level toggle: an Event with no admin recipients already sends nothing.

## Scheduling and runtime identity

`adminAlertDigest` is an `onSchedule` trigger on `*/5 * * * *` UTC. Five minutes is a floor on batching rather than a delay budget, and it is deliberately tighter than `unlockDay`'s and the daily email's quarter-hourly sweep: those wait on a wall-clock moment in the Event's timezone, while this one waits only on work existing—and moderation is the one notification where latency is a real cost. A sweep with nothing queued costs one indexed `sentAt == null` query per active Event and sends nothing.

`sentAt: null` is written EXPLICITLY on every alert rather than left absent, because Firestore's equality filter matches a stored null but not a missing field—an alert without it would sit in the collection forever, invisible to the drain. The filter is a single-field equality with a `limit`, so it rides the automatic index and adds no composite index.

`MAX_ALERTS_PER_DIGEST` is a ceiling, not a batch size: a larger backlog spans consecutive sweeps, because everything drained is removed and the next run resumes where this one stopped. It bounds a pathological queue, it does not size normal work. It is clamped to `MAX_ATOMIC_WRITES` (450), because the clean-up is one `WriteBatch` and an admin-SDK batch caps at 500 writes—a larger drain would split into several commits and reintroduce the partial-failure case the design exists to remove. Clamped rather than asserted, so a future config bump degrades to "drains less per sweep" instead of "silently non-atomic".

**A delivered row is REPLACED by a tombstone**—`{ sentAt, expiresAt }` written without merge—and it has to be both a removal and a retention at once.

The removal is the retention answer: a queue row carries a copy of pending or hidden user content, and keeping it would outlive the moderation decision it describes and even the deletion of the content itself. But deleting the document outright would destroy the deterministic-id dedup above, because `create` succeeds again on an id that no longer exists—so a redelivery arriving after a drain would queue and mail the same transition a second time. Replacing the payload with two numbers keeps the id, and the id is the whole dedup.

**The frozen request carries a bounded `expiresAt` too**, and the bound is the point. `events/{eventId}/adminAlertBatches/{batchId}` holds the FULLY RENDERED email—every pending Prompt's words and every abuse description in the batch at once—so it is the densest copy of user content in the system and must never outlive the alerts it was built from. Without a bound it could: repeated delivery failures keep a frozen batch alive indefinitely, the pending TTL below then reaps the claimed rows, and no later sweep can discover the batch to replay, release or delete it. Its deadline is therefore the EARLIEST covered row's own expiry, clamped to a week. Expiring early is safe and already handled—claimed rows with no frozen document take the documented rebuild path, and by then Resend's 24-hour idempotency window has closed, so the rebuilt send cannot 409 against the key the batch used.

**Every row carries an `expiresAt` from the moment it is written**, not only once it is tombstoned. A queue row holds a COPY of user content—a pending Prompt's words, a hidden Proof's text, an abuse reporter's description—and until this existed that copy had exactly one exit: being drained. Because the sweep only visits `active` Events, a row whose Event is archived before the next sweep is never looked at again, and its copy outlives the source it describes, the retention sweep that deletes that source, and every decision anyone made about it. `PENDING_TTL_MS` is thirty days: orders of magnitude past the five-minute sweep, well inside the ninety-day source-report retention window, and long enough that no ordinary backlog is ever reaped—so it only ever collects rows that were genuinely stranded rather than merely pending. A delivered row is REPLACED on drain, so the shorter tombstone expiry supersedes this one rather than competing with it.

`expiresAt` is seven days out on a tombstone, matching the outer bound on Cloud Functions event redelivery, so a Firestore TTL policy on that field reaps the tombstone once it can no longer do its job. It is written as a `Date`, never as epoch milliseconds: the TTL service only considers a timestamp-typed field, and a numeric deadline would leave an operator with a configured policy that reaps nothing and a spec claiming otherwise. That policy is a one-time per-project setup (`docs/app/phase-1-deploy.md`); without it tombstones simply accumulate, which is tolerable in a way the un-reaped ALERTS were not—a tombstone is two numbers and holds no copy of user content.

Unreadable or already-resolved rows are tombstoned on the same pass, so they stop consuming the drain limit: skipping them would leave them pending forever, and a whole page of malformed documents would then starve every valid alert behind it on every future sweep.

- **Given** a redelivered trigger for an already-mailed transition **then** nothing is re-queued and no second email is sent. (Test: "a REDELIVERED trigger for an already-mailed transition does not re-queue it".)
- **Given** a delivered drain **then** the row retains only `sentAt`/`expiresAt`, and its id. (Test: "leaves a payload-free tombstone behind".)
- **Given** a freshly queued row **then** it already carries a timestamp-typed `expiresAt`, so a stranded copy cannot outlive the retention window even if it is never drained. (Test: "stamps every queued row with a TTL, so a stranded copy of a report cannot live forever".)
- **Given** a frozen batch **then** its `expiresAt` is never later than the earliest row it covers, so the rows' TTL cannot orphan it. (Test: "bounds the frozen request by the rows it covers, so it cannot be orphaned by their TTL".)

- **Given** a page that is entirely malformed **then** it is retired rather than re-read forever. (Tests: "RETIRES a malformed queue row", "clears a page that is ENTIRELY malformed".)

The sweep is scoped to ACTIVE Events, mirroring `runDailyEmailSweep`. An archived Event has no live surface to moderate, and its queue drains the moment it is reactivated rather than being lost.

The trigger pins `ADMIN_SDK_SERVICE_ACCOUNT` (it reads Events, the queue, the roster and `hostnames`, and stamps alerts) and binds `RESEND_API_KEY`—it is now the only admin-notification function that sends. Per [#318](https://github.com/nathanjohnpayne/gaycruisebingo/issues/318): verify the Cloud Scheduler job exists after the deploy (`gcloud scheduler jobs list`)—the deployer service account has historically lacked `cloudscheduler.admin`, which deploys an `onSchedule` function jobless and silently.

The three PRODUCERS are `notifyItemModeration` and `notifyProofModeration` (`onDocumentWritten` on `events/{eventId}/{items,proofs}/{id}`) and `notifyAbuseBugReport` (`onDocumentWritten` on `bugReports/{reportId}`, [#670](https://github.com/nathanjohnpayne/gaycruisebingo/issues/670)). All three pin `ADMIN_SDK_SERVICE_ACCOUNT` and none binds `RESEND_API_KEY`—they only append to the queue. The third has no `{eventId}` wildcard to read, because its collection is flat; it fires on every bug report and rejects a plain `bug` with a pure predicate before it spends a read, so the common case costs one no-op invocation. It writes only under `events/{eventId}/adminAlerts`, never back into `bugReports`, so it cannot re-fire itself.

### The delivery identity is claimed, not derived

**The idempotency key is PERSISTED before the send.** `claimDrain` stamps every row it is about to drain with a `batchId`, and the email is keyed `admin-digest/{eventId}/{batchId}`. So the delivery identity is immutable from the moment the email goes out, and a retry after a failed clean-up recognises its own previous delivery.

Nothing derivable at send time has that property, and both directions fail. The RENDERED rows shrink: if the send lands but the clean-up does not, an admin can resolve one item before the next sweep, live revalidation drops that row, and the key moves with it—so Resend accepts a second email repeating every row from the first that is still unresolved. The raw pending PAGE grows: a new alert arriving before the retry joins the still-pending rows, and a page-derived key moves the other way, producing a second email that repeats every delivered row alongside the newcomer. Atomic clean-up keeps the old rows in place; it cannot stop the queue changing around them.

With a claim, the retry takes exactly the claimed rows, reuses their id, and Resend collapses it—and the alerts queued since simply belong to the next batch. The minted id is `drainKey`: greatest row id plus count, reduced order-independently because the drain query carries no `orderBy`, so a position-sensitive reduction could shuffle between sweeps over an identical page. A released cohort additionally carries its persisted `requeueGeneration` suffix: recipient revalidation intentionally turns the same raw rows into a new outbound request, so reusing the abandoned key would make Resend reject the changed request as `invalid_idempotent_request`.

**A failed claim sends nothing.** Sending under an unpersisted key would put the system back in exactly the state the claim closes.

**A claim reserves an EMAIL, not just an identity.** Resend's idempotency is a promise about the request, not only the key: replaying a key with a different body is rejected (`409 invalid_idempotent_request`), not deduplicated. And a rebuilt retry is different by construction here, because this digest renders from live state — any approval, report, roster change or hostname change between the two attempts moves the bytes. Without freezing, the retry would 409, `sendEmail` would surface that as `false`, the claimed rows could never be cleaned up, and the batch would sit stuck until the key expired and then mail a duplicate. So the rendered request is persisted to `events/{eventId}/adminAlertBatches/{batchId}` BEFORE the send, and a retry replays those exact bytes without re-deriving anything. Live revalidation belongs to building a NEW batch; a retry re-sends what was already decided. A freeze that fails sends nothing, and a claim with no freeze rebuilds — which is safe precisely because nothing went out under that key.

**The freeze is `create`-only**, and that is what makes the claim and the freeze mutually exclusive. The claim commits before the freeze is written, so a second invocation can legitimately see claimed rows with no frozen document and rebuild. Two unconditional writes would then race, and the surviving freeze might not be the request Resend accepted — leaving later retries stuck on 409s or eventually duplicating. With `create`, exactly one render wins; the loser discards its own bytes and replays the winner's, so one batch id can only ever name one request.

**Recipients are revalidated even on a replay.** A freeze is written before the send, so a crash in between — or a definitively rejected send — leaves bytes that may never have been delivered. If an admin has since been removed, or `ADMIN_NOTIFY_EMAIL` corrected, replaying verbatim would mail pending and hidden content to somebody no longer authorized, and would keep doing so forever because the stale address is baked in. So when the authorized set has changed the batch is ABANDONED, not replayed: the freeze is dropped, the claim released, and the rows re-batch under a new id for whoever is authorized then. Releasing is transactional and conditional on the exact old `batchId` plus `sentAt === null`, so a concurrent stale retry can never erase a newer claim or resurrect a tombstone. That can duplicate a digest if the original send did land — to a currently-authorized recipient, only when the roster moved mid-flight — which is strictly better than mailing a revoked one, and it is also what lets a corrected deployment unblock a batch its old configuration had wedged.

- **Given** a lost freeze race **then** the loser replays the winner's bytes rather than its own. (Test: "REPLAYS the winner when it loses the freeze race".)
- **Given** a frozen batch whose authorized recipients have changed **then** it is abandoned and re-batched, never replayed to the stale set. (Test: "ABANDONS a frozen batch when the authorized recipients have changed".)
- **Given** a released cohort whose rows are unchanged **then** its replacement uses a fresh key, never the abandoned request's key. (Tests: "gives a released cohort a fresh delivery identity", and "ABANDONS a frozen batch when the authorized recipients have changed".)

The frozen request is deleted in the same atomic commit that tombstones its rows: it holds a rendered copy of unapproved content, so it must not outlive the delivery it existed for, and it must not be released before the rows or a retry would find claimed rows with no bytes to replay.

- **Given** a retry whose live state has moved **then** the frozen bytes are replayed verbatim under the original key. (Test: "REPLAYS the frozen bytes on a retry".)
- **Given** a freeze that fails **then** nothing is sent. (Test: "sends NOTHING when the freeze itself fails".)
- **Given** a claim with no frozen request **then** the batch is rebuilt. (Test: "rebuilds when the claim exists but nothing was frozen".)

**The claim is TRANSACTIONAL, not an unconditional merge.** Cloud Scheduler can double-fire, and two overlapping invocations reading slightly different pages would derive different batch ids and each overwrite the other's claim on the rows they share—then send their own snapshot under their own key, mailing the overlap twice despite the one-digest guarantee. Claiming only rows that are still unclaimed makes "check, then claim" one indivisible step; the loser abandons its sweep and finds the winner's claim on the next one. The transaction requires each row to be **unclaimed AND still pending**: `sentAt === null` is not redundant, because an overlapping drain that finished first REPLACED its rows with tombstones, and a tombstone carries no `batchId`—so a claimed-only check would read one as free, merge a new batch id onto it, and mail the stale pre-tombstone snapshot a second time.

**A retry re-reads the batch BY ITS ID, not from the pending page.** The page is `limit`ed, so once it is full a newly queued row can displace one of the claimed rows out of it. Retrying the remainder under the original key would send a SMALLER payload that Resend treats as the same email—and the displaced rows would come back later under that same key, be suppressed as duplicates, and never be delivered at all. A single equality filter needs no composite index, and a tombstone carries no `batchId`, so it matches exactly the claimed rows still outstanding.

- **Given** a claimed batch partly displaced from the pending page **then** the retry still carries the whole batch. (Test: "reloads the WHOLE claimed batch".)
- **Given** rows already claimed by another drain **then** this sweep reuses that claim rather than minting a competing one. (Test: "claims EXCLUSIVELY".)

### The settling period

The queue is what makes a burst cost one email; the settling period is what stops the scheduler boundary from splitting that email in two. A pool import or a report pile-on that straddles a sweep would otherwise be snapshotted mid-write: the rows already enqueued go out now, the rows written a second later go out five minutes later, and the acceptance criterion fails on precisely the case it was written for. So a row is eligible only once `QUIET_PERIOD_MS` (60s) has passed since it was queued.

**Eligibility is a COHORT decision, not a per-row one.** Filtering row by row defeats the guarantee it exists for: a one-second import straddling the cutoff has its first rows at 60.5s and its last at 59.5s, so the front of the burst goes out now and the tail five minutes later. If any row in the page is still settling, the whole page waits.

Taken alone that would be a starvation bug — a steady trickle keeps something inside the window on every sweep and the queue never drains — so the hold is bounded by `MAX_HOLD_MS` (10 minutes, two sweeps' worth). Once the oldest eligible row passes it, the eligible cohort goes out and the stragglers follow, and the truncation is logged. Delivering late beats never.

It remains a settling period, not the batching mechanism — the distinction matters, because a debounce is what this design deliberately is not. An import running longer than the max hold will still split across sweeps, which is the honest limit of a poller. A row that is already CLAIMED bypasses the wait entirely: it has been mailed once, and waiting again would only delay the retry.

- **Given** a page with any row still settling **then** the whole page waits. (Test: "holds the WHOLE COHORT when any row is still settling".)
- **Given** an eligible row older than the max hold **then** the cohort drains anyway. (Test: "bounds the hold, so a steady trickle can never starve delivery".)

Applied in memory rather than as a query filter, because a `createdAt <=` range alongside the `sentAt ==` equality would need a composite index and the drain query's whole virtue is that it rides the automatic single-field one.

- **Given** a second sweep after a successful drain **then** nothing is sent. (Test: "is idempotent across sweeps".)
- **Given** a clean-up that fails **then** every alert is still pending, each carrying the batch id the email went out under, and the payload survives the merge. (Test: "CLAIMS the delivery identity before sending".)
- **Given** a row RESOLVED between the send and the retry **then** it drops out of the email and the key does not move. (Test: "keeps the retry key stable when a row RESOLVES".)
- **Given** a new alert ARRIVING between the send and the retry **then** the retry re-sends only the claimed rows under the same key, and the newcomer waits for its own batch. (Test: "keeps the retry key stable when a NEW alert ARRIVES".)
- **Given** a claim that fails **then** nothing is sent and nothing is cleared. (Test: "sends NOTHING when the claim itself fails".)
- **Given** rows still inside the settling period **then** nothing is drained, and the whole burst goes out together on a later sweep. (Tests: "waits out the settling period", and the cases under "planDrain".)
- **Given** the same page in a different order **then** the key is identical. (Test: "reduces the drain key order-independently".)
- **Given** a send that fails **then** nothing is cleared and the alerts drain on the next sweep. (Test: "leaves alerts queued when the send fails".)
- **Given** one Event whose sweep throws **then** every other Event still drains. (Test: "one Event's failure never sinks the sweep".)

## The queue is server-owned

`events/{eventId}/adminAlerts/{alertId}` is denied to clients in both directions in `firestore.rules`, each direction for its own reason. The same denial covers `events/{eventId}/adminAlertBatches/{batchId}`, the frozen outbound request, and one reason is sharper there: that document holds the FULLY RENDERED email, so a readable copy would disclose the words of every `pending` and `hidden` item in the batch at once—the whole moderation queue in a single document—and a writable one would let a client dictate the bytes a later retry sends to the admins.

**No write**, because a client write path would let any signed-in Player mint arbitrary alerts—flooding an admin's inbox with rows naming content that was never reported, which is both a spam vector and a way to bury a real report under noise. **No read**, because an alert carries the pre-moderation `label` (a Prompt's own words) for content that may be `pending` or `hidden`, states whose whole purpose is that non-admins cannot see them; a readable queue would route around the item/proof visibility rules via a second copy of the same text.

- **Given** any client—owner, participant or Event admin—**then** every read and write of `adminAlerts` is denied. (Tests in `tests/rules/admin-notification-emails.test.ts`.)

**The abuse signal is server-owned at its source too.** `bugReports/{reportId}` is already `allow read, write: if false`—the callable is the only write path—so the `kind` field that decides whether an admin is mailed cannot be forged. That denial is load-bearing in both directions now: a client able to write `kind` could mint admin alerts at will, and a client able to rewrite it could bury a real abuse report by downgrading it to a bug.

- **Given** any client **then** creating a `bugReports` document carrying `kind: 'abuse'`, and updating an existing report's `kind`, are both denied. (Test: "keeps bug reports and rate-limit state server-only", `tests/rules/w0-firestore-rules.test.ts`.)

## Not in this change

- **A deep link for an abuse row.** The digest's CTA opens the Review queue, and bug reports are not in it—they are pulled with `npm run bugs:pull` (`specs/w4-bug-report-inbox.md`). So an abuse row names its report ID and the module's overflow line names the inbox, but nothing in the email is one click from the report itself. Giving it one means an admin-console surface for bug reports, which does not exist.
- **An in-app admin notification-preferences surface.** Recipients are the roster plus the env override; there is no per-admin mute. An Event with no resolvable recipients already sends nothing.
- **Per-row deep links.** The digest carries one CTA to the Review queue, which lists every queued item; linking each row individually would need a per-content route the console does not have.
