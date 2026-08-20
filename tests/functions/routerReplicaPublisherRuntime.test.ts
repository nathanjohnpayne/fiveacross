import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  crc32c,
  createPublisherRuntimeDeps,
  replicaPayloadFromFirestoreEvent,
  replicaPayloadFromEvent,
} from '../../router-publisher/src/runtime';

const AUDIENCE =
  'https://five-across-event-registry.nathanpayne.workers.dev/__internal/hostname-replicas/v1';
const KEY_VERSION =
  'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher/cryptoKeyVersions/1';
const execFileAsync = promisify(execFile);

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
    ['fiveacross.app', 'fiveacross.app'],
    ['vacaybingo.com', 'vacaybingo.com'],
    ['fiveacross.vercel.app', 'fiveacross.app'],
    ['vacaybingo.vercel.app', 'vacaybingo.com'],
    ['gaycruisebingo.com', null],
    ['gaycruisebingo.vercel.app', null],
  ])(
    'accepts an active flagship route on %s with its host-class path capability',
    (host, pathNamespace) => {
      expect(
        replicaPayloadFromEvent(host, {
          schemaVersion: 1,
          revision: '1',
          host,
          desired: {
            kind: 'route',
            eventId: 'flagship-event',
            status: 'active',
            slug: 'flagship-event',
            edition: 'vacay',
            pathNamespace,
          },
          updatedAt: '2026-08-19T13:00:00.000Z',
        }),
      ).toMatchObject({ host, desired: { pathNamespace } });
    },
  );

  it.each([
    ['fiveacross.app', 'vacaybingo.com'],
    ['vacaybingo.vercel.app', 'fiveacross.app'],
    ['gaycruisebingo.com', 'fiveacross.app'],
    ['event-name.fiveacross.app', 'fiveacross.app'],
  ])('rejects a route on %s with path capability %s', (host, pathNamespace) => {
    expect(() =>
      replicaPayloadFromEvent(host, {
        schemaVersion: 1,
        revision: '1',
        host,
        desired: {
          kind: 'route',
          eventId: 'event',
          status: 'active',
          slug: host.startsWith('event-name.') ? 'event-name' : 'flagship-event',
          edition: 'fiveacross',
          pathNamespace,
        },
        updatedAt: '2026-08-19T13:00:00.000Z',
      }),
    ).toThrow('invalid router replica event');
  });

  it.each(['', 'admin', 'xn--poison', 'Mixed-Case', '-edge'])(
    'rejects invalid flagship slug %j on an apex route',
    (slug) => {
      expect(() =>
        replicaPayloadFromEvent('fiveacross.app', {
          schemaVersion: 1,
          revision: '1',
          host: 'fiveacross.app',
          desired: {
            kind: 'route',
            eventId: 'event',
            status: 'active',
            slug,
            edition: 'fiveacross',
            pathNamespace: 'fiveacross.app',
          },
          updatedAt: '2026-08-19T13:00:00.000Z',
        }),
      ).toThrow('invalid router replica event');
    },
  );

  it('decodes the Firestore written CloudEvent payload without a Firestore client', () => {
    const payload = replicaPayloadFromFirestoreEvent({
      specversion: '1.0',
      id: 'event-id',
      source: '//firestore.googleapis.com/projects/fiveacross/databases/(default)',
      type: 'google.cloud.firestore.document.v1.written',
      subject:
        'documents/routerReplicas/r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
      time: '2026-08-19T13:00:01.000Z',
      data: {
        value: {
          name: 'projects/fiveacross/databases/(default)/documents/routerReplicas/r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
          fields: {
            schemaVersion: { integerValue: '1' },
            revision: { stringValue: '1' },
            host: {
              stringValue: 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
            },
            desired: {
              mapValue: {
                fields: {
                  kind: { stringValue: 'route' },
                  eventId: { stringValue: 'synthetic-event' },
                  status: { stringValue: 'disabled' },
                  slug: { stringValue: 'r2-abcdefghijklmnopqrstuvwxyz' },
                  edition: { stringValue: 'fiveacross' },
                  pathNamespace: { nullValue: null },
                },
              },
            },
            updatedAt: { timestampValue: '2026-08-19T13:00:00.000Z' },
          },
          createTime: '2026-08-19T12:59:59.000Z',
          updateTime: '2026-08-19T13:00:00.000Z',
        },
        oldValue: {},
        updateMask: {
          fieldPaths: ['desired', 'host', 'revision', 'schemaVersion', 'updatedAt'],
        },
      },
    });

    expect(payload).toEqual({
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
      updatedAt: '2026-08-19T13:00:00.000Z',
    });
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
    const lockPath = fileURLToPath(new URL('../../router-publisher/package-lock.json', import.meta.url));
    const indexPath = fileURLToPath(new URL('../../router-publisher/src/index.ts', import.meta.url));
    const runtimePath = fileURLToPath(new URL('../../router-publisher/src/runtime.ts', import.meta.url));
    const deploymentPath = fileURLToPath(
      new URL('../../router-publisher/deployment.json', import.meta.url),
    );
    const [packageText, lockText, index, runtime, deploymentText] = await Promise.all([
      readFile(packagePath, 'utf8'),
      readFile(lockPath, 'utf8'),
      readFile(indexPath, 'utf8'),
      readFile(runtimePath, 'utf8'),
      readFile(deploymentPath, 'utf8'),
    ]);
    const packageManifest = JSON.parse(packageText) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const lock = JSON.parse(lockText) as {
      packages: Record<string, { name?: string }>;
    };
    const dependencyNames = new Set([
      ...Object.keys(packageManifest.dependencies ?? {}),
      ...Object.values(lock.packages).flatMap((entry) =>
        entry.name === undefined ? [] : [entry.name],
      ),
      ...Object.keys(lock.packages).map((path) => path.split('node_modules/').at(-1)),
    ]);
    expect(dependencyNames).not.toContain('firebase-admin');
    expect(dependencyNames).not.toContain('firebase-functions');
    expect(packageManifest.scripts?.['gcp-build']).toBe('npm run build');
    expect(`${index}\n${runtime}`).not.toMatch(
      /firebase-admin|firebase-functions|secretmanager|GOOGLE_APPLICATION_CREDENTIALS/,
    );
    expect(index).toContain("cloudEvent('publishRouterReplicaDesired'");
    expect(JSON.parse(deploymentText)).toMatchObject({
      retry: true,
      serviceAccount:
        'event-router-replica-publisher@fiveacross.iam.gserviceaccount.com',
      eventType: 'google.cloud.firestore.document.v1.written',
      documentPathPattern: 'routerReplicas/{host}',
    });
  });

  it('requires a reviewed Firestore trigger location before rendering a no-deploy plan', async () => {
    const script = fileURLToPath(
      new URL('../../router-publisher/scripts/render-deploy.mjs', import.meta.url),
    );

    await expect(execFileAsync(process.execPath, [script])).rejects.toMatchObject({
      stderr: expect.stringContaining('reviewed --trigger-location'),
    });
    const { stdout } = await execFileAsync(process.execPath, [
      script,
      '--trigger-location=reviewed-location',
    ]);
    expect(stdout).toContain('"--trigger-location=reviewed-location"');
    expect(stdout).toContain('plan only: no deployment command was executed');
  });
});
