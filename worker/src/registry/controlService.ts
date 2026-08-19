import { normalizeHost } from '../host';
import { REGISTRY_LOCATION_HINT, parseSyncRequest } from './contracts';
import { ControlAuthUnavailableError, authenticatePinnedRole, type PinnedRoleRequest } from './controlAuth';
import { publisherVerificationMappings, verificationRecordMappingDigest, type VerificationRecord } from './keys';
import { JwksUnavailableError, verifyGoogleOidc, type JwksResolver } from './oidc';
import type { ProbeChallengeRequest, ProbeObservation, ProbePrincipal } from './probe';
import type { RecoveryRequest, SourceAudit } from './recovery';
import type { HostRegistryNamespace, RegistryRateLimiter, RegistryServiceConfig } from './service';

export const RECOVERY_PATH = '/__internal/hostname-replicas/v1/recover';
export const PROBE_CHALLENGE_PATH = '/__internal/hostname-replicas/v1/probe-challenge';
export const PROBE_ATTEST_PATH = '/__internal/hostname-replicas/v1/probe-attest';
export const RECOVERY_MAX_BYTES = 16 * 1_024;

const AUDIT_PREFIX = '/__internal/hostname-replicas/v1/';
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

type ControlRole = 'audit' | 'recovery' | 'source-attestor' | 'regional-probe';

export type ControlServiceDeps = {
  now: () => number;
  jwks: JwksResolver;
  hostRegistry: HostRegistryNamespace;
  rateLimiter: RegistryRateLimiter;
  randomId: () => string;
};

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function bearer(value: string | null): string | null {
  if (value === null) return null;
  return /^Bearer ([A-Za-z0-9._-]+)$/.exec(value)?.[1] ?? null;
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

async function readExactJson(
  request: Request,
  maximum: number,
): Promise<{ rawBytes: Uint8Array; body: string; bodyDigest: string; value: unknown }> {
  if (request.headers.get('content-type') !== 'application/json') {
    throw new Response(JSON.stringify({ error: 'unsupported-media-type' }), {
      status: 415,
    });
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maximum)) {
    throw new Response(JSON.stringify({ error: 'request-too-large' }), {
      status: 413,
    });
  }
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > maximum) {
    throw new Response(JSON.stringify({ error: 'request-too-large' }), {
      status: 413,
    });
  }
  if (rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) {
    throw new Response(JSON.stringify({ error: 'invalid-request' }), { status: 400 });
  }
  let body: string;
  let value: unknown;
  try {
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBytes);
    value = JSON.parse(body);
  } catch {
    throw new Response(JSON.stringify({ error: 'invalid-request' }), {
      status: 400,
    });
  }
  return { rawBytes, body, bodyDigest: await sha256Hex(rawBytes), value };
}

function roleAudience(config: RegistryServiceConfig, role: ControlRole): string {
  const audience = config.roleAudiences?.[role];
  if (audience === undefined || audience.length === 0) {
    throw new ControlAuthUnavailableError('role audience unavailable');
  }
  return audience;
}

async function authenticateRequest(
  request: Request,
  role: 'recovery' | 'regional-probe',
  bodyDigest: string,
  config: RegistryServiceConfig,
  deps: ControlServiceDeps,
): Promise<{
  record: VerificationRecord;
  signature: string;
  issuedAtRaw: string;
  signatureScheme: 'v1';
  signedRole: 'recovery' | 'regional-probe';
  signedMethod: string;
  signedPath: string;
}> {
  const token = bearer(request.headers.get('authorization'));
  const slot = request.headers.get('x-registry-role-slot');
  const keyVersion = request.headers.get('x-registry-key-version');
  const signature = request.headers.get('x-registry-body-signature');
  const issuedAtRaw = request.headers.get('x-registry-issued-at');
  if (
    token === null ||
    slot === null ||
    keyVersion === null ||
    signature === null ||
    issuedAtRaw === null ||
    !/^[1-9]\d*$/.test(issuedAtRaw)
  ) {
    throw new Error('unauthorized');
  }
  const issuedAt = Number(issuedAtRaw);
  const url = new URL(request.url);
  const exactBytes = new TextEncoder().encode(
    ['v1', role, request.method, `${url.pathname}${url.search}`, issuedAtRaw, bodyDigest].join('\n'),
  );
  const record = await authenticatePinnedRole(
    {
      role,
      slot,
      keyVersion,
      token,
      signature,
      issuedAt,
      exactBytes,
      audience: roleAudience(config, role),
    },
    {
      now: deps.now(),
      jwks: deps.jwks,
      verificationRecords: config.verificationRecords,
    },
  );
  return {
    record,
    signature,
    issuedAtRaw,
    signatureScheme: 'v1' as const,
    signedRole: role,
    signedMethod: request.method,
    signedPath: `${url.pathname}${url.search}`,
  };
}

