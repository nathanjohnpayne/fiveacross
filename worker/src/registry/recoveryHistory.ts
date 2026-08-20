import { parseSyncRequest } from './contracts';
import type { RecoveryRecord } from './recovery';

const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CLOUDFLARE_RESOURCE_ID = /^[a-f0-9]{32}$/;
const KMS_KEY_VERSION =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/;
const RECOVERY_PATH = /^\/__internal\/hostname-replicas\/v1\/recover(?:\?[^#]*)?$/;
const ACTIONS = new Set(['acquire-lock', 'apply', 'clear-lock', 'abort-lock']);
const ACCESS_PERMISSIONS = new Set([
  'cloudkms.cryptoKeyVersions.useToSign',
  'iam.serviceAccounts.getOpenIdToken',
  'iam.serviceAccounts.getAccessToken',
]);

export const RECOVERY_HISTORY_PREFIX = 'recovery/';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('record');
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error('keys');
  }
  return value;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('string');
  return value;
}

function positiveDecimal(value: unknown): string {
  const result = nonEmptyString(value);
  if (!POSITIVE_DECIMAL.test(result)) throw new Error('decimal');
  return result;
}

function sha256(value: unknown): string {
  const result = nonEmptyString(value);
  if (!SHA256_HEX.test(result)) throw new Error('sha256');
  return result;
}

