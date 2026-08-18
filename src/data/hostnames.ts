import { doc, getDocFromServer, onSnapshot } from 'firebase/firestore';
import { db, applyResolvedEventId } from '../firebase';
import { dropCache, isServable, readCache, resolveEvent, writeCache, type Resolution } from '../eventResolution';
import type { HostnameDoc } from '../types';
import { setCardCacheEventId } from './cardCache';
import { setActiveEdition, applyEditionDocumentIdentity } from '../editions';
import { coerceAdultContent, setActiveAdultContent } from '../adultContent';
import { applyResolvedCanonicalHost } from '../canonicalHost';
import { activeEventPreview, applyResolvedEventPreview, coerceEventPreview } from '../eventPreview';
import { hostnameKey } from '../hostnameKey';

// The Firestore seam for hostname resolution (#543, ADR 0009). Kept apart from
// `eventResolution.ts` so the decision table stays pure and unit-testable; this
// module is the only part that touches the network.

const VALID_STATUS = new Set(['active', 'disabled', 'archived']);

// The Event chosen before React mounts. The live hostname watcher is an update
// channel, not an Event switch, so its preview must keep agreeing with this
// bootstrap result. `null` keeps the watcher test seam usable on its own; the
// production watcher mounts only after bootstrap has installed the value.
let bootstrappedEventId: string | null = null;

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
  const snap = await getDocFromServer(doc(db, 'hostnames', hostnameKey(hostname)));
  if (!snap.exists()) return null;
  return coerceHostnameDoc(snap.data() as Partial<HostnameDoc>, hostname);
}

/** The one reading of a raw `hostnames/{host}` payload into the contract shape
 *  — extracted from `fetchHostnameDoc` (verbatim semantics) so the live
 *  watcher below can validate its snapshots identically before caching them.
 *  Two seams reading the same document must not disagree about what a usable
 *  mapping is. */
