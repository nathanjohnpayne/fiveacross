// The post-Event archive's pure half (#134, specs/post-sailing-archive.md):
// deciding whether an Event is archived or closing, and building the frozen
// final record the archived Leaderboard renders from. Firestore-free and
// React-free, so the snapshot rules are unit-testable without an emulator or a
// mounted component (the `src/data/finale.ts` precedent).
//
// ADR 0001 governs what this module may do. It SNAPSHOTS the client-authoritative
// standings — every number below is copied off a Player-written `PlayerDoc` — and
// it never recomputes, re-derives or "verifies" them. The only derivation it
// performs is the ORDER (`sortPlayers`) and the honour SELECTIONS
// (`eventFirstBingoWinner`, `pinnedOrDerivedDailyHonors`), and both are the very
// selectors the live Leaderboard already renders with, reused rather than
// restated: the frozen record must say what the last live Leaderboard said.
import { isBanned } from './moderation';
import { supportedDayIndex } from './eventLimits';
import { dayHonorChipLabel, pinnedOrDerivedDailyHonors } from './finale';
import {
  eventFirstBingoWinner,
  resolvedStandingsFreezeAt,
  sortPlayers,
  tutorialDayIndexSet,
} from '../game/logic';
import type {
  ArchivedDayHonor,
  ArchivedFirstBingo,
  ArchivedFirstBingoRow,
  ArchivedStandingRow,
  DayMetaDoc,
  EventArchive,
  EventDoc,
  PlayerDoc,
} from '../types';

/**
 * Whether this Event is frozen (#134, specs/post-sailing-archive.md). The ONE
 * place the client asks the question, so no surface invents its own spelling of
 * `status === 'archived'` — `EventDoc.status` was a typed-but-dead field until
 * this ticket, and a dead field acquires several readers the moment it acquires
 * one.
 *
 * NOT to be confused with `HostnameDoc.status`, a different field with a
 * different value set (`'active' | 'disabled' | 'archived'`) that decides
 * ADDRESSING before first paint (`src/eventResolution.ts`). An Event can be
 * archived while its hostname is still perfectly servable — that is how a
 * Player reaches the archive at all.
 */
export function isEventArchived(
  // PARTIAL, so a raw or partially-decoded Event document answers the question
  // too: `status` is absent on every document written before this ticket, and
  // the predicate's own contract is that absent means OPEN — a caller holding a
  // `Partial<EventDoc>` (the deal path's mode read, the freeze's own raw
  // re-reads) must not have to assert its way past the type to ask.
  event: Partial<Pick<EventDoc, 'status'>> | null | undefined,
): boolean {
  return event?.status === 'archived';
}

/**
 * Whether this Event is in the archive's QUIESCING phase (#134, spec § "The
 * quiesce protocol"): shut to gameplay by the Admin's first archive write, but
 * not yet frozen. The rules deny every gameplay write in this state exactly as
 * they do for an archived Event, so nothing the freeze depends on can move
 * underneath it.
 *
 * Deliberately SEPARATE from `isEventArchived`, and neither implies the other.
 * A closing Event is reversible — an Admin can reopen play — while an archived
 * one clears the flag and is carried by `status`, which is write-once. The one
 * surface that cares about the difference is the Admin console, which offers a
 * closing Event both a way to finish and a way back.
 */
export function isEventArchiving(
  event: Partial<Pick<EventDoc, 'archiving'>> | null | undefined,
): boolean {
  return event?.archiving === true;
}

/**
 * How many standings rows the frozen record retains (#1151). The Event document
 * has one 1 MiB budget that `days`, `bannedUids` (capped at 1000) and
 * `mostLovedPhoto` already draw on, so the roster copy is the one field that
 * could make the document unwritable — the same reason `MostLovedPhotoAward`
 * bounds `winners` and records `winnerCount` beside it. 200 is far above any
 * real Event roster (both live Events are two figures), so in practice nothing
 * is ever dropped; `EventArchive.playerCount` records the true cardinality when
 * something is.
 */
export const MAX_ARCHIVED_STANDING_ROWS = 200;

/**
 * How long a name the frozen record keeps, per row (#1151, Codex P2 on PR
 * #1139).
 *
 * `players/{uid}` is self-written under the honour system (ADR 0001) and its
 * rules arm validates neither the presence nor the LENGTH of `displayName`, so a
 * Player can put an arbitrarily long string on their own row. The archive copies
 * that row into the Event document, where 200 of them share one 1 MiB budget —
 * so one over-long name is enough to make the archive write fail, permanently,
 * AFTER the closing write has already shut the Event.
 *
 * 100 is the cap `firestore.rules` already enforces on every OTHER
 * Player-authored display name in the estate (the per-Day honour pin, Tally
 * markers, Moments, Proofs), and the profile editor's own limit is 40
 * (`MAX_DISPLAY_NAME`), so no name a Player can enter through the app is ever
 * touched by this.
 */
export const MAX_ARCHIVED_DISPLAY_NAME = 100;

/**
 * How long an EVENT name the frozen record keeps (#1151, Codex P2 on PR #1139).
 *
 * The same bound, because the reason is the same one: `EventDoc.name` is
 * admin-written and `firestore.rules` validates neither its presence nor its
 * length either, so it can arrive at the record as an arbitrarily long string
 * sharing the document's one 1 MiB budget. A hundred characters is already far
 * past anything the Share Card's single title line can render.
 */
export const MAX_ARCHIVED_EVENT_NAME = MAX_ARCHIVED_DISPLAY_NAME;

/**
 * The size ceiling the frozen record must fit under, in bytes of serialized
 * JSON.
 *
 * A quarter of the Event document's 1 MiB budget, leaving three quarters for the
 * fields the archive shares it with (`days` with its per-Day snapshot id lists,
 * `bannedUids` at up to 1000 entries, `mostLovedPhoto`). The margin is
 * deliberately enormous: with rows bounded at `MAX_ARCHIVED_STANDING_ROWS` and
 * names at `MAX_ARCHIVED_DISPLAY_NAME` a real record is tens of kilobytes, so
 * this is the BACKSTOP for whatever those two clamps did not anticipate rather
 * than a limit any Event is expected to approach.
 *
 * Measured as UTF-8 bytes of `JSON.stringify`, which over-approximates
 * Firestore's own accounting (it counts the punctuation Firestore does not) —
 * over-approximating is the safe direction for a ceiling.
 */
export const MAX_ARCHIVE_BYTES = 256 * 1024;

/**
 * The size ceiling the WHOLE Event document must fit under once the record has
 * landed on it, in bytes of serialized JSON (#1151, Codex P2 on PR #1139).
 *
 * `MAX_ARCHIVE_BYTES` above bounds the record's own share of the budget. It
 * cannot bound the document, because the archive is not written to an empty one:
 * `days` carries a per-Day `snapshotItemIds` list, `bannedUids` holds up to 1000
 * entries, `mostLovedPhoto` keeps up to 100 winners, and every one of them is
 * already there when the freeze commits. An Event that has grown large on its
 * own could therefore pass the record's quarter-budget and still push the
 * document past Firestore's 1 MiB limit — inside the transaction, AFTER the
 * closing write had already shut the Event, which is the one failure the
 * pre-quiesce validation exists to make impossible.
 *
 * So the guard measures the PROJECTED document: everything the update leaves in
 * place, plus the fields it writes. 900 KiB leaves ~148 KiB of margin under the
 * real limit, which absorbs the difference between Firestore's own accounting
 * (field-name bytes, per-field and per-document overhead, the document path) and
 * `JSON.stringify`'s.
 */
export const MAX_ARCHIVED_EVENT_BYTES = 900 * 1024;

/** The Event fields the archive builder and its callers read. `name` is COPIED
 *  into the record rather than read live — see `archiveEventName`. */
export type ArchivableEvent = Pick<
  EventDoc,
  'days' | 'bannedUids' | 'frozenAt' | 'standingsFreezeAt'
> &
  // OPTIONAL, unlike the rest: an Event document with no name is a shape the
  // record has to survive (the rules validate neither the field's presence nor
  // its type), and `archiveEventName` resolves it to `null` rather than
  // inventing one.
  Partial<Pick<EventDoc, 'name'>>;

/**
 * A tag for a value this canonicaliser will not walk into: a CYCLE, or a
 * primitive `JSON.stringify` cannot represent (#1151, Codex P2 on PR #1162).
 *
 * Non-colliding BY CONSTRUCTION, which is the property that matters — this
 * output is never parsed, only compared, so the tag only has to be a byte
 * sequence no other branch below can emit. Every string this function produces
 * goes through `JSON.stringify` and is therefore quoted; numbers, booleans and
 * `null` are emitted bare but never in this shape. So a stored string literally
 * reading `<<cycle>>` serialises as `"<<cycle>>"` — quoted, and distinct from
 * this.
 */
