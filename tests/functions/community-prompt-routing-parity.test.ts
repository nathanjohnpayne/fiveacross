import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  isDayTargetable as fnsIsDayTargetable,
  targetableDays as fnsTargetableDays,
  defaultTargetDayIndex as fnsDefaultTargetDayIndex,
  routeApprovalToDay as fnsRouteApprovalToDay,
  isUsableTarget as fnsIsUsableTarget,
  type TargetableDay,
} from '../../functions/src/communityPromptRouting.generated';
import {
  isDayTargetable as clientIsDayTargetable,
  targetableDays as clientTargetableDays,
  defaultTargetDayIndex as clientDefaultTargetDayIndex,
  routeApprovalToDay as clientRouteApprovalToDay,
  isUsableTarget as clientIsUsableTarget,
} from '../../src/data/communityPrompts';

// Parity guard for the client/functions Community Prompt routing (#1275,
// specs/community-prompt-targeting.md; cf. the event-membership generator).
//
// `src/data/communityPrompts.ts` holds the ONE implementation: it decides the
// Day a SUBMISSION defaults to and what a submitter is told ("scheduled" vs
// "approved"). `functions/src/communityPromptRouting.generated.ts` is a
// byte-for-byte copy of its marked block, materialized by
// `scripts/materialize-community-prompt-routing-functions.mjs`, and it decides
// where the `approvePrompts` callable ROUTES that submission on the server
// clock. The first test pins the copy as current. The rest feed identical
// fixtures to both and require identical answers, because the one thing the
// copy does not share is `normalizePool` (`src/game/pool.ts` on the client,
// `functions/src/poolVocab.ts` in Functions). If they ever disagreed, a Player
// could be promised a Day the callable then rolls past.

const NOW = 1_000_000;

// Every axis the predicate reads, crossed: stamp state (absent / [] / a list),
// unlock relative to `now` (before / equal / after, plus the 0 sentinel), and
// pool (absent, canonical, legacy, closing, garbage).
const STAMPS: Array<string[] | undefined> = [undefined, [], ['x']];
const UNLOCKS = [NOW - 1, NOW, NOW + 1, 0];
const POOLS: Array<string | undefined> = [
  undefined,
  'main',
  'easy',
  'embark',
  'closing',
  'farewell',
  'garbage',
];

function dayFixtures(): TargetableDay[] {
  const out: TargetableDay[] = [];
  let index = 0;
  for (const snapshotItemIds of STAMPS) {
    for (const unlockAt of UNLOCKS) {
      for (const pool of POOLS) {
        out.push({
          index: index++,
          unlockAt,
          ...(pool === undefined ? {} : { pool }),
          ...(snapshotItemIds === undefined ? {} : { snapshotItemIds }),
        });
      }
    }
  }
  return out;
}

/** Schedules that exercise ordering: the intended Day exact, rolled forward,
 *  all passed, an earlier-open-only schedule, and a mis-ordered array. */
function schedules(): Array<{ label: string; days: TargetableDay[] }> {
  const open = (index: number, over: Partial<TargetableDay> = {}): TargetableDay => ({
    index,
    unlockAt: NOW + (index + 1) * 3_600_000,
    ...over,
  });
  const closed = (index: number): TargetableDay => ({
    index,
    unlockAt: NOW - 3_600_000,
    snapshotItemIds: [],
  });
  return [
    { label: 'empty', days: [] },
    { label: 'exact', days: [closed(0), closed(1), open(2), open(3)] },
    { label: 'rolled forward', days: [closed(0), closed(1), closed(2), open(3), open(4)] },
    { label: 'all passed', days: [closed(0), closed(1), closed(2)] },
    { label: 'earlier open only', days: [open(0), open(1), closed(2), closed(3)] },
    { label: 'mis-ordered', days: [open(4), open(2), closed(1), open(3)] },
    { label: 'curated after', days: [closed(1), open(2, { pool: 'embark' }), open(3, { pool: 'farewell' })] },
    { label: 'due but unstamped', days: [{ index: 1, unlockAt: NOW - 1 }, open(2)] },
    { label: 'cross product', days: dayFixtures() },
  ];
}

const INTENDED = [0, 1, 2, 3, 4, 9, -1];

describe('client/functions parity — Community Prompt routing (#1275)', () => {
  it('the Functions copy is byte-current with the marked source block', () => {
    expect(() => execFileSync(
      process.execPath,
      [path.join(process.cwd(), 'scripts/materialize-community-prompt-routing-functions.mjs'), '--check'],
      { cwd: process.cwd(), stdio: 'pipe' },
    )).not.toThrow();
  });

  it('isDayTargetable agrees on every Day in the cross product, at every clock', () => {
    for (const day of dayFixtures()) {
      for (const now of [NOW - 1, NOW, NOW + 1]) {
        expect(fnsIsDayTargetable(day, now)).toBe(clientIsDayTargetable(day, now));
      }
    }
  });

  it('targetableDays and defaultTargetDayIndex agree on every schedule', () => {
    for (const { days } of schedules()) {
      expect(fnsTargetableDays(days, NOW)).toEqual(clientTargetableDays(days, NOW));
      expect(fnsDefaultTargetDayIndex(days, NOW)).toBe(clientDefaultTargetDayIndex(days, NOW));
    }
  });

  it('routeApprovalToDay agrees for every intended Day on every schedule', () => {
    for (const { days } of schedules()) {
      for (const intended of INTENDED) {
        expect(fnsRouteApprovalToDay(days, intended, NOW)).toBe(
          clientRouteApprovalToDay(days, intended, NOW),
        );
      }
    }
  });

  it('isUsableTarget agrees on every shape', () => {
    for (const value of [0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '2', {}]) {
      expect(fnsIsUsableTarget(value)).toBe(clientIsUsableTarget(value));
    }
  });

  // The pins below are the ANSWERS both sides give, so a change that moves both
  // copies together in the wrong direction still fails here rather than passing
  // as "still in agreement".
  it('both sides read the 0 sentinel and an empty stamp as closed, and a due-but-unstamped Day as closed', () => {
    expect(fnsIsDayTargetable({ index: 0, unlockAt: 0 }, NOW)).toBe(false);
    expect(fnsIsDayTargetable({ index: 1, unlockAt: NOW + 1, snapshotItemIds: [] }, NOW)).toBe(false);
    expect(fnsIsDayTargetable({ index: 1, unlockAt: NOW - 1 }, NOW)).toBe(false);
    expect(fnsIsDayTargetable({ index: 1, unlockAt: NOW + 1 }, NOW)).toBe(true);
  });

  it('both sides roll strictly forward and retain when nothing later is open', () => {
    const earlierOnly = schedules().find((s) => s.label === 'earlier open only')!.days;
    expect(fnsRouteApprovalToDay(earlierOnly, 2, NOW)).toBeNull();
    const rolled = schedules().find((s) => s.label === 'rolled forward')!.days;
    expect(fnsRouteApprovalToDay(rolled, 2, NOW)).toBe(3);
  });
});
