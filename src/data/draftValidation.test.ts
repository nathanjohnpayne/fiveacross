import { describe, expect, it } from 'vitest';
import type { DraftDayDef, EventDraft, OccasionId, ThemeId } from '../types';
import { MIN_POOL } from '../game/logic';
import { createEventDraft } from './eventDraft';
import {
  MAX_DAYS,
  assignedPoolIssues,
  assignedPools,
  dayCompletenessIssues,
  dayCountIssues,
  eventCompletenessIssues,
  finaleClosingPoolIssues,
  firstUnlockIssues,
  isDraftLaunchable,
  isIsoDate,
  isRegisteredTheme,
  isSupportedTimezone,
  promptPoolIssues,
  validateEventDraft,
} from './draftValidation';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const FUTURE = NOW + 86_400_000;

function mainPrompts(n: number, spicy = false) {
  return Array.from({ length: n }, (_, i) => ({ text: `main ${i}`, spicy }));
}

function curatedPrompts(n: number, label: string) {
  return Array.from({ length: n }, (_, i) => ({ text: `${label} ${i}` }));
}

function day(index: number, over: Partial<DraftDayDef> = {}): DraftDayDef {
  return {
    index,
    date: '2026-08-07',
    unlockAt: FUTURE + index * 3_600_000,
    place: 'Point Reyes',
    placeEmoji: '🌊',
    theme: 'the-birds' as ThemeId,
    pool: 'main',
    tutorial: false,
    tonight: ['🦀 Crab shack', '🔥 Fire pit'],
    ...over,
  };
}

/** A draft that clears every gate, so each test can break exactly one thing. */
function launchableDraft(over: Partial<EventDraft> = {}): EventDraft {
  return {
    ...createEventDraft({ now: NOW, draftId: 'draft-1', timezone: 'America/Los_Angeles' }),
    occasion: 'weekend-away',
    name: 'Weekend in Point Reyes',
    startsOn: '2026-08-07',
    endsOn: '2026-08-09',
    slugCandidate: 'point-reyes',
    defaultTheme: 'fog-froth-farewells' as ThemeId,
    edition: 'vacay',
    prompts: {
      main: mainPrompts(32),
      easy: curatedPrompts(28, 'easy'),
      closing: curatedPrompts(26, 'closing'),
    },
    days: [
      day(0, { pool: 'easy' }),
      day(1),
      // Two Days on ONE date — Bodega's Sunday. A Day is not a calendar date.
      day(2, { date: '2026-08-09' }),
      day(3, { date: '2026-08-09', pool: 'closing', tutorial: true }),
    ],
    ...over,
  };
}

describe('the baseline fixture', () => {
  it('is launchable, so every failure below is the one thing the test broke', () => {
    expect(validateEventDraft(launchableDraft(), NOW)).toEqual([]);
    expect(isDraftLaunchable(launchableDraft(), NOW)).toBe(true);
  });

  it('carries two Days sharing one date — a Day is not a calendar date', () => {
    const dates = launchableDraft().days.map((d) => d.date);
    expect(dates.filter((d) => d === '2026-08-09')).toHaveLength(2);
  });
});

