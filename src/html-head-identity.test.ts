import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITION_IDS } from './edition-registry';
import { editionBrand } from './editions';
import {
  assertHeadIdentityCoverage,
  HEAD_IDENTITY_TAGS,
  headIdentityEdits,
  HTML_IDENTITY_TOKENS,
  requestOriginUrl,
  RUNTIME_REPAIRED_TOKENS,
} from './html-head-identity';
import { webManifestForEdition } from './web-manifest';

const EDITIONS = Object.values(EDITION_IDS);

// The shared table itself: that the build's placeholders and the edge's
// selectors describe the SAME tags in the real `index.html`, and that every
// token has somewhere to be corrected for a hostname-resolved bundle.
// `src/editions.test.ts` owns the build-time substitution, `worker/src/
// htmlHead.test.ts` the edge's edit list, and
// `worker/src/registry/routerHtmlHead.integration.test.ts` the transform.

const indexHtml = () => readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/** The attribute a selector like `meta[property="og:title"]` matches on. */
function selectorAttribute(selector: string): { name: string; value: string } {
  const match = /^meta\[([a-z-]+)="([^"]+)"\]$/.exec(selector);
  if (!match) throw new Error(`unparsed selector: ${selector}`);
  return { name: match[1]!, value: match[2]! };
}

describe('the index.html head-identity table', () => {
  it('points every edge selector at a tag that actually exists in index.html', () => {
    // A CSS selector that matches nothing is a silent no-op: the rewrite runs,
    // reports success and changes nothing. Reading the shipped file means this
    // fails when the markup drifts rather than when someone remembers to
    // update a fixture.
    const html = indexHtml();
    for (const tag of HEAD_IDENTITY_TAGS) {
      const { name, value } = selectorAttribute(tag.selector);
      expect(html, tag.selector).toContain(`<meta ${name}="${value}" ${tag.attribute}=`);
    }
  });

  it('gives every edge row the placeholder that tag carries in index.html', () => {
    // The agreement the whole module exists for: the build substitutes
    // `tag.token` into exactly the tag `tag.selector` matches, so a build and
    // an edge can never brand different tags.
    const html = indexHtml();
    for (const tag of HEAD_IDENTITY_TAGS) {
      const { name, value } = selectorAttribute(tag.selector);
      expect(html, tag.selector).toContain(
        `<meta ${name}="${value}" ${tag.attribute}="${tag.token}"`,
      );
    }
  });

  it('corrects every token somewhere, for a hostname-resolved bundle', () => {
    const covered = [...HEAD_IDENTITY_TAGS.map((tag) => tag.token), ...RUNTIME_REPAIRED_TOKENS];
    expect([...new Set(covered)].sort()).toEqual(Object.keys(HTML_IDENTITY_TOKENS).sort());
    expect(() => assertHeadIdentityCoverage()).not.toThrow();
  });

  it('leaves the two runtime-repaired tags to the DOM repair, and nothing else', () => {
    // `applyEditionDocumentIdentity` rewrites the document title and the iOS
    // home-screen label after resolution and stops. Anything else baked into
    // the markup has no runtime repair at all, which is why it has to be an
    // edge row.
    expect([...RUNTIME_REPAIRED_TOKENS]).toEqual(['%EDITION_DOCUMENT_TITLE%', '%EDITION_APP_NAME%']);
    expect(HEAD_IDENTITY_TAGS.map((tag) => tag.token)).not.toContain('%EDITION_DOCUMENT_TITLE%');
    expect(HEAD_IDENTITY_TAGS.map((tag) => tag.token)).not.toContain('%EDITION_APP_NAME%');
  });
});

describe('the edits the edge writes', () => {
  it.each(EDITIONS)('keeps %s’s theme-color equal to its manifest theme_color', (edition) => {
    // `specs/w1-pwa.md` requires the two to match EXACTLY. Now that the colour
    // is Edition-scoped, "exactly" has to be checked per Edition rather than
    // read off one shared constant.
    const themeColor = headIdentityEdits(editionBrand(edition), 'x.fiveacross.app').find(
      (edit) => edit.selector === 'meta[name="theme-color"]',
    )?.content;
    expect(themeColor, edition).toBe(webManifestForEdition(edition).theme_color);
    expect(themeColor, edition).toBe(webManifestForEdition(edition).background_color);
  });

  it('gives each Edition its own chrome colour, so the match is not vacuous', () => {
    const colours = EDITIONS.map((edition) => editionBrand(edition).chromeColor);
    expect(new Set(colours).size).toBe(EDITIONS.length);
    // The default Edition's value is unchanged from the Edition-invariant one
    // every manifest carried before #1118, so no installed gcb app's chrome or
    // splash moves.
    expect(editionBrand(EDITION_IDS.GAY_CRUISE_BINGO).chromeColor).toBe('#07060d');
    for (const colour of colours) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('hands the edge the plain brand string, unescaped', () => {
    // The build path escapes because it substitutes raw text into markup; the
    // edge path does not, because `HTMLRewriter.setAttribute` serializes the
    // value for the attribute context itself. Escaping twice would ship
    // `&amp;amp;` to a crawler.
    const awkward = { ...editionBrand('gcb'), ogImageAlt: 'Bingo & <b>Brunch</b>' };
    expect(
      headIdentityEdits(awkward, 'x.fiveacross.app').find(
        (edit) => edit.selector === 'meta[property="og:image:alt"]',
      )?.content,
    ).toBe('Bingo & <b>Brunch</b>');
  });

  it('builds og:url from the hostname alone', () => {
    expect(requestOriginUrl('bodega-bay.vacaybingo.com')).toBe('https://bodega-bay.vacaybingo.com/');
    expect(requestOriginUrl('fiveacross.app')).toBe('https://fiveacross.app/');
  });
});
