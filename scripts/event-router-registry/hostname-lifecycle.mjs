/**
 * The ONE transaction helper that owns every projected hostname mutation
 * (#971), implementing `specs/event-router-registry.md` § Provisioning,
 * mutation, and deletion.
 *
 * Why one helper rather than a mutation per command: `hostnames/{host}` is the
 * public source and `routerReplicas/{host}` is the private desired state the
 * publisher converges to the edge. If any command could move one without the
 * other, "the edge is a projection of Firestore" would be a convention rather
 * than an invariant, and the reconciler's drift report would be reporting on
 * whichever writer last forgot. So every create, status, Edition, root-marker,
 * repoint and delete goes through `applyHostnameMutation`, which reads both
 * documents plus the permanent rehearsal reservation in ONE Firestore
 * transaction, derives the projection from the RESULTING hostname document
 * rather than from the caller's patch, and writes both sides together.
 *
 * `pathNamespace` is deliberately absent from that list even though it is a
 * projected field. Under the frozen `ROOT_HOSTS` table it is a pure function of
 * the host — null for every Event subdomain, the table's value for every root
 * host — and `deriveCanonicalProjection` refuses any other value, so no
 * mutation of an existing host can turn the capability on or off. Publishing it
 * is therefore a provisioning decision, and the deployment barrier sits on
 * `provision` alone. Converting a host between a route and a root marker
 * outside the archive interlock has no intent here either; `planUpdate` refuses
 * it by name rather than letting the derivation report a malformed document.
 *
 * Deliberately NOT owned here: `adultContent` (#608) keeps updating its own
 * non-projected field with no revision, because the data contract does not copy
 * it; and `apexPath` stays target/client resolution data that the archive
 * transaction writes but the projection never reads.
 *
 * Dry run is the default. `apply: true` is the only way a write reaches
 * Firestore, and the returned plan is identical either way, so an operator
 * compares the two runs rather than trusting a description of one.
 *
 * Plain `.mjs`, no build step, no Firestore import: the caller injects a
 * transaction runner (`createTransactionRunner` below adapts either Firestore
 * SDK), so the emulator suite drives real transactions and the unit suite
 * drives an in-memory store through the same code path. Two more things the
 * module cannot import come through the same door — the SDK's `Timestamp`
 * constructor, because the ledger's `updatedAt` must be stored as one, and the
 * archive's `eventId` listing of `hostnames`, because an Event's complete
 * mapping set is a query rather than a point read.
 */
import {
  HostnameProjectionRefusal,
  ROOT_HOSTS,
  STATUSES,
  buildLedgerDocument,
  cloneDocumentValue,
  deriveCanonicalProjection,
  isCanonicalRevision,
  isRecord,
  isReservedClassHost,
  nextRevision,
  normalizeTimestamp,
  projectionDigest,
  sameValue,
  validateHostShape,
  validateLedgerDocument,
} from './hostname-projection.mjs';

const POSITIVE_DECIMAL = /^[1-9]\d*$/;

/**
 * The complete seam list. An exact set rather than a minimum, so a future
 * caller cannot quietly hand this helper a KV namespace, a Cache API handle, a
 * publisher acknowledgement writer, or a "read the source from the edge"
 * fallback — the four stores `specs/event-router-registry.md` says never
 * participate in accepted state.
 *
 * `timestamp` turns the authoritative clock's `Date` into the caller SDK's own
 * `Timestamp`, and it is a seam rather than an import for the reason the
 * module header gives. It is REQUIRED, not optional: the spec types the
 * ledger's `updatedAt` as a `Timestamp` and the deployed publisher's Eventarc
 * parser rejects a `stringValue` for it, so a helper that silently fell back
 * to RFC 3339 text would write documents the edge can never converge on.
 */
const DEPENDENCY_KEYS = ['now', 'runTransaction', 'timestamp'];

const PROJECTED_FIELDS = new Set(['eventId', 'status', 'slug', 'edition', 'root', 'pathNamespace']);
const NON_PROJECTED_FIELDS = new Set(['adultContent', 'canonicalHost', 'isCanonical', 'preview']);

/**
 * The fields only a route document may carry, which the archive's mirror-root
 * conversion therefore removes. `apexPath` belongs here rather than with the
 * non-projected fields above because it is per-Event, and the converted
 * document names no Event.
 */
const ROUTE_ONLY_FIELDS = ['eventId', 'status', 'slug', 'apexPath'];

const INTENTS = new Set([
  'provision',
  'update',
  'repoint',
  'archive',
  'delete',
  'backfill-ledger',
  'advance-ledger',
]);

