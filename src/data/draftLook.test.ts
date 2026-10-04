import { describe, expect, it } from 'vitest';
import type { DraftDayDef, EventDraft, ThemeId } from '../types';
import { createEventDraft } from './eventDraft';
import { applyOccasionDefaults, occasionById } from './occasions';
import { setCardFormat } from './draftSquares';
import { dayCompletenessIssues, firstUnlockIssues } from './draftValidation';
import {
  FALLBACK_UNLOCK_TIME,
  applyProposedDayThemes,
  dayUnlockTime,
  defaultUnlockTime,
  proposedDayTheme,
  setDayDate,
  setDayFreeText,
  setDayPlace,
  setDayPlaceEmoji,
  setDayTheme,
  setDayTonight,
  setDayUnlockTime,
  setDefaultTheme,
  setEasyMixRatio,
} from './draftLook';
import { isoDateInTz, isoTimeInTz } from './tzDate';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const LA = 'America/Los_Angeles';

function bare(over: Partial<EventDraft> = {}): EventDraft {
  return {
    ...createEventDraft({ now: NOW, draftId: 'draft-1', timezone: LA }),
    ...over,
  };
}

/** A Weekend-away draft whose Step 3 proposed its four-Day shape. */
function weekendAway(over: Partial<EventDraft> = {}): EventDraft {
  const occasion = occasionById('weekend-away');
  if (!occasion) throw new Error('weekend-away missing from the matrix');
  const picked = applyOccasionDefaults(bare(), occasion);
  // Round-trip through one card so `setCardFormat` proposes the occasion's
  // schedule shape, exactly as Step 3 would.
  const shaped = setCardFormat(setCardFormat(picked, 'one_card'), 'daily_cards');
  return { ...shaped, startsOn: '2026-08-06', endsOn: '2026-08-09', ...over };
}

