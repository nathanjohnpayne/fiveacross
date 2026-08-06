// Small, framework-free presentational formatters. Pure + unit-tested so
// components can render event metadata without re-deriving the shape inline.

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Format an Event's sail window as a compact human range:
 *   '2026-07-15', '2026-07-24' -> 'July 15–24, 2026'
 * Collapses a shared month (day–day) or a shared year (Mon d – Mon d, year),
 * and uses an en dash for the range per typographic convention.
 *
 * The ISO 'YYYY-MM-DD' parts are parsed directly rather than via `new Date()`:
 * `new Date('2026-07-15')` is parsed as UTC midnight and renders as the 14th in
 * negative-offset zones, so a naive parse would shift the displayed day.
 */
export function formatSailRange(sailStart: string, sailEnd: string): string {
  const parse = (s: string) => {
    const [y, m, d] = String(s ?? '')
      .split('-')
      .map(Number);
    return { y, m, d };
  };
  const a = parse(sailStart);
  const b = parse(sailEnd);
  // Degrade to no range (rather than throw / render a broken title) for a missing,
  // malformed, or impossible date, or a reversed window — a partial or hand-edited
  // Event doc must never crash the board, and the write rules don't validate
  // sailStart/sailEnd. `Date.UTC` is used ONLY to reject impossible calendar dates
  // (e.g. 2026-02-31, 2026-13-01) via a round-trip check; the range itself is still
  // formatted from the parsed integer parts so no timezone can shift a displayed day.
  const validCalendar = (p: { y: number; m: number; d: number }) => {
    if (![p.y, p.m, p.d].every(Number.isInteger)) return false;
    const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
    return dt.getUTCFullYear() === p.y && dt.getUTCMonth() === p.m - 1 && dt.getUTCDate() === p.d;
  };
  const key = (p: { y: number; m: number; d: number }) => p.y * 10000 + p.m * 100 + p.d;
  if (!validCalendar(a) || !validCalendar(b) || key(b) < key(a)) return '';
  const mA = MONTHS[a.m - 1];
  const mB = MONTHS[b.m - 1];

  if (a.y === b.y && a.m === b.m) {
    // A single-day sailing reads as a plain date, not a "15–15" range.
    return a.d === b.d ? `${mA} ${a.d}, ${a.y}` : `${mA} ${a.d}–${b.d}, ${a.y}`;
  }
  if (a.y === b.y) return `${mA} ${a.d} – ${mB} ${b.d}, ${a.y}`;
  return `${mA} ${a.d}, ${a.y} – ${mB} ${b.d}, ${b.y}`;
}

/**
 * The card's title line: the Event name joined to its sail range with an em
 * dash (no surrounding spaces), e.g.
 *   'Atlantis Med—Trieste to Barcelona' + dates
 *     -> 'Atlantis Med—Trieste to Barcelona—July 15–24, 2026'.
 * The `.card-meta` style uppercases it for display.
 */
export function eventTitle(name: string, sailStart: string, sailEnd: string): string {
  const range = formatSailRange(sailStart, sailEnd);
  return range ? `${name}—${range}` : name;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The compact sail window for tight chrome (#270 — the More menu's version
 * footer): 'Jul 15–24' within one month, 'Jul 15 – Aug 2' across months.
 * Degrades to '' on a malformed/reversed window (the footer just omits it).
 */
export function shortSailRange(sailStart: string, sailEnd: string): string {
  const parse = (v: string) => {
    const [y, m, d] = String(v ?? '').split('-').map(Number);
    if (!Number.isFinite(y) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    // Round-trip through Date to reject impossible calendar dates
    // (e.g. Feb 30 — Date would roll it over; #281 P3).
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? { y, m, d } : null;
  };
  const a = parse(sailStart);
  const b = parse(sailEnd);
  if (!a || !b || new Date(b.y, b.m - 1, b.d) < new Date(a.y, a.m - 1, a.d)) return '';
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${SHORT_MONTHS[a.m - 1]} ${a.d}`;
  if (a.y === b.y && a.m === b.m) return `${SHORT_MONTHS[a.m - 1]} ${a.d}\u2013${b.d}`;
  return `${SHORT_MONTHS[a.m - 1]} ${a.d} \u2013 ${SHORT_MONTHS[b.m - 1]} ${b.d}`;
}

/** One run of `segmentEmojiRuns` output: a maximal stretch of consecutive
 *  grapheme clusters that are either all emoji or all non-emoji. */
export interface EmojiRun {
  text: string;
  emoji: boolean;
}

/**
 * Grapheme clusters that need emoji-run isolation (#603). A cluster counts
 * when it contains an Extended_Pictographic code point (the emoji set proper,
 * incl. ZWJ-sequence members), a Regional Indicator (flag pairs), or a keycap
 * combiner. Over-matching a text-presentation pictograph is harmless — the
 * wrapper span renders identically on-page — while under-matching leaves a
 * glyph in a shared text run where html-to-image's raster pass can
 * mis-measure it.
 */
const EMOJI_CLUSTER = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;

/**
 * Split `text` into maximal emoji / non-emoji runs (#603).
 *
 * Why: html-to-image rasterizes through an SVG `<foreignObject>`, and that
 * pass can shape an emoji differently from the live document (observed in
 * desktop Chrome: the re-measured run wraps or the glyph paints displaced,
 * overlapping neighbouring characters — the "Day 4 🌊alletta" defect). Text
 * that may carry emoji therefore renders each emoji run in its own
 * `display: inline-block` element (`.emoji-run`): the raster clone freezes
 * that box at its live size, so however the raster pass shapes the glyph it
 * stays inside its own box and cannot displace the surrounding text.
 *
 * Grapheme segmentation (Intl.Segmenter) keeps flags and ZWJ sequences whole;
 * consecutive emoji clusters merge into one run so a flag never splits across
 * elements. In an environment without Intl.Segmenter the text is returned as
 * a single non-emoji run — the pre-#603 behavior, never a crash.
 */
/** The slice of Intl.Segmenter this module uses. Local because the project's
 *  `lib: ES2021` predates the built-in typings (they land in ES2022); every
 *  supported runtime (browsers, Node 22, jsdom) ships the real API and the
 *  code degrades to a single run when it is absent. */
type GraphemeSegmenter = new (
  locale?: string,
  options?: { granularity: 'grapheme' },
) => { segment(input: string): Iterable<{ segment: string }> };

export function segmentEmojiRuns(text: string): EmojiRun[] {
  if (!text) return [];
  const Segmenter = (Intl as { Segmenter?: GraphemeSegmenter }).Segmenter;
  if (typeof Segmenter !== 'function' || !EMOJI_CLUSTER.test(text)) {
    return [{ text, emoji: false }];
  }
  const runs: EmojiRun[] = [];
  for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const emoji = EMOJI_CLUSTER.test(segment);
    const last = runs[runs.length - 1];
    if (last && last.emoji === emoji) last.text += segment;
    else runs.push({ text: segment, emoji });
  }
  return runs;
}
