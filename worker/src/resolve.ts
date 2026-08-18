// The Event lookup at the edge (#545): "resolves slugs from the same
// `hostnames/{host}` collection the client uses" (specs/hostnames-lookup.md,
// ADR 0009). Same collection, same fail-closed rules, same stale-serve
// behaviour as `src/eventResolution.ts` — deliberately, because two answers to
// "is this address in service?" that can disagree is worse than either answer
// alone.
//
// Every seam is injected (`fetch`, `cache`, `now`), mirroring the convention
// `specs/event-resolution.md` sets for the client resolver: "a pure function
// with injected `fetchDoc`, `storage`, `now` and `delay`, so every branch is
// testable without a network, a browser or an emulator." That is why the whole
// decision table below is exercised by `resolve.test.ts` with no workerd, no
// Firestore and no Cloudflare cache.

/** The subset of `hostnames/{host}` this router reads. It reads no more than
 *  this on purpose: the router routes, so it has no business carrying the
 *  Edition, the preview slice, or the 18+ posture — the app resolves those for
 *  itself from the same document. */
export interface HostnameRecord {
  eventId: string;
  status: string;
  /** The first label, denormalised onto the document expressly "for the edge
   *  router" (specs/hostnames-lookup.md § Data model). This module is that
   *  router, and cross-checking it is what makes a repointed or half-written
   *  document fail closed instead of serving. */
  slug: string | null;
}

export type NotFoundReason =
  /** No `hostnames/{host}` document. The ordinary unknown-address case. */
  | 'unknown-host'
  /** Present but `status` is not `active` — disabled, archived, or a value
   *  this router does not recognise. */
  | 'inactive'
  /** Present and active but carries no `eventId`. A half-written document. */
  | 'malformed'
  /** Present, but its denormalised `slug` names a different first label than
   *  the address it was reached at. */
  | 'slug-mismatch'
  /** Present, but carries no `slug` to cross-check against. */
  | 'slug-missing'
  /** The lookup itself could not be completed and no cached answer existed.
   *  The only reason that is about US rather than about the address. */
  | 'lookup-unavailable';

export type Resolution =
  | { kind: 'serve'; eventId: string; stale: boolean }
  | { kind: 'not-found'; reason: NotFoundReason };

/** Bumped whenever `CacheEnvelope`'s shape changes, so an envelope written by
 *  an older Worker version reads as a MISS rather than being coerced —
 *  the same rule the client cache follows (specs/event-resolution.md). */
export const CACHE_VERSION = 1;

export interface CacheEnvelope {
  version: number;
  fetchedAt: number;
  record: HostnameRecord;
}

/** The cache seam. `worker/src/index.ts` adapts Cloudflare's `caches.default`
 *  to it; the tests supply a map. Deliberately narrow — a `Cache` has a large
 *  surface this module has no use for. */
export interface HostnameCache {
  read(host: string): Promise<CacheEnvelope | null>;
  write(host: string, envelope: CacheEnvelope): Promise<void>;
  drop(host: string): Promise<void>;
}

export interface ResolveConfig {
  projectId: string;
  apiKey: string;
  lookupTimeoutMs: number;
  cacheTtlMs: number;
}

export interface ResolveDeps {
  fetch: typeof fetch;
  cache: HostnameCache;
  now(): number;
}

/**
 * Whether the router can perform a lookup at all.
 *
 * Exported because it is checked in TWO places for two different reasons, and
 * collapsing them into one would lose a case: here, so a lookup is never
 * attempted with no credentials, and in `router.ts` BEFORE the `/__/auth/*`
 * exemption, so an unconfigured deployment fails closed uniformly instead of
 * quietly proxying the one path that skips the lookup. A missing api key is not
 * the transient dependency failure that exemption exists to survive — it is a
 * total misconfiguration, and a router that half-serves under one is harder to
 * diagnose than one that serves nothing.
 */
export function isLookupConfigured(config: Pick<ResolveConfig, 'projectId' | 'apiKey'>): boolean {
  return config.apiKey.length > 0 && config.projectId.length > 0;
}

/**
 * ONLY positive resolutions are cached, and the asymmetry is deliberate.
 *
 * A cached negative would make a newly provisioned Event unreachable for the
 * length of the TTL — an organizer finishes the setup wizard, types their own
 * address, and gets the not-found page for five minutes. That is the exact
 * moment the product is least able to afford it. A negative lookup is also
 * cheap to recompute: one Firestore point read, which Cloudflare absorbs at
 * edge volume. If unresolvable-hostname traffic ever becomes a real cost, the
 * knob is a short negative TTL here, not rate limiting bolted into the router —
 * volumetric abuse belongs to the Cloudflare layer in front of this code.
 */
