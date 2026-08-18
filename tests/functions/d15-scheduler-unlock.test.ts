import { describe, it, expect, vi } from 'vitest';
import {
  isDueForSnapshot,
  daysDueForSnapshot,
  activeSnapshotIds,
  finaleTimes,
  finaleActions,
  isEventAdmin,
  LAST_CALL_LEAD_MS,
  stampDaySnapshot,
  runScheduledUnlock,
  manualUnlockNow,
  UnlockPermissionError,
  type AdminFirestore,
  type DayLike,
  type EventLike,
  runFinaleBeats,
} from '../../functions/src/unlockDay';

// specs/d15-scheduler-unlock.md — the Phase 1.5 daily scheduler (#202,
// daily-cards-spec § "Unlock mechanics" / "Scoring and social surfaces"). Pure
// decision logic + an idempotent, DI'd write path (mirrors autohide.ts): the
// snapshot-at-unlock stamp, the finale two-beat finish (20:00 Day 9 last-call /
// 08:00 Day 10 freeze + podium), and the admin "unlock now" fallback. Every
// Firestore seam is a fake — no live runtime. Runs via `npm run test:functions`.

// --- In-memory Firestore fake ---------------------------------------------------

interface StoredItem {
  id: string;
  status: string;
  pool?: string;
  isFreeSpace?: boolean;
  reportCount?: number;
  createdBy?: string;
  createdAt?: number;
  approvedAt?: number;
}
interface StoredMoment {
  id: string;
  [k: string]: unknown;
}

/** A minimal in-memory stand-in for the admin-SDK surface unlockDay.ts injects. */
function makeDb(seed: {
  eventId: string;
  event: EventLike;
  items?: StoredItem[];
  moments?: StoredMoment[];
  // #266: the roster the finale content builders read.
  players?: Array<Record<string, unknown>>;
  // #266: pinned day honors, keyed by dayIndex.
  dayHonors?: Record<number, Record<string, unknown>>;
}): AdminFirestore & { readEvent(): EventLike; moments(): StoredMoment[] } {
  const docs: Record<string, Record<string, unknown> | undefined> = {
    [`events/${seed.eventId}`]: { ...seed.event } as Record<string, unknown>,
  };
  for (const [dayIndex, honor] of Object.entries(seed.dayHonors ?? {})) {
    docs[`events/${seed.eventId}/days/${dayIndex}/meta/${dayIndex}`] = honor;
  }
  const players = [...(seed.players ?? [])];
  const items = [...(seed.items ?? [])];
  const moments = [...(seed.moments ?? [])];
  let momentSeq = moments.length;

  const snapshotOf = (path: string) => {
    const data = docs[path];
    return { exists: data !== undefined, id: path.split('/').pop() as string, data: () => data };
  };

  const docRef = (path: string) => ({
    get: async () => snapshotOf(path),
    set: async (data: Record<string, unknown>) => {
      docs[path] = { ...data };
      return undefined;
    },
  });

  const collectionRef = (path: string) => {
    const filters: Array<[string, unknown]> = [];
    const backing = (): Array<Record<string, unknown>> =>
      path.endsWith('/items')
        ? (items as Array<Record<string, unknown>>)
        : path.endsWith('/moments')
          ? (moments as Array<Record<string, unknown>>)
          : path.endsWith('/players')
            ? players
            : [];
    const api: any = {
      where(field: string, _op: string, value: unknown) {
        filters.push([field, value]);
        return api;
      },
      async get() {
        const rows = (backing() as Array<Record<string, unknown>>).filter((row) =>
          filters.every(([f, v]) => row[f] === v),
        );
        return { docs: rows.map((row) => ({ exists: true, id: row.id as string, data: () => row })) };
      },
      doc(id?: string) {
        if (path.endsWith('/moments')) {
          const mid = id ?? `m${++momentSeq}`;
          return {
            get: async () => ({ exists: false, id: mid, data: () => undefined }),
            set: async (data: Record<string, unknown>) => {
              // Upsert by id, mirroring Firestore's `doc(id).set` overwrite so a
              // deterministic-id (`kind`) re-post replaces rather than duplicates.
              const at = moments.findIndex((m) => m.id === mid);
              if (at >= 0) moments[at] = { id: mid, ...data };
              else moments.push({ id: mid, ...data });
              return undefined;
            },
          };
        }
        return docRef(`${path}/${id}`);
      },
    };
    return api;
  };

  return {
    doc: (path: string) => docRef(path),
    collection: (path: string) => collectionRef(path),
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        get: async (ref: { get(): Promise<unknown> }) => ref.get(),
        update: (ref: { set(d: Record<string, unknown>): Promise<unknown> }, data: Record<string, unknown>) => {
          // merge onto the current doc (the surface only ever updates the event doc)
          const current = (docs[`events/${seed.eventId}`] ?? {}) as Record<string, unknown>;
          docs[`events/${seed.eventId}`] = { ...current, ...data };
          void ref;
        },
      };
      return fn(tx);
    },
    readEvent: () => docs[`events/${seed.eventId}`] as unknown as EventLike,
    moments: () => moments,
  };
}

// Clock anchors (ms epoch); the exact values don't matter, only their ordering.
const D9_UNLOCK = Date.UTC(2026, 6, 24, 6, 0); // Day 9 08:00 Europe/Rome (summer = UTC+2)
const D10_UNLOCK = Date.UTC(2026, 6, 25, 6, 0); // Day 10 08:00 Europe/Rome

