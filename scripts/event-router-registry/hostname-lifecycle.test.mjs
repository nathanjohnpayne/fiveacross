import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import { HostnameLifecycleRefusal, applyHostnameMutation, archiveSnapshotConfig } from './hostname-lifecycle.mjs';
import { ROOT_HOSTS, cloneDocumentValue, deriveCanonicalProjection, projectionDigest } from './hostname-projection.mjs';
// The application's own record builder, so the parity case below proves the
// helper accepts exactly what the operator command will hand it (#1256).
import { MAX_ARCHIVED_STANDING_ROWS, buildEventArchive, writableArchiveRecord } from '../../src/data/eventArchive.ts';
import { ARCHIVE_NUMBER_BOUND, MAX_DAYS } from '../../src/data/eventLimits.ts';

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
  // A STORED row carries a Firestore `Timestamp`; the deployed Eventarc
  // parser accepts only a `timestampValue`, so text here would be a document
  // whose trigger can never publish it.
  updatedAt: Timestamp.fromDate(new Date('2026-09-01T00:00:00.000Z')),
});

const converged = (host, revision, document) => ({
  [`hostnames/${host}`]: document,
  [`routerReplicas/${host}`]: ledgerFor(host, revision, document),
});

/**
 * The audit evidence an operator reads back from the Durable Object before a
 * repoint or a delete: the revision AND the digest the object reports as
 * committed. The digest is what a poisoned edge cannot forge, which is why
 * both intents ask for it rather than for the revision alone.
 */
