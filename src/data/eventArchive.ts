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
  ArchivedFirstBingoRow,
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

/**
 * How long a name the frozen record keeps, per row (#134, Codex P2 on PR #1139).
 *
 * `players/{uid}` is self-written under the honour system (ADR 0001) and its
 * rules arm validates neither the presence nor the LENGTH of `displayName`, so a
 * Player can put an arbitrarily long string on their own row. The archive copies
 * that row into the Event document, where 200 of them share one 1 MiB budget —
 * so one over-long name is enough to make the archive write fail, permanently,
 * AFTER the closing write has already shut the Event.
 *
 * 100 is the cap `firestore.rules` already enforces on every OTHER Player-authored
 * display name in the estate (the per-Day honour pin, Tally markers, Moments,
 * Proofs), and the profile editor's own limit is 40 (`MAX_DISPLAY_NAME`), so no
 * name a Player can enter through the app is ever touched by this.
 */
export const MAX_ARCHIVED_DISPLAY_NAME = 100;

/**
 * The size ceiling the frozen record must fit under, in bytes of serialized JSON.
 *
 * A quarter of the Event document's 1 MiB budget, leaving three quarters for the
 * fields the archive shares it with (`days` with its per-Day snapshot id lists,
 * `bannedUids` at up to 1000 entries, `mostLovedPhoto`). The margin is deliberately
 * enormous: with rows bounded at `MAX_ARCHIVED_STANDING_ROWS` and names at
 * `MAX_ARCHIVED_DISPLAY_NAME` a real record is tens of kilobytes, so this is the
 * BACKSTOP for whatever those two clamps did not anticipate rather than a limit
 * any Event is expected to approach.
 *
 * Measured as UTF-8 bytes of `JSON.stringify`, which over-approximates Firestore's
 * own accounting (it counts the punctuation Firestore does not) — over-approximating
 * is the safe direction for a ceiling.
 */
export const MAX_ARCHIVE_BYTES = 256 * 1024;

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

/**
 * Is this a `uid` the record can carry? (#134, Codex P2 on PR #1139.)
 *
 * A row with no usable id is unusable in every direction the archive needs: it
 * cannot be ban-filtered, it cannot be matched against the headline honour, the
 * Share Card cannot pin it — and, most immediately, Firestore REFUSES to
 * serialize an `undefined`, so one such row makes the whole archive write throw
 * after the closing write has already shut the Event. `players/{uid}` validates
 * no field in its rules arm (it is self-written under ADR 0001), so this is a
 * shape a Player can actually produce by deleting a field from their own row.
 */
function usableUid(uid: unknown): uid is string {
  return typeof uid === 'string' && uid.trim().length > 0;
}

/**
 * A display name the record can carry: trimmed, defaulted, and BOUNDED.
 *
 * `'Anonymous'` is the estate's existing stand-in for a nameless Player
 * (`functions/src/unlockDay.ts`'s roster read uses the same one), so a missing
 * name reads on the archived Leaderboard exactly as it does everywhere else
 * rather than rendering `undefined` or refusing to serialize.
 */
function archiveName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || 'Anonymous').slice(0, MAX_ARCHIVED_DISPLAY_NAME);
}

/** A count the record can carry. A non-finite or non-numeric stat reads as 0 —
 *  which is what the live Leaderboard already renders for the same row. */
function archiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** An instant the record can carry, or `null`. */
function archiveInstant(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Copy one Player's own written stats into a frozen standings row. No arithmetic
 * — whatever the Player's row said is what the record says (ADR 0001) — but the
 * values are COERCED to the shape the record's own contract declares.
 *
 * That is not adjudication: it decides nothing about who won. It is what makes
 * the row writable at all, on a document whose rules arm validates none of these
 * fields. See `usableUid` for the one malformation a row cannot survive.
 */
function toStandingRow(p: PlayerDoc): ArchivedStandingRow {
  return {
    uid: p.uid,
    displayName: archiveName(p.displayName),
    bingoCount: archiveCount(p.bingoCount),
    squaresMarked: archiveCount(p.squaresMarked),
    blackout: !!p.blackout,
    firstBingoAt: archiveInstant(p.firstBingoAt),
  };
}

/** How big this record would be on the Event document — UTF-8 bytes of its
 *  serialized JSON, which over-approximates Firestore's own accounting. */
function archiveBytes(archive: EventArchive): number {
  return new TextEncoder().encode(JSON.stringify(archive)).length;
}

/**
 * A record built but NOT yet committed, with everything the caller needs to
 * decide whether committing it is safe (#134, Codex P2 on PR #1139).
 *
 * The archive is TWO writes and the first one shuts the Event, so a record that
 * cannot be written has to be caught BEFORE the quiesce — otherwise every
 * attempt closes play and then fails, leaving an Event unplayable with nothing
 * to show for it. That is why the checks live here, beside the builder, rather
 * than in the `try` around the write.
 */
export interface EventArchiveDraft {
  /** The record itself, already coerced and bounded. */
  archive: EventArchive;
  /** Roster rows dropped for want of a usable `uid` (see `usableUid`). Stated on
   *  the confirm row so the Admin is told what the record will not contain,
   *  rather than discovering a short roster afterwards. Deliberately NOT stored
   *  in the record: the frozen shape is what the archived surfaces render, not a
   *  place to keep diagnostics. */
  skippedRows: number;
  /** `archiveBytes(archive)` — reported so the refusal below can quote it. */
  bytes: number;
  /** Non-null when this record must not be written. `'too-large'` means the
   *  coerced, bounded record STILL exceeds `MAX_ARCHIVE_BYTES`, which no clamp
   *  here can fix — the Admin has to be told rather than left with a shut Event. */
  refusal: 'too-large' | null;
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
 *    (`specs/w2-ban-console.md` § Leaderboard), made permanent. Their own
 *    standings row is kept beside it as `firstBingoRow`, with the rank they held
 *    in the COMPLETE standings, because the two bounds are independent: the
 *    prefix is cut by RANK and the honour is decided by who bingoed EARLIEST, so
 *    on a roster past `maxRows` the holder can fall outside the retained rows
 *    entirely and the Share Card's pinned row would have nothing to build from
 *    (Codex P2, PR #1139).
 *  - **Daily honours** come from `pinnedOrDerivedDailyHonors` — the write-once
 *    day-meta pin first, the roster-derived fallback for unpinned Days — over
 *    the ban-filtered roster, which is the same helper the frozen podium reads.
 *
 * `freezeAt` is the resolved Standings Freeze (`resolvedStandingsFreezeAt`), so
 * the archived hall of fame cuts on the SAME instant as the live pin, the podium
 * and the ceremonial `first_bingo` Moment. An Event with no freeze at all
 * (`null`) has no cutoff, which is the pre-ADR-0011 behaviour unchanged.
 *
 * THE INPUTS ARE VALIDATED, because `players/{uid}` validates nothing (#134,
 * Codex P2 on PR #1139). That row is self-written under the honour system and its
 * rules arm requires neither `uid`, `displayName`, `bingoCount` nor
 * `squaresMarked` — so a Player can delete a field from their own row, or store a
 * megabyte-long name, and the copy taken here would either refuse to serialize
 * (Firestore rejects `undefined`) or push the Event document past its 1 MiB limit.
 * Either way EVERY archive attempt would shut the Event and then fail, which is
 * the worst outcome the protocol can produce. So:
 *
 *  - a row with no usable `uid` is SKIPPED and counted (`EventArchiveDraft
 *    .skippedRows`) — it is unmatchable and unrenderable, so there is nothing to
 *    default it to;
 *  - every other malformation is COERCED to a safe default: a missing name reads
 *    `'Anonymous'`, a missing or non-finite count reads `0`, a bad instant reads
 *    `null`, and every name is bounded at `MAX_ARCHIVED_DISPLAY_NAME`;
 *  - and the finished record is measured against `MAX_ARCHIVE_BYTES`, which
 *    `draftEventArchive` reports as a REFUSAL rather than a throw so the caller
 *    can decline before taking the quiesce.
 *
 * None of that adjudicates a stat (ADR 0001): it decides nothing about who won,
 * it only makes the row expressible in the record's own declared shape.
 */
export function draftEventArchive(params: {
  players: readonly PlayerDoc[];
  event: ArchivableEvent | null | undefined;
  dayMetas?: ReadonlyMap<number, DayMetaDoc>;
  dayMetasLoaded?: boolean;
  archivedAt: number;
  maxRows?: number;
  maxBytes?: number;
}): EventArchiveDraft {
  const {
    players,
    event,
    dayMetas,
    dayMetasLoaded = true,
    archivedAt,
    maxRows = MAX_ARCHIVED_STANDING_ROWS,
    maxBytes = MAX_ARCHIVE_BYTES,
  } = params;
  const bannedUids = event?.bannedUids ?? [];
  const days = event?.days;
  const freezeAt = resolvedStandingsFreezeAt(event ?? null);
  const tutorialDays = tutorialDayIndexSet(days);
  const isTutorialDay = (i: number): boolean => tutorialDays.has(i);

  // Dropped FIRST, before any selection: an unidentifiable row must not be able
  // to win the headline honour or hold a daily one either, and every downstream
  // step here reads `uid`.
  const identified = players.filter((p) => usableUid(p.uid));
  const skippedRows = players.length - identified.length;

  const roster = identified.filter((p) => !isBanned(p.uid, bannedUids));
  const ranked = sortPlayers([...roster]);

  const winner = eventFirstBingoWinner(identified, isTutorialDay, freezeAt);
  const firstBingo =
    winner && !isBanned(winner.uid, bannedUids)
      ? { uid: winner.uid, displayName: archiveName(winner.displayName), at: archiveCount(winner.at) }
      : null;
  // The holder's own row, kept whole OUTSIDE the bounded prefix. A non-banned
  // winner is by construction somewhere in `ranked` (the selection ran over the
  // superset and the ban filter is the only thing that removes anyone), but the
  // lookup still resolves to `null` rather than asserting: a record that names a
  // row it does not carry is the failure this field exists to prevent.
  const holderAt = firstBingo ? ranked.findIndex((p) => p.uid === firstBingo.uid) : -1;
  const firstBingoRow: ArchivedFirstBingoRow | null =
    holderAt >= 0 ? { ...toStandingRow(ranked[holderAt]), rank: holderAt + 1 } : null;

  const archive: EventArchive = {
    standings: ranked.slice(0, Math.max(0, maxRows)).map(toStandingRow),
    playerCount: ranked.length,
    firstBingo,
    firstBingoRow,
    // Coerced on the way out for the same reason the rows are: a derived honour
    // carries the Player's own `displayName`, and a pinned one carries whatever
    // the day-meta document holds. A non-integer `dayIndex` is dropped rather
    // than coerced — a derived honour reads it off a `dayStats` KEY, which is a
    // Player-written map, and a Day the schedule does not have is a chip nothing
    // could ever label. The live strip already drops it by matching against the
    // schedule; the record has to, because the record is permanent.
    dailyHonors: pinnedOrDerivedDailyHonors(ranked, days, dayMetas, dayMetasLoaded)
      .filter((h) => Number.isInteger(h.dayIndex))
      .map((h) => ({
        dayIndex: h.dayIndex,
        uid: h.uid,
        displayName: archiveName(h.displayName),
        firstBingoAt: archiveCount(h.firstBingoAt),
      })),
    freezeAt,
    archivedAt,
  };
  const bytes = archiveBytes(archive);
  return { archive, skippedRows, bytes, refusal: bytes > maxBytes ? 'too-large' : null };
}

/** The frozen record alone, for the callers that only render it (the Admin
 *  console's preview size line, the unit tests). `draftEventArchive` is the
 *  entry point for anything that is about to WRITE it — the refusal and the
 *  skipped-row count are what make the quiesce safe to take. */
export function buildEventArchive(
  params: Parameters<typeof draftEventArchive>[0],
): EventArchive {
  return draftEventArchive(params).archive;
}
