import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), onSnapshot: vi.fn() }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'event' }));

import { parseDirectMarkAnalyticsEvent } from './directMarkAnalytics';

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
        transitionId: 'cloud-event',
      }),
    ).toMatchObject({ name: 'mark_square', transitionId: 'cloud-event' });
  });

  it('rejects a malformed server record instead of sending an ambiguous event', () => {
    expect(
      parseDirectMarkAnalyticsEvent({
        name: 'mark_square',
        source: 'pledge',
        mode: 'honor',
        uid: 'u1',
        transitionId: 'cloud-event',
      }),
    ).toBeNull();
  });
});
