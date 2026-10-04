import type { HostnameDoc, HostnameRootMarker, RoutingDoc } from './types';
import { ADULT_CONTENT_DEFAULT, coerceAdultContent } from './adultContent';
import { coerceEventPreview, type EventPreview } from './eventPreview';

// Startup Event resolution from the request hostname (ADR 0009, #543).
//
// Runs BEFORE authentication and BEFORE first paint, which is the whole
// constraint. `events/{eventId}` requires `signedIn()`, so the Event cannot be
// read from there in time to dress the sign-in screen; the public
// `hostnames/{host}` lookup exists precisely to answer "which Event is this?"
// while the user is still anonymous.
//
// Everything here is pure or injected — no Firestore import, no direct
// `window` — so the whole decision table is unit-testable without a network,
// a browser, or an emulator.

export type { HostnameDoc, HostnameRootMarker, RoutingDoc };

export type Resolution =
  | {
      kind: 'event';
      eventId: string;
      canonicalHost: string | null;
      edition: string | null;
      /** The first hostname label identifying the Event (CONTEXT.md §
       *  Slug), e.g. `bodega-bay` — an analytics dimension (#556), never an
       *  authorization secret. `null` on the env short-circuit (no hostname
       *  document was read) and when a legacy routing document predates the
       *  field; callers fall back to `eventId` as the closest available
       *  identifier. */
      slug: string | null;
      /** Whether this Event shows the 18+ acknowledgement (#608). Never `null`,
       *  unlike `edition`: there is no "unknown" posture a gate could render, so
       *  an unknown answer resolves to the gated one. */
      adultContent: boolean;
      /** Whether `adultContent` came from a LIVE read of `hostnames/{host}`, as
       *  opposed to a build-time seed, a cached entry, or the fail-closed
       *  default. Only a proven `true` latches the session (`sessionRaised`);
       *  only a proven `false` is allowed to stand without revalidation. See the
       *  rule at the top of `src/adultContent.ts`. */
      adultContentProven: boolean;
      /** The sign-in postcard's Event-preview slice (#647), when the routing
       *  document carries one. Absent on the env short-circuit (no document is
       *  read) and on documents seeded before the field existed — the gate
       *  then draws no card, never a broken one. */
      preview?: EventPreview;
      /** Where the answer came from — surfaced for diagnostics, never for logic. */
      source: 'cache' | 'network' | 'env';
    }
  /** The third outcome (specs/path-addressing-and-root.md § D1): a
   *  `root: 'doorway'` marker. Names no Event, so nothing Event-scoped is
   *  installed and no Event is mounted. Until the doorway itself ships (#1392)
   *  `src/main.tsx` renders it exactly as it rendered the same document before
   *  this outcome existed: not-found (`bootNotFound`). */
  | {
      kind: 'root';
      hostname: string;
      edition: string;
      /** The host's path capability, or `null` for none. Carried for the path
       *  chain (#1389); nothing reads it yet. */
      pathNamespace: string | null;
      source: 'cache' | 'network';
    }
  | {
      kind: 'not-found';
      hostname: string;
      reason: 'missing' | 'inactive' | 'unreachable';
      /** Present only when a `root: 'not-found'` capability marker answered:
       *  `/` is not-found there, but the marker still supplies the host's path
       *  capability (`null` when it carries none) to the path chain (#1389). */
      pathNamespace?: string | null;
    };

/** Minimal storage seam so tests inject a fake and a private-mode browser that
 *  throws on access degrades to "no cache" rather than taking the app down. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const CACHE_PREFIX = 'fa:hostname:';

/** Bumped when the cached shape changes. An entry written by an older version
 *  reads as a MISS rather than being coerced — the same discipline
 *  `cardCache.ts` uses for its snapshot version.
 *
 *  `2` is the path-capability enablement barrier
 *  (specs/path-addressing-and-root.md § "The three contract details", first
 *  bullet): a version-1 entry was written before this build could read a root
 *  marker or `pathNamespace`, so it is a pre-capability answer and is never
 *  served, not even as the stale offline fallback. The cost is one network read
 *  per hostname per device, paid once: an offline returning client with only a
 *  v1 entry boots `unreachable` until that read succeeds. This is the value the
 *  lifecycle helper's `pathCapabilityBarrier` record attests as
 *  `resolutionCacheSchemaVersion`. */
export const CACHE_VERSION = 2;

