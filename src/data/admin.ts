import { addDoc, collection, doc, getDoc, getDocFromServer, getDocs, getDocsFromServer, limit, query, where, updateDoc, deleteDoc, deleteField, runTransaction, arrayUnion, arrayRemove } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions, EVENT_ID } from '../firebase';
import { completedLines, countMarked, isBlackout, foldDayStat, foldEchoStats, applyEchoes, tutorialDayIndexSet, ceremonialDayIndexSet, standingsFrozen, type DayStats, type EchoBucket, type StatWrite } from '../game/logic';
import { cellsPatch, changedCells, cellsFromData } from '../game/cells';
import { cellsMergeSet } from './cellsMerge';
import { stampEchoAnalyticsTransitions } from './echoAnalytics';
import { directMarkAnalyticsRequest } from './markAnalytics';
import { honorDisplayName, markerDisplayName } from './attribution';
import { claimsAwaitingAdmin, isSystemAuthor, safetyHideStands, type SafetyHideState } from './moderation';
import {
  archiveSnapshotFingerprint,
  draftEventArchive,
  finaleHasRun,
} from './eventArchive';
import { migrateClaimMode, migrateDayFields } from './converters';
import { dayMetaRef, playersCol } from './paths';
import { routeApprovalToDay, defaultTargetDayIndex, isUsableTarget } from './communityPrompts';
import { normalizePool } from '../game/pool';
import type { Cell, ClaimMode, ThemeId, ClaimDoc, DayMetaDoc, EventDoc, ItemDoc, DayDef, PlayerDoc, ProofDoc } from '../types';

const evt = (eventId = EVENT_ID) => doc(db, 'events', eventId);
const item = (id: string, eventId = EVENT_ID) => doc(db, 'events', eventId, 'items', id);
const itemsRaw = () => collection(db, 'events', EVENT_ID, 'items');
const proof = (id: string, eventId = EVENT_ID) => doc(db, 'events', eventId, 'proofs', id);
const claim = (id: string, eventId = EVENT_ID) => doc(db, 'events', eventId, 'claims', id);
const claimsRaw = (eventId = EVENT_ID) => collection(db, 'events', eventId, 'claims');
const board = (uid: string, eventId = EVENT_ID) => doc(db, 'events', eventId, 'boards', uid);
// The day-scoped board a daily-mode claim resolves against (#246).
const dayBoard = (dayIndex: number, uid: string, eventId = EVENT_ID) =>
  doc(db, 'events', eventId, 'days', String(dayIndex), 'boards', uid);
const dayMeta = (dayIndex: number, eventId = EVENT_ID) =>
  doc(db, 'events', eventId, 'days', String(dayIndex), 'meta', String(dayIndex));
const player = (uid: string, eventId = EVENT_ID) =>
  doc(db, 'events', eventId, 'players', uid);
// A per-Prompt Tally marker (ADR 0002): the same path setMark/attachProof write.
const marker = (itemId: string, uid: string, eventId = EVENT_ID) =>
  doc(db, 'events', eventId, 'tally', itemId, 'markers', uid);

export const hideItem = (id: string) => updateDoc(item(id), { status: 'hidden' });
export const restoreItem = (id: string) => updateDoc(item(id), { status: 'active' });
export const deleteItem = (id: string) => deleteDoc(item(id));

// Phase 1.5 approval flow (#210, daily-cards-spec § "Item pools and the approval
// flow"): the Admin Approvals-queue write path. A main-pool submission lands
// `pending` (src/data/api.ts addItem); only an admin's decision here can move it
// out of that state. `approveItem` stamps `approvedBy`/`approvedAt` alongside the
// `active` transition so the item is both playable AND carries who/when approved
// it for audit — matching the ItemDoc contract (#200) this ticket is the first
// consumer of. `rejectItem` moves the row to `rejected` and otherwise LEAVES it in
// place (never deletes): rejected rows are "kept for audit, hidden from all
// non-admins" (daily-cards-spec), so the Admin console remains the only surface
// that can still see WHY a Prompt was turned down. Both writes are admin-only;
// approval additionally satisfies the rules' resulting pool/spicy invariant,
// while rejection changes neither field and retains the existing admin update arm.
/**
 * Where one approval landed (#557), in two independent parts: `dayIndex` /
 * `retained` say where the Prompt now STANDS, and `outcome` says what this call
 * DID to get it there.
 *
 * What THIS call did to the Prompt — kept separate from what state the Prompt is
 * in, because a caller that conflates them announces a placement for something
 * it never approved (Phase 4b P2, PR #812).
 *
 *   - `placed`      — approved onto `dayIndex`.
 *   - `untargeted`  — approved with no Day, which is only reachable on an Event
 *                     that has no schedule at all; it means every Day, and on a
 *                     Day-less Event that is the single board.
 *   - `retained`    — approved, but no Day can deal it, so it is dealt nowhere.
 *   - `stale`       — NOT approved: the row was no longer `pending`. `dayIndex`
 *                     and `retained` then describe where it already stands.
 *   - `missing`     — NOT approved: no such item.
 */
export type ApprovalOutcome = 'placed' | 'untargeted' | 'retained' | 'stale' | 'missing';

export interface ApprovalPlacement {
  itemId: string;
  /** The Day this Prompt is scheduled for, or `null` for none. */
  dayIndex: number | null;
  /** Whether the Prompt is in the retained state — dealt nowhere. */
  retained: boolean;
  /** What this call DID. Only `placed`/`untargeted`/`retained` wrote anything. */
  outcome: ApprovalOutcome;
}

/**
 * The queue row an approval is asked about. Shaped like the Approvals-queue row
 * so a caller can pass what it already holds. `id` is the only routing input:
 * `targetDayIndex` here is a hint, and routing deliberately ignores it in favour
 * of the value read inside the transaction. `pool` and `spicy` are different:
 * they carry the Admin's explicit #558 classification decision made at approval
 * time. They are validated and written only after the authoritative document
 * proves the row is still pending, so a stale client can neither reroute nor
 * reclassify an already-approved Prompt.
 */
export type ApprovableItem = Pick<ItemDoc, 'id'> &
  Partial<Pick<ItemDoc, 'targetDayIndex' | 'pool' | 'spicy'>>;

function approvalDifficulty(callerPool: unknown, storedPool: unknown): 'main' | 'easy' {
  // A caller-provided value is an explicit Admin decision, so fail closed on an
  // unknown/closing value rather than letting normalizePool's legacy-main fallback
  // silently turn a bad control value into Exploratory. A missing caller choice is
  // the backwards-compatible seam and inherits the authoritative row's normalized
  // pool (old submissions and malformed/missing legacy values normalize to main).
  if (
    callerPool !== undefined &&
    callerPool !== 'main' &&
    callerPool !== 'easy' &&
    callerPool !== 'embark'
  ) {
    throw new Error('Community Prompt approval requires an easy or exploratory classification.');
  }
  const normalized = normalizePool(callerPool ?? storedPool);
  if (normalized === 'closing') {
    throw new Error('Community Prompt approval requires an easy or exploratory classification.');
  }
  return normalized;
}

function approvalSpicy(
  callerSpicy: unknown,
  storedSpicy: unknown,
  difficulty: 'main' | 'easy',
): boolean {
  if (difficulty === 'easy') return false;
  if (callerSpicy !== undefined && typeof callerSpicy !== 'boolean') {
    throw new Error('Community Prompt approval requires a boolean spicy classification.');
  }
  // Old callers that predate #558 preserve the authoritative pending row. The
  // Review queue always supplies its exact current choice so a toggle followed
  // immediately by approval cannot lose a race to the approval transaction.
  return callerSpicy === undefined ? storedSpicy === true : callerSpicy;
}

/**
 * Approve one or more pending Prompts, routing each to its intended Day (#557,
 * specs/community-prompt-targeting.md).
 *
 * The routing rule, per Prompt: a Prompt targeted at a Day that can still take
 * it keeps that Day; one whose Day's cutoff has passed rolls FORWARD to the next
 * Day that can; one with nowhere left to go is retained — still `active`, still
 * in the pool for the recap or a reusable pack, but aimed at a Day that has been
 * and gone, so no snapshot will ever admit it. It is never deleted and never
 * re-aimed at a Day that has already dealt.
 *
 * WHY A TRANSACTION, when every write here is to an ITEM and none to a Day. The
 * Event doc is read inside it purely to make the schedule part of the read set.
 * The scheduler stamps snapshots by updating that same doc
 * (`stampDaySnapshot`), so if a Day freezes while this approval is in flight,
 * Firestore retries and the routing is recomputed against the schedule that
 * actually won. Without that, an approval could commit "scheduled for Day 4"
 * microseconds after Day 4 froze, and the Prompt would silently be retained
 * while the organiser was told it was placed. The transaction narrows that window
 * rather than mutating anything on the Day side — the already-frozen Day is left
 * strictly alone either way, which is the invariant that matters most here.
 *
 * What the two transactions do and do not guarantee, precisely, because the
 * boundary is easy to overstate in both directions (Phase 4b, PR #812). The
 * snapshot side is NOT the loose half: `stampDaySnapshot` reads its active-item
 * query THROUGH its own transaction, in the same read set as the `tx.update`
 * that stamps the Day, so the frozen ids and the committed pool always describe
 * one Firestore state. What neither transaction can promise is the phantom edge
 * — a row flipping pending→active is not a change to a document the scheduler's
 * `status == 'active'` query matched when it ran — so the residual risk is that
 * an approval landing in that instant is reported as placed on a Day whose
 * snapshot does not list it. That is a MISREPORT of which Day, and it is the
 * worst case: the Day itself is safe by construction, because the stamp is
 * written once, re-confirmed as absent inside the scheduler's transaction, and
 * never overwritten. Making even the misreport impossible means approving on the
 * server clock, which is #813, not a stronger client-side transaction.
 *
 * Bulk shares ONE transaction and one `approvedAt` instant (the pre-existing
 * `bulkApproveItems` contract: one click is one approval event). That also keeps
 * the whole batch on the same side of every Day's cutoff, so a bulk approve can
 * never split across a freeze.
 */
