// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SYNC_PATH } from './contracts';
import { findSourceRecord, parseProbePayload, PROBE_CHALLENGE_PATH, RECOVERY_PATH } from './controlService';
import type { VerificationRecord } from './keys';
import type { RecoveryRequest, SourceAudit } from './recovery';
import { GoogleJwksCache } from './oidc';
import {
  handleRegistryFetch,
  type HostRegistryStub,
  type RegistryServiceConfig,
  type RegistryServiceDeps,
} from './service';

const NOW = Date.parse('2026-08-19T13:00:00.000Z');
const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const ORIGIN = 'https://registry.example';
const AUDIT_AUDIENCE = `${ORIGIN}/audit-audience`;
const AUDIT_URL = `${ORIGIN}${SYNC_PATH}/${HOST}?afterRecoverySequence=0`;

function base64url(value: string | ArrayBuffer): string {
  return Buffer.from(value instanceof ArrayBuffer ? value : value).toString('base64url');
}

function pem(spki: ArrayBuffer): string {
  const body = Buffer.from(spki).toString('base64').match(/.{1,64}/g)?.join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

async function fixture() {
  const oidc = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const oidcJwk = {
    ...(await crypto.subtle.exportKey('jwk', oidc.publicKey)),
    kid: 'kid-1',
    alg: 'RS256',
    use: 'sig',
  };
  const subject = 'audit-subject';
  const header = base64url(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: AUDIT_AUDIENCE,
      sub: subject,
      iat: NOW / 1_000 - 10,
      exp: NOW / 1_000 + 300,
    }),
  );
  const jwtInput = `${header}.${claims}`;
  const jwtSignature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    oidc.privateKey,
    new TextEncoder().encode(jwtInput),
  );
  return {
    subject,
    token: `${jwtInput}.${base64url(jwtSignature)}`,
    jwks: new GoogleJwksCache({
      fetch: async () => new Response(JSON.stringify({ keys: [oidcJwk] })),
      now: () => NOW,
    }),
  };
}

async function auditRequest(data: Awaited<ReturnType<typeof fixture>>, token = data.token, clientIp = '203.0.113.9') {
  return new Request(AUDIT_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      'cf-connecting-ip': clientIp,
    },
  });
}

function harness(data: Awaited<ReturnType<typeof fixture>>) {
  const audit = vi.fn<HostRegistryStub['audit']>(async () => ({
    ok: true as const,
    page: {
      committed: null,
      minimumPublisherEpoch: '1',
      highestAuthenticatedPublisherEpoch: '0',
      highestQuarantinedPublisherEpoch: '0',
      recoveryLock: null,
      lookup: { kind: 'unknown-host' as const },
      records: [],
      nextAfter: null,
    },
  }));
  const getByName = vi.fn(() => ({
    audit,
    sync: vi.fn(),
    recover: vi.fn(),
    issueProbeChallenge: vi.fn(),
    attestProbe: vi.fn(),
  }));
  const config: RegistryServiceConfig = {
    audience: `${ORIGIN}${SYNC_PATH}`,
    auditSubject: data.subject,
    roleAudiences: { audit: AUDIT_AUDIENCE },
    verificationRecords: [],
  };
  const limit = vi.fn(async () => ({ success: true }));
  const deps: RegistryServiceDeps = {
    now: () => NOW,
    jwks: data.jwks,
    hostRegistry: { getByName },
    rateLimiter: { limit },
    randomId: () => 'random-id',
  };
  return { config, deps, audit, getByName, limit };
}

