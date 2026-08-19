/** What a report claims to be. `abuse` is the only value that earns an admin
 *  alert; everything else is inbox work (#670). */
export type BugReportKind = 'bug' | 'abuse';

export interface ValidClientReportFields {
  schemaVersion: 1;
  /** Normalised, never rejected: an absent or unknown value is a plain `bug`,
   *  so already-shipped clients that send no `kind` keep working unchanged. */
  kind: BugReportKind;
  description: string;
  captureError: string | null;
  route: string;
  eventId: string;
  appVersion: string;
  browser: string;
  viewport: { width: number; height: number };
  online: boolean;
}

export const REPORT_KINDS: readonly BugReportKind[];
export const SCREENSHOT_MAX_BYTES: number;
export function normalizeReportKind(input: unknown): BugReportKind;
export function validateClientReportFields(input: unknown): ValidClientReportFields;
export function validatePngBytes(input: Buffer): Buffer;
