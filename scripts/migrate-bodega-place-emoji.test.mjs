// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ALIGNMENT_FIELDS,
  EMOJI_FIELDS,
  EXPECTED_EVENT_ID,
  EXPECTED_PROJECT_ID,
  LEGACY_EMOJI_FIELD,
  TARGET_DAYS,
  assertSeedAgreement,
  assertWritablePlan,
  correctDay,
  diffDay,
  planEmojiMigration,
  seedDivergence,
} from './migrate-bodega-place-emoji.mjs';
import { EVENT_SEED } from './seed-data/bodega-bay-2026.mjs';
import { THEMES } from '../src/theme/themes';

// The one-off correction that carries #881's Day-glyph decision to the LIVE
// `fiveacross` Event doc, which the seed provably cannot reach: `scripts/seed.mjs`
// omits `days` whenever the Event already has a schedule, and its `SEED_DAYS=1`
// override is refused once any Day carries a frozen snapshot — every live Bodega
// Day does. (Codex P2, PR #896 round 1.)

/** The live `days[]` as read from `events/bodega-bay-2026` on the `fiveacross`
 *  project, 2026-08-18, trimmed to the fields that matter here plus enough
 *  ride-along state to prove the migration preserves it. Note the shape the
 *  seed's own header does NOT describe: only Day 3 carries a legacy
 *  `portEmoji` (Nathan's 2026-08-05 hand edit), and NO Day carries `port`. */
const LIVE_DAYS = [
  {
    index: 0,
    date: '2026-08-07',
    place: 'Bodega Bay',
    placeEmoji: '🐦',
    theme: 'the-birds',
    pool: 'embark',
    tutorial: false,
    scoring: 'competitive',
    unlockAt: 0,
    freeText: 'The flock has landed',
    tonight: ['🍷 Arrival pours', '🌊 First look at the water'],
    snapshotItemIds: ['seed-aaa', 'seed-bbb'],
  },
  {
    index: 1,
    date: '2026-08-08',
    place: 'Bodega Bay',
    placeEmoji: '🌊',
    theme: 'side-quests',
    pool: 'main',
    tutorial: false,
    scoring: 'competitive',
    unlockAt: 1_775_653_200_000,
    freeText: 'Main character on the coast',
    tonight: ['🦀 Harbor dinner', '🌅 Sunset'],
    snapshotItemIds: ['seed-ccc'],
    snapshotEasyMixRatio: 0.5,
  },
  {
    index: 2,
    date: '2026-08-09',
    place: 'Bodega Bay',
    placeEmoji: '🌅',
    theme: 'fog-froth-farewells',
    pool: 'main',
    tutorial: false,
    scoring: 'competitive',
    unlockAt: 1_775_739_600_000,
    freeText: 'One last coastal morning',
    tonight: ['☕ Last coffee', '🧳 The slow pack'],
    snapshotItemIds: ['seed-ddd'],
    snapshotEasyMixRatio: 0.5,
  },
  {
    index: 3,
    date: '2026-08-09',
    place: 'The drive home',
    placeEmoji: '🌫️',
    portEmoji: '👋',
    theme: 'fog-froth-farewells',
    pool: 'farewell',
    tutorial: true,
    scoring: 'ceremonial',
    unlockAt: 1_775_757_600_000,
    freeText: 'We did it for the story',
    tonight: ['📸 The photo dump', '📅 Next one'],
    snapshotItemIds: ['seed-eee'],
  },
];

const themeEmoji = (id) => THEMES.find((t) => t.id === id)?.emoji;

describe('migrate-bodega-place-emoji: the #881 target table', () => {
  it('pins the Event this migration is written for', () => {
    expect(EXPECTED_PROJECT_ID).toBe('fiveacross');
    expect(EXPECTED_EVENT_ID).toBe('bodega-bay-2026');
  });

  it('carries the glyphs #881 proposed, per Day', () => {
    expect(TARGET_DAYS.map((d) => [d.index, d.emoji])).toEqual([
      [0, '🐚'],
      [1, '🦪'],
      [2, '🌅'],
      [3, '👋'],
    ]);
  });

  // The rule the whole issue is about: `headerDayIdentity` draws `{placeEmoji}
  // {place}` over `{themeEmoji} {themeLabel}`, so a Day emoji equal to its own
  // Theme's renders the same character twice. This asserts the outcome against
  // the live THEMES registry rather than trusting the table's hardcoded glyphs.
  it('never reuses the Day Theme’s own glyph', () => {
    for (const day of TARGET_DAYS) {
      expect(themeEmoji(day.theme), `theme ${day.theme} must exist`).toBeTruthy();
      expect(day.emoji, `Day ${day.index + 1} (${day.theme})`).not.toBe(themeEmoji(day.theme));
    }
  });

  // The superseded glyphs are exactly the Theme glyphs that caused the stutter,
  // which is what makes `seedDivergence`'s 'pending-fix' classification safe:
  // it only ever forgives the value #881 is moving off.
  it('records each superseded glyph as the Theme glyph it collided with', () => {
    expect(TARGET_DAYS.find((d) => d.index === 0).superseded).toEqual([themeEmoji('the-birds')]);
    expect(TARGET_DAYS.find((d) => d.index === 1).superseded).toEqual([themeEmoji('side-quests')]);
    expect(TARGET_DAYS.find((d) => d.index === 3).superseded).toEqual([themeEmoji('fog-froth-farewells')]);
    // Day 2 was already distinct, so it supersedes nothing but is still planned.
    expect(TARGET_DAYS.find((d) => d.index === 2).superseded).toEqual([]);
  });
});

