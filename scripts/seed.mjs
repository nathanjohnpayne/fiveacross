// Seed the event + prompt pool using the Firebase Admin SDK (bypasses security rules).
//
// One-time setup (Application Default Credentials — no committed key file):
//   1. npm install
//   2. gcloud auth application-default login
//   3. Find each Admin's Google UID: sign into the app once, then Firebase console > Authentication > Users.
//   4. ADMIN_UID=<uid>[,<uid>,...] GOOGLE_CLOUD_PROJECT=gaycruisebingo node scripts/seed.mjs
//
// Per-Event targeting (#563): the seed payload comes from
// scripts/seed-data/<event-id>.mjs, selected by VITE_EVENT_ID or (when unset)
// by the resolved project's default Event — gaycruisebingo → med-2026,
// fiveacross → bodega-bay-2026. `npm run verify:seed` /
// `npm run verify:seed:fiveacross` pin project + Event per target.
//
// Admin roster: Admin is the only privileged role, and `events/{id}.admins` is the
// roster the app trusts. ADMIN_UID takes a comma-separated list of uids; the target
// roster is 2–4 Admins including Nathan's seed uid (the concrete co-admin uids are
// the #15 decision). The event write merges, and when ADMIN_UID is unset the write
// omits `admins` entirely — so re-running the seed never wipes a granted roster, and
// re-running with the final roster once #15 lands is safe.
//
// Falls back to a serviceAccountKey.json in the project root if one exists
// (gitignored — do NOT commit).
//
// Itinerary (`days[]`): written only when the Event doc doesn't exist yet — the
// schedule stays admin-editable in the Admin console afterward, so a routine
// reseed leaves a live schedule untouched. Pass SEED_DAYS=1 to explicitly
// overwrite `days` on an existing Event (a deliberate itinerary migration).
//
import { pathToFileURL } from 'node:url';
import { PROJECT_DEFAULT_EVENT, resolveSeedEvent } from './seed-data/index.mjs';
import { seedItemDocId } from './seed-data/item-id.mjs';

// ---------------------------------------------------------------------------
// Per-Event seed payloads (#563) live in scripts/seed-data/<event-id>.mjs —
// importable with no side effects (Firebase is only touched when this script
// is executed directly, below). The helpers here (roster parsing, the event
// write payload, item mutations, the drift verifier) are Event-agnostic and
// take the target Event's payload as input, so the drift check works for every
// project rather than comparing one baked pool. `src/test/w1-event-seed.test.ts`
// asserts their behavior per specs/w1-event-seed.md.
// ---------------------------------------------------------------------------

// Re-exported so existing importers (tests, tests/e2e/support) keep one
// canonical source for the content-hash doc id.
export { seedItemDocId };

// Parse the ADMIN_UID env var (comma-separated uids) into the events/{id}.admins roster.
export function adminRoster(raw = '') {
  return raw
    .split(',')
    .map((uid) => uid.trim())
    .filter(Boolean);
}

// The exact object written to events/{id}: `admins` is omitted when the roster is
// empty so a `merge: true` re-run without ADMIN_UID leaves the existing roster alone.
//
// `deleteBlackoutEnabled` is a Firestore delete-field sentinel (`FieldValue.delete()`
// from firebase-admin/firestore), injected by the caller rather than imported at module
// scope so this function stays import-safe without the dev-only firebase-admin install
// (see the dynamic import in `seed()` below). It is written at `settings.blackoutEnabled`
// because a `{ merge: true }` write only touches leaf paths present in the payload:
// re-running this seed against an Event doc the previous seed already wrote —
// which included `blackoutEnabled` — would otherwise leave that stale ADR 0004 field in
// place forever. The sentinel actively deletes it instead of merely omitting it.
// `includeDays` defaults to true (a brand-new Event needs the itinerary written
// once), but a routine reseed against an EXISTING Event must omit `days` — the
// schedule stays admin-editable in the Admin console (daily-cards-spec §
// "Itinerary and schedule": "party order can shift onboard"), and this payload
// is written with `{ merge: true }`, so including `days` here would replace the
// live `days[]` array wholesale on every reseed and silently discard any admin
// edit (Codex P2, PR #229). `seed()` below decides `includeDays` by checking
// whether the Event doc already exists (or via the explicit `SEED_DAYS=1`
// migration override), not this function.
//
// `eventSeed` is the target Event's EVENT_SEED (a scripts/seed-data module) —
// per-Event since #563, so this helper writes whichever Event it is given
// rather than one baked payload.
export function eventWritePayload(eventSeed, admins, deleteBlackoutEnabled, includeDays = true) {
  // Destructure `days` out rather than spreading it in conditionally: setting a
  // key to `undefined` would still send `days: undefined` to the Admin SDK
  // (which throws unless `ignoreUndefinedProperties` is set) instead of simply
  // omitting the field from the merge write.
  const { days, ...seedWithoutDays } = eventSeed;
  return {
    ...(includeDays ? eventSeed : seedWithoutDays),
    settings: {
      ...eventSeed.settings,
      blackoutEnabled: deleteBlackoutEnabled,
    },
    ...(admins.length ? { admins } : {}),
  };
}

