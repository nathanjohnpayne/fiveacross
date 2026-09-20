// Re-renders the wireframes' reference pictures of the final-standings share
// card, photo-hero composition:
//
//   plans/og-images/share-final-photo-gcb.png
//   plans/og-images/share-final-photo-vacay.png
//   plans/og-images/share-final-photo-fa.png
//
// WHY THIS EXISTS (#887). Until now these three PNGs had no generator: every
// refresh was a hand-driven screen capture, and #867's refresh caught an
// adjacent frame in shot — a scaled Vacay final-standings card composited over
// the upper-right corner of the GCB one, obscuring the wordmark line and half
// of FINAL STANDINGS. A hand capture also cannot be re-run, so the GCB card
// still read `Turntilla` on its 👑 row long after the artboard beside it was
// corrected to `Logan Murdock`. Both failures are the same failure: the asset
// had no reproducible source.
//
// It does now, and it was already in the tree. `plans/daily-cards-wireframes.html`
// draws each card as a live `.shc` artboard at HALF scale (300×375 CSS px
// representing the rendered 600×750), and the committed PNGs are 2× captures
// of exactly those elements — same page ground in the rounded corners, same
// Arial Narrow display face, same token-tinted placeholder scene. So this
// script opens that document in Playwright's chromium at
// `deviceScaleFactor: 2` and screenshots the artboard. The artboard is the
// source; the PNG is its render.
//
// This is NOT a capture of `src/components/ShareCard.tsx`. That component
// renders on the Player's own device from a real photo blob (ADR 0005) and has
// no offline harness, no placeholder scene and no sample Event — which is why
// the references were ever hand-made. The artboard is the design source both
// the component and these pictures answer to; `specs/w2-share-cards.md` and
// `specs/most-loved-photo.md` own the places the two deliberately differ (the
// crown row's dropped stat, for one).
//
// Brand-owned copy is not trusted to the artboard. The footer line is
// rewritten from `src/editions.ts` before the capture, exactly as
// `render-share-footer.mjs` draws it (`${appName} ${lexicon.shareMark}`,
// uppercased by the artboard's own CSS), so a share-mark change stays a
// one-table edit plus a re-run rather than an edit in two places.
//
// Usage:
//   node scripts/og/render-share-rasters.mjs --edition gcb
//   node scripts/og/render-share-rasters.mjs --all
//   node scripts/og/render-share-rasters.mjs --edition gcb --out /tmp/rasters
//   node scripts/og/render-share-rasters.mjs --edition gcb --check   # report only
//
// `--edition` is required rather than defaulting to all three, on the same
// reasoning `render-og-editions.mjs` and `render-share-footer.mjs` give: a
// re-render is never byte-identical to the last one, so running the full set
// for a one-Edition change commits binary diffs to cards nobody asked to
// change. `--out` writes to a scratch directory instead of the repo, which is
// what you want for a first look.
//
// The output is truecolor and NOT quantised, matching the committed captures
// (colour type 2) and `render-og-editions.mjs`'s posture: a palette pass
// perturbs pixels everywhere, which is exactly what makes "prove the only
// thing that moved is the thing you meant to move" impossible.
//
// Requirements: playwright + esbuild (dev deps), `npx playwright install
// chromium`, and macOS — the artboards resolve to Helvetica Neue and Arial
// Narrow and their marks rasterise as Apple Color Emoji, which is what the
// committed assets use. Do not suppress the output: this fails closed on a
// bad frame or a wrong-sized capture, and `>/dev/null 2>&1` turns that into a
// silent no-op that reads downstream as "the change had no effect".
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildSync } from 'esbuild';
import { scratchPathFor, screenshotOptionsFor } from './og-scratch-path.mjs';
import { lightPixelShare, readPngHeader, readPngPixels } from './png-pixels.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const args = process.argv.slice(2);
const argOf = (f) => {
  const i = args.indexOf(f);
  return i === -1 ? null : args[i + 1];
};
const only = argOf('--edition');
const all = args.includes('--all');
const checkOnly = args.includes('--check');
const outDir = argOf('--out');

