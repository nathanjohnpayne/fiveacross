import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { THEMES } from './themes';
import { contrastRatio, hexToRgb, mixSrgb, parseThemeBlocks } from './contrast';

// Covers specs/theme-on-color-contrast.md (issue #72): the hardcoded-#fff
// text/border fills in src/index.css that never adapted to [data-theme]
// (Scope A), and the primary/secondary text sitting directly on
// gradient-tinted backdrops that specs/w1-themes.md's "Known bound"
// carve-out deliberately didn't check (Scope B). Reuses the contrast math
// from ./contrast.ts (shared with src/theme/w1-themes.test.tsx) so both
// suites can never drift apart on how they compute a contrast ratio.

const themeDir = dirname(fileURLToPath(import.meta.url));
// See w1-themes.test.tsx for why this join(dirname(...), ...) form is used
// over `new URL(..., import.meta.url)` (Vite rewrites the latter under Vite,
// which isn't a file:// URL under Vitest).
const themeBlocks = parseThemeBlocks(readFileSync(join(themeDir, 'themes.css'), 'utf-8'));
const indexCss = readFileSync(join(themeDir, '..', 'index.css'), 'utf-8');

const TEXT_MIN = 4.5; // WCAG 1.4.3 Contrast (Minimum), normal text
const UI_MIN = 3.0; // WCAG 1.4.11 Non-text Contrast, graphical objects / UI component boundaries

// ---------------------------------------------------------------------------
// Scope A pin: no target rule regressed back to a literal #fff text/border
// fill. Parses the rule block straight out of index.css (not a hand-copied
// snippet) so this can't drift from the file it polices. Decorative
// text-shadow glows are stripped before the check — a glow layered around a
// fill is not the fill itself and does not count toward contrast (the same
// treatment index.css's own comments give .signin h1 / .celebrate .big's
// glows).
// ---------------------------------------------------------------------------

function ruleBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found in src/index.css: ${selector}`);
  return match[1];
}

// Parse the weight out of a `color-mix(in srgb, var(--<name>) N%, ...)` in a
// rule body and return it as a fraction in [0,1] — so every composited-surface
// check below computes against the REAL tint strength in src/index.css rather
// than a hand-copied literal that would silently go stale if the gradient is
// retuned (issue #72 Codex P3, PR #123 comment 3553469606). Same parse-the-CSS
// approach specs/a11y-badge-contrast.md's suite uses for its badge weights.
function mixWeight(ruleBody: string, varName: string): number {
  const m = ruleBody.match(
    new RegExp(`color-mix\\(\\s*in srgb\\s*,\\s*var\\(--${varName}\\)\\s*([\\d.]+)%`),
  );
  if (!m) throw new Error(`no color-mix(in srgb, var(--${varName}) N%, ...) in rule body`);
  return Number(m[1]) / 100;
}

// Strip CSS /* ... */ comments — these rules' own comments name the old #fff
// value and words like "transparent" in prose, which would false-positive the
// source pins below. Applied before any assertion that greps the rule body.
function stripComments(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripDecorativeGlow(block: string): string {
  // Also strip text-shadow declarations — a glow layered around a fill is not
  // the fill itself and does not count toward contrast.
  return stripComments(block).replace(/text-shadow:[^;]*;/g, '');
}

const FIXED_RULES = [
  '.cell.marked',
  '.cell.marked::after',
  '.celebrate .big',
  '.signin h1',
  '.share-card-cell.marked', // bonus fix: same hardcoded-#fff pattern as .cell.marked, same file
];

describe('src/index.css — no hardcoded #fff text/border fill (specs/theme-on-color-contrast.md)', () => {
  for (const selector of FIXED_RULES) {
    it(`${selector} does not fill color/border-color with a literal #fff`, () => {
      const fillOnly = stripDecorativeGlow(ruleBlock(indexCss, selector));
      expect(fillOnly.toLowerCase()).not.toMatch(/#fff\b/);
    });
  }

  it('documents the pre-fix regression: literal #fff on summer-white --bg fails WCAG AA', () => {
    // Historical value from issue #72's own audit — the worst contrast
    // failure in the app before this fix (.signin h1 / .cell.marked border
    // both painted #fff directly against summer-white's light --bg).
    const bg = themeBlocks['summer-white']?.bg;
    expect(bg).toBeDefined();
    expect(contrastRatio(hexToRgb('#ffffff'), hexToRgb(bg!))).toBeLessThan(1.2);
    expect(contrastRatio(hexToRgb('#ffffff'), hexToRgb(bg!))).toBeLessThan(TEXT_MIN);
  });
});

