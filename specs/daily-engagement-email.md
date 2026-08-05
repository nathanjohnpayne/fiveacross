---
spec_id: daily-engagement-email
status: accepted
---

# Daily themed engagement email (#616)

One email per participant per Day, sent at the Day's unlock in the Event's timezone, carrying the same identity the app shows that morning: the Day's Theme name, its palette, its context line. The job order is fixed — **nudge participation, show standings, make the photo expected, point at the Feed** — and the photos message is load-bearing: every BINGO claim is a photo opportunity, and the email is where that becomes a norm rather than a feature. It also carries the standing reminder that the most-loved photo takes an award at the finale ([#534](https://github.com/nathanjohnpayne/gaycruisebingo/issues/534)).

The design source is `plans/daily-cards-wireframes.html` § "Daily engagement email" — frames `#fx-email-anatomy` (annotated template anatomy and the per-module email-client constraints), `#fx-email-vacay` (a fully-rendered Bodega Day 1), `#fx-email-gcb` (mid-cruise Day 4), and `#fx-email-registers-tri` (the per-brand register strip). This spec records the implementation of those frames; where the two disagree, the frames are the design of record and this file is the bug.

Delivery is the existing transactional stack — Resend via `functions/src/email.ts`, sender identity from the `EMAIL_FROM` param, which this feature READS rather than duplicates, so it inherits the Edition-aware sender when #554/#608 land. The honor system is untouched ([ADR 0001](../docs/adr/0001-honor-system-trust-model.md)): the email recomputes no stats, gates no play, and a mail failure never blocks anything.

## Modules

Seven, in a fixed order, in both the HTML and the plain-text part. Editions change the WORDS, the Day changes the PALETTE, the order never moves.

