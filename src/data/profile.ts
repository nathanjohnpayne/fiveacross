import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db, EVENT_ID } from '../firebase';
import { uploadAvatar } from './storage';
import { isEventArchived, isEventArchiving } from './eventArchive';
import type { EventDoc } from '../types';

// Raw (converter-free) ref for writes — mirrors the private `rawUser` each
// writing data module keeps locally (see data/api.ts).
const rawUser = (uid: string) => doc(db, 'users', uid);
const rawEvent = (eventId: string = EVENT_ID) => doc(db, 'events', eventId);
const rawPlayer = (uid: string, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'players', uid);

export const MAX_DISPLAY_NAME = 40;

/**
 * Persist a display-name edit to `users/{uid}` (self-write only). A blank/whitespace-only name is a no-op.
 *
 * Uses a merge `setDoc` rather than `updateDoc`: the doc-create half of `ensureUserProfile`
 * (data/api.ts) runs on sign-in but its failure is swallowed (auth/AuthContext.tsx), so
 * `users/{uid}` may not exist yet when a User saves here. `updateDoc` throws on a missing
 * document; a merge `setDoc` creates it, so a save can't be permanently blocked by an earlier
 * silent create failure.
 */
export async function updateDisplayName(uid: string, displayName: string): Promise<void> {
  const trimmed = displayName.trim().slice(0, MAX_DISPLAY_NAME);
  if (!trimmed) return;
  // The user profile is deliberately global, while its public Player mirror is
  // Event-local. Capture the acted Event before the global write can yield so a
  // late Event A save never refreshes Event B's Player row.
  const eventId = EVENT_ID;
  await setDoc(rawUser(uid), { displayName: trimmed }, { merge: true });
  await updateExistingPlayer(uid, { displayName: trimmed }, eventId);
}

/**
 * Reuse `uploadAvatar` (storage.ts) — no new upload path — then flip `UserDoc.customPhoto` so Avatar prefers it.
 * Merge `setDoc` for the same missing-doc recovery reason as `updateDisplayName` above.
 */
export async function updateAvatar(uid: string, blob: Blob): Promise<string> {
  const eventId = EVENT_ID;
  const url = await uploadAvatar(uid, blob);
  await setDoc(rawUser(uid), { photoURL: url, customPhoto: true }, { merge: true });
  await updateExistingPlayer(uid, { photoURL: url }, eventId);
  return url;
}

/**
 * Refresh the Event-local Player mirror of a global profile edit — BEST EFFORT,
 * and explicitly skipped when the Event is frozen (#134, Codex P2 on PR #1139).
 *
 * The global write above has already committed by the time this runs: the User's
 * own identity is changed, and the two calls are not one transaction (they cannot
 * be — different roots). So a mirror failure must never surface as "the save
 * failed", or a Player editing their name on an archived Event is told their
 * profile did not save when it plainly did.
 *
 * `eventOpenForPlay` denies `players/{uid}` writes on BOTH halves of the freeze
 * — the Player row IS the standings — so this is a certainty on an archived or
 * closing Event rather than a risk. The rules are deliberately NOT loosened to
 * admit an identity-only update: the exemption would have to be carried by the
 * one arm the standings are frozen at.
 *
 * Two guards, because the read cannot be atomic with the write. The status read
 * skips the write we know is denied; the `permission-denied` catch covers the
 * Event that closes between the two. On this arm, for the row's own owner and a
 * patch that touches neither `reshufflesUsed` nor anyone else's row, the freeze
 * is the only thing that produces that code.
 */
async function updateExistingPlayer(
  uid: string,
  patch: { displayName?: string; photoURL?: string },
  eventId: string,
): Promise<void> {
  // An UNREADABLE Event reads as open and the write is attempted, which is
  // exactly what this function did before the read existed: the status decides
  // whether to skip a write, never whether the save may proceed, so a failed
  // read must not become a new way for a profile edit to fail.
  //
  // Only a SERVER-BACKED snapshot may skip (Codex P2 on PR #1157). Offline,
  // `getDoc` resolves from the persistent cache, and a cached `archiving: true`
  // can describe a quiesce another Admin has since lifted; skipping on it would
  // commit the global profile and drop the mirror for good, because nothing
  // queues a write that was never attempted. A cached closed state therefore
  // reads as open here and the write is attempted: if the freeze still holds,
  // the `permission-denied` catch below is the skip, one round trip later, and
  // if it was lifted the mirror lands when the device reconnects.
  const closed = await getDoc(rawEvent(eventId)).then(
    (snap) => {
      // A pending local close is not authoritative either (Phase 4b P2 on PR
      // #1157, run 3): `fromCache` and `hasPendingWrites` describe different
      // properties, and a refused close rolls back to open after this decision.
      if (snap.metadata?.fromCache || snap.metadata?.hasPendingWrites) return false;
      const event = snap.data() as Partial<EventDoc> | undefined;
      return isEventArchived(event) || isEventArchiving(event);
    },
    () => false,
  );
  if (closed) return;
  try {
    await updateDoc(rawPlayer(uid, eventId), patch);
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : null;
    // `not-found`: the Player never joined this Event, so there is no mirror to
    // refresh. `permission-denied`: the freeze landed between the read above and
    // this write — the same skip, one round trip later.
    if (code === 'not-found' || code === 'permission-denied') return;
    throw err;
  }
}
