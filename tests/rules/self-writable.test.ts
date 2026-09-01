import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';

// A minimal CANONICAL cells map (#458: the board rule requires exactly the 25
// decimal keys) — these suites test gates other than cell mechanics, so the
// cells are inert placeholders.
function fullCellsMap() {
  return Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      String(i),
      { index: i, itemId: i === 12 ? null : `i${i}`, text: 'p', free: i === 12, marked: i === 12, markedAt: null },
    ]),
  );
}


// Documentation-guard for the honor-system design this ticket (w3-security-
// hardening) documents in firestore.rules. It test-pins the INTENT so a future
// reviewer who "locks down" the self-writable rules trips a named test:
//   ADR 0001 — self-writable boards/{uid} + players/{uid} are intentional (the
//              owner writes their own Board + stats directly, NOT a hole).
//   ADR 0002 — every Mark self-publishes an attributed public Tally entry;
//              forging another Player's entry is denied.
// The PERMISSION_DENIED lines the SDK logs are the expected assertFails denials.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB, CAROL] = ['admin-uid', 'alice', 'bob', 'carol'];
const NOW = () => Date.now();
// Day 0 is UNLOCKED (unlockAt an hour in the past); the day-scoped Board write
// gate reads this Day's `unlockAt` from the Event doc's `days` DayDef[] array.
const PAST = () => NOW() - 3600_000;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;

beforeAll(async () => {
  // Under `firebase emulators:exec` the host is exported here; fall back to the
  // firebase.json firestore port so a direct run still connects.
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // A distinct projectId from w0-firestore-rules.test.ts (which also uses
    // clearFirestore() in beforeEach): the Firestore emulator hosts each
    // projectId as isolated data, so two suites sharing one id race each
    // other's clearFirestore() under Vitest's default file parallelism
    // (vitest.rules.config.ts doesn't disable it). w0-storage-rules.test.ts
    // already models a suite-specific id for the same reason.
    projectId: 'demo-gcb-self-writable',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// Each test starts clean with a canonical Event (admins=[ADMIN]) and a foreign
// Tally marker so the public-read assertion has something to read.
beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.firestore();
    await setDoc(doc(s, `events/${EVENT}`), { name: 'Cruise', status: 'active', defaultTheme: 'neon-playground', claimMode: 'honor', admins: [ADMIN], settings: { reportHideThreshold: 3 }, days: [{ index: 0, unlockAt: PAST() }] });
    await setDoc(doc(s, at(`tally/item1/markers/${CAROL}`)), { uid: CAROL, displayName: 'Carol', markedAt: NOW() });
  });
});

describe('firestore.rules — self-writable-by-design guard (w3-security-hardening)', () => {
  it('ADR 0001: boards/players stay self-writable for the owner; cross-player writes denied', async () => {
    // Phase 1.5 moved Boards under days/{dayIndex} (daily-cards-spec § Data model
    // + Migration); the self-writable-by-design posture is unchanged — it just
    // rides on the day-scoped path with the unlock-time gate on top (Day 0 is
    // unlocked, so the owner write clears the gate).
    const board = (uid: string, dayIndex: number) => ({ uid, dayIndex, seed: 1, createdAt: NOW(), cells: fullCellsMap() });
    const player = (uid: string) => ({ uid, displayName: uid, photoURL: null, joinedAt: NOW(), bingoCount: 0, squaresMarked: 0, firstBingoAt: null });
    // Self-write ALLOWED — the honor-system model, not a hole to lock down.
    await assertSucceeds(setDoc(doc(db(ALICE), at(`days/0/boards/${ALICE}`)), board(ALICE, 0)));
    await assertSucceeds(setDoc(doc(db(ALICE), at(`players/${ALICE}`)), player(ALICE)));
    // Cross-player writes DENIED by isOwner(uid).
    await assertFails(setDoc(doc(db(ALICE), at(`days/0/boards/${BOB}`)), board(BOB, 0)));
    await assertFails(setDoc(doc(db(ALICE), at(`players/${BOB}`)), player(BOB)));
  });

  it('ADR 0002: a Mark publishes an attributed Tally entry; forgery denied', async () => {
    const entry = (uid: string) => ({ eventId: EVENT, uid, displayName: uid, markedAt: NOW() });
    const mine = doc(db(ALICE), at(`tally/item1/markers/${ALICE}`));
    // Own attributed entry ALLOWED; unmarking removes exactly that entry.
    await assertSucceeds(setDoc(mine, entry(ALICE)));
    await assertSucceeds(deleteDoc(mine));
    // Public read — no anonymity: ALICE reads CAROL's foreign Tally entry.
    await assertSucceeds(getDoc(doc(db(ALICE), at(`tally/item1/markers/${CAROL}`))));
    // Another Player's slot, or a forged uid in your own slot, DENIED.
    await assertFails(setDoc(doc(db(ALICE), at(`tally/item1/markers/${BOB}`)), entry(ALICE)));
    await assertFails(setDoc(doc(db(ALICE), at(`tally/item1/markers/${ALICE}`)), entry(BOB)));
  });
});
