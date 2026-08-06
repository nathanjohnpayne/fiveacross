import { describe, it, expect } from 'vitest';
import type { DayDef } from '../types';
import { DAYS } from './seed';
import { EVENT_SEED } from '../../scripts/seed-data/med-2026.mjs';
import { ALLOWED_FIELDS, IMMUTABLE_FIELDS, diffDay, correctDay, planScheduleMigration } from '../../scripts/migrate-schedule-2026-07-17.mjs';

// A RAW live Day as persisted on the pre-migration med-2026 doc: `tonight`
// may be absent, and `pool` carries the LEGACY persisted values
// ('embark'/'farewell', pre-#565) — the migration script compares raw
// persisted data on both sides, so these fixtures deliberately keep the
// legacy vocabulary the live doc actually holds.
type LiveDay = Omit<DayDef, 'tonight' | 'pool'> & { tonight?: string[]; pool: string };
const IMMUTABLE_DAY_FIELDS = IMMUTABLE_FIELDS as Array<keyof LiveDay>;

// Covers specs/schedule-correction.md: the corrected itinerary (unified day
// themes + two-event "Tonight:" lines) asserted against the seed, and the
// owner-run migration's pure planning core (the diff/plan functions that
// enforce the "display metadata only, zero game impact" guarantee).

// The canonical corrected mapping (daily-cards-spec § Itinerary, corrected
// 2026-07-17). Atlantis marks are paraphrased out of user-facing copy (the
// w1-themes non-goal): "🎉 Welcome Party" (not "Atlantis Welcome Party") and
// "🏺 Dance Classics" (not "Atlantis Classics").
const EXPECTED = [
  { theme: 'welcome-aboard', place: 'Trieste', placeEmoji: '🇮🇹', tonight: ['⛵ Sail-Away Party', '🎉 Welcome Party'] },
  { theme: 'uniforms-without-borders', place: 'Split', placeEmoji: '🇭🇷', tonight: ['🪖 Dog Tag T-Dance', '✈️ Duty Free'] },
  { theme: 'neon-pink-playground', place: 'Sea Day', placeEmoji: '🌊', tonight: ['💖 Seriously Pink T-Dance', '🌈 Neon Playground'] },
  { theme: 'sporty-splash', place: 'Valletta', placeEmoji: '🇲🇹', tonight: ['💦 Splash T-Dance', '🏋️ Get Sporty'] },
  { theme: 'under-the-stars', place: 'Palermo (Sicily)', placeEmoji: '🇮🇹', tonight: ['🎭 AirOtic', '🌌 Under the Stars'] },
  { theme: 'glamiators', place: 'Naples (Pompeii)', placeEmoji: '🇮🇹', tonight: ['🎤 Solea Pfeiffer', '🏛️ Glamiators'] },
  { theme: 'atlantis-classics', place: 'Rome (Civitavecchia)', placeEmoji: '🇮🇹', tonight: ['🎭 Persephone', '🏺 Dance Classics'] },
  { theme: 'summer-white', place: 'Villefranche (Nice)', placeEmoji: '🇫🇷', tonight: ['🎤 HAYLA', '🤍 Summer White Party'] },
  { theme: 'revival-disco', place: 'Marseille', placeEmoji: '🇫🇷', tonight: ['🪩 Revival! Classic Disco T-Dance', '🎉 Last Dance'] },
  { theme: 'so-long-farewell', place: 'Barcelona', placeEmoji: '🇪🇸', tonight: ['🧳 Disembark in Barcelona', '👋 Until next year'] },
] as const;

describe('schedule correction — corrected day → theme/port/tonight mapping (specs/schedule-correction.md)', () => {
  it('maps every Day to its corrected theme, port, and placeEmoji', () => {
    EXPECTED.forEach((exp, i) => {
      expect(DAYS[i].theme).toBe(exp.theme);
      expect(DAYS[i].place).toBe(exp.place);
      expect(DAYS[i].placeEmoji).toBe(exp.placeEmoji);
    });
  });

  it('carries exactly two Tonight events on every Day, matching the spec table', () => {
    EXPECTED.forEach((exp, i) => {
      expect(DAYS[i].tonight).toHaveLength(2);
      expect(DAYS[i].tonight).toEqual(exp.tonight);
    });
  });

  it('keeps the Atlantis brand mark out of every Tonight line (w1-themes non-goal)', () => {
    for (const day of DAYS) {
      for (const event of day.tonight) {
        expect(event, `Tonight event leaks a mark: "${event}"`).not.toMatch(/atlantis/i);
      }
    }
  });

  it('stays in sync with scripts/seed-data/med-2026.mjs EVENT_SEED.days (tonight included)', () => {
    const scriptDays = EVENT_SEED.days as Array<Pick<DayDef, 'tonight'>>;
    expect(scriptDays.map((d) => d.tonight)).toEqual(DAYS.map((d) => d.tonight));
  });
});

