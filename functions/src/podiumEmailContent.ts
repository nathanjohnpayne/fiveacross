/**
 * Winner-announcement email CONTENT (issue #1192,
 * `plans/daily-cards-wireframes.html` frame `#fx-email-finale-gcb` and its
 * numbered legend). The last mail an Event sends, and the only one at or after
 * its Standings Freeze: #1121 stops the daily card there because nothing it
 * says is still true, and this is what speaks in its place.
 *
 * Pure, like `dailyEmailContent.ts` beside it — takes the podium payload the
 * in-app Moment carries plus the frozen Most-Loved award, and returns a model.
 * No clock, no I/O, no SDKs. The clock questions (has the freeze passed, has
 * this recipient been mailed) all live in `podiumEmail.ts`, which is what keeps
 * this file's output a pure function of the frozen record.
 *
 * WHY IT IS FED THE PAYLOAD RATHER THAN THE ROSTER. The podium Moment is
 * immutable and the Leaderboard agrees with it; an email that re-derived the
 * champion from a roster read would be a fourth selector of the same honours,
 * and #1052 is the record of what happens when selectors of one honour are
 * handed different inputs. So `buildPodiumEmailModel` takes
 * `buildPodiumPayload`'s own output and the parity test pins the email's
 * headline rows to the payload's fields.
 */
import type { EmailThemeTokens } from './dailyEmailTheme';
import { emailThemeTokens } from './dailyEmailTheme';
import type { EditionRegister } from './dailyEmailContent';
import { registerFor } from './dailyEmailContent';
import type { PodiumPayload } from './finaleContent';
// Same source `finaleContent.ts` imports them from — the award types are app
// package types, not this module's own.
import type { MostLovedPhotoAward } from '../../src/domainTypes';

/** One rendered standings row. Structurally the daily card's `StandingsRow`
 *  minus `starred`: the ⭐ is its own module here, because the Event-wide
 *  honour excludes Tutorial Days and so frequently belongs to someone outside
 *  the top three (frame legend item 4). */
export interface FinaleStandingsRow {
  uid: string;
  rank: number;
  displayName: string;
  bingoCount: number;
  squaresMarked: number;
}

/** The minimal roster shape the ranking needs — the podium's own re-aggregated
 *  totals, never live buckets. */
export interface FinaleRankedPlayer {
  uid: string;
  displayName: string;
  bingoCount: number;
  squaresMarked: number;
}

/** How many rows the standings module prints. The wireframe's frame shows
 *  three; a smaller Event simply prints what it has. */
export const FINALE_STANDINGS_ROWS = 3;

export interface PodiumEmailModel {
  edition: string;
  register: EditionRegister;
  theme: EmailThemeTokens;
  subject: string;
  preheader: string;
  /** "👋 So Long, Farewell" — Theme emoji + label, or the platform band's own
   *  headline for an Edition whose closing Day carries no vignette Theme. */
  themeHeadline: string;
  /** "Final standings · Day 10 of 10 · Friday, Jul 24 · 🇪🇸 Barcelona" */
  contextLine: string;
  standingsHeading: string;
  /** Top three (or fewer). Empty only when the Event's board was empty. */
  standingsRows: FinaleStandingsRow[];
  /** The empty-board sentence, or `null` when `standingsRows` carries the
   *  podium. */
  standingsEmptyLine: string | null;
  starHeading: string;
  /** "Logan Murdock took the cruise-wide First to BINGO—Day 2 in Split 🇭🇷.",
   *  or `null` when the Event has no eligible holder — in which case the module
   *  is omitted rather than printing a withheld honour (#1121's lesson: an
   *  empty state that advertises a closed honour is worse than no module). */
  starLine: string | null;
  mostLovedHeading: string;
  /** The award line, or `null` for an Event with no eligible photo — the
   *  module is omitted rather than printing a zero. */
  mostLovedLine: string | null;
  /** The reader's own final placing, or `null` for an address that is not on
   *  the roster. The daily card's rule, unchanged. */
  youLine: string | null;
  signOffLine: string;
  ctaLabel: string;
  ctaUrl: string;
  footerBrandLine: string;
  footerWhyLine: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}

