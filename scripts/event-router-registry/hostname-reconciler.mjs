/**
 * The dry-run-first backfill and reconciler (#971), implementing the paragraph
 * `specs/event-router-registry.md` § Provisioning, mutation, and deletion ends
 * on: "The first implementation includes a dry-run-by-default
 * backfill/reconciler."
 *
 * It compares three states for one host — the canonical `hostnames/{host}`
 * document, the private `routerReplicas/{host}` ledger, and the per-host
 * Durable Object's committed/lock/history state read through the authenticated
 * audit endpoint — and says which of them disagree. It writes nothing itself:
 * the one ledger mutation it can make, recreating a ledger that is missing
 * from an edge object that has committed nothing, is delegated to
 * `hostname-lifecycle.mjs`, because that helper is what makes "one transaction
 * owns every projected mutation" true rather than customary.
 *
 * What deliberately does not participate: KV, the Cache API, a Firestore
 * acknowledgement write recording that the publisher delivered, and any runtime
 * fallback that would let a serving path read the source. The first three are
 * ruled out by the exact dependency set below; the fourth cannot arise because
 * this command runs outside the request path with Admin credentials.
 *
 * Both listings paginate. The source list follows its page token and each
 * host's audit follows `nextAfter` to null, because a host with a long recovery
 * history would otherwise be reported from its first 100 records — which is
 * exactly the host whose history most needs reading.
 */
import {
  deriveCanonicalProjection,
  HostnameProjectionRefusal,
  isRecord,
  isReservedClassHost,
  sameValue,
  validateHostShape,
  validateLedgerDocument,
} from './hostname-projection.mjs';

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;

/**
 * Exactly these seams, for the reason the header gives: an exact set is what
 * keeps a later caller from handing the reconciler a KV namespace, a cache, or
 * an acknowledgement writer.
 */
const DEPENDENCY_KEYS = ['now', 'listSourcePage', 'readHostAuditPage', 'applyMutation'];

/** Page ceilings, so a provider that never terminates a cursor fails closed. */
const MAX_SOURCE_PAGES = 1000;
const MAX_AUDIT_PAGES = 1000;

export class HostnameReconcilerRefusal extends Error {
  constructor(code, host) {
    super(host === undefined ? `reconciliation refused: ${code}` : `reconciliation refused: ${code} (${host})`);
    this.name = 'HostnameReconcilerRefusal';
    this.code = code;
    this.host = host ?? null;
  }
}

function refuse(code, host) {
  throw new HostnameReconcilerRefusal(code, host);
}

function isNonempty(value) {
  return typeof value === 'string' && value.length > 0;
}

function exactKeys(value, expected, code, host) {
  if (!isRecord(value)) refuse(code, host);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    refuse(code, host);
  }
}

/**
 * Validates one `CommittedRef` and answers it normalized, or null for an
 * uninitialized object. Every comparison below and `classify`'s revision
 * arithmetic read these fields, so a malformed one is a malformed audit page
 * rather than a `BigInt` throw from the middle of a chain check.
 */
function committedRef(value, host) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !POSITIVE_DECIMAL.test(String(value.revision ?? '')) || !isNonempty(value.digest)) {
    refuse('malformed-audit-page', host);
  }
  return { revision: String(value.revision), digest: value.digest };
}

/**
 * Whether the object could have moved from `earlier` to `later` at all: an
 * uninitialized object precedes every committed state, committed state is
 * never withdrawn once it exists, and no path lowers the accepted revision
 * (`specs/event-router-registry.md` § Invariants and threat model, 5).
 */
function notLowered(earlier, later) {
  if (earlier === null) return true;
  if (later === null) return false;
  return BigInt(later.revision) >= BigInt(earlier.revision);
}

/**
 * Whether ORDINARY PUBLISHER SYNCS alone could have carried the object from
 * `earlier` to `later` — the relation that holds across a span the recovery
 * history does not record.
 *
 * It is `notLowered` plus one thing sync cannot do: change the payload at an
 * unchanged revision. The sync table in § The per-host Durable Object answers
 * an equal revision with `200 replay` when the payload is byte-equivalent and
 * `409 revision-conflict` when it is not, and neither commits, so an equal
 * revision across the span forces an equal digest.
 */
function publisherReachable(earlier, later) {
  if (!notLowered(earlier, later)) return false;
  if (earlier === null || later === null) return true;
  return BigInt(later.revision) > BigInt(earlier.revision) || earlier.digest === later.digest;
}

