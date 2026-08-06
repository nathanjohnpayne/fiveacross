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

import type { EditionBrand, EditionLexicon } from './types';
export type { EditionBrand, EditionLexicon } from './types';

// An Edition is a dialect as well as a name. Token skeletons and whole-string
// overrides live in the table below; their shared shape lives in `src/types.ts`
// with the rest of the app's cross-consumer contracts.

export const DEFAULT_EDITION = 'gcb';

const BRANDS: Record<string, EditionBrand> = {
  gcb: {
    wordmark: 'GAY CRUISE BINGO',
    wordmarkBold: 'BINGO',
    preEventVerb: 'Sails',
    tagline: 'Trieste → Barcelona · July 2026. Sign in, get your card, mark it if you see it.',
    offlineNote: 'Lost signal at sea? The printed cards and PDF still work.',
    // Verbatim the strings index.html and the manifest hardcoded before #586,
    // so a `gcb` build is byte-identical to the shipped deployment.
    documentTitle: 'Gay Cruise Bingo',
    appName: 'Gay Cruise Bingo',
    appShortName: 'Gay Bingo',
    appDescription: 'Live multiplayer bingo for the high seas.',
    lexicon: {
      occasion: 'cruise',
      occasionWide: 'cruise-wide',
      place: 'port',
      placePlural: 'Ports',
      crowd: 'the whole boat',
      offlineWhy: 'at sea',
      shareMark: '🚢',
      fileSlug: 'gay-cruise-bingo',
    },
    passCheckLabel: 'Checking your cruise pass…',
    scheduleTitle: 'Cruise schedule',
    scheduleSub: 'Ports, parties, unlock times',
    walkthroughReplaySub: 'Replay the Welcome Aboard walkthrough',
    promptDeadlineNote:
      "Get your prompts in before we sail—once your card is dealt it's frozen, so a prompt added after that joins the pool for a future card, not yours.",
    tutorialWarmupNote: "This one's a warm-up—easy squares, all on the ship. The real chaos starts tomorrow at 8.",
    championRole: 'Cruise champion',
    podiumLabel: 'Cruise podium',
    reviewQueueAllClear: 'All clear. Go enjoy the boat.',
    bingoShareText: 'I got BINGO on the high seas 🚢',
    blackoutShareText: 'BLACKOUT. I win the boat. 🚢',
    updateToastMark: '🚢',
    updateToastTitle: 'A fresh build just docked',
    guidelinesScope: 'one sailing’s friend group',
  },
  vacay: {
    wordmark: 'VACAY BINGO',
    wordmarkBold: 'BINGO',
    // The platform endorsement line the wireframes draw under every in-app
    // Vacay wordmark (plans/daily-cards-wireframes.html, .hdr lockup). Only
    // vacay carries it: gcb predates the platform, fiveacross IS the platform.
    wordmarkByline: 'BY FIVE ACROSS',
    preEventVerb: 'Starts',
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
    lexicon: {
      occasion: 'trip',
      occasionWide: 'trip-wide',
      place: 'stop',
      placePlural: 'Stops',
      crowd: 'the whole group',
      offlineWhy: 'wherever you land',
      shareMark: '🗺️',
      fileSlug: 'vacay-bingo',
    },
    passCheckLabel: 'Checking your trip pass…',
    scheduleTitle: 'Trip schedule',
    scheduleSub: 'Stops, parties, unlock times',
    walkthroughReplaySub: 'Replay the welcome walkthrough',
    promptDeadlineNote:
      "Get your prompts in before we set off—once your card is dealt it's frozen, so a prompt added after that joins the pool for a future card, not yours.",
    tutorialWarmupNote: "This one's a warm-up—easy squares, close to home. The real chaos starts tomorrow at 8.",
    championRole: 'Trip champion',
    podiumLabel: 'Trip podium',
    reviewQueueAllClear: 'All clear. Go enjoy the trip.',
    bingoShareText: 'I got BINGO on this trip 🗺️',
    blackoutShareText: 'BLACKOUT. I win the trip. 🗺️',
    updateToastMark: '🗺️',
    updateToastTitle: 'A fresh build just landed',
    guidelinesScope: 'one trip’s friend group',
  },
  // Five Across (#599, fiveacross.app) — the OCCASION-NEUTRAL register. Minimal
  // camp, no water, no spatial metaphor: a conference hall, a wedding, a
  // birthday weekend all have to read naturally in it. Its offline story is the
  // STRONGEST of the three, not the weakest (#608): a few hundred phones on one
  // cell, behind concrete and structural steel, drops signal more reliably than
  // a ship does — congestion and physical barriers, which the player experiences
  // identically as "no bars".
  fiveacross: {
    wordmark: 'FIVE ACROSS',
    // "FIVE **ACROSS**" — the second word, matching how the other two Editions
    // bold their own last word (#602). The wordmark IS the mechanic here, so the
    // emphasis lands on the thing you are trying to get.
    wordmarkBold: 'ACROSS',
    // The general register's pre-event verb (#602 × #608). "Sails" is cruise
    // vocabulary and "Starts" is the trip Edition's; a conference, a wedding and
    // a birthday weekend all read naturally as "Opens Aug 7" — the doors-open
    // framing its default Theme (✨ Marquee, #617) already speaks.
    preEventVerb: 'Opens',
    tagline: 'Sign in, get your card, mark it if you see it.',
    offlineNote: 'Packed room, no bars? Your card keeps working offline — marks sync when you reconnect.',
    // Title case for the tab and the home-screen label, as above. "Five Across"
    // is 11 characters, so it survives Android's short_name truncation whole.
    documentTitle: 'Five Across',
    appName: 'Five Across',
    appShortName: 'Five Across',
    appDescription: 'Live multiplayer bingo for your group.',
    lexicon: {
      occasion: 'event',
      occasionWide: 'event-wide',
      place: 'place',
      placePlural: 'Places',
      crowd: 'everyone here',
      offlineWhy: 'in a packed venue',
      shareMark: '✳️',
      fileSlug: 'five-across',
    },
    passCheckLabel: 'Checking your pass…',
    scheduleTitle: 'Schedule',
    scheduleSub: 'Places, events, unlock times',
    walkthroughReplaySub: 'Replay the welcome walkthrough',
    promptDeadlineNote:
      "Get your prompts in before the first card is dealt—once your card is dealt it's frozen, so a prompt added after that joins the pool for a future card, not yours.",
    tutorialWarmupNote: "This one's a warm-up—easy squares to warm up. The real chaos starts tomorrow at 8.",
    championRole: 'Champion',
    podiumLabel: 'Final podium',
    reviewQueueAllClear: 'All clear. Go enjoy yourself.',
    bingoShareText: 'I got BINGO. ✳️',
    blackoutShareText: 'BLACKOUT. I win. ✳️',
    updateToastMark: '⬆️',
    updateToastTitle: 'A new version is ready',
    guidelinesScope: 'one event’s friend group',
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

/**
 * Is `edition` a real row in `BRANDS` — an OWN property, not an inherited one?
 *
 * `BRANDS` is an object literal, so it inherits `Object.prototype`, and a plain
 * `BRANDS[edition]` therefore answers for `constructor`, `toString`,
 * `valueOf`, `hasOwnProperty` and friends (#597). Every one of those is TRUTHY
 * and none of them is an `EditionBrand`, so the two lookups below would install
 * a function as the resolved Edition and hand `undefined` to every copy site —
 * a blank wordmark and a blank tagline on the sign-in gate — instead of falling
 * back to `gcb`. `hostnames/{host}.edition` is operator-authored data, so the
 * value reaching here is not under this module's control.
 *
 * `Object.prototype.hasOwnProperty.call`, not `Object.hasOwn`: this program
 * targets ES2021, where `Object.hasOwn` is not in `lib`.
 */
function isKnownEdition(edition: string | null | undefined): boolean {
  return typeof edition === 'string' && Object.prototype.hasOwnProperty.call(BRANDS, edition);
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
  return isKnownEdition(edition) ? BRANDS[edition]! : BRANDS[DEFAULT_EDITION]!;
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
 * Which Edition a BUILD may bake, from the two env vars (#586).
 *
 * This mirrors the runtime rule rather than restating it loosely. `VITE_EVENT_ID`'s
 * PRESENCE marks a single-Event build (ADR 0009 step 0), and only such a build
 * owns an Edition: a hostname-resolved bundle defers to
 * `hostnames/{host}.edition`, where an Edition-less mapping resets to the
 * default — which is exactly why `setActiveEdition('')` does the same. A
 * leftover `VITE_EDITION` in a multi-Event `.env.local` must therefore not bake
 * another product's name into a bundle every Event shares.
 *
 * The manifest is what makes this more than tidiness. The document title is
 * repairable after resolution; `name` / `short_name` are read from the manifest
 * FILE at install time, so a stale Edition baked there installs every Event on
 * that build under the wrong name, permanently, on the player's home screen.
 */
export function buildTimeEdition(
  envEventId: string | null | undefined,
  envEdition: string | null | undefined,
): string {
  if (!envEventId) return DEFAULT_EDITION;
  return envEdition || DEFAULT_EDITION;
}

/** The brand fields that are plain strings — i.e. the ones a static HTML
 *  placeholder could carry. `EditionBrand` gained a nested `lexicon` in #608, so
 *  a bare `keyof EditionBrand` would let a token be pointed at an OBJECT and
 *  stringify it into the tab title as `[object Object]`. Narrowing here makes
 *  that a compile error at the table below rather than a shipped defect. */
type EditionBrandTextField = {
  // `-?` keeps OPTIONAL fields (`wordmarkByline`) out of the union the same
  // way objects are kept out: `string | undefined` fails `extends string`, so
  // the field maps to `never` — and the modifier stops the optionality from
  // smuggling `undefined` itself into the resulting key union.
  [K in keyof EditionBrand]-?: EditionBrand[K] extends string ? K : never;
}[keyof EditionBrand];

/** The `index.html` placeholders, and the field each one carries. Adding a row
 *  here is the whole cost of branding a new static tag. */
const HTML_IDENTITY_TOKENS: Record<string, EditionBrandTextField> = {
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
