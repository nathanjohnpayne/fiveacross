/**
 * Browser-held Event invitation state.
 *
 * This module is deliberately free of Firebase, React, and analytics imports so
 * `entry.tsx` can load it before anything capable of observing the current URL.
 */

export const EVENT_INVITATION_FRAGMENT_KEY = 'fa_invite';

/** Namespace for immutable same-origin records held across authentication. */
export const PENDING_EVENT_INVITATION_KEY = 'fa:event-invitation';

const PENDING_EVENT_INVITATION_STORAGE_ID_BYTES = 16;
const PENDING_EVENT_INVITATION_STORAGE_ID_PATTERN = /^[a-f0-9]{32}$/;
const PENDING_EVENT_INVITATION_STORAGE_KEY_ATTEMPTS = 3;
const PENDING_EVENT_INVITATION_STORAGE_PREFIX = `${PENDING_EVENT_INVITATION_KEY}:v1:`;

/**
 * The client-side resumption window.
 *
 * This is not the invitation's authoritative expiry; the server owns that.
 * It only bounds how long an abandoned bearer value is allowed to remain a
 * candidate for an unrelated visit after the player followed its link.
 */
export const PENDING_EVENT_INVITATION_TTL_MS = 30 * 60 * 1000;

/** Exactly one unpadded base64url-encoded 32-byte value. */
export const EVENT_INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface PendingEventInvitationRecord {
  /** Opaque per-capture identity. It is not an authority or a bearer value. */
  captureId: string;
  /** Orders same-millisecond captures observed by this operation. */
  captureOrdinal: number;
  /** The bearer value. It belongs only in memory, browser storage, and the callable body. */
  code: string;
  /** The exact origin that received the invitation. */
  origin: string;
  /** Millisecond epoch used only for the client-side resumption TTL. */
  capturedAt: number;
}

/**
 * A usable invitation and whether a redirect/reload can recover it.
 *
 * Memory is a deliberate fallback: a signed-in player can still redeem on the
 * current page when browser storage is unavailable. Callers that need to leave
 * this document can use `durable` to choose their product-level recovery path.
 */
export interface PendingEventInvitationState {
  record: PendingEventInvitationRecord;
  durable: boolean;
}

export interface CapturePendingEventInvitationInput {
  hash: string;
  origin: string;
  now?: number;
}

export interface ReadPendingEventInvitationInput {
  origin: string;
  now?: number;
}

let memoryRecord: PendingEventInvitationRecord | null = null;
let memoryCaptureSequence = 0;

export function isEventInvitationCode(value: string): boolean {
  return EVENT_INVITATION_TOKEN_PATTERN.test(value);
}

/**
 * Whether the fragment names the invitation credential slot at all.
 *
 * Deliberately broader than {@link readEventInvitationCode}: malformed and
 * duplicate values are not redeemable, but may still contain a real bearer and
 * therefore must be removed before telemetry can observe the URL.
 */
export function hasEventInvitationFragment(hash: string): boolean {
  if (!hash.startsWith('#')) return false;
  return new URLSearchParams(hash.slice(1)).has(EVENT_INVITATION_FRAGMENT_KEY);
}

/** Read an Event invitation only from a URL fragment, never from a query. */
export function readEventInvitationCode(hash: string): string | null {
  if (!hash.startsWith('#')) return null;
  const fragment = hash.slice(1);
  if (fragment === '') return null;
  const codes = new URLSearchParams(fragment).getAll(EVENT_INVITATION_FRAGMENT_KEY);
  if (codes.length !== 1) return null;
  return isEventInvitationCode(codes[0]) ? codes[0] : null;
}

/** A store, or `undefined` when privacy settings make even its getter throw. */
function storeNamed(name: 'sessionStorage' | 'localStorage'): Storage | undefined {
  try {
    return globalThis[name];
  } catch {
    return undefined;
  }
}

interface StoredPendingEventInvitation {
  key: string;
  record: PendingEventInvitationRecord | null;
}

function storageIdFromKey(key: string): string | null {
  if (!key.startsWith(PENDING_EVENT_INVITATION_STORAGE_PREFIX)) return null;
  const id = key.slice(PENDING_EVENT_INVITATION_STORAGE_PREFIX.length);
  return PENDING_EVENT_INVITATION_STORAGE_ID_PATTERN.test(id) ? id : null;
}

