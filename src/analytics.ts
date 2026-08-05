import { logEvent, setDefaultEventParameters } from 'firebase/analytics';
import { analytics } from './firebase';
import { phCapture, phRegister } from './posthog';
import { markSquareOccurred } from './hooks/useToastStack';
import { activeEdition } from './editions';

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

/**
 * Five Across's single Brand identity (CONTEXT.md § Brand: "One Brand
 * exists"). A constant, not a lookup — unlike Edition and Event there is
 * exactly one value, and it never varies per build or per hostname.
 */
export const BRAND_ID = 'five-across';

// The full MERGED set of GA4 default event params registered so far this
// load (#556, Codex P2 finding). `setDefaultEventParameters` OVERWRITES
// Firebase Analytics' single pending pre-init value on each call rather than
// merging it (`@firebase/analytics` keeps exactly one
// `defaultEventParametersForInit` slot) — so calling it twice before GA4
// finishes loading (`registerAnalyticsDimensions` at startup, then
// `registerDayIndexDimension` once the Event doc arrives) would otherwise
// silently drop whatever the first call set. Passing the full merged set on
// EVERY call is correct whether GA4 has finished loading or not: once it
// has, gtag's own `"set"` command merges anyway, so resending
// already-applied keys is a harmless no-op.
let ga4Dims: Record<string, unknown> = {};

/** Register `props` as default params on BOTH sinks — the shared mechanism
 *  behind `registerAnalyticsDimensions` and `registerDayIndexDimension`. */
function registerBothSinks(props: Record<string, unknown>): void {
  ga4Dims = { ...ga4Dims, ...props };
  try {
    setDefaultEventParameters(ga4Dims);
  } catch {
    /* no-op */
  }
  // `phRegister` keeps its own merged copy (posthog.ts) for the reset()
  // case, so it only needs THIS call's incremental props, not the full set.
  phRegister(props);
}

/**
 * Register the Event-identity dimensions every subsequent analytics event on
 * BOTH sinks must carry (#556, part of #532): `brand_id`, `edition_id`,
 * `event_id`, `event_slug`. Registered ONCE, at startup — the GA4-side
 * `setDefaultEventParameters` and PostHog-side `phRegister` are each this
 * module's existing "register, don't thread through every call site"
 * mechanism, the same posture `track()` already takes toward per-event
 * params. Call site: `main.tsx`, right after `bootstrapEventResolution`
 * resolves a `kind: 'event'` Resolution (src/eventResolution.ts).
 *
 * `edition_id` reads `activeEdition()` (src/editions.ts) at call time rather
 * than taking an argument: `bootstrapEventResolution` installs the resolved
 * Edition via `setActiveEdition` before returning, so the accessor already
 * reflects it (or the env-seeded default, for a single-Event build) by the
 * time a caller can reach this function.
 *
 * `eventSlug` falls back to the Event id when the Slug is unknown — a
 * single-Event build's Resolution never read a `hostnames/{host}` document
 * (see `Resolution.slug`'s own doc in eventResolution.ts), so it has no
 * separate Slug to report and the Event id is the closest identifier there is.
 */
export function registerAnalyticsDimensions(resolved: { eventId: string; eventSlug: string | null }): void {
  registerBothSinks({
    brand_id: BRAND_ID,
    edition_id: activeEdition(),
    event_id: resolved.eventId,
    event_slug: resolved.eventSlug ?? resolved.eventId,
  });
}

/**
 * Register the `day_index` dimension (#556) — kept SEPARATE from
 * `registerAnalyticsDimensions` because it is not known at startup. It comes
 * from the signed-in Event doc's Day schedule (`todaysDayIndex`,
 * src/theme/autoTheme.ts), resolved only once `useEventDoc` loads, and it
 * CHANGES mid-session the moment a Day unlocks. `main.tsx`'s `ThemedApp`
 * calls this from a `useEffect` keyed on the resolved index — the same
 * schedule it already watches to recompute `todaysDayTheme` — rather than
 * threading `dayIndex` through every `track()` call site (most of which,
 * e.g. `login` or `share_click`, have no Day context of their own to pass).
 *
 * A `null` index (no Event doc yet, or no Days configured) is a deliberate
 * no-op: there is nothing correct to register yet, and leaving the
 * dimension unset is a better answer than guessing. A previously-registered
 * value is not cleared by a later `null` — the same "sticks for the
 * session" posture `registerAnalyticsDimensions`'s dimensions already have.
 */
export function registerDayIndexDimension(dayIndex: number | null): void {
  if (dayIndex == null) return;
  registerBothSinks({ day_index: dayIndex });
}
