// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ConsumedProbeEvidence } from './probe';
import type { ProviderRequestEvidence, PublisherReplacement, RecoveryRecord } from './recovery';
import { parseRecoveryHistoryEntry, recoveryHistoryKey } from './recoveryHistory';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const DIGEST = '99bf68a026a95b1138b7c4817574612436f29c8ae0ea1fe8fd623012026f9755';
const BLOCK_DIGEST = '4e248ff71724eb2329a89411cc42e0066126c183d48483a5a0e58c28b9f800a5';
const QUERY_DIGESTS = [
  'f452ed80873504332793632c3d877ee47313c6981da8219febb28a12470e9ee0',
  'cb7105cc1ed86c95b9754e7a81edc47b73e8ac196e78d65c2afa482774f76b92',
  '737b3b2c32ba8ba84f5a58572f1f428e9a2b052889bc956e558e52cdf95204bd',
] as const;

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

function publisherReplacement(): NonNullable<PublisherReplacement> {
  const oldEmail = 'old-publisher@fiveacross.iam.gserviceaccount.com';
  const replacementEmail = 'replacement-publisher@fiveacross.iam.gserviceaccount.com';
  const oldMember = `serviceAccount:${oldEmail}`;
  const replacementMember = `serviceAccount:${replacementEmail}`;
  const replacementKeyVersion =
    'projects/p/locations/l/keyRings/r/cryptoKeys/replacement/cryptoKeyVersions/1';
  const replacementResource =
    `//iam.googleapis.com/projects/fiveacross/serviceAccounts/${replacementEmail}`;
  return {
    quarantinedEpochCeiling: '7',
    nextPublisherEpoch: '8',
    replacementSubject: '1002',
    replacementKeyVersion,
    replacementKeyFingerprint: 'e'.repeat(64),
    registryConfigDigest: 'f'.repeat(64),
    controlEvidence: {
      observedAt: '2020-01-01T00:00:00.000Z',
      quarantinedRuntime: {
        subject: '1001',
        serviceAccountEmail: oldEmail,
        iamMember: oldMember,
        functionFullResourceName:
          '//cloudfunctions.googleapis.com/projects/fiveacross/locations/us-central1/functions/publisher-old',
        functionRevision: 'old-1',
        responseDigest: '1'.repeat(64),
      },
      replacementRuntime: {
        subject: '1002',
        serviceAccountEmail: replacementEmail,
        iamMember: replacementMember,
        functionFullResourceName:
          '//cloudfunctions.googleapis.com/projects/fiveacross/locations/us-central1/functions/publisher-replacement',
        functionRevision: 'new-1',
        responseDigest: '2'.repeat(64),
      },
      activeEpochMappings: [
        {
          epoch: '7',
          subject: '1001',
          keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/old/cryptoKeyVersions/1',
          algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
          spkiSha256: '9'.repeat(64),
        },
        {
          epoch: '8',
          subject: '1002',
          keyVersion: replacementKeyVersion,
          algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
          spkiSha256: 'e'.repeat(64),
        },
      ],
      keyAccess: [
        {
          cryptoKey: 'projects/p/locations/l/keyRings/r/cryptoKeys/old',
          policyEtag: 'old-etag',
          signMembers: [],
          enabledVersions: [
            {
              keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/old/cryptoKeyVersions/1',
              algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
              spkiSha256: '9'.repeat(64),
            },
          ],
          responseDigest: '3'.repeat(64),
        },
        {
          cryptoKey: 'projects/p/locations/l/keyRings/r/cryptoKeys/replacement',
          policyEtag: 'new-etag',
          signMembers: [replacementMember],
          enabledVersions: [
            {
              keyVersion: replacementKeyVersion,
              algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
              spkiSha256: 'e'.repeat(64),
            },
          ],
          responseDigest: '4'.repeat(64),
        },
      ],
      serviceAccountAccess: [
        {
          subject: '1001',
          serviceAccountEmail: oldEmail,
          iamMember: oldMember,
          fullResourceName: `//iam.googleapis.com/projects/fiveacross/serviceAccounts/${oldEmail}`,
          policyEtag: 'old-sa-etag',
          tokenCreatorMembers: [],
          responseDigest: '5'.repeat(64),
        },
        {
          subject: '1002',
          serviceAccountEmail: replacementEmail,
          iamMember: replacementMember,
          fullResourceName: replacementResource,
          policyEtag: 'new-sa-etag',
          tokenCreatorMembers: [],
          responseDigest: '6'.repeat(64),
        },
      ],
      quarantinedAccessDecisions: [
        {
          principal: oldEmail,
          fullResourceName: `//cloudkms.googleapis.com/${replacementKeyVersion}`,
          permission: 'cloudkms.cryptoKeyVersions.useToSign',
          requestTime: '2020-01-01T00:00:00.000Z',
          overallAccessState: 'CANNOT_ACCESS',
          inheritedPoliciesComplete: true,
          responseDigest: '7'.repeat(64),
        },
        {
          principal: oldEmail,
          fullResourceName: replacementResource,
          permission: 'iam.serviceAccounts.getOpenIdToken',
          requestTime: '2020-01-01T00:00:00.000Z',
          overallAccessState: 'CANNOT_ACCESS',
          inheritedPoliciesComplete: true,
          responseDigest: '8'.repeat(64),
        },
        {
          principal: oldEmail,
          fullResourceName: replacementResource,
          permission: 'iam.serviceAccounts.getAccessToken',
          requestTime: '2020-01-01T00:00:00.000Z',
          overallAccessState: 'CANNOT_ACCESS',
          inheritedPoliciesComplete: true,
          responseDigest: '9'.repeat(64),
        },
      ],
      attestorSub: 'source-attestor',
      attestorKeyVersion: 'source-key/1',
      attestorKeyFingerprint: 'd'.repeat(64),
      attestationIssuedAt: '2020-01-01T00:00:00.000Z',
      attestationSignature: 'signed-control-evidence',
    },
  };
}

