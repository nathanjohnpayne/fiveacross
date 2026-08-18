import { addDoc, collection, doc, getDoc, updateDoc, deleteDoc, deleteField, runTransaction, arrayUnion, arrayRemove } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions, EVENT_ID } from '../firebase';
import { completedLines, countMarked, isBlackout, foldDayStat, foldEchoStats, applyEchoes, tutorialDayIndexSet, ceremonialDayIndexSet, standingsFrozen, type DayStats, type EchoBucket, type StatWrite } from '../game/logic';
import { cellsPatch, changedCells, cellsFromData } from '../game/cells';
import { cellsMergeSet } from './cellsMerge';
import { stampEchoAnalyticsTransitions } from './echoAnalytics';
import { directMarkAnalyticsRequest } from './markAnalytics';
import { honorDisplayName, markerDisplayName } from './attribution';
import { isSystemAuthor } from './moderation';
import { routeApprovalToDay, defaultTargetDayIndex, isUsableTarget } from './communityPrompts';
import type { Cell, ClaimMode, ThemeId, ClaimDoc, ItemDoc, DayDef, PlayerDoc } from '../types';

const evt = () => doc(db, 'events', EVENT_ID);
const item = (id: string) => doc(db, 'events', EVENT_ID, 'items', id);
const itemsRaw = () => collection(db, 'events', EVENT_ID, 'items');
const proof = (id: string) => doc(db, 'events', EVENT_ID, 'proofs', id);
const claim = (id: string) => doc(db, 'events', EVENT_ID, 'claims', id);
const board = (uid: string) => doc(db, 'events', EVENT_ID, 'boards', uid);
// The day-scoped board a daily-mode claim resolves against (#246).
const dayBoard = (dayIndex: number, uid: string) =>
  doc(db, 'events', EVENT_ID, 'days', String(dayIndex), 'boards', uid);
const dayMeta = (dayIndex: number) =>
  doc(db, 'events', EVENT_ID, 'days', String(dayIndex), 'meta', String(dayIndex));
const player = (uid: string) => doc(db, 'events', EVENT_ID, 'players', uid);
// A per-Prompt Tally marker (ADR 0002): the same path setMark/attachProof write.
const marker = (itemId: string, uid: string) =>
  doc(db, 'events', EVENT_ID, 'tally', itemId, 'markers', uid);

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
// that can still see WHY a Prompt was turned down. Both writes are unconstrained
// by `firestore.rules` under the `isAdmin(eventId)` arm — no client-side field
// allowlist needed beyond what the rule already checks.
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
 * so a caller can pass what it already holds, but only `id` is TRUSTED:
 * `targetDayIndex` here is a hint, and routing deliberately ignores it in favour
 * of the value read inside the transaction. A client row can be stale — that is
 * exactly the double-approval hazard the stale guard below exists for — so the
 * authoritative document is the only thing worth routing on.
 */
export type ApprovableItem = Pick<ItemDoc, 'id'> & Partial<Pick<ItemDoc, 'targetDayIndex'>>;

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
): Promise<ApprovalPlacement[]> {
  if (items.length === 0) return [];
  return runTransaction(db, async (tx) => {
    // EVERY read first: Firestore requires a transaction's reads to precede its
    // writes, so the item reads cannot live inside the write loop below.
    const evSnap = await tx.get(evt());
    const rows: (ItemDoc | undefined)[] = [];
    for (const it of items) {
      const snap = await tx.get(item(it.id));
      rows.push(snap.exists() ? (snap.data() as ItemDoc) : undefined);
    }
    const days = evSnap.exists() ? ((evSnap.data().days as DayDef[] | undefined) ?? []) : [];
    const approvedAt = Date.now();
    const placements: ApprovalPlacement[] = [];
    for (const [i, it] of items.entries()) {
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
      const base = { status: 'active' as const, approvedBy: adminUid, approvedAt };
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
          tx.update(item(it.id), placed);
          placements.push({ itemId: it.id, dayIndex: null, retained: false, outcome: 'untargeted' });
          continue;
        }
        const resolved = defaultTargetDayIndex(days, approvedAt);
        if (resolved == null) {
          // A schedule exists but nothing in it can still take a Prompt. Retained
          // is the honest outcome, and the same one a targeted Prompt with
          // nowhere left to go gets.
          tx.update(item(it.id), { ...base, retainedAt: approvedAt });
          placements.push({ itemId: it.id, dayIndex: null, retained: true, outcome: 'retained' });
          continue;
        }
        tx.update(item(it.id), { ...placed, targetDayIndex: resolved });
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
        tx.update(item(it.id), { ...base, retainedAt: approvedAt });
        placements.push({ itemId: it.id, dayIndex: null, retained: true, outcome: 'retained' });
        continue;
      }
      const routed = routeApprovalToDay(days, targetDayIndex, approvedAt);
      if (routed == null) {
        // Retained: the original target is LEFT in place. Clearing it would make
        // the Prompt untargeted, which reads as "every Day" — the one outcome
        // this ticket exists to prevent.
        tx.update(item(it.id), { ...base, retainedAt: approvedAt });
        placements.push({ itemId: it.id, dayIndex: null, retained: true, outcome: 'retained' });
        continue;
      }
      tx.update(item(it.id), { ...placed, targetDayIndex: routed });
      placements.push({ itemId: it.id, dayIndex: routed, retained: false, outcome: 'placed' });
    }
    return placements;
  });
}

