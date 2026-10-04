import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bootNotFound,
  CACHE_PREFIX,
  CACHE_TTL_MS,
  CACHE_VERSION,
  cacheKey,
  coerceRoutingDoc,
  isRootMarker,
  isServable,
  PATH_NAMESPACES,
  readCache,
  resolveEvent,
  shouldMountOnBootstrapFailure,
  writeCache,
  type RoutingDoc,
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
  adultContent: true,
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

const envelope = (doc: RoutingDoc, fetchedAt = T0) =>
  JSON.stringify({ v: CACHE_VERSION, fetchedAt, previewValidated: true, doc });

const prePreviewEnvelope = (doc: HostnameDoc, fetchedAt = T0) =>
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
    expect(r?.requiresPreviewRevalidation).toBe(false);
  });

  it('marks an entry stale once past the TTL', () => {
    const s = fakeStorage({ [cacheKey(HOST)]: envelope(DOC, T0) });
    expect(readCache(s, HOST, T0 + CACHE_TTL_MS - 1)?.stale).toBe(false);
    expect(readCache(s, HOST, T0 + CACHE_TTL_MS + 1)?.stale).toBe(true);
  });

  it('treats a materially-future fetchedAt as stale, not fresh — a clock rollback cannot extend the TTL', () => {
    // Codex P3 on #582: `now - fetchedAt` goes negative when a device clock
    // rolls back after the entry was written, and a naive `> CACHE_TTL_MS`
    // check reads that as fresh, letting the rollback extend the 12-hour
    // bound by however far the clock moved.
    const s = fakeStorage({ [cacheKey(HOST)]: envelope(DOC, T0) });
    expect(readCache(s, HOST, T0 - 1)?.stale).toBe(false); // ordinary skew tolerance
    expect(readCache(s, HOST, T0 - CACHE_TTL_MS)?.stale).toBe(true);
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
    // A non-empty VITE_EVENT_ID means the bundle serves one Event, so consulting
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
    // No hostname document was read, so there is no Slug to report (#556) —
    // callers fall back to `eventId` as the closest available identifier.
    expect(r).toMatchObject({ slug: null });
  });

  it('a FRESH cache hit resolves with no network call', async () => {
    const fetchDoc = vi.fn(never);
    const s = fakeStorage({ [cacheKey(HOST)]: envelope(DOC, T0) });
    const r = await resolveEvent({ hostname: HOST, fetchDoc, storage: s, now: at(T0) });
    expect(r).toMatchObject({ kind: 'event', eventId: 'bodega-bay-2026', source: 'cache' });
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('revalidates a fresh cache written before the optional preview slice', async () => {
    const s = fakeStorage({ [cacheKey(HOST)]: prePreviewEnvelope(DOC, T0) });
    const fresh = { ...DOC, preview: { eventName: 'Weekend in Bodega Bay' } };
    const fetchDoc = vi.fn(async () => fresh);
    const r = await resolveEvent({ hostname: HOST, fetchDoc, storage: s, now: at(T0) });
    expect(r).toMatchObject({ kind: 'event', source: 'network', preview: fresh.preview });
    expect(fetchDoc).toHaveBeenCalledOnce();
    expect(readCache(s, HOST, T0)?.requiresPreviewRevalidation).toBe(false);
  });

  it('keeps a pre-preview cache as the offline routing fallback', async () => {
    const s = fakeStorage({ [cacheKey(HOST)]: prePreviewEnvelope(DOC, T0) });
    const fetchDoc = vi.fn(async () => {
      throw new Error('offline');
    });
    const r = await resolveEvent({ hostname: HOST, fetchDoc, storage: s, now: at(T0) });
    expect(r).toMatchObject({ kind: 'event', source: 'cache', eventId: DOC.eventId });
    expect(fetchDoc).toHaveBeenCalledOnce();
  });

  it('surfaces the Slug from a resolved hostname document (#556)', async () => {
    const s = fakeStorage();
    const r = await resolveEvent({ hostname: HOST, fetchDoc: async () => DOC, storage: s, now: at(T0) });
    expect(r).toMatchObject({ kind: 'event', slug: 'bodega-bay' });
  });

  it('a legacy hostname document with no Slug field surfaces `null`, not undefined (#556)', async () => {
    const s = fakeStorage();
    const legacyDoc: HostnameDoc = { ...DOC, slug: undefined };
    const r = await resolveEvent({ hostname: HOST, fetchDoc: async () => legacyDoc, storage: s, now: at(T0) });
    expect(r).toMatchObject({ kind: 'event', slug: null });
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

// Phase 4b P1 on #576: the bootstrap .catch must not fail OPEN on a
// hostname-resolved build. Its pre-resolution EVENT_ID is the legacy fallback,
// so mounting on an unexpected exception would serve the legacy Event on an
// arbitrary hostname — with the auth-reachability gate skipped too.
describe('shouldMountOnBootstrapFailure — the .catch build-mode split', () => {
  it('mounts an env-pinned build: the baked Event IS the correct one', () => {
    expect(shouldMountOnBootstrapFailure('med-2026')).toBe(true);
  });

  it('fails CLOSED on a hostname-resolved build: unavailable screen, no app mount', () => {
    expect(shouldMountOnBootstrapFailure(null)).toBe(false);
    expect(shouldMountOnBootstrapFailure('')).toBe(false);
    expect(shouldMountOnBootstrapFailure(undefined)).toBe(false);
  });
});

// #1388 (specs/path-addressing-and-root.md § D1, § "Contracts this spec
// extends"): root-shaped routing documents and the third resolution outcome.
// Reading them must not turn path addressing on: nothing below may change what
// an Event mapping resolves to, and `src/main.tsx` renders the new outcome as
// the not-found screen the same document produced before (`bootNotFound`)
// until the doorway (#1392) and the basename (#1390) land.
const ROOT_HOST = 'fiveacross.app';
const DOORWAY: RoutingDoc = { root: 'doorway', edition: 'fiveacross', pathNamespace: 'fiveacross.app' };
const MIRROR_MARKER: RoutingDoc = { root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
const coerced = (raw: unknown, host = ROOT_HOST) => async () => coerceRoutingDoc(raw, host);

describe('coerceRoutingDoc — a root marker is read deliberately, never by accident', () => {
  it('reads a `root: doorway` document with no eventId as a root marker', () => {
    const doc = coerceRoutingDoc(DOORWAY, ROOT_HOST);
    expect(doc).toEqual(DOORWAY);
    expect(isRootMarker(doc)).toBe(true);
  });

  it('reads the non-serving `root: not-found` capability marker', () => {
    expect(coerceRoutingDoc(MIRROR_MARKER, 'vacaybingo.vercel.app')).toEqual(MIRROR_MARKER);
    // The GCB mirror's marker carries no capability at all.
    expect(coerceRoutingDoc({ root: 'not-found', edition: 'gcb' }, 'gaycruisebingo.vercel.app')).toEqual({
      root: 'not-found',
      edition: 'gcb',
    });
  });

  it('keeps an eventId-less document with no valid `root` malformed (null)', () => {
    for (const raw of [
      { edition: 'fiveacross' },
      { edition: 'fiveacross', status: 'active' },
      { edition: 'fiveacross', root: 'landing' },
      { edition: 'fiveacross', root: true },
      { edition: 'fiveacross', root: null },
      // A marker may not carry the route-only fields the registry refuses on one.
      { ...DOORWAY, status: 'active' },
      { ...DOORWAY, slug: 'fiveacross' },
      // Present-but-empty is not absent: it stays a malformed Event mapping.
      { ...DOORWAY, eventId: '' },
      { ...DOORWAY, eventId: null },
      null,
      'doorway',
    ]) {
      expect(coerceRoutingDoc(raw, ROOT_HOST), JSON.stringify(raw)).toBeNull();
    }
  });

  it('reads a document naming an eventId as that Event, even with a stray `root`', () => {
    const doc = coerceRoutingDoc({ ...DOC, root: 'doorway' }, HOST);
    expect(isRootMarker(doc)).toBe(false);
    expect(doc).toMatchObject({ eventId: DOC.eventId, status: 'active' });
    expect(doc).not.toHaveProperty('root');
  });

  it('carries none of the Event-scoped fields a route-to-root conversion leaves behind', () => {
    const left = { ...DOORWAY, adultContent: false, canonicalHost: ROOT_HOST, isCanonical: true, preview: { eventName: 'Bodega Bay' }, apexPath: true };
    expect(coerceRoutingDoc(left, ROOT_HOST)).toEqual(DOORWAY);
  });

  it('reads pathNamespace and apexPath fail-closed: only a Namespace apex, only a literal true', () => {
    for (const bad of ['gaycruisebingo.com', 'FIVEACROSS.APP', '', 42, null]) {
      expect(coerceRoutingDoc({ ...DOORWAY, pathNamespace: bad }, ROOT_HOST)).not.toHaveProperty('pathNamespace');
      expect(coerceRoutingDoc({ ...DOC, pathNamespace: bad }, HOST)).not.toHaveProperty('pathNamespace');
    }
    expect(coerceRoutingDoc({ ...DOC, pathNamespace: 'vacaybingo.com' }, HOST)).toMatchObject({ pathNamespace: 'vacaybingo.com' });
    expect(coerceRoutingDoc({ ...DOC, apexPath: true }, HOST)).toMatchObject({ apexPath: true });
    for (const bad of ['true', 1, false]) {
      expect(coerceRoutingDoc({ ...DOC, apexPath: bad }, HOST)).not.toHaveProperty('apexPath');
    }
  });

  it('PATH_NAMESPACES mirrors the registry derivation and the edge exactly', () => {
    const literal = (path: string, constName: string): string[] => {
      const src = readFileSync(`${process.cwd()}/${path}`, 'utf-8');
      const start = src.indexOf(constName);
      const open = src.indexOf('[', src.indexOf('=', start));
      const close = src.indexOf(']', open);
      return [...src.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    };
    const client = [...PATH_NAMESPACES].sort();
    expect(literal('scripts/event-router-registry/hostname-projection.mjs', 'export const PATH_NAMESPACES')).toEqual(client);
    expect(literal('worker/src/host.ts', 'export const NAMESPACES')).toEqual(client);
  });
});

describe('resolveEvent — the third outcome', () => {
  it('a `root: doorway` document resolves `kind: root` and names no Event', async () => {
    const r = await resolveEvent({ hostname: ROOT_HOST, fetchDoc: coerced(DOORWAY), storage: fakeStorage(), now: at(T0) });
    expect(r).toEqual({ kind: 'root', hostname: ROOT_HOST, edition: 'fiveacross', pathNamespace: 'fiveacross.app', source: 'network' });
    expect(r).not.toHaveProperty('eventId');
  });

  it('a doorway with no capability carries `pathNamespace: null`', async () => {
    const r = await resolveEvent({ hostname: 'gaycruisebingo.com', fetchDoc: coerced({ root: 'doorway', edition: 'gcb' }), now: at(T0) });
    expect(r).toMatchObject({ kind: 'root', edition: 'gcb', pathNamespace: null });
  });

  it('`root: not-found` is not-found at `/` while still exposing its capability', async () => {
    const r = await resolveEvent({ hostname: 'vacaybingo.vercel.app', fetchDoc: coerced(MIRROR_MARKER), now: at(T0) });
    expect(r).toEqual({ kind: 'not-found', hostname: 'vacaybingo.vercel.app', reason: 'missing', pathNamespace: 'vacaybingo.com' });
  });

  it('an eventId-less document with no `root` is not-found, exactly as before', async () => {
    const r = await resolveEvent({ hostname: ROOT_HOST, fetchDoc: coerced({ edition: 'fiveacross', pathNamespace: 'fiveacross.app' }), now: at(T0) });
    expect(r).toEqual({ kind: 'not-found', hostname: ROOT_HOST, reason: 'missing' });
  });

  it('a document naming an eventId resolves to that Event, and no doorway is produced', async () => {
    const raw = { ...DOC, root: 'doorway', pathNamespace: 'vacaybingo.com' };
    const r = await resolveEvent({ hostname: HOST, fetchDoc: coerced(raw, HOST), storage: fakeStorage(), now: at(T0) });
    expect(r).toMatchObject({ kind: 'event', eventId: DOC.eventId, source: 'network' });
  });

  it('caches the marker under its own hostname and serves it fresh with no network', async () => {
    const s = fakeStorage();
    await resolveEvent({ hostname: ROOT_HOST, fetchDoc: coerced(DOORWAY), storage: s, now: at(T0) });
    expect(readCache(s, ROOT_HOST, T0)?.doc).toEqual(DOORWAY);
    const fetchDoc = vi.fn(coerced(DOORWAY));
    const r = await resolveEvent({ hostname: ROOT_HOST, fetchDoc, storage: s, now: at(T0 + 1) });
    expect(r).toMatchObject({ kind: 'root', source: 'cache' });
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('a stale marker still answers when revalidation fails, like a stale Event mapping', async () => {
    const s = fakeStorage({ [cacheKey(ROOT_HOST)]: envelope(DOORWAY, T0) });
    const r = await resolveEvent({
      hostname: ROOT_HOST,
      fetchDoc: async () => {
        throw new Error('offline');
      },
      storage: s,
      now: at(T0 + CACHE_TTL_MS + 1),
    });
    expect(r).toMatchObject({ kind: 'root', source: 'cache' });
  });

  it('a host repointed from an Event to a marker stops serving the cached Event', async () => {
    const s = fakeStorage({ [cacheKey(ROOT_HOST)]: envelope({ ...DOC, canonicalHost: ROOT_HOST }, T0) });
    const r = await resolveEvent({ hostname: ROOT_HOST, fetchDoc: coerced(DOORWAY), storage: s, now: at(T0 + CACHE_TTL_MS + 1) });
    expect(r.kind).toBe('root');
    expect(readCache(s, ROOT_HOST, T0)?.doc).toEqual(DOORWAY);
  });
});

describe('the enablement barrier — a pre-capability cache entry is never served', () => {
  const v1 = (doc: unknown, fetchedAt = T0) => JSON.stringify({ v: 1, fetchedAt, previewValidated: true, doc });

  it('bumps the schema version past the pre-capability one', () => {
    // The lifecycle helper's `pathCapabilityBarrier` record attests this value
    // as `resolutionCacheSchemaVersion`; lowering it would re-admit v1 entries.
    expect(CACHE_VERSION).toBe(2);
  });

  it('a FRESH entry cached under the old version is a MISS: the server is asked', async () => {
    const s = fakeStorage({ [cacheKey(HOST)]: v1(DOC) });
    expect(readCache(s, HOST, T0)).toBeNull();
    const fetchDoc = vi.fn(async () => ({ ...DOC, eventId: 'repointed-2027' }));
    const r = await resolveEvent({ hostname: HOST, fetchDoc, storage: s, now: at(T0 + 1) });
    expect(fetchDoc).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ kind: 'event', eventId: 'repointed-2027', source: 'network' });
  });

  it('and is not served as the offline fallback either', async () => {
    const s = fakeStorage({ [cacheKey(ROOT_HOST)]: v1({ ...DOC, canonicalHost: ROOT_HOST }) });
    const r = await resolveEvent({
      hostname: ROOT_HOST,
      fetchDoc: async () => {
        throw new Error('offline');
      },
      storage: s,
      now: at(T0 + 1),
    });
    expect(r).toEqual({ kind: 'not-found', hostname: ROOT_HOST, reason: 'unreachable' });
  });
});

describe('bootNotFound — reading the third outcome turns nothing on', () => {
  it('mounts only an Event', () => {
    expect(bootNotFound({ kind: 'event', eventId: 'e', canonicalHost: null, edition: null, slug: null, adultContent: true, adultContentProven: false, source: 'env' })).toBeNull();
  });

  it('renders a doorway as the same not-found screen the document produced before (#1392 ships the doorway)', () => {
    expect(bootNotFound({ kind: 'root', hostname: ROOT_HOST, edition: 'fiveacross', pathNamespace: 'fiveacross.app', source: 'network' })).toEqual({ hostname: ROOT_HOST, reason: 'missing' });
  });

  it('passes every not-found through unchanged', () => {
    for (const reason of ['missing', 'inactive', 'unreachable'] as const) {
      expect(bootNotFound({ kind: 'not-found', hostname: HOST, reason, pathNamespace: null })).toEqual({ hostname: HOST, reason });
    }
  });

  // The #766 guardrail: if a production root host's Event mapping already
  // carried `pathNamespace` when this reader merged, the client must still
  // resolve and mount it exactly as before — capability is read, never acted
  // on, until the basename is threaded (#1390).
  it.each(['fiveacross.app', 'vacaybingo.com', 'fiveacross.vercel.app', 'vacaybingo.vercel.app'])(
    'an Event mapping on %s resolves identically with or without pathNamespace',
    async (host) => {
      const raw = { ...DOC, canonicalHost: host };
      const ns = host.includes('vacay') ? 'vacaybingo.com' : 'fiveacross.app';
      const plain = await resolveEvent({ hostname: host, fetchDoc: coerced(raw, host), now: at(T0) });
      const capable = await resolveEvent({ hostname: host, fetchDoc: coerced({ ...raw, pathNamespace: ns, apexPath: true }, host), now: at(T0) });
      expect(capable).toEqual(plain);
      expect(bootNotFound(capable)).toBeNull();
    },
  );
});