function providerRequest(index: number, blocked: boolean): ProviderRequestEvidence {
  return {
    rayId: `ray-${index}`,
    eventAt: '2020-01-01T00:00:00.000Z',
    verifiedAt: '2020-01-01T00:00:01.000Z',
    edgeColoCode: ['SJC', 'IAD', 'LHR'][index],
    host: HOST,
    path: '/__registry-probe',
    query: `nonce=nonce-${index}`,
    queryDigest: QUERY_DIGESTS[index],
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
          expectedBlockBodyDigest: BLOCK_DIGEST,
          observedBlockBodyDigest: BLOCK_DIGEST,
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
          expectedReason: 'inactive' as const,
          observedReason: 'inactive' as const,
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
  const committed = { revision: '1', digest: DIGEST };
  const phase = action === 'clear-lock' ? 'canonical-after-unblock' : 'blocked-before-worker';
  const probeEvidence = [0, 1, 2].map((index) => consumedEvidence(index, phase));
  if (action === 'clear-lock') {
    return {
      ...value,
      sequence: '2',
      action,
      before: committed,
      after: committed,
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
      customResponseBodyDigest: BLOCK_DIGEST,
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
    sequence: action === 'acquire-lock' ? '1' : '2',
    action,
    before: committed,
    after: committed,
    evidence:
      action === 'acquire-lock'
        ? { kind: action, wafEvidence }
        : { kind: action, lockId: 'lock-1', wafEvidence },
    probeEvidence,
    containmentRemains: action === 'abort-lock',
  };
}

function replacementRecord(): RecoveryRecord {
  const value = record();
  const committed = { revision: '1', digest: DIGEST };
  return {
    ...value,
    sequence: '2',
    before: committed,
    after: committed,
    evidence: {
      kind: 'apply',
      lockId: 'lock-1',
      publisherReplacement: publisherReplacement(),
    },
  };
}

describe('persisted recovery history validation', () => {
  it('accepts an exact historical record without reapplying request freshness', async () => {
    const value = record();

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).resolves.toEqual(value);
  });

  it.each(['acquire-lock', 'apply', 'clear-lock', 'abort-lock'] as const)(
    'accepts the exact persisted %s record union member',
    async (action) => {
      const value = recordFor(action);

      await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).resolves.toEqual(value);
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
      'canonical desired differs from ledger',
      (value: RecoveryRecord) => ({
        ...value,
        sourceAudit: {
          ...value.sourceAudit,
          canonicalProjection: {
            ...value.sourceAudit.canonicalProjection,
            desired: { ...value.sourceAudit.canonicalProjection.desired, eventId: 'different-event' },
          },
        },
      }),
    ],
    [
      'source and committed digests differ from the ledger projection',
      (value: RecoveryRecord) => ({
        ...value,
        after: { revision: '1', digest: '0'.repeat(64) },
        sourceAudit: { ...value.sourceAudit, digest: '0'.repeat(64) },
      }),
    ],
    [
      'altered operator provenance',
      (value: RecoveryRecord) => ({ ...value, operatorSignedRole: 'publisher' }),
    ],
  ])('rejects %s', async (_label, mutate) => {
    const value = record();

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), mutate(value), HOST)).rejects.toThrow(
      'recovery history malformed',
    );
  });

  it.each([
    [
      'source and ledger',
      (foreignHost: string) => {
        const value = record();
        return {
          ...value,
          sourceAudit: {
            ...value.sourceAudit,
            canonicalProjection: {
              ...value.sourceAudit.canonicalProjection,
              host: foreignHost,
              desired: { ...value.sourceAudit.canonicalProjection.desired, slug: 'r2-abcdefghijklmnopqrstuvwxya' },
            },
            ledgerPayload: {
              ...value.sourceAudit.ledgerPayload,
              host: foreignHost,
              desired: { ...value.sourceAudit.ledgerPayload.desired, slug: 'r2-abcdefghijklmnopqrstuvwxya' },
            },
          },
        };
      },
    ],
    [
      'WAF and provider requests',
      (foreignHost: string) => {
        const value = recordFor('acquire-lock');
        if (value.evidence.kind !== 'acquire-lock') throw new Error('test setup');
        return {
          ...value,
          evidence: {
            ...value.evidence,
            wafEvidence: {
              ...value.evidence.wafEvidence,
              host: foreignHost,
              providerRequests: value.evidence.wafEvidence.providerRequests.map((request) => ({
                ...request,
                host: foreignHost,
              })) as typeof value.evidence.wafEvidence.providerRequests,
            },
          },
        };
      },
    ],
    [
      'WAF expression',
      (foreignHost: string) => {
        const value = recordFor('acquire-lock');
        if (value.evidence.kind !== 'acquire-lock') throw new Error('test setup');
        return {
          ...value,
          evidence: {
            ...value.evidence,
            wafEvidence: {
              ...value.evidence.wafEvidence,
              providerRule: {
                ...value.evidence.wafEvidence.providerRule,
                expression: `http.host eq "${foreignHost}"`,
              },
            },
          },
        };
      },
    ],
    [
      'clear provider requests',
      (foreignHost: string) => {
        const value = recordFor('clear-lock');
        if (value.evidence.kind !== 'clear-lock') throw new Error('test setup');
        return {
          ...value,
          evidence: {
            ...value.evidence,
            providerRequests: value.evidence.providerRequests.map((request) => ({
              ...request,
              host: foreignHost,
            })) as typeof value.evidence.providerRequests,
          },
        };
      },
    ],
    [
      'probe challenge and observation',
      (foreignHost: string) => {
        const value = recordFor('clear-lock');
        return {
          ...value,
          probeEvidence: value.probeEvidence.map((evidence) => ({
            ...evidence,
            challenge: { ...evidence.challenge, host: foreignHost },
            observation: { ...evidence.observation, host: foreignHost },
          })),
        };
      },
    ],
  ])('rejects a foreign-host %s projection copied into the owning object history', async (_label, build) => {
    const foreignHost = 'r2-abcdefghijklmnopqrstuvwxya.fiveacross.app';
    const value = build(foreignHost);

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).rejects.toThrow(
      'recovery history malformed',
    );
  });

  it.each(['recovery/000001:2', 'recovery/000002:01', 'recovery/1'])(
    'rejects storage key mismatch %s',
    async (key) => {
      await expect(parseRecoveryHistoryEntry(key, record(), HOST)).rejects.toThrow('recovery history malformed');
    },
  );

  it('rejects a provider query whose persisted digest no longer matches', async () => {
    const value = recordFor('clear-lock');
    if (value.evidence.kind !== 'clear-lock') throw new Error('test setup');
    value.evidence.providerRequests[0].query = 'nonce=changed';

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).rejects.toThrow(
      'recovery history malformed',
    );
  });

  it('rejects an absolute persisted probe request URL', async () => {
    const value = recordFor('clear-lock');
    value.probeEvidence[0].observation.requestPath =
      'https://attacker.invalid/__registry-probe?nonce=nonce-0';

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).rejects.toThrow(
      'recovery history malformed',
    );
  });

  it.each([
    {
      label: 'Ray ID',
      mutate: (request: ReturnType<typeof providerRequest>) => {
        request.rayId = 'different-ray';
      },
    },
    {
      label: 'path',
      mutate: (request: ReturnType<typeof providerRequest>) => {
        request.path = '/different-probe';
      },
    },
    {
      label: 'query',
      mutate: (request: ReturnType<typeof providerRequest>) => {
        request.query = 'nonce=changed';
        request.queryDigest = '191bf32682ecc342b28eda69239493ebb5c0260af1af35c6c3ee9558f19c8464';
      },
    },
    {
      label: 'status',
      mutate: (request: ReturnType<typeof providerRequest>) => {
        request.edgeResponseStatus = 200;
      },
    },
  ])('rejects a provider/probe $label mismatch', async ({ mutate }) => {
    const value = recordFor('clear-lock');
    if (value.evidence.kind !== 'clear-lock') throw new Error('test setup');
    mutate(value.evidence.providerRequests[0]);

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).rejects.toThrow(
      'recovery history malformed',
    );
  });

  it.each([
    {
      label: 'block nonce/body digest',
      mutate: (value: RecoveryRecord) => {
        if (value.evidence.kind !== 'acquire-lock') throw new Error('test setup');
        value.evidence.wafEvidence.blockNonce = 'different-block-nonce';
      },
    },
    {
      label: 'rule ID/firewall record',
      mutate: (value: RecoveryRecord) => {
        if (value.evidence.kind !== 'acquire-lock') throw new Error('test setup');
        value.evidence.wafEvidence.ruleId = '4'.repeat(32);
      },
    },
    {
      label: 'rule ref/firewall record',
      mutate: (value: RecoveryRecord) => {
        if (value.evidence.kind !== 'acquire-lock') throw new Error('test setup');
        value.evidence.wafEvidence.providerRule.ref = 'different-ref';
      },
    },
  ])('rejects a WAF $label mismatch', async ({ mutate }) => {
    const value = recordFor('acquire-lock');
    mutate(value);

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).rejects.toThrow(
      'recovery history malformed',
    );
  });

  it('rejects blocked probe evidence whose body digest differs from the WAF response', async () => {
    const value = recordFor('acquire-lock');
    const observation = value.probeEvidence[0].observation;
    if (observation.phase !== 'blocked-before-worker') throw new Error('test setup');
    observation.expectedBlockBodyDigest = '0'.repeat(64);
    observation.observedBlockBodyDigest = '0'.repeat(64);

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).rejects.toThrow(
      'recovery history malformed',
    );
  });

  it('accepts internally consistent persisted publisher-replacement evidence', async () => {
    const value = replacementRecord();

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).resolves.toEqual(value);
  });

  it.each([
    {
      label: 'replacement subject/runtime',
      mutate: (replacement: NonNullable<PublisherReplacement>) => {
        replacement.replacementSubject = '1003';
      },
    },
    {
      label: 'replacement key/fingerprint mapping',
      mutate: (replacement: NonNullable<PublisherReplacement>) => {
        replacement.replacementKeyFingerprint = '0'.repeat(64);
      },
    },
    {
      label: 'active mapping/key readback',
      mutate: (replacement: NonNullable<PublisherReplacement>) => {
        replacement.controlEvidence.activeEpochMappings[1].spkiSha256 = '0'.repeat(64);
      },
    },
    {
      label: 'replacement direct signer policy',
      mutate: (replacement: NonNullable<PublisherReplacement>) => {
        replacement.controlEvidence.keyAccess[1].signMembers = [];
      },
    },
    {
      label: 'quarantine decision principal/resource',
      mutate: (replacement: NonNullable<PublisherReplacement>) => {
        replacement.controlEvidence.quarantinedAccessDecisions[0].principal =
          'different@fiveacross.iam.gserviceaccount.com';
      },
    },
  ])('rejects a publisher $label mismatch', async ({ mutate }) => {
    const value = replacementRecord();
    if (value.evidence.kind !== 'apply' || value.evidence.publisherReplacement === null) {
      throw new Error('test setup');
    }
    mutate(value.evidence.publisherReplacement);

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).rejects.toThrow(
      'recovery history malformed',
    );
  });

  it.each([
    {
      label: 'lock-only before/after transition',
      build: () => {
        const value = recordFor('acquire-lock');
        value.after = { revision: '1', digest: '0'.repeat(64) };
        return value;
      },
    },
    {
      label: 'apply after/source transition',
      build: () => {
        const value = record();
        value.after = { revision: '2', digest: DIGEST };
        return value;
      },
    },
    {
      label: 'apply skipped range',
      build: () => {
        const value = record();
        value.skippedRevisionRange = { from: '1', to: '1' };
        return value;
      },
    },
    {
      label: 'clear probe lock',
      build: () => {
        const value = recordFor('clear-lock');
        for (const evidence of value.probeEvidence) {
          if (evidence.challenge.phase !== 'canonical-after-unblock') throw new Error('test setup');
          evidence.challenge.recoveryLockId = 'different-lock';
        }
        return value;
      },
    },
    {
      label: 'clear probe sequence',
      build: () => {
        const value = recordFor('clear-lock');
        for (const evidence of value.probeEvidence) {
          if (evidence.challenge.phase !== 'canonical-after-unblock') throw new Error('test setup');
          evidence.challenge.recoverySequence = '9';
        }
        return value;
      },
    },
    {
      label: 'clear WAF-removal time',
      build: () => {
        const value = recordFor('clear-lock');
        for (const evidence of value.probeEvidence) {
          if (evidence.challenge.phase !== 'canonical-after-unblock') throw new Error('test setup');
          evidence.challenge.wafRemovedAt = '2020-01-01T00:00:00.750Z';
        }
        return value;
      },
    },
    {
      label: 'probe expected-state digest',
      build: () => {
        const value = recordFor('abort-lock');
        for (const evidence of value.probeEvidence) evidence.challenge.expectedStateDigest = '0'.repeat(64);
        return value;
      },
    },
    {
      label: 'abort containment flag',
      build: () => ({ ...recordFor('abort-lock'), containmentRemains: false }),
    },
  ])('rejects an inconsistent $label binding', async ({ build }) => {
    const value = build();

    await expect(parseRecoveryHistoryEntry(recoveryHistoryKey(value.sequence), value, HOST)).rejects.toThrow(
      'recovery history malformed',
    );
  });
});
