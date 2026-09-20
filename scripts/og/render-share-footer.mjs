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
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadEditions } from './load-editions.mjs';

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

// The brand table comes from the shared bundling loader in
// `load-editions.mjs`. This script used to transpile `src/editions.ts` alone
// and stub its `require`, which died on load once the module started importing
// `EDITION_IDS` and `brandFor` for real values.
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
        return { png: c.toDataURL('image/png'), bg, width: Math.round(w) };
      },
      { b64, band: BAND, ink: card.ink, line, centreX: CENTRE_X, cardW: CARD_W },
    );
    await page.close();

    console.log(`${id.padEnd(11)} "${line}"  ink ${card.ink}  ground ${out.bg}  line width ${out.width}px`);
    if (!checkOnly) {
      // Written as canvas hands it back: lossless TRUECOLOR (PNG colour type
      // 2), matching the three committed cards, what render-share-rasters.mjs
      // writes, and what `src/recon-share-og.test.ts` requires of all three.
      // An earlier version ran pngquant here on the reasoning that these are
      // soft-focus reference pictures rather than assets crawlers serve. That
      // is no longer available: pngquant emits a palette PNG (colour type 3),
      // which reds the recon guard — and a palette pass perturbs pixels
      // everywhere, so it also destroys the one property this tool exists to
      // have, that the only pixels that moved are the ones in the band.
      writeFileSync(path, Buffer.from(out.png.split(',')[1], 'base64'));
      console.log(`${''.padEnd(11)} wrote ${path} (${(statSync(path).size / 1024).toFixed(0)} KB, truecolor)`);
    }
  }
} finally {
  await browser.close();
}
if (checkOnly) console.log('\n--check: nothing written.');
