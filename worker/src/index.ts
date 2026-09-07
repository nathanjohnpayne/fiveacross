// The Cloudflare entrypoint — the ONLY file in `worker/` that knows it is
// running on Cloudflare.
//
// Everything with a decision in it lives in `router.ts`, `host.ts`,
// `resolve.ts` and `notFound.ts`, none of which import a Cloudflare type. That
// split is what lets the whole decision table be tested by the repo's ordinary
// `npm test` (jsdom/node Vitest, no workerd, no emulator) while this file stays
// thin enough to read in one sitting and verify by eye. Adding logic here means
// adding logic that only `wrangler dev` can exercise, so don't.
//
// It got THINNER in #972, and the deletions are the deliverable. There is no
// `caches.default` adapter here any more, because there is no edge cache in
// front of the lookup at all: the registry's per-host Durable Object is the one
// transactional owner of acceptance and lookup, so a cached second answer could
// only ever disagree with it. There is likewise no Firebase api key, project
// id, or Firestore request to configure — the whole reader is gone (ADR 0014).
// What remains is two seams: the origin `fetch` and the named lookup-only
// registry service binding.

import { registryFromEnv, routerConfigFromEnv, type RouterEnv } from './config';
import { handleRequest, type RouterDeps } from './router';

export type { RouterEnv as Env };

export default {
  async fetch(request: Request, env: RouterEnv): Promise<Response> {
    const deps: RouterDeps = {
      // Wrapped rather than passed by reference so the global keeps its own
      // receiver; workerd does not require it, but a bare `fetch: fetch` is the
      // kind of detail that breaks silently if that ever changes.
      fetch: (input, init) => fetch(input, init),
      // `undefined` normalised to `null` at the seam, so an unbound binding is
      // a fail-closed answer rather than a method call on `undefined`.
      registry: registryFromEnv(env),
    };

    return handleRequest(request, routerConfigFromEnv(env), deps);
  },
} satisfies ExportedHandler<RouterEnv>;
