import { parseSyncRequest, projectionDigest } from './contracts';
import type { ConsumedProbeEvidence } from './probe';
import type {
  ProviderRequestEvidence,
  PublisherReplacement,
  RecoveryRecord,
  RecoveryRequest,
  SourceAudit,
  WafEvidence,
} from './recovery';

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

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

async function validateSourceAudit(value: unknown, expectedHost: string): Promise<SourceAudit> {
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
  if (canonicalHost !== expectedHost) throw new Error('source host');
  const ledger = parseSyncRequest(JSON.stringify(source.ledgerPayload), 'application/json');
  const canonicalPayload = parseSyncRequest(
    JSON.stringify({
      schemaVersion: 1,
      revision,
      host: canonicalHost,
      desired: canonical.desired,
      updatedAt: observedAt,
    }),
    'application/json',
  );
  if (
    ledger.host !== canonicalHost ||
    ledger.revision !== revision ||
    JSON.stringify(ledger.desired) !== JSON.stringify(canonicalPayload.desired)
  ) {
    throw new Error('source binding');
  }
  if ((await projectionDigest(ledger)) !== source.digest) throw new Error('source digest');
  return value as SourceAudit;
}

async function validateProviderRequest(value: unknown, expectedHost: string): Promise<ProviderRequestEvidence> {
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
  if (nonEmptyString(request.host) !== expectedHost) throw new Error('provider host');
  const path = nonEmptyString(request.path);
  if (typeof request.query !== 'string') throw new Error('query');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
    throw new Error('path');
  }
  if (request.query.startsWith('?') || request.query.includes('#')) throw new Error('query');
  const queryDigest = sha256(request.queryDigest);
  if ((await sha256Hex(request.query)) !== queryDigest) throw new Error('query digest');
  const status = integer(request.edgeResponseStatus);
  if (status < 100 || status > 599) throw new Error('status');
  sha256(request.httpLogResponseDigest);
  if (request.firewall === null) return value as ProviderRequestEvidence;
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
  return value as ProviderRequestEvidence;
}