async function authenticateAudit(
  request: Request,
  config: RegistryServiceConfig,
  deps: ControlServiceDeps,
): Promise<void> {
  const token = bearer(request.headers.get('authorization'));
  if (token === null || config.auditSubject === undefined || config.auditSubject.length === 0) {
    throw new Error('unauthorized');
  }
  try {
    await verifyGoogleOidc(
      token,
      { audience: roleAudience(config, 'audit'), subject: config.auditSubject },
      deps.jwks,
      deps.now(),
    );
  } catch (error) {
    if (error instanceof JwksUnavailableError) {
      throw new ControlAuthUnavailableError('identity verification unavailable');
    }
    throw new Error('unauthorized');
  }
}

export function findSourceRecord(
  audit: SourceAudit,
  records: readonly VerificationRecord[],
): VerificationRecord | undefined {
  return records.find(
    (record) =>
      record.role === 'source-attestor' &&
      record.subject === audit.attestorSub &&
      record.keyVersion === audit.attestorKeyVersion &&
      record.spkiSha256 === audit.attestorKeyFingerprint,
  );
}

async function authenticateSourceAttestation(
  request: Request,
  recoveryRecord: VerificationRecord,
  recovery: RecoveryRequest,
  config: RegistryServiceConfig,
  deps: ControlServiceDeps,
): Promise<void> {
  const token = bearer(request.headers.get('x-source-attestor-authorization'));
  const audit = recovery.sourceAudit;
  const sourceRecord = findSourceRecord(audit, config.verificationRecords);
  if (token === null || sourceRecord === undefined) throw new Error('unauthorized');
  if (
    sourceRecord.subject === recoveryRecord.subject ||
    sourceRecord.keyVersion === recoveryRecord.keyVersion ||
    sourceRecord.spkiSha256 === recoveryRecord.spkiSha256
  ) {
    throw new Error('unauthorized');
  }
  const issuedAt = Date.parse(audit.attestationIssuedAt);
  const sourceBytes = new TextEncoder().encode(
    [
      'v1',
      'source-audit',
      recovery.host,
      audit.revision,
      audit.digest,
      audit.observedAt,
      audit.attestationIssuedAt,
      await sha256Hex(canonicalJson(audit.canonicalProjection)),
      await sha256Hex(canonicalJson(audit.ledgerPayload)),
      audit.canonicalProjection.sourceDocumentDigest,
      audit.ledgerDocumentDigest,
    ].join('\n'),
  );
  await authenticatePinnedRole(
    {
      role: 'source-attestor',
      slot: sourceRecord.epochOrSlot,
      keyVersion: audit.attestorKeyVersion,
      token,
      signature: audit.attestationSignature,
      issuedAt,
      exactBytes: sourceBytes,
      audience: roleAudience(config, 'source-attestor'),
    },
    {
      now: deps.now(),
      jwks: deps.jwks,
      verificationRecords: config.verificationRecords,
    },
  );

  if (recovery.action.kind === 'apply' && recovery.action.publisherReplacement !== null) {
    const control = recovery.action.publisherReplacement.controlEvidence;
    if (
      control.attestorSub !== sourceRecord.subject ||
      control.attestorKeyVersion !== sourceRecord.keyVersion ||
      control.attestorKeyFingerprint !== sourceRecord.spkiSha256
    ) {
      throw new Error('unauthorized');
    }
    const { attestationSignature: _attestationSignature, ...unsignedControl } = control;
    await authenticatePinnedRole(
      {
        role: 'source-attestor',
        slot: sourceRecord.epochOrSlot,
        keyVersion: control.attestorKeyVersion,
        token,
        signature: control.attestationSignature,
        issuedAt: Date.parse(control.attestationIssuedAt),
        exactBytes: new TextEncoder().encode(
          [
            'v1',
            'publisher-quarantine',
            control.observedAt,
            control.attestationIssuedAt,
            await sha256Hex(canonicalJson(unsignedControl)),
          ].join('\n'),
        ),
        audience: roleAudience(config, 'source-attestor'),
      },
      {
        now: deps.now(),
        jwks: deps.jwks,
        verificationRecords: config.verificationRecords,
      },
    );
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function validateDesiredSchema(value: unknown): void {
  if (!isRecord(value)) throw new Error('invalid desired state');
  const desired = value;
  if (desired.kind === 'route') {
    exactRecord(value, ['kind', 'eventId', 'status', 'slug', 'edition', 'pathNamespace'], 'route state');
  } else if (desired.kind === 'root') {
    exactRecord(value, ['kind', 'root', 'edition', 'pathNamespace'], 'root state');
  } else if (desired.kind === 'tombstone') {
    exactRecord(value, ['kind'], 'tombstone state');
  } else {
    throw new Error('invalid desired state');
  }
}

function validateProviderRequestSchema(value: unknown): void {
  const provider = exactRecord(
    value,
    [
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
    ],
    'provider request',
  );
  if (provider.firewall !== null) {
    exactRecord(
      provider.firewall,
      ['action', 'source', 'ruleId', 'ref', 'matchIndex', 'logResponseDigest'],
      'provider firewall record',
    );
  }
}

function validateWafSchema(value: unknown): void {
  const waf = exactRecord(
    value,
    [
      'zoneId',
      'rulesetId',
      'ruleId',
      'host',
      'verifiedAt',
      'blockNonce',
      'providerRule',
      'probeAttestationIds',
      'providerRequests',
    ],
    'WAF evidence',
  );
  exactRecord(
    waf.providerRule,
    ['enabled', 'action', 'expression', 'ref', 'customResponseBodyDigest', 'responseDigest'],
    'WAF provider rule',
  );
  stringArray(waf.probeAttestationIds, 'probe attestation IDs');
  if (!Array.isArray(waf.providerRequests)) throw new Error('invalid provider requests');
  waf.providerRequests.forEach(validateProviderRequestSchema);
}

function validatePublisherReplacementSchema(value: unknown): void {
  const replacement = exactRecord(
    value,
    [
      'quarantinedEpochCeiling',
      'nextPublisherEpoch',
      'replacementSubject',
      'replacementKeyVersion',
      'replacementKeyFingerprint',
      'registryConfigDigest',
      'controlEvidence',
    ],
    'publisher replacement',
  );
  const control = exactRecord(
    replacement.controlEvidence,
    [
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
    ],
    'publisher control evidence',
  );
  for (const runtime of [control.quarantinedRuntime, control.replacementRuntime]) {
    exactRecord(
      runtime,
      ['subject', 'serviceAccountEmail', 'iamMember', 'functionFullResourceName', 'functionRevision', 'responseDigest'],
      'publisher runtime readback',
    );
  }
  if (!Array.isArray(control.activeEpochMappings)) throw new Error('invalid publisher mappings');
  control.activeEpochMappings.forEach((mapping) =>
    exactRecord(mapping, ['epoch', 'subject', 'keyVersion', 'algorithm', 'spkiSha256'], 'publisher mapping'),
  );
  if (!Array.isArray(control.keyAccess)) throw new Error('invalid key access readbacks');
  control.keyAccess.forEach((entry) => {
    const readback = exactRecord(
      entry,
      ['cryptoKey', 'policyEtag', 'signMembers', 'enabledVersions', 'responseDigest'],
      'key access readback',
    );
    stringArray(readback.signMembers, 'key policy members');
    if (!Array.isArray(readback.enabledVersions)) throw new Error('invalid enabled key versions');
    readback.enabledVersions.forEach((version) =>
      exactRecord(version, ['keyVersion', 'algorithm', 'spkiSha256'], 'enabled key version'),
    );
  });
  if (!Array.isArray(control.serviceAccountAccess)) throw new Error('invalid service-account readbacks');
  control.serviceAccountAccess.forEach((entry) => {
    const readback = exactRecord(
      entry,
      [
        'subject',
        'serviceAccountEmail',
        'iamMember',
        'fullResourceName',
        'policyEtag',
        'tokenCreatorMembers',
        'responseDigest',
      ],
      'service-account readback',
    );
    stringArray(readback.tokenCreatorMembers, 'service-account policy members');
  });
  if (!Array.isArray(control.quarantinedAccessDecisions)) throw new Error('invalid access decisions');
  control.quarantinedAccessDecisions.forEach((decision) =>
    exactRecord(
      decision,
      [
        'principal',
        'fullResourceName',
        'permission',
        'requestTime',
        'overallAccessState',
        'inheritedPoliciesComplete',
        'responseDigest',
      ],
      'access decision',
    ),
  );
}

export function parseRecovery(value: unknown): RecoveryRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'host',
      'expectedCommitted',
      'sourceAudit',
      'action',
      'incidentUrl',
      'reason',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.host !== 'string' ||
    !isRecord(value.sourceAudit) ||
    !isRecord(value.action)
  ) {
    throw new Error('invalid recovery request');
  }
  const source = value.sourceAudit;
  if (
    !hasExactKeys(source, [
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
    ])
  ) {
    throw new Error('invalid source audit');
  }
  const canonical = exactRecord(
    source.canonicalProjection,
    ['sourceDocumentDigest', 'host', 'desired'],
    'canonical source projection',
  );
  validateDesiredSchema(canonical.desired);
  parseSyncRequest(JSON.stringify(source.ledgerPayload), 'application/json');
  if (value.expectedCommitted !== null) {
    exactRecord(value.expectedCommitted, ['revision', 'digest'], 'expected committed state');
  }
  const kind = value.action.kind;
  const expectedActionKeys =
    kind === 'acquire-lock'
      ? ['kind', 'wafEvidence']
      : kind === 'apply'
        ? ['kind', 'lockId', 'publisherReplacement']
        : kind === 'clear-lock'
          ? ['kind', 'lockId', 'wafRemovedAt', 'probeAttestationIds', 'providerRequests']
          : kind === 'abort-lock'
            ? ['kind', 'lockId', 'wafEvidence']
            : [];
  if (expectedActionKeys.length === 0 || !hasExactKeys(value.action, expectedActionKeys)) {
    throw new Error('invalid recovery action');
  }
  if (kind === 'acquire-lock' || kind === 'abort-lock') {
    validateWafSchema(value.action.wafEvidence);
  } else if (kind === 'clear-lock') {
    stringArray(value.action.probeAttestationIds, 'probe attestation IDs');
    if (!Array.isArray(value.action.providerRequests)) throw new Error('invalid provider requests');
    value.action.providerRequests.forEach(validateProviderRequestSchema);
  } else if (value.action.publisherReplacement !== null) {
    validatePublisherReplacementSchema(value.action.publisherReplacement);
  }
  return value as unknown as RecoveryRequest;
}

