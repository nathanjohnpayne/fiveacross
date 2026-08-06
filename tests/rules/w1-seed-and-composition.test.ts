import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  deleteField,
  doc,
  getDocs,
  setDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
// scripts/seed.mjs is a plain-JS node script (typed via scripts/seed.d.mts).
// The exported payload helpers are import-safe and side-effect-free; the GCB
// Event payload itself is per-Event seed data (#563).
import {
  adminRoster,
  eventWritePayload,
  seedItemDocId,
  seedItemMutations,
  verifySeedPool,
} from '../../scripts/seed.mjs';
import { ALL_ITEMS, EVENT_SEED } from '../../scripts/seed-data/med-2026.mjs';

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'seed-composition';

let testEnv: RulesTestEnvironment;

async function applySeed(db: Firestore) {
  const eventRef = doc(db, 'events', EVENT);
  const itemsRef = collection(db, 'events', EVENT, 'items');
  const existing = await getDocs(itemsRef);
  const { deleteIds, writes } = seedItemMutations(
    existing.docs.map((snap) => ({
      id: snap.id,
      createdBy: snap.data().createdBy,
    })),
    1_776_000_000_000,
    ALL_ITEMS,
  );
  const batch = writeBatch(db);
  batch.set(eventRef, eventWritePayload(EVENT_SEED, adminRoster(''), deleteField()), {
    merge: true,
  });
  for (const id of deleteIds) batch.delete(doc(itemsRef, id));
  for (const { id, data } of writes) batch.set(doc(itemsRef, id), data, { merge: true });
  await batch.commit();
}

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gaycruisebingo-seed-composition',
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

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe('scripts/seed.mjs — emulator-backed seed-owned replace semantics', () => {
  it('fresh seed writes exactly 80 active main prompts + 28 active embark + 28 active farewell prompts, all boolean spicy', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await applySeed(db);
      const seeded = (await getDocs(collection(db, 'events', EVENT, 'items'))).docs.map((snap) =>
        snap.data(),
      );

      expect(seeded).toHaveLength(136);
      expect(seeded.every((item) => item.createdBy === 'seed')).toBe(true);
      expect(seeded.every((item) => item.status === 'active')).toBe(true);
      expect(seeded.every((item) => item.status !== 'pending')).toBe(true);
      expect(seeded.filter((item) => item.pool === 'main')).toHaveLength(80);
      expect(seeded.filter((item) => item.pool === 'embark')).toHaveLength(28);
      expect(seeded.filter((item) => item.pool === 'farewell')).toHaveLength(28);
      expect(seeded.filter((item) => item.spicy === true)).toHaveLength(24);
      expect(seeded.filter((item) => item.spicy === false)).toHaveLength(112);
      expect(seeded.some((item) => item.isFreeSpace === true)).toBe(false);
    });
  });

  it('running twice replaces seed-owned prompts without duplicating or deleting player submissions', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await applySeed(db);
      await setDoc(doc(db, 'events', EVENT, 'items', 'stale-seed'), {
        text: 'stale seed prompt',
        createdBy: 'seed',
        createdAt: 1,
        isFreeSpace: false,
        status: 'active',
        reportCount: 0,
        spicy: false,
      });
      await setDoc(doc(db, 'events', EVENT, 'items', 'player-prompt'), {
        text: 'player prompt',
        createdBy: 'player-1',
        createdAt: 1,
        isFreeSpace: false,
        status: 'active',
        reportCount: 0,
        spicy: true,
      });

      await applySeed(db);
      const docs = (await getDocs(collection(db, 'events', EVENT, 'items'))).docs;
      const byId = new Map(docs.map((snap) => [snap.id, snap.data()]));
      const seedOwned = docs.filter((snap) => snap.data().createdBy === 'seed');

      expect(seedOwned).toHaveLength(136);
      expect(byId.has('stale-seed')).toBe(false);
      expect(byId.get('player-prompt')?.text).toBe('player prompt');
      expect(byId.get('player-prompt')?.createdBy).toBe('player-1');
    });
  });
});

async function readPool(db: Firestore) {
  const snap = await getDocs(collection(db, 'events', EVENT, 'items'));
  return snap.docs.map((d) => ({
    id: d.id,
    text: d.data().text,
    createdBy: d.data().createdBy,
    spicy: d.data().spicy,
    isFreeSpace: d.data().isFreeSpace,
    status: d.data().status,
    reportCount: d.data().reportCount,
    pool: d.data().pool,
  }));
}

// #129 reopened: a merged + deployed pool change still leaves players on the OLD
// pool until the seed is re-run against the live project. `verifySeedPool` is the
// drift check that catches that gap; these run it against a real (emulator)
// Firestore end-to-end — the seed writes, then the check reads the same docs back.
describe('scripts/seed.mjs — verifySeedPool against a live (emulator) Firestore', () => {
  it('a fresh seed leaves the live pool matching the canonical ALL_ITEMS (verify ok)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await applySeed(db);
      const report = verifySeedPool(await readPool(db), ALL_ITEMS);
      expect(report.ok).toBe(true);
      expect(report.seedOwned).toBe(136);
      expect(report.missing).toEqual([]);
      expect(report.stale).toEqual([]);
    });
  });

  it('catches an un-reseeded OLD pool as drift, then confirms the seed reconciles it', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // Simulate the exact production state after #135 merged/deployed but the
      // reseed was skipped: the live pool is still the pre-#135 seed set.
      const oldPool = [
        { text: 'Threesome', spicy: true }, // survived into the new pool
        { text: 'Make out with Patti LuPone', spicy: true }, // retired
        { text: 'Sex with four gays, each from a different continent', spicy: true }, // renamed out
        { text: '3 loads in one day', spicy: true }, // renamed out
      ];
      for (const { text, spicy } of oldPool) {
        await setDoc(doc(db, 'events', EVENT, 'items', seedItemDocId(text)), {
          text,
          createdBy: 'seed',
          createdAt: 1,
          isFreeSpace: false,
          status: 'active',
          reportCount: 0,
          spicy,
        });
      }

      const before = verifySeedPool(await readPool(db), ALL_ITEMS);
      expect(before.ok).toBe(false);
      expect(before.missing.length).toBe(135); // every ALL_ITEMS entry except 'Threesome'
      expect(before.stale.length).toBe(3); // the retired entries

      // Running the seed (what was skipped in prod) reconciles the pool.
      await applySeed(db);
      const after = verifySeedPool(await readPool(db), ALL_ITEMS);
      expect(after.ok).toBe(true);
      expect(after.seedOwned).toBe(136);
    });
  });
});
