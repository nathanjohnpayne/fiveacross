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

// specs/cloud-vision-moderation.md — the rules half of the Vision auto-hide
// (#133, ADR 0004). `hideProofOnVisionFlag` is a SECOND admin-SDK writer of the
// same server-authoritative `status` field #43 established, so this suite pins
// that adding it needed no loosening anywhere:
//   1. A non-admin still cannot self-hide or un-hide a Proof — including one the
//      AI screen has flagged or already hidden.
//   2. A non-admin cannot forge, change, or CLEAR `visionFlag` — the audit record
//      an admin's Restore deliberately leaves behind is not client-erasable.
//   3. Nor the `safetyHide` marker the trigger stamps beside the status, which is
//      the ONE fact `confirmClaim` gates the claim-confirm publish on: a client
//      that could forge or scrub it could hold or release any Proof it liked.
//   4. `flagged` and Vision-`hidden` Proofs stay admin-only reads, so the hide is
//      authoritative for the Feed rather than presentational.
//   5. The admin console's Restore, and the community report path, both still work
//      on an AI-flagged Proof.
// Both moderation fields ride the SAME `hasOnly(['reportCount'])` bound the #43
// `status` guard already imposed, so the marker needed no rules change — these
// cases are the pin that says so, not a new grant.
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
    projectId: 'demo-gaycruisebingo-vision-hide',
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
      name: 'Cruise', startsOn: '2026-01-01', endsOn: '2026-01-07', status: 'active',
      defaultTheme: 'neon-playground', claimMode: 'honor', admins: [ADMIN],
      settings: { reportHideThreshold: 4 },
    });
    // The three states the Vision lifecycle passes through, written the way the
    // admin SDK writes them (rules disabled — exactly the Function's own bypass).
    await setDoc(doc(s, at('proofs/pActive')), photoProof('pActive'));
    await setDoc(doc(s, at('proofs/pFlagged')), photoProof('pFlagged', { status: 'flagged', visionFlag: 'violence' }));
    await setDoc(
      doc(s, at('proofs/pVisionHidden')),
      // Exactly what `hideVisionFlaggedIfQualifies` writes: the status AND the
      // server-owned marker, in one update.
      photoProof('pVisionHidden', { status: 'hidden', safetyHide: true, visionFlag: 'violence' }),
    );
  });
});

describe('firestore.rules — the Vision hide needs no client write surface (specs/cloud-vision-moderation.md)', () => {
  it('a non-admin cannot self-hide a Vision-flagged Proof — the hide is the Function\'s alone', async () => {
    await assertFails(updateDoc(doc(db(BOB), at('proofs/pFlagged')), { status: 'hidden' }));
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/pFlagged')), { status: 'hidden' })); // not even the owner
    await assertFails(updateDoc(doc(db(BOB), at('proofs/pFlagged')), { reportCount: increment(1), status: 'hidden' }));
  });

  it('a non-admin cannot un-hide a Vision-hidden Proof, nor demote it back to flagged', async () => {
    await assertFails(updateDoc(doc(db(BOB), at('proofs/pVisionHidden')), { status: 'active' }));
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/pVisionHidden')), { status: 'active' }));
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/pVisionHidden')), { status: 'flagged' }));
  });

  it('a non-admin cannot forge, change, or CLEAR visionFlag — the AI verdict is server-set and not erasable', async () => {
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/pActive')), { visionFlag: 'violence' })); // forge
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/pFlagged')), { visionFlag: 'racy' })); // downgrade to a non-auto-hide verdict
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/pVisionHidden')), { visionFlag: null })); // scrub the audit record
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/pVisionHidden')), { reportCount: increment(1), visionFlag: null }));
  });

  it('a non-admin cannot forge, flip, or SCRUB the safetyHide marker the confirm gate reads', async () => {
    // `confirmClaim` publishes a claim's Proof unless this marker stands, so a
    // client able to write it could release any Proof the AI screen hid — or hold
    // any Proof it liked. `hasOnly(['reportCount'])` is what forbids all four.
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/pVisionHidden')), { safetyHide: false })); // scrub the hold
    await assertFails(updateDoc(doc(db(BOB), at('proofs/pVisionHidden')), { safetyHide: false }));
    await assertFails(updateDoc(doc(db(ALICE), at('proofs/pActive')), { safetyHide: true })); // forge a hold
    await assertFails(
      updateDoc(doc(db(ALICE), at('proofs/pVisionHidden')), { reportCount: increment(1), safetyHide: false }),
    ); // smuggled onto the one update a non-admin IS allowed
  });

  it('a non-admin cannot create a Proof that arrives pre-flagged, pre-hidden, or pre-marked', async () => {
    await assertFails(setDoc(doc(db(ALICE), at('proofs/pNew1')), photoProof('pNew1', { visionFlag: 'violence' })));
    await assertFails(setDoc(doc(db(ALICE), at('proofs/pNew2')), photoProof('pNew2', { status: 'flagged' })));
    await assertFails(setDoc(doc(db(ALICE), at('proofs/pNew3')), photoProof('pNew3', { status: 'hidden' })));
    // `safetyHide` is not in the create `hasOnly` list at all, so carrying it —
    // in EITHER direction — fails closed with no extra clause.
    await assertFails(setDoc(doc(db(ALICE), at('proofs/pNew5')), photoProof('pNew5', { safetyHide: true })));
    await assertFails(setDoc(doc(db(ALICE), at('proofs/pNew6')), photoProof('pNew6', { safetyHide: false })));
    await assertSucceeds(setDoc(doc(db(ALICE), at('proofs/pNew4')), photoProof('pNew4'))); // the ordinary active create still works
  });
});

