import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';

// Covers the client boundary in specs/event-invitations.md. Invitation
// documents are bearer-capability state and rate-limit documents are the abuse
// control protecting that state, so both collections are denied to EVERY
// client credential. The Admin SDK callables run with rules disabled in
// production; `withSecurityRulesDisabled` is their emulator stand-in here.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'bodega-bay-2026';
const HOST = 'bodega-bay.fiveacross.app';
const INVITATION = 'invitation-code-hash';
const RATE_BUCKET = 'redeem_caller-hash';
const [ADMIN, MEMBER, STRANGER] = ['admin-uid', 'member-uid', 'stranger-uid'];

let testEnv: RulesTestEnvironment;
const authed = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();

const clients: ReadonlyArray<readonly [string, () => Firestore]> = [
  ['an unauthenticated caller', anon],
  ['an active Event member', () => authed(MEMBER)],
  ['an active Event admin', () => authed(ADMIN)],
];

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-fiveacross-event-invitations',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `events/${EVENT}`), {
      name: 'Bodega Bay',
      status: 'active',
      admins: [ADMIN],
      membershipEnforcement: 'enforced',
    });
    for (const [uid, role] of [[ADMIN, 'admin'], [MEMBER, 'member']] as const) {
      await setDoc(doc(db, `events/${EVENT}/memberships/${uid}`), {
        schemaVersion: 1,
        eventId: EVENT,
        uid,
        role,
        status: 'active',
        grantedAt: 1_760_000_000_000,
        grantedBy: 'system:test',
        invitationId: null,
      });
    }
    await setDoc(doc(db, `eventInvitations/${INVITATION}`), {
      schemaVersion: 1,
      eventId: EVENT,
      role: 'member',
      status: 'active',
      remainingUses: 1,
      createdBy: ADMIN,
      createdAt: 1_760_000_000_000,
      expiresAt: 1_760_000_060_000,
    });
    await setDoc(doc(db, `eventInvitationRateLimits/${RATE_BUCKET}`), {
      attemptsMs: [1_760_000_000_000],
    });
    await setDoc(doc(db, `hostnames/${HOST}`), {
      eventId: EVENT,
      canonicalHost: HOST,
      edition: 'vacay',
      status: 'active',
      slug: 'bodega-bay',
      isCanonical: true,
    });
  });
});

describe('eventInvitations is server-only', () => {
  it.each(clients)('denies %s a point read', async (_label, db) => {
    await assertFails(getDoc(doc(db(), `eventInvitations/${INVITATION}`)));
  });

  it.each(clients)('denies %s a collection listing', async (_label, db) => {
    await assertFails(getDocs(collection(db(), 'eventInvitations')));
  });

  it.each(clients)('denies %s a forged invitation create', async (_label, db) => {
    await assertFails(
      setDoc(doc(db(), `eventInvitations/forged-${_label.replaceAll(' ', '-')}`), {
        eventId: EVENT,
        role: 'admin',
        status: 'active',
        remainingUses: 99,
      }),
    );
  });

  it.each(clients)('denies %s restoring uses or extending expiry', async (_label, db) => {
    await assertFails(
      updateDoc(doc(db(), `eventInvitations/${INVITATION}`), {
        remainingUses: 99,
        expiresAt: 4_102_444_800_000,
      }),
    );
  });

  it.each(clients)('denies %s deleting an invitation', async (_label, db) => {
    await assertFails(deleteDoc(doc(db(), `eventInvitations/${INVITATION}`)));
  });

});

describe('eventInvitationRateLimits is server-only', () => {
  it.each(clients)('denies %s a point read', async (_label, db) => {
    await assertFails(getDoc(doc(db(), `eventInvitationRateLimits/${RATE_BUCKET}`)));
  });

  it.each(clients)('denies %s a collection listing', async (_label, db) => {
    await assertFails(getDocs(collection(db(), 'eventInvitationRateLimits')));
  });

  it.each(clients)('denies %s creating a fresh bucket', async (_label, db) => {
    await assertFails(
      setDoc(doc(db(), `eventInvitationRateLimits/forged-${_label.replaceAll(' ', '-')}`), {
        attemptsMs: [],
      }),
    );
  });

  it.each(clients)('denies %s resetting an existing bucket', async (_label, db) => {
    await assertFails(
      updateDoc(doc(db(), `eventInvitationRateLimits/${RATE_BUCKET}`), { attemptsMs: [] }),
    );
  });

  it.each(clients)('denies %s deleting an existing bucket', async (_label, db) => {
    await assertFails(deleteDoc(doc(db(), `eventInvitationRateLimits/${RATE_BUCKET}`)));
  });

});

// There is deliberately no explicit memberships match yet: #804 owns its
// self-get/admin-list policy. These assertions pin the CURRENT default-deny
// write posture without claiming that #803 introduced a membership rule.
describe('membership writes remain default-denied pending #804', () => {
  it.each(clients)('denies %s creating a membership', async (_label, db) => {
    await assertFails(
      setDoc(doc(db(), `events/${EVENT}/memberships/${STRANGER}`), {
        schemaVersion: 1,
        eventId: EVENT,
        uid: STRANGER,
        role: 'admin',
        status: 'active',
        grantedAt: 1_760_000_000_000,
        grantedBy: ADMIN,
        invitationId: INVITATION,
      }),
    );
  });

  it.each(clients)('denies %s rewriting a membership', async (_label, db) => {
    await assertFails(
      updateDoc(doc(db(), `events/${EVENT}/memberships/${MEMBER}`), {
        role: 'admin',
        status: 'active',
      }),
    );
  });

  it.each(clients)('denies %s deleting a membership', async (_label, db) => {
    await assertFails(deleteDoc(doc(db(), `events/${EVENT}/memberships/${MEMBER}`)));
  });
});

it('leaves the neighboring public hostname lookup unchanged', async () => {
  const snapshot = await assertSucceeds(getDoc(doc(anon(), `hostnames/${HOST}`)));
  expect(snapshot.exists()).toBe(true);
  expect(snapshot.data()?.eventId).toBe(EVENT);
});
