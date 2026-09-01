import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';

// specs/w2-tally.md — the per-Prompt Tally rules contract (ADR 0002). The Tally
// is a subcollection whose marker doc id IS the marker's uid, so a Player may
// self-publish/remove ONLY their own attributed entry and a forged attribution
// is denied; reads are public (no anonymity). The aggregate tally/{itemId} doc
// is admin/Cloud-Function-maintained, never client-forged. These invariants ship
// in firestore.rules from #18; this suite pins the #31 Tally-write half of them.
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
// The attributed marker shape setMark writes, including its Event delivery key.
const marker = (uid: string, over: Record<string, unknown> = {}) => ({
  eventId: EVENT,
  uid,
  displayName: uid,
  markedAt: NOW(),
  ...over,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gaycruisebingo-w2-tally',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// Each test starts clean with a canonical Event, a Prompt, and a foreign marker
// (Carol's) so the public-read + own-only-write invariants have something to
// read against.
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
      text: 'Saw a drag show', createdBy: ALICE, createdAt: NOW(), isFreeSpace: false,
      status: 'active', reportCount: 0,
    });
    await setDoc(doc(s, markerPath(ITEM, CAROL)), marker(CAROL));
  });
});

describe('firestore.rules — per-Prompt Tally (specs/w2-tally.md)', () => {
  it('a signed-in Player self-publishes their OWN attributed marker, then unmarks it', async () => {
    const mine = doc(db(ALICE), markerPath(ITEM, ALICE));
    await assertSucceeds(setDoc(mine, marker(ALICE))); // every Mark publishes an attributed entry
    await assertSucceeds(deleteDoc(mine)); // unmarking removes exactly that Player's entry
  });

  it('denies a forged attribution — another Player’s slot or a forged uid in one’s own', async () => {
    await assertFails(setDoc(doc(db(ALICE), markerPath(ITEM, BOB)), marker(ALICE))); // another's slot
    await assertFails(setDoc(doc(db(ALICE), markerPath(ITEM, ALICE)), marker(BOB))); // forged uid in own slot
  });

  it('enforces the marker shape — non-empty ≤100 displayName and numeric markedAt', async () => {
    const mine = markerPath(ITEM, ALICE);
    await assertFails(setDoc(doc(db(ALICE), mine), marker(ALICE, { displayName: '' }))); // empty name
    await assertFails(setDoc(doc(db(ALICE), mine), marker(ALICE, { displayName: 'x'.repeat(101) }))); // over cap
    await assertFails(setDoc(doc(db(ALICE), mine), marker(ALICE, { markedAt: 'now' }))); // non-numeric stamp
    await assertSucceeds(setDoc(doc(db(ALICE), mine), marker(ALICE, { displayName: 'x'.repeat(100) }))); // exactly the cap
  });

  it('marker reads are public — no anonymity (ADR 0002)', async () => {
    await assertSucceeds(getDoc(doc(db(BOB), markerPath(ITEM, CAROL)))); // Bob reads who else got it
  });

  it('an admin may delete another Player’s marker; a non-admin peer may not', async () => {
    // The rejectClaim resolve (src/data/admin.ts) depends on this allowance: an
    // admin rejecting a pending claim deletes the claimant's marker in the same
    // transaction (the marked→unmarked ↔ marker-delete symmetry). Peers cannot.
    await assertFails(deleteDoc(doc(db(BOB), markerPath(ITEM, CAROL)))); // a peer cannot moderate
    await assertSucceeds(deleteDoc(doc(db(ADMIN), markerPath(ITEM, CAROL)))); // the admin resolve can
  });

  it('the aggregate tally/{itemId} doc is admin-maintained, never client-forged', async () => {
    const agg = { itemId: ITEM, count: 1, markers: [] };
    await assertFails(setDoc(doc(db(ALICE), at(`tally/${ITEM}`)), agg)); // a Player cannot forge the count
    await assertSucceeds(setDoc(doc(db(ADMIN), at(`tally/${ITEM}`)), agg)); // admin/CF may
  });
});