function mainDays(): DayLike[] {
  return [
    { index: 8, pool: 'main', unlockAt: D9_UNLOCK }, // Day 9
    { index: 9, pool: 'farewell', unlockAt: D10_UNLOCK }, // Day 10 (farewell)
  ];
}

describe('isDueForSnapshot / daysDueForSnapshot — the due-and-unstamped gate', () => {
  it('is due when unlockAt has passed and no snapshot exists', () => {
    expect(isDueForSnapshot({ index: 0, pool: 'main', unlockAt: 100 }, 200)).toBe(true);
  });
  it('is NOT due when unlockAt is still in the future', () => {
    expect(isDueForSnapshot({ index: 0, pool: 'main', unlockAt: 300 }, 200)).toBe(false);
  });
  it('is NOT due once a snapshot exists — even an empty one (idempotency)', () => {
    expect(isDueForSnapshot({ index: 0, pool: 'main', unlockAt: 100, snapshotItemIds: [] }, 200)).toBe(false);
    expect(isDueForSnapshot({ index: 0, pool: 'main', unlockAt: 100, snapshotItemIds: ['a'] }, 200)).toBe(false);
  });
  it('selects only the due, unstamped Days', () => {
    const days: DayLike[] = [
      { index: 0, pool: 'main', unlockAt: 100 },
      { index: 1, pool: 'main', unlockAt: 100, snapshotItemIds: ['x'] },
      { index: 2, pool: 'main', unlockAt: 500 },
    ];
    expect(daysDueForSnapshot(days, 200).map((d) => d.index)).toEqual([0]);
  });
});

describe('activeSnapshotIds — the frozen pool mirrors the live deal pool', () => {
  const OPEN = { cutoff: Number.MAX_SAFE_INTEGER }; // no cutoff exclusion

  it('keeps only the requested pool and defaults a missing pool to main', () => {
    const items = [
      { id: 'a', pool: 'main' },
      { id: 'b', pool: 'embark' },
      { id: 'c' }, // legacy, no pool → main
      { id: 'd', pool: 'farewell' },
    ];
    expect(activeSnapshotIds(items, { pool: 'main', ...OPEN })).toEqual(['a', 'c']);
    expect(activeSnapshotIds(items, { pool: 'embark', ...OPEN })).toEqual(['b']);
    expect(activeSnapshotIds(items, { pool: 'farewell', ...OPEN })).toEqual(['d']);
  });

  it('drops isFreeSpace sentinels — the free center is dealt separately (#228)', () => {
    const items = [
      { id: 'a', pool: 'main' },
      { id: 'free', pool: 'main', isFreeSpace: true },
    ];
    expect(activeSnapshotIds(items, { pool: 'main', ...OPEN })).toEqual(['a']);
  });

  it('drops community-hidden and banned-author items, like the live pool (#228)', () => {
    const items = [
      { id: 'ok', pool: 'main', reportCount: 1, createdBy: 'u1' },
      { id: 'reported', pool: 'main', reportCount: 5, createdBy: 'u2' },
      { id: 'banned', pool: 'main', reportCount: 0, createdBy: 'villain' },
    ];
    const ids = activeSnapshotIds(items, {
      pool: 'main',
      ...OPEN,
      reportHideThreshold: 5,
      bannedUids: ['villain'],
    });
    expect(ids).toEqual(['ok']);
  });

  it('fails OPEN on a non-positive threshold or empty ban roster (no over-filtering)', () => {
    const items = [{ id: 'a', pool: 'main', reportCount: 99, createdBy: 'u1' }];
    expect(activeSnapshotIds(items, { pool: 'main', ...OPEN, reportHideThreshold: 0 })).toEqual(['a']);
    expect(activeSnapshotIds(items, { pool: 'main', ...OPEN, bannedUids: [] })).toEqual(['a']);
  });

  it('excludes items that entered the pool AFTER the Day cutoff (approvedAt ?? createdAt)', () => {
    const items = [
      { id: 'legacy', pool: 'main' }, // no timestamps → fail open, kept
      { id: 'created-before', pool: 'main', createdAt: 100 },
      { id: 'created-after', pool: 'main', createdAt: 300 },
      { id: 'approved-before', pool: 'main', createdAt: 50, approvedAt: 150 },
      { id: 'approved-after', pool: 'main', createdAt: 50, approvedAt: 250 },
    ];
    expect(activeSnapshotIds(items, { pool: 'main', cutoff: 200 })).toEqual([
      'legacy',
      'created-before',
      'approved-before',
    ]);
  });

  it('a NON-POSITIVE cutoff applies no cutoff at all — an always-unlocked Day snapshots its full pool (#289)', () => {
    // The `unlockAt: 0` "live pre-cruise" sentinel used to feed cutoff=0 into the
    // entered-after exclusion: every item's createdAt > 0, so the ENTIRE pool was
    // dropped and the Day stamped an empty snapshot — which isDueForSnapshot then
    // treats as already-stamped (the no-forever-wait rule), permanently starving
    // the deal (the 2026-07-14 embark incident). Non-positive now means fail open.
    const items = [
      { id: 'a', pool: 'embark', createdAt: 100 },
      { id: 'b', pool: 'embark', createdAt: 300, approvedAt: 400 },
      { id: 'other-pool', pool: 'main', createdAt: 100 },
    ];
    expect(activeSnapshotIds(items, { pool: 'embark', cutoff: 0 })).toEqual(['a', 'b']);
    expect(activeSnapshotIds(items, { pool: 'embark', cutoff: -1 })).toEqual(['a', 'b']);
    // The other predicates still apply under the open cutoff.
    expect(
      activeSnapshotIds(
        [...items, { id: 'banned', pool: 'embark', createdAt: 100, createdBy: 'villain' }],
        { pool: 'embark', cutoff: 0, bannedUids: ['villain'] },
      ),
    ).toEqual(['a', 'b']);
  });
});

