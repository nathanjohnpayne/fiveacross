// Scores a fresh per-Edition render against the committed asset, so a
// re-render can PROVE it changed only what it meant to.
//
// The per-Edition artwork is a committed binary that ships to every link
// preview, and the two changes that have needed it so far (#681's share-mark
// swap, #688's endorsement line) were each a small edit inside an otherwise
// frozen composition. "Nothing else moved" is the acceptance criterion in both
// tickets, and eyeballing two PNGs cannot establish it.
//
// This prints a per-band difference score plus a side-by-side/diff sheet you
// can open. It is a REVIEW AID, not a gate: a legitimate change makes some
// bands differ, and the point is that you can name which ones and why.
//
// Usage:
//   node scripts/og/compare-og.mjs --new /tmp/preview          # all Editions
//   node scripts/og/compare-og.mjs --new /tmp/preview --edition vacay
//   node scripts/og/compare-og.mjs --new /tmp/preview --ref HEAD
//
// `--ref` compares against a git revision of the committed asset rather than
// the working tree, which is what you want once you have already overwritten
// public/og-*.png in place.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const args = process.argv.slice(2);
const argOf = (f) => {
  const i = args.indexOf(f);
  return i === -1 ? null : args[i + 1];
};

const newDir = argOf('--new');
if (!newDir) {
  console.error('compare-og.mjs: --new <dir> is required (the directory a render wrote to).');
  process.exit(1);
}
const ref = argOf('--ref');
const only = argOf('--edition');
const outDir = argOf('--sheet') ?? join(repo, 'scripts', 'og', 'compare-out');

const FILES = {
  gcb: 'og-gcb.png',
  vacay: 'og-vacay.png',
  fiveacross: 'og-fiveacross.png',
};

// The composition's regions, so a difference can be reported as "the eyebrow
// moved" rather than as one number for the whole frame.
const BANDS = [
  { name: 'eyebrow', box: [60, 90, 640, 140] },
  { name: 'wordmark', box: [60, 140, 660, 340] },
  { name: 'byline/rule', box: [60, 340, 660, 415] },
  { name: 'description', box: [60, 395, 660, 480] },
  { name: 'domain', box: [60, 490, 660, 545] },
  { name: 'board', box: [690, 40, 1160, 500] },
  { name: 'caption', box: [690, 500, 1160, 560] },
  { name: 'FULL FRAME', box: [0, 0, 1200, 630] },
];

const ids = only ? [only] : Object.keys(FILES);
mkdirSync(outDir, { recursive: true });

/** Read a PNG as raw RGBA through the browser, so this script needs no image
 *  decoder beyond the playwright already in devDependencies.
 *
 *  The bytes go in as a data: URI rather than a file:// path on purpose: a
 *  file:// subresource under about:blank is silently blocked, which is the
 *  same trap render-og-default.mjs documents for its inlined stylesheet — and
 *  here it surfaces as an opaque "source image cannot be decoded". */
async function pixels(page, pngPath) {
  const fileUrl = `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`;
  return page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, data: Array.from(d) };
  }, fileUrl);
}

const browser = await chromium.launch();
const page = await browser.newPage();
let anyMissing = false;
try {
  for (const id of ids) {
    const file = FILES[id];
    let refPath = join(repo, 'public', file);
    if (ref) {
      // Materialise the committed blob so the comparison is against the
      // revision rather than whatever is in the working tree now.
      const tmp = join(outDir, `ref-${file}`);
      try {
        const blob = execFileSync('git', ['show', `${ref}:public/${file}`], {
          cwd: repo,
          maxBuffer: 64 * 1024 * 1024,
        });
        writeFileSync(tmp, blob);
        refPath = tmp;
      } catch {
        console.error(`  ${id}: no public/${file} at ${ref} — skipping.`);
        anyMissing = true;
        continue;
      }
    }
    const a = await pixels(page, refPath);
    const b = await pixels(page, join(newDir, file));
    if (a.w !== b.w || a.h !== b.h) {
      console.error(`  ${id}: DIMENSIONS DIFFER — ref ${a.w}x${a.h}, new ${b.w}x${b.h}`);
      anyMissing = true;
      continue;
    }

    console.log(`\n== ${id}  (${a.w}x${a.h})`);
    for (const band of BANDS) {
      const [x0, y0, x1, y1] = band.box;
      let sum = 0;
      let changed = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * a.w + x) * 4;
          const d =
            Math.abs(a.data[i] - b.data[i]) +
            Math.abs(a.data[i + 1] - b.data[i + 1]) +
            Math.abs(a.data[i + 2] - b.data[i + 2]);
          sum += d;
          if (d > 24) changed++;
          n++;
        }
      }
      const pct = ((changed / n) * 100).toFixed(1);
      console.log(
        `   ${band.name.padEnd(13)} mean|Δ| ${(sum / n / 3).toFixed(1).padStart(6)}   pixels>24: ${pct.padStart(5)}%`,
      );
    }
  }
} finally {
  await browser.close();
}
if (anyMissing) process.exitCode = 1;
