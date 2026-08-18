// Phase 1.5 verification — chrome-finale sweep, area 4: the finale's
// two-beat finish (#217, daily-cards-spec § "The finale—two-beat finish" /
// § "Farewell view"). The scheduled D10 08:00 unlock (functions/src/unlockDay.ts,
// a CRON trigger unreachable in a short-lived test run — same documented gap
// d15-approvals.spec.ts already pins for the scheduler) is simulated the same
// way support/daily.ts's `seedDailyEvent({ frozenAt })` already does: seed the
// Event with `frozenAt` already stamped, the exact state the scheduled run
// leaves behind. This spec drives the real UI to prove: the farewell view
// opens WITH the podium once frozen (and withOUT it before), the podium shows
// the cruise champion + cruise-wide First to BINGO + per-Day honors, and a
// mark made on the farewell Day itself (ceremonial) never moves any of the three.
import { test, expect, type Page } from '@playwright/test';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { seedDailyEvent, dismissCoach, readDealtDayGrid, MAIN_A_INDEX, TODAY_INDEX, FAREWELL_INDEX } from './support/daily';
import { joinViaSharedLink, signedInUid } from './support/join';
import { claimCellByText, waitForBoardServerConfirmed, LINE_INDICES_EXCLUDING_CENTER } from './support/board';
import { EVENT_ID } from './support/env';

const SHOTS = process.env.E2E_SHOT_DIR || 'test-results/shots';

/**
 * Close any standing (or about-to-appear) Celebration overlay(s) — completing
 * a BINGO line pops a full-screen `.celebrate` modal A TICK LATER (its own
 * doc comment: the snapshot-effect edge detection fires off the board
 * subscription, not the mark tap itself), so a single immediate
 * `.celebrate` count check races that tick and can undercount, leaving the
 * caller to proceed straight into a grid tap the celebration is ABOUT to
 * cover — which then hangs until the whole test times out (no bounded
 * per-click actionability timeout is configured, so it retries against the
 * test's own deadline). This actively WAITS through that tick — polling
 * repeatedly rather than checking once — before concluding nothing is open,
 * then dismisses via the backdrop's own `onClick={onClose}` (no role/name
 * resolution, no dependency on "Keep playing" having finished laying out —
 * Celebration eagerly rasterizes a Share card at mount, which can keep the
 * main thread busy for a beat).
 */
async function closeCelebration(page: Page): Promise<void> {
  const cel = page.locator('.celebrate');
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if ((await cel.count()) > 0) {
      await cel.first().click({ position: { x: 5, y: 5 }, force: true, timeout: 5_000 }).catch(() => {});
    }
    await page.waitForTimeout(150);
    if ((await cel.count()) === 0) {
      // Confirm it's really settled, not just between a dismiss and a fresh
      // re-open (#176: a 2nd/3rd completed line re-fires the animation).
      await page.waitForTimeout(400);
      if ((await cel.count()) === 0) return;
    }
  }
}

/** Completes the shared middle-row BINGO line (4 non-center squares) on
 *  whichever Day is currently viewed, using each square's dealt text, then
 *  dismisses the Celebration overlay it pops. */
async function completeMiddleRowBingo(page: Page): Promise<string[]> {
  const texts = await readDealtDayGrid(page);
  const lineTexts = LINE_INDICES_EXCLUDING_CENTER.map((i) => texts[i]);
  for (const t of lineTexts) await claimCellByText(page, t);
  await closeCelebration(page);
  return lineTexts;
}

