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
 * - **Not exactly 200.** A 404, a 5xx and the origin's own 3xx pass through
 *   exactly as they arrived. An error page is not this Edition's share block,
 *   and #599 as amended forbids the router touching a redirect. The check is
 *   `=== 200` rather than the 2xx class because of ONE member of that class:
 *   a `206 Partial Content` is a window into a representation, described by
 *   byte offsets in its own `content-range`. Substituting a string of a
 *   different length inside that window leaves the offsets describing bytes
 *   that are no longer there, so a client assembling or resuming the document
 *   reassembles a corrupted one — a body transform's worst failure mode,
 *   reached by a header this router never has to honour itself. A partial
 *   representation is relayed whole, `content-range` and all.
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
  if (response.status !== 200) return false;
  if (response.body === null) return false;
  return /^\s*text\/html\s*(?:;|$)/i.test(response.headers.get('content-type') ?? '');
}

/** The two media ranges a client uses to say it is asking for a document. */
const HTML_MEDIA_RANGES = ['text/html', 'application/xhtml+xml'];

/**
 * Whether this REQUEST could be answered with a document the rewrite would
 * touch — the request-side approximation of {@link isHeadRewritable}.
 *
 * It has to be an approximation, because the one question that matters here is
 * asked before the origin has answered: may this request carry a cache
 * validator to the origin? The origin serves one baked `index.html` to every
 * hostname, so its `etag` and `last-modified` say nothing about which Edition
 * the registry now resolves this hostname to; a forwarded `if-none-match` can
 * therefore come back as a `304` that is true of the origin and false of what
 * this host should serve, leaving the router no body to rewrite and the client
 * on the previous Edition's Crawler identity.
 *
 * Conservative in the safe direction, deliberately. Only a `GET` qualifies —
 * a validator on any other method is a PRECONDITION rather than a cache
 * revalidation, and dropping it would change what the origin is being asked to
 * do — and only an `Accept` that names an HTML media range explicitly. A
 * request that does not say it accepts HTML keeps its validators and can still
 * be answered `304`, which is what every asset revalidation on the host is; a
 * bare wildcard range deliberately does not qualify, because that is what a
 * browser sends for a script. The residue — a crawler that both caches HTML
 * and asks with a wildcard — degrades to today's behaviour rather than to a
 * corrupt response, and closes for good the first time that client receives a
 * rewritten document, because {@link dropOriginValidators} leaves it nothing
 * to revalidate with.
 */
export function isHtmlDocumentRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;
  return (request.headers.get('accept') ?? '')
    .split(',')
    .some((range) => HTML_MEDIA_RANGES.includes(range.split(';')[0]!.trim().toLowerCase()));
}

/**
 * Take the cache validators off a request, so the origin must answer with a
 * body the rewrite can act on.
 *
 * `if-range` is deliberately NOT removed: it is meaningful only alongside
 * `Range`, whose answer is relayed rather than rewritten, and removing it would
 * let a `Range` apply to a representation the client did not mean.
 */
export function dropConditionalValidators(headers: Headers): void {
  headers.delete('if-none-match');
  headers.delete('if-modified-since');
}

/**
 * Take the origin's validators off a REWRITTEN response, and emit none in
 * their place.
 *
 * The origin's pair describes the pre-rewrite bytes — one `etag` for a document
 * that now differs per hostname — so relaying it re-opens the same stale-
 * identity window one cache generation later. Removing it converges instead: a
 * client can only ever hold an origin validator for a copy it obtained WITHOUT
 * the rewrite, so the window closes after one unconditional fetch rather than
 * recurring on the next repoint.
 *
 * The rejected alternative was a derived validator carrying the hostname and
 * the served record's revision. It is only worth its bytes if the edge also
 * ANSWERS `304` for it, which means translating the client's token back into
 * the origin's on the way out and reconstituting the `304` on the way in — a
 * validator codec with its own malformed-token arm, and materially more
 * machinery than the defect asks for. `specs/event-router.md` § Contract
 * records the choice.
 */
export function dropOriginValidators(headers: Headers): void {
  headers.delete('etag');
  headers.delete('last-modified');
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
