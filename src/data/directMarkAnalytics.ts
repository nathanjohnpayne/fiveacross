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
const outboxStorageKey = (uid: string) => `five-across:board-analytics-outbox:${EVENT_ID}:${uid}`;

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

function storedOutbox(uid: string): Map<string, BoardAnalyticsEvent> {
  try {
    const raw = localStorage.getItem(outboxStorageKey(uid));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const events = Array.isArray(parsed)
      ? parsed.map(parseDirectMarkAnalyticsEvent).filter((event): event is BoardAnalyticsEvent => event !== null)
      : [];
    return new Map(events.map((event) => [event.transitionId, event]));
  } catch {
    return new Map();
  }
}

/** A transition is cursor-safe only once this write read-backs. A termination
 * between this point and `track()` replays the outbox on the next mount. */
function storeOutbox(uid: string, outbox: Map<string, BoardAnalyticsEvent>): boolean {
  try {
    const encoded = JSON.stringify([...outbox.values()]);
    localStorage.setItem(outboxStorageKey(uid), encoded);
    return localStorage.getItem(outboxStorageKey(uid)) === encoded;
  } catch {
    return false;
  }
}

function dispatch(event: BoardAnalyticsEvent): boolean {
  if (event.name === 'echo_mark') {
    return track('echo_mark', {
      trigger: event.trigger,
      uid: event.uid,
      ...(event.dayIndex === undefined ? {} : { dayIndex: event.dayIndex }),
      count: 1,
      transitionId: event.transitionId,
      commitOrder: event.commitOrder,
    });
  }
  return track(
    event.name,
    {
      ...(event.name === 'mark_square' ? { source: 'pledge', marked: true } : {}),
      mode: event.mode,
      uid: event.uid,
      ...(event.dayIndex === undefined ? {} : { dayIndex: event.dayIndex }),
      transitionId: event.transitionId,
      commitOrder: event.commitOrder,
    },
    { localMarkOccurred: event.name === 'mark_square' && isLocalDirectMarkRequest(event.requestId) },
  );
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
  const outbox = storedOutbox(uid);
  const cursor = storedCursor(uid);
  const flushOutbox = () => {
    for (const event of [...outbox.values()]) {
      if (!dispatch(event)) return false;
      outbox.delete(event.transitionId);
      if (!storeOutbox(uid, outbox)) return false;
      delivered.add(event.transitionId);
      storeIds(uid, delivered);
    }
    return true;
  };
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
        // A cache-only snapshot can be newer at one position but older at
        // another. Never use it to advance the high-water cursor: doing so
        // would make `startAfter` skip a server row this tab never saw.
        if (snapshot.metadata?.fromCache === true) return;
        if (!flushOutbox()) return;
        let cursorSafe = true;
        let lastCursor: DeliveryCursor | null = null;
        for (const row of snapshot.docs) {
          const event = parseDirectMarkAnalyticsEvent(row.data());
          const nextCursor = rowCursor(row.data().recordedAt, row.id);
          if (!event || delivered.has(event.transitionId)) {
            if (nextCursor) lastCursor = nextCursor;
            continue;
          }
          outbox.set(event.transitionId, event);
          const durableBeforeDispatch = storeOutbox(uid, outbox);
          if (!dispatch(event)) {
            cursorSafe = false;
            break;
          }
          // An embedded webview can be denied localStorage. It may still
          // receive analytics, but it has no crash-safe acknowledgement, so
          // deliberately leave the cursor behind for an at-least-once replay.
          if (!durableBeforeDispatch) {
            cursorSafe = false;
            continue;
          }
          outbox.delete(event.transitionId);
          if (!storeOutbox(uid, outbox)) {
            outbox.set(event.transitionId, event);
            cursorSafe = false;
            break;
          }
          delivered.add(event.transitionId);
          storeIds(uid, delivered);
          if (nextCursor) lastCursor = nextCursor;
        }
        if (cursorSafe && lastCursor) storeCursor(uid, lastCursor);
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
