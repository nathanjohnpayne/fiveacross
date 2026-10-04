/**
 * The draft transforms Step 4 · Look commits through `updateDraft` (#792 /
 * #1377, specs/event-setup-wizard.md § "Look (Step 4)").
 *
 * Pure and React-free, for the reason `draftSquares.ts` is: every rule here
 * has an edge the UI cannot demonstrate on its own (a DST gap, a Theme the
 * Edition does not offer, a cleared Free Space input) and each is worth a unit
 * test that renders nothing.
 *
 * Step 3 creates Days carrying only `index`, `pool` and `tutorial`; everything
 * else on a Day is authored here: `date`, `unlockAt`, `place`, `placeEmoji`,
 * `theme`, the two `tonight` slots and `freeText`. So are the Event's
 * `defaultTheme` and `settings.easyMixRatio`.
 *
 * THE SAME TWO RULES AS STEP 3.
 *
 * 1. Every successful transform returns through `normalizeDraft`, the one
 *    chokepoint that densifies `days` and all three prompt pools. It is
 *    imported, never restated: `save` re-parses the whole draft, so a Look
 *    edit on a draft with a hole anywhere must repair it or the edit vanishes
 *    on reload.
 * 2. Refusals and no-ops return the ORIGINAL draft by identity. Nothing was
 *    edited, and a refusal should not quietly rewrite the draft it refused.
 *
 * Days are addressed by POSITION in the stored array, exactly as
 * `draftSquares` does: two Days may share one date (Bodega's Sunday), so a
 * date is never an address.
 */

import type { DraftDayDef, EventDraft, ThemeId } from '../types';
import { normalizeDraft } from './draftSquares';
import { isEditionTheme, isIsoDate, isRepresentableInstant, isSupportedTimezone } from './draftValidation';
import { occasionById } from './occasions';
import { instantFromZonedTime, isWallClockTime, isoTimeInTz } from './tzDate';

/** The unlock time a Day gets when its occasion proposes none: the Bodega
 *  cadence (#792), not the old 08:00. */
export const FALLBACK_UNLOCK_TIME = '06:00';

/** The `HH:MM` a newly dated Day opens at: the occasion's `unlockTime`, else
 *  `FALLBACK_UNLOCK_TIME` (Custom, Wedding, or no occasion yet). */
export function defaultUnlockTime(draft: EventDraft): string {
  const proposed = occasionById(draft.occasion)?.defaults.schedule?.unlockTime;
  return typeof proposed === 'string' && isWallClockTime(proposed) ? proposed : FALLBACK_UNLOCK_TIME;
}

/**
 * The `HH:MM` a Day's unlock reads in the Event's zone, for the time input.
 *
 * A Day with no unlock yet, the `0` open sentinel (whose wall time means
 * nothing), or a zone the read-side contract refuses all read as
 * `defaultUnlockTime`: the time the Day WILL get once it is dated.
 */
export function dayUnlockTime(draft: EventDraft, day: DraftDayDef): string {
  if (
    day.unlockAt !== null &&
    day.unlockAt !== 0 &&
    isRepresentableInstant(day.unlockAt) &&
    isSupportedTimezone(draft.timezone)
  ) {
    const time = isoTimeInTz(day.unlockAt, draft.timezone);
    if (isWallClockTime(time)) return time;
  }
  return defaultUnlockTime(draft);
}

/**
 * Re-date a Day, keeping its own unlock time (or the default, for a Day not
 * yet timed) and recomputing `unlockAt` in the Event's zone, so `date` and
 * `unlockAt` can never name two different calendar days
 * (`day-unlock-date-mismatch`).
 *
 * Refuses a malformed date, including `''`: a blank date can carry no
 * instant, and the gate already reports a Day that was never dated.
 */
export function setDayDate(draft: EventDraft, position: number, date: string): EventDraft {
  const target = draft.days[position];
  if (!target) return draft;
  return scheduleDay(draft, target, date, dayUnlockTime(draft, target));
}

/**
 * Re-time a Day on its own date. Refuses a Day with no valid date yet:
 * there is no calendar day to put the time on, and inventing one would be
 * the "looked honoured, silently changed" class of failure #785 catalogues.
 *
 * A time the zone skips (spring forward) is stored as the instant just past
 * the gap, so `dayUnlockTime` then reads it back moved forward by the gap
 * (02:30 → 03:30). See `instantFromZonedTime` for the full DST rule.
 */
export function setDayUnlockTime(draft: EventDraft, position: number, time: string): EventDraft {
  const target = draft.days[position];
  if (!target) return draft;
  return scheduleDay(draft, target, target.date, time);
}

/** The one place a Day's `date` and `unlockAt` are written, together. Refuses
 *  an unusable zone outright rather than computing an instant
 *  `eventConverter` would re-read at another zone's wall clock. */
function scheduleDay(draft: EventDraft, target: DraftDayDef, date: string, time: string): EventDraft {
  if (!isIsoDate(date) || !isWallClockTime(time) || !isSupportedTimezone(draft.timezone)) return draft;
  const unlockAt = instantFromZonedTime(date, time, draft.timezone);
  if (unlockAt === null) return draft;
  if (target.date === date && target.unlockAt === unlockAt) return draft;
  return replaceDay(draft, target, { ...target, date, unlockAt });
}

/** Set a Day's place, stored as typed: trimming per keystroke would eat the
 *  space between two words. The gate judges the trimmed value. */
export function setDayPlace(draft: EventDraft, position: number, place: string): EventDraft {
  return editDay(draft, position, (day) => (day.place === place ? day : { ...day, place }));
}

