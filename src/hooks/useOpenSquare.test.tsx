import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ eventId: 'event-a' }));

vi.mock('../firebase', () => ({
  get EVENT_ID() {
    return H.eventId;
  },
}));

import {
  __resetOpenSquareForTests,
  requestOpenSquare,
  useOpenSquareIntent,
} from './useOpenSquare';

beforeEach(() => {
  H.eventId = 'event-a';
  __resetOpenSquareForTests();
});

describe('Event-scoped Feed-to-Board square intent (#807)', () => {
  it('never exposes an Event A intent while Event B is active', () => {
    act(() => requestOpenSquare({ dayIndex: 2, itemId: 'same-item' }));
    const view = renderHook(() => useOpenSquareIntent());
    expect(view.result.current).toMatchObject({
      eventId: 'event-a',
      dayIndex: 2,
      itemId: 'same-item',
    });

    H.eventId = 'event-b';
    view.rerender();
    expect(view.result.current).toBeNull();

    act(() => requestOpenSquare({ dayIndex: 2, itemId: 'same-item' }));
    expect(view.result.current).toMatchObject({ eventId: 'event-b' });
  });
});