export async function approveItems(
  items: readonly ApprovableItem[],
  adminUid: string,
  eventId: string = EVENT_ID,
): Promise<ApprovalPlacement[]> {
  if (items.length === 0) return [];
  const eventRef = evt(eventId);
  const itemRefs = items.map((it) => item(it.id, eventId));
  return runTransaction(db, async (tx) => {
    // EVERY read first: Firestore requires a transaction's reads to precede its
    // writes, so the item reads cannot live inside the write loop below.
    const evSnap = await tx.get(eventRef);
    const rows: (ItemDoc | undefined)[] = [];
    for (const ref of itemRefs) {
      const snap = await tx.get(ref);
      rows.push(snap.exists() ? (snap.data() as ItemDoc) : undefined);
    }
    const days = evSnap.exists() ? ((evSnap.data().days as DayDef[] | undefined) ?? []) : [];
    const approvedAt = Date.now();
    const placements: ApprovalPlacement[] = [];
    for (const [i, it] of items.entries()) {
      const ref = itemRefs[i];
      const row = rows[i];
      // STALE APPROVAL GUARD. The queue row is a client snapshot, and two
      // organisers can hold the same one: the first approval routes the Prompt
      // to Day 2, Day 2 freezes with its id, and a second approval of that same
      // stale row would find Day 2 closed, roll FORWARD, and rewrite the Prompt
      // for Day 3 — which then freezes with it too. The Prompt would be dealt on
      // two Days, which is the one outcome this whole ticket exists to prevent,
      // and no Day is ever mutated on the way there, so nothing downstream would
      // catch it (Phase 4b P1, PR #812).
      //
      // The fix is to make approval read AUTHORITATIVE state rather than trust
      // the caller: only a row that is still `pending` is approved, and the
      // routing below reads the STORED target, not the one the client passed.
      // A row that has moved on is a no-op reported where it actually stands, so
      // a double-click or a stale queue is harmless rather than corrupting. A
      // row that has vanished is likewise reported, not invented.
      if (row === undefined) {
        placements.push({ itemId: it.id, dayIndex: null, retained: false, outcome: 'missing' });
        continue;
      }
      if (row.status !== 'pending') {
        // Report where it ALREADY stands, and say plainly that this call did not
        // approve it. `outcome` is what happened; `dayIndex`/`retained` are the
        // row's state. Keeping them separate is what stops a consumer announcing
        // "scheduled for Day 3" for a row that was actually REJECTED, or for one
        // that no longer exists (Phase 4b P2, PR #812). Only a live `active` row
        // can be described as scheduled at all.
        const stored = row.targetDayIndex;
        const isRetained = row.retainedAt != null;
        const live = row.status === 'active';
        placements.push({
          itemId: it.id,
          dayIndex: live && !isRetained && isUsableTarget(stored) ? stored : null,
          retained: isRetained,
          outcome: 'stale',
        });
        continue;
      }
      // The STORED target is the one routing acts on. The caller's row is a hint
      // that may be stale; this is the value the rules and the snapshot will see.
      const targetDayIndex = row.targetDayIndex;
      const difficulty = approvalDifficulty(it.pool, row.pool);
      const spicy = approvalSpicy(it.spicy, row.spicy, difficulty);
      const base = {
        status: 'active' as const,
        approvedBy: adminUid,
        approvedAt,
        // Persist through the same transition seam used by curated admin writes:
        // app-facing `easy` remains `embark` until the post-Event vocabulary cutover.
        pool: persistedPool(difficulty),
        // Adult-content derivation and gating are main-pool only. An Easy
        // classification must therefore clear a submitted/ticked spicy flag in
        // this SAME guarded write (the same invariant adminAddItem enforces).
        // Exploratory writes its exact Admin-selected value too: otherwise a
        // concurrent queue toggle that loses to approval would retry, see an
        // active row, and correctly no-op while silently losing the choice.
        spicy,
      };
      // A placement CLEARS any `retainedAt` already on the row, rather than
      // merely not writing one. Since `tx.update` is a merge, a marker left
      // behind would describe an active Prompt that is being DEALT as one that
      // was retained and dealt nowhere — the mirror of the malformed-target
      // misreport, and just as misleading (Phase 4b P1, PR #812). `retained:
      // true` is the only state that stamps it, so `retained: false` must
      // unstamp it. The rules now refuse a submitter-supplied `retainedAt`, so
      // this is the second line rather than the only one.
      const placed = { ...base, retainedAt: deleteField() };
      if (targetDayIndex === undefined) {
        // A PENDING row with no target is a player submission that lost one —
        // never an organiser Prompt meant for every Day. Organiser and seed
        // Prompts are created `active` directly (the rules' admin-active-create
        // arm) and never enter this queue, so by construction everything here is
        // a suggestion aimed at one Day. Leaving the absence in place would let a
        // crafted or cached client submit without a target and be approved onto
        // EVERY Day — the feature's central failure mode, reachable around the
        // create rule, which cannot cheaply tell "no Day was available" from "the
        // client declined to say" (Phase 4b P1, PR #812). So approval resolves
        // the target it should have had.
        //
        // The exception is an Event with NO schedule at all, where untargeted is
        // the honest record rather than a gap: there are no Days, so "every Day"
        // is the single legacy board and narrowing it would mean nothing.
        if (days.length === 0) {
          tx.update(ref, placed);
          placements.push({ itemId: it.id, dayIndex: null, retained: false, outcome: 'untargeted' });
          continue;
        }
        const resolved = defaultTargetDayIndex(days, approvedAt);
        if (resolved == null) {
          // A schedule exists but nothing in it can still take a Prompt. Retained
          // is the honest outcome, and the same one a targeted Prompt with
          // nowhere left to go gets.
          tx.update(ref, { ...base, retainedAt: approvedAt });
          placements.push({ itemId: it.id, dayIndex: null, retained: true, outcome: 'retained' });
          continue;
        }
        tx.update(ref, { ...placed, targetDayIndex: resolved });
        placements.push({ itemId: it.id, dayIndex: resolved, retained: false, outcome: 'placed' });
        continue;
      }
      if (!isUsableTarget(targetDayIndex)) {
        // Present but MALFORMED. The snapshot already excludes such a row from
        // every Day (`targetsDay` fails closed), so it will be dealt nowhere —
        // which is retention, and must be REPORTED as retention. Reporting it as
        // ordinary untargeted content would tell the organiser it is live on
        // every Day while it is live on none (Phase 4b P2, PR #812). The
        // malformed value is left in place rather than repaired: this write is a
        // merge, and guessing which Day was meant would be inventing one.
        tx.update(ref, { ...base, retainedAt: approvedAt });
        placements.push({ itemId: it.id, dayIndex: null, retained: true, outcome: 'retained' });
        continue;
      }
      const routed = routeApprovalToDay(days, targetDayIndex, approvedAt);
      if (routed == null) {
        // Retained: the original target is LEFT in place. Clearing it would make
        // the Prompt untargeted, which reads as "every Day" — the one outcome
        // this ticket exists to prevent.
        tx.update(ref, { ...base, retainedAt: approvedAt });
        placements.push({ itemId: it.id, dayIndex: null, retained: true, outcome: 'retained' });
        continue;
      }
      tx.update(ref, { ...placed, targetDayIndex: routed });
      placements.push({ itemId: it.id, dayIndex: routed, retained: false, outcome: 'placed' });
    }
    return placements;
  });
}

/**
 * Approve one Prompt. Takes the queue ROW because that is what the Approvals
 * queue holds. Its `id` is the only routing input: since the stale guard reads
 * the item inside the transaction, the intended Day comes from the stored
 * document rather than from whatever the client was last shown. Its optional
 * `pool`/`spicy` are the explicit #558 approval-time classification decision,
 * validated and persisted only if that authoritative row is still pending.
 */
export const approveItem = (
  row: ApprovableItem,
  adminUid: string,
  eventId: string = EVENT_ID,
) => approveItems([row], adminUid, eventId).then((placements) => placements[0]);
export const rejectItem = (id: string, adminUid: string) =>
  updateDoc(item(id), { status: 'rejected', approvedBy: adminUid, approvedAt: Date.now() });

// Lets an admin correct a submitter's 🔞 tagging from the Approvals queue BEFORE
// approving it into the live pool. This must contend with approval, not race it:
// the former bare update could land after an Easy approval and recreate the
// invalid `embark + spicy:true` state that adult-content gating does not inspect.
// Firestore retries this transaction when approval wins; the authoritative row
// then reads active/easy and the stale toggle becomes a no-op.
//
// The returned revision is the committed transaction's acknowledgement fence.
// A query listener can echo this write before runTransaction's Promise settles,
// and another Admin can then correct it again before settlement. Comparing the
// listener's monotonic revision with this return value distinguishes that newer
// correction from a stale pre-commit snapshot without treating value equality
// as authorship. Legacy rows have no revision and therefore start at 0. `null`
// means the authoritative row was missing or no longer eligible, so no write
// occurred and the caller must drop any optimistic overlay.
export async function setItemSpicy(
  id: string,
  spicy: boolean,
  eventId: string = EVENT_ID,
): Promise<number | null> {
  // Firestore can invoke or retry the callback after the app has switched
  // Events. Resolve the acted document once, before entering that lifecycle.
  const ref = item(id, eventId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const row = snap.data() as Partial<ItemDoc>;
    if (row.status !== 'pending' || normalizePool(row.pool) !== 'main') return null;
    const previousRevision =
      typeof row.spicyRevision === 'number' &&
      Number.isSafeInteger(row.spicyRevision) &&
      row.spicyRevision >= 0
        ? row.spicyRevision
        : 0;
    if (previousRevision === Number.MAX_SAFE_INTEGER) {
      throw new Error('Prompt spicy revision exhausted');
    }
    const revision = previousRevision + 1;
    tx.update(ref, { spicy, spicyRevision: revision });
    return revision;
  });
}

/**
 * Bulk-approve every row in `items` (the Approvals queue's full pending list) —
 * "Bulk approve works on the full pending list in one action" (#210 AC). One
 * atomic write covering every row, so the queue clears in one go rather than
 * firing an update per row, and every row carries the SAME `approvedAt` instant:
 * a single bulk click is one approval EVENT even though it touches many rows,
 * mirroring how any other single admin action reads as one moment in the audit
 * trail rather than many micro-timestamps.
 *
 * Since #557 this is a thin alias for `approveItems`, so a bulk approve routes
 * each Prompt to its intended Day exactly as a single approve does. It moved
 * from `writeBatch` to that function's transaction to gain the schedule read set
 * — see `approveItems` for why routing has to be serialized against the
 * scheduler. The shared `approvedAt` survives the move.
 */
export function bulkApproveItems(
  items: readonly ApprovableItem[],
  adminUid: string,
  eventId: string = EVENT_ID,
): Promise<ApprovalPlacement[]> {
  return approveItems(items, adminUid, eventId);
}
/**
 * The console's Hide — and, when a safety hold is already standing on the Proof,
 * the write that PRESERVES it (Codex P1 on #1143).
 *
 * The queue offers Hide on a `'flagged'` row, because the row is visible the
 * moment `moderateProof` writes the verdict and `hideProofOnVisionFlag` is not
 * instantaneous (and, being best-effort, may have swallowed a failure it will
 * retry). An admin who clicks it there is agreeing with the AI screen, not
 * overriding it — but a bare `status: 'hidden'` moves the doc OUT of the state
 * the trigger's hide arm looks for while leaving no marker behind, and
 * `safetyHideStands` then reads the result as a PLAIN hide: a later Confirm on
 * the same Proof publishes the media the admin had just taken down.
 *
 * So the hide carries the hold forward. `safetyHideStands` (./moderation) is the
 * same predicate `confirmClaim` gates on, read here against the LIVE doc inside a
 * transaction because the row may have moved since it rendered — the trigger may
 * have hidden and marked it already, or an admin at another console may have
 * Restored it. When a hold stands, the marker rides the same update; when none
 * does, this is byte-for-byte the write it always was, so an ordinary moderation
 * hide is untouched and stays liftable by `Restore` and publishable by a confirm.
 *
 * It deliberately reads no verdict. The verdict strings live in the Functions
 * allowlist (`AUTO_HIDE_VISION_FLAGS`) and Functions and this bundle deploy
 * separately, so a client that re-derived them could only ever UNDER-stamp — and
 * the trigger's own backfill arm covers exactly that gap, stamping the marker on
 * any extreme/illegal Proof that reached `'hidden'` without one. The two halves
 * compose in the safe direction: the client can be stale, and the server is still
 * authoritative.
 */
export function hideProof(id: string, eventId: string = EVENT_ID): Promise<void> {
  return runTransaction(db, async (tx) => {
    const ref = proof(id, eventId);
    const snap = await tx.get(ref);
    const held = snap.exists() && safetyHideStands(snap.data() as SafetyHideState);
    // `tx.update` on a missing doc still rejects, exactly as the previous
    // `updateDoc` did — a Hide on a deleted Proof is an error, not a silent no-op.
    tx.update(ref, held ? { status: 'hidden', safetyHide: true } : { status: 'hidden' });
  });
}

/**
 * The console's Restore — the ONE place an admin may override an AI verdict, and
 * the only lift for a Vision safety hide (there is no counter to clear).
 *
 * It clears the server's `safetyHide` marker in the same write (#133, Codex P1
 * round 2). The marker, not the verdict string, is what `confirmClaim` reads, so
 * leaving it set would keep the Proof held after the admin had explicitly lifted
 * the hide. Writing `false` rather than deleting the key records the override as a
 * fact, the same reason `visionFlag` itself is left in place: the row keeps its
 * `AI screen: …` pill, and the queue keeps the Proof (`useReportedProofs` queues
 * on the verdict), so the decision stays visible and re-hideable instead of
 * vanishing. A fresh scan that re-flags the Proof takes it back to `'flagged'`,
 * which the trigger owns again — the override is a lift, not immunity.
 *
 * It restores to the state the Proof came FROM, not unconditionally to `'active'`
 * (#133, Codex P1 round 2). In admin_confirmed claim mode a Proof is created
 * `'pending'` and stays admin-only readable until the admin confirms its claim,
 * and Cloud Vision scans the uploaded object — so a photo whose claim is still
 * undecided can be flagged, hidden, and then Restored. Publishing it `'active'`
 * there would put it in every Player's Feed BEFORE the claim was judged, and
 * rejecting the claim afterwards leaves it public: `rejectClaim` deliberately
 * writes nothing to the Proof (it leaves a rejected Proof `'pending'` rather than
 * exposed), so nothing would ever take it back down. Restoring to `'pending'`
 * hands the Proof back to the claim queue instead, where Confirm publishes it and
 * Reject leaves it unpublished — the decision the console is actually asking for.
 *
 * Which claims reference the Proof is discovered OUTSIDE the transaction because
 * claims carry auto-ids and the web SDK's `Transaction.get` takes a
 * DocumentReference, never a query. The DECISION is still transactional: each
 * candidate is re-read live inside the transaction, so a claim resolved between
 * the query and the write is seen as resolved. Nothing can appear in the gap —
 * a Proof's claim is created in `attachProof`'s own transaction, alongside the
 * Proof itself, so an existing Proof never gains a new one.
 *
 * That lookup asks for the OWNER's claims, not the Proof's (Codex P2 round 2 on
 * #1143). Only the owner's claim may steer a restore, and the bound below is
 * applied to the query — so a `proofId`-only lookup lets any signed-in user
 * decide what the query returns: 25 forged pending claims naming someone else's
 * Proof fill the page, the owner's real claim falls off the end, and Restore
 * publishes a photo whose claim nobody has judged. The forged docs are excluded
 * where the exclusion cannot be crowded out — by the query itself — and the
 * in-transaction owner check below stays exactly as it was, because the query
 * reads a snapshot and only the live re-read can be trusted with the decision.
 *
 * Two equality filters need no composite index: Firestore serves an equality-only
 * conjunction by merging the single-field indexes it maintains by default, so
 * this adds nothing to `firestore.indexes.json`.
 */
