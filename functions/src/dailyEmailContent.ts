/**
 * Daily engagement email CONTENT (issue #616, plans/daily-cards-wireframes.html
 * § "Daily engagement email"). Owns the model the template renders: the Theme
 * header, the standings snapshot, the participation nudge, the photos + award
 * module, the Feed CTA and the footer — assembled per Edition register (#608
 * lexicon, frame `#fx-email-registers-tri`) and per recipient.
 *
 * Pure and injectable, like `finaleContent.ts`: no `firebase-admin`, no
 * `firebase-functions`, no I/O. The scheduled orchestration (`dailyEmail.ts`)
 * reads Firestore and Auth and hands the results in; everything here is a
 * function of its arguments, so the whole content surface is unit-testable
 * without a Functions runtime.
 *
 * MODULE ORDER IS FIXED and load-bearing (the wireframe's numbered legend):
 * preheader → Theme header → standings → nudge → photos + award → Feed CTA →
 * footer. The plain-text part mirrors the same order. Editions change the
 * WORDS; the Day changes the PALETTE; the order never moves.
 */
import type { DayDef, EventDoc, PlayerDoc } from '../../src/domainTypes';
import {
  ceremonialDayIndexes,
  compareFinalePlayers,
  standingsFreezeAtFor,
  tutorialDayIndexes,
} from './finaleContent';
import { emailThemeTokens, type EmailThemeTokens } from './dailyEmailTheme';

// --- Canonical domain views -----------------------------------------------------

/** The canonical `DayDef` fields the email reads. Firestore's legacy/malformed
 *  tolerance makes display-only fields optional at this boundary; their value
 *  types still come directly from the shared contract. This boundary reads RAW
 *  Firestore Day objects (no client converter), so it also models the
 *  pre-#566 persisted field names — `port`/`portEmoji` — which `placeLabel`
 *  and the arrival line use when present. The live Bodega wrap-up's
 *  operator-corrected emoji remains on `portEmoji` during the transition. */
export type EmailDay = Pick<DayDef, 'index' | 'unlockAt'> &
  Partial<Pick<DayDef, 'date' | 'place' | 'placeEmoji' | 'theme' | 'tonight' | 'tutorial'>> & {
    /** Legacy persisted name for `place` (pre-#566 Event docs). */
    port?: string;
    /** Legacy persisted name for `placeEmoji` (pre-#566 Event docs). */
    portEmoji?: string;
    /** The Day's stated Scoring Policy (ADR 0011) — whether its Marks move the
     *  standings. Absent on every doc written before the field existed, which
     *  is every Day of both live Events. Typed as a bare `string` rather than
     *  `DayDef['scoring']` for the same reason `FinaleDay` is: this boundary
     *  reads RAW Firestore maps, so a stored value that is neither policy is
     *  reachable and must resolve, not fail to typecheck. Resolve through
     *  `scoringForDay`/`isCeremonialDay` (`scoringVocab.ts`) — never by direct
     *  comparison, and never off `pool` (ADR 0011: a reader who finds a pool
     *  comparison in a scoring path is looking at a regression). */
    scoring?: string;
    /** The Day's Pool identity, carried ONLY so the legacy Scoring Policy
     *  fallback can read it: a Day with no `scoring` key resolves ceremonial iff
     *  it deals the closing pool, which is exactly what the pre-ADR-0011 code
     *  hard-coded. Loosely typed because the pre-#565 spellings (`embark` /
     *  `farewell`) are what both live Events actually persist; `normalizePool`
     *  inside the resolver is what folds them. */
    pool?: string;
  };

/** The canonical `EventDoc` fields the email reads, with legacy-safe presence.
 *  `standingsFreezeAt` is the CONFIGURED Standings Freeze (ADR 0011); the
 *  headline ⭐ resolves it through `standingsFreezeAtFor`, which falls back to
 *  the first ceremonial Day's `unlockAt` when the doc carries none. */
export type EmailEvent = Partial<
  // `status`/`archiving` are the post-Event freeze (#134): an archived or
  // CLOSING Event is stopped, and the daily sweep has to read that off the
  // document rather than trusting its own `status == 'active'` selection —
  // the closing state is deliberately still `'active'`.
  Pick<EventDoc, 'name' | 'timezone' | 'bannedUids' | 'standingsFreezeAt' | 'status' | 'archiving'>
> & {
  days?: EmailDay[];
  settings?: Partial<Pick<EventDoc['settings'], 'dailyEmailEnabled'>>;
};

/** The canonical `PlayerDoc` fields the standings snapshot reads. */
export type EmailPlayer = Pick<
  PlayerDoc,
  'uid' | 'displayName' | 'bingoCount' | 'squaresMarked' | 'firstBingoAt' | 'dayStats'
>;

/** One rendered standings row. */
export interface StandingsRow {
  /** Carried so the ⭐-holder append can test membership without re-deriving
   *  it from a display name, which is neither unique nor stable. */
  uid: string;
  rank: number;
  displayName: string;
  bingoCount: number;
  squaresMarked: number;
  /** True for the Player holding the Event-wide First to BINGO pin (⭐). */
  starred: boolean;
}

// --- Edition registers (#608 lexicon; frame `#fx-email-registers-tri`) -----------

