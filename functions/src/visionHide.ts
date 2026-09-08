/**
 * Server-authoritative Vision auto-hide (issue #133, ADR 0004 Phase 1).
 *
 * The CONSUMER half of Cloud Vision. `moderateProof` (the producer, #132)
 * writes `{ status: 'flagged', visionFlag }` onto a Proof whose media SafeSearch
 * scored as extreme/illegal — through `writeVisionVerdict` below, which parks the
 * verdict rather than creating a Proof that does not exist yet (#1143; see
 * `PROOF_SCANS_COLLECTION`) — but nothing acts on that flag: the
 * shipped report-count auto-hide (`./autohide`) is deliberately ACTIVE-ONLY and
 * leaves a `'flagged'` doc alone, precisely so a report bump can never downgrade
 * the stronger Vision state to a plain `'hidden'` an admin might restore without
 * ever learning why it was hidden. This module supplies the missing path: the
 * one writer allowed to take a `'flagged'` doc to `'hidden'`, because it is the
 * writer that KNOWS the doc is Vision-flagged and leaves `visionFlag` in place
 * so the resulting hide is never a plain one.
 *
 * The two paths therefore compose rather than fight, and the split is exactly
 * the doc's own state:
 *
 *   - `./autohide` owns `'active'` docs and the `reportCount` threshold. It is
 *     unchanged by this module — no predicate, no write, no invariant of it is
 *     touched (this file adds a second writer; it does not widen the first).
 *   - THIS module owns `'flagged'` docs carrying an extreme/illegal `visionFlag`,
 *     and reads no threshold at all. It additionally owns its own MARKER wherever
 *     that marker and the status have come apart (see `visionHideAction`): it
 *     backfills the marker onto an extreme/illegal Proof that reached `'hidden'`
 *     without one, and re-hides an `'active'` Proof whose marker still stands.
 *     The marker — not the status — is what holds the media through a claim
 *     confirm, so an admin who hides a flagged row before the trigger reaches it
 *     must not thereby demote a safety hide to a plain one, and no client, however
 *     stale its cached bundle, may publish a Proof whose hold the server still
 *     records.
 *
 * Extreme/illegal ONLY (ADR 0004). The app is intentionally racy, so the trigger
 * is an ALLOWLIST of the producer's extreme verdicts (`violence`, `extreme`) —
 * never `adult`/`racy`, and never an unrecognized future flag, which fails
 * closed to "do not hide" rather than open. Hiding is not authorization
 * (ADR 0001): it removes media from every Player's read path and touches no
 * Mark, no stat, and no Board.
 *
 * It is also NOT a posting gate (PRD non-goal): the scan runs on the uploaded
 * object, so the hide is always reactive — the Proof exists, the Mark stands,
 * and only the media stops being readable.
 *
 * Deployment independence (#132 is human provisioning): the trigger that calls
 * this is a plain Firestore trigger and is exported UNCONDITIONALLY, unlike the
 * `ENABLE_VISION_MODERATION`-gated `moderateProof` export. With Vision off
 * nothing ever writes a `visionFlag`, so the trigger short-circuits on every
 * write and costs one predicate; with Vision on the consumer is already live and
 * needs no second cutover. Gating it on the same flag would additionally mean a
 * proof flagged while Vision was enabled silently stops being auto-hidden the
 * moment an operator turns the producer back off, which is the wrong direction
 * to fail.
 *
 * The Firestore surface is injectable so the whole flow is unit-testable without
 * a Functions runtime, mirroring `./autohide` and `./notify`.
 */

import { adminFirestore, type AdminFirestore } from './autohide';

/**
 * The `visionFlag` values that warrant an automatic hide: the two verdicts
 * `moderateProof` emits for extreme/illegal media (`violence >= LIKELY`, or
 * `adult >= VERY_LIKELY && violence >= POSSIBLE`).
 *
 * An ALLOWLIST, not a denylist, and that is the ADR 0004 guarantee rather than a
 * style choice. The app is intentionally racy; auto-hiding for raciness is the
 * one outcome this feature must never produce. A denylist ("hide unless the flag
 * is `racy`") would auto-hide every flag a future producer learns to write —
 * `adult`, `spoof`, `medical` — the moment it appeared, without a code change
 * here. The allowlist fails the other way: an unrecognized flag is surfaced to
 * admins as a `'flagged'` doc and hidden by nobody.
 */
export const AUTO_HIDE_VISION_FLAGS = ['violence', 'extreme'] as const;

