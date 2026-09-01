import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { db, EVENT_ID } from '../firebase';
import { uploadAvatar } from './storage';

// Raw (converter-free) ref for writes — mirrors the private `rawUser` each
// writing data module keeps locally (see data/api.ts).
const rawUser = (uid: string) => doc(db, 'users', uid);
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

async function updateExistingPlayer(
  uid: string,
  patch: { displayName?: string; photoURL?: string },
  eventId: string,
): Promise<void> {
  try {
    await updateDoc(rawPlayer(uid, eventId), patch);
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'not-found') return;
    throw err;
  }
}