export class HostnameLifecycleRefusal extends Error {
  constructor(code) {
    super(`hostname mutation refused: ${code}`);
    this.name = 'HostnameLifecycleRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new HostnameLifecycleRefusal(code);
}

function isNonempty(value) {
  return typeof value === 'string' && value.length > 0;
}

function exactKeys(value, expected, code) {
  if (!isRecord(value)) refuse(code);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    refuse(code);
  }
}

/** Every required key present, no key outside required ∪ optional. */
function boundedKeys(value, required, optional, code) {
  if (!isRecord(value)) refuse(code);
  const actual = new Set(Object.keys(value));
  for (const key of required) if (!actual.has(key)) refuse(code);
  for (const key of actual) if (!required.includes(key) && !optional.includes(key)) refuse(code);
}

const MUTATION_KEYS = ['schemaVersion', 'intent', 'apply', 'actor', 'reason', 'host'];

/** Re-raises a projection refusal under this module's error type and code. */
function project(work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof HostnameProjectionRefusal) refuse(error.code);
    throw error;
  }
}

function requireHttpsUrl(value, code) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.toString() !== value) refuse(code);
  } catch (error) {
    if (error instanceof HostnameLifecycleRefusal) throw error;
    refuse(code);
  }
}

/**
 * Every ordinary claim and mutation refuses the two globally reserved classes
 * and every permanent rehearsal reservation, in the same transaction that would
 * have written. #970's guarded controller is the only writer of a classed
 * reservation or a synthetic state, and it does not come through here.
 */
function guardClaimable(host, reservation) {
  project(() => validateHostShape(host));
  if (isReservedClassHost(host)) refuse('reserved-class');
  if (reservation !== null) refuse('rehearsal-reservation');
}

/**
 * The one instant a mutation is stamped with, in both encodings it is needed
 * in: `iso` for the plan an operator reads and for the barrier comparison, and
 * `stamp` for the `updatedAt` field the ledger document stores. The two are
 * required to name the same instant, so a `timestamp` seam that quietly
 * rounded, shifted or ignored its argument fails closed here rather than
 * writing a ledger whose observability field disagrees with its own plan.
 */
function authoritativeNow(dependencies) {
  let value;
  try {
    value = dependencies.now();
  } catch {
    refuse('authoritative-clock-unavailable');
  }
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(time)) refuse('authoritative-clock-unavailable');
  const at = new Date(time);
  const iso = at.toISOString();
  let stamp;
  try {
    stamp = dependencies.timestamp(at);
  } catch {
    refuse('authoritative-clock-unavailable');
  }
  // A plain string would be admissible to `buildLedgerDocument` — the receipt
  // callers use one — so it is refused HERE, where the write is Firestore's.
  if (typeof stamp === 'string' || normalizeTimestamp(stamp) !== iso) {
    refuse('authoritative-clock-unavailable');
  }
  return { iso, stamp };
}

function validateDependencies(dependencies) {
  exactKeys(dependencies, DEPENDENCY_KEYS, 'invalid-dependencies');
  for (const key of DEPENDENCY_KEYS) {
    if (typeof dependencies[key] !== 'function') refuse('invalid-dependencies');
  }
}

/**
 * The enablement barrier from `specs/path-addressing-and-root.md`: the endpoint
 * and capability-aware worker ship, the release arms forced advancement and
 * retires the root-scoped precaches, and the resolution cache's schema version
 * is bumped so no client evaluates install UI against a pre-capability answer —
 * and ONLY THEN may `pathNamespace` be published. None of that is observable
 * from inside a Firestore transaction, so the barrier is an explicit attested
 * record the operator supplies; absent, the mutation fails closed.
 *
 * Only `provision` consults it, for the reason the module header gives: the
 * capability is a constant per host, so the one write that can first publish it
 * for a host is the write that creates that host's document.
 */
function validatePathCapabilityBarrier(barrier, observedAt) {
  exactKeys(
    barrier,
    ['releaseTag', 'workerVersionId', 'resolutionCacheSchemaVersion', 'armedAt'],
    'path-capability-barrier',
  );
  if (
    !isNonempty(barrier.releaseTag) ||
    !isNonempty(barrier.workerVersionId) ||
    !Number.isInteger(barrier.resolutionCacheSchemaVersion) ||
    barrier.resolutionCacheSchemaVersion < 1 ||
    !isNonempty(barrier.armedAt)
  ) {
    refuse('path-capability-barrier');
  }
  const armed = Date.parse(barrier.armedAt);
  if (!Number.isFinite(armed) || armed > Date.parse(observedAt)) refuse('path-capability-barrier');
}

