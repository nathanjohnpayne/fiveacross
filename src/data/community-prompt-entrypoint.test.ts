import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { submitterStatus, type TargetableDay } from './communityPrompts';
import {
  loadTrackedSuggestions,
  persistTrackedSuggestions,
  refreshAndPersistLastKnownStatuses,
  trackSuggestion,
  deriveMySubmissions,
  refreshLastKnownStatuses,
} from './mySuggestions';
import type { ItemDoc } from '../types';

// jsdom here leaves `window.localStorage` unset (src/data/cardCache.test.ts's
// own note, src/hooks/useTextSize.test.ts) — provide a real in-memory Storage
// the module under test can read/write.
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

// #559 (specs/community-prompt-targeting.md § "Entry point, submitter states,
// and attribution"): the submitter-facing state machine layered on top of
// #557's targeting model, plus the local-device submission tracker that
// closes the "not selected" gap a submitter's own read rule leaves open (a
// rejected row is unreadable by its own submitter — see communityPrompts.ts's
// `submitterStatus` doc comment).

const day = (index: number, over: Partial<TargetableDay> = {}): TargetableDay => ({
  index,
  unlockAt: 1_000_000,
  pool: 'main',
  snapshotItemIds: undefined,
  ...over,
});

const item = (over: Partial<ItemDoc> = {}): ItemDoc =>
  ({
    id: 'it-1',
    text: 'Wore Crocs to dinner',
    createdBy: 'u1',
    createdAt: 0,
    isFreeSpace: false,
    status: 'active',
    reportCount: 0,
    spicy: false,
    pool: 'main',
    ...over,
  }) as ItemDoc;

describe('submitterStatus (#559)', () => {
  it('is "pending" for a still-pending row, regardless of any target', () => {
    expect(submitterStatus(item({ status: 'pending', targetDayIndex: 2 }), [day(2)], 0)).toBe('pending');
  });

  it('is "scheduled" when the target Day is still open (unstamped, ahead of now)', () => {
    const days = [day(3, { unlockAt: 5000 })];
    expect(submitterStatus(item({ status: 'active', targetDayIndex: 3 }), days, 0)).toBe('scheduled');
  });

  it('is "approved" once the target Day has stamped (already dealt)', () => {
    const days = [day(3, { unlockAt: 5000, snapshotItemIds: ['it-1'] })];
    expect(submitterStatus(item({ status: 'active', targetDayIndex: 3 }), days, 0)).toBe('approved');
  });

  it('is "approved" once the target Day\'s cutoff has passed but not yet stamped', () => {
    const days = [day(3, { unlockAt: 100 })];
    expect(submitterStatus(item({ status: 'active', targetDayIndex: 3 }), days, 5000)).toBe('approved');
  });

  it('is "approved" for an untargeted (every-Day) active row', () => {
    expect(submitterStatus(item({ status: 'active' }), [day(0, { unlockAt: 9999 })], 0)).toBe('approved');
  });

  it('is "approved", never re-derived as "scheduled", once retained — the target is left in place but unreachable', () => {
    const days = [day(3, { unlockAt: 9999 })];
    expect(submitterStatus(item({ status: 'active', targetDayIndex: 3, retainedAt: 500 }), days, 0)).toBe(
      'approved',
    );
  });

  it('is "approved" when the target names a Day not present in the schedule at all', () => {
    expect(submitterStatus(item({ status: 'active', targetDayIndex: 9 }), [day(0, { unlockAt: 9999 })], 0)).toBe(
      'approved',
    );
  });
});

