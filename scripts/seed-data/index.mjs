// Per-Event seed registry (#563). Each Event's canonical pools + Event payload
// live in their own module; scripts/seed.mjs resolves the target Event here
// rather than baking one Event's constants. The drift verifier
// (`node scripts/seed.mjs --verify`) therefore works per Event: it compares
// the target project's live `events/{id}/items` against THAT Event's pools.
import * as med2026 from './med-2026.mjs';
import * as bodegaBay2026 from './bodega-bay-2026.mjs';

/** Every seedable Event, keyed by its Event id (the Firestore doc id). */
export const SEED_EVENTS = {
  'med-2026': med2026,
  'bodega-bay-2026': bodegaBay2026,
};

/**
 * The Event a bare `node scripts/seed.mjs [--verify]` targets per Firebase
 * project when VITE_EVENT_ID is not set — so the npm scripts (`seed`,
 * `verify:seed`, `verify:seed:fiveacross`) each pin project + Event and can
 * never silently compare one project's live pool against another Event's
 * canon.
 */
export const PROJECT_DEFAULT_EVENT = {
  gaycruisebingo: 'med-2026',
  fiveacross: 'bodega-bay-2026',
};

/**
 * Look up an Event's seed module, failing loudly on an unknown id — seeding or
 * verifying an Event this registry has no data for would either write nothing
 * or report every live doc as stale, so an explicit error beats either.
 */
export function resolveSeedEvent(eventId) {
  const mod = SEED_EVENTS[eventId];
  if (!mod) {
    throw new Error(
      `No seed data for event '${eventId}' — known events: ${Object.keys(SEED_EVENTS).join(', ')}. ` +
        'Add a scripts/seed-data/<event-id>.mjs module and register it in scripts/seed-data/index.mjs.',
    );
  }
  return mod;
}
