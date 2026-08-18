// Client-side finale computation (#217, daily-cards-spec § "Scoring and social
// surfaces" → "The finale—two-beat finish" / § "Farewell view"). Pure and
// framework-free, so the podium + default-view rules are unit-testable without
// mounting a component. The functions-side mirror (functions/src/finaleContent.ts)
// posts the SAME podium as a Moment; this module is what the farewell VIEW renders.
import type { DayDef, DayMetaDoc, PlayerDoc } from '../types';
import {
  ceremonialDayIndexSet,
  comparePlayers,
  rankingExcludedDay,
  standingsFreezeAtFor,
  cruiseFirstBingoUid,
  effectiveCruiseFirstBingoAt,
  perDayHonors,
  tutorialDayIndexSet,
  type DayHonor,
  type Rankable,
} from '../game/logic';

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
export interface Podium {
  /** Top of the frozen standings (ceremonial Days excluded); `null` on an empty board. */
  champion: PodiumChampion | null;
  /** Cruise-wide First to BINGO across main-game Days; `null` when none qualifies. */
  firstBingo: PodiumFirstBingo | null;
  /** Each Day's pinned First to BINGO, sorted by Day index (present honors only). */
  dailyHonors: DayHonor[];
  /**
   * Standings rows 2-3 (#534/#561): the photo-hero share composition compresses
   * the podium to ranked rows, so it needs the two runners-up the champion-only
   * payload never carried. Same zero-activity guard as the champion (a row with
   * no marks is not a rank). CLIENT-ONLY — the functions-side `PodiumPayload`
   * and the podium Moment are NOT touched, so nothing served changes.
   */
  runnersUp: PodiumChampion[];
}

/**
 * A Player's standings row for the podium, re-aggregated to EXCLUDE every
 * CEREMONIAL Day (ADR 0011). A ceremonial Day Card's marks never move the
 * standings — on the cruise shape that card unlocks AT the freeze, so its marks
 * are all post-freeze — and they must never move the frozen podium (the
 * "standings shown are as of `frozenAt`, not live" rule).
 *
 * Keyed off the Day's stated Scoring Policy rather than its pool, so a weekend
 * Event whose final morning is real competitive play keeps that morning's marks
 * in the podium, and a schedule with no ceremonial Day at all excludes nothing.
 * A Player with no `dayStats` breakdown (a roster predating Day Cards) keeps its
 * root totals, and so does every Player when the schedule has NO ceremonial Day:
 * in both cases there is nothing to exclude, and re-summing the buckets anyway
 * would silently rewrite a legacy/hybrid row whose roots and buckets disagree
 * (the state `playerRowRootLag` exists to detect) instead of leaving it alone.
 * `firstBingoAt` is the tutorial-excluded Event-wide value so the row ranks on
 * the same first-bingo tie-break the Leaderboard uses.
 */
function podiumStandingRow(
  player: PlayerDoc,
  ceremonial: ReadonlySet<number>,
  isTutorialDay: (dayIndex: number) => boolean,
  withinFreeze: (at: number | null) => number | null,
): Rankable & { uid: string; displayName: string } {
  // RANKING first-bingo: Tutorial OR ceremonial (ADR 0011). `comparePlayers`
  // breaks ties on this timestamp, so leaving ceremonial Days in would let a
  // ceremonial Mark decide the podium while its bingos and squares are being
  // excluded two lines below. The First to BINGO HONOUR keeps its own
  // tutorial-only value — different question, different exclusion.
  const firstBingoAt = withinFreeze(
    effectiveCruiseFirstBingoAt(player, rankingExcludedDay(isTutorialDay, (i) => ceremonial.has(i))),
  );
  const dayStats = player.dayStats;
  if (!dayStats || ceremonial.size === 0) {
    return {
      uid: player.uid,
      displayName: player.displayName,
      bingoCount: player.bingoCount,
      squaresMarked: player.squaresMarked,
      firstBingoAt,
    };
  }
  let bingoCount = 0;
  let squaresMarked = 0;
  for (const [key, stat] of Object.entries(dayStats)) {
    if (ceremonial.has(Number(key))) continue;
    bingoCount += stat.bingoCount;
    squaresMarked += stat.squaresMarked;
  }
  return { uid: player.uid, displayName: player.displayName, bingoCount, squaresMarked, firstBingoAt };
}

