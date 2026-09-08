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
 *     and reads no threshold at all. It additionally BACKFILLS its own marker
 *     onto an extreme/illegal Proof that reached `'hidden'` without one (see
 *     `visionHideAction`), because the marker — not the status — is what holds
 *     the media through a claim confirm, and an admin who hides a flagged row
 *     before the trigger reaches it must not thereby demote a safety hide to a
 *     plain one.
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
 *     the re-fired `onDocumentWritten` no-ops. No infinite loop.
 *   - Admin Restore is preserved. `restoreProof` (src/data/admin.ts) clears the
 *     `safetyHide` marker and leaves `visionFlag` in place as the audit record of
 *     what the admin overrode. That doc is no longer `'flagged'`, so this path
 *     never re-hides it and the restore sticks — the same shape as the report
 *     path's restore, which survives because it leaves `reportCount` un-raised. A
 *     restored Proof is re-hidden only by a fresh scan (a re-upload re-flags it)
 *     or by an admin.
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
 *
 * Absent-or-non-boolean, never `false`, is the whole precision of the backfill
 * test. `false` is the warned console Restore's explicit override (`restoreProof`
 * writes it beside the status), and re-stamping `true` over it would let the
 * server silently overrule the one decision ADR 0004 reserves for a human. A
 * Proof an admin Restored and then hand-Hid keeps that `false` and stays a plain
 * hide — liftable by Restore, publishable by a confirm — because the admin has
 * already seen the verdict and overridden it.
 */
export type VisionHideAction = 'hide' | 'backfill';

export function visionHideAction(doc: VisionFlaggedDoc | undefined): VisionHideAction | null {
  if (!doc) return null; // delete — nothing to write
  if (qualifiesForVisionHide(doc)) return 'hide';
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
  const docRef = db.doc(`events/${eventId}/proofs/${proofId}`);
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

export interface VisionHideDeps {
  /** Transactionally apply the arm the Proof's LIVE state asks for, if any; defaults to `hideVisionFlaggedIfQualifies`. */
  hideIfQualifies?: (eventId: string, proofId: string) => Promise<boolean>;
}

/**
 * Best-effort: decide on the event snapshot, then hand off to the TRANSACTIONAL
 * `hideVisionFlaggedIfQualifies`, which re-confirms live state before writing.
 * Never throws — a write failure is swallowed so the trigger never crashes the
 * proof pipeline (ADR 0001; mirrors `applyThresholdHide`, `moderateProof`, and
 * the #101 notifier). Returns whether it wrote.
 *
 * The snapshot predicate runs BEFORE any Firestore access, so the overwhelmingly
 * common write (every create, every report bump, every admin action on an
 * unscreened Proof, and our own writes, which all leave a doc no arm claims)
 * costs one predicate and no read. Nothing here reads the Event doc at all:
 * unlike the report threshold, the Vision verdict is already on the Proof.
 */
export async function applyVisionFlagHide(
  eventId: string,
  proofId: string,
  after: VisionFlaggedDoc | undefined,
  deps: VisionHideDeps = {},
): Promise<boolean> {
  try {
    if (!visionHideAction(after)) return false;
    return await (deps.hideIfQualifies ?? defaultHideVisionFlaggedIfQualifies)(eventId, proofId);
  } catch (err) {
    console.error('applyVisionFlagHide failed', err);
    return false;
  }
}
