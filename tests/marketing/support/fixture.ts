// Marketing-screenshot fixture (docs/app/marketing-screenshots.md).
//
// Seeds a self-contained demo Event into the Firestore emulator so a capture
// run never touches production data. Three rules make its output publishable:
//
//   1. INVENTED display names. Never the real roster — the live podium, the
//      Daily Honors strip and every Feed card carry real people's names.
//   2. GENERAL-AUDIENCE POOLS ONLY. Bodega Bay (Vacay) is general-audience
//      throughout. Gay Cruise Bingo is NOT: only its `embark` tutorial pool
//      (med-2026's EASY_ITEMS) may be seeded, and `ITEMS` — the main pool,
//      explicit throughout — is never imported into this file. That is
//      enforced by the import list below, not by anyone remembering it.
//      Note `spicy: false` is NOT a sufficient SFW test on its own: the
//      embark pool ships at least one unflagged prompt that cannot go on a
//      portfolio page, which is what HERO_PROMPT_EXCLUSIONS is for.
//   3. NO photo proofs. A hero shot must carry nobody's real picture, and a
//      staged fake one would be worse.
//
// `HERO_PROMPT_EXCLUSIONS` trims a handful of otherwise-fine prompts that read
// badly blown up on a portfolio page.
import { doc, setDoc } from 'firebase/firestore';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  completeEmulatorSignIn,
  dismissConsentNotice,
  signedInUid,
  stubAuthWidgetCdn,
} from '../../support/emulator-signin';

// Re-exported so the spec imports its whole sign-in surface from one place.
export { signedInUid };
// @ts-expect-error — plain-JS seed script, no type declarations.
import { seedItemDocId } from '../../../scripts/seed.mjs';
import { ITEMS, EASY_ITEMS, CLOSING_ITEMS } from '../../../scripts/seed-data/bodega-bay-2026.mjs';
// GCB: the `embark` TUTORIAL pool only. Importing med-2026's `ITEMS` here
// would put the explicit main pool one typo away from a published capture —
// this named import is the enforcement, so do not widen it to a namespace
// import or re-export.
// @ts-expect-error — plain-JS seed script, no type declarations.
import { EASY_ITEMS as GCB_EMBARK_ITEMS } from '../../../scripts/seed-data/med-2026.mjs';

/** Keep this literal in lockstep with scripts/marketing-shots.sh's PROJECT_ID:
 *  the emulator, the browser bundle and this seeder must all name the same
 *  demo project or the app's writes evaluate rules under a different one. */
export const HERO_PROJECT_ID = 'demo-fiveacross-marketing';
export const HERO_EVENT_ID = 'hero-shot';
export const HERO_WEB_PORT = 5184;
/** Build output for the capture bundle, kept out of the shared `dist`. */
export const HERO_DIST_DIR = 'dist-marketing';

/**
 * The instant every rendered timestamp is derived from: today's date at 18:00
 * in the Event's own zone.
 *
 * Pinned to a fixed TIME OF DAY rather than to `Date.now()` so two captures on
 * the same day produce identical pixels — the Ranks rows render
 * `firstBingoAt` through `toLocaleString`, which otherwise moved every run
 * (Codex P2 round 2 on #1020). Pinned to TODAY'S DATE rather than to an
 * absolute instant so the Event keeps reading as current; an absolute anchor
 * would rot into a "Until next year" header the moment it passed.
 */
/**
 * The absolute instant of `hour:00` local time on the Day `offsetDays` from
 * today — so an unlock can be placed ON its labeled calendar date rather than
 * at a fixed offset from now (Codex P2 on #1023).
 */
