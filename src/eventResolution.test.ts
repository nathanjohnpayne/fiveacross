import { describe, it, expect, vi } from 'vitest';
import {
  CACHE_PREFIX,
  CACHE_TTL_MS,
  CACHE_VERSION,
  cacheKey,
  isServable,
  readCache,
  resolveEvent,
  writeCache,
  type StorageLike,
} from './eventResolution';
import type { HostnameDoc } from './types';

// Covers #543 / ADR 0009. The whole decision table runs without a network or a
// browser, which is the point of keeping resolveEvent injected.

const HOST = 'bodega-bay.vacaybingo.com';
const T0 = 1_700_000_000_000;

const DOC: HostnameDoc = {
  eventId: 'bodega-bay-2026',
  canonicalHost: HOST,
  edition: 'vacay',
  status: 'active',
  slug: 'bodega-bay',
  isCanonical: true,
};

function fakeStorage(seed: Record<string, string> = {}, opts: { throws?: boolean } = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(k: string) {
      if (opts.throws) throw new Error('storage disabled');
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (opts.throws) throw new Error('storage disabled');
      map.set(k, v);
    },
    removeItem(k: string) {
      map.delete(k);
    },
  } satisfies StorageLike & { map: Map<string, string> };
}

const envelope = (doc: HostnameDoc, fetchedAt = T0) =>
  JSON.stringify({ v: CACHE_VERSION, fetchedAt, doc });

const never = () => new Promise<HostnameDoc | null>(() => {});
const at = (t: number) => () => t;

describe('eventResolution — cache envelope', () => {
  it('keys the cache by hostname, lowercased', () => {
    expect(cacheKey('BODEGA-BAY.Vacaybingo.com')).toBe(`${CACHE_PREFIX}bodega-bay.vacaybingo.com`);
  });

  it('round-trips a document with its fetch stamp', () => {
    const s = fakeStorage();
    writeCache(s, HOST, DOC, T0);
    const r = readCache(s, HOST, T0);
    expect(r?.doc).toMatchObject({ eventId: 'bodega-bay-2026', edition: 'vacay' });
    expect(r?.fetchedAt).toBe(T0);
    expect(r?.stale).toBe(false);
  });

  it('marks an entry stale once past the TTL', () => {
    const s = fakeStorage({ [cacheKey(HOST)]: envelope(DOC, T0) });
    expect(readCache(s, HOST, T0 + CACHE_TTL_MS - 1)?.stale).toBe(false);
    expect(readCache(s, HOST, T0 + CACHE_TTL_MS + 1)?.stale).toBe(true);
  });

  it('treats a version-drifted envelope as a MISS, never coerces it', () => {
    const s = fakeStorage({
      [cacheKey(HOST)]: JSON.stringify({ v: CACHE_VERSION + 1, fetchedAt: T0, doc: DOC }),
    });
    expect(readCache(s, HOST, T0)).toBeNull();
  });

  it('treats corrupt JSON, missing eventId and unknown status as no cache', () => {
    expect(readCache(fakeStorage({ [cacheKey(HOST)]: '{not json' }), HOST, T0)).toBeNull();
    expect(
      readCache(
        fakeStorage({ [cacheKey(HOST)]: envelope({ ...DOC, eventId: '' } as HostnameDoc) }),
        HOST,
        T0,
      ),
    ).toBeNull();
    expect(
      readCache(
        fakeStorage({
          [cacheKey(HOST)]: JSON.stringify({
            v: CACHE_VERSION,
            fetchedAt: T0,
            doc: { ...DOC, status: 'weird' },
          }),
        }),
        HOST,
        T0,
      ),
    ).toBeNull();
  });

  it('survives storage that throws on access (private mode)', () => {
    const s = fakeStorage({}, { throws: true });
    expect(readCache(s, HOST, T0)).toBeNull();
    expect(() => writeCache(s, HOST, DOC, T0)).not.toThrow();
  });
});

describe('eventResolution — status must be explicit', () => {
  it('only `active` is servable', () => {
    expect(isServable({ status: 'active' })).toBe(true);
    expect(isServable({ status: 'archived' })).toBe(false);
    expect(isServable({ status: 'disabled' })).toBe(false);
    // The regression this guards: a partially-written routing document must not
    // publish an Event just because `status` is absent.
    expect(isServable({} as HostnameDoc)).toBe(false);
    expect(isServable(null)).toBe(false);
  });
});