export type AutoHideVisionFlag = (typeof AUTO_HIDE_VISION_FLAGS)[number];

/** Is this `visionFlag` one of the extreme/illegal verdicts that auto-hides? */
export function isAutoHideVisionFlag(flag: unknown): flag is AutoHideVisionFlag {
  return typeof flag === 'string' && (AUTO_HIDE_VISION_FLAGS as readonly string[]).includes(flag);
}

/** The subset of a Proof doc the Vision hide reads. */
export interface VisionFlaggedDoc {
  status?: string;
  visionFlag?: string | null;
  /** The marker below. Read as well as written, so a stamp is never re-applied. */
  safetyHide?: boolean | null;
}

/** The Proof document this module hides. */
export function proofPath(eventId: string, proofId: string): string {
  return `events/${eventId}/proofs/${proofId}`;
}

/**
 * The SERVER-ONLY collection that parks a Vision verdict whose Proof document
 * does not exist yet — `events/{eventId}/proofScans/{proofId}` — and the reason
 * the scanner is no longer allowed to touch the Proof at all in that case.
 *
 * `moderateProof` is a STORAGE trigger: it fires on the uploaded object, and
 * `attachProof` (src/data/proofs.ts) uploads the media BEFORE the transaction
 * that writes the Proof document. So the scan can reach a verdict while there is
 * no document to put it on — the upload-before-document race the #101 notifier
 * already names. The scanner used to close that gap by merge-setting the verdict,
 * which CREATES the Proof, and the created doc broke the submission that was
 * still on its way (Codex P1 on #1143):
 *
 *   - For an ordinary Player, `attachProof`'s `tx.set` is written as a CREATE and
 *     the rules judge it as one. Against a document the scanner had already
 *     created it becomes an UPDATE, where a non-admin is bounded to
 *     `hasOnly(['reportCount'])` — so the whole transaction is denied and the
 *     Player's submission fails outright, for no reason they could act on.
 *   - For an admin uploader the `isAdmin` arm ALLOWS that update, and the full
 *     `set` then overwrites `status`, `visionFlag` and `safetyHide` back to
 *     `'active'`, `null` and absent. The result matches no arm of
 *     `visionHideAction` below — not the hide arm (not `'flagged'`), not the
 *     re-hide arm (no marker), not the backfill arm (no verdict, not `'hidden'`)
 *     — so extreme/illegal media stays in the Feed with no server-side path left
 *     to take it down.
 *
 * The fix is that the Proof document has exactly ONE creator, `attachProof`. When
 * the scanner finds no Proof it records the verdict HERE instead, and
 * `applyPendingVisionScan` (below) applies it the moment the Proof appears, so
 * the verdict survives the race for every uploader and no submission fails
 * because the scanner got there first.
 *
 * NO CLIENT MAY READ OR WRITE THIS COLLECTION — `firestore.rules` denies every
 * verb to every client, an admin's included; the Admin SDK bypasses rules, and
 * the two transactional functions below are its only users. Nothing in `src/`
 * knows the path exists, which is the point: a Player could otherwise pre-empt
 * their own scan by writing the record, and an admin console that surfaced it
 * would be reading a hand-off rather than a decision.
 */
export const PROOF_SCANS_COLLECTION = 'proofScans' as const;

export function proofScanPath(eventId: string, proofId: string): string {
  return `events/${eventId}/${PROOF_SCANS_COLLECTION}/${proofId}`;
}

/** The parked verdict. `visionFlag` is whatever the producer decided to flag. */
export interface PendingVisionScan {
  visionFlag?: unknown;
  scannedAt?: unknown;
}

/**
 * The SERVER-OWNED marker this module stamps beside `status: 'hidden'`, and the
 * one fact the client's confirm-time gate reads (`safetyHideStands`,
 * src/data/moderation.ts).
 *
 * It exists because a client must never re-derive the verdict. `visionFlag` is a
 * string whose MEANING lives in `AUTO_HIDE_VISION_FLAGS` above, and Functions and
 * the PWA deploy separately: widen the allowlist here and, until every cached
 * bundle catches up, a client holding the older list reads a newly hide-worthy
 * verdict as safe and publishes a Proof this module deliberately hid. A boolean
 * the server writes carries no such interpretation — a client that has never
 * heard of the verdict still sees the hide.
 *
 * Tri-state by design, and the third state is the point: `true` = a safety hide
 * stands; `false` = an admin lifted it through the warned console Restore, which
 * is the one place an AI verdict may be overridden (`restoreProof`,
 * src/data/admin.ts, writes the `false` alongside the status); absent = no safety
 * hide has ever stood on this Proof. `visionFlag` stays put through all three, so
 * the audit record of WHAT was screened survives the lift exactly as before.
 */