/**
 * How many of the OWNER's claims the restore will consider. A Proof legitimately
 * backs exactly one (created in `attachProof`'s own transaction), so this is a
 * read-budget bound for the pathological case the query cannot exclude — a Player
 * minting many claims against their own Proof — rather than a defence against
 * forged ones, which the `uid` filter removes before the limit is reached.
 */
const RESTORE_CLAIM_LOOKUP_LIMIT = 25;

export async function restoreProof(id: string, eventId: string = EVENT_ID): Promise<void> {
  // The owner, read plainly and outside the transaction: `uid` is written once at
  // create and is immutable thereafter, so there is no state here a stale read
  // could get wrong. It only SCOPES the query; the authority for the decision is
  // the live re-read inside the transaction below.
  const ownerSnap = await getDoc(proof(id, eventId));
  const owner = ownerSnap.exists() ? (ownerSnap.data() as Partial<ProofDoc>).uid : undefined;
  const claimRefs =
    owner === undefined
      ? [] // no Proof, or no owner on it: nothing may steer the restore anyway
      : (
          await getDocs(
            query(
              claimsRaw(eventId),
              where('proofId', '==', id),
              where('uid', '==', owner),
              limit(RESTORE_CLAIM_LOOKUP_LIMIT),
            ),
          )
        ).docs.map((d) => claim(d.id, eventId));
  await runTransaction(db, async (tx) => {
    // The Proof first: a claim steers the restore only when it is the Proof
    // OWNER's claim. Any signed-in user can create a pending claim that names
    // someone else's Proof, and trusting it would let a stranger send another
    // Player's photo back to `pending` instead of to the Feed (Codex P2 on
    // #1143). The owner is read live, inside the transaction, like the claims.
    const proofSnap = await tx.get(proof(id, eventId));
    const owner = proofSnap.exists() ? (proofSnap.data() as Partial<ProofDoc>).uid : undefined;
    let claimUndecided = false;
    for (const ref of claimRefs) {
      const snap = await tx.get(ref);
      if (!snap.exists()) continue;
      const data = snap.data() as Partial<ClaimDoc>;
      if (data.status !== 'pending') continue;
      if (data.proofId !== id) continue;
      if (owner === undefined || data.uid !== owner) continue;
      claimUndecided = true;
    }
    tx.update(proof(id, eventId), {
      status: claimUndecided ? 'pending' : 'active',
      safetyHide: false,
    });
  });
}

// Lift the ADR 0004 Phase 0 community auto-hide by resetting reportCount to 0 —
// the explicit admin action the console lacked (Codex P2, PR #107 finding 3).
// Restoring `status` alone reactivates a hard-hidden row but leaves reportCount
// over the threshold, so it stays hidden on every Player's Feed/pool
// (useItems / useProofFeed via isReportHidden); an auto-hidden-but-active row has
// no `status` to restore at all. Clearing the counter is the one write that makes
// community-hidden content reappear in the player surfaces. An admin update is
// rules-unconstrained (firestore.rules `items`/`proofs`: `allow update: if
// isAdmin(eventId) || ...`), so writing reportCount is permitted — pinned by
// tests/rules/w2-admin-console.test.ts. This is the Phase 0 console affordance;
// the server-authoritative hide/lift is #43.
export const clearItemReports = (id: string) => updateDoc(item(id), { reportCount: 0 });
export const clearProofReports = (id: string) => updateDoc(proof(id), { reportCount: 0 });
export const setClaimMode = (mode: ClaimMode) => updateDoc(evt(), { claimMode: mode });
export const setEventTheme = (theme: ThemeId) => updateDoc(evt(), { defaultTheme: theme });

// The Admin "Proof & Claims" panel (#222): four single-field `settings.*`
// writes mirroring setClaimMode/setEventTheme. Each is a DOT-PATH `updateDoc`
// (`{ 'settings.photoProofSource': source }`), so it merges into the existing
// `settings` map and never clobbers a sibling key or any other event field —
// firestore.rules only requires the RESULTING `settings.reportHideThreshold`
// to stay a number, which a partial dot-path update preserves. `visionGate`
// is presentational-only for now: `functions/src/visionGate.ts` still gates
// `moderateProof` on its own deploy-time env flag, not this field.
export const setPhotoProofSource = (source: 'camera_or_library' | 'camera_only'): Promise<void> =>
  updateDoc(evt(), { 'settings.photoProofSource': source });
export const setStripPhotoExif = (on: boolean): Promise<void> =>
  updateDoc(evt(), { 'settings.stripPhotoExif': on });
export const setVisionGate = (on: boolean): Promise<void> =>
  updateDoc(evt(), { 'settings.visionGate': on });
export const setReportHideThreshold = (n: number): Promise<void> =>
  updateDoc(evt(), { 'settings.reportHideThreshold': n });

/**
 * The Admin override on the Event's 18+ posture (#608).
 *
 * An INPUT to the derivation, not the derived flag. `hostnames/{host}.adultContent`
 * is written only by `functions/src/adultContent.ts` — no client may write that
 * collection at all — and this is the field it ORs in:
 *
 *     adultContent = settings.forceAdult || (any active spicy Prompt in a dealable pool)
 *
 * It exists because `spicy` is narrower than it looks: it tracks SEXUAL
 * explicitness specifically, so an Event whose only mature content is violence,
 * drugs or self-harm would derive `false` and show no gate at all. Rather than
 * invent a content taxonomy, a human gets a lever.
 *
 * Turning it OFF does NOT un-gate the Event. The derived flag is monotone by
 * design, so clearing this removes the reason but not the posture — un-gating an
 * already-gated Event is an operator action, deliberately not a toggle. The
 * confirm on the way ON (`AdultContentConfirm`) says so.
 */
export const setForceAdult = (on: boolean): Promise<void> =>
  updateDoc(evt(), { 'settings.forceAdult': on });

// Easy mix (specs/easy-mix.md): the share of a main-day Board dealt from the embark
// pool, a live `settings.easyMixRatio` write mirroring the four above. A DOT-PATH
// merge so it never clobbers a sibling `settings` key. Difficulty becomes a dial, not
// a deploy — an admin changing it before a Day unlocks changes that Day's mix (the
// value is read at deal time off the frozen snapshot, which already carries both pools).
export const setEasyMixRatio = (ratio: number): Promise<void> =>
  updateDoc(evt(), { 'settings.easyMixRatio': ratio });

// The Admin Schedule editor (#221, daily-cards-spec § "Admin console" / §
// "Itinerary and schedule"): "changing a locked-future Day's theme is safe,
// changing an already-unlocked Day is disallowed." `days` is a Firestore ARRAY
// field, and the SDK cannot address one element by dot-path (`days.0.theme`
// would target a map key, not an array index) — so this is a targeted
// array-ELEMENT update expressed as a whole-ARRAY write: it reads the caller's
// already-subscribed `days` (the Admin console already holds it via
// `useEventDoc`), replaces only the one entry at `dayIndex` with its `theme`
// changed, and writes back `{ days }` alone. Every other event field
// (claimMode, defaultTheme, admins, settings, bannedUids) and every other
// Day's entry are untouched by this write — it never rewrites the whole
// EventDoc. The write-time lock itself lives in firestore.rules
// (`daysThemeLockOk`), which denies the write outright when the targeted
// Day's `unlockAt` has already passed; this function does not duplicate that
// check client-side (the UI's disabled dropdown is the courtesy, the rule is
// the guarantee) — it trusts the caller to have already excluded
// past/unlocked Days from the set of dayIndex values it invokes with.
// Re-read the freshest `days` INSIDE a transaction before writing the whole
// array back (Codex P2): the caller hands its already-subscribed snapshot, but a
// wholesale array write from a stale snapshot would clobber any concurrent change
// to a DIFFERENT Day that landed after that snapshot — another admin's theme edit
// on another row, or a future scheduler stamp (`snapshotItemIds`, #202) on an
// unlocked Day (which `dealDayCard` needs to leave the `waking` state). Merging
// the single `theme` swap onto the CURRENT array, not the caller's copy, keeps
// this edit surgical under concurrency. The `days` param is retained as the
// fallback when the doc is somehow missing.
export const setDayTheme = (days: DayDef[], dayIndex: number, theme: ThemeId): Promise<void> => {
  const eventId = EVENT_ID;
  const eventRef = evt(eventId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(eventRef);
    const current =
      (snap.exists() ? (snap.data().days as DayDef[] | undefined) : undefined) ?? days;
    tx.update(eventRef, {
      days: current.map((d) => (d.index === dayIndex ? { ...d, theme } : d)),
    });
  });
};

function normalizeTonightEntries(tonight: string[]): string[] {
  return tonight.map((entry) => entry.trim());
}

function isValidTonight(tonight: string[]): boolean {
  return tonight.length === 2 && tonight.every((entry) => entry.trim().length > 0);
}

/**
 * Edit a Day's "Tonight:" line (schedule correction 2026-07-17). Same surgical
 * merge-onto-current-array transaction as `setDayTheme` — for the same
 * concurrency reason (a wholesale write from a stale snapshot would clobber a
 * concurrent scheduler `snapshotItemIds` stamp or another admin's edit). Only
 * future Days may be edited here; the transaction re-checks the current
 * `unlockAt` so a stale Schedule tab cannot save after unlock. The
 * already-unlocked Days 1–3 are corrected by the one-time owner migration, not
 * this control.
 */
export const setDayTonight = (days: DayDef[], dayIndex: number, tonight: string[]): Promise<void> => {
  const eventId = EVENT_ID;
  const eventRef = evt(eventId);
  return runTransaction(db, async (tx) => {
    if (!isValidTonight(tonight)) {
      throw new Error('Tonight must contain exactly two non-empty entries.');
    }
    const snap = await tx.get(eventRef);
    const current = snap.exists() ? (snap.data().days as DayDef[] | undefined) : undefined;
    if (!Array.isArray(current)) {
      throw new Error('Cannot edit Tonight: event schedule is missing.');
    }
    const target = current.find((d) => d.index === dayIndex);
    if (!target) {
      throw new Error(`Cannot edit Tonight: Day ${dayIndex + 1} is missing.`);
    }
    if (target.unlockAt <= Date.now()) {
      throw new Error(`Cannot edit Tonight: Day ${dayIndex + 1} has already unlocked.`);
    }
    const nextTonight = normalizeTonightEntries(tonight);
    tx.update(eventRef, {
      days: current.map((d) => (d.index === dayIndex ? { ...d, tonight: nextTonight } : d)),
    });
  });
};

/** What `unlockDayNow` reports back — mirrors `SnapshotResult` in `functions/src/unlockDay.ts`. */
export type UnlockDayNowResult =
  | 'stamped'
  | 'already-stamped'
  | 'not-due'
  | 'no-event'
  | 'no-day'
  // The Event is closed to play — archived, or closing — and the server stood
  // down (specs/post-sailing-archive.md § "The server-side half"; Codex P2 on
  // PR #1161). `httpsCallable` trusts this generic, so the value has to be
  // here for an exhaustive handler or a mock to see it.
  | 'archived';

/** What the guarded re-snapshot reports back — mirrors `ResnapshotResult` in
 *  `functions/src/unlockDay.ts` (specs/easy-mix.md § "Deploy race"). */
export type ResnapshotDayResult =
  | 'resnapshotted'
  | 'has-boards'
  | 'not-recoverable'
  | 'not-due'
  | 'no-event'
  | 'no-day'
  // The Event is closed to play; the server stood down (Codex P2 on PR #1161).
  | 'archived';

/**
 * The Admin console's manual "unlock now" fallback (daily-cards-spec §
 * "Unlock mechanics": "a manual admin 'unlock now' button covers function
 * failure"). Invokes the EXISTING `unlockDayNow` callable
 * (`functions/src/index.ts`), which is admin-gated server-side
 * (`manualUnlockNow` denies a non-admin caller uid with `permission-denied`)
 * and forces the SAME idempotent `stampDaySnapshot` the scheduled unlock sweep
 * uses — so a forced unlock can never diverge from the scheduled path's
 * semantics, and a retry (or a race with the scheduler firing first) is a
 * safe no-op (`already-stamped`). Scoped to the single event this build
 * points at (`EVENT_ID`), matching every other write in this module — no
 * caller-supplied eventId, so this can't be pointed at a different event by
 * mistake. Follows the `submitBugReport` callable shape in `data/bugReports.ts`.
 */
export async function unlockDayNow(dayIndex: number): Promise<UnlockDayNowResult> {
  const callable = httpsCallable<{ eventId: string; dayIndex: number }, { result: UnlockDayNowResult }>(
    functions,
    'unlockDayNow',
  );
  const res = await callable({ eventId: EVENT_ID, dayIndex });
  return res.data.result;
}

