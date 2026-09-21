// Refreshes the BRAND FOOTER on the wireframes' reference share cards:
//
//   plans/og-images/share-final-photo-gcb.png
//   plans/og-images/share-final-photo-vacay.png
//   plans/og-images/share-final-photo-fa.png
//
// Those PNGs are renders of the `.shc` artboards in
// `plans/daily-cards-wireframes.html` (see render-share-rasters.mjs, #887).
// `ShareCard.tsx` draws the real card's footer as
// `${appName} ${lexicon.shareMark}` (three call sites), so the moment the
// brand table changes a share mark the shipped app is already correct and only
// these reference pictures are stale. #681 is exactly that case: #678 moved
// Vacay's mark from 🗺️ to 🧳 in the table, the running app followed, and the
// wireframes' card kept showing a map.
//
// So this script does not re-draw the card — it re-draws the one line the
// brand table owns, in place, reading `appName` and `lexicon.shareMark` from
// `src/editions.ts` exactly like render-og-editions.mjs does. The next share
// mark change is a table edit plus a re-run.
//
// SCOPE, stated plainly: everything else in these cards (the photo hero, the
// standings rows, the honors chips) comes from the artboard and is left
// untouched here. If anything other than the footer line changes, this is the
// wrong tool: edit the artboard and re-run
// `render-share-rasters.mjs --edition <id>`. Repainting one 32-row band is
// the cheaper answer only while the footer is all that moved.
//
// OUTPUT FORMAT (#887 round 4). The committed cards are 8-bit non-interlaced
// truecolor (PNG colour type 2) and `src/recon-share-og.test.ts` requires
// exactly that of the files in the tree. A 2D canvas carries an alpha channel,
// so `toDataURL('image/png')` encodes colour type 6 no matter how opaque the
// pixels it composited are — this tool used to write that straight over the
// committed card while its own comment claimed the output was truecolor, and
// the first thing that would have noticed is a red suite with the good picture
// already replaced. Removing the earlier `pngquant` pass fixed colour type 3
// and never touched this. The canvas bytes are now converted down to RGB
// (`png-truecolor.mjs`, which proves every alpha byte is 255 before it drops
// the plane and refuses by coordinate if one is not), the result is staged
// beside its destination and validated by the SAME guard the raster generator
// runs (`assertCapturedCardFormat` via `inspectCapture`), and only then
// published. `--all` publishes all three or none of them, through the same
// `commitStaged` phase.
//
// Usage:
//   node scripts/og/render-share-footer.mjs --edition vacay
//   node scripts/og/render-share-footer.mjs --all
//   node scripts/og/render-share-footer.mjs --edition vacay --check   # report only
//
// `--edition` is required rather than defaulting to all three, because a
// re-render rewrites the PNG whether or not its mark actually moved: running
// the full set for a one-Edition change commits two binary diffs that carry no
// content change. Touch the Edition whose brand table row moved.
//
// Requirements: playwright + esbuild (dev deps), macOS for Apple Color Emoji.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toTruecolorPng } from './png-truecolor.mjs';
import { renderCardSet } from './render-share-rasters.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

// Geometry measured off the committed cards. The band is the full-width strip
// the footer line occupies; it is repainted with the card's own background
// colour, sampled from inside the band well left of the centred text, so this
// works on Vacay's cream ground and the other two Editions' dark ones alike.
export const CARDS = {
  gcb: { file: 'share-final-photo-gcb.png', ink: '#d0a8ab' },
  vacay: { file: 'share-final-photo-vacay.png', ink: '#8a857b' },
  fiveacross: { file: 'share-final-photo-fa.png', ink: '#9aa3b2' },
};
export const BAND = { y: 694, h: 32, sampleX: 90 };
export const CENTRE_X = 300;
export const CARD_W = 600;

const DATA_URL_PREFIX = 'data:image/png;base64,';

/**
 * Turn a band-painting step into the `capture` seam `renderCardSet` takes.
 *
 * `paint(id)` hands back exactly what `canvas.toDataURL('image/png')` returns:
 * a `data:image/png;base64,…` string. Everything between that and a staged
 * file lives here rather than in the CLI, so the conversion and its refusal
 * are exercised by render-share-footer.test.mjs through the same seam the
 * raster generator's staging tests use — with a synthetic RGBA image in place
 * of a browser.
 */
export function footerCaptureFrom(paint) {
  return async (id, scratch) => {
    const dataUrl = await paint(id);
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(DATA_URL_PREFIX)) {
      // Without this, a canvas that returned `data:,` on an encode failure
      // would split to `undefined` and stage an empty file, and the reader
      // would then blame the PNG rather than the encoder.
      throw new Error(
        `render-share-footer.mjs: the canvas did not return a PNG data URL for ${id} ` +
          `(got ${typeof dataUrl === 'string' ? `${dataUrl.slice(0, 32)}…` : typeof dataUrl}).`,
      );
    }
    const encoded = Buffer.from(dataUrl.slice(DATA_URL_PREFIX.length), 'base64');
    // Converted here, not written here: the staged file is what the format
    // guard reads, so what gets proved is the byte sequence that will become
    // the committed card, not an intermediate nobody publishes.
    writeFileSync(scratch, toTruecolorPng(encoded, id));
  };
}

/** Read the card, sample its background inside the band, repaint the band and
 *  draw the footer — all in one canvas pass, so the new type is antialiased
 *  against the same ground the old type was. Returns the canvas data URL plus
 *  the numbers the run reports. */
