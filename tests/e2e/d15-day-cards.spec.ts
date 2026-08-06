// Live drive for #246 — the launch-blocking Day Card wiring, exercised against
// the real app (build --mode e2e) + the Firebase Emulator Suite. Proves the four
// behaviours the bug broke, end to end through a browser:
//   (i)   Day 0 and Day 1 tabs show DIFFERENT squares (their own day-scoped board),
//   (ii)  marking scores against the correct Day,
//   (iii) switching tabs and marking does NOT inflate the leaderboard total
//         (two marks total across two separate dayStats buckets — not 4),
//   (iv)  a locked future Day shows the preview and deals nothing.
import { test, expect } from '@playwright/test';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { seedEmulatorEvent } from './support/seed';
import { joinViaSharedLink, signedInUid } from './support/join';
import { waitForBoardServerConfirmed, claimCellByText } from './support/board';
import { dismissCoach } from './support/daily';
import { EVENT_ID } from './support/env';
// @ts-expect-error — plain-JS seed script, no type declarations (see support/seed.ts).
import { seedItemDocId } from '../../scripts/seed.mjs';
import { ITEMS } from '../../scripts/seed-data/med-2026.mjs';

let testEnv: RulesTestEnvironment;
const HOUR = 3_600_000;

test.beforeAll(async () => {
  testEnv = await seedEmulatorEvent();
  // The seeded Event's schedule uses real July-2026 dates with no snapshots, so
  // every Day would read `waking`/`locked`. Override it with two UNLOCKED,
  // snapshot-stamped Days (drawn from the full 80-item pool, so their cards are
  // fully disjoint) plus one locked future Day — the shape the scheduler produces.
  const now = Date.now();
  const snapshotItemIds = (ITEMS as Array<{ text: string }>).map((it) => seedItemDocId(it.text));
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'events', EVENT_ID), {
      days: [
        { index: 0, date: '2026-07-15', port: 'Trieste', portEmoji: '🇮🇹', theme: 'welcome-aboard', pool: 'main', tutorial: false, unlockAt: now - 48 * HOUR, snapshotItemIds },
        { index: 1, date: '2026-07-16', port: 'Split', portEmoji: '🇭🇷', theme: 'get-sporty', pool: 'main', tutorial: false, unlockAt: now - 24 * HOUR, snapshotItemIds },
        { index: 2, date: '2026-07-17', port: 'Valletta', portEmoji: '🇲🇹', theme: 'glamiators', pool: 'main', tutorial: false, unlockAt: now + 24 * HOUR },
      ],
    });
  });
});

test.afterAll(async () => {
  await testEnv?.cleanup();
});

// Wait until a FULLY-DEALT day grid is on screen (25 cells, ≥20 non-free squares
// carrying text) whose content differs from `differsFrom` — so we never read the
// stale previous-Day grid during the switch's "Dealing…" transient before the
// lazily-dealt card renders. Returns the settled grid's cell texts.
async function readDealtDayGrid(page: import('@playwright/test').Page, differsFrom?: string): Promise<string[]> {
  await expect
    .poll(
      async () => {
        const texts = await page.locator('.grid .cell').allTextContents();
        if (texts.length !== 25) return false;
        const dealt = texts.filter((t, i) => i !== 12 && t.trim().length > 0).length >= 20;
        return dealt && (differsFrom === undefined || texts.join('|') !== differsFrom);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return page.locator('.grid .cell').allTextContents();
}

async function readPlayer(uid: string): Promise<{ squaresMarked?: number; dayStats?: Record<string, { squaresMarked: number }> }> {
  let data: Record<string, unknown> = {};
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID, 'players', uid));
    data = (snap.data() as Record<string, unknown>) ?? {};
  });
  return data as { squaresMarked?: number; dayStats?: Record<string, { squaresMarked: number }> };
}

test('per-Day boards: different cards, correct-Day scoring, no leaderboard inflation, locked preview', async ({ page }) => {
  await joinViaSharedLink(page);
  const uid = await signedInUid(page);

  // Default view = today's Day = the latest unlocked (Day 1). The lazy deal fires
  // on open; the grid renders once the day-scoped board is written + confirmed.
  await waitForBoardServerConfirmed(page);
  // Dismiss the first-open scrims (#214 coach overlay, then the #378 Reshuffle
  // launch announcement queued behind it) — they otherwise intercept the
  // Day-switcher taps below.
  await dismissCoach(page);
  const day1Texts = await readDealtDayGrid(page);

  // (i) Switch to Day 0 → its OWN card. Different day-scoped board = different squares.
  await page.getByRole('tab').nth(0).click();
  const day0Texts = await readDealtDayGrid(page, day1Texts.join('|'));
  expect(day0Texts.join('|')).not.toBe(day1Texts.join('|'));

  // (ii) Mark one non-free square on Day 0 (honor pledge = a bare Mark).
  const day0Mark = day0Texts.find((t, i) => i !== 12 && t.trim().length > 0)!;
  await claimCellByText(page, day0Mark);

  // Switch to Day 1 and mark one of ITS squares.
  await page.getByRole('tab').nth(1).click();
  await readDealtDayGrid(page, day0Texts.join('|'));
  const day1Mark = day1Texts.find((t, i) => i !== 12 && t.trim().length > 0)!;
  await claimCellByText(page, day1Mark);

  // (iii) The cruise total is 2 — one mark per Day, in SEPARATE buckets. The
  // pre-fix shared-board bug summed the same board's marks into both days.
  await expect(async () => {
    const player = await readPlayer(uid);
    expect(player.squaresMarked).toBe(2);
    expect(player.dayStats?.['0']?.squaresMarked).toBe(1);
    expect(player.dayStats?.['1']?.squaresMarked).toBe(1);
  }).toPass({ timeout: 15_000 });

  // (iv) The locked future Day shows the preview and deals nothing.
  await page.getByRole('tab').nth(2).click();
  await expect(page.getByText(/unlocks/i)).toBeVisible();
  await expect(page.locator('.locked-grid')).toBeVisible(); // the themed blank preview
  await expect(page.locator('.grid[data-server-confirmed]')).toHaveCount(0); // no live/markable board dealt
});
