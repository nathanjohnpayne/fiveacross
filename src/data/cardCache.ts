import type { Cell, CardSnapshot, CardSnapshotDay } from '../types';

// Re-exported for convenience so existing importers (Board, CachedCardFallback,
// App, tests) can keep pulling the snapshot shape from this module; the single
// definition of record lives in src/types.ts with the other domain contracts.
export type { CardSnapshot, CardSnapshotDay };

// The active Event id, seeded the SAME way src/firebase.ts does. Deliberately
// NOT imported from ../firebase so this pure localStorage helper never pulls
// the Firebase app-init module into a consumer's import graph — a bare
// save/load round-trip must run in a unit test without Firebase config.
//
// Kept in sync by `setCardCacheEventId`, which startup resolution calls
// alongside `applyResolvedEventId` (#543). Without that, a multi-Event build —
// which ships with NO `VITE_EVENT_ID`, since its presence is what marks a
// bundle as single-Event — would leave this at the 'med-2026' default while
// every Firestore path used the resolved id. The cache would then key on a
// different Event than the data it caches, which is precisely the cross-Event
// bleed the key comment below promises to prevent.
let EVENT_ID = import.meta.env.VITE_EVENT_ID || 'med-2026';

/** Point the cache at the resolved Event. Startup only, before any read or
 *  write — re-pointing it later orphans everything already stored under the
 *  previous key rather than migrating it. */
export function setCardCacheEventId(id: string): void {
  EVENT_ID = id;
}

// Bump when the stored shape changes: an older-version blob reads as a MISS
// (null), never as a mis-shaped card.
const SNAPSHOT_VERSION = 1;

// One key per (event, user, day): the card this device painted for that Day.
// Event-scoped exactly like `hasCachedCard` (src/data/api.ts) so a PRIOR cruise's
// snapshot can never render for a new Event, uid-scoped so account B never sees
// account A's saved card, and day-scoped so switching Days offline cannot show
// the last card painted for a different Day.
function keyFor(uid: string, dayIndex: number | null): string {
  return `gcb:card-snapshot:${EVENT_ID}:${uid}:${dayIndex === null ? 'legacy' : `day-${dayIndex}`}`;
}

function latestKeyFor(uid: string): string {
  return `gcb:card-snapshot:${EVENT_ID}:${uid}:latest`;
}

// localStorage access throws in some privacy modes (and is absent under SSR),
// so every touch is guarded — a missing store means "no durable cache", never
// a crash. The durable cache is an ENHANCEMENT over the live Firestore-cached
// Board, never a dependency of it.
function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNullableString(v: unknown): v is string | null {
  return typeof v === 'string' || v === null;
}

function isSnapshotDay(v: unknown): v is CardSnapshotDay | null {
  if (v === null) return true;
  return (
    isRecord(v) &&
    isFiniteNumber(v.number) &&
    typeof v.place === 'string' &&
    typeof v.placeEmoji === 'string' &&
    typeof v.theme === 'string' &&
    typeof v.label === 'string'
  );
}

/**
 * Coerce a stored Day blob written before the #566 field rename — `port`/
 * `portEmoji` instead of `place`/`placeEmoji` — into the current shape, so a
 * device's existing durable card survives the rename instead of reading as a
 * miss mid-Event. Same read-coerce/write-new pattern as the converters
 * (`migrateClaimMode`); writes only ever emit the new keys. Anything that is
 * not a legacy-shaped record passes through untouched for `isSnapshotDay` to
 * judge.
 */
function normalizeSnapshotDay(v: unknown): unknown {
  if (!isRecord(v) || typeof v.place === 'string') return v;
  const { port, portEmoji, ...rest } = v as Record<string, unknown>;
  if (typeof port !== 'string' || typeof portEmoji !== 'string') return v;
  return { ...rest, place: port, placeEmoji: portEmoji };
}