describe('stampDaySnapshot — the snapshot at unlock (AC 1)', () => {
  it('stamps a due, unstamped MAIN Day with BOTH pools — main + embark (easy mix)', async () => {
    // specs/easy-mix.md § "Snapshot carries both pools": a main day now freezes the main
    // pool AND the embark pool so the easy-mix squares ride the one snapshot.
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      items: [
        { id: 'a', status: 'active', pool: 'main' },
        { id: 'b', status: 'active', pool: 'main' },
        { id: 'c', status: 'pending', pool: 'main' }, // not active → excluded
        { id: 'd', status: 'active', pool: 'embark' }, // embark → INCLUDED on a main day
        { id: 'far', status: 'active', pool: 'farewell' }, // other tutorial pool → excluded
        { id: 'legacy', status: 'active' }, // no pool → main → included
      ],
    });
    const result = await stampDaySnapshot(db, 'e1', 8, { now: () => D9_UNLOCK + 1 });
    expect(result).toBe('stamped');
    const day = db.readEvent().days!.find((d) => d.index === 8)!;
    expect(day.snapshotItemIds).toEqual(['a', 'b', 'd', 'legacy']);
  });

  it('freezes only what the live pool would deal: no free-space, hidden, banned, or late items (#228)', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: {
        days: mainDays(),
        settings: { reportHideThreshold: 5 },
        bannedUids: ['villain'],
      },
      items: [
        { id: 'keep', status: 'active', pool: 'main', createdBy: 'u1', createdAt: D9_UNLOCK - 1000 },
        { id: 'free', status: 'active', pool: 'main', isFreeSpace: true },
        { id: 'reported', status: 'active', pool: 'main', reportCount: 5, createdBy: 'u2' },
        { id: 'banned', status: 'active', pool: 'main', createdBy: 'villain' },
        { id: 'late', status: 'active', pool: 'main', createdBy: 'u3', createdAt: D9_UNLOCK + 10_000 },
      ],
    });
    // Run late (10s after unlock): the `late` item, created after the 08:00 cutoff,
    // must still be excluded because the snapshot freezes the pool AS OF unlockAt.
    const result = await stampDaySnapshot(db, 'e1', 8, { now: () => D9_UNLOCK + 20_000 });
    expect(result).toBe('stamped');
    expect(db.readEvent().days!.find((d) => d.index === 8)!.snapshotItemIds).toEqual(['keep']);
  });

  it('leaves a Day whose unlockAt is still in the future untouched (AC: future Day)', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      items: [{ id: 'a', status: 'active', pool: 'farewell' }],
    });
    const result = await stampDaySnapshot(db, 'e1', 9, { now: () => D10_UNLOCK - 1 });
    expect(result).toBe('not-due');
    expect(db.readEvent().days!.find((d) => d.index === 9)!.snapshotItemIds).toBeUndefined();
  });

  it('is idempotent: a second run against an already-stamped Day is a no-op (AC 1 retry)', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      items: [{ id: 'a', status: 'active', pool: 'main' }],
    });
    const first = await stampDaySnapshot(db, 'e1', 8, { now: () => D9_UNLOCK + 1 });
    expect(first).toBe('stamped');
    const stampedIds = db.readEvent().days!.find((d) => d.index === 8)!.snapshotItemIds;

    // A new active item appears AFTER the first stamp — a re-run must NOT pick it up.
    const second = await stampDaySnapshot(db, 'e1', 8, { now: () => D9_UNLOCK + 5000 });
    expect(second).toBe('already-stamped');
    expect(db.readEvent().days!.find((d) => d.index === 8)!.snapshotItemIds).toEqual(stampedIds);
  });
});

