// One-time owner-run schedule correction (2026-07-17, mid-cruise).
//
// The published July 2026 itinerary differs from what was seeded: ports moved
// (Sea Day is Day 3, Valletta Day 4, Palermo Day 5, Naples Day 6, Rome Day 7,
// Villefranche Day 8, Marseille Day 9) and each Day now carries ONE unified
// theme plus a two-event "Tonight:" line. Days 1–3 are already unlocked, so the
// Admin Schedule editor (and firestore.rules `daySchedUnchanged`) correctly
// refuse to change their `theme` — this lands the correction via the Admin SDK,
// which bypasses rules. No rules change; game state is never touched.
//
// HISTORICAL — already applied to prod on 2026-07-17; kept for the audit trail
// and its unit-tested planning core. The #566 field rename updated its target
// vocabulary to `place`/`placeEmoji` alongside the seed; the LIVE med-2026
// days still persist the pre-rename `port`/`portEmoji` (read-coerced by the
// app's eventConverter), so a hypothetical re-run would now ADD the neutral
// fields beside the legacy ones rather than edit them — fine, but pointless.
//
// DISPLAY METADATA ONLY. This writes the event doc's `days[]` and, per Day, may
// only change: `theme`, `place`, `placeEmoji`, `tonight`. It refuses to run if the
// corrected schedule would change ANY other Day field (index, date, pool,
// tutorial, unlockAt, freeText, snapshotItemIds) or if it can't align the live
// Days to the target by date. It never reads or writes boards, cells, marks,
// tallies, proofs, doubts, moments, dayStats, snapshots, or pools — only the
// `days` array field on events/{eventId}.
//
// Usage (dry-run is the DEFAULT — nothing is written without --apply):
//   # print the before/after diff, verify no forbidden field changes:
//   GOOGLE_CLOUD_PROJECT=gaycruisebingo VITE_EVENT_ID=med-2026 \
//     node scripts/migrate-schedule-2026-07-17.mjs
//   # after reviewing the diff, execute against prod:
//   GOOGLE_CLOUD_PROJECT=gaycruisebingo VITE_EVENT_ID=med-2026 \
//     node scripts/migrate-schedule-2026-07-17.mjs --apply
//
// Idempotent: a second run (after --apply) reports "already correct — nothing to
// write" and exits 0. Credentials: a gitignored repo-root serviceAccountKey.json
// if present (cert), else Application Default Credentials — the SAME resolution
// as scripts/seed.mjs / scripts/backfill-hide.mjs.
//
// The pure planning core (below the initFirestore boundary) imports no
// firebase-admin, so scripts/migrate-schedule-2026-07-17.test.mjs can import and
// assert `planScheduleMigration` / `diffDay` without any credential or install.
import { pathToFileURL } from 'node:url';
import { EVENT_SEED } from './seed-data/med-2026.mjs';

// The four Day fields this migration is permitted to change. The corrected Day
// written back is the LIVE Day with ONLY these fields overwritten from the
// target — so every other field (index, date, pool, tutorial, unlockAt,
// freeText, snapshotItemIds, and anything the scheduler added) is preserved
// byte-for-byte. That construction is what makes the "metadata only, zero game
// impact" guarantee hold; `diffDay`'s `forbidden` list re-asserts it in code.
export const ALLOWED_FIELDS = ['theme', 'place', 'placeEmoji', 'tonight'];

// Identity fields that must be IDENTICAL between the live Day and the seed
// target for the correction to be applied to the RIGHT Day. The target metadata
// is keyed by itinerary position, so if any of these has drifted (a shifted
// date, a re-pooled Day) we abort rather than paste a theme onto a mismatched
// Day. `date` is the true itinerary-position identity.
//
// `unlockAt` is deliberately NOT an alignment field: the embark Day carries a
// `0` "live from event open" sentinel in the seed, but the LIVE embark Day holds
// a real event-open timestamp — a legitimate, expected difference, not drift. It
// is preserved untouched regardless (see below), so it needs no alignment check.
// `freeText` and `snapshotItemIds` are likewise excluded — display/runtime state
// the migration preserves, not itinerary identity.
export const ALIGNMENT_FIELDS = ['index', 'date', 'pool', 'tutorial'];

