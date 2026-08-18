import { cellsFromData, cellsToMap } from '../game/cells';
import { normalizePool } from '../game/pool';
import { scoringForDay } from '../game/scoring';
import { standingsFreezeAtFor } from '../game/logic';
import type {
  FirestoreDataConverter,
  QueryDocumentSnapshot,
  DocumentData,
} from 'firebase/firestore';
import type {
  ClaimMode,
  DayDef,
  EventDoc,
  ItemDoc,
  BoardDoc,
  PlayerDoc,
  UserDoc,
  ProofDoc,
  ClaimDoc,
  TallyEntry,
  MomentDoc,
  NoticeDoc,
  DoubtDoc,
  HeartDoc,
  DayMetaDoc,
} from '../types';

function passthrough<T>(): FirestoreDataConverter<T> {
  return {
    toFirestore: (data) => data as DocumentData,
    fromFirestore: (snap: QueryDocumentSnapshot) => snap.data() as T,
  };
}

/**
 * Resolve a persisted Claim Mode to the current contract. Events seeded or
 * written before the rename persist the pre-rename value for what is now
 * `admin_confirmed`; coerce it on read so existing docs keep working. Unknown
 * or missing values fall back to the least-friction default, `honor`. Writes
 * only ever emit a current `ClaimMode` — the type no longer admits the old one.
 */
export function migrateClaimMode(raw: unknown): ClaimMode {
  if (raw === 'admin_confirmed' || raw === 'verified') return 'admin_confirmed';
  if (raw === 'honor' || raw === 'proof_required') return raw;
  return 'honor';
}

/**
 * Resolve a persisted pool value to the current contract (#565): `main`,
 * `easy`, `closing`. Both live Events' docs persist the pre-rename values —
 * `embark` for the easy pool, `farewell` for the closing pool — so coerce
 * them on read; unknown or missing values fall back to `'main'` (the same
 * default pre-Phase-1.5 items have always read as). Mirrors
 * `migrateClaimMode`. NOTE (transition posture): unlike Claim Mode, the pool
 * value is compared server-side (the scheduler's `snapshotPoolsFor` /
 * `standingsFrozen`-equivalents and `firestore.rules`' `validItemPool`), so
 * during the live-Event transition the client's curated-pool WRITES keep
 * emitting the LEGACY values (`adminAddItem`) — a hosting-only deploy must
 * never mint a value not-yet-redeployed Functions don't recognize. The flip
 * to emitting `easy`/`closing` is the post-Event cleanup, together with
 * dropping this coercion and narrowing the rules.
 */
export function migratePool(raw: unknown): 'main' | 'easy' | 'closing' {
  return normalizePool(raw);
}

/**
 * Resolve a persisted Day to the current field contract (#566/#565). Event
 * docs seeded before the neutral-vocabulary rename persist `port`/`portEmoji`
 * where the contract now reads `place`/`placeEmoji`, and the legacy pool
 * values `migratePool` coerces; normalize them on read. `place` wins when
 * both labels exist, while the legacy `portEmoji` wins when both emoji fields
 * disagree: the live Bodega wrap-up carries an operator-corrected 👋 only on
 * that legacy field, so blindly preferring the copied neutral value would
 * regress the live Day identity during this no-data-migration transition.
 * Writes only ever emit the new field names (the admin schedule editors
 * re-read the RAW stored `days` inside their transactions, so a theme/tonight
 * edit preserves whatever names/values the live doc holds). Mirrors
 * `migrateClaimMode` below. Every other Day field passes through untouched.
 */
export function migrateDayFields(raw: unknown): DayDef {
  const day = (raw ?? {}) as Record<string, unknown>;
  const { port, portEmoji, ...rest } = day;
  return {
    ...rest,
    place: typeof day.place === 'string' ? day.place : typeof port === 'string' ? port : '',
    placeEmoji:
      typeof portEmoji === 'string' ? portEmoji : typeof day.placeEmoji === 'string' ? day.placeEmoji : '',
    pool: migratePool(day.pool),
    // The Scoring Policy (ADR 0011) resolves on read the same way the pool
    // does. Docs written before the field existed — every Day of both live
    // Events — carry no key, and `scoringForDay` derives them from the closing
    // pool, which is precisely the comparison the scoring paths used to make.
    // Filling it here is a convenience for consumers reading a converted doc;
    // it is NOT the contract, because raw-hydrated paths bypass this converter
    // entirely — those resolve through `scoringForDay` at comparison time.
    scoring: scoringForDay(day),
  } as DayDef;
}

