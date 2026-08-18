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
 * nobody. Reporting `notified: true` on the strength of membership alone would
 * put the sheet right back to telling somebody an admin was alerted when none
 * was, which is the failure the receipt exists to prevent. The Event document is
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
): Promise<{ reportId: string; notified: boolean }> {
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
      // Written only on an abuse report, so its presence means "this was
      // checked" rather than "this defaulted". The trigger requires it to be
      // strictly `true`, so a hand-written or migrated document that never went
      // through the check above cannot escalate.
      ...(report.kind === 'abuse' ? { reporterInEvent: escalation.member } : {}),
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
  // TELL THE REPORTER WHAT ACTUALLY HAPPENED (#670, Codex P2). The sheet cannot
  // know whether an abuse report will escalate — that depends on a membership
  // fact only the server holds — and a person reporting harm must not be left
  // believing an admin was alerted when the report only reached the inbox. So
  // the outcome is returned rather than promised up front.
  //
  // It discloses nothing a caller could not already establish by observation,
  // and the alternative (staying silent) is worse for exactly the person the
  // escalation exists to protect.
  // BOTH halves, because either one failing means no admin heard anything: the
  // reporter has to belong to the Event, and the Event has to be one the sweep
  // will visit. A prediction rather than a guarantee — the trigger re-checks
  // activeness at enqueue time — but it is the honest answer at this moment.
  return { reportId: reportRef.id, notified: escalation.member && escalation.eventActive };
}
