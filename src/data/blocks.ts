import {
  getDocsFromServer,
  query,
  runTransaction,
  where,
  writeBatch,
  type DocumentReference,
} from 'firebase/firestore';
import { db, EVENT_ID, auth } from '../firebase';
import { awaitPrivateFirestore } from '../privateFirestore';
import { blockPairId, blockPairRef, blockPairsCol, blockRef, blocksCol } from './paths';
import type { BlockDoc, BlockPairDoc } from '../types';

// Player blocking (#689, specs/player-blocking.md, ADR 0016): the write flows
// and the pure hidden-set derivations. No React, no callable: every write is
// ONE atomic client commit whose result the rules check with `existsAfter`, so
// no single commit can break Invariant I (the pair exists iff at least one
// direction record does). A block is an optimistic `writeBatch` that queues
// durably offline; every unblock commit (at most three per call) is a
// server-only `runTransaction` that needs a connection. Concurrent commits
// can still leave one of two states the rules cannot rule out: a pair with no
// direction (two concurrent direction-only unblocks), cleaned up by
// `unblockPlayer` and durably by `reconcileOrphanPair`; and a direction with
// no pair (a block racing a pair delete), restored durably by
// `repairMissingPairs`. Firestore-free, React-free derivations live here so
// the provider (src/hooks/useBlocks.tsx) and its tests share one definition.

export { blockPairId };

export interface BlockPairParams {
  /** The caller (== auth.uid; the rules bind the direction record to it). */
  me: string;
  /** The Player being blocked or unblocked. */
  target: string;
  /** The acted Event, captured once by the caller; defaults to the live binding. */
  eventId?: string;
}

function assertPair(me: string, target: string): void {
  if (!me || !target) throw new Error('[blocks] both uids are required');
  if (me === target) throw new Error('[blocks] a Player cannot block themselves');
  if (target === 'system') throw new Error('[blocks] server-written Moments have no Player to block');
}


// The durable blind batch and private memory listener are separate instances.
// Relay only this process's pending intent; it cannot establish cold readiness,
// survives no reload, and is retired with its viewer/Event scope.
const pendingBlockIntents = new Map<string, Map<object, { target: string; acknowledged: boolean; observed: boolean }>>();
const pendingBlockSnapshots = new Map<string, ReadonlySet<string>>();
const pendingBlockListeners = new Set<() => void>();
const NO_PENDING_BLOCKS: ReadonlySet<string> = new Set();
const pendingBlockKey = (uid: string, eventId: string) => JSON.stringify([eventId, uid]);
function publishPendingBlocks(key: string): void {
  const intents = pendingBlockIntents.get(key);
  if (intents?.size) pendingBlockSnapshots.set(key, new Set([...intents.values()].map((intent) => intent.target)));
  else { pendingBlockIntents.delete(key); pendingBlockSnapshots.delete(key); }
  for (const listener of pendingBlockListeners) listener();
}
export function subscribePendingBlocks(listener: () => void): () => void {
  pendingBlockListeners.add(listener);
  return () => { pendingBlockListeners.delete(listener); };
}
export function pendingBlockTargets(uid: string, eventId: string): ReadonlySet<string> {
  return pendingBlockSnapshots.get(pendingBlockKey(uid, eventId)) ?? NO_PENDING_BLOCKS;
}
/** A server answer bridges batch ACK to named-memory listener visibility. */
export function observeConfirmedBlockTargets(uid: string, eventId: string, hidden: ReadonlySet<string>): void {
  const key = pendingBlockKey(uid, eventId);
  const intents = pendingBlockIntents.get(key);
  if (!intents) return;
  let changed = false;
  for (const [token, intent] of intents) {
    if (hidden.has(intent.target)) {
      intent.observed = true;
      if (intent.acknowledged) { intents.delete(token); changed = true; }
    }
  }
  if (changed) publishPendingBlocks(key);
}
/** Leaving a logical viewer/Event cannot transfer unfinished UI intent back. */
export function retirePendingBlocks(uid: string, eventId: string): void {
  const key = pendingBlockKey(uid, eventId);
  if (pendingBlockIntents.delete(key)) publishPendingBlocks(key);
}

/** The single shell provider's committed scope retains only its own relay.
 * Unmount alone is not a scope transition; a same-scope remount still needs
 * unfinished intent until the independent memory listener observes the batch. */
