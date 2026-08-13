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
  trackToAnalyticsSinks: vi.fn(() => ({ ga4: true, posthog: true })),
  analyticsInitializationSettled: Promise.resolve(),
  onPostHogReady: vi.fn<(listener: () => void) => () => void>(() => () => {}),
  isLocalDirectMarkRequest: vi.fn(() => false),
}));

vi.mock('firebase/firestore', () => H);
vi.mock('../analytics', () => ({
  analyticsInitializationSettled: H.analyticsInitializationSettled,
  trackToAnalyticsSinks: H.trackToAnalyticsSinks,
}));
vi.mock('../posthog', () => ({ onPostHogReady: H.onPostHogReady }));
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
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
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
    expect(H.trackToAnalyticsSinks).toHaveBeenNthCalledWith(
      1,
      'unmark_square',
      expect.objectContaining({ transitionId: 'event-2' }),
      { localMarkOccurred: false, posthogOptions: { durableOutbox: true } },
      { ga4: true, posthog: true },
    );
    expect(H.trackToAnalyticsSinks).toHaveBeenNthCalledWith(
      2,
      'echo_mark',
      expect.objectContaining({ trigger: 'mark', transitionId: 'echo-1' }),
      { posthogOptions: { durableOutbox: true } },
      { ga4: true, posthog: true },
    );
    vi.unstubAllGlobals();
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
    H.trackToAnalyticsSinks.mockReturnValueOnce({ ga4: false, posthog: true });
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

  it('retries a pre-ready GA4 delivery once analytics initialization settles without waiting for another Firestore snapshot', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    H.trackToAnalyticsSinks.mockReturnValueOnce({ ga4: false, posthog: true }).mockReturnValueOnce({ ga4: true, posthog: true });
    H.onSnapshot.mockImplementationOnce((_query, onNext) => {
      onNext({
        metadata: { fromCache: false },
        docs: [
          {
            id: 'row-pre-ready',
            data: () => ({
              name: 'unmark_square',
              mode: 'honor',
              uid: 'u1',
              requestId: 'request-pre-ready',
              transitionId: 'transition-pre-ready',
              commitOrder: '0000000000000012:000000000',
              recordedAt: { seconds: 12, nanoseconds: 0 },
            }),
          },
        ],
      });
      return () => {};
    });

    subscribeDirectMarkAnalytics('u1');
    await H.analyticsInitializationSettled;

    expect(H.trackToAnalyticsSinks).toHaveBeenLastCalledWith(
      'unmark_square',
      expect.objectContaining({ transitionId: 'transition-pre-ready' }),
      { localMarkOccurred: false, posthogOptions: { durableOutbox: true } },
      { ga4: true, posthog: false },
    );
    expect(storage.get('five-across:board-analytics-outbox:event:u1')).toBe('[]');
    vi.unstubAllGlobals();
  });

  it('queues every row in a blocked snapshot, then drains the tail when PostHog becomes ready', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    let postHogReady!: () => void;
    H.onPostHogReady.mockImplementationOnce((listener) => {
      postHogReady = listener;
      return () => {};
    });
    H.trackToAnalyticsSinks.mockReturnValueOnce({ ga4: true, posthog: false }).mockReturnValue({ ga4: true, posthog: true });
    H.onSnapshot.mockImplementationOnce((_query, onNext) => {
      onNext({
        metadata: { fromCache: false },
        docs: [
          {
            id: 'row-posthog-1',
            data: () => ({
              name: 'unmark_square', mode: 'honor', uid: 'u1', requestId: 'request-posthog-1',
              transitionId: 'transition-posthog-1', commitOrder: '0000000000000013:000000000',
              recordedAt: { seconds: 13, nanoseconds: 0 },
            }),
          },
          {
            id: 'row-posthog-2',
            data: () => ({
              name: 'unmark_square', mode: 'honor', uid: 'u1', requestId: 'request-posthog-2',
              transitionId: 'transition-posthog-2', commitOrder: '0000000000000014:000000000',
              recordedAt: { seconds: 14, nanoseconds: 0 },
            }),
          },
        ],
      });
      return () => {};
    });

    const callsBeforeSubscribe = H.trackToAnalyticsSinks.mock.calls.length;
    subscribeDirectMarkAnalytics('u1');

    const beforeReady = storage.get('five-across:board-analytics-outbox:event:u1') ?? '';
    expect(beforeReady).toContain('transition-posthog-1');
    expect(beforeReady).toContain('transition-posthog-2');
    expect(H.trackToAnalyticsSinks).toHaveBeenCalledTimes(callsBeforeSubscribe + 1);

    postHogReady();

    expect(H.trackToAnalyticsSinks).toHaveBeenLastCalledWith(
      'unmark_square',
      expect.objectContaining({ transitionId: 'transition-posthog-2' }),
      expect.objectContaining({ posthogOptions: { durableOutbox: true } }),
      { ga4: true, posthog: true },
    );
    expect(storage.get('five-across:board-analytics-cursor:event:u1')).toContain('"seconds":14');
    vi.unstubAllGlobals();
  });

  it('still dispatches transitions at least once when localStorage cannot accept an outbox', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    });
    H.onSnapshot.mockImplementationOnce((_query, onNext) => {
      onNext({
        metadata: { fromCache: false },
        docs: [
          {
            id: 'row-memory-only',
            data: () => ({
              name: 'unmark_square', mode: 'honor', uid: 'u1', requestId: 'request-memory-only',
              transitionId: 'transition-memory-only', commitOrder: '0000000000000015:000000000',
              recordedAt: { seconds: 15, nanoseconds: 0 },
            }),
          },
        ],
      });
      return () => {};
    });

    subscribeDirectMarkAnalytics('u1');

    expect(H.trackToAnalyticsSinks).toHaveBeenCalledWith(
      'unmark_square',
      expect.objectContaining({ transitionId: 'transition-memory-only' }),
      expect.objectContaining({ posthogOptions: { durableOutbox: true } }),
      { ga4: true, posthog: true },
    );
    vi.unstubAllGlobals();
  });

  it('retries only the sink that did not acknowledge a durable transition', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const snapshot = {
      metadata: { fromCache: false },
      docs: [
        {
          id: 'row-11',
          data: () => ({
            name: 'unmark_square',
            mode: 'honor',
            uid: 'u1',
            requestId: 'request-11',
            transitionId: 'transition-11',
            commitOrder: '0000000000000011:000000000',
            recordedAt: { seconds: 11, nanoseconds: 0 },
          }),
        },
      ],
    };
    let deliver: (snapshot: unknown) => void;
    H.trackToAnalyticsSinks.mockReturnValueOnce({ ga4: true, posthog: false });
    H.onSnapshot.mockImplementationOnce((_query, onNext) => {
      deliver = onNext;
      deliver(snapshot);
      return () => {};
    });

    subscribeDirectMarkAnalytics('u1');
    expect(storage.get('five-across:board-analytics-cursor:event:u1')).toBeUndefined();

    deliver!(snapshot);

    expect(H.trackToAnalyticsSinks).toHaveBeenLastCalledWith(
      'unmark_square',
      expect.objectContaining({ transitionId: 'transition-11' }),
      { localMarkOccurred: false, posthogOptions: { durableOutbox: true } },
      { ga4: false, posthog: true },
    );
    expect(storage.get('five-across:board-analytics-cursor:event:u1')).toContain('"seconds":11');
    vi.unstubAllGlobals();
  });
});