export function parseProbePayload(value: unknown, kind: 'challenge' | 'attest'): Record<string, unknown> {
  const challengePhase = isRecord(value) ? value.phase : undefined;
  const outer = exactRecord(
    value,
    kind === 'challenge'
      ? challengePhase === 'canonical-after-unblock'
        ? [
            'schemaVersion',
            'host',
            'phase',
            'expectedStateDigest',
            'recoveryLockId',
            'recoverySequence',
            'wafRemovedAt',
          ]
        : ['schemaVersion', 'host', 'phase', 'expectedStateDigest']
      : ['schemaVersion', 'host', 'observation'],
    'probe request',
  );
  if (outer.schemaVersion !== 1 || typeof outer.host !== 'string') {
    throw new Error('invalid probe request');
  }
  if (kind === 'challenge') {
    if (
      (outer.phase !== 'blocked-before-worker' && outer.phase !== 'canonical-after-unblock') ||
      typeof outer.expectedStateDigest !== 'string' ||
      !SHA256_HEX.test(outer.expectedStateDigest) ||
      (outer.phase === 'canonical-after-unblock' &&
        (typeof outer.recoveryLockId !== 'string' ||
          outer.recoveryLockId.length === 0 ||
          typeof outer.recoverySequence !== 'string' ||
          !/^[1-9]\d*$/.test(outer.recoverySequence) ||
          typeof outer.wafRemovedAt !== 'string' ||
          !Number.isFinite(Date.parse(outer.wafRemovedAt))))
    ) {
      throw new Error('invalid probe challenge');
    }
    return outer;
  }
  if (!isRecord(outer.observation)) throw new Error('invalid probe observation');
  const observation = outer.observation;
  const common = ['phase', 'probeNonce', 'observedAt', 'rayId', 'host', 'requestPath'];
  if (observation.phase === 'blocked-before-worker') {
    exactRecord(
      observation,
      [...common, 'expectedStatus', 'observedStatus', 'expectedBlockBodyDigest', 'observedBlockBodyDigest'],
      'blocked probe observation',
    );
  } else if (observation.phase === 'canonical-after-unblock') {
    exactRecord(
      observation,
      [
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
      ],
      'canonical probe observation',
    );
  } else {
    throw new Error('invalid probe observation');
  }
  if (observation.host !== outer.host) throw new Error('probe host mismatch');
  return outer;
}

