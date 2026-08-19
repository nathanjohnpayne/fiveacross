/**
 * Day-Theme tokens for the daily engagement email (issue #616,
 * plans/daily-cards-wireframes.html § "Daily engagement email" →
 * `#fx-email-anatomy`).
 *
 * WHY A MIRROR, NOT AN IMPORT. The app owns two halves of a Theme's identity:
 * its label + emoji live in `src/theme/themes.ts` (a TS registry) and its
 * palette lives in `src/theme/themes.css` (CSS custom properties). The email
 * needs BOTH, as literal hex, in the functions package — and neither is
 * reachable: the two packages are deliberately decoupled (the same posture
 * `autohide.ts` keeps toward `moderation.ts` and `finaleContent.ts` toward
 * `src/game/logic.ts`), and a mail client cannot resolve a CSS variable anyway,
 * which the wireframe states as a binding constraint ("Theme tokens arrive as
 * literal hex on `bgcolor`/`style` attributes, never CSS variables").
 *
 * A mirror without a parity test is how mirrors drift, so
 * `tests/functions/daily-engagement-email.test.ts` parses BOTH app sources and
 * asserts this table matches them id-for-id and hex-for-hex. It is intended to
 * FAIL if a Theme is added, removed, or re-palettised on either side alone.
 *
 * Only the seven tokens the email actually paints with are mirrored. `--cell`,
 * `--border`, `--shadow` and `--on-gradient` are card-surface tokens with no
 * email module behind them, and `--border`/`--shadow` are `rgba()` besides,
 * which Outlook's Word renderer drops.
 */

/** The literal-hex subset of a Theme the email paints with, plus its identity. */
export interface EmailThemeTokens {
  /** `ThemeMeta.label` — the Theme header's headline. */
  label: string;
  /** `ThemeMeta.emoji` — rides the label; Theme identity survives every register. */
  emoji: string;
  /** `--bg` — the email canvas. */
  bg: string;
  /** `--panel` — every content module's own explicit background. */
  panel: string;
  /** `--ink` — body text on `panel`/`bg`. */
  ink: string;
  /** `--dim` — secondary text (context line, footer). */
  dim: string;
  /** `--primary` — the Theme header band and the CTA fill. */
  primary: string;
  /** `--secondary` — the header band's second gradient stop. */
  secondary: string;
  /** `--accent` — rank numerals and the award emphasis. */
  accent: string;
}

/**
 * Every Theme in the app registry, keyed by `ThemeId`. Kept in registry order
 * so a diff against `src/theme/themes.ts` reads straight down.
 */