function validateDependencies(dependencies) {
  exactKeys(dependencies, DEPENDENCY_KEYS, 'invalid-dependencies');
  for (const key of DEPENDENCY_KEYS) {
    if (typeof dependencies[key] !== 'function') refuse('invalid-dependencies');
  }
}

function authoritativeNow(dependencies) {
  let value;
  try {
    value = dependencies.now();
  } catch {
    refuse('authoritative-clock-unavailable');
  }
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(time)) refuse('authoritative-clock-unavailable');
  return new Date(time).toISOString();
}

/**
 * Walks the source listing to its end. The token must change on every page:
 * a provider that repeats one would otherwise spin, and a reconciler that spins
 * looks exactly like a reconciler that is still working.
 */
async function collectSource(dependencies, pageSize) {
  const entries = [];
  const seenTokens = new Set();
  const seenHosts = new Set();
  let pageToken = null;
  let pages = 0;
  do {
    if (pages >= MAX_SOURCE_PAGES) refuse('source-pagination-unbounded');
    const page = await dependencies.listSourcePage({ pageToken, pageSize });
    pages += 1;
    exactKeys(page, ['entries', 'nextPageToken'], 'malformed-source-page');
    if (!Array.isArray(page.entries)) refuse('malformed-source-page');
    for (const entry of page.entries) {
      exactKeys(entry, ['host', 'hostname', 'routerReplica'], 'malformed-source-page');
      if (!isNonempty(entry.host)) refuse('malformed-source-page');
      if (seenHosts.has(entry.host)) refuse('duplicate-source-host', entry.host);
      seenHosts.add(entry.host);
      entries.push(entry);
    }
    const next = page.nextPageToken;
    if (next === null) break;
    if (!isNonempty(next) || seenTokens.has(next)) refuse('source-pagination-unbounded');
    seenTokens.add(next);
    pageToken = next;
  } while (true);
  return { entries, pages };
}

/**
 * Reads one host's complete Durable Object audit, following `nextAfter` to
 * null, and proves the recovery history is consistent while doing so.
 *
 * "Refuses conflicting histories" is enforced here rather than reported,
 * because a history whose records contradict each other means the audit's own
 * inputs disagree about what the object did; every comparison downstream would
 * be derived from a state nothing in the system actually reached.
 *
 * What the records are NOT is a complete log of the object's committed
 * transitions. A record is appended by a transaction that changes committed or
 * lock state THROUGH RECOVERY; an ordinary publisher `sync` commits a new
 * revision with no record at all (`applyPublisherSync` in
 * `worker/src/registry/state.ts` returns a new `committed` and an untouched
 * `recoverySequence`). So a recovered host that is later updated normally has
 * a gap between its last record's `after` and the state the object reports,
 * and two recovery episodes separated by one ordinary revision have a gap
 * between them. Requiring equality across those gaps refused a whole
 * reconciliation run over entirely valid history. The chain is therefore
 * checked as what the spec actually guarantees: contiguous sequences from 1,
 * a record that does not lower its own revision, and a span between records —
 * or between the last record and the reported state — that ordinary publisher
 * syncs could have produced.
 */