function readStore(name: 'sessionStorage' | 'localStorage'): StoredPendingEventInvitation[] {
  try {
    const storage = storeNamed(name);
    if (!storage) return [];
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && storageIdFromKey(key) !== null);
    return keys.flatMap((key) => {
      const captureId = storageIdFromKey(key)!;
      const record = parseRecordShape(storage.getItem(key), captureId);
      return [{ key, record }];
    });
  } catch {
    return [];
  }
}

function storeHasKey(name: 'sessionStorage' | 'localStorage', key: string): boolean {
  try {
    return storeNamed(name)?.getItem(key) != null;
  } catch {
    return false;
  }
}

function storeHasRecord(
  name: 'sessionStorage' | 'localStorage',
  key: string,
  expected: PendingEventInvitationRecord,
): boolean {
  try {
    const storage = storeNamed(name);
    const captureId = storageIdFromKey(key);
    if (!storage || captureId === null) return false;
    return sameRecord(parseRecordShape(storage.getItem(key), captureId), expected);
  } catch {
    return false;
  }
}

interface CaptureIdentity {
  captureId: string;
  storageKey: string | null;
}

function newCaptureIdentity(): CaptureIdentity {
  for (let attempt = 0; attempt < PENDING_EVENT_INVITATION_STORAGE_KEY_ATTEMPTS; attempt += 1) {
    try {
      const bytes = new Uint8Array(PENDING_EVENT_INVITATION_STORAGE_ID_BYTES);
      globalThis.crypto.getRandomValues(bytes);
      const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const key = `${PENDING_EVENT_INVITATION_STORAGE_PREFIX}${id}`;
      if (!storeHasKey('sessionStorage', key) && !storeHasKey('localStorage', key)) {
        return { captureId: id, storageKey: key };
      }
    } catch {
      break;
    }
  }
  memoryCaptureSequence += 1;
  return { captureId: `memory:${memoryCaptureSequence}`, storageKey: null };
}

function writeStore(
  name: 'sessionStorage' | 'localStorage',
  key: string,
  serialized: string,
): boolean {
  try {
    const storage = storeNamed(name);
    if (!storage) return false;
    storage.setItem(key, serialized);
    return true;
  } catch {
    /* The other store or the current document's memory may still be usable. */
    return false;
  }
}

function removeStored(
  name: 'sessionStorage' | 'localStorage',
  stored: StoredPendingEventInvitation,
): boolean {
  try {
    const storage = storeNamed(name);
    if (!storage) return false;
    storage.removeItem(stored.key);
    return true;
  } catch {
    return false;
  }
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

function parseRecordShape(
  raw: string | null,
  expectedCaptureId: string,
): PendingEventInvitationRecord | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const { captureId, captureOrdinal, code, origin, capturedAt } = parsed as Record<string, unknown>;
  if (captureId !== expectedCaptureId) return null;
  if (
    typeof captureOrdinal !== 'number' ||
    !Number.isSafeInteger(captureOrdinal) ||
    captureOrdinal < 0
  ) {
    return null;
  }
  if (typeof code !== 'string' || !isEventInvitationCode(code)) return null;
  if (typeof origin !== 'string' || !isOrigin(origin)) return null;
  if (
    typeof capturedAt !== 'number' ||
    !Number.isSafeInteger(capturedAt) ||
    capturedAt < 0
  ) {
    return null;
  }
  return { captureId, captureOrdinal, code, origin, capturedAt };
}

function usableRecord(
  record: PendingEventInvitationRecord | null,
  origin: string,
  now: number,
): PendingEventInvitationRecord | null {
  if (record === null || record.origin !== origin) return null;
  if (now < record.capturedAt || now - record.capturedAt > PENDING_EVENT_INVITATION_TTL_MS) {
    return null;
  }
  return record;
}

function expiredRecord(
  record: PendingEventInvitationRecord | null,
  origin: string,
  now: number,
): record is PendingEventInvitationRecord {
  return (
    record !== null &&
    record.origin === origin &&
    now >= record.capturedAt &&
    now - record.capturedAt > PENDING_EVENT_INVITATION_TTL_MS
  );
}

function sameRecord(
  left: PendingEventInvitationRecord | null,
  right: PendingEventInvitationRecord,
): boolean {
  return (
    left?.code === right.code &&
    left.captureId === right.captureId &&
    left.captureOrdinal === right.captureOrdinal &&
    left.origin === right.origin &&
    left.capturedAt === right.capturedAt
  );
}

interface PendingCaptureOrder {
  captureId: string;
  captureOrdinal: number;
  capturedAt: number;
}

