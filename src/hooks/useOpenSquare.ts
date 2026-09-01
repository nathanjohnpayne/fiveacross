import { useSyncExternalStore } from 'react';
import { EVENT_ID } from '../firebase';

/**
 * Feed → Board square-opening bridge (#261, daily-cards-spec § "Tally
 * Cards"): a Tally Card's ＋ Proof / 🙋 Got it too buttons hand Board an
 * intent — "open the claim/proof sheet for this Prompt on this Day" — then
 * navigate to the Card tab. Board consumes the intent through its OWN sheet
 * machinery (viewed-day switch, attribution guards, win-Moment pipeline), so
 * the Feed never re-implements any claim logic.
 *
 * Same module-store bridge pattern as `useToastStack`'s claim-sheet-open
 * signal: in-memory, one pending intent (last write wins), never persisted.
 */
export interface OpenSquareIntent {
  eventId: string;
  dayIndex: number;
  itemId: string;
}

let pending: OpenSquareIntent | null = null;
const listeners = new Set<() => void>();

export function requestOpenSquare(
  intent: Omit<OpenSquareIntent, 'eventId'> & { eventId?: string },
): void {
  pending = { ...intent, eventId: intent.eventId ?? EVENT_ID };
  listeners.forEach((l) => l());
}

/** Board calls this once it has acted on (or dropped) the intent. */
export function clearOpenSquare(): void {
  if (pending === null) return;
  pending = null;
  listeners.forEach((l) => l());
}

/** Test-only. */
export function __resetOpenSquareForTests(): void {
  pending = null;
  listeners.clear();
}

export function useOpenSquareIntent(): OpenSquareIntent | null {
  const current = () => (pending?.eventId === EVENT_ID ? pending : null);
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    current,
    current,
  );
}
