/**
 * The shared setup-wizard validation predicates
 * (specs/event-setup-wizard.md § Validation).
 *
 * Pure functions over an `EventDraft`, importable by Steps 3–5 (#791, #792,
 * #794) and by the launch provisioner (#793) so the live gauge on Step 3, the
 * checklist row on Step 5 and the server's final refusal all agree by
 * construction instead of by three careful re-implementations.
 *
 * Every rule here is a fact the code already enforces somewhere the organizer
 * cannot see until it is too late — `dealBoard`'s `MIN_POOL` throw, the
 * `daysThemeLockOk` index unroll in `firestore.rules`, `finaleTimes` returning
 * null, `activeSnapshotIds` excluding Prompts newer than a Day's cutoff. The
 * job of this module is to move those failures forward to a moment when they
 * are still editable.
 *
 * No Firebase, no React, no clock of its own: `now` is always passed in.
 */

import type { DraftDayDef, EventDraft, ThemeId } from '../types';
import { MIN_POOL } from '../game/logic';
import { normalizePool, type PoolId } from '../game/pool';
import { THEMES, themesForEdition } from '../theme/themes';
// `normalizeTimezone` is the SAME contract `eventConverter` applies on read, so
// importing it is what makes "the zone you typed is the zone you get" checkable
// instead of hopeful. It costs no Firebase dependency: `converters.ts` imports
// firebase as `import type` only, which erases at build.
import { normalizeTimezone } from './converters';
import { occasionById } from './occasions';
import { validateSlug } from '../slug';
// The SAME bound `parseEventDraft` enforces on the stored blob, so the
// in-memory gate and the persistence gate cannot drift apart.
import { MAX_PROMPT_TEXT } from './eventDraft';
// The SAME conversion the Day header uses, so "which calendar day is this
// instant on" has one answer across the gate and its consumers.
import { isoDateInTz } from './tzDate';

/**
 * The ten-Day ceiling. `daysThemeLockOk` (`firestore.rules`) unrolls its
 * schedule lock over indexes 0–9 ONLY, so an eleventh Day sits outside the
 * lock and stays editable after it has unlocked. A rules fact, not a
 * preference (#785).
 */
export const MAX_DAYS = 10;

export type DraftIssueCode =
  | 'pool-below-minimum'
  | 'no-closing-day'
  | 'first-unlock-missing'
  | 'first-unlock-sentinel'
  | 'first-unlock-past'
  | 'too-many-days'
  | 'no-days'
  | 'day-index-out-of-order'
  | 'day-missing-place'
  | 'day-missing-theme'
  | 'day-unregistered-theme'
  | 'day-missing-unlock'
  | 'day-missing-date'
  | 'day-invalid-date'
  | 'day-unlock-date-mismatch'
  | 'day-blank-free-text'
  | 'day-outside-event-window'
  | 'main-prompt-spicy-not-boolean'
  | 'extra-closing-day'
  | 'day-tonight-not-two'
  | 'day-off-edition-theme'
  | 'one-card-has-days'
  | 'event-missing-field'
  | 'event-unregistered-theme'
  | 'event-off-edition-theme'
  | 'event-unsupported-timezone'
  | 'event-invalid-date-window'
  | 'event-occasion-edition-mismatch'
  | 'event-invalid-slug'
  /** The address is present and well-formed but has not been CONFIRMED
   *  available for this draft's current Edition (#911). */
  | 'event-slug-unverified'
  | 'setting-out-of-range'
  | 'curated-prompt-is-spicy'
  | 'prompt-text-out-of-bounds';

/** One reason a draft cannot launch. `dayIndex`/`pool` anchor the issue to the
 *  control that fixes it, so a checklist row can deep-link to its own Edit. */
export interface DraftIssue {
  code: DraftIssueCode;
  message: string;
  dayIndex?: number;
  pool?: PoolId;
  field?: string;
}

const REGISTERED_THEME_IDS: ReadonlySet<string> = new Set(THEMES.map((t) => t.id));

/** Whether a Theme is backed by `THEMES` metadata (and therefore by a
 *  `themes.css` token block). There is no custom-theme value in the contract,
 *  so an unregistered id is not a styling miss — it is an unrenderable Day. */
export function isRegisteredTheme(theme: ThemeId | null | undefined): boolean {
  return typeof theme === 'string' && REGISTERED_THEME_IDS.has(theme);
}

/**
 * Whether a Theme is one the draft's Edition actually offers.
 *
 * A stricter question than `isRegisteredTheme`, and a separate failure:
 * `#frame-setup-look` picks Themes from "the Edition's registered Theme list",
 * and re-picking an occasion rebinds the Edition under Days that were themed
 * before it. An off-Edition Theme still renders — `THEMES` lookups and the
 * `themes.css` blocks are global — so this is reported as its own issue the
 * organizer can resolve in Step 4, never silently reset over their choice.
 */
