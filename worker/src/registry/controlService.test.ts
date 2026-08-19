// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SYNC_PATH } from './contracts';
import { findSourceRecord, PROBE_CHALLENGE_PATH } from './controlService';
import type { VerificationRecord } from './keys';
import type { SourceAudit } from './recovery';
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
});
