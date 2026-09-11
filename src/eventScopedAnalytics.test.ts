import { beforeEach, describe, expect, it, vi } from 'vitest';

// Covers specs/event-scoped-client-state.md § Stable Event identity (#1083):
// the structural form of the "only emit analytics if the acted Event is still
// the live Event" guard. The doubles mirror the shape the component/data
// suites use — a `get EVENT_ID()` getter on the firebase double and a bare
// `track` spy on the analytics double — so this proves the helper under
// exactly the doubles those suites run it against.
const H = vi.hoisted(() => ({ eventId: 'event-a', track: vi.fn() }));

vi.mock('./firebase', () => ({
  get EVENT_ID() {
    return H.eventId;
  },
}));
vi.mock('./analytics', () => ({ track: H.track }));

import { trackIfCurrentEvent } from './eventScopedAnalytics';

beforeEach(() => {
  vi.clearAllMocks();
  H.eventId = 'event-a';
});

describe('trackIfCurrentEvent (#1083)', () => {
  it('delegates to track() with the same name, params, and options while the acted Event is live', () => {
    const options = { localMarkOccurred: false };
    expect(trackIfCurrentEvent('event-a', 'share_click', { surface: 'leaderboard' }, options)).toBe(true);
    expect(H.track).toHaveBeenCalledTimes(1);
    expect(H.track).toHaveBeenCalledWith('share_click', { surface: 'leaderboard' }, options);
  });

  it('forwards exactly the arguments it was given, never a padded trailing undefined', () => {
    expect(trackIfCurrentEvent('event-a', 'bingo')).toBe(true);
    expect(H.track.mock.calls[0]).toEqual(['bingo']);
    expect(trackIfCurrentEvent('event-a', 'heart_post', { targetKind: 'proof', on: true })).toBe(true);
    expect(H.track.mock.calls[1]).toEqual(['heart_post', { targetKind: 'proof', on: true }]);
  });

  it('emits nothing and reports false once another Event has activated', () => {
    const actedEventId = 'event-a';
    H.eventId = 'event-b';
    expect(trackIfCurrentEvent(actedEventId, 'share_click', { surface: 'celebration' })).toBe(false);
    expect(H.track).not.toHaveBeenCalled();
  });

  it('re-reads the live binding on every call rather than capturing it at import', () => {
    const actedEventId = 'event-a';
    H.eventId = 'event-b';
    expect(trackIfCurrentEvent(actedEventId, 'demand_proof', { itemId: 'p1' })).toBe(false);
    H.eventId = 'event-a';
    expect(trackIfCurrentEvent(actedEventId, 'demand_proof', { itemId: 'p1' })).toBe(true);
    expect(H.track).toHaveBeenCalledTimes(1);
  });
});