export function isEditionTheme(theme: ThemeId | null | undefined, edition: string): boolean {
  if (typeof theme !== 'string') return false;
  return themesForEdition(edition).some((t) => t.id === theme);
}

/**
 * Whether the zone survives the contract `eventConverter` applies on read.
 *
 * `normalizeTimezone` rejects UTC/GMT/`Etc/*`, bare offsets and anything
 * without a region prefix, substituting `Europe/Rome` — so a draft that merely
 * checks "non-blank" can launch a schedule authored in UTC and have every
 * unlock instant, email time and finale beat re-interpreted at Rome wall-clock.
 * The device zone `createEventDraft` suggests is exactly where an unsupported
 * value comes from: plenty of runtimes report `UTC`.
 */
export function isSupportedTimezone(timezone: string): boolean {
  // The STORED value must itself be canonical — deliberately not trimmed first.
  // A padded value like ' America/Los_Angeles ' would pass a trimming check
  // while every consumer receives the padding: `Intl.DateTimeFormat` rejects
  // it, so `isoDateInTz` silently falls back to the DEVICE zone, which near a
  // date boundary can make a Day's unlock appear to match its date even though
  // the read-side normalization puts it on another day (#787 review).
  if (timezone.length === 0) return false;
  if (normalizeTimezone(timezone) !== timezone) return false;
  // Surviving `normalizeTimezone` proves only that the CONVERTER preserves the
  // string — it is a shape rule (region prefix, not UTC/Etc/an offset), not a
  // registry lookup. A region-shaped but nonexistent zone like
  // `America/Not_A_Zone` passes it, and then every consumer falls back to the
  // device zone, which can make the Day-date check agree by accident and
  // persist an Event whose whole schedule is interpreted in the wrong zone. So
  // the runtime must also RECOGNISE it (#787 Phase 4b review).
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The widest instant a JavaScript `Date` can represent: ±100,000,000 days from
 * the epoch (ECMA-262). Beyond it `new Date(v)` is an Invalid Date and every
 * formatter — including `Intl.DateTimeFormat.format` — THROWS a RangeError
 * rather than returning a fallback string.
 */
const MAX_TIME_VALUE = 8.64e15;

/** A number that can actually become a `Date`. `Number.isFinite` alone is not
 *  enough: `Number.MAX_VALUE` is finite and still unformattable. */
export function isRepresentableInstant(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_TIME_VALUE;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real ISO calendar date — `2026-02-30` parses as March 2nd in a `Date`, so
 *  the round-trip is what proves the day actually exists. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The Days that actually EXIST, in index order.
 *
 * Holes are dropped rather than dereferenced. A sparse `days` array is
 * reachable in memory (`new Array(n)`, a partially built schedule), and
 * spreading one yields `undefined` entries that would throw in the sort
 * comparator or on any field access — crashing the Step 5 checklist and the
 * provisioner gate before `dayCompletenessIssues` could report the gap.
 *
 * Every predicate that READS Days goes through here; the gap itself is
 * reported once, by `dayCompletenessIssues`, which walks by index (#787
 * Phase 4b review).
 */
function daysInOrder(draft: EventDraft): DraftDayDef[] {
  return draft.days.filter((day) => day !== null && day !== undefined).sort((a, b) => a.index - b.index);
}

/**
 * The pools this draft actually deals from.
 *
 * A `daily_cards` Event deals each Day from its own pool, so the assigned set
 * is the Days' pools. A `one_card` Event has no Days and deals its single
 * Board from the main pool.
 *
 * The Easy Mix is deliberately NOT counted as an assignment: on a main Day it
 * blends easy-pool Squares in, but a short easy pool backfills from tame main
 * (specs/easy-mix.md), so a thin easy pool there is a degraded card, not an
 * undealable one — and this gate exists for undealable.
 */
export function assignedPools(draft: EventDraft): PoolId[] {
  if (draft.cardFormat === 'one_card') return ['main'];
  const seen = new Set<PoolId>();
  // `daysInOrder` rather than `draft.days`: a hole yields `undefined` and
  // `day.pool` would THROW here — and this predicate runs BEFORE the one that
  // reports the gap, so a sparse schedule crashed the whole gate.
  for (const day of daysInOrder(draft)) seen.add(normalizePool(day.pool));
  return [...seen];
}

const POOL_LABEL: Record<PoolId, string> = {
  main: 'main',
  easy: 'easy',
  closing: 'closing',
};

/**
 * Prompt entries that actually EXIST — neither a hole nor an explicit
 * `null`/`undefined` — so this is what a pool really holds rather than its
 * `length`.
 *
 * `filter` alone drops holes but KEEPS an explicit `null`, and the two are the
 * same missing Prompt to every other reader: `promptTextIssues` reports both
 * as a gap, and Step 3 renders both as a removable "missing" row. Counting an
 * explicit `null` therefore let a 24-slot pool holding 23 usable Prompts read
 * `24 · ✓` beside a visible gap — the "looks satisfied, is not" reporting
 * #785 catalogues, arriving through the one path meant to prevent it (Codex
 * P2, PR #856, round 2). An explicit `null` only reaches memory through an
 * untyped path — `parseEventDraft` refuses a stored one — which is exactly the
 * case this gate exists to catch.
 *
 * EXPORTED (#791) so Step 3's live per-pool counter renders the same number
 * this gate judges. One function, one answer.
 */
export function countPrompts(prompts: readonly unknown[]): number {
  return prompts.filter((prompt) => prompt !== null && prompt !== undefined).length;
}

/**
 * Every ASSIGNED pool independently holds at least `MIN_POOL` (24) Prompts.
 *
 * The 24-Prompt minimum is per assigned pool, NEVER per Event (#785). A
 * closing Day snapshots only its closing pool and `dealBoard` rejects an
 * unstratified pool below `MIN_POOL`, so a pack with 62 Prompts of which 4 are
 * closing yields an undealable farewell card while every total-based check
 * reports success.
 *
 * The count is of authored Prompts alone. The Free Space is not in any pool —
 * it is `freeSpaceText` plus per-Day overrides — so this is already the
 * non-free count `MIN_POOL` means.
 */
export function assignedPoolIssues(draft: EventDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  for (const pool of assignedPools(draft)) {
    // REAL entries, not the array's nominal length. A sparse array of length 24
    // satisfies a length check while holding fewer than 24 Prompt objects —
    // and `every`/`forEach` both SKIP holes, so neither the parser nor
    // `promptTextIssues` would notice. A save/load then turns each hole into
    // `null` and the same draft stops being readable at all (#787 review).
    const count = countPrompts(draft.prompts[pool]);
    if (count < MIN_POOL) {
      issues.push({
        code: 'pool-below-minimum',
        pool,
        message: `The ${POOL_LABEL[pool]} pool has ${count} Prompts; a Day that deals from it needs at least ${MIN_POOL}.`,
      });
    }
  }
  return issues;
}

/**
 * A `daily_cards` draft's FINAL Day carries the closing pool.
 *
 * `finaleTimes` returns null when no Day is assigned the closing pool: no
 * standings freeze, no podium, no Most-Loved Photo. The finale is not an
 * automatic consequence of the schedule ending — it is a pool assignment.
 * Inert for `one_card`, which has no finale to run.
 */
export function finaleClosingPoolIssues(draft: EventDraft): DraftIssue[] {
  if (draft.cardFormat === 'one_card') return [];
  const ordered = daysInOrder(draft);
  const finalDay = ordered[ordered.length - 1];
  if (!finalDay) return [];
  const issues: DraftIssue[] = [];
  if (normalizePool(finalDay.pool) !== 'closing') {
    issues.push({
      code: 'no-closing-day',
      dayIndex: finalDay.index,
      message: `Day ${finalDay.index + 1} is the final Day but deals from the ${POOL_LABEL[normalizePool(finalDay.pool)]} pool; assign it the closing pool or the finale never runs.`,
    });
  }
  // The final Day carrying the closing pool is necessary but NOT sufficient:
  // every finale consumer resolves the farewell by `days.find(closing)` — the
  // FIRST match, not the last (`finaleTimes`, `farewellDayIndex` on both the
  // client and the server). So an earlier closing Day silently becomes the
  // finale: it freezes standings, posts the podium and excludes its own scores
  // days before the intended one, while this predicate's final-Day check still
  // passes (#787 review).
  // Every closing Day that is NOT the final one, identified by its own index
  // rather than by position in the filtered list. `slice(0, -1)` was wrong:
  // when the final Day is not closing, the LAST closing Day is still not the
  // final Day, and exempting it meant Step 5 first reported only "the final Day
  // needs the closing pool" and then, once the organizer fixed that, surfaced a
  // brand-new failure. Independent launch failures are reported together.
  for (const day of ordered) {
    if (day.index !== finalDay.index && normalizePool(day.pool) === 'closing') {
      issues.push({
        code: 'extra-closing-day',
        dayIndex: day.index,
        message: `Day ${day.index + 1} also deals from the closing pool, and the finale resolves to the FIRST closing Day — it would freeze standings and post the podium before Day ${finalDay.index + 1}. Only the final Day may use the closing pool.`,
      });
    }
  }
  return issues;
}

/**
 * The FIRST Day's unlock is still ahead.
 *
 * Prompts seeded at creation carry `createdAt`, and `activeSnapshotIds`
 * excludes Prompts newer than a Day's cutoff — so creating an Event after Day
 * 1's unlock has passed permanently stamps an EMPTY arrival snapshot (#785).
 *
 * The `0` open sentinel is reported separately rather than lumped in with a
 * past instant: the Bodega seed uses it legitimately, but only alongside a
 * pre-stamped snapshot written atomically by the Admin SDK. No client can do
 * that, so from the wizard the sentinel is a provisioner capability request,
 * not an organizer mistake — and the message says which.
 */
export function firstUnlockIssues(draft: EventDraft, now: number): DraftIssue[] {
  if (draft.cardFormat === 'one_card') return [];
  // Specifically the Day whose INDEX IS 0, found directly — NOT
  // `daysInOrder(draft)[0]`. `daysInOrder` sorts ascending, so on a malformed
  // schedule carrying a negative index alongside a real Day 0 (e.g. indexes
  // `-1` and `0`), position `[0]` in that sorted array is the Day at index
  // `-1`, not Day 0 — `[0].index !== 0` would then report NO first-unlock
  // issue even though Day 0 exists and needs one (CodeRabbit, #833 review).
  // A schedule missing Day 0 entirely is already its own failure —
  // `dayCompletenessIssues` reports the gap as `day-index-out-of-order` — and
  // treating a later Day as "first" here would double-misreport it: the
  // hardcoded "Day 1" message would actually describe Day 2 or later, AND
  // `validateEventDraft`'s dedup would suppress that Day's own generic
  // `day-missing-unlock` / `day-unlock-date-mismatch` diagnostic because it
  // believes the specific row already covers it (#816).
  const first = daysInOrder(draft).find((day) => day.index === 0);
  if (!first) return [];
  if (first.unlockAt === null) {
    return [
      {
        code: 'first-unlock-missing',
        dayIndex: first.index,
        message: 'Day 1 has no unlock time yet.',
      },
    ];
  }
  if (first.unlockAt === 0) {
    return [
      {
        code: 'first-unlock-sentinel',
        dayIndex: first.index,
        message:
          'Day 1 uses the open-immediately sentinel, which needs a pre-stamped snapshot the wizard cannot write. Give Day 1 a future unlock time.',
      },
    ];
  }
  if (first.unlockAt <= now) {
    return [
      {
        code: 'first-unlock-past',
        dayIndex: first.index,
        message:
          "Day 1's unlock has already passed; launching now would stamp an empty first-Day snapshot. Move it into the future.",
      },
    ];
  }
  return [];
}

/**
 * The schedule has between one and `MAX_DAYS` Days, and a `one_card` draft has
 * none at all.
 */
export function dayCountIssues(draft: EventDraft): DraftIssue[] {
  if (draft.cardFormat === 'one_card') {
    if (draft.days.length === 0) return [];
    return [
      {
        code: 'one-card-has-days',
        message: 'A one-card Event has no Day schedule, but this draft carries Days.',
      },
    ];
  }
  if (draft.days.length === 0) {
    return [{ code: 'no-days', message: 'A daily-cards Event needs at least one Day.' }];
  }
  if (draft.days.length > MAX_DAYS) {
    return [
      {
        code: 'too-many-days',
        message: `An Event can have at most ${MAX_DAYS} Days; this schedule has ${draft.days.length}. The Firestore schedule lock only covers Day indexes 0–${MAX_DAYS - 1}.`,
      },
    ];
  }
  return [];
}

/**
 * Every Day carries the fields a launched `DayDef` requires.
 *
 * `place`, `placeEmoji` and EXACTLY TWO `tonight` entries render on the card,
 * the locked tease, the schedule, the leaderboard and the share copy — and of
 * the three, only `tonight` has an Admin editor after creation, so a Day that
 * launches without a `place` has no repair path (#785).
 *
 * `tutorial` and `pool` are not checked: the type makes both total, and both
 * are meaningful in every combination. That independence is the point — a
 * curated-pool Day whose wins count is Bodega's Friday, not a mistake.
 */
export function dayCompletenessIssues(draft: EventDraft): DraftIssue[] {
  if (draft.cardFormat === 'one_card') return [];
  const issues: DraftIssue[] = [];
  // The RAW stored array, deliberately NOT sorted. Sorting first would accept a
  // shuffled schedule whose indexes are individually perfect, and the stored
  // order is what ships: `Board`, `eventPreview` and `DaySwitcher` all select
  // `days[i]` BY ARRAY POSITION, so a launched Event would deal and reshuffle
  // using another Day's unlock and snapshot. Requiring `days[position].index
  // === position` collapses contiguity, uniqueness and stored order into the
  // one property every consumer actually relies on (#787 review).
  // An INDEX walk, not `forEach`: `forEach` skips holes, so a sparse schedule
  // would slip past the position check entirely.
  for (let position = 0; position < draft.days.length; position++) {
    const day: DraftDayDef | undefined = draft.days[position];
    if (day === null || day === undefined) {
      issues.push({
        code: 'day-index-out-of-order',
        message: `The schedule has a gap at position ${position + 1}; Days must be contiguous from 0.`,
      });
      continue;
    }
    if (day.index !== position) {
      issues.push({
        code: 'day-index-out-of-order',
        dayIndex: day.index,
        message: `Day indexes must be contiguous from 0 AND stored in that order; found index ${day.index} in position ${position}. Consumers read days[i] by position, so a reordered array deals the wrong Day.`,
      });
    }
    if (!day.date.trim()) {
      issues.push({
        code: 'day-missing-date',
        dayIndex: day.index,
        message: `Day ${day.index + 1} has no date.`,
      });
    } else if (!isIsoDate(day.date)) {
      // Presence is not enough, for the same reason the Event window is
      // date-checked: a resumed or imported Day carrying `2026-02-30` or
      // `not-a-date` renders `Invalid Date` in `DaySwitcher.weekday`, and
      // `coerceEventPreview` rejects the malformed entry and drops the ENTIRE
      // pre-auth schedule preview — one bad Day silently costing the whole
      // schedule its shopfront.
      issues.push({
        code: 'day-invalid-date',
        dayIndex: day.index,
        message: `Day ${day.index + 1} has a date that is not a real calendar date in YYYY-MM-DD form.`,
      });
    }
    if (!day.place.trim() || !day.placeEmoji.trim()) {
      issues.push({
        code: 'day-missing-place',
        dayIndex: day.index,
        message: `Day ${day.index + 1} needs a place and its emoji; neither can be edited after launch.`,
      });
    }
    if (day.theme === null) {
      issues.push({
        code: 'day-missing-theme',
        dayIndex: day.index,
        message: `Day ${day.index + 1} has no Theme.`,
      });
    } else if (!isRegisteredTheme(day.theme)) {
      issues.push({
        code: 'day-unregistered-theme',
        dayIndex: day.index,
        message: `Day ${day.index + 1} uses an unregistered Theme; only Themes in the registry can be rendered.`,
      });
    } else if (!isEditionTheme(day.theme, draft.edition)) {
      issues.push({
        code: 'day-off-edition-theme',
        dayIndex: day.index,
        message: `Day ${day.index + 1} uses a Theme this Event's Edition does not offer; pick one from its list.`,
      });
    }
    if (day.unlockAt === null || !isRepresentableInstant(day.unlockAt)) {
      issues.push({
        code: 'day-missing-unlock',
        dayIndex: day.index,
        // A NaN or Infinity reaches here from schedule arithmetic over a
        // malformed date, and would otherwise pass a bare `!== null` check and
        // launch a Day that never unlocks. Finite is not enough either: a value
        // like Number.MAX_VALUE is finite but outside the representable `Date`
        // range, and formatting it THROWS — so an unguarded value would crash
        // the launch checklist instead of reporting an issue (#787 review).
        message: `Day ${day.index + 1} has no usable unlock time.`,
      });
    } else if (isIsoDate(day.date) && isSupportedTimezone(draft.timezone)) {
      // The instant and the label must name the SAME calendar day. The
      // scheduler and the board lock read `unlockAt`, while daily-email
      // ownership and every piece of schedule copy read `date` — so a Day
      // edited on one side only unlocks its card on one day and is announced,
      // labelled and emailed as another. Converted through the Event's own
      // zone via the same `isoDateInTz` the Day header uses, so the gate and
      // the consumer cannot disagree (#787 review). Only checked once both
      // inputs are themselves valid, so one bad date yields one issue.
      const unlockDate = isoDateInTz(day.unlockAt, draft.timezone);
      if (unlockDate !== day.date) {
        issues.push({
          code: 'day-unlock-date-mismatch',
          dayIndex: day.index,
          message: `Day ${day.index + 1} is dated ${day.date} but its unlock time falls on ${unlockDate} in ${draft.timezone}; the card would unlock on one day and be labelled and emailed as another.`,
        });
      }
    }
    if (
      isIsoDate(day.date) &&
      isIsoDate(draft.startsOn) &&
      isIsoDate(draft.endsOn) &&
      // ORDERED, not just individually valid. `eventCompletenessIssues`
      // already reports a reversed window as its own `event-invalid-date-window`
      // issue; comparing a Day's date against a window that is backwards is
      // not a second, independent repair — every Day would additionally fail
      // `day-outside-event-window` for the one mistake the event-level issue
      // already names, burying the checklist under an issue-per-Day pile that
      // clears the instant `startsOn`/`endsOn` are fixed (#815).
      draft.startsOn <= draft.endsOn &&
      (day.date < draft.startsOn || day.date > draft.endsOn)
    ) {
      // Both dates can be individually valid and still contradict each other:
      // editing `startsOn`/`endsOn` after authoring the schedule strands Days
      // outside the window. `More` then advertises the Event-level range while
      // the schedule and daily-email behaviour follow the out-of-window
      // `day.date` — the same record disagreeing with itself (#787 review).
      // ISO dates compare lexicographically, so no parsing is needed.
      issues.push({
        code: 'day-outside-event-window',
        dayIndex: day.index,
        message: `Day ${day.index + 1} is dated ${day.date}, outside the Event window ${draft.startsOn} to ${draft.endsOn}. Move the Day or widen the window.`,
      });
    }
    if (typeof day.freeText === 'string' && day.freeText.trim().length === 0) {
      // The in-memory half of the same rule the parser enforces on a stored
      // blob: the wizard clearing a Free Space input must produce `undefined`,
      // not `''`. `dealBoard` and the locked-card preview both read
      // `day.freeText ?? FREE_TEXT`, so a present blank suppresses the fallback
      // and the Day deals an EMPTY centre Square (#787 review).
      issues.push({
        code: 'day-blank-free-text',
        dayIndex: day.index,
        message: `Day ${day.index + 1} carries a blank Free Space override, which replaces the default with an empty centre Square. Clear it entirely to use the default.`,
      });
    }
    // The ARRAY length is what matters, not the non-blank count: `tonight` is
    // persisted verbatim and consumers join it or assume `length === 2`, so a
    // trailing blank entry would render a dangling separator on a Day this
    // validator had called complete.
    const filled = day.tonight.filter((entry) => entry.trim().length > 0);
    if (day.tonight.length !== 2 || filled.length !== 2) {
      issues.push({
        code: 'day-tonight-not-two',
        dayIndex: day.index,
        message: `Day ${day.index + 1} needs exactly two non-blank Tonight entries; it has ${day.tonight.length}.`,
      });
    }
  }
  return issues;
}

/** The Event-level fields a launched `EventDoc` requires. The address check
 *  delegates to `src/slug.ts`, the same contract the edge Worker applies
 *  before a hostname reaches Firestore. The wizard's shared launch gate is
 *  therefore not allowed to create an Event that the router will reject. */
export function eventCompletenessIssues(draft: EventDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const required: [keyof EventDraft, string][] = [
    ['name', 'an Event name'],
    ['startsOn', 'a start date'],
    ['endsOn', 'an end date'],
    ['timezone', 'a timezone'],
    ['slugCandidate', 'an address'],
  ];
  for (const [field, label] of required) {
    if (!String(draft[field] ?? '').trim()) {
      issues.push({
        code: 'event-missing-field',
        field: String(field),
        message: `This Event still needs ${label}.`,
      });
    }
  }
  // A blank address has already received the clearer missing-field error
  // above. Once it is present, validate the stored bytes strictly: the Basics
  // form is the typing surface that calls `normalizeSlug`, whereas accepting a
  // different spelling here would let a resumed/imported draft claim an
  // address the edge refuses. `validateSlug` is the sole list/grammar owner.
  if (draft.slugCandidate.trim() !== '') {
    // The address must be CONFIRMED available for the Edition this draft is
    // currently on, not merely present (Phase 4b P1, PR #911). Presence alone
    // was doing two jobs — recording the organizer's choice and standing in
    // for "claimable" — and they come apart twice: a resumed step paints an
    // already-committed candidate available before any read, so an organizer
    // advancing inside the debounce carried something unverified; and an
    // Edition change alters which hostnames a launch claims, so a candidate
    // confirmed under one Edition says nothing about another. This gate is
    // pure and synchronous and cannot await a read, so the component records
    // the verification and the gate consumes it.
    if (draft.slugVerifiedForEdition !== draft.edition) {
      issues.push({
        code: 'event-slug-unverified',
        field: 'slugCandidate',
        message: `"${draft.slugCandidate}" has not been confirmed available yet. Open Basics and wait for the address check to finish.`,
      });
    }
    const slug = validateSlug(draft.slugCandidate);
    if (!slug.ok) {
      issues.push({
        code: 'event-invalid-slug',
        field: 'slugCandidate',
        message: `"${draft.slugCandidate}" cannot be used as an Event address (${slug.reason}). Choose a lowercase DNS-safe address that is not reserved.`,
      });
    }
  }
  const occasion = occasionById(draft.occasion);
  if (occasion === null) {
    issues.push({
      code: 'event-missing-field',
      field: 'occasion',
      message: 'This Event still needs an occasion — it is what binds the Edition your players see.',
    });
  } else if (occasion.edition !== draft.edition) {
    // The occasion is what BINDS the Edition, so the two agreeing is the whole
    // content of that claim. A resumed or imported draft can carry a
    // recognized occasion beside a stale `edition` — re-picking an occasion
    // rebinds it, and a half-applied rebind leaves the pair disagreeing. Such
    // a draft still passes the Theme checks by using the stale Edition's
    // Themes, so nothing else here would catch it, and it would launch with a
    // player-facing identity the organizer never chose (#785).
    issues.push({
      code: 'event-occasion-edition-mismatch',
      field: 'edition',
      message: `This Event's occasion (${occasion.label}) plays as the ${occasion.edition} Edition, but the draft carries ${draft.edition}. Re-pick the occasion to rebind the Edition.`,
    });
  }
  // Presence is not enough for either of these: both have a downstream contract
  // that silently rewrites a value this validator would otherwise call done.
  if (draft.timezone.trim() && !isSupportedTimezone(draft.timezone)) {
    issues.push({
      code: 'event-unsupported-timezone',
      field: 'timezone',
      message: `"${draft.timezone}" is not a named IANA zone the app can schedule in; it would be read back as a different zone. Pick a region zone such as America/Los_Angeles.`,
    });
  }
  if (draft.startsOn.trim() && draft.endsOn.trim()) {
    if (!isIsoDate(draft.startsOn) || !isIsoDate(draft.endsOn)) {
      issues.push({
        code: 'event-invalid-date-window',
        field: 'startsOn',
        message: 'The Event dates must be real calendar dates in YYYY-MM-DD form.',
      });
    } else if (draft.startsOn > draft.endsOn) {
      issues.push({
        code: 'event-invalid-date-window',
        field: 'endsOn',
        message: 'The Event ends before it starts.',
      });
    }
  }
  if (draft.defaultTheme === null) {
    issues.push({
      code: 'event-missing-field',
      field: 'defaultTheme',
      message:
        'This Event still needs a default Theme — it is what a new player sees when no Day is current.',
    });
  } else if (!isRegisteredTheme(draft.defaultTheme)) {
    issues.push({
      code: 'event-unregistered-theme',
      field: 'defaultTheme',
      message: 'The default Theme is not in the registry.',
    });
  } else if (!isEditionTheme(draft.defaultTheme, draft.edition)) {
    issues.push({
      code: 'event-off-edition-theme',
      field: 'defaultTheme',
      message: "The default Theme is not one this Event's Edition offers.",
    });
  }
  return issues;
}

/**
 * No easy- or closing-pool Prompt carries `spicy`.
 *
 * The type already makes this unrepresentable (`DraftCuratedPrompt['spicy']:
 * never`) and `parseEventDraft` reads a stored blob that breaks it as a miss.
 * This is the third layer, for a draft that reached memory through an untyped
 * path — an imported pack, a fixture, a future server draft. `adminAddItem`
 * forces `spicy: false` outside main and the 18+ posture derivation ignores
 * non-main pools, so a spicy curated Prompt is silently de-flagged: an
 * explicit Square reaching a card with no 18+ gate (#785).
 */
export function promptPoolIssues(draft: EventDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  // The main pool's `spicy` is REQUIRED and must be a real boolean. An untyped
  // starter pack or import can supply `undefined` or the STRING 'true', which
  // `parseEventDraft` refuses but an in-memory draft never faces. The
  // provisioner then either trips the Firestore boolean requirement or, on a
  // trusted path, persists a value the dealer and the 18+ derivation do not
  // recognise as true — explicit content served with no gate (#787 review).
  for (const prompt of draft.prompts.main) {
    if (prompt === null || prompt === undefined) continue;
    if (typeof (prompt as { spicy?: unknown }).spicy !== 'boolean') {
      issues.push({
        code: 'main-prompt-spicy-not-boolean',
        pool: 'main',
        message:
          'A main-pool Prompt carries a non-boolean spicy flag; it would not be recognised as spicy and could serve explicit content without raising the 18+ gate.',
      });
    }
  }
  for (const pool of ['easy', 'closing'] as const) {
    for (const prompt of draft.prompts[pool]) {
      // A hole yields `undefined` here, and the property access below would
      // THROW before `promptTextIssues` could report the gap — crashing the
      // launch checklist. Reachable in memory via `new Array(n)`, with no
      // deserialization involved. The missing entry is reported there, so
      // this predicate only steps over it (#787 review).
      if (prompt === null || prompt === undefined) continue;
      // The VALUE, not the key: `JSON.stringify` drops an explicitly-undefined
      // property, so a presence check would call a draft unlaunchable in
      // memory and launchable after one save/load. `spicy: undefined` is
      // exactly equivalent to an absent key, and only a DEFINED flag is the
      // silently-dropped 18+ hazard this guards (matching `isCuratedPrompt`).
      if ((prompt as { spicy?: unknown }).spicy !== undefined) {
        issues.push({
          code: 'curated-prompt-is-spicy',
          pool,
          message: `A ${POOL_LABEL[pool]}-pool Prompt carries a spicy flag; spicy is main-pool only and would be dropped without raising the 18+ gate.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Every authored Prompt's text fits the persisted item-write contract.
 *
 * `firestore.rules` requires `text.size()` in 1–80 and every authoring input
 * caps at 80, but `assignedPoolIssues` counts entries rather than reading
 * them — so a pack with blank or over-long text can satisfy the 24-Prompt
 * minimum and clear the launch gate, only to be refused by rules at
 * provisioning or, through a trusted provisioner that bypasses them, create
 * blank Squares no Admin editor can repair (#785).
 *
 * Checked across ALL THREE pools: the contract is a property of an item
 * document, not of the pool it belongs to.
 */
export function promptTextIssues(draft: EventDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  for (const pool of ['main', 'easy', 'closing'] as const) {
    const prompts = draft.prompts[pool];
    // An INDEX walk, not `forEach`: `forEach` skips holes, so a sparse array
    // would slip its missing entries past this gate entirely.
    for (let position = 0; position < prompts.length; position++) {
      const prompt: unknown = prompts[position];
      if (prompt === null || prompt === undefined) {
        issues.push({
          code: 'prompt-text-out-of-bounds',
          pool,
          message: `Prompt ${position + 1} in the ${POOL_LABEL[pool]} pool is missing; the pool has a gap where an authored Prompt should be.`,
        });
        continue;
      }
      const raw = (prompt as { text?: unknown }).text;
      const rawText = typeof raw === 'string' ? raw : '';
      if (rawText.trim().length === 0) {
        issues.push({
          code: 'prompt-text-out-of-bounds',
          pool,
          message: `Prompt ${position + 1} in the ${POOL_LABEL[pool]} pool has no text; a blank Square cannot be created or repaired later.`,
        });
      } else if (rawText.length > MAX_PROMPT_TEXT) {
        // The RAW length, matching `firestore.rules`, which applies
        // `text.size() <= 80` to the value as PERSISTED. Measuring the trimmed
        // form would accept 80 visible characters plus trailing whitespace and
        // then be refused at provisioning (#787 review).
        issues.push({
          code: 'prompt-text-out-of-bounds',
          pool,
          message: `Prompt ${position + 1} in the ${POOL_LABEL[pool]} pool is ${rawText.length} characters as stored; the limit is ${MAX_PROMPT_TEXT}.`,
        });
      }
    }
  }
  return issues;
}

/**
 * The Event settings sit inside the ranges their consumers honour.
 *
 * `parseEventDraft` already refuses these values in a STORED blob, but the
 * launch gate runs over drafts that never went through storage — one created
 * with custom settings, or edited since the last save. Without this, a draft
 * with `reportHideThreshold: 0` reaches the provisioner through
 * `isDraftLaunchable` and persists an Event whose report-based hiding is
 * silently off (#787 review).
 *
 * The bounds are the same ones the parser enforces, for the same reasons:
 * `isReportHidden` and the server auto-hide path read a non-positive threshold
 * as "disabled", and `dealBoard` clamps ratios rather than honouring them.
 */
export function settingsIssues(draft: EventDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const { reportHideThreshold, spicyRatio, easyMixRatio } = draft.settings;
  if (!Number.isFinite(reportHideThreshold) || reportHideThreshold <= 0) {
    issues.push({
      code: 'setting-out-of-range',
      field: 'reportHideThreshold',
      message: `The report-hide threshold must be a positive number of reports; ${reportHideThreshold} disables community report hiding entirely.`,
    });
  }
  const ratios: [string, number][] = [
    ['spicyRatio', spicyRatio],
    ['easyMixRatio', easyMixRatio],
  ];
  for (const [field, value] of ratios) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      issues.push({
        code: 'setting-out-of-range',
        field,
        message: `${field} must be between 0 and 1; ${value} is outside the range the card dealer honours and would be silently clamped.`,
      });
    }
  }
  return issues;
}

/**
 * Every reason this draft cannot launch, in checklist order.
 *
 * Returns issues rather than a boolean because Step 5 renders each one as its
 * own row with its own Edit link — a single "not ready" would be exactly the
 * total-based reporting #785 warns about.
 */
export function validateEventDraft(draft: EventDraft, now: number): DraftIssue[] {
  const firstUnlock = firstUnlockIssues(draft, now);
  // ONE organizer mistake is ONE checklist row. `firstUnlockIssues` speaks
  // specifically about Day 1's unlock — missing, the open sentinel, or already
  // past — and each of those also trips the generic per-Day unlock checks.
  // Editing the unlock clears both, so rendering them as two independent
  // repairs would misrepresent the work (#787 review). The specific message
  // wins; the generic one for that same Day is suppressed.
  const firstUnlockDays = new Set(
    firstUnlock.map((issue) => issue.dayIndex).filter((index) => index !== undefined),
  );
  const dayIssues = dayCompletenessIssues(draft).filter(
    (issue) =>
      !(
        (issue.code === 'day-missing-unlock' || issue.code === 'day-unlock-date-mismatch') &&
        issue.dayIndex !== undefined &&
        firstUnlockDays.has(issue.dayIndex)
      ),
  );
  return [
    ...eventCompletenessIssues(draft),
    ...settingsIssues(draft),
    ...assignedPoolIssues(draft),
    ...promptPoolIssues(draft),
    ...promptTextIssues(draft),
    ...dayCountIssues(draft),
    ...finaleClosingPoolIssues(draft),
    ...firstUnlock,
    ...dayIssues,
  ];
}

/** Whether the draft clears every gate this module knows about. NOT the whole
 *  launch gate: the live slug claim, the derived 18+ posture and the last-call
 *  derivation (#784) are checked where they are resolved, not here. */
export function isDraftLaunchable(draft: EventDraft, now: number): boolean {
  return validateEventDraft(draft, now).length === 0;
}