/** How long a cached mapping may serve an Event without revalidation.
 *
 *  A hostname's Event assignment IS durable, which is why a cache is safe at
 *  all — but "durable" is not "permanent". If a host is archived or repointed,
 *  an unbounded cache would keep booting the old Event on that browser forever
 *  (Codex on #576). Twelve hours bounds that to well under a day while still
 *  covering a whole event-day of offline use. */
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Small allowance for ordinary clock drift between the write and the read
 *  (NTP correction, a few seconds of skew) — NOT a grace window for genuine
 *  rollback. A `fetchedAt` further in the future than this cannot have been
 *  written honestly by `writeCache`, which always stamps `Date.now()` at
 *  write time (Codex P3 on #582): treating it as fresh would let a device
 *  clock rollback extend the 12-hour bound by the rollback duration. */
const FUTURE_FETCH_TOLERANCE_MS = 60_000;

interface CacheEnvelope {
  v: number;
  fetchedAt: number;
  /** Written only after this build has checked the optional preview slice.
   *  Caches from before #647 lack it and need one network attempt so a newly
   *  seeded postcard does not stay invisible for the routing TTL. */
  previewValidated: boolean;
  doc: RoutingDoc;
}

/** Cache key is the HOSTNAME, not the slug: two hostnames can resolve to one
 *  Event, and a shared key would let an alias serve the canonical's cached
 *  edition (or vice versa) on the wrong origin. */
export const cacheKey = (hostname: string): string => `${CACHE_PREFIX}${hostname.toLowerCase()}`;

/** A hostname document is only usable when it says so explicitly.
 *
 *  Never infer `active` from a missing field: a partially-written routing
 *  document would then publish an Event before the record opts in, and the
 *  network and cache paths would disagree about identical data (Codex on #576). */
export function isServable(doc: Pick<RoutingDoc, 'status'> | null | undefined): boolean {
  return doc?.status === 'active';
}

/** Whether a coerced routing document is a root marker rather than an Event
 *  mapping. */
export function isRootMarker(doc: RoutingDoc | null | undefined): doc is HostnameRootMarker {
  return doc?.root === 'doorway' || doc?.root === 'not-found';
}

const VALID_STATUS = new Set(['active', 'disabled', 'archived']);

/**
 * The Namespace apexes a `pathNamespace` may name: apexes that issue Event
 * subdomains (CONTEXT.md § Namespace). Mirrors `PATH_NAMESPACES` in
 * `scripts/event-router-registry/hostname-projection.mjs` and `NAMESPACES` in
 * `worker/src/host.ts`; `src/eventResolution.test.ts` pins all three equal.
 * `gaycruisebingo.com` is deliberately absent: it is an Edition apex that
 * issues no Event subdomains (specs/path-addressing-and-root.md § D3).
 */
export const PATH_NAMESPACES: ReadonlySet<string> = new Set(['fiveacross.app', 'vacaybingo.com']);

/** Fail-closed: only a recognised Namespace apex is a capability. */
function coercePathNamespace(value: unknown): string | undefined {
  return typeof value === 'string' && PATH_NAMESPACES.has(value) ? value : undefined;
}

/**
 * THE one reading of a raw `hostnames/{host}` payload, shared by the network
 * seam (`fetchHostnameDoc`), its live watcher and the cache reader below, so no
 * two seams can disagree about what a usable mapping is.
 *
 * Two shapes, chosen by `eventId` and nothing else:
 *
 * - **A document naming an `eventId` is an Event mapping**, read exactly as it
 *   was before root markers existed: a recognised explicit `status` is
 *   required, and a stray `root` on it is ignored, so it never becomes a
 *   doorway. That keeps every serving host's answer unchanged by this reader.
 * - **A document with no `eventId` is a root marker only when it says so.**
 *   `root` must be `doorway` or `not-found`, and the marker may not carry the
 *   route-only `status` or `slug` (the registry derivation refuses the same
 *   shape). A missing or unknown discriminator stays malformed and reads as
 *   null, exactly as every `eventId`-less document did before.
 *
 * `pathNamespace` and `apexPath` are read fail-closed on both shapes. Nothing
 * acts on either until the path chain (#1389/#1390) lands.
 */
export function coerceRoutingDoc(d: unknown, hostname: string): RoutingDoc | null {
  if (typeof d !== 'object' || d === null) return null;
  const raw = d as Record<string, unknown>;
  const edition = typeof raw.edition === 'string' ? raw.edition : '';
  const pathNamespace = coercePathNamespace(raw.pathNamespace);
  if (raw.eventId === undefined) {
    if (raw.root !== 'doorway' && raw.root !== 'not-found') return null;
    if (raw.status !== undefined || raw.slug !== undefined) return null;
    return { root: raw.root, edition, ...(pathNamespace ? { pathNamespace } : {}) };
  }
  if (typeof raw.eventId !== 'string' || !raw.eventId) return null;
  if (typeof raw.status !== 'string' || !VALID_STATUS.has(raw.status)) return null;
  return {
    eventId: raw.eventId,
    canonicalHost: typeof raw.canonicalHost === 'string' ? raw.canonicalHost : hostname,
    edition,
    status: raw.status as HostnameDoc['status'],
    // The 18+ posture (#608). Validated field-by-field like everything else
    // here, but it does NOT join the null-returning guards above: a missing or
    // malformed `adultContent` is not a malformed routing record, it is an
    // Event that predates the field. Coercing it to `true` gates the Event;
    // rejecting the whole document would take the Event off the air.
    adultContent: coerceAdultContent(raw.adultContent),
    slug: typeof raw.slug === 'string' ? raw.slug : undefined,
    isCanonical: typeof raw.isCanonical === 'boolean' ? raw.isCanonical : undefined,
    // The sign-in postcard's preview slice (#647). Optional and fail-soft like
    // `slug`: a malformed or absent slice costs the card, never the Event.
    preview: coerceEventPreview(raw.preview),
    ...(pathNamespace ? { pathNamespace } : {}),
    ...(raw.apexPath === true ? { apexPath: true } : {}),
  };
}

export interface CacheRead {
  doc: RoutingDoc;
  fetchedAt: number;
  stale: boolean;
  /** A pre-preview cache remains a routing fallback, but cannot short-circuit
   *  its first post-upgrade network read. */
  requiresPreviewRevalidation: boolean;
}

/** Read a cached mapping. Tolerates absent, corrupt, version-drifted and
 *  shape-drifted entries by returning null — a bad cache must never be worse
 *  than no cache. A STALE entry is returned (flagged), not discarded: it is
 *  still the right thing to render when the network is unreachable. */
export function readCache(
  storage: StorageLike | null,
  hostname: string,
  now: number = Date.now(),
): CacheRead | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(cacheKey(hostname));
  } catch {
    return null; // private mode / disabled storage
  }
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as Partial<CacheEnvelope>;
    if (env?.v !== CACHE_VERSION) return null;
    if (typeof env.fetchedAt !== 'number') return null;
    // The same coercion the network seam runs. `adultContent` (#608) and
    // `preview` (#647) are additive fields read fail-soft inside it and never
    // needed a version bump of their own: a bump evicts every stored mapping,
    // the entries an offline cold boot depends on (step 3 below), and an absent
    // posture already reads as the safe `true`, an absent slice as no card.
    // Only the capability change above warranted paying that cost.
    const doc = coerceRoutingDoc(env.doc, hostname);
    if (!doc) return null;
    return {
      doc,
      fetchedAt: env.fetchedAt,
      stale: now - env.fetchedAt > CACHE_TTL_MS || env.fetchedAt - now > FUTURE_FETCH_TOLERANCE_MS,
      requiresPreviewRevalidation: env.previewValidated !== true,
    };
  } catch {
    return null;
  }
}

