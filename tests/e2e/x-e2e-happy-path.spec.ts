// x-e2e-happy-path — MIGRATED to the Phase 1.5 daily-cards flow (the legacy
// single-board deal was removed in #246/#247, which left the old assertions
// dead — `.grid[data-server-confirmed]` never latched because the seeded Event
// now carries a `days[]` schedule whose Days read `waking`/`locked` without
// stamped snapshots, so nothing was ever dealt). This drives the real
// zero-coordination round against a seeded MULTI-DAY event: land on the shared
// link → today's Day Card deals from its frozen snapshot → complete a line →
// BINGO celebration → the leaderboard shows the sole Player with one bingo,
// plus the ADR 0006 offline-mark-survives-reload assertion on that Day Card.
import { test, expect, type Page } from '@playwright/test';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc } from 'firebase/firestore';
import { seedDailyEvent, dismissCoach, readDealtDayGrid, readPlayer, playerUids } from './support/daily';
import { joinViaSharedLink, signedInUid } from './support/join';
import {
  LINE_INDICES_EXCLUDING_CENTER,
  claimCellByText,
  waitForBoardServerConfirmed,
} from './support/board';
import { userAttested } from './support/seed';
import { EVENT_ID } from './support/env';
import { cellsFromData } from '../../src/game/cells';

