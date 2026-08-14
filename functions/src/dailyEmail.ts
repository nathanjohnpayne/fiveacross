/**
 * Daily themed engagement email — the scheduled ORCHESTRATION (issue #616,
 * plans/daily-cards-wireframes.html § "Daily engagement email").
 *
 * One email per participant per Event-local calendar date, sent that morning in
 * the Event's timezone, carrying that day's Theme. This module owns WHO gets it
 * and WHEN; `dailyEmailContent.ts` owns WHAT it says, `dailyEmailTemplate.ts`
 * owns how it looks, and `emailOptOut.ts` owns consent. The trigger seam in
 * `index.ts` is three lines.
 *
 * WHY A QUARTER-HOURLY TRIGGER FOR A DAILY EMAIL (the #552 lesson, restated
 * because it is the thing most likely to be "simplified" later). The send has
 * to land at the Day's unlock in the EVENT's timezone, and a Cloud Scheduler
 * cron is a single fixed schedule for every Event the deployment serves. A
 * daily UTC cron would fire at some arbitrary local hour — 23:00 the previous
 * evening for a Pacific Event — and a per-Event cron would mean a deploy every
 * time an Event is created somewhere new. So the schedule is a frequent, dumb
 * sweep and the DUE CHECK is the real clock (`dueDayForDailyEmail`). Fifteen
 * minutes rather than an hour for the same reason `unlockDay` uses it: real
 * IANA offsets include :30 and :45, so an hourly sweep would be late by up to
 * 59 minutes in those zones.
 *
 * THE DUE CHECK IS PER EVENT-LOCAL CALENDAR DATE, not per Day document (#723):
 * one email per date that has a Day, whatever sort of Day it is. Eligibility
 * reads `date` and nothing else; `unlockAt` only decides WHEN in the morning the
 * send lands. See `dueDayForDailyEmail` for the rule and what it replaced.
 *
 * SAFE TO RUN 96× A DAY because every beat is self-guarded, not schedule-timed:
 * the Event-level admin toggle is off by default, the due window closes six
 * hours after unlock, each recipient's `lastSentDayIndex` makes a second run a
 * no-op, and the Resend idempotency key collapses any duplicate that slips
 * through a failed marker write inside its 24h window.
 *
 * Best-effort throughout (ADR 0001): one Event, one recipient, or one send
 * failing is logged and skipped, never crashing the sweep.
 *
 * The Firestore/Auth/send dependencies are injected, so the whole flow is
 * unit-testable without a Functions runtime and no live backend is touched
 * under test (mirrors `unlockDay.ts`).
 */
import {
  buildDailyEmailModel,
  firstBingoUid,
  hasScheduledUnlock,
  standingsThrough,
  type EmailDay,
  type EmailEvent,
  type EmailPlayer,
} from './dailyEmailContent';
import { tutorialDayIndexes, type FinaleDayStat } from './finaleContent';
import { renderDailyEmailHtml, renderDailyEmailText } from './dailyEmailTemplate';
import {
  ensureEmailPrefs,
  listUnsubscribeHeaders,
  markDailyEmailSent,
  preferencesLink,
  unsubscribeLink,
  type EmailPrefsFirestore,
  type OptOutDeps,
} from './emailOptOut';
import type { sendEmail } from './email';

// --- Minimal admin-SDK Firestore surface ----------------------------------------

interface Snapshot {
  readonly id: string;
  data(): Record<string, unknown> | undefined;
}
interface Query {
  where(field: string, op: string, value: unknown): Query;
  limit(count: number): Query;
  get(): Promise<{ docs: Snapshot[] }>;
}
/**
 * The narrowest surface `resolveEventOrigin` needs — a collection it can filter
 * and read. Stated separately from `DailyEmailFirestore` so the admin digest
 * (#638), whose Firestore surface has no `emailPrefs` doc shape at all, can
 * reuse the hostname resolution instead of carrying a second copy of the
 * canonical-host preference order. `DailyEmailFirestore` satisfies it
 * structurally, so no existing caller changes.
 */
export interface HostnameSource {
  collection(path: string): Query;
}
/** The minimal surface the daily email uses: the opt-out doc surface
 *  (`EmailPrefsFirestore`, inherited whole — including its `create`) plus the
 *  roster and hostname queries. */