if (!only && !all) {
  console.error(
    'render-share-rasters.mjs: pass --edition <id> (or --all). See the header for why there is no default.',
  );
  process.exit(1);
}
// A value-less `--out` would otherwise fall back to the committed directory,
// which is the one place someone reaching for `--out` is trying not to write.
if (args.includes('--out') && !outDir) {
  console.error('render-share-rasters.mjs: --out needs a directory.');
  process.exit(1);
}
if (process.platform !== 'darwin' && !args.includes('--allow-foreign-platform')) {
  console.error('render-share-rasters.mjs: refusing to render off macOS (Apple Color Emoji / Helvetica Neue / Arial Narrow).');
  process.exit(1);
}

/**
 * Load the brand table the way the app resolves it.
 *
 * `src/editions.ts` is BUNDLED here, not merely transpiled. Its neighbours
 * next door (`render-og-editions.mjs`, `render-share-footer.mjs`) transpile
 * the single file and hand it a `require` that returns `{}`, on a comment that
 * says "the only import is a type-only one" — which stopped being true once
 * the module started importing `EDITION_IDS` and `brandFor` for real values.
 * As of this writing both of those scripts die on load with `Cannot read
 * properties of undefined (reading 'VACAY_BINGO')`; that is their own defect,
 * not this one's, and it is what this loader is written not to repeat.
 * Bundling resolves the sibling modules instead of stubbing them, so the
 * loader cannot rot the next time the brand table grows an import.
 *
 * `import.meta.env.VITE_EDITION` is defined away because `seedEdition()` reads
 * it. Nothing here ever reaches that path — every lookup below passes an
 * explicit Edition id — but esbuild will not emit a CJS bundle containing
 * `import.meta` without being told what it is.
 */
