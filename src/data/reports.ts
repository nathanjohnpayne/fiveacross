import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../firebase';

/** Existing player report cadence, now also enforced by the rules' server clock. */
export const REPORT_RATE_LIMIT_MS = 3_000;

/** Atomically bind one report to this target's live incarnation and reporter. */
export async function reportContent(kind: 'items' | 'proofs', id: string, eventId: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in to report content.');
  const target = doc(db, 'events', eventId, kind, id);
  const receipt = doc(db, 'events', eventId, kind, id, 'reports', uid);
  const rate = doc(db, 'events', eventId, 'reportRateLimits', uid);
  let acceptedTargetReadDenied = false;
  try {
    await runTransaction(db, async (tx) => {
      const receiptSnap = await tx.get(receipt);
      acceptedTargetReadDenied = false;
      const targetSnap = await tx.get(target).catch((error: unknown) => {
        acceptedTargetReadDenied = receiptSnap.exists() &&
          (error as { code?: unknown } | null)?.code === 'permission-denied';
        throw error;
      });
      if (!targetSnap.exists()) throw new Error('This content is no longer available.');
      const data = targetSnap.data();
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
  } catch (error) {
    // An accepted report can auto-hide its target before this retry reads it.
    // The caller's private receipt is enough to acknowledge that harmless
    // retry; service failures and first submissions still fail normally.
    if (acceptedTargetReadDenied) return;
    throw error;
  }
}
