import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EDITION, editionBrand, setActiveEdition } from './editions';
import { EDITION_IDS } from './edition-registry';
import {
  buildWebManifest,
  serializeWebManifest,
  webManifestForEdition,
  WEB_MANIFEST_CONTENT_TYPE,
  WEB_MANIFEST_FILENAME,
  WEB_MANIFEST_PATH,
} from './web-manifest';

// The path goes through a VARIABLE, which is load-bearing rather than stylistic:
// Vite rewrites `new URL('<literal>', import.meta.url)` into an asset-URL
// lookup, so a literal here resolves to `http://localhost:3000/...` and
// `fileURLToPath` rejects it. Same idiom as `recon-share-og.test.ts`.
const repoFile = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url).href);

interface HostingHeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}
const hostingHeaders: HostingHeaderRule[] = (
  JSON.parse(readFileSync(repoFile('../firebase.json'), 'utf8')) as {
    hosting: { headers: HostingHeaderRule[] };
  }
).hosting.headers;

// The manifest builder both the build and the edge Worker call (#546). The
// tests that matter here are not "does it have a name" — they are the two
// properties an installed app depends on: the document is byte-for-byte what
// `vite-plugin-pwa` used to emit, and an unrecognised Edition resolves the same
// way at the edge as it does in the app.

afterEach(() => {
  // `setActiveEdition` writes module state shared with the rest of the suite.
  setActiveEdition(DEFAULT_EDITION);
});