async function enforceRateLimit(request: Request, role: string, deps: ControlServiceDeps): Promise<Response | null> {
  try {
    const clientIp = request.headers.get('cf-connecting-ip');
    const rateIdentity =
      clientIp !== null && /^[0-9A-Fa-f:.]{2,45}$/.test(clientIp) ? clientIp.toLowerCase() : 'unidentified-client';
    const key = `${role}:${rateIdentity}`;
    if (!(await deps.rateLimiter.limit({ key })).success) return json(429, { error: 'rate-limited' });
    return null;
  } catch {
    return json(503, { error: 'rate-limit-unavailable' });
  }
}

async function auditResponse(
  request: Request,
  hostSegment: string,
  config: RegistryServiceConfig,
  deps: ControlServiceDeps,
): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' });
  let host: string;
  try {
    host = decodeURIComponent(hostSegment);
  } catch {
    return json(400, { error: 'invalid-request' });
  }
  const url = new URL(request.url);
  const after = url.searchParams.get('afterRecoverySequence') ?? '0';
  if (
    [...url.searchParams.keys()].some((key) => key !== 'afterRecoverySequence') ||
    !NON_NEGATIVE_DECIMAL.test(after) ||
    host !== normalizeHost(host) ||
    encodeURIComponent(host) !== hostSegment
  ) {
    return json(400, { error: 'invalid-request' });
  }
  const limited = await enforceRateLimit(request, 'audit', deps);
  if (limited !== null) return limited;
  await authenticateAudit(request, config, deps);
  try {
    const result = await deps.hostRegistry.getByName(host, { locationHint: REGISTRY_LOCATION_HINT }).audit(after);
    if (!result.ok) return json(400, { error: 'invalid-audit-cursor' });
    return json(200, result.page as unknown as Record<string, unknown>);
  } catch {
    return json(503, { error: 'audit-unavailable' });
  }
}

