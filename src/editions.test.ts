import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_EDITION,
  activeEdition,
  setActiveEdition,
  editionBrand,
  brandHtmlIdentity,
  buildTimeEdition,
  applyEditionDocumentIdentity,
  wordmarkSegments,
} from './editions';
import { themesForEdition, defaultThemeForEdition } from './theme/themes';

const EDITIONS = ['gcb', 'vacay'];

// Covers the pre-auth Edition brand (#543, ADR 0009 § Consequences). The whole
// point of this module is that the sign-in gate can be branded BEFORE there is
// an authenticated user to read the Event doc with, so these tests assert the
// resolution → brand path without any Firestore or React involved.

afterEach(() => setActiveEdition(DEFAULT_EDITION));

describe('editions — the pre-auth brand', () => {
  it('defaults to the legacy Edition, so the existing build is unchanged', () => {
    expect(activeEdition()).toBe('gcb');
    expect(editionBrand().wordmark).toBe('GAY CRUISE BINGO');
  });

  it('serves the Vacay brand once the resolver installs that Edition', () => {
    // The regression this pins: before #543 the wordmark and the July-2026
    // itinerary were hardcoded, so a Bodega guest opened the app to another
    // product's name and a cruise that is not happening (Codex on #576).
    setActiveEdition('vacay');
    expect(activeEdition()).toBe('vacay');
    const brand = editionBrand();
    expect(brand.wordmark).toBe('VACAY BINGO');
    expect(brand.tagline).not.toMatch(/Trieste|Barcelona|July 2026/);
    expect(brand.offlineNote).not.toMatch(/at sea/i);
  });

  it('falls back to the legacy Edition for an unknown or missing value', () => {
    // Degrading to the shipped experience beats an unbranded screen. `null` is
    // the real case: `Resolution.edition` is nullable on the env short-circuit.
    for (const value of ['no-such-edition', '', null, undefined]) {
      setActiveEdition(value);
      expect(activeEdition()).toBe(DEFAULT_EDITION);
      expect(editionBrand().wordmark).toBe('GAY CRUISE BINGO');
    }
  });

  it('gives every Edition every string, none of them empty', () => {
    // A half-filled Edition would render a blank <h1> on the one screen a new
    // player sees first — or, since #586, a blank browser tab and a nameless
    // installed app.
    for (const edition of EDITIONS) {
      const brand = editionBrand(edition);
      for (const [field, value] of Object.entries(brand)) {
        expect(value, `${edition}.${field}`).toBeTypeOf('string');
        expect(value.length, `${edition}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the cruise itinerary OUT of every non-cruise Edition', () => {
    for (const edition of ['vacay']) {
      const brand = editionBrand(edition);
      // Every field, not a hand-listed three: the leak #586 fixed was in the
      // chrome identity, which the original spelling of this guard did not
      // reach — a new field must be covered by default, not by remembering.
      const all = Object.values(editionBrand(edition)).join(' ');
      expect(all).not.toMatch(/cruise|sailing|at sea|aboard/i);
      expect(brand.documentTitle).not.toMatch(/cruise/i);
    }
  });
});

// #602: the app header renders the wordmark as `lead<b>bold</b>`. The split is
// DERIVED from `wordmark` + `wordmarkBold` so the gate's wordmark and the
// header's can never disagree on the words, only on the weight.
describe('editions — the header wordmark split (#602)', () => {
  it('splits each Edition wordmark before its bold suffix', () => {
    expect(wordmarkSegments(editionBrand('gcb'))).toEqual({ lead: 'GAY CRUISE ', bold: 'BINGO' });
    expect(wordmarkSegments(editionBrand('vacay'))).toEqual({ lead: 'VACAY ', bold: 'BINGO' });
  });

  it('follows the active Edition by default, like editionBrand()', () => {
    setActiveEdition('vacay');
    expect(wordmarkSegments()).toEqual({ lead: 'VACAY ', bold: 'BINGO' });
  });

  it('degrades to an unbolded wordmark when the bold segment is not a suffix', () => {
    // The failure mode of a mis-edited table row must be a missing font
    // weight, never missing or duplicated words in the product name.
    const misedited = { ...editionBrand('gcb'), wordmarkBold: 'CRUISE' };
    expect(wordmarkSegments(misedited)).toEqual({ lead: 'GAY CRUISE BINGO', bold: '' });
  });
});

// #586: the Edition has to reach the browser chrome, not just the page. Before
// this, bodega-bay.vacaybingo.com rendered VACAY BINGO inside a tab that said
// "Gay Cruise Bingo", and installed itself on a general-audience guest's phone
// as "Gay Bingo".
describe('editions — the chrome identity (#586)', () => {
  it('leaves the legacy Edition byte-identical to what the app shipped before', () => {
    // The regression guard that matters most here is the one for the Edition
    // NOBODY is changing: this refactor moved four hardcoded strings into a
    // table, and a typo in any of them silently retitles the live deployment.
    const brand = editionBrand('gcb');
    expect(brand.documentTitle).toBe('Gay Cruise Bingo');
    expect(brand.appName).toBe('Gay Cruise Bingo');
    expect(brand.appShortName).toBe('Gay Bingo');
    expect(brand.appDescription).toBe('Live multiplayer bingo for the high seas.');
  });

  it('keeps every short_name inside Android’s truncation budget', () => {
    // Android clips the home-screen label around 12 characters. Choosing which
    // word to drop is a branding decision (#359); letting the launcher choose
    // is not.
    for (const edition of EDITIONS) {
      expect(editionBrand(edition).appShortName.length, edition).toBeLessThanOrEqual(12);
    }
  });
});

describe('buildTimeEdition — only a single-Event build owns an Edition', () => {
  it('bakes VITE_EDITION for a single-Event build', () => {
    expect(buildTimeEdition('bodega-bay-2026', 'vacay')).toBe('vacay');
    expect(buildTimeEdition('med-2026', '')).toBe(DEFAULT_EDITION);
  });

  it('IGNORES VITE_EDITION when there is no VITE_EVENT_ID', () => {
    // The contract a hostname-resolved build lives by: the lookup owns the
    // Edition, and an Edition-less mapping resets to the default — which is
    // what `setActiveEdition('')` already does at runtime. Without this, a
    // stale `VITE_EDITION=vacay` in a multi-Event .env.local would bake Vacay
    // into a bundle every Event shares, and the manifest half of that is
    // unrepairable: it is fetched as a file at install time.
    for (const absent of ['', null, undefined]) {
      expect(buildTimeEdition(absent, 'vacay')).toBe(DEFAULT_EDITION);
    }
  });
});

describe('brandHtmlIdentity — baking the Edition into index.html', () => {
  const HTML = '<title>%EDITION_DOCUMENT_TITLE%</title><meta content="%EDITION_APP_NAME%" />';

  it('substitutes the title and the iOS home-screen label per Edition', () => {
    expect(brandHtmlIdentity(HTML, editionBrand('vacay'))).toBe(
      '<title>Vacay Bingo</title><meta content="Vacay Bingo" />',
    );
    expect(brandHtmlIdentity(HTML, editionBrand('gcb'))).toBe(
      '<title>Gay Cruise Bingo</title><meta content="Gay Cruise Bingo" />',
    );
  });

  it('THROWS on a placeholder it does not recognise', () => {
    // Fail closed. A survivor is not a crash — it renders as the literal text
    // `%EDITION_TAGLINE%` in the browser tab of a deploy nobody reopens.
    expect(() =>
      brandHtmlIdentity('<title>%EDITION_TAGLINE%</title>', editionBrand('gcb')),
    ).toThrow(/%EDITION_TAGLINE%/);
  });

  it('escapes brand copy for both the element text and the attribute', () => {
    // No shipped Edition needs this, which is exactly why the brand is passed
    // in rather than looked up: an Edition named with an `&` has to be a
    // rendering detail, not malformed markup or an attribute that ends early.
    const awkward = {
      ...editionBrand('gcb'),
      documentTitle: 'Bingo & <b>Brunch</b>',
      appName: 'Say "Bingo"',
    };
    expect(brandHtmlIdentity(HTML, awkward)).toBe(
      '<title>Bingo &amp; &lt;b&gt;Brunch&lt;/b&gt;</title><meta content="Say &quot;Bingo&quot;" />',
    );
  });

  it('resolves every placeholder in the REAL index.html, for every Edition', () => {
    // The one assertion that catches the actual failure mode: a placeholder
    // added to the markup with no row in the substitution table. Reading the
    // shipped file means the test fails when index.html drifts, not when
    // someone remembers to update a fixture.
    // `process.cwd()`, not `import.meta.url`: under the jsdom environment the
    // module URL is an http:// one and `readFileSync` rejects it. Vitest runs
    // from the repo root, where index.html lives.
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(indexHtml).toContain('%EDITION_DOCUMENT_TITLE%'); // the fixture is real
    for (const edition of EDITIONS) {
      const out = brandHtmlIdentity(indexHtml, editionBrand(edition));
      // The same shape the build's fail-closed scan uses, so this test asserts
      // exactly the property the build enforces — no more, no less.
      expect(out, edition).not.toMatch(/%EDITION_[A-Z_]+%/);
      expect(out, edition).toContain(`<title>${editionBrand(edition).documentTitle}</title>`);
      expect(out, edition).toContain(
        `<meta name="apple-mobile-web-app-title" content="${editionBrand(edition).appName}" />`,
      );
    }
  });
});

describe('applyEditionDocumentIdentity — the runtime half, for resolved builds', () => {
  const originalTitle = document.title;
  afterEach(() => {
    document.title = originalTitle;
    document.head.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove();
  });

  const appleMeta = () =>
    document.head.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content');

  it('retitles the tab and the iOS label from the active Edition', () => {
    // A hostname-resolved build cannot bake either tag — one bundle, many
    // Editions — so this is the only thing standing between a Vacay Event and a
    // tab labelled "Gay Cruise Bingo".
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'apple-mobile-web-app-title');
    meta.setAttribute('content', 'Gay Cruise Bingo');
    document.head.appendChild(meta);

    setActiveEdition('vacay');
    applyEditionDocumentIdentity();

    expect(document.title).toBe('Vacay Bingo');
    expect(appleMeta()).toBe('Vacay Bingo');
  });

  it('accepts an explicit Edition, and ignores an unknown one', () => {
    applyEditionDocumentIdentity('vacay');
    expect(document.title).toBe('Vacay Bingo');
    applyEditionDocumentIdentity('no-such-edition');
    expect(document.title).toBe('Gay Cruise Bingo');
  });

  it('does not invent the meta tag when index.html has none', () => {
    // Injecting one would hide the tag's removal instead of surfacing it; the
    // title still has to be set either way.
    applyEditionDocumentIdentity('vacay');
    expect(appleMeta()).toBeUndefined();
    expect(document.title).toBe('Vacay Bingo');
  });
});

// #580: Edition identity is ONE piece of state. Before this, editions.ts and
// theme/themes.ts each held their own `currentEdition`, so the resolver's
// single setActiveEdition call rebranded the sign-in shell while every Theme
// picker kept serving the build-time Edition (split-brain). This is the
// assertion from the issue: one call moves BOTH surfaces.
describe('editions × themes — one setActiveEdition call drives both (#580)', () => {
  it('changes the brand AND the theme pick list together', () => {
    setActiveEdition('vacay');
    expect(editionBrand().wordmark).toBe('VACAY BINGO');
    expect(themesForEdition().map((t) => t.id)).toEqual([
      'the-birds',
      'side-quests',
      'fog-froth-farewells',
    ]);
    expect(defaultThemeForEdition()).toBe('the-birds');

    setActiveEdition(DEFAULT_EDITION);
    expect(editionBrand().wordmark).toBe('GAY CRUISE BINGO');
    expect(themesForEdition().map((t) => t.id)).toContain('neon-playground');
    expect(defaultThemeForEdition()).toBe('neon-playground');
  });

  it('themes.ts re-exports ARE the editions.ts state, not a second copy', async () => {
    const themed = await import('./theme/themes');
    setActiveEdition('vacay');
    expect(themed.activeEdition()).toBe('vacay');
    themed.setActiveEdition(DEFAULT_EDITION);
    expect(activeEdition()).toBe(DEFAULT_EDITION);
  });
});