describe('mySuggestions local tracker (#559)', () => {
  beforeEach(() => vi.stubGlobal('localStorage', new MemoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('loads nothing for a fresh device', () => {
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([]);
  });

  it('round-trips a tracked suggestion', () => {
    trackSuggestion('ev-1', 'u1', { id: 'a', text: 'Wore Crocs', submittedAt: 100 });
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([{ id: 'a', text: 'Wore Crocs', submittedAt: 100 }]);
  });

  it('is idempotent on id — re-tracking the same id replaces rather than duplicates', () => {
    trackSuggestion('ev-1', 'u1', { id: 'a', text: 'first text', submittedAt: 100 });
    trackSuggestion('ev-1', 'u1', { id: 'a', text: 'edited text', submittedAt: 100 });
    const loaded = loadTrackedSuggestions('ev-1', 'u1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].text).toBe('edited text');
  });

  it('normalizes duplicate ids from a persisted blob while refreshing the first occurrence in place (#909)', () => {
    localStorage.setItem(
      'gcb.mySuggestions.ev-1.u1',
      JSON.stringify([
        { id: 'before', text: 'before', submittedAt: 1 },
        { id: 'target', text: 'first copy', submittedAt: 2 },
        { id: 'middle', text: 'middle', submittedAt: 3 },
        { id: 'target', text: 'later duplicate', submittedAt: 4 },
        { id: 'after', text: 'after', submittedAt: 5 },
      ]),
    );

    trackSuggestion('ev-1', 'u1', { id: 'target', text: 'refreshed', submittedAt: 2 });

    const loaded = loadTrackedSuggestions('ev-1', 'u1');
    expect(loaded.map(({ id }) => id)).toEqual(['before', 'target', 'middle', 'after']);
    expect(loaded[1]).toEqual({ id: 'target', text: 'refreshed', submittedAt: 2 });
  });

  it('caps an oversized persisted blob even when the next write only refreshes an existing id (#909)', () => {
    localStorage.setItem(
      'gcb.mySuggestions.ev-1.u1',
      JSON.stringify(Array.from({ length: 22 }, (_, i) => ({ id: `id-${i}`, text: `t${i}`, submittedAt: i }))),
    );

    trackSuggestion('ev-1', 'u1', { id: 'id-10', text: 'refreshed', submittedAt: 10 });

    const loaded = loadTrackedSuggestions('ev-1', 'u1');
    expect(loaded).toHaveLength(20);
    expect(loaded[0].id).toBe('id-2');
    expect(loaded.at(-1)?.id).toBe('id-21');
    expect(loaded.find(({ id }) => id === 'id-10')?.text).toBe('refreshed');
  });

  it('persists one normalized capped snapshot when multiple stale entries refresh together (#909)', () => {
    const oversized = Array.from({ length: 22 }, (_, i) => ({
      id: `id-${i}`,
      text: `original-${i}`,
      submittedAt: i,
    }));
    const activeMine = oversized.map((tracked) => item({ id: tracked.id, text: `refreshed-${tracked.id}` }));
    const write = vi.spyOn(localStorage, 'setItem');

    const persisted = refreshAndPersistLastKnownStatuses('ev-1', 'u1', oversized, activeMine, [], 0);

    expect(write).toHaveBeenCalledTimes(1);
    expect(persisted.map(({ id }) => id)).toEqual(Array.from({ length: 20 }, (_, i) => `id-${i + 2}`));
    expect(persisted[0].lastKnownText).toBe('refreshed-id-2');
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual(persisted);
  });

  it('scopes tracking per Event AND per uid — no cross-Event or cross-account bleed', () => {
    trackSuggestion('ev-1', 'u1', { id: 'a', text: 'x', submittedAt: 1 });
    expect(loadTrackedSuggestions('ev-2', 'u1')).toEqual([]);
    expect(loadTrackedSuggestions('ev-1', 'u2')).toEqual([]);
  });

  it('caps tracked history so a long-running device does not grow the key unbounded', () => {
    for (let i = 0; i < 25; i++) {
      trackSuggestion('ev-1', 'u1', { id: `id-${i}`, text: `t${i}`, submittedAt: i });
    }
    const loaded = loadTrackedSuggestions('ev-1', 'u1');
    expect(loaded.length).toBeLessThanOrEqual(20);
    // The newest entries survive the cap, not the oldest.
    expect(loaded.at(-1)?.id).toBe('id-24');
  });

  it('caps by newest SUBMISSION, not by write/refresh position — refreshing an older entry must not save it from eviction at the expense of a genuinely more recent submission (#864)', () => {
    for (let i = 1; i <= 19; i++) {
      trackSuggestion('ev-1', 'u1', { id: `id-${i}`, text: `t${i}`, submittedAt: i });
    }
    // A REFRESH of the OLDEST entry — same id, same submittedAt, only a
    // follow-up field changing — is exactly what ItemPool's own
    // `refreshLastKnownStatuses` effect does on a status/target/text update.
    // Before #864, `trackSuggestion` always moved the touched entry to the
    // newest storage slot, whether it was a fresh submission or a refresh.
    trackSuggestion('ev-1', 'u1', { id: 'id-1', text: 't1', submittedAt: 1, lastKnownStatus: 'approved' });
    // Two genuinely NEW, later submissions push the tracker over its cap.
    trackSuggestion('ev-1', 'u1', { id: 'id-20', text: 't20', submittedAt: 20 });
    trackSuggestion('ev-1', 'u1', { id: 'id-21', text: 't21', submittedAt: 21 });

    const loaded = loadTrackedSuggestions('ev-1', 'u1');
    expect(loaded).toHaveLength(20);
    // The genuinely oldest submission is what the cap evicts...
    expect(loaded.find((s) => s.id === 'id-1')).toBeUndefined();
    // ...never a submission that is MORE recent than it, just because the
    // older one happened to be refreshed most recently (the pre-#864 bug:
    // refreshing id-1 moved it to the tail, so id-2 — genuinely newer —
    // would have been evicted in its place).
    expect(loaded.find((s) => s.id === 'id-2')).toBeDefined();
    expect(loaded.find((s) => s.id === 'id-21')).toBeDefined();
  });

  it('never evicts a genuinely NEW submission merely because an existing entry carries a non-monotonic (clock-skewed) submittedAt (Codex P2, PR #890 round 1)', () => {
    // Simulates 20 entries recorded while the device clock was skewed FAR
    // into the future (a bad NTP sync, say), filling the tracker to its cap.
    for (let i = 0; i < 20; i++) {
      trackSuggestion('ev-1', 'u1', { id: `skewed-${i}`, text: `t${i}`, submittedAt: 999_000 + i });
    }
    // The clock then corrects BACKWARD to the real time — a genuinely NEW
    // submission now carries a SMALLER recorded submittedAt than every
    // existing (skewed) entry, even though it is chronologically the most
    // recent write this device has made. The pre-round-1 sort-by-submittedAt
    // cap would have evicted THIS entry instead of the actually-oldest one.
    trackSuggestion('ev-1', 'u1', { id: 'genuinely-newest', text: 'just submitted', submittedAt: 500 });

    const loaded = loadTrackedSuggestions('ev-1', 'u1');
    expect(loaded.find((s) => s.id === 'genuinely-newest')).toBeDefined();
    // The tracker is capped by WRITE order, so the entry recorded FIRST —
    // regardless of its (skewed) timestamp — is what the cap evicts.
    expect(loaded.find((s) => s.id === 'skewed-0')).toBeUndefined();
  });

  it('never re-sorts a legacy blob by submittedAt — array position governs the cap even for a blob a pre-round-1 build left out of order (Codex P2, PR #890 rounds 2 + 4)', () => {
    // Models what the OLD (pre-#864-round-1) `trackSuggestion` could leave
    // behind: `old-1` (the actual oldest submission) was refreshed at some
    // point and moved to the array's TAIL. A one-time submittedAt-sort
    // "repair" (round 2's own first cut) sounds like the fix, but round 4
    // found it reintroduces the identical clock-skew loss round 1 exists to
    // prevent, just narrowed to the migration moment — so there is
    // deliberately NO migration (see the comment above `trackSuggestion`).
    // Array position — the actual write/refresh order this run of the code
    // produced — is what the cap uses, full stop; a legacy blob's own
    // pre-existing disorder is left exactly as found.
    const legacy = [
      ...Array.from({ length: 19 }, (_, i) => ({ id: `id-${i + 2}`, text: `t${i + 2}`, submittedAt: i + 2 })),
      { id: 'old-1', text: 'the actual oldest', submittedAt: 1 },
    ];
    localStorage.setItem('gcb.mySuggestions.ev-1.u1', JSON.stringify(legacy));

    trackSuggestion('ev-1', 'u1', { id: 'id-21', text: 'newest', submittedAt: 21 });

    const loaded = loadTrackedSuggestions('ev-1', 'u1');
    expect(loaded).toHaveLength(20);
    // The cap evicts whatever sits at array position 0 — `id-2`, the
    // legacy blob's own first entry — NOT `old-1` (which the pre-round-1
    // bug had already moved to the tail, and this run makes no attempt to
    // relocate).
    expect(loaded.find((s) => s.id === 'id-2')).toBeUndefined();
    expect(loaded.find((s) => s.id === 'old-1')).toBeDefined();
    expect(loaded.find((s) => s.id === 'id-21')).toBeDefined();
  });

  it('discards a persisted entry whose lastKnownStatus is not a valid SubmitterStatus, rather than letting a malformed value reach the pill label (#865)', () => {
    localStorage.setItem(
      'gcb.mySuggestions.ev-1.u1',
      JSON.stringify([{ id: 'a', text: 'x', submittedAt: 1, lastKnownStatus: 'banana' }]),
    );
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([]);
  });

  it("discards a persisted entry whose lastKnownStatus is 'pending' — never something this module itself writes, only a malformed or cross-version blob, and accepting it could pin a rejected submission as 'pending review' forever (Codex + CodeRabbit, PR #890 round 1)", () => {
    localStorage.setItem(
      'gcb.mySuggestions.ev-1.u1',
      JSON.stringify([{ id: 'a', text: 'x', submittedAt: 1, lastKnownStatus: 'pending' }]),
    );
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([]);
  });

  it('discards a persisted entry whose lastKnownText is not a string, rather than letting an object reach React as a child (#865)', () => {
    localStorage.setItem(
      'gcb.mySuggestions.ev-1.u1',
      JSON.stringify([{ id: 'a', text: 'x', submittedAt: 1, lastKnownText: { evil: true } }]),
    );
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([]);
  });

  it('discards a persisted entry whose lastKnownDayIndex is not a number (#865)', () => {
    localStorage.setItem(
      'gcb.mySuggestions.ev-1.u1',
      JSON.stringify([{ id: 'a', text: 'x', submittedAt: 1, lastKnownDayIndex: '3' }]),
    );
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([]);
  });

  it.each([-1, 1.5])(
    'discards a persisted entry whose lastKnownDayIndex is %s — not a non-negative integer (Codex + CodeRabbit, PR #890 round 1)',
    (badIndex) => {
      localStorage.setItem(
        'gcb.mySuggestions.ev-1.u1',
        JSON.stringify([{ id: 'a', text: 'x', submittedAt: 1, lastKnownDayIndex: badIndex }]),
      );
      expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([]);
    },
  );

  it('still accepts a well-formed entry carrying valid optional fields', () => {
    const stored = {
      id: 'a',
      text: 'x',
      submittedAt: 1,
      lastKnownStatus: 'scheduled',
      lastKnownDayIndex: 2,
      lastKnownText: 'edited wording',
    };
    localStorage.setItem('gcb.mySuggestions.ev-1.u1', JSON.stringify([stored]));
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([stored]);
  });

  it('falls open to an empty list when localStorage throws (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage unavailable');
      },
    });
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([]);
  });

  it('ignores malformed persisted JSON (a stale/corrupted key) rather than throwing', () => {
    localStorage.setItem('gcb.mySuggestions.ev-1.u1', '{not json');
    expect(loadTrackedSuggestions('ev-1', 'u1')).toEqual([]);
  });
});

