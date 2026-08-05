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

/** The shape of a `hostnames/{host}` document (specs/hostnames-lookup.md). */
export interface HostnameDoc {
  eventId: string;
  canonicalHost: string;
  edition: string;
  status: string;
  slug?: string;
  isCanonical?: boolean;
}

export type Resolution =
  | {
      kind: 'event';
      eventId: string;
      canonicalHost: string | null;
      edition: string | null;
      /** Where the answer came from — surfaced for diagnostics, never for logic. */
      source: 'cache' | 'network' | 'env';
    }
  | { kind: 'not-found'; hostname: string; reason: 'missing' | 'inactive' | 'unreachable' };

/** Minimal storage seam so tests inject a fake and a private-mode browser that
 *  throws on access degrades to "no cache" rather than taking the app down. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CACHE_PREFIX = 'fa:hostname:';

/** Cache key is the HOSTNAME, not the slug: two hostnames can resolve to one
 *  Event, and a shared key would let an alias serve the canonical's cached
 *  edition (or vice versa) on the wrong origin. */
export const cacheKey = (hostname: string): string => `${CACHE_PREFIX}${hostname.toLowerCase()}`;

/** Read a cached resolution. Tolerates absent, corrupt, and shape-drifted
 *  entries by returning null — a bad cache must never be worse than no cache. */
export function readCache(storage: StorageLike | null, hostname: string): HostnameDoc | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(cacheKey(hostname));
  } catch {
    return null; // private mode / disabled storage
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<HostnameDoc>;
    if (typeof v?.eventId !== 'string' || !v.eventId) return null;
    if (typeof v?.status !== 'string') return null;
    return {
      eventId: v.eventId,
      canonicalHost: typeof v.canonicalHost === 'string' ? v.canonicalHost : hostname,
      edition: typeof v.edition === 'string' ? v.edition : '',
      status: v.status,
      slug: typeof v.slug === 'string' ? v.slug : undefined,
      isCanonical: typeof v.isCanonical === 'boolean' ? v.isCanonical : undefined,
    };
  } catch {
    return null;
  }
}

/** Persist a resolution. Never throws: a full or disabled quota costs a cache
 *  entry, not a boot. */
export function writeCache(storage: StorageLike | null, hostname: string, doc: HostnameDoc): void {
  if (!storage) return;
  try {
    storage.setItem(cacheKey(hostname), JSON.stringify(doc));
  } catch {
    /* quota or private mode — cache is an optimisation, not a requirement */
  }
}

const isActive = (doc: HostnameDoc): boolean => doc.status === 'active';

const asEvent = (doc: HostnameDoc, source: 'cache' | 'network'): Resolution => ({
  kind: 'event',
  eventId: doc.eventId,
  canonicalHost: doc.canonicalHost,
  edition: doc.edition,
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
}

const defaultDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve the Event for a hostname.
 *
 * ORDER, and why:
 *
 *  1. **Cache first, and it wins outright.** A cache hit returns with no
 *     network at all, which is what makes an offline cold boot work (ADR 0006,
 *     specs/x-offline-cold-boot.md) and what keeps first paint off the
 *     network's critical path. A hostname's Event assignment is durable, so a
 *     stale-but-valid entry is the right trade against a blank screen.
 *  2. **Network, hard-bounded.** No cache means one `get`, raced against
 *     `timeoutMs`. This repo has shipped three separate blank-screen fixes; an
 *     unbounded pre-paint read is exactly that failure class, so the race is
 *     load-bearing rather than defensive.
 *  3. **Env fallback, only for a single-Event build.** `VITE_EVENT_ID`'s
 *     PRESENCE is the signal that this bundle serves exactly one Event — the
 *     Gay Cruise Bingo build, whose hostname has no `hostnames/` document at
 *     all. A multi-Event build ships WITHOUT it, so an unknown host there
 *     correctly resolves to not-found instead of silently serving some
 *     arbitrary Event. That distinction is the only thing separating "legacy
 *     build, no lookup needed" from "unknown address, show not-found".
 *
 * Always terminates in something renderable. `not-found` is a state the app
 * draws, never an exception it has to catch.
 */
export async function resolveEvent(opts: ResolveOptions): Promise<Resolution> {
  const { hostname, fetchDoc, storage = null, envEventId = null } = opts;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const delay = opts.delay ?? defaultDelay;

  const cached = readCache(storage, hostname);
  if (cached && isActive(cached)) return asEvent(cached, 'cache');

  const TIMED_OUT = Symbol('timeout');
  let doc: HostnameDoc | null;
  try {
    const raced = await Promise.race([
      fetchDoc(hostname),
      delay(timeoutMs).then(() => TIMED_OUT as unknown as HostnameDoc | null),
    ]);
    if ((raced as unknown) === TIMED_OUT) {
      return envFallback(envEventId, hostname, 'unreachable');
    }
    doc = raced;
  } catch {
    // Offline, denied, or transport failure. A cached-but-inactive entry is not
    // a rescue: it already told us this Event should not be served.
    return envFallback(envEventId, hostname, 'unreachable');
  }

  if (!doc) return envFallback(envEventId, hostname, 'missing');

  if (!isActive(doc)) {
    // Disabled or archived. Deliberately NOT cached: caching it would keep the
    // Event dark for the cache's lifetime after someone re-activates it.
    return { kind: 'not-found', hostname, reason: 'inactive' };
  }

  writeCache(storage, hostname, doc);
  return asEvent(doc, 'network');
}

function envFallback(
  envEventId: string | null,
  hostname: string,
  reason: 'missing' | 'unreachable',
): Resolution {
  if (envEventId) {
    return { kind: 'event', eventId: envEventId, canonicalHost: null, edition: null, source: 'env' };
  }
  return { kind: 'not-found', hostname, reason };
}
