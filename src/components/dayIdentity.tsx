import { isoDateInTz } from '../data/tzDate';
import { editionBrand } from '../editions';
import { THEMES } from '../theme/themes';
import type { EventDoc } from '../types';
import { defaultViewedIndex } from './DaySwitcher';

/**
 * The header's two "where are we" lines (daily-cards-spec § "Header"): always
 * TODAY's port and theme — the header is a "where are we" instrument; the
 * board chrome communicates the *viewed* Day, which the header never follows.
 *
 * "Today" mid-cruise is the latest UNLOCKED Day — the SAME notion the day
 * switcher and the Auto theme use (`dayStates`/`defaultViewedIndex` in
 * `./DaySwitcher`, `todaysDayTheme` in `theme/autoTheme.ts`) — so the header
 * and the board's default Day roll to a new port together at the 08:00 unlock.
 * Resolving this calendar-based instead made the header lead the board by up to
 * eight hours on a port morning (00:00 → the card's 08:00 unlock): the header
 * named the new port while the board still showed yesterday's locked Day, which
 * read as a header/board mismatch. The pre-cruise "Sails …" and post-cruise
 * "Until next year" boundaries stay calendar-based in the EVENT timezone — the
 * embark Day is unlocked from event open (`unlockAt: 0`), so an unlock-based
 * boundary could never surface the pre-cruise countdown.
 *
 * States, per the spec:
 *   pre-cruise  → "⚓ Sails Jul 15" / the embark Day's theme line
 *   during      → "🇭🇷 Split"       / "🏋️ Get Sporty" (today's unlocked Day)
 *   post-cruise → "Barcelona"      / "👋 Until next year"
 *
 * The pre-event VERB is Edition brand copy, not Event data (#602): "Sails" on
 * the cruise Edition, "Starts" on a house event — `EditionBrand.preEventVerb`.
 * The pre-event GLYPH is too (#881, `EditionBrand.preEventGlyph`): "⚓" reads
 * as cruise-specific decoration, so vacay and fiveacross carry their own
 * rather than inheriting gcb's anchor. Retiring the rest of the nautical
 * vocabulary is epic #535's job.
 *
 * Firestore-free like `theme/autoTheme.ts`, so the states are unit-testable
 * across clocks without mounting Nav. Clock-pure, Edition-scoped: the one
 * non-argument input is the resolved Edition (via `editionBrand()`), which
 * tests drive with `setActiveEdition` exactly as the sign-in gate's do.
 */
export interface DayIdentity {
  place: string;
  theme: string;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-07-15' -> 'Jul 15'; null for a malformed date (caller degrades). */
function shortDate(iso: string): string | null {
  const [y, m, d] = String(iso ?? '')
    .split('-')
    .map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || m < 1 || m > 12 || d < 1 || d > 31) {
    return null;
  }
  return `${SHORT_MONTHS[m - 1]} ${d}`;
}

/** ThemeId -> "🏋️ Get Sporty"; falls back to the raw id for an unknown theme. */
function themeLine(themeId: string): string {
  const meta = THEMES.find((t) => t.id === themeId);
  return meta ? `${meta.emoji} ${meta.label}` : themeId;
}

// Re-exported from its pure home in `data/tzDate.ts`, so the setup-wizard
// launch gates can share the exact conversion this header uses without
// importing a React module. Every existing importer keeps working unchanged.
export { isoDateInTz };

/**
 * Presentational (hook-free, so renderToStaticMarkup-testable without the
 * Firebase-backed hooks Nav mounts): the two stacked header lines. Before the
 * Event doc arrives (or signed out) it renders the original placeholder
 * dashes, aria-hidden so they are not announced.
 */
export function DayIdentityLines({ identity }: { identity: DayIdentity | null }) {
  if (!identity) {
    return (
      <div className="day-identity" aria-hidden="true">
        <span className="day-identity-line day-identity-place">—</span>
        <span className="day-identity-line day-identity-theme">—</span>
      </div>
    );
  }
  return (
    <div className="day-identity">
      <span className="day-identity-line day-identity-place">{identity.place}</span>
      <span className="day-identity-line day-identity-theme">{identity.theme}</span>
    </div>
  );
}

export function headerDayIdentity(
  event: Pick<EventDoc, 'days' | 'timezone'> | null | undefined,
  now: number = Date.now(),
): DayIdentity | null {
  const days = event?.days;
  if (!days || days.length === 0) return null;
  const ordered = [...days].filter((d) => typeof d.date === 'string' && d.date !== '').sort((a, b) => a.index - b.index);
  if (ordered.length === 0) return null;
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const today = isoDateInTz(now, event?.timezone || 'Europe/Rome');
  if (today < first.date) {
    const start = shortDate(first.date);
    const brand = editionBrand();
    return {
      // #881: the place line carried no glyph pre-cruise, against a theme
      // line that always has one (`themeLine` below) — `preEventGlyph`
      // closes that gap. Edition-scoped, same as `preEventVerb` itself
      // (Codex P2, PR #896 round 1): a universal ⚓ read as cruise-specific
      // decoration leaking into vacay/fiveacross, the same class of bug the
      // no-cruise-noun sweep (#608) already guards other shared strings
      // against.
      place: start ? `${brand.preEventGlyph} ${brand.preEventVerb} ${start}` : `${first.placeEmoji} ${first.place}`.trim(),
      theme: themeLine(first.theme),
    };
  }
  if (today > last.date) {
    // Spec copy is the bare port ("Barcelona"), no flag — the cruise is over.
    return { place: last.place, theme: '👋 Until next year' };
  }
  // Mid-cruise: name the latest UNLOCKED Day, delegating "which Day is today"
  // to the day switcher's `defaultViewedIndex` so the header and the board's
  // default Day are guaranteed to name the same port — they roll over together
  // at the 08:00 unlock instead of the header leading from calendar midnight.
  // `defaultViewedIndex` is >= 0 here (the embark Day's `unlockAt: 0` is always
  // unlocked), so the `?? first` is only a defensive fallback.
  const current = ordered[defaultViewedIndex(ordered, now)] ?? first;
  return { place: `${current.placeEmoji} ${current.place}`.trim(), theme: themeLine(current.theme) };
}