/**
 * The easy-mix deploy-race fallback (specs/easy-mix.md § "Deploy race"): re-stamp one
 * Day's snapshot with the current active pool (main + embark for a main day) so the
 * easy mix takes effect on a Day whose snapshot was frozen by the pre-easy-mix build.
 * Routes to the SAME admin-gated `unlockDayNow` callable with `resnapshot: true`, which
 * OVERWRITES the snapshot but ONLY while zero Day Cards exist for the Day
 * (`resnapshotDayIfNoBoards` — the guard is server-side; a Day with any board dealt
 * gets `has-boards` and no change). Scoped to `EVENT_ID` like every write here.
 */
export async function resnapshotDayNow(dayIndex: number): Promise<ResnapshotDayResult> {
  const callable = httpsCallable<
    { eventId: string; dayIndex: number; resnapshot: true },
    { result: ResnapshotDayResult }
  >(functions, 'unlockDayNow');
  const res = await callable({ eventId: EVENT_ID, dayIndex, resnapshot: true });
  return res.data.result;
}

// The Admin ban (#108): add/remove a uid on the event doc's `bannedUids` roster —
// the ADR 0004 Phase 0 presentational, event-scoped hide/mute the #113 rules + type
// contract landed (EventDoc.bannedUids, the isAdmin-gated event-doc write path). A
// ban is a moderation/dispute tool, NOT anti-cheat (ADR 0001) and NOT hard access
// revocation (server-authoritative enforcement is #43/#44); the client consumers
// (isBanned filters in the read hooks + the deal path) hide a banned uid's content
// from every PUBLIC/player surface.
//
// arrayUnion/arrayRemove are DELIBERATE (not a whole-doc { bannedUids } write): a
// partial update touches ONLY the roster, so a ban never clobbers other event
// config (claimMode, defaultTheme, settings, admins). firestore.rules validates the
// RESULTING field state (a list, size <= 1000, disjoint from admins), so the
// partial-update shape is accepted — pinned by tests/rules/w2-banned-uids.test.ts.
// This writes ONLY events/{EVENT_ID}, never owner-only users/{uid}. EVENT_ID scopes
// the single-event app exactly like setClaimMode/setEventTheme above.
//
// SENTINEL GUARD (Codex P1, PR #122): banUser REFUSES to add a system/sentinel
// author (isSystemAuthor — today just 'seed', the createdBy on every seeded default
// Prompt). Banning 'seed' would hide the ENTIRE default pool from useItems AND the
// deal path at once — a single mis-click could leave new Players with an empty
// board. The guard is the write-side backstop to the UI's hidden-control, so even a
// programmatic/leaked call can never poison the pool: it no-ops (resolves) rather
// than throwing so any awaiting caller stays happy. unbanUser is DELIBERATELY NOT
// gated — it removes ANY uid including a sentinel, so an admin who banned 'seed' on
// a pre-fix build (or by any other means) can always recover the pool.
export const banUser = (uid: string): Promise<void> =>
  isSystemAuthor(uid) ? Promise.resolve() : updateDoc(evt(), { bannedUids: arrayUnion(uid) });
export const unbanUser = (uid: string) => updateDoc(evt(), { bannedUids: arrayRemove(uid) });

/** What the archive's FIRST write reports back — shutting the Event to gameplay
 *  so the freeze has something that has stopped moving to land on. */
export type BeginArchiveResult = 'closing' | 'already-archived' | 'no-event';

/**
 * `beginArchive`'s outcome, WITH the quiesce generation it left in force
 * (Codex P2, PR #1139) and WHETHER THIS CALL OPENED IT (#1142 item 6).
 *
 * The token is returned rather than kept private because the caller is the one
 * that has to clean up after a refused freeze, and a cleanup that cannot name
 * the closing state it is lifting can lift somebody else's.
 *
 * `created` is the other half of that same question, and the token alone cannot
 * answer it. `beginArchive` is idempotent: called on an Event ALREADY closing it
 * preserves the stored generation and still reports `'closing'`, so a caller
 * that joined another Admin's in-flight quiesce comes back holding a token that
 * matches perfectly — and an automatic reopen keyed on the token alone would
 * then succeed in clearing a closing state this call never took, which is
 * precisely what the binding exists to prevent one step later. Only the CREATOR
 * of a quiesce may reopen it automatically.
 *
 * Both are `null` / `false` on every outcome but `'closing'` — there is no
 * quiesce to name and none was opened.
 */
export type BeginArchiveOutcome = {
  result: BeginArchiveResult;
  token: number | null;
  created: boolean;
  /**
   * The Event this call acted on (#1142 item 7). `EVENT_ID` is a LIVE binding a
   * hostname change reassigns, and the archive is a SEQUENCE — shut, freeze, and
   * a cleanup after a refusal — with awaited round trips between each step. A
   * caller that re-read the binding per step could shut one Event, freeze
   * another's roster onto it and reopen a third; carrying the id the shut
   * actually took makes the whole sequence name one Event.
   *
   * Reported on every outcome, including the ones that wrote nothing: the id is
   * what the call LOOKED at, not what it changed.
   */
  eventId: string;
};

/** What abandoning a started-but-uncommitted archive reports back.
 *  `quiesce-changed` is the CONDITIONAL reopen declining: the stored closing
 *  state is not the one the caller asked to lift, so nothing was written
 *  (Codex P2, PR #1139). */
export type AbandonArchiveResult =
  | 'reopened'
  | 'already-archived'
  | 'no-event'
  | 'quiesce-changed';

/**
 * WHICH of the freeze's server reads failed (CodeRabbit Major, PR #1162).
 *
 * The four are named separately rather than folded into one "a read failed"
 * because they fail for different reasons and an Admin can act on the
 * difference: the Event and the roster are the reads a connection drop takes
 * out, the Claim queue is the one an Admin who has just lost their admin claim
 * gets `permission-denied` on, and a Day's honour pin is the one an Event with a
 * hand-edited schedule can point at a path that is not there. A single opaque
 * refusal would make the console say "something could not be read" about four
 * genuinely different situations.
 *
 * `'event'` covers BOTH Event reads — the pre-read and the transaction's own
 * re-read — because they are the same document read twice and the remedy is
 * identical.
 */
export type ArchiveReadStage = 'event' | 'claims' | 'roster' | 'day-meta';

/** The typed refusal a failed server read reports (CodeRabbit Major, PR #1162).
 *  Spelled as a FAMILY over the stages rather than as four unrelated members, so
 *  a stage added later cannot be forgotten: the console's `Record<ArchiveOutcome,
 *  …>` maps are exhaustive, and the new member fails the build until its phase
 *  and its copy are stated. */
export type ArchiveReadFailure = `read-failed:${ArchiveReadStage}`;

/** What `archiveEvent` reports back — the `unlockDayNow` result-union shape, so
 *  the Admin surface can say what happened instead of inferring it from a
 *  resolved promise.
 *
 *  `not-closing` means the quiesce was never taken (or was abandoned under this
 *  call), which the rules refuse to archive from; `quiesce-changed` means the
 *  closing state in force is not the one this call was bound to — play was
 *  reopened and shut AGAIN underneath it (Codex P1, PR #1139); `config-changed`
 *  means the Event configuration the record is defined by moved between the
 *  pre-read and the commit, so the reads and the record would describe different
 *  Events (Codex P2, PR #1139); `claims-pending` means a Claim was still
 *  awaiting an Admin when the Event shut, which the freeze would make
 *  unresolvable; `finale-pending` means the Event's scheduled Standings Freeze
 *  has not run, so the irreversible flip would forgo the finale beats forever
 *  (#1151, routed from #1150's review); `too-large` means the record built from
 *  the server re-read would not fit on the Event document; `record-unwritable`
 *  means that record is a shape `firestore.rules` would refuse, caught here
 *  rather than thrown at the boundary after the Event is already shut (#1151,
 *  Codex P1 on PR #1162); and `read-failed:<stage>` means one of the server
 *  reads the record is built from did not answer at all (CodeRabbit Major, PR
 *  #1162). All of them write NOTHING (#1151). */
export type ArchiveEventResult =
  | 'archived'
  | 'already-archived'
  | 'no-event'
  | 'not-closing'
  | 'quiesce-changed'
  | 'config-changed'
  | 'claims-pending'
  | 'finale-pending'
  | 'too-large'
  | 'record-unwritable'
  | ArchiveReadFailure;

/**
 * One of the freeze's server reads, turned from a REJECTION into an answer
 * (CodeRabbit Major, PR #1162).
 *
 * Every read below is taken after `beginArchive` has already shut the Event, so
 * a rejection thrown out of `archiveEvent` is not a failed call — it is a LIVE
 * Event left closed with no record and no refusal for the console to clean up
 * after. The console's automatic reopen runs off a returned refusal, so a throw
 * skipped it entirely and left the Admin with a generic failure pill beside an
 * Event nobody could play on.
 *
 * It wraps ONE read and nothing else. Nothing that WRITES ever goes through it,
 * because a failed commit is a failed archive and must keep surfacing as one —
 * which is also why the transaction's own re-read is handled differently, at the
 * call site rather than here.
 */
