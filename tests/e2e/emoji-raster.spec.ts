import { test, expect, chromium, type Browser } from '@playwright/test';
import { BASE_URL } from './support/env';

// Regression spec for #603: emoji inside a shared text run break layout in
// every html-to-image rasterization (share cards + bug-report captures).
//
// The defect only manifests in a REAL, HEADED desktop Chrome: its SVG
// `<foreignObject>` raster pass shapes emoji differently from the live
// document (observed on macOS Chrome 151: the farewell card's "🏆 Champion"
// role line and the "GAY CRUISE BINGO 🚢" footer wrap in the raster and
// paint over their neighbours; the shipped user report shows the same class
// of failure as "Day 4 🌊alletta"). Headless Chromium — the suite's default
// browser — resolves fonts differently and does NOT reproduce it, so this
// spec launches its own headed real-Chrome instance and SKIPS when that
// channel can't launch (CI, or a machine without Chrome).
//
// It measures the REAL pipeline, not a replica: the app's e2e bundle (MODE
// 'e2e') exposes `window.__shareCardE2E` (src/components/ShareCard.tsx) with
// the exact production builder + rasterizer. The assertion is a render
// measurement: the raster's ink geometry in the champion-role and footer
// line bands must match the live DOM's. On pre-#603 code the role line
// wraps in the raster — the band holds only the wrapped-off trophy (~11% of
// the live width) — and the check fails.

test('farewell-card raster reproduces the live text geometry around emoji (#603)', async () => {
  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  } catch {
    test.skip(true, 'real headed Chrome unavailable — the #603 defect only manifests there');
    return;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
    await page.goto(BASE_URL);
    // The seam registers at module scope when the e2e bundle loads.
    await page.waitForFunction(() => '__shareCardE2E' in window, undefined, { timeout: 15_000 });

    const geometry = await page.evaluate(async () => {
      type FarewellData = {
        eventName: string;
        champion: { displayName: string; bingoCount: number; squaresMarked: number } | null;
        firstBingo: { displayName: string } | null;
        honors: Array<{ dayLabel: string; displayName: string }>;
        contextLine?: string;
      };
      const seam = (
        window as unknown as {
          __shareCardE2E: {
            buildFarewellCardNode: (d: FarewellData) => HTMLElement;
            rasterize: (node: HTMLElement) => Promise<Blob>;
          };
        }
      ).__shareCardE2E;
      const card = seam.buildFarewellCardNode({
        eventName: 'Allure of the Seas',
        champion: { displayName: 'Alex', bingoCount: 16, squaresMarked: 124 },
        firstBingo: null,
        honors: [
          { dayLabel: 'Day 2 · Split 🇭🇷', displayName: 'Player Name' },
          { dayLabel: 'Day 4 · Valletta 🌊', displayName: 'Player Name' },
        ],
        contextLine: 'Bodega Bay · Day 4 · Valletta',
      });

      // Transparent ground for the ink measurement — none of these move text:
      // the border keeps its width (only its color goes transparent), and the
      // title's glow would otherwise bleed ink into the adjacent bands.
      card.style.background = 'none';
      card.style.borderColor = 'transparent';
      card
        .querySelectorAll<HTMLElement>('.share-card-title')
        .forEach((n) => (n.style.textShadow = 'none'));

      // Live geometry: real on-screen layout of the very node the pipeline
      // will rasterize.
      const host = document.createElement('div');
      host.style.position = 'fixed';
      host.style.left = '0';
      host.style.top = '0';
      host.style.zIndex = '2147483647';
      host.appendChild(card);
      document.body.appendChild(host);
      await document.fonts.ready;
      const cardRect = card.getBoundingClientRect();
      const roleRect = card.querySelector('.share-card-honoree-role')!.getBoundingClientRect();
      const footerRect = card.querySelector('.share-card-footer')!.getBoundingClientRect();
      const roleBand = { y0: roleRect.top - cardRect.top, y1: roleRect.bottom - cardRect.top };
      const footerBand = { y0: footerRect.top - cardRect.top, y1: footerRect.bottom - cardRect.top };
      host.remove();

      // Raster through the real pipeline (offscreen mount + toBlob at 3x).
      const blob = await seam.rasterize(card);
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / cardRect.width;

      // Ink extent (non-transparent pixels) within a horizontal band, in CSS px.
      const bandInkWidth = (band: { y0: number; y1: number }): number => {
        const top = Math.max(0, Math.round(band.y0 * scale));
        const h = Math.max(1, Math.round((band.y1 - band.y0) * scale));
        const d = ctx.getImageData(0, top, canvas.width, h).data;
        let minX = Number.POSITIVE_INFINITY;
        let maxX = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            if (d[i + 3] > 20) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        return maxX < 0 ? 0 : (maxX - minX + 1) / scale;
      };

      return {
        liveRoleW: roleRect.width,
        rasterRoleBandW: bandInkWidth(roleBand),
        liveFooterW: footerRect.width,
        rasterFooterBandW: bandInkWidth(footerBand),
      };
    });

    // Failure signature on pre-#603 code (measured, headed macOS Chrome 151):
    // role band 0.11× live (only the wrapped-off trophy remains on the line),
    // footer band 0.86× live (the ship wrapped below). Fixed code measures
    // 0.96×/0.99× — the thresholds sit between the two states with margin.
    expect(geometry.rasterRoleBandW).toBeGreaterThan(0.85 * geometry.liveRoleW);
    expect(geometry.rasterRoleBandW).toBeLessThan(1.15 * geometry.liveRoleW);
    expect(geometry.rasterFooterBandW).toBeGreaterThan(0.93 * geometry.liveFooterW);
    expect(geometry.rasterFooterBandW).toBeLessThan(1.15 * geometry.liveFooterW);
  } finally {
    await browser.close();
  }
});
