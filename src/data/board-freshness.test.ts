import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetBoardFreshnessForTests,
  beginDayBoardSeedWatch as beginScopedWatch,
  recordDayBoardSeedSnapshot as recordScopedSnapshot,
  trustedDayBoardSeed as trustedScopedSeed,
} from './board-freshness';

const EVENT_ID = 'event-a';
const beginDayBoardSeedWatch = (dayIndex: number, uid: string) =>
  beginScopedWatch(EVENT_ID, dayIndex, uid);
const recordDayBoardSeedSnapshot = (
  dayIndex: number,
  uid: string,
  snapshot: Parameters<typeof recordScopedSnapshot>[3],
) => recordScopedSnapshot(EVENT_ID, dayIndex, uid, snapshot);
const trustedDayBoardSeed = (dayIndex: number, uid: string) =>
  trustedScopedSeed(EVENT_ID, dayIndex, uid);

// #474 — the Echo seed-freshness registry: trust a sibling Day board's cached
// seed only while a live watch has delivered a fully server-committed
// snapshot. Pure module-state unit tests; the end-to-end wiring is exercised
// by src/data/echo-marks.test.ts and tests/offline/echo-marks.test.ts.

const snap = (
  fromCache: boolean,
  hasPendingWrites: boolean,
  data: { seed?: number } | null,
) => ({
  metadata: { fromCache, hasPendingWrites },
  exists: () => data !== null,
  data: () => data ?? undefined,
});

beforeEach(() => __resetBoardFreshnessForTests());

describe('board-freshness registry (#474)', () => {
  it('is untrusted until a fully server-committed snapshot arrives under a live watch', () => {
    expect(trustedDayBoardSeed(1, 'u1').trusted).toBe(false);
    beginDayBoardSeedWatch(1, 'u1');
    expect(trustedDayBoardSeed(1, 'u1').trusted).toBe(false);
    recordDayBoardSeedSnapshot(1, 'u1', snap(true, false, { seed: 5 })); // cache-origin
    expect(trustedDayBoardSeed(1, 'u1').trusted).toBe(false);
    recordDayBoardSeedSnapshot(1, 'u1', snap(false, true, { seed: 5 })); // local optimistic
    expect(trustedDayBoardSeed(1, 'u1').trusted).toBe(false);
    recordDayBoardSeedSnapshot(1, 'u1', snap(false, false, { seed: 5 }));
    expect(trustedDayBoardSeed(1, 'u1')).toEqual({ trusted: true, seed: 5 });
  });

  it('latches through a later cache-origin snapshot (offline Marks must still echo) but tracks new server seeds', () => {
    beginDayBoardSeedWatch(2, 'u1');
    recordDayBoardSeedSnapshot(2, 'u1', snap(false, false, { seed: 7 }));
    recordDayBoardSeedSnapshot(2, 'u1', snap(true, false, { seed: 8 })); // network dropped
    expect(trustedDayBoardSeed(2, 'u1')).toEqual({ trusted: true, seed: 7 });
    recordDayBoardSeedSnapshot(2, 'u1', snap(false, false, { seed: 9 })); // remote reshuffle pushed
    expect(trustedDayBoardSeed(2, 'u1')).toEqual({ trusted: true, seed: 9 });
  });

  it('drops the entry fail-closed when the LAST watcher releases, surviving overlapping watchers', () => {
    const releaseA = beginDayBoardSeedWatch(3, 'u1');
    const releaseB = beginDayBoardSeedWatch(3, 'u1');
    recordDayBoardSeedSnapshot(3, 'u1', snap(false, false, { seed: 11 }));
    releaseA();
    releaseA(); // idempotent — a double release never steals watcher B's slot
    expect(trustedDayBoardSeed(3, 'u1')).toEqual({ trusted: true, seed: 11 });
    releaseB();
    expect(trustedDayBoardSeed(3, 'u1').trusted).toBe(false);
    // A recording with no live watch is ignored.
    recordDayBoardSeedSnapshot(3, 'u1', snap(false, false, { seed: 11 }));
    expect(trustedDayBoardSeed(3, 'u1').trusted).toBe(false);
  });

  it('records a server-confirmed ABSENT board (or seedless board) as seed undefined', () => {
    beginDayBoardSeedWatch(4, 'u1');
    recordDayBoardSeedSnapshot(4, 'u1', snap(false, false, null));
    expect(trustedDayBoardSeed(4, 'u1')).toEqual({ trusted: true, seed: undefined });
    recordDayBoardSeedSnapshot(4, 'u1', snap(false, false, {}));
    expect(trustedDayBoardSeed(4, 'u1')).toEqual({ trusted: true, seed: undefined });
  });

  it('ignores snapshots with missing metadata (fail closed on test doubles)', () => {
    beginDayBoardSeedWatch(5, 'u1');
    recordDayBoardSeedSnapshot(5, 'u1', {
      exists: () => true,
      data: () => ({ seed: 1 }),
    } as unknown as Parameters<typeof recordScopedSnapshot>[3]);
    expect(trustedDayBoardSeed(5, 'u1').trusted).toBe(false);
  });

  it('keys per (dayIndex, uid) — one board never launders another', () => {
    beginDayBoardSeedWatch(6, 'u1');
    recordDayBoardSeedSnapshot(6, 'u1', snap(false, false, { seed: 42 }));
    expect(trustedDayBoardSeed(6, 'u2').trusted).toBe(false);
    expect(trustedDayBoardSeed(7, 'u1').trusted).toBe(false);
  });

  it('keys per Event — the same uid and Day never inherit another Event\'s trust', () => {
    beginScopedWatch('event-a', 6, 'u1');
    recordScopedSnapshot('event-a', 6, 'u1', snap(false, false, { seed: 42 }));
    expect(trustedScopedSeed('event-b', 6, 'u1').trusted).toBe(false);
    expect(trustedScopedSeed('event-a', 6, 'u1')).toEqual({ trusted: true, seed: 42 });
  });
});
