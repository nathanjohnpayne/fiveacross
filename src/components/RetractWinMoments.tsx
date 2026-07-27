import { useEffect } from 'react';
import { onSnapshot } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { useEventDoc } from '../hooks/useData';
import { boardRef, dayBoardRef } from '../data/paths';
import { createRetractionFallObserver } from '../data/moments';
import type { BoardDoc } from '../types';

/**
 * The route-independent retraction fall observer (#479) — the retraction twin of
 * `ConfirmWinMoments` (#41), mounted beside it at the app shell (OUTSIDE the tab
 * Routes) so it runs wherever the Player is.
 *
 * #467's retraction detectors live on the Card route: Board's fall observers
 * record an intent when a cell unmark drops a published win, and its cells
 * effect drains that intent from a server-committed snapshot. But a win can stop
 * standing while Board is UNMOUNTED — deleting a proof from the FEED tab unmarks
 * the backing cell, and an ADMIN rejecting a confirmed claim unmarks it on a
 * different write path entirely. When the Player later returns to the Card
 * route, Board BASELINES on the current (already-fallen) state rather than
 * observing a falling edge, so no intent is ever recorded and the published
 * BINGO/Blackout Moment stands in the Feed forever — exactly what #377 set out
 * to prevent, minus those entry points.
 *
 * This component closes that gap with the SAME edge discipline, not a wider
 * reconciliation: it subscribes to the Player's OWN board docs (each scheduled
 * Day's in daily mode, the single legacy board otherwise) and feeds every
 * snapshot to a per-board `createRetractionFallObserver`, whose entire
 * irreversibility posture lives in src/data/moments.ts where it is unit-tested:
 * committed-snapshots-only, first-committed-snapshot-is-baseline, fall →
 * (dropPendingWins + enqueueRetraction + drainRetractions) with the same `fell`
 * verdict shape Board's sites use. The observer also drains PARKED intents on
 * its baseline snapshot, which is what resumes a mid-retract account switch
 * when the owning account returns (#480).
 *
 * The subscriptions deliberately wait for the Event doc: which boards exist is a
 * function of the schedule, and watching the LEGACY board on a daily Event
 * would hand the day-less (unconditional) retraction arm evidence from a board
 * the daily writers do not use. `includeMetadataChanges` is load-bearing — a
 * server ack for an unmark usually delivers byte-identical cells, and without
 * metadata events the observer would never see the snapshot flip to
 * server-committed. An account switch re-keys the effect, so every observer
 * re-baselines under the new uid (conservative: falls before the switch-back
 * are the accepted residual, never guessed at).
 */
export default function RetractWinMoments() {
  const { user } = useAuth();
  const uid = user?.uid;
  const { data: event } = useEventDoc(!!uid);
  const days = event?.days;
  const hasDays = (days?.length ?? 0) > 0;
  // Effect-key the CONTENT of the schedule (canonical DayDef.index values, the
  // #447 precedent), not the array identity — the event doc re-renders freely.
  const fanKey = days?.map((d) => d.index).join(',') ?? '';
  const eventKnown = event != null;

  useEffect(() => {
    if (!uid || !eventKnown) return;
    const targets = hasDays
      ? (days ?? []).map((d) => ({ dayIndex: d.index as number | undefined, ref: dayBoardRef(d.index, uid) }))
      : [{ dayIndex: undefined as number | undefined, ref: boardRef(uid) }];
    const unsubs = targets.map(({ dayIndex, ref }) => {
      const observe = createRetractionFallObserver(uid, dayIndex);
      return onSnapshot(
        ref,
        { includeMetadataChanges: true },
        (snap) => {
          const data = snap.exists() ? (snap.data() as BoardDoc) : null;
          observe({
            fromCache: snap.metadata.fromCache,
            hasPendingWrites: snap.metadata.hasPendingWrites,
            boardUid: data?.uid,
            cells: data?.cells ?? [],
          });
        },
        () => {
          /* permission-denied (signed out mid-flight) — the observer simply
             stops seeing snapshots; nothing enqueues, nothing retracts. */
        },
      );
    });
    return () => unsubs.forEach((u) => u());
    // `days` participates via fanKey (content, not identity) — see useMyDayBoards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, eventKnown, hasDays, fanKey]);

  return null;
}
