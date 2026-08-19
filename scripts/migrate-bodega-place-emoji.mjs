#!/usr/bin/env node
// One-off owner-run correction for the Bodega Bay Day glyphs (#881), applied to
// the LIVE `fiveacross` Event doc.
//
// WHY THIS EXISTS. #881 recorded owner direction that no frame may show the same
// emoji twice, and three Bodega Days set a `placeEmoji` identical to their own
// Theme's glyph — `headerDayIdentity` draws `{placeEmoji} {place}` over
// `{themeEmoji} {themeLabel}`, so the character rendered twice. PR #896 fixes
// the SEED. The seed is not the live doc, and on this Event it cannot become
// the live doc:
//
//   - `scripts/seed.mjs` omits `days` entirely whenever the target Event
//     already has a schedule (a reseed must never clobber admin edits), so a
//     routine reseed — or `npm run verify:seed:fiveacross` — leaves the live
//     glyphs exactly as they are while reporting success.
//   - The `SEED_DAYS=1` escape hatch is refused outright once any Day carries a
//     frozen `snapshotItemIds`, and every live Bodega Day carries one.
//
// So the seed correction reaches a fresh Event and nothing else. This script is
// the other half: it carries the same #881 decision to the doc clients actually
// read. (Codex P2, PR #896 round 1.)
//
// WHAT IS STILL EXPOSED. The Event concluded 2026-08-09, so the header no longer
// shows the stutter — `headerDayIdentity`'s post-event branch renders the bare
// place name over "👋 Until next year" and never touches `placeEmoji`. Every
// OTHER Day-glyph surface stays reachable for a concluded Event and still reads
// the stale value: the day-switcher chip (`DaySwitcher`'s `day-chip-port`), the
// board's day bar (`Board`'s `daybar-meta`), the schedule list in More, the
// offline `CachedCardFallback`, the admin Schedule panel, and — the post-event
// destination itself — the honors strip in `FarewellPodium` ("Day N · Place 🐦").
//
// WHAT IT DOES. Sets `placeEmoji` to the #881 target on each Day, and updates
// the legacy `portEmoji` ONLY on a Day that already carries that key. It never
// introduces `port`/`portEmoji` where they are absent: the #566 rename is
// retiring that vocabulary, `migrateDayFields` already falls back to
// `placeEmoji` when the legacy key is missing, and writing one back would put a
// field with READ PRECEDENCE in front of the field this migration corrects.
// Where the key IS present it must be written, for exactly that reason — a
// retained `portEmoji` wins inside `migrateDayFields`, so correcting
// `placeEmoji` alone would leave the old glyph on screen and make every rerun
// look idempotent (the #652 trap that already caught the schedule migration).
//
// It changes NOTHING else. The Day written back is the LIVE Day with only those
// two fields overwritten, so `snapshotItemIds`, `tonight`, `pool`, `tutorial`,
// `scoring`, `unlockAt`, `freeText`, `theme`, `date`, `place` and
// `snapshotEasyMixRatio` survive byte-for-byte; `diffDay`'s `forbidden` list
// re-asserts that in code. It never reads or writes boards, cells, marks,
// tallies, proofs, doubts, moments, dayStats, snapshots or pools — only the
// `days` array field on `events/bodega-bay-2026`.
//
// Usage (dry-run is the DEFAULT — nothing is written without --apply):
//   eval "$(OP_PREFLIGHT_FIREBASE_PROJECT_ID=fiveacross \
//     scripts/op-preflight.sh --agent claude --mode deploy)"
//   node scripts/migrate-bodega-place-emoji.mjs            # report the diff
//   node scripts/migrate-bodega-place-emoji.mjs --apply     # write it
//
// Idempotent: a second run reports "already correct — nothing to write" and
// exits 0. Credentials: a gitignored repo-root serviceAccountKey.json if present
// (cert), else Application Default Credentials — the SAME resolution as
// scripts/seed.mjs and scripts/migrate-schedule-2026-07-17.mjs. The project and
// Event are hard-pinned below, because `.firebaserc`'s default project is
// `gaycruisebingo` and this Event lives on `fiveacross`.
//
// APPLIED to fiveacross/bodega-bay-2026 on 2026-08-18; kept for the audit trail
// and its unit-tested planning core. Three Days moved, all on `placeEmoji`:
// Day 1 🐦→🐚, Day 2 🌊→🦪, Day 4 🌫️→👋. Day 3 was already 🌅. NO Day's
// `portEmoji` changed — the live doc turned out to carry that key on the wrap-up
// Day alone, already holding the 👋 Nathan set by hand on 2026-08-05, and no Day
// carried `port` at all. (The seed module's own header describes a dual-write
// posture "mirroring the live doc field-for-field" on all four Days; that is not
// the shape the live doc has. Filed as a follow-up on #881 rather than silently
// reconciled here, since this script must not edit the seed.)
//
// The pure planning core (above the initFirestore boundary) imports no
// firebase-admin, so scripts/migrate-bodega-place-emoji.test.mjs can import and
// assert it without any credential or install.
import { pathToFileURL } from 'node:url';
import { EVENT_SEED } from './seed-data/bodega-bay-2026.mjs';

