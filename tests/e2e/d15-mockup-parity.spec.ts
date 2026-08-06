// Mockup-parity regression net (specs/d15-mockup-parity.md) — the shipped app
// asserted against plans/daily-cards-wireframes.html screen by screen, at the
// wireframes' own 393×852 canvas, over the emulator-seeded parity fixture.
//
// Two layers:
//   1. STRUCTURAL — exact player-facing copy, Lucide glyph classes, tab
//      order, day-chip lock states, claim-sheet controls, admin defaults
//      (EXIF strip ON), the tally-dedupe names line, and the Feed photo
//      proof actually LOADING (naturalWidth > 0 — the "empty media area
//      under the 🖼️ badge" prod symptom from the parity catalog).
//   2. VISUAL — `toHaveScreenshot` baselines per screen over a deterministic
//      board (the app's own dealBoard with a FIXED seed, written over the
//      random-uid deal), volatile regions masked (clocks, relative times,
//      the signed-in identity, the version build hash).
//
// NOT asserted here: the wireframe HTML itself is never pixel-diffed — it is
// a hand-drawn frame with placeholder data, not a rendering target.
import { test, expect, type Page } from '@playwright/test';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  seedParityFixture,
  grantAdmin,
  PLAYER_A,
  PLAYER_B,
  SHARED_ITEM_TEXT,
  PARITY_NOW,
  PARITY_TODAY_INDEX,
  PARITY_LOCKED_INDEX,
  PARITY_FAREWELL_INDEX,
} from './support/parity';
import { readDealtDayGrid, dismissCoach } from './support/daily';
import { userAttested } from './support/seed';
import { joinViaSharedLink, signedInUid } from './support/join';
import { EVENT_ID } from './support/env';
import { dealBoard, type DealItem } from '../../src/game/logic';
// @ts-expect-error — plain-JS seed script, no type declarations (see support/seed.ts).
import { ITEMS, seedItemDocId } from '../../scripts/seed.mjs';

let testEnv: RulesTestEnvironment;

test.use({ viewport: { width: 393, height: 852 }, screenshot: 'only-on-failure' });

test.beforeAll(async () => {
  ({ testEnv } = await seedParityFixture());
});

test.afterAll(async () => {
  await testEnv?.cleanup();
});

/** The tab bar's four entries, in wireframe order, with their Lucide classes. */
const TABS: Array<{ label: string; lucide: string | null }> = [
  { label: 'Card', lucide: 'lucide-grid-3x3' },
  { label: 'Feed', lucide: 'lucide-radio' },
  { label: 'Ranks', lucide: 'lucide-trophy' },
  { label: 'More', lucide: null }, // avatar (or ellipsis fallback) — not a Lucide glyph
];