describe('migrate-bodega-place-emoji: correctDay', () => {
  it('sets placeEmoji to the target', () => {
    const out = correctDay(LIVE_DAYS[0], TARGET_DAYS[0]);
    expect(out.placeEmoji).toBe('🐚');
  });

  // The #566 rename is retiring `port`/`portEmoji`, and `migrateDayFields` gives
  // a retained `portEmoji` READ PRECEDENCE over `placeEmoji`. Writing one back
  // onto a Day that has shed it would put the retired field in front of the one
  // this migration corrects — the #652 trap, re-armed.
  it('never introduces the legacy portEmoji key', () => {
    const out = correctDay(LIVE_DAYS[0], TARGET_DAYS[0]);
    expect(LEGACY_EMOJI_FIELD in out).toBe(false);
    expect('port' in out).toBe(false);
  });

  it('corrects the legacy portEmoji where the key already exists', () => {
    const out = correctDay({ ...LIVE_DAYS[3], portEmoji: '🌫️' }, TARGET_DAYS[3]);
    expect(out.portEmoji).toBe('👋');
    expect(out.placeEmoji).toBe('👋');
  });

  // Presence, not truthiness: an empty-string portEmoji is still a key, and
  // `migrateDayFields` tests `typeof portEmoji === 'string'` — so '' wins the
  // precedence check and would blank the glyph on every surface.
  it('corrects an empty-string portEmoji rather than skipping it', () => {
    const out = correctDay({ ...LIVE_DAYS[3], portEmoji: '' }, TARGET_DAYS[3]);
    expect(out.portEmoji).toBe('👋');
  });

  it('preserves every other field byte-for-byte', () => {
    const out = correctDay(LIVE_DAYS[1], TARGET_DAYS[1]);
    for (const [key, value] of Object.entries(LIVE_DAYS[1])) {
      if (EMOJI_FIELDS.includes(key)) continue;
      expect(out[key], key).toEqual(value);
    }
    expect(out.snapshotItemIds).toEqual(['seed-ccc']);
    expect(out.snapshotEasyMixRatio).toBe(0.5);
    expect(out.unlockAt).toBe(1_775_653_200_000);
  });
});

describe('migrate-bodega-place-emoji: planEmojiMigration against the live shape', () => {
  const plan = planEmojiMigration(LIVE_DAYS);

  it('changes exactly the three stale Days, and only placeEmoji', () => {
    expect(plan.changed).toBe(true);
    expect(plan.diffs.map((d) => Object.keys(d.changed))).toEqual([
      ['placeEmoji'], // 🐦 → 🐚
      ['placeEmoji'], // 🌊 → 🦪
      [], // already 🌅
      ['placeEmoji'], // 🌫️ → 👋; the live portEmoji is ALREADY 👋
    ]);
    expect(plan.diffs[0].changed.placeEmoji).toEqual({ from: '🐦', to: '🐚' });
    expect(plan.diffs[3].changed.placeEmoji).toEqual({ from: '🌫️', to: '👋' });
  });

  it('touches no forbidden field and adds no legacy key', () => {
    expect(plan.forbidden).toEqual([]);
    expect(plan.legacyIntroduced).toEqual([]);
    expect(plan.misaligned).toBe(false);
  });

  it('leaves every Day’s frozen snapshot intact', () => {
    expect(plan.corrected.map((d) => d.snapshotItemIds)).toEqual([
      ['seed-aaa', 'seed-bbb'],
      ['seed-ccc'],
      ['seed-ddd'],
      ['seed-eee'],
    ]);
  });

  it('is idempotent — replanning the corrected days is a no-op', () => {
    const second = planEmojiMigration(plan.corrected);
    expect(second.changed).toBe(false);
    expect(second.corrected).toEqual(plan.corrected);
  });

  it('resolves each corrected Day through migrateDayFields’ precedence to the target', () => {
    // Mirrors src/data/converters.ts: a string `portEmoji` wins, else placeEmoji.
    const rendered = (d) => (typeof d.portEmoji === 'string' ? d.portEmoji : d.placeEmoji);
    expect(plan.corrected.map(rendered)).toEqual(['🐚', '🦪', '🌅', '👋']);
  });
});

