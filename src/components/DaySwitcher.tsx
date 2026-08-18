import type { DayDef } from '../types';
import { THEMES } from '../theme/themes';
import { TutorialTag, tutorialTagLabel } from './TutorialBanner';
import { editionLexicon } from '../editions';

/**
 * Day switcher strip (daily-cards-spec § "Day switcher"): a one-row,
 * horizontally scrolling strip of ten compact Day pills — state glyph +
 * weekday + port emoji + theme emoji on a single line (#293) — above the
 * board area. Chip state is derived from `unlockAt` vs `now` rather than
 * tracked separately, so Board and this component share one notion of
 * "today" without either owning a clock subscription.
 */
export type DayChipState = 'past' | 'today' | 'locked';

/**
 * Classifies every Day against `now`: `unlockAt > now` is `'locked'`.
 * Among the unlocked Days, the one with the LATEST `unlockAt` still <= `now`
 * is `'today'` — the most recently opened Day, and the natural "where are
 * we" default; every earlier unlocked Day is `'past'`. Pure — no Day is
 * `'today'` before the Event has opened (every `unlockAt` is in the
 * future), which `defaultViewedIndex` below falls back from.
 */
export function dayStates(days: readonly DayDef[], now: number): DayChipState[] {
  let todayIndex = -1;
  let todayUnlockAt = -Infinity;
  days.forEach((d, i) => {
    if (d.unlockAt <= now && d.unlockAt > todayUnlockAt) {
      todayUnlockAt = d.unlockAt;
      todayIndex = i;
    }
  });
  return days.map((_, i) => (i === todayIndex ? 'today' : days[i].unlockAt > now ? 'locked' : 'past'));
}

/** The default viewed-Day index: today's Day, or Day 0 pre-Event-open. */
export function defaultViewedIndex(days: readonly DayDef[], now: number): number {
  const today = dayStates(days, now).indexOf('today');
  return today >= 0 ? today : 0;
}

/**
 * A ThemeId's emoji, tolerant of an unregistered id — the two Phase 1.5
 * tutorial themes (`welcome-aboard` / `so-long-farewell`) land their
 * `ThemeMeta` entries in #206, a ticket this one does not depend on, so a
 * Day naming one of them before #206 ships must still render a chip rather
 * than throw or blank out.
 */
function themeEmoji(themeId: string): string {
  return THEMES.find((t) => t.id === themeId)?.emoji ?? '🎉';
}

/** `date` is a plain ISO date ('YYYY-MM-DD'); anchor at UTC midnight so the
 * weekday never shifts with the viewer's own timezone offset. */
function weekday(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

const GLYPH: Record<DayChipState, string> = { past: '✓', today: '', locked: '🔒' };

/** The strip's accessible name (#608). Composed rather than overridden: the
 *  skeleton "{Occasion} days" survives all three registers intact — Cruise
 *  days / Trip days / Event days — which is exactly the case a token is for. */
function dayTabsLabel(): string {
  const { occasion } = editionLexicon();
  return `${occasion.charAt(0).toUpperCase()}${occasion.slice(1)} days`;
}

export interface DaySwitcherProps {
  days: readonly DayDef[];
  /** The currently VIEWED Day's index — not necessarily `'today'`. */
  viewedIndex: number;
  onSelect: (index: number) => void;
  /** Injectable for tests; defaults to the real clock. */
  now?: number;
  /**
   * Whether a modal scrim is up over the card right now (Board's
   * `overlayOpen`, #736). Board renders `daySwitcher` OUTSIDE `.board-area` —
   * above CoachOverlay/LaunchIntro, and from several early-return branches
   * with no overlay concept at all — so `overlayOpen` marking `.board-area`
   * `inert` never reached these chips: a keyboard user could Tab off a
   * dialog's CTA and switch Days behind the scrim. Threading it in here
   * instead of widening the `.board-area` boundary keeps every no-overlay
   * early-return branch (which never passes this prop true) unaffected.
   * Defaults to `false` so every other call site — including the early
   * returns above and the existing tests — stays exactly as tappable as
   * before.
   */
  inert?: boolean;
}

/**
 * States per chip: past (✓, tappable), today (filled, default-selected),
 * locked future (🔒, tappable — opens the locked-Day preview, never deals).
 * Every chip — locked included — just reports the tap via `onSelect`; this
 * component issues no writes and holds no board data, so a locked tap is
 * structurally a no-op beyond changing which Day is viewed.
 *
 * `inert` on the wrapper is the same platform primitive Board's `.board-area`
 * uses (drops the group from the tab order and the accessibility tree in one
 * attribute), but jsdom implements no `inert` behaviour — see Board.test.tsx
 * "board inert while an overlay is up" — and neither does
 * `@testing-library/user-event`'s focusable-element selector, which checks
 * `:disabled` but not `[inert]`. Each `<button>` is additionally given
 * `disabled` when `inert` is true so the "not focusable/clickable" guarantee
 * holds under jsdom too, not only in real browsers: disabled buttons drop out
 * of the tab order and (unlike a bare `inert` ancestor in jsdom) don't fire a
 * click.
 */
export default function DaySwitcher({
  days,
  viewedIndex,
  onSelect,
  now = Date.now(),
  inert = false,
}: DaySwitcherProps) {
  const states = dayStates(days, now);
  return (
    <div className="day-switcher" role="tablist" aria-label={dayTabsLabel()} inert={inert}>
      {days.map((d, i) => {
        const state = states[i];
        const selected = i === viewedIndex;
        return (
          <button
            key={d.index}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={`${weekday(d.date)} · ${d.place}${d.tutorial ? ` · ${tutorialTagLabel(d.pool)}` : ''}${state === 'locked' ? ' · locked' : ''}`}
            className={`day-chip day-chip-${state}${selected ? ' selected' : ''}`}
            disabled={inert}
            onClick={() => onSelect(i)}
          >
            {/* The state glyph PREFIXES the single-line pill (#293 — the
                wireframes' "✓ Wed 🇮🇹 ⚽" reading); today carries none. */}
            {state !== 'today' && (
              <span className="day-chip-glyph" aria-hidden="true">
                {GLYPH[state]}
              </span>
            )}
            <span className="day-chip-weekday">{weekday(d.date)}</span>
            <span className="day-chip-port" aria-hidden="true">
              {d.placeEmoji}
            </span>
            {/* An explicit per-Day emoji REPLACES the Theme's, it doesn't
                stack with it — a Day wears one emoji (#646). Post-#566 the
                chip reads the coerced `placeEmoji` (a live legacy `portEmoji`
                wins inside `migrateDayFields`, preserving the operator's 👋);
                a Day without any per-Day emoji keeps its Theme's, unchanged. */}
            {!d.placeEmoji && (
              <span className="day-chip-theme" aria-hidden="true">
                {themeEmoji(d.theme)}
              </span>
            )}
            {/* "Warm-up"/"Goodbye" in place of a daily-honor pin
                (daily-cards-spec § "Embark (tutorial) view") — the two
                tutorial Days only; #212 owns the honor pin the eight main
                Days show here. */}
            {d.tutorial && <TutorialTag pool={d.pool} className="day-chip-warm-up" />}
          </button>
        );
      })}
    </div>
  );
}
