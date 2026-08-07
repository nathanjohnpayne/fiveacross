// specs/admin-notification-emails.md (#638) — the admin notification digest.
//
// Three layers, each testable on its own because every one of them is pure or
// dependency-injected: what earns an alert (`alertsForWrite`), what the digest
// SAYS (`buildAdminDigestModel` / `reviewDetail` / `currentThemeDay`), and how
// it is DELIVERED (`sendAdminDigestForEvent` / `runAdminAlertSweep`) against a
// fake Firestore. No Functions runtime, no emulator, no live Resend key.
import { describe, it, expect, vi } from 'vitest';
import {
  MAX_ALERTS_PER_DIGEST,
  MAX_ATOMIC_WRITES,
  QUIET_PERIOD_MS,
  flattenLabel,
  TOMBSTONE_TTL_MS,
  alertDocId,
  drainKey,
  planDrain,
  alertsForWrite,
  currentRowFor,
  enqueueAdminAlerts,
  recordAdminAlerts,
  runAdminAlertSweep,
  sendAdminDigestForEvent,
  type AdminAlertFirestore,
  type AlertableDoc,
} from '../../functions/src/adminAlerts';
import {
  ROWS_PER_SECTION,
  buildAdminDigestModel,
  currentThemeDay,
  renderAdminDigestHtml,
  renderAdminDigestText,
  reviewDetail,
  type AdminAlertRecord,
} from '../../functions/src/adminAlertDigest';
import { EMAIL_THEME_TOKENS } from '../../functions/src/dailyEmailTheme';

// --- A minimal in-memory Firestore ----------------------------------------------
//
// Only the operations the queue and its sweep use: an equality-filtered
// `.limit().get()`, `doc(path).get()`, admin-SDK `doc(path).create()` (which
// rejects when the document exists — the enqueue's idempotency) and an
// all-or-nothing `batch()`. Paths are flat string keys, which is all the module
// needs — it never walks a hierarchy.

interface FakeDoc {
  id: string;
  data: Record<string, unknown>;
}

function fakeDb(
  seed: Record<string, Record<string, unknown>[]> = {},
  docs: Record<string, Record<string, unknown>> = {},
  /** Collection or document paths whose `.get()` rejects — the injectable
   *  backend failure. */
  throwOn: readonly string[] = [],
  /** When true, the tombstone batch rejects — the atomic-clean-up failure. */
  failCommit = false,
  /** When true, the CLAIM batch rejects — the pre-send identity failure. */
  failClaim = false,
) {
  const collections = new Map<string, FakeDoc[]>();
  let autoId = 0;
  for (const [path, rows] of Object.entries(seed)) {
    collections.set(
      path,
      rows.map((data, i) => ({ id: (data.id as string) ?? `a${i + 1}`, data: { ...data } })),
    );
  }
  const singles = new Map<string, Record<string, unknown>>(Object.entries(docs));

  const makeQuery = (path: string, filters: Array<[string, unknown]>, cap: number | null) => {
    const query = {
      where: (field: string, _op: string, value: unknown) =>
        makeQuery(path, [...filters, [field, value]], cap),
      limit: (count: number) => makeQuery(path, filters, count),
      get: async () => {
        if (throwOn.includes(path)) throw new Error(`backend unavailable: ${path}`);
        let rows = collections.get(path) ?? [];
        for (const [field, value] of filters) {
          rows = rows.filter((row) => (row.data[field] ?? null) === value);
        }
        if (cap !== null) rows = rows.slice(0, cap);
        return { docs: rows.map((row) => ({ id: row.id, data: () => ({ ...row.data }) })) };
      },
      add: async (data: Record<string, unknown>) => {
        const id = `auto${++autoId}`;
        const rows = collections.get(path) ?? [];
        rows.push({ id, data: { ...data } });
        collections.set(path, rows);
        return { id };
      },
    };
    return query;
  };

  const split = (path: string) => {
    const slash = path.lastIndexOf('/');
    return { collectionPath: path.slice(0, slash), id: path.slice(slash + 1) };
  };
  const findRow = (path: string) => {
    const { collectionPath, id } = split(path);
    return (collections.get(collectionPath) ?? []).find((r) => r.id === id);
  };

  const docRef = (path: string) => ({
    path,
    get: async () => {
      if (throwOn.includes(path)) throw new Error(`backend unavailable: ${path}`);
      const single = singles.get(path);
      if (single) return { data: () => ({ ...single }) };
      const found = findRow(path);
      return { data: () => (found ? { ...found.data } : undefined) };
    },
    // Admin-SDK `create` semantics: reject if the document already exists.
    create: async (data: Record<string, unknown>) => {
      if (findRow(path)) {
        const err = new Error('already exists') as Error & { code?: number };
        err.code = 6;
        throw err;
      }
      const { collectionPath, id } = split(path);
      const rows = collections.get(collectionPath) ?? [];
      rows.push({ id, data: { ...data } });
      collections.set(collectionPath, rows);
      return undefined;
    },
  });

  const db = {
    collection: (path: string) => makeQuery(path, [], null),
    doc: docRef,
    // An all-or-nothing WriteBatch: writes are staged and applied only on a
    // clean commit, exactly like the admin SDK's. `set` REPLACES the document,
    // which is what turns a drained row into a payload-free tombstone.
    batch: () => {
      const staged: Array<[string, Record<string, unknown>, boolean]> = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          staged.push([ref.path, data, options?.merge === true]);
        },
        commit: async () => {
          if (failCommit && !staged.every(([, , merge]) => merge)) throw new Error('batch commit failed');
          if (failClaim && staged.every(([, , merge]) => merge)) throw new Error('batch claim failed');
          for (const [path, data, merge] of staged) {
            const { collectionPath, id } = split(path);
            const rows = collections.get(collectionPath) ?? [];
            const found = rows.find((r) => r.id === id);
            if (found) found.data = merge ? { ...found.data, ...data } : { ...data };
            else rows.push({ id, data: { ...data } });
            collections.set(collectionPath, rows);
          }
          return undefined;
        },
      };
    },
    // A serial transaction: reads see current state, writes apply on return.
    // Enough for the exclusive claim, whose whole content is read-then-set.
    runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      if (failClaim) throw new Error('transaction failed');
      const writes: Array<[string, Record<string, unknown>, boolean]> = [];
      const result = await fn({
        get: async (ref: { path: string }) => {
          const found = findRow(ref.path);
          return { data: () => (found ? { ...found.data } : undefined) };
        },
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          writes.push([ref.path, data, options?.merge === true]);
        },
      });
      for (const [path, data, merge] of writes) {
        const { collectionPath, id } = split(path);
        const rows = collections.get(collectionPath) ?? [];
        const found = rows.find((r) => r.id === id);
        if (found) found.data = merge ? { ...found.data, ...data } : { ...data };
        else rows.push({ id, data: { ...data } });
        collections.set(collectionPath, rows);
      }
      return result;
    },
    /** Test-only reader. */
    rows: (path: string) => (collections.get(path) ?? []).map((r) => ({ id: r.id, ...r.data })),
  };
  return db as unknown as AdminAlertFirestore & { rows: (path: string) => Record<string, unknown>[] };
}

