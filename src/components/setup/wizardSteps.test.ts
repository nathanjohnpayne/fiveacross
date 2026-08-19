import { describe, expect, it } from 'vitest';
import type { DraftDayDef, EventDraft, ThemeId } from '../../types';
import { createEventDraft } from '../../data/eventDraft';
import type { DraftIssue, DraftIssueCode } from '../../data/draftValidation';
import {
  SETUP_STEP_ORDER,
  STEP_LABELS,
  STEP_TICKETS,
  draftHasContent,
  firstIncompleteStep,
  isStepComplete,
  issuesForStep,
  stepForIssue,
  stepIndex,
} from './wizardSteps';

// Covers specs/event-setup-wizard.md § "Shell & navigation" — the pure
// classifier and step-completeness helpers behind #788's Continue gating,
// deep-link landing rule and Cancel-confirm gate. No React, no Firebase.

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function mainPrompts(n: number, spicy = false) {
  return Array.from({ length: n }, (_, i) => ({ text: `main ${i}`, spicy }));
}
function curatedPrompts(n: number, label: string) {
  return Array.from({ length: n }, (_, i) => ({ text: `${label} ${i}` }));
}
function unlockOn(date: string, index: number): number {
  return Date.parse(`${date}T13:00:00Z`) + index * 3_600_000;
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

/** A draft that clears every gate this module knows about, so each test can
 *  break exactly one field. Mirrors src/data/draftValidation.test.ts's own
 *  `launchableDraft` fixture. */
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
    days: [day(0, { pool: 'easy' }), day(1), day(2, { pool: 'closing', tutorial: true })],
    ...over,
  };
}

