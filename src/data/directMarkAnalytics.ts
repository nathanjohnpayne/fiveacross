import { Timestamp, collection, documentId, onSnapshot, orderBy, query, startAfter } from 'firebase/firestore';
import { track } from '../analytics';
import { db, EVENT_ID } from '../firebase';
import { isLocalDirectMarkRequest } from './markAnalytics';
import type { ClaimMode } from '../types';

export type DirectMarkAnalyticsEvent = {
  name: 'mark_square' | 'unmark_square';
  source?: 'pledge';
  mode: ClaimMode;
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

const deliveredStorageKey = (uid: string) => `five-across:board-analytics:${EVENT_ID}:${uid}`;
const cursorStorageKey = (uid: string) => `five-across:board-analytics-cursor:${EVENT_ID}:${uid}`;

type DeliveryCursor = { seconds: number; nanoseconds: number; id: string };

function storedIds(uid: string): Set<string> {
  try {
    const raw = localStorage.getItem(deliveredStorageKey(uid));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function storeIds(uid: string, ids: Set<string>): void {
  try {
    // Do not rotate this acknowledgement set: rotating made an old immutable
    // row become a fresh delivery after enough marks. If storage is exhausted,
    // the sink still receives at-least-once events keyed by transitionId.
    localStorage.setItem(deliveredStorageKey(uid), JSON.stringify([...ids]));
  } catch {
    // Browser storage is an optimization only. Transition IDs remain durable
    // and sink-side reconciliation still groups an at-least-once replay.
  }
}

function storedCursor(uid: string): DeliveryCursor | null {
  try {
    const raw = localStorage.getItem(cursorStorageKey(uid));
    const value = raw ? (JSON.parse(raw) as Partial<DeliveryCursor>) : null;
    if (
      !value ||
      typeof value.seconds !== 'number' ||
      !Number.isSafeInteger(value.seconds) ||
      typeof value.nanoseconds !== 'number' ||
      !Number.isInteger(value.nanoseconds) ||
      value.nanoseconds < 0 ||
      value.nanoseconds > 999_999_999 ||
      typeof value.id !== 'string' ||
      value.id.length === 0
    ) {
      return null;
    }
    return { seconds: value.seconds, nanoseconds: value.nanoseconds, id: value.id };
  } catch {
    return null;
  }
}

function rowCursor(value: unknown, id: string): DeliveryCursor | null {
  const timestamp = value as { seconds?: unknown; nanoseconds?: unknown } | null;
  if (
    !timestamp ||
    typeof timestamp.seconds !== 'number' ||
    !Number.isSafeInteger(timestamp.seconds) ||
    typeof timestamp.nanoseconds !== 'number' ||
    !Number.isInteger(timestamp.nanoseconds) ||
    timestamp.nanoseconds < 0 ||
    timestamp.nanoseconds > 999_999_999 ||
    id.length === 0
  ) {
    return null;
  }
  return { seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds, id };
}

function storeCursor(uid: string, cursor: DeliveryCursor): void {
  try {
    localStorage.setItem(cursorStorageKey(uid), JSON.stringify(cursor));
  } catch {
    // The next mount will replay at least once if a browser cannot persist its
    // cursor. Sinks still deduplicate that retry on transitionId.
  }
}

export function parseDirectMarkAnalyticsEvent(value: unknown): BoardAnalyticsEvent | null {
  const event = value as Partial<BoardAnalyticsEvent> | null;
  if (
    !event ||
    typeof event.uid !== 'string' ||
    typeof event.transitionId !== 'string' ||
    event.transitionId.length === 0 ||
    typeof event.commitOrder !== 'string' ||
    event.commitOrder.length === 0 ||
    (event.dayIndex !== undefined && !Number.isInteger(event.dayIndex))
  ) {
    return null;
  }
  if (event.name === 'echo_mark') {
    if (
      (event.trigger !== 'deal' &&
        event.trigger !== 'reshuffle' &&
        event.trigger !== 'mark' &&
        event.trigger !== 'open_reconcile' &&
        event.trigger !== 'admin_confirm') ||
      event.count !== 1
    ) {
      return null;
    }
    return event as EchoAnalyticsEvent;
  }
  if (
    (event.name !== 'mark_square' && event.name !== 'unmark_square') ||
    (event.mode !== 'honor' && event.mode !== 'proof_required' && event.mode !== 'admin_confirmed') ||
    typeof event.requestId !== 'string' ||
    event.requestId.length === 0
  ) {
    return null;
  }
  if (event.name === 'mark_square' && (event.source !== 'pledge' || event.marked !== true)) return null;
  if (event.name === 'unmark_square' && (event.source !== undefined || event.marked !== undefined)) return null;
  return event as DirectMarkAnalyticsEvent;
}

/**
 * Delivers immutable server-observed Board transitions once per browser
 * profile. `commitOrder` is a Firestore document-version key, not trigger
 * arrival time, so a rapid mark → unmark → mark can be reconstructed in its
 * actual committed sequence even when Functions executions overlap.
 */
export function subscribeDirectMarkAnalytics(uid: string): () => void {
  const delivered = storedIds(uid);
  const cursor = storedCursor(uid);
  try {
    const rows = collection(db, 'events', EVENT_ID, 'players', uid, 'analyticsTransitions');
    const transitions = cursor
      ? query(
          rows,
          orderBy('recordedAt'),
          orderBy(documentId()),
          startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id),
        )
      : query(
          rows,
          orderBy('recordedAt'),
          orderBy(documentId()),
        );
    return onSnapshot(
      transitions,
      (snapshot) => {
        for (const row of snapshot.docs) {
          const event = parseDirectMarkAnalyticsEvent(row.data());
          const nextCursor = rowCursor(row.data().recordedAt, row.id);
          if (!event || delivered.has(event.transitionId)) {
            if (nextCursor) storeCursor(uid, nextCursor);
            continue;
          }
          if (event.name === 'echo_mark') {
            track('echo_mark', {
              trigger: event.trigger,
              uid: event.uid,
              ...(event.dayIndex === undefined ? {} : { dayIndex: event.dayIndex }),
              count: 1,
              transitionId: event.transitionId,
              commitOrder: event.commitOrder,
            });
          } else {
            track(
              event.name,
              {
                ...(event.name === 'mark_square' ? { source: 'pledge', marked: true } : {}),
                mode: event.mode,
                uid: event.uid,
                ...(event.dayIndex === undefined ? {} : { dayIndex: event.dayIndex }),
                transitionId: event.transitionId,
                commitOrder: event.commitOrder,
              },
              // A server row can arrive in every active tab for this uid. Only
              // the browser that created the original mark request gets the
              // local install-nudge side effect; durable sink delivery is
              // otherwise intentionally shared and at-least-once.
              { localMarkOccurred: event.name === 'mark_square' && isLocalDirectMarkRequest(event.requestId) },
            );
          }
          delivered.add(event.transitionId);
          storeIds(uid, delivered);
          if (nextCursor) storeCursor(uid, nextCursor);
        }
      },
      () => {
        // Analytics must never disrupt the Board when a listener is briefly
        // unavailable; immutable records are read on the next subscription.
      },
    );
  } catch {
    // Keep lightweight component tests and constrained webviews from treating
    // an unavailable analytics listener as a gameplay failure.
    return () => {};
  }
}