// The pre-#566 vocabulary this script predates. A live Day still carrying
// `port`/`portEmoji` cannot be corrected safely through `place`/`placeEmoji`:
// `correctDay` spreads the live Day and overwrites only ALLOWED_FIELDS, so the
// legacy keys survive the write — and `migrateDayFields` (src/data/converters.ts)
// deliberately gives a retained `portEmoji` precedence over `placeEmoji`. The
// run would therefore report and apply a correction that clients never display,
// and every rerun would look idempotent while the stale emoji stayed on screen
// (#652). Refuse instead: this migration is out of contract against legacy-shaped
// data, and silently appearing to succeed is the worst of the available outcomes.
export const LEGACY_FIELDS = ['port', 'portEmoji'];

// The fields this migration must never change (everything a Day carries except
// ALLOWED_FIELDS). Preservation is guaranteed by construction (`correctDay`
// overwrites only ALLOWED_FIELDS) and re-asserted universally by `diffDay`'s
// `forbidden` list; this named list drives the test's explicit spot-check that
// unlockAt/date/pool/tutorial/freeText survive the write untouched.
export const IMMUTABLE_FIELDS = ['index', 'date', 'pool', 'tutorial', 'unlockAt', 'freeText'];

// The canonical corrected schedule is the seed itself (scripts/seed.mjs
// EVENT_SEED.days, kept in sync with src/data/seed.ts by the d15-tutorial-seed
// test). Reusing it here means there is no third copy of the itinerary to drift.
export const TARGET_DAYS = EVENT_SEED.days;

// Value equality that treats the `tonight` string[] structurally (order-
// sensitive, which is intentional — the two events render left-to-right). Scalars
// compare with ===; anything else falls back to JSON for a stable deep compare.
function fieldEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Build the Day that will actually be written: the live Day with only the
// allowed fields overwritten from the target.
export function correctDay(liveDay, targetDay) {
  const out = { ...(liveDay || {}) };
  for (const field of ALLOWED_FIELDS) {
    if (targetDay && field in targetDay) out[field] = targetDay[field];
  }
  return out;
}

/**
 * Diff one live Day against its correction. Returns:
 *   { index, corrected, allowed:{field:{from,to}}, forbidden:[field...], misalignedFields:[field...] }
 * - `allowed` — the intended metadata edits (a subset of ALLOWED_FIELDS).
 * - `forbidden` — any field the WRITE would change outside ALLOWED_FIELDS
 *   (empty by construction; a non-empty list means a coding regression and
 *   aborts the run — defense in depth for the metadata-only guarantee).
 * - `misalignedFields` — ALIGNMENT_FIELDS that differ between the live Day and
 *   the seed target; non-empty means the schedule drifted and we must abort
 *   before mislabeling a Day.
 */
export function diffDay(liveDay, targetDay) {
  const live = liveDay || {};
  const corrected = correctDay(live, targetDay);

  const allowed = {};
  for (const field of ALLOWED_FIELDS) {
    if (!fieldEqual(live[field], corrected[field])) {
      allowed[field] = { from: live[field], to: corrected[field] };
    }
  }

  const forbidden = [];
  const keys = new Set([...Object.keys(live), ...Object.keys(corrected)]);
  for (const key of keys) {
    if (ALLOWED_FIELDS.includes(key)) continue;
    if (!fieldEqual(live[key], corrected[key])) forbidden.push(key);
  }

  const misalignedFields = ALIGNMENT_FIELDS.filter(
    (key) => (key in live || key in (targetDay || {})) && !fieldEqual(live[key], targetDay?.[key]),
  );

  // Legacy keys are detected on the LIVE Day only: the target is the seed, which
  // is canonical by construction. Presence alone is the signal — a legacy key
  // survives `correctDay` whatever its value, and an empty-string `portEmoji`
  // still wins the precedence check in `migrateDayFields`.
  const legacyFields = LEGACY_FIELDS.filter((key) => key in live);

  return {
    index: live.index ?? targetDay?.index,
    corrected,
    allowed,
    forbidden,
    misalignedFields,
    legacyFields,
  };
}