function coerceHostnameDoc(d: Partial<HostnameDoc> | undefined, hostname: string): HostnameDoc | null {
  if (typeof d?.eventId !== 'string' || !d.eventId) return null;
  if (typeof d.status !== 'string' || !VALID_STATUS.has(d.status)) return null;
  return {
    eventId: d.eventId,
    canonicalHost: typeof d.canonicalHost === 'string' ? d.canonicalHost : hostname,
    edition: typeof d.edition === 'string' ? d.edition : '',
    status: d.status as HostnameDoc['status'],
    // The 18+ posture (#608). Validated field-by-field like everything else
    // here, but it does NOT join the two null-returning guards above: a missing
    // or malformed `adultContent` is not a malformed routing record, it is an
    // Event that predates the field. Coercing it to `true` gates the Event;
    // rejecting the whole document would take the Event off the air.
    adultContent: coerceAdultContent(d.adultContent),
    slug: typeof d.slug === 'string' ? d.slug : undefined,
    isCanonical: typeof d.isCanonical === 'boolean' ? d.isCanonical : undefined,
    // The sign-in postcard's preview slice (#647). Optional and fail-soft like
    // `slug`: a malformed or absent slice costs the card, never the Event.
    preview: coerceEventPreview(d.preview),
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
    // The 18+ opt-out for that same single-Event build (#608). Passed as the
    // raw string; `resolveEvent` owns the fail-closed reading of it.
    envAdultContent: import.meta.env.VITE_ADULT_CONTENT || null,
  });
  if (resolution.kind === 'event') {
    bootstrappedEventId = resolution.eventId;
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
    // The 18+ posture (#608). UNCONDITIONAL, unlike the Edition setter above,
    // because the two absences are not the same absence: `edition: null` means
    // "a build-time seed already installed one, don't clobber it", whereas
    // `adultContent` has no build-time seed — the env short-circuit reports the
    // fail-closed default, so installing it there is a no-op that writes the
    // value the accessor would have answered anyway.
    setActiveAdultContent(resolution.adultContent, { proven: resolution.adultContentProven });
    // …and the browser chrome around it (#586). Unconditional, unlike the
    // setter above: the guard there protects the ENV-SEEDED Edition from being
    // reset by a lookup that never ran, whereas this only reads whatever
    // Edition is now active. On the env short-circuit it rewrites the string
    // index.html was already built with; on a resolved build it is the only
    // thing that stops a Vacay Event from sitting in a tab labelled "Gay
    // Cruise Bingo".
    applyEditionDocumentIdentity();
    // The canonical hostname (#556, CONTEXT.md § Canonical hostname) — the
    // address ANALYTICS must report even when the Player is presently on a
    // validated Alias. Analytics only: share links deliberately carry the
    // entry-point origin instead (`shareOrigin()`, #607). `null` on the env
    // short-circuit is correct as-is: a single-Event build has no separate
    // Alias concept, so the analytics consumers' own `window.location`
    // fallback already IS canonical for that build.
    applyResolvedCanonicalHost(resolution.canonicalHost);
    // The sign-in postcard's preview slice (#647). Installed unconditionally
    // so a re-bootstrap can not leak a previous hostname's preview onto
    // another Event's gate.
    //
    // The ENV SHORT-CIRCUIT reads no routing document AT ALL, which is where
    // the shipped card first failed in production: the deployed Bodega build
    // is env-pinned, so `resolution.preview` is always absent there even with
    // the slice seeded. Two channels close that gap without touching the
    // resolution posture (the short-circuit stays zero-network): at boot, the
    // cached envelope `watchAdultContent` wrote on an earlier visit paints the
    // card immediately (stale is fine — display copy, corrected by the live
    // snapshot moments later); and the watcher itself installs the live slice
    // when its first snapshot lands (see watchAdultContent below), a beat
    // after first paint on a first-ever visit. Never blocks mount.
    let preview = resolution.preview ?? null;
    if (!preview && resolution.source === 'env') {
      // An env-pinned build still has an authoritative Event id. A cache entry
      // from a prior Event on this hostname (or a manually retained inactive
      // entry) must not borrow its postcard while the listener catches up.
      const cachedMapping = readCache(storage, hostname)?.doc;
      if (
        cachedMapping?.eventId === resolution.eventId &&
        isServable(cachedMapping)
      ) {
        preview = cachedMapping.preview ?? null;
      }
    }
    applyResolvedEventPreview(preview);
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

/**
 * Watch THIS origin's 18+ posture and keep it installed (Phase 4b).
 *
 * The posture is the one field on `hostnames/{host}` that is expected to change
 * mid-session: an admin approves the first explicit Prompt, the derivation
 * stamps the routing document, and every already-open tab is now serving an
 * adults-only Event with no acknowledgement. Startup resolution cannot cover
 * that — it runs once, before the flip.
 *
 * A LISTENER, not a poll (Phase 4b round 3). The first cut polled on an
 * interval, on the mistaken reasoning that a listener would need `list`. It does
 * not: `onSnapshot` on an EXACT document path exercises the same `get` the rule
 * already grants — the `list` denial only blocks queries. The distinction
 * matters because a poll loses the race that matters. The Prompts a Player sees
 * arrive over their own live `items` listener the moment an admin approves, so a
 * five-minute posture poll means explicit content can reach the screen minutes
 * before the acknowledgement that gates it. A listener makes the gate arrive on
 * the same round trip as the content.
 *
 * This never re-resolves the Event or touches the Edition: routing is durable
 * and re-deciding it mid-session is the churn `resolveEvent`'s 12-hour TTL
 * exists to avoid. The narrow companion is the preview slice: an env-pinned
 * build cannot obtain it during routing resolution, so this same exact-document
 * subscription validates, installs, and caches that display-only data.
 *
 * PROVEN vs provisional, which is what licenses UN-gating. A snapshot served
 * from Firestore's local cache is not evidence about the posture NOW, so it may
 * raise the gate but never lower it; only a server-backed snapshot
 * (`metadata.fromCache === false`) can prove `false`. Same rule the resolver
 * follows, same reason.
 *
 * ON ERROR, GATE. A listener that errors — permission, transport, a dead origin
 * — leaves the posture UNKNOWN, and unknown resolves to gated (Phase 4b round
 * 3). Preserving a previously proven `false` through a failure was the exact
 * hazard: after the Event has transitioned, a transient failure reading THIS
 * document would leave the session ungated while every other Firestore read
 * happily delivers the newly active explicit Prompt. The gate installed here is
 * provisional, so a later successful server snapshot saying `false` lowers it
 * again.
 *
 * Runs on EVERY build shape, including the single-Event short-circuit. That
 * build resolves its Event from `VITE_EVENT_ID` and never reads a routing
 * document for routing — but if it baked `VITE_ADULT_CONTENT=false` it holds an
 * ungated posture that nothing can currently revoke, and this is the revocation
 * channel. A missing document therefore gates, which is the honest answer: an
 * opt-out with no channel to withdraw it is not one this design can offer.
 *
 * The adult posture itself is terminal once a server snapshot raises it, but
 * this subscription is not: it also carries the sign-in postcard's only live
 * preview channel for env-pinned builds. Keeping the document listener alive
 * after the posture latches lets an adult Event's first visit populate and
 * later correct its preview. `setActiveAdultContent` owns the monotone latch,
 * so those later snapshots can never lower a proven adult gate.
 *
 * Returns an unsubscribe. Never throws.
 */
export function watchAdultContent(
  hostname: string = window.location.hostname,
  resolvedEventId: string | null = bootstrappedEventId,
): () => void {
  const unsubscribe = onSnapshot(
    doc(db, 'hostnames', hostnameKey(hostname)),
    (snap) => {
      // Server-backed snapshots prove; cached ones may only ever RAISE.
      const proven = snap.metadata.fromCache === false;
      if (!snap.exists()) {
        // No routing document: no card to draw (localhost, a single-Event
        // origin that never got a mapping), and no channel through which an
        // ungated posture could ever be withdrawn, so it is not one we can
        // hold. The preview is only CLEARED on a proven miss — Firestore's
        // initial cache-served snapshot can report a document it simply has
        // no local copy of, and blanking an already-painted card on that
        // non-evidence would flicker it for every guest.
        if (proven) {
          applyResolvedEventPreview(null);
          dropCache(safeLocalStorage(), hostname);
        }
        setActiveAdultContent(true, { proven: false });
        return;
      }
      const data = snap.data() as Partial<HostnameDoc> | undefined;
      // The sign-in postcard's preview slice rides THIS listener too (#647
      // follow-up): an env-pinned build's resolution never reads the routing
      // document, so this shared snapshot — already streaming for the 18+
      // posture — is the only live channel through which its gate can learn
      // the Event's name. The store deduplicates by value, so re-delivery is
      // free.
      //
      // The MAPPING is validated before its preview is believed (Codex P2):
      // the resolver refuses to serve a disabled, archived or half-written
      // document, so the gate must not advertise that document's Event either
      // — a retired hostname with a leftover slice would otherwise keep
      // drawing its card. An unservable mapping reads as "no preview here",
      // which the provenance rule below then applies: any snapshot may SUPPLY
      // a card (stale display copy beats no card, and a server-backed
      // delivery follows to correct it), but only a proven one may CLEAR an
      // already-installed card — an older cache-served copy of the document,
      // valid or not, is not evidence about the slice NOW. NOTE the
      // the listener remains alive after the posture latches because it is also
      // the preview's update channel; the adult-content store itself refuses to
      // lower a proven adult state.
      const mapping = coerceHostnameDoc(data, hostname);
      const servable = mapping !== null && isServable(mapping);
      // The watcher is a display/update channel, never an Event switch. It must
      // agree with the Event resolved before mount: an env-pinned bundle that
      // sees a hostname remapped to another Event must clear its postcard, not
      // advertise a card belonging to data the app will never serve.
      const belongsToResolvedEvent =
        mapping !== null &&
        isServable(mapping) &&
        (resolvedEventId === null || mapping.eventId === resolvedEventId);
      const previewSlice = belongsToResolvedEvent ? (mapping.preview ?? null) : null;
      // A cached Firestore snapshot is useful to fill a blank card on a first
      // visit, but it is not evidence newer than an already-installed preview.
      // Only a server-backed snapshot may replace or clear that display copy.
      if (proven || (previewSlice && activeEventPreview() === null)) {
        applyResolvedEventPreview(previewSlice);
      }
      // …and a PROVEN, servable mapping is cached whole, so the NEXT boot of
      // an env-pinned build paints the card at bootstrap instead of a beat
      // after mount (bootstrapEventResolution's env branch reads it back).
      // Same validation as the resolver's own network path — never cache a
      // shape `readCache` would reject, never resurrect an inactive mapping —
      // and only from server-backed snapshots, mirroring the resolver's rule
      // that Firestore's own cache is not evidence (Codex on #576).
      if (proven && servable) writeCache(safeLocalStorage(), hostname, mapping);
      // Mirror resolveEvent's inactive/missing eviction. Without it, an
      // env-pinned next boot can read the old active envelope before the live
      // watcher has a chance to correct the card.
      if (proven && !servable) dropCache(safeLocalStorage(), hostname);
      const adult = coerceAdultContent(data?.adultContent);
      if (!adult && !proven) return; // a cached `false` proves nothing
      setActiveAdultContent(adult, { proven });
    },
    // Transport/permission failure: gate (a failure proves nothing about the
    // posture) but leave the preview as-is — display copy already on screen
    // does not become wrong because a listener dropped.
    () => setActiveAdultContent(true, { proven: false }),
  );
  return unsubscribe;
}
