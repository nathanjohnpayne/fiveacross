import { afterAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator, createUserWithEmailAndPassword, inMemoryPersistence,
  initializeAuth, getAuth, getIdToken, signOut, updateCurrentUser, type Auth,
} from 'firebase/auth';
import {
  collection, connectFirestoreEmulator, disableNetwork, doc, enableNetwork, getDocFromCache,
  getDocFromServer, getDocsFromServer, initializeFirestore, memoryLocalCache, onSnapshot, query,
  persistentLocalCache, setDoc, terminate, waitForPendingWrites, where, writeBatch, type Firestore,
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

  it('a real same-UID token refresh keeps the memory client, listener and captured action alive', async () => {
    const primary = client('token-lifetime-primary');
    const user = (await createUserWithEmailAndPassword(primary.auth, runScopedEmail('token-lifetime'), 'passw0rd!')).user;
    await seedPrivateMembership(user.uid);
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
    const manager = createPrivateFirestoreSessions({ primaryAuth: primary.auth, options, recovered: () => true, online: () => true,
      emulator: { authUrl: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}`, firestoreHost: host, firestorePort: Number(port) },
    });
    let unsubscribe = () => {};
    try {
      await vi.waitFor(() => expect(manager.getSnapshot().db).not.toBeNull(), { timeout: 5000 });
      const before = manager.getSnapshot(); const lease = manager.capture();
      const path = `events/${eventId}/memberships/${user.uid}`;
      const snapshots: Array<{ fromCache: boolean; hasPendingWrites: boolean }> = [];
      unsubscribe = onSnapshot(doc(lease.db, path), { includeMetadataChanges: true }, (snapshot) => {
        snapshots.push({ ...snapshot.metadata });
      });
      await vi.waitFor(() => expect(snapshots.some((snapshot) => !snapshot.fromCache)).toBe(true), { timeout: 5000 });
      const oldToken = await getIdToken(user);
      // The emulator JWT iat is second-granular. Ensure force refresh changes
      // its bytes, so this is an actual onIdTokenChanged event, not a no-op.
      await new Promise<void>((resolve) => setTimeout(resolve, 1100));
      const refreshedToken = await getIdToken(user, true);
      expect(refreshedToken).not.toBe(oldToken);
      await vi.waitFor(async () => {
        expect(await getIdToken(getAuth(lease.db.app).currentUser!)).toBe(refreshedToken);
      }, { timeout: 5000 });
      expect(manager.getSnapshot()).toBe(before); expect(manager.capture().db).toBe(lease.db);
      expect(() => lease.assertCurrent()).not.toThrow();
      expect((await lease.guard(() => getDocFromServer(doc(lease.db, path)))).exists()).toBe(true);
      // Confirmed listeners survive a healthy credential-stream restart.
      const after = snapshots.slice(snapshots.findIndex((snapshot) => !snapshot.fromCache));
      expect(after.every((snapshot) => !snapshot.fromCache)).toBe(true);
      await signOut(primary.auth);
      expect(() => lease.assertCurrent()).toThrow('expired');
    } finally { unsubscribe(); manager.stop(); }
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

  it('a reloaded durable block batch can still be pending while a named memory client sees an empty server pair set', async () => {
    await seedEventDoc(projectId, eventId);
    const primary = client('durable-block-reload', true);
    const user = (await createUserWithEmailAndPassword(primary.auth, runScopedEmail('queued-block'), 'passw0rd!')).user;
    const target = 'queued-block-target';
    const uids = [user.uid, target].sort();
    const directionPath = `events/${eventId}/blocks/${user.uid}_${target}`;
    const pairPath = `events/${eventId}/blockPairs/${uids[0]}_${uids[1]}`;
    await disableNetwork(primary.db);
    // The real blind write shape from blockPlayer: no private payload read or
    // persisted UI hint is needed to queue the reciprocal atomic batch.
    const batch = writeBatch(primary.db);
    batch.set(doc(primary.db, directionPath), { ownerUid: user.uid, targetUid: target, eventId, createdAt: Date.now() });
    batch.set(doc(primary.db, pairPath), { uids, eventId });
    void batch.commit().catch(() => {});
    // SDK shutdown follows the queued write on its own async queue; no block
    // cache read is used as an acknowledgement or recovery-readiness signal.
    await terminate(primary.db); await deleteApp(primary.app);

    const reloaded = client('durable-block-reload', true);
    await disableNetwork(reloaded.db);
    await updateCurrentUser(reloaded.auth, user);
    const observer = client('block-server-observer');
    await updateCurrentUser(observer.auth, user);
    const pairs = (db: Firestore) => query(collection(db, `events/${eventId}/blockPairs`), where('uids', 'array-contains', user.uid));
    expect((await getDocsFromServer(pairs(observer.db))).empty).toBe(true);
    let drained = false;
    const drain = waitForPendingWrites(reloaded.db).then(() => { drained = true; });
    // A confirmed empty memory snapshot is not proof that the independent
    // durable client's queue has drained. Keep that client's transport offline.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(drained).toBe(false);
    expect((await getDocsFromServer(pairs(observer.db))).empty).toBe(true);
    expect(drained).toBe(false);

    await enableNetwork(reloaded.db);
    await drain;
    expect(drained).toBe(true);
    const fresh = client('block-fresh-server-observer');
    await updateCurrentUser(fresh.auth, user);
    const committed = await getDocsFromServer(pairs(fresh.db));
    expect(committed.docs.map((row) => row.id)).toEqual([`${uids[0]}_${uids[1]}`]);
    expect(committed.docs[0].data()).toEqual({ uids, eventId });
    expect((await getDocFromServer(doc(fresh.db, directionPath))).data()).toMatchObject({ ownerUid: user.uid, targetUid: target, eventId });
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
