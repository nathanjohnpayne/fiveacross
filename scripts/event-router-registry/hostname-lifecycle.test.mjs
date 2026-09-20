import { describe, expect, it, vi } from 'vitest';
import { HostnameLifecycleRefusal, applyHostnameMutation } from './hostname-lifecycle.mjs';
import { deriveCanonicalProjection, projectionDigest } from './hostname-projection.mjs';

const HOST = 'bodega-bay.fiveacross.app';
const MIRROR = 'vacaybingo.vercel.app';
const APEX = 'vacaybingo.com';
const ALIAS = 'bodega-bay.vacaybingo.com';
const SYNTHETIC = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const SYNTHETIC_ROOT = 'r2-root-abcdefghijklmnopqrst.fiveacross.app';
const NOW = '2026-09-20T12:00:00.000Z';

const BARRIER = {
  releaseTag: 'v2026.09.19-path-capability',
  workerVersionId: '3f6a0b1c-0000-4000-8000-000000000001',
  resolutionCacheSchemaVersion: 4,
  armedAt: '2026-09-19T18:00:00.000Z',
};

/**
 * An in-memory Firestore transaction with the property that matters here:
 * writes are staged and committed only when the transaction body returns, so a
 * refusal raised after some writes were buffered leaves the store untouched —
 * the same atomicity the emulator suite proves against a real transaction.
 */
function store(seed = {}) {
  const docs = new Map(Object.entries(structuredClone(seed)));
  const reads = [];
  const runTransaction = async (work) => {
    const staged = [];
    const result = await work({
      async get(path) {
        reads.push(path);
        return docs.has(path) ? structuredClone(docs.get(path)) : null;
      },
      set: (path, value) => staged.push(['set', path, value]),
      update: (path, value) => staged.push(['update', path, value]),
      delete: (path) => staged.push(['delete', path]),
    });
    for (const [op, path, value] of staged) {
      if (op === 'set') docs.set(path, structuredClone(value));
      else if (op === 'update') docs.set(path, { ...(docs.get(path) ?? {}), ...structuredClone(value) });
      else docs.delete(path);
    }
    return result;
  };
  return { docs, reads, dependencies: { now: () => new Date(NOW), runTransaction } };
}

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

const converged = (host, revision, document) => ({
  [`hostnames/${host}`]: document,
  [`routerReplicas/${host}`]: ledgerFor(host, revision, document),
});

const mutation = (overrides) => ({
  schemaVersion: 1,
  apply: true,
  actor: 'nathanjohnpayne',
  reason: 'lifecycle test',
  ...overrides,
});

async function refusal(input, dependencies) {
  try {
    await applyHostnameMutation(input, dependencies);
  } catch (error) {
    if (error instanceof HostnameLifecycleRefusal) return error.code;
    throw error;
  }
  return null;
}