/**
 * A mutation may only be layered on a host whose ledger ALREADY projects its
 * hostname document. Drift means one of the two was written outside this
 * helper, and the spec is explicit that attestation never blesses drift: the
 * repair is the explicit Admin ledger advance below, followed by a fresh read.
 */
function requireConvergedPreState(host, hostname, ledger) {
  const canonical = project(() => deriveCanonicalProjection(host, hostname ?? null));
  const stored = project(() => validateLedgerDocument(host, ledger));
  if (!sameValue(canonical, stored.desired)) refuse('source-ledger-drift');
  return stored;
}

/**
 * Collects the writes a plan would make, so a dry run executes exactly the same
 * read-and-derive path as an apply and differs only in whether the collected
 * writes are flushed. Firestore requires every read before the first write, and
 * buffering is what makes that ordering structural rather than remembered.
 */
function createWriteBuffer() {
  const writes = [];
  return {
    writes,
    // `cloneDocumentValue` rather than `structuredClone`, which would strip a
    // Firestore `Timestamp` to a plain two-number map on its way through the
    // buffer and store the ledger's `updatedAt` as one.
    set(path, value) {
      writes.push({ op: 'set', path, value: cloneDocumentValue(value) });
    },
    update(path, value) {
      writes.push({ op: 'update', path, value: cloneDocumentValue(value) });
    },
    delete(path) {
      writes.push({ op: 'delete', path });
    },
  };
}

async function readHostState(transaction, host) {
  const reservation = (await transaction.get(`routerRehearsals/${host}`)) ?? null;
  const hostname = (await transaction.get(`hostnames/${host}`)) ?? null;
  const ledger = (await transaction.get(`routerReplicas/${host}`)) ?? null;
  return { reservation, hostname, ledger };
}

function ledgerWrite(buffer, host, revision, desired, updatedAt, revisions, projections, from) {
  buffer.set(
    `routerReplicas/${host}`,
    project(() => buildLedgerDocument(host, revision, desired, updatedAt)),
  );
  revisions.push({ host, from, to: revision });
  projections.push({
    host,
    desired: structuredClone(desired),
    digest: project(() => projectionDigest(revision, host, desired)),
  });
}