function compareCaptureOrder(left: PendingCaptureOrder, right: PendingCaptureOrder): number {
  if (left.capturedAt !== right.capturedAt) return left.capturedAt < right.capturedAt ? -1 : 1;
  if (left.captureOrdinal !== right.captureOrdinal) {
    return left.captureOrdinal < right.captureOrdinal ? -1 : 1;
  }
  if (left.captureId === right.captureId) return 0;
  return left.captureId < right.captureId ? -1 : 1;
}

interface NextCaptureOrdinal {
  captureOrdinal: number;
  resetObservedSameTime: boolean;
}

function nextCaptureOrdinal(
  origin: string,
  capturedAt: number,
  stored: readonly StoredPendingEventInvitation[],
): NextCaptureOrdinal {
  let maximum =
    memoryRecord?.origin === origin &&
    memoryRecord.capturedAt === capturedAt
      ? memoryRecord.captureOrdinal
      : -1;
  for (const entry of stored) {
    const record = entry.record;
    if (record?.origin !== origin || record.capturedAt !== capturedAt) continue;
    if (record.captureOrdinal > maximum) maximum = record.captureOrdinal;
  }
  if (maximum === Number.MAX_SAFE_INTEGER) {
    return { captureOrdinal: 0, resetObservedSameTime: true };
  }
  return { captureOrdinal: maximum + 1, resetObservedSameTime: false };
}

function observedAtOrBeforeReplacement(
  record: PendingEventInvitationRecord,
  origin: string,
  replacement: PendingCaptureOrder,
  resetObservedSameTime: boolean,
): boolean {
  if (record.origin !== origin) return false;
  if (resetObservedSameTime && record.capturedAt === replacement.capturedAt) return true;
  return compareCaptureOrder(record, replacement) <= 0;
}

function newestUsableRecord(
  stored: readonly StoredPendingEventInvitation[],
  origin: string,
  now: number,
): PendingEventInvitationRecord | null {
  const newest = stored.reduce<StoredPendingEventInvitation | null>((current, entry) => {
    const record = usableRecord(entry.record, origin, now);
    if (record === null) return current;
    if (current === null || compareCaptureOrder(record, current.record!) > 0) return entry;
    return current;
  }, null);
  return newest?.record ?? null;
}

/**
 * Capture a valid invitation before the rest of the application is imported.
 *
 * Both stores are best-effort and independently verified. The in-memory copy
 * is always kept so storage denial does not make the current page discard a
 * valid invitation after it has safely removed the fragment.
 */
export function capturePendingEventInvitation(
  input: CapturePendingEventInvitationInput,
): PendingEventInvitationState | null {
  if (!isOrigin(input.origin)) return null;
  const code = readEventInvitationCode(input.hash);
  const capturedAt = input.now ?? Date.now();
  if (code === null || !Number.isSafeInteger(capturedAt) || capturedAt < 0) {
    if (
      hasEventInvitationFragment(input.hash) &&
      Number.isSafeInteger(capturedAt) &&
      capturedAt >= 0
    ) {
      forgetPendingEventInvitationsForOrigin(input.origin, capturedAt);
    }
    return null;
  }

  // Snapshot the records this arrival supersedes before publishing its unique
  // key. Cleanup then names only those immutable keys: a concurrent capture
  // ordered after this one can never be mistaken for an old record.
  // localStorage is the only cross-tab store, so snapshot it before touching
  // tab-local state. A different tab that publishes after this read can never
  // enter the cleanup set below.
  const localRecords = readStore('localStorage');
  const sessionRecords = readStore('sessionStorage');
  const nextOrdinal = nextCaptureOrdinal(input.origin, capturedAt, [
    ...localRecords,
    ...sessionRecords,
  ]);
  const identity = newCaptureIdentity();
  const record: PendingEventInvitationRecord = {
    captureId: identity.captureId,
    captureOrdinal: nextOrdinal.captureOrdinal,
    code,
    origin: input.origin,
    capturedAt,
  };
  const priorLocalRecords = localRecords.filter(
    (stored) =>
      stored.record === null ||
      stored.record.origin !== input.origin ||
      observedAtOrBeforeReplacement(
        stored.record,
        input.origin,
        record,
        nextOrdinal.resetObservedSameTime,
      ),
  );
  const priorSessionRecords = sessionRecords.filter(
    (stored) =>
      stored.record === null ||
      stored.record.origin !== input.origin ||
      observedAtOrBeforeReplacement(
        stored.record,
        input.origin,
        record,
        nextOrdinal.resetObservedSameTime,
      ),
  );
  memoryRecord = record;

  if (identity.storageKey !== null) {
    const serialized = JSON.stringify(record);
    writeStore('sessionStorage', identity.storageKey, serialized);
    writeStore('localStorage', identity.storageKey, serialized);
  }
  for (const stored of priorSessionRecords) removeStored('sessionStorage', stored);
  for (const stored of priorLocalRecords) removeStored('localStorage', stored);

  return {
    record,
    durable:
      identity.storageKey !== null &&
      (storeHasRecord('sessionStorage', identity.storageKey, record) ||
        storeHasRecord('localStorage', identity.storageKey, record)),
  };
}

