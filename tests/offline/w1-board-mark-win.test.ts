import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';

// setMark reaches the production firebase singleton for its DEFAULT `db`, whose
// module-load `getAuth()` throws `auth/invalid-api-key` without a real
// VITE_FIREBASE_* env (absent in this emulator run). This suite never uses that
// singleton — it injects its own emulator-backed `database` into setMark — so we
// stub the module out (keeping the same EVENT_ID) rather than boot a prod app.
vi.mock('../../src/firebase', () => ({ db: {}, EVENT_ID: 'med-2026' }));
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  type Auth,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  connectFirestoreEmulator,
  collection,
  doc,
  setDoc,
  getDocs,
  getDocFromServer,
  onSnapshot,
  disableNetwork,
  enableNetwork,
  waitForPendingWrites,
  terminate,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase/firestore';
import { setMark } from '../../src/data/api';
import type { BoardDoc, Cell, PlayerDoc } from '../../src/types';
import { seedEventDoc } from './seedEvent';
import { runScopedEmail, runScopedProject } from './runScope';
import { cellsToMap, cellsFromData } from '../../src/game/cells';

// ---------------------------------------------------------- ADR 0006 + 0002 ---
// The MARK half of the offline proof. Where `w0-offline-persistence` proves the
// persistent-cache primitive with a raw `setDoc`, THIS drives the REAL
// production Mark write path — Board.doMark -> setMark — to prove it is
// offline-durable. setMark had to stop using `runTransaction` (which needs a
// server round-trip and REJECTS offline) and switch to a plain batched write
// the persistent local cache can queue. The proof, against the Firestore + Auth
// emulators with real IndexedDB semantics via fake-indexeddb (see setup.ts):
// deal a Board online, go OFFLINE, Mark a Square through `setMark`, terminate
// the client BEFORE any sync, show the server still lacks the Mark, "reload"
// (same app name + uid), and watch the recovered queue drain the Mark AND the
// denormalized Player stats to Firestore — with NOTHING posted to the Feed
// (moments), per ADR 0002.
//
// Reverting setMark to a `runTransaction` makes this suite fail at the offline
// Mark: the transaction rejects instead of queuing. A second test below drives
// two real setMark calls back-to-back off one stale snapshot to prove the
// `getDocFromCache` fold — not the caller's `cells` prop — is what the second
// write actually lands on; reverting that fold to the caller's-`cells`-only
// version fails it (the first Mark comes back unmarked, clobbered by the
// second write's full-array replacement). Run it (app tests are not CI-run):
//   firebase emulators:exec --only auth,firestore \
//     "vitest run --config vitest.offline.config.ts"
//
// The Board lives at the Phase 1.5 DAY-SCOPED path
// events/{eventId}/days/{dayIndex}/boards/{uid} — the legacy
// events/{eventId}/boards/{uid} match no longer exists in firestore.rules —
// so setMark runs in `daily` mode and the event's `days[]` schedule (whose
// `unlockAt` gates every day-board write) is seeded out-of-band first (see
// seedEvent.ts).

const EVENT_ID = 'med-2026'; // must match src/firebase.ts default (setMark reads it)
const PROJECT_ID = runScopedProject('demo-mark-win'); // distinct from w0's project → isolated data
const EMAIL = runScopedEmail('marker');
const PASSWORD = 'passw0rd!';
// A normal (non-free) Square: index 12 is the Free Space center, which the real
// Board UI refuses to toggle — marking it would be an unreachable scenario.
const MARKED_CELL = 7;
// Reusing this exact name for the post-"reload" client re-opens the same
// IndexedDB persistence store.
const TAB_APP_NAME = 'gcb-mark-tab';
// A second, independent app name for the rapid-double-Mark race proof below,
// so its persistent-cache store never collides with the reload proof's.
const RACE_TAB_APP_NAME = 'gcb-mark-tab-race';

function firestoreEmulator(): [string, number] {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  return [hostname, Number(port)];
}

function authEmulatorUrl(): string {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
  return host.startsWith('http') ? host : `http://${host}`;
}

const apps: FirebaseApp[] = [];

