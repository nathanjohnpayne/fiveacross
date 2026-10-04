import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import SquareText from './SquareText';

// #1345: the Square fit guard verifies the estimate against the real rendered
// glyphs and keeps shrinking while a word is wider than the box. jsdom has no
// layout, so the cell box, the CSS ceiling, the host's padding and the
// rendered width of the text are stubbed: the span's fractional
// `getBoundingClientRect().width` is what the longest word would measure at
// the applied font size WHEN mid-word breaking is switched off (the probe the
// guard runs), `realCharEm` em per character — wider than the estimator's 0.55
// default, the way a fallback face runs wider than the condensed face.
const CELL = 70; // px, the Square; the guard subtracts its 4px padding per side
const HOST_PADDING_PX = 4;
const USABLE = CELL - 2 * HOST_PADDING_PX;
const CEILING_PX = 12;
const REAL_CHAR_EM = 0.6;

function rect(width: number): DOMRect {
  return { width, height: CELL, top: 0, left: 0, right: width, bottom: CELL, x: 0, y: 0, toJSON: () => ({}) };
}

function stubLayout(realCharEm = REAL_CHAR_EM) {
  const realGetComputedStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    if (el instanceof HTMLElement && el.classList.contains('cell-text')) {
      return { fontSize: `${CEILING_PX}px` } as CSSStyleDeclaration;
    }
    if (el instanceof HTMLElement && el.classList.contains('cell')) {
      return {
        paddingLeft: `${HOST_PADDING_PX}px`,
        paddingRight: `${HOST_PADDING_PX}px`,
        borderLeftWidth: '0px',
        borderRightWidth: '0px',
      } as CSSStyleDeclaration;
    }
    return realGetComputedStyle.call(window, el, pseudo ?? undefined);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('cell-text')) return rect(CELL);
    const size = parseFloat(this.style.fontSize);
    const longest = Math.max(...(this.textContent ?? '').split(/\s+/).map((w) => w.length));
    const unbrokenWidth = longest * size * realCharEm;
    // With mid-word breaking allowed the word wraps inside the box instead.
    return rect(this.style.wordBreak === 'normal' ? unbrokenWidth : Math.min(unbrokenWidth, USABLE));
  });
}

function renderedSpan(text: string): HTMLElement {
  const { container } = render(
    <div className="cell">
      <SquareText text={text} />
    </div>,
  );
  return container.querySelector('.cell-text') as HTMLElement;
}

describe('SquareText keeps words whole (#1345)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shrinks past the estimate until the longest word fits on one line at the real glyph width', () => {
    stubLayout();
    const target = renderedSpan('Grandparents on the dance floor');
    const size = parseFloat(target.style.fontSize);
    expect(size).toBeLessThan(CEILING_PX);
    // "Grandparents" (12 chars) must fit the 62px usable width at 0.6 em.
    expect(12 * size * REAL_CHAR_EM).toBeLessThanOrEqual(USABLE);
    // ...and it is the largest 0.5px step that does.
    expect(12 * (size + 0.5) * REAL_CHAR_EM).toBeGreaterThan(USABLE);
  });

  it('catches a word only a fraction of a pixel wider than the usable width', () => {
    // "Poolside" passes the estimate at the 12px ceiling, but at this ratio it
    // renders 62.4px against 62px usable: integer-rounded widths would call
    // that a fit. One 0.5px step down (59.8px) holds it.
    stubLayout(62.4 / (8 * CEILING_PX));
    const target = renderedSpan('Poolside');
    expect(parseFloat(target.style.fontSize)).toBe(CEILING_PX - 0.5);
  });

  it('keeps a narrow-glyph word at the ceiling when it really fits, even though the flat estimate says it is too wide', () => {
    // 12 chars at 0.55 em overflow 62px at 12px in the estimate, but these
    // glyphs really measure 0.4 em: 57.6px, a fit.
    stubLayout(0.4);
    const target = renderedSpan('Illimitables');
    expect(parseFloat(target.style.fontSize)).toBe(CEILING_PX);
  });

  it('keeps the no-mid-word-break overrides on the span once every word fits whole', () => {
    stubLayout();
    const target = renderedSpan('Grandparents on the dance floor');
    expect(target.style.wordBreak).toBe('normal');
    expect(target.style.overflowWrap).toBe('normal');
    expect(target.style.hyphens).toBe('manual');
  });

  it('restores the mid-word-break fallback when even the floor cannot hold the word', () => {
    stubLayout();
    const target = renderedSpan('Supercalifragilisticexpialidocious');
    expect(parseFloat(target.style.fontSize)).toBe(6);
    expect(target.style.wordBreak).toBe('');
    expect(target.style.overflowWrap).toBe('');
    expect(target.style.hyphens).toBe('');
  });

  it('leaves a prompt whose words already fit at the ceiling', () => {
    stubLayout();
    const target = renderedSpan('Kissed a stranger');
    expect(parseFloat(target.style.fontSize)).toBe(CEILING_PX);
  });
});
