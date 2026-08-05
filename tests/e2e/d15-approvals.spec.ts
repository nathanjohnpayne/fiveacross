// Phase 1.5 verification — the Approvals flow (#210, daily-cards-spec §
// "Item pools and the approval flow"). Drives the real app + Firebase
// emulators: a Player-submitted Prompt (More → Suggest a square → ItemPool)
// lands `pending` — invisible in the general pool, visible only to its
// submitter tagged "pending review" — until an Admin approves it (More →
// Admin → Review queue) and it flips `active`.
//
// "Never dealt" while pending holds by construction here (every seeded Day's
// Board/snapshot is already frozen before this submission exists) — the part
// this spec actually exercises end to end is "can enter a NOT-YET-UNLOCKED
// Day's snapshot" once approved. `npm run test:e2e` DOES boot the Functions
// emulator (scripts/test-e2e.sh: `--only auth,firestore,storage,functions`),
// but the scheduler that stamps a Day's `snapshotItemIds`
// (`functions/src/unlockDay.ts`, driven by the scheduled `unlockDay` trigger) is
// a CRON trigger — unreachable inside a short-lived test run whatever its
// cadence, which is why the cadence is deliberately not named here — and its one
// on-demand escape hatch, the `unlockDayNow` callable (admin-gated,
// `functions/src/index.ts`), has NO wired UI affordance anywhere in
// `Admin.tsx` for a real Admin to invoke as an actual user action (a real,
// separate gap worth a look — see the verification report). So rather than
// reach around the UI to invoke a callable no Admin can actually reach, this
// spec imports the SAME pure, unit-tested `activeSnapshotIds` the scheduler
// calls (functions/src/unlockDay.ts — it takes a plain items array + a
// filter, no Admin SDK) and calls it against the REAL post-approval Firestore
// state for the seeded LOCKED Day, proving the approved item is (now)
// eligible for that Day's eventual snapshot — the same predicate the real
// scheduled run applies.
import { test, expect } from '@playwright/test';
import { doc, updateDoc, collection, getDocs, getDoc, query, where } from 'firebase/firestore';
import { seedDailyEvent, dismissCoach, LOCKED_INDEX } from './support/daily';
import { joinViaSharedLink, signedInUid } from './support/join';
import { waitForBoardServerConfirmed } from './support/board';
import { EVENT_ID } from './support/env';
import { activeSnapshotIds, type SnapshotItem } from '../../functions/src/unlockDay';

const SHOTS = process.env.E2E_SHOT_DIR || 'test-results/shots';

