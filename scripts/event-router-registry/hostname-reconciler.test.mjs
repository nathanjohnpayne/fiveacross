import { describe, expect, it, vi } from 'vitest';
import { HostnameReconcilerRefusal, reconcileHostnameReplicas } from './hostname-reconciler.mjs';
import { deriveCanonicalProjection, projectionDigest } from './hostname-projection.mjs';

const HOST = 'bodega-bay.fiveacross.app';
const OTHER = 'sonoma.fiveacross.app';
const SYNTHETIC = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const NOW = '2026-09-20T12:00:00.000Z';

const hostnameDocument = (overrides = {}) => ({
  eventId: 'bodega-bay-2026',
  canonicalHost: HOST,
  edition: 'fiveacross',
  status: 'active',
  slug: 'bodega-bay',
  isCanonical: true,
  adultContent: false,
  ...overrides,
});

const ledgerFor = (host, revision, document) => ({
  schemaVersion: 1,
  revision,
  host,
  desired: deriveCanonicalProjection(host, document),
  updatedAt: '2026-09-01T00:00:00.000Z',
});

const digestOf = (host, revision, document) => projectionDigest(revision, host, deriveCanonicalProjection(host, document));

const auditPage = (overrides = {}) => ({
  committed: { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) },
  minimumPublisherEpoch: '2',
  highestAuthenticatedPublisherEpoch: '1',
  highestQuarantinedPublisherEpoch: '1',
  recoveryLock: null,
  lookup: { kind: 'committed', revision: '4' },
  records: [],
  nextAfter: null,
  ...overrides,
});

const record = (sequence, before, after) => ({
  sequence,
  action: 'apply',
  at: NOW,
  before,
  after,
});

const input = (overrides = {}) => ({
  schemaVersion: 1,
  mode: 'audit',
  apply: false,
  actor: 'nathanjohnpayne',
  reason: 'reconciler test',
  sourcePageSize: 100,
  ...overrides,
});

function dependencies({ pages, audits, applyMutation } = {}) {
  const sourcePages = pages ?? [
    { entries: [{ host: HOST, hostname: hostnameDocument(), routerReplica: ledgerFor(HOST, '4', hostnameDocument()) }], nextPageToken: null },
  ];
  let index = 0;
  return {
    now: () => new Date(NOW),
    listSourcePage: vi.fn(async () => sourcePages[index++] ?? { entries: [], nextPageToken: null }),
    readHostAuditPage: vi.fn(async ({ host, afterRecoverySequence }) => {
      const perHost = audits?.[host] ?? [auditPage()];
      const page = perHost.find((candidate) => (candidate.__after ?? '0') === afterRecoverySequence);
      if (page === undefined) throw new Error(`no audit fixture for ${host}@${afterRecoverySequence}`);
      const { __after, ...rest } = page;
      return rest;
    }),
    applyMutation: applyMutation ?? vi.fn(async () => ({ revisions: [{ host: HOST, from: null, to: '1' }] })),
  };
}

async function refusal(inputValue, deps) {
  try {
    await reconcileHostnameReplicas(inputValue, deps);
  } catch (error) {
    if (error instanceof HostnameReconcilerRefusal) return error.code;
    throw error;
  }
  return null;
}

