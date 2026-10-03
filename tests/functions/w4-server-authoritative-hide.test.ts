import { describe, it, expect, vi } from 'vitest';
import {
  shouldHideAtThreshold,
  stillQualifiesForHide,
  hideIfQualifies,
  applyThresholdHide,
  backfillThreshold,
  applyThresholdBackfill,
  runRolloutSweep,
  type AdminFirestore,
  type ReportableDoc,
  type ReportableCandidate,
  type ModeratedCollection,
} from '../../functions/src/autohide';

// specs/w4-server-authoritative-hide.md — the Phase-1 server-authoritative hide
// (#43, ADR 0004). Round-1 fixes: F1 no-zombie writer, F2 active-only, F3
// threshold-decrease backfill, F4 read-gating (rules). Round-2 fixes: a
// TRANSACTIONAL re-read guard (hideIfQualifies / stillQualifiesForHide) so a
// delayed trigger or racing sweep never acts on stale state, and a one-time
// rollout sweep (runRolloutSweep). Runs via `npm run test:functions`; every
// Firestore seam is injected or faked — no live runtime.

describe('shouldHideAtThreshold — the snapshot-level active-only "count rose to at/over" gate', () => {
  it('preserves admin restore suppression after new distinct reports and during delayed live rechecks', async () => {
    const restored = { status: 'active', reportCount: 6, reportHideSuppressed: true };
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 5 }, restored, 4)).toBe(false);
    expect(stillQualifiesForHide(restored, 4)).toBe(false);
    const { db, updates } = fakeDb({
      'events/event': { settings: { reportHideThreshold: 4 } },
      'events/event/items/item': restored,
    });
    expect(await hideIfQualifies(db, 'items', 'event', 'item')).toBe(false);
    expect(updates).toEqual([]);
  });
  it('hides an ACTIVE doc on the initial crossing from below the threshold to at/over it', () => {
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 3 }, { status: 'active', reportCount: 4 }, 4)).toBe(true);
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 3 }, { status: 'active', reportCount: 6 }, 4)).toBe(true);
    expect(shouldHideAtThreshold(undefined, { status: 'active', reportCount: 4 }, 4)).toBe(true);
  });

  it('R3 F2: RETRIES on the next bump if the doc stayed active at/over threshold (a swallowed first attempt)', () => {
    // before already at/over threshold but STILL active — a prior hide attempt was
    // swallowed. A further report (count rises) must re-attempt, not no-op.
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 4 }, { status: 'active', reportCount: 5 }, 4)).toBe(true);
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 5 }, { status: 'active', reportCount: 6 }, 4)).toBe(true);
  });

  it('F2: does NOT downgrade a flagged or pending doc that crosses the threshold', () => {
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 3 }, { status: 'flagged', reportCount: 4 }, 4)).toBe(false);
    expect(shouldHideAtThreshold({ status: 'flagged', reportCount: 3 }, { status: 'flagged', reportCount: 4 }, 4)).toBe(false);
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 3 }, { status: 'pending', reportCount: 4 }, 4)).toBe(false);
  });

  it('does NOT hide below the threshold, when the count did not rise, or when hidden (loop guard)', () => {
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 2 }, { status: 'active', reportCount: 3 }, 4)).toBe(false); // still below
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 4 }, { status: 'active', reportCount: 4 }, 4)).toBe(false); // no rise
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 5 }, { status: 'hidden', reportCount: 5 }, 4)).toBe(false); // our own hide write (now hidden)
    expect(shouldHideAtThreshold({ status: 'hidden', reportCount: 5 }, { status: 'hidden', reportCount: 6 }, 4)).toBe(false); // a bump on an already-hidden doc
  });

  it('preserves an admin restore — a status→active write with NO count rise is not re-hidden', () => {
    // restore leaves reportCount unchanged (5→5) → not a rise → no re-hide.
    expect(shouldHideAtThreshold({ status: 'hidden', reportCount: 5 }, { status: 'active', reportCount: 5 }, 4)).toBe(false);
  });

  it('fail-safe: an unset / zero / negative / non-numeric threshold hides nothing', () => {
    const rose: [ReportableDoc, ReportableDoc] = [{ status: 'active', reportCount: 0 }, { status: 'active', reportCount: 9 }];
    for (const t of [undefined, null, 0, -1, Number.NaN]) {
      expect(shouldHideAtThreshold(rose[0], rose[1], t as number | null | undefined)).toBe(false);
    }
  });

  it('is a no-op on a delete (after undefined)', () => {
    expect(shouldHideAtThreshold({ status: 'active', reportCount: 9 }, undefined, 4)).toBe(false);
  });
});

