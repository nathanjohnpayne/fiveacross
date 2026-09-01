import { describe, expect, it } from 'vitest';
import { eventScopeKey } from './eventScope';

describe('eventScopeKey', () => {
  it('changes whenever the Event identity changes', () => {
    expect(eventScopeKey('event-a', 'board', 'u1')).not.toBe(
      eventScopeKey('event-b', 'board', 'u1'),
    );
  });

  it('keeps segment boundaries unambiguous', () => {
    expect(eventScopeKey('event:a', 'board', 'u1')).not.toBe(
      eventScopeKey('event', 'a:board', 'u1'),
    );
  });
});
