// specs/admin-notification-emails.md (#638) — the admin notification digest.
//
// Three layers, each testable on its own because every one of them is pure or
// dependency-injected: what earns an alert (`alertsForWrite`), what the digest
// SAYS (`buildAdminDigestModel` / `reviewDetail` / `currentThemeDay`), and how
// it is DELIVERED (`sendAdminDigestForEvent` / `runAdminAlertSweep`) against a
// fake Firestore. No Functions runtime, no emulator, no live Resend key.
import { describe, it, expect, vi } from 'vitest';
import {
  LABEL_MAX,
  MAX_ALERTS_PER_DIGEST,
  MAX_ATOMIC_WRITES,
  MAX_HOLD_MS,
  QUIET_PERIOD_MS,
  flattenLabel,
  sameRecipients,
  FROZEN_TTL_MARGIN_MS,
  PENDING_TTL_MS,
  TOMBSTONE_TTL_MS,
  abuseAlertsForWrite,
  abuseAlertDraft,
  alertDocId,
  bugReportEventId,
  drainKey,
  isRetryableFirestoreError,
  planDrain,
  alertsForWrite,
  currentRowFor,
  enqueueAdminAlerts,
  pendingAdminAlertRow,
  recordAdminAlerts,
  recordBugReportAlerts,
  runAdminAlertSweep,
  runAdminAlertCycle,
  runAbuseEscalationSweep,
  settleAdminAlertsForArchivedEvent,
  shouldSettleAdminAlertsOnArchive,
  sendAdminDigestForEvent,
  type AdminAlertFirestore,
  type AlertableDoc,
  type BugReportDoc,
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
  /** When true, freezing the outbound request rejects. */
  failFreeze = false,
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
  let rejectTransactions = false;

  const valueMs = (value: unknown) => value instanceof Date ? value.getTime() : value;
  const makeQuery = (
    path: string,
    filters: Array<[string, string, unknown]>,
    cap: number | null,
    ordering: string | null = null,
  ) => {
    const query = {
      where: (field: string, op: string, value: unknown) =>
        makeQuery(path, [...filters, [field, op, value]], cap, ordering),
      orderBy: (field: string) => makeQuery(path, filters, cap, field),
      limit: (count: number) => makeQuery(path, filters, count, ordering),
      get: async () => {
        if (throwOn.includes(path)) throw new Error(`backend unavailable: ${path}`);
        let rows = collections.get(path) ?? [];
        for (const [field, op, value] of filters) {
          rows = rows.filter((row) => {
            const actual = valueMs(row.data[field]);
            const expected = valueMs(value);
            return op === '<=' ? (actual as number) <= (expected as number) : actual === expected;
          });
        }
        if (ordering) rows = [...rows].sort((a, b) => Number(valueMs(a.data[ordering])) - Number(valueMs(b.data[ordering])));
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
  // A doc seeded through `docs` (singles) still EXISTS for `create`'s check.
  const exists = (path: string) => Boolean(singles.get(path) || findRow(path));

  const docRef = (path: string) => ({
    path,
    get: async () => {
      if (throwOn.includes(path)) throw new Error(`backend unavailable: ${path}`);
      const single = singles.get(path);
      if (single) return { data: () => ({ ...single }) };
      const found = findRow(path);
      return { data: () => (found ? { ...found.data } : undefined) };
    },
    set: async (data: Record<string, unknown>) => {
      if (failFreeze) throw new Error('freeze write failed');
      const { collectionPath, id } = split(path);
      const rows = collections.get(collectionPath) ?? [];
      const found = rows.find((r) => r.id === id);
      if (found) found.data = { ...data };
      else rows.push({ id, data: { ...data } });
      collections.set(collectionPath, rows);
      return undefined;
    },
    // Admin-SDK `create` semantics: reject if the document already exists.
    create: async (data: Record<string, unknown>) => {
      if (failFreeze && path.includes('/adminAlertBatches/')) throw new Error('freeze write failed');
      if (exists(path)) {
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
      const deletes: string[] = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          staged.push([ref.path, data, options?.merge === true]);
        },
        delete: (ref: { path: string }) => {
          deletes.push(ref.path);
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
          for (const path of deletes) {
            singles.delete(path);
            const { collectionPath, id } = split(path);
            const rows = collections.get(collectionPath) ?? [];
            collections.set(
              collectionPath,
              rows.filter((r) => r.id !== id),
            );
          }
          return undefined;
        },
      };
    },
    // A serial transaction: reads see current state, writes apply on return.
    // Enough for the exclusive claim, whose whole content is read-then-set.
    runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      if (rejectTransactions) throw new Error('all transactions unavailable');
      if (failClaim) throw new Error('transaction failed');
      const writes: Array<[string, Record<string, unknown>, boolean]> = [];
      const deletes: string[] = [];
      const result = await fn({
        get: async (ref: { path: string }) => {
          if (throwOn.includes(ref.path)) throw new Error(`backend unavailable: ${ref.path}`);
          const single = singles.get(ref.path);
          if (single) return { data: () => ({ ...single }) };
          const found = findRow(ref.path);
          return { data: () => (found ? { ...found.data } : undefined) };
        },
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          writes.push([ref.path, data, options?.merge === true]);
        },
        delete: (ref: { path: string }) => {
          deletes.push(ref.path);
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
      for (const path of deletes) {
        singles.delete(path);
        const { collectionPath, id } = split(path);
        const rows = collections.get(collectionPath) ?? [];
        collections.set(
          collectionPath,
          rows.filter((r) => r.id !== id),
        );
      }
      return result;
    },
    /** Test-only reader. */
    rows: (path: string) => (collections.get(path) ?? []).map((r) => ({ id: r.id, ...r.data })),
    /** Test-only singleton update for lifecycle-race interleavings. */
    setDoc: (path: string, data: Record<string, unknown>) => singles.set(path, { ...data }),
    failTransactions: () => { rejectTransactions = true; },
  };
  return db as unknown as AdminAlertFirestore & {
    rows: (path: string) => Record<string, unknown>[];
    setDoc: (path: string, data: Record<string, unknown>) => void;
    failTransactions: () => void;
  };
}

const ITEM = (over: Partial<AlertableDoc> = {}): AlertableDoc => ({
  status: 'active',
  reportCount: 0,
  text: 'Spot a speedo at breakfast',
  ...over,
});

describe('durable abuse-escalation sweep (#859)', () => {
  const REPORT_ID = 'report-unknown-1';
  const REPORTER_HASH = 'fcdec6df4d44dbc637c7';
  const pendingTask = (over: Record<string, unknown> = {}) => ({
    id: REPORT_ID,
    state: 'pending',
    eventId: 'med-2026',
    reporterUid: 'user-123',
    reporterHash: REPORTER_HASH,
    createdAt: new Date(NOW - 60_000),
    nextAttemptAt: new Date(NOW - 1),
    attemptCount: 0,
    deadlineAt: new Date(NOW - 60_000 + 7 * 24 * 60 * 60_000),
    expiresAt: new Date(NOW - 60_000 + 8 * 24 * 60 * 60_000),
    ...over,
  });
  const unresolvedReport = (over: Record<string, unknown> = {}) => ({
    kind: 'abuse',
    description: 'Line one\nLine two',
    eventId: 'med-2026',
    reporterHash: REPORTER_HASH,
    escalationLookupFailed: true,
    intakeState: 'complete',
    status: 'new',
    ...over,
  });

  it('atomically queues one deterministic alert for a currently authorized reporter', async () => {
    const db = fakeDb(
      { bugReportEscalations: [pendingTask()] },
      {
        'bugReports/report-unknown-1': unresolvedReport(),
        'events/med-2026': { status: 'active', admins: ['user-123'] },
      },
    );

    await runAbuseEscalationSweep(db, { now: () => NOW });

    expect(db.rows('bugReportEscalations')).toEqual([{
      id: REPORT_ID,
      state: 'terminal',
      outcome: 'queued',
      resolvedAt: new Date(NOW),
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    }]);
    expect(db.rows('events/med-2026/adminAlerts')).toEqual([{
      id: alertDocId(`bug-report-escalation-${REPORT_ID}`, 'abuse-reported'),
      kind: 'abuse-reported',
      collection: 'bugReports',
      docId: REPORT_ID,
      label: 'Line one Line two',
      status: 'new',
      visionFlag: null,
      reportCount: 0,
      createdAt: NOW,
      sentAt: null,
      expiresAt: new Date(NOW + PENDING_TTL_MS),
    }]);
  });

  it('keeps infrastructure failure pending with bounded exponential backoff', async () => {
    for (const [attemptCount, delay] of [[0, 5 * 60_000], [1, 10 * 60_000], [9, 6 * 60 * 60_000]] as const) {
      const db = fakeDb(
        { bugReportEscalations: [pendingTask({ attemptCount })] },
        { 'bugReports/report-unknown-1': unresolvedReport() },
        ['events/med-2026'],
      );
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await runAbuseEscalationSweep(db, { now: () => NOW });

      spy.mockRestore();
      expect(db.rows('bugReportEscalations')[0]).toMatchObject({
        state: 'pending',
        attemptCount: attemptCount + 1,
        nextAttemptAt: new Date(NOW + delay),
      });
    }
  });

  it('never copies the raw reporter uid into failure logs', async () => {
    const db = fakeDb(
      { bugReportEscalations: [pendingTask()] },
      {
        [`bugReports/${REPORT_ID}`]: unresolvedReport(),
        'events/med-2026': { status: 'active', admins: [] },
      },
      ['events/med-2026/players/user-123'],
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runAbuseEscalationSweep(db, { now: () => NOW });
    expect(spy.mock.calls.flat().map(String).join(' ')).not.toContain('user-123');
    spy.mockRestore();
  });

  it('authorizes a current player as well as an Event admin', async () => {
    const db = fakeDb(
      { bugReportEscalations: [pendingTask()] },
      {
        [`bugReports/${REPORT_ID}`]: unresolvedReport(),
        'events/med-2026': { status: 'active', admins: [] },
        'events/med-2026/players/user-123': { displayName: 'Ada' },
      },
    );
    await runAbuseEscalationSweep(db, { now: () => NOW });
    expect(db.rows('bugReportEscalations')[0]).toMatchObject({ outcome: 'queued' });
  });

  it.each([
    ['source-invalid', undefined, undefined],
    ['source-invalid', unresolvedReport({ reporterHash: '0'.repeat(20) }), undefined],
    ['source-invalid', unresolvedReport({ escalationLookupFailed: false }), undefined],
    ['source-invalid', unresolvedReport({ intakeState: 'pending' }), undefined],
    ['event-missing', unresolvedReport(), undefined],
    ['event-inactive', unresolvedReport(), { status: 'archived', admins: ['user-123'] }],
    ['not-member', unresolvedReport(), { status: 'active', admins: [] }],
  ])('terminalizes %s without retaining the task payload', async (outcome, report, event) => {
    const docs: Record<string, Record<string, unknown>> = {};
    if (report) docs[`bugReports/${REPORT_ID}`] = report;
    if (event) docs['events/med-2026'] = event;
    const db = fakeDb({ bugReportEscalations: [pendingTask()] }, docs);

    await runAbuseEscalationSweep(db, { now: () => NOW });

    expect(db.rows('bugReportEscalations')).toEqual([{
      id: REPORT_ID,
      state: 'terminal',
      outcome,
      resolvedAt: new Date(NOW),
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    }]);
    expect(db.rows('events/med-2026/adminAlerts')).toEqual([]);
  });

  it('fails a malformed task binding closed as source-invalid', async () => {
    const db = fakeDb(
      { bugReportEscalations: [pendingTask({ reporterUid: 42 })] },
      { [`bugReports/${REPORT_ID}`]: unresolvedReport(), 'events/med-2026': { status: 'active' } },
    );
    await runAbuseEscalationSweep(db, { now: () => NOW });
    expect(db.rows('bugReportEscalations')[0]).toMatchObject({ outcome: 'source-invalid' });
  });

  it('accepts the legacy absent-intake-state report shape created in the same transaction', async () => {
    const { intakeState: _intakeState, ...legacyReport } = unresolvedReport();
    const db = fakeDb(
      { bugReportEscalations: [pendingTask()] },
      {
        [`bugReports/${REPORT_ID}`]: legacyReport,
        'events/med-2026': { status: 'active', admins: ['user-123'] },
      },
    );
    await runAbuseEscalationSweep(db, { now: () => NOW });
    expect(db.rows('bugReportEscalations')[0]).toMatchObject({ outcome: 'queued' });
  });

  it('gives an existing deterministic queue row the distinct alert-conflict outcome', async () => {
    const alertId = alertDocId(`bug-report-escalation-${REPORT_ID}`, 'abuse-reported');
    const db = fakeDb(
      { bugReportEscalations: [pendingTask()] },
      {
        [`bugReports/${REPORT_ID}`]: unresolvedReport(),
        'events/med-2026': { status: 'active', admins: ['user-123'] },
        [`events/med-2026/adminAlerts/${alertId}`]: { kind: 'moderation', foreign: true },
      },
    );
    await runAbuseEscalationSweep(db, { now: () => NOW });
    expect(db.rows('bugReportEscalations')[0]).toEqual({
      id: REPORT_ID,
      state: 'terminal',
      outcome: 'alert-conflict',
      resolvedAt: new Date(NOW),
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    });
    expect((await db.doc(`events/med-2026/adminAlerts/${alertId}`).get()).data()).toEqual({
      kind: 'moderation', foreign: true,
    });
  });

  it('expires the seven-day retry window before making another relationship decision', async () => {
    const db = fakeDb(
      { bugReportEscalations: [pendingTask({
        createdAt: new Date(NOW - 7 * 24 * 60 * 60_000),
        deadlineAt: new Date(NOW),
        expiresAt: new Date(NOW + 24 * 60 * 60_000),
      })] },
      {},
      ['events/med-2026'],
    );
    await runAbuseEscalationSweep(db, { now: () => NOW });
    expect(db.rows('bugReportEscalations')[0]).toMatchObject({ outcome: 'retry-window-expired' });
  });

  it('caps a retry at the deadline and tolerates a failed best-effort reschedule', async () => {
    const capped = fakeDb(
      { bugReportEscalations: [pendingTask({
        createdAt: new Date(NOW + 2 * 60_000 - 7 * 24 * 60 * 60_000),
        deadlineAt: new Date(NOW + 2 * 60_000),
        expiresAt: new Date(NOW + 2 * 60_000 + 24 * 60 * 60_000),
      })] },
      { [`bugReports/${REPORT_ID}`]: unresolvedReport() },
      ['events/med-2026'],
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runAbuseEscalationSweep(capped, { now: () => NOW });
    expect(capped.rows('bugReportEscalations')[0]).toMatchObject({
      attemptCount: 1,
      nextAttemptAt: new Date(NOW + 2 * 60_000),
    });

    const stranded = fakeDb({ bugReportEscalations: [pendingTask()] });
    stranded.failTransactions();
    await expect(runAbuseEscalationSweep(stranded, { now: () => NOW })).resolves.toBeUndefined();
    expect(stranded.rows('bugReportEscalations')[0]).toMatchObject({ state: 'pending', attemptCount: 0 });
    spy.mockRestore();
  });

  it('bounds and orders each due page to fifty tasks', async () => {
    const tasks = Array.from({ length: 52 }, (_, index) => pendingTask({
      id: `report-${String(index).padStart(2, '0')}`,
      nextAttemptAt: new Date(NOW - (52 - index)),
      deadlineAt: new Date(NOW),
    }));
    // Reverse insertion order proves the production query owns ordering rather
    // than inheriting whichever physical order Firestore happens to return.
    const db = fakeDb({ bugReportEscalations: [...tasks].reverse() });
    await runAbuseEscalationSweep(db, { now: () => NOW });
    const rows = db.rows('bugReportEscalations');
    expect(rows.filter((row) => row.state === 'terminal')).toHaveLength(50);
    expect(rows.filter((row) => row.state === 'pending').map((row) => row.id).sort()).toEqual(['report-50', 'report-51']);
  });

  it('isolates task failures and converges overlapping sweeps on one alert id', async () => {
    const good = pendingTask({ id: 'good', eventId: 'good-event' });
    const bad = pendingTask({ id: 'bad', eventId: 'bad-event' });
    const db = fakeDb(
      { bugReportEscalations: [bad, good] },
      {
        'bugReports/bad': unresolvedReport({ eventId: 'bad-event' }),
        'bugReports/good': unresolvedReport({ eventId: 'good-event' }),
        'events/good-event': { status: 'active', admins: ['user-123'] },
      },
      ['events/bad-event'],
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await Promise.all([
      runAbuseEscalationSweep(db, { now: () => NOW }),
      runAbuseEscalationSweep(db, { now: () => NOW }),
    ]);
    spy.mockRestore();
    expect(db.rows('events/good-event/adminAlerts')).toHaveLength(1);
    expect(db.rows('bugReportEscalations').find((row) => row.id === 'good')).toMatchObject({ outcome: 'queued' });
    expect(db.rows('bugReportEscalations').find((row) => row.id === 'bad')).toMatchObject({ state: 'pending' });
  });

  it('uses the same sanitized draft and pending row builders as the fast producer', () => {
    const { intakeState: _intakeState, ...report } = unresolvedReport({ reporterInEvent: true });
    const draft = abuseAlertDraft(REPORT_ID, report);
    expect(abuseAlertsForWrite(REPORT_ID, undefined, report)).toEqual([draft]);
    expect(pendingAdminAlertRow(draft!, NOW)).toEqual({
      ...draft,
      createdAt: NOW,
      sentAt: null,
      expiresAt: new Date(NOW + PENDING_TTL_MS),
    });
  });

  it('failure-isolates the escalation and ordinary digest legs', async () => {
    const send = vi.fn(async () => true);
    const digestContinues = fakeDb(
      {
        events: [{ id: 'med-2026', status: 'active' }],
        'events/med-2026/adminAlerts': [{
          id: 'existing', kind: 'item-created', collection: 'items', docId: 'i1', label: 'Prompt',
          status: 'pending', visionFlag: null, reportCount: 0, createdAt: 1, sentAt: null,
        }],
      },
      {
        'events/med-2026': EVENT,
        'events/med-2026/items/i1': { status: 'pending', reportCount: 0 },
      },
      ['bugReportEscalations'],
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runAdminAlertCycle(digestContinues, {
      now: () => NOW,
      send: send as never,
      getAdminUids: async () => ['user-123'],
      getEmailForUid: async () => 'admin@example.com',
      adminNotifyEmail: '',
      appBaseUrl: 'https://gaycruisebingo.com',
      from: 'x <x@example.com>',
      quietMs: 0,
    });
    expect(send).toHaveBeenCalledTimes(1);

    const escalationContinues = fakeDb(
      { bugReportEscalations: [pendingTask()] },
      {
        [`bugReports/${REPORT_ID}`]: unresolvedReport(),
        'events/med-2026': { status: 'active', admins: ['user-123'] },
      },
      ['events'],
    );
    await runAdminAlertCycle(escalationContinues, { now: () => NOW });
    expect(escalationContinues.rows('bugReportEscalations')[0]).toMatchObject({ outcome: 'queued' });
    spy.mockRestore();
  });
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
  status: 'active',
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
    const db = fakeDb({}, { 'events/med-2026': EVENT });
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
    const db = fakeDb({}, { 'events/e': EVENT });
    const drafts = alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' }));
    expect(await enqueueAdminAlerts(db, 'e', drafts, 'evt-1')).toBe(1);
    expect(await enqueueAdminAlerts(db, 'e', drafts, 'evt-1')).toBe(0); // redelivery: no-op
    expect(db.rows('events/e/adminAlerts')).toHaveLength(1);
    // A genuinely DISTINCT write carries a distinct id and does queue.
    expect(await enqueueAdminAlerts(db, 'e', drafts, 'evt-2')).toBe(1);
    expect(db.rows('events/e/adminAlerts')).toHaveLength(2);
  });

  it('cannot enqueue after archive wins the Event transaction', async () => {
    const db = fakeDb({}, { 'events/e': { status: 'archived' } });
    const drafts = alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' }));

    expect(await enqueueAdminAlerts(db, 'e', drafts, 'evt-1')).toBe(0);
    expect(db.rows('events/e/adminAlerts')).toEqual([]);
  });

  it('gives one write’s two alerts distinct ids, so neither collides with the other', async () => {
    const db = fakeDb({}, { 'events/e': EVENT });
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
      batch: () => ({ set: () => undefined, delete: () => undefined, commit: async () => undefined }),
      runTransaction: async () => Promise.reject(new Error('firestore down')),
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
    // DESTINATION-NEUTRAL (#670): abuse rows are not in the Review queue at all,
    // so the preheader states the count and lets each module name its own home.
    expect(model.preheader).toBe('2 items waiting for Trieste → Barcelona.');
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

  // #698 gave the cruise register the endorsement too, and the digest composes
  // its own line from the SAME `brandLine` — so the change reaches an internal
  // surface as well as the player-facing one. Pinned here because that
  // consequence is easy to miss from the daily-email suite alone.
  it('carries the endorsement into the cruise Edition’s admin line too', () => {
    const model = build([ALERT()], { edition: 'gcb' });
    expect(model.brandLine).toBe('Gay Cruise Bingo · by Five Across · Admin');
    expect(model.footerBrandLine).toBe('Gay Cruise Bingo · by Five Across');
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
    expect(plan).toEqual({ batchId: 'a2__2', ids: ['a1', 'a2'], claimNeeded: true });
  });

  it('gives a released cohort a fresh delivery identity, even when its rows are unchanged', () => {
    const plan = planDrain(
      [row('a1', { requeueGeneration: 1 }), row('a2', { requeueGeneration: 1 })],
      10_000,
      1_000,
    );
    expect(plan).toEqual({ batchId: 'a2__2__1', ids: ['a1', 'a2'], claimNeeded: true });
  });

  it('leaves rows still inside the settling period for the next sweep', () => {
    // A burst straddling the scheduler boundary would otherwise be snapshotted
    // mid-write and split across two emails.
    expect(planDrain([row('a1', { createdAt: 9_500 })], 10_000, 1_000)).toEqual({ reason: 'settling' });
  });

  it('holds the WHOLE COHORT when any row is still settling — per-row eligibility splits bursts', () => {
    // A one-second import straddling the cutoff has its first rows at 60.5s and
    // its last at 59.5s. Filtering row by row would email the front of the
    // burst now and the tail five minutes later, which is precisely the split
    // the settling period exists to prevent.
    const plan = planDrain([row('a1', { createdAt: 0 }), row('a2', { createdAt: 9_900 })], 10_000, 1_000);
    expect(plan).toEqual({ reason: 'settling' });
  });

  it('bounds the hold, so a steady trickle can never starve delivery outright', () => {
    // Same shape, but the ripe row is now older than the max hold: it goes out
    // and the straggler follows in the next batch. Delivering late beats never.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const plan = planDrain([row('a1', { createdAt: 0 }), row('a2', { createdAt: 9_900 })], 10_000, 1_000, 5_000);
    spy.mockRestore();
    expect(plan).toEqual({ batchId: 'a1__1', ids: ['a1'], claimNeeded: true });
    expect(MAX_HOLD_MS).toBeGreaterThan(QUIET_PERIOD_MS);
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
    opts: { throwOn?: string[]; failCommit?: boolean; failClaim?: boolean; failFreeze?: boolean } = {},
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
      opts.failFreeze ?? false,
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
    // The tombstone REPLACES the row, so the pending TTL written at enqueue is
    // superseded by the shorter tombstone one rather than competing with it.
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
    expect(key).toBe('admin-digest/med-2026/a2__2');
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
    expect(key).toBe('admin-digest/med-2026/a2__2');
    // The clean-up failed, so every row is still pending — and every one of
    // them carries the batch id the email went out under.
    const pending = db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null);
    expect(pending).toHaveLength(2);
    expect(pending.map((r) => r.batchId)).toEqual(['a2__2', 'a2__2']);
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
    const resolved = seeded([pendingAlert('a1', { batchId: 'a2__2' }), pendingAlert('a2', { batchId: 'a2__2' })], [], {
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
        pendingAlert('a1', { batchId: 'a2__2' }),
        pendingAlert('a2', { batchId: 'a2__2' }),
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

  it('cannot mint a new claim after archive wins the Event transaction', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1')], [], {
      'events/med-2026': { ...EVENT, status: 'archived' },
    });

    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 0,
      reason: 'inactive-event',
    });
    expect(send).not.toHaveBeenCalled();
    expect(db.rows('events/med-2026/adminAlerts')[0].batchId).toBeUndefined();
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
    expect(drainKey(['a1', 'a2', 'b0'])).toBe('b0__3');
    expect(drainKey(['b0', 'a2', 'a1'])).toBe('b0__3');
    expect(drainKey([])).toBe('empty__0');
    // `__` rather than `/`, because the batch id is also a document id.
    expect(drainKey(['a1'])).not.toContain('/');
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

  // #671: the digest's sender is Edition-aware too, resolved from the same
  // `resolveEventOrigin` hostname lookup the brand line already uses — not the
  // `deps.from` override, which these three cases deliberately omit.
  describe('Edition-aware sender (#671)', () => {
    const editionDeps = (send: ReturnType<typeof vi.fn>, fromOverrides: Record<string, string>) => {
      const { from: _from, ...rest } = deps(send);
      return { ...rest, fromOverrides };
    };

    // The real EMAIL_FROM param's `.value()` reads `process.env.EMAIL_FROM`
    // directly — its `default` is a deploy-time-only concern the firebase-tools
    // CLI resolves, never consulted at plain runtime — so an unset env var
    // resolves to `''`, not the documented default. Stub the env var directly
    // rather than mocking the whole `./params` module: `resolveEmailFrom`
    // reaches it via a fresh `await import('./params')` on every call, and an
    // earlier test in this file may already have resolved that dynamic import
    // before a `vi.doMock` registration here would take effect. Stubbing
    // `process.env` sidesteps that question entirely (CodeRabbit finding on
    // PR #810). The value is deliberately NOT the real EMAIL_FROM default, so
    // a passing assertion can only mean the stub was read.
    const STUBBED_EMAIL_FROM = 'Stubbed Sender <stub@example.invalid>';

    it('sends from the Edition-configured address when the host resolves a known Edition', async () => {
      const send = vi.fn(async () => true);
      const db = seeded(
        [pendingAlert('a1')],
        [{ eventId: 'med-2026', canonicalHost: 'bodega-bay.vacaybingo.com', edition: 'vacay', isCanonical: true, status: 'active' }],
      );
      await sendAdminDigestForEvent(db, 'med-2026', editionDeps(send, { vacay: 'Vacay Bingo <hello@vacaybingo.com>' }));
      expect((send.mock.calls[0][0] as { from: string }).from).toBe('Vacay Bingo <hello@vacaybingo.com>');
    });

    it('falls back to EMAIL_FROM when the resolved Edition has no configured override', async () => {
      vi.stubEnv('EMAIL_FROM', STUBBED_EMAIL_FROM);
      const send = vi.fn(async () => true);
      const db = seeded(
        [pendingAlert('a1')],
        [{ eventId: 'med-2026', canonicalHost: 'gaycruisebingo.com', edition: 'gcb', isCanonical: true, status: 'active' }],
      );
      await sendAdminDigestForEvent(db, 'med-2026', editionDeps(send, {}));
      expect((send.mock.calls[0][0] as { from: string }).from).toBe(STUBBED_EMAIL_FROM);
      vi.unstubAllEnvs();
    });

    it('falls back to EMAIL_FROM for an unrecognized Edition rather than failing the send', async () => {
      vi.stubEnv('EMAIL_FROM', STUBBED_EMAIL_FROM);
      const send = vi.fn(async () => true);
      const db = seeded(
        [pendingAlert('a1')],
        [{ eventId: 'med-2026', canonicalHost: 'green-valley.fiveacross.app', edition: 'some-future-edition', isCanonical: true, status: 'active' }],
      );
      const result = await sendAdminDigestForEvent(
        db,
        'med-2026',
        editionDeps(send, { 'some-future-edition': 'Should Not <use@example.com>' }),
      );
      expect(result.sent).toBe(1);
      expect((send.mock.calls[0][0] as { from: string }).from).toBe(STUBBED_EMAIL_FROM);
      vi.unstubAllEnvs();
    });

    it('falls back to EMAIL_FROM when the Event has no hostname documents at all', async () => {
      vi.stubEnv('EMAIL_FROM', STUBBED_EMAIL_FROM);
      const send = vi.fn(async () => true);
      const db = seeded([pendingAlert('a1')], []); // no hostnames → edition: null
      await sendAdminDigestForEvent(db, 'med-2026', editionDeps(send, { gcb: 'Should Not <use@example.com>' }));
      expect((send.mock.calls[0][0] as { from: string }).from).toBe(STUBBED_EMAIL_FROM);
      vi.unstubAllEnvs();
    });
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
      alert('a1', { batchId: 'a2__2' }),
      alert('a2', { batchId: 'a2__2' }),
      alert('a0'), // sorts first, and with maxAlerts 2 it displaces a claimed row
    ];
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': rows, events: [{ id: 'med-2026', status: 'active' }], hostnames: [] },
      withLive(rows),
    );
    const result = await sendAdminDigestForEvent(db, 'med-2026', { ...deps(send), maxAlerts: 2 });
    // Both claimed rows go out together, under their own batch id.
    expect(result.sent).toBe(2);
    expect((send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey).toBe('admin-digest/med-2026/a2__2');
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

describe('the frozen outbound request', () => {
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

  const build = (
    rows: Record<string, unknown>[],
    live: Record<string, Record<string, unknown>> = {},
    opts: { failFreeze?: boolean; failClaim?: boolean } = {},
  ) => {
    const base: Record<string, Record<string, unknown>> = { 'events/med-2026': EVENT };
    for (const r of rows) base[`events/med-2026/items/${r.docId}`] = { status: 'pending', reportCount: 0 };
    return fakeDb(
      { 'events/med-2026/adminAlerts': rows, events: [{ id: 'med-2026', status: 'active' }], hostnames: [] },
      { ...base, ...live },
      [],
      false,
      opts.failClaim ?? false,
      opts.failFreeze ?? false,
    );
  };

  it('freezes the request before sending, and drops it with the batch afterwards', async () => {
    const send = vi.fn(async () => true);
    const db = build([alert('a1')]);
    await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    // Delivered and cleaned up in one commit, so no rendered copy of
    // unapproved content outlives the delivery it existed for.
    expect(db.rows('events/med-2026/adminAlertBatches')).toEqual([]);
  });

  it('REPLAYS the frozen bytes on a retry, even when the live state has moved', async () => {
    // Resend's idempotency is a promise about the REQUEST, not just the key:
    // replaying a key with a different body is a 409, not a dedupe. A rebuilt
    // retry differs by construction here — this digest renders from live state
    // — so it would 409, `sendEmail` would report false, the claimed rows could
    // never be cleaned up, and the batch would sit stuck until the key expired.
    const send = vi.fn(async () => true);
    const db = build([alert('a1', { batchId: 'a1__1' })], {
      // An approval landed between the two attempts: a rebuild would render a
      // DIFFERENT email (in fact, no rows at all).
      'events/med-2026/items/i-a1': { status: 'active', reportCount: 0 },
      'events/med-2026/adminAlertBatches/a1__1': {
        // The SAME authorized set the deps resolve, so the replay is allowed.
        to: ['u1@example.com'],
        subject: 'Admin · frozen subject',
        html: '<p>frozen</p>',
        text: 'frozen',
        from: 'frozen <f@example.com>',
        alertCount: 1,
        createdAt: 1,
      },
    });
    const result = await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    expect(result).toEqual({ sent: 1, retired: 0 });
    const arg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.subject).toBe('Admin · frozen subject');
    expect(arg.html).toBe('<p>frozen</p>');
    expect(arg.to).toEqual(['u1@example.com']);
    expect(arg.from).toBe('frozen <f@example.com>');
    expect(arg.idempotencyKey).toBe('admin-digest/med-2026/a1__1');
    // Cleaned up: rows tombstoned, frozen request gone.
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
    expect(db.rows('events/med-2026/adminAlertBatches')).toEqual([]);
  });

  it('rebuilds when the claim exists but nothing was frozen — nothing went out under that key', async () => {
    const send = vi.fn(async () => true);
    const db = build([alert('a1', { batchId: 'a1__1' })]);
    expect((await sendAdminDigestForEvent(db, 'med-2026', deps(send))).sent).toBe(1);
    expect((send.mock.calls[0][0] as { subject: string }).subject).toContain('1 to approve');
  });

  it('sends NOTHING when the freeze itself fails — unrecorded bytes cannot be retried', async () => {
    const send = vi.fn(async () => true);
    const db = build([alert('a1')], {}, { failFreeze: true });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 0,
      reason: 'freeze-failed',
    });
    spy.mockRestore();
    expect(send).not.toHaveBeenCalled();
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toHaveLength(1);
  });

  it('gives the frozen request an expiry that outlives every row it claims', async () => {
    // The frozen document holds the fully rendered email — every Prompt's words
    // and every abuse description in the batch — and persists for as long as
    // delivery keeps failing. Without an expiry it outlives its own rows once
    // their TTL reaps them, with nothing left able to replay, release or delete
    // it (Phase 4b P1).
    //
    // It must OUTLIVE every row it claims. A freeze reaped while its claimed rows
    // survive sends the next sweep down the missing-freeze rebuild path, which
    // re-renders and re-sends — either 409ing against a still-live Resend key or,
    // past the 24h window, delivering a second copy of a digest that already
    // went out. Two earlier attempts (an inherited deadline, then a fixed week)
    // each fell into one side of that.
    const failing = vi.fn(async () => false);
    const LATE = 40 * 24 * 60 * 60 * 1000;
    const oldest = LATE - 60_000;
    const db = build([alert('a1', { createdAt: oldest })]);
    const result = await sendAdminDigestForEvent(db, 'med-2026', { ...deps(failing), now: () => LATE });
    // The send failed, so the batch stays frozen — exactly the state that lasts.
    expect(result.reason).toBe('send-failed');
    const batch = db.rows('events/med-2026/adminAlertBatches')[0];
    expect(batch).toBeDefined();
    // A Date, not epoch millis, or Firestore's TTL service ignores it entirely.
    expect(batch.expiresAt).toBeInstanceOf(Date);
    expect((batch.expiresAt as Date).getTime()).toBe(LATE + PENDING_TTL_MS + FROZEN_TTL_MARGIN_MS);
    // Later than the oldest claimed row's own deadline BY A MARGIN. "Not
    // earlier" is not enough: TTL deletion is asynchronous and unordered across
    // the two collection groups, so a batch frozen minutes after its rows would
    // otherwise be racing them.
    expect((batch.expiresAt as Date).getTime() - (oldest + PENDING_TTL_MS)).toBeGreaterThanOrEqual(
      FROZEN_TTL_MARGIN_MS,
    );
    // ...and still comfortably past the 24h idempotency window.
    expect(PENDING_TTL_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it('RETIRES past-due claimed rows with no freeze rather than risking a duplicate send', async () => {
    // The rebuild path is for a crash between the claim and the freeze — seconds
    // old, nothing sent. Rows already past their own retention deadline with no
    // frozen document are the opposite: a batch that keeps failing HAS a freeze,
    // so an old claim without one means it existed and was reaped, and
    // rebuilding would re-send bytes that may already have been delivered well
    // outside Resend's window (Phase 4b P1).
    const send = vi.fn(async () => true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const LATE = 40 * 24 * 60 * 60 * 1000;
    const db = build([alert('a1', { createdAt: 1_000, batchId: 'a1__1' })]);
    const result = await sendAdminDigestForEvent(db, 'med-2026', { ...deps(send), now: () => LATE });
    expect(result).toEqual({ sent: 0, retired: 1, reason: 'nothing-current' });
    expect(send).not.toHaveBeenCalled();
    // Cleared rather than left to be re-considered on every future sweep.
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
    spy.mockRestore();
  });

  it('ABANDONS a frozen batch when the authorized recipients have changed', async () => {
    // A freeze is written BEFORE the send, so a crash in between (or a rejected
    // send) leaves bytes that may never have been delivered. Replaying them
    // verbatim after an admin is removed would mail pending and hidden content
    // to somebody no longer authorized — and would keep doing so forever,
    // because the stale address is baked into the frozen request.
    const send = vi.fn(async () => true);
    const db = build([alert('a1', { batchId: 'a1__1' })], {
      'events/med-2026/adminAlertBatches/a1__1': {
        to: ['removed-admin@example.com'],
        subject: 'Admin · stale',
        html: '<p>stale</p>',
        text: 'stale',
        from: 'x <x@example.com>',
        alertCount: 1,
        createdAt: 1,
      },
    });
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 0,
      reason: 'rebatched',
    });
    expect(send).not.toHaveBeenCalled();
    // The frozen request is dropped and the claim released, so the rows
    // re-batch for whoever is authorized now — which is also what lets a
    // corrected deployment unblock a batch its old config had wedged.
    expect(db.rows('events/med-2026/adminAlertBatches')).toEqual([]);
    const row = db.rows('events/med-2026/adminAlerts').find((r) => r.id === 'a1');
    expect(row?.batchId).toBeNull();
    // And the very next sweep delivers it to the current roster.
    expect((await sendAdminDigestForEvent(db, 'med-2026', deps(send))).sent).toBe(1);
    expect((send.mock.calls[0][0] as { to: string[] }).to).toEqual(['u1@example.com']);
    // The live roster makes this a NEW request, so it cannot reuse the frozen
    // batch's Resend key and 409 against its different recipient set.
    expect((send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey).toBe(
      'admin-digest/med-2026/a1__1__1',
    );
  });

  it('ABANDONS a frozen batch whose abuse source has been deleted, rather than replaying it (#670)', async () => {
    // A batch that keeps failing to send is retried every sweep for as long as
    // it keeps failing — easily long enough for the 90-day retention sweep to
    // remove a report the frozen bytes quote. The replay path deliberately
    // re-derives nothing, so without this check the deleted report's
    // description would be mailed anyway, which is the one thing the tombstone
    // design promises not to do.
    const send = vi.fn(async () => true);
    const abuseRow = alert('a1', {
      kind: 'abuse-reported',
      collection: 'bugReports',
      docId: 'report_gone',
      label: 'Someone is posting slurs in the feed',
      status: 'new',
      batchId: 'a1__1',
    });
    const db = build([abuseRow], {
      // No `bugReports/report_gone`: retention removed it while the batch sat
      // frozen behind a failing send.
      'events/med-2026/adminAlertBatches/a1__1': {
        to: ['u1@example.com'],
        subject: 'Admin · Trieste → Barcelona—1 abuse report',
        html: '<p>Someone is posting slurs in the feed</p>',
        text: 'Someone is posting slurs in the feed',
        from: 'x <x@example.com>',
        alertCount: 1,
        createdAt: 1,
      },
    });
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 0,
      reason: 'rebatched',
    });
    expect(send).not.toHaveBeenCalled();
    // Same escape hatch as the roster-changed case: the freeze is dropped and
    // the claim released, so the rows re-batch from scratch.
    expect(db.rows('events/med-2026/adminAlertBatches')).toEqual([]);
    // And the next sweep RETIRES the row through `currentRowFor` instead of
    // mailing it — the deleted report never reaches an inbox.
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({
      sent: 0,
      retired: 1,
      reason: 'nothing-current',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('REPLAYS a frozen abuse batch whose source report is still there', async () => {
    const send = vi.fn(async () => true);
    const abuseRow = alert('a1', {
      kind: 'abuse-reported',
      collection: 'bugReports',
      docId: 'report_live',
      label: 'Someone is posting slurs in the feed',
      status: 'new',
      batchId: 'a1__1',
    });
    const db = build([abuseRow], {
      'bugReports/report_live': { kind: 'abuse', eventId: 'med-2026', reporterInEvent: true },
      'events/med-2026/adminAlertBatches/a1__1': {
        to: ['u1@example.com'],
        subject: 'Admin · frozen abuse',
        html: '<p>frozen</p>',
        text: 'frozen',
        from: 'x <x@example.com>',
        alertCount: 1,
        createdAt: 1,
      },
    });
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({ sent: 1, retired: 0 });
    // Byte-for-byte the frozen request, under its own key — a re-render would
    // 409 against a key this batch has already used.
    expect((send.mock.calls[0][0] as { html: string }).html).toBe('<p>frozen</p>');
    expect((send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey).toBe('admin-digest/med-2026/a1__1');
  });

  it('LEAVES the row untouched when release finds a NEWER claim already in place (stale)', async () => {
    // The concurrency guard `releaseBatch` exists for: a second invocation
    // re-claims (or settles) these rows between this drain reading the frozen
    // batch and its own release transaction. `data.batchId !== batchId` must
    // refuse the release — erasing that newer claim would strand or duplicate
    // whatever it is doing.
    const send = vi.fn(async () => true);
    const db = build([alert('a1', { batchId: 'a1__1' })], {
      'events/med-2026/adminAlertBatches/a1__1': {
        to: ['removed-admin@example.com'],
        subject: 'Admin · stale',
        html: '<p>stale</p>',
        text: 'stale',
        from: 'x <x@example.com>',
        alertCount: 1,
        createdAt: 1,
      },
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await sendAdminDigestForEvent(db, 'med-2026', {
      ...deps(send),
      getAdminUids: async () => {
        // Simulates the race: another invocation re-claims row `a1` under a
        // NEW batch id after this drain already read the frozen request but
        // before its release transaction re-reads the row.
        await db.doc('events/med-2026/adminAlerts/a1').set({ ...alert('a1'), batchId: 'someone-else/2' });
        return ['u1'];
      },
    });
    spy.mockRestore();
    expect(result).toEqual({ sent: 0, retired: 0, reason: 'claim-lost' });
    expect(send).not.toHaveBeenCalled();
    // The load-bearing assertion: the row is exactly what the newer claim
    // left it as — release neither erased it nor wrote anything of its own.
    const row = db.rows('events/med-2026/adminAlerts').find((r) => r.id === 'a1');
    expect(row?.batchId).toBe('someone-else/2');
    // The abandoned freeze is not deleted out from under the newer claim.
    const frozenAfter = await db.doc('events/med-2026/adminAlertBatches/a1__1').get();
    expect(frozenAfter.data()).toBeDefined();
  });

  it('LEAVES the row untouched when release finds it TOMBSTONED under the same claim (stale)', async () => {
    // The other half of `releaseBatch`'s guard: `data.sentAt !== null`,
    // isolated the same way the newer-claim test above isolates
    // `data.batchId !== batchId` — by changing only the one field the guard
    // checks and holding the other constant. A concurrent drain can settle
    // (send + tombstone) these SAME rows between this invocation's
    // frozen-batch read and its own release transaction; `sentAt` going
    // non-null must refuse the release on its own, independent of whatever
    // `batchId` the row carries afterwards. (`finishBatch`'s real tombstone
    // is a full replace that also drops `batchId` — an even easier case,
    // already caught by the `batchId` half of the guard — so holding
    // `batchId` fixed here is what actually exercises the `sentAt` half:
    // deleting only that condition leaves this row's `batchId` still
    // matching, and would incorrectly "release" a row that was, in fact,
    // already delivered.)
    const send = vi.fn(async () => true);
    const db = build([alert('a1', { batchId: 'a1__1' })], {
      'events/med-2026/adminAlertBatches/a1__1': {
        to: ['removed-admin@example.com'],
        subject: 'Admin · stale',
        html: '<p>stale</p>',
        text: 'stale',
        from: 'x <x@example.com>',
        alertCount: 1,
        createdAt: 1,
      },
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await sendAdminDigestForEvent(db, 'med-2026', {
      ...deps(send),
      getAdminUids: async () => {
        // Simulates the race: another invocation settled row `a1` under this
        // SAME batch id after this drain already read the frozen request but
        // before its release transaction re-reads the row.
        await db.doc('events/med-2026/adminAlerts/a1').set({
          ...alert('a1'),
          batchId: 'a1__1',
          sentAt: NOW,
          expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
        });
        return ['u1'];
      },
    });
    spy.mockRestore();
    expect(result).toEqual({ sent: 0, retired: 0, reason: 'claim-lost' });
    expect(send).not.toHaveBeenCalled();
    // The load-bearing assertion: the row is exactly what the settling drain
    // left it as — release neither erased it nor wrote anything of its own.
    const row = db.rows('events/med-2026/adminAlerts').find((r) => r.id === 'a1');
    expect(row?.sentAt).toBe(NOW);
    expect(row?.batchId).toBe('a1__1');
    // The abandoned freeze is not deleted out from under the settled send.
    const frozenAfter = await db.doc('events/med-2026/adminAlertBatches/a1__1').get();
    expect(frozenAfter.data()).toBeDefined();
  });

  it('LEAVES the row untouched when the release TRANSACTION itself fails (failed)', async () => {
    // The other early return: the transaction rejects outright (a backend
    // error), and `releaseBatch`'s catch block must not have written anything
    // — the row stays claimed for a later, safe retry, and the frozen batch
    // that would otherwise resurrect a tombstone is not dropped either.
    const send = vi.fn(async () => true);
    const db = build(
      [alert('a1', { batchId: 'a1__1' })],
      {
        'events/med-2026/adminAlertBatches/a1__1': {
          to: ['removed-admin@example.com'],
          subject: 'Admin · stale',
          html: '<p>stale</p>',
          text: 'stale',
          from: 'x <x@example.com>',
          alertCount: 1,
          createdAt: 1,
        },
      },
      { failClaim: true },
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    spy.mockRestore();
    expect(result).toEqual({ sent: 0, retired: 0, reason: 'claim-failed' });
    expect(send).not.toHaveBeenCalled();
    const row = db.rows('events/med-2026/adminAlerts').find((r) => r.id === 'a1');
    expect(row?.batchId).toBe('a1__1');
    expect(row?.sentAt).toBeNull();
    const frozenAfter = await db.doc('events/med-2026/adminAlertBatches/a1__1').get();
    expect(frozenAfter.data()).toBeDefined();
  });

  it('REPLAYS the winner when it loses the freeze race, discarding its own render', async () => {
    // The claim commits before the freeze is written, so a second invocation
    // can see claimed rows with no frozen document and correctly rebuild (no
    // freeze means nothing was sent). Two unconditional writes would then race
    // and the surviving freeze might not be the request Resend accepted.
    // `create` makes exactly one render win.
    const send = vi.fn(async () => true);
    const db = build([alert('a1')], {
      // Another invocation got there first, under the id this drain will mint.
      'events/med-2026/adminAlertBatches/a1__1': {
        to: ['u1@example.com'],
        subject: 'Admin · the winning render',
        html: '<p>winner</p>',
        text: 'winner',
        from: 'x <x@example.com>',
        alertCount: 1,
        createdAt: 1,
      },
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    spy.mockRestore();
    expect(result.sent).toBe(1);
    // One batch id can only ever name one request.
    expect((send.mock.calls[0][0] as { subject: string }).subject).toBe('Admin · the winning render');
    expect((send.mock.calls[0][0] as { html: string }).html).toBe('<p>winner</p>');
  });

  it('refuses to claim a TOMBSTONE, which carries no batchId and would otherwise look free', async () => {
    // The overlapping-drain race: the other invocation finished first and
    // REPLACED the shared rows with tombstones. A claimed-only check reads a
    // tombstone as unclaimed, merges a new batch id onto it, and mails the
    // stale pre-tombstone snapshot a second time.
    const send = vi.fn(async () => true);
    const rows = [alert('a1', { sentAt: NOW - 1, expiresAt: new Date(NOW) }), alert('a2')];
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': rows, events: [{ id: 'med-2026', status: 'active' }], hostnames: [] },
      { 'events/med-2026': EVENT, 'events/med-2026/items/i-a2': { status: 'pending', reportCount: 0 } },
    );
    // The pending query already excludes the tombstone, so the claim covers a2
    // alone — and the transaction would refuse it even if it did not.
    const result = await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    expect(result.sent).toBe(1);
    expect((send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey).toBe('admin-digest/med-2026/a2__1');
    // The tombstone is untouched: not re-claimed, not re-sent.
    const tomb = db.rows('events/med-2026/adminAlerts').find((r) => r.id === 'a1');
    expect(tomb?.batchId).toBeUndefined();
  });
});

describe('sameRecipients', () => {
  it('compares authorized sets, not resolution order or duplicates', () => {
    expect(sameRecipients(['a@x.com', 'b@x.com'], ['b@x.com', 'a@x.com'])).toBe(true);
    expect(sameRecipients(['A@X.com'], ['a@x.com'])).toBe(true);
    expect(sameRecipients([' a@x.com '], ['a@x.com'])).toBe(true);
    expect(sameRecipients(['a@x.com', 'a@x.com'], ['a@x.com'])).toBe(true);
    // A removal and an addition both count as a change.
    expect(sameRecipients(['a@x.com'], ['a@x.com', 'b@x.com'])).toBe(false);
    expect(sameRecipients(['a@x.com', 'b@x.com'], ['a@x.com'])).toBe(false);
    expect(sameRecipients([], ['a@x.com'])).toBe(false);
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
    const db = fakeDb({}, { 'events/e': EVENT });
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

  it('uses the archived-Event pass as a backstop for late queue rows', async () => {
    const send = vi.fn(async () => true);
    const db = fakeDb(
      {
        events: [{ id: 'med-2026', status: 'archived' }],
        'events/med-2026/adminAlerts': [
          {
            id: 'late',
            kind: 'item-created',
            collection: 'items',
            docId: 'i1',
            label: 'Late producer',
            status: 'pending',
            visionFlag: null,
            reportCount: 0,
            createdAt: 1,
            sentAt: null,
          },
        ],
      },
      { 'events/med-2026': { ...EVENT, status: 'archived' } },
    );

    await runAdminAlertSweep(db, { send: send as never, now: () => NOW });
    expect(send).not.toHaveBeenCalled();
    expect(db.rows('events/med-2026/adminAlerts')[0]).toEqual({
      id: 'late',
      discardedAt: NOW,
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    });
  });
});

describe('settleAdminAlertsForArchivedEvent', () => {
  const pending = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    kind: 'item-created',
    collection: 'items',
    docId: 'i1',
    label: 'Private pending Prompt',
    status: 'pending',
    visionFlag: null,
    reportCount: 0,
    createdAt: 1,
    sentAt: null,
    ...over,
  });

  it('discards an unclaimed archived row as a payload-free tombstone', async () => {
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': [pending()] },
      { 'events/med-2026': { ...EVENT, status: 'archived' } },
    );

    expect(await settleAdminAlertsForArchivedEvent(db, 'med-2026', { now: () => NOW })).toEqual({
      discarded: 1,
      preserved: 0,
    });
    const [row] = db.rows('events/med-2026/adminAlerts');
    expect(row).toEqual({
      id: 'a1',
      discardedAt: NOW,
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    });
    expect(await settleAdminAlertsForArchivedEvent(db, 'med-2026', { now: () => NOW + 1 })).toEqual({
      discarded: 0,
      preserved: 0,
    });
    expect(db.rows('events/med-2026/adminAlerts')[0]).toEqual(row);
  });

  it('never resurrects a discard tombstone after reactivation and producer redelivery', async () => {
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': [pending({ id: 'evt-1-item-created' })] },
      { 'events/med-2026': { ...EVENT, status: 'archived' } },
    );
    await settleAdminAlertsForArchivedEvent(db, 'med-2026', { now: () => NOW });
    db.setDoc('events/med-2026', EVENT);

    const drafts = alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' }));
    expect(await enqueueAdminAlerts(db, 'med-2026', drafts, 'evt-1')).toBe(0);
    expect(db.rows('events/med-2026/adminAlerts')[0]).toEqual({
      id: 'evt-1-item-created',
      discardedAt: NOW,
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    });
  });

  it('does not let a stale archive invocation discard work after reactivation', async () => {
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': [pending()] },
      { 'events/med-2026': { ...EVENT, status: 'active' } },
    );

    expect(await settleAdminAlertsForArchivedEvent(db, 'med-2026', { now: () => NOW })).toEqual({
      discarded: 0,
      preserved: 0,
    });
    expect(db.rows('events/med-2026/adminAlerts')[0]).toEqual(pending());
  });

  it('discards a claim that never acquired a frozen request', async () => {
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': [pending({ batchId: 'a1__1' })] },
      { 'events/med-2026': { ...EVENT, status: 'archived' } },
    );

    expect(await settleAdminAlertsForArchivedEvent(db, 'med-2026', { now: () => NOW })).toEqual({
      discarded: 1,
      preserved: 0,
    });
    expect(db.rows('events/med-2026/adminAlerts')[0]).toEqual({
      id: 'a1',
      discardedAt: NOW,
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    });
  });

  it('preserves and settles a frozen claim under its original bytes and key', async () => {
    const send = vi.fn(async () => true);
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': [pending({ batchId: 'a1__1' })] },
      {
        'events/med-2026': { ...EVENT, status: 'archived' },
        'events/med-2026/items/i1': { status: 'pending', reportCount: 0 },
        'events/med-2026/adminAlertBatches/a1__1': {
          to: ['u1@example.com'],
          subject: 'Admin · frozen before archive',
          html: '<p>frozen</p>',
          text: 'frozen',
          from: 'Five Across <alerts@example.com>',
          alertCount: 1,
        },
      },
    );

    expect(
      await settleAdminAlertsForArchivedEvent(db, 'med-2026', {
        now: () => NOW,
        send: send as never,
        getAdminUids: async () => ['u1'],
        getEmailForUid: async () => 'u1@example.com',
        adminNotifyEmail: '',
      }),
    ).toEqual({ discarded: 0, preserved: 1 });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Admin · frozen before archive',
        idempotencyKey: 'admin-digest/med-2026/a1__1',
      }),
    );
    expect(db.rows('events/med-2026/adminAlerts')[0]).toEqual({
      id: 'a1',
      sentAt: NOW,
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    });
  });

  it('discards an archived frozen claim atomically when recipient revalidation releases it', async () => {
    const send = vi.fn(async () => true);
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': [pending({ batchId: 'a1__1' })] },
      {
        'events/med-2026': { ...EVENT, status: 'archived' },
        'events/med-2026/adminAlertBatches/a1__1': {
          to: ['former-admin@example.com'],
          subject: 'Admin · frozen before archive',
          html: '<p>frozen</p>',
          text: 'frozen',
          from: 'Five Across <alerts@example.com>',
          alertCount: 1,
        },
      },
    );

    expect(
      await settleAdminAlertsForArchivedEvent(db, 'med-2026', {
        now: () => NOW,
        send: send as never,
        getAdminUids: async () => [],
        adminNotifyEmail: '',
      }),
    ).toEqual({ discarded: 1, preserved: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(db.rows('events/med-2026/adminAlerts')[0]).toEqual({
      id: 'a1',
      discardedAt: NOW,
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    });
    expect(db.rows('events/med-2026/adminAlertBatches')).toEqual([]);
  });

  it('does not send when archive tombstones the claim before its freeze commits', async () => {
    const send = vi.fn(async () => true);
    const db = fakeDb(
      { 'events/med-2026/adminAlerts': [pending()] },
      {
        'events/med-2026': { ...EVENT, status: 'active' },
        'events/med-2026/items/i1': { status: 'pending', reportCount: 0 },
      },
    );
    const originalDoc = db.doc.bind(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).doc = (path: string) => {
      const ref = originalDoc(path);
      if (!path.includes('/adminAlertBatches/')) return ref;
      return {
        ...ref,
        create: async (data: Record<string, unknown>) => {
          db.setDoc('events/med-2026', { ...EVENT, status: 'archived' });
          await settleAdminAlertsForArchivedEvent(db, 'med-2026', { now: () => NOW });
          return ref.create(data);
        },
      };
    };

    expect(
      await sendAdminDigestForEvent(db, 'med-2026', {
        send: send as never,
        getAdminUids: async () => ['u1'],
        getEmailForUid: async () => 'u1@example.com',
        adminNotifyEmail: '',
        appBaseUrl: 'https://gaycruisebingo.com',
        from: 'Five Across <alerts@example.com>',
        now: () => NOW,
        quietMs: 0,
      }),
    ).toEqual({ sent: 0, retired: 0, reason: 'claim-lost' });
    expect(send).not.toHaveBeenCalled();
    expect(db.rows('events/med-2026/adminAlerts')[0]).toEqual({
      id: 'a1',
      discardedAt: NOW,
      expiresAt: new Date(NOW + TOMBSTONE_TTL_MS),
    });
    expect(db.rows('events/med-2026/adminAlertBatches')).toEqual([]);
  });
});

describe('shouldSettleAdminAlertsOnArchive', () => {
  it('fires once for the active-to-archived lifecycle edge', () => {
    expect(shouldSettleAdminAlertsOnArchive({ status: 'active' }, { status: 'archived' })).toBe(true);
    expect(shouldSettleAdminAlertsOnArchive({ status: 'archived' }, { status: 'archived' })).toBe(false);
    expect(shouldSettleAdminAlertsOnArchive({ status: 'draft' }, { status: 'archived' })).toBe(false);
    expect(shouldSettleAdminAlertsOnArchive({ status: 'active' }, { status: 'active' })).toBe(false);
    expect(shouldSettleAdminAlertsOnArchive({ status: 'active' }, undefined)).toBe(false);
  });
});

// --- Abuse-marked bug reports (#670) ---------------------------------------------
//
// The fourth alert kind, and the only one whose subject document does NOT live
// under the Event. Everything below exists because of that one difference:
// `bugReports` is top-level with an `eventId` FIELD, and it carries none of the
// `status`/`reportCount` moderation vocabulary the other three are read through.

const BUG_REPORT = (over: Partial<BugReportDoc> = {}): BugReportDoc => ({
  kind: 'bug',
  description: 'The board stopped responding.',
  eventId: 'med-2026',
  reporterHash: '0123456789abcdefabcd',
  status: 'new',
  ...over,
});

/** An abuse report as INTAKE writes one: marked, and carrying the server's own
 *  answer to "does this reporter belong to the Event they named?". */
const ABUSE_REPORT = (over: Partial<BugReportDoc> = {}): BugReportDoc =>
  BUG_REPORT({ kind: 'abuse', reporterInEvent: true, ...over });
const IDEMPOTENT_REPORT_ID = 'a'.repeat(64);

describe('abuseAlertsForWrite', () => {
  it('queues one alert for a production-shaped legacy abuse create carrying reporterHash', () => {
    expect(abuseAlertsForWrite('r1', undefined, ABUSE_REPORT())).toEqual([
      {
        kind: 'abuse-reported',
        collection: 'bugReports',
        docId: 'r1',
        label: 'The board stopped responding.',
        status: 'new',
        visionFlag: null,
        reportCount: 0,
      },
    ]);
  });

  it('queues an idempotent abuse report only for its matching pending-to-complete transition', () => {
    const pending = BUG_REPORT({
      intakeState: 'pending',
      submissionId: 'submit_12345678',
      reporterHash: '0123456789abcdefabcd',
      requestHashVersion: 1,
      requestHash: 'a'.repeat(64),
    });
    const complete = ABUSE_REPORT({
      intakeState: 'complete',
      submissionId: 'submit_12345678',
      reporterHash: '0123456789abcdefabcd',
      requestHashVersion: 1,
      requestHash: 'a'.repeat(64),
    });
    expect(abuseAlertsForWrite(IDEMPOTENT_REPORT_ID, pending, complete)).toHaveLength(1);
    expect(abuseAlertsForWrite('not-deterministic', pending, complete)).toEqual([]);
    expect(abuseAlertsForWrite(IDEMPOTENT_REPORT_ID, undefined, complete)).toEqual([]);
    expect(abuseAlertsForWrite(IDEMPOTENT_REPORT_ID, { ...pending, intakeState: 'deleting' }, complete)).toEqual([]);
    expect(abuseAlertsForWrite(IDEMPOTENT_REPORT_ID, pending, { ...complete, requestHash: 'different' })).toEqual([]);
    expect(abuseAlertsForWrite(IDEMPOTENT_REPORT_ID, pending, { ...complete, intakeState: 'deleting' })).toEqual([]);
    expect(abuseAlertsForWrite(IDEMPOTENT_REPORT_ID, pending, { ...complete, requestHash: 'not-a-hash' })).toEqual([]);
    expect(abuseAlertsForWrite(IDEMPOTENT_REPORT_ID, undefined, { ...complete, intakeState: undefined })).toEqual([]);
  });

  it('never queues a staging create or a later completed-report update', () => {
    const pending = ABUSE_REPORT({
      intakeState: 'pending',
      submissionId: 'submit_12345678',
      reporterHash: '0123456789abcdefabcd',
      requestHashVersion: 1,
      requestHash: 'a'.repeat(64),
    });
    const complete = { ...pending, intakeState: 'complete' };
    expect(abuseAlertsForWrite(IDEMPOTENT_REPORT_ID, undefined, pending)).toEqual([]);
    expect(abuseAlertsForWrite(IDEMPOTENT_REPORT_ID, complete, { ...complete, status: 'triaged' })).toEqual([]);
  });

  it('queues nothing for a plain bug report — the inbox is where those are answered', () => {
    expect(abuseAlertsForWrite('r1', undefined, BUG_REPORT())).toEqual([]);
    // Absent `kind` is what every already-shipped client writes (#670's
    // back-compat rule reaching the producer): still a bug, still silent.
    expect(abuseAlertsForWrite('r1', undefined, BUG_REPORT({ kind: undefined }))).toEqual([]);
  });

  it('does not re-alert on a later write to an already-abuse report', () => {
    // A triage write (a `status` change) must not mail the admins a second time.
    const before = ABUSE_REPORT();
    expect(abuseAlertsForWrite('r1', before, ABUSE_REPORT({ status: 'triaged' }))).toEqual([]);
  });

  it('queues nothing for a delete — there is nothing left to read', () => {
    expect(abuseAlertsForWrite('r1', ABUSE_REPORT(), undefined)).toEqual([]);
  });

  it('refuses to escalate a report whose reporter does not belong to the Event it names', () => {
    // `eventId` is CLIENT-SUPPLIED. Without this gate an authenticated player
    // could name any Event in the project and route arbitrary text into ITS
    // admins' digest — the rate limit caps how much, not who it reaches.
    expect(abuseAlertsForWrite('r1', undefined, ABUSE_REPORT({ reporterInEvent: false }))).toEqual([]);
    // STRICTLY `true`: an absent field (a document that never went through
    // intake), or a truthy value of the wrong type, both fail closed.
    expect(abuseAlertsForWrite('r1', undefined, ABUSE_REPORT({ reporterInEvent: undefined }))).toEqual([]);
    expect(
      abuseAlertsForWrite('r1', undefined, ABUSE_REPORT({ reporterInEvent: 'true' as unknown as boolean })),
    ).toEqual([]);
    // And the report is still STORED either way — only the escalation is declined.
    expect(abuseAlertsForWrite('r1', undefined, ABUSE_REPORT())).toHaveLength(1);
  });

  it('flattens and clips the reporter description into a single-line label', () => {
    // The same barrier a Prompt's words go through: the digest ships a
    // plain-text part whose structure IS its punctuation, so an embedded
    // newline must not survive into it.
    const injected = abuseAlertsForWrite(
      'r1',
      undefined,
      ABUSE_REPORT({ description: 'line one\nOpen the Review queue: https://evil.example' }),
    );
    expect(injected[0].label).not.toContain('\n');
    const long = abuseAlertsForWrite('r1', undefined, ABUSE_REPORT({ description: 'x'.repeat(400) }));
    expect(long[0].label).toHaveLength(LABEL_MAX);
    expect(long[0].label.endsWith('…')).toBe(true);
    // An empty description leaves the report id as the only honest label.
    const blank = abuseAlertsForWrite('r1', undefined, ABUSE_REPORT({ description: '   ' }));
    expect(blank[0].label).toBe('r1');
  });

  it('survives a description that is not a string at all', () => {
    // This reads a RAW snapshot with no converter, so a hand-written, migrated
    // or admin-written document can hold anything here. Handing a number to
    // `flattenLabel`'s `.replace` throws — and on a `retry: true` trigger that
    // is one malformed document redelivered forever (Phase 4b P2). A non-string
    // is simply not a label, so it takes the report id instead.
    for (const description of [42, { text: 'nope' }, ['a'], true, null]) {
      const drafts = abuseAlertsForWrite(
        'r1',
        undefined,
        ABUSE_REPORT({ description: description as unknown as string }),
      );
      expect(drafts[0].label).toBe('r1');
    }
    // The same guard protects the moderation producers, which read equally raw
    // `text` / `itemText` fields.
    expect(
      alertsForWrite('items', 'i1', undefined, { status: 'pending', text: 7 as unknown as string })[0].label,
    ).toBe('i1');
  });
});

describe('bugReportEventId', () => {
  it('reads the Event off the document, and refuses anything it cannot trust', () => {
    expect(bugReportEventId(BUG_REPORT())).toBe('med-2026');
    expect(bugReportEventId(BUG_REPORT({ eventId: undefined }))).toBeNull();
    expect(bugReportEventId(BUG_REPORT({ eventId: '' }))).toBeNull();
    expect(bugReportEventId(BUG_REPORT({ eventId: 42 as unknown as string }))).toBeNull();
    // A `/` would reparent the queue write into a path nobody sweeps.
    expect(bugReportEventId(BUG_REPORT({ eventId: 'med-2026/../other' }))).toBeNull();
    expect(bugReportEventId(BUG_REPORT({ eventId: 'x'.repeat(101) }))).toBeNull();
    expect(bugReportEventId(undefined)).toBeNull();
  });
});

describe('recordBugReportAlerts', () => {
  const reportDb = (eventExists = true, status = 'active') =>
    fakeDb({}, eventExists ? { 'events/med-2026': { name: 'Trieste → Barcelona', status } } : {});

  it('stamps every queued row with a TTL, so a stranded copy of a report cannot live forever', async () => {
    // Until this existed a queue row had exactly ONE exit: being drained. The
    // sweep only visits active Events, so a row whose Event is archived before
    // the next sweep is never looked at again — and its copy of the reporter's
    // description outlives the source report, the 90-day retention sweep that
    // deletes it, and every decision anyone made about it (Phase 4b P1).
    const db = reportDb();
    await recordBugReportAlerts(db, 'r1', 'cloud-event-1', undefined, ABUSE_REPORT(), { now: () => NOW });
    const row = db.rows('events/med-2026/adminAlerts')[0];
    // A Date, NOT epoch millis: Firestore's TTL service only considers a
    // timestamp-typed field, so a number would leave the policy reaping nothing.
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect((row.expiresAt as Date).getTime()).toBe(NOW + PENDING_TTL_MS);
    // Generous enough that no ordinary backlog is ever reaped, and shorter than
    // the source-report retention window it must not outlive.
    expect(PENDING_TTL_MS).toBeGreaterThan(TOMBSTONE_TTL_MS);
    expect(PENDING_TTL_MS).toBeLessThan(90 * 24 * 60 * 60 * 1000);
  });

  it('enqueues an abuse alert scoped to the report’s own Event', async () => {
    const db = reportDb();
    expect(await recordBugReportAlerts(db, 'r1', 'cloud-event-1', undefined, ABUSE_REPORT())).toBe(1);
    const rows = db.rows('events/med-2026/adminAlerts');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(alertDocId('cloud-event-1', 'abuse-reported'));
    expect(rows[0].collection).toBe('bugReports');
    expect(rows[0].docId).toBe('r1');
    expect(rows[0].sentAt).toBeNull();
  });

  it('enqueues nothing for a plain bug report', async () => {
    const db = reportDb();
    expect(await recordBugReportAlerts(db, 'r1', 'cloud-event-1', undefined, BUG_REPORT())).toBe(0);
    expect(db.rows('events/med-2026/adminAlerts')).toEqual([]);
  });

  it('is a no-op on trigger redelivery — the same CloudEvent id writes one row', async () => {
    const db = reportDb();
    const report = ABUSE_REPORT();
    await recordBugReportAlerts(db, 'r1', 'cloud-event-1', undefined, report);
    // The redelivery carries the same CloudEvent id, so `create` rejects with
    // ALREADY_EXISTS and the second call writes nothing.
    expect(await recordBugReportAlerts(db, 'r1', 'cloud-event-1', undefined, report)).toBe(0);
    expect(db.rows('events/med-2026/adminAlerts')).toHaveLength(1);
  });

  it('refuses to enqueue when the report names no usable Event, rather than guessing one', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = reportDb();
    expect(
      await recordBugReportAlerts(db, 'r1', 'e1', undefined, ABUSE_REPORT({ eventId: undefined })),
    ).toBe(0);
    expect(db.rows('events/med-2026/adminAlerts')).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses to enqueue against an Event that does not resolve', async () => {
    // The sweep finds work by iterating `events`, so a row under an unresolvable
    // Event would never be visited, drained or tombstoned — an orphaned copy of
    // a report's words living in Firestore forever.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = reportDb(false);
    expect(await recordBugReportAlerts(db, 'r1', 'e1', undefined, ABUSE_REPORT())).toBe(0);
    expect(db.rows('events/med-2026/adminAlerts')).toEqual([]);
    spy.mockRestore();
  });

  it('refuses to enqueue against a non-ACTIVE Event, matching the sweep’s own precondition', async () => {
    // `runAdminAlertSweep` finds work with `where('status', '==', 'active')`, so
    // a row under an archived Event is never visited unless somebody reactivates
    // it. Reachable here in a way it is not for the moderation producers: those
    // fire on writes to an Event's own content, which stop when the Event does,
    // while a player can file a report against an Event long after it ended.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const event of [{ status: 'archived' }, { status: 'draft' }, { name: 'no status field at all' }]) {
      const db = fakeDb({}, { 'events/med-2026': event });
      expect(await recordBugReportAlerts(db, 'r1', 'e1', undefined, ABUSE_REPORT())).toBe(0);
      expect(db.rows('events/med-2026/adminAlerts')).toEqual([]);
    }
    spy.mockRestore();
  });

  it('PROPAGATES a failed Event lookup so the retryable trigger can try again', async () => {
    // The permanent answers above all return normally, which tells the platform
    // "handled, do not retry" — correct, because retrying changes nothing about
    // them. A transient Firestore failure is the opposite: nothing about the
    // report is wrong, and swallowing it silently and permanently loses a report
    // of harm. `notifyAbuseBugReport` is declared `retry: true`, and the alert
    // id derives from the CloudEvent id, so a retry is a no-op if the write
    // already landed (Phase 4b P1).
    const db = fakeDb({}, { 'events/med-2026': { name: 'x', status: 'active' } }, ['events/med-2026']);
    await expect(recordBugReportAlerts(db, 'r1', 'e1', undefined, ABUSE_REPORT())).rejects.toThrow(
      /backend unavailable/,
    );
    expect(db.rows('events/med-2026/adminAlerts')).toEqual([]);
  });

  it('ACKNOWLEDGES a permanent failure instead of looping the retryable trigger on it', async () => {
    // A retryable trigger that rethrows everything turns a misconfigured service
    // account into an Eventarc redelivery loop that can never succeed, burning
    // quota and burying the real error (Phase 4b P2).
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = reportDb();
    const denied = Object.assign(new Error('permission denied'), { code: 7 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (db as any).doc;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).doc = (path: string) => {
      if (path === 'events/med-2026') return { get: async () => { throw denied; } };
      return original(path);
    };
    await expect(recordBugReportAlerts(db, 'r1', 'e1', undefined, ABUSE_REPORT())).resolves.toBe(0);
    spy.mockRestore();
  });

  it('PROPAGATES a failed queue write, unlike the moderation producers', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = reportDb();
    const boom = new Error('write unavailable');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).runTransaction = async () => {
      throw boom;
    };
    await expect(recordBugReportAlerts(db, 'r1', 'e1', undefined, ABUSE_REPORT())).rejects.toThrow(boom);
    spy.mockRestore();
  });

  it('does NOT propagate a queue write failure for the moderation producers', async () => {
    // ADR 0001: their trigger guards a content write and is not retryable, so a
    // queue failure stays swallowed. The opt-in is what separates the two.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = fakeDb({}, { 'events/med-2026': EVENT });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).runTransaction = async () => {
      throw new Error('write unavailable');
    };
    await expect(
      recordAdminAlerts(db, 'items', 'med-2026', 'i1', 'e1', undefined, ITEM({ status: 'pending' })),
    ).resolves.toBe(0);
    spy.mockRestore();
  });
});

describe('isRetryableFirestoreError', () => {
  it('treats request-is-wrong statuses as permanent and everything else as retryable', () => {
    // Permanent: retrying cannot change the outcome.
    for (const code of [3, 5, 6, 7, 9, 11, 12, 16]) {
      expect(isRetryableFirestoreError({ code })).toBe(false);
    }
    for (const code of ['permission-denied', 'INVALID-ARGUMENT', 'not-found']) {
      expect(isRetryableFirestoreError({ code })).toBe(false);
    }
    // Retryable: the request was fine, the backend was not.
    for (const code of [1, 2, 4, 8, 10, 13, 14, 'unavailable', 'deadline-exceeded']) {
      expect(isRetryableFirestoreError({ code })).toBe(true);
    }
    // Unknown or absent leans RETRYABLE on purpose: retrying something permanent
    // wastes invocations, acknowledging something transient loses a report.
    expect(isRetryableFirestoreError(new Error('no code at all'))).toBe(true);
    expect(isRetryableFirestoreError(undefined)).toBe(true);
    expect(isRetryableFirestoreError({ code: 999 })).toBe(true);
  });
});

describe('the abuse module in the digest', () => {
  const abuseAlert = (id: string, over: Partial<AdminAlertRecord> = {}): AdminAlertRecord =>
    ALERT({
      id,
      kind: 'abuse-reported',
      collection: 'bugReports',
      docId: `report_${id}`,
      label: 'Someone is posting slurs in the feed',
      status: 'new',
      reportCount: 0,
      ...over,
    });

  it('renders abuse in its OWN module, ahead of the moderation ones, and names it in the subject', () => {
    const model = buildAdminDigestModel({
      event: EVENT,
      eventId: 'med-2026',
      alerts: [
        abuseAlert('a1', { createdAt: 2_000 }),
        ALERT({ id: 'a2', kind: 'item-created', status: 'pending', reportCount: 0, createdAt: 1_000 }),
      ],
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
    });
    expect(model.sections.map((s) => s.heading)).toEqual(['Abuse reports', 'Awaiting approval']);
    expect(model.sections[0].rows).toEqual([
      { label: 'Someone is posting slurs in the feed', detail: 'abuse report · report_a1' },
    ]);
    expect(model.subject).toBe('Admin · Trieste → Barcelona—1 abuse report, 1 to approve');
    expect(model.preheader).toContain('2 items');
  });

  it('renders one row per REPORT, never collapsing two abuse reports into one', () => {
    // The moderation module keys by content because two reports about one Proof
    // are one piece of work. A bug report has no subject document to collapse
    // toward, only its own text — so each row stands for one report, and the
    // report ID in its detail line is how an admin tells two rows apart. The
    // rows deliberately do NOT claim two distinct reporters: intake has no
    // submission idempotency yet, so one reporter retrying after a lost response
    // can produce two reports.
    const model = buildAdminDigestModel({
      event: EVENT,
      eventId: 'med-2026',
      alerts: [abuseAlert('a1'), abuseAlert('a2', { docId: 'report_a1' })],
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
    });
    expect(model.sections[0].rows).toHaveLength(2);
  });

  it('points its overflow at the bug-report inbox, not at the Review queue the CTA opens', () => {
    // Bug reports have no console surface; naming the wrong one would send an
    // admin looking somewhere the rows are not.
    const model = buildAdminDigestModel({
      event: EVENT,
      eventId: 'med-2026',
      alerts: Array.from({ length: ROWS_PER_SECTION + 2 }, (_, i) => abuseAlert(`a${i + 1}`)),
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
    });
    expect(model.sections[0].overflow).toBe(2);
    expect(renderAdminDigestText(model)).toContain('+2 more in the bug-report inbox');
    expect(renderAdminDigestHtml(model)).toContain('+2 more in the bug-report inbox');
  });

  it('survives the moderation liveness rules that would otherwise drop it as resolved', () => {
    // A bug report has no `status`/`reportCount` vocabulary, so every moderation
    // liveness answer for it is meaningless. Without the exemption the row would
    // be scored resolved and cleared the moment it was drained — queued,
    // claimed, tombstoned, never mailed.
    const alert = abuseAlert('a1');
    expect(currentRowFor(alert, {}, false)).toEqual(alert);
    expect(currentRowFor(alert, { status: 'active', reportCount: 0 }, false)).toEqual(alert);
    // A FAILED read still fails open, like every other kind.
    expect(currentRowFor(alert, undefined, true)).toEqual(alert);
  });

  it('RETIRES an abuse row whose source report has since been deleted', () => {
    // Exempt from the moderation rules is not exempt from existence. A digest
    // that cannot resolve a recipient leaves alerts pending indefinitely, and
    // the 90-day retention sweep can remove the source report meanwhile —
    // mailing the copied description and a dead report id after the private
    // source was deliberately deleted would break the retention promise the
    // tombstones exist to keep.
    expect(currentRowFor(abuseAlert('a1'), undefined, false)).toBeNull();
  });
});

describe('sendAdminDigestForEvent with an abuse alert', () => {
  it('MAILS an abuse row without re-reading a document that does not live under the Event', async () => {
    const send = vi.fn(async () => true);
    const db = fakeDb(
      {
        'events/med-2026/adminAlerts': [
          {
            id: 'a1',
            kind: 'abuse-reported',
            collection: 'bugReports',
            docId: 'report_xyz',
            label: 'Someone is posting slurs in the feed',
            status: 'new',
            visionFlag: null,
            reportCount: 0,
            createdAt: 1,
            sentAt: null,
          },
        ],
        hostnames: [],
        events: [{ id: 'med-2026', status: 'active' }],
      },
      {
        'events/med-2026': EVENT,
        // The source report at its TOP-LEVEL path. `events/med-2026/bugReports/
        // report_xyz` is deliberately NOT seeded: looking there would find
        // nothing and retire the row as though retention had deleted it.
        'bugReports/report_xyz': { kind: 'abuse', eventId: 'med-2026', reporterInEvent: true },
      },
    );
    const result = await sendAdminDigestForEvent(db, 'med-2026', {
      send: send as never,
      getAdminUids: async () => ['u1'],
      getEmailForUid: async (uid: string) => `${uid}@example.com`,
      adminNotifyEmail: '',
      appBaseUrl: 'https://gaycruisebingo.com',
      from: 'Gay Cruise Bingo <bingo@example.com>',
      now: () => NOW,
      quietMs: 0,
    });
    expect(result).toEqual({ sent: 1, retired: 0 });
    const arg = send.mock.calls[0][0] as { subject: string; text: string; html: string };
    expect(arg.subject).toBe('Admin · Trieste → Barcelona—1 abuse report');
    expect(arg.text).toContain('ABUSE REPORTS');
    expect(arg.text).toContain('report_xyz');
    expect(arg.html).toContain('Someone is posting slurs in the feed');
    // Drained and tombstoned like any other row.
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
  });

  it('sends nothing and clears the row when the source report was deleted before the digest went out', async () => {
    const send = vi.fn(async () => true);
    const db = fakeDb(
      {
        'events/med-2026/adminAlerts': [
          {
            id: 'a1',
            kind: 'abuse-reported',
            collection: 'bugReports',
            docId: 'report_gone',
            label: 'Someone is posting slurs in the feed',
            status: 'new',
            visionFlag: null,
            reportCount: 0,
            createdAt: 1,
            sentAt: null,
          },
        ],
        hostnames: [],
        events: [{ id: 'med-2026', status: 'active' }],
      },
      // No `bugReports/report_gone`: the retention sweep removed it while the
      // alert sat pending behind an unresolvable recipient.
      { 'events/med-2026': EVENT },
    );
    const result = await sendAdminDigestForEvent(db, 'med-2026', {
      send: send as never,
      getAdminUids: async () => ['u1'],
      getEmailForUid: async (uid: string) => `${uid}@example.com`,
      adminNotifyEmail: '',
      appBaseUrl: 'https://gaycruisebingo.com',
      from: 'Gay Cruise Bingo <bingo@example.com>',
      now: () => NOW,
      quietMs: 0,
    });
    expect(result).toEqual({ sent: 0, retired: 1, reason: 'nothing-current' });
    expect(send).not.toHaveBeenCalled();
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toEqual([]);
  });
});
