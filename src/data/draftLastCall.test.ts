import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAST_CALL_LEAD_MS, draftLastCall } from './draftLastCall';
import type { DraftDayDef } from '../types';

// Parity with the real `finaleTimes` lives in `src/draft-last-call-parity.test.ts`.
// This file covers what only the DRAFT mirror has to decide: holes, unset
// unlocks, and that it reports without correcting or mutating.
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 6, 8, 0, 0);

function day(index: number, unlockAt: number | null, pool: DraftDayDef['pool'] = 'main'): DraftDayDef {
  return {
    index,
    date: '2026-11-06',
    unlockAt,
    place: 'Somewhere',
    placeEmoji: '📍',
    theme: null,
    pool,
    tutorial: false,
    tonight: ['a', 'b'],
  };
}

describe('draftLastCall', () => {
  it('prefers the preceding Day’s unlock + 12h when the closing Day is on its own date', () => {
    const r = draftLastCall([day(0, T0), day(1, T0 + 24 * HOUR, 'closing')]);
    expect(r).toEqual({
      lastCallAt: T0 + LAST_CALL_LEAD_MS,
      standingsFreezeAt: T0 + 24 * HOUR,
      branch: 'forward',
      fires: true,
    });
  });

  it('falls back to freeze − 12h when the forward candidate would reach the freeze', () => {
    const r = draftLastCall([day(0, T0), day(1, T0 + 6 * HOUR, 'closing')]);
    expect(r?.branch).toBe('backward');
    expect(r?.lastCallAt).toBe(T0 + 6 * HOUR - LAST_CALL_LEAD_MS);
    expect(r?.fires).toBe(true);
  });

  it('is null when no Day is ceremonial and no freeze is configured', () => {
    expect(draftLastCall([day(0, T0), day(1, T0 + 24 * HOUR)])).toBeNull();
    expect(draftLastCall([])).toBeNull();
  });

  it('is null while any Day’s unlock is unset, rather than computing over a Day that is not there', () => {
    expect(draftLastCall([day(0, null), day(1, T0 + 24 * HOUR, 'closing')])).toBeNull();
    expect(draftLastCall([day(0, T0), day(1, null, 'closing')])).toBeNull();
    expect(draftLastCall([day(0, Number.NaN), day(1, T0 + 24 * HOUR, 'closing')])).toBeNull();
  });

  it('skips holes in a sparse Days array instead of throwing', () => {
    const sparse: Array<DraftDayDef | undefined | null> = [day(0, T0), undefined, null, day(1, T0 + 24 * HOUR, 'closing')];
    sparse.length = 6; // trailing holes
    expect(draftLastCall(sparse)?.lastCallAt).toBe(T0 + LAST_CALL_LEAD_MS);
  });

  it('does not reorder or mutate the Days it is given', () => {
    const days = [day(1, T0 + 24 * HOUR, 'closing'), day(0, T0)];
    const before = JSON.stringify(days);
    draftLastCall(days);
    expect(JSON.stringify(days)).toBe(before);
  });

  it('reports an empty window as fires:false and leaves lastCallAt uncorrected', () => {
    // MAX_VALUE − 12h === MAX_VALUE in doubles: the one finite configured freeze
    // that empties the window (see the parity test for the server-side twin).
    const r = draftLastCall([day(0, T0)], Number.MAX_VALUE);
    expect(r).toEqual({
      lastCallAt: Number.MAX_VALUE,
      standingsFreezeAt: Number.MAX_VALUE,
      branch: 'backward',
      fires: false,
    });
  });

  it('imports nothing from functions/ at runtime (parity is pinned in the test, not the bundle)', () => {
    // The bundle cannot prove this: until Look (#792) imports the module it is
    // tree-shaken out of `dist`, so the build is silent either way. Read the
    // source instead. `process.cwd()`, not `import.meta.url` (jsdom's is http://).
    const src = readFileSync(resolve(process.cwd(), 'src/data/draftLastCall.ts'), 'utf8');
    const importPaths = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(importPaths.length).toBeGreaterThan(0);
    for (const path of importPaths) expect(path).not.toMatch(/(^|\/)functions(\/|$)/);
  });
});
