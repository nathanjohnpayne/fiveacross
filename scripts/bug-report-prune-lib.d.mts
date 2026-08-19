export interface PruneRow {
  id: string;
  intakeState: string;
  [key: string]: unknown;
}

export interface BugReportPruneStore {
  list(state: 'pending' | 'deleting', cursor: string | null, limit: number): Promise<PruneRow[]>;
  claimPending(row: PruneRow, cleanupLeaseId: string, cleanupLeaseExpiresAt: number): Promise<boolean>;
  claimDeleting(row: PruneRow, cleanupLeaseId: string, cleanupLeaseExpiresAt: number): Promise<boolean>;
  deleteEvidence(path: string): Promise<void>;
  deleteIfOwned(row: PruneRow, cleanupLeaseId: string): Promise<boolean>;
}

export interface BugReportPruneSummary {
  scanned: number;
  eligible: number;
  claimed: number;
  resumed: number;
  deleted: number;
  skippedRace: number;
  failed: Array<{ id: string; error: string }>;
}

export function prunePendingBugReports(args: {
  store: BugReportPruneStore;
  nowMs: number;
  apply?: boolean;
  pageSize?: number;
  randomUUID: () => string;
}): Promise<BugReportPruneSummary>;
