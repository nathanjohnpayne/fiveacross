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
 * Proof delete, and that is the LAST it touches it. This module is the other
 * half of that promise: the trigger on tombstone CREATE performs the revocation
 * server-side and retires the row, so a client that failed, navigated away, or
 * lost the network never strands the media. It throws on a real failure so Cloud
 * Functions redelivers (`retry: true`), which is the durability a client-side
 * retry cannot offer — and which is why #1153 retired the device-local
 * `localStorage` queue child 1 shipped as the interim record: this record is
 * atomic with the delete, visible from every device, and does not depend on the
 * deleting Player ever coming back.
 *
 * RETIREMENT IS THIS MODULE'S ALONE (#1153, Codex round 3 P1). `firestore.rules`
 * denies every client delete on the row, because the row's path is entirely
 * predictable and the media's OWNER is exactly the party an admin takedown is
 * aimed at: a blind delete against it would make `revokeProofMedia` find no
 * tombstone, abandon the sweep by design, and leave the reported photo
 * reachable. The Admin SDK bypasses those rules, so the sweeper below is the
 * only writer that ever clears one.
 *
 * IT IS ALSO THE ONLY WRITER THAT EVER LEASES ONE (#1153, Codex round 6 P2).
 * `retry: true` and ordinary platform duplication both mean two deliveries of
 * one CloudEvent can be in flight at once, and a Firestore read taken before a
 * bucket delete cannot serialise them — so a row is claimed for EXCLUSIVE
 * processing before anything is deleted, through a server-only `leaseId` /
 * `leaseAt` pair the rules admit from nobody. See `SWEEP_LEASE_TTL_MS`.
 *
 * Every seam is injected, so the whole flow is unit-testable without a Functions
 * runtime or an emulator (the `autohide.ts` / `notify.ts` precedent).
 */

import { randomUUID } from 'node:crypto';

// The canonical persisted shape, declared ONCE for both compiler roots
// (`src/domainTypes.d.ts`, the `dailyEmailContent.ts` / `finaleContent.ts`
// precedent). The browser writes this row and this module consumes it, so the
// contract cannot live locally in either half without letting the writer and
// the sweeper drift — Codex round 4 P1 on PR #1163.
import type { ProofStorageDeleteDoc } from '../../src/domainTypes';

/**
 * The tombstone body AS READ, which is not the same thing as the contract.
 *
 * `ProofStorageDeleteDoc` says what a well-formed row IS; this says what the
 * sweeper is holding before it has checked. Every field is `unknown` because
 * the Admin SDK bypasses `firestore.rules` entirely and this handler holds a
 * bucket-wide delete: a hand-written document could carry anything at all under
 * these names, so the reading side must not be able to assume a `string` it has
 * not proved. `confinedProofMediaPath` and `isSameRevocation` are where the
 * unknowns are discharged.
 *
 * PINNED TO THE CONTRACT BELOW, so this cannot quietly fall behind it: a field
 * added to `ProofStorageDeleteDoc` and not mirrored here — or mirrored here and
 * not declared there — fails `cd functions && npm run build`.
 */
export interface ProofStorageDeleteInput {
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
  /**
   * The sweep lease — SERVER-ONLY, and the reason this module writes to the row
   * at all (#1153, Codex round 6 P2). See `SWEEP_LEASE_TTL_MS`.
   */
  leaseId?: unknown;
  leaseAt?: unknown;
}

/** `T` must be assignable to `U`, checked at compile time and erased at run time. */
type MustExtend<T extends U, U> = T;

/**
 * THE DRIFT GUARD (#1153, Codex round 4 P1). Both directions on purpose: a key
 * this module reads that the contract does not declare is a sweeper inventing a
 * field, and a key the contract declares that this module does not read is a
 * field the sweeper would silently stop modelling. Either way the build stops
 * until both halves are updated together.
 */
type _TombstoneShapeIsPinned =
  | MustExtend<keyof ProofStorageDeleteInput, keyof ProofStorageDeleteDoc>
  | MustExtend<keyof ProofStorageDeleteDoc, keyof ProofStorageDeleteInput>;

/**
 * The row's own bookkeeping, as opposed to a statement about WHICH revocation it
 * is (#1153, Codex round 6 P2). The sweeper writes these two and nothing else
 * ever does, so a row that has been leased is still the same row it was — which
 * is exactly why they must stay OUT of `isSameRevocation`. Naming them once, as
 * a type, is what lets the identity list below be pinned to "the contract minus
 * these" rather than restated by hand.
 */
type SweepLeaseKey = 'leaseId' | 'leaseAt';

/**
 * THE IDENTITY FIELDS, pinned to the contract (#1153, Codex round 6 P2). The
 * key-set guard above stops the two SHAPES drifting; this stops the identity
 * drifting from the shape. A field added to `ProofStorageDeleteDoc` fails the
 * build here until it is either listed as part of a revocation's identity or
 * declared to be lease bookkeeping — which is the choice that used to be made
 * silently by whether anyone remembered to add a line to `isSameRevocation`.
 */
const IDENTITY_FIELDS = ['storagePath', 'uid', 'requestedAt', 'generation'] as const;
type _IdentityFieldsArePinned =
  | MustExtend<(typeof IDENTITY_FIELDS)[number], Exclude<keyof ProofStorageDeleteDoc, SweepLeaseKey>>
  | MustExtend<Exclude<keyof ProofStorageDeleteDoc, SweepLeaseKey>, (typeof IDENTITY_FIELDS)[number]>;

/**
 * How long one delivery may hold a row before another may take it (#1153, Codex
 * round 6 P2).
 *
 * A lease has to expire, or a holder that crashed between claiming the row and
 * discharging it would hold the revocation FOREVER: the media would stay in the
 * bucket, the row would stand, and the Proof create arm's hold on that id would
 * stand with it. Ten minutes is an order of magnitude past the longest a holder
 * can possibly still be running — the trigger takes the Gen2 event-driven
 * default of 60 SECONDS, and the sweep inside it is one Firestore read, one
 * transaction, one bucket metadata read, one bucket delete and one more
 * transaction — and it is comfortably shorter than the hours `retry: true` keeps
 * redelivering, so a genuinely stuck sweep is re-attempted many times before the
 * platform gives up.
 *
 * IT IS ALSO THE RECOVERY LATENCY after a failed sweep, which is the cost side
 * of the number. A holder that rejects (a Storage 5xx) leaves its lease behind,
 * and its own redelivery arrives long before the lease ages out — that delivery
 * defers, rejects and is redelivered again, so the retry that actually gets to
 * work is the first one past this window. Ten minutes of extra latency on a
 * background revocation whose media has already left the Feed is a fair price
 * for not having to write a release path that can itself fail; shortening it
 * would only be safe down to the function's own timeout.
 *
 * It is not a correctness boundary on its own, which is what makes a wall-clock
 * TTL acceptable here. An expired lease that gets re-claimed while its original
 * holder is somehow still running cannot corrupt anything: every bucket delete
 * is bound to a generation READ UNDER A LEASE, so the overtaken holder's delete
 * answers `412` against anything the new holder replaced, and the retirement
 * refuses a holder whose lease has been taken over. The TTL decides liveness,
 * never safety.
 */
export const SWEEP_LEASE_TTL_MS = 10 * 60 * 1000;

/** One delivery's claim on a row: a fresh id, and the moment it was taken. */
export interface SweepLease {
  id: string;
  at: number;
}

/**
 * What the claim transaction found.
 *
 * `claimed` — the row is this delivery's, exclusively, until it retires the row
 * or the lease ages out. `held` — another delivery's lease is still live, so
 * this one does nothing and REJECTS, because nothing was discharged and only a
 * rejected delivery is redelivered. `lost` — the row is gone, or is no longer
 * the revocation this delivery was created for, which are the two conditions the
 * pre-check already abandons on and which the transaction re-asks because the
 * pre-check is a read at an earlier instant.
 */
export type SweepLeaseOutcome = 'claimed' | 'held' | 'lost';

/**
 * Is `row` under a lease that is still live at `now` (#1153, Codex round 6 P2)?
 *
 * Called from INSIDE the claim transaction, against the row that transaction
 * itself read, which is the only place the answer means anything.
 *
 * A lease this cannot read is NOT a lease. A missing or non-string `leaseId`, or
 * a `leaseAt` that is not a finite number, answers false and the row is
 * claimable — the safe direction, because the alternative is a hand-written row
 * that no delivery can ever claim, discharge or retire, which is precisely the
 * immortal poison row (and the permanently held Proof id behind it) the
 * structural comparison had to be introduced to avoid. Nothing reachable
 * produces one: the Admin SDK is the only writer of these two fields and it
 * writes them together, as this module's own transaction.
 *
 * A stamp far in the FUTURE expires too, for the same reason. The lease is
 * wall-clock bookkeeping across instances whose clocks are merely close, so the
 * window is measured in both directions: a lease taken by an instance running an
 * hour fast would otherwise pin the row for an hour after its holder had gone.
 */
export function hasActiveSweepLease(row: ProofStorageDeleteInput, now: number): boolean {
  if (typeof row.leaseId !== 'string' || row.leaseId.length === 0) return false;
  const at = row.leaseAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return Math.abs(now - at) < SWEEP_LEASE_TTL_MS;
}

export interface RevokeProofMediaDeps {
  /**
   * The row standing at `events/{eventId}/proofStorageDeletes/{proofId}` RIGHT
   * NOW, read with the Admin SDK — or `null` when nothing is there.
   *
   * Its CONTENT, not merely its existence (#1153, Codex round 3 P2). The event
   * snapshot is a statement about the past, and a delivery can arrive
   * arbitrarily late: `retry: true` keeps a failed one coming back for days, and
   * even a first delivery is not instantaneous. By the time it runs, the
   * revocation may already be discharged and the row retired by an earlier
   * delivery of this very event — retirement is server-only, so that is now the
   * only way one goes — at which point the rules deliberately FREE the Proof id
   * for reuse, and a Proof re-posted under that id can leave a tombstone of its
   * OWN at the very same path. An existence test answers "yes" to that second
   * row, so this hands back the row itself and `isSameRevocation` decides
   * whether it is the one this delivery was created for.
   */
  currentTombstone(): Promise<ProofStorageDeleteInput | null>;
  /**
   * Whether `events/{eventId}/proofs/{proofId}` still exists, read with the
   * Admin SDK. A standing tombstone is supposed to mean a Proof that is gone;
   * this is the sweeper asking rather than assuming.
   */
  proofExists(): Promise<boolean>;
  /**
   * CLAIM THE ROW FOR EXCLUSIVE PROCESSING (#1153, Codex round 6 P2), inside an
   * Admin SDK transaction that re-reads it and, in one atomic step, requires all
   * three of: the row is still there, `isSameRevocation` still holds against
   * `identity`, and `hasActiveSweepLease(row, lease.at)` is false or the live
   * lease is already `lease.id`. Only then does it stamp `{ leaseId: lease.id,
   * leaseAt: lease.at }` onto the row and answer `claimed`.
   *
   * THE LEASE IS WHAT SERIALISES THE BUCKET CALL, which the compare-and-delete
   * retirement never did. Both Firestore reads above it are PRE-checks taken at
   * one instant, and duplicate deliveries A and A2 of one event can both pass
   * them; A can then pause while A2 deletes the object and retires the row, the
   * freed Proof id is re-posted with new media at the very same path, and A
   * resumes holding a delete that is about to run. Retirement was already
   * protected — it re-reads and compares — but the DELETE was not, so the whole
   * protection sat downstream of the one operation that destroys bytes. A row
   * may now be swept by exactly one delivery at a time, and the reads that
   * authorise the delete happen under that exclusivity rather than before it.
   *
   * A rejection PROPAGATES, like every other Firestore failure here: nothing has
   * been deleted, and `retry: true` brings the delivery back to a row that is
   * still standing.
   */
  claimSweepLease(identity: ProofStorageDeleteInput, lease: SweepLease): Promise<SweepLeaseOutcome>;
  /**
   * The Storage generation the object at `storagePath` carries RIGHT NOW, or
   * `null` when nothing is there (#1153, Codex round 6 P2).
   *
   * Read under the lease, and only for a row that recorded no generation of its
   * own — the metadata read `deleteProof` attempts before the commit is best
   * effort, and a takedown must not fail because it failed. It is what lets even
   * that row take a GENERATION-BOUND delete: there is no unconditioned delete on
   * any path any more, so a replacement object cannot be removed by a stale
   * delivery even in the window a lease cannot cover.
   *
   * A 404 answers `null` — nothing to revoke — rather than rejecting. Every
   * other failure REJECTS and propagates: "I could not tell which object is
   * there" must never become "delete whatever is".
   */
  currentObjectGeneration(storagePath: string): Promise<string | null>;
  /**
   * Deletes the named Storage object, bound to `generation` — ALWAYS. Rejects
   * with a 404-shaped error if it is already gone, and with a 412-shaped one if
   * the generation no longer matches.
   *
   * The parameter is not nullable, which is the point (#1153, Codex round 6 P2):
   * a row that carried no generation now takes the one read under its lease, so
   * "delete whatever answers to this path" is not a call this seam can express.
   */
  deleteObject(storagePath: string, generation: string): Promise<void>;
  /**
   * Retires the tombstone — but ONLY if the row standing there is still the one
   * `identity` describes AND still carries THIS delivery's lease. A
   * COMPARE-AND-DELETE, run inside an Admin SDK transaction that re-reads the
   * row and applies `isSameRevocation` against it (#1153, Codex round 4 P2) plus
   * a `leaseId` check (#1153, Codex round 6 P2). Resolves `true` when it retired
   * the row and `false` when it left a different one — or a row another delivery
   * has since claimed, or nothing — where it was.
   *
   * `leaseId` is `null` only on the malformed-row path, which never claims a
   * lease because it never reaches the bucket: it drops a row whose `storagePath`
   * could not be confined, and no lease is needed to serialise an operation that
   * does not exist. The identity comparison still governs that delete.
   *
   * THE PRE-CHECK IS NOT THE RETIREMENT, which is the whole reason this dep has
   * this shape. `currentTombstone()` reads at one instant and every retirement
   * below happens at a later one, so an unconditional delete is a lost update
   * waiting for the gap between them: duplicate delivery A can validate row A,
   * pause, and let delivery A2 discharge and retire it; the rules FREE the Proof
   * id the moment that lands, so the id can be re-posted and taken down again,
   * leaving row B at the very same path. A's `ifGenerationMatch` then answers
   * 412 against B's object and A's unconditional retirement would delete B —
   * B's own delivery would find no tombstone, abandon by design, and B's media
   * would stay in the bucket. A revocation marked done that never happened is
   * the one state this collection exists to make impossible, so the identity
   * check has to be inside the same transaction as the delete rather than a
   * separate read some milliseconds earlier.
   *
   * A rejection PROPAGATES, like every other Firestore failure here: `retry:
   * true` brings the delivery back, and the row it could not retire is still
   * standing to be found.
   */
  retireTombstoneIfSame(
    identity: ProofStorageDeleteInput,
    leaseId: string | null,
  ): Promise<boolean>;
  /** Wall clock, injected so the lease's TTL is testable; defaults to `Date.now`. */
  now?(): number;
  /**
   * A fresh lease id, unique per DELIVERY rather than per event — two duplicate
   * deliveries of one CloudEvent must be able to tell each other apart, which is
   * the whole hazard the lease closes. Defaults to `randomUUID()`.
   */
  newLeaseId?(): string;
  /** Structured log sink; defaults to `console.warn`. */
  warn?(message: string, context: Record<string, unknown>): void;
}

export interface RevokeProofMediaTarget {
  eventId: string;
  proofId: string;
  tombstone: ProofStorageDeleteInput;
}

/**
 * Is the row standing at the tombstone's path the SAME revocation this delivery
 * was created for (#1153, Codex round 3 P2)?
 *
 * A path plus an existence test is not an identity. Retirement FREES the Proof
 * id for reuse, so the sequence "delivery A created → A's row retired by an
 * earlier delivery → the freed id re-posted and taken down again → row B
 * standing at the same path" is reachable, and a delayed delivery of A that
 * asked only `.exists` would proceed on its own stale snapshot: A's generation
 * answers `412` against B's object, and the retirement a 412 triggers would then
 * clear B while B's media is still in the bucket. That is a real revocation
 * marked done that never happened — the one state this collection exists to make
 * impossible.
 *
 * The row is CREATE-ONLY and update-denied in `firestore.rules`, so its fields
 * cannot change while it stands: two readings that agree on all four are two
 * readings of ONE row, and any disagreement is two different rows. `requestedAt`,
 * `storagePath` and `uid` are the three required keys; `generation` is the
 * optional fourth and is compared the same way, so present-against-absent is
 * itself a mismatch rather than a field quietly skipped.
 *
 * THE LEASE IS NOT PART OF THE IDENTITY (#1153, Codex round 6 P2). It is the one
 * thing on the row that DOES change while it stands, because this module writes
 * it — a leased row is the same revocation it was a moment earlier, and folding
 * the lease in would make every delivery's own claim look like somebody else's
 * row and abandon the sweep it had just been granted. The split is pinned at
 * compile time rather than left to this function's memory: `IDENTITY_FIELDS` is
 * checked against the contract minus `SweepLeaseKey`, so a new contract field
 * cannot join the row without a decision about which side of the line it is on.
 *
 * COMPARED STRUCTURALLY, NOT BY REFERENCE (#1153, Codex round 5 P2). All four
 * are primitives in every row `firestore.rules` admits, and for those
 * `sameFirestoreValue` IS `===`. The rules are not the only writer, though: the
 * Admin SDK bypasses them, so a hand-written row can carry an array or a map
 * under one of these names — and that is precisely the MALFORMED row
 * `revokeProofMedia`'s defensive path exists to retire. Strict equality made
 * that path unreachable. The event snapshot and the retirement transaction's own
 * re-read deserialise such a value into two DIFFERENT JavaScript objects, so
 * `===` reported two different revocations for one unchanged row,
 * `retireTombstoneIfSame` refused, and the poison row stood forever — with the
 * Proof create arm holding its id for just as long, because that hold lifts only
 * when the row is retired.
 *
 * A row that genuinely differs still mismatches, which is the property that
 * matters: `sameFirestoreValue` answers "these two readings describe the same
 * stored value", never "these two rows are close enough".
 */
export function isSameRevocation(
  current: ProofStorageDeleteInput,
  fromEvent: ProofStorageDeleteInput,
): boolean {
  return IDENTITY_FIELDS.every((field) =>
    sameFirestoreValue(current[field], fromEvent[field]),
  );
}

/**
 * Do two deserialisations describe the SAME Firestore value?
 *
 * Firestore hands back a fresh JavaScript object for every read, so reference
 * equality answers "same value" only for primitives. `isSameRevocation` needs a
 * comparison that survives a container, because a row this handler must be able
 * to RETIRE can legitimately contain one: `firestore.rules` type-checks all four
 * fields, but the Admin SDK bypasses the rules entirely, and a hand-written row
 * carrying an array or a map under `storagePath` is exactly the poison row the
 * malformed-path branch is there to drop (#1153, Codex round 5 P2).
 *
 * Deterministic, and deliberately narrow. It handles the value kinds a Firestore
 * read can actually produce AND compare soundly:
 *
 *   - primitives, `null` and `undefined` — `Object.is`, so this is `===` for
 *     every well-formed row, and a `NaN` matches itself;
 *   - arrays — same length, element-wise, recursively;
 *   - maps — same key SET, value-wise, recursively, and only for PLAIN objects
 *     (prototype `Object.prototype` or `null`), which is what a Firestore map
 *     deserialises to;
 *   - bytes — `Buffer`/`Uint8Array`, by length and content;
 *   - the Admin SDK's own value types — `Timestamp`, `GeoPoint`,
 *     `DocumentReference` — through the `isEqual` each of them publishes, which
 *     is the SDK's own answer to this question and costs no import. Calling it
 *     is safe on an untrusted row because a value that came back from Firestore
 *     is either one of those library types or plain JSON: a stored map cannot
 *     carry a function, so an `isEqual` found here is never supplied by whoever
 *     wrote the document.
 *
 * ANYTHING ELSE COMPARES UNEQUAL, which is the safe direction. A false negative
 * leaves a row standing for a delivery that still owes it; a false POSITIVE
 * would retire somebody else's revocation with its media still in the bucket,
 * which is the one state this collection exists to make impossible.
 */
export function sameFirestoreValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Everything past here needs two objects. `typeof null === 'object'`, and two
  // nulls were already answered above.
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameFirestoreValue(item, b[index]));
  }

  // Timestamp / GeoPoint / DocumentReference — the SDK's own equality, required
  // on BOTH sides so a library type is never asked to compare itself against a
  // plain map.
  const aIsEqual = (a as { isEqual?: unknown }).isEqual;
  const bIsEqual = (b as { isEqual?: unknown }).isEqual;
  if (typeof aIsEqual === 'function' && typeof bIsEqual === 'function') {
    return (aIsEqual as (other: unknown) => unknown).call(a, b) === true;
  }

  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
      return false;
    }
    return a.every((byte, index) => byte === b[index]);
  }

  if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && sameFirestoreValue(a[key], b[key]),
  );
}