test.describe('pre-freeze: no podium', () => {
  let testEnv: RulesTestEnvironment;
  test.beforeAll(async () => {
    // `farewellUnlocked` + no frozenAt: the scheduler-lag window — the clock
    // has passed the farewell's unlockAt (so its card deals and the goodbye
    // banner renders) but the D10 08:00 `frozenAt` stamp has not landed yet.
    // This is the ONLY reachable state with a dealt farewell card and no
    // freeze stamp, and it pins the sharper contract: the podium is gated on
    // `frozenAt` itself, never on the farewell Day merely being open.
    ({ testEnv } = await seedDailyEvent({ farewellUnlocked: true }));
  });
  test.afterAll(async () => {
    await testEnv?.cleanup();
  });

  test('the farewell Day shows the goodbye banner but NO podium before the freeze', async ({ page }) => {
    await joinViaSharedLink(page);
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);
    // In the scheduler-lag window the farewell is the most-recent unlock, so
    // `defaultViewedIndex` opens it as "today" — through the ordinary
    // latest-unlock rule, NOT the freeze pin (`finalePinIndex` stays null
    // until `frozenAt` lands). The podium must still be absent: it is gated on
    // `frozenAt` itself, never on the farewell Day merely being open.
    await expect(page.getByRole('tab').nth(FAREWELL_INDEX)).toHaveAttribute('aria-selected', 'true');
    await readDealtDayGrid(page);
    await expect(page.locator('.tutorial-banner-farewell')).toBeVisible();
    await expect(page.locator('.farewell-podium')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/finale-pre-freeze-no-podium.png`, fullPage: true });
  });
});

test.describe('post-freeze: podium + ceremonial farewell marks', () => {
  let testEnv: RulesTestEnvironment;
  test.beforeAll(async () => {
    // NOT frozen at seed time (#317): the standings the podium displays must be
    // EARNED first, and the app's freeze semantics (#265/#278) stop every
    // non-ceremonial stats fold the moment the event is frozen — seeding
    // `frozenAt` up front made the two Players' marks below fold NOTHING, so
    // the squaresMarked 5/4 ground truth could never be reached. Play happens
    // pre-freeze; the test then stamps the D10 08:00 transition itself.
    ({ testEnv } = await seedDailyEvent());
  });
  test.afterAll(async () => {
    await testEnv?.cleanup();
  });

  test('the farewell view opens WITH the podium by default once frozen, and the frozen standings then survive a farewell-Day mark', async ({
    browser,
  }) => {
    // Two independent Players, two BINGOs, several Firestore round trips, two
    // Celebration dismissals, and a mid-test freeze + reload — comfortably over
    // the 30s default given the local emulator's write latency under this
    // suite's serial single-worker run.
    test.setTimeout(120_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage(); // will be the CHAMPION (more squares)
    const pageB = await ctxB.newPage(); // bingos FIRST chronologically → cruise-wide First to BINGO

    try {
      // B joins and bingos FIRST (on MAIN_A_INDEX) so B is the cruise-wide
      // First to BINGO even though B ends up ranked below A on squares.
      await joinViaSharedLink(pageB);
      const uidB = await signedInUid(pageB);
      await waitForBoardServerConfirmed(pageB);
      await dismissCoach(pageB);
      // Not yet frozen: default view is today, and the farewell Day is still
      // locked — no podium anywhere (the pre-freeze describe pins that state).
      await expect(pageB.getByRole('tab').nth(TODAY_INDEX)).toHaveAttribute('aria-selected', 'true');
      await pageB.getByRole('tab').nth(MAIN_A_INDEX).click();
      await completeMiddleRowBingo(pageB);

      // A joins, bingos on TODAY_INDEX SECOND, then marks ONE extra square so
      // A's squaresMarked (5) beats B's (4) — comparePlayers ranks bingoCount
      // first (tied at 1), then squaresMarked (A wins), so A is CHAMPION while
      // B keeps the earlier firstBingoAt (cruise-wide First to BINGO).
      await joinViaSharedLink(pageA);
      const uidA = await signedInUid(pageA);
      await waitForBoardServerConfirmed(pageA);
      await dismissCoach(pageA);
      await pageA.getByRole('tab').nth(TODAY_INDEX).click();
      const todayTexts = await completeMiddleRowBingo(pageA);
      const extraTexts = await readDealtDayGrid(pageA);
      const extra = extraTexts.find((t, i) => i !== 12 && t.trim().length > 0 && !todayTexts.includes(t))!;
      await claimCellByText(pageA, extra);
      await closeCelebration(pageA);

      // Ground truth: both players' dayStats settle before reading the podium.
      await expect
        .poll(async () => {
          let ok = false;
          await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const a = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID, 'players', uidA));
            const b = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID, 'players', uidB));
            ok = (a.data()?.squaresMarked ?? 0) === 5 && (b.data()?.squaresMarked ?? 0) === 4;
          });
          return ok;
        }, {
          // Two Players' worth of marks (a bingo line + one extra for A, a
          // bingo line for B), each chained per-uid through markChains
          // (src/data/api.ts) — a generous timeout under a busy shared
          // emulator, not a weaker assertion.
          timeout: 30_000,
        })
        .toBe(true);

      // THE D10 08:00 TRANSITION, exactly the state the scheduled run
      // (functions/src/unlockDay.ts) leaves behind: `frozenAt` stamped and the
      // farewell Day's `unlockAt` in the past (its snapshot is already stamped
      // by the seed). Stamped HERE — after the standings were earned — because
      // the freeze stops every further non-ceremonial stats fold by design.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const snap = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID));
        const days = (snap.data() as { days: Array<{ index: number }> }).days;
        await updateDoc(doc(ctx.firestore(), 'events', EVENT_ID), {
          frozenAt: Date.now(),
          days: days.map((d) => (d.index === FAREWELL_INDEX ? { ...d, unlockAt: Date.now() - 1000 } : d)),
        });
      });

      // "Opens WITH the podium by default once frozen": a fresh open lands on
      // the farewell pin (farewellPinIndex reads frozenAt at mount) with the
      // podium up. The reload is the deterministic "fresh open".
      await pageA.reload();
      await expect(pageA.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 15_000 });
      await expect(pageA.getByRole('tab').nth(FAREWELL_INDEX)).toHaveAttribute('aria-selected', 'true', {
        timeout: 15_000,
      });
      await readDealtDayGrid(pageA); // the farewell card deals lazily on this first post-freeze open
      const podium = pageA.locator('.farewell-podium');
      await expect(podium).toBeVisible({ timeout: 15_000 });
      await expect(podium.locator('.farewell-podium-champion .farewell-podium-name')).toHaveText(/./); // populated
      const championName = await podium.locator('.farewell-podium-champion .farewell-podium-name').textContent();
      const firstBingoName = await podium.locator('.farewell-podium-first .farewell-podium-name').textContent();
      // Champion = A (more squares); cruise-wide First to BINGO = B (bingoed first).
      expect(championName).not.toBe(firstBingoName);
      // Two daily honors: MAIN_A_INDEX → B, TODAY_INDEX → A.
      const honors = await podium.locator('.farewell-podium-honor').allTextContents();
      expect(honors.length).toBeGreaterThanOrEqual(2);
      await pageA.screenshot({ path: `${SHOTS}/finale-podium.png`, fullPage: true });

      // --- Ceremonial: a mark made on the farewell Day itself must NOT move
      // the podium (buildPodium excludes the farewell Day's own dayStats). ---
      await pageA.getByRole('tab').nth(FAREWELL_INDEX).click();
      const farewellTexts = await readDealtDayGrid(pageA);
      const farewellMark = farewellTexts.find((t, i) => i !== 12 && t.trim().length > 0)!;
      await claimCellByText(pageA, farewellMark);
      await closeCelebration(pageA);

      // Ground truth: the farewell mark WAS recorded (dayStats[FAREWELL_INDEX]
      // ticked) — proving this is "excluded from the podium", not "never wrote".
      await expect
        .poll(async () => {
          let marked = 0;
          await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const a = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID, 'players', uidA));
            marked = a.data()?.dayStats?.[String(FAREWELL_INDEX)]?.squaresMarked ?? 0;
          });
          return marked;
        }, { timeout: 10_000 })
        .toBe(1);

      // The podium (still on screen — Board's own subscription, no reload)
      // shows the SAME champion/first-to-bingo/honors as before the farewell mark.
      await expect(podium.locator('.farewell-podium-champion .farewell-podium-name')).toHaveText(championName!);
      await expect(podium.locator('.farewell-podium-first .farewell-podium-name')).toHaveText(firstBingoName!);
      const honorsAfter = await podium.locator('.farewell-podium-honor').allTextContents();
      expect(honorsAfter).toEqual(honors); // byte-identical — the farewell mark changed nothing here
      await pageA.screenshot({ path: `${SHOTS}/finale-podium-after-farewell-mark.png`, fullPage: true });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
