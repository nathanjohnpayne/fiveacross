// The Event's resolved canonical hostname (#556, CONTEXT.md § Canonical
// hostname): "the hostname analytics **report**... but not the host they
// **ingest to**" — this module is that reported identity. A validated Alias
// redirects to the canonical host at the edge before the app starts, so
// `window.location` is expected to already be canonical by the time any of
// this runs; this binding exists so analytics and share metadata do not have
// to TRUST that — they read the Firestore-resolved answer instead.
//
// Deliberately its own dependency-free module, not a `firebase.ts` export
// alongside `EVENT_ID`: dozens of component tests already
// `vi.mock('../firebase', ...)` with a narrow stand-in object (db, EVENT_ID,
// etc.), and widening that real module's surface would silently break every
// one of those mocks the moment a real call site invoked the new export. A
// separate module (mirrors `local-host.ts`) needs no existing mock touched;
// a test that cares can mock this file directly.

/** `null` until `applyResolvedCanonicalHost` runs — a single-Event build has
 *  no separate Alias concept, so `canonicalOrigin()`'s `window.location`
 *  fallback already IS canonical for that build. */
let canonicalHost: string | null = null;

/** Install the resolved canonical hostname. Call once, at startup, from
 *  `bootstrapEventResolution` (src/data/hostnames.ts) alongside the other
 *  resolved-state installers (`applyResolvedEventId`, `setActiveEdition`). */
export function applyResolvedCanonicalHost(host: string | null): void {
  canonicalHost = host;
}

/** The origin analytics and share metadata must report (#556): the resolved
 *  canonical hostname when known, else the page's own origin — which is the
 *  correct answer for a single-Event build and the safe fallback before
 *  resolution has run. */
export function canonicalOrigin(): string {
  return canonicalHost ? `https://${canonicalHost}` : window.location.origin;
}
