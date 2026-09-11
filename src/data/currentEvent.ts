import { EVENT_ID } from '../firebase';

/**
 * Whether `eventId` is still the live Event.
 *
 * The shared spelling of the late-continuation guard (#1083): an Event-owned
 * operation captures `EVENT_ID` once before its first await and asks this
 * afterwards — before it touches live client state, opens a share surface, or
 * drains an Event-keyed outbox — so a continuation born under Event A can
 * finish A's own work but never act as B (specs/event-scoped-client-state.md
 * § The invariant). Reads the startup-resolved binding on EVERY call and never
 * captures it: `firebase.ts`'s own note explains why a module-scope copy would
 * freeze the pre-resolution value. Analytics emission has its own wrapper on
 * this predicate, `trackIfCurrentEvent` (`src/eventScopedAnalytics.ts`).
 *
 * Its own module, not an export of `./eventScope`: `eventScopeKey` is pure, and
 * `board-freshness.ts` (a pure registry whose only import is `./eventScope`)
 * consumes it, so folding the live-binding read in there would make that
 * registry — and its double-free unit test — initialize the Firebase
 * singleton. Every consumer of THIS predicate already imports `../firebase`,
 * so it grows no module's import graph.
 */
export function isCurrentEvent(eventId: string): boolean {
  return EVENT_ID === eventId;
}
