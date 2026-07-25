import { afterAll, describe, expect, it, vi } from 'vitest';
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
  setDoc,
  getDocFromCache,
  getDocFromServer,
  disableNetwork,
  waitForPendingWrites,
  terminate,
  type Firestore,
} from 'firebase/firestore';
import { setMark } from '../../src/data/api';
import type { Cell } from '../../src/types';
import { cellsToMap, cellsFromData } from '../../src/game/cells';
import { runScopedEmail, runScopedProject } from './runScope';

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
const PROJECT_ID = runScopedProject('demo-echo-marks'); // distinct project → isolated data
const EMAIL = runScopedEmail('echo');
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

async function signIn(auth: Auth) {
  try {
    return await signInWithEmailAndPassword(auth, EMAIL, PASSWORD);
  } catch {
    return await createUserWithEmailAndPassword(auth, EMAIL, PASSWORD);
  }
}

type Client = { app: FirebaseApp; db: Firestore; uid: string };

async function makeClient(name: string): Promise<Client> {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT_ID }, name);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
  const cred = await signIn(auth);
  const db = initializeFirestore(app, { localCache: persistentLocalCache() });
  connectFirestoreEmulator(db, ...firestoreEmulator());
  return { app, db, uid: cred.user.uid };
}

async function makeObserver(): Promise<Client> {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT_ID }, 'gcb-echo-observer');
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
  const cred = await signIn(auth);
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
});
