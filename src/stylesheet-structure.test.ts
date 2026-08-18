import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A structural guard on the app stylesheet.
 *
 * WHY THIS EXISTS: a merge dropped the closing `}` of a rule in `index.css`,
 * which silently swallowed every subsequent selector into that unclosed block
 * (Phase 4b P1, PR #856). Nothing caught it — `GITHUB_ACTIONS=1 npm run build`
 * PASSED, because the CSS pipeline tolerates an unterminated final block
 * rather than failing on it. So the build gate is not a check on this, and a
 * whole section of styles can stop applying with every other gate green.
 *
 * Deliberately not a CSS parser: brace balance is the one property that broke,
 * it is cheap to state, and a stricter linter here would be a second opinion
 * about CSS that this repo does not otherwise hold.
 */
const CSS_PATH = resolve(process.cwd(), 'src/index.css');

/** Braces that actually delimit rules — ignoring any inside comments or
 *  quoted strings, where a brace is just a character (a `content: '{'` value,
 *  or a brace in prose). */
function countDelimiterBraces(css: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let inComment = false;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (inComment) {
      if (c === '*' && css[i + 1] === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '{') open++;
    else if (c === '}') close++;
  }
  return { open, close };
}

describe('src/index.css', () => {
  const css = readFileSync(CSS_PATH, 'utf8');

  it('has balanced rule braces, so no block silently swallows the rules after it', () => {
    const { open, close } = countDelimiterBraces(css);
    expect({ open, close }).toEqual({ open: close, close });
  });

  it('keeps the Step 3 · Squares and live-preview blocks present', () => {
    // Both sat on either side of the merge conflict that lost the brace.
    expect(css).toContain('.squares-issues {');
    expect(css).toContain('.wizard-prevbar {');
  });
});