async function validateWafEvidence(value: unknown, expectedHost: string): Promise<WafEvidence> {
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
  if (nonEmptyString(waf.host) !== expectedHost) throw new Error('WAF host');
  timestamp(waf.verifiedAt);
  const blockNonce = nonEmptyString(waf.blockNonce);
  const providerRule = exactRecord(waf.providerRule, [
    'enabled',
    'action',
    'expression',
    'ref',
    'customResponseBodyDigest',
    'responseDigest',
  ]);
  if (
    providerRule.enabled !== true ||
    providerRule.action !== 'block' ||
    providerRule.expression !== `http.host eq "${expectedHost}"`
  ) {
    throw new Error('provider rule');
  }
  const providerRef = nonEmptyString(providerRule.ref);
  const customResponseBodyDigest = sha256(providerRule.customResponseBodyDigest);
  if ((await sha256Hex(JSON.stringify({ recoveryBlock: blockNonce }))) !== customResponseBodyDigest) {
    throw new Error('WAF body digest');
  }
  sha256(providerRule.responseDigest);
  const probeAttestationIds = exactStringArray(waf.probeAttestationIds, 3).map(nonEmptyString);
  if (new Set(probeAttestationIds).size !== 3) throw new Error('probe IDs');
  if (!Array.isArray(waf.providerRequests) || waf.providerRequests.length !== 3) throw new Error('provider requests');
  const providerRequests = await Promise.all(
    waf.providerRequests.map((request) => validateProviderRequest(request, expectedHost)),
  );
  if (
    providerRequests.some(
      (request) =>
        request.edgeResponseStatus !== 403 ||
        request.firewall === null ||
        request.firewall.ruleId !== waf.ruleId ||
        request.firewall.ref !== providerRef,
    )
  ) {
    throw new Error('WAF provider binding');
  }
  return value as WafEvidence;
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

  const typed = value as NonNullable<PublisherReplacement>;
  const typedControl = typed.controlEvidence;
  const quarantinedRuntime = typedControl.quarantinedRuntime;
  const replacementRuntime = typedControl.replacementRuntime;
  const keyResource = (keyVersion: string) => keyVersion.replace(/\/cryptoKeyVersions\/[1-9]\d*$/, '');
  const canonicalServiceAccountResource = (email: string): string | null => {
    const suffix = '.iam.gserviceaccount.com';
    const at = email.indexOf('@');
    const domain = at === -1 ? '' : email.slice(at + 1);
    const project = domain.endsWith(suffix) ? domain.slice(0, -suffix.length) : '';
    return at > 0 && project.length > 0 ? `//iam.googleapis.com/projects/${project}/serviceAccounts/${email}` : null;
  };
  const runtimeIsCanonical = (runtime: typeof quarantinedRuntime) =>
    POSITIVE_DECIMAL.test(runtime.subject) &&
    runtime.iamMember === `serviceAccount:${runtime.serviceAccountEmail}` &&
    /^\/\/cloudfunctions\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/functions\/[^/]+$/.test(
      runtime.functionFullResourceName,
    );
  const ceiling = BigInt(typed.quarantinedEpochCeiling);
  if (
    BigInt(typed.nextPublisherEpoch) <= ceiling ||
    !runtimeIsCanonical(quarantinedRuntime) ||
    !runtimeIsCanonical(replacementRuntime) ||
    quarantinedRuntime.subject === replacementRuntime.subject ||
    quarantinedRuntime.serviceAccountEmail === replacementRuntime.serviceAccountEmail ||
    quarantinedRuntime.functionFullResourceName === replacementRuntime.functionFullResourceName ||
    typed.replacementSubject !== replacementRuntime.subject
  ) {
    throw new Error('replacement runtime binding');
  }
  const replacementMapping = typedControl.activeEpochMappings.find(
    (mapping) => mapping.epoch === typed.nextPublisherEpoch,
  );
  if (
    typedControl.activeEpochMappings.length > 16 ||
    new Set(typedControl.activeEpochMappings.map((mapping) => mapping.epoch)).size !==
      typedControl.activeEpochMappings.length ||
    replacementMapping === undefined ||
    replacementMapping.subject !== typed.replacementSubject ||
    replacementMapping.keyVersion !== typed.replacementKeyVersion ||
    replacementMapping.spkiSha256 !== typed.replacementKeyFingerprint ||
    typedControl.activeEpochMappings.some(
      (mapping) => mapping.subject === quarantinedRuntime.subject && BigInt(mapping.epoch) > ceiling,
    )
  ) {
    throw new Error('replacement mapping binding');
  }
  const replacementKeyResource = keyResource(typed.replacementKeyVersion);
  const quarantinedKeyResources = new Set(
    typedControl.activeEpochMappings
      .filter((mapping) => mapping.subject === quarantinedRuntime.subject)
      .map((mapping) => keyResource(mapping.keyVersion)),
  );
  const expectedKeyResources = new Set([replacementKeyResource, ...quarantinedKeyResources]);
  const replacementKeyReadback = typedControl.keyAccess.find(
    (readback) => readback.cryptoKey === replacementKeyResource,
  );
  const expectedReplacementVersions = typedControl.activeEpochMappings
    .filter((mapping) => keyResource(mapping.keyVersion) === replacementKeyResource)
    .map((mapping) => JSON.stringify([mapping.keyVersion, mapping.algorithm, mapping.spkiSha256]))
    .sort();
  const suppliedReplacementVersions = [...(replacementKeyReadback?.enabledVersions ?? [])]
    .map((version) => JSON.stringify([version.keyVersion, version.algorithm, version.spkiSha256]))
    .sort();
  const oldPrincipals = new Set([quarantinedRuntime.subject, quarantinedRuntime.iamMember]);
  const broadMember = (member: string) =>
    member === 'allUsers' ||
    member === 'allAuthenticatedUsers' ||
    member.startsWith('group:') ||
    member.startsWith('domain:');
  if (
    replacementKeyResource === typed.replacementKeyVersion ||
    quarantinedKeyResources.size !== 1 ||
    expectedKeyResources.size !== 2 ||
    new Set(typedControl.keyAccess.map((readback) => readback.cryptoKey)).size !== 2 ||
    typedControl.keyAccess.some((readback) => !expectedKeyResources.has(readback.cryptoKey)) ||
    replacementKeyReadback === undefined ||
    replacementKeyReadback.signMembers.length !== 1 ||
    replacementKeyReadback.signMembers[0] !== replacementRuntime.iamMember ||
    suppliedReplacementVersions.length !== expectedReplacementVersions.length ||
    suppliedReplacementVersions.some((version, index) => version !== expectedReplacementVersions[index]) ||
    typedControl.keyAccess.some(
      (readback) =>
        readback.signMembers.length > 16 ||
        readback.enabledVersions.length > 16 ||
        readback.signMembers.some((member) => broadMember(member) || oldPrincipals.has(member)),
    ) ||
    typedControl.activeEpochMappings.some((mapping) => {
      const readback = typedControl.keyAccess.find(
        (candidate) => candidate.cryptoKey === keyResource(mapping.keyVersion),
      );
      return !readback?.enabledVersions.some(
        (version) =>
          version.keyVersion === mapping.keyVersion &&
          version.algorithm === mapping.algorithm &&
          version.spkiSha256 === mapping.spkiSha256,
      );
    })
  ) {
    throw new Error('replacement key readback binding');
  }
  const runtimeBySubject = new Map(
    [quarantinedRuntime, replacementRuntime].map((runtime) => [runtime.subject, runtime] as const),
  );
  if (
    new Set(typedControl.serviceAccountAccess.map((readback) => readback.subject)).size !== 2 ||
    typedControl.serviceAccountAccess.some((readback) => {
      const runtime = runtimeBySubject.get(readback.subject);
      return (
        runtime === undefined ||
        readback.serviceAccountEmail !== runtime.serviceAccountEmail ||
        readback.iamMember !== runtime.iamMember ||
        readback.fullResourceName !== canonicalServiceAccountResource(runtime.serviceAccountEmail) ||
        readback.tokenCreatorMembers.length > 16 ||
        readback.tokenCreatorMembers.some((member) => broadMember(member) || oldPrincipals.has(member))
      );
    })
  ) {
    throw new Error('replacement service account binding');
  }
  const replacementServiceAccountResource = canonicalServiceAccountResource(replacementRuntime.serviceAccountEmail);
  const permissions = new Set(typedControl.quarantinedAccessDecisions.map((decision) => decision.permission));
  if (
    permissions.size !== 3 ||
    !permissions.has('cloudkms.cryptoKeyVersions.useToSign') ||
    !permissions.has('iam.serviceAccounts.getOpenIdToken') ||
    !permissions.has('iam.serviceAccounts.getAccessToken') ||
    replacementServiceAccountResource === null ||
    typedControl.quarantinedAccessDecisions.some(
      (decision) =>
        decision.principal !== quarantinedRuntime.serviceAccountEmail ||
        decision.fullResourceName !==
          (decision.permission === 'cloudkms.cryptoKeyVersions.useToSign'
            ? `//cloudkms.googleapis.com/${typed.replacementKeyVersion}`
            : replacementServiceAccountResource),
    )
  ) {
    throw new Error('replacement quarantine decision binding');
  }
}

