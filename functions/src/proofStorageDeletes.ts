/**
 * Server-side completion of a Proof media revocation (#134 child 5, #1153;
 * `specs/post-sailing-archive.md` § "Moderation is not a gameplay write").
 *
 * `deleteProof` (src/data/proofs.ts) removes the Proof document and revokes its
 * Storage object as two operations against two services. The Firestore half goes
 * first, so a failed blob delete can never orphan a surviving Proof row — but
 * that commit is also what destroys the only record of which object was meant to
 * go, so a Storage failure afterwards would leave media reachable through its
 * download URL with nothing left to retry from.
 *
 * The client therefore writes a tombstone — `events/{eventId}/proofStorageDeletes/{proofId}`,
 * carrying `{ storagePath, uid, requestedAt }` — in the SAME transaction as the
 * Proof delete, and clears it once the object is provably gone. This module is
 * the other half of that promise: the trigger on tombstone CREATE performs the
 * revocation server-side, so a client that failed, navigated away, or lost the
 * network never strands the media. It throws on a real failure so Cloud
 * Functions redelivers (`retry: true`), which is the durability a client-side
 * retry cannot offer — and which is why #1153 retired the device-local
 * `localStorage` queue child 1 shipped as the interim record: this record is
 * atomic with the delete, visible from every device, and does not depend on the
 * deleting Player ever coming back.
 *
 * Every seam is injected, so the whole flow is unit-testable without a Functions
 * runtime or an emulator (the `autohide.ts` / `notify.ts` precedent).
 */

/** The tombstone body, as read off the created snapshot (untrusted — it is client-written). */
export interface ProofStorageDeleteDoc {
  storagePath?: unknown;
  uid?: unknown;
  requestedAt?: unknown;
}

export interface RevokeProofMediaDeps {
  /** Deletes the named Storage object. Rejects with a 404-shaped error if it is already gone. */
  deleteObject(storagePath: string): Promise<void>;
  /** Retires the tombstone once the object is provably gone. */
  deleteTombstone(): Promise<void>;
  /** Structured log sink; defaults to `console.warn`. */
  warn?(message: string, context: Record<string, unknown>): void;
}

export interface RevokeProofMediaTarget {
  eventId: string;
  proofId: string;
  tombstone: ProofStorageDeleteDoc;
}

/**
 * The tombstone's object path, CONFINED to the Event and Proof the row itself
 * belongs to — or `null` when it names anything else.
 *
 * `firestore.rules` already pins the path at create, so nothing reachable should
 * fail this. It is asked again here because the Admin SDK bypasses those rules
 * and this handler holds a bucket-wide delete: the question the rules answer is
 * "is this row well-formed for its author", the question here is "may THIS
 * trigger delete THAT object", and the second must not be taken on trust from
 * the first. It deliberately does not re-check the extension allowlist — the
 * confinement that matters is the Event prefix and the Proof id, and a narrower
 * check would only turn a legitimate future media type into a poison row.
 *
 * Only the FINAL extension is stripped, which is the same rule `storage.rules`'
 * orphan carve-out applies: a Proof id may itself carry a dot (`p.q`, media
 * `p.q.jpg`), and splitting on the first one would compare `p` against the id
 * and refuse a perfectly legitimate row (Phase 4b P1 on PR #1157, the same trap).
 */
export function confinedProofMediaPath(
  storagePath: unknown,
  eventId: string,
  proofId: string,
): string | null {
  if (typeof storagePath !== 'string') return null;
  const segments = storagePath.split('/');
  if (segments.length !== 4) return null;
  const [root, pathEventId, uid, file] = segments;
  if (root !== 'proofs' || pathEventId !== eventId || uid.length === 0) return null;
  const dot = file.lastIndexOf('.');
  if (dot <= 0 || file.slice(0, dot) !== proofId) return null;
  if (file.length - dot <= 1) return null;
  return storagePath;
}

/**
 * "Already gone" is SUCCESS, not a failure to retry.
 *
 * The common case is a race the design expects: the deleting client's own
 * Storage delete beat this trigger, so the object is missing by the time the
 * sweep arrives. Treating that as an error would retry a discharged revocation
 * until the platform gave up and would leave the tombstone behind forever.
 *
 * Both shapes are recognized because both can reach here: `@google-cloud/storage`
 * surfaces the Admin-SDK delete's 404 as a numeric `code`, while the Firebase
 * client SDK's `storage/object-not-found` is the string form the same condition
 * takes on the other side of this seam.
 */
export function isObjectAlreadyGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 404 || code === '404' || code === 'storage/object-not-found';
}

/**
 * Revoke one Proof's media and retire its tombstone.
 *
 * Ordering is the whole contract: the tombstone is removed ONLY after the object
 * is gone. A real Storage failure rethrows with the row still standing, so Cloud
 * Functions redelivers and the revocation is still owed; nothing is ever marked
 * done on the strength of an attempt.
 *
 * A row whose path escapes its own Event/Proof is dropped rather than retried:
 * redelivery cannot make an unconfinable path confinable, so retrying it only
 * buys an immortal poison row. It is logged, because the only way one exists is
 * a write that did not come through `firestore.rules`.
 */
export async function revokeProofMedia(
  deps: RevokeProofMediaDeps,
  { eventId, proofId, tombstone }: RevokeProofMediaTarget,
): Promise<void> {
  const warn = deps.warn ?? ((message, context) => console.warn(message, context));
  const storagePath = confinedProofMediaPath(tombstone.storagePath, eventId, proofId);
  if (!storagePath) {
    warn('proof media revocation refused: path outside its own Event/Proof', {
      eventId,
      proofId,
      storagePath: tombstone.storagePath,
    });
    await deps.deleteTombstone();
    return;
  }

  try {
    await deps.deleteObject(storagePath);
  } catch (err) {
    if (!isObjectAlreadyGone(err)) throw err;
  }
  await deps.deleteTombstone();
}