/**
 * Plan the whole migration from the live `days[]`. Pure — no I/O. Produces the
 * corrected array, the per-Day diffs, and the abort conditions: `forbidden`
 * (the write would change a non-allowed field — should never happen), and
 * `misaligned` (live/target length mismatch OR any Day's immutable fields
 * drifted). `changed` is false when the live schedule already matches the
 * target (idempotent no-op).
 */
export function planScheduleMigration(liveDays, targetDays = TARGET_DAYS) {
  const live = Array.isArray(liveDays) ? liveDays : [];
  const lengthMismatch = live.length !== targetDays.length;
  const diffs = [];
  const corrected = [];
  for (let i = 0; i < targetDays.length; i++) {
    const diff = diffDay(live[i] ?? {}, targetDays[i]);
    diffs.push(diff);
    corrected.push(diff.corrected);
  }
  const forbidden = diffs.filter((d) => d.forbidden.length > 0);
  const misaligned = lengthMismatch || diffs.some((d) => d.misalignedFields.length > 0);
  const legacyShaped = diffs.filter((d) => d.legacyFields.length > 0);
  const changed = diffs.some((d) => Object.keys(d.allowed).length > 0);
  return { corrected, diffs, forbidden, misaligned, lengthMismatch, legacyShaped, changed };
}

