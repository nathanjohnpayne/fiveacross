// The one `index.html` head-identity table (#1118).
//
// TWO consumers, one table, on the shape `web-manifest.ts` established for the
// manifest (#546): {@link brandHtmlIdentity} substitutes the placeholders at
// BUILD time for `vite.config.ts`, and the edge Worker rewrites the SAME tags
// per resolved hostname from {@link headIdentityEdits}
// (`worker/src/htmlHead.ts`). A second list kept in step by review is how a
// build bakes one Edition's share block while the edge serves another's — the
// same drift the manifest builder exists to prevent, on the surface a crawler
// actually reads. `src/editions.ts` re-exports `brandHtmlIdentity` so no
// import site had to move.
//
// Pure on purpose: no DOM, no `import.meta`, no Node built-in, extensionless
// relative imports. `editions.ts` can be compiled by neither the Worker's
// program (no `vite/client`, no DOM lib) nor `vite.config.ts`'s Node context,
// so anything both of them need lives out here. Keep this module the same
// shape.

import { buildWebManifest } from './web-manifest';
import type { EditionBrand } from './types';

/** The brand fields that are plain strings — i.e. the ones a static HTML
 *  placeholder could carry. `EditionBrand` gained a nested `lexicon` in #608, so
 *  a bare `keyof EditionBrand` would let a token be pointed at an OBJECT and
 *  stringify it into the tab title as `[object Object]`. Narrowing here makes
 *  that a compile error at the table below rather than a shipped defect. */
export type EditionBrandTextField = {
  // `-?` keeps OPTIONAL fields (`wordmarkByline`) out of the union the same
  // way objects are kept out: `string | undefined` fails `extends string`, so
  // the field maps to `never` — and the modifier stops the optionality from
  // smuggling `undefined` itself into the resulting key union.
  [K in keyof EditionBrand]-?: EditionBrand[K] extends string ? K : never;
}[keyof EditionBrand];

/** The `index.html` placeholders, and the field each one carries. Adding a row
 *  here is the whole cost of branding a new static tag — plus one line in
 *  {@link HEAD_IDENTITY_TAGS} or {@link RUNTIME_REPAIRED_TOKENS} saying which
 *  surface corrects it for a hostname-resolved bundle, which
 *  {@link assertHeadIdentityCoverage} refuses to let you skip. */
export const HTML_IDENTITY_TOKENS = {
  '%EDITION_DOCUMENT_TITLE%': 'documentTitle',
  '%EDITION_APP_NAME%': 'appName',
  // The share block (#587). Crawlers fetch index.html without running JS, so
  // unlike the two tags above there is no runtime repair path for these — the
  // edge Worker rewrites them per hostname instead (#1118), from the rows in
  // `HEAD_IDENTITY_TAGS` below. `%EDITION_SHARE_NAME%` appears twice
  // (og:site_name and og:title — both carry the product name);
  // `%EDITION_OG_IMAGE%` twice (og:image and twitter:image). og:description is
  // NOT tokenised: "Sign in, get your card, mark it if you see it." is the
  // Edition-invariant tagline, and keeping it static keeps the gcb unfurl
  // wording byte-identical to what shipped before #587.
  '%EDITION_META_DESCRIPTION%': 'metaDescription',
  '%EDITION_SHARE_NAME%': 'documentTitle',
  '%EDITION_OG_URL%': 'ogUrl',
  '%EDITION_OG_IMAGE%': 'ogImage',
  '%EDITION_OG_IMAGE_ALT%': 'ogImageAlt',
  // The PWA chrome colour (#1118). Tokenised rather than left literal because
  // `specs/w1-pwa.md` requires it to equal the manifest's `theme_color`
  // exactly, and that value became Edition-scoped in the same change — a
  // static `#07060d` here would manufacture the mismatch that spec forbids on
  // every Edition but the default.
  '%EDITION_THEME_COLOR%': 'chromeColor',
} as const satisfies Record<string, EditionBrandTextField>;

/** A placeholder this build knows. Edge rows below are keyed by it, so a tag
 *  the edge rewrites cannot name a token the build does not substitute. */
export type HtmlIdentityToken = keyof typeof HTML_IDENTITY_TOKENS;

/**
 * Where the EDGE gets a tag's value for one resolved hostname.
 *
 * - `brand` — the same brand field the build substitutes into the placeholder.
 * - `request-origin` — the requested hostname's own origin. The one value whose
 *   truth is per-EVENT rather than per-Edition, which is exactly why a build
 *   cannot bake it: the vacay row carries a single Event's canonical host
 *   because a build has nowhere else to put it (`EditionBrand.ogUrl`).
 * - `manifest-theme-color` — read back out of the manifest builder rather than
 *   off the brand row, so "the meta tag equals the manifest's `theme_color`"
 *   is structural rather than a second read of a shared constant.
 */
