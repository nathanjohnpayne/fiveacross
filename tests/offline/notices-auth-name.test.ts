import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it, expect } from 'vitest';
import { initializeTestEnvironment, assertSucceeds } from '@firebase/rules-unit-testing';
import { initializeApp as initializeClientApp, deleteApp as deleteClientApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithCredential, signInWithCustomToken } from 'firebase/auth';
import { initializeApp as initializeAdminApp, deleteApp as deleteAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { runScopedProject, runScopedEmail } from './runScope';
import { connectFirestoreEmulator, getFirestore, doc, setDoc } from 'firebase/firestore';

// specs/admin-messages.md #1426: use real Auth-issued ID tokens rather than
// rules-unit-testing custom claims to verify the Google → custom-token seam.
// This belongs to the existing Auth+Firestore emulator layer; test:rules only
// starts Firestore/Storage. It performs no production Auth or data operation.
const EVENT = 'cruise';
const noticePath = (id: string) => `events/${EVENT}/notices/${id}`;
const notice = (uid: string, fields: Record<string, unknown>) => ({
  uid, title: 'Notice', body: 'Token identity', pinned: true, createdAt: Date.now(), ...fields,
});
const RULES_PATH = resolve(process.cwd(), 'firestore.rules');

it('real Google sign-in and same-UID custom-token handoff retain the token name accepted by Notice Rules', async () => {
  const projectId = runScopedProject('demo-notice-auth-name');
  const [firestoreHost, firestorePort] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
  if (!/^127\.0\.0\.1:\d+$/.test(authHost)) throw new Error('local Auth emulator required');
  const priorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
  const testEnv = await initializeTestEnvironment({ projectId, firestore: {
    host: firestoreHost, port: Number(firestorePort), rules: readFileSync(RULES_PATH, 'utf8'),
  } });
  const apps = ['google-notice', 'handoff-notice'].map(name => initializeClientApp({ apiKey: 'fixture', projectId }, name));
  const server = initializeAdminApp({ projectId }, 'notice-handoff-fixture');
  try {
    const clients = apps.map(app => {
      const auth = getAuth(app); connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
      const firestore = getFirestore(app); connectFirestoreEmulator(firestore, firestoreHost, Number(firestorePort));
      return { auth, firestore };
    });
    const google = [{ alg: 'none', typ: 'JWT' }, { sub: 'google-notice-account', aud: 'fixture-google-client',
      iss: 'https://accounts.google.com', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
      email: runScopedEmail('notice-admin'), email_verified: true, name: 'Google Notice Admin' }]
      .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.';
    const signedIn = await signInWithCredential(clients[0].auth, GoogleAuthProvider.credential(google));
    const name = (await signedIn.user.getIdTokenResult()).claims.name;
    expect(name).toBe('Google Notice Admin');
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), `events/${EVENT}`), { admins: [signedIn.user.uid], status: 'active' });
    });
    await assertSucceeds(setDoc(doc(clients[0].firestore, noticePath('google')), notice(signedIn.user.uid, { displayName: name })));
    // The deployed handoff adapter creates a token for this UID without adding
    // caller-supplied names; prove the actual Auth SDK's resulting ID claim.
    const customToken = await getAdminAuth(server).createCustomToken(signedIn.user.uid);
    const handedOff = await signInWithCustomToken(clients[1].auth, customToken);
    expect(handedOff.user.uid).toBe(signedIn.user.uid);
    expect((await handedOff.user.getIdTokenResult()).claims.name).toBe(name);
    await assertSucceeds(setDoc(doc(clients[1].firestore, noticePath('handoff')), notice(handedOff.user.uid, { displayName: name })));
  } finally {
    await Promise.all(apps.map(deleteClientApp));
    await deleteAdminApp(server);
    await testEnv.cleanup();
    if (priorHost === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST = priorHost;
  }
});
