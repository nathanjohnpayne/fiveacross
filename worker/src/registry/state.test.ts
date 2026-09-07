// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyPublisherSync, initialRegistryState, registryLookup } from './state';
import type { RegistryState, ReplicaDesired, RouterReplicaDesired } from './contracts';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const ROOT_TEST_HOST = `r2-root-${'e'.repeat(20)}.fiveacross.app`;

function desired(revision: string, eventId = 'synthetic-event'): RouterReplicaDesired {
  return {
    schemaVersion: 1,
    revision,
    host: HOST,
    desired: {
      kind: 'route',
      eventId,
      status: 'disabled',
      slug: 'r2-abcdefghijklmnopqrstuvwxyz',
      edition: 'fiveacross',
      pathNamespace: null,
    },
    updatedAt: '2026-08-19T12:34:56.000Z',
  };
}

function locked(state: RegistryState): RegistryState {
  return {
    ...state,
    recoveryLock: {
      lockId: 'lock-1',
      acquiredAt: '2026-08-19T12:35:00.000Z',
      expectedCommitted: state.committed
        ? { revision: state.committed.revision, digest: state.committed.digest }
        : null,
      operatorSub: '2002',
      incidentUrl: 'https://example.com/incidents/1',
      reason: 'publisher integrity incident',
    },
  };
}