export function retirePendingBlocksOutsideScope(uid: string | null, eventId: string): void {
  const retained = uid === null ? null : pendingBlockKey(uid, eventId);
  for (const key of pendingBlockIntents.keys()) {
    if (key !== retained) { pendingBlockIntents.delete(key); publishPendingBlocks(key); }
  }
}

/**
 * Block `target`: set the caller's direction record and the pair record in one
 * batch. IDEMPOTENT under the rules (a re-set is a `createdAt` refresh on the
 * direction and a no-op on the deterministic pair), so the caller needs no
 * "already blocked" readiness gate: a blind set from a second device, or before
 * the own-blocks listener has loaded, lands the same way. Rejects online on a
 * rules denial; offline the batch pends durably (ADR 0006) and the promise
 * settles on reconnect. An in-process relay preserves same-session hiding
 * only for a viewer whose memory pair set was already server-confirmed; an
 * ACK retains that target until the memory listener observes it.
 */
export function blockPlayer({ me, target, eventId = EVENT_ID }: BlockPairParams): Promise<void> {
  assertPair(me, target);
  const direction: BlockDoc = { ownerUid: me, targetUid: target, eventId, createdAt: Date.now() };
  const pair: BlockPairDoc = { uids: me < target ? [me, target] : [target, me], eventId };
  const batch = writeBatch(db);
  batch.set(blockRef(me, target, eventId), direction);
  batch.set(blockPairRef(me, target, eventId), pair);
  const commit = batch.commit();
  const key = pendingBlockKey(me, eventId);
  const token = {};
  const intent = { target, acknowledged: false, observed: false };
  const intents = pendingBlockIntents.get(key) ?? new Map();
  intents.set(token, intent);
  pendingBlockIntents.set(key, intents);
  publishPendingBlocks(key);
  return commit.then(() => {
    // A retired scope cannot be reintroduced by an old completion.
    if (pendingBlockIntents.get(key)?.get(token) !== intent) return;
    intent.acknowledged = true;
    if (intent.observed) { intents.delete(token); publishPendingBlocks(key); }
  }, (error: unknown) => {
    if (pendingBlockIntents.get(key)?.get(token) === intent) { intents.delete(token); publishPendingBlocks(key); }
    throw error;
  });
}

export interface UnblockResult {
  /**
   * True when the pair still stood on the server after the caller's own
   * direction left (usually because the other Player has blocked the caller
   * too, though an orphaned pair that no direction backs reads the same), OR,
   * conservatively, when that could not be confirmed (a failed cleanup whose
   * follow-up listing also failed). False means the pair is known to be gone.
   * So `true` is not proof of a mutual block; the provider's pair listener,
   * not this flag, decides what renders.
   */
  stillHidden: boolean;
}

/**
 * Delete `refs` in one SERVER-ONLY commit. A `runTransaction` (here with no
 * reads) is never applied to the local cache before the server accepts it,
 * unlike a `writeBatch`, whose deletes are optimistic. That matters for the
 * pair: a pending local delete drops the pair from the viewer's query, and the
 * SDK derives a query snapshot's `hasPendingWrites` from the documents still
 * in the result, so the empty snapshot reads as settled (CodeRabbit on #1300)
 * and would reveal the counterpart until the server denied the mutual unblock,
 * indefinitely while offline. So every unblock write goes through here, and
 * an unblock needs a connection: offline it rejects instead of queueing.
 */
type BlockLease = Awaited<ReturnType<typeof awaitPrivateFirestore>>;
async function ownBlockLease(uid: string): Promise<BlockLease> {
  if (auth.currentUser?.uid !== uid) throw new Error('Private account changed.');
  const lease = await awaitPrivateFirestore(uid, true);
  lease.assertCurrent();
  return lease;
}

function deleteOnServer(refs: readonly DocumentReference<unknown>[], lease: BlockLease): Promise<void> {
  return lease.guard(() => runTransaction(lease.db, async (tx) => {
    lease.assertCurrent();
    for (const ref of refs) tx.delete(ref);
  }));
}