/**
 * Whether a seed run may touch the ITEMS of an Event that ALREADY holds
 * seed-owned prompts. Seeding is replace-semantics (never an append — a rerun
 * can NEVER duplicate prompts), but a replace still rewrites every seed-owned
 * doc at the current content-hash ids: against a live Event whose docs have
 * been edited in place (the 2026-08-05 Bodega text pass), that would change
 * doc ids out from under the Day snapshots that reference them. So a rerun
 * against an already-seeded Event leaves the pool UNTOUCHED (a loud no-op)
 * unless RESEED=1 explicitly opts into the replace — a fresh Event (zero
 * seed-owned docs) always seeds.
 */
export function reseedGuard(seedOwnedCount, reseedEnv) {
  if (seedOwnedCount === 0 || reseedEnv === '1') return { allowed: true };
  return {
    allowed: false,
    reason:
      `this event already holds ${seedOwnedCount} seed-owned prompts. ` +
      'A reseed REPLACES the seed-owned pool at current content-hash ids (never appends), which can ' +
      'orphan pre-stamped Day snapshots on a live Event. Re-run with RESEED=1 to replace deliberately.',
  };
}

/**
 * The Day indexes whose stamped `snapshotItemIds` would be ORPHANED by an item
 * replace that is not also rewriting `days[]` (Codex P1, PR #644 round 2): a
 * snapshot id that is being deleted (`deleteIds`) and NOT re-written at the
 * same id (`writeIds`) would reference a document that no longer exists, and
 * every deal for that Day would come up short. Ids outside `deleteIds`
 * (player-submitted or already-gone docs) are not this replace's doing and are
 * ignored. `seed()` refuses a RESEED=1 items replace while any such Day exists
 * unless SEED_DAYS=1 is ALSO set — the days rewrite is what re-stamps the
 * module's canonical snapshot ids.
 */
export function orphanedSnapshotDays(days, deleteIds, writeIds) {
  const deletes = new Set(deleteIds);
  const writes = new Set(writeIds);
  return (Array.isArray(days) ? days : [])
    .filter(
      (d) =>
        Array.isArray(d?.snapshotItemIds) &&
        d.snapshotItemIds.some((id) => deletes.has(id) && !writes.has(id)),
    )
    .map((d) => d.index);
}

/**
 * A seed-script schedule overwrite may only happen before any Day Snapshot
 * exists. A snapshot is the source of truth for already-dealt cards; replacing
 * `days[]` would silently erase its frozen ids (or substitute a module's
 * different ids). The script deliberately fails closed instead of trying to
 * re-stamp a live Day: that operation requires a dedicated transactional
 * maintenance path which proves that no board exists.
 */
export function stampedDayIndexes(days) {
  return (Array.isArray(days) ? days : [])
    .filter((day) => Array.isArray(day?.snapshotItemIds))
    .map((day) => day.index);
}

