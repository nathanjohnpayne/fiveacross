import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useBoard, useEventDoc, useMyDayBoards, useMyPlayer, useLeaderboard, useMyClaims } from '../hooks/useData';
import { resolveDisplayName } from '../data/api';
import {
  broadcastBingo,
  broadcastBlackout,
  broadcastFirstBingo,
  hasPriorBingoWitness,
  planConfirmBroadcasts,
  getConfirmState,
  type MomentActor,
} from '../data/moments';
import { hasBingo, standingsFrozen, tutorialDayIndexSet } from '../game/logic';
import type { BoardDoc, Cell, EventDoc, PlayerDoc } from '../types';
import { EVENT_ID } from '../firebase';

/** A confirm awaiting its board write: the Claim's cell AND the proof it resolves on. */
interface AwaitingConfirm {
  cellIndex: number;
  // The Claim's proofId. `confirmClaim` (src/data/admin.ts) resolves the board cell
  // by `x.proofId === c.proofId` when the Claim has one, so the confirmed cell carries
  // THIS proofId — the claim-specific match below. `null` = a legacy Claim with no
  // proofId, which resolves by index (the historical fallback).
  proofId: string | null;
  // The Claim's Day (#274): a daily Claim adjudicates against ITS day-scoped
  // board and its Moments name that Day. `null` = a legacy single-board Claim.
  dayIndex: number | null;
  // The Claim's creation time — the batch's ceremony ORDER (Codex P3 on #288
  // round 3): when two Day groups cross eligible bingos in one drain, the
  // event singleton goes to the group whose claim was raised FIRST (the claim
  // precedes its win), not to the lowest day number.
  createdAt: number;
}

/**
 * Whether the resolve() board write for a SPECIFIC confirmed Claim has LANDED
 * (Codex #116 R3 finding 3 + R4 finding 2): the cell at `cellIndex` must be MARKED,
 * `status === 'confirmed'`, AND — when the Claim carries a `proofId` — the cell's
 * `proofId` must MATCH it. A weaker `status !== 'pending'` test wrongly treated a
 * not-yet-arrived board (a stale cell with `status: undefined`) as reflected; and an
 * index-only test wrongly treated a DIFFERENT claim's confirm at the same square as
 * this Claim's (a player with two pending submissions for one square — `confirmClaim`
 * resolves by proofId, so an older Claim can confirm without touching the current
 * cell). Matching the proofId adjudicates only the Claim the board cell actually
 * reflects. A legacy Claim (no proofId) falls back to marked+confirmed by index.
 */
function cellReflectsConfirm(cells: Cell[], entry: AwaitingConfirm): boolean {
  const cell = cells.find((x) => x.index === entry.cellIndex);
  if (cell == null || cell.marked !== true || cell.status !== 'confirmed') return false;
  return entry.proofId == null || cell.proofId === entry.proofId;
}

