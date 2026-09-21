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

/**
 * The root hosts that render a DOORWAY once the flagship they carried is
 * archived, as opposed to the non-serving `not-found` marker.
 *
 * `specs/path-addressing-and-root.md` § D1 settles this per host rather than
 * per class: the canonical apexes render a doorway — the platform's on
 * `fiveacross.app`, the Edition's on `vacaybingo.com`, and the GCB apex
 * becomes its Edition doorway exactly when the archive retires the live
 * Event — while a brand mirror is deliberately not-found afterwards, because
 * a mirror exists to land a Player IN the game and answering the emergency
 * with a doorway is not that. The archive's conversion reads this rather
 * than forcing every root host to one marker.
 */
export const DOORWAY_ROOT_HOSTS = new Set(['fiveacross.app', 'vacaybingo.com', 'gaycruisebingo.com']);

/**
 * The path Namespaces whose APEX may carry an archive address today.
 *
 * MIRROR of the apex entries in `FIRST_PARTY_AUTH_HOSTS`
 * (`src/auth-domain.ts`), and a precondition rather than a preference:
 * `specs/path-addressing-and-root.md` § D7 states that an apex may not serve
 * regime (b) until it is registered as a first-party auth host, in that set,
 * in Firebase Auth's authorized domains, and on the project's Google OAuth
 * web client. `fiveacross.app` is registered; `vacaybingo.com` is not, and
 * the last of those steps is console-only and human-performed. An archive
 * parked at `vacaybingo.com/<slug>` would therefore render
 * `auth-unconfigured` instead of the sign-in gate, on an Event that can
 * never be un-archived. Until the registration lands, Vacay archives belong
 * at `fiveacross.app/<slug>`, which is registered and serves the same Event.
 * Pinned against the real predicate by `src/slug.test.ts`.
 */
export const AUTH_READY_PATH_NAMESPACES = new Set(['fiveacross.app']);

/**
 * The 2 KiB sync-request ceiling, MIRRORED from `SYNC_MAX_BYTES` in
 * `worker/src/registry/contracts.ts`, where the edge enforces it on the
 * request body and `publishRouterReplica` enforces it before sending. A
 * ledger document larger than this is a revision the edge can never accept
 * and every publisher retry fails on, so it is refused at the write rather
 * than discovered at the wire. The two constants are pinned equal by
 * `hostname-projection.parity.test.mjs`.
 */
export const LEDGER_MAX_BYTES = 2_048;

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
 *
 * Normalizing to ONE canonical form is what makes that true, and preserving an
 * accepted string as written would not: `2026-09-20T12:00:00Z`,
 * `2026-09-20T12:00:00+00:00` and a `Timestamp` all name one instant, so a
 * reader that echoed the first two and `toISOString()`d the third would hand
 * `documentDigest` three different documents for one ledger and an audit
 * comparing a receipt against the stored row would report a mismatch that is
 * an artifact of the encoding. The canonical form is therefore the
 * `toISOString()` text the `Timestamp` branch already produces — UTC, `Z`
 * offset, exactly three fractional digits — and a string is re-emitted through
 * it rather than returned as written.
 *
 * A string must ROUND-TRIP to reach that form: it is required to be RFC 3339
 * (the same shape `router-publisher/src/runtime.ts` and the worker's
 * `parseSyncRequest` require) BEFORE it is parsed, because `Date.parse` also
 * accepts texts RFC 3339 does not — and an offsetless `2026-09-20T12:00:00`
 * would be read as LOCAL time, making the digest depend on the machine that
 * computed it. Sub-millisecond digits are truncated rather than refused, since
 * a Firestore `Timestamp` loses them at `toDate()` too, so millisecond
 * resolution is the canonical resolution of the whole layer.
 *
 * The shape is not enough on its own, which is the sharp half. `Date.parse`
 * ROLLS an impossible day forward instead of refusing it — `2026-02-30`
 * answers March 2, `2025-02-29` answers March 1 — so a canonicalizer that
 * trusted the regex and the parse would publish and digest a DIFFERENT instant
 * than the one the ledger names, which is worse than the divergence
 * canonicalizing is here to remove. An out-of-range month, hour, minute or
 * second is already `NaN` in V8, but that is an implementation detail rather
 * than a contract, so the calendar components are read back from `Date.UTC`
 * and every one of them must survive the round trip. Leap years fall out of
 * that check rather than being special-cased.
 */
const RFC_3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether an RFC 3339 match names a calendar instant that exists, judged on
 * the components AS WRITTEN: the offset shifts which UTC instant the text
 * denotes, but `2026-02-30T12:00:00+02:00` is not a date in any zone.
 *
 * DELIBERATE BOUND: `Date.UTC` maps the years 0 through 99 onto 1900 through
 * 1999, so a year below `0100` never reads back and is refused. That is the
 * wanted answer rather than a gap to close. This probe judges exactly one
 * field — the ledger's `updatedAt`, a publish instant the helper's own clock
 * writes — so a year in the first century is corruption rather than a date
 * anyone needs, and refusing it fails closed. The same bound is applied by
 * `router-publisher/src/runtime.ts` and the worker's
 * `src/registry/contracts.ts`, so no layer disagrees with another about which
 * texts are admissible. A caller that ever needs a user-supplied or
 * externally sourced date here must switch all three to
 * `new Date(0)` + `setUTCFullYear` + `setUTCHours`, together.
 */
function namesARealInstant(match) {
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour &&
    probe.getUTCMinutes() === minute &&
    probe.getUTCSeconds() === second
  );
}