const ITEM = (over: Partial<AlertableDoc> = {}): AlertableDoc => ({
  status: 'active',
  reportCount: 0,
  text: 'Spot a speedo at breakfast',
  ...over,
});

const ALERT = (over: Partial<AdminAlertRecord> = {}): AdminAlertRecord => ({
  id: 'a1',
  kind: 'content-reported',
  collection: 'items',
  docId: 'i1',
  label: 'Spot a speedo at breakfast',
  status: 'active',
  visionFlag: null,
  reportCount: 1,
  createdAt: 1_000,
  ...over,
});

const EVENT = {
  name: 'Trieste → Barcelona',
  days: [
    { index: 0, unlockAt: 1_000, theme: 'welcome-aboard' },
    { index: 1, unlockAt: 2_000, theme: 'sporty-splash' },
    { index: 2, unlockAt: 9_000, theme: 'revival-disco' },
  ],
  settings: { reportHideThreshold: 4 },
};

const NOW = 5_000;

// --- What earns an alert ---------------------------------------------------------

describe('alertsForWrite', () => {
  it('queues item-created for a player submission landing pending, and for nothing else on the items path', () => {
    // `addItem` (the player path) writes status: 'pending'.
    expect(alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' })).map((a) => a.kind)).toEqual([
      'item-created',
    ]);
    // `adminAddItem` and every seed write 'active' — an admin's own Prompt notifies nobody.
    expect(alertsForWrite('items', 'i1', undefined, ITEM({ status: 'active' }))).toEqual([]);
    // The admin's approval (pending → active) is not news; it IS the response.
    expect(alertsForWrite('items', 'i1', ITEM({ status: 'pending' }), ITEM({ status: 'active' }))).toEqual([]);
    // A same-status re-write of a pending Prompt does not re-queue it.
    expect(alertsForWrite('items', 'i1', ITEM({ status: 'pending' }), ITEM({ status: 'pending' }))).toEqual([]);
    // A delete leaves nothing to review.
    expect(alertsForWrite('items', 'i1', ITEM({ status: 'pending' }), undefined)).toEqual([]);
  });

  it('never queues item-created on the proofs path — a Proof has no approval queue', () => {
    expect(alertsForWrite('proofs', 'p1', undefined, { status: 'pending' })).toEqual([]);
  });

  it('queues content-reported only when reportCount strictly ROSE', () => {
    const kinds = (before: AlertableDoc | undefined, after: AlertableDoc) =>
      alertsForWrite('items', 'i1', before, after).map((a) => a.kind);
    // The explicit report action.
    expect(kinds(ITEM({ reportCount: 1 }), ITEM({ reportCount: 2 }))).toEqual(['content-reported']);
    // An admin Clear-reports is a FALL, not a rise.
    expect(kinds(ITEM({ reportCount: 5 }), ITEM({ reportCount: 0 }))).toEqual([]);
    // A restore leaves the count alone — `status` goes active, nothing rises.
    expect(kinds(ITEM({ status: 'hidden', reportCount: 5 }), ITEM({ status: 'active', reportCount: 5 }))).toEqual([]);
    // A create already carrying reports is a rise from zero.
    expect(kinds(undefined, ITEM({ reportCount: 2 }))).toEqual(['content-reported']);
  });

  it('queues moderation on a transition INTO flagged/hidden, including a create straight into one', () => {
    const kinds = (before: AlertableDoc | undefined, after: AlertableDoc) =>
      alertsForWrite('proofs', 'p1', before, after).map((a) => a.kind);
    expect(kinds({ status: 'active' }, { status: 'hidden' })).toEqual(['moderation']);
    // moderateProof's merge-set can create the doc already flagged (#101 Codex F2).
    expect(kinds(undefined, { status: 'flagged', visionFlag: 'violence' })).toEqual(['moderation']);
    // A same-status re-write, a restore, and a create into active are all quiet.
    expect(kinds({ status: 'hidden' }, { status: 'hidden' })).toEqual([]);
    expect(kinds({ status: 'hidden' }, { status: 'active' })).toEqual([]);
    expect(kinds(undefined, { status: 'active' })).toEqual([]);
  });

  it('queues both alerts for a single hide-plus-report write', () => {
    const kinds = alertsForWrite(
      'items',
      'i1',
      ITEM({ status: 'active', reportCount: 3 }),
      ITEM({ status: 'hidden', reportCount: 4 }),
    ).map((a) => a.kind);
    expect(kinds).toEqual(['content-reported', 'moderation']);
  });

  it('labels an item with its own words and a proof with its Prompt text, falling back to the doc id', () => {
    expect(alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' }))[0].label).toBe(
      'Spot a speedo at breakfast',
    );
    expect(
      alertsForWrite('proofs', 'p1', { status: 'active' }, { status: 'hidden', itemText: 'Deck wine' })[0].label,
    ).toBe('Deck wine');
    expect(alertsForWrite('proofs', 'p9', { status: 'active' }, { status: 'hidden' })[0].label).toBe('p9');
    // Whitespace-only text is not a label.
    expect(alertsForWrite('items', 'i7', undefined, ITEM({ status: 'pending', text: '   ' }))[0].label).toBe('i7');
  });

  it('clips a runaway label rather than mailing an essay', () => {
    const label = alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending', text: 'x'.repeat(500) }))[0]
      .label;
    expect(label.length).toBe(80);
    expect(label.endsWith('…')).toBe(true);
  });
});

// --- Producing -------------------------------------------------------------------

