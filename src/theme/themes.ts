import type { ThemeId } from '../types';
import { activeEdition, DEFAULT_EDITION } from '../editions';

// Edition IDENTITY lives in src/editions.ts, and only there (#580). This module
// used to keep its own `currentEdition` twin, seeded from the same env var but
// installed separately — so `bootstrapEventResolution`'s single
// `setActiveEdition` call rebranded the sign-in shell while every Theme picker
// kept serving the build-time Edition (split-brain). The re-exports below exist
// for this module's established import surface (w1-themes tests, future theme
// callers); they are aliases of the editions.ts state, never a second copy.
export { activeEdition, setActiveEdition, DEFAULT_EDITION } from '../editions';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  emoji: string;
  // Player-facing dress-code blurb (daily-cards-spec § "Theme reference"),
  // shown on the locked-day preview (the tease is the dress code, not just the
  // name) and available to the theme switcher for richness. Copy verbatim from
  // the spec table — do not paraphrase. #206 adds the two new tutorial-theme
  // entries (welcome-aboard / so-long-farewell) with their own descriptions.
  description: string;
}

// The complete Theme REGISTRY, across every Edition. Descriptions track
// daily-cards-spec § "Theme reference", paraphrased where needed to keep the
// brand mark out of user-facing copy (PRD non-goal; see w1-themes guard test).
//
// This list is NOT what any picker renders — see `themesForEdition` (#555). It
// must stay complete because `Leaderboard`, `dayIdentity`, `DaySwitcher` and
// `Board` look Themes up BY ID here, and the contrast suites iterate it.
export const THEMES: ThemeMeta[] = [
  {
    id: 'neon-playground',
    label: 'Neon Playground',
    emoji: '🌈',
    description:
      'Fast, flashy, bright, and silly. Neon, sparkles, and lights for a laser-lit night in the Red Room.',
  },
  {
    id: 'get-sporty',
    label: 'Get Sporty',
    emoji: '🏋️',
    description:
      'Locker-room fantasy, varsity realness, cheer-captain glam—sporty looks that leave very little to the imagination.',
  },
  {
    id: 'duty-free',
    label: 'Duty Free',
    emoji: '✈️',
    description:
      'No borders, no limits, no VAT. National colors, flags, or whatever you find in Duty Free.',
  },
  {
    id: 'glamiators',
    label: 'Glamiators',
    emoji: '🏛️',
    description:
      'Roman toga-chic meets runway excess. Ancient fantasy, body armor, and spectator/judge looks welcome.',
  },
  {
    id: 'summer-white',
    label: 'Summer White',
    emoji: '🤍',
    description:
      'The pinnacle white party—dress up or down in white for a sexy, creative, irreverent night under the stars.',
  },
  {
    id: 'dog-tag',
    label: 'Dog Tag T-Dance',
    emoji: '🪖',
    description:
      'The longest-running signature party, inspired by men in small uniforms. Souvenir dog tags provided.',
  },
  {
    id: 'revival-disco',
    label: 'Revival: Classic Disco',
    emoji: '🪩',
    description:
      "A '70s disco afternoon—artificial fabrics, facial hair, oversized shoes, obnoxious accessories.",
  },
  {
    id: 'seriously-pink',
    label: 'Seriously Pink T-Dance',
    emoji: '💖',
    description:
      'A hot afternoon of pink silliness, Barbie energy, and frivolous dolled-up fun.',
  },
  // Phase 1.5 tutorial-day themes (daily-cards-spec § "Theme reference",
  // issue #206). Appended after the eight party themes so no existing
  // THEMES index shifts; neon-playground stays first/default.
  {
    id: 'welcome-aboard',
    label: 'Welcome Aboard',
    emoji: '🛳️',
    description: 'You made it. Learn the game, find the soft-serve, wave goodbye to land.',
  },
  {
    id: 'so-long-farewell',
    label: 'So Long, Farewell',
    emoji: '👋',
    description: 'Last one. Mark your goodbyes—then go book next year.',
  },
  // Unified day themes (schedule correction 2026-07-17, daily-cards-spec
  // § "Theme reference"). Appended after the tutorial themes so no existing
  // THEMES index shifts; neon-playground stays first/default. Each folds a
  // day's two parties into one chrome identity — the two events live in
  // `DayDef.tonight`. Descriptions track the spec table, paraphrased where
  // needed to keep the brand mark out of user-facing copy (the w1-themes
  // "no Atlantis mark" guard, same non-goal that made summer-white ship as
  // "The pinnacle white party").
  {
    id: 'uniforms-without-borders',
    label: 'Uniforms Without Borders',
    emoji: '🌍',
    description:
      'Men in small uniforms meet no-borders-no-VAT—one night of international service.',
  },
  {
    id: 'neon-pink-playground',
    label: 'Neon Pink Playground',
    emoji: '💖',
    description:
      'Barbie energy by day, laser-lit neon by night—pink silliness straight into the Red Room.',
  },
  {
    id: 'sporty-splash',
    label: 'Sporty Splash',
    emoji: '💦',
    description:
      'Leave your phone in the cabin—water everywhere, then locker-room fantasy and varsity realness.',
  },
  {
    id: 'under-the-stars',
    label: 'Under the Stars',
    emoji: '🌌',
    description: 'No theme. Just dance. An open-deck night under the Mediterranean sky.',
  },
  {
    id: 'atlantis-classics',
    label: 'Dance Classics',
    emoji: '🏺',
    description:
      'Three decades of dance music—big anthems, diva voices, and classic sounds that still sound amazing today.',
  },
  // --- Bodega Bay Day themes (#555, Vacay edition) --------------------------
  {
    id: 'the-birds',
    label: 'The Birds Have Entered the Group Chat',
    emoji: '🐦',
    description:
      'Coastal suspense with the volume just slightly too high. Eggshell, ink black, sea green, and one restrained streak of warning red.',
  },
  {
    id: 'side-quests',
    label: 'Bodega Bay Side Quests',
    emoji: '🌊',
    description:
      'Take the detour. Deep Pacific blue, seafoam, fog white, and a buoy-orange flash on the horizon.',
  },
  {
    id: 'fog-froth-farewells',
    label: 'Fog, Froth & Farewells',
    // Fog, not coffee: the froth is the surf and the fog is what Bodega Bay is
    // actually known for. A cup read as coffee-shop rather than coastline.
    emoji: '🌫️',
    description:
      'The last slow morning. Fog silver, chowder cream, coffee brown, and dusk coral through the window.',
  },
  // --- Five Across themes (#617) --------------------------------------------
  // Occasion-neutral in the fiveacross register (#608): no place, no water, no
  // spatial metaphor — a conference hall, a wedding, and a birthday weekend all
  // have to read naturally in every line here. The arc is the shape any
  // gathering shares: doors open, the peak, the wind-down.
  {
    id: 'marquee',
    label: 'Marquee',
    emoji: '✨',
    description:
      'Lights up, doors open. Bulb-gold warmth and ticket red on deep black—big-night energy for any occasion.',
  },
  {
    id: 'confetti-hour',
    label: 'Confetti Hour',
    emoji: '🎊',
    description:
      'The peak of the celebration. Pink, teal, and gold popping on midnight blue.',
  },
  {
    id: 'afterglow',
    label: 'Afterglow',
    emoji: '🌙',
    description:
      'The slow, happy wind-down. Dusk violet, ember orange, and one warm last light.',
  },
];

