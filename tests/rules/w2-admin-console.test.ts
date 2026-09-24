import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore';

// specs/w2-admin-console.md — the moderation rules surface the Admin console and
// the ADR 0004 Phase 0 auto-hide rely on. This ticket adds NO rules (the ban
// write it once assumed has no surface in firestore.rules — no `banned` field, no
// `bannedUids`, and users/{uid} is owner-only), so this suite PINS what the rules
// already enforce, per the #103 pattern that rules changes land in their own
// reviewed PR:
//   1. A report is increment-only for non-admins — reportCount may go up by
//      exactly 1 and nothing else; a jump, a decrement, a bundled field change,
//      or a status flip is denied. This is the counter the presentational
//      threshold hide reads (the hide itself is client-side; the rules only
//      guarantee the counter is honest-ish under the honor system, ADR 0001).
//   2. An Admin moderates — hard-hide (status) of an active row, restore of a
//      hidden one, delete, and a reportCount reset that would lift an auto-hide.
//      On a Prompt those are the only admin status moves besides
//      pending -> rejected since #1275 (approval is the approvePrompts callable;
//      tests/rules/d15-approvals.test.ts pins the denials). The console ships
//      status hide/restore/delete; #43 owns the server-authoritative hide.
//   3. reportHideThreshold is admin-only, numeric config.
//   4. Ban surface (#113): the ban now lives on the admin-writable EVENT doc as
//      `bannedUids` (presentational event-scoped hide/mute, ADR 0004 Phase 0) —
//      an Admin can set it, and users/{uid} stays owner-only (no admin write path
//      was opened there — the anti-schema-smuggling guarantee). The full ban
//      allow/deny matrix (list/cap/admins-overlap validation, non-admin denial,
//      arrayUnion-shaped updates) lives in tests/rules/w2-banned-uids.test.ts.
// The PERMISSION_DENIED lines the SDK logs are the expected assertFails denials.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB] = ['admin-uid', 'alice', 'bob'];
const THRESHOLD = 4;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;
const eventDoc = (ctxDb: ReturnType<typeof db>) => doc(ctxDb, 'events', EVENT);

const itemDoc = (over: Record<string, unknown> = {}) => ({
  text: 'Wore Crocs to dinner',
  createdBy: ALICE,
  createdAt: Date.now(),
  isFreeSpace: false,
  status: 'active',
  reportCount: 0,
  ...over,
});
const proofDoc = (over: Record<string, unknown> = {}) => ({
  uid: ALICE,
  displayName: 'Alice',
  photoURL: null,
  type: 'text',
  cellIndex: 0,
  itemText: 'a prompt',
  storagePath: null,
  mediaURL: null,
  thumbURL: null,
  text: 'x',
  createdAt: Date.now(),
  reportCount: 0,
  status: 'active',
  visionFlag: null,
  ...over,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gaycruisebingo-w2-admin-console',
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
      settings: { reportHideThreshold: THRESHOLD },
    });
    await setDoc(doc(s, at('items/i1')), itemDoc()); // unreported
    await setDoc(doc(s, at('items/i-hot')), itemDoc({ reportCount: THRESHOLD })); // at the threshold
    await setDoc(doc(s, at('proofs/p1')), proofDoc()); // unreported
    await setDoc(doc(s, at('proofs/p-hot')), proofDoc({ reportCount: THRESHOLD }));
    await setDoc(doc(s, 'users', BOB), { displayName: 'Bob', photoURL: null, createdAt: Date.now() });
  });
});

describe('firestore.rules — moderation surface (specs/w2-admin-console.md)', () => {
  it('a non-admin report increments reportCount by exactly 1 — Prompt and Proof', async () => {
    await assertSucceeds(updateDoc(doc(db(BOB), at('items/i1')), { reportCount: 1 }));
    await assertSucceeds(updateDoc(doc(db(BOB), at('proofs/p1')), { reportCount: 1 }));
  });

  it('a non-admin cannot jump the counter, decrement it, bundle other fields, or moderate', async () => {
    await assertFails(updateDoc(doc(db(BOB), at('items/i1')), { reportCount: 2 })); // not +1
    await assertFails(updateDoc(doc(db(BOB), at('items/i1')), { reportCount: 0 })); // decrement
    await assertFails(updateDoc(doc(db(BOB), at('items/i1')), { reportCount: 1, text: 'x' })); // hasOnly violated
    await assertFails(updateDoc(doc(db(BOB), at('items/i1')), { status: 'hidden' })); // moderation
    await assertFails(updateDoc(doc(db(BOB), at('proofs/p1')), { reportCount: 2 }));
    await assertFails(updateDoc(doc(db(BOB), at('proofs/p1')), { status: 'hidden' }));
  });

  it('an Admin moderates: hard-hide, restore, clear reports (lifting an auto-hide), and delete', async () => {
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('items/i1')), { status: 'hidden' })); // hard-hide
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('items/i1')), { status: 'active' })); // restore
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('proofs/p1')), { status: 'hidden' }));
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('proofs/p1')), { status: 'active' }));
    // An admin reportCount write is unconstrained: resetting it below the threshold
    // lifts the Phase-0 community auto-hide. This is the rules allowance the shipped
    // Clear reports control relies on (data/admin.ts clearItemReports/clearProofReports,
    // Codex P2 PR #107 finding 3); #43 owns the server-authoritative hide.
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('items/i-hot')), { reportCount: 0 }));
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('proofs/p-hot')), { reportCount: 0 }));
    await assertSucceeds(deleteDoc(doc(db(ADMIN), at('items/i1'))));
    await assertSucceeds(deleteDoc(doc(db(ADMIN), at('proofs/p-hot'))));
  });

  it('reportHideThreshold is admin-only, numeric config (ADR 0004)', async () => {
    await assertSucceeds(updateDoc(eventDoc(db(ADMIN)), { settings: { reportHideThreshold: 6 } }));
    await assertFails(updateDoc(eventDoc(db(BOB)), { settings: { reportHideThreshold: 6 } })); // non-admin
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { settings: { reportHideThreshold: 'high' } })); // non-numeric
  });

  it('ban surface is the EVENT doc (bannedUids), and users/{uid} stays owner-only (#113)', async () => {
    // The ban now lives on the admin-writable event doc as `bannedUids` — a
    // presentational event-scoped hide/mute roster (ADR 0004 Phase 0), NOT hard
    // access revocation. An Admin can set it (full matrix in
    // tests/rules/w2-banned-uids.test.ts).
    await assertSucceeds(updateDoc(eventDoc(db(ADMIN)), { bannedUids: [BOB] }));
    // users/{uid} is STILL owner-only: opening the ban surface on the event doc
    // did NOT open any admin write path into a foreign user profile — the
    // anti-schema-smuggling guarantee. An Admin still cannot flag `banned` on
    // another Player's users/{uid} doc, by create or update.
    await assertFails(
      setDoc(doc(db(ADMIN), 'users', BOB), { displayName: 'Bob', photoURL: null, createdAt: Date.now(), banned: true }),
    );
    await assertFails(updateDoc(doc(db(ADMIN), 'users', BOB), { banned: true }));
  });
});
