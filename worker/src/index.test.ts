// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cloudflareCache } from './index';
import { CACHE_VERSION, type CacheEnvelope } from './resolve';

class MemoryCache {
  private readonly entries = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

class FenceWriteFailingCache extends MemoryCache {
  deletedPrimary = false;

  override async put(request: Request, response: Response): Promise<void> {
    if (request.url.endsWith('/fence')) throw new Error('fence write unavailable');
    await super.put(request, response);
  }

  override async delete(request: Request): Promise<boolean> {
    this.deletedPrimary = true;
    return super.delete(request);
  }
}

const HOST = 'bodega-bay.fiveacross.app';

function envelope(eventId: string, fetchedAt: number): CacheEnvelope {
  return {
    version: CACHE_VERSION,
    fetchedAt,
    record: { eventId, status: 'active', slug: 'bodega-bay' },
  };
}

describe('Cloudflare cache revalidation fences', () => {
  it('does not let an older delayed positive write undo a newer drop', async () => {
    const edgeCache = cloudflareCache(new MemoryCache() as unknown as Cache);

    await edgeCache.write(HOST, envelope('old-event', 10));
    await edgeCache.drop(HOST, 20);
    // This models a request that began before the deactivation, received the
    // old Firestore document late, and reaches its cache write after the
    // newer request's refusal has completed.
    await edgeCache.write(HOST, envelope('old-event', 10));

    expect(await edgeCache.read(HOST)).toBeNull();

    await edgeCache.write(HOST, envelope('new-event', 21));
    expect(await edgeCache.read(HOST)).toMatchObject({ record: { eventId: 'new-event' } });

    // The successful newer write must not erase the high-water mark: a still
    // later completion of the older lookup remains unsafe.
    await edgeCache.write(HOST, envelope('old-event', 10));
    expect(await edgeCache.read(HOST)).toMatchObject({ record: { eventId: 'new-event' } });
  });

  it('still deletes the primary entry when persisting a refusal fence fails', async () => {
    const memory = new FenceWriteFailingCache();
    const edgeCache = cloudflareCache(memory as unknown as Cache);

    await edgeCache.write(HOST, envelope('old-event', 10));
    await edgeCache.drop(HOST, 20);

    // The durable fence failed, but this instance remembers the high-water
    // mark and must not serve the stale primary entry that drop removed.
    expect(memory.deletedPrimary).toBe(true);
    expect(await edgeCache.read(HOST)).toBeNull();
  });
});
