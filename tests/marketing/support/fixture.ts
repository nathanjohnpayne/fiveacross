// Marketing-screenshot fixture (docs/app/marketing-screenshots.md).
//
// Seeds a self-contained demo Event into the Firestore emulator so a capture
// run never touches production data. Three rules make its output publishable:
//
//   1. INVENTED display names. Never the real roster — the live podium, the
//      Daily Honors strip and every Feed card carry real people's names.
//   2. The Bodega Bay (Vacay) pools ONLY. They are general-audience
//      (spicyRatio 0); the Gay Cruise Bingo pool is never seeded here.
//   3. NO photo proofs. A hero shot must carry nobody's real picture, and a
//      staged fake one would be worse.
//
// `HERO_PROMPT_EXCLUSIONS` trims a handful of otherwise-fine prompts that read
// badly blown up on a portfolio page.
import { doc, setDoc } from 'firebase/firestore';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync as readCache, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error — plain-JS seed script, no type declarations.
import { seedItemDocId } from '../../../scripts/seed.mjs';
import { ITEMS, EASY_ITEMS, CLOSING_ITEMS } from '../../../scripts/seed-data/bodega-bay-2026.mjs';

/** Keep this literal in lockstep with scripts/marketing-shots.sh's PROJECT_ID:
 *  the emulator, the browser bundle and this seeder must all name the same
 *  demo project or the app's writes evaluate rules under a different one. */
export const HERO_PROJECT_ID = 'demo-fiveacross-marketing';
export const HERO_EVENT_ID = 'hero-shot';
export const HERO_WEB_PORT = 5184;
export const HERO_BASE_URL = `http://127.0.0.1:${HERO_WEB_PORT}`;
const FIRESTORE_HOST = '127.0.0.1';
const FIRESTORE_PORT = 8080;

const HOUR = 3_600_000;

/** `YYYY-MM-DD` in the Event's own timezone, `offsetDays` from today. */
function isoDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 24 * HOUR);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Prompts held OUT of the hero deal. Every one is a real, general-audience
 * Bodega prompt — they are excluded because a portfolio hero is read by
 * recruiters, not because the Event needed them cut. (The jammies line carries
 * a typo the live pool also carries; not something to enlarge to 393px.)
 */
const HERO_PROMPT_EXCLUSIONS = new Set([
  'Share a photo you’ve taken where you feel sexy',
  'Take a photo of somebody else looking sexy',
  'Take a shot',
  'Give a convincing speech on why men should not be included in this trip',
  'Post of a picture of you and somebody else in your jammies',
]);

export const heroDealable = (items: Array<{ text: string }>) =>
  items.filter((it) => !HERO_PROMPT_EXCLUSIONS.has(it.text));

/** Which Edition chrome the build under capture wears. */
export type HeroEdition = 'vacay' | 'fiveacross';
export const HERO_EDITION: HeroEdition =
  (process.env.HERO_EDITION as HeroEdition | undefined) ?? 'vacay';

/**
 * Invented display names. Deliberately NOT the real roster: first name plus an
 * initial, common enough to read as a group chat and specific to nobody.
 */
const PLAYERS = [
  { uid: 'hero-p1', displayName: 'Rae M.', squares: 11, bingos: 1 },
  { uid: 'hero-p2', displayName: 'Devon K.', squares: 9, bingos: 1 },
  { uid: 'hero-p3', displayName: 'Priya S.', squares: 8, bingos: 0 },
  { uid: 'hero-p4', displayName: 'Tomas L.', squares: 6, bingos: 0 },
];
export const FIRST_BINGO = PLAYERS[0];

/** Today's Day index in the seeded schedule below. */
export const HERO_TODAY_INDEX = 0;

/**
 * Per-Day deal inputs, keyed by Day index — the ONE place that says which pool
 * a Day is dealt from and what its free space reads. Both the Event seed below
 * and the spec's deterministic board read this, so switching
 * `HERO_TODAY_INDEX` moves the card AND its contents together.
 *
 * Codex P2 on #1020: these used to be stated twice — the `days[]` literal here
 * and a hardcoded `EASY_ITEMS` deal in the spec. Following the doc's "capture a
 * different Day" row therefore repointed the board document while still dealing
 * warm-up prompts, producing a main-Day screenshot full of warm-up content that
 * looked entirely successful.
 */
