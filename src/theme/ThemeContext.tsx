import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ThemeId } from '../types';
import { THEMES } from './themes';

const KEY = 'gcb.theme';
const DEFAULT: ThemeId = 'neon-playground';
// Excludes `chrome`-flagged Themes (#882, Codex P2 on #893) — this set gates
// what may become the ACTIVE applied theme (a saved localStorage pick, or an
// adopted Firestore playerTheme), not merely "is this id registered somewhere".
// `themesForEdition` already keeps a chrome Theme out of every picker's
// CHIPS, but neither localStorage nor a player's own Firestore doc goes
// through a picker — both are self-writable (ADR 0001's client-authoritative
// posture), so a stray `localStorage.setItem('gcb.theme', 'fiveacross-slate')`
// or a hand-written `players/{uid}.theme` would otherwise still validate as a
// "currently-known theme id" and get applied, contradicting the #882 contract
// that a chrome Theme is never player-wearable. THEMES itself stays complete
// (id->emoji/label lookups elsewhere are unaffected); only this gate narrows.
const PICKABLE_THEME_IDS = new Set<string>(THEMES.filter((t) => !t.chrome).map((t) => t.id));

/** Type guard: only a currently-known, PICKABLE (non-chrome) theme id may
 *  become the active applied ThemeId — see `PICKABLE_THEME_IDS` above. */
function isThemeId(value: string | null | undefined): value is ThemeId {
  return value != null && PICKABLE_THEME_IDS.has(value);
}

/** The locally-saved theme (localStorage) if it's still a valid id, else null. */
function savedTheme(): ThemeId | null {
  try {
    const saved = localStorage.getItem(KEY);
    if (isThemeId(saved)) return saved;
  } catch {
    /* ignore storage errors */
  }
  return null;
}

/**
 * A Player's theme PICK (daily-cards-spec § "More menu" — Theme row): either
 * a concrete `ThemeId`, or `'auto'` — "Auto: match the day", the new default.
 * `'auto'` is never itself persisted (see `setTheme` below), so a Player who
 * has never explicitly picked a theme (or who explicitly re-picks Auto)
 * always re-resolves against the current Day/event default on every load.
 */
export type ThemePreference = ThemeId | 'auto';

interface ThemeContextValue {
  /** The resolved, CONCRETE theme applied to `<html data-theme>` and CSS. */
  theme: ThemeId;
  /** What the Player picked — drives the ThemeSwitcher's active-chip highlight. */
  preference: ThemePreference;
  setTheme: (t: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT,
  preference: 'auto',
  setTheme: () => {},
});

export function ThemeProvider({
  children,
  defaultTheme = DEFAULT,
  playerTheme = null,
  autoThemeId = null,
}: {
  children: ReactNode;
  /** The event's admin-set default (main.tsx), used whenever Auto has no
   *  `autoThemeId` to resolve against — the same fallback role `defaultTheme`
   *  played pre-Auto (adopted live on every render, no separate "arrived
   *  async" effect needed since `theme` below is a pure derivation). Pure
   *  event/app fallback ONLY — never the Player's own pick (see
   *  `playerTheme`), so it can never outrank Auto's day-matching. */
  defaultTheme?: ThemeId;
  /** The Player's own explicit cross-device pick (Firestore `player.theme`,
   *  set via `savePlayerTheme` — main.tsx), arriving async after auth
   *  resolves. Adopted as the active preference once, on arrival, but ONLY
   *  when nothing more specific has already won: no local `gcb.theme`
   *  override on this device, and preference is still `'auto'` (no explicit
   *  in-session pick since mount). A concrete cross-device pick always
   *  outranks Auto's day-matching — see the effect below (Codex P2 on
   *  #232: `defaultTheme` used to carry this value and let `autoThemeId`
   *  silently override it as soon as a Day was current). */
  playerTheme?: ThemeId | null;
  /** Today's Day's ThemeId (daily-cards-spec § "More menu" Auto option),
   *  resolved by the caller from `EventDoc.days` (see `theme/autoTheme.ts`)
   *  so this Firestore-free module stays Firestore-free — mirrors how
   *  `defaultTheme` is already handed down precomputed. `null` before the
   *  Event doc has loaded, or with no Days configured. */
  autoThemeId?: ThemeId | null;
}) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => savedTheme() ?? 'auto');

  // Adopt the Player's cross-device explicit pick once it arrives from
  // Firestore, but only when preference is still 'auto' (no local override,
  // no explicit in-session pick already made) — see `playerTheme` above.
  useEffect(() => {
    if (!playerTheme) return;
    // A malformed/stale Firestore value (older data, since-removed theme id)
    // must not become the active `data-theme` — the previous async-default
    // path validated before applying, and this adopt effect needs the same
    // guard (Codex P3 on #232).
    if (!isThemeId(playerTheme)) return;
    if (savedTheme() !== null) return; // a local override already wins — never touch it
    setPreferenceState((prev) => (prev === 'auto' ? playerTheme : prev));
  }, [playerTheme]);

  // The resolved CSS theme: an explicit pick (local, cross-device, or
  // in-session) wins outright; 'auto' resolves to today's Day theme when
  // known, falling back to the event default while it isn't. A pure
  // derivation (not stored state), so it re-resolves on every render as
  // `autoThemeId`/`defaultTheme` arrive from Firestore.
  const theme: ThemeId = preference === 'auto' ? (autoThemeId ?? defaultTheme) : preference;

  // Apply the theme to the DOM for CSS. Deliberately does NOT persist here —
  // only an explicit concrete pick (setTheme below) is ever saved, so the
  // resolved auto/default value is never auto-saved.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((t: ThemePreference) => {
    if (t === 'auto') {
      // Picking Auto is itself never persisted — it un-saves any earlier
      // explicit pick so resolution re-derives from the Day/default on every
      // future load (daily-cards-spec § "More menu").
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore storage errors */
      }
      setPreferenceState('auto');
      return;
    }
    // Persist only explicit concrete choices, so the default is never auto-saved.
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* ignore storage errors */
    }
    setPreferenceState(t);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, preference, setTheme }}>{children}</ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
