// Phase 1.5 verification — chrome-finale sweep, area 3: the Admin console's
// Schedule editor and Proof & Claims panel (#221/#222, daily-cards-spec §
// "Admin console"). Drives the real app + Firebase emulators: a Day's theme
// is editable up to its own unlock, then locked; the six Proof & Claims knobs
// (claim mode, photo source, EXIF strip, AI image screen, auto-hide
// threshold, pending-claims jump link) round-trip through the real UI onto
// the Event doc; and the admin_confirmed claim mode's pending-claim queue
// (confirm/reject) is driven end to end using a TEXT ("Callout") proof —
// deliberately sidestepping the photo/audio Storage-upload path, which
// d15-claim-sheet-photo.spec.ts already pins as a genuine, deterministic
// local-stack gap (production Storage host vs. the emulator's), so this claim
// round trip is provably real rather than blocked on that same gap.
import { test, expect, type BrowserContext } from '@playwright/test';
import { doc, updateDoc, getDoc, collection, getDocs, query, where } from 'firebase/firestore';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { seedDailyEvent, dismissCoach, readDealtDayGrid, LOCKED_INDEX, TODAY_INDEX } from './support/daily';
import { joinViaSharedLink, signedInUid } from './support/join';
import { waitForBoardServerConfirmed } from './support/board';
import { EVENT_ID } from './support/env';
import { cellsFromData } from '../../src/game/cells';

const SHOTS = process.env.E2E_SHOT_DIR || 'test-results/shots';

async function becomeAdminAndOpenPanel(page: import('@playwright/test').Page, testEnv: RulesTestEnvironment, uid: string) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'events', EVENT_ID), { admins: [uid] });
  });
  await page.getByRole('link', { name: 'More' }).click();
  const adminRow = page.getByRole('button', { name: /^Admin/ });
  await expect(adminRow).toBeVisible({ timeout: 10_000 });
  await adminRow.click();
  // Lands on the hub (specs/admin-console-ia.md): /more/admin, five cards.
  await expect(page.getByRole('dialog', { name: 'Admin' })).toBeVisible();
}

// Open a detail surface from the hub by its card title; the sheet re-titles to
// the section (the dialog's accessible name), which is the settle signal.
async function openAdminSection(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('dialog', { name: 'Admin' }).getByRole('button', { name: title }).click();
  await expect(page.getByRole('dialog', { name: title })).toBeVisible();
}