describe('three-way reconciliation', () => {
  it('reports an already-correct host and follows no page it was not given', async () => {
    const deps = dependencies();
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.dryRun).toBe(true);
    expect(report.total).toBe(1);
    expect(report.counts['already-correct']).toBe(1);
    expect(report.hosts[0]).toEqual({
      host: HOST,
      state: 'already-correct',
      flags: [],
      sourceRevision: '4',
      committedRevision: '4',
      digestMatches: true,
      recoveryRecordCount: 0,
    });
    expect(deps.listSourcePage).toHaveBeenCalledTimes(1);
    expect(deps.applyMutation).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing',
      { hostname: hostnameDocument(), routerReplica: ledgerFor(HOST, '4', hostnameDocument()) },
      auditPage({ committed: null, lookup: { kind: 'unknown-host' } }),
    ],
    [
      'missing-ledger',
      { hostname: hostnameDocument(), routerReplica: null },
      auditPage({ committed: null, lookup: { kind: 'unknown-host' } }),
    ],
    [
      'drifted',
      {
        hostname: hostnameDocument(),
        routerReplica: ledgerFor(HOST, '4', hostnameDocument({ status: 'disabled' })),
      },
      auditPage(),
    ],
    [
      'poisoned',
      { hostname: hostnameDocument(), routerReplica: ledgerFor(HOST, '4', hostnameDocument()) },
      auditPage({ committed: { revision: '4', digest: 'f'.repeat(64) } }),
    ],
    [
      'source-behind',
      { hostname: hostnameDocument(), routerReplica: ledgerFor(HOST, '4', hostnameDocument()) },
      auditPage({ committed: { revision: '9', digest: digestOf(HOST, '9', hostnameDocument()) } }),
    ],
    [
      'edge-behind',
      { hostname: hostnameDocument(), routerReplica: ledgerFor(HOST, '7', hostnameDocument()) },
      auditPage(),
    ],
    [
      'malformed-source',
      { hostname: { eventId: 'e', edition: 'westminster', status: 'active', slug: 'bodega-bay' }, routerReplica: ledgerFor(HOST, '4', hostnameDocument()) },
      auditPage(),
    ],
    [
      'malformed-ledger',
      { hostname: hostnameDocument(), routerReplica: { schemaVersion: 1, revision: '4', host: HOST, desired: { kind: 'route' }, updatedAt: NOW } },
      auditPage(),
    ],
  ])('classifies %s', async (state, entry, page) => {
    const deps = dependencies({
      pages: [{ entries: [{ host: HOST, ...entry }], nextPageToken: null }],
      audits: { [HOST]: [page] },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts[0].state).toBe(state);
    expect(report.counts[state]).toBe(1);
  });

  it('classifies a repaired host as recovered once its history is non-empty', async () => {
    const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };
    const deps = dependencies({
      audits: { [HOST]: [auditPage({ committed, records: [record('1', null, committed)] })] },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts[0]).toMatchObject({ state: 'recovered', recoveryRecordCount: 1 });
  });

  it('flags a permanent tombstone, a held recovery lock and an unfenced quarantined epoch', async () => {
    const tombstone = { schemaVersion: 1, revision: '9', host: HOST, desired: { kind: 'tombstone' }, updatedAt: NOW };
    const committed = { revision: '9', digest: projectionDigest('9', HOST, { kind: 'tombstone' }) };
    const deps = dependencies({
      pages: [{ entries: [{ host: HOST, hostname: null, routerReplica: tombstone }], nextPageToken: null }],
      audits: {
        [HOST]: [
          auditPage({
            committed,
            recoveryLock: { lockId: 'l', acquiredAt: NOW, expectedCommitted: null, operatorSub: '1', incidentUrl: 'https://x', reason: 'r' },
            minimumPublisherEpoch: '3',
            highestQuarantinedPublisherEpoch: '3',
            lookup: { kind: 'unknown-host', revision: '9' },
          }),
        ],
      },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts[0].state).toBe('already-correct');
    expect(report.hosts[0].flags).toEqual(['tombstoned', 'locked', 'epoch-unfenced']);
    expect(report.flagCounts).toEqual({ tombstoned: 1, locked: 1, 'epoch-unfenced': 1 });
  });

  it('never audits or repairs a globally reserved rehearsal host', async () => {
    const deps = dependencies({
      pages: [{ entries: [{ host: SYNTHETIC, hostname: null, routerReplica: null }], nextPageToken: null }],
    });
    const report = await reconcileHostnameReplicas(input({ mode: 'backfill', apply: true }), deps);
    expect(report.hosts[0].state).toBe('reserved-class');
    expect(deps.readHostAuditPage).not.toHaveBeenCalled();
    expect(deps.applyMutation).not.toHaveBeenCalled();
  });
});

