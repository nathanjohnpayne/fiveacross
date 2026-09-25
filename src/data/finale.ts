// Client-side finale computation (#217, daily-cards-spec § "Scoring and social
// surfaces" → "The finale—two-beat finish" / § "Farewell view"). Pure and
// framework-free, so the podium + default-view rules are unit-testable without
// mounting a component. The functions-side mirror (functions/src/finaleContent.ts)
// posts the SAME podium as a Moment; this module is what the farewell VIEW renders.
import type { DayDef, DayMetaDoc, PlayerDoc } from '../types';
import { isBanned, isHiddenFor, withBlockExclusions } from './moderation';
import { clampReaggregatedTotal, supportedDayIndex } from './eventLimits';
import { THEMES } from '../theme/themes';
import {
  ceremonialDayIndexSet,
  comparePlayers,
  eventFirstBingoWinner,
  rankingExcludedDay,
  standingsFreezeAtFor,
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

/**
 * One standings row as a POSITION: its 1-based place among the rows a reader can
 * actually see. NOT an honour — see `withholdBannedHonours` for the distinction
 * and `specs/w2-leaderboard.md` § Design decisions for the rule.
 */
export interface PodiumStandingRow extends PodiumChampion {
  rank: number;
}

/** How many standings positions the podium's share composition prints — the
 *  three the photo-hero card's compressed rows have room for (#534/#561). */
export const PODIUM_STANDING_ROWS = 3;

export interface Podium {
  /** Top of the frozen standings (ceremonial Days excluded); `null` on an empty
   *  board, and `null` when its holder is currently banned — the HONOUR is
   *  withheld rather than handed down (`withholdBannedHonours`). Neither `null`
   *  is the empty-board fact: an Event whose only play was ceremonial has no
   *  ranking-eligible champion and was still played — see `playRecorded`. */
  champion: PodiumChampion | null;
  /** Cruise-wide First to BINGO across main-game Days; `null` when none
   *  qualifies, and `null` when its holder is currently banned. */
  firstBingo: PodiumFirstBingo | null;
  /** Each Day's pinned First to BINGO, sorted by Day index (present honors
   *  only), with a currently-banned holder's Day withheld, and, beside a frozen
   *  `frozenPlayRecorded: false`, every honour pinned at or after `freezeAt`
   *  dropped (#1263, `frozenEmptyHonourFilter`). */
  dailyHonors: DayHonor[];
  /**
   * The top `PODIUM_STANDING_ROWS` POSITIONS, numbered 1..n over the rows a
   * reader can see (#534/#561): the photo-hero share composition compresses the
   * podium to ranked rows, so it needs more than the champion-only payload ever
   * carried. Same zero-activity guard as the champion (a row with no marks is
   * not a rank), and a banned row is absent, so the numbering closes over it.
   *
   * CLIENT-ONLY — the functions-side `PodiumPayload` and the podium Moment are
   * NOT touched, so nothing served changes.
   */
  standings: PodiumStandingRow[];
  /**
   * Whether ANY Marks were recorded across the Event — the "did anybody play"
   * fact, stated rather than inferred from `champion` (#1192). Mirror of
   * `PodiumPayload.playRecorded` (`functions/src/finaleContent.ts`), pinned
   * against it by `tests/functions/finale-parity.test.ts`.
   *
   * NO CLIENT SURFACE READS IT YET, and it is carried anyway. The consumer that
   * needs it is the winner-announcement email, which reads the functions-side
   * payload off the Moment — but the two builders are a mirror, and the reason
   * this mirror has a parity test at all is that they once drifted invisibly.
   * A fact present on one side and absent on the other is the shape that drift
   * takes, so it moves with its twin. The farewell view needs no empty-board
   * copy today for the same reason it never had the bug: it OMITS the champion
   * block rather than asserting anything about who played.
   */
  playRecorded: boolean;
}

/**
 * Withhold every honour whose holder is currently banned.
 *
 * THE RULE, STATED ONCE for both surfaces that render a podium (`buildPodium`
 * here, and `ProofFeed`'s podium Moment, which reads the immutable payload the
 * scheduler posted). A ban is presentational (`specs/w2-ban-console.md`), and
 * this repo draws one line through every ban-aware surface:
 *
 *   - AN HONOUR IS WITHHELD, NEVER REASSIGNED. The champion, the Event-wide
 *     First to BINGO and a Day's pinned First to BINGO each name who WON
 *     something; hiding the winner does not make the runner-up the winner, so
 *     the module simply does not render. That is `specs/w2-ban-console.md`
 *     § Leaderboard, `specs/daily-engagement-email.md` § "A ban hides the
 *     holder", and `ArchivedLeaderboard`'s vacating hall-of-fame headline.
 *   - A POSITION CLOSES THE GAP. A standings rank is the row's place among the
 *     rows being shown, so a hidden row is simply not there and the rest are
 *     numbered 1..n — `specs/w2-leaderboard.md` § Design decisions, the live
 *     Leaderboard, both Share Cards, and `ArchivedLeaderboard`, whose own
 *     comment gives the reason: a hole at #1 advertises that a row was removed,
 *     which is the opposite of what hiding is for. The one exception is a
 *     Player block (#689): a row hidden by the viewer's own block keeps its
 *     gap (`withRanksKeepingGaps`), while its honours go through this rule via
 *     `withBlockExclusions`.
 *
 * So this function takes ONLY the honours. The positions beside them
 * (`Podium.standings`) are built from the ban-filtered rows instead, and the two
 * rules are applied in one place each rather than inferred per surface — which
 * is how the closing Day's banner came to crown the runner-up while the Feed's
 * Moment for the same Event showed no champion at all.
 *
 * Generic over the three honour shapes because the Moment's payload spells a
 * daily honour's instant `at` and this module's spells it `firstBingoAt`: only
 * the uid is read here, so one rule covers both rather than two copies that can
 * drift.
 */
export function withholdBannedHonours<
  C extends { uid: string },
  F extends { uid: string },
  H extends { uid: string },
>(
  honours: {
    champion: C | null | undefined;
    firstBingo: F | null | undefined;
    dailyHonors: readonly H[];
  },
  bannedUids: readonly string[],
): { champion: C | null; firstBingo: F | null; dailyHonors: H[] } {
  const { champion, firstBingo, dailyHonors } = honours;
  return {
    champion: champion && !isBanned(champion.uid, bannedUids) ? champion : null,
    firstBingo: firstBingo && !isBanned(firstBingo.uid, bannedUids) ? firstBingo : null,
    dailyHonors: dailyHonors.filter((h) => !isBanned(h.uid, bannedUids)),
  };
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
 *
 * THE RE-AGGREGATED TOTALS ARE CLAMPED TO THE SAME BOUND THE BUCKETS ARE (#1152,
 * Codex P2 on PR #1165). `useLeaderboard` hands this a roster whose every count
 * is already inside `MAX_ARCHIVE_NUMBER`, but a SUM of bounded counts is not
 * itself bounded: two buckets at the maximum re-aggregate to twice it, and the
 * row's clamped ROOT is what the live Leaderboard and the frozen record rank by.
 * A second row would then tie this one on the board and lose to it here — one
 * row ranking differently across surfaces that are documented never to disagree.
 * So the finished totals go back through `clampReaggregatedTotal`, once each.
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
  return {
    uid: player.uid,
    displayName: player.displayName,
    // The SUM is bounded, not just its addends: see `clampReaggregatedTotal`.
    bingoCount: clampReaggregatedTotal(bingoCount),
    squaresMarked: clampReaggregatedTotal(squaresMarked),
    firstBingoAt,
  };
}

/**
 * Did this Player record ANY Marks — a marked Square or a bingo — on ANY Day?
 *
 * THE MARKS QUESTION, NOT THE SCORING ONE (#1192). Every other predicate on the
 * podium path asks what COUNTS: `podiumStandingRow` above drops each ceremonial
 * Day's contribution and `effectiveCruiseFirstBingoAt` drops each Tutorial Day's
 * instant, because ADR 0011 makes pool identity, Tutorial framing and Scoring
 * Policy three independent facts. This asks whether anything HAPPENED, which no
 * exclusion can change: a Player who marked forty Squares on a ceremonial Day
 * marked forty Squares. The Scoring Policy removed their score, not their Marks.
 *
 * ROOTS OR BUCKETS, either one positive — the root aggregates and the per-Day
 * breakdown can disagree on a legacy or hybrid row (the state `playerRowRootLag`
 * exists to detect), and the only claim this answer gates is "nobody marked a
 * square", so it is refused unless every signal the row has agrees that nothing
 * was marked. Malformed counts are already coerced by `withReadableDayStats` at
 * the read boundary, and a non-finite or negative count is not positive anyway.
 *
 * The bucket guard is not decoration: this reads the map UNCONDITIONALLY, where
 * `podiumStandingRow` reads it only on a schedule that has a ceremonial Day to
 * exclude. `dayStats` is Player-written and validated by no rules arm (ADR 0001),
 * so a roster that reaches here without passing `withReadableDayStats` hands this
 * a `null` bucket the row builder would never have touched — and a throw inside
 * `buildPodium` takes the farewell view down with it.
 *
 * Mirror of `anyMarksRecorded` in `functions/src/finaleContent.ts`, pinned
 * against it by `tests/functions/finale-parity.test.ts`.
 */
function anyMarksRecorded(player: PlayerDoc): boolean {
  if (player.bingoCount > 0 || player.squaresMarked > 0) return true;
  for (const stat of Object.values(player.dayStats ?? {})) {
    if (stat && (stat.bingoCount > 0 || stat.squaresMarked > 0)) return true;
  }
  return false;
}

/**
 * The podium the farewell view renders: cruise champion (top of the standings,
 * ceremonial Days excluded), Event-wide First to BINGO (main-game Days only), and
 * the per-Day honors strip. Computed from the live `PlayerDoc` aggregates + the
 * per-Day `dayStats`, with the farewell Day frozen out so a post-freeze goodbye
 * mark never changes who is on the podium.
 */
/**
 * The per-Day First to BINGO honours: the write-once day-meta pin when the Day
 * has one, the roster-derived fallback when it does not, and nothing at all for
 * a Day whose pinned holder is BANNED — hidden, never reassigned.
 *
 * ONE selection, shared by the live Leaderboard's honours strip, the podium and
 * the frozen record (#1151, #1146, #1142 item 8). It used to hide a pin whose
 * holder was absent from the supplied roster, which read roster ABSENCE as a
 * ban: an Admin deleting a Player row left that Player's honour on the live
 * strip (which checks `bannedUids` explicitly) and dropped it from every surface
 * built through here — permanently, once the record froze. A pin is a write-once
 * day-meta document with its own name and instant, so it needs no Player row to
 * render; the only reason to hide one is the ban policy, and that is now the
 * only thing that does.
 *
 * `bannedUids` is therefore passed EXPLICITLY rather than inferred, and since
 * #1216/#1217 every caller hands this the RAW roster: the pin reads the list,
 * the derived fallback reads the roster and is filtered by that same list
 * afterwards. Both halves of the honour rule then land in one place.
 *
 * AND AN HONOUR IS ONLY EVER DERIVED FOR A DAY THE CONTRACT HAS (#1151, Codex P2
 * on PR #1162, round 7). `perDayHonors` reads its `dayIndex` off a `dayStats`
 * KEY, and that map is Player-written under ADR 0001 with a rules arm that
 * validates nothing inside it — so a row can name Day `-1`, Day `10` or Day
 * `4000`, and on an Event with NO schedule this function returned that list
 * straight through. The honour then rode onto the live strip as a chip labelled
 * `D0` or `D4001`, and into the frozen record's `dailyHonors`, where
 * `firestore.rules` cannot look inside a list to refuse it. `supportedDayIndex`
 * is the shared question `usableDayIndexes` asks of a stored schedule, asked here
 * of a derived key, so the two sides of the same contract cannot disagree.
 *
 * The filter is applied to the DERIVED list rather than to the schedule's own
 * entries, and that covers both routes a derived honour can arrive by: the
 * scheduleless list is the derived list itself, and the per-Day fallback below
 * finds its honour IN that list, so an out-of-range `day.index` now matches
 * nothing. A PIN on such a Day is deliberately left alone here — the live strip
 * renders a chip for every Day the schedule names, and hiding only its holder
 * would be the ban rule applied to a Day that was never banned. The record is
 * where that one is refused, by the same predicate, in `draftEventArchive`'s
 * carried-honour filter: `archiveEvent` will not freeze such a schedule at all
 * (`usableDayIndexes` → `schedule-unusable`), and the builder is what stands
 * between the ungated callers and a permanent record.
 *
 * AND THE SELECTION COMES OUT IN DAY-INDEX ORDER (#1151, Codex P2 on PR #1162,
 * round 9). This flat-maps over the schedule's ENTRIES, and a stored schedule
 * listing `[{index: 4}, {index: 1}]` is a legitimate one — the indexes are
 * unique, `usableDayIndexes` accepts it, and keying on `DayDef.index` rather than
 * on the array position is the whole point of that check. So the honours arrived
 * in SCHEDULE order, and every surface downstream inherited it: the podium
 * (`buildPodium`) and the Feed's honours line render this list straight through,
 * so they showed D5 ahead of D2 — while `draftEventArchive` sorted its own copy
 * and froze `[1, 4]`. The record's whole promise is that it says what the last
 * live display said, and the two had stopped agreeing.
 *
 * Sorted HERE rather than in each consumer, because the order is a property of
 * the SELECTION — `EventArchive.dailyHonors` and `Podium.dailyHonors` both
 * declare themselves ordered by Day index — and one shared answer is what stops
 * a consumer re-sorting defensively against a contract that already promised it.
 * The scheduleless path needed nothing: `perDayHonors` sorts its derived list
 * already, so this makes the two paths agree rather than imposing something new
 * on one of them. On the array `flatMap` just minted, so `days` is not the
 * caller's to reorder, and STABLE (V8's `Array#sort` is), so a schedule naming
 * the same Day twice still emits that Day's entries in schedule order — which is
 * the order `draftEventArchive`'s first-entry-wins dedupe reads them in.
 *
 * The Leaderboard's own strip is the one surface this does NOT order, because it
 * does not render this list: it renders a chip for every Day the SCHEDULE names,
 * winnerless Days included, and reads the holder out of this selection by index.
 * It sorts its chips by `DayDef.index` for the same reason and to the same
 * answer.
 */
export function pinnedOrDerivedDailyHonors(
  players: readonly PlayerDoc[],
  days: readonly DayDef[] | undefined,
  dayMetas: ReadonlyMap<number, DayMetaDoc> | undefined,
  dayMetasLoaded: boolean,
  bannedUids: readonly string[] = [],
): DayHonor[] {
  // A DERIVED honour is dropped for a banned holder AFTER the selection, never
  // before it, so that Day is withheld — "hidden, never reassigned", the same
  // rule the pin branch below already applied — rather than the next-earliest
  // Player handed a chip they did not earn.
  //
  // WHICH ONLY WORKS ON A RAW ROSTER. A caller that ban-filters on the way IN
  // hands this rows indistinguishable from a roster the banned Player was never
  // on, and `perDayHonors` then picks the earliest bingo among whoever is left
  // — this line sees nothing to drop and the promotion has already happened.
  // `buildPodium` passes the raw roster (#1216); the live Leaderboard's strip
  // and `draftEventArchive` do too (#1217), so all three surfaces read one
  // answer and the frozen record still says what the last live strip said.
  const derivedHonors = perDayHonors(players).filter(
    (h) => supportedDayIndex(h.dayIndex) && !isBanned(h.uid, bannedUids),
  );
  if (!days?.length || !dayMetas) return derivedHonors;
  return days
    .flatMap((day) => {
      const pinned = dayMetas.get(day.index)?.firstBingo;
      if (pinned) {
        if (isBanned(pinned.uid, bannedUids)) return [];
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
    })
    .sort((a, b) => a.dayIndex - b.dayIndex);
}

/**
 * How one Day's honour chip is LABELLED on an honours strip: the Day's theme
 * emoji, if the schedule names a theme this build knows, then the Day's own
 * ordinal (`D1`, `D2`, …).
 *
 * Shared rather than restated (#1151, Codex P2 on PR #1139). The live
 * Leaderboard's strip computes it from the CURRENT `EventDoc.days`, and the
 * post-Event archive computes it ONCE, at the freeze, and stores the result on
 * the honour — so an Admin who later re-themes a Day cannot change a frozen
 * honour's chip. Two callers, one derivation, so the frozen label is by
 * construction the label the last live strip rendered.
 *
 * The ordinal half is derived from the index rather than the schedule on
 * purpose: it is what the strip shows for a Day the schedule has nothing to say
 * about, and it cannot drift.
 */
export function dayHonorChipLabel(
  dayIndex: number,
  days: readonly DayDef[] | undefined,
): string {
  const day = days?.find((d) => d.index === dayIndex);
  const emoji = day ? (THEMES.find((t) => t.id === day.theme)?.emoji ?? '') : '';
  return `${emoji ? `${emoji} ` : ''}D${dayIndex + 1}`;
}

/**
 * The client's podium, honours and positions each under their own ban rule.
 *
 * `players` IS THE RAW ROSTER, and `bannedUids` is what hides anybody. The
 * earlier contract was the other way round — every caller ban-filtered its
 * roster first and `bannedUids` existed only for the day-meta PIN branch (#1146)
 * — and filtering the INPUT is precisely what promoted the runner-up: with the
 * champion's row removed, `standings[0]` is the next Player, `eventFirstBingoWinner`
 * picks the next-earliest bingo, and `perDayHonors` derives a Day's honour for
 * whoever is left. The closing Day's banner therefore crowned a champion the
 * Feed's own podium Moment for the same Event showed none of, and handed out a
 * ⭐ the spec says can never be reassigned (`specs/w2-ban-console.md`
 * § Leaderboard). Hiding is applied to the OUTPUT instead, which is how the
 * Feed's Moment has always done it and how the mirror on the Functions side is
 * shaped: `buildPodiumPayload` ranks the unfiltered roster and its consumers
 * withhold (`ProofFeed`, `podiumEmail`).
 *
 * So: the honours come off the raw ranking and go through
 * `withholdBannedHonours`; `standings` is numbered over the ban-filtered rows.
 * With an empty ban roster the two paths are the same array and this stays
 * byte-identical to `buildPodiumPayload`, which is what `tests/functions/finale-parity.test.ts`
 * compares — that guard covers the unbanned case because the Moment is written
 * unfiltered by contract, so a ban is exactly the input the two builders are
 * never handed together.
 */
export function buildPodium(
  players: readonly PlayerDoc[],
  days: readonly DayDef[] | undefined,
  dayMetas?: ReadonlyMap<number, DayMetaDoc>,
  dayMetasLoaded = true,
  freezeAt?: number | null,
  /**
   * The Event's ban roster — the ONLY thing that hides a Player here. Passing
   * `[]` renders everybody, which is right for a caller with no ban roster in
   * hand and wrong for one that has simply filtered its roster instead: that
   * caller gets the promotion this parameter exists to prevent.
   */
  bannedUids: readonly string[] = [],
  /**
   * `EventDoc.frozenPlayRecorded`, the freeze's own answer to "did anybody
   * play" (#1218). Only a stored `false` changes anything: the podium then drops
   * every daily honour pinned at or after `freezeAt`, the same rule
   * `runFinaleBeats` applies to the Moment it posts beside that `false` (#1263,
   * Codex P1 `4088148821` on PR #1268), so the in-app podium and share card
   * cannot print a ceremonial honour the Feed and the winner email omit.
   * `true`, `null` and absence keep every honour.
   */
  frozenPlayRecorded?: boolean | null,
  /**
   * The viewer's reciprocal hidden set (#689, specs/player-blocking.md): a
   * hidden Player's honours are withheld exactly as a ban's are, and their
   * standings row is dropped AFTER numbering and the top-three cut, so its rank
   * leaves a gap and nobody moves up into view (decision 6). Empty by default,
   * which leaves the output identical to the unblocked podium.
   */
  hiddenUids: ReadonlySet<string> = new Set<string>(),
): Podium {
  const excluded = withBlockExclusions(bannedUids, hiddenUids);
  // The podium is "as of the freeze", not live (Phase 4b P1). This module reads
  // the LIVE roster, and a ceremonial Day deliberately keeps recording Marks
  // after the freeze — its bucket is retained so its own daily honour still
  // renders, except beside a frozen `false`, where an honour pinned at or after
  // the freeze is dropped (`frozenEmptyHonourFilter`, #1263). Without a cutoff those post-freeze Marks can mint a First to BINGO
  // the scheduler's already-posted, immutable podium Moment does not have: a
  // Player whose only bingo lands after the freeze on a ceremonial,
  // `tutorial: false` Day would appear on the card while the Feed shows none.
  // The card and the Feed must not name different winners — that is the same
  // class of split ADR 0011 was written to close.
  //
  // `null`/absent means no cutoff, which is what every pre-freeze render wants.
  // INCLUSIVE at the freeze instant, matching `standingsFrozen`'s
  // `now >= freezeAt` and the half-open `[lastCallAt, freezeAt)` last-call
  // window: that millisecond is already frozen (Phase 4b P2).
  const withinFreeze = (at: number | null): number | null =>
    at != null && freezeAt != null && at >= freezeAt ? null : at;
  const tutorial = tutorialDayIndexSet(days);
  const isTutorialDay = (i: number): boolean => tutorial.has(i);
  const ceremonial = ceremonialDayIndexSet(days);

  const ranked = players
    .map((p) => podiumStandingRow(p, ceremonial, isTutorialDay, withinFreeze))
    .sort(comparePlayers);
  const top = ranked[0];
  const champion: PodiumChampion | null =
    top && (top.bingoCount > 0 || top.squaresMarked > 0)
      ? {
          uid: top.uid,
          displayName: top.displayName,
          bingoCount: top.bingoCount,
          squaresMarked: top.squaresMarked,
        }
      : null;

  // ONE selector, shared with the Leaderboard's pin (Phase 4b P1): the honour
  // must read the same on the card and in the standings, and the cutoff applies
  // to the SELECTION rather than only the reported instant — picking the winner
  // from uncut data and then blanking their timestamp would report no First to
  // BINGO at all while an eligible pre-freeze one existed.
  //
  // Over the RAW roster, like the Leaderboard's own pin and for the same reason
  // that spec gives: who crossed the line first already happened, so a ban can
  // only hide it.
  const firstBingo: PodiumFirstBingo | null =
    eventFirstBingoWinner(players, isTutorialDay, freezeAt) ?? null;

  // THE POSITIONS, numbered over the rows a reader can see — the other half of
  // the rule `withholdBannedHonours` states. Cut from the SAME sorted array the
  // champion came from, never a re-sort, with the champion's own zero-activity
  // guard applied per row (the sort puts zero-activity rows last, so a dropped
  // row can only ever be trailing; ranks never skip).
  const standings: PodiumStandingRow[] = ranked
    .filter((r) => !isBanned(r.uid, bannedUids) && (r.bingoCount > 0 || r.squaresMarked > 0))
    .slice(0, PODIUM_STANDING_ROWS)
    .map((r, i) => ({
      uid: r.uid,
      rank: i + 1,
      displayName: r.displayName,
      bingoCount: r.bingoCount,
      squaresMarked: r.squaresMarked,
    }))
    .filter((r) => !isHiddenFor(r.uid, hiddenUids));

  return {
    // The honours strip is ban-aware on BOTH sides of this call, and deliberately
    // so: `pinnedOrDerivedDailyHonors` has to make the check itself because a PIN
    // renders with no roster row behind it, and routing the finished list through
    // the shared rule as well is what keeps "an honour is withheld" a single
    // statement rather than one per surface. Applying one predicate twice to one
    // list costs an array and cannot disagree with itself.
    ...withholdBannedHonours(
      {
        champion,
        firstBingo,
        dailyHonors: frozenEmptyHonourFilter(
          pinnedOrDerivedDailyHonors(players, days, dayMetas, dayMetasLoaded, excluded),
          frozenPlayRecorded,
          freezeAt,
        ),
      },
      excluded,
    ),
    standings,
    // OVER THE RAW ROSTER, not over `standings` (#1192): the re-aggregated rows
    // are where a ceremonial Day's Marks have already been dropped, so asking
    // them whether anything was marked would answer the scoring question again
    // under a different name. Unbounded by `withinFreeze` because counts carry
    // no instant — the same reason the champion's own totals are not.
    playRecorded: players.some(anyMarksRecorded),
  };
}

/**
 * A frozen `false` keeps every honour pinned AT OR AFTER the freeze off the
 * podium (#1263): the freeze read the roster and every Day's pin and found
 * nothing, so an honour carrying a later instant is one the freeze could not
 * have seen. It filters by instant rather than blanking, for the reason the
 * scheduler's twin in `runFinaleBeats` gives: the field is admin-writable, so it
 * must not be able to erase anything the freeze could have seen. The bound is
 * the `>= freezeAt` cutoff `withinFreeze` applies to the First to BINGO.
 */
function frozenEmptyHonourFilter(
  honors: DayHonor[],
  frozenPlayRecorded: boolean | null | undefined,
  freezeAt: number | null | undefined,
): DayHonor[] {
  if (frozenPlayRecorded !== false || freezeAt == null) return honors;
  return honors.filter(
    (h) => typeof h.firstBingoAt === 'number' && Number.isFinite(h.firstBingoAt) && h.firstBingoAt < freezeAt,
  );
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