function timestamp(value: unknown): string {
  const result = nonEmptyString(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error('timestamp');
  return result;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('integer');
  return value;
}

function exactStringArray(value: unknown, length?: number): string[] {
  if (
    !Array.isArray(value) ||
    (length !== undefined && value.length !== length) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('string array');
  }
  return value;
}

function validateCommittedRef(value: unknown): void {
  if (value === null) return;
  const reference = exactRecord(value, ['revision', 'digest']);
  positiveDecimal(reference.revision);
  sha256(reference.digest);
}

function validateSourceAudit(value: unknown): void {
  const source = exactRecord(value, [
    'revision',
    'digest',
    'observedAt',
    'canonicalProjection',
    'ledgerPayload',
    'ledgerDocumentDigest',
    'attestorSub',
    'attestorKeyVersion',
    'attestorKeyFingerprint',
    'attestationIssuedAt',
    'attestationSignature',
  ]);
  const revision = positiveDecimal(source.revision);
  sha256(source.digest);
  const observedAt = timestamp(source.observedAt);
  sha256(source.ledgerDocumentDigest);
  nonEmptyString(source.attestorSub);
  nonEmptyString(source.attestorKeyVersion);
  sha256(source.attestorKeyFingerprint);
  timestamp(source.attestationIssuedAt);
  nonEmptyString(source.attestationSignature);

  const canonical = exactRecord(source.canonicalProjection, ['sourceDocumentDigest', 'host', 'desired']);
  sha256(canonical.sourceDocumentDigest);
  const canonicalHost = nonEmptyString(canonical.host);
  const ledger = parseSyncRequest(JSON.stringify(source.ledgerPayload), 'application/json');
  parseSyncRequest(
    JSON.stringify({
      schemaVersion: 1,
      revision,
      host: canonicalHost,
      desired: canonical.desired,
      updatedAt: observedAt,
    }),
    'application/json',
  );
  if (ledger.host !== canonicalHost || ledger.revision !== revision) throw new Error('source binding');
}

function validateProviderRequest(value: unknown): void {
  const request = exactRecord(value, [
    'rayId',
    'eventAt',
    'verifiedAt',
    'edgeColoCode',
    'host',
    'path',
    'query',
    'queryDigest',
    'edgeResponseStatus',
    'httpLogResponseDigest',
    'firewall',
  ]);
  nonEmptyString(request.rayId);
  timestamp(request.eventAt);
  timestamp(request.verifiedAt);
  nonEmptyString(request.edgeColoCode);
  nonEmptyString(request.host);
  nonEmptyString(request.path);
  if (typeof request.query !== 'string') throw new Error('query');
  sha256(request.queryDigest);
  const status = integer(request.edgeResponseStatus);
  if (status < 100 || status > 599) throw new Error('status');
  sha256(request.httpLogResponseDigest);
  if (request.firewall === null) return;
  const firewall = exactRecord(request.firewall, [
    'action',
    'source',
    'ruleId',
    'ref',
    'matchIndex',
    'logResponseDigest',
  ]);
  if (firewall.action !== 'block' || firewall.source !== 'firewallcustom' || firewall.matchIndex !== 0) {
    throw new Error('firewall');
  }
  nonEmptyString(firewall.ruleId);
  nonEmptyString(firewall.ref);
  sha256(firewall.logResponseDigest);
}

function validateWafEvidence(value: unknown): void {
  const waf = exactRecord(value, [
    'zoneId',
    'rulesetId',
    'ruleId',
    'host',
    'verifiedAt',
    'blockNonce',
    'providerRule',
    'probeAttestationIds',
    'providerRequests',
  ]);
  for (const resource of [waf.zoneId, waf.rulesetId, waf.ruleId]) {
    if (typeof resource !== 'string' || !CLOUDFLARE_RESOURCE_ID.test(resource)) throw new Error('resource id');
  }
  nonEmptyString(waf.host);
  timestamp(waf.verifiedAt);
  nonEmptyString(waf.blockNonce);
  const providerRule = exactRecord(waf.providerRule, [
    'enabled',
    'action',
    'expression',
    'ref',
    'customResponseBodyDigest',
    'responseDigest',
  ]);
  if (providerRule.enabled !== true || providerRule.action !== 'block') throw new Error('provider rule');
  nonEmptyString(providerRule.expression);
  nonEmptyString(providerRule.ref);
  sha256(providerRule.customResponseBodyDigest);
  sha256(providerRule.responseDigest);
  exactStringArray(waf.probeAttestationIds, 3).forEach(nonEmptyString);
  if (!Array.isArray(waf.providerRequests) || waf.providerRequests.length !== 3) throw new Error('provider requests');
  waf.providerRequests.forEach(validateProviderRequest);
}

function validatePublisherRuntime(value: unknown): void {
  const runtime = exactRecord(value, [
    'subject',
    'serviceAccountEmail',
    'iamMember',
    'functionFullResourceName',
    'functionRevision',
    'responseDigest',
  ]);
  for (const field of [
    runtime.subject,
    runtime.serviceAccountEmail,
    runtime.iamMember,
    runtime.functionFullResourceName,
    runtime.functionRevision,
  ]) {
    nonEmptyString(field);
  }
  sha256(runtime.responseDigest);
}

function validatePublisherReplacement(value: unknown): void {
  if (value === null) return;
  const replacement = exactRecord(value, [
    'quarantinedEpochCeiling',
    'nextPublisherEpoch',
    'replacementSubject',
    'replacementKeyVersion',
    'replacementKeyFingerprint',
    'registryConfigDigest',
    'controlEvidence',
  ]);
  positiveDecimal(replacement.quarantinedEpochCeiling);
  positiveDecimal(replacement.nextPublisherEpoch);
  nonEmptyString(replacement.replacementSubject);
  nonEmptyString(replacement.replacementKeyVersion);
  sha256(replacement.replacementKeyFingerprint);
  sha256(replacement.registryConfigDigest);

  const control = exactRecord(replacement.controlEvidence, [
    'observedAt',
    'quarantinedRuntime',
    'replacementRuntime',
    'activeEpochMappings',
    'keyAccess',
    'serviceAccountAccess',
    'quarantinedAccessDecisions',
    'attestorSub',
    'attestorKeyVersion',
    'attestorKeyFingerprint',
    'attestationIssuedAt',
    'attestationSignature',
  ]);
  timestamp(control.observedAt);
  validatePublisherRuntime(control.quarantinedRuntime);
  validatePublisherRuntime(control.replacementRuntime);
  if (!Array.isArray(control.activeEpochMappings) || control.activeEpochMappings.length === 0) {
    throw new Error('publisher mappings');
  }
  control.activeEpochMappings.forEach((entry) => {
    const mapping = exactRecord(entry, ['epoch', 'subject', 'keyVersion', 'algorithm', 'spkiSha256']);
    positiveDecimal(mapping.epoch);
    nonEmptyString(mapping.subject);
    nonEmptyString(mapping.keyVersion);
    if (mapping.algorithm !== 'RSA_SIGN_PKCS1_2048_SHA256') throw new Error('algorithm');
    sha256(mapping.spkiSha256);
  });
  if (!Array.isArray(control.keyAccess) || control.keyAccess.length !== 2) throw new Error('key access');
  control.keyAccess.forEach((entry) => {
    const access = exactRecord(entry, [
      'cryptoKey',
      'policyEtag',
      'signMembers',
      'enabledVersions',
      'responseDigest',
    ]);
    nonEmptyString(access.cryptoKey);
    nonEmptyString(access.policyEtag);
    exactStringArray(access.signMembers).forEach(nonEmptyString);
    if (!Array.isArray(access.enabledVersions)) throw new Error('enabled versions');
    access.enabledVersions.forEach((entry) => {
      const version = exactRecord(entry, ['keyVersion', 'algorithm', 'spkiSha256']);
      nonEmptyString(version.keyVersion);
      if (version.algorithm !== 'RSA_SIGN_PKCS1_2048_SHA256') throw new Error('algorithm');
      sha256(version.spkiSha256);
    });
    sha256(access.responseDigest);
  });
  if (!Array.isArray(control.serviceAccountAccess) || control.serviceAccountAccess.length !== 2) {
    throw new Error('service account access');
  }
  control.serviceAccountAccess.forEach((entry) => {
    const access = exactRecord(entry, [
      'subject',
      'serviceAccountEmail',
      'iamMember',
      'fullResourceName',
      'policyEtag',
      'tokenCreatorMembers',
      'responseDigest',
    ]);
    for (const field of [
      access.subject,
      access.serviceAccountEmail,
      access.iamMember,
      access.fullResourceName,
      access.policyEtag,
    ]) {
      nonEmptyString(field);
    }
    exactStringArray(access.tokenCreatorMembers).forEach(nonEmptyString);
    sha256(access.responseDigest);
  });
  if (!Array.isArray(control.quarantinedAccessDecisions) || control.quarantinedAccessDecisions.length !== 3) {
    throw new Error('access decisions');
  }
  control.quarantinedAccessDecisions.forEach((entry) => {
    const decision = exactRecord(entry, [
      'principal',
      'fullResourceName',
      'permission',
      'requestTime',
      'overallAccessState',
      'inheritedPoliciesComplete',
      'responseDigest',
    ]);
    nonEmptyString(decision.principal);
    nonEmptyString(decision.fullResourceName);
    if (typeof decision.permission !== 'string' || !ACCESS_PERMISSIONS.has(decision.permission)) {
      throw new Error('permission');
    }
    timestamp(decision.requestTime);
    if (decision.overallAccessState !== 'CANNOT_ACCESS' || decision.inheritedPoliciesComplete !== true) {
      throw new Error('access decision');
    }
    sha256(decision.responseDigest);
  });
  nonEmptyString(control.attestorSub);
  nonEmptyString(control.attestorKeyVersion);
  sha256(control.attestorKeyFingerprint);
  timestamp(control.attestationIssuedAt);
  nonEmptyString(control.attestationSignature);
}

function validateAction(value: unknown): string {
  if (!isRecord(value) || typeof value.kind !== 'string' || !ACTIONS.has(value.kind)) throw new Error('action');
  if (value.kind === 'acquire-lock') {
    const action = exactRecord(value, ['kind', 'wafEvidence']);
    validateWafEvidence(action.wafEvidence);
  } else if (value.kind === 'abort-lock') {
    const action = exactRecord(value, ['kind', 'lockId', 'wafEvidence']);
    nonEmptyString(action.lockId);
    validateWafEvidence(action.wafEvidence);
  } else if (value.kind === 'apply') {
    const action = exactRecord(value, ['kind', 'lockId', 'publisherReplacement']);
    nonEmptyString(action.lockId);
    validatePublisherReplacement(action.publisherReplacement);
  } else {
    const action = exactRecord(value, [
      'kind',
      'lockId',
      'wafRemovedAt',
      'probeAttestationIds',
      'providerRequests',
    ]);
    nonEmptyString(action.lockId);
    timestamp(action.wafRemovedAt);
    exactStringArray(action.probeAttestationIds, 3).forEach(nonEmptyString);
    if (!Array.isArray(action.providerRequests) || action.providerRequests.length !== 3) {
      throw new Error('provider requests');
    }
    action.providerRequests.forEach(validateProviderRequest);
  }
  return value.kind;
}

function validateProbeChallenge(value: unknown): Record<string, unknown> {
  const challenge = exactRecord(value, [
    'probeNonce',
    'subject',
    'keyVersion',
    'keyFingerprint',
    'region',
    'host',
    'expectedStateDigest',
    'issuedAt',
    'expiresAt',
    'consumed',
    'phase',
    'recoveryLockId',
    'recoverySequence',
    'wafRemovedAt',
  ]);
  for (const field of [
    challenge.probeNonce,
    challenge.subject,
    challenge.keyVersion,
    challenge.region,
    challenge.host,
  ]) {
    nonEmptyString(field);
  }
  sha256(challenge.keyFingerprint);
  sha256(challenge.expectedStateDigest);
  integer(challenge.issuedAt);
  integer(challenge.expiresAt);
  if (challenge.consumed !== true) throw new Error('unconsumed probe');
  if (challenge.phase === 'blocked-before-worker') {
    if (
      challenge.recoveryLockId !== null ||
      challenge.recoverySequence !== null ||
      challenge.wafRemovedAt !== null
    ) {
      throw new Error('blocked challenge');
    }
  } else if (challenge.phase === 'canonical-after-unblock') {
    nonEmptyString(challenge.recoveryLockId);
    positiveDecimal(challenge.recoverySequence);
    timestamp(challenge.wafRemovedAt);
  } else {
    throw new Error('probe phase');
  }
  return challenge;
}

function validateProbeObservation(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.phase !== 'string') throw new Error('observation');
  const common = ['phase', 'probeNonce', 'observedAt', 'rayId', 'host', 'requestPath'];
  const observation =
    value.phase === 'blocked-before-worker'
      ? exactRecord(value, [
          ...common,
          'expectedStatus',
          'observedStatus',
          'expectedBlockBodyDigest',
          'observedBlockBodyDigest',
        ])
      : value.phase === 'canonical-after-unblock'
        ? exactRecord(value, [
            ...common,
            'expectedStatus',
            'observedStatus',
            'expectedReason',
            'observedReason',
            'expectedRevision',
            'observedRevision',
            'expectedServesOrigin',
            'observedServesOrigin',
            'originRequestId',
          ])
        : (() => {
            throw new Error('observation phase');
          })();
  for (const field of [
    observation.probeNonce,
    observation.rayId,
    observation.host,
    observation.requestPath,
  ]) {
    nonEmptyString(field);
  }
  timestamp(observation.observedAt);
  const expectedStatus = integer(observation.expectedStatus);
  const observedStatus = integer(observation.observedStatus);
  if (expectedStatus < 100 || expectedStatus > 599 || observedStatus < 100 || observedStatus > 599) {
    throw new Error('status');
  }
  if (observation.phase === 'blocked-before-worker') {
    if (expectedStatus !== 403 || observedStatus !== 403) throw new Error('blocked status');
    sha256(observation.expectedBlockBodyDigest);
    sha256(observation.observedBlockBodyDigest);
  } else {
    const reasons = new Set([null, 'inactive', 'unknown-host']);
    if (!reasons.has(observation.expectedReason as null | string) || !reasons.has(observation.observedReason as null | string)) {
      throw new Error('reason');
    }
    positiveDecimal(observation.expectedRevision);
    positiveDecimal(observation.observedRevision);
    if (typeof observation.expectedServesOrigin !== 'boolean' || typeof observation.observedServesOrigin !== 'boolean') {
      throw new Error('serves origin');
    }
    if (observation.originRequestId !== null) nonEmptyString(observation.originRequestId);
  }
  return observation;
}

