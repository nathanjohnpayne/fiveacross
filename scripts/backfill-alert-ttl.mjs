#!/usr/bin/env node
/**
 * One-time rollout backfill for the admin-alert retention boundary (#670).
 *
 * WHY THIS EXISTS. `enqueueAdminAlerts` and the digest's freeze now write an
 * `expiresAt` on every document they create, and `docs/app/phase-1-deploy.md`
 * enables a Firestore TTL policy on each collection group so those documents
 * collect themselves. But **TTL only ever looks at documents that already carry
 * a timestamp in the named field** — it does not reap a document that lacks it.
 *
 * So enabling the policies does nothing for anything written BEFORE the deploy,
 * and that legacy set is exactly the population the retention change is for
 * (Phase 4b P1):
 *
 *   - Pending `adminAlerts` rows under an ARCHIVED Event. The sweep only visits
 *     `status == 'active'` Events, so nothing will ever revisit these rows to
 *     drain or tombstone them, and each one holds a copy of user content — a
 *     pending Prompt's words, a hidden Proof's text, a reporter's description.
 *   - Frozen `adminAlertBatches` documents whose delivery kept failing. Each one
 *     holds a FULLY RENDERED email: every pending and hidden item in that batch
 *     at once, the densest copy of user content in the system.
 *
 * Both would otherwise persist forever, with the policies enabled and reaping
 * nothing — the worst outcome, because the deploy doc would claim a boundary
 * that does not exist.
 *
 * WHAT IT DOES. Walks both collection groups and stamps `expiresAt` on any
 * document missing one, so the TTL policies can see them. It never touches a
 * document that already has the field: a live row's own deadline is already
 * correct, and rewriting it would extend the retention of the thing being
 * bounded.
 *
 * The stamp is `PENDING_TTL_MS` from the document's own `createdAt` where it has
 * a usable one — so a row queued months ago is already due rather than granted
 * another month — falling back to "now" only when the document carries no
 * readable timestamp at all.
 *
 * Firestore cannot query for a MISSING field, so this reads the collection
 * groups page by page and filters client-side. The queues are transient by
 * design, so the volume is small; the paging is there so a pathological backlog
 * cannot exhaust memory.
 *
 * Usage:
 *   node scripts/backfill-alert-ttl.mjs --project <projectId> [--dry-run]
 *
 * Run it ONCE per Firebase project, AFTER deploying the functions that write the
 * field and enabling both TTL policies. It is idempotent: a second run finds
 * nothing left to stamp, because everything it wrote now has the field.
 */
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

/** Mirrors `PENDING_TTL_MS` in functions/src/adminAlerts.ts. Restated rather
 *  than imported because that module is TypeScript compiled for the Functions
 *  runtime; the parity is asserted in scripts/backfill-alert-ttl.test.mjs. */
export const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Both collection groups that hold a copy of user content behind a TTL. */
export const TTL_COLLECTION_GROUPS = ['adminAlerts', 'adminAlertBatches'];

const PAGE_SIZE = 300;

/**
 * The deadline to stamp on one legacy document.
 *
 * Anchored to the document's OWN `createdAt` so age is honored: a row queued
 * three months ago is already past due and is reaped on the next TTL pass,
 * rather than being handed a fresh thirty days by the act of repairing it. Only
 * a document with no readable timestamp falls back to `now`, which is the
 * cautious direction — it keeps an unreadable document for one more window
 * instead of deleting something whose age cannot be established.
 */
export function expiryFor(data, now, ttlMs = PENDING_TTL_MS) {
  const createdAt = data?.createdAt;
  if (typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0) {
    return new Date(createdAt + ttlMs);
  }
  if (typeof createdAt?.toMillis === 'function') {
    const millis = createdAt.toMillis();
    if (Number.isFinite(millis) && millis > 0) return new Date(millis + ttlMs);
  }
  if (createdAt instanceof Date && Number.isFinite(createdAt.getTime())) {
    return new Date(createdAt.getTime() + ttlMs);
  }
  return new Date(now + ttlMs);
}

/** Does this document still need a stamp? Anything already carrying a usable
 *  timestamp is left exactly as it is — rewriting a live deadline would extend
 *  the retention this exists to bound. */
export function needsStamp(data) {
  const expiresAt = data?.expiresAt;
  if (expiresAt == null) return true;
  if (expiresAt instanceof Date) return !Number.isFinite(expiresAt.getTime());
  if (typeof expiresAt?.toMillis === 'function') return !Number.isFinite(expiresAt.toMillis());
  // A number, a string, or anything else is NOT a timestamp, so the TTL service
  // ignores it — the document is unprotected and must be stamped properly.
  return true;
}

export async function backfillCollectionGroup(db, group, { now, dryRun, pageSize = PAGE_SIZE, log = () => {} }) {
  let cursor = null;
  let scanned = 0;
  let stamped = 0;
  for (;;) {
    let query = db.collectionGroup(group).orderBy('__name__').limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    const pending = [];
    for (const doc of page.docs) {
      scanned += 1;
      const data = doc.data();
      if (!needsStamp(data)) continue;
      pending.push({ ref: doc.ref, expiresAt: expiryFor(data, now) });
    }
    if (pending.length > 0 && !dryRun) {
      const batch = db.batch();
      for (const { ref, expiresAt } of pending) {
        batch.set(ref, { expiresAt: Timestamp.fromDate(expiresAt) }, { merge: true });
      }
      await batch.commit();
    }
    stamped += pending.length;
    for (const { ref, expiresAt } of pending) {
      log(`${dryRun ? 'would stamp' : 'stamped'} ${ref.path} -> ${expiresAt.toISOString()}`);
    }
    cursor = page.docs[page.docs.length - 1];
    if (page.docs.length < pageSize) break;
  }
  return { group, scanned, stamped };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const projectId = args[args.indexOf('--project') + 1];
  if (!args.includes('--project') || !projectId || projectId.startsWith('--')) {
    console.error('Usage: node scripts/backfill-alert-ttl.mjs --project <projectId> [--dry-run]');
    process.exit(2);
  }
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  initializeApp(
    credentialsPath
      ? { credential: cert(JSON.parse(readFileSync(credentialsPath, 'utf8'))), projectId }
      : { projectId },
  );
  const db = getFirestore();
  const now = Date.now();
  console.log(`backfill-alert-ttl: project=${projectId} dryRun=${dryRun}`);
  for (const group of TTL_COLLECTION_GROUPS) {
    const result = await backfillCollectionGroup(db, group, { now, dryRun, log: (line) => console.log(`  ${line}`) });
    console.log(`  ${result.group}: scanned=${result.scanned} stamped=${result.stamped}`);
  }
}

// Importable for tests; only the direct invocation touches Firestore.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('backfill-alert-ttl failed:', error);
    process.exit(1);
  });
}