async function recoveryResponse(
  request: Request,
  config: RegistryServiceConfig,
  deps: ControlServiceDeps,
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
  let parsed: Awaited<ReturnType<typeof readExactJson>>;
  try {
    parsed = await readExactJson(request, RECOVERY_MAX_BYTES);
  } catch (response) {
    return response instanceof Response
      ? new Response(response.body, {
          status: response.status,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        })
      : json(400, { error: 'invalid-request' });
  }
  const limited = await enforceRateLimit(request, 'recovery', deps);
  if (limited !== null) return limited;
  let recovery: RecoveryRequest;
  try {
    recovery = parseRecovery(parsed.value);
  } catch {
    return json(400, { error: 'invalid-request' });
  }
  const authenticated = await authenticateRequest(request, 'recovery', parsed.bodyDigest, config, deps);
  await authenticateSourceAttestation(request, authenticated.record, recovery, config, deps);
  try {
    const namespace = recovery.host.endsWith('.fiveacross.app')
      ? ('fiveacross.app' as const)
      : recovery.host.endsWith('.vacaybingo.com')
        ? ('vacaybingo.com' as const)
        : null;
    const recoveryZone = namespace === null ? undefined : config.recoveryZones?.[namespace];
    if (namespace === null || recoveryZone === undefined) {
      throw new Error('recovery zone configuration unavailable');
    }
    const result = await deps.hostRegistry
      .getByName(recovery.host, { locationHint: REGISTRY_LOCATION_HINT })
      .recover(recovery, {
        now: deps.now(),
        operatorSub: authenticated.record.subject,
        operatorKeyVersion: authenticated.record.keyVersion,
        operatorKeyFingerprint: authenticated.record.spkiSha256,
        operatorSignature: authenticated.signature,
        operatorSignatureScheme: authenticated.signatureScheme,
        operatorSignedRole: 'recovery',
        operatorSignedMethod: 'POST',
        operatorSignedPath: authenticated.signedPath,
        operatorIssuedAt: authenticated.issuedAtRaw,
        requestBodyDigest: parsed.bodyDigest,
        lockId: deps.randomId(),
        expectedWafZone: { namespace, ...recoveryZone },
        // Omission is never evidence. This endpoint has no independent
        // trusted-publisher proof channel, so every recovery apply requires
        // the separately signed replacement evidence.
        publisherIntegrityProven: false,
        activeRegistryConfigDigest: await verificationRecordMappingDigest(config.verificationRecords),
        activePublisherMappings: publisherVerificationMappings(config.verificationRecords),
      });
    if (!result.ok) return json(409, { error: 'recovery-refused' });
    return json(200, { sequence: result.sequence, action: result.action });
  } catch {
    return json(503, { error: 'recovery-unavailable' });
  }
}

