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
  AUTH_READY_PATH_NAMESPACES,
  DOORWAY_ROOT_HOSTS,
  HostnameProjectionRefusal,
  ROOT_HOSTS,
  STATUSES,
  apexPathNamespace,
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

/**
 * The fields that describe THE EVENT rather than the host, and are therefore
 * reset by a repoint unless the caller supplies new values.
 *
 * A repoint moves a host from one Event to another, and a merge carried the
 * previous Event's public face with it: the old `preview` postcard the
 * sign-in gate renders, the old `canonicalHost` analytics attribute to, the
 * old `isCanonical` claim, and the old `adultContent` posture — which is a
 * content warning, so inheriting it is wrong in both directions. There is no
 * deletion sentinel in this helper, and deliberately so, which meant an
 * obsolete `preview` could not be removed through `changes` at all. Repoint
 * therefore REPLACES the document rather than patching it.
 *
 * `apexPath` is here because it is per-Event by definition; a repointed host
 * is `disabled` rather than archived, so it should never carry one, and
 * resetting costs nothing. Everything not named here is host-scoped and
 * survives: `pathNamespace` is a pure function of the host, `edition` and
 * `status` are barriered moves of their own, and `root` cannot appear on a
 * document this intent accepts.
 */
const EVENT_SCOPED_FIELDS = ['adultContent', 'apexPath', 'canonicalHost', 'isCanonical', 'preview'];

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
 * Refuses a route that would point at an Event the platform has already
 * retired, or is in the middle of retiring.
 *
 * The archive interlock retires an Event's own hosts in favour of the opted-in
 * apex path, and `unarchive-barrier` keeps an EXISTING routing document from
 * coming back. Neither covered a route that did not exist when the Event was
 * archived: `provision` never read `events/{eventId}`, so a fresh mapping
 * could be created `disabled` against an archived Event and then activated by
 * an ordinary update, whose own source status had never been `archived`. The
 * archived Event would serve at its own hostname again, which is exactly what
 * § D8 retires. `repoint` re-homes a document onto a DIFFERENT Event and is
 * the same hole through the other door.
 *
 * Both halves of the freeze count. `archiving: true` is the quiesce
 * `beginArchive` installs, and `specs/post-sailing-archive.md` treats it as
 * closed for every gameplay write, so publishing a new address into it would
 * race the flip this transaction cannot see.
 *
 * A MISSING Event document is not refused. Provisioning a hostname before the
 * Event document exists is an ordinary operator order, and refusing it would
 * be a new precondition rather than this defect; what is refused is a live
 * route onto an Event that is demonstrably not live.
 */
async function requireLiveEvent(transaction, eventId) {
  if (!isNonempty(eventId)) return;
  const event = await transaction.get(`events/${eventId}`);
  if (event === null) return;
  if (!isRecord(event)) refuse('event-not-live');
  if (event.status === 'archived' || event.archiving === true) refuse('event-not-live');
}

/**
 * The operator's proof that the EDGE has accepted the projection Firestore
 * holds — not merely that Firestore holds it.
 *
 * Two intents are barriered on inactive convergence rather than on inactive
 * state, and neither can observe the Durable Object from inside a Firestore
 * transaction, so the evidence is an input: the revision and digest the
 * private audit read back from the object's committed state. Both are
 * required, and the digest is the half that does the work. Revision equality
 * alone is satisfied by a POISONED object — the same revision carrying a
 * different and possibly still-serving payload, which is a state the
 * reconciler has a classification for and which equal-revision recovery can
 * produce — so a repoint or a delete resting on the revision alone would move
 * or retire a source while the edge still served the old Event.
 *
 * `stored.digest` is the digest of the ledger's own projection at its own
 * revision, computed by `validateLedgerDocument`, so this compares what the
 * edge reports against what the source says the edge should be holding.
 */