describe('stillQualifiesForHide — the live write-time re-confirm (round 2 F1)', () => {
  it('qualifies only when active AND reportCount at/over a positive threshold', () => {
    expect(stillQualifiesForHide({ status: 'active', reportCount: 4 }, 4)).toBe(true);
    expect(stillQualifiesForHide({ status: 'active', reportCount: 9 }, 4)).toBe(true);
    expect(stillQualifiesForHide({ status: 'active', reportCount: 3 }, 4)).toBe(false); // cleared below threshold
    expect(stillQualifiesForHide({ status: 'hidden', reportCount: 9 }, 4)).toBe(false); // already hidden
    expect(stillQualifiesForHide({ status: 'flagged', reportCount: 9 }, 4)).toBe(false); // stronger state kept
    expect(stillQualifiesForHide(undefined, 4)).toBe(false); // deleted
    for (const t of [undefined, null, 0, -1]) {
      expect(stillQualifiesForHide({ status: 'active', reportCount: 9 }, t as number | null | undefined)).toBe(false);
    }
  });
});

/**
 * A fake AdminFirestore: an in-memory doc store keyed by path (a missing key ⇒
 * the doc does not exist), a runTransaction that reads the live store and records
 * updates, and a where/get for the backfill query.
 */
function fakeDb(store: Record<string, Record<string, unknown> | undefined>) {
  const updates: Array<{ path: string; data: Record<string, unknown> }> = [];
  const snapFor = (path: string) => ({
    exists: store[path] !== undefined,
    id: path.split('/').pop() as string,
    data: () => store[path],
  });
  const ref = (path: string) => ({ __path: path, get: async () => snapFor(path) });
  const db = {
    doc: (path: string) => ref(path),
    collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }), get: async () => ({ docs: [] }) }),
    runTransaction: async <T>(fn: (tx: { get: (r: { __path: string }) => Promise<ReturnType<typeof snapFor>>; update: (r: { __path: string }, d: Record<string, unknown>) => void }) => Promise<T>) =>
      fn({
        get: async (r) => snapFor(r.__path),
        update: (r, d) => {
          // Reflect the write into the store so a second transaction sees it.
          store[r.__path] = { ...(store[r.__path] ?? {}), ...d };
          updates.push({ path: r.__path, data: d });
        },
      }),
  };
  return { db: db as unknown as AdminFirestore, updates, store };
}

