// The Event's gameplay lifecycle as this DEVICE last observed it, in memory
// (#1158, specs/post-sailing-archive.md § "The surfaces"). One slot, one owner:
// the shared Event subscription WRITES it (`useEventDoc`, through the same
// observer seam that records a confirmed archive), and `AuthContext`'s deal gate
// READS it — so the join can be resumed when an Admin reopens play.
//
// It exists because the deal gate has no Event subscription of its own and must
// not grow one. `AuthProvider` sits above every route, so opening a second
// listener there would duplicate the document every route already holds, and
// would make the whole provider — and the ten suites that mount it — depend on
// Firestore. The observer seam is already the place a fact about the Event is
// recorded for whatever route sees it first (`./archiveConfirmation`), so this
// is that pattern a second time: written from the snapshot callback, read as
// plain state, with no SDK on the reading side at all.
//
// Deliberately IN MEMORY rather than on `localStorage` like its sibling. The
// archive confirmation answers "has this device ever seen the flip committed?",
// which must survive a reload; this answers "is play open right now?", and a
// stale answer restored from a previous session is exactly the thing the join's
// own server read already refuses to act on. A fresh page load starts at the
// same `'open'` default a cold visit reads.
import type { SnapshotOrigin } from './archiveConfirmation';

/**
 * Whether the Event takes gameplay writes. `'closed'` covers BOTH halves of the
 * freeze — the reversible quiesce and the archived flip — because the rules deny
 * the join on both and the deal gate cares about nothing finer.
 */
export type EventPlayPhase = 'open' | 'closed';

/**
 * The last fully server-committed phase observed, and the Event it was observed
 * for. `null` until a snapshot lands; an Event nobody has observed reads `'open'`
 * (see `observedEventPlayPhase`).
 */
let observed: { eventId: string; phase: EventPlayPhase } | null = null;

const listeners = new Set<() => void>();

/**
 * Subscribe to phase changes, in the `useSyncExternalStore` shape. The callback
 * takes no argument on purpose: the value is read back per Event through
 * `observedEventPlayPhase`, so one notification serves readers of any Event.
 */
export function subscribeEventPlayPhase(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The phase observed for `eventId`, defaulting to `'open'`.
 *
 * ABSENT MEANS OPEN, the same default `isEventArchived` / `isEventArchiving`
 * take for a missing field, and for the same reason: every Event is open until
 * something says otherwise, and a cold visit that has not yet received a
 * snapshot must behave exactly as it does today. A phase observed for a
 * DIFFERENT Event is not evidence about this one, so it reads as open too.
 */
export function observedEventPlayPhase(eventId: string): EventPlayPhase {
  return observed?.eventId === eventId ? observed.phase : 'open';
}

/**
 * Record what a snapshot said, from the Event subscription's observer.
 *
 * Only a FULLY SERVER-COMMITTED snapshot is evidence — `fromCache` false and
 * `hasPendingWrites` false — the same three-flag rule the Card tab's redirect,
 * the join's own decline and the archive confirmation already hold themselves
 * to (Codex P2, PR #1157 rounds 6, 8 and 9). A cached `archiving: true` can
 * describe a quiesce another Admin has since lifted, and an Admin's own
 * optimistic close is undecided until the rules answer; treating either as a
 * phase change would either strand a join or fire a resume for a close that
 * rolled back.
 *
 * `closed` is passed in rather than derived here so this module stays a slot
 * with no opinions: the caller spells the predicate pair the rest of the client
 * spells (`isEventArchived(event) || isEventArchiving(event)`).
 */
export function recordEventPlayPhase(
  eventId: string,
  closed: boolean,
  origin: SnapshotOrigin,
): void {
  if (origin.fromCache || origin.hasPendingWrites) return;
  const phase: EventPlayPhase = closed ? 'closed' : 'open';
  if (observed?.eventId === eventId && observed.phase === phase) return;
  observed = { eventId, phase };
  for (const listener of listeners) listener();
}

/**
 * Forget every observation. For tests only — the slot is module state, and a
 * suite that leaves a closed Event behind would hand the next test a phase it
 * never set up.
 */
export function resetEventPlayPhaseForTests(): void {
  observed = null;
}
