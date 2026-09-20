// The per-hostname `<head>` rewrite (#1118, epic #529).
//
// The THIRD thing the Worker does to a response body, and the first that
// touches the origin's own bytes. `manifest.ts` (#546) and the path-capability
// projection in `router.ts` (#972) CONSTRUCT a document from a pure builder;
// this one mutates a streamed HTML response as it passes through, which is a
// different risk profile and the reason #1118 is a separate change from #546.
//
// What it corrects: the crawler-facing tags a hostname-resolved bundle bakes
// once per build and can never repair at runtime, because a crawler runs no
// JavaScript — the `og:*` / `twitter:*` share block, `<meta name="description">`
// and `<meta name="theme-color">`. `editions.ts` `applyEditionDocumentIdentity`
// repairs `<title>` and the iOS home-screen label in the DOM after resolution
// and stops there; those two are deliberately not rewritten here (see
// `RUNTIME_REPAIRED_TOKENS` in `src/html-head-identity.ts`).
//
// The module splits along the same line every other decision module in
// `worker/` splits along: the DECISION — which responses may be rewritten, and
// which tag gets which value — is pure and runs under plain Node in
// `htmlHead.test.ts`, while the streaming application of it is one small
// function that needs a workerd runtime and is proved under Miniflare in
// `routerHtmlHead.integration.test.ts`. `router.ts` takes the transform as an
// injected seam for exactly that reason, the way it already takes `fetch` and
// the registry.

import { brandFor } from '../../src/edition-brands';
import { headIdentityEdits, type HeadIdentityEdit } from '../../src/html-head-identity';

export type { HeadIdentityEdit } from '../../src/html-head-identity';

/**
 * The platform's streaming HTML transform, as a seam.
 *
 * `index.ts` supplies {@link rewriteHeadWithHTMLRewriter}; `router.test.ts`
 * supplies a recorder. A seam rather than a direct global for the same reason
 * `fetch` is one: `HTMLRewriter` exists only in workerd, and a router whose
 * decision table can only be exercised under a runtime is a router whose
 * decision table stops being exercised.
 */
export type HtmlHeadRewriter = (
  response: Response,
  edits: readonly HeadIdentityEdit[],
) => Response;

/**
 * Whether this origin response may be rewritten at all.
 *
 * Three refusals, and each one is an acceptance criterion rather than caution:
 *
 * - **Not 2xx.** A 404, a 5xx and the origin's own 3xx pass through exactly as
 *   they arrived. An error page is not this Edition's share block, and #599 as
 *   amended forbids the router touching a redirect.
 * - **No body.** A `HEAD` response and a `304` carry none; handing a null body
 *   to a transform is the shape that turns an origin failure into a Worker
 *   runtime error, which is precisely what this route may not do.
 * - **Not HTML.** The router proxies every asset on the host. Running an HTML
 *   parser over a JavaScript bundle or a PNG would be both pointless and the
 *   one way a body-rewriting path could corrupt a response.
 *
 * The media type is matched at a token boundary, so `text/html; charset=utf-8`
 * qualifies and a hypothetical `text/htmlx` does not.
 */
export function isHeadRewritable(response: Response): boolean {
  if (response.status < 200 || response.status > 299) return false;
  if (response.body === null) return false;
  return /^\s*text\/html\s*(?:;|$)/i.test(response.headers.get('content-type') ?? '');
}

/**
 * What to write into the `<head>` of a document served for `hostname` under
 * `edition`.
 *
 * `edition` is the committed projection's, taken from the SAME lookup that
 * decided the request may proceed. `brandFor` is total, so an unrecognised id
 * resolves to the default Edition rather than to `undefined` — the arm is
 * unreachable at the edge (`resolve.ts` refuses a projection whose `edition`
 * this build does not know, as `replica-malformed`, before any route sees it)
 * and is kept only because the shared builder serves a build-side consumer
 * whose input is not registry-validated.
 */
export function headEditsFor(
  edition: string | null,
  hostname: string,
): readonly HeadIdentityEdit[] {
  return headIdentityEdits(brandFor(edition), hostname);
}

/**
 * The workerd half: one `HTMLRewriter` pass, streaming.
 *
 * Streaming is the point. `HTMLRewriter.transform` returns immediately with a
 * `Response` whose body is produced as the origin's is consumed, so a large
 * document is never buffered in the Worker and time-to-first-byte is not
 * traded away for a branding fix.
 *
 * `setAttribute` writes the value into the attribute; lol-html escapes it for
 * that context, so the value handed in here is the plain brand string and NOT
 * the build path's pre-escaped one (`brandHtmlIdentity` escapes because it
 * does raw string substitution into markup, which has no serializer to do it).
 * Escaping twice would ship `&amp;amp;` to a crawler.
 *
 * A selector that matches nothing is a no-op rather than an error, which is
 * why `src/editions.test.ts` asserts every selector in the shared table
 * resolves against the real `index.html`: a silent no-op is the one failure
 * mode this file cannot report on its own.
 */
export function rewriteHeadWithHTMLRewriter(
  response: Response,
  edits: readonly HeadIdentityEdit[],
): Response {
  let rewriter = new HTMLRewriter();
  for (const edit of edits) {
    rewriter = rewriter.on(edit.selector, {
      element(element) {
        element.setAttribute(edit.attribute, edit.content);
      },
    });
  }
  return rewriter.transform(response);
}
