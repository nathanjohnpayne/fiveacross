// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectionDigest, type RegistryState, type RouterReplicaDesired } from './contracts';
import {
  applyRecovery,
  validateSourceAudit,
  type ProviderRequestEvidence,
  type PublisherReplacement,
  type RecoveryContext,
  type RecoveryRequest,
  type SourceAudit,
  type WafEvidence,
} from './recovery';
import { applyPublisherSync, initialRegistryState } from './state';
import { parseRecovery } from './controlService';
import type { ConsumedProbeEvidence } from './probe';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const NOW = Date.parse('2026-08-19T12:35:00.000Z');
const RECOVERY_AUTHORIZATION = {
  operatorKeyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/recovery/cryptoKeyVersions/1',
  operatorKeyFingerprint: 'd'.repeat(64),
  operatorSignature: 'signed-recovery-request',
  requestBodyDigest: 'e'.repeat(64),
} as const;

async function consumedEvidence(
  ids: readonly string[],
  phase: 'blocked' | 'canonical',
): Promise<readonly ConsumedProbeEvidence[]> {
  return ids.map((id, index) => {
    const suffix = index + 1;
    const probePhase = phase === 'blocked' ? ('blocked-before-worker' as const) : ('canonical-after-unblock' as const);
    const common = {
      id,
      receivedAt: '2026-08-19T12:34:56.000Z',
      subject: `runner-${suffix}`,
      keyVersion: `projects/p/locations/l/keyRings/r/cryptoKeys/probe-${suffix}/cryptoKeyVersions/1`,
      keyFingerprint: String(suffix).repeat(64),
      region: ['us-west1', 'us-east1', 'europe-west1'][index],
      challenge: {
        probeNonce: `nonce-${suffix}`,
        subject: `runner-${suffix}`,
        keyVersion: `projects/p/locations/l/keyRings/r/cryptoKeys/probe-${suffix}/cryptoKeyVersions/1`,
        keyFingerprint: String(suffix).repeat(64),
        region: ['us-west1', 'us-east1', 'europe-west1'][index],
        phase: probePhase,
        host: HOST,
        expectedStateDigest: 'a'.repeat(64),
        issuedAt: NOW - 10_000,
        expiresAt: NOW + 10_000,
        consumed: true,
      },
      observation:
        phase === 'blocked'
          ? {
              phase: 'blocked-before-worker' as const,
              probeNonce: `nonce-${suffix}`,
              observedAt: '2026-08-19T12:34:55.000Z',
              rayId: `ray-${suffix}`,
              host: HOST,
              requestPath: `/__registry-probe?nonce=nonce-${suffix}`,
              expectedStatus: 403 as const,
              observedStatus: 403 as const,
              expectedBlockBodyDigest: '1'.repeat(64),
              observedBlockBodyDigest: '1'.repeat(64),
            }
          : {
              phase: 'canonical-after-unblock' as const,
              probeNonce: `nonce-${suffix}`,
              observedAt: '2026-08-19T12:34:55.000Z',
              rayId: `ray-${suffix}`,
              host: HOST,
              requestPath: `/__registry-probe?nonce=nonce-${suffix}`,
              expectedStatus: 404,
              observedStatus: 404,
              expectedReason: 'unknown-host' as const,
              observedReason: 'unknown-host' as const,
              expectedRevision: '1',
              observedRevision: '1',
              expectedServesOrigin: false,
              observedServesOrigin: false,
              originRequestId: null,
            },
    };
    return common;
  });
}

function recoveryContext(lockId: string, overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    now: NOW,
    operatorSub: 'recovery-operator',
    lockId,
    ...RECOVERY_AUTHORIZATION,
    consumeAttestations: consumedEvidence,
    ...overrides,
  };
}

function payload(revision: string, eventId = 'synthetic-event'): RouterReplicaDesired {
  return {
    schemaVersion: 1,
    revision,
    host: HOST,
    desired: {
      kind: 'route',
      eventId,
      status: 'disabled',
      slug: 'r2-abcdefghijklmnopqrstuvwxyz',
      edition: 'fiveacross',
      pathNamespace: null,
    },
    updatedAt: '2026-08-19T12:34:30.000Z',
  };
}

