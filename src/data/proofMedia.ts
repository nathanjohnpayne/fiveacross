import { getBlob, ref } from 'firebase/storage';
import { EVENT_ID } from '../firebase';
import { capturePrivateFirestore } from '../privateFirestore';

/** Authenticated bytes only: never consult a persisted bearer URL. */
export async function loadProofMediaBlob(storagePath: string): Promise<Blob> {
  const eventId = EVENT_ID;
  if (!storagePath.startsWith(`proofs/${eventId}/`)
    || !/^proofs\/[^/]+\/[^/]+\/[^/]+$/.test(storagePath)) {
    throw new Error('Invalid proof media path.');
  }
  const lease = capturePrivateFirestore();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const blob = await Promise.race([
      getBlob(ref(lease.storage, storagePath), 12 * 1024 * 1024),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Proof media unavailable.')), 8_000);
      }),
    ]);
    lease.assertCurrent();
    if (EVENT_ID !== eventId) throw new Error('Proof media Event changed.');
    return blob;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
