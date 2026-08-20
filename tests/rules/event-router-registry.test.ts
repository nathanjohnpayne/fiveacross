import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const RULES = readFileSync(RULES_PATH, 'utf8');
const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const endpoint = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [host, port] = endpoint.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gcb-event-router-registry',
    firestore: { host, port: Number(port), rules: RULES },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, `routerReplicas/${HOST}`), { schemaVersion: 1, revision: '1' });
    await setDoc(doc(db, `routerRehearsals/${HOST}`), { class: 'route', reservedAt: 1 });
    await setDoc(doc(db, 'events/event-1'), { admins: ['admin'] });
  });
});

afterAll(async () => testEnv?.cleanup());

describe('private Event-router control-plane collections', () => {
  it('carry explicit deny-all match blocks in the deployed rules', () => {
    expect(RULES).toMatch(/match \/routerReplicas\/\{host\}[\s\S]*?allow read, write: if false;/);
    expect(RULES).toMatch(/match \/routerRehearsals\/\{host\}[\s\S]*?allow read, write: if false;/);
  });

  it.each(['anonymous', 'player', 'event admin'])('%s cannot get or list either collection', async (actor) => {
    const db =
      actor === 'anonymous'
        ? testEnv.unauthenticatedContext().firestore()
        : testEnv.authenticatedContext(actor === 'event admin' ? 'admin' : 'player').firestore();
    for (const name of ['routerReplicas', 'routerRehearsals']) {
      await assertFails(getDoc(doc(db, `${name}/${HOST}`)));
      await assertFails(getDocs(collection(db, name)));
    }
  });

  it.each(['anonymous', 'player', 'event admin'])('%s cannot create, update, or delete either collection', async (actor) => {
    const db =
      actor === 'anonymous'
        ? testEnv.unauthenticatedContext().firestore()
        : testEnv.authenticatedContext(actor === 'event admin' ? 'admin' : 'player').firestore();
    for (const name of ['routerReplicas', 'routerRehearsals']) {
      const ref = doc(db, `${name}/${HOST}`);
      await assertFails(setDoc(doc(db, `${name}/new-${HOST}`), { forged: true }));
      await assertFails(updateDoc(ref, { forged: true }));
      await assertFails(deleteDoc(ref));
    }
  });
});
