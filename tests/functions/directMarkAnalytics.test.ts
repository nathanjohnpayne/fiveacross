import { describe, expect, it, vi } from 'vitest';
import {
  directMarkAnalyticsForWrite,
  echoAnalyticsForWrite,
  firestoreCommitOrder,
  recordDirectMarkAnalytics,
} from '../../functions/src/directMarkAnalytics';

const COMMIT_ORDER = '0000000000000001:000000001';

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
        commitOrder: COMMIT_ORDER,
      }),
    ).toEqual({
      name: 'mark_square',
      source: 'pledge',
      mode: 'honor',
      marked: true,
      uid: 'u1',
      dayIndex: 3,
      requestId: 'request-1',
      transitionId: 'cloud-event-1',
      commitOrder: COMMIT_ORDER,
    });
  });

  it('ignores a stale writer that changes its request token but leaves the committed cell marked', () => {
    expect(
      directMarkAnalyticsForWrite({
        before: board(true, { id: 'first' }),
        after: board(true, { ...request(), id: 'stale-second' }),
        uid: 'u1',
        transitionId: 'cloud-event-2',
        commitOrder: COMMIT_ORDER,
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
        commitOrder: COMMIT_ORDER,
      }),
    ).toMatchObject({ name: 'unmark_square', transitionId: 'cloud-event-3' });
    expect(
      directMarkAnalyticsForWrite({
        before: board(false, { id: 'unmark', marked: false }),
        after: board(true, request({ id: 'remark' })),
        uid: 'u1',
        transitionId: 'cloud-event-4',
        commitOrder: COMMIT_ORDER,
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
          commitOrder: COMMIT_ORDER,
        },
      ),
    ).resolves.toBeUndefined();
    expect(doc).toHaveBeenCalledWith('events/event/players/u1/analyticsTransitions/cloud-event-5');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      transitionId: 'cloud-event-5',
      recordedAt: expect.anything(),
    }));
  });

  it('records a stamped Echo only after the server observed its false-to-true edge', () => {
    const before = { cells: { '7': { marked: false } } };
    const after = {
      cells: {
        '7': {
          marked: true,
          echo: true,
          echoAnalyticsId: 'echo-v1:event:u1:2:7:1',
          echoAnalyticsTrigger: 'mark',
        },
      },
    };
    expect(echoAnalyticsForWrite({ before, after, uid: 'u1', dayIndex: 2, commitOrder: COMMIT_ORDER })).toEqual([
      {
        name: 'echo_mark',
        trigger: 'mark',
        uid: 'u1',
        dayIndex: 2,
        count: 1,
        transitionId: 'echo-v1:event:u1:2:7:1',
        commitOrder: COMMIT_ORDER,
      },
    ]);
    expect(
      echoAnalyticsForWrite({ before: after, after, uid: 'u1', dayIndex: 2, commitOrder: COMMIT_ORDER }),
    ).toEqual([]);
  });

  it('uses Firestore nanosecond document versions as a sortable commit-order key', () => {
    expect(firestoreCommitOrder({ seconds: 12, nanoseconds: 9 })).toBe('0000000000000012:000000009');
    expect(firestoreCommitOrder({ seconds: 12, nanoseconds: 10 })).toBe('0000000000000012:000000010');
    expect(firestoreCommitOrder({ seconds: 12, nanoseconds: 1_000_000_000 })).toBeNull();
  });
});
