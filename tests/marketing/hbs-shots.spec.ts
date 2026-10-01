// HBS spring 2027 mockups (plans/hbs-spring-2027.md,
// docs/app/marketing-screenshots.md § "The HBS weekly mockups"). Not a test: it
// photographs the real app, and the real email templates, over the plan's
// content. Writes `hbs-*.png` to artifacts/marketing/.
//
// Opt-in: it runs only with `HERO_EVENT=hbs`, so a default capture never touches
// it. Run it with
//
//   HERO_EDITION=fiveacross HERO_EVENT=hbs scripts/marketing-shots.sh --grep hbs
//
// These are MOCKUPS of a proposed Event. The weekly vocabulary (plan ticket T1)
// does not exist, so the UI still says "Day 12", "today" and "Tonight" — the
// captions in the plan say so.
import { test, expect } from '@playwright/test';
import { doc, setDoc } from 'firebase/firestore';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { joinHero, signedInUid, renameSignedInPlayer, clickIfPresent, HERO_EVENT_ID } from './support/fixture';
import {
  HBS_FIXED_SEED,
  HBS_MARKED_TEXTS,
  HBS_NOW,
  HBS_POOL,
  HBS_TIMEZONE,
  HBS_TODAY_INDEX,
  hbsDays,
  hbsRoster,
  seedHbsEvent,
  unlockAt,
} from './support/hbs-fixture';
import { CENTER, completedLines, dealBoard, type DealItem } from '../../src/game/logic';
// @ts-expect-error — plain-JS seed script, no type declarations.
import { seedItemDocId } from '../../scripts/seed.mjs';
import {
  buildDailyEmailModel,
  standingsThrough,
  type EmailDay,
  type EmailEvent,
  type EmailPlayer,
} from '../../functions/src/dailyEmailContent';
import { renderDailyEmailHtml } from '../../functions/src/dailyEmailTemplate';
import { tutorialDayIndexes, ceremonialDayIndexes } from '../../functions/src/finaleContent';

const OUT_DIR = path.join(process.cwd(), 'artifacts', 'marketing');
const SIGNED_IN_NAME = 'Alex W.';