/**
 * Unblock `target`. Only the blocker can reverse a block, and the pair must
 * leave with the caller's direction record UNLESS the other direction still
 * stands. The flow is at most three server-only commits: first
 * `{delete direction, delete pair}`; only on a permission denial (which the
 * rules issue when the other direction exists, or when the pair is already
 * missing), `{delete direction}` alone; then EITHER, if that is denied, the
 * full delete once more, OR, if it landed, one best-effort `{delete pair}`
 * (followed, if that is denied or fails, by one server listing of the
 * caller's pairs to report `stillHidden`). Each is described below. A pair
 * confirmed still standing after the caller's direction left is how the
 * caller can infer the block was mutual, but `stillHidden: true` alone is not
 * proof (an orphaned pair, or an unanswered listing, reports the same; see
 * `UnblockResult`); reciprocity makes that disclosure inherent, and the copy
 * says so. Any other error rethrows. Every
 * attempt is a server-only commit (`deleteOnServer`), so nothing is hidden or
 * revealed locally before the server rules on it.
 *
 * If the retry is itself denied, the other direction left between the two
 * attempts (the other party unblocked in between), so the rules now require
 * the pair to go with ours: one more `{delete direction, delete pair}`, whose
 * success means nothing stays hidden. Any error there rethrows.
 *
 * After a landed retry, ONE best-effort `{delete pair}`, for the concurrent
 * mutual unblock (Codex P2 on #1300): if both parties unblock at once, both
 * first attempts are denied and both direction-only retries can land, each
 * authorized while the other direction still stood, leaving a pair with no
 * direction. The rules let either party delete a pair once neither direction
 * exists, and whichever retry commits LAST runs this after both directions are
 * gone, so the orphan is removed. While the other direction still stands (the
 * ordinary mutual case) the rules deny it and the result stays
 * `stillHidden: true`; any failure here is swallowed, because the caller's own
 * unblock has already landed.
 */
export async function unblockPlayer({
  me,
  target,
  eventId = EVENT_ID,
}: BlockPairParams): Promise<UnblockResult> {
  assertPair(me, target);
  const lease = await ownBlockLease(me);
  const direction = blockRef(me, target, eventId, lease.db);
  const pair = blockPairRef(me, target, eventId, lease.db);
  try {
    await deleteOnServer([direction, pair], lease);
    return { stillHidden: false };
  } catch (err) {
    lease.assertCurrent();
    if (!isPermissionDenied(err)) throw err;
  }
  try {
    await deleteOnServer([direction], lease);
  } catch (err) {
    lease.assertCurrent();
    if (!isPermissionDenied(err)) throw err;
    // The other direction left between our first two attempts (an interleaved
    // mutual unblock, CodeRabbit on #1300), so the rules now require the pair
    // to leave WITH ours: the first attempt's shape, once more.
    await deleteOnServer([direction, pair], lease);
    return { stillHidden: false };
  }
  try {
    await deleteOnServer([pair], lease);
    return { stillHidden: false };
  } catch {
    lease.assertCurrent();
    // Denied is the ordinary mutual case, but a MISSING pair is denied too
    // (a direction that had lost its pair to a concurrent delete; Codex P2 on
    // #1300), so ask the server whether the pair still stands rather than
    // assume it. Not by a direct get: the read arm tests the caller against
    // `resource.data.uids`, so a get of a MISSING pair is denied exactly like
    // the delete was (CodeRabbit on #1300). The caller's own pair listing (the
    // provider's query, which the rules allow whatever it contains) answers
    // for a missing pair too. An unreadable answer keeps the conservative `true`.
    try {
      const mine = await lease.guard(() => getDocsFromServer(query(blockPairsCol(eventId, lease.db), where('uids', 'array-contains', me))));
      const id = blockPairId(me, target);
      return { stillHidden: mine.docs.some((row) => row.id === id) };
    } catch {
      lease.assertCurrent();
      return { stillHidden: true };
    }
  }
}

/**
 * Remove a pair that no direction record backs any more, if that is what it
 * is. The durable half of the concurrent-mutual-unblock cleanup (Codex P1 on
 * #1300): `unblockPlayer`'s own cleanup is best-effort, so if both parties'
 * direction-only retries land and both cleanups fail (a dropped connection, a
 * lost acknowledgement), the provider calls this for every server-confirmed
 * pair it sees: once per app session, and again whenever that pair reappears
 * after a subscription's first server answer. It is SAFE to call on any pair: the rules allow the delete
 * only when neither direction exists server-side, so an ordinary pair (either
 * party's direction standing) is simply denied, which is the common outcome
 * and changes nothing on the device (`deleteOnServer` is server-only).
 * Resolves true when a pair was removed; never rejects.
 */
export async function reconcileOrphanPair({ me, target, eventId = EVENT_ID }: BlockPairParams): Promise<boolean> {
  try {
    assertPair(me, target);
    const lease = await ownBlockLease(me);
    await deleteOnServer([blockPairRef(me, target, eventId, lease.db)], lease);
    return true;
  } catch {
    return false;
  }
}

