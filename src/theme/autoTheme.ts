import type { DayDef, EventDoc, ThemeId } from '../types';

/**
 * Resolve "today's Day" from `EventDoc.days` for the More menu's Theme row
 * (daily-cards-spec § "More menu" — "Auto: match the day"): board chrome
 * already follows the VIEWED Day (a future ticket, #205); Auto makes the
 * WHOLE APP follow TODAY'S Day instead of a manual pick.
 *
 * "Today's Day" is the last Day whose `unlockAt` has passed relative to
 * `now` — a Day is "current" from its own unlock moment (which may be mid-
 * morning) until the NEXT Day's unlock, not by calendar date alone. Ties on
 * `unlockAt` break to the lowest `index`, the SAME tie-break as the
 * pre-unlock fallback below, so the resolved theme cannot flip at the
 * boundary the moment a tied pair unlocks (Codex P2 on #303). Before
 * the first Day's `unlockAt` (pre-cruise), the FIRST Day — earliest
 * `unlockAt`, ties broken by lowest `index` — is already what the whole app
 * presents (the Board's `defaultViewedIndex` falls back to Day 0, the header
 * reads the embark Day), so Auto resolves to that first Day's theme rather
 * than the event default (#299: Auto painted Neon Playground while every
 * other surface said Welcome Aboard). Only with no `days` configured (or no
 * Event yet) is there genuinely nothing to match: returns `null` so the
 * caller (ThemeContext's `autoThemeId` prop) falls back to the event/player
 * default instead of guessing.
 *
 * Pure and Firestore-free (like the rest of `theme/`) so it is unit-testable
 * without mounting a component or opening a subscription; `main.tsx` is the
 * one caller, handing the resolved id down to `ThemeProvider`.
 */
/**
 * The DayDef itself, shared by `todaysDayTheme` (which reads `.theme`) and
 * `todaysDayIndex` (#556, which reads `.index` for the `day_index` analytics
 * dimension) — one decision table, two thin projections, so the two callers
 * can never disagree about which Day is "today's".
 */
function resolveTodaysDay(
  event: Pick<EventDoc, 'days'> | null | undefined,
  now: number,
): DayDef | null {
  const days = event?.days;
  if (!days || days.length === 0) return null;
  let current: DayDef | null = null;
  let currentUnlockAt = -Infinity;
  let currentIndex = Infinity;
  for (const day of days) {
    if (
      day.unlockAt <= now &&
      (day.unlockAt > currentUnlockAt ||
        (day.unlockAt === currentUnlockAt && day.index < currentIndex))
    ) {
      current = day;
      currentUnlockAt = day.unlockAt;
      currentIndex = day.index;
    }
  }
  if (current !== null) return current;
  // Pre-cruise: Days are configured but none has unlocked yet. Mirror
  // `defaultViewedIndex`'s Day-0 fallback — resolve the first Day to unlock
  // (order-independent, like the loop above) instead of the event default.
  let first: DayDef | null = null;
  let firstUnlockAt = Infinity;
  let firstIndex = Infinity;
  for (const day of days) {
    if (day.unlockAt < firstUnlockAt || (day.unlockAt === firstUnlockAt && day.index < firstIndex)) {
      first = day;
      firstUnlockAt = day.unlockAt;
      firstIndex = day.index;
    }
  }
  return first;
}

export function todaysDayTheme(
  event: Pick<EventDoc, 'days'> | null | undefined,
  now: number = Date.now(),
): ThemeId | null {
  return resolveTodaysDay(event, now)?.theme ?? null;
}

/**
 * "Today's Day" index — the same resolution `todaysDayTheme` uses, projected
 * onto `.index` instead of `.theme` (#556: the `day_index` analytics
 * dimension `registerDayIndexDimension`, src/analytics.ts, registers from
 * `main.tsx`'s `ThemedApp`). Pure and Firestore-free like the rest of this
 * module.
 */
export function todaysDayIndex(
  event: Pick<EventDoc, 'days'> | null | undefined,
  now: number = Date.now(),
): number | null {
  return resolveTodaysDay(event, now)?.index ?? null;
}