async function sourceAudit(revision: string, eventId = 'synthetic-event'): Promise<SourceAudit> {
  const ledgerPayload = payload(revision, eventId);
  return {
    revision,
    digest: await projectionDigest(ledgerPayload),
    observedAt: '2026-08-19T12:34:40.000Z',
    canonicalProjection: {
      sourceDocumentDigest: 'a'.repeat(64),
      host: HOST,
      desired: ledgerPayload.desired,
    },
    ledgerPayload,
    ledgerDocumentDigest: 'b'.repeat(64),
    attestorSub: 'source-attestor-sub',
    attestorKeyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/source/cryptoKeyVersions/1',
    attestorKeyFingerprint: 'c'.repeat(64),
    attestationIssuedAt: '2026-08-19T12:34:45.000Z',
    attestationSignature: 'signed-source-audit',
  };
}

function providerRequest(index: number, blocked: boolean): ProviderRequestEvidence {
  const query = `nonce=nonce-${index}`;
  return {
    rayId: `ray-${index}`,
    eventAt: '2026-08-19T12:34:50.000Z',
    verifiedAt: '2026-08-19T12:34:55.000Z',
    edgeColoCode: ['SJC', 'IAD', 'LHR'][index - 1],
    host: HOST,
    path: '/__registry-probe',
    query,
    queryDigest: createHash('sha256').update(query).digest('hex'),
    edgeResponseStatus: blocked ? 403 : 404,
    httpLogResponseDigest: String(index + 3).repeat(64),
    firewall: blocked
      ? {
          action: 'block',
          source: 'firewallcustom',
          ruleId: 'rule-1',
          ref: 'registry-recovery-lock-1',
          matchIndex: 0,
          logResponseDigest: String(index + 6).repeat(64),
        }
      : null,
  };
}

async function wafEvidence(): Promise<WafEvidence> {
  const blockNonce = 'block-nonce-1';
  const digestBytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ recoveryBlock: blockNonce })),
  );
  const customResponseBodyDigest = [...new Uint8Array(digestBytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    zoneId: 'zone-1',
    rulesetId: 'ruleset-1',
    ruleId: 'rule-1',
    host: HOST,
    verifiedAt: '2026-08-19T12:34:55.000Z',
    blockNonce,
    providerRule: {
      enabled: true,
      action: 'block',
      expression: `http.host eq "${HOST}"`,
      ref: 'registry-recovery-lock-1',
      customResponseBodyDigest,
      responseDigest: 'd'.repeat(64),
    },
    probeAttestationIds: ['att-1', 'att-2', 'att-3'],
    providerRequests: [providerRequest(1, true), providerRequest(2, true), providerRequest(3, true)],
  };
}

async function request(
  state: RegistryState,
  action: RecoveryRequest['action'],
  source = sourceAudit(state.committed?.revision ?? '1'),
): Promise<RecoveryRequest> {
  return {
    schemaVersion: 1,
    host: HOST,
    expectedCommitted: state.committed ? { revision: state.committed.revision, digest: state.committed.digest } : null,
    sourceAudit: await source,
    action,
    incidentUrl: 'https://example.com/incidents/registry-1',
    reason: 'synthetic recovery exercise',
  };
}

async function committedState(revision = '1'): Promise<RegistryState> {
  return (await applyPublisherSync(initialRegistryState(), payload(revision), '1')).state;
}

