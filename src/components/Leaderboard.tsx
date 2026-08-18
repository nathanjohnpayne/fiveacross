import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useEventDoc, useDayMetasStatus, useLeaderboard, useProofKindsByUid, isBanned } from '../hooks/useData';
import type { ProofKindFlags } from '../hooks/useData';
import { cruiseFirstBingoUid, perDayHonors, tutorialDayIndexSet } from '../game/logic';
import { THEMES } from '../theme/themes';
import { track } from '../analytics';
import { shareOrigin } from '../canonicalHost';
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

export default function Leaderboard() {
  const { players, loading } = useLeaderboard();
  const { data: event } = useEventDoc();
  // #264: the pinned day-meta honors. Called HERE, with the other hooks —
  // never below the loading/empty early returns, where a later non-empty
  // render would change the hook order and crash (Codex P1 on #280).
  const { metas: dayMetas, loaded: dayMetasLoaded } = useDayMetasStatus(event?.days?.length ?? 0);
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

  // Cruise-wide First to BINGO is the earliest bingo across the MAIN-GAME Days —
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
  const firstBingoUid = cruiseFirstBingoUid(players, (i) => tutorialDays.has(i));

  // The Admin ban (#108) is PRESENTATIONAL and applied HERE, in the view only — the
  // shared `useLeaderboard` roster stays RAW so Board's First-to-BINGO ceremony reads
  // the true history (see the hook's comment). A banned Player is hidden from the
  // displayed rows and the Share Card, but the pin identity above is unaffected: if
  // the first-to-BINGO holder is banned, no visible row wins the badge (their row is
  // simply gone) — a later Player is NEVER promoted to first.
  const bannedUids = event?.bannedUids ?? [];
  const roster = players.filter((p) => !isBanned(p.uid, bannedUids));

  // The per-Day First to BINGO honors strip (daily-cards-spec § "Scoring and
  // social surfaces"): each Day's OWN earliest bingo, derived from the roster's
  // `dayStats`. Every Day gets its own daily honor — tutorial Days included (their
  // exclusion is only from the cruise-wide headline pin above). Derived from the
  // ban-filtered `roster` so a banned Player's honor never displays, and only
  // renders once a Player has bingoed on some Day (empty on a pre-Day-Cards
  // roster, so the strip is absent there).
  const derivedHonors = perDayHonors(roster);
  // #264: the PINNED day-meta honors merge with the roster-derived fallback.
  // Precedence (Codex P2s on #280): a banned Player's pin renders as "—" —
  // hidden, never promoted (the ban policy hides content; it never reassigns
  // an honor) — and the EARLIEST timestamp wins between a pin and a derived
  // honoree, so a true winner whose unknown-identity bingo skipped its pin is
  // not permanently displaced by a later Player's pin. On a daily event every
  // Day gets a chip ("—" until someone bingoes that Day); a legacy event
  // keeps the derived-only strip.
  const honors = (event?.days ?? []).map((d) => {
    const pinned = dayMetas.get(d.index)?.firstBingo;
    const derived = derivedHonors.find((h) => h.dayIndex === d.index);
    // THE PIN WINS when present (#280 round 4): the write-once, rules-
    // timestamped day-meta doc is the honor's source of truth. Derived
    // dayStats timestamps are NOT reliable tiebreakers — the mark folds can
    // seed a later day's bucket from the cruise-wide root firstBingoAt, so an
    // "earlier" derived stamp may be another day's time entirely. The derived
    // roster is the fallback for UNPINNED days only. If the pinned winner is
    // banned, the chip renders blank — hidden, never reassigned. The unknown-
    // identity-winner residual the old earliest-wins rule chased is now covered
    // by the module-state held-pin queue (which survives unmounts and fires on
    // identity resolve); what remains — a reload before the row resolves — is
    // accepted and documented.
    let winner: { displayName: string } | null;
    if (pinned && isBanned(pinned.uid, bannedUids)) {
      winner = null;
    } else if (pinned) {
      winner = pinned;
    } else {
      winner = dayMetasLoaded ? (derived ?? null) : null;
    }
    return { dayIndex: d.index, displayName: winner?.displayName ?? null };
  });
  const legacyHonors = event?.days?.length ? [] : derivedHonors;
  const dayChipLabel = (dayIndex: number): string => {
    const d = event?.days?.find((day) => day.index === dayIndex);
    const emoji = d ? (THEMES.find((t) => t.id === d.theme)?.emoji ?? '') : '';
    return `${emoji ? `${emoji} ` : ''}D${dayIndex + 1}`;
  };

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
    // Reuses the warmed render when its inputs still match, else renders
    // fresh (the cold-tap path — same behavior as before the warm-up).
    const blob = await warmShareCard();
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
      track('share_click', { surface: 'leaderboard' });
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
        Every Day Card counts here—except the farewell, which is pure ceremony. ⭐ marks the
        {editionLexicon().occasionWide} First to BINGO—main days only. Proof chips show every kind of
        proof a player has used. Tap a proof chip for the receipts in the Feed.
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
