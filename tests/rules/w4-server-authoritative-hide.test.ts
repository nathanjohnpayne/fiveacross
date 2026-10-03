import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, increment, query, setDoc, updateDoc, where } from 'firebase/firestore';

// specs/w4-server-authoritative-hide.md — the Phase-1 server-authoritative hide
// (#43, ADR 0004). This suite pins the firestore.rules half of the change: for
// the community-report path, `status` is SERVER/admin-authoritative — a non-admin
// client can NEVER set `status: 'hidden'` (nor un-hide), the auto-hide is written
// only by the Cloud Function via the admin SDK (which bypasses rules), and the
// existing legitimate writes are untouched:
//   1. A non-admin's report is a pure reportCount+1 — setting `status` (alone or
//      alongside the bump) is DENIED by `hasOnly(['reportCount'])`.
//   2. A bare reportCount+1 is DENIED without the paired receipt/rate (#1405).
//   3. An admin manual hide/restore still SUCCEEDS (the `isAdmin` branch).
//   4. Proof creation (status active/pending) still SUCCEEDS.
//   5. F4 — item READS are gated: a non-admin reads only active Prompts (mirroring
//      proofs), so a hidden Prompt is not directly fetchable and the player-facing
//      collection query must filter status=='active' to be allowed.
// The PERMISSION_DENIED lines the SDK logs are the expected assertFails denials.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB] = ['admin-uid', 'alice', 'bob'];
const NOW = () => Date.now();

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;

// A fully-valid `photo` Proof pinned to its OWN doc id (proofs/{event}/{uid}/{id}.jpg).
const photoProof = (id: string, over: Record<string, unknown> = {}) => ({
  uid: ALICE, displayName: 'Alice', photoURL: null, type: 'photo', cellIndex: 5,
  itemText: 'Saw a drag show', storagePath: `proofs/${EVENT}/${ALICE}/${id}.jpg`,
  mediaURL: `https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/proofs%2F${EVENT}%2F${ALICE}%2F${id}.jpg?alt=media&token=t`,
  thumbURL: null, text: null, createdAt: NOW(), reportCount: 0, status: 'active', visionFlag: null, ...over,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gaycruisebingo-w4-hide',
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
      settings: { reportHideThreshold: 4 },
    });
    await setDoc(doc(s, at('items/item1')), {
      text: 'Saw a drag show', createdBy: ALICE, createdAt: NOW(), isFreeSpace: false,
      status: 'active', reportCount: 3,
    });
    // A server-hidden Prompt (the auto-hide outcome) to prove F4 read-gating.
    await setDoc(doc(s, at('items/itemHidden')), {
      text: 'Hidden prompt', createdBy: ALICE, createdAt: NOW(), isFreeSpace: false,
      status: 'hidden', reportCount: 5,
    });
    // A live proof, and an already-hidden proof (to prove a non-admin can't un-hide).
    await setDoc(doc(s, at('proofs/p1')), photoProof('p1', { reportCount: 3 }));
    await setDoc(doc(s, at('proofs/phidden')), photoProof('phidden', { reportCount: 5, status: 'hidden' }));
  });
});

describe('firestore.rules — status is server-authoritative for the community hide (specs/w4-server-authoritative-hide.md)', () => {
  it('a non-admin CANNOT set status:hidden on an ITEM — alone or alongside a report bump', async () => {
    const item = doc(db(BOB), at('items/item1'));
    await assertFails(updateDoc(item, { status: 'hidden' })); // status-only write
    await assertFails(updateDoc(item, { reportCount: increment(1), status: 'hidden' })); // smuggled onto the report path
  });

  it('a non-admin CANNOT set status:hidden on a PROOF, nor un-hide one', async () => {
    await assertFails(updateDoc(doc(db(BOB), at('proofs/p1')), { status: 'hidden' }));
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/p1')), { status: 'hidden' })); // not even the owner
    await assertFails(updateDoc(doc(db(BOB), at('proofs/p1')), { reportCount: increment(1), status: 'hidden' }));
    await assertFails(updateDoc(doc(db(BOB), at('proofs/phidden')), { status: 'active' })); // cannot un-hide
  });

  it('denies bare reportCount+1 without the paired receipt/rate (#1405)', async () => {
    await assertFails(updateDoc(doc(db(BOB), at('items/item1')), { reportCount: increment(1) }));
    await assertFails(updateDoc(doc(db(BOB), at('proofs/p1')), { reportCount: increment(1) }));
  });

  it('an admin manual hide AND restore still SUCCEED (the isAdmin branch)', async () => {
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('items/item1')), { status: 'hidden' }));
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('items/item1')), { status: 'active' })); // restore
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('proofs/p1')), { status: 'hidden' }));
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('proofs/phidden')), { status: 'active' })); // restore
  });

  it('proof creation still SUCCEEDS (active), and creating straight into hidden is DENIED', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), at('proofs/pnew')), photoProof('pnew'))); // active create
    await assertFails(setDoc(doc(db(ALICE), at('proofs/pbad')), photoProof('pbad', { status: 'hidden' }))); // no client-set hidden at create
  });
});

describe('firestore.rules — F4: item (Prompt) reads are server-gated to active for non-admins', () => {
  const itemsCol = (uid: string) => collection(db(uid), at('items'));

  it('a non-admin reads an ACTIVE Prompt but NOT a hidden one (single-doc gets)', async () => {
    await assertSucceeds(getDoc(doc(db(BOB), at('items/item1')))); // active — visible
    await assertFails(getDoc(doc(db(BOB), at('items/itemHidden')))); // hidden — moderation-only
  });

  it('a non-admin collection query MUST filter status==active — unconstrained is DENIED, filtered is ALLOWED', async () => {
    // Firestore rejects a collection query unless it is constrained to only match
    // readable docs, so the player-facing pool query (useItems / joinAndDeal) filters
    // status==active. An unconstrained read could surface the hidden Prompt, so it is
    // denied outright.
    await assertFails(getDocs(itemsCol(BOB))); // unconstrained — denied
    await assertSucceeds(getDocs(query(itemsCol(BOB), where('status', '==', 'active')))); // active-filtered — allowed
  });

  it('an admin reads everything — the hidden Prompt and the whole collection (moderation console)', async () => {
    await assertSucceeds(getDoc(doc(db(ADMIN), at('items/itemHidden')))); // admin sees hidden
    await assertSucceeds(getDocs(itemsCol(ADMIN))); // useAllItems: unconstrained admin read of all statuses
  });
});