/**
 * The per-Edition voice of one email. Every field here is a row of the
 * wireframe's register strip; the modules the strip marks `brand-invariant`
 * (Theme header, standings structure, CTA, unsubscribe) carry no field at all,
 * which is how the invariance is enforced rather than merely asserted.
 */
export interface EditionRegister {
  /** Footer brand line. Every Edition OF the platform carries the `· by Five
   *  Across` endorsement — Vacay from #616, Gay Cruise Bingo from #698 —
   *  matching the in-app lockups (#647, #688). Only `fiveacross` goes without:
   *  it IS the platform, so endorsing itself would be noise. The separator is
   *  a `·` rather than the lockup's stacked micro-line because this renders as
   *  one inline sign-off, not as display type. */
  brandLine: string;
  /** The occasion noun: "cruise" / "trip" / "event". */
  occasion: string;
  /** The First-to-BINGO honor qualifier: "cruise-wide" / "trip-wide" / "event-wide". */
  occasionWide: string;
  /** Subject tail when there are standings to report. */
  subjectTail: string;
  /** Subject tail on the opening Day, when there are not. */
  subjectTailDayOne: string;
  /** The morning line's verb phrase, given the Day's Place (already formatted). */
  arrivalLine: (place: string) => string;
  /** The morning line when the Day names no Place. */
  arrivalLineNoPlace: string;
  /** Photos module: the emphasised lead clause. */
  photosLead: string;
  /** Photos module: the rest of the nudge, in this Edition's register. */
  photosRest: string;
  /** Footer: why this person is receiving the email, given the Event's name. */
  whyYouGotThis: (eventName: string) => string;
}

const REGISTERS: Record<string, EditionRegister> = {
  // 🚢 Gay Cruise Bingo — cruise register at full camp.
  gcb: {
    brandLine: 'Gay Cruise Bingo · by Five Across',
    occasion: 'cruise',
    occasionWide: 'cruise-wide',
    subjectTail: 'standings + tonight',
    subjectTailDayOne: 'your card is live',
    arrivalLine: (place) => `The boat docks in ${place} today`,
    arrivalLineNoPlace: 'A day at sea today',
    photosLead: 'BINGO without a photo is a rumor.',
    photosRest: 'Post a pic with every claim—the boat wants receipts.',
    whyYouGotThis: (eventName) => `You're getting this because you're sailing ${eventName}.`,
  },
  // 🧳 Vacay Bingo — trip register at moderate camp.
  vacay: {
    brandLine: 'Vacay Bingo · by Five Across',
    occasion: 'trip',
    occasionWide: 'trip-wide',
    subjectTail: 'standings + today',
    subjectTailDayOne: 'your card is live',
    arrivalLine: (place) => `The group lands in ${place} today`,
    arrivalLineNoPlace: 'The group is together today',
    photosLead: 'Got BINGO? Post a photo with it.',
    photosRest: 'Every claim is a photo op, and the group chat wants receipts.',
    whyYouGotThis: (eventName) => `You're getting this because you're on the ${eventName} trip.`,
  },
  // ✳ Five Across — the platform register: plain, occasion-neutral.
  fiveacross: {
    brandLine: 'Five Across',
    occasion: 'event',
    occasionWide: 'event-wide',
    subjectTail: "standings + today's card",
    subjectTailDayOne: 'your card is live',
    arrivalLine: (place) => `Today at ${place} starts now`,
    arrivalLineNoPlace: 'Today starts now',
    photosLead: 'Post a photo with every BINGO.',
    photosRest: "That's what the Feed is for.",
    whyYouGotThis: (eventName) => `You're getting this because you're part of ${eventName}.`,
  },
};

/** The Edition an unknown / absent id degrades to — the legacy experience, the
 *  same fallback direction `setActiveEdition` takes in the app. An OWN-PROPERTY
 *  check rather than a bare index read: a plain object inherits
 *  `Object.prototype`, so `REGISTERS['toString']` would otherwise pass as a
 *  register (#597); `hasOwnProperty.call` because this package targets ES2021. */
export const DEFAULT_EMAIL_EDITION = 'gcb';

export function registerFor(edition: string | null | undefined): EditionRegister {
  if (edition && Object.prototype.hasOwnProperty.call(REGISTERS, edition)) return REGISTERS[edition];
  return REGISTERS[DEFAULT_EMAIL_EDITION];
}

/**
 * The per-Edition `From:` override for one send, or `undefined` meaning "fall
 * back to the project-wide `EMAIL_FROM` default" (#671). Every email family
 * currently sends from a single per-PROJECT param even though one project can
 * serve several brands (ADR 0008 splits projects by cohort, not brand) — this
 * is the resolution that lets a Vacay host use a Vacay sender and a Five
 * Across host use a Five Across sender, without regressing an Edition whose
 * sending domain is not Resend-verified yet into a silently dropped send
 * (`sendEmail` swallows a Resend rejection into a logged `false`, never a
 * thrown error, per ADR 0001).
 *
 * `overrides` is keyed like `REGISTERS`. Three cases all resolve to
 * `undefined` — a `null`/absent edition, an edition unrecognized here, and a
 * recognized edition with no configured (or blank) override — so an unknown
 * or unconfigured Edition degrades to a working sender exactly like the
 * `registerFor` content fallback, rather than failing the send. The
 * `hasOwnProperty` guard mirrors `registerFor`'s prototype-pollution defense
 * (#597): a plain object inherits `Object.prototype`, so an edition literally
 * named `"toString"` must not read `Object.prototype.toString` as if it were
 * a configured address.
 */