export const EMAIL_THEME_TOKENS: Record<string, EmailThemeTokens> = {
  'neon-playground': { label: 'Neon Playground', emoji: '🌈', bg: '#07060d', panel: '#0e0a1a', ink: '#f6ecff', dim: '#b9a9d6', primary: '#ff2d95', secondary: '#00e6ff', accent: '#ffd23f' },
  'get-sporty': { label: 'Get Sporty', emoji: '🏋️', bg: '#0a0f0b', panel: '#0f1712', ink: '#f2fff4', dim: '#a9c8b3', primary: '#39ff88', secondary: '#eaffef', accent: '#ffe600' },
  'duty-free': { label: 'Duty Free', emoji: '✈️', bg: '#0a0e1a', panel: '#101827', ink: '#eef3ff', dim: '#a9b6d6', primary: '#ff4d5e', secondary: '#3aa0ff', accent: '#ffd23f' },
  glamiators: { label: 'Glamiators', emoji: '🏛️', bg: '#0c0a08', panel: '#16120c', ink: '#fff7e8', dim: '#cbb489', primary: '#e8c86a', secondary: '#c9a24a', accent: '#fffefb' },
  'summer-white': { label: 'Summer White', emoji: '🤍', bg: '#f6f1e7', panel: '#fffdf8', ink: '#20170f', dim: '#7a6a58', primary: '#8f600d', secondary: '#8a5c12', accent: '#20170f' },
  'dog-tag': { label: 'Dog Tag T-Dance', emoji: '🪖', bg: '#0c0e0a', panel: '#14170f', ink: '#eef2e6', dim: '#aeb69a', primary: '#b5c15a', secondary: '#8f9b8a', accent: '#ffd23f' },
  'revival-disco': { label: 'Revival: Classic Disco', emoji: '🪩', bg: '#120a14', panel: '#1b1020', ink: '#ffeede', dim: '#c9a7c0', primary: '#ff7a1a', secondary: '#c04bff', accent: '#ffd23f' },
  'seriously-pink': { label: 'Seriously Pink T-Dance', emoji: '💖', bg: '#1a0713', panel: '#260a1c', ink: '#ffe9f5', dim: '#e59bc4', primary: '#ff4fb0', secondary: '#ff9ed8', accent: '#fff06a' },
  'welcome-aboard': { label: 'Welcome Aboard', emoji: '🛳️', bg: '#051019', panel: '#0a1a28', ink: '#eaf6ff', dim: '#9fbcd0', primary: '#33c6ff', secondary: '#ffbe5c', accent: '#ffd23f' },
  'so-long-farewell': { label: 'So Long, Farewell', emoji: '👋', bg: '#140b12', panel: '#1e1019', ink: '#fff0ea', dim: '#d0a8ab', primary: '#ff8b6a', secondary: '#feb47b', accent: '#ffd23f' },
  'uniforms-without-borders': { label: 'Uniforms Without Borders', emoji: '🌍', bg: '#0a0d12', panel: '#12171f', ink: '#eef4f7', dim: '#a9b8ac', primary: '#b5c15a', secondary: '#3aa0ff', accent: '#ffd23f' },
  'neon-pink-playground': { label: 'Neon Pink Playground', emoji: '💖', bg: '#14061a', panel: '#1e0a26', ink: '#ffeafa', dim: '#e0a3d0', primary: '#ff4fb0', secondary: '#00e6ff', accent: '#fff06a' },
  'sporty-splash': { label: 'Sporty Splash', emoji: '💦', bg: '#04121a', panel: '#0a1c26', ink: '#eafaff', dim: '#9cc4d4', primary: '#33c6ff', secondary: '#39ff88', accent: '#ffe600' },
  'under-the-stars': { label: 'Under the Stars', emoji: '🌌', bg: '#070a18', panel: '#0d1224', ink: '#f2f2ff', dim: '#a9aed6', primary: '#ffd76a', secondary: '#8f7bff', accent: '#fffefb' },
  'atlantis-classics': { label: 'Dance Classics', emoji: '🏺', bg: '#0b0e10', panel: '#131a1c', ink: '#f6f1ea', dim: '#c0b3a2', primary: '#e2814d', secondary: '#2ec5b6', accent: '#ffd23f' },
  'the-birds': { label: 'The Birds Have Entered the Chat', emoji: '🐦', bg: '#0b0f0e', panel: '#151c19', ink: '#f2efe6', dim: '#a9b5ac', primary: '#6fbf9f', secondary: '#e07a6f', accent: '#e8d9a0' },
  'side-quests': { label: 'Bodega Bay Side Quests', emoji: '🌊', bg: '#041826', panel: '#082738', ink: '#eef7fb', dim: '#a3c3d4', primary: '#74e0c8', secondary: '#ff9d4d', accent: '#ffd98a' },
  'fog-froth-farewells': { label: 'Fog, Froth & Farewells', emoji: '🌫️', bg: '#efece4', panel: '#faf7ef', ink: '#33302b', dim: '#66625a', primary: '#8a5533', secondary: '#4f6b63', accent: '#a8462f' },
  marquee: { label: 'Marquee', emoji: '✨', bg: '#120d08', panel: '#1d1610', ink: '#f7f0e1', dim: '#b5a88e', primary: '#e8b64c', secondary: '#e2695a', accent: '#ffd98a' },
  'confetti-hour': { label: 'Confetti Hour', emoji: '🎊', bg: '#0d1020', panel: '#171b32', ink: '#f1f3fc', dim: '#aab1d6', primary: '#ff7eb6', secondary: '#5fe3cf', accent: '#ffd23f' },
  afterglow: { label: 'Afterglow', emoji: '🌙', bg: '#150f1c', panel: '#211830', ink: '#f5eef7', dim: '#b8aac6', primary: '#f09a6a', secondary: '#c583e0', accent: '#ffc98a' },
  // Five Across platform chrome (#882) — mirrored here for the same reason
  // every other Theme is: this table is a REGISTRY mirror, not a picker, so
  // it stays total against `THEMES` regardless of `ThemeMeta.chrome`. The
  // daily email is Day-scoped and no Day can ever carry this id (no picker
  // in the app offers it), so this row is exercised only by the parity
  // suite, not by a real send — but the parity test polices `THEMES`
  // unconditionally, and a real send is exactly the failure mode a silent
  // gap here would produce if that ever changed.
  'fiveacross-slate': { label: 'Slate', emoji: '🔹', bg: '#0f1116', panel: '#161a22', ink: '#f2f4f8', dim: '#9aa3b2', primary: '#718ef4', secondary: '#647be2', accent: '#f5b840' },
};