const GCB: readonly string[] = [DEFAULT_EDITION];
const VACAY: readonly string[] = ['vacay'];
const FIVEACROSS: readonly string[] = ['fiveacross'];

/**
 * Which Editions each Theme may be PICKED on.
 *
 * This exists so a Bodega Theme never turns up in the Gay Cruise Bingo picker,
 * and vice versa — the one-identity rule: after a player enters through an
 * Edition's hostname, the experience shows that Edition and nothing else.
 *
 * TOTAL, not partial, and that is the point. The first cut typed this
 * `Partial<Record<...>>` and read "absent" as "shared by every Edition", which
 * made the scoping vacuous in the direction that mattered: the nine Atlantis
 * party Themes have no business on a Bodega weekend, and every one of them was
 * absent, so the Vacay picker would have opened with Dog Tag T-Dance in it
 * (Codex on #577). A total map turns that class of mistake into a compile
 * error — add a ThemeId without declaring its Editions and this object stops
 * type-checking. There is deliberately no "shared" escape hatch: if a Theme
 * ever genuinely belongs to both, it lists both.
 */
const THEME_EDITIONS: Record<ThemeId, readonly string[]> = {
  // Gay Cruise Bingo party Themes — Atlantis signature nights, cruise-specific
  // content down to the dress codes.
  'neon-playground': GCB,
  'get-sporty': GCB,
  'duty-free': GCB,
  glamiators: GCB,
  'summer-white': GCB,
  'dog-tag': GCB,
  'revival-disco': GCB,
  'seriously-pink': GCB,
  'uniforms-without-borders': GCB,
  'neon-pink-playground': GCB,
  'sporty-splash': GCB,
  'under-the-stars': GCB,
  'atlantis-classics': GCB,
  // Gay Cruise Bingo's own tutorial Themes — embark/disembark framing.
  'welcome-aboard': GCB,
  'so-long-farewell': GCB,
  // Bodega Bay (#555).
  'the-birds': VACAY,
  'side-quests': VACAY,
  'fog-froth-farewells': VACAY,
  // Five Across (#617).
  marquee: FIVEACROSS,
  'confetti-hour': FIVEACROSS,
  afterglow: FIVEACROSS,
};

