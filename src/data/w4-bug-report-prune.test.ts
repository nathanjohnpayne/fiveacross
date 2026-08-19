// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { prunePendingBugReports } from '../../scripts/bug-report-prune-lib.mjs';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse('2026-08-19T00:00:00Z');
type PruneRow = { id: string; intakeState: string; [key: string]: unknown };
const reportId = (value: number) => value.toString(16).padStart(64, '0');

function pending(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    intakeState: 'pending',
    intakeStartedAt: NOW - 90 * DAY,
    submissionId: `submit_${id.slice(-8)}`,
    reporterHash: '0123456789abcdefabcd',
    requestHashVersion: 1,
    requestHash: 'a'.repeat(64),
    leaseId: `intake-${id}`,
    leaseExpiresAt: NOW - 1,
    ...over,
  };
}

class PruneStore {
  readonly docs = new Map<string, PruneRow>();
  readonly pages: Array<{ state: string; cursor: string | null; limit: number }> = [];
  readonly deletedEvidence: string[] = [];
  failEvidenceFor: string | null = null;
  raceOn: string | null = null;

  constructor(rows: PruneRow[]) {
    for (const row of rows) this.docs.set(row.id as string, row);
  }

  async list(state: 'pending' | 'deleting', cursor: string | null, limit: number) {
    this.pages.push({ state, cursor, limit });
    const rows = [...this.docs.values()]
      .filter((row) => row.intakeState === state && (cursor === null || (row.id as string) > cursor))
      .sort((a, b) => (a.id as string).localeCompare(b.id as string))
      .slice(0, limit);
    return rows;
  }

  async claimPending(row: PruneRow, cleanupLeaseId: string, cleanupLeaseExpiresAt: number) {
    if (this.raceOn === row.id) return false;
    const current = this.docs.get(row.id as string);
    if (current !== row) return false;
    this.docs.set(row.id as string, { ...row, intakeState: 'deleting', cleanupLeaseId, cleanupLeaseExpiresAt });
    return true;
  }

  async claimDeleting(row: PruneRow, cleanupLeaseId: string, cleanupLeaseExpiresAt: number) {
    const current = this.docs.get(row.id as string);
    if (current !== row) return false;
    this.docs.set(row.id as string, { ...row, cleanupLeaseId, cleanupLeaseExpiresAt });
    return true;
  }

  async deleteEvidence(path: string) {
    if (path.includes(this.failEvidenceFor ?? '\0')) throw new Error('storage unavailable');
    this.deletedEvidence.push(path);
  }

  async deleteIfOwned(row: PruneRow, cleanupLeaseId: string) {
    const current = this.docs.get(row.id as string);
    if (current?.cleanupLeaseId !== cleanupLeaseId) return false;
    this.docs.delete(row.id as string);
    return true;
  }
}

describe('pending bug-report retention', () => {
  it('pages pending and deleting independently, resumes prior work, and deletes evidence safely', async () => {
    const store = new PruneStore([
      pending(reportId(1)),
      pending(reportId(2), { leaseExpiresAt: NOW }),
      pending(reportId(3), { leaseExpiresAt: NOW + 1 }),
      pending(reportId(4), { intakeStartedAt: NOW - 90 * DAY + 1 }),
      { ...pending(reportId(5)), intakeState: 'deleting', cleanupLeaseId: 'old-cleaner', cleanupLeaseExpiresAt: NOW },
      { ...pending(reportId(6)), intakeState: 'deleting', cleanupLeaseId: 'other-cleaner', cleanupLeaseExpiresAt: NOW + 1 },
    ]);
    const summary = await prunePendingBugReports({
      store,
      nowMs: NOW,
      apply: true,
      pageSize: 2,
      randomUUID: vi.fn(() => 'cleanup-invocation'),
    });
    expect(summary).toMatchObject({ eligible: 3, claimed: 2, resumed: 1, deleted: 3, skippedRace: 0, failed: [] });
    expect(store.docs.has(reportId(1))).toBe(false);
    expect(store.docs.has(reportId(2))).toBe(false);
    expect(store.docs.has(reportId(5))).toBe(false);
    expect(store.docs.has(reportId(3))).toBe(true);
    expect(store.docs.has(reportId(4))).toBe(true);
    expect(store.docs.has(reportId(6))).toBe(true);
    expect(store.pages.filter((page) => page.state === 'pending').length).toBeGreaterThan(1);
    expect(store.pages.filter((page) => page.state === 'deleting').length).toBeGreaterThan(1);
    expect(store.deletedEvidence).toContain(`bug-reports/0123456789abcdefabcd/${reportId(5)}/screenshot.png`);
  });

  it('is dry-run by default and reports a compare-and-set race without deleting', async () => {
    const dryStore = new PruneStore([pending(reportId(1))]);
    const dry = await prunePendingBugReports({ store: dryStore, nowMs: NOW, randomUUID: () => 'dry' });
    expect(dry).toMatchObject({ eligible: 1, claimed: 0, deleted: 0, failed: [] });
    expect(dryStore.docs.get(reportId(1))?.intakeState).toBe('pending');

    const raceStore = new PruneStore([pending(reportId(2))]);
    raceStore.raceOn = reportId(2);
    const race = await prunePendingBugReports({
      store: raceStore,
      nowMs: NOW,
      apply: true,
      randomUUID: () => 'race',
    });
    expect(race.skippedRace).toBe(1);
    expect(race.deleted).toBe(0);
  });

  it('retains a deleting row and reports its id when evidence deletion fails', async () => {
    const store = new PruneStore([
      { ...pending(reportId(1)), intakeState: 'deleting', cleanupLeaseId: 'old', cleanupLeaseExpiresAt: NOW - 1 },
    ]);
    store.failEvidenceFor = reportId(1);
    const summary = await prunePendingBugReports({
      store,
      nowMs: NOW,
      apply: true,
      randomUUID: () => 'cleanup',
    });
    expect(summary.deleted).toBe(0);
    expect(summary.failed).toEqual([{ id: reportId(1), error: 'storage unavailable' }]);
    expect(store.docs.get(reportId(1))?.intakeState).toBe('deleting');
  });

  it('gives one of two concurrent cleaners the expired deleting row', async () => {
    const id = reportId(7);
    const store = new PruneStore([
      { ...pending(id), intakeState: 'deleting', cleanupLeaseId: 'expired', cleanupLeaseExpiresAt: NOW },
    ]);
    const [first, second] = await Promise.all([
      prunePendingBugReports({ store, nowMs: NOW, apply: true, randomUUID: () => 'cleaner-a' }),
      prunePendingBugReports({ store, nowMs: NOW, apply: true, randomUUID: () => 'cleaner-b' }),
    ]);
    expect(first.deleted + second.deleted).toBe(1);
    expect(first.resumed + second.resumed).toBe(1);
    expect(first.skippedRace + second.skippedRace).toBe(1);
    expect(store.deletedEvidence).toEqual([`bug-reports/0123456789abcdefabcd/${id}/screenshot.png`]);
  });
});
