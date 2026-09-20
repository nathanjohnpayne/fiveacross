/**
 * The canonical hostname → replica projection, shared by the lifecycle helper
 * and the reconciler (#971).
 *
 * `specs/event-router-registry.md` § Data and mutation contract defines exactly
 * one canonicalizer: the JSON array whose SHA-256 is the projection digest. The
 * lifecycle helper writes `routerReplicas/{host}` and the reconciler compares
 * it against the per-host Durable Object, so both must derive the same bytes
 * from the same hostname document or a "drift" report would be an artifact of
 * two derivations rather than a fact about the system. They therefore share
 * this module rather than each carrying a copy.
 *
 * `scripts/event-router-registry/recovery-controller.mjs` keeps its own copy of
 * the derivation for the reason its header records — it is #970's synthetic-only
 * attestor and validates a receipt rather than planning a write — and
 * `hostname-projection.parity.test.mjs` pins the two against one shared fixture
 * table over the synthetic host classes both accept.
 *
 * Plain `.mjs` with no build step and no dependency beyond `node:crypto`, so an
 * operator command and a Vitest run execute the same file.
 */
import { createHash } from 'node:crypto';

const POSITIVE_DECIMAL = /^[1-9]\d*$/;

export const EDITIONS = new Set(['gcb', 'vacay', 'fiveacross']);
export const STATUSES = new Set(['active', 'disabled', 'archived']);
export const PATH_NAMESPACES = new Set(['fiveacross.app', 'vacaybingo.com']);

// MIRROR of `RESERVED_LABELS` in `src/slug.ts` (see the note in
// `router-publisher/src/runtime.ts`); pinned by the parity test in
// `src/slug.test.ts`. `send` carries the Resend return-path MX (#1102).
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'auth',
  'd',
  'play',
  'send',
  'status',
  'www',
]);

/**
 * Every host whose `/` is answered by a root marker or by one flagship Event
 * mapping, with the Edition and path capability that host is allowed to carry
 * (`specs/path-addressing-and-root.md` § "What `/` serves"). A host outside this
 * table is an Event subdomain and may only ever carry a route.
 */
export const ROOT_HOSTS = new Map([
  ['fiveacross.app', { edition: 'fiveacross', pathNamespace: 'fiveacross.app' }],
  ['vacaybingo.com', { edition: 'vacay', pathNamespace: 'vacaybingo.com' }],
  ['gaycruisebingo.com', { edition: 'gcb', pathNamespace: null }],
  ['fiveacross.vercel.app', { edition: 'fiveacross', pathNamespace: 'fiveacross.app' }],
  ['vacaybingo.vercel.app', { edition: 'vacay', pathNamespace: 'vacaybingo.com' }],
  ['gaycruisebingo.vercel.app', { edition: 'gcb', pathNamespace: null }],
]);

const EVENT_HOST = /^([a-z0-9-]+)\.(fiveacross\.app|vacaybingo\.com)$/;
export const SYNTHETIC_EVENT = /^r2-[a-z2-7]{26}\.(fiveacross\.app|vacaybingo\.com)$/;
export const SYNTHETIC_ROOT = /^r2-root-[a-z2-7]{20}\.(fiveacross\.app|vacaybingo\.com)$/;

export class HostnameProjectionRefusal extends Error {
  constructor(code) {
    super(`hostname projection refused: ${code}`);
    this.name = 'HostnameProjectionRefusal';
    this.code = code;
  }
}

export function refuseProjection(code) {
  throw new HostnameProjectionRefusal(code);
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonempty(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The ONE reader of a ledger `updatedAt`, answering its RFC 3339 text or null.
 *
 * Two shapes reach it, and both are contract, not tolerance. The stored field
 * is a Firestore `Timestamp`, because `specs/event-router-registry.md` § Data
 * and mutation contract types it as one and the deployed publisher's Eventarc
 * parser (`replicaPayloadFromFirestoreEvent` in `router-publisher/src/
 * runtime.ts`) accepts only a `timestampValue`: a document whose `updatedAt`
 * arrived as a Firestore string is rejected before it can be published, so the
 * edge would never converge on it. The plain RFC 3339 string is the shape the
 * same publisher's `replicaPayloadFromEvent` also takes and the shape the
 * source-attestor receipt in `recovery-controller.mjs` carries, because a
 * receipt is normalized JSON rather than a Firestore snapshot.
 *
 * Reads therefore normalize rather than choose, which is also what keeps
 * `documentDigest` below equal across the two: `updatedAt` is observability
 * only and never orders a write, so which of the two encodings a reader
 * received must not change the digest it computes.
 */
export function normalizeTimestamp(value) {
  if (typeof value === 'string') {
    return value.length > 0 && Number.isFinite(Date.parse(value)) ? value : null;
  }
  if (!isRecord(value) || typeof value.toDate !== 'function') return null;
  let date;
  try {
    date = value.toDate();
  } catch {
    return null;
  }
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * A deep copy that returns anything which is not a plain object or array BY
 * REFERENCE, which `structuredClone` cannot do: it strips a class instance to
 * its own enumerable fields, so a Firestore `Timestamp` would reach the SDK as
 * a two-number map and be stored as one. Timestamps are immutable value
 * objects, so sharing the reference is safe, and every other value a hostname
 * or ledger document carries is plain JSON and is copied.
 */
export function cloneDocumentValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneDocumentValue(entry));
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneDocumentValue(entry)]));
  }
  return value;
}