async function collectAudit(dependencies, host) {
  const records = [];
  let previousAfter = null;
  let cursor = '0';
  let pages = 0;
  let head = null;
  do {
    if (pages >= MAX_AUDIT_PAGES) refuse('audit-pagination-unbounded', host);
    const page = await dependencies.readHostAuditPage({ host, afterRecoverySequence: cursor });
    pages += 1;
    exactKeys(
      page,
      [
        'committed',
        'minimumPublisherEpoch',
        'highestAuthenticatedPublisherEpoch',
        'highestQuarantinedPublisherEpoch',
        'recoveryLock',
        'lookup',
        'records',
        'nextAfter',
      ],
      'malformed-audit-page',
      host,
    );
    if (head === null) head = page;
    if (!Array.isArray(page.records)) refuse('malformed-audit-page', host);
    for (const record of page.records) {
      if (!isRecord(record) || !POSITIVE_DECIMAL.test(String(record.sequence ?? ''))) {
        refuse('malformed-audit-page', host);
      }
      // The history is append-only and contiguous from sequence 1, so the very
      // first record of the very first page is as load-bearing as the chain
      // between records: a page that opens at 2 has skipped whatever 1 did.
      if (BigInt(record.sequence) !== BigInt(records.length + 1)) {
        refuse('conflicting-recovery-history', host);
      }
      const before = committedRef(record.before ?? null, host);
      const after = committedRef(record.after ?? null, host);
      // Internal consistency only: an `apply` may repair a DIFFERENT payload
      // at the equal revision or jump to a higher one (§ Audit and recovery,
      // step 2), so a record's own digests may differ where its revisions do
      // not. All it may never do is lower the revision.
      if (!notLowered(before, after)) refuse('conflicting-recovery-history', host);
      if (records.length > 0 && !publisherReachable(previousAfter, before)) {
        refuse('conflicting-recovery-history', host);
      }
      previousAfter = after;
      records.push(record);
    }
    const next = page.nextAfter;
    if (next === null) break;
    if (!NON_NEGATIVE_DECIMAL.test(String(next ?? '')) || BigInt(next) <= BigInt(cursor)) {
      refuse('audit-pagination-unbounded', host);
    }
    cursor = String(next);
  } while (true);
  const committed = committedRef(head.committed ?? null, host);
  if (records.length > 0 && !publisherReachable(previousAfter, committed)) {
    // The state the object reports is not one it could have reached from the
    // last thing it recorded doing, even allowing for unrecorded syncs.
    refuse('conflicting-recovery-history', host);
  }
  // The floor is POSITIVE; only the two high-water marks may be zero.
  //
  // `RegistryState` initializes `minimumPublisherEpoch` to `1` and
  // `parseStoredRegistryState` requires a canonical positive decimal for it,
  // while zero is the no-quarantine sentinel the other two carry before
  // anything has happened. Accepting `0` here took malformed edge evidence as
  // fact — and it is the value the epoch-fence comparison below is least able
  // to read, since a floor of zero is not a floor at all. Validated
  // separately so the reconciler fails closed on an adapter that answers a
  // shape the Durable Object never stores.
  if (!POSITIVE_DECIMAL.test(String(head.minimumPublisherEpoch ?? ''))) refuse('malformed-audit-page', host);
  for (const field of ['highestAuthenticatedPublisherEpoch', 'highestQuarantinedPublisherEpoch']) {
    if (!NON_NEGATIVE_DECIMAL.test(String(head[field] ?? ''))) refuse('malformed-audit-page', host);
  }
  return { ...head, committed, records, pages };
}

/** Whether this projection may describe the host at all, asked without throwing. */
function projectableHost(host) {
  try {
    validateHostShape(host);
    return true;
  } catch (error) {
    if (error instanceof HostnameProjectionRefusal) return false;
    throw error;
  }
}

/**
 * The three-way comparison for one host. Returns one primary `state` plus the
 * orthogonal flags an operator must act on separately (a held lock, a
 * quarantined epoch that is still admissible, a permanent tombstone).
 *
 * "Orthogonal" is load-bearing: the lock and the epoch fence come from the
 * audit rather than from the comparison, so they are reported on EVERY audited
 * host, including the ones classified before a ledger is ever read. Only
 * `tombstoned` waits, because only it is a property of the ledger; and only
 * `reserved-class` carries nothing, because that host is never audited at all.
 */
