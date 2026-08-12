import type { Cell } from '../types';

/**
 * Stable id for one direct Board toggle. It is deterministic from the prior
 * persisted generation, so two tabs that fold the same stale cell and commit
 * the same edge report the same id rather than two indistinguishable events.
 */
export function markAnalyticsId(params: {
  eventId: string;
  uid: string;
  dayIndex: number;
  boardSeed: number | undefined;
  cellIndex: number;
  generation: number;
  marked: boolean;
}): string {
  const { eventId, uid, dayIndex, boardSeed, cellIndex, generation, marked } = params;
  return `mark-v1:${eventId}:${uid}:${dayIndex}:${boardSeed ?? 'legacy'}:${cellIndex}:${generation}:${marked ? 'mark' : 'unmark'}`;
}

/** Stamp the direct-toggle identity into the same cells write as the edge. */
export function stampMarkAnalyticsTransition(params: {
  before: readonly Cell[];
  after: Cell[];
  eventId: string;
  uid: string;
  dayIndex: number;
  boardSeed: number | undefined;
  cellIndex: number;
}): { cells: Cell[]; transitionId: string | undefined } {
  const before = params.before.find((cell) => cell.index === params.cellIndex);
  const after = params.after.find((cell) => cell.index === params.cellIndex);
  if (!before || !after || before.marked === after.marked) {
    return { cells: params.after, transitionId: undefined };
  }
  const priorGeneration =
    typeof before.markAnalyticsGeneration === 'number' &&
    Number.isSafeInteger(before.markAnalyticsGeneration) &&
    before.markAnalyticsGeneration > 0
      ? before.markAnalyticsGeneration
      : 0;
  const generation = priorGeneration + 1;
  const transitionId = markAnalyticsId({
    eventId: params.eventId,
    uid: params.uid,
    dayIndex: params.dayIndex,
    boardSeed: params.boardSeed,
    cellIndex: params.cellIndex,
    generation,
    marked: after.marked,
  });
  return {
    cells: params.after.map((cell) =>
      cell.index === params.cellIndex ? { ...cell, markAnalyticsGeneration: generation, markAnalyticsId: transitionId } : cell,
    ),
    transitionId,
  };
}
