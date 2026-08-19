// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SYNC_PATH } from './contracts';
import type { VerificationRecord } from './keys';
import { GoogleJwksCache } from './oidc';
import { handleRegistryFetch, type RegistryServiceConfig, type RegistryServiceDeps } from './service';

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

async function fixture() {
  const oidc = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const signing = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const oidcJwk = { ...(await crypto.subtle.exportKey('jwk', oidc.publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' };
  const spki = (await crypto.subtle.exportKey('spki', signing.publicKey)) as ArrayBuffer;
  const record: VerificationRecord = {
    role: 'audit',
    subject: 'audit-subject',
    epochOrSlot: 'primary',
    keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/audit/cryptoKeyVersions/1',
    algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
    pem: pem(spki),
    spkiSha256: createHash('sha256').update(Buffer.from(spki)).digest('hex'),
  };
  const header = base64url(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: AUDIT_AUDIENCE, sub: record.subject, iat: NOW / 1_000 - 10, exp: NOW / 1_000 + 300 }));
  const jwtInput = `${header}.${claims}`;
  const jwtSignature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', oidc.privateKey, new TextEncoder().encode(jwtInput));
  return {
    signing,
    record,
    token: `${jwtInput}.${base64url(jwtSignature)}`,
    jwks: new GoogleJwksCache({ fetch: async () => new Response(JSON.stringify({ keys: [oidcJwk] })), now: () => NOW }),
  };
}

async function auditRequest(data: Awaited<ReturnType<typeof fixture>>) {
  const path = `${SYNC_PATH}/${HOST}?afterRecoverySequence=0`;
  const digest = createHash('sha256').update('').digest('hex');
  const exact = `v1\naudit\nGET\n${path}\n${NOW}\n${digest}`;
  const signature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', data.signing.privateKey, new TextEncoder().encode(exact))).toString('base64');
  return new Request(AUDIT_URL, {
    headers: {
      authorization: `Bearer ${data.token}`,
      'x-registry-role-slot': 'primary',
      'x-registry-key-version': data.record.keyVersion,
      'x-registry-issued-at': String(NOW),
      'x-registry-body-signature': signature,
    },
  });
}

function harness(data: Awaited<ReturnType<typeof fixture>>) {
  const audit = vi.fn(async () => ({
    committed: null,
    minimumPublisherEpoch: '1',
    highestAuthenticatedPublisherEpoch: '0',
    highestQuarantinedPublisherEpoch: '0',
    recoveryLock: null,
    lookup: { kind: 'unknown-host' as const },
    records: [],
    nextAfter: null,
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
    roleAudiences: { audit: AUDIT_AUDIENCE },
    verificationRecords: [data.record],
  };
  const deps: RegistryServiceDeps = {
    now: () => NOW,
    jwks: data.jwks,
    hostRegistry: { getByName },
    rateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    randomId: () => 'random-id',
  };
  return { config, deps, audit, getByName };
}

describe('registry default fetch control-plane endpoints', () => {
  it('serves only an authenticated point audit at immutable wnam placement', async () => {
    const data = await fixture();
    const test = harness(data);
    const response = await handleRegistryFetch(await auditRequest(data), test.config, test.deps);
    expect(response.status).toBe(200);
    expect(test.getByName).toHaveBeenCalledExactlyOnceWith(HOST, { locationHint: 'wnam' });
    expect(test.audit).toHaveBeenCalledExactlyOnceWith('0');
    expect(JSON.stringify(await response.json())).not.toContain('payload');
  });

  it('rejects malformed cursor and wrong methods before any DO access', async () => {
    const data = await fixture();
    const test = harness(data);
    const malformed = new Request(`${ORIGIN}${SYNC_PATH}/${HOST}?afterRecoverySequence=01`);
    expect((await handleRegistryFetch(malformed, test.config, test.deps)).status).toBe(400);
    const wrongMethod = new Request(`${ORIGIN}${SYNC_PATH}/${HOST}`, { method: 'POST' });
    expect((await handleRegistryFetch(wrongMethod, test.config, test.deps)).status).toBe(405);
    expect(test.getByName).not.toHaveBeenCalled();
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
});
