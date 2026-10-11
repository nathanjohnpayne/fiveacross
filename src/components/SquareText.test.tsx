import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import SquareText, { FreeSquareText } from './SquareText';

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

function rect(width: number, height = CELL): DOMRect {
  return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
}

// `renderedLines` is how many lines the browser actually wraps the prompt to;
// the span's rendered height is that many lines at `.cell`'s 1.05 line-height.
function stubLayout(realCharEm = REAL_CHAR_EM, renderedLines = 2) {
  const realGetComputedStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    if (el instanceof HTMLElement && el.classList.contains('cell-text')) {
      return { fontSize: `${CEILING_PX}px` } as CSSStyleDeclaration;
    }
    if (el instanceof HTMLElement && el.classList.contains('cell')) {
      return {
        paddingLeft: `${HOST_PADDING_PX}px`,
        paddingRight: `${HOST_PADDING_PX}px`,
        paddingTop: `${HOST_PADDING_PX}px`,
        paddingBottom: `${HOST_PADDING_PX}px`,
        borderLeftWidth: '0px',
        borderRightWidth: '0px',
        borderTopWidth: '0px',
        borderBottomWidth: '0px',
        // index.css's corner-chip band, read live so a test can mark the
        // Square or add a chip after mount: 9px on top for the ✓ (15px once a
        // Doubt chip joins it), 15px at the bottom only under a ＋ or Tally.
        getPropertyValue: (name: string) => {
          if (!el.classList.contains('marked')) return '';
          if (name === '--fit-block-inset-top') return el.querySelector('.doubt-badge') ? '15px' : '9px';
          if (name === '--fit-block-inset-bottom') return el.querySelector('.proofbtn, .tally-badge') ? '15px' : '0px';
          return '';
        },
      } as unknown as CSSStyleDeclaration;
    }
    return realGetComputedStyle.call(window, el, pseudo ?? undefined);
  });
  // `transform.scale` mimics a CSS transform on the Square (the deal-drop
  // animation): it scales every bounding rect but not the computed padding.
  const transform = { scale: 1 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const s = transform.scale;
    if (!this.classList.contains('cell-text')) return rect(CELL * s, CELL * s);
    const size = parseFloat(this.style.fontSize);
    // The widest unbreakable run: CSS may wrap at whitespace or after a hyphen.
    const longest = Math.max(...((this.textContent ?? '').match(/[^\s-]*-|[^\s-]+/g) ?? []).map((w) => w.length));
    const unbrokenWidth = longest * size * realCharEm;
    // With mid-word breaking allowed the word wraps inside the box instead.
    const height = renderedLines * size * 1.05;
    return rect((this.style.wordBreak === 'normal' ? unbrokenWidth : Math.min(unbrokenWidth, USABLE)) * s, height * s);
  });
  return transform;
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

  it('re-fits once the deal animation ends, so a size probed mid-transform does not stick', () => {
    // "Poolside" renders 61.2px at 12px: a fit in the landed 62px box. Mid
    // deal-drop (scale 0.85) the rects shrink but the 8px padding does not,
    // so the probe sees 52.02px against 51.5px and steps down.
    const transform = stubLayout(61.2 / (8 * CEILING_PX));
    transform.scale = 0.85;
    const { container } = render(
      <div className="cell">
        <SquareText text="Poolside" />
      </div>,
    );
    const target = container.querySelector('.cell-text') as HTMLElement;
    expect(parseFloat(target.style.fontSize)).toBe(CEILING_PX - 0.5);

    transform.scale = 1;
    act(() => {
      container.querySelector('.cell')!.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(parseFloat(target.style.fontSize)).toBe(CEILING_PX);
  });

  it('keeps the ceiling when the real block fits, even though the estimator would shrink it on height', () => {
    // 10 narrow-glyph words: the flat 0.55 em estimate wraps them to 5 lines
    // at 12px (63px, over the 62px usable height) and would shrink, but the
    // browser renders them in 2 lines (25.2px) at 0.3 em.
    stubLayout(0.3, 2);
    const target = renderedSpan('iii iii iii iii iii iii iii iii iii iii');
    expect(parseFloat(target.style.fontSize)).toBe(CEILING_PX);
  });

  it('shrinks until the rendered block fits the height when the real line breaks need more lines than estimated', () => {
    // "WWWWW-WWWWW-WWWWW" may only wrap at its hyphens: the browser needs 6
    // lines here, which at the 12px ceiling is 75.6px against 62px usable.
    // The largest 0.5px step that fits is 9.5px (59.85px).
    stubLayout(0.4, 6);
    const target = renderedSpan('WWWWW-WWWWW-WWWWW');
    expect(parseFloat(target.style.fontSize)).toBe(9.5);
    // Words still fit whole, so the no-break overrides stay on.
    expect(target.style.wordBreak).toBe('normal');
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

// A marked Square's corner chips (✓, ＋, Doubt, Tally): the guard fits the
// prompt to the band between `--fit-block-inset-top` and `-bottom` so it clears
// them, and falls back to the full tile only when even the floor cannot.
describe('SquareText clears a marked Square\'s corner chips', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Short words, so width never binds: only the band's height decides.
  const FOUR_LINES = 'aa bb cc dd';
  const BAND = USABLE - 9 - 15; // 38px

  // `proof`: the Board renders a ＋ on every marked Square; the cached-card
  // fallback renders none.
  function renderCell(text: string, marked: boolean, proof = marked) {
    const { container } = render(
      <div className={marked ? 'cell marked' : 'cell'}>
        <SquareText text={text} />
        {proof && <button className="proofbtn" />}
      </div>,
    );
    return {
      cell: container.querySelector('.cell') as HTMLElement,
      target: container.querySelector('.cell-text') as HTMLElement,
    };
  }

  it('fits four lines inside the band on a marked Square, where an unmarked one keeps the ceiling', () => {
    stubLayout(REAL_CHAR_EM, 4);
    expect(parseFloat(renderCell(FOUR_LINES, false).target.style.fontSize)).toBe(CEILING_PX);
    const { target } = renderCell(FOUR_LINES, true);
    // The largest 0.5px step whose 4 lines at 1.05 fit 38px: 9px (37.8px).
    expect(parseFloat(target.style.fontSize)).toBe(9);
    expect(4 * 9 * 1.05).toBeLessThanOrEqual(BAND);
    // Centring in the band is CSS's margin, so the guard leaves it alone.
    expect(target.style.marginBottom).toBe('');
  });

  it('reserves only the top edge when no ＋ or Tally chip renders, as on the cached-card fallback', () => {
    // 62 - 9 = 53px: four lines fit at the 12px ceiling (50.4px).
    stubLayout(REAL_CHAR_EM, 4);
    expect(parseFloat(renderCell(FOUR_LINES, true, false).target.style.fontSize)).toBe(CEILING_PX);
  });

  it('falls back to the full tile, centred on it, when even the floor cannot hold the prompt in the band', () => {
    // 7 lines at the 6px floor are 44.1px, over the 38px band; on the full
    // 62px tile the largest step that fits is 8px (58.8px).
    stubLayout(REAL_CHAR_EM, 7);
    const { target } = renderCell(FOUR_LINES, true);
    expect(parseFloat(target.style.fontSize)).toBe(8);
    expect(target.style.marginBottom).toBe('0px');
  });

  it('re-fits when the Square is marked and again when a Doubt chip appears', async () => {
    stubLayout(REAL_CHAR_EM, 4);
    const { cell, target } = renderCell(FOUR_LINES, false);
    expect(parseFloat(target.style.fontSize)).toBe(CEILING_PX);

    await act(async () => {
      cell.classList.add('marked');
      const proof = document.createElement('button');
      proof.className = 'proofbtn';
      cell.appendChild(proof);
    });
    expect(parseFloat(target.style.fontSize)).toBe(9);

    // A Doubt chip raises the top inset to 15px: a 32px band, 7.5px (31.5px).
    await act(async () => {
      const chip = document.createElement('button');
      chip.className = 'doubt-badge';
      cell.appendChild(chip);
    });
    expect(parseFloat(target.style.fontSize)).toBe(7.5);
  });
});

// The free centre (FreeSquareText): its caption is fitted by the same guard,
// hosted by `.free-prompt-box`, which in the real layout shrinks to the height
// the display FREE label leaves. Stubbed here as a 20px-tall host.
describe('FreeSquareText fits its caption under the FREE label', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderFree(boxHeight: number, lines: number) {
    const realGetComputedStyle = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      if (el instanceof HTMLElement && el.classList.contains('cell-text')) {
        return { fontSize: `${CEILING_PX}px` } as CSSStyleDeclaration;
      }
      return realGetComputedStyle.call(window, el, pseudo ?? undefined);
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('free-prompt-box')) return rect(USABLE, boxHeight);
      if (!this.classList.contains('cell-text')) return rect(CELL, CELL);
      const size = parseFloat(this.style.fontSize);
      return rect(Math.min(4 * size * REAL_CHAR_EM, USABLE), lines * size * 1.05);
    });
    const { container } = render(
      <div className="cell free marked">
        <FreeSquareText text="Main character on the coast" />
      </div>,
    );
    return container;
  }

  it('renders the FREE label and a fitted caption carrying .free-prompt', () => {
    const container = renderFree(70, 2);
    expect(container.querySelector('.free-label')).toHaveTextContent('FREE');
    const caption = container.querySelector('.free-prompt-box > .cell-text.free-prompt') as HTMLElement;
    expect(caption).toHaveTextContent('Main character on the coast');
    // Room to spare: the caption keeps its ceiling.
    expect(parseFloat(caption.style.fontSize)).toBe(CEILING_PX);
  });

  it('shrinks the caption to the height the label leaves instead of clipping it', () => {
    // Three lines in a 20px box: the largest 0.5px step is 6px (18.9px).
    const caption = renderFree(20, 3).querySelector('.free-prompt') as HTMLElement;
    expect(parseFloat(caption.style.fontSize)).toBe(6);
    expect(3 * 6 * 1.05).toBeLessThanOrEqual(20);
  });
});
