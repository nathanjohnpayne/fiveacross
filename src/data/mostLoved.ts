// Most-Loved Photo (#534/#560, specs/most-loved-photo.md) — the CLIENT half of
// the frozen award contract. Pure, Firestore-free, React-free (the
// moderation.ts posture) so the finale surfaces, the parity test, and the
// analytics payload all share one derivation:
//
//   - `proofFeedVisible` re-states the Feed's exact visibility filter;
//   - `buildMostLovedPhotoAward` MIRRORS
//     `functions/src/finaleContent.ts#buildMostLovedPhotoAward` — the scheduler
//     computes and persists, this mirror exists so the semantics are pinnable
//     client-side; `tests/functions/most-loved-parity.test.ts` feeds one
//     fixture set to both and asserts identical output (ADR 0011's
//     pre-commitment: a mirror without a parity test is how mirrors drift);
//   - `mostLovedDisplayWinners` is the render-time gate honoring the
//     hidden-after-freeze rule (the award record never recomputes; DISPLAY
//     drops a winner whose live proof no longer survives the Feed filter);
//   - `mostLovedFrozenEventPayload` builds the `most_loved_photo_frozen`
//     analytics payload — ids and counts only, never media or display names.

import { isBanned, isReportHidden } from './moderation';
import type { HeartDoc, MostLovedPhotoAward, MostLovedPhotoWinner, ProofDoc } from '../types';

/** The subset of a `ProofDoc` the award computation reads. Structurally
 *  assignable to the functions-side `MostLovedProofLike`, so one fixture set
 *  can feed both builders in the parity test. */
export type MostLovedProofInput = Pick<
  ProofDoc,
  'id' | 'uid' | 'displayName' | 'type' | 'status' | 'reportCount' | 'createdAt' | 'itemText' | 'dayIndex'
>;

/** The subset of a `HeartDoc` the award computation reads. */
export type MostLovedHeartInput = Pick<
  HeartDoc,
  'uid' | 'targetKind' | 'targetId' | 'targetCreatedAt' | 'createdAt'
> & {
  /** The server creation time supplied by the scheduler's snapshot mapper. The
   *  client mirror accepts it so the parity test exercises the real freeze
   *  boundary; ordinary client HeartDocs intentionally have no such field. */
  serverCreatedAt?: number;
};

/** The eligibility/visibility options both builders share. */
export interface MostLovedAwardOptions {
  bannedUids: readonly string[];
  reportHideThreshold: number | undefined;
  cutoff: number;
  computedAt: number;
}

/**
 * The Feed's proof-visibility filter as ONE named predicate: `status ===
 * 'active'` (the Feed query's own constraint — excludes hidden/pending/flagged;
 * a deleted doc is absent from any read set by construction), NOT report-hidden
 * (fail-open threshold), and owner not banned.
 *
 * SEMANTICS SOURCE: `useProofFeed` (src/hooks/useData.ts) — its
 * `where('status', '==', 'active')` query plus its `isReportHidden`/`isBanned`
 * filter pair. Re-stated here rather than refactored out of the hook because
 * `useProofFeed` is a hot pre-freeze file this feature must not destabilize; if
 * the hook's filter ever changes, change this predicate with it.
 */
export function proofFeedVisible(
  proof: Pick<ProofDoc, 'uid' | 'status' | 'reportCount'>,
  reportHideThreshold: number | undefined,
  bannedUids: readonly string[],
): boolean {
  return (
    proof.status === 'active' &&
    !isReportHidden(proof.reportCount, reportHideThreshold) &&
    !isBanned(proof.uid, bannedUids)
  );
}

/**
 * Client mirror of the frozen-award computation — same semantics, rule by rule,
 * as `functions/src/finaleContent.ts#buildMostLovedPhotoAward` (see its doc
 * comment for the full eligibility mapping; the parity test pins the two):
 * eligible proofs are visible photo proofs (`proofFeedVisible` + `type ===
 * 'photo'`); eligible hearts match the proof's incarnation, are server-committed
 * at or before the cutoff (or use `createdAt` in the metadata-free fixture),
 * are never the owner's own heart, and never a banned Player's
 * heart (unconditionally — `heartState`'s display-only own-content exception
 * does NOT apply); the count is unique eligible heart uids; winners are every
 * eligible proof at the max count when max >= 1, ordered `proofCreatedAt` asc
 * then `proofId` asc; zero eligible hearts yields the EXPLICIT no-award record
 * `{ winners: [], heartCount: 0 }`.
 */