export const SAFETY_HIDE_MARKER = 'safetyHide' as const;

/**
 * The whole decision, as a pure predicate over the doc's RESULTING state: it is
 * currently `'flagged'` AND carries an extreme/illegal `visionFlag`.
 *
 * Deliberately a STATE predicate, where the report-count path's snapshot gate is
 * a TRANSITION one (`shouldHideAtThreshold` needs "`reportCount` rose" to tell a
 * fresh crossing from an admin restore that left the count over the bar). Here
 * the status carries that distinction on its own, and three properties fall out
 * of using one predicate at both the snapshot gate and the live write-time
 * re-confirm:
 *
 *   - Loop guard. Our own write makes the doc `'hidden'`, not `'flagged'`, so
 *     the re-fired `onDocumentWritten` no-ops — and it carries the marker, so
 *     neither does any other arm of `visionHideAction` below. No infinite loop.
 *   - Admin Restore is preserved. `restoreProof` (src/data/admin.ts) clears the
 *     `safetyHide` marker and leaves `visionFlag` in place as the audit record of
 *     what the admin overrode. That doc is no longer `'flagged'`, so this path
 *     never re-hides it and the restore sticks — the same shape as the report
 *     path's restore, which survives because it leaves `reportCount` un-raised.
 *     The explicit `false` it writes is equally load-bearing: it is what keeps the
 *     re-hide arm off a genuinely restored Proof. A restored Proof is re-hidden
 *     only by a fresh scan (a re-upload re-flags it) or by an admin.
 *   - Retry-safe. Because it reads state rather than a transition, ANY later
 *     write that leaves the doc `'flagged'` with an extreme flag (a report bump,
 *     an admin Clear reports) re-attempts a hide that an earlier swallowed
 *     best-effort failure never landed. A transition gate would have to see the
 *     flag appear again, which nothing would ever do.
 */
export function qualifiesForVisionHide(doc: VisionFlaggedDoc | undefined): boolean {
  if (!doc) return false; // delete — nothing to hide
  if (doc.status !== 'flagged') return false; // active/pending/hidden are not ours to move
  return isAutoHideVisionFlag(doc.visionFlag); // extreme/illegal only — never raciness (ADR 0004)
}

/**
 * What this trigger owes one Proof, given the state a write left it in. `null` —
 * the overwhelmingly common answer — is "nothing", and the three named arms are
 * the three ways a Proof can be out of step with the server's own safety record.
 *
 *   - `'hide'` — the hide itself: `'flagged'` with an extreme/illegal verdict,
 *     exactly `qualifiesForVisionHide` above.
 *   - `'backfill'` — a `'hidden'` Proof carrying an extreme/illegal verdict but
 *     NO boolean marker. The hold is real and the record of it is missing, which
 *     happens whenever something OTHER than this trigger performed the hide: an
 *     admin's own Hide on a row the trigger had not reached yet (the console
 *     offers Hide on a `'flagged'` row, and the trigger is not instantaneous), or
 *     a hide whose marker write was lost to a swallowed best-effort failure.
 *     Left unstamped, `confirmClaim` reads that Proof as a PLAIN hide and
 *     publishes it, which is the hole this arm closes.
 *   - `'rehide'` — an `'active'` Proof whose marker still says `true`. That
 *     combination is not reachable from any current client: every legitimate lift
 *     writes `safetyHide: false` in the SAME update as the status (`restoreProof`,
 *     src/data/admin.ts), and `confirmClaim` declines to publish at all while
 *     `safetyHideStands`. It IS reachable from a CACHED one — a PWA bundle built
 *     before either gate shipped, still open in an admin's tab, running the old
 *     unconditional `confirmClaim` publish or the old marker-less `restoreProof`.
 *     Enforcement therefore cannot live only on the client: the read rule exposes
 *     `'active'` Proofs to every Player, so a stale tab would put extreme/illegal
 *     media back in the Feed with no server-side path to take it down again —
 *     the hide arm sees `'active'`, not `'flagged'`, and stands down forever.
 *     This arm is that path. The marker is kept, so the re-hidden doc still
 *     carries the record the confirm gate reads.
 *
 * Absent-or-non-boolean, never `false`, is the whole precision of the backfill
 * test. `false` is the warned console Restore's explicit override (`restoreProof`
 * writes it beside the status), and re-stamping `true` over it would let the
 * server silently overrule the one decision ADR 0004 reserves for a human. A
 * Proof an admin Restored and then hand-Hid keeps that `false` and stays a plain
 * hide — liftable by Restore, publishable by a confirm — because the admin has
 * already seen the verdict and overridden it. The same `false` is what makes the
 * re-hide arm safe to state as broadly as it is: it fires on the marker alone,
 * with no verdict test, because an override records itself in the same write it
 * overrides with, and a Restore that has already happened is never contested.
 *
 * `'pending'` is deliberately NOT re-hidden. It is admin-only readable, so a
 * standing marker there exposes nothing to Players; it is also where the
 * claim-aware Restore deliberately parks a Proof whose claim is undecided, and
 * re-hiding that would fight the console rather than a stale tab.
 */
