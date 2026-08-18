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
    // At least one call — the schedule-change refresh effect (round 6) can
    // legitimately trigger a second render-and-reschedule pass on first
    // mount if `Date.now()` ticks over a millisecond between the initial
    // state and that effect running; every such call still targets the SAME
    // earliest-future unlock, so only the LAST call's delay is asserted.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const delay = setTimeoutSpy.mock.calls.at(-1)?.[1] as number;
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
    // At least one call — see the "earliest still-future unlockAt" test
    // above for why an exact count is fragile (the schedule-change refresh
    // effect can legitimately trigger extra reschedule passes on mount).
    // EVERY call must still be clamped, not just the last.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of setTimeoutSpy.mock.calls) {
      expect(call[1]).toBe(2_147_483_647);
    }
  });

  it('clears every timer it creates on unmount, leaving none stranded', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = renderHook(() => useNextUnlockClock([{ unlockAt: Date.now() + 5_000 }]));
    unmount();
    expect(clearTimeoutSpy.mock.calls.length).toBe(setTimeoutSpy.mock.calls.length);
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  // Codex P2, PR #845 round 6: `now` used to stay frozen at whatever it was
  // at MOUNT until the next scheduled timer fired. If the schedule itself
  // arrives late (the Event doc's first snapshot, a backgrounded tab), real
  // wall-clock time can have moved on significantly in the meantime — with
  // no timer armed yet to catch up (an undefined `days` schedules nothing).
  it('refreshes now to the current wall clock the moment the schedule itself changes, closing the stale-mount-time gap', () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      type Props = { days: readonly { unlockAt: number }[] | undefined };
      const { result, rerender } = renderHook(({ days }: Props) => useNextUnlockClock(days), {
        initialProps: { days: undefined } as Props,
      });
      expect(result.current).toBe(t0);

      // Real time moves on while no timer is armed (days was undefined, so
      // the hook had nothing to schedule against yet).
      vi.advanceTimersByTime(60_000);
      rerender({ days: [{ unlockAt: Date.now() + 5_000 }] });

      expect(result.current).toBe(t0 + 60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
