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
}

/**
 * States per chip: past (✓, tappable), today (filled, default-selected),
 * locked future (🔒, tappable — opens the locked-Day preview, never deals).
 * Every chip — locked included — just reports the tap via `onSelect`; this
 * component issues no writes and holds no board data, so a locked tap is
 * structurally a no-op beyond changing which Day is viewed.
 */
export default function DaySwitcher({ days, viewedIndex, onSelect, now = Date.now() }: DaySwitcherProps) {
  const states = dayStates(days, now);
  return (
    <div className="day-switcher" role="tablist" aria-label={dayTabsLabel()}>
      {days.map((d, i) => {
        const state = states[i];
        const selected = i === viewedIndex;
        return (
          <button
            key={d.index}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={`${weekday(d.date)} · ${d.port}${d.tutorial ? ` · ${tutorialTagLabel(d.pool)}` : ''}${state === 'locked' ? ' · locked' : ''}`}
            className={`day-chip day-chip-${state}${selected ? ' selected' : ''}`}
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
              {d.portEmoji}
            </span>
            <span className="day-chip-theme" aria-hidden="true">
              {themeEmoji(d.theme)}
            </span>
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