/** The Event this migration is written for. Hard-pinned rather than read from
 *  `.firebaserc` (whose default is `gaycruisebingo`) so a bare run can never
 *  touch the wrong project, and never the wrong Event on the right project. */
export const EXPECTED_PROJECT_ID = 'fiveacross';
export const EXPECTED_EVENT_ID = 'bodega-bay-2026';

/** The two Day fields this migration is permitted to change. Everything else on
 *  every Day is preserved by construction (`correctDay` spreads the live Day and
 *  overwrites only these). */
export const EMOJI_FIELDS = ['placeEmoji', 'portEmoji'];

/** The legacy field whose presence — not value — decides whether this migration
 *  writes it. Never introduced, always corrected when already there. */
export const LEGACY_EMOJI_FIELD = 'portEmoji';

/** Identity fields that must match between the live Day and the target for the
 *  correction to land on the RIGHT Day. `date` alone is ambiguous here (Days 2
 *  and 3 share 2026-08-09, the competitive Sunday and the 11:00 wrap-up), so
 *  `index` and `place` carry the disambiguation and `theme` pins the glyph the
 *  target was chosen against — the whole point of #881 is that the Day emoji
 *  must not equal the Theme's. */
export const ALIGNMENT_FIELDS = ['index', 'date', 'place', 'theme'];

/**
 * The #881 decision table, verbatim from the issue's "proposed placeEmoji"
 * column (owner direction, 2026-08-18). `superseded` records the glyph each Day
 * is moving OFF, which is what lets `seedDivergence` tell "PR #896 has not
 * merged yet" apart from "somebody changed the decision" — the first is an
 * expected transient, the second must stop the run.
 *
 * Day 2 is already distinct from its Theme (🌅 against 🌫️ `fog-froth-farewells`)
 * and is listed with no supersession so the plan still asserts its alignment and
 * proves it unchanged, rather than silently skipping a Day.
 */
export const TARGET_DAYS = Object.freeze([
  { index: 0, date: '2026-08-07', place: 'Bodega Bay', theme: 'the-birds', emoji: '🐚', superseded: ['🐦'] },
  { index: 1, date: '2026-08-08', place: 'Bodega Bay', theme: 'side-quests', emoji: '🦪', superseded: ['🌊'] },
  { index: 2, date: '2026-08-09', place: 'Bodega Bay', theme: 'fog-froth-farewells', emoji: '🌅', superseded: [] },
  { index: 3, date: '2026-08-09', place: 'The drive home', theme: 'fog-froth-farewells', emoji: '👋', superseded: ['🌫️'] },
]);

/**
 * Build the Day that will actually be written: the live Day with `placeEmoji`
 * set to the target, and `portEmoji` set to the target ONLY where that key
 * already exists. Presence is tested with `in` rather than a truthiness check —
 * an empty-string `portEmoji` is still a key that wins `migrateDayFields`'
 * precedence, so it must be corrected, not skipped.
 */
