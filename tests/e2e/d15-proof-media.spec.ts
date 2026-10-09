// The photo/audio Proof round trip, end to end against the emulator stack (#335).
//
// Photo and audio create path-only Proofs with null media URL fields. Feed
// renderers download authenticated SDK bytes by storagePath and own app-origin
// blob URLs. These cases assert the stored contract and real decoded playback.
//
// The fake camera/mic Chromium flags below are what make the AUDIO half
// drivable at all: `ProofSheet.startRec` calls `navigator.mediaDevices
// .getUserMedia({ audio: true })`, which headless Chromium answers with a
// synthetic tone (and auto-accepts the permission prompt) under these flags.
import { test, expect, type Page } from '@playwright/test';
import { seedDailyEvent, dismissCoach, readDealtDayGrid } from './support/daily';
import { joinViaSharedLink, signedInUid } from './support/join';
import { waitForBoardServerConfirmed } from './support/board';
import { EVENT_ID } from './support/env';

// Worker-scoped, so it must sit at file level (Playwright forbids launchOptions
// inside a describe). Harmless for the photo case, load-bearing for the audio one.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['microphone'],
});

const SHOTS = process.env.E2E_SHOT_DIR || 'test-results/shots';

// A real 1×1 PNG — `uploadProofMedia` re-encodes photo proofs through a canvas
// (the #211 EXIF strip) and REFUSES to upload anything it could not decode, so
// the fixture has to be a genuinely decodable image, not arbitrary bytes.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);


interface StoredProof {
  id: string;
  type: string;
  mediaURL: null;
  thumbURL: null;
  storagePath: string;
}

/** The committed Proof doc for `uid`, read with rules disabled — ground truth
 *  that the write actually landed (a UI that merely closed proves nothing). */
async function readOwnProof(
  testEnv: Awaited<ReturnType<typeof seedDailyEvent>>['testEnv'],
  uid: string,
): Promise<StoredProof> {
  let stored: StoredProof | undefined;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const { collection, getDocs, query, where } = await import('firebase/firestore');
    await expect
      .poll(
        async () => {
          const snap = await getDocs(
            query(collection(ctx.firestore(), 'events', EVENT_ID, 'proofs'), where('uid', '==', uid)),
          );
          if (snap.docs.length !== 1) return 0;
          const d = snap.docs[0];
          stored = { id: d.id, ...(d.data() as Omit<StoredProof, 'id'>) };
          return 1;
        },
        { timeout: 20_000, message: 'waiting for the media Proof doc to commit' },
      )
      .toBe(1);
  });
  return stored!;
}

/** Open the claim sheet on a dealt, unmarked Prompt and return its text. */
async function openClaimSheet(page: Page): Promise<string> {
  const dealt = await readDealtDayGrid(page);
  const prompt = dealt.find((t, i) => i !== 12 && t.trim().length > 0)!;
  await page.locator('.grid .cell').filter({ hasText: prompt }).click();
  await expect(page.locator('.sheet-title', { hasText: prompt })).toBeVisible();
  return prompt;
}

/** Arm a dialog handler BEFORE the submit click — `alert()` blocks page JS, so a
 *  handler armed afterwards would deadlock the failure path instead of reporting
 *  it. Returns a getter for whatever alert text (if any) the submit produced. */
function captureSubmitAlert(page: Page): () => string | null {
  let alertText: string | null = null;
  page.once('dialog', (d) => {
    alertText = d.message();
    void d.dismiss();
  });
  return () => alertText;
}

