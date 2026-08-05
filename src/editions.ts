// Edition identity for the PRE-AUTH shell (#543, ADR 0009).
//
// An Edition is a branded product line — Gay Cruise Bingo, Vacay Bingo — under
// which Events are run (CONTEXT.md § Edition). This module owns the copy the
// app must be able to show BEFORE it knows anything else about the Event.
//
// Why a code table and not Firestore: the sign-in gate has to be branded, and
// `events/{eventId}` requires `signedIn()`, so the Event doc cannot reach the
// screen that gets you signed in. `hostnames/{host}.edition` is the only
// Edition signal available that early, and it is an identifier, not copy.
// Editions are few and their wordmark is product copy rather than per-Event
// data, so resolving that identifier against a table here beats widening the
// routing document and reseeding every time a line of marketing copy changes.
//
// BUILD-TIME CONSUMER: `vite.config.ts` imports this module to brand
// `index.html` and the PWA manifest from `VITE_EDITION` (#586). It is loaded
// there by esbuild in a plain Node context, where `import.meta.env` does not
// exist and neither does `document`. Keep this module free of BOTH at module
// scope — a top-level read of either aborts Vite config loading (with a bare
// "Cannot read properties of undefined") before the build even starts. Reading
// them inside a function is fine: the config only ever calls `editionBrand`
// with an explicit Edition id.

export interface EditionBrand {
  /** The wordmark on the signed-out gate. */
  wordmark: string;
  /** One line under it: what this is and when. Signed-out state only. */
  tagline: string;
  /** The offline reassurance at the foot of the gate. Edition-specific because
   *  the reason you might lose signal is. */
  offlineNote: string;
  /** `<title>`: the browser tab, the bookmark name, and the title the share
   *  sheet pre-fills. Deliberately NOT the same field as `appName` — retitling
   *  a page must not be able to silently rename an already-installed icon,
   *  which is the reason index.html sets `apple-mobile-web-app-title`
   *  explicitly rather than letting iOS fall back to `<title>`. */
  documentTitle: string;
  /** The INSTALLED app's full name: the PWA manifest `name` (Android's install
   *  prompt and app info) and, via `apple-mobile-web-app-title`, the iOS
   *  home-screen label. */
  appName: string;
  /** Android's home-screen label (manifest `short_name`); iOS ignores it in
   *  favour of `appName` (#364). Keep it under ~12 characters or Android
   *  truncates it — dropping a word beats letting the launcher choose which
   *  half of the brand to show (#359). */
  appShortName: string;
  /** One line beside the install prompt (manifest `description`). */
  appDescription: string;
}

export const DEFAULT_EDITION = 'gcb';

const BRANDS: Record<string, EditionBrand> = {
  gcb: {
    wordmark: 'GAY CRUISE BINGO',
    tagline: 'Trieste → Barcelona · July 2026. Sign in, get your card, mark it if you see it.',
    offlineNote: 'Lost signal at sea? The printed cards and PDF still work.',
    // Verbatim the strings index.html and the manifest hardcoded before #586,
    // so a `gcb` build is byte-identical to the shipped deployment.
    documentTitle: 'Gay Cruise Bingo',
    appName: 'Gay Cruise Bingo',
    appShortName: 'Gay Bingo',
    appDescription: 'Live multiplayer bingo for the high seas.',
  },
  vacay: {
    wordmark: 'VACAY BINGO',
    tagline: 'Sign in, get your card, mark it if you see it.',
    offlineNote: 'Patchy signal? Your card keeps working offline — marks sync when you reconnect.',
    // Title case, not the caps wordmark: these render as a browser tab and a
    // home-screen label, not as the gate's display type. "Vacay Bingo" is 11
    // characters, so it survives Android's short_name truncation whole and
    // needs no shortened variant.
    documentTitle: 'Vacay Bingo',
    appName: 'Vacay Bingo',
    appShortName: 'Vacay Bingo',
    appDescription: 'Live multiplayer bingo for the trip.',
  },
};

/**
 * The resolved Edition for this session — the ONLY copy of it (#580).
 *
 * Seeded from `VITE_EDITION` so a single-Edition build is correct with no
 * network resolution at all, then overwritten by `bootstrapEventResolution`
 * with whatever `hostnames/{host}` said. Read through the accessors below, never
 * captured at import time — a module-level constant would freeze whatever was
 * true before resolution ran.
 *
 * `src/theme/themes.ts` reads and re-exports THIS state for Theme scoping
 * (`themesForEdition`, `defaultThemeForEdition`). It briefly held a twin
 * `currentEdition` of its own, which made the resolver rebrand the sign-in
 * shell while the pickers kept the build-time Edition — one setter, one state.
 */
