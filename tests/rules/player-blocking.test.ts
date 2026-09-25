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
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';

// specs/player-blocking.md — the block records' rules contract (#689, ADR 0016).
// Two records per block under events/{eventId}: the owner-only DIRECTION record
// `blocks/{owner}_{target}` and the PAIR record `blockPairs/{lo}_{hi}` either
// party may read. Pinned here:
//   - Invariant I (pair exists iff a direction exists) holds after every
//     committed batch, in both directions and in the mutual case;
//   - the direction record is private to its owner (get, list, no Admin path)
//     and the pair is readable by its two parties only; no collectionGroup;
//   - a Heart aimed across a pair is denied in BOTH directions, even though
//     the blocked Player cannot read the direction record that names them,
//     and a third Player's heart on the same post still lands;
//   - Doubt create across a pair STILL SUCCEEDS (the owner's decision 5: the
//     verification channel is never removed by a block);
//   - blocking survives the archive freeze and, under enforcement, needs
//     admission like every other arm.
// The same suite runs with membershipEnforcement 'off' and 'enforced'.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB, CAROL, STRANGER] = ['admin-uid', 'alice', 'bob', 'carol', 'stranger'];
const ITEM = 'item1';
const NOW = () => Date.now();
const PROOF_AT = Date.now() - 60000;
const MOMENT_AT = Date.now() - 120000;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;
// The two ids the client computes (src/data/blocks.ts blockPairId / paths.ts).
const pairId = (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`);
const blockPath = (owner: string, target: string) => at(`blocks/${owner}_${target}`);
const pairPath = (a: string, b: string) => at(`blockPairs/${pairId(a, b)}`);
const block = (owner: string, target: string, over: Record<string, unknown> = {}) => ({
  ownerUid: owner, targetUid: target, eventId: EVENT, createdAt: NOW(), ...over,
});
const pair = (a: string, b: string, over: Record<string, unknown> = {}) => ({
  uids: a < b ? [a, b] : [b, a], eventId: EVENT, ...over,
});
const heartSlot = (uid: string, kind: string, targetId: string) => at(`hearts/${uid}_${kind}_${targetId}`);
const heart = (uid: string, kind: string, targetId: string) => ({
  uid, targetKind: kind, targetId,
  targetCreatedAt: kind === 'moment' ? MOMENT_AT : PROOF_AT, createdAt: NOW(),
});
const doubtSlot = (from: string, target: string) => at(`doubts/${from}_${target}_${ITEM}`);
const doubt = (from: string, target: string) => ({
  itemId: ITEM, cellIndex: 3, fromUid: from, fromDisplayName: from,
  targetUid: target, targetDisplayName: target, createdAt: NOW(),
});
const proof = (uid: string) => ({
  uid, displayName: uid, photoURL: null, itemText: 'Saw a drag show', type: 'text',
  text: 'It happened.', status: 'active', reportCount: 0, createdAt: PROOF_AT,
});
const membership = (uid: string) => ({
  schemaVersion: 1, eventId: EVENT, uid, role: 'member', status: 'active',
  grantedAt: NOW(), grantedBy: 'system:test', invitationId: null,
});

// The client's block() batch: direction + pair, one commit.
function blockBatch(fs: Firestore, me: string, target: string, over: Record<string, unknown> = {}) {
  const b = writeBatch(fs);
  b.set(doc(fs, blockPath(me, target)), block(me, target, over));
  b.set(doc(fs, pairPath(me, target)), pair(me, target));
  return b.commit();
}
// The client's first unblock() attempt: direction + pair, one commit.
function unblockBatch(fs: Firestore, me: string, target: string) {
  const b = writeBatch(fs);
  b.delete(doc(fs, blockPath(me, target)));
  b.delete(doc(fs, pairPath(me, target)));
  return b.commit();
}
async function seeded(write: (s: Firestore) => Promise<void>) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => write(ctx.firestore()));
}
const seedBlock = (owner: string, target: string) =>
  seeded(async (s) => {
    await setDoc(doc(s, blockPath(owner, target)), block(owner, target));
    await setDoc(doc(s, pairPath(owner, target)), pair(owner, target));
  });

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-fiveacross-player-blocking',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

describe.each([{ enforcement: 'off' }, { enforcement: 'enforced' }])(
  'firestore.rules — player blocking (specs/player-blocking.md), membershipEnforcement $enforcement',
  ({ enforcement }) => {
    // A canonical Event whose four members (the Admin included) hold active
    // memberships so the enforced run admits them; a Proof and a Moment by
    // Bob, a Proof by Alice, a server-authored Moment, and standing Marks so
    // Doubts can be raised both ways. Stranger holds no membership.
    beforeEach(async () => {
      await testEnv.clearFirestore();
      await seeded(async (s) => {
        await setDoc(doc(s, `events/${EVENT}`), {
          name: 'Cruise', status: 'active', admins: [ADMIN], claimMode: 'honor',
          settings: { reportHideThreshold: 3 }, membershipEnforcement: enforcement,
        });
        for (const uid of [ADMIN, ALICE, BOB, CAROL]) {
          await setDoc(doc(s, at(`memberships/${uid}`)), membership(uid));
        }
        await setDoc(doc(s, at('proofs/bob-proof')), proof(BOB));
        await setDoc(doc(s, at('proofs/alice-proof')), proof(ALICE));
        await setDoc(doc(s, at('moments/bob-moment')), {
          kind: 'bingo', uid: BOB, displayName: BOB, photoURL: null, createdAt: MOMENT_AT,
        });
        await setDoc(doc(s, at('moments/last_call')), {
          kind: 'last_call', uid: 'system', displayName: 'Standings', photoURL: null,
          createdAt: MOMENT_AT, line: 'Bob leads by 1',
        });
        const marker = (uid: string) => ({ uid, displayName: uid, markedAt: NOW() });
        await setDoc(doc(s, at(`tally/${ITEM}/markers/${ALICE}`)), marker(ALICE));
        await setDoc(doc(s, at(`tally/${ITEM}/markers/${BOB}`)), marker(BOB));
      });
    });

    describe('the block batch and Invariant I', () => {
      it('a Player blocks another with one batch (direction + pair), and a re-block is an idempotent createdAt refresh', async () => {
        await assertSucceeds(blockBatch(db(ALICE), ALICE, BOB));
        await assertSucceeds(blockBatch(db(ALICE), ALICE, BOB));
      });

      it('a direction record cannot be created without its pair, nor a pair without the caller’s direction', async () => {
        await assertFails(setDoc(doc(db(ALICE), blockPath(ALICE, BOB)), block(ALICE, BOB)));
        await assertFails(setDoc(doc(db(ALICE), pairPath(ALICE, BOB)), pair(ALICE, BOB)));
        // ...and a pair whose direction belongs to the OTHER party is not the caller's.
        await seedBlock(BOB, ALICE);
        await assertFails(setDoc(doc(db(ALICE), pairPath(ALICE, BOB)), pair(ALICE, BOB, { eventId: EVENT })));
      });

      it('denies a forged owner, a self-block, an unbound id, a target containing the joiner, extra or wrong fields, and a bad clock', async () => {
        await assertFails(blockBatch(db(BOB), ALICE, BOB));
        await assertFails(blockBatch(db(ALICE), ALICE, ALICE));
        const fs = db(ALICE);
        const misbound = writeBatch(fs);
        misbound.set(doc(fs, blockPath(ALICE, CAROL)), block(ALICE, BOB));
        misbound.set(doc(fs, pairPath(ALICE, BOB)), pair(ALICE, BOB));
        await assertFails(misbound.commit());
        await assertFails(blockBatch(db(ALICE), ALICE, 'bo_b'));
        await assertFails(blockBatch(db(ALICE), ALICE, BOB, { note: 'extra' }));
        await assertFails(blockBatch(db(ALICE), ALICE, BOB, { eventId: 'other' }));
        await assertFails(blockBatch(db(ALICE), ALICE, BOB, { createdAt: NOW() + 3600000 }));
        await assertFails(blockBatch(db(ALICE), ALICE, BOB, { createdAt: NOW() - 172800000 }));
      });

      it('denies a pair whose uids do not match its id, are unordered, or omit the caller', async () => {
        const fs = db(ALICE);
        for (const bad of [
          { uids: [ALICE, CAROL], eventId: EVENT },
          { uids: [BOB, ALICE], eventId: EVENT },
          { uids: [ALICE], eventId: EVENT },
          { uids: [ALICE, BOB], eventId: EVENT, since: 1 },
        ]) {
          const b = writeBatch(fs);
          b.set(doc(fs, blockPath(ALICE, BOB)), block(ALICE, BOB));
          b.set(doc(fs, pairPath(ALICE, BOB)), bad);
          await assertFails(b.commit());
        }
        const carol = db(CAROL);
        const foreign = writeBatch(carol);
        foreign.set(doc(carol, blockPath(CAROL, BOB)), block(CAROL, BOB));
        foreign.set(doc(carol, pairPath(ALICE, BOB)), pair(ALICE, BOB));
        await assertFails(foreign.commit());
      });

      it('a direction update may refresh createdAt only; owner or target cannot be re-pointed', async () => {
        await seedBlock(ALICE, BOB);
        await assertSucceeds(updateDoc(doc(db(ALICE), blockPath(ALICE, BOB)), { createdAt: NOW() }));
        await assertFails(updateDoc(doc(db(ALICE), blockPath(ALICE, BOB)), { targetUid: CAROL }));
        await assertFails(updateDoc(doc(db(ALICE), blockPath(ALICE, BOB)), { ownerUid: CAROL }));
        await assertFails(updateDoc(doc(db(BOB), blockPath(ALICE, BOB)), { createdAt: NOW() }));
        await assertFails(updateDoc(doc(db(ADMIN), blockPath(ALICE, BOB)), { createdAt: NOW() }));
      });

      it('unblock removes the pair with the direction; a direction delete that would orphan the pair is denied', async () => {
        await seedBlock(ALICE, BOB);
        await assertFails(deleteDoc(doc(db(ALICE), blockPath(ALICE, BOB))));
        await assertFails(deleteDoc(doc(db(ALICE), pairPath(ALICE, BOB))));
        await assertFails(unblockBatch(db(BOB), ALICE, BOB));
        await assertFails(unblockBatch(db(ADMIN), ALICE, BOB));
        await assertSucceeds(unblockBatch(db(ALICE), ALICE, BOB));
      });

      it('mutual block: the second party joins the existing pair; the pair stays until the LAST direction goes', async () => {
        await assertSucceeds(blockBatch(db(ALICE), ALICE, BOB));
        await assertSucceeds(blockBatch(db(BOB), BOB, ALICE));
        // The first unblock attempt (direction + pair) is denied while Bob's
        // direction stands; the direction-only retry is what lands.
        await assertFails(unblockBatch(db(ALICE), ALICE, BOB));
        await assertSucceeds(deleteDoc(doc(db(ALICE), blockPath(ALICE, BOB))));
        await assertSucceeds(getDoc(doc(db(ALICE), pairPath(ALICE, BOB))));
        await assertSucceeds(unblockBatch(db(BOB), BOB, ALICE));
      });

      it('a pair left with no direction (a concurrent mutual unblock) is deletable by either party and nobody else', async () => {
        await seeded(async (s) => {
          await setDoc(doc(s, pairPath(ALICE, BOB)), pair(ALICE, BOB));
        });
        await assertFails(deleteDoc(doc(db(CAROL), pairPath(ALICE, BOB))));
        await assertFails(deleteDoc(doc(db(ADMIN), pairPath(ALICE, BOB))));
        await assertSucceeds(deleteDoc(doc(db(BOB), pairPath(ALICE, BOB))));
      });

      it('blocking is a safety action: the batch lands on an archived Event, and so does the unblock', async () => {
        await seeded(async (s) => {
          await updateDoc(doc(s, `events/${EVENT}`), { status: 'archived', archivedAt: NOW() });
        });
        await assertSucceeds(blockBatch(db(ALICE), ALICE, BOB));
        await assertSucceeds(unblockBatch(db(ALICE), ALICE, BOB));
      });

      it('a Player may block an Admin (a social hide only)', async () => {
        await assertSucceeds(blockBatch(db(ALICE), ALICE, ADMIN));
      });

      it.runIf(enforcement === 'enforced')('a non-admitted caller is denied every arm under enforcement', async () => {
        await assertFails(blockBatch(db(STRANGER), STRANGER, BOB));
        await seedBlock(STRANGER, BOB);
        await assertFails(getDoc(doc(db(STRANGER), blockPath(STRANGER, BOB))));
        await assertFails(getDoc(doc(db(STRANGER), pairPath(STRANGER, BOB))));
        await assertFails(unblockBatch(db(STRANGER), STRANGER, BOB));
      });
    });

    describe('who can read what', () => {
      beforeEach(() => seedBlock(ALICE, BOB));

      it('the direction record is the blocker’s alone: owner gets and lists it; the blocked Player, a third Player and an Admin cannot', async () => {
        await assertSucceeds(getDoc(doc(db(ALICE), blockPath(ALICE, BOB))));
        await assertSucceeds(getDocs(query(collection(db(ALICE), at('blocks')), where('ownerUid', '==', ALICE))));
        for (const uid of [BOB, CAROL, ADMIN]) {
          await assertFails(getDoc(doc(db(uid), blockPath(ALICE, BOB))));
          await assertFails(getDocs(query(collection(db(uid), at('blocks')), where('ownerUid', '==', ALICE))));
        }
        await assertFails(getDocs(collection(db(ALICE), at('blocks'))));
      });

      it('the pair is readable by its two parties (get, and list by array-contains) and by nobody else', async () => {
        for (const uid of [ALICE, BOB]) {
          await assertSucceeds(getDoc(doc(db(uid), pairPath(ALICE, BOB))));
          await assertSucceeds(getDocs(query(collection(db(uid), at('blockPairs')), where('uids', 'array-contains', uid))));
        }
        for (const uid of [CAROL, ADMIN]) {
          await assertFails(getDoc(doc(db(uid), pairPath(ALICE, BOB))));
          await assertFails(getDocs(query(collection(db(uid), at('blockPairs')), where('uids', 'array-contains', ALICE))));
        }
        await assertFails(getDocs(collection(db(ALICE), at('blockPairs'))));
        await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), pairPath(ALICE, BOB))));
      });

      it('no collectionGroup path exists for either collection', async () => {
        await assertFails(getDocs(query(collectionGroup(db(ALICE), 'blocks'), where('ownerUid', '==', ALICE))));
        await assertFails(getDocs(query(collectionGroup(db(ALICE), 'blockPairs'), where('uids', 'array-contains', ALICE))));
      });
    });

    describe('interactions across a block', () => {
      it('a Heart aimed across a pair is denied in both directions (even though Bob cannot read alice_bob); a third Player’s still lands', async () => {
        await seedBlock(ALICE, BOB);
        await assertFails(setDoc(doc(db(ALICE), heartSlot(ALICE, 'proof', 'bob-proof')), heart(ALICE, 'proof', 'bob-proof')));
        await assertFails(setDoc(doc(db(ALICE), heartSlot(ALICE, 'moment', 'bob-moment')), heart(ALICE, 'moment', 'bob-moment')));
        await assertFails(setDoc(doc(db(BOB), heartSlot(BOB, 'proof', 'alice-proof')), heart(BOB, 'proof', 'alice-proof')));
        await assertSucceeds(setDoc(doc(db(CAROL), heartSlot(CAROL, 'proof', 'bob-proof')), heart(CAROL, 'proof', 'bob-proof')));
        // A server-authored Moment never names a pair.
        await assertSucceeds(setDoc(doc(db(ALICE), heartSlot(ALICE, 'moment', 'last_call')), heart(ALICE, 'moment', 'last_call')));
      });

      it('a standing Heart cannot be refreshed (updated) across a pair, and unblocking restores hearting', async () => {
        await seeded(async (s) => {
          await setDoc(doc(s, heartSlot(ALICE, 'proof', 'bob-proof')), heart(ALICE, 'proof', 'bob-proof'));
        });
        await seedBlock(BOB, ALICE);
        await assertFails(setDoc(doc(db(ALICE), heartSlot(ALICE, 'proof', 'bob-proof')), heart(ALICE, 'proof', 'bob-proof')));
        await assertSucceeds(unblockBatch(db(BOB), BOB, ALICE));
        await assertSucceeds(setDoc(doc(db(ALICE), heartSlot(ALICE, 'proof', 'bob-proof')), heart(ALICE, 'proof', 'bob-proof')));
      });

      it('with no pair present a Heart lands exactly as before (the refactored target read and its budget)', async () => {
        await assertSucceeds(setDoc(doc(db(ALICE), heartSlot(ALICE, 'proof', 'bob-proof')), heart(ALICE, 'proof', 'bob-proof')));
        await assertSucceeds(setDoc(doc(db(ALICE), heartSlot(ALICE, 'moment', 'bob-moment')), heart(ALICE, 'moment', 'bob-moment')));
        await assertFails(setDoc(doc(db(ALICE), heartSlot(ALICE, 'proof', 'ghost')), heart(ALICE, 'proof', 'ghost')));
        await assertFails(setDoc(doc(db(ALICE), heartSlot(ALICE, 'moment', 'bob-proof')), heart(ALICE, 'moment', 'bob-proof')));
      });

      it('Doubt create across a pair STILL SUCCEEDS, both ways (ADR 0001: a block never removes the verification channel)', async () => {
        await seedBlock(ALICE, BOB);
        await assertSucceeds(setDoc(doc(db(ALICE), doubtSlot(ALICE, BOB)), doubt(ALICE, BOB)));
        await assertSucceeds(setDoc(doc(db(BOB), doubtSlot(BOB, ALICE)), doubt(BOB, ALICE)));
      });
    });
  },
);