describe('eventResolution — resolveEvent decision table', () => {
  it('a SINGLE-Event build never touches the network', async () => {
    // VITE_EVENT_ID's presence means the bundle serves one Event, so consulting
    // the lookup at all would be incoherent — and since resolution now gates
    // first paint, it would cost the legacy build a round trip it cannot use.
    const fetchDoc = vi.fn(never);
    const r = await resolveEvent({
      hostname: 'gaycruisebingo.com',
      fetchDoc,
      envEventId: 'med-2026',
      now: at(T0),
    });
    expect(r).toMatchObject({ kind: 'event', eventId: 'med-2026', source: 'env' });
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('a FRESH cache hit resolves with no network call', async () => {
    const fetchDoc = vi.fn(never);
    const s = fakeStorage({ [cacheKey(HOST)]: envelope(DOC, T0) });
    const r = await resolveEvent({ hostname: HOST, fetchDoc, storage: s, now: at(T0) });
    expect(r).toMatchObject({ kind: 'event', eventId: 'bodega-bay-2026', source: 'cache' });
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('a STALE cache hit revalidates over the network', async () => {
    const fetchDoc = vi.fn(async () => ({ ...DOC, eventId: 'repointed-2027' }));
    const s = fakeStorage({ [cacheKey(HOST)]: envelope(DOC, T0) });
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc,
      storage: s,
      now: at(T0 + CACHE_TTL_MS + 1),
    });
    expect(fetchDoc).toHaveBeenCalled();
    expect(r).toMatchObject({ kind: 'event', eventId: 'repointed-2027', source: 'network' });
  });

  it('a stale entry still serves when revalidation FAILS — offline beats dead', async () => {
    const s = fakeStorage({ [cacheKey(HOST)]: envelope(DOC, T0) });
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => {
        throw new Error('offline');
      },
      storage: s,
      now: at(T0 + CACHE_TTL_MS + 1),
    });
    expect(r).toMatchObject({ kind: 'event', eventId: 'bodega-bay-2026', source: 'cache' });
  });

  it('a cache MISS fetches, resolves, and populates the cache', async () => {
    const s = fakeStorage();
    const r = await resolveEvent({ hostname: HOST, fetchDoc: async () => DOC, storage: s, now: at(T0) });
    expect(r).toMatchObject({ kind: 'event', source: 'network' });
    expect(readCache(s, HOST, T0)?.doc.eventId).toBe('bodega-bay-2026');
  });

  it('an ARCHIVED host is not-found and its cached copy is DROPPED', async () => {
    // Otherwise a browser that cached the active mapping keeps booting a
    // disabled Event until the entry happens to expire.
    const s = fakeStorage({ [cacheKey(HOST)]: envelope(DOC, T0) });
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => ({ ...DOC, status: 'archived' as const }),
      storage: s,
      now: at(T0 + CACHE_TTL_MS + 1),
    });
    expect(r).toEqual({ kind: 'not-found', hostname: HOST, reason: 'inactive' });
    expect(s.map.size).toBe(0);
  });

  it('a REMOVED mapping is not-found and drops the cache too', async () => {
    const s = fakeStorage({ [cacheKey(HOST)]: envelope(DOC, T0) });
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => null,
      storage: s,
      now: at(T0 + CACHE_TTL_MS + 1),
    });
    expect(r).toEqual({ kind: 'not-found', hostname: HOST, reason: 'missing' });
    expect(s.map.size).toBe(0);
  });

  it('an unknown host on a multi-Event build is not-found', async () => {
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => null,
      envEventId: null,
      now: at(T0),
    });
    expect(r).toEqual({ kind: 'not-found', hostname: HOST, reason: 'missing' });
  });

  it('a HUNG fetch is bounded by the timeout instead of blocking paint forever', async () => {
    // The blank-screen failure class this repo has already fixed three times.
    // Without the race this test would never settle.
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: never,
      envEventId: null,
      timeoutMs: 10,
      now: at(T0),
    });
    expect(r).toEqual({ kind: 'not-found', hostname: HOST, reason: 'unreachable' });
  });

  it('resolves without any storage at all', async () => {
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => DOC,
      storage: null,
      now: at(T0),
    });
    expect(r).toMatchObject({ kind: 'event', source: 'network' });
  });
});
