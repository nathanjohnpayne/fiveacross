// Device recovery outcomes for PostHog (#1886). The recovery document starts no
// analytics (specs/private-cache-isolation.md), so it leaves bounded,
// identity-free records here. The application graph emits them through its own
// consent-aware PostHog client once that client is capture-ready.
const TELEMETRY_VERSION = 'device-recovery-telemetry-v1';
const MAX_RECORDS = 10;

export type RecoveryPath = 'verified' | 'unverified';
export type RecoveryStage = 'auth' | 'open' | 'server' | 'drain' | 'terminate' | 'clear' | 'record';
export interface RecoveryOutcome {
  outcome: 'failed' | 'completed';
  path: RecoveryPath;
  /** Failed outcomes only: the stage that was running and its error code. */
  stage?: RecoveryStage;
  reason?: string;
  /** ISO time the recovery document observed the outcome. */
  at: string;
}

export const privateCacheRecoveryTelemetryKey = (projectId: string) => `fiveacross:${projectId}:${TELEMETRY_VERSION}`;

const RECOVERY_CODE_PREFIX = 'recovery/';

/** A recovery-owned error: its message is shown, its code is reported. */
export function recoveryError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code: `${RECOVERY_CODE_PREFIX}${code}` });
}

export function isRecoveryErrorCode(code: unknown): code is string {
  return typeof code === 'string' && code.startsWith(RECOVERY_CODE_PREFIX);
}

/** A stable, PII-free reason code: never an error message. */
export function recoveryFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z0-9/_-]{1,64}$/i.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && typeof name === 'string') return `dom/${name}`;
  return 'unknown';
}

function isOutcome(value: unknown): value is RecoveryOutcome {
  const record = value as Partial<RecoveryOutcome> | null;
  return !!record && (record.outcome === 'failed' || record.outcome === 'completed')
    && (record.path === 'verified' || record.path === 'unverified') && typeof record.at === 'string';
}

function read(key: string): RecoveryOutcome[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isOutcome) : [];
  } catch { return []; }
}

/** Best effort: telemetry storage failure never affects recovery. */
export function recordRecoveryOutcome(projectId: string, outcome: Omit<RecoveryOutcome, 'at'>, now = new Date()): void {
  try {
    const key = privateCacheRecoveryTelemetryKey(projectId);
    // Keep the newest records: the latest attempts explain the current state.
    const records = [...read(key), { ...outcome, at: now.toISOString() }].slice(-MAX_RECORDS);
    localStorage.setItem(key, JSON.stringify(records));
  } catch { /* unwritable storage loses the record, never the recovery */ }
}

/**
 * Emits each stored outcome and keeps only those the sink did not acknowledge,
 * so a capture that is not yet safe stays for the next ready signal.
 */
export function drainRecoveryTelemetry(
  projectId: string,
  capture: (name: string, properties: Record<string, unknown>) => boolean,
): void {
  try {
    const key = privateCacheRecoveryTelemetryKey(projectId);
    const records = read(key);
    if (records.length === 0) return;
    const unsent = records.filter(record => !capture(
      record.outcome === 'failed' ? 'device_recovery_failed' : 'device_recovery_completed',
      {
        path: record.path,
        ...(record.stage ? { stage: record.stage } : {}),
        ...(record.reason ? { reason: record.reason } : {}),
        observed_at: record.at,
      },
    ));
    if (unsent.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(unsent));
  } catch { /* storage or sink failure leaves the records for a later load */ }
}
