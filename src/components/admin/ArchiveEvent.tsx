import { useEffect, useRef, useState } from 'react';
import {
  abandonArchive,
  archiveEvent,
  beginArchive,
  type AbandonArchiveResult,
  type ArchiveEventResult,
  type BeginArchiveResult,
} from '../../data/admin';
import { claimsAwaitingAdmin } from '../../data/moderation';
import {
  draftEventArchive,
  finaleHasRun,
  isEventArchived,
  isEventArchiving,
} from '../../data/eventArchive';
import { useDayMetasStatus, useLeaderboard } from '../../hooks/useData';
import { editionLexicon } from '../../editions';
import AsyncButton from './AsyncButton';
import type { ClaimDoc, EventDoc } from '../../types';

function archivedOn(at: number | undefined): string {
  if (!at) return 'ended';
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

type ArchiveOutcome = AbandonArchiveResult | BeginArchiveResult | ArchiveEventResult;

/** The three states this surface renders, in the order the lifecycle moves. */
type Phase = 'open' | 'closing' | 'archived';

/** Stated identically wherever the oversized record is refused — before the
 *  quiesce (the blocked control) and after it (the flip's own report) — so an
 *  Admin who meets it twice is told the same thing about the same cause.
 *
 *  It names the DOCUMENT rather than the record, because the check is on the
 *  projected document: the record plus everything already on the Event (`days`,
 *  `bannedUids`, `mostLovedPhoto`). The remedy is still the one an Admin can
 *  actually take from the console, and an over-long Player row is still
 *  overwhelmingly the cause once rows and names are both bounded — but the copy
 *  no longer asserts a cause the size check cannot prove. */
const TOO_LARGE_COPY =
  'These standings are too large to freeze onto the Event—the record and the Event data it would sit beside do not fit in one document. That is almost always a Player row carrying far more text than a name, and banning that Player drops their row from the record.';

/** Appended to a refusal's own copy when the automatic reopen DECLINED — the
 *  closing state in force is a later Admin's, so this handler left it alone
 *  (Codex P2, PR #1139). Stated rather than silent: play is still shut, and the
 *  Admin needs to know that is deliberate and whose it is. */
const REOPEN_SUPERSEDED_COPY =
  ' Play was left closed: the Event has been shut again by another archive, and that closing state is not this one to lift. Reopen play below if that archive is not going ahead.';

/** One sentence for all four read refusals, differing only in WHICH read did not
 *  answer (CodeRabbit Major, PR #1162). Written once and applied per stage
 *  rather than restated four times: the Admin's remedy is identical—the freeze
 *  wrote nothing and the archive can simply be taken again—so only the subject
 *  of the sentence carries information.
 *
 *  It names the read in the Admin's own vocabulary, not the writer's: **the
 *  Review queue** is the surface beside this one, where `claims` is a
 *  collection path nobody in the console has ever seen. */
const readFailedCopy = (subject: string) =>
  `${subject} could not be read back from the server after play closed, so nothing was frozen. Check the connection and archive again.`;

/** An outcome together with the phase the handler's own CLEANUP left the Event
 *  in, for the one path that has a cleanup: an open-phase `runArchive` whose
 *  flip refused and whose automatic reopen then succeeded (Codex P2 on PR
 *  #1162). Absent means nothing cleaned up, and `RESULT_PHASE` below decides. */
type ArchiveReport = { outcome: ArchiveOutcome; settledAt?: Phase };

/**
 * The lifecycle state each outcome DESCRIBES when nothing cleaned up after it
 * (Codex P2 on PR #1157). A result is a sentence about the Event as the action
 * left it, so it is shown only while the Event is still there: from the state the
 * action was taken in until its target state is observed, and then for as long as
 * that state holds. Another Admin moving the Event on — reopening after this
 * Admin closed it, or archiving it — clears the message instead of leaving "Play
 * is closed" beside the open controls indefinitely.
 *
 * Every refusal the flip can report is mapped to a CLOSING Event, because that is
 * where the flip ITSELF leaves one: each of them writes nothing, and the quiesce
 * is still in force when `archiveEvent` returns.
 *
 * BUT THAT IS NOT ALWAYS WHERE THE EVENT ENDS UP (Codex P2 on PR #1162). An
 * open-phase `runArchive` that CREATED the quiesce reopens play for every one of
 * those refusals, so the Event lands back OPEN — and the message was then
 * discarded twice over: the reopen the handler itself performed moved the phase
 * away from `closing`, and `movedDuringActionRef` had already recorded that the
 * phase moved during the action, so neither the observed-phase test nor the
 * still-where-it-started test could hold. The Admin was left with reopened
 * controls and no explanation of why nothing was frozen. So a refusal followed by
 * a successful automatic reopen is reported against `open` instead, through
 * `ArchiveReport.settledAt`; `closing` is retained only where no reopen was
 * attempted or none succeeded — a quiesce this handler merely JOINED, one another
 * archive has taken over, and the closing surface's own **Freeze the record**,
 * which never reopens at all.
 */
const RESULT_PHASE: Record<ArchiveOutcome, Phase> = {
  closing: 'closing',
  reopened: 'open',
  'already-archived': 'archived',
  'no-event': 'open',
  'quiesce-changed': 'closing',
  archived: 'archived',
  'not-closing': 'open',
  'config-changed': 'closing',
  'claims-pending': 'closing',
  'finale-pending': 'closing',
  'too-large': 'closing',
  // A read that did not answer is the same shape of refusal as the four above:
  // the flip wrote nothing and the quiesce is still in force when it returns
  // (CodeRabbit Major, PR #1162). Each is listed rather than folded together so
  // the exhaustive `Record` still has to name every one this union can carry.
  'read-failed:event': 'closing',
  'read-failed:claims': 'closing',
  'read-failed:roster': 'closing',
  'read-failed:day-meta': 'closing',
};

const RESULT_COPY: Record<ArchiveOutcome, string> = {
  closing: 'Play is closed. Reopen play to put it back.',
  reopened: 'Play is open again. Nothing was frozen.',
  'already-archived': 'Already archived—nothing changed.',
  'no-event': 'No Event document to close.',
  'quiesce-changed':
    'Play was reopened and shut again by another archive, so nothing was frozen. Archive again from where the Event stands now.',
  archived: 'Archived. The final standings are frozen.',
  'not-closing': 'Play reopened before the record was taken—nothing was frozen.',
  'config-changed':
    'The Event settings changed while the record was being taken, so the standings were read against settings the freeze no longer matches. Nothing was frozen—archive again.',
  'claims-pending':
    'A claim arrived as play was closing, so nothing was frozen. Resolve the Review queue, then archive again.',
  'finale-pending':
    'The scheduled standings freeze has not run yet, so nothing was frozen. Wait for the finale, or tick the box below to archive without it.',
  'too-large': `${TOO_LARGE_COPY} Nothing was frozen.`,
  'read-failed:event': readFailedCopy('The Event'),
  'read-failed:claims': readFailedCopy('The Review queue'),
  'read-failed:roster': readFailedCopy('The final standings'),
  'read-failed:day-meta': readFailedCopy('The daily honours'),
};

/**
 * THE AUTOMATIC REOPEN SET — the flip refusals an open-phase **Archive** puts
 * play back after (Codex P1+P2, PR #1139; CodeRabbit Major, PR #1162).
 *
 * Each of them wrote nothing and each leaves a LIVE Event shut to gameplay with
 * no record to show for it: the state the quiesce's reversibility exists for.
 * Leaving one closed would strand the Event on a condition the Admin cannot even
 * clear from there — draining the claim queue writes Boards, which the freeze
 * denies.
 *
 * `quiesce-changed` and `not-closing` are deliberately OUT (Codex P1, PR #1139).
 * The first means the closing state now in force is a DIFFERENT one, so
 * reopening would clear somebody else's quiesce out from under their in-flight
 * freeze; the second means there is no closing state left to lift at all.
 *
 * The four read refusals are IN for exactly the reason the other four are
 * (CodeRabbit Major, PR #1162). Before they existed, an unanswered read threw
 * out of `archiveEvent`, past this set entirely, and the Admin got the generic
 * `AsyncButton` failure pill over an Event this handler had just shut and would
 * now never put back — which is the one outcome the two-write protocol exists to
 * make impossible.
 */
const REOPEN_AFTER: ReadonlySet<ArchiveOutcome> = new Set<ArchiveOutcome>([
  'claims-pending',
  'too-large',
  'config-changed',
  'finale-pending',
  'read-failed:event',
  'read-failed:claims',
  'read-failed:roster',
  'read-failed:day-meta',
]);

/**
 * The end-of-Event control (#134, specs/post-sailing-archive.md): the admin-only
 * pair that shuts the Event to gameplay and puts it back, plus the one-way
 * ARCHIVE that freezes the final record. From the closed state every gameplay
 * write is denied at the rules boundary — Marks, Claims, Proofs, Doubts, Hearts
 * and Moments alike, for Players and Admins together.
 *
 * It lives inside Game settings rather than behind a seventh hub door
 * (`specs/admin-console-ia.md`) because it is a once-per-Event switch, not a
 * surface anyone visits: giving it its own card would put the most destructive
 * control in the console at the same level as the prompt pool.
 *
 * THREE ACTIONS, and only two of them are reversible:
 *
 *  - **Close play** takes the quiesce (`beginArchive`) and stops there. The
 *    Event is shut to gameplay and nothing is permanent.
 *  - **Reopen play** lifts it (`abandonArchive`), unconditionally, because it is
 *    an Admin acting on the Event standing in front of them.
 *  - **Archive** runs BOTH writes, in order, and the order is the guarantee
 *    (spec § "The quiesce protocol"): `beginArchive` shuts the Event first — the
 *    rules deny every Mark, Claim, Proof and Heart from that instant — and only
 *    then does `archiveEvent` re-read the roster and the Day honours FROM THE
 *    SERVER and freeze them.
 *
 * TWO TAPS FOR THE ARCHIVE, never one. It cannot be undone from the app, so the
 * control arms a confirm row first — the `AdultContentConfirm` posture (#610) in
 * its simplest form, inline rather than modal because there is nothing to explain
 * that the row cannot say itself. The second tap runs both writes; a failure
 * between them leaves the Event closed, which is why the closing state has a
 * surface of its own.
 *
 * THE PRECONDITIONS ahead of the first tap, because the write is permanent
 * behind write-once rules and there is no second attempt to correct it:
 *
 *  1. **Every preview input server-confirmed, THE EVENT INCLUDED.**
 *     `useLeaderboard`'s `hasServerData` and `useDayMetasStatus`'s `serverLoaded`
 *     are LATCHES on "the server has spoken", and until they hold, an empty
 *     roster and an unpinned Day are indistinguishable from a roster the ADR 0006
 *     persistent cache has not filled in yet — so the confirm row would understate
 *     what is about to be frozen. The Event document is the third input and it is
 *     gated the same way (`eventConfirmed`, Codex P2 on PR #1162): a non-null
 *     `event` is what the cache delivers, not what the server said, and the other
 *     two latches can hold while it is still the cached copy — so truthiness
 *     armed Archive over a stale schedule, name or ban list, and `dayCount` is
 *     derived from it besides, which makes `serverLoaded` vacuously true while it
 *     is absent. (The RECORD does not depend on these subscriptions at all —
 *     `archiveEvent` re-reads its inputs after the quiesce — but a console that
 *     has not loaded is still not a console to end an Event from, and the record
 *     the freeze takes is the one the Admin was shown.)
 *  2. **The claim queue drained.** Resolving a Claim writes the claimant's Board
 *     and Player row, and the freeze denies both — so a Claim still pending at
 *     the moment of the flip is pending forever, with a Confirm/Reject pair in
 *     the Review queue that can now only fail (Codex P2).
 *     `claimsAwaitingAdmin` is the shared predicate; the claims are threaded from
 *     `Admin.tsx`'s existing subscription rather than re-opened here, so the gate
 *     and the queue it points at can never disagree. It gates the archive in the
 *     closing state too, where the only way to drain is to reopen play first.
 *     THE GATE IS TAKEN AGAIN AFTER THE CLOSING WRITE, from the server, inside
 *     `archiveEvent`: a subscription can only report what has already been
 *     delivered, so a Claim committing between this render and the quiesce would
 *     sail straight through a check made here alone. When that server re-read
 *     refuses, this handler reopens play — it shut the Event, so it puts it back.
 *  3. **The record fits the DOCUMENT.** `players/{uid}` validates none of its
 *     fields, so a Player can leave a row the archive cannot serialize; and the
 *     record never lands on an empty Event, so an Event whose own `days` /
 *     `bannedUids` / `mostLovedPhoto` already fill the 1 MiB budget cannot take
 *     even an ordinary one. `draftEventArchive` coerces and skips what it can and
 *     REFUSES what it cannot — measured against the PROJECTED document, which is
 *     why the Event this control is subscribed to is passed to it — and that
 *     refusal has to be read BEFORE the first write, or every attempt shuts the
 *     Event and then fails on the second one (Codex P2, PR #1139).
 *  4. **The finale has run, or the Admin says otherwise** (#1151, routed from
 *     #1150's review). The quiesce only DELAYS the finale beats — the freeze
 *     stamp, the podium Moment and the Most-Loved award are withheld and land at
 *     the scheduled cutoff once play reopens — but the flip is irreversible, so
 *     an Event archived first never receives them and nothing else would say so.
 *     Unlike the three above this is a WARNING rather than a bar: an Admin may
 *     legitimately end an Event that will never reach its finale. So it is an
 *     explicit acknowledgement rather than a silent default, and `archiveEvent`
 *     refuses without it. It is offered on BOTH surfaces that reach the flip —
 *     the confirm row and the closing state's **Freeze the record** — because
 *     `ready` gates each of them and an Admin who has already shut the Event
 *     cannot get back to the other one (Codex P2 on PR #1162).
 */
export default function ArchiveEvent({
  event,
  eventConfirmed,
  pendingClaims,
  pendingClaimsLoaded,
}: {
  event: EventDoc | null | undefined;
  /**
   * Whether the Event snapshot beside it is fully SERVER-COMMITTED (Codex P2 on
   * PR #1162): `useEventDoc`'s `hasServerData` latch, and this snapshot's own
   * `fromCache` and `hasPendingWrites` both false — the same test `src/App.tsx`
   * applies before it moves a Player off their Card.
   *
   * A separate prop rather than a property of `event` because the two answer
   * different questions and only one of them is on the document. A non-null
   * `event` says the ADR 0006 persistent cache had something; it does NOT say
   * the server has spoken. The roster and the Day-meta listeners latch
   * independently, so both could confirm while the Event itself was still the
   * cached copy — and the Admin would then be shown, and asked to approve, a
   * preview built from a stale schedule, name or ban list. `archiveEvent` re-
   * reads the Event from the server and freezes THAT one, permanently.
   */
  eventConfirmed: boolean;
  /** `usePendingClaims`' queue, threaded from the console (no extra listener). */
  pendingClaims: readonly ClaimDoc[];
  /** That subscription's `hasServerData`: a not-yet-arrived queue reads as
   *  empty, and a drain gate that passes vacuously is no gate at all. */
  pendingClaimsLoaded: boolean;
}) {
  const archived = isEventArchived(event);
  const closing = !archived && isEventArchiving(event);
  const phase: Phase = archived ? 'archived' : closing ? 'closing' : 'open';
  const { players, hasServerData: rosterConfirmed } = useLeaderboard();
  const {
    metas: dayMetas,
    loaded: dayMetasLoaded,
    serverLoaded: dayMetasConfirmed,
  } = useDayMetasStatus(event?.days?.length ?? 0);
  const [arming, setArming] = useState(false);
  const [beforeFinale, setBeforeFinale] = useState(false);
  // `from` is the state the action was taken in; once the outcome's target state
  // is observed it is rebased there, so any LATER move — someone else's — clears
  // the message rather than contradicting the controls. `describes` is that
  // target state, carried on the record rather than looked up from the outcome,
  // because a refusal the handler then cleaned up after describes where the
  // CLEANUP left the Event and not where the flip did (Codex P2 on PR #1162).
  const [result, setResult] = useState<{
    outcome: ArchiveOutcome;
    from: Phase;
    describes: Phase;
  } | null>(null);
  // Whether the automatic reopen declined because the quiesce in force is no
  // longer the one this handler took. Carried BESIDE the result rather than
  // replacing it: the Admin needs both halves — why nothing was frozen, and why
  // play is nonetheless still closed.
  const [reopenSuperseded, setReopenSuperseded] = useState(false);
  // Whether the phase moved at all while an action was in flight (Phase 4b P2 on
  // PR #1157, run 3): a round trip — closing delivered, then someone else's
  // reopen — lands back on the starting phase, which equality alone cannot tell
  // from "nothing happened yet". Any move during the action means the starting
  // phase is no longer evidence the message is true.
  const inFlightRef = useRef(false);
  const movedDuringActionRef = useRef(false);
  useEffect(() => {
    if (inFlightRef.current) movedDuringActionRef.current = true;
    setResult((current) => {
      if (!current || phase === current.from) return current;
      if (phase === current.describes) return { ...current, from: phase };
      return null;
    });
  }, [phase]);
  // The LATEST observed state, for an action that resolves after the prop moved
  // (Codex P2 on PR #1157, round 7): `report` runs after an awaited write, and by
  // then another Admin may have moved the Event, with the `[phase]` effect above
  // having already run against a `result` that did not exist yet. So the record
  // is made against the state observed NOW rather than the render the click
  // happened in: if the Event is already where the outcome describes, or still
  // where the action started, the message is true and shown; anywhere else it
  // would be stale before it appeared, so nothing is shown at all.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const report = (outcome: ArchiveOutcome, startedIn: Phase, settledAt?: Phase) => {
    // A CLEANUP THIS HANDLER PERFORMED IS EVIDENCE IN ITS OWN RIGHT (Codex P2 on
    // PR #1162). The tests below are about a phase somebody ELSE may have moved
    // while the write was in flight; where the handler's own reopen succeeded it
    // knows exactly where it left the Event, so the record is made against that
    // phase directly. Nothing is bypassed by doing so — the `[phase]` effect
    // above still rebases the message when the subscription delivers the reopen,
    // and still clears it the moment anyone moves the Event anywhere else.
    if (settledAt) {
      setResult({ outcome, from: settledAt, describes: settledAt });
      return;
    }
    const describes = RESULT_PHASE[outcome];
    const observed = phaseRef.current;
    const stillWhereItStarted = observed === startedIn && !movedDuringActionRef.current;
    setResult(
      observed === describes || stillWhereItStarted ? { outcome, from: observed, describes } : null,
    );
  };
  const act = async (run: () => Promise<ArchiveOutcome | ArchiveReport>) => {
    const startedIn = phase;
    inFlightRef.current = true;
    movedDuringActionRef.current = false;
    setReopenSuperseded(false);
    try {
      const settled = await run();
      if (typeof settled === 'string') report(settled, startedIn);
      else report(settled.outcome, startedIn, settled.settledAt);
    } finally {
      inFlightRef.current = false;
    }
  };

  const blockingClaims = claimsAwaitingAdmin(event, pendingClaims);
  // The drain gate is the ONE precondition BOTH writes share: a Claim left
  // pending across the freeze can never be resolved again.
  const drained = pendingClaimsLoaded && blockingClaims.length === 0;
  // The Event ITSELF has to be server-confirmed, not merely present (Codex P2 on
  // PR #1162). `!!event` was reading truthiness as confirmation, and the
  // persistent cache makes those different facts: the roster and the Day-meta
  // listeners latch independently, so both could hold while `event` was still
  // the cached copy — arming Archive over a stale schedule, name or ban list.
  const previewConfirmed = !!event && eventConfirmed && rosterConfirmed && dayMetasConfirmed;
  const finaleDone = finaleHasRun(event);

  // What WOULD be frozen, so the confirm row can state the record's size before
  // the Admin commits to it — and whether it can be frozen at all. Derived from
  // the same builder the write uses, so the preview cannot drift from the record.
  const draft = draftEventArchive({
    players,
    event,
    dayMetas,
    dayMetasLoaded,
    archivedAt: 0,
    // The Event document the record would land on, so the size check measures
    // the projected DOCUMENT and not just the record (Codex P2, PR #1139). An
    // Event already carrying large `days` / `bannedUids` / `mostLovedPhoto`
    // fields can leave a perfectly ordinary record unwritable, and this control
    // is the one place that can still say so before anything is closed.
    existing: event as Readonly<Record<string, unknown>> | null | undefined,
  });
  const preview = draft.archive;
  // THE THIRD PRECONDITION, and it has to be checked HERE rather than around the
  // write (Codex P2, PR #1139). `players/{uid}` validates neither the presence
  // nor the length of its fields, so a Player can leave a row the record cannot
  // carry; the builder coerces and skips what it can, but a record that still
  // does not fit the Event document is unwritable — and the first write has
  // already shut the Event by the time the second one would discover that. Every
  // attempt would close play and then fail.
  const fits = draft.refusal === null;
  const ready = previewConfirmed && drained && fits && (finaleDone || beforeFinale);
  // Why the door is shut, in the order the Admin can act on it: nothing to do
  // about a loading roster but wait, whereas a pending claim names its own fix.
  const blockedReason =
    !previewConfirmed || !pendingClaimsLoaded
      ? 'Loading the final standings—the archive stays closed until every one of them is confirmed by the server.'
      : blockingClaims.length > 0
        ? `Resolve the ${blockingClaims.length} pending claim${blockingClaims.length === 1 ? '' : 's'} in the Review queue first. Confirming or rejecting a claim writes to a Board, which the freeze denies—so a claim left pending here stays pending forever.${closing ? ' Reopen play to drain the queue, then archive again.' : ''}`
        : !fits
          ? `${TOO_LARGE_COPY}${closing ? ' Play is already closed—reopen it, ban that Player, then archive again.' : ' Nothing has been closed.'}`
          : null;

  const frozen = event?.archive;

  /**
   * The pre-finale acknowledgement (#1151), rendered wherever `ready` gates the
   * flip — the open surface's confirm row AND the closing surface's **Freeze the
   * record** (Codex P2 on PR #1162).
   *
   * It lived only in the confirm row, which is a surface an Admin who has
   * already used **Close play** cannot reach: on a closing Event `ready` was
   * therefore false forever, the button was permanently disabled, and the only
   * way forward was to reopen play, arm the confirm row, tick the box and archive
   * — reopening gameplay on an Event the Admin had deliberately shut, purely to
   * satisfy a checkbox. Same control, same copy, same state, so an Admin who ends
   * up in either place is asked the same question and answers it once.
   */
  const finaleAcknowledgement = !finaleDone && (
    <label className="sub archive-before-finale">
      <input
        type="checkbox"
        checked={beforeFinale}
        onChange={(e) => setBeforeFinale(e.target.checked)}
      />{' '}
      The scheduled standings freeze has not run yet. Archive anyway—the podium, the Most-Loved
      award and the freeze stamp will never arrive.
    </label>
  );

  /** The Archive action: both writes, in order, with the cleanup a refusal needs
   *  — and the phase that cleanup LEFT the Event in, so the explanation is shown
   *  against the controls the Admin is actually looking at (Codex P2 on PR
   *  #1162). */
  const runArchive = async (): Promise<ArchiveReport> => {
    // The quiesce this handler took, and the Event it took it on (#1142 item 7):
    // `EVENT_ID` is a live binding, so the freeze and the cleanup name the Event
    // the SHUT actually landed on rather than re-resolving it per call.
    const { result: opened, token, created, eventId } = await beginArchive();
    if (opened !== 'closing') return { outcome: opened };
    const outcome = await archiveEvent(token as number, { eventId, beforeFinale });
    // THIS handler is what shut the Event, so this handler is what puts it back
    // when the second write refuses (Codex P2, PR #1139) — for every refusal in
    // `REOPEN_AFTER`, which is where the reasoning about which ones qualify lives.
    //
    // AND THE REOPEN IS CONDITIONAL ON THAT SAME GENERATION, and on having
    // CREATED it (Codex P2, PR #1139; #1142 item 6). `archiveEvent` checks the
    // generation inside its own transaction, but this call happens after it
    // returns — and everything the ABA case describes can happen in that gap too.
    // `created` is the other half: `beginArchive` is idempotent, so a call that
    // merely JOINED another Admin's in-flight quiesce comes back holding a token
    // that matches perfectly, and a reopen keyed on the token alone would happily
    // clear a closing state this handler never took.
    if (REOPEN_AFTER.has(outcome)) {
      if (created) {
        const reopened = await abandonArchive(token ?? undefined, eventId);
        setReopenSuperseded(reopened === 'quiesce-changed');
        // WHERE THE EVENT ACTUALLY ENDS UP (Codex P2 on PR #1162). The reopen
        // this handler just performed put it back OPEN, so the refusal is a
        // sentence about an open Event and belongs beside the open controls —
        // where, without this, it was discarded as stale by the very phase move
        // the handler caused. Only a reopen that SUCCEEDED settles it there: a
        // superseded or already-archived one wrote nothing and the Event is
        // wherever it already was.
        if (reopened === 'reopened') return { outcome, settledAt: 'open' };
      } else {
        // Joined, not created: the closing state belongs to whoever opened it,
        // and it is left exactly as found. Reported for the same reason a
        // superseded generation is — play is still shut, deliberately.
        setReopenSuperseded(true);
      }
    }
    return { outcome };
  };

  return (
    <div className="admin-section">
      <h3>End the {editionLexicon().occasion}</h3>
      {archived ? (
        <div className="row">
          <div className="grow">
            <div className="name">Archived {archivedOn(event?.archivedAt)}</div>
            <div className="sub">
              {frozen
                ? `${frozen.playerCount} player${frozen.playerCount === 1 ? '' : 's'} · first to BINGO ${frozen.firstBingo?.displayName ?? '—'}. Play is closed and the record is frozen.`
                : 'Play is closed. No one can Mark, claim, post a Proof or heart, and this cannot be undone from here.'}
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
            {finaleAcknowledgement}
          </div>
          <AsyncButton
            ariaLabel="Reopen play"
            failureLabel="Reopening failed—try again."
            // UNCONDITIONAL, deliberately. This is an Admin acting on the Event
            // in front of them, not an automatic cleanup of a call that already
            // failed — the token binding exists to stop a STALE handler
            // reopening a newer quiesce, and there is no stale handler here.
            onAction={() => act(() => abandonArchive())}
          >
            Reopen play
          </AsyncButton>
          <AsyncButton
            ariaLabel="Freeze the record now"
            failureLabel="Freeze failed—try again."
            disabled={!ready}
            // The closing-state surface reaches the flip too, and deliberately
            // does NOT reopen on a refusal: that Event was already shut when the
            // Admin arrived, and **Reopen play** sits beside the button they
            // pressed.
            onAction={() =>
              act(async () => {
                const { result: opened, token, eventId } = await beginArchive();
                if (opened !== 'closing') return opened;
                return archiveEvent(token as number, { eventId, beforeFinale });
              })
            }
          >
            Freeze the record
          </AsyncButton>
        </div>
      ) : (
        <>
          <div className="row" role="group" aria-label="Close play">
            <div className="grow">
              <div className="name">Close play when the {editionLexicon().occasion} is over</div>
              <div className="sub">
                Closing stops every Mark, claim, Proof and heart, and leaves a way back. Archiving
                freezes the Leaderboard and the First-to-BINGO hall of fame exactly as they stand,
                and cannot be undone from here.
              </div>
            </div>
            <AsyncButton
              ariaLabel="Close play"
              failureLabel="Closing play failed—try again."
              onAction={() => act(async () => (await beginArchive()).result)}
            >
              Close play
            </AsyncButton>
            {!arming && (
              <button
                type="button"
                className="btn"
                disabled={!previewConfirmed || !drained || !fits}
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
                  {preview.playerCount === 1 ? '' : 's'} and {preview.dailyHonors.length} daily
                  honor
                  {preview.dailyHonors.length === 1 ? '' : 's'}. Play closes first, then the record
                  is taken. No one can Mark, claim, post a Proof or heart afterwards.
                  {/* Stated rather than silently absorbed: a row with no id
                      cannot be ban-filtered, matched to an honour or rendered,
                      so the record leaves it out — and an Admin who is told the
                      count up front is not left comparing rosters afterwards. */}
                  {draft.skippedRows > 0 &&
                    ` ${draft.skippedRows} unreadable row${draft.skippedRows === 1 ? '' : 's'} will not be included.`}
                </div>
                {/* The finale acknowledgement (#1151). The quiesce only DELAYS
                    the finale beats; the flip forgoes them for good, so the
                    Admin says so explicitly rather than discovering it after an
                    irreversible write. Shared with the closing surface, which
                    reaches the same flip behind the same `ready`. */}
                {finaleAcknowledgement}
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setArming(false);
                  setBeforeFinale(false);
                }}
              >
                Cancel
              </button>
              <AsyncButton
                ariaLabel="Archive the Event now"
                failureLabel="Archive failed—try again."
                // Re-checked at the second tap, not only at the first: a claim
                // can arrive, or a subscription re-key, while the confirm row is
                // armed.
                disabled={!ready}
                onAction={() =>
                  act(async () => {
                    const outcome = await runArchive();
                    setArming(false);
                    return outcome;
                  })
                }
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
          {RESULT_COPY[result.outcome]}
          {reopenSuperseded && REOPEN_SUPERSEDED_COPY}
        </p>
      )}
    </div>
  );
}
