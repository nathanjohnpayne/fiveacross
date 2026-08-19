import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
  alternateNamespaceApex,
} from './editions';
import { themesForEdition, defaultThemeForEdition } from './theme/themes';

const EDITIONS = ['gcb', 'vacay', 'fiveacross'];

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
      const { lexicon, ...text } = editionBrand(edition);
      for (const [field, value] of Object.entries(text)) {
        expect(value, `${edition}.${field}`).toBeTypeOf('string');
        expect(value.length, `${edition}.${field}`).toBeGreaterThan(0);
      }
      // …and the lexicon it now carries (#608). Destructured out above rather
      // than skipped by name: a future non-string field on EditionBrand would
      // fail the destructure's exhaustiveness at the type level, not silently
      // slip past a `typeof value === 'string'` filter here.
      for (const [field, value] of Object.entries(lexicon)) {
        expect(value, `${edition}.lexicon.${field}`).toBeTypeOf('string');
        expect(value.length, `${edition}.lexicon.${field}`).toBeGreaterThan(0);
      }
    }
  });

  // #688: the endorsement byline is the platform's signature on an Edition, so
  // its presence is a per-Edition FACT worth pinning in the table itself, not
  // just in the two components that render it. The rule is "Editions of the
  // platform carry it; the platform does not endorse itself" — asserted here
  // as an exhaustive partition over EDITIONS so adding a fourth Edition
  // without deciding its side of that line fails.
  it('signs every Edition OF the platform, and only those, with the endorsement byline', () => {
    const endorsed = EDITIONS.filter((e) => editionBrand(e).wordmarkByline !== undefined);
    expect(endorsed).toEqual(['gcb', 'vacay']);
    for (const edition of endorsed) {
      expect(editionBrand(edition).wordmarkByline).toBe('BY FIVE ACROSS');
    }
    // Five Across IS the platform; an endorsement of itself would be noise.
    expect(editionBrand('fiveacross').wordmarkByline).toBeUndefined();
  });

  // The byline is an endorsement, not a rename (#688). On an ENDORSED Edition,
  // every place the product NAME is the payload — the tab title, the installed
  // app's name and short name, the h1 the production synthetic waits on — must
  // be untouched by it. (`fiveacross` is excluded because there the platform's
  // name IS the product name, which is the whole reason it carries no byline.)
  it('keeps the endorsement out of the product name on every endorsed Edition', () => {
    for (const edition of ['gcb', 'vacay']) {
      const brand = editionBrand(edition);
      for (const field of ['wordmark', 'documentTitle', 'appName', 'appShortName'] as const) {
        expect(brand[field], `${edition}.${field}`).not.toMatch(/five across/i);
      }
    }
    expect(editionBrand('gcb').wordmark).toBe('GAY CRUISE BINGO');
  });

  it('keeps the cruise itinerary OUT of every non-cruise Edition', () => {
    for (const edition of ['vacay', 'fiveacross']) {
      const brand = editionBrand(edition);
      // Every field, not a hand-listed three: the leak #586 fixed was in the
      // chrome identity, which the original spelling of this guard did not
      // reach — a new field must be covered by default, not by remembering.
      const { lexicon, ...text } = editionBrand(edition);
      const all = [...Object.values(text), ...Object.values(lexicon)].join(' ');
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
    // #587's share fields, same rule: the flagship unfurl's WORDING is exactly
    // what index.html hardcoded before the block was tokenised. (The artwork
    // moved to the #609 render, og-gcb.png — that change is deliberate.)
    expect(brand.metaDescription).toBe(
      'Live multiplayer bingo for the high seas. Trieste to Barcelona, July 2026.',
    );
    expect(brand.ogUrl).toBe('https://gaycruisebingo.com/');
    expect(brand.ogImage).toBe('https://gaycruisebingo.web.app/og-gcb.png');
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

// #587: crawlers do not run JS, so the share block has no runtime repair path —
// these fields ARE the unfurl. Before this, a Bodega guest who shared
// bodega-bay.vacaybingo.com into a group chat sent a link that previewed as a
// gay cruise, to people who are not guests and have attested nothing.
describe('editions — the share block (#587, artwork #609)', () => {
  it('points every Edition og:image at a web.app host, at a file that ships in public/', () => {
    // Two constraints with a history behind them: custom-domain apexes
    // TLS-reset for link crawlers (#340) / get SNI-blocked (#164), so the URL
    // must be on an always-healthy web.app host; and the referenced file must
    // actually be in the bundle, or every unfurl on that Edition is an empty
    // grey rectangle — a defect only ever discovered in someone's group chat.
    for (const edition of EDITIONS) {
      const url = new URL(editionBrand(edition).ogImage);
      expect(url.protocol, edition).toBe('https:');
      expect(url.hostname, edition).toMatch(/\.web\.app$/);
      const file = url.pathname.replace(/^\//, '');
      expect(file, edition).toMatch(/^og-[a-z]+\.png$/);
      // `npm test` runs Vitest from the repository root (package.json); the
      // src-only include pattern narrows discovery but does not change cwd.
      expect(existsSync(resolve(process.cwd(), 'public', file)), `${edition} → ${file}`).toBe(true);
    }
  });

  it('keeps every og:url on HTTPS with no other Edition’s hostname', () => {
    // og:url is the canonical identity a crawler files the link under. The
    // vacay row carries its Event canonical host (bodega-bay) rather than the
    // dead vacaybingo.com apex — per-Event truth carried per-Edition until the
    // #546 Worker rewrites it per hostname (see the EditionBrand.ogUrl note).
    expect(editionBrand('vacay').ogUrl).toBe('https://bodega-bay.vacaybingo.com/');
    expect(editionBrand('fiveacross').ogUrl).toBe('https://fiveacross.app/');
    for (const edition of ['vacay', 'fiveacross']) {
      const brand = editionBrand(edition);
      expect(brand.ogUrl, edition).not.toMatch(/gaycruisebingo/);
      expect(brand.ogImage, edition).not.toMatch(/gaycruisebingo/);
    }
  });

  it('gives no Edition another Edition’s artwork', () => {
    const images = EDITIONS.map((e) => editionBrand(e).ogImage);
    expect(new Set(images).size).toBe(EDITIONS.length);
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

  it('uses an explicit trusted static fallback for hostname-resolved target chrome', () => {
    expect(buildTimeEdition('', 'gcb', 'vacay')).toBe('vacay');
    expect(buildTimeEdition(null, 'vacay', '')).toBe(DEFAULT_EDITION);
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
      const brand = editionBrand(edition);
      expect(out, edition).toContain(`<title>${brand.documentTitle}</title>`);
      expect(out, edition).toContain(
        `<meta name="apple-mobile-web-app-title" content="${brand.appName}" />`,
      );
      // The share block (#587): what a crawler — which runs none of the app's
      // JS — reads out of this Edition's baked HTML.
      expect(out, edition).toContain(`<meta name="description" content="${brand.metaDescription}" />`);
      expect(out, edition).toContain(`<meta property="og:site_name" content="${brand.documentTitle}" />`);
      expect(out, edition).toContain(`<meta property="og:title" content="${brand.documentTitle}" />`);
      expect(out, edition).toContain(`<meta property="og:url" content="${brand.ogUrl}" />`);
      expect(out, edition).toContain(`<meta property="og:image" content="${brand.ogImage}" />`);
      expect(out, edition).toContain(`<meta property="og:image:alt" content="${brand.ogImageAlt}" />`);
      expect(out, edition).toContain(`<meta name="twitter:image" content="${brand.ogImage}" />`);
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

describe('alternateNamespaceApex — the setup wizard address step (#790)', () => {
  it('is null for fiveacross — it IS the canonical Namespace, so it owns no distinct alternate', () => {
    expect(alternateNamespaceApex('fiveacross')).toBeNull();
  });

  it('names vacaybingo.com for vacay', () => {
    expect(alternateNamespaceApex('vacay')).toBe('vacaybingo.com');
  });

  it('is null for gcb — gaycruisebingo.com is a site, not a wildcard Namespace', () => {
    // This asserted 'gaycruisebingo.com' until Codex caught it on PR #911.
    // `CONTEXT.md` § Namespace names exactly two apexes whose WILDCARD
    // subdomains address Events, and `worker/src/host.ts`'s NAMESPACES guard
    // admits exactly those two — so `<slug>.gaycruisebingo.com` is refused as
    // out-of-namespace before its hostname document is read. The old row made
    // the wizard advertise an address that cannot serve; now that the step
    // CHECKS every previewed address, it would have blocked a GCB occasion
    // outright.
    expect(alternateNamespaceApex('gcb')).toBeNull();
  });

  it('names only apexes the router actually serves', () => {
    // Pins the table against `worker/src/host.ts`'s NAMESPACES so a future row
    // cannot advertise an address the edge refuses. `fiveacross.app` is the
    // canonical Namespace and never appears as an ALTERNATE.
    const SERVED_ALTERNATES = ['vacaybingo.com'];
    for (const edition of ['gcb', 'vacay', 'fiveacross', 'not-a-real-edition']) {
      const apex = alternateNamespaceApex(edition);
      if (apex !== null) expect(SERVED_ALTERNATES).toContain(apex);
    }
  });

  it('is null for an unrecognized Edition id', () => {
    expect(alternateNamespaceApex('not-a-real-edition')).toBeNull();
  });

  it('is null for inherited Object.prototype keys, not a nonsense apex', () => {
    // Phase 4b P2, PR #911: as an ordinary object literal the table returned
    // the Function constructor for 'constructor' and a function for
    // 'toString' — both truthy, so the `?? null` fallback never fired and an
    // unrecognized id could produce an "apex" the wizard would preview, check
    // and hand to the launch provisioner. Edition ids arrive from imported and
    // hand-edited drafts, so these are reachable inputs rather than a
    // theoretical class.
    for (const key of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(alternateNamespaceApex(key)).toBeNull();
    }
  });
});
