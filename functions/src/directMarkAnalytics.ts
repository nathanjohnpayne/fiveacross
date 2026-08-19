/**
 * Server-observed Board analytics (#721, #727 Phase 4b).
 *
 * A browser may close while an offline Board write is queued, and cached state
 * may later be rolled back by a stale-write/rules rejection. Analytics rows
 * therefore derive exclusively from Firestore's committed before/after
 * snapshots. Every row carries the source document's version key, rather than
 * the asynchronous trigger's arrival order, so consumers can reconstruct the
 * order in which one Board actually changed.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { isAlreadyExists } from './firestoreErrors';

export type DirectMarkAnalyticsEvent = {
  name: 'mark_square' | 'unmark_square';
  source?: 'pledge' | 'proof' | 'admin_confirm';
  mode: 'honor' | 'proof_required' | 'admin_confirmed';
  marked?: true;
  uid: string;
  dayIndex?: number;
  requestId: string;
  transitionId: string;
  commitOrder: string;
};

export type EchoAnalyticsEvent = {
  name: 'echo_mark';
  trigger: 'deal' | 'reshuffle' | 'mark' | 'open_reconcile' | 'admin_confirm';
  uid: string;
  dayIndex?: number;
  count: 1;
  transitionId: string;
  commitOrder: string;
};

export type BoardAnalyticsEvent = DirectMarkAnalyticsEvent | EchoAnalyticsEvent;

type BoardCell = {
  marked?: unknown;
  status?: unknown;
  echo?: unknown;
  echoAnalyticsId?: unknown;
  echoAnalyticsTrigger?: unknown;
};
type DirectRequest = {
  id?: unknown;
  cellIndex?: unknown;
  marked?: unknown;
  mode?: unknown;
  source?: unknown;
};
type BoardWrite = {
  cells?: Record<string, BoardCell>;
  directAnalyticsRequest?: DirectRequest;
};

const CLAIM_MODES = new Set(['honor', 'proof_required', 'admin_confirmed']);
const DIRECT_SOURCES = new Set(['pledge', 'proof', 'admin_confirm']);
const ECHO_TRIGGERS = new Set(['deal', 'reshuffle', 'mark', 'open_reconcile', 'admin_confirm']);

/**
 * Firestore document versions carry seconds and nanoseconds. A fixed-width
 * encoding sorts lexicographically in the same order as those committed
 * versions, including rapid toggles that share a millisecond.
 */
export function firestoreCommitOrder(value: unknown): string | null {
  const timestamp = value as { seconds?: unknown; nanoseconds?: unknown } | null;
  if (
    !timestamp ||
    typeof timestamp.seconds !== 'number' ||
    !Number.isSafeInteger(timestamp.seconds) ||
    typeof timestamp.nanoseconds !== 'number' ||
    !Number.isInteger(timestamp.nanoseconds) ||
    timestamp.nanoseconds < 0 ||
    timestamp.nanoseconds > 999_999_999
  ) {
    return null;
  }
  return `${String(timestamp.seconds).padStart(16, '0')}:${String(timestamp.nanoseconds).padStart(9, '0')}`;
}

/** Returns an event only when this committed write actually crossed its direct edge. */
export function directMarkAnalyticsForWrite(params: {
  before: BoardWrite | undefined;
  after: BoardWrite | undefined;
  uid: string;
  dayIndex?: number;
  transitionId: string;
  commitOrder: string;
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
    !CLAIM_MODES.has(request.mode) ||
    (request.source !== undefined && (typeof request.source !== 'string' || !DIRECT_SOURCES.has(request.source)))
  ) {
    return null;
  }

  const cellKey = String(request.cellIndex);
  const beforeCell = params.before?.cells?.[cellKey];
  const afterCell = params.after?.cells?.[cellKey];
  const beforeMarked = beforeCell?.marked === true;
  const afterMarked = afterCell?.marked === true;
  // Both checks matter: a forged/mismatched request cannot name a different
  // changed cell, and an unchanged server state cannot become an event merely
  // because a stale client wrote a new request token.
  const source = (request.source ?? 'pledge') as NonNullable<DirectMarkAnalyticsEvent['source']>;
  const committedEdge =
    source === 'admin_confirm'
      ? request.marked === true && beforeCell?.status === 'pending' && afterCell?.status === 'confirmed'
      : beforeMarked !== afterMarked && afterMarked === request.marked;
  if (!committedEdge) return null;

  const common = {
    mode: request.mode as DirectMarkAnalyticsEvent['mode'],
    uid: params.uid,
    ...(params.dayIndex === undefined ? {} : { dayIndex: params.dayIndex }),
    requestId: request.id,
    transitionId: params.transitionId,
    commitOrder: params.commitOrder,
  };
  return afterMarked
    ? { name: 'mark_square', source, marked: true, ...common }
    : { name: 'unmark_square', ...common };
}

/**
 * Extracts every newly committed Echo from a Board write. The durable ID and
 * original propagation trigger are stamped with the cells, but this function
 * refuses to report either until Firestore supplies the committed snapshot.
 */
export function echoAnalyticsForWrite(params: {
  before: BoardWrite | undefined;
  after: BoardWrite | undefined;
  uid: string;
  dayIndex?: number;
  commitOrder: string;
}): EchoAnalyticsEvent[] {
  const afterCells = params.after?.cells ?? {};
  return Object.entries(afterCells).flatMap(([cellKey, afterCell]) => {
    const beforeCell = params.before?.cells?.[cellKey];
    const id = afterCell.echoAnalyticsId;
    const trigger = afterCell.echoAnalyticsTrigger;
    if (
      afterCell.marked !== true ||
      beforeCell?.marked === true ||
      afterCell.echo !== true ||
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof trigger !== 'string' ||
      !ECHO_TRIGGERS.has(trigger)
    ) {
      return [];
    }
    return [
      {
        name: 'echo_mark' as const,
        trigger: trigger as EchoAnalyticsEvent['trigger'],
        uid: params.uid,
        ...(params.dayIndex === undefined ? {} : { dayIndex: params.dayIndex }),
        count: 1 as const,
        transitionId: id,
        commitOrder: params.commitOrder,
      },
    ];
  });
}

/** Returns all immutable analytics rows caused by one committed Board write. */
export function boardAnalyticsForWrite(params: {
  before: BoardWrite | undefined;
  after: BoardWrite | undefined;
  uid: string;
  dayIndex?: number;
  transitionId: string;
  commitOrder: string;
}): BoardAnalyticsEvent[] {
  const direct = directMarkAnalyticsForWrite(params);
  return [...(direct ? [direct] : []), ...echoAnalyticsForWrite(params)];
}

type TransitionDoc = { create(data: BoardAnalyticsEvent & { recordedAt: unknown }): Promise<unknown> };
export type DirectMarkAnalyticsStore = { doc(path: string): TransitionDoc };

/**
 * Creates one immutable event row per transition identity. Firestore can
 * redeliver a trigger, so `create()` (rather than a merge set) makes repeated
 * delivery a no-op without allowing it to rewrite the source ordering key.
 */
export async function recordDirectMarkAnalytics(
  store: DirectMarkAnalyticsStore,
  params: Parameters<typeof boardAnalyticsForWrite>[0] & { eventId: string },
): Promise<void> {
  for (const transition of boardAnalyticsForWrite(params)) {
    try {
      await store
        .doc(`events/${params.eventId}/players/${params.uid}/analyticsTransitions/${transition.transitionId}`)
        .create({ ...transition, recordedAt: FieldValue.serverTimestamp() });
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }
}