export function fromAddressFor(
  edition: string | null | undefined,
  overrides: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (!edition || !Object.prototype.hasOwnProperty.call(REGISTERS, edition)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(overrides, edition)) return undefined;
  // Trim and return the SAME value: a value that is blank once trimmed falls
  // back (the case above), but a value with incidental padding — a stray
  // space pasted into an env file — must not carry that whitespace into the
  // `From:` header the return sends (CodeRabbit finding on PR #810).
  const value = overrides[edition]?.trim();
  return value || undefined;
}

// --- Standings ------------------------------------------------------------------

/**
 * Every Player's STANDINGS totals THROUGH a Day — i.e. folded over `dayStats`
 * entries strictly BEFORE `throughDayIndexExclusive`. The email reports
 * standings "through yesterday" because today's card has only just unlocked, so
 * today's marks are all zero and a snapshot including them would be identical
 * but mislabelled.
 *
 * THREE POLICIES MEET HERE AND ONLY TWO OF THEM LIVE IN THIS FUNCTION (#1052).
 * ADR 0011 makes a Day's Pool identity, its Tutorial framing and its Scoring
 * Policy three independent facts, and the surfaces that read them ask three
 * different questions:
 *
 *   - the standings TOTALS exclude ceremonial Days — a `ceremonial` policy
 *     promises its Marks never move the standings, so its bingos and squares
 *     are dropped from the sum (its per-Day bucket is untouched, and its own
 *     daily honour still stands);
 *   - the standings TIE-BREAK excludes Tutorial Days OR ceremonial Days.
 *     `compareFinalePlayers` breaks a bingos+squares tie on the earliest
 *     first-bingo, so a value that still counted a ceremonial Mark would let
 *     that Mark decide the ranking while its score was being excluded — the row
 *     would be internally inconsistent. This mirrors `rankingExcludedDay` in
 *     `src/game/logic.ts` and `podiumStandingRow` in `finaleContent.ts`;
 *   - the headline ⭐ excludes Tutorial Days ALONE and honours the Standings
 *     Freeze, which is a different question with a different answer — see
 *     `eventFirstBingoUid`. It is DELIBERATELY not read off the row this
 *     function returns: one mutated `firstBingoAt` cannot carry both meanings,
 *     and making it try is the defect #1052 fixed.
 *
 * Tutorial Days still COUNT FOR SCORE: an embark-Day bingo is real pre-freeze
 * play and is summed (ADR 0011; `sumDayStats` in `src/game/logic.ts` sums every
 * Day). Only the ceremonial policy removes score, and only the honour rules
 * remove a timestamp.
 *
 * A Player with no `dayStats` breakdown (a legacy roster predating Day Cards)
 * keeps their root aggregates — there is nothing to slice — matching
 * `podiumStandingRow`'s handling in `finaleContent.ts`. Ranking is
 * `compareFinalePlayers`, so the email, the podium and the in-app Leaderboard
 * can never disagree about who is ahead.
 *
 * A row that HAS buckets is always re-derived from them, where the podium
 * additionally passes the roots through when the schedule states no ceremonial
 * Day at all. The two are not in tension: this function reports a WINDOW ("through
 * Day N-1"), which no root can answer, so it has nothing to pass through — the
 * podium's extra branch exists to leave a legacy/hybrid row alone when it is
 * reporting the whole Event and re-summing would rewrite it.
 *
 * Malformed `dayStats` entries are SKIPPED rather than trusted: `players/{uid}`
 * is self-writable by design (ADR 0001), so a row like `{ dayStats: { 0: null } }`
 * is reachable, and one such row throwing here would suppress the whole Event's
 * send. The read boundary sanitizes too; this is the second line (Codex #623 P2).
 */
export function standingsThrough(
  players: readonly EmailPlayer[],
  throughDayIndexExclusive: number,
  tutorialDays: ReadonlySet<number> = new Set(),
  ceremonialDays: ReadonlySet<number> = new Set(),
): EmailPlayer[] {
  return players
    .map((p) => {
      const dayStats = p.dayStats;
      if (!dayStats || typeof dayStats !== 'object' || Object.keys(dayStats).length === 0) {
        return { ...p };
      }
      let bingoCount = 0;
      let squaresMarked = 0;
      let firstBingoAt: number | null = null;
      for (const [key, stat] of Object.entries(dayStats)) {
        const dayIndex = Number(key);
        if (!Number.isInteger(dayIndex) || dayIndex >= throughDayIndexExclusive) continue;
        if (!stat || typeof stat !== 'object') continue;
        // A ceremonial Day's Marks never move the standings — neither its score
        // nor the tie-break that separates equal scores.
        if (ceremonialDays.has(dayIndex)) continue;
        if (typeof stat.bingoCount === 'number' && Number.isFinite(stat.bingoCount)) {
          bingoCount += stat.bingoCount;
        }
        if (typeof stat.squaresMarked === 'number' && Number.isFinite(stat.squaresMarked)) {
          squaresMarked += stat.squaresMarked;
        }
        if (tutorialDays.has(dayIndex)) continue; // scores yes, ranking tie-break no
        const at = stat.firstBingoAt;
        if (typeof at === 'number' && Number.isFinite(at) && (firstBingoAt == null || at < firstBingoAt)) {
          firstBingoAt = at;
        }
      }
      return { ...p, bingoCount, squaresMarked, firstBingoAt };
    })
    .sort(compareFinalePlayers);
}