describe('hideIfQualifies — transactional conditional hide (round 2 F1)', () => {
  const ITEM = 'events/e/items/i1';
  const EVENT = 'events/e';

  it('hides an active over-threshold doc (tx.update {status:hidden}), returns true', async () => {
    const { db, updates } = fakeDb({ [ITEM]: { status: 'active', reportCount: 5 }, [EVENT]: { settings: { reportHideThreshold: 4 } } });
    expect(await hideIfQualifies(db, 'items', 'e', 'i1')).toBe(true);
    expect(updates).toEqual([{ path: ITEM, data: { status: 'hidden' } }]);
  });

  it('does NOT undo an admin Clear-reports — reportCount cleared below threshold before the write → no-op', async () => {
    const { db, updates } = fakeDb({ [ITEM]: { status: 'active', reportCount: 0 }, [EVENT]: { settings: { reportHideThreshold: 4 } } });
    expect(await hideIfQualifies(db, 'items', 'e', 'i1')).toBe(false);
    expect(updates).toEqual([]);
  });

  it('no-ops on an already-hidden, flagged, or DELETED doc (no re-create)', async () => {
    const hidden = fakeDb({ [ITEM]: { status: 'hidden', reportCount: 9 }, [EVENT]: { settings: { reportHideThreshold: 4 } } });
    expect(await hideIfQualifies(hidden.db, 'items', 'e', 'i1')).toBe(false);
    expect(hidden.updates).toEqual([]);
    const flagged = fakeDb({ [ITEM]: { status: 'flagged', reportCount: 9 }, [EVENT]: { settings: { reportHideThreshold: 4 } } });
    expect(await hideIfQualifies(flagged.db, 'items', 'e', 'i1')).toBe(false);
    // Deleted: the target doc key is absent from the store.
    const deleted = fakeDb({ [EVENT]: { settings: { reportHideThreshold: 4 } } });
    expect(await hideIfQualifies(deleted.db, 'items', 'e', 'i1')).toBe(false);
    expect(deleted.updates).toEqual([]);
  });

  it('no-ops when the current threshold is non-positive or unset (fail-safe)', async () => {
    const zero = fakeDb({ [ITEM]: { status: 'active', reportCount: 9 }, [EVENT]: { settings: { reportHideThreshold: 0 } } });
    expect(await hideIfQualifies(zero.db, 'items', 'e', 'i1')).toBe(false);
    expect(zero.updates).toEqual([]);
    const unset = fakeDb({ [ITEM]: { status: 'active', reportCount: 9 }, [EVENT]: {} });
    expect(await hideIfQualifies(unset.db, 'items', 'e', 'i1')).toBe(false);
  });
});

/** A recording stub for applyThresholdHide's injected seams. */
function makeDeps(threshold: number | null, opts: { throwOnRead?: boolean; hideResult?: boolean; throwOnHide?: boolean } = {}) {
  const calls: Array<{ collection: ModeratedCollection; eventId: string; docId: string }> = [];
  const getReportHideThreshold = vi.fn(async (_eventId: string) => {
    if (opts.throwOnRead) throw new Error('firestore read boom');
    return threshold;
  });
  const hideIfQualifies = vi.fn(async (collection: ModeratedCollection, eventId: string, docId: string) => {
    if (opts.throwOnHide) throw new Error('transaction boom');
    calls.push({ collection, eventId, docId });
    return opts.hideResult ?? true;
  });
  return { calls, deps: { getReportHideThreshold, hideIfQualifies } };
}