/** A Firestore MAP, as opposed to some class instance this cannot reason about. */
function isPlainRecord(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
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
 * Retire the row this delivery is holding — atomically, or not at all.
 *
 * Every retirement in `revokeProofMedia` goes through here, and each one is a
 * COMPARE-AND-DELETE against the delivery's own event snapshot rather than an
 * unconditional delete of whatever now sits at the path (#1153, Codex round 4
 * P2). The pre-check `revokeProofMedia` performs is a read at one instant and
 * the retirement happens at a later one; the row can be retired and the freed
 * Proof id re-posted and taken down again in the gap, and an unconditional
 * delete would then clear a revocation this delivery knows nothing about,
 * leaving its media in the bucket with nothing left owing it.
 *
 * The identity is compared STRUCTURALLY (`sameFirestoreValue`), which is what
 * lets the malformed-row branch above actually retire what it drops: a row
 * carrying an array or a map under one of the four fields deserialises into a
 * fresh object on every read, so a reference comparison reported "not ours"
 * about a row that had not changed at all.
 *
 * AND IT MUST STILL CARRY THIS DELIVERY'S LEASE (#1153, Codex round 6 P2), on
 * every path that took one. Identity alone answers "is this the same
 * revocation"; the lease answers "and am I still the delivery discharging it".
 * A holder that stalled past the TTL and was overtaken has to leave the row
 * where it is: the delivery that took the lease from it is mid-sweep, and
 * retiring the row out from under it would free the Proof id while its bucket
 * call is still outstanding. `leaseId` is `null` only for the malformed-path
 * drop, which never claims one because it never touches the bucket.
 *
 * A refusal is LOGGED AND ACCEPTED, never rethrown. The row standing there
 * belongs to somebody else's delivery, which is still owed and still coming;
 * redelivering this one cannot make it ours, so there is nothing for `retry:
 * true` to improve. Whatever this delivery came to do — drop a poison row,
 * stand down on a returned Proof, take the object — has already been done or
 * decided by the time this is called.
 */
async function retireIfStillOurs(
  deps: RevokeProofMediaDeps,
  { eventId, proofId, tombstone }: RevokeProofMediaTarget,
  leaseId: string | null,
  warn: (message: string, context: Record<string, unknown>) => void,
): Promise<void> {
  const retired = await deps.retireTombstoneIfSame(tombstone, leaseId);
  if (!retired) {
    warn('proof media revocation: the tombstone was NOT retired — the row there is no longer ours', {
      eventId,
      proofId,
      storagePath: tombstone.storagePath,
      requestedAt: tombstone.requestedAt,
    });
  }
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
 * a write that did not come through `firestore.rules`. That drop only WORKS
 * because the retirement compares the row structurally (#1153, Codex round 5
 * P2): the malformed values this branch fires on are exactly the ones two reads
 * deserialise into two different objects, so a reference comparison refused to
 * retire the row it had just decided to drop, and the poison row — plus the
 * Proof-create hold that lives as long as it does — stood forever.
 *
 * FIVE CHECKS STAND BETWEEN THE ROW AND THE BUCKET, because the row is a
 * promise about the past and this runs in the future (#1153, Phase 4b P1 and
 * P2, Codex rounds 3 P2 and 6 P2). A tombstone is admitted only alongside its own
 * Proof's deletion and the Proof create arm now refuses to bring that id back
 * while the row stands, so a live Proof under a pending revocation should be
 * unreachable — but the Admin SDK bypasses those rules entirely and this handler
 * holds a bucket-wide delete, so "should be unreachable" is not a safe premise
 * for revoking media.
 *
 * FIRST, IS ANY DEBT STILL OWED. The triggering row is re-read on EVERY
 * delivery, not only when the path is unbound. Retirement is server-only
 * (#1153, Codex round 3 P1), so the row can only have gone one way: an EARLIER
 * delivery of this same event already discharged the revocation and cleared it,
 * which `retry: true` makes an ordinary thing to arrive after. The moment it is
 * cleared the rules FREE the Proof id for reuse. A delayed delivery that skipped
 * this check would still be holding a generation-less row (a metadata read that
 * failed) and would delete whatever now answers to that path: a permitted
 * re-post can have uploaded its replacement media BEFORE creating its Proof
 * document, so the Proof read below is still false and the object taken is the
 * NEW one, leaving a live Feed entry pointing at media that is gone. A missing
 * row therefore ends the delivery outright — no bucket call, and no tombstone
 * delete either, because there is nothing left to retire and a blind delete
 * could only take a LATER revocation's row with it.
 *
 * SECOND, IS IT THIS DELIVERY'S DEBT. Existence is not identity: the freed id
 * can be re-posted and taken down AGAIN, leaving a SECOND tombstone at the same
 * path, and a delivery that only asked "is something there" would answer yes to
 * somebody else's revocation. Proceeding on its own stale snapshot, it would
 * take `412` against the new object and then RETIRE the new row — a revocation
 * marked done with its media still in the bucket. So the standing row is
 * compared against the event snapshot's own operation identity
 * (`isSameRevocation`: `requestedAt`, `storagePath`, `uid`, `generation`), and a
 * mismatch is logged and ABANDONED with the row left exactly where it is. It is
 * not this delivery's to retire, and its own delivery is still coming.
 *
 * THIRD, AM I THE ONE SWEEPING IT (#1153, Codex round 6 P2). The two questions
 * above are PRE-checks and nothing more: they read the row at one instant, and
 * two duplicate deliveries of one event can both pass them. So the row is
 * CLAIMED — an Admin SDK transaction that re-asks both questions against its own
 * read and, atomically with the answer, stamps a lease naming this delivery. A
 * delivery that finds another live lease deletes nothing and retires nothing,
 * and REJECTS so `retry: true` brings it back to a lease that has aged out (see
 * the claim dep for why acking there would strand the revocation). Everything
 * below this line happens under that exclusivity.
 *
 * FOURTH, IS THE PROOF BACK. If it is THERE, the revocation is abandoned rather
 * than performed, because whatever the row was owed for, it is not this Feed
 * entry's media.
 *
 * FIFTH, IS IT THE SAME OBJECT — ALWAYS, NOT ONLY WHEN THE ROW SAID SO (#1153,
 * Codex round 6 P2). The delete is bound to the generation the row recorded; a
 * row that recorded none takes the generation READ UNDER THE LEASE instead, and
 * is deleted bound to that. There is no unconditioned "delete whatever answers
 * to this path" left anywhere, which is what the lease alone could not
 * guarantee: a lease is wall-clock bookkeeping and a generation binding is not,
 * so the two together mean even an overtaken holder's delete can only ever
 * remove the exact bytes it looked at. An object that is already gone at the
 * metadata read is the ordinary discharged revocation, and retires the row.
 *
 * The last two retire the row: neither condition can improve on redelivery, and
 * a row that cannot be discharged is a poison row. The first three retire
 * nothing — the first because the row it would retire is already gone, the
 * second because the row standing there belongs to a revocation this delivery
 * knows nothing about, and the third because it belongs to a delivery that is
 * still working on it. Only the third REJECTS, because only the third leaves a
 * revocation still owed.
 *
 * AND EVERY RETIREMENT IS ITSELF A COMPARE-AND-DELETE (#1153, Codex round 4
 * P2). The first two checks are a PRE-check: they read the row at one instant,
 * and the retirement they authorise happens at a later one — after a bucket
 * round trip, in the case that matters. The gap is enough. Duplicate delivery A
 * can validate row A and pause; A2 finishes and retires it; the rules free the
 * Proof id, which is re-posted and taken down again, leaving row B at the same
 * path — and A, resuming, takes `412` against B's object and would have deleted
 * B on the way out. B's own delivery would then find no tombstone, abandon by
 * design, and B's media would stay in the bucket. So `retireIfStillOurs` re-reads
 * the row inside a transaction and deletes it only while `isSameRevocation` —
 * and this delivery's own lease — still hold against it; a refusal is logged and
 * the row is left standing for the delivery it actually belongs to.
 *
 * THAT WAS NOT ENOUGH ON ITS OWN, which is what the lease is for (#1153, Codex
 * round 6 P2). The compare-and-delete protected the RETIREMENT and only the
 * retirement; the bucket call in front of it was still authorised by a read
 * taken before it. Run the same interleaving against a row whose metadata
 * capture failed and so carries NO generation: A and A2 both pass the two
 * pre-checks, A pauses, A2 deletes the object and retires the row, the freed
 * Proof id is re-posted with new media at the same path — and A resumes into an
 * UNCONDITIONED delete that removes the live replacement. Nothing downstream can
 * undo that; the bytes are gone. Hence both halves of this fix: exclusive
 * processing through the lease, so A2 cannot start while A holds the row, and a
 * generation binding on EVERY delete, so even a delete that escapes the lease
 * can only remove the object it was actually looking at.
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
    // `null` lease: this branch never claims one, because it never reaches the
    // bucket. There is nothing here to serialise — only a poison row to drop,
    // which the identity comparison already governs.
    await retireIfStillOurs(deps, { eventId, proofId, tombstone }, null, warn);
    return;
  }

  // THE ROW MUST STILL BE STANDING, AND IT MUST BE OURS. One strongly
  // consistent read, taken on every delivery before anything else is asked,
  // because a retired row means the revocation is already discharged AND the
  // Proof id is free again — so every later question in this function would be
  // answered about somebody else's object. Only an earlier delivery of this same
  // event can have retired it; no client may (#1153, Codex round 3 P1). Nothing
  // is deleted on this path, the tombstone least of all: there is no row of ours
  // left to retire, and a blind delete would take a LATER revocation's row with
  // it. A read failure propagates, for the same reason the Proof read's does.
  const current = await deps.currentTombstone();
  if (!current) {
    warn('proof media revocation skipped: the tombstone was already retired', {
      eventId,
      proofId,
      storagePath,
    });
    return;
  }

  // …AND IT MUST BE THE ROW THIS DELIVERY WAS CREATED FOR (#1153, Codex round 3
  // P2). Existence alone answers "yes" to a SECOND tombstone the freed Proof id
  // produced after the first was retired, and proceeding on the event snapshot
  // would then take `412` against that second revocation's object and RETIRE its
  // row with its media still in place. Abandoned rather than retired, and rather
  // than rethrown: the standing row is not ours to clear, redelivering this
  // event can never make it ours, and its own delivery is still owed.
  if (!isSameRevocation(current, tombstone)) {
    warn('proof media revocation abandoned: a DIFFERENT revocation now holds this path', {
      eventId,
      proofId,
      storagePath,
      requestedAt: tombstone.requestedAt,
      standingRequestedAt: current.requestedAt,
    });
    return;
  }

  // …AND THIS DELIVERY MUST BE THE ONE SWEEPING IT (#1153, Codex round 6 P2).
  // Everything above is a pre-check: two duplicate deliveries of one event can
  // both reach this line, and only one of them may go on to touch the bucket.
  // The claim re-asks both questions inside a transaction and, atomically with
  // the answer, stamps this delivery's lease on the row — so the Proof read, the
  // metadata read and the delete below all happen while no other delivery can be
  // doing the same. A rejection propagates: nothing has been deleted, and the row
  // is still standing for the redelivery `retry: true` brings.
  const lease: SweepLease = {
    id: (deps.newLeaseId ?? randomUUID)(),
    at: (deps.now ?? Date.now)(),
  };
  const claim = await deps.claimSweepLease(tombstone, lease);
  if (claim !== 'claimed') {
    // NOTHING IS DELETED AND NOTHING IS RETIRED on either outcome — but they end
    // the delivery in opposite ways, and the difference is the whole durability
    // of this handler.
    //
    // `lost` RESOLVES. The row is gone, or the row standing there is a different
    // revocation: this delivery owes nothing, exactly as the two pre-checks
    // above already decided for the same two reasons.
    //
    // `held` THROWS. Nothing was discharged, so acknowledging the delivery would
    // be a lie — and unlike everything else here, it is a lie the platform acts
    // on. `retry: true` redelivers a REJECTED delivery and only a rejected one,
    // so a holder that fails (a Storage 5xx, an instance killed mid-sweep) has
    // left the row leased, and its own redelivery arrives seconds later to find
    // that lease still live. Resolving there would ack the redelivery, end the
    // retry chain, and strand a revocation nobody is discharging — a durability
    // regression, on the one path this whole collection exists to keep durable.
    // Throwing costs an extra redelivery when the holder is genuinely still
    // running (it acks its own delivery, and the loser's next attempt finds the
    // row retired and resolves), and it is what makes "the lease ages out and
    // somebody sweeps" true rather than hopeful.
    if (claim === 'lost') {
      warn('proof media revocation abandoned: the row changed before the sweep lease was taken', {
        eventId,
        proofId,
        storagePath,
        requestedAt: tombstone.requestedAt,
        leaseId: lease.id,
      });
      return;
    }
    warn('proof media revocation deferred: another delivery holds the sweep lease', {
      eventId,
      proofId,
      storagePath,
      requestedAt: tombstone.requestedAt,
      leaseId: lease.id,
    });
    throw new Error(
      `proof media revocation deferred: ${eventId}/${proofId} is held by another sweep delivery`,
    );
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
    await retireIfStillOurs(deps, { eventId, proofId, tombstone }, lease.id, warn);
    return;
  }

  // EVERY DELETE IS GENERATION-BOUND, INCLUDING A ROW THAT RECORDED NONE (#1153,
  // Codex round 6 P2). The recorded generation is preferred — it names the object
  // the revocation was actually written about — and a row whose client-side
  // metadata read failed takes the generation the object carries RIGHT NOW,
  // read under the lease that keeps anyone else from replacing it in between.
  // The unconditioned path delete this used to fall back to is what let a stale
  // duplicate delivery remove a live re-post's media; it no longer exists.
  //
  // A metadata read that finds nothing there means the revocation is already
  // discharged — the ordinary outcome, where the deleting client's own inline
  // Storage delete won the race — so the row is retired without a bucket call.
  // Any other metadata failure REJECTS out of the dep and propagates.
  const recorded =
    typeof tombstone.generation === 'string' && tombstone.generation.length > 0
      ? tombstone.generation
      : null;
  const generation = recorded ?? (await deps.currentObjectGeneration(storagePath));
  if (generation === null) {
    warn('proof media revocation: the object was already gone before the delete', {
      eventId,
      proofId,
      storagePath,
    });
    await retireIfStillOurs(deps, { eventId, proofId, tombstone }, lease.id, warn);
    return;
  }

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
      await retireIfStillOurs(deps, { eventId, proofId, tombstone }, lease.id, warn);
      return;
    }
    if (!isObjectAlreadyGone(err)) throw err;
  }
  await retireIfStillOurs(deps, { eventId, proofId, tombstone }, lease.id, warn);
}
