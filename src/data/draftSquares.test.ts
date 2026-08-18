import { describe, expect, it } from 'vitest';
import type { DraftDayDef, EventDraft, OccasionId } from '../types';
import { MIN_POOL } from '../game/logic';
import { createEventDraft } from './eventDraft';
import {
  MAX_DAYS,
  assignedPoolIssues,
  dayCountIssues,
  finaleClosingPoolIssues,
  promptPoolIssues,
  promptTextIssues,
} from './draftValidation';
import {
  addDay,
  addPrompt,
  canAddDay,
  duplicatePromptTexts,
  poolCounts,
  removeDay,
  removePrompt,
  seedPack,
  setCardFormat,
  setDayPool,
  setDayTutorial,
  setMainPromptSpicy,
  setPromptText,
} from './draftSquares';
import type { StarterPack } from './starterPacks';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function draftWith(over: Partial<EventDraft> = {}): EventDraft {
  return {
    ...createEventDraft({ now: NOW, draftId: 'draft-1', timezone: 'America/Los_Angeles' }),
    ...over,
  };
}

function day(index: number, over: Partial<DraftDayDef> = {}): DraftDayDef {
  return {
    index,
    date: '2026-08-07',
    unlockAt: null,
    place: '',
    placeEmoji: '',
    theme: null,
    pool: 'main',
    tutorial: false,
    tonight: [],
    ...over,
  };
}

describe('setCardFormat', () => {
  it('clears the schedule when switching to one card, because a one-card Event IS an empty days[]', () => {
    const before = draftWith({ cardFormat: 'daily_cards', days: [day(0), day(1, { pool: 'closing' })] });
    const after = setCardFormat(before, 'one_card');
    expect(after.cardFormat).toBe('one_card');
    expect(after.days).toEqual([]);
    // The whole point of clearing: a one-card draft carrying Days fails the
    // gate and no Day-authoring surface is reachable to delete them.
    expect(dayCountIssues(after)).toEqual([]);
    expect(dayCountIssues({ ...before, cardFormat: 'one_card' }).map((i) => i.code)).toEqual([
      'one-card-has-days',
    ]);
  });

  it("proposes the occasion's schedule SHAPE — pools and tutorial flags, never unlock instants", () => {
    const before = draftWith({ occasion: 'weekend-away', cardFormat: 'one_card', days: [] });
    const after = setCardFormat(before, 'daily_cards');
    // Weekend away: 4 Days, easy opener that COUNTS, closing finale.
    expect(after.days.map((d) => d.pool)).toEqual(['easy', 'main', 'main', 'closing']);
    expect(after.days.map((d) => d.tutorial)).toEqual([false, false, false, true]);
    expect(after.days.map((d) => d.index)).toEqual([0, 1, 2, 3]);
    // Step 4's fields are left for Step 4 — no clock was borrowed here.
    expect(after.days.every((d) => d.unlockAt === null)).toBe(true);
    expect(after.days.every((d) => d.theme === null)).toBe(true);
    // A per-Day Free Space override must be ABSENT, never `''`: a present
    // empty string suppresses the FREE_TEXT fallback and deals a blank centre.
    expect(after.days.every((d) => d.freeText === undefined)).toBe(true);
  });

  it('proposes NO Days for an occasion whose schedule is null, rather than inventing one', () => {
    const after = setCardFormat(
      draftWith({ occasion: 'custom', cardFormat: 'one_card', days: [] }),
      'daily_cards',
    );
    expect(after.days).toEqual([]);
    // Not a silent state — the shared gate reports it and "Add a Day" is next to it.
    expect(dayCountIssues(after).map((i) => i.code)).toEqual(['no-days']);
  });

  it('keeps an already-authored schedule when switching back to daily cards', () => {
    const authored = [day(0, { place: 'Point Reyes' }), day(1, { pool: 'closing' })];
    const before = draftWith({ occasion: 'weekend-away', cardFormat: 'daily_cards', days: authored });
    // A no-op returns the same draft rather than rebuilding it.
    expect(setCardFormat(before, 'daily_cards')).toBe(before);
  });
});

