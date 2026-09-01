import { afterAll, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';

// specs/w2-tally.md, offline layer (ADR 0002 + ADR 0006). The per-Prompt Tally
// rides the offline-queueable Mark path: setMark writes the attributed marker in
// the SAME batch as the board + player, so a Mark made in a ship-wifi dead zone
// queues durably and — on reconnect — publishes WHO marked the Prompt to the
// server. This drives the REAL setMark against the Firestore + Auth emulators
// (real IndexedDB via fake-indexeddb, see setup.ts): deal online, go OFFLINE,
// Mark through setMark, reconnect, and prove the attributed marker reached the
// Tally with NOTHING posted to the Feed (a bare Mark). Then unmark and prove the
// entry is removed. setMark reaches the prod firebase singleton for its default
// `db`, whose getAuth() throws without a real env, so stub the module (same
// EVENT_ID) — the test injects its own emulator-backed `database`.
// The Board lives at the Phase 1.5 DAY-SCOPED path
// events/{eventId}/days/{dayIndex}/boards/{uid} — the legacy
// events/{eventId}/boards/{uid} match no longer exists in firestore.rules —
// so setMark runs in `daily` mode and the event's `days[]` schedule (whose
// `unlockAt` gates every day-board write) is seeded out-of-band first (see
// seedEvent.ts).
//   firebase emulators:exec --only auth,firestore \
//     "vitest run --config vitest.offline.config.ts"
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
  disableNetwork,
  enableNetwork,
  waitForPendingWrites,
  type Firestore,
} from 'firebase/firestore';
import { setMark } from '../../src/data/api';
import type { BoardDoc, Cell, PlayerDoc, TallyEntry } from '../../src/types';
import { seedEventDoc } from './seedEvent';
import { runScopedEmail, runScopedProject } from './runScope';
import { cellsToMap, cellsFromData, type CellsMap } from '../../src/game/cells';

const EVENT_ID = 'med-2026'; // must match src/firebase.ts default (setMark reads it)
const PROJECT_ID = runScopedProject('demo-w2-tally'); // distinct project → isolated data
const EMAIL = runScopedEmail('tally');
const PASSWORD = 'passw0rd!';
const MARKED_CELL = 7; // a normal (non-free) Square; the free centre never tallies
const ITEM_ID = `item-${MARKED_CELL}`;
const DISPLAY_NAME = 'Marker McMarkface';

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

// The Player's tab: persistentLocalCache so the offline Mark queues durably.
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

// An independent observer (memory cache): what it reads from the server is
// ground truth about what actually synced — and marker reads are public (ADR 0002).
async function makeObserver(): Promise<Client> {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT_ID }, 'gcb-tally-observer');
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
  const cred = await signIn(auth);
  const db = initializeFirestore(app, {});
  connectFirestoreEmulator(db, ...firestoreEmulator());
  return { app, db, uid: cred.user.uid };
}

// The WIRE shape a seed writes (#457): BoardDoc with map-keyed cells.
function unmarkedBoard(uid: string): Omit<BoardDoc, 'cells'> & { cells: CellsMap } {
  const cells: Cell[] = Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `item-${index}`,
    text: index === 12 ? 'FREE' : `prompt ${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
  return { uid, dayIndex: 0, seed: 42, createdAt: Date.now(), cells: cellsToMap(cells) };
}

function freshPlayer(uid: string): PlayerDoc {
  return {
    uid,
    displayName: DISPLAY_NAME,
    photoURL: null,
    joinedAt: Date.now(),
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    blackout: false,
  };
}

afterAll(async () => {
  await Promise.all(apps.map((a) => deleteApp(a).catch(() => {})));
});

describe('w2 offline Tally marker via setMark (ADR 0002 + ADR 0006)', () => {
  it('queues an attributed marker offline, drains it to the Tally on reconnect, then unmark removes it — no Feed write', async () => {
    await seedEventDoc(PROJECT_ID, EVENT_ID);
    const tab = await makeClient('gcb-tally-tab');
    const boardPath = `events/${EVENT_ID}/days/0/boards/${tab.uid}`;
    const playerPath = `events/${EVENT_ID}/players/${tab.uid}`;
    const markerPath = `events/${EVENT_ID}/tally/${ITEM_ID}/markers/${tab.uid}`;

    // Deal the Board + Player ONLINE and sync (the offline Mark is then an update).
    await setDoc(doc(tab.db, boardPath), unmarkedBoard(tab.uid));
    await setDoc(doc(tab.db, playerPath), freshPlayer(tab.uid));
    await waitForPendingWrites(tab.db);

    // OFFLINE: Mark a Square through the real write path with a resolved name.
    await disableNetwork(tab.db);
    await setMark({
      uid: tab.uid,
      cells: unmarkedBoard(tab.uid).cells,
      index: MARKED_CELL,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      displayName: DISPLAY_NAME,
      dayIndex: 0,
      daily: true,
      boardSeed: 42,
      database: tab.db,
    });

    // Reconnect and let the queued batch drain.
    await enableNetwork(tab.db);
    await waitForPendingWrites(tab.db);

    // The attributed marker reached the server — every Mark publishes WHO got it.
    const observer = await makeObserver();
    const marker = await getDocFromServer(doc(observer.db, markerPath));
    expect(marker.exists()).toBe(true);
    const entry = marker.data() as TallyEntry;
    expect(entry.uid).toBe(tab.uid);
    expect(entry.eventId).toBe(EVENT_ID);
    expect(entry.displayName).toBe(DISPLAY_NAME); // no anonymity (ADR 0002)
    expect(typeof entry.markedAt).toBe('number');

    // A bare Mark posts NOTHING to the Feed (ADR 0002): moments stays empty.
    const moments = await getDocs(collection(observer.db, 'events', EVENT_ID, 'moments'));
    expect(moments.empty).toBe(true);

    // Unmarking removes exactly that Player's entry (mirrors the cell toggle).
    await setMark({
      uid: tab.uid,
      cells: unmarkedBoard(tab.uid).cells,
      index: MARKED_CELL,
      nextMarked: false,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      displayName: DISPLAY_NAME,
      dayIndex: 0,
      daily: true,
      boardSeed: 42,
      database: tab.db,
    });
    await waitForPendingWrites(tab.db);

    const afterUnmark = await getDocFromServer(doc(observer.db, markerPath));
    expect(afterUnmark.exists()).toBe(false);
  });
});
