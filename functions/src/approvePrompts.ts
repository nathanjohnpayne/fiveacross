/**
 * Server-side Community Prompt approval (#1275, #813, ADR 0015,
 * specs/community-prompt-targeting.md § "The clock routing trusts").
 *
 * The `approvePrompts` callable is the ONLY way a pending player submission
 * becomes `active`: `firestore.rules` deny every client `pending -> active`
 * flip, an Admin's included. Approval used to be a client transaction in
 * `src/data/admin.ts`, and two things about that could not be fixed there:
 *
 *   1. Routing compared each Day's `unlockAt` against the approving Admin's
 *      DEVICE clock and stamped the same instant as `approvedAt`, so a skewed
 *      clock could change which Day a Prompt landed on AND the value the
 *      snapshot cutoff is later judged against. `serverTimestamp()` cannot fix
 *      that client-side: its value is unreadable before the commit routing has
 *      to decide.
 *   2. The phantom ordering. `stampDaySnapshot` reads its `status == 'active'`
 *      item query inside its own transaction, but a row flipping
 *      `pending -> active` was not a document that query matched, so the
 *      scheduler could commit a list computed before an approval that had just
 *      reported "scheduled for Day N".
 *
 * Here routing, `approvedAt` and `retainedAt` all derive from ONE server
 * instant (`deps.now()`, read once per transaction attempt, after the reads),
 * kept as epoch-ms so no reader changes. And when any row is written, the same
 * transaction bumps `approvalSeq` on the Event doc: `stampDaySnapshot` reads
 * and updates that document, so the two transactions now conflict at the
 * document level in both Firestore concurrency modes, and whichever loses
 * re-runs against the state that won. Firestore already documents serializable
 * isolation for transactions, so the fence is defense-in-depth rather than the
 * correctness argument; the spec says why it is written anyway.
 *
 * `approvePromptsCore` is the logic, pure over an injected Admin-SDK surface so
 * the functions suite drives it with in-memory fakes. `approvePromptsCallable`
 * is the boundary: auth, App Check, payload validation, and the mapping of every
 * failure onto an `HttpsError` the Approvals queue already handles. Nothing
 * thrown by Firestore is ever echoed to the caller. `functions/src/index.ts`
 * stays a thin seam.
 */
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import {
  defaultTargetDayIndex,
  isUsableTarget,
  routeApprovalToDay,
  type TargetableDay,
} from './communityPromptRouting';
import { firestoreErrorCodeForLog } from './firestoreErrors';
import { normalizePool } from './poolVocab';
import { eventClosedToPlay, isEventAdmin, type AdminFirestore, type EventLike } from './unlockDay';

// --- Wire contract ----------------------------------------------------------------
// `ApprovalOutcome` and `ApprovalPlacement` are copied VERBATIM from
// src/data/admin.ts, which re-exports its own copy for the console. The two
// packages are deliberately decoupled, so the shape is restated; the client
// wrapper narrows every response against this shape before trusting it.

/**
 * What THIS call did to a Prompt — kept separate from what state the Prompt is
 * in, so a caller never announces a placement for something it never approved.
 *
 *   - `placed`      — approved onto `dayIndex`.
 *   - `untargeted`  — approved with no Day: only reachable on an Event that has
 *                     no schedule at all, where it means the single board.
 *   - `retained`    — approved, but no Day can deal it, so it is dealt nowhere.
 *   - `stale`       — NOT approved: the row was no longer `pending`. `dayIndex`
 *                     and `retained` then describe where it already stands.
 *   - `missing`     — NOT approved: no such item.
 *   - `malformed`   — NOT approved: the caller's #558 classification for that
 *                     row is not one approval can act on; `reason` says why.
 */
export type ApprovalOutcome =
  | 'placed'
  | 'untargeted'
  | 'retained'
  | 'stale'
  | 'missing'
  | 'malformed';

