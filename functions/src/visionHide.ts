/**
 * Server-authoritative Vision auto-hide (issue #133, ADR 0004 Phase 1).
 *
 * The CONSUMER half of Cloud Vision. `moderateProof` (the producer, #132)
 * merge-sets `{ status: 'flagged', visionFlag }` onto a Proof whose media
 * SafeSearch scored as extreme/illegal — but nothing acts on that flag: the
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
 *     and reads no threshold at all.
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
}

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
 *     the re-fired `onDocumentWritten` no-ops. No infinite loop.
 *   - Admin Restore is preserved. `restoreProof` (src/data/admin.ts) writes
 *     `status: 'active'` and deliberately LEAVES `visionFlag` in place as the
 *     audit record of what the admin overrode. That doc is no longer `'flagged'`,
 *     so this path never re-hides it and the restore sticks — the same shape as
 *     the report path's restore, which survives because it leaves `reportCount`
 *     un-raised. A restored Proof is re-hidden only by a fresh scan (a re-upload
 *     re-flags it) or by an admin.
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
 * Transactionally flip one Vision-flagged Proof to `'hidden'` ONLY if its LIVE
 * state still qualifies — the same write-time re-confirmation `hideIfQualifies`
 * gives the report path (#43 round 2 F1), so a delayed or retried trigger can
 * never act on a stale event snapshot:
 *
 *   - an admin who Restored (`'active'`) or Hid the Proof by hand since the
 *     trigger fired → no-op, so the admin's decision is not silently reverted;
 *   - a Proof DELETED since the snapshot → no-op via `tx.update` on a missing
 *     doc, never a re-creating `set`;
 *   - a `visionFlag` no longer in the allowlist → no-op.
 *
 * It writes `status` and NOTHING else. Leaving `visionFlag` intact is the point
 * of the whole ticket: the resulting doc is `hidden` WITH its reason attached,
 * which is what lets the console tell a Vision hide from a report-count one and
 * what `notify.ts` `deriveReason` already labels with the flag rather than
 * `(reports >= threshold)`.
 *
 * `db` is a parameter so the read-then-conditional-write is unit-testable with a
 * fake transaction. Returns whether it wrote.
 */
export async function hideVisionFlaggedIfQualifies(
  db: AdminFirestore,
  eventId: string,
  proofId: string,
): Promise<boolean> {
  const docRef = db.doc(`events/${eventId}/proofs/${proofId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return false; // deleted since the snapshot — never re-create
    if (!qualifiesForVisionHide(snap.data() as VisionFlaggedDoc | undefined)) return false;
    tx.update(docRef, { status: 'hidden' });
    return true;
  });
}

async function defaultHideVisionFlaggedIfQualifies(eventId: string, proofId: string): Promise<boolean> {
  return hideVisionFlaggedIfQualifies(await adminFirestore(), eventId, proofId);
}

export interface VisionHideDeps {
  /** Transactionally hide the Proof iff its live state still qualifies; defaults to `hideVisionFlaggedIfQualifies`. */
  hideIfQualifies?: (eventId: string, proofId: string) => Promise<boolean>;
}

/**
 * Best-effort: decide on the event snapshot, then hand off to the TRANSACTIONAL
 * `hideVisionFlaggedIfQualifies`, which re-confirms live state before writing.
 * Never throws — a write failure is swallowed so the trigger never crashes the
 * proof pipeline (ADR 0001; mirrors `applyThresholdHide`, `moderateProof`, and
 * the #101 notifier). Returns whether it hid the Proof.
 *
 * The snapshot predicate runs BEFORE any Firestore access, so the overwhelmingly
 * common write (any Proof that is not `'flagged'` with an extreme flag — every
 * create, every report bump, every admin action, and our own hide write) costs
 * one predicate and no read. Nothing here reads the Event doc at all: unlike the
 * report threshold, the Vision verdict is already on the Proof.
 */
export async function applyVisionFlagHide(
  eventId: string,
  proofId: string,
  after: VisionFlaggedDoc | undefined,
  deps: VisionHideDeps = {},
): Promise<boolean> {
  try {
    if (!qualifiesForVisionHide(after)) return false;
    return await (deps.hideIfQualifies ?? defaultHideVisionFlaggedIfQualifies)(eventId, proofId);
  } catch (err) {
    console.error('applyVisionFlagHide failed', err);
    return false;
  }
}
