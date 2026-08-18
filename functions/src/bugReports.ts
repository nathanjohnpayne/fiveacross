import { createHash } from 'node:crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { BugReportInputError, nextRateState, validateBugReportInput, type RateState } from './bugReportCore';

/** The minimal Firestore surface the participation check needs, so it can be
 *  exercised without an Admin SDK. */
export interface ReporterLookupFirestore {
  doc(path: string): { get(): Promise<{ exists?: boolean; data(): Record<string, unknown> | undefined }> };
}

/** Both halves of the question "will this abuse report actually reach an admin?".
 *  They are separate fields because they are persisted and reported differently:
 *  membership is stored for the trigger to gate on, while activeness is only a
 *  prediction the receipt uses — the trigger re-checks it at enqueue time. */
export interface AbuseEscalation {
  /** Does the reporter belong to the Event they named? Persisted as
   *  `reporterInEvent`, which `abuseAlertsForWrite` requires to be `true`. */
  member: boolean;
  /** Is the Event one the digest sweep will actually visit? */
  eventActive: boolean;
}

/**
 * Will this abuse report escalate — and if not, which half failed?
 *
 * WHY MEMBERSHIP IS CHECKED AT ALL (#670, Codex P2). `eventId` is
 * CLIENT-SUPPLIED. That was harmless while it was only a label on an inbox row,
 * but an abuse report mails the named Event's admins — so the field stopped
 * being a label and became a DELIVERY ADDRESS. Nothing else in the flow stops a
 * signed-in player naming somebody else's Event and routing arbitrary text into
 * its digest; the rate limit caps the volume and does nothing about the
 * direction. A player document is the membership record
 * (`events/{eventId}/players/{uid}` is written when they join); an Event ADMIN
 * who never dealt a board has no such document but is plainly authorized, so the
 * roster answers first and saves the second read when it does.
 *
 * WHY ACTIVENESS IS CHECKED HERE TOO (Codex P2, round 5). `recordBugReportAlerts`
 * refuses to enqueue against a non-active Event, matching the sweep's own
 * precondition — so a member reporting against an ARCHIVED Event escalates to
 * nobody. Reporting success on the strength of membership alone would put the
 * sheet right back to telling somebody their report reached the admins when it
 * did not, which is the failure the receipt exists to prevent. The Event document is
 * read either way, so this costs nothing.
 *
 * It stays a PREDICTION rather than a guarantee: the Event could be archived
 * between this read and the trigger, and the trigger — not this — is the
 * authority on what was queued. It is the best answer available at the moment
 * the reporter is looking at the screen.
 *
 * FAILS CLOSED on both halves. An unreadable answer is not membership: the wrong
 * direction is mailing an Event's admins on the say-so of somebody who has no
 * relationship with it, and claiming a delivery that did not happen.
 */
export async function resolveAbuseEscalation(
  db: ReporterLookupFirestore,
  eventId: string,
  uid: string,
): Promise<AbuseEscalation> {
  try {
    const event = (await db.doc(`events/${eventId}`).get()).data();
    const eventActive = event?.status === 'active';
    const admins = event?.admins;
    if (Array.isArray(admins) && admins.includes(uid)) return { member: true, eventActive };
    const player = await db.doc(`events/${eventId}/players/${uid}`).get();
    return { member: player.exists ?? player.data() !== undefined, eventActive };
  } catch (error) {
    console.error('submitBugReport: escalation check failed', eventId, error);
    return { member: false, eventActive: false };
  }
}

