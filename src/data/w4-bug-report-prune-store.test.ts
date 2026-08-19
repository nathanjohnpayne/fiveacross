// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createBugReportPruneStore } from '../../scripts/bug-report-prune-store.mjs';

const NOW = Date.parse('2026-08-19T00:00:00Z');
const ID = 'a'.repeat(64);
const baseRow = {
  id: ID,
  intakeState: 'pending',
  intakeStartedAt: new Date(NOW - 1000),
  requestHash: 'b'.repeat(64),
  leaseId: 'intake-owner',
  leaseExpiresAt: new Date(NOW - 1),
};

function transactionalAdapter(current: Record<string, unknown> | undefined) {
  const ref = { path: `bugReports/${ID}` };
  const update = vi.fn();
  const remove = vi.fn();
  const transaction = {
    get: vi.fn(async () => ({ data: () => current })),
    update,
    delete: remove,
  };
  const db = {
    doc: vi.fn(() => ref),
    collection: vi.fn(),
    runTransaction: vi.fn(async (work: (value: typeof transaction) => Promise<unknown>) => await work(transaction)),
  };
  const deleteEvidence = vi.fn(async () => undefined);
  const bucket = { file: vi.fn(() => ({ delete: deleteEvidence })) };
  const store = createBugReportPruneStore({ db, bucket, nowMs: NOW, documentIdField: '__name__' });
  return { store, db, transaction, update, remove, bucket, deleteEvidence };
}

describe('production pending-report prune store', () => {
  it('uses the exact bounded state/document-id query and cursor', async () => {
    const docs = [{ id: ID, data: () => ({ intakeState: 'pending' }) }];
    const query = {
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      startAfter: vi.fn(),
      get: vi.fn(async () => ({ docs })),
    };
    for (const method of ['where', 'orderBy', 'limit', 'startAfter'] as const) {
      query[method].mockReturnValue(query);
    }
    const db = { collection: vi.fn(() => query), doc: vi.fn(), runTransaction: vi.fn() };
    const store = createBugReportPruneStore({
      db,
      bucket: { file: vi.fn() },
      nowMs: NOW,
      documentIdField: '__name__',
    });
    await expect(store.list('deleting', 'cursor-id', 37)).resolves.toEqual([
      { id: ID, intakeState: 'pending' },
    ]);
    expect(db.collection).toHaveBeenCalledWith('bugReports');
    expect(query.where).toHaveBeenCalledWith('intakeState', '==', 'deleting');
    expect(query.orderBy).toHaveBeenCalledWith('__name__');
    expect(query.limit).toHaveBeenCalledWith(37);
    expect(query.startAfter).toHaveBeenCalledWith('cursor-id');
  });

  it('claims PENDING only when every scanned intake tuple value still matches', async () => {
    const exact = transactionalAdapter(baseRow);
    await expect(exact.store.claimPending(baseRow, 'cleanup-owner', NOW + 600_000)).resolves.toBe(true);
    expect(exact.update).toHaveBeenCalledWith(expect.anything(), {
      intakeState: 'deleting',
      cleanupLeaseId: 'cleanup-owner',
      cleanupLeaseExpiresAt: new Date(NOW + 600_000),
    });

    const races = [
      { intakeState: 'complete' },
      { requestHash: 'c'.repeat(64) },
      { leaseId: 'takeover-owner' },
      { intakeStartedAt: new Date(NOW - 999) },
      { leaseExpiresAt: new Date(NOW) },
    ];
    for (const mutation of races) {
      const raced = transactionalAdapter({ ...baseRow, ...mutation });
      await expect(raced.store.claimPending(baseRow, 'cleanup-owner', NOW + 600_000)).resolves.toBe(false);
      expect(raced.update).not.toHaveBeenCalled();
    }
  });

  it('takes over DELETING only at an expired, unchanged cleanup lease', async () => {
    const deleting = {
      ...baseRow,
      intakeState: 'deleting',
      cleanupLeaseId: 'old-cleaner',
      cleanupLeaseExpiresAt: new Date(NOW),
    };
    const exact = transactionalAdapter(deleting);
    await expect(exact.store.claimDeleting(deleting, 'new-cleaner', NOW + 600_000)).resolves.toBe(true);
    expect(exact.update).toHaveBeenCalledWith(expect.anything(), {
      cleanupLeaseId: 'new-cleaner',
      cleanupLeaseExpiresAt: new Date(NOW + 600_000),
    });

    for (const mutation of [
      { intakeState: 'complete' },
      { requestHash: 'c'.repeat(64) },
      { cleanupLeaseId: 'other-cleaner' },
      { intakeStartedAt: new Date(NOW - 999) },
      { cleanupLeaseExpiresAt: new Date(NOW + 1) },
    ]) {
      const raced = transactionalAdapter({ ...deleting, ...mutation });
      await expect(raced.store.claimDeleting(deleting, 'new-cleaner', NOW + 600_000)).resolves.toBe(false);
      expect(raced.update).not.toHaveBeenCalled();
    }
  });

  it('deletes evidence idempotently and the row only under its exact owned lease', async () => {
    const deleting = {
      ...baseRow,
      intakeState: 'deleting',
      cleanupLeaseId: 'cleanup-owner',
      cleanupLeaseExpiresAt: new Date(NOW + 1),
    };
    const exact = transactionalAdapter(deleting);
    await exact.store.deleteEvidence(`bug-reports/hash/${ID}/screenshot.png`);
    expect(exact.bucket.file).toHaveBeenCalledWith(`bug-reports/hash/${ID}/screenshot.png`);
    expect(exact.deleteEvidence).toHaveBeenCalledWith({ ignoreNotFound: true });
    await expect(exact.store.deleteIfOwned(deleting, 'cleanup-owner')).resolves.toBe(true);
    expect(exact.remove).toHaveBeenCalledTimes(1);

    for (const mutation of [
      { intakeState: 'complete' },
      { requestHash: 'c'.repeat(64) },
      { cleanupLeaseId: 'new-owner' },
      { intakeStartedAt: new Date(NOW - 999) },
    ]) {
      const raced = transactionalAdapter({ ...deleting, ...mutation });
      await expect(raced.store.deleteIfOwned(deleting, 'cleanup-owner')).resolves.toBe(false);
      expect(raced.remove).not.toHaveBeenCalled();
    }
  });
});