// Stable uid across "reloads": the first client creates the account, later
// clients sign back in to the SAME uid (the emulator keys accounts on email).
// The uid is load-bearing twice: firestore.rules isOwner() gates the board/
// player paths, and the SDK's persisted mutation queue is recovered per-user.
async function signIn(auth: Auth) {
  try {
    return await signInWithEmailAndPassword(auth, EMAIL, PASSWORD);
  } catch {
    return await createUserWithEmailAndPassword(auth, EMAIL, PASSWORD);
  }
}

type Client = { app: FirebaseApp; db: Firestore; uid: string };

// One emulator-backed client on the same persistentLocalCache as src/firebase.ts
// (DEFAULT single-tab manager — the node build hard-disables multi-tab; the
// durable-queue property under test is tab-manager-orthogonal, and
// src/firebase.test.ts pins the production multi-tab config). Each call models
// one app load of the same installed PWA.
// `projectId` is parameterizable because the RACE tests below each run in
// their OWN emulator project: the emulator's rules engine has a cumulative
// per-project expression-budget leak (later evaluations in one project can
// spuriously report "maximum of 1000 expressions ... reached" once several
// board-write evaluations have accumulated — observed after the day-board
// rule grew the Echo Marks version/seed guards on #447; a test that fails in
// a shared project passes byte-identically in a fresh one). Per-test project
// isolation is the same containment the suite already uses per FILE.
async function makeClient(name: string, projectId: string = PROJECT_ID): Promise<Client> {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId }, name);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
  const cred = await signIn(auth);
  const db = initializeFirestore(app, { localCache: persistentLocalCache() });
  connectFirestoreEmulator(db, ...firestoreEmulator());
  return { app, db, uid: cred.user.uid };
}

// An independent observer with the DEFAULT (memory) cache and its own app name:
// it shares no local state with the tab clients, so what it reads from the
// server is ground truth about what actually synced.
async function makeObserver(): Promise<Client> {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT_ID }, 'gcb-mark-observer');
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
  const cred = await signIn(auth);
  const db = initializeFirestore(app, {});
  connectFirestoreEmulator(db, ...firestoreEmulator());
  return { app, db, uid: cred.user.uid };
}

// Resolve on the first snapshot matching `predicate`, then unsubscribe. Used to
// observe the local offline write, whose batch.commit() promise intentionally
// does not resolve until a server ack.
function waitForSnapshot(
  ref: DocumentReference,
  predicate: (snap: DocumentSnapshot) => boolean,
  timeoutMs = 15000,
): Promise<DocumentSnapshot> {
  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('snapshot predicate not met in time'));
    }, timeoutMs);
    unsub = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        if (predicate(snap)) {
          clearTimeout(timer);
          unsub();
          resolve(snap);
        }
      },
      (err) => {
        clearTimeout(timer);
        unsub();
        reject(err);
      },
    );
  });
}

