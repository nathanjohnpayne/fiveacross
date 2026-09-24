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
//   - `plans/daily-cards-wireframes.html`, and only that file: the
//     `.shc .foot` rule, the font family the rule inherits, each
//     `fx-share-final-photo-*` frame's `data-theme`, AND the `[data-theme]`
//     token block that theme resolves against.
//
// That last one was wrong at first (#887 round 8, id 4058904673). The tokens
// were read from `src/theme/themes.css`, which is the app's stylesheet and not
// the artboard's: the wireframes document links no stylesheet for them, it
// declares its own `[data-theme]` blocks inline, and those are what Chromium
// actually applies when the full render screenshots the card. The two tables
// are near-copies, so it looked right, but they are maintained separately and
// have already diverged — `fiveacross-slate` carries a different `--primary`,
// `--secondary` and `--on-gradient` in each. The day `--dim` diverged the same
// way, a footer refresh would have committed a colour the full render never
// draws, while this module claimed to derive the artboard's own style. So the
// ink comes from the CSS the artboard renders. `themeTokenDisagreements` below
// reports the divergences that already exist, by name, so they are visible
// rather than silent; reconciling them is not this change's business.
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
/** The app's own theme tokens. NOT what the artboard renders — kept here only
 *  so `themeTokenDisagreements` can report where the two tables have drifted
 *  apart. Nothing the footer paints is read from this file. */
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

/**
 * The `data-theme` on an Edition's share-card artboard.
 *
 * Bound to the requested frame, and order-independent on the tag it reads
 * (#887, finding 4075112560). The old regex searched forward from the frame's
 * `id=` with no upper bound and required `class="shc"` to appear immediately
 * before `data-theme` in source order, so a semantically equivalent artboard
 * with its attributes written the other way round —
 * `<div data-theme="so-long-farewell" class="shc">` — was invisible to it, and
 * the search fell through past the WHOLE unit to the next frame's `.shc` div,
 * silently returning that Edition's theme instead of refusing. The full
 * raster renderer never had this failure mode: `#frame .shc` (see
 * `render-share-rasters.mjs`) is a real CSS selector Chromium resolves against
 * the parsed DOM, where attribute order carries no meaning at all. This
 * scopes the search to the frame's own unit — from its `id=` to the next
 * `<div class="unit"` sibling — finds the one `.shc` opening tag in that
 * scope by testing the whole tag rather than an ordered pair of attributes,
 * and reads `data-theme` from that same tag, independently of where either
 * attribute sits on it.
 */
function themeOf(html, id) {
  const frame = required(CARDS[id], `an artboard for edition "${id}"`).frame;
  const unitAt = html.indexOf(`id="${frame}"`);
  if (unitAt === -1) throw new Error(`share-card-footer-style.mjs: no #${frame} frame in the wireframes document.`);
  const nextUnitAt = html.indexOf('<div class="unit"', unitAt + 1);
  const scope = html.slice(unitAt, nextUnitAt === -1 ? undefined : nextUnitAt);
  const shcTag = [...scope.matchAll(/<div\b[^>]*>/g)].map((m) => m[0]).find((tag) => /\bclass="shc"/.test(tag));
  if (!shcTag) throw new Error(`share-card-footer-style.mjs: no .shc artboard inside #${frame}.`);
  const match = shcTag.match(/data-theme="([^"]+)"/);
  return required(match && match[1], `the data-theme on #${frame}`);
}

/**
 * Every `[data-theme]` token block in a stylesheet, as `theme -> { token:
 * value }`.
 *
 * A source may declare the same theme more than once — the wireframes document
 * carries two `<style>` blocks and repeats most themes across them — and the
 * copies must agree, because "whichever one the regex found first" is not a
 * source of truth. Blocks that declare no custom properties (a rule like
 * `[data-theme='summer-white'] .title{…}`) are not token tables and are
 * skipped.
 */
export function themeTokenTable(source) {
  const table = new Map();
  for (const match of source.matchAll(/\[data-theme=['"]([\w-]+)['"]\]\s*\{([^}]*)\}/g)) {
    const [, theme, body] = match;
    const tokens = Object.fromEntries(
      [...body.matchAll(/--([\w-]+)\s*:\s*([^;]+)/g)].map(([, name, value]) => [name, value.trim()]),
    );
    if (Object.keys(tokens).length === 0) continue;
    const seen = table.get(theme);
    if (seen) {
      for (const [name, value] of Object.entries(tokens)) {
        if (seen[name] !== undefined && seen[name] !== value) {
          throw new Error(
            `share-card-footer-style.mjs: the stylesheet declares --${name} for the ${theme} theme twice, ` +
              `as "${seen[name]}" and "${value}". One of them is what renders and this module cannot tell which.`,
          );
        }
      }
      Object.assign(seen, tokens);
      continue;
    }
    table.set(theme, tokens);
  }
  return table;
}

/** A custom property's value for one theme, from the stylesheet given. */
function themeToken(source, theme, token) {
  const tokens = themeTokenTable(source).get(theme);
  return required(tokens && tokens[token], `--${token} for the ${theme} theme`);
}

/** Whitespace and a leading-zero-less alpha are formatting, not disagreement:
 *  `rgba(0,0,0,.35)` and `rgba(0, 0, 0, 0.35)` are the same colour. */
const normaliseValue = (value) => value.replace(/\s+/g, '').replace(/(^|[,(])\./g, '$10.');

/**
 * Every token the artboard's stylesheet and the app's stylesheet declare
 * DIFFERENTLY, as `{ theme, token, wireframes, themes }`, sorted.
 *
 * Only tokens both files declare for a theme both files carry are compared: a
 * token one side simply does not have is an absence, not a contradiction, and
 * saying otherwise would bury the contradictions in noise. This reports; it
 * fixes nothing. The footer reads the artboard's table and is correct whatever
 * this returns — the point is that the next divergence is visible in a test
 * rather than discovered in a rendered asset.
 */
export function themeTokenDisagreements({ html = read(WIREFRAMES_PATH), css = read(THEMES_CSS_PATH) } = {}) {
  const artboard = themeTokenTable(html);
  const app = themeTokenTable(css);
  const out = [];
  for (const [theme, tokens] of [...artboard].sort(([a], [b]) => a.localeCompare(b))) {
    const appTokens = app.get(theme);
    if (!appTokens) continue;
    for (const token of Object.keys(tokens).sort()) {
      if (appTokens[token] === undefined) continue;
      if (normaliseValue(tokens[token]) === normaliseValue(appTokens[token])) continue;
      out.push({ theme, token, wireframes: tokens[token], themes: appTokens[token] });
    }
  }
  return out;
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
export function footerStyleFor(id, { scale = SCALE, html = read(WIREFRAMES_PATH) } = {}) {
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
    // From the artboard's OWN stylesheet, not the app's: the wireframes
    // document links no stylesheet for these tokens, so its inline blocks are
    // what Chromium applies to the card the full render captures.
    ink: themeToken(html, theme, tokenMatch[1]),
    uppercase: declaration(rule, 'text-transform') === 'uppercase',
  };
}
