// proofMediaCache — the single source of truth for how proof media is cached
// client-side (#363). Zero-dependency on purpose: src/sw.ts imports these
// constants to build the service worker's runtime-caching route, so this module
// must never pull in firebase (or anything browser-only) at import time — it is
// pulled into the SERVICE WORKER bundle, where nothing browser-only exists.
// (The importer was vite.config.ts until #514 moved the route into the
// hand-written worker; the zero-dependency constraint is unchanged and is now
// load-bearing for a second reason.)
//
// Proof objects have immutable paths, but their visibility can change after
// deletion or moderation. Path immutability does not justify retaining bytes.

/** New proof uploads must not populate shared or browser HTTP caches (#1410). */
export const PROOF_MEDIA_CACHE_CONTROL = 'private, no-store, max-age=0';

/**
 * Matches Firebase Storage download URLs for PROOF media only. getDownloadURL
 * always resolves to `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/
 * <url-encoded object path>?...`, and the encoding turns the path separators
 * into `%2F` — so `/o/proofs%2F` anchors this route to the proofs/
 * tree. Avatar URLs (`/o/avatars%2F...`, mutable objects) never match, and the
 * `^https://` anchor satisfies Workbox's rule that a cross-origin RegExp route
 * must match from the start of the URL.
 */
export const PROOF_MEDIA_URL_PATTERN = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/proofs%2F/i;

/** Legacy CacheFirst bucket, retained only for upgrade and local deletion purges. */
export const PROOF_MEDIA_CACHE_NAME = 'proof-media';

/**
 * Best-effort local purge alongside deleteProof (#373). The upgraded worker no
 * longer stores proof responses and deletes this legacy bucket on activation,
 * but an old worker may still own a cached copy on the deleting device. This
 * cannot recall another device's HTTP cache, old worker, or downloaded bytes.
 * Every failure is swallowed so it can never fail the authoritative delete.
 */
export async function purgeProofMediaFromCaches(mediaURL: string | null | undefined): Promise<void> {
  if (!mediaURL) return;
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(PROOF_MEDIA_CACHE_NAME);
    await cache.delete(mediaURL);
  } catch {
    // Best-effort, local-only purge (see doc comment above): swallow every
    // failure. The Storage delete already happened; this must never throw.
  }
}
