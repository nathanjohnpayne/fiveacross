import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, type Firestore, type Transaction, type TransactionOptions, type DocumentReference } from 'firebase/firestore';
import type { User } from 'firebase/auth';

const dealSeam = vi.hoisted(() => ({ database: null as Firestore | null, eventRead: vi.fn<() => Promise<void>>(), itemRead: vi.fn<(path: string) => Promise<void>>() }));
vi.mock('../../src/firebase', () => ({ get db() { return dealSeam.database; }, EVENT_ID: 'cruise' }));
vi.mock('../../src/analytics', () => ({ track: vi.fn() }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('firebase/firestore')>();
  return { ...sdk, runTransaction: (database: Firestore, callback: (tx: Transaction) => Promise<unknown>, options?: TransactionOptions) =>
    sdk.runTransaction(database, (tx) => callback(new Proxy(tx, {
      get(target, key) {
        if (key === 'get') return async (ref: DocumentReference) => {
          const snapshot = await target.get(ref);
          if (ref.path === `events/${EVENT}`) await dealSeam.eventRead();
          if (ref.path.startsWith(`events/${EVENT}/items/`)) await dealSeam.itemRead(ref.path);
          return snapshot;
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })), options),
  };
});
import { dealDayCard, reshuffleBoard } from '../../src/data/api';

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


// specs/d15-dealing.md, the dealing path against the day-scoped Board rules
// (#201): a Day Card write (the deal that CREATES the doc) is DENIED before that
// Day's `unlockAt`, and ALLOWED at/after unlock when the owner's board doc is
// absent. The full rules surface is exercised by tests/rules/d15-firestore-rules.
// test.ts; this suite pins the deal-time gate `dealDayCard` writes against.
//
// The PERMISSION_DENIED lines the SDK logs to stderr are the expected assertFails
// denials, not test failures.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ALICE] = ['alice'];
const NOW = () => Date.now();
const PAST = () => NOW() - 3_600_000;
const FUTURE = () => NOW() + 3_600_000;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;

// A well-formed Day Card payload; `cells` shape is not gated by the rules (the
// unlock time + ownership are), so an empty array suffices for the gate test.
const dayCard = (uid: string, dayIndex: number) => ({
  uid,
  dayIndex,
  seed: 1,
  createdAt: NOW(),
  cells: fullCellsMap(),
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // Unique per-file projectId so this suite's clearFirestore never races
    // another concurrently-running rules file's seed (same convention as the
    // other rules suites).
    projectId: 'demo-gaycruisebingo-d15-dealing',
    firestore: {
      host: hostname,
      port: Number(port),
      rules: readFileSync(RULES_PATH, 'utf8'),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// Each test starts clean with an Event whose `days` array has an unlocked Day 0
// (unlockAt in the past) and a locked Day 1 (unlockAt in the future) — the shape
// the day-scoped Board write gate reads `unlockAt` from.
beforeEach(async () => {
  await testEnv.clearFirestore();
  dealSeam.database = db(ALICE) as unknown as Firestore;
  dealSeam.eventRead.mockReset();
  dealSeam.itemRead.mockReset();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `events/${EVENT}`), {
      name: 'Cruise',
      status: 'active',
      admins: [],
      settings: {},
      timezone: 'Europe/Rome',
      days: [
        { index: 0, unlockAt: PAST() },
        { index: 1, unlockAt: FUTURE() },
      ],
    });
  });
});

describe('d15-dealing — the deal write is gated by the Day unlock', () => {
  it('DENIES dealing a Day Card before that Day unlockAt (locked Day 1)', async () => {
    await assertFails(setDoc(doc(db(ALICE), at(`days/1/boards/${ALICE}`)), dayCard(ALICE, 1)));
  });

  it('ALLOWS dealing a Day Card at/after unlockAt when the board doc is absent (unlocked Day 0)', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), at(`days/0/boards/${ALICE}`)), dayCard(ALICE, 0)));
  });
});


