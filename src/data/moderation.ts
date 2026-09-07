// ADR 0004 Phase 0 community auto-hide — the ONE pure predicate shared by every
// surface that must agree on "is this content community-hidden". It lives in this
// Firestore-free, React-free module so BOTH the read hooks (src/hooks/useData.ts,
// which re-exports it) and the deal path (src/data/api.ts's joinAndDeal, which
// must NOT import React) apply the identical test — a new Player's frozen card can
// no longer be dealt a Prompt the live pool hides (Codex P2, PR #107 finding 1).

/**
 * True iff `reportCount` has REACHED a POSITIVE `reportHideThreshold` — at OR
 * over, not just over. The threshold is only active when it is a number strictly
 * greater than zero:
 *
 * - `undefined` (the event doc still loading, or the setting unset) → NO filtering.
 * - `0`, a negative number, or `NaN` → NO filtering. A non-positive threshold would
 *   make `reportCount >= threshold` true for ALL content and blank every Player's
 *   Feed/pool from one admin typo (Codex P2, PR #107 finding 2); requiring
 *   `threshold > 0` closes that, and the same guard rejects `NaN` (`NaN > 0` is
 *   false) even though `typeof NaN === 'number'`.
 * - any non-number → NO filtering.
 *
 * The filter fails OPEN unless the threshold is positive, because wrongly blanking
 * the whole app for everyone is worse than briefly showing a heavily-reported item,
 * and the Admin report queue is the backstop either way. Pure so the at/over/below
 * boundary AND the non-positive boundary are unit-testable without a subscription.
 */
export function isReportHidden(reportCount: number, threshold: number | undefined): boolean {
  return typeof threshold === 'number' && threshold > 0 && reportCount >= threshold;
}

/**
 * True iff `uid` is on the event's `bannedUids` roster — the ADR 0004 Phase 0
 * presentational, event-scoped hide/mute (#108, consuming the #113 rules + type
 * contract). Like `isReportHidden` it lives in this Firestore-free, React-free
 * module so BOTH the public read hooks (src/hooks/useData.ts, which re-exports it)
 * AND the deal path (src/data/api.ts's joinAndDeal, which must not import React)
 * apply the identical test — a banned Player's content is filtered by its OWNER
 * uid off every PUBLIC/player surface with no Admin awake.
 *
 * It fails OPEN exactly like the auto-hide: an empty, missing, or malformed
 * `bannedUids` (the event doc still loading, a fresh event whose converter default
 * is `[]`, or an unexpected non-array) filters NOTHING. A ban is presentational
 * and bypassable by design (ADR 0004 Phase 0) — NOT hard access revocation, which
 * is #43/#44; and NOT anti-cheat (ADR 0001), it is a moderation/dispute tool.
 *
 * Deliberately NOT applied to the raw Leaderboard roster that feeds Board's
 * First-to-BINGO determination (a ban never rewrites who was first to BINGO — that
 * already happened) nor to a viewer's OWN content in their own view; see the
 * per-hook comments in src/hooks/useData.ts and specs/w2-ban-console.md.
 */
export function isBanned(
  uid: string | null | undefined,
  bannedUids: readonly string[] | undefined,
): boolean {
  return !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid);
}

/**
 * The SYSTEM/SENTINEL content-author ids that are NOT real player uids and so must
 * never be bannable (Codex P1, PR #122): banning one would hide EVERY doc it
 * authored at once. The only one today is `'seed'` — `scripts/seed.mjs` sets
 * `createdBy: 'seed'` on every seeded default Prompt (a content-hash-keyed upsert,
 * not a per-player write), so a single `banUser('seed')` would drop the whole
 * default pool from BOTH the live pool (`useItems`) and the deal path
 * (`joinAndDeal`), leaving new Players with a thin/empty board. Extend this set if
 * any other non-uid system author is ever introduced. (Proof/marker/moment/doubt
 * authors are always real player uids; `'Anonymous'` is a displayName fallback,
 * never a `uid`/`createdBy`, so it is not a poisoning vector.)
 */
export const SYSTEM_AUTHOR_UIDS: readonly string[] = ['seed'];

/**
 * True when `uid` is a system/sentinel content author (see `SYSTEM_AUTHOR_UIDS`),
 * NOT a real player. The Admin console hides the Ban control for such authors and
 * `banUser` refuses to add one to `bannedUids`, so the default pool can never be
 * nuked by a mis-click. Unbanning is deliberately NOT gated by this — see
 * `unbanUser` — so an admin who banned a sentinel on a pre-fix build can recover.
 */
