// Phase 1.5 verification — the Claim/Proof sheet's two photo affordances
// (#190, daily-cards-spec). Drives the real ProofSheet against the Firebase
// emulators: an unmarked Square's tap opens the sheet with BOTH 📷 Take photo
// and 🖼️ Library; a Library pick attaches a real file and previews it; the
// social heat line reads the Prompt's already-subscribed Tally count; and the
// event-level `camera_only` override hides Library, leaving only Take photo,
// in EVERY Claim Mode (never gated on claimMode itself).
//
// The Library pick's FULL round trip — submit → Storage upload → committed
// Proof doc — is exercised too. It used to 403 here 100% deterministically:
// Storage's EMULATOR `getDownloadURL()` returns a `http://127.0.0.1:9199/...`
// URL, while firestore.rules' proof-create rule regex-pins `mediaURL` to the
// PRODUCTION `https://firebasestorage.googleapis.com/...` host (by design — a
// forged non-Storage URL must never pass as proof media), so the rule the
// coverage exists to protect was the one thing e2e could not exercise. #335
// closed that with the flag-gated canonicalize/resolve pair in
// `src/data/proofMediaUrl.ts` — the emulator download URL is rewritten to its
// production-shaped twin at proof-write (so the regex is exercised FOR REAL,
// not relaxed) and inverted at render. The deeper media assertions — the
// stored URL against the literal rules regex, the rendered <img>/<audio> src
// against the emulator origin, decoded pixels, and the audio half via the fake
// mic — live in `tests/e2e/d15-proof-media.spec.ts`; this case just proves the
// affordance it is about actually completes a claim.
import { test, expect, type Page } from '@playwright/test';
import { seedDailyEvent, dismissCoach, readDealtDayGrid } from './support/daily';
import { joinViaSharedLink, signedInUid } from './support/join';
import { claimCellByText, waitForBoardServerConfirmed } from './support/board';
import { EVENT_ID } from './support/env';

const SHOTS = process.env.E2E_SHOT_DIR || 'test-results/shots';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function firstSharedPrompt(gridA: string[], gridB: string[]): string {
  const setB = new Set(gridB.filter((_, i) => i !== 12));
  const shared = gridA.find((t, i) => i !== 12 && t.trim().length > 0 && setB.has(t));
  if (!shared) throw new Error('No shared prompt between the two dealt boards — re-run (see file header note).');
  return shared;
}

