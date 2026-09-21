// The per-hostname `<head>` rewrite (#1118, epic #529).
//
// The THIRD thing the Worker does to a response body, and the first that
// touches the origin's own bytes. `manifest.ts` (#546) and the path-capability
// projection in `router.ts` (#972) CONSTRUCT a document from a pure builder;
// this one mutates a streamed HTML response as it passes through, which is a
// different risk profile and the reason #1118 is a separate change from #546.
//
// What it corrects: the crawler-facing tags a hostname-resolved bundle bakes
// once per build and that a crawler can never see repaired, because a crawler
// runs no JavaScript — the `og:*` / `twitter:*` share block,
// `<meta name="description">` and `<meta name="theme-color">`. `editions.ts`
// `applyEditionDocumentIdentity` repairs `<title>` and the iOS home-screen
// label in the DOM after resolution; those two are deliberately not rewritten
// here (see `RUNTIME_REPAIRED_TOKENS` in `src/html-head-identity.ts`). It
// repairs `<meta name="theme-color">` as well, and that tag IS rewritten here,
// because the two writers reach different surfaces: only the edge reaches a
// crawler, and only the DOM repair reaches an installed shell whose service
// worker answers navigations from the precached `index.html`. Both read the
// colour from the same `themeColorFor`, so they cannot disagree.
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
 *   reassembles a corrupted one — a body transform's worst failure mode. A
 *   partial representation is relayed whole, `content-range` and all. Since
 *   {@link dropRangeRequest} takes the `Range` off every document candidate,
 *   the only `206` that can now reach this test is an asset's, which is also
 *   the only one whose bytes are the same for every hostname; the status test
 *   stays `=== 200` so that remains true by construction rather than by
 *   depending on the request-side rule.
 * - **No body.** A `HEAD` response and a `304` carry none; handing a null body
 *   to a transform is the shape that turns an origin failure into a Worker
 *   runtime error, which is precisely what this route may not do.
 * - **Not HTML.** The router proxies every asset on the host. Running an HTML
 *   parser over a JavaScript bundle or a PNG would be both pointless and the
 *   one way a body-rewriting path could corrupt a response.
 * - **Still encoded.** A `gzip` or `br` body is not markup. `HTMLRewriter`
 *   would parse the compressed bytes, match no selector, change nothing and
 *   report success — the silent no-op this module's whole shape exists to
 *   avoid — and dropping the `content-encoding` off a body that is still
 *   encoded would be worse than the no-op, because the client would then be
 *   handed compressed bytes labelled as text. {@link negotiateIdentityEncoding}
 *   is what stops a document arriving this way; this refusal is what makes the
 *   negotiation's failure a relay rather than a corruption.
 *
 * The media type is matched at a token boundary, so `text/html; charset=utf-8`
 * qualifies and a hypothetical `text/htmlx` does not.
 */
export function isHeadRewritable(response: Response): boolean {
  if (response.status !== 200) return false;
  if (response.body === null) return false;
  if (!isIdentityEncoded(response.headers)) return false;
  return /^\s*text\/html\s*(?:;|$)/i.test(response.headers.get('content-type') ?? '');
}

/** Whether these response headers describe bytes an HTML parser can read.
 *  An absent `content-encoding` and the explicit `identity` token both mean
 *  "not encoded"; anything else, known to this Worker or not, does not. */
function isIdentityEncoded(headers: Headers): boolean {
  const encoding = (headers.get('content-encoding') ?? '').trim().toLowerCase();
  return encoding === '' || encoding === 'identity';
}

/** The two media ranges a client uses to say it is asking for a document. */
const HTML_MEDIA_RANGES = ['text/html', 'application/xhtml+xml'];

/** Every media range a request offered, lowercased and stripped of its
 *  parameters, so `text/html; charset=utf-8` and `*\/*;q=0.8` compare as the
 *  ranges they are. */
function acceptedMediaRanges(headers: Headers): string[] {
  return (headers.get('accept') ?? '')
    .split(',')
    .map((range) => range.split(';')[0]!.trim().toLowerCase())
    .filter((range) => range !== '');
}

/** Whether the request named an HTML media range explicitly. */
function acceptNamesHtml(headers: Headers): boolean {
  return acceptedMediaRanges(headers).some((range) => HTML_MEDIA_RANGES.includes(range));
}

/**
 * Whether the request stated no preference at all: no `Accept`, or nothing in
 * it but `*\/*`.
 *
 * This is the shape a link-preview crawler sends. `facebookexternalhit`,
 * `Twitterbot`, `Slackbot`, `LinkedInBot`, `Discordbot` and the iMessage
 * fetcher ask for the document with `Accept: *\/*` or with no `Accept`
 * header — they are not browsers and have no content-negotiation opinion —
 * which is precisely the client class this whole rewrite exists for. A range
 * list carrying anything MORE specific does not qualify, so a request that
 * asked for `application/json` and would also take anything is still a
 * request that asked for JSON.
 */
