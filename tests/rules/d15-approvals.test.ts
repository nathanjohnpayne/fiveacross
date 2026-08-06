import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// specs/d15-approvals.md — the WRITE side of the approval flow's firestore.rules
// contract. `d15-firestore-rules` (#201) already pinned the pending/rejected
// item READ carve-out (tests/rules/d15-firestore-rules.test.ts); this file pins
// what #201 deliberately left out of its own scope (a rules-only ticket that
// proves shape over hand-built payloads, not the client write paths): the
// CREATE side actually letting a non-admin land a `pending` row, and the
// ADMIN-ONLY `update` gate on the pending → active/rejected transition.
//
// The PERMISSION_DENIED lines the SDK logs to stderr are the expected assertFails
// denials, not test failures.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB] = ['admin-uid', 'alice', 'bob'];
const NOW = () => Date.now();

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const unauthDb = () => testEnv.unauthenticatedContext().firestore();
const at = (p: string) => `events/${EVENT}/${p}`;

const pendingPayload = (createdBy: string, over: Record<string, unknown> = {}) => ({
  text: 'A new prompt',
  createdBy,
  createdAt: NOW(),
  status: 'pending',
  pool: 'main',
  reportCount: 0,
  spicy: false,
  ...over,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // Unique per-file projectId (like every other d15/w-suite) so this suite's
    // `clearFirestore()` never wipes another concurrently-running file's seed.
    projectId: 'demo-gaycruisebingo-d15-approvals',
    firestore: {
      host: hostname,
      port: Number(port),
      rules: readFileSync(RULES_PATH, 'utf8'),
    },
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
      name: 'Cruise',
      status: 'active',
      admins: [ADMIN],
      settings: { reportHideThreshold: 4 },
      timezone: 'Europe/Rome',
    });
  });
});

describe('d15-approvals — create: a non-admin CAN land status: "pending"', () => {
  it('ALLOWS a non-admin create with status: "pending"', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), at('items/p1')), pendingPayload(ALICE)));
  });

  it('DENIES status: "active" on non-admin create — visible prompts require admin approval', async () => {
    await assertFails(setDoc(doc(db(ALICE), at('items/a1')), pendingPayload(ALICE, { status: 'active' })));
  });

  it('DENIES non-admin pending creates outside the main pool — legacy AND canonical curated values (#565)', async () => {
    await assertFails(setDoc(doc(db(ALICE), at('items/embark1')), pendingPayload(ALICE, { pool: 'embark' })));
    await assertFails(setDoc(doc(db(ALICE), at('items/farewell1')), pendingPayload(ALICE, { pool: 'farewell' })));
    await assertFails(setDoc(doc(db(ALICE), at('items/easy1')), pendingPayload(ALICE, { pool: 'easy' })));
    await assertFails(setDoc(doc(db(ALICE), at('items/closing1')), pendingPayload(ALICE, { pool: 'closing' })));
  });

  it('ALLOWS an admin active create in curated pools — both vocabularies during the #565 transition', async () => {
    // The client's curated writes keep emitting the LEGACY values during the
    // transition (`persistedPool`, src/data/admin.ts), but the validator must
    // accept the canonical ones too so the post-transition flip needs no rules
    // deploy in lockstep with hosting.
    await assertSucceeds(
      setDoc(doc(db(ADMIN), at('items/a1')), pendingPayload(ADMIN, { status: 'active', pool: 'main' })),
    );
    await assertSucceeds(
      setDoc(doc(db(ADMIN), at('items/e1')), pendingPayload(ADMIN, { status: 'active', pool: 'embark' })),
    );
    await assertSucceeds(
      setDoc(doc(db(ADMIN), at('items/f1')), pendingPayload(ADMIN, { status: 'active', pool: 'farewell' })),
    );
    await assertSucceeds(
      setDoc(doc(db(ADMIN), at('items/e2')), pendingPayload(ADMIN, { status: 'active', pool: 'easy' })),
    );
    await assertSucceeds(
      setDoc(doc(db(ADMIN), at('items/f2')), pendingPayload(ADMIN, { status: 'active', pool: 'closing' })),
    );
  });

  it('DENIES a create with a pool value outside both vocabularies', async () => {
    await assertFails(
      setDoc(doc(db(ADMIN), at('items/x1')), pendingPayload(ADMIN, { status: 'active', pool: 'bonus' })),
    );
  });

  it('DENIES a non-admin create with status: "rejected" — only an admin update may reject', async () => {
    await assertFails(setDoc(doc(db(ALICE), at('items/r1')), pendingPayload(ALICE, { status: 'rejected' })));
  });

  it('DENIES a non-admin create with status: "hidden"', async () => {
    await assertFails(setDoc(doc(db(ALICE), at('items/h1')), pendingPayload(ALICE, { status: 'hidden' })));
  });

  it('DENIES an unauthenticated create', async () => {
    await assertFails(setDoc(doc(unauthDb(), at('items/anon1')), pendingPayload('nobody')));
  });
});

describe('d15-approvals — pending item read carve-out re-pinned against a write-created row', () => {
  it('the submitter CAN read their own pending item; another non-admin CANNOT; an admin CAN', async () => {
    await setDoc(doc(db(ALICE), at('items/p1')), pendingPayload(ALICE));
    await assertSucceeds(getDoc(doc(db(ALICE), at('items/p1'))));
    await assertFails(getDoc(doc(db(BOB), at('items/p1'))));
    await assertSucceeds(getDoc(doc(db(ADMIN), at('items/p1'))));
  });
});

describe('d15-approvals — update: only an admin can transition pending → active/rejected', () => {
  it('ALLOWS an admin to approve (pending → active, stamping approvedBy/approvedAt)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), at('items/p1')), pendingPayload(ALICE));
    });
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), at('items/p1')), {
        status: 'active',
        approvedBy: ADMIN,
        approvedAt: NOW(),
      }),
    );
  });

  it('ALLOWS an admin to reject (pending → rejected)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), at('items/p1')), pendingPayload(ALICE));
    });
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), at('items/p1')), {
        status: 'rejected',
        approvedBy: ADMIN,
        approvedAt: NOW(),
      }),
    );
  });

  it('DENIES a non-admin (including the submitter) transitioning their own pending item to active', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), at('items/p1')), pendingPayload(ALICE));
    });
    await assertFails(
      updateDoc(doc(db(ALICE), at('items/p1')), { status: 'active', approvedBy: ALICE, approvedAt: NOW() }),
    );
  });

  it("DENIES a non-admin transitioning another Player's pending item to rejected", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), at('items/p1')), pendingPayload(ALICE));
    });
    await assertFails(
      updateDoc(doc(db(BOB), at('items/p1')), { status: 'rejected', approvedBy: BOB, approvedAt: NOW() }),
    );
  });

  it("a non-admin's ONLY permitted update on their own pending item is the reportCount increment path", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), at('items/p1')), pendingPayload(ALICE));
    });
    // The existing report path still works — unrelated to the approval gate.
    await assertSucceeds(updateDoc(doc(db(BOB), at('items/p1')), { reportCount: 1 }));
  });
});