export interface ApprovalPlacement {
  itemId: string;
  /** The Day this Prompt is scheduled for, or `null` for none. */
  dayIndex: number | null;
  /** Whether the Prompt is in the retained state — dealt nowhere. */
  retained: boolean;
  /** What this call DID. Only `placed`/`untargeted`/`retained` wrote anything. */
  outcome: ApprovalOutcome;
  /** Why a `malformed` row was skipped — the CLASSIFICATION only, never the
   *  Prompt, so it carries no submitter prose. Absent on every other outcome. */
  reason?: string;
}

/** One queue row as the callable receives it. `id` is the only routing input;
 *  `pool`/`spicy` carry the Admin's explicit #558 classification decision and
 *  are validated only after the stored row proves it is still pending. */
export interface ApprovePromptsItem {
  id: string;
  pool?: unknown;
  spicy?: unknown;
}

export interface ApprovePromptsRequest {
  eventId: string;
  items: ApprovePromptsItem[];
}

export interface ApprovePromptsResponse {
  placements: ApprovalPlacement[];
}

/** One transaction per call, so the batch is bounded: N item reads plus the
 *  Event, N item writes plus one. A queue over this gets `invalid-argument`
 *  rather than a partial approval. */
export const MAX_APPROVE_PROMPTS_ITEMS = 400;

// --- Injected surface -------------------------------------------------------------

export interface ApprovePromptsLogger {
  warn(message: string, context: Readonly<Record<string, unknown>>): void;
  error(message: string, context: Readonly<Record<string, unknown>>): void;
}

export interface ApprovePromptsDeps {
  db: AdminFirestore;
  /** The server clock. Read ONCE per transaction attempt, after the reads. */
  now: () => number;
  /** The Admin SDK's `FieldValue.delete()` sentinel, injected so the core and
   *  its tests never touch the SDK. A placement CLEARS `retainedAt` with it. */
  deleteField: () => unknown;
  logger?: ApprovePromptsLogger;
}

// --- Errors the core throws; the callable maps each to one HttpsError ------------

/** The caller is not on the Event's `admins` roster, or the Event does not
 *  exist. One class for both, so the response never reveals which. */
export class ApprovalPermissionError extends Error {}
/** The Event is archived or closing (#134): approvals are frozen with the rest
 *  of gameplay. Rejection stays a client write, because moderation outlives the
 *  Event. */
export class ApprovalClosedError extends Error {}
/** The payload is not the wire contract above. */
export class ApprovalRequestError extends Error {}

// --- The #558 classification guards: ONE copy, moved here from src/data/admin.ts --

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

function approvalSpicy(callerSpicy: unknown, storedSpicy: unknown, difficulty: 'main' | 'easy'): boolean {
  if (difficulty === 'easy') return false;
  if (callerSpicy !== undefined && typeof callerSpicy !== 'boolean') {
    throw new Error('Community Prompt approval requires a boolean spicy classification.');
  }
  // Old callers that predate #558 preserve the authoritative pending row. The
  // Review queue always supplies its exact current choice so a toggle followed
  // immediately by approval cannot lose a race to the approval transaction.
  return callerSpicy === undefined ? storedSpicy === true : callerSpicy;
}

// The two classification guards above are the only per-ROW rejections in the
// approval transaction, and the only ones a batch can isolate (#1070). Both
// throw a written-for-a-human sentence about the CLASSIFICATION — never about
// the Prompt — so it is carried straight through as the placement's `reason`.
const malformedReason = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : 'Community Prompt approval received a classification it cannot act on.';

/** The pool value approval PERSISTS during the #565 rename transition: `easy`
 *  stays `embark` until the post-Event vocabulary cutover, exactly as the
 *  client's own `persistedPool` (src/data/admin.ts, kept for adminAddItem). */
const persistedPool = (difficulty: 'main' | 'easy'): 'main' | 'embark' =>
  difficulty === 'easy' ? 'embark' : 'main';

// --- The core ---------------------------------------------------------------------

/** The raw stored item fields approval reads. Raw because the Admin SDK hands
 *  back untyped maps; every field is checked before it is trusted. */
interface StoredItemRow {
  status?: unknown;
  targetDayIndex?: unknown;
  retainedAt?: unknown;
  pool?: unknown;
  spicy?: unknown;
}