test.describe('Admin — Schedule editor', () => {
  let testEnv: RulesTestEnvironment;
  test.beforeAll(async () => {
    ({ testEnv } = await seedDailyEvent());
  });
  test.afterAll(async () => {
    await testEnv?.cleanup();
  });

  test('a locked future Day\'s theme is editable; an already-unlocked Day\'s theme is locked (disabled select, server-rejected)', async ({
    page,
  }) => {
    await joinViaSharedLink(page);
    const uid = await signedInUid(page);
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);
    await becomeAdminAndOpenPanel(page, testEnv, uid);

    // Scoped to the Admin hub dialog: unscoped, "Schedule" also
    // substring-matches the More menu's OWN "Cruise schedule" row (still in
    // the DOM behind this dialog), which is a different, read-only panel.
    // (No `exact` — a hub card's accessible name includes its subtitle.)
    await page.getByRole('dialog', { name: 'Admin' }).getByRole('button', { name: 'Schedule' }).click();
    await expect(page.getByRole('dialog', { name: 'Schedule' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/admin-schedule-tab.png`, fullPage: true });

    // The LOCKED Day (index 4, seeded with a future unlockAt) — its select is
    // enabled, and changing it round-trips onto the Event's days[] array.
    const lockedSelect = page.getByLabel(`Day ${LOCKED_INDEX + 1} theme`);
    await expect(lockedSelect).toBeEnabled();
    await lockedSelect.selectOption('duty-free');
    await expect
      .poll(async () => {
        let theme: string | undefined;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          const snap = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID));
          const days = (snap.data() as { days?: Array<{ index: number; theme: string }> } | undefined)?.days;
          theme = days?.find((d) => d.index === LOCKED_INDEX)?.theme;
        });
        return theme;
      }, { timeout: 10_000 })
      .toBe('duty-free');

    // The TODAY Day (index 2) is already unlocked (seeded `unlockAt: now - 10h`)
    // — its select renders disabled, the client-side convenience lock ahead of
    // firestore.rules' own `daysThemeLockOk` server-side denial.
    const unlockedSelect = page.getByLabel(`Day ${TODAY_INDEX + 1} theme`);
    await expect(unlockedSelect).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/admin-schedule-locked-row.png`, fullPage: true });
  });

  // #249, daily-cards-spec § "Unlock mechanics": "a manual admin 'unlock now'
  // button covers function failure." Drives the real `unlockDayNow` callable
  // through the Functions emulator against a Day forced into the exact state
  // a lagging/failed 08:00 scheduler run leaves behind — unlocked, but never
  // snapshot-stamped — and proves the button both fires the callable and
  // disappears once the Firestore listener reflects the resulting stamp.
  test('a Day that is due for unlock but not yet snapshot-stamped shows an "Unlock now" button that calls the callable and stamps the Day', async ({
    page,
  }) => {
    await joinViaSharedLink(page);
    const uid = await signedInUid(page);
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);
    await becomeAdminAndOpenPanel(page, testEnv, uid);

    // ONLY NOW — after the join/deal flow has already settled against the
    // original (healthy) schedule — push the still-LOCKED Day (index 4, no
    // snapshotItemIds) into the past without stamping it. Doing this before
    // joining would make it the newly-"due" default-viewed Day mid-deal and
    // hang the join flow on a Day the scheduler never stamped; the manual
    // Admin fallback here targets that same unstamped state deliberately.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID));
      const days = (snap.data() as { days: Array<Record<string, unknown>> }).days;
      await updateDoc(doc(ctx.firestore(), 'events', EVENT_ID), {
        days: days.map((d) => (d.index === LOCKED_INDEX ? { ...d, unlockAt: Date.now() - 1000 } : d)),
      });
    });

    await openAdminSection(page, 'Schedule');

    const dueRow = page.locator('.row').filter({ hasText: `Day ${LOCKED_INDEX + 1}` });
    const unlockBtn = dueRow.getByRole('button', { name: 'Unlock now' });
    await expect(unlockBtn).toBeVisible();
    // No other seeded Day (all already snapshot-stamped, or still genuinely
    // locked) offers this affordance.
    await expect(page.getByRole('button', { name: 'Unlock now' })).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/admin-schedule-unlock-now-due.png`, fullPage: true });

    await unlockBtn.click();
    // The result is plain text in the repair line, not a pill (#416).
    await expect(dueRow.locator('.schedule-row-result')).toHaveText('Unlocked.', { timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/admin-schedule-unlock-now-done.png`, fullPage: true });

    // Ground truth: the callable actually stamped the Day's Snapshot.
    await expect
      .poll(async () => {
        let ids: string[] | undefined;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          const snap = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID));
          const days = (snap.data() as { days?: Array<{ index: number; snapshotItemIds?: string[] }> } | undefined)
            ?.days;
          ids = days?.find((d) => d.index === LOCKED_INDEX)?.snapshotItemIds;
        });
        return ids;
      }, { timeout: 10_000 })
      .toBeDefined();

    // The button self-hides once the Firestore listener reflects the stamp —
    // dayDueForManualUnlock flips false, so there's no dead action left to offer.
    await expect(page.getByRole('button', { name: 'Unlock now' })).toHaveCount(0, { timeout: 10_000 });
  });
});

