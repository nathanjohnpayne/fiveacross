/**
 * Pure preview-derivation helpers for the setup wizard's live preview strip
 * (#795, specs/event-setup-wizard.md § "Live preview strip"). No React, no
 * Firebase — everything here is a projection over an in-memory `EventDraft`,
 * so the strip's caption/theme/deal logic is unit-testable without mounting
 * a component, mirroring `draftValidation.ts`'s own posture.
 *
 * This module deliberately does NOT import `draftValidation.ts`'s private
 * `daysInOrder` (it is not exported — scoped there to the validation
 * predicates) or `src/data/api.ts`'s live deal wiring (Firebase-coupled, not
 * importable here). `previewDays` and `dealPreviewCard` below re-derive the
 * same small, well-known rules — hole-dropping/index-sort, and "a main
 * DAILY-CARDS Day mixes the easy pool in; everything else, INCLUDING a
 * `one_card` draft's main-only deal, deals its own pool alone" — as short,
 * independently-testable functions, because a preview's job (show
 * something representative) and a validator's/live-deal's job (enforce a
 * gate / persist a real card) are different concerns that happen to want the
 * same small pieces of arithmetic.
 */

import type { Cell, DraftCuratedPrompt, DraftDayDef, DraftMainPrompt, EventDraft, ThemeId } from '../types';
import { MIN_POOL, dealBoard, type DealItem, type DealOptions } from '../game/logic';
import { normalizePool, type PoolId } from '../game/pool';
import { THEMES, defaultThemeForEdition } from '../theme/themes';
import { FREE_TEXT } from './seed';

/**
 * Fixed so the expanded preview deals the SAME sample card every time it is
 * opened (specs/event-setup-wizard.md acceptance: "deterministic across
 * re-opens"). An arbitrary constant — its only property that matters is that
 * it never changes.
 */
export const PREVIEW_SEED = 0x60ffee;

/**
 * `draft.days`, holes dropped and sorted by `index` — the presentational
 * twin of `draftValidation.ts`'s private `daysInOrder`. A hole (a sparse
 * array entry — see that module's own comments on why one can exist in
 * memory) must not crash a preview any more than it may crash the launch
 * gate.
 */
export function previewDays(draft: EventDraft): DraftDayDef[] {
  return draft.days.filter((day): day is DraftDayDef => day != null).sort((a, b) => a.index - b.index);
}

/** Real (non-hole) entry count in one array — "count entries, not array
 *  length", the same rule `draftValidation.ts`'s `countPrompts` applies to
 *  the per-pool launch minimum. `Array.prototype.filter` skips holes. */
function realCount(list: readonly unknown[]): number {
  return list.filter(() => true).length;
}

/** Real Prompt count across all three pools — the presentational total for
 *  a `daily_cards` draft, which can deal from any of them. */
export function squaresTotal(draft: EventDraft): number {
  return realCount(draft.prompts.main) + realCount(draft.prompts.easy) + realCount(draft.prompts.closing);
}

/**
 * The Day whose Theme the collapsed strip's swatch — and the expanded
 * preview's default selection — wears: the LAST Day (highest `index`) that
 * already carries a Theme, matching how Look (Step 4) fills Days in order
 * and the frame's own worked example ("Sunday preview" — the schedule's
 * final Day). `null` for a `one_card` draft, an empty schedule, or a
 * schedule with no Theme picked yet.
 */
export function previewDayForTheme(draft: EventDraft): DraftDayDef | null {
  const days = previewDays(draft);
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i]!.theme) return days[i]!;
  }
  return null;
}

/**
 * The Theme a Day-less part of the preview wears: the draft's own
 * `defaultTheme`, else the bound Edition's own default. This is the tail of
 * `previewTheme`'s chain WITHOUT the cross-Day lookup — the fallback for a
 * specific, already-known Day (or no Day at all), never a second "pick some
 * other Day's Theme instead" (Codex P2, PR #857 round 2: the expanded
 * sheet's own per-selected-Day fallback must resolve from the SELECTED Day
 * and the Event, not silently borrow another Day's Theme via `previewTheme`).
 */
export function draftFallbackTheme(draft: EventDraft): ThemeId {
  return draft.defaultTheme ?? defaultThemeForEdition(draft.edition);
}

/**
 * The Theme the preview island wears: the most-specified Day's Theme, else
 * the draft's own `defaultTheme`, else the bound Edition's own default —
 * mirroring the live app's own fallback chain (Day → event default →
 * Edition default), read here from the draft instead of a live Event doc.
 * For the COLLAPSED strip's single representative swatch only — a specific,
 * already-selected Day's own fallback is `draftFallbackTheme` above, not
 * this cross-Day lookup.
 */