// ---------------------------------------------------------------------------
// Scope A: --on-gradient (src/theme/themes.css) against BOTH endpoints of
// the `.cell.marked` / `.share-card-cell.marked` gradient
// (linear-gradient(var(--primary), var(--secondary))) — position-independent
// and therefore a stricter bound than sampling any single point on the
// gradient. The ✓ glyph and the border are graphical/UI-component objects
// (WCAG 1.4.11, 3:1 floor) but --on-gradient clears the stricter 4.5:1 text
// floor everywhere, so one assertion covers both floors for both call sites.
// ---------------------------------------------------------------------------

describe('--on-gradient vs both .cell.marked gradient endpoints (specs/theme-on-color-contrast.md)', () => {
  it('every ThemeId defines --on-gradient', () => {
    for (const t of THEMES) {
      expect(themeBlocks[t.id]?.['on-gradient'], `missing --on-gradient for ${t.id}`).toBeDefined();
    }
  });

  for (const t of THEMES) {
    const vars = themeBlocks[t.id] ?? {};
    it(`${t.id}: --on-gradient meets ${TEXT_MIN}:1 against --primary`, () => {
      expect(contrastRatio(hexToRgb(vars['on-gradient']), hexToRgb(vars.primary))).toBeGreaterThanOrEqual(TEXT_MIN);
    });
    it(`${t.id}: --on-gradient meets ${TEXT_MIN}:1 against --secondary`, () => {
      expect(contrastRatio(hexToRgb(vars['on-gradient']), hexToRgb(vars.secondary))).toBeGreaterThanOrEqual(TEXT_MIN);
    });
  }
});

// ---------------------------------------------------------------------------
// Scope A: the `.cell.marked` / `.share-card-cell.marked` border stays on
// --ink, not --on-gradient — its job is to read against the page background
// surrounding the cell (--bg), not the gradient fill it encloses. --ink vs
// --bg is already asserted >=4.5:1 in w1-themes.test.tsx's TEXT_PAIRS; this
// suite re-asserts it explicitly (at the looser 3:1 UI-component floor this
// call site actually needs) so the border fix this spec documents is pinned
// here too, not just inherited implicitly from the other suite.
// ---------------------------------------------------------------------------

describe('--ink vs --bg for the .cell.marked border (specs/theme-on-color-contrast.md)', () => {
  for (const t of THEMES) {
    const vars = themeBlocks[t.id] ?? {};
    it(`${t.id}: --ink meets the ${UI_MIN}:1 UI-component floor against --bg`, () => {
      expect(contrastRatio(hexToRgb(vars.ink), hexToRgb(vars.bg))).toBeGreaterThanOrEqual(UI_MIN);
    });
  }
});

// ---------------------------------------------------------------------------
// .celebrate .big: --ink against the celebrate backdrop. The celebration
// renders position:fixed OVER the live Board, so contrast here has to hold
// against the *real* surface behind the hero text, not a bare --bg (issue #72
// Codex P2, PR #123 comment 3553469597). The fix makes .celebrate's backdrop
// OPAQUE — a color-mix(--primary N%, --bg) radial fading to solid --bg, with
// no transparent stops — so no Board cell can bleed through and the surface is
// fully determined by this rule's own tokens. The hottest (most --primary)
// point is the radial's center, where `.big` sits. We first assert the
// opaqueness premise (no `transparent`, and a solid `var(--bg)` stop), then
// parse the actual center weight from the CSS (Codex P3, comment 3553469606)
// rather than hard-coding it, so a retune of the gradient moves this check too.
// ---------------------------------------------------------------------------

