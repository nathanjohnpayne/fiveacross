// `src/data/draftLastCall.ts` mirrors the Functions finale clock for a wizard
// DRAFT so Look (#792) and the Launch checklist (#794) can state the "last
// call" instant before any Event exists. The browser cannot import
// `functions/src/unlockDay.ts` at runtime (decoupled packages — the same posture
// `src/event-invitation-parity.test.ts` documents), so the mirror re-expresses
// the derivation locally and THIS test is what stops it drifting: it imports the
// real `finaleTimes` and `LAST_CALL_LEAD_MS`, feeds both the same Days, and
// requires identical instants. Change the lead, the forward/backward choice or
// the freeze resolution in Functions alone and this file fails.
//
// `unlockDay.ts` imports only pure modules (`finaleContent`, `poolVocab`,
// `eventMembership.generated`, `firestoreIds`), so unlike the invitation
// parity test it needs neither a Firebase mock nor `functions/node_modules`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finaleTimes, LAST_CALL_LEAD_MS, type DayLike } from '../functions/src/unlockDay';
import { LAST_CALL_LEAD_MS as CLIENT_LAST_CALL_LEAD_MS, draftLastCall } from './data/draftLastCall';
import type { DraftDayDef } from './types';

const HOUR = 60 * 60 * 1000;
// 2026-11-06 08:00 UTC — an arbitrary Friday-morning anchor; only differences
// between instants matter, nothing here assumes a zone.
const FRI_8 = Date.UTC(2026, 10, 6, 8, 0, 0);

function day(index: number, unlockAt: number | null, pool: DraftDayDef['pool'] = 'main'): DraftDayDef {
  return {
    index,
    date: '2026-11-06',
    unlockAt,
    place: `Place ${index}`,
    placeEmoji: '📍',
    theme: null,
    pool,
    tutorial: false,
    tonight: ['a', 'b'],
  };
}

/** The Functions view of the same Days: the two fields `finaleTimes` reads. */
function asFunctionsDays(days: readonly DraftDayDef[]): DayLike[] {
  return days.map((d) => ({ index: d.index, unlockAt: d.unlockAt as number, pool: d.pool }));
}

interface Fixture {
  name: string;
  days: DraftDayDef[];
  configuredFreeze?: number;
  /** Which branch the Functions derivation takes for this fixture. */
  branch: 'forward' | 'backward';
}

const FIXTURES: Fixture[] = [
  {
    name: 'the original ten-Day shape: closing Day on its own date, 08:00 → 08:00',
    days: [
      day(0, FRI_8 + 0 * 24 * HOUR, 'easy'),
      day(1, FRI_8 + 1 * 24 * HOUR),
      day(2, FRI_8 + 2 * 24 * HOUR),
      day(3, FRI_8 + 3 * 24 * HOUR, 'closing'),
    ],
    branch: 'forward',
  },
  {
    name: 'a Bodega-style tail: the competitive Day and the closing Day share one date (#784)',
    days: [
      day(0, FRI_8, 'easy'),
      day(1, FRI_8 + 24 * HOUR),
      // Same calendar date as Day 1, a few hours later: 08:00 + 12h lands past
      // the freeze, so the forward candidate must be rejected.
      day(2, FRI_8 + 24 * HOUR + 6 * HOUR, 'closing'),
    ],
    branch: 'backward',
  },
  {
    name: 'a closing Day exactly 12h after its predecessor (forward == freeze is NOT before it)',
    days: [day(0, FRI_8), day(1, FRI_8 + 12 * HOUR, 'closing')],
    branch: 'backward',
  },
  {
    name: 'a closing Day one millisecond past the 12h lead (the forward branch just fits)',
    days: [day(0, FRI_8), day(1, FRI_8 + 12 * HOUR + 1, 'closing')],
    branch: 'forward',
  },
  {
    name: 'a closing Day on its own date a full day later',
    days: [day(0, FRI_8), day(1, FRI_8 + 24 * HOUR, 'closing')],
    branch: 'forward',
  },
  {
    name: 'a one-Day schedule whose only Day is the closing Day',
    days: [day(0, FRI_8, 'closing')],
    branch: 'backward',
  },
  {
    name: 'a legacy farewell spelling of the closing pool',
    days: [day(0, FRI_8), day(1, FRI_8 + 24 * HOUR, 'farewell' as DraftDayDef['pool'])],
    branch: 'forward',
  },
  {
    name: 'days stored out of index order (the server reads the array as stored)',
    days: [
      day(2, FRI_8 + 48 * HOUR, 'closing'),
      day(0, FRI_8),
      day(1, FRI_8 + 24 * HOUR),
    ],
    branch: 'forward',
  },
  {
    name: 'a configured freeze after every Day, with no closing Day at all',
    days: [day(0, FRI_8), day(1, FRI_8 + 24 * HOUR)],
    configuredFreeze: FRI_8 + 36 * HOUR,
    branch: 'forward',
  },
  {
    name: 'closely spaced Days under a configured freeze (the preceding unlock + 12h overshoots it)',
    days: [day(0, FRI_8), day(1, FRI_8 + 3 * HOUR)],
    configuredFreeze: FRI_8 + 6 * HOUR,
    branch: 'backward',
  },
  {
    name: 'a configured freeze between two Days (podium Day is the earlier one)',
    days: [day(0, FRI_8), day(1, FRI_8 + 24 * HOUR), day(2, FRI_8 + 48 * HOUR)],
    configuredFreeze: FRI_8 + 30 * HOUR,
    branch: 'forward',
  },
  {
    // The issue (#1378) names this as "the only way to reach fires:false". It is
    // not: the backward branch is `freeze - 12h`, which is strictly before any
    // usable freeze, so the window is non-empty. What this shape DOES exercise
    // is the forward candidate landing past the freeze and being rejected.
    name: 'a configured freeze earlier than the preceding Day’s unlock',
    days: [day(0, FRI_8), day(1, FRI_8 + 24 * HOUR), day(2, FRI_8 + 48 * HOUR)],
    configuredFreeze: FRI_8 + 24 * HOUR - HOUR,
    branch: 'backward',
  },
  {
    name: 'a configured freeze before EVERY Day opens (podium falls back to the lowest index)',
    days: [day(1, FRI_8 + 24 * HOUR), day(2, FRI_8 + 48 * HOUR)],
    configuredFreeze: FRI_8,
    branch: 'backward',
  },
  {
    name: 'a configured freeze that overrides a ceremonial Day',
    days: [day(0, FRI_8), day(1, FRI_8 + 24 * HOUR, 'closing'), day(2, FRI_8 + 48 * HOUR)],
    configuredFreeze: FRI_8 + 72 * HOUR,
    branch: 'forward',
  },
  {
    name: 'an unusable configured freeze (0, the open sentinel) is ignored in favour of the derived one',
    days: [day(0, FRI_8), day(1, FRI_8 + 24 * HOUR, 'closing')],
    configuredFreeze: 0,
    branch: 'forward',
  },
  {
    name: 'an unusable configured freeze (negative) is ignored in favour of the derived one',
    days: [day(0, FRI_8), day(1, FRI_8 + 24 * HOUR, 'closing')],
    configuredFreeze: -5,
    branch: 'forward',
  },
  {
    name: 'a ceremonial Day carrying the 0 open sentinel schedules no freeze',
    days: [day(0, FRI_8), day(1, 0, 'closing')],
    branch: 'forward', // unused: both sides return null
  },
];