/** No `undefined` reaches a Firestore `update`, where it is not a deletion. */
function validateChanges(changes) {
  if (!isRecord(changes) || Object.keys(changes).length === 0) refuse('invalid-input');
  for (const value of Object.values(changes)) if (value === undefined) refuse('invalid-input');
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

async function planProvision(input, transaction, clock, buffer, revisions, projections) {
  boundedKeys(input, [...MUTATION_KEYS, 'hostname'], ['pathCapabilityBarrier'], 'invalid-input');
  const { host } = input;
  const state = await readHostState(transaction, host);
  guardClaimable(host, state.reservation);
  if (state.hostname !== null) refuse('hostname-exists');
  // A tombstone is permanent and an address is never reused, so the ledger's
  // mere existence — tombstoned or not — refuses the claim.
  if (state.ledger !== null) {
    const stored = project(() => validateLedgerDocument(host, state.ledger));
    refuse(stored.desired.kind === 'tombstone' ? 'tombstoned-address' : 'address-in-use');
  }
  if (!isRecord(input.hostname)) refuse('invalid-input');
  for (const key of Object.keys(input.hostname)) {
    if (!PROJECTED_FIELDS.has(key) && !NON_PROJECTED_FIELDS.has(key)) refuse('unknown-field');
  }
  if (Object.hasOwn(input.hostname, 'status') && input.hostname.status !== 'disabled') {
    // "create `hostnames/{host}` initially `disabled`" — activation waits for
    // publisher acceptance and edge inspection, which happen after this write.
    refuse('provision-requires-disabled');
  }
  const document = Object.hasOwn(input.hostname, 'root')
    ? { ...input.hostname }
    : { ...input.hostname, status: 'disabled' };
  const desired = project(() => deriveCanonicalProjection(host, document));
  if (desired.kind !== 'tombstone' && desired.pathNamespace !== null) {
    validatePathCapabilityBarrier(input.pathCapabilityBarrier ?? null, clock.iso);
  }
  buffer.set(`hostnames/${host}`, document);
  ledgerWrite(buffer, host, '1', desired, clock.stamp, revisions, projections, null);
  return { host, projectedChange: true, resultingHostname: document };
}

async function planUpdate(input, transaction, clock, buffer, revisions, projections) {
  exactKeys(input, [...MUTATION_KEYS, 'changes'], 'invalid-input');
  const { host } = input;
  const state = await readHostState(transaction, host);
  guardClaimable(host, state.reservation);
  if (state.hostname === null) refuse('hostname-missing');
  const stored = requireConvergedPreState(host, state.hostname, state.ledger);
  if (stored.desired.kind === 'tombstone') refuse('tombstoned-address');

  const changes = input.changes;
  validateChanges(changes);
  let projectedChange = false;
  for (const key of Object.keys(changes)) {
    if (key === 'apexPath') refuse('apex-path-barrier');
    if (NON_PROJECTED_FIELDS.has(key)) continue;
    if (!PROJECTED_FIELDS.has(key)) refuse('unknown-field');
    projectedChange = true;
  }
  // A route and a root marker are distinguished by which of `eventId`/`root`
  // the document carries, and `changes` can only ADD a field — Firestore's
  // delete sentinel is deliberately not plumbed through this helper — so a
  // conversion in either direction would merge into a document carrying both.
  // Route → `root: 'doorway'` and `root: 'not-found'` → an active replacement
  // flagship are the two moves `specs/path-addressing-and-root.md` § D1 names,
  // and neither has an intent here: the archive interlock owns the only
  // route → root conversion that exists. Refuse by name so the operator reads
  // "this transition has no path" rather than "your document is malformed".
  if (
    (Object.hasOwn(changes, 'root') && !Object.hasOwn(state.hostname, 'root')) ||
    (Object.hasOwn(changes, 'eventId') && !Object.hasOwn(state.hostname, 'eventId'))
  ) {
    refuse('root-route-transition-barrier');
  }
  const identityChange =
    (Object.hasOwn(changes, 'eventId') && changes.eventId !== state.hostname.eventId) ||
    (Object.hasOwn(changes, 'slug') && changes.slug !== state.hostname.slug);
  const statusChange = Object.hasOwn(changes, 'status') && changes.status !== state.hostname.status;
  if (identityChange && statusChange) refuse('combined-barrier');
  if (identityChange) {
    // Repoint is its own barriered intent precisely so that an "update" cannot
    // move an Event's address while the host is serving.
    refuse(state.hostname.status === 'active' ? 'active-repoint-barrier' : 'repoint-requires-intent');
  }
  if (statusChange && changes.status === 'archived') refuse('archive-barrier');
  if (statusChange && !STATUSES.has(changes.status)) refuse('malformed-hostname-source');
  // Archival moved the routing documents, the `apexPath` field and
  // `EventDoc.status` together; un-archiving one routing document alone would
  // serve an "archive" whose Event document still refuses every gameplay write.
  if (statusChange && state.hostname.status === 'archived') refuse('unarchive-barrier');

  const document = { ...state.hostname, ...changes };
  if (!projectedChange) {
    // The `adultContent` derivation's path: a non-projected field does not
    // churn the edge, so no revision is spent and the ledger is not touched.
    buffer.update(`hostnames/${host}`, changes);
    return { host, projectedChange: false, resultingHostname: document };
  }
  // No path-capability barrier is consulted here, and the intent takes no
  // barrier input: `deriveCanonicalProjection` pins `pathNamespace` to the
  // host's `ROOT_HOSTS` entry (or to null off the table), and
  // `requireConvergedPreState` has already forced the stored document through
  // that same derivation, so the value cannot differ before and after. A
  // barrier check on this path would be unreachable code that read as a
  // guarantee.
  const desired = project(() => deriveCanonicalProjection(host, document));
  if (sameValue(desired, stored.desired)) refuse('no-projected-change');
  buffer.update(`hostnames/${host}`, changes);
  ledgerWrite(buffer, host, nextRevision(stored.revision), desired, clock.stamp, revisions, projections, stored.revision);
  return { host, projectedChange: true, resultingHostname: document };
}

async function planRepoint(input, transaction, clock, buffer, revisions, projections) {
  exactKeys(input, [...MUTATION_KEYS, 'changes'], 'invalid-input');
  const { host } = input;
  const state = await readHostState(transaction, host);
  guardClaimable(host, state.reservation);
  if (state.hostname === null) refuse('hostname-missing');
  const stored = requireConvergedPreState(host, state.hostname, state.ledger);
  if (stored.desired.kind !== 'route') refuse('repoint-requires-route');
  // "active → disabled and converge; change `eventId`/`slug` while disabled and
  // converge; active and converge. Skipping or combining barriers is
  // prohibited." The disable and the re-activate are ordinary updates; this
  // intent is only ever the middle step.
  if (state.hostname.status !== 'disabled') refuse('repoint-requires-disabled');

  const changes = input.changes;
  validateChanges(changes);
  for (const key of Object.keys(changes)) {
    if (key === 'status') refuse('combined-barrier');
    if (key === 'apexPath') refuse('apex-path-barrier');
    if (!PROJECTED_FIELDS.has(key) && !NON_PROJECTED_FIELDS.has(key)) refuse('unknown-field');
  }
  if (!Object.hasOwn(changes, 'eventId') && !Object.hasOwn(changes, 'slug')) refuse('repoint-requires-identity');
  const document = { ...state.hostname, ...changes };
  const desired = project(() => deriveCanonicalProjection(host, document));
  if (sameValue(desired, stored.desired)) refuse('no-projected-change');
  buffer.update(`hostnames/${host}`, changes);
  ledgerWrite(buffer, host, nextRevision(stored.revision), desired, clock.stamp, revisions, projections, stored.revision);
  return { host, projectedChange: true, resultingHostname: document };
}

/**
 * Every host the `hostnames` collection currently maps to `eventId`, read
 * through the transaction's own listing seam.
 *
 * It fails closed when the seam is absent, and that is the point: the archive
 * interlock is a statement about ALL of an Event's mappings, and a caller that
 * cannot enumerate them cannot make it. An operator's `mappings` array is an
 * assertion about the collection, not a definition of it.
 */
async function listEventMappings(transaction, eventId) {
  if (typeof transaction.listEventMappings !== 'function') refuse('event-mapping-listing-unavailable');
  let mapped;
  try {
    mapped = await transaction.listEventMappings(eventId);
  } catch (error) {
    if (error instanceof HostnameLifecycleRefusal) throw error;
    refuse('event-mapping-listing-unavailable');
  }
  if (!Array.isArray(mapped) || mapped.some((host) => !isNonempty(host))) {
    refuse('event-mapping-listing-malformed');
  }
  if (new Set(mapped).size !== mapped.length) refuse('event-mapping-listing-malformed');
  return mapped;
}

/**
 * The archive is refused unless it names every host the collection currently
 * maps to the Event.
 *
 * An omitted alias is the defect this exists for: the named mappings and
 * `events/{eventId}` would archive while that document stayed `active`, so the
 * archived Event would keep serving at that URL and the § D8 interlock would
 * be false.
 *
 * Only that direction is checked here. The converse — a named host the Event
 * does not map — is already refused per host by `archive-mapping-mismatch`
 * below, from the host's own document rather than from a listing, and that
 * refusal names the defect more precisely than a set comparison would. The two
 * together are set equality.
 */
function requireCompleteMappingSet(mapped, hosts) {
  const named = new Set(hosts);
  for (const host of mapped) if (!named.has(host)) refuse('archive-mapping-incomplete');
}

/**
 * The archive interlock from `specs/path-addressing-and-root.md` § D8: every
 * Event mapping, the `apexPath` field on whichever mapping becomes the archive
 * address, the mirror-root conversion to the non-serving `root: 'not-found'`
 * marker, and `EventDoc.status` all move in ONE transaction. Nothing observes a
 * half-archived Event, and no active Event becomes reachable at an apex path.
 */
async function planArchive(input, transaction, clock, buffer, revisions, projections) {
  exactKeys(
    input,
    [
      'schemaVersion',
      'intent',
      'apply',
      'actor',
      'reason',
      'eventId',
      'mappings',
      'apexPathHost',
      'mirrorRootConversions',
    ],
    'invalid-input',
  );
  const { eventId, mappings, apexPathHost, mirrorRootConversions } = input;
  if (!isNonempty(eventId) || !Array.isArray(mappings) || !Array.isArray(mirrorRootConversions)) {
    refuse('invalid-input');
  }
  const hosts = [...mappings, ...mirrorRootConversions.map((entry) => (isRecord(entry) ? entry.host : entry))];
  if (hosts.length === 0 || new Set(hosts).size !== hosts.length) refuse('invalid-input');
  if (apexPathHost !== null && !mappings.includes(apexPathHost)) refuse('apex-path-target-unknown');

  const event = (await transaction.get(`events/${eventId}`)) ?? null;
  if (event === null) refuse('event-missing');
  requireCompleteMappingSet(await listEventMappings(transaction, eventId), hosts);
  const states = new Map();
  for (const host of hosts) {
    states.set(host, await readHostState(transaction, host));
  }

  for (const host of mappings) {
    const state = states.get(host);
    guardClaimable(host, state.reservation);
    if (state.hostname === null) refuse('hostname-missing');
    const stored = requireConvergedPreState(host, state.hostname, state.ledger);
    if (stored.desired.kind !== 'route' || stored.desired.eventId !== eventId) refuse('archive-mapping-mismatch');
    if (state.hostname.status !== 'active') refuse('archive-requires-active');
    const changes = { status: 'archived' };
    if (host === apexPathHost) {
      // `apexPath` gates apex-path eligibility for THIS Event and is deliberately
      // a different field on a different document from the host-wide
      // `pathNamespace`; it is target/client resolution data and is never
      // projected to the edge.
      if (ROOT_HOSTS.has(host)) refuse('apex-path-target-ineligible');
      changes.apexPath = true;
    }
    const document = { ...state.hostname, ...changes };
    const desired = project(() => deriveCanonicalProjection(host, document));
    buffer.update(`hostnames/${host}`, changes);
    ledgerWrite(buffer, host, nextRevision(stored.revision), desired, clock.stamp, revisions, projections, stored.revision);
  }

  for (const entry of mirrorRootConversions) {
    exactKeys(entry, ['host', 'root'], 'invalid-input');
    const { host, root } = entry;
    const state = states.get(host);
    guardClaimable(host, state.reservation);
    if (state.hostname === null) refuse('hostname-missing');
    const stored = requireConvergedPreState(host, state.hostname, state.ledger);
    if (stored.desired.kind !== 'route' || stored.desired.eventId !== eventId) refuse('archive-mapping-mismatch');
    if (state.hostname.status !== 'active') refuse('archive-requires-active');
    const rootHost = ROOT_HOSTS.get(host);
    if (rootHost === undefined) refuse('root-marker-ineligible');
    if (root !== 'not-found') refuse('root-marker-ineligible');
    // The marker retains the host's path capability and its Edition and keeps
    // no Event field at all, so `/` is not-found while `/<slug>` can still
    // resolve other mirrored Events.
    //
    // This is the one write in the helper that replaces a whole hostname
    // document rather than patching it, because a root marker may not carry
    // the route fields and `update` has no way to drop them. Replacement is
    // therefore built by REMOVING exactly the route fields from the stored
    // document, so `adultContent`, `preview`, `canonicalHost`, `isCanonical`
    // and anything else the host carries survive the conversion — those fields
    // have their own reviewed writers (`specs/hostnames-lookup.md` § Who
    // writes a hostname document) and the archive transaction is not one of
    // them. `apexPath` goes with the route fields: it is a per-Event apex-path
    // opt-in and this document no longer names an Event.
    const document = { ...state.hostname };
    for (const field of ROUTE_ONLY_FIELDS) delete document[field];
    document.root = root;
    document.edition = rootHost.edition;
    document.pathNamespace = rootHost.pathNamespace;
    const desired = project(() => deriveCanonicalProjection(host, document));
    buffer.set(`hostnames/${host}`, document);
    ledgerWrite(buffer, host, nextRevision(stored.revision), desired, clock.stamp, revisions, projections, stored.revision);
  }

  buffer.update(`events/${eventId}`, { status: 'archived' });
  return { hosts, eventId, projectedChange: true };
}

async function planDelete(input, transaction, clock, buffer, revisions, projections) {
  exactKeys(
    input,
    ['schemaVersion', 'intent', 'apply', 'actor', 'reason', 'host', 'convergedRevision'],
    'invalid-input',
  );
  const { host } = input;
  const state = await readHostState(transaction, host);
  guardClaimable(host, state.reservation);
  if (state.hostname === null) refuse('hostname-missing');
  const stored = requireConvergedPreState(host, state.hostname, state.ledger);
  // "Reject active delete" is about what the host SERVES, not about the
  // `status` field, which only a route has. `specs/path-addressing-and-root.md`
  // § D1 makes `root: 'doorway'` the live platform or Edition doorway, so a
  // doorway marker is as serving as an active route and the permanent
  // tombstone would strand it exactly the same way. Its sibling
  // `root: 'not-found'` is the explicitly non-serving marker — deleting it
  // retires the host's remaining path capability, which is a real and
  // deliberate operation — so only the doorway is refused here.
  const serving =
    (stored.desired.kind === 'route' && stored.desired.status === 'active') ||
    (stored.desired.kind === 'root' && stored.desired.root === 'doorway');
  if (serving) refuse('delete-requires-inactive');
  // "After inactive convergence" — the operator proves convergence by naming the
  // revision the private audit read back from the Durable Object's committed
  // state. A mismatch means the edge has not accepted the inactive projection
  // yet, so deleting the source would strand a serving route with no source.
  if (!isCanonicalRevision(input.convergedRevision)) refuse('invalid-input');
  if (input.convergedRevision !== stored.revision) refuse('delete-requires-convergence');
  const desired = { kind: 'tombstone' };
  buffer.delete(`hostnames/${host}`);
  // The ledger and the DO state are never deleted and the address is never
  // reused: the tombstone is the permanent record of both facts.
  ledgerWrite(buffer, host, nextRevision(stored.revision), desired, clock.stamp, revisions, projections, stored.revision);
  return { host, projectedChange: true, resultingHostname: null };
}

async function planBackfill(input, transaction, clock, buffer, revisions, projections) {
  exactKeys(input, ['schemaVersion', 'intent', 'apply', 'actor', 'reason', 'host'], 'invalid-input');
  const { host } = input;
  const state = await readHostState(transaction, host);
  guardClaimable(host, state.reservation);
  if (state.hostname === null) refuse('hostname-missing');
  // Backfill creates a missing ledger and changes no public document. An
  // existing ledger — however wrong — is a reconciliation question, not a
  // backfill one.
  if (state.ledger !== null) refuse('ledger-exists');
  const desired = project(() => deriveCanonicalProjection(host, state.hostname));
  ledgerWrite(buffer, host, '1', desired, clock.stamp, revisions, projections, null);
  return { host, projectedChange: true, resultingHostname: state.hostname };
}

/**
 * Whether the stored ledger is a WELL-FORMED tombstone. A malformed ledger
 * answers false rather than refusing, because repairing exactly that is what
 * the advance below is for; only a ledger that validates can be relied on to
 * say the address was permanently retired.
 */
function validTombstone(host, ledger) {
  try {
    return validateLedgerDocument(host, ledger).desired.kind === 'tombstone';
  } catch (error) {
    if (error instanceof HostnameProjectionRefusal) return false;
    throw error;
  }
}

/**
 * The explicit human Admin recovery transaction. It exists for exactly one
 * situation the closed recovery state machine cannot resolve on its own: the
 * Durable Object is AHEAD of Firestore, so `apply` fails `409 source-behind`
 * and no attestation can be signed over a ledger that is behind the edge.
 *
 * It may advance the ledger above the DO high-water mark, using the CURRENT
 * canonical hostname projection — never an invented one — and it never lowers a
 * revision and never touches the public document. A new read transaction and a
 * fresh signed audit follow; this call blesses nothing by itself.
 */
async function planAdvanceLedger(input, transaction, clock, buffer, revisions, projections) {
  exactKeys(
    input,
    [
      'schemaVersion',
      'intent',
      'apply',
      'actor',
      'reason',
      'host',
      'durableObjectHighWaterRevision',
      'incidentUrl',
    ],
    'invalid-input',
  );
  const { host } = input;
  const state = await readHostState(transaction, host);
  guardClaimable(host, state.reservation);
  if (!POSITIVE_DECIMAL.test(String(input.durableObjectHighWaterRevision ?? ''))) refuse('invalid-input');
  requireHttpsUrl(input.incidentUrl, 'invalid-input');
  // A missing or malformed ledger is exactly what this transaction repairs, so
  // it reads the stored revision defensively rather than validating the whole
  // document. Absence floors the high-water at 0.
  const storedRevision =
    isRecord(state.ledger) && isCanonicalRevision(state.ledger.revision) ? state.ledger.revision : '0';
  // A tombstone is permanent and the address is never reused, so it bounds
  // this repair the way it bounds every other intent. Reading the CURRENT
  // source is what makes the advance a repair rather than an invention — and
  // it is also how a tombstoned address could be reclaimed, because a partial
  // Admin write that recreates `hostnames/{host}` would derive a live route
  // from it and republish the retired address at a higher revision. So a
  // well-formed tombstone in the ledger is detected BEFORE the source is
  // derived, and any source at all is refused against it: no document a
  // hostname can hold derives a tombstone, so nothing is lost by refusing
  // before the derivation, and a recreated document that would not even parse
  // is refused as the reuse it is rather than as a malformed source. The
  // remaining case — the tombstone with no hostname document, which is the
  // converged one — still advances, because that is how a tombstone the edge
  // is ahead of gets republished.
  if (validTombstone(host, state.ledger) && state.hostname !== null) refuse('tombstoned-address');
  const desired = project(() => deriveCanonicalProjection(host, state.hostname));
  const highWater = BigInt(input.durableObjectHighWaterRevision);
  // Monotonicity is CONSTRUCTED, not checked: flooring at the greater of the
  // stored revision and the named high-water mark and adding one is what makes
  // "it never lowers a revision" true, so there is no reachable state left for
  // a guard to refuse. Any later edit to this floor has to preserve that
  // property itself rather than expect a check below to catch it.
  const floor = BigInt(storedRevision) > highWater ? BigInt(storedRevision) : highWater;
  const revision = (floor + 1n).toString(10);
  ledgerWrite(buffer, host, revision, desired, clock.stamp, revisions, projections, storedRevision === '0' ? null : storedRevision);
  return { host, projectedChange: true, resultingHostname: state.hostname };
}

const PLANNERS = {
  provision: planProvision,
  update: planUpdate,
  repoint: planRepoint,
  archive: planArchive,
  delete: planDelete,
  'backfill-ledger': planBackfill,
  'advance-ledger': planAdvanceLedger,
};

function validateCommonInput(input) {
  if (!isRecord(input)) refuse('invalid-input');
  if (input.schemaVersion !== 1) refuse('invalid-input');
  if (!INTENTS.has(input.intent)) refuse('unknown-intent');
  if (typeof input.apply !== 'boolean') refuse('invalid-input');
  if (!isNonempty(input.actor)) refuse('invalid-input');
  if (!isNonempty(input.reason) || input.reason.trim() !== input.reason) refuse('invalid-input');
}

/**
 * Plans — and, with `apply: true`, performs — one hostname mutation in one
 * Firestore transaction.
 *
 * Returns `{ dryRun, intent, writes, revisions, projections, projectedChange }`.
 * The plan is computed identically in both modes; `writes` is the exact list of
 * document operations the transaction did (or would have) perform.
 */
export async function applyHostnameMutation(input, dependencies) {
  validateCommonInput(input);
  validateDependencies(dependencies);
  const clock = authoritativeNow(dependencies);
  const planner = PLANNERS[input.intent];

  return dependencies.runTransaction(async (transaction) => {
    const buffer = createWriteBuffer();
    const revisions = [];
    const projections = [];
    const outcome = await planner(input, transaction, clock, buffer, revisions, projections);
    if (input.apply) {
      for (const write of buffer.writes) {
        if (write.op === 'set') transaction.set(write.path, write.value);
        else if (write.op === 'update') transaction.update(write.path, write.value);
        else transaction.delete(write.path);
      }
    }
    return {
      dryRun: !input.apply,
      intent: input.intent,
      observedAt: clock.iso,
      actor: input.actor,
      reason: input.reason,
      writes: buffer.writes,
      revisions,
      projections,
      ...outcome,
    };
  });
}

/**
 * Adapts either Firestore SDK to the `{ get, set, update, delete }` facade the
 * planners use, plus the optional `listEventMappings` the archive interlock
 * requires. `runTransaction` is the SDK's own — `db.runTransaction(fn)` on
 * the Admin SDK, `(fn) => runTransaction(db, fn)` on the client SDK — and
 * `documentReference(path)` turns a `collection/id` path into that SDK's
 * reference. Nothing else about Firestore leaks into this module.
 *
 * `listEventMappings(eventId, transaction)` answers every host id in
 * `hostnames` whose `eventId` equals the argument. It takes the SDK's own
 * transaction because the Admin SDK can run that query INSIDE the transaction
 * (`transaction.get(query)`) and should, while the client SDK has no
 * transactional query at all and its adapter reads the collection beside the
 * transaction instead. That difference is the adapter's to own, not this
 * module's. It is optional here and required by the archive planner, so every
 * other intent stays callable with a runner that cannot list, and an archive
 * through one refuses by name.
 */
export function createTransactionRunner({ runTransaction, documentReference, listEventMappings }) {
  if (typeof runTransaction !== 'function' || typeof documentReference !== 'function') {
    refuse('invalid-dependencies');
  }
  if (listEventMappings !== undefined && typeof listEventMappings !== 'function') {
    refuse('invalid-dependencies');
  }
  return async (work) =>
    runTransaction(async (transaction) => {
      const facade = {
        ...(listEventMappings === undefined
          ? {}
          : { listEventMappings: (eventId) => listEventMappings(eventId, transaction) }),
        async get(path) {
          const snapshot = await transaction.get(documentReference(path));
          const exists = typeof snapshot.exists === 'function' ? snapshot.exists() : snapshot.exists === true;
          return exists ? (snapshot.data() ?? null) : null;
        },
        set(path, value) {
          transaction.set(documentReference(path), value);
        },
        update(path, value) {
          transaction.update(documentReference(path), value);
        },
        delete(path) {
          transaction.delete(documentReference(path));
        },
      };
      return work(facade);
    });
}