describe('applyThresholdHide — snapshot gate then transactional write', () => {
  it('on a crossing, calls the transactional hideIfQualifies and returns its result', async () => {
    const { calls, deps } = makeDeps(4);
    expect(await applyThresholdHide('items', 'cruise', 'item1', { status: 'active', reportCount: 3 }, { status: 'active', reportCount: 4 }, deps)).toBe(true);
    expect(calls).toEqual([{ collection: 'items', eventId: 'cruise', docId: 'item1' }]);
  });

  it('R3 F2: RETRIES on the next bump after a swallowed first attempt (still active + over threshold, count rose)', async () => {
    const { calls, deps } = makeDeps(4);
    // The 3→4 crossing was swallowed earlier, leaving the doc active at 4; the next
    // report (4→5) re-attempts the hide through the transactional guard.
    expect(await applyThresholdHide('items', 'cruise', 'item1', { status: 'active', reportCount: 4 }, { status: 'active', reportCount: 5 }, deps)).toBe(true);
    expect(calls).toEqual([{ collection: 'items', eventId: 'cruise', docId: 'item1' }]);
  });

  it('returns false (does not count a hide) when the transaction declines — the live doc no longer qualifies', async () => {
    const { calls, deps } = makeDeps(4, { hideResult: false }); // e.g. an admin cleared reports mid-flight
    expect(await applyThresholdHide('proofs', 'cruise', 'p1', { status: 'active', reportCount: 3 }, { status: 'active', reportCount: 4 }, deps)).toBe(false);
    expect(calls).toEqual([{ collection: 'proofs', eventId: 'cruise', docId: 'p1' }]); // it still attempted
  });

  it('F2/short-circuit: flagged/pending/hidden after, a delete, or a non-rising count never reach the transaction', async () => {
    for (const after of [{ status: 'flagged', reportCount: 4 }, { status: 'pending', reportCount: 4 }, { status: 'hidden', reportCount: 4 }] as ReportableDoc[]) {
      const { calls, deps } = makeDeps(4);
      expect(await applyThresholdHide('proofs', 'cruise', 'p1', { status: 'active', reportCount: 3 }, after, deps)).toBe(false);
      expect(deps.getReportHideThreshold).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
    // reportCount did not rise (admin restore / re-fire)
    const restore = makeDeps(4);
    expect(await applyThresholdHide('items', 'cruise', 'i', { status: 'hidden', reportCount: 5 }, { status: 'active', reportCount: 5 }, restore.deps)).toBe(false);
    expect(restore.deps.getReportHideThreshold).not.toHaveBeenCalled();
  });

  it('fail-safe + never-throws: unset/zero threshold and a thrown read/transaction all resolve false', async () => {
    for (const t of [null, 0]) {
      const { calls, deps } = makeDeps(t as number | null);
      expect(await applyThresholdHide('items', 'cruise', 'i', { status: 'active', reportCount: 0 }, { status: 'active', reportCount: 9 }, deps)).toBe(false);
      expect(calls).toEqual([]);
    }
    await expect(applyThresholdHide('items', 'e', 'i', { status: 'active', reportCount: 3 }, { status: 'active', reportCount: 4 }, makeDeps(4, { throwOnRead: true }).deps)).resolves.toBe(false);
    await expect(applyThresholdHide('items', 'e', 'i', { status: 'active', reportCount: 3 }, { status: 'active', reportCount: 4 }, makeDeps(4, { throwOnHide: true }).deps)).resolves.toBe(false);
  });
});

describe('backfillThreshold — the decrease predicate (F3)', () => {
  it('sweeps on a decrease and on enable-from-disabled; not on unchanged/raised/disabled', () => {
    expect(backfillThreshold(10, 4)).toBe(4);
    expect(backfillThreshold(undefined, 4)).toBe(4); // enable from unset — also the rollout path
    expect(backfillThreshold(0, 4)).toBe(4);
    expect(backfillThreshold(4, 4)).toBe(null);
    expect(backfillThreshold(4, 10)).toBe(null);
    expect(backfillThreshold(4, 0)).toBe(null);
    expect(backfillThreshold(4, undefined)).toBe(null);
    expect(backfillThreshold(4, -1)).toBe(null);
  });
});

describe('applyThresholdBackfill — bounded event-scoped sweep via the transactional guard (F3 + R2)', () => {
  function makeBackfillDeps(byCollection: Partial<Record<ModeratedCollection, ReportableCandidate[]>>, opts: { throwId?: string; declineId?: string } = {}) {
    const hidden: Array<{ collection: ModeratedCollection; docId: string }> = [];
    const queryReportedDocs = vi.fn(async (collection: ModeratedCollection) => byCollection[collection] ?? []);
    const hideIfQualifies = vi.fn(async (collection: ModeratedCollection, _eventId: string, docId: string) => {
      if (docId === opts.throwId) throw new Error('per-doc transaction boom');
      if (docId === opts.declineId) return false; // live re-read declined (raced a clear)
      hidden.push({ collection, docId });
      return true;
    });
    return { hidden, deps: { queryReportedDocs, hideIfQualifies } };
  }

  it('hides active over-bar docs on a decrease; skips flagged/pending and now-below (pre-filter)', async () => {
    const { hidden, deps } = makeBackfillDeps({
      items: [
        { id: 'i1', status: 'active', reportCount: 5 },
        { id: 'i2', status: 'flagged', reportCount: 9 },
        { id: 'i3', status: 'active', reportCount: 2 },
      ],
      proofs: [
        { id: 'p1', status: 'active', reportCount: 4 },
        { id: 'p2', status: 'pending', reportCount: 7 },
      ],
    });
    expect(await applyThresholdBackfill('cruise', 10, 4, deps)).toBe(2);
    expect(hidden).toEqual([{ collection: 'items', docId: 'i1' }, { collection: 'proofs', docId: 'p1' }]);
  });

  it('does not count a doc the transactional guard declined (raced an admin clear)', async () => {
    const { hidden, deps } = makeBackfillDeps({ items: [{ id: 'i1', status: 'active', reportCount: 5 }, { id: 'i2', status: 'active', reportCount: 5 }] }, { declineId: 'i1' });
    expect(await applyThresholdBackfill('cruise', 10, 4, deps)).toBe(1);
    expect(hidden).toEqual([{ collection: 'items', docId: 'i2' }]);
  });

  it('idempotent: a re-sweep over already-hidden docs hides nothing (pre-filter skips them)', async () => {
    const { hidden, deps } = makeBackfillDeps({ items: [{ id: 'i1', status: 'hidden', reportCount: 9 }], proofs: [{ id: 'p1', status: 'hidden', reportCount: 9 }] });
    expect(await applyThresholdBackfill('cruise', 10, 4, deps)).toBe(0);
    expect(deps.hideIfQualifies).not.toHaveBeenCalled();
    expect(hidden).toEqual([]);
  });

  it('does NOTHING when the threshold is unchanged, raised, or disabled — no query', async () => {
    for (const [before, after] of [[4, 4], [4, 10], [4, 0]] as Array<[number, number]>) {
      const { hidden, deps } = makeBackfillDeps({ items: [{ id: 'i1', status: 'active', reportCount: 9 }] });
      expect(await applyThresholdBackfill('cruise', before, after, deps)).toBe(0);
      expect(deps.queryReportedDocs).not.toHaveBeenCalled();
      expect(hidden).toEqual([]);
    }
  });

  it('rollout path (enable-from-null) sweeps at the current bar; a per-doc failure does not abort', async () => {
    const { hidden, deps } = makeBackfillDeps({ items: [{ id: 'i1', status: 'active', reportCount: 5 }, { id: 'i2', status: 'active', reportCount: 5 }] }, { throwId: 'i1' });
    expect(await applyThresholdBackfill('cruise', null, 4, deps)).toBe(1); // before=null ⇒ rollout sweep at 4
    expect(hidden).toEqual([{ collection: 'items', docId: 'i2' }]);
  });
});

describe('runRolloutSweep — one-time cross-event rollout sweep (R2 F2)', () => {
  it('sweeps every event and sums the hides', async () => {
    const listEventThresholds = vi.fn(async () => [{ id: 'e1', threshold: 4 }, { id: 'e2', threshold: 3 }, { id: 'e3', threshold: null }]);
    const perEvent: Record<string, number> = { e1: 2, e2: 1, e3: 0 };
    const sweepEvent = vi.fn(async (eventId: string) => perEvent[eventId]);
    expect(await runRolloutSweep(undefined, { listEventThresholds, sweepEvent })).toEqual({ events: 3, hidden: 3 });
    expect(sweepEvent).toHaveBeenCalledTimes(3);
  });

  it('scopes to one event when an eventId is given', async () => {
    const listEventThresholds = vi.fn(async (eventId?: string) => (eventId === 'only' ? [{ id: 'only', threshold: 4 }] : []));
    const sweepEvent = vi.fn(async () => 5);
    expect(await runRolloutSweep('only', { listEventThresholds, sweepEvent })).toEqual({ events: 1, hidden: 5 });
    expect(listEventThresholds).toHaveBeenCalledWith('only');
    expect(sweepEvent).toHaveBeenCalledWith('only', 4);
  });
});