export interface DailyEmailFirestore extends EmailPrefsFirestore, HostnameSource {}

// --- Pure decisions -------------------------------------------------------------

/**
 * How long after a Day's unlock the email may still go out. Six hours is
 * deliberately generous but finite: a function outage or a late enable should
 * still get the morning's email to people while the Day is young, and must
 * NEVER back-fill a Day that has already been played — a "Day 3 is here!" email
 * arriving on the evening of Day 3 is worse than no email at all.
 */
export const SEND_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The Event-level admin toggle. OFF unless EXPLICITLY true: the daily email is
 *  opt-in per Event, so an Event doc that predates the setting — or one whose
 *  read half-failed — never mails anyone. */
export function dailyEmailEnabled(event: EmailEvent | undefined): boolean {
  return event?.settings?.dailyEmailEnabled === true;
}

/**
 * The Event-local hour a Day's morning email falls back to when the Event names
 * no unlock instant ANYWHERE — the `unlockAt` convention `src/domainTypes.d.ts`
 * documents, and the only sensible guess with nothing else to go on.
 */
export const DEFAULT_SEND_LOCAL_HOUR = 8;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** An instant as the Event's own wall clock: its calendar date ("2026-08-09")
 *  and minutes since local midnight. Both come from ONE formatter call, so they
 *  cannot describe different instants. Falls back to UTC for a bogus IANA
 *  string, exactly as `formatUnlockTime` does. */
function eventWallClock(at: number, timeZone: string | undefined): { date: string; minutes: number } {
  const read = (tz: string): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(at));
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = read(timeZone || 'UTC');
  } catch {
    parts = read('UTC');
  }
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // `hour12: false` resolves to the h24 cycle in some ICU builds, which spells
  // midnight "24" while the date parts already name the day that is STARTING —
  // the same trap `src/unlockCopy.ts` folds out. Assembled from parts rather
  // than a formatted string so the result is locale-independent.
  const hour = Number(part('hour')) % 24;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, minutes: hour * 60 + Number(part('minute')) };
}

/**
 * The Event-local calendar date a Day belongs to — its OWN `date` label, and
 * only that — or `''` for a Day that names none.
 *
 * `date` is a required `DayDef` field, the schedule's own statement of which
 * calendar day a Day is, so this needs no clock, no timezone and no inspection
 * of `unlockAt`. A Day whose label is missing or unparseable belongs to no
 * calendar day and can never be due: the single disqualifier in the whole due
 * check, and the #289 guarantee that a Day with nothing to anchor to never
 * mails forever.
 *
 * THE SHAPE IS NOT THE CHECK (Codex #729 P2). `ISO_DATE` says only "ten
 * characters that look like a date", so `2026-99-99` would pass it and take
 * ownership of a date that does not exist — and because a nonexistent label can
 * never equal today's, its owner can only ever surface through the carried-Day
 * path, i.e. on an evening when the real owner's window has closed. That is how
 * one garbled label would put Bodega's 11:00 wrap-up back into a second Sunday
 * email, the exact regression this rule was written to kill. Parsing alone is
 * not enough either: `Date.parse('2026-02-30T12:00:00Z')` happily rolls forward
 * to March 2 rather than failing, so the label has to ROUND-TRIP. Noon UTC is
 * the same anchor `formatDayDate` parses with, deliberately — a date the email
 * cannot print is a date that must not own a morning.
 */
function dayCalendarDate(day: EmailDay): string {
  const label = typeof day.date === 'string' ? day.date : '';
  if (!ISO_DATE.test(label)) return '';
  const at = Date.parse(`${label}T12:00:00Z`);
  if (Number.isNaN(at)) return '';
  return new Date(at).toISOString().slice(0, 10) === label ? label : '';
}

/**
 * Minutes past Event-local midnight at which the morning send opens for a Day
 * with no unlock instant of its own — the EARLIEST hour any Day in this Event
 * really unlocks, falling back to `DEFAULT_SEND_LOCAL_HOUR`.
 *
 * Derived rather than fixed because a hardcoded 08:00 is only right for Events
 * that happen to use it: Bodega Bay's real Days open at 06:00, so its opening
 * Friday would have been mailed two hours out of step with every other morning
 * of the same trip. Taking the EARLIEST also means this hour is never later
 * than the Event's own wake-up.
 */