export function localHourOn(offsetDays: number, hour: number): number {
  const [y, m, d] = isoDay(offsetDays).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  // `hourCycle: 'h23'`, never `hour12: false`: the latter is permitted to format
  // midnight as `24:00:00` on some ICU builds, and this parses the result back
  // through `Date`, which normalises hour 24 to the FOLLOWING day — shifting the
  // computed offset by 24h and landing an unlock on the wrong calendar date for
  // roughly half the year (Codex P2 on #1023). It does not reproduce on this
  // runtime; `h23` makes it unrepresentable instead of relying on that.
  const zoned = new Date(
    new Intl.DateTimeFormat('en-US', {
      timeZone: EVENT_TIMEZONE,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .format(new Date(guess))
      .replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/, '$3-$1-$2T$4:$5:$6Z'),
  ).getTime();
  return guess + (guess - zoned);
}

export function heroClock(): number {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  // 18:00 local, expressed as an absolute instant. Built by probing the zone's
  // offset for that date rather than assuming one, so it is correct on both
  // sides of a DST boundary.
  const [y, m, d] = today.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 18, 0, 0);
  // `hourCycle: 'h23'`, never `hour12: false`: the latter is permitted to format
  // midnight as `24:00:00` on some ICU builds, and this parses the result back
  // through `Date`, which normalises hour 24 to the FOLLOWING day — shifting the
  // computed offset by 24h and landing an unlock on the wrong calendar date for
  // roughly half the year (Codex P2 on #1023). It does not reproduce on this
  // runtime; `h23` makes it unrepresentable instead of relying on that.
  const zoned = new Date(
    new Intl.DateTimeFormat('en-US', {
      timeZone: EVENT_TIMEZONE,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .format(new Date(guess))
      .replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/, '$3-$1-$2T$4:$5:$6Z'),
  ).getTime();
  return guess + (guess - zoned);
}
export const HERO_BASE_URL = `http://127.0.0.1:${HERO_WEB_PORT}`;
const FIRESTORE_HOST = '127.0.0.1';
const FIRESTORE_PORT = 8080;

const HOUR = 3_600_000;

/** The seeded Event's zone. Also pinned as Playwright's `timezoneId` so the
 *  rendered clock labels match the data. */
export const EVENT_TIMEZONE = 'America/Los_Angeles';

/** The seeded Event's easy-mix ratio; also what a main Day is dealt with. */
export const EVENT_EASY_MIX_RATIO = 0.5;

/** `YYYY-MM-DD` in the Event's own timezone, `offsetDays` from today. */
function isoDay(offsetDays: number): string {
  // Advance CALENDAR fields, never 24-hour blocks (Codex P2 on #1020). Around
  // the autumn fallback in America/Los_Angeles a day is 25 hours long, so
  // `Date.now() + 24h` can land on the same local date it started on — which
  // would emit duplicate Day dates and a one-day-short Event window. Resolve
  // today's local date first, then let Date.UTC normalise the day arithmetic
  // (it carries across month and year ends, and UTC has no DST to trip on).
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

/** Which Edition chrome the build under capture wears. */
export type HeroEdition = 'vacay' | 'fiveacross' | 'gcb';
export const HERO_EDITION: HeroEdition =
  (process.env.HERO_EDITION as HeroEdition | undefined) ?? 'vacay';

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
  // GCB embark pool. Flagged `spicy: false` and genuinely fine on the ship;
  // not a line to enlarge to 393pt on a page a recruiter reads.
  'Locate the Dick Deck (reconnaissance only)',
]);

export const heroDealable = (items: Array<{ text: string }>) =>
  items.filter((it) => !HERO_PROMPT_EXCLUSIONS.has(it.text));

/**
 * The `embark` pool for the Edition under capture — the ONE source for it.
 *
 * Both the Event's seeded item documents / Day-0 `snapshotItemIds` AND the
 * board `writeHeroBoard` deals read this. Deriving them separately is what
 * Codex caught on #1031: the GCB branch changed only the board, so the frozen
 * snapshot still listed Bodega ids while the board carried GCB prompts. The
 * capture looked right purely because the board is written with security rules
 * disabled — i.e. it depicted a card the app could never have dealt, which is
 * the same class of defect as seeding a Feed entry outside the active Day's
 * snapshot.
 */
const EMBARK_ITEMS: ReadonlyArray<{ text: string; spicy?: boolean }> =
  HERO_EDITION === 'gcb' ? GCB_EMBARK_ITEMS : EASY_ITEMS;

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

/** Seeded roster names — the spec waits on these instead of a blind delay. */
export const PLAYER_NAMES: readonly string[] = PLAYERS.map((p) => p.displayName);