describe('the ten-Day ceiling', () => {
  const tenDays = Array.from({ length: MAX_DAYS }, (_unused, i) => day(i));

  it('refuses an eleventh Day rather than creating one the schedule lock cannot cover', () => {
    const full = draftWith({ cardFormat: 'daily_cards', days: tenDays });
    expect(canAddDay(full)).toBe(false);
    expect(addDay(full)).toBe(full);
    expect(full.days).toHaveLength(MAX_DAYS);
  });

  it('allows the tenth', () => {
    const nine = draftWith({ cardFormat: 'daily_cards', days: tenDays.slice(0, MAX_DAYS - 1) });
    expect(canAddDay(nine)).toBe(true);
    expect(addDay(nine).days).toHaveLength(MAX_DAYS);
  });

  it('never applies to a one-card draft, which has no Days to add to', () => {
    expect(canAddDay(draftWith({ cardFormat: 'one_card', days: [] }))).toBe(false);
  });
});

describe('addDay / removeDay', () => {
  it('appends a main-pool Day that counts, and moves NOTHING else', () => {
    const before = draftWith({
      cardFormat: 'daily_cards',
      days: [day(0), day(1, { pool: 'closing', tutorial: true })],
    });
    const after = addDay(before);
    expect(after.days).toHaveLength(3);
    expect(after.days[2]).toMatchObject({ index: 2, pool: 'main', tutorial: false });
    // The closing pool is NOT lifted off Day 2 onto the new final Day.
    // Silently reassigning a pool the organizer chose is the "looked
    // honoured, silently changed" failure #785 catalogues; both predicates
    // fire instead and each names its own Day.
    expect(after.days[1]!.pool).toBe('closing');
    const codes = finaleClosingPoolIssues(after).map((i) => i.code);
    expect(codes).toContain('no-closing-day');
    expect(codes).toContain('extra-closing-day');
    expect(finaleClosingPoolIssues(after).find((i) => i.code === 'extra-closing-day')?.dayIndex).toBe(1);
  });

  it('renumbers after a removal so days[position].index === position still holds', () => {
    const before = draftWith({
      cardFormat: 'daily_cards',
      days: [day(0, { place: 'a' }), day(1, { place: 'b' }), day(2, { place: 'c' })],
    });
    const after = removeDay(before, 1);
    expect(after.days.map((d) => d.place)).toEqual(['a', 'c']);
    expect(after.days.map((d) => d.index)).toEqual([0, 1]);
  });

  it('removes the Day at the requested STORED position even when earlier holes shift it', () => {
    const sparse: DraftDayDef[] = [day(0, { place: 'a' }), day(1, { place: 'b' })];
    // A hole at position 1, so 'b' sits at stored position 2.
    const holed = [sparse[0]!, , sparse[1]!] as unknown as DraftDayDef[];
    const after = removeDay(draftWith({ cardFormat: 'daily_cards', days: holed }), 2);
    expect(after.days.map((d) => d.place)).toEqual(['a']);
    expect(after.days.map((d) => d.index)).toEqual([0]);
  });

  it('compacts a hole out rather than leaving a draft that cannot persist', () => {
    const holed = [day(0), , day(1)] as unknown as DraftDayDef[];
    const after = removeDay(draftWith({ cardFormat: 'daily_cards', days: holed }), 0);
    expect(after.days).toHaveLength(1);
    expect(Object.keys(after.days)).toEqual(['0']);
  });
});

describe('pool and tutorial are independent, in both directions', () => {
  it('setDayPool leaves tutorial exactly as it found it', () => {
    const before = draftWith({
      cardFormat: 'daily_cards',
      days: [day(0, { pool: 'easy', tutorial: false })],
    });
    const after = setDayPool(before, 0, 'closing');
    expect(after.days[0]).toMatchObject({ pool: 'closing', tutorial: false });
  });

  it("setDayTutorial on an easy-pool Day records tutorial: false — the pool did not decide it", () => {
    const before = draftWith({
      cardFormat: 'daily_cards',
      days: [day(0, { pool: 'easy', tutorial: true })],
    });
    const after = setDayTutorial(before, 0, false);
    expect(after.days[0]).toMatchObject({ pool: 'easy', tutorial: false });
  });

  it('supports two Days on one date rather than collapsing them', () => {
    // Bodega's Sunday: a competitive main Day and a closing wrap-up, same date.
    const before = draftWith({
      cardFormat: 'daily_cards',
      days: [
        day(0, { date: '2026-08-08' }),
        day(1, { date: '2026-08-09', pool: 'main' }),
        day(2, { date: '2026-08-09', pool: 'main' }),
      ],
    });
    const after = setDayPool(setDayTutorial(before, 2, true), 2, 'closing');
    expect(after.days).toHaveLength(3);
    expect(after.days.map((d) => d.date)).toEqual(['2026-08-08', '2026-08-09', '2026-08-09']);
    // The competitive Day on that same date is untouched and still counts.
    expect(after.days[1]).toMatchObject({ date: '2026-08-09', pool: 'main', tutorial: false });
    expect(after.days[2]).toMatchObject({ date: '2026-08-09', pool: 'closing', tutorial: true });
    expect(finaleClosingPoolIssues(after)).toEqual([]);
  });
});

