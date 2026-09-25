import {
  getDocsFromServer,
  query,
  runTransaction,
  where,
  writeBatch,
  type DocumentReference,
} from 'firebase/firestore';
import { db, EVENT_ID } from '../firebase';
import { blockPairId, blockPairRef, blockPairsCol, blockRef, blocksCol } from './paths';
import type { BlockDoc, BlockPairDoc } from '../types';

// Player blocking (#689, specs/player-blocking.md, ADR 0016): the write flows
// and the pure hidden-set derivations. No React, no callable: every write is
// ONE atomic client commit whose result the rules check with `existsAfter`, so
// no single commit can break Invariant I (the pair exists iff at least one
// direction record does). A block is an optimistic `writeBatch` that queues
// durably offline; every unblock attempt (up to three per call) is a
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

/**
 * Block `target`: set the caller's direction record and the pair record in one
 * batch. IDEMPOTENT under the rules (a re-set is a `createdAt` refresh on the
 * direction and a no-op on the deterministic pair), so the caller needs no
 * "already blocked" readiness gate: a blind set from a second device, or before
 * the own-blocks listener has loaded, lands the same way. Rejects online on a
 * rules denial; offline the batch pends durably (ADR 0006) and the promise
 * settles on reconnect.
 */
export function blockPlayer({ me, target, eventId = EVENT_ID }: BlockPairParams): Promise<void> {
  assertPair(me, target);
  const direction: BlockDoc = { ownerUid: me, targetUid: target, eventId, createdAt: Date.now() };
  const pair: BlockPairDoc = { uids: me < target ? [me, target] : [target, me], eventId };
  const batch = writeBatch(db);
  batch.set(blockRef(me, target, eventId), direction);
  batch.set(blockPairRef(me, target, eventId), pair);
  return batch.commit();
}

export interface UnblockResult {
  /** True when the other Player has blocked the caller too, so the pair stays. */
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
function deleteOnServer(refs: readonly DocumentReference<unknown>[]): Promise<void> {
  return runTransaction(db, async (tx) => {
    for (const ref of refs) tx.delete(ref);
  });
}

/**
 * Unblock `target`. Only the blocker can reverse a block, and the pair must
 * leave with the caller's direction record UNLESS the other direction still
 * stands. The flow is up to four server-only commits: first
 * `{delete direction, delete pair}`; only on a permission denial (which the
 * rules issue exactly when the other direction exists), `{delete direction}`
 * alone; if THAT is denied, the full delete once more; and after a landed
 * direction-only retry, one best-effort `{delete pair}` (followed, if it is
 * denied, by one server listing of the caller's pairs to report `stillHidden`
 * truly).
 * Each is described below. The direction-only retry succeeding is
 * how the caller learns the block was mutual; reciprocity makes that
 * disclosure inherent, and the copy says so. Any other error rethrows. Every
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
  const direction = blockRef(me, target, eventId);
  const pair = blockPairRef(me, target, eventId);
  try {
    await deleteOnServer([direction, pair]);
    return { stillHidden: false };
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
  }
  try {
    await deleteOnServer([direction]);
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    // The other direction left between our first two attempts (an interleaved
    // mutual unblock, CodeRabbit on #1300), so the rules now require the pair
    // to leave WITH ours: the first attempt's shape, once more.
    await deleteOnServer([direction, pair]);
    return { stillHidden: false };
  }
  try {
    await deleteOnServer([pair]);
    return { stillHidden: false };
  } catch {
    // Denied is the ordinary mutual case, but a MISSING pair is denied too
    // (a direction that had lost its pair to a concurrent delete; Codex P2 on
    // #1300), so ask the server whether the pair still stands rather than
    // assume it. Not by a direct get: the read arm tests the caller against
    // `resource.data.uids`, so a get of a MISSING pair is denied exactly like
    // the delete was (CodeRabbit on #1300). The caller's own pair listing (the
    // provider's query, which the rules allow whatever it contains) answers
    // for a missing pair too. An unreadable answer keeps the conservative `true`.
    try {
      const mine = await getDocsFromServer(query(blockPairsCol(eventId), where('uids', 'array-contains', me)));
      const id = blockPairId(me, target);
      return { stillHidden: mine.docs.some((row) => row.id === id) };
    } catch {
      return { stillHidden: true };
    }
  }
}

/**
 * Remove a pair that no direction record backs any more, if that is what it
 * is. The durable half of the concurrent-mutual-unblock cleanup (Codex P1 on
 * #1300): `unblockPlayer`'s own cleanup is best-effort, so if both parties'
 * direction-only retries land and both cleanups fail (a dropped connection, a
 * lost acknowledgement), the provider calls this once per session for every
 * pair it sees. It is SAFE to call on any pair: the rules allow the delete
 * only when neither direction exists server-side, so an ordinary pair (either
 * party's direction standing) is simply denied, which is the common outcome
 * and changes nothing on the device (`deleteOnServer` is server-only).
 * Resolves true when a pair was removed; never rejects.
 */
export async function reconcileOrphanPair({ me, target, eventId = EVENT_ID }: BlockPairParams): Promise<boolean> {
  try {
    assertPair(me, target);
    await deleteOnServer([blockPairRef(me, target, eventId)]);
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
 * after any cache snapshot (a reconnection), and on any server-confirmed
 * snapshot from which a pair has disappeared; it lists the
 * caller's own directions FROM THE SERVER and re-sets the pair (server-only)
 * for every target missing from `knownCounterparts`. The pair arm allows that
 * only while the caller's direction exists, and the content is deterministic,
 * so a stale view can only cost a no-op write. Resolves the number of pairs
 * restored. A denied re-set (the direction left meanwhile) is skipped; a
 * failed listing or any other re-set failure rejects once every target has
 * been tried, so the provider re-arms the repair for its next server snapshot.
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
  const own = await getDocsFromServer(query(blocksCol(eventId), where('ownerUid', '==', me)));
  let restored = 0;
  let transient: unknown = null;
  for (const row of own.docs) {
    const target = row.data().targetUid;
    if (typeof target !== 'string' || target === me || knownCounterparts.has(target)) continue;
    const pair: BlockPairDoc = { uids: me < target ? [me, target] : [target, me], eventId };
    try {
      await runTransaction(db, async (tx) => {
        tx.set(blockPairRef(me, target, eventId), pair);
      });
      restored += 1;
    } catch (err) {
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
 * The published hidden set for one snapshot. A snapshot with pending local
 * writes publishes `current ∪ lastCommitted` (the set from the latest snapshot
 * without pending writes), and a settled one publishes `current`. So a
 * pending BLOCK hides immediately (it is in `current`) and no pending local
 * write ever reveals anyone. This is defence in depth, not the unblock
 * guarantee: the SDK does not flag a query snapshot whose only pending write
 * REMOVED a document, so a pending pair delete could not be seen here at all.
 * That is why `unblockPlayer` never deletes locally (`deleteOnServer`), and
 * the pair leaves the viewer's query only once the server has accepted it.
 */
export function computeHiddenSet(
  current: ReadonlySet<string>,
  lastCommitted: ReadonlySet<string>,
  hasPendingWrites: boolean,
): ReadonlySet<string> {
  if (!hasPendingWrites) return current;
  const union = new Set(current);
  for (const uid of lastCommitted) union.add(uid);
  return union;
}