test.describe('photo/audio Proof media round trip', () => {
  test('a photo Proof commits only its path and renders authenticated SDK bytes', async ({
    page,
  }) => {
    const { testEnv } = await seedDailyEvent();
    try {
      await joinViaSharedLink(page);
      const uid = await signedInUid(page);
      await waitForBoardServerConfirmed(page);
      await dismissCoach(page);

      await openClaimSheet(page);
      await page.getByRole('button', { name: /Photo/ }).click();
      await page.getByLabel('Library').setInputFiles({
        name: 'proof.png',
        mimeType: 'image/png',
        buffer: TINY_PNG,
      });
      await expect(page.locator('.preview')).toBeVisible();

      const submitAlert = captureSubmitAlert(page);
      await page.getByRole('button', { name: 'Mark it' }).click();
      // The sheet closing IS the success signal (`submit` closes only after
      // attachProof's transaction commits); an alert would mean the 403 is back.
      await expect(page.locator('.sheet-backdrop')).toHaveCount(0, { timeout: 20_000 });
      expect(submitAlert()).toBeNull();

      const stored = await readOwnProof(testEnv, uid);
      expect(stored.type).toBe('photo');
      expect(stored.storagePath).toBe(`proofs/${EVENT_ID}/${uid}/${stored.id}.jpg`);
      expect(stored.mediaURL).toBeNull();
      expect(stored.thumbURL).toBeNull();

      // The Feed renders an object URL from authenticated SDK bytes; the
      // browser must still decode the real emulator-backed media.
      await page.locator('nav.tabs a', { hasText: 'Feed' }).click();
      const photo = page.locator('img.proof-media');
      await expect(photo).toBeVisible({ timeout: 15_000 });
      expect(await photo.getAttribute('src')).toMatch(/^blob:/);
      await expect
        .poll(async () => photo.evaluate((el: HTMLImageElement) => el.naturalWidth), {
          timeout: 15_000,
          message: 'the proof <img> must decode real pixels, not 404 into a broken image',
        })
        .toBeGreaterThan(0);
      // The 🖼️ library source badge (#190) over genuinely loaded media.
      await expect(page.locator('.proof-src-badge', { hasText: '🖼️ library' })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/proof-media-photo-feed.png`, fullPage: true });
    } finally {
      await testEnv.cleanup();
    }
  });

  test('an audio Proof recorded from the fake mic commits and plays back from the emulator', async ({
    page,
  }) => {
    const { testEnv } = await seedDailyEvent();
    try {
      await joinViaSharedLink(page);
      const uid = await signedInUid(page);
      await waitForBoardServerConfirmed(page);
      await dismissCoach(page);

      await openClaimSheet(page);
      await page.getByRole('button', { name: /Sound/ }).click();
      await page.getByRole('button', { name: '● Record' }).click();
      // Long enough for the fake device to emit encodable frames — MediaRecorder
      // is started without a timeslice, so the single dataavailable fires on
      // stop and an instant stop can yield a zero-byte clip (the #295 guard).
      await expect(page.getByRole('button', { name: '■ Stop' })).toBeVisible();
      await page.waitForTimeout(1_500);
      await page.getByRole('button', { name: '■ Stop' }).click();

      // A real captured clip previews; the #295 empty-clip error must NOT show.
      await expect(page.locator('audio.preview')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.audio-error')).toHaveCount(0);

      const submitAlert = captureSubmitAlert(page);
      await page.getByRole('button', { name: 'Mark it' }).click();
      await expect(page.locator('.sheet-backdrop')).toHaveCount(0, { timeout: 20_000 });
      expect(submitAlert()).toBeNull();

      const stored = await readOwnProof(testEnv, uid);
      expect(stored.type).toBe('audio');
      // Chromium records WebM/Opus; the .m4a branch of the same rule is iOS
      // Safari's (#295) and is not reachable from this browser.
      expect(stored.storagePath).toBe(`proofs/${EVENT_ID}/${uid}/${stored.id}.webm`);
      expect(stored.mediaURL).toBeNull();
      expect(stored.thumbURL).toBeNull();

      await page.locator('nav.tabs a', { hasText: 'Feed' }).click();
      const audio = page.locator('.proof-audio');
      await expect(audio).toBeVisible({ timeout: 15_000 });
      const audioSrc = await page.locator('.proof-audio audio').getAttribute('src');
      expect(audioSrc).toMatch(/^blob:/);
      // Real, decodable audio: the element reports a finite duration only once
      // the browser has parsed the SDK-downloaded clip from its object URL.
      await expect
        .poll(
          async () =>
            page
              .locator('.proof-audio audio')
              .evaluate((el: HTMLAudioElement) => (Number.isFinite(el.duration) ? el.duration : 0)),
          { timeout: 20_000, message: 'the proof <audio> must load a real clip from the emulator' },
        )
        .toBeGreaterThan(0);
      await page.screenshot({ path: `${SHOTS}/proof-media-audio-feed.png`, fullPage: true });
    } finally {
      await testEnv.cleanup();
    }
  });
});
