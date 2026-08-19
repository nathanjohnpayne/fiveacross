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
import { isCacheEnvelope, type HostnameCache } from './resolve';

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
 * DELIBERATELY STATELESS, and the history matters because the obvious
 * "improvement" here has already been tried and reverted.
 *
 * Two overlapping lookups can finish out of order, so a positive write from a
 * lookup that began earlier can land after a later lookup refused the host and
 * deleted the entry — repopulating a mapping that is disabled or gone. Earlier
 * revisions of this file tried to fence that with a durable high-water mark:
 * a refusal wrote a `fenceAt` alongside the entry, reads and writes compared
 * against it, and a per-isolate map plus a per-host promise queue backed it up.
 *
 * It cannot work on these primitives, and Phase 4b review demonstrated why in
 * two independent ways. The fence update is read / `Math.max` / write across
 * separate Cache API operations with no compare-and-set, so two concurrent
 * drops can both read the old value and the older one can overwrite the newer,
 * regressing the very high-water mark the design claims to maintain. And the
 * ordering token was `deps.now()` at each lookup's start, which orders REQUESTS
 * rather than the document states they observed — a lookup starting later can
 * still read an older document — so even an atomic fence would be ordering the
 * wrong thing. Making it correct needs a compare-and-set store or a
 * server-issued document generation, neither of which the Cache API offers.
 *
 * So the race is accepted rather than half-defended, and the exposure is the
 * reason that is a proportionate call rather than a shrug. Its worst case is
 * that a disabled Event keeps serving for about one `cacheTtlMs` — five
 * minutes by default — after which revalidation corrects it. That is the same
 * staleness the TTL already grants by existing: a cached active entry serves
 * for up to five minutes after an Event is disabled whether or not any race
 * occurs. And the application accepts far more of it by design: the client
 * caches the identical mapping in `localStorage` for TWELVE HOURS
 * (specs/event-resolution.md), so a browser that has already resolved a host
 * outlives this window by two orders of magnitude regardless of what the edge
 * does. A takedown that genuinely cannot wait needs a cache purge and does not
 * become safe by adding an unsound fence here.
 *
 * A correct fence therefore needs a real coordination primitive — Durable
 * Objects or KV with a compare-and-set — and belongs in a change that can
 * justify that dependency, not smuggled into the router as cache bookkeeping.
 */
export function cloudflareCache(cache: Cache): HostnameCache {
  const keyFor = (host: string): Request =>
    new Request(`https://event-router.invalid/hostnames/${encodeURIComponent(host)}`);

  return {
    async read(host) {
      const hit = await cache.match(keyFor(host));
      if (hit === undefined) return null;
      try {
        // A shape-drifted or older-version envelope reads as a MISS rather
        // than being coerced, matching the client cache's rule. The predicate
        // checks every field the resolver dereferences, not just the version:
        // a current-version envelope with a partial `record` would otherwise
        // reach `decide` and throw a runtime error instead of rendering the
        // fail-closed page.
        const envelope: unknown = await hit.json();
        return isCacheEnvelope(envelope) ? envelope : null;
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
      await cache.put(keyFor(host), stored);
    },
    async drop(host) {
      // Awaited rather than handed to `waitUntil`: `resolveHost` awaits `drop`
      // so a mapping revalidated away is gone before the refusal is returned.
      // A write only benefits the NEXT request and could lag; a deletion is a
      // correctness barrier for requests already in flight.
      await cache.delete(keyFor(host));
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
      cache: cloudflareCache(caches.default),
      now: () => Date.now(),
    };

    return handleRequest(request, config, deps);
  },
} satisfies ExportedHandler<RouterEnv>;
