import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  crc32c,
  createPublisherRuntimeDeps,
  replicaPayloadFromEvent,
} from '../../router-publisher/src/runtime';

const AUDIENCE =
  'https://five-across-event-registry.nathanpayne.workers.dev/__internal/hostname-replicas/v1';
const KEY_VERSION =
  'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher/cryptoKeyVersions/1';

describe('keyless publisher runtime adapter', () => {
  it('obtains the exact audience token and KMS signature through metadata-bound credentials', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/identity?')) return new Response('header.payload.signature');
      if (url.endsWith('/token')) {
        return Response.json({ access_token: 'metadata-access-token', expires_in: 300, token_type: 'Bearer' });
      }
      if (url.startsWith('https://cloudkms.googleapis.com/v1/')) {
        const signature = Uint8Array.from([1, 2, 3]);
        return Response.json({
          name: KEY_VERSION,
          signature: Buffer.from(signature).toString('base64'),
          signatureCrc32c: String(crc32c(signature)),
          verifiedDigestCrc32c: true,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const deps = createPublisherRuntimeDeps(fetch, () => 1_776_297_600_123);

    await expect(deps.getIdentityToken(AUDIENCE)).resolves.toBe('header.payload.signature');
    const digest = Uint8Array.from({ length: 32 }, (_unused, index) => index);
    await expect(
      deps.signDigest({ keyVersion: KEY_VERSION, digest }),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3]));

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(AUDIENCE)}&format=full`,
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      `https://cloudkms.googleapis.com/v1/${KEY_VERSION}:asymmetricSign`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer metadata-access-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          digest: { sha256: Buffer.from(digest).toString('base64') },
          digestCrc32c: String(crc32c(digest)),
        }),
      },
    );
  });

  it('fails closed when KMS does not verify the digest CRC or returns a corrupt signature', async () => {
    const digest = Uint8Array.from({ length: 32 }, (_unused, index) => index);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/token')) {
        return Response.json({ access_token: 'token', expires_in: 300, token_type: 'Bearer' });
      }
      const signature = Uint8Array.from([1, 2, 3]);
      return Response.json({
        name: KEY_VERSION,
        signature: Buffer.from(signature).toString('base64'),
        signatureCrc32c: String(crc32c(signature) + 1),
        verifiedDigestCrc32c: false,
      });
    });
    const deps = createPublisherRuntimeDeps(fetch, () => 1);
    await expect(deps.signDigest({ keyVersion: KEY_VERSION, digest })).rejects.toThrow(
      'publisher runtime unavailable',
    );
  });

  it('normalizes the event Timestamp without reading Firestore', () => {
    const payload = replicaPayloadFromEvent(
      'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
      {
        schemaVersion: 1,
        revision: '1',
        host: 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
        desired: {
          kind: 'route',
          eventId: 'synthetic-event',
          status: 'disabled',
          slug: 'r2-abcdefghijklmnopqrstuvwxyz',
          edition: 'fiveacross',
          pathNamespace: null,
        },
        updatedAt: { toDate: () => new Date('2026-08-19T13:00:00.000Z') },
      },
    );
    expect(payload.updatedAt).toBe('2026-08-19T13:00:00.000Z');
  });

  it.each([
    ['host mismatch', 'other.fiveacross.app', {}],
    ['deleted/missing after data', 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app', null],
    ['non-canonical revision', 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app', { schemaVersion: 1, revision: '01' }],
    [
      'extra field',
      'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
      {
        schemaVersion: 1,
        revision: '1',
        host: 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
        desired: { kind: 'tombstone' },
        updatedAt: '2026-08-19T13:00:00.000Z',
        injected: true,
      },
    ],
    [
      'poisoned route slug',
      'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
      {
        schemaVersion: 1,
        revision: '1',
        host: 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
        desired: {
          kind: 'route',
          eventId: 'synthetic',
          status: 'disabled',
          slug: 'other',
          edition: 'fiveacross',
          pathNamespace: null,
        },
        updatedAt: '2026-08-19T13:00:00.000Z',
      },
    ],
  ])('fails closed on %s', (_label, host, data) => {
    expect(() => replicaPayloadFromEvent(host, data)).toThrow('invalid router replica event');
  });

  it('is a separately deployable codebase with no Admin, Secret Manager, or downloaded-key dependency', async () => {
    const packagePath = fileURLToPath(new URL('../../router-publisher/package.json', import.meta.url));
    const indexPath = fileURLToPath(new URL('../../router-publisher/src/index.ts', import.meta.url));
    const runtimePath = fileURLToPath(new URL('../../router-publisher/src/runtime.ts', import.meta.url));
    const [packageText, index, runtime] = await Promise.all([
      readFile(packagePath, 'utf8'),
      readFile(indexPath, 'utf8'),
      readFile(runtimePath, 'utf8'),
    ]);
    expect(packageText).not.toContain('firebase-admin');
    expect(`${index}\n${runtime}`).not.toMatch(/firebase-admin|secretmanager|GOOGLE_APPLICATION_CREDENTIALS/);
    expect(index).toContain('retry: true');
    expect(index).toContain("serviceAccount: PUBLISHER_SERVICE_ACCOUNT");
    expect(index).toContain("document: 'routerReplicas/{host}'");
  });
});