export type EdgeHeadSource = 'brand' | 'request-origin' | 'manifest-theme-color';

/** One `index.html` tag, in both of the places it is written. */
export interface HeadIdentityTag {
  /** The tag, as the CSS selector the edge rewriter matches it with. */
  selector: string;
  /** The attribute the value lands in. */
  attribute: string;
  /** The BUILD-time placeholder this tag carries in `index.html`. */
  token: HtmlIdentityToken;
  /** How the EDGE computes the value for a resolved hostname. */
  edge: EdgeHeadSource;
}

/**
 * The crawler-facing tags the edge rewrites per hostname, and nothing else.
 *
 * Scoped to the tags with NO runtime repair path. `<title>` and
 * `apple-mobile-web-app-title` are deliberately absent: `editions.ts`
 * `applyEditionDocumentIdentity` already corrects both in the DOM after
 * resolution, so rewriting them at the edge would add a second writer for a
 * surface that is already right, and the tokens are listed in
 * {@link RUNTIME_REPAIRED_TOKENS} instead so the coverage check still sees
 * them.
 *
 * Every selector is written exactly as `index.html` writes the attribute it
 * matches on, and `src/editions.test.ts` asserts each one resolves against the
 * real file — a selector that matches nothing rewrites nothing, silently.
 */
export const HEAD_IDENTITY_TAGS: readonly HeadIdentityTag[] = [
  {
    selector: 'meta[name="description"]',
    attribute: 'content',
    token: '%EDITION_META_DESCRIPTION%',
    edge: 'brand',
  },
  {
    selector: 'meta[property="og:site_name"]',
    attribute: 'content',
    token: '%EDITION_SHARE_NAME%',
    edge: 'brand',
  },
  {
    selector: 'meta[property="og:title"]',
    attribute: 'content',
    token: '%EDITION_SHARE_NAME%',
    edge: 'brand',
  },
  {
    selector: 'meta[property="og:url"]',
    attribute: 'content',
    token: '%EDITION_OG_URL%',
    edge: 'request-origin',
  },
  {
    selector: 'meta[property="og:image"]',
    attribute: 'content',
    token: '%EDITION_OG_IMAGE%',
    edge: 'brand',
  },
  {
    selector: 'meta[property="og:image:alt"]',
    attribute: 'content',
    token: '%EDITION_OG_IMAGE_ALT%',
    edge: 'brand',
  },
  {
    selector: 'meta[name="twitter:image"]',
    attribute: 'content',
    token: '%EDITION_OG_IMAGE%',
    edge: 'brand',
  },
  {
    selector: 'meta[name="theme-color"]',
    attribute: 'content',
    token: '%EDITION_THEME_COLOR%',
    edge: 'manifest-theme-color',
  },
];

/** The placeholders a hostname-resolved bundle repairs in the DOM after
 *  resolution (`applyEditionDocumentIdentity`), so the edge leaves them alone.
 *  Listed rather than inferred from absence: "not in the edge table" would
 *  read identically whether the omission was a decision or an oversight. */
export const RUNTIME_REPAIRED_TOKENS: readonly HtmlIdentityToken[] = [
  '%EDITION_DOCUMENT_TITLE%',
  '%EDITION_APP_NAME%',
];

/**
 * Every token is corrected somewhere, for a hostname-resolved bundle.
 *
 * Run at module load, like `assertEditionRegistryParity`. A new placeholder
 * that is baked at build time and corrected nowhere is not a crash — it is a
 * multi-Event bundle quietly serving the default Edition's copy on every other
 * Edition's hostname, which is the entire defect class this module exists to
 * close. Failing here makes the omission a decision someone has to write down.
 */
export function assertHeadIdentityCoverage(): void {
  const covered = new Set<string>([
    ...HEAD_IDENTITY_TAGS.map((tag) => tag.token),
    ...RUNTIME_REPAIRED_TOKENS,
  ]);
  const uncovered = Object.keys(HTML_IDENTITY_TOKENS).filter((token) => !covered.has(token));
  if (uncovered.length > 0) {
    throw new Error(
      `html-head-identity: ${uncovered.join(', ')} is baked into index.html at build time and ` +
        'corrected for a hostname-resolved bundle nowhere. Add a row to HEAD_IDENTITY_TAGS (the ' +
        'edge rewrites it per hostname) or to RUNTIME_REPAIRED_TOKENS (the app repairs it in the ' +
        'DOM after resolution) in src/html-head-identity.ts.',
    );
  }
}

