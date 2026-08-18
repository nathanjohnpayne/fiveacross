/**
 * Phase 1.5 finale CONTENT (issue #217, daily-cards-spec § "Scoring and social
 * surfaces" → "The finale—two-beat finish" / § "Farewell view").
 *
 * The scheduled finale TRIGGERS live in `unlockDay.ts` (#202): they decide WHEN
 * the two beats fire (`finaleActions`) and write the minimal Moment docs. This
 * module owns the CONTENT those triggers call into — the last-call standings copy
 * and the podium payload (cruise champion + cruise-wide First to BINGO + the ten
 * daily honors). Pure and injectable: no `firebase-admin`, no live backend, so
 * the whole thing is unit-testable without a Functions runtime (mirrors
 * `unlockDay.ts`'s decoupled-pure-decision posture).
 *
 * The ranking + tutorial-exclusion semantics MIRROR `src/game/logic.ts`'s
 * `comparePlayers` / `eventFirstBingoAt`. The app package and the functions
 * package are deliberately decoupled (the same split `autohide.ts` keeps from
 * `moderation.ts`), so this file re-states that logic locally rather than
 * importing across the package boundary. If the app's tie-break order or the
 * tutorial-exclusion rule ever changes, change it here too.
 */

import { isCeremonialDay } from './scoringVocab';
// Declaration-only shared contract (the daily-engagement-email precedent): the
// separately-rooted Functions compiler can consume `src/domainTypes.d.ts`
// without emitting an app file, so both the client mirror
// (src/data/mostLoved.ts) and this builder return the SAME named type.
import type { MostLovedPhotoAward, MostLovedPhotoWinner } from '../../src/domainTypes';

// --- Minimal domain shapes (local, package-decoupled) ---------------------------

/** One Day Card's contribution to a Player's cruise totals. */
export interface FinaleDayStat {
  bingoCount: number;
  squaresMarked: number;
  firstBingoAt: number | null;
}

/** The subset of a `PlayerDoc` the finale content reads. `bingoCount` /
 *  `squaresMarked` / `firstBingoAt` are the cruise-wide root AGGREGATES
 *  (`src/game/logic.ts` `aggregatePlayerStats`); `dayStats` is the per-Day
 *  breakdown the podium re-aggregates to exclude the ceremonial Days. */
export interface FinalePlayer {
  uid: string;
  displayName: string;
  bingoCount: number;
  squaresMarked: number;
  firstBingoAt: number | null;
  dayStats?: Record<number, FinaleDayStat>;
}

/** The subset of a `DayDef` the finale content reads. A Day is Tutorial only
 *  when its `tutorial` flag is set, and ceremonial only per its stated Scoring
 *  Policy; pool identity, Tutorial framing and Scoring Policy are three
 *  independent facts (ADR 0011). */
export interface FinaleDay {
  index: number;
  tutorial?: boolean;
  pool?: string; // 'main' | 'embark' | 'farewell'
  /** `'competitive' | 'ceremonial'`, absent on every doc written before ADR
   *  0011. Typed loosely because this side reads RAW Firestore maps; resolve it
   *  through `scoringForDay` (scoringVocab.ts), never by direct comparison. */
  scoring?: string;
}

/** One Day's pinned First to BINGO honor doc (`DayMetaDoc.firstBingo`), read from
 *  `events/{eventId}/days/{dayIndex}/meta/{dayIndex}`. `firstBingo` is absent
 *  until that Day has a bingo. */
export interface FinaleDayHonorDoc {
  dayIndex: number;
  firstBingo?: { uid: string; displayName: string; at: number } | null;
}

// --- Shared pure helpers (mirror src/game/logic.ts) -----------------------------

const RANK_ONLY_FIELDS = ['bingoCount', 'squaresMarked', 'firstBingoAt'] as const;
type Rankable = Pick<FinalePlayer, (typeof RANK_ONLY_FIELDS)[number]>;