describe('prompt CRUD', () => {
  it('carries spicy on a main add and makes it unrepresentable on a curated one', () => {
    const withMain = addPrompt(draftWith(), 'main', 'Karaoke duet', true);
    expect(withMain.prompts.main).toEqual([{ text: 'Karaoke duet', spicy: true }]);

    // Even asked for explicitly, spicy is dropped for easy/closing — the flag
    // would be silently de-flagged downstream, serving an explicit Square with
    // no 18+ gate (#785). Asserted as an absent KEY, since `promptPoolIssues`
    // tests the value and `JSON.stringify` drops an undefined one.
    const withEasy = addPrompt(draftWith(), 'easy', 'Windblown group selfie', true);
    expect(withEasy.prompts.easy).toEqual([{ text: 'Windblown group selfie' }]);
    expect('spicy' in withEasy.prompts.easy[0]!).toBe(false);
    expect(promptPoolIssues(withEasy)).toEqual([]);
  });

  it('stores trimmed text, because firestore.rules measures the value as persisted', () => {
    const eighty = 'x'.repeat(80);
    const after = addPrompt(draftWith(), 'main', `  ${eighty}  `, false);
    expect(after.prompts.main[0]!.text).toHaveLength(80);
    expect(promptTextIssues(after)).toEqual([]);
  });

  it('refuses a blank add and a blank rename rather than storing an unrepairable Square', () => {
    const blank = draftWith();
    expect(addPrompt(blank, 'main', '   ', false)).toBe(blank);
    const one = addPrompt(blank, 'main', 'Real prompt', false);
    expect(setPromptText(one, 'main', 0, '  ')).toBe(one);
  });

  it('renames and re-flags by position', () => {
    let d = addPrompt(addPrompt(draftWith(), 'main', 'one', false), 'main', 'two', false);
    d = setPromptText(d, 'main', 1, 'two edited');
    d = setMainPromptSpicy(d, 0, true);
    expect(d.prompts.main).toEqual([
      { text: 'one', spicy: true },
      { text: 'two edited', spicy: false },
    ]);
  });

  it('removes by position and leaves the rest in order', () => {
    let d = draftWith();
    for (const text of ['a', 'b', 'c']) d = addPrompt(d, 'closing', text, false);
    expect(removePrompt(d, 'closing', 1).prompts.closing).toEqual([{ text: 'a' }, { text: 'c' }]);
  });
});