function morningOpensAt(days: readonly EmailDay[], timeZone: string | undefined): number {
  const unlocks = days.filter(hasScheduledUnlock).map((d) => eventWallClock(d.unlockAt, timeZone).minutes);
  return unlocks.length > 0 ? Math.min(...unlocks) : DEFAULT_SEND_LOCAL_HOUR * 60;
}

/** Whether the Day that owns `date` is inside its send window at `now` — the
 *  ONLY place `unlockAt` is consulted, and it decides the hour, never
 *  eligibility.
 *
 *  A real unlock keeps the absolute `[unlockAt, unlockAt + windowMs)` it has had
 *  since #616, unaffected by which calendar date `now` falls on (so a 23:00
 *  unlock is still mailable at 01:00 after an outage, Codex #729) and carrying
 *  the same identity the app shows that morning. Anything else — sentinel,
 *  missing, `NaN`, negative, non-numeric — simply names no hour, so it gets the
 *  same span on the Event's WALL clock from `opensAt` on its own date. */
function windowIsOpen(
  day: EmailDay,
  date: string,
  now: number,
  today: { date: string; minutes: number },
  windowMs: number,
  opensAt: number,
): boolean {
  if (hasScheduledUnlock(day)) return now >= day.unlockAt && now < day.unlockAt + windowMs;
  // The date equality is what bounds this to one morning: local minutes never
  // reach 1440, so the window closes at local midnight even if the span is
  // longer.
  return date === today.date && today.minutes >= opensAt && today.minutes < opensAt + windowMs / 60_000;
}

/**
 * The Day whose email is due at `now`, or `null`.
 *
 * ONE EMAIL PER CALENDAR DATE THAT HAS A DAY, sent that morning in Event time
 * (#723). Eligibility asks only "does this Event-local date have a Day?", never
 * what sort of Day it is: the opening Day carrying the `unlockAt: 0` sentinel,
 * an ordinary Day, and a Day whose `unlockAt` is corrupt are all simply Days on
 * a date. The code this replaced sorted them into sentinel / real / malformed
 * and refused to mail two of the three, which is how Bodega Bay's Friday went
 * unmailed.
 *
 * ONE Day owns a date, and it is the LOWEST-INDEXED Day on it. This email is
 * the morning touchpoint for a calendar day, not a per-Day notification:
 * Bodega's Sunday carries both the 06:00 competitive card and the 11:00
 * ceremonial wrap-up, and mailing each in turn put two emails five hours apart
 * on one Sunday — the second announcing the wrap-up Day's `place`, "The drive
 * home", through an arrival line built for a port name. A later Day sharing a
 * date is not a new day and gets no email; its content still reaches players in
 * the app.
 *
 * Ownership picks who speaks for a date; `windowIsOpen` decides when, and never
 * shortens anyone's window — a date rolling over while a late-evening Day's six
 * hours are still running must not cancel the send. When two owners are somehow
 * due at once — a Day carried over from yesterday and today's — today's owner
 * wins, so the send is never a stale card.
 */
export function dueDayForDailyEmail(
  days: readonly EmailDay[] | undefined,
  now: number,
  timeZone?: string,
  windowMs: number = SEND_WINDOW_MS,
): EmailDay | null {
  const schedule = (days ?? []).filter((day): day is EmailDay => !!day);
  const today = eventWallClock(now, timeZone);
  const opensAt = morningOpensAt(schedule, timeZone);
  // Every Event-local date that has a Day on it, mapped to the Day that owns it.
  const owners = new Map<string, EmailDay>();
  for (const day of schedule) {
    const date = dayCalendarDate(day);
    if (!date) continue;
    const held = owners.get(date);
    if (!held || day.index < held.index) owners.set(date, day);
  }
  let carried: EmailDay | null = null;
  for (const [date, day] of owners) {
    if (!windowIsOpen(day, date, now, today, windowMs, opensAt)) continue;
    if (date === today.date) return day;
    if (!carried || day.unlockAt > carried.unlockAt) carried = day;
  }
  return carried;
}

/** Whether this participant should be mailed for `dayIndex`: opted in, and not
 *  already sent. Pure, so the suppression rule is testable on its own. */