async function archiveRead<T>(
  read: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

/**
 * A usable quiesce generation — the shape `beginArchive` mints and the shape
 * `archiveEvent` will bind a flip to, mirroring `usableArchiveToken` in
 * `firestore.rules` exactly: a POSITIVE INTEGER. A missing, non-numeric,
 * fractional or non-positive value is not one this build can bind to, so it is
 * refused rather than treated as a wildcard: an unidentified closing state is
 * exactly the state the binding exists to distinguish from another.
 */
function usableArchiveToken(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * The NEXT generation for an Event whose stored one is `stored` — the counter
 * `beginArchive` installs when it shuts a live Event (Phase 4b P1 on PR #1157,
 * run 4).
 *
 * A COUNTER rather than a fresh opaque id, because the rules can only compare
 * against the ONE value the document still carries: "different from the stored
 * token" let generation 1 come back into force after 2 had superseded it (shut
 * 1, reopen, shut 2, reopen, shut 1 again — 1 != 2, so it passed), and an
 * `archiveEvent(1)` still in flight could then archive a closing state it was
 * never taken against. `firestore.rules` requires every shut to install a
 * number STRICTLY GREATER than the stored one, so a superseded generation is
 * dead permanently rather than for one step, and this is the client half of the
 * same arithmetic.
 *
 * It reads the stored value rather than trusting a type: a document written by
 * a build that predates the counter carries a STRING there, and a hand edit
 * could carry anything, so anything not already a usable counter restarts at 1
 * — which the repair arm accepts precisely because it exceeds the 0 the rules
 * read such a document as. A stored FRACTION is floored and stepped past, so
 * the number written still exceeds the number the rules will compare it with.
 */
function nextArchiveGeneration(stored: unknown): number {
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= 1
    ? Math.floor(stored) + 1
    : 1;
}

/**
 * THE QUIESCE (#134, specs/post-sailing-archive.md § "The quiesce protocol") —
 * the archive's first write, and the reason the freeze can be trusted.
 *
 * It sets `archiving: true` and the generation that identifies it, and nothing
 * else. `firestore.rules`' and `storage.rules`' `eventClosedToPlay` then treat
 * the Event exactly as if it were already archived for EVERY gameplay write, so
 * from the moment this commits the roster, the Day honours and the Claim queue
 * cannot move again.
 *
 * Why it has to exist: the flip itself is one document read and one document
 * write, and a Firestore transaction serializes only against the documents it
 * READS. A Player's Board write, a stat write, or a Claim create lands in
 * another collection entirely, so a Mark can commit alongside the freeze — and
 * on an Event the rules then make permanent, a Claim can go pending one instant
 * before the freeze that makes it unresolvable. No client-side latch can close
 * that: the UI's server-data latches say the server has spoken, never that it
 * has stopped speaking. Only a server-enforced closed state can (Codex P1, PR
 * #1139).
 *
 * IT ALSO IDENTIFIES THE QUIESCE (Codex P1, PR #1139). `archiving: true` says
 * the Event is shut; it cannot say WHICH shut, and the archive's second write
 * needs to know — it is decided against one closing state and commits against
 * whatever the transaction finds. An Event reopened and shut AGAIN underneath a
 * slow caller presents an identical flag, so `archiveToken` is minted here and
 * carried through the protocol as the thing that tells two generations apart.
 *
 * IDEMPOTENT and REVERSIBLE. Calling it on an Event that is already closing is
 * a no-op that still reports `'closing'` — and PRESERVES the stored token,
 * because nothing about that call reopened play, so re-minting would abort an
 * in-flight freeze that is still perfectly valid. A closing Event carrying no
 * usable token gets one, which is how a state shut by a pre-token build becomes
 * archivable again. `abandonArchive` is the way back out, because a freeze that
 * failed halfway must not shut an Event forever; the next `beginArchive` after
 * it opens a NEW generation, which is exactly what a caller bound to the old one
 * must not commit against.
 *
 * IT REPORTS THE TOKEN IT LEFT IN FORCE, AND WHETHER IT OPENED IT (Codex P2, PR
 * #1139; #1142 item 6). The caller that shut the Event is the caller that must
 * put it back if the freeze refuses, and an unconditional reopen there can clear
 * a LATER Admin's quiesce out from under their own in-flight freeze. Naming the
 * generation is what makes that cleanup conditional — see `abandonArchive` — and
 * `created` is what stops a caller that merely JOINED an in-flight quiesce from
 * reopening it: the token it holds matches, so the conditional reopen would
 * happily succeed at exactly the write the condition exists to refuse.
 */
export async function beginArchive(eventId: string = EVENT_ID): Promise<BeginArchiveOutcome> {
  const eventRef = evt(eventId);
  return runTransaction(db, async (tx): Promise<BeginArchiveOutcome> => {
    const snap = await tx.get(eventRef);
    if (!snap.exists()) return { result: 'no-event', token: null, created: false, eventId };
    const data = snap.data() as Partial<EventDoc>;
    if (data.status === 'archived') {
      return { result: 'already-archived', token: null, created: false, eventId };
    }
    // JOINED, not created: the Event was already closing under a generation
    // this build can bind to, so that generation stands and this call owns
    // nothing (#1142 item 6). The token is restated rather than left alone so
    // the write shape is the same from either state.
    const stored = data.archiveToken;
    if (data.archiving === true && usableArchiveToken(stored)) {
      tx.update(eventRef, { archiving: true, archiveToken: stored });
      return { result: 'closing', token: stored, created: false, eventId };
    }
    // A closing Event carrying no USABLE generation is not a join — there is no
    // quiesce this build could have bound to, and the rules refuse the flip
    // from an unidentified one — so minting here opens a new generation and
    // this call owns it.
    //
    // MINTED FROM THE STORED VALUE, INSIDE THIS TRANSACTION, because the
    // generation must strictly exceed the one on the document (Phase 4b P1 on
    // PR #1157, run 4). The transaction is what makes `stored + 1` safe against
    // two Admins closing at once: both read the same document, so the loser
    // re-runs against the winner's value instead of writing the same counter
    // twice. A random id needed no read and bought no freshness — the rules
    // could only tell it apart from the ONE token still stored.
    const token = nextArchiveGeneration(stored);
    tx.update(eventRef, { archiving: true, archiveToken: token });
    return { result: 'closing', token, created: true, eventId };
  });
}

/**
 * Reopen an Event whose archive was started and not committed — the escape
 * hatch that makes the quiesce safe to take at all.
 *
 * `archiving` is deliberately NOT write-once (unlike `status` / `archivedAt`):
 * the first write shuts gameplay for everyone, so a tab closed mid-flight, a
 * failed second write, or an Admin who simply changed their mind would otherwise
 * leave a live Event permanently unplayable with no client-side way back. Once
 * `status` is `'archived'` this reports `already-archived` and writes nothing —
 * the freeze is carried by `status` from there, and that IS write-once
 * (spec § Recovery).
 *
 * `archiveToken` is deliberately LEFT in place rather than cleared. It only
 * ever means anything while `archiving` is true, and the next `beginArchive`
 * mints a fresh one precisely because the Event is no longer closing when it
 * runs — so a freeze still in flight under the old generation sees a token that
 * has moved and aborts, which is the whole point.
 *
 * IT CAN BE MADE CONDITIONAL, and the automatic cleanup path always is (Codex
 * P2, PR #1139). Pass the `expectedToken` `beginArchive` reported and this
 * reopens ONLY the closing state that token names: a quiesce taken over by
 * another Admin in the meantime carries a different generation, and clearing it
 * would reopen an Event underneath somebody else's in-flight freeze — the same
 * hazard `archiveEvent`'s own `quiesce-changed` refusal exists for, one step
 * later in the same handler. It reports `quiesce-changed` and writes nothing.
 *
 * The token is NOT the whole condition, though, and the caller carries the rest:
 * a call that merely JOINED an in-flight quiesce holds a matching token, so the
 * automatic-reopen caller gates on `BeginArchiveOutcome.created` as well (#1142
 * item 6). That caller is the console's **Archive** handler, which ships with
 * the pending-claim drain gate in #1151 (Phase 4b P1, PR #1157) — this child's
 * console has no flip to fail, so the only reopen on screen is the
 * unconditional one below.
 *
 * Called with NO token it is unconditional, which is what the console's own
 * **Reopen play** button wants: that is a deliberate act on the Event as it
 * stands in front of the Admin, not an automatic cleanup of a call that has
 * already failed.
 *
 * A stale token cannot be laundered into a match. `abandonArchive` leaves the
 * generation in place, so a reopened-and-re-shut Event carries the FRESH one
 * `beginArchive` minted (it only preserves a token while the Event is still
 * closing), and the stale caller's comparison fails.
 */
export async function abandonArchive(
  expectedToken?: number,
  /** The Event to reopen — the one `beginArchive` reported, for the automatic
   *  cleanup path, so a hostname change between the shut and the cleanup cannot
   *  reopen a different Event (#1142 item 7). */
  eventId: string = EVENT_ID,
): Promise<AbandonArchiveResult> {
  const eventRef = evt(eventId);
  return runTransaction(db, async (tx): Promise<AbandonArchiveResult> => {
    const snap = await tx.get(eventRef);
    if (!snap.exists()) return 'no-event';
    const data = snap.data() as Partial<EventDoc>;
    if (data.status === 'archived') return 'already-archived';
    if (expectedToken !== undefined && data.archiveToken !== expectedToken) {
      return 'quiesce-changed';
    }
    tx.update(eventRef, { archiving: false });
    return 'reopened';
  });
}

/**
 * Freeze this Event after the occasion (#134, specs/post-sailing-archive.md):
 * the archive's SECOND write — ONE update that flips `status` to `'archived'`,
 * stamps `archivedAt`, and clears the `archiving` flag the first write set.
 *
 * ONE update on ONE document is the whole atomicity requirement here: the rules
 * deny gameplay writes on an archived Event and read the stamp beside the
 * status, so an observer must never see one half without the other.
 *
 * IT MUST FOLLOW `beginArchive`, and the rules enforce that too: `status` may
 * only become `'archived'` from a stored document already carrying
 * `archiving: true`. This call re-checks it inside the transaction, reporting
 * `not-closing` rather than freezing an Event whose gameplay was never shut.
 *
 * IT IS BOUND TO THE QUIESCE IT WAS HANDED (Codex P1, PR #1139). `archiving:
 * true` cannot say WHICH shut, and play can be reopened and shut AGAIN between
 * the caller taking its quiesce and this transaction committing — the document
 * then carries an `archiving: true` indistinguishable from the first. So the
 * caller passes the generation `beginArchive` left in force, the transaction
 * refuses with `quiesce-changed` when the stored one has moved, and the flip arm
 * in `firestore.rules` requires the write to restate the stored token besides —
 * so a direct SDK write carrying a superseded generation is denied at the
 * boundary too, not only by the client that happens to check.
 *
 * `quiesce-changed` deliberately leaves the Event SHUT: the closing state in
 * force belongs to whoever took it, and clearing it would reopen an Event
 * underneath their in-flight freeze.
 *
 * Archiving is ONE-WAY from the client. The transaction re-reads the Event
 * inside itself and reports `already-archived` rather than re-flipping, so a
 * double tap (or a second Admin's tap) can never restamp the freeze — and the
 * rules refuse the rewrite besides. Un-archiving is deliberately not a client
 * operation at all; see the spec's § Recovery.
 *
 * IT PERSISTS THE FROZEN RECORD IN THE SAME UPDATE (#1151). `archive` — the
 * final standings and the First-to-BINGO hall of fame — is written beside
 * `status`, `archivedAt` and `archivedUnder`, because the rules deny gameplay on
 * an archived Event and the archived surfaces render from `archive`: an observer
 * that could see `status: 'archived'` with no record, or a record with the Event
 * still live, would see either an empty archive or a writable one.
 * `specs/path-addressing-and-root.md` § D8 additionally requires the Event's
 * ROUTING documents to move in that same transaction; that half waits on path
 * addressing, which ships nothing today.
 *
 * THE INPUTS ARE RE-READ FROM THE SERVER, after the quiesce, and that is the
 * whole point of the ordering (#1151). A passive listener re-delivers only when
 * its documents CHANGE, so "wait until the roster subscription is
 * server-confirmed again" would deadlock in precisely the case the quiesce
 * creates — nothing moving. An explicit server read issued after the closing
 * write is acknowledged returns the state of a collection that can no longer
 * change: the strongest form of "confirmed after the close" available to a
 * client, rather than the weakest.
 *
 * That is a READ, not a recompute (ADR 0001). Every number still comes verbatim
 * off the Player-written `PlayerDoc`, through the same converters the live
 * Leaderboard reads; only the freshness differs. The Event document is re-read
 * RAW inside the transaction — the `setDayTheme`/`confirmClaim` discipline — so
 * the ban roster and schedule the record freezes against are the stored ones.
 *
 * EVERY READ NAMES THE EVENT EXPLICITLY (#1142 item 7). `EVENT_ID` is a LIVE
 * binding that a hostname change reassigns, and this call takes four awaited
 * reads before it writes — so a path helper resolving the binding after an
 * A-to-B change would have frozen B's roster and honours onto A, with the
 * generation and configuration checks validating only A. The Event is captured
 * once, up front, and threaded through every reference including the caller's
 * own begin/freeze/cleanup sequence.
 *
 * AND A READ THAT DOES NOT ANSWER IS A REFUSAL TOO (CodeRabbit Major, PR
 * #1162). Those four reads are taken after the Event is already shut, so a
 * rejection thrown out of here is not a failed call — it is a LIVE Event left
 * closed with no record. The console's cleanup keys on a RETURNED refusal, so a
 * throw skipped the automatic reopen and left an Admin looking at a generic
 * failure pill beside an Event nobody could play on. Each read now reports
 * `read-failed:<stage>` naming the read that did not answer, which the console
 * treats exactly as it treats the four refusals below. The transaction's own
 * Event re-read is covered the same way, but only AFTER `runTransaction` has
 * exhausted its own retries — the read is re-thrown so the SDK still gets to
 * retry a transient one, and the classification happens outside, where a
 * rejected transaction is known to have written nothing. A COMMIT failure is
 * deliberately NOT swallowed: a failed write is a failed archive and keeps
 * surfacing as one.
 *
 * FIVE THINGS ARE REFUSED AFTER THE CLOSE RATHER THAN WRITTEN THROUGH, and each
 * reports instead of throwing so the console can say what happened and, where
 * this call is what shut the Event, put play back (Codex P1+P2, PR #1139):
 *
 *  - `quiesce-changed` — play was reopened and shut AGAIN under this call, so
 *    the closing state the reads describe is not the one the write would land
 *    on. This is the ONE refusal that leaves the Event shut: that closing state
 *    belongs to whoever took it.
 *  - `config-changed` — the Event configuration the record is defined by
 *    (`claimMode`, `days`, the freeze boundary) moved between the pre-read and
 *    the commit, so the reads and the record would describe different Events.
 *  - `claims-pending` — a Claim was still awaiting an Admin when the Event shut.
 *    The freeze never reads that collection, so a Claim left pending there is
 *    not resolvable at all; the same server-read discipline the roster gets is
 *    applied to the queue.
 *  - `finale-pending` — the Event's scheduled Standings Freeze has not run. The
 *    quiesce only DELAYS the finale beats, but the flip is irreversible, so an
 *    Event archived first never receives them (#1151, routed from #1150's
 *    review). Overridable with `beforeFinale`, because an Admin may legitimately
 *    end an Event that will never reach its finale — but only by saying so.
 *  - `too-large` — the record built from the server re-read would not fit on the
 *    Event document. `draftEventArchive` decides that on coerced, bounded inputs
 *    and against the PROJECTED document — the stored fields this update retains
 *    plus the ones it writes — because the archive never lands on an empty one:
 *    an Event whose own `days` / `bannedUids` / `mostLovedPhoto` already fill the
 *    budget overflows on a perfectly ordinary record.
 */
export async function archiveEvent(
  token: number,
  params: {
    now?: number;
    /** The Event to freeze. Captured by the CALLER from `beginArchive`, so the
     *  quiesce, the freeze and the cleanup after a refusal all name one Event
     *  even if the hostname binding moves between them (#1142 item 7). */
    eventId?: string;
    /** The Admin has been told the finale has not run and asked for the archive
     *  anyway (#1151). Without it the freeze refuses with `finale-pending`. */
    beforeFinale?: boolean;
  } = {},
): Promise<ArchiveEventResult> {
  // THE EVENT THIS CALL IS ABOUT, resolved ONCE and used for every read and the
  // write (#1142 item 7). Everything below awaits, and `EVENT_ID` can move.
  const eventId = params.eventId ?? EVENT_ID;
  const eventRef = evt(eventId);
  // Refused before anything is read rather than compared inside the transaction:
  // a missing, non-integer or non-positive generation is not one this build can
  // bind to, so there is nothing for the stored value to agree WITH — and the
  // rules refuse the flip from an unidentified quiesce besides. `beginArchive`
  // mints one, so reopening and archiving again is the way through.
  if (!usableArchiveToken(token)) return 'quiesce-changed';
  // The pre-read is FROM THE SERVER: a cache-sourced Event could still report
  // the pre-quiesce state, and the Day count read off it decides which honour
  // pins are fetched below.
  //
  // A read that does not answer is REPORTED, not thrown (CodeRabbit Major, PR
  // #1162): the Event is already shut by the time this runs, and only a returned
  // refusal reaches the console's reopen. `getDocFromServer` has no cache to fall
  // back to by design, so an offline tab is exactly the case that lands here.
  const preRead = await archiveRead(() => getDocFromServer(eventRef));
  if (!preRead.ok) return 'read-failed:event';
  const pre = preRead.value;
  if (!pre.exists()) return 'no-event';
  const preData = pre.data() as Partial<EventDoc>;
  if (preData.status === 'archived') return 'already-archived';
  if (preData.archiving !== true) return 'not-closing';
  // The binding, checked BEFORE the reads as well as inside the transaction.
  // Every read below describes the Event as it stands under THIS closing state;
  // taking them against a generation that has already moved would spend four
  // round trips to build a record the commit must refuse anyway.
  if (preData.archiveToken !== token) return 'quiesce-changed';
  // …and the CONFIGURATION those reads are about to be taken under (Codex P2,
  // PR #1139). The quiesce shuts gameplay, not administration, so an Admin can
  // still change the Event between this read and the commit — and the drain gate
  // below is evaluated against THIS document while the record is built against
  // the transaction's. A `claimMode` flipped from `honor` afterwards turns a gate
  // that passed vacuously into a queue full of Claims the freeze has just made
  // unresolvable; an edited `days` leaves the record built from honour pins
  // fetched for a schedule that no longer exists. The transaction refuses rather
  // than combining the two.
  const configAtRead = archiveSnapshotFingerprint(preData);

  // THE DRAIN GATE, RE-TAKEN FROM THE SERVER AFTER THE CLOSE (Codex P2, PR
  // #1139). The console's own gate reads a passive listener, and a Claim can
  // commit between that listener's last render and the closing write — the exact
  // window the quiesce exists to have. Nothing downstream would notice: the
  // freeze never reads the Claim collection, so an `admin_confirmed` Claim left
  // pending here is pending FOREVER, behind a Confirm/Reject pair whose Board and
  // Player writes the freeze now denies.
  //
  // Re-read the same way the roster is, and for the same reason: this read is
  // issued after the closing write is acknowledged, so its result is the state of
  // a collection that can no longer change. Refused rather than fixed — resolving
  // a Claim from here would be the gameplay write the freeze just denied — and
  // the console reopens play when it was this call that shut the Event.
  //
  // The gate reads a NORMALIZED Claim Mode (Codex P2, PR #1139). This pre-read is
  // deliberately converter-free — the freeze reads the STORED document, the
  // `setDayTheme`/`confirmClaim` discipline — but `claimsQueueOpen` compares
  // against the CURRENT contract, and an Event seeded or written before the
  // rename persists `'verified'` for what is now `'admin_confirmed'`. The console
  // gates on the converted document (`eventConverter` runs `migrateClaimMode`),
  // so on such an Event the two halves of one gate read the same queue and
  // disagreed: the console counted the pending Claims and refused to arm, while
  // this take saw a mode that is not `admin_confirmed`, passed vacuously, and
  // would have frozen the Event over exactly the Claims the gate exists to drain.
  //
  // AND A QUEUE THAT WILL NOT ANSWER IS NOT A DRAINED QUEUE (CodeRabbit Major,
  // PR #1162). This is the read a caller who has just lost their admin claim
  // gets `permission-denied` on, and the gate reads `.docs` off the result — so
  // an unanswered read is refused by name rather than allowed to throw past the
  // console's cleanup.
  const preClaimMode = migrateClaimMode(preData.claimMode);
  const claimsRead = await archiveRead(() => getDocsFromServer(claimsRaw(eventId)));
  if (!claimsRead.ok) return 'read-failed:claims';
  if (
    claimsAwaitingAdmin(
      { claimMode: preClaimMode },
      claimsRead.value.docs.map((d) => d.data() as ClaimDoc),
    ).length > 0
  ) {
    return 'claims-pending';
  }

  // Everything the record freezes, read after the close. `playersCol()` /
  // `dayMetaRef()` are the same converter-attached references the live
  // subscriptions use, so the rows are the identical shape — this is the live
  // Leaderboard's own data, read once more at the one moment it is guaranteed to
  // have stopped moving. Both take the captured `eventId` (#1142 item 7).
  //
  // WRAPPED SEPARATELY, and still issued together (CodeRabbit Major, PR #1162).
  // Each half is guarded on its own so the refusal can name WHICH one did not
  // answer — a roster read that fails is a connection problem, a Day pin that
  // fails can be a schedule pointing at a path that is not there — and because
  // neither wrapper ever rejects, the `Promise.all` cannot either: the two reads
  // still overlap on the wire, and neither can leave the other's rejection
  // unhandled.
  const dayIndexes = (Array.isArray(preData.days) ? preData.days : []).map((d) => d.index);
  const [rosterRead, metaRead] = await Promise.all([
    archiveRead(() => getDocsFromServer(playersCol(eventId))),
    archiveRead(() =>
      Promise.all(dayIndexes.map((index) => getDocFromServer(dayMetaRef(index, eventId)))),
    ),
  ]);
  if (!rosterRead.ok) return 'read-failed:roster';
  if (!metaRead.ok) return 'read-failed:day-meta';
  const players = rosterRead.value.docs.map((d) => d.data());
  const dayMetas = new Map<number, DayMetaDoc>();
  metaRead.value.forEach((snap, i) => {
    if (snap.exists()) dayMetas.set(dayIndexes[i], snap.data());
  });

  // THE TRANSACTIONAL EVENT RE-READ, CLASSIFIED WITHOUT COSTING ITS RETRIES
  // (CodeRabbit Major, PR #1162). `runTransaction` rejects for two quite
  // different reasons — the read did not answer, or the WRITE did not land — and
  // only the first may become a refusal: swallowing a failed commit would report
  // "nothing was frozen" about an archive whose outcome this call does not know.
  // Catching inside the callback would also spend the SDK's own retry, which is
  // the thing that gets a transient read through. So the read is flagged and
  // RE-THROWN — the SDK retries exactly as it did before, the flag is reset at
  // the top of every attempt so only the LAST one counts — and the classification
  // happens out here, on a transaction that has already given up and is therefore
  // known to have written nothing.
  let lastTxFailureWasTheRead = false;
  return runTransaction(db, async (tx): Promise<ArchiveEventResult> => {
    lastTxFailureWasTheRead = false;
    // FLAGGED AND RE-THROWN, never swallowed here. The ORIGINAL error is what
    // leaves the callback, so the SDK still decides its own retry from it; the
    // flag only records that the last thing to fail in THIS attempt was the read,
    // and the write below is outside the only `catch` in this transaction.
    const snap = await tx.get(eventRef).catch((err: unknown) => {
      lastTxFailureWasTheRead = true;
      throw err;
    });
    if (!snap.exists()) return 'no-event';
    const data = snap.data() as Partial<EventDoc>;
    if (data.status === 'archived') return 'already-archived';
    // Re-checked HERE, inside the transaction that writes: an Admin (or another
    // console) can abandon the archive between the reads above and this commit,
    // and an Event whose gameplay reopened in that window is one whose roster may
    // have moved again. Refuse rather than freeze what may already be stale.
    if (data.archiving !== true) return 'not-closing';
    // …and the flag alone cannot see the ABA case (Codex P1, PR #1139). Play can
    // be REOPENED and SHUT AGAIN inside the window the reads above occupy:
    // gameplay resumes, Marks land, Claims are created, and a second quiesce
    // begins — and the document this transaction reads then carries an
    // `archiving: true` indistinguishable from the one the reads were taken
    // under. Committing here would freeze standings that predate the reopened
    // play, permanently, and the record is what the rules lock. Refused, never
    // repaired, and deliberately WITHOUT reopening play: the closing state in
    // force belongs to whoever took it.
    if (data.archiveToken !== token) return 'quiesce-changed';
    // The snapshot-defining configuration, held across the same window. Every
    // read above describes the Event under `configAtRead`; this record would be
    // built under whatever the transaction found. `bannedUids` is deliberately
    // outside the fingerprint — moderation stays open through the quiesce on
    // purpose, and a ban is applied to the rows the record keeps rather than
    // deciding which rows were read (see `archiveSnapshotFingerprint`).
    if (archiveSnapshotFingerprint(data) !== configAtRead) return 'config-changed';
    // THE FINALE GATE (#1151, routed here from #1150's review). The quiesce only
    // DELAYS the finale beats — the freeze stamp, the podium Moment and the
    // Most-Loved award are withheld while play is shut and land at the scheduled
    // cutoff once it reopens — but `status: 'archived'` is irreversible, so an
    // Event flipped before its Standings Freeze never receives them, and the
    // record it freezes is one the podium never got to settle. Checked against
    // the TRANSACTIONAL read, which is the state the flip actually lands on; a
    // finale committing between the pre-read and here moves `frozenAt` and is
    // caught by the fingerprint above first.
    if (!params.beforeFinale && !finaleHasRun(data)) return 'finale-pending';
    const archivedAt = params.now ?? Date.now();
    const draft = draftEventArchive({
      players,
      event: {
        // Frozen INTO the record, from the transactional read, so the archived
        // Share Card is titled by the Event as it stood at the freeze rather than
        // by a name an Admin can still edit afterwards (Codex P2, PR #1139).
        name: data.name,
        // NORMALIZED for the derivations, while the raw document above and below
        // stays raw (Codex P2, PR #1139). The frozen honour chip's label comes
        // from `dayHonorChipLabel`, which resolves the Day's theme emoji out of
        // `THEMES` — and every LIVE surface hands that helper Days that have
        // already been through `migrateDayFields` / `normalizeEventTheme`
        // (`eventConverter`), while this writer holds the stored document. The
        // two disagree on exactly the Days the freeze has to get right: an
        // unknown persisted theme renders the Edition's default emoji live and NO
        // emoji in the record, and an off-Edition theme renders the default live
        // while the record freezes that other Theme's emoji. Either way the
        // permanent label is not the one the last live strip showed, which is the
        // whole promise `dayLabel` was stored to keep. Normalizing here also puts
        // this writer's Tutorial-Day and freeze-boundary derivations on the same
        // footing as the console preview's, which reads the converted document.
        //
        // Deliberately NOT applied to `archiveSnapshotFingerprint` (which
        // compares two RAW reads against each other, so normalizing either side
        // could only invent or hide a change) or to `existing` below (which is
        // MEASURED, and what the write lands on is the stored document).
        days: Array.isArray(data.days) ? data.days.map(migrateDayFields) : [],
        bannedUids: Array.isArray(data.bannedUids) ? data.bannedUids : [],
        frozenAt: data.frozenAt,
        standingsFreezeAt: data.standingsFreezeAt,
      },
      dayMetas,
      // Every Day's pin was read from the server above, so an absent pin is the
      // server's answer rather than an unfilled cache — which is the one thing
      // `dayMetasLoaded` exists to tell apart.
      dayMetasLoaded: true,
      archivedAt,
      // The STORED document, so the size check measures what the write actually
      // produces rather than the record alone (Codex P2, PR #1139). `data` is the
      // raw transactional read — the same one this update is about to be applied
      // to — so `days`, `bannedUids` and `mostLovedPhoto` are counted at the
      // sizes they will really have.
      existing: data as Readonly<Record<string, unknown>>,
    });
    // The last line of the same defence the Admin console applies BEFORE the
    // quiesce (Codex P2, PR #1139). The console checks the record it previewed
    // from the live subscriptions; this checks the one actually built from the
    // server re-read, which is a different roster and can be a different size —
    // and, since #1162, a different SHAPE too: `record-unwritable` is the draft
    // saying `firestore.rules` would refuse this record, which is the one
    // failure that would otherwise arrive as a REJECTED write on an Event this
    // call has already shut. Reported verbatim, because every refusal the draft
    // can name is an `ArchiveEventResult` member.
    if (draft.refusal !== null) return draft.refusal;
    tx.update(eventRef, {
      status: 'archived',
      archivedAt,
      // The frozen record, written in the SAME update as the stamp it agrees
      // with. `firestore.rules` requires it to be complete and locks it here.
      archive: draft.archive,
      // The quiesce is over. `status` carries the freeze from here, and unlike
      // this flag it cannot be cleared.
      archiving: false,
      // The generation this flip was bound to, written to a FLIP-ONLY field so
      // the RULES can hold the same binding this transaction just checked
      // (Phase 4b P1 on PR #1157, run 3): the flip arm requires `archivedUnder`
      // to be written by the flip and to equal the stored `archiveToken`.
      // Restating `archiveToken` was no binding — the merged write inherits
      // it — whereas a field the document does not carry until the flip cannot
      // be inherited, so a stale or tokenless flip is refused.
      archivedUnder: token,
    });
    return 'archived';
    // Only the READ becomes a refusal. Anything else — the commit, above all —
    // is the caller's to see, so the console's failure pill still means what it
    // has always meant.
  }).catch((err: unknown): ArchiveEventResult => {
    if (lastTxFailureWasTheRead) return 'read-failed:event';
    throw err;
  });
}

/** Recompute a player's stats after an admin resolves one of their claims. */
/**
 * The pool value adminAddItem PERSISTS during the #565 rename transition. The
 * app speaks the canonical vocabulary ('easy'/'closing'), but every persisted
 * pool value stays LEGACY ('embark'/'farewell') until the coercion can be
 * dropped: the pool value — unlike Claim Mode — is compared server-side (the
 * deployed scheduler's `snapshotPoolsFor` matches items against
 * ['main','embark']; `firestore.rules` validate it), and hosting and
 * functions deploy separately. A hosting-only deploy that minted `'easy'`
 * would leave a mid-Event admin-added easy Prompt silently missing from the
 * next snapshot on not-yet-redeployed Functions. Reads coerce both
 * vocabularies (`migratePool`), so the stored spelling is invisible to the
 * app. Flip this to the identity mapping — and drop it — in the post-Event
 * cleanup that also drops the coercion and narrows the rules.
 */
function persistedPool(pool: 'main' | 'easy' | 'closing'): 'main' | 'embark' | 'farewell' {
  return pool === 'easy' ? 'embark' : pool === 'closing' ? 'farewell' : 'main';
}

/**
 * Admin-only curated add (#269, daily-cards-spec § "Item pools and the
 * approval flow": "Curated pools: … Admins can add/edit/hide them through the
 * Admin console"): lands ACTIVE directly — the approval gate exists for
 * player submissions; an admin adding a prompt IS the approval — with the
 * chosen pool (easy/closing curation, or main). Same payload shape as the
 * player path (src/data/api.ts addItem), same 80-char clamp the rules pin.
 */
export async function adminAddItem(
  uid: string,
  text: string,
  spicy: boolean,
  pool: 'main' | 'easy' | 'closing',
): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const safeSpicy = pool === 'main' ? spicy : false;
  await addDoc(itemsRaw(), {
    text: t.slice(0, 80),
    createdBy: uid,
    createdAt: Date.now(),
    isFreeSpace: false,
    status: 'active',
    reportCount: 0,
    spicy: safeSpicy,
    pool: persistedPool(pool),
  });
}