describe('migrate-bodega-place-emoji: fail-closed guards', () => {
  it('refuses a schedule of the wrong length', () => {
    const plan = planEmojiMigration(LIVE_DAYS.slice(0, 3));
    expect(plan.lengthMismatch).toBe(true);
    expect(() => assertWritablePlan(plan, LIVE_DAYS.slice(0, 3))).toThrow(/not aligned/);
  });

  it.each(ALIGNMENT_FIELDS)('refuses when the live Day’s %s has drifted', (field) => {
    const drifted = LIVE_DAYS.map((d, i) => (i === 1 ? { ...d, [field]: 'drifted' } : d));
    const plan = planEmojiMigration(drifted);
    expect(plan.diffs[1].misalignedFields).toContain(field);
    expect(() => assertWritablePlan(plan, drifted)).toThrow(/not aligned/);
  });

  // Days 2 and 3 share 2026-08-09 (the competitive Sunday and the 11:00 wrap-up),
  // so date alone cannot align them — a swap must be caught by index/place.
  it('refuses a Day 2/Day 3 swap even though their dates match', () => {
    const swapped = [LIVE_DAYS[0], LIVE_DAYS[1], LIVE_DAYS[3], LIVE_DAYS[2]];
    const plan = planEmojiMigration(swapped);
    expect(plan.misaligned).toBe(true);
    expect(() => assertWritablePlan(plan, swapped)).toThrow(/not aligned/);
  });

  it('refuses a plan that would introduce the legacy key', () => {
    const plan = planEmojiMigration(LIVE_DAYS);
    plan.legacyIntroduced = [{ index: 0 }];
    expect(() => assertWritablePlan(plan, LIVE_DAYS)).toThrow(/would ADD the legacy/);
  });

  it('refuses a plan that would change a forbidden field', () => {
    const plan = planEmojiMigration(LIVE_DAYS);
    plan.forbidden = [{ index: 2 }];
    expect(() => assertWritablePlan(plan, LIVE_DAYS)).toThrow(/glyph-only/);
  });

  // `forbidden` is empty by construction, so its worth is in catching a
  // regression in `correctDay`. Two properties have to hold for it to be
  // trustworthy: the comparison must be DEEP (an equal-contents `tonight` array
  // is not a change), and it must cover keys this script has never heard of —
  // the scheduler stamps its own (`snapshotEasyMixRatio` arrived that way), and
  // a migration that dropped them would be silently lossy.
  it('compares every non-emoji field deeply, including unknown ones', () => {
    const withExtras = {
      ...LIVE_DAYS[1],
      tonight: [...LIVE_DAYS[1].tonight],
      scheduler: { addedBy: 'cron', at: 123 },
    };
    const diff = diffDay(withExtras, TARGET_DAYS[1]);
    expect(diff.forbidden).toEqual([]);
    expect(diff.corrected.scheduler).toEqual({ addedBy: 'cron', at: 123 });
    // The whole Day round-trips apart from the one glyph field it may change.
    const { placeEmoji: _corrected, ...restCorrected } = diff.corrected;
    const { placeEmoji: _live, ...restLive } = withExtras;
    expect(restCorrected).toEqual(restLive);
  });

  it('accepts a missing Day as misaligned rather than crashing', () => {
    const plan = planEmojiMigration([]);
    expect(plan.misaligned).toBe(true);
    expect(() => assertWritablePlan(plan, [])).toThrow();
  });
});

