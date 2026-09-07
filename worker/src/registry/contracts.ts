import { classifyHost, NAMESPACES, normalizeHost } from '../host';
import { isRehearsalEventLabel, isRehearsalRootLabel, validateSlug } from '../../../src/slug';

export const SYNC_PATH = '/__internal/hostname-replicas/v1';
export const SYNC_MAX_BYTES = 2_048;
export const REGISTRY_LOCATION_HINT = 'wnam' as const;

export type RegistryEdition = 'gcb' | 'vacay' | 'fiveacross';
export type PathNamespace = 'fiveacross.app' | 'vacaybingo.com' | null;

export type ReplicaDesired =
  | {
      kind: 'route';
      eventId: string;
      status: 'active' | 'disabled' | 'archived';
      slug: string;
      edition: RegistryEdition;
      pathNamespace: PathNamespace;
    }
  | {
      kind: 'root';
      root: 'doorway' | 'not-found';
      edition: RegistryEdition;
      pathNamespace: PathNamespace;
    }
  | { kind: 'tombstone' };

export type RouterReplicaDesired = {
  schemaVersion: 1;
  revision: string;
  host: string;
  desired: ReplicaDesired;
  updatedAt: string;
};

export type CommittedReplica = {
  revision: string;
  digest: string;
  payload: RouterReplicaDesired;
};

export type RecoveryLock = {
  lockId: string;
  acquiredAt: string;
  expectedCommitted: null | { revision: string; digest: string };
  operatorSub: string;
  incidentUrl: string;
  reason: string;
};

export type RegistryState = {
  committed: CommittedReplica | null;
  minimumPublisherEpoch: string;
  highestAuthenticatedPublisherEpoch: string;
  highestQuarantinedPublisherEpoch: string;
  recoveryLock: RecoveryLock | null;
  recoverySequence: string;
};

const TOP_LEVEL_KEYS = ['desired', 'host', 'revision', 'schemaVersion', 'updatedAt'];
const ROUTE_KEYS = ['edition', 'eventId', 'kind', 'pathNamespace', 'slug', 'status'];
const ROOT_KEYS = ['edition', 'kind', 'pathNamespace', 'root'];
const TOMBSTONE_KEYS = ['kind'];
const EDITIONS = new Set<RegistryEdition>(['gcb', 'vacay', 'fiveacross']);
const PATH_NAMESPACES = new Set(['fiveacross.app', 'vacaybingo.com']);
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
/**
 * A rehearsal host is one of the two closed label classes under one of the two
 * Namespaces. The label halves come from `src/slug.ts` and the Namespace half
 * from `host.ts`, so the registry, the router's guard and the private harness
 * all answer "is this a rehearsal host?" from one definition — a class that
 * three files agreed on separately is a class that eventually two of them
 * disagree on.
 */
function isSyntheticHost(host: string, isLabel: (label: string) => boolean): boolean {
  const separator = host.indexOf('.');
  return (
    separator !== -1 && isLabel(host.slice(0, separator)) && NAMESPACES.includes(host.slice(separator + 1))
  );
}

const isSyntheticRootHostClass = (host: string): boolean => isSyntheticHost(host, isRehearsalRootLabel);
const isSyntheticEventHostClass = (host: string): boolean => isSyntheticHost(host, isRehearsalEventLabel);
const ROOT_HOSTS = new Map<string, { edition: RegistryEdition; pathNamespace: PathNamespace }>([
  ['fiveacross.app', { edition: 'fiveacross', pathNamespace: 'fiveacross.app' }],
  ['vacaybingo.com', { edition: 'vacay', pathNamespace: 'vacaybingo.com' }],
  ['gaycruisebingo.com', { edition: 'gcb', pathNamespace: null }],
  ['fiveacross.vercel.app', { edition: 'fiveacross', pathNamespace: 'fiveacross.app' }],
  ['vacaybingo.vercel.app', { edition: 'vacay', pathNamespace: 'vacaybingo.com' }],
  ['gaycruisebingo.vercel.app', { edition: 'gcb', pathNamespace: null }],
]);

