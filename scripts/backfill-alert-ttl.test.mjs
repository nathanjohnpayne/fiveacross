// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PENDING_TTL_MS,
  TTL_COLLECTION_GROUPS,
  backfillCollectionGroup,
  expiryFor,
  needsStamp,
} from './backfill-alert-ttl.mjs';

// The one-time rollout backfill for the admin-alert retention boundary (#670,
// Phase 4b P1). Firestore TTL only ever looks at documents that ALREADY carry a
// timestamp in the named field, so enabling the policies does nothing for
// anything written before the deploy — which is precisely the stranded
// population the retention change exists for.

const NOW = 1_000_000_000_000;

/** A minimal Firestore collection-group surface: ordered pages, a merge batch. */
function fakeDb(groups) {
  const written = [];
  const makeQuery = (docs, after, cap) => ({
    orderBy: () => makeQuery(docs, after, cap),
    limit: (n) => makeQuery(docs, after, n),
    startAfter: (cursor) => makeQuery(docs, cursor, cap),
    get: async () => {
      const start = after ? docs.findIndex((d) => d.id === after.id) + 1 : 0;
      const page = docs.slice(start, cap ? start + cap : undefined);
      return { empty: page.length === 0, docs: page };
    },
  });
  return {
    written,
    collectionGroup: (name) => {
      const docs = (groups[name] ?? []).map((entry) => ({
        id: entry.id,
        ref: { path: `${name}/${entry.id}` },
        data: () => entry.data,
      }));
      return makeQuery(docs, null, null);
    },
    batch: () => ({
      set: (ref, data, options) => written.push({ path: ref.path, data, options }),
      commit: async () => undefined,
    }),
  };
}

describe('backfill-alert-ttl', () => {
  it('covers both collection groups that hold a copy of user content', () => {
    // One policy per collection group, so missing one leaves that group's
    // documents unprotected however carefully the other is configured.
    expect([...TTL_COLLECTION_GROUPS].sort()).toEqual(['adminAlertBatches', 'adminAlerts']);
  });

  it('keeps its TTL span in step with the functions runtime', () => {
    // Restated rather than imported (that module is TypeScript for the Functions
    // runtime), so something has to hold the two together.
    const source = readFileSync('functions/src/adminAlerts.ts', 'utf8');
    expect(source).toContain('export const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;');
    expect(PENDING_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('stamps only documents the TTL service cannot already see', () => {
    expect(needsStamp({})).toBe(true);
    expect(needsStamp({ expiresAt: null })).toBe(true);
    // A NUMBER is not a timestamp: Firestore's TTL service ignores it, so the
    // document is unprotected despite looking like it has a deadline.
    expect(needsStamp({ expiresAt: NOW })).toBe(true);
    expect(needsStamp({ expiresAt: '2026-01-01' })).toBe(true);
    expect(needsStamp({ expiresAt: new Date(NOW) })).toBe(false);
    expect(needsStamp({ expiresAt: { toMillis: () => NOW } })).toBe(false);
  });

  it('anchors the deadline to the document’s own age, not to the repair', () => {
    // A row queued three months ago is already past due; handing it a fresh
    // thirty days would make the repair itself extend the retention.
    const old = NOW - 90 * 24 * 60 * 60 * 1000;
    expect(expiryFor({ createdAt: old }, NOW).getTime()).toBe(old + PENDING_TTL_MS);
    expect(expiryFor({ createdAt: { toMillis: () => old } }, NOW).getTime()).toBe(old + PENDING_TTL_MS);
    expect(expiryFor({ createdAt: new Date(old) }, NOW).getTime()).toBe(old + PENDING_TTL_MS);
    // Only an unreadable timestamp falls back to now — the cautious direction,
    // keeping a document one more window rather than deleting one whose age
    // cannot be established.
    expect(expiryFor({}, NOW).getTime()).toBe(NOW + PENDING_TTL_MS);
    expect(expiryFor({ createdAt: 'yesterday' }, NOW).getTime()).toBe(NOW + PENDING_TTL_MS);
  });

  it('stamps legacy documents, leaves live ones alone, and pages through the group', async () => {
    const db = fakeDb({
      adminAlerts: [
        { id: 'a1', data: { createdAt: NOW - 1000, label: 'legacy pending row' } },
        { id: 'a2', data: { createdAt: NOW, expiresAt: new Date(NOW + PENDING_TTL_MS) } },
        { id: 'a3', data: { createdAt: NOW - 2000 } },
      ],
    });
    const result = await backfillCollectionGroup(db, 'adminAlerts', { now: NOW, dryRun: false, pageSize: 2 });
    expect(result).toEqual({ group: 'adminAlerts', scanned: 3, stamped: 2 });
    expect(db.written.map((w) => w.path)).toEqual(['adminAlerts/a1', 'adminAlerts/a3']);
    // MERGE, so repairing a row cannot destroy the payload it is protecting.
    expect(db.written.every((w) => w.options?.merge === true)).toBe(true);
    // The already-protected row is untouched: rewriting a live deadline would
    // extend the very retention this bounds.
    expect(db.written.some((w) => w.path === 'adminAlerts/a2')).toBe(false);
  });

  it('writes nothing on a dry run, but still reports what it would do', async () => {
    const db = fakeDb({ adminAlertBatches: [{ id: 'b1', data: { createdAt: NOW - 5000 } }] });
    const lines = [];
    const result = await backfillCollectionGroup(db, 'adminAlertBatches', {
      now: NOW,
      dryRun: true,
      log: (line) => lines.push(line),
    });
    expect(result.stamped).toBe(1);
    expect(db.written).toEqual([]);
    expect(lines[0]).toContain('would stamp adminAlertBatches/b1');
  });

  it('is idempotent — a second run finds nothing left to stamp', async () => {
    const docs = [{ id: 'a1', data: { createdAt: NOW - 1000 } }];
    const db = fakeDb({ adminAlerts: docs });
    await backfillCollectionGroup(db, 'adminAlerts', { now: NOW, dryRun: false });
    // Apply what the first run wrote, then run again.
    docs[0].data.expiresAt = new Date(NOW - 1000 + PENDING_TTL_MS);
    const second = await backfillCollectionGroup(fakeDb({ adminAlerts: docs }), 'adminAlerts', {
      now: NOW,
      dryRun: false,
    });
    expect(second.stamped).toBe(0);
  });
});