export function correctDay(liveDay, target) {
  const out = { ...(liveDay || {}) };
  out.placeEmoji = target.emoji;
  if (LEGACY_EMOJI_FIELD in out) out[LEGACY_EMOJI_FIELD] = target.emoji;
  return out;
}

/**
 * Diff one live Day against its correction. Returns:
 *   { index, corrected, changed:{field:{from,to}}, forbidden:[field...],
 *     misalignedFields:[field...], introducesLegacy, unrecognized:[{field,value}] }
 * - `changed` — the intended glyph edits (a subset of EMOJI_FIELDS).
 * - `forbidden` — any field the WRITE would change outside EMOJI_FIELDS. Empty
 *   by construction; a non-empty list is a coding regression and aborts the run.
 * - `misalignedFields` — ALIGNMENT_FIELDS that differ between live and target;
 *   non-empty means the schedule drifted and we must abort before pasting a
 *   glyph onto the wrong Day.
 * - `introducesLegacy` — true if the write would ADD `portEmoji` to a Day that
 *   lacks it. Also empty by construction, and also re-asserted rather than
 *   trusted: re-adding the legacy field would reinstate the read-precedence
 *   hazard this migration exists to clear.
 * - `unrecognized` — a PRESENT live glyph that is neither the #881 target nor
 *   the glyph #881 supersedes. Someone edited it by hand after this table was
 *   written, and overwriting it would silently revert their edit to a decision
 *   they have already moved past. That is not hypothetical on this Event: Day 4's
 *   live `portEmoji` is a hand edit (2026-08-05), which is the whole reason the
 *   legacy field disagrees with `placeEmoji` in the first place. (Codex P2,
 *   round 1.)
 *
 * A live Day MISSING `placeEmoji` is not unrecognized — the field resolves to ''
 * through `migrateDayFields` and renders no glyph at all, so writing the target
 * is a repair rather than an overwrite.
 */
export function diffDay(liveDay, target) {
  const live = liveDay || {};
  const corrected = correctDay(live, target);

  const changed = {};
  for (const field of EMOJI_FIELDS) {
    if (live[field] !== corrected[field]) changed[field] = { from: live[field], to: corrected[field] };
  }

  const forbidden = [];
  const keys = new Set([...Object.keys(live), ...Object.keys(corrected)]);
  for (const key of keys) {
    if (EMOJI_FIELDS.includes(key)) continue;
    if (JSON.stringify(live[key]) !== JSON.stringify(corrected[key])) forbidden.push(key);
  }

  const misalignedFields = ALIGNMENT_FIELDS.filter((key) => live[key] !== target[key]);
  const introducesLegacy = !(LEGACY_EMOJI_FIELD in live) && LEGACY_EMOJI_FIELD in corrected;

  const unrecognized = [];
  for (const field of EMOJI_FIELDS) {
    if (!(field in live)) continue;
    const value = live[field];
    if (value === target.emoji || target.superseded.includes(value)) continue;
    unrecognized.push({ field, value });
  }

  return { index: target.index, corrected, changed, forbidden, misalignedFields, introducesLegacy, unrecognized };
}

/**
 * Plan the whole migration from the live `days[]`. Pure — no I/O. `changed` is
 * false when the live schedule already carries every target glyph (the
 * idempotent no-op a second run reports).
 */
export function planEmojiMigration(liveDays, targets = TARGET_DAYS) {
  const live = Array.isArray(liveDays) ? liveDays : [];
  const lengthMismatch = live.length !== targets.length;
  const diffs = targets.map((target, i) => diffDay(live[i] ?? {}, target));
  return {
    corrected: diffs.map((d) => d.corrected),
    diffs,
    forbidden: diffs.filter((d) => d.forbidden.length > 0),
    legacyIntroduced: diffs.filter((d) => d.introducesLegacy),
    unrecognized: diffs.filter((d) => d.unrecognized.length > 0),
    misaligned: lengthMismatch || diffs.some((d) => d.misalignedFields.length > 0),
    lengthMismatch,
    changed: diffs.some((d) => Object.keys(d.changed).length > 0),
  };
}