export type VisionHideAction = 'hide' | 'backfill' | 'rehide';

export function visionHideAction(doc: VisionFlaggedDoc | undefined): VisionHideAction | null {
  if (!doc) return null; // delete — nothing to write
  if (qualifiesForVisionHide(doc)) return 'hide';
  if (doc.status === 'active' && doc[SAFETY_HIDE_MARKER] === true) return 'rehide';
  if (
    doc.status === 'hidden' &&
    isAutoHideVisionFlag(doc.visionFlag) &&
    typeof doc[SAFETY_HIDE_MARKER] !== 'boolean'
  ) {
    return 'backfill';
  }
  return null;
}

/**
 * The update each action writes, and nothing beyond it. `visionFlag` survives
 * every arm — the hide has to stay legible as a Vision hide — and so does an
 * existing `status` the arm is not there to change.
 */
export function visionHideWrite(action: VisionHideAction): Record<string, unknown> {
  switch (action) {
    case 'hide':
      return { status: 'hidden', [SAFETY_HIDE_MARKER]: true };
    case 'backfill':
      // The status is ALREADY `'hidden'` — this arm supplies only the missing
      // record of why, so it re-asserts nothing it did not decide.
      return { [SAFETY_HIDE_MARKER]: true };
    case 'rehide':
      // The marker is ALREADY `true` and is deliberately left standing: the
      // hold was never lifted, only ignored by a client too old to read it.
      return { status: 'hidden' };
  }
}

/**
 * Transactionally apply whatever `visionHideAction` asks of the Proof's LIVE
 * state — the same write-time re-confirmation `hideIfQualifies` gives the report
 * path (#43 round 2 F1), so a delayed or retried trigger can never act on a stale
 * event snapshot:
 *
 *   - an admin who Restored (`'active'`) or Hid the Proof by hand since the
 *     trigger fired → no-op, so the admin's decision is not silently reverted
 *     and no marker is stamped on a hide the admin owns;
 *   - a Proof DELETED since the snapshot → no-op via `tx.update` on a missing
 *     doc, never a re-creating `set`;
 *   - a `visionFlag` no longer in the allowlist → no-op;
 *   - a marker that landed between the snapshot and the write → no-op, because
 *     the backfill arm reads the live boolean rather than the stale one.
 *
 * It writes `status` and the `safetyHide` marker, and NOTHING else. Leaving
 * `visionFlag` intact is the point of the whole ticket: the resulting doc is
 * `hidden` WITH its reason attached, which is what lets the console tell a Vision
 * hide from a report-count one and what `notify.ts` `deriveReason` already labels
 * with the flag rather than `(reports >= threshold)`.
 *
 * On the hide arm the marker rides the SAME update, so there is no window in
 * which a Proof is hidden without the server's record of why, and no second write
 * for a client to observe half of. See `SAFETY_HIDE_MARKER` for why the client
 * reads that boolean rather than re-deciding the verdict for itself.
 *
 * `db` is a parameter so the read-then-conditional-write is unit-testable with a
 * fake transaction. Returns whether it wrote.
 */
export async function hideVisionFlaggedIfQualifies(
  db: AdminFirestore,
  eventId: string,
  proofId: string,
): Promise<boolean> {
  const docRef = db.doc(proofPath(eventId, proofId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return false; // deleted since the snapshot — never re-create
    const action = visionHideAction(snap.data() as VisionFlaggedDoc | undefined);
    if (!action) return false;
    tx.update(docRef, visionHideWrite(action));
    return true;
  });
}

