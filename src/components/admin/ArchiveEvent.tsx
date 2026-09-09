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
  MAX_ARCHIVE_BYTES,
} from '../../data/eventArchive';
import { MAX_DAYS } from '../../data/eventLimits';
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

/**
 * Stated identically wherever the oversized record is refused — before the
 * quiesce (the blocked control) and after it (the flip's own report) — so an
 * Admin who meets it twice is told the same thing about the same cause.
 *
 * IT NAMES THE LEVERS THAT ACTUALLY MOVE THE SIZE (Codex P2 on PR #1162). It
 * used to blame "a Player row carrying far more text than a name" and recommend
 * banning that Player, and neither half survives what `buildEventArchive`
 * actually copies. The record takes six SELECTED fields per row and nothing
 * else — no `dayStats`, no photo, no arbitrary Player text — with every name
 * clipped at `MAX_ARCHIVED_DISPLAY_NAME` (100), the roster prefix bounded at
 * `MAX_ARCHIVED_STANDING_ROWS` (200), and each row's `uid` pinned to a document
 * id `usableUid` has already bounded. So unrelated text on a Player document
 * cannot contribute a byte, and a full-sized record is tens of kilobytes. Worse,
 * banning was the one remedy that can make the DOCUMENT bigger: it drops one
 * bounded row and adds a uid to `bannedUids`, which is stored on the very Event
 * the record has to fit beside.
 *
 * What is left, and what this now names: the Event's own retained fields, which
 * the projected-document check measures and which are the only unbounded things
 * in the sum — `days` with each Day's frozen Prompt list, `bannedUids` at up to
 * 1000 entries, and `mostLovedPhoto` at up to 100 winners.
 *
 * THE ONE EXCEPTION THIS USED TO CARRY IS CLOSED (Codex P2 on PR #1162, round 7).
 * It said the honours count on an Event with NO schedule was the honest exception,
 * because the derived fallback then yielded one honour per Day index any Player's
 * `dayStats` mentioned — a Player-written map with no rules validation — so one
 * near-1-MiB row really could push the record past its OWN share, and banning that
 * Player really was the remedy the sentence below denied. The supported-range
 * filter is what removed it: an honour is derived only for a Day the `DayDef`
 * contract has, so a Player contributes at most one bounded standings row, the
 * bounded headline pair, and at most `MAX_DAYS` bounded honours. Measured rather
 * than asserted — `src/data/post-sailing-archive.test.ts` § "the record's own
 * share cannot be filled" builds the largest record this builder can produce (200
 * rows at the uid and name bounds, every honour, a clipped Event name) and pins it
 * at ~74 KiB against the 256 KiB share, with the finding's own fixture (one row
 * carrying the maximal `dayStats` the rules admit, no schedule) at ~4 KiB. So the
 * "banning does not help" sentence is now true without qualification, and the
 * ceiling sentence below is what tells the Admin which measurement refused them.
 */
const TOO_LARGE_COPY =
  'These standings are too large to freeze onto the Event—the record and the Event data it would sit beside do not fit in one document. The record itself is bounded: 200 standings rows, at most one honour for each day the Event can have, and names clipped at 100 characters, copied field by field from each row. So the room is taken by what the Event already carries—the Day schedule with each Day’s frozen Prompt list, the ban list, and the Most-Loved award—and trimming one of those is what helps. Banning a Player does not: it drops one bounded row and adds a uid to the ban list stored on the same document.';

