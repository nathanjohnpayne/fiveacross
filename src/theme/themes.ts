import type { ThemeId } from '../types';

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

// The eight party themes, surfaced in the theme switcher. Descriptions track
// daily-cards-spec § "Theme reference", paraphrased where needed to keep the
// brand mark out of user-facing copy (PRD non-goal; see w1-themes guard test).
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
];

/**
 * Which Editions a Theme belongs to. Absent from this map = available
 * everywhere (the shared party Themes, which predate Editions).
 *
 * This exists so a Bodega Theme never turns up in the Gay Cruise Bingo picker,
 * and vice versa — the one-identity rule: after a player enters through an
 * Edition's hostname, the experience shows that Edition and nothing else.
 */
const THEME_EDITIONS: Partial<Record<ThemeId, readonly string[]>> = {
  'the-birds': ['vacay'],
  'side-quests': ['vacay'],
  'fog-froth-farewells': ['vacay'],
  // Gay Cruise Bingo's own tutorial Themes are cruise-specific content.
  'welcome-aboard': ['gcb'],
  'so-long-farewell': ['gcb'],
};

/**
 * The Themes a player may PICK on this Edition.
 *
 * Deliberately NOT a filter over the exported `THEMES`, which stays the
 * complete registry: four components (`Leaderboard`, `dayIdentity`,
 * `DaySwitcher`, `Board`) look a Theme up BY ID to render its emoji and label,
 * and narrowing the registry would silently turn those lookups into fallbacks.
 * Registry and pickable list are different things; only the latter is scoped.
 *
 * An unknown or absent Edition falls back to `gcb`, NOT to "shared only".
 * Edition is not resolved anywhere yet (that is #543's hostname lookup), so
 * every current caller passes nothing — and a "shared only" default would
 * silently drop `welcome-aboard` / `so-long-farewell` out of the Gay Cruise
 * Bingo picker the moment this lands. Defaulting to the legacy Edition keeps
 * today's production behaviour byte-identical and makes this change purely
 * additive until a caller starts passing a real Edition.
 */
export const DEFAULT_EDITION = 'gcb';

export function themesForEdition(edition?: string | null): ThemeMeta[] {
  const ed = edition || DEFAULT_EDITION;
  return THEMES.filter((t) => {
    const editions = THEME_EDITIONS[t.id];
    if (!editions) return true; // shared, pre-Edition Themes
    return editions.includes(ed);
  });
}