describe('finaleTimes / finaleActions — the two-beat finish (AC 3)', () => {
  it('anchors last-call to Day 9 08:00 + 12h = 20:00 and freeze to the farewell unlock', () => {
    const t = finaleTimes(mainDays())!;
    expect(t.lastCallAt).toBe(D9_UNLOCK + LAST_CALL_LEAD_MS);
    expect(t.standingsFreezeAt).toBe(D10_UNLOCK);
    expect(t.lastCallDayIndex).toBe(8);
    expect(t.podiumDayIndex).toBe(9);
  });

  it('returns null when the Event has neither a ceremonial Day nor a configured freeze', () => {
    expect(finaleTimes([{ index: 0, pool: 'main', unlockAt: 1 }])).toBeNull();
  });

  it('posts last-call in [20:00 Day9, 08:00 Day10) and only when not already posted', () => {
    const t = finaleTimes(mainDays())!;
    const base = { lastCallPosted: false, podiumPosted: false, mostLovedComputed: false };
    expect(finaleActions(t, t.lastCallAt, base).postLastCall).toBe(true);
    expect(finaleActions(t, t.lastCallAt - 1, base).postLastCall).toBe(false); // before 20:00
    expect(finaleActions(t, t.standingsFreezeAt, base).postLastCall).toBe(false); // freeze supersedes
    expect(finaleActions(t, t.lastCallAt, { ...base, lastCallPosted: true }).postLastCall).toBe(false); // dedup
  });

  it('freezes at/after the farewell unlock only while not yet frozen', () => {
    const t = finaleTimes(mainDays())!;
    const base = { lastCallPosted: false, podiumPosted: false, mostLovedComputed: false };
    expect(finaleActions(t, t.standingsFreezeAt, base).freeze).toBe(true);
    expect(finaleActions(t, t.standingsFreezeAt - 1, base).freeze).toBe(false);
    expect(finaleActions(t, t.standingsFreezeAt, { ...base, frozenAt: 123 }).freeze).toBe(false);
  });

  it('posts the podium at/after the farewell unlock only while not already posted', () => {
    const t = finaleTimes(mainDays())!;
    const base = { lastCallPosted: false, podiumPosted: false, mostLovedComputed: false };
    expect(finaleActions(t, t.standingsFreezeAt, base).postPodium).toBe(true);
    expect(finaleActions(t, t.standingsFreezeAt - 1, base).postPodium).toBe(false);
    expect(finaleActions(t, t.standingsFreezeAt, { ...base, podiumPosted: true }).postPodium).toBe(false);
  });

  it('keeps the podium retry open after a run that froze but failed to post it (#228)', () => {
    const t = finaleTimes(mainDays())!;
    // An earlier run flipped frozenAt but its podium write failed transiently.
    const d = finaleActions(t, t.standingsFreezeAt + 60_000, {
      frozenAt: t.standingsFreezeAt,
      lastCallPosted: true,
      podiumPosted: false,
      mostLovedComputed: false,
    });
    expect(d.freeze).toBe(false); // already frozen — never re-freeze
    expect(d.postPodium).toBe(true); // but the podium beat is still owed
  });

  // #784 — Bodega's tail put the closing Day on the SAME calendar date as the
  // Day before it, which the plain forward `dayNine.unlockAt + 12h` offset
  // never anticipated: 06:00 + 12h = 18:00, well past the 11:00 freeze, so the
  // posting gate `[lastCallAt, standingsFreezeAt)` was empty and the beat could
  // never fire. Pin the exact seeded shape from
  // scripts/seed-data/bodega-bay-2026.mjs (index 2 'main' 06:00, index 3
  // 'farewell'/closing 11:00, both 2026-08-09) and assert the window is
  // non-empty and lands where the issue's derive-backwards option predicted.
  it('derives last-call backwards from the close when the preceding Day shares its calendar date (#784)', () => {
    const dayNineUnlock = Date.parse('2026-08-09T06:00:00-07:00'); // SUN_UNLOCK
    const farewellUnlock = Date.parse('2026-08-09T11:00:00-07:00'); // CHECKOUT_FREEZE
    const days: DayLike[] = [
      { index: 2, pool: 'main', unlockAt: dayNineUnlock },
      { index: 3, pool: 'farewell', unlockAt: farewellUnlock },
    ];

    const t = finaleTimes(days)!;

    // The forward offset (06:00 + 12h = 18:00) would land AFTER the freeze —
    // confirm that's true of this fixture, otherwise the regression proves
    // nothing.
    expect(dayNineUnlock + LAST_CALL_LEAD_MS).toBeGreaterThan(farewellUnlock);

    expect(t.lastCallAt).toBe(farewellUnlock - LAST_CALL_LEAD_MS);
    expect(t.lastCallAt).toBe(Date.parse('2026-08-08T23:00:00-07:00'));
    expect(t.lastCallAt).toBeLessThan(t.standingsFreezeAt);

    // The posting gate itself must now admit at least one instant.
    const base = { lastCallPosted: false, podiumPosted: false, mostLovedComputed: false };
    expect(finaleActions(t, t.lastCallAt, base).postLastCall).toBe(true);
  });

  // The normal multi-date shape (Day 9 and the farewell Day on DIFFERENT
  // calendar dates, as in `mainDays()`) must keep using the forward offset —
  // the #784 fix only changes behavior when the forward candidate would land
  // at-or-after the freeze.
  it('keeps the forward 08:00+12h derivation when Day 9 and the farewell Day fall on different dates', () => {
    const t = finaleTimes(mainDays())!;
    expect(t.lastCallAt).toBe(D9_UNLOCK + LAST_CALL_LEAD_MS);
    expect(t.lastCallAt).toBeLessThan(t.standingsFreezeAt);
  });

  // --- ADR 0011: the freeze is an Event setting, the policy is stated ---------

  it('leaves the live schedule s clock exactly where it was when nothing is configured', () => {
    // The regression pin: `mainDays()` is the ten-Day cruise shape with legacy
    // pool spellings and no `scoring`/`standingsFreezeAt` anywhere. Passing an
    // undefined configured freeze must reproduce the pre-ADR answer verbatim.
    expect(finaleTimes(mainDays(), undefined)).toEqual(finaleTimes(mainDays()));
    expect(finaleTimes(mainDays(), undefined)!.standingsFreezeAt).toBe(D10_UNLOCK);
  });

  it('prefers a CONFIGURED standingsFreezeAt over the ceremonial Day s unlock', () => {
    const configured = D10_UNLOCK + 3 * 60 * 60 * 1000; // 11:00, a check-out freeze
    const t = finaleTimes(mainDays(), configured)!;
    expect(t.standingsFreezeAt).toBe(configured);
    // The podium still files under the ceremonial Day — the freeze moved, the
    // schedule did not.
    expect(t.podiumDayIndex).toBe(9);
    // The forward last-call candidate (Day 9 08:00 + 12h) still precedes the
    // later freeze, so it is still preferred.
    expect(t.lastCallAt).toBe(D9_UNLOCK + LAST_CALL_LEAD_MS);
  });

  it('gives an ALL-COMPETITIVE schedule a finale once it states its own freeze', () => {
    // ADR 0011's motivating shape: the final morning deals the closing pool but
    // is real competitive play until check-out. Before this, the only way to get
    // a finale was to make that morning ceremonial — which froze the standings
    // at the card's own unlock and made the morning's marks inert.
    const checkout = D10_UNLOCK + 3 * 60 * 60 * 1000;
    const days: DayLike[] = [
      { index: 8, pool: 'main', unlockAt: D9_UNLOCK },
      { index: 9, pool: 'farewell', scoring: 'competitive', unlockAt: D10_UNLOCK },
    ];
    // Without a configured freeze there is no ceremonial Day, so no finale.
    expect(finaleTimes(days)).toBeNull();

    const t = finaleTimes(days, checkout)!;
    expect(t.standingsFreezeAt).toBe(checkout);
    // No ceremonial Day, so the podium files under the LAST Day of the schedule.
    expect(t.podiumDayIndex).toBe(9);
    expect(t.lastCallDayIndex).toBe(8);
    expect(t.lastCallAt).toBeLessThan(t.standingsFreezeAt);
  });

  it('honours a STATED ceremonial policy on a Day the pool would not have flagged', () => {
    const days: DayLike[] = [
      { index: 0, pool: 'main', unlockAt: D9_UNLOCK },
      { index: 1, pool: 'main', scoring: 'ceremonial', unlockAt: D10_UNLOCK },
    ];
    const t = finaleTimes(days)!;
    expect(t.standingsFreezeAt).toBe(D10_UNLOCK);
    expect(t.podiumDayIndex).toBe(1);
  });

  it('ignores a non-positive or non-finite configured freeze rather than honouring it', () => {
    // 0 is the schedule's "always unlocked" sentinel elsewhere in this file, so
    // reading it as an instant would freeze every Event at the epoch. Mirrors
    // `standingsFreezeAtFor` in src/game/logic.ts.
    for (const bad of [0, -1, Number.NaN]) {
      expect(finaleTimes(mainDays(), bad)!.standingsFreezeAt).toBe(D10_UNLOCK);
    }
  });

  it('returns null for a configured freeze on an Event with no schedule at all', () => {
    // There is no Day to file the Moments under, and a Moment at Day -1 renders
    // nowhere — the same "no finale" answer, not a podium posted into the void.
    expect(finaleTimes([], D10_UNLOCK)).toBeNull();
  });

  it('never files the last-call Moment under Day -1 on a single-Day schedule', () => {
    const t = finaleTimes([{ index: 0, pool: 'farewell', unlockAt: D10_UNLOCK }])!;
    expect(t.podiumDayIndex).toBe(0);
    expect(t.lastCallDayIndex).toBe(0); // clamped: Day -1 is not a Day
  });

  it('logs loudly when a configured freeze empties the last-call window (#784 guard)', () => {
    // An organiser can now configure a freeze EARLIER than the preceding Day's
    // unlock, which the schedule alone could not produce. The window guard has
    // to catch that too, or the beat silently never fires.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const t = finaleTimes(mainDays(), D9_UNLOCK - LAST_CALL_LEAD_MS)!;
      expect(t.lastCallAt).toBe(t.standingsFreezeAt - LAST_CALL_LEAD_MS);
      // The backward branch keeps the window non-empty even here, so the guard
      // should NOT fire — assert the healthy case explicitly rather than
      // assuming it.
      expect(t.lastCallAt).toBeLessThan(t.standingsFreezeAt);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runScheduledUnlock — the finale beats through the write path (AC 3)', () => {
  it('at 20:00 Day 9 posts exactly one last_call Moment and does not touch frozenAt', async () => {
    const db = makeDb({ eventId: 'e1', event: { days: mainDays() } });
    const at2000Day9 = D9_UNLOCK + LAST_CALL_LEAD_MS;
    await runScheduledUnlock(db, 'e1', { now: () => at2000Day9 });
    await runScheduledUnlock(db, 'e1', { now: () => at2000Day9 + 60_000 }); // retry same window

    const lastCalls = db.moments().filter((m) => m.kind === 'last_call');
    expect(lastCalls).toHaveLength(1);
    expect(lastCalls[0].dayIndex).toBe(8);
    expect(lastCalls[0].id).toBe('last_call'); // deterministic id → renders in the Feed (#228)
    expect(db.moments().filter((m) => m.kind === 'podium')).toHaveLength(0);
    expect(db.readEvent().frozenAt).toBeUndefined();
  });

  it('at 08:00 Day 10 sets frozenAt and posts exactly one podium Moment', async () => {
    const db = makeDb({ eventId: 'e1', event: { days: mainDays() } });
    await runScheduledUnlock(db, 'e1', { now: () => D10_UNLOCK });
    await runScheduledUnlock(db, 'e1', { now: () => D10_UNLOCK + 60_000 }); // retry

    expect(db.readEvent().frozenAt).toBe(D10_UNLOCK);
    const podiums = db.moments().filter((m) => m.kind === 'podium');
    expect(podiums).toHaveLength(1);
    expect(podiums[0].dayIndex).toBe(9);
    expect(podiums[0].id).toBe('podium'); // deterministic id → renders in the Feed (#228)
    // The farewell Day's own snapshot is stamped by the SAME run that froze
    // standings — one sweep does every beat that is due (#552).
    expect(db.readEvent().days!.find((d) => d.index === 9)!.snapshotItemIds).toEqual([]);
  });

  it('stamps frozenAt with the scheduled 08:00 cutoff even when the run is late (#228)', async () => {
    const db = makeDb({ eventId: 'e1', event: { days: mainDays() } });
    // A recovery run fires two hours late; frozenAt must still be the 08:00 cutoff,
    // not the run clock, so post-08:00 marks never slip into the frozen standings.
    await runScheduledUnlock(db, 'e1', { now: () => D10_UNLOCK + 2 * 60 * 60 * 1000 });
    expect(db.readEvent().frozenAt).toBe(D10_UNLOCK);
  });
});

describe('manualUnlockNow — the admin fallback (AC 2)', () => {
  it('is admin-gated: isEventAdmin only accepts a uid on the roster', () => {
    const event: EventLike = { admins: ['admin-1'] };
    expect(isEventAdmin(event, 'admin-1')).toBe(true);
    expect(isEventAdmin(event, 'someone-else')).toBe(false);
    expect(isEventAdmin(event, undefined)).toBe(false);
    expect(isEventAdmin({}, 'admin-1')).toBe(false);
  });

  it('produces the identical snapshot the scheduled path would for the same Day', async () => {
    const seed = () => ({
      eventId: 'e1',
      event: { days: mainDays(), admins: ['admin-1'] },
      items: [
        { id: 'a', status: 'active', pool: 'main' },
        { id: 'b', status: 'active', pool: 'main' },
      ],
    });
    const now = () => D9_UNLOCK + 1;

    const scheduled = makeDb(seed());
    await stampDaySnapshot(scheduled, 'e1', 8, { now });

    const manual = makeDb(seed());
    const result = await manualUnlockNow(manual, 'admin-1', 'e1', 8, { now });

    expect(result).toBe('stamped');
    const manualIds = manual.readEvent().days!.find((d) => d.index === 8)!.snapshotItemIds;
    const scheduledIds = scheduled.readEvent().days!.find((d) => d.index === 8)!.snapshotItemIds;
    expect(manualIds).toEqual(scheduledIds);
    expect(manualIds).toEqual(['a', 'b']);
  });

  it('denies a non-admin caller with UnlockPermissionError and writes nothing', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays(), admins: ['admin-1'] },
      items: [{ id: 'a', status: 'active', pool: 'main' }],
    });
    await expect(manualUnlockNow(db, 'not-an-admin', 'e1', 8, { now: () => D9_UNLOCK + 1 })).rejects.toBeInstanceOf(
      UnlockPermissionError,
    );
    expect(db.readEvent().days!.find((d) => d.index === 8)!.snapshotItemIds).toBeUndefined();
  });
});