/** How many ranked rows the standings module shows before the ⭐ exception. */
export const STANDINGS_ROWS = 3;

/**
 * The rendered rows: the top three by rank, PLUS the Event-wide First to BINGO
 * holder appended when their rank falls outside that slice.
 *
 * The append is not a nicety. Without it, an honor holder who has since slipped
 * to 4th vanishes from the email entirely and the ⭐ renders nowhere — so the
 * email would silently claim there is no First to BINGO while the in-app
 * Leaderboard still shows one (Codex #623 P2). `buildShareStandings` in
 * `src/components/Leaderboard.tsx` makes exactly the same exception for exactly
 * the same reason (specs/w2-leaderboard.md: "the pin can never silently drop
 * off the card just because its holder isn't otherwise a top-ranked Player"),
 * and this mirrors it so the email, the Share Card and the Leaderboard agree.
 *
 * The appended row carries its holder's TRUE rank, not a fourth-place slot, so
 * a reader is never told the wrong position. It reuses the same row shape, so
 * the rendered template is structurally unchanged.
 */
export function standingsRows(
  ranked: readonly EmailPlayer[],
  starUid: string | null,
  maxRows: number = STANDINGS_ROWS,
): StandingsRow[] {
  const toRow = (p: EmailPlayer, rank: number): StandingsRow => ({
    uid: p.uid,
    rank,
    displayName: p.displayName,
    bingoCount: p.bingoCount,
    squaresMarked: p.squaresMarked,
    starred: p.uid === starUid,
  });
  const rows = ranked.slice(0, maxRows).map((p, i) => toRow(p, i + 1));
  if (starUid && !rows.some((r) => r.uid === starUid)) {
    const at = ranked.findIndex((p) => p.uid === starUid);
    if (at >= 0) rows.push(toRow(ranked[at], at + 1));
  }
  return rows;
}

/** Whether a standings snapshot has anything to report: at least one Player who
 *  has actually marked something. An all-zero board renders the empty state
 *  (Day 1, or a Day nobody has played) rather than a podium of ties.
 *
 *  Read over the CEREMONIAL-EXCLUDED rows, so an Event whose only play so far
 *  landed on ceremonial Days reports no standings — which is the literal truth
 *  about the board, since none of those Marks moved it. The ⭐ is suppressed
 *  with the rows it would have ridden on; a headline pinned to nothing renders
 *  nowhere. */
function hasPlay(ranked: readonly EmailPlayer[]): boolean {
  return ranked.some((p) => p.bingoCount > 0 || p.squaresMarked > 0);
}

/**
 * One Player's EFFECTIVE Event-wide First to BINGO through a Day: the earliest
 * `firstBingoAt` across their NON-TUTORIAL buckets before
 * `throughDayIndexExclusive`, or — for a legacy row carrying no `dayStats` at
 * all — their root `firstBingoAt`, which is the only evidence such a row has.
 *
 * Mirrors `effectiveCruiseFirstBingoAt` in `src/game/logic.ts`, including that
 * a Player WITH buckets is answered from the buckets alone: a row that has a
 * breakdown and no qualifying bucket holds no honour, and falling back to its
 * root would re-admit exactly the Tutorial/ceremonial timestamp the breakdown
 * exists to filter.
 *
 * Ceremonial Days are NOT excluded here, deliberately. Their Marks are inert
 * for the standings and eligible for the headline; the two exclusions are
 * different sets and collapsing them is the bug (ADR 0011 § Consequences).
 */
function headlineFirstBingoAt(
  player: EmailPlayer,
  throughDayIndexExclusive: number,
  tutorialDays: ReadonlySet<number>,
): number | null {
  const dayStats = player.dayStats;
  if (!dayStats || typeof dayStats !== 'object' || Object.keys(dayStats).length === 0) {
    const root = player.firstBingoAt;
    return typeof root === 'number' && Number.isFinite(root) ? root : null;
  }
  let earliest: number | null = null;
  for (const [key, stat] of Object.entries(dayStats)) {
    const dayIndex = Number(key);
    if (!Number.isInteger(dayIndex) || dayIndex >= throughDayIndexExclusive) continue;
    if (tutorialDays.has(dayIndex)) continue;
    if (!stat || typeof stat !== 'object') continue;
    const at = stat.firstBingoAt;
    if (typeof at === 'number' && Number.isFinite(at) && (earliest == null || at < earliest)) {
      earliest = at;
    }
  }
  return earliest;
}

