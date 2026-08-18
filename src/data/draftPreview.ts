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
 * same small, well-known rules — hole-dropping/index-sort, and "a main Day
 * mixes the easy pool in, everything else deals its own pool alone" — as
 * short, independently-testable functions, because a preview's job (show
 * something representative) and a validator's/live-deal's job (enforce a
 * gate / persist a real card) are different concerns that happen to want the
 * same small pieces of arithmetic.
 */

import type { Cell, DraftCuratedPrompt, DraftDayDef, DraftMainPrompt, EventDraft, ThemeId } from '../types';
import { dealBoard, type DealItem, type DealOptions } from '../game/logic';
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

/**
 * Real (non-hole) Prompt count across all three pools — "count entries, not
 * array length", the same rule `draftValidation.ts`'s `countPrompts` applies
 * to the per-pool launch minimum, restated here for a presentational total.
 */
export function squaresTotal(draft: EventDraft): number {
  const count = (list: readonly unknown[]) => list.filter(() => true).length;
  return count(draft.prompts.main) + count(draft.prompts.easy) + count(draft.prompts.closing);
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
 * The Theme the preview island wears: the most-specified Day's Theme, else
 * the draft's own `defaultTheme`, else the bound Edition's own default —
 * mirroring the live app's own fallback chain (Day → event default →
 * Edition default), read here from the draft instead of a live Event doc.
 */
export function previewTheme(draft: EventDraft): ThemeId {
  return previewDayForTheme(draft)?.theme ?? draft.defaultTheme ?? defaultThemeForEdition(draft.edition);
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
 * The `DealItem[]` `dealBoard` deals from, for a deal from `pool` — the same
 * membership rule the live deal (`src/data/api.ts` `dealDayCard`) uses: a
 * `main` deal mixes BOTH the main and easy pools (so `dealBoard` can
 * stratify the easy half in per specs/easy-mix.md); `easy` and `closing`
 * each deal from their own pool alone.
 */
function previewDealItems(draft: EventDraft, pool: PoolId): DealItem[] {
  if (pool === 'main') {
    return [...mainDealItems(draft.prompts.main), ...curatedDealItems(draft.prompts.easy, 'easy')];
  }
  return curatedDealItems(draft.prompts[pool], pool);
}

/** Either a dealt sample card, or the shortfall message that stood in its
 *  way — never both, and never a thrown error. */
export type PreviewDeal = { cells: Cell[] } | { shortfall: string };

/**
 * Deal the expanded preview's sample card for `day` — or, when `day` is
 * `null` (a `one_card` draft, or a `daily_cards` draft with no Days yet),
 * the draft's main pool, unstratified-mix rules identical to a main Day. The
 * REAL deal path (`dealBoard`), a fixed seed, and the draft's own mix ratio
 * and free-space text — exactly what the acceptance criteria ask for.
 *
 * `dealBoard` throws its own `MIN_POOL` guard message when the assigned
 * pool is too thin to deal (`src/game/logic.ts`). This catches THAT message
 * rather than re-deriving the guard's arithmetic, so the preview's shortfall
 * wording can never drift from the Squares gate it has to stay "consistent
 * with" (specs/event-setup-wizard.md acceptance).
 */
export function dealPreviewCard(draft: EventDraft, day: DraftDayDef | null): PreviewDeal {
  const pool = day ? normalizePool(day.pool) : 'main';
  const items = previewDealItems(draft, pool);
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