describe('backfill', () => {
  const missingLedger = {
    pages: [{ entries: [{ host: HOST, hostname: hostnameDocument(), routerReplica: null }], nextPageToken: null }],
    audits: { [HOST]: [auditPage({ committed: null, lookup: { kind: 'unknown-host' } })] },
  };

  it('is a dry run by default and writes through the lifecycle helper only on apply', async () => {
    const dry = dependencies(missingLedger);
    const dryReport = await reconcileHostnameReplicas(input({ mode: 'backfill' }), dry);
    expect(dryReport.dryRun).toBe(true);
    expect(dryReport.hosts[0].state).toBe('missing-ledger');
    expect(dry.applyMutation).not.toHaveBeenCalled();

    const wet = dependencies(missingLedger);
    const wetReport = await reconcileHostnameReplicas(input({ mode: 'backfill', apply: true }), wet);
    expect(wet.applyMutation).toHaveBeenCalledWith({
      schemaVersion: 1,
      intent: 'backfill-ledger',
      apply: true,
      actor: 'nathanjohnpayne',
      reason: 'reconciler test',
      host: HOST,
    });
    expect(wetReport.applied).toEqual([{ host: HOST, revision: '1' }]);
    expect(wetReport.hosts[0].state).toBe('backfilled');
  });

  it('is idempotent: a converged host is classified, never written again', async () => {
    const deps = dependencies();
    await reconcileHostnameReplicas(input({ mode: 'backfill', apply: true }), deps);
    expect(deps.applyMutation).not.toHaveBeenCalled();
  });

  it('never repairs a drifted, poisoned or source-behind host', async () => {
    for (const page of [
      auditPage({ committed: { revision: '4', digest: 'f'.repeat(64) } }),
      auditPage({ committed: { revision: '9', digest: digestOf(HOST, '9', hostnameDocument()) } }),
    ]) {
      const deps = dependencies({ audits: { [HOST]: [page] } });
      await reconcileHostnameReplicas(input({ mode: 'backfill', apply: true }), deps);
      expect(deps.applyMutation).not.toHaveBeenCalled();
    }
  });

  it('refuses a backfill result that does not name exactly one revision', async () => {
    const deps = dependencies({ ...missingLedger, applyMutation: vi.fn(async () => ({ revisions: [] })) });
    expect(await refusal(input({ mode: 'backfill', apply: true }), deps)).toBe('backfill-result-malformed');
  });
});

