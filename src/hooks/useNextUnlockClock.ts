import { useEffect, useState } from 'react';

/**
 * A shared "now, ticking at the next Day unlock" clock (#559, Codex P2, PR
 * #845 round 5). Extracted after the SAME unclamped-`setTimeout` overflow
 * bug (round 4, P1) turned up independently in three copies of this exact
 * pattern: `Board.tsx`'s pre-existing timer, plus the two new #559 copies in
 * `ProofFeed.tsx` and `ItemPool.tsx`. Three hand-copies of one clock is
 * precisely the shape that lets a scheduling fix drift out of sync again;
 * this is the one place it now lives.
 *
 * `now` stands in for `Date.now()` everywhere a caller reads the clock to
 * decide whether a Day is still open/targetable (`isDayTargetable`,
 * `submitterStatus`, a lock check), and this hook bumps it exactly when the
 * EARLIEST still-open Day in the WHOLE schedule passes — not just the
 * caller's own narrower concern — so a tab left open across an `unlockAt`
 * rollover never lingers on stale state until some unrelated render happens
 * to fire.
 *
 * Clamped to the 32-bit signed int `setTimeout` max: an Event whose next
 * unlock is more than ~24.9 days out would otherwise overflow the delay,
 * which browsers clamp to ~0ms — firing near-instantly, recomputing the SAME
 * far-off target, and re-arming an equally near-instant timer forever while
 * the page stays open. Same clamp `admin/SchedulePanel.tsx` already carries
 * for its own unlock timer.
 *
 * Accepts `days` as possibly `undefined` (not defaulted by the caller to a
 * fresh `[]`) so the effect's dependency stays the RAW schedule reference —
 * a caller passing `event?.days ?? []` would hand this hook a brand-new
 * array identity on every render while the Event is still loading, which
 * would re-run the effect every render instead of only on a genuine
 * schedule change. The `?? []` fallback happens inside the effect instead.
 */
export function useNextUnlockClock(days: readonly { unlockAt: number }[] | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  // Refresh to the CURRENT wall clock the moment the schedule itself changes
  // (Codex P2, PR #845 round 6): `now` otherwise stays frozen at whatever it
  // was during the gap between mount and the schedule actually arriving — a
  // backgrounded tab, or the Event doc's first snapshot landing after a real
  // unlock already elapsed — so a caller reading `now` right after a
  // schedule change could judge a Day's lock/target state against a
  // significantly stale clock until the NEXT scheduled timer happens to
  // fire. Deliberately its OWN effect, depending ONLY on `days`, never
  // `now`: folding this into the timer effect below (whose deps include
  // `now`) would call `setNow` on every one of ITS OWN re-runs too, and
  // `Date.now()` is essentially never bit-for-bit equal across two calls, so
  // that would re-render forever.
  useEffect(() => {
    setNow(Date.now());
  }, [days]);
  useEffect(() => {
    const schedule = days ?? [];
    const nextUnlock = schedule
      .map((d) => d.unlockAt)
      .filter((t) => t > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextUnlock == null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(nextUnlock - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `days` is the RAW (possibly undefined) schedule reference, deliberately not defaulted by the caller — see the doc comment above for why. The effect's own reschedule (`now` in the deps) is what re-evaluates it on every genuine change.
  }, [days, now]);
  return now;
}
