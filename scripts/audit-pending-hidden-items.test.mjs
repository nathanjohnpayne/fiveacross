import { describe, expect, it } from 'vitest';
import {
  isPendingHiddenCandidate,
  parseAuditArgs,
  planPendingHiddenAudit,
  runPendingHiddenAudit,
} from './audit-pending-hidden-items.mjs';

// The pre-deploy audit for rows hidden while pending (#1275, ADR 0015). Pure
// core first, then the runner over a small in-memory Firestore double.

const ADMIN = 'admin-1';
const PLAYER = 'player-1';

describe('isPendingHiddenCandidate', () => {
  it('lists a hidden player row that was never approved', () => {
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: PLAYER }, [ADMIN])).toBe(true);
  });

  it('skips a row that carries approval provenance, a seeded row, and an Admin-authored row', () => {
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: PLAYER, approvedAt: 5 }, [ADMIN])).toBe(false);
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: 'seed' }, [ADMIN])).toBe(false);
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: ADMIN }, [ADMIN])).toBe(false);
  });

  it('only ever lists hidden rows', () => {
    for (const status of ['active', 'pending', 'rejected', undefined]) {
      expect(isPendingHiddenCandidate({ status, createdBy: PLAYER }, [ADMIN])).toBe(false);
    }
  });

  it('fails toward listing when provenance or the roster is malformed', () => {
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: PLAYER, approvedAt: 'yesterday' }, [ADMIN])).toBe(true);
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: PLAYER, approvedAt: Number.NaN }, [ADMIN])).toBe(true);
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: ADMIN }, 'admin-1')).toBe(true);
    expect(isPendingHiddenCandidate({ status: 'hidden' }, [ADMIN])).toBe(true);
    expect(isPendingHiddenCandidate(null, [ADMIN])).toBe(false);
  });
});

describe('planPendingHiddenAudit', () => {
  it('collects candidates across Events in a stable order', () => {
    const plan = planPendingHiddenAudit([
      {
        eventId: 'b',
        admins: [ADMIN],
        items: [
          { id: 'z', data: { status: 'hidden', createdBy: PLAYER, text: 'late' } },
          { id: 'a', data: { status: 'hidden', createdBy: PLAYER, createdAt: 0, text: 'early' } },
        ],
      },
      { eventId: 'a', admins: [ADMIN], items: [{ id: 'm', data: { status: 'hidden', createdBy: ADMIN } }] },
    ]);
    expect(plan.candidates.map((c) => `${c.eventId}/${c.itemId}`)).toEqual(['b/a', 'b/z']);
    expect(plan.candidates[0]).toMatchObject({ createdBy: PLAYER, createdAt: 0, text: 'early' });
  });
});

describe('parseAuditArgs', () => {
  it('requires exactly one known target and accepts only --requeue', () => {
    expect(parseAuditArgs(['fiveacross'])).toEqual({ target: 'fiveacross', projectId: 'fiveacross', requeue: false });
    expect(parseAuditArgs(['gaycruisebingo', '--requeue'])).toMatchObject({ projectId: 'gaycruisebingo', requeue: true });
    expect(() => parseAuditArgs([])).toThrow(/explicit target/);
    expect(() => parseAuditArgs(['staging'])).toThrow(/explicit target/);
    expect(() => parseAuditArgs(['fiveacross', 'gaycruisebingo'])).toThrow(/exactly one target/);
    expect(() => parseAuditArgs(['fiveacross', '--apply'])).toThrow(/unknown argument/);
  });
});

/** A Firestore double covering exactly the calls the runner makes. */
function fakeDb(docs) {
  const store = new Map(Object.entries(docs).map(([path, data]) => [path, { ...data }]));
  const writes = [];
  const snap = (path) => ({
    id: path.split('/').pop(),
    exists: store.has(path),
    data: () => (store.has(path) ? { ...store.get(path) } : undefined),
  });
  const children = (collectionPath) =>
    [...store.keys()].filter(
      (p) => p.startsWith(`${collectionPath}/`) && !p.slice(collectionPath.length + 1).includes('/'),
    );
  return {
    writes,
    read: (path) => store.get(path),
    collection: (collectionPath) => ({
      get: async () => ({ docs: children(collectionPath).map(snap) }),
      where: (field, op, value) => ({
        get: async () => ({
          docs: children(collectionPath)
            .filter(() => op === '==')
            .filter((p) => store.get(p)[field] === value)
            .map(snap),
        }),
      }),
    }),
    doc: (path) => ({ path }),
    runTransaction: async (fn) =>
      fn({
        get: async (ref) => snap(ref.path),
        update: (ref, data) => {
          writes.push({ path: ref.path, data });
          store.set(ref.path, { ...store.get(ref.path), ...data });
        },
      }),
  };
}

const quiet = () => {};

describe('runPendingHiddenAudit', () => {
  const seedDocs = () => ({
    'events/e1': { admins: [ADMIN] },
    'events/e1/items/never': { status: 'hidden', createdBy: PLAYER, text: 'never approved' },
    'events/e1/items/approved': { status: 'hidden', createdBy: PLAYER, approvedAt: 1 },
    'events/e1/items/seeded': { status: 'hidden', createdBy: 'seed' },
    'events/e1/items/live': { status: 'active', createdBy: PLAYER },
  });

  it('dry run lists the never-approved hidden row and writes nothing', async () => {
    const db = fakeDb(seedDocs());
    const { plan, requeued } = await runPendingHiddenAudit(db, { log: quiet });
    expect(plan.candidates.map((c) => c.itemId)).toEqual(['never']);
    expect(requeued).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('--requeue moves exactly that row to pending and changes nothing else on it', async () => {
    const db = fakeDb(seedDocs());
    const { requeued, skipped } = await runPendingHiddenAudit(db, { requeue: true, log: quiet });
    expect(requeued.map((c) => c.itemId)).toEqual(['never']);
    expect(skipped).toEqual([]);
    expect(db.writes).toEqual([{ path: 'events/e1/items/never', data: { status: 'pending' } }]);
    expect(db.read('events/e1/items/never')).toEqual({ status: 'pending', createdBy: PLAYER, text: 'never approved' });
    const again = await runPendingHiddenAudit(db, { log: quiet });
    expect(again.plan.candidates).toEqual([]);
  });

  it('skips a row that stopped qualifying between the scan and its transaction', async () => {
    const db = fakeDb(seedDocs());
    const original = db.runTransaction;
    db.runTransaction = async (fn) => {
      // An Admin was added to the roster after the scan.
      db.read('events/e1').admins = [ADMIN, PLAYER];
      return original(fn);
    };
    const { requeued, skipped } = await runPendingHiddenAudit(db, { requeue: true, log: quiet });
    expect(requeued).toEqual([]);
    expect(skipped.map((c) => c.itemId)).toEqual(['never']);
    expect(db.writes).toEqual([]);
  });
});
