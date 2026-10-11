import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainRecoveryTelemetry, privateCacheRecoveryTelemetryKey, recordRecoveryOutcome, recoveryError, recoveryFailureCode,
} from './privateCacheRecoveryTelemetry';

const project = 'demo-recovery-telemetry';
const key = privateCacheRecoveryTelemetryKey(project);
const stored = () => JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('device recovery telemetry outbox (#1889)', () => {
  it('records identity-free outcomes with an ISO time', () => {
    recordRecoveryOutcome(project, { outcome: 'failed', path: 'verified', stage: 'clear', reason: 'failed-precondition' }, new Date('2026-10-11T04:00:00Z'));
    expect(stored()).toEqual([{ outcome: 'failed', path: 'verified', stage: 'clear', reason: 'failed-precondition', at: '2026-10-11T04:00:00.000Z' }]);
  });
  it('keeps only the newest ten records', () => {
    for (let i = 0; i < 12; i++) recordRecoveryOutcome(project, { outcome: 'failed', path: 'verified', reason: `r${i}` });
    const records = stored() as { reason: string }[];
    expect(records).toHaveLength(10);
    expect(records[0].reason).toBe('r2'); expect(records[9].reason).toBe('r11');
  });
  it('never throws when storage is unwritable or holds garbage', () => {
    localStorage.setItem(key, '{not json');
    recordRecoveryOutcome(project, { outcome: 'completed', path: 'unverified' });
    expect(stored()).toHaveLength(1);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => recordRecoveryOutcome(project, { outcome: 'completed', path: 'verified' })).not.toThrow();
  });
  it('emits failed and completed events and removes acknowledged records', () => {
    recordRecoveryOutcome(project, { outcome: 'failed', path: 'verified', stage: 'auth', reason: 'recovery/signed-out-or-offline' }, new Date('2026-10-11T04:00:00Z'));
    recordRecoveryOutcome(project, { outcome: 'completed', path: 'unverified' }, new Date('2026-10-11T04:01:00Z'));
    const capture = vi.fn(() => true);
    drainRecoveryTelemetry(project, capture);
    expect(capture.mock.calls).toEqual([
      ['device_recovery_failed', { path: 'verified', stage: 'auth', reason: 'recovery/signed-out-or-offline', observed_at: '2026-10-11T04:00:00.000Z' }],
      ['device_recovery_completed', { path: 'unverified', observed_at: '2026-10-11T04:01:00.000Z' }],
    ]);
    expect(localStorage.getItem(key)).toBeNull();
  });
  it('keeps records the sink did not acknowledge for a later ready signal', () => {
    recordRecoveryOutcome(project, { outcome: 'failed', path: 'verified', reason: 'a' });
    recordRecoveryOutcome(project, { outcome: 'failed', path: 'verified', reason: 'b' });
    drainRecoveryTelemetry(project, (_name, properties) => properties.reason === 'a');
    expect((stored() as { reason: string }[]).map(record => record.reason)).toEqual(['b']);
  });
  it('does nothing without records', () => {
    const capture = vi.fn(() => true);
    drainRecoveryTelemetry(project, capture);
    expect(capture).not.toHaveBeenCalled();
  });
  it('reports codes, never messages', () => {
    expect(recoveryFailureCode(recoveryError('timeout', 'Recovery timed out; reload before retrying.'))).toBe('recovery/timeout');
    expect(recoveryFailureCode(Object.assign(new Error('x'), { code: 'failed-precondition' }))).toBe('failed-precondition');
    expect(recoveryFailureCode(new DOMException('quota', 'QuotaExceededError'))).toBe('dom/QuotaExceededError');
    expect(recoveryFailureCode(new Error('alice@example.com was refused'))).toBe('unknown');
    expect(recoveryFailureCode(Object.assign(new Error('x'), { code: 'has spaces and a secret' }))).toBe('unknown');
    expect(recoveryFailureCode(undefined)).toBe('unknown');
  });
});
