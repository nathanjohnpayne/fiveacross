import { readFileSync } from 'node:fs';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { submitPromptCore } from '../../functions/src/submitPrompt';

// Actual Admin SDK transactions: cap and fence are source behavior; this dark
// PR deliberately retains the current client pending-create Rules until cutover.
const projectId = 'demo-fiveacross-prompt-admission';
const EVENT = 'event'; const UID = 'player'; const NOW = 1_770_000_000_000;
let env: RulesTestEnvironment; let app: App; let db: Firestore;
const base = `events/${EVENT}`;
const submit = (id: string, uid = UID) => submitPromptCore({ db, now: () => NOW }, uid, { eventId: EVENT, itemId: id, text: 'Dance', spicy: false });
async function seedPending(count: number, uid = UID) {
  const batch = db.batch();
  for (let n = 0; n < count; n++) batch.set(db.doc(`${base}/items/${uid}-${n}`), { createdBy: uid, status: 'pending', text: 'Existing', pool: 'main', createdAt: NOW - 1000 });
  await batch.commit();
}
const pending = (uid = UID) => db.collection(`${base}/items`).where('createdBy', '==', uid).where('status', '==', 'pending').get();
beforeAll(async () => {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  env = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules: readFileSync('firestore.rules', 'utf8') } });
  app = initializeApp({ projectId }, `prompt-admission-${process.pid}`); db = getFirestore(app);
});
afterAll(async () => { await deleteApp(app); await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await db.doc(base).set({ status: 'active', days: [{ index: 0, pool: 'main', unlockAt: NOW - 1 }, { index: 2, pool: 'main', unlockAt: NOW + 1 }] });
});

describe('server Community Prompt intake', () => {
  it('server-stamps new pending content/default target and increments only the per-player fence', async () => {
    expect(await submit('new')).toEqual({ id: 'new', targetDayIndex: 2 });
    expect((await db.doc(`${base}/items/new`).get()).data()).toEqual({ text: 'Dance', createdBy: UID, createdAt: NOW, isFreeSpace: false, status: 'pending', reportCount: 0, spicy: false, pool: 'main', targetDayIndex: 2 });
    expect((await db.doc(`${base}/promptQuota/${UID}`).get()).data()).toEqual({ seq: 1 });
    expect((await db.doc(base).get()).data()).not.toHaveProperty('approvalSeq');
  });
  it.each([9, 10, 13])('admits only below ten and retains a preexisting %i-row queue', async count => {
    await seedPending(count);
    if (count < 10) await submit('new');
    else await expect(submit('new')).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect((await pending()).size).toBe(count < 10 ? 10 : count);
    expect((await db.doc(`${base}/items/${UID}-0`).get()).data()?.text).toBe('Existing');
  });
  it.each(['active', 'rejected'])('review status %s frees live capacity without a decrement/backfill', async status => {
    await seedPending(10); await db.doc(`${base}/items/${UID}-0`).update({ status });
    await submit('replacement'); expect((await pending()).size).toBe(10);
  });
  it('two concurrent final-slot submissions cannot exceed the cap', async () => {
    await seedPending(9);
    const results = await Promise.allSettled([submit('a'), submit('b')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'resource-exhausted' } });
    expect((await pending()).size).toBe(10);
    expect((await db.doc(`${base}/promptQuota/${UID}`).get()).data()?.seq).toBe(1);
  });
  it('same-ID concurrent/lost-response retries preserve the original row and fence', async () => {
    const [a, b] = await Promise.all([submit('same'), submit('same')]); expect(a).toEqual(b);
    await seedPending(9); await db.doc(`${base}/items/same`).update({ status: 'active', text: 'Admin edit', targetDayIndex: 3 });
    expect(await submit('same')).toEqual({ id: 'same', targetDayIndex: 3 });
    expect((await db.doc(`${base}/items/same`).get()).data()).toMatchObject({ status: 'active', text: 'Admin edit', createdAt: NOW });
    expect((await db.doc(`${base}/promptQuota/${UID}`).get()).data()?.seq).toBe(1);
  });
  it('different players have independent capacity; a foreign ID cannot be overwritten', async () => {
    await seedPending(10); await submit('new', 'other');
    await expect(submit('new')).rejects.toMatchObject({ code: 'already-exists' });
    expect((await db.doc(`${base}/items/new`).get()).data()?.createdBy).toBe('other');
  });
  it.each([{ status: 'archived' }, { archiving: true }])('closed Event refuses without item/fence writes %j', async patch => {
    await db.doc(base).update(patch); await expect(submit('new')).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await db.doc(`${base}/items/new`).get()).exists).toBe(false);
    expect((await db.doc(`${base}/promptQuota/${UID}`).get()).exists).toBe(false);
  });
  it.each([{ status: 'archived' }, { archiving: true }])('acknowledges an owned lost-response retry after closure without writes %j', async patch => {
    const before = await submit('same');
    const original = (await db.doc(`${base}/items/same`).get()).data();
    await db.doc(base).update(patch);
    expect(await submit('same')).toEqual(before);
    expect((await db.doc(`${base}/items/same`).get()).data()).toEqual(original);
    expect((await db.doc(`${base}/promptQuota/${UID}`).get()).data()?.seq).toBe(1);
    await expect(submit('different')).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await db.doc(`${base}/items/different`).get()).exists).toBe(false);
  });
  it('enforced membership must be currently active in the transaction', async () => {
    await db.doc(base).update({ membershipEnforcement: 'enforced' });
    await expect(submit('new')).rejects.toMatchObject({ code: 'permission-denied' });
    await db.doc(`${base}/memberships/${UID}`).set({ status: 'revoked' });
    await expect(submit('new')).rejects.toMatchObject({ code: 'permission-denied' });
    await db.doc(`${base}/memberships/${UID}`).update({ status: 'active' }); await submit('new');
  });
  it('scheduleless Events preserve untargeted legacy behavior', async () => {
    await db.doc(base).set({ status: 'active' }); expect(await submit('new')).toEqual({ id: 'new' });
    expect((await db.doc(`${base}/items/new`).get()).data()).not.toHaveProperty('targetDayIndex');
  });
  it('malformed fence state and server clock fail closed without persisting content', async () => {
    await db.doc(`${base}/promptQuota/${UID}`).set({ seq: 'bad' });
    await expect(submit('new')).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await db.doc(`${base}/items/new`).get()).exists).toBe(false);
    await db.doc(`${base}/promptQuota/${UID}`).delete();
    await expect(submitPromptCore({ db, now: () => NaN }, UID, { eventId: EVENT, itemId: 'new', text: 'Dance', spicy: false })).rejects.toMatchObject({ code: 'internal' });
    expect((await db.doc(`${base}/items/new`).get()).exists).toBe(false);
  });
});
