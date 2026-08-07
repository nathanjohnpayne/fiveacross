import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import { Lock, Shuffle } from 'lucide-react';
import { getDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { useBoard, useDayBoard, useDayMeta, useMyPlayer, useEventDoc, useItems, useTally, useLeaderboard, useDoubts, useMyProofs, useProofsForItemText, useDayMetasStatus, isBanned } from '../hooks/useData';
import { setMark, dealDayCard, reconcileEchoes, resolveDisplayName, RESHUFFLE_ALLOWANCE } from '../data/api';
import { saveCardSnapshot, loadCardSnapshot } from '../data/cardCache';
import { dayBoardRef } from '../data/paths';
import { raiseDoubt, openDoubts, doubtStatusFor } from '../data/doubts';
import {
  broadcastBingo,
  broadcastBlackout,
  broadcastFirstBingo,
  hasPriorBingoWitness,
  enqueueWinMoments,
  enqueueFirstBingoMoment,
  peekPendingMoments,
  pendingBlackoutDayIndexes,
  removePendingBlackoutDay,
  pendingBingoDayIndexes,
  removePendingBingoDay,
  pendingFirstBingoDayIndex,
  clearPendingMoment,
  dropPendingWins,
  enqueueRetraction,
  drainRetractions,
  pendingActionGeneration,
  firstBingoCandidateCurrent,
} from '../data/moments';
// Type-only (erased at runtime — pulls no module into suites that stub proofs):
// the proofed-mark completion verdict ProofSheet reports back (PR #110 round 2
// finding 1), same shape as setMark's return.
import type { AttachProofResult } from '../data/proofs';
import { hasBingo, isBlackout, winningCells, completedLines, countMarked, isPristine, MIN_POOL, bingoLineEdge, dayDealState, tutorialDayIndexSet, ceremonialDayIndexSet, standingsFrozen, playerRowRootLag } from '../game/logic';
import { dealDelayMs, winOrder } from '../game/motion';

// Board identities whose deal-in cascade has already played this session
// (specs/motion-polish.md; Codex P2 on #421): MODULE state, not component
// state, because the router unmounts Board on every tab switch — a set living
// in the component would forget the card and replay the deal on every return
// to the Card tab, defeating the "only a genuinely new card deals" gate.
// Session-scoped on purpose: a fresh page load deals visually again (the
// welcome-back beat), while a mere tab round-trip mounts the card landed.
// Never pruned — one short string per dealt card per session.
const dealCascadePlayed = new Set<string>();
import { useOnline } from '../hooks/useOnline';
import { track } from '../analytics';
import { setClaimSheetOpen } from '../hooks/useToastStack';
import { useOpenSquareIntent, clearOpenSquare } from '../hooks/useOpenSquare';
import Celebration from './Celebration';
import CachedCardFallback from './CachedCardFallback';
import ProofSheet from './ProofSheet';
import type { Cell, ClaimMode, DayDef, PlayerDoc, ProofDoc, TallyEntry } from '../types';
import LoadingState from './LoadingState';
import DaySwitcher, { defaultViewedIndex } from './DaySwitcher';
import TutorialBanner, { TutorialTag } from './TutorialBanner';
import { formatUnlockAt, unlockCaption } from '../unlockCopy';
import FarewellPodium from './FarewellPodium';
import { farewellPinIndex } from '../data/finale';
import { pinDayFirstBingo, enqueueHeldHonorPin, takeHeldHonorPins, dropHeldHonorPins } from '../data/dayMeta';
import CoachOverlay, { isCoachOverlayDismissed } from './CoachOverlay';
import LaunchIntro from './LaunchIntro';
import ReshuffleSheet from './ReshuffleSheet';
import { THEMES } from '../theme/themes';
import { FREE_TEXT } from '../data/seed';
// The non-free Square prompt text with the S/M/L auto-fit guard (#215) — moved
// to its own module (#434) so the read-only CachedCardFallback can reuse the
// SAME fitting guard instead of clipping long prompts. Firebase-free deps only.
import SquareText from './SquareText';

/**
 * The per-Prompt Tally count badge on a marked Square (ADR 0002). Subscribes to
 * the Prompt's marker subcollection and shows how many Players have marked it;
 * tapping opens the who-list. Rendered only on marked, non-free Squares, so a
 * freshly dealt card (only the free centre "on") surfaces no badge at all.
 */
function TallyBadge({ itemId, onOpen }: { itemId: string; onOpen: () => void }) {
  const { count } = useTally(itemId);
  if (count <= 0) return null;
  return (
    <button
      className="tally-badge"
      title="See who marked this"
      aria-label={`${count} marked—see who`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {count}
    </button>
  );
}

/**
 * The open-Doubt count on a marked Square (ADR 0001): how many "pics or it didn't
 * happen" Doubts AGAINST THIS SQUARE'S OWN MARKER (`targetUid` — Board only ever
 * renders the signed-in Player's own board, so that is always the viewer) are
 * still UNANSWERED. Scoped to `targetUid` deliberately: the shared item pool means
 * another Player commonly holds the same Prompt (ADR 0002 — "see who else got this
 * square"), and a Doubt is inherently a targeted accusation against ONE Player's
 * Mark, not ambient per-Prompt noise — an un-doubted Player must never see a badge
 * on their own Square just because someone ELSE who also marked this Prompt is
 * being doubted (verifier finding, #33). Mirrors `TallyBadge` — a per-cell
 * subscription (`useDoubts`) plus the VIEWER'S OWN active Proofs (passed down once
 * from Board — the viewer-scoped `useMyProofs`, #106 finding 4, since a Doubt
 * against the viewer is answered only by the viewer's own Proof) folded through the
 * PURE `openDoubts` derivation — but sits top-LEFT, clear of the
 * ✓ (top-right), the proof ＋ (bottom-left), and the Tally count (bottom-right).
 * Renders ONLY when at least one Doubt against `targetUid` is open. Tapping opens
 * the same who-list sheet, where a Doubt is actually raised against another
 * Player's entry — a Doubt never blocks or unmarks the Square, so this is a
 * pressure signal, never a gate.
 */
function DoubtBadge({
  itemId,
  itemText,
  targetUid,
  proofs,
  onOpen,
}: {
  itemId: string;
  itemText: string;
  targetUid: string;
  proofs: readonly Pick<ProofDoc, 'uid' | 'itemText' | 'createdAt'>[];
  onOpen: () => void;
}) {
  // `targetUid` here is the signed-in viewer (Board only ever renders the viewer's
  // OWN board, so every Square's `targetUid` is `uid`). Passing it as the viewerUid
  // keeps the ban own-content exception (#122 round 2): a banned viewer still sees —
  // and can answer — a Doubt raised against THEMSELVES on their own board, even
  // though `useDoubts` hides Doubts against a banned target for every OTHER viewer.
  const { doubts } = useDoubts(itemId, targetUid);
  const mine = doubts.filter((d) => d.targetUid === targetUid);
  const open = openDoubts(mine, itemText, proofs);
  if (open.length <= 0) return null;
  return (
    <button
      className="doubt-badge"
      title="pics or it didn't happen"
      aria-label={`${open.length} open doubt${open.length === 1 ? '' : 's'}—pics or it didn't happen`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <span aria-hidden="true">👀</span> {open.length}
    </button>
  );
}

/**
 * The tap-to-see-who list for a Prompt's Tally (ADR 0002): names EVERY Player who
 * marked the Prompt — no anonymity — chronologically. Reuses the proof-capture
 * sheet chrome. Markers carry no photo (the marker doc is just uid + displayName +
 * markedAt), so the avatar is the name's initial.
 *
 * It is also where a Doubt is RAISED (ADR 0001, #33): each OTHER Player's row
 * carries a "pics or it didn't happen" affordance that raises a Doubt against
 * their Mark of this Prompt; the header summarizes the open-Doubt total across the
 * markers listed below (deliberately UN-scoped per target, unlike the per-target
 * Square badge — this sheet already lists everyone by name, so an aggregate here is
 * a heat summary, not a personal accusation). A row whose Doubt(s) have been
 * answered by a Proof renders a distinct SATISFIED state, an open one a distinct
 * DOUBTED state — social pressure applied then visibly cooled. A Doubt never
 * blocks, unmarks, or discounts the Mark (never a gate), so nothing here changes
 * the Board; the doubter's own row offers no affordance (no self-doubt).
 *
 * Review-hardening details (Codex P2, PR #106 rounds 1–2):
 *  - Dormant-when-unmarked (finding 2): the open-Doubt header counts ONLY Doubts
 *    whose target is a CURRENT marker. A Doubt doc is never deleted when its target
 *    unmarks (no cross-writer cleanup); instead it goes dormant and reappears in
 *    the count if they re-mark — the accusation targets a standing Mark.
 *  - No double-raise (finding 1): the raise button disables SYNCHRONOUSLY on the
 *    first tap (a per-target in-flight ref, so a rapid second tap in the same tick
 *    is inert), cleared when the write settles; the echoed Doubt keeps it "Doubted"
 *    meanwhile, and `raiseDoubt` is passed the open set so a duplicate that slips
 *    through post-echo is also skipped at the data layer.
 *  - Item-scoped proofs (finding 4): satisfaction for the markers listed here reads
 *    the active Proofs for THIS Prompt only (`useProofsForItemText`, mounted with
 *    the sheet), not a Board-wide proof stream.
 *  - Once-only per target (round 2 finding 2): a marker this Player has ALREADY
 *    doubted — open OR satisfied — keeps the affordance disabled ("Doubted"): the
 *    deterministic doubt slot makes a re-raise in place structurally denied, so
 *    the button never offers a write the rules would reject. A fresh demand after
 *    a satisfying Proof is a retract-then-re-raise flow (the doubter's delete is
 *    already allowed by the rules), deliberately not surfaced here.
 *  - Identity-gated accusation (round 2 finding 3): the raise affordance is
 *    DISABLED until the viewer's saved identity is KNOWN (the same `identityKnown`
 *    tri-state setMark and the Moment broadcasts gate on) — a Doubt stores the
 *    accuser's name PERMANENTLY, so waiting beats stamping 'Anonymous'; the
 *    data layer's cached-row fallback (raiseDoubt) is the defense-in-depth.
 */
function TallySheet({
  itemId,
  itemText,
  cellIndex,
  meUid,
  meName,
  identityKnown,
  isSourceLive,
  onClose,
}: {
  itemId: string;
  itemText: string;
  cellIndex: number;
  meUid: string;
  meName: string | undefined;
  identityKnown: boolean;
  // Board's write-time source revalidation (Codex P2, PR #106 round 6): true only
  // while the CURRENT account's board still holds (cellIndex, itemId) as a marked,
  // non-free Square. This sheet's own props are exactly what goes stale when the
  // account switches (or the source unmarks in another tab) under an open sheet,
  // so the raise consults Board's latest knowledge instead of trusting them.
  isSourceLive: (cellIndex: number, itemId: string) => boolean;
  onClose: () => void;
}) {
  const { markers, loading } = useTally(itemId);
  // `meUid` is the signed-in viewer — pass it so the ban own-content exception holds
  // in the sheet too (#122 round 2): a banned viewer still sees Doubts against
  // themselves, while Doubts against a banned OTHER marker stay hidden.
  const { doubts } = useDoubts(itemId, meUid);
  // The active Proofs for THIS Prompt (finding 4) — joined by itemText, the same
  // (uid, itemText) key the derivation uses (ProofDoc carries no itemId). Mounted
  // only while this sheet is, so no Board-wide proof listener is opened.
  const { proofs } = useProofsForItemText(itemText);
  // Only Doubts against a CURRENT marker count in the header (finding 2): a Doubt
  // against a Player who has since unmarked is dormant (its target left the list),
  // reappearing if they re-mark. Doubt docs are never deleted here (no cross-writer
  // cleanup). The per-row status below is inherently scoped — a row IS a current
  // marker — so this one filter covers the only aggregate.
  const markedUids = new Set(markers.map((m) => m.uid));
  const open = openDoubts(doubts, itemText, proofs).filter((d) => markedUids.has(d.targetUid));
  const openCount = open.length;
  // Per-target in-flight guard (finding 1): held in a ref so a rapid double-tap in
  // ONE tick reads the mutation the first tap made (a render-closure boolean would
  // not update until the next render, so both taps would fire). The bump reducer
  // re-renders so the disabled affordance shows immediately; the guard clears when
  // the raise settles — meanwhile the echoed Doubt flips `iAlreadyDoubted` true and
  // keeps the button "Doubted", and a failed write both settles here and rolls the
  // echo back, re-enabling the row.
  const inFlight = useRef<Set<string>>(new Set());
  const [, bumpInFlight] = useReducer((n: number) => n + 1, 0);
  const doDoubt = (m: TallyEntry) => {
    // Write-time source revalidation (Codex P2, PR #106 round 6), SYNCHRONOUS with
    // the write decision — a Doubt is a permanent once-only slot, so a stale
    // source must be caught at the moment of the raise, not by an effect that can
    // race the tap by a commit. Board's render-time close (the tallySourceLive
    // adjust) normally unmounts this sheet first; this is the belt-and-braces
    // write layer for the tap that lands in the race window. Dead source → close
    // the sheet, write nothing, count nothing.
    if (!isSourceLive(cellIndex, itemId)) {
      onClose();
      return;
    }
    if (inFlight.current.has(m.uid)) return;
    inFlight.current.add(m.uid);
    bumpInFlight();
    const clear = () => {
      inFlight.current.delete(m.uid);
      bumpInFlight();
    };
    // `.then(clear, clear)` clears on either settle path; raiseDoubt already logs
    // and swallows an online rejection, so this never sees an unhandled rejection.
    void raiseDoubt({
      fromUid: meUid,
      fromDisplayName: meName,
      targetUid: m.uid,
      targetDisplayName: m.displayName,
      itemId,
      cellIndex,
      currentlyOpen: open,
    }).then(clear, clear);
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">Who got “{itemText}”</div>
        {/* The wireframes' subtitle (#263): "5 players · 3 open doubts 👀 on
            this square" — the player count always, the doubt half only when
            any are open. */}
        {markers.length > 0 && (
          <p className="doubt-summary">
            {markers.length} player{markers.length === 1 ? '' : 's'}
            {openCount > 0 && (
              <>
                {' '}· {openCount} open doubt{openCount === 1 ? '' : 's'} <span aria-hidden="true">👀</span> on this square
              </>
            )}
          </p>
        )}
        {loading && markers.length === 0 ? (
          <p className="muted tally-empty">Loading…</p>
        ) : markers.length === 0 ? (
          <p className="muted tally-empty">No one has marked this yet.</p>
        ) : (
          <div className="list">
            {markers.map((m) => {
              const status = doubtStatusFor(m.uid, doubts, itemText, proofs);
              const isMe = m.uid === meUid;
              // ANY Doubt of mine against this marker — open OR satisfied —
              // disables the affordance (round 2 finding 2): the deterministic
              // slot is once-only, so a re-raise in place would only be denied.
              const iAlreadyDoubted = doubts.some(
                (d) => d.targetUid === m.uid && d.fromUid === meUid,
              );
              const isPending = inFlight.current.has(m.uid);
              // The satisfying Proof's media chip (#263 — the wireframes'
              // inline thumb on an Answered row): the LATEST active Proof this
              // marker attached for this Prompt, mapped to its capture-type
              // glyph. No chip when the type is unknown (legacy docs).
              const answeredProof =
                status === 'satisfied'
                  ? [...proofs].filter((pr) => pr.uid === m.uid).sort((a, b) => b.createdAt - a.createdAt)[0]
                  : undefined;
              const proofChip =
                answeredProof?.type === 'photo'
                  ? answeredProof.source === 'library'
                    ? '🖼️'
                    : '📷'
                  : answeredProof?.type === 'audio'
                    ? '🎙'
                    : answeredProof?.type === 'text'
                      ? '✍️'
                      : null;
              const rowHasState = status === 'open' || status === 'satisfied';
              return (
                <div className="row wholist-row" key={m.uid}>
                  <div className="avatar">{(m.displayName.trim()[0] ?? '?').toUpperCase()}</div>
                  <div className="grow">
                    <div className="name">{m.displayName}</div>
                  </div>
                  {/* Right-aligned state (#263, the wireframes' who-list rows):
                      open → "👀 Doubted · waiting…"; answered → the proof's
                      media chip + "✓ Answered". Class names unchanged (they
                      are the pinned open/satisfied distinction). */}
                  {status === 'open' && (
                    <span className="wholist-state doubt-open">👀 Doubted · waiting…</span>
                  )}
                  {status === 'satisfied' && (
                    <>
                      {proofChip && (
                        <span className="wholist-thumb" aria-hidden="true">
                          {proofChip}
                        </span>
                      )}
                      <span className="wholist-state doubt-satisfied">✓ Answered</span>
                    </>
                  )}
                  {isMe && <span className="pill you-pill">you</span>}
                  {/* The raise affordance suppresses only for the VIEWER's own
                      involvement — self rows and rows they already doubted
                      (their deterministic slot is spent; the state above says
                      so). Someone ELSE's open/satisfied Doubt never blocks an
                      additional doubter: the slot is per (doubter, target,
                      Prompt), so Alice's raise stays valid on a row Bob
                      doubted (Codex P2 on #276). */}
                  {!isMe && !iAlreadyDoubted && (
                    <button
                      className="btn doubt-btn"
                      title="pics or it didn't happen"
                      // !identityKnown: never let a public, permanent accusation
                      // publish while the accuser's saved name is still unknown
                      // (round 2 finding 3) — the gate opens when the row loads.
                      disabled={isPending || !identityKnown}
                      onClick={() => doDoubt(m)}
                    >
                      {/* Compact label on a row already carrying a state so the
                          320px sheet row never overflows (Codex P2 on #276);
                          the full wireframe phrase stays on stateless rows. */}
                      {isPending ? 'Doubting…' : rowHasState ? '🤨 Doubt too' : '🤨 Pics or it didn’t happen'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="muted wholist-note">
          A doubt never blocks or unmarks—it&apos;s social pressure with a scoreboard.
        </p>
        <div className="sheet-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The caller's first-bingo state for a Mark is KNOWN only when the player row
 * genuinely resolved. While the subscription is still loading, OR when a
 * cache-only snapshot settled as "absent" without server confirmation (an
 * offline reload can cache the board but not the player row, and Firestore
 * reports an uncached doc as non-existent), the prior value is UNKNOWN —
 * `undefined` — so setMark omits the preserve-vs-stamp write instead of
 * treating a phantom `null` as a real "no first bingo yet" and re-stamping
 * over the server's earlier value (Codex P2, PR #75 rounds 2 + 4). A CACHED
 * row is real knowledge either way; a loaded `null` is a known none.
 * Exported for the unit test in `src/data/w1-board-mark-win.test.ts`.
 */
export function knownFirstBingoAt(
  player: { firstBingoAt?: number | null } | null,
  loading: boolean,
  serverConfirmed: boolean,
): number | null | undefined {
  if (loading || (player === null && !serverConfirmed)) return undefined;
  return player?.firstBingoAt ?? null;
}

export function shareCardBingoNumber(params: {
  cells: Cell[];
  rootBingoCount: number;
  dayBingoCount: number | undefined;
  hasDays: boolean;
  statsFrozen: boolean;
}): number {
  const currentBoardLines = completedLines(params.cells).length;
  if (!params.hasDays) return Math.max(params.rootBingoCount, currentBoardLines);
  if (params.statsFrozen) return currentBoardLines;
  return Math.max(params.dayBingoCount ?? 0, currentBoardLines);
}

/** Title-cases a hyphenated ThemeId ('welcome-aboard' -> 'Welcome Aboard') —
 * the fallback label/description source for a Day whose Theme has no
 * `ThemeMeta` entry yet (the two Phase 1.5 tutorial themes land theirs in
 * #206, which this ticket does not depend on). */
function titleCaseThemeId(themeId: string): string {
  return themeId
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function themeLabel(themeId: string): string {
  return THEMES.find((t) => t.id === themeId)?.label ?? titleCaseThemeId(themeId);
}

function themeDescription(themeId: string): string {
  return THEMES.find((t) => t.id === themeId)?.description ?? '';
}

/**
 * The viewed Day's board header (#260 — the wireframes' daybar, rendered on
 * BOTH the dealt Board and the locked preview so the two can't drift):
 * "Day N · Theme label" plus the tutorial tag on the left, the port on the
 * right, and the Theme's dress-code description underneath. The root keeps
 * the `.board-header` class — the pre-#260 tutorial-tag mount point — so
 * that contract (and the e2e selector on it) survives the daybar absorbing
 * it; #212's daily-honor pin will extend the meta slot on main Days.
 */
export function DayBar({
  day,
  honor,
  timezone,
  reshuffle,
}: {
  day: DayDef;
  // The Day's pinned First to BINGO (#264) — when present on a NON-tutorial
  // Day, the meta slot swaps the port for the wireframes' honor line
  // ("First to BINGO: Theo, 11:02"). Tutorial Days keep their tag in place of
  // daily-honor competitiveness (spec § "Embark (tutorial) view").
  honor?: { displayName: string; at: number } | null;
  timezone?: string;
  // The Reshuffle chip (#378, wireframes #frame-reshuffle): remaining cruise-wide
  // count + the tap that opens the confirm sheet. OPTIONAL by design — DayBar is
  // shared with `LockedDayPreview`, whose bare call site therefore stays
  // chip-free by construction rather than by a condition someone could later
  // get wrong. The caller owns the eligibility gate; this renders what it is
  // handed. `left` is only ever passed as 1..3 (a spent-out Player gets no
  // chip at all, not a "×0" one — see the wireframes' ×3 → ×0 range note).
  reshuffle?: { left: number; onOpen: () => void } | null;
}) {
  const description = themeDescription(day.theme);
  // The "Tonight:" line (schedule correction 2026-07-17): the Day's two
  // signature events, rendered on both the dealt board and the locked preview.
  // Guarded with `?? []` because DayBar is also handed cast fixtures and legacy
  // Event docs seeded before `tonight` existed — a missing field renders no
  // line rather than throwing on `.join`.
  const tonight = (Array.isArray(day.tonight) ? day.tonight : []).filter(Boolean);
  const showHonor = honor != null && validHonorTime(honor.at) && !day.tutorial;
  return (
    <div className="board-header daybar-block">
      <div className="daybar">
        <div className="daybar-name">
          Day {day.index + 1} · {themeLabel(day.theme)}
          {day.tutorial && <TutorialTag pool={day.pool} className="daybar-tag" />}
        </div>
        <div className="daybar-meta">
          {showHonor ? (
            <>First to BINGO: {honor.displayName}, {honorTime(honor.at, timezone)}</>
          ) : (
            <>
              <span aria-hidden="true">{day.placeEmoji}</span> {day.place}
            </>
          )}
        </div>
        {reshuffle && (
          <button
            type="button"
            className="reshuf"
            onClick={reshuffle.onOpen}
            aria-label={`Reshuffle this card—${reshuffle.left} of ${RESHUFFLE_ALLOWANCE} reshuffles left`}
          >
            <Shuffle aria-hidden="true" className="reshuf-icon" />
            <span aria-hidden="true">×{reshuffle.left}</span>
          </button>
        )}
      </div>
      {description && <p className="daybar-desc">{description}</p>}
      {tonight.length > 0 && (
        <p className="daybar-tonight">
          <span className="daybar-tonight-label">Tonight:</span>{' '}
          {tonight.join(' · ')}
        </p>
      )}
    </div>
  );
}

/** "11:02" — the honor line's compact event-timezone clock (wireframes' update-
 * banner frame shows no meridiem; hour12 kept off for the same reason). */
function honorTime(at: number, timezone: string | undefined): string {
  const date = new Date(at);
  if (!validHonorTime(at)) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone || 'UTC',
    }).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    } catch {
      return '—';
    }
  }
}

function validHonorTime(at: number): boolean {
  return Number.isFinite(at) && Number.isFinite(new Date(at).getTime());
}

function firstCompletedLineAt(cells: Cell[]): number | null {
  let firstAt: number | null = null;
  for (const line of completedLines(cells)) {
    let lineAt = 0;
    for (const index of line) {
      const markedAt = cells[index]?.markedAt;
      if (typeof markedAt === 'number' && markedAt > lineAt) lineAt = markedAt;
    }
    if (lineAt > 0 && (firstAt == null || lineAt < firstAt)) firstAt = lineAt;
  }
  return firstAt;
}

/**
 * The locked-Day preview (daily-cards-spec § "Locked Day preview"): full
 * themed chrome for the viewed Day over a 5x5 grid of blank Squares — only
 * the free space (index 12, the same center the live deal uses) is
 * populated, with that Day's `freeText` override if it carries one. No
 * click handler is wired to any Square here, so a tap is a structural
 * no-op — there is nothing to call `setMark` with.
 */
function LockedDayPreview({
  day,
  timezone,
  waking = false,
}: {
  day: DayDef;
  timezone: string | undefined;
  // `waking` (daily-cards-spec § "Client fallback"): the Day's `unlockAt` has
  // passed but the scheduler hasn't stamped its snapshot yet, so the card can't be
  // dealt from a frozen pool. Same themed chrome; the badge/caption say "waking up"
  // instead of "unlocks at" (the date is in the past, so the unlock copy misreads).
  waking?: boolean;
}) {
  const freeText = day.freeText ?? FREE_TEXT;
  return (
    <div className="board-area day-locked" data-theme={day.theme}>
      <DayBar day={day} />
      <div className="bingo-head" aria-hidden="true">
        {['B', 'I', 'N', 'G', 'O'].map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      <div className="grid locked-grid">
        {Array.from({ length: 25 }, (_, index) => (
          <div
            key={index}
            className={'cell locked-cell' + (index === 12 ? ' free marked' : '')}
          >
            {index === 12 && (
              <>
                <span className="free-label" aria-hidden="true">
                  FREE
                </span>
                <span className="free-prompt">{freeText}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="day-lock-badge">
        <span className="day-lock-icon-circle" aria-hidden="true">
          <Lock className="day-lock-icon" />
        </span>
        <span className="day-lock-text">
          {waking ? 'Waking up—dealing today’s squares' : `Unlocks ${formatUnlockAt(day.unlockAt, timezone)}`}
        </span>
      </div>
      <p className="day-lock-caption muted">
        {waking
          ? 'Today’s card is being dealt. Give it a moment, then come back.'
          : unlockCaption(day.unlockAt, timezone)}
      </p>
    </div>
  );
}

export default function Board() {
  const { user, retryDeal, dealing } = useAuth();
  const uid = user?.uid;
  // The single legacy Board (pre-1.5 events with no `days[]` schedule). In daily-
  // cards mode the rendered Board is the DAY-SCOPED one below; this stays the
  // source only for legacy events (#246).
  const {
    data: legacyBoard,
    loading: legacyBoardLoading,
    hasServerData: legacyBoardConfirmed,
    fromCache: legacyBoardFromCache,
    hasPendingWrites: legacyBoardPending,
  } = useBoard(uid);
  const { data: player, loading: playerLoading, hasServerData: playerConfirmed } = useMyPlayer(uid);
  // ONE resolution of the caller's public display name, fed to BOTH the per-Prompt
  // Tally marker (setMark, below) AND the new-Proof attribution (ProofSheet), so a
  // Mark and a Proof always publish the SAME identity the leaderboard shows — never
  // two divergent name sources (ADR 0002). It runs the saved player-row identity —
  // the denormalized name the profile editor keeps current (data/profile.ts writes
  // users/{uid} + the player row, #76/#78) — through `resolveDisplayName`, the same
  // validated resolver joinAndDeal uses (trim, ≤100-char cap, else the live auth value).
  const displayName = resolveDisplayName(player, user?.displayName);
  // ...but that saved identity is KNOWN only under the same tri-state as
  // knownFirstBingoAt above: while the subscription is still loading, or when a
  // cache-only snapshot settled "absent" without server confirmation, the row is
  // UNKNOWN — and `displayName` above has silently fallen back to the AUTH name.
  // Stamping that onto a Tally marker would publish a returning Player's stale
  // Google name over their customized one for any Mark tapped in the loading
  // window (Codex P2, PR #87). So doMark passes `displayName` only when the row
  // is known, and `undefined` otherwise — markerDisplayName then falls back to
  // the CACHED player row (the saved name), then 'Anonymous', deliberately never
  // the possibly-stale auth value. A loaded-null row IS known (a real "no saved
  // row"), so the auth fallback is then legitimate. ProofSheet keeps the resolved
  // string either way: its sheet only opens after a render with the row loaded in
  // practice, and #78 pins auth as its explicit pre-load fallback.
  const identityKnown = !playerLoading && (player !== null || playerConfirmed);
  const { data: event } = useEventDoc();
  // The Day schedule (daily-cards-spec § "Data model"): `[]` on a not-yet-migrated
  // (legacy) Event or while the doc loads, which keeps the entire day-scoped path
  // below inert and Board's single-Board rendering byte-identical to pre-1.5.
  const days: DayDef[] = event?.days ?? [];
  const hasDays = days.length > 0;
  const { metas: dayMetas, loaded: dayMetasLoaded } = useDayMetasStatus(hasDays ? days.length : 0);
  // The Day switcher's viewed-Day index (daily-cards-spec § "Day switcher"). Held
  // up here (before the day-scoped Board subscription that keys on it) so switching
  // a chip re-subscribes to that Day's own Board. Defaults to 0 and is adopted to
  // today's Day the first render `days` is non-empty (guarded once — see the
  // adjust-during-render block below), independent of the app-wide Theme.
  const [viewedIndex, setViewedIndex] = useState(0);
  const viewedIndexInitialized = useRef(false);
  // The VIEWED Day's own Board (#246): in daily mode this — not the legacy single
  // Board — is what renders, so every Day shows its OWN 24 squares and marks fold
  // into that Day's bucket. `undefined` dayIndex opens no subscription (legacy
  // events), so `useDayBoard` is inert there.
  const {
    data: dayBoard,
    loading: dayBoardLoading,
    hasServerData: dayBoardConfirmed,
    fromCache: dayBoardFromCache,
    hasPendingWrites: dayBoardPending,
  } = useDayBoard(uid, hasDays ? viewedIndex : undefined);
  // The VIEWED Day's pinned First to BINGO honor (#264) — one doc sub, keyed on
  // the viewed index; legacy events (no schedule) open no subscription.
  const { data: viewedDayMeta } = useDayMeta(hasDays ? viewedIndex : undefined);
  // The ACTIVE Board the whole component renders/marks against: the viewed Day's
  // Board in daily mode, the single legacy Board otherwise. In daily mode the
  // day-scoped subscription clears its previous doc only in a passive effect AFTER
  // its key changes (useDocSub), so for a render or two right after a Day switch
  // `dayBoard` can still be the PRIOR Day's board. Accepting it would briefly
  // render — and accept Mark taps against — the wrong Day's card. Gate on
  // `dayBoard.dayIndex === viewedIndex` so a stale board reads as "not yet dealt"
  // (the "Dealing…" transient) until the correct Day's board loads (Codex #247 P2).
  const dayBoardForView = hasDays && dayBoard?.dayIndex === viewedIndex ? dayBoard : null;
  const board = hasDays ? dayBoardForView : legacyBoard;
  const boardLoading = hasDays ? dayBoardLoading : legacyBoardLoading;
  const boardConfirmed = hasDays ? dayBoardConfirmed : legacyBoardConfirmed;
  // Is THIS snapshot the server's own view of the card — acked, not merely
  // optimistic? `boardConfirmed` is a LATCH ("the server has spoken at least once")
  // and cannot answer that. The #377 retraction drain is the one consumer, because
  // it is the one IRREVERSIBLE thing this component does: see the drain in the
  // cells effect. In daily mode the stale-Day guard above can null `board` while
  // `dayBoard` still holds the prior Day's doc, so the flags are read from the
  // subscription that actually feeds the rendered board.
  const boardServerCommitted = hasDays
    ? !dayBoardFromCache && !dayBoardPending
    : !legacyBoardFromCache && !legacyBoardPending;
  // The known-players roster — the SAME data the Leaderboard's First-to-BINGO pin
  // reads (useLeaderboard) — used to derive whether THIS Player is first to BINGO
  // when broadcasting the ceremonial Moment (ADR 0001). Read into a ref below so
  // the edge effect stays keyed on `[cells]`. `rosterConfirmed` is the roster's
  // server-confirmed latch (useColSub's `hasServerData`): an initial EMPTY `players`
  // from a still-loading (or cache-only) subscription is NOT proof nobody has
  // bingoed, so the First-to-BINGO claim is HELD until the roster is server-backed
  // (Codex P2, PR #99 finding 2) rather than guessed from an unloaded roster.
  const { players, hasServerData: rosterConfirmed } = useLeaderboard();
  // Codex P3 (PR #66): the pool only matters before a Board is dealt, so once
  // a Board exists this Player has no use for a live listener on every other
  // Player's prompt add/report. Gate the subscription to the no-board state.
  const { items, loading: poolLoading, hasServerData: poolConfirmed } = useItems(!board);
  // The VIEWER'S OWN active Proofs (Codex P2, PR #106 finding 4): the ONLY Proofs a
  // viewer-scoped DoubtBadge needs to tell whether a Doubt AGAINST THE VIEWER is
  // answered. A `where('uid','==',uid)` + `where('status','==','active')` query
  // (both equality — no composite index), subscribed ONCE here and threaded to
  // every Square's badge — replacing the Board-wide `useProofFeed` that pulled
  // every active Proof from every Player into every Card mount. The Tally sheet's
  // per-marker status needs OTHER Players' Proofs too, so it subscribes its own
  // item-scoped query WHILE OPEN (useProofsForItemText) rather than a global
  // stream. Satisfaction stays a pure derivation (src/data/doubts.ts); this read
  // never gates a Mark (ADR 0001) and does not touch the Moments machinery below.
  const { proofs: myProofs } = useMyProofs(uid);
  const claimMode: ClaimMode = event?.claimMode ?? 'honor';

  const [celebrate, setCelebrate] = useState<null | 'bingo' | 'blackout'>(null);
  const [freePulse, setFreePulse] = useState(0);
  // Squares wearing the one-shot mark-stamp animation (specs/motion-polish.md).
  // Populated by the rising-mark edge detector further down (it needs
  // `cellsAttributable`, derived below); cleared per cell on animationend and
  // wholesale on a board-identity change (the edgeStateKey adjust block).
  const [stamped, setStamped] = useState<ReadonlySet<number>>(() => new Set());
  const [proofTarget, setProofTarget] = useState<Cell | null>(null);
  const [tallyTarget, setTallyTarget] = useState<Cell | null>(null);
  // The Reshuffle confirm sheet (#378). Parent-owned open flag, like the sheets
  // above; the eligibility gate that decides whether the chip exists at all is
  // `reshuffleEligible` further down.
  const [reshuffleOpen, setReshuffleOpen] = useState(false);
  // Reshuffle is the one write that must not queue offline (see `reshuffleBoard`),
  // so it is the one control that has to know about connectivity.
  const online = useOnline();
  // Whether the coach overlay is already behind us, so the launch announcement
  // can queue behind it (see the LaunchIntro mount). Seeded from the stored flag
  // at mount and flipped by CoachOverlay's own dismiss — a plain render-time read
  // would never re-render Board when that key is written.
  const [coachSeen, setCoachSeen] = useState(isCoachOverlayDismissed);
  // A Feed Tally Card's pending "open this Prompt's sheet" request (#261),
  // consumed by the intent effect below once the right Day's board renders.
  const openSquareIntent = useOpenSquareIntent();

  // The open Claim sheet's social heat line (#211): reuse the SAME per-Prompt
  // Tally subscription the TallyBadge uses — no new read — for the Square the
  // sheet is open on. useTally accepts a null id (no proofTarget → no sub).
  const { count: proofTargetTally } = useTally(proofTarget?.itemId ?? null);
  // Reports ProofSheet's open state to UpdatePrompt (#219, useToastStack) —
  // UpdatePrompt mounts outside the auth-gated tree with no other view into
  // this state, and defers its reload offer while a proof is mid-capture.
  useEffect(() => {
    setClaimSheetOpen(!!proofTarget);
    return () => setClaimSheetOpen(false);
  }, [proofTarget]);
  // The locked/unlocked read below (`viewedLocked`) is only re-evaluated on a
  // render — with no OTHER state change due while idling on a locked Day, a
  // player who leaves the Card tab open across an `unlockAt` rollover (e.g.
  // the 8:00 ship-time unlock) would stay stuck on `LockedDayPreview` until
  // a reload or unrelated interaction (Codex P2, PR #230). `now` stands in
  // for `Date.now()` everywhere a lock check reads the clock, and this timer
  // bumps it exactly when the EARLIEST still-locked Day's `unlockAt` in the
  // whole schedule passes — not just the viewed Day, so switching to an
  // already-elapsed chip never needs its own reschedule. Depends on
  // `event?.days` (not the `days` local below, which is a fresh `[]`
  // literal on every render while unmigrated) so it doesn't re-schedule on
  // every unrelated render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const schedule = event?.days ?? [];
    const nextUnlock = schedule
      .map((d) => d.unlockAt)
      .filter((t) => t > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextUnlock == null) return;
    const timer = setTimeout(() => setNow(Date.now()), nextUnlock - Date.now());
    return () => clearTimeout(timer);
  }, [event?.days, now]);
  // Lazy per-Day dealing (#246, daily-cards-spec § "Unlock mechanics"): on opening
  // an UNLOCKED Day whose snapshot is stamped (`dayDealState === 'ready'`) that has
  // no Day Card for this Player yet, deal it from that Day's frozen snapshot
  // (`dealDayCard` draws from `snapshotItemIds`, excludes cross-cruise repeats, and
  // applies the stratified/tutorial deal). A Day that is `locked` (future),
  // `waking` (unlocked-by-clock but snapshot not yet stamped — scheduler lag), or
  // already `dealt` deals NOTHING here. `dealDayCard` re-checks all of this
  // server-side and no-ops on an existing card, so the in-flight ref only avoids
  // firing the same deal twice while one is in flight; gating on `dayBoardConfirmed`
  // keeps a cache-miss (board unknown) from dealing a second card over an existing
  // one. Fire-and-forget: the day-scoped subscription renders the card once written.
  const dealingDaysRef = useRef<Set<string>>(new Set());
  // The Day index whose lazy deal has FAILED (thin/malformed snapshot, or a
  // repeatedly-denied write), so the render can surface a retry instead of sitting
  // on "Dealing…" forever (Codex #247 P2). `dealNonce` bumps on a manual retry so
  // the deal effect re-fires even though nothing else in its deps changed.
  const [dayDealError, setDayDealError] = useState<number | null>(null);
  const [dealNonce, setDealNonce] = useState(0);
  useEffect(() => {
    if (!hasDays || !user) return;
    const day = days[viewedIndex] ?? days[0];
    // A dealt board for the viewed Day clears any prior deal error for it.
    if (board) {
      if (dayDealError !== null) setDayDealError(null);
      return;
    }
    if (!day || !dayBoardConfirmed) return;
    const state = dayDealState({
      unlockAt: day.unlockAt,
      snapshotItemIds: day.snapshotItemIds,
      now,
      hasBoard: false,
    });
    if (state !== 'ready') return;
    const key = `${user.uid}:${day.index}`;
    if (dealingDaysRef.current.has(key)) return;
    dealingDaysRef.current.add(key);
    const dealIndex = day.index;
    void dealDayCard(user, dealIndex)
      .catch(() => {
        // A denied/failed deal leaves the board null; surface a retry for the
        // viewed Day rather than an indefinite "Dealing…" spinner. Scoped to the
        // acted Day so switching away/among Days never shows a stale error.
        setDayDealError(dealIndex);
      })
      .finally(() => dealingDaysRef.current.delete(key));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `days`/`day` derive from event?.days; deps track the fields the deal actually reads.
  }, [hasDays, user, event?.days, viewedIndex, board, dayBoardConfirmed, now, dealNonce]);
  // Open-time echo reconcile (specs/echo-marks.md, #446): once per board
  // identity per session, bring the opened Day Card up to date against the
  // Player's achieved set — the lazy backfill that self-heals pre-feature
  // boards and mops up echo writes dropped offline. Gated on an ATTRIBUTABLE,
  // server-confirmed board and a settled player row (identityKnown), so the
  // cache reads inside `reconcileEchoes` see real state, and keyed by board
  // identity (uid + Day + seed) so a reshuffle re-reconciles its replacement
  // card. Fire-and-forget: the batch's latency-compensated write re-renders
  // the board, and any echo win it enqueued drains through the standard
  // cells-effect drain — nothing posts directly from here.
  const reconciledBoardsRef = useRef<Set<string>>(new Set());
  // #492: the board VISIT whose last reconcile pass came back INCOMPLETE (or
  // failed). `board` is a NEW object on every snapshot, so deleting the
  // once-per-board key alone made every subsequent snapshot re-run the whole
  // reconcile — N+2 cache reads through the markChains chain each time, plus
  // the repair-pin's repeated create-denials — while the board sat on an
  // incomplete cache. The contract is "a later OPEN retries" (spec §
  // Open-time), so an incomplete attempt BLOCKS re-runs for as long as the
  // player keeps looking at that same board, and stops blocking when the
  // visit ends: the retry happens once per visit, when the cache plausibly
  // gained siblings, not once per snapshot. Scoped to key AND generation
  // (#500): a pin from an ENDED visit is inert, so returning to the same
  // card after ANY departure — including through a state with no
  // attributable board at all — is a fresh open that retries.
  const incompleteReconcileVisitRef = useRef<{ key: string; generation: number } | null>(null);
  // The CURRENT board visit — identity key plus a generation that bumps every
  // time the viewed identity changes, INCLUDING to "no attributable board"
  // (#500: a locked/loading Day or account-switch interlude ends the visit —
  // the early returns below record it — so a same-card return is a later
  // OPEN, not a continuation). An async reconcile continuation may pin the
  // visit block above only when BOTH still match its originating visit
  // (Codex P2 x2 on #498): a slow incomplete completion landing after the
  // player navigated away must not re-block its board (key mismatch), and one
  // landing after the player LEFT AND RETURNED belongs to the previous visit
  // (generation mismatch) — pinning then would swallow the return visit's
  // retry until yet another navigation.
  const reconcileVisitRef = useRef<{ key: string | null; generation: number }>({
    key: null,
    generation: 0,
  });
  // Keys with a reconcile pass launched and not yet settled. Distinguishes
  // "in flight" from "settled complete" inside `reconciledBoardsRef` so the
  // #506 row-lag re-arm below never launches a second concurrent pass over
  // one already running (which will evaluate the same row itself).
  const reconcileInFlightRef = useRef<Set<string>>(new Set());
  // #499/#501: the explicit retry trigger. Completion handlers mutate refs,
  // and ref mutations schedule NO effect re-run — so when a STALE pass's
  // incomplete completion re-arms the guard for the board the player is
  // CURRENTLY viewing (its own fresh attempt was skipped by the in-flight
  // guard), bumping this nonce is what actually re-runs the effect for the
  // live visit instead of leaving the spec's "a later OPEN retries" promise
  // waiting on an unrelated snapshot. Bumped ONLY in that
  // key-matches-but-generation-differs case, and the retried pass carries the
  // CURRENT generation — its own incomplete completion pins the per-visit
  // block instead of bumping again — so the trigger cannot loop.
  const [reconcileRetryNonce, setReconcileRetryNonce] = useState(0);
  // #506: the row-lag EPISODE — scoped to the signed-in uid (Codex P2 round
  // 2 on #507: a component-global latch let one account's episode swallow
  // another's after a switch), latched `active` on the transition into row
  // inconsistency and reset when the row reads consistent again, so an
  // inconsistent row that a failed heal leaves standing cannot re-trigger a
  // pass per snapshot (the per-visit incomplete block owns that retry).
  const reconcileRowLagEpisodeRef = useRef<{ uid: string; active: boolean } | null>(null);
  // Whether the active episode still OWES its one heal pass. The heal is
  // ROW-scoped, not board-scoped — every board's pass evaluates the same
  // row predicate — so the debt follows the player to whatever board is
  // currently OPEN (Codex P2 round 2 on #507: re-arming only the key that
  // detected the lag left a navigated-to, already-settled board unhealed).
  // Cleared exactly when a pass LAUNCHES with the lag in view (that pass
  // reads the row), or when the row reads consistent again.
  const reconcileRowLagOwedRef = useRef(false);
  // The board key whose IN-FLIGHT pass's settle owes a retry-nonce bump
  // (Codex P2 round 1 on #507): a lag observed while a pass is already
  // running must not re-arm immediately (that would double the pass), but
  // that pass may have captured the previously CONSISTENT row and settle
  // `complete: true` without ever seeing the lag — with no further snapshot
  // guaranteed to re-run the effect. The settle consumes this and bumps the
  // nonce; the re-armed run then serves the still-owed heal on whatever
  // board is open at that moment.
  const reconcileRowLagRearmKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const schedule = event?.days ?? [];
    // #506/#508: the once-per-board guard is retained for the session, but
    // the session can outlive the row's consistency — another device's
    // acted-day batch can understate the roots AFTER a board settled its
    // complete pass, and with the row absent from the old deps the heal
    // predicate was never re-evaluated until a reload. The row is already
    // subscribed (`player` is in the deps), so track the row-lag EPISODE —
    // latched `active` on the transition into inconsistency, reset when the
    // row reads consistent again — and re-arm the guard for the OPEN board
    // while the episode still owes its one heal pass.
    //
    // The BOOKKEEPING half (uid scoping, the consistent-row reset, the
    // new-episode latch) runs on every pass whose ROW signal is attributable
    // — user signed in, schedule known, row subscription settled
    // (identityKnown), and the subscribed row either loaded-null or
    // belonging to the signed-in account — INDEPENDENT of whether an
    // attributable board is on screen (#508, the #507 round-3 P2): a row
    // that flips lagged→consistent→lagged entirely inside a locked/loading-
    // Day interlude previously hit the early return below unobserved, so the
    // latch still read `active` with no owed heal and the returning board
    // never re-armed, contrary to the once-per-episode re-arm contract. The
    // effect still runs during such interludes (`player` is in the deps), so
    // observing the transitions here is sufficient; only the SERVE half
    // (in-flight defer / guard drop) needs the attributable board and stays
    // below the guard.
    //
    // The row signal is consumed only when the subscribed row actually
    // BELONGS to the signed-in account (Phase 4b P1 on #507): during an
    // account switch the new user's board can turn valid before
    // `useMyPlayer`'s keyed effect clears the PREVIOUS account's row, and a
    // stale lagged row from the old account must not latch — and thereby
    // consume — the new account's episode, suppressing the real heal when
    // its own row arrives. A mismatched (or not-yet-settled) row is not a
    // row signal at all: every episode ref is left untouched until an
    // attributable snapshot re-runs this effect.
    const rowSignalAttributable =
      hasDays &&
      !!user &&
      identityKnown &&
      schedule.length > 0 &&
      (player === null || player.uid === user.uid);
    if (rowSignalAttributable) {
      const rowLag =
        !standingsFrozen(event) &&
        playerRowRootLag(
          player,
          (i: number) => ceremonialDayIndexSet(schedule).has(i),
          (i: number) => tutorialDayIndexSet(schedule).has(i),
        );
      if (reconcileRowLagEpisodeRef.current?.uid !== user.uid) {
        // Account switch: episode state is per-uid; the previous account's
        // latch (or debt) must never gate — or leak into — this one's.
        reconcileRowLagEpisodeRef.current = { uid: user.uid, active: false };
        reconcileRowLagOwedRef.current = false;
        reconcileRowLagRearmKeyRef.current = null;
      }
      if (!rowLag) {
        reconcileRowLagEpisodeRef.current.active = false;
        reconcileRowLagOwedRef.current = false;
        reconcileRowLagRearmKeyRef.current = null;
      } else if (!reconcileRowLagEpisodeRef.current.active) {
        reconcileRowLagEpisodeRef.current.active = true;
        reconcileRowLagOwedRef.current = true;
      }
    }
    if (
      !hasDays ||
      !user ||
      !board ||
      board.uid !== user.uid ||
      !identityKnown ||
      !dayBoardConfirmed ||
      schedule.length === 0
    ) {
      // #500: no attributable board on screen ENDS the current visit (the
      // generation is bumped by the next valid open), so an incomplete block
      // pinned before a locked/loading-Day or account-switch interlude can
      // never strand the old card past its visit.
      reconcileVisitRef.current = { key: null, generation: reconcileVisitRef.current.generation };
      return;
    }
    const key = `${user.uid}:${board.dayIndex}:${board.seed}`;
    if (reconcileVisitRef.current.key !== key) {
      reconcileVisitRef.current = { key, generation: reconcileVisitRef.current.generation + 1 };
      // Any pin belongs to an ended visit now — inert by generation, dropped
      // for hygiene.
      incompleteReconcileVisitRef.current = null;
    }
    const visitGeneration = reconcileVisitRef.current.generation;
    // The SERVE half of the episode (#506): the owed heal is ROW-scoped and
    // follows the player to whatever board is OPEN, not the board that first
    // detected the lag. While a pass is IN FLIGHT the re-arm is deferred,
    // not dropped — the running pass may have captured the previously
    // consistent row, so its settle owes the nonce bump that brings the debt
    // back to this effect (Codex P2 x2 on #507). An episode whose lag was
    // latched during a no-board interlude serves here on the first
    // attributable open, exactly like one latched with a board on screen
    // (#508); a consistent-row pass above has already cleared the debt, so
    // `owed` here always co-occurs with a still-lagged attributable row.
    if (rowSignalAttributable && reconcileRowLagOwedRef.current) {
      if (reconcileInFlightRef.current.has(key)) {
        reconcileRowLagRearmKeyRef.current = key;
      } else {
        // Serve the episode's heal here: drop this key's guard (and any
        // pin) so the pass below launches and evaluates the lagged row.
        reconcileRowLagRearmKeyRef.current = null;
        reconcileRowLagOwedRef.current = false;
        reconciledBoardsRef.current.delete(key);
        if (incompleteReconcileVisitRef.current?.key === key) {
          incompleteReconcileVisitRef.current = null;
        }
      }
    }
    if (reconciledBoardsRef.current.has(key)) return;
    const pin = incompleteReconcileVisitRef.current;
    if (pin !== null && pin.key === key && pin.generation === visitGeneration) {
      return; // same visit — no per-snapshot churn
    }
    reconciledBoardsRef.current.add(key);
    reconcileInFlightRef.current.add(key);
    // An INCOMPLETE pass (a sibling board this device has never cached — its
    // cache read rejected, so the achieved set may be missing the source
    // Mark; or a #491 stats-lag heal that failed) must not settle the
    // once-per-board guard: drop the key so a later open retries with more
    // of the cache populated (Codex P2 on #447). Then, by where the player
    // is looking NOW:
    //   • still this visit → pin the per-visit block so the retry is
    //     per-open, not per-snapshot (#492);
    //   • same card, LATER visit (they left and came back while this pass
    //     hung; the in-flight guard skipped the return visit's own attempt)
    //     → the current open's promised retry has no snapshot to ride, so
    //     bump the retry nonce to schedule it explicitly (#499/#501);
    //   • different card → nothing; the old card's next open retries.
    const settle = (complete: boolean) => {
      reconcileInFlightRef.current.delete(key);
      if (reconcileRowLagRearmKeyRef.current === key) {
        // A row lag surfaced DURING this pass, and this pass may have raced
        // past its own predicate on the previously consistent row — the
        // episode's heal is still OWED (`reconcileRowLagOwedRef` stays true),
        // so bump the nonce and let the re-armed effect run serve it on
        // whatever board is open by then. An incomplete pass still drops its
        // own key (standard later-open retry); a complete one keeps it — the
        // nonce run re-arms the CURRENT key itself. The debt clears exactly
        // when a pass launches with the lag in view, so no loop.
        reconcileRowLagRearmKeyRef.current = null;
        if (!complete) reconciledBoardsRef.current.delete(key);
        setReconcileRetryNonce((n) => n + 1);
        return;
      }
      if (complete) return;
      reconciledBoardsRef.current.delete(key);
      if (reconcileVisitRef.current.key !== key) return;
      if (reconcileVisitRef.current.generation === visitGeneration) {
        incompleteReconcileVisitRef.current = { key, generation: visitGeneration };
      } else {
        setReconcileRetryNonce((n) => n + 1);
      }
    };
    void reconcileEchoes({
      uid: user.uid,
      dayIndex: board.dayIndex,
      dayIndexes: schedule.map((d) => d.index),
      tutorialDayIndexes: [...tutorialDayIndexSet(schedule)],
      ceremonialDayIndexes: [...ceremonialDayIndexSet(schedule)],
      statsFrozen: standingsFrozen(event),
    })
      .then((res) => settle(Boolean(res.complete)))
      // A synchronous failure (nothing written) may retry on the next open.
      .catch(() => settle(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `schedule` derives from event?.days; deps track what the reconcile reads, plus the explicit retry nonce.
  }, [hasDays, user, board, identityKnown, dayBoardConfirmed, event?.days, player, reconcileRetryNonce]);
  // Edge refs for the COSMETIC Celebration UI only (issue #104). The public Moment
  // broadcast moved OFF this snapshot-diffing machinery and ONTO the action path —
  // doMark reads `setMark`'s synchronous win-transition verdict and enqueues into a
  // MODULE-scope pending queue that survives Board unmounts (src/data/moments.ts) —
  // so these refs no longer drive any Feed write. They serve one purpose now: fire
  // the local celebrate animation on the transition into a bingo/blackout, without
  // re-celebrating a win that ALREADY stood on first paint (a returning Player).
  // `initialized` holds that "baseline the first snapshot, detect edges after" rule;
  // the account-switch reset below re-establishes it per uid.
  // #176: the bingo edge tracks the COUNT of completed lines (not a boolean), so
  // a 2nd/3rd bingo line re-fires the animation. wasBlackout stays boolean.
  const wasBingoLines = useRef(0);
  const wasBlackout = useRef(false);
  const initialized = useRef(false);

  // Account switch: the celebration edge state is per-uid, and the reset must run
  // BEFORE any effect of the uid-switch render — an effect-based reset raced the
  // still-stale subscription rows (useBoard/useMyPlayer return the PREVIOUS uid's
  // data for the render(s) before their keyed effects clear it), which could seed
  // the new account's celebration baseline from the OLD board. React's
  // adjust-during-render pattern: on a uid mismatch, restore the uninitialized
  // baseline synchronously (idempotent per uid, StrictMode-safe), and the
  // attribution gate below keeps the stale board out of this same render's effect.
  // The pending Moment queue needs NO reset here — it is module state keyed BY uid
  // (src/data/moments.ts), so a held win for the previous account can never drain
  // under the new one.
  // Keyed on the account AND (in daily mode) the VIEWED Day (#246): each Day has
  // its OWN Board, so switching Days is a board-identity change just like an
  // account switch — re-baseline the celebration edges so a Day that already holds
  // a standing bingo/blackout on first view never spuriously re-animates the win.
  const edgeStateKey = hasDays ? `${uid ?? 'none'}:${viewedIndex}` : (uid ?? 'none');
  const edgeStateUid = useRef(edgeStateKey);
  if (edgeStateUid.current !== edgeStateKey) {
    edgeStateUid.current = edgeStateKey;
    initialized.current = false;
    wasBingoLines.current = 0;
    wasBlackout.current = false;
    // The stamp set is board-scoped too (specs/motion-polish.md): a stamp
    // whose animationend never fired (Day switched mid-punch) must not
    // replay on another board's same-index Square. Same adjust-during-render
    // idiom as the sheet closes below; guarded, so it can't loop.
    if (stamped.size > 0) setStamped(new Set());
  }

  const cells: Cell[] = board?.cells ?? [];
  // Attribution gate (round 2 finding B): board data is usable for edge state only
  // when the doc actually belongs to the CURRENT uid. During an account switch the
  // subscription still returns the previous uid's board for a render, and the
  // render-time reset above cannot stop this render's cells effect from seeding it
  // — this gate does. BoardDoc carries its owner's uid, so the check is direct.
  const cellsAttributable = board != null && board.uid === uid;

  // A Tally sheet's SOURCE Square is live only while the CURRENT account's board
  // still holds that cell marked, non-free, and carrying the SAME Prompt (Codex
  // P2, PR #106 round 6 — the #110 attribution-guard class applied to the Doubt
  // write path). `cellsAttributable` folds the account-identity half: another
  // uid's board validates nothing.
  const tallySourceLive = (target: Cell): boolean => {
    if (!cellsAttributable) return false;
    const cell = cells.find((c) => c.index === target.index);
    return cell != null && !cell.free && cell.marked && cell.itemId === target.itemId;
  };
  // Close a DANGLING sheet the moment its source dies — the account switched under
  // it, or the source Square unmarked in another tab — using the same
  // adjust-during-render pattern as the per-uid reset above (an effect could race
  // a tap by one commit; this runs before anything renders). Clearing the STATE
  // (not just gating the render) also stops a later re-mark from resurrecting a
  // sheet the Player already saw close. Idempotent: the very next render sees
  // tallyTarget null.
  if (tallyTarget && !tallySourceLive(tallyTarget)) setTallyTarget(null);

  // ProofSheet's SOURCE Square is live only while the CURRENT account's board
  // still holds the SAME Prompt at that cell in the SAME marked state the sheet
  // opened against (Codex P2, PR #184 — the tallySourceLive class applied to the
  // proof/pledge surface). An account switch can land the NEW uid's board under
  // an OPEN sheet: `cellsAttributable` alone then passes, and a pledge would
  // mark the captured index on the WRONG card. The marked-state check also
  // closes a claim sheet whose Square another tab claimed meanwhile (its pledge
  // has nothing left to claim) and a proof-add sheet whose Mark fell. Note the
  // sheet's own attachProof success races its board echo here: the echo flips
  // the cell to marked and this close can fire just before submit's onClose —
  // both paths null the same state, so the double-close is idempotent.
  const proofSourceLive = (target: Cell): boolean => {
    if (!cellsAttributable) return false;
    const cell = cells.find((c) => c.index === target.index);
    return cell != null && !cell.free && cell.itemId === target.itemId && cell.marked === target.marked;
  };
  if (proofTarget && !proofSourceLive(proofTarget)) setProofTarget(null);

  // Durable card snapshot (#434): persist the card the Player is looking at to
  // localStorage so a later transient deal failure (offline / flaky ship wifi)
  // renders THIS saved card instead of the full-screen reload screen — App reads
  // it back via `loadCardSnapshot` and swaps in `CachedCardFallback`. Only an
  // ATTRIBUTABLE, dealt board is snapshotted (`cellsAttributable` folds the
  // account-identity guard, so a mid-account-switch board never overwrites the
  // new account's snapshot), and the effect is keyed on the `board` doc so it
  // fires once per real card update rather than on every unrelated re-render.
  // The Day header is a tiny presentational subset — deriving it inline (not
  // from the later `viewedDay`) keeps this effect ahead of the render's early
  // returns. Fire-and-forget; `saveCardSnapshot` swallows any store failure.
  useEffect(() => {
    if (!uid || !cellsAttributable || !board || cells.length === 0) return;
    const vd = hasDays ? (days[viewedIndex] ?? days[0]) : undefined;
    saveCardSnapshot({
      uid,
      dayIndex: hasDays ? (board.dayIndex ?? null) : null,
      cells,
      bingoCount: player?.bingoCount ?? 0,
      day: vd
        ? {
            number: vd.index + 1,
            place: vd.place,
            placeEmoji: vd.placeEmoji,
            theme: vd.theme,
            label: themeLabel(vd.theme),
          }
        : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `days`/`vd` derive from event?.days (a fresh [] each render); the deps track the PRIMITIVE fields actually snapshotted, incl. the viewed Day's presentational meta so a live schedule correction (port/emoji/theme) re-writes the snapshot even when the board + stats are unchanged (Codex P3, #438).
  }, [
    uid,
    cellsAttributable,
    board,
    cells,
    hasDays,
    viewedIndex,
    player?.bingoCount,
    days[viewedIndex]?.place,
    days[viewedIndex]?.placeEmoji,
    days[viewedIndex]?.theme,
  ]);

  // The latest identity + roster + gate signals + CURRENT attributable cells for
  // Moment broadcasts, stored in a ref so `drainMoments` (a stable callback)
  // always reads the CURRENT actor, gate state, and board, never a stale render's
  // closure. Written every render. photoURL mirrors ProofSheet: a loaded player
  // row's null photo wins over the stale auth photo. The name is the SAME resolved
  // public identity the Tally + Proof carry; moments.ts bounds it to the rules'
  // ≤100 contract. `cells` (attribution-gated: another uid's board contributes
  // NOTHING) is back here for the drain's FIRE-TIME REVALIDATION (Codex P2, PR
  // #110 finding 3, restoring the PR #99 round-3 invariant on the queue path): a
  // held win can fall without any local unmark verdict — another tab unmarks, a
  // rules rollback lands as a passive snapshot — so a drain must never publish
  // without re-checking the win against the board as it stands at fire time.
  const feedCtx = useRef<{
    uid: string | undefined;
    displayName: string;
    photoURL: string | null;
    players: PlayerDoc[];
    identityKnown: boolean;
    rosterConfirmed: boolean;
    cells: Cell[];
    // The rendered board's OWN Day (daily mode), undefined on a legacy event —
    // the per-card blackout drain (#267, Codex P2 on #275) adjudicates only the
    // queued Day that IS this board, never sibling Days it cannot see.
    boardDayIndex: number | undefined;
  }>({
    uid: undefined,
    displayName: 'Anonymous',
    photoURL: null,
    players: [],
    identityKnown: false,
    rosterConfirmed: false,
    cells: [],
    boardDayIndex: undefined,
  });
  feedCtx.current = {
    uid,
    displayName,
    // `?? null` guards the undefined case, not just null: `dealDayCard` can create
    // the player row with ONLY a `dayStats` bucket (the join-vs-deal race,
    // api.ts:291), so a LOADED `player` can still lack the `photoURL` field
    // entirely (undefined, despite PlayerDoc typing it `string | null`). Passing
    // that undefined into a Moment `setDoc` throws "Unsupported field value:
    // undefined" and silently loses the whole BINGO/Blackout/First-to-BINGO
    // broadcast. Coalescing to null keeps the "loaded row's null photo wins over
    // the stale auth photo" intent while never handing undefined to Firestore.
    photoURL: (player ? player.photoURL : user?.photoURL) ?? null,
    players,
    identityKnown,
    rosterConfirmed,
    cells: cellsAttributable ? cells : [],
    boardDayIndex: hasDays && cellsAttributable ? board?.dayIndex : undefined,
  };

  // Write-time twin of `tallySourceLive` for the Doubt raise (Codex P2, PR #106
  // round 6): TallySheet calls this SYNCHRONOUSLY with the raise decision, so the
  // check reads the LATEST rendered board through feedCtx (already
  // attribution-gated — a foreign board contributes NO cells) rather than the
  // sheet's own captured props, which are exactly what goes stale when the account
  // switches or the source Square unmarks under an open sheet. A Doubt is a
  // PERMANENT once-only slot, so the wrong-source write must be stopped at the
  // moment of the write — the render-time close above is the UI layer, this is
  // the write layer (the same belt-and-braces split as toggle + doMark, #110
  // finding 2). Stable ([] deps): reads only the ref.
  const isDoubtSourceLive = useCallback((index: number, itemId: string): boolean => {
    const cell = feedCtx.current.cells.find((c) => c.index === index);
    return cell != null && !cell.free && cell.marked && cell.itemId === itemId;
  }, []);

  // Drain the module-scope pending queue (src/data/moments.ts): fire every held
  // Moment whose gate is now open, reading the LATEST actor + gates from feedCtx
  // (never a stale closure). Called after a mark enqueues (doMark, below) and
  // whenever a gate OPENS (identity resolves / the roster becomes server-confirmed).
  // Two gates:
  //   • Identity (all three, PR #99 finding 1): HOLD until a KNOWN saved identity,
  //     so a returning Player's stale auth/Google name is never stamped into an
  //     IMMUTABLE Moment (the same window setMark passes `undefined`). Because the
  //     queue is MODULE state, a held win survives a Board unmount / route change
  //     and drains on the next mount — the issue #104 fix. (Only a full page reload
  //     can still drop it; documented residual.)
  //   • Roster (first_bingo only, PR #99 finding 2): claim the ceremonial event
  //     singleton only against a SERVER-CONFIRMED roster showing no OTHER Player
  //     with an earlier bingo; while unconfirmed the candidate stays HELD (not
  //     cleared). The per-Player bingo/blackout do NOT wait on the roster.
  // FIRE-TIME REVALIDATION (Codex P2, PR #110 finding 3 — the PR #99 round-3
  // invariant, restored on the queue path): a held win can fall with NO local
  // unmark verdict — another tab unmarks it, or a rules rollback lands as a
  // passive snapshot — so the drain must never publish without re-checking the
  // win against the freshest board it has. `cellsOverride` lets the completing
  // action pass its own folded `res.cells` (doMark) — the authoritative
  // post-action state, since the render-current snapshot has usually not echoed
  // yet at that point; gate-open and snapshot drains use the render-current
  // attributable cells instead. hasBingo/isBlackout are recomputed, and a
  // NON-EMPTY attributable board is required before ANY publish: isBlackout([])
  // is vacuously TRUE ([].every(Boolean)), so the empty-board guard (PR #99
  // round 3 finding B) is load-bearing again on this path.
  //
  // On revalidation FAILURE the drain HOLDS (it does not clear): a drop here
  // would race the latency-compensation echo — a gate can open in the window
  // between the mark and its snapshot, when the rendered cells are still
  // pre-action — and re-lose held wins, the exact #104 bug class. The CLEARS for
  // fallen wins belong to the observers of the fall: doMark's unmark verdict and
  // the cells effect's passive falling edge (both via dropPendingWins, which also
  // bumps the action generation). A flag whose fall this tab never observes can
  // therefore idle un-fireable (revalidation keeps blocking it) until reload —
  // safe: nothing publishes for it.
  const drainMoments = useCallback((cellsOverride?: Cell[], dayOverride?: number) => {
    const {
      uid: cUid,
      displayName: cName,
      photoURL: cPhoto,
      players: roster,
      identityKnown: idKnown,
      rosterConfirmed: rosterOk,
      cells: cellsRendered,
      boardDayIndex,
    } = feedCtx.current;
    if (!cUid || !idKnown) return; // identity gate: hold every kind
    const pending = peekPendingMoments(cUid);
    if (!pending.bingo && !pending.blackout && !pending.firstBingo) return;
    const cellsNow = cellsOverride ?? cellsRendered;
    if (cellsNow.length === 0) return; // no attributable board → hold; never adjudicate vacuously
    const bingoNow = hasBingo(cellsNow);
    const blackoutNow = isBlackout(cellsNow);
    const actor = { uid: cUid, displayName: cName, photoURL: cPhoto };
    // #262/#372: the plain bingo's queued Day(s) — a SET since bingo became
    // per-card (the ceremonial first_bingo carries its OWN `firstBingoDayIndex`
    // stamp — see below).
    const bingoDays = pendingBingoDayIndexes(cUid);
    // The witnessed Day must MATCH the witnessed cells (Codex P2, #275 round 4):
    // an action/proof continuation passes the ACTED board's cells, and the
    // Player may have switched the rendered Day while that await was in flight —
    // so an override's Day rides WITH the override, and the rendered-board day
    // is trusted only for the no-override (snapshot) drains where the two are
    // the same board by construction.
    const witnessDay = cellsOverride !== undefined ? dayOverride : boardDayIndex;
    // Per-card adjudication (#372) — now identical in shape to the blackout arm
    // below, where it was already required by #267. A day-stamped queued bingo
    // adjudicates ONLY against ITS OWN Day's board (Codex P2 on #286):
    // `bingoNow` witnesses exactly ONE board — the rendered/acted one — and a
    // bingo held behind the identity/roster gates can be queued on Day 1, then
    // drained while Day 2 renders with its own standing bingo. Without the
    // match, that pass would publish a Day-1-stamped Moment off Day 2's witness.
    // A queued Day that is not the witnessed one HOLDS (it never clears): it
    // fires when its own board next renders standing, and a fall on that board
    // drops just it via dropPendingWins. An empty queue is the legacy day-less
    // broadcast (one card the whole Event — the rendered board IS the card).
    if (pending.bingo && bingoNow) {
      if (bingoDays.length === 0) {
        broadcastBingo(actor);
        clearPendingMoment(cUid, 'bingo');
      } else if (witnessDay !== undefined && bingoDays.includes(witnessDay)) {
        broadcastBingo(actor, witnessDay);
        removePendingBingoDay(cUid, witnessDay);
      }
    }
    if (pending.blackout && blackoutNow) {
      // Per-card adjudication (#267; Codex P2 on #275): `blackoutNow` witnesses
      // exactly ONE board — the rendered one — so only the queued Day that IS
      // that board may drain against it. A sibling queued Day (its blackout
      // completed while identity was unknown, then the Player switched Days)
      // stays queued until ITS board is rendered blacked-out again; a Day that
      // meanwhile FELL is dropped by that later pass's own `blackoutNow`/
      // dropPendingWins, never published off another Day's witness. The Day is
      // the one captured at ENQUEUE time (Codex finding 2,
      // fix/d15-blackout-day-naming), not re-derived at fire time. An empty
      // queue is the legacy day-less broadcast (one card the whole Event —
      // the rendered board IS the card).
      // `witnessDay` (above) rides the override for the same reason it does on
      // the bingo path.
      const blackoutDays = pendingBlackoutDayIndexes(cUid);
      if (blackoutDays.length === 0) {
        broadcastBlackout(actor);
        clearPendingMoment(cUid, 'blackout');
      } else if (witnessDay !== undefined && blackoutDays.includes(witnessDay)) {
        broadcastBlackout(actor, witnessDay);
        removePendingBlackoutDay(cUid, witnessDay);
      }
    }
    // Ceremonial decision — fully SYNCHRONOUS at publish time (PR #110 round 3
    // findings A + B). Round 2 re-read the witness here, which was WRONG: a
    // roster-held original win fires its plain bingo in an EARLIER drain pass, so
    // by the time the roster opens, the re-read sees this pipeline's own
    // `${uid}-bingo` Moment in the local cache and suppresses the very ceremony
    // that win legitimately raised (finding A). The prior-win question belongs to
    // BIRTH time (the enqueue gauntlet in broadcastWinVerdict) — the only moment
    // "is this a regain?" is answerable without self-interference; observed
    // falls/unmarks kill candidates via the generation stamp besides. And with no
    // async read between the roster decision and the write, a competing
    // firstBingoAt delivered mid-decision can no longer slip past (finding B):
    // `roster` here is feedCtx.current as of THIS synchronous drain, re-read on
    // every attempt — gate-open, snapshot, and action drains alike.
    // The ceremony's Day is the CANDIDATE's own stamp — decoupled from the
    // plain bingo's (Codex P3 on #286 round 2) — with the same witnessed-board
    // match as the other kinds.
    const firstBingoDay = pendingFirstBingoDayIndex(cUid);
    const firstBingoDayWitnessed = firstBingoDay === undefined || witnessDay === firstBingoDay;
    if (pending.firstBingo && bingoNow && firstBingoDayWitnessed && rosterOk) {
      if (!firstBingoCandidateCurrent(cUid)) {
        // Stale candidate (round 2 finding 3a): an observed BINGO fall bumped
        // the generation since this candidate was enqueued — the win context it
        // described no longer holds. KILLED, never fired.
        clearPendingMoment(cUid, 'firstBingo');
      } else {
        // Ceremonial + self-reported (ADR 0001): claim First-to-BINGO only when,
        // as far as this client's CONFIRMED known-players view shows AT PUBLISH
        // TIME, no OTHER Player has bingoed yet — and only while the underlying
        // bingo still STANDS. The race (two clients briefly both believing they
        // are first) resolves to one Moment per Event via the singleton doc id.
        // CONSUME-ON-DECISION: fired and decided-and-lost both clear here, in the
        // same synchronous block as the decision — no async gap can strand a
        // consumed-but-unpublished candidate, and HOLD paths (identity, roster,
        // board, standing-ness) never consume.
        const othersBingoed = roster.some((p) => p.uid !== cUid && p.firstBingoAt != null);
        if (!othersBingoed) {
          if (firstBingoDay === undefined) broadcastFirstBingo(actor);
          else broadcastFirstBingo(actor, firstBingoDay);
        }
        clearPendingMoment(cUid, 'firstBingo');
      }
    }
  }, []);

  // When a gate OPENS — identity resolves, or the roster becomes server-confirmed —
  // drain any Moment held while it was closed (PR #99 findings 1 + 2). The queue
  // itself holds the state across unmounts; this effect just re-attempts the drain.
  useEffect(() => {
    drainMoments();
  }, [identityKnown, rosterConfirmed, drainMoments]);

  // Snapshot effect: the cosmetic Celebration edges (no public writes), PLUS two
  // queue-maintenance duties the PASSIVE stream owns (Codex P2, PR #110 finding 3):
  //   1. Falling-edge clears — a listener snapshot showing a previously-standing
  //      win now GONE (bingo/blackout true→false) means the win fell without any
  //      local unmark verdict (another tab unmarked it, or a rules rollback rolled
  //      the optimistic mark back). The corresponding queued flag is dropped via
  //      dropPendingWins (which also bumps the action generation), so the queue
  //      tracks reality even when no local action observes the fall.
  //   2. Drain attempts — a queued win whose gate is already open still needs a
  //      board to revalidate against; the snapshot that delivers it (a fresh
  //      mount's first board, the latency-compensation echo) triggers the drain.
  useEffect(() => {
    // Attribution gate (round 2 finding B): during an account switch this effect
    // can run one render with the PREVIOUS uid's board still in the subscription;
    // ignore a board that is not the current account's so it neither seeds the
    // celebration baseline, drops/drains queue flags, nor animates.
    if (!cellsAttributable || !cells.length) return;
    // #176: track the COUNT of completed lines, not a boolean, so completing a
    // 2nd/3rd bingo line re-fires the animation (a boolean flips false→true only
    // once). `bingoEdge` is the rising edge vs the previous snapshot's count.
    const { lines: bingoLines, gained: bingoEdge } = bingoLineEdge(cells, wasBingoLines.current);
    const black = isBlackout(cells);
    // Passive falling edges (duty 1) — compared against the PREVIOUS snapshot's
    // state before the refs re-seed below. On a mount's first snapshot the refs
    // are 0/false, so nothing can spuriously read as a fall.
    if (uid) {
      if (wasBingoLines.current > 0 && bingoLines === 0) {
        // The fall is witnessed by THIS board — drop only its Day's queued
        // bingo (#372, the twin of the blackout day-scoping below); legacy
        // (no schedule) keeps the full clear.
        const fell = { bingo: true, bingoDayIndex: hasDays ? board?.dayIndex : undefined };
        dropPendingWins(uid, fell);
        // Cross-source fall (another tab/device unmarked, a rules rollback
        // landed): record the published-side intent too, so Feed truth does not
        // depend on which tab observed the fall. Writes nothing — the drain
        // below adjudicates it against the server.
        enqueueRetraction(uid, fell);
        if (hasDays && board?.dayIndex !== undefined) dropHeldHonorPins(uid, board.dayIndex);
      }
      if (wasBlackout.current && !black) {
        // The fall is witnessed by THIS board — drop only its Day's queued
        // blackout (#267); legacy (no schedule) keeps the full clear.
        const fell = { blackout: true, blackoutDayIndex: hasDays ? board?.dayIndex : undefined };
        dropPendingWins(uid, fell);
        enqueueRetraction(uid, fell);
      }
      // Retraction drain (#377, Codex P1 round 1 on #467): the IRREVERSIBLE half,
      // and the only place it happens. A retraction spends the (Player, Day) win
      // forever, so it may act only on the server's OWN view of this card —
      // `boardServerCommitted` is this snapshot being neither `fromCache` nor
      // `hasPendingWrites`, i.e. the write is acked, not merely optimistic. If
      // the win no longer stands there, the server agrees the fall is real and the
      // Moment is deleted + tombstoned; if it DOES stand — a rejected unmark
      // rolled back (a pre-#458 cells-array straggler, a seed/unlock guard), or
      // the Player re-marked — the intent is dropped and nothing is spent.
      // Offline no such snapshot arrives, so intents simply wait for reconnect.
      if (boardServerCommitted) {
        drainRetractions(uid, {
          dayIndex: hasDays ? board?.dayIndex : undefined,
          bingoStands: bingoLines > 0,
          blackoutStands: black,
        });
      }
    }
    // Baseline vs detection (round 2 finding C, kept for the animation): under the
    // ADR 0006 persistent cache the first snapshot(s) can be cache-only, and a
    // stale cache lacking a bingo the server already has would make the server
    // confirmation read as a live transition — animating a celebration for a win
    // that already stood. So while the board is NOT server-confirmed every snapshot
    // re-seeds wasBingoLines/wasBlackout without animating (initialized stays false); the
    // first server-confirmed snapshot is baseline too; edge DETECTION runs after it.
    // This is now purely cosmetic (no writes), so the round-3/round-4 local-action
    // machinery the offline MOMENT once needed is gone: a win completed while the
    // board is still cache-only animates when the board confirms — a small cosmetic
    // delay the durable Moment (action path, fires at mark time) does not share.
    if (!boardConfirmed || !initialized.current) {
      wasBingoLines.current = bingoLines;
      wasBlackout.current = black;
      initialized.current = boardConfirmed;
      drainMoments(); // duty 2: even a baseline snapshot delivers a board to revalidate against
      return;
    }
    // #176: fire on a RISING edge in the completed-line COUNT (bingoEdge, computed
    // above), so a 2nd/3rd bingo line re-animates — not just the first. Blackout
    // still takes visual priority; only one animation shows.
    const blackoutEdge = black && !wasBlackout.current;
    if (blackoutEdge) {
      setCelebrate('blackout');
      track('blackout');
    } else if (bingoEdge) {
      setCelebrate('bingo');
    }
    wasBingoLines.current = bingoLines;
    wasBlackout.current = black;
    drainMoments(); // duty 2
    // `boardServerCommitted` is a dependency because the server ack for an unmark
    // usually delivers IDENTICAL cells (the optimistic snapshot already had them),
    // so a `[cells]`-only effect would never re-run to drain the retraction intent
    // that unmark queued — the write would hang until some later cells change.
  }, [cells, cellsAttributable, boardConfirmed, boardServerCommitted, uid, drainMoments]);

  // The mark-stamp animation's edge detector (specs/motion-polish.md): a
  // Square whose marked flag RISES between attributable snapshots wears
  // `.just-marked` (the `stamped` state above) until its stamp animation
  // ends. Same edge discipline as the celebration refs above — the first
  // attributable snapshot per board identity (`edgeStateKey`: account AND
  // viewed Day) is a BASELINE, so a returning Player's standing marks, a Day
  // switch, or an account switch never replays the stamp; only a fresh Mark
  // does. The set is cleared per cell on animationend (reduced-motion leaves
  // the class inert — the kill switch in index.css collapses the animation
  // anyway).
  const prevMarkedRef = useRef<{ key: string; marked: Set<number> } | null>(null);
  useEffect(() => {
    if (!cellsAttributable || cells.length === 0) return;
    const markedNow = new Set(cells.filter((c) => c.marked && !c.free).map((c) => c.index));
    const prev = prevMarkedRef.current;
    prevMarkedRef.current = { key: edgeStateKey, marked: markedNow };
    if (prev == null || prev.key !== edgeStateKey) return; // baseline: never animate
    const fresh = [...markedNow].filter((i) => !prev.marked.has(i));
    if (fresh.length > 0) setStamped((s) => new Set([...s, ...fresh]));
  }, [cells, cellsAttributable, edgeStateKey]);
  const clearStamp = (index: number) =>
    setStamped((s) => {
      if (!s.has(index)) return s;
      const next = new Set(s);
      next.delete(index);
      return next;
    });

  // The deal cascade's replay decision (Codex P2 on #421), STICKY per mounted
  // board identity: computed once when this mount first sees a given dealKey
  // (adjust-during-render ref, the edgeStateUid idiom) and held for that
  // key's lifetime — recomputing per render would flip the grid to its
  // "already dealt" state on the first re-render after the effect below
  // records the key (a tally echo lands within the cascade's ~800ms),
  // cancelling the animation mid-flight. The effect records the identity
  // AFTER commit, so a discarded render never marks a cascade as played.
  const dealKeyLive = board != null ? `${edgeStateKey}:${board.seed}` : null;
  const replayDealRef = useRef<{ key: string; replay: boolean } | null>(null);
  if (dealKeyLive != null && replayDealRef.current?.key !== dealKeyLive) {
    replayDealRef.current = { key: dealKeyLive, replay: !dealCascadePlayed.has(dealKeyLive) };
  }
  const replayDeal = replayDealRef.current?.replay ?? false;
  useEffect(() => {
    if (dealKeyLive != null) dealCascadePlayed.add(dealKeyLive);
  }, [dealKeyLive]);

  // Feed → Board square-opening intent (#261): a Tally Card's ＋ Proof /
  // 🙋 Got it too recorded {dayIndex, itemId} and navigated here. Switch the
  // viewed Day first; once the DAY-SCOPED board is rendered and attributable,
  // open the sheet on that Prompt's cell through the same `proofTarget` the
  // grid tap uses (marked cell → proof-add open, unmarked → claim open with
  // the pledge row). The intent is dropped — not retried — if the Prompt is
  // no longer on the viewer's card by the time the board arrives.
  useEffect(() => {
    if (!openSquareIntent || !hasDays) return;
    if (viewedIndex !== openSquareIntent.dayIndex) {
      setViewedIndex(openSquareIntent.dayIndex);
      return;
    }
    if (!cellsAttributable || cells.length === 0) return;
    const cell = cells.find((c) => !c.free && c.itemId === openSquareIntent.itemId);
    if (cell) setProofTarget(cell);
    clearOpenSquare();
  }, [openSquareIntent, hasDays, viewedIndex, cells, cellsAttributable]);

  // Release held day-honor pins once the identity resolves (#280 round 2).
  // Holds are uid-keyed, so another account's stay queued for its return. Drain
  // every held Day for this account: the winning Day may no longer be rendered
  // when the saved row finally resolves, and fall observers already drop held
  // pins whose bingo no longer stands.
  useEffect(() => {
    if (!identityKnown || !uid) return;
    const mine = takeHeldHonorPins(uid);
    if (!mine.length) return;
    const actor = {
      uid,
      displayName,
      photoURL: (player ? player.photoURL : user?.photoURL) ?? null,
    };
    const release = async () => {
      for (const h of mine) {
        let stillHasBingo = false;
        if (hasDays && board?.dayIndex === h.dayIndex && cellsAttributable && cells.length > 0) {
          stillHasBingo = hasBingo(cells);
        } else {
          let readFailed = false;
          const snap = await getDoc(dayBoardRef(h.dayIndex, uid)).catch(() => {
            readFailed = true;
            return null;
          });
          if (readFailed) {
            enqueueHeldHonorPin(h.uid, h.dayIndex, h.at);
            continue;
          }
          const heldCells = snap?.exists() ? ((snap.data().cells ?? []) as Cell[]) : [];
          stillHasBingo = hasBingo(heldCells);
        }
        if (stillHasBingo) void pinDayFirstBingo(h.dayIndex, actor, h.at);
      }
    };
    void release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKnown, uid]);

  if (!uid) return null;

  // `days`/`hasDays` are resolved once at the top of the component (the
  // day-scoped Board subscription keys on them). Adopt today's Day as the viewed
  // default the FIRST render `days` is non-empty; guarded to fire once so it can
  // never override a Player's own later chip tap (adjust-during-render, mirroring
  // `edgeStateUid` above). Once the cruise has ended (`frozenAt` set + farewell
  // Day unlocked) the farewell Day — podium included — is pinned as the default
  // view (#217, `farewellPinIndex`); before the freeze it falls back to today's Day.
  if (!viewedIndexInitialized.current && hasDays) {
    viewedIndexInitialized.current = true;
    const initNow = Date.now();
    setViewedIndex(farewellPinIndex(days, event?.frozenAt, initNow) ?? defaultViewedIndex(days, initNow));
  }
  const viewedDay = hasDays ? (days[viewedIndex] ?? days[0]) : undefined;
  // The viewed Day's deal state (#246), folding the schedule + clock + the
  // day-scoped Board through `dayDealState`: `locked` (future → preview),
  // `waking` (unlocked-by-clock but the snapshot isn't stamped yet → "waking up"
  // wait, deal NOTHING), `ready` (unlocked + snapshot present, deal on open), or
  // `dealt` (a Board exists → render it). `now`, not `Date.now()` — the SAME
  // clock the unlock timer bumps (Codex P2, PR #230), so a rollover flips the
  // state via a state update, not only on the next unrelated render.
  const viewedState = viewedDay
    ? dayDealState({
        unlockAt: viewedDay.unlockAt,
        snapshotItemIds: viewedDay.snapshotItemIds,
        now,
        hasBoard: !!board,
      })
    : undefined;
  // ---- Reshuffle eligibility (#378, specs/reshuffle.md) ----
  //
  // The chip renders only when ALL of these hold. Each is a separate clause on
  // purpose: every one of them is independently re-checked by firestore.rules, so
  // a chip that renders when any is false is a button that offers a write the
  // server will refuse.
  //
  //   - the card is PRISTINE — `isPristine`, not `countMarked() === 0`: a pending
  //     admin_confirmed Mark scores nothing but IS a tap, and the rules count it
  //     (see isPristine's doc);
  //   - the counter is KNOWN and under the allowance. `identityKnown` gates the
  //     read because an unconfirmed-absent player row reads `null`, and
  //     `(player?.reshufflesUsed ?? 0) < 3` would then cheerfully offer "×3" to
  //     someone who has spent all three — the same tri-state trap `knownFirstBingoAt`
  //     exists for;
  //   - the Day is UNLOCKED. Not `viewedState`, which short-circuits to 'dealt'
  //     whenever a Board exists and so says nothing about lock state on a rendered
  //     card — the clock comparison is the honest question, against the `now` the
  //     unlock timer bumps;
  //   - the card is the caller's own (`cellsAttributable`), matching every other
  //     action path here;
  //   - we are ONLINE — the board replace and the counter increment must land
  //     together, so this write is the one that must never queue (ADR 0006's
  //     offline durability is deliberately NOT wanted here).
  const reshufflesUsed = identityKnown ? (player?.reshufflesUsed ?? 0) : null;
  const reshuffleLeft = reshufflesUsed == null ? 0 : RESHUFFLE_ALLOWANCE - reshufflesUsed;
  const reshuffleEligible =
    hasDays &&
    viewedDay != null &&
    board != null &&
    cellsAttributable &&
    isPristine(cells) &&
    reshufflesUsed != null &&
    reshuffleLeft > 0 &&
    viewedDay.unlockAt <= now &&
    online;
  // Close a dangling sheet during render, the same adjust-during-render idiom the
  // tally/proof sheets use: the sheet is open and a Mark lands from another tab
  // (card no longer pristine), the account switches, or the connection drops — the
  // confirm button must not survive its own preconditions. The write path
  // re-checks server-side too, for the races this cannot see.
  if (reshuffleOpen && !reshuffleEligible) setReshuffleOpen(false);

  const daySwitcher = hasDays ? (
    <DaySwitcher days={days} viewedIndex={viewedIndex} onSelect={setViewedIndex} />
  ) : null;
  // The tutorial (embark/farewell) Day indexes, threaded to the Mark/proof write
  // paths so the persisted cruise-wide `firstBingoAt` excludes them (spec §
  // "Resolved decisions" #2). `undefined` for legacy events excludes nothing.
  const tutorialDayIndexes = hasDays ? [...tutorialDayIndexSet(days)] : undefined;
  // The ceremonial (farewell) Day indexes + the standings freeze (#265): the
  // farewell bucket never enters the summed root totals, and once `frozenAt`
  // is stamped (the Day-10 08:00 scheduler beat) marks stop folding player
  // stats entirely — cells and Tally stay live (past Days stay markable), the
  // standings don't move. `frozenAt` is only ever stamped when reached, so its
  // presence IS the freeze.
  const ceremonialDayIndexes = hasDays ? [...ceremonialDayIndexSet(days)] : undefined;
  // `standingsFrozen` folds the scheduler's stamp with the scheduled farewell
  // unlock (the stale-cache belt, Codex P2 on #278) — `now` is the same
  // unlock-rollover clock the deal state reads, so the freeze engages on time
  // even in a tab that has been open (or offline) across the boundary. The
  // instant honor-mark path captures the boolean at tap time; the PROOF path
  // gets the GETTER below, so a slow upload straddling 08:00 is re-checked
  // inside the transaction (Codex P2 on #278 round 3).
  const statsFrozen = standingsFrozen(event, now);
  const isStatsFrozen = () => standingsFrozen(event);

  // A `locked` (future) or `waking` (unlocked-by-clock, snapshot not yet stamped)
  // viewed Day has no Board to deal or show — render the themed preview and deal
  // NOTHING (daily-cards-spec § "Locked Day preview" / "Client fallback"). This
  // branch is orthogonal to the `!board` guard below (which handles a `ready` Day
  // whose card is mid-deal). No inline Guidelines mount here (#208 retired every
  // Board-inline/pathname-gated AcceptableUse mount for the single More-menu row —
  // w3-security-hardening.test.tsx "reachable from every signed-in route"): the tab
  // bar (Nav, App.tsx) renders alongside Board regardless of state, so More — and
  // Guidelines inside it — stays reachable here exactly like any other route.
  if (viewedDay && (viewedState === 'locked' || viewedState === 'waking')) {
    return (
      <>
        {daySwitcher}
        <LockedDayPreview
          day={viewedDay}
          timezone={event?.timezone}
          waking={viewedState === 'waking'}
        />
      </>
    );
  }

  if (!board || !cellsAttributable) {
    // A lazy per-Day deal that FAILED for the viewed Day (thin/malformed snapshot
    // or a repeatedly-denied write) surfaces a retry instead of an indefinite
    // "Dealing…" spinner (Codex #247 P2). Retry clears the in-flight guard + error
    // and bumps the deal nonce so the effect re-attempts.
    if (hasDays && dayDealError === viewedIndex) {
      return (
        <>
          {daySwitcher}
          <div className="center muted" role="alert">
            <p>We couldn’t deal this day’s card.</p>
            <p>Check your connection, then retry.</p>
            <button
              className="btn"
              onClick={() => {
                if (uid) dealingDaysRef.current.delete(`${uid}:${viewedIndex}`);
                setDayDealError(null);
                setDealNonce((n) => n + 1);
              }}
            >
              Retry
            </button>
          </div>
        </>
      );
    }
    // A Board is dealt once at join from the active, non-free Prompt pool
    // (ADR 0003). dealBoard needs >= MIN_POOL prompts (ADR 0004); with fewer the
    // deal throws and no Board is ever written, so a bare `!board` check would
    // spin on "Dealing…" forever. Detect the thin pool here and surface the
    // guard to the Player rather than the blank card AC forbids. While either
    // subscription is still loading we can't tell a thin pool from an unfetched
    // board or a deal in flight, so keep the neutral state until both resolve —
    // this also avoids flashing the guard at a returning Player whose already
    // dealt board is mid-fetch when the pool has since gone thin. `loading`
    // alone is not enough under the ADR 0006 persistent cache (Codex P2, PR #66
    // round 4): a cold/stale IndexedDB can resolve both listeners FROM CACHE
    // with board=null and items=[], which would flash "0 prompts" at a Player
    // whose server state is a healthy pool or an existing Board — so the alert
    // additionally requires both subscriptions' hasServerData latch (a
    // server-confirmed snapshot has arrived). Cache-only data keeps the neutral
    // state below. (Pool-recovery has TWO recovery paths once a deal has failed:
    // the DealError panel's manual Retry, and the shell-level auto-retry that fires
    // when the pool crosses MIN_POOL upward — #70, src/components/PoolRecoveryWatcher.tsx.
    // This pre-deal empty state only explains the shortage; the auto-retry watches
    // the post-failure DealError state, not this one, so this copy still must not
    // promise automatic dealing here.)
    // Legacy-only (#246): this thin-pool guard reads the live `main` pool
    // (`useItems`), which is the join-deal source only in single-Board mode. In
    // daily mode a Day Card deals from that Day's FROZEN `snapshotItemIds`, not the
    // live pool, and a tutorial Day deals from the embark/farewell pool `useItems`
    // doesn't even surface — so the live-main count is the wrong measure and would
    // false-positive on a Day whose snapshot is fine. A `ready` day with no card
    // yet falls through to the "Dealing…" state while `dealDayCard` runs.
    const activePool = items.filter((i) => !i.isFreeSpace);
    if (
      !hasDays &&
      !boardLoading &&
      !poolLoading &&
      boardConfirmed &&
      poolConfirmed &&
      activePool.length < MIN_POOL
    ) {
      return (
        <>
          {daySwitcher}
          <div className="center muted" role="alert">
            <p>Not enough prompts to deal a full card yet.</p>
            <p>
              A card needs {MIN_POOL} prompts; the pool has {activePool.length}. Add prompts from the
              Prompts tab, then retry dealing from the Card tab.
            </p>
          </div>
        </>
      );
    }
    // #434 (Codex #438): no live, attributable board to render. This covers a
    // Firestore-cache eviction, a retained foreign board during an account switch,
    // and captive/ship Wi-Fi where navigator.onLine can be true while Firestore is
    // unreachable. Render only a durable snapshot that matches THIS viewed Day, so
    // an offline Day switch can never show the last card painted for another Day.
    if (uid) {
      const snapshot = loadCardSnapshot(uid, hasDays ? viewedIndex : null);
      if (snapshot) {
        return (
          <>
            {daySwitcher}
            <CachedCardFallback
              snapshot={snapshot}
              onRetry={() => {
                // Nudge both deal paths: the day-scoped lazy deal (dealNonce) and
                // the AuthContext join/legacy deal (retryDeal). If Firestore is
                // merely unreachable, this gives the Player agency without waiting
                // for a connectivity event the browser may never emit.
                setDealNonce((n) => n + 1);
                retryDeal();
              }}
              retrying={dealing}
            />
          </>
        );
      }
    }
    return (
      <>
        {daySwitcher}
        <LoadingState label="Dealing your card…" />
      </>
    );
  }

  const wins = winningCells(cells);
  // The payline sweep's per-cell order (specs/motion-polish.md): position of
  // each winning Square along ITS OWN line — `completedLines`, never the
  // `wins` union, so every line sweeps 0..4 independently and a multi-line
  // win (blackout included) never queues one board-wide ramp (Codex P2 on
  // #421). Consumed by `.cell.win`'s staggered `--win-order` delay.
  const winOrderByIndex = winOrder(completedLines(cells));
  // Remounting the grid per board identity replays the deal-in cascade for
  // every genuinely new card — first deal, Day switch, reshuffle (fresh seed),
  // account switch — while ordinary re-renders (marks, tally updates) keep
  // the DOM and play no entrance. Same identity notion as `edgeStateKey`,
  // plus the seed so a reshuffled card (same uid+Day) still re-deals. The
  // route-remount half of the gate is `replayDeal` above: this mount plays
  // the cascade only if the identity has not already dealt this session.
  const dealKey = dealKeyLive ?? `${edgeStateKey}:${board.seed}`;

  const doMark = async (c: Cell, nextMarked: boolean) => {
    // Attribution guard (Codex P2, PR #110 finding 2 — the SAME cellsAttributable
    // derivation the Celebration baseline uses): during an account switch the
    // subscription can still expose the PREVIOUS uid's board for a render, and a
    // tap landing in that render would fold the previous account's cells into the
    // current uid's board write AND feed its verdict into an immutable Moment
    // broadcast attributed to the current uid. Bail entirely — no setMark, no
    // enqueue; the next attributable render accepts taps normally.
    if (!cellsAttributable) return;
    try {
      // The first-bingo stamp `computeMark` preserves is per-BOARD, and in daily
      // mode each Day has its OWN board — so the "current first bingo" for a Mark is
      // the VIEWED Day's bucket, never the cruise-wide root (which would restamp an
      // earlier main-day bingo into this Day's honor — Codex #247 P2). The
      // knownFirstBingoAt tri-state still gates: `undefined` (row unknown) is
      // preserved so setMark omits the field rather than clobbering the server value.
      const rootFirstBingoKnown = knownFirstBingoAt(player, playerLoading, playerConfirmed);
      const currentFirstBingoAt =
        rootFirstBingoKnown === undefined
          ? undefined
          : hasDays
            ? (player?.dayStats?.[viewedIndex]?.firstBingoAt ?? null)
            : rootFirstBingoKnown;
      const res = await setMark({
        uid,
        cells,
        index: c.index,
        nextMarked,
        claimMode,
        currentFirstBingoAt,
        displayName: identityKnown ? displayName : undefined,
        // Stamp the viewed Day (#216, #246) so the Mark writes the right day-scoped
        // Board and its Tally marker groups into the right per-`(itemId, dayIndex)`
        // Feed card. In daily mode this is the SELECTED `viewedIndex` (the Day the
        // Player is looking at); legacy falls back to the dealt board's own dayIndex.
        dayIndex: hasDays ? viewedIndex : board?.dayIndex,
        // Route the Mark to the DAY-SCOPED board + fold its stats into
        // `dayStats[viewedIndex]` (#246). Legacy events keep the single-board path.
        daily: hasDays,
        boardSeed: board?.seed,
        tutorialDayIndexes,
        ceremonialDayIndexes,
        statsFrozen,
        // Echo Marks (specs/echo-marks.md, #446): the full schedule, so a Mark
        // that lands confirmed can auto-mark its Prompt on the Player's other
        // Day Cards in the same batch. Legacy events pass nothing (no echo).
        echoDayIndexes: hasDays ? days.map((d) => d.index) : undefined,
      });
      track('mark_square', { mode: claimMode, marked: nextMarked });
      if (nextMarked && res.bingo) track('bingo');
      if (nextMarked) {
        // Feed Moment broadcast on the ACTION path (issue #104): the win is tied
        // to the mark that COMPLETED it — setMark's synchronous transition
        // verdict — not to a snapshot diff that dies on unmount. Shared with the
        // proofed-mark path (attachProof returns the same verdict shape).
        await broadcastWinVerdict(res);
      } else {
        // Action-driven falling edge (issue #104, hardened by PR #110 finding 1):
        // an unmark whose verdict shows a win no longer stands DROPS its
        // still-held broadcast — a win completed-then-unmarked BEFORE its gate
        // opens never posts (a bingo fall also drops the ceremonial candidate) —
        // and an unmark that actually DROPS the bingo bumps the action generation
        // so an in-flight witness continuation from an earlier mark is invalidated
        // (round 4: a NON-falling unmark — another line still standing — bumps
        // nothing, so a legitimate ceremony mid-witness-read survives it). An already-drained
        // flag is a harmless no-op (the Moment is immutable + once-only besides).
        const fell = {
          bingo: !res.bingo,
          blackout: !res.blackout,
          // The unmark verdict witnesses the ACTED board only (#267 for
          // blackout; #372 extends the same day-scoping to bingo, so unmarking
          // on one Day cannot drop another Day's still-standing queued bingo).
          // Legacy single-board Events deliberately enqueue the day-less token:
          // `drainRetractions` has no Day there, so a stamped board.dayIndex
          // would never match and the retraction could never commit.
          bingoDayIndex: hasDays ? viewedIndex : undefined,
          blackoutDayIndex: hasDays ? viewedIndex : undefined,
        };
        dropPendingWins(uid, fell);
        // The same fall on the PUBLISHED side (#377) — but only as an INTENT.
        // The SAME `fell` verdict drives both halves, so the pre- and
        // post-publish paths can never disagree about what fell. The irreversible
        // write waits for a SERVER-COMMITTED board to confirm the fall (see the
        // drain in the cells effect): this verdict is a LOCAL fold and setMark's
        // batch is still pending, so a rejected unmark would otherwise spend a
        // win the server rolls back to standing (Codex P1, round 1 on #467).
        enqueueRetraction(uid, fell);
        if (hasDays && !res.bingo) dropHeldHonorPins(uid, viewedIndex);
        // Drain with the action's own folded cells AND its own Day (see
        // broadcastWinVerdict) — skipped if the account switched while the
        // await was in flight (the shared post-await revalidation; no
        // generation to compare — this very action just bumped it).
        if (revalidateAfterAwait(uid).isCurrentAccount)
          drainMoments(res.cells, hasDays ? viewedIndex : board?.dayIndex);
      }
    } catch {
      /* Neither an offline Mark nor an online write REJECTION lands here:
         setMark's commit is fire-and-forget. Offline it queues durably in the
         persistent cache (ADR 0006, #20) and syncs on reconnect; an online
         rejection is logged inside setMark and self-corrects when Firestore
         rolls the write back and the live listener re-renders without the Mark.
         This catch only guards a synchronous throw from setMark itself — no
         write happened and no Moment was enqueued, so there is nothing to
         broadcast or undo. */
    }
  };

  // The shared POST-AWAIT revalidation (PR #110 round 3, findings B + D): every
  // async continuation in the broadcast pipeline re-checks the world through this
  // ONE helper, synchronously after its last await, before acting on anything it
  // captured earlier — the invariant is structural, not per-call-site. Two
  // separable answers, used by need:
  //   • `generationUnchanged` — no OBSERVED BINGO FALL interleaved for the ACTED
  //     account since `capturedGeneration` (round 4: non-falling unmarks and
  //     blackout-only falls do not bump): a stale action never acts.
  //     (Omit the argument where the action itself just bumped, e.g. an unmark.)
  //   • `isCurrentAccount` — the acted account still drives this Board. Required
  //     for steps that touch the CURRENT context (draining with the current
  //     actor/gates). Deliberately NOT required for ENQUEUES (finding D chosen
  //     semantics): the queue is uid-keyed, so a candidate enqueued for the acted
  //     uid under a switched account cannot leak — it simply waits, and drains
  //     when that account returns. A skipped drain therefore destroys nothing:
  //     consumption happens only at the drain's synchronous decision point.
  const revalidateAfterAwait = (actedUid: string, capturedGeneration?: number) => ({
    generationUnchanged:
      capturedGeneration === undefined || pendingActionGeneration(actedUid) === capturedGeneration,
    isCurrentAccount: feedCtx.current.uid === actedUid,
  });

  // ONE completing-action broadcast pipeline for BOTH mark paths (issue #104 +
  // PR #110 round 2 finding 1): the bare honor Mark (doMark → setMark) and the
  // proofed Mark (ProofSheet → attachProof) return the SAME win verdict shape.
  // Enqueue the Moment(s) the verdict reports, run the ceremonial BIRTH-TIME
  // witness + generation gauntlet, then drain with the action's own folded cells
  // — the authoritative post-action board (the render-current snapshot has
  // usually not echoed yet), so the drain's fire-time revalidation sees the state
  // this verdict came from. Whatever gate is still closed stays queued (surviving
  // an unmount / route change) and drains on the next gate-open. This covers the
  // OFFLINE honor win for free: setMark computes the transition from the local
  // cache and the Moment `setDoc` pends durably (ADR 0006). attachProof cannot
  // run offline at all (its transaction rejects), so its verdict is always an
  // online fact.
  const broadcastWinVerdict = async (res: {
    cells: Cell[];
    bingoTransition: boolean;
    blackoutTransition: boolean;
  }) => {
    // The ACTED Day, captured synchronously with the verdict (before any await
    // below) — the drain override and the enqueue both use THIS, never the
    // render-time day a mid-flight switch could change.
    const actedDay = hasDays ? viewedIndex : board?.dayIndex;
    // The WIN's own time (#280 round 4): the completing Mark's `markedAt` from
    // the folded cells — the same clock the stats fold persisted — falling
    // back to the verdict clock when no cell stamp is readable. A slow upload
    // preceding the verdict can then never skew the displayed honor time.
    const actedAt = firstCompletedLineAt(res.cells) ?? Date.now();
    enqueueWinMoments({
      uid,
      bingoTransition: res.bingoTransition,
      blackoutTransition: res.blackoutTransition,
      // The Day THIS Mark landed on, captured NOW (Codex finding 2,
      // fix/d15-blackout-day-naming) — never re-derived at drain time, when the
      // Player may be looking at a different Day. `undefined` on a legacy
      // (non-daily) Event: daily-cards-spec's "Day N" naming doesn't apply
      // there, so a blackout Moment on that shape stays day-less (Codex finding
      // 1: a legacy single-Board Event has no Day schedule to render a chip
      // from — `board?.dayIndex` defaulting to 0 would otherwise read as a
      // misleading "Day 1").
      dayIndex: hasDays ? viewedIndex : undefined,
    });
    // The per-Day First to BINGO pin (#264, daily-cards-spec § "Scoring and
    // social surfaces"): fired on the rising edge by the achieving Player
    // themselves — the day-meta create rule requires firstBingo.uid ==
    // request.auth.uid — and WRITE-ONCE server-side (create-only, no update),
    // so the honest race's first create wins (ADR 0001) and a later bingo on
    // the same Day lands on the deny-all update and is swallowed. Identity-
    // gated like a Doubt raise: a permanent public honor must never stamp
    // 'Anonymous' — an unknown-identity win skips the pin (the honors strip's
    // roster-derived fallback still names them once their row resolves).
    if (res.bingoTransition && hasDays && actedDay !== undefined) {
      // Re-read the LIVE gate through feedCtx (#280 round 3): this verdict can
      // run after an await (a proofed win's upload), and the render-closure
      // `identityKnown` may be stale — the row can have resolved mid-flight,
      // in which case a held pin would idle until an unrelated flip.
      const live = feedCtx.current;
      if (live.identityKnown && live.uid === uid) {
        void pinDayFirstBingo(actedDay, {
          uid,
          displayName: live.displayName,
          photoURL: live.photoURL,
        }, actedAt);
      } else {
        // Identity still resolving (#280 round 2): hold the pin — MODULE
        // state keyed to the acted account (rounds 3-4), so it survives Board
        // unmounts/route changes and a switch never releases another player's
        // honor. `at` is the WIN's own time. Reload loses the hold
        // (in-memory), an accepted residual the strip's derived fallback
        // covers.
        enqueueHeldHonorPin(uid, actedDay, actedAt);
      }
    }
    // The BIRTH-TIME witness (round 2 finding D; made the SOLE witness site by
    // round 3 finding A): the prior-win question — "is this win a regain?" — is
    // answerable only HERE, at the moment the win happened, before this
    // pipeline's own plain bingo posts. (Round 2's drain-time re-read saw that
    // just-written `${uid}-bingo` doc when a roster-held ceremony finally
    // drained, and suppressed the original win's own ceremony — finding A.) A
    // regained line whose owner already has a `${uid}-bingo` Moment in the local
    // cache never mints a candidate; a cache miss (fresh device) resolves false,
    // so the drain's publish-time roster gate is the fallback (the narrowed
    // residual the spec documents).
    //
    // The read is ASYNC, and the pending win can change inside that gap (round 1
    // P1): the player can unmark and LOSE the bingo while the read is in flight.
    // The continuation therefore re-checks through the shared post-await
    // revalidation: the captured ACTION GENERATION must be unchanged (every
    // OBSERVED BINGO FALL bumps it — round 4: a non-falling unmark does not,
    // so it cannot suppress a ceremony whose bingo stands continuously). It is deliberately NOT gated on the
    // pending bingo flag (round 2 finding 2: a concurrent drain can legitimately
    // FIRE the plain bingo mid-read — that clear says the win STOOD) and NOT
    // gated on the current account (round 3 finding D: the queue is uid-keyed,
    // so the enqueue cannot leak — the candidate waits for the acted account).
    // The ceremonial First-to-BINGO candidate never mints post-freeze (Codex
    // P2 on #278 round 2): the headline honor was decided when the podium was
    // computed — a post-freeze bingo still celebrates locally and posts its
    // plain bingo/blackout Moments (the farewell card is ceremonial, not
    // silent), but must not crown a new public First to BINGO after final
    // standings. Evaluated at VERDICT time (round 3): a proofed submission's
    // slow upload can straddle the boundary, so the render-time boolean is
    // not trusted here.
    //
    // And never minted from a TUTORIAL Day (Codex P1 on #287, closing the
    // spec contract on the live path too — daily-cards-spec § "Scoring and
    // social surfaces": cruise-wide First to BINGO is anchored to MAIN-GAME
    // Days only; the embark card is live pre-cruise and trivially easy by
    // design, so it would otherwise decide the headline honor before anyone
    // boards). The tutorial Day still posts its plain bingo/blackout and pins
    // its own per-Day honor above; only the event-level singleton is gated.
    const actedTutorialDay =
      hasDays && actedDay !== undefined && (tutorialDayIndexes?.includes(actedDay) ?? false);
    if (res.bingoTransition && !isStatsFrozen() && !actedTutorialDay) {
      const generation = pendingActionGeneration(uid);
      // Tutorial-Day wins are excluded from the prior-win witness (Codex P1 on
      // #288): the legacy once-per-Player `${uid}-bingo` doc is written by
      // warm-up wins too, and reading one as a prior win would permanently
      // disqualify everyone who played the embark card from the headline honor.
      // `dayIndexes` (#372) hands over the schedule so the witness can probe the
      // PER-CARD ids, where the same exclusion is exact rather than inferential:
      // a tutorial win now owns its own day-scoped id, which is simply not
      // probed. The legacy day-less doc keeps its existing exclusion path.
      const witnessed = await hasPriorBingoWitness(uid, {
        excludeDayIndexes: hasDays ? new Set(tutorialDayIndexes) : undefined,
        dayIndexes: hasDays ? days.map((d) => d.index) : undefined,
        // #332: `generation` was captured above, before this await — if a
        // concurrent drain (gate-open/snapshot) broadcasts THIS win's plain
        // bingo while the read is in flight, the witness recognizes the
        // just-written doc as self-evidence (not a prior win) and falls
        // through to the singleton consult instead of suppressing the
        // ceremonial candidate. Still required with per-card ids (#372): the
        // same race just lands on `${uid}-bingo-d${actedDay}` instead.
        selfWriteGeneration: generation,
        // The Day this action's own bingo lands on (Codex P2 on #386) — only
        // THAT doc may be excused as self-evidence. The generation alone cannot
        // identify it: it bumps only on a bingo fall, so an earlier Day's win
        // shares this generation and would otherwise be waved through.
        selfWriteDayIndex: hasDays ? actedDay : undefined,
      });
      if (!witnessed && revalidateAfterAwait(uid, generation).generationUnchanged) {
        // The candidate carries its OWN Day (#262; Codex P3 on #286 round 2):
        // a snapshot drain can fire the plain bingo — day included — while the
        // witness read above is in flight, so the ceremony never borrows the
        // bingo's day at drain time. Same legacy form as enqueueWinMoments
        // above: `undefined` on a non-daily Event (board.dayIndex defaults to
        // 0 there, which would both mislabel the chip AND never match the
        // drain's undefined legacy witnessDay — holding the ceremony forever).
        enqueueFirstBingoMoment(uid, hasDays ? actedDay : undefined);
      }
    }
    // Draining touches the CURRENT actor/gates, so it does require the acted
    // account to still be active; the queue keeps the flags otherwise. The
    // override rides with ITS OWN Day (Codex P2, #275 round 4) — actedDay was
    // captured before the awaits above, so a mid-flight Day switch cannot
    // relabel the witness.
    if (revalidateAfterAwait(uid).isCurrentAccount) drainMoments(res.cells, actedDay);
  };

  const toggle = (c: Cell) => {
    // The shared attribution guard (PR #110 finding 2, widened in round 2):
    // NO action may start from a render still showing another account's board —
    // an honor mark would fold the wrong cells (doMark also guards, belt-and-
    // braces), and a proof sheet would open against the wrong card.
    if (!cellsAttributable) return;
    if (c.free) {
      setFreePulse((pulse) => pulse + 1);
      return;
    }
    if (c.marked) {
      doMark(c, false); // unmark is always instant
      return;
    }
    // EVERY claim opens the ProofSheet (issue #181) — honor included, which
    // used to mark instantly here. In honor mode the sheet's 🎖️ Cross My Heart
    // pledge (onPledge below) is the one-tap path back to that same bare Mark;
    // proof_required / admin_confirmed still require a real capture.
    setProofTarget(c);
  };

  return (
    <>
      {/* No itinerary line here (#300) — per the wireframe the header carries
          brand + today's port/theme and the day bar carries day name/port/
          description, so the Card chrome opens straight with the Day strip. */}
      {daySwitcher}
      {/* First-open coach overlay (specs/d15-coach-overlay.md, #214): mounted
          whenever Board has cells — whichever Board is the Player's first
          dealt card, not hardcoded to the embark Day. Self-gates on a
          per-Event localStorage flag, so this fires unconditionally. */}
      {cells.length > 0 && <CoachOverlay onDismiss={() => setCoachSeen(true)} />}
      {/* Reshuffle launch announcement (#378, wireframes #frame-launch-intro):
          one-time, self-gating on its own localStorage key, mounted over a dealt
          card like the coach overlay above. QUEUED BEHIND that overlay rather
          than mounted alongside it: both draw the same `sheet-backdrop` scrim, so
          a Player joining mid-cruise (first card + unseen announcement in the
          same open) would get two stacked scrims and two CTAs. The coach overlay
          decodes the card in front of them and goes first; this announces a
          feature and can wait for the next render — its dismissal writes the
          key, which re-renders Board and lets this through. */}
      {/* `hasDays` too: Reshuffle is a daily-cards feature, so a legacy Event
          (single Board, no `days[]` schedule) must never be told about a chip it
          can never show. */}
      {hasDays && cells.length > 0 && coachSeen && <LaunchIntro />}
      {/* `board-area` is the retint scope (daily-cards-spec § "Day switcher"):
          `data-theme` here — set ONLY when the Event carries a Day schedule —
          follows the VIEWED Day and cascades the theme token set (themes.css)
          to just this chrome, leaving `<html>`'s own `data-theme` (the
          Player's own Theme choice, ThemeContext) untouched. Absent entirely
          on a not-yet-migrated Event (`hasDays` false), so the pre-Phase-1.5
          single-Board rendering is byte-identical to before. */}
      <div className="board-area" data-theme={viewedDay?.theme}>
        {/* The daybar (#260 — wireframes' day gallery): "Day N · Theme" +
            tutorial tag, port, and the dress-code description, on every
            viewed Day. Absorbs the pre-#260 tutorial-only board-header
            (the tag now renders inside the daybar's name line). */}
        {/* A banned Player's pinned honor never displays (#280 round 2) —
            same posture as the Ranks strip: hidden, never promoted. */}
        {viewedDay && (
          <DayBar
            day={viewedDay}
            honor={
              viewedDayMeta?.firstBingo && !isBanned(viewedDayMeta.firstBingo.uid, event?.bannedUids ?? [])
                ? viewedDayMeta.firstBingo
                : null
            }
            timezone={event?.timezone}
            reshuffle={
              reshuffleEligible ? { left: reshuffleLeft, onOpen: () => setReshuffleOpen(true) } : null
            }
          />
        )}
        {/* The farewell podium (#217, daily-cards-spec § "Farewell view"):
            shown on the farewell Day once the standings freeze (`frozenAt`
            set), ABOVE the goodbye banner below — this ticket owns the
            podium and its stacking order; the goodbye copy is
            TutorialBanner's. `buildPodium` freezes out the farewell Day's
            own marks, so a post-freeze goodbye tap never moves the podium.
            The roster is ban-filtered first (Leaderboard.tsx parity): the
            podium is a public leaderboard-like surface, so a banned Player
            must never surface as champion, First to BINGO, or a daily
            honor (Codex #244). */}
        {viewedDay?.pool === 'closing' && event?.frozenAt != null && (
          <FarewellPodium
            players={players.filter((p) => !isBanned(p.uid, event?.bannedUids ?? []))}
            days={days}
            dayMetas={dayMetas}
            dayMetasLoaded={dayMetasLoaded}
            /* Board's own event, passed down for the Share Card's copy
               (Codex P2, PR #450): the frozenAt gate above guarantees it is
               loaded, so the podium never opens a second listener that
               could bake the bare-app-name card on an early Share tap. */
            event={event}
          />
        )}
        {viewedDay && <TutorialBanner day={viewedDay} event={event} />}
        {/* Keyed + gated like the grid below (Codex P3 on #421 round 3): the
            header letters cascade once per board identity — replaying for a
            genuinely new card (Day switch, reshuffle) and mounting landed on
            a tab round-trip — instead of riding every route remount. */}
        <div className={'bingo-head' + (replayDeal ? '' : ' bingo-head-dealt')} key={`head:${dealKey}`}>
          {['B', 'I', 'N', 'G', 'O'].map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
        {/* `data-server-confirmed` mirrors useBoard's `hasServerData` latch — the
          first SERVER-backed board snapshot (vs the latency-compensated cache
          echo that can arrive first). It carries no styling; it is the
          deterministic signal the e2e suite waits on before tapping a winning
          line, so a BINGO that lands while the board is still cache-only (which
          the Celebration baseline above would swallow as an initial state, not
          an animated edge) cannot flake the BINGO! assertion (Codex P2 on
          PR #114 round 3). */}
        {/* `grid-dealt` (Codex P2 on #421): a card whose cascade already
            played this session mounts landed — the class zeroes the entrance
            animation (index.css) instead of replaying it on a tab
            round-trip. */}
        <div
          className={'grid' + (replayDeal ? '' : ' grid-dealt')}
          key={dealKey}
          data-server-confirmed={boardConfirmed ? 'true' : 'false'}
        >
        {cells.map((c) => (
          <div
            key={c.index}
            className={
              'cell' +
              (c.free ? ' free' : '') +
              (c.marked ? ' marked' : '') +
              (c.marked && c.echo === true ? ' echo' : '') +
              (c.status === 'pending' ? ' pending' : '') +
              (wins.has(c.index) ? ' win' : '') +
              (stamped.has(c.index) ? ' just-marked' : '') +
              (c.free && freePulse > 0 ? (freePulse % 2 ? ' free-pulse-a' : ' free-pulse-b') : '')
            }
            // The motion pass's per-Square inputs (specs/motion-polish.md):
            // the deal cascade's column/row delay, and — on a winning line —
            // the payline sweep's position stagger.
            style={
              {
                '--deal-delay': `${dealDelayMs(c.index)}ms`,
                ...(winOrderByIndex.has(c.index)
                  ? { '--win-order': winOrderByIndex.get(c.index) }
                  : null),
              } as CSSProperties
            }
            role={c.free ? 'button' : undefined}
            tabIndex={c.free ? 0 : undefined}
            aria-label={c.free ? c.text : undefined}
            title={c.free ? 'Free space—already marked' : undefined}
            onClick={() => toggle(c)}
            onKeyDown={(event) => {
              if (c.free && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                toggle(c);
              }
            }}
            onAnimationEnd={(event) => {
              if (c.free) setFreePulse(0);
              // The stamp is one-shot: release the class the moment its own
              // animation ends (other animations on the cell — deal, win —
              // report different names and must not clear it early).
              if (event.animationName === 'cell-stamp') clearStamp(c.index);
            }}
          >
            {c.free ? (
              <>
                <span className="free-label" aria-hidden="true">
                  FREE
                </span>
                <span className="free-prompt">{c.text}</span>
              </>
            ) : (
              <SquareText text={c.text} />
            )}
            {c.marked && !c.free && (
              <button
                className="proofbtn"
                title="Add proof"
                onClick={(e) => {
                  // stopPropagation bypasses `toggle`, so this handler needs the
                  // shared attribution guard itself (PR #110 round 3 finding C):
                  // during an account switch this cell can belong to the PREVIOUS
                  // uid's board, and a sheet opened from it would attach a proof
                  // (and broadcast a Moment) for the current uid off the wrong card.
                  e.stopPropagation();
                  if (!cellsAttributable) return;
                  setProofTarget(c);
                }}
              >
                ＋
              </button>
            )}
            {c.marked && !c.free && c.itemId && (
              // Same guard for the Tally who-list (finding C sweep): read-only, but
              // a stale render must not open another board's Prompt sheet either.
              <TallyBadge
                itemId={c.itemId}
                onOpen={() => {
                  if (cellsAttributable) setTallyTarget(c);
                }}
              />
            )}
            {c.marked && !c.free && c.itemId && (
              <DoubtBadge
                itemId={c.itemId}
                itemText={c.text}
                targetUid={uid}
                proofs={myProofs}
                onOpen={() => {
                  // The same attribution guard as the TallyBadge open above (the
                  // #110 finding-C sweep — this open was missed; round 6 closes it):
                  // a stale render must not open the who-list against another
                  // account's board.
                  if (cellsAttributable) setTallyTarget(c);
                }}
              />
            )}
          </div>
        ))}
        </div>
      </div>
      <div className="count">
        {/* Keyed by value (specs/motion-polish.md): a change remounts the
            span and replays the .stat-pop tick — the odometer beat. */}
        Marked <b key={`m${countMarked(cells)}`} className="stat-pop">{countMarked(cells)}</b> · Bingos{' '}
        <b key={`b${player?.bingoCount ?? 0}`} className="stat-pop">{player?.bingoCount ?? 0}</b>
      </div>
      {/* `cells` fixes the empty-card share race (Codex P2, PR #111 finding
          1): Celebration used to open its own useBoard(uid) listener and
          could render/share before that listener's own first snapshot
          arrived. Board already has the loaded `cells` right here
          (guaranteed by the `!board` early-return above), so handing them
          down as a prop removes the race instead of letting Celebration
          re-fetch what this component already has. `playerName` is the
          identity twin (round 2 finding 1): the SAME resolved public name
          the Tally/Proof/Moment paths carry, gated by the SAME identityKnown
          tri-state — null while the saved row is unknown, so Celebration
          disables Share instead of ever stamping the stale auth fallback
          onto a card (mirrors doMark's `identityKnown ? displayName :
          undefined`). */}
      {celebrate &&
        (() => {
          // Share Card copy (issue #423): the context + stat lines the card
          // renderer displays, composed HERE where the win's Day (port, night)
          // and the Player's stats live — the renderer stays dumb. Built only
          // when the win's Day is known (a daily event); a legacy non-daily
          // event leaves both undefined, and the card falls back to the bare
          // event name with no stat line.
          const winDay =
            hasDays && board?.dayIndex != null
              ? (days.find((d) => d.index === board.dayIndex) ?? days[board.dayIndex])
              : undefined;
          const night = winDay?.tonight?.find(Boolean);
          const nightSuffix = night ? ` · ${night} night` : '';
          const contextLine =
            winDay && event?.name
              ? `${event.name} · Day ${winDay.index + 1} · ${winDay.place}`
              : undefined;
          const statLine = winDay
            ? celebrate === 'blackout'
              ? `All 24 squares${nightSuffix}`
              : `Bingo #${shareCardBingoNumber({
                  cells,
                  rootBingoCount: player?.bingoCount ?? 0,
                  dayBingoCount: board?.dayIndex == null ? undefined : player?.dayStats?.[board.dayIndex]?.bingoCount,
                  hasDays,
                  statsFrozen,
                })} · ${countMarked(cells)} squares${nightSuffix}`
            : undefined;
          return (
            <Celebration
              // Keyed by win kind (Codex P3 on #421): a BINGO celebration still
              // open when a blackout lands must REMOUNT, not re-render — the
              // confetti burst is a mount-time lazy initializer, so an in-place
              // kind change would keep the smaller BINGO rain under the new
              // BLACKOUT hero.
              key={celebrate}
              kind={celebrate}
              cells={cells}
              playerName={identityKnown ? displayName : null}
              contextLine={contextLine}
              statLine={statLine}
              onClose={() => setCelebrate(null)}
            />
          );
        })()}
      {proofTarget && user && (
        <ProofSheet
          uid={uid}
          // Attribute new proofs to the denormalized player identity, which the
          // profile editor keeps current (data/profile.ts writes users/{uid} +
          // the player row, #76). Sourcing straight from the Firebase Auth user
          // would stamp the stale Google name onto proofs a renamed player
          // creates. displayName reuses the single `displayName` resolved above,
          // so a Proof and its Tally marker always carry the SAME name — one
          // source, never two. photoURL keys on whether `player` is loaded rather
          // than `??`-chaining: PlayerDoc.photoURL is nullable, and a loaded row
          // with a null photo means "no avatar" — that null must win over the
          // stale auth photo, not be masked by it. The trailing `?? null` guards
          // the UNDEFINED case (not just null): `dealDayCard` can create the
          // player row with only a `dayStats` bucket (api.ts:291), so a loaded
          // `player` can lack `photoURL` entirely — and undefined into a proof
          // `setDoc`/transaction throws, dropping the proofed Mark's attribution.
          displayName={displayName}
          photoURL={(player ? player.photoURL : user.photoURL) ?? null}
          cells={cells}
          cell={proofTarget}
          claimMode={claimMode}
          currentFirstBingoAt={player?.firstBingoAt ?? null}
          // Event admin knobs, read defensively with the spec defaults (#211).
          // `photoProofSource` is NEVER tied to claimMode — only this event-level
          // override hides the 🖼️ Library pick.
          photoProofSource={event?.settings?.photoProofSource ?? 'camera_or_library'}
          stripExif={event?.settings?.stripPhotoExif ?? true}
          // The viewed Day and the Square's live Tally count for the
          // "🔥 Marked by N others" heat line. When a Day schedule is live the
          // Day switcher can display any unlocked Day while the single legacy
          // Board still reads `dayIndex: 0`, so stamp the SELECTED `viewedIndex`
          // (what the Player is actually claiming from) — not the Board doc's
          // index, which would badge every Day-2+ claim as Day 1 (Codex P2).
          // Fall back to the Board doc index only when there is no schedule.
          dayIndex={hasDays ? viewedIndex : board?.dayIndex}
          // Route a proofed Mark to the DAY-SCOPED board + fold its stats into
          // `dayStats[viewedIndex]` (#246), the SAME path the honor Mark takes.
          daily={hasDays}
          tutorialDayIndexes={tutorialDayIndexes}
          ceremonialDayIndexes={ceremonialDayIndexes}
          statsFrozen={isStatsFrozen}
          tallyCount={proofTargetTally}
          // The proofed-mark completion verdict (PR #110 round 2 finding 1): a
          // successful attachProof reports the SAME win-transition shape setMark
          // returns, and it rides the SAME broadcast pipeline — a proof_required
          // win posts its Moment exactly like an honor win. (In admin_confirmed
          // the attached cell is pending and excluded from the win mask, so the
          // verdict is structurally transition-free — the confirm-path Moment
          // stays #41's.) Fire-and-forget: the sheet closes without waiting on
          // the witness read.
          onAttached={(res: AttachProofResult) => void broadcastWinVerdict(res)}
          // The 🎖️ Cross My Heart pledge (issue #181), offered only on a CLAIM
          // open — an unmarked Square's tap. It is the bare honor Mark the tap
          // used to make directly: doMark carries the verdict through the same
          // broadcast pipeline, and the mark queues offline exactly as before
          // (ADR 0006 — a pledge is a setMark, never a transaction). A ＋-button
          // proof-add open (marked cell) omits it: the Square is already
          // claimed, so ProofSheet hides the row entirely.
          onPledge={
            proofTarget.marked
              ? undefined
              : () => {
                  const target = proofTarget;
                  setProofTarget(null);
                  // Write-time twin of the render-time proofSourceLive close
                  // above (Codex P2, PR #184) — the same belt-and-braces split
                  // as toggle + doMark: a tap queued before the closing render
                  // commits must not mark a captured target the current board
                  // no longer backs. Dead source → close only, write nothing.
                  if (!proofSourceLive(target)) return;
                  void doMark(target, true);
                }
          }
          onClose={() => setProofTarget(null)}
        />
      )}
      {tallyTarget && tallyTarget.itemId && (
        <TallySheet
          itemId={tallyTarget.itemId}
          itemText={tallyTarget.text}
          cellIndex={tallyTarget.index}
          meUid={uid}
          meName={identityKnown ? displayName : undefined}
          identityKnown={identityKnown}
          isSourceLive={isDoubtSourceLive}
          onClose={() => setTallyTarget(null)}
        />
      )}
      {/* The Reshuffle confirm (#378). `reshuffleOpen` can only be true while
          `reshuffleEligible` holds — the render-time close above enforces that —
          so uid/viewedDay/the counter are all non-null here by construction. */}
      {reshuffleOpen && uid && viewedDay && reshufflesUsed != null && (
        <ReshuffleSheet
          uid={uid}
          dayIndex={viewedDay.index}
          used={reshufflesUsed}
          expectedSeed={board.seed}
          onClose={() => setReshuffleOpen(false)}
        />
      )}
    </>
  );
}