/**
 * Cross-check the seed module against the same target table, so the live doc and
 * `scripts/seed-data/bodega-bay-2026.mjs` can never quietly disagree about a
 * Day's glyph — a divergence is exactly how this bug reached production in the
 * first place (Day 3's live `portEmoji` was hand-edited to 👋 on 2026-08-05
 * while the seed kept 🌫️).
 *
 * Per Day and per emoji field, the seed value is one of:
 *   'converged'   — already the #881 target. The steady state.
 *   'pending-fix' — still the exact glyph #881 supersedes, i.e. PR #896 has not
 *                   merged. Expected while that PR is open; reported, not fatal,
 *                   because the live doc's stale glyph is user-visible NOW and
 *                   the seed cannot reach this Event anyway.
 *   'conflict'    — neither. Somebody changed the decision, or the seed drifted
 *                   somewhere unplanned. Fatal: refuse rather than push a glyph
 *                   the seed will contradict.
 * A seed Day missing the FIELD is 'converged' by omission — the seed simply does
 * not assert that field, so there is nothing to disagree with. A missing DAY is
 * a different thing entirely and is a 'conflict': the seed no longer describes a
 * Day this table still plans to write, so either the itinerary was reindexed or
 * a Day was dropped, and a retained migration would carry its old decision into
 * a live or restored Event while reporting that the seed agreed. (Codex P2,
 * round 1.)
 */
export function seedDivergence(seedDays = EVENT_SEED.days, targets = TARGET_DAYS) {
  const entries = [];
  for (const target of targets) {
    const day = (Array.isArray(seedDays) ? seedDays : []).find((d) => d?.index === target.index);
    if (!day) {
      entries.push({ index: target.index, field: '(day)', value: undefined, target: target.emoji, status: 'conflict' });
      continue;
    }
    for (const field of EMOJI_FIELDS) {
      if (!(field in day)) continue;
      const value = day[field];
      const status =
        value === target.emoji ? 'converged' : target.superseded.includes(value) ? 'pending-fix' : 'conflict';
      if (status !== 'converged') entries.push({ index: target.index, field, value, target: target.emoji, status });
    }
  }
  return {
    entries,
    pendingFix: entries.filter((e) => e.status === 'pending-fix'),
    conflicts: entries.filter((e) => e.status === 'conflict'),
  };
}