/**
 * Resolve a persisted Event date-window field pair to the current contract
 * (#566): `startsOn`/`endsOn`, with the pre-rename `sailStart`/`sailEnd` read
 * as fallbacks. A doc carrying neither (malformed/partial) resolves to '' —
 * the date-range formatters already degrade an invalid ISO date to "no range"
 * rather than throwing.
 */
function migrateEventWindow(data: Record<string, unknown>): { startsOn: string; endsOn: string } {
  const pick = (current: unknown, legacy: unknown): string =>
    typeof current === 'string' ? current : typeof legacy === 'string' ? legacy : '';
  return {
    startsOn: pick(data.startsOn, data.sailStart),
    endsOn: pick(data.endsOn, data.sailEnd),
  };
}

// The July sailing's zone — the default a missing or invalid `timezone` field
// resolves to so day-scheduling consumers always read a real IANA zone.
const DEFAULT_TIMEZONE = 'Europe/Rome';

/**
 * Resolve a persisted `timezone` to a usable IANA zone. A legacy Event doc
 * (seeded before Phase 1.5) carries no field; a malformed one can carry '',
 * whitespace, a non-string, or a bogus id like 'Mars/Olympus'. The contract is
 * a *real named IANA zone* — not an offset id ('+02:00', 'Etc/GMT+5') or a
 * bare abbreviation ('EST'), which some runtimes' `Intl.DateTimeFormat` will
 * happily accept even though day-scheduling consumers expect a canonical zone.
 *
 * Validate/canonicalize with `Intl.DateTimeFormat` after explicitly rejecting
 * offset-style ids, GMT/UTC/Etc zones, and separator-less abbreviations.
 * `supportedValuesOf('timeZone')` is not enough by itself because runtimes can
 * accept still-valid IANA aliases (for example Europe/Kyiv) while listing only
 * the runtime's canonical spelling. Anything that fails resolves to
 * `Europe/Rome`.
 */