/** Render the before/after diff as human-readable lines for the console. */
export function formatMigrationReport(plan) {
  const lines = [];
  for (const d of plan.diffs) {
    const dayNo = (d.index ?? 0) + 1;
    const changedFields = Object.keys(d.allowed);
    if (!changedFields.length && !d.forbidden.length && !d.misalignedFields.length && !d.legacyFields.length) {
      lines.push(`  Day ${dayNo}: unchanged`);
      continue;
    }
    for (const field of d.legacyFields) {
      lines.push(
        `  Day ${dayNo}: ⛔ LEGACY FIELD "${field}" — pre-#566 shape; a correction here would not reach clients`,
      );
    }
    for (const field of d.misalignedFields) {
      lines.push(`  Day ${dayNo}: ⚠️ MISALIGNED — immutable field "${field}" differs between live and target`);
    }
    for (const [field, { from, to }] of Object.entries(d.allowed)) {
      lines.push(`  Day ${dayNo}: ${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
    }
    for (const field of d.forbidden) {
      lines.push(`  Day ${dayNo}: ⛔ FORBIDDEN change to "${field}" — this migration must not touch it`);
    }
  }
  return lines.join('\n');
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

  const EVENT_ID = process.env.VITE_EVENT_ID || 'med-2026';

  // Pin the target project (mirrors scripts/seed.mjs) so a bare run can never
  // read or write the wrong Firebase project.
  let projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
  if (!projectId) {
    const rcUrl = new URL('../.firebaserc', import.meta.url);
    if (existsSync(rcUrl)) {
      try {
        projectId = JSON.parse(readFileSync(rcUrl, 'utf8'))?.projects?.default || '';
      } catch {
        projectId = '';
      }
    }
  }
  if (!projectId) {
    throw new Error(
      'schedule-migration: no Firebase project resolved. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or .firebaserc projects.default before running.',
    );
  }

  const keyUrl = new URL('../serviceAccountKey.json', import.meta.url);
  initializeApp({
    ...(existsSync(keyUrl)
      ? { credential: cert(JSON.parse(readFileSync(keyUrl))) }
      : { credential: applicationDefault() }),
    projectId,
  });
  return { db: getFirestore(), EVENT_ID, projectId };
}

function assertWritablePlan(plan, liveDays) {
  // Checked FIRST: a legacy-shaped live schedule makes every other verdict in
  // the plan misleading, because the correction this script computes cannot
  // reach the client through `migrateDayFields`' legacy precedence (#652).
  if (plan.legacyShaped.length > 0) {
    const days = plan.legacyShaped.map((d) => (d.index ?? 0) + 1).join(', ');
    throw new Error(
      `schedule-migration: REFUSING — Day(s) ${days} still carry pre-#566 field(s) (${LEGACY_FIELDS.join('/')}). ` +
        'This migration writes place/placeEmoji, but a retained portEmoji takes display precedence, so the ' +
        'correction would not reach clients and every rerun would look idempotent. Migrate the Day(s) to the ' +
        'neutral vocabulary first. No write performed.',
    );
  }
  if (plan.misaligned) {
    throw new Error(
      'schedule-migration: REFUSING — live schedule is not aligned to the target' +
        (plan.lengthMismatch ? ` (length ${liveDays.length} vs ${plan.corrected.length})` : ' (a Day date differs)') +
        '. No write performed.',
    );
  }
  if (plan.forbidden.length > 0) {
    const days = plan.forbidden.map((d) => (d.index ?? 0) + 1).join(', ');
    throw new Error(
      `schedule-migration: REFUSING — the corrected schedule would change forbidden field(s) on Day(s) ${days}. ` +
        'This migration is display-metadata only. No write performed.',
    );
  }
}

async function main() {
  const apply = process.argv.includes('--apply') || process.argv.includes('--execute');
  const { db, EVENT_ID, projectId } = await initFirestore();

  console.log(`schedule-migration: event=${EVENT_ID} project=${projectId || '(ADC default)'} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);

  const ref = db.doc(`events/${EVENT_ID}`);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`schedule-migration: event ${EVENT_ID} not found — aborting.`);
    process.exit(1);
  }
  const liveDays = snap.get('days');
  if (!Array.isArray(liveDays)) {
    console.error('schedule-migration: event has no days[] array — aborting (nothing to correct).');
    process.exit(1);
  }

  const plan = planScheduleMigration(liveDays);
  console.log('\nBefore → after (theme / port / placeEmoji / tonight only):');
  console.log(formatMigrationReport(plan));

  // Fail closed on either abort condition.
  try {
    assertWritablePlan(plan, liveDays);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }

  if (!plan.changed) {
    console.log('\nschedule-migration: already correct — nothing to write. ✅');
    return;
  }

  if (!apply) {
    console.log('\nschedule-migration: DRY-RUN complete. Re-run with --apply to write the corrected days[]. Nothing was written.');
    return;
  }

  // Single targeted update of ONLY the days field — no other event field is
  // touched, and no subcollection is read or written. The write is transaction-
  // wrapped so a concurrent admin/scheduler edit cannot be overwritten from the
  // stale dry-run read above.
  await db.runTransaction(async (tx) => {
    const applySnap = await tx.get(ref);
    if (!applySnap.exists) {
      throw new Error(`schedule-migration: event ${EVENT_ID} not found — aborting.`);
    }
    const applyDays = applySnap.get('days');
    if (!Array.isArray(applyDays)) {
      throw new Error('schedule-migration: event has no days[] array — aborting (nothing to correct).');
    }
    const applyPlan = planScheduleMigration(applyDays);
    assertWritablePlan(applyPlan, applyDays);
    if (!applyPlan.changed) return;
    tx.update(ref, { days: applyPlan.corrected });
  });
  console.log('\nschedule-migration: applied — corrected days[] written transactionally. ✅');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('schedule-migration failed', err);
    process.exit(1);
  });
}