test.describe('HBS spring 2027 mockups', () => {
  test.skip(process.env.HERO_EVENT !== 'hbs', 'opt-in: set HERO_EVENT=hbs');
  test.use({ viewport: { width: 393, height: 775 }, timezoneId: HBS_TIMEZONE });
  test.describe.configure({ timeout: 180_000 });

  let testEnv: RulesTestEnvironment;

  test.beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    testEnv = await seedHbsEvent();
  });
  test.afterAll(async () => {
    await testEnv?.cleanup();
  });

  async function shoot(page: import('@playwright/test').Page, name: string): Promise<void> {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT_DIR, `hbs-${name}.png`), animations: 'disabled' });
  }

  async function clearScrims(page: import('@playwright/test').Page, firstTimeout: number): Promise<void> {
    await clickIfPresent(page.getByRole('button', { name: /got it/i }), 3_000);
    await clickIfPresent(page.getByRole('button', { name: /deal me in/i }), firstTimeout);
    await clickIfPresent(page.getByRole('button', { name: /let's play/i }), 6_000);
    await clickIfPresent(page.getByRole('button', { name: /got it/i }), 2_000);
    await clickIfPresent(page.getByRole('button', { name: /dismiss how this works/i }), 4_000);
  }

  test('capture the weekly card and the leaderboard', async ({ page }) => {
    await page.clock.install({ time: HBS_NOW });
    await joinHero(page);
    const uid = await signedInUid(page);
    await renameSignedInPlayer(testEnv, uid, SIGNED_IN_NAME);

    // The card, dealt by the real `dealBoard` from the 24 hand-picked prompts, so
    // the composition is the plan's: 12 easy, 6 themed, 6 evergreen. Written with
    // rules disabled because the server clock (real now) is before Week 12's
    // unlock, so the rules would refuse the deal; the page clock is what the UI
    // reads.
    const pool: DealItem[] = HBS_POOL.map((it) => ({
      id: seedItemDocId(it.text),
      text: it.text,
      spicy: false,
      ...(it.pool === 'embark' ? { pool: 'embark' } : {}),
    })) as DealItem[];
    const day = hbsDays()[HBS_TODAY_INDEX];
    const cells = dealBoard(pool, day.freeText, HBS_FIXED_SEED, 0, { stratify: true, easyMixRatio: 0.5 });
    const marked = cells.map((c, i) =>
      !c.free && HBS_MARKED_TEXTS.has(c.text) ? { ...c, marked: true, markedAt: HBS_NOW - 3 * 3_600_000 } : cells[i],
    );
    // A completed line would fire the celebration overlay over the shot.
    expect(completedLines(marked)).toHaveLength(0);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'events', HERO_EVENT_ID, 'days', String(HBS_TODAY_INDEX), 'boards', uid),
        { uid, dayIndex: HBS_TODAY_INDEX, seed: HBS_FIXED_SEED, createdAt: unlockAt(HBS_TODAY_INDEX) + 30 * 3_600_000, cells: marked, easyMixRatio: 0.5 },
      );
    });

    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 30_000 });
    await clearScrims(page, 8_000);

    const normalise = (t: string) => t.replace(/[✓＋+]/g, '').replace(/\s+/g, ' ').trim();
    await expect
      .poll(
        async () => {
          const shown = (await page.locator('.grid .cell').allTextContents()).map(normalise);
          if (shown.length !== 25) return null;
          return shown.filter((_, i) => i !== CENTER);
        },
        { timeout: 30_000 },
      )
      .toEqual(cells.filter((_, i) => i !== CENTER).map((c) => normalise(c.text)));
    await shoot(page, 'card');

    // The week header and Day switcher, scrolled to the current week by hand: the
    // row opens at Week 1, and every chip reads "Mon" because the chips show the
    // weekday (plan ticket T1).
    await page.locator('.day-chip.selected').scrollIntoViewIfNeeded();
    await page.locator('.day-chip.selected').evaluate((el) => el.scrollIntoView({ inline: 'center', block: 'nearest' }));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(OUT_DIR, 'hbs-switcher.png'),
      clip: { x: 0, y: 0, width: 393, height: 112 },
      animations: 'disabled',
    });

    await renameSignedInPlayer(testEnv, uid, SIGNED_IN_NAME);
    await page.locator('nav.tabs a', { hasText: 'Ranks' }).click();
    for (const p of hbsRoster()) {
      await expect(page.getByText(p.displayName, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    }
    await expect(page.getByText(SIGNED_IN_NAME, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.rank')).toHaveCount(hbsRoster().length + 1, { timeout: 30_000 });
    await shoot(page, 'ranks');
  });

  test('capture the Monday email', async ({ page }) => {
    const days = hbsDays() as EmailDay[];
    const event: EmailEvent = {
      name: 'HBS Spring 2027',
      timezone: HBS_TIMEZONE,
      standingsFreezeAt: unlockAt(days.length - 1),
      days,
    };
    const roster = hbsRoster() as EmailPlayer[];
    const day = days[HBS_TODAY_INDEX];
    const model = buildDailyEmailModel({
      event,
      day,
      players: roster,
      ranked: standingsThrough(roster, day.index, tutorialDayIndexes(days), ceremonialDayIndexes(days)),
      recipient: { uid: 'hero-p2', displayName: 'Devon K.' },
      edition: 'fiveacross',
      feedUrl: 'https://example.com/feed',
      unsubscribeUrl: 'https://example.com/unsubscribe',
      preferencesUrl: 'https://example.com/unsubscribe?a=preferences',
    });
    await page.setViewportSize({ width: 640, height: 900 });
    await page.setContent(renderDailyEmailHtml(model), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT_DIR, 'hbs-email.png'), fullPage: true, animations: 'disabled' });
  });
});