describe('per-host contiguous publisher state', () => {
  it('accepts revision 1 into an uninitialized object', async () => {
    const result = await applyPublisherSync(initialRegistryState(), desired('1'), '1');
    expect(result.response).toEqual({ status: 200, result: 'applied' });
    expect(result.state.committed).toMatchObject({
      revision: '1',
      payload: desired('1'),
    });
    expect(result.state.highestAuthenticatedPublisherEpoch).toBe('1');
  });

  it('handles successor, replay, stale, conflict, and gap without precision loss', async () => {
    const first = await applyPublisherSync(initialRegistryState(), desired('1'), '1');
    const successor = await applyPublisherSync(first.state, desired('2'), '1');
    expect(successor.response).toEqual({ status: 200, result: 'applied' });

    const replay = await applyPublisherSync(successor.state, desired('2'), '1');
    expect(replay.response).toEqual({ status: 200, result: 'replay' });

    const stale = await applyPublisherSync(replay.state, desired('1'), '1');
    expect(stale.response).toEqual({ status: 200, result: 'ignored-stale' });

    const conflict = await applyPublisherSync(stale.state, desired('2', 'poisoned'), '4');
    expect(conflict.response).toEqual({
      status: 409,
      result: 'revision-conflict',
    });
    expect(conflict.state.committed).toEqual(successor.state.committed);
    expect(conflict.state.highestAuthenticatedPublisherEpoch).toBe('4');

    const gap = await applyPublisherSync(conflict.state, desired('900719925474099312345'), '5');
    expect(gap.response).toEqual({ status: 409, result: 'revision-gap' });
    expect(gap.state.committed).toEqual(successor.state.committed);
    expect(gap.state.highestAuthenticatedPublisherEpoch).toBe('5');
  });

  it('raises the authenticated epoch even when a recovery lock rejects the revision', async () => {
    const first = await applyPublisherSync(initialRegistryState(), desired('1'), '1');
    const result = await applyPublisherSync(locked(first.state), desired('2'), '7');
    expect(result.response).toEqual({ status: 503, result: 'recovery-locked' });
    expect(result.state.committed).toEqual(first.state.committed);
    expect(result.state.highestAuthenticatedPublisherEpoch).toBe('7');
  });

  it('fences epochs below the recovery floor before applying a payload', async () => {
    const state = { ...initialRegistryState(), minimumPublisherEpoch: '8' };
    const result = await applyPublisherSync(state, desired('1'), '7');
    expect(result.response).toEqual({
      status: 401,
      result: 'publisher-epoch-rejected',
    });
    expect(result.state).toEqual(state);
  });

  it('makes a tombstone permanent', async () => {
    const tombstone = {
      ...desired('1'),
      desired: { kind: 'tombstone' } as const,
    };
    const first = await applyPublisherSync(initialRegistryState(), tombstone, '1');
    const result = await applyPublisherSync(first.state, desired('2'), '1');
    expect(result.response).toEqual({ status: 409, result: 'tombstone-final' });
    expect(result.state.committed?.payload.desired).toEqual({
      kind: 'tombstone',
    });
  });

  it('keeps the committed lookup readable while the lock fences publisher mutation', async () => {
    const first = await applyPublisherSync(initialRegistryState(), desired('1'), '1');
    expect(registryLookup(first.state)).toEqual({
      kind: 'committed',
      schemaVersion: 1,
      revision: '1',
      desired: desired('1').desired,
    });
    expect(registryLookup(locked(first.state))).toEqual({
      kind: 'committed',
      schemaVersion: 1,
      revision: '1',
      desired: desired('1').desired,
    });
    expect(registryLookup(initialRegistryState())).toEqual({
      kind: 'unknown-host',
    });
  });

  it('reports a tombstone as unknown but keeps the revision recovery has to observe', async () => {
    // The projection is withheld — a deleted address must not advertise that
    // it ever named an Event — but the revision is not. The spec's own threat
    // model calls individual replica revisions public metadata, and
    // `clear-lock` consumes three public attestations "whose host/result/
    // revision equal committed state", which a tombstoned host could never
    // produce if its public answer carried no revision.
    const tombstone = {
      ...desired('1'),
      revision: '4',
      desired: { kind: 'tombstone' } as const,
    };
    const applied = await applyPublisherSync(initialRegistryState(), { ...desired('1') }, '1');
    const deleted = await applyPublisherSync(applied.state, { ...tombstone, revision: '2' }, '1');
    expect(deleted.response).toEqual({ status: 200, result: 'applied' });
    expect(registryLookup(deleted.state)).toEqual({
      kind: 'unknown-host',
      revision: '2',
      schemaVersion: 1,
    });
  });

  it('carries the committed schema version on every shape the router interprets', async () => {
    // The registry is a separately deployed Worker, so the version a record was
    // COMMITTED under is the only thing that tells a router on the far side of
    // the service binding whether it may read the record at all. An additive v2
    // that kept today's discriminants would otherwise arrive looking exactly
    // like a v1 route. The version therefore travels with every arm derived
    // from a committed record — the active and inactive route, the root marker,
    // and the tombstone whose revision the router publishes — which is what
    // lets `worker/src/resolve.ts` refuse an unsupported one BEFORE reading
    // `desired` (`specs/event-router-registry.md` § Failure semantics,
    // "malformed/unsupported committed state").
    const route = (status: 'active' | 'disabled'): ReplicaDesired => ({
      kind: 'route',
      eventId: 'synthetic-event',
      status,
      slug: 'r2-abcdefghijklmnopqrstuvwxyz',
      edition: 'fiveacross',
      pathNamespace: null,
    });
    const root: ReplicaDesired = {
      kind: 'root',
      root: 'doorway',
      edition: 'fiveacross',
      pathNamespace: null,
    };

    for (const [label, host, shape] of [
      ['active route', HOST, route('active')],
      ['inactive route', HOST, route('disabled')],
      ['root marker', ROOT_TEST_HOST, root],
    ] as const) {
      const applied = await applyPublisherSync(
        initialRegistryState(),
        { ...desired('1'), host, desired: shape },
        '1',
      );
      expect(applied.response, label).toEqual({ status: 200, result: 'applied' });
      expect(registryLookup(applied.state), label).toEqual({
        kind: 'committed',
        schemaVersion: 1,
        revision: '1',
        desired: shape,
      });
    }

    const tombstoned = await applyPublisherSync(
      initialRegistryState(),
      { ...desired('1'), desired: { kind: 'tombstone' } },
      '1',
    );
    expect(registryLookup(tombstoned.state)).toEqual({
      kind: 'unknown-host',
      revision: '1',
      schemaVersion: 1,
    });

    // An uninitialized object has no committed record, so it stamps no version
    // and the router reads the same plain `unknown-host` it always did.
    expect(registryLookup(initialRegistryState())).toEqual({ kind: 'unknown-host' });
  });
});