describe('sparse pools', () => {
  /** A pool of nominal length 3 holding two real entries at positions 0 and 2. */
  function holedMain() {
    return [{ text: 'a', spicy: false }, , { text: 'c', spicy: false }] as unknown as {
      text: string;
      spicy: boolean;
    }[];
  }

  it('counts REAL entries, so the number shown matches the number the gate judges', () => {
    const d = draftWith({ prompts: { main: holedMain(), easy: [], closing: [] } });
    expect(d.prompts.main).toHaveLength(3);
    expect(poolCounts(d).main).toBe(2);
  });

  it('excludes an EXPLICIT null the same way it excludes a hole', () => {
    // `filter` drops holes but keeps an explicit null, and the two are the
    // same missing Prompt to `promptTextIssues` and to the repair UI. Counting
    // one let a 24-slot pool holding 23 usable Prompts read as passing (Codex
    // P2, PR #856, round 2).
    const withNull = [
      { text: 'a', spicy: false },
      null,
      { text: 'c', spicy: false },
    ] as unknown as { text: string; spicy: boolean }[];
    const d = draftWith({
      cardFormat: 'daily_cards',
      days: [day(0, { pool: 'main' })],
      prompts: { main: withNull, easy: [], closing: [] },
    });
    expect(poolCounts(d).main).toBe(2);
    expect(assignedPoolIssues(d)[0]?.message).toContain('has 2 Prompts');
    expect(promptTextIssues(d).map((i) => i.code)).toEqual(['prompt-text-out-of-bounds']);
  });

  it('addresses the entry at the STORED position, holes included', () => {
    const d = draftWith({ prompts: { main: holedMain(), easy: [], closing: [] } });
    // 'c' is at stored position 2, not at dense position 1.
    expect(setPromptText(d, 'main', 2, 'c edited').prompts.main).toEqual([
      { text: 'a', spicy: false },
      { text: 'c edited', spicy: false },
    ]);
  });

  it('compacts holes out on any edit, so the draft can persist again', () => {
    const d = draftWith({ prompts: { main: holedMain(), easy: [], closing: [] } });
    // Before: the gap is reported and a save/load round trip would reject it.
    expect(promptTextIssues(d).map((i) => i.code)).toEqual(['prompt-text-out-of-bounds']);
    const repaired = removePrompt(d, 'main', 0);
    expect(repaired.prompts.main).toEqual([{ text: 'c', spicy: false }]);
    expect(Object.keys(repaired.prompts.main)).toEqual(['0']);
    expect(promptTextIssues(repaired)).toEqual([]);
  });

  it('compacts an EXPLICIT missing entry when adding, so the new Prompt actually persists', () => {
    // The sharp version: `addPrompt` compacts through `densePrompts`, and a
    // `filter(() => true)` there kept an explicit null — so `parseEventDraft`
    // refused the serialized draft, `save` kept the previous blob, and the
    // newly added Prompt vanished on the next load (Codex P2, round 3).
    const withNull = [
      { text: 'a', spicy: false },
      null,
    ] as unknown as { text: string; spicy: boolean }[];
    const after = addPrompt(draftWith({ prompts: { main: withNull, easy: [], closing: [] } }), 'main', 'brand new', false);
    expect(after.prompts.main).toEqual([
      { text: 'a', spicy: false },
      { text: 'brand new', spicy: false },
    ]);
    // The gate agrees the draft is clean, which is what makes it storable.
    expect(promptTextIssues(after)).toEqual([]);
  });

  it('compacts EVERY pool on an edit, not just the one being edited', () => {
    // Storability is a property of the whole draft: a gap left in another
    // pool means this edit, and every edit after it, silently stops
    // persisting (Codex P2, round 4).
    const withNull = [{ text: 'c1' }, null] as unknown as { text: string }[];
    const d = draftWith({
      prompts: { main: [{ text: 'm1', spicy: false }], easy: holedMain() as never, closing: withNull },
    });
    const after = setPromptText(d, 'main', 0, 'renamed');
    expect(after.prompts.main).toEqual([{ text: 'renamed', spicy: false }]);
    expect(after.prompts.easy).toEqual([{ text: 'a', spicy: false }, { text: 'c', spicy: false }]);
    expect(after.prompts.closing).toEqual([{ text: 'c1' }]);
    expect(promptTextIssues(after)).toEqual([]);
  });

  it('never dereferences a hole while producing the per-pool verdict', () => {
    const d = draftWith({
      cardFormat: 'daily_cards',
      days: [day(0, { pool: 'closing' })],
      prompts: { main: [], easy: [], closing: holedMain() as never },
    });
    expect(() => assignedPoolIssues(d)).not.toThrow();
    expect(assignedPoolIssues(d)[0]?.message).toContain(`has 2 Prompts`);
  });
});

describe('seedPack', () => {
  const pack: StarterPack = {
    id: 'coastal',
    label: 'Coastal weekend pack',
    emoji: '🌊',
    prompts: {
      main: [{ text: 'Chimney Rock viewpoint', spicy: false }],
      easy: [{ text: 'Windblown group selfie' }],
      closing: [{ text: "Say the thing you'll actually miss" }],
    },
  };

  it('replaces every pool', () => {
    const before = addPrompt(draftWith(), 'main', 'my own', false);
    const after = seedPack(before, pack);
    expect(after.prompts.main).toEqual([{ text: 'Chimney Rock viewpoint', spicy: false }]);
    expect(poolCounts(after)).toEqual({ main: 1, easy: 1, closing: 1 });
  });

  it('copies rather than aliases, so editing one draft cannot rewrite the shared table', () => {
    const seeded = seedPack(draftWith(), pack);
    const edited = setPromptText(seeded, 'main', 0, 'edited in this draft');
    expect(pack.prompts.main[0]!.text).toBe('Chimney Rock viewpoint');
    expect(seeded.prompts.main).not.toBe(edited.prompts.main);
    // A second draft seeded afterwards still gets the pack's own copy.
    expect(seedPack(draftWith(), pack).prompts.main[0]!.text).toBe('Chimney Rock viewpoint');
  });
});

