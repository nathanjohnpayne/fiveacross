import { deleteDoc, setDoc } from 'firebase/firestore';
import { heartRef } from './paths';
import { track } from '../analytics';
import { isBanned } from './moderation';
import type { HeartDoc, HeartTargetKind } from '../types';

/**
 * Hearts (specs/feed-hearts.md): one Player's like on a Feed post — a Proof or
 * a Moment. ONE deterministic doc per (Player, post) slot; the slot id — not
 * an update denial — is the once-only guarantee, so the owner may freely
 * overwrite their own slot (that is how a heart re-binds to a RECREATED post,
 * Codex P2 on #425) and counts still cannot inflate. Firestore's rules
 * re-check everything this module encodes (own uid, bound id, the target
 * existing with the declared incarnation stamp), so the client stays simple:
 * fire-and-forget writes whose latency-compensated echo flips the UI
 * instantly, with an online rejection rolled back by the listener.
 */

/** The deterministic Heart slot id — `_` joins, same as the Doubt slot: it
 * appears in no Firebase-minted uid and the id is constructed, never parsed. */
export function heartDocId(uid: string, targetKind: HeartTargetKind, targetId: string): string {
  return `${uid}_${targetKind}_${targetId}`;
}

/**
 * Set the caller's Heart on a post to the INTENDED state. `on` is what the
 * tap asked for — not derived from a possibly-stale render (Codex P2 on
 * #425's double-tap race: HeartButton tracks its own pending intent and
 * hands the resolved next state here). `targetCreatedAt` is the post's own
 * createdAt — the incarnation stamp the rules verify against the live
 * target doc. Fire-and-forget like setMark: offline both legs queue durably
 * (ADR 0006); an online rejection logs and self-corrects when the listener
 * rolls the optimistic doc back. Analytics fires only once the write
 * PERSISTS (the doubts posture — accurate-but-delayed beats inflated).
 */
export function setHeart(params: {
  uid: string;
  targetKind: HeartTargetKind;
  targetId: string;
  targetCreatedAt: number;
  on: boolean;
}): Promise<void> {
  const { uid, targetKind, targetId, targetCreatedAt, on } = params;
  const ref = heartRef(heartDocId(uid, targetKind, targetId));
  if (!on) {
    return deleteDoc(ref).then(
      () => track('heart_post', { targetKind, on: false }),
      (err: unknown) => {
        console.warn('[hearts] unheart rejected; the listener will re-sync', err);
      },
    );
  }
  const payload: Omit<HeartDoc, 'id'> = {
    uid,
    targetKind,
    targetId,
    targetCreatedAt,
    createdAt: Date.now(),
  };
  // setDoc, deliberately able to OVERWRITE the caller's own slot: re-hearting
  // a recreated post refreshes the incarnation stamp in place (the rules
  // allow owner create AND update under the same full validation).
  return setDoc(ref, payload).then(
    () => track('heart_post', { targetKind, on: true }),
    (err: unknown) => {
      console.warn('[hearts] heart rejected; the listener will re-sync', err);
    },
  );
}

/** A post's heart state as ONE derivation (pure — unit-tested directly): the
 * visible count and whether the viewer is among the hearts.
 *
 * `targetCreatedAt` scopes the count to THIS incarnation of the post (Codex
 * P2 on #425): a Heart left over from a deleted-then-recreated post (same
 * deterministic id, different createdAt) is excluded, so the new post starts
 * at zero and the viewer's stale slot reads unhearted — their next tap
 * overwrites it with the fresh stamp.
 *
 * Ban semantics mirror useAllDoubts' fromUid arm with the own-content
 * exception: a banned Player's hearts vanish from everyone else's counts,
 * but their OWN heart stays visible to themselves — otherwise their button
 * would read unhearted while the slot doc still exists, and the retap would
 * simply re-assert it forever. */
export function heartState(
  hearts: readonly Pick<HeartDoc, 'uid' | 'targetKind' | 'targetId' | 'targetCreatedAt'>[],
  targetKind: HeartTargetKind,
  targetId: string,
  targetCreatedAt: number,
  viewerUid: string | undefined,
  bannedUids: readonly string[] = [],
): { count: number; hearted: boolean } {
  let count = 0;
  let hearted = false;
  for (const h of hearts) {
    if (h.targetKind !== targetKind || h.targetId !== targetId) continue;
    if (h.targetCreatedAt !== targetCreatedAt) continue; // another incarnation's heart
    if (isBanned(h.uid, bannedUids) && h.uid !== viewerUid) continue;
    count += 1;
    if (viewerUid != null && h.uid === viewerUid) hearted = true;
  }
  return { count, hearted };
}
