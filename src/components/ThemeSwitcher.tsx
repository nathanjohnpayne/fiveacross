import { useTheme } from '../theme/ThemeContext';
import { themesForEditionIncluding } from '../theme/themes';
import { useAuth } from '../auth/AuthContext';
import { savePlayerTheme, clearPlayerTheme } from '../data/api';
import { track } from '../analytics';

/**
 * The Theme row's control (More menu § "Theme", daily-cards-spec § "More
 * menu"). Relocated from `Nav.tsx` into `More.tsx` by this ticket (#208).
 * Leads with the new **Auto—match the day** chip (the default, resolved by
 * `ThemeContext`'s `autoThemeId`), followed by every pickable Theme for this
 * Edition (`themesForEdition`, #555 — the registry is scoped for the PICKER
 * only, so a Bodega Theme never appears in a Gay Cruise Bingo switcher) in its
 * fixed order — new party themes still auto-pick up here for free, same as
 * before Auto existed (w1-themes.md's "auto-pickup" contract). A concrete
 * pick both saves locally (`ThemeContext.setTheme`) and cross-device
 * (`savePlayerTheme`); picking Auto saves neither — see `ThemeContext` for
 * why.
 */
export default function ThemeSwitcher() {
  const { preference, setTheme } = useTheme();
  const { user } = useAuth();
  return (
    <div className="themes" aria-label="Theme">
      <button
        className={'chip' + (preference === 'auto' ? ' active' : '')}
        onClick={() => {
          setTheme('auto');
          track('theme_change', { theme: 'auto' });
          // Un-save the cross-device pick too (Codex P2 on #232) — otherwise
          // ThemeProvider's playerTheme-adopt effect re-applies the old
          // concrete theme on the next load/device and Auto never sticks.
          if (user) clearPlayerTheme(user.uid).catch(() => {});
        }}
      >
        🧭 Auto—match the day
      </button>
      {/* `…Including(preference)` for the same reason the admin controls use it,
          and more urgently here: `ThemeContext` validates a saved pick against
          the whole REGISTRY, so an off-Edition preference is still APPLIED. A
          plain scoped list would leave the player wearing that skin with Auto
          inactive and no chip showing what is selected — a picker disagreeing
          with the screen it is on (Codex on #577). Kept rather than cleared:
          clearing is a destructive fix for a display bug, and a player who
          moves between Editions on one device would silently lose their pick.
          `preference` is `'auto'` or a ThemeId; `'auto'` matches no Theme. */}
      {themesForEditionIncluding(preference === 'auto' ? null : preference).map((t) => (
        <button
          key={t.id}
          className={'chip' + (preference === t.id ? ' active' : '')}
          onClick={() => {
            setTheme(t.id);
            track('theme_change', { theme: t.id });
            if (user) savePlayerTheme(user.uid, t.id).catch(() => {});
          }}
        >
          {t.emoji} {t.label}
        </button>
      ))}
    </div>
  );
}
