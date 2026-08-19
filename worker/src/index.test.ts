// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cloudflareCache } from './index';
import { CACHE_VERSION, type CacheEnvelope } from './resolve';

class MemoryCache {
  readonly entries = new Map<string, Response>();
  deleted: string[] = [];

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    this.deleted.push(request.url);
    return this.entries.delete(request.url);
  }
}

const HOST = 'bodega-bay.fiveacross.app';
const primaryKey = new Request(`https://event-router.invalid/hostnames/${encodeURIComponent(HOST)}`);

function envelope(eventId: string, fetchedAt: number): CacheEnvelope {
  return {
    version: CACHE_VERSION,
    fetchedAt,
    record: { eventId, status: 'active', slug: 'bodega-bay' },
  };
}

function adapterOver(cache: MemoryCache) {
  return cloudflareCache(cache as unknown as Cache);
}

describe('the Cloudflare cache adapter', () => {
  it('round-trips an envelope through the synthetic key', async () => {
    const cache = new MemoryCache();
    const adapter = adapterOver(cache);
    await adapter.write(HOST, envelope('bodega-bay-2026', 1_000));
    expect(await adapter.read(HOST)).toEqual(envelope('bodega-bay-2026', 1_000));
    // The key must not collide with a cached ORIGIN response for a real
    // address — both live in the same store.
    expect([...cache.entries.keys()]).toEqual([primaryKey.url]);
  });

  it('reads an absent entry as a miss', async () => {
    expect(await adapterOver(new MemoryCache()).read(HOST)).toBeNull();
  });

  it('deletes the entry on drop', async () => {
    const cache = new MemoryCache();
    const adapter = adapterOver(cache);
    await adapter.write(HOST, envelope('bodega-bay-2026', 1_000));
    await adapter.drop(HOST);
    expect(await adapter.read(HOST)).toBeNull();
    expect(cache.deleted).toEqual([primaryKey.url]);
  });

  it('awaits the deletion rather than deferring it', async () => {
    // `resolveHost` awaits `drop` so a mapping revalidated away is gone before
    // the refusal is returned. A deferred delete would make that await
    // meaningless and let a concurrent request keep serving the old entry.
    let settled = false;
    const cache = new MemoryCache();
    const slow = {
      match: cache.match.bind(cache),
      put: cache.put.bind(cache),
      delete: async (request: Request) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled = true;
        return cache.delete(request);
      },
    };
    await cloudflareCache(slow as unknown as Cache).drop(HOST);
    expect(settled).toBe(true);
  });

  it.each([
    ['a version-drifted envelope', JSON.stringify({ version: CACHE_VERSION + 1, fetchedAt: 1, record: { eventId: 'e', status: 'active', slug: 'bodega-bay' } })],
    ['a partial record at the current version', JSON.stringify({ version: CACHE_VERSION, fetchedAt: 1, record: { eventId: 'e' } })],
    ['a null record', JSON.stringify({ version: CACHE_VERSION, fetchedAt: 1, record: null })],
    ['unparseable JSON', '{not json'],
  ])('reads %s as a miss rather than coercing it', async (_label, body) => {
    const cache = new MemoryCache();
    await cache.put(primaryKey, new Response(body));
    expect(await adapterOver(cache).read(HOST)).toBeNull();
  });

  it('is stateless, so no ordering guarantee survives between requests', async () => {
    // Pinning the ACCEPTED behaviour rather than a defended one. A durable
    // high-water fence was tried and removed: it cannot be made correct on the
    // Cache API's non-atomic primitives, and a request start time orders
    // requests rather than the document states they observed. The residual
    // exposure is one cacheTtlMs of staleness — the same window the TTL grants
    // anyway, and 1/144th of the client's own 12-hour cache. See index.ts.
    const cache = new MemoryCache();
    const first = adapterOver(cache);
    const second = adapterOver(cache);

    await second.write(HOST, envelope('newer', 2_000));
    await first.drop(HOST);
    // An older lookup returning late repopulates the entry; nothing here
    // prevents it, and the resolver's TTL is what bounds the consequence.
    await first.write(HOST, envelope('older', 1_000));

    expect(await second.read(HOST)).toEqual(envelope('older', 1_000));
  });
});
