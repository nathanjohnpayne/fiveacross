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
 *  breakdown the podium re-aggregates to exclude the ceremonial farewell Day. */
export interface FinalePlayer {
  uid: string;
  displayName: string;
  bingoCount: number;
  squaresMarked: number;
  firstBingoAt: number | null;
  dayStats?: Record<number, FinaleDayStat>;
}

/** The subset of a `DayDef` the finale content reads. A Day is Tutorial only
 *  when its `tutorial` flag is set; pool identity and Tutorial framing are
 *  independent. */
export interface FinaleDay {
  index: number;
  tutorial?: boolean;
  pool?: string; // 'main' | 'embark' | 'farewell'
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

/** The farewell Day's `index`, or `-1` when the schedule has none (a non-Phase-1.5
 *  event). The farewell Day unlocks AT the freeze, so its marks are all post-freeze
 *  and must never move the frozen standings — the podium excludes this Day. */
export function farewellDayIndex(days: readonly FinaleDay[] | undefined): number {
  const f = (days ?? []).find((d) => d.pool === 'farewell');
  return f ? f.index : -1;
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

/** A Player's standings row for the podium, re-aggregated to EXCLUDE the farewell
 *  Day (the ceremonial-freeze rule). When the Player has no `dayStats` breakdown
 *  (a legacy roster) the root totals stand — there is nothing to exclude. */
function podiumStandingRow(
  player: FinalePlayer,
  farewellIndex: number,
  isTutorialDay: (dayIndex: number) => boolean,
): FinalePlayer {
  const firstBingoAt = effectiveFirstBingoAt(player, isTutorialDay);
  const dayStats = player.dayStats;
  if (!dayStats || farewellIndex < 0) {
    return { ...player, firstBingoAt };
  }
  let bingoCount = 0;
  let squaresMarked = 0;
  for (const [key, stat] of Object.entries(dayStats)) {
    if (Number(key) === farewellIndex) continue;
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
  /** Top of the frozen standings (farewell Day excluded); `null` on an empty board. */
  champion: PodiumChampion | null;
  /** Event-wide First to BINGO across non-Tutorial Days; `null` when none qualifies. */
  firstBingo: PodiumFirstBingo | null;
  /** Each Day's pinned First to BINGO, sorted by Day index (present honors only). */
  dailyHonors: PodiumHonor[];
}

/**
 * Build the podium payload posted at the 08:00 Day 10 freeze:
 *
 *   - champion: the top of the standings re-aggregated to EXCLUDE the farewell Day
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
  const farewellIndex = farewellDayIndex(days);

  const standings = players
    .map((p) => podiumStandingRow(p, farewellIndex, isTutorialDay))
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
