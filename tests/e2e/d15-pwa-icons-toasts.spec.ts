// Phase 1.5 verification — chrome-finale sweep, area 5: PWA install/update
// toasts (#219, specs/d15-pwa-toasts.md) and the Lucide/emoji iconography
// split (#220, specs/d15-icons-lucide.md). Drives the real app + Firebase
// emulators.
//
// `beforeinstallprompt` is a Chromium-only, criteria-gated event that a
// headless/automated run cannot reliably coax the browser into firing on its
// own — this is the standard, accepted way PWA install-flow e2e suites drive
// it (there is no other lever): dispatch a synthetic `Event('beforeinstallprompt')`
// with the two methods `useInstallPrompt`'s real listener actually calls
// (`preventDefault`, `prompt`/`userChoice`) stubbed on. Everything downstream —
// the real `window.addEventListener('beforeinstallprompt', ...)` handler in
// src/hooks/useInstallPrompt.ts, the shared store, the first-Mark gate, the
// toast-priority ranking — is exercised for real; only the browser-native
// trigger itself is synthesized.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { seedDailyEvent, dismissCoach, readDealtDayGrid } from './support/daily';
import { joinViaSharedLink } from './support/join';
import { claimCellByText, waitForBoardServerConfirmed } from './support/board';
import { EVENT_ID, PROJECT_ID } from './support/env';

const SHOTS = process.env.E2E_SHOT_DIR || 'test-results/shots';

/** Fires a fake `beforeinstallprompt` capture — same shape as the real
 *  Chromium event `useInstallPrompt`'s listener reads (`preventDefault`,
 *  and a `prompt()`/`userChoice` pair, unused by this spec but present so a
 *  stray `install()` call in the app doesn't throw). Dispatched via
 *  `page.evaluate` AFTER the signed-in shell is on screen — `attachListenersOnce`
 *  registers the real `window.addEventListener('beforeinstallprompt', ...)`
 *  listener from `InstallPrompt`'s mount effect (`main.tsx`, always mounted
 *  regardless of auth state), which only runs once React has committed; an
 *  `addInitScript`-on-`DOMContentLoaded` dispatch races that (DOMContentLoaded
 *  fires on the initial HTML parse, well before the SPA bundle has executed
 *  and React has mounted), so the event was landing before anyone was
 *  listening. Calling this AFTER the app has visibly rendered sidesteps the
 *  race entirely. */
async function fireFakeInstallPrompt(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ev = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt?: () => Promise<void>;
      userChoice?: Promise<{ outcome: string; platform: string }>;
    };
    ev.prompt = () => Promise.resolve();
    ev.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(ev);
  });
}

