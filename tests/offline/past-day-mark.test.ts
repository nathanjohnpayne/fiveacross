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
  getDocFromServer,
  waitForPendingWrites,
  type Firestore,
} from 'firebase/firestore';
import { setMark } from '../../src/data/api';
import type { Cell, PlayerDoc } from '../../src/types';
import { seedEventDoc } from './seedEvent';
import { runScopedEmail, runScopedProject } from './runScope';
import { cellsToMap, cellsFromData } from '../../src/game/cells';

// ---------------------------------------------------------------------- #387 ---
// A Mark on a PAST (earlier, already-unlocked) Day must COMMIT — the square
// stays marked. Past Days stay markable all cruise by design, and the Mark is
// one atomic batch: the day-scoped board cells patch, the player-stats fold,
// the Tally marker create, plus any Echo writes to sibling Day Cards. If ANY
// write in that batch violates firestore.rules, the whole batch is denied,
// Firestore rolls back the optimistic local write, and the live listener
// re-renders the square unmarked — exactly the #387 "mark reverts" symptom.
//
// That symptom shipped for real on 2026-07-17/18: the #383 rules deploy added
// the `markSeed` stale-write gate while players still ran pre-#383 bundles
// (sticky PWA shells) that never stamped `markSeed`, so every mark from those
// clients — past OR current Day — was PERMISSION_DENIED and reverted. The
// production session replays carry the `[setMark] batch.commit() rejected`
// console line for 6 sessions across both days (see the #387 investigation).
//
// This suite pins the contract going forward, against the REAL rules the
// emulator loads: the CURRENT client write shape, marking a past Day with the
// full batch (tally marker + stats fold + echo to the current Day's card),
// is accepted end-to-end and lands server-side. If a future rules tightening
// (or client write-shape change) breaks any write in the batch, this fails.
// NOTE (Codex P1/P2 on PR #470): the tests/offline layer is NOT yet collected
// by app-ci — wiring it in is #471 — so the CI-GATED pin for the deployment-
// skew class is tests/rules/mark-wire-compat.test.ts (the frozen deployed
// wire shape, run by `npm run test:rules`). This file is the deeper local
// proof through the real setMark writer.

const EVENT_ID = 'med-2026'; // must match the mocked src/firebase EVENT_ID
const PROJECT_ID = runScopedProject('demo-past-day-mark'); // distinct project → isolated data
const EMAIL = runScopedEmail('pastday');
const PASSWORD = 'passw0rd!';
// The shared Prompt sits on BOTH Day Cards, so the past-Day Mark also
// exercises the Echo write to the current Day's board in the same batch.
const SHARED = 'shared-prompt';
const PAST_DAY = 0;
const CURRENT_DAY = 1;
const MARK_INDEX = 7; // shared Prompt on the past Day's card
const ECHO_INDEX = 3; // shared Prompt on the current Day's card

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

async function makeClient(name: string): Promise<{ app: FirebaseApp; db: Firestore; uid: string }> {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT_ID }, name);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
  const cred = await signIn(auth);
  const db = initializeFirestore(app, { localCache: persistentLocalCache() });
  connectFirestoreEmulator(db, ...firestoreEmulator());
  return { app, db, uid: cred.user.uid };
}

/** A dealt, unmarked Day Card whose cell at `sharedIndex` carries the SHARED Prompt. */
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

