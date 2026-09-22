// The Event lookup at the edge, against the App Check-compatible registry
// (#972, epic #888; specs/event-router-registry.md, ADR 0014).
//
// This module used to point-get `hostnames/{host}` over the Firestore REST API
// with the Firebase web api key, in front of a `caches.default` envelope with a
// TTL and a stale-serve path. All of it is gone, and the removal is the point
// rather than a side effect: enforced Cloud Firestore rejects an unattested
// REST caller regardless of the public `allow get` rule, so a router that reads
// Firestore at all can only be routed by weakening the control #44 exists to
// add. What replaces it is one strongly consistent point call into a per-host
// Durable Object through a named lookup-only service binding.
//
// THERE IS NO FALLBACK BEHIND IT — not Firestore, not KV, not the Cache API,
// not a negative or stale envelope. That is a deliberate trade rather than an
// omission: the registry object is the single transactional owner of acceptance
// and lookup, so a second cached answer could only ever disagree with it, and a
// router that serves a mapping the registry has retracted is worse than one
// that fails closed for the length of an outage. Every failure below is a
// rendered not-found with a closed reason header.
//
// Every seam is injected (`registry`), so the whole decision table below is
// exercised by `resolve.test.ts` with no workerd, no Durable Object and no
// network — the same convention `specs/event-resolution.md` sets for the client
// resolver, and the reason `worker/src/index.ts` is still the only file here
// that knows it is running on Cloudflare.

import {
  hasExactDesiredKeys,
  isCanonicalRevision,
  isRegistryEdition,
  isRegistryRootHost,
  isReplicaRootMarker,
  isReplicaRouteStatus,
  isSyntheticRootTestHost,
  registryHostPathNamespace,
  registryRootHostEdition,
  type PathNamespace,
  type RegistryEdition,
} from './registry/contracts';
import type { RegistryLookup, RegistryLookupService } from './registry/state';
import { validateSlug } from '../../src/slug';

export type { RegistryLookupService };

export type NotFoundReason =
  /** No committed projection for this address — an uninitialized object, or a
   *  tombstone, which is permanent and reads the same way from outside. The
   *  ordinary unknown-address case. */
  | 'unknown-host'
  /** A committed route whose `status` is not `active` — disabled or archived. */
  | 'inactive'
  /** The registry answered, and its committed projection is malformed, carries
   *  a shape this router does not support, or is bound to a different
   *  canonical hostname than the one looked up. Distinguished from
   *  `lookup-unavailable` because it alerts and will not heal on a retry. */
  | 'replica-malformed'
  /** A committed route whose denormalised `slug` names a different first label
   *  than the address it was reached at. */
  | 'slug-mismatch'
  /** A committed route carrying no `slug` to cross-check against. */
  | 'slug-missing'
  /** The lookup itself could not be completed: no registry binding, or the
   *  service call rejected or exceeded the bound. The only reason that is about
   *  US rather than about the address. */
  | 'lookup-unavailable';

/**
 * The projection the router serves from — and the whole of it.
 *
 * It carries no membership, no Event data, no adult-content posture and no
 * hostname catalogue, because the router routes: the application resolves all
 * of that for itself and never accepts the edge's `eventId` as its own
 * Resolution (ADR 0014 invariant 2). `edition` and the root/path-capability
 * fields are present only because #546's per-host identity and the accepted
 * path-addressing contract must render without a second lookup.
 */
export interface ServedRecord {
  /** `null` for a root marker: a configured origin that is not itself an Event. */
  eventId: string | null;
  /** A validated canonical decimal — the only shape that reaches the
   *  `x-event-router-revision` header. */
  revision: string;
  pathNamespace: PathNamespace;
  edition: RegistryEdition;
  /** `doorway` or `not-found` for a root marker, `null` for a route. It
   *  controls the APP's `/` outcome, never whether the edge may serve. */
  root: 'doorway' | 'not-found' | null;
}