/** Leaderboard order, byte-identical to `comparePlayers` in `src/game/logic.ts`:
 *  bingos desc, then squares desc, then earliest first-bingo; two no-bingo rows
 *  tie at exactly 0 (the explicit guard avoids `Infinity - Infinity = NaN`). */
export function compareFinalePlayers(a: Rankable, b: Rankable): number {
  if (b.bingoCount !== a.bingoCount) return b.bingoCount - a.bingoCount;
  if (b.squaresMarked !== a.squaresMarked) return b.squaresMarked - a.squaresMarked;
  if (a.firstBingoAt == null && b.firstBingoAt == null) return 0;
  const af = a.firstBingoAt ?? Number.POSITIVE_INFINITY;
  const bf = b.firstBingoAt ?? Number.POSITIVE_INFINITY;
  return af - bf;
}

/** The Tutorial Day indexes from an Event's schedule. The Event-wide First to
 *  BINGO honor excludes these Days.
 *
 *  MUST stay identical to `tutorialDayIndexSet` in `src/game/logic.ts`. The two
 *  packages are deliberately decoupled, so this is a mirror, not an import —
 *  and `tests/functions/finale-parity.test.ts` feeds one fixture schedule to
 *  both and asserts identical output, because a mirror without a parity test is
 *  how they drifted in the first place.
 *
 *  This previously ALSO excluded `pool === 'embark' | 'farewell'`, which the
 *  client never did. That was invisible on Gay Cruise Bingo, whose curated Days
 *  carry `tutorial: true` anyway — and wrong on any Event where a curated pool
 *  is competitive play. A Five Across Event opening on the easy pool with
 *  `tutorial: false` would have had the card credit a first bingo that the
 *  scheduler's podium excluded: two contradictory answers to "who was First to
 *  BINGO", one on the card and one in the Feed. Pool identity and Tutorial
 *  framing are independent (ADR 0011); only the flag belongs here. */
export function tutorialDayIndexes(days: readonly FinaleDay[] | undefined): Set<number> {
  const s = new Set<number>();
  for (const d of days ?? []) {
    if (d.tutorial === true) s.add(d.index);
  }
  return s;
}

/** The CEREMONIAL Day indexes — the Days whose Scoring Policy is `ceremonial`
 *  (ADR 0011). Their marks never move the standings, so the podium excludes
 *  them; on the cruise shape that Day unlocks AT the freeze, so its marks are
 *  all post-freeze anyway.
 *
 *  MUST stay identical to `ceremonialDayIndexSet` in `src/game/logic.ts`, and
 *  `tests/functions/finale-parity.test.ts` pins the two against one fixture
 *  schedule. This replaced a `farewellDayIndex` that resolved the FIRST
 *  closing-pool Day and excluded that one index: a set keyed on stated scoring
 *  keeps a competitive final morning in the standings, and stops a second
 *  ceremonial Day from silently counting. */
export function ceremonialDayIndexes(days: readonly FinaleDay[] | undefined): Set<number> {
  const s = new Set<number>();
  for (const d of days ?? []) {
    if (isCeremonialDay(d)) s.add(d.index);
  }
  return s;
}

/** A Player's EFFECTIVE Event-wide First to BINGO: the earliest `firstBingoAt`
 *  across non-Tutorial Days when the Player has a `dayStats` breakdown, else the
 *  legacy root `firstBingoAt` (a roster predating Day Cards carries no `dayStats`).
 *  Mirrors `effectiveCruiseFirstBingoAt` in `src/game/logic.ts`. */
function effectiveFirstBingoAt(
  player: Pick<FinalePlayer, 'firstBingoAt' | 'dayStats'>,
  isTutorialDay: (dayIndex: number) => boolean,
): number | null {
  const dayStats = player.dayStats;
  if (dayStats && Object.keys(dayStats).length > 0) {
    let earliest: number | null = null;
    for (const [key, stat] of Object.entries(dayStats)) {
      if (isTutorialDay(Number(key))) continue;
      if (stat.firstBingoAt == null) continue;
      if (earliest == null || stat.firstBingoAt < earliest) earliest = stat.firstBingoAt;
    }
    return earliest;
  }
  return player.firstBingoAt;
}