const UNWALKABLE = (kind: string): string => `<<${kind}>>`;

/**
 * JSON with object keys in a fixed order, so two reads of an UNCHANGED document
 * always serialize identically. `JSON.stringify` follows insertion order, which
 * the Firestore SDK does not promise to reproduce across two decodes of the same
 * document — and a comparison that can report a spurious change would abort
 * archives at random.
 *
 * FIRESTORE-AWARE AND CYCLE-SAFE, because it is handed RAW documents (#1151,
 * Codex P2 on PR #1162). `archiveSnapshotFingerprint` fingerprints
 * `EventDoc.days`, which is admin-written and validated by no rules arm, so an
 * Admin-SDK repair or a console hand edit can leave a native Firestore value
 * sitting in it. A plain recursive walk enumerated those as ordinary objects,
 * and a `DocumentReference` carries an enumerable `firestore` back-reference
 * that points at a graph containing the reference again: the walk cycles and
 * throws `RangeError: Maximum call stack size exceeded`. That throw lands after
 * play has closed and OUTSIDE every `archiveRead` wrapper, so `archiveEvent`
 * rejected rather than returning a refusal, the console's automatic reopen never
 * ran, and the Event was left stuck closing — the one outcome the two-write
 * protocol exists to make impossible.
 *
 * The four special types are recognised by SHAPE rather than by `instanceof`,
 * deliberately. This module is Firestore-free on purpose (its whole test layer
 * runs without an emulator or an SDK), and duck-typing is also the more robust
 * check at runtime: two copies of `firebase/firestore` in one bundle produce
 * values that fail `instanceof` against the class this module would have
 * imported. Each is reduced to the scalar the SDK itself round-trips it by —
 * `Timestamp.toMillis()`, `GeoPoint`'s latitude/longitude, a reference's `path`,
 * `Bytes.toBase64()` — so two reads of an unchanged field still agree, which is
 * the only property this fingerprint needs.
 *
 * `seen` tracks the current PATH, not every node visited: an object is added
 * before its children are walked and removed afterwards, so a value that appears
 * twice in a TREE serialises identically both times and only a true back-edge is
 * tagged. Tracking every visited node instead would report a spurious change the
 * moment a document repeated a subobject.
 */
