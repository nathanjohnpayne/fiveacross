/**
 * Stable identity for client state that belongs to one Event.
 *
 * JSON keeps segment boundaries unambiguous without imposing a delimiter
 * restriction on Event ids or caller-owned values. Callers use this for React
 * subscription lifecycles and in-memory registries; persisted stores retain
 * their existing human-readable prefixes and include the Event id directly.
 */
export function eventScopeKey(
  eventId: string,
  ...parts: readonly (string | number)[]
): string {
  return JSON.stringify([eventId, ...parts]);
}