describe('source-attested recovery', () => {
  it('requires a fresh, exact canonical-source/ledger equality before recovery', async () => {
    const valid = await sourceAudit('1');
    await expect(validateSourceAudit(HOST, valid, NOW)).resolves.toEqual(valid.ledgerPayload);

    await expect(
      validateSourceAudit(
        HOST,
        {
          ...valid,
          canonicalProjection: {
            ...valid.canonicalProjection,
            desired: payload('1', 'poisoned').desired,
          },
        },
        NOW,
      ),
    ).rejects.toThrow('source and ledger differ');
    await expect(validateSourceAudit(HOST, { ...valid, observedAt: '2026-08-19T12:20:00.000Z' }, NOW)).rejects.toThrow(
      'source audit is stale',
    );
  });

  it('acquires an exact-host durable lock only with three distinct blocked provider records', async () => {
    const state = await committedState();
    const consumedProbeEvidence = [1, 2, 3].map((index) => ({
      id: `att-${index}`,
      receivedAt: '2026-08-19T12:34:56.000Z',
      subject: `runner-${index}`,
      keyVersion: `projects/p/locations/l/keyRings/r/cryptoKeys/probe-${index}/cryptoKeyVersions/1`,
      keyFingerprint: String(index).repeat(64),
      region: ['us-west1', 'us-east1', 'europe-west1'][index - 1],
      challenge: {
        probeNonce: `nonce-${index}`,
        subject: `runner-${index}`,
        keyVersion: `projects/p/locations/l/keyRings/r/cryptoKeys/probe-${index}/cryptoKeyVersions/1`,
        keyFingerprint: String(index).repeat(64),
        region: ['us-west1', 'us-east1', 'europe-west1'][index - 1],
        phase: 'blocked-before-worker' as const,
        host: HOST,
        expectedStateDigest: state.committed?.digest ?? '',
        issuedAt: NOW - 10_000,
        expiresAt: NOW + 10_000,
        consumed: true as const,
      },
      observation: {
        phase: 'blocked-before-worker' as const,
        probeNonce: `nonce-${index}`,
        observedAt: '2026-08-19T12:34:55.000Z',
        rayId: `ray-${index}`,
        host: HOST,
        requestPath: `/__registry-probe?nonce=nonce-${index}`,
        expectedStatus: 403 as const,
        observedStatus: 403 as const,
        expectedBlockBodyDigest: '1'.repeat(64),
        observedBlockBodyDigest: '1'.repeat(64),
      },
    }));
    const result = await applyRecovery(
      state,
      await request(state, {
        kind: 'acquire-lock',
        wafEvidence: await wafEvidence(),
      }),
      recoveryContext('lock-1', {
        consumeAttestations: async () => consumedProbeEvidence as never,
      }),
    );
    expect(result.state.recoveryLock).toMatchObject({
      lockId: 'lock-1',
      operatorSub: 'recovery-operator',
    });
    expect(result.record).toMatchObject({
      sequence: '1',
      action: 'acquire-lock',
      operatorSub: 'recovery-operator',
      ...RECOVERY_AUTHORIZATION,
      probeEvidence: consumedProbeEvidence,
    });

    await expect(
      applyRecovery(
        state,
        await request(state, { kind: 'acquire-lock', wafEvidence: await wafEvidence() }),
        recoveryContext('lock-without-probes', { consumeAttestations: undefined }),
      ),
    ).rejects.toThrow('probe attestation consumer is unavailable');

    const evidence = await wafEvidence();
    evidence.providerRequests[2].edgeColoCode = evidence.providerRequests[0].edgeColoCode;
    await expect(
      applyRecovery(
        state,
        await request(state, { kind: 'acquire-lock', wafEvidence: evidence }),
        recoveryContext('lock-2'),
      ),
    ).rejects.toThrow('provider colos must be distinct');

    const forgedQueryDigest = await wafEvidence();
    forgedQueryDigest.providerRequests[0].queryDigest = 'a'.repeat(64);
    await expect(
      applyRecovery(
        state,
        await request(state, { kind: 'acquire-lock', wafEvidence: forgedQueryDigest }),
        recoveryContext('lock-3'),
      ),
    ).rejects.toThrow('provider response digest');

    const nestedExtra = await request(state, {
      kind: 'acquire-lock',
      wafEvidence: await wafEvidence(),
    });
    (
      nestedExtra.action as Extract<RecoveryRequest['action'], { kind: 'acquire-lock' }>
    ).wafEvidence.providerRequests[0] = {
      ...(nestedExtra.action as Extract<RecoveryRequest['action'], { kind: 'acquire-lock' }>).wafEvidence
        .providerRequests[0],
      unexpectedTokenSink: 'must-not-persist',
    } as never;
    expect(() => parseRecovery(nestedExtra)).toThrow('provider request');
  });

  it('applies an equal repair or higher jump, records skips, and never goes backward', async () => {
    const state = await committedState();
    const acquired = await applyRecovery(
      state,
      await request(state, {
        kind: 'acquire-lock',
        wafEvidence: await wafEvidence(),
      }),
      recoveryContext('lock-1'),
    );
    const repairedAudit = sourceAudit('1', 'canonical-repair');
    await expect(
      applyRecovery(
        acquired.state,
        await request(acquired.state, { kind: 'apply', lockId: 'lock-1', publisherReplacement: null }, repairedAudit),
        recoveryContext('unused'),
      ),
    ).rejects.toThrow('publisher replacement required');

    const jump = await applyRecovery(
      acquired.state,
      await request(acquired.state, { kind: 'apply', lockId: 'lock-1', publisherReplacement: null }, sourceAudit('4')),
      recoveryContext('unused', { publisherIntegrityProven: true }),
    );
    expect(jump.state.committed?.revision).toBe('4');
    expect(jump.record.skippedRevisionRange).toEqual({ from: '2', to: '3' });
    expect(jump.state.recoveryLock?.lockId).toBe('lock-1');

    await expect(
      applyRecovery(
        jump.state,
        await request(jump.state, { kind: 'apply', lockId: 'lock-1', publisherReplacement: null }, sourceAudit('3')),
        recoveryContext('unused', { publisherIntegrityProven: true }),
      ),
    ).rejects.toThrow('source-behind');
  });

  it('fences every quarantined epoch before activating a direct-only replacement', async () => {
    const oldEmail = 'old-publisher@fiveacross.iam.gserviceaccount.com';
    const replacementEmail = 'replacement-publisher@fiveacross.iam.gserviceaccount.com';
    const oldMember = `serviceAccount:${oldEmail}`;
    const replacementMember = `serviceAccount:${replacementEmail}`;
    const oldResource = `//iam.googleapis.com/projects/fiveacross/serviceAccounts/${oldEmail}`;
    const replacementResource = `//iam.googleapis.com/projects/fiveacross/serviceAccounts/${replacementEmail}`;
    const oldFunctionResource =
      '//cloudfunctions.googleapis.com/projects/fiveacross/locations/us-central1/functions/publisher-old';
    const replacementFunctionResource =
      '//cloudfunctions.googleapis.com/projects/fiveacross/locations/us-central1/functions/publisher-replacement';
    const base = {
      ...(await committedState()),
      highestAuthenticatedPublisherEpoch: '7',
    };
    const acquired = await applyRecovery(
      base,
      await request(base, {
        kind: 'acquire-lock',
        wafEvidence: await wafEvidence(),
      }),
      recoveryContext('lock-1'),
    );
    const replacement: NonNullable<PublisherReplacement> = {
      quarantinedEpochCeiling: '7',
      nextPublisherEpoch: '8',
      replacementSubject: '1002',
      replacementKeyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/replacement/cryptoKeyVersions/1',
      replacementKeyFingerprint: 'e'.repeat(64),
      registryConfigDigest: 'f'.repeat(64),
      controlEvidence: {
        observedAt: '2026-08-19T12:34:50.000Z',
        quarantinedRuntime: {
          subject: '1001',
          serviceAccountEmail: oldEmail,
          iamMember: oldMember,
          functionFullResourceName: oldFunctionResource,
          functionRevision: 'old-1',
          responseDigest: '1'.repeat(64),
        },
        replacementRuntime: {
          subject: '1002',
          serviceAccountEmail: replacementEmail,
          iamMember: replacementMember,
          functionFullResourceName: replacementFunctionResource,
          functionRevision: 'new-1',
          responseDigest: '2'.repeat(64),
        },
        activeEpochMappings: [
          {
            epoch: '7',
            subject: '1001',
            keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/old/cryptoKeyVersions/1',
            algorithm: 'RSA_SIGN_PKCS1_2048_SHA256' as const,
            spkiSha256: '9'.repeat(64),
          },
          {
            epoch: '8',
            subject: '1002',
            keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/replacement/cryptoKeyVersions/1',
            algorithm: 'RSA_SIGN_PKCS1_2048_SHA256' as const,
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
                algorithm: 'RSA_SIGN_PKCS1_2048_SHA256' as const,
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
                keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/replacement/cryptoKeyVersions/1',
                algorithm: 'RSA_SIGN_PKCS1_2048_SHA256' as const,
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
            fullResourceName: oldResource,
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
            fullResourceName:
              '//cloudkms.googleapis.com/projects/p/locations/l/keyRings/r/cryptoKeys/replacement/cryptoKeyVersions/1',
            permission: 'cloudkms.cryptoKeyVersions.useToSign' as const,
            requestTime: '2026-08-19T12:34:50.000Z',
            overallAccessState: 'CANNOT_ACCESS' as const,
            inheritedPoliciesComplete: true as const,
            responseDigest: '7'.repeat(64),
          },
          {
            principal: oldEmail,
            fullResourceName: replacementResource,
            permission: 'iam.serviceAccounts.getOpenIdToken' as const,
            requestTime: '2026-08-19T12:34:50.000Z',
            overallAccessState: 'CANNOT_ACCESS' as const,
            inheritedPoliciesComplete: true as const,
            responseDigest: '8'.repeat(64),
          },
          {
            principal: oldEmail,
            fullResourceName: replacementResource,
            permission: 'iam.serviceAccounts.getAccessToken' as const,
            requestTime: '2026-08-19T12:34:50.000Z',
            overallAccessState: 'CANNOT_ACCESS' as const,
            inheritedPoliciesComplete: true as const,
            responseDigest: '9'.repeat(64),
          },
        ],
        attestorSub: 'source-attestor-sub',
        attestorKeyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/source/cryptoKeyVersions/1',
        attestorKeyFingerprint: 'c'.repeat(64),
        attestationIssuedAt: '2026-08-19T12:34:50.000Z',
        attestationSignature: 'signed-control-evidence',
      },
    };
    const replacementContext = recoveryContext('unused', {
      activeRegistryConfigDigest: 'f'.repeat(64),
      activePublisherMappings: replacement.controlEvidence.activeEpochMappings,
    });
    const strictRequest = await request(
      acquired.state,
      { kind: 'apply', lockId: 'lock-1', publisherReplacement: replacement },
      sourceAudit('2'),
    );
    expect(parseRecovery(strictRequest)).toEqual(strictRequest);
    const nestedReplacementExtra = structuredClone(strictRequest);
    if (nestedReplacementExtra.action.kind !== 'apply' || nestedReplacementExtra.action.publisherReplacement === null) {
      throw new Error('replacement fixture is malformed');
    }
    nestedReplacementExtra.action.publisherReplacement.controlEvidence.quarantinedRuntime = {
      ...nestedReplacementExtra.action.publisherReplacement.controlEvidence.quarantinedRuntime,
      leakedCredential: 'must-not-persist',
    } as never;
    expect(() => parseRecovery(nestedReplacementExtra)).toThrow('publisher runtime readback');

    const applied = await applyRecovery(acquired.state, strictRequest, replacementContext);
    expect(applied.state.minimumPublisherEpoch).toBe('8');
    expect(applied.state.highestQuarantinedPublisherEpoch).toBe('7');

    const invalid = structuredClone(replacement);
    invalid.controlEvidence.quarantinedAccessDecisions[1].overallAccessState = 'CAN_ACCESS' as never;
    await expect(
      applyRecovery(
        acquired.state,
        await request(
          acquired.state,
          { kind: 'apply', lockId: 'lock-1', publisherReplacement: invalid },
          sourceAudit('2'),
        ),
        replacementContext,
      ),
    ).rejects.toThrow('CANNOT_ACCESS');

    const unrelatedResources = structuredClone(replacement);
    unrelatedResources.controlEvidence.keyAccess[1] = structuredClone(unrelatedResources.controlEvidence.keyAccess[0]);
    unrelatedResources.controlEvidence.quarantinedAccessDecisions[0].fullResourceName =
      '//cloudkms.googleapis.com/projects/p/locations/l/keyRings/r/cryptoKeys/unrelated/cryptoKeyVersions/1';
    await expect(
      applyRecovery(
        acquired.state,
        await request(
          acquired.state,
          {
            kind: 'apply',
            lockId: 'lock-1',
            publisherReplacement: unrelatedResources,
          },
          sourceAudit('2'),
        ),
        replacementContext,
      ),
    ).rejects.toThrow(/resource|readback/);

    const irrelevantDecision = structuredClone(replacement);
    irrelevantDecision.controlEvidence.quarantinedAccessDecisions[0].fullResourceName =
      '//cloudkms.googleapis.com/projects/p/locations/l/keyRings/r/cryptoKeys/unrelated/cryptoKeyVersions/1';
    await expect(
      applyRecovery(
        acquired.state,
        await request(
          acquired.state,
          {
            kind: 'apply',
            lockId: 'lock-1',
            publisherReplacement: irrelevantDecision,
          },
          sourceAudit('2'),
        ),
        replacementContext,
      ),
    ).rejects.toThrow('quarantine decisions');

    const wrongQuarantinedVersion = structuredClone(replacement);
    wrongQuarantinedVersion.controlEvidence.keyAccess[0].enabledVersions[0].spkiSha256 = '8'.repeat(64);
    await expect(
      applyRecovery(
        acquired.state,
        await request(
          acquired.state,
          {
            kind: 'apply',
            lockId: 'lock-1',
            publisherReplacement: wrongQuarantinedVersion,
          },
          sourceAudit('2'),
        ),
        replacementContext,
      ),
    ).rejects.toThrow('quarantined key version readback');

    const extraReplacementSigner = structuredClone(replacement);
    extraReplacementSigner.controlEvidence.keyAccess[1].signMembers.push(
      'serviceAccount:unreviewed@fiveacross.iam.gserviceaccount.com',
    );
    await expect(
      applyRecovery(
        acquired.state,
        await request(
          acquired.state,
          {
            kind: 'apply',
            lockId: 'lock-1',
            publisherReplacement: extraReplacementSigner,
          },
          sourceAudit('2'),
        ),
        replacementContext,
      ),
    ).rejects.toThrow('replacement key policy must exactly match');

    const extraReplacementVersion = structuredClone(replacement);
    extraReplacementVersion.controlEvidence.keyAccess[1].enabledVersions.push({
      keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/replacement/cryptoKeyVersions/2',
      algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
      spkiSha256: '8'.repeat(64),
    });
    await expect(
      applyRecovery(
        acquired.state,
        await request(
          acquired.state,
          {
            kind: 'apply',
            lockId: 'lock-1',
            publisherReplacement: extraReplacementVersion,
          },
          sourceAudit('2'),
        ),
        replacementContext,
      ),
    ).rejects.toThrow('replacement key policy must exactly match');

    const omittedMapping = structuredClone(replacement);
    omittedMapping.controlEvidence.activeEpochMappings.shift();
    await expect(
      applyRecovery(
        acquired.state,
        await request(
          acquired.state,
          {
            kind: 'apply',
            lockId: 'lock-1',
            publisherReplacement: omittedMapping,
          },
          sourceAudit('2'),
        ),
        replacementContext,
      ),
    ).rejects.toThrow('active epoch mappings do not match');
  });

  it('clears only after fresh source equals committed and three canonical records match', async () => {
    const state = await committedState();
    const acquired = await applyRecovery(
      state,
      await request(state, {
        kind: 'acquire-lock',
        wafEvidence: await wafEvidence(),
      }),
      recoveryContext('lock-1'),
    );
    const clear = await applyRecovery(
      acquired.state,
      await request(acquired.state, {
        kind: 'clear-lock',
        lockId: 'lock-1',
        wafRemovedAt: '2026-08-19T12:34:56.000Z',
        probeAttestationIds: ['clear-1', 'clear-2', 'clear-3'],
        providerRequests: [providerRequest(1, false), providerRequest(2, false), providerRequest(3, false)],
      }),
      recoveryContext('unused'),
    );
    expect(clear.state.recoveryLock).toBeNull();
    expect(clear.record.action).toBe('clear-lock');
  });

  it('aborts without mutating committed state and records that containment remains', async () => {
    const state = await committedState();
    const acquired = await applyRecovery(
      state,
      await request(state, {
        kind: 'acquire-lock',
        wafEvidence: await wafEvidence(),
      }),
      recoveryContext('lock-1'),
    );
    const aborted = await applyRecovery(
      acquired.state,
      await request(acquired.state, {
        kind: 'abort-lock',
        lockId: 'lock-1',
        wafEvidence: await wafEvidence(),
      }),
      recoveryContext('unused'),
    );
    expect(aborted.state.committed).toEqual(state.committed);
    expect(aborted.state.recoveryLock).toBeNull();
    expect(aborted.record.containmentRemains).toBe(true);
  });
});