test.describe('claim sheet photo affordances', () => {
  test('both affordances render by default; a Library pick badges the Feed proof; the heat line shows', async ({
    browser,
  }) => {
    const { testEnv } = await seedDailyEvent();
    let pageA: Page | undefined;
    let pageB: Page | undefined;
    try {
      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      pageA = await ctxA.newPage();
      pageB = await ctxB.newPage();

      await joinViaSharedLink(pageA);
      await signedInUid(pageA);
      await waitForBoardServerConfirmed(pageA);
      await dismissCoach(pageA);
      const gridA = await readDealtDayGrid(pageA);

      await joinViaSharedLink(pageB);
      const uidB = await signedInUid(pageB);
      await waitForBoardServerConfirmed(pageB);
      await dismissCoach(pageB);
      const gridB = await readDealtDayGrid(pageB);

      const prompt = firstSharedPrompt(gridA, gridB);

      // A marks the shared Prompt first (bare honor Mark) — B's later claim
      // sheet on the SAME Prompt should read "Marked by 1 other so far".
      await claimCellByText(pageA, prompt);

      // Ground-truth wait for A's marker doc to be server-visible before B taps
      // — avoids a race where B's claim sheet opens against a tally count that
      // has not yet synced (the heat line only appears once `useTally` resolves;
      // this just makes the assertion below deterministic rather than relying on
      // pure UI polling latitude).
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const itemSnap = await getDocs(
          query(collection(ctx.firestore(), 'events', EVENT_ID, 'items'), where('text', '==', prompt)),
        );
        const itemId = itemSnap.docs[0].id;
        await expect
          .poll(async () => (await getDocs(collection(ctx.firestore(), 'events', EVENT_ID, 'tally', itemId, 'markers'))).size, {
            timeout: 10_000,
          })
          .toBeGreaterThanOrEqual(1);
      });

      // B taps their OWN unmarked cell for the same Prompt — the claim sheet.
      const cellB = pageB.locator('.grid .cell').filter({ hasText: prompt });
      await cellB.click();
      await expect(pageB.locator('.sheet-title', { hasText: prompt })).toBeVisible();

      // The heat line (ADR 0002): the Prompt's already-subscribed Tally count,
      // excluding the viewer's own (not-yet-made) Mark.
      await expect(pageB.getByText(/Marked by 1 other so far/)).toBeVisible({ timeout: 10_000 });

      await pageB.getByRole('button', { name: /Photo/ }).click();
      // BOTH affordances present by default (camera_or_library, the fallback
      // when the event carries no `settings.photoProofSource` override).
      await expect(pageB.getByLabel('Take photo')).toBeVisible();
      await expect(pageB.getByLabel('Library')).toBeVisible();
      await pageB.screenshot({ path: `${SHOTS}/claim-sheet-both-affordances.png`, fullPage: true });

      // The Library pick — no `capture` attribute, the ProfileEditor-style
      // full picker — attaches a real file and previews it, which is as far
      // as this client-side step goes before the submit's network round trip.
      await pageB.getByLabel('Library').setInputFiles({
        name: 'library-pick.png',
        mimeType: 'image/png',
        buffer: TINY_PNG,
      });
      await expect(pageB.locator('.preview')).toBeVisible();
      await pageB.screenshot({ path: `${SHOTS}/claim-sheet-library-preview.png`, fullPage: true });

      // The submit now COMPLETES against this stack (#335). `alert()` blocks the
      // page's JS, so the dialog handler is still armed BEFORE the click — an
      // alert here would mean the host mismatch is back, and it must be captured
      // rather than deadlock the run.
      let alertText: string | null = null;
      pageB.once('dialog', (d) => {
        alertText = d.message();
        void d.dismiss();
      });
      await pageB.getByRole('button', { name: 'Mark it' }).click();
      // ProofSheet closes only after attachProof's transaction commits, so the
      // sheet going away IS the success signal.
      await expect(pageB.locator('.sheet-backdrop')).toHaveCount(0, { timeout: 20_000 });
      expect(alertText).toBeNull();

      // Ground truth: the Proof doc landed, with the media pinned to the exact
      // object this Proof owns — which is only possible because the committed
      // `mediaURL` satisfied the proof-create rule's production-host regex.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const snap = await getDocs(
          query(collection(ctx.firestore(), 'events', EVENT_ID, 'proofs'), where('uid', '==', uidB)),
        );
        expect(snap.docs).toHaveLength(1);
        const proof = snap.docs[0];
        expect(proof.data().type).toBe('photo');
        expect(proof.data().source).toBe('library');
        expect(proof.data().storagePath).toBe(`proofs/${EVENT_ID}/${uidB}/${proof.id}.jpg`);
        expect(proof.data().mediaURL).toMatch(
          /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/proofs%2F/,
        );
      });
    } finally {
      await pageA?.context().close();
      await pageB?.context().close();
      await testEnv.cleanup();
    }
  });

  test('the camera_only event override hides the Library affordance', async ({ page }) => {
    const { testEnv } = await seedDailyEvent();
    try {
      // The event-level override (#190) — never gated on Claim Mode. A dotted
      // field path patches just this key, leaving the seed's other `settings`
      // (reportHideThreshold, spicyRatio) intact for the deal that follows.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const { doc, updateDoc } = await import('firebase/firestore');
        await updateDoc(doc(ctx.firestore(), 'events', EVENT_ID), {
          'settings.photoProofSource': 'camera_only',
        });
      });

      await joinViaSharedLink(page);
      await signedInUid(page);
      await waitForBoardServerConfirmed(page);
      await dismissCoach(page);
      const dealt = await readDealtDayGrid(page);
      const prompt = dealt.find((t, i) => i !== 12 && t.trim().length > 0)!;

      await page.locator('.grid .cell').filter({ hasText: prompt }).click();
      await expect(page.locator('.sheet-title', { hasText: prompt })).toBeVisible();
      await page.getByRole('button', { name: /Photo/ }).click();

      await expect(page.getByLabel('Take photo')).toBeVisible();
      await expect(page.getByLabel('Library')).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/claim-sheet-camera-only.png`, fullPage: true });
    } finally {
      await testEnv.cleanup();
    }
  });
});
