import type { BugReportPruneStore, PruneRow } from './bug-report-prune-lib.mjs';

export interface PruneFirestore {
  collection(path: string): PruneQuery;
  doc(path: string): object;
  runTransaction(work: (transaction: PruneTransaction) => Promise<unknown>): Promise<unknown>;
}

export interface PruneQuery {
  where(field: string, operator: '==', value: string): PruneQuery;
  orderBy(field: unknown): PruneQuery;
  limit(value: number): PruneQuery;
  startAfter(cursor: string): PruneQuery;
  get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }>;
}

export interface PruneTransaction {
  get(ref: object): Promise<{ data(): Record<string, unknown> | undefined }>;
  update(ref: object, data: Record<string, unknown>): unknown;
  delete(ref: object): unknown;
}

export interface PruneBucket {
  file(path: string): { delete(options: { ignoreNotFound: boolean }): Promise<unknown> };
}

export function createBugReportPruneStore(args: {
  db: PruneFirestore;
  bucket: PruneBucket;
  nowMs: number;
  documentIdField?: unknown;
}): BugReportPruneStore;

export type { PruneRow };
