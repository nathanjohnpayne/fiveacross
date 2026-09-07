import { projectionDigest, type RegistryState, type ReplicaDesired, type RouterReplicaDesired } from './contracts';

export type SyncResult =
  | 'applied'
  | 'replay'
  | 'ignored-stale'
  | 'revision-conflict'
  | 'revision-gap'
  | 'recovery-locked'
  | 'publisher-epoch-rejected'
  | 'tombstone-final';

export type SyncResponse = {
  status: 200 | 401 | 409 | 503;
  result: SyncResult;
};

/**
 * The whole result surface the public router is given.
 *
 * `malformed` is distinct from `unavailable` for the same reason the failure
 * table in `specs/event-router-registry.md` separates them: a projection this
 * object cannot parse is a standing data fact that alerts and will not heal on
 * a retry, whereas an unavailable object is usually transient. Collapsing them
 * would turn a diagnosable replica defect into a mystery outage. Both fail
 * closed, and neither reaches for a second source of truth.
 */
export type RegistryLookup =
  | { kind: 'unknown-host' }
  | { kind: 'unavailable' }
  | { kind: 'malformed' }
  | { kind: 'committed'; revision: string; desired: ReplicaDesired };

/**
 * The ONLY registry capability the public router holds, declared here — beside
 * the result it returns and free of every Cloudflare type — rather than beside
 * the Worker that implements it. `RegistryLookupEntrypoint` implements it, and
 * `worker/src/resolve.ts` consumes it, so the router's decision modules depend
 * on the shape of one method instead of on the registry Worker's module graph.
 */
export interface RegistryLookupService {
  lookup(host: string): Promise<RegistryLookup>;
}

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
    return {
      state: current,
      response: { status: 401, result: 'publisher-epoch-rejected' },
    };
  }
  if (!CANONICAL_POSITIVE.test(current.minimumPublisherEpoch)) {
    throw new Error('stored minimumPublisherEpoch is malformed');
  }
  if (!CANONICAL_NON_NEGATIVE.test(current.highestAuthenticatedPublisherEpoch)) {
    throw new Error('stored highestAuthenticatedPublisherEpoch is malformed');
  }
  if (BigInt(publisherEpoch) < BigInt(current.minimumPublisherEpoch)) {
    return {
      state: current,
      response: { status: 401, result: 'publisher-epoch-rejected' },
    };
  }

  const authenticatedState: RegistryState = {
    ...current,
    highestAuthenticatedPublisherEpoch: maxDecimal(current.highestAuthenticatedPublisherEpoch, publisherEpoch),
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
        ? {
            state: authenticatedState,
            response: { status: 200, result: 'replay' },
          }
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

/**
 * A pure projection of already-parsed state, so its result is narrower than the
 * seam's: `unavailable` and `malformed` describe reaching or reading the object
 * and cannot arise from a state this function was handed.
 */
export function registryLookup(
  state: RegistryState,
): Extract<RegistryLookup, { kind: 'unknown-host' } | { kind: 'committed' }> {
  if (state.committed === null || state.committed.payload.desired.kind === 'tombstone') {
    return { kind: 'unknown-host' };
  }
  return {
    kind: 'committed',
    revision: state.committed.revision,
    desired: state.committed.payload.desired,
  };
}