/**
 * Whether this Player has ANY bingo of their own recorded before
 * `throughDayIndexExclusive` — the honest answer to "is your first BINGO still
 * out there", which is a question about the reader's own play and NOT about the
 * standings or the honour.
 *
 * Every Day counts here, Tutorial and ceremonial alike: a bingo happened. The
 * ceremonial policy removes its SCORE, and the Tutorial framing removes its
 * claim on the headline, but neither un-marks the card. Reading the answer off
 * the ceremonial-excluded `bingoCount` — or off whether the reader owns the ⭐ —
 * tells a Player who bingoed on a ceremonial Day that their first BINGO is
 * still out there while their own `dayStats` records one (Codex P2, round 2).
 *
 * A legacy row with no `dayStats` falls back to its root `bingoCount`, the only
 * evidence such a row has, matching every other legacy path in this module.
 */
function hasBingoThrough(player: EmailPlayer, throughDayIndexExclusive: number): boolean {
  const dayStats = player.dayStats;
  if (!dayStats || typeof dayStats !== 'object' || Object.keys(dayStats).length === 0) {
    return typeof player.bingoCount === 'number' && player.bingoCount > 0;
  }
  for (const [key, stat] of Object.entries(dayStats)) {
    const dayIndex = Number(key);
    if (!Number.isInteger(dayIndex) || dayIndex >= throughDayIndexExclusive) continue;
    if (!stat || typeof stat !== 'object') continue;
    const bingos = stat.bingoCount;
    if (typeof bingos === 'number' && Number.isFinite(bingos) && bingos > 0) return true;
  }
  return false;
}

/**
 * The uid holding the Event-wide First to BINGO pin (⭐), or `null` when nobody
 * qualifies.
 *
 * DERIVED FROM THE RAW ROSTER, NOT FROM THE RANKED ROWS (#1052). The honour and
 * the standings answer different questions, so this reads the Players' own
 * `dayStats` rather than the `firstBingoAt` `standingsThrough` rewrote for the
 * ranking tie-break. Two exclusions, and they are not the same set — the same
 * split `eventFirstBingoWinner` keeps in `src/game/logic.ts`:
 *
 *   - Tutorial Days, always. An onboarding or send-off card is framed as
 *     non-competition, so its bingo never takes the headline honour — even when
 *     its timestamp is the earliest on the Event.
 *   - Anything at or after `freezeAt`, when a cutoff is supplied. The standings
 *     are "as of the freeze", and a ceremonial Day deliberately keeps recording
 *     Marks afterwards so its own daily honour still renders; without the cutoff
 *     those late Marks would mint a ⭐ the frozen podium does not carry, and the
 *     email and the Card would name different winners. INCLUSIVE at the instant
 *     itself, matching `standingsFrozen`'s `now >= freezeAt`.
 *
 * A CEREMONIAL, non-Tutorial Day stays ELIGIBLE. Its bingos and squares are out
 * of the standings and its timestamp is out of the ranking tie-break, but it is
 * still real play that someone was first to, so the headline can be its.
 *
 * AN EXACT-MILLISECOND TIE IS BROKEN BY UID, ASCENDING, so the caller may hand
 * this ANY roster order — Firestore's page order included. The app's mirror
 * (`eventFirstBingoWinner` in `src/game/logic.ts`) resolves the same tie over a
 * roster sorted by LIVE root totals, today's marks included, while this one only
 * ever sees the THROUGH-YESTERDAY window. So a rule that read either roster's
 * order would let a Player who marks today's card before a delayed or retried
 * send flip which of two tied Players the email stars versus the Leaderboard
 * (Codex P2, #1052). The uid is standings-independent, so no view's ordering
 * participates, and the tie-break applies only when the eligible timestamps are
 * exactly equal. `buildPodiumPayload` in `finaleContent.ts` is the third copy of
 * the same key, and `tests/functions/finale-parity.test.ts` fails if any of the
 * three changes alone.
 *
 * Pass the roster BEFORE the presentational ban filter, so a ban hides the
 * holder's row without promoting the next-earliest Player
 * (specs/w2-ban-console.md).
 */
export function eventFirstBingoUid(
  players: readonly EmailPlayer[],
  throughDayIndexExclusive: number,
  tutorialDays: ReadonlySet<number> = new Set(),
  freezeAt?: number | null,
): string | null {
  let best: { uid: string; at: number } | null = null;
  for (const p of players) {
    const at = headlineFirstBingoAt(p, throughDayIndexExclusive, tutorialDays);
    if (at == null) continue;
    if (freezeAt != null && at >= freezeAt) continue;
    if (!best || at < best.at || (at === best.at && p.uid < best.uid)) best = { uid: p.uid, at };
  }
  return best ? best.uid : null;
}

// --- Formatting helpers ---------------------------------------------------------

/**
 * "Saturday, Jul 18" from a Day's ISO date. Returns `''` for a missing or
 * unparseable date rather than "Invalid Date".
 *
 * FORMATTED IN UTC, DELIBERATELY, and it takes no timezone argument so it
 * cannot be "fixed" back. `DayDef.date` is ALREADY the Event's local calendar
 * date — a plain wall-clock label, not an instant — so pinning it to noon UTC
 * and then rendering it in the Event's zone applies the offset a second time.
 * Inside ±12h that cancels out invisibly; past it, it does not: in
 * `Pacific/Kiritimati` (UTC+14) noon UTC is 02:00 the NEXT day, so `2026-07-18`
 * would print as Sunday, Jul 19 (Codex #623 P2). Noon rather than midnight is
 * still the parse anchor, so the same label survives any future re-render at a
 * modest offset.
 */
