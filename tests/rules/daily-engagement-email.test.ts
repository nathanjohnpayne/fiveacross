import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// Covers specs/daily-engagement-email.md § Consent, rules layer.
//
// `events/{eventId}/emailPrefs/{uid}` is a SERVER-OWNED collection: the daily
// sender and the unsubscribe endpoint write it through the Admin SDK (which
// bypasses rules entirely), and no client may read or write it. Both directions
// matter and neither is incidental:
//
//   - the doc holds an unguessable per-user capability `token`, and a readable
//     token would let any signed-in reader unsubscribe someone else;
//   - the doc IS the record of a consent decision, so a client write path would
//     let a Player forge another Player's suppression state.
//
// A deny-all block reads like it could be deleted as redundant with Firestore's
// default deny. It cannot: this suite is what turns "we meant to deny it" into
// a failing test if a future edit widens it, deliberately or by a wildcard.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB] = ['admin-uid', 'alice', 'bob'];
const prefs = (uid: string) => `events/${EVENT}/emailPrefs/${uid}`;

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
    projectId: 'demo-gcb-daily-email',
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
    // An admin roster, so the "not even an admin" assertions below are real.
    await setDoc(doc(raw, `events/${EVENT}`), {
      name: 'Cruise',
      status: 'active',
      admins: [ADMIN],
      settings: { reportHideThreshold: 3, dailyEmailEnabled: true },
    });
    // The server-written pref doc, as the sender would mint it.
    await setDoc(doc(raw, prefs(ALICE)), { optedOut: false, token: 'server-minted-token', updatedAt: 1 });
  });
});

describe('events/{eventId}/emailPrefs/{uid} is server-owned', () => {
  it('denies the OWNER a read — the capability token is not the Player’s to see', async () => {
    await assertFails(getDoc(doc(db(ALICE), prefs(ALICE))));
  });

  it('denies another Player and an Event admin the same read', async () => {
    await assertFails(getDoc(doc(db(BOB), prefs(ALICE))));
    await assertFails(getDoc(doc(db(ADMIN), prefs(ALICE))));
  });

  it('denies an unauthenticated read', async () => {
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), prefs(ALICE))));
  });

  it('denies every client write path — create, update and delete, owner included', async () => {
    await assertFails(setDoc(doc(db(ALICE), prefs(ALICE)), { optedOut: true, token: 'mine' }));
    await assertFails(updateDoc(doc(db(ALICE), prefs(ALICE)), { optedOut: true }));
    await assertFails(deleteDoc(doc(db(ALICE), prefs(ALICE))));
    // The forgery this closes: suppressing somebody else's mail, or stamping
    // their lastSentDayIndex so the sender skips them forever.
    await assertFails(setDoc(doc(db(BOB), prefs(ALICE)), { optedOut: true }));
    await assertFails(updateDoc(doc(db(BOB), prefs(ALICE)), { lastSentDayIndex: 9_999 }));
    await assertFails(setDoc(doc(db(ADMIN), prefs(ALICE)), { optedOut: true }));
    await assertFails(setDoc(doc(db(ALICE), prefs('brand-new')), { optedOut: false, token: 't' }));
  });

  it('leaves the rest of the Event schema reachable — the deny is scoped to this collection', async () => {
    // A guard against a future edit that denies more than it means to: the
    // sibling reads a signed-in Player depends on still work.
    await assertSucceeds(getDoc(doc(db(ALICE), `events/${EVENT}`)));
    await assertSucceeds(getDoc(doc(db(ALICE), `events/${EVENT}/players/${ALICE}`)));
  });
});

describe('the Event-level admin toggle', () => {
  it('is admin-writable through the existing settings gate, and denied to a Player', async () => {
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { settings: { reportHideThreshold: 3, dailyEmailEnabled: false } }),
    );
    await assertFails(
      updateDoc(doc(db(ALICE), `events/${EVENT}`), { settings: { reportHideThreshold: 3, dailyEmailEnabled: true } }),
    );
  });
});