async function probeResponse(
  request: Request,
  kind: 'challenge' | 'attest',
  config: RegistryServiceConfig,
  deps: ControlServiceDeps,
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
  let parsed: Awaited<ReturnType<typeof readExactJson>>;
  try {
    parsed = await readExactJson(request, RECOVERY_MAX_BYTES);
  } catch (response) {
    return response instanceof Response
      ? new Response(response.body, {
          status: response.status,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        })
      : json(400, { error: 'invalid-request' });
  }
  const limited = await enforceRateLimit(request, `probe-${kind}`, deps);
  if (limited !== null) return limited;
  let probe: Record<string, unknown>;
  try {
    probe = parseProbePayload(parsed.value, kind);
  } catch {
    return json(400, { error: 'invalid-request' });
  }
  const host = probe.host as string;
  if (host !== normalizeHost(host) || host.endsWith('.')) {
    return json(400, { error: 'invalid-request' });
  }
  const { record } = await authenticateRequest(request, 'regional-probe', parsed.bodyDigest, config, deps);
  const principal: ProbePrincipal = {
    subject: record.subject,
    keyVersion: record.keyVersion,
    keyFingerprint: record.spkiSha256,
    region: record.epochOrSlot,
  };
  try {
    const stub = deps.hostRegistry.getByName(host, {
      locationHint: REGISTRY_LOCATION_HINT,
    });
    if (kind === 'challenge') {
      const result = await stub.issueProbeChallenge(
        probe as unknown as ProbeChallengeRequest,
        principal,
        deps.now(),
        deps.randomId(),
      );
      if (!result.ok) return json(409, { error: 'probe-refused' });
      return json(200, result.challenge as unknown as Record<string, unknown>);
    }
    const result = await stub.attestProbe(
      probe.observation as ProbeObservation,
      principal,
      deps.now(),
      deps.randomId(),
    );
    if (!result.ok) return json(409, { error: 'probe-refused' });
    return json(200, { attestationId: result.attestation.id });
  } catch {
    return json(503, { error: 'probe-unavailable' });
  }
}

export async function handleControlFetch(
  request: Request,
  config: RegistryServiceConfig,
  deps: ControlServiceDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  try {
    if (url.pathname === RECOVERY_PATH && url.search === '') {
      return await recoveryResponse(request, config, deps);
    }
    if (url.pathname === PROBE_CHALLENGE_PATH && url.search === '') {
      return await probeResponse(request, 'challenge', config, deps);
    }
    if (url.pathname === PROBE_ATTEST_PATH && url.search === '') {
      return await probeResponse(request, 'attest', config, deps);
    }
    if (url.pathname.startsWith(AUDIT_PREFIX)) {
      const hostSegment = url.pathname.slice(AUDIT_PREFIX.length);
      if (hostSegment.length > 0 && !hostSegment.includes('/')) {
        return await auditResponse(request, hostSegment, config, deps);
      }
    }
    return null;
  } catch (error) {
    if (error instanceof ControlAuthUnavailableError) {
      return json(503, { error: 'identity-verification-unavailable' });
    }
    return json(401, { error: 'unauthorized' });
  }
}