export function formatDayDate(isoDate: string | undefined): string {
  if (!isoDate) return '';
  const at = Date.parse(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(at)) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(at));
}

/**
 * The largest millisecond offset a JavaScript `Date` can represent (ECMA-262
 * "time clip", ±100,000,000 days around the epoch).
 */
const MAX_TIME_VALUE = 8.64e15;

/**
 * True when a Day names a REAL unlock instant, rather than the `unlockAt: 0`
 * "live from Event open" sentinel (#289), a missing value, or a corrupt one.
 *
 * ONE question, deliberately not three (#723). Sentinel, absent, `NaN`,
 * negative, non-numeric and out-of-range all mean the same thing to both
 * callers — there is no hour to quote and none to schedule against — so they
 * are one case, and nothing downstream sorts them further. The sender and the
 * copy must agree on it: a Day the sender mails at the Event's fallback morning
 * hour is a Day whose copy must not promise an unlock time.
 *
 * FINITE IS NOT THE SAME AS REPRESENTABLE, and this predicate is the single
 * place that difference is caught (Codex #729 P2). `Number.MAX_VALUE` is finite
 * and positive, but `new Date(Number.MAX_VALUE)` is an Invalid Date and EVERY
 * `Intl` call on it throws `RangeError` — including the `formatToParts` in
 * `morningOpensAt`, whose try/catch only re-reads in UTC and so rethrows. One
 * corrupt future Day would abort the whole Event's due check and silently
 * suppress that morning's otherwise valid email, which is precisely the
 * mail-nothing failure the #723 rule exists to remove. Bounding here rather
 * than at each `new Date` keeps the callers agreeing by construction: an
 * unlock the sender cannot schedule against is an unlock the copy cannot quote.
 */
export function hasScheduledUnlock(day: Pick<EmailDay, 'unlockAt'>): boolean {
  return (
    typeof day.unlockAt === 'number' &&
    Number.isFinite(day.unlockAt) &&
    day.unlockAt > 0 &&
    day.unlockAt <= MAX_TIME_VALUE
  );
}

/**
 * "8:00 a.m." — the Day's unlock in the Event's timezone — or `null` when the
 * Day has no real unlock instant to quote.
 *
 * NULL RATHER THAN A FORMATTED SENTINEL (#723). Epoch 0 is a perfectly valid
 * instant to `Intl`, so the sentinel formats as a plausible clock time —
 * "4:00 p.m." in `America/Los_Angeles` — and a caller that forgets to branch
 * ships a confident lie about when the card opens instead of something anybody
 * would notice. Returning null makes the omission render as the literal `null`,
 * which a test catches at a glance and a reviewer cannot miss.
 */
export function formatUnlockTime(unlockAt: number, timeZone: string): string | null {
  if (!hasScheduledUnlock({ unlockAt })) return null;
  const fmt = (tz: string): string =>
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(
      new Date(unlockAt),
    );
  let out: string;
  try {
    out = fmt(timeZone);
  } catch {
    out = fmt('UTC');
  }
  // CMOS-style lowercase meridiem with periods, matching the app's copy.
  return out.replace(/\s*AM$/, ' a.m.').replace(/\s*PM$/, ' p.m.');
}

/** "🇲🇹 Valletta", "Valletta", or `''` when the Day names no Place. The
 *  neutral place label wins; legacy `portEmoji` takes precedence while both
 *  fields are dual-written, preserving a live operator correction. */
function placeLabel(day: EmailDay): string {
  const place = (day.place ?? day.port ?? '').trim();
  if (!place) return '';
  const emoji = (day.portEmoji ?? day.placeEmoji ?? '').trim();
  return emoji ? `${emoji} ${place}` : place;
}

// --- The assembled model --------------------------------------------------------

/** The standings module, already resolved to its rendered state. */
export interface StandingsModule {
  heading: string;
  /** Top three; empty on the empty state. */
  rows: StandingsRow[];
  /** The empty-state sentence, or `null` when `rows` carries the snapshot. */
  emptyLine: string | null;
  /** The one per-recipient line in the whole send, or `null` when the
   *  recipient is not on the roster (an admin-only address, say). */
  youLine: string | null;
}

/** Everything the HTML and plain-text renderers need, and nothing they must
 *  compute. Both parts read THIS, so they cannot drift in content — only in
 *  presentation, which is the entire point of a multipart/alternative pair. */
export interface DailyEmailModel {
  edition: string;
  register: EditionRegister;
  theme: EmailThemeTokens;
  subject: string;
  preheader: string;
  /** "💦 Sporty Splash" — Theme emoji + label. */
  themeHeadline: string;
  /** "Day 4 of 10 · Saturday, Jul 18 · 🇲🇹 Valletta" */
  contextLine: string;
  standings: StandingsModule;
  nudgeHeading: string;
  /** "Morning, Theo. The boat docks in Valletta today—your Day 4 card is live: 24 fresh squares." */
  nudgeLine: string;
  /** "🍷 Deck wine · 🎬 The Birds", or `null` when the Day publishes none. */
  tonightLine: string | null;
  photosHeading: string;
  /** Emphasised lead clause of the photos nudge. */
  photosLead: string;
  photosRest: string;
  /** "most-loved photo of the cruise" — the emphasised span of the award line. */
  awardLead: string;
  awardRest: string;
  ctaLabel: string;
  ctaUrl: string;
  footerBrandLine: string;
  footerWhyLine: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}