/**
 * The Theme each Edition falls back to when a Day's `theme` is missing or
 * unknown — a mirror of `EDITION_DEFAULT_THEME` in `src/theme/themes.ts`, held
 * to it by the same parity test as the token table.
 *
 * Deliberately the app's own per-Edition default rather than a neutral grey, or
 * a single global fallback: an email whose palette degrades to grey looks
 * broken, and one that degrades to `neon-playground` puts Gay Cruise Bingo's
 * skin on a Vacay or Five Across Event — another product's visual identity on a
 * degraded Day, which is exactly what the one-identity rule forbids (Codex #623
 * P2). Degrading to the Edition's OWN default just looks like a different Day.
 */
export const EDITION_FALLBACK_THEME: Record<string, string> = {
  gcb: 'neon-playground',
  vacay: 'the-birds',
  fiveacross: 'marquee',
};

/** The last-resort Theme: the app's `:root` Theme, and the legacy Edition's
 *  default. The only value guaranteed to exist — `:root` and
 *  `[data-theme='neon-playground']` share a block in `themes.css`. */
export const FALLBACK_EMAIL_THEME = 'neon-playground';

/** The fallback Theme id for one Edition. An unknown Edition degrades to the
 *  legacy one, the direction `setActiveEdition` degrades in the app. */
export function fallbackThemeForEdition(edition: string | undefined | null): string {
  if (edition && Object.prototype.hasOwnProperty.call(EDITION_FALLBACK_THEME, edition)) {
    return EDITION_FALLBACK_THEME[edition];
  }
  return FALLBACK_EMAIL_THEME;
}

/**
 * Tokens for one `ThemeId`, falling back to the EDITION's default Theme for an
 * unknown or absent id. An OWN-PROPERTY check rather than a bare index read: a
 * plain object inherits `Object.prototype`, so
 * `EMAIL_THEME_TOKENS['constructor']` is truthy and would sail past a `??`
 * guard as a "Theme" (the #597 class of bug). `hasOwnProperty.call` rather than
 * `Object.hasOwn` because this package targets ES2021.
 */
export function emailThemeTokens(
  themeId: string | undefined | null,
  edition?: string | null,
): EmailThemeTokens {
  if (themeId && Object.prototype.hasOwnProperty.call(EMAIL_THEME_TOKENS, themeId)) {
    return EMAIL_THEME_TOKENS[themeId];
  }
  return EMAIL_THEME_TOKENS[fallbackThemeForEdition(edition)] ?? EMAIL_THEME_TOKENS[FALLBACK_EMAIL_THEME];
}