/** A Player's standings row for the podium, re-aggregated to EXCLUDE every
 *  CEREMONIAL Day (ADR 0011). When the Player has no `dayStats` breakdown (a
 *  legacy roster), or the schedule has no ceremonial Day at all, the root totals
 *  stand — there is nothing to exclude, and re-summing the buckets anyway would
 *  rewrite a legacy/hybrid row whose roots and buckets disagree.
 *
 *  Byte-identical to `podiumStandingRow` in `src/data/finale.ts`, including that
 *  empty-set passthrough — the parity test compares the two builders' output. */
function podiumStandingRow(
  player: FinalePlayer,
  ceremonial: ReadonlySet<number>,
  isTutorialDay: (dayIndex: number) => boolean,
): FinalePlayer {
  const firstBingoAt = effectiveFirstBingoAt(player, isTutorialDay);
  const dayStats = player.dayStats;
  if (!dayStats || ceremonial.size === 0) {
    return { ...player, firstBingoAt };
  }
  let bingoCount = 0;
  let squaresMarked = 0;
  for (const [key, stat] of Object.entries(dayStats)) {
    if (ceremonial.has(Number(key))) continue;
    bingoCount += stat.bingoCount;
    squaresMarked += stat.squaresMarked;
  }
  return { ...player, bingoCount, squaresMarked, firstBingoAt };
}

// --- Last-call standings copy ---------------------------------------------------

export interface LastCallOptions {
  /** The freeze-time phrase appended after the em dash. Injectable so a future
   *  event with a different disembark hour can override the default. */
  freezePhrase?: string;
}

/** The default freeze phrase, matching the spec's verbatim example
 *  ("…—standings freeze at 8 a.m."). */
// No trailing period — every template supplies the sentence's own full stop,
// so the rendered copy reads "…—standings freeze at 8 a.m." (single period,
// the spec's exact line), not the double-dotted "a.m.." the phrase-with-
// period produced (#266).
export const DEFAULT_FREEZE_PHRASE = 'standings freeze at 8 a.m';

/** The app's legacy-doc / malformed-value timezone default. Mirrors
 *  `DEFAULT_TIMEZONE` in `src/data/converters.ts`. */
export const DEFAULT_TIMEZONE = 'Europe/Rome';

/**
 * Resolve a persisted `timezone` to a usable IANA zone — a *real named* zone
 * ('Area/Location'), never an offset id ('+02:00'), a GMT/UTC/Etc alias, or a
 * bare abbreviation ('EST'), even though some runtimes' `Intl.DateTimeFormat`
 * will accept those. Mirrors `normalizeTimezone` in `src/data/converters.ts`
 * — restated here because the app and functions packages are deliberately
 * decoupled (ADR 0011); `tests/functions/timezone-normalize-parity.test.ts`
 * pins the two together.
 *
 * `runFinaleBeats` (`functions/src/unlockDay.ts`) reads the raw Firestore
 * Event doc directly, bypassing `eventConverter` — so WITHOUT this mirror, a
 * legacy Event doc missing `timezone` would format the freeze phrase in a
 * different zone than the client resolves through `eventConverter` (#800
 * Codex P2): exactly the two-rendering-paths-disagree bug this ticket exists
 * to fix, just moved one layer down. Falls back to `DEFAULT_TIMEZONE`
 * ('Europe/Rome') for anything invalid, matching `eventConverter`'s legacy
 * default.
 */