/**
 * The podium the farewell view renders: cruise champion (top of the standings,
 * ceremonial Days excluded), Event-wide First to BINGO (main-game Days only), and
 * the per-Day honors strip. Computed from the live `PlayerDoc` aggregates + the
 * per-Day `dayStats`, with the farewell Day frozen out so a post-freeze goodbye
 * mark never changes who is on the podium.
 */
function pinnedOrDerivedDailyHonors(
  players: readonly PlayerDoc[],
  days: readonly DayDef[] | undefined,
  dayMetas: ReadonlyMap<number, DayMetaDoc> | undefined,
  dayMetasLoaded: boolean,
): DayHonor[] {
  const derivedHonors = perDayHonors(players);
  if (!days?.length || !dayMetas) return derivedHonors;
  const visibleUids = new Set(players.map((p) => p.uid));
  return days.flatMap((day) => {
    const pinned = dayMetas.get(day.index)?.firstBingo;
    if (pinned) {
      if (!visibleUids.has(pinned.uid)) return [];
      return [
        {
          dayIndex: day.index,
          uid: pinned.uid,
          displayName: pinned.displayName,
          firstBingoAt: pinned.at,
        },
      ];
    }
    if (!dayMetasLoaded) return [];
    const derived = derivedHonors.find((h) => h.dayIndex === day.index);
    return derived ? [derived] : [];
  });
}

export function buildPodium(
  players: readonly PlayerDoc[],
  days: readonly DayDef[] | undefined,
  dayMetas?: ReadonlyMap<number, DayMetaDoc>,
  dayMetasLoaded = true,
  freezeAt?: number | null,
): Podium {
  // The podium is "as of the freeze", not live (Phase 4b P1). This module reads
  // the LIVE roster, and a ceremonial Day deliberately keeps recording Marks
  // after the freeze — its bucket is retained so its own daily honour still
  // renders. Without a cutoff those post-freeze Marks can mint a First to BINGO
  // the scheduler's already-posted, immutable podium Moment does not have: a
  // Player whose only bingo lands after the freeze on a ceremonial,
  // `tutorial: false` Day would appear on the card while the Feed shows none.
  // The card and the Feed must not name different winners — that is the same
  // class of split ADR 0011 was written to close.
  //
  // `null`/absent means no cutoff, which is what every pre-freeze render wants.
  const withinFreeze = (at: number | null): number | null =>
    at != null && freezeAt != null && at > freezeAt ? null : at;
  const tutorial = tutorialDayIndexSet(days);
  const isTutorialDay = (i: number): boolean => tutorial.has(i);
  const ceremonial = ceremonialDayIndexSet(days);

  const standings = players
    .map((p) => podiumStandingRow(p, ceremonial, isTutorialDay, withinFreeze))
    .sort(comparePlayers);
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

  // Ranks 2-3 from the SAME sorted standings the champion came from — never a
  // re-sort — with the champion's own zero-activity guard applied per row (the
  // sort puts zero-activity rows last, so a filtered row can only ever be
  // trailing; ranks never skip).
  const runnersUp: PodiumChampion[] = standings
    .slice(1, 3)
    .filter((r) => r.bingoCount > 0 || r.squaresMarked > 0)
    .map((r) => ({
      uid: r.uid,
      displayName: r.displayName,
      bingoCount: r.bingoCount,
      squaresMarked: r.squaresMarked,
    }));

  // Re-derived here rather than via `cruiseFirstBingoUid` so the freeze cutoff
  // applies to the SELECTION as well as the reported instant — picking the
  // winner from uncut data and then blanking their timestamp would report no
  // First to BINGO at all while an eligible pre-freeze one existed.
  let firstBingo: PodiumFirstBingo | null = null;
  for (const p of players) {
    const at = withinFreeze(effectiveCruiseFirstBingoAt(p, isTutorialDay));
    if (at == null) continue;
    if (!firstBingo || at < firstBingo.at) {
      firstBingo = { uid: p.uid, displayName: p.displayName, at };
    }
  }

  return {
    champion,
    firstBingo,
    dailyHonors: pinnedOrDerivedDailyHonors(players, days, dayMetas, dayMetasLoaded),
    runnersUp,
  };
}

