// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createCardinalitySemanticEvent,
  createRecoverySemanticEvent,
  createSyncSemanticEvent,
  emitRegistrySemanticEvent,
} from './telemetry';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const KEY_VERSION =
  'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher/cryptoKeyVersions/7';

describe('registry semantic telemetry', () => {
  it('maps sync results to closed outcomes and computes rejected gap age from desired-state time', () => {
    expect(
      createSyncSemanticEvent({
        registryVersion: 'v1',
        host: HOST,
        revision: '9',
        result: 'revision-gap',
        updatedAt: '2026-08-19T12:00:00.000Z',
        keyVersion: KEY_VERSION,
        startedAt: Date.parse('2026-08-19T12:05:59.950Z'),
        finishedAt: Date.parse('2026-08-19T12:06:00.000Z'),
      }),
    ).toEqual({
      schemaVersion: 1,
      event: 'event-router-registry.semantic',
      operation: 'sync',
      outcome: 'gap',
      registryVersion: 'v1',
      host: HOST,
      revision: '9',
      latencyMs: 50,
      gapAgeMs: 360_000,
      keyVersion: KEY_VERSION,
      recoveryAction: null,
    });

    expect(
      createSyncSemanticEvent({
        registryVersion: 'v1',
        host: HOST,
        revision: '8',
        result: 'revision-conflict',
        updatedAt: '2026-08-19T12:00:00.000Z',
        keyVersion: KEY_VERSION,
        startedAt: 100,
        finishedAt: 101,
      }).outcome,
    ).toBe('conflict');
  });

  it('records recovery, lock, and empty-object cardinality as distinct closed outcomes', () => {
    const locked = createSyncSemanticEvent({
      registryVersion: 'v1',
      host: HOST,
      revision: '10',
      result: 'recovery-locked',
      updatedAt: '2026-08-19T12:00:00.000Z',
      keyVersion: KEY_VERSION,
      startedAt: 100,
      finishedAt: 110,
    });
    const recovered = createRecoverySemanticEvent({
      registryVersion: 'v1',
      host: HOST,
      revision: '10',
      recoveryAction: 'apply',
      keyVersion: KEY_VERSION,
      startedAt: 200,
      finishedAt: 225,
    });
    const empty = createCardinalitySemanticEvent({
      registryVersion: 'v1',
      host: HOST,
      startedAt: 300,
      finishedAt: 303,
    });

    expect(locked).toMatchObject({ operation: 'sync', outcome: 'recovery-locked', gapAgeMs: null });
    expect(recovered).toMatchObject({
      operation: 'recovery',
      outcome: 'recovered',
      revision: '10',
      latencyMs: 25,
      recoveryAction: 'apply',
    });
    expect(empty).toMatchObject({
      operation: 'lookup',
      outcome: 'empty-object',
      revision: null,
      latencyMs: 3,
    });
  });

  it('admits canonical serving hosts so empty-object cardinality covers random valid-host floods', () => {
    expect(
      createCardinalitySemanticEvent({
        registryVersion: 'v1',
        host: 'random-valid-label.fiveacross.app',
        startedAt: 300,
        finishedAt: 303,
      }),
    ).toMatchObject({ outcome: 'empty-object', host: 'random-valid-label.fiveacross.app' });
  });

  it('emits only the sanitized closed event and never caller extras', () => {
    const logger = vi.fn();
    const event = createSyncSemanticEvent({
      registryVersion: 'v1',
      host: HOST,
      revision: '1',
      result: 'applied',
      updatedAt: '2026-08-19T12:00:00.000Z',
      keyVersion: KEY_VERSION,
      startedAt: 100,
      finishedAt: 105,
      authorization: 'Bearer stolen-token',
      signature: 'sensitive-signature',
      requestBody: '{"eventId":"must-not-log"}',
    } as Parameters<typeof createSyncSemanticEvent>[0] & Record<string, unknown>);

    emitRegistrySemanticEvent(event, logger);
    expect(logger).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith(event);
    expect(JSON.stringify(logger.mock.calls[0][0])).not.toMatch(/stolen-token|sensitive-signature|eventId|requestBody/);
    expect(Object.keys(event)).toEqual([
      'schemaVersion',
      'event',
      'operation',
      'outcome',
      'registryVersion',
      'host',
      'revision',
      'latencyMs',
      'gapAgeMs',
      'keyVersion',
      'recoveryAction',
    ]);
  });

  it.each([
    ['out-of-namespace host', { host: 'not-five-across.example.com' }],
    ['unsafe version', { registryVersion: 'v1\ntoken=secret' }],
    ['non-canonical revision', { revision: '01' }],
    ['negative latency', { startedAt: 101, finishedAt: 100 }],
    ['non-KMS key version', { keyVersion: 'secret-key-alias' }],
  ])('fails closed on %s', (_label, override) => {
    expect(() =>
      createSyncSemanticEvent({
        registryVersion: 'v1',
        host: HOST,
        revision: '1',
        result: 'applied',
        updatedAt: '2026-08-19T12:00:00.000Z',
        keyVersion: KEY_VERSION,
        startedAt: 100,
        finishedAt: 101,
        ...override,
      }),
    ).toThrow();
  });
});
