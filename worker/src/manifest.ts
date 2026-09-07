// The per-hostname PWA manifest response (#546, epic #529).
//
// One of the TWO bodies the router constructs besides the fail-closed page —
// the other is the path-capability projection in `router.ts` (#972). Everything
// else it answers is either the origin's bytes relayed untouched or the
// dependency-free not-found state; this is the one address whose correct answer
// depends on WHICH hostname asked, and cannot be recovered any other way.
//
// Why it cannot be fixed anywhere else: `name` and `short_name` are read from
// the manifest FILE at install time, so a multi-Event bundle — which does not
// know its Edition until `hostnames/{host}` answers — cannot bake them, and the
// app deliberately does not patch them at runtime either (`editions.ts`
// `applyEditionDocumentIdentity` repairs the document title and the iOS label
// and stops, because rewriting the manifest client-side strands an installed
// app with an identity no server can later correct). The edge is the only place
// left.
//
// The document is built by `src/web-manifest.ts`, the same module
// `vite.config.ts` emits `dist/manifest.webmanifest` from, so the file a guest
// installs from the origin and the file a guest installs from a routed
// hostname are the same bytes for the same Edition.

import {
  serializeWebManifest,
  webManifestForEdition,
  WEB_MANIFEST_CONTENT_TYPE,
  WEB_MANIFEST_PATH,
} from '../../src/web-manifest';

export { WEB_MANIFEST_PATH } from '../../src/web-manifest';

/**
 * Whether this request is the manifest request.
 *
 * `GET` and `HEAD` only. Anything else on this path falls through to the proxy
 * exactly as it does today — the router does not start refusing methods at an
 * address it used to relay, because that would be a behaviour change nobody
 * asked for hiding inside a branding fix.
 */
export function isWebManifestRequest(method: string, pathname: string): boolean {
  return (method === 'GET' || method === 'HEAD') && pathname === WEB_MANIFEST_PATH;
}

/**
 * The manifest for one resolved Edition.
 *
 * `no-cache` — revalidate, do not reuse blind — for the same reason Firebase
 * Hosting serves the built file that way: this document decides an installed
 * app's name, and a stale copy is a defect that outlives the deploy that caused
 * it. It is deliberately NOT `no-store`: revalidation is cheap and a 304 keeps
 * the install path fast.
 *
 * `HEAD` gets the identical headers with no body, rather than a body the
 * runtime might or might not strip. `content-length` is left to the runtime,
 * which computes it from the body it actually sends.
 *
 * `x-event-router` for the same reason every other response carries it: an
 * operator verifying a cutover needs to tell, from outside, whether this Worker
 * answered — and this address is the single most useful one to ask, because its
 * body says which Edition the edge resolved.
 */
export function webManifestResponse(
  edition: string | null,
  version: string,
  method: string,
): Response {
  const body = serializeWebManifest(webManifestForEdition(edition));
  return new Response(method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'content-type': `${WEB_MANIFEST_CONTENT_TYPE}; charset=utf-8`,
      'cache-control': 'no-cache',
      'x-event-router': version,
    },
  });
}
