import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import { HostnameLifecycleRefusal, applyHostnameMutation } from './hostname-lifecycle.mjs';
import { cloneDocumentValue, deriveCanonicalProjection, projectionDigest } from './hostname-projection.mjs';

const HOST = 'bodega-bay.fiveacross.app';
const MIRROR = 'vacaybingo.vercel.app';
const APEX = 'vacaybingo.com';
const ALIAS = 'bodega-bay.vacaybingo.com';
const SYNTHETIC = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const SYNTHETIC_ROOT = 'r2-root-abcdefghijklmnopqrst.fiveacross.app';
const NOW = '2026-09-20T12:00:00.000Z';
// The same class the emulator arm writes through, because the ledger's
// `updatedAt` must reach Firestore as a timestamp field rather than as text:
// the deployed publisher's Eventarc parser rejects a `stringValue` for it.
const NOW_STAMP = Timestamp.fromDate(new Date(NOW));

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
function store(seed = {}, { listEventMappings = true } = {}) {
  // `cloneDocumentValue`, not `structuredClone`, for the reason the module
  // gives: `structuredClone` strips a `Timestamp` to a plain map, so a double
  // built on it would hide exactly the field shape under test here.
  const docs = new Map(Object.entries(cloneDocumentValue(seed)));
  const reads = [];
  const runTransaction = async (work) => {
    const staged = [];
    const result = await work({
      async get(path) {
        reads.push(path);
        return docs.has(path) ? cloneDocumentValue(docs.get(path)) : null;
      },
      // The Admin SDK can run this query inside the transaction, so the double
      // answers from the same committed map every `get` above reads.
      ...(listEventMappings
        ? {
            async listEventMappings(eventId) {
              reads.push(`hostnames?eventId=${eventId}`);
              return [...docs.entries()]
                .filter(([path, value]) => path.startsWith('hostnames/') && value?.eventId === eventId)
                .map(([path]) => path.slice('hostnames/'.length));
            },
          }
        : {}),
      set: (path, value) => staged.push(['set', path, value]),
      update: (path, value) => staged.push(['update', path, value]),
      delete: (path) => staged.push(['delete', path]),
    });
    for (const [op, path, value] of staged) {
      if (op === 'set') docs.set(path, cloneDocumentValue(value));
      else if (op === 'update') docs.set(path, { ...(docs.get(path) ?? {}), ...cloneDocumentValue(value) });
      else docs.delete(path);
    }
    return result;
  };
  return {
    docs,
    reads,
    dependencies: { now: () => new Date(NOW), timestamp: (date) => Timestamp.fromDate(date), runTransaction },
  };
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
      updatedAt: NOW_STAMP,
    });
    expect(plan.projections[0].digest).toBe(projectionDigest('1', HOST, plan.projections[0].desired));
  });

  // The stored document has to say what the projection says. `recovery-
  // controller.mjs` validates the RAW hostname document for its source
  // attestation and requires `source.pathNamespace === null`, so a document
  // that merely omits the field derives the same projection here and can
  // never be attested there — the host is publishable and unrecoverable.
  it('persists an explicit null pathNamespace when the caller omits it', async () => {
    const { docs, dependencies } = store();
    await applyHostnameMutation(
      mutation({
        intent: 'provision',
        host: HOST,
        hostname: { eventId: 'bodega-bay-2026', canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay', isCanonical: true },
      }),
      dependencies,
    );
    const stored = docs.get(`hostnames/${HOST}`);
    expect(Object.hasOwn(stored, 'pathNamespace')).toBe(true);
    expect(stored.pathNamespace).toBe(null);
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

  // The archive is a one-way door: with no target named, every mapping and
  // the Event document retire while the apex archive address never becomes
  // eligible, and an ordinary update refuses both to add `apexPath` and to
  // un-archive. Refused before the first read rather than repaired after.
  it('refuses an archive that names no apexPath target, leaving both sides untouched', async () => {
    const { docs, dependencies } = store(flagship());
    expect(await refusal(archiveInput({ apexPathHost: null }), dependencies)).toBe('archive-apex-target-missing');
    expect(docs.get(`hostnames/${HOST}`).status).toBe('active');
    expect(docs.get(`hostnames/${HOST}`).apexPath).toBeUndefined();
    expect(docs.get(`hostnames/${ALIAS}`).status).toBe('active');
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
    expect(docs.get('events/bodega-bay-2026').status).toBe('active');
  });

  // A non-target mapping that already carries `apexPath` would leave the Event
  // with two apex archive addresses, which § D8 forbids, and the write loop
  // cannot see the field: `apexPath` is not projected, so a source and a
  // ledger that agree on the projection agree whether or not the source
  // carries it, and an update is a merge, so the flag survives while the
  // target gains its own. Refused for BOTH statuses the state can be in — an
  // archived one from a previous archive, and an active one from the legacy
  // or partial Admin write the flag has no other route onto — and refused
  // before anything is written either way.
  it.each([
    ['archived', 'the mapping a previous archive left flagged'],
    ['active', 'a legacy or partial Admin write'],
  ])('refuses an archive whose non-target mapping carries apexPath while %s, from %s', async (status) => {
    const seed = flagship();
    seed[`hostnames/${ALIAS}`] = { ...seed[`hostnames/${ALIAS}`], status, apexPath: true };
    seed[`routerReplicas/${ALIAS}`] = ledgerFor(ALIAS, '2', seed[`hostnames/${ALIAS}`]);
    const { docs, dependencies } = store(seed);
    expect(await refusal(archiveInput(), dependencies)).toBe('archive-apex-flag-carried');
    expect(docs.get(`hostnames/${HOST}`).status).toBe('active');
    expect(docs.get(`hostnames/${HOST}`).apexPath).toBeUndefined();
    expect(docs.get(`hostnames/${ALIAS}`)).toMatchObject({ status, apexPath: true });
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
    expect(docs.get('events/bodega-bay-2026').status).toBe('active');
  });

  // Two eligible mappings, one named: the archive is legal and EXACTLY one of
  // them takes the flag. A second `apexPath` cannot be written whatever the
  // caller asks for, because `apexPathHost` is one host and a duplicate
  // mapping is already refused as `invalid-input`.
  it('marks exactly one of two eligible mappings when both could have taken the flag', async () => {
    const { docs, dependencies } = store(flagship());
    await applyHostnameMutation(archiveInput({ apexPathHost: ALIAS }), dependencies);
    expect(docs.get(`hostnames/${ALIAS}`)).toMatchObject({ status: 'archived', apexPath: true });
    expect(docs.get(`hostnames/${HOST}`).status).toBe('archived');
    expect(docs.get(`hostnames/${HOST}`).apexPath).toBeUndefined();
    expect(await refusal(archiveInput({ mappings: [HOST, HOST] }), store(flagship()).dependencies)).toBe(
      'invalid-input',
    );
  });

  // A root host's `status` gates the WHOLE host, so archiving one as a route
  // takes its path capability down and every other Event addressed by path
  // there stops resolving. § D8 retires it by conversion instead, and the
  // caller is pointed at that array rather than converted silently.
  it('refuses a configured root host placed in mappings instead of mirrorRootConversions', async () => {
    const { docs, dependencies } = store(flagship());
    expect(
      await refusal(
        archiveInput({ mappings: [HOST, ALIAS, MIRROR], mirrorRootConversions: [] }),
        dependencies,
      ),
    ).toBe('archive-root-host-requires-conversion');
    expect(docs.get(`hostnames/${MIRROR}`)).toMatchObject({ status: 'active', pathNamespace: 'vacaybingo.com' });
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
    // Every mapping of the Event is still named, so the set is complete and
    // the refusal is about ALIAS carrying no root class rather than about a
    // host left out.
    expect(
      await refusal(
        archiveInput({
          mappings: [HOST],
          mirrorRootConversions: [
            { host: ALIAS, root: 'not-found' },
            { host: MIRROR, root: 'not-found' },
          ],
        }),
        store(flagship()).dependencies,
      ),
    ).toBe('root-marker-ineligible');
  });

  it('refuses an archive that omits one of the Event mappings and leaves every document standing', async () => {
    // The defect this closes: the named mappings and `events/{eventId}` would
    // archive while `hostnames/{ALIAS}` stayed `active`, so the archived Event
    // would keep serving at that address.
    const { docs, dependencies } = store(flagship());
    expect(await refusal(archiveInput({ mappings: [HOST] }), dependencies)).toBe('archive-mapping-incomplete');
    expect(docs.get(`hostnames/${HOST}`).status).toBe('active');
    expect(docs.get(`hostnames/${ALIAS}`).status).toBe('active');
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
    expect(docs.get('events/bodega-bay-2026').status).toBe('active');

    // Omitting the mirror conversion is the same defect: that host maps the
    // Event too, so leaving it out would leave an active route behind.
    const mirror = store(flagship());
    expect(await refusal(archiveInput({ mirrorRootConversions: [] }), mirror.dependencies)).toBe(
      'archive-mapping-incomplete',
    );
    expect(mirror.docs.get(`hostnames/${MIRROR}`).status).toBe('active');
  });

  it('proves the set against the collection rather than the caller, and refuses a runner that cannot', async () => {
    // The complete set comes from `hostnames` itself: naming all three is
    // accepted, and no extra attestation is asked of the operator.
    const { docs, dependencies } = store(flagship());
    await applyHostnameMutation(archiveInput(), dependencies);
    expect(docs.get('events/bodega-bay-2026').status).toBe('archived');

    // A transaction runner with no listing seam cannot make the interlock's
    // claim at all, so the archive fails closed by name.
    const blind = store(flagship(), { listEventMappings: false });
    expect(await refusal(archiveInput(), blind.dependencies)).toBe('event-mapping-listing-unavailable');
    expect(blind.docs.get('events/bodega-bay-2026').status).toBe('active');
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

  // The apex archive address is archived AND serving, which no projected
  // field records: `apexPath` is not copied to the edge, so the converged
  // inactive projection says nothing about it. Deleting it tombstones the
  // address permanently and strands the archive exactly as an archive with no
  // target would have.
  it('refuses to delete the apex archive target however converged it is', async () => {
    const archived = hostnameDocument({ status: 'archived', apexPath: true });
    const { docs, dependencies } = store(converged(HOST, '4', archived));
    expect(
      await refusal(mutation({ intent: 'delete', host: HOST, convergedRevision: '4' }), dependencies),
    ).toBe('delete-apex-archive-target');
    expect(docs.has(`hostnames/${HOST}`)).toBe(true);
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
    // The same archived route WITHOUT the flag is an ordinary retirement.
    const plain = store(converged(HOST, '4', hostnameDocument({ status: 'archived' })));
    await applyHostnameMutation(mutation({ intent: 'delete', host: HOST, convergedRevision: '4' }), plain.dependencies);
    expect(plain.docs.has(`hostnames/${HOST}`)).toBe(false);
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
      updatedAt: NOW_STAMP,
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

  // Revisions are canonical decimal TEXT so they stay lossless under BigInt.
  // A JSON number above `Number.MAX_SAFE_INTEGER` has already been rounded by
  // the time it arrives, so a floor computed from it can name a revision that
  // is not actually above the Durable Object and the repair earns a stale,
  // conflict or gap answer instead.
  it.each([
    ['a number', 11],
    ['a rounded number above MAX_SAFE_INTEGER', 9007199254740993],
    ['a non-canonical string', '011'],
    ['zero', '0'],
  ])('refuses a durableObjectHighWaterRevision supplied as %s', async (_why, durableObjectHighWaterRevision) => {
    const { dependencies } = store(converged(HOST, '4', hostnameDocument()));
    expect(await refusal(advance({ durableObjectHighWaterRevision }), dependencies)).toBe('invalid-input');
  });

  it('stays lossless on a high-water mark above MAX_SAFE_INTEGER', async () => {
    const { docs, dependencies } = store(converged(HOST, '4', hostnameDocument()));
    const plan = await applyHostnameMutation(
      advance({ durableObjectHighWaterRevision: '9007199254740993' }),
      dependencies,
    );
    expect(plan.revisions).toEqual([{ host: HOST, from: '4', to: '9007199254740994' }]);
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('9007199254740994');
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

  it('refuses to advance a tombstoned address back into a live route or root', async () => {
    // A partial Admin write recreates the source over a permanent tombstone.
    // The advance reads the CURRENT source, so without this guard it would
    // derive a live route from the recreated document and republish the
    // retired address at a higher revision than the tombstone.
    const tombstone = { schemaVersion: 1, revision: '5', host: HOST, desired: { kind: 'tombstone' }, updatedAt: NOW };
    const route = store({ [`hostnames/${HOST}`]: hostnameDocument(), [`routerReplicas/${HOST}`]: tombstone });
    expect(await refusal(advance(), route.dependencies)).toBe('tombstoned-address');
    expect(route.docs.get(`routerReplicas/${HOST}`)).toEqual(tombstone);

    const marker = store({
      [`hostnames/${APEX}`]: { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' },
      [`routerReplicas/${APEX}`]: { ...tombstone, host: APEX },
    });
    expect(await refusal(advance({ host: APEX }), marker.dependencies)).toBe('tombstoned-address');

    // A recreated document too malformed to derive is the same reuse, and is
    // refused as reuse rather than as a malformed source.
    const malformed = store({
      [`hostnames/${HOST}`]: { eventId: 'e', edition: 'westminster', status: 'active', slug: 'bodega-bay' },
      [`routerReplicas/${HOST}`]: tombstone,
    });
    expect(await refusal(advance(), malformed.dependencies)).toBe('tombstoned-address');
  });

  // The advance is the one intent that tolerates a malformed ledger, so a
  // tombstone that fails validation for an UNRELATED reason fell through the
  // retirement check entirely: `validTombstone` answered false, and with a
  // recreated source beside it the retired address was republished as a live
  // route at a higher revision. The claim is now honoured before it is
  // validated, and the refusal is its own code because a corrupt tombstone
  // is an investigation rather than a repair this intent may perform.
  it.each([
    ['an extra field', { extra: true }],
    ['a timestamp that will not normalise', { updatedAt: '2026-02-30T12:00:00Z' }],
    ['a revision that is not canonical', { revision: '05' }],
  ])('refuses to advance past a tombstone carrying %s, with or without a source', async (_why, overrides) => {
    const corrupt = {
      schemaVersion: 1,
      revision: '5',
      host: HOST,
      desired: { kind: 'tombstone' },
      updatedAt: NOW,
      ...overrides,
    };
    const recreated = store({ [`hostnames/${HOST}`]: hostnameDocument(), [`routerReplicas/${HOST}`]: corrupt });
    expect(await refusal(advance(), recreated.dependencies)).toBe('tombstoned-address-malformed');
    expect(recreated.docs.get(`routerReplicas/${HOST}`)).toEqual(corrupt);
    expect(recreated.docs.get(`hostnames/${HOST}`)).toEqual(hostnameDocument());

    // Also refused with no source document: the converged retirement is the
    // case the advance may republish, and a corrupt one is not it.
    const alone = store({ [`routerReplicas/${HOST}`]: corrupt });
    expect(await refusal(advance(), alone.dependencies)).toBe('tombstoned-address-malformed');
    expect(alone.docs.get(`routerReplicas/${HOST}`)).toEqual(corrupt);
  });
});

describe('the helper boundary', () => {
  it('accepts exactly the transaction, clock and timestamp seams, and no edge store', async () => {
    const { dependencies } = store();
    const input = mutation({ intent: 'backfill-ledger', host: HOST });
    for (const extra of ['kv', 'cache', 'acknowledge', 'readSourceFromEdge']) {
      expect(await refusal(input, { ...dependencies, [extra]: () => undefined }), extra).toBe('invalid-dependencies');
    }
    const { timestamp, ...withoutTimestamp } = dependencies;
    expect(await refusal(input, withoutTimestamp)).toBe('invalid-dependencies');
  });

  it('stores updatedAt as the SDK timestamp the seam built, never as text', async () => {
    // The deployed publisher's Eventarc parser requires a `timestampValue` for
    // this field and rejects a `stringValue`, so a ledger event written with
    // RFC 3339 text can never be published and the edge never converges on it.
    const { docs, dependencies } = store({ [`hostnames/${HOST}`]: hostnameDocument() });
    await applyHostnameMutation(mutation({ intent: 'backfill-ledger', host: HOST }), dependencies);
    const written = docs.get(`routerReplicas/${HOST}`).updatedAt;
    expect(typeof written).not.toBe('string');
    expect(written).toBeInstanceOf(Timestamp);
    expect(written.toDate().toISOString()).toBe(NOW);
  });

  it('refuses a timestamp seam that does not answer the clock it was given', async () => {
    const { docs, dependencies } = store({ [`hostnames/${HOST}`]: hostnameDocument() });
    const input = mutation({ intent: 'backfill-ledger', host: HOST });
    for (const broken of [
      () => NOW,
      () => Timestamp.fromDate(new Date('2020-01-01T00:00:00.000Z')),
      () => ({ toDate: () => 'not a date' }),
      () => {
        throw new Error('no timestamp');
      },
    ]) {
      expect(await refusal(input, { ...dependencies, timestamp: broken })).toBe('authoritative-clock-unavailable');
    }
    expect(docs.has(`routerReplicas/${HOST}`)).toBe(false);
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
