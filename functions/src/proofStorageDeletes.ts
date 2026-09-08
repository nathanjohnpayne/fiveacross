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
  /**
   * The Storage generation of the object the row was written about, when the
   * deleting client could read it (#1153). Optional: a takedown must not fail
   * because a metadata read did, so `deleteProof` omits the key rather than
   * writing a placeholder.
   */
  generation?: unknown;
}

export interface RevokeProofMediaDeps {
  /**
   * Whether `events/{eventId}/proofStorageDeletes/{proofId}` — the row that
   * TRIGGERED this delivery — is still standing, read with the Admin SDK.
   *
   * The event snapshot is a statement about the past, and a delivery can arrive
   * arbitrarily late: `retry: true` keeps a failed one coming back for days, and
   * even a first delivery is not instantaneous. By the time it runs, the
   * revocation may already be discharged and the row retired — by the deleting
   * client, or by an earlier delivery of this very event — at which point the
   * rules deliberately FREE the Proof id for reuse. This is the sweeper asking
   * whether the debt it is about to collect is still owed.
   */
  tombstoneExists(): Promise<boolean>;
  /**
   * Whether `events/{eventId}/proofs/{proofId}` still exists, read with the
   * Admin SDK. A standing tombstone is supposed to mean a Proof that is gone;
   * this is the sweeper asking rather than assuming.
   */
  proofExists(): Promise<boolean>;
  /**
   * Deletes the named Storage object, bound to `generation` when the row carried
   * one. Rejects with a 404-shaped error if it is already gone, and with a
   * 412-shaped one if the generation no longer matches.
   */
  deleteObject(storagePath: string, generation: string | null): Promise<void>;
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
 * "That is not the object this row was written about" — the generation
 * precondition failed (#1153, Phase 4b P1).
 *
 * `ifGenerationMatch` turns the delete into a compare-and-swap on the object's
 * identity, and Cloud Storage answers a mismatch with `412 Precondition Failed`.
 * The only way to reach it is that the name was re-occupied after the tombstone
 * was written, so the correct response is to leave the bytes alone: the object
 * the revocation was owed for is already gone, and whatever is there now was put
 * there by somebody else's write that this row says nothing about.
 *
 * Distinct from `isObjectAlreadyGone` because the two describe different worlds
 * even though both end in retirement — one means the debt was discharged, the
 * other means it can no longer be discharged against this path — and because a
 * mismatch is worth a log line while the 404 is the ordinary case.
 */
export function isGenerationMismatch(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 412 || code === '412';
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
 *
 * THREE CHECKS STAND BETWEEN THE ROW AND THE BUCKET, because the row is a
 * promise about the past and this runs in the future (#1153, Phase 4b P1 and
 * P2). A tombstone is admitted only alongside its own Proof's deletion and the
 * Proof create arm now refuses to bring that id back while the row stands, so a
 * live Proof under a pending revocation should be unreachable — but the Admin
 * SDK bypasses those rules entirely and this handler holds a bucket-wide
 * delete, so "should be unreachable" is not a safe premise for revoking media.
 *
 * FIRST, IS THE DEBT STILL OWED. The triggering row is re-read on EVERY
 * delivery, not only when the path is unbound: the ordinary case is precisely
 * the retired one — the deleting client's own Storage delete usually wins the
 * race and clears the row before this ever runs — and the moment it is cleared
 * the rules FREE the Proof id for reuse. A delayed delivery that skipped this
 * check would still be holding a generation-less row (a metadata read that
 * failed) and would delete whatever now answers to that path: a permitted
 * re-post can have uploaded its replacement media BEFORE creating its Proof
 * document, so the Proof read below is still false and the object taken is the
 * NEW one, leaving a live Feed entry pointing at media that is gone. A missing
 * row therefore ends the delivery outright — no bucket call, and no tombstone
 * delete either, because there is nothing left to retire and a blind delete
 * could only take a LATER revocation's row with it.
 *
 * SECOND, IS THE PROOF BACK. If it is THERE, the revocation is abandoned rather
 * than performed, because whatever the row was owed for, it is not this Feed
 * entry's media.
 *
 * THIRD, IS IT THE SAME OBJECT. The object is deleted by GENERATION when the
 * row recorded one, so even a name re-occupied by a blob with no document
 * pointing at it is left alone instead of swept.
 *
 * The last two retire the row: neither condition can improve on redelivery, and
 * a row that cannot be discharged is a poison row. The first retires nothing,
 * because the row it would retire is already gone.
 *
 * A read failure in either Firestore check PROPAGATES rather than resolving to
 * a delete: "I could not tell" must never become "delete it", and `retry: true`
 * brings the sweep back.
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

  // THE ROW MUST STILL BE STANDING. One strongly consistent read, taken on
  // every delivery before anything else is asked, because a retired row means
  // the revocation is already discharged AND the Proof id is free again — so
  // every later question in this function would be answered about somebody
  // else's object. Nothing is deleted here, the tombstone least of all: there is
  // no row of ours left to retire, and a blind delete would take a LATER
  // revocation's row with it. A read failure propagates, for the same reason the
  // Proof read's does.
  if (!(await deps.tombstoneExists())) {
    warn('proof media revocation skipped: the tombstone was already retired', {
      eventId,
      proofId,
      storagePath,
    });
    return;
  }

  // THE PROOF MUST BE ABSENT. A read failure is NOT swallowed: it propagates and
  // the platform redelivers, because "I could not tell whether a Feed entry
  // still points at this media" must never resolve to "delete it".
  if (await deps.proofExists()) {
    warn('proof media revocation skipped: a Proof document holds this id again', {
      eventId,
      proofId,
      storagePath,
    });
    await deps.deleteTombstone();
    return;
  }

  const generation =
    typeof tombstone.generation === 'string' && tombstone.generation.length > 0
      ? tombstone.generation
      : null;

  try {
    await deps.deleteObject(storagePath, generation);
  } catch (err) {
    if (isGenerationMismatch(err)) {
      warn('proof media revocation skipped: the object was replaced after the tombstone', {
        eventId,
        proofId,
        storagePath,
        generation,
      });
      await deps.deleteTombstone();
      return;
    }
    if (!isObjectAlreadyGone(err)) throw err;
  }
  await deps.deleteTombstone();
}
