/**
 * Daily themed engagement email — the scheduled ORCHESTRATION (issue #616,
 * plans/daily-cards-wireframes.html § "Daily engagement email").
 *
 * One email per participant per Day, sent at the Day's unlock in the Event's
 * timezone, carrying the Day's Theme. This module owns WHO gets it and WHEN;
 * `dailyEmailContent.ts` owns WHAT it says, `dailyEmailTemplate.ts` owns how it
 * looks, and `emailOptOut.ts` owns consent. The trigger seam in `index.ts` is
 * three lines.
 *
 * WHY A QUARTER-HOURLY TRIGGER FOR A DAILY EMAIL (the #552 lesson, restated
 * because it is the thing most likely to be "simplified" later). The send has
 * to land at the Day's unlock in the EVENT's timezone, and a Cloud Scheduler
 * cron is a single fixed schedule for every Event the deployment serves. A
 * daily UTC cron would fire at some arbitrary local hour — 23:00 the previous
 * evening for a Pacific Event — and a per-Event cron would mean a deploy every
 * time an Event is created somewhere new. So the schedule is a frequent, dumb
 * sweep and the DUE CHECK is the real clock: `dueDayForDailyEmail` fires only
 * inside a window that opens at the Day's own `unlockAt` (an absolute instant
 * derived from the Event's local schedule), which makes the send
 * timezone-correct with no timezone arithmetic anywhere in this file. Fifteen
 * minutes rather than an hour for the same reason `unlockDay` uses it: real
 * IANA offsets include :30 and :45, so an hourly sweep would be late by up to
 * 59 minutes in those zones.
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
  get(): Promise<{ docs: Snapshot[] }>;
}
/** The minimal surface the daily email uses: the opt-out doc surface
 *  (`EmailPrefsFirestore`, inherited whole — including its `create`) plus the
 *  roster and hostname queries. */
export interface DailyEmailFirestore extends EmailPrefsFirestore {
  collection(path: string): Query;
}

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
 * The Day whose email is due at `now`, or `null`. Due means: unlock has passed
 * AND `now` is still inside the send window. The LAST such Day wins, so an
 * Event whose Days somehow overlap sends today's card, not a stale one.
 */
export function dueDayForDailyEmail(
  days: readonly EmailDay[] | undefined,
  now: number,
  windowMs: number = SEND_WINDOW_MS,
): EmailDay | null {
  let due: EmailDay | null = null;
  for (const day of days ?? []) {
    if (typeof day?.unlockAt !== 'number' || !Number.isFinite(day.unlockAt)) continue;
    // A non-positive `unlockAt` is the "live pre-event" sentinel some seeds use
    // (#289), not a real instant — it would look permanently overdue and mail
    // the Day forever, so it is never due.
    if (day.unlockAt <= 0) continue;
    if (day.unlockAt > now || now >= day.unlockAt + windowMs) continue;
    if (!due || day.unlockAt > due.unlockAt) due = day;
  }
  return due;
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
 *  banned Player is hidden from must be the same standings the email prints. */
export async function readEmailRoster(
  db: DailyEmailFirestore,
  eventId: string,
  bannedUids: readonly string[] = [],
): Promise<EmailPlayer[]> {
  const snap = await db.collection(`events/${eventId}/players`).get();
  return snap.docs
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
    .filter((p) => p.uid !== '' && !bannedUids.includes(p.uid));
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
  db: DailyEmailFirestore,
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
   *  param, or the endpoint's conventional Cloud Functions URL. */
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

  const day = dueDayForDailyEmail(event.days, now);
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

  const roster = await readEmailRoster(db, eventId, event.bannedUids ?? []);
  if (roster.length === 0) return { sent: 0, skipped: 0, failed: 0, reason: 'no-roster' };
  // ONCE for the whole send, not once per recipient: the standings snapshot is
  // identical for everyone (the rank line is a lookup into it), so recomputing
  // it inside the loop would re-slice and re-sort the roster N times for the
  // same answer — quadratic in roster size.
  const ranked = standingsThrough(roster, day.index, tutorialDayIndexes(event.days ?? []));

  const result: DailySendResult = { sent: 0, skipped: 0, failed: 0 };
  let attempted = 0;

  for (const player of roster) {
    if (attempted >= maxRecipients) {
      console.warn(`sendDailyEmailForEvent: recipient cap ${maxRecipients} reached`, eventId, day.index);
      break;
    }
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
        recipient: { uid: player.uid, displayName: player.displayName },
        edition,
        feedUrl,
        unsubscribeUrl: unsubUrl,
        preferencesUrl: preferencesLink(linkArgs),
      });
      attempted++;
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

/** One sweep across every active Event. Best-effort per Event. */
export async function runDailyEmailSweep(
  db: DailyEmailFirestore,
  deps: DailyEmailDeps = {},
): Promise<void> {
  const events = await db.collection('events').where('status', '==', 'active').get();
  for (const ev of events.docs) {
    try {
      await sendDailyEmailForEvent(db, ev.id, deps);
    } catch (err) {
      console.error('runDailyEmailSweep: event failed', ev.id, err);
    }
  }
}
