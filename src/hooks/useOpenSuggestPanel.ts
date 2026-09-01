import { useSyncExternalStore } from 'react';
import { EVENT_ID } from '../firebase';

/**
 * Card/Feed → More "Suggest a square" bridge (#559) — the SAME module-store
 * intent pattern `useOpenSquare.ts` uses for the Feed → Board bridge: the
 * "put it on tomorrow's card" entry point (TomorrowsCardInvite.tsx, mounted
 * on both the Card and the Feed) hands More an intent — open its Suggest
 * panel, where `ItemPool` already lives (#203/#208 moved Prompts off the tab
 * bar into a More sub-panel) — then navigates to the More tab. More consumes
 * the intent through its OWN `panel` state, so this never forks or
 * reimplements ItemPool's suggestion box.
 *
 * In-memory, one Event-scoped pending intent (last write wins), never
 * persisted — same shape as `useOpenSquare.ts`.
 */
let pendingEventId: string | null = null;
const listeners = new Set<() => void>();

export function requestOpenSuggestPanel(): void {
  pendingEventId = EVENT_ID;
  listeners.forEach((l) => l());
}

/** More calls this once it has acted on (or dropped) the intent. */
export function clearOpenSuggestPanel(): void {
  if (pendingEventId === null) return;
  pendingEventId = null;
  listeners.forEach((l) => l());
}

/** Test-only. */
export function __resetOpenSuggestPanelForTests(): void {
  pendingEventId = null;
  listeners.clear();
}

export function useOpenSuggestPanelIntent(): boolean {
  const current = () => pendingEventId === EVENT_ID;
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    current,
    current,
  );
}