/**
 * Pick the timestamp for a replacement seed Prompt. Keeping the original
 * seed-entry time makes an ID-changing maintenance reseed safe for a future
 * scheduler stamp of an already-due, but not-yet-snapshotted, Day: its cutoff
 * still admits the replacement ids. A brand-new pool falls back to the first
 * already-due positive unlock (or the run time when every Day is future).
 */
export function seedEntryTimestamp(existingDocs, days, now = Date.now()) {
  const knownSeedTimes = existingDocs
    .filter((doc) => doc.createdBy === 'seed' && typeof doc.createdAt === 'number')
    .map((doc) => doc.createdAt);
  const dueCutoffs = (Array.isArray(days) ? days : [])
    .map((day) => day?.unlockAt)
    .filter((unlockAt) => typeof unlockAt === 'number' && unlockAt > 0 && unlockAt <= now);
  return Math.min(now, ...knownSeedTimes, ...dueCutoffs);
}

/** The timestamp and the Event payload must describe the same schedule. On a
 * fresh Event the existing document has no `days` yet, so use the schedule we
 * are about to atomically install; on a routine reseed preserve the live
 * schedule that the item pool will continue serving. */
export function effectiveSeedSchedule(existingDays, seedDays, includeDays) {
  return includeDays ? seedDays : existingDays;
}

// `pool` is REQUIRED (the target Event's ALL_ITEMS): with per-Event seed data
// (#563) there is no one global pool a default could safely point at, and a
// caller that omitted it would silently seed nothing or the wrong Event's
// prompts — so it fails loudly instead.
export function seedItemMutations(existingDocs, now = Date.now(), pool, fallbackCreatedAt = now) {
  if (!Array.isArray(pool)) {
    throw new Error(
      'seedItemMutations requires the target event pool (its ALL_ITEMS) — per-Event since #563; there is no global default.',
    );
  }
  const existingSeedCreatedAt = new Map(
    existingDocs
      .filter((doc) => doc.createdBy === 'seed' && typeof doc.createdAt === 'number')
      .map((doc) => [doc.id, doc.createdAt]),
  );
  return {
    deleteIds: existingDocs.filter((doc) => doc.createdBy === 'seed').map((doc) => doc.id),
    writes: pool.map(({ text, spicy, pool: itemPool }) => ({
      id: seedItemDocId(text),
      data: {
        text,
        createdBy: 'seed',
        // Keep the matching doc's original entry time; an ID-changing prompt
        // takes the oldest safe seed time supplied by `seedEntryTimestamp`.
        // Otherwise a delayed scheduler would exclude the replacement from a
        // past Day's cutoff and permanently stamp an empty card.
        createdAt: existingSeedCreatedAt.get(seedItemDocId(text)) ?? fallbackCreatedAt,
        isFreeSpace: false,
        status: 'active',
        reportCount: 0,
        spicy,
        // Honor the now-required ItemDoc.pool: main-pool entries in ITEMS carry
        // no `pool` tag of their own (so default to 'main'); embark/farewell
        // entries already carry their own tag.
        pool: itemPool ?? 'main',
      },
    })),
  };
}

