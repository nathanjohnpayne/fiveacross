// Verifies the header wordmark renders on ONE line at iPhone widths.
//
// The 2026-08-05 live bug: at iPhone width the post-auth header stacked
// "VACAY" / "BINGO" onto two lines. `.brand` sat in the `.nav` flex row with
// wrapping allowed, so a long Day identity ("The Birds Have Entered the …")
// squeezed the wordmark past its min-content and it broke at the space. The
// fix is `white-space: nowrap` on `.brand-wordmark` (src/index.css) plus the
// byline lockup from plans/daily-cards-wireframes.html § in-app header.
//
// A vitest+jsdom test cannot prove wrapping — jsdom does no layout — so this
// is a REAL-layout check in the same shape as scripts/og/render-og-default.mjs:
// headless Chromium, the PRODUCTION stylesheet from dist/, and the exact DOM
// `Nav.tsx` renders, measured at the two iPhone viewports that matter
// (390x844 = iPhone 12–15, 375x667 = iPhone SE).
//
// Manual and local, like the OG renderer — not wired into `npm run build` or
// CI (it needs a prior build and a downloaded Chromium).
//
// Usage:
//   GITHUB_ACTIONS=1 npm run build     # CI-mode build; no .env.local needed
//   node scripts/verify-wordmark-one-line.mjs
//
// Exit 0 with per-case measurements on success; exit 1 naming the failing
// case otherwise.
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const cssFiles = globSync(join(here, '..', 'dist', 'assets', 'index-*.css'));
if (cssFiles.length !== 1) {
  console.error(
    `Expected exactly one dist/assets/index-*.css (found ${cssFiles.length}). ` +
      'Run `GITHUB_ACTIONS=1 npm run build` first.',
  );
  process.exit(1);
}
// Inlined rather than <link>ed: a file:// subresource under about:blank is
// silently blocked, which turned every measurement into a vacuous 0px PASS on
// this script's first draft. The sanity check below guards the same failure.
const css = readFileSync(cssFiles[0], 'utf8');

// The exact classes and nesting Nav.tsx renders (brand + byline lockup, Day
// identity lines from dayIdentity.tsx). The Day identity carries the LONGEST
// live strings — Bodega Day 1 — because a long right-hand block is precisely
// the squeeze that produced the two-line stack.
const CASES = [
  {
    name: 'vacay (Bodega Day 1)',
    brand: 'VACAY <b>BINGO</b>',
    byline: 'BY FIVE ACROSS',
    port: '🐦 Friday · Bodega Bay',
    theme: 'The Birds Have Entered the Chat',
  },
  {
    name: 'gcb (longest wordmark)',
    brand: 'GAY CRUISE <b>BINGO</b>',
    byline: null,
    port: '🇭🇷 Split',
    theme: '🌍 Uniforms Without Borders',
  },
  {
    name: 'fiveacross',
    brand: 'FIVE <b>ACROSS</b>',
    byline: null,
    port: 'Fri · Green Valley',
    theme: 'Day 2 · Rehearsal',
  },
];

const VIEWPORTS = [
  { width: 390, height: 844, label: 'iPhone 12-15' },
  { width: 375, height: 667, label: 'iPhone SE' },
];

const pageHtml = ({ brand, byline, port, theme }) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head><body>
<div class="nav">
  <div class="brand">
    <span class="brand-wordmark">${brand}</span>
    ${byline ? `<span class="brand-byline">${byline}</span>` : ''}
  </div>
  <div class="day-identity">
    <span class="day-identity-line day-identity-place">${port}</span>
    <span class="day-identity-line day-identity-theme">${theme}</span>
  </div>
</div>
</body></html>`;

const browser = await chromium.launch();
let failed = false;
try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 3,
    });
    for (const c of CASES) {
      await page.setContent(pageHtml(c), { waitUntil: 'load' });
      const m = await page.evaluate(() => {
        const el = document.querySelector('.brand-wordmark');
        const style = getComputedStyle(el);
        // A block-level element that wraps grows in height; one rendered line
        // means clientHeight stays under 2 line-boxes. The overflow check
        // proves nowrap isn't hiding a wordmark wider than its column.
        return {
          clientHeight: el.clientHeight,
          fontSize: parseFloat(style.fontSize),
          lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          rects: el.getClientRects().length,
        };
      });
      // Vacuous-pass guard: the production stylesheet sets 26px display type,
      // so browser-default metrics (16px, 0-height inline box) mean the CSS
      // never applied and every assertion below would be measuring nothing.
      if (m.fontSize < 20 || m.clientHeight === 0) {
        console.error(
          `FAIL  ${vp.width}x${vp.height}  ${c.name}: stylesheet did not apply ` +
            `(fontSize=${m.fontSize}px, clientHeight=${m.clientHeight}px)`,
        );
        failed = true;
        continue;
      }
      const oneLine = m.clientHeight < 2 * m.lineHeight;
      const noOverflow = m.scrollWidth <= m.clientWidth + 1; // ±1px rounding
      const ok = oneLine && noOverflow;
      if (!ok) failed = true;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${vp.width}x${vp.height} (${vp.label})  ${c.name}: ` +
          `height=${m.clientHeight}px lineHeight=${m.lineHeight}px ` +
          `scrollWidth=${m.scrollWidth}px clientWidth=${m.clientWidth}px` +
          (ok ? '' : `  — ${oneLine ? 'wordmark overflows its column' : 'wordmark wrapped to two lines'}`),
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
