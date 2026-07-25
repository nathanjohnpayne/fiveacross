import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';

// setMark reaches the production firebase singleton for its DEFAULT `db`;
// stub it out like the sibling offline suites (same EVENT_ID).
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
  doc,
  onSnapshot,
  setDoc,
  getDocFromCache,
  getDocFromServer,
  disableNetwork,
  waitForPendingWrites,
  terminate,
  type Firestore,
} from 'firebase/firestore';
import { setMark } from '../../src/data/api';
import {
  __resetBoardFreshnessForTests,
  beginDayBoardSeedWatch,
  recordDayBoardSeedSnapshot,
  trustedDayBoardSeed,
} from '../../src/data/board-freshness';
import type { Cell } from '../../src/types';
import { cellsToMap, cellsFromData } from '../../src/game/cells';

// ------------------------------------------------------ specs/echo-marks.md ---
// The OFFLINE half of Echo Marks (ADR 0006): a Mark made in a ship-wifi dead
// zone whose echoes ride the SAME durable batch. Against the real emulators
// (rules loaded — the DAY-SCOPED board paths, unlike the legacy-path sibling
// suites): deal two Day Cards sharing a Prompt online, go OFFLINE, mark the
// shared Prompt on Day 0 through the real setMark, terminate the client BEFORE
// any sync, show the server still lacks BOTH the Mark and its echo, "reload"
// (same app name + uid), and watch the recovered queue drain the Mark, the
// Day-1 echo (its own markSeed), and the ONE aggregated player write together.

const EVENT_ID = 'med-2026'; // must match the mocked src/firebase EVENT_ID
const PROJECT_ID = 'demo-echo-marks'; // distinct project → isolated data
const EMAIL = 'echo@offline.test';
const PASSWORD = 'passw0rd!';
const TAB_APP_NAME = 'gcb-echo-tab';
// The shared Prompt sits at index 3 on Day 0 and index 8 on Day 1.
const SHARED = 'shared-prompt';
const MARK_INDEX = 3;

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

async function signIn(auth: Auth, email = EMAIL) {
  try {
    return await signInWithEmailAndPassword(auth, email, PASSWORD);
  } catch {
    return await createUserWithEmailAndPassword(auth, email, PASSWORD);
  }
}

type Client = { app: FirebaseApp; db: Firestore; uid: string };

async function makeClient(name: string, email = EMAIL): Promise<Client> {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT_ID }, name);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
  const cred = await signIn(auth, email);
  const db = initializeFirestore(app, { localCache: persistentLocalCache() });
  connectFirestoreEmulator(db, ...firestoreEmulator());
  return { app, db, uid: cred.user.uid };
}

async function makeObserver(name = 'gcb-echo-observer', email = EMAIL): Promise<Client> {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT_ID }, name);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
  const cred = await signIn(auth, email);
  const db = initializeFirestore(app, {});
  connectFirestoreEmulator(db, ...firestoreEmulator());
  return { app, db, uid: cred.user.uid };
}

/**
 * Seed the EVENT doc through the emulator's rules-bypassing REST endpoint
 * (`Bearer owner`). The day-board write gate reads
 * `events/{id}.days[dayIndex].unlockAt`, but a CLIENT can never create the
 * event doc itself — the create rule reads the (nonexistent) doc's own
 * `admins`, which errors and denies — so the schedule has to be planted the
 * way production does: out-of-band.
 */
async function seedEventDoc(): Promise<void> {
  const [hostname, port] = firestoreEmulator();
  const int = (n: number) => ({ integerValue: String(n) });
  const str = (s: string) => ({ stringValue: s });
  const bool = (b: boolean) => ({ booleanValue: b });
  const dayVal = (index: number) => ({
    mapValue: {
      fields: { index: int(index), unlockAt: int(Date.now() - 3_600_000), pool: str('main'), tutorial: bool(false) },
    },
  });
  const res = await fetch(
    `http://${hostname}:${port}/v1/projects/${PROJECT_ID}/databases/(default)/documents/events/${EVENT_ID}`,
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          name: str('Cruise'),
          status: str('active'),
          admins: { arrayValue: { values: [] } },
          days: { arrayValue: { values: [dayVal(0), dayVal(1)] } },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`event seed failed: ${res.status} ${await res.text()}`);
}