async function validateAction(value: unknown, expectedHost: string): Promise<RecoveryRequest['action']> {
  if (!isRecord(value) || typeof value.kind !== 'string' || !ACTIONS.has(value.kind)) throw new Error('action');
  if (value.kind === 'acquire-lock') {
    const action = exactRecord(value, ['kind', 'wafEvidence']);
    await validateWafEvidence(action.wafEvidence, expectedHost);
  } else if (value.kind === 'abort-lock') {
    const action = exactRecord(value, ['kind', 'lockId', 'wafEvidence']);
    nonEmptyString(action.lockId);
    await validateWafEvidence(action.wafEvidence, expectedHost);
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
    await Promise.all(action.providerRequests.map((request) => validateProviderRequest(request, expectedHost)));
  }
  return value as RecoveryRequest['action'];
}

function validateProbeChallenge(value: unknown, expectedHost: string): Record<string, unknown> {
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
  if (challenge.host !== expectedHost) throw new Error('challenge host');
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

function validateProbeObservation(value: unknown, expectedHost: string): Record<string, unknown> {
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
  ]) {
    nonEmptyString(field);
  }
  const requestPath = nonEmptyString(observation.requestPath);
  if (!requestPath.startsWith('/') || requestPath.startsWith('//')) throw new Error('observation request path');
  if (observation.host !== expectedHost) throw new Error('observation host');
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

