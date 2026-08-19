import { normalizeHost } from '../host';
import { REGISTRY_LOCATION_HINT, parseSyncRequest } from './contracts';
import {
  ControlAuthUnavailableError,
  authenticatePinnedRole,
  type PinnedRoleRequest,
} from './controlAuth';
import {
  verificationRecordMappingDigest,
  type VerificationRecord,
} from './keys';
import { JwksUnavailableError, verifyGoogleOidc, type JwksResolver } from './oidc';
import type { ProbeObservation, ProbePhase, ProbePrincipal } from './probe';
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
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
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

async function readExactJson(request: Request, maximum: number): Promise<{ body: string; value: unknown }> {
  if (request.headers.get('content-type') !== 'application/json') {
    throw new Response(JSON.stringify({ error: 'unsupported-media-type' }), { status: 415 });
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maximum)) {
    throw new Response(JSON.stringify({ error: 'request-too-large' }), { status: 413 });
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maximum) {
    throw new Response(JSON.stringify({ error: 'request-too-large' }), { status: 413 });
  }
  let body: string;
  let value: unknown;
  try {
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    value = JSON.parse(body);
  } catch {
    throw new Response(JSON.stringify({ error: 'invalid-request' }), { status: 400 });
  }
  return { body, value };
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
  body: string,
  config: RegistryServiceConfig,
  deps: ControlServiceDeps,
): Promise<VerificationRecord> {
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
    ['v1', role, request.method, `${url.pathname}${url.search}`, issuedAtRaw, await sha256Hex(body)].join('\n'),
  );
  return authenticatePinnedRole(
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
    { now: deps.now(), jwks: deps.jwks, verificationRecords: config.verificationRecords },
  );
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

function findSourceRecord(
  audit: SourceAudit,
  records: readonly VerificationRecord[],
): VerificationRecord | undefined {
  return records.find(
    (record) =>
      record.role === 'source-attestor' &&
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
    { now: deps.now(), jwks: deps.jwks, verificationRecords: config.verificationRecords },
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
      { now: deps.now(), jwks: deps.jwks, verificationRecords: config.verificationRecords },
    );
  }
}

function parseRecovery(value: unknown): RecoveryRequest {
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
  parseSyncRequest(JSON.stringify(source.ledgerPayload), 'application/json');
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
  return value as unknown as RecoveryRequest;
}

async function enforceRateLimit(request: Request, role: string, deps: ControlServiceDeps): Promise<Response | null> {
  try {
    const key = `${role}:${await sha256Hex(request.headers.get('authorization') ?? '')}`;
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
    const result = await deps.hostRegistry
      .getByName(host, { locationHint: REGISTRY_LOCATION_HINT })
      .audit(after);
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
  let parsed: { body: string; value: unknown };
  try {
    parsed = await readExactJson(request, RECOVERY_MAX_BYTES);
  } catch (response) {
    return response instanceof Response
      ? new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
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
  const recoveryRecord = await authenticateRequest(request, 'recovery', parsed.body, config, deps);
  await authenticateSourceAttestation(request, recoveryRecord, recovery, config, deps);
  try {
    const result = await deps.hostRegistry
      .getByName(recovery.host, { locationHint: REGISTRY_LOCATION_HINT })
      .recover(recovery, {
        now: deps.now(),
        operatorSub: recoveryRecord.subject,
        lockId: deps.randomId(),
        publisherIntegrityProven:
          recovery.action.kind === 'apply' && recovery.action.publisherReplacement === null,
        activeRegistryConfigDigest: await verificationRecordMappingDigest(
          config.verificationRecords,
        ),
      });
    return json(200, result as unknown as Record<string, unknown>);
  } catch {
    return json(409, { error: 'recovery-refused' });
  }
}

async function probeResponse(
  request: Request,
  kind: 'challenge' | 'attest',
  config: RegistryServiceConfig,
  deps: ControlServiceDeps,
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
  let parsed: { body: string; value: unknown };
  try {
    parsed = await readExactJson(request, RECOVERY_MAX_BYTES);
  } catch (response) {
    return response instanceof Response
      ? new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      : json(400, { error: 'invalid-request' });
  }
  const limited = await enforceRateLimit(request, `probe-${kind}`, deps);
  if (limited !== null) return limited;
  if (!isRecord(parsed.value) || parsed.value.schemaVersion !== 1 || typeof parsed.value.host !== 'string') {
    return json(400, { error: 'invalid-request' });
  }
  const record = await authenticateRequest(request, 'regional-probe', parsed.body, config, deps);
  const principal: ProbePrincipal = {
    subject: record.subject,
    keyVersion: record.keyVersion,
    keyFingerprint: record.spkiSha256,
    region: record.epochOrSlot,
  };
  const host = parsed.value.host;
  try {
    const stub = deps.hostRegistry.getByName(host, { locationHint: REGISTRY_LOCATION_HINT });
    if (kind === 'challenge') {
      if (
        !hasExactKeys(parsed.value, ['schemaVersion', 'host', 'phase', 'expectedStateDigest']) ||
        (parsed.value.phase !== 'blocked-before-worker' && parsed.value.phase !== 'canonical-after-unblock') ||
        typeof parsed.value.expectedStateDigest !== 'string' ||
        !SHA256_HEX.test(parsed.value.expectedStateDigest)
      ) {
        return json(400, { error: 'invalid-request' });
      }
      const challenge = await stub.issueProbeChallenge(
        {
          host,
          phase: parsed.value.phase as ProbePhase,
          expectedStateDigest: parsed.value.expectedStateDigest,
        },
        principal,
        deps.now(),
        deps.randomId(),
      );
      return json(200, challenge as unknown as Record<string, unknown>);
    }
    if (!hasExactKeys(parsed.value, ['schemaVersion', 'host', 'observation']) || !isRecord(parsed.value.observation)) {
      return json(400, { error: 'invalid-request' });
    }
    const attestation = await stub.attestProbe(
      parsed.value.observation as ProbeObservation,
      principal,
      deps.now(),
      deps.randomId(),
    );
    return json(200, { attestationId: attestation.id });
  } catch {
    return json(409, { error: 'probe-refused' });
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
