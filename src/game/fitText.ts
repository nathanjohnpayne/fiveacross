/**
 * The measure-and-shrink primitive behind the Square auto-fit guard
 * (`specs/d15-text-size.md`, daily-cards-spec § "More menu" item 3). No
 * `fitText`-style utility existed anywhere in this codebase before this
 * ticket (#215) — this is a from-scratch design, not a port of an existing
 * print-card routine.
 *
 * Deliberately a PURE, DOM-free estimator rather than a real canvas
 * `measureText`/DOM-layout loop: `Board.tsx` calls this with a box already
 * measured from the live DOM (`getBoundingClientRect`), and this file stays
 * unit-testable in plain Node/jsdom with no canvas or real text-layout
 * dependency. The greedy word-wrap estimate below mirrors `.cell`'s own
 * `word-break: break-word` CSS closely enough for a shrink guard: it does
 * not need to be typographically exact, only MONOTONIC — smaller font size
 * must never estimate a taller block than a larger one did — which a
 * straightforward average-character-width model guarantees.
 */

export interface FitTextBox {
  /** Usable width in px — the caller subtracts the cell's own padding. */
  width: number;
  /** Usable height in px — the caller subtracts the cell's own padding. */
  height: number;
}

export interface FitTextOptions {
  /** The starting/ceiling font size in px — the S/M/L pick's CSS-resolved
   *  size (already viewport-clamped by `index.css`). The guard only ever
   *  shrinks from here; it never grows past it ("Large is a ceiling, never
   *  an overflow", daily-cards-spec § "More menu"). */
  baseSize: number;
  /** The smallest size the guard will fall back to when even that doesn't
   *  fit — a floor so a pathological prompt never shrinks to unreadable
   *  or zero/negative px. Default 6. */
  minSize?: number;
  /** Average glyph width as a fraction of font size, used to estimate how
   *  many characters fit on one line. `.cell`'s type is a bold condensed
   *  face, so 0.55 approximates it closely enough for a monotonic shrink
   *  decision without needing real glyph metrics. */
  charWidthRatio?: number;
  /** Line-height multiplier converting an estimated line count into a
   *  block height — matches `.cell`'s own `line-height: 1.05`. */
  lineHeight?: number;
  /** The font-size step (px) the guard decrements by per iteration. */
  step?: number;
}

const DEFAULT_MIN_SIZE = 6;
const DEFAULT_CHAR_WIDTH_RATIO = 0.55;
const DEFAULT_LINE_HEIGHT = 1.05;
const DEFAULT_STEP = 0.5;

/**
 * Greedy word-wrap estimate: how many lines does `text` take at `fontSize`
 * once wrapped to `width`, given `charWidthRatio`? A single word longer
 * than one full line wraps mid-word (mirroring `.cell`'s `word-break:
 * break-word`), consuming `ceil(word.length / charsPerLine)` lines on its
 * own rather than overflowing sideways. `wordsStayWhole` reports whether
 * that never happened — every word fit on one line — which `fitTextSize`
 * requires of a size before accepting it (#1345). A whitespace-free run in a
 * script whose normal CSS line breaking falls BETWEEN its characters
 * (ideographs, kana, Hangul, and the dictionary-broken Southeast Asian
 * scripts) is not a word that must stay whole: wrapping it is a legal break,
 * so it never clears `wordsStayWhole`.
 */
const INTRA_WORD_BREAK_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function estimateLineCount(
  text: string,
  width: number,
  fontSize: number,
  charWidthRatio: number,
): { lines: number; wordsStayWhole: boolean } {
  const charWidth = fontSize * charWidthRatio;
  if (charWidth <= 0 || width <= 0) return { lines: 1, wordsStayWhole: true };
  const charsPerLine = Math.max(1, Math.floor(width / charWidth));
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: 1, wordsStayWhole: true };

  let lines = 1;
  let lineLen = 0;
  let wordsStayWhole = true;
  for (const word of words) {
    if (word.length > charsPerLine) {
      if (!INTRA_WORD_BREAK_SCRIPTS.test(word)) wordsStayWhole = false;
      if (lineLen > 0) {
        lines += 1;
        lineLen = 0;
      }
      lines += Math.ceil(word.length / charsPerLine) - 1;
      lineLen = word.length % charsPerLine || charsPerLine;
      continue;
    }
    const nextLen = lineLen === 0 ? word.length : lineLen + 1 + word.length;
    if (nextLen > charsPerLine) {
      lines += 1;
      lineLen = word.length;
    } else {
      lineLen = nextLen;
    }
  }
  return { lines, wordsStayWhole };
}

/**
 * Returns the largest font size (px), at or below `options.baseSize`, that
 * fits `text` inside `box` per the estimator above — the auto-fit guard's
 * always-wins rule (daily-cards-spec § "More menu" item 3). A short string
 * that already fits at `baseSize` returns `baseSize` UNSHRUNK; an oversized
 * one steps down by `options.step` until it fits or bottoms out at
 * `options.minSize`, whichever comes first. A size only fits when the block
 * is short enough AND no single word has to break across lines (#1345): the
 * guard keeps shrinking past a mid-word break ("Grandparent / s") and only
 * accepts one when even the floor cannot hold the longest word. `text` with no content, or a
 * box with no usable area (mirrors `Board.tsx`'s not-yet-laid-out guard —
 * `getBoundingClientRect` reports 0x0 before first paint), never shrinks:
 * there is nothing to measure against yet, so the ceiling wins by default.
 */
export function fitTextSize(text: string, box: FitTextBox, options: FitTextOptions): number {
  const {
    baseSize,
    minSize = DEFAULT_MIN_SIZE,
    charWidthRatio = DEFAULT_CHAR_WIDTH_RATIO,
    lineHeight = DEFAULT_LINE_HEIGHT,
    step = DEFAULT_STEP,
  } = options;

  if (!text.trim() || box.width <= 0 || box.height <= 0 || baseSize <= 0) return baseSize;

  const floor = Math.min(minSize, baseSize);
  for (let size = baseSize; size >= floor; size -= step) {
    const { lines, wordsStayWhole } = estimateLineCount(text, box.width, size, charWidthRatio);
    const blockHeight = lines * size * lineHeight;
    if (wordsStayWhole && blockHeight <= box.height) return size;
  }
  return floor;
}

/**
 * Second pass against the REAL rendered glyphs (#1345). `fitTextSize` models
 * glyph width with a flat average, which is only an approximation of whatever
 * face the browser actually resolved (a headless Linux fallback face runs
 * wider than the bold condensed face the estimate assumes), so a word the
 * estimate says fits can still break. The caller supplies `overflows(size)`,
 * which applies `size`, lays the text out with mid-word breaking disabled and
 * reports whether any word is wider than the box; this steps down from
 * `startSize` by `step` until it reports false, bottoming out at `minSize`
 * (default 6px) — and never raising `startSize` itself if that is already
 * below the floor. Pure of any DOM so it is unit-testable.
 */
export function shrinkToWholeWords(
  startSize: number,
  overflows: (size: number) => boolean,
  options: { minSize?: number; step?: number } = {},
): number {
  const { minSize = DEFAULT_MIN_SIZE, step = DEFAULT_STEP } = options;
  const floor = Math.min(minSize, startSize);
  for (let size = startSize; size >= floor; size -= step) {
    if (!overflows(size)) return size;
  }
  return floor;
}