test('structural parity — every screen against the wireframes', async ({ page }) => {
  // Freeze the browser clock mid-cruise on the fixture's schedule so the
  // date-driven header and the unlock-driven chips agree, deterministically.
  await page.clock.install({ time: PARITY_NOW });
  await joinViaSharedLink(page);
  const uid = await signedInUid(page);

  await test.step('tab bar: order, labels, Lucide glyphs, visible More label', async () => {
    const tabs = page.locator('nav.tabs a');
    await expect(tabs).toHaveCount(4);
    for (const [i, t] of TABS.entries()) {
      await expect(tabs.nth(i)).toContainText(t.label);
      if (t.lucide) await expect(tabs.nth(i).locator(`svg.${t.lucide}`)).toBeVisible();
    }
  });

  await test.step('header: brand + two-line day identity (no itinerary line)', async () => {
    await expect(page.locator('.nav .brand')).toContainText('GAY CRUISE');
    // The seeded schedule's "today" is Day 3 (Valletta · Duty Free).
    await expect(page.locator('.nav')).toContainText('Valletta');
    // The one-line itinerary ("Trieste to Barcelona…") stays retired (#300).
    await expect(page.locator('.nav')).not.toContainText('Trieste to Barcelona');
  });

  await test.step('coach overlay: badge legend with sample chips, then dismiss', async () => {
    // Generous window: the first deal round-trips a token refresh under the
    // frozen clock before the day-scoped board write confirms.
    await expect(page.locator('.grid')).toHaveAttribute('data-server-confirmed', 'true', { timeout: 20_000 });
    const overlay = page.locator('.coach-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('How to read your card');
    await expect(overlay.locator('.coach-overlay-chip')).toHaveText(['4', '👀 2', '＋', 'FREE']);
    await expect(overlay).toContainText('never unmarks');
    await page.getByRole('button', { name: 'Got it—deal me in.' }).click();
    await expect(overlay).not.toBeVisible();
  });

  await test.step('launch intro: three reshuffle beats, shown once, then dismissed (#frame-launch-intro)', async () => {
    // Queued behind the coach overlay above — it only mounts once that flag is
    // set, which is why this step follows the dismissal rather than racing it.
    const intro = page.locator('.launch-intro');
    await expect(intro).toBeVisible();
    await expect(intro).toContainText('New today: reshuffles');
    await expect(intro).toContainText('Dealt a dud?');
    await expect(intro).toContainText('Three for the whole cruise');
    await expect(intro).toContainText("the moment you tap a square, the card's yours for the day");
    await page.getByRole('button', { name: "Nice—let's play" }).click();
    await expect(intro).not.toBeVisible();
  });

  await test.step('reshuffle: day-bar chip on a pristine card + confirm sheet (#frame-reshuffle)', async () => {
    // The walk reaches this step BEFORE the claim-sheet step marks anything, so
    // the dealt card is still pristine and the chip is live. The final step below
    // re-checks it once a Mark has landed.
    const chip = page.locator('.reshuf');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('×3');
    await expect(chip.locator('svg.lucide-shuffle')).toHaveCount(1);

    await chip.click();
    const sheet = page.locator('.reshuffle-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Reshuffle this card?');
    await expect(sheet).toContainText(`A fresh 24 squares for Day ${PARITY_TODAY_INDEX + 1}—same day, new luck.`);
    await expect(sheet).toContainText("This can't be undone.");
    await expect(sheet).toContainText("You'll never see this card again—and reshuffles don't come back.");
    await expect(sheet).toContainText("3 of 3 cruise reshuffles left · available only before you've marked a square");
    await expect(sheet.getByRole('button', { name: 'Keep my card' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: /Reshuffle it/ })).toBeVisible();

    // Cancel — this walk must not actually spend a reshuffle, or every later step
    // would assert against a re-dealt card.
    await page.getByRole('button', { name: 'Keep my card' }).click();
    await expect(sheet).not.toBeVisible();
    await expect(chip).toBeVisible();
  });

  await test.step('day switcher: single-line chips, lock states, WARM-UP/GOODBYE tags', async () => {
    const chips = page.getByRole('tab');
    await expect(chips).toHaveCount(5);
    // Chips stay one line high (#293): strip height under two line-boxes.
    const box = await page.locator('.day-switcher').boundingBox();
    expect(box && box.height).toBeLessThan(64);
    await expect(chips.nth(0)).toHaveAccessibleName(/Warm-up/i);
    await expect(chips.nth(PARITY_LOCKED_INDEX)).toHaveAccessibleName(/locked/i);
    await expect(chips.nth(PARITY_FAREWELL_INDEX)).toHaveAccessibleName(/Goodbye/i);
  });

  await test.step('tutorial banner + free-space overrides: Welcome Aboard copy and farewell locked centre', async () => {
    await page.getByRole('tab').nth(0).click();
    await expect(page.locator('.grid')).toHaveAttribute('data-server-confirmed', 'true', { timeout: 20_000 });
    const embark = page.locator('.board-area');
    await expect(embark).toHaveAttribute('data-theme', 'welcome-aboard');
    await expect(embark.locator('.tutorial-banner-embark')).toContainText('Mark what happens. Tap a square when you see it, do it, or survive it.');
    await expect(embark.locator('.tutorial-banner-embark')).toContainText("Five in a row is BINGO. The center is free. Blackout the card if you're ambitious.");
    await expect(embark.locator('.tutorial-banner-embark')).toContainText('The feed is the proof. Attach a pic, doubt a friend, watch the Moments roll in.');
    await expect(embark.locator('.tutorial-banner-embark')).toContainText("This one's a warm-up—easy squares, all on the ship. The real chaos starts tomorrow at 8.");
    await expect(embark.locator('.grid .cell').nth(12)).toContainText('You made it aboard');

    await page.getByRole('tab').nth(PARITY_FAREWELL_INDEX).click();
    const farewell = page.locator('.board-area.day-locked');
    await expect(farewell).toBeVisible();
    await expect(farewell).toHaveAttribute('data-theme', 'so-long-farewell');
    await expect(farewell.locator('.free-prompt')).toHaveText('We had the best damn time');
    await page.getByRole('tab').nth(PARITY_TODAY_INDEX).click();
    await readDealtDayGrid(page);
  });

  await test.step('locked-day preview: themed retint, exact lock badge, dress-code tease, caption', async () => {
    await page.getByRole('tab').nth(PARITY_LOCKED_INDEX).click();
    const locked = page.locator('.board-area.day-locked');
    await expect(locked).toBeVisible();
    // The board area carries the VIEWED Day's theme (#301/#306).
    await expect(locked).toHaveAttribute('data-theme', 'glamiators');
    await expect(locked.locator('.day-lock-text')).toHaveText('Unlocks 8:00 a.m. · Sat, Jul 18');
    await expect(locked).toContainText('24 fresh squares land at 8. Come back after coffee.');
    // The theme's dress-code description doubles as the party tease.
    await expect(locked).toContainText(/toga-chic|runway excess/i);
    // Only the free centre is populated; squares deal nothing.
    await expect(locked.locator('.locked-grid .cell')).toHaveCount(25);
    await expect(locked.locator('.free-prompt')).toHaveCount(1);
    await page.getByRole('tab').nth(PARITY_TODAY_INDEX).click();
    await readDealtDayGrid(page);
  });

  await test.step('claim sheet: pledge, segments, photo affordances, EXIF-safe library note, heat line', async () => {
    const cellTexts = await readDealtDayGrid(page);
    // Never the shared-Tally Prompt (Codex P2 on #316): it already carries the
    // two fixture markers, so the heat line would read "4 others" whenever the
    // random deal put it first.
    const targetIndex = cellTexts.findIndex(
      (t, i) => i !== 12 && t.trim().length > 0 && t !== SHARED_ITEM_TEXT,
    );
    const target = cellTexts[targetIndex];
    // Two seeded "others" on THIS Prompt (today's Day) light the heat line.
    const itemId = seedItemDocId(target);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      for (const [heatUid, name] of [['fixture-heat-1', 'Heat One'], ['fixture-heat-2', 'Heat Two']] as const) {
        await setDoc(doc(db, 'events', EVENT_ID, 'tally', itemId, 'markers', heatUid), {
          uid: heatUid, displayName: name, markedAt: PARITY_NOW - 3 * 3_600_000, dayIndex: PARITY_TODAY_INDEX, itemText: target,
        });
      }
    });
    // Click by cell index — the square may now wear its tally badge, so its
    // textContent is no longer an exact match for the prompt alone.
    await page.locator('.grid .cell').nth(targetIndex).click();
    const sheet = page.locator('.sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(`Proof for “${target}”`);
    await expect(sheet).toContainText('🔥 Marked by 2 others so far');
    await expect(sheet.getByRole('button', { name: /cross my heart/i })).toBeEnabled();
    // Proof-type segments with their Lucide glyphs.
    for (const [label, glyph] of [['Photo', 'lucide-camera'], ['Sound', 'lucide-mic'], ['Callout', 'lucide-pen-line']] as const) {
      const seg = sheet.getByRole('button', { name: label, exact: true });
      await expect(seg).toBeVisible();
      await expect(seg.locator(`svg.${glyph}`)).toBeVisible();
    }
    // #190 photo body: Take photo (live capture) + Library, with the badge
    // note. The body mounts on the Photo segment tap (the wireframe paints it
    // open — the default-segment gap is catalogued under #309).
    await sheet.getByRole('button', { name: 'Photo', exact: true }).click();
    await expect(sheet.getByText('Take photo')).toBeVisible();
    await expect(sheet.getByText('Library', { exact: true })).toBeVisible();
    await expect(sheet).toContainText('Library picks wear a 🖼️ badge on the Feed');
    const capture = sheet.locator('input[type="file"][capture]');
    await expect(capture).toHaveAttribute('accept', 'image/*');
    await expect(sheet.locator('input[type="file"]:not([capture])')).toHaveAttribute('accept', 'image/*');
    // Cancel out — the walk must not mark anything here.
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).not.toBeVisible();
    // Drop the heat markers again (Codex P2 on #316): they were written for a
    // RANDOM dealt Prompt, and the visual-baseline test reuses this fixture —
    // a leftover "Heat One/Two" tally on a colliding square would repaint the
    // deterministic screenshots nondeterministically.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const { deleteDoc } = await import('firebase/firestore');
      const db = ctx.firestore();
      for (const heatUid of ['fixture-heat-1', 'fixture-heat-2']) {
        await deleteDoc(doc(db, 'events', EVENT_ID, 'tally', itemId, 'markers', heatUid));
      }
    });
  });

  await test.step('feed: tally card dedupe line, day chips, loaded photo + 🖼️ badge, audio chrome, callout, moment', async () => {
    await page.locator('nav.tabs a', { hasText: 'Feed' }).click();
    // The shared Tally Card reads BOTH names — never one name twice (#216 + dedupe).
    const tallyCard = page.locator('.tally-card', { hasText: SHARED_ITEM_TEXT });
    await expect(tallyCard).toContainText(`${PLAYER_A.displayName}, ${PLAYER_B.displayName}`);
    await expect(tallyCard).not.toContainText(`${PLAYER_A.displayName}, ${PLAYER_A.displayName}`);
    // Its Day reference is PLAIN text (wireframe `.who`), not the bordered pill.
    await expect(tallyCard.locator('.tally-day')).toContainText('Day 3');
    await expect(tallyCard.locator('.proof-day-chip')).toHaveCount(0);
    await expect(tallyCard).toContainText('tap for who');

    // The photo proof MUST actually render pixels — a valid <img> with the 🖼️
    // badge over an empty media area is the prod bug this line locks out.
    const photo = page.locator('.proof', { hasText: PLAYER_A.displayName }).locator('img.proof-media');
    await expect(photo).toBeVisible();
    await expect
      .poll(async () => photo.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.locator('.proof-src-badge', { hasText: '🖼️ library' })).toBeVisible();

    // Proof day chips render as the bordered pill on PROOF cards.
    await expect(page.locator('.proof .proof-day-chip').first()).toContainText('Day 3 · ✈️ Duty Free');
    // Audio proof wears the wireframes' player chrome, not native controls.
    const audio = page.locator('.proof-audio');
    await expect(audio.locator('svg.lucide-play')).toBeVisible();
    await expect(audio.locator('.proof-audio-wave')).toBeVisible();
    // Text proof renders the ✍️ callout quote.
    await expect(page.locator('.proof-quote', { hasText: 'Customs in Valletta' })).toBeVisible();
    // The Moment card renders its celebratory line.
    await expect(page.locator('.moment', { hasText: 'got a BINGO!' })).toBeVisible();
  });

  await test.step('feed tally card tap → who-list sheet', async () => {
    await page.locator('.tally-card', { hasText: SHARED_ITEM_TEXT }).locator('.tally-card-body').click();
    const sheet = page.locator('.sheet');
    await expect(sheet).toContainText(PLAYER_A.displayName);
    await expect(sheet).toContainText(PLAYER_B.displayName);
    await page.keyboard.press('Escape');
  });

  await test.step('ranks: honors strip, fixture rows, player-voice footnote', async () => {
    await page.locator('nav.tabs a', { hasText: 'Ranks' }).click();
    // Leaderboard sits behind a loading gate; late in a full-suite run the
    // players subscription can take well past the 5s default to deliver.
    await expect(page.getByText(PLAYER_A.displayName).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(PLAYER_B.displayName).first()).toBeVisible();
    // The footnote is player copy (#298/#302), not the wireframe annotation.
    await expect(page.locator('.lb-footnote')).toContainText('Every Day Card counts here');
    await expect(page.locator('.lb-footnote')).not.toContainText('Totals sum every Day Card');
  });

  await test.step('more menu: rows in order, Auto theme default copy, S/M/L, version footer', async () => {
    await page.locator('nav.tabs a', { hasText: 'More' }).click();
    await expect(page.getByText(/Auto: match the day/)).toBeVisible();
    // The auto row spells "(🛳️ today)" WITH the space when today resolves.
    await expect(page.getByText(/\(\S+ today\)/)).toBeVisible();
    for (const size of ['Small', 'Medium', 'Large']) {
      await expect(page.getByRole('button', { name: size, exact: true })).toBeVisible();
    }
    for (const row of ['Cruise schedule', 'Suggest a square', 'How to play', 'Report a bug', 'Sign out']) {
      await expect(page.getByText(row, { exact: true })).toBeVisible();
    }
    // Version footer: build + route + dates.
    await expect(page.locator('.more-version')).toContainText('Trieste → Barcelona');
    // Signed-in non-admin: no Admin row yet (anchored — "Goes to admin
    // review" on the Suggest row must not match).
    await expect(page.locator('.more-row-title', { hasText: /^Admin$/ })).toHaveCount(0);
  });

  await test.step('admin: hub-and-detail IA (admin-console-ia); Game settings defaults — EXIF strip ON', async () => {
    await grantAdmin(testEnv, uid);
    const adminRow = page.getByRole('button', { name: /Admin/ });
    await expect(adminRow.first()).toBeVisible();
    await adminRow.first().click();
    // The hub: five section cards, sticky header with Done.
    const hub = page.getByRole('dialog', { name: 'Admin' });
    await expect(hub).toBeVisible();
    for (const card of ['Review queue', 'Game settings', 'Schedule', 'Prompt pool', 'Players']) {
      await expect(hub.getByRole('button', { name: card })).toBeVisible();
    }
    await expect(hub.getByRole('button', { name: 'Done' })).toBeVisible();

    // Game settings detail: the claims/proof knobs under the new chrome.
    await hub.getByRole('button', { name: 'Game settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Game settings' });
    await expect(settings).toBeVisible();
    await expect(page.getByText('Claim mode')).toBeVisible();
    await expect(page.getByText('Photo proof source')).toBeVisible();
    const stripRow = page.locator('.row', { hasText: 'Strip location data' });
    await expect(stripRow).toBeVisible();
    // Spec default ON: an event doc with no explicit setting reads as checked.
    await expect(stripRow.locator('input[type="checkbox"]')).toBeChecked();
    await expect(page.getByText('AI image screen')).toBeVisible();
    await expect(page.getByText('Auto-hide after reports')).toBeVisible();
    // The Easy mix slider with its squares bubble (admin-console-ia).
    await expect(page.getByRole('slider', { name: 'Easy mix percentage' })).toBeVisible();
    await expect(page.getByText(/of 24 squares/)).toBeVisible();

    // ‹ Admin backs out to the hub; Schedule detail: locked vs editable rows,
    // with a sticky Done visible without scrolling on this taller-than-viewport
    // surface (the dismissal contract's AC). `exact` — a bare "Admin" substring
    // would also match the Claim-mode row's "Admin-confirmed" segment.
    await settings.getByRole('button', { name: 'Admin', exact: true }).click();
    await hub.getByRole('button', { name: 'Schedule' }).click();
    await expect(page.getByRole('dialog', { name: 'Schedule' })).toBeVisible();
    await expect(page.getByText('locked—already unlocked or past').first()).toBeVisible();
    await expect(page.getByText('editable until unlock').first()).toBeVisible();
    const done = page.getByRole('dialog', { name: 'Schedule' }).getByRole('button', { name: 'Done' });
    await expect(done).toBeVisible();
    const box = await done.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(852);
    // Done closes the entire admin from this depth, back to More.
    await done.click();
    await expect(page.getByRole('dialog', { name: 'Schedule' })).toHaveCount(0);
    await expect(page.getByText(/Auto: match the day/)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Visual baselines — the regression net going forward. Deterministic content:
// the app's own dealBoard with a FIXED seed replaces the random-uid deal, and
// the volatile chrome (clocks, relative times, the signed-in identity, build
// hash) is masked. 393×852, animations disabled by toHaveScreenshot itself.
// ---------------------------------------------------------------------------

const FIXED_SEED = 424242;

async function writeDeterministicBoard(env: RulesTestEnvironment, uid: string): Promise<string[]> {
  const pool: DealItem[] = (ITEMS as Array<{ text: string; spicy: boolean }>).map((it) => ({
    id: seedItemDocId(it.text),
    text: it.text,
    spicy: it.spicy,
  }));
  const cells = dealBoard(pool, 'Complain about circuit music', FIXED_SEED);
  // Three marks give the card its wireframe look (gradient fill + tally badge).
  for (const i of [0, 6, 18]) {
    cells[i] = { ...cells[i], marked: true, markedAt: PARITY_NOW - 3 * 3_600_000 };
  }
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'events', EVENT_ID, 'days', String(PARITY_TODAY_INDEX), 'boards', uid), {
      uid, dayIndex: PARITY_TODAY_INDEX, seed: FIXED_SEED, createdAt: PARITY_NOW - 6 * 3_600_000, cells,
    });
    await updateDoc(doc(db, 'events', EVENT_ID, 'players', uid), { displayName: 'Parity Tester' });
  });
  return cells.map((c) => c.text);
}