function day(index: number, over: Partial<DraftDayDef> = {}): DraftDayDef {
  return {
    index,
    date: '',
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

describe('defaultUnlockTime', () => {
  it("uses the occasion's unlockTime, else 06:00", () => {
    expect(defaultUnlockTime(weekendAway())).toBe(occasionById('weekend-away')?.defaults.schedule?.unlockTime);
    expect(defaultUnlockTime(bare({ occasion: 'custom' }))).toBe(FALLBACK_UNLOCK_TIME);
    expect(defaultUnlockTime(bare({ occasion: null }))).toBe(FALLBACK_UNLOCK_TIME);
    expect(FALLBACK_UNLOCK_TIME).toBe('06:00');
  });
});

describe('setDayDate / setDayUnlockTime', () => {
  it('stores an unlockAt that formats back to the same date and default time in the draft zone', () => {
    const after = setDayDate(weekendAway(), 0, '2026-08-06');
    const first = after.days[0];
    expect(first.date).toBe('2026-08-06');
    expect(first.unlockAt).toBe(Date.UTC(2026, 7, 6, 13, 0));
    expect(isoDateInTz(first.unlockAt as number, LA)).toBe('2026-08-06');
    expect(isoTimeInTz(first.unlockAt as number, LA)).toBe('06:00');
  });

  it('keeps a Day’s own time when it is re-dated, and its own date when it is re-timed', () => {
    const timed = setDayUnlockTime(setDayDate(weekendAway(), 3, '2026-08-09'), 3, '11:00');
    expect(dayUnlockTime(timed, timed.days[3])).toBe('11:00');
    const moved = setDayDate(timed, 3, '2026-08-08');
    expect(moved.days[3].date).toBe('2026-08-08');
    expect(dayUnlockTime(moved, moved.days[3])).toBe('11:00');
    expect(isoDateInTz(moved.days[3].unlockAt as number, LA)).toBe('2026-08-08');
  });

  it('round-trips on a spring-forward date, and moves a skipped time forward by the gap', () => {
    const base = weekendAway({ startsOn: '2026-03-06', endsOn: '2026-03-09' });
    const dated = setDayDate(base, 0, '2026-03-08');
    expect(isoTimeInTz(dated.days[0].unlockAt as number, LA)).toBe('06:00');
    expect(isoDateInTz(dated.days[0].unlockAt as number, LA)).toBe('2026-03-08');
    const skipped = setDayUnlockTime(dated, 0, '02:30');
    expect(dayUnlockTime(skipped, skipped.days[0])).toBe('03:30');
    expect(dayCompletenessIssues(skipped).filter((i) => i.code === 'day-unlock-date-mismatch')).toEqual([]);
  });

  it('round-trips on a fall-back date, taking the first of a repeated time', () => {
    const base = weekendAway({ startsOn: '2026-10-30', endsOn: '2026-11-02' });
    const repeated = setDayUnlockTime(setDayDate(base, 0, '2026-11-01'), 0, '01:30');
    expect(repeated.days[0].unlockAt).toBe(Date.UTC(2026, 10, 1, 8, 30));
    expect(dayUnlockTime(repeated, repeated.days[0])).toBe('01:30');
    expect(isoDateInTz(repeated.days[0].unlockAt as number, LA)).toBe('2026-11-01');
  });

  it('refuses a malformed date or time, an undated Day, an unusable zone, or a missing Day — by identity', () => {
    const draft = weekendAway();
    expect(setDayDate(draft, 0, '2026-02-30')).toBe(draft);
    expect(setDayDate(draft, 0, '')).toBe(draft);
    expect(setDayDate(draft, 9, '2026-08-06')).toBe(draft);
    // Day 0 has no date yet, so there is no calendar day to put a time on.
    expect(setDayUnlockTime(draft, 0, '07:00')).toBe(draft);
    const dated = setDayDate(draft, 0, '2026-08-06');
    expect(setDayUnlockTime(dated, 0, '7:00')).toBe(dated);
    expect(setDayUnlockTime(dated, 0, '24:00')).toBe(dated);
    // `UTC` is refused by the read-side contract; computing an instant in it
    // would launch a schedule `eventConverter` re-reads at Rome wall-clock.
    const utc = { ...dated, timezone: 'UTC' };
    expect(setDayUnlockTime(utc, 0, '07:00')).toBe(utc);
    expect(setDayDate(utc, 0, '2026-08-07')).toBe(utc);
  });

  it('returns the draft by identity when nothing would change', () => {
    const dated = setDayDate(weekendAway(), 0, '2026-08-06');
    expect(setDayDate(dated, 0, '2026-08-06')).toBe(dated);
    expect(setDayUnlockTime(dated, 0, '06:00')).toBe(dated);
  });

  it('reads the default time for a Day with no unlock or the open sentinel', () => {
    const draft = weekendAway();
    expect(dayUnlockTime(draft, draft.days[0])).toBe('06:00');
    expect(dayUnlockTime(draft, { ...draft.days[0], unlockAt: 0 })).toBe('06:00');
  });
});

describe('themes', () => {
  it('refuses a Day or default Theme outside themesForEdition(draft.edition)', () => {
    const draft = weekendAway();
    // `marquee` is registered, but for the fiveacross Edition, not vacay.
    expect(setDayTheme(draft, 0, 'marquee')).toBe(draft);
    expect(setDayTheme(draft, 0, 'not-a-theme' as ThemeId)).toBe(draft);
    expect(setDefaultTheme(draft, 'marquee')).toBe(draft);
    expect(setDefaultTheme(draft, 'not-a-theme' as ThemeId)).toBe(draft);
  });

  it('accepts an Edition Theme, and is a no-op when it is already set', () => {
    const themed = setDayTheme(weekendAway(), 1, 'side-quests');
    expect(themed.days[1].theme).toBe('side-quests');
    expect(setDayTheme(themed, 1, 'side-quests')).toBe(themed);
    const defaulted = setDefaultTheme(themed, 'side-quests');
    expect(defaulted.defaultTheme).toBe('side-quests');
    expect(setDefaultTheme(defaulted, 'side-quests')).toBe(defaulted);
  });

  it("proposes the occasion's dayThemes in order, repeating the tail past the end of the list", () => {
    const draft = weekendAway();
    expect([0, 1, 2, 3].map((position) => proposedDayTheme(draft, position))).toEqual([
      'the-birds',
      'side-quests',
      'fog-froth-farewells',
      'fog-froth-farewells',
    ]);
    expect(proposedDayTheme(bare({ occasion: 'custom' }), 0)).toBeNull();
  });

  it('applies the proposal only to unthemed Days, never over an organizer choice', () => {
    const chosen = setDayTheme(weekendAway(), 0, 'side-quests');
    const proposed = applyProposedDayThemes(chosen);
    expect(proposed.days.map((d) => d.theme)).toEqual([
      'side-quests',
      'side-quests',
      'fog-froth-farewells',
      'fog-froth-farewells',
    ]);
    expect(applyProposedDayThemes(proposed)).toBe(proposed);
    const custom = bare({ occasion: 'custom', cardFormat: 'daily_cards', days: [day(0)] });
    expect(applyProposedDayThemes(custom)).toBe(custom);
  });
});

describe('place, tonight and Free Space', () => {
  it('stores place and emoji as typed, so a trailing space mid-word survives', () => {
    const typed = setDayPlaceEmoji(setDayPlace(weekendAway(), 0, 'Bodega '), 0, '🌊');
    expect(typed.days[0].place).toBe('Bodega ');
    expect(typed.days[0].placeEmoji).toBe('🌊');
    expect(setDayPlace(typed, 0, 'Bodega ')).toBe(typed);
    expect(setDayPlaceEmoji(typed, 0, '🌊')).toBe(typed);
  });

  it('always holds exactly two tonight entries', () => {
    const first = setDayTonight(weekendAway(), 0, 0, 'Sunset at the dock');
    expect(first.days[0].tonight).toEqual(['Sunset at the dock', '']);
    const second = setDayTonight(first, 0, 1, 'Karaoke');
    expect(second.days[0].tonight).toEqual(['Sunset at the dock', 'Karaoke']);
    const overlong = { ...second, days: second.days.map((d, i) => (i === 0 ? { ...d, tonight: ['a', 'b', 'c'] } : d)) };
    expect(setDayTonight(overlong, 0, 1, 'B').days[0].tonight).toEqual(['a', 'B']);
    expect(setDayTonight(second, 0, 1, 'Karaoke')).toBe(second);
    expect(setDayTonight(second, 0, 2 as 0 | 1, 'x')).toBe(second);
  });

  it('stores a Free Space override, and a cleared one as undefined rather than an empty string', () => {
    const set = setDayFreeText(weekendAway(), 0, 'Spot the heron');
    expect(set.days[0].freeText).toBe('Spot the heron');
    for (const cleared of ['', '   ']) {
      const after = setDayFreeText(set, 0, cleared);
      expect(after.days[0].freeText).toBeUndefined();
      expect('freeText' in after.days[0]).toBe(false);
    }
    const untouched = weekendAway();
    expect(setDayFreeText(untouched, 0, '')).toBe(untouched);
    expect(setDayFreeText(set, 0, 'Spot the heron')).toBe(set);
  });
});

describe('setEasyMixRatio', () => {
  it('stores a ratio in 0–1 and refuses anything the dealer would clamp', () => {
    const draft = weekendAway();
    expect(setEasyMixRatio(draft, 0.35).settings.easyMixRatio).toBe(0.35);
    for (const bad of [Number.NaN, -0.05, 1.05, Number.POSITIVE_INFINITY]) {
      expect(setEasyMixRatio(draft, bad)).toBe(draft);
    }
    expect(setEasyMixRatio(draft, draft.settings.easyMixRatio)).toBe(draft);
  });
});

describe('normalizeDraft chokepoint', () => {
  it('returns a dense draft from a Look edit, repairing holes in days and prompts alike', () => {
    const days: DraftDayDef[] = [day(0), day(1), day(2)];
    delete (days as unknown[])[1];
    const main = [{ text: 'a', spicy: false }, { text: 'b', spicy: false }];
    delete (main as unknown[])[0];
    const sparse = bare({ cardFormat: 'daily_cards', days, prompts: { main, easy: [], closing: [] } });
    const after = setDayPlace(sparse, 2, 'Pier');
    expect(after.days.map((d) => [d.index, d.place])).toEqual([
      [0, ''],
      [1, 'Pier'],
    ]);
    expect(after.prompts.main).toEqual([{ text: 'b', spicy: false }]);
    expect(Object.keys(after.days)).toEqual(['0', '1']);
  });
});

describe('a schedule filled entirely through these transforms', () => {
  it('leaves dayCompletenessIssues and firstUnlockIssues (future now) with nothing to report', () => {
    let draft = applyProposedDayThemes(weekendAway());
    const dates = ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
    dates.forEach((date, position) => {
      draft = setDayDate(draft, position, date);
      draft = setDayPlace(draft, position, 'Bodega Bay');
      draft = setDayPlaceEmoji(draft, position, '🐦');
      draft = setDayTonight(draft, position, 0, 'Dinner at the Tides');
      draft = setDayTonight(draft, position, 1, 'Bonfire');
    });
    draft = setDayFreeText(draft, 0, 'Spot the heron');
    draft = setDayFreeText(draft, 1, '');
    expect(dayCompletenessIssues(draft)).toEqual([]);
    expect(firstUnlockIssues(draft, NOW)).toEqual([]);
  });
});