/**
 * The confirm-path Moment emitter (issue #41 — the deferred PR #99 finding 6).
 *
 * In `admin_confirmed` Claim Mode a Mark starts PENDING and is excluded from the
 * win mask (`game/logic`: `marked && status !== 'pending'`), so an `attachProof`
 * in that mode crosses no win transition — Board's action-path broadcast
 * (`broadcastWinVerdict`, PR #104/#110) intentionally emits nothing at attach time
 * (a pending claim can be REJECTED and a Moment is immutable). The win — and its
 * Moment — materialize only when an Admin CONFIRMS the Claim: `resolve()`
 * (src/data/admin.ts) flips the cell `pending → confirmed` and recomputes the
 * winner's stats. But that confirm can land while the winning Player is off the
 * Card route (Board unmounted) or offline, so Board's route-scoped machinery never
 * sees it. Left unaddressed, the leaderboard and stats update while the Feed
 * silently misses the win.
 *
 * This component closes that gap. It is mounted ONCE at the app shell — OUTSIDE the
 * tab Routes — so it runs wherever the Player is. It watches the Player's OWN
 * Claims (`useMyClaims`, a `where('uid','==',uid)`-scoped read the rules permit),
 * notices when one flips to `confirmed`, waits for the confirm's board write to
 * reflect the flip, and emits the SAME Moment(s) the live edge would have —
 * attributed to the WINNER (the claim owner), NEVER the confirming Admin, and
 * written as the winner (`isOwner` create), so it needs no rules change.
 *
 * Four properties, mirroring the #110 live pipeline (Codex #116 review):
 *   1. TRANSITION-GATED (finding 1). `planConfirmBroadcasts` emits only what the
 *      just-confirmed cells CROSSED (measured against the board with those cells
 *      forced back to pending) — a confirm that completes no new line, or one made
 *      while a bingo already stood, emits nothing.
 *   2. DRAIN-UNTIL-EMPTY (finding 2). The witness read is async; a second confirm
 *      arriving while it is in flight is enqueued and the drain re-runs on settle
 *      until the queue is empty, so no confirm is stranded.
 *   3. FRESH-CONFIRM WITNESS (finding 3). A confirm is fresh (emits) only if this
 *      listener observed the Claim PENDING while mounted; a Claim already confirmed
 *      at first sight is baselined as history. This is the key discriminator, not a
 *      first-snapshot latch — so a confirm that becomes visible only on RECONNECT
 *      (the offline-but-open case) still emits, while only a confirm that landed
 *      while the app was FULLY CLOSED is the accepted residual.
 *   4. UID-KEYED PERSISTENCE (finding 4). The working state lives in module scope
 *      keyed by uid (`getConfirmState`, mirroring the #110 pending queue), so an
 *      account switch PARKS held work (including a roster-held first_bingo) and a
 *      switch-back resumes it rather than baselining the now-confirmed Claim away.
 *
 * Exactly-once and no-false-singleton are preserved by COMPOSITION: the writers'
 * deterministic doc ids (`${uid}-bingo` / `${uid}-blackout` / the `first_bingo`
 * singleton) are create-only and immutable, so a live edge that also posts the same
 * win makes this emit a denied/skipped no-op; and the ceremonial First-to-BINGO
 * applies the SAME roster gate the live path does, so a confirm racing another
 * Player's live first-BINGO is suppressed-or-correct — never a false singleton.
 */