describe('enqueueAdminAlerts', () => {
  it('writes sentAt: null EXPLICITLY, so the drain query can find the alert at all', async () => {
    const db = fakeDb();
    await enqueueAdminAlerts(
      db,
      'med-2026',
      alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' })),
      'evt-1',
      { now: () => 42 },
    );
    const [row] = db.rows('events/med-2026/adminAlerts');
    // Firestore's equality filter matches a stored null but NOT a missing field.
    expect(row.sentAt).toBeNull();
    expect('sentAt' in row).toBe(true);
    expect(row.createdAt).toBe(42);
    expect(row.kind).toBe('item-created');
  });

  it('is idempotent under trigger REDELIVERY — the same CloudEvent id is one alert, not two', async () => {
    // Firestore redelivers a document-write event on retry with the SAME
    // CloudEvent id. A random-id `add` would mint a second alert for one
    // transition — a duplicate row before a drain, and a whole second email if
    // the redelivery lands after one.
    const db = fakeDb();
    const drafts = alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' }));
    expect(await enqueueAdminAlerts(db, 'e', drafts, 'evt-1')).toBe(1);
    expect(await enqueueAdminAlerts(db, 'e', drafts, 'evt-1')).toBe(0); // redelivery: no-op
    expect(db.rows('events/e/adminAlerts')).toHaveLength(1);
    // A genuinely DISTINCT write carries a distinct id and does queue.
    expect(await enqueueAdminAlerts(db, 'e', drafts, 'evt-2')).toBe(1);
    expect(db.rows('events/e/adminAlerts')).toHaveLength(2);
  });

  it('gives one write’s two alerts distinct ids, so neither collides with the other', async () => {
    const db = fakeDb();
    const drafts = alertsForWrite(
      'items',
      'i1',
      ITEM({ status: 'active', reportCount: 3 }),
      ITEM({ status: 'hidden', reportCount: 4 }),
    );
    expect(await enqueueAdminAlerts(db, 'e', drafts, 'evt-1')).toBe(2);
    expect(db.rows('events/e/adminAlerts').map((r) => r.id).sort()).toEqual([
      'evt-1-content-reported',
      'evt-1-moderation',
    ]);
  });

  it('sanitizes a document id so a stray slash cannot reparent the write', () => {
    // `/` would reparent, and `.`/`..` are reserved document ids in Firestore —
    // both are collapsed to underscores.
    expect(alertDocId('evt/../other', 'moderation')).toBe('evt____other-moderation');
    expect(alertDocId('', 'moderation')).toBe('unknown-moderation');
    expect(alertDocId('x'.repeat(400), 'moderation').length).toBeLessThanOrEqual(211);
  });

  it('never throws when the queue write fails — a mail concern must not fail a moderation write', async () => {
    const db = {
      collection: () => ({ get: async () => ({ docs: [] }) }),
      doc: () => ({
        get: async () => ({ data: () => undefined }),
        create: async () => Promise.reject(new Error('firestore down')),
      }),
      batch: () => ({ set: () => undefined, commit: async () => undefined }),
      runTransaction: async () => undefined,
    } as unknown as AdminAlertFirestore;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      recordAdminAlerts(db, 'items', 'e', 'i1', 'evt-1', undefined, ITEM({ status: 'pending' })),
    ).resolves.toBe(0);
    spy.mockRestore();
  });

  it('writes nothing at all for a write that earns nothing', async () => {
    const db = fakeDb();
    expect(await recordAdminAlerts(db, 'items', 'e', 'i1', 'evt-1', ITEM(), ITEM())).toBe(0);
    expect(db.rows('events/e/adminAlerts')).toEqual([]);
  });
});

// --- Revalidation at send time ---------------------------------------------------

describe('currentRowFor', () => {
  it('drops an approval alert whose Prompt is no longer pending', () => {
    const alert = ALERT({ kind: 'item-created', status: 'pending' });
    // Approved, rejected or hidden inside the batching window — the work is done.
    expect(currentRowFor(alert, ITEM({ status: 'active' }), false)).toBeNull();
    expect(currentRowFor(alert, ITEM({ status: 'rejected' }), false)).toBeNull();
    expect(currentRowFor(alert, ITEM({ status: 'pending' }), false)?.kind).toBe('item-created');
  });

  it('drops a report alert once the content is restored AND the reports are cleared', () => {
    const alert = ALERT({ kind: 'content-reported', reportCount: 3 });
    expect(currentRowFor(alert, ITEM({ status: 'active', reportCount: 0 }), false)).toBeNull();
    // A restore that left the count alone is still live work.
    expect(currentRowFor(alert, ITEM({ status: 'active', reportCount: 3 }), false)?.kind).toBe('content-reported');
  });

  it('drops any alert whose content was deleted', () => {
    expect(currentRowFor(ALERT(), undefined, false)).toBeNull();
    expect(currentRowFor(ALERT({ kind: 'item-created', status: 'pending' }), undefined, false)).toBeNull();
  });

  it('takes the KIND from the live document, which is what fixes the out-of-order collapse', () => {
    // The report write and the auto-hide write reach two independent trigger
    // invocations whose handler wall-clocks can interleave, so `createdAt`
    // cannot say which state is newer. The document can.
    const staleReport = ALERT({ kind: 'content-reported', reportCount: 4, createdAt: 9_999 });
    const row = currentRowFor(staleReport, ITEM({ status: 'hidden', reportCount: 4 }), false);
    expect(row?.kind).toBe('moderation');
    expect(row?.status).toBe('hidden');
  });

  it('refreshes the counts, so the email never states a stale report total', () => {
    const row = currentRowFor(ALERT({ reportCount: 1 }), ITEM({ status: 'active', reportCount: 6 }), false);
    expect(row?.reportCount).toBe(6);
  });

  it('FAILS OPEN on a read error — an unreported moderation alert is worse than a stale one', () => {
    const alert = ALERT({ kind: 'moderation', status: 'hidden' });
    expect(currentRowFor(alert, undefined, true)).toEqual(alert);
  });
});

// --- What the digest says --------------------------------------------------------

describe('currentThemeDay', () => {
  it('picks the most recently unlocked Day, so a mid-cruise digest wears today’s palette', () => {
    expect(currentThemeDay(EVENT.days, NOW)?.theme).toBe('sporty-splash');
  });

  it('falls back to the first Day before the Event has started', () => {
    expect(currentThemeDay(EVENT.days, 0)?.theme).toBe('welcome-aboard');
  });

  it('ignores the unlockAt:0 live-pre-event sentinel rather than treating it as unlocked', () => {
    const days = [{ index: 0, unlockAt: 0, theme: 'welcome-aboard' }, { index: 1, unlockAt: 2_000, theme: 'marquee' }];
    expect(currentThemeDay(days, 1_000)?.theme).toBe('welcome-aboard'); // the [0] fallback, not the sentinel match
    expect(currentThemeDay(days, 3_000)?.theme).toBe('marquee');
  });

  it('returns undefined for an Event with no schedule, so the EDITION default takes over', () => {
    expect(currentThemeDay([], NOW)).toBeUndefined();
    expect(currentThemeDay(undefined, NOW)).toBeUndefined();
    const model = buildAdminDigestModel({
      event: { name: 'Bodega', days: [] },
      eventId: 'e',
      alerts: [ALERT()],
      edition: 'vacay',
      origin: 'https://vacaybingo.com',
      now: NOW,
    });
    // Vacay's own default Theme — never grey, never another product's identity.
    expect(model.theme).toEqual(EMAIL_THEME_TOKENS['the-birds']);
  });
});

