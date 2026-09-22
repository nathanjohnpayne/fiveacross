// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  dropConditionalValidators,
  dropOriginEncoding,
  dropOriginValidators,
  dropRangeRequest,
  headEditsFor,
  isDocumentCandidate,
  isDocumentShapedPath,
  isHeadRewritable,
  negotiateIdentityEncoding,
} from './htmlHead';
import { EDITION_IDS } from '../../src/edition-registry';
// `edition-brands`, NOT `editions`: this program has no DOM lib and no
// `vite/client`, the same reason #546 split the brand table out.
import { brandFor } from '../../src/edition-brands';
import { HEAD_IDENTITY_TAGS } from '../../src/html-head-identity';
import { webManifestForEdition } from '../../src/web-manifest';

// The DECISION half only — which responses may be rewritten, and which tag
// gets which value. `src/html-head-identity.test.ts` owns the shared table
// itself, `router.test.ts` owns WHERE in the pipeline this sits, and
// `routerHtmlHead.integration.test.ts` owns the streaming transform,
// which needs a workerd runtime this program does not have.

const html = (init: ResponseInit = {}) =>
  new Response('<!doctype html><head></head>', {
    status: 200,
    ...init,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) },
  });

describe('which origin responses may be rewritten', () => {
  it('accepts a 200 HTML response with a body', () => {
    expect(isHeadRewritable(html())).toBe(true);
  });

  it.each([201, 203, 206, 301, 302, 304, 400, 404, 500, 502])('refuses status %i', (status) => {
    // An error page is not this Edition's share block, #599 as amended forbids
    // the router touching a redirect at all, and the 2xx siblings are refused
    // for the reason 206 is: only the full representation this origin serves
    // for a plain GET is a document whose bytes may be substituted.
    const body = status === 304 ? null : '<!doctype html>';
    expect(
      isHeadRewritable(
        new Response(body, { status, headers: { 'content-type': 'text/html' } }),
      ),
    ).toBe(false);
  });

  it('refuses a 206, whose content-range describes offsets a substitution invalidates', () => {
    // The whole reason the status check is `=== 200` rather than the 2xx
    // class. A rewritten window would still be framed by the origin's
    // `content-range`, so a client assembling or resuming the document would
    // reassemble a corrupted one.
    const partial = new Response('<!doctype html><head></head>', {
      status: 206,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-range': 'bytes 0-27/4096',
      },
    });
    expect(isHeadRewritable(partial)).toBe(false);
    expect(partial.headers.get('content-range')).toBe('bytes 0-27/4096');
  });

  it('refuses a response with no body, which a HEAD and a 304 both are', () => {
    expect(
      isHeadRewritable(new Response(null, { status: 200, headers: { 'content-type': 'text/html' } })),
    ).toBe(false);
  });

  it.each([
    'application/javascript',
    'application/json',
    'image/png',
    'text/plain; charset=utf-8',
    'application/manifest+json',
    '',
  ])('refuses content-type %s', (contentType) => {
    expect(isHeadRewritable(new Response('x', { status: 200, headers: contentType ? { 'content-type': contentType } : {} }))).toBe(
      false,
    );
  });

  it.each(['gzip', 'br', 'deflate', 'GZIP', ' gzip '])(
    'refuses a body still encoded as %s, which is not markup',
    (encoding) => {
      // `HTMLRewriter` would parse the compressed bytes, match nothing,
      // change nothing and report success — and dropping the header off a
      // body that is still encoded would hand the client compressed bytes
      // labelled as text. The negotiation is what stops this arriving; the
      // refusal is what makes the negotiation failing a relay.
      expect(isHeadRewritable(html({ headers: { 'content-encoding': encoding } }))).toBe(false);
    },
  );

  it.each(['identity', 'IDENTITY'])('accepts an explicit %s encoding', (encoding) => {
    expect(isHeadRewritable(html({ headers: { 'content-encoding': encoding } }))).toBe(true);
  });

  it('matches the media type at a token boundary, not as a prefix', () => {
    // A prefix match would hand an HTML parser a `text/htmlx` body, and the
    // one way a body-rewriting path corrupts a response is by parsing
    // something that is not the thing it parses.
    expect(isHeadRewritable(html({ headers: { 'content-type': 'text/htmlx' } }))).toBe(false);
    expect(isHeadRewritable(html({ headers: { 'content-type': 'TEXT/HTML' } }))).toBe(true);
    expect(isHeadRewritable(html({ headers: { 'content-type': 'text/html' } }))).toBe(true);
  });
});