// A dealt, fully UNMARKED board (only the free center is "on"). The Mark under
// test is applied later, offline, through setMark.
function unmarkedBoard(uid: string): BoardDoc {
  const cells: Cell[] = Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `item-${index}`,
    text: index === 12 ? 'FREE' : `prompt ${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
  // `markSeed` (== seed) makes the re-seed in the two race tests below pass the
  // rules: every test in this file signs in as the SAME uid (the emulator keys
  // accounts on email), so their seeding setDoc REWRITES the day-board doc the
  // reload test already marked — a cells-changing write to a seeded Board,
  // which `seededMarkWriteOk` denies unless it carries markSeed == the stored
  // seed. On the very first create the field is inert.
  return { uid, dayIndex: 0, seed: 42, markSeed: 42, createdAt: Date.now(), cells };
}

function freshPlayer(uid: string): PlayerDoc {
  return {
    uid,
    displayName: 'Marker',
    photoURL: null,
    joinedAt: Date.now(),
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    blackout: false,
  };
}

beforeAll(async () => {
  await seedEventDoc(PROJECT_ID, EVENT_ID);
});

afterAll(async () => {
  await Promise.all(apps.map((a) => deleteApp(a).catch(() => {})));
});

describe('w1 offline Mark via setMark (ADR 0006 + ADR 0002)', () => {
  it('queues an offline Mark across a reload, then syncs the Mark + stats with no Feed write', async () => {
    const tab = await makeClient(TAB_APP_NAME);
    const boardPath = `events/${EVENT_ID}/days/0/boards/${tab.uid}`;
    const playerPath = `events/${EVENT_ID}/players/${tab.uid}`;
    const boardRef = doc(tab.db, boardPath);

    // 0. Deal the Board + Player ONLINE (the first-ever join needs connectivity,
    //    ADR 0006) and let both sync, so the offline Mark is an UPDATE to
    //    existing docs — the production sequence.
    await setDoc(boardRef, { ...unmarkedBoard(tab.uid), cells: cellsToMap(unmarkedBoard(tab.uid).cells) });
    await setDoc(doc(tab.db, playerPath), freshPlayer(tab.uid));
    await waitForPendingWrites(tab.db);

    // 1. Go offline — a ship-wifi dead zone.
    await disableNetwork(tab.db);

    // 2. Mark a Square offline through the REAL write path. setMark fires the
    //    batched write without awaiting the server ack (it lands in the
    //    persistent cache now) and returns the locally-computed win result.
    const res = await setMark({
      uid: tab.uid,
      cells: unmarkedBoard(tab.uid).cells,
      index: MARKED_CELL,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      dayIndex: 0,
      daily: true,
      boardSeed: 42,
      database: tab.db,
    });
    expect(res.bingo).toBe(false);

    // 3. The Mark is present locally and flagged as an unsynced pending write.
    const queued = await waitForSnapshot(
      boardRef,
      (snap) =>
        snap.exists() &&
        snap.metadata.hasPendingWrites &&
        cellsFromData(((snap.data() as unknown) as { cells?: unknown }).cells)[MARKED_CELL]?.marked === true,
    );
    expect(queued.metadata.fromCache).toBe(true);

    // 4. The "reload": kill the tab WHILE STILL OFFLINE, before any sync. The
    //    Mark now exists nowhere except the persisted local queue.
    await terminate(tab.db);
    await deleteApp(tab.app);

    // 5. Ground truth via an independent observer: the seeded Board is on the
    //    server, but the offline Mark did NOT sync — the Square is still false.
    const observer = await makeObserver();
    const beforeRecovery = await getDocFromServer(doc(observer.db, boardPath));
    expect(beforeRecovery.exists()).toBe(true);
    expect(cellsFromData(((beforeRecovery.data() as unknown) as { cells?: unknown }).cells)[MARKED_CELL].marked).toBe(false);

    // 6. Bring the "reloaded" tab up: same app name -> same IndexedDB store,
    //    same uid -> same recovered mutation queue, which drains online.
    const reloaded = await makeClient(TAB_APP_NAME);
    await waitForPendingWrites(reloaded.db);

    // 7. The Mark survived the reload and synced: the Square is marked AND the
    //    denormalized Player stats followed, server-side (fresh, not cached).
    const syncedBoard = await getDocFromServer(doc(reloaded.db, boardPath));
    expect(syncedBoard.metadata.hasPendingWrites).toBe(false);
    expect(cellsFromData(((syncedBoard.data() as unknown) as { cells?: unknown }).cells)[MARKED_CELL].marked).toBe(true);

    const observedBoard = await getDocFromServer(doc(observer.db, boardPath));
    expect(cellsFromData(((observedBoard.data() as unknown) as { cells?: unknown }).cells)[MARKED_CELL].marked).toBe(true);
    const observedPlayer = await getDocFromServer(doc(observer.db, playerPath));
    expect((observedPlayer.data() as PlayerDoc).squaresMarked).toBe(1);
    expect((observedPlayer.data() as PlayerDoc).bingoCount).toBe(0);

    // 8. A bare Mark posts NOTHING to the Feed (ADR 0002): no Moment was written.
    const moments = await getDocs(collection(observer.db, 'events', EVENT_ID, 'moments'));
    expect(moments.empty).toBe(true);
  });

  // ------------------------------------------------------------- concurrency -
  // Two Marks issued back-to-back off the SAME pre-listener-echo snapshot —
  // exactly what Board.tsx passes on two fast taps, since its `cells` closure
  // only advances once the onSnapshot listener re-renders it with the prior
  // Mark. Neither call here awaits a listener update between them. Before the
  // `getDocFromCache` fold-onto-freshest-local-state fix, the second write's
  // full-array `cells` replacement silently clobbered the first Mark (proven
  // by temporarily reverting this behavior — see the unit-level sibling test
  // in `src/data/w1-board-mark-win.test.ts`, which fails the same way against
  // the pre-fix code).
  it('two Marks fired back-to-back off the same stale snapshot both survive (no clobber)', async () => {
    const raceProject = `${PROJECT_ID}-race`;
    await seedEventDoc(raceProject, EVENT_ID);
    const tab = await makeClient(RACE_TAB_APP_NAME, raceProject);
    const boardPath = `events/${EVENT_ID}/days/0/boards/${tab.uid}`;
    const playerPath = `events/${EVENT_ID}/players/${tab.uid}`;
    const boardRef = doc(tab.db, boardPath);

    await setDoc(boardRef, { ...unmarkedBoard(tab.uid), cells: cellsToMap(unmarkedBoard(tab.uid).cells) });
    await setDoc(doc(tab.db, playerPath), freshPlayer(tab.uid));
    await waitForPendingWrites(tab.db);

    await disableNetwork(tab.db);

    const staleSnapshot = unmarkedBoard(tab.uid).cells;
    await setMark({
      uid: tab.uid,
      cells: staleSnapshot,
      index: 3,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      dayIndex: 0,
      daily: true,
      boardSeed: 42,
      database: tab.db,
    });
    // Still the ORIGINAL stale snapshot -- not the first call's result -- just
    // like Board.tsx's render closure would be if its listener has not yet
    // echoed the first Mark back.
    await setMark({
      uid: tab.uid,
      cells: staleSnapshot,
      index: 9,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      dayIndex: 0,
      daily: true,
      boardSeed: 42,
      database: tab.db,
    });

    // `waitForPendingWrites` needs a backend ack, so it must not be called
    // while still offline (it would hang) — reconnect first, then wait.
    await enableNetwork(tab.db);
    await waitForPendingWrites(tab.db);

    const synced = await getDocFromServer(boardRef);
    expect(cellsFromData(((synced.data() as unknown) as { cells?: unknown }).cells)[3].marked).toBe(true);
    expect(cellsFromData(((synced.data() as unknown) as { cells?: unknown }).cells)[9].marked).toBe(true);
    const player = await getDocFromServer(doc(tab.db, playerPath));
    expect((player.data() as PlayerDoc).squaresMarked).toBe(2);
  });

  // Harder than back-to-back: OVERLAPPING calls, neither awaited before the
  // other starts — exactly what Board.toggle produces, since doMark is
  // fire-and-forget. Without the per-board serialization chain (Codex P1,
  // PR #75), both calls pass getDocFromCache before either has issued its
  // batch, fold onto the same cached board, and the later commit clobbers the
  // earlier Mark even WITH the cache fold in place.
  it('two OVERLAPPING unawaited Marks both survive (per-board serialization)', async () => {
    const overlapProject = `${PROJECT_ID}-overlap`;
    await seedEventDoc(overlapProject, EVENT_ID);
    const tab = await makeClient('gcb-mark-overlap-tab', overlapProject);
    const boardPath = `events/${EVENT_ID}/days/0/boards/${tab.uid}`;
    const playerPath = `events/${EVENT_ID}/players/${tab.uid}`;
    const boardRef = doc(tab.db, boardPath);

    await setDoc(boardRef, { ...unmarkedBoard(tab.uid), cells: cellsToMap(unmarkedBoard(tab.uid).cells) });
    await setDoc(doc(tab.db, playerPath), freshPlayer(tab.uid));
    await waitForPendingWrites(tab.db);

    await disableNetwork(tab.db);

    const staleSnapshot = unmarkedBoard(tab.uid).cells;
    const common = {
      uid: tab.uid,
      cells: staleSnapshot,
      nextMarked: true,
      claimMode: 'honor' as const,
      currentFirstBingoAt: null,
      dayIndex: 0,
      daily: true,
      boardSeed: 42,
      database: tab.db,
    };
    await Promise.all([
      setMark({ ...common, index: 5 }),
      setMark({ ...common, index: 11 }),
    ]);

    await enableNetwork(tab.db);
    await waitForPendingWrites(tab.db);

    const synced = await getDocFromServer(boardRef);
    expect(cellsFromData(((synced.data() as unknown) as { cells?: unknown }).cells)[5].marked).toBe(true);
    expect(cellsFromData(((synced.data() as unknown) as { cells?: unknown }).cells)[11].marked).toBe(true);
    const player = await getDocFromServer(doc(tab.db, playerPath));
    expect((player.data() as PlayerDoc).squaresMarked).toBe(2);
  });
});