export type Resolution =
  | { kind: 'serve'; record: ServedRecord }
  | {
      kind: 'not-found';
      reason: NotFoundReason;
      /**
       * The committed revision this refusal was decided FROM, or `null` when
       * there was none to decide from.
       *
       * A fail-closed answer is not automatically a revision-less one.
       * `specs/event-router-registry.md` § Failure semantics says a resolved
       * edge record carries `x-event-router-revision`, and § Audit and recovery
       * makes that header load-bearing rather than decorative: a
       * `canonical-after-unblock` probe observation is `{reason, revision}`
       * together for `null`, `inactive` AND `unknown-host`, and `clear-lock`
       * consumes three of them "whose host/result/revision equal committed
       * state". A router that dropped the revision on the two refusals the
       * recovery machine can be asked to prove would leave those hosts unable
       * to clear a lock — and therefore unable to accept another publisher
       * update — for as long as the state persisted.
       *
       * So it is non-null for exactly the refusals the router decided FROM a
       * committed record it could attribute to this address: `inactive`, and
       * the `unknown-host` a tombstone produces. It is `null` for the refusals
       * that are about the absence of a usable record rather than its content —
       * an uninitialized object, an unavailable lookup, a malformed projection,
       * and a record whose Slug names a different address, none of which the
       * probe contract models and none of which the router may claim to be
       * serving a revision for.
       */
      revision: string | null;
    };

export interface ResolveConfig {
  /** Hard bound on the whole registry service call. */
  lookupTimeoutMs: number;
}

export interface ResolveDeps {
  /** The named lookup-only registry entrypoint, or `null` when the binding is
   *  absent. Absent is a configuration fact the router must ANSWER rather than
   *  crash in — the same reason `config.ts` normalises an unbound string
   *  binding to `''` instead of leaving it `undefined`. */
  registry: RegistryLookupService | null;
  /**
   * Where the two refusals the registry spec pages on are reported
   * (§ Failure semantics: `replica-malformed` and `lookup-unavailable` both say
   * "alert"). A closed, bounded event — the reason and the host, never the
   * lookup's contents — so a permanently broken projection is distinguishable
   * from an ordinary unknown host in monitoring (Phase 4b P2, #1120).
   * Optional: the decision table is unchanged whether or not anyone listens.
   */
  diagnostics?: (event: RouterDiagnosticEvent) => void;
}

/** The closed shape every router-side alert carries. */
export interface RouterDiagnosticEvent {
  event: 'event-router.diagnostic';
  outcome: 'replica-malformed' | 'lookup-unavailable';
  host: string;
}

const ALERTED_REASONS: ReadonlySet<NotFoundReason> = new Set(['replica-malformed', 'lookup-unavailable']);

/**
 * Emit one router-side diagnostic through the seam. Exported so the router can
 * report the refusal it decides BEFORE `resolveHost` runs — an absent binding
 * — under the same closed shape (Codex P2 on #1120): the spec's Failure
 * semantics page on that case, and a deployment-wide misconfiguration is the
 * one failure this alerting most needs to see.
 */
export function reportDiagnostic(
  deps: Pick<ResolveDeps, 'diagnostics'>,
  host: string,
  outcome: RouterDiagnosticEvent['outcome'],
): void {
  if (!deps.diagnostics) return;
  try {
    deps.diagnostics({ event: 'event-router.diagnostic', outcome, host });
  } catch {
    // A diagnostic must never turn a closed refusal into an escaping error.
  }
}

function reportRefusal(deps: ResolveDeps, host: string, resolution: Resolution): Resolution {
  if (resolution.kind === 'not-found' && ALERTED_REASONS.has(resolution.reason)) {
    reportDiagnostic(deps, host, resolution.reason as RouterDiagnosticEvent['outcome']);
  }
  return resolution;
}

/** `revision` defaults to `null`, so a refusal only carries one where the arm
 *  deciding it says so. */
function notFound(reason: NotFoundReason, revision: string | null = null): Resolution {
  return { kind: 'not-found', reason, revision };
}

/**
 * The exact key set each LOOKUP ENVELOPE arm may carry.
 *
 * The same rule the projection gets, one level up, and for the same reason. An
 * envelope that carries a field its arm does not define is internally
 * contradictory — `{kind: 'unknown-host', revision, schemaVersion, desired}` is
 * a registry that has said "nothing here" and handed over a projection in the
 * same breath — and validating only the fields the arm happens to read would
 * publish that revision as canonical recovery evidence off a record this Worker
 * never actually agreed with. `parseDesired` refuses contradictory shapes on
 * the way in; a separately deployed consumer has to refuse them on the way out.
 *
 * `revision`, `schemaVersion` and `host` are optional on the `unknown-host`
 * arm, so it is expressed as the keys ALLOWED rather than the keys required;
 * the pairing rule below is what makes the optional trio coherent.
 */
