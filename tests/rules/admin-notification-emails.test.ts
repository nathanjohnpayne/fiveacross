import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

// Covers specs/admin-notification-emails.md § "The queue is server-owned".
//
// `events/{eventId}/adminAlerts/{alertId}` is a SERVER-OWNED collection: the two
// moderation triggers append to it and the digest sweep drains it, both through
// the Admin SDK (which bypasses rules entirely), and no client may read or write
// it. Both directions matter and neither is incidental:
//
//   - NO WRITE, because the queue is what an admin's inbox is built from. A
//     client write path would let any signed-in Player mint arbitrary alerts —
//     flooding the digest with rows naming content that was never reported,
//     which is both a spam vector against the admins and a way to bury a real
//     report under noise.
//   - NO READ, because an alert carries the pre-moderation `label` (a Prompt's
//     own words) for content that may be `pending` or `hidden` — states whose
//     whole purpose is that non-admins cannot see them. A readable queue routes
//     around the item visibility rules via a second copy of the same text.
//
// A deny-all block reads like it could be deleted as redundant with Firestore's
// default deny. It cannot: this suite is what turns "we meant to deny it" into
// a failing test if a future edit widens it, deliberately or by a wildcard.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB] = ['admin-uid', 'alice', 'bob'];
const alert = (id: string) => `events/${EVENT}/adminAlerts/${id}`;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();

beforeAll(async () => {
  // Under `firebase emulators:exec` the host is exported here; fall back to the
  // firebase.json firestore port so a direct run still connects.
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // A suite-specific projectId: the emulator hosts each projectId as isolated
    // data, so two suites sharing one id race each other's clearFirestore().
    projectId: 'demo-gcb-admin-alerts',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const raw = ctx.firestore();
    // A real admin roster, so the "not even an admin" assertions below bite.
    await setDoc(doc(raw, `events/${EVENT}`), {
      name: 'Cruise',
      status: 'active',
      admins: [ADMIN],
      settings: { reportHideThreshold: 3 },
    });
    // A queued alert, as the moderation trigger would append it — carrying the
    // words of a Prompt nobody has approved.
    await setDoc(doc(raw, alert('a1')), {
      kind: 'item-created',
      collection: 'items',
      docId: 'i1',
      label: 'An unapproved Prompt nobody may read yet',
      status: 'pending',
      visionFlag: null,
      reportCount: 0,
      createdAt: 1,
      sentAt: null,
    });
  });
});

describe('events/{eventId}/adminAlerts/{alertId} is server-owned', () => {
  it('denies a Player the read — the label is unapproved content in a second wrapper', async () => {
    await assertFails(getDoc(doc(db(ALICE), alert('a1'))));
    await assertFails(getDoc(doc(db(BOB), alert('a1'))));
  });

  it('denies the EVENT ADMIN the read too — the console reads the items, not the queue', async () => {
    // The admin is not being locked out of their own moderation work: the
    // Review queue reads `items`/`proofs` directly. This collection exists only
    // to drive the digest, so nothing legitimate needs to read it client-side.
    await assertFails(getDoc(doc(db(ADMIN), alert('a1'))));
  });

  it('denies an unauthenticated read, and denies LISTING the collection', async () => {
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), alert('a1'))));
    // A `get` deny that leaves `list` open would hand over the whole queue in
    // one query, which is the same disclosure by another route.
    await assertFails(getDocs(collection(db(ALICE), `events/${EVENT}/adminAlerts`)));
    await assertFails(getDocs(collection(db(ADMIN), `events/${EVENT}/adminAlerts`)));
  });

  it('denies every client write path — create, update and delete, admin included', async () => {
    // The forgery this closes: minting alerts to flood an admin's inbox, or
    // stamping `sentAt` on a real one so the digest never reports it.
    await assertFails(setDoc(doc(db(ALICE), alert('forged')), { kind: 'moderation', collection: 'items' }));
    await assertFails(updateDoc(doc(db(ALICE), alert('a1')), { sentAt: 1 }));
    await assertFails(deleteDoc(doc(db(ALICE), alert('a1'))));
    await assertFails(setDoc(doc(db(BOB), alert('a1')), { kind: 'item-created', label: 'noise' }));
    await assertFails(setDoc(doc(db(ADMIN), alert('by-admin')), { kind: 'item-created' }));
    await assertFails(deleteDoc(doc(db(ADMIN), alert('a1'))));
    await assertFails(
      setDoc(doc(testEnv.unauthenticatedContext().firestore(), alert('anon')), { kind: 'moderation' }),
    );
  });

  it('leaves the rest of the Event schema reachable — the deny is scoped to this collection', async () => {
    // A guard against a future edit that denies more than it means to: the
    // sibling reads a signed-in Player depends on still work.
    await assertSucceeds(getDoc(doc(db(ALICE), `events/${EVENT}`)));
    await assertSucceeds(getDoc(doc(db(ALICE), `events/${EVENT}/players/${ALICE}`)));
  });
});
