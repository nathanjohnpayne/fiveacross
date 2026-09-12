/**
 * Winner-announcement email SEND (issue #1192). The last mail an Event sends:
 * one per opted-in participant at the finale's podium beat, replacing the daily
 * card that #1121 stops at the Standings Freeze.
 *
 * WHAT THIS FILE IS AND IS NOT. It owns the email concerns only — consent,
 * addresses, the Edition's sender and canonical host, pacing, the transport and
 * the per-recipient marker. It owns NO finale logic: the podium payload, the
 * ranked standings and the frozen Most-Loved award all arrive as arguments,
 * computed once by the beat in `unlockDay.ts` from the roster it has already
 * read. That is deliberate, and it is what makes the parity requirement
 * structural rather than asserted: the email is handed the SAME payload object
 * the `podium` Moment is written from, so there is no second computation for it
 * to disagree with.
 *
 * AND IT IS INJECTED, NOT IMPORTED BY THE BEAT. `runFinaleBeats` reaches this
 * code through an optional `UnlockDeps.sendPodiumEmail` dep, so `unlockDay.ts`
 * keeps a Firestore-only dependency graph and every existing finale test runs
 * with no transport at all. `index.ts` binds the default at the composition
 * root, where the real Admin SDK Firestore satisfies both this module's
 * surface and the beat's.
 */
import { dailyEmailEnabled, resolveEmailFrom, resolveEventOrigin } from './dailyEmail';
import type { DailyEmailDeps, DailyEmailFirestore } from './dailyEmail';
import {
  ensureEmailPrefs,
  markPodiumEmailSent,
  preferencesLink,
  shouldSendPodiumTo,
  unsubscribeLink,
  listUnsubscribeHeaders,
} from './emailOptOut';
import type { FinalePlayer, PodiumPayload } from './finaleContent';
import { buildPodiumEmailModel } from './podiumEmailContent';
import { renderPodiumEmailHtml, renderPodiumEmailText } from './podiumEmailTemplate';
import type { MostLovedPhotoAward } from '../../src/domainTypes';

/** Everything the beat hands over. Every field is already computed — this
 *  module reads no finale state of its own. */
export interface PodiumEmailInput {
  /** The Event doc as the beat read it, for the name, the admin toggle and the
   *  archive guard. */
  event: {
    name?: unknown;
    settings?: { dailyEmailEnabled?: unknown } | undefined;
  };
  /** The payload written to the `podium` Moment, passed through verbatim. */
  podium: PodiumPayload;
  /** `podiumStandings(...)` output, ban-filtered — the ranked roster whose head
   *  IS `podium.champion`. Doubles as the recipient list: every row carries the
   *  uid and display name the send needs, so the fan-out costs no extra read. */
  ranked: readonly FinalePlayer[];
  /** The frozen award, or `null` for an Event that never computed one. */
  mostLoved?: MostLovedPhotoAward | null;
  /** The closing Day, already formatted in the Event's timezone by the beat —
   *  this module holds no clock and no timezone logic. */
  closingDay: {
    themeId?: string | null;
    dayNumber: number;
    dayCount: number;
    dateLabel: string;
    placeLabel: string;
  };
  /** `dayIndex` → "Day 2 in Split 🇭🇷", for the ⭐ line's qualifier. */
  honorDayLabels?: Readonly<Record<number, string>>;
}

export interface PodiumSendResult {
  /** Emails accepted by the transport. */
  sent: number;
  /** Suppressed before send: opted out, already sent, or no verified address. */
  skipped: number;
  /** Transport failures — logged, never thrown. */
  failed: number;
  /**
   * Whether this run finished the Event's fan-out, so the beat may stop asking.
   *
   * FALSE IS THE RESUMABLE ANSWER, and the distinction is what keeps a partial
   * send from being stranded. A roster can outlast one invocation exactly as the
   * daily card's can, and a transport failure is worth one more attempt — in
   * both cases the recipients already mailed carry `podiumEmailSentAt` and are
   * skipped, so the next sweep resumes rather than repeating. Only a run that
   * examined the whole roster with nothing failing has actually finished.
   */
  drained: boolean;
  /** Why nothing was sent, when nothing was. */
  reason?: 'disabled' | 'no-roster';
}

/** The per-run recipient ceiling — a runaway guard on a corrupted roster, not a
 *  batch size. Matches the daily card's ceiling and its reasoning: a roster at
 *  or under it is examined in full every run, so continuation is unaffected. */
const DEFAULT_MAX_RECIPIENTS = 2000;
const DEFAULT_PACING_MS = 550;

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