/**
 * Supersede every copy from this origin after an explicitly tagged replacement
 * fails validation. Each immutable key is deleted from a snapshot so a newer
 * key written by another tab between the snapshot and delete survives.
 */
function forgetPendingEventInvitationsForOrigin(
  origin: string,
  capturedAt: number,
): void {
  const localRecords = readStore('localStorage');
  const sessionRecords = readStore('sessionStorage');
  const nextOrdinal = nextCaptureOrdinal(origin, capturedAt, [
    ...localRecords,
    ...sessionRecords,
  ]);
  const replacement: PendingCaptureOrder = {
    captureId: newCaptureIdentity().captureId,
    captureOrdinal: nextOrdinal.captureOrdinal,
    capturedAt,
  };
  if (
    memoryRecord?.origin === origin &&
    observedAtOrBeforeReplacement(
      memoryRecord,
      origin,
      replacement,
      nextOrdinal.resetObservedSameTime,
    )
  ) {
    memoryRecord = null;
  }
  for (const [name, records] of [
    ['localStorage', localRecords],
    ['sessionStorage', sessionRecords],
  ] as const) {
    for (const stored of records) {
      if (
        stored.record === null ||
        stored.record.origin !== origin ||
        observedAtOrBeforeReplacement(
          stored.record,
          origin,
          replacement,
          nextOrdinal.resetObservedSameTime,
        )
      ) {
        removeStored(name, stored);
      }
    }
  }
}

/**
 * Return the invitation for this exact origin when it is still inside the
 * client resumption window.
 *
 * The current document's capture wins first; after a reload, tab-scoped
 * sessionStorage wins over the cross-tab fallback in localStorage.
 */
export function readPendingEventInvitation(
  input: ReadPendingEventInvitationInput,
): PendingEventInvitationState | null {
  const now = input.now ?? Date.now();
  if (!isOrigin(input.origin) || !Number.isSafeInteger(now) || now < 0) return null;

  const storedLocalRecords = readStore('localStorage');
  const storedSessionRecords = readStore('sessionStorage');
  if (expiredRecord(memoryRecord, input.origin, now)) memoryRecord = null;
  for (const [name, storedRecords] of [
    ['sessionStorage', storedSessionRecords],
    ['localStorage', storedLocalRecords],
  ] as const) {
    for (const stored of storedRecords) {
      if (
        stored.record === null ||
        stored.record.origin !== input.origin ||
        expiredRecord(stored.record, input.origin, now)
      ) {
        removeStored(name, stored);
      }
    }
  }

  const sessionRecord = newestUsableRecord(storedSessionRecords, input.origin, now);
  const localRecord = newestUsableRecord(storedLocalRecords, input.origin, now);
  const currentRecord =
    usableRecord(memoryRecord, input.origin, now) ?? sessionRecord ?? localRecord;
  if (currentRecord === null) return null;

  return {
    record: currentRecord,
    durable: sameRecord(sessionRecord, currentRecord) || sameRecord(localRecord, currentRecord),
  };
}

/**
 * Delete only immutable entries that equal the invitation the caller consumed.
 *
 * localStorage is shared across tabs. An older redemption has no mutable slot
 * with which it could erase a newer invitation captured while it was in flight.
 */
export function forgetPendingEventInvitationIf(expected: PendingEventInvitationRecord): boolean {
  let removed = false;
  const storedLocalRecords = readStore('localStorage');
  const storedSessionRecords = readStore('sessionStorage');
  if (sameRecord(memoryRecord, expected)) {
    memoryRecord = null;
    removed = true;
  }

  for (const [name, records] of [
    ['localStorage', storedLocalRecords],
    ['sessionStorage', storedSessionRecords],
  ] as const) {
    for (const stored of records) {
      if (sameRecord(stored.record, expected) && removeStored(name, stored)) removed = true;
    }
  }
  return removed;
}
