import { ref, uploadBytes, getDownloadURL, deleteObject, getMetadata, type FirebaseStorage } from 'firebase/storage';
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
  opts: { stripExif?: boolean; eventId?: string } = {},
): Promise<{ path: string; url: string }> {
  // `EVENT_ID` is a live binding. Capture the action's scope before image
  // decoding or any other await so a delayed Event A upload cannot land under B.
  const eventId = opts.eventId ?? EVENT_ID;
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
  const path = `proofs/${eventId}/${uid}/${proofId}.${ext}`;
  const r = ref(storage, path);
  // #1410: new sensitive proof media must not enter shared or browser HTTP
  // caches. This changes new uploads only, not metadata on existing objects.
  await uploadBytes(r, payload, { contentType, cacheControl: PROOF_MEDIA_CACHE_CONTROL });
  // #335: identity in every real build. Under the Playwright e2e build ONLY, the
  // Storage emulator hands back its own origin (`http://127.0.0.1:9199/v0/b/…`),
  // which firestore.rules' proof-create `mediaURL` regex — which pins the
  // production `firebasestorage.googleapis.com` host on purpose — can never
  // match, so a real photo/audio Proof used to 403 in the emulator stack. The
  // canonicalization writes the production-shaped URL the rule actually expects,
  // so e2e exercises that regex for real; ProofFeed reads storagePath via the SDK
  // (loadProofMediaBlob) to load authenticated bytes from the emulator.
  const url = canonicalizeProofMediaUrl(await getDownloadURL(r));
  return { path, url };
}

export async function uploadAvatar(
  uid: string,
  blob: Blob,
  client: FirebaseStorage,
  assertCurrent: () => void,
): Promise<string> {
  // Profile media shares the captured private Auth incarnation. Image decoding
  // may yield long enough for that incarnation to retire: check again before
  // creating the reference or beginning any write, and after each SDK await.
  assertCurrent();
  const small = await downscaleImage(blob, 400, 0.85);
  assertCurrent();
  const r = ref(client, `avatars/${uid}.jpg`);
  await uploadBytes(r, small, { contentType: 'image/jpeg' });
  assertCurrent();
  // Identity in every real build. Under the e2e emulator build the download URL
  // is rewritten to its production-shaped twin, because `firestore.rules`'
  // `photoUrlOk` pins stored avatars to the production Storage host just as the
  // proof-create rule pins `mediaURL`; `Avatar` resolves it back to render.
  const url = await getDownloadURL(r);
  assertCurrent();
  return canonicalizeProofMediaUrl(url);
}

/**
 * The Storage GENERATION of an object, or `null` when it cannot be read (#1153).
 *
 * A path names a slot, not a blob: delete the object and upload another one
 * under the same name and the path still resolves, now to different bytes. The
 * media-revocation tombstone `deleteProof` writes therefore records the
 * generation of the object it actually targeted, so the server-side sweeper can
 * delete THAT object rather than whatever currently answers to its path — see
 * `functions/src/proofStorageDeletes.ts`.
 *
 * BEST EFFORT ON PURPOSE, and that is why it swallows everything. The value is a
 * refinement of a revocation that is already correct without it, while the read
 * is one more network round trip on a takedown path whose whole design goal is
 * that it cannot be made to fail: a tombstone denied — or never written — because
 * a HEAD request timed out would cost exactly the durability the row exists for.
 * A row with no generation is NOT revoked by bare path: the sweeper reads the
 * object's generation under its own sweep lease and binds the delete to that
 * instead (#1153, Codex round 6 P2), so what this read buys is one saved server
 * round trip and a binding to the object as it stood at DELETE time rather than
 * at sweep time — not the protection itself.
 */
export async function proofMediaGeneration(path: string, client: FirebaseStorage = storage): Promise<string | null> {
  try {
    const generation = (await getMetadata(ref(client, path))).generation;
    return typeof generation === 'string' && generation.length > 0 ? generation : null;
  } catch {
    return null;
  }
}

export async function deleteStoragePath(path: string, client: FirebaseStorage = storage): Promise<void> {
  try {
    await deleteObject(ref(client, path));
  } catch (err) {
    // Only swallow "already gone"; surface real failures (permission, network)
    // so callers don't delete the referencing doc and orphan the media.
    if ((err as { code?: string })?.code !== 'storage/object-not-found') throw err;
  }
}
