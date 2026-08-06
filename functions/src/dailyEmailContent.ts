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
import { compareFinalePlayers, tutorialDayIndexes, type FinaleDayStat } from './finaleContent';
import { emailThemeTokens, type EmailThemeTokens } from './dailyEmailTheme';

// --- Minimal domain shapes (local, package-decoupled) ---------------------------

/** The subset of a `DayDef` the email reads. */
export interface EmailDay {
  index: number;
  /** ISO date, e.g. '2026-07-18'. Formatted in the Event's timezone. */
  date?: string;
  port?: string;
  portEmoji?: string;
  theme?: string;
  /** The night's signature events, rendered as the "Tonight:" line. */
  tonight?: string[];
  tutorial?: boolean;
  /** ms epoch — the Day's unlock, and this email's send moment. */
  unlockAt: number;
}

/** The subset of an `EventDoc` the email reads. */
export interface EmailEvent {
  name?: string;
  timezone?: string;
  days?: EmailDay[];
  bannedUids?: string[];
  settings?: { dailyEmailEnabled?: boolean };
}

/** The subset of a `PlayerDoc` the standings snapshot reads. */
export interface EmailPlayer {
  uid: string;
  displayName: string;
  bingoCount: number;
  squaresMarked: number;
  firstBingoAt: number | null;
  dayStats?: Record<number, FinaleDayStat>;
}

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
  /** Footer brand line. Vacay carries the endorsement (one-identity rule). */
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
    brandLine: 'Gay Cruise Bingo',
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
  // 🗺️ Vacay Bingo — trip register at moderate camp.
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

// --- Standings ------------------------------------------------------------------

/**
 * Every Player's totals THROUGH a Day — i.e. summed over `dayStats` entries
 * strictly BEFORE `throughDayIndexExclusive`. The email reports standings
 * "through yesterday" because today's card has only just unlocked, so today's
 * marks are all zero and a snapshot including them would be identical but
 * mislabelled.
 *
 * TUTORIAL DAYS COUNT FOR SCORE BUT NOT FOR THE ⭐ (ADR 0011, and the parity
 * `finaleContent.ts` already keeps with `src/game/logic.ts`). Bingos and squares
 * from a Tutorial Day are real play and are summed; the Event-wide First to
 * BINGO honor deliberately excludes them, and so does the `firstBingoAt`
 * tie-break that rides on it — otherwise an embark-Day winner would take the
 * ⭐ in the email while the in-app Leaderboard gave it to someone else, which
 * is the exact contradiction ADR 0011 exists to prevent (Codex #623 P2).
 *
 * A Player with no `dayStats` breakdown (a legacy roster predating Day Cards)
 * keeps their root aggregates — there is nothing to slice — matching
 * `podiumStandingRow`'s handling in `finaleContent.ts`. Ranking is
 * `compareFinalePlayers`, so the email, the podium and the in-app Leaderboard
 * can never disagree about who is ahead.
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
        if (typeof stat.bingoCount === 'number' && Number.isFinite(stat.bingoCount)) {
          bingoCount += stat.bingoCount;
        }
        if (typeof stat.squaresMarked === 'number' && Number.isFinite(stat.squaresMarked)) {
          squaresMarked += stat.squaresMarked;
        }
        if (tutorialDays.has(dayIndex)) continue; // scores yes, ⭐ no
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
 *  (Day 1, or a Day nobody has played) rather than a podium of ties. */
function hasPlay(ranked: readonly EmailPlayer[]): boolean {
  return ranked.some((p) => p.bingoCount > 0 || p.squaresMarked > 0);
}

/** The uid holding the Event-wide First to BINGO pin (⭐) across the ranked
 *  slice, or `null` when nobody has one. Earliest `firstBingoAt` wins. */
function firstBingoUid(ranked: readonly EmailPlayer[]): string | null {
  let best: EmailPlayer | null = null;
  for (const p of ranked) {
    if (p.firstBingoAt == null) continue;
    if (!best || p.firstBingoAt < (best.firstBingoAt as number)) best = p;
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

/** "8:00 a.m." — the Day's unlock in the Event's timezone. */
export function formatUnlockTime(unlockAt: number, timeZone: string): string {
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

/** "🇲🇹 Valletta", "Valletta", or `''` when the Day names no Place. */
function placeLabel(day: EmailDay): string {
  const port = (day.port ?? '').trim();
  if (!port) return '';
  const emoji = (day.portEmoji ?? '').trim();
  return emoji ? `${emoji} ${port}` : port;
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
   * `standingsThrough(players, day.index)`, precomputed. Optional and purely a
   * cost lever: the snapshot is IDENTICAL for every recipient (the rank line is
   * a lookup into it, not a per-recipient computation), so a send to a full
   * roster would otherwise re-slice and re-sort the roster once per recipient —
   * quadratic in roster size for no different answer. The sender computes it
   * once and passes it here; a caller that omits it gets the same result, just
   * recomputed.
   */
  ranked?: readonly EmailPlayer[];
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
  const ranked = args.ranked ?? standingsThrough(players, day.index, tutorialDayIndexes(days));
  const played = hasPlay(ranked);
  const starUid = played ? firstBingoUid(ranked) : null;
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
    const tail =
      you.bingoCount > 0
        ? `${you.bingoCount} bingo${you.bingoCount === 1 ? '' : 's'} and ${you.squaresMarked} square${you.squaresMarked === 1 ? '' : 's'} so far.`
        : you.squaresMarked > 0
          ? `${you.squaresMarked} square${you.squaresMarked === 1 ? '' : 's'} marked—your first BINGO is still out there.`
          : 'your first BINGO is still out there.';
    youLine = `You're #${youIndex + 1}—${tail}`;
  }

  // --- ④ Participation nudge ----------------------------------------------------
  const firstName = (recipient.displayName || '').trim().split(/\s+/)[0] || '';
  const greeting = firstName ? `Morning, ${firstName}. ` : 'Morning. ';
  // The arrival line names the Place WITHOUT its flag emoji: the flag rides the
  // context line, and a flag mid-sentence reads as decoration rather than data.
  const port = (day.port ?? '').trim();
  const arrival = port ? register.arrivalLine(port) : register.arrivalLineNoPlace;
  const nudgeLine = `${greeting}${arrival}—your Day ${dayNumber} card is live at ${formatUnlockTime(day.unlockAt, timeZone)}: 24 fresh squares.`;
  const tonight = (day.tonight ?? []).filter((t) => typeof t === 'string' && t.trim() !== '');
  const tonightLine = tonight.length > 0 ? tonight.join(' · ') : null;

  // --- ⑤ Photos + the Most-Loved Photo award (#534) -----------------------------
  const awardLead = `most-loved photo of the ${register.occasion}`;
  const awardRest = ' takes an award at the finale—Hearts on photo Proofs decide it, frozen at the Standings Freeze.';

  // --- ① Preheader and the subject ----------------------------------------------
  const tail = played ? register.subjectTail : register.subjectTailDayOne;
  const subject = `Day ${dayNumber} · ${theme.label} ${theme.emoji} — ${tail}`;
  // ~85 characters, the Day plus one hook — never a second sentence, because
  // clients truncate hard and the hook is what earns the open.
  const preheader = played
    ? `Day ${dayNumber}: ${theme.label}—standings through Day ${dayNumber - 1} inside.`
    : `Day ${dayNumber} is here—your card unlocks at ${formatUnlockTime(day.unlockAt, timeZone)}.`;

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