/** A seeded Feed proof's body, used the same way. */
export const FEED_PROOF_TEXT = 'To the group chat that actually showed up.';

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
  freeText: string;
  /**
   * The prompts this Day is dealt from, already shaped the way the app shapes
   * them. `pool` is set on an item ONLY to mark it as the EASY half of a
   * main-Day mix; dealBoard reads it for exactly that split, and an untagged
   * item counts as main.
   */
  items: () => Array<{ text: string; spicy?: boolean; pool?: string }>;
  /** `stratify: pool === 'main'` — the app's own rule (src/data/draftPreview.ts). */
  stratify: boolean;
  /** The Event's `settings.easyMixRatio`; inert unless the pool carries embark items. */
  easyMixRatio: number;
}> = [
  {
    pool: 'embark',
    // Each Edition's own warm-up copy. GCB's is med-2026's Day 0 free space.
    freeText: HERO_EDITION === 'gcb' ? 'You made it aboard' : 'The flock has landed',
    // The TUTORIAL pool of whichever Edition is under capture. For GCB that is
    // `embark` and ONLY `embark` — its main pool is not imported into this
    // file at all, so a Day-index change cannot reach it by accident.
    items: () => [...(EMBARK_ITEMS as SeedItem[])],
    stratify: false,
    easyMixRatio: 0,
  },
  {
    pool: 'main',
    freeText: 'Main character on the coast',
    // A main Day blends main + easy 50/50 (specs/easy-mix.md), so the pool
    // carries BOTH and the easy half is tagged. Dealing main alone produced a
    // card the app would never deal (Codex P2 round 2 on #1020).
    items: () => [
      ...(ITEMS as SeedItem[]),
      ...(EMBARK_ITEMS as SeedItem[]).map((it) => ({ ...it, pool: 'embark' })),
    ],
    stratify: true,
    easyMixRatio: EVENT_EASY_MIX_RATIO,
  },
  {
    pool: 'farewell',
    freeText: 'We did it for the story',
    items: () => [...(CLOSING_ITEMS as SeedItem[])],
    stratify: false,
    easyMixRatio: 0,
  },
];

