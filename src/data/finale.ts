// Client-side finale computation (#217, daily-cards-spec § "Scoring and social
// surfaces" → "The finale—two-beat finish" / § "Farewell view"). Pure and
// framework-free, so the podium + default-view rules are unit-testable without
// mounting a component. The functions-side mirror (functions/src/finaleContent.ts)
// posts the SAME podium as a Moment; this module is what the farewell VIEW renders.
import type { DayDef, DayMetaDoc, PlayerDoc } from '../types';
import { normalizePool } from '../game/pool';
import {
  comparePlayers,
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
  /** Top of the frozen standings (farewell Day excluded); `null` on an empty board. */
  champion: PodiumChampion | null;
  /** Cruise-wide First to BINGO across main-game Days; `null` when none qualifies. */
  firstBingo: PodiumFirstBingo | null;
  /** Each Day's pinned First to BINGO, sorted by Day index (present honors only). */
  dailyHonors: DayHonor[];
}

/** The farewell Day's `DayDef.index`, or `-1` when the schedule has none. */
function farewellDayIndex(days: readonly DayDef[] | undefined): number {
  const f = (days ?? []).find((d) => normalizePool(d.pool) === 'closing');
  return f ? f.index : -1;
}

/**
 * A Player's standings row for the podium, re-aggregated to EXCLUDE the farewell
 * Day. The farewell Day Card unlocks AT the freeze, so its marks are all
 * post-freeze and ceremonial — they must never move the frozen podium (the
 * "standings shown are as of `frozenAt`, not live" rule). A Player with no
 * `dayStats` breakdown (a roster predating Day Cards) keeps its root totals —
 * there is nothing to exclude. `firstBingoAt` is the tutorial-excluded cruise
 * value so the row ranks on the same first-bingo tie-break the Leaderboard uses.
 */
function podiumStandingRow(
  player: PlayerDoc,
  farewellIndex: number,
  isTutorialDay: (dayIndex: number) => boolean,
): Rankable & { uid: string; displayName: string } {
  const firstBingoAt = effectiveCruiseFirstBingoAt(player, isTutorialDay);
  const dayStats = player.dayStats;
  if (!dayStats || farewellIndex < 0) {
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
    if (Number(key) === farewellIndex) continue;
    bingoCount += stat.bingoCount;
    squaresMarked += stat.squaresMarked;
  }
  return { uid: player.uid, displayName: player.displayName, bingoCount, squaresMarked, firstBingoAt };
}

/**
 * The podium the farewell view renders: cruise champion (top of the standings,
 * farewell Day excluded), cruise-wide First to BINGO (main-game Days only), and
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
): Podium {
  const tutorial = tutorialDayIndexSet(days);
  const isTutorialDay = (i: number): boolean => tutorial.has(i);
  const farewellIndex = farewellDayIndex(days);

  const standings = players
    .map((p) => podiumStandingRow(p, farewellIndex, isTutorialDay))
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

  const firstUid = cruiseFirstBingoUid(players, isTutorialDay);
  const firstPlayer = firstUid ? players.find((p) => p.uid === firstUid) : undefined;
  const firstAt = firstPlayer ? effectiveCruiseFirstBingoAt(firstPlayer, isTutorialDay) : null;
  const firstBingo: PodiumFirstBingo | null =
    firstPlayer && firstAt != null
      ? { uid: firstPlayer.uid, displayName: firstPlayer.displayName, at: firstAt }
      : null;

  return { champion, firstBingo, dailyHonors: pinnedOrDerivedDailyHonors(players, days, dayMetas, dayMetasLoaded) };
}

/**
 * The default-view pin once the cruise has ended: the farewell Day's ARRAY index
 * (the position Board indexes `days[viewedIndex]` by) once `frozenAt` is set AND
 * the farewell Day is unlocked. Returns `null` before the freeze — or when the
 * farewell Day is somehow still locked, or absent — so the caller falls back to
 * the normal "today" default. Never pins the farewell view early.
 */
export function farewellPinIndex(
  days: readonly DayDef[] | undefined,
  frozenAt: number | null | undefined,
  now: number,
): number | null {
  if (frozenAt == null) return null;
  const arr = days ?? [];
  const idx = arr.findIndex((d) => normalizePool(d.pool) === 'closing');
  if (idx < 0) return null;
  if (arr[idx].unlockAt > now) return null;
  return idx;
}
