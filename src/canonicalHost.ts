// The Event's resolved canonical hostname (#556, CONTEXT.md § Canonical
// hostname): "the hostname analytics **report**... but not the host they
// **ingest to**" — this module is that reported identity. A validated Alias
// redirects to the canonical host at the edge before the app starts, so
// `window.location` is expected to already be canonical by the time any of
// this runs; this binding exists so analytics do not have to TRUST that —
// they read the Firestore-resolved answer instead.
//
// ANALYTICS ONLY (#607, superseding the original #556 scope). Share links
// deliberately do NOT consume this identity: under the amended multi-domain
// policy (#599) every serving host stays live and brands dynamically, so a
// shared link must carry the origin the sharer is actually standing on —
// `shareOrigin()` below — or the recipient lands (and the URL unfurls) under
// another Edition's brand. The canonical hostname remains the one-host-per-
// Event ANALYTICS dimension, so cross-host traffic still aggregates.
//
// Deliberately its own dependency-free module, not a `firebase.ts` export
// alongside `EVENT_ID`: dozens of component tests already
// `vi.mock('../firebase', ...)` with a narrow stand-in object (db, EVENT_ID,
// etc.), and widening that real module's surface would silently break every
// one of those mocks the moment a real call site invoked the new export. A
// separate module (mirrors `local-host.ts`) needs no existing mock touched;
// a test that cares can mock this file directly.

/** `null` until `applyResolvedCanonicalHost` runs — a single-Event build has
 *  no separate Alias concept, so the page's own `window.location` origin
 *  already IS canonical for that build. */
let canonicalHost: string | null = null;

/** Install the resolved canonical hostname. Call once, at startup, from
 *  `bootstrapEventResolution` (src/data/hostnames.ts) alongside the other
 *  resolved-state installers (`applyResolvedEventId`, `setActiveEdition`). */
export function applyResolvedCanonicalHost(host: string | null): void {
  canonicalHost = host;
}

/**
 * The RAW resolved canonical hostname, `null` when none has been resolved
 * (#556, Codex round-2 P2). Callers that need to know whether an actual
 * Alias-vs-canonical distinction exists for THIS build (posthog.ts's
 * URL-origin canonicalization, analytics.ts's `currentPageLocation`; a
 * single-Event build has none, and both must stay a no-op / fall back to the
 * page's own origin there) read this and apply their own fallback.
 */
export function resolvedCanonicalHost(): string | null {
  return canonicalHost;
}

/**
 * The origin a share LINK must carry (#607, amended multi-domain policy
 * #599): the ENTRY-POINT origin — the host the sharer is standing on — never
 * the analytics-canonical host above. Every serving host stays live and
 * brands dynamically, so the link has to land recipients on the same-branded
 * surface the sharer saw; rewriting it to one primary host is exactly the
 * unfurl mismatch #607 removes (a Bodega guest's share landing as Gay Cruise
 * Bingo). Alias-collapse is unaffected: a true redirect Alias never serves
 * the app, so no share can originate from one.
 *
 * Trivial on purpose, and kept HERE on purpose: the split between the
 * analytics identity (`resolvedCanonicalHost`) and the share identity (this)
 * is the decision, and one module holding both is what keeps a future reader
 * from "fixing" a share surface back onto the canonical host.
 */
export function shareOrigin(): string {
  return window.location.origin;
}