export const HERO_DAY_DEAL: ReadonlyArray<{
  pool: 'embark' | 'main' | 'farewell';
  items: Array<{ text: string; spicy?: boolean }>;
  freeText: string;
}> = [
  { pool: 'embark', items: EASY_ITEMS as Array<{ text: string; spicy?: boolean }>, freeText: 'The flock has landed' },
  { pool: 'main', items: ITEMS as Array<{ text: string; spicy?: boolean }>, freeText: 'Main character on the coast' },
  { pool: 'farewell', items: CLOSING_ITEMS as Array<{ text: string; spicy?: boolean }>, freeText: 'We did it for the story' },
];

// Per-Edition Day chrome. Bodega's own Themes are Vacay-scoped
// (THEME_EDITIONS), so the platform build wears the occasion-neutral trio.
const DAY_CHROME =
  HERO_EDITION === 'vacay'
    ? {
        defaultTheme: 'the-birds',
        days: [
          { place: 'Bodega Bay', placeEmoji: '🐚', theme: 'the-birds' },
          { place: 'Bodega Bay', placeEmoji: '🦪', theme: 'side-quests' },
          { place: 'Bodega Bay', placeEmoji: '🌅', theme: 'fog-froth-farewells' },
        ],
      }
    : {
        defaultTheme: 'marquee',
        days: [
          { place: 'Opening night', placeEmoji: '🎟️', theme: 'marquee' },
          { place: 'The main day', placeEmoji: '🎊', theme: 'confetti-hour' },
          { place: 'The slow morning', placeEmoji: '🌙', theme: 'afterglow' },
        ],
      };

type SeedItem = { text: string; spicy?: boolean };
const idsOf = (items: SeedItem[]): string[] => items.map((it) => seedItemDocId(it.text));

const RULES_PATH = fileURLToPath(new URL('../../../firestore.rules', import.meta.url));

