import { afterAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator, createUserWithEmailAndPassword, inMemoryPersistence,
  initializeAuth, signOut, updateCurrentUser, type Auth,
} from 'firebase/auth';
import {
  connectFirestoreEmulator, disableNetwork, doc, getDocFromCache,
  getDocFromServer, initializeFirestore, memoryLocalCache, onSnapshot,
  persistentLocalCache, setDoc, terminate, waitForPendingWrites, type Firestore,
} from 'firebase/firestore';
import { cellsFromData, cellsToMap } from '../../src/game/cells';
import { createPrivateFirestoreSessions } from '../../src/auth/privateFirestoreSession';
import { runScopedEmail, runScopedProject } from './runScope';
import { seedEventDoc } from './seedEvent';

// #1411 feasibility gate: exercise PUBLIC SDK APIs with independent named apps,
// real emulator authorization and the existing durable mutation-queue harness.
// This does not implement or claim legacy-cache cleanup.
const projectId = runScopedProject('demo-private-cache');
const options = { apiKey: 'demo-api-key', projectId };
const clients: { app: FirebaseApp; db: Firestore; auth: Auth }[] = [];
const eventId = 'private-cache-event';

function client(name: string, persistent = false) {
  const app = initializeApp(options, name);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}`, { disableWarnings: true });
  const db = initializeFirestore(app, { localCache: persistent ? persistentLocalCache() : memoryLocalCache() });
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  connectFirestoreEmulator(db, host, Number(port));
  const result = { app, auth, db };
  clients.push(result);
  return result;
}

async function seedPrivateMembership(uid: string) {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const res = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents/events/${eventId}/memberships/${uid}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { privateLabel: { stringValue: `secret-${uid}` } } }),
  });
  if (!res.ok) throw new Error(`membership fixture failed: ${res.status}`);
}

async function pending(db: Firestore, path: string) {
  await new Promise<void>((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => { unsub(); reject(new Error('pending write timeout')); }, 15000);
    unsub = onSnapshot(doc(db, path), { includeMetadataChanges: true }, (snap) => {
      if (!snap.metadata.hasPendingWrites) return;
      clearTimeout(timer); unsub(); resolve();
    }, reject);
  });
}

afterAll(async () => {
  await Promise.all(clients.map(async ({ app, db }) => {
    await terminate(db).catch(() => {});
    await deleteApp(app).catch(() => {});
  }));
});

describe('private-cache named-app Auth feasibility (#1411)', () => {
  it('clones the primary session, enforces owner access and drops secondary Auth on reload', async () => {
    const primary = client('primary-auth');
    const privateClient = client('private-memory');
    const a = (await createUserWithEmailAndPassword(primary.auth, runScopedEmail('a'), 'passw0rd!')).user;
    await seedPrivateMembership(a.uid);
    const aPath = `events/${eventId}/memberships/${a.uid}`;
    expect(privateClient.auth.currentUser).toBeNull();
    await expect(getDocFromServer(doc(privateClient.db, aPath))).rejects.toMatchObject({ code: 'permission-denied' });

    await updateCurrentUser(privateClient.auth, a);
    expect(privateClient.auth.currentUser?.uid).toBe(a.uid);
    expect(primary.auth.currentUser?.uid).toBe(a.uid);
    expect((await getDocFromServer(doc(privateClient.db, aPath))).data()?.privateLabel).toBe(`secret-${a.uid}`);

    const b = (await createUserWithEmailAndPassword(primary.auth, runScopedEmail('b'), 'passw0rd!')).user;
    await seedPrivateMembership(b.uid);
    await updateCurrentUser(privateClient.auth, b);
    await expect(getDocFromServer(doc(privateClient.db, aPath))).rejects.toMatchObject({ code: 'permission-denied' });
    // Auth switching alone does NOT remove this app's memory cache. The full
    // implementation must retire the named app whenever the subject changes.
    expect((await getDocFromCache(doc(privateClient.db, aPath))).data()?.privateLabel).toBe(`secret-${a.uid}`);
    expect((await getDocFromServer(doc(privateClient.db, `events/${eventId}/memberships/${b.uid}`))).exists()).toBe(true);

    await updateCurrentUser(privateClient.auth, null);
    expect(primary.auth.currentUser?.uid).toBe(b.uid);
    await expect(getDocFromServer(doc(privateClient.db, aPath))).rejects.toMatchObject({ code: 'permission-denied' });
    await terminate(privateClient.db); await deleteApp(privateClient.app);
    const reloaded = client('private-memory');
    await reloaded.auth.authStateReady();
    expect(reloaded.auth.currentUser).toBeNull();
    await expect(getDocFromCache(doc(reloaded.db, aPath))).rejects.toMatchObject({ code: 'unavailable' });
    await signOut(primary.auth);
  });

  it('the shipped session manager isolates account caches and fences late actions and offline access', async () => {
    const primary = client('managed-primary');
    const a = (await createUserWithEmailAndPassword(primary.auth, runScopedEmail('managed-a'), 'passw0rd!')).user;
    await seedPrivateMembership(a.uid);
    let recovered = false;
    let online = true;
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
    const manager = createPrivateFirestoreSessions({ primaryAuth: primary.auth, options,
      recovered: () => recovered, online: () => online,
      emulator: { authUrl: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}`, firestoreHost: host, firestorePort: Number(port) },
    });
    const ready = async (uid: string) => {
      await vi.waitFor(() => { expect(manager.getSnapshot().uid).toBe(uid); expect(manager.getSnapshot().db).not.toBeNull(); }, { timeout: 5000 });
    };
    try {
      await ready(a.uid);
      expect(() => manager.capture()).toThrow('recovery');
      // Auth bootstrap can recover this account's Marks using a memory-only
      // own-profile read while legacy private/Admin UI stays quarantined.
      const recoveryLease = manager.capture(true);
      const aPath = `events/${eventId}/memberships/${a.uid}`;
      expect((await recoveryLease.guard(() => getDocFromServer(doc(recoveryLease.db, aPath)))).exists()).toBe(true);
      recovered = true; manager.refreshRecovery(); await ready(a.uid);
      const aLease = manager.capture();
      const aAppName = aLease.db.app.name;
      await aLease.guard(() => getDocFromServer(doc(aLease.db, aPath)));
      let resolveLate: (value: string) => void = () => {};
      const late = aLease.guard(() => new Promise<string>(resolve => { resolveLate = resolve; }));
      const b = (await createUserWithEmailAndPassword(primary.auth, runScopedEmail('managed-b'), 'passw0rd!')).user;
      resolveLate('secret');
      await expect(late).rejects.toThrow('expired');
      await ready(b.uid);
      const bLease = manager.capture();
      expect(bLease.db.app.name).not.toBe(aAppName);
      await expect(getDocFromCache(doc(bLease.db, aPath))).rejects.toMatchObject({ code: 'unavailable' });
      const forbiddenAction = vi.fn(async () => 'never');
      await expect(aLease.guard(forbiddenAction)).rejects.toThrow('expired');
      expect(forbiddenAction).not.toHaveBeenCalled();
      online = false; manager.refreshConnection();
      expect(manager.getSnapshot().db).toBeNull();
      expect(() => bLease.assertCurrent()).toThrow('expired');
      online = true; manager.refreshConnection(); await ready(b.uid);
      const reconnected = manager.capture();
      expect(reconnected.generation).not.toBe(bLease.generation);
      await signOut(primary.auth);
      expect(manager.getSnapshot().db).toBeNull();
      expect(() => reconnected.assertCurrent()).toThrow('expired');
    } finally { manager.stop(); }
  });

  it('keeps an offline primary Mark recoverable while the private app is retired', async () => {
    await seedEventDoc(projectId, eventId);
    const primary = client('durable-gameplay', true);
    const user = (await createUserWithEmailAndPassword(primary.auth, runScopedEmail('mark'), 'passw0rd!')).user;
    const privateClient = client('mark-private-memory');
    await updateCurrentUser(privateClient.auth, user);
    const path = `events/${eventId}/days/0/boards/${user.uid}`;
    await disableNetwork(primary.db);
    setDoc(doc(primary.db, path), {
      uid: user.uid, dayIndex: 0, seed: 42, createdAt: Date.now(),
      cells: cellsToMap(Array.from({ length: 25 }, (_, index) => ({
        index, itemId: index === 12 ? null : `item-${index}`, text: index === 12 ? 'FREE' : `prompt ${index}`,
        free: index === 12, marked: index === 7, markedAt: index === 7 ? Date.now() : null,
      }))),
    }).catch(() => {});
    await pending(primary.db, path);
    await updateCurrentUser(privateClient.auth, null);
    await terminate(privateClient.db); await deleteApp(privateClient.app);
    await terminate(primary.db); await deleteApp(primary.app);
    const reloaded = client('durable-gameplay', true);
    await updateCurrentUser(reloaded.auth, user);
    await waitForPendingWrites(reloaded.db);
    const snap = await getDocFromServer(doc(reloaded.db, path));
    expect(snap.metadata.hasPendingWrites).toBe(false);
    expect(cellsFromData(snap.data()?.cells)[7].marked).toBe(true);
  });

  it('does not mistake the active-user drain for a safe all-user legacy-cache purge', async () => {
    await seedEventDoc(projectId, eventId);
    const legacy = client('legacy-multi-user', true);
    const first = (await createUserWithEmailAndPassword(legacy.auth, runScopedEmail('legacy-a'), 'passw0rd!')).user;
    const second = (await createUserWithEmailAndPassword(legacy.auth, runScopedEmail('legacy-b'), 'passw0rd!')).user;
    // The SDK's IndexedDB highest-batch query has an upper user-key bound.
    // Put the queued account above the empty account so the fixture proves an
    // excluded other-user queue rather than depending on random UID ordering.
    // IndexedDB string ordering is code-unit ordering, not locale ordering.
    const queuedUser = first.uid > second.uid ? first : second;
    const emptyUser = first.uid > second.uid ? second : first;
    await updateCurrentUser(legacy.auth, queuedUser);
    const path = `events/${eventId}/days/0/boards/${queuedUser.uid}`;
    await disableNetwork(legacy.db);
    setDoc(doc(legacy.db, path), {
      uid: queuedUser.uid, dayIndex: 0, seed: 42, createdAt: Date.now(),
      cells: cellsToMap(Array.from({ length: 25 }, (_, index) => ({
        index, itemId: index === 12 ? null : `item-${index}`, text: index === 12 ? 'FREE' : `prompt ${index}`,
        free: index === 12, marked: index === 9, markedAt: index === 9 ? Date.now() : null,
      }))),
    }).catch(() => {});
    await pending(legacy.db, path);
    await updateCurrentUser(legacy.auth, emptyUser);
    expect(emptyUser.uid).not.toBe(queuedUser.uid);
    // Let Firestore's Auth listener move its queue to B before asking it to
    // drain. A's pending overlay disappears from this active-user snapshot.
    await new Promise<void>((resolve, reject) => {
      let unsub = () => {};
      const timer = setTimeout(() => { unsub(); reject(new Error('Firestore user change timeout')); }, 15000);
      unsub = onSnapshot(doc(legacy.db, path), { includeMetadataChanges: true }, (snap) => {
        if (snap.metadata.hasPendingWrites) return;
        clearTimeout(timer); unsub(); resolve();
      }, reject);
    });
    // This resolves despite A's unsynced Mark. Clearing persistence now would
    // erase A's queue together with historical sensitive documents.
    await waitForPendingWrites(legacy.db);
    await terminate(legacy.db); await deleteApp(legacy.app);
    const recovered = client('legacy-multi-user', true);
    await updateCurrentUser(recovered.auth, queuedUser);
    await waitForPendingWrites(recovered.db);
    expect(cellsFromData((await getDocFromServer(doc(recovered.db, path))).data()?.cells)[9].marked).toBe(true);
  });
});
