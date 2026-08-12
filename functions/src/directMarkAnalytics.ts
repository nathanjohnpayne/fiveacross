/**
 * Server-observed direct Board transitions (#721, #727 Phase 4b).
 *
 * A Board toggle can be queued offline, outlive the browser that initiated it,
 * and arrive after a stale writer. The client therefore writes only a fresh
 * request token. This module derives the analytics event from Firestore's
 * committed before/after snapshots: a stale true→true rewrite is ignored,
 * while a queued mark → unmark → mark sequence gets three distinct CloudEvent
 * identities in the exact order Firestore committed it.
 */

export type DirectMarkAnalyticsEvent = {
  name: 'mark_square' | 'unmark_square';
  source?: 'pledge';
  mode: 'honor' | 'proof_required' | 'admin_confirmed';
  marked?: true;
  uid: string;
  dayIndex?: number;
  transitionId: string;
};

type BoardCell = { marked?: unknown };
type DirectRequest = {
  id?: unknown;
  cellIndex?: unknown;
  marked?: unknown;
  mode?: unknown;
};
type BoardWrite = {
  cells?: Record<string, BoardCell>;
  directAnalyticsRequest?: DirectRequest;
};

const CLAIM_MODES = new Set(['honor', 'proof_required', 'admin_confirmed']);

/** Returns an event only when this committed write actually crossed its edge. */
export function directMarkAnalyticsForWrite(params: {
  before: BoardWrite | undefined;
  after: BoardWrite | undefined;
  uid: string;
  dayIndex?: number;
  transitionId: string;
}): DirectMarkAnalyticsEvent | null {
  const request = params.after?.directAnalyticsRequest;
  const beforeRequest = params.before?.directAnalyticsRequest;
  if (
    !request ||
    typeof request.id !== 'string' ||
    request.id.length === 0 ||
    request.id === beforeRequest?.id ||
    typeof request.cellIndex !== 'number' ||
    !Number.isInteger(request.cellIndex) ||
    request.cellIndex < 0 ||
    request.cellIndex > 24 ||
    typeof request.marked !== 'boolean' ||
    typeof request.mode !== 'string' ||
    !CLAIM_MODES.has(request.mode)
  ) {
    return null;
  }

  const cellKey = String(request.cellIndex);
  const beforeMarked = params.before?.cells?.[cellKey]?.marked === true;
  const afterMarked = params.after?.cells?.[cellKey]?.marked === true;
  // Both checks matter: a forged/mismatched request cannot name a different
  // changed cell, and an unchanged server state cannot become an event merely
  // because a stale client wrote a new request token.
  if (beforeMarked === afterMarked || afterMarked !== request.marked) return null;

  const common = {
    mode: request.mode as DirectMarkAnalyticsEvent['mode'],
    uid: params.uid,
    ...(params.dayIndex === undefined ? {} : { dayIndex: params.dayIndex }),
    transitionId: params.transitionId,
  };
  return afterMarked
    ? { name: 'mark_square', source: 'pledge', marked: true, ...common }
    : { name: 'unmark_square', ...common };
}

type TransitionDoc = { create(data: DirectMarkAnalyticsEvent): Promise<unknown> };
export type DirectMarkAnalyticsStore = { doc(path: string): TransitionDoc };

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

/**
 * Creates one immutable event row per CloudEvent id. Firestore can redeliver a
 * trigger, so `create()` (rather than a merge set) makes repeated delivery a
 * no-op without allowing it to rewrite the original event.
 */
export async function recordDirectMarkAnalytics(
  store: DirectMarkAnalyticsStore,
  params: Parameters<typeof directMarkAnalyticsForWrite>[0] & { eventId: string },
): Promise<void> {
  const transition = directMarkAnalyticsForWrite(params);
  if (!transition) return;
  try {
    await store
      .doc(`events/${params.eventId}/players/${params.uid}/analyticsTransitions/${params.transitionId}`)
      .create(transition);
  } catch (error) {
    if (isAlreadyExists(error)) return;
    throw error;
  }
}
