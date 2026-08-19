// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createAuditPage } from './audit';
import { initialRegistryState } from './state';
import type { RecoveryRecord } from './recovery';

function record(sequence: number): RecoveryRecord {
  return {
    sequence: String(sequence),
    action: 'acquire-lock',
    at: '2026-08-19T12:35:00.000Z',
    before: null,
    after: null,
    skippedRevisionRange: null,
    sourceAudit: {} as RecoveryRecord['sourceAudit'],
    evidence: {} as RecoveryRecord['evidence'],
    operatorSub: 'operator',
    incidentUrl: 'https://example.com/incidents/1',
    reason: 'test',
    containmentRemains: false,
  };
}

describe('point audit pagination', () => {
  it('exposes references, epoch ceilings, lock metadata and bounded history without payloads', () => {
    const state = {
      ...initialRegistryState(),
      recoverySequence: '102',
      highestAuthenticatedPublisherEpoch: '7',
    };
    const first = createAuditPage(state, Array.from({ length: 101 }, (_, index) => record(index + 1)), '0');
    expect(first.records).toHaveLength(100);
    expect(first.nextAfter).toBe('100');
    expect(first).toMatchObject({
      committed: null,
      highestAuthenticatedPublisherEpoch: '7',
      lookup: { kind: 'unknown-host' },
    });
    expect(JSON.stringify(first)).not.toContain('ledgerPayload');

    const last = createAuditPage(state, [record(101), record(102)], '100');
    expect(last.records.map((entry) => entry.sequence)).toEqual(['101', '102']);
    expect(last.nextAfter).toBeNull();
  });

  it.each(['-1', '01', 'not-a-number', '103'])('rejects malformed or unknown-ahead cursor %s', (cursor) => {
    const state = { ...initialRegistryState(), recoverySequence: '102' };
    expect(() => createAuditPage(state, [], cursor)).toThrow('audit cursor');
  });
});
