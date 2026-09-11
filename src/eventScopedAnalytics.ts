import { track } from './analytics';
import { isCurrentEvent } from './data/currentEvent';

/**
 * Emit an analytics event ONLY if the Event it was acted under is still the
 * live Event — the structural form (#1083) of the guard #807 hand-copied at
 * every late-continuation call site as `if (EVENT_ID === actedEventId)
 * track(...)`.
 *
 * The analytics dimensions (`event_id`, `event_slug`, `day_index` —
 * `registerAnalyticsDimensions` / `registerDayIndexDimension` in analytics.ts)
 * are registered from the ACTIVE Event and cannot be rebound for one
 * continuation, so a write that settles after another Event has activated
 * must park its analytics rather than report Event A's action as Event B's
 * (specs/event-scoped-client-state.md § Async operations and uploads). A new
 * call site that forgot the hand-rolled guard would reintroduce that
 * cross-Event leak silently — no compiler or lint signal — which is why this
 * helper takes the acted Event id as a REQUIRED first argument: an
 * Event-guarded emission cannot be written without naming the Event it is
 * guarded against. Callers capture `EVENT_ID` once, before their first await
 * (the spec's "read the live binding once" rule), and hand that capture here
 * after the await.
 *
 * Forwards EXACTLY the arguments it was given (a rest tuple, not three named
 * parameters), so `track` sees the same arity the call site wrote — the
 * component and data suites assert `toHaveBeenCalledWith(name, params)` on
 * their `track` doubles, and a padded trailing `undefined` would fail every
 * one of them.
 *
 * Returns whether the event was emitted, so a caller with other same-Event
 * work to gate can branch on the one verdict instead of re-deriving it.
 *
 * Deliberately a SIBLING of `analytics.ts` rather than an export of it: the
 * component and data suites stub `../analytics` as `{ track }` and assert on
 * `track`, so keeping `track()` the one dispatch seam means those doubles
 * exercise this guard for real and none of them needs a second export. And
 * deliberately NOT beside `isCurrentEvent` in `data/currentEvent.ts`: that
 * predicate stays free of the analytics graph so `moments.ts` — the one
 * consumer whose import graph does not already reach `analytics.ts` — and its
 * `{ db, EVENT_ID }` firebase doubles never load it.
 */
export function trackIfCurrentEvent(actedEventId: string, ...args: Parameters<typeof track>): boolean {
  if (!isCurrentEvent(actedEventId)) return false;
  track(...args);
  return true;
}