export function setDayPlaceEmoji(draft: EventDraft, position: number, placeEmoji: string): EventDraft {
  return editDay(draft, position, (day) => (day.placeEmoji === placeEmoji ? day : { ...day, placeEmoji }));
}

/** Set a Day's Theme. Refuses anything outside `themesForEdition(draft.edition)`
 *  (`isEditionTheme`): there is deliberately no Custom option, and the
 *  registry is what the contrast suite audits. */
export function setDayTheme(draft: EventDraft, position: number, theme: ThemeId): EventDraft {
  if (!isEditionTheme(theme, draft.edition)) return draft;
  return editDay(draft, position, (day) => (day.theme === theme ? day : { ...day, theme }));
}

/**
 * Set one of a Day's two `tonight` slots.
 *
 * The result ALWAYS holds exactly two entries: missing slots read as `''` and
 * anything past the second is dropped. Consumers join the pair or assume
 * `length === 2`, so the array length is part of the contract
 * (`day-tonight-not-two`), not just the non-blank count. Text is stored as
 * typed, for the same reason as `setDayPlace`.
 */
export function setDayTonight(draft: EventDraft, position: number, slot: 0 | 1, text: string): EventDraft {
  if (slot !== 0 && slot !== 1) return draft;
  return editDay(draft, position, (day) => {
    const pair = [day.tonight[0] ?? '', day.tonight[1] ?? ''];
    pair[slot] = text;
    const unchanged = day.tonight.length === 2 && day.tonight[0] === pair[0] && day.tonight[1] === pair[1];
    return unchanged ? day : { ...day, tonight: pair };
  });
}

/**
 * Set or clear a Day's Free Space override.
 *
 * A blank input CLEARS the override: the key is removed, never stored as
 * `''`. Both the deal path and the locked-card preview read
 * `day.freeText ?? FREE_TEXT`, so a present empty string suppresses the
 * fallback and deals a blank centre Square (the #791 hand-off).
 */
export function setDayFreeText(draft: EventDraft, position: number, text: string): EventDraft {
  return editDay(draft, position, (day) => {
    if (text.trim() === '') {
      if (!Object.prototype.hasOwnProperty.call(day, 'freeText')) return day;
      const { freeText: _cleared, ...rest } = day;
      return rest;
    }
    return day.freeText === text ? day : { ...day, freeText: text };
  });
}

/** Set the Event's `defaultTheme`, which dresses Auto when no Day is current.
 *  Independent of every Day's Theme, and held to the same Edition list. */
export function setDefaultTheme(draft: EventDraft, theme: ThemeId): EventDraft {
  if (!isEditionTheme(theme, draft.edition) || draft.defaultTheme === theme) return draft;
  return normalizeDraft({ ...draft, defaultTheme: theme });
}

/**
 * The Theme the occasion proposes for the Day at schedule position
 * `position`: its `dayThemes` in order, with the LAST entry repeated for any
 * Day past the end of the list (a four-Day weekend on three Edition Themes;
 * Bodega's two Sunday Days share one). `null` when the occasion proposes no
 * Themes, or proposes one the draft's Edition no longer offers.
 */
export function proposedDayTheme(draft: EventDraft, position: number): ThemeId | null {
  const themes = occasionById(draft.occasion)?.defaults.dayThemes ?? [];
  if (themes.length === 0 || !Number.isInteger(position) || position < 0) return null;
  const theme = themes[Math.min(position, themes.length - 1)];
  return isEditionTheme(theme, draft.edition) ? theme : null;
}

/**
 * Fill every UNTHEMED Day with `proposedDayTheme`. A Day that already carries
 * a Theme, even an off-Edition one, is left alone: overwriting an organizer's
 * choice is never a proposal, and an off-Edition Theme is its own reported
 * issue (`day-off-edition-theme`) for the organizer to resolve.
 *
 * Positions are counted over the Days that exist, in stored order, which is
 * the `index` each one has after `normalizeDraft`.
 */
export function applyProposedDayThemes(draft: EventDraft): EventDraft {
  let changed = false;
  const days = draft.days
    .filter((day) => day !== null && day !== undefined)
    .map((day, position) => {
      if (day.theme !== null) return day;
      const theme = proposedDayTheme(draft, position);
      if (theme === null) return day;
      changed = true;
      return { ...day, theme };
    });
  return changed ? normalizeDraft({ ...draft, days }) : draft;
}

/**
 * Set `settings.easyMixRatio`, the share of a main Day's card dealt from the
 * easy pool. Refuses anything outside 0–1: `dealBoard` clamps rather than
 * honours it, and `parseEventDraft` refuses it, so storing one would make
 * every later edit fail to persist.
 */
export function setEasyMixRatio(draft: EventDraft, ratio: number): EventDraft {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return draft;
  if (draft.settings.easyMixRatio === ratio) return draft;
  return normalizeDraft({ ...draft, settings: { ...draft.settings, easyMixRatio: ratio } });
}

/** Apply `edit` to the Day at `position`; the draft by identity when there is
 *  no such Day or the edit returns the Day unchanged. */
function editDay(draft: EventDraft, position: number, edit: (day: DraftDayDef) => DraftDayDef): EventDraft {
  const target = draft.days[position];
  if (!target) return draft;
  const next = edit(target);
  return next === target ? draft : replaceDay(draft, target, next);
}

/** Swap one Day object for another and return through the chokepoint, which
 *  drops holes and renumbers `index`. Matched by identity, as `draftSquares`
 *  does, because holes before `position` shift it once compacted. */
function replaceDay(draft: EventDraft, target: DraftDayDef, next: DraftDayDef): EventDraft {
  return normalizeDraft({ ...draft, days: draft.days.map((day) => (day === target ? next : day)) });
}
