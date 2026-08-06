// Fixture layer for the mockup-parity suite (specs/d15-mockup-parity.md):
// a five-Day schedule pinned to ABSOLUTE times around `PARITY_NOW` (the suite
// freezes the browser clock there via `page.clock.install`, so every
// time-derived string — header day identity, chip weekdays, "bumped 2h ago",
// proof clock labels, the locked unlock date — is identical on every run),
// plus the SOCIAL surfaces the wireframes paint: two distinct seeded Players,
// a shared per-Prompt Tally (the "Nathan Payne, Sterling Tadlock got …"
// line), a pinned day-meta honor, and one Feed proof of each type with REAL
// media bytes in the Storage emulator (the photo must actually load — an
// empty media area under the 🖼️ badge is the exact prod symptom the parity
// catalog logged).
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { seedEmulatorEvent } from './seed';
import { EVENT_ID } from './env';
// @ts-expect-error — plain-JS seed script, no type declarations (see support/seed.ts).
import { seedItemDocId } from '../../../scripts/seed.mjs';
import { ITEMS, EASY_ITEMS, CLOSING_ITEMS } from '../../../scripts/seed-data/med-2026.mjs';

const HOUR = 3_600_000;

/** The frozen "now" every parity run shares: Fri 2026-07-17, 14:00 CEST —
 * mid-cruise on the seeded schedule below (Day 3 unlocked six hours ago). */
export const PARITY_NOW = Date.parse('2026-07-17T14:00:00+02:00');

/** 08:00 CEST on a seeded date — the spec's unlock rule, absolute. */
const unlockAt = (isoDate: string) => Date.parse(`${isoDate}T08:00:00+02:00`);

/** Two distinct seeded identities — the tally-dedupe assertion's ground truth:
 * a Tally Card must read BOTH names, never one of them twice. */
export const PLAYER_A = { uid: 'fixture-nathan', displayName: 'Nathan Payne' };
export const PLAYER_B = { uid: 'fixture-sterling', displayName: 'Sterling Tadlock' };

/** The shared-Tally Prompt (both fixture Players marked it on today's Day). */
export const SHARED_ITEM_TEXT: string = (ITEMS as Array<{ text: string }>)[0].text;
/** The photo-proof Prompt. */
export const PHOTO_ITEM_TEXT: string = (ITEMS as Array<{ text: string }>)[1].text;

/** The frozen schedule's viewed-day indices. */
export const PARITY_TODAY_INDEX = 2;
/** The plain locked MAIN day (glamiators) the locked-preview walk views. */
export const PARITY_LOCKED_INDEX = 3;
/** The locked farewell (tutorial) day — wears the Goodbye chip tag. */
export const PARITY_FAREWELL_INDEX = 4;

// A tiny valid JPEG (1×1 px) — enough for <img> to decode and report a natural
// size, which is the "the photo actually rendered" assertion's signal.
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);
// A minimal WebM header — a real (if undecodable) object so the audio proof's
// URL resolves 200 and the player chrome renders; duration simply stays blank.
const WEBM_STUB = Buffer.from('GkXfo0AgQoaBAUL3gQFC8oEEQvOBCEKChHdlYm1Ch4EEQoWBAhhTgGcBAAAAAAAB', 'base64');

type SeedItem = { text: string; spicy?: boolean };
const idsOf = (items: SeedItem[]): string[] => items.map((it) => seedItemDocId(it.text));

export interface ParityFixture {
  testEnv: RulesTestEnvironment;
  /** Download URL of the seeded photo proof (Storage-emulator hosted). */
  photoProofURL: string;
}

/**
 * Seed the parity fixture: main + tutorial pools, the frozen five-Day
 * schedule, the two fixture Players, tally markers, the day-meta honor, and
 * the three Feed proofs (photo bytes + audio bytes live in the Storage
 * emulator). Every timestamp is PARITY_NOW-relative and absolute.
 */
