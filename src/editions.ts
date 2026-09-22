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
// `index.html` from `VITE_EDITION` (#586). It is loaded there by esbuild in a
// plain Node context, where `import.meta.env` does not exist and neither does
// `document`. Keep this module free of BOTH at module scope — a top-level read
// of either aborts Vite config loading (with a bare "Cannot read properties of
// undefined") before the build even starts. Reading them inside a function is
// fine: the config only ever calls `editionBrand` with an explicit Edition id.
//
// EDGE CONSUMER: the Worker's manifest route (#546) needs the same brand rows,
// and its TypeScript program has neither `vite/client` nor a DOM lib, so it
// cannot compile the two reads above at all. That is why the table itself now
// lives in `edition-brands.ts` and this module re-exports it: one table, three
// programs, and the split is enforced by the compilers rather than by a note.
// The `index.html` placeholder table, and the build-time substitution over it,
// left for `html-head-identity.ts` on the same terms in #1118, because the
// edge Worker now rewrites those same tags per hostname and its program cannot
// compile this module either.

import type { EditionBrand, EditionLexicon } from './types';
import { EDITION_IDS } from './edition-registry.ts';
// Re-exported rather than moved-and-updated-everywhere: `vite.config.ts` and
// `src/editions.test.ts` both reach for it here, and the function is still
// this module's story (the build-time half of Edition chrome) even though the
// table it iterates is now shared with the edge.
export { brandHtmlIdentity } from './html-head-identity';
// The chrome colour and the tag it lands in, for the runtime repair below.
// Imported rather than restated so the DOM repair, the edge rewrite and the
// manifest cannot drift apart.
import { THEME_COLOR_SELECTOR, themeColorFor } from './html-head-identity';
// The brand TABLE itself lives in a DOM-free, `import.meta`-free sibling so the
// edge Worker can read the same rows (#546); everything below is the part that
// needs a runtime. Re-exported here so no import site had to move.
import { brandFor, DEFAULT_EDITION, isKnownEdition } from './edition-brands';
export type { EditionBrand, EditionLexicon } from './types';
export { DEFAULT_EDITION } from './edition-brands';

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
  currentEdition = isKnownEdition(edition) ? edition! : DEFAULT_EDITION;
}

/** Brand copy for the active Edition (or an explicit one, for tests).
 *
 *  `vite.config.ts` calls this at build time and MUST pass the id explicitly:
 *  the default argument resolves through `activeEdition()`, which reads
 *  `import.meta.env` and therefore only works in the app. */
export function editionBrand(edition: string = activeEdition()): EditionBrand {
  return brandFor(edition);
}

/** The active Edition's vocabulary (#608) — the token layer. Whole-string
 *  overrides come off `editionBrand()` instead; see `EditionLexicon`. */
export function editionLexicon(edition: string = activeEdition()): EditionLexicon {
  return editionBrand(edition).lexicon;
}

/**
 * The header wordmark split for display (#602): everything before the bold
 * suffix, and the suffix itself — `Nav.tsx` renders `lead<b>bold</b>`. Derived
 * from `wordmark` rather than stored as two fields so the gate's wordmark and
 * the header's can never drift apart. When `wordmarkBold` is not actually a
 * suffix of `wordmark`, the whole wordmark comes back as `lead` with an empty
 * `bold`: the failure mode is a missing font weight, never missing or
 * duplicated words.
 */
export function wordmarkSegments(brand: EditionBrand = editionBrand()): {
  lead: string;
  bold: string;
} {
  const { wordmark, wordmarkBold } = brand;
  return wordmarkBold && wordmark.endsWith(wordmarkBold)
    ? { lead: wordmark.slice(0, wordmark.length - wordmarkBold.length), bold: wordmarkBold }
    : { lead: wordmark, bold: '' };
}

/**
 * Which Edition a BUILD may bake, from the runtime env vars and optional
 * trusted target-registry fallback (#586/#851).
 *
 * This mirrors the runtime rule rather than restating it loosely. A non-empty
 * `VITE_EVENT_ID` marks a single-Event build (ADR 0009 step 0), and such a build
 * owns its `VITE_EDITION`: a hostname-resolved bundle defers to
 * `hostnames/{host}.edition`, where an Edition-less mapping resets to the
 * default — which is exactly why `setActiveEdition('')` does the same. A named
 * target may separately preserve a trusted static fallback for the static HTML
 * identity and the manifest a host serves before the Worker's routes are
 * attached — the edge rewrites the crawler-facing `<head>` per host (#1118)
 * and answers the manifest per host (#546), but only once it is in the
 * request path at all, which is a human cutover. A leftover
 * `VITE_EDITION` in a multi-Event `.env.local` must still not bake another
 * product's name into a bundle every Event shares.
 *
 * The manifest is what makes this more than tidiness. The document title is
 * repairable after resolution; `name` / `short_name` are read from the manifest
 * FILE at install time, so a stale Edition baked there installs every Event on
 * that build under the wrong name, permanently, on the player's home screen.
 */
export function buildTimeEdition(
  envEventId: string | null | undefined,
  envEdition: string | null | undefined,
  staticFallbackEdition?: string | null,
): string {
  if (!envEventId) return staticFallbackEdition || DEFAULT_EDITION;
  return envEdition || DEFAULT_EDITION;
}