/** Persist a mapping with its fetch stamp. Never throws: a full or disabled
 *  quota costs a cache entry, not a boot. */
export function writeCache(
  storage: StorageLike | null,
  hostname: string,
  doc: RoutingDoc,
  now: number = Date.now(),
): void {
  if (!storage) return;
  const env: CacheEnvelope = { v: CACHE_VERSION, fetchedAt: now, previewValidated: true, doc };
  try {
    storage.setItem(cacheKey(hostname), JSON.stringify(env));
  } catch {
    /* quota or private mode — cache is an optimisation, not a requirement */
  }
}

/** Remove a mapping after proven evidence that this hostname is no longer
 * servable. The live hostname watcher shares this with the bootstrap resolver:
 * an inactive routing document must not resurrect from a prior active envelope
 * on the next env-pinned boot. */
export function dropCache(storage: StorageLike | null, hostname: string): void {
  try {
    storage?.removeItem?.(cacheKey(hostname));
  } catch {
    /* best effort */
  }
}

/** A root marker's resolution: `doorway` is the third outcome; `not-found`
 *  answers not-found at `/` while still exposing the host's capability. */
const asRoot = (doc: HostnameRootMarker, hostname: string, source: 'cache' | 'network'): Resolution =>
  doc.root === 'doorway'
    ? { kind: 'root', hostname, edition: doc.edition, pathNamespace: doc.pathNamespace ?? null, source }
    : { kind: 'not-found', hostname, reason: 'missing', pathNamespace: doc.pathNamespace ?? null };