function validateProbeEvidence(value: unknown): void {
  const evidence = exactRecord(value, [
    'id',
    'receivedAt',
    'subject',
    'keyVersion',
    'keyFingerprint',
    'region',
    'challenge',
    'observation',
  ]);
  nonEmptyString(evidence.id);
  timestamp(evidence.receivedAt);
  nonEmptyString(evidence.subject);
  nonEmptyString(evidence.keyVersion);
  sha256(evidence.keyFingerprint);
  nonEmptyString(evidence.region);
  const challenge = validateProbeChallenge(evidence.challenge);
  const observation = validateProbeObservation(evidence.observation);
  if (
    evidence.subject !== challenge.subject ||
    evidence.keyVersion !== challenge.keyVersion ||
    evidence.keyFingerprint !== challenge.keyFingerprint ||
    evidence.region !== challenge.region ||
    challenge.phase !== observation.phase ||
    challenge.probeNonce !== observation.probeNonce ||
    challenge.host !== observation.host
  ) {
    throw new Error('probe binding');
  }
}

function validateSkippedRange(value: unknown): void {
  if (value === null) return;
  const range = exactRecord(value, ['from', 'to']);
  const from = positiveDecimal(range.from);
  const to = positiveDecimal(range.to);
  if (BigInt(from) > BigInt(to)) throw new Error('skipped range');
}