describe('assignedPoolIssues — the minimum is per assigned pool, never a total', () => {
  it('fails the closing pool BY NAME on a 62-total pack with 4 closing Prompts', () => {
    const draft = launchableDraft({
      prompts: {
        main: mainPrompts(32),
        easy: curatedPrompts(26, 'easy'),
        closing: curatedPrompts(4, 'closing'),
      },
    });
    // 32 + 26 + 4 = 62 — comfortably past 24 by any total-based check.
    const total = draft.prompts.main.length + draft.prompts.easy.length + draft.prompts.closing.length;
    expect(total).toBe(62);
    expect(total).toBeGreaterThan(MIN_POOL);

    const issues = assignedPoolIssues(draft);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('pool-below-minimum');
    expect(issues[0].pool).toBe('closing');
    expect(issues[0].message).toContain('closing');
    expect(issues[0].message).toContain('24');
  });

  it('passes a pool sitting exactly on MIN_POOL and fails it one short', () => {
    const at = launchableDraft({
      prompts: {
        main: mainPrompts(MIN_POOL),
        easy: curatedPrompts(MIN_POOL, 'easy'),
        closing: curatedPrompts(MIN_POOL, 'closing'),
      },
    });
    expect(assignedPoolIssues(at)).toEqual([]);

    const short = launchableDraft({
      prompts: {
        main: mainPrompts(MIN_POOL - 1),
        easy: curatedPrompts(MIN_POOL, 'easy'),
        closing: curatedPrompts(MIN_POOL, 'closing'),
      },
    });
    expect(assignedPoolIssues(short).map((i) => i.pool)).toEqual(['main']);
  });

  it('ignores a pool no Day is assigned to', () => {
    // No easy Day: the empty easy pool must not block the launch.
    const draft = launchableDraft({
      days: [day(0), day(1, { pool: 'closing' })],
      prompts: { main: mainPrompts(24), easy: [], closing: curatedPrompts(24, 'closing') },
    });
    expect(assignedPools(draft).sort()).toEqual(['closing', 'main']);
    expect(assignedPoolIssues(draft)).toEqual([]);
  });

  it('reads legacy persisted pool spellings through normalizePool', () => {
    const draft = launchableDraft({
      // `embark`/`farewell` are what both live Events still persist.
      days: [
        day(0, { pool: 'embark' as unknown as DraftDayDef['pool'] }),
        day(1, { pool: 'farewell' as unknown as DraftDayDef['pool'] }),
      ],
      prompts: { main: [], easy: curatedPrompts(24, 'easy'), closing: curatedPrompts(24, 'closing') },
    });
    expect(assignedPools(draft).sort()).toEqual(['closing', 'easy']);
    expect(assignedPoolIssues(draft)).toEqual([]);
  });

  it('gates a one-card Event on the main pool alone', () => {
    const draft = launchableDraft({
      cardFormat: 'one_card',
      days: [],
      prompts: { main: mainPrompts(4), easy: [], closing: [] },
    });
    expect(assignedPools(draft)).toEqual(['main']);
    expect(assignedPoolIssues(draft).map((i) => i.pool)).toEqual(['main']);
  });
});

describe('finaleClosingPoolIssues', () => {
  it('fails, naming the final Day, when it carries no closing pool', () => {
    const draft = launchableDraft({
      days: [day(0, { pool: 'easy' }), day(1), day(2)],
    });
    const issues = finaleClosingPoolIssues(draft);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('no-closing-day');
    expect(issues[0].dayIndex).toBe(2);
    expect(issues[0].message).toContain('Day 3');
    expect(issues[0].message).toContain('closing');
  });

  it('is not satisfied by a closing Day somewhere in the middle', () => {
    const draft = launchableDraft({
      days: [day(0, { pool: 'closing' }), day(1)],
    });
    expect(finaleClosingPoolIssues(draft).map((i) => i.dayIndex)).toEqual([1]);
  });

  it('judges the FINAL Day by index, not by array position', () => {
    const draft = launchableDraft({
      days: [day(3, { pool: 'closing' }), day(0, { pool: 'easy' }), day(1), day(2)],
    });
    expect(finaleClosingPoolIssues(draft)).toEqual([]);
  });

  it('is inert for a one-card Event, which has no finale', () => {
    expect(finaleClosingPoolIssues(launchableDraft({ cardFormat: 'one_card', days: [] }))).toEqual([]);
  });
});