const ENVELOPE_KEYS: Record<string, readonly string[]> = {
  'unknown-host': ['host', 'kind', 'revision', 'schemaVersion'],
  unavailable: ['kind'],
  malformed: ['kind'],
  committed: ['desired', 'host', 'kind', 'revision', 'schemaVersion'],
};

function hasExactEnvelopeKeys(lookup: RegistryLookup): boolean {
  // An OWN-property lookup, and a string discriminant, before the table is
  // indexed at all. `ENVELOPE_KEYS` is an ordinary object literal, so it
  // inherits every member of `Object.prototype`: `{kind: 'constructor'}`,
  // `{kind: 'toString'}` and `{kind: '__proto__'}` each select an inherited
  // member that is not an array, and `allowed.includes` throws on it. That
  // throw does not stay inside the module — `decide` runs OUTSIDE the
  // `try/catch` in `resolveHost`, which brackets the bounded service call
  // only — so a registry answer carrying one of those three strings escapes as
  // a runtime error and an unversioned Cloudflare error page, instead of the
  // `replica-malformed` this table promises for every arm it does not
  // recognise (Codex P2 on #1120). A non-string `kind` is refused for the same
  // reason it is refused everywhere else here: it is not a discriminant this
  // envelope defines.
  const kind: unknown = (lookup as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !Object.hasOwn(ENVELOPE_KEYS, kind)) return false;
  const allowed = ENVELOPE_KEYS[kind];
  const actual = Object.keys(lookup);
  return actual.every((key) => allowed.includes(key));
}

/**
 * Whether an envelope that NAMES a canonical host names this one, compared
 * byte for byte (#1133).
 *
 * The comparison is `===` against the host the lookup was made for, with no
 * normalisation, no case folding and no trailing-dot tolerance, because both
 * sides are already canonical: the registry stores `hostnameKey(host)` as the
 * committed payload's `host` and as the object's own document ID, and
 * `RegistryLookupEntrypoint` refuses a raw host that does not equal its own
 * normalisation before it ever reaches an object. Anything this comparison
 * would have had to normalise is therefore a defect on one side or the other,
 * and normalising it here would be this module quietly repairing a projection
 * it cannot vouch for — the coercion the whole boundary revalidation exists to
 * refuse.
 *
 * Presence is a separate question from equality, and the two arms answer it
 * differently: a committed projection must always name its host, while an
 * uninitialized object has no committed record to name one from.
 */
function namesCanonicalHost(lookup: RegistryLookup, host: string): boolean {
  return (lookup as { host?: unknown }).host === host;
}

/**
 * The projection schema versions THIS router build knows how to interpret.
 *
 * Declared here rather than imported from the registry's contracts module, and
 * the distinction is the whole mechanism: the registry stamps a committed
 * record with the version it was WRITTEN under, and this set is the version or
 * versions this deployment can READ. They are different facts about two
 * separately deployed Workers, and a single shared constant would silently make
 * every registry schema bump look supported to a router that had merely been
 * rebuilt against it.
 *
 * Widening it is therefore a deliberate edit made together with the code that
 * understands the new shape — never a consequence of the registry moving.
 */
const SUPPORTED_PROJECTION_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

/**
 * Fail-closed on the version BEFORE anything is read out of the record.
 *
 * `specs/event-router-registry.md` § Failure semantics gives unsupported
 * committed state the same closed answer as malformed state, and this is the
 * only check that can deliver it: a future schema whose `desired` keeps today's
 * discriminants — an additive v2 — is byte-indistinguishable from a v1 route
 * once the version is gone, so a router that reads the projection first has
 * already served it under the wrong rules. Absent, non-numeric and merely
 * unrecognised versions are all the same answer, because "I cannot tell what
 * this record means" is one condition however it arrives.
 */
function isSupportedProjectionSchemaVersion(value: unknown): value is number {
  return typeof value === 'number' && SUPPORTED_PROJECTION_SCHEMA_VERSIONS.has(value);
}