let currentEdition: string | null = null;

/** The build-time seed, read LAZILY.
 *
 *  It used to be a module-scope initialiser, which is the obvious way to write
 *  it and the one thing this module may not do: `vite.config.ts` now imports
 *  the brand table (see the module note above), and `import.meta.env` is
 *  undefined in that Node context, so evaluating it at import time took the
 *  whole build down before it started. Deferring the read into a function makes
 *  the module safe to import from the config while leaving app behaviour
 *  identical — `activeEdition()` still answers `VITE_EDITION` on first call. */
function seedEdition(): string {
  return import.meta.env.VITE_EDITION || DEFAULT_EDITION;
}

export function activeEdition(): string {
  return (currentEdition ??= seedEdition());
}

/** Install the resolved Edition. A falsy or unknown value resets to the legacy
 *  Edition: an unrecognised Edition should degrade to the shipped experience,
 *  never to an unbranded screen. */
export function setActiveEdition(edition: string | null | undefined): void {
  currentEdition = edition && BRANDS[edition] ? edition : DEFAULT_EDITION;
}

/** Brand copy for the active Edition (or an explicit one, for tests).
 *
 *  `vite.config.ts` calls this at build time and MUST pass the id explicitly:
 *  the default argument resolves through `activeEdition()`, which reads
 *  `import.meta.env` and therefore only works in the app. */
export function editionBrand(edition: string = activeEdition()): EditionBrand {
  return BRANDS[edition] ?? BRANDS[DEFAULT_EDITION];
}

/** The `index.html` placeholders, and the field each one carries. Adding a row
 *  here is the whole cost of branding a new static tag. */
const HTML_IDENTITY_TOKENS: Record<string, keyof EditionBrand> = {
  '%EDITION_DOCUMENT_TITLE%': 'documentTitle',
  '%EDITION_APP_NAME%': 'appName',
};

/** Matches every placeholder of that SHAPE, including ones with no row above —
 *  which is the point: an unknown one must fail the build, not pass through. */
const HTML_IDENTITY_PATTERN = /%EDITION_[A-Z_]+%/;

/** Escape a brand string for BOTH contexts it lands in — `<title>` element text
 *  and a double-quoted attribute value. Every value is plain ASCII today; this
 *  exists so an Edition named with an `&` is a rendering detail rather than
 *  malformed markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Brand `index.html`'s static chrome identity with one Edition's copy (#586).
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
 * today — the escaping below has no other way to be exercised.
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
        'to HTML_IDENTITY_TOKENS in src/editions.ts (with the EditionBrand field it ' +
        'should read), or remove it from the markup — a placeholder that survives ' +
        'this substitution is shipped as literal text to every visitor.',
    );
  }
  return out;
}

/**
 * Put the Edition's name on the browser chrome: the tab, and the label iOS
 * offers when someone adds the app to their home screen.
 *
 * Only a HOSTNAME-RESOLVED build needs this. A single-Event build already has
 * the right strings baked into `index.html` at build time, which is strictly
 * better — it is correct before the first byte of JavaScript runs, and it
 * survives a crash that never mounts React. A multi-Event bundle cannot have
 * them baked, because it does not know its Edition until `hostnames/{host}`
 * answers, so it repairs the DOM afterwards instead. Calling it on the
 * single-Event path is a harmless no-op that rewrites the identical string.
 *
 * The PWA manifest is deliberately NOT patched here. `name` / `short_name` are
 * read from the manifest FILE at install time, and rewriting it client-side
 * (blob URL, re-inserted <link rel="manifest">) is exactly the kind of cleverness
 * that strands an installed app with an identity no server can correct. A
 * hostname-resolved build gets its manifest from the edge Worker (#546).
 */
export function applyEditionDocumentIdentity(edition: string = activeEdition()): void {
  // Guarded because this module is imported by `vite.config.ts`, where there is
  // no DOM — and because it costs one comparison on a path that runs once.
  if (typeof document === 'undefined') return;
  const brand = editionBrand(edition);
  document.title = brand.documentTitle;
  // Absent rather than created when missing: index.html always ships the tag,
  // and injecting one here would hide its removal instead of surfacing it.
  document
    .querySelector('meta[name="apple-mobile-web-app-title"]')
    ?.setAttribute('content', brand.appName);
}