function isSnapshotCell(v: unknown): v is Cell {
  if (!isRecord(v)) return false;
  const status = v.status;
  const proofId = v.proofId;
  return (
    Number.isInteger(v.index) &&
    typeof v.itemId !== 'undefined' &&
    isNullableString(v.itemId) &&
    typeof v.text === 'string' &&
    typeof v.free === 'boolean' &&
    typeof v.marked === 'boolean' &&
    typeof v.markedAt !== 'undefined' &&
    (isFiniteNumber(v.markedAt) || v.markedAt === null) &&
    (typeof proofId === 'undefined' || isNullableString(proofId)) &&
    (typeof status === 'undefined' || status === 'confirmed' || status === 'pending')
  );
}

function isSnapshotCells(v: unknown): v is Cell[] {
  if (!Array.isArray(v) || v.length !== 25) return false;
  const seen = new Set<number>();
  for (const cell of v) {
    if (!isSnapshotCell(cell) || cell.index < 0 || cell.index > 24 || seen.has(cell.index)) return false;
    if (cell.index === 12) {
      if (!cell.free || cell.itemId !== null || !cell.marked) return false;
    } else if (cell.free || cell.itemId === null) {
      return false;
    }
    seen.add(cell.index);
  }
  return seen.size === 25;
}

function isDayIndex(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
}

function parseSnapshot(raw: string, uid: string, requiredDayIndex: number | null | undefined): CardSnapshot | null {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return null;
  const day = normalizeSnapshotDay(parsed.day);
  if (
    parsed.v !== SNAPSHOT_VERSION ||
    parsed.uid !== uid ||
    parsed.eventId !== EVENT_ID ||
    !isDayIndex(parsed.dayIndex) ||
    (requiredDayIndex !== undefined && parsed.dayIndex !== requiredDayIndex) ||
    !isFiniteNumber(parsed.savedAt) ||
    !isFiniteNumber(parsed.bingoCount) ||
    !isSnapshotCells(parsed.cells) ||
    !isSnapshotDay(day)
  ) {
    return null;
  }
  return {
    v: SNAPSHOT_VERSION,
    uid,
    eventId: EVENT_ID,
    dayIndex: parsed.dayIndex,
    savedAt: parsed.savedAt,
    bingoCount: parsed.bingoCount,
    cells: parsed.cells,
    day,
  };
}

/**
 * Persist the card the Player is currently looking at, so a later transient
 * deal failure or offline reload can render it in place of the full-screen
 * "we couldn't deal your card" reload screen (#434). Best-effort: an empty
 * card, a missing store, or a quota/serialization failure is swallowed.
 */
export function saveCardSnapshot(input: {
  uid: string;
  dayIndex: number | null;
  cells: Cell[];
  bingoCount: number;
  day: CardSnapshotDay | null;
}): void {
  const ls = store();
  if (!ls || !input.uid || input.cells.length === 0) return;
  const snapshot: CardSnapshot = {
    v: SNAPSHOT_VERSION,
    uid: input.uid,
    eventId: EVENT_ID,
    dayIndex: input.dayIndex,
    savedAt: Date.now(),
    bingoCount: input.bingoCount,
    cells: input.cells,
    day: input.day,
  };
  try {
    const serialized = JSON.stringify(snapshot);
    ls.setItem(keyFor(input.uid, input.dayIndex), serialized);
    ls.setItem(latestKeyFor(input.uid), serialized);
  } catch {
    /* quota exceeded / serialization failure — skip; the live Board still renders */
  }
}

/**
 * This device's durable card snapshot for (event, user), or null on ANY miss:
 * absent, unparseable, a stale schema version, or a uid/event mismatch (so
 * another account's or another cruise's card is never rendered). Reads the
 * local store only — no network, never throws.
 */
export function loadCardSnapshot(uid: string, dayIndex?: number | null): CardSnapshot | null {
  const ls = store();
  if (!ls || !uid) return null;
  try {
    const raw = ls.getItem(dayIndex === undefined ? latestKeyFor(uid) : keyFor(uid, dayIndex));
    if (!raw) return null;
    return parseSnapshot(raw, uid, dayIndex);
  } catch {
    return null;
  }
}

/** True when a renderable card snapshot exists for this (event, user). */
export function hasCardSnapshot(uid: string, dayIndex?: number | null): boolean {
  return loadCardSnapshot(uid, dayIndex) !== null;
}
