import { collection, doc, increment, runTransaction, updateDoc } from 'firebase/firestore';
import { db, EVENT_ID } from '../firebase';
import { uploadProofMedia, deleteStoragePath } from './storage';
import { purgeProofMediaFromCaches } from './proofMediaCache';
import {
  clearProofMediaRevocation,
  drainProofMediaRevocations,
  queueProofMediaRevocation,
} from './proofMediaRevocations';
import { resolveProofMediaUrl } from './proofMediaUrl';
import { markerDisplayName } from './attribution';
import { boardFirstBingoAt, completedLines, countMarked, isBlackout, foldDayStat, type DayStats } from '../game/logic';
import { cellsPatch, changedCells, cellsFromData } from '../game/cells';
import { cellsMergeSet } from './cellsMerge';
import { directMarkAnalyticsRequest } from './markAnalytics';
import { isEventArchived, isEventArchiving } from './eventArchive';
import type { Cell, ClaimMode, EventDoc, ProofDoc, ProofType } from '../types';

const rawEvent = (eventId: string = EVENT_ID) => doc(db, 'events', eventId);
const rawProofs = (eventId: string = EVENT_ID) => collection(db, 'events', eventId, 'proofs');
const rawProof = (id: string, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'proofs', id);
const rawClaims = (eventId: string = EVENT_ID) => collection(db, 'events', eventId, 'claims');
const rawBoard = (uid: string, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'boards', uid);
// The day-scoped Board write ref (#246, daily-cards-spec § "Data model"): one
// Board per Player per Day at events/{eventId}/days/{dayIndex}/boards/{uid}.
// `String(dayIndex)` is the canonical decimal segment the rules gate accepts (#201).
const rawDayBoard = (dayIndex: number, uid: string, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'days', String(dayIndex), 'boards', uid);
const rawPlayer = (uid: string, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'players', uid);

/**
 * The `{ merge: true }` player-stats write a proofed Mark / proof deletion
 * commits: in daily-cards mode (#246) the per-Board result is ONE Day Card's
 * bucket, folded into `players/{uid}.dayStats[dayIndex]` with the cruise-wide
 * root aggregates re-derived (`foldDayStat`) — exactly what the honor-Mark path
 * (`setMark` → `foldDayStat`) writes, so both paths share the scoring shape and a
 * proofed win on Day N credits Day N alone. In legacy mode it is the pre-1.5
 * flat root write. `tutorialDayIndexes` scopes the cruise-wide First-to-BINGO
 * exclusion (spec § "Resolved decisions" #2); absent excludes nothing.
 */
function playerStatWrite(params: {
  daily: boolean;
  dayIndex: number;
  priorDayStats: DayStats | undefined;
  bingoCount: number;
  squaresMarked: number;
  firstBingoAt: number | null;
  blackout: boolean;
  tutorialDayIndexes?: number[];
  // #265: ceremonial (farewell) buckets never enter the summed root totals.
  ceremonialDayIndexes?: number[];
}) {
  const { daily, dayIndex, priorDayStats, bingoCount, squaresMarked, firstBingoAt, blackout } = params;
  if (!daily) return { squaresMarked, bingoCount, firstBingoAt, blackout };
  return foldDayStat({
    priorDayStats,
    dayIndex,
    bucket: { bingoCount, squaresMarked, firstBingoAt },
    blackout,
    isTutorialDay: params.tutorialDayIndexes
      ? (i: number) => params.tutorialDayIndexes!.includes(i)
      : undefined,
    isCeremonialDay: params.ceremonialDayIndexes
      ? (i: number) => params.ceremonialDayIndexes!.includes(i)
      : undefined,
  });
}
// A per-Prompt Tally marker: events/{EVENT_ID}/tally/{itemId}/markers/{uid} (ADR
// 0002) — the SAME path setMark's honor-Mark marker uses. Raw ref (converter-free),
// matching the board/player/proof writes in these transactions and setMark's write.
const rawMarker = (itemId: string, markerUid: string, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'tally', itemId, 'markers', markerUid);

export interface AttachProofArgs {
  uid: string;
  displayName: string;
  photoURL: string | null;
  cells: Cell[];
  cellIndex: number;
  // The backing cell's Prompt id, for the per-Prompt Tally marker (ADR 0002).
  // `null` for the free centre — which never opens ProofSheet, so this is
  // defensive; a null itemId simply publishes no marker.
  itemId: string | null;
  itemText: string;
  claimMode: ClaimMode;
  currentFirstBingoAt: number | null;
  // Which affordance produced a photo — 📷 camera or 🖼️ library (#190). Stamped
  // from the ProofSheet input, NOT inferred from EXIF; the Feed badges 🖼️.
  source?: 'camera' | 'library';
  // The Day this Proof belongs to, so the Feed reads "Day 2 · Get Sporty".
  dayIndex?: number;
  // Daily-cards mode (#246): write the DAY-SCOPED board + fold the player stats
  // into `dayStats[dayIndex]` (see `playerStatWrite`). Absent/false keeps the
  // pre-1.5 single-board flat write. `tutorialDayIndexes` scopes the cruise-wide
  // First-to-BINGO exclusion.
  daily?: boolean;
  tutorialDayIndexes?: number[];
  // #265: the ceremonial (farewell) Day indexes + the standings-freeze gate —
  // same contract as setMark's (the fold excludes ceremonial buckets from the
  // root sums; a frozen event narrows to the ceremonial bucket-only write).
  // Accepts a GETTER so the gate is evaluated INSIDE the transaction, after a
  // slow photo/audio upload — a submission started seconds before 08:00 must
  // not fold with a pre-freeze capture (Codex P2 on #278 round 3).
  ceremonialDayIndexes?: number[];
  statsFrozen?: boolean | (() => boolean);
  // Strip EXIF/GPS from a photo before upload (event `stripPhotoExif`, default
  // true); threaded straight to uploadProofMedia — this layer never reads the blob.
  stripExif?: boolean;
  proof: { type: ProofType; blob?: Blob; text?: string };
}