function itemTextLockedByUnlockedSnapshot(days: DayDef[] | undefined, id: string, now = Date.now()): boolean {
  return (days ?? []).some(
    (d) =>
      typeof d.unlockAt === 'number' &&
      d.unlockAt <= now &&
      Array.isArray(d.snapshotItemIds) &&
      d.snapshotItemIds.includes(id),
  );
}

/**
 * Admin-only text edit (#269) — curated-pool wording fixes without a reseed.
 * Rules: the isAdmin update arm allows it; the 80-char clamp matches create.
 * Re-reads the Event in the transaction so a stale Admin tab or direct call
 * cannot change text once an unlocked Day's snapshot can still deal that item.
 */
export async function adminUpdateItemText(id: string, text: string): Promise<void> {
  const eventId = EVENT_ID;
  const t = text.trim();
  if (!t) return;
  const eventRef = evt(eventId);
  const itemRef = item(id, eventId);
  await runTransaction(db, async (tx) => {
    const evSnap = await tx.get(eventRef);
    const days = evSnap.exists() ? (evSnap.data().days as DayDef[] | undefined) : undefined;
    if (itemTextLockedByUnlockedSnapshot(days, id)) return;
    tx.update(itemRef, { text: t.slice(0, 80) });
  });
}

/**
 * What one `resolve()` call performed, for the server-observed analytics
 * transition that `confirmClaim` stamps in its Board write.
 */