function requireEdgeConvergence(converged, stored, code) {
  exactKeys(converged, ['revision', 'digest'], 'invalid-input');
  if (!isCanonicalRevision(converged.revision) || !isNonempty(converged.digest)) refuse('invalid-input');
  if (converged.revision !== stored.revision || converged.digest !== stored.digest) refuse(code);
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
  // `pathNamespace` is PERSISTED as an explicit `null` when the caller omits
  // it, rather than stored as an absence that happens to project to `null`.
  // `deriveCanonicalProjection` reads an absent field as `null`, so the two
  // are the same projection — but `recovery-controller.mjs` validates the RAW
  // hostname document for its source attestation and requires
  // `source.pathNamespace === null`, so a document that merely omits the
  // field can be published and can never be attested, which is exactly the
  // recovery path it would need after a drift. Writing what we project keeps
  // the stored document and the derivation agreeing about a field whose
  // absence is meaningful.
  const provided = Object.hasOwn(input.hostname, 'pathNamespace')
    ? { ...input.hostname }
    : { ...input.hostname, pathNamespace: null };
  const document = Object.hasOwn(provided, 'root') ? provided : { ...provided, status: 'disabled' };
  const desired = project(() => deriveCanonicalProjection(host, document));
  if (desired.kind !== 'tombstone' && desired.pathNamespace !== null) {
    validatePathCapabilityBarrier(input.pathCapabilityBarrier ?? null, clock.iso);
  }
  if (desired.kind === 'route') await requireLiveEvent(transaction, desired.eventId);
  buffer.set(`hostnames/${host}`, document);
  ledgerWrite(buffer, host, '1', desired, clock.stamp, revisions, projections, null);
  return { host, projectedChange: true, resultingHostname: document };
}

