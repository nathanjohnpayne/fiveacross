import { useState } from 'react';
import {
  abandonArchive,
  archiveEvent,
  beginArchive,
  type AbandonArchiveResult,
  type ArchiveEventResult,
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

/** Appended to a refusal's own copy when the automatic reopen DECLINED — the
 *  closing state in force was not this call's to lift, so the handler left it
 *  alone (Codex P2, PR #1139; #1142 item 6). Stated rather than silent: play is
 *  still shut, and the Admin needs to know that is deliberate and whose it is. */
const REOPEN_SUPERSEDED_COPY =
  'Play was left closed: this Event was shut again by another archive, and that closing state is not this one to lift. Reopen play above if that archive is not going ahead.';

type ArchiveOutcome = ArchiveEventResult | AbandonArchiveResult | BeginArchiveResult;

const RESULT_COPY: Record<ArchiveOutcome, string> = {
  archived: 'Archived. Play is closed for good.',
  'already-archived': 'Already archived—nothing changed.',
  'no-event': 'No Event document to archive.',
  'not-closing': 'Play reopened before the Event was archived—nothing was frozen.',
  'quiesce-changed':
    'Play was reopened and shut again while this archive was running, so nothing was frozen. Archive again from where the Event stands now.',
  closing: 'Play is closed. Archive to finish, or reopen play to put it back.',
  reopened: 'Play is open again. Nothing was frozen.',
};

/**
 * The archive door (#134, specs/post-sailing-archive.md): the admin-only,
 * one-way action that ends the Event. It shuts gameplay and then flips
 * `EventDoc.status` to `'archived'`, from which every gameplay write is denied
 * at the rules boundary — Marks, Claims, Proofs, Doubts, Hearts and Moments
 * alike, for Players and Admins together.
 *
 * It lives inside Game settings rather than behind a seventh hub door
 * (`specs/admin-console-ia.md`) because it is a once-per-Event switch, not a
 * surface anyone visits: giving it its own card would put the most destructive
 * control in the console at the same level as the prompt pool.
 *
 * THREE ACTIONS, and the middle one is why the other two are safe:
 *
 *  - **Close play** takes the quiesce (`beginArchive`) and stops there. The
 *    Event is shut to gameplay and nothing is permanent yet.
 *  - **Reopen play** lifts it (`abandonArchive`), unconditionally, because it is
 *    an Admin acting on the Event standing in front of them.
 *  - **Archive** runs both writes in order and is the only irreversible one.
 *
 * TWO WRITES, in order, and the order is the guarantee (spec § "The quiesce
 * protocol"). `beginArchive` shuts the Event to gameplay first — the rules deny
 * every Mark, Claim, Proof and Heart from that instant — and only then does
 * `archiveEvent` flip the status, bound to the generation the first write left
 * in force. `Archive` therefore works from either state: on a live Event it
 * takes the quiesce itself; on an Event already closing it JOINS the one in
 * force and finishes it.
 *
 * THE CLOSING STATE IS REVERSIBLE, deliberately. If the flip fails, the tab
 * closes mid-flight, or the Admin changes their mind, the Event is shut with
 * play stopped and nothing to show for it — so this control renders that state
 * explicitly and offers both ways out. Nothing else in the console would ever
 * surface it, and an Event silently stuck unplayable is the worst outcome this
 * feature could produce.
 *
 * WHAT IT DOES NOT SHOW, on this ticket: what is about to be frozen. The
 * confirm row previewing the record, the pending-claim drain gate and the
 * document-size refusal all belong to the snapshot (#1151) and its presentation
 * (#1152); the archived surface itself is #1152's too. This is the lifecycle
 * made operable, and nothing more.
 */
export default function ArchiveEvent({ event }: { event: EventDoc | null | undefined }) {
  const archived = isEventArchived(event);
  const closing = !archived && isEventArchiving(event);
  const [result, setResult] = useState<ArchiveOutcome | null>(null);
  // Whether the automatic reopen below declined because this call did not take
  // the closing state it would have lifted. Carried BESIDE the result rather
  // than replacing it: the Admin needs both halves — why nothing was frozen,
  // and why play is nonetheless still closed.
  const [reopenSuperseded, setReopenSuperseded] = useState(false);

  /**
   * Both writes of the quiesce protocol, in order, with the cleanup that makes
   * the first one safe to take.
   *
   * ONLY THE CREATOR REOPENS (#1142 item 6). `beginArchive` is idempotent: on an
   * Event already closing it preserves the stored generation and reports
   * `'closing'` all the same, so a call that merely JOINED another Admin's
   * in-flight quiesce comes back holding a token that matches perfectly. An
   * automatic reopen keyed on the token alone would then succeed at exactly the
   * write the binding exists to refuse — clearing a closing state this handler
   * never took, out from under whoever did. So the cleanup runs only when this
   * call OPENED the quiesce, and `abandonArchive` is passed the same token
   * besides, so a generation that moved between the flip returning and the
   * cleanup running declines too (Codex P2, PR #1139).
   *
   * IT RUNS ON A THROWN FLIP, not on a reported refusal. Every refusal
   * `archiveEvent` reports on this ticket either leaves nothing shut
   * (`not-closing`, `no-event`, `already-archived`) or is deliberately left
   * exactly as found (`quiesce-changed` — that closing state belongs to whoever
   * took it). A flip that THREW is the case the reversibility exists for: this
   * handler shut the Event a moment ago, the freeze did not land, and leaving it
   * closed strands a live Event on a failure the Admin did not choose.
   */
  const runArchive = async () => {
    setReopenSuperseded(false);
    const { result: opened, token, created } = await beginArchive();
    if (opened !== 'closing' || token === null) {
      setResult(opened);
      return;
    }
    try {
      setResult(await archiveEvent(token));
    } catch (err) {
      // Only the creator reopens. A call that JOINED an in-flight quiesce
      // leaves it exactly as found — that Event was already shut when this
      // Admin arrived, and **Reopen play** sits beside the button they pressed.
      if (created) {
        // Best effort, and its own failure is swallowed: the flip's failure is
        // what `AsyncButton` reports, and a reopen that also failed leaves the
        // closing-state surface offering the same button by hand.
        const reopened = await abandonArchive(token).catch(() => null);
        setReopenSuperseded(reopened === 'quiesce-changed');
      }
      throw err;
    }
  };

  return (
    <div className="admin-section">
      <h3>Archive the {editionLexicon().occasion}</h3>
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
        <div className="row" role="group" aria-label="Finish or abandon the archive">
          <div className="grow">
            <div className="name">Play is closed—the Event is not archived yet</div>
            <div className="sub">
              No one can Mark, claim, post a Proof or heart while this holds. Archive to finish, or
              reopen play to put the {editionLexicon().occasion} back the way it was.
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
              setReopenSuperseded(false);
              setResult(await abandonArchive());
            }}
          >
            Reopen play
          </AsyncButton>
          <AsyncButton
            ariaLabel="Archive the Event now"
            failureLabel="Archive failed—try again."
            onAction={runArchive}
          >
            Archive
          </AsyncButton>
        </div>
      ) : (
        <div className="row" role="group" aria-label="Close play or archive the Event">
          <div className="grow">
            <div className="name">End the {editionLexicon().occasion}</div>
            <div className="sub">
              Close play to stop every Mark, claim, Proof and heart while leaving a way back.
              Archiving does the same and makes it permanent—it cannot be undone from here.
            </div>
          </div>
          <AsyncButton
            ariaLabel="Close play"
            failureLabel="Closing play failed—try again."
            onAction={async () => {
              setReopenSuperseded(false);
              setResult((await beginArchive()).result);
            }}
          >
            Close play
          </AsyncButton>
          <AsyncButton
            ariaLabel="Archive the Event now"
            failureLabel="Archive failed—try again."
            onAction={runArchive}
          >
            Archive
          </AsyncButton>
        </div>
      )}
      {(result || reopenSuperseded) && (
        <p className="schedule-row-result" role="status">
          {[result ? RESULT_COPY[result] : null, reopenSuperseded ? REOPEN_SUPERSEDED_COPY : null]
            .filter((line): line is string => line !== null)
            .join(' ')}
        </p>
      )}
    </div>
  );
}