export function previewTheme(draft: EventDraft): ThemeId {
  return previewDayForTheme(draft)?.theme ?? draftFallbackTheme(draft);
}

/** A short, human Day label ("Friday"), falling back to a 1-based ordinal
 *  when `date` will not parse — the SAME technique `DaySwitcher`'s own
 *  (unexported) `weekday` helper uses (anchor at UTC midnight, format in
 *  UTC), re-derived here for the same "not worth exporting across a
 *  component/data-module boundary for one extra caller" reason as
 *  `previewDays` above. The UTC anchor matters for more than consistency: an
 *  out-of-range calendar day would otherwise make the weekday — and whether
 *  a malformed date is even caught — shift with the machine running it. */
export function previewDayLabel(day: DraftDayDef): string {
  const parsed = new Date(`${day.date}T00:00:00Z`);
  // `2026-02-30` parses as a real, ROLLED-OVER `Date` (March 2nd) rather than
  // `Invalid Date` — the same ECMAScript quirk `draftValidation.ts`'s
  // `isIsoDate` guards against — so this must round-trip the parse back to
  // the SAME calendar string, not just check for `NaN`.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day.date) {
    return `Day ${day.index + 1}`;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(parsed);
  } catch {
    return `Day ${day.index + 1}`;
  }
}

/**
 * The collapsed strip's caption (specs/event-setup-wizard.md § "Live preview
 * strip"): generic until there is something to say, then a squares count
 * once a pack exists, then a per-Day Theme preview once a Day is fully
 * themed — `#frame-setup-basics` → `#frame-setup-squares` →
 * `#frame-setup-look`'s own progression. Read from draft DATA rather than
 * pinned to whichever step mounted the strip, so the caption upgrades the
 * moment the underlying data does, not only once the organizer reaches the
 * "matching" step (an organizer can fill Squares before Basics finishes, for
 * instance, and the caption should say so either way).
 */
export function previewCaption(draft: EventDraft): string {
  const themedDay = previewDayForTheme(draft);
  if (themedDay) {
    const meta = THEMES.find((t) => t.id === themedDay.theme);
    return `${previewDayLabel(themedDay)} preview · ${meta?.label ?? 'themed'}`;
  }
  // `one_card` deals from the main pool alone and has no "per day" cadence
  // at all (specs/event-setup-wizard.md § Contract — `cardFormat`) — a
  // one-card-specific line, counting only the pool it actually uses,
  // instead of `squaresTotal`'s cross-pool count and the daily-cards
  // "deals 24 per day" phrasing (Codex P2, PR #857 round 2): switching
  // OUT of a one-card occasion leaves `applyOccasionDefaults` preserving
  // whatever easy/closing Prompts were authored, so a raw total can name
  // squares the launched Board will never deal from.
  if (draft.cardFormat === 'one_card') {
    const mainCount = realCount(draft.prompts.main);
    if (mainCount > 0) return `${mainCount} squares · one card`;
    return 'Live preview · updates as you build';
  }
  const total = squaresTotal(draft);
  if (total > 0) return `${total} squares · deals 24 per day`;
  return 'Live preview · updates as you build';
}

function mainDealItems(list: readonly DraftMainPrompt[]): DealItem[] {
  return list
    .filter((p): p is DraftMainPrompt => p != null)
    .map((p, i) => ({ id: `main-${i}`, text: p.text, spicy: p.spicy, pool: 'main' }));
}

function curatedDealItems(list: readonly DraftCuratedPrompt[], poolId: 'easy' | 'closing'): DealItem[] {
  return list
    .filter((p): p is DraftCuratedPrompt => p != null)
    .map((p, i) => ({ id: `${poolId}-${i}`, text: p.text, spicy: false, pool: poolId }));
}

/**
 * The `DealItem[]` `dealBoard` deals from, for a deal from `pool`.
 *
 * `mixEasy` (true for any `daily_cards` MAIN deal — an actual main Day, OR a
 * `daily_cards` draft with no Days authored yet, which still previews as a
 * main deal per the spec) mirrors the live deal's own membership rule
 * (`src/data/api.ts` `dealDayCard`): a main deal mixes BOTH the main and
 * easy pools in, so `dealBoard` can stratify the easy half per
 * specs/easy-mix.md. A `one_card` draft's main deal (`mixEasy` false — see
 * `dealPreviewCard`'s `cardFormat` check) is deliberately NOT the same rule:
 * `joinAndDeal`'s one-card path pulls from the main pool ONLY, and
 * `assignedPools` agrees (`one_card` ⇒ `['main']`), so mixing easy items in
 * here would preview squares the launched Board never deals (Codex P2, PR
 * #857 round 2 — reachable because `applyOccasionDefaults` preserves an
 * authored easy pool across an occasion switch INTO one-card). `easy`/
 * `closing` always deal their own pool alone, regardless of `mixEasy`.
 */