/** A dealt Day Card whose cell at `sharedIndex` carries the SHARED Prompt. */
function dayCard(uid: string, dayIndex: number, seed: number, sharedIndex: number) {
  const cells: Cell[] = Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : index === sharedIndex ? SHARED : `d${dayIndex}-item-${index}`,
    text: index === 12 ? 'FREE' : `prompt ${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
  return { uid, dayIndex, seed, createdAt: Date.now(), cells };
}

/**
 * #474: latch mark-time echo trust the way the production `useMyDayBoards`
 * fan does — a live watch feeding the seed-freshness registry from real
 * snapshots (`includeMetadataChanges` so the server-committed confirmation of
 * byte-identical cached data still notifies). Returns a teardown fn.
 */
function watchDayBoardSeed(dbx: Firestore, dayIndex: number, uid: string): () => void {
  const release = beginDayBoardSeedWatch(dayIndex, uid);
  const unsub = onSnapshot(
    doc(dbx, `events/${EVENT_ID}/days/${dayIndex}/boards/${uid}`),
    { includeMetadataChanges: true },
    (snap) => recordDayBoardSeedSnapshot(dayIndex, uid, snap),
  );
  return () => {
    release();
    unsub();
  };
}

/** Poll until the registry trusts `seed` for the board (listener delivery is async). */
async function untilTrustedSeed(dayIndex: number, uid: string, seed: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const trust = trustedDayBoardSeed(dayIndex, uid);
    if (trust.trusted && trust.seed === seed) return;
    if (Date.now() > deadline) throw new Error(`trust for seed ${seed} never arrived`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Rules-bypassing server-side write: PATCH one field of a day board (the "other device" reshuffle). */
async function serverPatchBoardSeed(uid: string, dayIndex: number, seed: number): Promise<void> {
  const [hostname, port] = firestoreEmulator();
  const res = await fetch(
    `http://${hostname}:${port}/v1/projects/${PROJECT_ID}/databases/(default)/documents/events/${EVENT_ID}/days/${dayIndex}/boards/${uid}?updateMask.fieldPaths=seed`,
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { seed: { integerValue: String(seed) } } }),
    },
  );
  if (!res.ok) throw new Error(`board seed patch failed: ${res.status} ${await res.text()}`);
}

beforeEach(() => __resetBoardFreshnessForTests());

afterAll(async () => {
  await Promise.all(apps.map((a) => deleteApp(a).catch(() => {})));
});

