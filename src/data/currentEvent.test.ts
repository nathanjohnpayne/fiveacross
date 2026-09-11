import { beforeEach, describe, expect, it, vi } from 'vitest';

// Covers specs/event-scoped-client-state.md § Stable Event identity (#1083):
// the shared late-continuation predicate. `firebase.ts` initializes the
// Firebase singleton at import, so the live `EVENT_ID` read is doubled with
// the same getter shape the Event-scope suites use to simulate an in-session
// switch.
const H = vi.hoisted(() => ({ eventId: 'event-a' }));

vi.mock('../firebase', () => ({
  get EVENT_ID() {
    return H.eventId;
  },
}));

import { isCurrentEvent } from './currentEvent';

beforeEach(() => {
  H.eventId = 'event-a';
});

describe('isCurrentEvent (#1083)', () => {
  it('is true only for the live Event', () => {
    expect(isCurrentEvent('event-a')).toBe(true);
    expect(isCurrentEvent('event-b')).toBe(false);
  });

  it('reads the live binding on every call, so a captured id goes stale after a switch and revives on return', () => {
    const captured = 'event-a';
    expect(isCurrentEvent(captured)).toBe(true);
    H.eventId = 'event-b';
    expect(isCurrentEvent(captured)).toBe(false);
    H.eventId = 'event-a';
    expect(isCurrentEvent(captured)).toBe(true);
  });
});
