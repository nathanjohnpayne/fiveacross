import { describe, expect, it } from 'vitest';
import {
  disposeCandidates,
  formatAuditReport,
  formatEpochMs,
  isPendingHiddenCandidate,
  parseAuditArgs,
  planPendingHiddenAudit,
  runPendingHiddenAudit,
} from './audit-pending-hidden-items.mjs';

// The pre-deploy audit for rows that may have been hidden while pending (#1275,
// ADR 0015). Pure core first, then the runner over a small in-memory Firestore
// double.

const ADMIN = 'admin-1';
const PLAYER = 'player-1';

describe('isPendingHiddenCandidate', () => {
  it('lists a hidden player row', () => {
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: PLAYER })).toBe(true);
  });

  it('never trusts approvedAt or approvedBy as provenance — a submitter could have forged them', () => {
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: PLAYER, approvedAt: 5, approvedBy: ADMIN })).toBe(true);
  });

  it('lists a row by a current Admin too — an Admin can submit through the player flow', () => {
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: ADMIN })).toBe(true);
  });

  it('skips only a seeded row', () => {
    expect(isPendingHiddenCandidate({ status: 'hidden', createdBy: 'seed' })).toBe(false);
  });

  it('only ever lists hidden rows', () => {
    for (const status of ['active', 'pending', 'rejected', undefined]) {
      expect(isPendingHiddenCandidate({ status, createdBy: PLAYER })).toBe(false);
    }
  });

  it('fails toward listing when the author is missing', () => {
    expect(isPendingHiddenCandidate({ status: 'hidden' })).toBe(true);
    expect(isPendingHiddenCandidate(null)).toBe(false);
  });
});

describe('formatEpochMs and the report', () => {
  it('never throws on a raw timestamp Date cannot represent', () => {
    expect(formatEpochMs(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(formatEpochMs(9e15)).toBe('(invalid 9000000000000000)');
    expect(formatEpochMs(Number.NaN)).toBe('(none)');
    expect(formatEpochMs('yesterday')).toBe('(none)');
    expect(formatEpochMs(undefined)).toBe('(none)');
  });

  it('renders a row whose createdAt and approvedAt are out of range', () => {
    const plan = planPendingHiddenAudit([
      { eventId: 'e', admins: [], items: [{ id: 'x', data: { status: 'hidden', createdBy: PLAYER, createdAt: 9e15, approvedAt: -9e15 } }] },
    ]);
    expect(() => formatAuditReport(plan.candidates)).not.toThrow();
    expect(formatAuditReport(plan.candidates)).toContain('createdAt=(invalid 9000000000000000)');
  });
});

describe('planPendingHiddenAudit and disposeCandidates', () => {
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
    { eventId: 'c', admins: [ADMIN], items: [{ id: 's', data: { status: 'hidden', createdBy: 'seed' } }] },
  ]);

  it('collects candidates across Events in a stable order, marking a current Admin author', () => {
    expect(plan.candidates.map((c) => `${c.eventId}/${c.itemId}`)).toEqual(['a/m', 'b/a', 'b/z']);
    expect(plan.candidates[0]).toMatchObject({ createdBy: ADMIN, authorIsAdmin: true });
    expect(plan.candidates[1]).toMatchObject({ createdBy: PLAYER, authorIsAdmin: false, createdAt: 0, text: 'early' });
    expect(formatAuditReport(plan.candidates)).toContain(`createdBy=${ADMIN} (current Admin)`);
  });

  it('splits by decision, and reports an accept that names no listed row', () => {
    const split = disposeCandidates(plan, new Set(['b/a', 'b/typo']));
    expect(split.accepted.map((c) => c.itemId)).toEqual(['a']);
    expect(split.undecided.map((c) => c.itemId)).toEqual(['m', 'z']);
    expect(split.unknown).toEqual(['b/typo']);
  });
});

