import { describe, it, expect } from 'vitest';
import type { DayDef } from '../types';
import {
  ALLOWED_FIELDS,
  LEGACY_FIELDS,
  correctDay,
  diffDay,
  planScheduleMigration,
  formatMigrationReport,
} from '../../scripts/migrate-schedule-2026-07-17.mjs';

// specs/schedule-correction.md — the pure planning core of the 2026-07-17
// schedule correction. The #652 contract: this script predates the #566 neutral
// vocabulary, and `correctDay` writes the corrected Day by SPREADING the live
// Day and overwriting only ALLOWED_FIELDS. A live Day still carrying legacy
// `port`/`portEmoji` therefore keeps them through the write, and
// `migrateDayFields` (src/data/converters.ts) gives a retained `portEmoji`
// display precedence over the freshly-corrected `placeEmoji` — so the run would
// report success while clients kept rendering the stale emoji, and every rerun
// would look idempotent. The fixtures below deliberately use the RAW legacy
// field names; fixtures written in the `place` vocabulary cannot reach this case
// at all, which is why it went unnoticed.

/** The live Day as it may actually be persisted: `MigrationDay` is written in
 *  the post-#566 vocabulary, but a doc predating that rename still carries the
 *  legacy keys — which is precisely the shape these tests exist to reject. */
type LegacyDay = ReturnType<typeof correctDay> & { port?: string; portEmoji?: string };

const target = (over: Partial<DayDef> = {}): DayDef => ({
  index: 0,
  date: '2026-07-18',
  pool: 'main',
  tutorial: false,
  theme: 'summer-white',
  place: 'Trieste',
  placeEmoji: '⚓️',
  tonight: ['White Party'],
  unlockAt: 1_760_000_000_000,
  ...over,
});

const liveNeutral = (over: Partial<LegacyDay> = {}): LegacyDay => ({
  ...target(),
  theme: 'neon-playground',
  placeEmoji: '🚢',
  ...over,
});

describe('schedule correction — legacy vocabulary refusal (#652)', () => {
  it('flags a live Day that still carries port/portEmoji', () => {
    const live = liveNeutral({ port: 'Trieste', portEmoji: '🚢' });
    const diff = diffDay(live, target());
    expect(diff.legacyFields).toEqual(['port', 'portEmoji']);
  });

  it('flags a legacy field even when its value is empty', () => {
    // Presence is the signal, not truthiness: `migrateDayFields` prefers a
    // retained `portEmoji` whenever the key exists, empty string included.
    const diff = diffDay(liveNeutral({ portEmoji: '' }), target());
    expect(diff.legacyFields).toEqual(['portEmoji']);
  });

  it('reports no legacy fields for a fully migrated Day', () => {
    expect(diffDay(liveNeutral(), target()).legacyFields).toEqual([]);
  });

  it('demonstrates why the refusal is necessary: correctDay retains the legacy keys', () => {
    // This is the defect the refusal exists to prevent, pinned so a future
    // change to `correctDay` cannot quietly make the guard look unnecessary.
    const corrected: LegacyDay = correctDay(liveNeutral({ port: 'Trieste', portEmoji: '🚢' }), target());
    expect(corrected.placeEmoji).toBe('⚓️');
    // The retained legacy key — invisible to `MigrationDay`, which is written in
    // the post-#566 vocabulary, but very much present on the written doc, where
    // `migrateDayFields` then prefers it over the corrected `placeEmoji`.
    expect(corrected.portEmoji).toBe('🚢');
  });

  it('surfaces legacy-shaped Days on the plan as an abort condition', () => {
    const plan = planScheduleMigration([liveNeutral({ portEmoji: '🚢' })], [target()]);
    expect(plan.legacyShaped).toHaveLength(1);
    expect(plan.legacyShaped[0]!.legacyFields).toEqual(['portEmoji']);
  });

  it('leaves legacyShaped empty for a clean neutral-vocabulary schedule', () => {
    expect(planScheduleMigration([liveNeutral()], [target()]).legacyShaped).toEqual([]);
  });

  it('names the legacy field in the human-readable report', () => {
    const plan = planScheduleMigration([liveNeutral({ portEmoji: '🚢' })], [target()]);
    const report = formatMigrationReport(plan);
    expect(report).toContain('LEGACY FIELD');
    expect(report).toContain('portEmoji');
  });

  it('never reports a legacy-shaped Day as "unchanged"', () => {
    // The theme already matches, so without the legacy check this Day would
    // render as `unchanged` — the exact "reruns appear idempotent" symptom.
    const live = liveNeutral({ theme: 'summer-white', placeEmoji: '⚓️', portEmoji: '🚢' });
    const report = formatMigrationReport(planScheduleMigration([live], [target()]));
    expect(report).not.toContain('unchanged');
    expect(report).toContain('LEGACY FIELD');
  });

  it('keeps the allowed-field set on the neutral vocabulary', () => {
    // The #652 finding's first proposed remedy was to move this script back to
    // the legacy vocabulary. We chose refusal instead, so pin that ALLOWED_FIELDS
    // stays neutral and LEGACY_FIELDS is detection-only — never written.
    expect(ALLOWED_FIELDS).toEqual(['theme', 'place', 'placeEmoji', 'tonight']);
    expect(LEGACY_FIELDS).toEqual(['port', 'portEmoji']);
    for (const field of LEGACY_FIELDS) {
      expect(ALLOWED_FIELDS).not.toContain(field);
    }
  });
});

describe('schedule correction — the existing guarantees still hold', () => {
  it('overwrites only the allowed fields and preserves everything else', () => {
    const live = liveNeutral({ freeText: 'keep me', snapshotItemIds: ['a', 'b'] });
    const corrected = correctDay(live, target());
    expect(corrected.theme).toBe('summer-white');
    expect(corrected.unlockAt).toBe(1_760_000_000_000);
    expect(corrected.freeText).toBe('keep me');
    expect(corrected.snapshotItemIds).toEqual(['a', 'b']);
    expect(diffDay(live, target()).forbidden).toEqual([]);
  });

  it('reports a drifted identity field as misaligned', () => {
    const diff = diffDay(liveNeutral({ date: '2026-07-19' }), target());
    expect(diff.misalignedFields).toContain('date');
  });
});
