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
 * the one ledger mutation it can make, creating a MISSING ledger, is delegated
 * to `hostname-lifecycle.mjs`, because that helper is what makes "one
 * transaction owns every projected mutation" true rather than customary.
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

function sameCommittedRef(left, right) {
  if (left === null || right === null) return left === right;
  return left.revision === right.revision && left.digest === right.digest;
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
 * null, and proves the recovery history is a single chain while doing so.
 *
 * "Refuses conflicting histories" is enforced here rather than reported,
 * because a history whose records do not chain means the audit's own inputs
 * disagree about what the object did; every comparison downstream would be
 * derived from a state nothing in the system actually reached.
 */
async function collectAudit(dependencies, host) {
  const records = [];
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
      const previous = records.at(-1);
      if (previous !== undefined && !sameCommittedRef(previous.after ?? null, record.before ?? null)) {
        refuse('conflicting-recovery-history', host);
      }
      records.push(record);
    }
    const next = page.nextAfter;
    if (next === null) break;
    if (!NON_NEGATIVE_DECIMAL.test(String(next ?? '')) || BigInt(next) <= BigInt(cursor)) {
      refuse('audit-pagination-unbounded', host);
    }
    cursor = String(next);
  } while (true);
  const terminal = records.at(-1);
  if (terminal !== undefined && !sameCommittedRef(terminal.after ?? null, head.committed ?? null)) {
    // The last thing the object recorded doing is not the state it reports.
    refuse('conflicting-recovery-history', host);
  }
  for (const field of [
    'minimumPublisherEpoch',
    'highestAuthenticatedPublisherEpoch',
    'highestQuarantinedPublisherEpoch',
  ]) {
    if (!NON_NEGATIVE_DECIMAL.test(String(head[field] ?? ''))) refuse('malformed-audit-page', host);
  }
  return { ...head, records, pages };
}

/**
 * The three-way comparison for one host. Returns one primary `state` plus the
 * orthogonal flags an operator must act on separately (a held lock, a
 * quarantined epoch that is still admissible, a permanent tombstone).
 */
function classify(host, entry, audit) {
  const flags = [];
  const unknown = { flags, sourceRevision: null, sourceDigest: null };
  if (isReservedClassHost(host)) return { state: 'reserved-class', ...unknown };

  let canonical = null;
  try {
    canonical = deriveCanonicalProjection(host, entry.hostname ?? null);
  } catch (error) {
    if (error instanceof HostnameProjectionRefusal) {
      return { state: error.code === 'invalid-host' ? 'invalid-host' : 'malformed-source', ...unknown };
    }
    throw error;
  }

  if (entry.routerReplica === null || entry.routerReplica === undefined) {
    return { state: entry.hostname === null ? 'orphan-source' : 'missing-ledger', ...unknown };
  }
  let stored;
  try {
    stored = validateLedgerDocument(host, entry.routerReplica);
  } catch (error) {
    if (error instanceof HostnameProjectionRefusal) return { state: 'malformed-ledger', ...unknown };
    throw error;
  }
  if (stored.desired.kind === 'tombstone') flags.push('tombstoned');
  if (audit.recoveryLock !== null) flags.push('locked');
  // A quarantined publisher epoch is only fenced once the floor sits strictly
  // above it; equal means the quarantined key can still authenticate.
  if (BigInt(audit.minimumPublisherEpoch) <= BigInt(audit.highestQuarantinedPublisherEpoch)) {
    flags.push('epoch-unfenced');
  }
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

const STATES = [
  'already-correct',
  'recovered',
  'missing',
  'missing-ledger',
  'orphan-source',
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
 * Audits — and, in `backfill` mode with `apply: true`, repairs only MISSING
 * ledgers for — every host the source listing returns.
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