/**
 * What `src/main.tsx` renders INSTEAD of mounting the app, or `null` to mount.
 *
 * Only an Event mounts. A root resolution renders not-found until the doorway
 * ships (#1392): the same screen, with the same reason, that the identical
 * `eventId`-less document produced before root markers could be read. Reading
 * the third outcome therefore changes what no host serves.
 */
export function bootNotFound(
  resolution: Resolution,
): { hostname: string; reason: 'missing' | 'inactive' | 'unreachable' } | null {
  if (resolution.kind === 'event') return null;
  if (resolution.kind === 'root') return { hostname: resolution.hostname, reason: 'missing' };
  return { hostname: resolution.hostname, reason: resolution.reason };
}

const asEvent = (doc: HostnameDoc, source: 'cache' | 'network'): Resolution => ({
  kind: 'event',
  eventId: doc.eventId,
  canonicalHost: doc.canonicalHost,
  edition: doc.edition,
  adultContent: doc.adultContent,
  // A cache hit is not evidence about the posture NOW — the document may have
  // been stamped since. Only the network read proves anything.
  adultContentProven: source === 'network',
  slug: doc.slug ?? null,
  preview: doc.preview,
  source,
});

export interface ResolveOptions {
  hostname: string;
  /** Injected Firestore `get`. Resolves to null when the document is absent or
   *  malformed, otherwise to an Event mapping or a root marker. */
  fetchDoc: (hostname: string) => Promise<RoutingDoc | null>;
  storage?: StorageLike | null;
  /** `VITE_EVENT_ID`. A non-empty value marks a single-Event build. */
  envEventId?: string | null;
  /** `VITE_ADULT_CONTENT`, verbatim. Only a literal `'false'` opts a
   *  single-Event build out of the 18+ posture (#608); read as a raw string
   *  rather than a boolean so the fail-closed coercion lives in ONE place and
   *  an unset/blank/typo'd var cannot un-gate a build. Ignored entirely on the
   *  hostname-resolved path, which defers to the routing document. */
  envAdultContent?: string | null;
  /** Hard ceiling on the network read. */
  timeoutMs?: number;
  /** Injected for tests; defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
  /** Injected for tests. */
  now?: () => number;
}

const defaultDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve the Event for a hostname.
 *
 * ORDER, and why:
 *
 *  0. **A single-Event build never looks up at all.** A non-empty
 *     `VITE_EVENT_ID` signals that this bundle serves exactly one Event — the
 *     Gay Cruise Bingo build, whose hostname has no `hostnames/` document. It
 *     would be incoherent to consult the lookup and then discard the answer,
 *     and since resolution now blocks first paint, racing a Firestore read it
 *     cannot use would cost that build a round trip — or, on captive Wi-Fi, the
 *     full timeout — while already knowing the answer (Codex on #576).
 *  1. **Fresh cache wins outright.** A hit inside the TTL returns with no
 *     network at all, which is what makes offline cold boot work (ADR 0006)
 *     and keeps first paint off the network's critical path.
 *  2. **Network, hard-bounded.** A miss, or a STALE hit, does one `get` raced
 *     against `timeoutMs`. This repo has shipped three blank-screen fixes; an
 *     unbounded pre-paint read is that failure class, so the race is
 *     load-bearing rather than defensive.
 *  3. **Stale cache is the offline fallback.** If revalidation fails and a
 *     stale entry exists, serve it rather than a not-found — an expired mapping
 *     beats a dead app when the network is simply gone.
 *
 * Always terminates in something renderable. `not-found` is a state the app
 * draws, never an exception it has to catch.
 */
/**
 * What main.tsx renders when the bootstrap PROMISE ITSELF rejects — the branch
 * `resolveEvent`'s never-throw contract says cannot happen, guarded anyway
 * because it is the one path that would otherwise render nothing at all.
 *
 * The answer splits on the build mode, and the split is the point (Phase 4b P1
 * on #576). An env-pinned build (`envEventId` non-empty) mounts: `EVENT_ID`
 * already holds the baked id, which IS the correct Event for that build, so a
 * blank screen would be strictly worse. A hostname-resolved build must fail
 * CLOSED instead: its pre-resolution `EVENT_ID` is the legacy fallback
 * (`med-2026`), so mounting on an unexpected exception would serve the legacy
 * Event — listeners, card deals, writes and all — on an arbitrary hostname,
 * and would also skip the auth-reachability gate that only runs on the
 * resolved path. An "unreachable" screen is recoverable by reload; a player
 * silently joined to the wrong Event is not.
 */
export function shouldMountOnBootstrapFailure(envEventId: string | null | undefined): boolean {
  return Boolean(envEventId);
}

export async function resolveEvent(opts: ResolveOptions): Promise<Resolution> {
  const { hostname, fetchDoc, storage = null, envEventId = null } = opts;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const delay = opts.delay ?? defaultDelay;
  const now = opts.now ?? Date.now;

  // 0. Single-Event build: answer immediately, never touch the network.
  if (envEventId) {
    // `adultContent` defaults CLOSED here, like everywhere else — this path
    // reads no hostname document, so there is nothing to derive from, and the
    // legacy Gay Cruise Bingo build it serves is 18+ anyway.
    //
    // `envAdultContent` is the build-time opt-out — a SEED, and deliberately not
    // an answer (Phase 4b P1). A single-Event build is the shape the repo
    // documents for a small standalone deployment, and without some build-time
    // input it could never be anything but adults-only. But a baked `false` that
    // simply STOOD would be the worst version of that: the build never reads a
    // routing document, so an admin who later approves an explicit Prompt or
    // flips `forceAdult` would change nothing on those clients — not on a reload,
    // not ever, short of a rebuild — while the ticket advertises exactly that
    // transition.
    //
    // So the seed is marked UNPROVEN (`adultContentProven: false` below). It
    // paints the first frame, and `revalidateAdultContent` then has to confirm it
    // against `hostnames/{host}` like any other ungated claim. If that read says
    // `true`, the gate goes up. If the document does not exist, there is no
    // channel through which this posture could ever be revoked — so the posture
    // returns to gated rather than standing forever on a promise nobody can keep.
    // A deployment that wants to be non-adult needs a routing document, which is
    // the same document the derivation already writes to.
    //
    // Only a literal `'false'` seeds the opt-out; a typo, a blank, or an unset
    // var all gate.
    const envUngated = opts.envAdultContent === 'false';
    return {
      kind: 'event',
      eventId: envEventId,
      canonicalHost: null,
      edition: null,
      adultContent: envUngated ? false : ADULT_CONTENT_DEFAULT,
      // Never proven: a build-time string is a claim about the past.
      adultContentProven: false,
      slug: null,
      source: 'env',
    };
  }

  const cached = readCache(storage, hostname, now());
  // A fresh cache hit wins outright — UNLESS it would UN-GATE the Event (#608,
  // Codex P1 on #615).
  //
  // `adultContent` is the one cached field that can only ever move in one
  // direction, and it is the direction that matters: an admin approves the first
  // explicit Prompt, the derivation stamps the routing document `true`, and every
  // device holding a cached `false` would keep short-circuiting to it for the
  // rest of the 12-hour TTL — booting straight past the 18+ gate the Event has
  // since acquired. The re-prompt path #608 relies on ("a spicy Prompt approved
  // mid-Event flips the flag and the existing re-prompt gate does the rest")
  // simply never fires on those devices.
  //
  // So a cached `false` is treated as a REVALIDATION CANDIDATE rather than an
  // answer: fall through to the network read below.
  //
  // AND, if that read fails, the posture resolves to GATED — not back to the
  // cached `false` (Phase 4b P1, correcting the first cut of this rule). The
  // reasoning that talked me into the softer version was about the offline cost:
  // gating asks a Player of a tame Event for an attestation nobody offered them,
  // and `bootstrapUser`'s offline branch holds on "Loading…" without a cached
  // stamp. But that argument answers the wrong question. A failed revalidation
  // does not mean "the posture is still false" — it means the posture is
  // UNKNOWN, and this field is monotone, so the one direction it could have
  // moved in is the direction that matters. Serving a cached `false` on no
  // evidence is precisely the fail-open the whole design is built to refuse.
  //
  // The offline cost is real and is paid deliberately. Two things bound it: an
  // Event that has ALREADY flipped caches `true` and short-circuits normally, so
  // this only touches the never-yet-adult case; and the gate is provisional, not
  // latched (`setActiveAdultContent(..., { proven: false })`), so the first
  // successful revalidation lowers it again. It is a gate until we can ask, not
  // a gate forever.
  //
  // A cached `true` still short-circuits, so the gated path — every Gay Cruise
  // Bingo host, and every Event that has already flipped — keeps the pure
  // offline-first cold boot ADR 0006 specifies, at no cost.
  const cacheMayUnGate = cached?.doc.adultContent === false;
  // A fresh root marker serves from cache like a fresh Event mapping: routing
  // is durable, and the marker's entry is keyed by this hostname exactly as an
  // Event mapping's is (§ D3: the root marker's own document caches separately
  // from any derived path target). It carries no posture or preview to
  // revalidate.
  if (cached && !cached.stale && isRootMarker(cached.doc)) {
    return asRoot(cached.doc, hostname, 'cache');
  }
  // A cache written before the Event-preview slice existed must make ONE
  // best-effort revalidation, even inside the usual TTL. It still reaches
  // `staleOrNotFound` on failure, preserving its offline routing fallback;
  // a successful read rewrites the envelope with `previewValidated: true`.
  const cacheNeedsPreviewRevalidation = cached?.requiresPreviewRevalidation === true;
  if (
    cached &&
    !cached.stale &&
    !cacheMayUnGate &&
    !cacheNeedsPreviewRevalidation &&
    !isRootMarker(cached.doc) &&
    isServable(cached.doc)
  ) {
    return asEvent(cached.doc, 'cache');
  }

  const TIMED_OUT = Symbol('timeout');
  let doc: RoutingDoc | null;
  try {
    const raced = await Promise.race([
      fetchDoc(hostname),
      delay(timeoutMs).then(() => TIMED_OUT as unknown as RoutingDoc | null),
    ]);
    if ((raced as unknown) === TIMED_OUT) return staleOrNotFound(cached, hostname, 'unreachable');
    doc = raced;
  } catch {
    return staleOrNotFound(cached, hostname, 'unreachable');
  }

  if (!doc) {
    // The mapping is gone. A cached entry for it is now wrong, not merely old.
    dropCache(storage, hostname);
    return { kind: 'not-found', hostname, reason: 'missing' };
  }

  if (isRootMarker(doc)) {
    // A deliberate marker, not an inactive mapping: cache it under this
    // hostname like any other server-proven routing answer.
    writeCache(storage, hostname, doc, now());
    return asRoot(doc, hostname, 'network');
  }

  if (!isServable(doc)) {
    // Disabled or archived. Drop any cached copy so this browser stops serving
    // the Event, and do not cache the inactive state either — caching it would
    // keep the Event dark for the cache's lifetime after someone re-activates.
    dropCache(storage, hostname);
    return { kind: 'not-found', hostname, reason: 'inactive' };
  }

  writeCache(storage, hostname, doc, now());
  return asEvent(doc, 'network');
}

/** Revalidation failed. A stale-but-active cached mapping is still the best
 *  answer available for ROUTING — an expired entry beats a dead app when the
 *  network is simply unreachable.
 *
 *  Its POSTURE is a different question, and gets the opposite answer (Phase 4b
 *  P1). Routing is effectively immutable: a hostname's Event assignment is
 *  durable, which is why serving a stale one is safe at all. `adultContent` is
 *  the one field on the document that is expected to change, in exactly one
 *  direction, and we have just failed to find out whether it has. So the Event
 *  still resolves — the player is not stranded on a not-found screen — but it
 *  resolves GATED, and unproven, so the first successful revalidation can lower
 *  it again. */
function staleOrNotFound(
  cached: CacheRead | null,
  hostname: string,
  reason: 'missing' | 'unreachable',
): Resolution {
  // A stale root marker is the same durable routing answer a stale Event
  // mapping is, so it serves offline too. It carries no posture to gate.
  if (cached && isRootMarker(cached.doc)) return asRoot(cached.doc, hostname, 'cache');
  if (cached && !isRootMarker(cached.doc) && isServable(cached.doc)) {
    const stale = asEvent(cached.doc, 'cache');
    return stale.kind === 'event' ? { ...stale, adultContent: true, adultContentProven: false } : stale;
  }
  return { kind: 'not-found', hostname, reason };
}