/**
 * The win verdict a proofed Mark reports back to Board — the SAME shape `setMark`
 * returns (issue #104 / PR #110 round 2 finding 1), so both completing-mark paths
 * feed one broadcast helper. `bingo`/`blackout` are the STANDING state of the
 * folded board; the transitions are the rising EDGE this attach crossed
 * (no-win → win), computed against the LIVE prior cells the transaction read.
 * In `admin_confirmed` mode the attached cell goes `pending`, and the win mask
 * (game/logic: `marked && status !== 'pending'`) excludes it — so an
 * admin-confirmed attach structurally crosses NO transition and broadcasts no
 * Moment at attach time. That is a decision, not an accident: a pending claim
 * can be REJECTED, and a Moment is IMMUTABLE (delete-only moderation) — an
 * attach-time broadcast would leave a permanent win announcement for a claim an
 * admin then rejects. The tally-marker analogy (which does publish at attach,
 * #87) does not carry: `rejectClaim` deletes the marker on rejection, but no
 * automatic cleanup path exists for a Moment. The admin-confirmed win (and its
 * Moment) materialize at admin confirm — the #41 deferral. `cells` is the folded
 * post-attach board, for fire-time revalidation in the drain.
 */
export interface AttachProofResult {
  cells: Cell[];
  bingo: boolean;
  blackout: boolean;
  bingoTransition: boolean;
  blackoutTransition: boolean;
  // The false→true edge on THIS cell (#721, Codex round 1 finding 6), derived
  // from the transaction's OWN `existingCell` read — the committed board
  // state, not the caller's sheet-opening snapshot. A concurrent write from
  // another device (or tab) can mark this Square between the sheet opening
  // and this transaction's read; `attachProof` still runs and merely attaches
  // proof to an already-marked cell, so the caller's stale `!cell.marked`
  // check would wrongly read that as a transition and fire a second
  // `mark_square` for a Square that was already credited. The caller must gate
  // its `mark_square` emission on THIS field, not its own opening snapshot.
  markTransition: boolean;
}

/**
 * Mark a square and attach a playful proof (ADR 0002: the Proof IS the Feed
 * entry — a bare Mark posts nothing, an attached Proof posts here). In
 * admin_confirmed mode the square goes pending (doesn't count) and a claim is
 * created for an admin/peer to confirm. A Proof is flavour, never enforcement
 * (ADR 0001): it enriches the Feed, it does not make the Mark more trustworthy.
 *
 * Online-only, by design AND by rule (ADR 0006) — unlike a bare honor Mark
 * (`setMark`), attachProof does NOT queue offline:
 *   - it runs in a `runTransaction`, which needs a server round-trip and REJECTS
 *     offline (the read-modify-write folds onto the LIVE board/player so a
 *     concurrent admin resolve / another of the owner's tabs isn't clobbered),
 *     and
 *   - a photo/audio proof is unwritable before its media exists: firestore.rules
 *     pins `storagePath`/`mediaURL` to the EXACT uploaded Storage object, and a
 *     Storage upload needs signal — so a media proof doc can't be queued ahead of
 *     its upload. (A text proof carries no media, but still rides the same
 *     rejecting transaction.)
 * The offline-durable path is therefore the bare honor Mark; the Proof and its
 * media attach when connectivity returns (ADR 0006: "marks queue, proof media
 * doesn't"). Capture-then-retry lives in `ProofSheet`: a failed submit keeps the
 * captured blob/text in component state so the Player retries without
 * re-capturing — durable for the session, NOT across a reload (only the honor
 * Mark survives a reload).
 *
 * The proof→cell link is authoritative in the proof DOC (`uid` + `cellIndex`),
 * which this writes; `cells[i].proofId` is only a denormalized projection a
 * queued bare-Mark drain can wholesale-replace and drop
 * (specs/w1-board-mark-win.md § cross-writer). This is what discharges that
 * constraint for proof-capture: the Feed (`ProofFeed`/`useProofFeed`) renders
 * every entry from this doc, never from `cells`, so a dropped `proofId` never
 * removes a Proof from the Feed. `deleteProof` looks the backing cell up by
 * this same `cellIndex` rather than scanning for `proofId` — equivalent to the
 * scan given `proofId`'s uniqueness, so this is a clarity change, not a new
 * protection; see its own comment for what it does and does not do once a
 * drain has actually clobbered the projection.
 */