function validateProbeEvidence(value: unknown, expectedHost: string): ConsumedProbeEvidence {
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
  const challenge = validateProbeChallenge(evidence.challenge, expectedHost);
  const observation = validateProbeObservation(evidence.observation, expectedHost);
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
  return value as ConsumedProbeEvidence;
}

function validateProviderProbeBindings(
  providerRequests: readonly ProviderRequestEvidence[],
  expectedIds: readonly string[],
  probeEvidence: readonly ConsumedProbeEvidence[],
  expectedBlockBodyDigest?: string,
): void {
  if (providerRequests.length !== 3 || expectedIds.length !== 3 || probeEvidence.length !== 3) {
    throw new Error('provider probe count');
  }
  const ids = new Set<string>();
  const rays = new Set<string>();
  const colos = new Set<string>();
  const subjects = new Set<string>();
  const keys = new Set<string>();
  const regions = new Set<string>();
  for (const [index, evidence] of probeEvidence.entries()) {
    const provider = providerRequests[index];
    const expectedId = expectedIds[index];
    let observedRequest: URL;
    try {
      observedRequest = new URL(evidence.observation.requestPath, 'https://registry-probe.invalid');
    } catch {
      throw new Error('probe request');
    }
    const expectedQuery = `nonce=${encodeURIComponent(evidence.challenge.probeNonce)}`;
    if (
      evidence.id !== expectedId ||
      evidence.observation.rayId !== provider.rayId ||
      observedRequest.pathname !== provider.path ||
      observedRequest.search.slice(1) !== provider.query ||
      provider.query !== expectedQuery ||
      observedRequest.hash !== '' ||
      evidence.observation.expectedStatus !== provider.edgeResponseStatus ||
      evidence.observation.observedStatus !== provider.edgeResponseStatus ||
      (expectedBlockBodyDigest !== undefined &&
        (evidence.observation.phase !== 'blocked-before-worker' ||
          evidence.observation.expectedBlockBodyDigest !== expectedBlockBodyDigest ||
          evidence.observation.observedBlockBodyDigest !== expectedBlockBodyDigest)) ||
      (expectedBlockBodyDigest === undefined && evidence.observation.phase !== 'canonical-after-unblock')
    ) {
      throw new Error('provider probe binding');
    }
    ids.add(evidence.id);
    rays.add(provider.rayId);
    colos.add(provider.edgeColoCode);
    subjects.add(evidence.subject);
    keys.add(evidence.keyFingerprint);
    regions.add(evidence.region);
  }
  if (
    ids.size !== 3 ||
    rays.size !== 3 ||
    colos.size !== 3 ||
    subjects.size !== 3 ||
    keys.size !== 3 ||
    regions.size !== 3
  ) {
    throw new Error('provider probe uniqueness');
  }
}

function sameCommitted(left: RecoveryRecord['before'], right: RecoveryRecord['after']): boolean {
  return (
    left === right ||
    (left !== null && right !== null && left.revision === right.revision && left.digest === right.digest)
  );
}

function skippedRange(
  before: RecoveryRecord['before'],
  afterRevision: string,
): RecoveryRecord['skippedRevisionRange'] {
  if (before === null) {
    return BigInt(afterRevision) > 1n ? { from: '1', to: (BigInt(afterRevision) - 1n).toString() } : null;
  }
  const first = BigInt(before.revision) + 1n;
  const last = BigInt(afterRevision) - 1n;
  return last >= first ? { from: first.toString(), to: last.toString() } : null;
}

function sameSkippedRange(
  left: RecoveryRecord['skippedRevisionRange'],
  right: RecoveryRecord['skippedRevisionRange'],
): boolean {
  return left === right || (left !== null && right !== null && left.from === right.from && left.to === right.to);
}

