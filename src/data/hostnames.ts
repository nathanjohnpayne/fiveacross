import { doc, getDocFromServer } from 'firebase/firestore';
import { db, applyResolvedEventId } from '../firebase';
import { resolveEvent, type Resolution } from '../eventResolution';
import type { HostnameDoc } from '../types';
import { setCardCacheEventId } from './cardCache';
import { setActiveEdition, applyEditionDocumentIdentity } from '../editions';
import { applyResolvedCanonicalHost } from '../canonicalHost';

// The Firestore seam for hostname resolution (#543, ADR 0009). Kept apart from
// `eventResolution.ts` so the decision table stays pure and unit-testable; this
// module is the only part that touches the network.

const VALID_STATUS = new Set(['active', 'disabled', 'archived']);

/**
 * Fetch `hostnames/{host}` FROM THE SERVER.
 *
 * A single `get`, never a query — the rule grants `get` and denies `list`
 * precisely so an address can be resolved without the collection becoming a
 * directory of every Event (specs/hostnames-lookup.md). Runs UNAUTHENTICATED:
 * this happens before sign-in, which is the whole reason the collection is
 * world-readable.
 *
 * `getDocFromServer`, not `getDoc`, and that distinction is load-bearing. A
 * plain `getDoc` may answer from Firestore's OWN cache, so offline or on a
 * captive network a stale mapping would come back looking like a successful
 * revalidation — and `resolveEvent` would restamp `localStorage` for another
 * full TTL. The 12-hour bound on archived/repointed hostnames would then renew
 * itself indefinitely, which is the unbounded cache that bound exists to
 * prevent (Codex on #576). Refusing to answer from cache is stronger than
 * inspecting `snap.metadata.fromCache` after the fact: this call THROWS when
 * the server is unreachable, and `resolveEvent` routes a throwing fetch to its
 * stale-cache fallback, which serves the old mapping WITHOUT restamping it.
 * Offline players see no change; offline simply stops counting as proof that a
 * mapping is still good.
 *
 * Returns null for a missing document AND for a malformed one. A routing record
 * with no explicit, recognised `status` is NOT treated as active: defaulting it
 * would let a partially-written document publish an Event before the record
 * opts in, and would make this path disagree with the cache reader, which
 * rejects the same shape (Codex on #576). Null means "no usable mapping here",
 * which the resolver renders as not-found rather than as a failed read.
 */
export async function fetchHostnameDoc(hostname: string): Promise<HostnameDoc | null> {
  const snap = await getDocFromServer(doc(db, 'hostnames', hostname.toLowerCase()));
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
    // The Edition brands the PRE-AUTH shell (src/editions.ts) AND scopes every
    // Theme picker plus the Edition default Theme (src/theme/themes.ts reads
    // the same state — #580). This is the only point at which a RESOLVED
    // Edition can be installed: `events/{eventId}` needs `signedIn()`, so the
    // sign-in gate would otherwise render another product's wordmark.
    //
    // Guarded on `null`, not truthiness, because the type separates two
    // different absences. The env short-circuit returns `edition: null` — it
    // never reads a hostname document — so calling the setter there would reset
    // a single-Event Vacay build (`VITE_EVENT_ID` + `VITE_EDITION=vacay`)
    // straight back to `gcb` and undo the seed `editions.ts` just made from the
    // very same env (Codex on #576). A lookup that RAN, though, owns the
    // pre-auth brand outright: a routing doc with a missing/blank edition comes
    // back as `''`, and `setActiveEdition('')` resets to the default Edition —
    // otherwise a stray `VITE_EDITION` baked into a hostname-resolved build
    // would outrank the mapping it exists to defer to (Codex P3 round 6 on
    // #576).
    if (resolution.edition !== null) setActiveEdition(resolution.edition);
    // …and the browser chrome around it (#586). Unconditional, unlike the
    // setter above: the guard there protects the ENV-SEEDED Edition from being
    // reset by a lookup that never ran, whereas this only reads whatever
    // Edition is now active. On the env short-circuit it rewrites the string
    // index.html was already built with; on a resolved build it is the only
    // thing that stops a Vacay Event from sitting in a tab labelled "Gay
    // Cruise Bingo".
    applyEditionDocumentIdentity();
    // The canonical hostname (#556, CONTEXT.md § Canonical hostname) — the
    // address analytics and share metadata must report even when the Player
    // is presently on a validated Alias. `null` on the env short-circuit is
    // correct as-is: a single-Event build has no separate Alias concept, so
    // `canonicalOrigin()`'s own `window.location` fallback already IS
    // canonical for that build.
    applyResolvedCanonicalHost(resolution.canonicalHost);
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