async function planUpdate(input, transaction, clock, buffer, revisions, projections) {
  boundedKeys(input, [...MUTATION_KEYS, 'changes'], ['converged'], 'invalid-input');
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
  // Activation is the other door onto an archived Event. `unarchive-barrier`
  // above guards the DOCUMENT's own history; this guards the Event the
  // document points at, which may have been archived after the mapping was
  // created disabled.
  if (statusChange && changes.status === 'active') {
    await requireLiveEvent(transaction, { ...state.hostname, ...changes }.eventId);
    // ACTIVATION IS A CONVERGENCE BARRIER TOO. "Wait for publisher acceptance
    // and edge inspection before activation" is what provision defers to, and
    // "disabled and converge, repoint, active and converge" is what the
    // repoint sequence rests on — and both were only the Firestore half. A
    // caller could provision and activate, or repoint and activate, before
    // the disabled or new-identity revision ever reached the edge, so the
    // host went live at a projection the edge had never accepted. The
    // evidence is the same shape `repoint` takes, compared against the
    // PRIOR ledger, which is the revision activation is supposed to be
    // waiting on.
    requireEdgeConvergence(input.converged, stored, 'activation-requires-convergence');
  }

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
  exactKeys(input, [...MUTATION_KEYS, 'changes', 'converged'], 'invalid-input');
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
  // "active → disabled AND CONVERGE → repoint" — the converge is half the
  // barrier and was the half nothing checked. A disabled `status` in
  // Firestore says only that the disabling revision was written; until the
  // Durable Object has committed it the edge is still serving the previous
  // Event, and moving the identity there hands that Event's traffic to a
  // host whose source now names another one. Checked AFTER the status, so an
  // operator who skipped the disable still reads `repoint-requires-disabled`
  // rather than a convergence complaint about a barrier they have not
  // reached yet.
  requireEdgeConvergence(input.converged, stored, 'repoint-requires-convergence');

  const changes = input.changes;
  validateChanges(changes);
  for (const key of Object.keys(changes)) {
    if (key === 'status') refuse('combined-barrier');
    if (key === 'apexPath') refuse('apex-path-barrier');
    if (!PROJECTED_FIELDS.has(key) && !NON_PROJECTED_FIELDS.has(key)) refuse('unknown-field');
  }
  if (!Object.hasOwn(changes, 'eventId') && !Object.hasOwn(changes, 'slug')) refuse('repoint-requires-identity');
  // Event-scoped metadata does not survive the move. Reset first, then apply
  // `changes`, so a caller that supplies a new `preview` or `adultContent`
  // replaces it and a caller that supplies neither is left with none rather
  // than with the previous Event's.
  const retained = { ...state.hostname };
  for (const field of EVENT_SCOPED_FIELDS) delete retained[field];
  const document = { ...retained, ...changes };
  // The Event the host would point at AFTER the move, which is the one that
  // matters: re-homing a document onto an archived Event publishes a route
  // to it that § D8 retired.
  await requireLiveEvent(transaction, document.eventId);
  const desired = project(() => deriveCanonicalProjection(host, document));
  if (sameValue(desired, stored.desired)) refuse('no-projected-change');
  // A whole-document SET, not a patch: this is the second lifecycle write
  // that replaces rather than merges, for the same reason the mirror-root
  // conversion does — Firestore's delete sentinel is not plumbed through
  // this helper, so removing a field means writing the document without it.
  buffer.set(`hostnames/${host}`, document);
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
 *
 * The `apexPath` half is not optional. An archive with no target named would
 * retire the Event without activating the address that replaces it, which
 * `archive-apex-target-missing` refuses below before the transaction reads
 * anything.
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
  // EXACTLY ONE mapping must take `apexPath`, and the refusal is here, before
  // the first read, because the archive is otherwise a one-way door. § D8 of
  // `specs/path-addressing-and-root.md` retires every mapping and the Event
  // document together and makes the target's apex-path address live in the
  // same transaction; with no target named, the loop below marks nothing, so
  // the Event stops serving at its own hosts while the archive URL it is
  // replaced by never becomes eligible. Nothing can repair that afterwards:
  // an ordinary update refuses to add `apexPath` and refuses to un-archive, so
  // the Event is stranded permanently.
  //
  // One target is also the MOST that can be marked, and that needs no separate
  // refusal: `apexPathHost` is a single host and `hosts` above has already
  // refused a duplicate, so the loop can match it at most once.
  if (apexPathHost === null) refuse('archive-apex-target-missing');
  if (!mappings.includes(apexPathHost)) refuse('apex-path-target-unknown');
  // A configured apex or mirror flagship is retired by CONVERSION, never by
  // being switched to `archived` as a route. Its `status` is what gates the
  // whole HOST, so an archived route on `vacaybingo.com` takes that host's
  // path capability down with it and every other Event addressed by path
  // there stops resolving — which is why § D8 turns such a mapping into the
  // `root: 'not-found'` marker that keeps `pathNamespace`. The caller is
  // pointed at `mirrorRootConversions` rather than converted silently: which
  // marker a retired root host should carry is a decision, not a default.
  for (const host of mappings) {
    if (!ROOT_HOSTS.has(host)) continue;
    refuse(host === apexPathHost ? 'apex-path-target-ineligible' : 'archive-root-host-requires-conversion');
  }
  // The apex the target's archive address would live under has to be able to
  // SIGN A PLAYER IN. § D7 states the precondition: an apex may not serve
  // regime (b) until it is registered as a first-party auth host, and
  // `vacaybingo.com` is not — so an archive parked at `vacaybingo.com/<slug>`
  // renders `auth-unconfigured` rather than the sign-in gate, on an Event
  // that can never be un-archived. Vacay archives belong at
  // `fiveacross.app/<slug>` until that registration lands. Read from the
  // Namespace table rather than from a host literal, so the refusal lifts by
  // editing the set the spec names.
  const targetNamespace = apexPathNamespace(apexPathHost);
  if (targetNamespace === null || !AUTH_READY_PATH_NAMESPACES.has(targetNamespace)) {
    refuse('archive-apex-target-auth-unready');
  }

  const event = (await transaction.get(`events/${eventId}`)) ?? null;
  if (event === null) refuse('event-missing');
  requireCompleteMappingSet(await listEventMappings(transaction, eventId), hosts);
  const states = new Map();
  for (const host of hosts) {
    states.set(host, await readHostState(transaction, host));
  }

  // A mapping that ALREADY carries the flag, read before anything is written.
  //
  // `apexPath` is not projected, so `requireConvergedPreState` below cannot
  // see it: a source and a ledger that agree on the projection agree whether
  // or not the source carries this field. A legacy or partial Admin write can
  // therefore leave the flag on an ACTIVE mapping, and the write loop would
  // preserve it — `changes` names only `status`, and an update is a merge —
  // while adding the flag to the target, leaving the Event with two archived
  // mappings eligible for apex paths. That is refused rather than cleared:
  // which of the two the operator meant is not something this transaction may
  // decide, and silently dropping a flag somebody wrote is the more dangerous
  // repair. This narrows an earlier round's reasoning, which correctly ruled
  // out an ARCHIVED flagged mapping (`archive-requires-active` refuses it) but
  // did not cover an active one.
  for (const host of mappings) {
    if (host === apexPathHost) continue;
    const hostname = states.get(host).hostname;
    if (isRecord(hostname) && hostname.apexPath === true) refuse('archive-apex-flag-carried');
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
    // WHICH marker is a property of the host class, not one answer for every
    // conversion. § D1 gives a canonical apex a doorway once its flagship is
    // archived — the platform's on `fiveacross.app`, the Edition's on
    // `vacaybingo.com`, and the GCB apex becomes its Edition doorway exactly
    // when this transaction retires the live Event — while a brand mirror is
    // deliberately not-found, because a mirror exists to land a Player in the
    // game rather than to answer the emergency with a doorway. Forcing
    // `not-found` everywhere made archiving the live GCB Event impossible to
    // do correctly: including `gaycruisebingo.com` is required for
    // completeness, and the only marker this branch accepted would have left
    // the canonical GCB surface offline instead of on its Edition doorway.
    if (root !== (DOORWAY_ROOT_HOSTS.has(host) ? 'doorway' : 'not-found')) {
      refuse('root-marker-ineligible');
    }
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
    ['schemaVersion', 'intent', 'apply', 'actor', 'reason', 'host', 'convergedRevision', 'convergedDigest'],
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
  // The apex archive address is NOT non-serving, whatever its `status` says.
  // After a legitimate archive the target mapping is `archived` with
  // `apexPath: true`, which is precisely the document that answers the apex
  // path § D8 retired the Event's own subdomain in favour of — so the
  // predicate above reads it as deletable, and deleting it tombstones the
  // address permanently and strands the archive exactly as an archive with no
  // target would have. `apexPath` is not projected, so no revision or digest
  // can carry this fact; it is read from the source document.
  if (state.hostname.apexPath === true) refuse('delete-apex-archive-target');
  // "After inactive convergence" — the operator proves convergence by naming the
  // revision the private audit read back from the Durable Object's committed
  // state. A mismatch means the edge has not accepted the inactive projection
  // yet, so deleting the source would strand a serving route with no source.
  if (!isCanonicalRevision(input.convergedRevision)) refuse('invalid-input');
  if (input.convergedRevision !== stored.revision) refuse('delete-requires-convergence');
  // The revision is not enough on its own. A POISONED object carries the
  // ledger's revision with a different payload — the reconciler classifies
  // exactly that state, and § Audit and recovery lets `apply` repair a
  // different payload at an equal revision — so the edge can report this
  // revision while still serving the route this delete is about to tombstone
  // the source of. The committed DIGEST is what says which payload it holds.
  if (!isNonempty(input.convergedDigest)) refuse('invalid-input');
  if (input.convergedDigest !== stored.digest) refuse('delete-requires-converged-payload');
  const desired = { kind: 'tombstone' };
  buffer.delete(`hostnames/${host}`);
  // The ledger and the DO state are never deleted and the address is never
  // reused: the tombstone is the permanent record of both facts.
  ledgerWrite(buffer, host, nextRevision(stored.revision), desired, clock.stamp, revisions, projections, stored.revision);
  return { host, projectedChange: true, resultingHostname: null };
}

/**
 * What a REPAIR owes the two rules an ordinary write already keeps.
 *
 * `backfill-ledger` and `advance-ledger` both publish a source document that
 * nothing in this helper wrote, and both used to publish it exactly as found.
 * Two things follow from that and neither is optional:
 *
 * 1. NORMALIZE THE SOURCE. An omitted `pathNamespace` derives as `null`, so
 *    the ledger is right, but `recovery-controller.mjs` validates the RAW
 *    document and requires the explicit `null` — a pre-helper route could
 *    therefore be backfilled, published, and then never attested, which is
 *    the one thing it would need after a drift. The default is written onto
 *    the hostname document in the SAME batch as the ledger, so the pair the
 *    edge converges on and the pair an attestor reads are one write.
 *
 * 2. KEEP THE DEPLOYMENT BARRIER. `provision` refuses to publish a non-null
 *    `pathNamespace` without the attested barrier record, and for a legacy or
 *    partial-Admin source a repair is the FIRST edge publication of that
 *    capability — so publishing it here without the barrier arms path routing
 *    before the capability-aware Worker, the cache-schema bump and forced
 *    advancement are, which is the exposure the barrier exists for.
 */
function prepareRepairSource(input, host, hostname, clock, buffer) {
  const desired = project(() => deriveCanonicalProjection(host, hostname));
  if (desired.kind !== 'tombstone' && desired.pathNamespace !== null) {
    if ((input.pathCapabilityBarrier ?? null) === null) refuse('path-capability-barrier-required');
    validatePathCapabilityBarrier(input.pathCapabilityBarrier, clock.iso);
  }
  if (isRecord(hostname) && !Object.hasOwn(hostname, 'pathNamespace')) {
    buffer.update(`hostnames/${host}`, { pathNamespace: null });
    return { desired, resultingHostname: { ...hostname, pathNamespace: null } };
  }
  return { desired, resultingHostname: hostname };
}

async function planBackfill(input, transaction, clock, buffer, revisions, projections) {
  boundedKeys(
    input,
    ['schemaVersion', 'intent', 'apply', 'actor', 'reason', 'host'],
    ['pathCapabilityBarrier'],
    'invalid-input',
  );
  const { host } = input;
  const state = await readHostState(transaction, host);
  guardClaimable(host, state.reservation);
  if (state.hostname === null) refuse('hostname-missing');
  // Backfill creates a missing ledger and changes no PROJECTED field. An
  // existing ledger — however wrong — is a reconciliation question, not a
  // backfill one.
  if (state.ledger !== null) refuse('ledger-exists');
  const { desired, resultingHostname } = prepareRepairSource(input, host, state.hostname, clock, buffer);
  ledgerWrite(buffer, host, '1', desired, clock.stamp, revisions, projections, null);
  return { host, projectedChange: true, resultingHostname };
}

/**
 * Whether the stored ledger CLAIMS to be a tombstone, whatever else is wrong
 * with it. Asked structurally rather than through the validator, because the
 * point is to recognise the claim in a document the validator rejects.
 */
function tombstoneShaped(ledger) {
  return isRecord(ledger) && isRecord(ledger.desired) && ledger.desired.kind === 'tombstone';
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
  boundedKeys(
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
    ['pathCapabilityBarrier'],
    'invalid-input',
  );
  const { host } = input;
  const state = await readHostState(transaction, host);
  guardClaimable(host, state.reservation);
  // A STRING, validated as one. Revisions are canonical decimal text
  // precisely so they stay lossless under `BigInt`, and coercing through
  // `String()` accepted a JSON number — which above `Number.MAX_SAFE_INTEGER`
  // has already been rounded by the time it arrives, so the floor computed
  // from it can name a revision that is not actually above the Durable
  // Object and the repair earns a stale, conflict or gap answer instead.
  if (!isCanonicalRevision(input.durableObjectHighWaterRevision)) refuse('invalid-input');
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
  // A ledger that CLAIMS a tombstone but does not validate is not evidence
  // that the address is free, and this is the one intent that would otherwise
  // read it that way: the advance deliberately tolerates a missing or
  // malformed ledger, because repairing exactly that is what it is for, and
  // `validTombstone` answers false for a malformed one. So a tombstone
  // carrying an extra field, or a timestamp that will not normalise, fell
  // through the retirement check — and if a partial Admin write had also
  // recreated `hostnames/{host}`, the advance republished the retired address
  // as a live route at a higher revision, permanently. The claim is therefore
  // honoured before it is validated: a tombstone-shaped ledger that does not
  // validate refuses for investigation, with or without a source document,
  // because which of the two documents is the corrupt one is exactly what a
  // human has to decide.
  if (tombstoneShaped(state.ledger) && !validTombstone(host, state.ledger)) {
    refuse('tombstoned-address-malformed');
  }
  if (validTombstone(host, state.ledger) && state.hostname !== null) refuse('tombstoned-address');
  const { desired, resultingHostname } = prepareRepairSource(input, host, state.hostname, clock, buffer);
  const highWater = BigInt(input.durableObjectHighWaterRevision);
  // Monotonicity is CONSTRUCTED, not checked: flooring at the greater of the
  // stored revision and the named high-water mark and adding one is what makes
  // "it never lowers a revision" true, so there is no reachable state left for
  // a guard to refuse. Any later edit to this floor has to preserve that
  // property itself rather than expect a check below to catch it.
  const floor = BigInt(storedRevision) > highWater ? BigInt(storedRevision) : highWater;
  const revision = (floor + 1n).toString(10);
  ledgerWrite(buffer, host, revision, desired, clock.stamp, revisions, projections, storedRevision === '0' ? null : storedRevision);
  return { host, projectedChange: true, resultingHostname };
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