export default function ConfirmWinMoments() {
  const { user } = useAuth();
  const uid = user?.uid;
  const eventId = EVENT_ID;
  const { data: board } = useBoard(uid);
  // Daily-cards mode (#274): a confirmed Claim's board write lands on the
  // DAY-SCOPED board for the Claim's own dayIndex — subscribe the viewer's
  // dealt Day Cards (bounded by the schedule length) so the drain can
  // adjudicate each Claim against ITS board. Legacy events keep the single
  // `useBoard` above; the two paths never mix (a Claim either carries a
  // dayIndex or it does not).
  const { data: event } = useEventDoc(!!uid);
  // Canonical DayDef.index values, not array positions (#447 precedent, #474):
  // the fan keys board paths AND the echo seed-trust registry on d.index.
  const dayBoards = useMyDayBoards(uid, event?.days?.map((d) => d.index) ?? []);
  const { data: player, loading: playerLoading, hasServerData: playerConfirmed } = useMyPlayer(uid);
  const { players, hasServerData: rosterConfirmed } = useLeaderboard();
  const { claims, fromCache: claimsFromCache } = useMyClaims(uid);

  const displayName = resolveDisplayName(player, user?.displayName);
  // The SAME identity tri-state Board uses (knownFirstBingoAt / doMark): HOLD every
  // broadcast until the saved row is known, so a returning Player's stale auth name
  // is never stamped into an immutable Moment.
  const identityKnown = !playerLoading && (player !== null || playerConfirmed);

  // Latest actor + gates + attributable board, in a ref so the stable callbacks and
  // the async witness continuation always read CURRENT state, never a stale closure.
  const ctx = useRef<{
    eventId: string;
    uid: string | undefined;
    displayName: string;
    photoURL: string | null;
    players: PlayerDoc[];
    rosterConfirmed: boolean;
    identityKnown: boolean;
    cells: Cell[];
    boardOwned: boolean;
    dayBoards: ReadonlyMap<number, BoardDoc>;
    event: EventDoc | null;
    tutorialDays: ReadonlySet<number>;
  }>({
    eventId,
    uid: undefined,
    displayName: 'Anonymous',
    photoURL: null,
    players: [],
    rosterConfirmed: false,
    identityKnown: false,
    cells: [],
    boardOwned: false,
    dayBoards: new Map(),
    event: null,
    tutorialDays: new Set(),
  });
  // The cells a Day's confirms adjudicate against (#274): that Day's own board
  // in daily mode (owned by construction — useMyDayBoards subscribes only the
  // viewer's docs, and a foreign uid is re-checked), the attributable legacy
  // board when the Claim carried no Day. `null` = that board isn't available
  // yet (hold; a later snapshot retries).
  const cellsForDay = (c: typeof ctx.current, dayIndex: number | null): Cell[] | null => {
    if (dayIndex != null) {
      const dayBoard = c.dayBoards.get(dayIndex);
      return dayBoard && dayBoard.uid === c.uid && dayBoard.cells.length > 0 ? dayBoard.cells : null;
    }
    return c.boardOwned && c.cells.length > 0 ? c.cells : null;
  };
  const cellsForDayRef = useRef(cellsForDay);
  // Async routing refs describe the latest COMMITTED app-shell view. Updating
  // them during render lets an abandoned concurrent Event-B render poison an
  // Event-A witness that still belongs to the visible tree.
  useLayoutEffect(() => {
    ctx.current = {
      eventId,
      uid,
      displayName,
      photoURL: player ? player.photoURL : (user?.photoURL ?? null),
      players,
      rosterConfirmed,
      identityKnown,
      cells: board?.cells ?? [],
      boardOwned: board != null && board.uid === uid,
      dayBoards,
      event: event ?? null,
      tutorialDays: tutorialDayIndexSet(event?.days),
    };
    cellsForDayRef.current = cellsForDay;
  });

  // Self-reference so the async settle continuation can loop the drain until the
  // queue is empty (finding 2) without capturing a stale callback.
  const drainRef = useRef<() => void>(() => {});

  // Emit for any awaiting confirm whose board flip has landed. Reads the prior-win
  // witness ONCE (birth-time, before the plain bingo posts), plans the TRANSITION
  // the confirmed cells crossed, broadcasts, and parks a still-unconfirmed ceremony.
  const drain = useCallback(() => {
    const c = ctx.current;
    if (!c.uid || !c.identityKnown) return;
    const st = getConfirmState(c.uid, c.eventId);
    if (st.inFlight || st.awaiting.size === 0) return;
    // A confirm is "reflected" only once the resolve() board write has LANDED for its
    // OWN cell — marked + status 'confirmed' + matching proofId (cellReflectsConfirm,
    // Codex #116 R3 finding 3 + R4 finding 2) — on the board the CLAIM belongs
    // to (#274: the day-scoped board in daily mode). Only spend a witness read
    // if at least one awaiting confirm is reflected on its own board.
    const anyReflected = [...st.awaiting.values()].some((e) => {
      const cells = cellsForDayRef.current(c, e.dayIndex);
      return cells != null && cellReflectsConfirm(cells, e);
    });
    if (!anyReflected) return;
    const actedUid = c.uid;
    const actedEventId = c.eventId;
    st.inFlight = true;
    // Tutorial-Day wins are excluded from the prior-win witness (Codex P1 on
    // #288, mirroring the live path): an admin-approved warm-up bingo writes
    // the legacy once-per-Player `${uid}-bingo` doc too, and reading it as a
    // prior win would permanently disqualify the player's first MAIN-GAME
    // confirm from the ceremony. `dayIndexes` (#372) hands over the schedule so
    // the PER-CARD witness ids are probed here exactly as on the live path —
    // without it this path would see only the legacy doc and could re-mint a
    // ceremony for a Player whose prior win now lives at a day-scoped id.
    void hasPriorBingoWitness(actedUid, {
      excludeDayIndexes: c.tutorialDays,
      dayIndexes: c.event?.days?.map((d) => d.index),
      eventId: actedEventId,
    })
      .then((witnessed) => {
        const st2 = getConfirmState(actedUid, actedEventId);
        st2.inFlight = false;
        const cc = ctx.current;
        // Account switched away mid-read (finding 4): leave the awaiting entries in
        // the uid-keyed state so a switch-BACK resumes them; never emit with the
        // wrong actor or against another account's board. The board-availability
        // check is per-entry now (#274) — cellsFor holds an entry whose board
        // isn't attributable/present.
        if (cc.uid === actedUid && cc.eventId === actedEventId) {
          // Recompute reflected from the CURRENT post-await state, NOT a pre-await
          // snapshot (Codex #116 R4 finding 1): a sibling confirm that landed while the
          // witness read was in flight is now in `st2.awaiting` and its cell is on
          // `cc.cells`, so it must be adjudicated in THIS pass rather than masking (or
          // being masked by) the earlier one. All currently-reflected confirms are
          // adjudicated as ONE batch — `confirmedIndexes` holds every reflected cell,
          // so `planConfirmBroadcasts` measures the transition this batch CROSSED with
          // each sibling forced back to pending, and no confirm reads another as an
          // already-standing win. Concurrent multi-confirm is then deterministic: the
          // batch emits exactly the kinds it crossed, once each (deterministic-id
          // dedup besides), and the winner-attributed Moment is never lost or doubled.
          // #274: adjudicate PER BOARD — group the reflected confirms by the
          // Day they belong to (null = the legacy single board). Each group's
          // transition is measured against ITS OWN board with its own siblings
          // forced back to pending, exactly as before; groups on different
          // boards are independent wins by construction (one card each).
          const groups = new Map<number | null, Array<[string, AwaitingConfirm]>>();
          for (const [id, e] of st2.awaiting.entries()) {
            const cells = cellsForDayRef.current(cc, e.dayIndex);
            if (cells != null && cellReflectsConfirm(cells, e)) {
              const key = e.dayIndex;
              const list = groups.get(key) ?? [];
              list.push([id, e]);
              groups.set(key, list);
            }
          }
          const actor: MomentActor = { uid: actedUid, displayName: cc.displayName, photoURL: cc.photoURL };
          // ONE ceremonial decision per batch (Codex P2 on #288): first_bingo
          // is the event singleton, so when two Day groups both cross an
          // eligible bingo in the same batch, only ONE may fire or park it —
          // the group whose claim was raised EARLIEST (round 3 P3: the claim
          // precedes its win, so claim age approximates which bingo crossed
          // first far better than day number; day index breaks ties). The
          // true cross-player race still resolves at the create-once doc id.
          // A ceremony already parked from an earlier batch keeps its slot
          // (never overwritten by a later group).
          let ceremonyOpen = st2.heldCeremony == null;
          let plainBingoOpen = true;
          const groupAge = (entries: Array<[string, AwaitingConfirm]>) =>
            Math.min(...entries.map(([, e]) => e.createdAt));
          const orderedGroups = [...groups.entries()].sort(
            ([a, ea], [b, eb]) => groupAge(ea) - groupAge(eb) || (a ?? -1) - (b ?? -1),
          );
          for (const [dayKey, entries] of orderedGroups) {
            const cells = cellsForDayRef.current(cc, dayKey);
            if (cells == null) continue;
            const plan = planConfirmBroadcasts({
              cells,
              confirmedIndexes: entries.map(([, e]) => e.cellIndex),
              uid: actedUid,
              roster: cc.players,
              rosterConfirmed: cc.rosterConfirmed,
              hasPriorBingo: witnessed,
            });
            // The Day rides every broadcast (#274): the per-card blackout id
            // (#267), and the bingo/first_bingo payload chips (#262). A legacy
            // (null-day) group keeps the day-less calls. NO day-honor pin here
            // (Codex P3 on #287): `confirmClaim` already pins the per-Day First
            // to BINGO inside the ADMIN's resolve transaction (src/data/admin.ts,
            // the isAdmin arm of the day-meta create rule), so a winner-side pin
            // would only re-create an existing write-once doc — denied noise.
            const day = dayKey ?? undefined;
            // The bingo Moment is PER CARD since #372, so a batch crossing
            // bingos on TWO Day boards must fire one Moment PER Day — each has
            // its own `${uid}-bingo-d${day}` id and would be accepted. The
            // once-per-Player `plainBingoOpen` gate below is now correct ONLY
            // for the legacy day-less id, where a second same-tick call could
            // still only churn the local cache before the server denied it
            // (Codex P2 on #288 round 4). Exactly the blackout shape (#267).
            if (plan.bingo) {
              if (day !== undefined) {
                broadcastBingo(actor, day, actedEventId);
              } else if (plainBingoOpen) {
                broadcastBingo(actor, day, actedEventId); // `day` is undefined here — the legacy id
                plainBingoOpen = false;
              }
            }
            if (plan.blackout) broadcastBlackout(actor, day, actedEventId);
            // The ceremonial event singleton is anchored to MAIN-GAME Days only
            // (Codex P1 on #287; daily-cards-spec § "Scoring and social
            // surfaces": the embark card is live pre-cruise and trivially easy
            // by design) and never minted POST-FREEZE (the second P1; mirrors
            // the live path's verdict-time gate, Codex P2 on #278) — a late
            // admin approval must not rewrite the settled headline honor. Both
            // gates are decision-time: an ineligible group neither fires NOR
            // parks a held candidate. The plain bingo/blackout above (and
            // confirmClaim's own per-Day honor pin) still land.
            const ceremonyEligible =
              (dayKey == null || !cc.tutorialDays.has(dayKey)) && !standingsFrozen(cc.event) && ceremonyOpen;
            if (plan.firstBingo && ceremonyEligible) {
              broadcastFirstBingo(actor, day, actedEventId);
              ceremonyOpen = false;
            } else if (plan.firstBingoHeld && ceremonyEligible) {
              st2.heldCeremony = actor;
              st2.heldCeremonyDay = dayKey;
              ceremonyOpen = false;
            }
            entries.forEach(([id]) => st2.awaiting.delete(id));
          }
          // Drain-until-empty: any confirm still awaiting (its board write not yet
          // landed) is retried on the next board snapshot; re-run in case one became
          // reflected during this synchronous emit.
          drainRef.current();
        }
      })
      .catch(() => {
        getConfirmState(actedUid, actedEventId).inFlight = false;
      });
  }, []);
  drainRef.current = drain;

  // Resolve — or FALL-CLEAR — a first-BINGO candidate parked at the roster gate.
  // Runs on every board update while holding (never re-reads the witness — eligibility
  // was fixed at detection).
  //
  // FALL-CLEARING (Codex #116 R2 finding 1): the held candidate is identified with the
  // ORIGINAL win; if that win no longer STANDS on an attributable board, VOID it —
  // REGARDLESS of roster/identity state. Without this, a slow-roster window let a
  // player lose the held bingo then complete a DIFFERENT line before the roster
  // confirmed, and the publish-time `hasBingo` check would then fire the STALE held
  // singleton against the REGAINED board. Because the board effect runs on every
  // snapshot, the unmark that drops the bingo produces a no-bingo snapshot that clears
  // the candidate here BEFORE any regain — mirroring the #110 round-4 fall clearing
  // (drop the candidate on an observed bingo fall). A later regained line is a NEW win,
  // adjudicated by its own confirm transition, never this candidate.
  const resolveHeldCeremony = useCallback(() => {
    const c = ctx.current;
    if (!c.uid) return;
    const st = getConfirmState(c.uid, c.eventId);
    const actor = st.heldCeremony;
    if (!actor || actor.uid !== c.uid) return;
    // Fall-clear against the board the held win STOOD on (#274): its own Day
    // Card when the win carried a Day, the legacy board otherwise.
    const heldDay = st.heldCeremonyDay ?? null;
    const cells = cellsForDayRef.current(c, heldDay);
    // A missing / non-attributable board is NOT an observed fall — hold.
    if (cells == null) return;
    // Attributable board with no standing bingo → the held win fell: drop it, even
    // while the roster is still unconfirmed.
    if (!hasBingo(cells)) {
      st.heldCeremony = null;
      st.heldCeremonyDay = null;
      return;
    }
    // The freeze can land while the candidate is parked (Codex P2 on #288
    // round 3): admin approvals are arbitrarily delayed, so re-check at
    // RELEASE time and VOID a candidate the finale has overtaken — the
    // headline honor is settled with the podium and a late roster
    // confirmation must not rewrite it.
    if (standingsFrozen(c.event)) {
      st.heldCeremony = null;
      st.heldCeremonyDay = null;
      return;
    }
    // The win still stands — publish only once the identity + roster gates open.
    if (!c.identityKnown || !c.rosterConfirmed) return; // still held
    const othersBingoed = c.players.some((p) => p.uid !== c.uid && p.firstBingoAt != null);
    if (!othersBingoed) broadcastFirstBingo(actor, heldDay ?? undefined, c.eventId);
    st.heldCeremony = null;
    st.heldCeremonyDay = null;
  }, []);

  // Detect fresh confirms. A Claim seen PENDING is remembered; a Claim seen
  // CONFIRMED is a fresh emit only if it was previously seen pending — so a Claim
  // already confirmed at first sight (history / the fully-closed residual) is
  // baselined, while a pending→confirmed flip observed while mounted (INCLUDING one
  // that becomes visible only on reconnect) emits (round-1 finding 3).
  //
  // SERVER-BACKED WITNESS ONLY (Codex #116 R2 finding 2): the pending observation
  // that seeds the freshness witness must come from a SERVER-backed snapshot, never a
  // cache-only one. On a fresh reload the persistent IndexedDB cache replays the
  // last-known rows; a Claim that was pending at close and confirmed WHILE CLOSED
  // could otherwise be recorded pending from that cache snapshot, making the
  // subsequent server `confirmed` look like an in-session flip and posting a NEW
  // Moment (with `Date.now()`) that pins an OLD admin confirmation to the Feed top.
  // Gating the seed on `!claimsFromCache` keeps the fully-closed confirm baselined
  // (the accepted residual) while the offline-BUT-OPEN case still fires — that case
  // observed the Claim pending from a server snapshot IN-SESSION before going offline,
  // so it seeds normally and its reconnect `confirmed` is a genuine fresh transition.
  useEffect(() => {
    if (!uid) return;
    const st = getConfirmState(uid, eventId);
    let added = false;
    for (const c of claims) {
      // Cross-account guard (Codex #116 R3 finding 1): on an account switch, useColSub
      // clears the previous query's rows only in an effect, so this component can
      // render once — or a queued stale listener callback can fire — with the PREVIOUS
      // account's Claims under the NEW uid. Ignore any Claim not owned by the current
      // uid at the point of use, so a prior account's Claim can neither seed this
      // account's witness nor adjudicate against its board (belt-and-braces beyond the
      // effect-time clear, the same synchronous attribution guard #110/#106 use).
      if (c.uid !== uid) continue;
      if (c.status === 'pending') {
        if (!claimsFromCache) st.seenPending.add(c.id);
      } else if (c.status === 'confirmed' && st.seenPending.has(c.id) && !st.handled.has(c.id)) {
        st.handled.add(c.id);
        // Carry the proofId so reflection is claim-SPECIFIC (R4 finding 2): a
        // different claim's confirm at the same square must not count as this one's.
        // And the Claim's Day (#274) so the drain adjudicates against ITS board.
        st.awaiting.set(c.id, {
          cellIndex: c.cellIndex,
          proofId: c.proofId ?? null,
          dayIndex: typeof c.dayIndex === 'number' ? c.dayIndex : null,
          createdAt: c.createdAt,
        });
        added = true;
      }
    }
    if (added) drain();
  }, [claims, claimsFromCache, uid, eventId, drain]);

  // Re-attempt on a board snapshot (the confirm's board write can lag its claim) or
  // when a gate opens (identity resolves / the roster becomes server-confirmed).
  useEffect(() => {
    // Fall-clear FIRST (Codex P2 on #288 round 4): a parked candidate whose
    // win has fallen must free the ceremony slot before the drain adjudicates
    // new confirms from the same snapshot — the reverse order let a stale
    // held candidate block a fresh eligible win from parking (the fresh
    // confirm was consumed ceremony-less, then the stale candidate voided,
    // and the later roster confirmation emitted nothing).
    resolveHeldCeremony();
    drain();
  }, [board, dayBoards, identityKnown, rosterConfirmed, drain, resolveHeldCeremony]);

  return null;
}
