// The share card's brand-footer style, derived from the two files that own it
// rather than restated a second time.
//
// WHY THIS EXISTS (#887 round 7, id 4058824577). `render-share-footer.mjs`
// repaints one 32-row band on a committed card, and it carried its own idea of
// what that band looks like: 16px type, 3px letter spacing, and a per-Edition
// `ink` table. The canonical source says otherwise. The artboards' rule is
// `.shc .foot{font-size:8.5px;letter-spacing:.16em;text-transform:uppercase;
// color:var(--dim)}` and the cards are captured at `deviceScaleFactor: 2`, so
// the committed footer is 17px type with .16em (2.72px) spacing in that
// theme's `--dim`. The second definition had already drifted in two ways at
// once: every Edition's type was a size and a tracking the artboard never
// asked for, and Vacay's ink was `#8a857b` where its theme
// (`fog-froth-farewells`) sets `--dim: #66625a`. So a refresh documented as
// changing one line of copy silently restyled the type on all three cards and
// reverted Vacay's colour.
//
// A second table cannot be kept in step by review — it was not — so there is
// no second table. Everything here is read from:
//
//   - `plans/daily-cards-wireframes.html`: the `.shc .foot` rule, the font
//     family the rule inherits, and each `fx-share-final-photo-*` frame's
//     `data-theme`.
//   - `src/theme/themes.css`: the colour token that rule names (`--dim`), for
//     that theme.
//
// These are the same two files the artboard itself renders from, so "the
// repaint matches the capture" stops being a thing anyone has to remember.
//
// The parsing is deliberately narrow. This is not a CSS engine: it resolves
// ONE property set on ONE rule, with an explicit, short inheritance chain for
// the font family (`.shc .foot`, then `.shc`, then the document's `body`), and
// it throws by name the moment a source stops looking the way it expects
// rather than falling back to a plausible default. A silent default here is
// how the drift this module exists to end would come back.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARDS, SCALE } from './render-share-rasters.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The artboards, and the frames that carry each Edition's theme. */
export const WIREFRAMES_PATH = join(repo, 'plans', 'daily-cards-wireframes.html');
/** The theme tokens the artboards' `var(--…)` colours resolve against. */
export const THEMES_CSS_PATH = join(repo, 'src', 'theme', 'themes.css');
/** The artboard rule that owns the footer band's type. */
export const FOOTER_SELECTOR = '.shc .foot';
/** Weight, which no rule in the chain sets — CSS's own initial value, stated
 *  once here rather than assumed at the canvas call site. */
const DEFAULT_FONT_WEIGHT = '400';

const read = (path) => readFileSync(path, 'utf8');

/**
 * Every declaration block belonging to a rule whose selector is exactly
 * `selector`.
 *
 * The lookbehind is the whole trick: it requires the selector not to be the
 * tail of a longer one (`.foo.shc`, `--shc`), while still matching wherever a
 * selector legitimately starts — after a closing brace, a comma, the end of a
 * comment, a `<style>` tag or a newline, all of which a stylesheet embedded in
 * an HTML document actually uses. Anchoring on a closing brace alone silently
 * found nothing for the one rule that happens to follow a comment, which is
 * the sort of miss that makes a derived value quietly become a default.
 */