describe('.celebrate .big: --ink vs the (opaque) celebrate backdrop (specs/theme-on-color-contrast.md)', () => {
  // Comments stripped: this rule's own comment discusses the old translucent
  // backdrop by name, which would false-positive the opaqueness grep below.
  const celebrateBody = stripComments(ruleBlock(indexCss, '.celebrate'));

  it('.celebrate backdrop is opaque — no transparent stop, fades to solid var(--bg)', () => {
    // The point of the P2 fix: an opaque backdrop removes the dependency on
    // whatever Board cell is underneath. A `transparent` anywhere in the
    // background would let it bleed back through and invalidate the check.
    expect(celebrateBody).not.toMatch(/transparent/);
    expect(celebrateBody).toMatch(/,\s*var\(--bg\)\s*\)/); // solid --bg outer stop
  });

  const weight = mixWeight(celebrateBody, 'primary');
  for (const t of THEMES) {
    const vars = themeBlocks[t.id] ?? {};
    it(`${t.id}: --ink meets ${TEXT_MIN}:1 against the ${weight * 100}% --primary center over --bg`, () => {
      const composite = mixSrgb(hexToRgb(vars.primary), hexToRgb(vars.bg), weight);
      expect(contrastRatio(hexToRgb(vars.ink), composite)).toBeGreaterThanOrEqual(TEXT_MIN);
    });
  }
});

// ---------------------------------------------------------------------------
// .signin h1: no ancestor background between it and body (see App.tsx /
// SignIn.tsx), so this is the plain --ink/--bg pair — restated explicitly
// here (rather than only inherited from w1-themes.test.tsx) since it is one
// of this spec's four target rules.
// ---------------------------------------------------------------------------

describe('.signin h1: --ink vs --bg (specs/theme-on-color-contrast.md)', () => {
  for (const t of THEMES) {
    const vars = themeBlocks[t.id] ?? {};
    it(`${t.id}: --ink meets ${TEXT_MIN}:1 against --bg`, () => {
      expect(contrastRatio(hexToRgb(vars.ink), hexToRgb(vars.bg))).toBeGreaterThanOrEqual(TEXT_MIN);
    });
  }
});

// ---------------------------------------------------------------------------
// Scope B (retires w1-themes.md's former "Known bound: gradient-tinted
// backdrops are not checked"): `body`'s background (index.css) layers two
// radial-gradient tints over --bg — up to 32% --primary near the top-left,
// up to 26% --secondary near the top-right. .brand b / .bingo-head span (the
// B-I-N-G-O header) and .count b used to fill text with --primary/
// --secondary directly, a self-referential trap (the same token tints the
// backdrop *and* is the text sitting on it) that already dropped under
// 4.5:1 in 6 of the 8 themes at the gradient's actual max strength. All
// three now use --ink instead, checked here against the composited tint at
// its hottest (highest-alpha) point — a stricter, position-independent
// bound than any single on-screen sample, since every less-tinted point on
// the same gradient is closer to the already-covered flat---bg case.
// ---------------------------------------------------------------------------

describe('body gradient tints: --ink vs the composited backdrop (specs/theme-on-color-contrast.md)', () => {
  // Parse the two tint weights straight from body's own background rather than
  // hard-coding 0.32/0.26 (issue #72 Codex P3, PR #123 comment 3553469606), so
  // a retune of body's radial-gradient stops moves these checks with it. The
  // color-mix(..., transparent) stops composite over the opaque --bg base
  // identically to mixing toward --bg at the same weight (mixing toward
  // transparent only scales alpha).
  const bodyBody = ruleBlock(indexCss, 'body');
  const primaryWeight = mixWeight(bodyBody, 'primary');
  const secondaryWeight = mixWeight(bodyBody, 'secondary');

  for (const t of THEMES) {
    const vars = themeBlocks[t.id] ?? {};
    it(`${t.id}: --ink meets ${TEXT_MIN}:1 against the ${primaryWeight * 100}% --primary tint over --bg (.brand b, .bingo-head span)`, () => {
      const composite = mixSrgb(hexToRgb(vars.primary), hexToRgb(vars.bg), primaryWeight);
      expect(contrastRatio(hexToRgb(vars.ink), composite)).toBeGreaterThanOrEqual(TEXT_MIN);
    });
    it(`${t.id}: --ink meets ${TEXT_MIN}:1 against the ${secondaryWeight * 100}% --secondary tint over --bg (.count b)`, () => {
      const composite = mixSrgb(hexToRgb(vars.secondary), hexToRgb(vars.bg), secondaryWeight);
      expect(contrastRatio(hexToRgb(vars.ink), composite)).toBeGreaterThanOrEqual(TEXT_MIN);
    });
  }

  it('documents the pre-fix regression: the old --primary/--secondary self-fill already failed 4.5:1 in most themes', () => {
    // Historical values (issue #72's own audit, verified independently here):
    // before this fix, .brand b / .bingo-head span filled with --primary
    // directly, and that same --primary tints the backdrop it sits on — a
    // self-referential pairing that already dropped under 4.5:1 well before
    // the gradient's actual 32% max in most themes. Pinned for
    // neon-playground (a mid-saturation theme, not just the summer-white
    // extreme this issue's table led with) so a future revert is caught.
    const vars = themeBlocks['neon-playground']!;
    const oldComposite = mixSrgb(hexToRgb(vars.primary), hexToRgb(vars.bg), 0.32);
    expect(contrastRatio(hexToRgb(vars.primary), oldComposite)).toBeLessThan(TEXT_MIN);
  });
});

