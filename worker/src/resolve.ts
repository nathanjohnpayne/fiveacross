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
  /** The registry answered, and its committed projection is malformed or
   *  carries a shape this router does not support. Distinguished from
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
  | { kind: 'not-found'; reason: NotFoundReason };

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
}

function notFound(reason: NotFoundReason): Resolution {
  return { kind: 'not-found', reason };
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
  if (deps.registry === null) return notFound('lookup-unavailable');

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
    return notFound('lookup-unavailable');
  }

  return decide(host, lookup, expectedSlug);
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
  if (typeof lookup !== 'object' || lookup === null) return notFound('replica-malformed');

  switch (lookup.kind) {
    case 'unknown-host':
      return notFound('unknown-host');
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

  if (!isCanonicalRevision(lookup.revision)) return notFound('replica-malformed');
  const revision = lookup.revision;
  const desired = lookup.desired;
  if (typeof desired !== 'object' || desired === null) return notFound('replica-malformed');

  switch (desired.kind) {
    case 'tombstone':
      // A deleted address is permanent and is indistinguishable from an
      // unknown one from outside, which is the point: a tombstone must not
      // advertise that the address ever existed. The object already collapses
      // this arm before it answers; the router repeats it so a registry that
      // ever stopped doing so still fails closed here.
      return notFound('unknown-host');

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
      if (desired.status !== 'active') return notFound('inactive');
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