describe('firestore.rules — a Vision-hidden Proof is authoritatively gone from the player read path', () => {
  const proofsCol = (uid: string) => collection(db(uid), at('proofs'));

  it('a non-admin reads the active Proof but NOT the flagged or Vision-hidden one', async () => {
    await assertSucceeds(getDoc(doc(db(BOB), at('proofs/pActive'))));
    await assertFails(getDoc(doc(db(BOB), at('proofs/pFlagged'))));
    await assertFails(getDoc(doc(db(BOB), at('proofs/pVisionHidden'))));
    await assertFails(getDoc(doc(db(ALICE), at('proofs/pVisionHidden')))); // the uploader loses the read too
  });

  it('the Feed query (status==active) is ALLOWED and an unconstrained one is DENIED', async () => {
    // useProofFeed subscribes with where('status','==','active'), so the hide removes
    // the Proof from the Feed at the rules layer, not just presentationally.
    await assertSucceeds(getDocs(query(proofsCol(BOB), where('status', '==', 'active'))));
    await assertFails(getDocs(proofsCol(BOB)));
  });

  it('an admin reads every state — the moderation queue is the surface that must not lose them', async () => {
    await assertSucceeds(getDoc(doc(db(ADMIN), at('proofs/pFlagged'))));
    await assertSucceeds(getDoc(doc(db(ADMIN), at('proofs/pVisionHidden'))));
    await assertSucceeds(getDocs(proofsCol(ADMIN))); // useReportedProofs: unconstrained admin read
  });
});

describe('firestore.rules — the admin Restore and the community report path still work on a flagged Proof', () => {
  it('an admin restores a Vision-hidden Proof, clearing the marker and leaving visionFlag intact', async () => {
    // The exact `restoreProof` write (src/data/admin.ts): the status and the
    // marker together, so the hold the confirm gate reads is lifted in one go.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), at('proofs/pVisionHidden')), { status: 'active', safetyHide: false }),
    );
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('proofs/pFlagged')), { status: 'hidden' })); // and can hide by hand
  });

  it('a bare reportCount+1 still SUCCEEDS on a flagged Proof — #133 did not narrow the report path', async () => {
    await assertSucceeds(updateDoc(doc(db(BOB), at('proofs/pFlagged')), { reportCount: increment(1) }));
    await assertSucceeds(updateDoc(doc(db(BOB), at('proofs/pVisionHidden')), { reportCount: increment(1) }));
  });
});