export interface BuildPodiumEmailArgs {
  /** The Event's name, for the footer's why-you-got-this line. */
  eventName: string;
  /** The podium payload as the Moment carries it — `buildPodiumPayload`'s
   *  return value, passed through rather than recomputed. */
  podium: PodiumPayload;
  /** The frozen Most-Loved award, or `null`/`undefined` for an Event whose
   *  award was never computed. */
  mostLoved?: MostLovedPhotoAward | null;
  /**
   * The full standings, already ranked by `compareFinalePlayers` and
   * ban-filtered, from which the top rows and the reader's placing are read.
   *
   * ROW 1 MUST EQUAL `podium.champion`, and `tests/functions/finale-parity.test.ts`
   * pins that. The caller derives this from the same re-aggregated rows
   * `buildPodiumPayload` sorted, so the two cannot disagree; passing the ranked
   * list rather than re-sorting here keeps the cost off the per-recipient path.
   */
  ranked: readonly FinaleRankedPlayer[];
  /** The closing Day's Theme id, and its position in the schedule. */
  closingDay: {
    themeId?: string | null;
    /** 1-based, for the "Day 10 of 10" context line. */
    dayNumber: number;
    dayCount: number;
    /** "Friday, Jul 24", already formatted in the Event's timezone. */
    dateLabel: string;
    /** "🇪🇸 Barcelona", or `''` when the Day names no Place. */
    placeLabel: string;
  };
  /** The Day each honour was won on, for the ⭐ line: `dayIndex` → its label
   *  ("Day 2 in Split 🇭🇷"). A missing entry drops the qualifier rather than
   *  inventing one. */
  honorDayLabels?: Readonly<Record<number, string>>;
  recipient: { uid: string; displayName: string };
  edition: string | null | undefined;
  feedUrl: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}

/** "16 bingos · 124 sq" — the stat cell, pluralised. Shared by both parts so
 *  the HTML and the text cannot disagree about a singular. */
export function finaleStatLine(row: FinaleStandingsRow | FinaleRankedPlayer): string {
  return `${row.bingoCount} bingo${row.bingoCount === 1 ? '' : 's'} · ${row.squaresMarked} sq`;
}

/**
 * The ⭐ line, or `null` when nobody holds the honour.
 *
 * The Day qualifier is OPTIONAL on purpose. `PodiumFirstBingo` carries a
 * timestamp, not a Day index — the honour is the earliest qualifying bingo
 * Event-wide, and which Day that fell on is a join the caller may or may not
 * have made. A caller that resolved it gets "—Day 2 in Split 🇭🇷"; one that did
 * not gets the sentence without it, rather than a formatted guess.
 */
function starLineFor(
  podium: PodiumPayload,
  register: EditionRegister,
  honorDayLabels: Readonly<Record<number, string>> | undefined,
): string | null {
  const star = podium.firstBingo;
  if (!star) return null;
  // MATCHED BY TIMESTAMP, NOT BY EARLIEST INDEX (Codex P2 on PR #1207). The
  // Event-wide honour IS one of the pinned daily honours, but "the earliest Day
  // this uid holds" is a different row whenever the holder ALSO took a Tutorial
  // Day: the Event-wide honour excludes Tutorial Days, so that earlier pin is
  // ineligible for it, and naming its Day would date the honour to a morning
  // that did not win it. `firstBingo.at` identifies the qualifying bingo
  // exactly, so the Day is the honour whose instant equals it — and a uid check
  // beside it, because two Players can hold separate honours at one instant.
  const own = podium.dailyHonors.find((h) => h.uid === star.uid && h.at === star.at);
  const label = own && honorDayLabels ? honorDayLabels[own.dayIndex] : undefined;
  const where = label ? `—${label}` : '';
  return `${star.displayName} took the ${register.occasionWide} First to BINGO${where}.`;
}

/**
 * The Most-Loved Photo line, or `null` when there is no award to print.
 *
 * A TIE PRINTS THE HERO AND SAYS SO. `buildMostLovedPhotoAward` returns every
 * proof at the maximum eligible Heart count, with `winners[0]` the share hero
 * and `winnerCount` the complete tied cardinality — so an email that printed
 * only `winners[0]` would silently award one of several, and one that printed
 * all of them would have no bound. The hero plus the count is the honest
 * bounded form, and it matches the share card's own choice of hero.
 */
function mostLovedLineFor(
  award: MostLovedPhotoAward | null | undefined,
  register: EditionRegister,
): string | null {
  if (!award) return null;
  const hero = award.winners[0];
  // `{ winners: [], heartCount: 0 }` is the EXPLICIT no-award record, not a
  // missing computation (see `buildMostLovedPhotoAward`), so it is rendered as
  // no module rather than as a zero.
  if (!hero || award.heartCount < 1) return null;
  const prompt = hero.promptText.trim();
  const quoted = prompt ? ` "${prompt}"` : '';
  const hearts = `❤ ${award.heartCount}`;
  // `winnerCount` is ABSENT on records written before the bounded format, where
  // `winners` WAS the complete tie — so the retained prefix's length is the
  // right fallback, and a legacy record reports its true tie rather than none.
  const tied = award.winnerCount ?? award.winners.length;
  const others = tied - 1;
  const shared =
    others > 0
      ? ` Shared with ${others} other photo${others === 1 ? '' : 's'} on the same count.`
      : '';
  return (
    `${hero.displayName}—the most-loved photo of the ${register.occasion}:` +
    `${quoted}. ${hearts}, frozen at the Standings Freeze.${shared}`
  );
}