async function paintBand(page, { b64, band, ink, line, centreX, cardW }) {
  return page.evaluate(
    async ({ b64, band, ink, line, centreX, cardW }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const [r, g, bl] = ctx.getImageData(band.sampleX, band.y + Math.floor(band.h / 2), 1, 1).data;
      const bg = `rgb(${r},${g},${bl})`;
      ctx.fillStyle = bg;
      // Clear the OLD line row by row, walking in from each edge until the
      // pixel already matches the card's interior ground. A full-width
      // fillRect is the obvious version and it is wrong: these cards carry a
      // rounded outer border, so it painted over the card's own outline and
      // left a 32-row gap in it on both sides. Deriving the interior span per
      // row instead of hardcoding an inset keeps that true through the
      // corner curvature, and on any Edition's border width or colour.
      const rows = ctx.getImageData(0, band.y, cardW, band.h);
      const matches = (i) =>
        Math.abs(rows.data[i] - r) <= 2 &&
        Math.abs(rows.data[i + 1] - g) <= 2 &&
        Math.abs(rows.data[i + 2] - bl) <= 2;
      for (let row = 0; row < band.h; row++) {
        const base = row * cardW * 4;
        let left = 0;
        while (left < cardW && !matches(base + left * 4)) left++;
        let right = cardW - 1;
        while (right > left && !matches(base + right * 4)) right--;
        if (right > left) ctx.fillRect(left, band.y + row, right - left + 1, 1);
      }
      // Letter-spaced uppercase, matching the committed cards' footer.
      ctx.letterSpacing = '3px';
      ctx.font = '400 16px "Helvetica Neue", Helvetica, Arial, sans-serif';
      ctx.fillStyle = ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(line, centreX, band.y + band.h / 2 + 1);
      const w = ctx.measureText(line).width;
      // Colour type 6, because the context has an alpha channel. The caller
      // converts and proves; see the OUTPUT FORMAT note in the header.
      return { png: c.toDataURL('image/png'), bg, width: Math.round(w) };
    },
    { b64, band, ink, line, centreX, cardW },
  );
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = (f) => {
    const i = args.indexOf(f);
    return i === -1 ? null : args[i + 1];
  };
  const only = argOf('--edition');
  const all = args.includes('--all');
  const checkOnly = args.includes('--check');
  if (!only && !all) {
    console.error(
      'render-share-footer.mjs: pass --edition <id> (or --all). See the header for why there is no default.',
    );
    process.exit(1);
  }

  if (process.platform !== 'darwin' && !args.includes('--allow-foreign-platform')) {
    console.error('render-share-footer.mjs: refusing to render off macOS (Apple Color Emoji / Helvetica Neue).');
    process.exit(1);
  }

  const ids = only ? [only] : Object.keys(CARDS);
  for (const id of ids) {
    if (!CARDS[id]) {
      console.error(`Unknown edition "${id}". Known: ${Object.keys(CARDS).join(', ')}`);
      process.exit(1);
    }
  }

  // The brand table comes from the shared bundling loader in
  // `load-editions.mjs`. This script used to transpile `src/editions.ts` alone
  // and stub its `require`, which died on load once the module started
  // importing `EDITION_IDS` and `brandFor` for real values. Loaded inside
  // `main` (it shells out to esbuild) so importing this file for its capture
  // seam costs nothing.
  const { loadEditions } = await import('./load-editions.mjs');
  const { editionBrand } = loadEditions();
  const destDir = join(repo, 'plans', 'og-images');

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  let browserClosed = false;
  const closeBrowser = async () => {
    if (browserClosed) return;
    browserClosed = true;
    await browser.close();
  };

  /** One band pass, reported the way this tool has always reported it. The
   *  input is the CURRENTLY committed card: this is a repaint of an existing
   *  picture, not a render from the artboard. */
  const paint = async (id) => {
    const card = CARDS[id];
    const brand = editionBrand(id);
    const line = `${brand.appName.toUpperCase()} ${brand.lexicon.shareMark}`;
    const b64 = readFileSync(join(destDir, card.file)).toString('base64');
    const page = await browser.newPage({ viewport: { width: CARD_W, height: BAND.h }, deviceScaleFactor: 1 });
    try {
      const out = await paintBand(page, {
        b64,
        band: BAND,
        ink: card.ink,
        line,
        centreX: CENTRE_X,
        cardW: CARD_W,
      });
      console.log(`${id.padEnd(11)} "${line}"  ink ${card.ink}  ground ${out.bg}  line width ${out.width}px`);
      return out.png;
    } finally {
      await page.close();
    }
  };

  try {
    if (checkOnly) {
      for (const id of ids) await paint(id);
      console.log('\n--check: nothing written.');
      return;
    }

    const staged = await renderCardSet({
      ids,
      destDir,
      fileFor: (id) => CARDS[id].file,
      beforeCommit: closeBrowser,
      capture: footerCaptureFrom(paint),
    });
    for (const { id, dest, report } of staged) {
      console.log(
        `${''.padEnd(11)} wrote ${dest} — ${report.width}×${report.height}, colour type ${report.colorType}, ` +
          `${(report.bytes / 1024).toFixed(0)} KB (${id})`,
      );
    }
  } finally {
    try {
      await closeBrowser();
    } catch {
      // Preserve whatever brought us here; the success path closes the browser
      // before the commit phase, so a close failure can never turn a published
      // run into a reported failure.
    }
  }
}

// Importable for its capture seam, runnable as the refresher. Nothing above
// this line touches the filesystem, the brand table or a browser.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