async function defaultHideVisionFlaggedIfQualifies(eventId: string, proofId: string): Promise<boolean> {
  return hideVisionFlaggedIfQualifies(await adminFirestore(), eventId, proofId);
}

/** Where `writeVisionVerdict` put the verdict: onto the Proof, or into the hand-off. */
export type VisionVerdictTarget = 'proof' | 'scan';

/**
 * The PRODUCER-side write, and the half of the #1143 fix that lives with the
 * scanner: record a Vision verdict WITHOUT ever creating the Proof document.
 *
 * One transaction, two arms, chosen by whether `attachProof` has committed yet:
 *
 *   - the Proof EXISTS → `tx.update` writes `{ status: 'flagged', visionFlag }`
 *     onto it, exactly what the scanner's merge-set used to write. `update`
 *     rather than `set` is the guarantee: a Proof deleted since the upload is
 *     never resurrected as a two-field ghost, the same promise
 *     `hideVisionFlaggedIfQualifies` already makes.
 *   - the Proof is ABSENT → `tx.set` parks the verdict in `proofScans` (above),
 *     and `applyPendingVisionScan` applies it when the Proof arrives.
 *
 * The transaction is what makes the hand-off airtight, and this is the whole
 * argument for it. A Firestore read-write transaction commits only if every
 * document it READ is unchanged — including one it read as ABSENT. So if
 * `attachProof` creates the Proof between this read and this commit, this
 * transaction ABORTS and retries, re-reads, and takes the first arm instead.
 * "The record was written" therefore implies "the Proof did not exist at commit
 * time", which implies the Proof's own create is still to come — and that create
 * is the write `applyVisionFlagHide` consults the record on. There is no
 * interleaving in which a verdict is parked and nothing ever picks it up.
 *
 * `db` is a parameter so the whole decision is unit-testable with a fake
 * transaction; `now` is one so the stamp is deterministic under test.
 */
export async function writeVisionVerdict(
  db: AdminFirestore,
  eventId: string,
  proofId: string,
  visionFlag: string,
  now: number = Date.now(),
): Promise<VisionVerdictTarget> {
  const proofRef = db.doc(proofPath(eventId, proofId));
  const scanRef = db.doc(proofScanPath(eventId, proofId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(proofRef);
    if (snap.exists) {
      tx.update(proofRef, { status: 'flagged', visionFlag });
      return 'proof';
    }
    tx.set(scanRef, { visionFlag, scannedAt: now });
    return 'scan';
  });
}

/**
 * The CONSUMER side of the same hand-off: apply a parked verdict to the Proof
 * that has just been created, and consume the record in the same transaction.
 *
 * The write is the producer's own — `{ status: 'flagged', visionFlag }`, the
 * verdict string verbatim — so the Proof reaches exactly the state a scan that
 * had won the race would have left it in, and the hide it now deserves is
 * decided where every other hide is: by `visionHideAction` on the write this
 * makes, which re-fires the trigger and takes the `'flagged'` doc to `'hidden'`
 * with the marker. NO allowlist is consulted here. The producer decides what is
 * worth FLAGGING (and a future producer may flag more); this module decides what
 * is worth HIDING, and the split has to survive the race intact or the race
 * would quietly become a second, laxer policy.
 *
 * Exactly-once by construction: the record is deleted in the same transaction
 * that applies it, so no later write can re-flag a Proof whose verdict an admin
 * has since acted on. A record whose Proof is (still, or again) missing is left
 * alone for the create that will consume it; a malformed one is dropped rather
 * than written onto the Proof.
 */
export async function applyPendingVisionScan(
  db: AdminFirestore,
  eventId: string,
  proofId: string,
): Promise<boolean> {
  const proofRef = db.doc(proofPath(eventId, proofId));
  const scanRef = db.doc(proofScanPath(eventId, proofId));
  return db.runTransaction(async (tx) => {
    // Reads before writes, and the cheap one first: the overwhelming majority of
    // Proof creates have no parked verdict and stop here having read one doc.
    const scanSnap = await tx.get(scanRef);
    if (!scanSnap.exists) return false;
    const proofSnap = await tx.get(proofRef);
    if (!proofSnap.exists) return false; // deleted again already — leave the record
    const visionFlag = (scanSnap.data() as PendingVisionScan | undefined)?.visionFlag;
    if (typeof visionFlag !== 'string' || visionFlag.length === 0) {
      tx.delete(scanRef); // nothing a producer would have written — drop it
      return false;
    }
    tx.update(proofRef, { status: 'flagged', visionFlag });
    tx.delete(scanRef);
    return true;
  });
}

