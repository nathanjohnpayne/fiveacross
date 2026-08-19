import {
  REGISTRY_LOCATION_HINT,
  SYNC_MAX_BYTES,
  SYNC_PATH,
  parseSyncRequest,
  type RouterReplicaDesired,
} from './contracts';
import { validateVerificationRecords, verifyPinnedSignature, type VerificationRecord } from './keys';
import { JwksUnavailableError, verifyGoogleOidc, type JwksResolver } from './oidc';
import type { SyncResponse } from './state';
import type { RegistryAuditPage } from './audit';
import type { ProbeAttestation, ProbeChallenge, ProbeObservation, ProbePhase, ProbePrincipal } from './probe';
import type { RecoveryRecord, RecoveryRequest } from './recovery';
import { handleControlFetch } from './controlService';

const MAX_SIGNATURE_AGE_MS = 60_000;
const CANONICAL_POSITIVE_DECIMAL = /^[1-9]\d*$/;
const KMS_KEY_VERSION =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/;
const SYNC_RESULTS = new Set([
  'applied',
  'replay',
  'ignored-stale',
  'revision-conflict',
  'revision-gap',
  'recovery-locked',
  'publisher-epoch-rejected',
  'tombstone-final',
]);

export type HostRegistryStub = {
  sync(payload: RouterReplicaDesired, publisherEpoch: string): Promise<SyncResponse>;
  audit(
    afterRecoverySequence?: string,
  ): Promise<{ ok: true; page: RegistryAuditPage } | { ok: false; error: 'invalid-cursor' }>;
  recover(
    request: RecoveryRequest,
    context: {
      now: number;
      operatorSub: string;
      lockId: string;
      publisherIntegrityProven?: boolean;
      activeRegistryConfigDigest?: string;
    },
  ): Promise<
    { ok: true; sequence: string; action: RecoveryRecord['action'] } | { ok: false; error: 'recovery-refused' }
  >;
  issueProbeChallenge(
    request: { host: string; phase: ProbePhase; expectedStateDigest: string },
    principal: ProbePrincipal,
    now: number,
    nonce: string,
  ): Promise<{ ok: true; challenge: ProbeChallenge } | { ok: false; error: 'probe-refused' }>;
  attestProbe(
    observation: ProbeObservation,
    principal: ProbePrincipal,
    now: number,
    attestationId: string,
  ): Promise<{ ok: true; attestation: ProbeAttestation } | { ok: false; error: 'probe-refused' }>;
};

export type HostRegistryNamespace = {
  getByName(host: string, options: { locationHint: typeof REGISTRY_LOCATION_HINT }): HostRegistryStub;
};

export type RegistryRateLimiter = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type RegistryServiceConfig = {
  audience: string;
  verificationRecords: readonly VerificationRecord[];
  auditSubject?: string;
  roleAudiences?: Partial<Record<'audit' | 'recovery' | 'source-attestor' | 'regional-probe', string>>;
};

export type RegistryServiceDeps = {
  now: () => number;
  jwks: JwksResolver;
  hostRegistry: HostRegistryNamespace;
  rateLimiter: RegistryRateLimiter;
  randomId?: () => string;
};

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization === null) return null;
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function isSyncResponse(value: unknown): value is SyncResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 2 &&
    typeof candidate.status === 'number' &&
    [200, 401, 409, 503].includes(candidate.status) &&
    typeof candidate.result === 'string' &&
    SYNC_RESULTS.has(candidate.result)
  );
}

async function syncResponse(
  request: Request,
  config: RegistryServiceConfig,
  deps: RegistryServiceDeps,
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
  if (request.headers.get('content-type') !== 'application/json') {
    return json(415, { error: 'unsupported-media-type' });
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > 2_048n) {
    return json(413, { error: 'request-too-large' });
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    return json(400, { error: 'invalid-request' });
  }
  if (bytes.byteLength > SYNC_MAX_BYTES) return json(413, { error: 'request-too-large' });
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return json(400, { error: 'invalid-request' });
  }

  try {
    const clientIp = request.headers.get('cf-connecting-ip');
    const rateIdentity =
      clientIp !== null && /^[0-9A-Fa-f:.]{2,45}$/.test(clientIp) ? clientIp.toLowerCase() : 'unidentified-client';
    const rateKey = `sync:${rateIdentity}`;
    if (!(await deps.rateLimiter.limit({ key: rateKey })).success) {
      return json(429, { error: 'rate-limited' });
    }
  } catch {
    return json(503, { error: 'rate-limit-unavailable' });
  }

  let payload: RouterReplicaDesired;
  try {
    payload = parseSyncRequest(body, request.headers.get('content-type'));
  } catch {
    return json(400, { error: 'invalid-request' });
  }

  const epoch = request.headers.get('x-registry-publisher-epoch');
  const keyVersion = request.headers.get('x-registry-key-version');
  const issuedAtRaw = request.headers.get('x-registry-issued-at');
  const signature = request.headers.get('x-registry-body-signature');
  const token = bearerToken(request);
  if (
    epoch === null ||
    !CANONICAL_POSITIVE_DECIMAL.test(epoch) ||
    keyVersion === null ||
    !KMS_KEY_VERSION.test(keyVersion) ||
    issuedAtRaw === null ||
    !CANONICAL_POSITIVE_DECIMAL.test(issuedAtRaw) ||
    signature === null ||
    token === null
  ) {
    return json(401, { error: 'unauthorized' });
  }
  const issuedAt = Number(issuedAtRaw);
  const now = deps.now();
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(now) ||
    Math.abs(now - issuedAt) > MAX_SIGNATURE_AGE_MS
  ) {
    return json(401, { error: 'unauthorized' });
  }

  let records: readonly VerificationRecord[];
  try {
    records = await validateVerificationRecords(config.verificationRecords);
  } catch {
    return json(503, { error: 'configuration-unavailable' });
  }
  const record = records.find(
    (candidate) =>
      candidate.role === 'publisher' && candidate.epochOrSlot === epoch && candidate.keyVersion === keyVersion,
  );
  if (record === undefined) return json(401, { error: 'unauthorized' });

  try {
    await verifyGoogleOidc(token, { audience: config.audience, subject: record.subject }, deps.jwks, now);
  } catch (error) {
    if (error instanceof JwksUnavailableError) {
      return json(503, { error: 'identity-verification-unavailable' });
    }
    return json(401, { error: 'unauthorized' });
  }

  const exactSignatureInput = new TextEncoder().encode(
    ['v1', 'POST', SYNC_PATH, issuedAtRaw, epoch, await sha256Hex(body)].join('\n'),
  );
  if (!(await verifyPinnedSignature(record, exactSignatureInput, signature))) {
    return json(401, { error: 'unauthorized' });
  }

  try {
    const stub = deps.hostRegistry.getByName(payload.host, {
      locationHint: REGISTRY_LOCATION_HINT,
    });
    const result = await stub.sync(payload, epoch);
    if (!isSyncResponse(result)) return json(503, { error: 'registry-state-unavailable' });
    return json(result.status, { result: result.result });
  } catch {
    return json(503, { error: 'registry-state-unavailable' });
  }
}

export async function handleRegistryFetch(
  request: Request,
  config: RegistryServiceConfig,
  deps: RegistryServiceDeps,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === SYNC_PATH && url.search === '') return syncResponse(request, config, deps);
  const control = await handleControlFetch(request, config, {
    ...deps,
    randomId: deps.randomId ?? (() => crypto.randomUUID()),
  });
  return control ?? json(404, { error: 'not-found' });
}
