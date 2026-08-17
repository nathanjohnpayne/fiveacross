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
// The SAME bound `parseEventDraft` enforces on the stored blob, so the
// in-memory gate and the persistence gate cannot drift apart.
import { MAX_PROMPT_TEXT } from './eventDraft';

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
  | 'day-tonight-not-two'
  | 'day-off-edition-theme'
  | 'one-card-has-days'
  | 'event-missing-field'
  | 'event-unregistered-theme'
  | 'event-off-edition-theme'
  | 'event-unsupported-timezone'
  | 'event-invalid-date-window'
  | 'event-occasion-edition-mismatch'
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
  const trimmed = timezone.trim();
  return trimmed.length > 0 && normalizeTimezone(trimmed) === trimmed;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real ISO calendar date — `2026-02-30` parses as March 2nd in a `Date`, so
 *  the round-trip is what proves the day actually exists. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function daysInOrder(draft: EventDraft): DraftDayDef[] {
  return [...draft.days].sort((a, b) => a.index - b.index);
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
  for (const day of draft.days) seen.add(normalizePool(day.pool));
  return [...seen];
}

const POOL_LABEL: Record<PoolId, string> = {
  main: 'main',
  easy: 'easy',
  closing: 'closing',
};

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
    const count = draft.prompts[pool].length;
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
  if (normalizePool(finalDay.pool) === 'closing') return [];
  return [
    {
      code: 'no-closing-day',
      dayIndex: finalDay.index,
      message: `Day ${finalDay.index + 1} is the final Day but deals from the ${POOL_LABEL[normalizePool(finalDay.pool)]} pool; assign it the closing pool or the finale never runs.`,
    },
  ];
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
  const first = daysInOrder(draft)[0];
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
  const ordered = daysInOrder(draft);
  ordered.forEach((day, position) => {
    if (day.index !== position) {
      issues.push({
        code: 'day-index-out-of-order',
        dayIndex: day.index,
        message: `Day indexes must be contiguous from 0; found index ${day.index} in position ${position}.`,
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
    if (day.unlockAt === null || !Number.isFinite(day.unlockAt)) {
      issues.push({
        code: 'day-missing-unlock',
        dayIndex: day.index,
        // A NaN or Infinity reaches here from schedule arithmetic over a
        // malformed date, and would otherwise pass a bare `!== null` check and
        // launch a Day that never unlocks.
        message: `Day ${day.index + 1} has no usable unlock time.`,
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
  });
  return issues;
}

/** The Event-level fields a launched `EventDoc` requires. `slugCandidate` is
 *  checked for presence only: its format and the reserved-name list are the
 *  shared contract #790 introduces, and duplicating a weaker version of them
 *  here would be a second answer to a question that needs one. */
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
  for (const pool of ['easy', 'closing'] as const) {
    for (const prompt of draft.prompts[pool]) {
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
    draft.prompts[pool].forEach((prompt, position) => {
      const text = typeof prompt.text === 'string' ? prompt.text.trim() : '';
      if (text.length === 0) {
        issues.push({
          code: 'prompt-text-out-of-bounds',
          pool,
          message: `Prompt ${position + 1} in the ${POOL_LABEL[pool]} pool has no text; a blank Square cannot be created or repaired later.`,
        });
      } else if (text.length > MAX_PROMPT_TEXT) {
        issues.push({
          code: 'prompt-text-out-of-bounds',
          pool,
          message: `Prompt ${position + 1} in the ${POOL_LABEL[pool]} pool is ${text.length} characters; the limit is ${MAX_PROMPT_TEXT}.`,
        });
      }
    });
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
  return [
    ...eventCompletenessIssues(draft),
    ...assignedPoolIssues(draft),
    ...promptPoolIssues(draft),
    ...promptTextIssues(draft),
    ...dayCountIssues(draft),
    ...finaleClosingPoolIssues(draft),
    ...firstUnlockIssues(draft, now),
    ...dayCompletenessIssues(draft),
  ];
}

/** Whether the draft clears every gate this module knows about. NOT the whole
 *  launch gate: the live slug claim, the derived 18+ posture and the last-call
 *  derivation (#784) are checked where they are resolved, not here. */
export function isDraftLaunchable(draft: EventDraft, now: number): boolean {
  return validateEventDraft(draft, now).length === 0;
}