// Drift check (#129 reopened): the app renders the pool from Firestore, not from
// the JS bundle, so a change to ITEMS only reaches players once this seed is
// re-run against the live project. Merging + deploying the frontend does NOT
// reseed — so a pool change can pass CI, ship the bundle, and still leave players
// on the OLD pool (exactly what happened after #135: 87-prompt pool merged, but
// events/{id}/items still held the pre-#135 32). `verifySeedPool` compares the
// live SEED-OWNED docs against the canonical `pool` and reports the drift so a
// post-deploy check (or `node scripts/seed.mjs --verify`) fails loudly instead of
// the mismatch going unnoticed. A payload may additionally name one legacy
// content-id per current prompt when a documented in-place production text edit
// preserved frozen snapshot identity; a fresh canonical id remains valid too.
// Player-submitted docs (createdBy !== 'seed') are ignored — they are not part
// of the canonical pool and must never count as drift.
export function verifySeedPool(
  existingDocs,
  // REQUIRED: the target Event's full canonical pool (its ALL_ITEMS — main +
  // both curated pools). Per-Event since #563, so there is no global default a
  // partial pool could silently hide behind: a caller that omits the argument
  // (an ad-hoc smoke check, a test) must fail loudly rather than report OK
  // against the wrong Event's canon — the same failure class Codex P2 (PR
  // #229) flagged when the old default was the main-only ITEMS.
  pool,
  // The auto-hide visibility threshold to check reportCount against. Defaults
  // to 4 — the value every Event seeds today (`settings.reportHideThreshold`,
  // ADR 0004); pass the target Event's own value when they diverge.
  reportHideThreshold = 4,
  // Optional per-prompt legacy ids, in the same order as `pool`. This is a
  // verification allowance only: `seedItemMutations` always writes the current
  // text-derived id for a new Event or an explicitly-safe reseed.
  verifyItemIds = undefined,
) {
  if (!Array.isArray(pool)) {
    throw new Error(
      'verifySeedPool requires the target event pool (its ALL_ITEMS) — per-Event since #563; there is no global default.',
    );
  }
  if (verifyItemIds !== undefined) {
    if (
      !Array.isArray(verifyItemIds) ||
      verifyItemIds.length !== pool.length ||
      verifyItemIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(verifyItemIds).size !== verifyItemIds.length
    ) {
      throw new Error(
        'verifySeedPool verifyItemIds must be a unique, one-to-one list matching the target event pool.',
      );
    }
  }
  const expected = pool.map(({ text, spicy, pool: itemPool }, index) => ({
    canonicalId: seedItemDocId(text),
    // The current content hash always remains valid, so a fresh seed and the
    // documented in-place production identity both verify cleanly. A Set
    // handles the ordinary case where the two ids happen to be the same.
    acceptedIds: [
      ...new Set([seedItemDocId(text), ...(verifyItemIds ? [verifyItemIds[index]] : [])]),
    ],
      // An untagged entry (the main 80-entry pool in ITEMS) defaults to 'main',
      // mirroring the stamp in `seedItemMutations`; a tagged entry (embark/
      // farewell) keeps its own tag — a live seed doc missing `pool` or
      // drifted to another pool is itself drift this check surfaces.
    text,
    spicy,
    isFreeSpace: false,
    status: 'active',
    pool: itemPool ?? 'main',
  }));
  const seedDocs = existingDocs.filter((doc) => doc.createdBy === 'seed');
  const seedById = new Map(seedDocs.map((doc) => [doc.id, doc]));

  // Canonical prompts absent from the live seed pool (a new/renamed prompt that
  // was never seeded — the #135 symptom for every new-text entry).
  const missing = [];
  // Present at either accepted id but a stored field drifted from the canonical
  // record. The doc id is normally a content hash of `text`, so a matching id
  // normally implies matching text — but a malformed or hand-edited doc can
  // carry an accepted id with different stored text, and the whole point of
  // this check is to catch live drift, so compare stored fields exactly (Codex
  // P2, PR #139) rather than trusting identity alone.
  // `spicy` is compared strictly, not by truthiness: firestore.rules require
  // `spicy is bool`, so a live value of `"true"`, `1`, `undefined`, or a missing
  // field (all of which `Boolean(...)` would silently coerce to the "right"
  // answer) is itself drift the check must surface (Codex P2, PR #139).
  const mismatched = [];
  const matchedIds = new Set();
  for (const expectedDoc of expected) {
    const { canonicalId: id, text } = expectedDoc;
    const live = expectedDoc.acceptedIds.map((acceptedId) => seedById.get(acceptedId)).find(Boolean);
    if (!live) {
      missing.push({ id, text });
    } else if (
      live.text !== expectedDoc.text ||
      live.spicy !== expectedDoc.spicy ||
      live.isFreeSpace !== expectedDoc.isFreeSpace ||
      live.status !== expectedDoc.status ||
      live.pool !== expectedDoc.pool ||
      (typeof reportHideThreshold === 'number' &&
        reportHideThreshold > 0 &&
        live.reportCount >= reportHideThreshold)
    ) {
      matchedIds.add(live.id);
      mismatched.push({
        id: live.id,
        text,
        expectedSpicy: expectedDoc.spicy,
        actualSpicy: live.spicy,
        ...(live.text !== text ? { actualText: live.text } : {}),
        ...(live.isFreeSpace !== expectedDoc.isFreeSpace
          ? { expectedIsFreeSpace: expectedDoc.isFreeSpace, actualIsFreeSpace: live.isFreeSpace }
          : {}),
        ...(live.status !== expectedDoc.status
          ? { expectedStatus: expectedDoc.status, actualStatus: live.status }
          : {}),
        ...(live.pool !== expectedDoc.pool
          ? { expectedPool: expectedDoc.pool, actualPool: live.pool }
          : {}),
        ...(typeof reportHideThreshold === 'number' &&
        reportHideThreshold > 0 &&
        live.reportCount >= reportHideThreshold
          ? { reportHideThreshold, actualReportCount: live.reportCount }
          : {}),
      });
    } else {
      matchedIds.add(live.id);
    }
  }
  // Seed-owned docs the canonical pool no longer contains (an old prompt that a
  // reseed should have deleted — the #135 symptom for every retired entry).
  const stale = seedDocs
    .filter((doc) => !matchedIds.has(doc.id))
    .map((doc) => ({ id: doc.id, text: doc.text }));

  return {
    ok: missing.length === 0 && mismatched.length === 0 && stale.length === 0,
    expected: expected.length,
    seedOwned: seedDocs.length,
    playerOwned: existingDocs.length - seedDocs.length,
    missing,
    mismatched,
    stale,
  };
}