export async function resolveHost(
  host: string,
  expectedSlug: string | null,
  config: ResolveConfig,
  deps: ResolveDeps,
): Promise<Resolution> {
  // The cache is an OPTIMISATION, so every access degrades to "no cache"
  // rather than propagating. A rejecting Cache API would otherwise escape this
  // function as a Worker runtime error — no rendered state, no diagnostic
  // header, no fail-closed page — which is strictly worse than the extra
  // Firestore read a miss costs. Same rule `specs/event-resolution.md` gives
  // the client: "storage that throws on access degrades to 'no cache', never
  // to a failed boot."
  const cached = await swallow(() => deps.cache.read(host), null);
  const fresh =
    cached !== null &&
    cached.version === CACHE_VERSION &&
    deps.now() - cached.fetchedAt < config.cacheTtlMs;

  if (fresh && cached !== null) {
    return decide(cached.record, expectedSlug, false);
  }

  let record: HostnameRecord | null;
  try {
    record = await fetchHostnameRecord(host, config, deps);
  } catch {
    // Revalidation failed. A stale-but-servable entry still serves and is NOT
    // restamped — an expired mapping beats a dead app when the network is
    // simply gone, but it stops counting as evidence the mapping is still
    // good (specs/event-resolution.md). With no entry at all there is nothing
    // to fall back to, so this fails closed like every other unknown.
    if (cached !== null && cached.version === CACHE_VERSION) {
      return decide(cached.record, expectedSlug, true);
    }
    return { kind: 'not-found', reason: 'lookup-unavailable' };
  }

  if (record === null) {
    // Dropped, not expired: a mapping that is gone must stop serving from this
    // edge immediately rather than at the end of its TTL.
    await swallow(() => deps.cache.drop(host), undefined);
    return { kind: 'not-found', reason: 'unknown-host' };
  }

  const decision = decide(record, expectedSlug, false);
  if (decision.kind === 'serve') {
    await swallow(
      () => deps.cache.write(host, { version: CACHE_VERSION, fetchedAt: deps.now(), record }),
      undefined,
    );
  } else {
    // Only SERVABLE records are cached, and the else-arm is the other half of
    // that rule rather than a tidy-up. Caching a record that exists but does
    // not serve — inactive, malformed, slug-mismatched — would manufacture
    // exactly the stuck negative this module refuses to create for an unknown
    // host: provisioning that briefly exposes a partial document would pin the
    // failure for a full TTL after the document was corrected. Dropping also
    // closes the other direction: an Event that goes inactive must not leave a
    // servable envelope behind for the stale-serve path to resurrect.
    await swallow(() => deps.cache.drop(host), undefined);
  }
  return decision;
}

/** Run a cache operation, treating any failure as absence. */
async function swallow<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

/**
 * The fail-closed decision table. Every arm that is not an explicit,
 * well-formed, active, address-matching record is a not-found — never an
 * inferred active.
 */
function decide(
  record: HostnameRecord,
  expectedSlug: string | null,
  stale: boolean,
): Resolution {
  // `status` must be EXPLICIT. Defaulting a missing or unrecognised value to
  // active would let a half-written routing document publish an Event before
  // the record opts in (ADR 0009).
  if (record.status !== 'active') return { kind: 'not-found', reason: 'inactive' };
  if (record.eventId.length === 0) return { kind: 'not-found', reason: 'malformed' };

  // The apex has no first label, so there is nothing to cross-check; its
  // document's `slug` names the Event's wildcard address, not this one.
  if (expectedSlug !== null) {
    if (record.slug === null) return { kind: 'not-found', reason: 'slug-missing' };
    if (record.slug !== expectedSlug) return { kind: 'not-found', reason: 'slug-mismatch' };
  }

  return { kind: 'serve', eventId: record.eventId, stale };
}

/**
 * One Firestore REST point-get, as an UNAUTHENTICATED caller.
 *
 * The Worker carries the Firebase web API key and no service-account
 * credential, which is a deliberate ceiling rather than an omission: it means
 * the router can read exactly what a browser standing on the same address can
 * read, and `firestore.rules` (`allow get: if true; allow list: if false`) is
 * the thing enforcing that — not a promise this code makes about itself. A
 * router that held admin credentials would be one refactor away from becoming
 * the authorization layer #529 says it must never be. The web API key is not a
 * secret; the identical value already ships in every production bundle.
 *
 * Throws on anything that is not a definite answer, so the caller's stale-serve
 * path can take over. A 404 is a definite answer — Firestore returns it for a
 * document that does not exist — and reads as `null`, matching the client's
 * rule that "an unknown host is a missing document, not a denial"
 * (specs/hostnames-lookup.md).
 */
export async function fetchHostnameRecord(
  host: string,
  config: ResolveConfig,
  deps: ResolveDeps,
): Promise<HostnameRecord | null> {
  if (!isLookupConfigured(config)) {
    throw new Error('event-router: FIREBASE_API_KEY / FIREBASE_PROJECT_ID are not configured');
  }

  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}` +
      `/databases/(default)/documents/hostnames/${encodeURIComponent(host)}`,
  );
  url.searchParams.set('key', config.apiKey);
  // A field mask, so a document that grows a large `preview` slice does not
  // grow this request. The router reads routing fields and nothing else.
  for (const field of ['eventId', 'status', 'slug']) {
    url.searchParams.append('mask.fieldPaths', field);
  }

  const response = await deps.fetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
    // Hard-bounded. An unbounded pre-proxy read would put every request on the
    // wrong side of a hung dependency, which is the same failure class the
    // client resolver's `timeoutMs` exists to prevent.
    signal: AbortSignal.timeout(config.lookupTimeoutMs),
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`event-router: hostnames lookup returned ${response.status}`);
  }

  return parseHostnameDocument(await response.json());
}

/** Firestore REST wraps every value in a type tag; anything that is not a
 *  present `stringValue` reads as absent rather than being coerced. */
function stringField(fields: Record<string, unknown>, name: string): string | null {
  const value = fields[name];
  if (typeof value !== 'object' || value === null) return null;
  const stringValue = (value as { stringValue?: unknown }).stringValue;
  return typeof stringValue === 'string' ? stringValue : null;
}

export function parseHostnameDocument(body: unknown): HostnameRecord {
  const fields =
    typeof body === 'object' && body !== null && typeof (body as { fields?: unknown }).fields === 'object'
      ? ((body as { fields: Record<string, unknown> }).fields ?? {})
      : {};

  return {
    eventId: stringField(fields, 'eventId') ?? '',
    // Absent `status` deliberately becomes a value that is not `'active'`,
    // rather than a default that is.
    status: stringField(fields, 'status') ?? '',
    slug: stringField(fields, 'slug'),
  };
}