/**
 * The Theme an Edition wears when nothing more specific has resolved.
 *
 * Last resort in the chain player pick → Event `defaultTheme` → **here**. It
 * matters most where the chain is shortest: the signed-out shell reads no Event
 * doc at all (`useEventDoc(false)`), so before #555 a Vacay build opened in Neon
 * Playground — Gay Cruise Bingo's skin on the one pre-auth surface ADR 0009 says
 * must be Edition-correct — and only changed after sign-in (Codex on #577). It
 * also covers an Event doc that simply has no `defaultTheme`.
 *
 * Bodega's is its Day 1 Theme, so the gate matches the first card. Five
 * Across's is Marquee — the doors-open Theme, so the gate reads as "an event
 * is about to happen" whatever the occasion is (#617).
 */
const EDITION_DEFAULT_THEME: Record<string, ThemeId> = {
  gcb: 'neon-playground',
  vacay: 'the-birds',
  fiveacross: 'marquee',
};

export function defaultThemeForEdition(edition: string = activeEdition()): ThemeId {
  // OWN property, not an inherited one — the exact twin of the `BRANDS` bug
  // (#597, fixed in `src/editions.ts` alongside this). This table is an object
  // literal too, so a plain `EDITION_DEFAULT_THEME[edition]` answers TRUTHY for
  // `constructor`, `toString` and friends, and the `??` fallback never fires:
  // the pre-auth shell would then set `[data-theme]` to a stringified function
  // and render unstyled. The Edition id comes from operator-authored routing
  // data, so this is reachable without a code change.
  //
  // `Object.prototype.hasOwnProperty.call`, not `Object.hasOwn`: ES2021 target.
  return Object.prototype.hasOwnProperty.call(EDITION_DEFAULT_THEME, edition)
    ? EDITION_DEFAULT_THEME[edition]!
    : EDITION_DEFAULT_THEME[DEFAULT_EDITION]!;
}

/**
 * The Themes a player or Admin may PICK on this Edition.
 *
 * Deliberately NOT a filter over the exported `THEMES`, which stays the
 * complete registry: four components (`Leaderboard`, `dayIdentity`,
 * `DaySwitcher`, `Board`) look a Theme up BY ID to render its emoji and label,
 * and narrowing the registry would silently turn those lookups into fallbacks.
 * Registry and pickable list are different things; only the latter is scoped.
 *
 * Every picker goes through here, admin ones included. Scoping only the player
 * switcher left the two admin controls (`GameSettings` Appearance and
 * `SchedulePanel`'s per-Day select) mapping the raw registry, so adding the
 * Bodega Themes would have offered 🐦 The Birds as a Mediterranean cruise's
 * `defaultTheme` (Codex on #577).
 *
 * An unknown Edition falls back to `gcb` rather than to an empty list: an
 * Edition string that nothing recognises should degrade to the legacy
 * experience, not to a picker with nothing in it.
 */
export function themesForEdition(edition?: string | null): ThemeMeta[] {
  const ed = edition || activeEdition();
  const known = THEMES.some((t) => THEME_EDITIONS[t.id].includes(ed));
  const scope = known ? ed : DEFAULT_EDITION;
  return THEMES.filter((t) => THEME_EDITIONS[t.id].includes(scope));
}

/**
 * `themesForEdition`, plus `keep` when that Theme is already SET but sits
 * outside this Edition.
 *
 * For controls that both display and change a stored Theme. A `<select>` whose
 * `value` matches no `<option>` falls back to rendering the first one, so a
 * plain scoped list would quietly show a Day as "Neon Playground" when it is
 * stored as something else — narrowing what may be picked must not misreport
 * what is set. The off-Edition entry leads the list so it is visible rather
 * than buried.
 */
export function themesForEditionIncluding(
  keep?: ThemeId | null,
  edition?: string | null,
): ThemeMeta[] {
  const list = themesForEdition(edition);
  if (!keep || list.some((t) => t.id === keep)) return list;
  const current = THEMES.find((t) => t.id === keep);
  return current ? [current, ...list] : list;
}