/**
 * The value predicates below are exported because the projection has TWO
 * validating consumers, not one: this module validates a payload on its way IN
 * from the publisher, and `worker/src/resolve.ts` re-validates the committed
 * projection on its way OUT across the registry service binding — a boundary
 * between two separately deployed Workers whose returned shape is a contract
 * rather than something the router itself wrote. Duplicating the closed sets
 * would let those two answers drift, which is the one failure a shared registry
 * projection cannot survive.
 */
export function isRegistryEdition(value: unknown): value is RegistryEdition {
  return typeof value === 'string' && EDITIONS.has(value as RegistryEdition);
}

export function isPathNamespace(value: unknown): value is PathNamespace {
  return value === null || (typeof value === 'string' && PATH_NAMESPACES.has(value));
}

export function isReplicaRouteStatus(value: unknown): value is 'active' | 'disabled' | 'archived' {
  return value === 'active' || value === 'disabled' || value === 'archived';
}

export function isReplicaRootMarker(value: unknown): value is 'doorway' | 'not-found' {
  return value === 'doorway' || value === 'not-found';
}

/** A canonical positive decimal with no leading zeroes — the only shape a
 *  revision may take, and therefore the only shape that may reach the
 *  `x-event-router-revision` response header. */
export function isCanonicalRevision(value: unknown): value is string {
  return typeof value === 'string' && POSITIVE_DECIMAL.test(value);
}

export function isSyntheticRegistryHost(host: string): boolean {
  return isSyntheticEventHostClass(host) || isSyntheticRootHostClass(host);
}

export function isRegistryRootHost(host: string): boolean {
  return ROOT_HOSTS.has(host) || isSyntheticRootHostClass(host);
}

/**
 * The ONE `pathNamespace` a projection for this host may carry.
 *
 * `pathNamespace` is non-null only on a mapped Namespace apex or brand mirror,
 * and explicitly null everywhere else — an Event subdomain, a GCB host, or
 * either synthetic rehearsal class. Expressed as the expected VALUE rather than
 * as a predicate so both consumers compare against the same single answer:
 * `parseDesired` when a payload arrives, and `worker/src/resolve.ts` when a
 * committed projection comes back across the service binding. A router that
 * accepted a non-null namespace on an Event subdomain would publish a path
 * capability that the accepted path-addressing contract forbids.
 */
