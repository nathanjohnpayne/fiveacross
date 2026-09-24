#!/usr/bin/env node
// Pre-deploy audit for Prompts that may have been hidden while still `pending`
// (#1275, ADR 0015).
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
// exposure is bounded to rows that already exist, and this is a one-time step.
//
// WHAT COUNTS. Every `hidden` item whose `createdBy` is neither the seed
// (`'seed'`) nor on the Event's current `admins` roster. `createdBy` is the one
// provenance a submitter cannot forge (`firestore.rules` binds it to
// `request.auth.uid` on create). `approvedAt`/`approvedBy` are deliberately NOT
// used to rule a row out: the non-admin create arm has no key whitelist, so a
// submitter could have arrived with a forged `approvedAt`, and `rejectItem`
// stamps it too. They are printed for the operator's judgement only. The list
// therefore also includes rows that are legitimately restorable, such as an
// approved player Prompt the community hid, or an organiser Prompt whose author
// has since left the roster; the operator decides each one.
//
// HOW IT IS DISPOSED. Every listed row needs an explicit decision:
//   --accept <eventId>/<itemId>   keep it as it is (it stays restorable). Repeatable.
//   --requeue                     move every listed row NOT accepted to `pending`.
// A requeue sets `status: 'pending'` and nothing else, in a transaction that
// re-reads the row and the Event roster and skips a row that no longer
// qualifies. From `pending` the only way to `active` is the callable, which
// routes it and stamps it on the server clock. Nothing is deleted or rejected.
//
// FAIL-CLOSED. The run exits 0 only when every row a fresh scan lists is
// accepted, so a deploy checklist step that runs it stops until each row has a
// decision. An `--accept` naming a row the scan does not list is refused, so a
// typo cannot pass for a decision. Run it against each project before the first
// deploy of the #1275 rules (ADR 0015 § Consequences, specs/d15-approvals.md).
//
// Usage:
//   npm run audit:pending-hidden -- <gaycruisebingo|fiveacross>
//   npm run audit:pending-hidden -- <project> --accept <eventId>/<itemId> [--accept ...]
//   npm run audit:pending-hidden -- <project> [--accept ...] --requeue
//
// Credentials resolve exactly as scripts/seed.mjs does (Application Default
// Credentials, or a gitignored repo-root serviceAccountKey.json for a read-only
// run). The pure core above the runtime boundary imports no firebase-admin, so
// scripts/audit-pending-hidden-items.test.mjs asserts it without credentials.
import { pathToFileURL } from 'node:url';
import { DEPLOY_TARGETS } from './build-target.mjs';

/** The `createdBy` every seeded default Prompt carries (scripts/seed.mjs). */
export const SEED_AUTHOR = 'seed';

/**
 * Could this stored item be a Prompt hidden while pending? Pure over the raw
 * Firestore data and the Event's raw `admins` value, both checked before use.
 */
export function isPendingHiddenCandidate(item, admins) {
  if (item == null || typeof item !== 'object') return false;
  if (item.status !== 'hidden') return false;
  if (item.createdBy === SEED_AUTHOR) return false;
  const roster = Array.isArray(admins) ? admins : [];
  if (typeof item.createdBy === 'string' && roster.includes(item.createdBy)) return false;
  return true;
}

/** `<eventId>/<itemId>`, the key an operator names a row by. */
export const candidateKey = (c) => `${c.eventId}/${c.itemId}`;

/** A finite epoch-ms value as ISO, or a marker; never throws on a raw value. */
export function formatEpochMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(none)';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? `(invalid ${value})` : date.toISOString();
}

/**
 * Plan the audit over every Event read. `events` is
 * `[{ eventId, admins, items: [{ id, data }] }]`; returns the candidate rows in
 * a stable order (Event id, then item id) with the fields a human needs.
 */
export function planPendingHiddenAudit(events) {
  const candidates = [];
  for (const event of Array.isArray(events) ? events : []) {
    for (const item of Array.isArray(event.items) ? event.items : []) {
      if (!isPendingHiddenCandidate(item.data, event.admins)) continue;
      const d = item.data;
      candidates.push({
        eventId: event.eventId,
        itemId: item.id,
        createdBy: typeof d.createdBy === 'string' ? d.createdBy : null,
        createdAt: d.createdAt,
        approvedAt: d.approvedAt,
        approvedBy: typeof d.approvedBy === 'string' ? d.approvedBy : null,
        text: typeof d.text === 'string' ? d.text : '',
      });
    }
  }
  candidates.sort((a, b) => (candidateKey(a) < candidateKey(b) ? -1 : candidateKey(a) > candidateKey(b) ? 1 : 0));
  return { candidates };
}