/**
 * Send the winner-announcement email for ONE Event.
 *
 * Idempotent per recipient: a second run sends nothing to anyone already
 * carrying `podiumEmailSentAt`, and the Resend idempotency key — keyed on the
 * Event and the recipient with NO Day in it, because there is exactly one such
 * mail per Event — collapses a duplicate inside its 24h window even when the
 * marker write is the thing that failed.
 *
 * NEVER THROWS. The beat calls this after the freeze and the podium Moment have
 * already committed, and the ticket requires a failed send not to block either;
 * every per-recipient failure is counted and logged, and the whole call is
 * wrapped by the beat as well.
 */
export async function sendPodiumEmailForEvent(
  db: DailyEmailFirestore,
  eventId: string,
  input: PodiumEmailInput,
  deps: DailyEmailDeps = {},
): Promise<PodiumSendResult> {
  const result: PodiumSendResult = { sent: 0, skipped: 0, failed: 0, drained: false };

  // The SAME Event-level opt-in the daily card reads: the ticket adds no new
  // category, so an Event that never turned the daily email on does not start
  // mailing at its finale either. `drained: true` — there is nothing owed, so
  // the beat should stop asking rather than retry forever.
  if (!dailyEmailEnabled(input.event as Parameters<typeof dailyEmailEnabled>[0])) {
    return { ...result, drained: true, reason: 'disabled' };
  }
  if (input.ranked.length === 0) {
    return { ...result, drained: true, reason: 'no-roster' };
  }

  const appBaseUrl = deps.appBaseUrl ?? (await import('./params')).APP_BASE_URL.value();
  const unsubscribeBaseUrl =
    deps.unsubscribeBaseUrl ?? (await import('./params')).EMAIL_UNSUBSCRIBE_URL.value();
  const send = deps.send ?? (await import('./email')).sendEmail;
  const getEmailForUid = deps.getEmailForUid ?? defaultGetEmailForUid;
  const sleep = deps.sleep ?? defaultSleep;
  const pacingMs = deps.pacingMs ?? DEFAULT_PACING_MS;
  const maxRecipients = deps.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;

  // Resolved before `from`, because the sender is Edition-aware (#671) and the
  // Edition only becomes known once the Event's host resolves.
  const { origin, edition } = await resolveEventOrigin(db, eventId, appBaseUrl);
  const from = deps.from ?? (await resolveEmailFrom(edition, deps.fromOverrides));
  const feedUrl = `${origin.replace(/\/+$/, '')}/feed`;
  const eventName = typeof input.event.name === 'string' ? input.event.name : '';

  let capHit = false;
  let examined = 0;
  for (const player of input.ranked) {
    if (examined >= maxRecipients) {
      console.error(
        `sendPodiumEmailForEvent: examined cap ${maxRecipients} reached; the remainder is not mailed`,
        eventId,
      );
      capHit = true;
      break;
    }
    examined++;
    try {
      // Consent FIRST, address second — an opted-out participant's address is
      // never looked up, and one whose prefs doc cannot be minted is skipped
      // rather than mailed without a working unsubscribe.
      const prefs = await ensureEmailPrefs(db, eventId, player.uid, deps);
      if (prefs === null || !shouldSendPodiumTo(prefs)) {
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
      const model = buildPodiumEmailModel({
        eventName,
        podium: input.podium,
        mostLoved: input.mostLoved ?? null,
        ranked: input.ranked,
        closingDay: input.closingDay,
        honorDayLabels: input.honorDayLabels,
        recipient: { uid: player.uid, displayName: player.displayName },
        edition,
        feedUrl,
        unsubscribeUrl: unsubUrl,
        preferencesUrl: preferencesLink(linkArgs),
      });
      const ok = await send({
        to: [to],
        subject: model.subject,
        html: renderPodiumEmailHtml(model),
        text: renderPodiumEmailText(model),
        from,
        // NO Day index in the key, unlike the daily card's: there is exactly one
        // winner mail per Event per recipient, so the Event and the uid are the
        // whole identity of the send. A retry after a failed marker write
        // dedupes at Resend rather than arriving twice.
        idempotencyKey: `podium-email/${eventId}/${player.uid}`,
        headers: listUnsubscribeHeaders(unsubUrl),
      });
      if (ok) {
        result.sent++;
        await markPodiumEmailSent(db, eventId, player.uid, deps);
      } else {
        result.failed++;
      }
      if (pacingMs > 0) await sleep(pacingMs);
    } catch (err) {
      // Sanitized: the code and the ids, never the address or the payload — the
      // ticket requires a failure to be logged without leaking the recipient.
      console.error(
        'sendPodiumEmailForEvent: recipient failed',
        eventId,
        player.uid,
        err instanceof Error ? err.name : 'unknown',
      );
      result.failed++;
    }
  }

  result.drained = !capHit && result.failed === 0;
  console.log(
    `sendPodiumEmailForEvent ${eventId}: sent=${result.sent} skipped=${result.skipped} ` +
      `failed=${result.failed} drained=${result.drained}`,
  );
  return result;
}