describe('reviewDetail', () => {
  it('derives the cause from stored facts and never fabricates a threshold', () => {
    const mod = (over: Partial<AdminAlertRecord>) => ALERT({ kind: 'moderation', ...over });
    expect(reviewDetail(mod({ status: 'hidden', reportCount: 4 }), 4)).toBe('hidden (reports >= threshold) · 4 reports');
    expect(reviewDetail(mod({ status: 'hidden', reportCount: 1 }), 4)).toBe('hidden (by an admin) · 1 report');
    expect(reviewDetail(mod({ status: 'hidden', reportCount: 1 }), null)).toBe('hidden · 1 report');
    expect(reviewDetail(mod({ status: 'flagged', visionFlag: 'violence', reportCount: 0 }), 4)).toBe(
      'flagged (violence) · 0 reports',
    );
  });

  it('states the distance to the auto-hide bar for a live report', () => {
    expect(reviewDetail(ALERT({ reportCount: 1 }), 4)).toBe('reported · 1 report · 3 more to auto-hide');
    expect(reviewDetail(ALERT({ reportCount: 3 }), 4)).toBe('reported · 3 reports · 1 more to auto-hide');
    // At/over the bar there is no distance left to state.
    expect(reviewDetail(ALERT({ reportCount: 4 }), 4)).toBe('reported · 4 reports');
    // No threshold configured → no claim about auto-hiding.
    expect(reviewDetail(ALERT({ reportCount: 2 }), null)).toBe('reported · 2 reports');
  });
});

describe('buildAdminDigestModel', () => {
  const build = (alerts: AdminAlertRecord[], over: Partial<Parameters<typeof buildAdminDigestModel>[0]> = {}) =>
    buildAdminDigestModel({
      event: EVENT,
      eventId: 'med-2026',
      alerts,
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
      ...over,
    });

  it('renders both modules and names both counts', () => {
    const model = build([
      ALERT({ id: 'a1', kind: 'item-created', docId: 'i1', label: 'Spot a speedo', status: 'pending' }),
      ALERT({ id: 'a2', kind: 'content-reported', docId: 'i2', label: 'Rude one', reportCount: 2, createdAt: 2_000 }),
    ]);
    expect(model.sections.map((s) => s.heading)).toEqual(['Awaiting approval', 'Reported & hidden']);
    expect(model.subject).toBe('Admin · Trieste → Barcelona—1 to approve, 1 to review');
    expect(model.preheader).toBe('2 items in the review queue for Trieste → Barcelona.');
    expect(model.sections[0].rows).toEqual([{ label: 'Spot a speedo', detail: 'new Prompt · pending approval' }]);
    expect(model.sections[1].rows[0].label).toBe('Prompt: Rude one');
  });

  it('omits a module with no rows rather than rendering an empty one', () => {
    const model = build([ALERT({ kind: 'item-created', status: 'pending' })]);
    expect(model.sections.map((s) => s.heading)).toEqual(['Awaiting approval']);
    expect(model.subject).toBe('Admin · Trieste → Barcelona—1 to approve');
  });

  it('collapses a report and the auto-hide it caused into ONE row carrying the hide', () => {
    const model = build([
      ALERT({ id: 'a1', kind: 'content-reported', docId: 'i1', reportCount: 4, createdAt: 1_000 }),
      ALERT({ id: 'a2', kind: 'moderation', docId: 'i1', status: 'hidden', reportCount: 4, createdAt: 1_100 }),
    ]);
    const review = model.sections.find((s) => s.heading === 'Reported & hidden');
    expect(review?.rows).toHaveLength(1);
    expect(review?.rows[0].detail).toBe('hidden (reports >= threshold) · 4 reports');
    // Two things did not happen to two things.
    expect(model.subject).toBe('Admin · Trieste → Barcelona—1 to review');
  });

  it('does NOT collapse approvals — each pending Prompt is its own piece of work', () => {
    const model = build([
      ALERT({ id: 'a1', kind: 'item-created', docId: 'i1', label: 'One', status: 'pending' }),
      ALERT({ id: 'a2', kind: 'item-created', docId: 'i2', label: 'Two', status: 'pending', createdAt: 1_100 }),
    ]);
    expect(model.sections[0].rows.map((r) => r.label)).toEqual(['One', 'Two']);
  });

  it('states the overflow rather than truncating silently', () => {
    const many = Array.from({ length: ROWS_PER_SECTION + 7 }, (_, i) =>
      ALERT({ id: `a${i}`, kind: 'item-created', docId: `i${i}`, label: `P${i}`, status: 'pending', createdAt: i }),
    );
    const section = build(many).sections[0];
    expect(section.rows).toHaveLength(ROWS_PER_SECTION);
    expect(section.overflow).toBe(7);
    expect(renderAdminDigestHtml(build(many))).toContain('+7 more in the Review queue');
  });

  it('deep-links the Review queue, not the /admin route that goes nowhere', () => {
    // `/admin` matches no route in the app — the console lives at
    // /more/admin[/section] (specs/admin-console-ia.md), and the pre-#638
    // notifier linked the dead one.
    expect(build([ALERT()]).ctaUrl).toBe('https://gaycruisebingo.com/more/admin/queue');
  });

  it('carries the Edition brand line and the Day’s Theme', () => {
    const model = build([ALERT()], { edition: 'vacay' });
    expect(model.brandLine).toBe('Vacay Bingo · by Five Across · Admin');
    expect(model.footerBrandLine).toBe('Vacay Bingo · by Five Across');
    expect(model.theme).toEqual(EMAIL_THEME_TOKENS['sporty-splash']);
    expect(model.contextLine).toBe('Trieste → Barcelona · Day 2 of 3 · 💦 Sporty Splash');
  });
});

// --- Rendering -------------------------------------------------------------------

