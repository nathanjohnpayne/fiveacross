// The device-local record that a SERVER-COMMITTED archive was observed for an
// Event (#1152, specs/post-sailing-archive.md § "The surfaces"). One slot, one
// owner: the shared Event subscription WRITES it (`useEventDoc`, via the
// observer it hands `useDocSub`), and the Leaderboard's routing half READS it.
//
// It lives here rather than in either of those files because it is neither a
// hook nor a component concern (Codex P2 on PR #1165). The write has to happen
// wherever the Event is observed — every route subscribes to the same document,
// and the Admin console is routinely the first surface to receive the committed
// flip — while the read happens on exactly one surface. A module both sides
// import is what keeps the key's SPELLING and its meaning single-sourced now
// that the writer and the reader are no longer the same component; a key format
// restated in two places is the defect this file exists to make impossible.
//
// Deliberately not `./eventArchive`, whose header promises a Firestore-free,
// React-free PURE half — this module is a side effect on browser storage, which
// is a different kind of thing. It is the `./cardCache` / `./eventDraft`
// precedent for a small `src/data/**` module owning one persisted slot.
import { isEventArchived } from './eventArchive';
import type { EventDoc } from '../types';

/**
 * The two per-snapshot metadata flags that decide whether a snapshot is fully
 * server-committed, structurally rather than as Firestore's `SnapshotMetadata`,
 * so this module stays free of the SDK and a caller can hand it a plain object
 * (the hooks pass the real metadata; the tests pass a literal).
 */
export type SnapshotOrigin = {
  /** Served from the ADR 0006 persistent cache rather than by the server. */
  fromCache: boolean;
  /** Carries a local optimistic write the server has not acked. */
  hasPendingWrites: boolean;
};

/**
 * localStorage slot recording that this device has SEEN a server-committed
 * archive for an Event, holding the generation the flip was bound to
 * (`EventDoc.archivedUnder`) as its value (Codex P2 on PR #1165).
 *
 * Per generation, not a bare "this Event is archived" flag, because the two
 * things it has to tell apart are a committed archive and an Admin's OPTIMISTIC
 * flip — and both write `status: 'archived'` on the local snapshot. The
 * generation is what the flip is bound to at the rules boundary, so it is the
 * one value that identifies WHICH archive was confirmed; an unconfirmed flip
 * under a different generation cannot match a record left by a confirmed one.
 *
 * `gcb.*`-namespaced and fail-open on throw, the pattern the rest of the app's
 * persisted UI state already uses: storage throws in some privacy modes and is
 * absent under SSR. Reached through `window` for the reason `FarewellPodium`
 * does — recent Node runtimes ship a bare `localStorage` global that is present
 * but non-functional and can shadow the DOM's. And it is trusted for ROUTING and
 * for nothing else: no number, name or honour is read from it, and the record
 * the page prints still comes off the Event document.
 */
const archiveConfirmedKey = (eventId: string): string => `gcb.archive.${eventId}.confirmedUnder`;

export function confirmedArchiveGeneration(eventId: string): string | null {
  try {
    return window.localStorage.getItem(archiveConfirmedKey(eventId));
  } catch {
    return null;
  }
}

export function rememberConfirmedArchive(eventId: string, generation: number): void {
  try {
    window.localStorage.setItem(archiveConfirmedKey(eventId), String(generation));
  } catch {
    /* storage refused — the in-session latch still holds for this mount */
  }
}

/**
 * The observation itself, called by the SHARED Event subscription on every
 * snapshot it delivers, on every route (Codex P2 on PR #1165).
 *
 * Only a mounted Leaderboard used to write the record, which made it useless in
 * the case it was added for. An Admin who first receives the committed archive
 * on the console, queues an offline ban THERE, and only then opens the
 * Leaderboard hands that mount a first snapshot which is `archived` with
 * `hasPendingWrites: true` and no persisted generation behind it: the in-session
 * latch has no history, the persisted one was never written, and the routing
 * gate mounted `LiveLeaderboard` after its settle escape — reopening every
 * gameplay listener the archived surface exists not to open, for as long as the
 * moderation write stayed in flight, which offline is until the client
 * reconnects. The confirmation is a fact about the DEVICE, not about a
 * component, so the subscription every route already holds is where it is
 * recorded.
 *
 * Called from the `onSnapshot` callback rather than from a render or an effect,
 * so it does not depend on the observing component re-rendering, staying mounted
 * or ever reading the value itself. Idempotent — the same generation rewritten
 * is the same string — and total: `rememberConfirmedArchive` swallows a refusing
 * store, and every other input is checked before it is used.
 *
 * The four conditions are the same ones the Leaderboard's in-session latch turns
 * on, plus the record: a snapshot that is `archived`, carries the `archive`
 * itself, is SERVER-BACKED and free of local writes (`!fromCache &&
 * !hasPendingWrites`), and names a numeric generation. The `archive` is required
 * because the routing gate this record serves also requires it — a hand-edited
 * document marked archived with no record routes to the live view either way, so
 * vouching for it would be a confirmation nothing could ever use.
 */
export function recordArchiveConfirmation(
  eventId: string,
  event: Partial<Pick<EventDoc, 'status' | 'archive' | 'archivedUnder'>> | null | undefined,
  origin: SnapshotOrigin,
): void {
  if (origin.fromCache || origin.hasPendingWrites) return;
  if (!isEventArchived(event) || !event?.archive) return;
  const generation = event.archivedUnder;
  if (typeof generation !== 'number') return;
  rememberConfirmedArchive(eventId, generation);
}