/**
 * The canonical text for an accepted instant, or null.
 *
 * BOTH ends are checked, and the second is not redundant: the components are
 * judged as WRITTEN, before the offset is applied, so a text at either end of
 * the supported range can validate and still canonicalise outside it.
 * `0100-01-01T00:00:00+01:00` answers `0099-12-31T23:00:00.000Z`, which the
 * year bound refuses, and `9999-12-31T23:59:59-01:00` answers the expanded
 * form `+010000-01-01T00:59:59.000Z`, which is not RFC 3339 at all. A reader
 * that returned either would hand the digest — and the publisher — a text its
 * own rules reject.
 */
function canonicalInstant(value) {
  const match = RFC_3339.exec(value);
  if (match === null || !namesARealInstant(match)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  const canonicalMatch = RFC_3339.exec(canonical);
  return canonicalMatch !== null && namesARealInstant(canonicalMatch) ? canonical : null;
}

export function normalizeTimestamp(value) {
  if (typeof value === 'string') return canonicalInstant(value);
  if (!isRecord(value) || typeof value.toDate !== 'function') return null;
  let date;
  try {
    date = value.toDate();
  } catch {
    return null;
  }
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  // The canonical text goes back through the SAME predicate the string branch
  // applies, so the two encodings accept exactly the same instants. Without
  // it a `Timestamp` for a year below 0100 answered `0099-...` text that the
  // string branch — and therefore the deployed publisher and the worker —
  // refuse, so `authoritativeNow` could store a ledger the edge would never
  // accept. It also closes the expanded-year form `toISOString()` produces
  // outside 0000-9999, which is not RFC 3339 at all.
  const canonical = date.toISOString();
  const canonicalMatch = RFC_3339.exec(canonical);
  return canonicalMatch !== null && namesARealInstant(canonicalMatch) ? canonical : null;
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
 * A hostname this projection may describe at all: canonical lowercase, and one
 * of exactly the three classes every downstream consumer admits — a known root
 * host, one of the two closed rehearsal classes, or an Event subdomain whose
 * label is a CLAIMABLE Slug.
 *
 * That last clause is the one a syntactic check would miss, and missing it is
 * how a ledger gets written that can never converge. The wildcard-Namespace
 * pattern accepts `admin.fiveacross.app`, `ab.fiveacross.app` and
 * `ab--cd.fiveacross.app`, but the deployed publisher's `isRegistryHost` and
 * the worker's sync parser both reach `validateSlug` and refuse all three, so
 * a projection derived for one of them is a desired state the edge will never
 * accept. The route derivation below already refused them — its source has to
 * carry a `slug` equal to the label — but a TOMBSTONE derives from an absent
 * source and has no slug to check, so before this rule lived here
 * `advance-ledger` could write a tombstone that `validateLedgerDocument` then
 * called well formed while the sync endpoint rejected every attempt to publish
 * it, and the reconciler read the pair as a valid source rather than as the
 * dead end it is.
 *
 * A reserved-class host is still deliberately NOT refused: #970's controller
 * derives projections for its own synthetic states through this module. What
 * is admitted is the EXACT rehearsal classes rather than any `r2-` prefix,
 * because the publisher admits exactly those; the ordinary-claim refusal for
 * them stays in the lifecycle helper, which is the path an operator reaches.
 */
export function validateHostShape(host) {
  if (!isNonempty(host) || host !== host.toLowerCase() || host.endsWith('.') || host.includes('/')) {
    refuseProjection('invalid-host');
  }
  if (ROOT_HOSTS.has(host)) return;
  const event = EVENT_HOST.exec(host);
  if (event === null) refuseProjection('invalid-host');
  if (SYNTHETIC_EVENT.test(host) || SYNTHETIC_ROOT.test(host)) return;
  if (!validSlug(event[1])) refuseProjection('invalid-host');
}

/**
 * The Namespace an Event subdomain's archive address would live under — the
 * apex whose `/<slug>` path replaces the host when the Event is archived.
 * Null for anything that is not an Event subdomain.
 */
export function apexPathNamespace(host) {
  const event = EVENT_HOST.exec(host);
  return event === null ? null : event[2];
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
    // Digested over the CANONICALIZED timestamp, so a stored Firestore
    // `Timestamp` and every RFC 3339 spelling of the same instant produce one
    // digest rather than several; `canonicalJson` of a `Timestamp` would
    // otherwise serialize its internal second/nanosecond fields, and an echoed
    // string would make `Z` and `+00:00` two documents.
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
  const normalized = normalizeTimestamp(updatedAt);
  if (normalized === null) refuseProjection('malformed-timestamp');
  const document = {
    schemaVersion: 1,
    revision,
    host,
    desired: structuredClone(desired),
    updatedAt,
  };
  // The 2 KiB ceiling, measured on the SHAPE THAT GOES ON THE WIRE: the
  // publisher sends this document with `updatedAt` as RFC 3339 text, so the
  // envelope is weighed with the normalized string rather than with the
  // Firestore `Timestamp` the field is stored as. Nothing else bounds the
  // projected values — `eventId` is only required to be non-empty and a
  // revision is any run of digits — so an oversized one would otherwise
  // commit a Firestore revision that `publishRouterReplica` refuses and the
  // edge never sees, with every trigger retry failing on the same bytes.
  const envelope = JSON.stringify({ ...document, updatedAt: normalized });
  if (new TextEncoder().encode(envelope).byteLength > LEDGER_MAX_BYTES) {
    refuseProjection('projection-exceeds-sync-limit');
  }
  return document;
}
