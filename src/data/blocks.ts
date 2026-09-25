import { writeBatch } from 'firebase/firestore';
import { db, EVENT_ID } from '../firebase';
import { blockPairId, blockPairRef, blockRef } from './paths';
import type { BlockDoc, BlockPairDoc } from '../types';

// Player blocking (#689, specs/player-blocking.md, ADR 0016): the write flows
// and the pure hidden-set derivations. No React, no callable: every write is
// ONE client `writeBatch` whose result the rules check with `existsAfter`, so
// no committed state can violate Invariant I (the pair exists iff at least one
// direction record does). Firestore-free, React-free derivations live here so
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
 * Unblock `target`. Only the blocker can reverse a block, and the pair must
 * leave with the caller's direction record UNLESS the other direction still
 * stands, so the flow is two attempts: first `{delete direction, delete pair}`,
 * and, only on a permission denial (which the rules issue exactly when the
 * other direction exists), `{delete direction}` alone. The retry succeeding is
 * how the caller learns the block was mutual; reciprocity makes that
 * disclosure inherent, and the copy says so. Any other error rethrows.
 *
 * If the retry is itself denied, the other direction left between the two
 * attempts (the other party unblocked in between), so the rules now require
 * the pair to go with ours: one more `{delete direction, delete pair}`, whose
 * success means nothing stays hidden. Any error there rethrows.
 *
 * After a landed retry, ONE best-effort `{delete pair}`, for the concurrent mutual unblock
 * (Codex P2 on #1300): if both parties unblock at once, both first attempts
 * are denied and both direction-only retries can land, each authorized while
 * the other direction still stood, leaving a pair with no direction. The
 * rules let either party delete a pair once neither direction exists, and
 * whichever retry commits LAST runs this after both directions are gone, so
 * the orphan is removed. While the other direction still stands (the ordinary
 * mutual case) the rules deny it and the result stays `stillHidden: true`;
 * any failure here is swallowed, because the caller's own unblock has
 * already landed.
 */
export async function unblockPlayer({
  me,
  target,
  eventId = EVENT_ID,
}: BlockPairParams): Promise<UnblockResult> {
  assertPair(me, target);
  const both = writeBatch(db);
  both.delete(blockRef(me, target, eventId));
  both.delete(blockPairRef(me, target, eventId));
  try {
    await both.commit();
    return { stillHidden: false };
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
  }
  const directionOnly = writeBatch(db);
  directionOnly.delete(blockRef(me, target, eventId));
  try {
    await directionOnly.commit();
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    // The other direction left between our two attempts (an interleaved
    // mutual unblock, CodeRabbit on #1300), so the rules now require the pair
    // to leave WITH ours: the first attempt's shape, once more.
    const again = writeBatch(db);
    again.delete(blockRef(me, target, eventId));
    again.delete(blockPairRef(me, target, eventId));
    await again.commit();
    return { stillHidden: false };
  }
  const orphanedPair = writeBatch(db);
  orphanedPair.delete(blockPairRef(me, target, eventId));
  try {
    await orphanedPair.commit();
    return { stillHidden: false };
  } catch {
    return { stillHidden: true };
  }
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
 * writes publishes `current ∪ lastCommitted` (the set from the latest
 * server-acked snapshot), and a settled one publishes `current`. So a pending
 * BLOCK hides immediately (it is in `current`), a pending UNBLOCK reveals
 * nobody until the server acks it, and a DENIED unblock (the mutual case,
 * where the rules refuse the pair delete) never flashes the counterpart back
 * in: the optimistic local delete is rolled back before any committed snapshot
 * could drop them from `lastCommitted`. Offline, a pending unblock therefore
 * stays hidden until reconnect, which the spec records.
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