/**
 * Key-sorted JSON, so a digest over a document does not depend on the order in
 * which Firestore happened to hand back its fields.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Structural equality over the plain JSON shapes this module produces. */
export function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function isCanonicalRevision(value) {
  return typeof value === 'string' && POSITIVE_DECIMAL.test(value);
}

export function nextRevision(current) {
  if (!isCanonicalRevision(current)) refuseProjection('malformed-revision');
  return (BigInt(current) + 1n).toString(10);
}

/**
 * The globally reserved rehearsal classes. `r2-root-` is a strict prefix
 * extension of `r2-`, so ONE `startsWith` closes both classes at once and the
 * two patterns above stay where they belong — classifying a host that already
 * IS one, for #970's controller — rather than becoming a third mirror the
 * parity suite in `src/slug.test.ts` would have to track.
 */
export function isReservedClassHost(host) {
  return isNonempty(host) && host.split('.')[0].startsWith('r2-');
}

export function validSlug(slug) {
  return (
    isNonempty(slug) &&
    slug.length >= 3 &&
    slug.length <= 63 &&
    /^[a-z0-9-]+$/.test(slug) &&
    !slug.startsWith('-') &&
    !slug.endsWith('-') &&
    !slug.startsWith('r2-') &&
    !RESERVED_SLUGS.has(slug) &&
    !(slug.length >= 4 && slug[2] === '-' && slug[3] === '-')
  );
}

/**
 * A hostname this projection may describe at all: canonical lowercase, and
 * either a known root host or an Event subdomain in a wildcard Namespace. A
 * reserved-class host is a valid host shape and is deliberately NOT refused
 * here — #970's controller derives projections for its own synthetic states
 * through this module, and the ordinary-claim refusal belongs to the lifecycle
 * helper, which is the path an operator reaches.
 */
export function validateHostShape(host) {
  if (!isNonempty(host) || host !== host.toLowerCase() || host.endsWith('.') || host.includes('/')) {
    refuseProjection('invalid-host');
  }
  if (!ROOT_HOSTS.has(host) && EVENT_HOST.exec(host) === null) refuseProjection('invalid-host');
}

/**
 * The strict derivation. Absence derives only a tombstone; anything else must
 * be a well-formed route or root document for THIS host, or the derivation
 * refuses rather than inventing a projection.
 *
 * `adultContent`, `canonicalHost`, `preview`, `apexPath`, `isCanonical` and
 * every other field are deliberately ignored: the spec's data contract copies
 * exactly the fields below and nothing else, which is why an `adultContent`
 * derivation can keep writing without a revision.
 */
export function deriveCanonicalProjection(host, source) {
  validateHostShape(host);
  if (source === null || source === undefined) return { kind: 'tombstone' };
  if (!isRecord(source)) refuseProjection('malformed-hostname-source');
  const hasEvent = Object.hasOwn(source, 'eventId');
  const hasRoot = Object.hasOwn(source, 'root');
  if (hasEvent === hasRoot) refuseProjection('malformed-hostname-source');
  if (!EDITIONS.has(source.edition)) refuseProjection('malformed-hostname-source');
  const pathNamespace = Object.hasOwn(source, 'pathNamespace') ? source.pathNamespace : null;
  if (pathNamespace !== null && !PATH_NAMESPACES.has(pathNamespace)) {
    refuseProjection('malformed-hostname-source');
  }
  const root = ROOT_HOSTS.get(host);
  if (hasRoot) {
    if (
      (source.root !== 'doorway' && source.root !== 'not-found') ||
      Object.hasOwn(source, 'status') ||
      Object.hasOwn(source, 'slug')
    ) {
      refuseProjection('malformed-hostname-source');
    }
    const synthetic = SYNTHETIC_ROOT.test(host);
    if (
      (!synthetic && root === undefined) ||
      (synthetic && pathNamespace !== null) ||
      (root !== undefined && (source.edition !== root.edition || pathNamespace !== root.pathNamespace))
    ) {
      refuseProjection('malformed-hostname-source');
    }
    return { kind: 'root', root: source.root, edition: source.edition, pathNamespace };
  }
  if (
    !isNonempty(source.eventId) ||
    !STATUSES.has(source.status) ||
    !isNonempty(source.slug) ||
    (!validSlug(source.slug) && !(SYNTHETIC_EVENT.test(host) && source.slug === host.split('.')[0]))
  ) {
    refuseProjection('malformed-hostname-source');
  }
  const event = EVENT_HOST.exec(host);
  if (
    (root === undefined && (event === null || event[1] !== source.slug || pathNamespace !== null)) ||
    (root !== undefined && pathNamespace !== root.pathNamespace)
  ) {
    refuseProjection('malformed-hostname-source');
  }
  return {
    kind: 'route',
    eventId: source.eventId,
    status: source.status,
    slug: source.slug,
    edition: source.edition,
    pathNamespace,
  };
}