describe('renderAdminDigestHtml', () => {
  const model = buildAdminDigestModel({
    event: EVENT,
    eventId: 'med-2026',
    alerts: [
      ALERT({ id: 'a1', kind: 'item-created', docId: 'i1', label: 'Spot a speedo', status: 'pending' }),
      ALERT({ id: 'a2', kind: 'moderation', docId: 'p1', collection: 'proofs', status: 'hidden', reportCount: 4 }),
    ],
    edition: 'gcb',
    origin: 'https://gaycruisebingo.com',
    now: NOW,
  });

  it('renders the wireframe’s email-safe shell', () => {
    const html = renderAdminDigestHtml(model);
    expect(html).toContain('width="600"'); // 600px single-column table
    expect(html).not.toMatch(/display:\s*(flex|grid)/); // Outlook renders through Word
    expect(html).not.toContain('var(--'); // Gmail resolves no custom properties
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('name="supported-color-schemes" content="light dark"');
    expect(html).toContain('v:roundrect'); // the Outlook VML half of the bulletproof CTA
    expect(html).not.toContain('<img'); // the CTA survives image blocking
    expect(html).toContain("'Bebas Neue','Arial Narrow',Arial");
    expect(html).toContain('Open the Review queue');
  });

  it('carries no unsubscribe link — this is operational mail, not engagement mail', () => {
    const html = renderAdminDigestHtml(model);
    expect(html.toLowerCase()).not.toContain('unsubscribe');
    expect(html).toContain('Admin alerts are batched');
  });

  it('escapes an unapproved Prompt’s own words', () => {
    // The one string here most likely to contain markup arrives straight from a
    // user submission that nobody has approved yet.
    const hostile = buildAdminDigestModel({
      event: EVENT,
      eventId: 'e',
      alerts: [
        ALERT({ kind: 'item-created', status: 'pending', label: '<script>alert("x")</script>' }),
      ],
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
    });
    const html = renderAdminDigestHtml(hostile);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses a non-https link', () => {
    const bad = buildAdminDigestModel({
      event: EVENT,
      eventId: 'e',
      alerts: [ALERT()],
      edition: 'gcb',
      origin: 'javascript:alert(1)//',
      now: NOW,
    });
    const html = renderAdminDigestHtml(bad);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });

  it('paints every module on a light Theme, so dark-mode inversion has nothing to grab', () => {
    const light = buildAdminDigestModel({
      event: { ...EVENT, days: [{ index: 0, unlockAt: 1_000, theme: 'fog-froth-farewells' }] },
      eventId: 'e',
      alerts: [ALERT()],
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
    });
    const tokens = EMAIL_THEME_TOKENS['fog-froth-farewells'];
    const html = renderAdminDigestHtml(light);
    expect(html).toContain(`bgcolor="${tokens.panel}"`);
    expect(html).toContain(`color:${tokens.ink}`);
    expect(html).toContain(`background-color:${tokens.bg}`);
  });
});

describe('renderAdminDigestText', () => {
  it('mirrors the module order so multipart/alternative degrades to something triage-able', () => {
    const model = buildAdminDigestModel({
      event: EVENT,
      eventId: 'e',
      alerts: [
        ALERT({ id: 'a1', kind: 'item-created', docId: 'i1', label: 'Spot a speedo', status: 'pending' }),
        ALERT({ id: 'a2', kind: 'content-reported', docId: 'i2', label: 'Rude one', reportCount: 2, createdAt: 2_000 }),
      ],
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
    });
    const text = renderAdminDigestText(model);
    expect(text.indexOf('AWAITING APPROVAL')).toBeLessThan(text.indexOf('REPORTED & HIDDEN'));
    expect(text.indexOf('REPORTED & HIDDEN')).toBeLessThan(text.indexOf('Open the Review queue:'));
    expect(text).toContain('- Spot a speedo—new Prompt · pending approval');
    expect(text).toContain('https://gaycruisebingo.com/more/admin/queue');
  });
});

// --- Delivery --------------------------------------------------------------------

describe('planDrain', () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({ id, createdAt: 0, ...over });

  it('claims the settled rows as a new batch when nothing is claimed yet', () => {
    const plan = planDrain([row('a1'), row('a2')], 10_000, 1_000);
    expect(plan).toEqual({ batchId: 'a2/2', ids: ['a1', 'a2'], claimNeeded: true });
  });

  it('leaves rows still inside the settling period for the next sweep', () => {
    // A burst straddling the scheduler boundary would otherwise be snapshotted
    // mid-write and split across two emails.
    expect(planDrain([row('a1', { createdAt: 9_500 })], 10_000, 1_000)).toEqual({ reason: 'settling' });
    // Mixed: only the settled prefix is taken.
    const plan = planDrain([row('a1', { createdAt: 0 }), row('a2', { createdAt: 9_900 })], 10_000, 1_000);
    expect(plan).toEqual({ batchId: 'a1/1', ids: ['a1'], claimNeeded: true });
  });

  it('REUSES an existing claim and ignores everything queued since', () => {
    // The retry case. Taking the newcomer too would mint a different key and
    // re-deliver every row the first attempt already sent.
    const plan = planDrain(
      [row('a1', { batchId: 'b/2' }), row('a2', { batchId: 'b/2' }), row('a3')],
      10_000,
      1_000,
    );
    expect(plan).toEqual({ batchId: 'b/2', ids: ['a1', 'a2'], claimNeeded: false });
  });

  it('takes a claimed batch even while it would still be settling', () => {
    // It has already been mailed once; waiting again would only delay the retry.
    const plan = planDrain([row('a1', { batchId: 'b/1', createdAt: 9_999 })], 10_000, 1_000);
    expect(plan).toEqual({ batchId: 'b/1', ids: ['a1'], claimNeeded: false });
  });

  it('picks the lowest batch id deterministically when several are present', () => {
    const plan = planDrain([row('a1', { batchId: 'z/1' }), row('a2', { batchId: 'b/1' })], 10_000, 1_000);
    expect(plan).toEqual({ batchId: 'b/1', ids: ['a2'], claimNeeded: false });
  });
});

