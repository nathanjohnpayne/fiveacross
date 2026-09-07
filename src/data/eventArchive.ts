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
import { dayHonorChipLabel, pinnedOrDerivedDailyHonors } from './finale';
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

/**
 * The size ceiling the WHOLE Event document must fit under once the record has
 * landed on it, in bytes of serialized JSON (#134, Codex P2 on PR #1139).
 *
 * `MAX_ARCHIVE_BYTES` above bounds the record's own share of the budget. It
 * cannot bound the document, because the archive is not written to an empty
 * one: `days` carries a per-Day `snapshotItemIds` list, `bannedUids` holds up
 * to 1000 entries, `mostLovedPhoto` keeps up to 100 winners, and every one of
 * them is already there when the freeze commits. An Event that has grown large
 * on its own could therefore pass the record's quarter-budget and still push
 * the document past Firestore's 1 MiB limit — inside the transaction, AFTER the
 * closing write had already shut the Event, which is the one failure the
 * pre-quiesce validation exists to make impossible.
 *
 * So the guard measures the PROJECTED document: everything the update leaves in
 * place, plus the four fields it writes. 900 KiB leaves ~148 KiB of margin
 * under the real limit, which absorbs the difference between Firestore's own
 * accounting (field-name bytes, per-field and per-document overhead, the
 * document path) and `JSON.stringify`'s.
 */
export const MAX_ARCHIVED_EVENT_BYTES = 900 * 1024;

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
 * JSON with object keys in a fixed order, so two reads of an UNCHANGED document
 * always serialize identically. `JSON.stringify` follows insertion order, which
 * the Firestore SDK does not promise to reproduce across two decodes of the
 * same document — and a comparison that can report a spurious change would
 * abort archives at random.
 */
