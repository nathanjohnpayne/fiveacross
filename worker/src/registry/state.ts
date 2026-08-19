import {
  projectionDigest,
  type RegistryState,
  type ReplicaDesired,
  type RouterReplicaDesired,
} from './contracts';

export type SyncResult =
  | 'applied'
  | 'replay'
  | 'ignored-stale'
  | 'revision-conflict'
  | 'revision-gap'
  | 'recovery-locked'
  | 'publisher-epoch-rejected'
  | 'tombstone-final';

export type SyncResponse = { status: 200 | 401 | 409 | 503; result: SyncResult };

export type RegistryLookup =
  | { kind: 'unknown-host' }
  | { kind: 'unavailable' }
  | { kind: 'committed'; revision: string; desired: ReplicaDesired };

const CANONICAL_NON_NEGATIVE = /^(?:0|[1-9]\d*)$/;
const CANONICAL_POSITIVE = /^[1-9]\d*$/;

export function initialRegistryState(): RegistryState {
  return {
    committed: null,
    minimumPublisherEpoch: '1',
    highestAuthenticatedPublisherEpoch: '0',
    highestQuarantinedPublisherEpoch: '0',
    recoveryLock: null,
    recoverySequence: '0',
  };
}

function maxDecimal(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right;
}

export async function applyPublisherSync(
  current: RegistryState,
  payload: RouterReplicaDesired,
  publisherEpoch: string,
): Promise<{ state: RegistryState; response: SyncResponse }> {
  if (!CANONICAL_POSITIVE.test(publisherEpoch)) {
    return { state: current, response: { status: 401, result: 'publisher-epoch-rejected' } };
  }
  if (!CANONICAL_POSITIVE.test(current.minimumPublisherEpoch)) {
    throw new Error('stored minimumPublisherEpoch is malformed');
  }
  if (!CANONICAL_NON_NEGATIVE.test(current.highestAuthenticatedPublisherEpoch)) {
    throw new Error('stored highestAuthenticatedPublisherEpoch is malformed');
  }
  if (BigInt(publisherEpoch) < BigInt(current.minimumPublisherEpoch)) {
    return { state: current, response: { status: 401, result: 'publisher-epoch-rejected' } };
  }

  const authenticatedState: RegistryState = {
    ...current,
    highestAuthenticatedPublisherEpoch: maxDecimal(
      current.highestAuthenticatedPublisherEpoch,
      publisherEpoch,
    ),
  };
  if (authenticatedState.recoveryLock !== null) {
    return {
      state: authenticatedState,
      response: { status: 503, result: 'recovery-locked' },
    };
  }

  const digest = await projectionDigest(payload);
  const committed = authenticatedState.committed;
  const incomingRevision = BigInt(payload.revision);

  if (committed === null) {
    if (incomingRevision !== 1n) {
      return {
        state: authenticatedState,
        response: { status: 409, result: 'revision-gap' },
      };
    }
  } else {
    const storedRevision = BigInt(committed.revision);
    if (incomingRevision < storedRevision) {
      return {
        state: authenticatedState,
        response: { status: 200, result: 'ignored-stale' },
      };
    }
    if (incomingRevision === storedRevision) {
      return digest === committed.digest
        ? { state: authenticatedState, response: { status: 200, result: 'replay' } }
        : {
            state: authenticatedState,
            response: { status: 409, result: 'revision-conflict' },
          };
    }
    if (committed.payload.desired.kind === 'tombstone') {
      return {
        state: authenticatedState,
        response: { status: 409, result: 'tombstone-final' },
      };
    }
    if (incomingRevision !== storedRevision + 1n) {
      return {
        state: authenticatedState,
        response: { status: 409, result: 'revision-gap' },
      };
    }
  }

  return {
    state: {
      ...authenticatedState,
      committed: { revision: payload.revision, digest, payload },
    },
    response: { status: 200, result: 'applied' },
  };
}

export function registryLookup(state: RegistryState): RegistryLookup {
  if (state.recoveryLock !== null) return { kind: 'unavailable' };
  if (state.committed === null || state.committed.payload.desired.kind === 'tombstone') {
    return { kind: 'unknown-host' };
  }
  return {
    kind: 'committed',
    revision: state.committed.revision,
    desired: state.committed.payload.desired,
  };
}