assertHeadIdentityCoverage();

/** Matches every placeholder of that SHAPE, including ones with no row in
 *  {@link HTML_IDENTITY_TOKENS} — which is the point: an unknown one must fail
 *  the build, not pass through. */
const HTML_IDENTITY_PATTERN = /%EDITION_[A-Z_]+%/;

/** Escape a brand string for BOTH contexts it lands in — `<title>` element text
 *  and a double-quoted attribute value. Every value is plain ASCII today; this
 *  exists so an Edition named with an `&` is a rendering detail rather than
 *  malformed markup. The EDGE deliberately does not do this: `setAttribute`
 *  hands the value to a serializer that escapes it for the attribute context
 *  itself, and escaping twice would ship `&amp;amp;` to a crawler. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Brand `index.html`'s static identity with one Edition's copy (#586).
 *
 * Called at BUILD time by the `edition-html-identity` plugin in
 * `vite.config.ts` — hence a pure string function here rather than logic inside
 * the config, so the substitution and its fail-closed check are unit-testable
 * without running a build. `<title>` and `apple-mobile-web-app-title` are static
 * markup, so on a single-Event build this is the only place the Edition can
 * reach a browser tab, a bookmark, a share-sheet title or iOS's "Add to Home
 * Screen" default before any JavaScript runs.
 *
 * Takes the resolved brand rather than an Edition id: the caller already holds
 * one (it brands the manifest from the same object), and a caller-supplied
 * brand is what lets a test drive copy this table does not happen to contain
 * today — the escaping above has no other way to be exercised.
 *
 * THROWS on a placeholder it does not recognise. A survivor is not a crash —
 * it renders as the literal text `%EDITION_…%` in the tab and in the installed
 * app's name, which is the kind of defect that builds, deploys, and is found by
 * a player rather than by CI.
 */
export function brandHtmlIdentity(html: string, brand: EditionBrand): string {
  let out = html;
  for (const [token, field] of Object.entries(HTML_IDENTITY_TOKENS)) {
    out = out.replaceAll(token, escapeHtml(brand[field]));
  }
  const orphan = out.match(HTML_IDENTITY_PATTERN);
  if (orphan) {
    throw new Error(
      `index.html contains an unrecognised Edition placeholder ${orphan[0]}. Add it ` +
        'to HTML_IDENTITY_TOKENS in src/html-head-identity.ts (with the EditionBrand ' +
        'field it should read), or remove it from the markup — a placeholder that ' +
        'survives this substitution is shipped as literal text to every visitor.',
    );
  }
  return out;
}

/** One attribute write the edge performs on the proxied document. */
export interface HeadIdentityEdit {
  selector: string;
  attribute: string;
  content: string;
}

/**
 * `og:url` for a requested hostname: its own origin, with the trailing slash
 * every brand row's `ogUrl` carries.
 *
 * Built from the hostname rather than copied off the request URL so neither a
 * port nor a scheme a proxy hop invented can reach an unfurl. Every serving
 * address is HTTPS — the router rewrites the origin fetch to `https:` for the
 * same reason — and a crawler that files the link under an `http://` identity
 * files it under a different one.
 */
export function requestOriginUrl(hostname: string): string {
  return `https://${hostname}/`;
}

/**
 * What the edge writes into the proxied `<head>` for one Edition on one host.
 *
 * Pure, and returns data rather than performing the rewrite, so the decision
 * (which tag gets which value) is unit-testable in plain Node while only the
 * streaming application of it needs a workerd runtime.
 *
 * The theme colour is read back out of {@link buildWebManifest} rather than off
 * `brand.chromeColor`: `specs/w1-pwa.md` requires the meta tag to equal the
 * manifest's `theme_color` exactly, and reading the manifest is the only form
 * of that claim a later change to the builder cannot falsify.
 */
export function headIdentityEdits(brand: EditionBrand, hostname: string): HeadIdentityEdit[] {
  const themeColor = buildWebManifest(brand).theme_color;
  return HEAD_IDENTITY_TAGS.map((tag) => ({
    selector: tag.selector,
    attribute: tag.attribute,
    content:
      tag.edge === 'brand'
        ? brand[HTML_IDENTITY_TOKENS[tag.token]]
        : tag.edge === 'request-origin'
          ? requestOriginUrl(hostname)
          : themeColor,
  }));
}
