import { afterAll, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import type { User } from 'firebase/auth';

// joinAndDeal reads the production firebase singleton `db` directly (it takes
// no injectable database, unlike setMark), so the emulator client is threaded
// through a mutable holder the mock's getter re-reads on every access.
const liveDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../src/firebase', () => ({
  get db() {
    return liveDb.current;
  },
  EVENT_ID: 'med-2026',
}));
// DETERMINISTIC overlap barrier (Codex P2 on #472): `Promise.all` alone does
// not guarantee the two joins overlap at the conflicting player-row read — the
// emulator may let the first call read AND commit before the second reaches
// the row, a schedule in which even the old non-transactional code returns one
// true/one false. While armed, both transactions are held at the TOP of their
// callback (before any tx read) until BOTH have arrived, so both perform the
// row read before either can commit — a guaranteed read-write conflict the
// loser must resolve by retrying against the winner's committed row. Retries
// re-enter the callback and pass straight through (the gate is already open).
const txGate = vi.hoisted(() => {
  let release: (() => void) | undefined;
  let open: Promise<void> = Promise.resolve();
  let remaining = 0;
  return {
    /** Hold the next `n` transaction callbacks until all `n` have arrived. */
    arm(n: number) {
      remaining = n;
      open = new Promise<void>((r) => {
        release = r;
      });
    },
    async arrive(): Promise<void> {
      if (remaining <= 0) return;
      remaining -= 1;
      if (remaining === 0) release?.();
      await open;
    },
  };
});
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  const gatedRunTransaction: typeof actual.runTransaction = (db, fn, options?) =>
    actual.runTransaction(
      db,
      async (tx) => {
        await txGate.arrive();
        return fn(tx);
      },
      options,
    );
  return { ...actual, runTransaction: gatedRunTransaction };
});
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  type Auth,
} from 'firebase/auth';
import {
  initializeFirestore,
  connectFirestoreEmulator,
  doc,
  getDocFromServer,
  type Firestore,
} from 'firebase/firestore';
import { joinAndDeal } from '../../src/data/api';
import { seedEventDoc } from './seedEvent';
import { runScopedEmail, runScopedProject } from './runScope';

// ---------------------------------------------------------------------- #409 ---
// The join must be IDEMPOTENT under overlap. `withTimeout` in runDeal rejects
// the race but cannot cancel the underlying joinAndDeal, so a timed-out deal
// keeps running while a Retry starts a second one — two joinAndDeal calls for
// the same uid in flight at once. Against the REAL emulator (rules loaded):
// both must settle, EXACTLY ONE may report an actual join (the join_event
// gate), and the committed row must be a single coherent join — no double
// write, no `joinedAt` re-stamp, no aggregate re-zeroing. The runTransaction
// conversion inside joinAndDeal is what serializes them; before it, both
// overlapping calls read "no row" and both committed a full seed.

const EVENT_ID = 'med-2026'; // must match the mocked src/firebase EVENT_ID
// Per-run scoped (#473): a fixed project id + email left the player row and
// its auth user behind in a long-lived local emulator, so a SECOND `vitest
// run` saw the row already present and both overlapping joins resolved false.
const PROJECT_ID = runScopedProject('demo-join-idempotent'); // distinct project → isolated data
const EMAIL = runScopedEmail('idem');
const PASSWORD = 'passw0rd!';

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
  const db = initializeFirestore(app, {});
  connectFirestoreEmulator(db, ...firestoreEmulator());
  return { app, db, uid: cred.user.uid };
}

afterAll(async () => {
  await Promise.all(apps.map((a) => deleteApp(a).catch(() => {})));
});

describe('#409 — joinAndDeal is idempotent under overlapping calls', () => {
  it('two concurrent joins commit ONE coherent row and exactly one reports an actual join', async () => {
    // Daily mode (the live production shape): the event carries a days[]
    // schedule, so the join seeds the identity row only.
    await seedEventDoc(PROJECT_ID, EVENT_ID, 1);
    const tab = await makeClient('gcb-join-idem-tab');
    liveDb.current = tab.db;
    const user = { uid: tab.uid, displayName: 'Idem Tester', photoURL: null } as unknown as User;

    // The timed-out-deal + Retry window, compressed: both calls in flight at
    // once, neither awaited before the other starts — and the barrier holds
    // BOTH transactions before their row read until both have arrived, so the
    // conflicting overlap is guaranteed, not schedule-dependent.
    txGate.arm(2);
    const [first, second] = await Promise.all([joinAndDeal(user), joinAndDeal(user)]);

    // Exactly one actual join — runDeal fires join_event off this verdict, so
    // a double-true is a double-counted analytic; a double-false is a lost one.
    expect([first, second].filter((dealt) => dealt === true)).toHaveLength(1);

    // One coherent committed row: identity + a single joinedAt stamp + zeroed
    // aggregates, accepted by the live rules (the monotonic reshuffle counter
    // included — a stale-read overlap used to risk a rules-denied rewind).
    const row = await getDocFromServer(doc(tab.db, 'events', EVENT_ID, 'players', tab.uid));
    expect(row.exists()).toBe(true);
    expect(row.data()).toMatchObject({
      uid: tab.uid,
      displayName: 'Idem Tester',
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      blackout: false,
      reshufflesUsed: 0,
    });
    expect(typeof (row.data() as { joinedAt?: unknown }).joinedAt).toBe('number');

    // A later re-join (reconnect, authority flip) stays a no-op verdict.
    await expect(joinAndDeal(user)).resolves.toBe(false);
  });
});