describe('what the edge writes for a resolved hostname', () => {
  it.each([EDITION_IDS.GAY_CRUISE_BINGO, EDITION_IDS.VACAY_BINGO, EDITION_IDS.FIVE_ACROSS])(
    'brands every crawler-facing tag from %s’s row',
    (edition) => {
      const brand = brandFor(edition);
      const edits = headEditsFor(edition, 'bodega-bay.fiveacross.app');
      // One edit per row of the shared table, in its order, and nothing else:
      // a tag the build brands and the edge forgets is the whole defect.
      expect(edits.map((edit) => edit.selector)).toEqual(
        HEAD_IDENTITY_TAGS.map((tag) => tag.selector),
      );
      expect(edits.every((edit) => edit.attribute === 'content')).toBe(true);
      expect(new Map(edits.map((edit) => [edit.selector, edit.content]))).toEqual(
        new Map([
          ['meta[name="description"]', brand.metaDescription],
          ['meta[property="og:site_name"]', brand.documentTitle],
          ['meta[property="og:title"]', brand.documentTitle],
          ['meta[property="og:url"]', 'https://bodega-bay.fiveacross.app/'],
          ['meta[property="og:image"]', brand.ogImage],
          ['meta[property="og:image:alt"]', brand.ogImageAlt],
          ['meta[name="twitter:image"]', brand.ogImage],
          ['meta[name="theme-color"]', webManifestForEdition(edition).theme_color],
        ]),
      );
    },
  );

  it.each([null, '', 'not-an-edition'])(
    'falls back to the default Edition for %s, exactly as the manifest builder does',
    (edition) => {
      // Unreachable at the edge — `resolve.ts` refuses a projection whose
      // Edition this build does not know, as `replica-malformed`, before any
      // route sees it — but the arm must agree with the manifest's or the same
      // host would unfurl as one product and install as another.
      expect(headEditsFor(edition, 'x.fiveacross.app')).toEqual(
        headEditsFor(EDITION_IDS.GAY_CRUISE_BINGO, 'x.fiveacross.app'),
      );
    },
  );

  it('takes og:url from the hostname rather than from the brand row', () => {
    const ogUrl = (host: string) =>
      headEditsFor(EDITION_IDS.VACAY_BINGO, host).find(
        (edit) => edit.selector === 'meta[property="og:url"]',
      )?.content;
    expect(ogUrl('bodega-bay.vacaybingo.com')).toBe('https://bodega-bay.vacaybingo.com/');
    expect(ogUrl('bodega-bay.fiveacross.app')).toBe('https://bodega-bay.fiveacross.app/');
    // Two registered hosts for one Event, two og:urls — which is the point:
    // the brand row can only carry one, and it carries the first.
    expect(ogUrl('bodega-bay.vacaybingo.com')).not.toBe(brandFor(EDITION_IDS.VACAY_BINGO).ogUrl);
  });

  it('always emits an https origin with a trailing slash, whatever the host', () => {
    for (const host of ['fiveacross.app', 'r2-aaa.vacaybingo.com', 'bodega-bay.fiveacross.app']) {
      const url = new URL(
        headEditsFor(EDITION_IDS.FIVE_ACROSS, host).find(
          (edit) => edit.selector === 'meta[property="og:url"]',
        )!.content,
      );
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe(host);
      expect(url.port).toBe('');
      expect(url.pathname).toBe('/');
    }
  });
});

