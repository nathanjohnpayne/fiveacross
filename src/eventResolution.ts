import type { HostnameDoc } from './types';
import { ADULT_CONTENT_DEFAULT, coerceAdultContent } from './adultContent';

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

export type { HostnameDoc };

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
      /** Whether this Event shows the 18+ acknowledgement (#608). Unlike
       *  `edition`, this is never `null`: there is no "unknown" posture a gate
       *  could render, so the env short-circuit — which reads no hostname
       *  document at all — reports the fail-closed default rather than deferring. */
      adultContent: boolean;
      /** Where the answer came from — surfaced for diagnostics, never for logic. */
      source: 'cache' | 'network' | 'env';
    }
  | { kind: 'not-found'; hostname: string; reason: 'missing' | 'inactive' | 'unreachable' };

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
 *  `cardCache.ts` uses for its snapshot version. */
export const CACHE_VERSION = 1;

/** How long a cached mapping may serve an Event without revalidation.
 *
 *  A hostname's Event assignment IS durable, which is why a cache is safe at
 *  all — but "durable" is not "permanent". If a host is archived or repointed,
 *  an unbounded cache would keep booting the old Event on that browser forever
 *  (Codex on #576). Twelve hours bounds that to well under a day while still
 *  covering a whole event-day of offline use. */
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface CacheEnvelope {
  v: number;
  fetchedAt: number;
  doc: HostnameDoc;
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
export function isServable(doc: Pick<HostnameDoc, 'status'> | null | undefined): boolean {
  return doc?.status === 'active';
}

export interface CacheRead {
  doc: HostnameDoc;
  fetchedAt: number;
  stale: boolean;
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
    const d = env.doc as Partial<HostnameDoc> | undefined;
    if (typeof d?.eventId !== 'string' || !d.eventId) return null;
    if (d.status !== 'active' && d.status !== 'disabled' && d.status !== 'archived') return null;
    return {
      doc: {
        eventId: d.eventId,
        canonicalHost: typeof d.canonicalHost === 'string' ? d.canonicalHost : hostname,
        edition: typeof d.edition === 'string' ? d.edition : '',
        status: d.status,
        // Coerced, not version-gated. Adding a field to the cached shape would
        // normally argue for a CACHE_VERSION bump, but a bump invalidates every
        // stored mapping — and the entries this would evict are exactly the ones
        // an offline cold boot depends on (step 3 below), so it would trade a
        // correct fail-closed default for a not-found screen. `undefined` here
        // reads as `true`, which IS the safe direction, so an entry written
        // before #608 is already correct.
        adultContent: coerceAdultContent(d.adultContent),
        slug: typeof d.slug === 'string' ? d.slug : undefined,
        isCanonical: typeof d.isCanonical === 'boolean' ? d.isCanonical : undefined,
      },
      fetchedAt: env.fetchedAt,
      stale: now - env.fetchedAt > CACHE_TTL_MS,
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
  doc: HostnameDoc,
  now: number = Date.now(),
): void {
  if (!storage) return;
  const env: CacheEnvelope = { v: CACHE_VERSION, fetchedAt: now, doc };
  try {
    storage.setItem(cacheKey(hostname), JSON.stringify(env));
  } catch {
    /* quota or private mode — cache is an optimisation, not a requirement */
  }
}

function dropCache(storage: StorageLike | null, hostname: string): void {
  try {
    storage?.removeItem?.(cacheKey(hostname));
  } catch {
    /* best effort */
  }
}

const asEvent = (doc: HostnameDoc, source: 'cache' | 'network'): Resolution => ({
  kind: 'event',
  eventId: doc.eventId,
  canonicalHost: doc.canonicalHost,
  edition: doc.edition,
  adultContent: doc.adultContent,
  slug: doc.slug ?? null,
  source,
});

export interface ResolveOptions {
  hostname: string;
  /** Injected Firestore `get`. Resolves to null when the document is absent. */
  fetchDoc: (hostname: string) => Promise<HostnameDoc | null>;
  storage?: StorageLike | null;
  /** `VITE_EVENT_ID`. Its PRESENCE marks a single-Event build. */
  envEventId?: string | null;
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
 *  0. **A single-Event build never looks up at all.** `VITE_EVENT_ID`'s
 *     PRESENCE is the signal that this bundle serves exactly one Event — the
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
 * on #576). An env-pinned build (`envEventId` present) mounts: `EVENT_ID`
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
    // `adultContent` is the fail-closed default here, NOT `null` like `edition`
    // (#608). The Edition splits because a single-Event build BAKES its own via
    // `VITE_EDITION`, so deferring to the seed is right; the 18+ posture has no
    // build-time seed to defer to, and the legacy Gay Cruise Bingo build this
    // path serves is 18+ anyway — so the default reproduces today's gate exactly.
    return {
      kind: 'event',
      eventId: envEventId,
      canonicalHost: null,
      edition: null,
      adultContent: ADULT_CONTENT_DEFAULT,
      slug: null,
      source: 'env',
    };
  }

  const cached = readCache(storage, hostname, now());
  if (cached && !cached.stale && isServable(cached.doc)) return asEvent(cached.doc, 'cache');

  const TIMED_OUT = Symbol('timeout');
  let doc: HostnameDoc | null;
  try {
    const raced = await Promise.race([
      fetchDoc(hostname),
      delay(timeoutMs).then(() => TIMED_OUT as unknown as HostnameDoc | null),
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
 *  answer available — an expired entry beats a dead app when the network is
 *  simply unreachable. */
function staleOrNotFound(
  cached: CacheRead | null,
  hostname: string,
  reason: 'missing' | 'unreachable',
): Resolution {
  if (cached && isServable(cached.doc)) return asEvent(cached.doc, 'cache');
  return { kind: 'not-found', hostname, reason };
}