export async function seedParityFixture(): Promise<ParityFixture> {
  const testEnv = await seedEmulatorEvent({ withStorage: true });
  const now = PARITY_NOW;

  const mainIds = idsOf(ITEMS as SeedItem[]);
  const embarkIds = idsOf(EASY_ITEMS as SeedItem[]);
  const farewellIds = idsOf(CLOSING_ITEMS as SeedItem[]);
  const sharedItemId = seedItemDocId(SHARED_ITEM_TEXT);

  // Storage bytes first (owner-scoped create per storage.rules), so the proof
  // docs written below carry live download URLs.
  const ownerStorage = testEnv.authenticatedContext(PLAYER_A.uid).storage();
  const photoPath = `proofs/${EVENT_ID}/${PLAYER_A.uid}/parity-photo-1.jpg`;
  await uploadBytes(storageRef(ownerStorage, photoPath), JPEG_1PX, { contentType: 'image/jpeg' });
  const photoProofURL = await getDownloadURL(storageRef(ownerStorage, photoPath));

  const bStorage = testEnv.authenticatedContext(PLAYER_B.uid).storage();
  const audioPath = `proofs/${EVENT_ID}/${PLAYER_B.uid}/parity-audio-1.webm`;
  await uploadBytes(storageRef(bStorage, audioPath), WEBM_STUB, { contentType: 'audio/webm' });
  const audioProofURL = await getDownloadURL(storageRef(bStorage, audioPath));

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    // The two curated tutorial pools as real item docs (deal-from-snapshot
    // resolves each id to its doc) — mirrors support/daily.ts.
    for (const { items, pool } of [
      { items: EASY_ITEMS as SeedItem[], pool: 'embark' },
      { items: CLOSING_ITEMS as SeedItem[], pool: 'farewell' },
    ]) {
      for (const it of items) {
        await setDoc(doc(db, 'events', EVENT_ID, 'items', seedItemDocId(it.text)), {
          text: it.text, createdBy: 'seed', createdAt: now - 200 * HOUR, isFreeSpace: false,
          status: 'active', reportCount: 0, spicy: it.spicy === true, pool,
        });
      }
    }

    // The frozen schedule: Days 1–3 unlocked (Day 3 = today), 4–5 locked.
    // Dates bracket PARITY_NOW so the date-driven header and the unlock-driven
    // chips agree — the wireframes' mid-cruise frame.
    //
    // UNLOCKED days carry REAL-past `unlockAt`s (`firestore.rules` gates the
    // deal on request.time — the SERVER clock, which `page.clock.install`
    // cannot freeze); no player-visible string renders them, so determinism is
    // unaffected. LOCKED days carry ABSOLUTE 08:00-CEST stamps — their
    // "Unlocks 8:00 a.m. · …" copy must render identically on every run, and
    // the frozen PAGE clock (not the server) decides their locked state, so
    // they stay locked previews even when the real date passes them.
    // Anchor the unlocked stamps at whichever clock is EARLIER (Codex P2 on
    // #316 round 2): they must be ≤ the real server clock (the rules gate) AND
    // ≤ the frozen page clock (chip/deal state) — `realNow - 6h` alone drifts
    // ABOVE PARITY_NOW once real time passes the frozen window, reclassifying
    // "today" as locked and rotting the suite after 2026-07-17.
    const unlockAnchor = Math.min(Date.now(), PARITY_NOW);
    await updateDoc(doc(db, 'events', EVENT_ID), {
      days: [
        { index: 0, date: '2026-07-15', port: 'Trieste', portEmoji: '🇮🇹', theme: 'welcome-aboard', pool: 'embark', tutorial: true, unlockAt: unlockAnchor - 50 * HOUR, snapshotItemIds: embarkIds, freeText: 'You made it aboard' },
        { index: 1, date: '2026-07-16', port: 'Split', portEmoji: '🇭🇷', theme: 'get-sporty', pool: 'main', tutorial: false, unlockAt: unlockAnchor - 26 * HOUR, snapshotItemIds: mainIds },
        { index: 2, date: '2026-07-17', port: 'Valletta', portEmoji: '🇲🇹', theme: 'duty-free', pool: 'main', tutorial: false, unlockAt: unlockAnchor - 6 * HOUR, snapshotItemIds: mainIds },
        { index: 3, date: '2026-07-18', port: 'Palermo', portEmoji: '🇮🇹', theme: 'glamiators', pool: 'main', tutorial: false, unlockAt: unlockAt('2026-07-18') },
        { index: 4, date: '2026-07-24', port: 'Barcelona', portEmoji: '🇪🇸', theme: 'so-long-farewell', pool: 'farewell', tutorial: true, unlockAt: unlockAt('2026-07-24'), freeText: 'We had the best damn time' },
      ],
    });

    // Two seeded Players with cruise totals + a Day-3 bucket, so Ranks has
    // rows, totals, and an honors strip to assert against.
    for (const [p, squares, bingos] of [
      [PLAYER_A, 7, 1],
      [PLAYER_B, 5, 0],
    ] as const) {
      await setDoc(doc(db, 'events', EVENT_ID, 'players', p.uid), {
        uid: p.uid,
        displayName: p.displayName,
        photoURL: null,
        joinedAt: now - 50 * HOUR,
        squaresMarked: squares,
        bingoCount: bingos,
        firstBingoAt: bingos > 0 ? now - 4 * HOUR : null,
        dayStats: { [PARITY_TODAY_INDEX]: { bingoCount: bingos, squaresMarked: squares, firstBingoAt: bingos > 0 ? now - 4 * HOUR : null } },
      });
    }

    // The pinned per-Day honor (#264) behind the Ranks honors strip. The doc
    // id IS the dayIndex (src/data/paths.ts dayMetaRef) — a `meta/meta` id
    // would never be read and Ranks would silently fall back to the
    // roster-derived honor (Codex P2 on #316).
    await setDoc(doc(db, 'events', EVENT_ID, 'days', String(PARITY_TODAY_INDEX), 'meta', String(PARITY_TODAY_INDEX)), {
      firstBingo: { uid: PLAYER_A.uid, displayName: PLAYER_A.displayName, at: now - 4 * HOUR },
    });

    // The shared Tally: BOTH Players marked the same Prompt on today's Day —
    // the Feed folds these into ONE card reading both names.
    await setDoc(doc(db, 'events', EVENT_ID, 'tally', sharedItemId, 'markers', PLAYER_A.uid), {
      uid: PLAYER_A.uid, displayName: PLAYER_A.displayName, markedAt: now - 2 * HOUR, dayIndex: PARITY_TODAY_INDEX, itemText: SHARED_ITEM_TEXT,
    });
    await setDoc(doc(db, 'events', EVENT_ID, 'tally', sharedItemId, 'markers', PLAYER_B.uid), {
      uid: PLAYER_B.uid, displayName: PLAYER_B.displayName, markedAt: now - 1 * HOUR, dayIndex: PARITY_TODAY_INDEX, itemText: SHARED_ITEM_TEXT,
    });

    // One Feed proof of each type (photo/audio/text), all on today's Day. The
    // photo is a LIBRARY pick so the 🖼️ source badge renders over real media.
    await setDoc(doc(db, 'events', EVENT_ID, 'proofs', 'parity-photo-1'), {
      uid: PLAYER_A.uid, displayName: PLAYER_A.displayName, photoURL: null,
      itemText: PHOTO_ITEM_TEXT, type: 'photo', mediaURL: photoProofURL, storagePath: photoPath,
      createdAt: now - 90 * 60_000, status: 'active', reportCount: 0, dayIndex: PARITY_TODAY_INDEX, source: 'library',
    });
    await setDoc(doc(db, 'events', EVENT_ID, 'proofs', 'parity-audio-1'), {
      uid: PLAYER_B.uid, displayName: PLAYER_B.displayName, photoURL: null,
      itemText: (ITEMS as SeedItem[])[2].text, type: 'audio', mediaURL: audioProofURL, storagePath: audioPath,
      createdAt: now - 60 * 60_000, status: 'active', reportCount: 0, dayIndex: PARITY_TODAY_INDEX, source: 'camera',
    });
    await setDoc(doc(db, 'events', EVENT_ID, 'proofs', 'parity-text-1'), {
      uid: PLAYER_B.uid, displayName: PLAYER_B.displayName, photoURL: null,
      itemText: (ITEMS as SeedItem[])[3].text, type: 'text', text: 'Customs in Valletta would like a word.',
      createdAt: now - 30 * 60_000, status: 'active', reportCount: 0, dayIndex: PARITY_TODAY_INDEX,
    });

    // A Moment so the Feed shows the celebratory (no-media) card too. The id
    // must be canonical (`${uid}-bingo`) or hasCanonicalMomentId drops it.
    await setDoc(doc(db, 'events', EVENT_ID, 'moments', `${PLAYER_A.uid}-bingo`), {
      kind: 'bingo', uid: PLAYER_A.uid, displayName: PLAYER_A.displayName, photoURL: null,
      createdAt: now - 4 * HOUR, dayIndex: PARITY_TODAY_INDEX,
    });
  });

  return { testEnv, photoProofURL };
}

/** Make the signed-in browser user an Event admin (rules-disabled write) so the
 * Admin console walk can assert the Proof & Claims defaults. */
export async function grantAdmin(testEnv: RulesTestEnvironment, uid: string): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'events', EVENT_ID), { admins: [uid] });
  });
}
