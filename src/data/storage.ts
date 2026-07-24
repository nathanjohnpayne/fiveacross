import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage, EVENT_ID } from '../firebase';
import { PROOF_MEDIA_CACHE_CONTROL } from './proofMediaCache';
import { canonicalizeProofMediaUrl } from './proofMediaUrl';

/** Downscale + re-encode an image in the browser so we upload ~100–300 KB, not 12 MP. */
export async function downscaleImage(file: Blob, max = 1280, quality = 0.82): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/jpeg', quality),
    );
    return blob ?? file;
  } catch {
    return file; // fall back to the original if the browser can't decode it
  }
}

// #295: iOS Safari's MediaRecorder records MP4/AAC, not WebM/Opus — the
// uploaded object's extension AND Content-Type must match what was ACTUALLY
// recorded (ProofSheet stamps the real recorder mimeType onto the Blob's own
// `type`, never assumes one), or the Storage object mislabels a genuinely
// playable clip and the Feed inherits the same "unplayable audio" bug the
// local preview had. `storage.rules` already accepts any `audio/.*`
// contentType (`okAudio()`), so only the extension/contentType MAPPING lives
// here. Falls back to the pre-#295 webm default for an empty/unrecognized
// type (an older MediaRecorder that reports no mimeType at all).
function audioExtAndContentType(blobType: string): { ext: string; contentType: string } {
  const base = blobType.split(';')[0].trim().toLowerCase();
  if (base === 'audio/mp4' || base === 'audio/aac') return { ext: 'm4a', contentType: 'audio/mp4' };
  return { ext: 'webm', contentType: 'audio/webm' };
}

export async function uploadProofMedia(
  uid: string,
  proofId: string,
  blob: Blob,
  kind: 'photo' | 'audio',
  // #211: strip EXIF/GPS from photo proofs so a library pick's geotags never
  // leave the phone. Default true (event `stripPhotoExif`); inert for audio.
  opts: { stripExif?: boolean } = {},
): Promise<{ path: string; url: string }> {
  const stripExif = opts.stripExif ?? true;
  let payload: Blob = blob;
  if (kind === 'photo') {
    // downscaleImage's canvas repaint drops ALL embedded metadata (EXIF, GPS,
    // orientation) — that repaint IS the strip. It returns the SAME object only
    // on its decode-failure fallback, where EXIF is still intact.
    payload = await downscaleImage(blob);
    if (stripExif && payload === blob) {
      // Fail closed rather than leak a geotag: refuse a photo we couldn't
      // re-encode. attachProof surfaces it as a retryable upload failure.
      throw new Error('uploadProofMedia: could not re-encode photo to strip EXIF/GPS');
    }
  }
  const { ext, contentType } =
    kind === 'photo' ? { ext: 'jpg', contentType: 'image/jpeg' } : audioExtAndContentType(payload.type);
  const path = `proofs/${EVENT_ID}/${uid}/${proofId}.${ext}`;
  const r = ref(storage, path);
  // #363: without an explicit cacheControl, Firebase Storage serves media as
  // `private, max-age=0` and the Feed refetches every photo on every visit.
  // Proof objects are immutable (path unique per proofId, never overwritten),
  // so the long-lived immutable policy is safe. Avatars below deliberately do
  // NOT get this: avatars/{uid}.jpg is overwritten in place on profile edits.
  await uploadBytes(r, payload, { contentType, cacheControl: PROOF_MEDIA_CACHE_CONTROL });
  // #335: identity in every real build. Under the Playwright e2e build ONLY, the
  // Storage emulator hands back its own origin (`http://127.0.0.1:9199/v0/b/…`),
  // which firestore.rules' proof-create `mediaURL` regex — which pins the
  // production `firebasestorage.googleapis.com` host on purpose — can never
  // match, so a real photo/audio Proof used to 403 in the emulator stack. The
  // canonicalization writes the production-shaped URL the rule actually expects,
  // so e2e exercises that regex for real; ProofFeed inverts it at render
  // (resolveProofMediaUrl) to load the bytes back from the emulator.
  const url = canonicalizeProofMediaUrl(await getDownloadURL(r));
  return { path, url };
}

export async function uploadAvatar(uid: string, blob: Blob): Promise<string> {
  const small = await downscaleImage(blob, 400, 0.85);
  const r = ref(storage, `avatars/${uid}.jpg`);
  await uploadBytes(r, small, { contentType: 'image/jpeg' });
  return await getDownloadURL(r);
}

export async function deleteStoragePath(path: string): Promise<void> {
  try {
    await deleteObject(ref(storage, path));
  } catch (err) {
    // Only swallow "already gone"; surface real failures (permission, network)
    // so callers don't delete the referencing doc and orphan the media.
    if ((err as { code?: string })?.code !== 'storage/object-not-found') throw err;
  }
}