test.describe('x-e2e-happy-path (daily-cards)', () => {
  let testEnv: RulesTestEnvironment;

  test.beforeAll(async () => {
    ({ testEnv } = await seedDailyEvent());
  });

  test.afterAll(async () => {
    await testEnv?.cleanup();
  });

  test('join -> today deals -> Mark -> BINGO -> Leaderboard, zero admin action', async ({ page }) => {
    // The "shared link" is just the app's one URL. Nothing here visits /admin.
    await joinViaSharedLink(page);
    const uid = await signedInUid(page);

    // Today's Day (the latest unlocked, a MAIN Day) deals lazily on open. Wait
    // for the first server-backed board snapshot before completing the line, so
    // the win animates as an edge rather than being swallowed as the baseline.
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);
    const dealt = await readDealtDayGrid(page);
    // A dealt card carries real prompt text on (nearly) every non-free square —
    // proof the Day Card was dealt from its snapshot, not a blank/locked preview.
    expect(dealt.filter((t, i) => i !== 12 && t.trim().length > 0).length).toBeGreaterThanOrEqual(20);

    // Complete the middle row [10,11,13,14] (the free centre 12 is the 5th) — a
    // BINGO through the free space, so four honor Marks win it.
    for (const index of LINE_INDICES_EXCLUDING_CENTER) {
      await claimCellByText(page, dealt[index]);
    }

    // The celebration headline (Celebration.tsx `.big`) — class + text, since the
    // Share Card renders a second "BINGO!" node inside the same celebration.
    await expect(page.locator('.big', { hasText: 'BINGO!' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep playing' }).click();

    // The leaderboard shows this sole Player, ranked #1 with one bingo and the
    // four completed squares — the day-scoped Marks folded up to the cruise root.
    //
    // Ground truth FIRST (#317): exactly one Player doc — this uid — exists
    // server-side before any UI count is read. beforeAll's clearFirestore
    // guarantees it, but pinning the roster as DATA means a stray second row
    // would fail here naming the intruding uid instead of surfacing later as
    // a bare `.list .row` count mismatch (run-2's undiagnosable 2-row flake).
    await expect.poll(async () => playerUids(testEnv), { timeout: 15_000 }).toEqual([uid]);
    await page.getByRole('link', { name: 'Ranks' }).click();
    // Verify the click LANDED on the Ranks view before counting rows (#317):
    // the tap follows the celebration overlay's teardown, and a tab-bar click
    // that fires into mid-unmount layout can land on an adjacent tab — the
    // Feed's card list also matches `.list .row`, so a mis-landed click used
    // to fail 15s later as a nonsense row count. Re-click until the SPA route
    // is /leaderboard, then wait out the roster subscription's loading gate
    // (`.lb-filters` renders only with the roster live).
    await expect(async () => {
      if (!new URL(page.url()).pathname.startsWith('/leaderboard')) {
        await page.getByRole('link', { name: 'Ranks' }).click();
      }
      await expect(page.locator('.lb-filters')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    const rows = page.locator('.list .row');
    // Sole Player (asserted as data above) — but the leaderboard subscription
    // is a cold read on nav, so allow it to settle rather than the 5s default.
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
    await expect(rows.first().locator('.rank')).toHaveText('1', { timeout: 15_000 });
    // The row existing (above) only proves the Player doc's IDENTITY write
    // landed — bingoCount/squaresMarked come from setMark's own fold write,
    // which lands after the marks' batches drain, so this row can render with
    // "0 bingos" text for a beat after it first mounts. A generous timeout
    // (not a weaker assertion) lets Playwright's auto-retry keep re-reading
    // this same live element as later snapshots land.
    await expect(rows.first().locator('.sub')).toContainText('1 bingo', { timeout: 20_000 });
    await expect(rows.first().locator('.sub')).toContainText(
      `${LINE_INDICES_EXCLUDING_CENTER.length} squares`,
      { timeout: 20_000 },
    );

    // Ground truth: the win folded into TODAY's day bucket, not a legacy root board.
    const player = await readPlayer(testEnv, uid);
    expect(player.bingoCount).toBe(1);
    expect(player.dayStats?.['2']?.bingoCount).toBe(1);
    expect(player.dayStats?.['2']?.squaresMarked).toBe(LINE_INDICES_EXCLUDING_CENTER.length);
  });

  test('a Mark made offline survives a reload and syncs on reconnect (ADR 0006)', async ({
    page,
    context,
  }) => {
    await joinViaSharedLink(page);
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);
    await readDealtDayGrid(page); // waits for today's Day Card to render (25 cells)
    const uid = await signedInUid(page);

    const target = page.locator('.grid .cell:not(.free):not(.marked)').first();
    const targetText = (await target.textContent())?.trim();
    if (!targetText) throw new Error('No unmarked, non-free Square available to Mark offline.');

    // The offline reload resolves the shell from the PWA precache; wait until the
    // service worker is active before cutting the network.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // The join must have fully settled (the 18+ attestation transaction committed)
    // before going offline — transactions never queue offline.
    await expect(async () => {
      expect(await userAttested(testEnv, uid)).toBe(true);
    }).toPass({ timeout: 10_000 });

    await context.setOffline(true);
    // Mark it — the write lands in the persistent cache synchronously (latency
    // compensation) and the honor pledge is offline-durable (never a transaction).
    await claimCellByText(page, targetText);
    await expect(markedCellLocator(page, targetText)).toHaveClass(/marked/);

    // Reload while STILL offline: memory is wiped; anything surviving came from the
    // durable IndexedDB queue the SW-served JS recovers.
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 15_000 });
    await expect(markedCellLocator(page, targetText)).toHaveClass(/marked/, { timeout: 15_000 });

    // Reconnect — the recovered queue drains to the emulator's DAY-SCOPED board.
    await context.setOffline(false);
    await expect(async () => {
      expect(await dayBoardHasMarkedText(testEnv, uid, 2, targetText)).toBe(true);
    }).toPass({ timeout: 20_000 });
  });
});

function markedCellLocator(page: Page, text: string) {
  return page.locator('.cell', { hasText: text });
}

// Day-scoped twin of support/seed.ts's boardHasMarkedText: the offline Mark on a
// Day Card writes events/{eventId}/days/{dayIndex}/boards/{uid}, not the legacy
// root boards/{uid}. Reads that day-scoped board straight from the emulator.
async function dayBoardHasMarkedText(
  testEnv: RulesTestEnvironment,
  uid: string,
  dayIndex: number,
  text: string,
): Promise<boolean> {
  let found = false;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(
      doc(ctx.firestore(), 'events', EVENT_ID, 'days', String(dayIndex), 'boards', uid),
    );
    const cells = cellsFromData(snap.data()?.cells);
    found = cells.some((c) => c.text === text && c.marked === true);
  });
  return found;
}
