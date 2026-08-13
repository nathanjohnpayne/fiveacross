import type { ClaimMode } from '../types';

/**
 * A fresh request token accompanies every direct Board toggle. It is NOT an
 * analytics identity: a Firestore trigger derives that from the committed
 * before/after board state. The token only tells the trigger which cell and
 * claim-mode a client intended to toggle, including when the write was queued
 * offline and reaches the server long after this tab has gone away.
 */
export interface DirectMarkAnalyticsRequest {
  id: string;
  cellIndex: number;
  marked: boolean;
  mode: ClaimMode;
  source: 'pledge' | 'proof' | 'admin_confirm';
}

const localRequestStorageKey = 'five-across:local-direct-mark-requests';
const MAX_LOCAL_REQUEST_IDS = 100;

function localRequestIds(): string[] {
  try {
    const raw = localStorage.getItem(localRequestStorageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberLocalMarkRequest(id: string): void {
  try {
    const ids = localRequestIds().filter((known) => known !== id);
    ids.push(id);
    localStorage.setItem(localRequestStorageKey, JSON.stringify(ids.slice(-MAX_LOCAL_REQUEST_IDS)));
  } catch {
    // The server-observed event remains valid. This only decides whether this
    // browser, rather than another tab for the same player, gets the local
    // first-mark install-nudge side effect.
  }
}

/** True only for a mark request issued by this browser profile. */
export function isLocalDirectMarkRequest(id: string): boolean {
  return localRequestIds().includes(id);
}

function requestId(): string {
  // All supported browsers expose randomUUID. The fallback keeps test and
  // embedded-webview environments collision-resistant without depending on a
  // local counter that a second tab or a reload could repeat.
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `mark-request:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function directMarkAnalyticsRequest(params: {
  cellIndex: number;
  marked: boolean;
  mode: ClaimMode;
  source?: DirectMarkAnalyticsRequest['source'];
  id?: string;
}): DirectMarkAnalyticsRequest {
  const request = {
    id: params.id ?? requestId(),
    cellIndex: params.cellIndex,
    marked: params.marked,
    mode: params.mode,
    source: params.source ?? 'pledge',
  };
  if (request.marked) rememberLocalMarkRequest(request.id);
  return request;
}