1. **Preheader** — hidden body text clients show beside the subject. The Day plus one hook, ~85 characters, never a second sentence.
2. **Theme header** — the Day's Theme emoji + label in display type over a two-token gradient band, with the context line (`Day N of M · weekday, date · Place`) and the Theme's five-swatch palette strip. This is the module that makes the email resemble the Day.
3. **Standings snapshot** — the top three through YESTERDAY (today's card has only just unlocked), plus one personalized "You're #N" line. On the opening Day, or any Day nobody has played, it renders its empty state and sells the two open honors instead of showing a podium of ties — in two variants, because "the cruise starts today" is true on Day 1 and plainly false on Day 4.
4. **Participation nudge** — the greeting, the arrival line in the Edition's register, today's unlock time, and the Day's "Tonight:" line when it publishes one.
5. **Photos + award** — the two content requirements ride together, the same module every Day, because norms are built by repetition.
6. **Feed CTA** — one bulletproof button, "Open the Feed", deep-linking the Event's canonical host ([#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599)). The Feed, not the Card: the email's job is the social loop.
7. **Footer** — Edition sender identity, the why-you-got-this line, and the visible unsubscribe + preferences links.

- **Given** a mid-cruise Day with a played schedule **then** the model carries the Theme headline, a `Day N of M · weekday · Place` context line, the top three with the ⭐ Event-wide First-to-BINGO pin on the earliest first bingo, and the register's arrival line. (Test: "renders the mid-cruise Day 4 case from the wireframe".)
- **Given** the opening Day of a Vacay Event **then** the standings module renders its empty state naming the trip-wide honor, the subject tail is "your card is live", and the award line reads "most-loved photo of the trip". (Test: "renders the Bodega Day 1 empty state in the trip register".)
- **Given** two recipients of the same send **then** the ONLY differences are the greeting and the "You're #N" line; every other field is identical. (Test: "personalizes exactly one line".)
- **Given** an address that is not on the roster **then** no rank line is rendered rather than a rank nobody holds. (Test: "omits the rank line for an address that is not on the roster".)
- **Given** a later Day on which nobody has played **then** the empty state says the honors are wide open rather than that the occasion starts today. (Test: "does not claim the occasion \"starts today\" on a LATER empty Day".)

### Ranking parity

Ranking is `compareFinalePlayers`, so the email, the podium and the in-app Leaderboard can never disagree about who is ahead. Two subtleties carry the same parity:

**Tutorial Days count for score, not for the ⭐.** A bingo on the embark Day is real play and is summed into the standings, but the Event-wide First to BINGO honor deliberately excludes Tutorial Days ([ADR 0011](../docs/adr/0011-scoring-policy-stated-not-inferred.md), mirrored in `finaleContent.ts`) — and so does the `firstBingoAt` tie-break that rides on it. Without that exclusion an embark-Day winner would take the ⭐ in the email while the in-app Leaderboard gave it to someone else.

**`dayStats` is untrusted runtime shape.** `players/{uid}` is self-writable by design ([ADR 0001](../docs/adr/0001-honor-system-trust-model.md) — stats are client-authoritative), so a row carrying `{ dayStats: { 0: null } }` is reachable by any participant. It is sanitized at the read boundary (`sanitizeEmailDayStats`, the same normalization `readFinaleRoster` applies) and skipped defensively inside `standingsThrough`, because one malformed row throwing would suppress the entire Event's send.

- **Given** a Tutorial Day carrying the earliest bingo **then** its score counts and its timestamp does not, so the ⭐ goes to the earliest non-Tutorial bingo. (Tests: "excludes Tutorial Days from the ⭐ and its tie-break", "carries the Event's Tutorial Days through the model".)
- **Given** a malformed `dayStats` row **then** the snapshot is built without it rather than throwing. (Tests: "survives a malformed dayStats row", "sanitizes dayStats at the read boundary".)

## Edition register

Per-brand copy is a table in `functions/src/dailyEmailContent.ts`, one field per row of the wireframe's register strip. The modules the strip marks brand-invariant — Theme header, standings structure, CTA, unsubscribe — carry no field at all, which is how the invariance is enforced rather than merely asserted. An unknown or absent Edition degrades to the legacy Edition (`gcb`), the same direction `setActiveEdition` degrades in the app, and the lookup is an own-property check so an inherited `Object.prototype` key can never pass as a register ([#597](https://github.com/nathanjohnpayne/gaycruisebingo/issues/597)).

- **Given** each Edition **then** the occasion noun, subject tail, arrival line, photos nudge, award line and why-you-got-this line follow the #608 lexicon, and only Vacay carries the `· by Five Across` endorsement. (Tests under "Edition registers".)

## Day-Theme tokens

The app keeps a Theme's label and emoji in `src/theme/themes.ts` and its palette in `src/theme/themes.css`. The email needs both, as literal hex, in the functions package — and a mail client resolves no CSS variable — so `functions/src/dailyEmailTheme.ts` mirrors the seven tokens the email paints with. The app and functions packages are deliberately decoupled (the same posture `autohide.ts` keeps toward `moderation.ts`), so this is a mirror, not an import.

A mirror without a parity test is how mirrors drift, so the suite parses both app sources and asserts the table matches them id-for-id and hex-for-hex. It is intended to fail if a Theme is added, removed or re-palettised on either side alone.

- **Given** the app Theme registry **then** the mirror covers exactly the same ids and carries each label, emoji and palette hex verbatim. (Tests under "Day-Theme token mirror".)
- **Given** an unknown, absent or inherited Theme id **then** the tokens fall back to that EDITION's default Theme — `the-birds` for Vacay, `marquee` for Five Across — rather than to grey, and rather than to Gay Cruise Bingo's default, which would put another product's visual identity on a degraded Day. (Tests: "falls back to the default Theme for an unknown id", "falls back to the EDITION default", "mirrors the app's per-Edition default Theme".)

**Dates are calendar labels, not instants.** `DayDef.date` is already the Event's local calendar date, so `formatDayDate` renders it in UTC and takes no timezone argument at all. Pinning it to noon UTC and then re-rendering it in the Event's zone applies the offset twice — invisible inside ±12h, and wrong past it: in `Pacific/Kiritimati` (UTC+14) `2026-07-18` would print as Sunday, Jul 19. The unlock TIME is a real instant and is formatted in the Event's zone, falling back to UTC for a bogus IANA string.

- **Given** an Event east of UTC+12 **then** the context line names the weekday on the Event's own calendar. (Test: "renders the Day date as the calendar label it already is".)

## Email-safe rendering

Every constraint below is a real mail-client limitation, not a stylistic preference, and each is asserted:

- **600px single-column table layout**, no flexbox or grid — Outlook 2016-2019 renders through Word, which supports neither.
- **Literal hex on `bgcolor`/`style`, never a CSS variable** — Gmail resolves no custom properties.
- **An explicit background AND ink on every module**, plus `color-scheme`/`supported-color-schemes` — Gmail and Outlook dark modes invert colors they consider unmanaged, so every module leaves them nothing to grab. The light Theme (`fog-froth-farewells`) is the case that proves it and is rendered under test.
- **Display type declared `'Bebas Neue','Arial Narrow',Arial`** and designed to survive the fallback, because the webfont does not load in mail.
- **A bulletproof CTA** — a padded, bordered cell plus the Outlook-only VML fill — and no `<img>` anywhere, so the primary action survives image blocking.
- **A plain-text mirror** in the same module order, so `multipart/alternative` degrades to something still worth reading.
- **Every interpolated string escaped**, and every `href` restricted to `https:` — the model is built from Firestore data (Event name, Player display names, the canonical host), so a `javascript:` scheme reaching an anchor is the one templating mistake that would matter.

- **Given** a rendered email **then** it is a 600px table with no flex/grid, contains no `var(--`, declares both color schemes, includes the VML CTA and no `<img>`, and carries the visible unsubscribe and preferences links. (Tests under "renderDailyEmailHtml".)
- **Given** a display name containing markup **then** it is escaped rather than interpolated raw; **given** a non-https CTA URL **then** the anchor renders `#`. (Tests: "escapes Firestore-sourced copy", "refuses a non-https link".)

## Scheduling

`dailyEngagementEmail` is an `onSchedule` trigger on `*/15 * * * *` UTC, and the cadence is deliberate for the reason `unlockDay` runs the same one ([#552](https://github.com/nathanjohnpayne/gaycruisebingo/issues/552)). The send has to land at the Day's unlock in the EVENT's timezone, and a Cloud Scheduler cron is one fixed schedule for every Event a deployment serves: a daily UTC cron would fire at an arbitrary local hour, and a per-Event cron would mean a deploy every time an Event is created somewhere new. So the schedule is a frequent, dumb sweep and `dueDayForDailyEmail` is the real clock — it fires only inside a window that opens at the Day's own `unlockAt`, an absolute instant already derived from the Event's local schedule. There is no timezone arithmetic anywhere in the sender. Fifteen minutes rather than sixty because real IANA offsets include `:30` and `:45`.

Running 96× a day is safe because every beat is self-guarded rather than schedule-timed: the Event-level toggle is off by default, the due window closes six hours after unlock so a recovered outage never back-fills an already-played Day, each recipient's `lastSentDayIndex` makes a second sweep a no-op, and the Resend idempotency key (`daily-email/{eventId}/{dayIndex}/{uid}`) collapses any duplicate that slips through a failed marker write.

Per [#318](https://github.com/nathanjohnpayne/gaycruisebingo/issues/318): verify the Cloud Scheduler job exists after the deploy (`gcloud scheduler jobs list`) — the deployer service account has historically lacked `cloudscheduler.admin`, which deploys an `onSchedule` function jobless and silently.

- **Given** `now` at or after a Day's `unlockAt` and within the window **then** that Day is due; **given** before unlock, or past the window **then** nothing is. (Tests under "dueDayForDailyEmail".)
- **Given** the `unlockAt: 0` live-pre-event sentinel ([#289](https://github.com/nathanjohnpayne/gaycruisebingo/issues/289)) **then** the Day is never due, rather than permanently overdue. (Test: "ignores the unlockAt:0 sentinel".)
- **Given** a second sweep inside the same window **then** nothing is sent. (Test: "is idempotent".)

## Consent

Non-negotiable, and applied before the send rather than filtered after it.

**Recipients** are signed-in participants only — the Event's `players` roster, ban-filtered exactly as the podium filters it, mapped to verified Firebase Auth emails by the same verified-only policy `notify.ts` uses. A participant with no verified address is skipped.

**The Event-level admin toggle** is `events/{eventId}.settings.dailyEmailEnabled`, read as OFF unless explicitly `true`. It is the only thing that decides whether anyone is emailed at all, it ships off, and it is admin-writable through the settings gate that already exists in `firestore.rules` — no new write path. (The Admin-console CONTROL for it is not in this change; the field is set through the console's existing settings write path or a seed until a follow-up adds the switch.)

**The per-user opt-out** lives at `events/{eventId}/emailPrefs/{uid}`: `{ optedOut, token, lastSentDayIndex, updatedAt }`. Event-scoped because that is what the unsubscribe link in a given Event's email actually promises, and because the Event is already the schema's isolation boundary. The collection is SERVER-OWNED — `firestore.rules` denies clients read and write outright, and the Admin SDK bypasses rules. Both directions matter: `token` is an unguessable per-user capability, so a readable token would let any signed-in reader unsubscribe someone else, and the doc is the record of a consent decision, so a client write path would let a Player forge another Player's suppression.

**The token is stored randomness, not an HMAC.** An HMAC would need a Secret Manager entry set out of band, and an unresolved secret would break the one part of this feature that must never break. 256 stored random bits are equally unguessable with no key management, and revoking one is a field write rather than a rotation.

**Unsubscribe** is the `emailUnsubscribe` HTTP endpoint. It is HTTP rather than a callable because RFC 8058 one-click unsubscribe is a bare POST issued by the mail client itself, with no Firebase SDK, no session and no callable envelope — and because the visible link is a URL a mail app opens in a browser. Every send carries both the visible link and the `List-Unsubscribe` / `List-Unsubscribe-Post` header pair that makes a client surface its own native control.

**GET confirms; POST acts.** Corporate link scanners and client prefetchers issue GETs against every URL in a message, so a GET that unsubscribed would silently opt people out of mail they never opened. The GET renders a one-button form; the POST — which is also what one-click sends — performs the change. A wrong token and an unknown uid get the identical answer, so the endpoint cannot be used to enumerate participants. The confirmation form and its links carry through every non-reserved parameter the request arrived with, so a deployment whose `EMAIL_UNSUBSCRIBE_URL` selects the endpoint with its own router parameter does not lose it on the POST.

**A read failure is not an absence.** The preference doc is only ever created from a CONFIRMED absence, and only through an atomic `create`. Collapsing "cannot read" into "not there" would let a transient Firestore error mint a fresh opted-in document over a real opt-out and mail somebody who asked not to be mailed; `create` closes the remaining window, where a concurrent unsubscribe lands between the read and the write. A document that exists without a token gets one merged in, a write that names only the token, so an existing opt-out survives it.

- **Given** a matching token **then** the opt-out is recorded and is reversible on the same token; **given** a wrong token, an unknown uid, or a failed read **then** the answer is the same `invalid` and the stored state is untouched. (Tests under "applyOptOut".)
- **Given** a GET **then** the endpoint renders a confirmation form and changes nothing; **given** a POST **then** it applies the change. (Tests: "CONFIRMS on GET instead of acting", "ACTS on POST".)
- **Given** a participant who has opted out **then** their email address is never even resolved. (Test: "suppresses an opted-out participant BEFORE looking their address up".)
- **Given** a participant whose opt-out doc can be neither read nor minted **then** no email is sent — an email whose unsubscribe cannot be honored must not go out. (Tests: "returns null rather than a token-less pref when the backend is down", plus the `shouldSendTo(null)` case.)
- **Given** a read that FAILS while writes would succeed **then** nothing is minted and the stored opt-out is untouched. (Tests: "reports a read FAILURE separately from an absence", "NEVER resurrects an opted-out participant".)
- **Given** a document that lands between the read and the mint **then** `create` refuses and the stored document wins. (Test: "mints with create, so a doc that appears mid-flight wins over this run".)
- **Given** a router parameter on the endpoint URL **then** it survives into the form action and the resubscribe link. (Test: "preserves a router parameter from the endpoint URL".)
- **Given** any client, owner or Event admin included **then** every read and write of `emailPrefs` is denied. (Tests in `tests/rules/daily-engagement-email.test.ts`.)

## Deep links

The Feed CTA points at `https://{canonical host}/feed`. The host comes from the public `hostnames` map, queried on `eventId` alone and filtered in memory — a two-field query would need a composite index this feature is not worth adding one for — preferring the canonical active mapping, then any active mapping, then the `APP_BASE_URL` param, so a deployment with no hostname documents still mails a working link. #607's entry-point rules do not apply here: an email has no entry-point origin.

- **Given** an Event with an alias and a canonical mapping **then** the canonical one supplies both the origin and the Edition; **given** only archived mappings, or none **then** the fallback origin is used. (Tests under "resolveEventOrigin".)

## Runtime identity and config

Both new triggers pin `ADMIN_SDK_SERVICE_ACCOUNT`, derived per-project as `functions/src/index.ts` documents ([ADR 0008](../docs/adr/0008-five-across-second-firebase-project.md), #593): they read Events, rosters and hostnames and write opt-out docs through the Admin SDK, which the default Gen2 compute identity cannot reach. The scheduled sender binds `RESEND_API_KEY` like the moderation notifiers.

`EMAIL_UNSUBSCRIBE_URL` (`functions/src/params.ts`) is the endpoint's public address. A param rather than a derived string because the address is a deployment fact, not a code fact — the same source deploys to two Firebase projects and may sit behind a rewrite or custom domain. The default is the conventional Cloud Functions URL for `gaycruisebingo`; **any other project must set it in `functions/.env.<projectId>`**, or its emails will carry an unsubscribe link pointing at the wrong project.

The fan-out is paced (default 550ms between sends) because Resend's default account limit is a couple of requests a second and an unpaced blast would be throttled into dropped mail; the trigger's timeout is raised to match, and a recipient cap bounds a runaway.

## Not in this change

- The Admin-console switch for `settings.dailyEmailEnabled`. The server-side toggle, its default-off semantics and its rules coverage all ship here; the console control is a follow-up so this change stays out of `src/components`, which several in-flight lanes own.
- An in-app email-preferences screen. The footer's "Email preferences" link is served by the same endpoint, so the loop is closed without one.
- The Most-Loved Photo award ITSELF (#534). This email carries the reminder; the computation and the finale award are that ticket's.
- Distance-to-BINGO in the personalized line. The wireframe illustrates "two squares from your first BINGO", which cannot be derived from the standings aggregates — it would need each recipient's board and a second copy of the bingo-line logic. The line ships as rank plus progress from the aggregates instead; upgrading it is a content change with no structural cost.
