import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useEventDoc, useDayMetasStatus, useLeaderboard, useProofKindsByUid, isBanned } from '../hooks/useData';
import type { ProofKindFlags } from '../hooks/useData';
import { useOnline } from '../hooks/useOnline';
import {
  ceremonialDayIndexSet,
  cruiseFirstBingoUid,
  resolvedStandingsFreezeAt,
  tutorialDayIndexSet,
} from '../game/logic';
import { dayHonorChipLabel, pinnedOrDerivedDailyHonors } from '../data/finale';
import { isEventArchived } from '../data/eventArchive';
import { confirmedArchiveGeneration } from '../data/archiveConfirmation';
import ArchivedLeaderboard from './ArchivedLeaderboard';
import { track } from '../analytics';
import { shareOrigin } from '../canonicalHost';
import { EVENT_ID } from '../firebase';
import { renderLeaderboardShareCard, shareCardBlob, shareCardAppName, type LeaderboardShareRow } from './ShareCard';
import { editionBrand, editionLexicon } from '../editions';
import Avatar from './Avatar';
import { EmojiText } from './EmojiText';
import type { EventDoc, PlayerDoc } from '../types';
import LoadingState from './LoadingState';

function when(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

type LeaderboardFilter = 'all' | 'bingo' | 'blackout';

const FILTERS: Array<{ id: LeaderboardFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'bingo', label: 'With BINGO' },
  { id: 'blackout', label: 'Blackout' },
];

/**
 * How long the routing gate below waits for a SERVER-committed Event once the
 * ADR 0006 persistent cache has already answered, before it settles on what the
 * cache said (Codex P1 on PR #1165).
 *
 * The wait exists because `onSnapshot` has no "the server is unreachable"
 * signal. Behind a captive or partially routed Wi-Fi portal — the ship's normal
 * network, and this app's whole operating context — Firestore serves the cached
 * document with `fromCache: true` and RETRIES indefinitely: it never calls the
 * error callback, so `serverResolved` stays false, and `navigator.onLine` reads
 * TRUE, so the offline escape never fires either. Neither of the two things that
 * end the wait short of a server snapshot could happen, and the Leaderboard sat
 * on its spinner for the whole crossing.
 *
 * A few seconds rather than a round-trip estimate: it is not measuring the
 * network, it is bounding how long a Player stares at a spinner before being
 * shown the record their own device already has. Long enough that an ordinary
 * slow answer still WINS the race (a server snapshot inside the window resolves
 * the wait immediately and routes on the truth), short enough that a portal is
 * not the rest of the sailing. Exported so the tests drive the real constant
 * rather than a number that can drift away from it.
 */
export const CACHED_EVENT_SETTLE_MS = 4_000;

/**
 * Presentational-only predicate (ADR 0001: the Leaderboard is a for-fun tally,
 * not a tamper-proof record). It decides which already-ranked rows are
 * visible; it never reorders or re-ranks — `sortPlayers` (src/game/logic.ts)
 * stays the single source of order.
 */
function matchesFilter(p: PlayerDoc, filter: LeaderboardFilter): boolean {
  switch (filter) {
    case 'bingo':
      return p.bingoCount > 0;
    case 'blackout':
      return !!p.blackout;
    default:
      return true;
  }
}

// The Leaderboard row's proof-kind chip set (#604): the UNION of proof kinds
// that Player has used across their active Proofs — 📷/🖼️/🎙️/✍️ per
// `ProofKindFlags` (`useProofKindsByUid`) — not just their latest Proof's
// kind (#218's original behavior). Stable order regardless of which order
// the Player used them in: 📷 🖼️ 🎙️ ✍️. Stays emoji per #220's rule. `[]`
// when `flags` is `undefined` (no active Proof at all).
function proofChips(flags: ProofKindFlags | undefined): string[] {
  if (!flags) return [];
  const chips: string[] = [];
  if (flags.photo) chips.push('📷');
  if (flags.library) chips.push('🖼️');
  if (flags.audio) chips.push('🎙️');
  if (flags.text) chips.push('✍️');
  return chips;
}

// Share Card row cap (issue #36; lowered 8→5 for the text-message-first
// redesign, issue #423; raised 5→10 by issue #444 — five left the fixed
// frame looking bare mid-cruise): the card shows the top MAX_SHARE_ROWS by
// rank — the renderer lays the first three out as a podium and the
// remainder as compact rows, so ten (podium + seven) is the frame's shape,
// eleven (podium + eight) when the First-BINGO pin is appended from outside
// the top ten.
const MAX_SHARE_ROWS = 10;