describe('SETUP_STEP_ORDER / STEP_LABELS / STEP_TICKETS', () => {
  it('lists the five frames in frame order', () => {
    expect(SETUP_STEP_ORDER).toEqual(['occasion', 'basics', 'squares', 'look', 'launch']);
  });

  it('labels and ticket-numbers every step, matching the registry order', () => {
    for (const step of SETUP_STEP_ORDER) {
      expect(typeof STEP_LABELS[step]).toBe('string');
    }
    // Steps 1-4 and Launch map to #789–#792 / #794 (epic #786); the
    // provisioner (#793) and preview strip (#795) are shared components, not
    // steps, so they are deliberately absent from this map.
    expect(STEP_TICKETS).toEqual({ occasion: 789, basics: 790, squares: 791, look: 792, launch: 794 });
  });

  it('gives every step a unique, contiguous index', () => {
    expect(SETUP_STEP_ORDER.map(stepIndex)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('stepForIssue (data ownership, not layout)', () => {
  // Compile-time exhaustiveness over DraftIssueCode is enforced by the `never`
  // arm in wizardSteps.ts itself (tsc fails a build that adds a code here
  // without updating that switch). These are spot checks for correctness,
  // covering every code at least once so a wrong mapping still fails a test
  // even on a change that keeps `tsc` green.
  const cases: [DraftIssueCode, ReturnType<typeof stepForIssue>][] = [
    ['event-occasion-edition-mismatch', 'occasion'],
    ['event-unsupported-timezone', 'basics'],
    ['event-invalid-date-window', 'basics'],
    ['event-invalid-slug', 'basics'],
    ['pool-below-minimum', 'squares'],
    ['main-prompt-spicy-not-boolean', 'squares'],
    ['curated-prompt-is-spicy', 'squares'],
    ['prompt-text-out-of-bounds', 'squares'],
    ['too-many-days', 'squares'],
    ['no-days', 'squares'],
    ['one-card-has-days', 'squares'],
    ['no-closing-day', 'squares'],
    ['extra-closing-day', 'squares'],
    ['first-unlock-missing', 'look'],
    ['first-unlock-sentinel', 'look'],
    ['first-unlock-past', 'look'],
    ['day-index-out-of-order', 'look'],
    ['day-missing-place', 'look'],
    ['day-missing-theme', 'look'],
    ['day-unregistered-theme', 'look'],
    ['day-off-edition-theme', 'look'],
    ['day-missing-unlock', 'look'],
    ['day-missing-date', 'look'],
    ['day-invalid-date', 'look'],
    ['day-unlock-date-mismatch', 'look'],
    ['day-blank-free-text', 'look'],
    ['day-outside-event-window', 'look'],
    ['day-tonight-not-two', 'look'],
    ['setting-out-of-range', 'look'],
    ['event-unregistered-theme', 'look'],
    ['event-off-edition-theme', 'look'],
  ];

  it.each(cases)('classifies %s under the %s step', (code, expected) => {
    const issue: DraftIssue = { code, message: 'x' };
    expect(stepForIssue(issue)).toBe(expected);
  });

  it('disambiguates event-missing-field by which field is missing', () => {
    expect(stepForIssue({ code: 'event-missing-field', field: 'occasion', message: 'x' })).toBe('occasion');
    expect(stepForIssue({ code: 'event-missing-field', field: 'defaultTheme', message: 'x' })).toBe('look');
    for (const field of ['name', 'startsOn', 'endsOn', 'timezone', 'slugCandidate']) {
      expect(stepForIssue({ code: 'event-missing-field', field, message: 'x' })).toBe('basics');
    }
  });
});

describe('issuesForStep / isStepComplete', () => {
  it('a bare draft is incomplete on occasion, reporting exactly the occasion-missing issue there', () => {
    const draft = createEventDraft({ now: NOW });
    expect(isStepComplete('occasion', draft, NOW)).toBe(false);
    const issues = issuesForStep('occasion', draft, NOW);
    expect(issues.map((i) => i.code)).toContain('event-missing-field');
    expect(issues.every((i) => i.field === undefined || i.field === 'occasion')).toBe(true);
  });

  it('a fully launchable draft clears every step, including launch', () => {
    const draft = launchableDraft();
    for (const step of SETUP_STEP_ORDER) {
      expect(isStepComplete(step, draft, NOW)).toBe(true);
    }
  });

  it('a pool-below-minimum issue blocks squares only, leaving occasion/basics clear', () => {
    const draft = launchableDraft({ prompts: { main: mainPrompts(10), easy: curatedPrompts(28, 'e'), closing: curatedPrompts(26, 'c') } });
    expect(isStepComplete('occasion', draft, NOW)).toBe(true);
    expect(isStepComplete('basics', draft, NOW)).toBe(true);
    expect(isStepComplete('squares', draft, NOW)).toBe(false);
    expect(issuesForStep('squares', draft, NOW).map((i) => i.code)).toContain('pool-below-minimum');
  });

  it('an out-of-range setting blocks look, not squares', () => {
    const draft = launchableDraft({ settings: { ...launchableDraft().settings, easyMixRatio: 1.5 } });
    expect(isStepComplete('squares', draft, NOW)).toBe(true);
    expect(isStepComplete('look', draft, NOW)).toBe(false);
  });

  it('launch completeness is the FULL launch gate, not a per-code bucket', () => {
    // Break a field that maps to 'basics'; launch must also read incomplete —
    // it is not an independent bucket that happens to stay empty.
    const draft = launchableDraft({ name: '' });
    expect(isStepComplete('basics', draft, NOW)).toBe(false);
    expect(isStepComplete('launch', draft, NOW)).toBe(false);
  });
});

describe('firstIncompleteStep', () => {
  it('lands on occasion for a brand-new draft', () => {
    expect(firstIncompleteStep(createEventDraft({ now: NOW }), NOW)).toBe('occasion');
  });

  it('lands on basics once occasion is answered', () => {
    const draft = { ...createEventDraft({ now: NOW }), occasion: 'weekend-away', edition: 'vacay' } as EventDraft;
    expect(firstIncompleteStep(draft, NOW)).toBe('basics');
  });

  it('lands on launch once every earlier step clears', () => {
    expect(firstIncompleteStep(launchableDraft(), NOW)).toBe('launch');
  });

  it('skips over an already-complete step to the next incomplete one', () => {
    // occasion + basics complete, squares incomplete (short pool), look untouched.
    const draft = launchableDraft({ prompts: { main: mainPrompts(1), easy: curatedPrompts(28, 'e'), closing: curatedPrompts(26, 'c') } });
    expect(firstIncompleteStep(draft, NOW)).toBe('squares');
  });
});

describe('draftHasContent', () => {
  it('a brand-new draft is empty', () => {
    expect(draftHasContent(createEventDraft({ now: NOW }))).toBe(false);
  });

  it('picking an occasion alone counts as content', () => {
    const draft = { ...createEventDraft({ now: NOW }), occasion: 'custom' } as EventDraft;
    expect(draftHasContent(draft)).toBe(true);
  });

  it('typing a name alone counts as content', () => {
    const draft = { ...createEventDraft({ now: NOW }), name: 'Weekend in Point Reyes' };
    expect(draftHasContent(draft)).toBe(true);
  });

  it('a fully launchable draft counts as content', () => {
    expect(draftHasContent(launchableDraft())).toBe(true);
  });

  it('the device-timezone suggestion and bare settings alone do not count as content', () => {
    // createEventDraft seeds a timezone suggestion and default settings even
    // on a "brand new" draft — neither is something the organizer entered.
    const draft = createEventDraft({ now: NOW, timezone: 'America/Los_Angeles' });
    expect(draftHasContent(draft)).toBe(false);
  });
});