export function normalizeTimezone(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_TIMEZONE;
  const tz = raw.trim();

  if (
    /^[+-]\d/.test(tz) ||
    /GMT|UTC|Etc\//i.test(tz) ||
    !tz.includes('/')
  ) {
    return DEFAULT_TIMEZONE;
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
    return canonical.includes('/') && !/GMT|UTC|Etc\//i.test(canonical)
      ? canonical
      : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

// Events read through the Claim Mode migration so a pre-rename persisted value
// (seeded or in-flight docs) resolves to the current contract; every other field
// passes through untouched.
export const eventConverter: FirestoreDataConverter<EventDoc> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => {
    const data = snap.data() as EventDoc;
    const days = Array.isArray(data.days) ? data.days.map(migrateDayFields) : [];
    return {
      ...data,
      claimMode: migrateClaimMode(data.claimMode),
      // Event docs seeded/written before #113 carry no `bannedUids`; default a
      // missing (or malformed non-array) field to [] so consumers read the
      // presentational hide/mute roster (ADR 0004 Phase 0) as [] rather than
      // undefined. Writes only ever emit a real array.
      bannedUids: Array.isArray(data.bannedUids) ? data.bannedUids : [],
      // Event docs seeded/written before Phase 1.5 carry no `days`/`timezone`.
      // Default a missing (or malformed non-array) `days` to [] and resolve a
      // missing/empty/invalid `timezone` to a real IANA zone ('Europe/Rome',
      // the July sailing's zone) via `normalizeTimezone` so day-scheduling
      // consumers read a real schedule/zone rather than undefined and a
      // not-yet-migrated doc never throws downstream (daily-cards-spec §
      // "Migration"). Writes only ever emit real values. Each Day additionally
      // reads through the #566 field migration (`migrateDayFields`) so a doc
      // persisting the pre-rename `port`/`portEmoji` resolves to the current
      // `place`/`placeEmoji` contract.
      days,
      timezone: normalizeTimezone(data.timezone),
      // The CONFIGURED Standings Freeze (ADR 0011). Absent on every doc written
      // before the field existed, so resolve it here the same way the runtime
      // helper does — a stored instant wins, else the first ceremonial Day's
      // `unlockAt`, which is the moment the old pool-scanning derivation froze
      // at. Both live Events therefore freeze at exactly the instant they
      // always did while reading a stated field. `standingsFreezeAtFor` is
      // still the contract every consumer holds (raw-hydrated event re-reads
      // never pass through here); resolving on the converted doc just means a
      // surface reading `event.standingsFreezeAt` directly is never wrong. The
      // already-migrated `days` go in, so the derivation sees the same
      // normalized pools every other consumer does.
      standingsFreezeAt:
        standingsFreezeAtFor({ standingsFreezeAt: data.standingsFreezeAt, days, frozenAt: data.frozenAt }) ??
        undefined,
      // The Event date window reads through the #566 rename too: `startsOn`/
      // `endsOn`, with the legacy `sailStart`/`sailEnd` as read fallbacks.
      ...migrateEventWindow(data as unknown as Record<string, unknown>),
      // `frozenAt` (the finale freeze stamp, #217) needs no default: it is
      // optional and absent until the 08:00-Day-10 scheduler run sets it, so a
      // pre-finale/legacy Event doc reads it through the spread above as
      // `undefined` (unset), exactly the pre-freeze state consumers branch on.
      // `mostLovedPhoto` (#560) rides the same reasoning and passes through the
      // spread untouched: ABSENT means "not yet computed" (the scheduler beat's
      // idempotence key) while present-with-empty-`winners` is the explicit
      // no-award record — inventing a default here would erase the distinction
      // the write-once guard depends on.
    };
  },
};
// Boards read through a `dayIndex` default so a legacy/current Board (written
// before the day-scoped path #204 exists, one Board per Player per Event) reads
// as Day 0 rather than `undefined`, which day-aware consumers would branch on.
// The write side stamps `dayIndex: 0` too; a real day-scoped write emits its own.
// `cells` normalizes through the #457 wire boundary (src/game/cells.ts): the
// stored shape is a MAP keyed by cell index since the cells-map migration —
// with the legacy array still readable (pre-migration caches/docs) — while the
// app-side contract stays `Cell[]`. Writes emit the map, so a converter-routed
// full-board write can never reintroduce the array shape the rules now reject.
export const boardConverter: FirestoreDataConverter<BoardDoc> = {
  toFirestore: (data) => ({
    ...(data as DocumentData),
    ...(Array.isArray((data as BoardDoc).cells) ? { cells: cellsToMap((data as BoardDoc).cells) } : {}),
  }),
  fromFirestore: (snap: QueryDocumentSnapshot) => {
    const data = snap.data() as Omit<BoardDoc, 'cells'> & { cells: unknown };
    return {
      ...data,
      cells: cellsFromData(data.cells),
      dayIndex: typeof data.dayIndex === 'number' ? data.dayIndex : 0,
    };
  },
};
// Players read through a `reshufflesUsed` default so a legacy Player row (every
// row written before #378 — the counter ships with no backfill) reads as 0 spent
// rather than `undefined`, which the chip's `used < 3` gate would branch on
// wrongly (`undefined < 3` is false, silently hiding the chip from every existing
// Player). Mirrors `boardConverter.dayIndex` above: a `typeof` guard, not `??`,
// so a persisted null/string reads as 0 too. Writes only ever emit a real number.
export const playerConverter: FirestoreDataConverter<PlayerDoc> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => {
    const data = snap.data() as PlayerDoc;
    return {
      ...data,
      reshufflesUsed: typeof data.reshufflesUsed === 'number' ? data.reshufflesUsed : 0,
    };
  },
};
export const userConverter = passthrough<UserDoc>();