function classify(host, entry, audit) {
  const flags = [];
  const unknown = { flags, sourceRevision: null, sourceDigest: null };
  // The classifications reached with no audit at all: the caller returns a
  // reserved-class or invalid-host row before it reads the Durable Object, so
  // there is no lock or epoch state to report and the two flags below must
  // stay behind this. `invalid-host` never reaches here for that reason;
  // reserved-class is restated so the function is total on its own inputs.
  if (isReservedClassHost(host)) return { state: 'reserved-class', ...unknown };

  // The lock and the epoch fence are properties of the audited edge object
  // alone, so they are read BEFORE anything that can classify the host early.
  // A host whose source document will not parse, or that has no ledger for a
  // backfill to compare against, is exactly the host an operator acts on, and
  // acting on it while a recovery lock is held is what the flag exists to
  // prevent. `unknown` closes over this same array, so every early return
  // below carries whatever is pushed here.
  if (audit.recoveryLock !== null) flags.push('locked');
  // Zero is the registry's no-quarantine sentinel, not an epoch: `RegistryState`
  // initializes `highestQuarantinedPublisherEpoch` to it and only a
  // `publisherReplacement` raises it, so there is no quarantined key for a
  // floor to fence until it is above zero. `recovery.ts` reads it the same way
  // before deciding a replacement is required. Only once a quarantine has
  // happened is the fence tested, and then it is strict: an equal floor still
  // lets the quarantined key authenticate.
  if (
    BigInt(audit.highestQuarantinedPublisherEpoch) > 0n &&
    BigInt(audit.minimumPublisherEpoch) <= BigInt(audit.highestQuarantinedPublisherEpoch)
  ) {
    flags.push('epoch-unfenced');
  }

  let canonical = null;
  try {
    canonical = deriveCanonicalProjection(host, entry.hostname ?? null);
  } catch (error) {
    if (error instanceof HostnameProjectionRefusal) {
      // `invalid-host` cannot arrive here: the caller validated the host
      // before the audit and reported it without one. What is left is a
      // source document this host may not hold.
      return { state: 'malformed-source', ...unknown };
    }
    throw error;
  }

  if (entry.routerReplica === null || entry.routerReplica === undefined) {
    // `no-documents` is the listing naming a host that has NEITHER document —
    // nothing to project and nothing projected — which backfill must not treat
    // as a ledger it can create. It was named `orphan-source` and read as the
    // opposite of its neighbour `missing-ledger`, which is a source with no
    // ledger.
    if (entry.hostname === null) return { state: 'no-documents', ...unknown };
    // Backfill recreates the ledger at revision 1, and an UNINITIALIZED object
    // is the only edge that accepts revision 1 (§ The per-host Durable Object:
    // "An uninitialized object accepts revision 1 only"). A ledger that went
    // missing under an object that has already committed something is the
    // source-behind condition by another name, and backfilling it would write
    // a revision the edge answers `409 revision-gap` or `ignored-stale` while
    // the report said `backfilled`. Its repair is the explicit Admin
    // `advance-ledger` above the DO high-water mark, which this command
    // deliberately does not perform: that intent requires an incident URL and
    // a human reason the reconciler has neither of and cannot invent, and
    // § Provisioning, mutation, and deletion makes it the explicit human
    // transaction. So the state is reported, and an operator runs it.
    return {
      state: (audit.committed ?? null) === null ? 'missing-ledger' : 'missing-ledger-source-behind',
      ...unknown,
    };
  }
  let stored;
  try {
    stored = validateLedgerDocument(host, entry.routerReplica);
  } catch (error) {
    if (error instanceof HostnameProjectionRefusal) return { state: 'malformed-ledger', ...unknown };
    throw error;
  }
  // `tombstoned` stays here, and only here: it is a property of the LEDGER,
  // so it cannot be read until the ledger exists and validates.
  if (stored.desired.kind === 'tombstone') flags.push('tombstoned');
  const known = { flags, sourceRevision: stored.revision, sourceDigest: stored.digest };
  if (!sameValue(canonical, stored.desired)) return { state: 'drifted', ...known };

  const committed = audit.committed ?? null;
  if (committed === null) return { state: 'missing', ...known };
  const source = BigInt(stored.revision);
  const edge = BigInt(committed.revision);
  if (edge > source) return { state: 'source-behind', ...known };
  if (edge < source) return { state: 'edge-behind', ...known };
  // Same revision, different payload: the edge accepted bytes this ledger did
  // not produce, which is the `409 revision-conflict` signature seen after the
  // fact rather than at the boundary.
  if (committed.digest !== stored.digest) return { state: 'poisoned', ...known };
  if (audit.records.length > 0) return { state: 'recovered', ...known };
  return { state: 'already-correct', ...known };
}

/**
 * Every classification `classify` can return, and the exact set `counts` is
 * seeded from. `backfilled` is deliberately NOT here: it is not something a
 * host can be classified as, it is what an applied backfill turns a
 * `missing-ledger` row into, and it is seeded onto `counts` separately below
 * so a report always carries it at zero rather than only after a repair.
 * `specs/event-router-registry.md` § Provisioning, mutation, and deletion
 * enumerates both halves and must stay equal to this list.
 */
const STATES = [
  'already-correct',
  'recovered',
  'missing',
  'missing-ledger',
  'missing-ledger-source-behind',
  'no-documents',
  'drifted',
  'poisoned',
  'source-behind',
  'edge-behind',
  'malformed-source',
  'malformed-ledger',
  'invalid-host',
  'reserved-class',
];

