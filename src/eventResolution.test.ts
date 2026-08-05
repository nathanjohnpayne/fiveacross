import { describe, it, expect, vi } from 'vitest';
import {
  CACHE_PREFIX,
  cacheKey,
  readCache,
  resolveEvent,
  writeCache,
  type HostnameDoc,
  type StorageLike,
} from './eventResolution';

// Covers #543 / specs/x-multi-event-schema.md § "Recommended migration seam".
// The whole decision table is exercised without a network or a browser, which
// is the point of keeping resolveEvent injected.

const HOST = 'bodega-bay.vacaybingo.com';

const DOC: HostnameDoc = {
  eventId: 'bodega-bay-2026',
  canonicalHost: HOST,
  edition: 'vacay',
  status: 'active',
  slug: 'bodega-bay',
  isCanonical: true,
};

/** In-memory StorageLike with optional failure injection (private mode). */
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
  } satisfies StorageLike & { map: Map<string, string> };
}

const never = () => new Promise<HostnameDoc | null>(() => {});

describe('eventResolution — cache helpers', () => {
  it('keys the cache by hostname, lowercased', () => {
    expect(cacheKey('BODEGA-BAY.Vacaybingo.com')).toBe(`${CACHE_PREFIX}bodega-bay.vacaybingo.com`);
  });

  it('round-trips a document', () => {
    const s = fakeStorage();
    writeCache(s, HOST, DOC);
    expect(readCache(s, HOST)).toMatchObject({ eventId: 'bodega-bay-2026', edition: 'vacay' });
  });

  it('treats corrupt JSON as no cache rather than throwing', () => {
    const s = fakeStorage({ [cacheKey(HOST)]: '{not json' });
    expect(readCache(s, HOST)).toBeNull();
  });

  it('rejects a shape-drifted entry missing eventId', () => {
    const s = fakeStorage({ [cacheKey(HOST)]: JSON.stringify({ status: 'active' }) });
    expect(readCache(s, HOST)).toBeNull();
  });

  it('survives storage that throws on access (private mode)', () => {
    const s = fakeStorage({}, { throws: true });
    expect(readCache(s, HOST)).toBeNull();
    expect(() => writeCache(s, HOST, DOC)).not.toThrow();
  });
});

describe('eventResolution — resolveEvent decision table', () => {
  it('a cache hit resolves with NO network call at all', async () => {
    // The offline-cold-boot property: first paint must not depend on a request.
    const fetchDoc = vi.fn(never);
    const s = fakeStorage({ [cacheKey(HOST)]: JSON.stringify(DOC) });
    const r = await resolveEvent({ hostname: HOST, fetchDoc, storage: s });
    expect(r).toMatchObject({ kind: 'event', eventId: 'bodega-bay-2026', source: 'cache' });
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('a cache MISS fetches, resolves, and populates the cache', async () => {
    const s = fakeStorage();
    const r = await resolveEvent({ hostname: HOST, fetchDoc: async () => DOC, storage: s });
    expect(r).toMatchObject({ kind: 'event', eventId: 'bodega-bay-2026', source: 'network' });
    expect(readCache(s, HOST)).toMatchObject({ eventId: 'bodega-bay-2026' });
  });

  it('an inactive cached entry does not short-circuit — it refetches', async () => {
    const s = fakeStorage({ [cacheKey(HOST)]: JSON.stringify({ ...DOC, status: 'archived' }) });
    const r = await resolveEvent({ hostname: HOST, fetchDoc: async () => DOC, storage: s });
    expect(r).toMatchObject({ kind: 'event', source: 'network' });
  });

  it('an archived host is not-found, and is NOT cached', async () => {
    // Caching it would keep the Event dark for the cache's lifetime after
    // someone re-activates it.
    const s = fakeStorage();
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => ({ ...DOC, status: 'archived' }),
      storage: s,
    });
    expect(r).toEqual({ kind: 'not-found', hostname: HOST, reason: 'inactive' });
    expect(s.map.size).toBe(0);
  });

  it('an unknown host is not-found on a multi-Event build (no VITE_EVENT_ID)', async () => {
    const r = await resolveEvent({ hostname: HOST, fetchDoc: async () => null, envEventId: null });
    expect(r).toEqual({ kind: 'not-found', hostname: HOST, reason: 'missing' });
  });

  it('an unknown host falls back to env on a SINGLE-Event build', async () => {
    // The Gay Cruise Bingo build: its hostname has no hostnames/ document, and
    // VITE_EVENT_ID's presence is what marks the bundle as single-Event.
    const r = await resolveEvent({
      hostname: 'gaycruisebingo.com',
      fetchDoc: async () => null,
      envEventId: 'med-2026',
    });
    expect(r).toMatchObject({ kind: 'event', eventId: 'med-2026', source: 'env' });
  });

  it('a fetch rejection falls back to env rather than throwing', async () => {
    const r = await resolveEvent({
      hostname: 'gaycruisebingo.com',
      fetchDoc: async () => {
        throw new Error('offline');
      },
      envEventId: 'med-2026',
    });
    expect(r).toMatchObject({ kind: 'event', eventId: 'med-2026', source: 'env' });
  });

  it('a fetch rejection with no cache and no env is not-found, never a throw', async () => {
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => {
        throw new Error('offline');
      },
      envEventId: null,
    });
    expect(r).toEqual({ kind: 'not-found', hostname: HOST, reason: 'unreachable' });
  });

  it('a HUNG fetch is bounded by the timeout instead of blocking paint forever', async () => {
    // The blank-screen failure class this repo has already shipped three fixes
    // for. Without the race, this test would never settle.
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: never,
      envEventId: null,
      timeoutMs: 10,
      delay: (ms) => new Promise((res) => setTimeout(res, ms)),
    });
    expect(r).toEqual({ kind: 'not-found', hostname: HOST, reason: 'unreachable' });
  });

  it('a hung fetch on a single-Event build still boots that Event', async () => {
    const r = await resolveEvent({
      hostname: 'gaycruisebingo.com',
      fetchDoc: never,
      envEventId: 'med-2026',
      timeoutMs: 10,
    });
    expect(r).toMatchObject({ kind: 'event', eventId: 'med-2026', source: 'env' });
  });

  it('resolves without any storage at all', async () => {
    const r = await resolveEvent({ hostname: HOST, fetchDoc: async () => DOC, storage: null });
    expect(r).toMatchObject({ kind: 'event', source: 'network' });
  });
});
