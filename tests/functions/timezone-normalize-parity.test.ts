import { describe, it, expect } from 'vitest';
import { normalizeTimezone as fnsNormalizeTimezone, DEFAULT_TIMEZONE as fnsDefaultTimezone } from '../../functions/src/finaleContent';
import { normalizeTimezone as clientNormalizeTimezone } from '../../src/data/converters';

// Parity guard for the client/functions timezone-normalization mirror (#800
// Codex P2, ADR 0011, cf. finale-parity.test.ts / lastcall-copy-parity.test.ts).
//
// `src/data/converters.ts`'s `normalizeTimezone` is the app's canonical
// contract for resolving a persisted `EventDoc.timezone` value — the client
// ALWAYS reads Events through `eventConverter`, which calls it.
// `functions/src/finaleContent.ts` restates the same rule because
// `runFinaleBeats` (`functions/src/unlockDay.ts`) reads the raw Firestore doc
// directly, bypassing the converter, and the two packages are deliberately
// decoupled (ADR 0011). If the two ever disagree on what a malformed
// `timezone` resolves to, the last-call freeze phrase (#800) could once again
// quote a different time than what the client would compute for the SAME
// Event doc — the exact bug class this ticket exists to close, just one layer
// down. This feeds identical fixtures to both and asserts byte-identical
// output.

const FIXTURES: unknown[] = [
  'America/Los_Angeles',
  'Europe/Rome',
  'Pacific/Auckland',
  undefined,
  null,
  '',
  '   ',
  42,
  '+02:00',
  'Etc/GMT+5',
  'UTC',
  'GMT',
  'EST',
  'Mars/Olympus',
  'Not/A_Zone',
];

describe('client/functions parity — timezone normalization (#800)', () => {
  it('agrees on every fixture', () => {
    for (const raw of FIXTURES) {
      expect(fnsNormalizeTimezone(raw)).toBe(clientNormalizeTimezone(raw));
    }
  });

  it("both sides' default is 'Europe/Rome'", () => {
    expect(fnsDefaultTimezone).toBe('Europe/Rome');
    expect(clientNormalizeTimezone(undefined)).toBe('Europe/Rome');
  });
});