function previewDealItems(draft: EventDraft, pool: PoolId, mixEasy: boolean): DealItem[] {
  if (pool === 'main') {
    const mainItems = mainDealItems(draft.prompts.main);
    return mixEasy ? [...mainItems, ...curatedDealItems(draft.prompts.easy, 'easy')] : mainItems;
  }
  return curatedDealItems(draft.prompts[pool], pool);
}

/** Either a dealt sample card, or the shortfall message that stood in its
 *  way — never both, and never a thrown error. */
export type PreviewDeal = { cells: Cell[] } | { shortfall: string };

/**
 * Deal the expanded preview's sample card for `day` — or, when `day` is
 * `null` (a `one_card` draft, or a `daily_cards` draft with no Days yet),
 * the draft's main pool. The REAL deal path (`dealBoard`), a fixed seed, and
 * the draft's own mix ratio and free-space text — exactly what the
 * acceptance criteria ask for. Those two `day === null` cases are NOT dealt
 * identically, though — a `one_card` draft's main-only deal never mixes in
 * the easy pool, exactly matching a `daily_cards` MAIN Day, but a
 * `daily_cards` draft with no Days *does*, because its eventual main Day
 * will (see `mixEasy` in `previewDealItems`, Codex P2, PR #857 round 3).
 *
 * `dealBoard` throws its own `MIN_POOL` guard message when the assigned
 * pool is too thin to deal (`src/game/logic.ts`). This catches THAT message
 * rather than re-deriving the guard's arithmetic, so the preview's shortfall
 * wording can never drift from the Squares gate it has to stay "consistent
 * with" (specs/event-setup-wizard.md acceptance) — EXCEPT for one case
 * `dealBoard` cannot see on its own: `assignedPoolIssues` requires the
 * ASSIGNED pool alone to clear `MIN_POOL`, "per pool, never as a total"
 * (specs/event-setup-wizard.md § Validation), but a main Day's easy-mix
 * backfill can make `dealBoard` itself succeed on a COMBINED main+easy pool
 * that is still short on main alone — a full-looking preview the Squares
 * gate would refuse (Codex P2, PR #857 round 2). That ASSIGNED-pool check
 * runs first, using the SAME `MIN_POOL` constant and message shape
 * `dealBoard` itself throws, so the wording stays identical either way.
 */
export function dealPreviewCard(draft: EventDraft, day: DraftDayDef | null): PreviewDeal {
  const pool = day ? normalizePool(day.pool) : 'main';
  // Easy mixing is a `cardFormat` question, NOT a "day is null" one — a
  // `daily_cards` draft with no Days authored yet (Custom, before Step 4)
  // is still going to deal a main-Day-shaped card once one exists, and the
  // spec says so explicitly (§ "Live preview strip"). Gating on `day !==
  // null` alone (round 2's one-card fix) wrongly swept up THIS case too,
  // since it is also `day === null` (Codex P2, PR #857 round 3). Only an
  // actual `one_card` draft — whose LAUNCHED deal is main-only, per
  // `joinAndDeal` and `assignedPools` — skips the mix.
  const mixEasy = draft.cardFormat !== 'one_card' && pool === 'main';
  const assignedList = pool === 'main' ? draft.prompts.main : draft.prompts[pool];
  const assignedCount = assignedList.filter(() => true).length;
  if (assignedCount < MIN_POOL) {
    return { shortfall: `dealBoard needs at least ${MIN_POOL} prompts, received ${assignedCount}.` };
  }
  const items = previewDealItems(draft, pool, mixEasy);
  const freeText = day?.freeText ?? FREE_TEXT;
  const opts: DealOptions = {
    stratify: pool === 'main',
    easyMixRatio: draft.settings.easyMixRatio,
  };
  try {
    const cells = dealBoard(items, freeText, PREVIEW_SEED, draft.settings.spicyRatio, opts);
    return { cells };
  } catch (err) {
    return { shortfall: err instanceof Error ? err.message : 'Not enough squares yet to deal a preview.' };
  }
}
