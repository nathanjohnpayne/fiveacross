// Turning Cloudflare bindings into a `RouterConfig`.
//
// Its own module, and not three lines inside `index.ts`, for one reason: a
// misconfigured deployment is a state this router PROMISES to survive — it must
// answer the documented `lookup-unavailable` fail-closed response rather than
// throw — and a promise about misconfiguration cannot be kept by code that only
// the real Cloudflare runtime can execute. Here it is testable.
//
// EVERY binding is optional, including the ones `wrangler.toml` declares. That
// is not defensive typing for its own sake: `wrangler.toml` deliberately does
// NOT commit `FIREBASE_API_KEY` (it is set with `wrangler secret put`), so
// "deployed but not yet configured" is a state the deployment procedure
// actively creates, on purpose, between step 1 and step 2 of the cutover. A
// binding typed `string` while the runtime hands over `undefined` is a lie the
// type checker cannot catch, and the first thing to touch it — `.length` —
// throws a Worker runtime error instead of rendering the fail-closed page.

import type { RouterConfig } from './router';

export interface RouterEnv {
  /** The Firebase Hosting origin, e.g. `fiveacross.web.app`. */
  ORIGIN_HOST?: string;
  FIREBASE_PROJECT_ID?: string;
  /** The Firebase WEB api key — the same non-secret value that ships in every
   *  production bundle. Set with `wrangler secret put` rather than committed,
   *  purely so GitHub's secret scanner does not raise a standing false positive
   *  on the repo; it grants nothing a page view does not already grant. */
  FIREBASE_API_KEY?: string;
  LOOKUP_TIMEOUT_MS?: string;
  HOSTNAME_CACHE_TTL_MS?: string;
  ROUTER_VERSION?: string;
}

export const DEFAULT_LOOKUP_TIMEOUT_MS = 2_000;
export const DEFAULT_CACHE_TTL_MS = 300_000;
export const DEFAULT_ROUTER_VERSION = 'v1';

/** A malformed or absent numeric binding falls back rather than propagating
 *  `NaN`, which would make every timeout comparison silently false. */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * An absent string binding becomes `''`, never `undefined`.
 *
 * `''` is the value the router's configuration checks are written against, so
 * this is what converts "the secret was never bound" into the documented
 * fail-closed answer instead of a crash.
 */
export function routerConfigFromEnv(env: RouterEnv): RouterConfig {
  return {
    originHost: env.ORIGIN_HOST ?? '',
    projectId: env.FIREBASE_PROJECT_ID ?? '',
    apiKey: env.FIREBASE_API_KEY ?? '',
    lookupTimeoutMs: positiveInt(env.LOOKUP_TIMEOUT_MS, DEFAULT_LOOKUP_TIMEOUT_MS),
    cacheTtlMs: positiveInt(env.HOSTNAME_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
    version: env.ROUTER_VERSION ?? DEFAULT_ROUTER_VERSION,
  };
}
