import { describe, expect, it, vi } from 'vitest';
import { BugReportInputError, nextRateState, validateBugReportInput } from '../../functions/src/bugReportCore';
import {
  ESCALATION_LOOKUP_ATTEMPTS,
  resolveAbuseEscalation,
  type ReporterLookupFirestore,
} from '../../functions/src/bugReports';
import contract from '../../functions/src/bugReportContract.cjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const valid = () => ({
  schemaVersion: 1,
  submissionId: 'submit_12345678',
  kind: 'bug',
  description: 'The board stopped responding.',
  screenshotDataUrl: png,
  captureError: null,
  route: '/leaderboard?view=all',
  eventId: 'med-2026',
  appVersion: 'abc123',
  browser: 'Test Browser',
  viewport: { width: 390, height: 844 },
  online: true,
});

describe('bug-report server validation', () => {
  it('accepts bounded diagnostics and a real PNG signature', () => {
    const report = validateBugReportInput(valid());
    expect(report.submissionId).toBe('submit_12345678');
    expect(report.description).toBe('The board stopped responding.');
    expect(report.screenshot?.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('rejects a malformed present submission identity but preserves an absent legacy identity', () => {
    for (const submissionId of ['', 'short', 'contains spaces', 'x'.repeat(65), 42, null]) {
      expect(() => validateBugReportInput({ ...valid(), submissionId })).toThrow(BugReportInputError);
    }
    const legacy = valid() as Record<string, unknown>;
    delete legacy.submissionId;
    expect(validateBugReportInput(legacy).submissionId).toBeNull();
  });

  it('accepts a text-only fallback with a bounded capture error', () => {
    const report = validateBugReportInput({ ...valid(), screenshotDataUrl: null, captureError: 'Canvas unavailable' });
    expect(report.screenshot).toBeNull();
    expect(report.captureError).toBe('Canvas unavailable');
  });

  it('rejects spoofed image content and non-app routes', () => {
    expect(() => validateBugReportInput({ ...valid(), screenshotDataUrl: 'data:image/png;base64,YWJj' })).toThrow(BugReportInputError);
    expect(() => validateBugReportInput({ ...valid(), route: 'https://attacker.example' })).toThrow('Route must be app-relative');
  });

  it('rejects a structurally valid PNG container with no image data', () => {
    const complete = Buffer.from(png.split(',')[1], 'base64');
    const ihdrLength = 25;
    const noImageData = Buffer.concat([
      complete.subarray(0, 8 + ihdrLength),
      complete.subarray(complete.length - 12),
    ]);
    expect(() => contract.validatePngBytes(noImageData)).toThrow('incomplete');
  });

  it('carries the reporter’s abuse marking through to the persisted report (#670)', () => {
    expect(validateBugReportInput({ ...valid(), kind: 'abuse' }).kind).toBe('abuse');
    expect(validateBugReportInput(valid()).kind).toBe('bug');
  });

  it('accepts an ABSENT kind as a plain bug, so already-shipped clients keep working', () => {
    // THE BACK-COMPAT GUARANTEE, stated as a test rather than as a comment. Every
    // client in the wild sends no `kind` at all, and an installed PWA holding a
    // stale precached bundle can be weeks behind a deploy — rejecting the field's
    // absence would break bug reporting for exactly those players.
    const legacy = valid() as Record<string, unknown>;
    delete legacy.kind;
    const report = validateBugReportInput(legacy);
    expect(report.kind).toBe('bug');
    // Nothing else about the legacy payload changes shape.
    expect(report.description).toBe('The board stopped responding.');
    expect(report.route).toBe('/leaderboard?view=all');
  });

  it('normalises an UNKNOWN kind down to a bug rather than rejecting the report', () => {
    // The value comes from a client the server cannot force to upgrade, so a
    // future third kind must not start failing submissions against a server that
    // has not shipped yet. Degrading keeps the report; rejecting loses it. The
    // direction is safe because `abuse` is the only value that DOES anything —
    // normalisation can decline an escalation, never invent one.
    for (const kind of ['ABUSE', 'abuse ', 'harassment', '', 42, null, {}, ['abuse']]) {
      expect(validateBugReportInput({ ...valid(), kind }).kind).toBe('bug');
    }
    expect(contract.normalizeReportKind(undefined)).toBe('bug');
    expect(contract.REPORT_KINDS).toEqual(['bug', 'abuse']);
  });

  it('allows only three reports in every rolling 15-minute window, including across the boundary', () => {
    const first = nextRateState(undefined, 1_000);
    const second = nextRateState(first, 2_000);
    const third = nextRateState(second, 3_000);
    expect(third.submissionMs).toEqual([1_000, 2_000, 3_000]);
    expect(() => nextRateState(third, 4_000)).toThrow(BugReportInputError);
    const atBoundary = nextRateState(third, 1_000 + 15 * 60 * 1000);
    expect(atBoundary.submissionMs).toEqual([2_000, 3_000, 901_000]);
    expect(() => nextRateState(atBoundary, 901_001)).toThrow(BugReportInputError);
  });
});

describe('resolveAbuseEscalation (#670 — the abuse escalation gate)', () => {
  // `eventId` rides in on the client payload, and once an abuse report mails the
  // named Event's admins that field is a delivery address rather than a label.
  // These are the only answers that may open it.
  const lookup = (
    docs: Record<string, Record<string, unknown> | undefined>,
    throwOn: readonly string[] = [],
  ): ReporterLookupFirestore => ({
    doc: (path: string) => ({
      get: async () => {
        if (throwOn.includes(path)) throw new Error(`backend unavailable: ${path}`);
        const data = docs[path];
        return { exists: data !== undefined, data: () => data };
      },
    }),
  });

  const ACTIVE = { status: 'active' };

  it('accepts a player of the Event they named', async () => {
    const db = lookup({ 'events/med-2026': ACTIVE, 'events/med-2026/players/u1': { displayName: 'Ada' } });
    expect(await resolveAbuseEscalation(db, 'med-2026', 'u1')).toEqual({ member: true, eventActive: true });
  });

  it('accepts an Event ADMIN who never dealt a board', async () => {
    // An organizer who sets the Event up without playing has no player document
    // and is plainly authorized, so the roster answers first — and saves the
    // second read when it does.
    const db = lookup({ 'events/med-2026': { ...ACTIVE, admins: ['u1', 'u2'] } });
    expect(await resolveAbuseEscalation(db, 'med-2026', 'u1')).toEqual({ member: true, eventActive: true });
  });

  it('rejects a stranger naming somebody else’s Event', async () => {
    const strangers = [
      { 'events/med-2026': { ...ACTIVE, admins: ['someone-else'] } },
      {},
      // A non-array or absent roster is not a membership claim.
      { 'events/med-2026': { ...ACTIVE, admins: 'u1' } },
      { 'events/med-2026': ACTIVE },
    ];
    for (const docs of strangers) {
      expect((await resolveAbuseEscalation(lookup(docs), 'med-2026', 'u1')).member).toBe(false);
    }
  });

  it('reports a NON-ACTIVE Event as unescalatable even for a genuine member', async () => {
    // `recordBugReportAlerts` refuses to enqueue against a non-active Event, so
    // membership alone would have the sheet telling a member an admin was
    // alerted when nobody was — the exact failure the receipt exists to prevent.
    for (const event of [{ status: 'archived' }, { status: 'draft' }, { name: 'no status at all' }]) {
      const db = lookup({ 'events/med-2026': event, 'events/med-2026/players/u1': { displayName: 'Ada' } });
      expect(await resolveAbuseEscalation(db, 'med-2026', 'u1')).toEqual({ member: true, eventActive: false });
    }
  });

  it('does not believe the FIRST failure — a transient blip must not look like non-membership', async () => {
    // A backend failure is recorded as `reporterInEvent: false`, which the
    // trigger cannot tell from a confirmed non-member, so it suppresses the
    // escalation for good. Retrying is the cheapest defence against a blip
    // costing somebody their abuse escalation (Phase 4b P2).
    let calls = 0;
    const flaky: ReporterLookupFirestore = {
      doc: (path: string) => ({
        get: async () => {
          if (path === 'events/med-2026') {
            calls += 1;
            if (calls < ESCALATION_LOOKUP_ATTEMPTS) throw new Error('backend unavailable');
            return { exists: true, data: () => ACTIVE };
          }
          return { exists: true, data: () => ({ displayName: 'Ada' }) };
        },
      }),
    };
    expect(await resolveAbuseEscalation(flaky, 'med-2026', 'u1')).toEqual({ member: true, eventActive: true });
    expect(calls).toBe(ESCALATION_LOOKUP_ATTEMPTS);
    expect(ESCALATION_LOOKUP_ATTEMPTS).toBeGreaterThan(1);
  });

  it('answers UNKNOWN, not "no", when the lookup cannot be completed', async () => {
    // The wrong directions here are mailing an Event's admins on the say-so of
    // somebody with no relationship to it, and claiming a delivery that did not
    // happen — so an unreadable answer is neither membership nor activeness.
    // `null`, not `false`. Recording a backend failure as a confirmed non-member
    // made an infrastructure problem indistinguishable from an authorization
    // decision, and unrecoverable — nothing downstream could tell the question
    // had never been answered (Phase 4b P2). The caller writes no
    // `reporterInEvent` at all in this case, so the trigger still fails closed
    // without anything false being recorded.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = lookup({ 'events/med-2026': { ...ACTIVE, admins: ['u1'] } }, ['events/med-2026']);
    expect(await resolveAbuseEscalation(db, 'med-2026', 'u1')).toEqual({ member: null, eventActive: null });
    // A confirmed non-member is a DIFFERENT answer, and stays `false`.
    const known = lookup({ 'events/med-2026': ACTIVE });
    expect(await resolveAbuseEscalation(known, 'med-2026', 'u1')).toEqual({ member: false, eventActive: true });
    spy.mockRestore();
  });

  it('does not echo a raw reporter uid when the immediate lookup fails', async () => {
    const db = lookup(
      { 'events/med-2026': ACTIVE },
      ['events/med-2026/players/private-user-123'],
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(resolveAbuseEscalation(db, 'med-2026', 'private-user-123', 1)).resolves.toEqual({
      member: null,
      eventActive: null,
    });
    expect(spy.mock.calls.flat().map(String).join(' ')).not.toContain('private-user-123');
    spy.mockRestore();
  });
});
