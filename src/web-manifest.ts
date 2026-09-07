// The one PWA manifest builder (#546).
//
// TWO consumers, one function: `vite.config.ts` emits `dist/manifest.webmanifest`
// from it at build time, and the edge Worker answers `GET /manifest.webmanifest`
// from it per hostname (`worker/src/manifest.ts`). They cannot drift, which is
// the actual content of this ticket's "verified across the cutover" criterion —
// a build that installs one name while the edge serves another is the same
// defect as no per-host manifest at all, only harder to see.
//
// Pure on purpose: no DOM, no `import.meta`, no Node built-in. `editions.ts`
// can be neither compiled by the Worker's program (no `vite/client`, no DOM
// lib) nor loaded in workerd, so the brand rows come from `edition-brands.ts`
// instead. Keep this module the same shape.

import { brandFor } from './edition-brands';
import type { EditionBrand } from './types';

/** The filename the manifest is served at, on the origin and at the edge
 *  alike. `vite-plugin-pwa`'s own default, restated here because this module
 *  now emits the file that plugin used to generate. */
export const WEB_MANIFEST_FILENAME = 'manifest.webmanifest';

/** The request path the edge Worker answers. Derived from the filename so the
 *  route and the emitted asset cannot be renamed apart. */
export const WEB_MANIFEST_PATH = `/${WEB_MANIFEST_FILENAME}`;

/** `application/manifest+json` is the registered media type, and the one
 *  Firebase Hosting already serves the built file with — so the edge response
 *  and the origin response agree on the header as well as the body. */
export const WEB_MANIFEST_CONTENT_TYPE = 'application/manifest+json';

export interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

/**
 * The exact set of members this app publishes — no more, and in this order.
 *
 * The order is load-bearing for one reason: it keeps the emitted file
 * byte-identical to the artifact `vite-plugin-pwa` generated before this
 * ticket, so the extraction can be reviewed as a move rather than as a
 * redesign of every installed app's identity.
 *
 * `id` is deliberately absent, and its absence is the interesting member.
 * Without one, a PWA's identity derives from `start_url` resolved against the
 * document origin — already per-origin, which is exactly the granularity #599
 * as amended settled on (every registered host serves in place, so each host is
 * its own installed app). Adding an `id` now would re-identify every app that
 * is already installed from the statically served manifest, which is the one
 * thing a change reaching installed shells may not do.
 */
export interface WebManifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  display: string;
  background_color: string;
  theme_color: string;
  lang: string;
  scope: string;
  orientation: string;
  icons: WebManifestIcon[];
}

/** `start_url` and `scope` are both the site root because the app is served
 *  from the origin root on every hostname (Vite's `base` is its default `/`).
 *  Constants rather than a derived base path, because the Worker has no Vite
 *  config to derive one from and must produce the same bytes. `lang` is the
 *  plugin default the generated manifest carried, preserved verbatim. */
const START_URL = '/';
const SCOPE = '/';
const LANG = 'en';

/**
 * The dark chrome colour, shared with `index.html`'s `<meta name="theme-color">`
 * — `specs/w1-pwa.md` requires the two to match exactly.
 *
 * Edition-INVARIANT, and that is this ticket's scope line rather than an
 * oversight. The meta tag is static markup inside a proxied HTML response, so
 * making the manifest's colours per-Edition here while the tag stayed
 * `#07060d` would manufacture the mismatch that spec forbids. Both move
 * together in the follow-up that rewrites the proxied `<head>` (#1118).
 */
const CHROME_COLOR = '#07060d';

/** One shared icon set. There is no per-Edition PWA icon art anywhere in the
 *  repo — the only per-Edition images are the 1200x630 `og-*.png` unfurls,
 *  wrong aspect and wrong purpose — so "icons match the Edition" is satisfied
 *  today by Edition-invariant icons being correct for every Edition. Per-Edition
 *  icon art is a design deliverable, not a routing one. */
const ICONS: readonly WebManifestIcon[] = [
  { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
  { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
  { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/**
 * The installed app's identity for one Edition.
 *
 * `name` is the roomier install-prompt and splash label; `short_name` is the
 * home-screen label and Android's only source for it, which is why
 * `EditionBrand.appShortName` owns a separate ~12-character budget (#359,
 * #364). iOS reads neither — it takes its home-screen label from
 * `apple-mobile-web-app-title` in the markup — so the two platforms are set
 * independently and this file cannot fix the iOS half.
 */
export function buildWebManifest(brand: EditionBrand): WebManifest {
  return {
    name: brand.appName,
    short_name: brand.appShortName,
    description: brand.appDescription,
    start_url: START_URL,
    display: 'standalone',
    background_color: CHROME_COLOR,
    theme_color: CHROME_COLOR,
    lang: LANG,
    scope: SCOPE,
    orientation: 'portrait',
    // Copied rather than shared, so a caller that mutates what it was handed
    // cannot rewrite the icon set every later caller receives.
    icons: ICONS.map((icon) => ({ ...icon })),
  };
}

/** The manifest for an Edition id, applying the same total fallback the app
 *  applies: absent, non-string or unrecognised resolves to the default Edition
 *  (`brandFor`). This is the edge's entry point, because a hostname document's
 *  `edition` is operator-authored data rather than a value this code chose. */
export function webManifestForEdition(edition: string | null | undefined): WebManifest {
  return buildWebManifest(brandFor(edition));
}

/** Minified, with the trailing newline the generated artifact carried. Both
 *  consumers serialize through here, so the emitted file and the edge response
 *  are byte-for-byte the same document. */
export function serializeWebManifest(manifest: WebManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}