describe('pagination', () => {
  it('follows the source listing to its end and audits every host it returns', async () => {
    const deps = dependencies({
      pages: [
        { entries: [{ host: HOST, hostname: hostnameDocument(), routerReplica: ledgerFor(HOST, '4', hostnameDocument()) }], nextPageToken: 'p2' },
        {
          entries: [
            {
              host: OTHER,
              hostname: hostnameDocument({ canonicalHost: OTHER, slug: 'sonoma', eventId: 'sonoma-2027' }),
              routerReplica: ledgerFor(OTHER, '1', hostnameDocument({ canonicalHost: OTHER, slug: 'sonoma', eventId: 'sonoma-2027' })),
            },
          ],
          nextPageToken: null,
        },
      ],
      audits: {
        [HOST]: [auditPage()],
        [OTHER]: [
          auditPage({
            committed: {
              revision: '1',
              digest: digestOf(OTHER, '1', hostnameDocument({ canonicalHost: OTHER, slug: 'sonoma', eventId: 'sonoma-2027' })),
            },
          }),
        ],
      },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.total).toBe(2);
    expect(report.pages).toEqual({ source: 2, audit: 2 });
    expect(deps.listSourcePage).toHaveBeenNthCalledWith(1, { pageToken: null, pageSize: 100 });
    expect(deps.listSourcePage).toHaveBeenNthCalledWith(2, { pageToken: 'p2', pageSize: 100 });
  });

  it('follows a host recovery history across audit pages', async () => {
    const first = { revision: '2', digest: 'a'.repeat(64) };
    const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };
    const deps = dependencies({
      audits: {
        [HOST]: [
          { ...auditPage({ committed, records: [record('1', null, first)], nextAfter: '1' }), __after: '0' },
          { ...auditPage({ committed, records: [record('2', first, committed)], nextAfter: null }), __after: '1' },
        ],
      },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts[0]).toMatchObject({ state: 'recovered', recoveryRecordCount: 2 });
    expect(report.pages.audit).toBe(2);
    expect(deps.readHostAuditPage).toHaveBeenNthCalledWith(2, { host: HOST, afterRecoverySequence: '1' });
  });

  it.each([
    ['a repeated source page token', { pages: [{ entries: [], nextPageToken: 'p' }, { entries: [], nextPageToken: 'p' }] }, 'source-pagination-unbounded'],
    [
      'a duplicated host across source pages',
      {
        pages: [
          { entries: [{ host: HOST, hostname: hostnameDocument(), routerReplica: null }], nextPageToken: 'p2' },
          { entries: [{ host: HOST, hostname: hostnameDocument(), routerReplica: null }], nextPageToken: null },
        ],
      },
      'duplicate-source-host',
    ],
  ])('refuses %s', async (_why, overrides, expected) => {
    expect(await refusal(input(), dependencies(overrides))).toBe(expected);
  });

  it('refuses an audit cursor that does not advance', async () => {
    const deps = dependencies({
      audits: { [HOST]: [{ ...auditPage({ nextAfter: '0' }), __after: '0' }] },
    });
    expect(await refusal(input(), deps)).toBe('audit-pagination-unbounded');
  });
});

describe('conflicting recovery histories', () => {
  const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };

  it.each([
    ['a sequence gap', [record('1', null, committed), record('3', committed, committed)]],
    ['a chain whose before does not follow the previous after', [record('1', null, { revision: '2', digest: 'a'.repeat(64) }), record('2', null, committed)]],
  ])('refuses %s', async (_why, records) => {
    const deps = dependencies({ audits: { [HOST]: [auditPage({ committed, records })] } });
    expect(await refusal(input(), deps)).toBe('conflicting-recovery-history');
  });

  it('refuses a terminal record that does not equal the state the object reports', async () => {
    const deps = dependencies({
      audits: { [HOST]: [auditPage({ committed, records: [record('1', null, { revision: '3', digest: 'b'.repeat(64) })] })] },
    });
    expect(await refusal(input(), deps)).toBe('conflicting-recovery-history');
  });

  it('refuses in backfill mode too, before any repair is attempted', async () => {
    const deps = dependencies({
      pages: [{ entries: [{ host: HOST, hostname: hostnameDocument(), routerReplica: null }], nextPageToken: null }],
      audits: { [HOST]: [auditPage({ committed, records: [record('2', null, committed)] })] },
    });
    expect(await refusal(input({ mode: 'backfill', apply: true }), deps)).toBe('conflicting-recovery-history');
    expect(deps.applyMutation).not.toHaveBeenCalled();
  });
});

describe('the reconciler boundary', () => {
  it('accepts exactly the four seams, and no edge store or acknowledgement writer', async () => {
    const deps = dependencies();
    for (const extra of ['kv', 'cache', 'acknowledgeDelivery', 'readSourceFromEdge']) {
      expect(await refusal(input(), { ...deps, [extra]: () => undefined }), extra).toBe('invalid-dependencies');
    }
    const { applyMutation, ...missing } = deps;
    expect(await refusal(input(), missing)).toBe('invalid-dependencies');
  });

  it('emits counts plus host and revision identifiers and no credential material', async () => {
    const report = await reconcileHostnameReplicas(input(), dependencies());
    expect(report.credentialMaterialOmitted).toBe(true);
    const serialized = JSON.stringify(report);
    for (const forbidden of ['token', 'Bearer', 'signature', 'oidc', 'privateKey']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(Object.keys(report.hosts[0]).sort()).toEqual([
      'committedRevision',
      'digestMatches',
      'flags',
      'host',
      'recoveryRecordCount',
      'sourceRevision',
      'state',
    ]);
  });

  it.each([
    ['an unknown mode', { mode: 'repair' }],
    ['a page size outside its bounds', { sourcePageSize: 0 }],
    ['a blank reason', { reason: ' ' }],
  ])('refuses %s', async (_why, overrides) => {
    expect(await refusal(input(overrides), dependencies())).toBe('invalid-input');
  });
});