describe('deriveMySubmissions (#559)', () => {
  const days = [day(2, { unlockAt: 9999 })];

  it('reports every row in the LIVE pending query as "pending", even one this device never tracked (cross-device visibility)', () => {
    const pendingMine = [item({ id: 'p1', status: 'pending', text: 'from another device', createdAt: 10 })];
    const views = deriveMySubmissions([], pendingMine, [], days, 0, true);
    expect(views).toEqual([{ id: 'p1', text: 'from another device', submittedAt: 10, status: 'pending' }]);
  });

  it('resolves a tracked id that is now active to its derived submitterStatus, with dayIndex when scheduled, using the ACTIVE document\'s text', () => {
    const tracked = [{ id: 'a1', text: 'original wording', submittedAt: 5 }];
    const activeMine = [item({ id: 'a1', status: 'active', targetDayIndex: 2, text: 'authoritative wording' })];
    const views = deriveMySubmissions(tracked, [], activeMine, days, 0, true);
    expect(views).toEqual([
      { id: 'a1', text: 'authoritative wording', submittedAt: 5, status: 'scheduled', dayIndex: 2 },
    ]);
  });

  it('reports a tracked id absent from BOTH live queries as "not_selected" once both queries are ready — the rejected-and-unreadable inference', () => {
    const tracked = [{ id: 'gone', text: 'Too spicy for this crowd', submittedAt: 5 }];
    const views = deriveMySubmissions(tracked, [], [], days, 0, true);
    expect(views).toEqual([{ id: 'gone', text: 'Too spicy for this crowd', submittedAt: 5, status: 'not_selected' }]);
  });

  it('OMITS (never guesses) a tracked id absent from both live queries while they are not yet ready', () => {
    const tracked = [{ id: 'gone', text: 'Too spicy for this crowd', submittedAt: 5 }];
    const views = deriveMySubmissions(tracked, [], [], days, 0, false);
    expect(views).toEqual([]);
  });

  it('still resolves a tracked id already found in a live query even while NOT ready — only the absence case waits', () => {
    const tracked = [{ id: 'a1', text: 'Wore Crocs', submittedAt: 5 }];
    const activeMine = [item({ id: 'a1', status: 'active', targetDayIndex: 2 })];
    const views = deriveMySubmissions(tracked, [], activeMine, days, 0, false);
    expect(views).toHaveLength(1);
    expect(views[0].status).toBe('scheduled');
  });

  it("uses the active document's authoritative text once approved, not the locally tracked original", () => {
    const tracked = [{ id: 'a1', text: 'original wording', submittedAt: 5 }];
    const activeMine = [item({ id: 'a1', status: 'active', text: 'admin-edited wording' })];
    const views = deriveMySubmissions(tracked, [], activeMine, days, 0, true);
    expect(views[0].text).toBe('admin-edited wording');
  });

  it('never double-counts a tracked id that is ALSO in the live pending query', () => {
    const tracked = [{ id: 'p1', text: 'mine', submittedAt: 1 }];
    const pendingMine = [item({ id: 'p1', status: 'pending', text: 'mine', createdAt: 1 })];
    const views = deriveMySubmissions(tracked, pendingMine, [], days, 0, true);
    expect(views).toHaveLength(1);
    expect(views[0].status).toBe('pending');
  });

  it('sorts the merged view oldest-first', () => {
    const tracked = [{ id: 'later', text: 'b', submittedAt: 200 }];
    const pendingMine = [item({ id: 'earlier', status: 'pending', text: 'a', createdAt: 100 })];
    const views = deriveMySubmissions(tracked, pendingMine, [], days, 0, true);
    expect(views.map((v) => v.id)).toEqual(['earlier', 'later']);
  });

  // Codex P2, PR #845 round 7: absence from both live queries, even once
  // `ready`, is NOT automatically "not selected" — a submission previously
  // OBSERVED active (lastKnownStatus set) falls back to that last-known
  // state instead, covering both the cross-listener approval race and a
  // later hard-hide, neither of which is a genuine rejection.
  it('falls back to lastKnownStatus, not "not_selected", for a submission absent from both live queries but previously observed active', () => {
    const tracked = [{ id: 'a1', text: 'Wore Crocs', submittedAt: 5, lastKnownStatus: 'approved' as const, lastKnownDayIndex: undefined }];
    const views = deriveMySubmissions(tracked, [], [], days, 0, true);
    expect(views).toEqual([{ id: 'a1', text: 'Wore Crocs', submittedAt: 5, status: 'approved', dayIndex: undefined }]);
  });

  it('carries lastKnownDayIndex through the same fallback, for a submission previously observed scheduled — while its named Day is STILL targetable', () => {
    const tracked = [{ id: 'a1', text: 'Wore Crocs', submittedAt: 5, lastKnownStatus: 'scheduled' as const, lastKnownDayIndex: 2 }];
    const views = deriveMySubmissions(tracked, [], [], days, 0, true);
    expect(views[0]).toEqual({ id: 'a1', text: 'Wore Crocs', submittedAt: 5, status: 'scheduled', dayIndex: 2 });
  });

  it('still reports "not_selected" for a submission that was NEVER observed active', () => {
    const tracked = [{ id: 'gone', text: 'Too spicy', submittedAt: 5 }];
    const views = deriveMySubmissions(tracked, [], [], days, 0, true);
    expect(views[0].status).toBe('not_selected');
  });

  // Codex P2, PR #845 round 8, finding (a): the FIRST-time version of round
  // 7's race — a submission this device has NEVER before seen active (no
  // lastKnownStatus cached yet) still needs one render's grace, or the SAME
  // cross-listener overlap reads "not selected" for a submission that is
  // actually about to resolve.
  it('reports "pending" (not "not_selected") for an id in graceIds absent from both live queries, even with no lastKnownStatus cached', () => {
    const tracked = [{ id: 'a1', text: 'Wore Crocs', submittedAt: 5 }];
    const views = deriveMySubmissions(tracked, [], [], days, 0, true, new Set(['a1']));
    expect(views).toEqual([{ id: 'a1', text: 'Wore Crocs', submittedAt: 5, status: 'pending' }]);
  });

  it('graceIds does not override a submission that HAS already resolved active — the live document wins', () => {
    const tracked = [{ id: 'a1', text: 'Wore Crocs', submittedAt: 5 }];
    const activeMine = [item({ id: 'a1', status: 'active', targetDayIndex: 2 })];
    const views = deriveMySubmissions(tracked, [], activeMine, days, 0, true, new Set(['a1']));
    expect(views[0].status).toBe('scheduled');
  });

  it('a genuine rejection is unaffected by an EMPTY graceIds (the default) — still "not_selected"', () => {
    const tracked = [{ id: 'gone', text: 'Too spicy', submittedAt: 5 }];
    const views = deriveMySubmissions(tracked, [], [], days, 0, true);
    expect(views[0].status).toBe('not_selected');
  });

  // Codex P2, PR #845 round 8, finding (b): a cached 'scheduled' fallback is
  // a promise about a SPECIFIC Day, true only while that Day is still
  // targetable — a submission hard-hidden before its Day's cutoff must not
  // replay "scheduled · Day N" forever once that Day stops being targetable.
  it('downgrades a cached "scheduled" fallback to "approved" once its named Day is no longer targetable (stamped)', () => {
    const stampedDays = [day(2, { unlockAt: 9999, snapshotItemIds: ['whatever'] })];
    const tracked = [{ id: 'a1', text: 'Wore Crocs', submittedAt: 5, lastKnownStatus: 'scheduled' as const, lastKnownDayIndex: 2 }];
    const views = deriveMySubmissions(tracked, [], [], stampedDays, 0, true);
    expect(views[0]).toEqual({ id: 'a1', text: 'Wore Crocs', submittedAt: 5, status: 'approved', dayIndex: undefined });
  });

  it('downgrades a cached "scheduled" fallback to "approved" once its named Day\'s cutoff has passed', () => {
    const pastCutoffDays = [day(2, { unlockAt: 100 })];
    const tracked = [{ id: 'a1', text: 'Wore Crocs', submittedAt: 5, lastKnownStatus: 'scheduled' as const, lastKnownDayIndex: 2 }];
    const views = deriveMySubmissions(tracked, [], [], pastCutoffDays, 500, true);
    expect(views[0]).toEqual({ id: 'a1', text: 'Wore Crocs', submittedAt: 5, status: 'approved', dayIndex: undefined });
  });

  it('downgrades a cached "scheduled" fallback naming a Day no longer in the schedule at all', () => {
    const tracked = [{ id: 'a1', text: 'Wore Crocs', submittedAt: 5, lastKnownStatus: 'scheduled' as const, lastKnownDayIndex: 99 }];
    const views = deriveMySubmissions(tracked, [], [], days, 0, true);
    expect(views[0]).toEqual({ id: 'a1', text: 'Wore Crocs', submittedAt: 5, status: 'approved', dayIndex: undefined });
  });

  // Codex P2, PR #845 round 10: the fallback text preference, once a
  // submission has been hard-hidden after an admin edited its wording — the
  // whole point `lastKnownText` exists, mirroring the SAME correction
  // `lastKnownStatus`/`lastKnownDayIndex` already made for status/target.
  it('falls back to lastKnownText (the last observed admin-edited wording), not the locally-tracked ORIGINAL text', () => {
    const tracked = [
      {
        id: 'a1',
        text: 'my original wording',
        submittedAt: 5,
        lastKnownStatus: 'approved' as const,
        lastKnownText: 'admin-edited wording',
      },
    ];
    const views = deriveMySubmissions(tracked, [], [], days, 0, true);
    expect(views[0].text).toBe('admin-edited wording');
  });

  it('falls back to the locally-tracked ORIGINAL text when no lastKnownText was ever recorded (never observed active)', () => {
    const tracked = [{ id: 'a1', text: 'my original wording', submittedAt: 5 }];
    const views = deriveMySubmissions(tracked, [], [], days, 0, true);
    expect(views[0].text).toBe('my original wording');
  });
});