export function shouldSendTo(
  prefs: { optedOut: boolean; lastSentDayIndex?: number } | null,
  dayIndex: number,
): boolean {
  if (!prefs) return false; // no honorable unsubscribe → no email
  if (prefs.optedOut) return false;
  return !(typeof prefs.lastSentDayIndex === 'number' && prefs.lastSentDayIndex >= dayIndex);
}

// --- Firestore reads ------------------------------------------------------------

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize a `dayStats` map read off a Player doc, dropping every entry that
 * is not a well-formed `{ bingoCount, squaresMarked, firstBingoAt }`.
 *
 * `players/{uid}` is SELF-WRITABLE by design (ADR 0001 — stats are
 * client-authoritative), so `dayStats` is untrusted runtime shape, not a
 * contract. A single row carrying `{ dayStats: { 0: null } }` — reachable by
 * any participant, deliberately or by a client bug — would otherwise throw
 * while building the model and take the WHOLE Event's send down with it (Codex
 * #623 P2). This is the same defensive normalization `readFinaleRoster` applies
 * in `unlockDay.ts`, and for the same reason.
 */
export function sanitizeEmailDayStats(value: unknown): Record<number, FinaleDayStat> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<number, FinaleDayStat> = {};
  for (const [key, raw] of Object.entries(value)) {
    const dayIndex = Number(key);
    if (!Number.isInteger(dayIndex) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const stat = raw as Record<string, unknown>;
    if (typeof stat.bingoCount !== 'number' || !Number.isFinite(stat.bingoCount)) continue;
    if (typeof stat.squaresMarked !== 'number' || !Number.isFinite(stat.squaresMarked)) continue;
    out[dayIndex] = {
      bingoCount: stat.bingoCount,
      squaresMarked: stat.squaresMarked,
      firstBingoAt:
        typeof stat.firstBingoAt === 'number' && Number.isFinite(stat.firstBingoAt)
          ? stat.firstBingoAt
          : null,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The Event's roster as `EmailPlayer[]`, ban-filtered. Mirrors
 *  `readFinaleRoster`/`visibleFinaleRoster` in `unlockDay.ts` — the standings a
 *  banned Player is hidden from must be the same standings the email prints.
 *
 *  BOUNDED AT THE QUERY, not just in the loop that consumes it (Codex #623 P2):
 *  an unbounded `.get()` materializes the whole collection into memory before
 *  any cap can apply, so a corrupted roster exhausts the function during the
 *  READ and never reaches the guard downstream. `limit` is one MORE than the
 *  ceiling so the caller can tell "exactly at the ceiling" from "truncated". */
async function readEmailRosterPage(
  db: DailyEmailFirestore,
  eventId: string,
  bannedUids: readonly string[] = [],
  limit?: number,
): Promise<{ allPlayers: EmailPlayer[]; players: EmailPlayer[]; queriedCount: number }> {
  const base = db.collection(`events/${eventId}/players`);
  const snap = await (limit && limit > 0 ? base.limit(limit) : base).get();
  const allPlayers = snap.docs
    .map((d) => {
      const data = (d.data() ?? {}) as Record<string, unknown>;
      const uid = d.id || (typeof data.uid === 'string' ? data.uid : '');
      return {
        uid,
        displayName:
          typeof data.displayName === 'string' && data.displayName ? data.displayName : 'Anonymous',
        bingoCount: finiteNumber(data.bingoCount, 0),
        squaresMarked: finiteNumber(data.squaresMarked, 0),
        firstBingoAt:
          typeof data.firstBingoAt === 'number' && Number.isFinite(data.firstBingoAt)
            ? data.firstBingoAt
            : null,
        dayStats: sanitizeEmailDayStats(data.dayStats),
      };
    })
    .filter((p) => p.uid !== '');
  const banned = new Set(bannedUids);
  const players = allPlayers.filter((p) => !banned.has(p.uid));
  return { allPlayers, players, queriedCount: snap.docs.length };
}

export async function readEmailRoster(
  db: DailyEmailFirestore,
  eventId: string,
  bannedUids: readonly string[] = [],
  limit?: number,
): Promise<EmailPlayer[]> {
  return (await readEmailRosterPage(db, eventId, bannedUids, limit)).players;
}

/**
 * The Event's Edition and canonical origin, from the public hostname map
 * (`hostnames/{host}` → `{ eventId, canonicalHost, edition, isCanonical }`).
 *
 * Queried on `eventId` ALONE and filtered in memory: a two-field
 * `where(...).where(...)` needs a composite index, and this feature is not
 * worth adding one for — the result set is an Event's handful of registered
 * addresses. The canonical entry wins; failing that the first active one; and
 * failing THAT the caller's `APP_BASE_URL` fallback, so a deployment with no
 * hostname documents at all still mails a working link (#599: links use the
 * Event's canonical host; #607's entry-point rules do not apply to email,
 * which has no entry-point origin).
 */
export async function resolveEventOrigin(
  db: HostnameSource,
  eventId: string,
  fallbackOrigin: string,
): Promise<{ origin: string; edition: string | null }> {
  try {
    const snap = await db.collection('hostnames').where('eventId', '==', eventId).get();
    const rows = snap.docs
      .map((d) => {
        const data = (d.data() ?? {}) as Record<string, unknown>;
        return {
          host: typeof data.canonicalHost === 'string' && data.canonicalHost ? data.canonicalHost : d.id,
          edition: typeof data.edition === 'string' ? data.edition : null,
          isCanonical: data.isCanonical === true,
          active: data.status === 'active',
        };
      })
      .filter((r) => r.active && r.host);
    const chosen = rows.find((r) => r.isCanonical) ?? rows[0];
    if (chosen) return { origin: `https://${chosen.host}`, edition: chosen.edition };
  } catch (err) {
    console.error('resolveEventOrigin: hostname lookup failed', eventId, err);
    // A failed read is not a confirmed absence. Falling back here would also
    // erase the Event's Edition and can mail a Vacay/Five Across roster in the
    // legacy Gay Cruise Bingo register. Let the per-Event sweep boundary log
    // and skip this Event; the next quarter-hourly run can retry safely.
    throw err;
  }
  return { origin: fallbackOrigin, edition: null };
}

// --- The send -------------------------------------------------------------------

export interface DailyEmailDeps extends OptOutDeps {
  /** Override the send transport (defaults to `sendEmail`). */
  send?: typeof sendEmail;
  /** Resolve a uid to its verified email, or null. Defaults to a Firebase Auth
   *  lookup, matching `notify.ts`'s verified-only policy. */
  getEmailForUid?: (uid: string) => Promise<string | null>;
  /** Sender identity; defaults to the `EMAIL_FROM` param (Edition-aware per
   *  #554, which this reads through rather than duplicating). */
  from?: string;
  /** Fallback origin when the Event has no hostname documents; defaults to the
   *  `APP_BASE_URL` param. */
  appBaseUrl?: string;
  /** Base URL of the unsubscribe endpoint; defaults to the `EMAIL_UNSUBSCRIBE_URL`
   *  param, or the project's hosted `/unsubscribe` URL (a Firebase Hosting
   *  rewrite to the `emailUnsubscribe` function — see `functions/src/params.ts`). */
  unsubscribeBaseUrl?: string;
  /** Milliseconds to wait between sends. Resend's default account limit is a
   *  couple of requests a second, so an unpaced fan-out to a full roster would
   *  be throttled into dropped mail. Set to 0 in tests. */
  pacingMs?: number;
  /** Injectable sleep so the pacing above costs a test nothing. */
  sleep?: (ms: number) => Promise<void>;
  /** Hard ceiling on recipients per Event per run — a runaway guard, not an
   *  expected limit. */
  maxRecipients?: number;
}


const DEFAULT_PACING_MS = 550;

/**
 * The per-run recipient ceiling — deliberately far ABOVE what one run can
 * actually deliver.
 *
 * A ROSTER LARGER THAN ONE RUN IS FINE, and that is the design rather than a
 * gap. Paced sending means a big roster can outlast the function's 540s
 * timeout: at the default 550ms spacing a run gets through roughly 900
 * recipients before the platform kills it mid-loop. The next sweep — fifteen
 * minutes later, still inside the six-hour due window — resumes exactly where
 * this one stopped, because every recipient already mailed carries
 * `lastSentDayIndex` and is skipped. Nobody is mailed twice and nobody is
 * missed; the send simply spreads across a few sweeps.
 *
 * So this cap bounds a PATHOLOGICAL roster (a corrupted `players` collection),
 * it does not size a batch. Lowering it to "what fits in one run" would
 * silently cap large Events instead of letting them drain.
 */
const DEFAULT_MAX_RECIPIENTS = 2000;

async function defaultGetEmailForUid(uid: string): Promise<string | null> {
  try {
    const { getAuth } = await import('firebase-admin/auth');
    const user = await getAuth().getUser(uid);
    return user.email && user.emailVerified ? user.email : null;
  } catch {
    return null; // one broken uid must never sink the whole send
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export interface DailySendResult {
  /** Emails actually accepted by the transport. */
  sent: number;
  /** Participants suppressed before send: opted out, already sent, or with no
   *  verified email on file. */
  skipped: number;
  /** Transport failures — logged, never thrown. */
  failed: number;
  /** Why nothing was attempted, when nothing was. */
  reason?: 'no-event' | 'disabled' | 'not-due' | 'no-roster';
}

/**
 * Send the daily email for ONE Event, if one is due. Idempotent: a second run
 * inside the same window sends nothing (every recipient's `lastSentDayIndex`
 * already covers the Day).
 */
export async function sendDailyEmailForEvent(
  db: DailyEmailFirestore,
  eventId: string,
  deps: DailyEmailDeps = {},
): Promise<DailySendResult> {
  const now = (deps.now ?? Date.now)();
  const event = (await db.doc(`events/${eventId}`).get()).data() as EmailEvent | undefined;
  if (!event) return { sent: 0, skipped: 0, failed: 0, reason: 'no-event' };
  if (!dailyEmailEnabled(event)) return { sent: 0, skipped: 0, failed: 0, reason: 'disabled' };

  const day = dueDayForDailyEmail(event.days, now, event.timezone);
  if (!day) return { sent: 0, skipped: 0, failed: 0, reason: 'not-due' };

  const appBaseUrl = deps.appBaseUrl ?? (await import('./params')).APP_BASE_URL.value();
  const unsubscribeBaseUrl =
    deps.unsubscribeBaseUrl ?? (await import('./params')).EMAIL_UNSUBSCRIBE_URL.value();
  const from = deps.from ?? (await import('./params')).EMAIL_FROM.value();
  const send = deps.send ?? (await import('./email')).sendEmail;
  const getEmailForUid = deps.getEmailForUid ?? defaultGetEmailForUid;
  const sleep = deps.sleep ?? defaultSleep;
  const pacingMs = deps.pacingMs ?? DEFAULT_PACING_MS;
  const maxRecipients = deps.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;

  const { origin, edition } = await resolveEventOrigin(db, eventId, appBaseUrl);
  const feedUrl = `${origin.replace(/\/+$/, '')}/feed`;

  const rosterPage = await readEmailRosterPage(db, eventId, event.bannedUids ?? [], maxRecipients + 1);
  const roster = rosterPage.players;
  if (rosterPage.queriedCount > maxRecipients) {
    // Loud, because it means the Event is either pathological or has outgrown
    // the documented ceiling — and in the latter case nobody past the cap gets
    // mail, which is a delivery gap, not a tidy degradation. Count the RAW
    // query page rather than the ban-filtered roster: a banned row inside the
    // page must not hide the fact that valid participants beyond it were cut
    // off by the query limit.
    console.error(
      `sendDailyEmailForEvent: roster exceeds the ${maxRecipients} ceiling; the remainder will not be mailed`,
      eventId,
      day.index,
    );
  }
  if (roster.length === 0) return { sent: 0, skipped: 0, failed: 0, reason: 'no-roster' };
  // ONCE for the whole send, not once per recipient: the standings snapshot is
  // identical for everyone (the rank line is a lookup into it), so recomputing
  // it inside the loop would re-slice and re-sort the roster N times for the
  // same answer — quadratic in roster size.
  const tutorialDays = tutorialDayIndexes(event.days ?? []);
  const rawRanked = standingsThrough(rosterPage.allPlayers, day.index, tutorialDays);
  const starUid = firstBingoUid(rawRanked);
  const banned = new Set(event.bannedUids ?? []);
  const ranked = rawRanked.filter((player) => !banned.has(player.uid));

  const result: DailySendResult = { sent: 0, skipped: 0, failed: 0 };
  // EXAMINED, not attempted (Codex #623 P2). The cap used to count only real
  // send attempts, so a roster that is entirely opted out, already sent, or
  // missing verified addresses incremented nothing and ran the loop to the end
  // — each iteration still costing a preference read. The ceiling has to bound
  // the WORK, and the work is per-player regardless of whether mail goes out.
  //
  // Counting examined players does not strand a legitimate large Event: every
  // roster at or under the ceiling is examined in full on every sweep, so
  // continuation is unaffected. Only a roster ABOVE the ceiling is truncated,
  // which is the runaway case this guard exists for, and it is logged above.
  let examined = 0;

  for (const player of roster) {
    if (examined >= maxRecipients) {
      console.warn(`sendDailyEmailForEvent: examined cap ${maxRecipients} reached`, eventId, day.index);
      break;
    }
    examined++;
    try {
      // Consent FIRST, address second: an opted-out participant's email address
      // is never even looked up, and a participant whose opt-out doc cannot be
      // minted is skipped rather than mailed without a working unsubscribe.
      const prefs = await ensureEmailPrefs(db, eventId, player.uid, deps);
      if (prefs === null || !shouldSendTo(prefs, day.index)) {
        result.skipped++;
        continue;
      }
      const to = await getEmailForUid(player.uid);
      if (!to) {
        result.skipped++;
        continue;
      }
      const linkArgs = { baseUrl: unsubscribeBaseUrl, eventId, uid: player.uid, token: prefs.token };
      const unsubUrl = unsubscribeLink(linkArgs);
      const model = buildDailyEmailModel({
        event,
        day,
        players: roster,
        ranked,
        starUid,
        recipient: { uid: player.uid, displayName: player.displayName },
        edition,
        feedUrl,
        unsubscribeUrl: unsubUrl,
        preferencesUrl: preferencesLink(linkArgs),
      });
      const ok = await send({
        to: [to],
        subject: model.subject,
        html: renderDailyEmailHtml(model),
        text: renderDailyEmailText(model),
        from,
        // Stable per Event/Day/recipient: a retry of the same beat dedupes at
        // Resend, while tomorrow's Day is a different key and delivers.
        idempotencyKey: `daily-email/${eventId}/${day.index}/${player.uid}`,
        headers: listUnsubscribeHeaders(unsubUrl),
      });
      if (ok) {
        result.sent++;
        await markDailyEmailSent(db, eventId, player.uid, day.index, deps);
      } else {
        result.failed++;
      }
      if (pacingMs > 0) await sleep(pacingMs);
    } catch (err) {
      console.error('sendDailyEmailForEvent: recipient failed', eventId, player.uid, err);
      result.failed++;
    }
  }
  console.log(
    `sendDailyEmailForEvent ${eventId} day ${day.index}: sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`,
  );
  return result;
}

/** One sweep across every active Event. Best-effort per Event.
 *
 * Event work starts concurrently so a large or slow first Event cannot consume
 * the whole 540-second invocation before later Events are even visited. Actual
 * transport calls still pass through ONE shared pacing queue: concurrency is
 * for fairness across Events, never a multiplier on Resend's account-wide
 * request rate. Each Event keeps at most one delivery queued because its own
 * recipient loop awaits every send before advancing. */
export async function runDailyEmailSweep(
  db: DailyEmailFirestore,
  deps: DailyEmailDeps = {},
): Promise<void> {
  const events = await db.collection('events').where('status', '==', 'active').get();
  const transport = deps.send ?? (await import('./email')).sendEmail;
  const pacingMs = deps.pacingMs ?? DEFAULT_PACING_MS;
  const sleep = deps.sleep ?? defaultSleep;
  let deliveryTail: Promise<void> = Promise.resolve();
  const pacedTransport: typeof sendEmail = async (args) => {
    const turn = deliveryTail;
    let release!: () => void;
    deliveryTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await turn;
    try {
      return await transport(args);
    } finally {
      try {
        await sleep(pacingMs);
      } finally {
        release();
      }
    }
  };

  await Promise.all(
    events.docs.map(async (ev) => {
      try {
        await sendDailyEmailForEvent(db, ev.id, {
          ...deps,
          send: pacedTransport,
          pacingMs: 0,
        });
      } catch (err) {
        console.error('runDailyEmailSweep: event failed', ev.id, err);
      }
    }),
  );
}