describe('sendAdminDigestForEvent', () => {
  const deps = (send: ReturnType<typeof vi.fn>) => ({
    send: send as never,
    getAdminUids: async () => ['u1'],
    getEmailForUid: async (uid: string) => `${uid}@example.com`,
    adminNotifyEmail: '',
    appBaseUrl: 'https://gaycruisebingo.com',
    from: 'Gay Cruise Bingo <bingo@example.com>',
    now: () => NOW,
    // The settling period has its own tests; everywhere else the fixture rows
    // are already old, so this only keeps the intent explicit.
    quietMs: 0,
  });

  const pendingAlert = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: 'item-created',
    collection: 'items',
    docId: `i-${id}`,
    label: `Prompt ${id}`,
    status: 'pending',
    visionFlag: null,
    reportCount: 0,
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    sentAt: null,
    ...over,
  });

  /** Seed a queue AND the live content each alert points at, since the drain
   *  re-reads every referenced document before it renders a row. */
  const seeded = (
    alerts: Record<string, unknown>[],
    hostnames: Record<string, unknown>[] = [],
    liveOver: Record<string, Record<string, unknown>> = {},
    opts: { throwOn?: string[]; failCommit?: boolean; failClaim?: boolean } = {},
  ) => {
    const live: Record<string, Record<string, unknown>> = { 'events/med-2026': EVENT };
    for (const a of alerts) {
      const path = `events/med-2026/${a.collection}/${a.docId}`;
      live[path] = { status: a.status, reportCount: a.reportCount ?? 0, visionFlag: a.visionFlag ?? null };
    }
    return fakeDb(
      { 'events/med-2026/adminAlerts': alerts, hostnames, events: [{ id: 'med-2026', status: 'active' }] },
      { ...live, ...liveOver },
      opts.throwOn ?? [],
      opts.failCommit ?? false,
      opts.failClaim ?? false,
    );
  };

  it('sends ONE digest for a burst of eighty pending Prompts', async () => {
    // The acceptance criterion in its most literal form: a pool import writes
    // eighty rows in a second and the admins get one email.
    const send = vi.fn(async () => true);
    const db = seeded(Array.from({ length: 80 }, (_, i) => pendingAlert(`a${i + 1}`)));
    const result = await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    expect(result).toEqual({ sent: 80, retired: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0] as { subject: string; to: string[]; html: string };
    expect(arg.subject).toBe('Admin · Trieste → Barcelona—80 to approve');
    expect(arg.to).toEqual(['u1@example.com']);
    expect(arg.html).toContain(`+${80 - ROWS_PER_SECTION} more in the Review queue`);
  });

  it('is idempotent across sweeps, and leaves a payload-free tombstone behind', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1'), pendingAlert('a2')]);
    expect((await sendAdminDigestForEvent(db, 'med-2026', deps(send))).sent).toBe(2);
    // The row is REPLACED, not stamped: its copy of unapproved content is gone,
    // so nothing outlives the moderation decision it described...
    const rows = db.rows('events/med-2026/adminAlerts');
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([
      ['expiresAt', 'id', 'sentAt'],
      ['expiresAt', 'id', 'sentAt'],
    ]);
    // A Date, NOT epoch millis: Firestore's TTL service only considers a
    // timestamp-typed field, so a number would leave the documented policy
    // configured and reaping nothing.
    expect(rows[0].expiresAt).toBeInstanceOf(Date);
    expect((rows[0].expiresAt as Date).getTime()).toBe(NOW + TOMBSTONE_TTL_MS);
    // ...but the ID survives, which is what keeps the redelivery dedup honest.
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 0,
      reason: 'no-alerts',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a REDELIVERED trigger for an already-mailed transition does not re-queue it', async () => {
    // The hole a plain delete would have opened: `create` succeeds again once
    // the row is gone, so a delayed redelivery mails the same transition twice.
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('evt-9-item-created', { docId: 'i1' })]);
    await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    const drafts = alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' }));
    expect(await enqueueAdminAlerts(db, 'med-2026', drafts, 'evt-9')).toBe(0);
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 0,
      reason: 'no-alerts',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keys the send by the RAW drained page, and an ATOMIC clean-up keeps it stable on retry', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1'), pendingAlert('a2')], [], {}, { failCommit: true });
    await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    const key = (send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey;
    expect(key).toBe('admin-digest/med-2026/a2/2');
    // The clean-up failed, so EVERY alert is still pending — never a subset.
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toHaveLength(2);
    await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    expect((send.mock.calls[1][0] as { idempotencyKey: string }).idempotencyKey).toBe(key);
  });

  it('CLAIMS the delivery identity before sending, and persists it on every drained row', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1'), pendingAlert('a2')], [], {}, { failCommit: true });
    await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    const key = (send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey;
    expect(key).toBe('admin-digest/med-2026/a2/2');
    // The clean-up failed, so every row is still pending — and every one of
    // them carries the batch id the email went out under.
    const pending = db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null);
    expect(pending).toHaveLength(2);
    expect(pending.map((r) => r.batchId)).toEqual(['a2/2', 'a2/2']);
    // The claim MERGES: the payload the digest renders must survive it.
    expect(pending[0].label).toBe('Prompt a1');
  });

  it('keeps the retry key stable when a row RESOLVES between the send and the retry', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1'), pendingAlert('a2')], [], {}, { failCommit: true });
    await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    const key = (send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey;

    // An admin approves one of the two Prompts before the retry. A key derived
    // from the RENDERED rows would move with it and Resend would accept a
    // second email repeating everything still unresolved.
    const resolved = seeded([pendingAlert('a1', { batchId: 'a2/2' }), pendingAlert('a2', { batchId: 'a2/2' })], [], {
      'events/med-2026/items/i-a1': { status: 'active', reportCount: 0 },
    });
    const result = await sendAdminDigestForEvent(resolved, 'med-2026', deps(send));
    expect(result.sent).toBe(1); // one row genuinely dropped out of the email...
    expect((send.mock.calls[1][0] as { idempotencyKey: string }).idempotencyKey).toBe(key);
  });

  it('keeps the retry key stable when a NEW alert ARRIVES between the send and the retry', async () => {
    // The mirror hole: atomic clean-up preserves the old rows but cannot stop
    // the queue growing, so a page-derived key would move and Resend would
    // accept a second email repeating every delivered row beside the new one.
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1'), pendingAlert('a2')], [], {}, { failCommit: true });
    await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    const key = (send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey;

    const grown = seeded(
      [
        pendingAlert('a1', { batchId: 'a2/2' }),
        pendingAlert('a2', { batchId: 'a2/2' }),
        pendingAlert('a3'), // queued after the failed clean-up
      ],
      [],
    );
    const result = await sendAdminDigestForEvent(grown, 'med-2026', deps(send));
    expect(result.sent).toBe(2); // the CLAIMED rows only — a3 is not in this batch
    expect((send.mock.calls[1][0] as { idempotencyKey: string }).idempotencyKey).toBe(key);
    // The newcomer waits, and goes out as its own batch on the next sweep.
    expect(grown.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null).map((r) => r.id)).toEqual([
      'a3',
    ]);
  });

  it('sends NOTHING when the claim itself fails — an unpersisted key is worse than a delay', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1')], [], {}, { failClaim: true });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 0,
      reason: 'claim-failed',
    });
    spy.mockRestore();
    expect(send).not.toHaveBeenCalled();
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toHaveLength(1);
  });

  it('waits out the settling period, so a burst straddling the sweep is not split in two', async () => {
    const send = vi.fn(async () => true);
    // Written 10s ago — a burst may still be in flight.
    const db = seeded([pendingAlert('a1', { createdAt: NOW - 10_000 })]);
    expect(
      await sendAdminDigestForEvent(db, 'med-2026', { ...deps(send), quietMs: QUIET_PERIOD_MS }),
    ).toEqual({ sent: 0, retired: 0, reason: 'settling' });
    expect(send).not.toHaveBeenCalled();
    // The whole burst goes out together on a later sweep.
    const later = { ...deps(send), quietMs: QUIET_PERIOD_MS, now: () => NOW + QUIET_PERIOD_MS };
    expect((await sendAdminDigestForEvent(db, 'med-2026', later)).sent).toBe(1);
  });

  it('reduces the drain key order-independently — the query carries no orderBy', () => {
    expect(drainKey(['a1', 'a2', 'b0'])).toBe('b0/3');
    expect(drainKey(['b0', 'a2', 'a1'])).toBe('b0/3');
    expect(drainKey([])).toBe('empty/0');
  });

  it('leaves alerts queued when the send fails, so nothing is silently dropped', async () => {
    const send = vi.fn(async () => false);
    const db = seeded([pendingAlert('a1')]);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 0,
      reason: 'send-failed',
    });
    expect(db.rows('events/med-2026/adminAlerts')).toHaveLength(1);
  });

  it('leaves alerts queued when no admin email resolves', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1')]);
    const result = await sendAdminDigestForEvent(db, 'med-2026', {
      ...deps(send),
      getAdminUids: async () => [],
      getEmailForUid: async () => null,
    });
    expect(result).toEqual({ sent: 0, retired: 0, reason: 'no-recipients' });
    expect(send).not.toHaveBeenCalled();
    // They drain on the first sweep after a recipient exists, rather than being lost.
    expect(db.rows('events/med-2026/adminAlerts')).toHaveLength(1);
  });

  it('does NOT mail a Prompt that was approved inside the batching window', async () => {
    // The subject and preheader claim these items are in the review queue NOW.
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1'), pendingAlert('a2')], [], {
      // a1's Prompt was approved two minutes after it landed.
      'events/med-2026/items/i-a1': { status: 'active', reportCount: 0 },
    });
    const result = await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    expect(result).toEqual({ sent: 1, retired: 1 });
    expect((send.mock.calls[0][0] as { subject: string }).subject).toBe('Admin · Trieste → Barcelona—1 to approve');
    // The resolved row is retired too — it is answered work, not pending work.
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
  });

  it('sends nothing at all when every queued alert was resolved, and still clears the queue', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1')], [], {
      'events/med-2026/items/i-a1': { status: 'active', reportCount: 0 },
    });
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 1,
      reason: 'nothing-current',
    });
    // An email claiming a review queue that is empty is worse than no email.
    expect(send).not.toHaveBeenCalled();
    // Retired anyway, so they stop costing a re-read on every future sweep.
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
  });

  it('prefers the Event’s canonical host for the deep link, falling back to APP_BASE_URL', async () => {
    const send = vi.fn(async () => true);
    const withHost = seeded(
      [pendingAlert('a1')],
      [{ id: 'bingo.example.com', eventId: 'med-2026', status: 'active', isCanonical: true, edition: 'vacay' }],
    );
    await sendAdminDigestForEvent(withHost, 'med-2026', deps(send));
    expect((send.mock.calls[0][0] as { html: string }).html).toContain('https://bingo.example.com/more/admin/queue');

    const noHost = seeded([pendingAlert('a1')]);
    await sendAdminDigestForEvent(noHost, 'med-2026', deps(send));
    expect((send.mock.calls[1][0] as { html: string }).html).toContain(
      'https://gaycruisebingo.com/more/admin/queue',
    );
  });

  it('RETIRES a malformed queue row rather than letting it occupy the drain limit forever', async () => {
    // Skipping an unreadable row leaves it pending, so a page of them would
    // starve every valid alert behind it on every future sweep.
    const send = vi.fn(async () => true);
    const db = seeded([
      { id: 'bad', kind: 'not-a-kind', collection: 'items', docId: 'x', sentAt: null, createdAt: 1 },
      pendingAlert('a2'),
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({ sent: 1, retired: 1 });
    spy.mockRestore();
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
  });

  it('clears a page that is ENTIRELY malformed, so valid alerts behind it are reachable', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([
      { id: 'bad1', kind: 'nope', collection: 'items', docId: 'x', sentAt: null, createdAt: 1 },
      { id: 'bad2', kind: 'nope', collection: 'items', docId: 'y', sentAt: null, createdAt: 2 },
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 2,
      reason: 'nothing-current',
    });
    spy.mockRestore();
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
  });

  it('bounds the drain query, and clamps it to what one atomic batch can clear', async () => {
    const send = vi.fn(async () => true);
    const db = seeded(Array.from({ length: 12 }, (_, i) => pendingAlert(`a${i + 1}`)));
    await sendAdminDigestForEvent(db, 'med-2026', { ...deps(send), maxAlerts: 5 });
    expect((send.mock.calls[0][0] as { subject: string }).subject).toContain('5 to approve');
    // The rest are untouched and drain on the next sweep.
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toHaveLength(7);
    // A config bump past the batch limit degrades to "drains less", never to a
    // non-atomic multi-commit clean-up.
    expect(MAX_ALERTS_PER_DIGEST).toBeLessThanOrEqual(MAX_ATOMIC_WRITES);
    const big = seeded(Array.from({ length: 3 }, (_, i) => pendingAlert(`b${i + 1}`)));
    await sendAdminDigestForEvent(big, 'med-2026', { ...deps(send), maxAlerts: 10_000 });
    expect(big.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
  });

  it('keeps a row on a FAILED content re-read rather than losing a moderation alert', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1')], [], {}, { throwOn: ['events/med-2026/items/i-a1'] });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await sendAdminDigestForEvent(db, 'med-2026', deps(send))).sent).toBe(1);
    spy.mockRestore();
  });
});

