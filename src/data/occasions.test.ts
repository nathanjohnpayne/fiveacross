import { describe, expect, it } from 'vitest';
import type { OccasionId } from '../types';
import { themesForEdition } from '../theme/themes';
import { MAX_DAYS } from './draftValidation';
import { createEventDraft } from './eventDraft';
import { OCCASIONS, applyOccasionDefaults, occasionById } from './occasions';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

describe('the occasion matrix', () => {
  it('ships the frames six occasions, in frame order', () => {
    expect(OCCASIONS.map((o) => o.id)).toEqual([
      'weekend-away',
      'city-break',
      'wedding',
      'conference',
      'cruise',
      'custom',
    ]);
    expect(OCCASIONS.map((o) => o.label)).toEqual([
      'Weekend away',
      'City break',
      'Wedding',
      'Conference or offsite',
      'Cruise',
      'Custom',
    ]);
  });

  it('binds the two travel occasions to the Vacay Edition, as the frames name', () => {
    expect(occasionById('weekend-away')?.edition).toBe('vacay');
    expect(occasionById('city-break')?.edition).toBe('vacay');
  });

  it('binds Wedding, Conference and Custom to the occasion-neutral Five Across Edition', () => {
    for (const id of ['wedding', 'conference', 'custom'] as OccasionId[]) {
      expect(occasionById(id)?.edition).toBe('fiveacross');
    }
  });

  it('leaves every starter pack unowned — content ownership is an open epic decision', () => {
    expect(OCCASIONS.map((o) => o.starterPackId)).toEqual([null, null, null, null, null, null]);
  });

  it('offers only Themes the bound Edition registers', () => {
    for (const occasion of OCCASIONS) {
      const allowed = new Set(themesForEdition(occasion.edition).map((t) => t.id));
      expect(allowed.has(occasion.defaults.defaultTheme)).toBe(true);
      for (const theme of occasion.defaults.dayThemes) {
        expect(allowed.has(theme)).toBe(true);
      }
    }
  });

  it('proposes no Day Themes exactly when it proposes no schedule', () => {
    for (const occasion of OCCASIONS) {
      const { schedule, dayThemes } = occasion.defaults;
      expect(dayThemes.length === 0).toBe(schedule === null);
    }
  });

  it('never proposes a schedule for a one-card occasion', () => {
    for (const occasion of OCCASIONS) {
      if (occasion.defaults.cardFormat === 'one_card') {
        expect(occasion.defaults.schedule).toBeNull();
      }
    }
    expect(occasionById('wedding')?.defaults.cardFormat).toBe('one_card');
  });

  it('keeps every proposed schedule inside the ten-Day ceiling', () => {
    for (const occasion of OCCASIONS) {
      const schedule = occasion.defaults.schedule;
      if (!schedule) continue;
      expect(schedule.dayCount).toBeGreaterThanOrEqual(1);
      expect(schedule.dayCount).toBeLessThanOrEqual(MAX_DAYS);
      expect(schedule.unlockTime).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('closes every proposed schedule with the closing pool, so the finale can run', () => {
    for (const occasion of OCCASIONS) {
      const schedule = occasion.defaults.schedule;
      if (!schedule) continue;
      expect(schedule.finalDayPool).toBe('closing');
    }
  });

  it('keeps tutorial independent of pool — a warm-up pool whose wins still count', () => {
    // Bodega's easy-pool Friday is `tutorial: false`. The Weekend-away default
    // matches it, which is the whole point of the two fields being separate.
    const weekend = occasionById('weekend-away')?.defaults.schedule;
    expect(weekend?.firstDayPool).toBe('easy');
    expect(weekend?.firstDayTutorial).toBe(false);

    // And the converse combination is expressible: a conference opener is
    // onboarding, so its easy Day IS excluded from the Event-wide honour.
    const conference = occasionById('conference')?.defaults.schedule;
    expect(conference?.firstDayPool).toBe('easy');
    expect(conference?.firstDayTutorial).toBe(true);
  });

  it('defaults every occasion to All ages and to no daily email', () => {
    for (const occasion of OCCASIONS) {
      expect(occasion.defaults.settings.forceAdult).toBe(false);
      expect(occasion.defaults.settings.dailyEmailEnabled).toBe(false);
    }
  });

  it('answers claim mode rather than leaving the provisioner to hard-code Honor', () => {
    for (const occasion of OCCASIONS) {
      expect(['honor', 'proof_required', 'admin_confirmed']).toContain(occasion.defaults.claimMode);
    }
  });
});

describe('occasionById', () => {
  it('resolves each shipped id', () => {
    for (const occasion of OCCASIONS) {
      expect(occasionById(occasion.id)).toBe(occasion);
    }
  });

  it('returns null for an unknown or absent id, never another occasion', () => {
    expect(occasionById(null)).toBeNull();
    expect(occasionById(undefined)).toBeNull();
    expect(occasionById('festival' as OccasionId)).toBeNull();
  });
});

describe('applyOccasionDefaults', () => {
  it('commits the Edition, card format, claim mode, default Theme and settings', () => {
    const weekend = occasionById('weekend-away')!;
    const applied = applyOccasionDefaults(createEventDraft({ now: NOW, draftId: 'd' }), weekend);

    expect(applied.occasion).toBe('weekend-away');
    expect(applied.edition).toBe('vacay');
    expect(applied.cardFormat).toBe('daily_cards');
    expect(applied.claimMode).toBe(weekend.defaults.claimMode);
    expect(applied.defaultTheme).toBe(weekend.defaults.defaultTheme);
    expect(applied.settings).toEqual(weekend.defaults.settings);
  });

  it('copies the settings rather than aliasing the shared matrix object', () => {
    const weekend = occasionById('weekend-away')!;
    const applied = applyOccasionDefaults(createEventDraft({ now: NOW }), weekend);
    applied.settings.forceAdult = true;
    expect(weekend.defaults.settings.forceAdult).toBe(false);
  });

  it('builds no Days and seeds no Prompts — those are Steps 4 and 3', () => {
    const applied = applyOccasionDefaults(createEventDraft({ now: NOW }), occasionById('cruise')!);
    expect(applied.days).toEqual([]);
    expect(applied.prompts).toEqual({ main: [], easy: [], closing: [] });
  });

  it('returns a new draft rather than mutating the one passed in', () => {
    const before = createEventDraft({ now: NOW, draftId: 'd' });
    const applied = applyOccasionDefaults(before, occasionById('wedding')!);
    expect(applied).not.toBe(before);
    expect(before.occasion).toBeNull();
    expect(before.edition).toBe('fiveacross');
    expect(applied.cardFormat).toBe('one_card');
  });

  it('leaves a re-pick clean — switching occasion replaces the Edition, never merges it', () => {
    const first = applyOccasionDefaults(createEventDraft({ now: NOW }), occasionById('weekend-away')!);
    const second = applyOccasionDefaults(first, occasionById('conference')!);
    expect(second.edition).toBe('fiveacross');
    expect(second.occasion).toBe('conference');
  });
});