// Per-Edition Day chrome. Bodega's own Themes are Vacay-scoped
// (THEME_EDITIONS), so the platform build wears the occasion-neutral trio.
const DAY_CHROME =
  HERO_EDITION === 'gcb'
    ? {
        // med-2026's opening leg, wearing the Event's own default Theme
        // (`neon-playground`) rather than the boarding-day one. A Theme is a
        // skin any Day can wear — ThemeIsland lets a player switch at will —
        // so this is a real app state, and neon is the one that reads as Gay
        // Cruise Bingo at a glance next to the warm Vacay card.
        //
        // The Theme is CHROME. The POOL is the safety property, and it stays
        // `embark` via HERO_TODAY_INDEX — do not reach for med-2026's neon
        // Day 2 to get this look, because that Day is dealt from `main`.
        defaultTheme: 'neon-playground',
        days: [
          { place: 'Trieste', placeEmoji: '🇮🇹', theme: 'neon-playground' },
          { place: 'Split', placeEmoji: '🇭🇷', theme: 'neon-playground' },
          { place: 'Sea Day', placeEmoji: '🌊', theme: 'neon-playground' },
        ],
      }
    : HERO_EDITION === 'vacay'
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
    // Two clocks, deliberately. `display` is the pinned instant behind every
    // timestamp a viewer can READ, so captures are reproducible. `anchor` is
    // what unlock times hang off, and it is the EARLIER of the pinned clock and
    // the real one: Firestore rules gate the deal on `request.time` (the real
    // server clock, which a frozen page clock cannot touch), while the client
    // decides chip state from the frozen one — an unlock has to be in the past
    // for both. Same split the parity fixture uses.
    const display = heroClock();
    const anchor = Math.min(Date.now(), display);
    // Each unlock must sit on the calendar date its Day is LABELLED with; a
    // fixed offset from `anchor` does not guarantee that. A capture started
    // before 06:00 put `anchor - 6h` on yesterday while the Day still read
    // today, reintroducing exactly the date/state mismatch this fixture just
    // fixed in the other direction (Codex P2 on #1023). Clamping to the start
    // of the labelled day keeps the unlock in the past AND on its own date.
    const todayUnlock = Math.max(localHourOn(0, 0), Math.min(anchor - 6 * HOUR, anchor));
    const now = display;
    const mainIds = idsOf(heroDealable(ITEMS as SeedItem[]) as SeedItem[]);
    const easyIds = idsOf(heroDealable(EMBARK_ITEMS as SeedItem[]) as SeedItem[]);
    const closingIds = idsOf(heroDealable(CLOSING_ITEMS as SeedItem[]) as SeedItem[]);

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();

      // Every prompt doc the Event can deal. `embark` follows the Edition
      // (EMBARK_ITEMS); `main` and `farewell` stay Bodega because only Days 1
      // and 2 read them and those Days are locked for the whole capture — GCB's
      // own main pool is not imported into this file at all.
      for (const { items, pool } of [
        { items: ITEMS as SeedItem[], pool: 'main' },
        { items: EMBARK_ITEMS as SeedItem[], pool: 'embark' },
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
        name:
          HERO_EDITION === 'gcb'
            ? 'Trieste to Barcelona'
            : HERO_EDITION === 'vacay'
              ? 'Bodega Bay'
              : 'The weekend',
        startsOn: isoDay(0),
        endsOn: isoDay(2),
        sailStart: isoDay(0),
        sailEnd: isoDay(2),
        status: 'active',
        defaultTheme: DAY_CHROME.defaultTheme,
        claimMode: 'honor',
        settings: { reportHideThreshold: 4, spicyRatio: 0, easyMixRatio: EVENT_EASY_MIX_RATIO },
        timezone: EVENT_TIMEZONE,
        days: [
          {
            index: 0,
            date: isoDay(0),
            ...DAY_CHROME.days[0],
            port: DAY_CHROME.days[0].place,
            portEmoji: DAY_CHROME.days[0].placeEmoji,
            tonight: ['🍷 Arrival pours', '🌊 First look at the water'],
            pool: HERO_DAY_DEAL[0].pool,
            // The warm-up card: tutorial pool, tutorial tag, gentlest prompts.
            tutorial: true,
            scoring: 'competitive',
            unlockAt: todayUnlock,
            snapshotItemIds: easyIds,
            freeText: HERO_DAY_DEAL[0].freeText,
          },
          {
            index: 1,
            date: isoDay(1),
            ...DAY_CHROME.days[1],
            port: DAY_CHROME.days[1].place,
            portEmoji: DAY_CHROME.days[1].placeEmoji,
            tonight: ['🦀 Harbor dinner', '🌅 Sunset'],
            pool: HERO_DAY_DEAL[1].pool,
            tutorial: false,
            scoring: 'competitive',
            unlockAt: localHourOn(1, 8),
            snapshotItemIds: mainIds,
            freeText: HERO_DAY_DEAL[1].freeText,
          },
          {
            index: 2,
            date: isoDay(2),
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
            unlockAt: localHourOn(2, 8),
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
      // Every social entry is drawn from the ACTIVE Day's own dealable
      // snapshot. Sourcing them from the main pool while stamping
      // dayIndex 0 depicted players marking prompts nobody could have been
      // dealt that Day — a screenshot asserting something the product
      // cannot produce (Codex P2 on #1020).
      const activeDayItems = heroDealable(
        HERO_DAY_DEAL[HERO_TODAY_INDEX].items(),
      ) as SeedItem[];
      const sharedText = activeDayItems[0].text;
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
        itemText: activeDayItems[3].text,
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
        itemText: activeDayItems[6].text,
        type: 'text',
        text: FEED_PROOF_TEXT,
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

// --- sign-in ----------------------------------------------------------------
// The emulator widget, CDN stubs and uid readback are shared with the e2e
// layer (tests/support/emulator-signin.ts). Only the GATE differs: this one is
// edition-neutral, because Vacay and Five Across render neither the Gay Cruise
// Bingo wordmark nor — with an ungated Event — the 18+ checkbox.

/** Wait briefly for a locator; report whether it showed up. */
export async function isPresent(locator: Locator, timeout: number): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

/** Click a locator if it appears within `timeout`; otherwise do nothing. */
export async function clickIfPresent(locator: Locator, timeout: number): Promise<boolean> {
  if (!(await isPresent(locator, timeout))) return false;
  await locator.first().click();
  return true;
}

/**
 * Land on the app and sign in, without asserting any Edition's gate copy.
 *
 * The mechanics are the shared ones; only the two optional scrims differ from
 * `joinViaSharedLink`. Both are OPTIONAL here rather than asserted, which is
 * the whole reason this exists: Vacay renders no Gay Cruise Bingo wordmark,
 * and an ungated Event renders no 18+ checkbox at all.
 */
export async function joinHero(page: Page): Promise<void> {
  await stubAuthWidgetCdn(page); // popups inherit the context's routes
  await page.goto('/');

  // `locator.isVisible()` never waits, so each optional scrim is waited for
  // explicitly and treated as absent on timeout.
  await clickIfPresent(page.getByRole('button', { name: /got it/i }), 10_000);
  await dismissConsentNotice(page);

  // The 18+ acknowledgement renders only on an adult-content Event; this
  // fixture seeds an ungated hostname document, so check it only if present.
  const ack = page.getByRole('checkbox').first();
  if (await isPresent(ack, 3_000)) await ack.check();

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await completeEmulatorSignIn(await popupPromise);

  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 30_000 });
}

