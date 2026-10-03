import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, increment, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch, type Firestore } from 'firebase/firestore';

let env: RulesTestEnvironment;
const event = 'reports';
const path = (tail: string) => `events/${event}/${tail}`;
const db = (uid: string) => env.authenticatedContext(uid).firestore();
function submission(fs: Firestore, uid: string, kind = 'items', id = 'target', incarnation = 100) {
  const batch = writeBatch(fs);
  batch.update(doc(fs, path(`${kind}/${id}`)), { reportCount: increment(1) });
  batch.set(doc(fs, path(`${kind}/${id}/reports/${uid}`)), { uid, targetCreatedAt: incarnation, submittedAt: serverTimestamp() });
  batch.set(doc(fs, path(`reportRateLimits/${uid}`)), { kind, targetId: id, submittedAt: serverTimestamp() });
  return batch;
}
beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({ projectId: 'demo-report-admission', firestore: { host, port: Number(port), rules: readFileSync('firestore.rules', 'utf8') } });
});
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, path('')), { admins: ['admin'], status: 'active', bannedUids: ['banned'], settings: { reportHideThreshold: 2 } });
    for (const kind of ['items', 'proofs']) {
      await setDoc(doc(fs, path(`${kind}/target`)), { uid: 'owner', createdBy: 'owner', createdAt: 100, status: 'active', reportCount: 0 });
      await setDoc(doc(fs, path(`${kind}/other`)), { uid: 'owner', createdBy: 'owner', createdAt: 200, status: 'active', reportCount: 0 });
    }
  });
});

describe('rules-paired reports per reporter and target incarnation', () => {
  it.each(['items', 'proofs'])('denies direct %s increments and counts distinct reporters once', async (kind) => {
    await assertFails(updateDoc(doc(db('alice'), path(`${kind}/target`)), { reportCount: increment(1) }));
    await assertSucceeds(submission(db('alice'), 'alice', kind).commit());
    await assertFails(submission(db('alice'), 'alice', kind).commit());
    await assertSucceeds(submission(db('bob'), 'bob', kind).commit());
    expect((await getDoc(doc(db('admin'), path(`${kind}/target`)))).data()?.reportCount).toBe(2);
  });
  it('accepts a player Proof create but denies forged report-hide suppression', async () => {
    const fs = db('owner');
    const proof = { uid: 'owner', displayName: 'Owner', photoURL: null, type: 'text',
      cellIndex: 4, itemText: 'Dance', storagePath: null, mediaURL: null,
      thumbURL: null, text: 'A caption', createdAt: Date.now(), reportCount: 0,
      status: 'active', visionFlag: null, source: null, dayIndex: 0 };
    await assertSucceeds(setDoc(doc(fs, path('proofs/valid-proof')), proof));
    await assertFails(setDoc(doc(fs, path('proofs/forged-proof')), { ...proof, reportHideSuppressed: true }));
    expect((await getDoc(doc(db('admin'), path('proofs/valid-proof')))).data()?.reportHideSuppressed).toBeUndefined();
    expect((await getDoc(doc(db('admin'), path('proofs/forged-proof')))).exists()).toBe(false);
  });
  it('denies banned reporters even when membership admission is off', async () => {
    await assertFails(submission(db('banned'), 'banned').commit());
    await assertFails(updateDoc(doc(db('banned'), path('items/target')), { reportCount: 1 }));
  });
  it('denies missing/forged receipts, detached rate fences and receipt deletion', async () => {
    await assertFails(setDoc(doc(db('alice'), path('items/target/reports/alice')), { uid: 'alice', targetCreatedAt: 100, submittedAt: serverTimestamp() }));
    await assertFails(submission(db('alice'), 'alice', 'items', 'target', 99).commit());
    await assertFails(submission(db('alice'), 'bob').commit());
    await assertFails(setDoc(doc(db('alice'), path('reportRateLimits/alice')), { kind: 'items', targetId: 'target', submittedAt: serverTimestamp() }));
    await assertSucceeds(submission(db('alice'), 'alice').commit());
    const fs = db('alice');
    const batch = writeBatch(fs);
    batch.delete(doc(fs, path('items/target/reports/alice')));
    await assertFails(batch.commit());
  });
  it('enforces the 3-second server-clock cadence across different targets and collections', async () => {
    await assertSucceeds(submission(db('alice'), 'alice').commit());
    await assertFails(submission(db('alice'), 'alice', 'proofs', 'other', 200).commit());
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), path('reportRateLimits/alice')), { submittedAt: Timestamp.fromMillis(Date.now() - 3_100) });
    });
    await assertSucceeds(submission(db('alice'), 'alice', 'proofs', 'other', 200).commit());
  });
  it('does not let one paired receipt/rate authorize multiple counter increments', async () => {
    const fs = db('alice');
    const batch = submission(fs, 'alice');
    batch.update(doc(fs, path('items/other')), { reportCount: increment(1) });
    batch.set(doc(fs, path('items/other/reports/alice')), { uid: 'alice', targetCreatedAt: 200, submittedAt: serverTimestamp() });
    await assertFails(batch.commit());
  });
  it('permits the same reporter only when the target is recreated with a new incarnation', async () => {
    await assertSucceeds(submission(db('alice'), 'alice').commit());
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path('items/target')), { createdAt: 101, status: 'active', reportCount: 0 });
      await updateDoc(doc(ctx.firestore(), path('reportRateLimits/alice')), { submittedAt: Timestamp.fromMillis(Date.now() - 3_100) });
    });
    await assertFails(submission(db('alice'), 'alice').commit());
    await assertSucceeds(submission(db('alice'), 'alice', 'items', 'target', 101).commit());
    await assertFails(submission(db('alice'), 'alice', 'items', 'target', 101).commit());
  });
  it('preserves admin suppression while new distinct reports remain visible to admins', async () => {
    const admin = db('admin');
    await updateDoc(doc(admin, path('items/target')), { reportHideSuppressed: true });
    await assertSucceeds(submission(db('alice'), 'alice').commit());
    expect((await getDoc(doc(admin, path('items/target')))).data()).toMatchObject({ reportCount: 1, reportHideSuppressed: true });
    await assertSucceeds(getDoc(doc(admin, path('items/target/reports/alice'))));
    await assertFails(updateDoc(doc(db('alice'), path('items/target')), { reportHideSuppressed: false }));
  });
  it('denies reports during an Event freeze and across Events with enforced membership', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), path('')), { archiving: true }); });
    await assertFails(submission(db('alice'), 'alice').commit());
    await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), path('')), { archiving: false, membershipEnforcement: 'enforced' }); });
    await assertFails(submission(db('alice'), 'alice').commit());
  });
});
