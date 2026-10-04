import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import SquareText from './SquareText';

// #1345: the Square fit guard verifies the estimate against the real rendered
// glyphs and keeps shrinking while a word is wider than the box. jsdom has no
// layout, so the cell box, the CSS ceiling and the rendered width of the text
// are stubbed: the span's `offsetWidth` is what the longest word would measure
// at the applied font size WHEN mid-word breaking is switched off (the probe
// the guard runs), 0.6 em per character — wider than the estimator's 0.55
// default, the way a fallback face runs wider than the condensed face.
const CELL = 70; // px, the Square; the guard subtracts its 8px of padding
const CEILING_PX = 12;
const REAL_CHAR_EM = 0.6;

function stubLayout() {
  const realGetComputedStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    if (el instanceof HTMLElement && el.classList.contains('cell-text')) {
      return { fontSize: `${CEILING_PX}px` } as CSSStyleDeclaration;
    }
    return realGetComputedStyle.call(window, el, pseudo ?? undefined);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: CELL,
    height: CELL,
    top: 0,
    left: 0,
    right: CELL,
    bottom: CELL,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(CELL);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('cell-text')) return 0;
    const size = parseFloat(this.style.fontSize);
    const longest = Math.max(...(this.textContent ?? '').split(/\s+/).map((w) => w.length));
    const unbrokenWidth = longest * size * REAL_CHAR_EM;
    // With mid-word breaking allowed the word wraps inside the box instead.
    return this.style.wordBreak === 'normal' ? unbrokenWidth : Math.min(unbrokenWidth, CELL - 8);
  });
}

function renderedSize(text: string): HTMLElement {
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
    const target = renderedSize('Grandparents on the dance floor');
    const size = parseFloat(target.style.fontSize);
    expect(size).toBeLessThan(CEILING_PX);
    // "Grandparents" (12 chars) must fit the 62px usable width at 0.6 em.
    expect(12 * size * REAL_CHAR_EM).toBeLessThanOrEqual(CELL - 8);
    // ...and it is the largest 0.5px step that does.
    expect(12 * (size + 0.5) * REAL_CHAR_EM).toBeGreaterThan(CELL - 8);
  });

  it('leaves the probe overrides off the rendered span', () => {
    stubLayout();
    const target = renderedSize('Grandparents on the dance floor');
    expect(target.style.wordBreak).toBe('');
    expect(target.style.overflowWrap).toBe('');
    expect(target.style.hyphens).toBe('');
  });

  it('leaves a prompt whose words already fit at the ceiling', () => {
    stubLayout();
    const target = renderedSize('Kissed a stranger');
    expect(parseFloat(target.style.fontSize)).toBe(CEILING_PX);
  });
});