/**
 * The mirror of `reconcileOrphanPair`: restore the pair behind any of the
 * caller's OWN direction records that has lost it (Codex P1 on #1300). A block
 * batch and a concurrent pair delete (the other party unblocking a one-way
 * block, or an orphan reconcile) can each be authorized from the state before
 * the other, and if the delete lands last the direction is left with no pair,
 * so the block would stop hiding anyone. Reading the pair inside the deleting
 * transaction would not serialize them: the block's pair write is
 * content-identical, and Firestore does not advance a document's update time
 * for a write that changes nothing, so there is no version to conflict on.
 * Repair is therefore by reconciliation, from the one party who can see the
 * gap: the provider calls this with the server-confirmed pair counterparts on
 * the first server-confirmed snapshot of every subscription, on the first one
 * after any cache snapshot (a reconnection), and on the first one after any
 * snapshot (pending included) from which a pair has disappeared; it lists the
 * caller's own directions FROM THE SERVER and re-sets the pair (server-only)
 * for every target missing from `knownCounterparts`. The pair arm allows that
 * only while the caller's direction exists, and the content is deterministic,
 * so a stale view can only cost a no-op write. Resolves the number of pairs
 * restored. A denied re-set (the direction left meanwhile) is skipped; a
 * failed listing or any other re-set failure rejects once every target has
 * been tried, so the provider retries it on a backoff timer (a failed write
 * produces no snapshot to wait for) and on its next server snapshot.
 */
export async function repairMissingPairs({
  me,
  knownCounterparts,
  eventId = EVENT_ID,
}: {
  me: string;
  knownCounterparts: ReadonlySet<string>;
  eventId?: string;
}): Promise<number> {
  const lease = await ownBlockLease(me);
  const own = await lease.guard(() => getDocsFromServer(query(blocksCol(eventId, lease.db), where('ownerUid', '==', me))));
  let restored = 0;
  let transient: unknown = null;
  for (const row of own.docs) {
    lease.assertCurrent();
    const target = row.data().targetUid;
    if (typeof target !== 'string' || target === me || knownCounterparts.has(target)) continue;
    const pair: BlockPairDoc = { uids: me < target ? [me, target] : [target, me], eventId };
    try {
      await lease.guard(() => runTransaction(lease.db, async (tx) => {
        lease.assertCurrent();
        tx.set(blockPairRef(me, target, eventId, lease.db), pair);
      }));
      restored += 1;
    } catch (err) {
      lease.assertCurrent();
      // Denied: the direction left meanwhile, so there is nothing to restore.
      if (!isPermissionDenied(err)) transient = err;
    }
  }
  if (transient !== null) throw transient;
  return restored;
}

/** The FirebaseError code a rules denial carries, whatever the SDK build. */
export function isPermissionDenied(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'permission-denied';
}

/**
 * The counterpart of every pair that names `me`: the uids the viewer hides and
 * is hidden from. A malformed pair (not two strings, or one that does not name
 * the viewer) contributes nothing rather than throwing, so one bad document
 * can never blank the listener.
 */
export function hiddenUidsFromPairs(
  pairs: readonly Pick<BlockPairDoc, 'uids'>[],
  me: string,
): Set<string> {
  const hidden = new Set<string>();
  for (const pair of pairs) {
    const uids = Array.isArray(pair.uids) ? pair.uids : [];
    if (uids.length !== 2 || !uids.every((u) => typeof u === 'string')) continue;
    if (uids[0] === me) hidden.add(uids[1]);
    else if (uids[1] === me) hidden.add(uids[0]);
  }
  return hidden;
}

/**
 * The conservative union for an unsettled snapshot or in-process block
 * overlay: `current ∪ lastCommitted`. Only a server-confirmed snapshot without
 * pending writes can publish `current` alone. New batch intent is relayed from
 * the durable writer into an already-confirmed memory set; no pending/cache
 * answer establishes cold readiness or reveals a confirmed counterpart. This is defence in depth, not the unblock
 * guarantee: the SDK does not flag a query snapshot whose only pending write
 * REMOVED a document, so a pending pair delete could not be seen here at all.
 * That is why `unblockPlayer` never deletes locally (`deleteOnServer`), and
 * the pair leaves the viewer's query only once the server has accepted it.
 */
export function computeHiddenSet(
  current: ReadonlySet<string>,
  lastCommitted: ReadonlySet<string>,
  unsettled: boolean,
): ReadonlySet<string> {
  if (!unsettled) return current;
  const union = new Set(current);
  for (const uid of lastCommitted) union.add(uid);
  return union;
}