export async function attachProof(args: AttachProofArgs): Promise<AttachProofResult> {
  const { uid, displayName, photoURL, cells, cellIndex, itemId, itemText, claimMode, currentFirstBingoAt, source, dayIndex, daily, tutorialDayIndexes, ceremonialDayIndexes, statsFrozen, stripExif, proof } =
    args;
  const eventId = EVENT_ID;
  const now = Date.now();
  const pRef = doc(rawProofs(eventId));
  const proofId = pRef.id;

  let storagePath: string | null = null;
  let mediaURL: string | null = null;
  if ((proof.type === 'photo' || proof.type === 'audio') && proof.blob) {
    // Only photos carry EXIF/GPS; the strip flag is inert for audio.
    const up = await uploadProofMedia(uid, proofId, proof.blob, proof.type, {
      stripExif,
      eventId,
    });
    storagePath = up.path;
    mediaURL = up.url;
  }

  const pending = claimMode === 'admin_confirmed';
  // Stable across every transaction retry. It is written only for the
  // committed false→true edge below, where the server observer turns it into
  // the durable analytics record even if this tab closes immediately after.
  const analyticsRequest = directMarkAnalyticsRequest({
    cellIndex,
    marked: true,
    mode: claimMode,
    source: 'proof',
    eventId,
  });

  // Recompute cells from the live board inside a transaction so a concurrent
  // mark from another tab/device isn't clobbered by this caller's stale snapshot.
  // The transaction callback RETURNS the win verdict (PR #110 round 2 finding 1 —
  // return-shape only; the write set is untouched): on a retry the callback
  // re-runs against fresh reads, so the verdict always describes the COMMITTED
  // attempt's fold. runTransaction resolves with the callback's return value.
  //
  // A REJECTED transaction ROLLS THE UPLOAD BACK (see the `.catch` below).
  return await runTransaction(db, async (tx): Promise<AttachProofResult> => {
    // Daily mode (#246): the Mark lives on the DAY-SCOPED board and its stats fold
    // into that Day's bucket — the SAME routing the honor Mark (`setMark`) uses, so
    // a proofed claim on the viewed Day never writes the (now rules-denied) legacy
    // board nor double-credits another Day. Legacy mode is unchanged.
    const boardRef = daily === true
      ? rawDayBoard(dayIndex ?? 0, uid, eventId)
      : rawBoard(uid, eventId);
    const playerRef = rawPlayer(uid, eventId);
    const markerRef = itemId ? rawMarker(itemId, uid, eventId) : null;
    // Read board + player before any write — a Firestore transaction requires ALL
    // reads before the FIRST write. The existing Tally marker is read HERE with
    // them (never down at its write below): attaching a Proof to an ALREADY-marked
    // square must preserve the marker's original markedAt (Codex P2, PR #87), and
    // that needs a read the transaction contract forbids once anything is written.
    const boardSnap = await tx.get(boardRef);
    const playerSnap = await tx.get(playerRef);
    const markerSnap = markerRef ? await tx.get(markerRef) : null;
    const boardData = boardSnap.data() as { cells?: unknown; seed?: number } | undefined;
    const liveRaw = cellsFromData(boardData?.cells);
    const liveCells = liveRaw.length > 0 ? liveRaw : cells;
    const existingCell = liveCells.find((cell) => cell.index === cellIndex);
    // The COMMITTED false→true edge (#721, Codex round 1 finding 6): derived
    // from this transaction's own live read, never the caller's
    // sheet-opening snapshot — see `AttachProofResult.markTransition`'s doc
    // comment for why the caller's own `cell` prop cannot be trusted here.
    const markTransition = existingCell?.marked !== true;
    // A confirmed Echo has already passed the original admin confirmation. Adding
    // proof makes it a local mark, but must not create a second pending claim.
    const pendingClaim = pending && !(existingCell?.echo === true && existingCell.status === 'confirmed');
    const next: Cell[] = liveCells.map((c) => {
      if (c.index !== cellIndex) return c;
      // A proof creates a durable artifact anchored to this card. It must turn
      // an Echo into a local Mark so the reshuffle gate cannot trade the card
      // away and strand that artifact.
      const { echo: _echo, echoOptOut: _echoOptOut, ...proofed } = c;
      return { ...proofed, marked: true, markedAt: now, proofId, status: pendingClaim ? 'pending' : 'confirmed' };
    });

    const bingoCount = completedLines(next).length;
    const squares = countMarked(next);
    const blackout = isBlackout(next);
    // Derive firstBingoAt from the live player row, not the caller's stale prop,
    // so a concurrent proof/mark can't overwrite an earlier first-bingo stamp;
    // clear it when no bingo stands (mirrors setMark/deleteProof). In daily mode
    // the stamp being preserved is the VIEWED Day's bucket, never the Event-wide
    // root (#1049) — `boardFirstBingoAt` owns that choice for every write path.
    const livePlayer = playerSnap.data() as
      | { firstBingoAt?: number | null; dayStats?: DayStats }
      | undefined;
    // The caller's sheet prop is a fallback for an UNREADABLE Player row ONLY —
    // never for a live row whose Board stamp is explicitly absent (Codex P2,
    // round 2). A `??` chain over the live value cannot tell those apart, so it
    // revived a stamp the transaction had just been told is gone: another tab
    // removing this Day's last line clears the bucket, and the proof that
    // re-completes the line must stamp `now`. That misread is worst on a
    // Tutorial or ceremonial Day, whose Event root legitimately stays `null`
    // while the sheet still holds the Day's old instant.
    const existingFirst =
      livePlayer === undefined
        ? (currentFirstBingoAt ?? null)
        : boardFirstBingoAt(livePlayer, daily === true, dayIndex ?? 0);
    const firstBingoAt = bingoCount > 0 ? (existingFirst ?? now) : null;

    tx.set(pRef, {
      uid,
      displayName,
      photoURL,
      type: proof.type,
      cellIndex,
      itemText,
      storagePath,
      mediaURL,
      thumbURL: null,
      text: proof.text ?? null,
      createdAt: now,
      reportCount: 0,
      // Admin-confirmed-mode proofs stay 'pending' (admin-only readable) until an admin
      // confirms the claim; otherwise the proof is public immediately.
      status: pendingClaim ? 'pending' : 'active',
      visionFlag: null,
      // #190: stamp which affordance produced a photo so the Feed badges a
      // library pick 🖼️; null for audio/text and camera picks that pass none.
      source: source ?? null,
      // The Day this claim belongs to, so the Feed reads "Day 2 · Get Sporty".
      dayIndex: typeof dayIndex === 'number' ? dayIndex : null,
    });
    // Per-cell merge (#457): only the proofed cell rides the write.
    tx.set(
      boardRef,
      ...cellsMergeSet(cellsPatch(changedCells(liveCells, next)), {
        ...(typeof boardData?.seed === 'number' ? { markSeed: boardData.seed } : {}),
        ...(markTransition ? { directAnalyticsRequest: analyticsRequest } : {}),
      }),
    );
    // The standings freeze (#265): a post-freeze proofed Mark keeps the card +
    // Tally + Proof honest and still records its PER-DAY bucket (the farewell
    // daily honor reads it — Codex P2 on #278); the ROOT aggregates stop
    // moving (bucket-only write). A frozen LEGACY event cannot arise (no
    // schedule → standingsFrozen is false), so the legacy flat write needs no
    // frozen arm.
    {
      const frozenNow = typeof statsFrozen === 'function' ? statsFrozen() : statsFrozen === true;
      const statWrite = playerStatWrite({
        daily: daily === true,
        dayIndex: dayIndex ?? 0,
        priorDayStats: playerSnap.data()?.dayStats as DayStats | undefined,
        bingoCount,
        squaresMarked: squares,
        firstBingoAt,
        blackout,
        tutorialDayIndexes,
        ceremonialDayIndexes,
      });
      if (frozenNow && daily === true && 'dayStats' in statWrite && ceremonialDayIndexes?.includes(dayIndex ?? 0)) {
        // Post-freeze, only the ceremonial (farewell) Day's bucket records —
        // any other Day's bucket would still drift the settled daily honors
        // (Codex P2 on #278 round 2).
        tx.set(playerRef, { dayStats: statWrite.dayStats }, { merge: true });
      } else if (!frozenNow) {
        tx.set(playerRef, statWrite, { merge: true });
      }
    }
    // Per-Prompt Tally (ADR 0002): a proofed Mark self-publishes the SAME attributed
    // marker a bare honor Mark does (setMark) — EVERY Mark, proofed or not, tallies.
    // The cell above is set marked:true in BOTH claim modes (proof_required →
    // 'confirmed', admin_confirmed → 'pending'), so the marker publishes here under
    // the SAME condition as the cell becoming marked — exactly as setMark writes it
    // on `nextMarked` regardless of pending/confirmed status. The marker doc id IS
    // the marker uid so firestore.rules keeps a forged attribution out; the name is
    // bounded to the rule's non-empty ≤100 contract via `markerDisplayName` (shared
    // with setMark), falling back to the live player row already read above. The free
    // centre never opens ProofSheet (no itemId), but guard defensively. Because it
    // rides this runTransaction, the marker is ONLINE-only like the proof itself (ADR
    // 0006): a transaction rejects offline and never queues. The marked→unmarked
    // symmetry is kept by every unmark path: setMark (bare unmark), deleteProof
    // (below), and rejectClaim (src/data/admin.ts) when an admin rejects a pending
    // claim — wherever a cell flips marked→unmarked, that cell's marker is deleted.
    //
    // A Proof attached to an ALREADY-marked square (the cell's proofbtn) must not
    // re-stamp the marker: the who-list is chronological by FIRST mark, and
    // overwriting markedAt with `now` would reorder it by proof-attach time (Codex
    // P2, PR #87). Preserve an existing marker's original markedAt — refreshing
    // uid/displayName is fine — and stamp `now` only when no marker exists yet (a
    // fresh mark, or a legacy pre-Tally mark that never had one). The merge also
    // preserves an existing Day/feed stamp while this write refreshes the
    // canonical path Event, Prompt text, and supplied Day identity (#1072).
    if (markerRef) {
      const priorMarkedAt = (markerSnap?.data() as { markedAt?: unknown } | undefined)?.markedAt;
      tx.set(
        markerRef,
        {
          uid,
          eventId,
          displayName: markerDisplayName(displayName, playerSnap.data()?.displayName),
          markedAt: typeof priorMarkedAt === 'number' ? priorMarkedAt : now,
          itemText,
          ...(typeof dayIndex === 'number' ? { dayIndex } : {}),
        },
        { merge: true },
      );
    }
    if (pendingClaim) {
      tx.set(doc(rawClaims(eventId)), {
        uid,
        displayName,
        cellIndex,
        itemText,
        proofId,
        status: 'pending',
        createdAt: now,
        resolvedBy: null,
        // In daily mode the pending mark lives on the DAY-SCOPED board, so the
        // Claim carries its `dayIndex` — `confirmClaim`/`rejectClaim` resolve
        // against that board + fold `dayStats[dayIndex]` (#246, Codex #247 P2).
        // Omitted (not `undefined`, which Firestore rejects) in legacy mode.
        ...(daily === true ? { dayIndex: dayIndex ?? 0 } : {}),
      });
    }
    // The verdict (see AttachProofResult): standing state from the fold, rising
    // edges against the LIVE prior cells this transaction read. In
    // admin_confirmed the folded cell is `pending` and the win mask excludes it,
    // so both transitions are structurally false — no Moment fires at attach.
    return {
      cells: next,
      bingo: bingoCount > 0,
      blackout,
      bingoTransition: completedLines(liveCells).length === 0 && bingoCount > 0,
      blackoutTransition: blackout && !isBlackout(liveCells),
      markTransition,
    };
  }).catch(async (err: unknown) => {
    // ROLL THE UPLOAD BACK WHEN THE TRANSACTION LOSES (Codex P1, PR #1157).
    // The media is uploaded BEFORE the transaction and has to be — the Proof
    // document's `storagePath`/`mediaURL` are pinned to the exact object by
    // `firestore.rules`, so there is nothing to write until the object exists.
    // Every rejection therefore leaves a blob no document points at, and the
    // freeze made one of those rejections routine: an Admin committing
    // `archiving: true` in the window between `uploadProofMedia` resolving and
    // this transaction reading denies the write, and the archive keeps the blob
    // forever — the one Event where nothing can be re-posted acquiring litter
    // is exactly what the document/media freeze exists to prevent.
    //
    // So the object is deleted here. `storage.rules` authorises it in every
    // state, including after the close, because its ORPHAN carve-out asks
    // whether a Proof document points at the media rather than whether the
    // Event is open — and after a rejected transaction none does.
    //
    // BEST EFFORT, and the ORIGINAL error is what the caller sees. The cleanup
    // is a courtesy on a path that has already failed; a cleanup that fails too
    // (offline, a Storage hiccup) must not replace "your proof did not post"
    // with a Storage error the Player can do nothing with. `ProofSheet` keeps
    // the captured blob either way, so a retry re-uploads under a NEW proof id
    // and never depends on this object surviving.
    if (storagePath) await deleteStoragePath(storagePath).catch(() => undefined);
    throw err;
  });
}