describe('the per-pool minimum, through these transforms', () => {
  it('fails the closing pool BY NAME on a 62-total pack with 4 closing Prompts', () => {
    let d = draftWith({
      cardFormat: 'daily_cards',
      days: [day(0, { pool: 'main' }), day(1, { pool: 'closing' })],
      prompts: { main: [], easy: [], closing: [] },
    });
    for (let i = 0; i < 58; i++) d = addPrompt(d, 'main', `main ${i}`, false);
    for (let i = 0; i < 4; i++) d = addPrompt(d, 'closing', `closing ${i}`, false);
    const counts = poolCounts(d);
    expect(counts.main + counts.easy + counts.closing).toBe(62);

    const issues = assignedPoolIssues(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.pool).toBe('closing');
    expect(issues[0]!.message).toContain('closing');
    expect(issues[0]!.message).toContain(String(MIN_POOL));
  });

  it('ignores a pool no Day deals from — an idle pool is not a passing one', () => {
    const d = draftWith({
      cardFormat: 'daily_cards',
      days: [day(0, { pool: 'closing' })],
      prompts: {
        main: [],
        easy: [],
        closing: Array.from({ length: MIN_POOL }, (_unused, i) => ({ text: `c${i}` })),
      },
    });
    expect(assignedPoolIssues(d)).toEqual([]);
    expect(poolCounts(d).main).toBe(0);
  });
});

describe('duplicatePromptTexts', () => {
  it('reports a repeat once, per pool, ignoring case and surrounding space', () => {
    const d = draftWith({
      prompts: {
        main: [
          { text: 'Karaoke duet', spicy: false },
          { text: '  karaoke DUET ', spicy: false },
          { text: 'Karaoke duet', spicy: false },
          { text: 'Something else', spicy: false },
        ],
        easy: [{ text: 'Selfie' }, { text: 'Selfie' }],
        closing: [{ text: 'Unique' }],
      },
    });
    expect(duplicatePromptTexts(d)).toEqual({
      main: ['Karaoke duet'],
      easy: ['Selfie'],
      closing: [],
    });
  });

  it('is advisory only — a duplicated pool still clears the shared launch gate', () => {
    const repeated = Array.from({ length: MIN_POOL }, () => ({ text: 'The same square' }));
    const d = draftWith({
      cardFormat: 'daily_cards',
      days: [day(0, { pool: 'closing' })],
      prompts: { main: [], easy: [], closing: repeated },
    });
    expect(duplicatePromptTexts(d).closing).toEqual(['The same square']);
    // Nothing downstream breaks, so it is not a DraftIssue and does not block.
    expect(assignedPoolIssues(d)).toEqual([]);
    expect(promptTextIssues(d)).toEqual([]);
  });

  it('steps over holes and non-string text rather than throwing', () => {
    const holed = [{ text: 'a' }, , { text: 'a' }] as unknown as { text: string }[];
    const d = draftWith({ prompts: { main: [], easy: holed, closing: [] } });
    expect(() => duplicatePromptTexts(d)).not.toThrow();
    expect(duplicatePromptTexts(d).easy).toEqual(['a']);
  });
});

describe('occasion coverage', () => {
  it.each<[OccasionId, number]>([
    ['weekend-away', 4],
    ['city-break', 3],
    ['conference', 3],
    ['cruise', 7],
  ])('builds %s with %i contiguous Days ending on the closing pool', (occasion, count) => {
    const after = setCardFormat(
      draftWith({ occasion, cardFormat: 'one_card', days: [] }),
      'daily_cards',
    );
    expect(after.days).toHaveLength(count);
    expect(after.days.map((d) => d.index)).toEqual(Array.from({ length: count }, (_u, i) => i));
    expect(finaleClosingPoolIssues(after)).toEqual([]);
    expect(dayCountIssues(after)).toEqual([]);
  });
});
