import {
  projectionDigest,
  type CommittedReplica,
  type RegistryState,
  type ReplicaDesired,
  type RouterReplicaDesired,
} from './contracts';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const MAX_SOURCE_AGE_MS = 5 * 60_000;
const MAX_ATTESTATION_AGE_MS = 60_000;

export type CommittedRef = null | { revision: string; digest: string };

export type SourceAudit = {
  revision: string;
  digest: string;
  observedAt: string;
  canonicalProjection: {
    sourceDocumentDigest: string;
    host: string;
    desired: ReplicaDesired;
  };
  ledgerPayload: RouterReplicaDesired;
  ledgerDocumentDigest: string;
  attestorSub: string;
  attestorKeyVersion: string;
  attestorKeyFingerprint: string;
  attestationIssuedAt: string;
  attestationSignature: string;
};

export type ProviderRequestEvidence = {
  rayId: string;
  eventAt: string;
  verifiedAt: string;
  edgeColoCode: string;
  host: string;
  path: string;
  queryDigest: string;
  edgeResponseStatus: number;
  httpLogResponseDigest: string;
  firewall: null | {
    action: 'block';
    source: 'firewallcustom';
    ruleId: string;
    ref: string;
    matchIndex: 0;
    logResponseDigest: string;
  };
};

export type WafEvidence = {
  zoneId: string;
  rulesetId: string;
  ruleId: string;
  host: string;
  verifiedAt: string;
  blockNonce: string;
  providerRule: {
    enabled: true;
    action: 'block';
    expression: string;
    ref: string;
    customResponseBodyDigest: string;
    responseDigest: string;
  };
  probeAttestationIds: [string, string, string];
  providerRequests: [ProviderRequestEvidence, ProviderRequestEvidence, ProviderRequestEvidence];
};

type PublisherControlEvidence = {
  observedAt: string;
  quarantinedRuntime: { subject: string; functionRevision: string; responseDigest: string };
  replacementRuntime: { subject: string; functionRevision: string; responseDigest: string };
  activeEpochMappings: Array<{
    epoch: string;
    subject: string;
    keyVersion: string;
    algorithm: 'RSA_SIGN_PKCS1_2048_SHA256';
    spkiSha256: string;
  }>;
  keyAccess: unknown[];
  serviceAccountAccess: unknown[];
  quarantinedAccessDecisions: Array<{ overallAccessState: 'CANNOT_ACCESS' }>;
  attestorSub: string;
  attestorKeyVersion: string;
  attestorKeyFingerprint: string;
  attestationIssuedAt: string;
  attestationSignature: string;
};

export type PublisherReplacement = null | {
  quarantinedEpochCeiling: string;
  nextPublisherEpoch: string;
  replacementSubject: string;
  replacementKeyVersion: string;
  replacementKeyFingerprint: string;
  registryConfigDigest: string;
  controlEvidence: PublisherControlEvidence;
};

export type RecoveryRequest = {
  schemaVersion: 1;
  host: string;
  expectedCommitted: CommittedRef;
  sourceAudit: SourceAudit;
  action:
    | { kind: 'acquire-lock'; wafEvidence: WafEvidence }
    | { kind: 'apply'; lockId: string; publisherReplacement: PublisherReplacement }
    | {
        kind: 'clear-lock';
        lockId: string;
        wafRemovedAt: string;
        probeAttestationIds: [string, string, string];
        providerRequests: [ProviderRequestEvidence, ProviderRequestEvidence, ProviderRequestEvidence];
      }
    | { kind: 'abort-lock'; lockId: string; wafEvidence: WafEvidence };
  incidentUrl: string;
  reason: string;
};

export type RecoveryRecord = {
  sequence: string;
  action: RecoveryRequest['action']['kind'];
  at: string;
  before: CommittedRef;
  after: CommittedRef;
  skippedRevisionRange: null | { from: string; to: string };
  sourceAudit: SourceAudit;
  evidence: RecoveryRequest['action'];
  operatorSub: string;
  incidentUrl: string;
  reason: string;
  containmentRemains: boolean;
};

export type RecoveryContext = {
  now: number;
  operatorSub: string;
  lockId: string;
  publisherIntegrityProven?: boolean;
  consumeAttestations?: (ids: readonly string[], phase: 'blocked' | 'canonical') => Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
  );
}