export async function reportProof(id: string): Promise<void> {
  await updateDoc(rawProof(id), { reportCount: increment(1) });
}

/**
 * The moderation delete REFUSED, because the Proof still backs a marked cell on
 * an Event that is merely CLOSING (#134, Phase 4b P2 on PR #1157 run 4).
 *
 * The archived skip and the closing skip look the same and are not the same
 * thing. ARCHIVED is permanent: Marks can never move again, so the cell the
 * deleted Proof backed is exactly as frozen as everything around it and there
 * is nothing to repair — the skip is correct and stays. CLOSING is REVERSIBLE
 * by design, and skipping there leaves live gameplay inconsistent the moment an
 * Admin reopens play: a marked cell backed by a Proof that no longer exists,
 * counted in the owner's squares and lines, with a Tally marker still standing
 * behind it. Nothing puts that right later, because the delete that would have
 * done it has already been reported as clean.
 *
 * So the transaction refuses instead of skipping, and says what the Admin has
 * to do first. Reopening play is one tap away in Game settings and makes the
 * delete the ordinary one, cleanup included; the alternative — attempting the
 * cleanup — is the denial that used to take the whole takedown down with it.
 * A Proof that backs NOTHING (already unmarked, or never on a cell) still
 * deletes in either state, because there is nothing to keep consistent.
 */
