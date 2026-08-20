import {
  projectionDigest,
  type CommittedReplica,
  type RegistryState,
  type ReplicaDesired,
  type RouterReplicaDesired,
} from './contracts';
import type { ConsumedProbeEvidence } from './probe';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const KMS_KEY_VERSION =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/;
const CLOUDFLARE_RESOURCE_ID = /^[a-f0-9]{32}$/;
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
  query: string;
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

export type KeyAccessReadback = {
  cryptoKey: string;
  policyEtag: string;
  signMembers: string[];
  enabledVersions: Array<{
    keyVersion: string;
    algorithm: 'RSA_SIGN_PKCS1_2048_SHA256';
    spkiSha256: string;
  }>;
  responseDigest: string;
};

export type ServiceAccountAccessReadback = {
  subject: string;
  serviceAccountEmail: string;
  iamMember: string;
  fullResourceName: string;
  policyEtag: string;
  tokenCreatorMembers: string[];
  responseDigest: string;
};

export type AccessDecisionReadback = {
  principal: string;
  fullResourceName: string;
  permission:
    | 'cloudkms.cryptoKeyVersions.useToSign'
    | 'iam.serviceAccounts.getOpenIdToken'
    | 'iam.serviceAccounts.getAccessToken';
  requestTime: string;
  overallAccessState: 'CANNOT_ACCESS';
  inheritedPoliciesComplete: true;
  responseDigest: string;
};

export type PublisherRuntimeReadback = {
  subject: string;
  serviceAccountEmail: string;
  iamMember: string;
  functionFullResourceName: string;
  functionRevision: string;
  responseDigest: string;
};

export type ActivePublisherMapping = {
  epoch: string;
  subject: string;
  keyVersion: string;
  algorithm: 'RSA_SIGN_PKCS1_2048_SHA256';
  spkiSha256: string;
};

type PublisherControlEvidence = {
  observedAt: string;
  quarantinedRuntime: PublisherRuntimeReadback;
  replacementRuntime: PublisherRuntimeReadback;
  activeEpochMappings: ActivePublisherMapping[];
  keyAccess: [KeyAccessReadback, KeyAccessReadback];
  serviceAccountAccess: [ServiceAccountAccessReadback, ServiceAccountAccessReadback];
  quarantinedAccessDecisions: [AccessDecisionReadback, AccessDecisionReadback, AccessDecisionReadback];
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
    | {
        kind: 'apply';
        lockId: string;
        publisherReplacement: PublisherReplacement;
      }
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
  probeEvidence: ConsumedProbeEvidence[];
  operatorSub: string;
  operatorKeyVersion: string;
  operatorKeyFingerprint: string;
  operatorSignature: string;
  operatorSignatureScheme: 'v1';
  operatorSignedRole: 'recovery';
  operatorSignedMethod: 'POST';
  operatorSignedPath: string;
  operatorIssuedAt: string;
  requestBodyDigest: string;
  incidentUrl: string;
  reason: string;
  containmentRemains: boolean;
};

