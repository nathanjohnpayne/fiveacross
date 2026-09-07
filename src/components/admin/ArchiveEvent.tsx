import { useState } from 'react';
import {
  abandonArchive,
  archiveEvent,
  beginArchive,
  type ArchiveEventResult,
} from '../../data/admin';
import { claimsAwaitingAdmin } from '../../data/moderation';
import { buildEventArchive, isEventArchived, isEventArchiving } from '../../data/eventArchive';
import { useDayMetasStatus, useLeaderboard } from '../../hooks/useData';
import { editionLexicon } from '../../editions';
import AsyncButton from './AsyncButton';
import type { ClaimDoc, EventDoc } from '../../types';

function archivedOn(at: number | undefined): string {
  if (!at) return 'ended';
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

const RESULT_COPY: Record<ArchiveEventResult | 'reopened', string> = {
  archived: 'Archived. The final standings are frozen.',
  'already-archived': 'Already archived—the record is unchanged.',
  'no-event': 'No Event document to archive.',
  'not-closing': 'Play reopened before the record was taken—nothing was frozen.',
  reopened: 'Play is open again. Nothing was frozen.',
};

/**
 * The archive door (#134, specs/post-sailing-archive.md): the admin-only,
 * one-way action that ends the Event. It shuts gameplay, freezes the final
 * Leaderboard standings plus the First-to-BINGO hall of fame onto the Event
 * document, and flips `EventDoc.status` to `'archived'` — from which the
 * archived Leaderboard then renders read-only.
 *
 * It lives inside Game settings rather than behind a seventh hub door
 * (`specs/admin-console-ia.md`) because it is a once-per-Event switch, not a
 * surface anyone visits: giving it its own card would put the most destructive
 * control in the console at the same level as the prompt pool.
 *
 * TWO WRITES, in order, and the order is the guarantee (spec § "The quiesce
 * protocol"). `beginArchive` shuts the Event to gameplay first — the rules deny
 * every Mark, Claim, Proof and Heart from that instant — and only then does
 * `archiveEvent` re-read the roster and the Day honours FROM THE SERVER and
 * freeze them. A snapshot taken over live play cannot serialize against a Board
 * write in another collection, so it can silently omit a Mark the rules then
 * make permanent (Codex P1). The second write reports `not-closing` rather than
 * freezing if the quiesce was lifted underneath it.
 *
 * TWO TAPS, never one. Archiving cannot be undone from the app, so the control
 * arms a confirm row first — the `AdultContentConfirm` posture (#610) in its
 * simplest form, inline rather than modal because there is nothing to explain
 * that the row cannot say itself. The second tap runs BOTH writes; a failure
 * between them leaves the Event closed, which is why the closing state has a
 * surface of its own below rather than being invisible.
 *
 * THE CLOSING STATE IS REVERSIBLE, deliberately. If the freeze fails, the tab
 * closes mid-flight, or the Admin changes their mind, the Event is shut with no
 * record — so this control renders that state explicitly and offers both ways
 * out: finish the freeze, or reopen play. Nothing else in the console would
 * ever surface it, and an Event silently stuck unplayable is the worst outcome
 * this feature could produce.
 *
 * TWO PRECONDITIONS ahead of the first tap, because the write is permanent
 * behind write-once rules and there is no second attempt to correct it:
 *
 *  1. **Every preview input server-confirmed.** `useLeaderboard`'s
 *     `hasServerData` and `useDayMetasStatus`'s `serverLoaded` are LATCHES on
 *     "the server has spoken", and until they hold, an empty roster and an
 *     unpinned Day are indistinguishable from a roster the ADR 0006 persistent
 *     cache has not filled in yet — so the confirm row would understate what is
 *     about to be frozen. The Event doc is part of the same precondition:
 *     `dayCount` is derived from it, so `serverLoaded` is vacuously true while
 *     it is absent. (The RECORD no longer depends on these subscriptions at all
 *     — `archiveEvent` re-reads its inputs after the quiesce — but a console
 *     that has not loaded is still not a console to end an Event from.)
 *  2. **The claim queue drained.** Resolving a Claim writes the claimant's
 *     Board and Player row, and the freeze denies both — so a claim still
 *     pending at the moment of archival is pending forever, with a
 *     Confirm/Reject pair in the Review queue that can now only fail
 *     (Codex P2). `claimsAwaitingAdmin` is the shared predicate; the claims are
 *     threaded from `Admin.tsx`'s existing subscription rather than re-opened
 *     here, so the gate and the queue it points at can never disagree. It gates
 *     the freeze in the closing state too, where the only way to drain is to
 *     reopen play first.
 */
export default function ArchiveEvent({
  event,
  pendingClaims,
  pendingClaimsLoaded,
}: {
  event: EventDoc | null | undefined;
  /** `usePendingClaims`' queue, threaded from the console (no extra listener). */
  pendingClaims: readonly ClaimDoc[];
  /** That subscription's `hasServerData`: a not-yet-arrived queue reads as
   *  empty, and a drain gate that passes vacuously is no gate at all. */
  pendingClaimsLoaded: boolean;
}) {
  const archived = isEventArchived(event);
  const closing = !archived && isEventArchiving(event);
  const { players, hasServerData: rosterConfirmed } = useLeaderboard();
  const {
    metas: dayMetas,
    loaded: dayMetasLoaded,
    serverLoaded: dayMetasConfirmed,
  } = useDayMetasStatus(event?.days?.length ?? 0);
  const [arming, setArming] = useState(false);
  const [result, setResult] = useState<ArchiveEventResult | 'reopened' | null>(null);

  const blockingClaims = claimsAwaitingAdmin(event, pendingClaims);
  // The drain gate is the ONE precondition BOTH writes share: a Claim left
  // pending across the freeze can never be resolved again.
  const drained = pendingClaimsLoaded && blockingClaims.length === 0;
  const previewConfirmed = !!event && rosterConfirmed && dayMetasConfirmed;
  const ready = previewConfirmed && drained;
  // Why the door is shut, in the order the Admin can act on it: nothing to do
  // about a loading roster but wait, whereas a pending claim names its own fix.
  const blockedReason =
    !previewConfirmed || !pendingClaimsLoaded
      ? 'Loading the final standings—the archive stays closed until every one of them is confirmed by the server.'
      : blockingClaims.length > 0
        ? `Resolve the ${blockingClaims.length} pending claim${blockingClaims.length === 1 ? '' : 's'} in the Review queue first. Confirming or rejecting a claim writes to a Board, which the freeze denies—so a claim left pending here stays pending forever.${closing ? ' Reopen play to drain the queue, then archive again.' : ''}`
        : null;

  // What WOULD be frozen, so the confirm row can state the record's size before
  // the Admin commits to it. Derived from the same builder the write uses, so
  // the preview cannot drift from the record.
  const preview = buildEventArchive({
    players,
    event,
    dayMetas,
    dayMetasLoaded,
    archivedAt: 0,
  });
  const frozen = event?.archive;

  const runArchive = async () => {
    const opened = await beginArchive();
    if (opened !== 'closing') {
      setResult(opened);
      return;
    }
    setResult(await archiveEvent());
  };

  return (
    <div className="admin-section">
      <h3>Archive the {editionLexicon().occasion}</h3>
      {archived ? (
        <div className="row">
          <div className="grow">
            <div className="name">Archived {archivedOn(event?.archivedAt)}</div>
            <div className="sub">
              {frozen
                ? `${frozen.playerCount} player${frozen.playerCount === 1 ? '' : 's'} · first to BINGO ${frozen.firstBingo?.displayName ?? '—'}. Play is closed and the record is frozen.`
                : 'Play is closed.'}
            </div>
          </div>
        </div>
      ) : closing ? (
        <div className="row" role="group" aria-label="Finish or abandon the archive">
          <div className="grow">
            <div className="name">Play is closed—the record has not been taken yet</div>
            <div className="sub">
              No one can Mark, claim, post a Proof or heart while this holds. Freeze the record to
              finish, or reopen play to put the {editionLexicon().occasion} back the way it was.
            </div>
          </div>
          <AsyncButton
            ariaLabel="Reopen play"
            failureLabel="Reopening failed—try again."
            onAction={async () => setResult(await abandonArchive())}
          >
            Reopen play
          </AsyncButton>
          <AsyncButton
            ariaLabel="Freeze the record now"
            failureLabel="Freeze failed—try again."
            disabled={!drained}
            onAction={async () => setResult(await archiveEvent())}
          >
            Freeze the record
          </AsyncButton>
        </div>
      ) : (
        <>
          <div className="row">
            <div className="grow">
              <div className="name">Freeze the final standings</div>
              <div className="sub">
                Closes play for everyone and keeps the Leaderboard and the First-to-BINGO hall of
                fame exactly as they stand. It cannot be undone from here.
              </div>
            </div>
            {!arming && (
              <button
                type="button"
                className="btn"
                disabled={!ready}
                onClick={() => setArming(true)}
              >
                Archive…
              </button>
            )}
          </div>
          {arming && (
            <div className="row" role="group" aria-label="Confirm archive">
              <div className="grow">
                <div className="sub">
                  Freezing {preview.playerCount} player
                  {preview.playerCount === 1 ? '' : 's'} and{' '}
                  {preview.dailyHonors.length} daily honor
                  {preview.dailyHonors.length === 1 ? '' : 's'}. Play closes first, then the record
                  is taken. No one can Mark, claim, post a Proof or heart afterwards.
                </div>
              </div>
              <button type="button" className="btn" onClick={() => setArming(false)}>
                Cancel
              </button>
              <AsyncButton
                ariaLabel="Archive the Event now"
                failureLabel="Archive failed—try again."
                // Re-checked at the second tap, not only at the first: a claim
                // can arrive, or a subscription re-key, while the confirm row
                // is armed.
                disabled={!ready}
                onAction={async () => {
                  await runArchive();
                  setArming(false);
                }}
              >
                Archive now
              </AsyncButton>
            </div>
          )}
        </>
      )}
      {!archived && blockedReason && (
        <p className="sub archive-blocked-reason" role="status">
          {blockedReason}
        </p>
      )}
      {result && (
        <p className="schedule-row-result" role="status">
          {RESULT_COPY[result]}
        </p>
      )}
    </div>
  );
}