describe('provision', () => {
  it('creates the hostname disabled and its ledger at revision 1 in one transaction', async () => {
    const { docs, dependencies } = store();
    const plan = await applyHostnameMutation(
      mutation({
        intent: 'provision',
        host: HOST,
        hostname: { eventId: 'bodega-bay-2026', canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay', isCanonical: true },
      }),
      dependencies,
    );
    expect(plan.revisions).toEqual([{ host: HOST, from: null, to: '1' }]);
    expect(docs.get(`hostnames/${HOST}`).status).toBe('disabled');
    expect(docs.get(`routerReplicas/${HOST}`)).toEqual({
      schemaVersion: 1,
      revision: '1',
      host: HOST,
      desired: { kind: 'route', eventId: 'bodega-bay-2026', status: 'disabled', slug: 'bodega-bay', edition: 'fiveacross', pathNamespace: null },
      updatedAt: NOW,
    });
    expect(plan.projections[0].digest).toBe(projectionDigest('1', HOST, plan.projections[0].desired));
  });

  it('is a dry run by default and writes nothing while planning identically', async () => {
    const { docs, dependencies } = store();
    const input = mutation({
      intent: 'provision',
      apply: false,
      host: HOST,
      hostname: { eventId: 'bodega-bay-2026', canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay', isCanonical: true },
    });
    const dry = await applyHostnameMutation(input, dependencies);
    expect(dry.dryRun).toBe(true);
    expect(docs.size).toBe(0);
    const wet = await applyHostnameMutation({ ...input, apply: true }, dependencies);
    expect(wet.writes).toEqual(dry.writes);
    expect(docs.size).toBe(2);
  });

  it('refuses an explicit non-disabled initial status', async () => {
    const { dependencies } = store();
    expect(
      await refusal(
        mutation({
          intent: 'provision',
          host: HOST,
          hostname: { eventId: 'e', canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay', status: 'active' },
        }),
        dependencies,
      ),
    ).toBe('provision-requires-disabled');
  });

  it.each([SYNTHETIC, SYNTHETIC_ROOT])('refuses the globally reserved class %s', async (host) => {
    const { docs, dependencies } = store();
    expect(
      await refusal(
        mutation({ intent: 'provision', host, hostname: { eventId: 'e', edition: 'fiveacross', slug: host.split('.')[0] } }),
        dependencies,
      ),
    ).toBe('reserved-class');
    expect(docs.size).toBe(0);
  });

  it('refuses a host carrying a permanent rehearsal reservation', async () => {
    const { dependencies } = store({ [`routerRehearsals/${HOST}`]: { class: 'route', reservedAt: 1 } });
    expect(
      await refusal(
        mutation({ intent: 'provision', host: HOST, hostname: { eventId: 'e', edition: 'fiveacross', slug: 'bodega-bay' } }),
        dependencies,
      ),
    ).toBe('rehearsal-reservation');
  });

  it('refuses an existing hostname, an in-use address, and a permanent tombstone', async () => {
    const claim = mutation({
      intent: 'provision',
      host: HOST,
      hostname: { eventId: 'e', canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay' },
    });
    expect(await refusal(claim, store(converged(HOST, '4', hostnameDocument())).dependencies)).toBe('hostname-exists');
    expect(
      await refusal(claim, store({ [`routerReplicas/${HOST}`]: ledgerFor(HOST, '4', hostnameDocument()) }).dependencies),
    ).toBe('address-in-use');
    expect(
      await refusal(
        claim,
        store({
          [`routerReplicas/${HOST}`]: { schemaVersion: 1, revision: '9', host: HOST, desired: { kind: 'tombstone' }, updatedAt: NOW },
        }).dependencies,
      ),
    ).toBe('tombstoned-address');
  });

  it('refuses enabling path capability without the deployment barrier and accepts it with one', async () => {
    const rootClaim = (extra) =>
      mutation({ intent: 'provision', host: APEX, hostname: { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' }, ...extra });
    expect(await refusal(rootClaim({}), store().dependencies)).toBe('path-capability-barrier');
    expect(
      await refusal(rootClaim({ pathCapabilityBarrier: { ...BARRIER, resolutionCacheSchemaVersion: 0 } }), store().dependencies),
    ).toBe('path-capability-barrier');
    expect(
      await refusal(rootClaim({ pathCapabilityBarrier: { ...BARRIER, armedAt: '2026-09-21T00:00:00.000Z' } }), store().dependencies),
    ).toBe('path-capability-barrier');
    const { docs, dependencies } = store();
    await applyHostnameMutation(rootClaim({ pathCapabilityBarrier: BARRIER }), dependencies);
    expect(docs.get(`routerReplicas/${APEX}`).desired).toEqual({
      kind: 'root',
      root: 'doorway',
      edition: 'vacay',
      pathNamespace: 'vacaybingo.com',
    });
  });
});

describe('ordinary update', () => {
  it('writes a non-projected field with no revision and no ledger write', async () => {
    const { docs, dependencies } = store(converged(HOST, '4', hostnameDocument()));
    const before = structuredClone(docs.get(`routerReplicas/${HOST}`));
    const plan = await applyHostnameMutation(
      mutation({ intent: 'update', host: HOST, changes: { adultContent: true } }),
      dependencies,
    );
    expect(plan.projectedChange).toBe(false);
    expect(plan.revisions).toEqual([]);
    expect(plan.writes).toEqual([{ op: 'update', path: `hostnames/${HOST}`, value: { adultContent: true } }]);
    expect(docs.get(`hostnames/${HOST}`).adultContent).toBe(true);
    expect(docs.get(`routerReplicas/${HOST}`)).toEqual(before);
  });

  it('spends exactly one revision on a status change and recomputes the projection', async () => {
    const { docs, dependencies } = store(converged(HOST, '4', hostnameDocument()));
    const plan = await applyHostnameMutation(
      mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' } }),
      dependencies,
    );
    expect(plan.revisions).toEqual([{ host: HOST, from: '4', to: '5' }]);
    expect(docs.get(`routerReplicas/${HOST}`).desired.status).toBe('disabled');
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('5');
  });

  it('spends one revision on an Edition-only correction without disabling the host', async () => {
    const { docs, dependencies } = store(converged(HOST, '4', hostnameDocument()));
    await applyHostnameMutation(mutation({ intent: 'update', host: HOST, changes: { edition: 'vacay' } }), dependencies);
    expect(docs.get(`hostnames/${HOST}`).status).toBe('active');
    expect(docs.get(`routerReplicas/${HOST}`).desired).toMatchObject({ edition: 'vacay', status: 'active' });
  });

  it('is idempotent: re-applying a change that is already in place refuses rather than churning the edge', async () => {
    const { dependencies } = store(converged(HOST, '4', hostnameDocument({ status: 'disabled' })));
    expect(await refusal(mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' } }), dependencies)).toBe(
      'no-projected-change',
    );
  });

  it.each([
    ['archive through an ordinary update', { status: 'archived' }, 'archive-barrier'],
    ['a repoint while the host is active', { eventId: 'other-event' }, 'active-repoint-barrier'],
    ['a combined status and identity move', { status: 'disabled', slug: 'sonoma' }, 'combined-barrier'],
    ['an apexPath write outside the archive transaction', { apexPath: true }, 'apex-path-barrier'],
    ['a field the contract does not know', { canonicalTarget: 'x' }, 'unknown-field'],
  ])('refuses %s', async (_why, changes, expected) => {
    const { docs, dependencies } = store(converged(HOST, '4', hostnameDocument()));
    expect(await refusal(mutation({ intent: 'update', host: HOST, changes }), dependencies)).toBe(expected);
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
  });

  it('moves a root marker between its two values and spends one revision', async () => {
    const marker = { root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
    const { docs, dependencies } = store(converged(APEX, '3', marker));
    await applyHostnameMutation(mutation({ intent: 'update', host: APEX, changes: { root: 'doorway' } }), dependencies);
    expect(docs.get(`routerReplicas/${APEX}`)).toMatchObject({
      revision: '4',
      desired: { kind: 'root', root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' },
    });
  });

  it('refuses a root/route conversion by name in both directions and takes no barrier input', async () => {
    // `specs/path-addressing-and-root.md` § D1's replacement-flagship repoint
    // and the route → doorway move have no intent in this helper; the archive
    // interlock owns the only route → root conversion that exists.
    const route = store(converged(HOST, '4', hostnameDocument()));
    expect(await refusal(mutation({ intent: 'update', host: HOST, changes: { root: 'doorway' } }), route.dependencies)).toBe(
      'root-route-transition-barrier',
    );
    expect(route.docs.get(`routerReplicas/${HOST}`).revision).toBe('4');

    const marker = store(converged(APEX, '3', { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' }));
    expect(
      await refusal(
        mutation({ intent: 'update', host: APEX, changes: { eventId: 'replacement-2027', slug: 'replacement', status: 'active' } }),
        marker.dependencies,
      ),
    ).toBe('root-route-transition-barrier');

    // `pathNamespace` is a constant per host, so `update` has no barrier
    // parameter at all and offering one is a malformed envelope.
    expect(
      await refusal(
        mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' }, pathCapabilityBarrier: BARRIER }),
        store(converged(HOST, '4', hostnameDocument())).dependencies,
      ),
    ).toBe('invalid-input');
  });

  it('refuses un-archiving a routing document on its own', async () => {
    const { dependencies } = store(converged(HOST, '9', hostnameDocument({ status: 'archived' })));
    expect(await refusal(mutation({ intent: 'update', host: HOST, changes: { status: 'active' } }), dependencies)).toBe(
      'unarchive-barrier',
    );
  });

  it('refuses any mutation layered on a source/ledger pair that already disagrees', async () => {
    const { dependencies } = store({
      [`hostnames/${HOST}`]: hostnameDocument(),
      [`routerReplicas/${HOST}`]: ledgerFor(HOST, '4', hostnameDocument({ status: 'disabled' })),
    });
    expect(await refusal(mutation({ intent: 'update', host: HOST, changes: { edition: 'vacay' } }), dependencies)).toBe(
      'source-ledger-drift',
    );
  });
});

describe('repoint', () => {
  it('refuses while the host is active and succeeds once it is disabled', async () => {
    const active = store(converged(HOST, '4', hostnameDocument()));
    expect(
      await refusal(mutation({ intent: 'repoint', host: HOST, changes: { eventId: 'sonoma-2027' } }), active.dependencies),
    ).toBe('repoint-requires-disabled');

    const disabled = store(converged(HOST, '5', hostnameDocument({ status: 'disabled' })));
    const plan = await applyHostnameMutation(
      mutation({ intent: 'repoint', host: HOST, changes: { eventId: 'sonoma-2027' } }),
      disabled.dependencies,
    );
    expect(plan.revisions).toEqual([{ host: HOST, from: '5', to: '6' }]);
    expect(disabled.docs.get(`routerReplicas/${HOST}`).desired).toMatchObject({
      eventId: 'sonoma-2027',
      status: 'disabled',
    });
  });

  it('refuses combining the barrier with the status move it exists to separate', async () => {
    const { dependencies } = store(converged(HOST, '5', hostnameDocument({ status: 'disabled' })));
    expect(
      await refusal(
        mutation({ intent: 'repoint', host: HOST, changes: { eventId: 'sonoma-2027', status: 'active' } }),
        dependencies,
      ),
    ).toBe('combined-barrier');
  });

  it('refuses a repoint that moves no identity', async () => {
    const { dependencies } = store(converged(HOST, '5', hostnameDocument({ status: 'disabled' })));
    expect(await refusal(mutation({ intent: 'repoint', host: HOST, changes: { edition: 'vacay' } }), dependencies)).toBe(
      'repoint-requires-identity',
    );
  });
});

describe('archive', () => {
  const flagship = () => ({
    ...converged(HOST, '4', hostnameDocument()),
    ...converged(ALIAS, '2', hostnameDocument({ canonicalHost: HOST, isCanonical: false, slug: 'bodega-bay' })),
    ...converged(MIRROR, '7', {
      eventId: 'bodega-bay-2026',
      edition: 'vacay',
      status: 'active',
      slug: 'bodega-bay',
      pathNamespace: 'vacaybingo.com',
      // Non-projected fields with their own reviewed writers. The conversion
      // replaces this whole document, so they are exactly what it must not
      // silently drop.
      adultContent: true,
      preview: { headline: 'Bodega Bay' },
      canonicalHost: HOST,
      isCanonical: false,
      // A per-Event opt-in left behind by an earlier writer. The converted
      // document names no Event, so this one MUST go.
      apexPath: true,
    }),
    'events/bodega-bay-2026': { status: 'active', admins: ['nathan'] },
  });

  const archiveInput = (overrides = {}) =>
    mutation({
      intent: 'archive',
      eventId: 'bodega-bay-2026',
      mappings: [HOST, ALIAS],
      apexPathHost: HOST,
      mirrorRootConversions: [{ host: MIRROR, root: 'not-found' }],
      ...overrides,
    });

  it('moves every mapping, the apexPath flag, the mirror root marker and the Event document together', async () => {
    const { docs, dependencies } = store(flagship());
    const plan = await applyHostnameMutation(archiveInput(), dependencies);
    expect(plan.revisions).toEqual([
      { host: HOST, from: '4', to: '5' },
      { host: ALIAS, from: '2', to: '3' },
      { host: MIRROR, from: '7', to: '8' },
    ]);
    expect(docs.get(`hostnames/${HOST}`)).toMatchObject({ status: 'archived', apexPath: true });
    expect(docs.get(`hostnames/${ALIAS}`)).toMatchObject({ status: 'archived' });
    expect(docs.get(`hostnames/${ALIAS}`).apexPath).toBeUndefined();
    // The conversion drops exactly the route fields and keeps every
    // non-projected field: those have their own reviewed writers, and this
    // transaction is not one of them.
    expect(docs.get(`hostnames/${MIRROR}`)).toEqual({
      root: 'not-found',
      edition: 'vacay',
      pathNamespace: 'vacaybingo.com',
      adultContent: true,
      preview: { headline: 'Bodega Bay' },
      canonicalHost: HOST,
      isCanonical: false,
    });
    expect(docs.get(`routerReplicas/${MIRROR}`).desired).toEqual({
      kind: 'root',
      root: 'not-found',
      edition: 'vacay',
      pathNamespace: 'vacaybingo.com',
    });
    expect(docs.get('events/bodega-bay-2026').status).toBe('archived');
    // `apexPath` gates the client's apex-path eligibility and is deliberately
    // not copied to the edge.
    expect(docs.get(`routerReplicas/${HOST}`).desired).not.toHaveProperty('apexPath');
  });

  it('leaves both sides of every host untouched when one mapping is ineligible', async () => {
    const seed = flagship();
    seed[`hostnames/${ALIAS}`] = { ...seed[`hostnames/${ALIAS}`], status: 'disabled' };
    seed[`routerReplicas/${ALIAS}`] = ledgerFor(ALIAS, '2', seed[`hostnames/${ALIAS}`]);
    const { docs, dependencies } = store(seed);
    expect(await refusal(archiveInput(), dependencies)).toBe('archive-requires-active');
    expect(docs.get(`hostnames/${HOST}`).status).toBe('active');
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
    expect(docs.get('events/bodega-bay-2026').status).toBe('active');
  });

  it('refuses an apexPath target that is not one of the Event mappings or is a root host', async () => {
    expect(await refusal(archiveInput({ apexPathHost: 'sonoma.fiveacross.app' }), store(flagship()).dependencies)).toBe(
      'apex-path-target-unknown',
    );
    expect(
      await refusal(
        archiveInput({ mappings: [HOST, ALIAS, MIRROR], apexPathHost: MIRROR, mirrorRootConversions: [] }),
        store(flagship()).dependencies,
      ),
    ).toBe('apex-path-target-ineligible');
  });

  it('refuses a mapping that belongs to another Event and a missing Event document', async () => {
    expect(await refusal(archiveInput({ eventId: 'other-2026' }), store(flagship()).dependencies)).toBe('event-missing');
    const seed = flagship();
    seed['events/other-2026'] = { status: 'active' };
    expect(await refusal(archiveInput({ eventId: 'other-2026' }), store(seed).dependencies)).toBe(
      'archive-mapping-mismatch',
    );
  });

  it('refuses a root marker on a host that has no root class', async () => {
    expect(
      await refusal(
        archiveInput({ mappings: [HOST], mirrorRootConversions: [{ host: ALIAS, root: 'not-found' }] }),
        store(flagship()).dependencies,
      ),
    ).toBe('root-marker-ineligible');
  });
});

describe('delete', () => {
  it('refuses an active host and a revision the edge has not converged on', async () => {
    expect(
      await refusal(
        mutation({ intent: 'delete', host: HOST, convergedRevision: '4' }),
        store(converged(HOST, '4', hostnameDocument())).dependencies,
      ),
    ).toBe('delete-requires-inactive');
    expect(
      await refusal(
        mutation({ intent: 'delete', host: HOST, convergedRevision: '3' }),
        store(converged(HOST, '4', hostnameDocument({ status: 'disabled' }))).dependencies,
      ),
    ).toBe('delete-requires-convergence');
  });

  it('refuses a serving root marker and accepts the non-serving one', async () => {
    // `root: 'doorway'` IS the live platform/Edition doorway, so it is as
    // serving as an active route even though a root marker has no `status`.
    const doorway = { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
    expect(
      await refusal(
        mutation({ intent: 'delete', host: APEX, convergedRevision: '3' }),
        store(converged(APEX, '3', doorway)).dependencies,
      ),
    ).toBe('delete-requires-inactive');

    const marker = { root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
    const { docs, dependencies } = store(converged(MIRROR, '3', marker));
    await applyHostnameMutation(mutation({ intent: 'delete', host: MIRROR, convergedRevision: '3' }), dependencies);
    expect(docs.has(`hostnames/${MIRROR}`)).toBe(false);
    expect(docs.get(`routerReplicas/${MIRROR}`)).toMatchObject({ revision: '4', desired: { kind: 'tombstone' } });
  });

  it('deletes the hostname and advances the ledger to a permanent tombstone', async () => {
    const { docs, dependencies } = store(converged(HOST, '4', hostnameDocument({ status: 'disabled' })));
    const plan = await applyHostnameMutation(mutation({ intent: 'delete', host: HOST, convergedRevision: '4' }), dependencies);
    expect(plan.revisions).toEqual([{ host: HOST, from: '4', to: '5' }]);
    expect(docs.has(`hostnames/${HOST}`)).toBe(false);
    expect(docs.get(`routerReplicas/${HOST}`)).toEqual({
      schemaVersion: 1,
      revision: '5',
      host: HOST,
      desired: { kind: 'tombstone' },
      updatedAt: NOW,
    });
  });

  it('never reuses the address: a fresh claim on the tombstoned host is refused', async () => {
    const { dependencies } = store(converged(HOST, '4', hostnameDocument({ status: 'disabled' })));
    await applyHostnameMutation(mutation({ intent: 'delete', host: HOST, convergedRevision: '4' }), dependencies);
    expect(
      await refusal(
        mutation({ intent: 'provision', host: HOST, hostname: { eventId: 'new', edition: 'fiveacross', slug: 'bodega-bay' } }),
        dependencies,
      ),
    ).toBe('tombstoned-address');
  });
});

describe('backfill and the explicit Admin ledger advance', () => {
  it('backfills a missing ledger at revision 1 and changes no public document', async () => {
    const { docs, dependencies } = store({ [`hostnames/${HOST}`]: hostnameDocument() });
    const before = structuredClone(docs.get(`hostnames/${HOST}`));
    const plan = await applyHostnameMutation(mutation({ intent: 'backfill-ledger', host: HOST }), dependencies);
    expect(plan.revisions).toEqual([{ host: HOST, from: null, to: '1' }]);
    expect(docs.get(`hostnames/${HOST}`)).toEqual(before);
    expect(docs.get(`routerReplicas/${HOST}`).desired).toEqual(deriveCanonicalProjection(HOST, before));
  });

  it('refuses to backfill over an existing ledger', async () => {
    const { dependencies } = store(converged(HOST, '4', hostnameDocument()));
    expect(await refusal(mutation({ intent: 'backfill-ledger', host: HOST }), dependencies)).toBe('ledger-exists');
  });

  const advance = (overrides = {}) =>
    mutation({
      intent: 'advance-ledger',
      host: HOST,
      durableObjectHighWaterRevision: '11',
      incidentUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/971',
      ...overrides,
    });

  it('advances a source-behind ledger above the Durable Object high-water mark from the current canonical projection', async () => {
    const { docs, dependencies } = store(converged(HOST, '4', hostnameDocument()));
    const plan = await applyHostnameMutation(advance(), dependencies);
    expect(plan.revisions).toEqual([{ host: HOST, from: '4', to: '12' }]);
    expect(docs.get(`routerReplicas/${HOST}`).desired).toEqual(deriveCanonicalProjection(HOST, hostnameDocument()));
    expect(docs.get(`hostnames/${HOST}`)).toEqual(hostnameDocument());
  });

  it('never lowers a revision when the ledger is already ahead of the edge', async () => {
    const { docs, dependencies } = store(converged(HOST, '20', hostnameDocument()));
    await applyHostnameMutation(advance(), dependencies);
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('21');
  });

  it('repairs a missing or malformed ledger, which is what makes repair-then-reattest possible', async () => {
    const missing = store({ [`hostnames/${HOST}`]: hostnameDocument() });
    await applyHostnameMutation(advance(), missing.dependencies);
    expect(missing.docs.get(`routerReplicas/${HOST}`).revision).toBe('12');

    const poisoned = store({
      [`hostnames/${HOST}`]: hostnameDocument(),
      [`routerReplicas/${HOST}`]: { schemaVersion: 1, revision: '4', host: HOST, desired: { kind: 'route' }, updatedAt: NOW },
    });
    // The pair is inadmissible to every other intent...
    expect(await refusal(mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' } }), poisoned.dependencies)).toBe(
      'malformed-ledger',
    );
    // ...and the explicit advance is the repair that restores equality.
    await applyHostnameMutation(advance(), poisoned.dependencies);
    expect(poisoned.docs.get(`routerReplicas/${HOST}`).desired).toEqual(deriveCanonicalProjection(HOST, hostnameDocument()));
    const repaired = await applyHostnameMutation(
      mutation({ intent: 'update', apply: false, host: HOST, changes: { status: 'disabled' } }),
      poisoned.dependencies,
    );
    expect(repaired.revisions).toEqual([{ host: HOST, from: '12', to: '13' }]);
  });

  it('derives a tombstone when the hostname is gone and refuses a non-https incident URL', async () => {
    const { docs, dependencies } = store({
      [`routerReplicas/${HOST}`]: { schemaVersion: 1, revision: '5', host: HOST, desired: { kind: 'tombstone' }, updatedAt: NOW },
    });
    await applyHostnameMutation(advance(), dependencies);
    expect(docs.get(`routerReplicas/${HOST}`)).toMatchObject({ revision: '12', desired: { kind: 'tombstone' } });
    expect(await refusal(advance({ incidentUrl: 'http://example.com/incident' }), dependencies)).toBe('invalid-input');
  });

  it.each([SYNTHETIC, SYNTHETIC_ROOT])('refuses to advance the reserved class %s', async (host) => {
    const { dependencies } = store();
    expect(await refusal(advance({ host }), dependencies)).toBe('reserved-class');
  });
});

describe('the helper boundary', () => {
  it('accepts exactly the transaction and clock seams, and no edge store', async () => {
    const { dependencies } = store();
    const input = mutation({ intent: 'backfill-ledger', host: HOST });
    for (const extra of ['kv', 'cache', 'acknowledge', 'readSourceFromEdge']) {
      expect(await refusal(input, { ...dependencies, [extra]: () => undefined }), extra).toBe('invalid-dependencies');
    }
  });

  it('reads the reservation, the hostname and the ledger inside the one transaction', async () => {
    const { reads, dependencies } = store(converged(HOST, '4', hostnameDocument()));
    await applyHostnameMutation(mutation({ intent: 'update', apply: false, host: HOST, changes: { status: 'disabled' } }), dependencies);
    expect(reads).toEqual([`routerRehearsals/${HOST}`, `hostnames/${HOST}`, `routerReplicas/${HOST}`]);
  });

  it('refuses an unknown intent and a malformed envelope', async () => {
    const { dependencies } = store();
    expect(await refusal(mutation({ intent: 'rename', host: HOST }), dependencies)).toBe('unknown-intent');
    expect(await refusal({ schemaVersion: 2, intent: 'provision', apply: false, actor: 'a', reason: 'b', host: HOST }, dependencies)).toBe(
      'invalid-input',
    );
  });

  it('refuses a clock that cannot answer', async () => {
    const { dependencies } = store();
    const broken = {
      ...dependencies,
      now: vi.fn(() => {
        throw new Error('no clock');
      }),
    };
    expect(await refusal(mutation({ intent: 'backfill-ledger', host: HOST }), broken)).toBe('authoritative-clock-unavailable');
  });
});
