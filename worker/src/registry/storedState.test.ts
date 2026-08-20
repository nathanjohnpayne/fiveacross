// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyPublisherSync, initialRegistryState } from './state';
import { parseStoredRegistryState } from './storedState';
import type { RouterReplicaDesired } from './contracts';

const PAYLOAD: RouterReplicaDesired = {
  schemaVersion: 1,
  revision: '1',
  host: 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
  desired: {
    kind: 'route',
    eventId: 'synthetic',
    status: 'disabled',
    slug: 'r2-abcdefghijklmnopqrstuvwxyz',
    edition: 'fiveacross',
    pathNamespace: null,
  },
  updatedAt: '2026-08-19T12:34:56.000Z',
};

describe('persisted registry state validation', () => {
  it('round-trips an exact state and committed digest', async () => {
    const state = (await applyPublisherSync(initialRegistryState(), PAYLOAD, '1')).state;
    await expect(parseStoredRegistryState(state)).resolves.toEqual(state);
  });

  it.each([
    ['extra top-level field', (state: Record<string, unknown>) => ({ ...state, injected: true })],
    ['malformed epoch', (state: Record<string, unknown>) => ({ ...state, minimumPublisherEpoch: '01' })],
    ['wrong payload revision', (state: Record<string, unknown>) => ({ ...state, committed: { ...(state.committed as object), payload: { ...((state.committed as { payload: object }).payload), revision: '2' } } })],
    ['wrong digest', (state: Record<string, unknown>) => ({ ...state, committed: { ...(state.committed as object), digest: '0'.repeat(64) } })],
  ])('fails closed on %s', async (_label, mutate) => {
    const state = (await applyPublisherSync(initialRegistryState(), PAYLOAD, '1')).state;
    await expect(parseStoredRegistryState(mutate(state as unknown as Record<string, unknown>))).rejects.toThrow(
      'registry state malformed',
    );
  });

  it.each([
    ['equal to', '7'],
    ['above', '8'],
  ])('fails closed when the quarantined publisher epoch is %s the minimum epoch', async (_label, quarantined) => {
    const state = {
      ...(await applyPublisherSync(initialRegistryState(), PAYLOAD, '1')).state,
      minimumPublisherEpoch: '7',
      highestQuarantinedPublisherEpoch: quarantined,
    };

    await expect(parseStoredRegistryState(state)).rejects.toThrow('registry state malformed');
  });
});
