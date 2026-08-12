import { describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  Timestamp: class {
    constructor(
      public seconds: number,
      public nanoseconds: number,
    ) {}
  },
  collection: vi.fn(() => ({})),
  documentId: vi.fn(() => '__name__'),
  onSnapshot: vi.fn(),
  orderBy: vi.fn((field) => ({ field })),
  query: vi.fn(() => ({})),
  startAfter: vi.fn(),
  track: vi.fn(() => true),
  isLocalDirectMarkRequest: vi.fn(() => false),
}));

vi.mock('firebase/firestore', () => H);
vi.mock('../analytics', () => ({ track: H.track }));
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'event' }));
vi.mock('./markAnalytics', () => ({ isLocalDirectMarkRequest: H.isLocalDirectMarkRequest }));

import { parseDirectMarkAnalyticsEvent, subscribeDirectMarkAnalytics } from './directMarkAnalytics';

describe('durable direct-mark analytics delivery', () => {
  it('accepts only the server-record shape for a direct mark', () => {
    expect(
      parseDirectMarkAnalyticsEvent({
        name: 'mark_square',
        source: 'pledge',
        marked: true,
        mode: 'honor',
        uid: 'u1',
        dayIndex: 2,
        requestId: 'request-1',
        transitionId: 'cloud-event',
        commitOrder: '0000000000000001:000000001',
      }),
    ).toMatchObject({ name: 'mark_square', transitionId: 'cloud-event' });
  });

  it('rejects a malformed server record instead of sending an ambiguous event', () => {
    expect(
      parseDirectMarkAnalyticsEvent({
        name: 'mark_square',
        source: 'pledge',
        mode: 'honor',
        requestId: 'request-1',
        uid: 'u1',
        transitionId: 'cloud-event',
        commitOrder: '0000000000000001:000000001',
      }),
    ).toBeNull();
  });

  it('delivers server rows in their stored commit order and suppresses a remote tab’s nudge', () => {
    H.onSnapshot.mockImplementationOnce((_query, onNext) => {
      onNext({
        metadata: { fromCache: false },
        docs: [
          {
            id: 'event-2',
            data: () => ({
              name: 'unmark_square',
              mode: 'honor',
              uid: 'u1',
              requestId: 'request-2',
              transitionId: 'event-2',
              commitOrder: '0000000000000002:000000000',
              recordedAt: { seconds: 2, nanoseconds: 0 },
            }),
          },
          {
            id: 'echo-1',
            data: () => ({
              name: 'echo_mark',
              trigger: 'mark',
              uid: 'u1',
              dayIndex: 2,
              count: 1,
              transitionId: 'echo-1',
              commitOrder: '0000000000000003:000000000',
              recordedAt: { seconds: 3, nanoseconds: 0 },
            }),
          },
        ],
      });
      return () => {};
    });

    subscribeDirectMarkAnalytics('u1');

    expect(H.orderBy).toHaveBeenNthCalledWith(1, 'recordedAt');
    expect(H.orderBy).toHaveBeenNthCalledWith(2, '__name__');
    expect(H.track).toHaveBeenNthCalledWith(
      1,
      'unmark_square',
      expect.objectContaining({ transitionId: 'event-2' }),
      { localMarkOccurred: false },
    );
    expect(H.track).toHaveBeenNthCalledWith(
      2,
      'echo_mark',
      expect.objectContaining({ trigger: 'mark', transitionId: 'echo-1' }),
    );
  });

  it('uses the persisted server-record cursor instead of re-reading prior history on remount', () => {
    const storage = new Map<string, string>([
      ['five-across:board-analytics-cursor:event:u1', JSON.stringify({ seconds: 4, nanoseconds: 5, id: 'row-4' })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    H.onSnapshot.mockImplementationOnce(() => () => {});

    subscribeDirectMarkAnalytics('u1');

    expect(H.startAfter).toHaveBeenCalledWith(expect.any(H.Timestamp), 'row-4');
    expect(H.startAfter.mock.calls.at(-1)?.[0]).toMatchObject({ seconds: 4, nanoseconds: 5 });
    vi.unstubAllGlobals();
  });

  it('does not advance the cursor from a cache-only snapshot', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    H.onSnapshot.mockImplementationOnce((_query, onNext) => {
      onNext({
        metadata: { fromCache: true },
        docs: [{ id: 'row-9', data: () => ({ recordedAt: { seconds: 9, nanoseconds: 0 } }) }],
      });
      return () => {};
    });
    subscribeDirectMarkAnalytics('u1');
    expect(storage.get('five-across:board-analytics-cursor:event:u1')).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('keeps the cursor behind an event the analytics sinks did not accept', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    H.track.mockReturnValueOnce(false);
    H.onSnapshot.mockImplementationOnce((_query, onNext) => {
      onNext({
        metadata: { fromCache: false },
        docs: [
          {
            id: 'row-10',
            data: () => ({
              name: 'unmark_square',
              mode: 'honor',
              uid: 'u1',
              requestId: 'request-10',
              transitionId: 'transition-10',
              commitOrder: '0000000000000010:000000000',
              recordedAt: { seconds: 10, nanoseconds: 0 },
            }),
          },
        ],
      });
      return () => {};
    });

    subscribeDirectMarkAnalytics('u1');

    expect(storage.get('five-across:board-analytics-cursor:event:u1')).toBeUndefined();
    expect(storage.get('five-across:board-analytics-outbox:event:u1')).toContain('transition-10');
    vi.unstubAllGlobals();
  });
});