export class ProofBacksMarkWhileClosingError extends Error {
  constructor(readonly proofId: string) {
    super(
      'This photo still backs a marked square. Reopen play first, then delete it—while play is closed the square cannot be unmarked.',
    );
    this.name = 'ProofBacksMarkWhileClosingError';
  }
}

export async function deleteProof(
  id: string,
  storagePath?: string | null,
  // Daily-cards mode (#246): unmark the backing cell on the DAY-SCOPED board for
  // the Proof's OWN `dayIndex` and fold the owner's stats into that Day's bucket,
  // mirroring `attachProof`. Absent/false keeps the pre-1.5 flat single-board
  // unmark. `tutorialDayIndexes` scopes the cruise-wide First-to-BINGO exclusion.
  opts?: {
    daily?: boolean;
    dayIndexes?: number[];
    tutorialDayIndexes?: number[];
    ceremonialDayIndexes?: number[];
    statsFrozen?: boolean | (() => boolean);
  },
): Promise<void> {
  const eventId = EVENT_ID;
  // COMMIT FIRST, THEN REVOKE THE MEDIA — for the owner and the Admin alike
  // (Codex P1, PR #1157).
  //
  // Storage first is what main shipped, and the freeze is what makes it wrong.
  // An owner's delete that starts while the Event is open can revoke the media
  // and then lose its Firestore transaction to an Admin's quiesce: the Proof
  // survives, pointing at media that is gone, on the one Event where nothing
  // can be re-posted — and there is no way back, because the owner's document
  // delete is now denied and the object it named is already deleted. Committing
  // first inverts that into the recoverable direction: a delete that loses the
  // race changes nothing at all, and a delete that wins leaves at worst an
  // ORPHANED blob, which `storage.rules` lets its owner clear in every state
  // precisely because no Proof document points at it any more.
  //
  // THE RETRY THAT MAKES IT SAFE. Round 1 of this review rejected the same
  // inversion because the commit takes the Proof, its `storagePath` and the
  // surface that offered the delete all at once, so a post-commit Storage
  // failure had nothing left to retry from. `proofMediaRevocations.ts` is that
  // record: a failed revocation is queued to `localStorage` before the error
  // reaches the caller, and drained on the next app start and at the top of the
  // next delete. It is durable on THIS DEVICE only — the server-side tombstone
  // and sweeper in
  // [#1153](https://github.com/nathanjohnpayne/fiveacross/issues/1153) are what
  // close the never-returns and cross-device cases.
  //
  // Drain first, so a delete taken on this device is also the moment a previous
  // one gets its retry. Never throws, so it cannot become a new way for a
  // takedown to fail.
  // Kicked off, NOT awaited (Phase 4b P2 on PR #1157 run 2): the queue can hold
  // up to fifty historical Storage retries, and a Storage outage must not stall
  // a new takedown that only needs Firestore. The drain runs independently
  // beside this delete; it also runs on every sign-in.
  void drainProofMediaRevocations(eventId).catch(() => undefined);

  // Captured from the proof doc the transaction reads, so the post-commit
  // purge below (#373) targets the SAME media the Storage delete revokes.
  // Declared outside the callback because a Firestore transaction can retry:
  // each attempt reassigns it, so only the committed attempt's value survives
  // to the purge call.
  let mediaURL: string | null | undefined;

  // THE DELETION INTENT, RECORDED BEFORE THE TRANSACTION IS SENT (Phase 4b P2
  // on PR #1157 run 4).
  //
  // Recording it after `runTransaction` RESOLVES covered the wrong window.
  // Firestore can ACCEPT the commit and the tab die before the acknowledgement
  // gets back — and the commit takes the Proof, its `storagePath` and the
  // surface that offered the delete with it, so nothing on this device knows
  // an object was ever meant to go. Writing the record first means the window
  // is covered from the moment the write could possibly land, which is exactly
  // what the round-5 finding asked of the failure handler and this asks of the
  // whole transaction.
  //
  // It runs AFTER the drain above, deliberately: `drainProofMediaRevocations`
  // snapshots the queue synchronously before its first await, so the drain this
  // call kicked off can never see this call's own intent and decide — correctly
  // for a killed tab, wrongly for a delete still in flight — that the surviving
  // Proof document means the object must be kept.
  if (storagePath) queueProofMediaRevocation(storagePath, eventId);

  try {
    await runTransaction(db, async (tx) => {
      const proofRef = rawProof(id, eventId);
      // THE EVENT, READ INSIDE THE TRANSACTION THAT WRITES (#134, Codex P2 on PR
      // #1139). The moderation delete is an admin path the freeze deliberately
      // leaves open — a permanent record needs a takedown route (#808) — but the
      // GAMEPLAY cleanup below is not: unmarking the backing cell writes a Board,
      // a Player row and a Tally marker, and `eventOpenForPlay` denies all three.
      // One transaction, so the denial would take the DELETE down with it and the
      // advertised takedown would fail outright on exactly the Event whose play
      // can never resume.
      //
      // So the cleanup is SKIPPED on an ARCHIVED Event rather than attempted:
      // there is nothing for it to repair. Marks can never move again, so the
      // cell the deleted Proof backed is exactly as frozen as everything around
      // it. What the delete still does is what a takedown is for: the document
      // leaves the Feed and the media leaves Storage.
      //
      // THE TWO HALVES OF THE FREEZE PART COMPANY HERE (Phase 4b P2 on PR #1157
      // run 4). Closing is REVERSIBLE, so the same skip is not harmless there: an
      // Admin reopens play and the Board still carries a marked cell backed by a
      // Proof that no longer exists, counted in the owner's squares and lines,
      // with its Tally marker standing. Nothing repairs that afterwards, because
      // the delete that would have has already reported success. So a Proof that
      // backs a marked cell is REFUSED while closing, with the way through named
      // in the error — see `ProofBacksMarkWhileClosingError`.
      //
      // Read inside the transaction, not before it: a transaction serializes
      // against the documents it READS, and the quiesce writes this one — so a
      // close committing in the window aborts this attempt and the retry re-reads
      // the closed state, instead of a cleanup landing on a Board the freeze has
      // already shut.
      const eventData = (await tx.get(rawEvent(eventId))).data() as Partial<EventDoc> | undefined;
      const archived = isEventArchived(eventData);
      const closing = !archived && isEventArchiving(eventData);
      const proofSnap = await tx.get(proofRef);
      const proof = proofSnap.data() as ProofDoc | undefined;
      mediaURL = proof?.mediaURL;

      // `!archived` rather than "not closed": an archived Event needs none of
      // this and reads nothing, while a CLOSING one still has to learn whether
      // the Proof backs a marked cell before it can decide between deleting and
      // refusing. Reading the Board while closing costs one `get` on a document
      // no one may write in that state.
      if (proof && !archived) {
        // A deleted proof must not leave its square marked-but-uncredited (in
        // proof_required mode a marked cell is backed by this proof). Unmark the
        // backing cell and recompute the owner's derived stats in the same txn.
        const daily = opts?.daily === true;
        const proofDayIndex = typeof proof.dayIndex === 'number' ? proof.dayIndex : 0;
        const boardRef = daily
          ? rawDayBoard(proofDayIndex, proof.uid, eventId)
          : rawBoard(proof.uid, eventId);
        const playerRef = rawPlayer(proof.uid, eventId);
        const boardSnap = await tx.get(boardRef);
        const boardData = boardSnap.data() as { cells?: unknown; seed?: number } | undefined;
        const normalized = cellsFromData(boardData?.cells);
        const cells = normalized.length > 0 ? normalized : undefined;
        // Resolve the backing cell from the proof's OWN cellIndex — the
        // authoritative proof→cell link (specs/w1-board-mark-win.md § cross-writer)
        // — rather than scanning for `cells[i].proofId === id`. Given `proofId`'s
        // uniqueness and that a proof's `cellIndex` never changes after creation,
        // the two lookups pick out the same cell in every reachable state: this is
        // a clarity/consistency change, not a new protection, and it does NOT
        // recover a clobbered projection. A queued bare-Mark drain does a
        // whole-array { merge:true } replace of `cells` and can drop the
        // `proofId` at `cellIndex`; once that has happened, this lookup sees the
        // same dropped value a `cells.some(c => c.proofId === id)` scan would have
        // seen, so the guard below no-ops identically either way. We gate the
        // unmark on `proofId === id` so we never fight a bare Mark that has since
        // taken the cell over — if the projection was dropped, the drained bare
        // Mark owns the cell and deleteProof leaves it (accepted residual, ADR
        // 0001) rather than un-marking a live Mark. What DOES discharge the PR #75
        // constraint for proof-capture is that the Feed resolves a Proof from this
        // doc's own `uid`/`cellIndex`, never solely from `cells[i].proofId` — see
        // `ProofFeed`/`useProofFeed`.
        const backing = cells?.find((c) => c.index === proof.cellIndex);
        if (cells && backing && backing.proofId === id) {
          // THE REFUSAL, and only for the reversible half of the freeze. Nothing
          // has been written yet — the throw aborts the transaction before the
          // Proof delete below, so the document, the Board and the media are all
          // exactly as they were, and the caller is told to reopen play first.
          if (closing) throw new ProofBacksMarkWhileClosingError(id);
          const playerSnap = await tx.get(playerRef);
          // A proof can turn an Echo into a local proof-backed Mark while the
          // original source remains confirmed on a sibling day. The tally marker
          // is global per (Prompt, Player), so its deletion must see every known
          // day board before removing a still-standing source's marker.
          const siblingBoards =
            daily && backing.itemId
              ? await Promise.all(
                  (opts?.dayIndexes ?? [])
                    .filter((dayIndex) => dayIndex !== proofDayIndex)
                    .map((dayIndex) => tx.get(rawDayBoard(dayIndex, proof.uid, eventId))),
                )
              : [];
          // The stamp a deletion preserves belongs to the Day whose Board it is
          // unmarking (#1049): when a line still stands on THIS Day, that Day's
          // own bucket keeps its instant — reading the Event-wide root here would
          // write some other Day's First-to-BINGO into it. Legacy events have one
          // bucket, so the root is that Board's stamp and is read unchanged.
          // Deletion takes no caller-supplied stamp at all, so there is no stale
          // prop to fall back to and none of `attachProof`'s revival hazard: the
          // live row IS the only source, and an unreadable one reads as no stamp.
          const existingFirst = boardFirstBingoAt(
            playerSnap.data() as { firstBingoAt?: number | null; dayStats?: DayStats } | undefined,
            daily,
            proofDayIndex,
          );
          const next: Cell[] = cells.map((c) => {
            if (c.index !== proof.cellIndex) return c;
            // Deleting a proof unmarks the cell — mirror computeMark's manual
            // unmark EXACTLY (Phase 4b P1 on #447): strip any echo flag and
            // persist `echoOptOut` on a non-free Prompt cell, so open-time
            // reconciliation cannot restore the Prompt from a standing sibling
            // and undo the deletion the Player just performed. A later manual
            // re-mark clears the opt-out, exactly as after a manual unmark.
            const { echo: _echo, echoOptOut: _echoOptOut, ...manual } = c;
            return {
              ...manual,
              marked: false,
              markedAt: null,
              proofId: null,
              status: 'confirmed' as const,
              ...(!c.free && c.itemId !== null ? { echoOptOut: true } : {}),
            };
          });
          const bingoCount = completedLines(next).length;
          const squares = countMarked(next);
          const blackout = isBlackout(next);
          const firstBingoAt = bingoCount > 0 ? existingFirst : null;
          tx.set(
            boardRef,
            // Per-cell merge (#457): only the cleared cell rides the write.
            ...cellsMergeSet(cellsPatch(changedCells(cells, next)), {
              ...(typeof boardData?.seed === 'number' ? { markSeed: boardData.seed } : {}),
            }),
          );
          // The standings freeze (#265): a post-freeze proof deletion unmarks the
          // cell and updates its PER-DAY bucket only (symmetric with setMark's
          // bucket-only frozen write — Codex P2 on #278); the frozen ROOT
          // aggregates never unfold.
          {
            const statWrite = playerStatWrite({
              daily,
              dayIndex: proofDayIndex,
              priorDayStats: playerSnap.data()?.dayStats as DayStats | undefined,
              bingoCount,
              squaresMarked: squares,
              firstBingoAt,
              blackout: blackout || siblingBoards.some((sibling) => isBlackout((cellsFromData(sibling.data()?.cells)))),
              tutorialDayIndexes: opts?.tutorialDayIndexes,
              ceremonialDayIndexes: opts?.ceremonialDayIndexes,
            });
            const frozenNow =
              typeof opts?.statsFrozen === 'function' ? opts.statsFrozen() : opts?.statsFrozen === true;
            if (frozenNow && daily && 'dayStats' in statWrite && opts?.ceremonialDayIndexes?.includes(proofDayIndex)) {
              // Ceremonial-day-only post-freeze bucket, mirroring setMark.
              tx.set(playerRef, { dayStats: statWrite.dayStats }, { merge: true });
            } else if (!frozenNow) {
              tx.set(playerRef, statWrite, { merge: true });
            }
          }
          // Unmarking removes exactly that Player's per-Prompt Tally entry (ADR 0002),
          // mirroring the cell flip — reached only when the cell is still backed by
          // THIS proof (a genuine unmark), and only for a non-free Prompt. Same marker
          // path setMark writes; the owner is the proof's uid.
          const markedOnSibling = siblingBoards.some((sibling) =>
            (cellsFromData(sibling.data()?.cells)).some(
              (cell) => !cell.free && cell.marked && cell.itemId === backing.itemId,
            ),
          );
          if (backing.itemId && !markedOnSibling) {
            tx.delete(rawMarker(backing.itemId, proof.uid, eventId));
          }
        }
      }

      tx.delete(proofRef);
    });
  } catch (err) {
    // The transaction never committed — the Proof and the media it points at
    // both survive — so the intent is withdrawn rather than left to a drain
    // that would find the document still there and drop it anyway. Clearing it
    // HERE is what keeps the ambiguous case the drain has to resolve down to
    // the one it cannot avoid: a tab killed before either half could decide.
    if (storagePath) clearProofMediaRevocation(storagePath, eventId);
    throw err;
  }

  // The commit already stood down the Proof, so this object is now an orphan
  // — which is exactly what `storage.rules` lets its owner delete in any
  // state. The intent recorded above is KEPT through the commit and forgotten
  // only once the object is provably gone (Codex P2 on PR #1157, round 5,
  // widened to the whole transaction in run 4): a catch-only record missed the
  // tab closed or killed between the commit and the delete settling, which
  // left the only discoverable `storagePath` in a document that no longer
  // existed.
  try {
    if (storagePath) {
      await deleteStoragePath(storagePath);
      clearProofMediaRevocation(storagePath, eventId);
    }
  } catch (err) {
    // Re-assert the intent before the error leaves. A drain that ran while this
    // transaction was still in flight — one started by a sign-in, not by this
    // call — would have found the Proof document still present and dropped the
    // record as a never-committed delete. It committed after all, so the retry
    // has to exist again.
    if (storagePath) queueProofMediaRevocation(storagePath, eventId);
    throw err;
  } finally {
    // Fire-and-forget, AFTER commit (never inside the retryable transaction
    // callback above — a callback re-run on conflict would fire this on every
    // attempt, not just the committed one). purgeProofMediaFromCaches already
    // swallows every failure internally, so this is never awaited in a way
    // that could let a purge rejection propagate to deleteProof's caller.
    // `resolveProofMediaUrl` keeps the purge key equal to the URL the browser
    // actually fetched (#335): identity in every real build, and under the e2e
    // emulator build the emulator-origin twin of the canonicalized stored value.
    //
    // In a `finally` because the commit is what the purge follows, not the
    // Storage delete: once the Proof document is gone this device must stop
    // serving the deleted photo out of its own cache whether or not the blob
    // itself could be revoked on this attempt (#373).
    void purgeProofMediaFromCaches(resolveProofMediaUrl(mediaURL));
  }
}
