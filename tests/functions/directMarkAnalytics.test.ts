import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  directMarkAnalyticsForWrite,
  echoAnalyticsForWrite,
  firestoreCommitOrder,
  recordDirectMarkAnalytics,
} from '../../functions/src/directMarkAnalytics';

const COMMIT_ORDER = '0000000000000001:000000001';

// Resolve the Functions dependency graph, including on a clean CI install.
const { Firestore } = createRequire(new URL('../../functions/package.json', import.meta.url))(
  'firebase-admin/firestore',
) as { Firestore: new (settings: { projectId: string }) => { doc(path: string): { path: string } } };
const pathParser = new Firestore({ projectId: 'demo-analytics-path-validation' });
const echoBoard = (id: unknown) => ({
  cells: { '7': { marked: true, echo: true, echoAnalyticsId: id, echoAnalyticsTrigger: 'mark' } },
});
const unsafeIds = [
  '', 'unsafe/nested', 'unsafe/nested/row', '/', '.', '..', '__reserved__', '__\n__', '\ud800',
  'a'.repeat(1_501), 'é'.repeat(751),
];

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

  it('preserves the committed proof/admin source instead of attributing every edge to a pledge', () => {
    expect(
      directMarkAnalyticsForWrite({
        before: board(false, { id: 'old' }),
        after: board(true, request({ source: 'proof', mode: 'proof_required' })),
        uid: 'u1',
        transitionId: 'cloud-event-proof',
        commitOrder: COMMIT_ORDER,
      }),
    ).toMatchObject({ name: 'mark_square', source: 'proof', mode: 'proof_required' });
    expect(
      directMarkAnalyticsForWrite({
        before: {
          cells: { '4': { marked: true, status: 'pending' } },
          directAnalyticsRequest: { id: 'old' },
        },
        after: {
          cells: { '4': { marked: true, status: 'confirmed' } },
          directAnalyticsRequest: request({ source: 'admin_confirm', mode: 'admin_confirmed' }),
        },
        uid: 'u1',
        transitionId: 'cloud-event-confirm',
        commitOrder: COMMIT_ORDER,
      }),
    ).toMatchObject({ name: 'mark_square', source: 'admin_confirm', mode: 'admin_confirmed' });
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

  it('exercises both rejection and nested-document acceptance in the real Admin SDK path parser', () => {
    const prefix = 'events/event/players/u1/analyticsTransitions/';
    expect(() => pathParser.doc(`${prefix}unsafe/nested`)).toThrow();
    expect(pathParser.doc(`${prefix}unsafe/nested/row`).path).toBe(`${prefix}unsafe/nested/row`);
  });

  it.each(unsafeIds)('terminally skips unsafe Echo identity %j before any SDK path or write', async (id) => {
    const doc = vi.fn((path: string) => {
      pathParser.doc(path);
      return { create: vi.fn(async () => undefined) };
    });
    const params = {
      eventId: 'event', uid: 'u1', transitionId: 'cloud-event', commitOrder: COMMIT_ORDER,
      before: { cells: { '7': { marked: false } } }, after: echoBoard(id),
    };
    expect(echoAnalyticsForWrite(params)).toEqual([]);
    for (let delivery = 0; delivery < 3; delivery++) {
      await expect(recordDirectMarkAnalytics({ doc }, params)).resolves.toBeUndefined();
    }
    expect(doc).not.toHaveBeenCalled();
  });

  it.each(unsafeIds)('terminally skips unsafe direct CloudEvent identity %j', async (transitionId) => {
    const doc = vi.fn();
    const params = {
      eventId: 'event', uid: 'u1', transitionId, commitOrder: COMMIT_ORDER,
      before: board(false, { id: 'old' }), after: board(true),
    };
    expect(directMarkAnalyticsForWrite(params)).toBeNull();
    await expect(recordDirectMarkAnalytics({ doc }, params)).resolves.toBeUndefined();
    expect(doc).not.toHaveBeenCalled();
  });

  it.each(['eventId', 'uid'] as const)('rejects an unsafe %s before any SDK path', async (segment) => {
    const doc = vi.fn();
    await expect(recordDirectMarkAnalytics({ doc }, {
      eventId: 'event', uid: 'u1', transitionId: 'cloud-event', commitOrder: COMMIT_ORDER,
      before: board(false, { id: 'old' }), after: board(true), [segment]: 'unsafe/nested/row',
    })).resolves.toBeUndefined();
    expect(doc).not.toHaveBeenCalled();
  });

  it('records valid sibling transitions and makes redelivery a no-op despite a malformed Echo', async () => {
    const rows = new Map<string, unknown>();
    const create = vi.fn(async (path: string, data: unknown) => {
      if (rows.has(path)) throw { code: 6 };
      rows.set(path, data);
    });
    const doc = vi.fn((path: string) => {
      const ref = pathParser.doc(path);
      return { create: (data: unknown) => create(ref.path, data) };
    });
    const params = {
      eventId: 'event', uid: 'u1', transitionId: 'cloud-event', commitOrder: COMMIT_ORDER,
      before: board(false, { id: 'old' }),
      after: { ...board(true), cells: {
        ...board(true).cells, ...echoBoard('unsafe/nested/row').cells,
        '8': { marked: true, echo: true, echoAnalyticsId: 'echo-v1:event:u1:2:222:8:1', echoAnalyticsTrigger: 'mark' },
      } },
    };
    await recordDirectMarkAnalytics({ doc }, params);
    const originalRows = [...rows.entries()];
    await recordDirectMarkAnalytics({ doc }, params);
    expect([...rows.entries()]).toEqual(originalRows);
    expect([...rows.keys()]).toEqual([
      'events/event/players/u1/analyticsTransitions/cloud-event',
      'events/event/players/u1/analyticsTransitions/echo-v1:event:u1:2:222:8:1',
    ]);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it.each(['a'.repeat(1_500), 'é'.repeat(750)])('preserves a valid 1,500-byte identity', async (id) => {
    const create = vi.fn(async () => undefined);
    const doc = vi.fn((path: string) => {
      pathParser.doc(path);
      return { create };
    });
    await recordDirectMarkAnalytics({ doc }, {
      eventId: 'event', uid: 'u1', transitionId: 'cloud-event', commitOrder: COMMIT_ORDER,
      before: undefined, after: echoBoard(id),
    });
    expect(doc).toHaveBeenCalledWith(`events/event/players/u1/analyticsTransitions/${id}`);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ transitionId: id }));
  });

  it('keeps real service failures retryable for valid transitions', async () => {
    const failure = new Error('service unavailable');
    const create = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const doc = vi.fn(() => ({ create }));
    const params = {
      eventId: 'event', uid: 'u1', transitionId: 'cloud-event', commitOrder: COMMIT_ORDER,
      before: board(false, { id: 'old' }), after: board(true),
    };
    await expect(recordDirectMarkAnalytics({ doc }, params)).rejects.toBe(failure);
    await expect(recordDirectMarkAnalytics({ doc }, params)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('uses Firestore nanosecond document versions as a sortable commit-order key', () => {
    expect(firestoreCommitOrder({ seconds: 12, nanoseconds: 9 })).toBe('0000000000000012:000000009');
    expect(firestoreCommitOrder({ seconds: 12, nanoseconds: 10 })).toBe('0000000000000012:000000010');
    expect(firestoreCommitOrder({ seconds: 12, nanoseconds: 1_000_000_000 })).toBeNull();
  });
});