/**
 * The default-view pin once the Event has ended: the ARRAY index (the position
 * Board indexes `days[viewedIndex]` by) of the Day the finale lives on, once
 * `frozenAt` is set AND that Day is unlocked. Returns `null` before the freeze —
 * or while the target Day is still locked, or when there are no Days — so the
 * caller falls back to the normal "today" default. Never pins early.
 *
 * The target is the first CEREMONIAL Day when the schedule has one (the cruise
 * shape: the goodbye card the podium banner mounts on), else the LAST Day (ADR
 * 0011). An Event whose final morning is competitive play has no ceremonial card
 * to pin, and pinning nothing would drop a returning Player onto "today" — which
 * after the Event has ended is a Day that no longer exists in the schedule. The
 * last Day is where the podium is posted in that shape, so it is where the
 * podium should be read.
 *
 * Renamed from `farewellPinIndex`: the pin follows the Scoring Policy and the
 * schedule's end, not the closing pool, and a `farewell`-named helper in a
 * finale path is now exactly the kind of pool-inference ADR 0011 removed.
 */
export function finalePinIndex(
  days: readonly DayDef[] | undefined,
  frozenAt: number | null | undefined,
  now: number,
  standingsFreezeAt?: number,
): number | null {
  if (frozenAt == null) return null;
  const idx = finaleDayIndex(days, standingsFreezeAtFor({ frozenAt, days: [...(days ?? [])], standingsFreezeAt }));
  if (idx < 0) return null;
  if ((days ?? [])[idx].unlockAt > now) return null;
  return idx;
}

/**
 * The ARRAY index of the Day the finale lives on: the LAST Day still open at the
 * Event's Standings Freeze. `-1` when there are no Days.
 *
 * One answer, read by the default-view pin (`finalePinIndex`) and the podium's
 * mount gate in `Board.tsx`. Those two used to disagree by construction — the
 * pin resolved the closing Day while the mount re-inferred it from
 * `viewedDay.pool === 'closing'` — so an Event stating a ceremonial Day on some
 * other pool, or none at all, would pin a returning Player to a Day that then
 * rendered no podium and no share action (Codex P1).
 *
 * KEYED ON THE FREEZE, not on the first ceremonial Day (Phase 4b P1). Those
 * coincide whenever the freeze is derived — the derived freeze IS that Day's
 * unlock, so it is the last Day open at it — but they come apart the moment a
 * freeze is configured. A schedule with an EARLY ceremonial Day, later
 * competitive Days, and an end-of-Event freeze would otherwise file the podium
 * on the early Day and derive last call from ITS predecessor, stranding the
 * finale in the middle of an Event that was still being played. A Day's Scoring
 * Policy says whether its Marks count; it does not elect the finale's host.
 * `functions/src/unlockDay.ts` resolves `podiumDayIndex` by the same rule.
 */
export function finaleDayIndex(
  days: readonly DayDef[] | undefined,
  freezeAt: number | null | undefined,
): number {
  const arr = days ?? [];
  if (arr.length === 0) return -1;
  if (freezeAt == null) return arr.length - 1;
  // The LAST Day open at the freeze. One rule, and it subsumes the case that
  // used to be special: when nothing is configured the freeze IS the first
  // ceremonial Day's unlock, so that Day is the last one open at it and the
  // answer is unchanged for both live Events.
  let best = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].unlockAt <= freezeAt) best = i;
  }
  // A freeze before EVERY Day opens is a misconfiguration rather than a shape;
  // host the finale on the first Day so the podium still lands somewhere.
  return best >= 0 ? best : 0;
}