describe('parseAuditArgs', () => {
  it('requires exactly one known target and accepts only --accept <event>/<item> and --requeue', () => {
    expect(parseAuditArgs(['fiveacross'])).toMatchObject({ target: 'fiveacross', projectId: 'fiveacross', requeue: false });
    const parsed = parseAuditArgs(['gaycruisebingo', '--accept', 'e/i', '--accept', 'e/j', '--requeue']);
    expect(parsed).toMatchObject({ projectId: 'gaycruisebingo', requeue: true });
    expect([...parsed.accepted]).toEqual(['e/i', 'e/j']);
    expect(() => parseAuditArgs([])).toThrow(/explicit target/);
    expect(() => parseAuditArgs(['staging'])).toThrow(/explicit target/);
    expect(() => parseAuditArgs(['fiveacross', 'gaycruisebingo'])).toThrow(/exactly one target/);
    expect(() => parseAuditArgs(['fiveacross', '--apply'])).toThrow(/unknown argument/);
    expect(() => parseAuditArgs(['fiveacross', '--accept'])).toThrow(/--accept takes/);
    expect(() => parseAuditArgs(['fiveacross', '--accept', 'just-an-item'])).toThrow(/--accept takes/);
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
    'events/e1/items/forged': { status: 'hidden', createdBy: PLAYER, approvedAt: 1 },
    'events/e1/items/seeded': { status: 'hidden', createdBy: 'seed' },
    'events/e1/items/organiser': { status: 'hidden', createdBy: ADMIN },
    'events/e1/items/live': { status: 'active', createdBy: PLAYER },
  });

  it('a read-only run lists every undecided row, writes nothing, and is not clean', async () => {
    const db = fakeDb(seedDocs());
    const result = await runPendingHiddenAudit(db, { log: quiet });
    expect(result.plan.candidates.map((c) => c.itemId)).toEqual(['forged', 'never', 'organiser']);
    expect(result.clean).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it('is clean without writing once every listed row is accepted', async () => {
    const db = fakeDb(seedDocs());
    const result = await runPendingHiddenAudit(db, {
      accepted: new Set(['e1/forged', 'e1/never', 'e1/organiser']),
      log: quiet,
    });
    expect(result.clean).toBe(true);
    expect(db.writes).toEqual([]);
  });

  it('refuses an accept that names a row the scan does not list, changing nothing', async () => {
    const db = fakeDb(seedDocs());
    await expect(
      runPendingHiddenAudit(db, { requeue: true, accepted: new Set(['e1/seeded']), log: quiet }),
    ).rejects.toThrow(/does not list: e1\/seeded/);
    expect(db.writes).toEqual([]);
  });

  it('--requeue moves exactly the undecided rows to pending, touching nothing else, and ends clean', async () => {
    const db = fakeDb(seedDocs());
    const result = await runPendingHiddenAudit(db, {
      requeue: true,
      accepted: new Set(['e1/forged', 'e1/organiser']),
      log: quiet,
    });
    expect(result.requeued.map((c) => c.itemId)).toEqual(['never']);
    expect(db.writes).toEqual([{ path: 'events/e1/items/never', data: { status: 'pending' } }]);
    expect(db.read('events/e1/items/never')).toEqual({ status: 'pending', createdBy: PLAYER, text: 'never approved' });
    expect(db.read('events/e1/items/forged').status).toBe('hidden');
    expect(result.clean).toBe(true);
  });

  it('skips a row that stopped qualifying between the scan and its transaction', async () => {
    const db = fakeDb(seedDocs());
    const original = db.runTransaction;
    db.runTransaction = async (fn) => {
      // An Admin restored the row after the scan.
      db.read('events/e1/items/never').status = 'active';
      return original(fn);
    };
    const result = await runPendingHiddenAudit(db, {
      requeue: true,
      accepted: new Set(['e1/forged', 'e1/organiser']),
      log: quiet,
    });
    expect(result.requeued).toEqual([]);
    expect(result.skipped.map((c) => c.itemId)).toEqual(['never']);
    expect(db.writes).toEqual([]);
  });
});
