import { describe, it, expect, expectTypeOf } from 'vitest';
import contract from '../../functions/src/bugReportContract.cjs';
import type { BugReportKind, ValidClientReportFields } from '../../functions/src/bugReportContract.cjs';
import type { ValidBugReport } from '../../functions/src/bugReportCore';

// Contract guard for the bug-report intake, the FUNCTIONS half (#670).
//
// `bugReportContract.cjs` is the one module both sides of the wire read: the
// callable validates against it, `scripts/bug-reports-lib.mjs` re-validates the
// stored document against it before exporting, and the client mirrors its field
// list in `src/data/bugReports.ts`. Three consumers, one source — which only
// stays true if something asserts it.
//
// This file guards the SERVER side of that: `ValidBugReport` (what the callable
// hands `bugReports.ts` to persist) must stay a superset of
// `ValidClientReportFields` (what the shared contract returns), so a field added
// to the contract cannot be silently dropped on the way to Firestore. The client
// half lives in `src/data/w4-bug-report-contract-parity.test.ts`, which runs in
// the root suite where the browser module can be imported.
//
// The type-level assertions cost nothing at runtime and fail at compile time.

describe('the persisted report stays a superset of the shared client contract', () => {
  it('ValidBugReport carries every field ValidClientReportFields defines', () => {
    expectTypeOf<ValidBugReport>().toExtend<ValidClientReportFields>();
  });

  it('the kind field has the SAME type on both sides — no widening at the seam', () => {
    expectTypeOf<ValidClientReportFields['kind']>().toEqualTypeOf<BugReportKind>();
    expectTypeOf<ValidBugReport['kind']>().toEqualTypeOf<BugReportKind>();
  });

  it('the declared kinds and the runtime list are the same list', () => {
    // The `.d.cts` union and the `.cjs` array are two hand-written statements of
    // one fact; a value present in one and missing from the other is the exact
    // drift this test exists to catch.
    expectTypeOf<BugReportKind>().toEqualTypeOf<'bug' | 'abuse'>();
    expect([...contract.REPORT_KINDS]).toEqual(['bug', 'abuse']);
  });

  it('every declared kind survives normalisation unchanged', () => {
    // A kind the contract declares but does not accept would validate as `bug`
    // and silently lose an escalation.
    for (const kind of contract.REPORT_KINDS) {
      expect(contract.normalizeReportKind(kind)).toBe(kind);
    }
  });
});