export function buildMostLovedPhotoAward(
  proofs: readonly MostLovedProofInput[],
  hearts: readonly MostLovedHeartInput[],
  opts: MostLovedAwardOptions,
): MostLovedPhotoAward {
  const eligible = proofs.filter(
    (p) => p.type === 'photo' && proofFeedVisible(p, opts.reportHideThreshold, opts.bannedUids),
  );
  const byId = new Map<string, MostLovedProofInput>();
  const heartUids = new Map<string, Set<string>>();
  for (const p of eligible) {
    byId.set(p.id, p);
    heartUids.set(p.id, new Set());
  }
  for (const h of hearts) {
    if (h.targetKind !== 'proof') continue;
    const p = byId.get(h.targetId);
    if (!p) continue;
    if (h.targetCreatedAt !== p.createdAt) continue; // another incarnation's heart
    const heartAt = h.serverCreatedAt ?? h.createdAt;
    if (!Number.isFinite(heartAt) || heartAt > opts.cutoff) continue;
    if (h.uid === p.uid) continue; // own heart on own proof does NOT count
    if (isBanned(h.uid, opts.bannedUids)) continue; // no own-content exception here
    heartUids.get(p.id)!.add(h.uid);
  }
  let max = 0;
  for (const uids of heartUids.values()) {
    if (uids.size > max) max = uids.size;
  }
  const winners: MostLovedPhotoWinner[] =
    max < 1
      ? []
      : eligible
          .filter((p) => heartUids.get(p.id)!.size === max)
          .map((p) => ({
            proofId: p.id,
            uid: p.uid,
            displayName: p.displayName,
            promptText: p.itemText,
            dayIndex: p.dayIndex ?? null,
            proofCreatedAt: p.createdAt,
          }))
          .sort(
            (a, b) =>
              a.proofCreatedAt - b.proofCreatedAt ||
              (a.proofId < b.proofId ? -1 : a.proofId > b.proofId ? 1 : 0),
          );
  return {
    winners,
    heartCount: max < 1 ? 0 : max,
    frozenAt: opts.cutoff,
    computedAt: opts.computedAt,
  };
}

/** One display-gated co-winner: the persisted award entry joined to its LIVE
 *  proof doc (which carries the media the award deliberately does not). */
export interface MostLovedDisplayWinner<T> {
  winner: MostLovedPhotoWinner;
  proof: T;
}

/**
 * The render-time display gate (the "hidden later" rule): join the persisted
 * winners against the LIVE, already-Feed-filtered proofs by `proofId` AND
 * incarnation (`proofCreatedAt === proof.createdAt`) AND `type === 'photo'`. A
 * winner with no surviving live proof is dropped FROM DISPLAY while the award
 * record stays untouched — if a winning photo is later hidden the award stays
 * recorded and the finale falls back to photo highlights. Order is the award's
 * own (earliest-posted first), so `[0]` is the share hero among the SURVIVING
 * winners. `liveProofs` must already be Feed-filtered (`useProofFeed`, or
 * `proofFeedVisible` applied by the caller); this gate adds only the join.
 */
export function mostLovedDisplayWinners<T extends Pick<ProofDoc, 'id' | 'type' | 'createdAt'>>(
  award: MostLovedPhotoAward | null | undefined,
  liveProofs: readonly T[],
): MostLovedDisplayWinner<T>[] {
  if (!award || award.winners.length === 0) return [];
  const byId = new Map<string, T>();
  for (const p of liveProofs) byId.set(p.id, p);
  const out: MostLovedDisplayWinner<T>[] = [];
  for (const winner of award.winners) {
    const proof = byId.get(winner.proofId);
    if (!proof) continue; // hidden/deleted after the freeze — display-only drop
    if (proof.createdAt !== winner.proofCreatedAt) continue; // another incarnation
    if (proof.type !== 'photo') continue; // defensive: the award only ever names photos
    out.push({ winner, proof });
  }
  return out;
}

/**
 * The `most_loved_photo_frozen` analytics payload (#560): ids and counts ONLY.
 * NEVER `mediaURL`/`thumbURL`/`storagePath`/display names — the winner shape
 * carries no media by design, and this builder additionally strips the display
 * name so no private media or PII rides the event. `award: false` (the
 * no-award record) is signal, not noise, so the caller fires it too.
 */
export function mostLovedFrozenEventPayload(award: MostLovedPhotoAward): {
  winnersCount: number;
  heartCount: number;
  tie: boolean;
  award: boolean;
  proofId: string | null;
  dayIndex: number | null;
} {
  const hero = award.winners.length > 0 ? award.winners[0] : null;
  return {
    winnersCount: award.winners.length,
    heartCount: award.heartCount,
    tie: award.winners.length > 1,
    award: award.winners.length > 0,
    proofId: hero ? hero.proofId : null,
    dayIndex: hero ? hero.dayIndex : null,
  };
}
