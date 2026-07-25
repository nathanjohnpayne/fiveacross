import { afterAll, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';

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
  getDoc,
  getDocFromServer,
  disableNetwork,
  enableNetwork,
  waitForPendingWrites,
  type Firestore,
} from 'firebase/firestore';
import { setMark } from '../../src/data/api';
import { cellsToMap, cellsFromData } from '../../src/game/cells';
import type { Cell, PlayerDoc } from '../../src/types';
import { seedEventDoc } from './seedEvent';
import { runScopedEmail, runScopedProject } from './runScope';

// ------------------------------------------------------- specs/cells-map.md ---
// THE test the #457 schema exists for: two DEVICES of the same account, each
// folding from its own (mutually stale) cache, mark DIFFERENT Squares of the
// SAME Day Card while offline — and BOTH Marks survive the drains, because a
// Mark is a per-cell `{ merge: true }` patch of the cells MAP, not a
// full-array replacement. Under the pre-#457 array schema the later drain
// silently erased the earlier device's Mark (PR #447 review rounds 1/6 — the
// class no version counter could close). Real emulators, real rules, real
// persistence: the strongest form of the guarantee this repo can state.

const EVENT_ID = 'med-2026';
const PROJECT_ID = runScopedProject('demo-cells-map'); // isolated project (emulator budget-leak containment)
const EMAIL = runScopedEmail('cellsmap');
const PASSWORD = 'passw0rd!';
const DEVICE_A_MARK = 3;
const DEVICE_B_MARK = 9;

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
/** One "device": its own app name → its own persistent cache and queue. */
async function makeDevice(name: string): Promise<{ app: FirebaseApp; db: Firestore; uid: string }> {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT_ID }, name);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
  const cred = await signIn(auth);
  const db = initializeFirestore(app, { localCache: persistentLocalCache() });
  connectFirestoreEmulator(db, ...firestoreEmulator());
  return { app, db, uid: cred.user.uid };
}
function dealtCells(): Cell[] {
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `item-${index}`,
    text: index === 12 ? 'FREE' : `prompt ${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
}
afterAll(async () => {
  await Promise.all(apps.map((a) => deleteApp(a).catch(() => {})));
});

describe('cells-map — cross-device Marks merge instead of clobbering (specs/cells-map.md)', () => {
  it('two devices mark DIFFERENT cells from mutually stale caches; both Marks survive both drains', async () => {
    await seedEventDoc(PROJECT_ID, EVENT_ID);
    const a = await makeDevice('cells-map-device-a');
    const b = await makeDevice('cells-map-device-b');
    const boardPath = `events/${EVENT_ID}/days/0/boards/${a.uid}`;
    const playerPath = `events/${EVENT_ID}/players/${a.uid}`;

    // Device A deals the board online; device B loads the same pristine board
    // into ITS cache (both now share the same base state).
    const cells = dealtCells();
    await setDoc(doc(a.db, boardPath), {
      uid: a.uid,
      dayIndex: 0,
      seed: 42,
      createdAt: Date.now(),
      cells: cellsToMap(cells),
    });
    await setDoc(doc(a.db, playerPath), {
      uid: a.uid,
      displayName: 'Two Phones',
      photoURL: null,
      joinedAt: Date.now(),
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      blackout: false,
      reshufflesUsed: 0,
    } satisfies PlayerDoc & { reshufflesUsed: number });
    await waitForPendingWrites(a.db);
    await getDocFromServer(doc(b.db, boardPath)); // hydrate device B's cache

    // Both go OFFLINE, then each marks a different Square from its own cache —
    // neither can see the other's Mark.
    await disableNetwork(a.db);
    await disableNetwork(b.db);
    await setMark({
      uid: a.uid,
      cells,
      index: DEVICE_A_MARK,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      dayIndex: 0,
      daily: true,
      boardSeed: 42,
      database: a.db,
    });
    await setMark({
      uid: b.uid,
      cells,
      index: DEVICE_B_MARK,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      dayIndex: 0,
      daily: true,
      boardSeed: 42,
      database: b.db,
    });

    // Drain A first, then B — the order that previously clobbered A's Mark.
    await enableNetwork(a.db);
    await waitForPendingWrites(a.db);
    await enableNetwork(b.db);
    await waitForPendingWrites(b.db);

    const server = await getDocFromServer(doc(a.db, boardPath));
    const stored = cellsFromData((server.data() as { cells?: unknown }).cells);
    expect(stored.find((c) => c.index === DEVICE_A_MARK)?.marked).toBe(true); // survived B's later drain
    expect(stored.find((c) => c.index === DEVICE_B_MARK)?.marked).toBe(true);

    // STATS CONVERGENCE (Phase 4b P1 on #458): the aggregated player write is
    // an absolute projection of the writing device's cached view, so B's later
    // drain briefly records a one-mark projection. The designed consistency
    // model (specs/cells-map.md § Contract): the BOARD is the source of truth,
    // per-day buckets merge-scope to the acted day, and the next fold from a
    // SYNCED cache re-derives correct absolutes. Prove it: device A refreshes
    // its cache (both cells now visible) and marks a third Square — its fold
    // must count all three Marks.
    const refreshed = await getDoc(doc(a.db, boardPath)); // server read → cache
    const refreshedCells = cellsFromData((refreshed.data() as { cells?: unknown }).cells);
    expect(refreshedCells.filter((c) => !c.free && c.marked)).toHaveLength(2);
    await setMark({
      uid: a.uid,
      cells: refreshedCells,
      index: 15,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      dayIndex: 0,
      daily: true,
      boardSeed: 42,
      database: a.db,
    });
    await waitForPendingWrites(a.db);
    const player = await getDocFromServer(doc(a.db, playerPath));
    const stats = player.data() as { squaresMarked: number; dayStats: Record<number, { squaresMarked: number }> };
    expect(stats.squaresMarked).toBe(3); // converged: all three Marks counted
    expect(stats.dayStats[0].squaresMarked).toBe(3);
  }, 60000);
});
