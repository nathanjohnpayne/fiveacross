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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// Scratch (the materialised --ref blobs) goes OUTSIDE the repo by default: a
// review aid must not be able to dirty the tree it is auditing. Pass --sheet
// to put it somewhere you can browse.
const outDir = argOf('--sheet') ?? mkdtempSync(join(tmpdir(), 'og-compare-'));

const FILES = {
  gcb: 'og-gcb.png',
  vacay: 'og-vacay.png',
  fiveacross: 'og-fiveacross.png',
};

// The composition's regions, so a difference can be reported as "the eyebrow
// moved" rather than as one number for the whole frame. These are ATTRIBUTION
// BUCKETS, not assertions — they only have to contain the thing they name.
//
// They are per-Edition because the three lockups do not share a vertical
// rhythm: the two Editions stack a two-line wordmark from y~90, while the
// platform sets its wordmark on one line and centres the whole column, putting
// its eyebrow at y~180 — below where the Editions' wordmark has already
// finished. One shared table reported a Five Across copy change under the
// wrong region name, which defeats the point of the tool (Codex P2 on #697).
//
// Keep these in step with `left.top` / `left.gaps` in render-og-editions.mjs;
// the run warns if a band lands empty in BOTH images, which is what a drifted
// table looks like.
const COMMON_BANDS = [
  { name: 'board', box: [690, 40, 1160, 500] },
  { name: 'caption', box: [690, 500, 1160, 560] },
  { name: 'FULL FRAME', box: [0, 0, 1200, 630] },
];
const BANDS = {
  gcb: [
    { name: 'eyebrow', box: [60, 75, 660, 120] },
    { name: 'wordmark', box: [60, 120, 660, 330] },
    { name: 'byline/rule', box: [60, 330, 660, 405] },
    { name: 'description', box: [60, 405, 660, 505] },
    { name: 'domain', box: [60, 505, 660, 560] },
    ...COMMON_BANDS,
  ],
  vacay: [
    { name: 'eyebrow', box: [60, 95, 660, 140] },
    { name: 'wordmark', box: [60, 140, 660, 340] },
    { name: 'byline/rule', box: [60, 340, 660, 415] },
    { name: 'description', box: [60, 415, 660, 480] },
    { name: 'domain', box: [60, 480, 660, 530] },
    ...COMMON_BANDS,
  ],
  fiveacross: [
    { name: 'eyebrow', box: [60, 165, 660, 205] },
    { name: 'wordmark', box: [60, 205, 660, 300] },
    { name: 'rule', box: [60, 300, 660, 345] },
    { name: 'description', box: [60, 345, 660, 405] },
    { name: 'domain', box: [60, 405, 660, 465] },
    ...COMMON_BANDS,
  ],
};

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

/** Does this region contain anything but flat ground? Used to catch a band
 *  table that has drifted away from the render it is meant to describe. */
function hasInk(img, [x0, y0, x1, y1]) {
  const at = (x, y) => {
    const i = (y * img.w + x) * 4;
    return img.data[i] + img.data[i + 1] + img.data[i + 2];
  };
  const base = at(x0 + 1, y0 + 1);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      if (Math.abs(at(x, y) - base) > 60) return true;
    }
  }
  return false;
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

    // The sheet the header promises: committed above, fresh below, and an
    // amplified difference map under both, so a score you cannot explain has
    // somewhere to be looked at.
    const sheet = await page.evaluate(
      ({ ref, fresh }) => {
        const draw = (px) => {
          const c = document.createElement('canvas');
          c.width = px.w;
          c.height = px.h;
          c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.data), px.w, px.h), 0, 0);
          return c;
        };
        const A = draw(ref);
        const B = draw(fresh);
        const diff = document.createElement('canvas');
        diff.width = ref.w;
        diff.height = ref.h;
        const dctx = diff.getContext('2d');
        const out = dctx.createImageData(ref.w, ref.h);
        for (let i = 0; i < ref.data.length; i += 4) {
          // x6 so a difference that matters is visible without hunting.
          const d = Math.min(
            255,
            (Math.abs(ref.data[i] - fresh.data[i]) +
              Math.abs(ref.data[i + 1] - fresh.data[i + 1]) +
              Math.abs(ref.data[i + 2] - fresh.data[i + 2])) *
              2,
          );
          out.data[i] = d;
          out.data[i + 1] = d * 0.35;
          out.data[i + 2] = d * 0.6;
          out.data[i + 3] = 255;
        }
        dctx.putImageData(out, 0, 0);
        const gap = 12;
        const sheetC = document.createElement('canvas');
        sheetC.width = ref.w;
        sheetC.height = ref.h * 3 + gap * 2;
        const sctx = sheetC.getContext('2d');
        sctx.fillStyle = '#101014';
        sctx.fillRect(0, 0, sheetC.width, sheetC.height);
        sctx.drawImage(A, 0, 0);
        sctx.drawImage(B, 0, ref.h + gap);
        sctx.drawImage(diff, 0, (ref.h + gap) * 2);
        return sheetC.toDataURL('image/png');
      },
      { ref: a, fresh: b },
    );
    const sheetPath = join(outDir, `compare-${id}.png`);
    writeFileSync(sheetPath, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log(`   sheet: ${sheetPath}  (committed / fresh / amplified difference)`);
    for (const band of BANDS[id]) {
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
      // A band with no ink in EITHER image is a drifted table, not a clean
      // region: it silently reports 0.0 and hides whatever really moved.
      const empty = band.name !== 'FULL FRAME' && !hasInk(a, band.box) && !hasInk(b, band.box);
      console.log(
        `   ${band.name.padEnd(13)} mean|Δ| ${(sum / n / 3).toFixed(1).padStart(6)}   pixels>24: ${pct.padStart(5)}%` +
          (empty ? '   <- EMPTY in both: this band no longer covers its element' : ''),
      );
    }
  }
} finally {
  await browser.close();
}
if (anyMissing) process.exitCode = 1;