/**
 * Whether the projection's `pathNamespace` is the one this host may carry.
 *
 * Compared against a single expected VALUE rather than against membership of
 * the closed set, because membership is not the rule: `fiveacross.app` is a
 * valid namespace and a valid value for the apex, and simultaneously an invalid
 * value for `bodega-bay.fiveacross.app`. A set test would accept the second and
 * publish a path capability claiming an Event subdomain is path-addressed,
 * which is precisely what the accepted path-addressing contract forbids.
 */
function hostPathNamespace(host: string, pathNamespace: PathNamespace): boolean {
  return pathNamespace === registryHostPathNamespace(host);
}

/**
 * Bound the ENTIRE service call, not a request inside it.
 *
 * The Firestore reader could hand `AbortSignal.timeout` to `fetch` and be done;
 * an RPC call over a service binding has no such signal, so the bound has to be
 * a race the caller owns. Unbounded, a hung registry would put every request on
 * the wrong side of a stalled dependency — the failure class the 2,000 ms bound
 * exists to prevent, and the one an edge router can least afford because it
 * sits in front of the origin rather than beside it.
 *
 * The timer is always cleared, so a fast lookup does not leave the isolate
 * holding a pending timeout for the rest of the bound.
 */
async function boundedLookup(
  registry: RegistryLookupService,
  host: string,
  timeoutMs: number,
): Promise<RegistryLookup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      registry.lookup(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('event-router: registry lookup timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One point lookup, and nothing else.
 *
 * Note what is NOT here any more: no cache read, no TTL comparison, no
 * stale-serve, no drop-on-refusal, no negative-caching asymmetry. Every one of
 * those existed to soften a slow or unreachable Firestore, and every one of
 * them was a second answer to "is this address in service?" that could disagree
 * with the first. The registry object is strongly consistent with its own
 * committed state, so the correct behaviour on a failed lookup is to say so.
 */
export async function resolveHost(
  host: string,
  expectedSlug: string | null,
  config: ResolveConfig,
  deps: ResolveDeps,
): Promise<Resolution> {
  if (deps.registry === null) return reportRefusal(deps, host, notFound('lookup-unavailable'));

  let lookup: RegistryLookup;
  try {
    lookup = await boundedLookup(deps.registry, host, config.lookupTimeoutMs);
  } catch {
    // A rejected or timed-out service call is indistinguishable from an
    // unavailable object from here, and both demand the same closed answer.
    // The rejection is swallowed rather than propagated so the response stays
    // inside the router's contract: an escaping rejection would hand the
    // response to Cloudflare and lose the version stamp an operator uses to
    // prove this Worker handled the host.
    return reportRefusal(deps, host, notFound('lookup-unavailable'));
  }

  return reportRefusal(deps, host, decide(host, lookup, expectedSlug));
}

/**
 * The fail-closed decision table. Every arm that is not an explicit,
 * well-formed, active, address-matching projection is a not-found — never an
 * inferred active.
 *
 * It re-validates the projection it was handed AGAINST THE HOST it was fetched
 * for, and that is not belt-and-braces over the Durable Object's own parse. The
 * service binding is a boundary between two separately deployed Workers: what
 * arrives is a contract this module did not write, one field of it is reflected
 * into a response header and another into a public capability projection, and a
 * Worker built against an older projection shape must fail closed rather than
 * dereference a field that has since changed meaning. Checking the closed sets
 * without checking the host class would leave the combinations that matter
 * most — a root shape on an Event subdomain, a non-null `pathNamespace` on a
 * host that has none — accepted at exactly the boundary the revalidation exists
 * to survive. Anything that does not conform is `replica-malformed`, never
 * coerced data.
 *
 * "Against the host" now means the WHOLE host and not only its host class:
 * every committed-derived envelope names the canonical hostname it was
 * projected from, and that name must equal the requested one byte for byte
 * before any arm is entered (#1133). The denormalised `slug` cross-check that
 * used to be the only address test compares a single label, which two sibling
 * Namespaces share.
 */
export function decide(host: string, lookup: RegistryLookup, expectedSlug: string | null): Resolution {
  // The ENVELOPE is checked before its discriminant is read, and the order is
  // the point. A registry mid-rollout, or one whose entrypoint returned nothing
  // at all, hands back `null` or `undefined`; reading `.kind` off that throws
  // before any arm below can classify it, and the rejection escapes
  // `resolveHost` — which does not catch it, because `decide` runs outside the
  // bounded call — into an unversioned Cloudflare error page. That is the same
  // crash-instead-of-fail-closed failure an unbound binding used to cause, and
  // it is exactly the response this module exists to never produce.
  // A record, not an array, for the envelope exactly as for `desired` below:
  // an array carrying the envelope property names satisfies both `typeof` and
  // the exact-key check (Codex P2 on #1120).
  if (typeof lookup !== 'object' || lookup === null || Array.isArray(lookup)) {
    return notFound('replica-malformed');
  }
  // The envelope's own key set, before its discriminant is used to read
  // anything out of it. An arm carrying a field it does not define is a
  // registry contradicting itself, and the arms below would otherwise judge
  // only the fields they happen to look at.
  if (!hasExactEnvelopeKeys(lookup)) return notFound('replica-malformed');

  // THE ADDRESS THE RECORD BELONGS TO, before the discriminant selects an arm
  // and therefore before any status, Edition, root marker or revision is read
  // out of it (#1133).
  //
  // Until now the only cross-check between a committed record and the address
  // it came back for was the denormalised `slug`, which is the host's FIRST
  // LABEL — shared by `bodega-bay.fiveacross.app` and
  // `bodega-bay.vacaybingo.com`. A registry that answered a lookup of one with
  // the other's projection would pass that check, and the router would then
  // serve a sibling host's status and Edition, or publish its revision as this
  // address's recovery evidence. Slug equality is not address equality, and the
  // registry is a separately deployed Worker: the router cannot assume the
  // envelope it gets back was fetched for the host it asked about.
  //
  // So every envelope that names a canonical host must name THIS one. Whether
  // an arm is REQUIRED to name one is decided below, where the arm knows
  // whether it is derived from a committed record.
  if (Object.hasOwn(lookup, 'host') && !namesCanonicalHost(lookup, host)) {
    return notFound('replica-malformed');
  }

  switch (lookup.kind) {
    case 'unknown-host': {
      // `revision`, `schemaVersion` and `host` travel TOGETHER on this arm,
      // and are therefore judged together. All three are stamped from a
      // committed record — the tombstone that reads as unknown from outside
      // while keeping the revision the recovery machine's canonical probe has
      // to observe — and all three are absent when there is no committed
      // record at all. ONLY that second case is the ordinary unknown address.
      //
      // Any one of them arriving alone is a half-written envelope: something
      // committed existed to stamp it, and the rest did not survive the
      // crossing. Reading "no record here" off it would infer an absence
      // from a defect, which is the one coercion this module refuses
      // everywhere else — and it would let an unsupported-version tombstone
      // that lost its revision pass as an ordinary unknown host instead of
      // raising the `replica-malformed` alert that the state actually needs,
      // leaving that host unable to produce the revision-bearing evidence
      // `clear-lock` consumes. A registry too old to stamp `host` therefore
      // fails closed here rather than having its tombstone revision accepted
      // unbound (#1133).
      //
      // Past that pairing, the version gates the revision for the same reason
      // it gates a projection: publishing a revision read out of a record
      // written under a schema this build does not understand would attribute
      // to the address a value this Worker cannot claim to have read
      // correctly. A revision that is present and NOT canonical is judged the
      // same way one on a committed projection is — the shape rule is the
      // projection's, not the arm's.
      // Absence is judged by OWN-KEY presence, not by value: the contract says
      // an uninitialized object carries none of the three fields, and the
      // service binding carries `undefined` values intact where JSON would
      // drop them. An envelope that names any of those keys with an
      // `undefined` value is a version-skewed or half-written tombstone, not
      // an ordinary unknown address, and it falls through to the shape rules
      // below, which refuse it (Codex P2 on #1120). A named-but-undefined
      // `host` is already refused by the binding check above, for which
      // `undefined` is simply not this address.
      const { revision, schemaVersion } = lookup;
      const namesRevision = Object.hasOwn(lookup, 'revision');
      const namesSchemaVersion = Object.hasOwn(lookup, 'schemaVersion');
      const namesHost = Object.hasOwn(lookup, 'host');
      if (!namesRevision && !namesSchemaVersion && !namesHost) return notFound('unknown-host');
      if (!namesHost) return notFound('replica-malformed');
      if (!isSupportedProjectionSchemaVersion(schemaVersion)) return notFound('replica-malformed');
      if (!isCanonicalRevision(revision)) return notFound('replica-malformed');
      return notFound('unknown-host', revision);
    }
    case 'unavailable':
      return notFound('lookup-unavailable');
    case 'malformed':
      return notFound('replica-malformed');
    case 'committed':
      break;
    default:
      // An arm this Worker does not recognise — the shape of a registry that
      // has moved ahead of this deployment.
      return notFound('replica-malformed');
  }

  // THE ADDRESS FIRST, then the version, then everything the record says.
  //
  // Equality was already enforced at the envelope level; what is left is that
  // a committed projection may not DECLINE to name its address. An envelope
  // from a registry too old to stamp one therefore fails closed rather than
  // being read under the pre-#1133 rules, which is the point of pinning the
  // field: a projection whose binding cannot be checked is exactly as
  // unusable as one whose binding is wrong, and the two must not be told
  // apart by which registry build happened to answer.
  if (!Object.hasOwn(lookup, 'host')) return notFound('replica-malformed');

  // `desired` is read under the rules of a particular schema, so a version
  // this build does not understand has to be refused before any field of it is
  // interpreted — that ordering is the fail-closed half of the contract, not a
  // stylistic choice.
  if (!isSupportedProjectionSchemaVersion(lookup.schemaVersion)) return notFound('replica-malformed');
  if (!isCanonicalRevision(lookup.revision)) return notFound('replica-malformed');
  const revision = lookup.revision;
  const desired = lookup.desired;
  // A record, not an array: `typeof [] === 'object'`, and an array carrying
  // the route's property names would satisfy the exact-key check below, so the
  // ingestion parser's `!Array.isArray` requirement is repeated at this
  // boundary rather than assumed of the other deployment (Codex P2 on #1120).
  if (typeof desired !== 'object' || desired === null || Array.isArray(desired)) {
    return notFound('replica-malformed');
  }

  // The exact KEY SET, before any arm reads a value out of it, and from the
  // same table `parseDesired` uses at ingestion.
  //
  // Checking values without checking the key set accepts exactly the shapes
  // that carry a field their arm does not define — a tombstone with an
  // `eventId`, a root with a `slug`, a route with a field this schema has never
  // heard of. Every one of them is refused on the way IN, so a committed
  // projection carrying one is a registry defect however it got there, and this
  // boundary exists to answer for defects the registry did not catch. It
  // matters more than tidiness because these arms publish a revision: § Audit
  // and recovery makes the public `{reason, revision}` pair the evidence
  // `clear-lock` compares against committed state, so serving — or
  // `unknown-host`-ing — a shape the registry itself would have rejected would
  // offer it to the recovery machine as canonical.
  if (!hasExactDesiredKeys(desired)) return notFound('replica-malformed');

  switch (desired.kind) {
    case 'tombstone':
      // A deleted address is permanent and reads as `unknown-host` from
      // outside, which is the point: a tombstone must not advertise that the
      // address ever existed as a route. It keeps its REVISION, though — that
      // is public metadata by the spec's own threat model, and the recovery
      // contract requires it (see the `revision` note on `Resolution`).
      //
      // The object already reports this state through its `unknown-host` arm;
      // the router repeats the classification so a registry that ever handed
      // back the committed tombstone instead still fails closed here, with the
      // same reason and the same revision either way.
      return notFound('unknown-host', revision);

    case 'root': {
      // A root marker is a valid configured origin. `doorway` or `not-found`
      // controls what the APP renders at `/`; it is not a statement about
      // whether the edge may serve the shell or the path capability. There is
      // no Slug cross-check because a root projection carries no slug — the
      // apex has no first label, and the guarded `r2-root-*` rehearsal class
      // deliberately reuses the same shape on a labelled host.
      //
      // The root SHAPE is nonetheless bound to a host class: only a Namespace
      // apex, a brand mirror, or the root-test rehearsal class may carry one.
      // A root projection returned for an ordinary Event subdomain is a
      // registry defect, not a doorway.
      if (!isRegistryRootHost(host)) return notFound('replica-malformed');
      if (!isReplicaRootMarker(desired.root)) return notFound('replica-malformed');
      if (!isRegistryEdition(desired.edition) || !hostPathNamespace(host, desired.pathNamespace)) {
        return notFound('replica-malformed');
      }
      // A configured root origin brands itself: `vacaybingo.com` is the Vacay
      // doorway and `fiveacross.app` is the Five Across one. A root marker
      // whose Edition disagrees with its host would render the wrong product's
      // doorway on a real brand domain, so the pin is checked here as well as
      // at ingestion. The synthetic root-test class pins none, and
      // `registryRootHostEdition` returns `null` for it.
      const pinnedEdition = registryRootHostEdition(host);
      if (pinnedEdition !== null && desired.edition !== pinnedEdition) {
        return notFound('replica-malformed');
      }
      return {
        kind: 'serve',
        record: {
          eventId: null,
          revision,
          pathNamespace: desired.pathNamespace,
          edition: desired.edition,
          root: desired.root,
        },
      };
    }

    case 'route': {
      // The root-test rehearsal class accepts no route, on either side of the
      // registry. `parseDesired` refuses one at ingestion; this refuses one
      // that reached the binding anyway, which is the whole reason a
      // separately deployed consumer revalidates at all — an ingestion-only
      // rule is not a rule the router can rely on across version skew.
      if (isSyntheticRootTestHost(host)) return notFound('replica-malformed');
      if (!isRegistryEdition(desired.edition) || !hostPathNamespace(host, desired.pathNamespace)) {
        return notFound('replica-malformed');
      }
      // `status` must be EXPLICIT and known. An unrecognised value is a
      // projection this Worker cannot judge, not an inferred active — the same
      // rule ADR 0009 gives the source document, moved to the projection.
      if (!isReplicaRouteStatus(desired.status)) return notFound('replica-malformed');

      // SHAPE AND ADDRESS FIRST, STATE SECOND — and the order is load-bearing
      // now that `inactive` publishes a revision. A disabled route with no
      // `slug`, or one naming a different host, is not a record this address
      // may quote a revision from: it is half-written or it belongs to
      // somewhere else, and answering `inactive` with its revision would both
      // contradict the rule that a slug-less or slug-mismatched projection
      // carries none and offer a cross-host projection to the recovery machine
      // as this host's canonical evidence. Judging the projection before its
      // state is the same rule the unrecognised-`status` arm above applies.
      if (typeof desired.eventId !== 'string' || desired.eventId.length === 0) {
        return notFound('replica-malformed');
      }

      // EVERY route projection carries a slug — the schema requires a non-empty
      // one, and a route that has lost it is half-written whatever host it was
      // reached at. The apex exemption removes only the COMPARISON to a first
      // label, because the apex has none; it does not remove the requirement.
      if (typeof desired.slug !== 'string' || desired.slug.length === 0) {
        return notFound('slug-missing');
      }
      if (expectedSlug === null) {
        // On the apex there is no first label to compare against, so the Slug
        // contract itself is the only check left — and it is the one
        // `parseDesired` applies to this host class. Without it, a projection
        // naming `admin` or `bad/slash` would serve from the apex on the
        // strength of being non-empty. It is `replica-malformed` rather than a
        // slug reason because nothing about the ADDRESS is wrong: the
        // projection violates its own schema.
        //
        // The comparison arm below needs no equivalent. `expectedSlug` came
        // from `classifyHost`, which produces one only for a label that has
        // already passed this contract — or for a rehearsal class, which is
        // deliberately outside it and can only ever match itself.
        if (!validateSlug(desired.slug).ok) return notFound('replica-malformed');
      } else if (desired.slug !== expectedSlug) {
        return notFound('slug-mismatch');
      }

      // Only now is this a complete route projection for THIS address, and
      // therefore a record whose revision the router may publish. Disabled and
      // archived are refusals decided FROM it, so they carry that revision —
      // the state a `canonical-after-unblock` probe observes as
      // `{reason: 'inactive', revision}` and `clear-lock` compares against
      // committed state.
      if (desired.status !== 'active') return notFound('inactive', revision);

      return {
        kind: 'serve',
        record: {
          eventId: desired.eventId,
          revision,
          pathNamespace: desired.pathNamespace,
          edition: desired.edition,
          root: null,
        },
      };
    }

    default:
      return notFound('replica-malformed');
  }
}