describe('refreshLastKnownStatuses (#559, Codex P2, PR #845 rounds 7 + 10)', () => {
  it('stamps lastKnownStatus/lastKnownDayIndex/lastKnownText the first time a tracked entry is observed active', () => {
    const tracked = [{ id: 'a1', text: 'Wore Crocs', submittedAt: 5 }];
    const activeMine = [item({ id: 'a1', status: 'active', targetDayIndex: 2, text: 'Wore Crocs to dinner' })];
    const refreshed = refreshLastKnownStatuses(tracked, activeMine, [day(2, { unlockAt: 9999 })], 0);
    expect(refreshed).not.toBe(tracked);
    expect(refreshed[0]).toMatchObject({
      lastKnownStatus: 'scheduled',
      lastKnownDayIndex: 2,
      lastKnownText: 'Wore Crocs to dinner',
    });
  });

  it('returns the SAME array reference when nothing actually changed (no-op, no needless persistence)', () => {
    const tracked = [
      {
        id: 'a1',
        text: 'Wore Crocs',
        submittedAt: 5,
        lastKnownStatus: 'scheduled' as const,
        lastKnownDayIndex: 2,
        lastKnownText: 'Wore Crocs to dinner',
      },
    ];
    const activeMine = [item({ id: 'a1', status: 'active', targetDayIndex: 2, text: 'Wore Crocs to dinner' })];
    const refreshed = refreshLastKnownStatuses(tracked, activeMine, [day(2, { unlockAt: 9999 })], 0);
    expect(refreshed).toBe(tracked);
  });

  it('leaves an entry untouched when it is NOT currently found in activeMine — a transient gap or a hard-hide keeps its last recorded state', () => {
    const tracked = [
      { id: 'a1', text: 'Wore Crocs', submittedAt: 5, lastKnownStatus: 'approved' as const, lastKnownDayIndex: undefined },
    ];
    const refreshed = refreshLastKnownStatuses(tracked, [], [], 0);
    expect(refreshed).toBe(tracked);
    expect(refreshed[0].lastKnownStatus).toBe('approved');
  });

  it('updates an entry whose observed status moved on (e.g. scheduled -> approved once its Day dealt) — dayIndex still reflects the stored target either way', () => {
    const tracked = [
      { id: 'a1', text: 'Wore Crocs', submittedAt: 5, lastKnownStatus: 'scheduled' as const, lastKnownDayIndex: 2 },
    ];
    const activeMine = [item({ id: 'a1', status: 'active', targetDayIndex: 2 })];
    // The Day has since stamped — no longer targetable, so submitterStatus now reads 'approved'.
    const refreshed = refreshLastKnownStatuses(tracked, activeMine, [day(2, { unlockAt: 9999, snapshotItemIds: ['a1'] })], 0);
    expect(refreshed[0]).toMatchObject({ lastKnownStatus: 'approved', lastKnownDayIndex: 2 });
  });

  // Codex P2, PR #845 round 10: an admin may edit a submission's wording
  // AFTER approval — the observed active document's text is what re-stamps
  // here, not the locally-tracked original, so a since-hard-hidden
  // submission's fallback text (deriveMySubmissions) can stay authoritative
  // too instead of reverting to the pre-edit wording.
  it('re-stamps lastKnownText when the active document text changes (an admin edit)', () => {
    const tracked = [
      {
        id: 'a1',
        text: 'original wording',
        submittedAt: 5,
        lastKnownStatus: 'approved' as const,
        lastKnownText: 'original wording',
      },
    ];
    const activeMine = [item({ id: 'a1', status: 'active', text: 'admin-edited wording' })];
    const refreshed = refreshLastKnownStatuses(tracked, activeMine, [], 0);
    expect(refreshed).not.toBe(tracked);
    expect(refreshed[0].lastKnownText).toBe('admin-edited wording');
  });
});