describe('what a document subrequest and its rewritten answer must not carry', () => {
  it('removes both revalidation validators and nothing else', () => {
    const headers = new Headers({
      'if-none-match': '"origin-index"',
      'if-modified-since': 'Wed, 01 Jul 2026 00:00:00 GMT',
      'if-range': '"origin-index"',
      accept: 'text/html',
    });
    dropConditionalValidators(headers);
    expect(headers.get('if-none-match')).toBeNull();
    expect(headers.get('if-modified-since')).toBeNull();
    // `if-range` is not a revalidation header — it qualifies a `Range` — so it
    // is `dropRangeRequest`'s to remove, and taking it here while leaving the
    // range behind would let that range apply to a representation the client
    // did not mean.
    expect(headers.get('if-range')).toBe('"origin-index"');
    expect(headers.get('accept')).toBe('text/html');
  });

  it('takes the range request off a document subrequest, and only that', () => {
    // A ranged document would come back `206`: bytes and byte offsets from the
    // baked representation, while an ordinary GET of the same URL is answered
    // with the rewritten one, which is a different length. Dropping the range
    // is what stops a client splicing the two.
    const headers = new Headers({
      range: 'bytes=0-99',
      'if-range': '"origin-index"',
      accept: 'text/html',
      'if-none-match': '"origin-index"',
    });
    dropRangeRequest(headers);
    expect(headers.get('range')).toBeNull();
    expect(headers.get('if-range')).toBeNull();
    expect(headers.get('accept')).toBe('text/html');
    // The revalidation headers are the sibling function's business.
    expect(headers.get('if-none-match')).toBe('"origin-index"');
  });

  it('asks the origin for identity, whatever the runtime negotiated', () => {
    // The runtime replaces this header with its own `br, gzip` on a
    // subrequest, so the value being overwritten is the runtime's rather than
    // the guest's — and either way an encoded document is not markup.
    const headers = new Headers({ 'accept-encoding': 'br, gzip', accept: 'text/html' });
    negotiateIdentityEncoding(headers);
    expect(headers.get('accept-encoding')).toBe('identity');
    expect(headers.get('accept')).toBe('text/html');
  });

  it('takes the encoding framing off a rewritten response', () => {
    const headers = new Headers({
      'content-encoding': 'identity',
      vary: 'Accept-Encoding',
      'content-type': 'text/html; charset=utf-8',
    });
    dropOriginEncoding(headers);
    expect(headers.get('content-encoding')).toBeNull();
    // Nothing left of a negotiation this hop did not perform.
    expect(headers.get('vary')).toBeNull();
    expect(headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it.each([
    ['Accept-Encoding, Origin', 'Origin'],
    ['origin, accept-encoding', 'origin'],
    ['Origin, Accept-Encoding, Cookie', 'Origin, Cookie'],
    ['Origin', 'Origin'],
    ['*', '*'],
  ])('narrows a Vary of %s to %s', (vary, expected) => {
    // Only the one field this hop stopped varying on is taken. A `Vary`
    // naming anything else, or the blanket `*`, still describes the response
    // and is the origin's to state.
    const headers = new Headers({ vary });
    dropOriginEncoding(headers);
    expect(headers.get('vary')).toBe(expected);
  });

  it('leaves a response with no Vary without one', () => {
    const headers = new Headers({ 'content-type': 'text/html' });
    dropOriginEncoding(headers);
    expect(headers.get('vary')).toBeNull();
  });

  it('removes the origin validators from a rewritten response and emits none in their place', () => {
    const headers = new Headers({
      etag: '"origin-index"',
      'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT',
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    });
    dropOriginValidators(headers);
    expect(headers.get('etag')).toBeNull();
    expect(headers.get('last-modified')).toBeNull();
    expect([...headers.keys()].sort()).toEqual(['cache-control', 'content-type']);
  });
});

describe('which requests are document candidates, for the validators and the encoding alike', () => {
  // ONE predicate decides both (#1118, round five). It was two for a round, on
  // the theory that dropping a validator from a request that turns out to be
  // an asset costs that asset its cheap 304 while negotiating identity for one
  // costs only compression. What actually protects an asset here is the PATH
  // test, not the narrowness of the Accept test, so the narrow validator rule
  // bought assets nothing and cost a crawler the fix: it asked with a
  // wildcard, kept its validators, was answered 304, and isHeadRewritable then
  // refused the bodyless response.
  const asked = (
    path: string,
    headers: Record<string, string> = {},
    method = 'GET',
  ): boolean => {
    const url = new URL(`https://bodega-bay.fiveacross.app${path}`);
    return isDocumentCandidate(new Request(url, { method, headers }), url);
  };

  it.each([
    'text/html',
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'application/xhtml+xml',
    'TEXT/HTML; charset=utf-8',
  ])('takes a browser navigation accepting %s, whatever its path', (accept) => {
    expect(asked('/board', { accept })).toBe(true);
    // An explicit HTML Accept is a statement about the representation, so the
    // path is never consulted for it — and the media range is matched at a
    // token boundary, case-insensitively, parameters and all.
    expect(asked('/weird.name', { accept })).toBe(true);
  });

  it.each([
    ['*/*', '/'],
    ['*/*', '/board'],
    ['*/*', '/board/'],
    ['*/*', '/index.html'],
    ['*/*', '/admin/prompts'],
    ['*/*;q=0.8', '/'],
    ['', '/'],
  ])('takes a no-preference Accept of %s at the document-shaped %s', (accept, path) => {
    // The link-preview crawlers this rewrite exists for — facebookexternalhit,
    // Twitterbot, Slackbot, LinkedInBot, Discordbot, the iMessage fetcher —
    // name no media type at all. A rule keyed on an explicit HTML Accept would
    // negotiate identity for browsers and leave every one of them reading
    // compressed bytes, which is the whole defect for the one client class the
    // rewrite is for.
    expect(asked(path, accept === '' ? {} : { accept })).toBe(true);
  });

  it.each([
    '/assets/app-3f2a.js',
    '/pwa-192.png',
    '/manifest.webmanifest',
    '/assets/app.css',
    '/assets/app.css.map',
    '/fonts/inter.woff2',
    '/data.json',
  ])('leaves %s alone for a no-preference Accept, so no asset loses compression', (path) => {
    expect(asked(path, { accept: '*/*' })).toBe(false);
  });

  it.each([
    ['text/html;q=0.1', 'a grudging but positive quality'],
    ['text/html;q=1.0', 'the explicit maximum'],
    ['text/*;q=0.5', 'the subtype wildcard, when the exact type is unnamed'],
    ['text/html;q=0.001', 'a quality small enough to look like zero and is not'],
    ['text/html;q=', 'a blank quality, which is malformed and so reads as absent, not as zero'],
    ['text/html; charset=utf-8', 'a parameter that is not q at all'],
    ['application/json, text/html', 'HTML named second, with no q'],
    ['text/html;q=0.8;level=1', 'an accept-extension after the q'],
    ['text/html;Q=0.9', 'an uppercase parameter name'],
    ['text/html;q=bogus', 'a malformed q, read as absent rather than as a rejection'],
  ])('takes %s — %s', (accept) => {
    expect(asked('/board', { accept })).toBe(true);
  });

  it.each([
    ['application/json, text/html;q=0', 'the defect: HTML named and refused in one header'],
    ['text/html;q=0', 'refused on its own'],
    ['text/html;q=0.0', 'refused, written long'],
    ['text/html;q=0, text/*;q=1', 'the specific refusal outranks the subtype wildcard'],
    ['text/*;q=0', 'the whole text type refused'],
    ['application/xhtml+xml;q=0', 'the other HTML range refused'],
  ])('refuses %s — %s', (accept) => {
    // Naming a media range is not the same as wanting it. A parser that
    // dropped the parameters read `application/json, text/html;q=0` as a
    // request FOR html, and then took that client's validators, its Range and
    // its compression away — turning a 304 or a 206 it was entitled to into a
    // full uncompressed 200.
    expect(asked('/board', { accept })).toBe(false);
  });

  it('reads a q=0 wildcard as a preference rather than as no preference', () => {
    // A client that refuses every media type has stated a preference, and it
    // is not for a document — so it does not reach the no-preference arm even
    // at a document-shaped path.
    expect(asked('/', { accept: '*/*;q=0' })).toBe(false);
    expect(asked('/', { accept: '*/*;q=0.1' })).toBe(true);
  });

  it('lets a later duplicate of the same range win, deterministically', () => {
    // A repeated range is malformed and no rule says which wins; answering
    // the same way every time is the property worth having.
    expect(asked('/board', { accept: 'text/html;q=1, text/html;q=0' })).toBe(false);
    expect(asked('/board', { accept: 'text/html;q=0, text/html;q=1' })).toBe(true);
  });

  it.each([
    'application/json',
    'image/png',
    'application/javascript',
    'image/png,image/svg+xml',
    'text/htmlx',
    'text/css,*/*;q=0.1',
  ])(
    'leaves a document-shaped path asked for as %s alone',
    (accept) => {
      // A client that named a media type, and named one that is not HTML. Its
      // path is never second-guessed: the shape test exists only to read a
      // client that stated no preference.
      expect(asked('/board', { accept })).toBe(false);
    },
  );

  it('takes a HEAD as well as a GET, and no other method', () => {
    // Both are safe and cacheable, so a validator on them is a cache
    // revalidation. A HEAD carries no body to rewrite, but dropping its
    // validators turns a crawler probe into a 200 it will follow with a GET
    // rather than a 304 that lets it keep what it has.
    expect(asked('/', { accept: '*/*' }, 'HEAD')).toBe(true);
    expect(asked('/board', { accept: 'text/html' }, 'HEAD')).toBe(true);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      // On an unsafe method a validator is a PRECONDITION rather than a cache
      // revalidation, so removing it would change what the origin is asked to
      // do.
      expect(asked('/', { accept: 'text/html' }, method), method).toBe(false);
    }
  });

  it.each([
    ['/', true],
    ['/board', true],
    ['/board/', true],
    ['/index.html', true],
    ['/admin/prompts', true],
    ['/v1.2/board', true],
    ['/nested/path/index.html', true],
    ['/assets/app-3f2a.js', false],
    ['/manifest.webmanifest', false],
    ['/apple-touch-icon.png', false],
  ])('reads %s as document-shaped: %s', (pathname, expected) => {
    // Structural rather than a guess at the origin's routing: every asset the
    // bundle emits is a file with an extension, and every route the app serves
    // as a document is extensionless or ends in a slash or index.html.
    expect(isDocumentShapedPath(pathname)).toBe(expected);
  });
});
