// Marketing screenshots for nathanpayne.com and blog posts
// (docs/app/marketing-screenshots.md). Not a test: it asserts only enough to
// know the screen it wants is settled. Writes PNGs to artifacts/marketing/.
//
// Run it with `scripts/marketing-shots.sh`, which supplies the emulators and
// the JDK the Firestore emulator needs.
import { test, expect } from '@playwright/test';
import { doc, setDoc } from 'firebase/firestore';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  seedHeroEvent,
  renameSignedInPlayer,
  joinHero,
  signedInUid,
  HERO_EVENT_ID,
  HERO_TODAY_INDEX,
  HERO_EDITION,
  clickIfPresent,
  heroDealable,
} from './support/fixture';
import { dealBoard, type DealItem } from '../../src/game/logic';
// @ts-expect-error — plain-JS seed script, no type declarations.
import { seedItemDocId } from '../../scripts/seed.mjs';
import { EASY_ITEMS } from '../../scripts/seed-data/bodega-bay-2026.mjs';

const OUT_DIR = path.join(process.cwd(), 'artifacts', 'marketing');
const FIXED_SEED = 606060;
/** A partially-marked board: seven claimed squares, no completed line. */
const MARKED = [0, 3, 7, 11, 16, 19, 23];

let testEnv: RulesTestEnvironment;

/** Clear every first-open scrim: the analytics notice, the coach overlay, then
 * the reshuffle launch announcement (which only mounts once coach is cleared). */
async function clearScrims(page: import('@playwright/test').Page, firstTimeout: number): Promise<void> {
  await clickIfPresent(page.getByRole('button', { name: /got it/i }), 3_000);
  await clickIfPresent(page.getByRole('button', { name: /deal me in/i }), firstTimeout);
  await clickIfPresent(page.getByRole('button', { name: /let's play/i }), 6_000);
  await clickIfPresent(page.getByRole('button', { name: /got it/i }), 2_000);
  // The warm-up Day's "How this works" banner — in-flow, not a scrim, so it
  // pushes the card off screen until dismissed.
  await clickIfPresent(page.getByRole('button', { name: /dismiss how this works/i }), 4_000);
}

test.use({ viewport: { width: 393, height: 775 } });
test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  testEnv = await seedHeroEvent();
});

test.afterAll(async () => {
  await testEnv?.cleanup();
});

type SeedItem = { text: string; spicy?: boolean };

async function writeHeroBoard(uid: string): Promise<string[]> {
  // The main-day deal blends main + easy 50/50 (easyMixRatio 0.5), so the
  // hero pool is both — exactly what the Player would have been dealt.
  // The warm-up Day deals from the easy pool alone. `pool` is left UNSET on
  // purpose: dealBoard reads it to split a main-day card into its easy and
  // main halves, so tagging every prompt 'embark' would leave the main half
  // empty and the deal would fail its MIN_POOL guard. Absent === 'main',
  // which is exactly "one undifferentiated pool" — a tutorial-day deal.
  const pool: DealItem[] = (heroDealable(EASY_ITEMS as SeedItem[]) as SeedItem[]).map((it) => ({
    id: seedItemDocId(it.text),
    text: it.text,
    spicy: it.spicy === true,
  })) as DealItem[];
  const now = Date.now();
  const cells = dealBoard(pool, 'The flock has landed', FIXED_SEED, 0);
  for (const i of MARKED) {
    cells[i] = { ...cells[i], marked: true, markedAt: now - 2 * 3_600_000 };
  }
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), 'events', HERO_EVENT_ID, 'days', String(HERO_TODAY_INDEX), 'boards', uid),
      { uid, dayIndex: HERO_TODAY_INDEX, seed: FIXED_SEED, createdAt: now - 6 * 3_600_000, cells },
    );
  });
  return cells.map((c) => c.text);
}

test('capture marketing shots', async ({ page }) => {
  await joinHero(page);
  const uid = await signedInUid(page);

  await clearScrims(page, 25_000);

  await expect(page.locator('.grid')).toHaveAttribute('data-server-confirmed', 'true', {
    timeout: 30_000,
  });

  // After the join has written this Player's roster row.
  await renameSignedInPlayer(testEnv, uid, 'Alex W.');

  const cellTexts = await writeHeroBoard(uid);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 30_000 });
  await clearScrims(page, 8_000);

  // Wait for the deterministic board (the persistent cache can replay the
  // random first deal on reload).
  await expect
    .poll(async () => (await page.locator('.grid .cell').allTextContents())[0], { timeout: 30_000 })
    .toContain(cellTexts[0]);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);

  await page.screenshot({ path: path.join(OUT_DIR, `${HERO_EDITION}-card.png`) });

  await renameSignedInPlayer(testEnv, uid, 'Alex W.');
  await page.locator('nav.tabs a', { hasText: 'Feed' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, `${HERO_EDITION}-feed.png`) });

  await renameSignedInPlayer(testEnv, uid, 'Alex W.');
  await page.locator('nav.tabs a', { hasText: 'Ranks' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, `${HERO_EDITION}-ranks.png`) });
});
