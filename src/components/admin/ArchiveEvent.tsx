import { useState } from 'react';
import {
  abandonArchive,
  beginArchive,
  type AbandonArchiveResult,
  type BeginArchiveResult,
} from '../../data/admin';
import { isEventArchived, isEventArchiving } from '../../data/eventArchive';
import { editionLexicon } from '../../editions';
import AsyncButton from './AsyncButton';
import type { EventDoc } from '../../types';

function archivedOn(at: number | undefined): string {
  if (!at) return 'ended';
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

type ArchiveOutcome = AbandonArchiveResult | BeginArchiveResult;

const RESULT_COPY: Record<ArchiveOutcome, string> = {
  closing: 'Play is closed. Reopen play to put it back.',
  reopened: 'Play is open again. Nothing was frozen.',
  'already-archived': 'Already archived—nothing changed.',
  'no-event': 'No Event document to close.',
  // Unreachable from this surface today: **Reopen play** is deliberately
  // unconditional, and only a CONDITIONAL reopen — one naming the generation it
  // expects — can be refused this way. It is carried because the result union
  // carries it, and the conditional caller arrives with the flip (#1151).
  'quiesce-changed': 'Play was reopened and shut again by another archive, so nothing changed.',
};

/**
 * The end-of-Event control (#134, specs/post-sailing-archive.md): the admin-only
 * pair that shuts the Event to gameplay and puts it back. From the closed state
 * every gameplay write is denied at the rules boundary — Marks, Claims, Proofs,
 * Doubts, Hearts and Moments alike, for Players and Admins together.
 *
 * It lives inside Game settings rather than behind a seventh hub door
 * (`specs/admin-console-ia.md`) because it is a once-per-Event switch, not a
 * surface anyone visits: giving it its own card would put the most destructive
 * control in the console at the same level as the prompt pool.
 *
 * TWO ACTIONS on this child, and both are reversible:
 *
 *  - **Close play** takes the quiesce (`beginArchive`) and stops there. The
 *    Event is shut to gameplay and nothing is permanent.
 *  - **Reopen play** lifts it (`abandonArchive`), unconditionally, because it is
 *    an Admin acting on the Event standing in front of them.
 *
 * THE IRREVERSIBLE FLIP IS DELIBERATELY NOT REACHABLE FROM HERE (Phase 4b P1 on
 * PR #1157). `archiveEvent(token)` ships and is tested at the data layer, but
 * the console's **Archive** action arrives with #1151, together with the two
 * things that make it safe to press: the pending-claim DRAIN GATE and the
 * durable snapshot. Without the drain gate, archiving an Event whose Claim queue
 * still holds an `admin_confirmed` Claim strands it — `resolve()` writes the
 * claimant's Board and Player row, both of which the freeze denies, so Confirm
 * and Reject can only fail, and the console cannot reopen a state it never took.
 * A one-way door that can leave the Event unworkable does not belong on screen
 * until the gate that refuses to open it is there too.
 *
 * THE CLOSED STATE IS REVERSIBLE, deliberately. An Admin who shuts the Event and
 * changes their mind, or closes the tab mid-flight, must not leave a live Event
 * permanently unplayable — so this control renders that state explicitly and
 * offers the way out. Nothing else in the console would ever surface it, and an
 * Event silently stuck unplayable is the worst outcome this feature could
 * produce.
 *
 * THE ARCHIVED STATE IS STILL RENDERED, because the flip can reach the document
 * without this surface — an Admin-SDK edit today, #1151's console action next —
 * and an archived Event whose console said nothing would be the same silence
 * this control exists to break.
 */
export default function ArchiveEvent({ event }: { event: EventDoc | null | undefined }) {
  const archived = isEventArchived(event);
  const closing = !archived && isEventArchiving(event);
  const [result, setResult] = useState<ArchiveOutcome | null>(null);

  return (
    <div className="admin-section">
      <h3>End the {editionLexicon().occasion}</h3>
      {archived ? (
        <div className="row">
          <div className="grow">
            <div className="name">Archived {archivedOn(event?.archivedAt)}</div>
            <div className="sub">
              Play is closed. No one can Mark, claim, post a Proof or heart, and this cannot be
              undone from here.
            </div>
          </div>
        </div>
      ) : closing ? (
        <div className="row" role="group" aria-label="Reopen play">
          <div className="grow">
            <div className="name">Play is closed—the Event is not archived yet</div>
            <div className="sub">
              No one can Mark, claim, post a Proof or heart while this holds. Reopen play to put the{' '}
              {editionLexicon().occasion} back the way it was.
            </div>
          </div>
          <AsyncButton
            ariaLabel="Reopen play"
            failureLabel="Reopening failed—try again."
            // UNCONDITIONAL, deliberately. This is an Admin acting on the Event
            // in front of them, not an automatic cleanup of a call that already
            // failed — the token binding exists to stop a STALE handler
            // reopening a newer quiesce, and there is no stale handler here.
            onAction={async () => {
              setResult(await abandonArchive());
            }}
          >
            Reopen play
          </AsyncButton>
        </div>
      ) : (
        <div className="row" role="group" aria-label="Close play">
          <div className="grow">
            <div className="name">Close play when the {editionLexicon().occasion} is over</div>
            <div className="sub">
              Closing stops every Mark, claim, Proof and heart, and leaves a way back. Archiving—the
              permanent freeze—is not available from the console yet.
            </div>
          </div>
          <AsyncButton
            ariaLabel="Close play"
            failureLabel="Closing play failed—try again."
            onAction={async () => {
              setResult((await beginArchive()).result);
            }}
          >
            Close play
          </AsyncButton>
        </div>
      )}
      {result && (
        <p className="schedule-row-result" role="status">
          {RESULT_COPY[result]}
        </p>
      )}
    </div>
  );
}
