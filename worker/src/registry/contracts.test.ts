// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { canonicalProjectionBytes, parseSyncRequest, projectionDigest, type RouterReplicaDesired } from './contracts';

const SYNTHETIC_HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';

function route(overrides: Partial<RouterReplicaDesired> = {}): RouterReplicaDesired {
  return {
    schemaVersion: 1,
    revision: '1',
    host: SYNTHETIC_HOST,
    desired: {
      kind: 'route',
      eventId: 'synthetic-event',
      status: 'disabled',
      slug: 'r2-abcdefghijklmnopqrstuvwxyz',
      edition: 'fiveacross',
      pathNamespace: null,
    },
    updatedAt: '2026-08-19T12:34:56.000Z',
    ...overrides,
  };
}

describe('registry sync request contract', () => {
  it('accepts the exact deny-all synthetic route projection', () => {
    const body = JSON.stringify(route());
    expect(parseSyncRequest(body, 'application/json')).toEqual(route());
  });

  it.each([
    ['extra top-level field', { ...route(), unexpected: true }],
    [
      'extra desired field',
      {
        ...route(),
        desired: { ...route().desired, canonicalHost: SYNTHETIC_HOST },
      },
    ],
    ['non-canonical revision', route({ revision: '01' })],
    ['zero revision', route({ revision: '0' })],
    ['mixed-case host', route({ host: SYNTHETIC_HOST.toUpperCase() })],
    ['slug/host mismatch', { ...route(), desired: { ...route().desired, slug: 'different-slug' } }],
    [
      'path capability on an Event subdomain',
      {
        ...route(),
        desired: { ...route().desired, pathNamespace: 'fiveacross.app' },
      },
    ],
    ['invalid timestamp', route({ updatedAt: 'not-a-time' })],
    ['foreign tombstone host', route({ host: 'example.com', desired: { kind: 'tombstone' } })],
  ])('rejects %s before storage', (_label, payload) => {
    expect(() => parseSyncRequest(JSON.stringify(payload), 'application/json')).toThrow();
  });

  it('requires the exact application/json content type', () => {
    expect(() => parseSyncRequest(JSON.stringify(route()), 'application/json; charset=utf-8')).toThrow('content-type');
  });

  it('enforces the 2 KiB boundary on the exact UTF-8 request bytes', () => {
    expect(() => parseSyncRequest(' '.repeat(2_049), 'application/json')).toThrow('2 KiB');
  });

  it('admits only the guarded synthetic root-test class with a null path capability', () => {
    const host = 'r2-root-abcdefghijklmnopqrst.vacaybingo.com';
    const payload = route({
      host,
      desired: {
        kind: 'root',
        root: 'not-found',
        edition: 'vacay',
        pathNamespace: null,
      },
    });
    expect(parseSyncRequest(JSON.stringify(payload), 'application/json')).toEqual(payload);

    const ordinaryRoot = route({
      host: 'ordinary.vacaybingo.com',
      desired: {
        kind: 'root',
        root: 'doorway',
        edition: 'vacay',
        pathNamespace: null,
      },
    });
    expect(() => parseSyncRequest(JSON.stringify(ordinaryRoot), 'application/json')).toThrow('root shape');
  });

  it('pins Namespace apex and brand-mirror root capability to the host class', () => {
    const mirror = route({
      host: 'fiveacross.vercel.app',
      desired: {
        kind: 'root',
        root: 'not-found',
        edition: 'fiveacross',
        pathNamespace: 'fiveacross.app',
      },
    });
    expect(parseSyncRequest(JSON.stringify(mirror), 'application/json')).toEqual(mirror);
    expect(() =>
      parseSyncRequest(
        JSON.stringify({
          ...mirror,
          desired: { ...mirror.desired, pathNamespace: 'vacaybingo.com' },
        }),
        'application/json',
      ),
    ).toThrow('host class');
  });

  it.each([
    ['fiveacross.app', 'fiveacross.app'],
    ['vacaybingo.com', 'vacaybingo.com'],
    ['fiveacross.vercel.app', 'fiveacross.app'],
    ['vacaybingo.vercel.app', 'vacaybingo.com'],
    ['gaycruisebingo.com', null],
    ['gaycruisebingo.vercel.app', null],
  ] as const)('preserves the route Slug exception and exact capability on %s', (host, pathNamespace) => {
    const payload = route({
      host,
      desired: {
        kind: 'route',
        eventId: 'event-1',
        status: 'active',
        slug: 'bodega-bay',
        edition: 'vacay',
        pathNamespace,
      },
    });
    expect(parseSyncRequest(JSON.stringify(payload), 'application/json')).toEqual(payload);
  });

  it('rejects a route capability that does not match its apex or mirror class', () => {
    const payload = route({
      host: 'fiveacross.vercel.app',
      desired: {
        kind: 'route',
        eventId: 'event-1',
        status: 'active',
        slug: 'bodega-bay',
        edition: 'vacay',
        pathNamespace: 'vacaybingo.com',
      },
    });
    expect(() => parseSyncRequest(JSON.stringify(payload), 'application/json')).toThrow('route host class');
  });
});

describe('projection digest', () => {
  it('uses the one exact route array and an independently pinned SHA-256 literal', async () => {
    expect(new TextDecoder().decode(canonicalProjectionBytes(route()))).toBe(
      '[1,"1","r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app","route","synthetic-event","disabled","r2-abcdefghijklmnopqrstuvwxyz","fiveacross",null]',
    );
    expect(await projectionDigest(route())).toBe('99bf68a026a95b1138b7c4817574612436f29c8ae0ea1fe8fd623012026f9755');
  });

  it('keeps tombstones distinct from routes and roots', async () => {
    const tombstone = route({ desired: { kind: 'tombstone' } });
    const root = route({
      host: 'r2-root-abcdefghijklmnopqrst.fiveacross.app',
      desired: {
        kind: 'root',
        root: 'not-found',
        edition: 'fiveacross',
        pathNamespace: null,
      },
    });
    expect(await projectionDigest(tombstone)).not.toBe(await projectionDigest(route()));
    expect(await projectionDigest(root)).not.toBe(await projectionDigest(route()));
  });
});