/**
 * The ONE canonicalizer the spec names: constructing this array is the only way
 * a digest is produced anywhere in the system. Explicit JSON `null` is what
 * keeps an absent capability from colliding with a present one.
 */
export function projectionDigest(revision, host, desired) {
  if (!isCanonicalRevision(revision)) refuseProjection('malformed-revision');
  const tuple =
    desired.kind === 'route'
      ? [1, revision, host, 'route', desired.eventId, desired.status, desired.slug, desired.edition, desired.pathNamespace]
      : desired.kind === 'root'
        ? [1, revision, host, 'root', desired.root, desired.edition, desired.pathNamespace]
        : [1, revision, host, 'tombstone'];
  return sha256Hex(JSON.stringify(tuple));
}

/**
 * Validates a stored `routerReplicas/{host}` document and re-derives its
 * desired state through the same strict rules, so a ledger that was written by
 * a direct Admin SDK edit (a contract violation the spec says audit catches)
 * cannot pass as well-formed merely because its keys are present.
 */
export function validateLedgerDocument(host, ledger) {
  validateHostShape(host);
  if (ledger === null || ledger === undefined) refuseProjection('missing-ledger');
  if (!isRecord(ledger)) refuseProjection('malformed-ledger');
  const keys = Object.keys(ledger).sort();
  const expected = ['desired', 'host', 'revision', 'schemaVersion', 'updatedAt'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    refuseProjection('malformed-ledger');
  }
  const updatedAt = normalizeTimestamp(ledger.updatedAt);
  if (
    ledger.schemaVersion !== 1 ||
    !isCanonicalRevision(ledger.revision) ||
    ledger.host !== host ||
    updatedAt === null
  ) {
    refuseProjection('malformed-ledger');
  }
  const desired = normalizeDesired(host, ledger.desired);
  return {
    revision: ledger.revision,
    desired,
    digest: projectionDigest(ledger.revision, host, desired),
    // Digested over the NORMALIZED timestamp, so a stored Firestore
    // `Timestamp` and the same instant as RFC 3339 text produce one digest
    // rather than two; `canonicalJson` of a `Timestamp` would otherwise
    // serialize its internal second/nanosecond fields.
    documentDigest: sha256Hex(canonicalJson({ ...ledger, updatedAt })),
  };
}

/**
 * Re-derives a stored `desired` through `deriveCanonicalProjection` by turning
 * it back into the hostname fields it claims to project. A `desired` that no
 * hostname document could have produced is malformed, however well its own keys
 * typecheck.
 */
export function normalizeDesired(host, desired) {
  if (!isRecord(desired) || typeof desired.kind !== 'string') refuseProjection('malformed-ledger');
  const keys =
    desired.kind === 'route'
      ? ['kind', 'eventId', 'status', 'slug', 'edition', 'pathNamespace']
      : desired.kind === 'root'
        ? ['kind', 'root', 'edition', 'pathNamespace']
        : desired.kind === 'tombstone'
          ? ['kind']
          : [];
  if (keys.length === 0) refuseProjection('malformed-ledger');
  const actual = Object.keys(desired).sort();
  const sorted = [...keys].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    refuseProjection('malformed-ledger');
  }
  if (desired.kind === 'tombstone') return { kind: 'tombstone' };
  const source =
    desired.kind === 'root'
      ? { root: desired.root, edition: desired.edition, pathNamespace: desired.pathNamespace }
      : {
          eventId: desired.eventId,
          status: desired.status,
          slug: desired.slug,
          edition: desired.edition,
          pathNamespace: desired.pathNamespace,
        };
  try {
    return deriveCanonicalProjection(host, source);
  } catch (error) {
    if (error instanceof HostnameProjectionRefusal) refuseProjection('malformed-ledger');
    throw error;
  }
}

/**
 * The exact `RouterReplicaDesired` document the lifecycle helper writes.
 * `updatedAt` is observability only and never orders a write, which is why it
 * is outside the digest above.
 *
 * `updatedAt` is stored EXACTLY as handed in, and the lifecycle helper hands
 * in the Firestore `Timestamp` its `timestamp` seam builds, because the
 * deployed Eventarc publisher rejects a `stringValue` for this field. The
 * plain RFC 3339 string stays admissible for the receipt-shaped callers
 * `normalizeTimestamp` documents.
 */
export function buildLedgerDocument(host, revision, desired, updatedAt) {
  if (!isCanonicalRevision(revision)) refuseProjection('malformed-revision');
  if (normalizeTimestamp(updatedAt) === null) refuseProjection('malformed-timestamp');
  return {
    schemaVersion: 1,
    revision,
    host,
    desired: structuredClone(desired),
    updatedAt,
  };
}
