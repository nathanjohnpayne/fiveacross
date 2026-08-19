// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { projectionDigest, type RegistryState, type RouterReplicaDesired } from './contracts';
import {
  applyRecovery,
  validateSourceAudit,
  type ProviderRequestEvidence,
  type RecoveryRequest,
  type SourceAudit,
  type WafEvidence,
} from './recovery';
import { applyPublisherSync, initialRegistryState } from './state';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const NOW = Date.parse('2026-08-19T12:35:00.000Z');

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
  return {
    rayId: `ray-${index}`,
    eventAt: '2026-08-19T12:34:50.000Z',
    verifiedAt: '2026-08-19T12:34:55.000Z',
    edgeColoCode: ['SJC', 'IAD', 'LHR'][index - 1],
    host: HOST,
    path: `/__registry-probe?nonce=nonce-${index}`,
    queryDigest: String(index).repeat(64),
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
    expectedCommitted: state.committed
      ? { revision: state.committed.revision, digest: state.committed.digest }
      : null,
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
        { ...valid, canonicalProjection: { ...valid.canonicalProjection, desired: payload('1', 'poisoned').desired } },
        NOW,
      ),
    ).rejects.toThrow('source and ledger differ');
    await expect(
      validateSourceAudit(HOST, { ...valid, observedAt: '2026-08-19T12:20:00.000Z' }, NOW),
    ).rejects.toThrow('source audit is stale');
  });

  it('acquires an exact-host durable lock only with three distinct blocked provider records', async () => {
    const state = await committedState();
    const result = await applyRecovery(
      state,
      await request(state, { kind: 'acquire-lock', wafEvidence: await wafEvidence() }),
      { now: NOW, operatorSub: 'recovery-operator', lockId: 'lock-1' },
    );
    expect(result.state.recoveryLock).toMatchObject({ lockId: 'lock-1', operatorSub: 'recovery-operator' });
    expect(result.record).toMatchObject({ sequence: '1', action: 'acquire-lock' });

    const evidence = await wafEvidence();
    evidence.providerRequests[2].edgeColoCode = evidence.providerRequests[0].edgeColoCode;
    await expect(
      applyRecovery(state, await request(state, { kind: 'acquire-lock', wafEvidence: evidence }), {
        now: NOW,
        operatorSub: 'recovery-operator',
        lockId: 'lock-2',
      }),
    ).rejects.toThrow('provider colos must be distinct');
  });

  it('applies an equal repair or higher jump, records skips, and never goes backward', async () => {
    const state = await committedState();
    const acquired = await applyRecovery(
      state,
      await request(state, { kind: 'acquire-lock', wafEvidence: await wafEvidence() }),
      { now: NOW, operatorSub: 'recovery-operator', lockId: 'lock-1' },
    );
    const repairedAudit = sourceAudit('1', 'canonical-repair');
    await expect(
      applyRecovery(
        acquired.state,
        await request(acquired.state, { kind: 'apply', lockId: 'lock-1', publisherReplacement: null }, repairedAudit),
        { now: NOW, operatorSub: 'recovery-operator', lockId: 'unused' },
      ),
    ).rejects.toThrow('publisher replacement required');

    const jump = await applyRecovery(
      acquired.state,
      await request(acquired.state, { kind: 'apply', lockId: 'lock-1', publisherReplacement: null }, sourceAudit('4')),
      { now: NOW, operatorSub: 'recovery-operator', lockId: 'unused', publisherIntegrityProven: true },
    );
    expect(jump.state.committed?.revision).toBe('4');
    expect(jump.record.skippedRevisionRange).toEqual({ from: '2', to: '3' });
    expect(jump.state.recoveryLock?.lockId).toBe('lock-1');

    await expect(
      applyRecovery(
        jump.state,
        await request(jump.state, { kind: 'apply', lockId: 'lock-1', publisherReplacement: null }, sourceAudit('3')),
        { now: NOW, operatorSub: 'recovery-operator', lockId: 'unused', publisherIntegrityProven: true },
      ),
    ).rejects.toThrow('source-behind');
  });

  it('fences every quarantined epoch before activating a direct-only replacement', async () => {
    const base = { ...(await committedState()), highestAuthenticatedPublisherEpoch: '7' };
    const acquired = await applyRecovery(
      base,
      await request(base, { kind: 'acquire-lock', wafEvidence: await wafEvidence() }),
      { now: NOW, operatorSub: 'recovery-operator', lockId: 'lock-1' },
    );
    const replacement = {
      quarantinedEpochCeiling: '7',
      nextPublisherEpoch: '8',
      replacementSubject: 'replacement-subject',
      replacementKeyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/replacement/cryptoKeyVersions/1',
      replacementKeyFingerprint: 'e'.repeat(64),
      registryConfigDigest: 'f'.repeat(64),
      controlEvidence: {
        observedAt: '2026-08-19T12:34:50.000Z',
        quarantinedRuntime: { subject: 'old-subject', functionRevision: 'old-1', responseDigest: '1'.repeat(64) },
        replacementRuntime: { subject: 'replacement-subject', functionRevision: 'new-1', responseDigest: '2'.repeat(64) },
        activeEpochMappings: [{ epoch: '8', subject: 'replacement-subject', keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/replacement/cryptoKeyVersions/1', algorithm: 'RSA_SIGN_PKCS1_2048_SHA256' as const, spkiSha256: 'e'.repeat(64) }],
        keyAccess: [],
        serviceAccountAccess: [],
        quarantinedAccessDecisions: [
          { overallAccessState: 'CANNOT_ACCESS' as const },
          { overallAccessState: 'CANNOT_ACCESS' as const },
          { overallAccessState: 'CANNOT_ACCESS' as const },
        ],
        attestorSub: 'source-attestor-sub',
        attestorKeyVersion: 'source-key/1',
        attestorKeyFingerprint: 'c'.repeat(64),
        attestationIssuedAt: '2026-08-19T12:34:50.000Z',
        attestationSignature: 'signed-control-evidence',
      },
    };
    const applied = await applyRecovery(
      acquired.state,
      await request(acquired.state, { kind: 'apply', lockId: 'lock-1', publisherReplacement: replacement }, sourceAudit('2')),
      { now: NOW, operatorSub: 'recovery-operator', lockId: 'unused' },
    );
    expect(applied.state.minimumPublisherEpoch).toBe('8');
    expect(applied.state.highestQuarantinedPublisherEpoch).toBe('7');

    const invalid = structuredClone(replacement);
    invalid.controlEvidence.quarantinedAccessDecisions[1].overallAccessState = 'CAN_ACCESS' as never;
    await expect(
      applyRecovery(
        acquired.state,
        await request(acquired.state, { kind: 'apply', lockId: 'lock-1', publisherReplacement: invalid }, sourceAudit('2')),
        { now: NOW, operatorSub: 'recovery-operator', lockId: 'unused' },
      ),
    ).rejects.toThrow('CANNOT_ACCESS');
  });

  it('clears only after fresh source equals committed and three canonical records match', async () => {
    const state = await committedState();
    const acquired = await applyRecovery(
      state,
      await request(state, { kind: 'acquire-lock', wafEvidence: await wafEvidence() }),
      { now: NOW, operatorSub: 'recovery-operator', lockId: 'lock-1' },
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
      { now: NOW, operatorSub: 'recovery-operator', lockId: 'unused' },
    );
    expect(clear.state.recoveryLock).toBeNull();
    expect(clear.record.action).toBe('clear-lock');
  });

  it('aborts without mutating committed state and records that containment remains', async () => {
    const state = await committedState();
    const acquired = await applyRecovery(
      state,
      await request(state, { kind: 'acquire-lock', wafEvidence: await wafEvidence() }),
      { now: NOW, operatorSub: 'recovery-operator', lockId: 'lock-1' },
    );
    const aborted = await applyRecovery(
      acquired.state,
      await request(acquired.state, { kind: 'abort-lock', lockId: 'lock-1', wafEvidence: await wafEvidence() }),
      { now: NOW, operatorSub: 'recovery-operator', lockId: 'unused' },
    );
    expect(aborted.state.committed).toEqual(state.committed);
    expect(aborted.state.recoveryLock).toBeNull();
    expect(aborted.record.containmentRemains).toBe(true);
  });
});
