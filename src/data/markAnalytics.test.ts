import { describe, expect, it } from 'vitest';
import type { Cell } from '../types';
import { stampMarkAnalyticsTransition } from './markAnalytics';

const cell = (overrides: Partial<Cell> = {}): Cell => ({
  index: 4,
  itemId: 'prompt',
  text: 'Prompt',
  free: false,
  marked: false,
  markedAt: null,
  ...overrides,
});

const context = {
  eventId: 'event',
  uid: 'player',
  dayIndex: 2,
  boardSeed: 42,
  cellIndex: 4,
};

describe('persisted direct-mark analytics identities', () => {
  it('gives concurrent stale writers of the same edge one durable id', () => {
    const before = [cell()];
    const first = stampMarkAnalyticsTransition({ before, after: [cell({ marked: true, markedAt: 1 })], ...context });
    const second = stampMarkAnalyticsTransition({ before, after: [cell({ marked: true, markedAt: 2 })], ...context });

    expect(first.transitionId).toBe(second.transitionId);
    expect(first.cells[0]).toMatchObject({ markAnalyticsGeneration: 1, markAnalyticsId: first.transitionId });
  });

  it('gives a later reversal a new id', () => {
    const marked = cell({ marked: true, markedAt: 1, markAnalyticsGeneration: 1 });
    const result = stampMarkAnalyticsTransition({ before: [marked], after: [cell({ marked: false })], ...context });

    expect(result.transitionId).toContain(':2:unmark');
    expect(result.cells[0]).toMatchObject({ markAnalyticsGeneration: 2, markAnalyticsId: result.transitionId });
  });
});
