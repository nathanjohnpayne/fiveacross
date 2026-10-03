import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc, collection, getDocs, query, where } from 'firebase/firestore';

// specs/feed-hearts.md — the Hearts rules contract. A Heart is one Player's
// like on a Feed post (a Proof or a Moment): the Doubt slot's structure
// without the accusation. Pinned invariants:
//   - create/update: OWN uid only, exactly the contract's five fields, a
//     real targetKind, the doc id BOUND to `${uid}_${targetKind}_${targetId}`
//     (no squatting another Player's slot), the hearted post must EXIST as
//     its declared kind WITH a matching `targetCreatedAt` incarnation stamp
//     and a Proof must be active
//     (Codex P2 on #425 — a recreated post must never inherit old hearts),
//     and createdAt sits in the shared +60s/-24h window.
//   - once-only: the SLOT ID is the guarantee — one doc per (Player, post),
//     so counts cannot inflate; the owner overwriting their own slot (the
//     recreated-post re-bind) is allowed under the same full validation and
//     still yields exactly one doc.
//   - toggle: the owner (or an admin) deletes; unheart-then-reheart is
//     delete + fresh create.
//   - read: ordinary admitted readers need the current active target and
//     incarnation; Admins can inspect retained stale slots.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB] = ['admin-uid', 'alice', 'bob'];
const PROOF = 'proof1';
const MOMENT = 'moment1';
const NOW = () => Date.now();
// The seeded targets' own createdAt stamps — the incarnation the heart
// fixtures must carry (rules compare via get() against the live doc).
const PROOF_AT = Date.now() - 60000;
const MOMENT_AT = Date.now() - 120000;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;
// The deterministic once-only slot setHeart writes (src/data/hearts.ts
// heartDocId) — the write rule binds the doc id to exactly this triple.
const slot = (uid: string, kind: string, targetId: string) =>
  at(`hearts/${uid}_${kind}_${targetId}`);
const heart = (uid: string, kind: string, targetId: string, over: Record<string, unknown> = {}) => ({
  uid,
  targetKind: kind,
  targetId,
  targetCreatedAt: kind === 'moment' ? MOMENT_AT : PROOF_AT,
  createdAt: NOW(),
  ...over,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gaycruisebingo-feed-hearts',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// Each test starts clean with a canonical Event, one Proof, one Moment, and
// Bob's standing heart on the Proof (at its canonical slot), so the read /
// once-only / delete invariants have something to act on.
beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.firestore();
    await setDoc(doc(s, `events/${EVENT}`), {
      name: 'Cruise', sailStart: '2026-01-01', sailEnd: '2026-01-07', status: 'active',
      defaultTheme: 'neon-playground', claimMode: 'honor', admins: [ADMIN],
      settings: { reportHideThreshold: 3 },
    });
    await setDoc(doc(s, at(`proofs/${PROOF}`)), {
      uid: BOB, displayName: BOB, photoURL: null, itemText: 'Saw a drag show',
      type: 'text', text: 'It happened.', status: 'active', reportCount: 0, createdAt: PROOF_AT,
    });
    await setDoc(doc(s, at(`moments/${MOMENT}`)), {
      kind: 'bingo', uid: BOB, displayName: BOB, photoURL: null, createdAt: MOMENT_AT,
    });
    await setDoc(doc(s, slot(BOB, 'proof', PROOF)), heart(BOB, 'proof', PROOF));
  });
});

