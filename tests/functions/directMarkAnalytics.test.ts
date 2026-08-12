import { describe, expect, it, vi } from 'vitest';
import { directMarkAnalyticsForWrite, recordDirectMarkAnalytics } from '../../functions/src/directMarkAnalytics';

const request = (overrides: Record<string, unknown> = {}) => ({
  id: 'request-1',
  cellIndex: 4,
  marked: true,
  mode: 'honor',
  ...overrides,
});
const board = (marked: boolean, directAnalyticsRequest: Record<string, unknown> = request()) => ({
  cells: { '4': { marked } },
  directAnalyticsRequest,
});

describe('server-observed direct-mark analytics', () => {
  it('records a queued direct mark from the committed board edge, not from an optimistic client verdict', () => {
    expect(
      directMarkAnalyticsForWrite({
        before: board(false, { id: 'old' }),
        after: board(true),
        uid: 'u1',
        dayIndex: 3,
        transitionId: 'cloud-event-1',
      }),
    ).toEqual({
      name: 'mark_square',
      source: 'pledge',
      mode: 'honor',
      marked: true,
      uid: 'u1',
      dayIndex: 3,
      transitionId: 'cloud-event-1',
    });
  });

  it('ignores a stale writer that changes its request token but leaves the committed cell marked', () => {
    expect(
      directMarkAnalyticsForWrite({
        before: board(true, { id: 'first' }),
        after: board(true, { ...request(), id: 'stale-second' }),
        uid: 'u1',
        transitionId: 'cloud-event-2',
      }),
    ).toBeNull();
  });

  it('gives each later committed reversal its own CloudEvent identity', () => {
    expect(
      directMarkAnalyticsForWrite({
        before: board(true, { id: 'mark' }),
        after: board(false, request({ id: 'unmark', marked: false })),
        uid: 'u1',
        transitionId: 'cloud-event-3',
      }),
    ).toMatchObject({ name: 'unmark_square', transitionId: 'cloud-event-3' });
    expect(
      directMarkAnalyticsForWrite({
        before: board(false, { id: 'unmark', marked: false }),
        after: board(true, request({ id: 'remark' })),
        uid: 'u1',
        transitionId: 'cloud-event-4',
      }),
    ).toMatchObject({ name: 'mark_square', transitionId: 'cloud-event-4' });
  });

  it('is idempotent when Firestore redelivers one trigger', async () => {
    const create = vi.fn(async () => {
      throw { code: 'already-exists' };
    });
    const doc = vi.fn(() => ({ create }));
    await expect(
      recordDirectMarkAnalytics(
        { doc },
        {
          eventId: 'event',
          before: board(false, { id: 'old' }),
          after: board(true),
          uid: 'u1',
          transitionId: 'cloud-event-5',
        },
      ),
    ).resolves.toBeUndefined();
    expect(doc).toHaveBeenCalledWith('events/event/players/u1/analyticsTransitions/cloud-event-5');
  });
});