/** WHICH ceiling the draft met, appended wherever the draft is in hand (Codex P2
 *  on PR #1162). Two are measured and they mean different things: the record's
 *  own quarter of the budget, and the whole document it would land on. Only the
 *  console's pre-quiesce check can say — the flip's own `too-large` is decided
 *  server-side over a roster this surface never saw — so this is stated beside
 *  the shared copy rather than folded into it.
 *
 *  THE FIRST BRANCH IS UNREACHABLE WITH THE BOUNDS AS SHIPPED, and is kept for
 *  exactly that reason (Codex P2 on PR #1162, round 7). Once honours are capped
 *  at the supported Day range the largest record `draftEventArchive` can build is
 *  ~74 KiB against `MAX_ARCHIVE_BYTES`, so nothing an Admin can reach through this
 *  console fires it — but `MAX_ARCHIVED_STANDING_ROWS`, `MAX_ARCHIVED_UID` and
 *  `MAX_ARCHIVE_BYTES` are independent constants, and folding the two sentences
 *  into one would hand the Admin the Event-data advice on the day one of them
 *  moves. The size test named above is the tripwire that would fail first. */
const tooLargeCeiling = (draft: { bytes: number; projectedBytes: number }): string =>
  draft.bytes > MAX_ARCHIVE_BYTES
    ? ' The record is over its own share of the budget on its own, before the Event data is counted.'
    : ' The record fits its own share; it is the Event document that has no room left for it.';

/**
 * Stated identically wherever the record's SHAPE is refused — before the quiesce
 * (the blocked control) and after it (the flip's own report), like
 * `TOO_LARGE_COPY` beside it (#1151, Codex P1 on PR #1162).
 *
 * It is the backstop refusal, not an expected one: `draftEventArchive` coerces,
 * bounds and clamps every value it copies precisely so the record it builds is
 * always one `firestore.rules` accepts, and `writableArchiveRecord` asks the
 * boundary's own question on this side of the quiesce so a cause nobody
 * anticipated cannot arrive as a REJECTED write on an Event already shut. So the
 * copy names no lever an Admin can pull—there is none to name that the builder
 * has not already pulled itself—and says the one true thing instead: nothing was
 * closed or frozen, and a second identical attempt is not the remedy.
 */
const RECORD_UNWRITABLE_COPY =
  'These standings did not produce a record the Event will accept, so it cannot be frozen. Reload the console and try again—if it refuses a second time, the Event needs an operator rather than another attempt.';

/** Why the archive will not open when a Day's honour listener has DIED (Codex P2
 *  on PR #1162).
 *
 *  It says the honours could not be READ rather than showing what the fallback
 *  derived, because those are different records and only one of them is the one
 *  the freeze would take: a Day whose meta subscription errored before any
 *  server snapshot has no confirmed pin, the preview falls back to the
 *  roster-derived honour (or to none), and `archiveEvent`'s own
 *  `getDocFromServer` may then recover the PINNED holder and freeze them
 *  instead — permanently, and differently from what the Admin approved.
 *
 *  It also names the remedy, because unlike the loading state this one never
 *  clears itself: an `onSnapshot` error is terminal for that listener, so the
 *  fan only recovers when it is rebuilt. */
const HONORS_UNREADABLE_COPY =
  'The daily honours could not be read from the server, so the archive cannot tell a Day that had no First to BINGO from one whose honour never arrived. Reload the console and try again.';

/** Why the archive will not open over a schedule the FREEZE would refuse (#1151,
 *  Codex P2 on PR #1162).
 *
 *  `archiveEvent` turns down a stored schedule carrying a Day index that names no
 *  Day, or naming one Day twice (`usableDayIndexes` → `schedule-unusable`), and
 *  until this the console could not see that coming: the honour fan normalised
 *  both shapes away, every latch went true, and the Archive control armed. The
 *  Admin then closed play, the flip refused, and the handler reopened it — a
 *  round trip through a shut Event for a condition that was visible on screen the
 *  whole time.
 *
 *  "Names no Day" is the `DayDef` contract's own range, not merely readability
 *  (Codex P2 on PR #1162, round 7). `-1` and `MAX_DAYS` are integers that address
 *  real meta paths, so an Admin told the day "could not be read" would go looking
 *  for a broken entry and find one that looks perfectly fine — the copy names the
 *  actual defect instead.
 *
 *  It names the same repair the post-flip copy does, in the same words and at the
 *  same surface—the day schedule in Game settings, directly above this control—
 *  because it is the same defect caught earlier. */