export async function seedHeroEvent(): Promise<RulesTestEnvironment> {
  const testEnv = await initializeTestEnvironment({
    projectId: HERO_PROJECT_ID,
    firestore: {
      host: FIRESTORE_HOST,
      port: FIRESTORE_PORT,
      rules: readFileSync(RULES_PATH, 'utf8'),
    },
  });

  try {
    await testEnv.clearFirestore();
    const now = Date.now();
    const mainIds = idsOf(heroDealable(ITEMS as SeedItem[]) as SeedItem[]);
    const easyIds = idsOf(heroDealable(EASY_ITEMS as SeedItem[]) as SeedItem[]);
    const closingIds = idsOf(heroDealable(CLOSING_ITEMS as SeedItem[]) as SeedItem[]);

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();

      // Every prompt doc across the three Bodega pools.
      for (const { items, pool } of [
        { items: ITEMS as SeedItem[], pool: 'main' },
        { items: EASY_ITEMS as SeedItem[], pool: 'embark' },
        { items: CLOSING_ITEMS as SeedItem[], pool: 'farewell' },
      ]) {
        for (const it of items) {
          await setDoc(doc(db, 'events', HERO_EVENT_ID, 'items', seedItemDocId(it.text)), {
            text: it.text,
            createdBy: 'seed',
            createdAt: now - 200 * HOUR,
            isFreeSpace: false,
            status: 'active',
            reportCount: 0,
            spicy: it.spicy === true,
            pool,
          });
        }
      }

      // The Event: a three-day weekend, Day 1 unlocked this morning (today),
      // Day 2 still locked so the standings are NOT frozen.
      await setDoc(doc(db, 'events', HERO_EVENT_ID), {
        name: HERO_EDITION === 'vacay' ? 'Bodega Bay' : 'The weekend',
        startsOn: isoDay(-1),
        endsOn: isoDay(1),
        sailStart: isoDay(-1),
        sailEnd: isoDay(1),
        status: 'active',
        defaultTheme: DAY_CHROME.defaultTheme,
        claimMode: 'honor',
        settings: { reportHideThreshold: 4, spicyRatio: 0, easyMixRatio: 0.5 },
        timezone: 'America/Los_Angeles',
        days: [
          {
            index: 0,
            date: isoDay(-1),
            ...DAY_CHROME.days[0],
            port: DAY_CHROME.days[0].place,
            portEmoji: DAY_CHROME.days[0].placeEmoji,
            tonight: ['🍷 Arrival pours', '🌊 First look at the water'],
            pool: HERO_DAY_DEAL[0].pool,
            // The warm-up card: tutorial pool, tutorial tag, gentlest prompts.
            tutorial: true,
            scoring: 'competitive',
            unlockAt: now - 6 * HOUR,
            snapshotItemIds: easyIds,
            freeText: HERO_DAY_DEAL[0].freeText,
          },
          {
            index: 1,
            date: isoDay(0),
            ...DAY_CHROME.days[1],
            port: DAY_CHROME.days[1].place,
            portEmoji: DAY_CHROME.days[1].placeEmoji,
            tonight: ['🦀 Harbor dinner', '🌅 Sunset'],
            pool: HERO_DAY_DEAL[1].pool,
            tutorial: false,
            scoring: 'competitive',
            unlockAt: now + 20 * HOUR,
            snapshotItemIds: mainIds,
            freeText: HERO_DAY_DEAL[1].freeText,
          },
          {
            index: 2,
            date: isoDay(1),
            ...DAY_CHROME.days[2],
            port: DAY_CHROME.days[2].place,
            portEmoji: DAY_CHROME.days[2].placeEmoji,
            tonight: ['☕ Last coffee', '🧳 The slow pack'],
            pool: HERO_DAY_DEAL[2].pool,
            // Ordinary locked Day, not the ceremonial wrap-up: the GOODBYE tag
            // a `tutorial` closing Day wears pushes the third chip past the
            // 393pt viewport, and a hero image with a word clipped mid-letter
            // reads as a rendering bug rather than as a horizontal scroller.
            tutorial: false,
            scoring: 'competitive',
            unlockAt: now + 44 * HOUR,
            snapshotItemIds: closingIds,
            freeText: HERO_DAY_DEAL[2].freeText,
          },
        ],
      });

      for (const p of PLAYERS) {
        await setDoc(doc(db, 'events', HERO_EVENT_ID, 'players', p.uid), {
          uid: p.uid,
          displayName: p.displayName,
          photoURL: null,
          joinedAt: now - 26 * HOUR,
          squaresMarked: p.squares,
          bingoCount: p.bingos,
          firstBingoAt: p.bingos > 0 ? now - 3 * HOUR : null,
          dayStats: {
            [HERO_TODAY_INDEX]: {
              bingoCount: p.bingos,
              squaresMarked: p.squares,
              firstBingoAt: p.bingos > 0 ? now - 3 * HOUR : null,
            },
          },
        });
      }

      // The pinned first-BINGO honor behind the card header's honors line.
      await setDoc(
        doc(db, 'events', HERO_EVENT_ID, 'days', String(HERO_TODAY_INDEX), 'meta', String(HERO_TODAY_INDEX)),
        { firstBingo: { uid: FIRST_BINGO.uid, displayName: FIRST_BINGO.displayName, at: now - 3 * HOUR } },
      );

      // Feed content: a shared tally (two players on one prompt), two text
      // proofs and a BINGO moment. No photo proofs — a hero shot must not
      // carry anybody's real picture, and a fake one would be worse.
      const sharedText = (ITEMS as SeedItem[])[0].text;
      const sharedId = seedItemDocId(sharedText);
      for (const [p, ago] of [
        [PLAYERS[1], 2 * HOUR],
        [PLAYERS[2], 1 * HOUR],
      ] as const) {
        await setDoc(doc(db, 'events', HERO_EVENT_ID, 'tally', sharedId, 'markers', p.uid), {
          uid: p.uid,
          displayName: p.displayName,
          markedAt: now - ago,
          dayIndex: HERO_TODAY_INDEX,
          itemText: sharedText,
        });
      }

      await setDoc(doc(db, 'events', HERO_EVENT_ID, 'proofs', 'hero-text-1'), {
        uid: PLAYERS[3].uid,
        displayName: PLAYERS[3].displayName,
        photoURL: null,
        itemText: (ITEMS as SeedItem[])[3].text,
        type: 'text',
        text: 'Took the long way. Worth it.',
        createdAt: now - 40 * 60_000,
        status: 'active',
        reportCount: 0,
        dayIndex: HERO_TODAY_INDEX,
      });
      await setDoc(doc(db, 'events', HERO_EVENT_ID, 'proofs', 'hero-text-2'), {
        uid: PLAYERS[2].uid,
        displayName: PLAYERS[2].displayName,
        photoURL: null,
        itemText: (EASY_ITEMS as SeedItem[])[6].text,
        type: 'text',
        text: 'To the group chat that actually showed up.',
        createdAt: now - 20 * 60_000,
        status: 'active',
        reportCount: 0,
        dayIndex: HERO_TODAY_INDEX,
      });

      // The world-readable routing document. A single-Event build treats
      // VITE_ADULT_CONTENT=false as an UNPROVEN seed and re-derives the posture
      // from `hostnames/{host}`; with no document the posture fails closed and
      // the 18+ gate returns. Bodega's pool is tame, so this is the truthful
      // value, not a convenience.
      await setDoc(doc(db, 'hostnames', '127.0.0.1'), {
        eventId: HERO_EVENT_ID,
        canonicalHost: '127.0.0.1',
        edition: HERO_EDITION,
        status: 'active',
        adultContent: false,
      });

      await setDoc(doc(db, 'events', HERO_EVENT_ID, 'moments', `${FIRST_BINGO.uid}-bingo`), {
        kind: 'bingo',
        uid: FIRST_BINGO.uid,
        displayName: FIRST_BINGO.displayName,
        photoURL: null,
        createdAt: now - 3 * HOUR,
        dayIndex: HERO_TODAY_INDEX,
      });
    });
  } catch (error) {
    await testEnv.cleanup().catch(() => {});
    throw error;
  }

  return testEnv;
}