/**
 * Approve one Prompt. Takes the queue ROW because that is what the Approvals
 * queue holds, but only its `id` is load-bearing: since the stale guard reads
 * the item inside the transaction, the intended Day comes from the stored
 * document rather than from whatever the client was last shown. That is the
 * stronger version of the original reason for this signature — an id is enough
 * precisely BECAUSE approval no longer trusts the caller's copy of the target.
 */
export const approveItem = (row: ApprovableItem, adminUid: string) =>
  approveItems([row], adminUid).then((placements) => placements[0]);
export const rejectItem = (id: string, adminUid: string) =>
  updateDoc(item(id), { status: 'rejected', approvedBy: adminUid, approvedAt: Date.now() });

// Lets an admin correct a submitter's 🔞 tagging from the Approvals queue BEFORE
// approving it into the live pool — once approved, `dealBoard`'s spicy-ratio
// sampling treats `spicy` as authoritative, so getting it right pre-approve
// matters more than it would post-approve.
export const setItemSpicy = (id: string, spicy: boolean) => updateDoc(item(id), { spicy });

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
): Promise<ApprovalPlacement[]> {
  return approveItems(items, adminUid);
}
export const hideProof = (id: string) => updateDoc(proof(id), { status: 'hidden' });
export const restoreProof = (id: string) => updateDoc(proof(id), { status: 'active' });

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
export const setDayTheme = (days: DayDef[], dayIndex: number, theme: ThemeId): Promise<void> =>
  runTransaction(db, async (tx) => {
    const snap = await tx.get(evt());
    const current =
      (snap.exists() ? (snap.data().days as DayDef[] | undefined) : undefined) ?? days;
    tx.update(evt(), {
      days: current.map((d) => (d.index === dayIndex ? { ...d, theme } : d)),
    });
  });

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
export const setDayTonight = (days: DayDef[], dayIndex: number, tonight: string[]): Promise<void> =>
  runTransaction(db, async (tx) => {
    if (!isValidTonight(tonight)) {
      throw new Error('Tonight must contain exactly two non-empty entries.');
    }
    const snap = await tx.get(evt());
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
    tx.update(evt(), {
      days: current.map((d) => (d.index === dayIndex ? { ...d, tonight: nextTonight } : d)),
    });
  });

/** What `unlockDayNow` reports back — mirrors `SnapshotResult` in `functions/src/unlockDay.ts`. */
export type UnlockDayNowResult = 'stamped' | 'already-stamped' | 'not-due' | 'no-event' | 'no-day';

/** What the guarded re-snapshot reports back — mirrors `ResnapshotResult` in
 *  `functions/src/unlockDay.ts` (specs/easy-mix.md § "Deploy race"). */
export type ResnapshotDayResult =
  | 'resnapshotted'
  | 'has-boards'
  | 'not-recoverable'
  | 'not-due'
  | 'no-event'
  | 'no-day';

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
  const t = text.trim();
  if (!t) return;
  await runTransaction(db, async (tx) => {
    const evSnap = await tx.get(evt());
    const days = evSnap.exists() ? (evSnap.data().days as DayDef[] | undefined) : undefined;
    if (itemTextLockedByUnlockedSnapshot(days, id)) return;
    tx.update(item(id), { text: t.slice(0, 80) });
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
        })
      : undefined;
  // Daily mode (#246, Codex #247 P2): a claim created on a day-scoped board carries
  // its `dayIndex`, so resolve against `days/{dayIndex}/boards/{uid}` and fold the
  // owner's `dayStats[dayIndex]` — the SAME routing attachProof/setMark use. Legacy
  // claims (no dayIndex) resolve the single event-level board. The tutorial set for
  // the cruise-wide first-bingo exclusion is read once, outside the atomic txn
  // (stable config, not part of the board/player invariant).
  const daily = typeof c.dayIndex === 'number';
  const boardRef = daily ? dayBoard(c.dayIndex as number, c.uid) : board(c.uid);
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
    const evSnap = await getDoc(evt());
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
    const pSnap = await tx.get(player(c.uid));
    // The owner's sibling Day Cards, read in the SAME transaction (before any
    // write, per Firestore's reads-first contract) so a retry re-derives the
    // echo set from committed state (specs/echo-marks.md).
    const echoSiblingRefs = echoSiblingDays.map((i) => dayBoard(i, c.uid));
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
    const metaRef = shouldPinDayHonor ? dayMeta(c.dayIndex as number) : null;
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
            eventId: EVENT_ID,
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
      const snap = await tx.get(dayMeta(d));
      echoMetaSnaps.push({ dayIndex: d, exists: snap.exists() });
    }

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
      tx.set(dayMeta(echoDay), {
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
          tx.set(player(c.uid), { dayStats: ceremonialBuckets }, { merge: true });
        }
      } else {
        tx.set(player(c.uid), aggregatedWrite, { merge: true });
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
      tx.set(player(c.uid), { squaresMarked: squares, bingoCount, blackout, firstBingoAt }, { merge: true });
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
        tx.delete(marker(before.itemId, c.uid));
      }
    });
    tx.set(claim(c.id), { status, resolvedBy: adminUid }, { merge: true });
    // Confirming an admin-confirmed claim publishes its proof, which was created 'pending'
    // (admin-only readable) so it stayed hidden from the public feed until now. A
    // rejected proof is left 'pending' (still admin-only) rather than exposed.
    if (status === 'confirmed' && c.proofId) {
      tx.set(proof(c.proofId), { status: 'active' }, { merge: true });
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