interface ResolveResult {
  /** Whether THIS call performed a genuine pending→confirmed transition on
   *  the claim's own cell (#721, Codex round 1 findings 3 & 5) — the moment
   *  `countMarked` (game/logic.ts, which excludes `status: 'pending'`) starts
   *  crediting the Square, and therefore the ONLY moment this write may carry
   *  an `admin_confirm` durable analytics request. `false` covers both
   *  non-credit-changing cases in one signal: a stale claim whose board no
   *  longer exists, or whose cell no longer matches `isClaimCell` (both
   *  no-ops below — no write, no transition), and the concurrent-confirm
   *  race (two admins resolve the same claim; Firestore replays the loser's
   *  transaction against the WINNER's already-`confirmed` cell, so its own
   *  `before` read is 'confirmed', not 'pending' — a rewrite, not a
   *  transition). Computed generically here (not gated to `status ===
   *  'confirmed'` internally) so a future confirm-adjacent caller cannot
   *  forget to ask; `rejectClaim` below simply never reads it. */
  transitioned: boolean;
}

async function resolve(
  c: ClaimDoc,
  transform: (cells: Cell[]) => Cell[],
  adminUid: string,
  status: 'confirmed' | 'rejected',
): Promise<ResolveResult> {
  // Claims can finish after hostname/Event resolution changes. Capture the
  // acted Event before the first await and keep every read, write and durable
  // analytics identity inside that one Event for the whole resolution.
  const eventId = EVENT_ID;
  // One stable identity outside the retryable transaction. The server trigger
  // observes the actual pending→confirmed edge and ignores this token unless
  // that edge commits, so a closed admin tab cannot lose or invent an event.
  const analyticsRequest =
    status === 'confirmed'
      ? directMarkAnalyticsRequest({
          cellIndex: c.cellIndex,
          marked: true,
          mode: 'admin_confirmed',
          source: 'admin_confirm',
          eventId,
        })
      : undefined;
  // Daily mode (#246, Codex #247 P2): a claim created on a day-scoped board carries
  // its `dayIndex`, so resolve against `days/{dayIndex}/boards/{uid}` and fold the
  // owner's `dayStats[dayIndex]` — the SAME routing attachProof/setMark use. Legacy
  // claims (no dayIndex) resolve the single event-level board. The tutorial set for
  // the cruise-wide first-bingo exclusion is read once, outside the atomic txn
  // (stable config, not part of the board/player invariant).
  const daily = typeof c.dayIndex === 'number';
  const boardRef = daily
    ? dayBoard(c.dayIndex as number, c.uid, eventId)
    : board(c.uid, eventId);
  let isTutorialDay: ((i: number) => boolean) | undefined;
  let isCeremonialDay: ((i: number) => boolean) | undefined;
  // The claim owner's OTHER Day indexes (specs/echo-marks.md, #446): a CONFIRM
  // is the moment an admin_confirmed Mark reaches confirmed, so it is the
  // moment the Prompt echoes onto the owner's sibling Day Cards — inside this
  // same transaction, each echoed board carrying its own markSeed, all stat
  // deltas folded into the ONE player write below. A reject uses the same reads
  // only to preserve a standing sibling's Tally marker; it never echoes.
  let echoSiblingDays: number[] = [];
  // The freeze gate is a GETTER re-evaluated inside the transaction callback
  // (Codex P2 on #278 round 4): a resolve started seconds before 08:00 must
  // fold with the post-boundary truth on retry/commit, not a pre-read capture.
  let isStatsFrozen: () => boolean = () => false;
  if (daily) {
    const evSnap = await getDoc(evt(eventId));
    const days = (evSnap?.data()?.days as DayDef[] | undefined) ?? [];
    const set = tutorialDayIndexSet(days);
    isTutorialDay = (i: number) => set.has(i);
    // The freeze + ceremonial gates apply to the ADMIN resolve fold too (#265,
    // Codex P1 on #278): a post-freeze claim approval must not move the frozen
    // standings — it narrows to the bucket-only write below, exactly like
    // setMark/attachProof — and the farewell bucket never enters the root sums.
    const ceremonial = ceremonialDayIndexSet(days);
    isCeremonialDay = (i: number) => ceremonial.has(i);
    const frozenAt = evSnap?.data()?.frozenAt as number | undefined;
    // The CONFIGURED freeze rides along with the stamp (ADR 0011): this
    // transaction re-reads the RAW event doc, so nothing has resolved
    // `standingsFreezeAt` for it and omitting it would silently fall back to
    // the schedule derivation on an Event that states its own freeze.
    const standingsFreezeAt = evSnap?.data()?.standingsFreezeAt as number | undefined;
    isStatsFrozen = () => standingsFrozen({ frozenAt, standingsFreezeAt, days });
    if (status === 'confirmed' || status === 'rejected') {
      echoSiblingDays = days.map((d) => d.index).filter((i) => i !== (c.dayIndex as number));
    }
  }
  return await runTransaction(db, async (tx): Promise<ResolveResult> => {
    // Read board + player inside the txn so a concurrent mark/proof from the same
    // player isn't clobbered by a stale snapshot (mirrors setMark/attachProof).
    const bSnap = await tx.get(boardRef);
    if (!bSnap.exists()) return { transitioned: false };
    const pSnap = await tx.get(player(c.uid, eventId));
    // The owner's sibling Day Cards, read in the SAME transaction (before any
    // write, per Firestore's reads-first contract) so a retry re-derives the
    // echo set from committed state (specs/echo-marks.md).
    const echoSiblingRefs = echoSiblingDays.map((i) => dayBoard(i, c.uid, eventId));
    const echoSiblingSnaps = await Promise.all(echoSiblingRefs.map((ref) => tx.get(ref)));
    const boardData = bSnap.data() as { cells?: unknown; seed?: number };
    const cells = cellsFromData(boardData.cells);
    const next = transform(cells);
    // The transition verdict (#721, Codex round 1 findings 3 & 5): computed
    // from THIS transaction's own before/after reads of the claim's cell —
    // see this function's doc comment. `isClaimCell` matches nothing when the
    // claim's board has moved on (a reshuffle traded the cell's position
    // away, or the index is simply stale); a `before` that is anything but
    // 'pending' means either it was never pending (a legacy/malformed claim)
    // or another confirm already credited it.
    const claimCellBefore = cells.find((x) => isClaimCell(x, c));
    const claimCellAfter = next.find((x) => isClaimCell(x, c));
    const transitionedToConfirmed =
      status === 'confirmed' && claimCellBefore?.status === 'pending' && claimCellAfter?.status === 'confirmed';
    const bingoCount = completedLines(next).length;
    const bingoTransition = completedLines(cells).length === 0 && bingoCount > 0;
    const squares = countMarked(next);
    const blackout = isBlackout(next);
    const dayHonorName = honorDisplayName(c.displayName, pSnap.exists() ? pSnap.data().displayName : undefined);
    // The prior first-bingo stamp is per-BOARD: in daily mode read the VIEWED Day's
    // bucket, not the cruise-wide root (which would restamp a cross-Day time).
    const priorDayStats = pSnap.exists() ? (pSnap.data().dayStats as DayStats | undefined) : undefined;
    const existingFirst = daily
      ? (priorDayStats?.[c.dayIndex as number]?.firstBingoAt ?? null)
      : (pSnap.exists() ? ((pSnap.data().firstBingoAt as number | null) ?? null) : null);
    // Clear the first-bingo stamp when the resolved board has no bingo (rejecting
    // a claim can remove the last line); keep the earliest stamp otherwise.
    const firstBingoAt = bingoCount > 0 ? (existingFirst ?? Date.now()) : null;
    const shouldPinDayHonor =
      daily &&
      status === 'confirmed' &&
      bingoTransition &&
      typeof firstBingoAt === 'number' &&
      dayHonorName !== null;
    const metaRef = shouldPinDayHonor ? dayMeta(c.dayIndex as number, eventId) : null;
    const metaSnap = metaRef ? await tx.get(metaRef) : null;

    // Echo Marks (specs/echo-marks.md, #446): a CONFIRM is the moment the
    // Prompt reaches confirmed, so echo it onto every sibling Day Card of the
    // owner's that carries it unmarked — in this SAME transaction, each echoed
    // board carrying ITS OWN markSeed. Echoed cells are born `confirmed`: the
    // achievement was already admin-confirmed once, so they raise no second
    // Claim. A reject writes no Echo, but uses the sibling snapshots below to
    // preserve a marker while another confirmed carrier stands. Unmarking a
    // rejected cell never cascades to prior echoes. No Feed Moment is posted
    // from here — this runs on the ADMIN's device and a Moment must be written
    // by its winner (see the spec's Moments residual for this mode) — but an
    // echo-completed first line DOES pin its Day's write-once honor below
    // (Codex P2 on #447), through the day-meta create rule's admin arm,
    // attributed to the WINNER like the claim Day's own pin. Computed here —
    // BEFORE any tx write — because the pin needs its meta doc read first
    // (Firestore's reads-before-writes transaction contract).
    const confirmedCell = status === 'confirmed' ? next.find((x) => isClaimCell(x, c)) : undefined;
    const echoItemId =
      confirmedCell && !confirmedCell.free && confirmedCell.marked ? confirmedCell.itemId : null;
    const echoBuckets: EchoBucket[] = [];
    const echoWrites: Array<{ ref: ReturnType<typeof dayBoard>; set: ReturnType<typeof cellsMergeSet> }> = [];
    const echoPinDays: number[] = [];
    const echoNow = Date.now();
    if (echoItemId && echoSiblingSnaps.length > 0) {
      const achieved = new Set([echoItemId]);
      echoSiblingSnaps.forEach((snap, idx) => {
        if (!snap.exists()) return;
        const sib = snap.data() as { cells?: unknown; seed?: number };
        const sibCells = cellsFromData(sib.cells);
        const rawRes = applyEchoes(sibCells, achieved, echoNow);
        const res = {
          ...rawRes,
          cells: stampEchoAnalyticsTransitions({
            cells: rawRes.cells,
            changed: changedCells(sibCells, rawRes.cells),
            eventId,
            uid: c.uid,
            dayIndex: echoSiblingDays[idx],
            boardSeed: typeof sib.seed === 'number' ? sib.seed : undefined,
            trigger: 'admin_confirm',
          }),
        };
        if (!res.changed) return;
        echoWrites.push({
          ref: echoSiblingRefs[idx],
          // Per-cell merge (#457): only the newly echoed cells ride the write.
          set: cellsMergeSet(cellsPatch(changedCells(sibCells, res.cells)), {
            ...(typeof sib.seed === 'number' ? { markSeed: sib.seed } : {}),
          }),
        });
        echoBuckets.push({
          dayIndex: echoSiblingDays[idx],
          bingoCount: res.bingoCount,
          squaresMarked: res.squaresMarked,
          blackout: res.blackout,
        });
        if (res.bingoTransition && dayHonorName) echoPinDays.push(echoSiblingDays[idx]);
      });
    }
    // Echo Day-honor meta reads — the same post-freeze narrowing as the stats.
    const pinnableEchoDays = echoPinDays.filter((d) => !isStatsFrozen() || !!isCeremonialDay?.(d));
    const echoMetaSnaps: Array<{ dayIndex: number; exists: boolean }> = [];
    for (const d of pinnableEchoDays) {
      const snap = await tx.get(dayMeta(d, eventId));
      echoMetaSnaps.push({ dayIndex: d, exists: snap.exists() });
    }
    // The claim's Proof, read LIVE and BEFORE any write (Firestore's
    // reads-before-writes contract), so the publish below can be conditional on
    // the state Cloud Vision may have moved it to since the Player submitted it
    // (#133). `null` whenever there is nothing to publish — a reject, or a
    // legacy claim carrying no proofId — so no other resolve pays for the read.
    const claimProofRef = status === 'confirmed' && c.proofId ? proof(c.proofId, eventId) : null;
    const claimProofSnap = claimProofRef ? await tx.get(claimProofRef) : null;

    tx.set(
      boardRef,
      // Per-cell merge (#457): only the resolved claim's cell rides the write.
      ...cellsMergeSet(cellsPatch(changedCells(cells, next)), {
        ...(typeof boardData.seed === 'number' ? { markSeed: boardData.seed } : {}),
        ...(transitionedToConfirmed && analyticsRequest ? { directAnalyticsRequest: analyticsRequest } : {}),
      }),
    );
    for (const write of echoWrites) {
      tx.set(write.ref, ...write.set);
    }
    for (const { dayIndex: echoDay, exists } of echoMetaSnaps) {
      if (exists) continue; // the write-once honor is already claimed
      tx.set(dayMeta(echoDay, eventId), {
        firstBingo: {
          uid: c.uid,
          displayName: dayHonorName!,
          at: echoNow,
        },
      });
    }
    if (daily) {
      const siblingBlackout =
        status === 'rejected' &&
        pSnap.exists() &&
        (pSnap.data() as Partial<PlayerDoc>).blackout === true &&
        echoSiblingSnaps.some(
          (snap) => snap.exists() && isBlackout(cellsFromData((snap.data() as { cells?: unknown }).cells)),
        );
      const playerWrite = foldDayStat({
        priorDayStats,
        dayIndex: c.dayIndex as number,
        bucket: { bingoCount, squaresMarked: squares, firstBingoAt },
        blackout: blackout || siblingBlackout,
        isTutorialDay,
        isCeremonialDay,
      });
      // The ONE aggregated player write: the claim Day's fold composed with
      // every echoed board's bucket (specs/echo-marks.md § Scoring).
      const aggregatedWrite =
        echoBuckets.length > 0
          ? foldEchoStats({
              priorDayStats,
              echoes: echoBuckets,
              now: echoNow,
              isTutorialDay,
              isCeremonialDay,
              // Preserve a blackout standing on an UNTOUCHED board (Codex P2
              // on #447): a confirm only adds Marks, so the latch is safe.
              priorBlackout: pSnap.exists() && (pSnap.data() as Partial<PlayerDoc>).blackout === true,
              base: playerWrite,
            })
          : playerWrite;
      const canWriteStats = !isStatsFrozen() || !!isCeremonialDay?.(c.dayIndex as number);
      if (isStatsFrozen()) {
        // Ceremonial-day-only post-freeze buckets, mirroring setMark (Codex P2
        // on #278 round 2): any other Day's bucket would drift settled honors —
        // echoed main-day buckets are dropped with the root aggregates.
        const ceremonialBuckets: Record<number, StatWrite> = {};
        for (const [k, v] of Object.entries(aggregatedWrite.dayStats)) {
          if (isCeremonialDay?.(Number(k))) ceremonialBuckets[Number(k)] = v;
        }
        if (Object.keys(ceremonialBuckets).length > 0) {
          tx.set(player(c.uid, eventId), { dayStats: ceremonialBuckets }, { merge: true });
        }
      } else {
        tx.set(player(c.uid, eventId), aggregatedWrite, { merge: true });
      }
      if (canWriteStats && shouldPinDayHonor) {
        if (metaRef && !metaSnap?.exists()) {
          tx.set(metaRef, {
            firstBingo: {
              uid: c.uid,
              displayName: dayHonorName!,
              at: firstBingoAt,
            },
          });
        }
      }
    } else {
      tx.set(
        player(c.uid, eventId),
        { squaresMarked: squares, bingoCount, blackout, firstBingoAt },
        { merge: true },
      );
    }
    // Tally symmetry (ADR 0002): wherever a write flips a cell marked→unmarked it
    // must delete that cell's per-Prompt Tally marker, and wherever it flips
    // →marked it must ensure the marker (setMark and attachProof do). Rejecting a
    // claim unmarks the claim's cell via the transform above, so diff old→new and
    // delete the marker for exactly the cells that lost their mark — the SAME
    // conditionality as the flip itself; without this, a rejected admin_confirmed
    // claim would reverse the board + stats but leave the player in the Prompt's
    // public count/who-list (Codex P2, PR #87). The transform is a positional map,
    // so old/new align by index; the free centre (null itemId) never has a marker;
    // confirming never unmarks, so this is a no-op for confirmClaim. tx.delete is
    // a write, so the reads-before-writes transaction contract holds unchanged.
    next.forEach((after, i) => {
      const before = cells[i];
      const siblingStillCarriesMarker = echoSiblingSnaps.some(
        (snap) =>
          snap.exists() &&
          cellsFromData((snap.data() as { cells?: unknown }).cells).some(
            (cell) => !cell.free && cell.marked && cell.itemId === before.itemId,
          ),
      );
      if (before.marked && !after.marked && before.itemId && !siblingStillCarriesMarker) {
        tx.delete(marker(before.itemId, c.uid, eventId));
      }
    });
    tx.set(claim(c.id, eventId), { status, resolvedBy: adminUid }, { merge: true });
    // Confirming an admin-confirmed claim publishes its proof, which was created 'pending'
    // (admin-only readable) so it stayed hidden from the public feed until now. A
    // rejected proof is left 'pending' (still admin-only) rather than exposed.
    //
    // UNLESS a server-authoritative safety hide stands on it (#133, Codex P1).
    // Cloud Vision scans the uploaded object, so an admin_confirmed claim's Proof
    // can be flagged and hidden BEFORE its claim is ever reviewed. Publishing it
    // unconditionally would write `status: 'active'`, and active Proofs are
    // outside `qualifiesForVisionHide` — so extreme/illegal media would go back
    // in front of every Player and the trigger would never hide it again, lifted
    // by a control that shows only the submitter and the Prompt. This is NOT the
    // warned, explicit moderation Restore (ReviewQueue), which is the one place
    // an admin may override an AI verdict, having been told what they are
    // lifting. So the claim still resolves and the Mark is still confirmed —
    // only the media stays hidden, and the queue row says so on the claim.
    //
    // `safetyHideStands` reads the SERVER's own record — `hideProofOnVisionFlag`'s
    // `safetyHide` marker, and the `'flagged'` status only `moderateProof` writes
    // — never the verdict string (Codex P1 round 2). The verdict's MEANING lives
    // in the Functions allowlist, and Functions and this bundle deploy
    // separately, so a client that re-derived it would publish a Proof hidden for
    // a verdict its cached copy of the list had never heard of.
    //
    // The gate reads the LIVE snapshot, not the stale event that opened the
    // admin's console, and only a genuinely publishable Proof is moved: a
    // 'pending' one, an already-active one (a no-op re-write), or a plain
    // report-count / manual hide, whose lift is `Clear reports` / `Restore` and
    // whose confirm behaviour is unchanged. A missing snapshot keeps the pre-#133
    // write.
    if (claimProofRef) {
      const liveProof = claimProofSnap?.exists()
        ? (claimProofSnap.data() as Partial<ProofDoc> | undefined)
        : undefined;
      if (!safetyHideStands(liveProof)) {
        tx.set(claimProofRef, { status: 'active' }, { merge: true });
      }
    }
    return { transitioned: transitionedToConfirmed };
  });
}

