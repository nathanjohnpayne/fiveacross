import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from 'firebase/firestore';

// specs/d15-tally-cards.md — day-scoped Tally Cards (#216). A Mark stamps the
// viewed `dayIndex` and the Prompt `itemText` as ADDITIVE fields on the same
// `tally/{itemId}/markers/{uid}` doc (the marker create rule validates
// uid/displayName/markedAt but not the full key set), so the Feed groups markers
// into per-(itemId, dayIndex) cards while the Square badge (`useTally`) and the
// Doubt `exists()` gate keep reading the unchanged path. This suite pins that the
// day-scoped marker is still self-writable + attributed + publicly readable, and
// that the forged-attribution and shape denials still hold with the extra fields.
// The Feed's stream additionally needs the `{path=**}/markers` collection-group
// LIST rule (#294/#1072): a CG query never matches the nested path rule, so the
// query must prove its captured Event identity with an `eventId` equality.
// The PERMISSION_DENIED lines the SDK logs are the expected assertFails denials.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const ITEM = 'item1';
const [ADMIN, ALICE, BOB, CAROL] = ['admin-uid', 'alice', 'bob', 'carol'];
const NOW = () => Date.now();

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;
const markerPath = (itemId: string, uid: string) => at(`tally/${itemId}/markers/${uid}`);
// The day-scoped marker shape setMark writes (#216): the per-Prompt entry PLUS
// the additive dayIndex + itemText the Feed groups/labels on.
const marker = (uid: string, over: Record<string, unknown> = {}) => ({
  eventId: EVENT,
  uid,
  displayName: uid,
  markedAt: NOW(),
  dayIndex: 2,
  itemText: 'Balcony or porthole photo',
  ...over,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gaycruisebingo-d15-tally-cards',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.firestore();
    await setDoc(doc(s, `events/${EVENT}`), {
      name: 'Cruise', sailStart: '2026-01-01', sailEnd: '2026-01-07', status: 'active',
      defaultTheme: 'neon-playground', claimMode: 'honor', admins: [ADMIN],
      settings: { reportHideThreshold: 3 },
    });
    await setDoc(doc(s, at(`items/${ITEM}`)), {
      text: 'Balcony or porthole photo', createdBy: ALICE, createdAt: NOW(), isFreeSpace: false,
      status: 'active', reportCount: 0,
    });
    await setDoc(doc(s, markerPath(ITEM, CAROL)), marker(CAROL));
  });
});

describe('firestore.rules — day-scoped Tally Card markers (specs/d15-tally-cards.md)', () => {
  it('a Player self-publishes their OWN day-scoped marker (dayIndex + itemText), then unmarks it', async () => {
    const mine = doc(db(ALICE), markerPath(ITEM, ALICE));
    await assertSucceeds(setDoc(mine, marker(ALICE))); // additive fields are accepted
    await assertSucceeds(deleteDoc(mine)); // unmark drops exactly that entry → the card can empty out
  });

  it('still denies a forged attribution even with the extra day-scoped fields', async () => {
    await assertFails(setDoc(doc(db(ALICE), markerPath(ITEM, BOB)), marker(ALICE))); // another Player's slot
    await assertFails(setDoc(doc(db(ALICE), markerPath(ITEM, ALICE)), marker(BOB))); // forged uid in own slot
  });

  it('still enforces the core marker shape — a bad displayName/markedAt is denied regardless of dayIndex', async () => {
    const mine = markerPath(ITEM, ALICE);
    await assertFails(setDoc(doc(db(ALICE), mine), marker(ALICE, { displayName: '' })));
    await assertFails(setDoc(doc(db(ALICE), mine), marker(ALICE, { markedAt: 'now' })));
  });

  it('day-scoped markers are publicly readable — the Feed builds Tally Cards for everyone (no anonymity)', async () => {
    await assertSucceeds(getDoc(doc(db(BOB), markerPath(ITEM, CAROL))));
  });

  it('the Event-scoped collectionGroup(markers) subscription reads for any signed-in Player (#294/#1072)', async () => {
    // Firestore evaluates a collection-group query ONLY against a {path=**}
    // rule; without one the Feed's useTallyCards listen is permission-denied
    // and other Players' bare Marks never surface as Tally Cards.
    await assertSucceeds(
      getDocs(query(collectionGroup(db(BOB), 'markers'), where('eventId', '==', EVENT))),
    );
  });

  it('a signed-out reader gets NO collection-group markers access', async () => {
    await assertFails(
      getDocs(query(
        collectionGroup(testEnv.unauthenticatedContext().firestore(), 'markers'),
        where('eventId', '==', EVENT),
      )),
    );
  });

  it('the collection-group rule grants READ only — writes stay path-scoped and owner-bound', async () => {
    // A cross-event forged write must still be denied: the CG rule has no
    // create/update/delete arm, and the path rule binds the doc id to the uid.
    await assertFails(setDoc(doc(db(ALICE), markerPath(ITEM, BOB)), marker(BOB)));
  });
});
