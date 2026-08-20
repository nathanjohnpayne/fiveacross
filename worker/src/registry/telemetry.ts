import { classifyHost, normalizeHost } from '../host';
import { isRegistryRootHost, isSyntheticRegistryHost } from './contracts';
import type { RecoveryRequest } from './recovery';
import type { SyncResult } from './state';

export type RegistrySemanticOutcome =
  | 'applied'
  | 'replay'
  | 'ignored-stale'
  | 'gap'
  | 'conflict'
  | 'recovery-locked'
  | 'publisher-epoch-rejected'
  | 'tombstone-final'
  | 'recovered'
  | 'empty-object';

export type RegistrySemanticEvent = Readonly<{
  schemaVersion: 1;
  event: 'event-router-registry.semantic';
  operation: 'sync' | 'recovery' | 'lookup';
  outcome: RegistrySemanticOutcome;
  registryVersion: string;
  host: string;
  revision: string | null;
  latencyMs: number;
  gapAgeMs: number | null;
  keyVersion: string | null;
  recoveryAction: RecoveryRequest['action']['kind'] | null;
}>;

type SemanticLogger = (event: RegistrySemanticEvent) => void;

const REGISTRY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const KMS_KEY_VERSION =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/;

export function isRegistryTelemetryVersion(value: unknown): value is string {
  return typeof value === 'string' && REGISTRY_VERSION.test(value);
}

const SYNC_OUTCOMES: Readonly<Record<SyncResult, RegistrySemanticOutcome>> = Object.freeze({
  applied: 'applied',
  replay: 'replay',
  'ignored-stale': 'ignored-stale',
  'revision-gap': 'gap',
  'revision-conflict': 'conflict',
  'recovery-locked': 'recovery-locked',
  'publisher-epoch-rejected': 'publisher-epoch-rejected',
  'tombstone-final': 'tombstone-final',
});

function requireCommon(args: {
  registryVersion: string;
  host: string;
  revision: string | null;
  startedAt: number;
  finishedAt: number;
  keyVersion: string | null;
}): { latencyMs: number } {
  if (!isRegistryTelemetryVersion(args.registryVersion)) throw new Error('invalid registry telemetry version');
  const classified = classifyHost(args.host);
  if (
    args.host !== normalizeHost(args.host) ||
    (classified.kind === 'rejected' && !isSyntheticRegistryHost(args.host) && !isRegistryRootHost(args.host))
  ) {
    throw new Error('invalid registry telemetry host');
  }
  if (args.revision !== null && !POSITIVE_DECIMAL.test(args.revision)) {
    throw new Error('invalid registry telemetry revision');
  }
  if (
    !Number.isSafeInteger(args.startedAt) ||
    !Number.isSafeInteger(args.finishedAt) ||
    args.startedAt < 0 ||
    args.finishedAt < args.startedAt
  ) {
    throw new Error('invalid registry telemetry timing');
  }
  if (args.keyVersion !== null && !KMS_KEY_VERSION.test(args.keyVersion)) {
    throw new Error('invalid registry telemetry key version');
  }
  return { latencyMs: args.finishedAt - args.startedAt };
}

export function createSyncSemanticEvent(args: {
  registryVersion: string;
  host: string;
  revision: string;
  result: SyncResult;
  updatedAt: string;
  keyVersion: string;
  startedAt: number;
  finishedAt: number;
}): RegistrySemanticEvent {
  const { latencyMs } = requireCommon(args);
  const updatedAt = Date.parse(args.updatedAt);
  if (!Number.isFinite(updatedAt)) throw new Error('invalid registry telemetry desired-state time');
  const outcome = SYNC_OUTCOMES[args.result];
  const gapAgeMs = outcome === 'gap' ? Math.max(0, args.finishedAt - updatedAt) : null;
  if (gapAgeMs !== null && !Number.isSafeInteger(gapAgeMs)) {
    throw new Error('invalid registry telemetry gap age');
  }

  return Object.freeze({
    schemaVersion: 1,
    event: 'event-router-registry.semantic',
    operation: 'sync',
    outcome,
    registryVersion: args.registryVersion,
    host: args.host,
    revision: args.revision,
    latencyMs,
    gapAgeMs,
    keyVersion: args.keyVersion,
    recoveryAction: null,
  });
}

export function createRecoverySemanticEvent(args: {
  registryVersion: string;
  host: string;
  revision: string;
  recoveryAction: RecoveryRequest['action']['kind'];
  keyVersion: string;
  startedAt: number;
  finishedAt: number;
}): RegistrySemanticEvent {
  const { latencyMs } = requireCommon(args);
  return Object.freeze({
    schemaVersion: 1,
    event: 'event-router-registry.semantic',
    operation: 'recovery',
    outcome: 'recovered',
    registryVersion: args.registryVersion,
    host: args.host,
    revision: args.revision,
    latencyMs,
    gapAgeMs: null,
    keyVersion: args.keyVersion,
    recoveryAction: args.recoveryAction,
  });
}

export function createCardinalitySemanticEvent(args: {
  registryVersion: string;
  host: string;
  startedAt: number;
  finishedAt: number;
}): RegistrySemanticEvent {
  const { latencyMs } = requireCommon({ ...args, revision: null, keyVersion: null });
  return Object.freeze({
    schemaVersion: 1,
    event: 'event-router-registry.semantic',
    operation: 'lookup',
    outcome: 'empty-object',
    registryVersion: args.registryVersion,
    host: args.host,
    revision: null,
    latencyMs,
    gapAgeMs: null,
    keyVersion: null,
    recoveryAction: null,
  });
}

export function emitRegistrySemanticEvent(
  event: RegistrySemanticEvent,
  logger: SemanticLogger = (entry) => console.log(entry),
): void {
  logger(event);
}
