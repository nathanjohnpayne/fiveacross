// Phase 1.5 verification — Doubts (ADR 0001, #33). Drives TWO real browser
// contexts (two independent Players joining the SAME seeded Event) against the
// Firebase emulators: Player B raises a "pics or it didn't happen" Doubt
// against Player A's marked Square, the 👀-style doubt-count badge appears on
// A's OWN board, and attaching a Proof satisfies it — the who-list row flips
// from "Doubted" to "Proof shown ✓" and the badge disappears. A Doubt never
// blocks or unmarks the Square (ADR 0001) — this spec never asserts otherwise.
import { test, expect, type Page } from '@playwright/test';
import { seedDailyEvent, dismissCoach, readDealtDayGrid } from './support/daily';
import { joinViaSharedLink, signedInUid } from './support/join';
import { claimCellByText, waitForBoardServerConfirmed } from './support/board';
import { EVENT_ID } from './support/env';

const SHOTS = process.env.E2E_SHOT_DIR || 'test-results/shots';

/** The first text the two dealt grids share — both Players' cards are drawn
 * from the SAME 80-item main pool for a 24-square board (src/game/logic.ts
 * MIN_POOL), so an overlap is expected (~7 items on average) though not
 * mathematically guaranteed. */
function firstSharedPrompt(gridA: string[], gridB: string[]): string {
  const setB = new Set(gridB.filter((_, i) => i !== 12));
  const shared = gridA.find((t, i) => i !== 12 && t.trim().length > 0 && setB.has(t));
  if (!shared) throw new Error('No shared prompt between the two dealt boards — re-run (see file header note).');
  return shared;
}

test('Doubt raised on another Player\'s Mark → badge appears; a Proof satisfies it', async ({ browser }) => {
  const { testEnv } = await seedDailyEvent();
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  try {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();

    await joinViaSharedLink(pageA);
    const uidA = await signedInUid(pageA);
    await waitForBoardServerConfirmed(pageA);
    await dismissCoach(pageA);
    const gridA = await readDealtDayGrid(pageA);

    await joinViaSharedLink(pageB);
    const uidB = await signedInUid(pageB);
    await waitForBoardServerConfirmed(pageB);
    await dismissCoach(pageB);
    const gridB = await readDealtDayGrid(pageB);

    expect(uidA).not.toBe(uidB);
    const prompt = firstSharedPrompt(gridA, gridB);

    // Both Players mark the SAME Prompt on their own boards (bare honor Marks) —
    // the Tally who-list a Doubt is raised from is scoped to the VIEWER's own
    // marked Square (src/components/Board.tsx TallyBadge), so B needs their own
    // marked cell for this Prompt to open a who-list that includes A.
    await claimCellByText(pageA, prompt);
    await claimCellByText(pageB, prompt);

    // B opens the who-list from their own marked Square and raises a Doubt
    // against A's row (never their own — Board renders no self-doubt affordance).
    const cellB = pageB.locator('.grid .cell').filter({ hasText: prompt });
    await cellB.locator('.tally-badge').click();
    await expect(pageB.getByText('Who got', { exact: false })).toBeVisible();
    const rows = pageB.locator('.sheet .list .row');
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    // A's row is the one carrying the Doubt affordance (B's own row renders
    // none) — the button's VISIBLE text is the wireframe's full phrase (#263).
    const doubtBtn = pageB.locator('.doubt-btn');
    await expect(doubtBtn).toBeVisible();
    await expect(doubtBtn).toHaveText(/Pics or it didn\u2019t happen/);
    await doubtBtn.click();
    // #263: once the Doubt echoes, the row swaps to its right-aligned state.
    await expect(pageB.locator('.doubt-open')).toHaveText(/Doubted \u00b7 waiting/, { timeout: 10_000 });
    await pageB.screenshot({ path: `${SHOTS}/doubt-raised-who-list.png`, fullPage: true });
    await pageB.getByRole('button', { name: 'Close' }).click();

    // Emulator ground truth: exactly one Doubt doc, from B against A, on this Prompt.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const { collection, getDocs } = await import('firebase/firestore');
      const snap = await getDocs(collection(ctx.firestore(), 'events', EVENT_ID, 'doubts'));
      const docs = snap.docs.map((d) => d.data());
      expect(docs).toHaveLength(1);
      expect(docs[0].fromUid).toBe(uidB);
      expect(docs[0].targetUid).toBe(uidA);
    });

    // A sees the open-Doubt count badge on THEIR OWN marked Square (live —
    // subscription-driven, no reload).
    const cellA = pageA.locator('.grid .cell').filter({ hasText: prompt });
    const badgeA = cellA.locator('.doubt-badge');
    await expect(badgeA).toBeVisible({ timeout: 15_000 });
    await expect(badgeA).toHaveText(/1/);
    await pageA.screenshot({ path: `${SHOTS}/doubt-badge-on-target-board.png`, fullPage: true });

    // A attaches a Proof to the SAME Square (the "＋ Proof" affordance on an
    // already-marked, non-free cell). A TEXT proof (a Callout), not a photo:
    // `isDoubtSatisfied` keys on `(uid, itemText, createdAt)` and never on proof
    // `type`, so a Callout proves the same derivation with no Storage upload in
    // the way. (The media path IS drivable here now — #335's canonicalize/resolve
    // pair fixed the Storage-emulator host mismatch that used to 403 it — and is
    // covered end to end by tests/e2e/d15-proof-media.spec.ts; keeping this case
    // on text just holds it to the one behavior it is about.)
    await cellA.locator('.proofbtn').click();
    await pageA.getByRole('button', { name: 'Callout' }).click();
    await pageA.getByPlaceholder('Name names. Who, what, how bad?').fill('Proof: it happened.');
    await pageA.getByRole('button', { name: 'Mark it' }).click();
    await expect(pageA.locator('.sheet-backdrop')).toHaveCount(0, { timeout: 15_000 });

    // The Doubt is SATISFIED (derived from the Proof, never a write to the
    // Doubt doc itself — src/data/doubts.ts isDoubtSatisfied): the badge on A's
    // own board disappears (open count → 0) without any further action.
    await expect(badgeA).toHaveCount(0, { timeout: 15_000 });
    await pageA.screenshot({ path: `${SHOTS}/doubt-satisfied-badge-gone.png`, fullPage: true });

    // B's who-list row for A now reads "✓ Answered" instead of the open state.
    await cellB.locator('.tally-badge').click();
    await expect(pageB.getByText('Who got', { exact: false })).toBeVisible();
    await expect(pageB.getByText('✓ Answered')).toBeVisible({ timeout: 15_000 });
    await pageB.screenshot({ path: `${SHOTS}/doubt-satisfied-who-list.png`, fullPage: true });
  } finally {
    await pageA?.context().close();
    await pageB?.context().close();
    await testEnv.cleanup();
  }
});