/** `EventLike` plus the fence counter, which is this module's own field. */
type ApprovalEvent = EventLike & { approvalSeq?: unknown };

/**
 * Approve one or more pending Prompts as `uid`, routing each to its intended Day
 * on the server clock and stamping `approvedAt`/`retainedAt` from that instant.
 *
 * Everything happens inside ONE transaction attempt, in this order: read the
 * Event, verify `uid` is an admin (`ApprovalPermissionError`) and the Event is
 * open (`ApprovalClosedError`), read every item, take `deps.now()`, route and
 * stage the item writes, then — only when at least one row was written — bump
 * `approvalSeq` on the Event. A retried attempt starts clean, so the placements
 * always describe the state that actually committed.
 *
 * Per-row conditions are reported as that row's own outcome and skipped —
 * `missing`, `stale`, and a `malformed` classification (#1070) — so the rest of
 * the batch still approves. Every failure of the TRANSACTION itself still fails
 * the whole call. Bulk shares one `approvedAt` instant (one click is one
 * approval event), which also keeps the batch on one side of every cutoff.
 *
 * A batch made only of stale, missing or malformed rows writes NOTHING: no item
 * write and no fence, so a harmless double-click costs no Event write.
 */
export async function approvePromptsCore(
  deps: ApprovePromptsDeps,
  uid: string,
  eventId: string,
  items: readonly ApprovePromptsItem[],
): Promise<ApprovalPlacement[]> {
  if (items.length === 0) return [];
  const eventRef = deps.db.doc(`events/${eventId}`);
  const itemRefs = items.map((it) => deps.db.doc(`events/${eventId}/items/${it.id}`));
  return deps.db.runTransaction(async (tx) => {
    // EVERY read first: Firestore requires a transaction's reads to precede its
    // writes. The Event is read before the items so a non-admin never learns
    // which of their guessed item ids exist.
    const evSnap = await tx.get(eventRef);
    const ev = evSnap.exists ? (evSnap.data() as ApprovalEvent | undefined) : undefined;
    // Verified INSIDE the attempt, against the roster this commit will be
    // serialized with (the eventInvitations pattern). A missing Event and a
    // non-admin caller are the same answer, so the response reveals neither.
    if (!ev || !isEventAdmin(ev, uid)) {
      throw new ApprovalPermissionError('Only an admin of this Event can approve its Prompts.');
    }
    // #134: every Admin-SDK gameplay writer stands down on a closed Event, and
    // approval deals a Prompt into a future Day, so it is one of them.
    if (eventClosedToPlay(ev)) {
      throw new ApprovalClosedError('This Event is closed; approvals are frozen.');
    }
    const rowSnaps = await Promise.all(itemRefs.map((ref) => tx.get(ref)));
    const days: TargetableDay[] = Array.isArray(ev.days) ? ev.days : [];
    // The ONE instant for this attempt: routing, approvedAt and retainedAt all
    // read it, so a bulk approve shares it and a retry re-takes it.
    const approvedAt = deps.now();
    const placements: ApprovalPlacement[] = [];
    let wrote = false;
    for (const [i, it] of items.entries()) {
      const ref = itemRefs[i];
      const snap = rowSnaps[i];
      const row = snap.exists ? (snap.data() as StoredItemRow | undefined) : undefined;
      // STALE APPROVAL GUARD. Two organisers can hold the same queue row: the
      // first approval routes the Prompt to Day 2, Day 2 freezes with its id,
      // and a second approval of the stale row would find Day 2 closed, roll
      // FORWARD, and rewrite it for Day 3, which then freezes with it too — the
      // Prompt dealt on two Days, the one outcome targeting exists to prevent.
      // So only a row that is still `pending` is approved, and routing reads
      // the STORED target, never the one the client passed. It is also the
      // idempotency key: a repeat of a call whose response was lost reports
      // `stale` with the stored Day and writes nothing.
      if (row === undefined) {
        placements.push({ itemId: it.id, dayIndex: null, retained: false, outcome: 'missing' });
        continue;
      }
      if (row.status !== 'pending') {
        // Report where it ALREADY stands, and say plainly that this call did
        // not approve it. Only a live `active` row can be described as
        // scheduled at all.
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
      const targetDayIndex = row.targetDayIndex;
      // MALFORMED-CLASSIFICATION GUARD (#1070). Both guards throw, and an
      // uncaught throw here would abort the whole transaction, so ONE bad row
      // in an "Approve all" batch would fail every other still-valid row. It is
      // a fact about one row, decided from the caller's row alone, so it is
      // caught per row and reported as that row's outcome. Every OTHER failure
      // mode still aborts the batch: a failed read or a rejected commit is a
      // fact about the transaction, and finishing the remaining rows after one
      // would report placements the commit may never make.
      let difficulty: 'main' | 'easy';
      let spicy: boolean;
      try {
        difficulty = approvalDifficulty(it.pool, row.pool);
        spicy = approvalSpicy(it.spicy, row.spicy, difficulty);
      } catch (error) {
        placements.push({
          itemId: it.id,
          dayIndex: null,
          retained: false,
          outcome: 'malformed',
          reason: malformedReason(error),
        });
        continue;
      }
      const base = {
        status: 'active' as const,
        // Identity comes from the verified auth uid, never from the payload.
        approvedBy: uid,
        approvedAt,
        pool: persistedPool(difficulty),
        // Adult-content derivation and gating are main-pool only, so an Easy
        // classification clears a submitted/ticked spicy flag in this SAME
        // write. Exploratory writes the exact Admin-selected value too.
        spicy,
      };
      // A placement CLEARS any `retainedAt` already on the row rather than
      // merely not writing one: `tx.update` is a merge, and a marker left
      // behind would describe an active, DEALT Prompt as one that was retained.
      const placed = { ...base, retainedAt: deps.deleteField() };
      wrote = true;
      if (targetDayIndex === undefined) {
        // A PENDING row with no target is a player submission that lost one,
        // never an organiser Prompt meant for every Day (those are created
        // `active` and never enter this queue), so approval resolves the Day it
        // should have had. The exception is an Event with NO schedule at all,
        // where untargeted is the honest record: there are no Days.
        if (days.length === 0) {
          tx.update(ref, placed);
          placements.push({ itemId: it.id, dayIndex: null, retained: false, outcome: 'untargeted' });
          continue;
        }
        const resolved = defaultTargetDayIndex(days, approvedAt);
        if (resolved == null) {
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
        // every Day, so it is dealt nowhere — retention, reported as retention.
        // The value is left in place: guessing the Day would be inventing one.
        tx.update(ref, { ...base, retainedAt: approvedAt });
        placements.push({ itemId: it.id, dayIndex: null, retained: true, outcome: 'retained' });
        continue;
      }
      const routed = routeApprovalToDay(days, targetDayIndex, approvedAt);
      if (routed == null) {
        // Retained: the original target is LEFT in place. Clearing it would
        // make the Prompt untargeted, which reads as "every Day".
        tx.update(ref, { ...base, retainedAt: approvedAt });
        placements.push({ itemId: it.id, dayIndex: null, retained: true, outcome: 'retained' });
        continue;
      }
      tx.update(ref, { ...placed, targetDayIndex: routed });
      placements.push({ itemId: it.id, dayIndex: routed, retained: false, outcome: 'placed' });
    }
    if (wrote) {
      // THE FENCE (#813). `stampDaySnapshot` reads AND updates this document
      // inside its own transaction, so writing it here makes the two conflict
      // at the document level: if this approval commits first, the scheduler
      // retries and its `status == 'active'` query now lists the Prompt; if the
      // scheduler commits first, this attempt retries, sees `snapshotItemIds`,
      // and rolls forward or retains. Computed from the value already read, not
      // `FieldValue.increment`, so the fake surface stays SDK-free; nothing
      // reads the number for meaning, only the write matters. `days` is never
      // written here — a frozen Day is never mutated by an approval.
      const seq = typeof ev.approvalSeq === 'number' && Number.isFinite(ev.approvalSeq) ? ev.approvalSeq : 0;
      tx.update(eventRef, { approvalSeq: seq + 1 });
    }
    return placements;
  });
}

// --- The callable boundary --------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A document id: a non-empty string with no path separator, so it can never
 *  escape `events/{eventId}/items/{id}`. Length is bounded the way Firestore
 *  bounds ids. */
const isDocId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1500 && !value.includes('/');

/**
 * Narrow the untrusted payload to the wire contract. Reads ONLY `eventId` and
 * each item's `id`, `pool` and `spicy`: an `adminUid`, `approvedAt` or `now` in
 * the payload is never looked at, let alone honoured.
 */
export function parseApprovePromptsRequest(data: unknown): ApprovePromptsRequest {
  if (!isPlainObject(data)) throw new ApprovalRequestError('A request body is required.');
  if (!isDocId(data.eventId)) throw new ApprovalRequestError('eventId must be a non-empty id.');
  if (!Array.isArray(data.items)) throw new ApprovalRequestError('items must be an array.');
  if (data.items.length > MAX_APPROVE_PROMPTS_ITEMS) {
    throw new ApprovalRequestError(`items must hold at most ${MAX_APPROVE_PROMPTS_ITEMS} rows per call.`);
  }
  const seen = new Set<string>();
  const items: ApprovePromptsItem[] = [];
  for (const raw of data.items) {
    if (!isPlainObject(raw) || !isDocId(raw.id)) {
      throw new ApprovalRequestError('Every item needs a non-empty id.');
    }
    if (seen.has(raw.id)) throw new ApprovalRequestError('Item ids must be unique.');
    seen.add(raw.id);
    items.push({
      id: raw.id,
      ...(raw.pool !== undefined ? { pool: raw.pool } : {}),
      ...(raw.spicy !== undefined ? { spicy: raw.spicy } : {}),
    });
  }
  return { eventId: data.eventId, items };
}

/** Firestore's ABORTED (gRPC 10): the Admin SDK's retries were exhausted by
 *  contention. Recognised in every spelling the SDK layers use. */
function isFirestoreAborted(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 10 || code === '10') return true;
  return typeof code === 'string' && code.replaceAll('_', '-').toLowerCase() === 'aborted';
}

/**
 * The callable. Auth first, then App Check (enforced only when
 * `APPROVE_PROMPTS_APP_CHECK` is on, the same off-by-default posture as
 * `submitBugReport`), then the payload, then the core. Every failure maps to an
 * `HttpsError` whose message is a fixed server string — the Approvals queue's
 * AsyncButton shows `error.message`, so it is written for an admin to read and
 * never carries anything Firestore threw.
 */
export async function approvePromptsCallable(
  request: CallableRequest<unknown>,
  requireAppCheck: boolean,
  deps: ApprovePromptsDeps,
): Promise<ApprovePromptsResponse> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before approving Prompts.');
  if (requireAppCheck && !request.app) throw new HttpsError('failed-precondition', 'App Check is required.');
  let parsed: ApprovePromptsRequest;
  try {
    parsed = parseApprovePromptsRequest(request.data);
  } catch (error) {
    if (error instanceof ApprovalRequestError) throw new HttpsError('invalid-argument', error.message);
    throw error;
  }
  if (parsed.items.length === 0) return { placements: [] };
  try {
    const placements = await approvePromptsCore(deps, uid, parsed.eventId, parsed.items);
    return { placements };
  } catch (error) {
    if (error instanceof ApprovalPermissionError) {
      throw new HttpsError('permission-denied', 'Only an admin of this Event can approve its Prompts.');
    }
    if (error instanceof ApprovalClosedError) {
      throw new HttpsError('failed-precondition', 'This Event is closed; approvals are frozen.');
    }
    if (isFirestoreAborted(error)) {
      throw new HttpsError('aborted', 'Another change collided with this approval; try again.');
    }
    deps.logger?.error('approvePrompts failed', { code: firestoreErrorCodeForLog(error) });
    throw new HttpsError('internal', 'Approval failed; try again.');
  }
}