test.describe('iconography — Lucide chrome, emoji flavor', () => {
  let testEnv: Awaited<ReturnType<typeof seedDailyEvent>>['testEnv'];
  test.beforeAll(async () => {
    ({ testEnv } = await seedDailyEvent());
  });
  test.afterAll(async () => {
    await testEnv?.cleanup();
  });

  test('Lucide svg glyphs render for tab bar / More rows / claim sheet; emoji render for themes and Day ports', async ({
    page,
  }) => {
    await joinViaSharedLink(page);
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);

    // Tab bar: three plain Lucide tabs + the More ellipsis fallback (no
    // avatar on this emulator identity — see d15-tab-more-menu.spec.ts).
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.locator('svg.tab-icon')).toHaveCount(3);
    await expect(nav.locator('svg.tab-ellipsis')).toHaveCount(1);

    // Day tabs carry an EMOJI (portEmoji) as visible text content, not a
    // Lucide icon — camp/theme flavor stays emoji per the split. (The tab's
    // `aria-label` is a separate, plain-text weekday/port string — see
    // DaySwitcher.tsx — so the emoji check reads the rendered text instead.)
    const firstTabText = await page.getByRole('tab').first().textContent();
    expect(firstTabText).toMatch(/[\u{1F1E6}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // any emoji-range codepoint

    // More menu rows: Lucide icons on Theme/Text-size-adjacent section
    // headers and every navigable row (Cruise schedule, Suggest a square,
    // How to play), while the Theme chips themselves stay emoji-led.
    await page.getByRole('link', { name: 'More' }).click();
    // Theme's Palette icon + Text size's ALargeSmall icon (#281 gave the
    // Text-size section header its own Lucide icon alongside Theme's; this
    // count was stale at 1 — part of the #317 union-failure set).
    await expect(page.locator('h3 svg.more-section-icon')).toHaveCount(2);
    const rowIcons = page.locator('.more-rows .more-row svg.more-row-icon');
    await expect(rowIcons).toHaveCount(await rowIcons.count()); // sanity: locator resolves
    expect(await rowIcons.count()).toBeGreaterThanOrEqual(3); // schedule / suggest / how-to-play
    const autoChip = page.getByRole('button', { name: /Auto—match the day/ });
    await expect(autoChip).toContainText('🧭');
    const firstThemeChip = page.locator('.themes[aria-label="Theme"] button').nth(1);
    expect(await firstThemeChip.textContent()).toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    await page.screenshot({ path: `${SHOTS}/icons-more-menu.png`, fullPage: true });

    // Claim sheet: Lucide segment icons (camera/mic/pen-line) + the X dismiss.
    // Back to the Card tab — no sub-panel was opened above, so there is no
    // "Close" button here, just the bottom tab bar.
    await page.getByRole('link', { name: 'Card' }).click();
    const dealt = await readDealtDayGrid(page);
    const promptText = dealt.find((t, i) => i !== 12 && t.trim().length > 0)!;
    await page.locator('.grid .cell').filter({ hasText: promptText }).click();
    await expect(page.locator('.sheet-title', { hasText: promptText })).toBeVisible();
    await expect(page.locator('.seg .seg-btn-icon')).toHaveCount(3);
    await expect(page.locator('button.sheet-dismiss svg')).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/icons-claim-sheet.png`, fullPage: true });
  });
});

test.describe('install nudge (quiet, invitational, gated on the first Mark)', () => {
  let testEnv: Awaited<ReturnType<typeof seedDailyEvent>>['testEnv'];
  test.beforeAll(async () => {
    ({ testEnv } = await seedDailyEvent());
  });
  test.afterAll(async () => {
    await testEnv?.cleanup();
  });

  test('does not appear on load even with an installable prompt captured; appears right after the first Mark', async ({
    page,
  }) => {
    await joinViaSharedLink(page);
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);
    await fireFakeInstallPrompt(page);

    // Installable (the captured prompt exists) but NOT yet marked anything —
    // #219's whole point: no toast on app-load.
    await expect(page.locator('.install-prompt')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/pwa-install-not-yet-shown.png`, fullPage: true });

    const dealt = await readDealtDayGrid(page);
    const promptText = dealt.find((t, i) => i !== 12 && t.trim().length > 0)!;
    await claimCellByText(page, promptText); // the FIRST Mark

    const toast = page.locator('.install-prompt');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toHaveAttribute('role', 'note'); // quiet, not role="status"/"alert"
    await expect(toast.getByRole('button', { name: 'Install' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/pwa-install-after-first-mark.png`, fullPage: true });
  });
});

test.describe('update banner: defers while a claim sheet is open; stacks over the install toast (urgent first, capped at two)', () => {
  let testEnv: Awaited<ReturnType<typeof seedDailyEvent>>['testEnv'];
  test.beforeAll(async () => {
    ({ testEnv } = await seedDailyEvent());
  });
  test.afterAll(async () => {
    await testEnv?.cleanup();
  });

  test('a genuinely new deployed build (forced via a real second `vite build`) surfaces as needRefresh, defers while a claim sheet is open, and stacks above the install toast', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await joinViaSharedLink(page);
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);
    await fireFakeInstallPrompt(page);

    // Trigger the install toast first (first Mark on a non-farewell/locked
    // Square), so both toasts can compete for the two-slot stack later.
    const dealt = await readDealtDayGrid(page);
    const firstPrompt = dealt.find((t, i) => i !== 12 && t.trim().length > 0)!;
    await claimCellByText(page, firstPrompt);
    await expect(page.locator('.install-prompt')).toBeVisible({ timeout: 10_000 });

    // Open a real claim sheet (the ＋ "Add proof" affordance on the
    // now-marked Square) and leave it open — UpdatePrompt must defer while
    // it's up.
    await page.locator('.grid .cell').filter({ hasText: firstPrompt }).locator('button.proofbtn').click();
    const sheetOpen = await page.locator('.sheet-title', { hasText: firstPrompt }).isVisible().catch(() => false);

    // Force a genuinely new deployed build: re-run the SAME `vite build` the
    // webServer used, with one inert env var bumped (GITHUB_SHA — vite.config.ts's
    // `appVersion()` reads it FIRST, ahead of `git rev-parse HEAD`; it only
    // changes the More-menu version string, no gating logic) so the compiled
    // bundle's content — and therefore vite-plugin-pwa's generated precache
    // manifest revision — is REALLY different, the same way a real deploy is.
    // Writes into the SAME `dist/` the running `vite preview` (webServer) is
    // still serving from disk, mirroring a real prod deploy landing under a
    // long-lived tab.
    //
    // The ORIGINAL dist/ is snapshotted first and RESTORED byte-for-byte in the
    // finally below (#317): leaving the forced bundle in place poisoned every
    // LATER spec in a full-suite run — the still-running `vite preview` served
    // fresh pages a stale/mixed view of dist (pages booted the ORIGINAL bundle,
    // per their More-menu version string, while `/sw.js` re-fetches saw the NEW
    // one), so each subsequent test ran under a spurious "A fresh build just
    // docked" update toast and, intermittently, wedged subscriptions/routing.
    // Restoring the exact original bytes puts the server, the precache
    // manifest, and every later page load back on one consistent build.
    const distDir = path.join(process.cwd(), 'dist');
    const distBackup = path.join(process.cwd(), 'node_modules', '.cache', 'gcb-e2e-dist-backup');
    rmSync(distBackup, { recursive: true, force: true });
    mkdirSync(path.dirname(distBackup), { recursive: true });
    cpSync(distDir, distBackup, { recursive: true });
    try {
      const fakeSha = `e2e-forced-update-${Date.now()}`;
      execFileSync('npx', ['vite', 'build', '--mode', 'e2e'], {
        cwd: process.cwd(),
        stdio: 'pipe',
        env: {
          ...process.env,
          GITHUB_SHA: fakeSha,
          VITE_FIREBASE_API_KEY: 'demo-api-key',
          VITE_FIREBASE_AUTH_DOMAIN: `${PROJECT_ID}.firebaseapp.com`,
          VITE_FIREBASE_PROJECT_ID: PROJECT_ID,
          VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT_ID}.appspot.com`,
          VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
          VITE_FIREBASE_APP_ID: '1:000000000000:web:0000000000000000000000',
          VITE_EVENT_ID: EVENT_ID,
          VITE_FIREBASE_MEASUREMENT_ID: '',
          VITE_POSTHOG_KEY: '',
          VITE_POSTHOG_HOST: '',
          VITE_RECAPTCHA_SITE_KEY: '',
        },
      });

      // Ask the already-registered SW to re-check `/sw.js` right now (sw.js is
      // served Cache-Control: no-cache) instead of waiting for the 60s poll.
      await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        await reg?.update();
      });

      if (sheetOpen) {
        // Deferred: needRefresh is true internally, but the claim sheet being
        // open must suppress the banner.
        await page.waitForTimeout(3_000); // let the SW installed→waiting transition settle
        await expect(page.locator('.update-prompt')).toHaveCount(0);
        await page.screenshot({ path: `${SHOTS}/pwa-update-deferred-sheet-open.png`, fullPage: true });
        await page.getByRole('button', { name: 'Cancel' }).click();
      } else {
        console.log('[pwa-update-defer] could not open a claim sheet on the already-marked Square — defer-while-open leg skipped, update-detection + stacking legs still run below.');
      }

      // Now visible (sheet closed) — urgent priority banner, real copy/actions.
      const updateToast = page.locator('.update-prompt');
      await expect(updateToast).toBeVisible({ timeout: 20_000 });
      await expect(updateToast).toHaveAttribute('role', 'status');
      await expect(updateToast.getByRole('button', { name: 'Reload' })).toBeVisible();
      await expect(updateToast.getByRole('button', { name: 'Not now' })).toBeVisible();

      // Stacking: both toasts visible at once (MAX_VISIBLE_TOASTS=2), update
      // ranked ABOVE install (urgent outranks invitational — lower --toast-index).
      await expect(page.locator('.install-prompt')).toBeVisible();
      const updateIndex = await updateToast.evaluate((el) => getComputedStyle(el).getPropertyValue('--toast-index').trim());
      const installIndex = await page.locator('.install-prompt').evaluate((el) => getComputedStyle(el).getPropertyValue('--toast-index').trim());
      expect(Number(updateIndex)).toBeLessThan(Number(installIndex));
      await page.screenshot({ path: `${SHOTS}/pwa-toasts-stacked.png`, fullPage: true });
    } finally {
      // Byte-identical restore of the pre-test build (never a third `vite
      // build`, whose output could drift) — even when an assertion above threw.
      rmSync(distDir, { recursive: true, force: true });
      renameSync(distBackup, distDir);
    }
  });
});
