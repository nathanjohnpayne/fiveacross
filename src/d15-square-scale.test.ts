import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #325 — the S/M/L pick scales the BINGO TILES through their own multiplier
// (`--square-scale`), decoupled from `--text-scale` so no non-tile text size
// changed. Pinned at the CSS source level (jsdom applies no stylesheets, so a
// rendered assertion can't see index.css — same approach as og-theme-parity's
// palette pin). See specs/d15-text-size.md § Contract.
//
// The boundary this holds:
//   - `--square-scale`: 1 by default, 1.4 at large, NO small override — tiles
//     never render below the Medium baseline, and Large is bigger than the
//     pre-#325 ceiling (1.15 via --text-scale).
//   - `--text-scale` keeps its original 0.9 / 1 / 1.15 — body copy behavior
//     is exactly what shipped before #325.
//   - Only `.cell` and `.free-prompt` read `--square-scale`; `body` still
//     reads `--text-scale`; nothing else reads either in a font-size.

const css = readFileSync('src/index.css', 'utf8');

/** Every `font-size` declaration in index.css, keyed by its rule selector. */
function fontSizesBySelector(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ');
    const sizes = [...m[2].matchAll(/font-size:\s*([^;]+);/g)].map((d) => d[1].trim());
    if (sizes.length) out.set(selector, [...(out.get(selector) ?? []), ...sizes]);
  }
  return out;
}

describe('square-scale split (#325, specs/d15-text-size.md)', () => {
  const bySelector = fontSizesBySelector();

  it('pins the square multipliers: 1 default, 1.4 large, no small override', () => {
    expect(css).toMatch(/:root\s*\{[^}]*--square-scale:\s*1;/);
    expect(css).toMatch(/:root\[data-text-size='large'\]\s*\{[^}]*--square-scale:\s*1\.4;/);
    const smallBlock = css.match(/:root\[data-text-size='small'\]\s*\{([^}]*)\}/);
    expect(smallBlock).not.toBeNull();
    expect(smallBlock![1]).not.toContain('--square-scale');
  });

  it('keeps --text-scale exactly as it shipped before #325 (0.9 / 1 / 1.15)', () => {
    expect(css).toMatch(/:root\s*\{[^}]*--text-scale:\s*1;/);
    expect(css).toMatch(/:root\[data-text-size='small'\]\s*\{[^}]*--text-scale:\s*0\.9;/);
    expect(css).toMatch(/:root\[data-text-size='large'\]\s*\{[^}]*--text-scale:\s*1\.15;/);
  });

  it.each(['.cell', '.free-prompt'])('tile ceiling %s reads var(--square-scale)', (selector) => {
    const sizes = bySelector.get(selector);
    expect(sizes, `selector ${selector} lost its font-size declaration`).toBeDefined();
    expect(sizes!.some((s) => s.includes('var(--square-scale'))).toBe(true);
  });

  it('body still reads var(--text-scale)', () => {
    expect(bySelector.get('body')?.some((s) => s.includes('var(--text-scale'))).toBe(true);
  });

  it('no other font-size reads either multiplier', () => {
    const allowed = new Set(['.cell', '.free-prompt', 'body']);
    for (const [selector, sizes] of bySelector) {
      if (allowed.has(selector)) continue;
      for (const size of sizes) {
        expect(size, `${selector} must not read a text-size multiplier`).not.toMatch(
          /var\(--(square|text)-scale/,
        );
      }
    }
  });
});