/**
 * The board cell a claim resolves. Match on the claim's own proofId when it has
 * one, so resolving one of several pending claims for the same square acts on
 * that claim's proof — not whichever proof currently sits at the index (which may
 * be a newer submission). Fall back to cellIndex for legacy claims with no proofId.
 */
const isClaimCell = (x: Cell, c: ClaimDoc): boolean =>
  c.proofId != null ? x.proofId === c.proofId : x.index === c.cellIndex;

export function confirmClaim(c: ClaimDoc, adminUid: string): Promise<void> {
  const creditedAt = Date.now();
  const confirmed = resolve(
    c,
    (cells) =>
      cells.map((x) =>
        isClaimCell(x, c) ? { ...x, status: 'confirmed' as const, markedAt: creditedAt } : x,
      ),
    adminUid,
    'confirmed',
  );
  // Mark-transition instrumentation (#721): `confirmClaim` only ever resolves
  // a PENDING claim (ReviewQueue's "Pending claims" queue is admin_confirmed-
  // mode only, per its own module comment) reaching `confirmed` — the moment
  // `countMarked` (game/logic.ts) starts crediting the Square, since it
  // excludes `status: 'pending'`. The Square itself went `marked: true`
  // earlier, at proof-attach time (ProofSheet's `source: 'proof'` event), so
  // one confirmed admin_confirmed-mode Square produces TWO `mark_square`
  // events before it counts once in `dayStats[*].squaresMarked` — documented
  // in specs/w2-ga4-events.md § Reconciliation, not a double-count bug. Fired
  // only after `confirmed` resolves (the transaction committed), via a
  // dynamic import — matching src/data/api.ts's `mark_rejected` call site —
  // so this Firestore-only module stays free of an eager
  // analytics/firebase-singleton dependency; test doubles mock `../firebase`
  // with only what the writes need.
  //
  // Gated on `resolve()`'s own transition verdict (Codex round 1 finding 3):
  // a stale claim (no board, or `isClaimCell` matches nothing on the current
  // board — a reshuffle traded the cell away) resolves without moving the
  // Square from pending to confirmed at all, and two admins racing the SAME
  // claim have their loser's transaction replay against the winner's
  // already-confirmed cell — a rewrite, not a transition. Firing here
  // unconditionally would report a credited Square in both cases even though
  // `dayStats[*].squaresMarked` never moved, breaking the reconciliation
  // identity specs/w2-ga4-events.md § Reconciliation documents.
  //
  // `uid: c.uid` (Codex round 1 finding 6): `track()` runs in the resolving
  // ADMIN's own browser/session, so without an explicit target-player
  // identifier PostHog/GA4 attribute this event to the ADMIN's distinct id,
  // not the claim owner's — there is otherwise no way to recover whose
  // Square this was from the payload alone.
  //
  // `resolve` stamps this committed edge with a stable request token. The
  // server-side recorder, rather than this administrator's browser, delivers
  // the analytics event for the claim owner's Board transition.
  return confirmed.then(() => undefined);
}

export function rejectClaim(c: ClaimDoc, adminUid: string): Promise<void> {
  // `resolve()`'s transition verdict is confirm-only instrumentation
  // (`confirmClaim`'s concern, above) — a reject fires no `mark_square`, so
  // the boolean is simply discarded here.
  return resolve(
    c,
    (cells) =>
      cells.map((x) =>
        isClaimCell(x, c)
          ? { ...x, marked: false, status: 'confirmed' as const, proofId: null, markedAt: null }
          : x,
      ),
    adminUid,
    'rejected',
  ).then(() => undefined);
}