/**
 * The alternate Namespace apex an Edition owns beyond the canonical
 * `fiveacross.app` Namespace every Event is reachable in (CONTEXT.md §
 * Namespace: "Every Event is reachable in the Five Across namespace; an
 * Edition may own a second one"). `null` means exactly that — no second
 * one — which is the common case, not an omission: `fiveacross` IS the
 * canonical Namespace, so a Five Across-Edition occasion (Wedding,
 * Conference) has no distinct alternate to claim.
 *
 * This is the table `specs/event-setup-wizard.md` names as deliberately
 * ABSENT from the occasion matrix ("the alternate is an Edition fact
 * resolved at Steps 2 and 5, #790/#793") — the setup wizard's address step
 * (#790) previews it, and the launch provisioner (#793) claims it
 * atomically alongside the canonical hostname. Kept here, keyed by Edition
 * rather than by occasion, so both consumers read the same one-row-per-
 * Edition fact instead of re-deriving it from whichever occasion happened
 * to bind that Edition.
 *
 * **`gcb` maps to `null`, and that is a correction rather than an omission**
 * (Codex, PR #911). An earlier version mapped it to `gaycruisebingo.com` on
 * the reasoning that the fact is true of the Edition regardless of whether the
 * wizard can reach it — but it is not true: a Namespace is an apex whose
 * WILDCARD subdomains address Events, and `gaycruisebingo.com` is Gay Cruise
 * Bingo's own site, not a wildcard Namespace. `CONTEXT.md` § Namespace names
 * exactly two (`fiveacross.app`, `vacaybingo.com`) and `worker/src/host.ts`'s
 * `NAMESPACES` guard admits exactly those two, so `<slug>.gaycruisebingo.com`
 * is refused as `out-of-namespace` before its hostname document is ever read.
 *
 * The cost of getting this wrong rose with this PR. While the alternate was
 * only PREVIEWED, a wrong row printed an address that would not work. Now that
 * availability is checked against every previewed address and the alternate is
 * a guarantee (owner ruling, 2026-08-19), a wrong row would BLOCK a GCB
 * occasion on an address that can never serve. Add a row here only when
 * wildcard serving for that apex actually lands.
 */
/**
 * The canonical Namespace every Event is reachable in, regardless of Edition
 * (CONTEXT.md § Namespace). Lives here beside {@link alternateNamespaceApex}
 * rather than in the wizard step that renders it, because the data layer needs
 * the same fact to check availability and the launch provisioner (#793) needs
 * it to claim — three consumers reading one constant instead of each carrying
 * their own copy of a string that must never disagree.
 */
export const CANONICAL_NAMESPACE_APEX = 'fiveacross.app';

// `null`-prototype so a lookup cannot reach Object.prototype (Phase 4b P2,
// PR #911). As an ordinary object literal, `ALTERNATE_NAMESPACE_APEX['constructor']`
// returned the Function constructor and `['toString']` a function — both
// truthy, so `?? null` never fired and an unrecognized Edition id could yield
// a nonsense "apex" that the wizard would preview, check and hand the launch
// provisioner. Edition ids reach this table from imported and hand-edited
// drafts, so "unrecognized" is not a hypothetical input class.
const ALTERNATE_NAMESPACE_APEX: Partial<Record<string, string>> = Object.assign(Object.create(null), {
  [EDITION_IDS.VACAY_BINGO]: 'vacaybingo.com',
});

/** `null` when `edition` owns no alternate Namespace — see
 *  `ALTERNATE_NAMESPACE_APEX`. */
export function alternateNamespaceApex(edition: string): string | null {
  const apex = ALTERNATE_NAMESPACE_APEX[edition];
  return typeof apex === 'string' ? apex : null;
}

/**
 * Put the Edition on the browser chrome: the tab, the label iOS offers when
 * someone adds the app to their home screen, and the colour the browser
 * paints its chrome and splash with.
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
 * hostname-resolved build gets its manifest from the edge Worker instead
 * (#546, `worker/src/manifest.ts`) — once its routes are attached, which is a
 * human cutover rather than something this build can arrange.
 *
 * Those two tags are the two the EDGE deliberately leaves alone (#1118,
 * `RUNTIME_REPAIRED_TOKENS` in `html-head-identity.ts`). The edge rewrites the
 * crawler-facing block because a crawler runs no JavaScript and nothing here
 * can reach it; adding a second writer for a surface this function already
 * corrects would buy nothing and could disagree with it.
 *
 * `<meta name="theme-color">` is the one tag both surfaces write, and it needs
 * both. A crawler reads it without running JavaScript, so only the edge can
 * correct it there. But an INSTALLED shell serves its navigations from the
 * precached `index.html` through the service worker's `NavigationRoute`, so
 * the proxied response the edge rewrites never reaches it: after a hostname is
 * repointed to another Edition, that shell would keep painting the previous
 * Edition's chrome while the manifest it re-reads and the app it opens into
 * both moved — the per-Edition equality `specs/w1-pwa.md` requires, broken on
 * the one surface no deploy can fix. Both writers take the colour from
 * `themeColorFor`, so the equality holds by construction rather than because
 * two call sites were kept in step.
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
  document.querySelector(THEME_COLOR_SELECTOR)?.setAttribute('content', themeColorFor(brand));
}
