import { doc, getDocFromServer } from 'firebase/firestore';
import { db, EVENT_ID } from '../firebase';
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
 * The Proof DOCUMENT a queued object belongs to, derived from the object's own
 * path (#134, Phase 4b P2 on PR #1157 run 4).
 *
 * `uploadProofMedia` writes `proofs/{eventId}/{uid}/{proofId}.{ext}` and
 * `firestore.rules` pins `storagePath` to exactly that shape, so the object
 * names its own document — which is what lets the drain ask whether the delete
 * this entry records actually happened. Only the FINAL extension is stripped,
 * the same rule `storage.rules`' orphan carve-out applies, so a dotted proof id
 * such as `p.q` (media `p.q.jpg`) is recovered whole rather than truncated to
 * `p` (Phase 4b P1 on PR #1157 run 2 in the rules, the same trap here).
 *
 * `null` for anything that is not that shape: a path this build could not have
 * written, and one the drain therefore refuses to revoke from.
 */
function proofDocFromStoragePath(path: string): { eventId: string; proofId: string } | null {
  const segments = path.split('/');
  if (segments.length !== 4 || segments[0] !== 'proofs') return null;
  const eventId = segments[1];
  const file = segments[3];
  const dot = file.lastIndexOf('.');
  const proofId = dot > 0 ? file.slice(0, dot) : file;
  if (!eventId || !proofId) return null;
  return { eventId, proofId };
}

/** The default document check, injected so the drain is testable without
 *  Firestore. Rejecting is meaningful: the drain keeps the entry rather than
 *  revoking media it could not prove is unreferenced. */
async function proofDocumentExists(eventId: string, proofId: string): Promise<boolean> {
  // A SERVER read, never the cache (Codex P2 on PR #1157): after a commit whose
  // acknowledgement the tab never received, the persistent cache can still hold
  // the pre-delete document, and a cached `exists()` would clear the only retry
  // record without revoking the blob. Offline this rejects, and the drain keeps
  // the entry for a later attempt rather than reading absence into the cache.
  return (await getDocFromServer(doc(db, 'events', eventId, 'proofs', proofId))).exists();
}

/** The seams `drainProofMediaRevocations` takes so its decision is testable. */
export interface ProofMediaRevocationDeps {
  /** Does the Proof document this object belongs to still EXIST? */
  proofExists?: (eventId: string, proofId: string) => Promise<boolean>;
}

/**
 * Record the INTENT to revoke a Storage object, so a later drain can finish it.
 * Deduplicated (the same path queued twice is one entry) and bounded. Never
 * throws.
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
 * IT VERIFIES THE PROOF DOCUMENT IS GONE FIRST (#134, Phase 4b P2 on PR #1157
 * run 4). The entry is now written BEFORE the transaction is sent rather than
 * after it resolves, which is what covers a tab killed between Firestore
 * accepting the commit and the acknowledgement arriving — but it also means an
 * entry can outlive a transaction that never committed at all (a tab killed in
 * that same window, on the other side of the coin). `deleteProof` clears its
 * own intent when its transaction is REFUSED, so only the killed-tab case
 * reaches here undecided, and the object's path names the document that settles
 * it: a Proof that still exists is a Proof whose media must not be revoked, so
 * the entry is dropped without touching Storage. Dropping rather than keeping,
 * because the delete it recorded plainly did not happen and nothing later will
 * make it happen; the surviving Proof and its media are consistent.
 *
 * A path that names no document this build could have written, and a document
 * check that FAILS, are treated conservatively in opposite directions: the
 * unparseable path is dropped without a Storage call (it cannot be shown to be
 * an orphan, and an orphan is all this queue is for), and the failed check is
 * kept for the next drain (offline says nothing about the document).
 *
 * Resolves rather than rejects, always: every caller (app start, and the next
 * `deleteProof`) is doing this alongside work whose outcome is its own.
 *
 * The write-back re-reads the queue and removes only the CLEARED paths rather
 * than storing the leftovers wholesale, so a revocation queued by a concurrent
 * `deleteProof` while this drain was in flight is not silently dropped.
 */
/**
 * Forget a revocation that SUCCEEDED. The path is recorded before the Storage
 * delete starts (Codex P2 on PR #1157) so a tab killed between the commit and
 * the delete settling still leaves a record; this is the other half — the
 * record must not outlive the object, or the next drain would spend a delete
 * on nothing (harmless, `not-found` is swallowed, but it is litter of its own).
 */
export function clearProofMediaRevocation(path: string, eventId: string = EVENT_ID): void {
  if (!path) return;
  const queued = readQueue(eventId);
  if (!queued.includes(path)) return;
  writeQueue(eventId, queued.filter((queuedPath) => queuedPath !== path));
}

export async function drainProofMediaRevocations(
  eventId: string = EVENT_ID,
  deps: ProofMediaRevocationDeps = {},
): Promise<void> {
  const proofExists = deps.proofExists ?? proofDocumentExists;
  const queued = readQueue(eventId);
  if (queued.length === 0) return;
  const cleared: string[] = [];
  for (const path of queued) {
    const ref = proofDocFromStoragePath(path);
    // Not a path this build writes, so it cannot be shown to be an orphan.
    if (!ref) {
      cleared.push(path);
      continue;
    }
    let stillReferenced: boolean;
    try {
      stillReferenced = await proofExists(ref.eventId, ref.proofId);
    } catch {
      // The check itself failed (offline, a transient error). That says nothing
      // about the document, so keep the entry rather than guess in either
      // direction.
      continue;
    }
    // The delete this entry recorded never landed. Drop the intent and leave
    // Storage alone — the Proof still points at this object.
    if (stillReferenced) {
      cleared.push(path);
      continue;
    }
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

/**
 * Drain on EVERY signed-in transition, not only the restored one (Codex P2 on
 * PR #1157, round 7). A one-shot drain behind `authStateReady()` skipped the
 * queue when the app started signed out, and nothing ran it again after the
 * Player signed in through the ordinary screen — so an orphan queued on this
 * device could outlive any number of reopenings. The subscription is injected
 * so the wiring is testable without Firebase Auth: `main.tsx` passes
 * `onAuthStateChanged`, which also fires once with the restored state.
 */
export function drainProofMediaRevocationsOnSignIn(
  subscribe: (listener: (user: unknown) => void) => () => void,
  drain: () => Promise<void> = drainProofMediaRevocations,
): () => void {
  return subscribe((user) => {
    if (user) void drain().catch(() => undefined);
  });
}
