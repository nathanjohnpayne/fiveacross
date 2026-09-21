import { describe, expect, it, vi } from 'vitest';
import { HostnameReconcilerRefusal, reconcileHostnameReplicas } from './hostname-reconciler.mjs';
import { deriveCanonicalProjection, projectionDigest } from './hostname-projection.mjs';

const HOST = 'bodega-bay.fiveacross.app';
const OTHER = 'sonoma.fiveacross.app';
const SYNTHETIC = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
// Uppercase, so `validateHostShape` refuses it as `invalid-host` — the listing
// can name a host this projection may not describe.
const UNPROJECTABLE = 'Bodega-Bay.fiveacross.app';
const NOW = '2026-09-20T12:00:00.000Z';
const HELD_LOCK = {
  lockId: 'l',
  acquiredAt: NOW,
  expectedCommitted: null,
  operatorSub: '1',
  incidentUrl: 'https://x',
  reason: 'r',
};

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

// A stored `routerReplicas/{host}` row carries a Firestore `Timestamp`, not
// text: the deployed Eventarc parser accepts only a `timestampValue`, so
// `validateLedgerDocument` refuses a stored string.
const storedStamp = (iso) => ({ toDate: () => new Date(iso) });

const ledgerFor = (host, revision, document) => ({
  schemaVersion: 1,
  revision,
  host,
  desired: deriveCanonicalProjection(host, document),
  updatedAt: storedStamp('2026-09-01T00:00:00.000Z'),
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
      // Neither document exists: nothing to project and nothing projected, so
      // backfill has no ledger to create here.
      'no-documents',
      { hostname: null, routerReplica: null },
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
      { hostname: hostnameDocument(), routerReplica: { schemaVersion: 1, revision: '4', host: HOST, desired: { kind: 'route' }, updatedAt: storedStamp(NOW) } },
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

  // The deployed audit endpoint requires `host === normalizeHost(host)` and
  // answers 400 for anything else, so a single non-canonical document id used
  // to take the whole run down before any report existed. It is now
  // classified before the audit is attempted, like `reserved-class`, and the
  // good rows beside it are still reported. No flags: there is no audited
  // object to have read a lock or an epoch from.
  it('classifies an unauditable host without calling the audit endpoint, and keeps going', async () => {
    const deps = dependencies({
      pages: [
        {
          entries: [
            { host: UNPROJECTABLE, hostname: null, routerReplica: null },
            { host: HOST, hostname: hostnameDocument(), routerReplica: ledgerFor(HOST, '4', hostnameDocument()) },
          ],
          nextPageToken: null,
        },
      ],
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts.map((row) => [row.host, row.state])).toEqual([
      [UNPROJECTABLE, 'invalid-host'],
      [HOST, 'already-correct'],
    ]);
    expect(report.hosts[0].flags).toEqual([]);
    expect(report.counts['invalid-host']).toBe(1);
    expect(report.counts['already-correct']).toBe(1);
    // The endpoint that would have answered 400 was never called for it.
    expect(deps.readHostAuditPage.mock.calls.map(([args]) => args.host)).toEqual([HOST]);
  });

  // The label is syntactically a wildcard-Namespace subdomain but is reserved,
  // so no organizer could claim it and neither the publisher nor the worker
  // would accept a projection for it. Before the host rule reached the
  // tombstone arm this row read as `already-correct`: the derivation answered
  // a tombstone, the ledger held one, and the audit reported the matching
  // digest, so a ledger that can never be published looked converged.
  it('classifies a tombstone keyed to an unclaimable host as invalid source rather than converged', async () => {
    const host = 'admin.fiveacross.app';
    const tombstone = { schemaVersion: 1, revision: '9', host, desired: { kind: 'tombstone' }, updatedAt: storedStamp(NOW) };
    const committed = { revision: '9', digest: projectionDigest('9', host, { kind: 'tombstone' }) };
    const deps = dependencies({
      pages: [{ entries: [{ host, hostname: null, routerReplica: tombstone }], nextPageToken: null }],
      audits: { [host]: [auditPage({ committed, lookup: { kind: 'committed', revision: '9' } })] },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts[0].state).toBe('invalid-host');
    expect(report.counts['invalid-host']).toBe(1);
    expect(report.counts['already-correct']).toBe(0);
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
    const tombstone = { schemaVersion: 1, revision: '9', host: HOST, desired: { kind: 'tombstone' }, updatedAt: storedStamp(NOW) };
    const committed = { revision: '9', digest: projectionDigest('9', HOST, { kind: 'tombstone' }) };
    const deps = dependencies({
      pages: [{ entries: [{ host: HOST, hostname: null, routerReplica: tombstone }], nextPageToken: null }],
      audits: {
        [HOST]: [
          auditPage({
            committed,
            recoveryLock: HELD_LOCK,
            minimumPublisherEpoch: '3',
            highestQuarantinedPublisherEpoch: '3',
            lookup: { kind: 'unknown-host', revision: '9' },
          }),
        ],
      },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts[0].state).toBe('already-correct');
    // The lock and the epoch fence are read first because they are read for
    // every audited host; `tombstoned` can only follow a readable ledger.
    expect(report.hosts[0].flags).toEqual(['locked', 'epoch-unfenced', 'tombstoned']);
    expect(report.flagCounts).toEqual({ tombstoned: 1, locked: 1, 'epoch-unfenced': 1 });
  });

  it('does not report epoch-unfenced for an object that has never been quarantined', async () => {
    // Zero is the registry's no-quarantine sentinel rather than an epoch, so
    // there is nothing for the floor to fence and a `<=` test against it is a
    // false operational alarm on every never-quarantined host. The floor is
    // varied across its own initial and post-rotation values to show the flag
    // is off because of the sentinel and not because of the comparison.
    // `'0'` is deliberately NOT in this list: the floor is a positive
    // canonical decimal in `RegistryState` — only the two high-water marks
    // carry the zero sentinel — so an audit page answering zero for it is
    // malformed evidence rather than a never-quarantined object, and is
    // refused by the case below rather than classified from.
    for (const minimumPublisherEpoch of ['1', '9']) {
      const deps = dependencies({
        audits: { [HOST]: [auditPage({ minimumPublisherEpoch, highestQuarantinedPublisherEpoch: '0' })] },
      });
      const report = await reconcileHostnameReplicas(input(), deps);
      expect(report.hosts[0].flags, minimumPublisherEpoch).toEqual([]);
      expect(report.flagCounts['epoch-unfenced'], minimumPublisherEpoch).toBe(0);
    }

    // One real quarantine later, an unraised floor is flagged again.
    const quarantined = dependencies({
      audits: { [HOST]: [auditPage({ minimumPublisherEpoch: '7', highestQuarantinedPublisherEpoch: '7' })] },
    });
    expect((await reconcileHostnameReplicas(input(), quarantined)).hosts[0].flags).toEqual(['epoch-unfenced']);
  });

  // The floor is the one epoch field that may not be zero, so it is validated
  // apart from the two high-water marks. Accepting zero took a shape the
  // Durable Object never stores as evidence, and a floor of zero is not a
  // floor at all — the fence comparison below it cannot mean anything.
  // The audit contract emits revisions, sequences, cursors and epochs as
  // canonical decimal TEXT, for the reason every revision here is text: they
  // stay lossless under BigInt. A `String(...)` coercion accepted the
  // JSON-number form of each, and a number above MAX_SAFE_INTEGER has
  // already been rounded by the time it is stringified, so the reconciler
  // would compare and report a value the object never emitted.
  it.each([
    ['a committed revision', { committed: { revision: 4, digest: 'f'.repeat(64) } }],
    ['a rounded committed revision above MAX_SAFE_INTEGER', { committed: { revision: 9007199254740993, digest: 'f'.repeat(64) } }],
    ['the epoch floor', { minimumPublisherEpoch: 2 }],
    ['a high-water mark', { highestQuarantinedPublisherEpoch: 0 }],
  ])('refuses an audit page answering %s as a JSON number', async (_why, overrides) => {
    const deps = dependencies({ audits: { [HOST]: [auditPage(overrides)] } });
    expect(await refusal(input(), deps)).toBe('malformed-audit-page');
  });

  // The cursor keeps its own refusal, which is the one that already names
  // what went wrong with a pagination value.
  it('refuses an audit page answering its cursor as a JSON number', async () => {
    const deps = dependencies({ audits: { [HOST]: [auditPage({ nextAfter: 1 })] } });
    expect(await refusal(input(), deps)).toBe('audit-pagination-unbounded');
  });

  // The object emits a lowercase 64-character SHA-256 hex digest. Accepting
  // any non-empty string let a truncated or non-hex value decide a
  // classification: at an equal revision the comparison reports poisoned,
  // and across a recovery span it feeds the reachability check.
  it.each([
    ['truncated', 'f'.repeat(63)],
    ['over-long', 'f'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
    ['uppercase', 'F'.repeat(64)],
    ['empty', ''],
  ])('refuses an audit page whose committed digest is %s', async (_why, digest) => {
    const deps = dependencies({ audits: { [HOST]: [auditPage({ committed: { revision: '4', digest } })] } });
    expect(await refusal(input(), deps)).toBe('malformed-audit-page');
  });

  it('refuses a recovery record whose digest is not a SHA-256 hex string', async () => {
    const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };
    const truncated = record('1', null, { revision: '4', digest: 'a'.repeat(10) });
    const deps = dependencies({ audits: { [HOST]: [auditPage({ committed, records: [truncated] })] } });
    expect(await refusal(input(), deps)).toBe('malformed-audit-page');
  });

  it('refuses a recovery record whose sequence is a JSON number', async () => {
    const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };
    const numeric = { ...record('1', null, committed), sequence: 1 };
    const deps = dependencies({ audits: { [HOST]: [auditPage({ committed, records: [numeric] })] } });
    expect(await refusal(input(), deps)).toBe('malformed-audit-page');
  });

  it('refuses an audit page whose minimumPublisherEpoch is the zero sentinel', async () => {
    const deps = dependencies({
      audits: { [HOST]: [auditPage({ minimumPublisherEpoch: '0' })] },
    });
    expect(await refusal(input(), deps)).toBe('malformed-audit-page');
  });

  it.each(['0', '1'])('still accepts the zero sentinel on a high-water mark (%s)', async (value) => {
    const deps = dependencies({
      audits: {
        [HOST]: [auditPage({ highestAuthenticatedPublisherEpoch: value, highestQuarantinedPublisherEpoch: '0' })],
      },
    });
    expect((await reconcileHostnameReplicas(input(), deps)).hosts[0].state).toBe('already-correct');
  });

  // The two edge flags describe the audited Durable Object rather than the
  // three-way comparison, so an early classification has to carry them. A
  // `missing-ledger` host is precisely the row an apply run hands to the
  // lifecycle helper, and a held recovery lock must be visible on the report
  // before it does that rather than only on hosts that got as far as a
  // ledger comparison.
  it.each([
    ['missing-ledger', HOST, { hostname: hostnameDocument(), routerReplica: null }],
    ['no-documents', HOST, { hostname: null, routerReplica: null }],
    [
      'malformed-ledger',
      HOST,
      {
        hostname: hostnameDocument(),
        routerReplica: { schemaVersion: 1, revision: '4', host: HOST, desired: { kind: 'route' }, updatedAt: storedStamp(NOW) },
      },
    ],
    [
      'malformed-source',
      HOST,
      {
        hostname: { eventId: 'e', edition: 'westminster', status: 'active', slug: 'bodega-bay' },
        routerReplica: ledgerFor(HOST, '4', hostnameDocument()),
      },
    ],
  ])('reports a held lock and an unfenced epoch on the %s early return', async (state, host, entry) => {
    const deps = dependencies({
      pages: [{ entries: [{ host, ...entry }], nextPageToken: null }],
      audits: {
        [host]: [
          auditPage({
            committed: null,
            lookup: { kind: 'unknown-host' },
            recoveryLock: HELD_LOCK,
            minimumPublisherEpoch: '3',
            highestQuarantinedPublisherEpoch: '3',
          }),
        ],
      },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts[0].state).toBe(state);
    expect(report.hosts[0].flags).toEqual(['locked', 'epoch-unfenced']);
    expect(report.flagCounts).toEqual({ tombstoned: 0, locked: 1, 'epoch-unfenced': 1 });
  });

  // The prefix is refused to every CLAIM, but only the two closed patterns
  // are controller-owned. A host under the prefix matching neither is owned
  // by nothing — the publisher, the worker and `validateHostShape` all
  // reject it — so reporting it reserved-class hid a partial Admin write
  // behind a class that never produced it.
  it('reports an arbitrary r2- host as invalid rather than as controller-owned', async () => {
    const garbage = 'r2-garbage.fiveacross.app';
    const deps = dependencies({
      pages: [
        {
          entries: [
            { host: garbage, hostname: hostnameDocument(), routerReplica: null },
            { host: SYNTHETIC, hostname: null, routerReplica: null },
          ],
          nextPageToken: null,
        },
      ],
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts.map((row) => [row.host, row.state])).toEqual([
      [garbage, 'invalid-host'],
      [SYNTHETIC, 'reserved-class'],
    ]);
    // Neither was audited, but for different reasons, and neither reached
    // the endpoint.
    expect(deps.readHostAuditPage).not.toHaveBeenCalled();
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

  it('never backfills a missing ledger the edge has already committed past', async () => {
    // Backfill recreates the ledger at revision 1, and only an uninitialized
    // object accepts revision 1. Under an object that has committed revision
    // 4, the publication is refused at the edge while the report would have
    // said `backfilled`, so the row is classified for the explicit Admin
    // `advance-ledger` instead of repaired here.
    const deps = dependencies({
      pages: [{ entries: [{ host: HOST, hostname: hostnameDocument(), routerReplica: null }], nextPageToken: null }],
      audits: { [HOST]: [auditPage()] },
    });
    const report = await reconcileHostnameReplicas(input({ mode: 'backfill', apply: true }), deps);
    expect(report.hosts[0]).toMatchObject({
      state: 'missing-ledger-source-behind',
      sourceRevision: null,
      committedRevision: '4',
      digestMatches: null,
    });
    expect(report.counts['missing-ledger-source-behind']).toBe(1);
    expect(report.counts.backfilled).toBe(0);
    expect(report.applied).toEqual([]);
    expect(deps.applyMutation).not.toHaveBeenCalled();
  });

  // An applied repair is the first edge publication of a capability for a
  // source nothing in the helper wrote, so backfill-ledger requires the
  // attested barrier. The reconciler has to carry one or the run would have
  // thrown the moment it reached a missing ledger for a serving root, AFTER
  // backfilling whatever came earlier in the listing.
  const APEX_HOST = 'fiveacross.app';
  const apexSource = { root: 'doorway', edition: 'fiveacross', pathNamespace: 'fiveacross.app' };
  const BARRIER = {
    releaseTag: 'v2026.09.19-path-capability',
    workerVersionId: 'a1b2c3d4-0000-4000-8000-000000000001',
    resolutionCacheSchemaVersion: 4,
    armedAt: '2026-09-19T00:00:00.000Z',
  };
  const apexDeps = (applyMutation) =>
    dependencies({
      pages: [{ entries: [{ host: APEX_HOST, hostname: apexSource, routerReplica: null }], nextPageToken: null }],
      audits: { [APEX_HOST]: [auditPage({ committed: null, lookup: { kind: 'unknown-host' } })] },
      applyMutation,
    });

  it('refuses an applied run up front when a capability-bearing source is in scope and no barrier was supplied', async () => {
    const applyMutation = vi.fn(async () => ({ revisions: [{ host: APEX_HOST, from: null, to: '1' }] }));
    expect(await refusal(input({ mode: 'backfill', apply: true }), apexDeps(applyMutation))).toBe(
      'path-capability-barrier-required',
    );
    // Nothing was repaired: the refusal is before the walk, not inside it.
    expect(applyMutation).not.toHaveBeenCalled();
  });

  it('forwards the attested barrier into the backfill that repairs a serving root', async () => {
    const applyMutation = vi.fn(async () => ({ revisions: [{ host: APEX_HOST, from: null, to: '1' }] }));
    const report = await reconcileHostnameReplicas(
      input({ mode: 'backfill', apply: true, pathCapabilityBarrier: BARRIER }),
      apexDeps(applyMutation),
    );
    expect(report.hosts[0].state).toBe('backfilled');
    expect(applyMutation.mock.calls[0][0]).toMatchObject({
      intent: 'backfill-ledger',
      host: APEX_HOST,
      pathCapabilityBarrier: BARRIER,
    });
  });

  it('refuses a malformed barrier rather than carrying it to the repair', async () => {
    expect(
      await refusal(
        input({ mode: 'backfill', apply: true, pathCapabilityBarrier: { ...BARRIER, resolutionCacheSchemaVersion: 0 } }),
        apexDeps(vi.fn()),
      ),
    ).toBe('path-capability-barrier');
  });

  // A capability-free listing needs no barrier at all, which is what keeps
  // the up-front refusal about capability rather than about applying.
  it('applies a backfill with no barrier when nothing in scope carries a capability', async () => {
    const applyMutation = vi.fn(async () => ({ revisions: [{ host: HOST, from: null, to: '1' }] }));
    const deps = dependencies({
      pages: [{ entries: [{ host: HOST, hostname: hostnameDocument(), routerReplica: null }], nextPageToken: null }],
      audits: { [HOST]: [auditPage({ committed: null, lookup: { kind: 'unknown-host' } })] },
      applyMutation,
    });
    const report = await reconcileHostnameReplicas(input({ mode: 'backfill', apply: true }), deps);
    expect(report.hosts[0].state).toBe('backfilled');
    expect(applyMutation.mock.calls[0][0].pathCapabilityBarrier).toBeUndefined();
  });

  // `audit` cannot write, so `apply` on it is a claim the mode cannot keep,
  // and the report said dryRun false over a read-only run.
  it('refuses apply on an audit run rather than reporting a dry run as applied', async () => {
    expect(await refusal(input({ mode: 'audit', apply: true }), dependencies())).toBe('audit-mode-cannot-apply');
    const audited = await reconcileHostnameReplicas(input(), dependencies());
    expect(audited.dryRun).toBe(true);
    const planned = await reconcileHostnameReplicas(input({ mode: 'backfill', apply: false }), dependencies());
    expect(planned.dryRun).toBe(true);
    expect(planned.counts.backfilled).toBe(0);
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

  // A cursor that merely advances lets an adapter skip ahead: one page
  // carrying sequence 1 with nextAfter 100, then an empty terminal page,
  // reads as a complete one-record history and the host is reported
  // recovered from a span nothing verified.
  // The records and the classification have to describe ONE state. Keeping
  // the first page metadata while consuming later records let an acquire-lock
  // record on page two chain successfully while the reported lock stayed
  // null, so `locked` was omitted and an apply-mode backfill could proceed
  // during containment.
  it('refuses a page walk whose object state changed under it, and reports the lock when it has not', async () => {
    const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };
    const changed = dependencies({
      audits: {
        [HOST]: [
          auditPage({ committed, recoveryLock: null, records: [record('1', null, committed)], nextAfter: '1' }),
          {
            ...auditPage({ committed, recoveryLock: HELD_LOCK, records: [record('2', committed, committed)], nextAfter: null }),
            __after: '1',
          },
        ],
      },
    });
    expect(await refusal(input(), changed)).toBe('audit-state-changed');

    // The same two-page walk with the lock held from the first page reports
    // it, which is what makes the refusal about the CHANGE rather than about
    // locks or about pagination.
    const steady = dependencies({
      audits: {
        [HOST]: [
          auditPage({ committed, recoveryLock: HELD_LOCK, records: [record('1', null, committed)], nextAfter: '1' }),
          {
            ...auditPage({ committed, recoveryLock: HELD_LOCK, records: [record('2', committed, committed)], nextAfter: null }),
            __after: '1',
          },
        ],
      },
    });
    const report = await reconcileHostnameReplicas(input(), steady);
    expect(report.hosts[0].flags).toContain('locked');
    expect(report.hosts[0].recoveryRecordCount).toBe(2);
  });

  // `before` and `after` are legitimately null at the ends of a history, so
  // a nullish fallback read an OMITTED field as that legitimate value and a
  // truncated record satisfied the chain.
  it.each([['before'], ['after']])('refuses a recovery record that omits %s entirely', async (field) => {
    const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };
    const truncated = record('1', null, committed);
    delete truncated[field];
    const deps = dependencies({ audits: { [HOST]: [auditPage({ committed, records: [truncated] })] } });
    expect(await refusal(input(), deps)).toBe('malformed-audit-page');
  });

  it('refuses a cursor that skips past the records the page returned', async () => {
    const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };
    const deps = dependencies({
      audits: {
        [HOST]: [
          auditPage({ committed, records: [record('1', null, committed)], nextAfter: '100' }),
          { ...auditPage({ committed, records: [], nextAfter: null }), __after: '100' },
        ],
      },
    });
    expect(await refusal(input(), deps)).toBe('malformed-audit-page');
  });

  it('refuses a non-terminal page that returned no records at all', async () => {
    const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };
    const deps = dependencies({
      audits: { [HOST]: [auditPage({ committed, records: [], nextAfter: '1' })] },
    });
    expect(await refusal(input(), deps)).toBe('malformed-audit-page');
  });

  it('walks a well-formed two-page history whose cursor names each page last record', async () => {
    const committed = { revision: '4', digest: digestOf(HOST, '4', hostnameDocument()) };
    const deps = dependencies({
      audits: {
        [HOST]: [
          auditPage({ committed, records: [record('1', null, null), record('2', null, committed)], nextAfter: '2' }),
          { ...auditPage({ committed, records: [record('3', committed, committed)], nextAfter: null }), __after: '2' },
        ],
      },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts[0]).toMatchObject({ state: 'recovered', recoveryRecordCount: 3 });
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

  it('refuses a terminal record the object could not have advanced FROM to the state it reports', async () => {
    // Lowered: nothing in the system reduces the accepted revision, so a
    // terminal record above the reported state is a contradiction.
    const lowered = dependencies({
      audits: { [HOST]: [auditPage({ committed, records: [record('1', null, { revision: '9', digest: 'b'.repeat(64) })] })] },
    });
    expect(await refusal(input(), lowered)).toBe('conflicting-recovery-history');

    // Equal revision, different digest: an ordinary sync answers that `409
    // revision-conflict` and commits nothing, so no unrecorded transition can
    // explain the gap.
    const repainted = dependencies({
      audits: { [HOST]: [auditPage({ committed, records: [record('1', null, { revision: '4', digest: 'b'.repeat(64) })] })] },
    });
    expect(await refusal(input(), repainted)).toBe('conflicting-recovery-history');
  });

  it('accepts a recovered host that ordinary publisher syncs have since moved on', async () => {
    // The defect this closes: `applyPublisherSync` commits a new revision
    // WITHOUT appending a recovery record, so recovery records are not a
    // complete log of committed transitions. Requiring the terminal record to
    // equal the reported state, or each record's `before` to equal the
    // previous record's `after`, made one routine revision after a recovery
    // refuse the whole reconciliation run.
    const recoveredAt = { revision: '2', digest: 'a'.repeat(64) };
    const secondEpisode = { revision: '3', digest: 'c'.repeat(64) };
    const deps = dependencies({
      audits: {
        [HOST]: [
          auditPage({
            committed,
            records: [
              // Recovered at 2, then an unrecorded sync carried it to 3...
              record('1', null, recoveredAt),
              // ...where a second episode repaired the payload in place, and a
              // further unrecorded sync carried it to the reported 4.
              record('2', secondEpisode, { revision: '3', digest: 'd'.repeat(64) }),
            ],
          }),
        ],
      },
    });
    const report = await reconcileHostnameReplicas(input(), deps);
    expect(report.hosts[0]).toMatchObject({ state: 'recovered', recoveryRecordCount: 2, digestMatches: true });
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
    // Every classification plus the one applied outcome, always present at
    // zero. `specs/event-router-registry.md` enumerates this exact set, so a
    // state added without a spec sentence fails here.
    expect(Object.keys(report.counts).sort()).toEqual([
      'already-correct',
      'backfilled',
      'drifted',
      'edge-behind',
      'invalid-host',
      'malformed-ledger',
      'malformed-source',
      'missing',
      'missing-ledger',
      'missing-ledger-source-behind',
      'no-documents',
      'poisoned',
      'recovered',
      'reserved-class',
      'source-behind',
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
