import { useLayoutEffect, useRef, useState } from 'react';
import { useTextSize } from '../hooks/useTextSize';
import { fitTextSize, shrinkToWholeWords } from '../game/fitText';

type InsetKey =
  | 'paddingLeft'
  | 'paddingRight'
  | 'paddingTop'
  | 'paddingBottom'
  | 'borderLeftWidth'
  | 'borderRightWidth'
  | 'borderTopWidth'
  | 'borderBottomWidth';

/**
 * #1345: verify the estimate against the real rendered glyphs and keep
 * shrinking while any single word is wider than the Square (which `.cell`'s
 * `word-break: break-word` would otherwise split mid-word, "Grandparent / s").
 * Each probe applies the size with mid-word breaking and hyphenation switched
 * off, so a too-long word makes the span (a flex item) as wide as that word
 * instead of wrapping; its width then exceeds the host's usable (content-box)
 * width. Both sides are compared as fractional layout widths
 * (`getBoundingClientRect` minus the host's computed padding and border), not
 * the integer-rounded `offsetWidth`/`clientWidth`, so a word only a fraction
 * of a pixel too wide is still caught.
 *
 * When the accepted size keeps every word whole the overrides STAY on the
 * span: restoring `.cell`'s `hyphens: auto` / `word-break: break-word` would
 * let the browser hyphenate or split a word that fits on its own line just to
 * fill a preceding line. They are removed only when even `minSize` cannot hold
 * the longest word, where `.cell`'s mid-word breaking is the last-resort
 * fallback.
 *
 * The probe starts from `heightBound` — the estimator's height-only fit, which
 * does not reject a size for a word the flat average glyph width merely
 * GUESSES is too wide — so real measurement decides the whole-word question:
 * a token of narrow glyphs, or one that may wrap after a hyphen, keeps the
 * largest size it actually fits at. Each probe also checks the rendered
 * block's HEIGHT against the host's usable height, so the real line breaks
 * (not the estimator's guess at them) decide whether the block fits and
 * nothing is clipped. A host with no layout yet (width 0,
 * pre-first-paint or jsdom) has nothing to measure against, so the
 * whole-word `estimated` size stands with the overrides off.
 */
function keepWordsWhole(el: HTMLElement, host: HTMLElement, estimated: number, heightBound: number): number {
  clearWholeWordOverrides(el);
  const hostStyle = window.getComputedStyle(host);
  const inset = (keys: readonly InsetKey[]) => keys.reduce((sum, key) => sum + (parseFloat(hostStyle[key]) || 0), 0);
  const hostRect = host.getBoundingClientRect();
  const usableWidth = hostRect.width - inset(['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']);
  const usableHeight = hostRect.height - inset(['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']);
  if (!(usableWidth > 0)) return estimated;
  el.style.wordBreak = 'normal';
  el.style.overflowWrap = 'normal';
  el.style.hyphens = 'manual';
  // Layout sizes are multiples of 1/64px, so any real overflow clears this
  // tolerance; it only absorbs float noise in the subtractions above.
  const EPSILON = 0.005;
  const rectAt = (size: number) => {
    el.style.fontSize = `${size}px`;
    return el.getBoundingClientRect();
  };
  const tooWide = (rect: DOMRect) => rect.width > usableWidth + EPSILON;
  // The rendered block must also fit the height: the estimator's line count
  // is only an approximation of where the browser actually breaks (e.g. a
  // compound that may only wrap at its hyphens), and `.cell` clips overflow.
  const tooTall = (rect: DOMRect) => usableHeight > 0 && rect.height > usableHeight + EPSILON;
  const fitted = shrinkToWholeWords(heightBound, (size) => {
    const rect = rectAt(size);
    return tooWide(rect) || tooTall(rect);
  });
  if (tooWide(rectAt(fitted))) clearWholeWordOverrides(el);
  return fitted;
}

function clearWholeWordOverrides(el: HTMLElement) {
  el.style.wordBreak = '';
  el.style.overflowWrap = '';
  el.style.hyphens = '';
}