describe('claimed-batch retries and exclusivity', () => {
  const deps = (send: ReturnType<typeof vi.fn>) => ({
    send: send as never,
    getAdminUids: async () => ['u1'],
    getEmailForUid: async (uid: string) => `${uid}@example.com`,
    adminNotifyEmail: '',
    appBaseUrl: 'https://gaycruisebingo.com',
    from: 'x <x@example.com>',
    now: () => NOW,
    quietMs: 0,
  });

  const alert = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: 'item-created',
    collection: 'items',
    docId: `i-${id}`,
    label: `Prompt ${id}`,
    status: 'pending',
    visionFlag: null,
    reportCount: 0,
    createdAt: 1,
    sentAt: null,
    ...over,
  });

  const withLive = (rows: Record<string, unknown>[]) => {
    const live: Record<string, Record<string, unknown>> = { 'events/med-2026': EVENT };
    for (const r of rows) live[`events/med-2026/items/${r.docId}`] = { status: 'pending', reportCount: 0 };
    return live;
  };

  it('reloads the WHOLE claimed batch, even when a newcomer displaces part of it from the page', async () => {
    // The pending page is `limit`ed. Once it is full, a newly queued row can
    // push a claimed row out of it — and retrying the remainder under the
    // original key would send a SMALLER payload that Resend treats as the same
    // email, so the displaced rows are suppressed later and never delivered.
    const send = vi.fn(async () => true);
    const rows = [
      alert('a1', { batchId: 'a2/2' }),
      alert('a2', { batchId: 'a2/2' }),
      alert('a0'), // sorts first, and with maxAlerts 2 it displaces a claimed row
    ];
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': rows, events: [{ id: 'med-2026', status: 'active' }], hostnames: [] },
      withLive(rows),
    );
    const result = await sendAdminDigestForEvent(db, 'med-2026', { ...deps(send), maxAlerts: 2 });
    // Both claimed rows go out together, under their own batch id.
    expect(result.sent).toBe(2);
    expect((send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey).toBe('admin-digest/med-2026/a2/2');
    // The newcomer is untouched and becomes its own batch next sweep.
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null).map((r) => r.id)).toEqual(['a0']);
  });

  it('claims EXCLUSIVELY, so an overlapping drain steps aside instead of mailing the overlap twice', async () => {
    // Cloud Scheduler can double-fire. Two invocations reading slightly
    // different pages would derive different batch ids and, under an
    // unconditional merge, overwrite each other's claim on the rows they share.
    const send = vi.fn(async () => true);
    const rows = [alert('a1', { batchId: 'someone-else/1' }), alert('a2')];
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': rows, events: [{ id: 'med-2026', status: 'active' }], hostnames: [] },
      withLive(rows),
    );
    // a1 is already claimed by the other drain, so THIS sweep reuses that claim
    // rather than minting a competing one over the shared row.
    const result = await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    expect(result.sent).toBe(1);
    expect((send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey).toBe(
      'admin-digest/med-2026/someone-else/1',
    );
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null).map((r) => r.id)).toEqual(['a2']);
  });

  it('sends nothing when the transactional claim itself fails', async () => {
    const send = vi.fn(async () => true);
    const rows = [alert('a1')];
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': rows, events: [{ id: 'med-2026', status: 'active' }], hostnames: [] },
      withLive(rows),
      [],
      false,
      true,
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 0,
      reason: 'claim-failed',
    });
    spy.mockRestore();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('flattenLabel', () => {
  it('collapses newlines, so a Prompt cannot forge structure in the plain-text part', () => {
    // The text alternative has no escaping — its structure IS its punctuation.
    // A newline inside a Prompt would otherwise emit unprefixed lines that
    // imitate a section heading or the CTA, complete with an auto-linked URL,
    // while the HTML consumer still shows one tidy escaped row.
    expect(flattenLabel('Buy a drink\n\nOPEN THE REVIEW QUEUE: https://evil.example')).toBe(
      'Buy a drink OPEN THE REVIEW QUEUE: https://evil.example',
    );
    expect(flattenLabel('a\r\nb\tc')).toBe('a b c');
    expect(flattenLabel('  padded  ')).toBe('padded');
    expect(flattenLabel('\u0000\u007F')).toBe('');
  });

  it('flattens at BOTH boundaries — the producer and the digest read-back', async () => {
    const db = fakeDb();
    await enqueueAdminAlerts(
      db,
      'e',
      alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending', text: 'One\nTwo' })),
      'evt-1',
    );
    expect(db.rows('events/e/adminAlerts')[0].label).toBe('One Two');

    // And a row queued before this existed is flattened on the way out.
    const send = vi.fn(async () => true);
    const legacy = fakeDb(
      {
        'events/med-2026/adminAlerts': [
          {
            id: 'old',
            kind: 'item-created',
            collection: 'items',
            docId: 'i9',
            label: 'Legacy\nInjected line',
            status: 'pending',
            visionFlag: null,
            reportCount: 0,
            createdAt: 1,
            sentAt: null,
          },
        ],
        events: [{ id: 'med-2026', status: 'active' }],
        hostnames: [],
      },
      { 'events/med-2026': EVENT, 'events/med-2026/items/i9': { status: 'pending', reportCount: 0 } },
    );
    await sendAdminDigestForEvent(legacy, 'med-2026', {
      send: send as never,
      getAdminUids: async () => ['u1'],
      getEmailForUid: async (uid: string) => `${uid}@example.com`,
      adminNotifyEmail: '',
      appBaseUrl: 'https://gaycruisebingo.com',
      from: 'x <x@example.com>',
      now: () => NOW,
      quietMs: 0,
    });
    const text = (send.mock.calls[0][0] as { text: string }).text;
    expect(text).toContain('- Legacy Injected line—new Prompt · pending approval');
    expect(text).not.toContain('\nInjected line');
  });
});