function acceptStatesNoPreference(headers: Headers): boolean {
  return acceptedMediaRanges(headers).every((range) => range === '*/*');
}

/**
 * Whether this path is the shape an SPA document lives at rather than an
 * asset.
 *
 * A structural test, not a guess at the origin's routing: the bundle's assets
 * are hashed files with extensions (`/assets/app-3f2a.js`, `/pwa-192.png`,
 * `/manifest.webmanifest`), and every route the app serves as a document is
 * extensionless (`/`, `/board`, `/admin/prompts`) or ends in a slash or
 * `index.html`. Being wrong in the asset direction costs one asset its
 * compression on one hop; being wrong in the document direction costs that
 * document its Edition, which is the defect. It is only ever consulted for a
 * client that stated no preference, so a request that names its media type
 * never has its path second-guessed.
 */
export function isDocumentShapedPath(pathname: string): boolean {
  if (pathname.endsWith('/')) return true;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (lastSegment === 'index.html') return true;
  return !lastSegment.includes('.');
}

/**
 * Whether this REQUEST could be answered with a document the rewrite would
 * touch — the request-side approximation of {@link isHeadRewritable}, and the
 * ONE predicate behind both of the things a document subrequest must ask for
 * differently from an asset.
 *
 * It has to be an approximation, because both questions are asked before the
 * origin has answered.
 *
 * - **May this request carry a cache validator to the origin?** The origin
 *   serves one baked `index.html` to every hostname, so its `etag` and
 *   `last-modified` say nothing about which Edition the registry now resolves
 *   this hostname to; a forwarded `if-none-match` can come back as a `304`
 *   that is true of the origin and false of what this host should serve,
 *   leaving the router no body to rewrite and the client on the previous
 *   Edition Crawler identity.
 * - **May the origin compress its answer?** A `gzip` or `br` body reaches the
 *   transform as bytes no HTML parser can read, which is
 *   {@link negotiateIdentityEncoding}'s reason for existing.
 *
 * These were two predicates for one round of review, on the theory that the
 * costs are asymmetric: dropping a validator from a request that turns out to
 * be an asset costs that asset its cheap `304` on every revalidation, while
 * negotiating `identity` for one costs only compression on the origin hop. The
 * asymmetry was real and the conclusion was wrong. What protects an asset here
 * is the PATH test, not the narrowness of the `Accept` test — a no-preference
 * `Accept` only qualifies for a document-shaped path — so the narrow validator
 * rule bought assets nothing and cost a crawler the fix: it asked with
 * `Accept: *\/*`, kept its validators, was answered `304`, and
 * {@link isHeadRewritable} then refused the bodyless response, so the rewrite
 * never ran and the stale Edition metadata it already held survived. One
 * predicate, and both answers follow from it.
 *
 * What qualifies:
 *
 * - **`GET` or `HEAD`.** Both are safe and cacheable, so a validator on them
 *   is a cache revalidation. On any other method it is a PRECONDITION —
 *   optimistic concurrency rather than caching — and removing it would change
 *   what the origin is being asked to do, so those travel untouched. A `HEAD`
 *   carries no body to rewrite, but dropping its validators is what turns a
 *   crawler probe into a `200` it will follow with a `GET` rather than a `304`
 *   that lets it keep what it has.
 * - **An `Accept` naming an HTML media range**, at any path. That is a
 *   statement about the representation wanted, so the path is not consulted.
 * - **Or an `Accept` stating no preference at all** — absent, or nothing but
 *   `*\/*` — for a path shaped like a document. That is the link-preview
 *   crawler arm, and it is the point rather than a nicety:
 *   `facebookexternalhit`, `Twitterbot`, `Slackbot`, `LinkedInBot`,
 *   `Discordbot` and the iMessage fetcher all ask this way, so a rule keyed on
 *   an explicit HTML `Accept` would serve browsers and miss every client this
 *   rewrite exists for.
 *
 * What stays outside, with its validators and its negotiated encoding intact:
 * a request that names a non-HTML media type, and a path carrying a file
 * extension asked for with a wildcard — a script, a stylesheet, an image, a
 * font, a source map. Those are relayed rather than parsed, so an asset keeps
 * its cheap `304` and the bundle keeps its compression.
 */
export function isDocumentCandidate(request: Request, url: URL): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (acceptNamesHtml(request.headers)) return true;
  if (!acceptStatesNoPreference(request.headers)) return false;
  return isDocumentShapedPath(url.pathname);
}

