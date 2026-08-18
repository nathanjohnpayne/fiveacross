import { createHash } from 'node:crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { BugReportInputError, nextRateState, validateBugReportInput, type RateState } from './bugReportCore';

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
