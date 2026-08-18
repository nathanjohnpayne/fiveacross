import { Timestamp, collection, documentId, onSnapshot, orderBy, query, startAfter } from 'firebase/firestore';
import {
  analyticsInitializationSettled,
  trackToAnalyticsSinks,
  type AnalyticsSinkSelection,
} from '../analytics';
import { onPostHogReady } from '../posthog';
import { db, EVENT_ID } from '../firebase';
import { isLocalDirectMarkRequest } from './markAnalytics';
import type { ClaimMode } from '../types';

export type DirectMarkAnalyticsEvent = {
  name: 'mark_square' | 'unmark_square';
  source?: 'pledge' | 'proof' | 'admin_confirm';
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

// #764: a sink that throws AFTER both one-shot readiness signals
// (`analyticsInitializationSettled`, `onPostHogReady`) have already fired
// once has no other wake-up left short of a fresh Firestore snapshot or a
// remount — this bounded-backoff timer is that wake-up. Kept low-single-digit
// seconds initially so a transient hiccup drains quickly, doubling up to a
// two-minute ceiling so a genuinely broken sink does not spin the tab.
const RETRY_INITIAL_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 120_000;

type DeliveryCursor = { seconds: number; nanoseconds: number; id: string };
type PendingDelivery = { event: BoardAnalyticsEvent; pending: AnalyticsSinkSelection };

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

function parsePendingDelivery(value: unknown): PendingDelivery | null {
  const entry = value as Partial<PendingDelivery> | null;
  const event = parseDirectMarkAnalyticsEvent(entry?.event ?? value);
  if (!event) return null;
  const pending = entry?.pending;
  if (pending && typeof pending.ga4 === 'boolean' && typeof pending.posthog === 'boolean') {
    return { event, pending: { ga4: pending.ga4, posthog: pending.posthog } };
  }
  // Migrate an outbox written before per-sink acknowledgements. Replaying it
  // is intentionally at-least-once, which is safer than dropping a sink.
  return { event, pending: { ga4: true, posthog: true } };
}

function storedOutbox(uid: string): Map<string, PendingDelivery> {
  try {
    const raw = localStorage.getItem(outboxStorageKey(uid));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const events = Array.isArray(parsed)
      ? parsed.map(parsePendingDelivery).filter((entry): entry is PendingDelivery => entry !== null)
      : [];
    return new Map(events.map((entry) => [entry.event.transitionId, entry]));
  } catch {
    return new Map();
  }
}

/** A transition is cursor-safe only once this write read-backs. A termination
 * between this point and `track()` replays the outbox on the next mount. */
function storeOutbox(uid: string, outbox: Map<string, PendingDelivery>): boolean {
  try {
    const encoded = JSON.stringify([...outbox.values()]);
    localStorage.setItem(outboxStorageKey(uid), encoded);
    return localStorage.getItem(outboxStorageKey(uid)) === encoded;
  } catch {
    return false;
  }
}

function dispatch(delivery: PendingDelivery): PendingDelivery {
  const { event, pending } = delivery;
  let acknowledged: AnalyticsSinkSelection;
  if (event.name === 'echo_mark') {
    acknowledged = trackToAnalyticsSinks('echo_mark', {
      trigger: event.trigger,
      uid: event.uid,
      ...(event.dayIndex === undefined ? {} : { dayIndex: event.dayIndex }),
      count: 1,
      transitionId: event.transitionId,
      commitOrder: event.commitOrder,
    }, { posthogOptions: { durableOutbox: true } }, pending);
  } else {
    acknowledged = trackToAnalyticsSinks(
      event.name,
      {
        ...(event.name === 'mark_square' ? { source: event.source, marked: true } : {}),
        mode: event.mode,
        uid: event.uid,
        ...(event.dayIndex === undefined ? {} : { dayIndex: event.dayIndex }),
        transitionId: event.transitionId,
        commitOrder: event.commitOrder,
      },
      {
        // The local install-nudge is an action side effect, not a per-sink
        // delivery side effect. Do it only on the first outbox attempt; a
        // later retry may be for one analytics sink alone.
        localMarkOccurred:
          event.name === 'mark_square' &&
          pending.ga4 &&
          pending.posthog &&
          isLocalDirectMarkRequest(event.requestId),
        posthogOptions: { durableOutbox: true },
      },
      pending,
    );
  }
  return { event, pending: { ga4: !acknowledged.ga4, posthog: !acknowledged.posthog } };
}

function fullyAcknowledged(delivery: PendingDelivery): boolean {
  return !delivery.pending.ga4 && !delivery.pending.posthog;
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
  if (
    event.name === 'mark_square' &&
    (event.source !== 'pledge' && event.source !== 'proof' && event.source !== 'admin_confirm')
  ) {
    return null;
  }
  if (event.name === 'mark_square' && event.marked !== true) return null;
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
  let unsubscribed = false;
  let pendingCursor: DeliveryCursor | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = RETRY_INITIAL_DELAY_MS;
  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  // Reschedules itself with exponential backoff (capped) as long as the
  // outbox still has an unacknowledged entry when the timer fires. A no-op
  // once the outbox is empty or the caller has unsubscribed, so this never
  // outlives what it exists to retry.
  const scheduleRetry = () => {
    if (unsubscribed || outbox.size === 0) return;
    clearRetryTimer();
    const delay = retryDelayMs;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_DELAY_MS);
      if (!unsubscribed) flushOutbox();
    }, delay);
  };
  const attemptDrain = () => {
    for (const delivery of [...outbox.values()]) {
      const updated = dispatch(delivery);
      outbox.set(updated.event.transitionId, updated);
      // Persistence is the preferred crash boundary, but constrained browsers
      // can block or exhaust localStorage. Keep retrying in memory there;
      // because the cursor does not advance until every sink acknowledges,
      // Firestore replays the immutable transition on the next mount.
      storeOutbox(uid, outbox);
      if (!fullyAcknowledged(updated)) return false;
      outbox.delete(updated.event.transitionId);
      storeOutbox(uid, outbox);
      delivered.add(updated.event.transitionId);
      storeIds(uid, delivered);
    }
    if (pendingCursor) {
      storeCursor(uid, pendingCursor);
      pendingCursor = null;
    }
    return true;
  };
  // Every existing wake-up (a Firestore snapshot, either one-shot readiness
  // signal, and now the retry timer below) funnels through this single
  // entrypoint, so backoff state stays consistent no matter which one fired:
  // a full drain resets the backoff and cancels any pending timer; a partial
  // drain (still-unacknowledged entries) arms the next retry.
  const flushOutbox = () => {
    const drained = attemptDrain();
    if (drained) {
      retryDelayMs = RETRY_INITIAL_DELAY_MS;
      clearRetryTimer();
    } else {
      scheduleRetry();
    }
    return drained;
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
    const unsubscribe = onSnapshot(
      transitions,
      (snapshot) => {
        // A cache-only snapshot can be newer at one position but older at
        // another. Never use it to advance the high-water cursor: doing so
        // would make `startAfter` skip a server row this tab never saw.
        if (snapshot.metadata?.fromCache === true) return;
        let lastCursor: DeliveryCursor | null = null;
        for (const row of snapshot.docs) {
          const event = parseDirectMarkAnalyticsEvent(row.data());
          const nextCursor = rowCursor(row.data().recordedAt, row.id);
          if (!event || delivered.has(event.transitionId)) {
            if (nextCursor) lastCursor = nextCursor;
            continue;
          }
          // Queue the entire server snapshot before attempting a sink. A
          // temporarily unavailable first row must not strand its later rows
          // until Firestore happens to emit another snapshot.
          if (!outbox.has(event.transitionId)) {
            outbox.set(event.transitionId, { event, pending: { ga4: true, posthog: true } });
          }
          if (nextCursor) lastCursor = nextCursor;
        }
        if (lastCursor) pendingCursor = lastCursor;
        storeOutbox(uid, outbox);
        flushOutbox();
      },
      () => {
        // Analytics must never disrupt the Board when a listener is briefly
        // unavailable; immutable records are read on the next subscription.
      },
    );
    // The listener can receive its first server snapshot before Firebase
    // Analytics finishes initializing. `trackToAnalyticsSinks` retains that
    // pending GA4 delivery in the outbox; retry it once readiness settles even
    // if Firestore has no further snapshot to wake this listener.
    const retryOutbox = () => {
      if (!unsubscribed) flushOutbox();
    };
    void analyticsInitializationSettled.then(retryOutbox);
    const stopPostHogRetry = onPostHogReady(retryOutbox);
    return () => {
      unsubscribed = true;
      unsubscribe();
      stopPostHogRetry();
      clearRetryTimer();
    };
  } catch {
    // Keep lightweight component tests and constrained webviews from treating
    // an unavailable analytics listener as a gameplay failure.
    return () => {};
  }
}