/** Rename the signed-in browser Player so the roster carries no autogen id. */
export async function renameSignedInPlayer(
  testEnv: RulesTestEnvironment,
  uid: string,
  displayName: string,
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), 'events', HERO_EVENT_ID, 'players', uid),
      { displayName },
      { merge: true },
    );
  });
}

// --- sign-in ---------------------------------------------------------------
// Copied from support/join.ts (which hard-asserts the GCB wordmark) so this
// throwaway can drive the Vacay / Five Across gates too.

const GAPI_CACHE_DIR = path.join(process.cwd(), 'node_modules', '.cache', 'gcb-e2e-gapi');

async function cacheThroughGapi(route: Route): Promise<void> {
  const request = route.request();
  if (request.method() !== 'GET') return route.fallback();
  const url = request.url();
  const key = createHash('sha1').update(url).digest('hex');
  const file = path.join(GAPI_CACHE_DIR, key);
  if (existsSync(file)) {
    try {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: readCache(file) });
    } catch {
      /* fall through to a fresh fetch */
    }
  }
  const response = await route.fetch();
  const body = await response.body();
  if (response.ok()) {
    try {
      mkdirSync(GAPI_CACHE_DIR, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, body);
      renameSync(tmp, file);
    } catch {
      /* best-effort cache */
    }
  }
  return route.fulfill({ response });
}

/** Wait briefly for a locator; report whether it showed up. */
export async function isPresent(locator: import('@playwright/test').Locator, timeout: number): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

/** Click a locator if it appears within `timeout`; otherwise do nothing. */
export async function clickIfPresent(
  locator: import('@playwright/test').Locator,
  timeout: number,
): Promise<boolean> {
  if (!(await isPresent(locator, timeout))) return false;
  await locator.first().click();
  return true;
}

export async function joinHero(page: Page): Promise<void> {
  const ctx = page.context();
  await ctx.route(/^https:\/\/(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '' }),
  );
  await ctx.route(/^https:\/\/(apis\.google\.com|www\.gstatic\.com)\//, cacheThroughGapi);

  await page.goto('/');
  // `locator.isVisible()` never waits, so these optional scrims are waited for
  // explicitly and treated as absent on timeout.
  await clickIfPresent(page.getByRole('button', { name: /got it/i }), 10_000);

  // The 18+ acknowledgement only renders on an adult-content build; the hero
  // build seeds an ungated hostname document, so check it only if it appears.
  const ack = page.getByRole('checkbox').first();
  if (await isPresent(ack, 3_000)) await ack.check();

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('load', { timeout: 30_000 });
  const autogen = popup.locator('#autogen-button');
  await expect(async () => {
    if (!(await autogen.isVisible())) await popup.locator('.js-new-account').click();
    await expect(autogen).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 10_000 });
  await autogen.click();
  await popup.locator('#sign-in').click();

  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 30_000 });
}

export async function signedInUid(page: Page): Promise<string> {
  const uid = await page.evaluate(async () => {
    const open = indexedDB.open('firebaseLocalStorageDb');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const store = db
        .transaction('firebaseLocalStorage', 'readonly')
        .objectStore('firebaseLocalStorage');
      const rows = await new Promise<Array<{ fbase_key?: string; value?: { uid?: string } }>>(
        (resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result as never);
          req.onerror = () => reject(req.error);
        },
      );
      return rows.find((r) => r.fbase_key?.startsWith('firebase:authUser:'))?.value?.uid ?? '';
    } finally {
      db.close();
    }
  });
  if (!uid) throw new Error('No signed-in Firebase user found.');
  return uid;
}