function validateActionBindings(
  record: RecoveryRecord,
  sourceAudit: SourceAudit,
  action: RecoveryRequest['action'],
  probeEvidence: readonly ConsumedProbeEvidence[],
): void {
  if (action.kind === 'apply') {
    const after = record.after;
    if (
      after === null ||
      after.revision !== sourceAudit.revision ||
      after.digest !== sourceAudit.digest ||
      (record.before !== null && BigInt(record.before.revision) > BigInt(after.revision)) ||
      (record.before !== null &&
        record.before.revision === after.revision &&
        record.before.digest !== after.digest &&
        action.publisherReplacement === null) ||
      !sameSkippedRange(record.skippedRevisionRange, skippedRange(record.before, after.revision))
    ) {
      throw new Error('apply binding');
    }
    return;
  }

  const before = record.before;
  if (before === null || !sameCommitted(before, record.after) || record.skippedRevisionRange !== null) {
    throw new Error('lock-only binding');
  }
  if (probeEvidence.some((evidence) => evidence.challenge.expectedStateDigest !== before.digest)) {
    throw new Error('probe state binding');
  }

  if (action.kind === 'acquire-lock') return;
  if (sourceAudit.revision !== before.revision || sourceAudit.digest !== before.digest) {
    throw new Error('lock release source binding');
  }
  if (action.kind === 'abort-lock') return;

  const desired = sourceAudit.canonicalProjection.desired;
  const expected =
    desired.kind === 'tombstone'
      ? { status: 404, reason: 'unknown-host' as const, servesOrigin: false }
      : desired.kind === 'route' && desired.status !== 'active'
        ? { status: 404, reason: 'inactive' as const, servesOrigin: false }
        : { status: 200, reason: null, servesOrigin: true };
  const recoverySequence = (BigInt(record.sequence) - 1n).toString();
  if (
    action.providerRequests.some((request) => request.firewall !== null) ||
    probeEvidence.some((evidence) => {
      const challenge = evidence.challenge;
      const observation = evidence.observation;
      return (
        challenge.phase !== 'canonical-after-unblock' ||
        observation.phase !== 'canonical-after-unblock' ||
        challenge.recoveryLockId !== action.lockId ||
        challenge.recoverySequence !== recoverySequence ||
        challenge.wafRemovedAt !== action.wafRemovedAt ||
        observation.expectedStatus !== expected.status ||
        observation.observedStatus !== expected.status ||
        observation.expectedReason !== expected.reason ||
        observation.observedReason !== expected.reason ||
        observation.expectedRevision !== before.revision ||
        observation.observedRevision !== before.revision ||
        observation.expectedServesOrigin !== expected.servesOrigin ||
        observation.observedServesOrigin !== expected.servesOrigin ||
        (expected.servesOrigin ? observation.originRequestId === null : observation.originRequestId !== null)
      );
    })
  ) {
    throw new Error('clear probe binding');
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

export async function parseRecoveryHistoryEntry(
  storageKey: string,
  value: unknown,
  expectedHost: string,
): Promise<RecoveryRecord> {
  try {
    const host = nonEmptyString(expectedHost);
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
    const sourceAudit = await validateSourceAudit(record.sourceAudit, host);
    const action = await validateAction(record.evidence, host);
    if (action.kind !== record.action) throw new Error('action binding');
    if (action.kind === 'apply' && action.publisherReplacement !== null) {
      const control = action.publisherReplacement.controlEvidence;
      if (
        control.attestorSub !== sourceAudit.attestorSub ||
        control.attestorKeyVersion !== sourceAudit.attestorKeyVersion ||
        control.attestorKeyFingerprint !== sourceAudit.attestorKeyFingerprint
      ) {
        throw new Error('replacement attestor binding');
      }
    }
    if (!Array.isArray(record.probeEvidence)) throw new Error('probe evidence');
    const expectedProbeCount = record.action === 'apply' ? 0 : 3;
    if (record.probeEvidence.length !== expectedProbeCount) throw new Error('probe evidence count');
    const probeEvidence = record.probeEvidence.map((evidence) => validateProbeEvidence(evidence, host));
    if (action.kind === 'acquire-lock' || action.kind === 'abort-lock') {
      validateProviderProbeBindings(
        action.wafEvidence.providerRequests,
        action.wafEvidence.probeAttestationIds,
        probeEvidence,
        action.wafEvidence.providerRule.customResponseBodyDigest,
      );
    } else if (action.kind === 'clear-lock') {
      validateProviderProbeBindings(action.providerRequests, action.probeAttestationIds, probeEvidence);
    }
    validateActionBindings(value as RecoveryRecord, sourceAudit, action, probeEvidence);
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
