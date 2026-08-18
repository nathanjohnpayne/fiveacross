import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNextUnlockClock } from './useNextUnlockClock';

// #559, Codex P2, PR #845 round 5: extracted after the identical unclamped-
// setTimeout overflow bug (round 4, P1) turned up independently in
// Board.tsx, ProofFeed.tsx, and ItemPool.tsx's own hand-copies of this
// pattern. This suite pins the ONE place the fix now lives.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNextUnlockClock (#559)', () => {
  it('returns the current time and schedules no timer when the schedule is empty or undefined', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { result: r1 } = renderHook(() => useNextUnlockClock(undefined));
    const { result: r2 } = renderHook(() => useNextUnlockClock([]));
    expect(typeof r1.current).toBe('number');
    expect(typeof r2.current).toBe('number');
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('schedules no timer when every Day in the schedule has already unlocked', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    renderHook(() => useNextUnlockClock([{ unlockAt: Date.now() - 1000 }]));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('schedules a timer at the earliest still-future unlockAt in the schedule, not the nearest-in-array one', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const now = Date.now();
    renderHook(() =>
      useNextUnlockClock([
        { unlockAt: now + 50_000 },
        { unlockAt: now + 5_000 }, // earliest still-future — this is the one that should win
        { unlockAt: now - 1_000 }, // already unlocked — must be excluded
      ]),
    );
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    const delay = setTimeoutSpy.mock.calls[0][1] as number;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5_000);
  });

  // The regression this hook exists to close (Codex P1, PR #845 round 4): an
  // unclamped delay overflows the 32-bit signed int `setTimeout` accepts
  // once the next unlock is more than ~24.9 days out, which browsers clamp
  // to ~0ms — firing near-instantly, recomputing the SAME far-off target,
  // and re-arming an equally near-instant timer forever.
  it('clamps the delay to the 32-bit setTimeout max for a Day more than ~24.9 days out', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    renderHook(() => useNextUnlockClock([{ unlockAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }]));
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    const delay = setTimeoutSpy.mock.calls[0][1] as number;
    expect(delay).toBe(2_147_483_647);
  });

  it('clears its timer on unmount', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = renderHook(() => useNextUnlockClock([{ unlockAt: Date.now() + 5_000 }]));
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});
