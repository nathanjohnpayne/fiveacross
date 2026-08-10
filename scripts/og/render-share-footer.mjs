// Refreshes the BRAND FOOTER on the wireframes' reference share cards:
//
//   plans/og-images/share-final-photo-gcb.png
//   plans/og-images/share-final-photo-vacay.png
//   plans/og-images/share-final-photo-fa.png
//
// Those PNGs are static pictures of a LIVE component. `ShareCard.tsx` draws
// the real card's footer as `${appName} ${lexicon.shareMark}` (three call
// sites), so the moment the brand table changes a share mark the shipped app
// is already correct and only these reference pictures are stale. #681 is
// exactly that case: #678 moved Vacay's mark from 🗺️ to 🧳 in the table, the
// running app followed, and the wireframes' card kept showing a map.
//
// So this script does not re-draw the card — it re-draws the one line the
// brand table owns, in place, reading `appName` and `lexicon.shareMark` from
// `src/editions.ts` exactly like render-og-editions.mjs does. The next share
// mark change is a table edit plus a re-run.
//
// SCOPE, stated plainly: everything else in these cards (the photo hero, the
// standings rows, the honors chips) is a picture of sample data, has no design
// source in this repo, and is deliberately left untouched. If the card's
// LAYOUT ever changes, these references need re-screenshotting from the real
// component, not patching here.
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
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { transformSync } from 'esbuild';

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

function loadEditions() {
  const src = readFileSync(join(repo, 'src', 'editions.ts'), 'utf8');
  const js = transformSync(src, { loader: 'ts', format: 'cjs', target: 'node20' }).code;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', js)(module, module.exports, () => ({}));
  return module.exports;
}
const { editionBrand } = loadEditions();

// Geometry measured off the committed cards. The band is the full-width strip
// the footer line occupies; it is repainted with the card's own background
// colour, sampled from inside the band well left of the centred text, so this
// works on Vacay's cream ground and the other two Editions' dark ones alike.
const CARDS = {
  gcb: { file: 'share-final-photo-gcb.png', ink: '#d0a8ab' },
  vacay: { file: 'share-final-photo-vacay.png', ink: '#8a857b' },
  fiveacross: { file: 'share-final-photo-fa.png', ink: '#9aa3b2' },
};
const BAND = { y: 694, h: 32, sampleX: 90 };
const CENTRE_X = 300;
const CARD_W = 600;

const ids = only ? [only] : Object.keys(CARDS);
for (const id of ids) {
  if (!CARDS[id]) {
    console.error(`Unknown edition "${id}". Known: ${Object.keys(CARDS).join(', ')}`);
    process.exit(1);
  }
}

const browser = await chromium.launch();
try {
  for (const id of ids) {
    const card = CARDS[id];
    const brand = editionBrand(id);
    const line = `${brand.appName.toUpperCase()} ${brand.lexicon.shareMark}`;
    const path = join(repo, 'plans', 'og-images', card.file);

    const page = await browser.newPage({ viewport: { width: CARD_W, height: BAND.h }, deviceScaleFactor: 1 });
    // Read the card, sample its background inside the band, repaint the band,
    // and draw the footer — all in one canvas pass so the new type is
    // antialiased against the same ground the old type was.
    const b64 = readFileSync(path).toString('base64');
    const out = await page.evaluate(
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
        ctx.fillRect(0, band.y, cardW, band.h);
        // Letter-spaced uppercase, matching the committed cards' footer.
        ctx.letterSpacing = '3px';
        ctx.font = '400 16px "Helvetica Neue", Helvetica, Arial, sans-serif';
        ctx.fillStyle = ink;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(line, centreX, band.y + band.h / 2 + 1);
        const w = ctx.measureText(line).width;
        return { png: c.toDataURL('image/png'), bg, width: Math.round(w) };
      },
      { b64, band: BAND, ink: card.ink, line, centreX: CENTRE_X, cardW: CARD_W },
    );
    await page.close();

    console.log(`${id.padEnd(11)} "${line}"  ink ${card.ink}  ground ${out.bg}  line width ${out.width}px`);
    if (!checkOnly) {
      writeFileSync(path, Buffer.from(out.png.split(',')[1], 'base64'));
      // The committed cards are pngquant-crushed. Canvas hands back a lossless
      // PNG, so skipping this step grows a 150 KB reference asset to 240 KB for
      // a one-emoji change — a bigger diff than the change itself.
      try {
        execFileSync(
          'pngquant',
          ['--quality=75-95', '--speed', '1', '--strip', '--force', '--output', `${path}.quant`, path],
          { stdio: 'inherit' },
        );
        renameSync(`${path}.quant`, path);
      } catch {
        console.warn(`${''.padEnd(11)} pngquant unavailable — keeping the lossless PNG (expect a larger file).`);
      }
      console.log(`${''.padEnd(11)} wrote ${path} (${(statSync(path).size / 1024).toFixed(0)} KB)`);
    }
  }
} finally {
  await browser.close();
}
if (checkOnly) console.log('\n--check: nothing written.');