function ruleBodies(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?<![\\w.#[-])${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
}

/** The declaration block of the first rule with exactly this selector. */
function ruleBody(css, selector) {
  const [first = null] = ruleBodies(css, selector);
  return first;
}

function declaration(body, property) {
  if (body === null) return null;
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  return match ? match[1].trim() : null;
}

function required(value, what) {
  if (value === null || value === undefined) {
    throw new Error(
      `share-card-footer-style.mjs: could not read ${what}. The footer repaint derives every paint ` +
        'value from the artboard and the theme tokens, so it refuses rather than falling back to a ' +
        'guess — see this module\'s header, and check whether the source moved.',
    );
  }
  return value;
}

/**
 * The font family the footer inherits.
 *
 * `.shc .foot` sets none and neither does `.shc`, so it comes from the
 * document, which declares it in a `font:` shorthand on `body`. The wireframes
 * document contains more than one `body` rule; they must agree, because
 * "whichever one the regex found first" is not a source of truth.
 */
function inheritedFontFamily(html) {
  for (const selector of [FOOTER_SELECTOR, '.shc']) {
    const explicit = declaration(ruleBody(html, selector), 'font-family');
    if (explicit) return explicit;
  }
  const families = ruleBodies(html, 'body')
    .map((body) => declaration(body, 'font'))
    .filter(Boolean)
    // `14px/1.45 "Helvetica Neue",Arial,sans-serif` — the family list is
    // everything after the size/line-height.
    .map((shorthand) => shorthand.replace(/^\s*\S+\s+/, '').trim());
  const distinct = [...new Set(families)];
  if (distinct.length !== 1) {
    throw new Error(
      `share-card-footer-style.mjs: the wireframes document declares ${distinct.length} different body ` +
        `font stacks (${distinct.join(' | ') || 'none'}); the footer inherits its family, so exactly one is required.`,
    );
  }
  return distinct[0];
}

/** The `data-theme` on an Edition's share-card artboard. */
function themeOf(html, id) {
  const frame = required(CARDS[id], `an artboard for edition "${id}"`).frame;
  const unit = html.indexOf(`id="${frame}"`);
  if (unit === -1) throw new Error(`share-card-footer-style.mjs: no #${frame} frame in the wireframes document.`);
  const match = html.slice(unit).match(/class="shc"\s+data-theme="([^"]+)"/);
  return required(match && match[1], `the data-theme on #${frame}`);
}

/** A custom property's value for one theme, from `themes.css`. */
function themeToken(css, theme, token) {
  const block = css.match(new RegExp(`\\[data-theme=['"]${theme}['"]\\]\\s*\\{([\\s\\S]*?)\\}`));
  return required(declaration(block && block[1], `--${token}`), `--${token} for the ${theme} theme`);
}

/**
 * Everything the band repaint needs to draw the footer exactly as the artboard
 * draws it, at `scale` (the capture's `deviceScaleFactor`, so the numbers are
 * the committed picture's own pixels).
 *
 * Returns `{ theme, fontPx, letterSpacingPx, fontFamily, font, letterSpacing,
 * ink, uppercase }` — `font` and `letterSpacing` being the strings a canvas 2D
 * context takes, so the caller assembles nothing of its own.
 */
export function footerStyleFor(id, { scale = SCALE, html = read(WIREFRAMES_PATH), css = read(THEMES_CSS_PATH) } = {}) {
  const rule = ruleBody(html, FOOTER_SELECTOR);
  if (rule === null) {
    throw new Error(`share-card-footer-style.mjs: no ${FOOTER_SELECTOR} rule in the wireframes document.`);
  }

  const size = required(declaration(rule, 'font-size'), `font-size on ${FOOTER_SELECTOR}`);
  const sizeMatch = size.match(/^([\d.]+)px$/);
  if (!sizeMatch) {
    throw new Error(`share-card-footer-style.mjs: ${FOOTER_SELECTOR} font-size is "${size}"; only px is understood.`);
  }
  const fontPx = Number(sizeMatch[1]) * scale;

  // Tracking is declared in `em`, which is relative to the font size, so it
  // scales with it rather than by the device scale factor separately. A canvas
  // context wants px.
  const tracking = required(declaration(rule, 'letter-spacing'), `letter-spacing on ${FOOTER_SELECTOR}`);
  const trackingMatch = tracking.match(/^([\d.]+)em$/);
  if (!trackingMatch) {
    throw new Error(
      `share-card-footer-style.mjs: ${FOOTER_SELECTOR} letter-spacing is "${tracking}"; only em is understood.`,
    );
  }
  const letterSpacingPx = Number(trackingMatch[1]) * fontPx;

  const colour = required(declaration(rule, 'color'), `color on ${FOOTER_SELECTOR}`);
  const tokenMatch = colour.match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (!tokenMatch) {
    throw new Error(
      `share-card-footer-style.mjs: ${FOOTER_SELECTOR} color is "${colour}"; the footer is expected to take a theme token.`,
    );
  }
  const theme = themeOf(html, id);
  const fontFamily = inheritedFontFamily(html);

  return {
    theme,
    fontPx,
    letterSpacingPx,
    fontFamily,
    font: `${DEFAULT_FONT_WEIGHT} ${fontPx}px ${fontFamily}`,
    letterSpacing: `${letterSpacingPx}px`,
    ink: themeToken(css, theme, tokenMatch[1]),
    uppercase: declaration(rule, 'text-transform') === 'uppercase',
  };
}