describe('firstUnlockIssues', () => {
  it('passes a first unlock in the future', () => {
    expect(firstUnlockIssues(launchableDraft(), NOW)).toEqual([]);
  });

  it('fails an already-elapsed first unlock, which would stamp an empty snapshot', () => {
    const draft = launchableDraft({ days: [day(0, { unlockAt: NOW - 1 }), day(1, { pool: 'closing' })] });
    const issues = firstUnlockIssues(draft, NOW);
    expect(issues.map((i) => i.code)).toEqual(['first-unlock-past']);
    expect(issues[0].dayIndex).toBe(0);
  });

  it('fails an unlock exactly at now — the cutoff is strict', () => {
    const draft = launchableDraft({ days: [day(0, { unlockAt: NOW }), day(1, { pool: 'closing' })] });
    expect(firstUnlockIssues(draft, NOW).map((i) => i.code)).toEqual(['first-unlock-past']);
  });

  it('reports the open-immediately sentinel separately from a past instant', () => {
    const draft = launchableDraft({ days: [day(0, { unlockAt: 0 }), day(1, { pool: 'closing' })] });
    const issues = firstUnlockIssues(draft, NOW);
    expect(issues.map((i) => i.code)).toEqual(['first-unlock-sentinel']);
    expect(issues[0].message).toContain('pre-stamped snapshot');
  });

  it('reports a missing unlock as its own code', () => {
    const draft = launchableDraft({ days: [day(0, { unlockAt: null }), day(1, { pool: 'closing' })] });
    expect(firstUnlockIssues(draft, NOW).map((i) => i.code)).toEqual(['first-unlock-missing']);
  });

  it('judges Day 0 even when it is not first in the array', () => {
    const draft = launchableDraft({
      days: [day(1, { pool: 'closing' }), day(0, { unlockAt: NOW - 1 })],
    });
    expect(firstUnlockIssues(draft, NOW).map((i) => i.dayIndex)).toEqual([0]);
  });
});

describe('dayCountIssues — the ten-Day ceiling is a rules fact', () => {
  it('fails an eleven-Day schedule', () => {
    const days = Array.from({ length: MAX_DAYS + 1 }, (_, i) =>
      day(i, { pool: i === MAX_DAYS ? 'closing' : 'main' }),
    );
    const issues = dayCountIssues(launchableDraft({ days }));
    expect(issues.map((i) => i.code)).toEqual(['too-many-days']);
    expect(issues[0].message).toContain('0–9');
  });

  it('passes exactly ten Days', () => {
    const days = Array.from({ length: MAX_DAYS }, (_, i) =>
      day(i, { pool: i === MAX_DAYS - 1 ? 'closing' : 'main' }),
    );
    expect(dayCountIssues(launchableDraft({ days }))).toEqual([]);
  });

  it('fails a daily-cards draft with no Days at all', () => {
    expect(dayCountIssues(launchableDraft({ days: [] })).map((i) => i.code)).toEqual(['no-days']);
  });

  it('passes a one-card draft with no Days, and fails one that carries them', () => {
    expect(dayCountIssues(launchableDraft({ cardFormat: 'one_card', days: [] }))).toEqual([]);
    expect(
      dayCountIssues(launchableDraft({ cardFormat: 'one_card' })).map((i) => i.code),
    ).toEqual(['one-card-has-days']);
  });
});

