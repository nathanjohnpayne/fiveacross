import { FieldPath } from 'firebase-admin/firestore';
import { normalizeSubmittedAt } from './bug-reports-lib.mjs';

function sameValue(left, right) {
  if (left && typeof left.isEqual === 'function') return left.isEqual(right);
  return left === right;
}

/**
 * The production Firestore/Storage adapter for pending-report cleanup.
 * Dependencies stay injectable so tests exercise the exact destructive query
 * and compare-and-set implementation used by the CLI.
 */
export function createBugReportPruneStore({
  db,
  bucket,
  nowMs,
  documentIdField = FieldPath.documentId(),
}) {
  return {
    list: async (state, cursor, limit) => {
      let query = db.collection('bugReports').where('intakeState', '==', state).orderBy(documentIdField).limit(limit);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
    },
    claimPending: async (row, cleanupLeaseId, cleanupLeaseExpiresAt) => await db.runTransaction(async (transaction) => {
      const ref = db.doc(`bugReports/${row.id}`);
      const snapshot = await transaction.get(ref);
      const current = snapshot.data();
      if (
        current?.intakeState !== 'pending' ||
        current.requestHash !== row.requestHash ||
        current.leaseId !== row.leaseId ||
        !sameValue(current.intakeStartedAt, row.intakeStartedAt) ||
        !sameValue(current.leaseExpiresAt, row.leaseExpiresAt)
      ) return false;
      transaction.update(ref, {
        intakeState: 'deleting',
        cleanupLeaseId,
        cleanupLeaseExpiresAt: new Date(cleanupLeaseExpiresAt),
      });
      return true;
    }),
    claimDeleting: async (row, cleanupLeaseId, cleanupLeaseExpiresAt) => await db.runTransaction(async (transaction) => {
      const ref = db.doc(`bugReports/${row.id}`);
      const snapshot = await transaction.get(ref);
      const current = snapshot.data();
      const currentExpiry = normalizeSubmittedAt(current?.cleanupLeaseExpiresAt);
      if (
        current?.intakeState !== 'deleting' ||
        current.requestHash !== row.requestHash ||
        current.cleanupLeaseId !== row.cleanupLeaseId ||
        !sameValue(current.intakeStartedAt, row.intakeStartedAt) ||
        !sameValue(current.cleanupLeaseExpiresAt, row.cleanupLeaseExpiresAt) ||
        !currentExpiry || Date.parse(currentExpiry) > nowMs
      ) return false;
      transaction.update(ref, {
        cleanupLeaseId,
        cleanupLeaseExpiresAt: new Date(cleanupLeaseExpiresAt),
      });
      return true;
    }),
    deleteEvidence: async (storagePath) => {
      await bucket.file(storagePath).delete({ ignoreNotFound: true });
    },
    deleteIfOwned: async (row, cleanupLeaseId) => await db.runTransaction(async (transaction) => {
      const ref = db.doc(`bugReports/${row.id}`);
      const snapshot = await transaction.get(ref);
      const current = snapshot.data();
      if (
        current?.intakeState !== 'deleting' ||
        current.requestHash !== row.requestHash ||
        current.cleanupLeaseId !== cleanupLeaseId ||
        !sameValue(current.intakeStartedAt, row.intakeStartedAt)
      ) return false;
      transaction.delete(ref);
      return true;
    }),
  };
}