// ---------------------------------------------------------------------------
// Scope C (issues #301 / #296): the `.board-area[data-theme]` retint scope
// paints its OWN themed surface. Before the fix, Board.tsx's data-theme
// re-scoped the CSS variables but `.board-area` painted no background, so the
// viewed Day's text tokens floated over the PAGE theme's backdrop — a
// cross-theme (viewed x page) contrast matrix the per-theme contract above
// never covered: a dark Day over a dark page changed almost nothing visible
// (#301), and summer-white's near-black --ink went dark-on-dark (#296).
// The structural pin below asserts the rule paints a FLAT `var(--bg)` (no
// gradient/color-mix/transparent), which is what collapses that matrix back
// to per-theme self-consistency: every board-area text token sits on its own
// theme's --bg / --cell, independent of the page theme. The flatness is
// load-bearing — summer-white's --dim (the dress-code description, at the
// top of the box where a body-style radial tint would be hottest) has no
// tint headroom at all (under 4.5:1 vs even an 18% --primary mix), so the
// Day's-world glow lives in box-shadow (painted outside the surface), never
// under the box's own text.
// ---------------------------------------------------------------------------

describe('.board-area[data-theme] paints its own flat themed surface (specs/theme-on-color-contrast.md, #301/#296)', () => {
  const boardAreaBody = stripComments(ruleBlock(indexCss, '.board-area[data-theme]'));

  it('backgrounds with a flat var(--bg) — no gradient, color-mix, or transparent stop', () => {
    expect(boardAreaBody).toMatch(/background:\s*var\(--bg\)\s*;/);
    expect(boardAreaBody).not.toMatch(/gradient|color-mix|transparent/);
  });

  it('keeps the glow outside the surface (box-shadow), never as a backdrop under text', () => {
    expect(boardAreaBody).toMatch(/box-shadow:[^;]*var\(--shadow\)/);
  });

  // With the surface painted, the viewed-Day tokens that render as text
  // inside .board-area reduce to their own theme's pairs regardless of the
  // page theme: --ink on --bg (Day header, B-I-N-G-O letters) and --dim on
  // --bg (dress-code description, daybar meta, lock captions). Restated
  // explicitly here (rather than only inherited from w1-themes.test.tsx's
  // TEXT_PAIRS) because they are THE pairs this fix's structural reduction
  // bottoms out on — same treatment the .signin h1 section above gives its
  // inherited pair.
  for (const t of THEMES) {
    const vars = themeBlocks[t.id] ?? {};
    it(`${t.id}: --ink and --dim meet ${TEXT_MIN}:1 against the board-area's own painted --bg`, () => {
      expect(contrastRatio(hexToRgb(vars.ink), hexToRgb(vars.bg))).toBeGreaterThanOrEqual(TEXT_MIN);
      expect(contrastRatio(hexToRgb(vars.dim), hexToRgb(vars.bg))).toBeGreaterThanOrEqual(TEXT_MIN);
    });
  }

  // A Theme is LIGHT when its --bg is lighter than its --ink. Derived rather
  // than listed: `summer-white` used to be the only one, and #555's
  // `fog-froth-farewells` made that assumption false — a hardcoded list would
  // have gone stale again on the next light Theme instead of failing loudly.
  // `contrastRatio(x, black)` is monotonic in relative luminance, so it works
  // as a lightness proxy without importing a second helper.
  const lightness = (hex: string) => contrastRatio(hexToRgb(hex), hexToRgb('#000000'));
  const isLight = (id: string) =>
    lightness(themeBlocks[id]!.bg) > lightness(themeBlocks[id]!.ink);

  it('documents the pre-fix regression: summer-white --ink floated over a DARK page theme fails 4.5:1', () => {
    // The #296 gap in one assertion: with no painted surface, a light theme's
    // near-black --ink rendered directly over whichever theme the PAGE was
    // wearing. Against a dark-bg theme that pairing is catastrophically under
    // the floor — which no per-theme check could see.
    const ink = hexToRgb(themeBlocks['summer-white']!.ink);
    const darkThemes = THEMES.filter((t) => t.id !== 'summer-white' && !isLight(t.id));
    expect(darkThemes.length).toBeGreaterThan(0);
    for (const t of darkThemes) {
      const pageBg = hexToRgb(themeBlocks[t.id]!.bg);
      expect(
        contrastRatio(ink, pageBg),
        `summer-white --ink over ${t.id} --bg should document the pre-fix failure`,
      ).toBeLessThan(TEXT_MIN);
    }
  });

  it('the same regression runs the other way: a DARK theme\'s --ink over a light page', () => {
    // The mirror case, which only became reachable once a second light Theme
    // existed. It is the same structural bug — the fix is the painted surface,
    // not the palette — so it belongs beside the original rather than as a
    // footnote to it.
    const lightThemes = THEMES.filter((t) => isLight(t.id));
    expect(lightThemes.length).toBeGreaterThanOrEqual(2);
    for (const light of lightThemes) {
      const pageBg = hexToRgb(themeBlocks[light.id]!.bg);
      const dark = THEMES.find((t) => !isLight(t.id))!;
      expect(
        contrastRatio(hexToRgb(themeBlocks[dark.id]!.ink), pageBg),
        `${dark.id} --ink over ${light.id} --bg should document the same pre-fix failure`,
      ).toBeLessThan(TEXT_MIN);
    }
  });
});

