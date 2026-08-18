import { describe, expect, it, vi } from 'vitest';
import { BugReportInputError, nextRateState, validateBugReportInput } from '../../functions/src/bugReportCore';
import { reporterBelongsToEvent, type ReporterLookupFirestore } from '../../functions/src/bugReports';
import contract from '../../functions/src/bugReportContract.cjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const valid = () => ({
  schemaVersion: 1,
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
    expect(report.description).toBe('The board stopped responding.');
    expect(report.screenshot?.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
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

describe('reporterBelongsToEvent (#670 — the abuse escalation gate)', () => {
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

  it('accepts a player of the Event they named', async () => {
    const db = lookup({ 'events/med-2026/players/u1': { displayName: 'Ada' } });
    expect(await reporterBelongsToEvent(db, 'med-2026', 'u1')).toBe(true);
  });

  it('accepts an Event ADMIN who never dealt a board', async () => {
    // An organizer who sets the Event up without playing has no player document
    // and is plainly authorized — the roster is the second chance, and only the
    // second, because it costs a whole Event read the common case should not pay.
    const db = lookup({ 'events/med-2026': { admins: ['u1', 'u2'] } });
    expect(await reporterBelongsToEvent(db, 'med-2026', 'u1')).toBe(true);
  });

  it('rejects a stranger naming somebody else’s Event', async () => {
    const db = lookup({ 'events/med-2026': { admins: ['someone-else'] } });
    expect(await reporterBelongsToEvent(db, 'med-2026', 'u1')).toBe(false);
    expect(await reporterBelongsToEvent(lookup({}), 'med-2026', 'u1')).toBe(false);
    // A non-array or absent roster is not a membership claim.
    expect(await reporterBelongsToEvent(lookup({ 'events/med-2026': { admins: 'u1' } }), 'med-2026', 'u1')).toBe(false);
    expect(await reporterBelongsToEvent(lookup({ 'events/med-2026': {} }), 'med-2026', 'u1')).toBe(false);
  });

  it('FAILS CLOSED when the lookup itself breaks', async () => {
    // The wrong direction here is mailing an Event's admins on the say-so of
    // somebody with no relationship to it, so an unreadable answer is not
    // membership.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = lookup({ 'events/med-2026': { admins: ['u1'] } }, ['events/med-2026/players/u1']);
    expect(await reporterBelongsToEvent(db, 'med-2026', 'u1')).toBe(false);
    spy.mockRestore();
  });
});
