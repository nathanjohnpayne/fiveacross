#!/usr/bin/env node
// Pre-deploy audit for Prompts hidden while still `pending` (#1275, ADR 0015).
//
// WHY THIS EXISTS. Before #1275 an Admin client could move an item
// `pending -> hidden`. The #1275 rules close that move and route every
// `pending -> active` flip through the `approvePrompts` callable, but they keep
// the manual `hidden -> active` restore, which carries no provenance. A row
// hidden while it was still pending under the OLD rules would therefore become
// `active` on a Restore click without ever being routed or stamped by the
// server: the approval bypass the callable exists to close. No new row can
// reach that state once the rules ship (`pending -> hidden` is denied to every
// client, and the server-side hide only ever hides `active` rows), so the
// exposure is bounded to rows that already exist. This script finds them and,
// with `--requeue`, puts them back in the Approvals queue.
//
// WHAT COUNTS. A `hidden` item with no valid finite numeric `approvedAt` whose
// `createdBy` is neither the seed (`'seed'`) nor on the Event's current `admins`
// roster. Every row that
// ever went `pending -> active` through approval carries `approvedAt` (the #210
// approval flow stamped it from the start), seeded rows are `createdBy: 'seed'`,
// and organiser Prompts (`adminAddItem`) are created `active` by an Admin. What
// is left is a player submission that was never approved. The scan cannot tell
// one of those apart from a player row created `active` before #210 existed, so
// such a row is listed too: requeueing it costs one explicit Approve.
//
// WHAT IT CANNOT SEE. `rejectItem` stamps `approvedAt` too, so a row an Admin
// rejected and then moved `rejected -> hidden` under the old rules carries the
// same provenance as an approved row and is not listed. Reaching that state took
// two deliberate Admin writes, and restoring it takes a third; it stays a named
// trusted-Admin residual beside the others in ADR 0015 § Consequences.
//
// WHAT --requeue DOES. Sets `status: 'pending'` on each listed row, and nothing
// else, inside a transaction that re-reads the row and the Event roster and
// skips any row that no longer qualifies. `pending` is where the row was when it
// was hidden, and from there the only way to `active` is the callable, which
// routes it and stamps it on the server clock. Nothing is deleted or rejected;
// the Admin decides in the queue.
//
// FAIL-CLOSED. The dry run (the default) exits 1 when it lists any row, so a
// deploy checklist step that runs it stops until the rows are requeued or
// consciously accepted. Run it against each project before the first deploy of
// the #1275 rules (ADR 0015 § Consequences, specs/d15-approvals.md).
//
// Usage:
//   npm run audit:pending-hidden -- <gaycruisebingo|fiveacross>            # list; exit 1 if any
//   npm run audit:pending-hidden -- <gaycruisebingo|fiveacross> --requeue  # move them to pending
//
// Credentials resolve exactly as scripts/seed.mjs does (Application Default
// Credentials, or a gitignored repo-root serviceAccountKey.json for a dry run).
// The pure planning core above the runtime boundary imports no firebase-admin,
// so scripts/audit-pending-hidden-items.test.mjs asserts it without credentials.
import { pathToFileURL } from 'node:url';
import { DEPLOY_TARGETS } from './build-target.mjs';

/** The `createdBy` every seeded default Prompt carries (scripts/seed.mjs). */
export const SEED_AUTHOR = 'seed';

/**
 * Is this stored item a Prompt that may have been hidden while pending? Pure
 * over the raw Firestore data and the Event's raw `admins` value, both of which
 * are checked before they are trusted.
 */
export function isPendingHiddenCandidate(item, admins) {
  if (item == null || typeof item !== 'object') return false;
  if (item.status !== 'hidden') return false;
  if (typeof item.approvedAt === 'number' && Number.isFinite(item.approvedAt)) return false;
  if (item.createdBy === SEED_AUTHOR) return false;
  const roster = Array.isArray(admins) ? admins : [];
  if (typeof item.createdBy === 'string' && roster.includes(item.createdBy)) return false;
  return true;
}

/**
 * Plan the audit over every Event read. `events` is
 * `[{ eventId, admins, items: [{ id, data }] }]`; returns the candidate rows in
 * a stable order (Event id, then item id) with the fields a human needs to
 * judge them.
 */
export function planPendingHiddenAudit(events) {
  const candidates = [];
  for (const event of Array.isArray(events) ? events : []) {
    for (const item of Array.isArray(event.items) ? event.items : []) {
      if (!isPendingHiddenCandidate(item.data, event.admins)) continue;
      candidates.push({
        eventId: event.eventId,
        itemId: item.id,
        createdBy: typeof item.data.createdBy === 'string' ? item.data.createdBy : null,
        createdAt: typeof item.data.createdAt === 'number' ? item.data.createdAt : null,
        text: typeof item.data.text === 'string' ? item.data.text : '',
      });
    }
  }
  candidates.sort((a, b) =>
    a.eventId === b.eventId ? (a.itemId < b.itemId ? -1 : 1) : a.eventId < b.eventId ? -1 : 1,
  );
  return { candidates };
}

