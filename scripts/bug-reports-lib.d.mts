export interface ExportReport {
  id: string;
  schemaVersion: number;
  description: string;
  screenshotPath: string | null;
  [key: string]: unknown;
}

export interface IntakeCoordinationReport {
  id: string;
  intakeState: string;
  [key: string]: unknown;
}

export interface ExportSummary {
  exported: string[];
  skipped: string[];
  failed: Array<{ id: string; error: string }>;
}

export function normalizeSubmittedAt(value: unknown): string | null;

export function exportReports(args: {
  reports: Array<ExportReport | IntakeCoordinationReport>;
  downloadScreenshot: (path: string) => Promise<Buffer>;
  root: string;
}): Promise<ExportSummary>;

export interface ImportReceipt {
  reportId: string;
  issue: number;
  url: string;
  importedAt: string;
}

export function archiveReport(args: {
  reportId: string;
  issueUrl: string;
  root: string;
  now?: Date;
}): Promise<ImportReceipt>;

export interface ReportDisposition {
  reportId: string;
  status: 'failed' | 'ambiguous';
  reason: string;
  retryable: true;
  recordedAt: string;
}

export function recordDisposition(args: {
  reportId: string;
  status: 'failed' | 'ambiguous';
  reason: string;
  root: string;
  now?: Date;
}): Promise<ReportDisposition>;
