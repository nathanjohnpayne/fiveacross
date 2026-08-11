// Renders the PER-EDITION link-unfurl artwork from scripts/og/og-edition.html:
//
//   public/og-gcb.png          + plans/og-images/gay-cruise-bingo-og.png
//   public/og-vacay.png        + plans/og-images/vacay-bingo-og.png
//   public/og-fiveacross.png   + plans/og-images/five-across-og.png
//
// The `plans/og-images/` copies are the wireframes' reference assets and MUST
// stay byte-identical to the shipped ones — the wireframes doc claims they are
// the same render, and #681 makes that an acceptance criterion. This script
// writes both from one render so they cannot drift.
//
// WHY THIS EXISTS
//
// The originals (#609, landed via #642) were committed as binaries with no
// generator: `render-og-default.mjs` next door only builds og-default.png. So
// the first two content changes to them — #681 (Vacay's share mark moved from
// 🗺️ to 🧳) and #688 (Gay Cruise Bingo gained the BY FIVE ACROSS endorsement)
// — each began as an archaeology pass over a PNG. This script ends that: the
// COPY comes from `src/editions.ts`, so both of those changes are now brand-
// table edits plus a re-render.
//
// What lives here rather than in the brand table is ART DIRECTION — palette,
// board pattern, ornament geometry — because none of it is app copy and the
// app has no other consumer for it.
//
// Manual and local, exactly like render-og-default.mjs: the PNGs are committed
// assets, not build artifacts, so this is not wired into `npm run build` or CI.
//
// Usage:
//   node scripts/og/render-og-editions.mjs --edition vacay
//   node scripts/og/render-og-editions.mjs --all
//   node scripts/og/render-og-editions.mjs --edition vacay --out /tmp/preview
//
// `--edition` is required rather than defaulting to all three. A re-render is
// never byte-identical to the last one, so rendering the full set for a
// one-Edition change commits binary diffs to Editions whose artwork nobody
// asked to change — and each of those is a live link preview. Touch the
// Edition whose brand table row moved.
//
// Requirements:
//   - dev deps installed (`npm install`; uses the repo's playwright + esbuild)
//   - Playwright's chromium downloaded (`npx playwright install chromium`)
//   - network at render time (Anton/Oswald come from Google Fonts)
//   - macOS: the body copy resolves to Helvetica Neue and the share marks
//     rasterise as Apple Color Emoji, which is what the committed assets use.
//     Rendering elsewhere silently restyles both — the script refuses to run
//     off-darwin unless --allow-foreign-platform is passed.
//
// After rendering, prove you changed only what you meant to — render to a
// scratch directory first, then point the comparison at it:
//   node scripts/og/render-og-editions.mjs --edition vacay --out /tmp/og
//   node scripts/og/compare-og.mjs --new /tmp/og --edition vacay
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { transformSync } from 'esbuild';
import { assertWithinHardCap } from './og-size-guard.mjs';
import { scratchPathFor, screenshotOptionsFor } from './og-scratch-path.mjs';
import { commitStaged, discardStaged } from './og-stage-commit.mjs';
import { withDestinationLocks } from './og-commit-lock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const template = join(here, 'og-edition.html');

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const only = argOf('--edition');
const all = args.includes('--all');
const outDir = argOf('--out');
const allowForeign = args.includes('--allow-foreign-platform');

if (!only && !all) {
  console.error(
    'render-og-editions.mjs: pass --edition <id> (or --all). See the header for why there is no default.',
  );
  process.exit(1);
}