describe('dayCompletenessIssues', () => {
  it('requires a place and its emoji — neither is editable after launch', () => {
    const draft = launchableDraft({ days: [day(0, { place: '  ' }), day(1, { pool: 'closing', placeEmoji: '' })] });
    expect(dayCompletenessIssues(draft).map((i) => [i.code, i.dayIndex])).toEqual([
      ['day-missing-place', 0],
      ['day-missing-place', 1],
    ]);
  });

  it('requires EXACTLY two tonight entries', () => {
    const draft = launchableDraft({
      days: [
        day(0, { tonight: ['only one'] }),
        day(1, { tonight: ['a', 'b', 'c'] }),
        day(2, { tonight: ['a', '   '] }),
        day(3, { pool: 'closing' }),
      ],
    });
    expect(dayCompletenessIssues(draft).map((i) => [i.code, i.dayIndex])).toEqual([
      ['day-tonight-not-two', 0],
      ['day-tonight-not-two', 1],
      ['day-tonight-not-two', 2],
    ]);
  });

  it('requires a registered Theme, and distinguishes unset from unregistered', () => {
    const draft = launchableDraft({
      days: [
        day(0, { theme: null }),
        day(1, { theme: 'custom-palette' as ThemeId }),
        day(2, { pool: 'closing' }),
      ],
    });
    expect(dayCompletenessIssues(draft).map((i) => i.code)).toEqual([
      'day-missing-theme',
      'day-unregistered-theme',
    ]);
    expect(isRegisteredTheme('the-birds' as ThemeId)).toBe(true);
    expect(isRegisteredTheme('custom-palette' as ThemeId)).toBe(false);
  });

  it('counts tonight ARRAY entries, not just the non-blank ones', () => {
    // `tonight` is persisted verbatim and consumers join it, so a trailing
    // blank is a rendering defect even though two entries are filled.
    const draft = launchableDraft({
      days: [day(0, { tonight: ['🦀 Crab shack', '🔥 Fire pit', '  '] }), day(1, { pool: 'closing' })],
    });
    const issues = dayCompletenessIssues(draft);
    expect(issues.map((i) => i.code)).toEqual(['day-tonight-not-two']);
    expect(issues[0].message).toContain('3');
  });

  it('rejects a non-finite unlock time, not only a missing one', () => {
    const draft = launchableDraft({
      days: [day(0, { unlockAt: Number.NaN }), day(1, { unlockAt: Infinity, pool: 'closing' })],
    });
    expect(dayCompletenessIssues(draft).map((i) => [i.code, i.dayIndex])).toEqual([
      ['day-missing-unlock', 0],
      ['day-missing-unlock', 1],
    ]);
  });

  it('flags a Day Theme the bound Edition does not offer, separately from an unregistered one', () => {
    const draft = launchableDraft({
      // Registered, but a Five Across Theme on a Vacay Event — the state a
      // re-picked occasion leaves behind.
      days: [day(0, { theme: 'marquee' as ThemeId }), day(1, { pool: 'closing' })],
    });
    expect(dayCompletenessIssues(draft).map((i) => i.code)).toEqual(['day-off-edition-theme']);
  });

  it('requires contiguous indexes from zero', () => {
    const draft = launchableDraft({ days: [day(1), day(2, { pool: 'closing' })] });
    expect(dayCompletenessIssues(draft).map((i) => i.code)).toEqual([
      'day-index-out-of-order',
      'day-index-out-of-order',
    ]);
  });

  it('accepts a curated-pool Day whose wins count, and a main Day that is tutorial', () => {
    // `tutorial` is independent of `pool` in BOTH directions (#785): Bodega's
    // easy-pool Friday is tutorial:false, and nothing forbids the converse.
    const draft = launchableDraft({
      days: [
        day(0, { pool: 'easy', tutorial: false }),
        day(1, { pool: 'main', tutorial: true }),
        day(2, { pool: 'closing', tutorial: false }),
      ],
    });
    expect(dayCompletenessIssues(draft)).toEqual([]);
  });
});