/**
 * The ~85-character preheader, naming only the honours this email actually
 * carries. Four cases, because both honours are independently absent: an Event
 * can have a ⭐ and no eligible photo, a photo and no ⭐ (every bingo landed on
 * a Tutorial Day), both, or — on an empty board — neither.
 */
function podiumPreheader(
  hasStar: boolean,
  hasMostLoved: boolean,
  register: EditionRegister,
): string {
  if (hasStar && hasMostLoved) {
    return 'The podium is in—see who took the ⭐ and the Most-Loved Photo.';
  }
  if (hasStar) return 'The podium is in—see who took the ⭐.';
  if (hasMostLoved) return 'The podium is in—see who took the Most-Loved Photo.';
  return `The final standings are in—that's the ${register.occasion}.`;
}

/** The reader's own final placing, or `null` when they are not on the roster.
 *  Past tense throughout: nothing moves after the freeze. */
function youLineFor(
  ranked: readonly FinaleRankedPlayer[],
  recipientUid: string,
): string | null {
  const index = ranked.findIndex((p) => p.uid === recipientUid);
  if (index < 0) return null; // off-roster address — no rank line at all
  const me = ranked[index];
  const bingos = `${me.bingoCount} bingo${me.bingoCount === 1 ? '' : 's'}`;
  const squares = `${me.squaresMarked} square${me.squaresMarked === 1 ? '' : 's'}`;
  return `You finished #${index + 1}—${bingos} and ${squares}.`;
}

/**
 * Assemble one recipient's winner-announcement model.
 *
 * The only per-recipient variance is `youLine` — everything else is identical
 * across the send, exactly as it is for the daily card, which is what makes a
 * per-recipient fan-out affordable.
 */
export function buildPodiumEmailModel(args: BuildPodiumEmailArgs): PodiumEmailModel {
  const register = registerFor(args.edition);
  const theme = emailThemeTokens(args.closingDay.themeId, args.edition);
  const champion = args.podium.champion;
  // Resolved BEFORE the preheader, which is built from which of them rendered.
  const starLine = starLineFor(args.podium, register, args.honorDayLabels);
  const mostLovedLine = mostLovedLineFor(args.mostLoved ?? null, register);

  // ① The subject names the champion (#1192 decision), the register supplies
  // the verb, and an empty board falls back to the occasion close because there
  // is no name to print.
  const subject = `Final standings 🏆—${
    champion ? register.finaleSubjectTail(champion.displayName) : register.finaleSubjectTailNoChampion
  }`;
  // BUILT FROM THE HONOURS THAT ACTUALLY RENDER (Codex P2 on PR #1207). The
  // body already omits the ⭐ and the award when the Event has no holder, for
  // the reason #1121 exists — but a constant preheader made exactly the claim
  // those omissions avoid, and an inbox preview shows it BEFORE the message is
  // opened, so the misleading version is the one most people would read. The
  // honours are named only when they are there, and an Event with neither gets
  // neutral finale copy rather than a sentence about nothing.
  const preheader = podiumPreheader(
    starLine !== null,
    mostLovedLine !== null,
    register,
  );

  const rows: FinaleStandingsRow[] = args.ranked
    .slice(0, FINALE_STANDINGS_ROWS)
    .map((p, i) => ({
      uid: p.uid,
      rank: i + 1,
      displayName: p.displayName,
      bingoCount: p.bingoCount,
      squaresMarked: p.squaresMarked,
    }));

  // An empty board is the one state with no rows: `champion` is `null` exactly
  // when nobody marked anything, which is the same condition
  // `buildPodiumPayload` applies.
  const emptyBoard = champion === null;
  const contextPlace = args.closingDay.placeLabel.trim();

  return {
    edition: args.edition ?? '',
    register,
    theme,
    subject,
    preheader,
    themeHeadline: `${theme.emoji} ${theme.label}`,
    contextLine: [
      'Final standings',
      `Day ${args.closingDay.dayNumber} of ${args.closingDay.dayCount}`,
      args.closingDay.dateLabel,
      ...(contextPlace ? [contextPlace] : []),
    ].join(' · '),
    standingsHeading: 'Final standings · frozen',
    standingsRows: emptyBoard ? [] : rows,
    standingsEmptyLine: emptyBoard
      ? `Nobody marked a square this ${register.occasion}—the board closed empty.`
      : null,
    starHeading: 'The ⭐',
    starLine,
    mostLovedHeading: 'Most-loved photo',
    mostLovedLine,
    youLine: youLineFor(args.ranked, args.recipient.uid),
    signOffLine: register.finaleSignOff,
    ctaLabel: 'Open the Feed',
    ctaUrl: args.feedUrl,
    footerBrandLine: register.brandLine,
    footerWhyLine: register.whyYouGotThis(args.eventName),
    unsubscribeUrl: args.unsubscribeUrl,
    preferencesUrl: args.preferencesUrl,
  };
}
