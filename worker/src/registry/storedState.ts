import { parseSyncRequest, projectionDigest, type RegistryState } from './contracts';

const POSITIVE = /^[1-9]\d*$/;
const NON_NEGATIVE = /^(?:0|[1-9]\d*)$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validCommittedRef(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      exactKeys(value, ['revision', 'digest']) &&
      typeof value.revision === 'string' &&
      POSITIVE.test(value.revision) &&
      typeof value.digest === 'string' &&
      SHA256_HEX.test(value.digest))
  );
}

export async function parseStoredRegistryState(value: unknown, expectedHost: string): Promise<RegistryState> {
  try {
    if (
      !isRecord(value) ||
      !exactKeys(value, [
        'committed',
        'minimumPublisherEpoch',
        'highestAuthenticatedPublisherEpoch',
        'highestQuarantinedPublisherEpoch',
        'recoveryLock',
        'recoverySequence',
      ]) ||
      typeof value.minimumPublisherEpoch !== 'string' ||
      !POSITIVE.test(value.minimumPublisherEpoch) ||
      typeof value.highestAuthenticatedPublisherEpoch !== 'string' ||
      !NON_NEGATIVE.test(value.highestAuthenticatedPublisherEpoch) ||
      typeof value.highestQuarantinedPublisherEpoch !== 'string' ||
      !NON_NEGATIVE.test(value.highestQuarantinedPublisherEpoch) ||
      typeof value.recoverySequence !== 'string' ||
      !NON_NEGATIVE.test(value.recoverySequence)
    ) {
      throw new Error('shape');
    }

    if (value.committed !== null) {
      if (
        !isRecord(value.committed) ||
        !exactKeys(value.committed, ['revision', 'digest', 'payload']) ||
        typeof value.committed.revision !== 'string' ||
        !POSITIVE.test(value.committed.revision) ||
        typeof value.committed.digest !== 'string' ||
        !SHA256_HEX.test(value.committed.digest)
      ) {
        throw new Error('committed');
      }
      const payload = parseSyncRequest(JSON.stringify(value.committed.payload), 'application/json');
      if (
        payload.host !== expectedHost ||
        payload.revision !== value.committed.revision ||
        (await projectionDigest(payload)) !== value.committed.digest
      ) {
        throw new Error('committed digest');
      }
    }

    if (
      BigInt(value.highestQuarantinedPublisherEpoch) > 0n &&
      BigInt(value.highestQuarantinedPublisherEpoch) >= BigInt(value.minimumPublisherEpoch)
    ) {
      throw new Error('quarantined publisher epoch is not fenced');
    }

    if (value.recoveryLock !== null) {
      if (
        !isRecord(value.recoveryLock) ||
        !exactKeys(value.recoveryLock, [
          'lockId',
          'acquiredAt',
          'expectedCommitted',
          'operatorSub',
          'incidentUrl',
          'reason',
        ]) ||
        typeof value.recoveryLock.lockId !== 'string' ||
        value.recoveryLock.lockId.length === 0 ||
        typeof value.recoveryLock.acquiredAt !== 'string' ||
        !Number.isFinite(Date.parse(value.recoveryLock.acquiredAt)) ||
        !validCommittedRef(value.recoveryLock.expectedCommitted) ||
        typeof value.recoveryLock.operatorSub !== 'string' ||
        value.recoveryLock.operatorSub.length === 0 ||
        typeof value.recoveryLock.incidentUrl !== 'string' ||
        new URL(value.recoveryLock.incidentUrl).protocol !== 'https:' ||
        typeof value.recoveryLock.reason !== 'string' ||
        value.recoveryLock.reason.length === 0
      ) {
        throw new Error('lock');
      }
    }
    return value as unknown as RegistryState;
  } catch {
    throw new Error('registry state malformed');
  }
}