/** Regions whose content varies run to run — masked out of every baseline. */
function volatileMasks(page: Page) {
  return [
    page.locator('.day-lock-text'), // structurally pinned above; masked from broad visual diffs
    page.locator('.proof .sub'), // proof-card clock labels
    page.locator('.tally-card .sub'), // "bumped 1h ago · tap for who"
    page.locator('.moment .sub'),
    page.locator('.avatar-trigger'), // the signed-in identity (random autogen account)
    page.locator('.more-version'), // build hash footer
  ];
}

test.describe('visual baselines (393×852, emulator fixture)', () => {
  // The committed expected images are `*-chromium-darwin.png` — this layer is
  // local-only (docs/agents/testing-requirements.md) and darwin-rendered; a
  // Linux checkout would look for `-linux` baselines that do not exist
  // (Codex P2 on #316), so it self-skips off darwin instead of failing.
  test.skip(process.platform !== 'darwin', 'visual baselines are darwin-only (local e2e layer)');

  test('card, locked preview, claim sheet, feed, more, admin', async ({ page }) => {
    await page.clock.install({ time: PARITY_NOW });
    await joinViaSharedLink(page);
    const uid = await signedInUid(page);
    await expect(page.locator('.grid')).toHaveAttribute('data-server-confirmed', 'true', { timeout: 20_000 });
    await dismissCoach(page);
    const cellTexts = await writeDeterministicBoard(testEnv, uid);
    // The 18+ attestation persists via a Firestore TRANSACTION that starts
    // after the signed-in shell renders — reloading before it commits lands
    // on the re-attestation gate (the same race d15-coach-overlay documents).
    await expect.poll(async () => userAttested(testEnv, uid), { timeout: 15_000 }).toBe(true);
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 30_000 });
    await dismissCoach(page);
    // The persistent Firestore cache can replay the PREVIOUS random deal on
    // reload (Codex P2 on #316) — wait until the grid shows the deterministic
    // board's own first cell, not merely any fully-dealt grid.
    await expect
      .poll(async () => (await page.locator('.grid .cell').allTextContents())[0], { timeout: 20_000 })
      .toContain(cellTexts[0]);
    await readDealtDayGrid(page);
    await page.evaluate(() => document.fonts.ready);

    const shot = (name: string) =>
      expect(page).toHaveScreenshot(name, { mask: volatileMasks(page), maxDiffPixelRatio: 0.02 });

    await shot('card-today.png');

    await page.getByRole('tab').nth(PARITY_LOCKED_INDEX).click();
    await expect(page.locator('.board-area.day-locked')).toBeVisible();
    await shot('locked-day-preview.png');
    await page.getByRole('tab').nth(PARITY_TODAY_INDEX).click();
    await readDealtDayGrid(page);

    // An UNMARKED cell (the deterministic board pre-marks 0/6/18; 12 is free),
    // clicked by index — a badge-wearing cell's text is not an exact match.
    const targetIndex = cellTexts.findIndex(
      (t, i) => i !== 12 && ![0, 6, 18].includes(i) && t.trim().length > 0,
    );
    await page.locator('.grid .cell').nth(targetIndex).click();
    await expect(page.locator('.sheet')).toBeVisible();
    await shot('claim-sheet.png');
    await page.locator('.sheet').getByRole('button', { name: 'Cancel' }).click();

    await page.locator('nav.tabs a', { hasText: 'Feed' }).click();
    await expect(page.locator('img.proof-media')).toBeVisible();
    await shot('feed.png');

    await page.locator('nav.tabs a', { hasText: 'More' }).click();
    await expect(page.getByText(/Auto: match the day/)).toBeVisible();
    await shot('more-menu.png');

    await grantAdmin(testEnv, uid);
    const adminRow = page.getByRole('button', { name: /Admin/ });
    await expect(adminRow.first()).toBeVisible();
    await adminRow.first().click();
    // The admin-console-ia parity set: hub, Game settings, Review queue.
    const hub = page.getByRole('dialog', { name: 'Admin' });
    await expect(hub.getByRole('button', { name: 'Players' })).toBeVisible();
    await shot('admin-hub.png');
    await hub.getByRole('button', { name: 'Game settings' }).click();
    await expect(page.getByText('Claim mode')).toBeVisible();
    await shot('admin-settings.png');
    await page.getByRole('dialog', { name: 'Game settings' }).getByRole('button', { name: 'Admin', exact: true }).click();
    await hub.getByRole('button', { name: 'Review queue' }).click();
    await expect(page.getByRole('dialog', { name: 'Review queue' })).toBeVisible();
    await shot('admin-queue.png');
  });
});