function requireFresh(timestamp: string, now: number, maximumAge: number, label: string): void {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || parsed > now) throw new Error(`${label} is future or malformed`);
  if (now - parsed > maximumAge) throw new Error(`${label} is stale`);
}

function committedRef(committed: CommittedReplica | null): CommittedRef {
  return committed === null ? null : { revision: committed.revision, digest: committed.digest };
}

function sameCommitted(left: CommittedRef, right: CommittedRef): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.revision === right.revision &&
      left.digest === right.digest)
  );
}

function maxDecimal(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateSourceAudit(
  host: string,
  audit: SourceAudit,
  now: number,
): Promise<RouterReplicaDesired> {
  requireFresh(audit.observedAt, now, MAX_SOURCE_AGE_MS, 'source audit');
  requireFresh(audit.attestationIssuedAt, now, MAX_ATTESTATION_AGE_MS, 'source attestation');
  if (!POSITIVE_DECIMAL.test(audit.revision) || !SHA256_HEX.test(audit.digest)) {
    throw new Error('source revision or digest malformed');
  }
  if (
    audit.canonicalProjection.host !== host ||
    audit.ledgerPayload.host !== host ||
    audit.ledgerPayload.revision !== audit.revision
  ) {
    throw new Error('source audit host or revision mismatch');
  }
  if (
    !SHA256_HEX.test(audit.canonicalProjection.sourceDocumentDigest) ||
    !SHA256_HEX.test(audit.ledgerDocumentDigest) ||
    !SHA256_HEX.test(audit.attestorKeyFingerprint)
  ) {
    throw new Error('source document or attestor fingerprint malformed');
  }
  if (!deepEqual(audit.canonicalProjection.desired, audit.ledgerPayload.desired)) {
    throw new Error('source and ledger differ');
  }
  if ((await projectionDigest(audit.ledgerPayload)) !== audit.digest) {
    throw new Error('source ledger digest mismatch');
  }
  if (
    audit.attestorSub.length === 0 ||
    audit.attestorKeyVersion.length === 0 ||
    audit.attestationSignature.length === 0
  ) {
    throw new Error('source attestation identity is incomplete');
  }
  return audit.ledgerPayload;
}

function validateRecoveryEnvelope(request: RecoveryRequest): void {
  if (request.schemaVersion !== 1 || request.host.length === 0) {
    throw new Error('recovery request malformed');
  }
  let incident: URL;
  try {
    incident = new URL(request.incidentUrl);
  } catch {
    throw new Error('incidentUrl must be HTTPS');
  }
  if (incident.protocol !== 'https:' || request.reason.trim().length === 0) {
    throw new Error('incidentUrl must be HTTPS and reason is required');
  }
}

function validateProviderRequests(
  host: string,
  requests: readonly ProviderRequestEvidence[],
  blocked: boolean,
  now: number,
  waf?: WafEvidence,
): void {
  if (requests.length !== 3) throw new Error('exactly three provider requests required');
  const rays = new Set<string>();
  const colos = new Set<string>();
  for (const request of requests) {
    requireFresh(request.eventAt, now, MAX_SOURCE_AGE_MS, 'provider event');
    requireFresh(request.verifiedAt, now, MAX_SOURCE_AGE_MS, 'provider verification');
    if (request.host !== host || request.rayId.length === 0 || request.edgeColoCode.length === 0) {
      throw new Error('provider request host or identity mismatch');
    }
    if (!SHA256_HEX.test(request.queryDigest) || !SHA256_HEX.test(request.httpLogResponseDigest)) {
      throw new Error('provider response digest malformed');
    }
    rays.add(request.rayId);
    colos.add(request.edgeColoCode);
    if (blocked) {
      if (
        request.edgeResponseStatus !== 403 ||
        request.firewall === null ||
        request.firewall.action !== 'block' ||
        request.firewall.source !== 'firewallcustom' ||
        request.firewall.matchIndex !== 0 ||
        request.firewall.ruleId !== waf?.ruleId ||
        request.firewall.ref !== waf.providerRule.ref ||
        !SHA256_HEX.test(request.firewall.logResponseDigest)
      ) {
        throw new Error('blocked provider request does not match exact WAF rule');
      }
    } else if (request.firewall !== null) {
      throw new Error('canonical provider request must not include a firewall event');
    }
  }
  if (rays.size !== 3) throw new Error('provider Ray IDs must be distinct');
  if (colos.size !== 3) throw new Error('provider colos must be distinct');
}

async function validateWafEvidence(host: string, evidence: WafEvidence, now: number): Promise<void> {
  requireFresh(evidence.verifiedAt, now, MAX_SOURCE_AGE_MS, 'WAF verification');
  if (
    evidence.host !== host ||
    evidence.ruleId.length === 0 ||
    evidence.providerRule.enabled !== true ||
    evidence.providerRule.action !== 'block' ||
    evidence.providerRule.expression !== `http.host eq "${host}"` ||
    evidence.providerRule.ref.length === 0 ||
    evidence.blockNonce.length === 0 ||
    !SHA256_HEX.test(evidence.providerRule.responseDigest)
  ) {
    throw new Error('WAF rule is not the exact-host recovery rule');
  }
  const bodyDigest = await sha256Hex(JSON.stringify({ recoveryBlock: evidence.blockNonce }));
  if (bodyDigest !== evidence.providerRule.customResponseBodyDigest) {
    throw new Error('WAF block response digest mismatch');
  }
  if (new Set(evidence.probeAttestationIds).size !== 3) {
    throw new Error('probe attestations must be distinct');
  }
  validateProviderRequests(host, evidence.providerRequests, true, now, evidence);
}

function validateReplacement(
  state: RegistryState,
  replacement: NonNullable<PublisherReplacement>,
  now: number,
): void {
  if (
    !POSITIVE_DECIMAL.test(replacement.quarantinedEpochCeiling) ||
    !POSITIVE_DECIMAL.test(replacement.nextPublisherEpoch) ||
    !SHA256_HEX.test(replacement.replacementKeyFingerprint) ||
    !SHA256_HEX.test(replacement.registryConfigDigest)
  ) {
    throw new Error('publisher replacement mapping malformed');
  }
  const ceiling = BigInt(replacement.quarantinedEpochCeiling);
  if (
    ceiling < BigInt(state.highestAuthenticatedPublisherEpoch) ||
    ceiling < BigInt(state.highestQuarantinedPublisherEpoch) ||
    BigInt(replacement.nextPublisherEpoch) <= ceiling
  ) {
    throw new Error('publisher replacement does not fence quarantined epochs');
  }
  const control = replacement.controlEvidence;
  requireFresh(control.observedAt, now, MAX_SOURCE_AGE_MS, 'publisher control evidence');
  requireFresh(control.attestationIssuedAt, now, MAX_ATTESTATION_AGE_MS, 'publisher control attestation');
  if (control.activeEpochMappings.length > 16) throw new Error('too many active epoch mappings');
  const mapping = control.activeEpochMappings.find(
    (candidate) => candidate.epoch === replacement.nextPublisherEpoch,
  );
  if (
    mapping === undefined ||
    mapping.subject !== replacement.replacementSubject ||
    mapping.keyVersion !== replacement.replacementKeyVersion ||
    mapping.spkiSha256 !== replacement.replacementKeyFingerprint ||
    control.replacementRuntime.subject !== replacement.replacementSubject
  ) {
    throw new Error('replacement runtime and active mapping differ');
  }
  if (
    control.quarantinedAccessDecisions.length !== 3 ||
    control.quarantinedAccessDecisions.some(
      (decision) => decision.overallAccessState !== 'CANNOT_ACCESS',
    )
  ) {
    throw new Error('all publisher quarantine decisions must be CANNOT_ACCESS');
  }
  if (control.keyAccess.length > 16 || control.serviceAccountAccess.length > 16) {
    throw new Error('publisher control evidence is oversized');
  }
  if (
    control.attestorSub.length === 0 ||
    control.attestorKeyVersion.length === 0 ||
    !SHA256_HEX.test(control.attestorKeyFingerprint) ||
    control.attestationSignature.length === 0
  ) {
    throw new Error('publisher control attestation is incomplete');
  }
}

function nextSequence(state: RegistryState): string {
  return (BigInt(state.recoverySequence) + 1n).toString();
}

function skippedRange(before: CommittedRef, afterRevision: string): RecoveryRecord['skippedRevisionRange'] {
  if (before === null) {
    return BigInt(afterRevision) > 1n ? { from: '1', to: (BigInt(afterRevision) - 1n).toString() } : null;
  }
  const first = BigInt(before.revision) + 1n;
  const last = BigInt(afterRevision) - 1n;
  return last >= first ? { from: first.toString(), to: last.toString() } : null;
}

export async function applyRecovery(
  state: RegistryState,
  request: RecoveryRequest,
  context: RecoveryContext,
): Promise<{ state: RegistryState; record: RecoveryRecord }> {
  validateRecoveryEnvelope(request);
  const ledgerPayload = await validateSourceAudit(request.host, request.sourceAudit, context.now);
  const before = committedRef(state.committed);
  if (!sameCommitted(before, request.expectedCommitted)) throw new Error('committed-state CAS failed');

  const sequence = nextSequence(state);
  let nextState: RegistryState = state;
  let skippedRevisionRange: RecoveryRecord['skippedRevisionRange'] = null;
  let containmentRemains = false;

  if (request.action.kind === 'acquire-lock') {
    if (state.recoveryLock !== null) throw new Error('recovery lock already held');
    await validateWafEvidence(request.host, request.action.wafEvidence, context.now);
    await context.consumeAttestations?.(request.action.wafEvidence.probeAttestationIds, 'blocked');
    nextState = {
      ...state,
      recoverySequence: sequence,
      recoveryLock: {
        lockId: context.lockId,
        acquiredAt: new Date(context.now).toISOString(),
        expectedCommitted: before,
        operatorSub: context.operatorSub,
        incidentUrl: request.incidentUrl,
        reason: request.reason,
      },
    };
  } else {
    const lock = state.recoveryLock;
    if (lock === null || lock.lockId !== request.action.lockId) {
      throw new Error('current recovery lock required');
    }

    if (request.action.kind === 'apply') {
      const sourceRevision = BigInt(ledgerPayload.revision);
      const currentRevision = state.committed === null ? 0n : BigInt(state.committed.revision);
      if (sourceRevision < currentRevision) throw new Error('source-behind');
      const digest = await projectionDigest(ledgerPayload);
      const equalRepair = sourceRevision === currentRevision && state.committed?.digest !== digest;
      if ((equalRepair || context.publisherIntegrityProven !== true) && request.action.publisherReplacement === null) {
        throw new Error('publisher replacement required');
      }
      let epochState = state;
      if (request.action.publisherReplacement !== null) {
        validateReplacement(state, request.action.publisherReplacement, context.now);
        epochState = {
          ...state,
          highestQuarantinedPublisherEpoch: maxDecimal(
            state.highestQuarantinedPublisherEpoch,
            request.action.publisherReplacement.quarantinedEpochCeiling,
          ),
          minimumPublisherEpoch: request.action.publisherReplacement.nextPublisherEpoch,
        };
      }
      skippedRevisionRange = skippedRange(before, ledgerPayload.revision);
      nextState = {
        ...epochState,
        recoverySequence: sequence,
        committed: { revision: ledgerPayload.revision, digest, payload: ledgerPayload },
      };
    } else if (request.action.kind === 'clear-lock') {
      if (!sameCommitted(before, { revision: ledgerPayload.revision, digest: request.sourceAudit.digest })) {
        throw new Error('fresh source must equal committed state before clear');
      }
      if (new Set(request.action.probeAttestationIds).size !== 3) {
        throw new Error('probe attestations must be distinct');
      }
      validateProviderRequests(request.host, request.action.providerRequests, false, context.now);
      await context.consumeAttestations?.(request.action.probeAttestationIds, 'canonical');
      nextState = { ...state, recoverySequence: sequence, recoveryLock: null };
    } else {
      if (!sameCommitted(before, { revision: ledgerPayload.revision, digest: request.sourceAudit.digest })) {
        throw new Error('fresh source must equal committed state before abort');
      }
      await validateWafEvidence(request.host, request.action.wafEvidence, context.now);
      await context.consumeAttestations?.(request.action.wafEvidence.probeAttestationIds, 'blocked');
      containmentRemains = true;
      nextState = { ...state, recoverySequence: sequence, recoveryLock: null };
    }
  }

  const after = committedRef(nextState.committed);
  return {
    state: nextState,
    record: {
      sequence,
      action: request.action.kind,
      at: new Date(context.now).toISOString(),
      before,
      after,
      skippedRevisionRange,
      sourceAudit: request.sourceAudit,
      evidence: request.action,
      operatorSub: context.operatorSub,
      incidentUrl: request.incidentUrl,
      reason: request.reason,
      containmentRemains,
    },
  };
}
