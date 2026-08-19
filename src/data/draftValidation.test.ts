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
  isRepresentableInstant,
  settingsIssues,
  firstUnlockIssues,
  isDraftLaunchable,
  isIsoDate,
  isRegisteredTheme,
  isSupportedTimezone,
  promptPoolIssues,
  promptTextIssues,
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

/**
 * An unlock instant that genuinely falls on `date` in the fixture's zone
 * (America/Los_Angeles). 13:00Z is 06:00 PDT in August, and the per-Day hour
 * offset keeps every Day well inside its own calendar day.
 *
 * Derived from the date rather than from a flat `NOW + n` offset because the
 * two must AGREE: a Day whose stated date and unlock instant name different
 * calendar days unlocks its card on one day and is emailed as another, which
 * `day-unlock-date-mismatch` now rejects. A malformed date has no instant to
 * derive, so those cases keep a fixed valid unlock and fail on the date alone.
 */
function unlockOn(date: string, index: number): number {
  const parsed = Date.parse(`${date}T13:00:00Z`);
  return Number.isNaN(parsed) ? FUTURE + index * 3_600_000 : parsed + index * 3_600_000;
}

function day(index: number, over: Partial<DraftDayDef> = {}): DraftDayDef {
  const date = over.date ?? '2026-08-07';
  return {
    index,
    date,
    unlockAt: unlockOn(date, index),
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
    slugVerifiedForEdition: 'vacay',
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
    const issues = finaleClosingPoolIssues(draft);
    // BOTH independent failures, reported together: the final Day is not
    // closing (index 1), AND the middle Day wrongly is (index 0). Reporting
    // only the first would make the second appear as a brand-new failure the
    // moment the organizer fixed it.
    expect(issues.map((i) => [i.code, i.dayIndex]).sort()).toEqual([
      ['extra-closing-day', 0],
      ['no-closing-day', 1],
    ]);
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

  it('reports nothing when Day 0 is missing, rather than misattributing a later Day as "Day 1" (#816)', () => {
    // No index-0 entry at all — a malformed/sparse schedule, already its own
    // failure (`dayCompletenessIssues` → `day-index-out-of-order`). Before the
    // fix, `daysInOrder(draft)[0]` picked Day 1 here and reported it under the
    // hardcoded "Day 1 has no unlock time yet." message.
    const draft = launchableDraft({
      days: [day(1, { unlockAt: null }), day(3, { pool: 'closing' })],
    });
    expect(firstUnlockIssues(draft, NOW)).toEqual([]);
  });

  it('still finds Day 0 directly when a negative-index Day sorts before it (CodeRabbit, #833 review)', () => {
    // daysInOrder sorts ascending, so [0] in that array would be the Day at
    // index -1, not Day 0 — the wrong Day, from which the old `[0].index !==
    // 0` guard concluded there was no first-unlock issue to report, even
    // though Day 0 is right here and unlockless.
    const draft = launchableDraft({
      days: [day(-1, { pool: 'closing' }), day(0, { unlockAt: null })],
    });
    const issues = firstUnlockIssues(draft, NOW);
    expect(issues.map((i) => i.code)).toEqual(['first-unlock-missing']);
    expect(issues[0].dayIndex).toBe(0);
  });

  it('does not suppress a later Day\'s own unlock diagnostic when Day 0 is missing (#816)', () => {
    const draft = launchableDraft({
      days: [day(1, { unlockAt: null }), day(3, { pool: 'closing' })],
    });
    // Day 1's own generic diagnostic must survive — the old bug swallowed it
    // into a wrongly labeled "Day 1" first-unlock issue instead.
    const dayIssues = dayCompletenessIssues(draft);
    expect(dayIssues.some((i) => i.code === 'day-missing-unlock' && i.dayIndex === 1)).toBe(true);
    expect(validateEventDraft(draft, NOW).some((i) => i.code === 'first-unlock-missing')).toBe(false);
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

  it('flags a platform-chrome Theme the SAME way, even on the Edition it is bound to (#882)', () => {
    // `fiveacross-slate` is registered and THEME_EDITIONS-bound to
    // `fiveacross` — same as `marquee` above — but `chrome: true` keeps it
    // out of `themesForEdition('fiveacross')`'s picker, so `isEditionTheme`
    // reads it exactly like an off-Edition Theme even though it belongs to
    // the Event's OWN Edition. No UI path can write this id to a Day (no
    // picker offers it), but the validator has to be right about it anyway:
    // 'day-off-edition-theme' is a statement about the PICKER, not about
    // which Edition a Theme's THEME_EDITIONS row names.
    const draft = launchableDraft({
      edition: 'fiveacross',
      // day(1) needs its own valid fiveacross Theme — its default ('the-birds',
      // a Vacay Theme) would otherwise ALSO trip 'day-off-edition-theme' once
      // the draft's Edition changes, polluting the assertion below.
      days: [
        day(0, { theme: 'fiveacross-slate' as ThemeId }),
        day(1, { theme: 'marquee' as ThemeId, pool: 'closing' }),
      ],
    });
    expect(dayCompletenessIssues(draft).map((i) => i.code)).toEqual(['day-off-edition-theme']);
    expect(isRegisteredTheme('fiveacross-slate' as ThemeId)).toBe(true);
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

  it('refuses an address that is present but not CONFIRMED available', () => {
    // Phase 4b P1, PR #911. This gate is pure and synchronous and cannot await
    // a network read, so it consumes the verification the step records. A
    // present-but-unverified candidate is exactly what a resumed step shows
    // optimistically before its check resolves — and what an organizer would
    // otherwise carry straight past Continue.
    const issues = eventCompletenessIssues(launchableDraft({ slugVerifiedForEdition: '' }));
    expect(issues.map((i) => i.code)).toContain('event-slug-unverified');
  });

  it('refuses an address confirmed against a DIFFERENT Edition', () => {
    // An Edition change alters which hostnames a launch claims, so a candidate
    // confirmed under one says nothing about another. Storing the Edition
    // rather than a boolean is what makes that expressible.
    const issues = eventCompletenessIssues(launchableDraft({ slugVerifiedForEdition: 'fiveacross' }));
    expect(issues.map((i) => i.code)).toContain('event-slug-unverified');
  });

  it('requires an occasion — it is what binds the Edition', () => {
    expect(eventCompletenessIssues(launchableDraft({ occasion: null })).map((i) => i.field)).toEqual([
      'occasion',
    ]);
    expect(
      eventCompletenessIssues(launchableDraft({ occasion: 'festival' as OccasionId })).map((i) => i.field),
    ).toEqual(['occasion']);
  });

  it.each([
    ['reserved infrastructure', 'admin', 'reserved-label'],
    ['reserved IDNA form', 'ab--cd', 'reserved-tag'],
    ['uppercase wire spelling', 'Point-Reyes', 'invalid-characters'],
  ])('uses the shared router Slug contract for %s', (_label, slugCandidate, rejection) => {
    const issues = eventCompletenessIssues(launchableDraft({ slugCandidate }));
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'event-invalid-slug',
        field: 'slugCandidate',
        message: expect.stringContaining(rejection),
      }),
    ]);
    expect(isDraftLaunchable(launchableDraft({ slugCandidate }), NOW)).toBe(false);
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

describe('day date validity (#787 review)', () => {
  it('rejects a Day whose date is not a real calendar date', () => {
    // `2026-02-30` parses as March 2nd in a `Date`, so a format check alone
    // would pass it — and `coerceEventPreview` then drops the ENTIRE pre-auth
    // schedule preview over the one malformed entry.
    const codes = dayCompletenessIssues(launchableDraft({ days: [day(0, { date: '2026-02-30' })] })).map(
      (i) => i.code,
    );
    expect(codes).toContain('day-invalid-date');
  });

  it('rejects unparseable Day date text', () => {
    const issues = dayCompletenessIssues(launchableDraft({ days: [day(0, { date: 'not-a-date' })] }));
    expect(issues.map((i) => i.code)).toContain('day-invalid-date');
    expect(issues.find((i) => i.code === 'day-invalid-date')?.dayIndex).toBe(0);
  });

  it('still reports a BLANK date as missing rather than invalid', () => {
    // The two are different repairs, so they stay different rows.
    const codes = dayCompletenessIssues(launchableDraft({ days: [day(0, { date: '   ' })] })).map(
      (i) => i.code,
    );
    expect(codes).toContain('day-missing-date');
    expect(codes).not.toContain('day-invalid-date');
  });

  it('accepts the real dates the baseline fixture uses', () => {
    expect(
      dayCompletenessIssues(launchableDraft()).filter((i) => i.code === 'day-invalid-date'),
    ).toEqual([]);
  });
});

describe('occasion-to-Edition binding (#787 review)', () => {
  it('rejects a recognized occasion sitting beside a stale Edition', () => {
    // A half-applied rebind: the occasion is what BINDS the Edition, so the
    // pair disagreeing means the launched Event carries a player-facing
    // identity the organizer never chose.
    const draft = launchableDraft({
      occasion: 'weekend-away' as OccasionId, // binds 'vacay'
      edition: 'fiveacross',
      // Themes that ARE registered for the stale Edition, so nothing else fires.
      defaultTheme: 'marquee' as ThemeId,
      days: [day(0, { theme: 'marquee' as ThemeId, pool: 'closing' })],
    });
    const issues = eventCompletenessIssues(draft);
    expect(issues.map((i) => i.code)).toContain('event-occasion-edition-mismatch');
    expect(issues.find((i) => i.code === 'event-occasion-edition-mismatch')?.field).toBe('edition');
  });

  it('is silent when the occasion and Edition agree', () => {
    expect(
      eventCompletenessIssues(launchableDraft()).filter(
        (i) => i.code === 'event-occasion-edition-mismatch',
      ),
    ).toEqual([]);
  });

  it('does not fire when there is no occasion yet — that is already its own issue', () => {
    const codes = eventCompletenessIssues(launchableDraft({ occasion: null })).map((i) => i.code);
    expect(codes).toContain('event-missing-field');
    expect(codes).not.toContain('event-occasion-edition-mismatch');
  });
});

describe('promptTextIssues — the persisted 1–80 contract (#787 review)', () => {
  it('rejects blank Prompt text that would otherwise count toward the minimum', () => {
    // `assignedPoolIssues` counts entries; it does not read them. So a blank
    // Prompt satisfies the 24-minimum and clears the gate.
    const draft = launchableDraft({
      prompts: {
        main: [...mainPrompts(31), { text: '   ', spicy: false }],
        easy: curatedPrompts(28, 'easy'),
        closing: curatedPrompts(26, 'closing'),
      },
    });
    expect(assignedPoolIssues(draft)).toEqual([]);
    const issues = promptTextIssues(draft);
    expect(issues.map((i) => i.code)).toContain('prompt-text-out-of-bounds');
    expect(issues[0].pool).toBe('main');
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });

  it('rejects text past the 80-character rules limit, in any pool', () => {
    const draft = launchableDraft({
      prompts: {
        main: mainPrompts(32),
        easy: [...curatedPrompts(27, 'easy'), { text: 'x'.repeat(81) }],
        closing: curatedPrompts(26, 'closing'),
      },
    });
    const issues = promptTextIssues(draft);
    expect(issues).toHaveLength(1);
    expect(issues[0].pool).toBe('easy');
    expect(issues[0].message).toContain('81');
  });

  it('accepts text exactly at the boundary', () => {
    const draft = launchableDraft({
      prompts: {
        main: [...mainPrompts(31), { text: 'x'.repeat(80), spicy: false }],
        easy: curatedPrompts(28, 'easy'),
        closing: curatedPrompts(26, 'closing'),
      },
    });
    expect(promptTextIssues(draft)).toEqual([]);
    expect(isDraftLaunchable(draft, NOW)).toBe(true);
  });
});

describe('curated spicy is judged by VALUE, so a save/load cannot flip it', () => {
  it('treats spicy:undefined as an absent key on both sides of a round trip', () => {
    const draft = launchableDraft({
      prompts: {
        main: mainPrompts(32),
        easy: [...curatedPrompts(27, 'easy'), { text: 'calm', spicy: undefined }],
        closing: curatedPrompts(26, 'closing'),
      },
    });
    expect(promptPoolIssues(draft)).toEqual([]);
    // The same draft after serialization, where the key no longer exists.
    const roundTripped = JSON.parse(JSON.stringify(draft)) as EventDraft;
    expect(promptPoolIssues(roundTripped)).toEqual([]);
    expect(isDraftLaunchable(draft, NOW)).toBe(isDraftLaunchable(roundTripped, NOW));
  });

  it('still refuses a DEFINED spicy flag on a curated Prompt', () => {
    const draft = launchableDraft({
      prompts: {
        main: mainPrompts(32),
        easy: [...curatedPrompts(27, 'easy'), { text: 'nope', spicy: true } as never],
        closing: curatedPrompts(26, 'closing'),
      },
    });
    expect(promptPoolIssues(draft).map((i) => i.code)).toEqual(['curated-prompt-is-spicy']);
  });
});

describe('stored Day order is the contract, not just index membership (#787 review)', () => {
  it('rejects a shuffled days array even when every index appears exactly once', () => {
    // Board, eventPreview and DaySwitcher all read days[i] BY POSITION, so a
    // schedule that only sorts correctly would deal another Day's card.
    const draft = launchableDraft({
      days: [
        day(1),
        day(0, { pool: 'easy' }),
        day(2, { date: '2026-08-09' }),
        day(3, { date: '2026-08-09', pool: 'closing', tutorial: true }),
      ],
    });
    const issues = dayCompletenessIssues(draft).filter((i) => i.code === 'day-index-out-of-order');
    expect(issues.length).toBeGreaterThan(0);
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });

  it('still accepts the correctly ordered baseline', () => {
    expect(
      dayCompletenessIssues(launchableDraft()).filter((i) => i.code === 'day-index-out-of-order'),
    ).toEqual([]);
  });
});

describe('only the final Day may carry the closing pool (#787 review)', () => {
  it('rejects an earlier closing Day, which would hijack the finale', () => {
    // finaleTimes and farewellDayIndex both resolve the farewell with
    // days.find(closing) — the FIRST match — so an earlier closing Day freezes
    // standings and posts the podium before the intended finale.
    const draft = launchableDraft({
      days: [
        day(0, { pool: 'easy' }),
        day(1, { pool: 'closing' }),
        day(2, { date: '2026-08-09' }),
        day(3, { date: '2026-08-09', pool: 'closing', tutorial: true }),
      ],
    });
    const issues = finaleClosingPoolIssues(draft);
    expect(issues.map((i) => i.code)).toContain('extra-closing-day');
    expect(issues.find((i) => i.code === 'extra-closing-day')?.dayIndex).toBe(1);
    // The final Day is still closing, so the original gate is satisfied...
    expect(issues.map((i) => i.code)).not.toContain('no-closing-day');
    // ...but the draft is not launchable.
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });

  it('is silent when exactly one closing Day sits last', () => {
    expect(finaleClosingPoolIssues(launchableDraft())).toEqual([]);
  });
});

describe('a Day unlock must land on the Day it is dated (#787 review)', () => {
  it('rejects an unlock that falls on a different calendar day in the Event zone', () => {
    // The scheduler and board lock read unlockAt; email ownership and schedule
    // copy read date. Disagreement means the card opens one day and is
    // announced on another.
    const draft = launchableDraft({
      days: [day(0, { pool: 'closing', unlockAt: Date.parse('2026-08-09T13:00:00Z') })],
      timezone: 'America/Los_Angeles',
    });
    const issues = dayCompletenessIssues(draft).filter(
      (i) => i.code === 'day-unlock-date-mismatch',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('2026-08-09');
  });

  it('reads the boundary through the Event timezone, not UTC', () => {
    // 2026-08-08T02:00Z is still Aug 7 at 19:00 in Los Angeles, so a Day dated
    // 2026-08-07 is CORRECT here — a UTC-based check would wrongly reject it.
    const draft = launchableDraft({
      days: [day(0, { pool: 'closing', date: '2026-08-07', unlockAt: Date.parse('2026-08-08T02:00:00Z') })],
      timezone: 'America/Los_Angeles',
    });
    expect(
      dayCompletenessIssues(draft).filter((i) => i.code === 'day-unlock-date-mismatch'),
    ).toEqual([]);
  });

  it('does not pile on when the date is already malformed', () => {
    const codes = dayCompletenessIssues(
      launchableDraft({ days: [day(0, { pool: 'closing', date: '2026-02-30' })] }),
    ).map((i) => i.code);
    expect(codes).toContain('day-invalid-date');
    expect(codes).not.toContain('day-unlock-date-mismatch');
  });
});

describe('sparse pools are counted honestly (#787 review)', () => {
  it('does not let holes satisfy the per-pool minimum', () => {
    // A sparse array of length 24 passes a nominal length check while holding
    // no Prompt objects at all; every/forEach both skip the holes.
    const sparse: { text: string; spicy: boolean }[] = [];
    sparse.length = MIN_POOL;
    const draft = launchableDraft({
      cardFormat: 'one_card',
      days: [],
      prompts: { main: sparse, easy: [], closing: [] },
    });
    expect(draft.prompts.main.length).toBe(MIN_POOL);
    const issues = assignedPoolIssues(draft);
    expect(issues.map((i) => i.code)).toContain('pool-below-minimum');
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });

  it('reports each missing slot rather than silently skipping it', () => {
    const holed = [...mainPrompts(3)];
    delete holed[1];
    const draft = launchableDraft({
      prompts: { main: holed, easy: curatedPrompts(28, 'easy'), closing: curatedPrompts(26, 'closing') },
    });
    const issues = promptTextIssues(draft).filter((i) => i.pool === 'main');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('missing');
  });
});

describe('Prompt text is bounded as STORED, not as trimmed (#787 review)', () => {
  it('rejects 80 visible characters plus trailing whitespace', () => {
    // firestore.rules applies text.size() <= 80 to the persisted value, so the
    // trimmed reading would launch a draft the server then refuses.
    const draft = launchableDraft({
      prompts: {
        main: [...mainPrompts(31), { text: `${'x'.repeat(80)}  `, spicy: false }],
        easy: curatedPrompts(28, 'easy'),
        closing: curatedPrompts(26, 'closing'),
      },
    });
    const issues = promptTextIssues(draft);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('82');
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });
});

describe('settings bounds hold in the shared launch gate too (#787 review)', () => {
  it('rejects a non-positive report-hide threshold on an unsaved draft', () => {
    // parseEventDraft only guards the STORED path; a draft created with custom
    // settings, or edited since the last save, never went through it.
    const draft = launchableDraft({
      settings: { ...launchableDraft().settings, reportHideThreshold: 0 },
    });
    const issues = settingsIssues(draft);
    expect(issues.map((i) => i.code)).toEqual(['setting-out-of-range']);
    expect(issues[0].field).toBe('reportHideThreshold');
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });

  it('rejects ratios outside 0-1 on an unsaved draft, naming each field', () => {
    const draft = launchableDraft({
      settings: { ...launchableDraft().settings, spicyRatio: 1.4, easyMixRatio: -0.2 },
    });
    expect(settingsIssues(draft).map((i) => i.field)).toEqual(['spicyRatio', 'easyMixRatio']);
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });

  it('is silent on the baseline settings', () => {
    expect(settingsIssues(launchableDraft())).toEqual([]);
  });
});

describe('an unrepresentable unlock instant is an issue, never a crash (#787 review)', () => {
  it('reports Number.MAX_VALUE instead of throwing while formatting it', () => {
    // Finite but outside the Date range: every Intl formatter throws on it, so
    // an unguarded value would crash the launch checklist.
    const draft = launchableDraft({
      days: [day(0, { pool: 'closing', unlockAt: Number.MAX_VALUE })],
    });
    expect(() => dayCompletenessIssues(draft)).not.toThrow();
    expect(dayCompletenessIssues(draft).map((i) => i.code)).toContain('day-missing-unlock');
    expect(() => isDraftLaunchable(draft, NOW)).not.toThrow();
  });

  it('accepts an instant at the representable boundary', () => {
    expect(isRepresentableInstant(8.64e15)).toBe(true);
    expect(isRepresentableInstant(8.64e15 + 1)).toBe(false);
    expect(isRepresentableInstant(Number.MAX_VALUE)).toBe(false);
    expect(isRepresentableInstant(Number.NaN)).toBe(false);
  });
});

describe('every non-final closing Day is reported at once (#787 review)', () => {
  it('flags the earlier closing Day even when the final Day is not closing', () => {
    // The slice(0, -1) reading exempted the LAST closing Day, so Step 5 first
    // showed only "the final Day needs the closing pool" and then surfaced a
    // brand-new failure after the organizer fixed it.
    const draft = launchableDraft({
      days: [
        day(0, { pool: 'easy' }),
        day(1, { pool: 'closing' }),
        day(2, { date: '2026-08-09' }),
        day(3, { date: '2026-08-09', pool: 'main' }),
      ],
    });
    const issues = finaleClosingPoolIssues(draft);
    // BOTH failures, together — not one and then the other.
    expect(issues.map((i) => i.code).sort()).toEqual(['extra-closing-day', 'no-closing-day']);
    expect(issues.find((i) => i.code === 'extra-closing-day')?.dayIndex).toBe(1);
  });
})

describe('a blank Free Space override is not "no override" (#787 review)', () => {
  it('rejects a present-but-blank freeText, which deals an empty centre Square', () => {
    // dealBoard and the locked-card preview both read `freeText ?? FREE_TEXT`,
    // so '' suppresses the default rather than falling back to it.
    const draft = launchableDraft({ days: [day(0, { pool: 'closing', freeText: '   ' })] });
    const issues = dayCompletenessIssues(draft).filter((i) => i.code === 'day-blank-free-text');
    expect(issues).toHaveLength(1);
    expect(issues[0].dayIndex).toBe(0);
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });

  it('accepts an absent override and a real one alike', () => {
    const absent = launchableDraft({ days: [day(0, { pool: 'closing' })] });
    const real = launchableDraft({
      days: [day(0, { pool: 'closing', freeText: 'You made it aboard' })],
    });
    for (const draft of [absent, real]) {
      expect(dayCompletenessIssues(draft).filter((i) => i.code === 'day-blank-free-text')).toEqual(
        [],
      );
    }
  });
});

describe('sparse arrays never crash the launch gate (#787 review)', () => {
  it('steps over a hole in a curated pool instead of throwing on .spicy', () => {
    // for...of yields undefined for a hole, so the property access used to
    // throw before promptTextIssues could report the gap.
    const holed: { text: string }[] = [];
    holed.length = 2;
    holed[0] = { text: 'easy 0' };
    const draft = launchableDraft({
      prompts: { main: mainPrompts(32), easy: holed, closing: curatedPrompts(26, 'closing') },
    });
    expect(() => promptPoolIssues(draft)).not.toThrow();
    expect(() => validateEventDraft(draft, NOW)).not.toThrow();
    // The gap is still REPORTED, just by the predicate that owns it.
    expect(promptTextIssues(draft).some((i) => i.message.includes('missing'))).toBe(true);
  });

  it('reports a gap in the day schedule rather than skipping it', () => {
    const days: DraftDayDef[] = [];
    days.length = 2;
    days[0] = day(0, { pool: 'closing' });
    const draft = launchableDraft({ days });
    expect(() => dayCompletenessIssues(draft)).not.toThrow();
    expect(dayCompletenessIssues(draft).map((i) => i.code)).toContain('day-index-out-of-order');
  });
});

describe('one unlock mistake is one checklist row (#787 review)', () => {
  it('does not also emit the generic unlock issue for Day 1', () => {
    const draft = launchableDraft({
      days: [day(0, { pool: 'closing', unlockAt: null })],
    });
    const codes = validateEventDraft(draft, NOW).map((i) => i.code);
    expect(codes).toContain('first-unlock-missing');
    expect(codes).not.toContain('day-missing-unlock');
  });

  it('still reports the generic issue for a LATER Day', () => {
    const draft = launchableDraft({
      days: [day(0), day(1, { pool: 'closing', unlockAt: null })],
    });
    const codes = validateEventDraft(draft, NOW).map((i) => i.code);
    expect(codes).toContain('day-missing-unlock');
  });

  it('suppresses the date-mismatch row behind the open-sentinel row', () => {
    const draft = launchableDraft({ days: [day(0, { pool: 'closing', unlockAt: 0 })] });
    const codes = validateEventDraft(draft, NOW).map((i) => i.code);
    expect(codes).toContain('first-unlock-sentinel');
    expect(codes).not.toContain('day-unlock-date-mismatch');
  });
});

describe('the stored timezone must itself be canonical (#787 review)', () => {
  it('rejects a padded zone rather than trimming it', () => {
    // A trimming check would pass, but every CONSUMER receives the padding:
    // Intl rejects it and isoDateInTz falls back to the DEVICE zone, which
    // near a date boundary can make a wrong unlock look correct.
    expect(isSupportedTimezone(' America/Los_Angeles ')).toBe(false);
    expect(isSupportedTimezone('America/Los_Angeles')).toBe(true);
  });

  it('reports it as the unsupported-timezone issue', () => {
    const codes = eventCompletenessIssues(
      launchableDraft({ timezone: ' America/Los_Angeles ' }),
    ).map((i) => i.code);
    expect(codes).toContain('event-unsupported-timezone');
  });
});

describe('Days stay inside the Event window (#787 review)', () => {
  it('rejects a Day stranded outside the window by a later date edit', () => {
    // Both values stay individually valid; only their RELATIONSHIP breaks.
    const draft = launchableDraft({ startsOn: '2026-08-08', endsOn: '2026-08-09' });
    const issues = dayCompletenessIssues(draft).filter(
      (i) => i.code === 'day-outside-event-window',
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });

  it('accepts Days on the window boundaries', () => {
    expect(
      dayCompletenessIssues(launchableDraft()).filter((i) => i.code === 'day-outside-event-window'),
    ).toEqual([]);
  });

  it('stays quiet while the window itself is malformed', () => {
    // One bad window should not also accuse every Day.
    const codes = dayCompletenessIssues(launchableDraft({ startsOn: 'nope' })).map((i) => i.code);
    expect(codes).not.toContain('day-outside-event-window');
  });

  it('stays quiet, per Day, while the window is reversed — that is event-invalid-date-window\'s report alone (#815)', () => {
    // Both dates are individually valid ISO dates; only their ORDER is wrong.
    // Before the fix, every Day also failed day-outside-event-window for the
    // very defect eventCompletenessIssues already reports once.
    const draft = launchableDraft({ startsOn: '2026-08-09', endsOn: '2026-08-07' });
    const dayCodes = dayCompletenessIssues(draft).map((i) => i.code);
    expect(dayCodes).not.toContain('day-outside-event-window');

    const eventCodes = eventCompletenessIssues(draft).map((i) => i.code);
    expect(eventCodes).toContain('event-invalid-date-window');

    // One organizer mistake, one checklist row — not one plus one-per-Day.
    expect(validateEventDraft(draft, NOW).filter((i) => i.code === 'day-outside-event-window')).toEqual(
      [],
    );
  });
});

describe('main-pool spicy must be a real boolean in the launch gate (#787 review)', () => {
  it('rejects a string "true" from an untyped import', () => {
    const draft = launchableDraft({
      prompts: {
        main: [...mainPrompts(31), { text: 'imported', spicy: 'true' } as never],
        easy: curatedPrompts(28, 'easy'),
        closing: curatedPrompts(26, 'closing'),
      },
    });
    const issues = promptPoolIssues(draft).filter(
      (i) => i.code === 'main-prompt-spicy-not-boolean',
    );
    expect(issues).toHaveLength(1);
    expect(isDraftLaunchable(draft, NOW)).toBe(false);
  });

  it('rejects a missing spicy flag', () => {
    const draft = launchableDraft({
      prompts: {
        main: [...mainPrompts(31), { text: 'imported' } as never],
        easy: curatedPrompts(28, 'easy'),
        closing: curatedPrompts(26, 'closing'),
      },
    });
    expect(
      promptPoolIssues(draft).filter((i) => i.code === 'main-prompt-spicy-not-boolean'),
    ).toHaveLength(1);
  });

  it('is silent on a well-formed main pool', () => {
    expect(
      promptPoolIssues(launchableDraft()).filter(
        (i) => i.code === 'main-prompt-spicy-not-boolean',
      ),
    ).toEqual([]);
  });
});

describe('a sparse day schedule reports, never crashes (#787 Phase 4b)', () => {
  it('survives assignedPools, which runs before the gap is reported', () => {
    // assignedPoolIssues composes THIRD in validateEventDraft, so a hole here
    // used to throw on day.pool before dayCompletenessIssues could report it.
    const days: DraftDayDef[] = [];
    days.length = 3;
    days[0] = day(0, { pool: 'easy' });
    days[2] = day(2, { pool: 'closing', date: '2026-08-09' });
    const draft = launchableDraft({ days });

    expect(() => assignedPools(draft)).not.toThrow();
    expect(() => validateEventDraft(draft, NOW)).not.toThrow();
    expect(() => isDraftLaunchable(draft, NOW)).not.toThrow();
    // The real Days still drive the pool set...
    expect(assignedPools(draft).sort()).toEqual(['closing', 'easy']);
    // ...and the gap is reported exactly once, by the predicate that owns it.
    expect(validateEventDraft(draft, NOW).map((i) => i.code)).toContain('day-index-out-of-order');
  });

  it('survives the finale and first-unlock predicates too', () => {
    const days: DraftDayDef[] = [];
    days.length = 2;
    days[1] = day(1, { pool: 'closing' });
    const draft = launchableDraft({ days });
    expect(() => finaleClosingPoolIssues(draft)).not.toThrow();
    expect(() => firstUnlockIssues(draft, NOW)).not.toThrow();
  });
});

describe('the timezone must be a zone the RUNTIME knows (#787 Phase 4b)', () => {
  it('rejects a region-shaped zone that does not exist', () => {
    // normalizeTimezone is a SHAPE rule (region prefix, not UTC/Etc/offset).
    // It happily preserves a fictional zone, after which every consumer falls
    // back to the device zone and the Day-date check can agree by accident.
    expect(isSupportedTimezone('America/Not_A_Zone')).toBe(false);
    expect(isSupportedTimezone('Europe/Atlantis')).toBe(false);
  });

  it('still accepts real IANA zones', () => {
    for (const zone of ['America/Los_Angeles', 'Europe/Rome', 'Australia/Sydney']) {
      expect(isSupportedTimezone(zone)).toBe(true);
    }
  });

  it('reports the fictional zone as the unsupported-timezone issue', () => {
    const issues = eventCompletenessIssues(launchableDraft({ timezone: 'America/Not_A_Zone' }));
    expect(issues.map((i) => i.code)).toContain('event-unsupported-timezone');
  });

  it('does not run the Day-date comparison on an unusable zone', () => {
    // The mismatch check is gated on isSupportedTimezone, so a fictional zone
    // yields ONE issue about the zone rather than a spurious per-Day one.
    const codes = dayCompletenessIssues(
      launchableDraft({ timezone: 'America/Not_A_Zone' }),
    ).map((i) => i.code);
    expect(codes).not.toContain('day-unlock-date-mismatch');
  });
});
