import { getBlob, ref } from 'firebase/storage';
import { EVENT_ID } from '../firebase';
import { capturePrivateFirestore } from '../privateFirestore';

/** Share only in-flight bytes within one transport; bound work across transports. */
export function createProofMediaReads(concurrency = 4, pendingLimit = 128) {
  const transports = new WeakMap<object, Map<string, Promise<Blob>>>();
  type Job = { start: () => Promise<Blob>; resolve: (blob: Blob) => void; reject: (error: unknown) => void;
    done: () => void; timer?: ReturnType<typeof setTimeout> };
  const waiting: Job[] = [];
  let active = 0;
  const pump = () => {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift()!;
      clearTimeout(job.timer);
      active++;
      // A caller timeout does not cancel getBlob. Keep its slot until the SDK
      // settles, so repeated viewport entry cannot multiply abandoned requests.
      void Promise.resolve().then(job.start).then(job.resolve, job.reject).finally(() => {
        active--; job.done(); pump();
      });
    }
  };
  return (transport: object, key: string, start: () => Promise<Blob>): Promise<Blob> => {
    let reads = transports.get(transport);
    if (!reads) { reads = new Map(); transports.set(transport, reads); }
    const existing = reads.get(key);
    if (existing) return existing;
    if (waiting.length >= pendingLimit) return Promise.reject(new Error('Proof media busy.'));
    let job!: Job;
    const promise = new Promise<Blob>((resolve, reject) => {
      job = { start, resolve, reject, done: () => { reads!.delete(key); } };
    });
    reads.set(key, promise);
    job.timer = setTimeout(() => {
      const index = waiting.indexOf(job);
      if (index < 0) return;
      waiting.splice(index, 1); job.done(); job.reject(new Error('Proof media unavailable.'));
    }, 8_000);
    waiting.push(job); pump();
    return promise;
  };
}
const readProofMedia = createProofMediaReads();

/** Authenticated bytes only: never consult a persisted bearer URL. */
export async function loadProofMediaBlob(storagePath: string): Promise<Blob> {
  const eventId = EVENT_ID;
  if (!storagePath.startsWith(`proofs/${eventId}/`)
    || !/^proofs\/[^/]+\/[^/]+\/[^/]+$/.test(storagePath)) {
    throw new Error('Invalid proof media path.');
  }
  // Shared Feed media may render during attended recovery, like its reciprocal
  // block filter. This memory-only transport reads no quarantined private docs.
  const lease = capturePrivateFirestore(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const blob = await Promise.race([
      readProofMedia(lease.storage, JSON.stringify([eventId, lease.uid, lease.generation, storagePath]), () => {
        lease.assertCurrent();
        if (EVENT_ID !== eventId) throw new Error('Proof media Event changed.');
        return getBlob(ref(lease.storage, storagePath), 12 * 1024 * 1024);
      }),
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
