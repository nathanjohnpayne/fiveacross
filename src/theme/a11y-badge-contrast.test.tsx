import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { THEMES } from './themes';
import {
  type Rgb,
  alphaCompositeOver,
  contrastRatio,
  hexToRgb,
  mixSrgb,
  parseThemeBlocks,
} from './contrast';

// Covers specs/a11y-badge-contrast.md: the two marked-Square overlay badges
// that fill their text with a literal `#fff` — .doubt-badge (top-left, a
// darkened --secondary chip) and .tally-badge (bottom-right, a translucent
// black scrim over the marked-cell gradient). Both were out of scope for
// specs/w1-themes.md (whose contract only covers the theme *tokens*, not these
// composited overlays); this suite is their WCAG contrast contract.
//
// Everything is COMPUTED from the real CSS: --primary/--secondary come from
// themes.css and the badge fill/background come from index.css, both parsed at
// test time. Nothing is hand-transcribed, so a Theme retint, a color-mix-weight
// tweak, or a scrim-alpha change re-derives the ratios and this test moves with
// the CSS it polices.

const here = dirname(fileURLToPath(import.meta.url));
const themeBlocks = parseThemeBlocks(readFileSync(join(here, 'themes.css'), 'utf-8'));
const indexCss = readFileSync(join(here, '..', 'index.css'), 'utf-8');

// These are small numeric-text badges. The count they show is real,
// information-bearing text (not a decorative glyph), so we hold them to WCAG
// 2.1 1.4.3 Contrast (Minimum) 4.5:1 — the same normal-text floor
// specs/w1-themes.md applies to the equally-small leaderboard rank numerals —
// rather than the looser 3:1 non-text/UI-component floor (1.4.11).
const TEXT_MIN = 4.5;
// WCAG 2.1 1.4.11 Non-text Contrast: the floor for the proof chip's ＋ glyph.
const UI_MIN = 3;

/** Body (declaration list) of the first `selector { ... }` rule in a stylesheet. */
function ruleBody(css: string, selector: string): string {
  const re = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1];
}

function textColor(body: string): string {
  const m = body.match(/(?:^|[;{\s])color:\s*(#[0-9a-fA-F]{3,8})\s*;/);
  if (!m) throw new Error('no `color: #hex` in rule body');
  return m[1];
}

const doubtBody = ruleBody(indexCss, '.doubt-badge');
const tallyBody = ruleBody(indexCss, '.tally-badge');
const markedBody = ruleBody(indexCss, '.cell.marked');

describe('badge overlays — WCAG AA contrast (specs/a11y-badge-contrast.md)', () => {
  it('has a [data-theme] block with --primary and --secondary for every ThemeId', () => {
    for (const t of THEMES) {
      const vars = themeBlocks[t.id];
      expect(vars, `missing [data-theme='${t.id}'] block`).toBeDefined();
      expect(vars.primary, `${t.id}: missing --primary`).toMatch(/^#/);
      expect(vars.secondary, `${t.id}: missing --secondary`).toMatch(/^#/);
    }
  });

  // ----- .doubt-badge: white text on an OPAQUE color-mix(--secondary N%, #000).
  // Opaque, so the mix result IS the painted background (nothing beneath bleeds
  // through). Parse N straight from the CSS.
  describe('.doubt-badge — #fff on color-mix(--secondary N%, #000)', () => {
    const fg = hexToRgb(textColor(doubtBody));
    const mix = doubtBody.match(
      /background:\s*color-mix\(\s*in srgb\s*,\s*var\(--secondary\)\s*([\d.]+)%\s*,\s*#0{3,6}\s*\)/,
    );

    it('fills its text with #fff over a --secondary/#000 mix (parse premise)', () => {
      expect(textColor(doubtBody)).toBe('#fff');
      expect(mix, '.doubt-badge background is not the expected color-mix form').not.toBeNull();
    });

    const weight = Number(mix?.[1]) / 100;
    for (const t of THEMES) {
      it(`${t.id}: white numerals meet ${TEXT_MIN}:1`, () => {
        const bg = mixSrgb(hexToRgb(themeBlocks[t.id].secondary), [0, 0, 0], weight);
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(TEXT_MIN);
      });
    }
  });

  // ----- .tally-badge: white text on rgba(0,0,0,A) over the marked-cell
  // gradient linear-gradient(145deg, --primary, --secondary). The scrim is
  // TRANSLUCENT, so the composited color depends on the gradient point beneath
  // the corner. Luminance along a straight sRGB line is convex, so it peaks at
  // an endpoint → the lowest white-contrast is at --primary or --secondary.
  // Checking both bounds the whole gradient (and keeps the badge safe wherever
  // it lands if the gradient angle ever changes).
  describe('.tally-badge — #fff on rgba(0,0,0,A) over the marked gradient', () => {
    const fg = hexToRgb(textColor(tallyBody));
    const rgba = tallyBody.match(/background:\s*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)/);

    it('fills its text with #fff over a pure-black rgba scrim (parse premise)', () => {
      expect(textColor(tallyBody)).toBe('#fff');
      expect(rgba, '.tally-badge background is not the expected rgba(0,0,0,A) form').not.toBeNull();
    });

    it('sits over a --primary→--secondary marked-cell gradient (endpoint premise)', () => {
      expect(markedBody).toMatch(/linear-gradient\([^)]*var\(--primary\)[^)]*var\(--secondary\)/);
    });

    const alpha = Number(rgba?.[1]);
    for (const t of THEMES) {
      it(`${t.id}: white numerals meet ${TEXT_MIN}:1 over both gradient ends`, () => {
        const black: Rgb = [0, 0, 0];
        for (const end of ['primary', 'secondary'] as const) {
          const bg = alphaCompositeOver(black, alpha, hexToRgb(themeBlocks[t.id][end]));
          expect(
            contrastRatio(fg, bg),
            `${t.id}: over --${end}`,
          ).toBeGreaterThanOrEqual(TEXT_MIN);
        }
      });
    }
  });

  // ----- .proofbtn: a white ＋ on rgba(0,0,0,A) over the same marked gradient.
  // An action glyph, not information-bearing text, so the bar is 1.4.11's 3:1
  // UI-component floor (specs/a11y-badge-contrast.md § `.proofbtn`). It sits
  // bottom-left, nearer the 145° gradient's midpoint than either end; the same
  // convexity argument as the Tally means both ends bound every point between.
  // 0.35 measured only over --primary passed, and fell to 2.54:1 over
  // get-sporty's near-white --secondary.
  describe('.proofbtn — #fff ＋ on rgba(0,0,0,A) over the marked gradient', () => {
    const proofBody = ruleBody(indexCss, '.proofbtn');
    const fg = hexToRgb(textColor(proofBody));
    const rgba = proofBody.match(/background:\s*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)/);

    it('fills its glyph with #fff over a pure-black rgba scrim (parse premise)', () => {
      expect(textColor(proofBody)).toBe('#fff');
      expect(rgba, '.proofbtn background is not the expected rgba(0,0,0,A) form').not.toBeNull();
    });

    const alpha = Number(rgba?.[1]);
    for (const t of THEMES) {
      it(`${t.id}: the ＋ meets ${UI_MIN}:1 over both gradient ends`, () => {
        const black: Rgb = [0, 0, 0];
        for (const end of ['primary', 'secondary'] as const) {
          const bg = alphaCompositeOver(black, alpha, hexToRgb(themeBlocks[t.id][end]));
          expect(contrastRatio(fg, bg), `${t.id}: over --${end}`).toBeGreaterThanOrEqual(UI_MIN);
        }
      });
    }
  });
});