describe('firestore.rules — Hearts (specs/feed-hearts.md)', () => {
  it('a signed-in Player may heart an existing Proof at their bound slot', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), slot(ALICE, 'proof', PROOF)), heart(ALICE, 'proof', PROOF)));
  });

  it('a signed-in Player may heart an existing Moment at their bound slot', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), slot(ALICE, 'moment', MOMENT)), heart(ALICE, 'moment', MOMENT)));
  });

  it('denies a forged uid — a Player cannot heart as someone else', async () => {
    await assertFails(setDoc(doc(db(ALICE), slot(BOB, 'moment', MOMENT)), heart(BOB, 'moment', MOMENT)));
  });

  it('denies an unbound doc id — no squatting another Player’s slot', async () => {
    // Alice's own valid payload, parked at Bob's would-be slot id.
    await assertFails(setDoc(doc(db(ALICE), slot(BOB, 'proof', PROOF)), heart(ALICE, 'proof', PROOF)));
    // ...and at an arbitrary id.
    await assertFails(setDoc(doc(db(ALICE), at('hearts/free-form-id')), heart(ALICE, 'proof', PROOF)));
  });

  it('denies hearting a post that does not exist (either kind)', async () => {
    await assertFails(setDoc(doc(db(ALICE), slot(ALICE, 'proof', 'ghost')), heart(ALICE, 'proof', 'ghost')));
    await assertFails(setDoc(doc(db(ALICE), slot(ALICE, 'moment', 'ghost')), heart(ALICE, 'moment', 'ghost')));
    // A real doc id under the WRONG declared kind is a phantom too.
    await assertFails(setDoc(doc(db(ALICE), slot(ALICE, 'moment', PROOF)), heart(ALICE, 'moment', PROOF)));
  });

  it('denies an unknown targetKind and extra fields', async () => {
    await assertFails(setDoc(doc(db(ALICE), slot(ALICE, 'tally', PROOF)), heart(ALICE, 'tally', PROOF)));
    await assertFails(
      setDoc(doc(db(ALICE), slot(ALICE, 'proof', PROOF)), heart(ALICE, 'proof', PROOF, { displayName: 'Alice' })),
    );
  });

  it('denies a far-future or ancient createdAt (the shared clock window)', async () => {
    await assertFails(
      setDoc(doc(db(ALICE), slot(ALICE, 'proof', PROOF)), heart(ALICE, 'proof', PROOF, { createdAt: NOW() + 3600000 })),
    );
    await assertFails(
      setDoc(doc(db(ALICE), slot(ALICE, 'proof', PROOF)), heart(ALICE, 'proof', PROOF, { createdAt: NOW() - 172800000 })),
    );
  });

  it('once-only lives in the slot id: the owner overwriting their own slot succeeds and still means ONE doc', async () => {
    // The recreated-post re-bind (Codex P2 on #425): a duplicate setDoc from
    // the owner is an allowed full-validation overwrite — never a second doc,
    // so the count cannot inflate.
    await assertSucceeds(setDoc(doc(db(BOB), slot(BOB, 'proof', PROOF)), heart(BOB, 'proof', PROOF)));
    await assertSucceeds(getDoc(doc(db(BOB), slot(BOB, 'proof', PROOF))));
  });

  it('denies a stale or forged incarnation stamp — targetCreatedAt must match the live target doc', async () => {
    await assertFails(
      setDoc(doc(db(ALICE), slot(ALICE, 'proof', PROOF)), heart(ALICE, 'proof', PROOF, { targetCreatedAt: PROOF_AT - 999 })),
    );
    await assertFails(
      setDoc(doc(db(ALICE), slot(ALICE, 'moment', MOMENT)), heart(ALICE, 'moment', MOMENT, { targetCreatedAt: 'soon' })),
    );
  });

  it('no cross-Player mutation: an admin (or anyone) cannot update someone else’s Heart in place', async () => {
    // The merged doc's uid stays BOB — never the caller's — so the own-uid
    // bind denies every foreign update; the admin lever is delete, not edit.
    await assertFails(updateDoc(doc(db(ADMIN), slot(BOB, 'proof', PROOF)), { createdAt: NOW() }));
    await assertFails(updateDoc(doc(db(ALICE), slot(BOB, 'proof', PROOF)), { createdAt: NOW() }));
  });

  it('the owner unhearts (deletes) their own Heart; others cannot', async () => {
    await assertFails(deleteDoc(doc(db(ALICE), slot(BOB, 'proof', PROOF))));
    await assertSucceeds(deleteDoc(doc(db(BOB), slot(BOB, 'proof', PROOF))));
  });

  it('unheart-then-reheart works: delete + fresh create at the same slot', async () => {
    await assertSucceeds(deleteDoc(doc(db(BOB), slot(BOB, 'proof', PROOF))));
    await assertSucceeds(setDoc(doc(db(BOB), slot(BOB, 'proof', PROOF)), heart(BOB, 'proof', PROOF)));
  });

  it('an admin may delete any Heart (moderation)', async () => {
    await assertSucceeds(deleteDoc(doc(db(ADMIN), slot(BOB, 'proof', PROOF))));
  });

  it('hearts are publicly readable to signed-in Players, never to signed-out', async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), slot(BOB, 'proof', PROOF))));
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), slot(BOB, 'proof', PROOF))));
  });
});


describe('active target Heart read boundary', () => {
  const mine = () => doc(db(ALICE), slot(ALICE, 'proof', PROOF));
  const scoped = () => query(collection(db(ALICE), at('hearts')), where('targetKind', '==', 'proof'), where('targetId', '==', PROOF), where('targetCreatedAt', '==', PROOF_AT));
  it.each(['hidden', 'pending', 'flagged'])('denies creating and reading references to a %s Proof', async status => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), at(`proofs/${PROOF}`)), { status });
    });
    await assertFails(setDoc(mine(), heart(ALICE, 'proof', PROOF)));
    await assertFails(getDoc(doc(db(ALICE), slot(BOB, 'proof', PROOF))));
    await assertFails(getDocs(scoped()));
    await assertSucceeds(getDoc(doc(db(ADMIN), slot(BOB, 'proof', PROOF))));
  });
  it('admits the visible target query while denying the flat collection, then denies stale rows after deletion', async () => {
    await assertSucceeds(getDocs(scoped()));
    await assertFails(getDocs(collection(db(ALICE), at('hearts'))));
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await deleteDoc(doc(ctx.firestore(), at(`proofs/${PROOF}`)));
    });
    await assertFails(getDoc(doc(db(ALICE), slot(BOB, 'proof', PROOF))));
    await assertFails(getDocs(scoped()));
    await assertSucceeds(getDoc(doc(db(ADMIN), slot(BOB, 'proof', PROOF))));
  });
  it('cannot resurrect a stale Heart by recreating a target ID under a different incarnation', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), at(`proofs/${PROOF}`)), { createdAt: PROOF_AT + 1 });
    });
    await assertFails(getDoc(doc(db(ALICE), slot(BOB, 'proof', PROOF))));
    await assertFails(getDocs(scoped()));
    await assertSucceeds(setDoc(mine(), { ...heart(ALICE, 'proof', PROOF), targetCreatedAt: PROOF_AT + 1 }));
    await assertSucceeds(getDocs(query(collection(db(ALICE), at('hearts')), where('targetKind', '==', 'proof'), where('targetId', '==', PROOF), where('targetCreatedAt', '==', PROOF_AT + 1))));
  });
});
