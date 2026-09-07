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
  /** No servable address here. `revision` and `schemaVersion` are present only
   *  for a TOMBSTONE — a committed record that reads as unknown from outside
   *  but still has a revision the public response must carry, because
   *  `specs/event-router-registry.md` § Audit and recovery makes the publicly
   *  observed revision the evidence a tombstoned host's recovery lock is
   *  cleared with. They are absent, not null, for an uninitialized object, so a
   *  router built against the earlier shape reads the same `unknown-host` it
   *  always did instead of failing on an unrecognised field. */
  | { kind: 'unknown-host'; revision?: string; schemaVersion?: number }
  | { kind: 'unavailable' }
  | { kind: 'malformed' }
  /**
   * A committed projection, stamped with the SCHEMA VERSION it was committed
   * under.
   *
   * The version is carried rather than dropped because the registry is a
   * separately deployed Worker whose schema may move ahead of this router's.
   * `desired` is a closed union today, so a v2 that keeps the current
   * discriminants and merely adds meaning to them — an additive field, a
   * narrowed `status`, a new constraint on `pathNamespace` — would arrive here
   * looking exactly like a v1 route and be served under v1 rules. That is the
   * version-skew hole `specs/event-router-registry.md` § Failure semantics
   * closes with its "malformed/unsupported committed state" row: the consumer
   * has to be able to SEE the version to refuse it. It is typed `number`, not
   * the literal this deployment happens to accept, because the whole point is
   * that the value may be one this build does not know.
   */
  | { kind: 'committed'; schemaVersion: number; revision: string; desired: ReplicaDesired };

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
 *
 * A tombstone collapses to `unknown-host` — a deleted address must not advertise
 * that it ever existed as a ROUTE — but it keeps its revision, and that is not a
 * contradiction. Individual replica revisions are public metadata by this
 * spec's own threat model, and the recovery contract depends on this one being
 * public: `clear-lock` consumes three attestations "whose host/result/revision
 * equal committed state", and a tombstoned host whose public response carried no
 * revision could never produce them. What stays hidden is the projection — no
 * Event ID, Slug or Edition leaves this arm.
 */
export function registryLookup(
  state: RegistryState,
): Extract<RegistryLookup, { kind: 'unknown-host' } | { kind: 'committed' }> {
  const committed = state.committed;
  if (committed === null) return { kind: 'unknown-host' };
  // The committed record's own schema version travels with everything derived
  // from it — the projection AND the tombstone's revision — so a consumer on
  // the far side of the service binding can decide whether it understands this
  // record before it reads anything else out of it.
  const schemaVersion = committed.payload.schemaVersion;
  if (committed.payload.desired.kind === 'tombstone') {
    return { kind: 'unknown-host', revision: committed.revision, schemaVersion };
  }
  return {
    kind: 'committed',
    schemaVersion,
    revision: committed.revision,
    desired: committed.payload.desired,
  };
}