describe('registry default fetch control-plane endpoints', () => {
  it('binds source-attestor attribution to the authenticated pinned subject', () => {
    const record = {
      role: 'source-attestor',
      subject: 'source-subject-1',
      epochOrSlot: 'source',
      keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/source/cryptoKeyVersions/1',
      algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
      pem: 'unused in record selection',
      spkiSha256: 'a'.repeat(64),
    } satisfies VerificationRecord;
    const audit = {
      attestorSub: 'forged-source-subject',
      attestorKeyVersion: record.keyVersion,
      attestorKeyFingerprint: record.spkiSha256,
    } as SourceAudit;
    expect(findSourceRecord(audit, [record])).toBeUndefined();
    expect(findSourceRecord({ ...audit, attestorSub: record.subject }, [record])).toBe(record);
  });

  it('serves only an authenticated point audit at immutable wnam placement', async () => {
    const data = await fixture();
    const test = harness(data);
    const response = await handleRegistryFetch(await auditRequest(data), test.config, test.deps);
    expect(response.status).toBe(200);
    expect(test.getByName).toHaveBeenCalledExactlyOnceWith(HOST, {
      locationHint: 'wnam',
    });
    expect(test.audit).toHaveBeenCalledExactlyOnceWith('0');
    expect(JSON.stringify(await response.json())).not.toContain('payload');
  });

  it('rejects malformed cursor and wrong methods before any DO access', async () => {
    const data = await fixture();
    const test = harness(data);
    const malformed = new Request(`${ORIGIN}${SYNC_PATH}/${HOST}?afterRecoverySequence=01`);
    expect((await handleRegistryFetch(malformed, test.config, test.deps)).status).toBe(400);
    const wrongMethod = new Request(`${ORIGIN}${SYNC_PATH}/${HOST}`, {
      method: 'POST',
    });
    expect((await handleRegistryFetch(wrongMethod, test.config, test.deps)).status).toBe(405);
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('distinguishes an unknown-ahead cursor from a retryable storage failure', async () => {
    const data = await fixture();
    const unknownAhead = harness(data);
    unknownAhead.audit.mockResolvedValueOnce({
      ok: false as const,
      error: 'invalid-cursor' as const,
    });
    expect((await handleRegistryFetch(await auditRequest(data), unknownAhead.config, unknownAhead.deps)).status).toBe(
      400,
    );

    const unavailable = harness(data);
    unavailable.audit.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await handleRegistryFetch(await auditRequest(data), unavailable.config, unavailable.deps)).status).toBe(
      503,
    );
  });

  it('rate-limits control callers by Cloudflare client IP rather than rotating bearer bytes', async () => {
    const data = await fixture();
    const test = harness(data);
    await handleRegistryFetch(await auditRequest(data), test.config, test.deps);
    await handleRegistryFetch(await auditRequest(data, 'different.invalid.token'), test.config, test.deps);
    expect(test.limit).toHaveBeenNthCalledWith(1, { key: 'audit:203.0.113.9' });
    expect(test.limit).toHaveBeenNthCalledWith(2, { key: 'audit:203.0.113.9' });
  });

  it('enforces the exact 16 KiB recovery bound before identity or storage work', async () => {
    const data = await fixture();
    const test = harness(data);
    const response = await handleRegistryFetch(
      new Request(`${ORIGIN}${SYNC_PATH}/recover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(16 * 1_024) }),
      }),
      test.config,
      test.deps,
    );
    expect(response.status).toBe(413);
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it.each([
    ['UTF-8 BOM', Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])],
    ['invalid UTF-8', Uint8Array.from([0xc3, 0x28])],
  ])('rejects %s in a control body before identity or storage work', async (_label, body) => {
    const data = await fixture();
    const test = harness(data);
    const response = await handleRegistryFetch(
      new Request(`${ORIGIN}${PROBE_CHALLENGE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      test.config,
      test.deps,
    );
    expect(response.status).toBe(400);
    expect(test.limit).not.toHaveBeenCalled();
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('threads exact recovery authorization provenance without retaining either OIDC token', async () => {
    const oidc = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const oidcJwk = {
      ...(await crypto.subtle.exportKey('jwk', oidc.publicKey)),
      kid: 'recovery-kid',
      alg: 'RS256',
      use: 'sig',
    };
    const role = async (name: 'recovery' | 'source-attestor', subject: string, slot: string) => {
      const key = (await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
      const spki = (await crypto.subtle.exportKey('spki', key.publicKey)) as ArrayBuffer;
      return {
        key,
        record: {
          role: name,
          subject,
          epochOrSlot: slot,
          keyVersion: `projects/p/locations/l/keyRings/r/cryptoKeys/${name}/cryptoKeyVersions/1`,
          algorithm: 'RSA_SIGN_PKCS1_2048_SHA256' as const,
          pem: pem(spki),
          spkiSha256: createHash('sha256').update(Buffer.from(spki)).digest('hex'),
        } satisfies VerificationRecord,
      };
    };
    const recoveryRole = await role('recovery', 'recovery-subject', 'primary');
    const sourceRole = await role('source-attestor', 'source-subject', 'source');
    const recoveryAudience = `${ORIGIN}/recovery-audience`;
    const sourceAudience = `${ORIGIN}/source-audience`;
    const token = async (subject: string, audience: string) => {
      const header = base64url(JSON.stringify({ alg: 'RS256', kid: 'recovery-kid', typ: 'JWT' }));
      const claims = base64url(
        JSON.stringify({
          iss: 'https://accounts.google.com',
          aud: audience,
          sub: subject,
          iat: NOW / 1_000 - 10,
          exp: NOW / 1_000 + 300,
        }),
      );
      const input = `${header}.${claims}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        oidc.privateKey,
        new TextEncoder().encode(input),
      );
      return `${input}.${base64url(signature)}`;
    };
    const recoveryToken = await token(recoveryRole.record.subject, recoveryAudience);
    const sourceToken = await token(sourceRole.record.subject, sourceAudience);
    const ledgerPayload = {
      schemaVersion: 1 as const,
      revision: '1',
      host: HOST,
      desired: {
        kind: 'route' as const,
        eventId: 'synthetic-event',
        status: 'disabled' as const,
        slug: 'r2-abcdefghijklmnopqrstuvwxyz',
        edition: 'fiveacross' as const,
        pathNamespace: null,
      },
      updatedAt: new Date(NOW - 1_000).toISOString(),
    };
    const canonicalProjection = {
      sourceDocumentDigest: 'a'.repeat(64),
      host: HOST,
      desired: ledgerPayload.desired,
    };
    const auditDigest = 'b'.repeat(64);
    const observedAt = new Date(NOW - 5_000).toISOString();
    const attestationIssuedAt = new Date(NOW - 1_000).toISOString();
    const sourceSignatureInput = [
      'v1',
      'source-audit',
      HOST,
      '1',
      auditDigest,
      observedAt,
      attestationIssuedAt,
      createHash('sha256').update(canonicalJson(canonicalProjection)).digest('hex'),
      createHash('sha256').update(canonicalJson(ledgerPayload)).digest('hex'),
      canonicalProjection.sourceDocumentDigest,
      'c'.repeat(64),
    ].join('\n');
    const sourceSignature = Buffer.from(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        sourceRole.key.privateKey,
        new TextEncoder().encode(sourceSignatureInput),
      ),
    ).toString('base64');
    const recovery: RecoveryRequest = {
      schemaVersion: 1,
      host: HOST,
      expectedCommitted: null,
      sourceAudit: {
        revision: '1',
        digest: auditDigest,
        observedAt,
        canonicalProjection,
        ledgerPayload,
        ledgerDocumentDigest: 'c'.repeat(64),
        attestorSub: sourceRole.record.subject,
        attestorKeyVersion: sourceRole.record.keyVersion,
        attestorKeyFingerprint: sourceRole.record.spkiSha256,
        attestationIssuedAt,
        attestationSignature: sourceSignature,
      },
      action: { kind: 'apply', lockId: 'lock-1', publisherReplacement: null },
      incidentUrl: 'https://example.com/incidents/1',
      reason: 'restore café route',
    };
    const rawBody = new TextEncoder().encode(JSON.stringify(recovery));
    const bodyDigest = createHash('sha256').update(rawBody).digest('hex');
    const recoverySignatureInput = ['v1', 'recovery', 'POST', RECOVERY_PATH, String(NOW), bodyDigest].join('\n');
    const recoverySignature = Buffer.from(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        recoveryRole.key.privateKey,
        new TextEncoder().encode(recoverySignatureInput),
      ),
    ).toString('base64');
    const recover = vi.fn<HostRegistryStub['recover']>(async () => ({
      ok: true as const,
      sequence: '1',
      action: 'apply' as const,
    }));
    const config: RegistryServiceConfig = {
      audience: `${ORIGIN}${SYNC_PATH}`,
      verificationRecords: [recoveryRole.record, sourceRole.record],
      roleAudiences: { recovery: recoveryAudience, 'source-attestor': sourceAudience },
    };
    const deps: RegistryServiceDeps = {
      now: () => NOW,
      jwks: new GoogleJwksCache({
        fetch: async () => new Response(JSON.stringify({ keys: [oidcJwk] })),
        now: () => NOW,
      }),
      hostRegistry: {
        getByName: () => ({
          sync: vi.fn(),
          audit: vi.fn(),
          recover,
          issueProbeChallenge: vi.fn(),
          attestProbe: vi.fn(),
        }),
      },
      rateLimiter: { limit: async () => ({ success: true }) },
      randomId: () => 'recovery-lock-id',
    };
    const response = await handleRegistryFetch(
      new Request(`${ORIGIN}${RECOVERY_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${recoveryToken}`,
          'x-source-attestor-authorization': `Bearer ${sourceToken}`,
          'content-type': 'application/json',
          'x-registry-role-slot': recoveryRole.record.epochOrSlot,
          'x-registry-key-version': recoveryRole.record.keyVersion,
          'x-registry-issued-at': String(NOW),
          'x-registry-body-signature': recoverySignature,
        },
        body: rawBody,
      }),
      config,
      deps,
    );
    expect(response.status).toBe(200);
    const context = recover.mock.calls[0][1];
    expect(context).toMatchObject({
      operatorSub: recoveryRole.record.subject,
      operatorKeyVersion: recoveryRole.record.keyVersion,
      operatorKeyFingerprint: recoveryRole.record.spkiSha256,
      operatorSignature: recoverySignature,
      requestBodyDigest: bodyDigest,
    });
    expect(JSON.stringify(context)).not.toContain(recoveryToken);
    expect(JSON.stringify(context)).not.toContain(sourceToken);
  });

  it('rejects a non-canonical probe host before identity or Durable Object access', async () => {
    const data = await fixture();
    const test = harness(data);
    const response = await handleRegistryFetch(
      new Request(`${ORIGIN}${PROBE_CHALLENGE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          host: HOST.toUpperCase(),
          phase: 'blocked-before-worker',
          expectedStateDigest: 'a'.repeat(64),
        }),
      }),
      test.config,
      test.deps,
    );
    expect(response.status).toBe(400);
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('rejects extra nested probe observation fields before they can be persisted', () => {
    expect(() =>
      parseProbePayload(
        {
          schemaVersion: 1,
          host: HOST,
          observation: {
            phase: 'blocked-before-worker',
            probeNonce: 'nonce-1',
            observedAt: new Date(NOW).toISOString(),
            rayId: 'ray-1',
            host: HOST,
            requestPath: '/__registry-probe?nonce=nonce-1',
            expectedStatus: 403,
            observedStatus: 403,
            expectedBlockBodyDigest: 'a'.repeat(64),
            observedBlockBodyDigest: 'a'.repeat(64),
            leakedCredential: 'must-not-persist',
          },
        },
        'attest',
      ),
    ).toThrow('blocked probe observation');
  });
});
