import { doc, getDoc } from 'firebase/firestore';
import { db, applyResolvedEventId } from '../firebase';
import { resolveEvent, type Resolution } from '../eventResolution';
import type { HostnameDoc } from '../types';
import { setCardCacheEventId } from './cardCache';

// The Firestore seam for hostname resolution (#543, ADR 0009). Kept apart from
// `eventResolution.ts` so the decision table stays pure and unit-testable; this
// module is the only part that touches the network.

const VALID_STATUS = new Set(['active', 'disabled', 'archived']);

/**
 * Fetch `hostnames/{host}`.
 *
 * A single `get`, never a query — the rule grants `get` and denies `list`
 * precisely so an address can be resolved without the collection becoming a
 * directory of every Event (specs/hostnames-lookup.md). Runs UNAUTHENTICATED:
 * this happens before sign-in, which is the whole reason the collection is
 * world-readable.
 *
 * Returns null for a missing document AND for a malformed one. A routing record
 * with no explicit, recognised `status` is NOT treated as active: defaulting it
 * would let a partially-written document publish an Event before the record
 * opts in, and would make this path disagree with the cache reader, which
 * rejects the same shape (Codex on #576). Null means "no usable mapping here",
 * which the resolver renders as not-found rather than as a failed read.
 */
export async function fetchHostnameDoc(hostname: string): Promise<HostnameDoc | null> {
  const snap = await getDoc(doc(db, 'hostnames', hostname.toLowerCase()));
  if (!snap.exists()) return null;
  const d = snap.data() as Partial<HostnameDoc>;
  if (typeof d.eventId !== 'string' || !d.eventId) return null;
  if (typeof d.status !== 'string' || !VALID_STATUS.has(d.status)) return null;
  return {
    eventId: d.eventId,
    canonicalHost: typeof d.canonicalHost === 'string' ? d.canonicalHost : hostname,
    edition: typeof d.edition === 'string' ? d.edition : '',
    status: d.status as HostnameDoc['status'],
    slug: typeof d.slug === 'string' ? d.slug : undefined,
    isCanonical: typeof d.isCanonical === 'boolean' ? d.isCanonical : undefined,
  };
}

/**
 * Resolve this origin's Event and install it, once, at startup.
 *
 * Returns the resolution so the caller can render an Event-not-found state
 * instead of mounting the app. It never throws and never hangs: `resolveEvent`
 * bounds the network read and always terminates in something renderable, which
 * is the guard against the blank-screen class this repo has shipped three fixes
 * for.
 */
export async function bootstrapEventResolution(
  hostname: string = window.location.hostname,
): Promise<Resolution> {
  const storage = safeLocalStorage();
  const resolution = await resolveEvent({
    hostname,
    fetchDoc: fetchHostnameDoc,
    storage,
    // PRESENCE marks a single-Event build, and short-circuits the lookup
    // entirely — see resolveEvent step 0.
    envEventId: import.meta.env.VITE_EVENT_ID || null,
  });
  if (resolution.kind === 'event') {
    applyResolvedEventId(resolution.eventId);
    // cardCache keeps its own copy of the id on purpose (it must stay free of
    // the Firebase import graph), so it has to be told separately. Miss this
    // and the offline card cache silently keys on a different Event than the
    // data it caches.
    setCardCacheEventId(resolution.eventId);
  }
  return resolution;
}

/** localStorage, or null where it is unavailable (private mode, embedded
 *  webviews). Touching it can THROW rather than return null, so the probe is
 *  wrapped — an unavailable cache must cost a round-trip, not a boot. */
function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