// The pre-correction ("old") live schedule, as it was seeded before this ticket:
// original ports/themes, no `tonight`, and a scheduler-stamped `snapshotItemIds`
// on the already-unlocked Days 1–3 (index 0..2). Dates and unlockAt match the
// corrected seed exactly (the correction never moves them).
function oldLiveDays(): LiveDay[] {
  const at = (date: string) => Date.parse(`${date}T08:00:00+02:00`);
  return [
    { index: 0, date: '2026-07-15', place: 'Trieste', placeEmoji: '🇮🇹', theme: 'welcome-aboard', pool: 'embark', tutorial: true, unlockAt: 0, freeText: 'You made it aboard', snapshotItemIds: ['e1', 'e2'] },
    { index: 1, date: '2026-07-16', place: 'Split', placeEmoji: '🇭🇷', theme: 'get-sporty', pool: 'main', tutorial: false, unlockAt: at('2026-07-16'), snapshotItemIds: ['m1', 'm2', 'm3'] },
    { index: 2, date: '2026-07-17', place: 'Valletta', placeEmoji: '🇲🇹', theme: 'duty-free', pool: 'main', tutorial: false, unlockAt: at('2026-07-17'), snapshotItemIds: ['m4', 'm5'] },
    { index: 3, date: '2026-07-18', place: 'Palermo', placeEmoji: '🇮🇹', theme: 'glamiators', pool: 'main', tutorial: false, unlockAt: at('2026-07-18') },
    { index: 4, date: '2026-07-19', place: 'Sorrento', placeEmoji: '🇮🇹', theme: 'neon-playground', pool: 'main', tutorial: false, unlockAt: at('2026-07-19') },
    { index: 5, date: '2026-07-20', place: 'Rome (Civitavecchia)', placeEmoji: '🇮🇹', theme: 'summer-white', pool: 'main', tutorial: false, unlockAt: at('2026-07-20') },
    { index: 6, date: '2026-07-21', place: 'Nice', placeEmoji: '🇫🇷', theme: 'dog-tag', pool: 'main', tutorial: false, unlockAt: at('2026-07-21') },
    { index: 7, date: '2026-07-22', place: 'Marseille', placeEmoji: '🇫🇷', theme: 'revival-disco', pool: 'main', tutorial: false, unlockAt: at('2026-07-22') },
    { index: 8, date: '2026-07-23', place: 'Sea Day', placeEmoji: '🌊', theme: 'seriously-pink', pool: 'main', tutorial: false, unlockAt: at('2026-07-23') },
    { index: 9, date: '2026-07-24', place: 'Barcelona', placeEmoji: '🇪🇸', theme: 'so-long-farewell', pool: 'farewell', tutorial: true, unlockAt: at('2026-07-24'), freeText: 'We had the best damn time' },
  ];
}

