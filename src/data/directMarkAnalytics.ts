import { collection, onSnapshot } from 'firebase/firestore';
import { track } from '../analytics';
import { db, EVENT_ID } from '../firebase';
import type { ClaimMode } from '../types';

export type DirectMarkAnalyticsEvent = {
  name: 'mark_square' | 'unmark_square';
  source?: 'pledge';
  mode: ClaimMode;
  marked?: true;
  uid: string;
  dayIndex?: number;
  transitionId: string;
};

const deliveredStorageKey = (uid: string) => `five-across:direct-mark-analytics:${EVENT_ID}:${uid}`;
const MAX_DELIVERED_IDS = 1000;

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
    localStorage.setItem(deliveredStorageKey(uid), JSON.stringify([...ids].slice(-MAX_DELIVERED_IDS)));
  } catch {
    // Browser storage is an optimization only. Transition IDs remain durable
    // and the sink-side reconciliation still groups an at-least-once replay.
  }
}

export function parseDirectMarkAnalyticsEvent(value: unknown): DirectMarkAnalyticsEvent | null {
  const event = value as Partial<DirectMarkAnalyticsEvent> | null;
  if (
    !event ||
    (event.name !== 'mark_square' && event.name !== 'unmark_square') ||
    (event.mode !== 'honor' && event.mode !== 'proof_required' && event.mode !== 'admin_confirmed') ||
    typeof event.uid !== 'string' ||
    typeof event.transitionId !== 'string' ||
    event.transitionId.length === 0 ||
    (event.dayIndex !== undefined && !Number.isInteger(event.dayIndex))
  ) {
    return null;
  }
  if (event.name === 'mark_square' && (event.source !== 'pledge' || event.marked !== true)) return null;
  if (event.name === 'unmark_square' && (event.source !== undefined || event.marked !== undefined)) return null;
  return event as DirectMarkAnalyticsEvent;
}

/**
 * Delivers immutable server-observed records once per browser profile. A fresh
 * browser may replay historical rows; exports group by `transitionId`, while
 * this local acknowledgement avoids repeatedly replaying the same history on
 * ordinary remounts and listener reconnects.
 */
export function subscribeDirectMarkAnalytics(uid: string): () => void {
  const delivered = storedIds(uid);
  try {
    return onSnapshot(
      collection(db, 'events', EVENT_ID, 'players', uid, 'analyticsTransitions'),
      (snapshot) => {
        for (const doc of snapshot.docs) {
          const event = parseDirectMarkAnalyticsEvent(doc.data());
          if (!event || delivered.has(event.transitionId)) continue;
          track(event.name, {
            ...(event.name === 'mark_square' ? { source: 'pledge', marked: true } : {}),
            mode: event.mode,
            uid: event.uid,
            ...(event.dayIndex === undefined ? {} : { dayIndex: event.dayIndex }),
            transitionId: event.transitionId,
          });
          delivered.add(event.transitionId);
          storeIds(uid, delivered);
        }
      },
      () => {
        // Analytics must never disrupt the Board when a listener is briefly
        // unavailable; the immutable records are read on the next subscription.
      },
    );
  } catch {
    // Keep lightweight component tests and constrained webviews from treating
    // an unavailable analytics listener as a gameplay failure.
    return () => {};
  }
}
