// The Edition brand table — the pure half of `src/editions.ts` (#546).
//
// Split out so a program with NO DOM and NO `import.meta` can read it.
// `editions.ts` carries the session's resolved-Edition state, the lazy
// `import.meta.env` seed and the `document`-touching chrome repair; the
// Cloudflare Worker's TypeScript program (`worker/tsconfig.json`,
// `lib: ["ES2022"]`, no `vite/client`) can compile none of that, and the edge
// manifest route needs exactly the rows below. Everything here is a plain
// value or a pure function of its arguments, so a Node build script, a browser
// bundle and a workerd program can all load it.
//
// `editions.ts` re-exports what it used to own, so no existing import site
// moves. Add brand COPY here; add anything that reads a runtime — an env var,
// a global, a DOM node — to `editions.ts` instead.

import type { EditionBrand } from './types';
// Extensionless, unlike `editions.ts`'s import of the same module: the Worker's
// TypeScript program does not enable `allowImportingTsExtensions`, and this
// module is now in it.
import {
  assertEditionRegistryParity,
  EDITION_IDS,
  isRegisteredEdition,
} from './edition-registry';
import type { EditionId } from './edition-registry';

// An Edition is a dialect as well as a name. Token skeletons and whole-string
// overrides live in the table below; their shared shape lives in `src/types.ts`
// with the rest of the app's cross-consumer contracts.

export const DEFAULT_EDITION = EDITION_IDS.GAY_CRUISE_BINGO;