/**
 * A non-free Square's prompt text (#215, specs/d15-text-size.md): the S/M/L
 * auto-fit guard that always wins over the chosen base size. `.cell`'s own
 * `font-size` (index.css, `clamp(...) * var(--text-scale)`) is the CEILING
 * this reads via `getComputedStyle` — the Player's S/M/L pick, already
 * viewport-clamped by CSS — never the floor: this span's own inline
 * `font-size` is what a Square actually renders text at, and it only ever
 * shrinks that ceiling down, never grows past it ("Large is a ceiling,
 * never an overflow"). Re-measures whenever the prompt text or the live
 * `textSize` pick changes (a pick applies `data-text-size` to `<html>`
 * SYNCHRONOUSLY inside `useTextSize`'s `setState`, ahead of the React
 * notify, so the CSS custom property has already updated by the time this
 * effect re-runs and re-reads the computed ceiling). A cell not yet laid
 * out (`getBoundingClientRect` reporting 0x0 pre-first-paint) is left at
 * the unshrunk ceiling — `fitTextSize` itself treats a zero-area box as
 * "nothing to measure against yet" — so a Square never flashes at a
 * shrunk size before its real box is known.
 *
 * Extracted from Board (#434) so the read-only CachedCardFallback can reuse
 * the SAME fitting guard rather than rendering a bare span that would clip a
 * long prompt at the Large text setting — Firebase-free deps only, so it stays
 * out of the fallback's (and this module's) import graph.
 */
export default function SquareText({ text }: { text: string }) {
  // Not read directly below — its only job is to make this effect re-run
  // when the Player's S/M/L pick changes, since the ceiling itself is read
  // from the DOM (getComputedStyle), not from this hook's return value.
  const [textSize] = useTextSize();
  const ref = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    // The box this text has to fit inside. On the live Board that is the
    // Square's full-bleed claim <button> (which spans the tile inside its
    // border); on the read-only CachedCardFallback the span is still a direct
    // child of `.cell`. Both carry the same 4px padding, so the measurement
    // below holds for either host.
    const host = el?.parentElement;
    if (!el || !host) return;

    // Applies the fitted size directly to the DOM every time this runs,
    // independent of React state — `setFontSize` alone isn't enough: two
    // different prompts can both bottom out at the same fitted number (PR
    // #237 Codex finding), and React bails out of re-rendering (and thus
    // re-applying the `style` prop) when a state update doesn't change the
    // value. Writing `el.style.fontSize` imperatively here guarantees the
    // shrink is always (re)applied, whether or not the number moved.
    const measure = () => {
      // Reset to the CSS-computed ceiling before measuring — a shrink
      // applied for a PREVIOUS (longer) prompt or a PREVIOUS (larger) cell
      // size must never cap this one's ceiling.
      el.style.fontSize = '';
      const baseSize = parseFloat(window.getComputedStyle(el).fontSize);
      if (!Number.isFinite(baseSize) || baseSize <= 0) return;
      const hostRect = host.getBoundingClientRect();
      // The host's 4px padding on every side (index.css: `.cell` and
      // `.cell-claim` both set it) — the usable box the text actually has to
      // fit inside is the host minus that padding.
      const HOST_PADDING = 8;
      const box = {
        width: Math.max(0, hostRect.width - HOST_PADDING),
        height: Math.max(0, hostRect.height - HOST_PADDING),
      };
      const estimated = fitTextSize(text, box, { baseSize });
      const heightBound = fitTextSize(text, box, { baseSize, keepWordsWhole: false });
      const fitted = keepWordsWhole(el, host, estimated, heightBound);
      el.style.fontSize = `${fitted}px`;
      setFontSize(fitted);
    };

    measure();

    // Recompute on any cell-size change (phone rotation, split-screen,
    // desktop resize, sidebar toggling the grid's column count, etc.) — PR
    // #237 Codex finding: without this, an already-mounted Square keeps the
    // font size fitted to its OLD box until `text` or the S/M/L pick next
    // changes, so a prompt that fit at the old width can overflow or clip
    // at a narrower one. ResizeObserver is unavailable in some older/jsdom
    // test environments, so this is a best-effort enhancement, not a hard
    // dependency of the guard (the effect above still fits on mount/change).
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(host);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textSize only retriggers the DOM re-read above; see the doc comment.
  }, [text, textSize]);

  return (
    <span ref={ref} className="cell-text" style={fontSize != null ? { fontSize: `${fontSize}px` } : undefined}>
      {text}
    </span>
  );
}
