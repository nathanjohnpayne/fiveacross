// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authenticatePinnedRole } from './controlAuth';
import type { VerificationRecord, VerificationRole } from './keys';
import { GoogleJwksCache } from './oidc';

const NOW = Date.parse('2026-08-19T13:00:00.000Z');

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
  const oidcJwk = { ...(await crypto.subtle.exportKey('jwk', oidc.publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' };
  const cache = new GoogleJwksCache({
    fetch: async () => new Response(JSON.stringify({ keys: [oidcJwk] })),
    now: () => NOW,
  });
  const roleKey = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey('spki', roleKey.publicKey)) as ArrayBuffer;
  const record: VerificationRecord = {
    role: 'recovery',
    subject: 'recovery-sub',
    epochOrSlot: 'primary',
    keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/recovery/cryptoKeyVersions/1',
    algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
    pem: pem(spki),
    spkiSha256: createHash('sha256').update(Buffer.from(spki)).digest('hex'),
  };
  const audience = 'https://registry.example/recover';
  const header = base64url(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: audience, sub: record.subject, iat: NOW / 1_000 - 10, exp: NOW / 1_000 + 300 }));
  const input = `${header}.${claims}`;
  const jwtSignature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', oidc.privateKey, new TextEncoder().encode(input));
  return { cache, record, roleKey, audience, token: `${input}.${base64url(jwtSignature)}` };
}

async function signed(data: Awaited<ReturnType<typeof fixture>>, role: VerificationRole = 'recovery') {
  const exactBytes = new TextEncoder().encode('v1\nrecovery\nPOST\n/recover\nbody-digest');
  const signature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', data.roleKey.privateKey, exactBytes)).toString('base64');
  return authenticatePinnedRole(
    {
      role,
      slot: 'primary',
      keyVersion: data.record.keyVersion,
      token: data.token,
      signature,
      issuedAt: NOW,
      exactBytes,
      audience: data.audience,
    },
    { now: NOW, jwks: data.cache, verificationRecords: [data.record] },
  );
}

describe('control-plane role authentication', () => {
  it('requires the exact role/slot/version OIDC subject and pinned signing key', async () => {
    const data = await fixture();
    await expect(signed(data)).resolves.toEqual(data.record);
  });

  it('refuses cross-role use even when the token and signature are otherwise valid', async () => {
    const data = await fixture();
    await expect(signed(data, 'source-attestor')).rejects.toThrow('unauthorized');
  });

  it('refuses stale signatures and a different exact request body', async () => {
    const data = await fixture();
    const exactBytes = new TextEncoder().encode('different');
    const signature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', data.roleKey.privateKey, new TextEncoder().encode('original'))).toString('base64');
    await expect(
      authenticatePinnedRole(
        {
          role: 'recovery',
          slot: 'primary',
          keyVersion: data.record.keyVersion,
          token: data.token,
          signature,
          issuedAt: NOW - 60_001,
          exactBytes,
          audience: data.audience,
        },
        { now: NOW, jwks: data.cache, verificationRecords: [data.record] },
      ),
    ).rejects.toThrow('unauthorized');
  });
});
