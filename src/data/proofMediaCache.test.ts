import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PROOF_MEDIA_CACHE_CONTROL,
  PROOF_MEDIA_URL_PATTERN,
  PROOF_MEDIA_CACHE_NAME,
  purgeProofMediaFromCaches,
} from './proofMediaCache';

// #363 (specs/w2-proof-capture.md § Feed, specs/w1-pwa.md): the constants the
// service worker's proof-media route and uploadProofMedia's Cache-Control share.
// The RegExp decides which cross-origin proof fetches bypass all caches — so it gets a positive/negative URL matrix.

// The shape getDownloadURL actually returns for a proof upload: the object path
// URL-encoded under /o/, then the token query.
const proofUrl =
  'https://firebasestorage.googleapis.com/v0/b/gaycruisebingo.firebasestorage.app/o/proofs%2Fsummer-2026%2Fu123%2Fp456.jpg?alt=media&token=abc-def';

describe('PROOF_MEDIA_URL_PATTERN — the SW route matches proof media only (#363)', () => {
  it('matches a real proof download URL (photo and audio, any bucket name)', () => {
    expect(PROOF_MEDIA_URL_PATTERN.test(proofUrl)).toBe(true);
    expect(
      PROOF_MEDIA_URL_PATTERN.test(
        'https://firebasestorage.googleapis.com/v0/b/some-bucket.appspot.com/o/proofs%2Fevt%2Fu%2Fclip.m4a?alt=media&token=t',
      ),
    ).toBe(true);
  });

  it('does NOT match avatar URLs — avatars keep their existing fetch policy', () => {
    expect(
      PROOF_MEDIA_URL_PATTERN.test(
        'https://firebasestorage.googleapis.com/v0/b/gaycruisebingo.firebasestorage.app/o/avatars%2Fu123.jpg?alt=media&token=t',
      ),
    ).toBe(false);
  });

  it('does NOT match lookalike hosts or a proofs path on another origin', () => {
    // Host-suffix forgery: the RegExp must anchor the whole origin.
    expect(
      PROOF_MEDIA_URL_PATTERN.test('https://firebasestorage.googleapis.com.evil.example/v0/b/x/o/proofs%2Fa'),
    ).toBe(false);
    // Path forgery on another origin.
    expect(
      PROOF_MEDIA_URL_PATTERN.test('https://evil.example/firebasestorage.googleapis.com/v0/b/x/o/proofs%2Fa'),
    ).toBe(false);
    // Same host, non-proofs tree.
    expect(PROOF_MEDIA_URL_PATTERN.test('https://firebasestorage.googleapis.com/v0/b/x/o/other%2Fa')).toBe(false);
  });

  it('is a cross-origin-safe Workbox route: anchored to the start of the URL', () => {
    expect(PROOF_MEDIA_URL_PATTERN.source.startsWith('^https:')).toBe(true);
  });
});

describe('proof-media cache policy constants (#363)', () => {
  it('new proof uploads prohibit shared and browser HTTP retention (#1410)', () => {
    expect(PROOF_MEDIA_CACHE_CONTROL).toBe('private, no-store, max-age=0');
  });


});

// #373 (follow-up to #369): deleteProof's Storage delete is the authoritative
// revocation of a proof's media — this purge only stops the DELETING device's
// own already-fetched copy from continuing to render out of the legacy
// `proof-media` cache until its worker upgrades. It is local-only and best-effort by design, so every
// failure mode must be swallowed rather than propagated (a failed purge must
// never fail the delete it rides alongside).
describe('purgeProofMediaFromCaches — best-effort local purge of the deleting device’s own cached copy (#373)', () => {
  const cacheDelete = vi.fn();
  const cachesOpen = vi.fn();

  beforeEach(() => {
    cacheDelete.mockReset().mockResolvedValue(true);
    cachesOpen.mockReset().mockResolvedValue({ delete: cacheDelete });
    vi.stubGlobal('caches', { open: cachesOpen });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the proof-media cache bucket and deletes the exact mediaURL', async () => {
    const url = 'https://firebasestorage.googleapis.com/v0/b/b/o/proofs%2Fe%2Fu%2Fp.jpg?alt=media&token=t';
    await purgeProofMediaFromCaches(url);

    expect(cachesOpen).toHaveBeenCalledWith(PROOF_MEDIA_CACHE_NAME);
    expect(cacheDelete).toHaveBeenCalledWith(url);
  });

  it('no-ops (never opens a cache) when the URL is missing, null, or empty', async () => {
    await purgeProofMediaFromCaches(undefined);
    await purgeProofMediaFromCaches(null);
    await purgeProofMediaFromCaches('');

    expect(cachesOpen).not.toHaveBeenCalled();
  });

  it('no-ops when `caches` is unsupported (e.g. Safari private mode, non-SW context)', async () => {
    vi.stubGlobal('caches', undefined);

    await expect(purgeProofMediaFromCaches('https://firebasestorage.googleapis.com/x')).resolves.toBeUndefined();
    expect(cachesOpen).not.toHaveBeenCalled();
  });

  it('swallows a caches.open rejection rather than throwing', async () => {
    cachesOpen.mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(purgeProofMediaFromCaches('https://firebasestorage.googleapis.com/x')).resolves.toBeUndefined();
  });

  it('swallows a cache.delete rejection rather than throwing', async () => {
    cacheDelete.mockRejectedValueOnce(new Error('boom'));

    await expect(purgeProofMediaFromCaches('https://firebasestorage.googleapis.com/x')).resolves.toBeUndefined();
  });
});