const edgeConverged = (host, revision, document) => ({
  revision,
  digest: projectionDigest(revision, host, deriveCanonicalProjection(host, document)),
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
          [`routerReplicas/${HOST}`]: { schemaVersion: 1, revision: '9', host: HOST, desired: { kind: 'tombstone' }, updatedAt: NOW_STAMP },
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
    // The doorway go-live carries the deployment barrier (#1251).
    await applyHostnameMutation(
      mutation({ intent: 'update', host: APEX, changes: { root: 'doorway' }, pathCapabilityBarrier: BARRIER }),
      dependencies,
    );
    expect(docs.get(`routerReplicas/${APEX}`)).toMatchObject({
      revision: '4',
      desired: { kind: 'root', root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' },
    });
  });

  it('refuses a root/route conversion by name in both directions and takes no barrier input outside a doorway go-live', async () => {
    // An `update` never converts: the archive interlock, `convert-to-root` and
    // `convert-to-route` own both directions, each behind its own barrier
    // (#1251), so the ordinary update refuses the move by name.
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

    // `pathNamespace` is a constant per host, so an `update` takes the barrier
    // record only for a doorway go-live, and offering one anywhere else is a
    // malformed envelope.
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

  // `preview`, `canonicalHost` and `isCanonical` each have ONE reviewed
  // writer (`specs/hostnames-lookup.md`), and those writers validate what they
  // write. An ordinary update that carried them would be a second, unvalidated
  // writer able to redirect analytics and email origins or mint a second
  // canonical mapping, so the helper takes none of them from caller input.
  it.each([
    ['canonicalHost', { canonicalHost: 'wrong.example' }],
    ['isCanonical', { isCanonical: true }],
    ['preview', { preview: { eventName: 'Somewhere else' } }],
    ['an owner-only field beside a projected change', { edition: 'vacay', canonicalHost: 'wrong.example' }],
  ])('refuses %s on an ordinary update and leaves both documents untouched', async (_why, changes) => {
    const before = hostnameDocument({ canonicalHost: HOST, isCanonical: false });
    const { docs, dependencies } = store(converged(HOST, '4', before));
    const ledger = structuredClone(docs.get(`routerReplicas/${HOST}`));
    expect(await refusal(mutation({ intent: 'update', host: HOST, changes }), dependencies)).toBe(
      'owner-restricted-field',
    );
    expect(docs.get(`hostnames/${HOST}`)).toEqual(before);
    expect(docs.get(`routerReplicas/${HOST}`)).toEqual(ledger);
  });
  // The permitted non-projected update (`adultContent`) is the first test in
  // this block, so the refusal above is scoped to the owner-only three.
});

describe('the adultContent acknowledgement', () => {
  // It records a client acknowledgement and the #608 derivation only ever
  // raises it, so a second writer that could clear it would be a way around
  // the acknowledgement rather than a second way to set it.
  it('refuses an ordinary update that lowers it, and allows a raise and a restatement', async () => {
    const flagged = hostnameDocument({ adultContent: true });
    const lowered = store(converged(HOST, '4', flagged));
    expect(
      await refusal(mutation({ intent: 'update', host: HOST, changes: { adultContent: false } }), lowered.dependencies),
    ).toBe('adult-content-monotone');
    expect(lowered.docs.get(`hostnames/${HOST}`).adultContent).toBe(true);

    const raised = store(converged(HOST, '4', hostnameDocument()));
    await applyHostnameMutation(
      mutation({ intent: 'update', host: HOST, changes: { adultContent: true } }),
      raised.dependencies,
    );
    expect(raised.docs.get(`hostnames/${HOST}`).adultContent).toBe(true);

    // Restating the value it already holds is not a lowering and stays an
    // ordinary no-revision write.
    const unchanged = store(converged(HOST, '4', flagged));
    await applyHostnameMutation(
      mutation({ intent: 'update', host: HOST, changes: { adultContent: true } }),
      unchanged.dependencies,
    );
    expect(unchanged.docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
  });

  // The repoint reset is not a lowering: it clears the field for a DIFFERENT
  // Event rather than withdrawing it for this one.
  it('still clears it on a repoint, which changes which Event the host serves', async () => {
    const before = hostnameDocument({ status: 'disabled', adultContent: true });
    const { docs, dependencies } = store(converged(HOST, '5', before));
    await applyHostnameMutation(
      mutation({
        intent: 'repoint',
        host: HOST,
        changes: { eventId: 'sonoma-2027' },
        converged: edgeConverged(HOST, '5', before),
      }),
      dependencies,
    );
    expect(docs.get(`hostnames/${HOST}`).adultContent).toBeUndefined();
  });
});

describe('the activation convergence barrier', () => {
  // Provision defers activation to "publisher acceptance and edge
  // inspection", and the repoint sequence is disabled and CONVERGE, repoint,
  // active and CONVERGE. Both were only the Firestore half: a caller could
  // provision or repoint and activate immediately, taking the host live at a
  // projection the edge had never accepted.
  it.each([
    ['the edge is still behind the disabling revision', (document) => ({ ...edgeConverged(HOST, '3', document), revision: '3' })],
    ['the edge is poisoned at that revision', (document) => ({ ...edgeConverged(HOST, '4', document), digest: 'f'.repeat(64) })],
  ])('refuses an activation when %s', async (_why, evidence) => {
    const document = hostnameDocument({ status: 'disabled' });
    const { docs, dependencies } = store(converged(HOST, '4', document));
    expect(
      await refusal(
        mutation({ intent: 'update', host: HOST, changes: { status: 'active' }, converged: evidence(document) }),
        dependencies,
      ),
    ).toBe('activation-requires-convergence');
    expect(docs.get(`hostnames/${HOST}`).status).toBe('disabled');
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
  });

  it('activates on the audited evidence for the disabled revision, and leaves every other update alone', async () => {
    const document = hostnameDocument({ status: 'disabled' });
    const { docs, dependencies } = store(converged(HOST, '4', document));
    await applyHostnameMutation(
      mutation({
        intent: 'update',
        host: HOST,
        changes: { status: 'active' },
        converged: edgeConverged(HOST, '4', document),
      }),
      dependencies,
    );
    expect(docs.get(`hostnames/${HOST}`).status).toBe('active');
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('5');

    // Disabling, and every non-activating update, needs no evidence: the
    // barrier is about going LIVE at a projection the edge has not taken.
    const live = store(converged(HOST, '4', hostnameDocument()));
    await applyHostnameMutation(
      mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' } }),
      live.dependencies,
    );
    expect(live.docs.get(`hostnames/${HOST}`).status).toBe('disabled');
    const nonProjected = store(converged(HOST, '4', hostnameDocument()));
    await applyHostnameMutation(
      mutation({ intent: 'update', host: HOST, changes: { adultContent: true } }),
      nonProjected.dependencies,
    );
    expect(nonProjected.docs.get(`hostnames/${HOST}`).adultContent).toBe(true);
  });
});

describe('the archived-Event barrier', () => {
  const eventDoc = (overrides = {}) => ({ 'events/bodega-bay-2026': { status: 'active', admins: ['n'], ...overrides } });
  const hostname = { eventId: 'bodega-bay-2026', canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay', isCanonical: true };

  // `unarchive-barrier` guards a DOCUMENT's own history. Neither it nor the
  // archive interlock covered a route that did not exist when the Event was
  // archived: provision never read the Event, so a fresh mapping could be
  // created disabled against an archived Event and then activated by an
  // ordinary update whose own source status had never been archived — the
  // archived Event serving at its own hostname again, which is what § D8
  // retires.
  it.each([
    ['archived', { status: 'archived' }],
    ['in the archiving quiesce', { archiving: true }],
  ])('refuses provisioning a route onto an Event that is %s', async (_why, overrides) => {
    const { docs, dependencies } = store(eventDoc(overrides));
    expect(await refusal(mutation({ intent: 'provision', host: HOST, hostname }), dependencies)).toBe('event-not-live');
    expect(docs.has(`hostnames/${HOST}`)).toBe(false);
    expect(docs.has(`routerReplicas/${HOST}`)).toBe(false);
  });

  it('refuses activating a disabled mapping whose Event archived in between', async () => {
    const { docs, dependencies } = store({
      ...converged(HOST, '4', hostnameDocument({ status: 'disabled' })),
      ...eventDoc({ status: 'archived' }),
    });
    expect(
      await refusal(mutation({ intent: 'update', host: HOST, changes: { status: 'active' } }), dependencies),
    ).toBe('event-not-live');
    expect(docs.get(`hostnames/${HOST}`).status).toBe('disabled');
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
  });

  it('refuses re-homing a host onto an archived Event', async () => {
    const document = hostnameDocument({ status: 'disabled' });
    const { docs, dependencies } = store({
      ...converged(HOST, '5', document),
      'events/sonoma-2027': { status: 'archived' },
    });
    expect(
      await refusal(
        mutation({
          intent: 'repoint',
          host: HOST,
          changes: { eventId: 'sonoma-2027' },
          converged: edgeConverged(HOST, '5', document),
        }),
        dependencies,
      ),
    ).toBe('event-not-live');
    expect(docs.get(`hostnames/${HOST}`).eventId).toBe('bodega-bay-2026');
  });

  // A MISSING Event document is not refused: provisioning a hostname before
  // the Event exists is an ordinary operator order, and refusing it would be
  // a new precondition rather than this defect.
  it('still provisions and activates against a live or not-yet-created Event', async () => {
    const live = store(eventDoc());
    await applyHostnameMutation(mutation({ intent: 'provision', host: HOST, hostname }), live.dependencies);
    expect(live.docs.get(`hostnames/${HOST}`).status).toBe('disabled');

    const absent = store();
    await applyHostnameMutation(mutation({ intent: 'provision', host: HOST, hostname }), absent.dependencies);
    expect(absent.docs.get(`hostnames/${HOST}`).status).toBe('disabled');

    const disabled = hostnameDocument({ status: 'disabled' });
    const activating = store({ ...converged(HOST, '4', disabled), ...eventDoc() });
    await applyHostnameMutation(
      mutation({
        intent: 'update',
        host: HOST,
        changes: { status: 'active' },
        converged: edgeConverged(HOST, '4', disabled),
      }),
      activating.dependencies,
    );
    expect(activating.docs.get(`hostnames/${HOST}`).status).toBe('active');
  });
});

describe('repoint', () => {
  it('refuses while the host is active and succeeds once it is disabled', async () => {
    const active = store(converged(HOST, '4', hostnameDocument()));
    expect(
      await refusal(
        mutation({
          intent: 'repoint',
          host: HOST,
          changes: { eventId: 'sonoma-2027' },
          converged: edgeConverged(HOST, '4', hostnameDocument()),
        }),
        active.dependencies,
      ),
    ).toBe('repoint-requires-disabled');

    const disabled = store(converged(HOST, '5', hostnameDocument({ status: 'disabled' })));
    const plan = await applyHostnameMutation(
      mutation({
        intent: 'repoint',
        host: HOST,
        changes: { eventId: 'sonoma-2027' },
        converged: edgeConverged(HOST, '5', hostnameDocument({ status: 'disabled' })),
      }),
      disabled.dependencies,
    );
    expect(plan.revisions).toEqual([{ host: HOST, from: '5', to: '6' }]);
    expect(disabled.docs.get(`routerReplicas/${HOST}`).desired).toMatchObject({
      eventId: 'sonoma-2027',
      status: 'disabled',
    });
  });

  // A disabled `status` in Firestore says only that the disabling revision
  // was WRITTEN. Until the Durable Object has committed it the edge still
  // serves the previous Event, so moving the identity there hands that
  // Event's traffic to a host whose source now names another one. The
  // evidence is an input because no Firestore transaction can see the edge.
  it.each([
    ['the edge is still a revision behind', (host, document) => ({ ...edgeConverged(host, '4', document), revision: '4' })],
    ['the edge is poisoned at the same revision', (host, document) => ({ ...edgeConverged(host, '5', document), digest: 'f'.repeat(64) })],
  ])('refuses a repoint when %s', async (_why, evidence) => {
    const document = hostnameDocument({ status: 'disabled' });
    const { docs, dependencies } = store(converged(HOST, '5', document));
    expect(
      await refusal(
        mutation({ intent: 'repoint', host: HOST, changes: { eventId: 'sonoma-2027' }, converged: evidence(HOST, document) }),
        dependencies,
      ),
    ).toBe('repoint-requires-convergence');
    expect(docs.get(`hostnames/${HOST}`).eventId).toBe('bodega-bay-2026');
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('5');
  });

  it('refuses a repoint whose convergence evidence is malformed, and asks for the disable first', async () => {
    const document = hostnameDocument({ status: 'disabled' });
    const { dependencies } = store(converged(HOST, '5', document));
    for (const converged_ of [undefined, {}, { revision: '5' }, { revision: 5, digest: 'a' }, { revision: '05', digest: 'a' }]) {
      expect(
        await refusal(
          mutation({ intent: 'repoint', host: HOST, changes: { eventId: 'sonoma-2027' }, converged: converged_ }),
          dependencies,
        ),
        JSON.stringify(converged_ ?? null),
      ).toBe('invalid-input');
    }
    // The status barrier still answers first, so an operator who skipped the
    // disable is not told about a barrier they have not reached yet.
    const active = store(converged(HOST, '4', hostnameDocument()));
    expect(
      await refusal(
        mutation({ intent: 'repoint', host: HOST, changes: { eventId: 'sonoma-2027' }, converged: { revision: '9', digest: 'f'.repeat(64) } }),
        active.dependencies,
      ),
    ).toBe('repoint-requires-disabled');
  });

  // A repoint moves the host to ANOTHER Event, so the previous Event's public
  // face must not travel with it: the `preview` postcard the sign-in gate
  // renders, the `canonicalHost` analytics attribute to, the `isCanonical`
  // claim, and `adultContent`, which is a content warning and therefore wrong
  // to inherit in either direction. There is no deletion sentinel here, so a
  // merge could not even have removed an obsolete one.
  it('clears the previous Event metadata when the repoint supplies none', async () => {
    const before = hostnameDocument({
      status: 'disabled',
      canonicalHost: 'bodega-bay.vacaybingo.com',
      isCanonical: false,
      adultContent: true,
      preview: { headline: 'Bodega Bay' },
    });
    const { docs, dependencies } = store(converged(HOST, '5', before));
    await applyHostnameMutation(
      mutation({
        intent: 'repoint',
        host: HOST,
        changes: { eventId: 'sonoma-2027', slug: 'bodega-bay' },
        converged: edgeConverged(HOST, '5', before),
      }),
      dependencies,
    );
    expect(docs.get(`hostnames/${HOST}`)).toEqual({
      eventId: 'sonoma-2027',
      edition: 'fiveacross',
      status: 'disabled',
      slug: 'bodega-bay',
    });
  });

  it('replaces the adultContent posture the repoint does supply, and keeps the host-scoped fields', async () => {
    const before = hostnameDocument({ status: 'disabled', pathNamespace: null, adultContent: true });
    const { docs, dependencies } = store(converged(HOST, '5', before));
    await applyHostnameMutation(
      mutation({
        intent: 'repoint',
        host: HOST,
        changes: { eventId: 'sonoma-2027', adultContent: false },
        converged: edgeConverged(HOST, '5', before),
      }),
      dependencies,
    );
    expect(docs.get(`hostnames/${HOST}`)).toEqual({
      eventId: 'sonoma-2027',
      edition: 'fiveacross',
      status: 'disabled',
      slug: 'bodega-bay',
      // Host-scoped, so it survives the move.
      pathNamespace: null,
      adultContent: false,
    });
  });

  // The repoint clears the previous Event's `preview`, `canonicalHost` and
  // `isCanonical`. Their reviewed writers are Bodega-pinned, so a validated
  // write for another Event is still missing (#1274).
  // Taking replacements from the caller would make this intent the unvalidated
  // second writer the ordinary update refuses to be.
  it.each([
    ['canonicalHost', { canonicalHost: 'sonoma.fiveacross.app' }],
    ['isCanonical', { isCanonical: true }],
    ['preview', { preview: { eventName: 'Sonoma' } }],
  ])('refuses %s on a repoint and leaves both documents untouched', async (_why, extra) => {
    const before = hostnameDocument({ status: 'disabled' });
    const { docs, dependencies } = store(converged(HOST, '5', before));
    expect(
      await refusal(
        mutation({
          intent: 'repoint',
          host: HOST,
          changes: { eventId: 'sonoma-2027', ...extra },
          converged: edgeConverged(HOST, '5', before),
        }),
        dependencies,
      ),
    ).toBe('owner-restricted-field');
    expect(docs.get(`hostnames/${HOST}`)).toEqual(before);
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('5');
  });

  // Key PRESENCE is not an identity change. Restating the current `eventId`
  // beside an Edition correction satisfied the old presence test and the
  // projection-inequality check (the Edition moved), and then reset every
  // Event-scoped field of a host that still served the same Event — clearing
  // its `adultContent` acknowledgement around the monotone rule and deleting
  // its `preview` and canonical metadata. An Edition-only correction is an
  // ordinary update.
  it.each([
    ['its unchanged eventId', { eventId: 'bodega-bay-2026', edition: 'vacay' }],
    ['its unchanged slug', { slug: 'bodega-bay', edition: 'vacay' }],
    ['both unchanged', { eventId: 'bodega-bay-2026', slug: 'bodega-bay', edition: 'vacay' }],
  ])('refuses a repoint that restates %s', async (_why, changes) => {
    const before = hostnameDocument({ status: 'disabled', adultContent: true, preview: { eventName: 'Bodega Bay' } });
    const { docs, dependencies } = store(converged(HOST, '5', before));
    expect(
      await refusal(
        mutation({ intent: 'repoint', host: HOST, changes, converged: edgeConverged(HOST, '5', before) }),
        dependencies,
      ),
    ).toBe('repoint-requires-identity');
    expect(docs.get(`hostnames/${HOST}`)).toEqual(before);
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('5');
  });

  // A slug move that keeps the Event is still that Event's host, so nothing
  // Event-scoped is reset and the monotone rule still holds. Only a root host
  // can carry a route whose slug is not its own first label, the doorway hosts
  // refuse every repoint, and a brand mirror's slug move owes the replacement
  // proof (#1251), so this is a mirror following its flagship's new slug.
  it('keeps the Event metadata on a slug-only repoint and refuses lowering adultContent there', async () => {
    const ROOT = 'fiveacross.vercel.app';
    const FLAGSHIP = 'bodega.fiveacross.app';
    const flagship = hostnameDocument({ slug: 'bodega', pathNamespace: null });
    const proof = { replacementHost: FLAGSHIP, replacementConverged: edgeConverged(FLAGSHIP, '3', flagship) };
    const before = hostnameDocument({
      canonicalHost: HOST,
      isCanonical: false,
      status: 'disabled',
      pathNamespace: 'fiveacross.app',
      adultContent: true,
      preview: { eventName: 'Bodega Bay' },
    });
    const seed = () => ({ ...converged(ROOT, '5', before), ...converged(FLAGSHIP, '3', flagship) });
    const lowered = store(seed());
    expect(
      await refusal(
        mutation({
          intent: 'repoint',
          host: ROOT,
          changes: { slug: 'bodega', adultContent: false },
          converged: edgeConverged(ROOT, '5', before),
          ...proof,
        }),
        lowered.dependencies,
      ),
    ).toBe('adult-content-monotone');
    const slugMove = (extra = {}) =>
      mutation({ intent: 'repoint', host: ROOT, changes: { slug: 'bodega' }, converged: edgeConverged(ROOT, '5', before), ...extra });
    expect(await refusal(slugMove(), store(seed()).dependencies)).toBe('replacement-proof-required');

    const { docs, dependencies } = store(seed());
    await applyHostnameMutation(slugMove(proof), dependencies);
    expect(docs.get(`hostnames/${ROOT}`)).toEqual({ ...before, slug: 'bodega' });
    expect(docs.get(`routerReplicas/${ROOT}`).revision).toBe('6');
  });

  // § D1: the doorway hosts leave their Event only by becoming a root marker
  // and never carry another one, so any identity move there is refused by name.
  it.each([
    ['fiveacross.app', { slug: 'bodega' }],
    ['vacaybingo.com', { eventId: 'sonoma-2027' }],
    ['gaycruisebingo.com', { eventId: 'sonoma-2027' }],
  ])('refuses a repoint of the doorway host %s', async (host, changes) => {
    const before = hostnameDocument({ status: 'disabled', ...ROOT_HOSTS.get(host) });
    const { docs, dependencies } = store(converged(host, '5', before));
    expect(
      await refusal(mutation({ intent: 'repoint', host, changes, converged: edgeConverged(host, '5', before) }), dependencies),
    ).toBe('repoint-doorway-host');
    expect(docs.get(`hostnames/${host}`)).toEqual(before);
  });

  it('refuses combining the barrier with the status move it exists to separate', async () => {
    const { dependencies } = store(converged(HOST, '5', hostnameDocument({ status: 'disabled' })));
    expect(
      await refusal(
        mutation({
          intent: 'repoint',
          host: HOST,
          changes: { eventId: 'sonoma-2027', status: 'active' },
          converged: edgeConverged(HOST, '5', hostnameDocument({ status: 'disabled' })),
        }),
        dependencies,
      ),
    ).toBe('combined-barrier');
  });

  it('refuses a repoint that moves no identity', async () => {
    const { dependencies } = store(converged(HOST, '5', hostnameDocument({ status: 'disabled' })));
    const evidence = edgeConverged(HOST, '5', hostnameDocument({ status: 'disabled' }));
    expect(
      await refusal(
        mutation({ intent: 'repoint', host: HOST, changes: { edition: 'vacay' }, converged: evidence }),
        dependencies,
      ),
    ).toBe(
      'repoint-requires-identity',
    );
  });
});

// #1251. Each conversion spends exactly one revision. A mirror conversion is
// non-serving in both directions and its going live is the barriered
// activation that follows; a doorway conversion IS the apex's go-live step and
// carries the deployment barrier record.
describe('root/route conversion', () => {
  const REPLACEMENT = 'replacement.vacaybingo.com';
  const EVENT = 'events/replacement-2027';
  // The retired flagship's public face, which must not travel to the new one.
  const MARKER = { root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com', adultContent: true, preview: { eventName: 'Bodega Bay' }, canonicalHost: HOST, isCanonical: false };
  const replacementRoute = (extra = {}) => ({ eventId: 'replacement-2027', edition: 'vacay', status: 'active', slug: 'replacement', pathNamespace: null, ...extra });
  const disabledRootRoute = (host, extra = {}) => hostnameDocument({ status: 'disabled', adultContent: true, apexPath: true, ...ROOT_HOSTS.get(host), ...extra });
  const sourceFor = (host, extra = {}) => (ROOT_HOSTS.has(host) ? disabledRootRoute(host, extra) : hostnameDocument({ status: 'disabled', ...extra }));
  const DISABLED_ROUTE = { eventId: 'replacement-2027', slug: 'replacement', status: 'disabled', edition: 'vacay', pathNamespace: 'vacaybingo.com' };

  const routeSeed = ({ source = MARKER, replacement = replacementRoute(), event = { status: 'active' }, extra = {} } = {}) => ({
    ...converged(MIRROR, '8', source),
    ...(replacement === null ? {} : converged(REPLACEMENT, '2', replacement)),
    ...(event === null ? {} : { [EVENT]: event }),
    ...extra,
  });
  const REPLACEMENT_EDGE = edgeConverged(REPLACEMENT, '2', replacementRoute());
  const PROOF = { replacementHost: REPLACEMENT, replacementConverged: REPLACEMENT_EDGE };
  const toRoute = (extra = {}) =>
    mutation({ intent: 'convert-to-route', host: MIRROR, eventId: 'replacement-2027', ...PROOF, converged: edgeConverged(MIRROR, '8', MARKER), ...extra });
  // A doorway conversion is the go-live step, so it carries the deployment
  // barrier record by default; a mirror conversion takes none.
  const toRoot = (host, source, root, extra = {}) =>
    mutation({
      intent: 'convert-to-root',
      host,
      root,
      converged: edgeConverged(host, '5', source),
      ...(root === 'doorway' ? { pathCapabilityBarrier: BARRIER } : {}),
      ...extra,
    });

  it('turns a not-found mirror marker into a disabled replacement route, then activates it separately', async () => {
    const { docs, dependencies } = store(routeSeed());
    const plan = await applyHostnameMutation(toRoute(), dependencies);
    expect(docs.get(`hostnames/${MIRROR}`)).toEqual(DISABLED_ROUTE);
    expect(plan.revisions).toEqual([{ host: MIRROR, from: '8', to: '9' }]);
    const activate = (extra = {}) =>
      mutation({ intent: 'update', host: MIRROR, changes: { status: 'active' }, converged: edgeConverged(MIRROR, '9', DISABLED_ROUTE), ...extra });
    // The activation is what makes the mirror serve, so it re-proves the
    // replacement home rather than trusting the conversion's earlier proof.
    expect(await refusal(activate(), dependencies)).toBe('replacement-proof-required');
    await applyHostnameMutation(activate(PROOF), dependencies);
    expect(docs.get(`routerReplicas/${MIRROR}`)).toMatchObject({ revision: '10', desired: { kind: 'route', status: 'active' } });
  });

  it('refuses the mirror activation once the replacement stopped serving after the conversion', async () => {
    const { docs, dependencies } = store(routeSeed());
    await applyHostnameMutation(toRoute(), dependencies);
    const disabled = replacementRoute({ status: 'disabled' });
    docs.set(`hostnames/${REPLACEMENT}`, disabled);
    docs.set(`routerReplicas/${REPLACEMENT}`, ledgerFor(REPLACEMENT, '3', disabled));
    expect(
      await refusal(
        mutation({
          intent: 'update',
          host: MIRROR,
          changes: { status: 'active' },
          converged: edgeConverged(MIRROR, '9', DISABLED_ROUTE),
          replacementHost: REPLACEMENT,
          replacementConverged: edgeConverged(REPLACEMENT, '3', disabled),
        }),
        dependencies,
      ),
    ).toBe('replacement-not-serving');
    expect(docs.get(`routerReplicas/${MIRROR}`).revision).toBe('9');
  });

  it('inherits adultContent only when the replacement flagship carries true', async () => {
    const { docs, dependencies } = store(routeSeed({ replacement: replacementRoute({ adultContent: true }) }));
    await applyHostnameMutation(toRoute(), dependencies);
    expect(docs.get(`hostnames/${MIRROR}`)).toEqual({ ...DISABLED_ROUTE, adultContent: true });
  });

  it.each([
    ['an apex', {}, { host: APEX }, 'convert-to-route-requires-mirror'],
    ['the platform apex', {}, { host: 'fiveacross.app' }, 'convert-to-route-requires-mirror'],
    ['the GCB apex', {}, { host: 'gaycruisebingo.com' }, 'convert-to-route-requires-mirror'],
    ['the mirror as its own replacement', {}, { replacementHost: MIRROR }, 'replacement-host-ineligible'],
    ['another mirror as the replacement', {}, { replacementHost: 'fiveacross.vercel.app' }, 'replacement-host-ineligible'],
    // The evidence below names the marker, so these two also prove the kind
    // and serving checks run before the convergence check.
    ['a route source', { source: disabledRootRoute(MIRROR) }, {}, 'convert-to-route-requires-root'],
    ['a serving doorway source', { source: { ...MARKER, root: 'doorway' } }, {}, 'convert-requires-inactive'],
    ['stale evidence', {}, { converged: edgeConverged(MIRROR, '7', MARKER) }, 'convert-requires-convergence'],
    ['poisoned evidence', {}, { converged: { revision: '8', digest: 'f'.repeat(64) } }, 'convert-requires-convergence'],
    ['malformed evidence', {}, { converged: { revision: 8 } }, 'invalid-input'],
    ['no Event named', {}, { eventId: '' }, 'invalid-input'],
    ['no replacement named', {}, { replacementHost: '' }, 'invalid-input'],
    ['no replacement evidence', {}, { replacementConverged: undefined }, 'invalid-input'],
    ['stale replacement evidence', {}, { replacementConverged: edgeConverged(REPLACEMENT, '1', replacementRoute()) }, 'replacement-requires-convergence'],
    ['poisoned replacement evidence', {}, { replacementConverged: { revision: '2', digest: 'f'.repeat(64) } }, 'replacement-requires-convergence'],
    ['a missing replacement host', { replacement: null }, {}, 'replacement-not-serving'],
    ['a disabled replacement', { replacement: replacementRoute({ status: 'disabled' }) }, {}, 'replacement-not-serving'],
    ['a root-marker replacement', { extra: converged(APEX, '3', { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' }) }, { replacementHost: APEX }, 'replacement-not-serving'],
    ['a replacement for another Event', { replacement: replacementRoute({ eventId: 'other-2027' }) }, {}, 'replacement-mismatch'],
    ['a replacement in another Edition', { replacement: replacementRoute({ edition: 'fiveacross' }) }, {}, 'replacement-mismatch'],
    ['a drifted replacement', { extra: { [`routerReplicas/${REPLACEMENT}`]: ledgerFor(REPLACEMENT, '2', replacementRoute({ status: 'disabled' })) } }, {}, 'source-ledger-drift'],
    ['a missing Event document', { event: null }, {}, 'replacement-event-missing'],
    ['an archived Event', { event: { status: 'archived' } }, {}, 'event-not-live'],
    ['an Event in its archive quiesce', { event: { status: 'active', archiving: true } }, {}, 'event-not-live'],
  ])('convert-to-route refuses %s and writes nothing', async (_why, seedWith, extra, expected) => {
    const seed = routeSeed(seedWith);
    const { docs, dependencies } = store(seed);
    const input = toRoute(extra);
    for (const [key, value] of Object.entries(input)) if (value === undefined) delete input[key];
    expect(await refusal(input, dependencies)).toBe(expected);
    expect(docs.get(`hostnames/${MIRROR}`)).toEqual(seed[`hostnames/${MIRROR}`]);
    expect(docs.get(`routerReplicas/${MIRROR}`).revision).toBe('8');
  });

  it.each([
    ['the Vacay apex to its doorway', APEX, 'doorway', {}],
    ['the platform apex to its doorway', 'fiveacross.app', 'doorway', {}],
    ['a mirror whose flagship document is gone', MIRROR, 'not-found', {}],
    ['a mirror whose flagship archived', MIRROR, 'not-found', { 'events/bodega-bay-2026': { status: 'archived' } }],
  ])('convert-to-root turns %s, keeping only the non-projected fields', async (_why, host, root, extra) => {
    const source = disabledRootRoute(host);
    const { docs, dependencies } = store({ ...converged(host, '5', source), ...extra });
    const plan = await applyHostnameMutation(toRoot(host, source, root), dependencies);
    expect(docs.get(`hostnames/${host}`)).toEqual({ root, ...ROOT_HOSTS.get(host), canonicalHost: HOST, isCanonical: true, adultContent: true });
    expect(plan.revisions).toEqual([{ host, from: '5', to: '6' }]);
  });

  it.each([
    ['the GCB apex, which only the archive retires', 'gaycruisebingo.com', {}, 'doorway', {}, 'root-conversion-requires-archive'],
    ['an Event subdomain', HOST, {}, 'doorway', {}, 'root-marker-ineligible'],
    ['a doorway on a mirror', MIRROR, {}, 'doorway', {}, 'root-marker-ineligible'],
    ['not-found on an apex', APEX, {}, 'not-found', {}, 'root-marker-ineligible'],
    ['an unknown marker', APEX, {}, 'banner', {}, 'invalid-input'],
    // Evidence names the disabled source, so these also prove the ordering.
    ['an active route', APEX, { status: 'active' }, 'doorway', {}, 'convert-requires-inactive'],
    ['an archived route', APEX, { status: 'archived' }, 'doorway', {}, 'convert-requires-inactive'],
    ['stale evidence', APEX, {}, 'doorway', { converged: { revision: '4', digest: 'f'.repeat(64) } }, 'convert-requires-convergence'],
    // The doorway serves the moment it converges, so § D1's service-worker
    // retirement is attested before it; a mirror marker takes no record.
    ['a doorway without the deployment barrier', APEX, {}, 'doorway', { pathCapabilityBarrier: undefined }, 'doorway-requires-deployment-barrier'],
    ['a doorway whose barrier is armed in the future', APEX, {}, 'doorway', { pathCapabilityBarrier: { ...BARRIER, armedAt: '2026-09-21T00:00:00.000Z' } }, 'path-capability-barrier'],
    ['a malformed deployment barrier', 'fiveacross.app', {}, 'doorway', { pathCapabilityBarrier: { ...BARRIER, resolutionCacheSchemaVersion: 0 } }, 'path-capability-barrier'],
    ['a deployment barrier on a mirror marker', MIRROR, {}, 'not-found', { pathCapabilityBarrier: BARRIER }, 'invalid-input'],
    ['a mirror whose flagship is live', MIRROR, { event: { status: 'active' } }, 'not-found', {}, 'root-conversion-flagship-live'],
    ['a mirror whose flagship is archiving', MIRROR, { event: { status: 'active', archiving: true } }, 'not-found', {}, 'root-conversion-flagship-live'],
  ])('convert-to-root refuses %s and writes nothing', async (_why, host, { event, ...overrides }, root, extra, expected) => {
    const source = sourceFor(host, overrides);
    const seed = { ...converged(host, '5', source), ...(event ? { 'events/bodega-bay-2026': event } : {}) };
    const { docs, dependencies } = store(seed);
    const input = toRoot(host, sourceFor(host), root, extra);
    for (const [key, value] of Object.entries(input)) if (value === undefined) delete input[key];
    expect(await refusal(input, dependencies)).toBe(expected);
    expect(docs.get(`hostnames/${host}`)).toEqual(source);
    expect(docs.get(`routerReplicas/${host}`).revision).toBe('5');
  });

  it('refuses convert-to-root on a marker, and the converted doorway still refuses delete', async () => {
    const doorway = { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
    expect(await refusal(toRoot(APEX, doorway, 'doorway'), store(converged(APEX, '5', doorway)).dependencies)).toBe(
      'convert-to-root-requires-route',
    );
    const source = disabledRootRoute(APEX);
    const { docs, dependencies } = store(converged(APEX, '5', source));
    const dry = await applyHostnameMutation(toRoot(APEX, source, 'doorway', { apply: false }), dependencies);
    expect(docs.get(`hostnames/${APEX}`)).toEqual(source);
    const wet = await applyHostnameMutation(toRoot(APEX, source, 'doorway'), dependencies);
    expect(wet.writes).toEqual(dry.writes);
    const converted = docs.get(`hostnames/${APEX}`);
    expect(
      await refusal(
        mutation({ intent: 'delete', host: APEX, convergedRevision: '6', convergedDigest: edgeConverged(APEX, '6', converted).digest }),
        dependencies,
      ),
    ).toBe('delete-requires-inactive');
  });
});

// Without these, one later call walks around the replacement proof: an
// activation onto an Event nothing provisioned, a mirror repoint to another
// Event, or an Edition relabel of a root host route.
describe('the root-host replacement barrier', () => {
  const REPLACEMENT = 'replacement.vacaybingo.com';
  const mirrorRoute = hostnameDocument({ status: 'disabled', edition: 'vacay', pathNamespace: 'vacaybingo.com' });
  const replacement = { eventId: 'replacement-2027', edition: 'vacay', status: 'active', slug: 'replacement', pathNamespace: null };
  const seed = (extra = {}) => ({
    ...converged(MIRROR, '5', mirrorRoute),
    ...converged(REPLACEMENT, '2', replacement),
    'events/replacement-2027': { status: 'active' },
    ...extra,
  });
  const PROOF = { replacementHost: REPLACEMENT, replacementConverged: edgeConverged(REPLACEMENT, '2', replacement) };
  const repointMirror = (extra = {}) =>
    mutation({ intent: 'repoint', host: MIRROR, changes: { eventId: 'replacement-2027', slug: 'replacement' }, converged: edgeConverged(MIRROR, '5', mirrorRoute), ...PROOF, ...extra });

  it('refuses activating a root host route whose Event document is missing, but not an Event subdomain', async () => {
    const activate = (host, document, extra = {}) =>
      mutation({ intent: 'update', host, changes: { status: 'active' }, converged: edgeConverged(host, '5', document), ...extra });
    expect(await refusal(activate(MIRROR, mirrorRoute, PROOF), store(converged(MIRROR, '5', mirrorRoute)).dependencies)).toBe(
      'replacement-event-missing',
    );
    const subdomain = hostnameDocument({ status: 'disabled' });
    const { docs, dependencies } = store(converged(HOST, '5', subdomain));
    expect(await refusal(activate(HOST, subdomain, PROOF), dependencies)).toBe('invalid-input');
    await applyHostnameMutation(activate(HOST, subdomain), dependencies);
    expect(docs.get(`hostnames/${HOST}`).status).toBe('active');
  });

  it('refuses a mirror activation without the replacement proof, or with only half of it', async () => {
    const { docs, dependencies } = store(seed());
    const activate = (extra = {}) =>
      mutation({ intent: 'update', host: MIRROR, changes: { status: 'active' }, converged: edgeConverged(MIRROR, '5', mirrorRoute), ...extra });
    expect(await refusal(activate(), dependencies)).toBe('replacement-proof-required');
    expect(await refusal(activate({ replacementHost: REPLACEMENT }), dependencies)).toBe('replacement-proof-required');
    // The mirror names bodega-bay-2026, which the replacement does not serve.
    expect(await refusal(activate(PROOF), dependencies)).toBe('replacement-event-missing');
    expect(docs.get(`routerReplicas/${MIRROR}`).revision).toBe('5');
  });

  it.each([
    ['without a replacement proof', {}, { replacementHost: undefined, replacementConverged: undefined }, 'replacement-proof-required'],
    ['with stale replacement evidence', {}, { replacementConverged: edgeConverged(REPLACEMENT, '1', replacement) }, 'replacement-requires-convergence'],
    ['onto a slug the replacement does not serve', {}, { changes: { eventId: 'replacement-2027', slug: 'other' } }, 'replacement-mismatch'],
    ['onto an Event document that does not exist', { 'events/replacement-2027': undefined }, {}, 'replacement-event-missing'],
    ['relabelled with another Edition', {}, { changes: { eventId: 'replacement-2027', slug: 'replacement', edition: 'gcb' } }, 'host-scoped-field'],
  ])('refuses a mirror repoint %s', async (_why, seedExtra, extra, expected) => {
    const seeded = store(Object.fromEntries(Object.entries(seed(seedExtra)).filter(([, value]) => value !== undefined)));
    const input = repointMirror(extra);
    for (const [key, value] of Object.entries(input)) if (value === undefined) delete input[key];
    expect(await refusal(input, seeded.dependencies)).toBe(expected);
    expect(seeded.docs.get(`routerReplicas/${MIRROR}`).revision).toBe('5');
  });

  it('repoints a mirror onto a proved replacement and refuses the proof where it proves nothing', async () => {
    const { docs, dependencies } = store(seed());
    await applyHostnameMutation(repointMirror(), dependencies);
    expect(docs.get(`hostnames/${MIRROR}`)).toMatchObject({ eventId: 'replacement-2027', slug: 'replacement', status: 'disabled' });
    const subdomain = hostnameDocument({ status: 'disabled' });
    expect(
      await refusal(
        mutation({ intent: 'repoint', host: HOST, changes: { eventId: 'sonoma-2027' }, converged: edgeConverged(HOST, '5', subdomain), ...PROOF }),
        store(converged(HOST, '5', subdomain)).dependencies,
      ),
    ).toBe('invalid-input');
  });

  // § D1: brand mirrors get no doorway, and the derivation accepts either root
  // value on every root host, so the class rule holds on every root write.
  it('refuses a doorway on a brand mirror through an update or a provision, but lets an apex doorway withdraw to not-found', async () => {
    const marker = { root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
    const mirror = store(converged(MIRROR, '5', marker));
    expect(await refusal(mutation({ intent: 'update', host: MIRROR, changes: { root: 'doorway' } }), mirror.dependencies)).toBe(
      'root-marker-ineligible',
    );
    expect(mirror.docs.get(`routerReplicas/${MIRROR}`).revision).toBe('5');
    expect(
      await refusal(
        mutation({ intent: 'provision', host: MIRROR, hostname: { ...marker, root: 'doorway' }, pathCapabilityBarrier: BARRIER }),
        store().dependencies,
      ),
    ).toBe('root-marker-ineligible');
    const doorway = { ...marker, root: 'doorway' };
    const apex = store(converged(APEX, '5', doorway));
    await applyHostnameMutation(mutation({ intent: 'update', host: APEX, changes: { root: 'not-found' } }), apex.dependencies);
    expect(apex.docs.get(`hostnames/${APEX}`).root).toBe('not-found');
  });

  // A `not-found` apex marker moving to `doorway` is a doorway go-live, so it
  // owes the same deployment barrier as the doorway `convert-to-root`.
  it('requires the deployment barrier when an update turns an apex marker into its doorway', async () => {
    const marker = { root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
    const goLive = (extra = {}) => mutation({ intent: 'update', host: APEX, changes: { root: 'doorway' }, ...extra });
    const { docs, dependencies } = store(converged(APEX, '5', marker));
    expect(await refusal(goLive(), dependencies)).toBe('doorway-requires-deployment-barrier');
    expect(await refusal(goLive({ pathCapabilityBarrier: { ...BARRIER, armedAt: '2026-09-21T00:00:00.000Z' } }), dependencies)).toBe(
      'path-capability-barrier',
    );
    expect(docs.get(`routerReplicas/${APEX}`).revision).toBe('5');
    await applyHostnameMutation(goLive({ pathCapabilityBarrier: BARRIER }), dependencies);
    expect(docs.get(`hostnames/${APEX}`).root).toBe('doorway');
    expect(
      await refusal(mutation({ intent: 'update', host: APEX, changes: { root: 'not-found' }, pathCapabilityBarrier: BARRIER }), dependencies),
    ).toBe('invalid-input');
  });

  it('refuses provisioning a root-host route under another Edition, and activating a legacy one on a mirror', async () => {
    expect(
      await refusal(
        mutation({ intent: 'provision', host: MIRROR, hostname: { ...mirrorRoute, edition: 'gcb' }, pathCapabilityBarrier: BARRIER }),
        store().dependencies,
      ),
    ).toBe('host-scoped-field');
    const legacy = { ...mirrorRoute, eventId: 'replacement-2027', slug: 'replacement', edition: 'fiveacross' };
    const seeded = store({ ...seed(), ...converged(MIRROR, '5', legacy) });
    expect(
      await refusal(
        mutation({ intent: 'update', host: MIRROR, changes: { status: 'active' }, converged: edgeConverged(MIRROR, '5', legacy), ...PROOF }),
        seeded.dependencies,
      ),
    ).toBe('host-scoped-field');
    expect(seeded.docs.get(`routerReplicas/${MIRROR}`).revision).toBe('5');
  });

  it('refuses an ordinary update that relabels a root host route with another Edition', async () => {
    expect(
      await refusal(mutation({ intent: 'update', host: MIRROR, changes: { edition: 'gcb' } }), store(converged(MIRROR, '5', mirrorRoute)).dependencies),
    ).toBe('host-scoped-field');
  });
});

describe('archive', () => {
  // A SECOND mapping in the auth-ready Namespace, so "two eligible targets"
  // can be exercised: the `vacaybingo.com` alias below is a mapping of the
  // same Event but is not an admissible archive address yet (§ D7).
  const SECOND = 'bodega-bay-2026.fiveacross.app';

  // The application flip this intent composes with (#1256): the quiesce
  // `beginArchive` installed under generation 3, and the payload prepared
  // under it. The helper runs as Admin, so the rules' flip arm never sees its
  // write, and it asks that arm's questions itself.
  const GENERATION = 3;
  const ARCHIVED_AT = Date.parse('2026-09-20T11:59:00.000Z');
  const ROW = {
    uid: 'p1',
    displayName: 'Pat',
    bingoCount: 2,
    squaresMarked: 14,
    blackout: false,
    firstBingoAt: 1_000,
  };
  const HONOR = (dayIndex) => ({ dayIndex, uid: 'p1', displayName: 'Pat', firstBingoAt: 1_000, dayLabel: `D${dayIndex + 1}` });
  const archiveRecord = (overrides = {}) => ({
    eventName: 'Bodega Bay',
    standings: [ROW],
    playerCount: 1,
    firstBingo: { uid: 'p1', displayName: 'Pat', at: 1_000 },
    firstBingoRow: { ...ROW, rank: 1 },
    dailyHonors: [],
    freezeAt: null,
    archivedAt: ARCHIVED_AT,
    ...overrides,
  });
  const flipFor = (archivedUnder, overrides = {}) => ({
    archivedAt: ARCHIVED_AT,
    archivedUnder,
    archive: archiveRecord(),
    ...overrides,
  });
  const composedFlip = (generation = GENERATION) => ({
    archiveToken: generation,
    flip: flipFor(generation),
    snapshotConfig: archiveSnapshotConfig(quiescedEvent()),
  });
  // The configuration the record is defined by (`archiveSnapshotConfig`).
  const SNAPSHOT_FIELDS = {
    name: 'Bodega Bay',
    claimMode: 'honor',
    days: [{ index: 0, theme: 'neon-playground', unlockAt: 1_000, tonight: [] }],
    standingsFreezeAt: 5_000,
    bannedUids: ['p9'],
  };
  const quiescedEvent = (overrides = {}) => ({
    status: 'active',
    admins: ['nathan'],
    ...SNAPSHOT_FIELDS,
    archiving: true,
    archiveToken: GENERATION,
    ...overrides,
  });

  const flagship = () => ({
    ...converged(HOST, '4', hostnameDocument()),
    ...converged(SECOND, '3', hostnameDocument({ canonicalHost: HOST, isCanonical: false, slug: 'bodega-bay-2026' })),
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
    'events/bodega-bay-2026': quiescedEvent(),
  });

  const archiveInput = (overrides = {}) =>
    mutation({
      intent: 'archive',
      ...composedFlip(),
      eventId: 'bodega-bay-2026',
      mappings: [HOST, SECOND, ALIAS],
      apexPathHost: HOST,
      mirrorRootConversions: [{ host: MIRROR, root: 'not-found' }],
      ...overrides,
    });

  it('moves every mapping, the apexPath flag, the mirror root marker and the Event document together', async () => {
    const { docs, dependencies } = store(flagship());
    const plan = await applyHostnameMutation(archiveInput(), dependencies);
    expect(plan.revisions).toEqual([
      { host: HOST, from: '4', to: '5' },
      { host: SECOND, from: '3', to: '4' },
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
    // The Event takes the application flip, not a bare status: all five fields
    // in the same transaction as the routing moves, with the generation kept
    // and every other field left as it was.
    expect(docs.get('events/bodega-bay-2026')).toEqual({
      admins: ['nathan'],
      ...SNAPSHOT_FIELDS,
      archiveToken: GENERATION,
      status: 'archived',
      archivedAt: ARCHIVED_AT,
      archivedUnder: GENERATION,
      archive: archiveRecord(),
      archiving: false,
    });
    expect(plan.archivedUnder).toBe(GENERATION);
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
    await applyHostnameMutation(archiveInput({ apexPathHost: SECOND }), dependencies);
    expect(docs.get(`hostnames/${SECOND}`)).toMatchObject({ status: 'archived', apexPath: true });
    expect(docs.get(`hostnames/${HOST}`).status).toBe('archived');
    expect(docs.get(`hostnames/${HOST}`).apexPath).toBeUndefined();
    expect(await refusal(archiveInput({ mappings: [HOST, HOST] }), store(flagship()).dependencies)).toBe(
      'invalid-input',
    );
  });

  // Which marker a retired root host takes is a property of the host class.
  // § D1 gives a canonical apex its doorway once the flagship archives — the
  // GCB apex becomes its Edition doorway exactly at this transaction — while
  // a brand mirror is deliberately not-found. Forcing `not-found` everywhere
  // made archiving the live GCB Event impossible to do correctly: including
  // `gaycruisebingo.com` is required for completeness, and the only marker
  // the branch accepted would have left the canonical surface offline.
  it.each([
    ['the canonical GCB apex', 'gaycruisebingo.com', 'gcb', null, 'doorway', 'not-found'],
    ['a brand mirror', MIRROR, 'vacay', 'vacaybingo.com', 'not-found', 'doorway'],
  ])('converts %s to its own marker and refuses the other', async (_why, host, edition, pathNamespace, allowed, refused) => {
    const seed = () => ({
      ...converged(HOST, '4', hostnameDocument()),
      ...converged(host, '6', {
        eventId: 'bodega-bay-2026',
        edition,
        status: 'active',
        slug: 'bodega-bay',
        pathNamespace,
      }),
      'events/bodega-bay-2026': quiescedEvent(),
    });
    // A doorway conversion is a doorway go-live and carries the deployment
    // barrier (#1296); a not-found one refuses the record. The class refusal
    // comes first, so the refused arm is about the marker either way.
    const input = (root) =>
      mutation({
        intent: 'archive',
        ...composedFlip(),
        eventId: 'bodega-bay-2026',
        mappings: [HOST],
        apexPathHost: HOST,
        mirrorRootConversions: [{ host, root }],
        ...(root === 'doorway' ? { pathCapabilityBarrier: BARRIER } : {}),
      });
    expect(await refusal(input(refused), store(seed()).dependencies)).toBe('root-marker-ineligible');

    const { docs, dependencies } = store(seed());
    await applyHostnameMutation(input(allowed), dependencies);
    expect(docs.get(`hostnames/${host}`)).toEqual({ root: allowed, edition, pathNamespace });
    expect(docs.get(`routerReplicas/${host}`).desired).toEqual({
      kind: 'root',
      root: allowed,
      edition,
      pathNamespace,
    });
  });

  // A doorway the archive writes SERVES as soon as its revision converges, at
  // a root the retired Event's service worker controlled, so the archive takes
  // the same deployment-barrier record the doorway `convert-to-root` and the
  // `not-found` -> `doorway` update take (#1296). The GCB apex carries no
  // `pathNamespace` and takes exactly the same record: one attestation for
  // every doorway, by the owner's decision, and no GCB-specific one.
  describe('the deployment barrier on a doorway conversion', () => {
    const doorwaySeed = (host, edition, pathNamespace) => ({
      ...converged(HOST, '4', hostnameDocument()),
      ...converged(host, '6', { eventId: 'bodega-bay-2026', edition, status: 'active', slug: 'bodega-bay', pathNamespace }),
      'events/bodega-bay-2026': quiescedEvent(),
    });
    const doorwayArchive = (host, extra = {}) =>
      mutation({
        intent: 'archive',
        ...composedFlip(),
        eventId: 'bodega-bay-2026',
        mappings: [HOST],
        apexPathHost: HOST,
        mirrorRootConversions: [{ host, root: 'doorway' }],
        ...extra,
      });

    it.each([
      ['the GCB apex, which carries no pathNamespace', 'gaycruisebingo.com', 'gcb', null],
      ['a Namespace-bearing doorway apex', APEX, 'vacay', 'vacaybingo.com'],
    ])('refuses %s without an armed record and leaves every document standing', async (_why, host, edition, pathNamespace) => {
      for (const [extra, code] of [
        [{}, 'doorway-requires-deployment-barrier'],
        [{ pathCapabilityBarrier: null }, 'doorway-requires-deployment-barrier'],
        [{ pathCapabilityBarrier: { ...BARRIER, armedAt: '2026-09-21T00:00:00.000Z' } }, 'path-capability-barrier'],
        [{ pathCapabilityBarrier: { ...BARRIER, resolutionCacheSchemaVersion: 0 } }, 'path-capability-barrier'],
        [{ pathCapabilityBarrier: { ...BARRIER, note: 'gcb' } }, 'path-capability-barrier'],
      ]) {
        const { docs, dependencies } = store(doorwaySeed(host, edition, pathNamespace));
        expect(await refusal(doorwayArchive(host, extra), dependencies)).toBe(code);
        expect(docs.get(`hostnames/${host}`)).toMatchObject({ eventId: 'bodega-bay-2026', status: 'active' });
        expect(docs.get(`routerReplicas/${host}`).revision).toBe('6');
        expect(docs.get(`hostnames/${HOST}`).status).toBe('active');
        expect(docs.get('events/bodega-bay-2026').status).toBe('active');
      }

      const { docs, dependencies } = store(doorwaySeed(host, edition, pathNamespace));
      await applyHostnameMutation(doorwayArchive(host, { pathCapabilityBarrier: BARRIER }), dependencies);
      expect(docs.get(`hostnames/${host}`)).toEqual({ root: 'doorway', edition, pathNamespace });
      expect(docs.get('events/bodega-bay-2026').status).toBe('archived');
    });

    it('refuses the record on an archive whose conversions yield no doorway', async () => {
      for (const pathCapabilityBarrier of [BARRIER, null]) {
        const { docs, dependencies } = store(flagship());
        expect(await refusal(archiveInput({ pathCapabilityBarrier }), dependencies)).toBe('invalid-input');
        expect(docs.get(`hostnames/${MIRROR}`)).toMatchObject({ status: 'active' });
        expect(docs.get('events/bodega-bay-2026').status).toBe('active');
      }
      // An archive with no root conversion at all has no doorway either.
      const plain = store({
        ...converged(HOST, '4', hostnameDocument()),
        'events/bodega-bay-2026': quiescedEvent(),
      });
      expect(
        await refusal(
          archiveInput({ mappings: [HOST], mirrorRootConversions: [], pathCapabilityBarrier: BARRIER }),
          plain.dependencies,
        ),
      ).toBe('invalid-input');
    });

    it('takes one record for an archive that converts a doorway and a mirror together', async () => {
      const seed = {
        ...flagship(),
        ...converged('gaycruisebingo.com', '6', {
          eventId: 'bodega-bay-2026',
          edition: 'gcb',
          status: 'active',
          slug: 'bodega-bay',
          pathNamespace: null,
        }),
      };
      const conversions = [
        { host: MIRROR, root: 'not-found' },
        { host: 'gaycruisebingo.com', root: 'doorway' },
      ];
      expect(await refusal(archiveInput({ mirrorRootConversions: conversions }), store(seed).dependencies)).toBe(
        'doorway-requires-deployment-barrier',
      );
      const { docs, dependencies } = store(seed);
      await applyHostnameMutation(
        archiveInput({ mirrorRootConversions: conversions, pathCapabilityBarrier: BARRIER }),
        dependencies,
      );
      expect(docs.get('hostnames/gaycruisebingo.com')).toEqual({ root: 'doorway', edition: 'gcb', pathNamespace: null });
      expect(docs.get(`hostnames/${MIRROR}`).root).toBe('not-found');
    });
  });

  // The archive address has to be able to SIGN A PLAYER IN, and the apex it
  // would live under decides that. § D7 states the precondition and records
  // that `vacaybingo.com` has not met it, so an archive parked there renders
  // auth-unconfigured on an Event that can never be un-archived.
  it('refuses an archive target whose apex cannot sign a Player in yet', async () => {
    const { docs, dependencies } = store(flagship());
    expect(await refusal(archiveInput({ apexPathHost: ALIAS }), dependencies)).toBe(
      'archive-apex-target-auth-unready',
    );
    expect(docs.get(`hostnames/${HOST}`).status).toBe('active');
    expect(docs.get('events/bodega-bay-2026').status).toBe('active');

    // The registered apex is admissible, which is what makes the refusal
    // about registration rather than about archives at a path.
    const ready = store(flagship());
    await applyHostnameMutation(archiveInput({ apexPathHost: HOST }), ready.dependencies);
    expect(ready.docs.get(`hostnames/${HOST}`)).toMatchObject({ status: 'archived', apexPath: true });
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
    seed['events/other-2026'] = quiescedEvent();
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
          mappings: [HOST, SECOND],
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

  // #1256: the archive composes the application flip of
  // `specs/post-sailing-archive.md` instead of stamping `status` alone. The
  // helper runs as Admin, so the rules' flip arm never sees its write; the
  // quiesce, its generation and the record are all checked here, inside the
  // transaction that moves the mappings, and a refusal writes nothing.
  describe('the composed application flip', () => {
    const untouched = (docs, event) => {
      expect(docs.get(`hostnames/${HOST}`)).toMatchObject({ status: 'active' });
      expect(docs.get(`hostnames/${HOST}`).apexPath).toBeUndefined();
      expect(docs.get(`hostnames/${MIRROR}`)).toMatchObject({ status: 'active' });
      expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
      expect(docs.get(`routerReplicas/${MIRROR}`).revision).toBe('7');
      expect(docs.get('events/bodega-bay-2026')).toEqual(event);
    };

    it.each([
      ['was never shut', { status: 'active', admins: ['nathan'] }, 'archive-requires-quiesce'],
      ['was reopened by abandonArchive', quiescedEvent({ archiving: false }), 'archive-requires-quiesce'],
      [
        'is already archived',
        quiescedEvent({
          status: 'archived',
          archiving: false,
          archivedAt: ARCHIVED_AT,
          archivedUnder: GENERATION,
          archive: archiveRecord(),
        }),
        'event-already-archived',
      ],
      ['was reopened and shut again under a later generation', quiescedEvent({ archiveToken: 4 }), 'archive-quiesce-changed'],
      ['carries a generation no build can bind to', quiescedEvent({ archiveToken: '3' }), 'archive-quiesce-changed'],
      ['was shut with no generation at all', { status: 'active', admins: ['nathan'], archiving: true }, 'archive-quiesce-changed'],
      ['already carries the flip-only archivedUnder', quiescedEvent({ archivedUnder: GENERATION }), 'archive-quiesce-changed'],
    ])('refuses an Event that %s and leaves every document standing', async (_why, event, code) => {
      const seed = flagship();
      seed['events/bodega-bay-2026'] = event;
      const { docs, dependencies } = store(seed);
      expect(await refusal(archiveInput(), dependencies)).toBe(code);
      untouched(docs, event);
    });

    // A payload carried over from one quiesce, replayed after an abort and a
    // second `beginArchive` with the generation it declares left as it was.
    // The payload's own `archivedUnder` is what is refused, whichever generation
    // the caller names beside it. What this cannot catch is a caller that
    // rewrites BOTH to the new generation around the old record: nothing in the
    // payload records when the record was read, so its freshness is the
    // operator command's obligation (#1488), as it is the console's at the
    // rules boundary.
    it('refuses a payload declaring a superseded generation, whichever generation the caller names', async () => {
      const seed = flagship();
      seed['events/bodega-bay-2026'] = quiescedEvent({ archiveToken: 4 });
      const stale = store(seed);
      expect(await refusal(archiveInput(), stale.dependencies)).toBe('archive-quiesce-changed');
      untouched(stale.docs, seed['events/bodega-bay-2026']);

      // Naming the generation now in force beside a payload that still
      // declares the old one is refused before anything is read.
      const relabelled = store(seed);
      expect(await refusal(archiveInput({ archiveToken: 4 }), relabelled.dependencies)).toBe(
        'archive-flip-generation-mismatch',
      );
      expect(relabelled.reads).toEqual([]);
      untouched(relabelled.docs, seed['events/bodega-bay-2026']);

      // A payload prepared under the generation in force is accepted.
      const fresh = store(seed);
      await applyHostnameMutation(archiveInput(composedFlip(4)), fresh.dependencies);
      expect(fresh.docs.get('events/bodega-bay-2026')).toMatchObject({ status: 'archived', archivedUnder: 4 });
    });

    it.each([
      ['no flip at all', { flip: undefined }],
      ['a zero generation', { archiveToken: 0 }],
      ['a fractional generation', { archiveToken: 2.5 }],
      ['a generation spelled as text', { archiveToken: '3' }],
      ['an unsafe integer generation', { archiveToken: 2 ** 53 }],
    ])('refuses %s as invalid input before the first read', async (_why, overrides) => {
      const input = archiveInput(overrides);
      if (input.flip === undefined) delete input.flip;
      const { docs, reads, dependencies } = store(flagship());
      expect(await refusal(input, dependencies)).toBe('invalid-input');
      expect(reads).toEqual([]);
      untouched(docs, quiescedEvent());
    });

    it.each([
      ['no configuration at all', undefined],
      ['a configuration that is not a map', 'bodega'],
      ['a configuration missing a key', (() => { const { frozenAt: _f, ...rest } = archiveSnapshotConfig(quiescedEvent()); return rest; })()],
      ['a configuration with a key the snapshot does not define', { ...archiveSnapshotConfig(quiescedEvent()), finaleCompletedAt: null }],
      ['a schedule that is not a list', { ...archiveSnapshotConfig(quiescedEvent()), days: {} }],
      ['a ban list that is not a list', { ...archiveSnapshotConfig(quiescedEvent()), bannedUids: 'p9' }],
    ])('refuses %s as invalid input before the first read', async (_why, snapshotConfig) => {
      const input = archiveInput({ snapshotConfig });
      if (snapshotConfig === undefined) delete input.snapshotConfig;
      const { docs, reads, dependencies } = store(flagship());
      expect(await refusal(input, dependencies)).toBe('invalid-input');
      expect(reads).toEqual([]);
      untouched(docs, quiescedEvent());
    });

    // The quiesce shuts gameplay, not administration: inside ONE generation an
    // Admin can still edit what the record was built against, and the token
    // check cannot see it. The console's `archiveEvent` aborts on the same
    // change (`config-changed`); this transaction does too, with nothing moved.
    it.each([
      ['renamed', { name: 'Bodega Bay Redux' }],
      ['switched claim mode', { claimMode: 'admin_confirmed' }],
      ['re-themed a Day', { days: [{ ...SNAPSHOT_FIELDS.days[0], theme: 'disco' }] }],
      ['added a Day', { days: [...SNAPSHOT_FIELDS.days, { index: 1, theme: 'disco', unlockAt: 2_000, tonight: [] }] }],
      ['moved the Standings Freeze', { standingsFreezeAt: 6_000 }],
      ['stamped the freeze', { frozenAt: 5_000 }],
      // The console leaves bans out of its fingerprint only because it builds
      // the record from its own transactional read; this record was built
      // from an earlier one, so a ban or an unban in between changes whose
      // rows it should have kept.
      ['banned a Player', { bannedUids: ['p9', 'p1'] }],
      ['unbanned a Player', { bannedUids: [] }],
    ])('refuses an archive whose Event was %s after the record was prepared', async (_why, edit) => {
      const seed = flagship();
      seed['events/bodega-bay-2026'] = quiescedEvent(edit);
      const { docs, dependencies } = store(seed);
      expect(await refusal(archiveInput(), dependencies)).toBe('archive-config-changed');
      untouched(docs, seed['events/bodega-bay-2026']);
      for (const host of [HOST, SECOND, ALIAS]) expect(docs.get(`hostnames/${host}`).status).toBe('active');
    });

    // …while a finale marker stays outside, as it does in the console's: it
    // only ever makes the archive more permitted, and the builder does not
    // read it.
    it.each([
      ['completed its finale', { finaleCompletedAt: 4_000 }],
    ])('accepts an archive whose Event was %s after the record was prepared', async (_why, edit) => {
      const seed = flagship();
      seed['events/bodega-bay-2026'] = quiescedEvent(edit);
      const { docs, dependencies } = store(seed);
      await applyHostnameMutation(archiveInput(), dependencies);
      expect(docs.get('events/bodega-bay-2026')).toMatchObject({ status: 'archived', ...edit });
    });

    it('derives the configuration of an Event that stores none of it as nulls and an empty schedule', () => {
      expect(archiveSnapshotConfig({ status: 'active' })).toEqual({
        name: null,
        claimMode: null,
        days: [],
        standingsFreezeAt: null,
        frozenAt: null,
        bannedUids: [],
      });
      expect(archiveSnapshotConfig({ days: 'not-a-list' }).days).toEqual([]);
    });

    // An Admin-written schedule is unconstrained, so it can hold a value the
    // structural comparison cannot walk. That is a named refusal with nothing
    // written, not a thrown stack overflow.
    it('refuses a configuration it cannot compare by name and writes nothing', async () => {
      // An SDK-shaped object (not a plain map) whose back-reference is cyclic,
      // as a client `DocumentReference`'s `firestore` handle is.
      class Reference {
        constructor(path) {
          this.path = path;
          this.firestore = { root: this };
        }
      }
      const cyclic = new Reference('events/elsewhere');
      const seed = flagship();
      seed['events/bodega-bay-2026'] = quiescedEvent({ days: [{ ...SNAPSHOT_FIELDS.days[0], link: cyclic }] });
      const { docs, dependencies } = store(seed);
      expect(await refusal(archiveInput(), dependencies)).toBe('archive-config-unreadable');
      untouched(docs, seed['events/bodega-bay-2026']);
    });

    // Every question the rules' flip arm asks, because an Admin write is not
    // asked them by the boundary: a record the console could never have
    // written is still irreversible once this transaction commits it.
    const stamped = (archivedAt) => flipFor(GENERATION, { archivedAt, archive: archiveRecord({ archivedAt }) });
    const { freezeAt: _dropped, ...recordWithoutFreezeAt } = archiveRecord();
    it.each([
      ['a payload missing its record', (() => { const { archive: _a, ...rest } = flipFor(GENERATION); return rest; })()],
      ['a payload carrying a field the flip does not write', flipFor(GENERATION, { archiving: false })],
      ['a zero stamp', stamped(0)],
      ['a stamp past 2100', stamped(4102444800000)],
      ['a stamp spelled as text', stamped('2026-09-20T11:59:00.000Z')],
      ['a record stamped at another instant', flipFor(GENERATION, { archive: archiveRecord({ archivedAt: ARCHIVED_AT + 1 }) })],
      ['a null record', flipFor(GENERATION, { archive: null })],
      ['a record missing a key', flipFor(GENERATION, { archive: recordWithoutFreezeAt })],
      ['a record with a key EventArchive does not declare', flipFor(GENERATION, { archive: archiveRecord({ extra: 1 }) })],
      ['a name that is not text', flipFor(GENERATION, { archive: archiveRecord({ eventName: 7 }) })],
      ['a fractional playerCount', flipFor(GENERATION, { archive: archiveRecord({ playerCount: 1.5 }) })],
      // Integral but unsafe: the Admin SDK stores it as a double, which the
      // rules' `is int` denies, so it is refused here as the arm would.
      [
        'an unsafe integer playerCount',
        flipFor(GENERATION, { archive: archiveRecord({ standings: Array.from({ length: 200 }, () => ROW), playerCount: 1e20 }) }),
      ],
      [
        'a held row with an unsafe integer rank',
        flipFor(GENERATION, { archive: archiveRecord({ firstBingoRow: { ...ROW, rank: 2 ** 53 } }) }),
      ],
      [
        'a daily honour with an unsafe integer Day index',
        flipFor(GENERATION, { archive: archiveRecord({ dailyHonors: [{ ...HONOR(0), dayIndex: 2 ** 53 }] }) }),
      ],
      ['standings that disagree with playerCount', flipFor(GENERATION, { archive: archiveRecord({ playerCount: 2 }) })],
      ['standings that are not a list', flipFor(GENERATION, { archive: archiveRecord({ standings: { 0: ROW } }) })],
      [
        'more daily honours than an Event has Days',
        flipFor(GENERATION, {
          archive: archiveRecord({
            dailyHonors: Array.from({ length: 21 }, (_, dayIndex) => HONOR(dayIndex)),
          }),
        }),
      ],
      // Each honour is walked as the console's `writableArchiveRecord` walks
      // it: the archived surfaces render its fields straight through.
      ['a daily honour carrying no fields', flipFor(GENERATION, { archive: archiveRecord({ dailyHonors: [{}] }) })],
      ['a daily honour that is not a map', flipFor(GENERATION, { archive: archiveRecord({ dailyHonors: [null] }) })],
      [
        'a daily honour with no label',
        flipFor(GENERATION, { archive: archiveRecord({ dailyHonors: [{ ...HONOR(0), dayLabel: undefined }] }) }),
      ],
      [
        'a daily honour with an empty uid',
        flipFor(GENERATION, { archive: archiveRecord({ dailyHonors: [{ ...HONOR(0), uid: '' }] }) }),
      ],
      [
        'a daily honour with a fractional Day index',
        flipFor(GENERATION, { archive: archiveRecord({ dailyHonors: [{ ...HONOR(0), dayIndex: 0.5 }] }) }),
      ],
      [
        'a daily honour with an unbounded instant',
        flipFor(GENERATION, { archive: archiveRecord({ dailyHonors: [{ ...HONOR(0), firstBingoAt: Infinity }] }) }),
      ],
      ['daily honours out of Day order', flipFor(GENERATION, { archive: archiveRecord({ dailyHonors: [HONOR(2), HONOR(1)] }) })],
      ['two honours for one Day', flipFor(GENERATION, { archive: archiveRecord({ dailyHonors: [HONOR(1), HONOR(1)] }) })],
      ['an unbounded freezeAt', flipFor(GENERATION, { archive: archiveRecord({ freezeAt: Infinity }) })],
      ['a First to BINGO without its row', flipFor(GENERATION, { archive: archiveRecord({ firstBingoRow: null }) })],
      [
        'an honour and a row naming different Players',
        flipFor(GENERATION, { archive: archiveRecord({ firstBingoRow: { ...ROW, uid: 'p2', rank: 1 } }) }),
      ],
      ['a held row ranked past the roster', flipFor(GENERATION, { archive: archiveRecord({ firstBingoRow: { ...ROW, rank: 2 } }) })],
      [
        'a held row carrying a NaN count',
        flipFor(GENERATION, { archive: archiveRecord({ firstBingoRow: { ...ROW, bingoCount: Number.NaN, rank: 1 } }) }),
      ],
      ['an honour with no instant', flipFor(GENERATION, { archive: archiveRecord({ firstBingo: { uid: 'p1', displayName: 'Pat' } }) })],
    ])('refuses %s before the first read', async (_why, flip) => {
      const { docs, reads, dependencies } = store(flagship());
      expect(await refusal(archiveInput({ flip }), dependencies)).toBe('archive-flip-invalid');
      expect(reads).toEqual([]);
      untouched(docs, quiescedEvent());
    });

    it.each([
      [
        'a record nobody bingoed in',
        archiveRecord({ standings: [], playerCount: 0, firstBingo: null, firstBingoRow: null, eventName: null }),
      ],
      [
        'a bounded prefix of a larger roster',
        archiveRecord({ standings: Array.from({ length: 200 }, () => ROW), playerCount: 250, freezeAt: 500 }),
      ],
      [
        'one honour for each of the most Days an Event has',
        archiveRecord({ dailyHonors: Array.from({ length: 20 }, (_, dayIndex) => HONOR(dayIndex)) }),
      ],
    ])('accepts %s', async (_why, archive) => {
      const { docs, dependencies } = store(flagship());
      await applyHostnameMutation(archiveInput({ flip: flipFor(GENERATION, { archive }) }), dependencies);
      expect(docs.get('events/bodega-bay-2026')).toMatchObject({ status: 'archived', archive });
    });

    // THE SECOND COPY, PINNED TO THE FIRST. This helper is a plain Node module
    // and cannot import the console's TypeScript validator, so the record's
    // bounds and per-entry questions are restated here, the way
    // `firestore.rules` restates them. What keeps the copies from drifting is
    // this table: every boundary is derived from the console's own constants,
    // and each case asserts the console's `writableArchiveRecord` AND this
    // intent agree on it. A change to `MAX_DAYS`, the standings bound, the
    // number bound or an entry predicate on either side fails here, and the
    // builder parity case below fails on a new `EventArchive` key.
    const honours = (count) => Array.from({ length: count }, (_, dayIndex) => HONOR(dayIndex));
    const prefix = (count) => Array.from({ length: count }, () => ROW);
    it.each([
      ['honours at the Day bound', archiveRecord({ dailyHonors: honours(MAX_DAYS) }), true],
      ['honours past the Day bound', archiveRecord({ dailyHonors: honours(MAX_DAYS + 1) }), false],
      [
        'the full standings prefix of a larger roster',
        archiveRecord({ standings: prefix(MAX_ARCHIVED_STANDING_ROWS), playerCount: MAX_ARCHIVED_STANDING_ROWS + 1 }),
        true,
      ],
      [
        'a standings prefix one row short of the bound',
        archiveRecord({ standings: prefix(MAX_ARCHIVED_STANDING_ROWS - 1), playerCount: MAX_ARCHIVED_STANDING_ROWS + 1 }),
        false,
      ],
      ['a freeze just inside the number bound', archiveRecord({ freezeAt: ARCHIVE_NUMBER_BOUND - 1 }), true],
      ['a freeze at the number bound', archiveRecord({ freezeAt: ARCHIVE_NUMBER_BOUND }), false],
      ['a negative freeze just inside the bound', archiveRecord({ freezeAt: -ARCHIVE_NUMBER_BOUND + 1 }), true],
      ['an honour instant at the number bound', archiveRecord({ dailyHonors: [{ ...HONOR(0), firstBingoAt: ARCHIVE_NUMBER_BOUND }] }), false],
      ['an empty honour', archiveRecord({ dailyHonors: [{}] }), false],
      ['an honour with an empty uid', archiveRecord({ dailyHonors: [{ ...HONOR(0), uid: '' }] }), false],
      ['honours out of Day order', archiveRecord({ dailyHonors: [HONOR(1), HONOR(0)] }), false],
      ['a held row ranked past the roster', archiveRecord({ firstBingoRow: { ...ROW, rank: 2 } }), false],
      ['a held row ranked zero', archiveRecord({ firstBingoRow: { ...ROW, rank: 0 } }), false],
      ['a held row with a non-boolean blackout', archiveRecord({ firstBingoRow: { ...ROW, blackout: 0, rank: 1 } }), false],
    ])('agrees with the console writer on %s', async (_why, archive, writable) => {
      expect(writableArchiveRecord(archive)).toBe(writable);
      const { docs, dependencies } = store(flagship());
      const input = archiveInput({ flip: flipFor(GENERATION, { archive }) });
      if (writable) {
        await applyHostnameMutation(input, dependencies);
        expect(docs.get('events/bodega-bay-2026').archive).toEqual(archive);
      } else {
        expect(await refusal(input, dependencies)).toBe('archive-flip-invalid');
        untouched(docs, quiescedEvent());
      }
    });

    // The record the application's own builder produces is one this helper
    // accepts: the operator command prepares the payload with it.
    it('accepts the record buildEventArchive produces', async () => {
      const player = (uid, bingoCount, firstBingoAt) => ({
        uid,
        displayName: uid.toUpperCase(),
        photoURL: null,
        joinedAt: 0,
        bingoCount,
        squaresMarked: 10 + bingoCount,
        firstBingoAt,
        reshufflesUsed: 0,
      });
      const day = (index) => ({
        index,
        date: `2026-07-${String(15 + index).padStart(2, '0')}`,
        place: 'Somewhere',
        placeEmoji: '🏖️',
        theme: 'neon-playground',
        tonight: [],
        pool: 'main',
        tutorial: false,
        unlockAt: 1000 * (index + 1),
      });
      const archive = buildEventArchive({
        players: [player('ana', 2, 900), player('bo', 1, 800), player('cy', 0, null)],
        event: { name: 'Bodega Bay', days: [day(0), day(1)], bannedUids: [] },
        dayMetas: new Map([
          [0, { firstBingo: { uid: 'bo', displayName: 'BO', at: 800 } }],
          [1, { firstBingo: { uid: 'ana', displayName: 'ANA', at: 900 } }],
        ]),
        dayMetasLoaded: true,
        archivedAt: ARCHIVED_AT,
      });
      expect(archive.firstBingo).not.toBeNull();
      // The builder's own honours, so the per-honour walk is exercised on the
      // shape the operator command will actually hand this intent.
      expect(archive.dailyHonors.map((honor) => honor.dayIndex)).toEqual([0, 1]);
      const { docs, dependencies } = store(flagship());
      await applyHostnameMutation(archiveInput({ flip: flipFor(GENERATION, { archive }) }), dependencies);
      expect(docs.get('events/bodega-bay-2026').archive).toEqual(archive);
    });

    it('plans the whole flip in a dry run and writes nothing', async () => {
      const { docs, dependencies } = store(flagship());
      const plan = await applyHostnameMutation(archiveInput({ apply: false }), dependencies);
      expect(plan.dryRun).toBe(true);
      expect(plan.writes).toContainEqual({
        op: 'update',
        path: 'events/bodega-bay-2026',
        value: {
          status: 'archived',
          archivedAt: ARCHIVED_AT,
          archivedUnder: GENERATION,
          archive: archiveRecord(),
          archiving: false,
        },
      });
      untouched(docs, quiescedEvent());
    });

    // A retry of an archive that already committed — an operator who lost the
    // answer, or the same payload sent twice — is refused by name and moves
    // nothing: the routing moved in the same commit as the flip, so there is
    // nothing left to repair and nothing the retry may restamp.
    it('answers a retry of a committed archive by name and writes nothing', async () => {
      const { docs, dependencies } = store(flagship());
      await applyHostnameMutation(archiveInput(), dependencies);
      const committed = cloneDocumentValue(Object.fromEntries(docs));
      expect(await refusal(archiveInput(), dependencies)).toBe('event-already-archived');
      expect(Object.fromEntries(docs)).toEqual(committed);
    });
  });
});

describe('delete', () => {
  it('refuses an active host and a revision the edge has not converged on', async () => {
    expect(
      await refusal(
        mutation({
          intent: 'delete',
          host: HOST,
          convergedRevision: '4',
          convergedDigest: edgeConverged(HOST, '4', hostnameDocument()).digest,
        }),
        store(converged(HOST, '4', hostnameDocument())).dependencies,
      ),
    ).toBe('delete-requires-inactive');
    expect(
      await refusal(
        mutation({
          intent: 'delete',
          host: HOST,
          convergedRevision: '3',
          convergedDigest: edgeConverged(HOST, '3', hostnameDocument({ status: 'disabled' })).digest,
        }),
        store(converged(HOST, '4', hostnameDocument({ status: 'disabled' }))).dependencies,
      ),
    ).toBe('delete-requires-convergence');
  });

  // Revision equality is satisfied by a POISONED object: the same revision
  // carrying a different and possibly still-serving payload, which is a state
  // the reconciler classifies and which equal-revision recovery can produce.
  // So the digest is what proves the edge stopped serving, and without it
  // this delete tombstones the source of a route the edge still answers.
  it('refuses a delete when the edge is poisoned at the converged revision', async () => {
    const document = hostnameDocument({ status: 'disabled' });
    const { docs, dependencies } = store(converged(HOST, '4', document));
    expect(
      await refusal(
        mutation({ intent: 'delete', host: HOST, convergedRevision: '4', convergedDigest: 'f'.repeat(64) }),
        dependencies,
      ),
    ).toBe('delete-requires-converged-payload');
    expect(docs.has(`hostnames/${HOST}`)).toBe(true);
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');

    // The digest the audit reports for the projection the ledger holds is the
    // one that lets it through.
    await applyHostnameMutation(
      mutation({
        intent: 'delete',
        host: HOST,
        convergedRevision: '4',
        convergedDigest: edgeConverged(HOST, '4', document).digest,
      }),
      dependencies,
    );
    expect(docs.has(`hostnames/${HOST}`)).toBe(false);
  });

  it('refuses a delete whose converged digest is missing or not a string', async () => {
    const { dependencies } = store(converged(HOST, '4', hostnameDocument({ status: 'disabled' })));
    for (const convergedDigest of [undefined, '', 7]) {
      expect(
        await refusal(mutation({ intent: 'delete', host: HOST, convergedRevision: '4', convergedDigest }), dependencies),
        String(convergedDigest),
      ).toBe('invalid-input');
    }
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
      await refusal(
        mutation({
          intent: 'delete',
          host: HOST,
          convergedRevision: '4',
          convergedDigest: edgeConverged(HOST, '4', archived).digest,
        }),
        dependencies,
      ),
    ).toBe('delete-apex-archive-target');
    expect(docs.has(`hostnames/${HOST}`)).toBe(true);
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('4');
    // The same archived route WITHOUT the flag is an ordinary retirement.
    const plain = store(converged(HOST, '4', hostnameDocument({ status: 'archived' })));
    await applyHostnameMutation(
      mutation({
        intent: 'delete',
        host: HOST,
        convergedRevision: '4',
        convergedDigest: edgeConverged(HOST, '4', hostnameDocument({ status: 'archived' })).digest,
      }),
      plain.dependencies,
    );
    expect(plain.docs.has(`hostnames/${HOST}`)).toBe(false);
  });

  it('refuses a serving root marker and accepts the non-serving one', async () => {
    // `root: 'doorway'` IS the live platform/Edition doorway, so it is as
    // serving as an active route even though a root marker has no `status`.
    const doorway = { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
    expect(
      await refusal(
        mutation({
          intent: 'delete',
          host: APEX,
          convergedRevision: '3',
          convergedDigest: edgeConverged(APEX, '3', doorway).digest,
        }),
        store(converged(APEX, '3', doorway)).dependencies,
      ),
    ).toBe('delete-requires-inactive');

    const marker = { root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
    const { docs, dependencies } = store(converged(MIRROR, '3', marker));
    await applyHostnameMutation(
      mutation({
        intent: 'delete',
        host: MIRROR,
        convergedRevision: '3',
        convergedDigest: edgeConverged(MIRROR, '3', marker).digest,
      }),
      dependencies,
    );
    expect(docs.has(`hostnames/${MIRROR}`)).toBe(false);
    expect(docs.get(`routerReplicas/${MIRROR}`)).toMatchObject({ revision: '4', desired: { kind: 'tombstone' } });
  });

  it('deletes the hostname and advances the ledger to a permanent tombstone', async () => {
    const { docs, dependencies } = store(converged(HOST, '4', hostnameDocument({ status: 'disabled' })));
    const plan = await applyHostnameMutation(
      mutation({
        intent: 'delete',
        host: HOST,
        convergedRevision: '4',
        convergedDigest: edgeConverged(HOST, '4', hostnameDocument({ status: 'disabled' })).digest,
      }),
      dependencies,
    );
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
    await applyHostnameMutation(
      mutation({
        intent: 'delete',
        host: HOST,
        convergedRevision: '4',
        convergedDigest: edgeConverged(HOST, '4', hostnameDocument({ status: 'disabled' })).digest,
      }),
      dependencies,
    );
    expect(
      await refusal(
        mutation({ intent: 'provision', host: HOST, hostname: { eventId: 'new', edition: 'fiveacross', slug: 'bodega-bay' } }),
        dependencies,
      ),
    ).toBe('tombstoned-address');
  });
});

describe('backfill and the explicit Admin ledger advance', () => {
  it('backfills a missing ledger at revision 1, normalizing the source and changing no projected value', async () => {
    const { docs, dependencies } = store({ [`hostnames/${HOST}`]: hostnameDocument() });
    const before = structuredClone(docs.get(`hostnames/${HOST}`));
    const plan = await applyHostnameMutation(mutation({ intent: 'backfill-ledger', host: HOST }), dependencies);
    expect(plan.revisions).toEqual([{ host: HOST, from: null, to: '1' }]);
    // The one write it makes to the public document is the absent-to-null
    // default the recovery consumer requires, in the same batch as the
    // ledger. No projected value moves.
    expect(docs.get(`hostnames/${HOST}`)).toEqual({ ...before, pathNamespace: null });
    expect(docs.get(`routerReplicas/${HOST}`).desired).toEqual(deriveCanonicalProjection(HOST, before));
  });

  // A repair is the FIRST edge publication for a legacy or partial-Admin
  // source, so it owes the same deployment barrier provision does: publishing
  // a capability here without it arms path routing before the
  // capability-aware Worker, the cache-schema bump and forced advancement
  // are. Both repair intents, because both publish whatever they find.
  it.each([
    ['backfill-ledger', (extra = {}) => mutation({ intent: 'backfill-ledger', host: APEX, ...extra })],
    [
      'advance-ledger',
      (extra = {}) =>
        mutation({
          intent: 'advance-ledger',
          host: APEX,
          durableObjectHighWaterRevision: '11',
          incidentUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/971',
          ...extra,
        }),
    ],
  ])('refuses %s on a capability-bearing source with no barrier, and accepts it with one', async (_intent, build) => {
    const marker = { root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' };
    const bare = store({ [`hostnames/${APEX}`]: marker });
    expect(await refusal(build(), bare.dependencies)).toBe('path-capability-barrier-required');
    expect(bare.docs.has(`routerReplicas/${APEX}`)).toBe(false);

    const stale = store({ [`hostnames/${APEX}`]: marker });
    expect(
      await refusal(build({ pathCapabilityBarrier: { ...BARRIER, resolutionCacheSchemaVersion: 0 } }), stale.dependencies),
    ).toBe('path-capability-barrier');

    const barriered = store({ [`hostnames/${APEX}`]: marker });
    await applyHostnameMutation(build({ pathCapabilityBarrier: BARRIER }), barriered.dependencies);
    expect(barriered.docs.get(`routerReplicas/${APEX}`).desired).toEqual({
      kind: 'root',
      root: 'not-found',
      edition: 'vacay',
      pathNamespace: 'vacaybingo.com',
    });
  });

  // A repair publishes whatever source it finds, so the host-class rules hold
  // there too: a partial Admin write must not reach the edge as a mirror
  // doorway or a root-host route under another Edition.
  it.each([
    ['backfill-ledger', {}],
    ['advance-ledger', { durableObjectHighWaterRevision: '11', incidentUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/971' }],
  ])('refuses %s on a mirror doorway or a mis-editioned mirror route', async (intent, extra) => {
    const sources = [
      { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' },
      hostnameDocument({ status: 'disabled', edition: 'gcb', pathNamespace: 'vacaybingo.com' }),
    ];
    for (const source of sources) {
      const seeded = store({ [`hostnames/${MIRROR}`]: source });
      const expected = Object.hasOwn(source, 'root') ? 'root-marker-ineligible' : 'host-scoped-field';
      expect(
        await refusal(mutation({ intent, host: MIRROR, pathCapabilityBarrier: BARRIER, ...extra }), seeded.dependencies),
      ).toBe(expected);
      expect(seeded.docs.has(`routerReplicas/${MIRROR}`)).toBe(false);
    }
  });

  // An Event subdomain projects `pathNamespace: null`, so a repair on one
  // needs no barrier at all: there is no capability to publish.
  it('needs no barrier to repair a source that carries no capability', async () => {
    const { docs, dependencies } = store({ [`hostnames/${HOST}`]: hostnameDocument() });
    await applyHostnameMutation(mutation({ intent: 'backfill-ledger', host: HOST }), dependencies);
    expect(docs.get(`routerReplicas/${HOST}`).revision).toBe('1');
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
    expect(docs.get(`hostnames/${HOST}`)).toEqual({ ...hostnameDocument(), pathNamespace: null });
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
      [`routerReplicas/${HOST}`]: { schemaVersion: 1, revision: '4', host: HOST, desired: { kind: 'route' }, updatedAt: NOW_STAMP },
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
      [`routerReplicas/${HOST}`]: { schemaVersion: 1, revision: '5', host: HOST, desired: { kind: 'tombstone' }, updatedAt: NOW_STAMP },
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
    const tombstone = { schemaVersion: 1, revision: '5', host: HOST, desired: { kind: 'tombstone' }, updatedAt: NOW_STAMP };
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
      updatedAt: NOW_STAMP,
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
