/**
 * Browser-held Event invitation state.
 *
 * This module is deliberately free of Firebase, React, and analytics imports so
 * `entry.tsx` can load it before anything capable of observing the current URL.
 */

export const EVENT_INVITATION_FRAGMENT_KEY = 'fa_invite';

/** The same-origin browser slot used while authentication leaves and returns. */
export const PENDING_EVENT_INVITATION_KEY = 'fa:event-invitation';

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

export function isEventInvitationCode(value: string): boolean {
  return EVENT_INVITATION_TOKEN_PATTERN.test(value);
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

function readStore(name: 'sessionStorage' | 'localStorage'): string | null {
  try {
    return storeNamed(name)?.getItem(PENDING_EVENT_INVITATION_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStore(name: 'sessionStorage' | 'localStorage', serialized: string): void {
  try {
    storeNamed(name)?.setItem(PENDING_EVENT_INVITATION_KEY, serialized);
  } catch {
    /* The other store or the current document's memory may still be usable. */
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

function parseRecordShape(raw: string | null): PendingEventInvitationRecord | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const { code, origin, capturedAt } = parsed as Record<string, unknown>;
  if (typeof code !== 'string' || !isEventInvitationCode(code)) return null;
  if (typeof origin !== 'string' || !isOrigin(origin)) return null;
  if (
    typeof capturedAt !== 'number' ||
    !Number.isSafeInteger(capturedAt) ||
    capturedAt < 0
  ) {
    return null;
  }
  return { code, origin, capturedAt };
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

function sameRecord(
  left: PendingEventInvitationRecord | null,
  right: PendingEventInvitationRecord,
): boolean {
  return (
    left?.code === right.code &&
    left.origin === right.origin &&
    left.capturedAt === right.capturedAt
  );
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
  const code = readEventInvitationCode(input.hash);
  if (code === null || !isOrigin(input.origin)) return null;
  const capturedAt = input.now ?? Date.now();
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) return null;

  const record: PendingEventInvitationRecord = {
    code,
    origin: input.origin,
    capturedAt,
  };
  memoryRecord = record;

  const serialized = JSON.stringify(record);
  writeStore('sessionStorage', serialized);
  writeStore('localStorage', serialized);

  return readPendingEventInvitation({ origin: input.origin, now: record.capturedAt });
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

  const sessionRecord = usableRecord(
    parseRecordShape(readStore('sessionStorage')),
    input.origin,
    now,
  );
  const localRecord = usableRecord(parseRecordShape(readStore('localStorage')), input.origin, now);
  const currentRecord =
    usableRecord(memoryRecord, input.origin, now) ?? sessionRecord ?? localRecord;
  if (currentRecord === null) return null;

  return {
    record: currentRecord,
    durable: sameRecord(sessionRecord, currentRecord) || sameRecord(localRecord, currentRecord),
  };
}

/**
 * Delete only copies that still equal the invitation the caller consumed.
 *
 * localStorage is shared across tabs. An older redemption must never erase a
 * newer invitation another tab captured while it was in flight.
 */
export function forgetPendingEventInvitationIf(expected: PendingEventInvitationRecord): boolean {
  let removed = false;
  if (sameRecord(memoryRecord, expected)) {
    memoryRecord = null;
    removed = true;
  }

  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      const storage = storeNamed(name);
      if (!storage) continue;
      if (!sameRecord(parseRecordShape(storage.getItem(PENDING_EVENT_INVITATION_KEY)), expected)) {
        continue;
      }
      storage.removeItem(PENDING_EVENT_INVITATION_KEY);
      removed = true;
    } catch {
      /* An unavailable store must not widen this into an unconditional clear. */
    }
  }
  return removed;
}
