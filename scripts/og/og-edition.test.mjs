// @vitest-environment node
//
// Exercises the template's own `window.__OG_RENDER__`, loaded from the real
// og-edition.html rather than a reimplementation, so this pins the actual
// markup the renderer screenshots (#700).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const templateHtml = readFileSync(join(here, 'og-edition.html'), 'utf8');

/** A config with just enough fields for `__OG_RENDER__`'s stacked wordmark
 *  branch to run without touching the parts this test doesn't care about. */
function baseConfig(wordmarkOverrides) {
  return {
    palette: { bg: '#000', ink: '#fff', dim: '#999', primary: '#f0f', secondary: '#0ff', accent: '#ff0' },
    background: '#000',
    backgroundGrid: null,
    frame: null,
    eyebrow: { mark: '✨', text: 'EYEBROW' },
    wordmark: { size: 90, lineHeight: 1, ...wordmarkOverrides },
    byline: null,
    rule: { width: 100, background: '#fff' },
    desc: { text: 'A description.' },
    domain: 'example.com',
    left: { top: 80, gaps: { wordmark: 20, byline: 20, rule: 20, desc: 20, domain: 20 } },
    board: {
      x: 700,
      y: 90,
      size: 400,
      pattern: ['.....', '.....', '..F..', '.....', '.....'],
      freeLabel: 'FREE',
      barShort: 60,
      barLong: 100,
      barInset: 13,
    },
    stamp: null,
    caption: 'BINGO',
  };
}

async function renderWordmark(wordmarkOverrides) {
  const dom = new JSDOM(templateHtml, {
    url: pathToFileURL(join(here, 'og-edition.html')).href,
    runScripts: 'dangerously',
    resources: undefined,
  });
  const { window } = dom;
  window.__OG_RENDER__(baseConfig(wordmarkOverrides));
  const wm = window.document.getElementById('wordmark');
  return { window, wm };
}

describe('og-edition.html wordmark stacking (#700)', () => {
  it('stacks lead and bold on two lines with a <br> when both segments are present', async () => {
    const { wm } = await renderWordmark({ lead: 'GAY CRUISE', bold: 'BINGO' });
    expect(wm.querySelectorAll('br').length).toBe(1);
    const spans = wm.querySelectorAll('span');
    expect(spans.length).toBe(2);
    expect(spans[0].textContent).toBe('GAY CRUISE');
    expect(spans[0].className).toBe('');
    expect(spans[1].textContent).toBe('BINGO');
    expect(spans[1].className).toBe('grad');
  });

  it('renders a single unbolded span — no <br>, no blank line — when bold degraded to empty', async () => {
    // wordmarkSegments() takes this path whenever `wordmarkBold` is falsy or
    // is not a suffix of `wordmark` (src/editions.ts). The old markup always
    // inserted <span>lead</span><br><span class="grad"></span>, leaving a
    // blank second line.
    const { wm } = await renderWordmark({ lead: 'VACAY BINGO', bold: '' });
    expect(wm.querySelectorAll('br').length).toBe(0);
    const spans = wm.querySelectorAll('span');
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe('VACAY BINGO');
    expect(spans[0].className).toBe('');
  });

  it('renders a single gradient span — no <br>, no blank line — when the whole wordmark is bold', async () => {
    // The mirror-image degrade: `wordmarkBold === wordmark` leaves `lead`
    // empty. The old markup rendered <span></span><br><span class="grad">…</span>,
    // leaving a blank FIRST line instead.
    const { wm } = await renderWordmark({ lead: '', bold: 'BINGO' });
    expect(wm.querySelectorAll('br').length).toBe(0);
    const spans = wm.querySelectorAll('span');
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe('BINGO');
    expect(spans[0].className).toBe('grad');
  });
});

describe('og-edition.html board geometry (#884)', () => {
  it('keeps the free square at zero padding when prompt bars use an inset', () => {
    const dom = new JSDOM(templateHtml, {
      url: pathToFileURL(join(here, 'og-edition.html')).href,
      runScripts: 'dangerously',
      resources: undefined,
    });
    const config = baseConfig({ lead: 'GAY CRUISE', bold: 'BINGO' });

    dom.window.__OG_RENDER__(config);

    const squares = dom.window.document.querySelectorAll('.sq');
    const freeSquare = dom.window.document.querySelector('.sq.free');
    expect(squares[0].style.padding).toBe('0px 13px');
    expect(freeSquare.style.padding).toBe('');
    expect(dom.window.getComputedStyle(freeSquare).padding).toBe('0px');
  });
});

describe('og-edition.html board.barInset guard (#997)', () => {
  function renderWith(mutate) {
    const dom = new JSDOM(templateHtml, {
      url: pathToFileURL(join(here, 'og-edition.html')).href,
      runScripts: 'dangerously',
      resources: undefined,
    });
    const config = baseConfig({ lead: 'GAY CRUISE', bold: 'BINGO' });
    mutate(config);
    return { dom, render: () => dom.window.__OG_RENDER__(config) };
  }

  it('throws, and never signals ogReady, when board.barInset is omitted', () => {
    // `barInset` is required by og-edition-art.d.mts and every shipped Edition
    // sets it, but the template used to fall back to zero horizontal padding
    // when it was missing — a silently wrong render. The throw rejects the
    // `page.evaluate` call in render-og-editions.mjs that invokes
    // `__OG_RENDER__`, whose outer catch discards the staged renders and
    // exits nonzero; the renderer's later `ogReady` check is only a backstop,
    // pinned here so the backstop stays honest.
    const { dom, render } = renderWith((config) => {
      delete config.board.barInset;
    });
    expect(render).toThrow('og-edition: board.barInset is required');
    expect(dom.window.document.body.dataset.ogReady).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['NaN', Number.NaN],
    ['a numeric string', '13'],
    ['a negative number', -5],
  ])('rejects %s rather than coercing it into a padding value', (_label, value) => {
    const { render } = renderWith((config) => {
      config.board.barInset = value;
    });
    expect(render).toThrow('og-edition: board.barInset is required');
  });
});