/** Parse `<target> [--accept <eventId>/<itemId>]... [--requeue]`. */
export function parseAuditArgs(argv) {
  let target;
  let requeue = false;
  const accepted = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--requeue') {
      requeue = true;
      continue;
    }
    if (arg === '--accept') {
      const key = argv[i + 1];
      if (typeof key !== 'string' || !/^[^/]+\/[^/]+$/.test(key)) {
        throw new Error('pending-hidden audit: --accept takes <eventId>/<itemId>.');
      }
      accepted.add(key);
      i += 1;
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
  return { target, projectId: DEPLOY_TARGETS[target].firebaseProject, requeue, accepted };
}

/**
 * Split a plan by the operator's decisions. An accepted key the plan does not
 * list is an error, so a typo or a stale id can never pass for a decision.
 */
export function disposeCandidates(plan, accepted) {
  const listed = new Set(plan.candidates.map(candidateKey));
  const unknown = [...accepted].filter((key) => !listed.has(key)).sort();
  return {
    unknown,
    accepted: plan.candidates.filter((c) => accepted.has(candidateKey(c))),
    undecided: plan.candidates.filter((c) => !accepted.has(candidateKey(c))),
  };
}

/** One line per candidate, for the console. */
export function formatAuditReport(candidates, accepted = new Set()) {
  return candidates
    .map(
      (c) =>
        `  ${accepted.has(candidateKey(c)) ? 'accepted ' : 'UNDECIDED'} ${candidateKey(c)}  ` +
        `createdBy=${c.createdBy ?? '(none)'}  createdAt=${formatEpochMs(c.createdAt)}  ` +
        `approvedAt=${formatEpochMs(c.approvedAt)} (unverified)  approvedBy=${c.approvedBy ?? '(none)'}  ` +
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
 * `{ plan, unknown, undecided, requeued, skipped, clean }`. `clean` is true only
 * when a scan AFTER any requeue lists nothing that was not accepted.
 */
export async function runPendingHiddenAudit(
  db,
  { requeue = false, accepted = new Set(), log = console.log } = {},
) {
  const plan = planPendingHiddenAudit(await readAuditInput(db));
  const first = disposeCandidates(plan, accepted);
  if (first.unknown.length > 0) {
    throw new Error(
      `pending-hidden audit: --accept names row(s) the scan does not list: ${first.unknown.join(', ')}. Nothing was changed.`,
    );
  }
  log(`pending-hidden audit: ${plan.candidates.length} hidden row(s) need a decision; ${first.accepted.length} accepted.`);
  if (plan.candidates.length > 0) log(formatAuditReport(plan.candidates, accepted));

  const requeued = [];
  const skipped = [];
  if (requeue) {
    for (const c of first.undecided) {
      const itemRef = db.doc(`events/${c.eventId}/items/${c.itemId}`);
      const eventRef = db.doc(`events/${c.eventId}`);
      let wrote = false;
      await db.runTransaction(async (tx) => {
        // Reset per attempt: a retried callback must report only what committed.
        wrote = false;
        const eventSnap = await tx.get(eventRef);
        const itemSnap = await tx.get(itemRef);
        if (!itemSnap.exists) return;
        const admins = eventSnap.exists ? eventSnap.data()?.admins : undefined;
        if (!isPendingHiddenCandidate(itemSnap.data(), admins)) return;
        tx.update(itemRef, { status: 'pending' });
        wrote = true;
      });
      (wrote ? requeued : skipped).push(c);
    }
    log(`pending-hidden audit: requeued ${requeued.length} row(s) to pending; ${skipped.length} changed since the scan and were left alone.`);
  }

  const after = requeue ? disposeCandidates(planPendingHiddenAudit(await readAuditInput(db)), accepted) : first;
  const clean = after.undecided.length === 0;
  log(
    clean
      ? 'pending-hidden audit: every listed row has a decision. ✅'
      : `pending-hidden audit: ${after.undecided.length} row(s) still undecided: accept each with --accept, or requeue with --requeue.`,
  );
  return { plan, unknown: first.unknown, undecided: after.undecided, requeued, skipped, clean };
}

// ---------------------------------------------------------------------------
// Runtime boundary: firebase-admin is loaded only when run directly.
// ---------------------------------------------------------------------------

async function main() {
  const { target, projectId, requeue, accepted } = parseAuditArgs(process.argv.slice(2));
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
  console.log(`pending-hidden audit: target=${target} project=${projectId} mode=${requeue ? 'REQUEUE' : 'READ-ONLY'}`);
  const { clean } = await runPendingHiddenAudit(initialized.db, { requeue, accepted });
  if (!clean) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'pending-hidden audit failed.');
    process.exitCode = 1;
  });
}