describe('runAdminAlertSweep', () => {
  it('one Event’s failure never sinks the sweep', async () => {
    const send = vi.fn(async () => true);
    const alert = {
      id: 'a1',
      kind: 'item-created',
      collection: 'items',
      docId: 'i1',
      label: 'Prompt',
      status: 'pending',
      visionFlag: null,
      reportCount: 0,
      createdAt: 1,
      sentAt: null,
    };
    const db = fakeDb(
      {
        events: [{ id: 'broken', status: 'active' }, { id: 'med-2026', status: 'active' }],
        'events/med-2026/adminAlerts': [alert],
        'events/broken/adminAlerts': [{ ...alert, id: 'b1' }],
      },
      {
        'events/med-2026': EVENT,
        'events/broken': EVENT,
        'events/med-2026/items/i1': { status: 'pending', reportCount: 0 },
      },
      // The first Event's drain throws outright; the second must still send.
      ['events/broken/adminAlerts'],
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runAdminAlertSweep(db, {
      send: send as never,
      getAdminUids: async () => ['u1'],
      getEmailForUid: async (uid: string) => `${uid}@example.com`,
      adminNotifyEmail: '',
      appBaseUrl: 'https://gaycruisebingo.com',
      from: 'x <x@example.com>',
      now: () => NOW,
      quietMs: 0,
    });
    spy.mockRestore();
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
    // The broken Event keeps its work for the next sweep.
    expect(db.rows('events/broken/adminAlerts')).toHaveLength(1);
  });
});