const BRANDS: Record<EditionId, EditionBrand> = {
  [EDITION_IDS.GAY_CRUISE_BINGO]: {
    wordmark: 'GAY CRUISE BINGO',
    wordmarkBold: 'BINGO',
    // The platform endorsement line, carried here since #688. It is an
    // ENDORSEMENT, not a rename: the wordmark, the cruise vocabulary, the
    // adult posture, gaycruisebingo.com and the legacy Firebase project are
    // all unchanged — GCB is simply one Edition of Five Across now, on the
    // same engine as Vacay, and under the Phase 7 native plan the store
    // binary a GCB player installs is literally named Five Across. See the
    // scoping note on `wordmarkByline` in the vacay row below.
    wordmarkByline: 'BY FIVE ACROSS',
    preEventVerb: 'Sails',
    // #881: the pre-event header line's glyph — cruise-appropriate here,
    // unlike a universal anchor (Codex P2, PR #896 round 1; see the field's
    // own note).
    preEventGlyph: '⚓',
    tagline: 'Sign in, get your card, mark it if you see it.',
    // The Join-frame voice chip and the gate's fixed postage mark (#881: "a
    // treatment only one brand receives reads as an accident" — vacay had
    // both, gcb and fiveacross had neither). ADDITIVE, not vacay's replacing
    // kind (Codex P2, PR #896 round 1): the gcb Join frame keeps its own
    // plain tagline line right below this chip, so `signinVoiceChip` is the
    // field, not `signinTaglineChip` (see the type's own note on why they're
    // separate fields). The rainbow flag doesn't repeat anything else the
    // gcb Join frame draws.
    signinVoiceChip: 'What happens at sea. Goes on the card.',
    signinStampGlyph: '🏳️‍🌈',
    // #881: this note is specifically ADR 0006's ROUTINE-dead-zone promise
    // (a Player loses signal for a few minutes, the app itself keeps
    // working) — all three Editions now state that same mechanic in the same
    // words, varying only the opener. It is NOT the total-failure fallback;
    // that stayed real (the printed cards and PDF genuinely exist per the
    // launch-accepted PRD/spec — Codex P2, PR #896 round 2 caught the first
    // cut conflating the two and silently dropping the crash panel's
    // fallback message along with this one), and now lives in its own
    // field below.
    offlineNote: 'Lost signal at sea? Your card keeps working offline—marks sync when you reconnect.',
    // The crash panel's fallback (`ErrorBoundary.tsx`), read instead of
    // `offlineNote` above: `specs/x-launch-checklist.md` § "Printed 12-card
    // PDF fallback" accepts the printed cards and PDF as the answer
    // specifically for "the app itself is broken and can't be fixed in
    // time" — a real, documented, pre-existing artifact (the PRD's own
    // words: "already exist"), and gcb is the one Edition with that printed
    // tradition to point to.
    crashFallbackNote: "If the app won't recover, the printed cards and PDF still work.",
    // Verbatim the strings index.html and the manifest hardcoded before #586,
    // so a `gcb` build is byte-identical to the shipped deployment.
    documentTitle: 'Gay Cruise Bingo',
    appName: 'Gay Cruise Bingo',
    appShortName: 'Gay Bingo',
    appDescription: 'Live multiplayer bingo for the high seas.',
    // Verbatim the share block index.html hardcoded before #587: the flagship
    // unfurl's wording does not change, only its delivery. The artwork DID
    // change — og-gcb.png is the #609 render (1200×630), superseding the
    // 2400×1260 og-default.png.
    metaDescription: 'Live multiplayer bingo for the high seas. Trieste to Barcelona, July 2026.',
    ogUrl: 'https://gaycruisebingo.com/',
    ogImage: 'https://gaycruisebingo.web.app/og-gcb.png',
    ogImageAlt:
      'Gay Cruise Bingo—a marked-up live multiplayer bingo card for the July 2026 sailing, Trieste to Barcelona',
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
    tutorialWarmupNote: "This one's a warm-up—easy squares, all on the ship.",
    championRole: 'Cruise champion',
    podiumLabel: 'Cruise podium',
    reviewQueueAllClear: 'All clear. Go enjoy the boat.',
    bingoShareText: 'I got BINGO on the high seas 🚢',
    blackoutShareText: 'BLACKOUT. I win the boat. 🚢',
    updateToastMark: '🚢',
    updateToastTitle: 'A fresh build just docked',
    guidelinesScope: 'one sailing’s friend group',
  },
  [EDITION_IDS.VACAY_BINGO]: {
    wordmark: 'VACAY BINGO',
    wordmarkBold: 'BINGO',
    // The platform endorsement line the wireframes draw under every in-app
    // Edition wordmark (plans/daily-cards-wireframes.html, .hdr lockup). Every
    // Edition OF the platform carries it — vacay from #647, gcb from #688.
    // Only `fiveacross` goes without: it IS the platform, so endorsing itself
    // would be noise.
    wordmarkByline: 'BY FIVE ACROSS',
    preEventVerb: 'Starts',
    // #881: this Edition's own pre-event glyph — its share mark, not gcb's
    // anchor (Codex P2, PR #896 round 1; nautical decoration does not belong
    // on the trip register either).
    preEventGlyph: '🧳',
    tagline: 'Sign in, get your card, mark it if you see it.',
    // The Join-frame voice pieces (#647, wireframes § "Join—the postcard, not
    // the casino"). This chip REPLACES the plain tagline on the signed-out
    // gate — vacay's frame draws no separate tagline line under it. gcb and
    // fiveacross carry their own voice chip too (#881), but ADDITIVE: their
    // frames keep the plain tagline right below it, so they use the
    // separate `signinVoiceChip` field, not this one (see that field's own
    // note for why "replace" and "add" are not the same field with a flag).
    // The invite note and the postcard's dashed-stamp treatment stay
    // vacay-only, since its postage is the current Day's own emoji rather
    // than a fixed brand mark (see `signinStampGlyph` for the fixed kind).
    signinTaglineChip: 'Take the detour. For the story.',
    signinInviteNote:
      'Prompts are invitations, not chores. Take the fun detour, share the story if you want—five across earns a BINGO.',
    signinCardVariant: 'postcard',
    offlineNote: 'Patchy signal? Your card keeps working offline—marks sync when you reconnect.',
    // Title case, not the caps wordmark: these render as a browser tab and a
    // home-screen label, not as the gate's display type. "Vacay Bingo" is 11
    // characters, so it survives Android's short_name truncation whole and
    // needs no shortened variant.
    documentTitle: 'Vacay Bingo',
    appName: 'Vacay Bingo',
    appShortName: 'Vacay Bingo',
    appDescription: 'Live multiplayer bingo for the trip.',
    metaDescription: 'Live multiplayer bingo for the trip.',
    // The Event canonical host, not either Vacay alias: og:url is the one tag
    // whose per-Event truth the edge HTML rewrite will own (#1118) — see the
    // field note on `EditionBrand.ogUrl`.
    ogUrl: 'https://bodega-bay.fiveacross.app/',
    // Served by the fiveacross project (ADR 0008), which hosts every Five
    // Across Edition — vacaybingo.com hostnames included.
    ogImage: 'https://fiveacross.web.app/og-vacay.png',
    ogImageAlt: 'Vacay Bingo—a marked-up live multiplayer bingo card for the trip',
    lexicon: {
      occasion: 'trip',
      occasionWide: 'trip-wide',
      place: 'stop',
      placePlural: 'Stops',
      crowd: 'the whole group',
      offlineWhy: 'wherever you land',
      shareMark: '🧳',
      fileSlug: 'vacay-bingo',
    },
    passCheckLabel: 'Checking your trip pass…',
    scheduleTitle: 'Trip schedule',
    scheduleSub: 'Stops, parties, unlock times',
    walkthroughReplaySub: 'Replay the welcome walkthrough',
    promptDeadlineNote:
      "Get your prompts in before we set off—once your card is dealt it's frozen, so a prompt added after that joins the pool for a future card, not yours.",
    tutorialWarmupNote: "This one's a warm-up—easy squares, close to home.",
    championRole: 'Trip champion',
    podiumLabel: 'Trip podium',
    reviewQueueAllClear: 'All clear. Go enjoy the trip.',
    bingoShareText: 'I got BINGO on this trip 🧳',
    blackoutShareText: 'BLACKOUT. I win the trip. 🧳',
    updateToastMark: '🧳',
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
  [EDITION_IDS.FIVE_ACROSS]: {
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
    // #881: a plain calendar mark, not gcb's anchor (Codex P2, PR #896
    // round 1) — functional, not decorative, matching this Edition's own
    // "no lead-in emoji, functional emoji only" voice (see the Join caption).
    preEventGlyph: '📅',
    tagline: 'Sign in, get your card, mark it if you see it.',
    // Same Join-frame voice-chip-plus-postage treatment as gcb (#881),
    // additive rather than replacing (see gcb's own note above). The postage
    // is fiveacross's own share mark, not the wedding-bell the wireframe's
    // sample happens to render (Codex P2, PR #896 round 1): this Edition is
    // occasion-neutral, so a wedding glyph baked into the brand table would
    // leak onto every OTHER occasion this same Edition equally supports (a
    // conference, a birthday) — the sample's identity, not the brand's.
    signinVoiceChip: 'Bring everyone. Into the game.',
    signinStampGlyph: '✳️',
    offlineNote: 'Packed room, no bars? Your card keeps working offline—marks sync when you reconnect.',
    // Title case for the tab and the home-screen label, as above. "Five Across"
    // is 11 characters, so it survives Android's short_name truncation whole.
    documentTitle: 'Five Across',
    appName: 'Five Across',
    appShortName: 'Five Across',
    appDescription: 'Live multiplayer bingo for your group.',
    metaDescription: 'Live multiplayer bingo for your group.',
    ogUrl: 'https://fiveacross.app/',
    ogImage: 'https://fiveacross.web.app/og-fiveacross.png',
    ogImageAlt: 'Five Across—a marked-up live multiplayer bingo card',
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
    tutorialWarmupNote: "This one's a warm-up—easy squares to warm up.",
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

// The EditionId-backed Record catches TypeScript drift; this runtime parity
// check also catches a new ID added to edition-registry.ts without a matching
// BRANDS change, before a lookup could silently fall back to GCB.
assertEditionRegistryParity(Object.keys(BRANDS));

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
export function isKnownEdition(edition: string | null | undefined): edition is EditionId {
  return isRegisteredEdition(edition) && Object.prototype.hasOwnProperty.call(BRANDS, edition);
}

/**
 * Brand copy for one Edition id — TOTAL, so every caller gets a real row.
 *
 * An absent, non-string or unrecognised id resolves to {@link DEFAULT_EDITION}
 * rather than to `undefined`, which is the SAME rule the app's own resolution
 * path follows: `hostnames/{host}` coerces a non-string `edition` to `''`
 * (`src/data/hostnames.ts`) and `setActiveEdition('')` then resets to the
 * default. Edge and client must not disagree even about the fallback — a
 * hostname whose document names an Edition this build has never heard of has
 * to install under the same name in both places, or one player's home screen
 * ends up branded differently from the app they open from it.
 */
export function brandFor(edition: string | null | undefined): EditionBrand {
  return isKnownEdition(edition) ? BRANDS[edition]! : BRANDS[DEFAULT_EDITION]!;
}