function stableJson(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) return 'null';
  // `JSON.stringify` THROWS on a bigint rather than returning undefined, and a
  // throw here is the very failure this function was hardened against — so the
  // one primitive it cannot represent is tagged with its own value, which keeps
  // two different bigints distinguishable.
  if (typeof value === 'bigint') return UNWALKABLE(`bigint:${value}`);
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  const obj = value as Record<string, unknown>;
  // THE FIRESTORE TYPES, ahead of the cycle check: none of them is cyclic in
  // itself, and reducing them to a scalar is what stops the walk reaching the
  // back-reference that is.
  if (typeof obj.toMillis === 'function') {
    return stableJson((obj.toMillis as () => unknown)());
  }
  if (typeof obj.toBase64 === 'function') {
    return stableJson((obj.toBase64 as () => unknown)());
  }
  // A `GeoPoint`. `isEqual` is asked for alongside the coordinates BECAUSE the
  // coordinates alone are not a distinctive enough shape: `latitude` and
  // `longitude` are ordinary field names a stored Day could plausibly carry
  // (`DayDef` already has `place`), and reducing such a map to its two numbers
  // would drop every other field from the fingerprint — so a change to one of
  // them would read as no change, which is the failure this fingerprint exists
  // to prevent. Firestore's own `GeoPoint` carries `isEqual`; a plain map does
  // not.
  if (
    typeof obj.latitude === 'number'
    && typeof obj.longitude === 'number'
    && typeof obj.isEqual === 'function'
  ) {
    return `{"latitude":${stableJson(obj.latitude)},"longitude":${stableJson(obj.longitude)}}`;
  }
  // A `DocumentReference` or a `CollectionReference`. `path` is the SDK's own
  // identity for both — the value its equality is decided by — so reducing to it
  // asks the same question without walking the `firestore` handle hanging off it.
  //
  // A FUNCTION-VALUED SDK MARKER IS REQUIRED BESIDE IT (Codex P2 on PR #1162,
  // round 8), for the reason the GeoPoint branch above requires `isEqual` and
  // with more at stake. `path` (a string) and `firestore` (a map) are BOTH
  // shapes a stored Day can hold, so asking for that pair alone matched an
  // ordinary map that merely carried those two field names — and collapsed the
  // whole Day to its `path`. Every other field then left the fingerprint, so an
  // Admin editing `index`, `theme` or `unlockAt` between the pre-read and the
  // transaction produced two EQUAL fingerprints: `archiveEvent` skipped its
  // `config-changed` abort and froze honour pins fetched for the old schedule
  // into a record built from the new one, permanently. `firestore` is no longer
  // asked at all, because it never discriminated anything — it named the cycle
  // this branch exists to avoid, not the type.
  //
  // The invariant the marker rests on: a value DECODED from Firestore is built
  // out of Firestore's own types, and none of them is a JS function — so no
  // stored map can present one, whatever its field names. TWO are accepted
  // because the SDKs disagree about which they carry: the modular client's
  // `DocumentReference`/`CollectionReference` carry `withConverter` and dropped
  // `isEqual` at v9 (the free `refEqual` replaced it), while the Admin SDK's
  // carry both. Asking for either keeps this branch true of a real reference
  // from whichever SDK left the value behind.
  if (
    typeof obj.path === 'string'
    && (typeof obj.withConverter === 'function' || typeof obj.isEqual === 'function')
  ) {
    return stableJson(obj.path);
  }

  if (seen.has(obj)) return UNWALKABLE('cycle');
  seen.add(obj);
  try {
    if (Array.isArray(value)) return `[${value.map((v) => stableJson(v, seen)).join(',')}]`;
    const entries = Object.entries(obj)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v, seen)}`).join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * A fingerprint of the Event configuration THE SNAPSHOT IS DEFINED BY (#1151,
 * Codex P2 on PR #1139).
 *
 * `archiveEvent` reads the Claim queue, the roster and the Day honour pins
 * against the Event it PRE-READ, and then builds the record against the Event
 * its transaction reads. Between the two, an Admin can change the Event's
 * configuration — the quiesce shuts gameplay, not administration — and the
 * freeze would then combine reads taken for one configuration with a record
 * built for another. Three concrete ways that goes wrong:
 *
 *  - **`claimMode`.** The drain gate is scoped to `claimsQueueOpen`, so a queue
 *    read while the Event was on `honor` passes VACUOUSLY. Flipping to
 *    `admin_confirmed` afterwards makes every one of those pending Claims
 *    blocking — and unresolvable, because the freeze denies both writes their
 *    resolution consists of.
 *  - **`days`.** The schedule decides which Day honour pins were fetched at all,
 *    which Days are Tutorial (excluded from the headline honour), where a
 *    missing Standings Freeze is derived from, and the label each frozen honour
 *    chip carries. A schedule edited after the pins were read produces a record
 *    built from pins for a schedule that no longer exists.
 *  - **`frozenAt`.** It resolves the honour cutoff: a freeze stamped between the
 *    pre-read and the commit would leave the record cut on one answer and built
 *    against another.
 *
 * `standingsFreezeAt` rides along because it resolves the same cutoff.
 *
 * `finaleCompletedAt` is deliberately OUT, even though it is what the finale
 * gate now reads (#1151, Codex P1 on PR #1162). That gate is evaluated against
 * the TRANSACTIONAL read — the state the flip actually lands on — and the marker
 * only ever moves one way, from absent to stamped, so a finale finishing
 * mid-snapshot can only make the archive MORE permitted and needs no abort. It
 * changes nothing about which rows were read either, which is the question this
 * fingerprint exists to ask.
 *
 * `bannedUids` is deliberately OUT. Moderation is not a gameplay write and stays
 * available through the quiesce on purpose; a ban is applied to the rows the
 * record keeps rather than deciding which rows were read, so a ban landing
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
 * The fingerprint, or `null` if the document could not be fingerprinted at all
 * (#1151, Codex P2 on PR #1162).
 *
 * `stableJson` above is now cycle-safe and Firestore-aware, so the concrete
 * throw that prompted this — a `DocumentReference`'s enumerable `firestore`
 * back-reference sending the walk round a cycle — cannot happen any more. This
 * is the BELT beside those braces, and it is here because of WHERE the
 * fingerprint runs rather than because of any value in particular: both calls
 * are taken after `beginArchive` has already shut the Event, and one of them is
 * outside every `archiveRead` wrapper. A throw from either therefore leaves
 * `archiveEvent` REJECTING instead of returning, which skips the console's
 * automatic reopen entirely and strands a live Event closed to gameplay with no
 * record and no explanation — the failure mode the two-write protocol exists to
 * make impossible.
 *
 * Anything that can still throw in there is something no one anticipated: a
 * throwing getter, a Proxy that refuses enumeration, a `toMillis` that is not
 * the SDK's. Every one of them is a property of the STORED document, so a second
 * attempt would meet it again — which is exactly the case for turning it into a
 * refusal the caller can name (`config-unreadable`) rather than a rejection it
 * cannot clean up after.
 */
export function archiveSnapshotFingerprintOrNull(
  event:
    | Partial<Pick<EventDoc, 'claimMode' | 'days' | 'standingsFreezeAt' | 'frozenAt'>>
    | null
    | undefined,
): string | null {
  try {
    return archiveSnapshotFingerprint(event);
  } catch {
    return null;
  }
}

/**
 * Has this Event's finale already RUN — all of it? (#1151, routed here from
 * #1150's review; Codex P1 on PR #1162.)
 *
 * The quiesce only DELAYS the finale beats — the freeze stamp, the podium
 * Moment and the Most-Loved award are withheld while play is shut and land at
 * the scheduled cutoff once it reopens — but `status: 'archived'` is
 * irreversible, so an Event flipped BEFORE its finale never receives them at
 * all. Nothing else warns the Admin, and there is no way back.
 *
 * `finaleCompletedAt` IS THE EVIDENCE, and `frozenAt` is not. The scheduler
 * writes `frozenAt` in the freeze transaction and posts the podium Moment
 * AFTERWARDS, as a separate best-effort beat under its own try/catch whose retry
 * guard is deliberately decoupled from the freeze (`finaleActions.postPodium`,
 * Codex #228) — so an Event carries the stamp and no podium for as long as that
 * beat keeps failing, and reading the stamp alone answered "the finale has run"
 * for the whole of that window. An archive taken there closed the Event over a
 * podium that, because a closed Event's finale is never retried
 * (`eventClosedToPlay` in `functions/src/unlockDay.ts`), would then never arrive.
 * `finaleCompletedAt` is the composite marker `runFinaleBeats` writes only once
 * it can observe every required beat, so a `frozenAt` without it keeps the
 * acknowledgement on screen. It is also the only one of the two no client can
 * write: `firestore.rules` refuses a change to it on every admin arm, where
 * `frozenAt` beside it stays admin-writable.
 *
 * An Event with no resolved Standings Freeze at all has no finale to wait for —
 * the pre-ADR-0011 "legacy Events never freeze" shape — and gating on one would
 * block archiving an Event that can never satisfy the gate.
 *
 * It is a WARNING rather than a prohibition, which is why it is a predicate
 * rather than a refusal baked into the builder: an Admin may legitimately end an
 * Event that will never reach its finale, and the console makes them say so
 * explicitly (`archiveEvent`'s `beforeFinale`).
 */
export function finaleHasRun(
  event:
    | Partial<Pick<EventDoc, 'finaleCompletedAt' | 'standingsFreezeAt' | 'days'>>
    | null
    | undefined,
): boolean {
  if (event?.finaleCompletedAt != null) return true;
  // PARTIAL on the way in, like every other predicate here, because the freeze
  // writer asks the question of a RAW transactional read. `days` is defaulted
  // rather than asserted: an Event document with no schedule has no ceremonial
  // Day to derive a freeze from, which is exactly the `null` the check wants.
  return (
    resolvedStandingsFreezeAt(
      event ? { ...event, days: Array.isArray(event.days) ? event.days : [] } : null,
    ) == null
  );
}

/**
 * How long a `uid` the frozen record keeps, per row (#1151, Codex P1 on PR
 * #1162).
 *
 * 128 is the maximum length of a Firebase Auth uid, so no id the platform can
 * ever mint is touched by this. It is a DEFENCE IN DEPTH rather than the fix:
 * the fix is that every uid in the record is a DOCUMENT ID (`playerConverter`
 * pins `PlayerDoc.uid` to `snap.id`), and a document id under `players/` is the
 * `request.auth.uid` the rules arm's `isOwner(uid)` bound the write to. What the
 * bound covers is everything that is not a client write through that arm — an
 * Admin-SDK repair, a seed script, a hand edit in the console — none of which
 * the rules constrain at all, and any of which could leave a path segment up to
 * Firestore's own 1500-byte limit sitting in a record with a 256 KiB ceiling.
 */
export const MAX_ARCHIVED_UID = 128;

/**
 * Is this a `uid` the record can carry? (#1151, Codex P2 on PR #1139; Codex P1
 * on PR #1162.)
 *
 * A row with no usable id is unusable in every direction the archive needs: it
 * cannot be ban-filtered, it cannot be matched against the headline honour, the
 * Share Card cannot pin it — and, most immediately, Firestore REFUSES to
 * serialize an `undefined`, so one such row makes the whole archive write throw
 * after the closing write has already shut the Event. `players/{uid}` validates
 * no field in its rules arm (it is self-written under ADR 0001), so this is a
 * shape a Player can actually produce by deleting a field from their own row.
 *
 * IT IS ASKED OF THE DOCUMENT ID, not of the stored field. The rules arm binds
 * the PATH (`isOwner(uid)`) and validates nothing inside the document, so a
 * Player can store a 300 KB string at `uid` on their own row — and a record that
 * copied it would exceed `MAX_ARCHIVE_BYTES` on every attempt, permanently, on
 * an Event the first write has already shut. `playerConverter` is where the two
 * are separated: it pins `PlayerDoc.uid` to `snap.id` for every reader, so both
 * the console's preview and the freeze's own server re-read hand this predicate
 * the row's real identity. The LENGTH bound below is the backstop for the ids no
 * rules arm ever saw (`MAX_ARCHIVED_UID`).
 *
 * An id that fails either half is SKIPPED and counted in
 * `EventArchiveDraft.skippedRows`, exactly as a missing one is, rather than
 * refusing the whole archive: it is the same field failing the same question, so
 * it takes the same route — dropped before any selection (an unidentifiable row
 * must not be able to take an honour either), stated on the confirm row, and
 * outside `playerCount`, which records the cardinality of the rows the record
 * COULD carry. Refusing instead would strand an Event on a row no Admin can edit
 * — a Player row's id cannot be renamed, only deleted — for a row the record can
 * simply leave out, which is the trade every other malformation here already
 * makes.
 */
function usableUid(uid: unknown): uid is string {
  return typeof uid === 'string' && uid.trim().length > 0 && uid.length <= MAX_ARCHIVED_UID;
}

/**
 * Is this schedule's list of Day indexes one the archive can be taken over?
 * (#1151, Codex P2 on PR #1162.)
 *
 * `EventDoc.days` is admin-written with NO per-entry validation in its rules
 * arm, and `eventConverter` tolerates an entry it cannot read
 * (`migrateDayFields` treats a nullish one as `{}`), so a stored schedule can
 * carry either shape this refuses:
 *
 *  - **An index that names no Day.** It is the `days/{dayIndex}` path segment
 *    every honour pin is addressed by, so a missing or fractional one reads
 *    `days/undefined/meta/undefined` — a document that is not there, delivered
 *    as a perfectly ordinary "no pin here" — and the record would freeze that
 *    absence as the Day's honour. `-1`, `10` and an unsafe large integer are the
 *    same defect wearing an integer's clothes: each addresses a real, arbitrary
 *    meta path, and each can freeze an `ArchivedDayHonor` labelled `D0` or `D11`
 *    into `dailyHonors`, where the rules cannot look inside a list to refuse it.
 *    The question is therefore the shared `supportedDayIndex` — a safe integer
 *    inside the `DayDef` contract's own `0 … MAX_DAYS - 1` — not
 *    `Number.isInteger` (Codex P2 on PR #1162, round 7).
 *  - **The same index TWICE.** Every Day-keyed structure downstream is keyed by
 *    index rather than by position, so the two entries are not two Days: the
 *    freeze's own `Map<number, DayMetaDoc>` collapses both reads onto one entry,
 *    while `pinnedOrDerivedDailyHonors` flat-maps over the schedule ENTRIES and
 *    emits that one Day's honour once per entry. The record then carries the
 *    same `dayIndex` twice, permanently, against a spec whose whole `dailyHonors`
 *    contract is one honour per Day.
 *
 * ONE PREDICATE, TWO CALLERS, on purpose. `archiveEvent` refuses such a schedule
 * as `schedule-unusable` after the quiesce; the console's honour fan asks the
 * same question BEFORE it, so the Archive control never arms over a schedule the
 * freeze is going to refuse. Stated once here rather than restated in each,
 * which is the drift that made the console and the freeze disagree about which
 * Days existed in the first place.
 *
 * A UNIQUE NON-CONTIGUOUS list stays usable, deliberately. `days[i].index === i`
 * is what the setup wizard's draft validation enforces at AUTHORING time and
 * nothing enforces on a stored Event; every day-scoped path in the estate keys
 * on `DayDef.index` (the #447 precedent), so a one-Day schedule at index 4 is a
 * schedule this reads and freezes correctly, not a broken one — a GAP is not an
 * out-of-range index, and only the second is refused here.
 */
export function usableDayIndexes(dayIndexes: readonly number[]): boolean {
  return (
    dayIndexes.every(supportedDayIndex)
    && new Set(dayIndexes).size === dayIndexes.length
  );
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

/**
 * The EVENT's own name, frozen into the record (#1151, Codex P2 on PR #1139).
 *
 * The archived Share Card builds its title and its context line from the Event
 * name, and that field is deliberately outside the write-once clause — which
 * protects `status`, `archivedAt`, `archivedUnder` and `archive` and nothing
 * else — so an Admin renaming the Event afterwards would silently re-title a
 * frozen card. Two people sharing "the archive" a week apart would get two
 * different images of the same standings, which is the one thing a permanent
 * record promises it cannot do. It is the identical argument
 * `ArchivedDayHonor.dayLabel` already won.
 *
 * `null` rather than a stand-in when the Event has no usable name: the Share
 * Card already falls back to the app's own name for an unnamed Event, and
 * inventing one here would freeze a name nobody chose. Trimmed and bounded for
 * the reason every other name in the record is.
 */
function archiveEventName(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, MAX_ARCHIVED_EVENT_NAME) : null;
}

/**
 * The magnitude `firestore.rules`' `finiteArchiveNumber` bounds every number in
 * the frozen record by, EXCLUSIVELY:
 * `value is number && value > -4102444800000 && value < 4102444800000`.
 *
 * 4102444800000 is 2100-01-01T00:00:00Z, the estate's stand-in for an
 * `isFinite()` Rules does not have — already used that way for
 * `standingsFreezeAt` and for the flip's own `archivedAt`. Restated here rather
 * than left implicit because the WRITER and the RULES have to agree about it:
 * see `MAX_ARCHIVE_NUMBER`.
 */
const ARCHIVE_NUMBER_BOUND = 4_102_444_800_000;

/**
 * The largest magnitude a number in the frozen record may carry (#1151, Codex P1
 * on PR #1162) — one below `firestore.rules`' exclusive bound, because the rules'
 * comparison is `<` rather than `<=`.
 *
 * THE WRITER AND THE RULES MUST SHARE ONE REPRESENTABLE-NUMBER CONTRACT, and
 * before this they did not. The coercions below kept ANY finite value, while
 * `finiteArchiveNumber` accepts only the bounded ones — so a Player self-writing
 * `bingoCount: 5e12` on their own row (`players/{uid}` validates no field at all,
 * ADR 0001) produced a record the rules REFUSED. That refusal lands on the flip,
 * which runs after `beginArchive` has already shut the Event, and a rejected
 * write throws past the refusal cleanup rather than returning one — so play was
 * closed, nothing was frozen, no automatic reopen ran, and every retry failed
 * identically until an admin found and repaired, banned or deleted that one row.
 *
 * Clamping rather than refusing, for the reason every other coercion here
 * clamps: the record has to be expressible, and a value 40 times the age of the
 * universe in milliseconds is not a stat anybody is going to lose. It decides
 * nothing about who won (ADR 0001) — no real count or instant is within nine
 * orders of magnitude of this — it only keeps the row writable.
 */
export const MAX_ARCHIVE_NUMBER = ARCHIVE_NUMBER_BOUND - 1;

/** A finite number brought inside `MAX_ARCHIVE_NUMBER` in both directions, so
 *  the value the writer produces is one `finiteArchiveNumber` accepts. */
function clampArchiveNumber(value: number): number {
  return Math.min(MAX_ARCHIVE_NUMBER, Math.max(-MAX_ARCHIVE_NUMBER, value));
}

/** A count the record can carry. A non-finite or non-numeric stat reads as 0 —
 *  which is what the live Leaderboard already renders for the same row — and a
 *  finite one is CLAMPED into the range the rules accept (`MAX_ARCHIVE_NUMBER`),
 *  because a value the flip cannot write is worse than one it rounds. */
function archiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? clampArchiveNumber(value) : 0;
}

/** An instant the record can carry, or `null`. Exported because it is also the
 *  coercion the ROOT `firstBingoAt` gets before the headline selection runs
 *  (#1142 item 9), which is a property worth pinning on its own. Bounded like
 *  every other number the record carries. */
export function archiveInstant(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clampArchiveNumber(value) : null;
}

/**
 * One Player's row with its instants made READABLE (#1151, Codex P2 on PR #1139;
 * #1142 item 9).
 *
 * `usableUid` is about the one malformation a row cannot survive; this is about
 * the one the SELECTORS cannot survive. `players/{uid}` validates nothing in its
 * rules arm, so `dayStats` is a Player-written map that can hold `null`, a
 * string, or a bucket missing every field — and `eventFirstBingoAt`,
 * `sumDayStats` and `perDayHonors` all dereference the bucket directly
 * (`stat.firstBingoAt`, `stat.bingoCount`). A single `dayStats: { '1': null }`
 * therefore THREW out of the builder, and because `ArchiveEvent` builds the
 * draft during RENDER, that exception took Game settings and the Reopen play
 * control down with it — on an Event that may already be shut, where reopening
 * is the one way back. The coercions further down never ran, because the throw
 * happened first.
 *
 * So a bucket that is not an object is DROPPED (there is nothing to default a
 * Day's evidence to) and every field inside one that is gets the same coercion
 * the standings rows get: a non-finite count reads `0`, a bad instant reads
 * `null`. Nothing else moves — the KEY is preserved verbatim, junk included, so
 * the selectors see exactly the Days they saw before and the record's own
 * `Number.isInteger` filter still decides which honours survive.
 *
 * AND THE ROOT `firstBingoAt` IS NORMALISED TOO (#1142 item 9). Sanitising only
 * the buckets left the one path that does not read them exposed:
 * `effectiveCruiseFirstBingoAt` falls back to the ROOT stamp for a row with no
 * `dayStats` at all — a pre-Day-Cards roster — and `selectHeadlineBingoWinner`
 * orders candidates with `<`. Every comparison against `NaN` is false, so a
 * `NaN` row encountered FIRST was kept as the best and never displaced by a real
 * one; the serializer then wrote that Player into the hall of fame's headline at
 * `at: 0`, permanently, over a Player who genuinely bingoed first. A row whose
 * root stamp cannot be read now simply has no eligible instant, which is exactly
 * how the selector already treats a row that never bingoed.
 *
 * AND SO ARE THE ROOT COUNTS, in the same pass and for the same reason (#1151,
 * Codex P1 on PR #1162). The stamp was normalised because the headline SELECTION
 * reads it; `bingoCount` and `squaresMarked` are what the ORDER reads, and the
 * order is the other thing this builder decides. `comparePlayers` subtracts them
 * (`b.bingoCount - a.bingoCount`), so a missing or `NaN` count yields `NaN` for
 * every comparison against that row — and a `NaN` comparator result leaves
 * `Array.prototype.sort` free to keep the malformed row exactly where it started,
 * which on the roster order this builder is handed can be AHEAD of a legitimate
 * champion. `Infinity` is worse than free: it compares as the largest count there
 * is and takes rank 1 outright. Either way `toStandingRow` then serialises the
 * same row at `0` — so the frozen record ranked a Player first and printed no
 * bingos beside them, permanently, on the one write that can never be amended.
 * Normalising here rather than at serialisation is what makes the ORDER and the
 * ROW agree: they are then the same numbers, read from the same row, in one pass
 * before anything is sorted.
 *
 * This is the whole of `Rankable` — the three fields `comparePlayers` reads — and
 * nothing beyond it: `blackout` and `displayName` are coerced where they are
 * serialised, because no selector or comparator reads them.
 *
 * A well-formed row is unchanged by construction, and no count is RECOMPUTED:
 * whatever the Player's own row said is still what the record says (ADR 0001).
 * This decides nothing about who won — it only makes the row readable by the
 * selectors and the comparator that were already reading it.
 */
export function withReadableDayStats(p: PlayerDoc): PlayerDoc {
  const firstBingoAt = archiveInstant(p.firstBingoAt);
  const bingoCount = archiveCount(p.bingoCount);
  const squaresMarked = archiveCount(p.squaresMarked);
  // Object identity is preserved for every ordinary row: the console re-runs
  // this on each render, and copying rows would defeat the reference equality
  // React's memoisation elsewhere relies on. `NaN === NaN` is false, so a row
  // carrying one is correctly seen as changed.
  const rootReadable =
    firstBingoAt === p.firstBingoAt
    && bingoCount === p.bingoCount
    && squaresMarked === p.squaresMarked;
  const raw = p.dayStats;
  if (!raw || typeof raw !== 'object') {
    return rootReadable ? p : { ...p, firstBingoAt, bingoCount, squaresMarked };
  }
  const readable = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, bucket]) => !!bucket && typeof bucket === 'object')
      .map(([key, bucket]) => {
        const stat = bucket as Record<string, unknown>;
        return [
          key,
          {
            bingoCount: archiveCount(stat.bingoCount),
            squaresMarked: archiveCount(stat.squaresMarked),
            firstBingoAt: archiveInstant(stat.firstBingoAt),
          },
        ];
      }),
  ) as NonNullable<PlayerDoc['dayStats']>;
  return { ...p, firstBingoAt, bingoCount, squaresMarked, dayStats: readable };
}

/**
 * Copy one Player's own written stats into a frozen standings row. No arithmetic
 * — whatever the Player's row said is what the record says (ADR 0001) — but the
 * values are COERCED to the shape the record's own contract declares.
 *
 * That is not adjudication: it decides nothing about who won. It is what makes
 * the row writable at all, on a document whose rules arm validates none of these
 * fields. See `usableUid` for the one malformation a row cannot survive.
 *
 * `uid` is the row's DOCUMENT ID rather than its stored `uid` field, which is
 * unvalidated Player input like everything else here — `playerConverter` pins
 * the two together on read, and `usableUid` has already bounded it (#1151, Codex
 * P1 on PR #1162).
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

/**
 * How big the Event DOCUMENT would be once the freeze lands on it (#1151, Codex
 * P2 on PR #1139): the stored fields the archive update leaves in place, plus
 * the ones it writes.
 *
 * The record is not written to an empty document, and the fields it shares the
 * 1 MiB budget with are the ones that grow — `days` with its per-Day snapshot id
 * lists, `bannedUids`, `mostLovedPhoto`. Measuring the record alone let an
 * already-large Event pass the check and then overflow inside the transaction,
 * with gameplay already shut and no record to show for it.
 *
 * `archive` is dropped from the retained side because the update REPLACES it;
 * the lifecycle fields are re-stated at their post-write values for the same
 * reason. Every other stored field is carried through as-is, which is what a
 * partial update does.
 */
function projectedEventBytes(
  existing: Readonly<Record<string, unknown>> | null | undefined,
  archive: EventArchive,
  archivedAt: number,
): number {
  const retained = { ...(existing ?? {}) };
  delete retained.archive;
  delete retained.archivedAt;
  delete retained.archivedUnder;
  delete retained.status;
  delete retained.archiving;
  return jsonBytes({
    ...retained,
    status: 'archived',
    archivedAt,
    archiving: false,
    // The generation the flip names. Its exact value moves the measurement by a
    // byte or two at most, but it IS written, so leaving it out would measure a
    // document the update does not produce.
    archivedUnder: typeof retained.archiveToken === 'number' ? retained.archiveToken : 0,
    archive,
  });
}

/** A number `firestore.rules`' `finiteArchiveNumber` would accept — the same
 *  two-sided magnitude bound, asked in JS. */
function writableArchiveNumber(value: unknown): boolean {
  return (
    typeof value === 'number'
    && value > -ARCHIVE_NUMBER_BOUND
    && value < ARCHIVE_NUMBER_BOUND
  );
}

/** `firestore.rules`' `firstBingoHonorComplete`, restated. */
function writableFirstBingo(honor: ArchivedFirstBingo): boolean {
  return (
    typeof honor.uid === 'string'
    && typeof honor.displayName === 'string'
    && writableArchiveNumber(honor.at)
  );
}

/** `firestore.rules`' `firstBingoRowComplete`, restated — `rank` included, the
 *  one field held to a positive integer because it is the one the builder
 *  computes rather than copies. */
function writableFirstBingoRow(row: ArchivedFirstBingoRow): boolean {
  return (
    typeof row.uid === 'string'
    && typeof row.displayName === 'string'
    && writableArchiveNumber(row.bingoCount)
    && writableArchiveNumber(row.squaresMarked)
    && typeof row.blackout === 'boolean'
    && (row.firstBingoAt === null || writableArchiveNumber(row.firstBingoAt))
    && Number.isInteger(row.rank)
    && row.rank > 0
  );
}

/**
 * Is this a frozen Day honour the record can actually carry? (#1151, Codex P2 on
 * PR #1162.)
 *
 * `ArchivedDayHonor`'s own declared shape, asked in JS, and the one entry check
 * in `writableArchiveRecord` that goes BEYOND what Rules asks. It is deliberate:
 * the Day-meta arm this honour is pinned by validates `displayName` and `at` but
 * NOT `uid` on its admin branch (`firestore.rules`, the `meta/{metaId}` create),
 * so a pin written by an Admin — or by the Admin SDK, which no arm constrains at
 * all — can carry a `uid` that is not a string, and the flip's own
 * `completeArchiveRecord` cannot look inside a list to notice. The rules would
 * take that record; the record would then violate the shape every archived
 * surface renders it through, permanently. So this half of the check answers a
 * question the boundary does not ask, and says so.
 *
 * `dayIndex` is held to an INTEGER, and `firstBingoAt` to the same magnitude
 * bound every other number in the record carries, because both are what the
 * builder itself guarantees one line earlier.
 */
function writableDayHonor(honor: ArchivedDayHonor): boolean {
  return (
    Number.isInteger(honor.dayIndex)
    && typeof honor.uid === 'string'
    && honor.uid.length > 0
    && typeof honor.displayName === 'string'
    && typeof honor.dayLabel === 'string'
    && writableArchiveNumber(honor.firstBingoAt)
  );
}

/**
 * Is the frozen honours list in the order its own contract declares? (#1151,
 * Codex P2 on PR #1162, round 8.)
 *
 * `EventArchive.dailyHonors` is documented as "ordered by Day index", and every
 * archived surface renders it straight through, so the order is part of the
 * record rather than a rendering preference — on the one write that can never be
 * amended. `firestore.rules` cannot ask this at all: rules have no iteration and
 * no way to relate one list element to the next, so `completeArchiveRecord` gets
 * no further than `dailyHonors is list` (asserting it by unrolling all
 * `MAX_DAYS` positions would cost more expressions than that arm has left, on a
 * clause the writer can guarantee for free). That is exactly why it is asserted
 * here: this predicate is the boundary's question PLUS the two things the
 * boundary cannot see inside a list to ask, and this is the second of them.
 *
 * STRICTLY ascending, so it re-states the one-honour-per-Day contract in the
 * same clause: a repeat is not merely out of order, it is a second honour for a
 * Day that has one. The builder's dedupe already makes that true by
 * construction; asserting both here is what refuses a later regression in the
 * dedupe or in the sort before the quiesce rather than after it.
 */
function ascendingHonorDays(honors: readonly ArchivedDayHonor[]): boolean {
  return honors.every((h, i) => i === 0 || honors[i - 1].dayIndex < h.dayIndex);
}

/**
 * `firestore.rules`' `standingsSizeMatches`, restated (#1151, Codex P2 on PR
 * #1162).
 *
 * The two fields are ONE contract, not two: `standings` is the bounded prefix of
 * the complete ban-filtered order and `playerCount` is that order's true
 * cardinality — the `MostLovedPhotoAward` `winners`/`winnerCount` pairing. Typed
 * apart they said nothing about each other, so a direct admin flip could freeze
 * `playerCount: 0` beside a non-empty list, or a list longer than the bound the
 * Event document's 1 MiB budget depends on.
 *
 * `draftEventArchive` produces exactly this — `ranked.slice(0, maxRows)` beside
 * `ranked.length` — so the equality holds by construction for every record the
 * writer builds at the SHIPPED bound. `MAX_ARCHIVED_STANDING_ROWS` is asked here
 * rather than the caller's own `maxRows`, because the question is the boundary's
 * (which knows only the constant), not the builder's: a caller passing a smaller
 * prefix is producing a record the rules would refuse, and this is where it is
 * told so — before the quiesce rather than after it.
 */
function writableStandingsSize(archive: EventArchive): boolean {
  return (
    archive.standings.length
    === (archive.playerCount <= MAX_ARCHIVED_STANDING_ROWS
      ? archive.playerCount
      : MAX_ARCHIVED_STANDING_ROWS)
  );
}

/**
 * Would `firestore.rules` accept this record? (#1151, Codex P1 on PR #1162.)
 *
 * THE LAST DEFENCE AGAINST THE ONE FAILURE THIS WHOLE MODULE IS SHAPED AROUND.
 * The flip is the archive's SECOND write, so a record the rules refuse is
 * refused after `beginArchive` has already shut the Event — and a rejected write
 * REJECTS rather than returning, so it goes past `archiveEvent`'s typed refusals
 * and past the console's automatic reopen alike, leaving a live Event closed
 * with nothing frozen and every retry failing the same way. Every other check
 * here exists to keep that from happening for a known cause; this one asks the
 * question the boundary will actually ask, so a cause nobody anticipated is
 * caught on the same side of the quiesce as the ones that were.
 *
 * It mirrors `completeArchiveRecord` and its two helpers CLAUSE FOR CLAUSE, with
 * TWO deliberate exceptions, and both are the same exception: rules cannot
 * iterate a list, so the boundary gets no further than `dailyHonors is list` and
 * everything that list's own contract promises has to be asked here or nowhere.
 *
 * The first is each ENTRY's shape (`writableDayHonor`). The Day-meta arm that
 * admits a pin does not type-check its `uid` on the ADMIN branch, so an
 * admin-written pin is the one value in the record that reaches here unvalidated
 * by anything. The rules would accept such a record and the archived surfaces
 * would then render an `ArchivedDayHonor` that violates its own declared shape,
 * permanently.
 *
 * The second is the list's ORDER (`ascendingHonorDays`, Codex P2 on PR #1162,
 * round 8). `EventArchive.dailyHonors` declares itself ordered by Day index, and
 * a stored schedule listing its Days out of order — `[{index: 4}, {index: 1}]`,
 * unique indexes the schedule check accepts and should — froze them in schedule
 * order, so every archived surface showed the Days out of chronological sequence
 * forever or had to re-sort defensively. Strictly ascending, which re-states the
 * one-honour-per-Day contract in the same clause.
 *
 * A stricter check is worth taking on both BECAUSE the builder itself now
 * guarantees the clauses they assert — the discard below drops exactly the pins
 * that would fail the first, and the sort beside it establishes the second — so
 * this refuses no record the writer can legitimately produce, only one a later
 * regression could.
 *
 * `standings`' rows stay unchecked, for the original reason unchanged: every one
 * of them is built by `toStandingRow` from a row `usableUid` has already
 * accepted, so there is no unvalidated value left in them to ask about. How MANY
 * of them there are is a different question and it is asked
 * (`writableStandingsSize`, Codex P2 on PR #1162), because the count is a
 * relationship with `playerCount` rather than a property of any row — and the
 * boundary asks it too, where a list's size costs one expression and walking it
 * is not expressible at all.
 *
 * `archivedAt` is asked only for FINITENESS, not for the flip arm's `> 0`: the
 * console builds its preview at `archivedAt: 0` deliberately (it is a preview,
 * with no clock), and refusing that would disarm the control on every Event. The
 * stamp's own bounds are the caller's, checked where the caller supplies them.
 *
 * EXPORTED so the backstop can be pinned on its own (#1151, Codex P2 on PR
 * #1162), the reason `archiveInstant` above is. Every clause here is meant to be
 * unreachable through `draftEventArchive`, whose coercions and discards are what
 * make it so — which is precisely why asserting it through the builder would
 * assert nothing. A predicate no test can address is a predicate a later change
 * can quietly weaken.
 */
export function writableArchiveRecord(archive: EventArchive): boolean {
  return (
    (archive.eventName === null || typeof archive.eventName === 'string')
    && Array.isArray(archive.standings)
    && Number.isInteger(archive.playerCount)
    && archive.playerCount >= 0
    && writableStandingsSize(archive)
    && Array.isArray(archive.dailyHonors)
    && archive.dailyHonors.every(writableDayHonor)
    && ascendingHonorDays(archive.dailyHonors)
    && ((archive.firstBingo === null && archive.firstBingoRow === null)
      || (!!archive.firstBingo
        && !!archive.firstBingoRow
        && writableFirstBingo(archive.firstBingo)
        && writableFirstBingoRow(archive.firstBingoRow)
        && archive.firstBingoRow.uid === archive.firstBingo.uid))
    && (archive.freezeAt === null || writableArchiveNumber(archive.freezeAt))
    && Number.isFinite(archive.archivedAt)
  );
}

/**
 * A record built but NOT yet committed, with everything the caller needs to
 * decide whether committing it is safe (#1151, Codex P2 on PR #1139).
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
  /**
   * Daily honours the record could not carry, and therefore did not (#1151,
   * Codex P2 on PR #1162). Two causes, counted together because the Admin's
   * remedy is the same for both — there is none, and the sentence they get is
   * about what the record will not contain:
   *
   *  - a PINNED holder whose `uid` is unusable (`usableUid`). The Day-meta arm
   *    does not type-check `uid` on its admin branch, so an admin-written or
   *    Admin-SDK-written pin can carry one that is not a string at all;
   *  - an honour whose `dayIndex` is not a Day index (the pre-existing filter) —
   *    a derived honour reads it off a Player-written `dayStats` KEY.
   *
   * Reported beside `skippedRows` and for the same reason: an Admin told the
   * count up front is not left comparing honours strips afterwards. Deliberately
   * NOT stored in the record, like `skippedRows`.
   */
  skippedHonors: number;
  /** The record's own size in bytes, reported so the refusal below can quote it. */
  bytes: number;
  /** How big the Event DOCUMENT would be once this record lands on it: the
   *  stored fields the update retains plus the ones it writes. `bytes` alone
   *  cannot answer the question the write actually asks, because the archive
   *  never lands on an empty document (#1151, Codex P2 on PR #1139). Equal to
   *  the record's own size plus the JSON envelope when no `existing` document
   *  was supplied. */
  projectedBytes: number;
  /** Non-null when this record must not be written. `'too-large'` means the
   *  coerced, bounded record STILL exceeds `MAX_ARCHIVE_BYTES`, or the Event
   *  document it would sit on exceeds `MAX_ARCHIVED_EVENT_BYTES` with it —
   *  neither of which a clamp here can fix, so the Admin has to be told rather
   *  than left with a shut Event. `'record-unwritable'` means the record is a
   *  shape `firestore.rules` would REFUSE (`writableArchiveRecord`), which is the
   *  same failure arriving at the boundary instead of the ceiling: refused here,
   *  before the quiesce, rather than thrown after it (#1151, Codex P1 on PR
   *  #1162).
   *
   *  Both members are `ArchiveEventResult` members too, so the writer's own
   *  post-quiesce re-check can report the draft's answer verbatim. */
  refusal: 'too-large' | 'record-unwritable' | null;
}

/**
 * Build the frozen final record: the Leaderboard's own standings plus the
 * First-to-BINGO hall of fame, as of `archivedAt`.
 *
 * The three derivations mirror `src/components/Leaderboard.tsx` clause for
 * clause, because the archive's promise is "the Leaderboard, kept":
 *
 *  - **Standings** are the BAN-FILTERED roster in `sortPlayers` order — exactly
 *    the rows the live Leaderboard lists and the Share Card prints.
 *    `sortPlayers` is a stable sort over the caller's array, so passing
 *    `useLeaderboard`'s already-ranked roster (the expected caller) reorders
 *    nothing; running it here anyway means the record cannot depend on a caller
 *    remembering to sort.
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
 *    the ban-filtered roster, with the ban roster passed EXPLICITLY so a pin
 *    whose holder no longer has a Player row is KEPT rather than silently
 *    dropped (#1146, #1142 item 8). It is the same helper the live strip and the
 *    frozen podium read, so the record cannot name a different holder from the
 *    last live strip.
 *
 * `freezeAt` is the resolved Standings Freeze (`resolvedStandingsFreezeAt`), so
 * the archived hall of fame cuts on the SAME instant as the live pin, the podium
 * and the ceremonial `first_bingo` Moment. An Event with no freeze at all
 * (`null`) has no cutoff, which is the pre-ADR-0011 behaviour unchanged.
 *
 * THE INPUTS ARE VALIDATED, because `players/{uid}` validates nothing (#1151,
 * Codex P2 on PR #1139). That row is self-written under the honour system and
 * its rules arm requires neither `uid`, `displayName`, `bingoCount` nor
 * `squaresMarked` — so a Player can delete a field from their own row, or store
 * a megabyte-long name, and the copy taken here would either refuse to serialize
 * (Firestore rejects `undefined`) or push the Event document past its 1 MiB
 * limit. Either way EVERY archive attempt would shut the Event and then fail,
 * which is the worst outcome the protocol can produce. So:
 *
 *  - a row with no usable `uid` is SKIPPED and counted
 *    (`EventArchiveDraft.skippedRows`) — it is unmatchable and unrenderable, so
 *    there is nothing to default it to. The id asked about is the DOCUMENT ID,
 *    which `playerConverter` pins onto every row it reads, because the stored
 *    field is Player input the rules bound nothing about — including its length
 *    (#1151, Codex P1 on PR #1162);
 *  - every other malformation is COERCED to a safe default: a missing name reads
 *    `'Anonymous'`, a missing or non-finite count reads `0`, a bad instant reads
 *    `null`, and every name is bounded at `MAX_ARCHIVED_DISPLAY_NAME`;
 *  - and the finished record is measured TWICE — against `MAX_ARCHIVE_BYTES` for
 *    its own share of the budget, and, with `existing`, against
 *    `MAX_ARCHIVED_EVENT_BYTES` for the whole document it would land on, since
 *    the archive never lands on an empty one. Either is reported as a REFUSAL
 *    rather than a throw, so the caller can decline before taking the quiesce.
 *
 * None of that adjudicates a stat (ADR 0001): it decides nothing about who won,
 * it only makes the row expressible in the record's own declared shape.
 *
 * PURE. No Firestore, no clock, no globals — `archivedAt` is supplied — so the
 * same inputs always produce the same record and the console's preview and the
 * writer's commit cannot drift.
 */
export function draftEventArchive(params: {
  players: readonly PlayerDoc[];
  event: ArchivableEvent | null | undefined;
  dayMetas?: ReadonlyMap<number, DayMetaDoc>;
  dayMetasLoaded?: boolean;
  archivedAt: number;
  /**
   * The STORED Event document the record would land on, for the projected-size
   * check (#1151, Codex P2 on PR #1139). Deliberately separate from `event`
   * above, which is the narrow `ArchivableEvent` slice the builder DERIVES from:
   * this one is measured, not read, so it takes the whole document — the fields
   * it shares the 1 MiB budget with (`days`, `bannedUids`, `mostLovedPhoto`) are
   * exactly the ones the builder never looks at. Omitting it measures the record
   * alone, which is right only for a caller with no document in hand.
   */
  existing?: Readonly<Record<string, unknown>> | null;
  /**
   * The retained prefix's own bound, defaulting to `MAX_ARCHIVED_STANDING_ROWS`.
   * A TEST SEAM rather than a production knob, and since #1162 an honest one:
   * `firestore.rules` binds `standings.size()` to `min(playerCount, 200)`, so a
   * caller passing a smaller bound over a longer roster builds a record the
   * boundary would refuse — and `writableArchiveRecord` says so, as
   * `record-unwritable`, on the near side of the quiesce (Codex P2 on PR #1162).
   */
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
  // COERCED like every other instant the record carries (#1151, Codex P1 on PR
  // #1162), and coerced ONCE so the cutoff the selections apply and the
  // `freezeAt` the record stores are the same number — the discipline the root
  // counts already follow. `frozenAt` is the field it resolves from first, and
  // that one is written by the Admin SDK, which no rules arm constrains: a
  // hand-repaired or scheduler-written stamp outside `MAX_ARCHIVE_NUMBER` would
  // otherwise be copied straight into a record the flip's own rules then refuse.
  // A stamp that cannot be read at all resolves to `null`, which is exactly how
  // `standingsFreezeAtFor` already treats a non-finite configured value: no
  // cutoff rather than a cutoff nothing can satisfy.
  const freezeAt = archiveInstant(resolvedStandingsFreezeAt(event ?? null));
  const tutorialDays = tutorialDayIndexSet(days);
  const isTutorialDay = (i: number): boolean => tutorialDays.has(i);

  // Dropped FIRST, before any selection: an unidentifiable row must not be able
  // to win the headline honour or hold a daily one either, and every downstream
  // step here reads `uid` — which is the row's DOCUMENT ID by the time it
  // arrives here (`playerConverter`), not the unvalidated field beside it.
  //
  // …and every surviving row is made READABLE in the SAME pass, before any
  // selector or the comparator reads one (`withReadableDayStats`). The honour
  // selectors read `stat.firstBingoAt` off a Player-written map with no rules
  // validation at all, so one malformed bucket threw out of the builder — and
  // this draft is built during `ArchiveEvent`'s RENDER, so the throw took Game
  // settings and its Reopen play control with it. The ROOT stamp is normalised
  // in the same place, because a `NaN` there wins the headline outright (#1142
  // item 9), and so are the ROOT COUNTS, because those are what `sortPlayers`
  // below reads: a `NaN` count makes every `comparePlayers` result `NaN` and an
  // `Infinity` one takes rank 1, while `toStandingRow` serialises both at `0`
  // (#1151, Codex P1 on PR #1162). Normalising before the sort is what keeps the
  // ORDER and the frozen ROW reading the same numbers.
  const identified = players.filter((p) => usableUid(p.uid)).map(withReadableDayStats);
  const skippedRows = players.length - identified.length;

  const roster = identified.filter((p) => !isBanned(p.uid, bannedUids));
  const ranked = sortPlayers([...roster]);

  const winner = eventFirstBingoWinner(identified, isTutorialDay, freezeAt);
  const firstBingo =
    winner && !isBanned(winner.uid, bannedUids)
      ? {
          uid: winner.uid,
          displayName: archiveName(winner.displayName),
          at: archiveCount(winner.at),
        }
      : null;
  // The holder's own row, kept whole OUTSIDE the bounded prefix. A non-banned
  // winner is by construction somewhere in `ranked` (the selection ran over the
  // superset and the ban filter is the only thing that removes anyone), but the
  // lookup still resolves to `null` rather than asserting: a record that names a
  // row it does not carry is the failure this field exists to prevent.
  const holderAt = firstBingo ? ranked.findIndex((p) => p.uid === firstBingo.uid) : -1;
  const firstBingoRow: ArchivedFirstBingoRow | null =
    holderAt >= 0 ? { ...toStandingRow(ranked[holderAt]), rank: holderAt + 1 } : null;

  // THE HONOUR SELECTION, TAKEN ONCE SO WHAT IT DROPS CAN BE COUNTED (#1151,
  // Codex P2 on PR #1162). See `carriedHonors` for what the filter refuses and
  // why a discarded pin leaves the Day with no honour at all.
  const selectedHonors = pinnedOrDerivedDailyHonors(
    ranked,
    days,
    dayMetas,
    dayMetasLoaded,
    bannedUids,
  );
  // A `dayIndex` that names no Day is dropped rather than coerced — a derived
  // honour reads it off a `dayStats` KEY, which is a Player-written map, and a
  // Day the schedule does not have is a chip nothing could ever label. The live
  // strip already drops it by matching against the schedule; the record has to,
  // because the record is permanent.
  //
  // ASKED AS `supportedDayIndex`, not as `Number.isInteger` (Codex P2 on PR
  // #1162, round 7). `-1`, `10` and an unsafe large integer all pass the integer
  // test while naming no Day the `DayDef` contract has, and a record carrying one
  // freezes an honour labelled `D0` or `D11` that no schedule can ever label and
  // no rules arm can look inside `dailyHonors` to refuse. `pinnedOrDerivedDailyHonors`
  // now refuses to DERIVE one, so the derived side is closed at its source; this
  // is the same question asked of the PINNED side, which arrives off
  // `days/{i}/meta/{i}` rather than off a roster row and therefore never went
  // through it.
  //
  // AND SO IS AN HONOUR WHOSE HOLDER HAS NO USABLE `uid` (#1151, Codex P2 on PR
  // #1162). Every OTHER uid the record carries has already been through
  // `usableUid`: the standings rows are filtered by it and the headline pair is
  // selected from those same rows. A PINNED daily honour is the one that has
  // not, because it comes off `days/{i}/meta/{i}` rather than off a Player row —
  // and that document's rules arm type-checks `displayName` and `at` but NOT
  // `uid` on its ADMIN branch, while the Admin SDK beside it is constrained by
  // no arm at all. So a pin can arrive carrying a `uid` that is not a string,
  // and `completeArchiveRecord` cannot see inside a list to refuse it: the flip
  // SUCCEEDED and froze an `ArchivedDayHonor` violating its own declared shape,
  // permanently, on the one write that can never be amended.
  //
  // DISCARDED, AND THE DAY IS THEN RECORDED AS HAVING NO HONOUR — the pin is not
  // replaced by the roster-derived fallback. That is the BAN rule, deliberately,
  // not the missing-pin rule: derivation is what an UNPINNED Day gets, and this
  // Day is pinned. The pin is write-once and says an honour was claimed; the
  // only thing wrong with it is that the record cannot express who holds it. So
  // it is hidden, never reassigned — the same clause `pinnedOrDerivedDailyHonors`
  // already applies to a pin whose holder is banned, and the same reason:
  // handing a Day's honour to somebody the pin does not name would be the one
  // adjudication this module must never make (ADR 0001).
  //
  // The honour's other copied scalars need no filter, because they are already
  // COERCED on the way out exactly as the standings rows are: `displayName`
  // through `archiveName` (trimmed, defaulted to `'Anonymous'`, bounded at
  // `MAX_ARCHIVED_DISPLAY_NAME`) and `firstBingoAt` through `archiveCount`
  // (non-finite reads `0`, finite is clamped into `MAX_ARCHIVE_NUMBER`). `uid` is
  // the only one that cannot be coerced — there is nothing to default an
  // identity to, which is the argument `usableUid` already won for a roster row.
  //
  // AND ONE HONOUR PER DAY INDEX, whatever the schedule says (#1151, Codex P2 on
  // PR #1162). `pinnedOrDerivedDailyHonors` flat-maps over the schedule's
  // ENTRIES, so a stored schedule naming the same index twice emits that Day's
  // honour twice — two identical `ArchivedDayHonor` entries in a list whose whole
  // contract is one honour per Day, frozen permanently, and invisible to
  // `completeArchiveRecord`, which cannot look inside a list. `archiveEvent`
  // refuses such a schedule outright (`usableDayIndexes` → `schedule-unusable`)
  // and the console's honour fan asks the same question before arming, so this is
  // DEFENCE IN DEPTH rather than the fix: the builder is called from surfaces
  // that never went through the freeze's own gate (the console preview, the
  // tests, any later caller), and the record is the one write that can never be
  // amended. The FIRST entry wins, which is the same entry `dayMetas.get(index)`
  // would have answered with — so the deduped record is exactly the one a
  // schedule naming that Day once would have produced.
  //
  // AND IN DAY-INDEX ORDER, whatever order the schedule lists its Days in (#1151,
  // Codex P2 on PR #1162, round 8). `EventArchive.dailyHonors` declares itself
  // "ordered by Day index" and every archived surface renders it straight
  // through, so the order is part of the record rather than a rendering
  // preference — and the record is permanent. `pinnedOrDerivedDailyHonors`
  // flat-maps over the schedule's ENTRIES, so a stored schedule listing
  // `[{index: 4}, {index: 1}]` — unique indexes, which `usableDayIndexes`
  // accepts and should, since a non-contiguous schedule is a legitimate one —
  // emitted D5's honour ahead of D2's and froze them that way. The scheduleless
  // path never could: `perDayHonors` sorts its derived list already, so this
  // makes the two paths agree rather than imposing something new on one of them.
  //
  // Sorted rather than refused, because there is nothing wrong with the
  // schedule: `DayDef.index` is what names a Day, and the array position has
  // never meant anything. And sorted HERE, on the deduped list, so the preview
  // and the frozen record come out of the same expression — the console renders
  // this builder's own output, and a record whose order the preview disagreed
  // with would be the same class of drift `dayLabel` was stored to close.
  //
  // KEPT, now that `pinnedOrDerivedDailyHonors` orders its own output (round 9).
  // The sort there is what fixed the LIVE surfaces — the podium and the Feed
  // render the selection straight through, so the record was ordered while the
  // last live display was not — and it does make this line a no-op on every list
  // the selector can currently produce. It is kept because the two are not the
  // same guarantee. This builder is called from surfaces that never went through
  // the freeze's gate, `writableArchiveRecord` ASSERTS the order rather than
  // establishing it, and that assertion fires as `record-unwritable` — a refusal
  // that reopens play with nothing frozen. So a later regression in the
  // selector's order would take the archive down here rather than merely
  // rendering out of sequence, and one line on the deduped list is what keeps the
  // builder's own promise its own.
  const seenHonorDays = new Set<number>();
  const carriedHonors = selectedHonors
    .filter((h) => {
      if (!supportedDayIndex(h.dayIndex) || !usableUid(h.uid)) return false;
      if (seenHonorDays.has(h.dayIndex)) return false;
      seenHonorDays.add(h.dayIndex);
      return true;
    })
    // On the array `filter` just minted, so `selectedHonors` is not touched —
    // this builder is PURE and its caller's list is not its to reorder.
    .sort((a, b) => a.dayIndex - b.dayIndex);
  const skippedHonors = selectedHonors.length - carriedHonors.length;

  const archive: EventArchive = {
    // The Event's own copy, frozen with the standings it titles. `dayLabel` came
    // off the archived surface for this reason and `name` follows it: the freeze
    // leaves both editable, and a card rebuilt from either drifts.
    eventName: archiveEventName(event?.name),
    standings: ranked.slice(0, Math.max(0, maxRows)).map(toStandingRow),
    playerCount: ranked.length,
    firstBingo,
    firstBingoRow,
    // Coerced on the way out for the same reason the rows are: a derived honour
    // carries the Player's own `displayName`, and a pinned one carries whatever
    // the day-meta document holds. What the record cannot carry at all has
    // already been discarded above (`carriedHonors`).
    dailyHonors: carriedHonors.map((h) => ({
      dayIndex: h.dayIndex,
      uid: h.uid,
      displayName: archiveName(h.displayName),
      firstBingoAt: archiveCount(h.firstBingoAt),
      // The chip LABEL, resolved here and stored (Codex P2, PR #1139). The
      // archived strip would otherwise look the Day's theme emoji up in the LIVE
      // `EventDoc.days`, which the freeze deliberately leaves editable — so an
      // Admin re-theming a Day after the archive would re-label a frozen honour.
      // `dayHonorChipLabel` is the live strip's own derivation, shared rather
      // than restated, so the frozen label is by construction the one the last
      // live strip rendered.
      dayLabel: dayHonorChipLabel(h.dayIndex, days),
    })),
    freezeAt,
    archivedAt,
  };
  const bytes = jsonBytes(archive);
  // TWO ceilings, and the second is the one the write actually meets: the record
  // must fit its own quarter of the Event document's budget, AND the document
  // must still fit once it lands there. An Event already carrying large `days` /
  // `bannedUids` / `mostLovedPhoto` fields could pass the first and overflow on
  // the second — inside the transaction, with gameplay already shut (Codex P2,
  // PR #1139).
  const projectedBytes = projectedEventBytes(existing, archive, archivedAt);
  return {
    archive,
    skippedRows,
    skippedHonors,
    bytes,
    projectedBytes,
    // The size ceilings first, because they are the refusal an Admin can act on:
    // a record the rules would refuse is a shape the coercions above are
    // supposed to make impossible, so it is the backstop rather than the
    // expected answer, and stating the ceiling where both hold is the more
    // useful sentence.
    refusal:
      bytes > maxBytes || projectedBytes > maxEventBytes
        ? 'too-large'
        : writableArchiveRecord(archive)
          ? null
          : 'record-unwritable',
  };
}

/** The frozen record alone, for the callers that only render it (the Admin
 *  console's preview line, the unit tests). `draftEventArchive` is the entry
 *  point for anything that is about to WRITE it — the refusal and the
 *  skipped-row count are what make the quiesce safe to take. */
export function buildEventArchive(
  params: Parameters<typeof draftEventArchive>[0],
): EventArchive {
  return draftEventArchive(params).archive;
}
