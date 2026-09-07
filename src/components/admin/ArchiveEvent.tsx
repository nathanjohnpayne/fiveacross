import { useState } from 'react';
import { archiveEvent, type ArchiveEventResult } from '../../data/admin';
import { buildEventArchive, isEventArchived } from '../../data/eventArchive';
import { useDayMetasStatus, useLeaderboard } from '../../hooks/useData';
import { editionLexicon } from '../../editions';
import AsyncButton from './AsyncButton';
import type { EventDoc } from '../../types';

function archivedOn(at: number | undefined): string {
  if (!at) return 'ended';
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

const RESULT_COPY: Record<ArchiveEventResult, string> = {
  archived: 'Archived. The final standings are frozen.',
  'already-archived': 'Already archived—the record is unchanged.',
  'no-event': 'No Event document to archive.',
};

/**
 * The archive door (#134, specs/post-sailing-archive.md): the admin-only,
 * one-way action that ends the Event. It flips `EventDoc.status` to
 * `'archived'`, stamps `archivedAt`, and freezes the final Leaderboard
 * standings plus the First-to-BINGO hall of fame onto the Event document, from
 * which the archived Leaderboard then renders read-only.
 *
 * It lives inside Game settings rather than behind a seventh hub door
 * (`specs/admin-console-ia.md`) because it is a once-per-Event switch, not a
 * surface anyone visits: giving it its own card would put the most destructive
 * control in the console at the same level as the prompt pool.
 *
 * The roster is subscribed HERE rather than threaded from `Admin.tsx`: this is
 * the only admin surface that needs it, and the snapshot must be of the live
 * standings at the moment the Admin taps (ADR 0001 — snapshot, never
 * recompute). `useDayMetasStatus` supplies the write-once per-Day honour pins
 * the hall of fame prefers over the roster-derived fallback, exactly as the
 * Leaderboard and the podium resolve them.
 *
 * TWO TAPS, never one. Archiving cannot be undone from the app, so the control
 * arms a confirm row first — the `AdultContentConfirm` posture (#610) in its
 * simplest form, inline rather than modal because there is nothing to explain
 * that the row cannot say itself.
 */
export default function ArchiveEvent({ event }: { event: EventDoc | null | undefined }) {
  const archived = isEventArchived(event);
  const { players } = useLeaderboard();
  const { metas: dayMetas, loaded: dayMetasLoaded } = useDayMetasStatus(event?.days?.length ?? 0);
  const [arming, setArming] = useState(false);
  const [result, setResult] = useState<ArchiveEventResult | null>(null);

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
              <button type="button" className="btn" onClick={() => setArming(true)}>
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
                  {preview.dailyHonors.length === 1 ? '' : 's'}. No one can Mark, claim, post a
                  Proof or heart afterwards.
                </div>
              </div>
              <button type="button" className="btn" onClick={() => setArming(false)}>
                Cancel
              </button>
              <AsyncButton
                ariaLabel="Archive the Event now"
                failureLabel="Archive failed—try again."
                onAction={async () => {
                  const outcome = await archiveEvent({ players, dayMetas, dayMetasLoaded });
                  setResult(outcome);
                  setArming(false);
                }}
              >
                Archive now
              </AsyncButton>
            </div>
          )}
        </>
      )}
      {result && (
        <p className="schedule-row-result" role="status">
          {RESULT_COPY[result]}
        </p>
      )}
    </div>
  );
}
