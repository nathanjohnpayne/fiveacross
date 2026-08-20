// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_OIDC_ISSUER,
  GOOGLE_OIDC_JWKS_URL,
  GoogleJwksCache,
  JwksUnavailableError,
  verifyGoogleOidc,
} from './oidc';

const NOW = Date.parse('2026-08-19T13:00:00.000Z');
const POLICY = {
  audience: 'https://registry.example.workers.dev/__internal/hostname-replicas/v1',
  subject: '1001',
};

function base64url(value: string | ArrayBuffer): string {
  return Buffer.from(typeof value === 'string' ? value : value).toString('base64url');
}

async function keyFixture(kid = 'kid-1') {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, pair, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

async function tokenFor(
  fixture: Awaited<ReturnType<typeof keyFixture>>,
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  const header = base64url(
    JSON.stringify({
      alg: 'RS256',
      kid: fixture.kid,
      typ: 'JWT',
      ...headerOverrides,
    }),
  );
  const payload = base64url(
    JSON.stringify({
      iss: GOOGLE_OIDC_ISSUER,
      aud: POLICY.audience,
      sub: POLICY.subject,
      iat: Math.floor(NOW / 1_000) - 10,
      exp: Math.floor(NOW / 1_000) + 300,
      ...payloadOverrides,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    fixture.pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(signature)}`;
}

describe('Google OIDC verification', () => {
  it('pins issuer, audience, numeric subject, claims, key id, and RS256 signature', async () => {
    const fixture = await keyFixture();
    const cache = new GoogleJwksCache({
      fetch: vi.fn(async (url) => {
        expect(url).toBe(GOOGLE_OIDC_JWKS_URL);
        return new Response(JSON.stringify({ keys: [fixture.jwk] }), {
          status: 200,
        });
      }),
      now: () => NOW,
    });
    await expect(verifyGoogleOidc(await tokenFor(fixture), POLICY, cache, NOW)).resolves.toMatchObject({
      sub: '1001',
      aud: POLICY.audience,
    });
  });

  it.each([
    ['issuer', { iss: 'https://evil.example' }],
    ['audience', { aud: 'https://other.example' }],
    ['subject', { sub: '1002' }],
    ['expiry', { exp: Math.floor(NOW / 1_000) - 1 }],
    ['future issued-at', { iat: Math.floor(NOW / 1_000) + 61 }],
    ['overlong lifetime', { exp: Math.floor(NOW / 1_000) + 3_601 }],
  ])('rejects the wrong %s generically', async (_label, overrides) => {
    const fixture = await keyFixture();
    const cache = new GoogleJwksCache({
      fetch: async () => new Response(JSON.stringify({ keys: [fixture.jwk] })),
      now: () => NOW,
    });
    await expect(verifyGoogleOidc(await tokenFor(fixture, overrides), POLICY, cache, NOW)).rejects.toThrow(
      'OIDC token rejected',
    );
  });

  it('rejects a non-RS256 header before accepting its signature', async () => {
    const fixture = await keyFixture();
    const cache = new GoogleJwksCache({
      fetch: async () => new Response(JSON.stringify({ keys: [fixture.jwk] })),
      now: () => NOW,
    });
    await expect(verifyGoogleOidc(await tokenFor(fixture, {}, { alg: 'none' }), POLICY, cache, NOW)).rejects.toThrow(
      'OIDC token rejected',
    );
  });

  it('single-flights refresh and rate-limits unknown-kid refreshes to five minutes', async () => {
    let now = NOW;
    const fixture = await keyFixture();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [fixture.jwk] })));
    const cache = new GoogleJwksCache({ fetch, now: () => now });

    await Promise.all([cache.resolve('unknown'), cache.resolve('unknown')]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await cache.resolve('still-unknown');
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 300_001;
    await cache.resolve('still-unknown');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('distinguishes JWKS availability failure so the endpoint can retry with 503', async () => {
    const cache = new GoogleJwksCache({
      fetch: async () => new Response('unavailable', { status: 503 }),
      now: () => NOW,
    });
    await expect(cache.resolve('kid')).rejects.toBeInstanceOf(JwksUnavailableError);
    await expect(cache.resolve('kid')).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('expires known keys and removes a provider-revoked kid on refresh', async () => {
    let now = NOW;
    const first = await keyFixture('kid-1');
    const replacement = await keyFixture('kid-2');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [first.jwk] }), {
          headers: { 'cache-control': 'public, max-age=60' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [replacement.jwk] }), {
          headers: { 'cache-control': 'public, max-age=60' },
        }),
      );
    const cache = new GoogleJwksCache({ fetch, now: () => now });
    await expect(cache.resolve('kid-1')).resolves.not.toBeNull();
    now += 60_001;
    await expect(cache.resolve('kid-1')).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