/**
 * Take the cache validators off a request, so the origin must answer with a
 * body the rewrite can act on.
 *
 * Scoped to the two REVALIDATION headers. `if-range` is not a cache validator
 * — it qualifies a `Range` — so it is {@link dropRangeRequest}'s to remove,
 * and removing it here while leaving the `Range` behind would let that range
 * apply to a representation the client did not mean.
 */
export function dropConditionalValidators(headers: Headers): void {
  headers.delete('if-none-match');
  headers.delete('if-modified-since');
}

/**
 * Take the range request off a document subrequest, so the origin answers with
 * the whole representation.
 *
 * The rewrite refuses a `206` — a window described by byte offsets cannot have
 * a string of a different length substituted inside it — so a ranged document
 * used to be relayed exactly as the origin wrote it. Relaying it is safe on
 * its own and wrong in company: the SAME resource answers an ordinary `GET`
 * with the REWRITTEN representation, which is a different length, so a client
 * that resumes or assembles the document splices baked bytes into rewritten
 * ones, and a range covering the head hands back the Edition the bundle was
 * built with. Two representations of one URL, and the client picks the seam.
 *
 * Dropping the range rather than answering `416` or ranging over the
 * transformed body: a byte range over the SPA shell has no legitimate use —
 * it is one small `no-cache` document, not a media file — and a server may
 * always answer a ranged request with the full `200` it would otherwise have
 * sent, which is exactly the representation a document client must see.
 * Ranging over the transform instead would mean buffering the rewritten
 * document to know its length, giving up the streaming this module is built
 * around, for a client that does not exist.
 *
 * `if-range` goes with it, because a precondition on a range that is no longer
 * being asked for has nothing left to qualify.
 *
 * Applied only to a document candidate. Every other request keeps its `Range`
 * and its `206`, which is what the relay path continues to serve.
 */
export function dropRangeRequest(headers: Headers): void {
  headers.delete('range');
  headers.delete('if-range');
}

/**
 * Ask the origin for bytes an HTML parser can read.
 *
 * The runtime negotiates compression on a subrequest whether or not this file
 * asks it to — workerd replaces the header with its own `br, gzip` — so an
 * origin that honours it answers a document in `gzip` or `br`, and what
 * reaches `HTMLRewriter` is not markup. The parser matches no selector,
 * changes nothing and reports success, and the client receives the bundle's
 * baked Edition identity: the rewrite's one silent failure mode, and the whole
 * reason {@link isHeadRewritable} also refuses an encoded body.
 *
 * `identity` rather than deleting the header, and rather than decoding the
 * body here: deleting it leaves the runtime free to negotiate again, and a
 * decode arm can only ever cover the codecs the runtime happens to implement
 * (`DecompressionStream` has no `br`), so it would answer the case the origin
 * is least likely to pick. Asking for no encoding is the only form of the
 * request whose answer is a document in every codec. The cost is the
 * origin-to-edge hop of ONE small `no-cache` document; Cloudflare compresses
 * the rewritten response to the client on the way out, so nothing on the wire
 * a visitor pays for grows.
 *
 * Applied on {@link isDocumentCandidate}, the same predicate that decides the
 * validators, and for the same reason: only a request that could be answered
 * with a rewritable document. An asset keeps whatever the runtime negotiated
 * for it, because an asset is relayed rather than parsed and making the bundle
 * travel uncompressed would be a bandwidth bill with no defect behind it.
 */
export function negotiateIdentityEncoding(headers: Headers): void {
  headers.set('accept-encoding', 'identity');
}

/**
 * Take the encoding framing off a REWRITTEN response.
 *
 * Both values are about bytes that no longer exist. `content-encoding` can
 * only be `identity` here — {@link isHeadRewritable} refuses anything else —
 * and an explicit `identity` describing a body the transform rebuilt is a
 * claim worth nothing. `Vary: Accept-Encoding` is the origin's record of a
 * negotiation this hop did not perform: the edge asked for `identity`
 * unconditionally, so the entity the Worker returns is the same whatever the
 * client sent, and Cloudflare owns the encoding of the hop after this one.
 * Leaving it would let a shared cache key the rewritten document on a header
 * it no longer varies with — harmless on a `no-cache` document that now
 * carries no validator either, and still not a true header.
 *
 * Only the `accept-encoding` token is taken: a `Vary` naming anything else,
 * or the blanket `*`, still describes this response and is left exactly as the
 * origin wrote it.
 */
export function dropOriginEncoding(headers: Headers): void {
  headers.delete('content-encoding');
  const vary = headers.get('vary');
  if (vary === null) return;
  const remaining = vary
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '' && field.toLowerCase() !== 'accept-encoding');
  if (remaining.length === 0) headers.delete('vary');
  else headers.set('vary', remaining.join(', '));
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