export type RecoveryContext = {
  now: number;
  operatorSub: string;
  operatorKeyVersion: string;
  operatorKeyFingerprint: string;
  operatorSignature: string;
  operatorSignatureScheme: 'v1';
  operatorSignedRole: 'recovery';
  operatorSignedMethod: 'POST';
  operatorSignedPath: string;
  operatorIssuedAt: string;
  requestBodyDigest: string;
  lockId: string;
  expectedWafZone: {
    namespace: 'fiveacross.app' | 'vacaybingo.com';
    zoneId: string;
    rulesetId: string;
  };
  publisherIntegrityProven?: boolean;
  activeRegistryConfigDigest?: string;
  activePublisherMappings?: readonly ActivePublisherMapping[];
  consumeAttestations?: (
    ids: readonly string[],
    phase: 'blocked' | 'canonical',
  ) => Promise<readonly ConsumedProbeEvidence[]>;
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
    (left !== null && right !== null && left.revision === right.revision && left.digest === right.digest)
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

function validateRecoveryAuthorization(context: RecoveryContext): void {
  if (
    context.operatorSub.length === 0 ||
    !KMS_KEY_VERSION.test(context.operatorKeyVersion) ||
    !SHA256_HEX.test(context.operatorKeyFingerprint) ||
    context.operatorSignature.length === 0 ||
    context.operatorSignatureScheme !== 'v1' ||
    context.operatorSignedRole !== 'recovery' ||
    context.operatorSignedMethod !== 'POST' ||
    !/^\/__internal\/hostname-replicas\/v1\/recover(?:\?[^#]*)?$/.test(context.operatorSignedPath) ||
    !/^[1-9]\d*$/.test(context.operatorIssuedAt) ||
    !SHA256_HEX.test(context.requestBodyDigest)
  ) {
    throw new Error('recovery authorization provenance is malformed');
  }
}

export function recoveryOperatorSignatureBytes(
  record: Pick<
    RecoveryRecord,
    | 'operatorSignatureScheme'
    | 'operatorSignedRole'
    | 'operatorSignedMethod'
    | 'operatorSignedPath'
    | 'operatorIssuedAt'
    | 'requestBodyDigest'
  >,
): Uint8Array {
  return new TextEncoder().encode(
    [
      record.operatorSignatureScheme,
      record.operatorSignedRole,
      record.operatorSignedMethod,
      record.operatorSignedPath,
      record.operatorIssuedAt,
      record.requestBodyDigest,
    ].join('\n'),
  );
}

async function consumeRequiredProbeEvidence(
  context: RecoveryContext,
  ids: readonly string[],
  phase: 'blocked' | 'canonical',
): Promise<ConsumedProbeEvidence[]> {
  if (context.consumeAttestations === undefined) {
    throw new Error('probe attestation consumer is unavailable');
  }
  const consumed = [...(await context.consumeAttestations(ids, phase))];
  if (
    consumed.length !== ids.length ||
    consumed.some((entry, index) => entry.id !== ids[index])
  ) {
    throw new Error('consumed probe evidence does not match the authorized attestation IDs');
  }
  return consumed;
}

async function validateProviderRequests(
  host: string,
  requests: readonly ProviderRequestEvidence[],
  blocked: boolean,
  now: number,
  waf?: WafEvidence,
  notBefore?: number,
): Promise<void> {
  if (requests.length !== 3) throw new Error('exactly three provider requests required');
  const rays = new Set<string>();
  const colos = new Set<string>();
  for (const request of requests) {
    requireFresh(request.eventAt, now, MAX_SOURCE_AGE_MS, 'provider event');
    requireFresh(request.verifiedAt, now, MAX_SOURCE_AGE_MS, 'provider verification');
    const eventAt = Date.parse(request.eventAt);
    const verifiedAt = Date.parse(request.verifiedAt);
    if (verifiedAt < eventAt || (notBefore !== undefined && (eventAt <= notBefore || verifiedAt <= notBefore))) {
      throw new Error('provider evidence predates the authorized recovery phase');
    }
    if (request.host !== host || request.rayId.length === 0 || request.edgeColoCode.length === 0) {
      throw new Error('provider request host or identity mismatch');
    }
    if (
      !request.path.startsWith('/') ||
      request.path.includes('?') ||
      request.path.includes('#') ||
      request.query.startsWith('?') ||
      request.query.includes('#') ||
      !SHA256_HEX.test(request.queryDigest) ||
      request.queryDigest !== (await sha256Hex(request.query)) ||
      !SHA256_HEX.test(request.httpLogResponseDigest)
    ) {
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

async function validateWafEvidence(
  host: string,
  evidence: WafEvidence,
  now: number,
  expectedZone: RecoveryContext['expectedWafZone'],
): Promise<void> {
  requireFresh(evidence.verifiedAt, now, MAX_SOURCE_AGE_MS, 'WAF verification');
  if (
    !CLOUDFLARE_RESOURCE_ID.test(evidence.zoneId) ||
    !CLOUDFLARE_RESOURCE_ID.test(evidence.rulesetId) ||
    !CLOUDFLARE_RESOURCE_ID.test(evidence.ruleId) ||
    !host.endsWith(`.${expectedZone.namespace}`) ||
    evidence.zoneId !== expectedZone.zoneId ||
    evidence.rulesetId !== expectedZone.rulesetId ||
    evidence.host !== host ||
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
  await validateProviderRequests(host, evidence.providerRequests, true, now, evidence);
}

function validateReplacement(
  state: RegistryState,
  replacement: NonNullable<PublisherReplacement>,
  now: number,
  activePublisherMappings: readonly ActivePublisherMapping[] | undefined,
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
    BigInt(replacement.nextPublisherEpoch) <= ceiling ||
    BigInt(replacement.nextPublisherEpoch) < BigInt(state.minimumPublisherEpoch)
  ) {
    throw new Error('publisher replacement does not fence quarantined epochs');
  }
  const control = replacement.controlEvidence;
  requireFresh(control.observedAt, now, MAX_SOURCE_AGE_MS, 'publisher control evidence');
  requireFresh(control.attestationIssuedAt, now, MAX_ATTESTATION_AGE_MS, 'publisher control attestation');
  if (control.activeEpochMappings.length === 0 || control.activeEpochMappings.length > 16) {
    throw new Error('active epoch mappings are empty or oversized');
  }
  const mappingProjection = (mapping: ActivePublisherMapping) =>
    JSON.stringify([mapping.epoch, mapping.subject, mapping.keyVersion, mapping.algorithm, mapping.spkiSha256]);
  const suppliedMappings = [...control.activeEpochMappings].sort((left, right) =>
    mappingProjection(left).localeCompare(mappingProjection(right)),
  );
  const configuredMappings = [...(activePublisherMappings ?? [])].sort((left, right) =>
    mappingProjection(left).localeCompare(mappingProjection(right)),
  );
  if (
    activePublisherMappings === undefined ||
    suppliedMappings.length !== configuredMappings.length ||
    suppliedMappings.some(
      (mapping, index) => mappingProjection(mapping) !== mappingProjection(configuredMappings[index]),
    )
  ) {
    throw new Error('publisher active epoch mappings do not match registry configuration');
  }
  const canonicalServiceAccountResource = (email: string): string | null => {
    const suffix = '.iam.gserviceaccount.com';
    const at = email.indexOf('@');
    const domain = at === -1 ? '' : email.slice(at + 1);
    const project = domain.endsWith(suffix) ? domain.slice(0, -suffix.length) : '';
    return at > 0 && project.length > 0 ? `//iam.googleapis.com/projects/${project}/serviceAccounts/${email}` : null;
  };
  const runtimeIdentityIsCanonical = (runtime: PublisherRuntimeReadback) =>
    POSITIVE_DECIMAL.test(runtime.subject) &&
    runtime.iamMember === `serviceAccount:${runtime.serviceAccountEmail}` &&
    /^\/\/cloudfunctions\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/functions\/[^/]+$/.test(
      runtime.functionFullResourceName,
    );
  if (
    !POSITIVE_DECIMAL.test(replacement.replacementSubject) ||
    control.quarantinedRuntime.subject === replacement.replacementSubject ||
    control.quarantinedRuntime.serviceAccountEmail === control.replacementRuntime.serviceAccountEmail ||
    control.quarantinedRuntime.functionFullResourceName === control.replacementRuntime.functionFullResourceName ||
    !runtimeIdentityIsCanonical(control.quarantinedRuntime) ||
    !runtimeIdentityIsCanonical(control.replacementRuntime) ||
    control.quarantinedRuntime.functionRevision.length === 0 ||
    !SHA256_HEX.test(control.quarantinedRuntime.responseDigest) ||
    control.replacementRuntime.functionRevision.length === 0 ||
    !SHA256_HEX.test(control.replacementRuntime.responseDigest)
  ) {
    throw new Error('publisher runtime readback is malformed or not distinct');
  }
  const mapping = control.activeEpochMappings.find((candidate) => candidate.epoch === replacement.nextPublisherEpoch);
  if (
    mapping === undefined ||
    mapping.subject !== replacement.replacementSubject ||
    mapping.keyVersion !== replacement.replacementKeyVersion ||
    mapping.spkiSha256 !== replacement.replacementKeyFingerprint ||
    control.replacementRuntime.subject !== replacement.replacementSubject
  ) {
    throw new Error('replacement runtime and active mapping differ');
  }
  for (const active of control.activeEpochMappings) {
    if (
      !POSITIVE_DECIMAL.test(active.epoch) ||
      active.subject.length === 0 ||
      active.keyVersion.length === 0 ||
      !SHA256_HEX.test(active.spkiSha256) ||
      active.algorithm !== 'RSA_SIGN_PKCS1_2048_SHA256'
    ) {
      throw new Error('active epoch mapping malformed');
    }
    if (active.subject === control.quarantinedRuntime.subject && BigInt(active.epoch) > ceiling) {
      throw new Error('quarantined epoch ceiling misses an active mapping');
    }
  }
  if (
    control.quarantinedAccessDecisions.length !== 3 ||
    control.quarantinedAccessDecisions.some((decision) => decision.overallAccessState !== 'CANNOT_ACCESS')
  ) {
    throw new Error('all publisher quarantine decisions must be CANNOT_ACCESS');
  }
  if (control.keyAccess.length !== 2 || control.serviceAccountAccess.length !== 2) {
    throw new Error('publisher control evidence must include both key and service-account readbacks');
  }
  const broadMember = (member: string) =>
    member === 'allUsers' ||
    member === 'allAuthenticatedUsers' ||
    member.startsWith('group:') ||
    member.startsWith('domain:');
  const oldPrincipals = new Set([control.quarantinedRuntime.subject, control.quarantinedRuntime.iamMember]);
  const keyResource = (keyVersion: string) => keyVersion.replace(/\/cryptoKeyVersions\/[1-9]\d*$/, '');
  const replacementKeyResource = keyResource(replacement.replacementKeyVersion);
  if (replacementKeyResource === replacement.replacementKeyVersion) {
    throw new Error('replacement key version resource is malformed');
  }
  const quarantinedKeyResources = new Set(
    control.activeEpochMappings
      .filter((active) => active.subject === control.quarantinedRuntime.subject)
      .map((active) => keyResource(active.keyVersion)),
  );
  if (quarantinedKeyResources.size !== 1) {
    throw new Error('quarantined key readback is missing or ambiguous');
  }
  const expectedKeyResources = new Set([replacementKeyResource, ...quarantinedKeyResources]);
  const replacementKeyReadback = control.keyAccess.find(
    (readback) => readback.cryptoKey === replacementKeyResource,
  );
  const expectedReplacementVersions = control.activeEpochMappings
    .filter((active) => keyResource(active.keyVersion) === replacementKeyResource)
    .map((active) => ({
      keyVersion: active.keyVersion,
      algorithm: active.algorithm,
      spkiSha256: active.spkiSha256,
    }));
  const versionProjection = (version: KeyAccessReadback['enabledVersions'][number]) =>
    JSON.stringify([version.keyVersion, version.algorithm, version.spkiSha256]);
  if (
    expectedKeyResources.size !== 2 ||
    new Set(control.keyAccess.map((readback) => readback.cryptoKey)).size !== 2 ||
    control.keyAccess.some((readback) => !expectedKeyResources.has(readback.cryptoKey))
  ) {
    throw new Error('publisher key readbacks do not match the quarantined and replacement resources');
  }
  const suppliedReplacementVersions = [...(replacementKeyReadback?.enabledVersions ?? [])]
    .map(versionProjection)
    .sort();
  const configuredReplacementVersions = expectedReplacementVersions.map(versionProjection).sort();
  if (
    replacementKeyReadback === undefined ||
    replacementKeyReadback.signMembers.length !== 1 ||
    replacementKeyReadback.signMembers[0] !== control.replacementRuntime.iamMember ||
    suppliedReplacementVersions.length !== configuredReplacementVersions.length ||
    suppliedReplacementVersions.some(
      (version, index) => version !== configuredReplacementVersions[index],
    )
  ) {
    throw new Error('replacement key policy must exactly match its active mapping and direct signer');
  }
  const quarantinedMappings = control.activeEpochMappings.filter(
    (active) => active.subject === control.quarantinedRuntime.subject,
  );
  if (
    quarantinedMappings.some((active) => {
      const readback = control.keyAccess.find((candidate) => candidate.cryptoKey === keyResource(active.keyVersion));
      return !readback?.enabledVersions.some(
        (version) => version.keyVersion === active.keyVersion && version.spkiSha256 === active.spkiSha256,
      );
    })
  ) {
    throw new Error('quarantined key version readback does not match its active mapping');
  }
  const serviceAccountSubjects = new Set(control.serviceAccountAccess.map((readback) => readback.subject));
  if (
    serviceAccountSubjects.size !== 2 ||
    !serviceAccountSubjects.has(control.quarantinedRuntime.subject) ||
    !serviceAccountSubjects.has(replacement.replacementSubject)
  ) {
    throw new Error('publisher service-account readbacks do not match both runtimes');
  }
  for (const runtime of [control.quarantinedRuntime, control.replacementRuntime]) {
    const readback = control.serviceAccountAccess.find((candidate) => candidate.subject === runtime.subject);
    if (
      readback === undefined ||
      readback.serviceAccountEmail !== runtime.serviceAccountEmail ||
      readback.iamMember !== runtime.iamMember ||
      readback.fullResourceName !== canonicalServiceAccountResource(runtime.serviceAccountEmail)
    ) {
      throw new Error('publisher service-account readback identity does not match its runtime');
    }
  }
  let replacementSigningGrant = false;
  for (const readback of control.keyAccess) {
    if (
      readback.signMembers.length > 16 ||
      readback.enabledVersions.length > 16 ||
      readback.signMembers.some((member) => broadMember(member) || oldPrincipals.has(member)) ||
      !SHA256_HEX.test(readback.responseDigest) ||
      readback.enabledVersions.some(
        (version) => version.algorithm !== 'RSA_SIGN_PKCS1_2048_SHA256' || !SHA256_HEX.test(version.spkiSha256),
      )
    ) {
      throw new Error('replacement key policy does not quarantine the old publisher');
    }
    if (
      readback.cryptoKey === replacementKeyResource &&
      readback.enabledVersions.some(
        (version) =>
          version.keyVersion === replacement.replacementKeyVersion &&
          version.spkiSha256 === replacement.replacementKeyFingerprint,
      ) &&
      readback.signMembers.includes(control.replacementRuntime.iamMember)
    ) {
      replacementSigningGrant = true;
    }
  }
  if (!replacementSigningGrant) throw new Error('replacement subject lacks a direct signing grant');
  for (const readback of control.serviceAccountAccess) {
    if (
      readback.tokenCreatorMembers.length > 16 ||
      readback.tokenCreatorMembers.some((member) => broadMember(member) || oldPrincipals.has(member)) ||
      !SHA256_HEX.test(readback.responseDigest)
    ) {
      throw new Error('replacement service-account policy does not quarantine the old publisher');
    }
  }
  const permissions = new Set(control.quarantinedAccessDecisions.map((decision) => decision.permission));
  if (
    permissions.size !== 3 ||
    !permissions.has('cloudkms.cryptoKeyVersions.useToSign') ||
    !permissions.has('iam.serviceAccounts.getOpenIdToken') ||
    !permissions.has('iam.serviceAccounts.getAccessToken') ||
    control.quarantinedAccessDecisions.some(
      (decision) =>
        decision.principal !== control.quarantinedRuntime.serviceAccountEmail ||
        decision.fullResourceName !==
          (decision.permission === 'cloudkms.cryptoKeyVersions.useToSign'
            ? `//cloudkms.googleapis.com/${replacement.replacementKeyVersion}`
            : canonicalServiceAccountResource(control.replacementRuntime.serviceAccountEmail)) ||
        decision.inheritedPoliciesComplete !== true ||
        !SHA256_HEX.test(decision.responseDigest) ||
        !Number.isFinite(Date.parse(decision.requestTime)),
    )
  ) {
    throw new Error('publisher quarantine decisions are incomplete');
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
  validateRecoveryAuthorization(context);
  const ledgerPayload = await validateSourceAudit(request.host, request.sourceAudit, context.now);
  const before = committedRef(state.committed);
  if (!sameCommitted(before, request.expectedCommitted)) throw new Error('committed-state CAS failed');

  const sequence = nextSequence(state);
  let nextState: RegistryState = state;
  let skippedRevisionRange: RecoveryRecord['skippedRevisionRange'] = null;
  let containmentRemains = false;
  let probeEvidence: ConsumedProbeEvidence[] = [];

  if (request.action.kind === 'acquire-lock') {
    if (state.recoveryLock !== null) throw new Error('recovery lock already held');
    await validateWafEvidence(request.host, request.action.wafEvidence, context.now, context.expectedWafZone);
    probeEvidence = await consumeRequiredProbeEvidence(
      context,
      request.action.wafEvidence.probeAttestationIds,
      'blocked',
    );
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
      if (state.committed?.payload.desired.kind === 'tombstone' && ledgerPayload.desired.kind !== 'tombstone') {
        throw new Error('tombstone-final');
      }
      const digest = await projectionDigest(ledgerPayload);
      const equalRepair = sourceRevision === currentRevision && state.committed?.digest !== digest;
      if ((equalRepair || context.publisherIntegrityProven !== true) && request.action.publisherReplacement === null) {
        throw new Error('publisher replacement required');
      }
      let epochState = state;
      if (request.action.publisherReplacement !== null) {
        validateReplacement(state, request.action.publisherReplacement, context.now, context.activePublisherMappings);
        if (
          context.activeRegistryConfigDigest !== undefined &&
          request.action.publisherReplacement.registryConfigDigest !== context.activeRegistryConfigDigest
        ) {
          throw new Error('publisher replacement registry mapping digest mismatch');
        }
        const control = request.action.publisherReplacement.controlEvidence;
        if (
          control.attestorSub !== request.sourceAudit.attestorSub ||
          control.attestorKeyVersion !== request.sourceAudit.attestorKeyVersion ||
          control.attestorKeyFingerprint !== request.sourceAudit.attestorKeyFingerprint
        ) {
          throw new Error('publisher control evidence uses the wrong source attestor');
        }
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
        committed: {
          revision: ledgerPayload.revision,
          digest,
          payload: ledgerPayload,
        },
      };
    } else if (request.action.kind === 'clear-lock') {
      const lockAcquiredAt = Date.parse(lock.acquiredAt);
      const wafRemovedAt = Date.parse(request.action.wafRemovedAt);
      if (
        !Number.isFinite(wafRemovedAt) ||
        wafRemovedAt <= lockAcquiredAt ||
        wafRemovedAt > context.now ||
        context.now - wafRemovedAt > MAX_SOURCE_AGE_MS
      ) {
        throw new Error('WAF removal time is malformed, stale, or predates the recovery lock');
      }
      if (
        !sameCommitted(before, {
          revision: ledgerPayload.revision,
          digest: request.sourceAudit.digest,
        })
      ) {
        throw new Error('fresh source must equal committed state before clear');
      }
      if (new Set(request.action.probeAttestationIds).size !== 3) {
        throw new Error('probe attestations must be distinct');
      }
      if (
        BigInt(state.highestQuarantinedPublisherEpoch) > 0n &&
        BigInt(state.highestAuthenticatedPublisherEpoch) < BigInt(state.minimumPublisherEpoch)
      ) {
        throw new Error('replacement publisher epoch has not authenticated');
      }
      await validateProviderRequests(
        request.host,
        request.action.providerRequests,
        false,
        context.now,
        undefined,
        wafRemovedAt,
      );
      probeEvidence = await consumeRequiredProbeEvidence(
        context,
        request.action.probeAttestationIds,
        'canonical',
      );
      const authorizedWafRemovedAt = request.action.wafRemovedAt;
      if (
        probeEvidence.some((evidence) => {
          if (evidence.challenge.phase !== 'canonical-after-unblock') return true;
          const observedAt = Date.parse(evidence.observation.observedAt);
          const receivedAt = Date.parse(evidence.receivedAt);
          return (
            evidence.challenge.recoveryLockId !== lock.lockId ||
            evidence.challenge.recoverySequence !== state.recoverySequence ||
            evidence.challenge.wafRemovedAt !== authorizedWafRemovedAt ||
            evidence.challenge.issuedAt <= wafRemovedAt ||
            !Number.isFinite(observedAt) ||
            observedAt <= wafRemovedAt ||
            !Number.isFinite(receivedAt) ||
            receivedAt < observedAt
          );
        })
      ) {
        throw new Error('canonical probe evidence predates or is not bound to WAF removal and current lock');
      }
      nextState = { ...state, recoverySequence: sequence, recoveryLock: null };
    } else {
      if (
        !sameCommitted(before, {
          revision: ledgerPayload.revision,
          digest: request.sourceAudit.digest,
        })
      ) {
        throw new Error('fresh source must equal committed state before abort');
      }
      await validateWafEvidence(request.host, request.action.wafEvidence, context.now, context.expectedWafZone);
      probeEvidence = await consumeRequiredProbeEvidence(
        context,
        request.action.wafEvidence.probeAttestationIds,
        'blocked',
      );
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
      probeEvidence,
      operatorSub: context.operatorSub,
      operatorKeyVersion: context.operatorKeyVersion,
      operatorKeyFingerprint: context.operatorKeyFingerprint,
      operatorSignature: context.operatorSignature,
      operatorSignatureScheme: context.operatorSignatureScheme,
      operatorSignedRole: context.operatorSignedRole,
      operatorSignedMethod: context.operatorSignedMethod,
      operatorSignedPath: context.operatorSignedPath,
      operatorIssuedAt: context.operatorIssuedAt,
      requestBodyDigest: context.requestBodyDigest,
      incidentUrl: request.incidentUrl,
      reason: request.reason,
      containmentRemains,
    },
  };
}