// Codex P2, round 1. Hand edits to this Event's live glyphs are not
// hypothetical — Day 4's `portEmoji` IS one (2026-08-05), which is exactly why
// it disagreed with `placeEmoji`. Overwriting an unrecognised value would
// silently revert whoever made it to a decision they had already moved past.
describe('migrate-bodega-place-emoji: unrecognised live glyphs', () => {
  it('refuses a live placeEmoji that is neither the target nor the superseded glyph', () => {
    const edited = LIVE_DAYS.map((d, i) => (i === 1 ? { ...d, placeEmoji: '🦞' } : d));
    const plan = planEmojiMigration(edited);
    expect(plan.unrecognized).toHaveLength(1);
    expect(plan.unrecognized[0].unrecognized).toEqual([{ field: 'placeEmoji', value: '🦞' }]);
    expect(() => assertWritablePlan(plan, edited)).toThrow(/does not recognise/);
  });

  it('refuses an unrecognised value on the retained legacy field too', () => {
    const edited = LIVE_DAYS.map((d, i) => (i === 3 ? { ...d, portEmoji: '🚗' } : d));
    const plan = planEmojiMigration(edited);
    expect(plan.unrecognized[0].unrecognized).toEqual([{ field: 'portEmoji', value: '🚗' }]);
    expect(() => assertWritablePlan(plan, edited)).toThrow(/does not recognise/);
  });

  it('accepts the pre-migration live doc — every glyph is a superseded one', () => {
    const plan = planEmojiMigration(LIVE_DAYS);
    expect(plan.unrecognized).toEqual([]);
    expect(() => assertWritablePlan(plan, LIVE_DAYS)).not.toThrow();
  });

  it('accepts the post-migration live doc — every glyph is a target', () => {
    const applied = planEmojiMigration(LIVE_DAYS).corrected;
    const plan = planEmojiMigration(applied);
    expect(plan.unrecognized).toEqual([]);
    expect(() => assertWritablePlan(plan, applied)).not.toThrow();
  });

  // A Day with no `placeEmoji` renders no glyph at all (`migrateDayFields`
  // resolves it to ''), so writing the target repairs it rather than overwriting
  // anybody's edit.
  it('treats an absent placeEmoji as a repair, not an unrecognised value', () => {
    const stripped = LIVE_DAYS.map((d, i) => {
      if (i !== 0) return d;
      const { placeEmoji: _dropped, ...rest } = d;
      return rest;
    });
    const plan = planEmojiMigration(stripped);
    expect(plan.unrecognized).toEqual([]);
    expect(plan.diffs[0].changed.placeEmoji).toEqual({ from: undefined, to: '🐚' });
    expect(() => assertWritablePlan(plan, stripped)).not.toThrow();
  });
});

describe('migrate-bodega-place-emoji: seed cross-check', () => {
  it('classifies the real seed module as converged or pending PR #896, never a conflict', () => {
    const divergence = seedDivergence(EVENT_SEED.days);
    expect(divergence.conflicts).toEqual([]);
    expect(() => assertSeedAgreement(divergence)).not.toThrow();
    // Every non-converged entry is a Day #896 is moving off its Theme glyph.
    for (const entry of divergence.pendingFix) {
      const target = TARGET_DAYS.find((d) => d.index === entry.index);
      expect(target.superseded).toContain(entry.value);
    }
  });

  it('reports nothing once the seed carries the targets (post-#896 steady state)', () => {
    const seeded = TARGET_DAYS.map((t) => ({ index: t.index, placeEmoji: t.emoji, portEmoji: t.emoji }));
    expect(seedDivergence(seeded).entries).toEqual([]);
  });

  it('refuses an unrecognised seed value — the decision changed, or the seed drifted', () => {
    const seeded = TARGET_DAYS.map((t) => ({ index: t.index, placeEmoji: t.index === 1 ? '🦞' : t.emoji }));
    const divergence = seedDivergence(seeded);
    expect(divergence.conflicts).toHaveLength(1);
    expect(divergence.conflicts[0]).toMatchObject({ index: 1, field: 'placeEmoji', value: '🦞' });
    expect(() => assertSeedAgreement(divergence)).toThrow(/does not recognise/);
  });

  it('treats a field the seed omits as nothing to disagree with', () => {
    const seeded = TARGET_DAYS.map((t) => ({ index: t.index, placeEmoji: t.emoji }));
    expect(seedDivergence(seeded).entries).toEqual([]);
  });

  // Codex P2, round 1. A missing FIELD is unasserted; a missing DAY means the
  // seed no longer describes a Day this table still plans to write — a dropped
  // or reindexed Day — and must not read as agreement.
  it('refuses a target Day the seed no longer describes', () => {
    const seeded = TARGET_DAYS.filter((t) => t.index !== 2).map((t) => ({
      index: t.index,
      placeEmoji: t.emoji,
    }));
    const divergence = seedDivergence(seeded);
    expect(divergence.conflicts).toHaveLength(1);
    expect(divergence.conflicts[0]).toMatchObject({ index: 2, field: '(day)' });
    expect(() => assertSeedAgreement(divergence)).toThrow(/does not recognise/);
  });

  it('refuses a reindexed seed even when every glyph value is a target', () => {
    const seeded = TARGET_DAYS.map((t) => ({ index: t.index + 10, placeEmoji: t.emoji }));
    const divergence = seedDivergence(seeded);
    expect(divergence.conflicts).toHaveLength(TARGET_DAYS.length);
    expect(() => assertSeedAgreement(divergence)).toThrow();
  });

  it('refuses an empty seed rather than reporting agreement', () => {
    expect(() => assertSeedAgreement(seedDivergence([]))).toThrow();
  });
});