describe('schedule migration — planning core (specs/schedule-correction.md)', () => {
  it('permits changing exactly theme/port/placeEmoji/tonight and nothing else', () => {
    expect([...ALLOWED_FIELDS].sort()).toEqual(['place', 'placeEmoji', 'theme', 'tonight']);
  });

  it('corrects the old live schedule without misalignment or any forbidden change', () => {
    const plan = planScheduleMigration(oldLiveDays());
    expect(plan.misaligned).toBe(false);
    expect(plan.forbidden).toHaveLength(0);
    expect(plan.changed).toBe(true);
    // Every Day's forbidden set is empty — the write touches only allowed fields.
    for (const d of plan.diffs) expect(d.forbidden).toEqual([]);
  });

  it('preserves the scheduler snapshot on already-unlocked Days (never touches game state)', () => {
    const plan = planScheduleMigration(oldLiveDays());
    expect(plan.corrected[0].snapshotItemIds).toEqual(['e1', 'e2']);
    expect(plan.corrected[1].snapshotItemIds).toEqual(['m1', 'm2', 'm3']);
    expect(plan.corrected[2].snapshotItemIds).toEqual(['m4', 'm5']);
    // ...and date / unlockAt / pool / tutorial / freeText are untouched.
    for (let i = 0; i < plan.corrected.length; i++) {
      for (const f of IMMUTABLE_DAY_FIELDS) {
        expect(plan.corrected[i][f]).toEqual(oldLiveDays()[i][f]);
      }
    }
  });

  it('writes the corrected Days to match the seed (theme/port/placeEmoji/tonight)', () => {
    const plan = planScheduleMigration(oldLiveDays());
    const corrected = plan.corrected as LiveDay[];
    corrected.forEach((d, i) => {
      expect(d.theme).toBe(DAYS[i].theme);
      expect(d.place).toBe(DAYS[i].place);
      expect(d.placeEmoji).toBe(DAYS[i].placeEmoji);
      expect(d.tonight).toEqual(DAYS[i].tonight);
    });
  });

  it('is idempotent — re-running against corrected Days reports no change', () => {
    const once = planScheduleMigration(oldLiveDays());
    const twice = planScheduleMigration(once.corrected);
    expect(twice.changed).toBe(false);
    expect(twice.misaligned).toBe(false);
  });

  it('refuses (misaligned) when an immutable field has drifted from the target', () => {
    // A live Day 5 re-pooled to a different pool must abort — the migration would
    // otherwise paste a theme onto a Day it can no longer trust to be the target.
    const drifted = oldLiveDays();
    drifted[5] = { ...drifted[5], pool: 'embark' };
    const plan = planScheduleMigration(drifted);
    expect(plan.misaligned).toBe(true);
    expect(plan.diffs[5].misalignedFields).toContain('pool');
  });

  it('refuses (misaligned) on a date shift', () => {
    const drifted = oldLiveDays();
    drifted[4] = { ...drifted[4], date: '2026-07-30' };
    const plan = planScheduleMigration(drifted);
    expect(plan.misaligned).toBe(true);
    expect(plan.diffs[4].misalignedFields).toContain('date');
  });

  it('refuses (misaligned) on a Day-count mismatch', () => {
    const plan = planScheduleMigration(oldLiveDays().slice(0, 9));
    expect(plan.misaligned).toBe(true);
    expect(plan.lengthMismatch).toBe(true);
  });

  it('does NOT flag the embark Day when its live unlockAt differs from the seed 0 sentinel', () => {
    // The seed uses `unlockAt: 0` ("live from event open") on the embark Day, but
    // the LIVE embark Day holds a real event-open timestamp. That is expected, not
    // drift: `unlockAt` is not an alignment field, and the migration preserves it
    // untouched. (Regression: the first prod dry-run wrongly aborted on this.)
    const live = oldLiveDays();
    const realEmbarkUnlock = Date.parse('2026-07-14T08:46:58+02:00');
    live[0] = { ...live[0], unlockAt: realEmbarkUnlock };
    const plan = planScheduleMigration(live);
    expect(plan.misaligned).toBe(false);
    expect(plan.diffs[0].misalignedFields).toEqual([]);
    // ...and the real unlockAt is carried through to the corrected write.
    expect(plan.corrected[0].unlockAt).toBe(realEmbarkUnlock);
    expect(plan.diffs[0].forbidden).toEqual([]);
  });

  it('diffDay reports the allowed field edits for a single Day', () => {
    const live = oldLiveDays()[2]; // Valletta 🇲🇹/duty-free → Sea Day 🌊/neon-pink-playground
    const target = DAYS[2];
    const diff = diffDay(live, target);
    // port, placeEmoji, theme, and tonight all change on this Day (plus tonight is
    // newly added), so all four allowed fields appear.
    expect(Object.keys(diff.allowed).sort()).toEqual(['place', 'placeEmoji', 'theme', 'tonight']);
    expect(diff.allowed.theme).toEqual({ from: 'duty-free', to: 'neon-pink-playground' });
    expect(diff.allowed.place).toEqual({ from: 'Valletta', to: 'Sea Day' });
    expect(diff.allowed.placeEmoji).toEqual({ from: '🇲🇹', to: '🌊' });
    expect(diff.forbidden).toEqual([]);
  });

  it('correctDay overwrites only allowed fields, preserving the rest', () => {
    const live = oldLiveDays()[1];
    const corrected = correctDay(live, DAYS[1]);
    expect(corrected.theme).toBe('uniforms-without-borders');
    expect(corrected.snapshotItemIds).toEqual(['m1', 'm2', 'm3']);
    expect(corrected.unlockAt).toBe(live.unlockAt);
    expect(corrected.pool).toBe('main');
  });
});