export function leaderboardShareCopy(
  event: Pick<EventDoc, 'name' | 'days'> | null | undefined,
  now = Date.now(),
): { eventName: string; contextLine: string | undefined; statLine: string | undefined; cacheKey: string } {
  const eventName = event?.name ?? shareCardAppName();
  const days = [...(event?.days ?? [])].sort((a, b) => a.index - b.index);
  const unlocked = days.filter((d) => d.unlockAt <= now);
  const currentDay = unlocked.length ? unlocked[unlocked.length - 1] : days[0];
  const contextLine =
    currentDay && event?.name
      ? `${event.name} · Day ${currentDay.index + 1} · ${currentDay.place}`
      : undefined;
  const statLine = days.length
    ? `Through Day ${(currentDay?.index ?? days.length - 1) + 1} of ${days.length}`
    : undefined;
  return {
    eventName,
    contextLine,
    statLine,
    cacheKey: JSON.stringify({ eventName, contextLine, statLine }),
  };
}

function toShareRow(p: PlayerDoc, rank: number, firstBingoUid: string | undefined): LeaderboardShareRow {
  return {
    uid: p.uid,
    rank,
    displayName: p.displayName,
    bingoCount: p.bingoCount,
    squaresMarked: p.squaresMarked,
    blackout: !!p.blackout,
    firstToBingo: p.uid === firstBingoUid,
  };
}

/**
 * Shapes the Share Card's row list from the FULL (already `sortPlayers`-
 * ordered) roster — independent of the presentational filter above, same
 * principle as the pin itself (specs/w2-leaderboard.md): the top `maxRows`
 * by rank, plus the First to BINGO Player appended at the end when their
 * rank falls outside that slice, so the pin can never silently drop off the
 * card just because its holder isn't otherwise a top-ranked Player.
 */
function buildShareStandings(
  players: PlayerDoc[],
  firstBingoUid: string | undefined,
  maxRows: number,
): LeaderboardShareRow[] {
  const ranked = players.map((p, i) => toShareRow(p, i + 1, firstBingoUid));
  const top = ranked.slice(0, maxRows);
  if (firstBingoUid && !top.some((r) => r.uid === firstBingoUid)) {
    const pinned = ranked.find((r) => r.uid === firstBingoUid);
    if (pinned) top.push(pinned);
  }
  return top;
}

