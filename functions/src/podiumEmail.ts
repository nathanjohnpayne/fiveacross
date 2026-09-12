/**
 * Winner-announcement email (issue #1192). The last mail an Event sends: one per
 * opted-in participant once the finale's `podium` Moment has been posted,
 * replacing the daily card that #1121 stops at the Standings Freeze.
 *
 * ITS OWN SCHEDULED SWEEP, not a finale beat (Codex on PR #1207). The first
 * implementation ran the fan-out inside `runFinaleBeats`, and three separate
 * findings were all that coupling: the `unlockDay` scheduler binds no
 * `RESEND_API_KEY` and defaults to a 60-second timeout, its Event loop is
 * SERIAL — so one Event's paced per-recipient fan-out delayed every later
 * Event's Day snapshot — and an email-only retry rebuilt the podium from live,
 * client-authoritative Player documents, which a post-freeze display-name or
 * count edit could make disagree with the Moment already posted. A separate
 * trigger, shaped exactly like `dailyEngagementEmail`, answers all three.
 *
 * AND THE MOMENT IS THE SOURCE, not the roster. The `podium` Moment is written
 * once at a deterministic id and never amended, so reading its stored payload is
 * what makes the email quote the frozen record BY CONSTRUCTION rather than by a
 * recomputation that happens to agree — #1052 being the record of what it costs
 * when several readers of one honour each derive it themselves.
 *
 * The residual is stated in the spec: the Moment carries a single `champion`, so
 * ranks 2 and 3 are read from the roster through `podiumStandings`. They can
 * therefore drift from what the Moment would have shown if a Player edits their
 * own document after the freeze — the freeze cutoff bounds timestamps, not
 * counts. The honours that the Moment DOES carry — the champion, the ⭐ — never
 * drift.
 */
import { dailyEmailEnabled, resolveEmailFrom, resolveEventOrigin } from './dailyEmail';
import type { DailyEmailDeps, DailyEmailFirestore } from './dailyEmail';
// The SAME readers and the SAME normalisation the finale beat uses, imported
// rather than restated: #1152 is the record of what a second copy of the roster
// normalisation costs. `eventClosedToPlay` is the same freeze predicate the
// daily card consults at this boundary.
import {
  eventClosedToPlay,
  readDayHonors,
  readFinaleRoster,
  visibleFinaleRoster,
  type FinaleReadSource,
} from './unlockDay';
import { formatDayDate, placeLabel, type EmailDay } from './dailyEmailContent';
import { podiumStandings, standingsFreezeAtFor } from './finaleContent';
import {
  ensureEmailPrefs,
  markPodiumEmailSent,
  markPodiumEmailUndeliverable,
  preferencesLink,
  shouldSendPodiumTo,
  unsubscribeLink,
  listUnsubscribeHeaders,
} from './emailOptOut';
import type { FinalePlayer, PodiumPayload } from './finaleContent';
import { buildPodiumEmailModel, type VisibleMostLovedAward } from './podiumEmailContent';
import { renderPodiumEmailHtml, renderPodiumEmailText } from './podiumEmailTemplate';
import type { MostLovedPhotoAward, MostLovedPhotoWinner } from '../../src/domainTypes';

/** Everything the beat hands over. Every field is already computed — this
 *  module reads no finale state of its own. */
export interface PodiumEmailInput {
  /** The Event doc as the beat read it, for the name, the admin toggle and the
   *  archive guard. */
  event: {
    name?: unknown;
    settings?: { dailyEmailEnabled?: unknown; reportHideThreshold?: unknown } | undefined;
  };
  /** The payload written to the `podium` Moment, passed through verbatim. */
  podium: PodiumPayload;
  /** `podiumStandings(...)` output, ban-filtered — the ranked roster whose head
   *  IS `podium.champion`. Doubles as the recipient list: every row carries the
   *  uid and display name the send needs, so the fan-out costs no extra read. */
  ranked: readonly FinalePlayer[];
  /** The frozen award, already validated and ban-filtered, or `null`. */
  mostLoved?: VisibleMostLovedAward | null;
  /** Whether the Event's board was empty at the freeze, read off the Moment
   *  before its honours were ban-filtered. */
  boardWasEmpty: boolean;
  /** The ban roster the honours and the recipient list were filtered against,
   *  carried so the completion guard can compare like with like. */
  bannedUids?: readonly string[];
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
  /** The Most-Loved photo's own Day, already formatted. */
  photoDayLabel?: string;
}

export interface PodiumSendResult {
  /** Emails accepted by the transport. */
  sent: number;
  /** PERMANENTLY suppressed: opted out, already sent, or no address on file.
   *  Nothing about a skipped recipient is worth retrying. */
  skipped: number;
  /** Transport failures — logged, never thrown. */
  failed: number;
  /**
   * Recipients this run could not DECIDE about, because a dependency failed:
   * the prefs doc could not be read or minted, or the address lookup threw.
   *
   * SEPARATE FROM `skipped` because the drain verdict turns on the difference
   * (Codex P1 on PR #1207). `ensureEmailPrefs` returns `null` on a Firestore
   * failure and an address lookup returns nothing on an Auth outage, and both
   * used to land in `skipped` — which the verdict ignored. A transient outage
   * could therefore skip an entire roster, report `drained: true`, stamp the
   * Event marker, and mean nobody was ever mailed. A blocked recipient is a
   * question still open, so it keeps the run undrained.
   */
  blocked: number;
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
  reason?: 'disabled' | 'no-roster' | 'archived' | 'bans-changed';
}