describe('runFinaleBeats — the beats carry their CONTENT (#266)', () => {
  it('the last-call Moment carries the standings line built from the ban-filtered roster', async () => {
    const db = makeDb({
      eventId: 'e',
      // #800: D10_UNLOCK is 06:00 UTC — the Event's own 'Europe/Rome' zone is
      // what makes that 08:00, so the fixture must carry it for the freeze
      // phrase to read "8 a.m." rather than a UTC-formatted "6 a.m.".
      event: { days: mainDays(), bannedUids: ['muted'], timezone: 'Europe/Rome' },
      players: [
        { uid: 'jess', displayName: 'Jess', bingoCount: 3, squaresMarked: 40, firstBingoAt: 10 },
        { uid: 'rex', displayName: 'Rex', bingoCount: 1, squaresMarked: 44, firstBingoAt: 20 },
        { uid: 'muted', displayName: 'Muted', bingoCount: 9, squaresMarked: 99, firstBingoAt: 1 },
      ],
    });
    await runFinaleBeats(db, 'e', { now: () => D9_UNLOCK + 13 * 60 * 60 * 1000 });
    const lastCall = db.moments().find((m) => m.kind === 'last_call')!;
    // The banned leader never headlines; Jess leads Rex by 2 bingos.
    expect(lastCall.line).toBe('Jess leads by 2 bingos—standings freeze at 8 a.m.');
    expect(lastCall.lastCall).toMatchObject({
      freezePhrase: 'standings freeze at 8 a.m',
      players: [
        { uid: 'jess', displayName: 'Jess', bingoCount: 3, squaresMarked: 40 },
        { uid: 'rex', displayName: 'Rex', bingoCount: 1, squaresMarked: 44 },
        { uid: 'muted', displayName: 'Muted', bingoCount: 9, squaresMarked: 99 },
      ],
    });
  });

  it('uses the player document id as the canonical finale roster uid when the field is missing', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), timezone: 'Europe/Rome' },
      players: [
        { id: 'jess', displayName: 'Jess', bingoCount: 3, squaresMarked: 40, firstBingoAt: 10 },
        { id: 'rex', displayName: 'Rex', bingoCount: 1, squaresMarked: 44, firstBingoAt: 20 },
      ],
    });
    await runFinaleBeats(db, 'e', { now: () => D9_UNLOCK + 13 * 60 * 60 * 1000 });
    const lastCall = db.moments().find((m) => m.kind === 'last_call')!;
    expect(lastCall.line).toBe('Jess leads by 2 bingos—standings freeze at 8 a.m.');
    expect(lastCall.lastCall).toMatchObject({
      players: [
        { uid: 'jess', displayName: 'Jess' },
        { uid: 'rex', displayName: 'Rex' },
      ],
    });
  });

  it('uses the player document id as the canonical uid for ban filtering and stored payloads', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), bannedUids: ['muted'], timezone: 'Europe/Rome' },
      players: [
        { id: 'jess', uid: 'jess', displayName: 'Jess', bingoCount: 3, squaresMarked: 40, firstBingoAt: 10 },
        { id: 'muted', uid: 'spoofed-safe-uid', displayName: 'Muted', bingoCount: 9, squaresMarked: 99, firstBingoAt: 1 },
      ],
    });
    await runFinaleBeats(db, 'e', { now: () => D9_UNLOCK + 13 * 60 * 60 * 1000 });
    const lastCall = db.moments().find((m) => m.kind === 'last_call')!;
    expect(lastCall.line).toBe('Jess has the board to themselves going into the final night—standings freeze at 8 a.m.');
    expect(lastCall.lastCall).toMatchObject({
      players: [
        { uid: 'jess', displayName: 'Jess' },
        { uid: 'muted', displayName: 'Muted' },
      ],
    });
  });

  it("#800: derives the freeze phrase from the Event's ACTUAL closing-Day unlock, not a hardcoded 8 a.m.", async () => {
    // Bodega's exact shape (the issue's own example): a closing Day unlocking
    // at 11:00 local, not 08:00. A schedule shaped like this used to post
    // "standings freeze at 8 a.m." regardless — the wrong time entirely.
    const bodegaFarewellUnlock = Date.UTC(2026, 6, 25, 18, 0); // 11:00 America/Los_Angeles (PDT, UTC-7)
    const db = makeDb({
      eventId: 'e',
      event: {
        days: [
          { index: 8, pool: 'main', unlockAt: Date.UTC(2026, 6, 24, 6, 0) },
          { index: 9, pool: 'farewell', unlockAt: bodegaFarewellUnlock },
        ],
        timezone: 'America/Los_Angeles',
      },
      players: [{ uid: 'jess', displayName: 'Jess', bingoCount: 1, squaresMarked: 5, firstBingoAt: 10 }],
    });
    await runFinaleBeats(db, 'e', { now: () => bodegaFarewellUnlock - 1 });
    const lastCall = db.moments().find((m) => m.kind === 'last_call')!;
    expect(lastCall.line).toBe('Jess has the board to themselves going into the final night—standings freeze at 11 a.m.');
    expect(lastCall.lastCall).toMatchObject({ freezePhrase: 'standings freeze at 11 a.m' });
  });

  // Phase 4b P1: the beat's own podium build must carry the freeze cutoff.
  // `postPodium` is retried until the Moment lands, so a delayed sweep or a
  // retry after a transient write failure reads LIVE ceremonial-Day buckets —
  // and whatever it selects is then posted PERMANENTLY.
  it('ADR 0011: the posted podium ignores a post-freeze bingo on a ceremonial Day', async () => {
    const freeze = D10_UNLOCK;
    const db = makeDb({
      eventId: 'e',
      event: {
        days: [
          { index: 8, pool: 'main', unlockAt: D9_UNLOCK },
          // Ceremonial but NOT a Tutorial Day, so it stays eligible for the
          // Event-wide honour — which is what makes the cutoff load-bearing.
          { index: 9, pool: 'farewell', tutorial: false, scoring: 'ceremonial', unlockAt: freeze },
        ],
      },
      players: [
        {
          uid: 'late',
          displayName: 'Late',
          bingoCount: 1,
          squaresMarked: 10,
          firstBingoAt: freeze + 5000,
          dayStats: {
            8: { bingoCount: 0, squaresMarked: 6, firstBingoAt: null },
            9: { bingoCount: 1, squaresMarked: 4, firstBingoAt: freeze + 5000 },
          },
        },
      ],
    });
    // The sweep runs LATE — after the freeze, with the post-freeze mark already
    // recorded in the ceremonial Day's bucket.
    await runFinaleBeats(db, 'e', { now: () => freeze + 60_000 });
    const podium = db.moments().find((m) => m.kind === 'podium')!;
    expect((podium.podium as { firstBingo: unknown }).firstBingo).toBeNull();
  });

  it('ADR 0011: quotes the CONFIGURED freeze, not a Day unlock, when the two differ', async () => {
    // The interaction between #800 (this phrase) and #551 (ADR 0011). #800
    // shipped deriving the phrase from the closing Day's `unlockAt`, which was
    // the freeze by construction at the time. It no longer is: an Event whose
    // final morning plays competitively until an 11:00 check-out states its own
    // `standingsFreezeAt`, and NO Day's unlock equals it. Quoting a Day here
    // would announce a deadline three hours before the real one — reintroducing
    // #800's bug one layer up, which is why `runFinaleBeats` feeds this
    // `times.standingsFreezeAt` rather than any Day's unlock.
    const finalMorningUnlock = Date.UTC(2026, 6, 25, 15, 0); // 08:00 America/Los_Angeles
    const checkoutFreeze = Date.UTC(2026, 6, 25, 18, 0); // 11:00 — the STATED freeze
    const db = makeDb({
      eventId: 'e',
      event: {
        days: [
          { index: 0, pool: 'main', unlockAt: Date.UTC(2026, 6, 24, 15, 0) },
          // Deals the closing pool, but STATES that it counts — so it is not
          // ceremonial, and its unlock is not the freeze.
          { index: 1, pool: 'farewell', scoring: 'competitive', unlockAt: finalMorningUnlock },
        ],
        standingsFreezeAt: checkoutFreeze,
        timezone: 'America/Los_Angeles',
      },
      players: [{ uid: 'jess', displayName: 'Jess', bingoCount: 1, squaresMarked: 5, firstBingoAt: 10 }],
    });
    await runFinaleBeats(db, 'e', { now: () => checkoutFreeze - 1 });
    const lastCall = db.moments().find((m) => m.kind === 'last_call')!;
    // 11 a.m — the configured freeze. The final Day's own 08:00 unlock, which
    // the pre-ADR derivation would have quoted, is explicitly NOT the answer.
    expect(lastCall.lastCall).toMatchObject({ freezePhrase: 'standings freeze at 11 a.m' });
    expect(lastCall.line).toContain('standings freeze at 11 a.m.');
    expect(lastCall.line).not.toContain('8 a.m');
  });

  it('the podium Moment carries champion + cruise First-to-BINGO + the pinned daily honors', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays() },
      players: [
        {
          uid: 'jess',
          displayName: 'Jess',
          bingoCount: 3,
          squaresMarked: 40,
          firstBingoAt: 10,
          dayStats: { 8: { bingoCount: 3, squaresMarked: 40, firstBingoAt: 10 } },
        },
      ],
      dayHonors: { 8: { firstBingo: { uid: 'jess', displayName: 'Jess', at: 10 } } },
    });
    await runFinaleBeats(db, 'e', { now: () => D10_UNLOCK + 1000 });
    const podium = db.moments().find((m) => m.kind === 'podium')! as Record<string, unknown> & {
      podium?: { champion?: { displayName?: string } | null; firstBingo?: { displayName?: string } | null; dailyHonors?: unknown[] };
    };
    expect(podium.podium?.champion?.displayName).toBe('Jess');
    expect(podium.podium?.firstBingo?.displayName).toBe('Jess');
    expect(podium.podium?.dailyHonors).toHaveLength(1);
  });

  it('preserves raw daily honors in the stored podium Moment so reversible bans can re-render', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), bannedUids: ['muted'] },
      players: [
        {
          uid: 'jess',
          displayName: 'Jess',
          bingoCount: 3,
          squaresMarked: 40,
          firstBingoAt: 10,
          dayStats: { 8: { bingoCount: 3, squaresMarked: 40, firstBingoAt: 10 } },
        },
      ],
      dayHonors: {
        8: { firstBingo: { uid: 'muted', displayName: 'Muted', at: 1 } },
        9: { firstBingo: { uid: 'jess', displayName: 'Jess', at: 10 } },
      },
    });
    await runFinaleBeats(db, 'e', { now: () => D10_UNLOCK + 1000 });
    const podium = db.moments().find((m) => m.kind === 'podium')! as Record<string, unknown> & {
      podium?: { dailyHonors?: Array<{ uid: string; displayName: string }> };
    };
    expect(podium.podium?.dailyHonors).toEqual([
      { dayIndex: 8, uid: 'muted', displayName: 'Muted', at: 1 },
      { dayIndex: 9, uid: 'jess', displayName: 'Jess', at: 10 },
    ]);
  });

  it('normalizes malformed player dayStats before building podium content', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays() },
      players: [
        {
          uid: 'jess',
          displayName: 'Jess',
          bingoCount: 3,
          squaresMarked: 40,
          firstBingoAt: 10,
          dayStats: { 8: null, 9: { bingoCount: 'bad', squaresMarked: 'bad', firstBingoAt: 'bad' } },
        },
      ],
    });
    await runFinaleBeats(db, 'e', { now: () => D10_UNLOCK + 1000 });
    const podium = db.moments().find((m) => m.kind === 'podium')! as Record<string, unknown> & {
      podium?: { champion?: { displayName?: string; bingoCount?: number; squaresMarked?: number } | null };
    };
    expect(podium.podium?.champion).toMatchObject({ displayName: 'Jess', bingoCount: 3, squaresMarked: 40 });
  });

  it('a roster read failure still posts the minimal beat (content is best-effort)', async () => {
    const db = makeDb({ eventId: 'e', event: { days: mainDays() } });
    const failing = {
      ...db,
      collection: (path: string) => {
        if (path.endsWith('/players')) throw new Error('unavailable');
        return db.collection(path);
      },
    } as typeof db;
    await runFinaleBeats(failing, 'e', { now: () => D9_UNLOCK + 13 * 60 * 60 * 1000 });
    const lastCall = db.moments().find((m) => m.kind === 'last_call')!;
    expect(lastCall.id).toBe('last_call');
    expect(lastCall.line).toBeUndefined();
  });
});
