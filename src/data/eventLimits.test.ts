import { describe, expect, it } from 'vitest';
import { MAX_DAYS, UNROLLED_SCHEDULE_LOCK_DAYS, scheduleEditFromFor, supportedDayIndex } from './eventLimits';

// #1357 — the platform ceiling moved off the rules' ten-index unroll; the
// unroll itself did not move, and the edit window covers the difference.
describe('event limits (#1357)', () => {
  it('holds a sixteen-week semester plus slack, while the rules unroll stays at ten', () => {
    expect(MAX_DAYS).toBe(20);
    expect(UNROLLED_SCHEDULE_LOCK_DAYS).toBe(10);
  });

  it('supports Day indexes 0..MAX_DAYS - 1 and nothing else', () => {
    expect(supportedDayIndex(0)).toBe(true);
    expect(supportedDayIndex(15)).toBe(true);
    expect(supportedDayIndex(MAX_DAYS - 1)).toBe(true);
    expect(supportedDayIndex(MAX_DAYS)).toBe(false);
    expect(supportedDayIndex(-1)).toBe(false);
  });

  it('opens no window on a schedule the unroll still covers', () => {
    expect(scheduleEditFromFor(1, 0)).toBeUndefined();
    expect(scheduleEditFromFor(UNROLLED_SCHEDULE_LOCK_DAYS, 9)).toBeUndefined();
  });

  it('opens the window at the edited Day, pulled back one when the Day is last', () => {
    expect(scheduleEditFromFor(16, 0)).toBe(0);
    expect(scheduleEditFromFor(16, 7)).toBe(7);
    expect(scheduleEditFromFor(16, 14)).toBe(14);
    expect(scheduleEditFromFor(16, 15)).toBe(14);
    expect(scheduleEditFromFor(UNROLLED_SCHEDULE_LOCK_DAYS + 1, 10)).toBe(9);
  });
});