describe('#387 — a Mark on a past Day commits and persists', () => {
  it('accepts the full past-Day mark batch (board + stats + tally marker + echo) under the live rules', async () => {
    // Two unlocked Days: Day 0 is the PAST Day under test, Day 1 stands in for
    // "today" (the Day the player is NOT viewing). Both unlocked an hour ago —
    // the rules' unlock gate reads `days[dayIndex].unlockAt`, and a past Day
    // passes it by definition.
    await seedEventDoc(PROJECT_ID, EVENT_ID, 2);
    const tab = await makeClient('gcb-past-day-tab');
    const pastBoardPath = `events/${EVENT_ID}/days/${PAST_DAY}/boards/${tab.uid}`;
    const currentBoardPath = `events/${EVENT_ID}/days/${CURRENT_DAY}/boards/${tab.uid}`;
    const playerPath = `events/${EVENT_ID}/players/${tab.uid}`;

    // Deal both Day Cards + the player row ONLINE (the production sequence);
    // the #457 wire shape stores cells as a MAP.
    const past = dayCard(tab.uid, PAST_DAY, 100, MARK_INDEX);
    await setDoc(doc(tab.db, pastBoardPath), { ...past, cells: cellsToMap(past.cells) });
    const current = dayCard(tab.uid, CURRENT_DAY, 111, ECHO_INDEX);
    await setDoc(doc(tab.db, currentBoardPath), { ...current, cells: cellsToMap(current.cells) });
    await setDoc(doc(tab.db, playerPath), {
      uid: tab.uid,
      displayName: 'Past Marker',
      photoURL: null,
      joinedAt: Date.now(),
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      blackout: false,
      reshufflesUsed: 0,
    });
    await waitForPendingWrites(tab.db);

    // The player switches back to the earlier Day and marks a square — the
    // REAL write path, exactly what Board.doMark passes for a past Day view
    // (dayIndex = the viewed past Day, echo across the whole schedule).
    const res = await setMark({
      uid: tab.uid,
      cells: past.cells,
      index: MARK_INDEX,
      nextMarked: true,
      claimMode: 'honor',
      currentFirstBingoAt: null,
      displayName: 'Past Marker',
      dayIndex: PAST_DAY,
      daily: true,
      boardSeed: 100,
      echoDayIndexes: [PAST_DAY, CURRENT_DAY],
      database: tab.db,
    });
    expect(res.bingo).toBe(false);

    // The batch must be ACCEPTED by the rules: after the server ack, the mark
    // is on the past Day's board SERVER-SIDE. (A rules denial would roll the
    // optimistic write back — the #387 revert — and the server would still
    // show the square unmarked.)
    await waitForPendingWrites(tab.db);
    const serverPast = await getDocFromServer(doc(tab.db, pastBoardPath));
    expect(serverPast.metadata.hasPendingWrites).toBe(false);
    const pastCells = cellsFromData((serverPast.data() as { cells?: unknown }).cells);
    expect(pastCells[MARK_INDEX].marked).toBe(true);

    // Every companion write in the SAME atomic batch landed too — a denial of
    // ANY of them would have reverted the mark above with it.
    // 1. The Tally marker (attributed, day-stamped).
    const marker = await getDocFromServer(
      doc(tab.db, 'events', EVENT_ID, 'tally', SHARED, 'markers', tab.uid),
    );
    expect(marker.exists()).toBe(true);
    expect(marker.data()).toMatchObject({ uid: tab.uid, displayName: 'Past Marker', dayIndex: PAST_DAY });

    // 2. The player-stats fold: the acted mark credits the PAST Day's bucket,
    //    the echoed square credits the current Day's, and the cruise-wide root
    //    re-derives as their sum (specs/echo-marks.md § Scoring).
    const player = await getDocFromServer(doc(tab.db, playerPath));
    const playerData = player.data() as PlayerDoc & { dayStats?: Record<string, { squaresMarked?: number }> };
    expect(playerData.dayStats?.[String(PAST_DAY)]?.squaresMarked).toBe(1);
    expect(playerData.dayStats?.[String(CURRENT_DAY)]?.squaresMarked).toBe(1);
    expect(playerData.squaresMarked).toBe(2);

    // 3. The Echo write to the current Day's card (same batch, its own seed).
    const serverCurrent = await getDocFromServer(doc(tab.db, currentBoardPath));
    const currentCells = cellsFromData((serverCurrent.data() as { cells?: unknown }).cells);
    expect(currentCells[ECHO_INDEX].marked).toBe(true);
    expect(currentCells[ECHO_INDEX].echo).toBe(true);
  });
});