/** Render the before/after diff as human-readable lines for the console. */
export function formatMigrationReport(plan) {
  const lines = [];
  for (const d of plan.diffs) {
    const dayNo = (d.index ?? 0) + 1;
    const fields = Object.keys(d.changed);
    if (!fields.length && !d.forbidden.length && !d.misalignedFields.length && !d.introducesLegacy) {
      lines.push(`  Day ${dayNo}: unchanged`);
      continue;
    }
    for (const field of d.misalignedFields) {
      lines.push(`  Day ${dayNo}: ⚠️ MISALIGNED — "${field}" differs between the live Day and the #881 target`);
    }
    for (const { field, value } of d.unrecognized) {
      lines.push(
        `  Day ${dayNo}: ⛔ UNRECOGNISED live ${field}=${JSON.stringify(value)} — neither the #881 target nor the ` +
          'glyph it supersedes; looks like a later hand edit',
      );
    }
    for (const [field, { from, to }] of Object.entries(d.changed)) {
      lines.push(`  Day ${dayNo}: ${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
    }
    if (d.introducesLegacy) {
      lines.push(`  Day ${dayNo}: ⛔ would ADD the legacy "${LEGACY_EMOJI_FIELD}" key — this migration must not`);
    }
    for (const field of d.forbidden) {
      lines.push(`  Day ${dayNo}: ⛔ FORBIDDEN change to "${field}" — this migration is glyph-only`);
    }
  }
  return lines.join('\n');
}

/** Render the seed cross-check as human-readable lines. */
export function formatSeedReport(divergence) {
  return divergence.entries
    .map(
      (e) =>
        `  Day ${e.index + 1}: seed ${e.field}=${JSON.stringify(e.value)} vs target ${JSON.stringify(e.target)}` +
        (e.status === 'pending-fix' ? '  (PR #896 not merged yet — expected)' : '  ⛔ CONFLICT'),
    )
    .join('\n');
}

/** Fail closed on every abort condition, in the order that makes the message
 *  most useful: alignment first (a misaligned plan makes every other verdict
 *  meaningless), then the two by-construction invariants. */
export function assertWritablePlan(plan, liveDays = []) {
  if (plan.misaligned) {
    throw new Error(
      'bodega-place-emoji: REFUSING — the live schedule is not aligned to the #881 target' +
        (plan.lengthMismatch
          ? ` (length ${liveDays.length} vs ${plan.corrected.length})`
          : ' (a Day index/date/place/theme differs)') +
        '. No write performed.',
    );
  }
  // Before the by-construction invariants, because this one is about the DATA
  // rather than about this script's own correctness: a live glyph nobody
  // recognises is somebody's later edit, and stomping it would revert them to a
  // decision they have already moved past.
  if (plan.unrecognized.length > 0) {
    const detail = plan.unrecognized
      .flatMap((d) => d.unrecognized.map((u) => `Day ${(d.index ?? 0) + 1} ${u.field}=${JSON.stringify(u.value)}`))
      .join('; ');
    throw new Error(
      `bodega-place-emoji: REFUSING — live glyph(s) this migration does not recognise: ${detail}. Neither the #881 ` +
        'target nor the glyph it supersedes, so this looks like a hand edit made after the table was written. ' +
        'Overwriting it would silently revert that edit. Reconcile it, or extend the target table. No write performed.',
    );
  }
  if (plan.legacyIntroduced.length > 0) {
    const days = plan.legacyIntroduced.map((d) => (d.index ?? 0) + 1).join(', ');
    throw new Error(
      `bodega-place-emoji: REFUSING — the correction would ADD the legacy "${LEGACY_EMOJI_FIELD}" key to Day(s) ` +
        `${days}. That field takes read precedence in migrateDayFields, so re-introducing it would put the retired ` +
        'vocabulary back in front of the corrected one. No write performed.',
    );
  }
  if (plan.forbidden.length > 0) {
    const days = plan.forbidden.map((d) => (d.index ?? 0) + 1).join(', ');
    throw new Error(
      `bodega-place-emoji: REFUSING — the correction would change forbidden field(s) on Day(s) ${days}. ` +
        'This migration is glyph-only. No write performed.',
    );
  }
}

/** Fatal only on a real conflict; a still-unmerged PR #896 is reported by the
 *  caller and allowed through. */
export function assertSeedAgreement(divergence) {
  if (divergence.conflicts.length === 0) return;
  const detail = divergence.conflicts
    .map((c) => `Day ${c.index + 1} ${c.field}=${JSON.stringify(c.value)} (target ${JSON.stringify(c.target)})`)
    .join('; ');
  throw new Error(
    `bodega-place-emoji: REFUSING — the seed module disagrees with the #881 target in a way this migration does ` +
      `not recognise: ${detail}. Either the decision changed and this table is stale, or the seed drifted. ` +
      'Reconcile them before writing to the live Event. No write performed.',
  );
}

// ---------------------------------------------------------------------------
// Runtime boundary — everything below resolves firebase-admin lazily and only
// runs when the script is executed directly. Nothing above imports it, so the
// planning core stays import-safe for the unit test.
// ---------------------------------------------------------------------------

async function initFirestore() {
  const { readFileSync, existsSync } = await import('node:fs');
  const adminAppModule = 'firebase-admin/app';
  const adminFirestoreModule = 'firebase-admin/firestore';
  let initializeApp, cert, applicationDefault, getFirestore;
  try {
    ({ initializeApp, cert, applicationDefault } = await import(/* @vite-ignore */ adminAppModule));
    ({ getFirestore } = await import(/* @vite-ignore */ adminFirestoreModule));
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(
        'firebase-admin is not installed — it is a dev-only dependency this script\n' +
          'loads at runtime. Install it first, then re-run:\n' +
          '  npm i -D firebase-admin',
      );
      process.exit(1);
    }
    throw err;
  }

  // Both are overridable so the script can be pointed at a restore/staging copy,
  // but each override must be stated explicitly — the defaults are the pinned
  // production identities, never `.firebaserc`'s (`gaycruisebingo`).
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || EXPECTED_PROJECT_ID;
  const eventId = process.env.VITE_EVENT_ID || EXPECTED_EVENT_ID;

  const keyUrl = new URL('../serviceAccountKey.json', import.meta.url);
  initializeApp({
    ...(existsSync(keyUrl)
      ? { credential: cert(JSON.parse(readFileSync(keyUrl))) }
      : { credential: applicationDefault() }),
    projectId,
  });
  return { db: getFirestore(), eventId, projectId };
}

