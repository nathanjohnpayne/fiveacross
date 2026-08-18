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

/**
 * Is this reporter actually part of the Event they are reporting against?
 *
 * WHY THIS EXISTS AT ALL (#670, Codex P2). `eventId` is CLIENT-SUPPLIED. That
 * was harmless while it was only a label on an inbox row, but an abuse report
 * mails the named Event's admins — so the field stopped being a label and became
 * a DELIVERY ADDRESS. Nothing else in the flow stops a signed-in player naming
 * somebody else's Event and routing arbitrary text into its digest; the rate
 * limit caps the volume and does nothing about the direction.
 *
 * A player document is the membership record (`events/{eventId}/players/{uid}`
 * is written when they join). An Event ADMIN who never dealt a board has no such
 * document but is plainly authorized, so the roster is the second chance — and
 * only the second, because it costs a whole Event read that the common case
 * should not pay.
 *
 * FAILS CLOSED. An unreadable answer is not membership: the wrong direction here
 * is mailing an Event's admins on the say-so of somebody who has no relationship
 * with it.
 */
export async function reporterBelongsToEvent(
  db: ReporterLookupFirestore,
  eventId: string,
  uid: string,
): Promise<boolean> {
  try {
    const player = await db.doc(`events/${eventId}/players/${uid}`).get();
    if (player.exists ?? player.data() !== undefined) return true;
    const admins = (await db.doc(`events/${eventId}`).get()).data()?.admins;
    return Array.isArray(admins) && admins.includes(uid);
  } catch (error) {
    console.error('submitBugReport: participation check failed', eventId, error);
    return false;
  }
}

export async function handleSubmitBugReport(
  request: CallableRequest<unknown>,
  requireAppCheck: boolean,
): Promise<{ reportId: string }> {
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
  const reporterInEvent =
    report.kind === 'abuse' ? await reporterBelongsToEvent(db, report.eventId, uid) : false;

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
      ...(report.kind === 'abuse' ? { reporterInEvent } : {}),
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
  return { reportId: reportRef.id };
}
