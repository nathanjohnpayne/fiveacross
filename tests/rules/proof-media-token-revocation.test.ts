import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';

let env: RulesTestEnvironment;
beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-proof-media-token-revocation',
    firestore: { host, port: Number(port), rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'proofMediaTokenSweeps/run'), { status: 'pending' });
    await setDoc(doc(context.firestore(), 'events/A'), { admins: ['admin'] });
  });
});
afterAll(async () => { await env?.cleanup(); });

describe('proof-media sweep progress stays server-only', () => {
  for (const uid of [null, 'alice', 'admin']) {
    it(`denies reads and writes by ${uid ?? 'anonymous callers'}`, async () => {
      const context = uid === null ? env.unauthenticatedContext() : env.authenticatedContext(uid);
      const target = doc(context.firestore(), 'proofMediaTokenSweeps/run');
      await assertFails(getDoc(target));
      await assertFails(setDoc(target, { status: 'complete' }));
      await assertFails(deleteDoc(target));
    });
  }
});
