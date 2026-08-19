import contract from './bugReportContract.cjs';
import type { BugReportKind } from './bugReportContract.cjs';

const { validateClientReportFields, validatePngBytes } = contract;

export type { BugReportKind };
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 3;

export class BugReportInputError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'resource-exhausted',
    message: string,
  ) {
    super(message);
  }
}

export interface ValidBugReport {
  schemaVersion: 1;
  submissionId: string | null;
  /** `bug` unless the reporter marked this abuse. Normalised by the shared
   *  contract, so an absent or unknown value arrives here as `bug` (#670). */
  kind: BugReportKind;
  description: string;
  screenshot: Buffer | null;
  captureError: string | null;
  route: string;
  eventId: string;
  appVersion: string;
  browser: string;
  viewport: { width: number; height: number };
  online: boolean;
}

export interface RateState {
  submissionMs: number[];
}

function screenshotFrom(value: unknown): Buffer | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new BugReportInputError('invalid-argument', 'Screenshot must be a PNG data URL.');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new BugReportInputError('invalid-argument', 'Screenshot must be a PNG data URL.');
  const screenshot = Buffer.from(match[1], 'base64');
  try {
    return validatePngBytes(screenshot);
  } catch (error) {
    throw new BugReportInputError('invalid-argument', error instanceof Error ? error.message : 'Screenshot is invalid.');
  }
}

export function validateBugReportInput(value: unknown): ValidBugReport {
  try {
    const fields = validateClientReportFields(value);
    return { ...fields, screenshot: screenshotFrom((value as Record<string, unknown>).screenshotDataUrl) };
  } catch (error) {
    if (error instanceof BugReportInputError) throw error;
    throw new BugReportInputError('invalid-argument', error instanceof Error ? error.message : 'Report payload is invalid.');
  }
}

export function nextRateState(previous: RateState | undefined, nowMs: number): RateState {
  const cutoff = nowMs - RATE_WINDOW_MS;
  const recent = (previous?.submissionMs ?? []).filter((timestamp) => Number.isFinite(timestamp) && timestamp > cutoff);
  if (recent.length >= RATE_MAX) throw new BugReportInputError('resource-exhausted', 'Too many bug reports. Try again later.');
  return { submissionMs: [...recent, nowMs] };
}