describe('frozen snapshot hydration through the real deal path (#1406)', () => {
  async function seedSnapshot(hidden = false) {
    const ids = Array.from({ length: 30 }, (_, i) => `prompt-${i}`);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const trusted = ctx.firestore();
      await setDoc(doc(trusted, `events/${EVENT}`), {
        status: 'active', admins: [], settings: {},
        days: [{ index: 0, unlockAt: PAST(), pool: 'main', snapshotItemIds: ids }],
      });
      await setDoc(doc(trusted, at(`players/${ALICE}`)), { uid: ALICE, displayName: 'Alice', joinedAt: PAST() });
      await Promise.all(ids.map((id, i) => setDoc(doc(trusted, at(`items/${id}`)), {
        text: `Prompt ${i}`, status: hidden && i === 0 ? 'hidden' : 'active',
        spicy: false, isFreeSpace: false, pool: 'main', reportCount: 0,
      })));
    });
    return ids;
  }

  it('denies hidden Prompt reads and never commits a card from the remaining snapshot', async () => {
    const ids = await seedSnapshot(true);
    await assertFails(getDoc(doc(db(ALICE), at(`items/${ids[0]}`))));
    await expect(dealDayCard({ uid: ALICE } as User, 0)).rejects.toThrow('frozen');
    expect((await getDoc(doc(db(ALICE), at(`days/0/boards/${ALICE}`)))).exists()).toBe(false);
  });

  it.each(['deal', 'reshuffle'] as const)('preserves a complete readable snapshot through the real %s transaction', async (operation) => {
    await seedSnapshot();
    if (operation === 'reshuffle') {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), at(`days/0/boards/${ALICE}`)), { ...dayCard(ALICE, 0), seed: 111 });
        await updateDoc(doc(ctx.firestore(), at(`players/${ALICE}`)), { reshufflesUsed: 0 });
      });
    }
    if (operation === 'deal') await expect(dealDayCard({ uid: ALICE } as User, 0)).resolves.toBe(true);
    else await expect(reshuffleBoard({ uid: ALICE, dayIndex: 0, expectedSeed: 111 })).resolves.toBe(1);
    const board = (await getDoc(doc(db(ALICE), at(`days/0/boards/${ALICE}`)))).data()!;
    expect(Object.keys(board.cells)).toHaveLength(25);
  });

  it.each([
    ['deal', 'hide'], ['deal', 'delete'], ['deal', 'edit'],
    ['reshuffle', 'hide'], ['reshuffle', 'delete'], ['reshuffle', 'edit'],
  ] as const)('refuses %s when a frozen Prompt is changed by %s after readable preflight', async (operation, mutation) => {
    const ids = await seedSnapshot();
    if (operation === 'reshuffle') {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), at(`days/0/boards/${ALICE}`)), { ...dayCard(ALICE, 0), seed: 111 });
        await updateDoc(doc(ctx.firestore(), at(`players/${ALICE}`)), { reshufflesUsed: 0 });
      });
    }
    const beforePlayer = (await getDoc(doc(db(ALICE), at(`players/${ALICE}`)))).data();
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const read = new Promise<void>((resolve) => { signalRead = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    // This existing Event-TX seam runs only after all preflight item reads and
    // preserves exactly the same Event/snapshot IDs throughout the mutation.
    dealSeam.eventRead.mockImplementationOnce(async () => { signalRead(); await release; });
    const publishing = operation === 'deal'
      ? dealDayCard({ uid: ALICE } as User, 0)
      : reshuffleBoard({ uid: ALICE, dayIndex: 0, expectedSeed: 111 });
    await read;
    try {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const item = doc(ctx.firestore(), at(`items/${ids[0]}`));
        if (mutation === 'delete') await deleteDoc(item);
        else await updateDoc(item, mutation === 'hide' ? { status: 'hidden' } : { text: 'Changed after hydration' });
      });
    } finally { releaseRead(); }
    await expect(publishing).rejects.toThrow('frozen');
    const board = await getDoc(doc(db(ALICE), at(`days/0/boards/${ALICE}`)));
    if (operation === 'deal') expect(board.exists()).toBe(false);
    else expect(board.data()?.seed).toBe(111);
    expect((await getDoc(doc(db(ALICE), at(`players/${ALICE}`)))).data()).toEqual(beforePlayer);
    expect((await getDoc(doc(db(ALICE), at(`reshuffles/${ALICE}-1`)))).exists()).toBe(false);
  });

  it.each(['deal', 'reshuffle'] as const)('retries the real %s transaction when a Prompt changes after its transaction read', async (operation) => {
    const ids = await seedSnapshot();
    if (operation === 'reshuffle') {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), at(`days/0/boards/${ALICE}`)), { ...dayCard(ALICE, 0), seed: 111 });
        await updateDoc(doc(ctx.firestore(), at(`players/${ALICE}`)), { reshufflesUsed: 0 });
      });
    }
    const beforePlayer = (await getDoc(doc(db(ALICE), at(`players/${ALICE}`)))).data();
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const read = new Promise<void>((resolve) => { signalRead = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    let held = false;
    dealSeam.itemRead.mockImplementation(async (path) => {
      if (path !== at(`items/${ids[0]}`) || held) return;
      held = true;
      signalRead();
      await release;
    });
    const publishing = operation === 'deal'
      ? dealDayCard({ uid: ALICE } as User, 0)
      : reshuffleBoard({ uid: ALICE, dayIndex: 0, expectedSeed: 111 });
    await Promise.race([read, publishing.then(() => { throw new Error('Published without reading the Prompt in its transaction'); })]);
    try {
      // The native transaction has read the old Prompt version; no Event
      // field changes. Its commit must conflict, then refuse stale hydration.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), at(`items/${ids[0]}`)), { text: 'Changed after transaction read' });
      });
    } finally { releaseRead(); }
    await expect(publishing).rejects.toThrow('frozen');
    expect(dealSeam.eventRead.mock.calls.length).toBeGreaterThan(1);
    const board = await getDoc(doc(db(ALICE), at(`days/0/boards/${ALICE}`)));
    if (operation === 'deal') expect(board.exists()).toBe(false);
    else expect(board.data()?.seed).toBe(111);
    expect((await getDoc(doc(db(ALICE), at(`players/${ALICE}`)))).data()).toEqual(beforePlayer);
    expect((await getDoc(doc(db(ALICE), at(`reshuffles/${ALICE}-1`)))).exists()).toBe(false);
  });

  it('retries the real transaction when re-snapshot changes Event after the deal read', async () => {
    const ids = await seedSnapshot();
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const read = new Promise<void>((resolve) => { signalRead = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    dealSeam.eventRead.mockImplementationOnce(async () => { signalRead(); await release; });
    const dealing = dealDayCard({ uid: ALICE } as User, 0);
    await read;
    try {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const ref = doc(ctx.firestore(), `events/${EVENT}`);
        const event = (await getDoc(ref)).data()!;
        await updateDoc(ref, { days: [{ ...event.days[0], snapshotItemIds: ids.slice(1) }] });
      });
    } finally { releaseRead(); }
    await expect(dealing).resolves.toBe(false);
    expect(dealSeam.eventRead.mock.calls.length).toBeGreaterThan(1);
    expect((await getDoc(doc(db(ALICE), at(`days/0/boards/${ALICE}`)))).exists()).toBe(false);
  });

  it('retries a real reshuffle transaction after re-snapshot without replacing the card or spending', async () => {
    const ids = await seedSnapshot();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), at(`days/0/boards/${ALICE}`)), { ...dayCard(ALICE, 0), seed: 111 });
      await updateDoc(doc(ctx.firestore(), at(`players/${ALICE}`)), { reshufflesUsed: 0 });
    });
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const read = new Promise<void>((resolve) => { signalRead = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    dealSeam.eventRead.mockImplementationOnce(async () => { signalRead(); await release; });
    const reshuffling = reshuffleBoard({ uid: ALICE, dayIndex: 0, expectedSeed: 111 });
    await read;
    try {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const ref = doc(ctx.firestore(), `events/${EVENT}`);
        const event = (await getDoc(ref)).data()!;
        await updateDoc(ref, { days: [{ ...event.days[0], snapshotItemIds: ids.slice(1) }] });
      });
    } finally { releaseRead(); }
    await expect(reshuffling).rejects.toThrow('Day changed');
    expect(dealSeam.eventRead.mock.calls.length).toBeGreaterThan(1);
    expect((await getDoc(doc(db(ALICE), at(`days/0/boards/${ALICE}`)))).data()?.seed).toBe(111);
    expect((await getDoc(doc(db(ALICE), at(`players/${ALICE}`)))).data()?.reshufflesUsed).toBe(0);
    expect((await getDoc(doc(db(ALICE), at(`reshuffles/${ALICE}-1`)))).exists()).toBe(false);
  });
});