/** The per-run recipient ceiling — a runaway guard on a corrupted roster, not a
 *  batch size. Matches the daily card's ceiling and its reasoning: a roster at
 *  or under it is examined in full every run, so continuation is unaffected. */
const DEFAULT_MAX_RECIPIENTS = 2000;
const DEFAULT_PACING_MS = 550;

/**
 * The verified-address lookup, matching `notify.ts`'s verified-only policy.
 *
 * IT DOES NOT SWALLOW ITS OWN FAILURE, unlike the daily card's copy of this
 * (Codex P1 on PR #1207): a `user-not-found` is a permanent "no address", but
 * an Auth outage is not, and a lookup that returns `null` for both makes them
 * indistinguishable to the drain verdict. Throwing lets `resolveAddress` keep
 * the outage retryable; the throw never escapes the recipient loop's own
 * try/catch, so one broken uid still cannot sink the send.
 */
async function defaultGetEmailForUid(uid: string): Promise<string | null> {
  const { getAuth } = await import('firebase-admin/auth');
  try {
    const user = await getAuth().getUser(uid);
    return user.email && user.emailVerified ? user.email : null;
  } catch (err) {
    // A uid with no Auth record will never acquire one retroactively — that is
    // a permanent absence, not an outage, so it stays a skip.
    if ((err as { code?: string })?.code === 'auth/user-not-found') return null;
    throw err;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * One recipient's address, as THREE outcomes rather than `string | null`.
 *
 * The lookup's own contract cannot tell them apart — `defaultGetEmailForUid`
 * catches an Auth failure and returns `null`, which is the same value it
 * returns for a participant with no verified address — and those two must not
 * share a fate: the first is worth retrying and the second never will be. A
 * THROW is read as the transient case, which is why the default above is
 * wrapped here rather than swallowing its own error. An injected lookup that
 * returns `null` is taken at its word ("no address"), because a caller that
 * wants the transient answer can throw for it.
 */
async function resolveAddress(
  lookup: (uid: string) => Promise<string | null>,
  uid: string,
): Promise<{ status: 'ok'; email: string } | { status: 'none' } | { status: 'error' }> {
  try {
    const email = await lookup(uid);
    return email ? { status: 'ok', email } : { status: 'none' };
  } catch {
    return { status: 'error' };
  }
}

/** Whether the Event's ban roster differs from the one a snapshot was filtered
 *  against. Order-insensitive and tolerant of a malformed stored value, which
 *  reads as an empty roster exactly as `visibleFinaleRoster` treats it. */
function bansDiffer(filteredAgainst: readonly string[], current: unknown): boolean {
  const now = Array.isArray(current) ? current.filter((u): u is string => typeof u === 'string') : [];
  if (now.length !== filteredAgainst.length) return true;
  const before = new Set(filteredAgainst);
  return now.some((uid) => !before.has(uid));
}

/**
 * Verify the recipient set and write `podiumEmailAt` in ONE transaction, and say
 * whether the marker landed.
 *
 * ATOMIC BECAUSE THE TWO-STEP VERSION HAD A CREATION WINDOW (Codex P2, round 5
 * on PR #1207). Reading the roster and then writing the Event document left a
 * gap in which a Player could create their row: the marker still landed, every
 * later sweep answered `already-sent`, and that participant was never examined
 * or mailed. `firestore.rules` permits `players/{uid}` creation until archival,
 * so the window was reachable rather than theoretical — narrow, but the loss is
 * silent and permanent, which is the combination worth paying a transaction for.
 *
 * The read is the players COLLECTION, so Firestore serializes this write against
 * any creation in it: a row added during the transaction aborts and retries, and
 * the retry sees it.
 *
 * WHAT IT COMPARES, and why each half matters:
 *
 *   - the VISIBLE roster, filtered by the same ban list the send walked, because
 *     `readFinaleRoster` keeps banned rows by design and comparing raw against
 *     filtered counts every banned player as an arrival;
 *   - the uid SET rather than its size, because an admin deleting one Player
 *     while another joins leaves the count unchanged while an unexamined
 *     recipient has replaced an examined one;
 *   - the CARRIED ban list rather than a fresh one, because re-reading would
 *     make an unban read as an arrival and an Event that has ever banned anyone
 *     could have its marker deferred indefinitely by ordinary moderation.
 *
 * A MERGE, emphatically: a one-argument `set` replaces the document, which would
 * reduce the Event to `{ podiumEmailAt }`.
 *
 * Best-effort overall — a failure answers `false`, which withholds the marker and
 * costs one more sweep. Every recipient already carries `podiumEmailSentAt`, so
 * the retry mails nobody twice.
 */
async function verifyAndStampCompletion(
  db: DailyEmailFirestore & FinaleReadSource,
  eventId: string,
  examined: ReadonlySet<string>,
  bannedUids: readonly string[],
  deps: DailyEmailDeps,
): Promise<boolean> {
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection(`events/${eventId}/players`));
      const banned = new Set(bannedUids);
      const unexamined = snap.docs
        .map((d) => d.id || (d.data()?.uid as string | undefined) || '')
        .filter((uid) => uid !== '' && !banned.has(uid) && !examined.has(uid));
      if (unexamined.length > 0) return false;
      tx.set(
        db.doc(`events/${eventId}`),
        { podiumEmailAt: (deps.now ?? Date.now)() },
        { merge: true },
      );
      return true;
    });
  } catch (err) {
    console.error('verifyAndStampCompletion failed', eventId, err);
    return false;
  }
}

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
  db: DailyEmailFirestore & FinaleReadSource,
  eventId: string,
  input: PodiumEmailInput,
  deps: DailyEmailDeps = {},
): Promise<PodiumSendResult> {
  const result: PodiumSendResult = { sent: 0, skipped: 0, failed: 0, blocked: 0, drained: false };

  // The SAME Event-level opt-in the daily card reads: the ticket adds no new
  // category, so an Event that never turned the daily email on does not start
  // mailing at its finale either. `drained: true` — there is nothing owed, so
  // the beat should stop asking rather than retry forever.
  // Re-asserted here rather than trusted from the due check: this function is
  // also called directly (by tests, and by any future manual replay), and the
  // Event-level opt-in is the one condition that must hold at the send itself.
  //
  // NOT DRAINED, AND NOT STAMPED, because the toggle is REVERSIBLE. An owner who
  // turns the daily email on after the podium has posted should still get the
  // winner announcement, and a completion marker written while it was off would
  // silently make that impossible. The cost of leaving the question open is one
  // Event document read per sweep, which the active-Event selection already
  // bounds; the cost of closing it wrongly is the Event's last email, forever.
  if (!dailyEmailEnabled(input.event as Parameters<typeof dailyEmailEnabled>[0])) {
    return { ...result, reason: 'disabled' };
  }
  // THE FRESH READ, immediately before the first send (Codex P2, round 2 on PR
  // #1207). Everything above this line is preparation — the due check's Moment
  // and roster reads, the hostname resolution, the sender identity — and that is
  // exactly the elapsed time an archive landing mid-sweep gets to slip through:
  // the closed-Event guard ran against the snapshot the due check opened with,
  // and the spec says archival is TERMINAL for this send. Re-reading the one
  // document that carries it is what turns "this Event was open when the sweep
  // started" into "it is still open now". Mirrors `sendDailyEmailForEvent`'s own
  // pre-delivery re-read, for the same reason.
  const atDelivery = (await db.doc(`events/${eventId}`).get()).data() as
    | PodiumEmailEvent
    | undefined;
  if (eventClosedToPlay(atDelivery)) {
    // Not drained: the fan-out is genuinely unfinished. It will not be retried
    // either, because an archived Event is never due again — that residual is
    // the spec's, not this guard's, and stopping here is what it promises.
    return { ...result, reason: 'archived' };
  }
  // AND THE TOGGLE IS RE-APPLIED HERE TOO (Codex P2, round 3 on PR #1207). The
  // projected shape this read used to take could not even express `settings`, so
  // the fresh read closed the archive window and left the enablement one open —
  // an admin turning `settings.dailyEmailEnabled` off during the same
  // preparation was simply not seen, and the fan-out began anyway. It is the
  // documented sole control over whether anyone is mailed at all, so it gets the
  // same treatment as the archive state: read fresh, applied last.
  //
  // Not drained and not stamped, for the same reason the opening check is not:
  // the toggle is reversible, and a marker written while it is off would deny
  // the Event its last email permanently if the owner turned it back on.
  if (!dailyEmailEnabled(atDelivery as Parameters<typeof dailyEmailEnabled>[0])) {
    return { ...result, reason: 'disabled' };
  }
  // AND THE BAN ROSTER IS RE-COMPARED (Codex P2, round 4 on PR #1207). Every
  // ban-filtered thing this send carries — the recipient list, the podium
  // honours, the Most-Loved winner — was filtered against the roster the due
  // check read, and a ban landing during preparation would otherwise mail the
  // newly banned Player AND keep naming them in everybody else's copy, which is
  // exactly what the ban-filtered presentation contract forbids.
  //
  // ABORT RATHER THAN REBUILD: the snapshot is internally consistent and
  // rebuilding it here would mean re-deriving the honours, the ranking and the
  // award mid-function. Returning undrained sends this Event through the whole
  // due check again on the next sweep, which produces a correctly filtered
  // snapshot by construction, and every recipient already mailed is skipped by
  // their own marker.
  //
  // The residual matches the daily card's: a ban landing after delivery has
  // BEGUN still finishes the roster already in flight, because the check is per
  // send, not per recipient.
  if (bansDiffer(input.bannedUids ?? [], atDelivery?.bannedUids)) {
    console.log(`sendPodiumEmailForEvent ${eventId}: ban roster changed during preparation`);
    return { ...result, reason: 'bans-changed' };
  }

  if (input.ranked.length === 0) {
    // AN EMPTY ROSTER IS STILL A ROSTER THAT CAN GAIN A MEMBER (Codex P2, round
    // 3 on PR #1207). This fast path stamped completion directly and so skipped
    // the membership recount the normal path ends with — and `firestore.rules`
    // permits `players/{uid}` creation until archival, so a participant joining
    // between the due check's query and this line would have been locked out
    // permanently: every later sweep answers `already-sent`. The zero-recipient
    // case needs the same verification as every other, not less.
    const stamped = await verifyAndStampCompletion(
      db,
      eventId,
      new Set<string>(),
      input.bannedUids ?? [],
      deps,
    );
    return { ...result, drained: stamped, reason: 'no-roster' };
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
      // `null` here is NOT an opt-out — `ensureEmailPrefs` returns it when the
      // doc could not be read or minted, which is a Firestore failure and a
      // question still open. The opt-out and already-sent answers are
      // `shouldSendPodiumTo`'s, and those are permanent.
      if (prefs === null) {
        result.blocked++;
        continue;
      }
      if (!shouldSendPodiumTo(prefs)) {
        result.skipped++;
        continue;
      }
      const address = await resolveAddress(getEmailForUid, player.uid);
      if (address.status === 'error') {
        result.blocked++;
        continue;
      }
      if (address.status === 'none') {
        // Recorded durably, so the next sweep does not pay this Auth lookup
        // again — a long leading prefix of address-less Players could otherwise
        // consume a whole invocation and starve the deliverable tail behind it.
        await markPodiumEmailUndeliverable(db, eventId, player.uid, deps);
        result.skipped++;
        continue;
      }
      const to = address.email;
      const linkArgs = { baseUrl: unsubscribeBaseUrl, eventId, uid: player.uid, token: prefs.token };
      const unsubUrl = unsubscribeLink(linkArgs);
      const model = buildPodiumEmailModel({
        eventName,
        podium: input.podium,
        mostLoved: input.mostLoved ?? null,
        ranked: input.ranked,
        boardWasEmpty: input.boardWasEmpty,
        closingDay: input.closingDay,
        honorDayLabels: input.honorDayLabels,
        photoDayLabel: input.photoDayLabel,
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
        // A SWALLOWED marker failure is how a duplicate escapes (CodeRabbit,
        // round 2 on PR #1207): the send succeeded, so the recipient is mailed,
        // but without the marker a later sweep would mail them again — and
        // Resend's idempotency key only dedupes for 24 hours, so a retry after
        // that window would genuinely deliver twice. Counting it as blocked
        // keeps the Event undrained, which brings the retry forward to the next
        // quarter hour, well inside the window, where the key still collapses it.
        const marked = await markPodiumEmailSent(db, eventId, player.uid, deps);
        if (!marked) result.blocked++;
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

  // Drained means every recipient got a PERMANENT answer: mailed, or suppressed
  // for a reason no retry would change. A transport failure or a blocked
  // dependency leaves the question open, so the marker is withheld and the next
  // sweep resumes (Codex P1 on PR #1207).
  result.drained = !capHit && result.failed === 0 && result.blocked === 0;
  if (result.drained) {
    // THE ROSTER MAY HAVE GROWN WHILE THIS RAN (Codex P2, round 2 on PR #1207).
    // `firestore.rules` permits `players/{uid}` creation until archival and a
    // paced fan-out runs for minutes, so somebody joining after the due check's
    // roster read is absent from `input.ranked` — and stamping the marker on
    // that stale list would mean every later sweep skips the Event and they are
    // never mailed. Re-counting is one bounded read against a roster this run
    // has already paid to walk; a mismatch simply withholds the marker, and the
    // next sweep examines the new member while everybody else is skipped by
    // their own `podiumEmailSentAt`.
    const stamped = await verifyAndStampCompletion(
      db,
      eventId,
      new Set(input.ranked.map((p) => p.uid)),
      input.bannedUids ?? [],
      deps,
    );
    if (!stamped) {
      console.log(`sendPodiumEmailForEvent ${eventId}: roster changed mid-send, deferring the marker`);
      result.drained = false;
    }
  }
  console.log(
    `sendPodiumEmailForEvent ${eventId}: sent=${result.sent} skipped=${result.skipped} ` +
      `failed=${result.failed} blocked=${result.blocked} drained=${result.drained}`,
  );
  return result;
}

// --- Due check and the sweep ----------------------------------------------------

/** The Event fields the sweep reads. Raw Firestore view, like every other
 *  boundary in this package. */
interface PodiumEmailEvent {
  name?: unknown;
  days?: unknown;
  bannedUids?: unknown;
  standingsFreezeAt?: unknown;
  mostLovedPhoto?: unknown;
  /** The fan-out marker: present means this Event is finished (#1192). */
  podiumEmailAt?: unknown;
  /** The freeze stamp. Its PRESENCE is what says the Most-Loved award has been
   *  decided, because both are written by one transaction. */
  frozenAt?: unknown;
  settings?: { dailyEmailEnabled?: unknown } | undefined;
  /** Typed as the archive predicate reads them rather than as `unknown`, so the
   *  guard is called with the shape it declares instead of through a cast. A raw
   *  document can hold any value in either, which is exactly what
   *  `eventClosedToPlay` already defaults for. */
  status?: string;
  archiving?: boolean;
}

/** The stored `podium` Moment, at its deterministic id. `podium` is absent when
 *  the beat posted the Moment but its content build had failed. */
interface PodiumMomentDoc {
  kind?: unknown;
  dayIndex?: unknown;
  podium?: PodiumPayload;
}

export type PodiumDueReason =
  | 'no-event'
  | 'archived'
  | 'disabled'
  | 'already-sent'
  | 'no-podium'
  | 'no-payload'
  | 'not-frozen';

/**
 * Drop award winners whose live Proof no longer survives the Feed filter — the
 * documented "hidden later" rule (Codex P2, round 5 on PR #1207).
 *
 * `buildMostLovedPhotoAward`'s own contract says display "always re-joins the
 * LIVE Proof doc (`mostLovedDisplayWinners`, src/data/mostLoved.ts), so a
 * later-hidden photo can never render from a stale stored URL". The email is a
 * display surface and was not performing that join: a Proof deleted, hidden, or
 * pushed over the report threshold AFTER the freeze still had its frozen winner
 * entry, so the mail broadcast that Player's name and prompt to the whole roster
 * while the Feed and the in-app finale suppressed it.
 *
 * Mirrors `mostLovedDisplayWinners` plus the Feed filter its caller is required
 * to have applied — `status === 'active'`, not report-hidden (fail-open
 * threshold), owner not banned — because this package stays decoupled from the
 * app package exactly as `finaleContent.ts` does.
 *
 * READS IN AWARD ORDER AND STOPS AT THE FIRST SURVIVOR, so the common case costs
 * ONE document read rather than a hundred: only the hero is rendered, and the
 * order is the award's own.
 */
async function firstVisibleWinner(
  db: FinaleReadSource,
  eventId: string,
  winners: readonly MostLovedPhotoWinner[],
  bannedUids: ReadonlySet<string>,
  reportHideThreshold: number | undefined,
): Promise<{ winner: MostLovedPhotoWinner; index: number } | null> {
  for (let i = 0; i < winners.length; i++) {
    const winner = winners[i];
    try {
      const proof = (await db.doc(`events/${eventId}/proofs/${winner.proofId}`).get()).data() as
        | { type?: unknown; status?: unknown; reportCount?: unknown; createdAt?: unknown; uid?: unknown }
        | undefined;
      if (!proof) continue; // deleted after the freeze — display-only drop
      if (proof.createdAt !== winner.proofCreatedAt) continue; // another incarnation
      if (proof.type !== 'photo') continue; // defensive: the award only names photos
      if (proof.status !== 'active') continue; // hidden, pending or flagged
      const reports = typeof proof.reportCount === 'number' ? proof.reportCount : 0;
      if (
        typeof reportHideThreshold === 'number' &&
        reportHideThreshold > 0 &&
        reports >= reportHideThreshold
      ) {
        continue; // report-hidden since the freeze
      }
      if (typeof proof.uid === 'string' && bannedUids.has(proof.uid)) continue;
      return { winner, index: i };
    } catch (err) {
      // A read failure is not evidence the photo is fine. Skipping it renders a
      // shorter email; naming it could broadcast a suppressed Proof.
      console.error('firstVisibleWinner: proof read failed', eventId, winner.proofId, err);
      continue;
    }
  }
  return null;
}

/**
 * The frozen Most-Loved award, VALIDATED and ban-filtered, or `null`.
 *
 * VALIDATED because `EventDoc.mostLovedPhoto` arrives here as a raw Firestore
 * map and the content module indexes into it (CodeRabbit, round 2 on PR #1207):
 * an award missing `winners`, or carrying a winner without a string
 * `promptText`, threw inside `mostLovedLineFor` — and because the throw landed
 * in the per-recipient catch, it counted as a failure for EVERY recipient, so
 * the Event never drained and the sweep retried the same crash every quarter
 * hour. Nothing about this module may assume the document's shape.
 *
 * BAN-FILTERED for the same reason the podium honours are (Codex + CodeRabbit,
 * round 2): the stored award is the record and keeps the unfiltered truth, while
 * this email is a rendered view. A currently-banned winner is dropped, the next
 * visible co-winner becomes the hero, and an award with no visible winner left
 * renders no module at all. `heartCount` is the frozen count they tied at and is
 * preserved; `winnerCount` is reduced to what remains visible, so the "shared
 * with N others" tail counts only Players the reader could actually see.
 */
export function visibleMostLovedAward(
  raw: unknown,
  bannedUids: ReadonlySet<string>,
): VisibleMostLovedAward | null {
  if (!raw || typeof raw !== 'object') return null;
  const award = raw as Partial<MostLovedPhotoAward>;
  if (!Array.isArray(award.winners)) return null;
  if (typeof award.heartCount !== 'number' || !Number.isFinite(award.heartCount)) return null;
  const winners = award.winners.filter(
    (w): w is MostLovedPhotoWinner =>
      !!w &&
      typeof w === 'object' &&
      typeof (w as MostLovedPhotoWinner).uid === 'string' &&
      typeof (w as MostLovedPhotoWinner).displayName === 'string' &&
      typeof (w as MostLovedPhotoWinner).promptText === 'string' &&
      !bannedUids.has((w as MostLovedPhotoWinner).uid),
  );
  if (winners.length === 0) return null;
  // The retained prefix's length is the right fallback when `winnerCount` is
  // absent (records written before the bounded format), and the filtered count
  // must never exceed what survived the filter.
  const declared =
    typeof award.winnerCount === 'number' && Number.isFinite(award.winnerCount)
      ? award.winnerCount
      : award.winners.length;
  const removed = award.winners.length - winners.length;
  // A TRUNCATED TIE CANNOT BE COUNTED EXACTLY (Codex P2, rounds 3 and 4 on PR
  // #1207). `winners` is a bounded prefix — `MAX_PERSISTED_MOST_LOVED_WINNERS` —
  // while `winnerCount` deliberately preserves the FULL cardinality beyond it, so
  // a banned winner outside the prefix is invisible here and cannot be
  // subtracted. Reporting a number would then overstate the visible tie, naming
  // hidden Players by implication — the very thing the ban filter is for.
  //
  // ROUND 3'S VERSION OF THIS TEST WAS TOO WEAK: it asked whether a ban had been
  // found INSIDE the prefix (`removed > 0`), which is precisely the case that
  // does not need the guard. The unprovable case is a ban that lies only BEYOND
  // the prefix, where `removed` is zero. A truncated award simply cannot prove
  // its hidden remainder is ban-free, so the only honest test is whether any ban
  // roster is in play at all — with none, no filtering happened and the declared
  // count stands.
  const truncated = declared > award.winners.length;
  return {
    winners,
    winnerCount: Math.max(winners.length, declared - removed),
    winnerCountExact: !truncated || bannedUids.size === 0,
    heartCount: award.heartCount,
    frozenAt: typeof award.frozenAt === 'number' ? award.frozenAt : 0,
    computedAt: typeof award.computedAt === 'number' ? award.computedAt : 0,
  };
}

/** `events/{eventId}/moments/podium` — the one place this path is spelled. */
export function podiumMomentPath(eventId: string): string {
  return `events/${eventId}/moments/podium`;
}

/**
 * The closing Day's labels for the email's context line, and one label per Day
 * that pinned an honour.
 *
 * Formatted HERE rather than in the content module because the Day's stored
 * `date` is a plain wall-clock calendar date and `formatDayDate` owns the one
 * correct way to render it — see its own comment on the double-offset trap.
 */
function dayLabels(
  days: readonly EmailDay[],
  podiumDayIndex: number,
  honorDayIndexes: readonly number[],
): {
  closingDay: PodiumEmailInput['closingDay'];
  honorDayLabels: Record<number, string>;
  /** `dayIndex` → "Day 7 · 🇮🇹 Rome (Civitavecchia)", the shape the Most-Loved
   *  line dates its photo with. A different separator from the ⭐ line's, which
   *  reads "Day 2 in 🇭🇷 Split" — both are the frame's own wording. */
  photoDayLabels: Record<number, string>;
} {
  const raw = days.find((d) => d.index === podiumDayIndex);
  const honorDayLabels: Record<number, string> = {};
  for (const index of honorDayIndexes) {
    const day = days.find((d) => d.index === index);
    const where = day ? placeLabel(day) : '';
    // A Day with no Place yields "Day 2" alone rather than a dangling
    // preposition.
    honorDayLabels[index] = where ? `Day ${index + 1} in ${where}` : `Day ${index + 1}`;
  }
  const photoDayLabels: Record<number, string> = {};
  for (const day of days) {
    const where = placeLabel(day);
    photoDayLabels[day.index] = where
      ? `Day ${day.index + 1} · ${where}`
      : `Day ${day.index + 1}`;
  }
  return {
    photoDayLabels,
    closingDay: {
      themeId: raw?.theme ?? null,
      dayNumber: podiumDayIndex + 1,
      dayCount: days.length,
      dateLabel: raw ? formatDayDate(raw.date) : '',
      placeLabel: raw ? placeLabel(raw) : '',
    },
    honorDayLabels,
  };
}

/**
 * Assemble the send input for one Event from its stored state, or say why it is
 * not due.
 *
 * READS THE MOMENT FOR THE HONOURS AND THE ROSTER ONLY FOR THE RANKING. The
 * champion and the ⭐ come out of the Moment's own payload, so no amount of
 * post-freeze Player editing can make this email disagree with the Feed. The
 * roster supplies ranks 2 and 3 and the recipient list, ban-filtered and ranked
 * by `podiumStandings` — the same function whose head `buildPodiumPayload` took
 * its champion from.
 *
 * BAN-FILTERED FOR THE EMAIL, DELIBERATELY, even though the Moment's payload is
 * not (Codex P2 on PR #1207). `readFinaleRoster`'s own contract says ban
 * filtering "is applied only to the rendered view/copy, so reversible bans do
 * not permanently erase finale data" — the Moment is the record and keeps the
 * unfiltered truth; this email is a rendered view and must hide a banned row.
 * So a champion or ⭐ holder who is currently banned is dropped from the email's
 * honours rather than named in its subject while row 1 shows somebody else.
 */
export async function podiumEmailInputFor(
  db: DailyEmailFirestore & FinaleReadSource,
  eventId: string,
  /** The Event document the sweep already read, to save a second fetch of it. A
   *  caller with none (a test, a manual replay) omits it and this reads. */
  known?: PodiumEmailEvent,
  /** The recipient ceiling the send will apply, so the roster QUERY is bounded
   *  by the same number the loop is. Defaults to the module's own ceiling; the
   *  sweep passes whatever `deps.maxRecipients` configures, so the two halves
   *  cannot bound at different sizes. */
  maxRecipients?: number,
): Promise<{ due: true; input: PodiumEmailInput } | { due: false; reason: PodiumDueReason }> {
  const event =
    known ?? ((await db.doc(`events/${eventId}`).get()).data() as PodiumEmailEvent | undefined);
  if (!event) return { due: false, reason: 'no-event' };
  // Checked ahead of the toggle, because it is the stronger statement: the
  // occasion is over, whatever the settings say. This is also where an archived
  // Event stops being retried at all — the same posture the daily card takes,
  // and the reason the spec states archival as terminal for this send.
  if (eventClosedToPlay(event)) return { due: false, reason: 'archived' };
  if (!dailyEmailEnabled(event as Parameters<typeof dailyEmailEnabled>[0])) {
    return { due: false, reason: 'disabled' };
  }
  if (event.podiumEmailAt != null) return { due: false, reason: 'already-sent' };

  const moment = (await db.doc(podiumMomentPath(eventId)).get()).data() as
    | PodiumMomentDoc
    | undefined;
  // The Moment IS the due condition: no podium, no winner email. The finale beat
  // retries the Moment on its own guard until it lands, so "not yet" is a wait,
  // not a failure.
  if (!moment) return { due: false, reason: 'no-podium' };
  // THE FREEZE STAMP GATES THE AWARD, and the podium Moment does not (Codex P2,
  // round 5 on PR #1207). `runFinaleBeats` posts the Moment under its own guard,
  // independently of the freeze — that decoupling is deliberate (#228) — so a
  // run whose freeze transaction failed can leave a posted podium beside an
  // Event with NO `mostLovedPhoto` at all. The field's contract is explicit that
  // absence means "not yet computed", while `{ winners: [], heartCount: 0 }`
  // means "computed, no award": collapsing the two would let this sweep mail the
  // Event, stamp completion, and permanently omit an award the next unlock retry
  // was about to persist.
  //
  // `frozenAt` is the right gate rather than `mostLovedPhoto` itself, because
  // the award and the freeze stamp are written by ONE transaction. Waiting on
  // the award directly would hang forever on the defensive `freezeStandings`
  // path, which stamps the freeze for an Event that already had an award and
  // writes none; waiting on the freeze is bounded, because that beat retries
  // until it lands.
  if (event.frozenAt == null) return { due: false, reason: 'not-frozen' };
  const payload = moment.podium;
  // A Moment posted without its payload (the beat's content build failed) has
  // nothing for this email to print. The beat does not retry a landed Moment, so
  // this is terminal in practice — and silence is the right answer, which is why
  // it is a distinct reason rather than folded into `no-podium`.
  if (!payload || !Array.isArray(payload.dailyHonors)) return { due: false, reason: 'no-payload' };

  const days = (Array.isArray(event.days) ? event.days : []) as EmailDay[];
  const banned = (Array.isArray(event.bannedUids) ? event.bannedUids : []) as string[];
  // BOUNDED AT THE QUERY, ceiling plus one so overflow is detectable from the
  // raw page rather than from the ban-filtered roster — a banned row inside the
  // page must not hide the fact that valid participants beyond it were cut off.
  const cap = maxRecipients ?? DEFAULT_MAX_RECIPIENTS;
  const roster = await readFinaleRoster(db, eventId, cap + 1);
  if (roster.length > cap) {
    console.error(
      `podiumEmailInputFor: roster exceeds the ${cap} ceiling; the remainder will not be mailed`,
      eventId,
    );
  }
  const visible = visibleFinaleRoster(roster, banned);
  // THE RESOLVED FREEZE, not the configured field. `standingsFreezeAtFor` falls
  // back to the first ceremonial Day's `unlockAt` when `EventDoc.standingsFreezeAt`
  // is absent — which is every Event written before that field existed, including
  // both live ones — and the beat builds the Moment's payload with exactly that
  // resolved value. Reading the raw field here left the cutoff NULL for those
  // Events, so `podiumStandings` applied none: ranks 2 and 3 would have counted
  // post-freeze marks the Moment's own champion excludes, and the tie-break
  // instant would differ too, which reorders rows. That is a systematic
  // disagreement with the frozen record, not the documented per-Player-edit
  // residual.
  const freezeAt = standingsFreezeAtFor({
    standingsFreezeAt: typeof event.standingsFreezeAt === 'number' ? event.standingsFreezeAt : undefined,
    days,
  });
  const ranked = podiumStandings(visible, days, freezeAt);
  const bannedSet = new Set(banned);
  const filtered = visibleMostLovedAward(event.mostLovedPhoto, bannedSet);
  // The render-time visibility join, applied AFTER the ban filter so a banned
  // winner is never even looked up. The hero is the first winner whose live
  // Proof still survives the Feed filter; the rest of the award travels with it
  // so the tie tail keeps meaning what it meant.
  const hero = filtered
    ? await firstVisibleWinner(
        db,
        eventId,
        filtered.winners,
        bannedSet,
        typeof (event.settings as { reportHideThreshold?: unknown } | undefined)?.reportHideThreshold ===
          'number'
          ? ((event.settings as { reportHideThreshold?: number }).reportHideThreshold as number)
          : undefined,
      )
    : null;
  const award: VisibleMostLovedAward | null =
    filtered && hero
      ? {
          ...filtered,
          // The surviving hero leads, and the winners dropped BEFORE it are gone
          // from the tail count too — they are as invisible to this reader as a
          // banned one.
          winners: filtered.winners.slice(hero.index),
          winnerCount: Math.max(1, (filtered.winnerCount ?? filtered.winners.length) - hero.index),
        }
      : null;
  const { closingDay, honorDayLabels, photoDayLabels } = dayLabels(
    days,
    typeof moment.dayIndex === 'number' ? moment.dayIndex : Math.max(days.length - 1, 0),
    payload.dailyHonors.map((h) => h.dayIndex),
  );

  return {
    due: true,
    input: {
      event,
      // The Moment's honours, with a currently-banned holder withheld.
      podium: {
        champion:
          payload.champion && !bannedSet.has(payload.champion.uid) ? payload.champion : null,
        firstBingo:
          payload.firstBingo && !bannedSet.has(payload.firstBingo.uid) ? payload.firstBingo : null,
        dailyHonors: payload.dailyHonors.filter((h) => !bannedSet.has(h.uid)),
      },
      ranked,
      mostLoved: award,
      photoDayLabel:
        award?.winners[0]?.dayIndex != null
          ? photoDayLabels[award.winners[0].dayIndex as number]
          : undefined,
      // Read from the Moment BEFORE the honour filtering above, so a withheld
      // banned champion is never mistaken for a board nobody played.
      boardWasEmpty: payload.champion == null,
      bannedUids: banned,
      closingDay,
      honorDayLabels,
    },
  };
}

/**
 * One sweep across every active Event, mirroring `runDailyEmailSweep`: Event
 * work starts concurrently so a large or slow first Event cannot consume the
 * whole invocation, while every transport call still passes through ONE pacing
 * queue — concurrency is for fairness across Events, never a multiplier on the
 * send rate.
 *
 * THAT QUEUE IS PER-INVOCATION, NOT ACCOUNT-WIDE, and the earlier wording here
 * claimed otherwise (Codex P2, round 2 on PR #1207). `runDailyEmailSweep` owns a
 * separate in-memory queue, so a daily sweep and a podium sweep running at once
 * can each pace independently and together exceed Resend's account-wide rate;
 * so can two overlapping instances of either. The schedules are staggered seven
 * minutes apart to make the common case not overlap at all, and the residual is
 * written down in the spec. A shared durable limiter is the real fix and belongs
 * to both families rather than to this ticket.
 */
export async function runPodiumEmailSweep(
  db: DailyEmailFirestore & FinaleReadSource,
  deps: DailyEmailDeps = {},
): Promise<void> {
  // ACTUALLY FILTERED (Codex + CodeRabbit, round 2 on PR #1207). This comment
  // used to claim the selection excluded archived Events while the query applied
  // no filter at all, so every Event ever created was fetched 96 times a day and
  // then re-read inside the due check merely to be rejected — a cost that grows
  // with the lifetime Event count and never falls back.
  //
  // The filter is NOT the freeze check and not the marker check: the archive's
  // closing phase deliberately leaves `status` alone, and this query runs once
  // before any Event is processed, so `podiumEmailInputFor` still reads both off
  // the document itself. It just no longer reads the ones that can never qualify.
  const events = await db.collection('events').where('status', '==', 'active').get();
  const transport = deps.send ?? (await import('./email')).sendEmail;
  const pacingMs = deps.pacingMs ?? DEFAULT_PACING_MS;
  const sleep = deps.sleep ?? defaultSleep;
  let deliveryTail: Promise<void> = Promise.resolve();
  const pacedTransport: typeof transport = async (args) => {
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
        // The snapshot this sweep already holds, passed through rather than
        // re-fetched: the due check needed a second read of the same document
        // on every Event on every sweep.
        const due = await podiumEmailInputFor(
          db,
          ev.id,
          ev.data() as PodiumEmailEvent | undefined,
          deps.maxRecipients,
        );
        if (!due.due) return;
        await sendPodiumEmailForEvent(db, ev.id, due.input, {
          ...deps,
          send: pacedTransport,
          pacingMs: 0,
        });
      } catch (err) {
        console.error('runPodiumEmailSweep: event failed', ev.id, err);
      }
    }),
  );
}
