// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyPublisherSync, initialRegistryState, registryLookup } from './state';
import type { RegistryState, RouterReplicaDesired } from './contracts';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';

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
    expect(result.state.committed).toMatchObject({ revision: '1', payload: desired('1') });
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
    expect(conflict.response).toEqual({ status: 409, result: 'revision-conflict' });
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
    expect(result.response).toEqual({ status: 401, result: 'publisher-epoch-rejected' });
    expect(result.state).toEqual(state);
  });

  it('makes a tombstone permanent', async () => {
    const tombstone = { ...desired('1'), desired: { kind: 'tombstone' } as const };
    const first = await applyPublisherSync(initialRegistryState(), tombstone, '1');
    const result = await applyPublisherSync(first.state, desired('2'), '1');
    expect(result.response).toEqual({ status: 409, result: 'tombstone-final' });
    expect(result.state.committed?.payload.desired).toEqual({ kind: 'tombstone' });
  });

  it('returns only point lookup state and fails closed while recovery is locked', async () => {
    const first = await applyPublisherSync(initialRegistryState(), desired('1'), '1');
    expect(registryLookup(first.state)).toEqual({
      kind: 'committed',
      revision: '1',
      desired: desired('1').desired,
    });
    expect(registryLookup(locked(first.state))).toEqual({ kind: 'unavailable' });
    expect(registryLookup(initialRegistryState())).toEqual({ kind: 'unknown-host' });
  });
});