export async function handleSubmitBugReport(
  request: CallableRequest<unknown>,
  requireAppCheck: boolean,
): Promise<{ reportId: string; escalated: boolean }> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before reporting a bug.');
  if (requireAppCheck && !request.app) throw new HttpsError('failed-precondition', 'App Check is required.');
  const nowMs = Date.now();
  const db = getFirestore();
  const uidHash = createHash('sha256').update(uid).digest('hex').slice(0, 20);
  const rateRef = db.doc(`bugReportRateLimits/${uidHash}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(rateRef);
    const current = snapshot.exists ? (snapshot.data() as RateState) : undefined;
    try {
      transaction.set(rateRef, nextRateState(current, nowMs));
    } catch (error) {
      if (error instanceof BugReportInputError) throw new HttpsError(error.code, error.message);
      throw error;
    }
  });

  let report: ReturnType<typeof validateBugReportInput>;
  try {
    report = validateBugReportInput(request.data);
  } catch (error) {
    if (error instanceof BugReportInputError) throw new HttpsError(error.code, error.message);
    throw error;
  }

  // Only an abuse report pays for this, because only an abuse report escalates —
  // and it never rejects the SUBMISSION. A report filed from the sign-in or join
  // screen, by someone who has not joined the Event yet, still lands in the
  // inbox exactly as it always did; this declines to ESCALATE it, which is the
  // only thing the claimed Event buys the reporter.
  //
  // Resolved HERE and persisted rather than checked at the trigger, because the
  // trigger only ever sees `reporterHash` — a truncated SHA-256 that is
  // deliberately not resolvable back to a uid. This is the one point in the flow
  // holding both facts at once.
  const escalation: AbuseEscalation =
    report.kind === 'abuse'
      ? await resolveAbuseEscalation(db, report.eventId, uid)
      : { member: false, eventActive: false };

  const reportRef = db.collection('bugReports').doc();
  const storagePath = report.screenshot
    ? `bug-reports/${uidHash}/${reportRef.id}/screenshot.png`
    : null;
  const file = storagePath ? getStorage().bucket().file(storagePath) : null;
  if (file && report.screenshot) {
    await file.save(report.screenshot, {
      resumable: false,
      validation: 'crc32c',
      metadata: { contentType: 'image/png', cacheControl: 'private, max-age=0, no-store' },
    });
  }
  try {
    await reportRef.create({
      schemaVersion: report.schemaVersion,
      // Server-normalised, never the raw client value: `bugReports` is denied to
      // clients in both directions, so this document is the ONLY place the
      // reporter's abuse marking exists — and it is what the `notifyAbuseBugReport`
      // trigger reads to decide whether an admin hears about it (#670).
      kind: report.kind,
      // Both written only on an abuse report, so their presence means "this was
      // checked" rather than "this defaulted", and they answer DIFFERENT
      // questions — which is the whole reason there are two of them (#670,
      // Codex P2 round 6):
      //
      //   `reporterInEvent` is the trigger's GATE INPUT. `abuseAlertsForWrite`
      //   requires it to be strictly `true`, so a hand-written or migrated
      //   document that never went through the check above cannot escalate. It
      //   is a necessary condition for escalation, not a sufficient one.
      //
      //   `escalatedAtIntake` is WHETHER THIS SUBMISSION WAS ELIGIBLE to reach
      //   the admin alert queue — membership AND a live Event, the same
      //   conjunction the callable returns to the reporter. Persisted because it
      //   is a durable fact about the submission rather than a stale snapshot of
      //   Event state: if somebody asks why a report never surfaced, this is the
      //   record of what the submission itself decided.
      //
      // NEITHER IS A DELIVERY CLAIM, and the naming is deliberate (#670, Codex
      // P2 round 7). Delivery is decided by a pipeline this callable does not
      // own: the trigger re-reads Event status at enqueue time, and the digest
      // can still resolve no admin recipient at all and leave the alert queued.
      // "Escalated" is what is knowable here — the report entered the path that
      // reaches admins — and nothing downstream can retroactively make it false.
      ...(report.kind === 'abuse'
        ? {
            reporterInEvent: escalation.member,
            escalatedAtIntake: escalation.member && escalation.eventActive,
          }
        : {}),
      description: report.description,
      screenshotPath: storagePath,
      captureError: report.captureError,
      route: report.route,
      eventId: report.eventId,
      appVersion: report.appVersion,
      browser: report.browser,
      viewport: report.viewport,
      online: report.online,
      reporterHash: uidHash,
      submittedAt: FieldValue.serverTimestamp(),
      status: 'new',
    });
  } catch (error) {
    if (file) await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    throw error;
  }
  // TELL THE REPORTER WHAT THIS SUBMISSION DID (#670, Codex P2). The sheet
  // cannot work it out alone — both halves are server-side facts — and a person
  // reporting harm must not be left believing the admins were reached when the
  // report only entered the inbox. So the outcome is returned rather than
  // promised up front.
  //
  // `escalated`, NOT `notified`, and that distinction is the whole point. This
  // function knows exactly one thing: whether the report entered the path that
  // reaches admins. It cannot know whether an admin was NOTIFIED — that needs
  // the trigger's own re-check and the digest resolving a recipient, and an
  // Event with no verified admin email and no `ADMIN_NOTIFY_EMAIL` override
  // leaves the alert queued and unsent. Claiming delivery here would be the same
  // over-promise a third time; claiming escalation is true when it is said and
  // stays true.
  //
  // It discloses nothing a caller could not already establish by observation,
  // and staying silent is worse for exactly the person this exists to protect.
  return { reportId: reportRef.id, escalated: escalation.member && escalation.eventActive };
}