function loadEditions() {
  const bundled = buildSync({
    entryPoints: [join(repo, 'src', 'editions.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    define: { 'import.meta.env.VITE_EDITION': 'undefined' },
    logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(
    module,
    module.exports,
    () => ({}),
  );
  return module.exports;
}
const { editionBrand } = loadEditions();

/** The artboard each committed picture is a render of. Edition ids match the
 *  brand table (`src/edition-brands.ts`), so `editionBrand(id)` resolves. */
const CARDS = {
  gcb: { frame: 'fx-share-final-photo-gcb', file: 'share-final-photo-gcb.png' },
  vacay: { frame: 'fx-share-final-photo-vacay', file: 'share-final-photo-vacay.png' },
  fiveacross: { frame: 'fx-share-final-photo-fa', file: 'share-final-photo-fa.png' },
};
const CARD_W = 600;
const CARD_H = 750;
/** The artboards are drawn at half scale, so the capture runs at 2× to land on
 *  the committed 600×750. */
const SCALE = 2;
/**
 * Upper-right quadrant near-white share above which the capture is rejected.
 *
 * This is the #887 defect expressed as a number a machine can check: the
 * overlaid Vacay card was a large cream block in that quadrant and scored
 * 27.4%, while the clean dark-ground artboards score a few percent of thin
 * antialiased ink. Vacay's own card is cream end to end and is exempted below
 * rather than scored against a threshold that means nothing for it.
 */
const MAX_DARK_CARD_LIGHT_SHARE = 0.12;

const ids = only ? [only] : Object.keys(CARDS);
for (const id of ids) {
  if (!CARDS[id]) {
    console.error(`Unknown edition "${id}". Known: ${Object.keys(CARDS).join(', ')}`);
    process.exit(1);
  }
}

/** Fix `frame` at the viewport origin and return the undo. */
async function pinToOrigin(frame) {
  const before = await frame.evaluate((node) => {
    const previous = {
      position: node.style.position,
      left: node.style.left,
      top: node.style.top,
      zIndex: node.style.zIndex,
    };
    node.style.position = 'fixed';
    node.style.left = '0px';
    node.style.top = '0px';
    node.style.zIndex = '2147483647';
    return previous;
  });
  return () =>
    frame.evaluate((node, previous) => {
      node.style.position = previous.position;
      node.style.left = previous.left;
      node.style.top = previous.top;
      node.style.zIndex = previous.zIndex;
    }, before);
}

const destDir = outDir ?? join(repo, 'plans', 'og-images');
if (outDir) mkdirSync(outDir, { recursive: true });
const wireframes = pathToFileURL(join(repo, 'plans', 'daily-cards-wireframes.html')).href;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1200 },
    deviceScaleFactor: SCALE,
  });
  await page.goto(wireframes, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  for (const id of ids) {
    const card = CARDS[id];
    const brand = editionBrand(id);
    const footer = `${brand.appName} ${brand.lexicon.shareMark}`;
    const frame = page.locator(`#${card.frame} .shc`);
    if ((await frame.count()) !== 1) {
      throw new Error(`render-share-rasters.mjs: #${card.frame} .shc did not match exactly one artboard.`);
    }

    // Brand-table copy wins over whatever the artboard has typed into it.
    const replaced = await frame.evaluate((node, line) => {
      const foot = node.querySelector('.foot');
      if (!foot) throw new Error('artboard has no .foot line');
      const before = foot.textContent;
      foot.textContent = line;
      return before;
    }, footer);
    if (replaced.trim() !== footer) {
      console.warn(`${id.padEnd(11)} artboard footer "${replaced.trim()}" replaced with brand-table "${footer}"`);
    }

    const dest = join(destDir, card.file);
    if (checkOnly) {
      console.log(`${id.padEnd(11)} would write ${dest} — footer "${footer}"`);
      continue;
    }

    // Pin the artboard to the viewport origin for the capture, and un-pin it
    // straight afterwards.
    //
    // Pinning, because in the document flow the artboard lands on a fractional
    // y and Playwright rounds the clip outwards from there — a 600×752 capture
    // of a 600×750 card, off by one device row at each end. A fixed origin
    // makes the box integral, and it also brings the artboard on screen
    // however far down the document it sits. Nothing about the card's own
    // rendering changes: it carries explicit width, height and
    // `box-sizing: border-box`, and the ground behind its rounded corners is
    // the same page background either way.
    //
    // Un-pinning, because `--all` reuses one page: leaving the previous card
    // stacked at the same origin would put it behind the next one, and the
    // antialiased pixels along the rounded corner arc would composite over
    // Vacay's cream card instead of over the page. That is a one-pixel version
    // of exactly the defect this script exists to stop shipping.
    const restore = await pinToOrigin(frame);
    const scratch = scratchPathFor(dest);
    try {
      await frame.screenshot(screenshotOptionsFor(scratch));
    } finally {
      await restore();
    }
    try {
      const bytes = readFileSync(scratch);
      const { width, height, colorType } = readPngHeader(bytes);
      if (width !== CARD_W || height !== CARD_H) {
        throw new Error(
          `render-share-rasters.mjs: ${id} captured ${width}×${height}, expected ${CARD_W}×${CARD_H}. ` +
            'The artboard is drawn at half scale, so the capture must run at 2×.',
        );
      }
      let lightShare = null;
      if (id !== 'vacay') {
        lightShare = lightPixelShare(readPngPixels(bytes), {
          x: CARD_W / 2,
          y: 0,
          width: CARD_W / 2,
          height: CARD_H / 2,
        });
        if (lightShare > MAX_DARK_CARD_LIGHT_SHARE) {
          throw new Error(
            `render-share-rasters.mjs: ${id}'s upper-right quadrant is ${(lightShare * 100).toFixed(1)}% ` +
              `near-white (cap ${(MAX_DARK_CARD_LIGHT_SHARE * 100).toFixed(0)}%) — something is composited over the card (#887).`,
          );
        }
      }
      renameSync(scratch, dest);
      const kb = (statSync(dest).size / 1024).toFixed(0);
      const light = lightShare === null ? 'n/a (cream ground)' : `${(lightShare * 100).toFixed(1)}%`;
      console.log(
        `${id.padEnd(11)} wrote ${dest} — ${width}×${height}, colour type ${colorType}, ${kb} KB, ` +
          `upper-right near-white ${light}, footer "${footer}"`,
      );
    } catch (error) {
      try {
        unlinkSync(scratch);
      } catch {
        /* the staged file may already be gone; the original render error is what matters */
      }
      throw error;
    }
  }
} finally {
  await browser.close();
}
if (checkOnly) console.log('\n--check: nothing written.');
