import { useSyncExternalStore } from 'react';
import { adultContentRequired, subscribeAdultContent } from '../adultContent';

/**
 * The 18+ posture, as reactive React state (Phase 4b P1).
 *
 * `adultContentRequired()` is a plain module read, which is right for the
 * callers that are not components — `AuthContext`'s callbacks, the flip
 * confirm's guard, `resolveEvent`. But a component that read it directly would
 * only pick up a change when something ELSE re-rendered it, so a tab open when
 * the Event turned adult would keep rendering the ungated shell indefinitely.
 *
 * `useSyncExternalStore` over the store's own subscription: the posture is
 * resolved before React exists and is read from non-component code, so it
 * cannot live in a context provider without becoming two sources of truth.
 * One store, two readers.
 */
export function useAdultContent(): boolean {
  return useSyncExternalStore(subscribeAdultContent, adultContentRequired, adultContentRequired);
}