// ---------------------------------------------------------------------------
// Seeding — runs only when executed directly (`node scripts/seed.mjs`), so
// importing the payload above never requires the dev-only firebase-admin install.
// ---------------------------------------------------------------------------

// Resolve the Admin SDK + a Firestore handle. Shared by `seed()` (writes) and
// `verify()` (read-only). firebase-admin is a dev dependency used only when this
// script runs directly. The specifiers are computed + @vite-ignore so Vite (which transforms
// this module when a test imports the pure payload/verify builders) never tries
// to resolve them at transform time — Node resolves them normally at run time.
export async function initFirestore() {
  const { readFileSync, existsSync } = await import('node:fs');
  const adminAppModule = 'firebase-admin/app';
  const adminFirestoreModule = 'firebase-admin/firestore';
  let initializeApp, cert, applicationDefault, getFirestore, FieldValue;
  try {
    ({ initializeApp, cert, applicationDefault } = await import(/* @vite-ignore */ adminAppModule));
    ({ getFirestore, FieldValue } = await import(/* @vite-ignore */ adminFirestoreModule));
  } catch (err) {
    // Keep a focused error if a partial or production-only install omitted the
    // dev dependency, rather than surfacing a raw ERR_MODULE_NOT_FOUND.
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

  // Pin the target Firebase project so a bare `node scripts/seed.mjs [--verify]`
  // (npm run seed / verify:seed) can never silently read or write the wrong
  // project (Codex P2, PR #139): prefer the standard env vars, else fall back to
  // the .firebaserc default, and pass it to initializeApp explicitly rather than
  // relying on ADC's ambient project.
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

  // Resolve the target Event: an explicit VITE_EVENT_ID wins; otherwise the
  // resolved project's default Event (#563) so `verify:seed` /
  // `verify:seed:fiveacross` each compare their own project's live pool
  // against that Event's canon. A project with NO registered default is an
  // ERROR, never a fallback (Codex P1, PR #644 round 3): silently selecting
  // med-2026 would seed the Med Event into an unknown project, or verify a
  // project against the wrong canon. `resolveSeedEvent` fails loudly on an
  // Event id this repo has no seed data for.
  const EVENT_ID = process.env.VITE_EVENT_ID || PROJECT_DEFAULT_EVENT[projectId];
  if (!EVENT_ID) {
    console.error(
      `✗ no VITE_EVENT_ID set and project '${projectId || '(unresolved)'}' has no registered default Event ` +
        `(known: ${Object.entries(PROJECT_DEFAULT_EVENT)
          .map(([p, e]) => `${p} → ${e}`)
          .join(', ')}). Set VITE_EVENT_ID explicitly.`,
    );
    process.exit(1);
  }
  const seedEvent = resolveSeedEvent(EVENT_ID);

  const keyUrl = new URL('../serviceAccountKey.json', import.meta.url);
  initializeApp({
    ...(existsSync(keyUrl)
      ? { credential: cert(JSON.parse(readFileSync(keyUrl))) }
      : { credential: applicationDefault() }),
    ...(projectId ? { projectId } : {}),
  });
  // `projectId` rides along for scripts/provision-bodega-preview.mjs (#649),
  // which pins its writes to the fiveacross project.
  return { db: getFirestore(), EVENT_ID, seedEvent, FieldValue, projectId };
}

async function seed() {
  const { db, EVENT_ID, seedEvent, FieldValue } = await initFirestore();
  const { EVENT_SEED, ALL_ITEMS } = seedEvent;
  const admins = adminRoster(process.env.ADMIN_UID);

  const eventRef = db.doc(`events/${EVENT_ID}`);
  // Write `days` when creating the Event, when the existing Event has no
  // schedule yet (missing/empty `days`), or when SEED_DAYS=1 explicitly opts
  // into overwriting it (e.g. a deliberate itinerary migration). A routine
  // reseed against an existing Event that already HAS a schedule (to refresh
  // prompts, grant an admin, etc.) must never clobber a live, admin-edited
  // schedule (Codex P2, PR #229 — daily-cards-spec § "Itinerary and
  // schedule": "the schedule stays admin-editable in the Admin console").
  // Checking existence alone missed the case where the Event doc was created
  // without a schedule (e.g. med-2026 pre-dating this migration): the
  // existence check alone left `days` permanently missing until an operator
  // knew to pass SEED_DAYS=1 (Codex P1, PR #229).
  const col = eventRef.collection('items');

  // Replace semantics, not append (w1-seed-and-composition): every SEED-OWNED
  // item doc is deleted and the current ITEMS are (re)written in ONE atomic
  // transaction (Codex P2, PR #135) — not a delete operation committed
  // separately from the writes, which would leave events/{id}/items with no
  // seed prompts (and joinAndDeal short of MIN_POOL) if the process died
  // between commits. A doc whose id is unchanged across reseeds (same text)
  // gets a delete followed by a set within the transaction, so the set is what
  // lands. The delete pass is scoped to `createdBy === 'seed'`
  // (CodeRabbit Major, PR #135) — addItem writes live Player-submitted
  // prompts into this SAME collection with their own uid as createdBy, so an
  // unscoped delete-everything would erase user content on every reseed.
  // A seed is a single Firestore transaction, rather than a preflight read
  // followed by a batch. That makes the Day snapshot interlocks a true
  // precondition: if the scheduler stamps a Day or another seed changes the
  // pool after either read, Firestore retries the whole callback against the
  // current Event and collection before it can replace anything.
  const runAt = Date.now();
  const refusal = (message) => Object.assign(new Error(message), { code: 'seed-safety-refusal' });
  let result;
  try {
    result = await db.runTransaction(async (transaction) => {
      const [existingEventSnap, existing] = await Promise.all([
        transaction.get(eventRef),
        transaction.get(col),
      ]);
      const existingDays = existingEventSnap.data()?.days;
      const hasScheduledDays = Array.isArray(existingDays) && existingDays.length > 0;
      const includeDays = !hasScheduledDays || process.env.SEED_DAYS === '1';
      const seedOwnedCount = existing.docs.filter((doc) => doc.data().createdBy === 'seed').length;
      const guard = reseedGuard(seedOwnedCount, process.env.RESEED);
      if (!guard.allowed) {
        // A refused items replace must also refuse a requested Day rewrite. In
        // particular, Bodega's canonical Day 0 snapshot ids are not necessarily
        // the ids in its live, in-place-edited pool; writing them by themselves
        // would strand the existing card pool. The safe no-op still permits the
        // metadata-only admin-roster/config merge.
        transaction.set(eventRef, eventWritePayload(EVENT_SEED, admins, FieldValue.delete(), false), {
          merge: true,
        });
        return { skipped: true, reason: guard.reason };
      }

      const existingDocs = existing.docs.map((doc) => ({
        id: doc.id,
        createdBy: doc.data().createdBy,
        createdAt: doc.data().createdAt,
      }));
      const { deleteIds, writes } = seedItemMutations(
        existingDocs,
        runAt,
        ALL_ITEMS,
        seedEntryTimestamp(
          existingDocs,
          effectiveSeedSchedule(existingDays, EVENT_SEED.days, includeDays),
          runAt,
        ),
      );
      if (includeDays) {
        const stampedDays = stampedDayIndexes(existingDays);
        if (stampedDays.length) {
          throw refusal(
            `✗ events/${EVENT_ID}: refusing SEED_DAYS=1 because Day ${stampedDays.join(', ')} already has a frozen snapshot. ` +
              'A schedule rewrite may only happen before snapshots exist; use a dedicated transactional maintenance path that proves zero boards before any re-stamp. Nothing was written.',
          );
        }
      }
      // Snapshot-integrity interlock: if this replace deletes ids a stamped Day
      // snapshot still references WITHOUT rewriting `days[]`, that Day would
      // deal from documents that no longer exist. This is evaluated inside the
      // transaction so a scheduler stamp that races us causes a retry, not an
      // orphaned snapshot.
      if (!includeDays) {
        const orphaned = orphanedSnapshotDays(existingDays, deleteIds, writes.map((w) => w.id));
        if (orphaned.length) {
          throw refusal(
            `✗ events/${EVENT_ID}: replacing the seed-owned pool would orphan the stamped snapshot on Day ${orphaned.join(', ')} ` +
              '(snapshotItemIds reference ids this replace deletes without rewriting). ' +
              'Do not re-run with SEED_DAYS=1: schedule overwrites are also refused after a snapshot. ' +
              'Use a dedicated transactional maintenance path that proves zero dealt boards before any re-stamp. Nothing was written.',
          );
        }
      }
      transaction.set(
        eventRef,
        eventWritePayload(EVENT_SEED, admins, FieldValue.delete(), includeDays),
        { merge: true },
      );
      for (const id of deleteIds) transaction.delete(col.doc(id));
      for (const { id, data } of writes) transaction.set(col.doc(id), data, { merge: true });
      return { skipped: false };
    });
  } catch (error) {
    if (error?.code === 'seed-safety-refusal') {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  if (result.skipped) {
    console.log(`Event doc written (merge). Prompts SKIPPED: ${result.reason}`);
    console.log(
      admins.length
        ? `Admins: set (${admins.length})`
        : 'No ADMIN_UID set — set the roster (comma-separated uids) and re-run to grant admin.',
    );
    process.exit(0);
  }

  // Self-check: read the collection back and confirm the live seed pool now
  // matches the canonical ALL_ITEMS (main + both curated pools). A green seed
  // run that leaves drift (failed transaction, wrong project, stale doc a scoped
  // delete missed) should fail loudly right here, not weeks later when a
  // player notices the old prompts.
  const report = verifySeedPool(
    (await col.get()).docs.map((doc) => ({
      id: doc.id,
      text: doc.data().text,
      createdBy: doc.data().createdBy,
      spicy: doc.data().spicy,
      isFreeSpace: doc.data().isFreeSpace,
      status: doc.data().status,
      reportCount: doc.data().reportCount,
      pool: doc.data().pool,
    })),
    ALL_ITEMS,
    EVENT_SEED.settings.reportHideThreshold,
    seedEvent.VERIFY_ITEM_IDS,
  );
  if (!report.ok) {
    console.error(formatDriftReport(report, EVENT_ID));
    process.exit(1);
  }

  console.log(`Seeded ${ALL_ITEMS.length} prompts into events/${EVENT_ID}.`);
  // Redacted on purpose (CodeQL js/clear-text-logging, alert #2): report that the
  // roster was set — and how many uids parsed — without echoing the env-sourced uids.
  console.log(
    admins.length
      ? `Admins: set (${admins.length})`
      : 'No ADMIN_UID set — set the roster (comma-separated uids) and re-run to grant admin.',
  );
  process.exit(0);
}

// Render a `verifySeedPool` drift report as a human-readable, actionable block.
// Only the first few entries per bucket are listed so a wholesale reseed (dozens
// of missing/stale) stays readable; the counts tell the full story.
export function formatDriftReport(report, eventId) {
  const preview = (rows) =>
    rows
      .slice(0, 5)
      .map((r) => JSON.stringify(r.text))
      .join(', ') + (rows.length > 5 ? ', …' : '');
  const lines = [
    `✗ events/${eventId}/items DRIFTS from the canonical ${report.expected}-prompt pool`,
    `  live seed-owned: ${report.seedOwned}   player-owned (ignored): ${report.playerOwned}`,
  ];
  if (report.missing.length)
    lines.push(`  missing from live (${report.missing.length}): ${preview(report.missing)}`);
  if (report.stale.length)
    lines.push(`  stale in live (${report.stale.length}): ${preview(report.stale)}`);
  if (report.mismatched.length)
    lines.push(`  field drift (${report.mismatched.length}): ${preview(report.mismatched)}`);
  // Reconcile with a bare reseed — NO ADMIN_UID. The seed's event write merges,
  // and omitting ADMIN_UID leaves `events/{id}.admins` untouched (a reseed to
  // refresh prompts must never overwrite the live admin roster, Codex P2 PR
  // #139). ADMIN_UID is only for the separate act of *granting* admin.
  //
  // Echo the SAME target the drift was found against, not a hardcoded default
  // (Codex P2, PR #139): carry the resolved project and the explicit
  // `VITE_EVENT_ID` (always, now that Events are per-project — #563), so a
  // copy-pasted reconcile command reseeds the event that actually drifted
  // rather than a different one.
  const project =
    process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'gaycruisebingo';
  const eventEnv = eventId ? `VITE_EVENT_ID=${eventId} ` : '';
  lines.push(
    `  → reconcile (prompts only, replaces the seed-owned pool): ADMIN_UID= RESEED=1 ${eventEnv}GOOGLE_CLOUD_PROJECT=${project} node scripts/seed.mjs`,
    // A replace that changes doc ids would orphan any Day's pre-stamped
    // snapshotItemIds; seed() refuses that combination outright and names the
    // affected Days (Codex P1, PR #644 round 2), so the caution rides the
    // command it applies to.
    '    (if a Day carries a pre-stamped snapshot, do not run this command: use a dedicated transactional maintenance path that proves zero dealt boards)',
  );
  return lines.join('\n');
}

// Read-only drift check (`node scripts/seed.mjs --verify`). Never writes — safe
// to run as a post-deploy smoke test. Exits 0 when the live seed pool matches
// the target Event's canonical ALL_ITEMS (main + both curated pools), 1 (with
// an actionable report) when it drifts.
async function verify() {
  const { db, EVENT_ID, seedEvent } = await initFirestore();
  const snap = await db.collection(`events/${EVENT_ID}/items`).get();
  const report = verifySeedPool(
    snap.docs.map((doc) => ({
      id: doc.id,
      text: doc.data().text,
      createdBy: doc.data().createdBy,
      spicy: doc.data().spicy,
      isFreeSpace: doc.data().isFreeSpace,
      status: doc.data().status,
      reportCount: doc.data().reportCount,
      pool: doc.data().pool,
    })),
    seedEvent.ALL_ITEMS,
    seedEvent.EVENT_SEED.settings.reportHideThreshold,
    seedEvent.VERIFY_ITEM_IDS,
  );
  if (report.ok) {
    console.log(
      `✓ events/${EVENT_ID}/items matches the canonical ${report.expected}-prompt pool ` +
        `(${report.seedOwned} seed-owned, ${report.playerOwned} player-owned).`,
    );
    process.exit(0);
  }
  console.error(formatDriftReport(report, EVENT_ID));
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--verify')) await verify();
  else await seed();
}