async function defaultApplyPendingVisionScan(eventId: string, proofId: string): Promise<boolean> {
  return applyPendingVisionScan(await adminFirestore(), eventId, proofId);
}

/**
 * `moderateProof`'s seam onto `writeVisionVerdict`, resolving the shared
 * admin-SDK handle the way every other default in this module does. The Storage
 * trigger calls THIS rather than writing the Proof itself, which is what makes
 * `attachProof` the Proof document's only creator.
 */
export async function recordVisionVerdict(
  eventId: string,
  proofId: string,
  visionFlag: string,
): Promise<VisionVerdictTarget> {
  return writeVisionVerdict(await adminFirestore(), eventId, proofId, visionFlag);
}

/**
 * The trigger-side gate on the hand-off lookup: is THIS write the Proof's own
 * creation, arriving without a verdict?
 *
 * A parked record exists only because the scanner found no Proof, and the Proof's
 * create is therefore the write that must consume it (see `writeVisionVerdict`
 * for why no record can be parked AFTER the create). Gating on the create keeps
 * every other Proof write — every report bump, every admin action, every write
 * this trigger makes itself — on the pre-#1143 cost of one predicate and no read.
 * A create that already carries a verdict cannot be waiting on one: the rules
 * pin `visionFlag == null` at create, and `attachProof` writes exactly that.
 */
export function awaitsPendingVisionScan(
  before: VisionFlaggedDoc | undefined,
  after: VisionFlaggedDoc | undefined,
): boolean {
  if (before !== undefined || after === undefined) return false;
  return after.visionFlag === null || after.visionFlag === undefined;
}

export interface VisionHideDeps {
  /** Transactionally apply the arm the Proof's LIVE state asks for, if any; defaults to `hideVisionFlaggedIfQualifies`. */
  hideIfQualifies?: (eventId: string, proofId: string) => Promise<boolean>;
  /** Transactionally consume a parked verdict, if one is waiting; defaults to `applyPendingVisionScan`. */
  applyPendingScan?: (eventId: string, proofId: string) => Promise<boolean>;
}

/**
 * Best-effort: decide on the event snapshot, then hand off to the TRANSACTIONAL
 * `hideVisionFlaggedIfQualifies`, which re-confirms live state before writing.
 * Never throws — a write failure is swallowed so the trigger never crashes the
 * proof pipeline (ADR 0001; mirrors `applyThresholdHide`, `moderateProof`, and
 * the #101 notifier). Returns whether it wrote.
 *
 * The snapshot predicate runs BEFORE any Firestore access, so the overwhelmingly
 * common write (every report bump, every admin action on an unscreened Proof, and
 * our own writes, which all leave a doc no arm claims) costs one predicate and no
 * read. Nothing here reads the Event doc at all: unlike the report threshold, the
 * Vision verdict is already on the Proof.
 *
 * A Proof's own CREATE is the one write that also consults the scanner hand-off
 * (`awaitsPendingVisionScan`, #1143), because a verdict reached while the Proof
 * did not exist is parked in `proofScans` rather than merge-created onto the
 * Proof, and the create is the write that must pick it up. That costs one read on
 * the write that already costs a document write, and nothing on any other. When a
 * verdict IS waiting, applying it leaves the Proof `'flagged'`, and the hide
 * itself happens on the re-fire through the ordinary arms — this function never
 * hides and flags in one write, so `visionHideAction` stays the single place a
 * status moves. The action pass still runs after a lookup that found nothing, so
 * a create is judged exactly as it was before.
 */
export async function applyVisionFlagHide(
  eventId: string,
  proofId: string,
  before: VisionFlaggedDoc | undefined,
  after: VisionFlaggedDoc | undefined,
  deps: VisionHideDeps = {},
): Promise<boolean> {
  try {
    if (awaitsPendingVisionScan(before, after)) {
      const applied = await (deps.applyPendingScan ?? defaultApplyPendingVisionScan)(eventId, proofId);
      if (applied) return true; // now 'flagged'; the re-fire hides it through the hide arm
    }
    if (!visionHideAction(after)) return false;
    return await (deps.hideIfQualifies ?? defaultHideVisionFlaggedIfQualifies)(eventId, proofId);
  } catch (err) {
    console.error('applyVisionFlagHide failed', err);
    return false;
  }
}