function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * A fingerprint of the Event configuration THE SNAPSHOT IS DEFINED BY (#134,
 * Codex P2 on PR #1139).
 *
 * `archiveEvent` reads the Claim queue, the roster and the Day honour pins
 * against the Event it PRE-READ, and then builds the record against the Event
 * its transaction reads. Between the two, an Admin can change the Event's
 * configuration — the quiesce shuts gameplay, not administration — and the
 * freeze would then combine reads taken for one configuration with a record
 * built for another. Two concrete ways that goes wrong:
 *
 *  - **`claimMode`.** The drain gate is scoped to `claimsQueueOpen`, so a queue
 *    read while the Event was on `honor` passes VACUOUSLY. Flipping to
 *    `admin_confirmed` afterwards makes every one of those pending Claims
 *    blocking — and unresolvable, because the freeze denies both writes their
 *    resolution consists of.
 *  - **`days`.** The schedule decides which Day honour pins were fetched at
 *    all, which Days are Tutorial (excluded from the headline honour), where a
 *    missing Standings Freeze is derived from, and the label each frozen
 *    honour chip carries. A schedule edited after the pins were read produces a
 *    record built from pins for a schedule that no longer exists.
 *
 * `standingsFreezeAt` and `frozenAt` ride along because they resolve the
 * honour cutoff the same reads were selected under.
 *
 * `bannedUids` is deliberately OUT. Moderation is not a gameplay write and
 * stays available through the quiesce on purpose; a ban is applied to the rows
 * the record keeps rather than deciding which rows were read, so a ban landing
 * mid-snapshot changes what the record CONTAINS in exactly the way it should.
 * Aborting on it would make the freeze race the one administrative action the
 * spec keeps open across it.
 */
export function archiveSnapshotFingerprint(
  event:
    | Partial<Pick<EventDoc, 'claimMode' | 'days' | 'standingsFreezeAt' | 'frozenAt'>>
    | null
    | undefined,
): string {
  return stableJson({
    claimMode: event?.claimMode ?? null,
    days: Array.isArray(event?.days) ? event.days : [],
    standingsFreezeAt: event?.standingsFreezeAt ?? null,
    frozenAt: event?.frozenAt ?? null,
  });
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

/** UTF-8 bytes of a value's serialized JSON, the stand-in this module measures
 *  Firestore payloads with. */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

/** How big this record would be on the Event document — UTF-8 bytes of its
 *  serialized JSON, which over-approximates Firestore's own accounting. */
function archiveBytes(archive: EventArchive): number {
  return jsonBytes(archive);
}

/**
 * How big the Event DOCUMENT would be once the freeze lands on it (#134, Codex
 * P2 on PR #1139): the stored fields the archive update leaves in place, plus
 * the four it writes.
 *
 * The record is not written to an empty document, and the fields it shares the
 * 1 MiB budget with are the ones that grow — `days` with its per-Day snapshot
 * id lists, `bannedUids`, `mostLovedPhoto`. Measuring the record alone let an
 * already-large Event pass the check and then overflow inside the transaction,
 * with gameplay already shut and no record to show for it.
 *
 * `archive` is dropped from the retained side because the update REPLACES it;
 * the other three archive fields are re-stated at their post-write values for
 * the same reason. Every other stored field is carried through as-is, which is
 * what a partial update does.
 */
function projectedEventBytes(
  existing: Readonly<Record<string, unknown>> | null | undefined,
  archive: EventArchive,
  archivedAt: number,
): number {
  const retained = { ...(existing ?? {}) };
  delete retained.archive;
  delete retained.archivedAt;
  delete retained.status;
  delete retained.archiving;
  return jsonBytes({ ...retained, status: 'archived', archivedAt, archiving: false, archive });
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
  /** `archiveBytes(archive)` — the record's own size, reported so the refusal
   *  below can quote it. */
  bytes: number;
  /** How big the Event DOCUMENT would be once this record lands on it: the
   *  stored fields the update retains plus the four it writes. `bytes` alone
   *  cannot answer the question the write actually asks, because the archive
   *  never lands on an empty document (#134, Codex P2 on PR #1139). Equal to
   *  the record's own size plus the JSON envelope when no `existing` document
   *  was supplied. */
  projectedBytes: number;
  /** Non-null when this record must not be written. `'too-large'` means the
   *  coerced, bounded record STILL exceeds `MAX_ARCHIVE_BYTES`, or the Event
   *  document it would sit on exceeds `MAX_ARCHIVED_EVENT_BYTES` with it —
   *  neither of which a clamp here can fix, so the Admin has to be told rather
   *  than left with a shut Event. */
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
 *  - and the finished record is measured TWICE — against `MAX_ARCHIVE_BYTES`
 *    for its own share of the budget, and, with `existing`, against
 *    `MAX_ARCHIVED_EVENT_BYTES` for the whole document it would land on, since
 *    the archive never lands on an empty one. Either is reported as a REFUSAL
 *    rather than a throw, so the caller can decline before taking the quiesce.
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
  /**
   * The STORED Event document the record would land on, for the projected-size
   * check (#134, Codex P2 on PR #1139). Deliberately separate from `event`
   * above, which is the narrow `ArchivableEvent` slice the builder DERIVES
   * from: this one is measured, not read, so it takes the whole document — the
   * fields it shares the 1 MiB budget with (`days`, `bannedUids`,
   * `mostLovedPhoto`) are exactly the ones the builder never looks at.
   * Omitting it measures the record alone, which is the pre-#1139 behaviour and
   * right only for a caller with no document in hand (the unit tests).
   */
  existing?: Readonly<Record<string, unknown>> | null;
  maxRows?: number;
  maxBytes?: number;
  maxEventBytes?: number;
}): EventArchiveDraft {
  const {
    players,
    event,
    dayMetas,
    dayMetasLoaded = true,
    archivedAt,
    existing,
    maxRows = MAX_ARCHIVED_STANDING_ROWS,
    maxBytes = MAX_ARCHIVE_BYTES,
    maxEventBytes = MAX_ARCHIVED_EVENT_BYTES,
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
        // The chip LABEL, resolved here and stored (Codex P2, PR #1139). The
        // archived strip used to look the Day's theme emoji up in the LIVE
        // `EventDoc.days`, which the freeze deliberately leaves editable — so
        // an Admin re-theming a Day after the archive re-labelled a frozen
        // honour. `dayHonorChipLabel` is the live strip's own derivation,
        // shared rather than restated, so the frozen label is by construction
        // the one the last live strip rendered.
        dayLabel: dayHonorChipLabel(h.dayIndex, days),
      })),
    freezeAt,
    archivedAt,
  };
  const bytes = archiveBytes(archive);
  // TWO ceilings, and the second is the one the write actually meets: the
  // record must fit its own quarter of the Event document's budget, AND the
  // document must still fit once it lands there. An Event already carrying
  // large `days` / `bannedUids` / `mostLovedPhoto` fields could pass the first
  // and overflow on the second — inside the transaction, with gameplay already
  // shut (Codex P2, PR #1139).
  const projectedBytes = projectedEventBytes(existing, archive, archivedAt);
  return {
    archive,
    skippedRows,
    bytes,
    projectedBytes,
    refusal: bytes > maxBytes || projectedBytes > maxEventBytes ? 'too-large' : null,
  };
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
