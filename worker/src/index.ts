// The Cloudflare entrypoint — the ONLY file in `worker/` that knows it is
// running on Cloudflare.
//
// Everything with a decision in it lives in `router.ts`, `host.ts`,
// `resolve.ts` and `notFound.ts`, none of which import a Cloudflare type. That
// split is what lets the whole decision table be tested by the repo's ordinary
// `npm test` (jsdom/node Vitest, no workerd, no emulator) while this file stays
// thin enough to read in one sitting and verify by eye. Adding logic here means
// adding logic that only `wrangler dev` can exercise, so don't.

import { routerConfigFromEnv, type RouterEnv } from './config';
import { handleRequest, type RouterDeps } from './router';
import { CACHE_VERSION, type CacheEnvelope, type HostnameCache } from './resolve';

export type { RouterEnv as Env };

/** How long an envelope may survive in Cloudflare's cache. This is NOT the
 *  freshness window — `resolve.ts` owns that via `fetchedAt` — it is the
 *  ceiling on how stale a stale-serve may get when Firestore is unreachable.
 *  Kept long precisely so a Firestore outage does not become an outage here. */
const CACHE_RETENTION_SECONDS = 86_400;

/**
 * Cloudflare's `caches.default` behind the narrow `HostnameCache` seam.
 *
 * The key is a synthetic URL on a domain that resolves nowhere, so a cache
 * entry can never be confused with a cached ORIGIN response for a real
 * address — the two live in the same store.
 *
 * Writes go through `waitUntil` rather than being awaited: a guest waiting on
 * their first byte should not also be waiting on a cache write that only
 * benefits the next guest.
 */
function cloudflareCache(cache: Cache, ctx: ExecutionContext): HostnameCache {
  const keyFor = (host: string): Request =>
    new Request(`https://event-router.invalid/hostnames/${encodeURIComponent(host)}`);

  return {
    async read(host) {
      const hit = await cache.match(keyFor(host));
      if (hit === undefined) return null;
      try {
        const envelope = (await hit.json()) as CacheEnvelope;
        // A shape-drifted or older-version envelope reads as a MISS rather
        // than being coerced, matching the client cache's rule.
        return envelope?.version === CACHE_VERSION ? envelope : null;
      } catch {
        return null;
      }
    },
    async write(host, envelope) {
      const stored = new Response(JSON.stringify(envelope), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `max-age=${CACHE_RETENTION_SECONDS}`,
        },
      });
      ctx.waitUntil(cache.put(keyFor(host), stored));
    },
    async drop(host) {
      ctx.waitUntil(cache.delete(keyFor(host)));
    },
  };
}

export default {
  async fetch(request: Request, env: RouterEnv, ctx: ExecutionContext): Promise<Response> {
    const config = routerConfigFromEnv(env);

    const deps: RouterDeps = {
      // Wrapped rather than passed by reference so the global keeps its own
      // receiver; workerd does not require it, but a bare `fetch: fetch` is the
      // kind of detail that breaks silently if that ever changes.
      fetch: (input, init) => fetch(input, init),
      cache: cloudflareCache(caches.default, ctx),
      now: () => Date.now(),
    };

    return handleRequest(request, config, deps);
  },
} satisfies ExportedHandler<RouterEnv>;