// Items carry their doc id (used as the stable key when dealing boards).
export const itemConverter: FirestoreDataConverter<ItemDoc> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => {
    const data = snap.data() as Omit<ItemDoc, 'id'>;
    return {
      ...data,
      id: snap.id,
      // Items seeded/written before Phase 1.5 carry no `pool` (defaults to
      // 'main', mirroring the `bannedUids` default above), and items written
      // before the #565 rename persist 'embark'/'farewell' — both resolve
      // through `migratePool` so existing Prompts read the current contract
      // without a data backfill (daily-cards-spec § "Migration").
      pool: migratePool(data.pool),
    };
  },
};

export const proofConverter: FirestoreDataConverter<ProofDoc> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => ({
    ...(snap.data() as Omit<ProofDoc, 'id'>),
    id: snap.id,
  }),
};

export const claimConverter: FirestoreDataConverter<ClaimDoc> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => ({
    ...(snap.data() as Omit<ClaimDoc, 'id'>),
    id: snap.id,
  }),
};

// A Feed Moment (ADR 0002): a broadcast BINGO / Blackout / First-to-BINGO beat,
// read from events/{EVENT_ID}/moments/{momentId}. Like proofs/claims it carries
// its own doc id (the Feed keys on it), so pin `id` to `snap.id`. The write side
// (src/data/moments.ts) never stores media or a proofId — a Moment marks *that*
// something happened, not what it looked like.
export const momentConverter: FirestoreDataConverter<MomentDoc> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => ({
    ...(snap.data() as Omit<MomentDoc, 'id'>),
    id: snap.id,
  }),
};

// A Notice (specs/admin-messages.md): an admin-authored broadcast, read from
// events/{EVENT_ID}/notices/{noticeId}. Like proofs/moments it carries its own
// doc id (the Feed keys on it), so pin `id` to `snap.id`. The write side
// (src/data/notices.ts) uses a raw ref and never stores `id`.
export const noticeConverter: FirestoreDataConverter<NoticeDoc> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => ({
    ...(snap.data() as Omit<NoticeDoc, 'id'>),
    id: snap.id,
  }),
};

// A per-Prompt Tally marker (ADR 0002): one Player's attributed entry in a
// Prompt's Tally, read from events/{EVENT_ID}/tally/{itemId}/markers/{uid}. The
// doc id IS the marker's uid (firestore.rules keys the self-write on it — a
// forgery-deniable attribution), so pin `uid` to `snap.id` rather than trusting
// the stored field. This is the read side of the count + tap-to-see-who list.
export const tallyMarkerConverter: FirestoreDataConverter<TallyEntry> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => ({
    ...(snap.data() as Omit<TallyEntry, 'uid'>),
    uid: snap.id,
  }),
};

// A Doubt (ADR 0001): one Player publicly asking another to back up a marked
// Prompt — "pics or it didn't happen", social pressure never a gate — read from
// events/{EVENT_ID}/doubts/{doubtId}. Like proofs/claims/moments it carries its
// own doc id (the read hook + derivation key on it), so pin `id` to `snap.id`.
// The write side (src/data/doubts.ts) uses a raw ref and never stores `id`.
// A Heart on a Feed post (specs/feed-hearts.md) — same id-from-path shape as
// the doubt/moment converters.
export const heartConverter: FirestoreDataConverter<HeartDoc> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => ({
    ...(snap.data() as Omit<HeartDoc, 'id'>),
    id: snap.id,
  }),
};

export const doubtConverter: FirestoreDataConverter<DoubtDoc> = {
  toFirestore: (data) => data as DocumentData,
  fromFirestore: (snap: QueryDocumentSnapshot) => ({
    ...(snap.data() as Omit<DoubtDoc, 'id'>),
    id: snap.id,
  }),
};

// A per-Day honor doc (daily-cards-spec § "Data model"), read from
// events/{EVENT_ID}/days/{dayIndex}/meta/{dayIndex} — a `meta` subcollection
// whose single document id IS the encoded dayIndex (a valid document path).
// Passthrough — no `id` to pin, because the doc id is that path-encoded
// dayIndex (the reading ticket, #212, owns the path helper). Holds that Day's
// own First to BINGO.
export const dayMetaConverter = passthrough<DayMetaDoc>();