export interface BuildDailyEmailArgs {
  event: EmailEvent;
  day: EmailDay;
  /** The full roster, already ban-filtered by the caller. */
  players: readonly EmailPlayer[];
  /**
   * `standingsThrough(players, day.index, tutorialDays, ceremonialDays)`,
   * precomputed. Optional and purely a cost lever: the snapshot is IDENTICAL
   * for every recipient (the rank line is a lookup into it, not a per-recipient
   * computation), so a send to a full roster would otherwise re-slice and
   * re-sort the roster once per recipient — quadratic in roster size for no
   * different answer. The sender computes it once and passes it here; a caller
   * that omits it gets the same result, just recomputed.
   */
  ranked?: readonly EmailPlayer[];
  /** Historical First-to-BINGO holder, resolved by `eventFirstBingoUid` from
   *  the RAW roster — never read off `ranked`, whose `firstBingoAt` carries the
   *  standings tie-break rather than the honour (#1052). `undefined` lets the
   *  model derive it from `players`; `null` records that nobody holds it. The
   *  sender passes it explicitly so a presentational ban hides the holder's row
   *  without promoting a later Player. */
  starUid?: string | null;
  /** The recipient — their row drives the one personalized line. */
  recipient: { uid: string; displayName: string };
  edition: string | null | undefined;
  /** Deep link to the Event's canonical host Feed (#599). */
  feedUrl: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}

/**
 * Assemble one recipient's email model.
 *
 * The ONLY per-recipient variance is the greeting and the "You're #N" line
 * (the wireframe says so explicitly) — everything else is identical across the
 * send, which is what makes a per-recipient send affordable at all: the Event
 * is read once and only the two personal strings are recomputed.
 */
