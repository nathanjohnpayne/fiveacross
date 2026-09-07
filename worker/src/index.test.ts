// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';
import type { RegistryLookup } from './registry/state';

const SERVING: RegistryLookup = {
  kind: 'committed',
  revision: '42',
  desired: {
    kind: 'route',
    eventId: 'bodega-bay-2026',
    status: 'active',
    slug: 'bodega-bay',
    edition: 'fiveacross',
    pathNamespace: null,
  },
};

/**
 * The Cloudflare entrypoint used to need a `caches.default` adapter and its own
 * test file for it. Both are gone (#972), so what is worth proving here is what
 * the handler now wires: the registry service binding is passed through as the
 * router's only lookup seam, an unbound one still answers, and no global
 * platform store is touched on any path.
 */
function environment(overrides: Partial<Env> = {}): Env {
  return {
    ORIGIN_HOST: 'fiveacross.web.app',
    ROUTER_VERSION: 'entry-1',
    REGISTRY: { lookup: async () => SERVING },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Cloudflare entrypoint', () => {
  it('routes a serving address through the bound registry and proxies to the origin', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    const response = await worker.fetch(
      new Request('https://bodega-bay.fiveacross.app/board'),
      environment(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-event-router')).toBe('entry-1');
    expect(response.headers.get('x-event-router-revision')).toBe('42');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const proxied = fetchSpy.mock.calls[0][0] as Request;
    expect(new URL(proxied.url).hostname).toBe('fiveacross.web.app');
  });

  it('renders the fail-closed response when the registry binding is absent, rather than throwing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = environment();
    delete env.REGISTRY;

    const response = await worker.fetch(new Request('https://bodega-bay.fiveacross.app/'), env);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('lookup-unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('touches no Firebase host, Cache API or KV store on any outcome', async () => {
    // `caches` and a Firestore endpoint are both simply absent from this file
    // now. Asserting it at the entrypoint — the only file that may hold a
    // Cloudflare global — is what makes "no Firebase/KV/Cache request" a
    // property of the deployed artifact rather than of one decision module.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const cachesSpy = vi.fn();
    vi.stubGlobal('caches', {
      get default() {
        cachesSpy();
        throw new Error('the router must not touch the Cache API');
      },
    });

    for (const url of [
      'https://bodega-bay.fiveacross.app/',
      'https://unknown.fiveacross.app/',
      'https://admin.fiveacross.app/',
      'https://bodega-bay.fiveacross.app/__/auth/handler',
      'https://bodega-bay.fiveacross.app/.well-known/fiveacross-path-capability',
    ]) {
      await worker.fetch(new Request(url), environment());
    }

    expect(cachesSpy).not.toHaveBeenCalled();
    for (const [input] of fetchSpy.mock.calls) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.hostname).toBe('fiveacross.web.app');
    }
    vi.unstubAllGlobals();
  });
});