async function main() {
  const apply = process.argv.includes('--apply') || process.argv.includes('--execute');
  const { db, eventId, projectId } = await initFirestore();

  console.log(
    `bodega-place-emoji: event=${eventId} project=${projectId} mode=${apply ? 'APPLY' : 'DRY-RUN'}`,
  );
  if (projectId !== EXPECTED_PROJECT_ID || eventId !== EXPECTED_EVENT_ID) {
    console.log(
      `  note: overridden from the pinned ${EXPECTED_PROJECT_ID}/${EXPECTED_EVENT_ID} — the alignment check below is ` +
        'what keeps this honest.',
    );
  }

  // Checked before the doc is even read: a seed the table no longer matches
  // makes the whole plan suspect.
  const divergence = seedDivergence();
  if (divergence.entries.length > 0) {
    console.log('\nSeed cross-check (scripts/seed-data/bodega-bay-2026.mjs):');
    console.log(formatSeedReport(divergence));
  }
  try {
    assertSeedAgreement(divergence);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }

  const ref = db.doc(`events/${eventId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`bodega-place-emoji: event ${eventId} not found — aborting.`);
    process.exit(1);
  }
  const liveDays = snap.get('days');
  if (!Array.isArray(liveDays)) {
    console.error('bodega-place-emoji: event has no days[] array — aborting (nothing to correct).');
    process.exit(1);
  }

  const plan = planEmojiMigration(liveDays);
  console.log('\nBefore → after (placeEmoji / portEmoji only):');
  console.log(formatMigrationReport(plan));

  try {
    assertWritablePlan(plan, liveDays);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }

  if (!plan.changed) {
    console.log('\nbodega-place-emoji: already correct — nothing to write. ✅');
    return;
  }

  if (!apply) {
    console.log(
      '\nbodega-place-emoji: DRY-RUN complete. Re-run with --apply to write the corrected days[]. Nothing was written.',
    );
    return;
  }

  // Single targeted update of ONLY the days field. Transaction-wrapped so a
  // concurrent admin/scheduler edit between the dry-run read above and this
  // write cannot be silently overwritten — the plan is recomputed and
  // re-asserted against the transaction's own read.
  await db.runTransaction(async (tx) => {
    const applySnap = await tx.get(ref);
    if (!applySnap.exists) throw new Error(`bodega-place-emoji: event ${eventId} not found — aborting.`);
    const applyDays = applySnap.get('days');
    if (!Array.isArray(applyDays)) {
      throw new Error('bodega-place-emoji: event has no days[] array — aborting (nothing to correct).');
    }
    const applyPlan = planEmojiMigration(applyDays);
    assertWritablePlan(applyPlan, applyDays);
    if (!applyPlan.changed) return;
    tx.update(ref, { days: applyPlan.corrected });
  });
  console.log('\nbodega-place-emoji: applied — corrected days[] written transactionally. ✅');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('bodega-place-emoji failed', err);
    process.exit(1);
  });
}