function validateInput(input) {
  exactKeys(input, ['schemaVersion', 'mode', 'apply', 'actor', 'reason', 'sourcePageSize'], 'invalid-input');
  if (input.schemaVersion !== 1) refuse('invalid-input');
  if (input.mode !== 'audit' && input.mode !== 'backfill') refuse('invalid-input');
  if (typeof input.apply !== 'boolean') refuse('invalid-input');
  if (!isNonempty(input.actor)) refuse('invalid-input');
  if (!isNonempty(input.reason) || input.reason.trim() !== input.reason) refuse('invalid-input');
  if (!Number.isInteger(input.sourcePageSize) || input.sourcePageSize < 1 || input.sourcePageSize > 500) {
    refuse('invalid-input');
  }
}

/**
 * Audits — and, in `backfill` mode with `apply: true`, repairs only the
 * `missing-ledger` hosts among — every host the source listing returns.
 *
 * `missing-ledger` is deliberately narrower than "has no ledger": it is a
 * source document with no ledger AND an edge object that has committed
 * nothing, which is the only edge a revision-1 backfill can converge on. Its
 * sibling `missing-ledger-source-behind` is reported and never repaired here.
 *
 * Idempotent in both modes: a second apply run finds the ledgers it created and
 * classifies them, rather than writing again.
 */
export async function reconcileHostnameReplicas(input, dependencies) {
  validateInput(input);
  validateDependencies(dependencies);
  const observedAt = authoritativeNow(dependencies);

  const { entries, pages: sourcePages } = await collectSource(dependencies, input.sourcePageSize);
  const hosts = [];
  const applied = [];
  let auditPages = 0;

  for (const entry of entries) {
    const { host } = entry;
    if (isReservedClassHost(host)) {
      // #970's controller owns every synthetic state; this command neither
      // audits its Durable Object nor repairs it.
      hosts.push({
        host,
        state: 'reserved-class',
        flags: [],
        sourceRevision: null,
        committedRevision: null,
        digestMatches: null,
        recoveryRecordCount: null,
      });
      continue;
    }
    // The SECOND classification reached with no audit at all, and it has to
    // be: the deployed audit endpoint requires `host === normalizeHost(host)`
    // and answers 400 for anything else, so a single non-canonical document
    // id — an uppercase host, a reserved label — made `collectAudit` fail and
    // took the whole reconciliation down with it, producing no report at all
    // instead of one bad row among the good ones. A row nothing can audit is
    // reported the way `reserved-class` is: no lock, no epoch, no revisions,
    // because there is no audited object to have read them from.
    if (!projectableHost(host)) {
      hosts.push({
        host,
        state: 'invalid-host',
        flags: [],
        sourceRevision: null,
        committedRevision: null,
        digestMatches: null,
        recoveryRecordCount: null,
      });
      continue;
    }
    const audit = await collectAudit(dependencies, host);
    auditPages += audit.pages;
    const verdict = classify(host, entry, audit);
    const committed = audit.committed ?? null;
    const row = {
      host,
      state: verdict.state,
      flags: verdict.flags,
      sourceRevision: verdict.sourceRevision,
      committedRevision: committed === null ? null : committed.revision,
      digestMatches:
        committed === null || verdict.sourceDigest === null ? null : committed.digest === verdict.sourceDigest,
      recoveryRecordCount: audit.records.length,
    };
    hosts.push(row);

    if (input.mode === 'backfill' && input.apply && verdict.state === 'missing-ledger') {
      const result = await dependencies.applyMutation({
        schemaVersion: 1,
        intent: 'backfill-ledger',
        apply: true,
        actor: input.actor,
        reason: input.reason,
        host,
      });
      if (!isRecord(result) || !Array.isArray(result.revisions) || result.revisions.length !== 1) {
        refuse('backfill-result-malformed', host);
      }
      applied.push({ host, revision: result.revisions[0].to });
      row.state = 'backfilled';
    }
  }

  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  counts.backfilled = 0;
  for (const row of hosts) counts[row.state] = (counts[row.state] ?? 0) + 1;
  const flagCounts = { tombstoned: 0, locked: 0, 'epoch-unfenced': 0 };
  for (const row of hosts) for (const flag of row.flags) flagCounts[flag] += 1;

  return {
    dryRun: !input.apply,
    mode: input.mode,
    observedAt,
    actor: input.actor,
    reason: input.reason,
    total: hosts.length,
    counts,
    flagCounts,
    hosts,
    applied,
    pages: { source: sourcePages, audit: auditPages },
    // The report carries host and revision identifiers only: no OIDC token, no
    // signature, no route payload, and no credential material of any kind.
    credentialMaterialOmitted: true,
  };
}
