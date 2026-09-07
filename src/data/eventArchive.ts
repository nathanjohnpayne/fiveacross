// The post-Event archive's pure half (#134, specs/post-sailing-archive.md):
// deciding whether an Event is archived, and building the frozen final record
// the archived Leaderboard renders from. Firestore-free and React-free, so the
// snapshot rules are unit-testable without an emulator or a mounted component
// (the `src/data/finale.ts` precedent).
//
// ADR 0001 governs what this module may do. It SNAPSHOTS the client-authoritative
// standings — every number below is copied off a Player-written `PlayerDoc` — and
// it never recomputes, re-derives or "verifies" them. The only derivation it
// performs is the ORDER (`sortPlayers`) and the honour SELECTIONS
// (`eventFirstBingoWinner`, `pinnedOrDerivedDailyHonors`), and both are the very
// selectors the live Leaderboard already renders with, reused rather than
// restated: the frozen record must say what the last live Leaderboard said.
import { isBanned } from './moderation';
import { pinnedOrDerivedDailyHonors } from './finale';
import {
  eventFirstBingoWinner,
  resolvedStandingsFreezeAt,
  sortPlayers,
  tutorialDayIndexSet,
} from '../game/logic';
import type {
  ArchivedStandingRow,
  DayMetaDoc,
  EventArchive,
  EventDoc,
  PlayerDoc,
} from '../types';

/**
 * How many standings rows the frozen record retains. The Event document has one
 * 1 MiB budget that `days`, `bannedUids` (capped at 1000) and `mostLovedPhoto`
 * already draw on, so the roster copy is the one field that could make the
 * document unwritable — the same reason `MostLovedPhotoAward` bounds `winners`
 * and records `winnerCount` beside it. 200 is far above any real Event roster
 * (both live Events are two figures), so in practice nothing is ever dropped;
 * `EventArchive.playerCount` records the true cardinality when something is.
 */
export const MAX_ARCHIVED_STANDING_ROWS = 200;

/** The Event fields the archive builder and its callers read. */
export type ArchivableEvent = Pick<
  EventDoc,
  'days' | 'bannedUids' | 'frozenAt' | 'standingsFreezeAt'
>;

/**
 * Whether this Event is frozen (#134). The ONE place the client asks the
 * question, so no surface invents its own spelling of `status === 'archived'`
 * — `EventDoc.status` was a typed-but-dead field until this ticket, and a dead
 * field acquires several readers the moment it acquires one.
 *
 * NOT to be confused with `HostnameDoc.status`, a different field with a
 * different value set (`'active' | 'disabled' | 'archived'`) that decides
 * ADDRESSING before first paint (`src/eventResolution.ts`). An Event can be
 * archived while its hostname is still perfectly servable — that is how a
 * Player reaches the archive at all.
 */
export function isEventArchived(
  event: Pick<EventDoc, 'status'> | null | undefined,
): boolean {
  return event?.status === 'archived';
}

/**
 * Whether this Event is in the archive's QUIESCING phase (#134, spec § "The
 * quiesce protocol"): shut to gameplay by the Admin's first archive write, but
 * not yet frozen. The rules deny every gameplay write in this state exactly as
 * they do for an archived Event, so the roster the second write snapshots
 * cannot move underneath it.
 *
 * Deliberately SEPARATE from `isEventArchived`, and neither implies the other.
 * A closing Event has no `archive` to render — the Leaderboard stays live, and
 * correctly so, because the record does not exist yet — while an archived one
 * clears the flag. The one surface that cares about the difference is the Admin
 * console, which offers a closing Event both a way to finish and a way back.
 */
export function isEventArchiving(
  event: Pick<EventDoc, 'archiving'> | null | undefined,
): boolean {
  return event?.archiving === true;
}

/** Copy one Player's own written stats into a frozen standings row. No
 *  arithmetic: whatever the Player's row said is what the record says. */
function toStandingRow(p: PlayerDoc): ArchivedStandingRow {
  return {
    uid: p.uid,
    displayName: p.displayName,
    bingoCount: p.bingoCount,
    squaresMarked: p.squaresMarked,
    blackout: !!p.blackout,
    firstBingoAt: p.firstBingoAt ?? null,
  };
}

/**
 * Build the frozen final record: the Leaderboard's own standings plus the
 * First-to-BINGO hall of fame, as of `archivedAt`.
 *
 * The three derivations mirror `src/components/Leaderboard.tsx` clause for
 * clause, because the archive's promise is "the Leaderboard, kept":
 *
 *  - **Standings** are the BAN-FILTERED roster in `sortPlayers` order — exactly
 *    the rows the live Leaderboard lists and the Share Card prints. `sortPlayers`
 *    is a stable sort over the caller's array, so passing `useLeaderboard`'s
 *    already-ranked roster (the expected caller) reorders nothing; running it
 *    here anyway means the record cannot depend on a caller remembering to sort.
 *  - **The headline First to BINGO** is selected from the FULL, RAW roster
 *    through `eventFirstBingoWinner`, so a ban can never promote a later Player
 *    into an honour that already happened — then dropped to `null` if the holder
 *    is banned. Hidden, never reassigned: the same rule the live pin applies
 *    (`specs/w2-ban-console.md` § Leaderboard), made permanent.
 *  - **Daily honours** come from `pinnedOrDerivedDailyHonors` — the write-once
 *    day-meta pin first, the roster-derived fallback for unpinned Days — over
 *    the ban-filtered roster, which is the same helper the frozen podium reads.
 *
 * `freezeAt` is the resolved Standings Freeze (`resolvedStandingsFreezeAt`), so
 * the archived hall of fame cuts on the SAME instant as the live pin, the podium
 * and the ceremonial `first_bingo` Moment. An Event with no freeze at all
 * (`null`) has no cutoff, which is the pre-ADR-0011 behaviour unchanged.
 */
export function buildEventArchive(params: {
  players: readonly PlayerDoc[];
  event: ArchivableEvent | null | undefined;
  dayMetas?: ReadonlyMap<number, DayMetaDoc>;
  dayMetasLoaded?: boolean;
  archivedAt: number;
  maxRows?: number;
}): EventArchive {
  const {
    players,
    event,
    dayMetas,
    dayMetasLoaded = true,
    archivedAt,
    maxRows = MAX_ARCHIVED_STANDING_ROWS,
  } = params;
  const bannedUids = event?.bannedUids ?? [];
  const days = event?.days;
  const freezeAt = resolvedStandingsFreezeAt(event ?? null);
  const tutorialDays = tutorialDayIndexSet(days);
  const isTutorialDay = (i: number): boolean => tutorialDays.has(i);

  const roster = players.filter((p) => !isBanned(p.uid, bannedUids));
  const ranked = sortPlayers([...roster]);

  const winner = eventFirstBingoWinner(players, isTutorialDay, freezeAt);
  const firstBingo = winner && !isBanned(winner.uid, bannedUids) ? { ...winner } : null;

  return {
    standings: ranked.slice(0, Math.max(0, maxRows)).map(toStandingRow),
    playerCount: ranked.length,
    firstBingo,
    dailyHonors: pinnedOrDerivedDailyHonors(ranked, days, dayMetas, dayMetasLoaded),
    freezeAt,
    archivedAt,
  };
}