const SCHEDULE_UNUSABLE_BLOCKED_COPY = `One of the days in the schedule above is not a day this Event can have—its number is missing, or outside the ${MAX_DAYS} a schedule holds—or the same day is listed twice, so the daily honours cannot be looked up one per day. Fix or re-save that day, then archive.`;

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
  // The record's own shape refused, which the flip reports without writing
  // anything exactly as the ceiling does (#1151, Codex P1 on PR #1162).
  'record-unwritable': 'closing',
  // An unusable Day entry in the stored schedule, which the freeze's raw read
  // refuses rather than dereferences (Codex P2 on PR #1162) — again writing
  // nothing, again with the quiesce still in force on the way out.
  'schedule-unusable': 'closing',
  // The Event document could not be fingerprinted, so the snapshot-defining
  // comparison could not be made at all (Codex P2 on PR #1162) — again nothing
  // written, again with the quiesce still in force on the way out.
  'config-unreadable': 'closing',
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
  'record-unwritable': `${RECORD_UNWRITABLE_COPY} Nothing was frozen.`,
  // Named as the Admin knows it—the day schedule in Game settings, the surface
  // this control sits at the bottom of—rather than as `EventDoc.days`. It is the
  // one refusal here with a repair the Admin can actually make from the console
  // they are already looking at.
  // …and it names WHY the day is unusable rather than only that it is (Codex P2
  // on PR #1162, round 7). "Could not be read" was true of a missing or
  // fractional index and false of the ones that matter most: `-1` and `10` read
  // perfectly well, they simply are not days this Event can have — so an Admin
  // sent looking for an unreadable day would have found one that looks fine.
  'schedule-unusable': `One of the days in the schedule above is not a day this Event can have—its number is missing, or outside the ${MAX_DAYS} a schedule holds—or the same day is listed twice, so the daily honours could not be looked up one per day and nothing was frozen. Fix or re-save that day, then archive again.`,
  // No lever to name, like `record-unwritable`: the defect is a value stored on
  // the Event document itself that nothing in the console can reach, and a
  // second identical attempt would meet it again (Codex P2 on PR #1162).
  'config-unreadable':
    'The Event’s own settings could not be read closely enough to tell whether they changed while the standings were being taken, so nothing was frozen. Reload the console and try again—if it refuses a second time, the Event needs an operator rather than another attempt.',
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
  'record-unwritable',
  'schedule-unusable',
  // IN for the same reason the four read refusals are (Codex P2 on PR #1162):
  // before it existed, an unfingerprintable Event threw out of `archiveEvent`,
  // past this set entirely, and left a live Event shut with the generic failure
  // pill over it.
  'config-unreadable',
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
 *  1. **Every preview input CURRENTLY server-committed, THE EVENT INCLUDED.**
 *     Until the server has spoken, an empty roster and an unpinned Day are
 *     indistinguishable from a roster the ADR 0006 persistent cache has not
 *     filled in yet — so the confirm row would understate what is about to be
 *     frozen. The Event document is the third input and it is gated the same way
 *     (`eventConfirmed`, Codex P2 on PR #1162): a non-null `event` is what the
 *     cache delivers, not what the server said, and the other two inputs resolve
 *     INDEPENDENTLY of it — so truthiness armed Archive over a stale schedule,
 *     name or ban list, and `dayCount` is derived from it besides, which makes an
 *     unanswered Day fan vacuously satisfied while it is absent.
 *
 *     AND ALL THREE ARE HELD TO THE SAME THREE FLAGS (Codex P2 on PR #1162).
 *     `useLeaderboard`'s `hasServerData` and `useDayMetasStatus`'s `serverLoaded`
 *     are LATCHES on "the server has spoken", which is a different claim from
 *     "this is what the server says". They never clear, so a console that
 *     confirmed every input and then went offline kept both true while the
 *     persistent cache re-served the roster and every honour — and Archive armed
 *     over precisely the cached preview the latches exist to refuse. A pending
 *     local write (a roster row, an honour pin) is the same hole from the other
 *     side: emitted server-backed but undecided, and rolled back if refused. So
 *     the roster is gated on `hasServerData && !fromCache && !hasPendingWrites`
 *     and the Day fan on `serverConfirmed`, which asks that of every Day's LATEST
 *     snapshot — the same test `eventConfirmed` carries for the Event document
 *     and `src/App.tsx` applies before it moves a Player off their Card. Each can
 *     fall false again, which is the point: the confirmation has to describe the
 *     preview on screen at the tap, not a moment that has passed. (The RECORD
 *     does not depend on these subscriptions at all — `archiveEvent` re-reads its
 *     inputs after the quiesce — but a console that is not looking at the server
 *     is still not a console to end an Event from, and the record the freeze
 *     takes is the one the Admin was shown.)
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
  // EVERY preview input is gated on its CURRENT committed snapshot, not on a
  // lifetime latch (Codex P2 on PR #1162). `hasServerData` and `serverLoaded`
  // say the server HAS spoken; neither says the rows and honours on screen right
  // now are what it said. Both are for life, so a console that confirmed its
  // inputs and then went offline kept reporting them confirmed while the ADR
  // 0006 persistent cache re-served every one — and the archive armed over
  // exactly the cached preview those latches exist to refuse. A pending local
  // write is the same hole from the other side: emitted server-backed but
  // undecided, and rolled back if it is refused. So the roster and the Day metas
  // are held to the three-flag test `eventConfirmed` already applies to the
  // Event document, and `src/App.tsx` to the redirect off a Player's Card.
  const {
    players,
    hasServerData: rosterSeen,
    fromCache: rosterFromCache,
    hasPendingWrites: rosterPending,
  } = useLeaderboard();
  const rosterConfirmed = rosterSeen && !rosterFromCache && !rosterPending;
  // THE SCHEDULE'S OWN DAY INDEXES, NOT ITS LENGTH (Codex P2 on PR #1162).
  // Passing a count subscribed this fan to `days/0 … days/n-1`, while
  // `archiveEvent` reads `days/{d.index}/meta/{d.index}` — the same set only
  // while the schedule is contiguous from zero. That is a property the setup
  // wizard's own draft validation enforces at authoring time and nothing
  // enforces on a STORED Event, and every day-scoped path in the estate keys on
  // `DayDef.index` (the #447 precedent).
  //
  // On a schedule where the two disagree the console lied, permanently. A
  // one-Day schedule at `index: 4` had this fan confirm `days/0/meta/0` — absent,
  // so the server answers an ordinary "no pin here" — every gate passed, the
  // preview showed the roster-DERIVED honour or none, and the Admin armed and
  // archived. The freeze then read `days/4/meta/4`, found the real pin, and
  // froze a different honour from the one on the screen that was approved.
  //
  // …and a schedule the FREEZE would refuse blocks the control rather than
  // arming it (Codex P2 on PR #1162). The fan normalises an unreadable index and
  // a repeated Day away so it can still complete, which made both invisible here
  // — so it reports that it had to, and `archiveEvent`'s own `usableDayIndexes`
  // is the question it reports on.
  const {
    metas: dayMetas,
    loaded: dayMetasLoaded,
    serverConfirmed: dayMetasConfirmed,
    failed: dayMetasFailed,
    scheduleUnusable,
  } = useDayMetasStatus(event?.days?.map((d) => d.index) ?? []);
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
  // …and the FOURTH, which is about the schedule rather than the record (Codex P2
  // on PR #1162). A stored schedule with an unreadable Day index or the same Day
  // listed twice is one the flip refuses as `schedule-unusable` — after the
  // quiesce, on an Event this control has already shut. The console can see it
  // from here, so it says so from here.
  const scheduleUsable = !scheduleUnusable;
  const ready =
    previewConfirmed && drained && fits && scheduleUsable && (finaleDone || beforeFinale);
  // Why the door is shut, in the order the Admin can act on it: nothing to do
  // about a loading roster but wait, whereas a pending claim names its own fix.
  //
  // A DEAD honours listener comes FIRST, ahead of the loading sentence (Codex P2
  // on PR #1162). A Day whose subscription died before any server snapshot can
  // never be confirmed, so "loading" would be a message that never resolves —
  // and the Admin would be left waiting on a control that is not going to open.
  // It is stated as what it is: the honours could not be read, and the preview
  // beside it is showing whatever the roster derives rather than the pins the
  // freeze would find.
  //
  // BUT ONLY WHILE THE CONFIRMATION IS ACTUALLY MISSING (CodeRabbit, PR #1162).
  // `failed` is not the complement of `dayMetasConfirmed`: a Day the server
  // answered before its listener died stays confirmed, and nothing clears it. So
  // `failed` alone printed this terminal sentence — "reload the console and try
  // again" — beside an ENABLED Archive control, telling an Admin to fix
  // something that was not blocking them. The two now agree by construction:
  // this is the reason the door is shut, so it is stated only when the door is
  // shut on it.
  //
  // …and the third precondition now has TWO refusals behind it, so it is stated
  // by NAME rather than by `!fits` (#1151, Codex P1 on PR #1162). The ceiling and
  // the shape send an Admin after entirely different things — one names the Event
  // data to trim, the other says there is nothing to trim and to reload instead —
  // so folding them into one sentence would give the wrong advice to whichever
  // one fired.
  const nothingClosedYet = closing
    ? ' Play is already closed—nothing has been frozen.'
    : ' Nothing has been closed.';
  //
  // AND AN UNUSABLE SCHEDULE COMES FIRST OF ALL (Codex P2 on PR #1162). It is
  // terminal in the same way a dead honours listener is — nothing here resolves
  // it and waiting does not help — but unlike every other reason on this list it
  // names a repair the Admin can make on the surface they are already looking at,
  // and it is upstream of the honours the sentence below is about: the Days those
  // pins would be read from are the ones the schedule cannot name.
  const blockedReason = scheduleUnusable
    ? `${SCHEDULE_UNUSABLE_BLOCKED_COPY}${nothingClosedYet}`
    : dayMetasFailed && !dayMetasConfirmed
      ? `${HONORS_UNREADABLE_COPY}${nothingClosedYet}`
      : !previewConfirmed || !pendingClaimsLoaded
      ? 'Loading the final standings—the archive stays closed until every one of them is confirmed by the server.'
      : blockingClaims.length > 0
        ? `Resolve the ${blockingClaims.length} pending claim${blockingClaims.length === 1 ? '' : 's'} in the Review queue first. Confirming or rejecting a claim writes to a Board, which the freeze denies—so a claim left pending here stays pending forever.${closing ? ' Reopen play to drain the queue, then archive again.' : ''}`
        : draft.refusal === 'too-large'
          ? `${TOO_LARGE_COPY}${tooLargeCeiling(draft)}${nothingClosedYet}`
          : draft.refusal === 'record-unwritable'
            ? `${RECORD_UNWRITABLE_COPY}${nothingClosedYet}`
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
                disabled={!previewConfirmed || !drained || !fits || !scheduleUsable}
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
                  {/* And the same sentence for a HONOUR the record cannot carry
                      (#1151, Codex P2 on PR #1162): a pinned holder whose id is
                      not one the record can express, or an honour on a Day the
                      schedule does not have. A discarded pin leaves its Day with
                      no honour at all rather than handing it to the roster's
                      runner-up, so the strip the Admin approves is shorter than
                      the one on screen — which is exactly the surprise this
                      count exists to remove. */}
                  {draft.skippedHonors > 0 &&
                    ` ${draft.skippedHonors} unreadable daily honor${draft.skippedHonors === 1 ? '' : 's'} will not be included.`}
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
