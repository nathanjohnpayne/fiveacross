// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_VERSION,
  parseHostnameDocument,
  resolveHost,
  type CacheEnvelope,
  type HostnameCache,
  type ResolveConfig,
  type ResolveDeps,
} from './resolve';

const CONFIG: ResolveConfig = {
  projectId: 'fiveacross',
  apiKey: 'test-web-api-key',
  lookupTimeoutMs: 2_000,
  cacheTtlMs: 300_000,
};

/** Firestore REST's type-tagged document shape. */
function firestoreDoc(fields: Record<string, string>): unknown {
  return {
    name: 'projects/fiveacross/databases/(default)/documents/hostnames/bodega-bay.fiveacross.app',
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { stringValue: v }])),
  };
}

function memoryCache(seed?: Record<string, CacheEnvelope>): HostnameCache & { store: Map<string, CacheEnvelope> } {
  const store = new Map<string, CacheEnvelope>(Object.entries(seed ?? {}));
  return {
    store,
    read: async (host) => store.get(host) ?? null,
    write: async (host, envelope) => void store.set(host, envelope),
    drop: async (host) => void store.delete(host),
  };
}

function deps(
  fetchImpl: ResolveDeps['fetch'],
  cache: HostnameCache,
  clock = 1_000_000,
): ResolveDeps {
  return { fetch: fetchImpl, cache, now: () => clock };
}

function respondWith(body: unknown, status = 200): ResolveDeps['fetch'] {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as ResolveDeps['fetch'];
}

const ACTIVE = firestoreDoc({ eventId: 'bodega-bay-2026', status: 'active', slug: 'bodega-bay' });
const HOST = 'bodega-bay.fiveacross.app';

describe('resolveHost — servable', () => {
  it('serves an active, well-formed, address-matching record', async () => {
    const cache = memoryCache();
    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(respondWith(ACTIVE), cache));
    expect(result).toEqual({ kind: 'serve', eventId: 'bodega-bay-2026', stale: false });
  });

  it('serves the apex without a Slug cross-check', async () => {
    // The apex document's `slug` names the Event's WILDCARD address, so
    // comparing it against a first label the apex does not have would refuse a
    // host that is registered and in service.
    const cache = memoryCache();
    const result = await resolveHost('fiveacross.app', null, CONFIG, deps(respondWith(ACTIVE), cache));
    expect(result).toMatchObject({ kind: 'serve', eventId: 'bodega-bay-2026' });
  });
});

