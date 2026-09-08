import { EVENT_ID } from '../firebase';
import { deleteStoragePath } from './storage';

/**
 * The device-local, durable queue of proof-media objects whose Storage delete
 * did not land (#134 child 1, `specs/post-sailing-archive.md` § "Moderation is
 * not a gameplay write"; Codex P1 on PR #1157).
 *
 * WHY IT EXISTS. `deleteProof` commits the Firestore transaction BEFORE it
 * revokes the media, so a delete that loses the race with an Admin's quiesce
 * can never leave a surviving Proof pointing at media that is already gone —
 * the failure the freeze made routine, and the one a Player cannot repair,
 * because `firestore.rules` refuses the owner's document delete once the Event
 * is closed. Committing first inverts that failure into the recoverable
 * direction: what survives a failed Storage delete is a blob NO document points
 * at, and `storage.rules`' orphan carve-out lets its owner clear it in every
 * state, closed Events included.
 *
 * "Recoverable" is only true if something remembers the blob. The commit takes
 * the Proof, its `storagePath` and the surface that offered the delete all at
 * once, so this queue is the record that outlives them. It is written to
 * `localStorage`, so it survives the tab closing and the reload after it.
 *
 * WHAT IT IS NOT. This is durable on the DELETING DEVICE ONLY. A Player who
 * deletes a Proof, loses the Storage call, and never opens the app again on
 * that device leaves the blob behind, and no other device can see the entry.
 * The server-side tombstone and its sweeper —
 * [#1153](https://github.com/nathanjohnpayne/fiveacross/issues/1153) — are what
 * close the never-returns and cross-device cases; this queue is what makes the
 * ordering safe enough to ship ahead of them, not a substitute for them.
 *
 * EVERY `localStorage` TOUCH IS GUARDED. Private mode, a browser configured to
 * block site data, and a quota failure all throw on read or write, and a
 * corrupted value parses to nothing. None of those may break a delete that has
 * already committed, so every accessor falls open to "no queue" and the caller
 * is never told.
 */

/** Event-scoped, so a device that plays two Events never drains A's paths while
 *  B is the live scope (and `EVENT_ID` is a live binding that moves). */
const storageKey = (eventId: string) => `five-across:pending-proof-media-revocations:${eventId}`;

/** Bounded, because an offline device could otherwise queue without limit and
 *  eventually fail its own `setItem` on quota. The oldest entries lose: a
 *  recent revocation is the one most likely still to matter, and every entry is
 *  a best-effort retry rather than a guarantee. */
const QUEUE_LIMIT = 50;

function readQueue(eventId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(eventId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((path): path is string => typeof path === 'string' && path.length > 0);
  } catch {
    return [];
  }
}

function writeQueue(eventId: string, paths: string[]): void {
  try {
    if (paths.length === 0) localStorage.removeItem(storageKey(eventId));
    else localStorage.setItem(storageKey(eventId), JSON.stringify(paths));
  } catch {
    // A queue we cannot persist is a retry we do not get. The delete itself has
    // already committed and must still report its own outcome.
  }
}

/**
 * Record a Storage object whose revocation failed, so a later drain can retry
 * it. Deduplicated (the same path queued twice is one entry) and bounded.
 * Never throws.
 */
export function queueProofMediaRevocation(path: string, eventId: string = EVENT_ID): void {
  if (!path) return;
  const queued = readQueue(eventId);
  if (queued.includes(path)) return;
  writeQueue(eventId, [...queued, path].slice(-QUEUE_LIMIT));
}

/**
 * Retry every queued revocation, dropping the ones that succeed and keeping the
 * ones that do not. `deleteStoragePath` already resolves on
 * `storage/object-not-found`, so an object somebody else already removed drops
 * too — this queue's job is to stop pointing at blobs, not to prove it was the
 * one that removed them.
 *
 * Resolves rather than rejects, always: every caller (app start, and the next
 * `deleteProof`) is doing this alongside work whose outcome is its own.
 *
 * The write-back re-reads the queue and removes only the CLEARED paths rather
 * than storing the leftovers wholesale, so a revocation queued by a concurrent
 * `deleteProof` while this drain was in flight is not silently dropped.
 */
export async function drainProofMediaRevocations(eventId: string = EVENT_ID): Promise<void> {
  const queued = readQueue(eventId);
  if (queued.length === 0) return;
  const cleared: string[] = [];
  for (const path of queued) {
    try {
      await deleteStoragePath(path);
      cleared.push(path);
    } catch {
      // Still unreachable (offline, or the Event closed and this object is not
      // an orphan after all). Keep it for the next drain.
    }
  }
  if (cleared.length === 0) return;
  writeQueue(
    eventId,
    readQueue(eventId).filter((path) => !cleared.includes(path)),
  );
}