export function recoveryHistoryKey(sequence: string): string {
  if (!NON_NEGATIVE_DECIMAL.test(sequence)) throw new Error('recovery history malformed');
  return `${RECOVERY_HISTORY_PREFIX}${sequence.length.toString().padStart(6, '0')}:${sequence}`;
}

export function parseRecoveryHistoryEntry(storageKey: string, value: unknown): RecoveryRecord {
  try {
    const record = exactRecord(value, [
      'sequence',
      'action',
      'at',
      'before',
      'after',
      'skippedRevisionRange',
      'sourceAudit',
      'evidence',
      'probeEvidence',
      'operatorSub',
      'operatorKeyVersion',
      'operatorKeyFingerprint',
      'operatorSignature',
      'operatorSignatureScheme',
      'operatorSignedRole',
      'operatorSignedMethod',
      'operatorSignedPath',
      'operatorIssuedAt',
      'requestBodyDigest',
      'incidentUrl',
      'reason',
      'containmentRemains',
    ]);
    const sequence = positiveDecimal(record.sequence);
    if (storageKey !== recoveryHistoryKey(sequence)) throw new Error('storage key');
    if (typeof record.action !== 'string' || !ACTIONS.has(record.action)) throw new Error('action');
    timestamp(record.at);
    validateCommittedRef(record.before);
    validateCommittedRef(record.after);
    validateSkippedRange(record.skippedRevisionRange);
    validateSourceAudit(record.sourceAudit);
    if (validateAction(record.evidence) !== record.action) throw new Error('action binding');
    if (!Array.isArray(record.probeEvidence)) throw new Error('probe evidence');
    const expectedProbeCount = record.action === 'apply' ? 0 : 3;
    if (record.probeEvidence.length !== expectedProbeCount) throw new Error('probe evidence count');
    record.probeEvidence.forEach(validateProbeEvidence);
    nonEmptyString(record.operatorSub);
    if (typeof record.operatorKeyVersion !== 'string' || !KMS_KEY_VERSION.test(record.operatorKeyVersion)) {
      throw new Error('operator key');
    }
    sha256(record.operatorKeyFingerprint);
    nonEmptyString(record.operatorSignature);
    if (
      record.operatorSignatureScheme !== 'v1' ||
      record.operatorSignedRole !== 'recovery' ||
      record.operatorSignedMethod !== 'POST' ||
      typeof record.operatorSignedPath !== 'string' ||
      !RECOVERY_PATH.test(record.operatorSignedPath)
    ) {
      throw new Error('operator provenance');
    }
    positiveDecimal(record.operatorIssuedAt);
    sha256(record.requestBodyDigest);
    const incident = new URL(nonEmptyString(record.incidentUrl));
    if (incident.protocol !== 'https:') throw new Error('incident');
    if (nonEmptyString(record.reason).trim().length === 0) throw new Error('reason');
    if (typeof record.containmentRemains !== 'boolean') throw new Error('containment');
    if (record.containmentRemains !== (record.action === 'abort-lock')) throw new Error('containment binding');
    return value as RecoveryRecord;
  } catch {
    throw new Error('recovery history malformed');
  }
}
