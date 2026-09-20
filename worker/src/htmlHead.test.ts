// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { headEditsFor, isHeadRewritable } from './htmlHead';
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
  it('accepts a 2xx HTML response with a body', () => {
    expect(isHeadRewritable(html())).toBe(true);
    expect(isHeadRewritable(html({ status: 203 }))).toBe(true);
  });

  it.each([301, 302, 304, 400, 404, 500, 502])('refuses status %i', (status) => {
    // An error page is not this Edition's share block, and #599 as amended
    // forbids the router touching a redirect at all.
    const body = status === 304 ? null : '<!doctype html>';
    expect(
      isHeadRewritable(
        new Response(body, { status, headers: { 'content-type': 'text/html' } }),
      ),
    ).toBe(false);
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