export function isSystemAuthor(uid: string | null | undefined): boolean {
  return !!uid && SYSTEM_AUTHOR_UIDS.includes(uid);
}

/**
 * Should this Prompt be withheld because the session is not gated for it?
 *
 * THE PUBLISH RACE (Phase 4b round 4). An admin approving the first explicit
 * Prompt performs ONE write — `status: 'active'` — and the 18+ posture is
 * published by a Cloud Function reacting to it. Those are two writes with a
 * function invocation between them, so for a moment the Prompt is live and the
 * posture is not: every Player's `status == 'active'` listener delivers the
 * explicit text while `hostnames/{host}.adultContent` still says `false`. No
 * amount of listener promptness closes that — it is an ordering problem, not a
 * latency one, and the client cannot make the two writes atomic because no
 * client may write `hostnames` at all.
 *
 * So the invariant is enforced where it actually has to hold: an explicit Prompt
 * is not RENDERED or DEALT into a session that has not raised the gate. The
 * window then resolves itself — the stamp lands, the posture raises, the gate
 * goes up, and the Prompt becomes visible in the same motion.
 *
 * This is the same layer the 18+ acknowledgement itself lives at. The gate is an
 * honor-system self-statement, not access control (ADR 0001), and the rules
 * deliberately do not hide `spicy` Prompts from signed-in readers — so a
 * client-side withhold is the right and only mechanism, exactly like the ADR
 * 0004 Phase 0 community auto-hide next door.
 *
 * Costs nothing in the steady state: on a gated Event `adultRequired` is `true`
 * and this is always false, and on a genuinely tame Event there are no spicy
 * Prompts to withhold.
 */
export function isExplicitWithheld(spicy: boolean | undefined, adultRequired: boolean): boolean {
  return spicy === true && !adultRequired;
}

/**
 * The `visionFlag` verdicts that carry a server-authoritative safety hide — the
 * CLIENT MIRROR of `AUTO_HIDE_VISION_FLAGS` in `functions/src/visionHide.ts`
 * (#133). Restated rather than imported because the app and the Functions package
 * are deliberately decoupled (the same posture `autohide.ts` takes toward this
 * module), and pinned against the functions original by the client/functions
 * parity block in `tests/functions/cloud-vision-moderation.test.ts`, which is
 * intended to FAIL if either side changes alone.
 *
 * An ALLOWLIST, not a denylist, for the same ADR 0004 reason the producer gives:
 * the app is intentionally racy, so an unrecognized verdict must fail closed to
 * "not a safety hide" rather than silently acquiring one.
 */
export const AUTO_HIDE_VISION_FLAGS: readonly string[] = ['violence', 'extreme'];

/** Is this `visionFlag` one of the extreme/illegal verdicts that auto-hides? */
export function isAutoHideVisionFlag(flag: unknown): boolean {
  return typeof flag === 'string' && AUTO_HIDE_VISION_FLAGS.includes(flag);
}

/**
 * Does a server-authoritative Vision safety hide currently STAND on this Proof?
 * True iff it is `'hidden'` or `'flagged'` AND carries an extreme/illegal
 * `visionFlag` — the two states `hideProofOnVisionFlag` owns: `'flagged'` is the
 * Proof the trigger is about to hide (or failed to hide, and will retry on the
 * next write), `'hidden'` is the one it already hid.
 *
 * The one client caller is `confirmClaim` (./admin), which publishes an
 * admin_confirmed claim's `'pending'` Proof by writing `status: 'active'`. Active
 * Proofs sit OUTSIDE `qualifiesForVisionHide`, so without this gate confirming
 * the Mark would put extreme/illegal media back in front of every Player and the
 * trigger would never hide it again — from a control whose row shows only the
 * submitter and the Prompt, and which is emphatically NOT the warned, explicit
 * moderation Restore. The claim still resolves and the Mark is still confirmed;
 * only the media stays hidden, and the queue row says so.
 *
 * Deliberately keyed on the Vision verdict alone rather than on "is this Proof
 * hidden at all": lifting an admin's manual hide or a report-count auto-hide is
 * confirm's pre-existing behaviour and has its own console affordances (`Restore`,
 * `Clear reports`). This closes the SAFETY hole ADR 0004 exists for.
 */
export function visionHideStands(
  status: string | undefined,
  visionFlag: string | null | undefined,
): boolean {
  return (status === 'hidden' || status === 'flagged') && isAutoHideVisionFlag(visionFlag);
}
