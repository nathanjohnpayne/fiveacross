import { afterEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ eventId: 'event-a' }));

vi.mock('../firebase', () => ({
  get EVENT_ID() {
    return H.eventId;
  },
}));

import { directMarkAnalyticsRequest, isLocalDirectMarkRequest } from './markAnalytics';

afterEach(() => {
  vi.unstubAllGlobals();
  H.eventId = 'event-a';
});

describe('direct-mark analytics requests', () => {
  it('carries the exact direct action metadata while leaving the durable identity to the server transition', () => {
    expect(
      directMarkAnalyticsRequest({ cellIndex: 4, marked: true, mode: 'honor', id: 'request-1' }),
    ).toEqual({ id: 'request-1', cellIndex: 4, marked: true, mode: 'honor', source: 'pledge' });
  });

  it('keeps local request acknowledgements inside the Event that issued them', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });

    directMarkAnalyticsRequest({
      cellIndex: 4,
      marked: true,
      mode: 'honor',
      id: 'request-a',
      eventId: 'event-a',
    });

    expect(isLocalDirectMarkRequest('request-a', 'event-a')).toBe(true);
    expect(isLocalDirectMarkRequest('request-a', 'event-b')).toBe(false);
    expect(values.has('five-across:local-direct-mark-requests:event-a')).toBe(true);
    expect(values.has('five-across:local-direct-mark-requests:event-b')).toBe(false);
  });
});