describe('eventCompletenessIssues', () => {
  it('names every empty required field', () => {
    const bare = createEventDraft({ now: NOW, draftId: 'd', timezone: '' });
    expect(eventCompletenessIssues(bare).map((i) => i.field)).toEqual([
      'name',
      'startsOn',
      'endsOn',
      'timezone',
      'slugCandidate',
      'occasion',
      'defaultTheme',
    ]);
  });

  it('requires an occasion — it is what binds the Edition', () => {
    expect(eventCompletenessIssues(launchableDraft({ occasion: null })).map((i) => i.field)).toEqual([
      'occasion',
    ]);
    expect(
      eventCompletenessIssues(launchableDraft({ occasion: 'festival' as OccasionId })).map((i) => i.field),
    ).toEqual(['occasion']);
  });

  it('rejects a zone the read-side contract would silently rewrite', () => {
    // `normalizeTimezone` substitutes Europe/Rome for UTC, Etc/*, bare offsets
    // and anything without a region prefix — so accepting them here would
    // launch a schedule that runs hours away from where it was authored.
    for (const zone of ['UTC', 'Etc/UTC', 'GMT', '+05:30', 'PST']) {
      const issues = eventCompletenessIssues(launchableDraft({ timezone: zone }));
      expect(issues.map((i) => i.code)).toEqual(['event-unsupported-timezone']);
    }
    expect(isSupportedTimezone('America/Los_Angeles')).toBe(true);
    expect(isSupportedTimezone('Europe/Rome')).toBe(true);
    expect(isSupportedTimezone('UTC')).toBe(false);
  });

  it('rejects a reversed or impossible date window', () => {
    expect(
      eventCompletenessIssues(launchableDraft({ startsOn: '2026-08-09', endsOn: '2026-08-07' })).map(
        (i) => i.code,
      ),
    ).toEqual(['event-invalid-date-window']);
    expect(
      eventCompletenessIssues(launchableDraft({ startsOn: '2026-02-30' })).map((i) => i.code),
    ).toEqual(['event-invalid-date-window']);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('7 Aug 2026')).toBe(false);
  });

  it('accepts a single-day window', () => {
    expect(
      eventCompletenessIssues(launchableDraft({ startsOn: '2026-08-07', endsOn: '2026-08-07' })),
    ).toEqual([]);
  });

  it('rejects a default Theme the bound Edition does not offer', () => {
    // Marquee is registered, but it belongs to the Five Across Edition — this
    // is the state a re-picked occasion leaves behind.
    const issues = eventCompletenessIssues(launchableDraft({ defaultTheme: 'marquee' as ThemeId }));
    expect(issues.map((i) => i.code)).toEqual(['event-off-edition-theme']);
  });

  it('requires a default Theme independently of every Day Theme', () => {
    const draft = launchableDraft({ defaultTheme: null });
    expect(eventCompletenessIssues(draft).map((i) => i.field)).toEqual(['defaultTheme']);
  });

  it('rejects an unregistered default Theme', () => {
    const draft = launchableDraft({ defaultTheme: 'not-a-theme' as ThemeId });
    expect(eventCompletenessIssues(draft).map((i) => i.code)).toEqual(['event-unregistered-theme']);
  });
});

describe('promptPoolIssues — spicy is main-pool only', () => {
  it('accepts spicy on main-pool Prompts', () => {
    expect(promptPoolIssues(launchableDraft({
      prompts: {
        main: mainPrompts(24, true),
        easy: curatedPrompts(24, 'easy'),
        closing: curatedPrompts(24, 'closing'),
      },
    }))).toEqual([]);
  });

  it('flags a spicy flag that reached a curated pool through an untyped path', () => {
    const draft = launchableDraft();
    // The type forbids this; only JSON or a cast can produce it, which is
    // exactly the path this predicate exists for.
    draft.prompts.closing[0] = { text: 'smuggled', spicy: true } as unknown as (typeof draft.prompts.closing)[number];
    const issues = promptPoolIssues(draft);
    expect(issues.map((i) => [i.code, i.pool])).toEqual([['curated-prompt-is-spicy', 'closing']]);
  });

  it('does not allow spicy on a curated Prompt at the type level', () => {
    // @ts-expect-error `spicy` is `never` on a curated Prompt — this is the
    // type-level half of the main-pool-only rule, asserted by `tsc`.
    const bad: EventDraft['prompts']['easy'][number] = { text: 'nope', spicy: true };
    expect(bad.text).toBe('nope');
  });
});

describe('validateEventDraft', () => {
  it('reports every independent failure at once rather than stopping at the first', () => {
    const draft = launchableDraft({
      name: '',
      days: [day(0, { unlockAt: NOW - 1, place: '' })],
      prompts: { main: mainPrompts(2), easy: [], closing: [] },
    });
    const codes = validateEventDraft(draft, NOW).map((i) => i.code);
    expect(codes).toContain('event-missing-field');
    expect(codes).toContain('pool-below-minimum');
    expect(codes).toContain('no-closing-day');
    expect(codes).toContain('first-unlock-past');
    expect(codes).toContain('day-missing-place');
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });
});