export function normalizeTimezone(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_TIMEZONE;
  const tz = raw.trim();
  if (/^[+-]\d/.test(tz) || /GMT|UTC|Etc\//i.test(tz) || !tz.includes('/')) {
    return DEFAULT_TIMEZONE;
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
    return canonical.includes('/') && !/GMT|UTC|Etc\//i.test(canonical) ? canonical : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * "8 a.m.", "11:30 p.m." — bare hour, minutes only off the hour, no trailing
 * period on the meridiem (the caller's own sentence supplies the final full
 * stop — see the `DEFAULT_FREEZE_PHRASE` note above, same reason). Mirrors the
 * clock-formatting rule in `src/unlockCopy.ts`'s `spokenHour`, restated here
 * because the app and functions packages are deliberately decoupled (ADR 0011).
 */
function spokenHour(unlockAt: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(new Date(unlockAt));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const minute = part('minute');
  const hour = part('hour');
  const meridiem = part('dayPeriod').toUpperCase().startsWith('P') ? 'p.m' : 'a.m';
  return `${hour}${minute === '00' ? '' : `:${minute}`} ${meridiem}`;
}

/**
 * "standings freeze at 8 a.m" — the Event's ACTUAL Standings Freeze, formatted
 * in the Event's timezone (#800). Both rendering paths that quote the freeze
 * time used to hardcode this as the literal "8 a.m." regardless of the
 * schedule; this is the one place that now derives it, so an Event that freezes
 * at, say, 11:00 announces "11 a.m.", not a copy-pasted 8. `runFinaleBeats`
 * (`functions/src/unlockDay.ts`) computes this once and writes it into the
 * `last_call` Moment's payload; `src/lastCallCopy.ts`'s client reconstruction
 * reads that same persisted string rather than reformatting the instant
 * itself, so the two rendering paths cannot drift apart.
 *
 * WHICH INSTANT (#800 landed before ADR 0011, #551, and the answer changed).
 * The argument is the RESOLVED Standings Freeze — `times.standingsFreezeAt`,
 * which is the configured `EventDoc.standingsFreezeAt` when the doc carries a
 * usable one and the first ceremonial Day's `unlockAt` otherwise. It was
 * originally the closing Day's unlock, and for both live Events those are the
 * same instant to the millisecond (Bodega pins `standingsFreezeAt ==
 * days[3].unlockAt`), so no shipped copy changes. It matters for the shape ADR
 * 0011 exists for: an Event whose final morning plays competitively until an
 * 11:00 check-out has NO closing-Day unlock that equals its freeze, and the
 * copy must quote the freeze the standings actually observe — otherwise this
 * function would confidently announce the wrong deadline, which is exactly the
 * bug #800 closed, one layer up. The parameter is named for the concept rather
 * than the Day for that reason; the exported name is kept as-is so #800's own
 * tests and call sites are untouched.
 *
 * `timeZone` is passed through `normalizeTimezone` first (#800 Codex P2): a
 * missing/malformed value resolves to `DEFAULT_TIMEZONE` ('Europe/Rome'), the
 * SAME legacy default `eventConverter` applies client-side, not UTC — a raw
 * Firestore Event doc read here (bypassing the converter) must still land on
 * the zone the client would resolve to. Falls back to `DEFAULT_FREEZE_PHRASE`
 * when the instant is missing/non-finite or formatting still throws, so a
 * malformed schedule degrades to the historical literal rather than crashing
 * the finale beat.
 */
export function freezePhraseForUnlock(freezeAt: number | undefined, timeZone: string | undefined): string {
  if (typeof freezeAt !== 'number' || !Number.isFinite(freezeAt)) {
    return DEFAULT_FREEZE_PHRASE;
  }
  try {
    return `standings freeze at ${spokenHour(freezeAt, normalizeTimezone(timeZone))}`;
  } catch {
    return DEFAULT_FREEZE_PHRASE;
  }
}

/**
 * The going-into-the-final-night last-call line posted at 20:00 on Day 9. Names
 * the current leader and their margin over the runner-up — by bingos when they
 * lead on bingos, else by squares when the bingos tie — degrading gracefully:
 *
 *   - an empty board (nobody has marked anything) → a generic "wide open" line;
 *   - a solo leader (only one Player) → a "board to themselves" line;
 *   - a dead heat at the top (leader and runner-up tie on bingos AND squares) →
 *     a generic "neck and neck" line.
 *
 * Ranks by the players' cruise-wide root aggregates — at 20:00 Day 9 the farewell
 * Day has not unlocked, so no ceremonial exclusion is needed. Em dashes take no
 * surrounding spaces (CMOS), matching the spec's example.
 */
export function lastCallStandingsCopy(
  players: readonly FinalePlayer[],
  opts: LastCallOptions = {},
): string {
  const freeze = opts.freezePhrase ?? DEFAULT_FREEZE_PHRASE;
  const ranked = [...players].sort(compareFinalePlayers);
  const leader = ranked[0];

  if (!leader || (leader.bingoCount === 0 && leader.squaresMarked === 0)) {
    return `The board's wide open going into the final night—${freeze}.`;
  }
  const runnerUp = ranked[1];
  if (!runnerUp) {
    return `${leader.displayName} has the board to themselves going into the final night—${freeze}.`;
  }

  const bingoMargin = leader.bingoCount - runnerUp.bingoCount;
  if (bingoMargin > 0) {
    return `${leader.displayName} leads by ${bingoMargin} bingo${bingoMargin === 1 ? '' : 's'}—${freeze}.`;
  }
  const squareMargin = leader.squaresMarked - runnerUp.squaresMarked;
  if (squareMargin > 0) {
    return `${leader.displayName} leads by ${squareMargin} square${squareMargin === 1 ? '' : 's'}—${freeze}.`;
  }
  return `It's neck and neck at the top going into the final night—${freeze}.`;
}

// --- Podium payload -------------------------------------------------------------

export interface PodiumChampion {
  uid: string;
  displayName: string;
  bingoCount: number;
  squaresMarked: number;
}
export interface PodiumFirstBingo {
  uid: string;
  displayName: string;
  at: number;
}
export interface PodiumHonor {
  dayIndex: number;
  uid: string;
  displayName: string;
  at: number;
}
export interface PodiumPayload {
  /** Top of the frozen standings (ceremonial Days excluded); `null` on an empty board. */
  champion: PodiumChampion | null;
  /** Event-wide First to BINGO across non-Tutorial Days; `null` when none qualifies. */
  firstBingo: PodiumFirstBingo | null;
  /** Each Day's pinned First to BINGO, sorted by Day index (present honors only). */
  dailyHonors: PodiumHonor[];
}

/**
 * Build the podium payload posted at the 08:00 Day 10 freeze:
 *
 *   - champion: the top of the standings re-aggregated to EXCLUDE every ceremonial Day
 *     (its marks are all post-freeze and ceremonial), `null` when nobody has played;
 *   - firstBingo: the Event-wide First to BINGO, non-Tutorial Days only — pool
 *     identity alone never decides the headline honor;
 *   - dailyHonors: the ten Days' own pinned First to BINGO honors, straight from the
 *     `meta.firstBingo` docs, sorted by Day index (a Day with no bingo is omitted).
 */
export function buildPodiumPayload(
  players: readonly FinalePlayer[],
  days: readonly FinaleDay[] | undefined,
  dayHonors: readonly FinaleDayHonorDoc[] = [],
): PodiumPayload {
  const tutorial = tutorialDayIndexes(days);
  const isTutorialDay = (i: number): boolean => tutorial.has(i);
  const ceremonial = ceremonialDayIndexes(days);

  const standings = players
    .map((p) => podiumStandingRow(p, ceremonial, isTutorialDay))
    .sort(compareFinalePlayers);
  const top = standings[0];
  const champion: PodiumChampion | null =
    top && (top.bingoCount > 0 || top.squaresMarked > 0)
      ? {
          uid: top.uid,
          displayName: top.displayName,
          bingoCount: top.bingoCount,
          squaresMarked: top.squaresMarked,
        }
      : null;

  let firstBingo: PodiumFirstBingo | null = null;
  for (const p of players) {
    const at = effectiveFirstBingoAt(p, isTutorialDay);
    if (at == null) continue;
    if (!firstBingo || at < firstBingo.at) {
      firstBingo = { uid: p.uid, displayName: p.displayName, at };
    }
  }

  const dailyHonors: PodiumHonor[] = dayHonors
    .filter((h): h is FinaleDayHonorDoc & { firstBingo: NonNullable<FinaleDayHonorDoc['firstBingo']> } =>
      h.firstBingo != null,
    )
    .map((h) => ({
      dayIndex: h.dayIndex,
      uid: h.firstBingo.uid,
      displayName: h.firstBingo.displayName,
      at: h.firstBingo.at,
    }))
    .sort((a, b) => a.dayIndex - b.dayIndex);

  return { champion, firstBingo, dailyHonors };
}

// --- Most-Loved Photo award (#534/#560, specs/most-loved-photo.md) --------------

/** The subset of a `ProofDoc` the award computation reads (local minimal shape,
 *  package-decoupled like every other input in this file). */
export interface MostLovedProofLike {
  id: string;
  uid: string;
  displayName: string;
  type: string;
  status: string;
  reportCount: number;
  createdAt: number;
  itemText: string;
  dayIndex?: number | null;
}

/** The subset of a `HeartDoc` the award computation reads. */
export interface MostLovedHeartLike {
  uid: string;
  targetKind: string;
  targetId: string;
  targetCreatedAt: number;
  createdAt: number;
  /** Firestore's server-assigned document creation instant. Optional only so
   *  the client parity fixture can model the same pure rule without importing
   *  Admin SDK snapshot types; scheduler input always supplies it. */
  serverCreatedAt?: number;
}

/**
 * A Proof's frozen attribution is bounded by the write target, not by the
 * number of eligible photos. Firestore permits a 1 MiB document; retaining an
 * unbounded tie list would make the freeze retry forever once that limit is
 * crossed. The ordered prefix is deterministic and `winnerCount` preserves the
 * full cardinality for callers that need to describe the tie.
 */
export const MAX_PERSISTED_MOST_LOVED_WINNERS = 100;

/** Local mirror of `src/data/moderation.ts`'s `isReportHidden` (this module
 *  stays decoupled from the app package, like `autohide.ts`/`unlockDay.ts`).
 *  True iff `reportCount` has REACHED a POSITIVE threshold; fails OPEN for a
 *  missing/non-positive/NaN threshold. */
function mostLovedReportHidden(reportCount: number, threshold: number | undefined): boolean {
  return typeof threshold === 'number' && threshold > 0 && reportCount >= threshold;
}

/** Local mirror of `src/data/moderation.ts`'s `isBanned`. True iff `uid` is on
 *  the roster; fails OPEN for a missing/malformed roster. */
function mostLovedBanned(uid: string | undefined, bannedUids: readonly string[] | undefined): boolean {
  return !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid);
}

/**
 * Build the frozen Most-Loved Photo award (#560): the visible,
 * moderation-eligible photo Proof holding the most eligible Hearts at the
 * standings freeze. Pure and injectable — the scheduler beat in `unlockDay.ts`
 * feeds it plain collection reads; `src/data/mostLoved.ts` mirrors it verbatim
 * and `tests/functions/most-loved-parity.test.ts` pins the two against one
 * fixture set (a mirror without a parity test is how mirrors drift).
 *
 * Eligibility, rule by rule (the 2026-08-04 verbatim decisions):
 *
 *   - an eligible PROOF is a photo (`type === 'photo'`) passing the Feed's
 *     exact visibility filter (`useProofFeed`, src/hooks/useData.ts): `status
 *     === 'active'` (excludes hidden/pending/flagged; deleted docs are absent
 *     from the read set by construction), NOT report-hidden (fail-open
 *     threshold, mirror of `isReportHidden`), owner not banned;
 *   - an eligible HEART targets that proof (`targetKind === 'proof'`,
 *     `targetId`), matches its incarnation (`targetCreatedAt ===
 *     proof.createdAt`, the `heartState` rule), was committed at or before the
 *     freeze cutoff (Firestore `createTime <= cutoff` — the SCHEDULED instant, never the run
 *     clock), is NOT the owner's own heart (`h.uid !== proof.uid` — new logic:
 *     `heartState` deliberately counts self-hearts for display and that stays
 *     unchanged), and is NOT from a banned Player — UNCONDITIONALLY:
 *     `heartState`'s own-content exception (a banned viewer still sees their
 *     own heart) is display-only and does NOT apply to the award;
 *   - the count is the number of UNIQUE eligible heart uids per proof (the
 *     deterministic slot id already guarantees one doc per pair; the Set makes
 *     this total over arbitrary fixtures);
 *   - winners are the first 100 eligible proofs at the maximum count when that
 *     maximum is >= 1, ordered `proofCreatedAt` asc then `proofId` asc (total,
 *     deterministic; `winners[0]` is the share hero); `winnerCount` retains
 *     the complete tied cardinality without an unbounded Event payload;
 *   - zero eligible hearts (or zero eligible photo proofs) persists the
 *     EXPLICIT no-award record `{ winners: [], heartCount: 0 }` — field
 *     absence must keep meaning "not yet computed" (the write-once guard's
 *     idempotence key), so "computed, none" needs its own frozen state.
 *
 * Winner entries are built entirely from the winning proof's own denormalized
 * fields — no roster join, and NO media fields on purpose: display always
 * re-joins the live Proof doc, so a later-hidden photo can never render from a
 * stale stored URL.
 */
export function buildMostLovedPhotoAward(
  proofs: readonly MostLovedProofLike[],
  hearts: readonly MostLovedHeartLike[],
  opts: {
    bannedUids: readonly string[];
    reportHideThreshold: number | undefined;
    cutoff: number;
    computedAt: number;
  },
): MostLovedPhotoAward {
  const eligible = proofs.filter(
    (p) =>
      p.type === 'photo' &&
      p.status === 'active' &&
      !mostLovedReportHidden(p.reportCount, opts.reportHideThreshold) &&
      !mostLovedBanned(p.uid, opts.bannedUids),
  );
  const byId = new Map<string, MostLovedProofLike>();
  const heartUids = new Map<string, Set<string>>();
  for (const p of eligible) {
    byId.set(p.id, p);
    heartUids.set(p.id, new Set());
  }
  for (const h of hearts) {
    if (h.targetKind !== 'proof') continue;
    const p = byId.get(h.targetId);
    if (!p) continue;
    if (h.targetCreatedAt !== p.createdAt) continue; // another incarnation's heart
    // Firestore's server creation time, not the client-set `createdAt`, is the
    // freeze boundary. Rules allow a bounded clock-skew window for createdAt,
    // so a delayed sweep could otherwise accept a post-freeze heart backdated
    // into that window. The pure client fixture has no Admin snapshot metadata
    // and falls back to createdAt; scheduler input always carries serverCreatedAt.
    const heartAt = h.serverCreatedAt ?? h.createdAt;
    if (!Number.isFinite(heartAt) || heartAt > opts.cutoff) continue;
    if (h.uid === p.uid) continue; // own heart on own proof does NOT count
    if (mostLovedBanned(h.uid, opts.bannedUids)) continue; // no own-content exception here
    heartUids.get(p.id)!.add(h.uid);
  }
  let max = 0;
  for (const uids of heartUids.values()) {
    if (uids.size > max) max = uids.size;
  }
  const allWinners: MostLovedPhotoWinner[] =
    max < 1
      ? []
      : eligible
          .filter((p) => heartUids.get(p.id)!.size === max)
          .map((p) => ({
            proofId: p.id,
            uid: p.uid,
            displayName: p.displayName,
            promptText: p.itemText,
            dayIndex: p.dayIndex ?? null,
            proofCreatedAt: p.createdAt,
          }))
          .sort(
            (a, b) =>
              a.proofCreatedAt - b.proofCreatedAt ||
              (a.proofId < b.proofId ? -1 : a.proofId > b.proofId ? 1 : 0),
          );
  return {
    winners: allWinners.slice(0, MAX_PERSISTED_MOST_LOVED_WINNERS),
    winnerCount: allWinners.length,
    heartCount: max < 1 ? 0 : max,
    frozenAt: opts.cutoff,
    computedAt: opts.computedAt,
  };
}
