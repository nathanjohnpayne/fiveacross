// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type RouterReplicaDesired, SYNC_PATH } from './contracts';
import { GoogleJwksCache } from './oidc';
import { handleRegistryFetch, type RegistryServiceConfig, type RegistryServiceDeps } from './service';
import type { VerificationRecord } from './keys';
import type { SyncResponse } from './state';

const NOW = Date.parse('2026-08-19T13:00:00.000Z');
const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const AUDIENCE = `https://fiveacross-registry.example.workers.dev${SYNC_PATH}`;
const KEY_VERSION = 'projects/fiveacross/locations/us/keyRings/event-router/cryptoKeys/publisher/cryptoKeyVersions/1';

const PAYLOAD: RouterReplicaDesired = {
  schemaVersion: 1,
  revision: '1',
  host: HOST,
  desired: {
    kind: 'route',
    eventId: 'synthetic-event',
    status: 'disabled',
    slug: 'r2-abcdefghijklmnopqrstuvwxyz',
    edition: 'fiveacross',
    pathNamespace: null,
  },
  updatedAt: '2026-08-19T13:00:00.000Z',
};

function base64url(value: string | ArrayBuffer): string {
  return Buffer.from(value instanceof ArrayBuffer ? value : value).toString('base64url');
}

function pem(spki: ArrayBuffer): string {
  const body = Buffer.from(spki)
    .toString('base64')
    .match(/.{1,64}/g)
    ?.join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
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
  const publisher = (await crypto.subtle.generateKey(
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
  const publisherSpki = (await crypto.subtle.exportKey('spki', publisher.publicKey)) as ArrayBuffer;
  const publisherPem = pem(publisherSpki);
  const record: VerificationRecord = {
    role: 'publisher',
    subject: '1001',
    epochOrSlot: '1',
    keyVersion: KEY_VERSION,
    algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
    pem: publisherPem,
    spkiSha256: createHash('sha256').update(Buffer.from(publisherSpki)).digest('hex'),
  };
  const cache = new GoogleJwksCache({
    fetch: async () => new Response(JSON.stringify({ keys: [oidcJwk] })),
    now: () => NOW,
  });
  const header = base64url(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: AUDIENCE,
      sub: '1001',
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
    publisher,
    record,
    cache,
    token: `${jwtInput}.${base64url(jwtSignature)}`,
  };
}

async function signedRequest(
  data: Awaited<ReturnType<typeof fixture>>,
  overrides: {
    body?: string;
    epoch?: string;
    keyVersion?: string;
    issuedAt?: number;
    signature?: string;
    token?: string;
    clientIp?: string;
  } = {},
) {
  const body = overrides.body ?? JSON.stringify(PAYLOAD);
  const epoch = overrides.epoch ?? '1';
  const issuedAt = overrides.issuedAt ?? NOW;
  const bodyDigest = createHash('sha256').update(body).digest('hex');
  const signatureInput = `v1\nPOST\n${SYNC_PATH}\n${issuedAt}\n${epoch}\n${bodyDigest}`;
  const signature =
    overrides.signature ??
    Buffer.from(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        data.publisher.privateKey,
        new TextEncoder().encode(signatureInput),
      ),
    ).toString('base64');
  return new Request(AUDIENCE, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${overrides.token ?? data.token}`,
      'content-type': 'application/json',
      'x-registry-key-version': overrides.keyVersion ?? KEY_VERSION,
      'x-registry-publisher-epoch': epoch,
      'x-registry-issued-at': String(issuedAt),
      'x-registry-body-signature': signature,
      'cf-connecting-ip': overrides.clientIp ?? '2001:db8::1',
    },
    body,
  });
}

function harness(data: Awaited<ReturnType<typeof fixture>>) {
  const sync = vi.fn(async (): Promise<SyncResponse> => ({
    status: 200,
    result: 'applied',
  }));
  const getByName = vi.fn(() => ({
    sync,
    audit: vi.fn(),
    recover: vi.fn(),
    issueProbeChallenge: vi.fn(),
    attestProbe: vi.fn(),
  }));
  const limit = vi.fn(async () => ({ success: true }));
  const semanticLogger = vi.fn();
  const config: RegistryServiceConfig = {
    audience: AUDIENCE,
    registryVersion: 'v1',
    verificationRecords: [data.record],
  };
  const deps: RegistryServiceDeps = {
    now: () => NOW,
    jwks: data.cache,
    hostRegistry: { getByName },
    rateLimiter: { limit },
    semanticLogger,
  };
  return { config, deps, sync, getByName, limit, semanticLogger };
}

describe('registry default fetch sync endpoint', () => {
  it('authenticates exact bytes and applies one host at immutable wnam placement', async () => {
    const data = await fixture();
    const test = harness(data);
    const response = await handleRegistryFetch(await signedRequest(data), test.config, test.deps);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: 'applied' });
    expect(test.getByName).toHaveBeenCalledExactlyOnceWith(HOST, {
      locationHint: 'wnam',
    });
    expect(test.sync).toHaveBeenCalledExactlyOnceWith(PAYLOAD, '1');
    expect(test.semanticLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'event-router-registry.semantic',
        operation: 'sync',
        outcome: 'applied',
        registryVersion: 'v1',
        host: HOST,
        revision: '1',
        keyVersion: KEY_VERSION,
      }),
    );
  });

  it('emits an aged gap outcome distinct from conflict without logging request credentials', async () => {
    const data = await fixture();
    const test = harness(data);
    test.sync.mockResolvedValue({ status: 409, result: 'revision-gap' });
    test.deps.now = vi
      .fn<() => number>()
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW + 359_950)
      .mockReturnValueOnce(NOW + 360_000);

    const request = await signedRequest(data);
    const response = await handleRegistryFetch(request, test.config, test.deps);
    expect(response.status).toBe(409);
    expect(test.semanticLogger).toHaveBeenCalledExactlyOnceWith({
      schemaVersion: 1,
      event: 'event-router-registry.semantic',
      operation: 'sync',
      outcome: 'gap',
      registryVersion: 'v1',
      host: HOST,
      revision: '1',
      latencyMs: 50,
      gapAgeMs: 360_000,
      keyVersion: KEY_VERSION,
      recoveryAction: null,
    });
    expect(JSON.stringify(test.semanticLogger.mock.calls)).not.toContain(data.token);
    expect(JSON.stringify(test.semanticLogger.mock.calls)).not.toContain('x-registry-body-signature');
  });

  it.each([
    ['wrong key version', { keyVersion: `${KEY_VERSION}-other` }],
    ['wrong epoch', { epoch: '2' }],
    ['stale timestamp', { issuedAt: NOW - 60_001 }],
    ['invalid signature', { signature: Buffer.from('forged').toString('base64') }],
  ])('returns generic 401 and performs no DO work for %s', async (_label, overrides) => {
    const data = await fixture();
    const test = harness(data);
    const response = await handleRegistryFetch(await signedRequest(data, overrides), test.config, test.deps);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('returns retryable 503 when Google JWKS is unavailable', async () => {
    const data = await fixture();
    const test = harness(data);
    test.deps.jwks = new GoogleJwksCache({
      fetch: async () => new Response('down', { status: 503 }),
      now: () => NOW,
    });
    const response = await handleRegistryFetch(await signedRequest(data), test.config, test.deps);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'identity-verification-unavailable',
    });
  });

  it.each([
    ['wrong method', new Request(AUDIENCE, { method: 'GET' }), 405],
    [
      'wrong path',
      new Request('https://fiveacross-registry.example.workers.dev/not-sync', {
        method: 'POST',
      }),
      404,
    ],
    [
      'wrong content type',
      new Request(AUDIENCE, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      }),
      415,
    ],
    [
      'oversized body',
      new Request(AUDIENCE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(2_049),
      }),
      413,
    ],
  ])('rejects %s before token or storage work', async (_label, request, status) => {
    const data = await fixture();
    const test = harness(data);
    const response = await handleRegistryFetch(request, test.config, test.deps);
    expect(response.status).toBe(status);
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('rejects a declared oversized sync body before rate limiting or reading', async () => {
    const data = await fixture();
    const test = harness(data);
    const request = new Request(AUDIENCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '2049',
      },
      body: '{}',
    });
    const arrayBuffer = vi.spyOn(request, 'arrayBuffer');
    const getReader = vi.spyOn(request.body!, 'getReader');

    const response = await handleRegistryFetch(request, test.config, test.deps);

    expect(response.status).toBe(413);
    expect(test.limit).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('enforces the bound rate limiter before JWT work', async () => {
    const data = await fixture();
    const test = harness(data);
    const request = await signedRequest(data);
    const arrayBuffer = vi.spyOn(request, 'arrayBuffer');
    const getReader = vi.spyOn(request.body!, 'getReader');
    test.limit.mockImplementation(async () => {
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(getReader).not.toHaveBeenCalled();
      return { success: false };
    });
    const response = await handleRegistryFetch(request, test.config, test.deps);
    expect(response.status).toBe(429);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('cancels a chunked body after reading only the 2 KiB bound plus one byte', async () => {
    const data = await fixture();
    const test = harness(data);
    const chunks = [new Uint8Array(2_048), new Uint8Array([0]), new Uint8Array(8_192)];
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(chunks[pulled++]!);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(AUDIENCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '2001:db8::1',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(request.headers.get('content-length')).toBeNull();

    const response = await handleRegistryFetch(request, test.config, test.deps);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'request-too-large' });
    expect(pulled).toBe(2);
    expect(cancelled).toBe(true);
    expect(test.limit).toHaveBeenCalledExactlyOnceWith({ key: 'sync:2001:db8::1' });
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('uses the Cloudflare client IP rather than attacker-rotatable credentials as the rate key', async () => {
    const data = await fixture();
    const test = harness(data);
    const first = await signedRequest(data, {
      token: 'garbage.one.token',
      clientIp: '203.0.113.9',
    });
    const second = await signedRequest(data, {
      token: 'different.bad.token',
      clientIp: '203.0.113.9',
    });
    await handleRegistryFetch(first, test.config, test.deps);
    await handleRegistryFetch(second, test.config, test.deps);
    expect(test.limit).toHaveBeenNthCalledWith(1, { key: 'sync:203.0.113.9' });
    expect(test.limit).toHaveBeenNthCalledWith(2, { key: 'sync:203.0.113.9' });
  });

  it('returns a closed 400 for invalid UTF-8 before identity or DO work', async () => {
    const data = await fixture();
    const test = harness(data);
    const response = await handleRegistryFetch(
      new Request(AUDIENCE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Uint8Array.from([0xc3, 0x28]),
      }),
      test.config,
      test.deps,
    );
    expect(response.status).toBe(400);
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('rejects a UTF-8 BOM before identity or DO work', async () => {
    const data = await fixture();
    const test = harness(data);
    const json = new TextEncoder().encode(JSON.stringify(PAYLOAD));
    const body = new Uint8Array(3 + json.length);
    body.set([0xef, 0xbb, 0xbf]);
    body.set(json, 3);
    const response = await handleRegistryFetch(
      new Request(AUDIENCE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      test.config,
      test.deps,
    );
    expect(response.status).toBe(400);
    expect(test.limit).toHaveBeenCalledExactlyOnceWith({ key: 'sync:unidentified-client' });
    expect(test.getByName).not.toHaveBeenCalled();
  });
});
