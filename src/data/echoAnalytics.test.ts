import { describe, expect, it } from 'vitest';
import type { Cell } from '../types';
import { applyEchoes } from '../game/logic';
import { echoAnalyticsId, echoAnalyticsIds, stampEchoAnalyticsTransitions } from './echoAnalytics';

const cell = (overrides: Partial<Cell> = {}): Cell => ({
  index: 4,
  itemId: 'shared',
  text: 'Shared Prompt',
  free: false,
  marked: false,
  markedAt: null,
  ...overrides,
});

function stamped(cells: Cell[], changed: Cell[]): Cell[] {
  return stampEchoAnalyticsTransitions({
    cells,
    changed,
    eventId: 'event',
    uid: 'player',
    dayIndex: 2,
    boardSeed: 42,
    trigger: 'mark',
  });
}

describe('persisted Echo analytics identities', () => {
  it('gives a later re-echo a new identity after a reversal, rather than suppressing it behind a high-water mark', () => {
    const first = applyEchoes([cell()], new Set(['shared']), 1);
    const firstCells = stamped(first.cells, first.cells);
    const firstId = echoAnalyticsIds(firstCells)[0];

    // `computeMark` clears the old event identity when a player explicitly
    // unmarks, but preserves the generation so a later earned Echo is new.
    const manuallyUnmarked = [
      cell({ echoGeneration: firstCells[0].echoGeneration, echo: undefined, echoAnalyticsId: undefined }),
    ];
    const second = applyEchoes(manuallyUnmarked, new Set(['shared']), 2);
    const secondCells = stamped(second.cells, second.cells);

    expect(echoAnalyticsIds(secondCells)).toEqual([expect.any(String)]);
    expect(echoAnalyticsIds(secondCells)[0]).not.toBe(firstId);
    expect(secondCells[0].echoGeneration).toBe(2);
  });

  it('does not mint an identity for a reshuffle echo that was not net new', () => {
    const echoed = applyEchoes([cell()], new Set(['shared']), 1);
    const suppressed = stampEchoAnalyticsTransitions({
      cells: echoed.cells,
      changed: echoed.cells,
      eventId: 'event',
      uid: 'player',
      dayIndex: 2,
      boardSeed: 42,
      trigger: 'reshuffle',
      limit: 0,
    });
    expect(echoAnalyticsIds(suppressed)).toEqual([]);
  });

  it('replaces an old identity when a non-Board reversal re-earns an Echo', () => {
    const prior = echoAnalyticsId({
      eventId: 'event',
      uid: 'player',
      dayIndex: 2,
      boardSeed: 42,
      cellIndex: 4,
      generation: 1,
    });
    const reechoed = stamped(
      [cell({ echo: true, echoGeneration: 2, echoAnalyticsId: prior, echoAnalyticsTrigger: 'mark' })],
      [cell({ echo: true, echoGeneration: 2, echoAnalyticsId: prior, echoAnalyticsTrigger: 'mark' })],
    );

    expect(echoAnalyticsIds(reechoed)).toEqual([expect.stringContaining(':2')]);
    expect(echoAnalyticsIds(reechoed)[0]).not.toBe(prior);
  });
});