export function registryHostPathNamespace(host: string): PathNamespace {
  return ROOT_HOSTS.get(host)?.pathNamespace ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function parseDesired(host: string, value: unknown): ReplicaDesired {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('invalid desired');

  if (value.kind === 'tombstone') {
    if (!hasExactKeys(value, TOMBSTONE_KEYS)) throw new Error('invalid tombstone fields');
    if (classifyHost(host).kind === 'rejected' && !isSyntheticRegistryHost(host) && !isRegistryRootHost(host)) {
      throw new Error('invalid tombstone host');
    }
    return { kind: 'tombstone' };
  }

  const edition = value.edition;
  if (!isRegistryEdition(edition)) {
    throw new Error('invalid edition');
  }
  const pathNamespace = value.pathNamespace;
  if (!isPathNamespace(pathNamespace)) {
    throw new Error('invalid pathNamespace');
  }

  if (value.kind === 'route') {
    if (!hasExactKeys(value, ROUTE_KEYS)) throw new Error('invalid route fields');
    const eventId = requireString(value.eventId, 'eventId');
    const slug = requireString(value.slug, 'slug');
    if (!isReplicaRouteStatus(value.status)) {
      throw new Error('invalid route status');
    }
    // The root-test class is ROOT-shaped and disjoint by construction, so a
    // route may never be committed on it. Stated explicitly rather than left to
    // the host classifier: `classifyHost` now ADDRESSES `r2-root-*` (#972), so
    // without this line the branch below would read it as an ordinary labelled
    // Event address and admit a route whose slug happened to match — letting
    // the one host reserved to prove root behaviour serve an Event instead.
    if (isSyntheticRootHostClass(host)) {
      throw new Error('the root-test rehearsal class accepts no route projection');
    }
    const classified = classifyHost(host);
    const syntheticSlug = isSyntheticEventHostClass(host) ? host.split('.')[0] : null;
    const rootClass = ROOT_HOSTS.get(host);
    if (syntheticSlug !== null) {
      if (syntheticSlug !== slug || pathNamespace !== null) {
        throw new Error('route slug must match the canonical host label');
      }
    } else if (classified.kind === 'event') {
      if (classified.slug !== slug || pathNamespace !== null) {
        throw new Error('route slug must match the canonical host label');
      }
    } else if (rootClass === undefined || !validateSlug(slug).ok || rootClass.pathNamespace !== pathNamespace) {
      throw new Error('route host class or pathNamespace is invalid');
    }
    return {
      kind: 'route',
      eventId,
      status: value.status,
      slug,
      edition,
      pathNamespace,
    };
  }

  if (value.kind === 'root') {
    if (!hasExactKeys(value, ROOT_KEYS)) throw new Error('invalid root fields');
    if (!isReplicaRootMarker(value.root)) throw new Error('invalid root marker');
    const syntheticRoot = isSyntheticRootHostClass(host);
    const rootClass = ROOT_HOSTS.get(host);
    if (!syntheticRoot && rootClass === undefined) throw new Error('invalid root shape');
    if (syntheticRoot) {
      if (pathNamespace !== null) throw new Error('synthetic root pathNamespace must be null');
    } else if (rootClass?.pathNamespace !== pathNamespace || rootClass.edition !== edition) {
      throw new Error('root edition/pathNamespace must match its host class');
    }
    return {
      kind: 'root',
      root: value.root,
      edition,
      pathNamespace,
    };
  }

  throw new Error('invalid desired kind');
}

export function parseSyncRequest(body: string, contentType: string | null): RouterReplicaDesired {
  if (contentType !== 'application/json') throw new Error('invalid content-type');
  if (new TextEncoder().encode(body).byteLength > SYNC_MAX_BYTES) {
    throw new Error('sync request exceeds 2 KiB');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new Error('invalid JSON');
  }
  if (!isRecord(decoded) || !hasExactKeys(decoded, TOP_LEVEL_KEYS)) {
    throw new Error('invalid sync request fields');
  }
  if (decoded.schemaVersion !== 1) throw new Error('invalid schemaVersion');
  const revision = requireString(decoded.revision, 'revision');
  if (!isCanonicalRevision(revision)) throw new Error('invalid revision');
  const host = requireString(decoded.host, 'host');
  if (host !== normalizeHost(host) || host.endsWith('.')) throw new Error('host must be canonical');
  const updatedAt = requireString(decoded.updatedAt, 'updatedAt');
  if (!RFC_3339.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error('invalid updatedAt');
  }
  return {
    schemaVersion: 1,
    revision,
    host,
    desired: parseDesired(host, decoded.desired),
    updatedAt,
  };
}

export function canonicalProjectionBytes(payload: RouterReplicaDesired): Uint8Array {
  const { desired } = payload;
  const tuple =
    desired.kind === 'route'
      ? [
          1,
          payload.revision,
          payload.host,
          'route',
          desired.eventId,
          desired.status,
          desired.slug,
          desired.edition,
          desired.pathNamespace,
        ]
      : desired.kind === 'root'
        ? [1, payload.revision, payload.host, 'root', desired.root, desired.edition, desired.pathNamespace]
        : [1, payload.revision, payload.host, 'tombstone'];
  return new TextEncoder().encode(JSON.stringify(tuple));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function projectionDigest(payload: RouterReplicaDesired): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', canonicalProjectionBytes(payload));
  return bytesToHex(new Uint8Array(digest));
}