export function buildDailyEmailModel(args: BuildDailyEmailArgs): DailyEmailModel {
  const { event, day, players, recipient, feedUrl } = args;
  const register = registerFor(args.edition);
  const theme = emailThemeTokens(day.theme, args.edition);
  const timeZone = event.timezone || 'UTC';
  const days = Array.isArray(event.days) ? event.days : [];
  const dayNumber = day.index + 1;
  const dayCount = days.length || dayNumber;
  const eventName = (event.name ?? '').trim() || 'this event';

  // --- ② Theme header -----------------------------------------------------------
  const themeHeadline = `${theme.emoji} ${theme.label}`;
  const place = placeLabel(day);
  const contextLine = [`Day ${dayNumber} of ${dayCount}`, formatDayDate(day.date), place]
    .filter((part) => part !== '')
    .join(' · ');

  // --- ③ Standings snapshot -----------------------------------------------------
  // Two independent policy sets, resolved from the schedule (ADR 0011): the
  // ranked rows drop ceremonial score and a Tutorial-or-ceremonial tie-break,
  // while the ⭐ is derived separately from the raw roster with the
  // Tutorial-only exclusion and the Event's resolved Standings Freeze. The
  // sender precomputes both and passes them in; a caller that omits them gets
  // the same answers, just recomputed (#1052).
  const tutorialDays = tutorialDayIndexes(days);
  const ranked =
    args.ranked ?? standingsThrough(players, day.index, tutorialDays, ceremonialDayIndexes(days));
  const holderUid =
    args.starUid === undefined
      ? eventFirstBingoUid(
          // The roster as given, NOT the ranked rows: the honour is read off each
          // Player's own buckets, and an exact-millisecond tie is broken by uid,
          // so ranking this first would change nothing (Codex P2, #1052).
          players,
          day.index,
          tutorialDays,
          // The ALREADY-GUARDED `days`, not `event`: a raw Event doc whose
          // `days` is not an array would otherwise make the resolver's
          // `for…of` throw and take the whole send down, and this module's
          // contract is that everything is a function of its arguments.
          standingsFreezeAtFor({ standingsFreezeAt: event.standingsFreezeAt, days }),
        )
      : args.starUid;
  // THE HONOUR IS NOT GATED ON THE SCORE (Codex P2 on this PR). An Event whose
  // only play so far landed on ceremonial Days has an all-zero board AND a real
  // ⭐ holder — the exact combination the policy above deliberately creates —
  // and reporting the empty state there would print "every honor is wide open"
  // while the Card and the Leaderboard show a First to BINGO. That is the
  // email-versus-app contradiction this whole change exists to remove, so a held
  // honour is itself reason enough to render the snapshot: every row honestly
  // reads 0 bingos · 0 sq, because none of those Marks scored, and the ⭐ sits
  // where it belongs. The holder must be VISIBLE for that to help — a banned
  // holder is absent from `ranked` by design, and no visible Player is ever
  // promoted into their honour (specs/w2-ban-console.md).
  const holderVisible = holderUid != null && ranked.some((p) => p.uid === holderUid);
  const played = hasPlay(ranked) || holderVisible;
  const starUid = played ? holderUid : null;
  const rows: StandingsRow[] = played ? standingsRows(ranked, starUid) : [];
  const standingsHeading = played ? `Standings · through Day ${dayNumber - 1}` : `Standings · Day ${dayNumber}`;
  // Two empty states, not one. The OPENING Day has nothing to report because
  // nothing has happened yet, and says so with anticipation. A LATER Day with
  // an empty board is a different fact — the honors are still open, but "the
  // cruise starts today" would be plainly false on Day 4 (Codex #623 P2).
  const emptyLine = played
    ? null
    : dayNumber === 1
      ? `No standings yet—the ${register.occasion} starts today. First BINGO takes the ⭐ ${register.occasionWide} honor, and the first photo sets the bar.`
      : `Still no standings—every honor is wide open. First BINGO takes the ⭐ ${register.occasionWide} honor, and the first photo sets the bar.`;

  // The personalized line. `youLine` stays null for an address that is not on
  // the roster; ranking an absent Player would print a rank nobody holds.
  const youIndex = ranked.findIndex((p) => p.uid === recipient.uid);
  const you = youIndex >= 0 ? ranked[youIndex] : null;
  let youLine: string | null = null;
  if (you && played) {
    // "Your first BINGO is still out there" is a claim about the READER'S OWN
    // play, so it is answered from their own buckets rather than from the
    // ceremonial-excluded `bingoCount` or from whether they hold the ⭐ (Codex P2,
    // round 2). A Player who bingoed on a ceremonial Day has bingoed; the policy
    // removed its score, not the Mark. With no scoring squares either there is
    // nothing true left to say about their standings, so the line is omitted —
    // the choice this module already makes for an off-roster address.
    const bingoStillOpen = !hasBingoThrough(you, day.index);
    const squares = `${you.squaresMarked} square${you.squaresMarked === 1 ? '' : 's'}`;
    const tail =
      you.bingoCount > 0
        ? `${you.bingoCount} bingo${you.bingoCount === 1 ? '' : 's'} and ${squares} so far.`
        : you.squaresMarked > 0
          ? bingoStillOpen
            ? `${squares} marked—your first BINGO is still out there.`
            : `${squares} marked so far.`
          : bingoStillOpen
            ? 'your first BINGO is still out there.'
            : null;
    youLine = tail === null ? null : `You're #${youIndex + 1}—${tail}`;
  }

  // --- ④ Participation nudge ----------------------------------------------------
  const firstName = (recipient.displayName || '').trim().split(/\s+/)[0] || '';
  const greeting = firstName ? `Morning, ${firstName}. ` : 'Morning. ';
  // The arrival line names the Place WITHOUT its flag emoji: the flag rides the
  // context line, and a flag mid-sentence reads as decoration rather than data.
  const arrivalPlace = (day.place ?? day.port ?? '').trim();
  const arrival = arrivalPlace ? register.arrivalLine(arrivalPlace) : register.arrivalLineNoPlace;
  // The opening Day of an Event that uses the open sentinel has no unlock hour
  // to promise — it is already live — so the copy says so rather than quoting
  // the epoch (#723).
  const unlockClock = formatUnlockTime(day.unlockAt, timeZone);
  const liveWhen = unlockClock ? `live at ${unlockClock}` : 'live now';
  const nudgeLine = `${greeting}${arrival}—your Day ${dayNumber} card is ${liveWhen}: 24 fresh squares.`;
  const tonight = (day.tonight ?? []).filter((t) => typeof t === 'string' && t.trim() !== '');
  const tonightLine = tonight.length > 0 ? tonight.join(' · ') : null;

  // --- ⑤ Photos + the Most-Loved Photo award (#534) -----------------------------
  const awardLead = `most-loved photo of the ${register.occasion}`;
  const awardRest = ' takes an award at the finale—Hearts on photo Proofs decide it, frozen at the Standings Freeze.';

  // --- ① Preheader and the subject ----------------------------------------------
  const tail = played ? register.subjectTail : register.subjectTailDayOne;
  const subject = `Day ${dayNumber} · ${theme.label} ${theme.emoji}—${tail}`;
  // ~85 characters, the Day plus one hook — never a second sentence, because
  // clients truncate hard and the hook is what earns the open.
  const preheader = played
    ? `Day ${dayNumber}: ${theme.label}—standings through Day ${dayNumber - 1} inside.`
    : unlockClock
      ? `Day ${dayNumber} is here—your card unlocks at ${unlockClock}.`
      : `Day ${dayNumber} is here—your card is live now.`;

  return {
    edition: args.edition || DEFAULT_EMAIL_EDITION,
    register,
    theme,
    subject,
    preheader,
    themeHeadline,
    contextLine,
    standings: { heading: standingsHeading, rows, emptyLine, youLine },
    nudgeHeading: 'Today',
    nudgeLine,
    tonightLine,
    photosHeading: 'Photos',
    photosLead: register.photosLead,
    photosRest: register.photosRest,
    awardLead,
    awardRest,
    ctaLabel: 'Open the Feed',
    ctaUrl: feedUrl,
    footerBrandLine: register.brandLine,
    footerWhyLine: register.whyYouGotThis(eventName),
    unsubscribeUrl: args.unsubscribeUrl,
    preferencesUrl: args.preferencesUrl,
  };
}