describe('offline Echo Marks via setMark (specs/echo-marks.md + ADR 0006)', () => {
  it('queues the Mark + its Day-1 echo + the ONE aggregated player write offline, and drains them together on reload', async () => {
    await seedEventDoc();
    const tab = await makeClient(TAB_APP_NAME);
    const day0Path = `events/${EVENT_ID}/days/0/boards/${tab.uid}`;
    const day1Path = `events/${EVENT_ID}/days/1/boards/${tab.uid}`;
    const playerPath = `events/${EVENT_ID}/players/${tab.uid}`;

    // 0. Deal both Day Cards + the player row ONLINE and let them sync — the
    //    offline echo is an UPDATE to existing day-scoped docs, the production
    //    sequence (and the rules' unlock gate needs the seeded schedule above).
    const day0 = dayCard(tab.uid, 0, 100, MARK_INDEX);
    // #457 wire shape: seeds write the cells MAP; the app-side array stays in
    // `day0.cells` for the setMark fold under test.
    await setDoc(doc(tab.db, day0Path), { ...day0, cells: cellsToMap(day0.cells) });
    const day1 = dayCard(tab.uid, 1, 111, 8);
    await setDoc(doc(tab.db, day1Path), { ...day1, cells: cellsToMap(day1.cells) });
    await setDoc(doc(tab.db, playerPath), {
      uid: tab.uid,
      displayName: 'Echo Tester',
      photoURL: null,
      joinedAt: Date.now(),
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      blackout: false,
      reshufflesUsed: 0,
    });
    await waitForPendingWrites(tab.db);

    // 0b. #474: the mark-time echo only trusts a sibling seed a live,
    //     server-committed snapshot has confirmed — mount the production
    //     `useMyDayBoards` fan's equivalent and wait for the latch BEFORE the
    //     dead zone. The latch survives going offline (spec § Residuals).
    const stopWatch = watchDayBoardSeed(tab.db, 1, tab.uid);
    await untilTrustedSeed(1, tab.uid, 111);

    // 1. Ship-wifi dead zone.
    await disableNetwork(tab.db);

    // 2. Mark the shared Prompt on Day 0 through the REAL write path, echo
    //    days included. The batch queues durably; the local cache reflects the
    //    Day-1 echo immediately (latency compensation).
    await setMark({
      uid: tab.uid,
      cells: day0.cells,
      index: MARK_INDEX,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      displayName: 'Echo Tester',
      dayIndex: 0,
      daily: true,
      boardSeed: 100,
      echoDayIndexes: [0, 1],
      database: tab.db,
    });
    // The latency-compensated LOCAL truth: both the Mark and its Day-1 echo
    // are in the persistent cache before any sync. (A cache point read, not an
    // onSnapshot wait — the node/jsdom SDK build does not reliably deliver
    // listener snapshots while the network is disabled.)
    const localDay1 = await getDocFromCache(doc(tab.db, day1Path));
    const localEcho = cellsFromData((localDay1.data() as { cells?: unknown }).cells).find((c) => c.index === 8)!;
    expect(localEcho).toMatchObject({ itemId: SHARED, marked: true, status: 'confirmed', echo: true });

    // 3. Kill the tab BEFORE any sync (terminate + deleteApp, so the "reload"
    //    below constructs a genuinely fresh client over the SAME IndexedDB
    //    store). The server must still lack both writes.
    stopWatch();
    await terminate(tab.db);
    await deleteApp(tab.app);
    const observer = await makeObserver();
    const serverDay1 = await getDocFromServer(doc(observer.db, day1Path));
    expect(cellsFromData((serverDay1.data() as { cells?: unknown }).cells).some((c) => c.echo === true)).toBe(false);

    // 4. "Reload": the same app name re-opens the same IndexedDB store, same
    //    uid recovers the same mutation queue, which drains online — Mark,
    //    echo, and player write land together (one batch, atomic on the
    //    server).
    const reloaded = await makeClient(TAB_APP_NAME);
    await waitForPendingWrites(reloaded.db);

    const drainedDay1 = await getDocFromServer(doc(observer.db, day1Path));
    const echoed = cellsFromData((drainedDay1.data() as { cells?: unknown }).cells).find((c) => c.index === 8)!;
    expect(echoed).toMatchObject({ itemId: SHARED, marked: true, status: 'confirmed', echo: true });
    // The echoed board write carried ITS OWN markSeed (111) — the rules
    // accepted it, and the stored doc proves it.
    expect((drainedDay1.data() as { markSeed?: number }).markSeed).toBe(111);
    const drainedDay0 = await getDocFromServer(doc(observer.db, day0Path));
    expect(cellsFromData((drainedDay0.data() as { cells?: unknown }).cells)[MARK_INDEX]).toMatchObject({
      marked: true,
      status: 'confirmed',
    });

    // The ONE aggregated player write: both Day buckets + the re-summed root.
    const player = await getDocFromServer(doc(observer.db, playerPath));
    const stats = player.data() as {
      squaresMarked: number;
      dayStats: Record<number, { squaresMarked: number }>;
    };
    expect(stats.squaresMarked).toBe(2);
    expect(stats.dayStats[0].squaresMarked).toBe(1);
    expect(stats.dayStats[1].squaresMarked).toBe(1);

    await terminate(reloaded.db);
  }, 60000);

  it('#474 REGRESSION: a sibling reshuffled server-side while stale-cached is SKIPPED — the acted Mark COMMITS instead of the whole batch denying', async () => {
    await seedEventDoc();
    const email = 'echo-stale@offline.test';
    const tab = await makeClient('gcb-echo-stale-tab', email);
    const day0Path = `events/${EVENT_ID}/days/0/boards/${tab.uid}`;
    const day1Path = `events/${EVENT_ID}/days/1/boards/${tab.uid}`;
    const playerPath = `events/${EVENT_ID}/players/${tab.uid}`;

    // Deal both cards + the player row online; the persistent cache now holds
    // the Day-1 sibling at seed 111.
    const day0 = dayCard(tab.uid, 0, 100, MARK_INDEX);
    await setDoc(doc(tab.db, day0Path), { ...day0, cells: cellsToMap(day0.cells) });
    const day1 = dayCard(tab.uid, 1, 111, 8);
    await setDoc(doc(tab.db, day1Path), { ...day1, cells: cellsToMap(day1.cells) });
    await setDoc(doc(tab.db, playerPath), {
      uid: tab.uid,
      displayName: 'Stale Tester',
      photoURL: null,
      joinedAt: Date.now(),
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      blackout: false,
      reshufflesUsed: 0,
    });
    await waitForPendingWrites(tab.db);

    // The "other device" reshuffles Day 1: the SERVER seed moves 111 → 222
    // while THIS device keeps the old card in cache and — the poison setup —
    // has NO live watch on the sibling (nothing subscribed it).
    await serverPatchBoardSeed(tab.uid, 1, 222);

    // Mark the shared Prompt on Day 0 through the real write path. Pre-#474
    // this queued a Day-1 echo stamped markSeed 111, `seededMarkGuard` denied
    // it, and the WHOLE batch — the acted Mark included — rolled back.
    await setMark({
      uid: tab.uid,
      cells: day0.cells,
      index: MARK_INDEX,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      displayName: 'Stale Tester',
      dayIndex: 0,
      daily: true,
      boardSeed: 100,
      echoDayIndexes: [0, 1],
      database: tab.db,
    });
    await waitForPendingWrites(tab.db);

    const reader = await makeObserver('gcb-echo-stale-reader', email);
    // The acted Mark COMMITTED — the regression signal (a poisoned batch
    // would have left this cell unmarked on the server).
    const day0Snap = await getDocFromServer(doc(reader.db, day0Path));
    expect(cellsFromData((day0Snap.data() as { cells?: unknown }).cells)[MARK_INDEX]).toMatchObject({
      marked: true,
      status: 'confirmed',
    });
    // The untrusted sibling was skipped: no echo, no markSeed stamp, and the
    // other device's reshuffled seed stands. (Its next open reconciles.)
    const day1Snap = await getDocFromServer(doc(reader.db, day1Path));
    const day1Data = day1Snap.data() as { cells?: unknown; seed?: number; markSeed?: number };
    expect(day1Data.seed).toBe(222);
    expect(day1Data.markSeed).toBeUndefined();
    expect(cellsFromData(day1Data.cells).some((c) => c.echo === true)).toBe(false);
    // The aggregated player write folded the acted bucket ONLY.
    const player = await getDocFromServer(doc(reader.db, playerPath));
    const stats = player.data() as {
      squaresMarked: number;
      dayStats: Record<number, { squaresMarked: number }>;
    };
    expect(stats.squaresMarked).toBe(1);
    expect(stats.dayStats[0].squaresMarked).toBe(1);
    expect(stats.dayStats[1]).toBeUndefined();

    await terminate(tab.db);
  }, 60000);

  it('#474 inverse: a LIVE-watched sibling stays echo-eligible — trust re-latches onto the server reshuffle and the echo commits', async () => {
    await seedEventDoc();
    const email = 'echo-live@offline.test';
    const tab = await makeClient('gcb-echo-live-tab', email);
    const day0Path = `events/${EVENT_ID}/days/0/boards/${tab.uid}`;
    const day1Path = `events/${EVENT_ID}/days/1/boards/${tab.uid}`;
    const playerPath = `events/${EVENT_ID}/players/${tab.uid}`;

    const day0 = dayCard(tab.uid, 0, 100, MARK_INDEX);
    await setDoc(doc(tab.db, day0Path), { ...day0, cells: cellsToMap(day0.cells) });
    const day1 = dayCard(tab.uid, 1, 111, 8);
    await setDoc(doc(tab.db, day1Path), { ...day1, cells: cellsToMap(day1.cells) });
    await setDoc(doc(tab.db, playerPath), {
      uid: tab.uid,
      displayName: 'Live Tester',
      photoURL: null,
      joinedAt: Date.now(),
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      blackout: false,
      reshufflesUsed: 0,
    });
    await waitForPendingWrites(tab.db);

    // The live watch (the production fan's equivalent) latches trust at 111,
    // then the "other device" reshuffles — the SAME vector as the regression
    // above, but this time the watch both re-latches trust onto 333 AND syncs
    // the cache, so the echo rides with the CURRENT seed.
    const stopWatch = watchDayBoardSeed(tab.db, 1, tab.uid);
    await untilTrustedSeed(1, tab.uid, 111);
    await serverPatchBoardSeed(tab.uid, 1, 333);
    await untilTrustedSeed(1, tab.uid, 333);

    await setMark({
      uid: tab.uid,
      cells: day0.cells,
      index: MARK_INDEX,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      displayName: 'Live Tester',
      dayIndex: 0,
      daily: true,
      boardSeed: 100,
      echoDayIndexes: [0, 1],
      database: tab.db,
    });
    await waitForPendingWrites(tab.db);
    stopWatch();

    const reader = await makeObserver('gcb-echo-live-reader', email);
    const day1Snap = await getDocFromServer(doc(reader.db, day1Path));
    const day1Data = day1Snap.data() as { cells?: unknown; markSeed?: number };
    const echoed = cellsFromData(day1Data.cells).find((c) => c.index === 8)!;
    expect(echoed).toMatchObject({ itemId: SHARED, marked: true, status: 'confirmed', echo: true });
    expect(day1Data.markSeed).toBe(333); // the CURRENT seed — rules-accepted
    const player = await getDocFromServer(doc(reader.db, playerPath));
    expect((player.data() as { squaresMarked: number }).squaresMarked).toBe(2);

    await terminate(tab.db);
  }, 60000);
});