// ---------------------------------------------------------------------------
// #291: the themed wash spans the viewport. Scope B's checks assume body's
// gradient-tinted background IS the page surface, but the old
// `html, body, #root { min-height: 100% }` chain resolved every percentage
// against an auto-height parent, so on sparse screens body stopped at
// content height and index.html's flat pre-hydration shell color showed
// below it as a black band. Pinned structurally: the chain must use
// viewport units (dvh) so the surface Scope B polices actually covers the
// window.
// ---------------------------------------------------------------------------

describe('html/body/#root span the viewport (specs/theme-on-color-contrast.md, #291)', () => {
  it('the root sizing chain min-heights in dvh, not a percentage', () => {
    const rootChain = stripComments(ruleBlock(indexCss, '#root'));
    expect(rootChain).toMatch(/min-height:\s*100dvh\s*;/);
    expect(rootChain).not.toMatch(/min-height:\s*100%\s*;/);
  });
});

// ---------------------------------------------------------------------------
// The Share Card's own background layers a 30% --primary / 24% --secondary
// radial-gradient tint over --bg (src/components/ShareCard.tsx), the same
// self-referential trap as body's. The text-message-first redesign (issue
// #423) dropped the old B-I-N-G-O header (.share-card-bhead span) but the
// --ink text over that tint is now carried by the context line, the title,
// and the player name — so this legibility bound still guards a real surface.
// ---------------------------------------------------------------------------

describe('share-card gradient tints: --ink vs the composited backdrop (specs/theme-on-color-contrast.md)', () => {
  // Parse the tint weight from .share-card's own background rather than
  // hard-coding 0.30 (issue #72 Codex P3, PR #123 comment 3553469606).
  const shareCardBody = ruleBlock(indexCss, '.share-card');
  const primaryWeight = mixWeight(shareCardBody, 'primary');

  for (const t of THEMES) {
    const vars = themeBlocks[t.id] ?? {};
    it(`${t.id}: --ink meets ${TEXT_MIN}:1 against the ${primaryWeight * 100}% --primary tint over --bg (share-card context/title text)`, () => {
      const composite = mixSrgb(hexToRgb(vars.primary), hexToRgb(vars.bg), primaryWeight);
      expect(contrastRatio(hexToRgb(vars.ink), composite)).toBeGreaterThanOrEqual(TEXT_MIN);
    });
  }
});
