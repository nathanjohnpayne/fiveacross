import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildInvitationRecord,
  invitationIdForCode,
  invitationPath,
  invitationRatePath,
  redeemEventInvitation,
  type EventInvitationDeps,
  type EventInvitationPolicy,
  type InvitationFirestore,
} from '../../functions/src/eventInvitations';
import { eventInvitationFirestore } from '../../functions/src/eventInvitationFirestore';
import { membershipPath } from '../../functions/src/eventMembership.generated';

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const PROJECT_ID = 'demo-fiveacross-event-invitation-core';
const EVENT_ID = 'event-a';
const ADMIN = 'admin-uid';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const CODE = 'a'.repeat(43);
const INVITATION_ID = invitationIdForCode(CODE);
const T0 = 1_760_000_000_000;

const POLICY: EventInvitationPolicy = {
  ttlMs: 60_000,
  grantRole: 'member',
  maxUses: 1,
  revokeGrantedMemberships: false,
  rate: {
    mint: { windowMs: 60_000, maxAttempts: 1 },
    redeem: { windowMs: 60_000, maxAttempts: 2 },
    revoke: { windowMs: 60_000, maxAttempts: 1 },
  },
};

let testEnv: RulesTestEnvironment;
let adminApp: App;
let adminDb: Firestore;

beforeAll(async () => {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
  const [host, port] = emulatorHost.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
  adminApp = initializeApp({ projectId: PROJECT_ID }, `event-invitation-core-${process.pid}`);
  adminDb = getFirestore(adminApp);
});

afterAll(async () => {
  await deleteApp(adminApp);
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await Promise.all([
    adminDb.doc(`events/${EVENT_ID}`).set({ status: 'active', admins: [ADMIN] }),
    adminDb.doc(invitationPath(INVITATION_ID)).set(buildInvitationRecord({
      eventId: EVENT_ID,
      role: 'member',
      createdBy: ADMIN,
      createdAt: T0,
      expiresAt: T0 + 60_000,
      maxUses: 1,
      timestamp: (ms) => Timestamp.fromMillis(ms),
    })),
  ]);
});

function deps(db: InvitationFirestore = eventInvitationFirestore(adminDb)): EventInvitationDeps {
  return {
    db,
    now: () => T0 + 1_000,
    timestamp: (ms) => Timestamp.fromMillis(ms),
    policy: POLICY,
  };
}

function contentionAdapter(): { db: InvitationFirestore; attempts(): number } {
  let attemptCount = 0;
  let invitationReadArrivals = 0;
  let release = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const db = eventInvitationFirestore(adminDb, {
    onTransactionAttempt: () => { attemptCount += 1; },
    beforeGet: async (path) => {
      if (path !== invitationPath(INVITATION_ID) || invitationReadArrivals >= 2) return;
      invitationReadArrivals += 1;
      if (invitationReadArrivals === 2) release();
      await gate;
    },
  });
  return { db, attempts: () => attemptCount };
}

describe('Event Invitation core against real Firestore transactions', () => {
  it('creates exactly one membership when two distinct recipients race for one use', async () => {
    const contention = contentionAdapter();
    const outcomes = await Promise.all([
      redeemEventInvitation({ uid: ALICE, code: CODE, expectedEventId: EVENT_ID }, deps(contention.db)),
      redeemEventInvitation({ uid: BOB, code: CODE, expectedEventId: EVENT_ID }, deps(contention.db)),
    ]);

    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'invitation-unavailable' },
    ]);
    const memberships = await Promise.all([
      adminDb.doc(membershipPath(EVENT_ID, ALICE)).get(),
      adminDb.doc(membershipPath(EVENT_ID, BOB)).get(),
    ]);
    expect(memberships.filter((snapshot) => snapshot.exists)).toHaveLength(1);
    expect((await adminDb.doc(invitationPath(INVITATION_ID)).get()).data()).toMatchObject({
      status: 'consumed',
      remainingUses: 0,
      grantedUids: [expect.stringMatching(/^(alice|bob)-uid$/)],
    });
    expect(contention.attempts()).toBeGreaterThanOrEqual(3);
  });

  it('lets two same-caller attempts converge idempotently with one grant and two rate charges', async () => {
    const contention = contentionAdapter();
    const outcomes = await Promise.all([
      redeemEventInvitation({ uid: ALICE, code: CODE, expectedEventId: EVENT_ID }, deps(contention.db)),
      redeemEventInvitation({ uid: ALICE, code: CODE, expectedEventId: EVENT_ID }, deps(contention.db)),
    ]);

    expect(outcomes).toEqual(expect.arrayContaining([
      { ok: true, eventId: EVENT_ID, outcome: 'membership-created' },
      { ok: true, eventId: EVENT_ID, outcome: 'already-member' },
    ]));
    expect((await adminDb.doc(membershipPath(EVENT_ID, ALICE)).get()).exists).toBe(true);
    expect((await adminDb.doc(invitationPath(INVITATION_ID)).get()).data()).toMatchObject({
      status: 'consumed',
      remainingUses: 0,
      grantedUids: [ALICE],
    });
    expect((await adminDb.doc(invitationRatePath('redeem', ALICE)).get()).data()?.attemptMs).toEqual([
      T0 + 1_000,
      T0 + 1_000,
    ]);
    expect(contention.attempts()).toBeGreaterThanOrEqual(3);
  });
});
