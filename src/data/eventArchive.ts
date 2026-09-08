import type { EventDoc } from '../types';

/**
 * Whether this Event is frozen (#134, specs/post-sailing-archive.md). The ONE
 * place the client asks the question, so no surface invents its own spelling of
 * `status === 'archived'` — `EventDoc.status` was a typed-but-dead field until
 * this ticket, and a dead field acquires several readers the moment it acquires
 * one.
 *
 * NOT to be confused with `HostnameDoc.status`, a different field with a
 * different value set (`'active' | 'disabled' | 'archived'`) that decides
 * ADDRESSING before first paint (`src/eventResolution.ts`). An Event can be
 * archived while its hostname is still perfectly servable — that is how a
 * Player reaches the archive at all.
 */
export function isEventArchived(
  // PARTIAL, so a raw or partially-decoded Event document answers the question
  // too: `status` is absent on every document written before this ticket, and
  // the predicate's own contract is that absent means OPEN — a caller holding a
  // `Partial<EventDoc>` (the deal path's mode read, the freeze's own raw
  // re-reads) must not have to assert its way past the type to ask.
  event: Partial<Pick<EventDoc, 'status'>> | null | undefined,
): boolean {
  return event?.status === 'archived';
}

/**
 * Whether this Event is in the archive's QUIESCING phase (#134, spec § "The
 * quiesce protocol"): shut to gameplay by the Admin's first archive write, but
 * not yet frozen. The rules deny every gameplay write in this state exactly as
 * they do for an archived Event, so nothing the freeze depends on can move
 * underneath it.
 *
 * Deliberately SEPARATE from `isEventArchived`, and neither implies the other.
 * A closing Event is reversible — an Admin can reopen play — while an archived
 * one clears the flag and is carried by `status`, which is write-once. The one
 * surface that cares about the difference is the Admin console, which offers a
 * closing Event both a way to finish and a way back.
 */
export function isEventArchiving(
  event: Partial<Pick<EventDoc, 'archiving'>> | null | undefined,
): boolean {
  return event?.archiving === true;
}
