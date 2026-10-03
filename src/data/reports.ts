import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../firebase';

/** Existing player report cadence, now also enforced by the rules' server clock. */
export const REPORT_RATE_LIMIT_MS = 3_000;

/**
 * Bind a report to the account displayed by its initiating control and this
 * target's live incarnation. No live-auth fallback may retarget old UI intent.
 * Recheck resumed attempts and acknowledgments; an already committed request
 * remains committed, so these checks do not promise server cancellation.
 */
export async function reportContent(kind: 'items' | 'proofs', id: string, eventId: string, expectedCreatedAt: number | undefined, expectedUid: string): Promise<void> {
  const assertReporterCurrent = () => {
    if (!expectedUid || auth.currentUser?.uid !== expectedUid) {
      throw new Error('Sign in as the reporting account before reporting content.');
    }
  };
  assertReporterCurrent();
  const uid = expectedUid;
  const target = doc(db, 'events', eventId, kind, id);
  const receipt = doc(db, 'events', eventId, kind, id, 'reports', uid);
  const rate = doc(db, 'events', eventId, 'reportRateLimits', uid);
  let acceptedTargetReadDenied = false;
  try {
    await runTransaction(db, async (tx) => {
      acceptedTargetReadDenied = false;
      assertReporterCurrent();
      const receiptSnap = await tx.get(receipt);
      assertReporterCurrent();
      const targetSnap = await tx.get(target).catch((error: unknown) => {
        acceptedTargetReadDenied = typeof expectedCreatedAt === 'number' && Number.isFinite(expectedCreatedAt)
          && receiptSnap.exists() && receiptSnap.data().targetCreatedAt === expectedCreatedAt &&
          (error as { code?: unknown } | null)?.code === 'permission-denied';
        throw error;
      });
      assertReporterCurrent();
      if (!targetSnap.exists()) throw new Error('This content is no longer available.');
      const data = targetSnap.data();
      if (expectedCreatedAt !== undefined && data.createdAt !== expectedCreatedAt) {
        throw new Error('This content has changed. Refresh before reporting.');
      }
      if (typeof data.createdAt !== 'number' || !Number.isFinite(data.createdAt) ||
          typeof data.reportCount !== 'number' || !Number.isSafeInteger(data.reportCount) || data.reportCount < 0) {
        throw new Error('This content cannot be reported.');
      }
      if (receiptSnap.exists() && receiptSnap.data().targetCreatedAt === data.createdAt) {
        return; // retry acknowledgement: never spends quota or increments twice
      }
      tx.set(receipt, { uid, targetCreatedAt: data.createdAt, submittedAt: serverTimestamp() });
      tx.set(rate, { kind, targetId: id, submittedAt: serverTimestamp() });
      tx.update(target, { reportCount: data.reportCount + 1 });
    });
    assertReporterCurrent();
  } catch (error) {
    assertReporterCurrent();
    // An accepted report can auto-hide its target before this retry reads it.
    // A receipt for the caller's observed incarnation acknowledges that retry;
    // a stale surviving receipt never acknowledges a recreated hidden target.
    if (acceptedTargetReadDenied) return;
    throw error;
  }
}