/** Parse `<target> [--requeue]`; anything else is refused. */
export function parseAuditArgs(argv) {
  let target;
  let requeue = false;
  for (const arg of argv) {
    if (arg === '--requeue') {
      requeue = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`pending-hidden audit: unknown argument ${arg}.`);
    if (target !== undefined) throw new Error('pending-hidden audit: exactly one target is allowed.');
    target = arg;
  }
  if (target === undefined || !Object.hasOwn(DEPLOY_TARGETS, target)) {
    throw new Error(
      `pending-hidden audit: an explicit target is required (${Object.keys(DEPLOY_TARGETS).join('|')}).`,
    );
  }
  return { target, projectId: DEPLOY_TARGETS[target].firebaseProject, requeue };
}

/** One line per candidate, for the console. */
export function formatAuditReport(plan) {
  return plan.candidates
    .map(
      (c) =>
        `  events/${c.eventId}/items/${c.itemId}  createdBy=${c.createdBy ?? '(none)'}  ` +
        `createdAt=${c.createdAt == null ? '(none)' : new Date(c.createdAt).toISOString()}  ` +
        `text=${JSON.stringify(c.text.slice(0, 80))}`,
    )
    .join('\n');
}

/** Read every Event and its hidden items. */
async function readAuditInput(db) {
  const events = [];
  const eventSnaps = await db.collection('events').get();
  for (const eventSnap of eventSnaps.docs) {
    const itemSnaps = await db
      .collection(`events/${eventSnap.id}/items`)
      .where('status', '==', 'hidden')
      .get();
    events.push({
      eventId: eventSnap.id,
      admins: eventSnap.data()?.admins,
      items: itemSnaps.docs.map((d) => ({ id: d.id, data: d.data() })),
    });
  }
  return events;
}

/**
 * Run the audit against an initialized Firestore. Returns
 * `{ plan, requeued, skipped }`; `requeued`/`skipped` are empty on a dry run.
 * Each requeue is its own transaction that re-reads the row and the roster, so
 * a row restored, approved or re-rostered since the scan is skipped, never
 * overwritten.
 */
export async function runPendingHiddenAudit(db, { requeue = false, log = console.log } = {}) {
  const plan = planPendingHiddenAudit(await readAuditInput(db));
  if (plan.candidates.length === 0) {
    log('pending-hidden audit: no hidden row lacks approval provenance. ✅');
    return { plan, requeued: [], skipped: [] };
  }
  log(`pending-hidden audit: ${plan.candidates.length} hidden row(s) with no approval provenance:`);
  log(formatAuditReport(plan));
  if (!requeue) return { plan, requeued: [], skipped: [] };

  const requeued = [];
  const skipped = [];
  for (const c of plan.candidates) {
    const itemRef = db.doc(`events/${c.eventId}/items/${c.itemId}`);
    const eventRef = db.doc(`events/${c.eventId}`);
    let wrote = false;
    await db.runTransaction(async (tx) => {
      // Reset per attempt: a retried callback must report only what committed.
      wrote = false;
      const eventSnap = await tx.get(eventRef);
      const itemSnap = await tx.get(itemRef);
      if (!itemSnap.exists) return;
      if (!isPendingHiddenCandidate(itemSnap.data(), eventSnap.exists ? eventSnap.data()?.admins : undefined)) {
        return;
      }
      tx.update(itemRef, { status: 'pending' });
      wrote = true;
    });
    (wrote ? requeued : skipped).push(c);
  }
  log(`pending-hidden audit: requeued ${requeued.length} row(s) to pending; skipped ${skipped.length} that changed since the scan.`);
  return { plan, requeued, skipped };
}

// ---------------------------------------------------------------------------
// Runtime boundary: firebase-admin is loaded only when run directly.
// ---------------------------------------------------------------------------

async function main() {
  const { target, projectId, requeue } = parseAuditArgs(process.argv.slice(2));
  // Pin the shared initializer to the named project, and never let an ambient
  // Event id redirect it (the same guard scripts/migrate-marker-event-id.mjs uses).
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  process.env.VITE_EVENT_ID = DEPLOY_TARGETS[target].identity.VITE_EVENT_ID || '';
  const { initFirestore } = await import('./seed.mjs');
  const initialized = await initFirestore({ allowLocalServiceAccountKey: !requeue });
  if (initialized.projectId !== projectId) {
    throw new Error(
      `pending-hidden audit: refusing Firestore project ${initialized.projectId || '(none)'}; expected ${projectId}.`,
    );
  }
  console.log(`pending-hidden audit: target=${target} project=${projectId} mode=${requeue ? 'REQUEUE' : 'DRY-RUN'}`);
  const { plan } = await runPendingHiddenAudit(initialized.db, { requeue });
  if (!requeue) {
    if (plan.candidates.length > 0) {
      console.log('Dry run only: nothing was changed. Requeue with --requeue, or record why each row may stay hidden.');
      process.exitCode = 1;
    }
    return;
  }
  // Exit 0 only when a fresh scan after the requeue finds nothing left.
  const { plan: after } = await runPendingHiddenAudit(initialized.db, { requeue: false });
  if (after.candidates.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'pending-hidden audit failed.');
    process.exitCode = 1;
  });
}