/**
 * The Leaderboard's routing half, and the ONLY hook it owns is the Event doc
 * every Player already subscribes to.
 *
 * #1152: once the Event is archived, the FROZEN record supersedes the live
 * roster entirely — `ArchivedLeaderboard` renders `EventDoc.archive`, so the
 * standings a returning Player sees are the ones the archive stamped, not a
 * re-derivation over rows that may since have been moderated.
 *
 * THE SPLIT IS WHAT MAKES THAT TRUE, not just what it renders. The live view's
 * three subscriptions — the whole `players` roster, every Day's meta document,
 * and up to 60 live Proofs — belong to `LiveLeaderboard` below, so an archived
 * visit never opens them. With the branch inside one component the hooks had
 * already run by the time it was reached: the archived page rendered from the
 * snapshot while a listener fan stayed open behind it, which is the opposite of
 * the spec's "it subscribes to NOTHING".
 *
 * A component boundary is also the only way to do this without breaking the #280
 * hook-order rule. Conditioning the hooks in place is illegal in React; returning
 * a DIFFERENT component unmounts the live one and its listeners with it, and each
 * component's own hook sequence stays fixed.
 *
 * AND THE LIVE BRANCH WAITS FOR THE SERVER (Codex P2, PR #1139 round 5). The
 * split decides nothing on a cold visit, where `useEventDoc` starts at
 * `data: null` and the ADR 0006 persistent cache can then replay the Event as it
 * stood when the tab last saw it — `active`, because it was. Falling through to
 * the live child on either of those mounts the whole listener fan the archived
 * page exists not to open, and the archived branch then arrives a snapshot later
 * and tears it down again. The listeners were open; "it subscribes to NOTHING"
 * was false for exactly as long as the roster, every Day's meta and 60 Proofs
 * took to answer.
 *
 * So an UNRESOLVED status renders the live view's own loading state — the same
 * label, so there is no visible seam between this wait and the roster's — and
 * only a resolved one routes. Two things resolve it short of a server snapshot,
 * because a spinner nobody can get past is worse than the listeners:
 *
 *  - a cached `archived` record, which needs no confirmation at all. The flip is
 *    write-once at the rules boundary, so an Event that has been archived can
 *    never be un-archived — the archive renders immediately, offline included.
 *  - a subscription that ERRORED, or a client the browser says is OFFLINE.
 *    Neither can ever be answered by the server (`useOnline`'s `false` is the
 *    trustworthy half of that hook, and it is read here to stop waiting, never to
 *    authorize anything), and this app is offline-durable by design (ADR 0006) —
 *    so the wait ends and the Leaderboard renders from the cache, which is what
 *    it did before this gate existed — ONCE THE CACHE HAS ANSWERED (Codex P2 on
 *    PR #1165). `useOnline` reports offline on the very first render, while the
 *    Event subscription is still at `data: null` with its cache read in flight,
 *    and settling on that alone mounted the live child over no Event at all:
 *    the whole listener fan opened on a cold offline visit to an ARCHIVED Event
 *    and was torn down a snapshot later, the same defect the server wait above
 *    exists to close, reached through the escape hatch instead. So the offline
 *    arm also requires `loading` to have cleared, which is exactly "this
 *    subscription has produced its cache result, or failed".
 *  - a CACHE-SERVED snapshot the server has not contradicted within
 *    `CACHED_EVENT_SETTLE_MS` (Codex P1 on PR #1165). Neither arm above can fire
 *    behind a captive or partially routed portal, which is this app's normal
 *    network: Firestore answers from the cache with `fromCache: true` and retries
 *    forever rather than calling its terminal error callback, so `serverResolved`
 *    stays false — and `navigator.onLine` reports TRUE, so `useOnline` says
 *    nothing either. `navigator.onLine === false` cannot be the only non-error
 *    escape. The bounded wait is the real settle signal: once the subscription
 *    has answered from anywhere, the gate gives a server-committed snapshot a few
 *    seconds to arrive and then settles on the cached Event, exactly as the
 *    offline arm does. A server snapshot inside the window still WINS — it
 *    resolves the wait outright, and the timer is cancelled with it — so nothing
 *    about the answering case changes.
 *
 * A PENDING archive is the one closed state this gate declines to believe, the
 * `App.tsx` Card-redirect rule applied to the surface that redirect points AT
 * (Codex P2 on PR #1157, round 9). `status: 'archived'` written by an Admin on
 * THIS device is emitted optimistically before the rules decide it, and a refused
 * flip rolls back to open — so a record the server may never accept would
 * otherwise tear down the live listeners and print itself as final. `fromCache`
 * is deliberately NOT required alongside it: unlike the reversible `archiving`
 * the redirect guards, an accepted `archived` can never be contradicted later, so
 * demanding a fresh server snapshot would only break the offline archive read.
 *
 * THAT GUARD IS ABOUT THE TRANSITION, NOT ABOUT THE STATE (Codex P2 on PR #1165).
 * `hasPendingWrites` is a flag on the WHOLE Event snapshot rather than on the
 * field that moved, so an Admin's ban or unban after the freeze raises it over an
 * archive the server settled long ago. Read as "this archive is unconfirmed" it
 * put the page back on `LiveLeaderboard` — reopening every gameplay listener the
 * archived surface exists not to open, and printing re-derived live standings
 * over a frozen record — for as long as the moderation write stayed in flight,
 * which offline is until the client reconnects. So a CONFIRMED archive is
 * latched: the first snapshot that is `archived`, server-backed and free of local
 * writes (`!fromCache && !hasPendingWrites`) is the flip committing, and the
 * routing half stops asking after that. Monotone for the same reason the status
 * latch above is, and safe for the same one the paragraph above gives — the flip
 * is write-once at the rules boundary, so nothing can un-archive the Event
 * underneath the latch. Every snapshot before that one still meets the
 * pending-write guard in full.
 *
 * AND THE LATCH IS PERSISTED PER ARCHIVE GENERATION, so it survives a remount
 * (Codex P2 on PR #1165). An in-session latch only covers moderation that starts
 * after this mount has seen a clean server snapshot; a tab reloaded — or the
 * Leaderboard revisited — while an offline ban is still queued starts from
 * nothing, sees a cached `archived` snapshot carrying `hasPendingWrites: true`,
 * and mounted the live child over an archive committed long before that write
 * existed. `EventDoc.archivedUnder` is the generation the flip was bound to at
 * the rules boundary, so a server-committed archive records `{eventId,
 * archivedUnder}` in `localStorage` and a later cached snapshot naming the SAME
 * generation is treated as confirmed. An optimistic flip carries a generation
 * nothing ever confirmed, so it is still declined — which is precisely what a
 * bare "this Event is archived" flag could not distinguish.
 *
 * AND THE RECORD IS WRITTEN BY THE SHARED SUBSCRIPTION, NOT BY THIS COMPONENT
 * (Codex P2 on PR #1165). Persisting it from the Leaderboard's own effect left
 * it useless in the case it was built for: only a mounted Leaderboard ever wrote
 * it, and the visit that needs it is the one where some OTHER route saw the
 * commit. An Admin receives the committed archive on the console, queues an
 * offline ban there, and then opens the standings — whose first snapshot is the
 * cached archive carrying that pending write, with both latches false and
 * nothing persisted, so the gate mounted `LiveLeaderboard` after its settle
 * escape and reopened every gameplay listener until the ban synced. The
 * observation is a fact about the DEVICE, so `useEventDoc` records it from the
 * `onSnapshot` callback every route already holds (`../data/archiveConfirmation`)
 * and this component only reads it back.
 *
 * An Event marked archived with NO record is not a state this app produces —
 * `archiveEvent` writes status, stamp and record in one update — so the live view
 * is left as the fallback for a hand-edited document. It is still read-only in the
 * only place that counts: `firestore.rules` deny its gameplay writes on the
 * `status` field alone.
 */
