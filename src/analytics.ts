import { logEvent } from 'firebase/analytics';
import { analytics } from './firebase';
import { phCapture } from './posthog';
import { markSquareOccurred } from './hooks/useToastStack';

/**
 * GA4 event catalog — the single source of truth for every analytics event
 * this app fires (the PRD's "GA4 events" list plus the Doubt-flow
 * `demand_proof` event). `track()` below is the only call into Firebase's
 * `logEvent`; nothing else should import `firebase/analytics` directly.
 * Call sites: `login` + `login_failed` (auth/AuthContext.tsx), `join_event` (App.tsx),
 * `add_item` + `report_item` (components/ItemPool.tsx, ProofFeed.tsx),
 * `mark_square` + `bingo` + `blackout` (components/Board.tsx),
 * `attach_proof` (components/ProofSheet.tsx), `theme_change`
 * (components/ThemeSwitcher.tsx), `text_size_change` (components/More.tsx,
 * #215), `share_click` (components/Celebration.tsx).
 * `demand_proof` (Doubt flow, #33) and `install_pwa` (install-prompt flow,
 * #30) are catalogued and type-checked here so each ticket can add its one
 * call site as a one-line `track(...)` addition; this ticket (#38) does not
 * build either flow.
 */
export const GA4_EVENTS = [
  'login',
  'login_failed',
  'join_event',
  'add_item',
  'report_item',
  'mark_square',
  'attach_proof',
  'demand_proof',
  'bingo',
  'blackout',
  'theme_change',
  'text_size_change',
  'share_click',
  'install_pwa',
  // Reshuffle (#378, specs/reshuffle.md) — a Player traded a pristine Day Card
  // for a fresh deal. Params: `dayIndex`, `reshufflesUsed` (the resulting spend,
  // 1..3). Call site: components/ReshuffleSheet.tsx.
  'reshuffle_card',
  // Hearts (specs/feed-hearts.md) — a Player toggled a like on a Feed post.
  // Params: `targetKind` ('proof' | 'moment'), `on` (true = hearted, false =
  // unhearted). Fired only once the write persists (the demand_proof posture).
  // Call site: src/data/hearts.ts.
  'heart_post',
  // A Mark's atomic batch was REJECTED online (#387) — a rules denial rolled
  // back the optimistic write and the square visibly reverted. Params: `code`
  // (the FirebaseError code, e.g. 'permission-denied'), `index`, `marked`,
  // `dayIndex`, `daily`. The 2026-07-17 rules/stale-bundle skew produced
  // exactly this failure, but it was only visible in the console logs of the
  // subset of sessions replay happened to capture; as a first-class event it
  // is queryable, alertable, and countable the moment a deploy starts
  // reverting players' marks.
  // Call site: src/data/api.ts (setMark's commit-rejection handler).
  'mark_rejected',
] as const;

export type GA4EventName = (typeof GA4_EVENTS)[number];

/**
 * Fire an analytics event to BOTH sinks — GA4 and PostHog (#96) — from one call
 * site. Each sink is independently guarded and never throws, so one being
 * unavailable (or failing) never blocks the other. Same event name + params go
 * to both. These explicit events are additive: PostHog also autocaptures
 * pageviews, clicks, heatmaps, and session replays (see posthog.ts). Never throws.
 */
export function track(name: GA4EventName, params?: Record<string, unknown>): void {
  try {
    // Firebase's `logEvent` overloads key off literal reserved event names
    // (e.g. `login`), so a union type like `GA4EventName` matches no single
    // overload — widen to `string` (the SDK's generic-event overload).
    if (analytics) logEvent(analytics, name as string, params as Record<string, unknown>);
  } catch {
    /* no-op */
  }
  // PostHog, alongside GA4 — same event, same params (internally guarded).
  phCapture(name, params);
  // Install nudge trigger (#219, daily-cards-spec § "Install nudge and
  // update banner"): reuses this existing `mark_square` call site as the
  // signal instead of a new one in Board.tsx — see useToastStack's module doc.
  // Gated on `marked === true` (Codex review, PR #238): Board.doMark fires
  // this same event for unmarking too, and an unmark shouldn't count as
  // "the Player marked a Square on this device" (e.g. marks synced from
  // another device, then undone here first).
  if (name === 'mark_square' && params?.marked === true) markSquareOccurred();
}
