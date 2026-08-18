import { describe, it, expect, vi, beforeEach } from 'vitest';

// ADR 0011 (#551), Codex P1 on PR #841 — the invariant this file exists to pin.
//
// Two changes in that PR interact at exactly one seam:
//
//   1. `migrateDayFields` MATERIALIZES a resolved `scoring` on every Day it
//      reads, so a converter-read schedule carries the field even when the
//      stored document does not.
//   2. `firestore.rules` now LOCKS `scoring` on an already-unlocked Day, by
//      presence as well as value — adding the field to a locked Day is a write
//      the rules reject.
//
// Put those together and a schedule editor that round-tripped a CONVERTED
// schedule back to Firestore would brick itself on every legacy Event: reading
// materializes `scoring` on all ten Days, writing back trips the presence check
// on each already-unlocked one, and the future-Day editor stops working
// entirely on the very docs the read-fallback exists to support.
//
// It does not, because `src/data/admin.ts` deliberately re-reads the RAW stored
// `days` inside its transaction (`evt()` attaches no converter) — a posture
// adopted for the #566 `port`/`place` rename, which had the identical hazard.
// That is load-bearing rather than incidental now, and nothing in the type
// system enforces it: attaching a converter to `evt()` would compile, pass every
// other test, and break admin schedule editing on Gay Cruise Bingo in
// production. So it gets a test that reads the actual write payload.

type Ref = { __kind: 'doc'; path: string; withConverter: () => Ref };

const { updateMock, eventDataMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  eventDataMock: vi.fn((): Record<string, unknown> | undefined => undefined),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026', functions: {} }));
vi.mock('firebase/functions', () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  const snap = () => {
    const data = eventDataMock();
    return { exists: () => data !== undefined, data: () => data };
  };
  return {
    ...actual,
    doc: (_db: unknown, ...rest: string[]): Ref => {
      const ref: Ref = { __kind: 'doc', path: rest.join('/'), withConverter: () => ref };
      return ref;
    },
    collection: (_db: unknown, ...rest: string[]) => ({ path: rest.join('/') }),
    runTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: () => Promise.resolve(snap()),
        update: (ref: Ref, data: unknown) => updateMock(ref.path, data),
      }),
  };
});

import { setDayTheme, setDayTonight } from './admin';
import { migrateDayFields } from './converters';
import type { DayDef } from '../types';

const HOUR = 3_600_000;
const NOW = Date.now();

/** The LIVE Gay Cruise Bingo shape: legacy pool spellings, no `scoring` key on
 *  any Day, one already-unlocked Day and one still ahead of its unlock. */
const STORED_LEGACY_DAYS = [
  { index: 0, place: 'Split', placeEmoji: '🇭🇷', theme: 'welcome-aboard', tonight: ['a', 'b'], pool: 'embark', tutorial: true, unlockAt: NOW - HOUR },
  { index: 1, place: 'Valletta', placeEmoji: '🇲🇹', theme: 'get-sporty', tonight: ['c', 'd'], pool: 'main', tutorial: false, unlockAt: NOW + HOUR },
];

/** What the SAME schedule looks like after `eventConverter` — i.e. what the
 *  Admin UI holds and passes in. Every Day has gained `scoring`. */
const convertedDays = (): DayDef[] => STORED_LEGACY_DAYS.map((d) => migrateDayFields(d));

/** The `days` array a write actually carried. */
const writtenDays = (): Array<Record<string, unknown>> => {
  const [, payload] = updateMock.mock.calls.at(-1)!;
  return (payload as { days: Array<Record<string, unknown>> }).days;
};

beforeEach(() => {
  vi.clearAllMocks();
  eventDataMock.mockReturnValue({ days: STORED_LEGACY_DAYS });
});

describe('admin schedule writeback stays RAW (ADR 0011)', () => {
  // The premise check: the converter really does add the field, so the test
  // below is exercising a live hazard rather than a hypothetical one.
  it('the converter DOES materialize scoring the stored doc lacks', () => {
    expect(STORED_LEGACY_DAYS.every((d) => !('scoring' in d))).toBe(true);
    expect(convertedDays().map((d) => d.scoring)).toEqual(['competitive', 'competitive']);
  });

  it('setDayTheme writes back Days with NO scoring key, even when handed converted ones', async () => {
    // The caller passes the CONVERTED schedule — exactly what the Admin console
    // holds — and edits the still-future Day.
    await setDayTheme(convertedDays(), 1, 'neon-pink-playground');

    const days = writtenDays();
    expect(days).toHaveLength(2);
    // Nothing gained `scoring`: the transaction re-read the raw stored days.
    for (const d of days) expect('scoring' in d).toBe(false);
    // …and the edit still landed on the right Day.
    expect(days[1].theme).toBe('neon-pink-playground');
    // The already-unlocked Day is byte-identical to what was stored, which is
    // what the locked-Day rule compares against.
    expect(days[0]).toEqual(STORED_LEGACY_DAYS[0]);
  });

  it('setDayTonight writes back Days with NO scoring key either', async () => {
    await setDayTonight(convertedDays(), 1, ['🎭 Show', '🌌 Party']);

    const days = writtenDays();
    for (const d of days) expect('scoring' in d).toBe(false);
    expect(days[1].tonight).toEqual(['🎭 Show', '🌌 Party']);
    expect(days[0]).toEqual(STORED_LEGACY_DAYS[0]);
  });

  it('preserves a stored scoring value untouched when the doc DOES carry one', async () => {
    // Bodega's shape: the seed writes `scoring` on every Day. A theme edit must
    // neither drop it (the locked-Day presence check) nor rewrite it.
    const stored = STORED_LEGACY_DAYS.map((d, i) => ({
      ...d,
      scoring: i === 0 ? 'ceremonial' : 'competitive',
    }));
    eventDataMock.mockReturnValue({ days: stored });

    await setDayTheme(stored as unknown as DayDef[], 1, 'neon-pink-playground');

    const days = writtenDays();
    expect(days.map((d) => d.scoring)).toEqual(['ceremonial', 'competitive']);
    expect(days[0]).toEqual(stored[0]);
  });
});
