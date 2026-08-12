import type { Cell } from '../types';

export type EchoAnalyticsTrigger = 'deal' | 'reshuffle' | 'mark' | 'open_reconcile' | 'admin_confirm';

export type EchoAnalyticsTransition = { id: string; trigger: EchoAnalyticsTrigger };

/**
 * Persisted identity for one countable Echo Mark transition. Analytics delivery
 * is intentionally at-least-once: a tab can die after Firestore accepts its
 * cells but before its post-commit continuation runs, and another device can
 * open the same board. Downstream reconciliation therefore deduplicates on this
 * identity instead of trusting device-local storage or event delivery order.
 */
export function echoAnalyticsId(params: {
  eventId: string;
  uid: string;
  dayIndex: number;
  boardSeed: number | undefined;
  cellIndex: number;
  generation: number;
}): string {
  const { eventId, uid, dayIndex, boardSeed, cellIndex, generation } = params;
  return `echo-v1:${eventId}:${uid}:${dayIndex}:${boardSeed ?? 'legacy'}:${cellIndex}:${generation}`;
}

/**
 * Attach durable analytics identities to selected newly-echoed cells. The
 * caller supplies the before/after diff, so old echoed cells are never minted
 * retroactively. `limit` is used by reshuffle: replacement echoes only count
 * up to the card's net-new marked total.
 */
export function stampEchoAnalyticsTransitions(params: {
  cells: Cell[];
  changed: Cell[];
  eventId: string;
  uid: string;
  dayIndex: number;
  boardSeed: number | undefined;
  trigger: EchoAnalyticsTrigger;
  limit?: number;
}): Cell[] {
  const limit = params.limit ?? Number.POSITIVE_INFINITY;
  if (limit <= 0) return params.cells;
  const candidates = new Set(
    params.changed
      .filter(
        (cell) =>
          cell.echo === true &&
          typeof cell.echoGeneration === 'number' &&
          Number.isSafeInteger(cell.echoGeneration) &&
          cell.echoGeneration > 0 &&
          // A reversal can retain a prior cell's ID if it passed through a
          // non-Board writer (for example, proof deletion). The generation is
          // the transition identity, so replace a stale ID rather than
          // suppressing the newly-earned Echo behind it.
          cell.echoAnalyticsId !==
            echoAnalyticsId({
              eventId: params.eventId,
              uid: params.uid,
              dayIndex: params.dayIndex,
              boardSeed: params.boardSeed,
              cellIndex: cell.index,
              generation: cell.echoGeneration,
            }),
      )
      .sort((a, b) => a.index - b.index)
      .slice(0, limit)
      .map((cell) => cell.index),
  );
  if (candidates.size === 0) return params.cells;
  return params.cells.map((cell) => {
    if (!candidates.has(cell.index)) return cell;
    return {
      ...cell,
      echoAnalyticsId: echoAnalyticsId({
        eventId: params.eventId,
        uid: params.uid,
        dayIndex: params.dayIndex,
        boardSeed: params.boardSeed,
        cellIndex: cell.index,
        generation: cell.echoGeneration as number,
      }),
      echoAnalyticsTrigger: params.trigger,
    };
  });
}

/** Stable identities carried by a board's countable Echo Mark cells. */
export function echoAnalyticsIds(cells: readonly Cell[]): string[] {
  return echoAnalyticsTransitions(cells).map((transition) => transition.id);
}

/** Persisted identity plus the propagation path that originally minted it. */
export function echoAnalyticsTransitions(cells: readonly Cell[]): EchoAnalyticsTransition[] {
  return cells
    .flatMap((cell) => {
      if (typeof cell.echoAnalyticsId !== 'string' || cell.echoAnalyticsId.length === 0) return [];
      const trigger = cell.echoAnalyticsTrigger;
      if (
        trigger !== 'deal' &&
        trigger !== 'reshuffle' &&
        trigger !== 'mark' &&
        trigger !== 'open_reconcile' &&
        trigger !== 'admin_confirm'
      ) {
        return [];
      }
      return [{ id: cell.echoAnalyticsId, trigger }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Ship one event per durable transition. Duplicate delivery is deliberate and
 * safe: downstream reconciliation groups by `transitionId`, not raw event rows.
 */
export async function trackEchoTransitions(params: {
  transitions: readonly EchoAnalyticsTransition[];
  uid: string;
  dayIndex: number;
}): Promise<void> {
  if (params.transitions.length === 0) return;
  const { track } = await import('../analytics');
  for (const transition of params.transitions) {
    track('echo_mark', {
      trigger: transition.trigger,
      uid: params.uid,
      dayIndex: params.dayIndex,
      count: 1,
      transitionId: transition.id,
    });
  }
}
