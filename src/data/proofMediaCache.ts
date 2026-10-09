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
 * longer stores proof responses and retires this legacy bucket plus its token-bearing Workbox expiration records on activation,
 * but an old worker may still own a cached copy on the deleting device. This
 * cannot recall another device's HTTP cache, old worker, or downloaded bytes.
 * An optional tokenless object URL identifies the captured bucket/path without
 * a persisted mediaURL. Query variants match only within that exact origin.
 * Every failure is swallowed so it can never fail the authoritative delete.
 */
export async function purgeProofMediaFromCaches(
  mediaURL: string | null | undefined,
  objectURL?: string | null,
): Promise<void> {
  if (!mediaURL && !objectURL) return;
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(PROOF_MEDIA_CACHE_NAME);
    if (mediaURL) await cache.delete(mediaURL).catch(() => false);
    if (!objectURL) return;
    const identity = (value: string) => {
      const url = new URL(value);
      const match = /^\/v0\/b\/([^/]+)\/o\/(.+)$/.exec(url.pathname);
      if (!match) return null;
      const path = decodeURIComponent(match[2]);
      return path.startsWith('proofs/')
        ? { origin: url.origin, bucket: decodeURIComponent(match[1]), path }
        : null;
    };
    const target = identity(objectURL);
    if (!target) return;
    const matching = (await cache.keys()).filter(request => {
      try {
        const key = identity(request.url);
        return key?.origin === target.origin && key.bucket === target.bucket && key.path === target.path;
      } catch { return false; }
    });
    await Promise.allSettled(matching.map(request => cache.delete(request)));
  } catch {
    // Best-effort, local-only purge (see doc comment above): swallow every
    // failure. The Storage delete already happened; this must never throw.
  }
}
