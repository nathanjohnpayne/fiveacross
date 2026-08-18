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
 * Every operation for one hostname is sequenced. That is not a throughput
 * preference: a refusal writes a short-lived fence, so a slower overlapping
 * lookup that observed the older active document cannot put it back after the
 * newer lookup has deactivated it.
 */
export function cloudflareCache(cache: Cache): HostnameCache {
  const keyFor = (host: string): Request =>
    new Request(`https://event-router.invalid/hostnames/${encodeURIComponent(host)}`);
  const fenceKeyFor = (host: string): Request =>
    new Request(`https://event-router.invalid/hostnames/${encodeURIComponent(host)}/fence`);
  const tails = new Map<string, Promise<void>>();

  const queue = <T>(host: string, operation: () => Promise<T>): Promise<T> => {
    const prior = tails.get(host) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(host, settled);
    void settled.finally(() => {
      if (tails.get(host) === settled) tails.delete(host);
    });
    return run;
  };

  const readFence = async (host: string): Promise<number | null> => {
    const hit = await cache.match(fenceKeyFor(host));
    if (hit === undefined) return null;
    try {
      const value: unknown = await hit.json();
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { fenceAt?: unknown }).fenceAt === 'number' &&
        Number.isFinite((value as { fenceAt: number }).fenceAt)
      ) {
        return (value as { fenceAt: number }).fenceAt;
      }
    } catch {
      // An invalid fence is no fence. The resolver still treats a cache fault
      // as a miss, so corrupt cache metadata cannot become a request failure.
    }
    return null;
  };

  const fenceResponse = (fenceAt: number): Response =>
    new Response(JSON.stringify({ fenceAt }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${CACHE_RETENTION_SECONDS}`,
      },
    });

  return {
    async read(host) {
      return queue(host, async () => {
        // A fence makes every old positive a miss until a lookup begun later
        // has positively replaced it. Check it before the envelope so a delete
        // racing through another request cannot leak an already-refused Event.
        if ((await readFence(host)) !== null) return null;
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
      });
    },
    async write(host, envelope) {
      return queue(host, async () => {
        const fenceAt = await readFence(host);
        // The drop has observed a lookup that started later than this one, so
        // this positive is known stale even if its delayed Firestore response
        // arrived last. Do not let it undo the refusal.
        if (fenceAt !== null && envelope.fetchedAt <= fenceAt) return;
        const stored = new Response(JSON.stringify(envelope), {
          headers: {
            'content-type': 'application/json',
            'cache-control': `max-age=${CACHE_RETENTION_SECONDS}`,
          },
        });
        await cache.put(keyFor(host), stored);
        // A lookup newer than the fence has supplied a positive answer. It is
        // now safe for later reads to use that answer; keeping the fence would
        // turn it into a permanent negative cache.
        if (fenceAt !== null) await cache.delete(fenceKeyFor(host));
      });
    },
    async drop(host, fenceAt) {
      return queue(host, async () => {
        // A plain cleanup (for a semantically invalid cache hit) needs no
        // fence. A server-verified refusal does: it is a correctness barrier
        // for late positive writes from requests that began earlier.
        if (fenceAt !== undefined) {
          const previous = await readFence(host);
          await cache.put(fenceKeyFor(host), fenceResponse(Math.max(previous ?? fenceAt, fenceAt)));
        }
        await cache.delete(keyFor(host));
      });
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