if (process.platform !== 'darwin' && !allowForeign) {
  console.error(
    [
      'render-og-editions.mjs: refusing to render off macOS.',
      '  The committed assets use Helvetica Neue for body copy and Apple Color Emoji',
      '  for the share marks. Another platform substitutes both, so the render would',
      '  differ everywhere rather than only where you meant it to.',
      '  Pass --allow-foreign-platform if you have accepted that.',
    ].join('\n'),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Copy comes from the brand table, art direction comes from here.
// ---------------------------------------------------------------------------

/** Load `src/editions.ts` in this Node process. esbuild strips the types; the
 *  module is deliberately free of `import.meta.env` and `document` at module
 *  scope (see its header) precisely so non-browser callers like this one and
 *  vite.config.ts can import it. */
function loadEditions() {
  const src = readFileSync(join(repo, 'src', 'editions.ts'), 'utf8');
  const js = transformSync(src, { loader: 'ts', format: 'cjs', target: 'node20' }).code;
  const module = { exports: {} };
  // The only import is a type-only one, which esbuild has already erased.
  new Function('module', 'exports', 'require', js)(module, module.exports, () => ({}));
  return module.exports;
}

const { editionBrand, wordmarkSegments } = loadEditions();

/** The share mark with U+FE0F (VARIATION SELECTOR-16) removed, for the design
 *  that wants the flat TEXT glyph rather than a colour emoji — Five Across's
 *  mark is a tinted asterisk, not Apple's multicolour sparkle. Written as an
 *  escape on purpose: a literal U+FE0F here is invisible in a diff,
 *  unsearchable, and one editor normalisation away from silently becoming a
 *  no-op that ships the wrong glyph. */
const textGlyph = (mark) => mark.replace(/\uFE0F/g, '');

/** Break a sentence into two lines after the Nth word. The template renders
 *  `white-space: pre-line`, so a newline here is the line break. */
const wrapAfter = (text, words) => {
  const parts = text.split(' ');
  return parts.slice(0, words).join(' ') + '\n' + parts.slice(words).join(' ');
};

const ART = {
  gcb: {
    file: 'og-gcb.png',
    mirror: 'gay-cruise-bingo-og.png',
    // The neon-playground register (src/theme/themes.css), same tokens the
    // og-default artboard uses.
    palette: {
      bg: '#07060d',
      ink: '#f6ecff',
      dim: '#b9a9d6',
      primary: '#ff2d95',
      secondary: '#00e6ff',
      accent: '#ffd23f',
      sqbg: '#181424',
      sqline: 'rgba(255,255,255,0.07)',
      barbg: '#36283c',
      onbar: 'rgba(20,10,30,0.45)',
      onglow: 'rgba(255,45,149,0.30)',
      ongrad: 'linear-gradient(145deg,#ff2d95,#00e6ff)',
      boardline: 'rgba(255,45,149,0.30)',
      boardshadow: '0 0 70px rgba(255,45,149,0.10)',
      freeink: '#1a1206',
    },
    background:
      'radial-gradient(820px 620px at 4% 2%, rgba(255,45,149,0.22), transparent 66%),' +
      'radial-gradient(780px 600px at 100% 100%, rgba(0,230,255,0.18), transparent 64%),' +
      '#07060d',
    eyebrow: { text: 'ONE SAILING AT A TIME' },
    // Anton, tracked open. The size/tracking pair is solved against the #609
    // render rather than guessed: cap height 81px, "GAY CRUISE" 422px wide.
    wordmark: { size: 93, lineHeight: 1.032, letterSpacing: '0.05em', glow: '0 0 42px rgba(255,45,149,0.28)' },
    rule: { width: 104, background: 'linear-gradient(90deg,#ff2d95,#00e6ff)' },
    // The words are the brand table's `appDescription`; the only thing art
    // direction owns is WHERE the line breaks, so the two-line block sits
    // square under the rule instead of running past the board.
    desc: { wrapAfterWords: 3 },
    // The endorsement row (#688) adds ~45px to a stack that used to fill the
    // frame symmetrically, so the whole lockup rides up to keep the top and
    // bottom margins even. Gaps otherwise mirror Vacay's rhythm — one family.
    left: { top: 85, gaps: { wordmark: 22, byline: 24, rule: 30, desc: 24, domain: 34 } },
    board: {
      x: 722,
      y: 94,
      size: 399,
      pad: 15,
      gap: 9,
      radius: 26,
      cellRadius: 13,
      freeLabel: 'FREE',
      pattern: ['x..x.', '.x..x', 'xxFxx', '.x...', 'x..x.'],
      // Prompt-rule lengths, per square, read off the #609 render: the long
      // rule fills the square's interior (~42px) and the short one runs ~69%
      // of it (~29px). `s`/`l` per rule, top then bottom.
      barShort: 69,
      barLong: 100,
      bars: [
        ['ls', 'sl', 'ls', 'ss', 'll'],
        ['sl', 'ls', 'ss', 'll', 'sl'],
        ['ls', 'sl', '..', 'll', 'ss'],
        ['ll', 'ss', 'ls', 'sl', 'ls'],
        ['sl', 'ls', 'ss', 'll', 'sl'],
      ],
    },
    caption: 'BINGO',
  },

  vacay: {
    file: 'og-vacay.png',
    mirror: 'vacay-bingo-og.png',
    // Pacific blue + sea glass, weathered orange accent — the Bodega register,
    // deliberately non-tropical.
    palette: {
      bg: '#0a141c',
      ink: '#e6eef2',
      dim: '#6b7d87',
      primary: '#2e7fa8',
      secondary: '#8fd0c3',
      accent: '#e8862e',
      sqbg: '#1b2a3a',
      sqline: 'rgba(255,255,255,0.06)',
      barbg: '#2e4759',
      onbar: 'rgba(10,25,35,0.40)',
      onglow: 'rgba(46,127,168,0.20)',
      ongrad: 'linear-gradient(150deg,#2e7fa8,#8fd0c3)',
      boardline: 'rgba(143,208,195,0.16)',
      boardbg: 'rgba(9,22,32,0.82)',
      // The stamp's scrim: the page ground at 0.70, so the board recedes
      // under the box instead of reading straight through it.
      stampscrim: 'rgba(10,20,28,0.70)',
      boardshadow: '0 22px 48px rgba(0,0,0,0.45)',
      freeink: '#1b1005',
    },
    background:
      'radial-gradient(820px 620px at 96% 6%, rgba(46,127,168,0.20), transparent 66%),' +
      'radial-gradient(760px 600px at 4% 96%, rgba(143,208,195,0.13), transparent 64%),' +
      '#0a141c',
    // The passport frame: a dashed rule inset from the bleed, the postcard tell
    // this Edition wears wherever it can.
    frame: { inset: 34, width: 2, radius: 4, color: 'rgba(150,196,208,0.36)' },
    eyebrow: { text: 'ONE TRIP AT A TIME' },
    // Cap height 79px, "VACAY" 225px wide, line pitch 94px — solved against
    // the #609 render the same way gcb's pair was.
    wordmark: { size: 90, lineHeight: 1.044, letterSpacing: '0.055em' },
    rule: { width: 100, background: 'linear-gradient(90deg,#2e7fa8,#8fd0c3)' },
    desc: { size: 26 },
    // The artwork names the Edition's own apex, NOT `ogUrl`'s hostname. Vacay
    // is the one Edition whose og:url is Event-scoped
    // (bodega-bay.vacaybingo.com) until the #546 Worker rewrites it per
    // hostname — see the field note on `EditionBrand.ogUrl`. An unfurl is a
    // brand impression, so it wears the brand's address; the other two
    // Editions' apexes and og:url hosts already agree, so only this row has to
    // say so.
    domain: 'vacaybingo.com',
    // Gaps are box-to-box, so they read smaller than the ink-to-ink rhythm
    // they produce (24 / 33 / 32 / 32 / 41 measured off the #609 render).
    left: { left: 82, top: 110, gaps: { wordmark: 12, byline: 19, rule: 28, desc: 24, domain: 33 } },
    board: {
      // Cell 56px, gap 10, pad 15 — measured off the #609 render's FREE
      // square, whose centre is the board's centre and so pins the position
      // through the rotation.
      x: 770,
      y: 150,
      size: 350,
      pad: 15,
      gap: 10,
      radius: 22,
      cellRadius: 12,
      // The postcard tilt. Measured off the #609 render's cell edges, not
      // chosen: a marked square's top edge rises 2 degrees to the right.
      rotate: -2,
      freeLabel: 'FREE',
      pattern: ['.x..x', 'x..x.', 'xxFxx', '..x..', 'x...x'],
      // Same two lengths as the cruise board. Unlike gcb's, this map is CHOSEN
      // rather than measured: the board is rotated, so de-rotating to read each
      // square's rules back costs more resampling error than the numbers are
      // worth. What matters for the comparison workflow is that the variation
      // is real and STABLE — a copy-only re-render reproduces it exactly.
      barShort: 69,
      barLong: 100,
      bars: [
        ['sl', 'll', 'ls', 'ss', 'ls'],
        ['ll', 'sl', 'ss', 'ls', 'sl'],
        ['ls', 'ss', '..', 'sl', 'll'],
        ['ss', 'ls', 'll', 'sl', 'ls'],
        ['sl', 'll', 'ls', 'ss', 'ls'],
      ],
    },
    // The dashed stamp box over the board's shoulder. Its glyph is the same
    // share mark as the eyebrow, which is what made #681 a one-line change.
    stamp: { x: 1028, y: 56, w: 106, h: 126, text: 'TAKE THE DETOUR' },
    caption: 'BINGO',
  },

  fiveacross: {
    file: 'og-fiveacross.png',
    mirror: 'five-across-og.png',
    // The platform: slate and cobalt, set type, no glow. Restraint is the
    // differentiation (wireframes § the three identities).
    palette: {
      bg: '#0f1116',
      ink: '#f2f4f8',
      dim: '#98a1b0',
      primary: '#3f66f0',
      secondary: '#2c4bd8',
      accent: '#f5c451',
      sqbg: '#191c25',
      sqline: 'rgba(255,255,255,0.07)',
      barbg: '#2b303c',
      onbar: 'rgba(255,255,255,0.55)',
      onglow: 'transparent',
      ongrad: 'linear-gradient(145deg,#3f66f0,#2c4bd8)',
      boardline: 'rgba(255,255,255,0.10)',
      freeink: '#171410',
    },
    background:
      'radial-gradient(900px 640px at 78% 30%, rgba(63,102,240,0.10), transparent 70%),' +
      '#0f1116',
    backgroundGrid:
      'repeating-linear-gradient(90deg, rgba(255,255,255,0.028) 0 1px, transparent 1px 96px),' +
      'repeating-linear-gradient(0deg, rgba(255,255,255,0.028) 0 1px, transparent 1px 96px)',
    eyebrow: { text: 'THE PLATFORM', markStyle: 'glyph' },
    // Set, not stacked: one line, light lead and heavy second word.
    // Cap height 53px, "FIVE ACROSS" 515px wide — the platform's wordmark is
    // tracked noticeably wider than the two Editions' stacked Anton marks,
    // which is most of what makes it read as set type rather than display.
    wordmark: { style: 'set', size: 71, lineHeight: 1, letterSpacing: '0.14em' },
    rule: { width: 73, background: '#3f66f0' },
    desc: {},
    left: { top: 177, gaps: { wordmark: 24, byline: 0, rule: 31, desc: 27, domain: 41 } },
    board: {
      x: 708,
      y: 90,
      size: 412,
      pad: 16,
      gap: 10,
      radius: 20,
      cellRadius: 10,
      // The platform's own mark sits in the free square, the way the other
      // two Editions' spell FREE — resolved from the brand table below.
      freeLabel: null,
      pattern: ['.....', '.....', 'xxFxx', '.....', '.....'],
      // The platform's board is quieter than the Editions': its rules sit
      // shorter and closer in length, which is the same restraint the set
      // wordmark and unglowing type carry.
      barShort: 62,
      barLong: 78,
      bars: [
        ['ls', 'sl', 'ls', 'sl', 'ls'],
        ['sl', 'ls', 'sl', 'ls', 'sl'],
        ['ll', 'll', '..', 'll', 'll'],
        ['ls', 'sl', 'ls', 'sl', 'ls'],
        ['sl', 'ls', 'sl', 'ls', 'sl'],
      ],
    },
    caption: 'BINGO',
  },
};

// ---------------------------------------------------------------------------

// WhatsApp caps og:image at 600 KB; iMessage/Telegram recommend <= 1 MB. The
// budget sits below the hard cap so a render that drifts over it is crushed
// before a messenger silently drops the preview.
const SIZE_BUDGET_BYTES = 500 * 1024;

// The hard cap itself (#699): whatever survives quantisation — or the
// lossless render, if pngquant is missing or fails — MUST clear this before
// it is allowed to replace a committed copy. Automation checks this script's
// exit status to decide whether an asset is safe to ship; a link preview that
// silently fails to unfurl on WhatsApp is exactly what that check exists to
// catch.
const HARD_CAP_BYTES = 600 * 1024;

const GOOGLE_FONTS_CSS_PATTERN = /^https:\/\/fonts\.googleapis\.com\/css2\?/;
const EXPECTED_FACES = [
  { family: 'Anton', weight: 400 },
  { family: 'Oswald', weight: 700 },
];

/** Assemble the render config: art direction from ART, every word from the
 *  brand table. The mapping is deliberately total — if a field the artwork
 *  shows has a brand-table home, it reads it from there. */
function configFor(id) {
  const art = ART[id];
  const brand = editionBrand(id);
  // The canonical splitter, not a second copy of it. `wordmarkSegments` is
  // what the app header uses and what `editions.test.ts` pins — including its
  // degrade-to-unbolded behaviour when the bold segment is not a suffix. A
  // private reimplementation here would let the app and the unfurl split the
  // same Edition differently while both kept running (Codex P1 on #697).
  const { lead, bold } = wordmarkSegments(brand);
  // Default to the og:url host — for gcb and fiveacross that IS the brand's
  // apex. An Edition whose og:url is Event-scoped overrides it (see vacay).
  const domain = art.domain ?? new URL(brand.ogUrl).hostname.replace(/^www\./, '');
  const isGlyph = art.eyebrow.markStyle === 'glyph';
  const shareMark = isGlyph ? textGlyph(brand.lexicon.shareMark) : brand.lexicon.shareMark;
  return {
    id,
    palette: art.palette,
    background: art.background,
    backgroundGrid: art.backgroundGrid ?? null,
    frame: art.frame ?? null,
    eyebrow: { mark: shareMark, text: art.eyebrow.text, markStyle: art.eyebrow.markStyle ?? 'emoji' },
    wordmark: { ...art.wordmark, lead: lead.trimEnd(), bold },
    // The endorsement line the brand table carries, verbatim. gcb and vacay do;
    // fiveacross IS the platform, so it has none and the row collapses.
    byline: brand.wordmarkByline ?? null,
    rule: art.rule,
    // Brand-table copy, wrapped where the art direction asks. `appDescription`
    // is the same sentence the manifest and the share block carry — retyping it
    // here is exactly the drift this generator exists to stop.
    desc: {
      ...art.desc,
      text: art.desc.wrapAfterWords
        ? wrapAfter(brand.appDescription, art.desc.wrapAfterWords)
        : brand.appDescription,
    },
    domain,
    left: art.left,
    // The platform draws its share mark in the free square instead of the
    // word FREE; resolving it here keeps it tied to the brand table.
    board: { ...art.board, freeLabel: art.board.freeLabel ?? textGlyph(brand.lexicon.shareMark) },
    stamp: art.stamp ? { ...art.stamp, mark: brand.lexicon.shareMark } : null,
    caption: art.caption,
  };
}

const targets = only ? [only] : Object.keys(ART);
for (const id of targets) {
  if (!ART[id]) {
    console.error(`Unknown edition "${id}". Known: ${Object.keys(ART).join(', ')}`);
    process.exit(1);
  }
}

const browser = await chromium.launch();
// Every edition's render is staged to its scratch path here first (#699) and
// ONLY moved into its committed destination once every targeted edition has
// individually cleared the hard cap (#713 on `--all`): if edition 3 of 3
// fails, editions 1 and 2 must still not have replaced anything in `public/`
// or the wireframes mirror. Renaming inside the per-edition loop, as the
// original version of this script did, broke that guarantee for `--all` —
// it made the earlier passing editions durable before the later ones had
// even been checked, so a late failure left a partially-updated render set
// contradicting the fail-before-overwrite behaviour this file exists for.
const staged = [];
let written;
try {
  for (const id of targets) {
    const config = configFor(id);
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });

    let stylesheetResponse = null;
    let stylesheetRequestFailure = null;
    page.on('response', (r) => {
      if (GOOGLE_FONTS_CSS_PATTERN.test(r.url())) stylesheetResponse = r;
    });
    page.on('requestfailed', (r) => {
      if (GOOGLE_FONTS_CSS_PATTERN.test(r.url())) {
        stylesheetRequestFailure = r.failure()?.errorText ?? 'unknown error';
      }
    });

    await page.goto(pathToFileURL(template).href, { waitUntil: 'load', timeout: 120_000 });
    await page.evaluate((c) => window.__OG_RENDER__(c), config);
    await page.evaluate(() => document.fonts.ready);

    // Same fail-closed posture as render-og-default.mjs: a degraded font load
    // ships a system-fallback wordmark that looks almost right, which is worse
    // than a failed render.
    const problems = [];
    if (!stylesheetResponse) {
      problems.push(
        `Google Fonts stylesheet request never completed (${stylesheetRequestFailure ?? 'network unreachable or blocked'})`,
      );
    } else if (!stylesheetResponse.ok()) {
      problems.push(`Google Fonts stylesheet returned HTTP ${stylesheetResponse.status()}`);
    }
    const missing = await page.evaluate(
      (faces) => faces.filter(({ family, weight }) => !document.fonts.check(`${weight} 24px "${family}"`)),
      EXPECTED_FACES,
    );
    if (missing.length > 0) {
      problems.push(`web font faces failed to load: ${missing.map((f) => `${f.family} ${f.weight}`).join(', ')}`);
    }
    const ready = await page.evaluate(() => document.body.dataset.ogReady === '1');
    if (!ready) problems.push('template never signalled ogReady — __OG_RENDER__ threw');
    if (problems.length > 0) {
      throw new Error(
        [`render-og-editions.mjs: refusing to write a degraded ${id} render.`, ...problems.map((p) => `  - ${p}`)].join('\n'),
      );
    }

    const dest = outDir ? join(outDir, ART[id].file) : join(repo, 'public', ART[id].file);
    mkdirSync(dirname(dest), { recursive: true });
    // Render to a scratch path next to `dest`, NOT `dest` itself (#699): the
    // hard-cap check below must be able to refuse a bad render without ever
    // having touched the committed copy it would otherwise have overwritten.
    // The path is `.png`-suffixed and `type: 'png'` is passed explicitly
    // (#713): Playwright infers the screenshot format from `path`'s
    // extension and throws for anything else unless `type` overrides it, so
    // a scratch suffix without a recognised image extension fails the
    // screenshot itself, before the hard-cap guard it was meant to protect
    // ever runs.
    // Computed once and reused for both the screenshot write and every later
    // reference (stage bookkeeping, size checks, commit) — `scratchPathFor`
    // mints a fresh random token per call (#713 round 3), so calling it
    // twice for the "same" file would silently produce two different paths.
    const scratch = scratchPathFor(dest);
    await page.screenshot(screenshotOptionsFor(scratch));
    await page.close();

    // Crush ONLY if the lossless render misses the size budget. og-default.png
    // is quantised because at 2400x1260 it is ~1.6 MB lossless and WhatsApp
    // caps og:image at 600 KB; at 1200x630 these land near 250 KB, so there is
    // nothing to buy. And quantising is not free on this artwork: the palette
    // takes the corner radial washes from ~70 distinct values across a row to
    // ~16, which is invisible at size but shows as contour rings under
    // contrast amplification. The #609 originals were truecolor; so are these.
    const losslessBytes = statSync(scratch).size;
    if (losslessBytes > SIZE_BUDGET_BYTES) {
      try {
        execFileSync(
          'pngquant',
          ['--quality=75-95', '--speed', '1', '--strip', '--force', '--output', `${scratch}.quant`, scratch],
          { stdio: 'inherit' },
        );
        renameSync(`${scratch}.quant`, scratch);
        console.warn(
          `  ${id}: ${(losslessBytes / 1024).toFixed(0)} KB lossless exceeded the ` +
            `${(SIZE_BUDGET_BYTES / 1024).toFixed(0)} KB budget — quantised to ` +
            `${(statSync(scratch).size / 1024).toFixed(0)} KB. Check the washes for banding.`,
        );
      } catch {
        console.warn(`  ${id}: over budget and pngquant is unavailable — shipping the lossless PNG.`);
      }
    }

    // The hard cap (#699): refuse to replace the committed copies with a
    // render known not to unfurl. Whatever caused it — pngquant missing,
    // pngquant failing, or the artwork just being too heavy even quantised —
    // the failure happens BEFORE `dest` or the wireframes mirror is touched,
    // and the process exits nonzero so automation checking this script's
    // status does not accept the asset.
    const finalBytes = statSync(scratch).size;
    try {
      assertWithinHardCap(id, finalBytes, HARD_CAP_BYTES);
    } catch (err) {
      unlinkSync(scratch);
      throw err;
    }

    // Stage only — do NOT touch `dest` or the wireframes mirror yet. See the
    // note above `staged`: committing here, inside the per-edition loop,
    // is exactly what made `--all` non-atomic (#713).
    const mirror = outDir
      ? join(outDir, ART[id].mirror)
      : join(repo, 'plans', 'og-images', ART[id].mirror);
    staged.push({ id, scratch, dest, mirror, bytes: finalBytes });
  }

  // Every targeted edition cleared the hard cap — commit them all now, in
  // one pass, so a run either updates every targeted destination or (per
  // the catch below) none of them. This runs INSIDE the same try as the
  // render loop (#713 round 3): `commitStaged` has its own internal
  // rollback for a failure mid-commit (a mirror going unwritable, the disk
  // filling), but that rollback only restores destinations/mirrors — it
  // does not know about scratch files still on disk for editions this call
  // never reached. Staying inside this try means a commit-phase failure
  // reaches the same `catch` as a render-phase one, so `discardStaged`
  // still runs and sweeps those up.
  //
  // Locked for the WHOLE commit-or-rollback phase, not just the call to
  // `commitStaged` — see og-commit-lock.mjs's header (#713 round 4, id
  // 3762521202). Unique scratch paths (round 3) stop two invocations from
  // clobbering each other's STAGED bytes, but say nothing about two
  // invocations publishing the same destination at once: without this,
  // their rename-then-copy pairs (and their identically-named
  // `*.rollback-tmp` backups) can interleave, so the destination that
  // survives can come from one process while the mirror that survives
  // comes from the other. Acquired only here, not around the render loop
  // above — staging writes to per-invocation scratch paths that never
  // touch a shared destination, so there is nothing to serialize before
  // this point.
  const releaseLocks = withDestinationLocks(staged);
  try {
    written = commitStaged(staged).map((w) => ({ ...w, bytes: statSync(w.dest).size }));
  } finally {
    releaseLocks();
  }
} catch (err) {
  // Either a later edition failed its hard cap (or a font/render problem
  // threw first) — every earlier edition in this run already passed its own
  // guard and is sitting in a scratch file, not yet committed — or
  // `commitStaged` itself failed partway and already rolled every
  // destination/mirror it touched back to its pre-commit bytes. Either way,
  // sweep up whatever scratch files remain (this tolerates the ones
  // `commitStaged` already consumed) so a failed run doesn't leave stray
  // `*.render-tmp.*.png` files behind, and rethrow so the process still
  // exits nonzero and `public/` (and the mirror) stay exactly as they were
  // before this run started.
  discardStaged(staged);
  throw err;
} finally {
  await browser.close();
}

// Every entry here already cleared HARD_CAP_BYTES — a render that didn't
// threw above and never reached `written`, so there is nothing left to warn
// about post hoc.
for (const w of written) {
  console.log(`${w.id.padEnd(11)} ${(w.bytes / 1024).toFixed(0).padStart(4)} KB  ${w.dest}`);
  console.log(`${''.padEnd(11)}      mirrored -> ${w.mirror}`);
}