test.describe('Admin — Proof & Claims panel', () => {
  let testEnv: RulesTestEnvironment;
  test.beforeAll(async () => {
    ({ testEnv } = await seedDailyEvent());
  });
  test.afterAll(async () => {
    await testEnv?.cleanup();
  });

  test('claim mode, photo source, EXIF strip, AI image screen, and the report threshold all round-trip onto the Event doc', async ({
    page,
  }) => {
    await joinViaSharedLink(page);
    const uid = await signedInUid(page);
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);
    await becomeAdminAndOpenPanel(page, testEnv, uid);
    // The knobs live in Game settings › Claims & proof (admin-console-ia).
    await openAdminSection(page, 'Game settings');
    const panel = page.locator('.admin-section').filter({ hasText: 'Claims & proof' });
    await expect(panel).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/admin-proof-claims-panel.png`, fullPage: true });

    // Claim mode → admin_confirmed.
    await panel.getByRole('button', { name: 'Admin-confirmed' }).click();
    await expect
      .poll(async () => (await eventField(testEnv, uid, 'claimMode')) as unknown)
      .toBe('admin_confirmed');

    // Photo proof source → camera only, then back — proves the write path
    // both directions (the claim-sheet-photo spec already proves the RENDER
    // effect of camera_only; this proves the admin control that sets it).
    await panel.getByRole('button', { name: 'Camera only' }).click();
    await expect
      .poll(async () => (await eventField(testEnv, uid, 'settings'))?.photoProofSource)
      .toBe('camera_only');
    await panel.getByRole('button', { name: 'Camera or library' }).click();
    await expect
      .poll(async () => (await eventField(testEnv, uid, 'settings'))?.photoProofSource)
      .toBe('camera_or_library');

    // Strip location data — defaults ON (per seed.mjs); toggling off round-trips.
    // Plain `.click()`, not `.check()/.uncheck()`: these boxes are PURELY
    // server-echoed (`checked={event?.settings?.... ?? true}`, no local
    // optimistic state), so the native click flips the DOM property and
    // React's very next render (still on the stale subscription value)
    // snaps it back until the Firestore write round-trips — a real but
    // sub-frame revert that `.uncheck()`'s own strict same-click
    // verification treats as "did not change state". A retrying
    // `expect(...).not.toBeChecked()` waits out that round trip instead.
    const exifCheckbox = panel.locator('input[type="checkbox"]').first();
    await expect(exifCheckbox).toBeChecked();
    await exifCheckbox.click();
    await expect(exifCheckbox).not.toBeChecked({ timeout: 10_000 });
    await expect.poll(async () => (await eventField(testEnv, uid, 'settings'))?.stripPhotoExif).toBe(false);

    // AI image screen (visionGate) — defaults ON; toggling off round-trips.
    const visionCheckbox = panel.locator('input[type="checkbox"]').nth(1);
    await expect(visionCheckbox).toBeChecked();
    await visionCheckbox.click();
    await expect(visionCheckbox).not.toBeChecked({ timeout: 10_000 });
    await expect.poll(async () => (await eventField(testEnv, uid, 'settings'))?.visionGate).toBe(false);

    // Auto-hide threshold stepper — +/- around the seeded default, floored at 1.
    const before = (await eventField(testEnv, uid, 'settings'))?.reportHideThreshold ?? 4;
    await panel.getByRole('button', { name: 'Increase auto-hide threshold' }).click();
    await expect.poll(async () => (await eventField(testEnv, uid, 'settings'))?.reportHideThreshold).toBe(before + 1);
    await panel.getByRole('button', { name: 'Decrease auto-hide threshold' }).click();
    await expect.poll(async () => (await eventField(testEnv, uid, 'settings'))?.reportHideThreshold).toBe(before);
    await page.screenshot({ path: `${SHOTS}/admin-proof-claims-after-edits.png`, fullPage: true });

    // The Easy mix slider (admin-console-ia AC): keyboard-stepped from the
    // seeded 50% down to 25% and released — settings.easyMixRatio lands 0.25
    // and the squares bubble tracked the drag.
    const slider = page.getByRole('slider', { name: 'Easy mix percentage' });
    await slider.focus();
    for (let i = 0; i < 5; i++) await slider.press('ArrowLeft');
    await expect(page.getByText('25% · 6 of 24 squares')).toBeVisible();
    await slider.blur();
    await expect.poll(async () => (await eventField(testEnv, uid, 'settings'))?.easyMixRatio).toBe(0.25);
  });

  test('admin_confirmed: a text (Callout) proof lands pending and does NOT count until an Admin confirms it; reject discards it', async ({
    browser,
  }) => {
    // Two independent Players, an admin promote, a claim submit/confirm AND a
    // second submit/reject — comfortably over the 30s default given the local
    // emulator's write latency under this suite's serial single-worker run.
    test.setTimeout(60_000);
    // A separate seed (own testEnv) so this test's claim-mode flip and marks
    // never interact with the panel-round-trip test above.
    const { testEnv: env } = await seedDailyEvent();
    // Declared OUTSIDE the try so the finally can close them (#317): these two
    // contexts used to leak — the finally only ran env.cleanup() — leaving two
    // ZOMBIE pages (admin on /more, player on the Card) open for the REST OF
    // THE SUITE, each with a live signed-in Firestore client on the shared
    // emulator. Every later spec's clearFirestore+reseed then fired those
    // clients' listeners against the fresh world, and their retried creates /
    // re-deals materialized stray users/players docs MID-TEST in other specs —
    // the union run's cross-spec poisoning (e.g. a phantom second Leaderboard
    // row in x-e2e-happy-path, 'already-exists' commit spam in the logs).
    let ctxAdmin: BrowserContext | undefined;
    let ctxPlayer: BrowserContext | undefined;
    try {
      ctxAdmin = await browser.newContext();
      ctxPlayer = await browser.newContext();
      const adminPage = await ctxAdmin.newPage();
      const playerPage = await ctxPlayer.newPage();

      await joinViaSharedLink(adminPage);
      const adminUid = await signedInUid(adminPage);
      await waitForBoardServerConfirmed(adminPage);
      await dismissCoach(adminPage);

      await env.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), 'events', EVENT_ID), {
          admins: [adminUid],
          claimMode: 'admin_confirmed',
        });
      });

      await joinViaSharedLink(playerPage);
      const playerUid = await signedInUid(playerPage);
      await waitForBoardServerConfirmed(playerPage);
      await dismissCoach(playerPage);
      const dealt = await readDealtDayGrid(playerPage);
      const promptText = dealt.find((t, i) => i !== 12 && t.trim().length > 0)!;

      // admin_confirmed mode: tapping an unmarked Square opens the sheet with
      // NO pledge fast-path (disabled) — a real proof is required. Use the
      // TEXT tab (no Storage round trip).
      await playerPage.locator('.grid .cell').filter({ hasText: promptText }).click();
      await expect(playerPage.locator('.sheet-title', { hasText: promptText })).toBeVisible();
      const pledgeBtn = playerPage.getByRole('button', { name: /cross my heart/i });
      await expect(pledgeBtn).toBeDisabled();
      await playerPage.getByRole('button', { name: 'Callout' }).click();
      await playerPage.getByPlaceholder(/Name names/).fill('Saw it with my own eyes, 100%.');
      await expect(playerPage.getByText(/Goes pending until an admin confirms/)).toBeVisible();
      await playerPage.getByRole('button', { name: 'Submit claim' }).click();
      await expect(playerPage.locator('.sheet-title', { hasText: promptText })).toHaveCount(0);
      await playerPage.screenshot({ path: `${SHOTS}/admin-claim-submitted-pending.png`, fullPage: true });

      // Ground truth: the Square is 'pending' (not credited) on the Player's
      // board — a pending claim never counts toward the leaderboard.
      await expect
        .poll(async () => {
          let cells: ReturnType<typeof cellsFromData> = [];
          await env.withSecurityRulesDisabled(async (ctx) => {
            const snap = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID, 'days', String(TODAY_INDEX), 'boards', playerUid));
            cells = cellsFromData(snap.data()?.cells);
          });
          return cells.find((c) => c.text === promptText)?.status;
        }, { timeout: 10_000 })
        .toBe('pending');
      let playerSnap = await readPlayer(env, playerUid);
      expect(playerSnap.squaresMarked ?? 0).toBe(0);

      // The Admin sees it in the Review queue's Pending-claims group
      // (admin-console-ia — the merged inbox at /more/admin/queue), scoped to
      // that group's own `.admin-section` so a same-text row in another group
      // can never make the filter ambiguous.
      await adminPage.getByRole('link', { name: 'More' }).click();
      await adminPage.getByRole('button', { name: /^Admin/ }).click();
      await adminPage.getByRole('dialog', { name: 'Admin' }).getByRole('button', { name: 'Review queue' }).click();
      await expect(adminPage.getByRole('dialog', { name: 'Review queue' })).toBeVisible();
      const pendingClaimsSection = adminPage.locator('.admin-section').filter({ hasText: 'Pending claims' });
      const claimRow = pendingClaimsSection.locator('.row').filter({ hasText: promptText });
      await expect(claimRow).toBeVisible({ timeout: 10_000 });
      await adminPage.screenshot({ path: `${SHOTS}/admin-pending-claims-queue.png`, fullPage: true });

      await claimRow.getByRole('button', { name: 'Confirm' }).click();
      await expect(pendingClaimsSection.locator('.row').filter({ hasText: promptText })).toHaveCount(0, { timeout: 10_000 });

      // Confirmed: the claim doc flips, the Square is credited, and the Proof
      // (created 'pending'/admin-only) is published 'active'. confirmClaim
      // (src/data/admin.ts) is its own runTransaction, independent of a
      // Player's markChains, but still a real emulator round trip — a
      // generous timeout under a busy shared emulator, not a weaker assertion.
      await expect
        .poll(async () => {
          const snap = await readPlayer(env, playerUid);
          return snap.squaresMarked ?? 0;
        }, { timeout: 25_000 })
        .toBe(1);
      await env.withSecurityRulesDisabled(async (ctx) => {
        const claimSnap = await getDocs(query(collection(ctx.firestore(), 'events', EVENT_ID, 'claims'), where('uid', '==', playerUid)));
        expect(claimSnap.docs).toHaveLength(1);
        expect(claimSnap.docs[0].data().status).toBe('confirmed');
        const proofSnap = await getDocs(query(collection(ctx.firestore(), 'events', EVENT_ID, 'proofs'), where('uid', '==', playerUid)));
        expect(proofSnap.docs[0].data().status).toBe('active');
      });

      // --- Reject path: a second Square, rejected, must NOT credit. ---
      const secondPrompt = dealt.find((t, i) => i !== 12 && t.trim().length > 0 && t !== promptText)!;
      await playerPage.locator('.grid .cell').filter({ hasText: secondPrompt }).click();
      await playerPage.getByRole('button', { name: 'Callout' }).click();
      await playerPage.getByPlaceholder(/Name names/).fill('Reject-path callout.');
      await playerPage.getByRole('button', { name: 'Submit claim' }).click();
      await expect(playerPage.locator('.sheet-title', { hasText: secondPrompt })).toHaveCount(0);

      const secondRow = pendingClaimsSection.locator('.row').filter({ hasText: secondPrompt });
      await expect(secondRow).toBeVisible({ timeout: 10_000 });
      // The reject control is an icon-only button (visible text "✕"; "Reject"
      // is only its `title` tooltip, not its accessible name) — select by the
      // title attribute rather than a role/name match on "Reject".
      await secondRow.locator('button[title="Reject"]').click();
      await expect(pendingClaimsSection.locator('.row').filter({ hasText: secondPrompt })).toHaveCount(0, { timeout: 10_000 });

      // Rejected: never credited — squaresMarked stays at 1 (only the confirmed one).
      playerSnap = await readPlayer(env, playerUid);
      expect(playerSnap.squaresMarked ?? 0).toBe(1);
      await env.withSecurityRulesDisabled(async (ctx) => {
        const claimSnap = await getDocs(
          query(collection(ctx.firestore(), 'events', EVENT_ID, 'claims'), where('uid', '==', playerUid)),
        );
        expect(claimSnap.docs).toHaveLength(2);
        const rejected = claimSnap.docs.find((d) => d.data().itemText === secondPrompt);
        expect(rejected?.data().status).toBe('rejected');
      });
      await adminPage.screenshot({ path: `${SHOTS}/admin-claim-rejected.png`, fullPage: true });
    } finally {
      // Best-effort teardown (CodeRabbit, PR #339): one close throwing must
      // not skip the other close or env.cleanup() — a surviving signed-in
      // context is exactly the zombie-listener class this suite fix hunts.
      await ctxAdmin?.close().catch(() => {});
      await ctxPlayer?.close().catch(() => {});
      await env.cleanup();
    }
  });
});

async function eventField(
  testEnv: RulesTestEnvironment,
  _uid: string,
  field: 'claimMode' | 'settings',
): Promise<{ photoProofSource?: string; stripPhotoExif?: boolean; visionGate?: boolean; reportHideThreshold?: number; easyMixRatio?: number } | string | undefined> {
  let value: unknown;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID));
    value = (snap.data() as Record<string, unknown> | undefined)?.[field];
  });
  return value as never;
}

async function readPlayer(testEnv: RulesTestEnvironment, uid: string): Promise<{ squaresMarked?: number }> {
  let data: Record<string, unknown> = {};
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID, 'players', uid));
    data = (snap.data() as Record<string, unknown>) ?? {};
  });
  return data as { squaresMarked?: number };
}