export default function Leaderboard() {
  const { data: event, loading: eventLoading, serverResolved, fromCache, hasPendingWrites } = useEventDoc();
  const online = useOnline();
  // MONOTONE, and latched in STATE rather than in a ref — the adjust-during-
  // render idiom `Board`'s dangling-sheet close already uses, and deliberately
  // not the ref write CodeRabbit rejected on #452: React discards state updates
  // from an abandoned render, whereas a ref written during one would keep a
  // conclusion that never committed.
  //
  // The latch exists because only ONE of its two inputs is monotone. A reconnect
  // (`online` false → true, with the server snapshot still a round trip away)
  // would otherwise bounce an already-rendered live view back through the
  // spinner, unmounting `LiveLeaderboard`, dropping its listeners and resetting
  // the Player's filter with them.
  //
  // AND THE OFFLINE ESCAPE WAITS FOR THE SUBSCRIPTION TO ANSWER (Codex P2 on PR
  // #1165). `useOnline` reports false on the FIRST render of an offline cold
  // mount, while `useEventDoc` is still at `data: null` with its cache read in
  // flight — so `!online` alone settled the status over no Event at all and
  // mounted the live child, opening the roster, Day-meta and Proof listeners an
  // archived cached Event promises never to open and tearing them down one
  // snapshot later. `loading` is the half that says the subscription has
  // ANSWERED: `useDocSub` clears it on the first snapshot, cache-served
  // included, and on an error (which also resolves `serverResolved`, the other
  // arm here). So offline stops the wait once the cache has spoken, and never
  // before it.
  //
  // AND `!online` IS NOT THE ONLY NON-ERROR ESCAPE (Codex P1 on PR #1165).
  // Behind a captive or partially routed portal — the ship's ordinary Wi-Fi, and
  // this app's whole operating context — Firestore cannot reach the server while
  // the browser still reports ONLINE: the subscription serves the cached Event
  // with `fromCache: true` and keeps retrying, never invoking the terminal error
  // callback, so `serverResolved` stays false and `online` stays true and this
  // expression never settled at all. A cached ACTIVE Event's Leaderboard then
  // held its spinner indefinitely. `onSnapshot` exposes no reachability signal to
  // read instead, so the settle signal is a BOUNDED WAIT, started once the
  // subscription has answered from anywhere: `CACHED_EVENT_SETTLE_MS` after the
  // cache result the gate settles on what the cache said, which is exactly what
  // the offline arm already does one render earlier. The timer is cancelled the
  // moment the server answers, so a snapshot inside the window still wins and
  // the answering case is untouched.
  const cacheAnswered = !eventLoading && !serverResolved;
  const [cacheSettled, setCacheSettled] = useState(false);
  useEffect(() => {
    if (!cacheAnswered || cacheSettled) return;
    const timer = window.setTimeout(() => setCacheSettled(true), CACHED_EVENT_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [cacheAnswered, cacheSettled]);
  const [statusLatched, setStatusLatched] = useState(false);
  const statusSettled =
    statusLatched || serverResolved || (!eventLoading && (!online || cacheSettled));
  if (statusSettled && !statusLatched) setStatusLatched(true);

  // The archive's own latch, monotone and adjusted during render by the same
  // idiom, because the two answer different questions: that one is "may this
  // render decide anything at all", this one is "has the flip COMMITTED". A
  // server-backed `archived` snapshot carrying no local write is the commit, and
  // once it has been seen the pending-write guard below has nothing left to
  // protect — every later `hasPendingWrites` on this Event belongs to some other
  // field, a moderation ban being the one that actually happens.
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const archiveCommitted = !fromCache && !hasPendingWrites && isEventArchived(event);
  if (archiveCommitted && !archiveConfirmed) setArchiveConfirmed(true);

  // …AND THE LATCH HAS TO SURVIVE A REMOUNT (Codex P2 on PR #1165). The latch
  // above covers moderation that starts after THIS mount has already seen a
  // clean server snapshot. A tab reloaded, or the Leaderboard revisited, while an
  // offline ban or unban is still queued has no such history: the first cached
  // snapshot is `archived` with `hasPendingWrites: true`, `archiveConfirmed`
  // starts false, and the pending-write guard mounted `LiveLeaderboard` and
  // opened all three gameplay listeners — over an archive the server settled
  // long ago, and for as long as an unrelated write stays in flight, which
  // offline is until the client reconnects.
  //
  // So the confirmation is PERSISTED, per archive generation. `archivedUnder` is
  // what the flip is bound to at the rules boundary, so it names WHICH archive
  // was confirmed; a cached archived snapshot whose generation matches a record
  // this device wrote is the archive it already saw the server commit, pending
  // writes or not. An optimistic flip is still declined, because it carries a
  // generation nothing has confirmed — which is exactly what a bare "this Event
  // is archived" flag could not express. The store is read ONCE, at mount, and
  // is trusted for routing alone; every number the page prints still comes off
  // the Event document.
  //
  // AND THIS COMPONENT ONLY READS IT (Codex P2 on PR #1165). The write belongs to
  // the SHARED Event subscription — `useEventDoc` hands `useDocSub` an observer
  // that records a server-committed archive on whatever route observes it
  // (`../data/archiveConfirmation`). While the write lived here it could only
  // ever be made by a mounted Leaderboard, which is the one route the record is
  // not needed on: an Admin receives the committed archive on the console, queues
  // an offline ban THERE, and the Leaderboard's first snapshot is then a cached
  // archive with `hasPendingWrites: true` and nothing persisted behind it — both
  // latches false, and the live child mounted after the settle escape.
  const [persistedGeneration] = useState(() => confirmedArchiveGeneration(EVENT_ID));
  const archivedUnder = event?.archivedUnder;
  const generationConfirmed =
    typeof archivedUnder === 'number' && persistedGeneration === String(archivedUnder);

  if (
    (archiveConfirmed || generationConfirmed || !hasPendingWrites) &&
    isEventArchived(event) &&
    event?.archive
  ) {
    return <ArchivedLeaderboard event={event} archive={event.archive} />;
  }
  if (!statusSettled) return <LoadingState label="Tallying the leaderboard…" />;
  return <LiveLeaderboard event={event} />;
}

function LiveLeaderboard({ event }: { event: EventDoc | null | undefined }) {
  const { players, loading } = useLeaderboard();
  // #264: the pinned day-meta honors. Called HERE, with the other hooks —
  // never below the loading/empty early returns, where a later non-empty
  // render would change the hook order and crash (Codex P1 on #280).
  // The schedule's own `DayDef.index` values, not its length: every day-scoped
  // path keys on the index, so a non-contiguous schedule would otherwise have
  // the strip reading a different Day's pin from the one it labels (Codex P2 on
  // PR #1162, the #447 precedent).
  const { metas: dayMetas, loaded: dayMetasLoaded } = useDayMetasStatus(
    event?.days?.map((d) => d.index) ?? [],
  );
  const { kindsByUid } = useProofKindsByUid();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<LeaderboardFilter>('all');
  // The most recent warmed-up card render, keyed by the inputs it was built
  // from (the roster array's identity + the resolved schedule copy) so a tap
  // reuses it only while it still depicts the CURRENT standings and Day context
  // — see warmShareCard below (Codex P2, PR #111 round 2 finding 2).
  const warmedCard = useRef<{
    players: PlayerDoc[];
    shareCopyKey: string;
    bannedKey: string;
    promise: Promise<Blob | null>;
  } | null>(null);

  if (loading) return <LoadingState label="Tallying the leaderboard…" />;
  if (!players.length) return <div className="center muted">No players yet. Be the first.</div>;

  // Event-wide First to BINGO is the earliest bingo across non-tutorial Days —
  // a ceremonial, self-reported honour (ADR 0001), not a rank. Tutorial Days
  // (embark/farewell) are EXCLUDED from this headline honor (daily-cards-spec §
  // "Resolved decisions" #2): the embark card is trivially easy and live before
  // anyone boards, so it must never decide the pin before the cruise starts. The
  // exclusion is derived per-Player from `dayStats`; a roster that predates Day
  // Cards (no `dayStats`) falls back to the legacy root `firstBingoAt`, so a
  // pre-Phase-1.5 board is unchanged. Computed over the FULL, RAW roster (never
  // the filtered `visible` subset below, and never the ban-filtered roster) so
  // the pin's identity can't shift on which filter is selected OR on who is
  // banned: a ban never rewrites who was first to BINGO (specs/w2-ban-console.md
  // § Leaderboard). Only whether that Player's row is currently VISIBLE changes.
  const tutorialDays = tutorialDayIndexSet(event?.days);
  // The SAME cutoff the frozen podium and the ceremonial `first_bingo` Moment
  // gate apply, through the SAME resolver (#1050). A ceremonial Day deliberately
  // keeps recording per-Day stats after the freeze, so without this the live
  // Leaderboard could name a post-freeze winner while the card and the immutable
  // podium Moment name nobody, or someone else — two screens answering one
  // question differently.
  const freezeAt = resolvedStandingsFreezeAt(event ?? null);
  const firstBingoUid = cruiseFirstBingoUid(players, (i) => tutorialDays.has(i), freezeAt);
  // The footnote's standings caveat, derived from the resolved Scoring Policy
  // rather than naming the exception by pool (ADR 0011, Codex P2 on PR #841).
  // A closing-pool Day that states `scoring: 'competitive'` DOES count, and a
  // ceremonial Day on another pool does not — copy that says "except the
  // farewell" contradicts the actual ranking rule in both directions. An Event
  // with no ceremonial Day at all gets no caveat, because there is no exception
  // to explain.
  const ceremonialDays = ceremonialDayIndexSet(event?.days);

  // The Admin ban (#108) is PRESENTATIONAL and applied HERE, in the view only — the
  // shared `useLeaderboard` roster stays RAW so Board's First-to-BINGO ceremony reads
  // the true history (see the hook's comment). A banned Player is hidden from the
  // displayed rows and the Share Card, but the pin identity above is unaffected: if
  // the first-to-BINGO holder is banned, no visible row wins the badge (their row is
  // simply gone) — a later Player is NEVER promoted to first.
  const bannedUids = event?.bannedUids ?? [];
  const roster = players.filter((p) => !isBanned(p.uid, bannedUids));

  // #264: the PINNED day-meta honors merge with the roster-derived fallback.
  // Precedence (Codex P2s on #280): a banned Player's pin renders as "—" —
  // hidden, never promoted (the ban policy hides content; it never reassigns
  // an honor) — and the pin wins over a derived honoree on a pinned Day, so a
  // true winner whose unknown-identity bingo skipped its pin is not permanently
  // displaced by a later Player's pin. On a daily event every Day gets a chip
  // ("—" until someone bingoes that Day); a legacy event keeps the derived-only
  // strip.
  //
  // THE PIN WINS when present (#280 round 4): the write-once, rules-timestamped
  // day-meta doc is the honor's source of truth. Derived `dayStats` timestamps
  // are NOT reliable tiebreakers — a proof-backed Mark could seed a later day's
  // bucket from the cruise-wide root `firstBingoAt`, so an "earlier" derived
  // stamp may be another day's time entirely. The write paths no longer copy the
  // root (#1049, `boardFirstBingoAt`), but that ticket ships no backfill, so
  // rows persisted before it can still carry another Day's instant and this
  // pin-wins rule still stands. The derived roster is the fallback for UNPINNED
  // days only. The unknown-identity-winner residual the old earliest-wins rule
  // chased is now covered by the module-state held-pin queue (which survives
  // unmounts and fires on identity resolve); what remains — a reload before the
  // row resolves — is accepted and documented.
  //
  // The precedence itself now lives in ONE place (#1151, #1146): this strip, the
  // frozen podium and the durable archive record all resolve it through
  // `pinnedOrDerivedDailyHonors`, so the record cannot name a different holder
  // from the last live strip. It is handed the ban roster explicitly, because a
  // pin needs no Player row to render and roster absence is not a ban.
  const honorByDay = new Map(
    pinnedOrDerivedDailyHonors(roster, event?.days, dayMetas, dayMetasLoaded, bannedUids).map(
      (h) => [h.dayIndex, h],
    ),
  );
  // …AND IN DAY-INDEX ORDER, whatever order the schedule lists its Days in
  // (#1151, Codex P2 on PR #1162, round 9). This strip is the one honours
  // surface that does not render the selection itself — it renders a chip for
  // every Day the SCHEDULE names, winnerless Days included, and reads each
  // holder out of the map above — so ordering the selection could not reach it.
  // A stored schedule listing `[{index: 4}, {index: 1}]` is a legitimate one
  // (unique indexes, which `usableDayIndexes` accepts, and `DayDef.index` is
  // what names a Day), and it put D5's chip ahead of D2's while the frozen
  // record — and now the podium — said `[1, 4]`. The record's whole promise is
  // that it says what the last live strip said, so the strip has to be ordered
  // by the same key the record is.
  //
  // On a COPY, because `EventDoc.days` is the hook's own array and its order is
  // the stored schedule's, which nothing here is entitled to rewrite. Keyed on
  // `DayDef.index` rather than on the array position, which is the same question
  // every Day-scoped path in the estate asks.
  const honors = [...(event?.days ?? [])]
    .sort((a, b) => a.index - b.index)
    .map((d) => ({
      dayIndex: d.index,
      displayName: honorByDay.get(d.index)?.displayName ?? null,
    }));
  // The LEGACY strip, for an Event with no schedule at all: the same selection,
  // read out of the map above rather than derived a second time (#1151, Codex P2
  // on PR #1162, round 7). It used to call `perDayHonors` itself, which is the
  // one derivation in this file that did NOT go through
  // `pinnedOrDerivedDailyHonors` — so once that helper stopped deriving an
  // honour for a `dayStats` key outside the supported Day range, this strip would
  // have gone on rendering a `D0` or `D4001` chip the frozen record then dropped,
  // and the record's whole promise is that it says what the last live strip said.
  // On a scheduleless Event the map IS the derived list, in `perDayHonors`' own
  // Day order, so nothing else about this strip changes.
  const legacyHonors = event?.days?.length ? [] : [...honorByDay.values()];
  const dayChipLabel = (dayIndex: number): string => dayHonorChipLabel(dayIndex, event?.days);

  // Filters narrow this render's visible subset of the already-ranked,
  // ban-filtered roster — a plain `.filter`, never a `.sort`, so the relative
  // order sortPlayers produced is always preserved.
  const visible = roster.filter((p) => matchesFilter(p, filter));

  // Warm-on-intent pre-render (Codex P2, PR #111 round 2 finding 2): start
  // rasterizing when the Player signals intent to share — pointerenter
  // (mouse hover), focus (keyboard), or pointerdown (touch press) on the
  // Share button — so the tap's own `await` picks up an in-flight or
  // already-settled render and `navigator.share` runs within the browser's
  // transient user-activation window instead of expiring it mid-rasterize.
  // Deliberately NOT mount-eager like Celebration's card: this component
  // re-renders on every roster snapshot (any Player's Mark updates a player
  // row), so rasterizing per snapshot would burn phone CPU/battery for a
  // card that is rarely shared; Celebration's inputs are fixed for the
  // lifetime of a short-lived win modal, so mount-eager is cheap there. The
  // warmed promise is reused ONLY while its inputs (the roster array's
  // identity + rendered event/schedule copy) still match — a roster or schedule
  // that moved between warm-up and tap re-renders fresh at tap time so the card
  // never shows stale standings, accepting the (rare, slow-device) residual
  // activation risk on that path. `.catch(() => null)` lives inside the cached
  // promise: a render failure resolves null (shareCardBlob degrades to the
  // text/URL leg) and can never surface as an unhandled rejection from a
  // hover that was never followed by a tap.
  //
  // No Celebration-style settled-gate here (Codex P2, PR #111 round 3
  // finding 1, decided): Celebration can disable Share until its MOUNT
  // render settles because a render always exists; here no render exists
  // until intent, so disabled-until-settled would present a permanently
  // disabled button that nothing warms (and a disable between pointerdown
  // and click would swallow the very tap that warmed it). The round-2
  // stated cold/stale-tap residual therefore stands — warm-on-intent makes
  // an unsettled-at-tap await rare (hover/focus/press starts the render
  // before the click can land).
  const warmShareCard = (): Promise<Blob | null> => {
    const shareCopy = leaderboardShareCopy(event);
    // The ban roster is part of the card's inputs (#108): the warmed render is
    // reused only while the SAME banned set still applies, so a ban/unban that
    // lands between warm-up and tap re-renders fresh rather than sharing a card
    // that shows (or hides) the wrong Player.
    const bannedKey = JSON.stringify(bannedUids);
    const cached = warmedCard.current;
    if (
      cached &&
      cached.players === players &&
      cached.shareCopyKey === shareCopy.cacheKey &&
      cached.bannedKey === bannedKey
    ) {
      return cached.promise;
    }
    const promise = renderLeaderboardShareCard({
      eventName: shareCopy.eventName,
      rows: buildShareStandings(roster, firstBingoUid, MAX_SHARE_ROWS),
      contextLine: shareCopy.contextLine,
      statLine: shareCopy.statLine,
    }).catch(() => null);
    warmedCard.current = { players, shareCopyKey: shareCopy.cacheKey, bannedKey, promise };
    return promise;
  };

  // The Share Card always reflects the top standings across the full BAN-FILTERED
  // roster (buildShareStandings over `roster`), independent of whatever filter is
  // currently selected — mirrors the pin's own full-roster scope above, so
  // switching filters can never change what a shared card shows, and a banned
  // Player never appears on a shared card.
  const shareLeaderboard = async () => {
    const actedEventId = EVENT_ID;
    // Reuses the warmed render when its inputs still match, else renders
    // fresh (the cold-tap path — same behavior as before the warm-up).
    const blob = await warmShareCard();
    if (EVENT_ID !== actedEventId) return;
    try {
      await shareCardBlob({
        blob,
        filename: `${editionLexicon().fileSlug}-leaderboard.png`,
        title: `${shareCardAppName()}—Leaderboard`,
        text: `Check out the ${editionBrand().appName} leaderboard 🏆`,
        // Entry-point origin (#607, amended multi-domain policy #599), not
        // the analytics-canonical host: every serving host brands
        // dynamically, so the link must land recipients on the SAME host the
        // sharer is standing on — a rewritten link unfurls and lands under
        // another Edition's brand.
        url: shareOrigin(),
      });
    } catch {
      // shareCardBlob is designed to never throw, but a share failure must
      // never crash the Leaderboard regardless.
    } finally {
      if (EVENT_ID === actedEventId) {
        track('share_click', { surface: 'leaderboard' });
      }
    }
  };

  return (
    <>
      <div className="lb-filters" role="group" aria-label="Filter leaderboard">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={'lb-filter-btn' + (filter === f.id ? ' on' : '')}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {(honors.length > 0 || legacyHonors.length > 0) && (
        <div className="lb-honors" aria-label="Daily First to BINGO">
          <div className="lb-honors-title">Daily first to bingo</div>
          <ul className="lb-honors-strip">
            {(honors.length > 0 ? honors : legacyHonors.map((h) => ({ dayIndex: h.dayIndex, displayName: h.displayName as string | null }))).map((h) => (
              <li key={h.dayIndex} className="lb-honor">
                {/* EmojiText (#603): the chip label leads with the Day-Theme
                    emoji; in a bare text run the bug-report capture pass
                    displaces the "D1" text out of the pill. */}
                <span className="lb-honor-day">
                  <EmojiText text={dayChipLabel(h.dayIndex)} />
                </span>
                <span className="lb-honor-name">{h.displayName ?? '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {visible.length === 0 ? (
        // Compact (NOT the 70vh `.center`) so the below-list "Share leaderboard"
        // action stays reachable in an empty-filter view (Codex, #174): the share
        // card uses the full roster, so the CTA is still valid here.
        <div className="lb-empty muted">No one matches this filter yet.</div>
      ) : (
        <div className="list">
          {visible.map((p, i) => {
            const isFirst = p.uid === firstBingoUid;
            // Presentational-only (#218, union semantics #604): decorates an
            // already-ranked row, never feeds rank/filter — see `proofChips` above.
            const chips = proofChips(kindsByUid[p.uid]);
            return (
              <div key={p.uid} className={'row' + (isFirst ? ' leader' : '')}>
                <div className="rank">{i + 1}</div>
                <Avatar name={p.displayName} src={p.photoURL} />
                <div className="grow">
                  <div className="name">{p.displayName}</div>
                  <div className="sub">
                    {p.bingoCount} bingo{p.bingoCount === 1 ? '' : 's'} · {p.squaresMarked} squares
                    {p.blackout ? ' · BLACKOUT' : ''} · {when(p.firstBingoAt)}
                  </div>
                </div>
                {chips.length > 0 && (
                  <button
                    type="button"
                    className="lb-proof-chips"
                    aria-label={`${p.displayName}'s proof types—view in Feed`}
                    onClick={() => navigate('/feed')}
                  >
                    {/* One <span> per chip so `.lb-proof-chips`'s flex gap spaces
                        them evenly — a bare `join('')` renders the emoji flush
                        against each other (📷🖼️), which reads as cramped (#433). */}
                    {chips.map((chip, ci) => (
                      <span key={ci}>{chip}</span>
                    ))}
                  </button>
                )}
                {isFirst && <div className="badge">⭐ First BINGO</div>}
              </div>
            );
          })}
        </div>
      )}
      {/* The wireframes' explanatory footnote (#264), re-voiced as player copy (#298). */}
      <p className="muted lb-footnote">
        {ceremonialDays.size > 0
          ? `Every Day Card counts here—except ${ceremonialDays.size === 1 ? 'the wrap-up, which is' : 'the wrap-up Days, which are'} pure ceremony. `
          : 'Every Day Card counts here. '}
        {`⭐ marks the ${editionLexicon().occasionWide} First to BINGO${tutorialDays.size > 0 ? '—tutorial Days excluded.' : '.'} `}
        Proof chips show every kind of proof a player has used. Tap a proof chip for the receipts in
        the Feed.
      </p>
      <div className="lb-actions">
        <button
          type="button"
          className="btn"
          onClick={shareLeaderboard}
          onPointerEnter={() => void warmShareCard()}
          onFocus={() => void warmShareCard()}
          onPointerDown={() => void warmShareCard()}
        >
          Share leaderboard
        </button>
      </div>
    </>
  );
}