test('a Player-submitted prompt lands Pending, then an Admin approval makes it active and snapshot-eligible', async ({
  page,
}) => {
  const { testEnv } = await seedDailyEvent();
  try {
    await joinViaSharedLink(page);
    const uid = await signedInUid(page);
    await waitForBoardServerConfirmed(page);
    await dismissCoach(page);

    const promptText = `Verification prompt ${Date.now()}`;

    // Submit via the real UI: More → Suggest a square → ItemPool's add bar.
    await page.getByRole('link', { name: 'More' }).click();
    await page.getByRole('button', { name: /Suggest a square/ }).click();
    await page.getByPlaceholder('Add a prompt…').fill(promptText);
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // Pending: visible ONLY to the submitter, tagged "pending review" — never
    // in the general (active) pool list.
    const ownRow = page.locator('.row').filter({ hasText: promptText });
    await expect(ownRow).toBeVisible({ timeout: 10_000 });
    await expect(ownRow.getByText('pending review')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/approvals-pending-own-row.png`, fullPage: true });

    // Emulator ground truth: the item doc is `status: 'pending'`, and a
    // status=='active' query — the SAME query useItems()/the live deal pool
    // run — excludes it, i.e. it cannot be dealt onto any card while pending.
    let itemId = '';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDocs(
        query(collection(ctx.firestore(), 'events', EVENT_ID, 'items'), where('text', '==', promptText)),
      );
      expect(snap.docs).toHaveLength(1);
      itemId = snap.docs[0].id;
      expect(snap.docs[0].data().status).toBe('pending');
      const activeSnap = await getDocs(
        query(collection(ctx.firestore(), 'events', EVENT_ID, 'items'), where('status', '==', 'active')),
      );
      expect(activeSnap.docs.map((d) => d.id)).not.toContain(itemId);
    });

    // Promote this Player to admin (seedDailyEvent leaves `admins` empty).
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'events', EVENT_ID), { admins: [uid] });
    });

    // The Admin row appears live (useEventDoc is a subscription — no reload).
    await page.getByRole('button', { name: 'Close' }).click(); // close the Suggest panel
    const adminRow = page.getByRole('button', { name: /^Admin/ });
    await expect(adminRow).toBeVisible({ timeout: 10_000 });
    await adminRow.click();
    // Approvals live in the merged Review queue now (admin-console-ia):
    // hub card → /more/admin/queue, Approvals group.
    await page.getByRole('dialog', { name: 'Admin' }).getByRole('button', { name: 'Review queue' }).click();
    await expect(page.getByRole('dialog', { name: 'Review queue' })).toBeVisible();

    const queueRow = page.locator('.row').filter({ hasText: promptText });
    await expect(queueRow).toBeVisible({ timeout: 10_000 });
    await expect(queueRow.getByText(`submitted by ${uid}`, { exact: false })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/approvals-queue-row.png`, fullPage: true });
    await queueRow.getByRole('button', { name: 'Approve' }).click();

    // The whole inbox empties (this was the only pending item this seed
    // created, and nothing is reported) — the wireframes' empty state.
    await expect(page.getByText('All clear. Go enjoy the boat.')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/approvals-queue-empty-after-approve.png`, fullPage: true });

    // Emulator ground truth: `active`, stamped `approvedBy`/`approvedAt`.
    let approvedAt = 0;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDocs(
        query(collection(ctx.firestore(), 'events', EVENT_ID, 'items'), where('text', '==', promptText)),
      );
      const data = snap.docs[0].data();
      expect(data.status).toBe('active');
      expect(data.approvedBy).toBe(uid);
      expect(typeof data.approvedAt).toBe('number');
      approvedAt = data.approvedAt as number;
    });

    // It now shows in the general Prompts pool (no "pending review" pill).
    await page.getByRole('button', { name: 'Done' }).click(); // Done closes the admin from any depth
    await page.getByRole('button', { name: /Suggest a square/ }).click();
    const activeRow = page.locator('.row').filter({ hasText: promptText });
    await expect(activeRow).toBeVisible({ timeout: 10_000 });
    await expect(activeRow.getByText('pending review')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/approvals-active-in-pool.png`, fullPage: true });

    // Snapshot eligibility (see file header): the approved item is now
    // eligible to enter the LOCKED Day's snapshot once the scheduler fires —
    // proved against the REAL production predicate, not a re-implementation.
    let items: SnapshotItem[] = [];
    let lockedUnlockAt = 0;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const activeSnap = await getDocs(
        query(collection(ctx.firestore(), 'events', EVENT_ID, 'items'), where('status', '==', 'active')),
      );
      items = activeSnap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          pool: data.pool as string | undefined,
          isFreeSpace: data.isFreeSpace as boolean | undefined,
          reportCount: data.reportCount as number | undefined,
          createdBy: data.createdBy as string | undefined,
          createdAt: data.createdAt as number | undefined,
          approvedAt: data.approvedAt as number | undefined,
        };
      });
    });
    // The LOCKED Day (seeded with no snapshotItemIds — see support/daily.ts)
    // — its `unlockAt` is the future cutoff a real scheduled run would use.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const eventDoc = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID));
      const days = (eventDoc.data() as { days: Array<{ index: number; pool: string; unlockAt: number }> }).days;
      const lockedDay = days.find((d) => d.index === LOCKED_INDEX)!;
      lockedUnlockAt = lockedDay.unlockAt;
      const eligibleIds = activeSnapshotIds(items, { pool: lockedDay.pool, cutoff: lockedUnlockAt });
      expect(eligibleIds).toContain(itemId);
    });
    expect(approvedAt).toBeLessThan(lockedUnlockAt);
  } finally {
    await testEnv.cleanup();
  }
});