describe('resolveHost — fail closed', () => {
  it.each([
    ['unknown host (404 from Firestore)', 404, undefined, 'unknown-host'],
    ['disabled', 200, { eventId: 'e', status: 'disabled', slug: 'bodega-bay' }, 'inactive'],
    ['archived', 200, { eventId: 'e', status: 'archived', slug: 'bodega-bay' }, 'inactive'],
    ['absent status', 200, { eventId: 'e', slug: 'bodega-bay' }, 'inactive'],
    ['unrecognised status', 200, { eventId: 'e', status: 'ACTIVE', slug: 'bodega-bay' }, 'inactive'],
    ['no eventId', 200, { status: 'active', slug: 'bodega-bay' }, 'malformed'],
    ['no slug', 200, { eventId: 'e', status: 'active' }, 'slug-missing'],
    ['slug names another address', 200, { eventId: 'e', status: 'active', slug: 'elsewhere' }, 'slug-mismatch'],
  ] as const)('refuses %s', async (_label, status, fields, reason) => {
    const cache = memoryCache();
    const body = fields === undefined ? {} : firestoreDoc(fields as Record<string, string>);
    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(respondWith(body, status), cache));
    expect(result).toEqual({ kind: 'not-found', reason });
  });

  it('never infers active from a missing status, on the cache path either', async () => {
    const cache = memoryCache({
      [HOST]: { version: CACHE_VERSION, fetchedAt: 1_000_000, record: { eventId: 'e', status: '', slug: 'bodega-bay' } },
    });
    const fetchImpl = respondWith(ACTIVE);
    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(fetchImpl, cache));
    expect(result).toEqual({ kind: 'not-found', reason: 'inactive' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when the lookup is unavailable and nothing is cached', async () => {
    const cache = memoryCache();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as ResolveDeps['fetch'];
    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(fetchImpl, cache));
    expect(result).toEqual({ kind: 'not-found', reason: 'lookup-unavailable' });
  });

  it('fails closed rather than serving when the router is unconfigured', async () => {
    const cache = memoryCache();
    const fetchImpl = respondWith(ACTIVE);
    const result = await resolveHost(
      HOST,
      'bodega-bay',
      { ...CONFIG, apiKey: '' },
      deps(fetchImpl, cache),
    );
    expect(result).toEqual({ kind: 'not-found', reason: 'lookup-unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a Firestore 5xx as unavailable rather than as an absent document', async () => {
    const cache = memoryCache();
    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(respondWith({}, 503), cache));
    expect(result).toEqual({ kind: 'not-found', reason: 'lookup-unavailable' });
  });
});

describe('resolveHost — the cache', () => {
  it('answers a fresh entry with no network read at all', async () => {
    const cache = memoryCache({
      [HOST]: {
        version: CACHE_VERSION,
        fetchedAt: 999_000,
        record: { eventId: 'bodega-bay-2026', status: 'active', slug: 'bodega-bay' },
      },
    });
    const fetchImpl = respondWith(ACTIVE);
    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(fetchImpl, cache));
    expect(result).toEqual({ kind: 'serve', eventId: 'bodega-bay-2026', stale: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('revalidates past the TTL boundary and restamps', async () => {
    const cache = memoryCache({
      [HOST]: {
        version: CACHE_VERSION,
        fetchedAt: 1_000_000 - CONFIG.cacheTtlMs,
        record: { eventId: 'old-event', status: 'active', slug: 'bodega-bay' },
      },
    });
    const fetchImpl = respondWith(ACTIVE);
    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(fetchImpl, cache));
    expect(result).toEqual({ kind: 'serve', eventId: 'bodega-bay-2026', stale: false });
    expect(cache.store.get(HOST)?.fetchedAt).toBe(1_000_000);
  });

  it('reads a version-drifted envelope as a miss rather than coercing it', async () => {
    const cache = memoryCache({
      [HOST]: {
        version: CACHE_VERSION + 1,
        fetchedAt: 1_000_000,
        record: { eventId: 'from-the-future', status: 'active', slug: 'bodega-bay' },
      },
    });
    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(respondWith(ACTIVE), cache));
    expect(result).toMatchObject({ eventId: 'bodega-bay-2026' });
  });

  it('serves a stale-but-active entry when revalidation fails, WITHOUT restamping it', async () => {
    const staleAt = 1_000_000 - CONFIG.cacheTtlMs - 1;
    const cache = memoryCache({
      [HOST]: {
        version: CACHE_VERSION,
        fetchedAt: staleAt,
        record: { eventId: 'bodega-bay-2026', status: 'active', slug: 'bodega-bay' },
      },
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('firestore unreachable');
    }) as unknown as ResolveDeps['fetch'];

    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(fetchImpl, cache));
    expect(result).toEqual({ kind: 'serve', eventId: 'bodega-bay-2026', stale: true });
    // A bound that renews itself is not a bound.
    expect(cache.store.get(HOST)?.fetchedAt).toBe(staleAt);
  });

  it('drops the entry outright when the mapping is gone, rather than letting it expire', async () => {
    const cache = memoryCache({
      [HOST]: {
        version: CACHE_VERSION,
        fetchedAt: 0,
        record: { eventId: 'bodega-bay-2026', status: 'active', slug: 'bodega-bay' },
      },
    });
    const result = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(respondWith({}, 404), cache));
    expect(result).toEqual({ kind: 'not-found', reason: 'unknown-host' });
    expect(cache.store.has(HOST)).toBe(false);
  });

  it('caches no negatives, so a newly provisioned address serves on the next request', async () => {
    const cache = memoryCache();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ACTIVE), { status: 200 }));

    const first = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(fetchImpl as unknown as ResolveDeps['fetch'], cache));
    const second = await resolveHost(HOST, 'bodega-bay', CONFIG, deps(fetchImpl as unknown as ResolveDeps['fetch'], cache));

    expect(first).toEqual({ kind: 'not-found', reason: 'unknown-host' });
    expect(second).toMatchObject({ kind: 'serve', eventId: 'bodega-bay-2026' });
  });
});

describe('the Firestore request', () => {
  let seen: string;

  beforeEach(() => {
    seen = '';
  });

  it('point-gets the same hostnames/{host} document the client reads, unauthenticated and masked', async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      seen = String(input);
      return new Response(JSON.stringify(ACTIVE), { status: 200 });
    }) as unknown as ResolveDeps['fetch'];

    await resolveHost(HOST, 'bodega-bay', CONFIG, deps(fetchImpl, memoryCache()));

    const url = new URL(seen);
    expect(url.origin).toBe('https://firestore.googleapis.com');
    expect(url.pathname).toBe(
      `/v1/projects/fiveacross/databases/(default)/documents/hostnames/${encodeURIComponent(HOST)}`,
    );
    expect(url.searchParams.get('key')).toBe('test-web-api-key');
    expect(url.searchParams.getAll('mask.fieldPaths')).toEqual(['eventId', 'status', 'slug']);
    // No Authorization header anywhere: the router reads exactly what a browser
    // on the same address can read, and firestore.rules is what enforces it.
    const init = (fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0][1];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('bounds the read, so a hung dependency cannot hang the request', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(ACTIVE), { status: 200 });
    }) as unknown as ResolveDeps['fetch'];
    await resolveHost(HOST, 'bodega-bay', CONFIG, deps(fetchImpl, memoryCache()));
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe('parseHostnameDocument', () => {
  it('reads a well-formed document', () => {
    expect(parseHostnameDocument(ACTIVE)).toEqual({
      eventId: 'bodega-bay-2026',
      status: 'active',
      slug: 'bodega-bay',
    });
  });

  it.each([null, undefined, 42, 'a string', {}, { fields: null }, { fields: 'nope' }])(
    'reads %s as an unservable record rather than throwing',
    (body) => {
      expect(parseHostnameDocument(body)).toEqual({ eventId: '', status: '', slug: null });
    },
  );

  it('ignores a non-string typed value rather than coercing it', () => {
    const body = { fields: { eventId: { integerValue: '7' }, status: { stringValue: 'active' } } };
    expect(parseHostnameDocument(body)).toEqual({ eventId: '', status: 'active', slug: null });
  });
});
