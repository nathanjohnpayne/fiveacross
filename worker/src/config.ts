// Turning Cloudflare bindings into a `RouterConfig` and a registry seam.
//
// Its own module, and not three lines inside `index.ts`, for one reason: a
// misconfigured deployment is a state this router PROMISES to survive — it must
// answer the documented `lookup-unavailable` fail-closed response rather than
// throw — and a promise about misconfiguration cannot be kept by code that only
// the real Cloudflare runtime can execute. Here it is testable.
//
// EVERY binding is optional, including the ones `wrangler.toml` declares. That
// is not defensive typing for its own sake: "deployed but not yet bound" is a
// state the deployment procedure actively creates, on purpose, between
// uploading this Worker and the registry service existing beside it. A binding
// typed non-optional while the runtime hands over `undefined` is a lie the type
// checker cannot catch, and the first thing to touch it — `.length`, or a
// method call — throws a Worker runtime error instead of rendering the
// fail-closed page.
//
// `FIREBASE_PROJECT_ID` and `FIREBASE_API_KEY` are deliberately absent (#972).
// The Firestore REST reader they configured is gone, so there is no Firebase
// credential, project reference, or data-plane binding left in this Worker at
// all — which is the property that makes it compatible with enforced App Check
// (ADR 0014) rather than dependent on an exemption from it.

import type { RegistryLookupService } from './registry/state';
import type { RouterConfig } from './router';

export interface RouterEnv {
  /** The Firebase Hosting origin, e.g. `fiveacross.web.app`. */
  ORIGIN_HOST?: string;
  ROUTER_VERSION?: string;
  LOOKUP_TIMEOUT_MS?: string;
  /**
   * The registry service binding, bound in `wrangler.toml` with an EXPLICIT
   * `entrypoint = "RegistryLookupEntrypoint"`.
   *
   * Typed as the one-method seam rather than as the registry Worker's module,
   * so this program can never reach the registry's default public `fetch`, its
   * `HOST_REGISTRY` Durable Object namespace, or any list or mutation method
   * even if a future edit misconfigures the binding. `router-configuration.d.ts`
   * carries Wrangler's own generated shape for the same binding —
   * `Service<typeof RegistryLookupEntrypoint>` — and `routerBinding.test.ts`
   * holds the two in agreement.
   */
  REGISTRY?: RegistryLookupService;
}

export const DEFAULT_LOOKUP_TIMEOUT_MS = 2_000;
export const DEFAULT_ROUTER_VERSION = 'v1';

/**
 * A malformed or absent numeric binding falls back rather than propagating
 * `NaN`, which would make every timeout comparison silently false.
 *
 * The WHOLE trimmed string must be digits — `Number.parseInt` alone is not
 * enough, because it accepts a valid prefix and discards the rest. That turns
 * `750.5` into `750` and `2000ms` into `2000`, which merely look like the
 * operator got away with it, and turns `1e3` into **1** — a one-millisecond
 * lookup timeout that fails closed on every host while the binding reads as if
 * it said one second. Silently honouring a prefix of a value nobody wrote is
 * worse than ignoring the value.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * An absent string binding becomes `''`, never `undefined`.
 *
 * `''` is the value the router's configuration checks are written against, so
 * this is what converts "the binding was never bound" into the documented
 * fail-closed answer instead of a crash.
 */
export function routerConfigFromEnv(env: RouterEnv): RouterConfig {
  return {
    originHost: env.ORIGIN_HOST ?? '',
    lookupTimeoutMs: positiveInt(env.LOOKUP_TIMEOUT_MS, DEFAULT_LOOKUP_TIMEOUT_MS),
    version: env.ROUTER_VERSION ?? DEFAULT_ROUTER_VERSION,
  };
}

/**
 * The registry seam, or `null` when the binding is absent.
 *
 * Normalised to `null` for the same reason a string binding is normalised to
 * `''`: the router answers an unbound registry with `lookup-unavailable`, and
 * an `undefined` that reaches a method call answers with a runtime error
 * instead. It is deliberately NOT folded into `RouterConfig` — a live service
 * stub is a dependency, not configuration, and keeping it in `RouterDeps` is
 * what lets `router.test.ts` drive the whole decision table with a plain
 * object in its place.
 */
export function registryFromEnv(env: RouterEnv): RegistryLookupService | null {
  return env.REGISTRY ?? null;
}
