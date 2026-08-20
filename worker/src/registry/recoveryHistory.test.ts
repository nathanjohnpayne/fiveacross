// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ConsumedProbeEvidence } from './probe';
import type { RecoveryRecord } from './recovery';
import { parseRecoveryHistoryEntry, recoveryHistoryKey } from './recoveryHistory';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const DIGEST = 'a'.repeat(64);

function record(): RecoveryRecord {
  const desired = {
    kind: 'route' as const,
    eventId: 'synthetic-event',
    status: 'disabled' as const,
    slug: 'r2-abcdefghijklmnopqrstuvwxyz',
    edition: 'fiveacross' as const,
    pathNamespace: null,
  };
  return {
    sequence: '1',
    action: 'apply',
    at: '2020-01-01T00:00:00.000Z',
    before: null,
    after: { revision: '1', digest: DIGEST },
    skippedRevisionRange: null,
    sourceAudit: {
      revision: '1',
      digest: DIGEST,
      observedAt: '2020-01-01T00:00:00.000Z',
      canonicalProjection: {
        sourceDocumentDigest: 'b'.repeat(64),
        host: HOST,
        desired,
      },
      ledgerPayload: {
        schemaVersion: 1,
        revision: '1',
        host: HOST,
        desired,
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
      ledgerDocumentDigest: 'c'.repeat(64),
      attestorSub: 'source-attestor',
      attestorKeyVersion: 'source-key/1',
      attestorKeyFingerprint: 'd'.repeat(64),
      attestationIssuedAt: '2020-01-01T00:00:00.000Z',
      attestationSignature: 'signed-source-audit',
    },
    evidence: { kind: 'apply', lockId: 'lock-1', publisherReplacement: null },
    probeEvidence: [],
    operatorSub: 'recovery-operator',
    operatorKeyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/recovery/cryptoKeyVersions/1',
    operatorKeyFingerprint: 'e'.repeat(64),
    operatorSignature: 'signed-recovery-request',
    operatorSignatureScheme: 'v1',
    operatorSignedRole: 'recovery',
    operatorSignedMethod: 'POST',
    operatorSignedPath: '/__internal/hostname-replicas/v1/recover',
    operatorIssuedAt: '1577836800000',
    requestBodyDigest: 'f'.repeat(64),
    incidentUrl: 'https://example.com/incidents/1',
    reason: 'historical incident',
    containmentRemains: false,
  };
}

function providerRequest(index: number, blocked: boolean) {
  return {
    rayId: `ray-${index}`,
    eventAt: '2020-01-01T00:00:00.000Z',
    verifiedAt: '2020-01-01T00:00:01.000Z',
    edgeColoCode: ['SJC', 'IAD', 'LHR'][index],
    host: HOST,
    path: '/__registry-probe',
    query: `nonce=nonce-${index}`,
    queryDigest: String(index + 1).repeat(64),
    edgeResponseStatus: blocked ? 403 : 404,
    httpLogResponseDigest: String(index + 4).repeat(64),
    firewall: blocked
      ? {
          action: 'block' as const,
          source: 'firewallcustom' as const,
          ruleId: '3'.repeat(32),
          ref: 'registry-recovery',
          matchIndex: 0 as const,
          logResponseDigest: String(index + 7).repeat(64),
        }
      : null,
  };
}

function consumedEvidence(index: number, phase: 'blocked-before-worker' | 'canonical-after-unblock') {
  const common = {
    id: `attestation-${index}`,
    receivedAt: '2020-01-01T00:00:03.000Z',
    subject: `probe-${index}`,
    keyVersion: `probe-key/${index}`,
    keyFingerprint: String(index + 1).repeat(64),
    region: ['us-west1', 'us-east1', 'europe-west1'][index],
  };
  const challenge = {
    probeNonce: `nonce-${index}`,
    subject: common.subject,
    keyVersion: common.keyVersion,
    keyFingerprint: common.keyFingerprint,
    region: common.region,
    host: HOST,
    expectedStateDigest: DIGEST,
    issuedAt: 1_577_836_801_000,
    expiresAt: 1_577_837_101_000,
    consumed: true as const,
    phase,
    recoveryLockId: phase === 'blocked-before-worker' ? null : 'lock-1',
    recoverySequence: phase === 'blocked-before-worker' ? null : '1',
    wafRemovedAt: phase === 'blocked-before-worker' ? null : '2020-01-01T00:00:00.500Z',
  };
  const observation =
    phase === 'blocked-before-worker'
      ? {
          phase,
          probeNonce: challenge.probeNonce,
          observedAt: '2020-01-01T00:00:02.000Z',
          rayId: `ray-${index}`,
          host: HOST,
          requestPath: `/__registry-probe?nonce=nonce-${index}`,
          expectedStatus: 403 as const,
          observedStatus: 403 as const,
          expectedBlockBodyDigest: '9'.repeat(64),
          observedBlockBodyDigest: '9'.repeat(64),
        }
      : {
          phase,
          probeNonce: challenge.probeNonce,
          observedAt: '2020-01-01T00:00:02.000Z',
          rayId: `ray-${index}`,
          host: HOST,
          requestPath: `/__registry-probe?nonce=nonce-${index}`,
          expectedStatus: 404,
          observedStatus: 404,
          expectedReason: 'unknown-host' as const,
          observedReason: 'unknown-host' as const,
          expectedRevision: '1',
          observedRevision: '1',
          expectedServesOrigin: false,
          observedServesOrigin: false,
          originRequestId: null,
        };
  return { ...common, challenge, observation } as ConsumedProbeEvidence;
}

function recordFor(action: RecoveryRecord['action']): RecoveryRecord {
  const value = record();
  if (action === 'apply') return value;
  const phase = action === 'clear-lock' ? 'canonical-after-unblock' : 'blocked-before-worker';
  const probeEvidence = [0, 1, 2].map((index) => consumedEvidence(index, phase));
  if (action === 'clear-lock') {
    return {
      ...value,
      action,
      evidence: {
        kind: action,
        lockId: 'lock-1',
        wafRemovedAt: '2020-01-01T00:00:00.500Z',
        probeAttestationIds: ['attestation-0', 'attestation-1', 'attestation-2'],
        providerRequests: [providerRequest(0, false), providerRequest(1, false), providerRequest(2, false)],
      },
      probeEvidence,
    };
  }
  const wafEvidence = {
    zoneId: '1'.repeat(32),
    rulesetId: '2'.repeat(32),
    ruleId: '3'.repeat(32),
    host: HOST,
    verifiedAt: '2020-01-01T00:00:01.000Z',
    blockNonce: 'block-nonce',
    providerRule: {
      enabled: true as const,
      action: 'block' as const,
      expression: `http.host eq "${HOST}"`,
      ref: 'registry-recovery',
      customResponseBodyDigest: '9'.repeat(64),
      responseDigest: '8'.repeat(64),
    },
    probeAttestationIds: ['attestation-0', 'attestation-1', 'attestation-2'] as [string, string, string],
    providerRequests: [providerRequest(0, true), providerRequest(1, true), providerRequest(2, true)] as [
      ReturnType<typeof providerRequest>,
      ReturnType<typeof providerRequest>,
      ReturnType<typeof providerRequest>,
    ],
  };
  return {
    ...value,
    action,
    evidence:
      action === 'acquire-lock'
        ? { kind: action, wafEvidence }
        : { kind: action, lockId: 'lock-1', wafEvidence },
    probeEvidence,
    containmentRemains: action === 'abort-lock',
  };
}

describe('persisted recovery history validation', () => {
  it('accepts an exact historical record without reapplying request freshness', () => {
    const value = record();

    expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value)).toEqual(value);
  });

  it.each(['acquire-lock', 'apply', 'clear-lock', 'abort-lock'] as const)(
    'accepts the exact persisted %s record union member',
    (action) => {
      const value = recordFor(action);

      expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value)).toEqual(value);
    },
  );

  it.each([
    ['extra record field', (value: RecoveryRecord) => ({ ...value, injected: true })],
    ['action/evidence mismatch', (value: RecoveryRecord) => ({ ...value, action: 'clear-lock' })],
    [
      'extra nested source field',
      (value: RecoveryRecord) => ({
        ...value,
        sourceAudit: {
          ...value.sourceAudit,
          canonicalProjection: { ...value.sourceAudit.canonicalProjection, injected: true },
        },
      }),
    ],
    [
      'altered operator provenance',
      (value: RecoveryRecord) => ({ ...value, operatorSignedRole: 'publisher' }),
    ],
  ])('rejects %s', (_label, mutate) => {
    const value = record();

    expect(() => parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), mutate(value))).toThrow(
      'recovery history malformed',
    );
  });

  it.each(['recovery/000001:2', 'recovery/000002:01', 'recovery/1'])('rejects storage key mismatch %s', (key) => {
    expect(() => parseRecoveryHistoryEntry(key, record())).toThrow('recovery history malformed');
  });
});