const NO_FINALE: Array<{ name: string; days: DraftDayDef[]; configuredFreeze?: number }> = [
  { name: 'no closing Day and no configured freeze', days: [day(0, FRI_8), day(1, FRI_8 + 24 * HOUR)] },
  { name: 'an empty schedule', days: [] },
  { name: 'an empty schedule with a configured freeze', days: [], configuredFreeze: FRI_8 },
];

describe('draftLastCall ↔ functions finaleTimes parity (#1378)', () => {
  beforeEach(() => {
    // `finaleTimes` logs loudly on an empty window; keep the suite output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shares the Functions last-call lead (12h)', () => {
    expect(CLIENT_LAST_CALL_LEAD_MS).toBe(LAST_CALL_LEAD_MS);
    expect(LAST_CALL_LEAD_MS).toBe(12 * HOUR);
  });

  describe.each(FIXTURES)('$name', ({ days, configuredFreeze, branch }) => {
    it('resolves the same lastCallAt and standingsFreezeAt as finaleTimes', () => {
      const server = finaleTimes(asFunctionsDays(days), configuredFreeze);
      const mirror = draftLastCall(days, configuredFreeze);
      if (server === null) {
        expect(mirror).toBeNull();
        return;
      }
      expect(mirror).not.toBeNull();
      expect(mirror?.lastCallAt).toBe(server.lastCallAt);
      expect(mirror?.standingsFreezeAt).toBe(server.standingsFreezeAt);
      expect(mirror?.branch).toBe(branch);
      expect(mirror?.fires).toBe(server.lastCallAt < server.standingsFreezeAt);
    });
  });

  it.each(NO_FINALE)('returns null where finaleTimes does: $name', ({ days, configuredFreeze }) => {
    expect(finaleTimes(asFunctionsDays(days), configuredFreeze)).toBeNull();
    expect(draftLastCall(days, configuredFreeze)).toBeNull();
  });

  it('reports an empty window as fires:false with the instant the scheduler computes, uncorrected', () => {
    // `Number.MAX_VALUE` is finite and positive, so BOTH sides accept it as a
    // configured freeze — and `MAX_VALUE - 12h === MAX_VALUE` in doubles, so the
    // backward branch yields lastCallAt === standingsFreezeAt. Absurd as a
    // schedule, but it is the one input where the scheduler's own #784 guard
    // trips, which makes it the honest fixture for "fires is exactly the guard".
    // One Day only: with a preceding Day the forward branch would win instead.
    const days = [day(0, FRI_8)];
    const server = finaleTimes(asFunctionsDays(days), Number.MAX_VALUE);
    const mirror = draftLastCall(days, Number.MAX_VALUE);
    expect(server).not.toBeNull();
    expect(server && server.lastCallAt < server.standingsFreezeAt).toBe(false);
    expect(console.error).toHaveBeenCalled();
    expect(mirror).not.toBeNull();
    expect(mirror?.fires).toBe(false);
    expect(mirror?.lastCallAt).toBe(server?.lastCallAt);
    expect(mirror?.standingsFreezeAt).toBe(server?.standingsFreezeAt);
  });

  it('is pinned over a generated sweep of two-Day gaps around the 12h lead', () => {
    // Boundary sweep: the forward/backward switch happens exactly where the gap
    // between the preceding unlock and the freeze crosses LAST_CALL_LEAD_MS.
    for (let offset = -3; offset <= 3; offset++) {
      const gap = LAST_CALL_LEAD_MS + offset;
      const days = [day(0, FRI_8), day(1, FRI_8 + gap, 'closing')];
      const server = finaleTimes(asFunctionsDays(days));
      const mirror = draftLastCall(days);
      expect(mirror?.lastCallAt, `gap ${gap}`).toBe(server?.lastCallAt);
      expect(mirror?.standingsFreezeAt, `gap ${gap}`).toBe(server?.standingsFreezeAt);
    }
  });
});