describe('the manifest document', () => {
  it('publishes exactly the members the generated manifest published, in the same order', () => {
    // Order is asserted, not just membership. It is what keeps the emitted file
    // byte-identical to the pre-#546 artifact, which is what lets this change be
    // reviewed as a move rather than as a rename of every installed app.
    expect(Object.keys(buildWebManifest(editionBrand(EDITION_IDS.GAY_CRUISE_BINGO)))).toEqual([
      'name',
      'short_name',
      'description',
      'start_url',
      'display',
      'background_color',
      'theme_color',
      'lang',
      'scope',
      'orientation',
      'icons',
    ]);
  });

  it('carries no `id`, so installed identity keeps deriving from the origin', () => {
    // Absent `id` means identity comes from `start_url` resolved against the
    // document origin — already per-origin, which is the granularity #599 as
    // amended settled on. Adding one would re-identify every app installed from
    // the statically served manifest, which is the one thing a change that
    // reaches installed shells may not do.
    expect(buildWebManifest(editionBrand(EDITION_IDS.VACAY_BINGO))).not.toHaveProperty('id');
  });

  it.each([EDITION_IDS.GAY_CRUISE_BINGO, EDITION_IDS.VACAY_BINGO, EDITION_IDS.FIVE_ACROSS])(
    'takes the installed identity of %s from its brand row, and nothing else',
    (edition) => {
      const brand = editionBrand(edition);
      const manifest = webManifestForEdition(edition);
      expect(manifest.name).toBe(brand.appName);
      expect(manifest.short_name).toBe(brand.appShortName);
      expect(manifest.description).toBe(brand.appDescription);
    },
  );

  it.each([EDITION_IDS.GAY_CRUISE_BINGO, EDITION_IDS.VACAY_BINGO, EDITION_IDS.FIVE_ACROSS])(
    'keeps every non-identity member Edition-invariant for %s',
    (edition) => {
      const manifest = webManifestForEdition(edition);
      // The plugin defaults, preserved verbatim...
      expect(manifest.start_url).toBe('/');
      expect(manifest.scope).toBe('/');
      expect(manifest.lang).toBe('en');
      // ...and this ticket's scope line. The colours stay Edition-invariant
      // because `index.html`'s `<meta name="theme-color">` is static markup that
      // only the follow-up HTML rewrite (#1118) can move, and specs/w1-pwa.md
      // requires the two to match exactly.
      expect(manifest.theme_color).toBe('#07060d');
      expect(manifest.background_color).toBe('#07060d');
      expect(manifest.display).toBe('standalone');
      expect(manifest.orientation).toBe('portrait');
      // One shared icon set: there is no per-Edition PWA icon art in the repo.
      expect(manifest.icons).toEqual([
        { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]);
    },
  );

  it('hands each caller its own icon array', () => {
    const first = buildWebManifest(editionBrand(EDITION_IDS.GAY_CRUISE_BINGO));
    first.icons[0]!.src = 'mutated.png';
    expect(buildWebManifest(editionBrand(EDITION_IDS.GAY_CRUISE_BINGO)).icons[0]!.src).toBe('pwa-192.png');
  });
});

describe('serialization', () => {
  it('reproduces the pre-#546 artifact byte for byte', () => {
    // Pinned as a literal on purpose. This exact string is what
    // `vite-plugin-pwa` emitted as `dist/manifest.webmanifest` before this
    // ticket (MD5 812a982ad414e9afa6301b2db245e49e, the revision the old
    // precache entry carried), so a diff here is a diff in what every Gay
    // Cruise Bingo player's home screen is named. Changing the copy is allowed;
    // changing it ACCIDENTALLY is what this pin is for.
    expect(serializeWebManifest(webManifestForEdition(EDITION_IDS.GAY_CRUISE_BINGO))).toBe(
      '{"name":"Gay Cruise Bingo","short_name":"Gay Bingo","description":"Live multiplayer bingo for the high seas.",' +
        '"start_url":"/","display":"standalone","background_color":"#07060d","theme_color":"#07060d","lang":"en",' +
        '"scope":"/","orientation":"portrait","icons":[{"src":"pwa-192.png","sizes":"192x192","type":"image/png"},' +
        '{"src":"pwa-512.png","sizes":"512x512","type":"image/png"},{"src":"pwa-512.png","sizes":"512x512",' +
        '"type":"image/png","purpose":"maskable"}]}\n',
    );
  });

  it('is minified and newline-terminated, like the generated file', () => {
    const serialized = serializeWebManifest(webManifestForEdition(EDITION_IDS.VACAY_BINGO));
    expect(serialized.endsWith('}\n')).toBe(true);
    expect(serialized).not.toMatch(/\n\s/);
    expect(JSON.parse(serialized)).toEqual(webManifestForEdition(EDITION_IDS.VACAY_BINGO));
  });
});

describe('an unrecognised Edition', () => {
  // The edge and the client must not disagree even about the FALLBACK. A
  // hostname document naming an Edition this build has never heard of has to
  // install under the same name in both places, or a player's home-screen icon
  // ends up named differently from the app it opens.
  const unknown: (string | null | undefined)[] = [
    '',
    null,
    undefined,
    'not-an-edition',
    // Inherited `Object.prototype` keys, which a bare index lookup answers
    // truthily (#597) — the reason the guard tests own-property-hood.
    'constructor',
    'toString',
    'hasOwnProperty',
  ];

  it.each(unknown)('resolves %s to the default Edition', (edition) => {
    expect(webManifestForEdition(edition)).toEqual(webManifestForEdition(DEFAULT_EDITION));
  });

  it.each(unknown)('agrees with what the app itself would install for %s', (edition) => {
    // `setActiveEdition` is the app's own coercion (`src/data/hostnames.ts`
    // hands it a `''` for a non-string `edition`), so this compares the edge's
    // answer against the client's rather than against a restatement of it.
    setActiveEdition(edition);
    expect(webManifestForEdition(edition).name).toBe(editionBrand().appName);
    expect(webManifestForEdition(edition).short_name).toBe(editionBrand().appShortName);
  });
});

describe('the served address', () => {
  it('derives the request path from the filename, so they cannot be renamed apart', () => {
    expect(WEB_MANIFEST_FILENAME).toBe('manifest.webmanifest');
    expect(WEB_MANIFEST_PATH).toBe(`/${WEB_MANIFEST_FILENAME}`);
  });

  it('declares the registered media type', () => {
    expect(WEB_MANIFEST_CONTENT_TYPE).toBe('application/manifest+json');
  });

  it('is served `no-cache` by the origin, by DECLARATION rather than by accident', () => {
    // It was already no-cache before #546 — but only because it fell through
    // the `**` catch-all while also happening to miss the immutable
    // `js|css|woff2|png|svg` rule. Right posture, held up by two absences.
    // Naming it in the explicit enumeration is what stops a future headers edit
    // (adding `.webmanifest` to the immutable list, say) from silently pinning
    // an installed app's identity to whatever the origin last served.
    const explicit = hostingHeaders.filter(
      (rule) => rule.source.includes(WEB_MANIFEST_FILENAME) && !rule.source.startsWith('**'),
    );
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.headers).toEqual([{ key: 'Cache-Control', value: 'no-cache' }]);
    // ...and it must NOT also match the immutable rule.
    const immutable = hostingHeaders.filter((rule) =>
      rule.headers.some((header) => header.value.includes('immutable')),
    );
    for (const rule of immutable) {
      expect(rule.source).not.toContain('webmanifest');
    }
  });
});
