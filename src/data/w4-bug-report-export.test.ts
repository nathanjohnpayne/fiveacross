// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveReport, exportReports, normalizeSubmittedAt, recordDisposition } from '../../scripts/bug-reports-lib.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const COMPLETE_ID = 'a'.repeat(64);
const PENDING_ID = 'b'.repeat(64);
const DELETING_ID = 'c'.repeat(64);
let root: string;

const report = (id = 'report_123') => ({
  id,
  schemaVersion: 1,
  description: 'The board froze.',
  screenshotPath: `bug-reports/0123456789abcdefabcd/${id}/screenshot.png`,
  route: '/',
  submittedAt: '2026-07-09T00:00:00.000Z',
  eventId: 'med-2026',
  appVersion: 'abc123',
  browser: 'Test Browser',
  viewport: { width: 390, height: 844 },
  online: true,
  reporterHash: '0123456789abcdefabcd',
  captureError: null,
  status: 'new',
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'gcb-bugs-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('local bug-report export', () => {
  it('atomically exports a self-contained report and skips it on rerun', async () => {
    const first = await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    expect(first.exported).toEqual(['report_123']);
    expect(await readFile(path.join(root, 'inbox/report_123/description.md'), 'utf8')).toBe('The board froze.\n');
    expect(await readFile(path.join(root, 'inbox/report_123/screenshot.png'))).toEqual(PNG);
    const second = await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    expect(second.skipped).toEqual(['report_123']);
  });

  it('removes partial output when a screenshot is malformed', async () => {
    const summary = await exportReports({ reports: [report()], downloadScreenshot: async () => Buffer.from('bad'), root });
    expect(summary.failed[0].error).toContain('valid PNG');
    await expect(stat(path.join(root, 'inbox/report_123'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects screenshot evidence over the shared 5 MiB limit', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
    PNG.copy(oversized);
    const summary = await exportReports({ reports: [report()], downloadScreenshot: async () => oversized, root });
    expect(summary.failed[0].error).toContain('5 MiB');
    await expect(stat(path.join(root, 'inbox/report_123'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a report missing required diagnostic metadata', async () => {
    const incomplete = report();
    delete (incomplete as Partial<typeof incomplete>).browser;
    const summary = await exportReports({ reports: [incomplete], downloadScreenshot: async () => PNG, root });
    expect(summary.failed[0].error).toContain('Browser');
    await expect(stat(path.join(root, 'inbox/report_123'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the screenshot path to match the report identity exactly', async () => {
    const mismatched = { ...report(), screenshotPath: 'bug-reports/0123456789abcdefabcd/other_report/screenshot.png' };
    const summary = await exportReports({ reports: [mismatched], downloadScreenshot: async () => PNG, root });
    expect(summary.failed[0].error).toContain('Unsafe screenshot path');
  });

  it('exports only the explicit metadata allowlist', async () => {
    const summary = await exportReports({
      reports: [{ ...report(), rawUid: 'secret-user-id', futurePrivateField: 'do-not-export' }],
      downloadScreenshot: async () => PNG,
      root,
    });
    expect(summary.exported).toEqual(['report_123']);
    const metadata = JSON.parse(await readFile(path.join(root, 'inbox/report_123/report.json'), 'utf8'));
    expect(metadata).not.toHaveProperty('rawUid');
    expect(metadata).not.toHaveProperty('futurePrivateField');
  });

  it('accepts a completed idempotent report but omits every coordination field', async () => {
    const complete = {
      ...report(COMPLETE_ID),
      submissionId: 'submit_12345678',
      requestHashVersion: 1,
      requestHash: 'a'.repeat(64),
      intakeState: 'complete',
    };
    const summary = await exportReports({ reports: [complete], downloadScreenshot: async () => PNG, root });
    expect(summary.exported).toEqual([COMPLETE_ID]);
    const metadata = JSON.parse(await readFile(path.join(root, `inbox/${COMPLETE_ID}/report.json`), 'utf8'));
    for (const field of ['submissionId', 'requestHashVersion', 'requestHash', 'intakeState']) {
      expect(metadata).not.toHaveProperty(field);
    }
  });

  it('skips structurally valid pending and deleting coordination rows', async () => {
    const pending = {
      id: PENDING_ID,
      submissionId: 'submit_12345678',
      reporterHash: '0123456789abcdefabcd',
      requestHashVersion: 1,
      requestHash: 'a'.repeat(64),
      intakeState: 'pending',
      intakeStartedAt: '2026-07-09T00:00:00.000Z',
      leaseId: 'lease-123',
      leaseExpiresAt: '2026-07-09T00:01:00.000Z',
    };
    const deleting = {
      ...pending,
      id: DELETING_ID,
      intakeState: 'deleting',
      cleanupLeaseId: 'cleanup-123',
      cleanupLeaseExpiresAt: '2026-07-09T00:10:00.000Z',
    };
    const summary = await exportReports({ reports: [pending, deleting], downloadScreenshot: async () => PNG, root });
    expect(summary.skipped).toEqual([PENDING_ID, DELETING_ID]);
    expect(summary.failed).toEqual([]);
  });

  it('fails closed on unknown or malformed coordination state', async () => {
    for (const malformed of [
      { id: 'pending_123', intakeState: 'pending' },
      { ...report(), intakeState: 'future' },
      {
        id: 'pending_123',
        submissionId: 'submit_12345678',
        reporterHash: '0123456789abcdefabcd',
        requestHashVersion: 1,
        requestHash: 'a'.repeat(64),
        intakeState: 'pending',
        intakeStartedAt: '2026-07-09T00:00:00.000Z',
        leaseId: 'lease-123',
        leaseExpiresAt: '2026-07-09T00:01:00.000Z',
      },
      { ...report(COMPLETE_ID), intakeState: 'complete', requestHashVersion: 99 },
    ]) {
      const summary = await exportReports({ reports: [malformed], downloadScreenshot: async () => PNG, root });
      expect(summary.failed).toHaveLength(1);
    }
  });

  it('carries the abuse marking into the exported metadata, defaulting a pre-#670 report to bug', async () => {
    // The fixture has no `kind` — exactly the shape of every report stored
    // before the field existed. It must export as `bug`, not as a hole the
    // importer has to interpret.
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    const legacy = JSON.parse(await readFile(path.join(root, 'inbox/report_123/report.json'), 'utf8'));
    expect(legacy.kind).toBe('bug');
    await exportReports({
      reports: [{ ...report('report_abuse'), kind: 'abuse', reporterInEvent: true, escalationEligible: true, escalationLookupFailed: false }],
      downloadScreenshot: async () => PNG,
      root,
    });
    const marked = JSON.parse(await readFile(path.join(root, 'inbox/report_abuse/report.json'), 'utf8'));
    expect(marked.kind).toBe('abuse');
  });

  it('fails closed on a stored kind the contract does not recognize', async () => {
    // Unlike intake, which normalizes an unknown value down so a client that
    // cannot be forced to upgrade never loses a report. By the time a document
    // is being EXPORTED it has already been through that normalizer, so a
    // present-but-unrecognized value means a hand-repaired or half-migrated
    // record — and exporting it as `bug` would silently discard triage
    // information the operator is relying on.
    const summary = await exportReports({
      reports: [{ ...report(), kind: 'harassment' }],
      downloadScreenshot: async () => PNG,
      root,
    });
    expect(summary.failed[0].error).toContain('Invalid kind');
    await expect(stat(path.join(root, 'inbox/report_123'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records BOTH escalation conditions, so a suppressed report is not read as delivered', async () => {
    // Membership alone is necessary, not sufficient: the trigger also refuses a
    // non-active Event, so an Event member reporting against an archived Event
    // has `reporterInEvent: true` and still reached nobody. Exporting only the
    // first would have an operator assume an admin saw it (#670).
    const abuse = (id: string, over: Record<string, unknown>) => ({ ...report(id), kind: 'abuse', ...over });
    for (const doc of [
      abuse('report_alerted', { reporterInEvent: true, escalationEligible: true, escalationLookupFailed: false }),
      abuse('report_archived', { reporterInEvent: true, escalationEligible: false, escalationLookupFailed: false }),
      abuse('report_stranger', { reporterInEvent: false, escalationEligible: false, escalationLookupFailed: false }),
      // The lookup never answered: no authorization decision was recorded, and
      // that must not read as a confirmed non-member.
      abuse('report_unknown', { escalationEligible: false, escalationLookupFailed: true }),
    ]) {
      await exportReports({ reports: [doc], downloadScreenshot: async () => PNG, root });
    }
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    const read = async (id: string) =>
      JSON.parse(await readFile(path.join(root, `inbox/${id}/report.json`), 'utf8'));

    expect(await read('report_alerted')).toMatchObject({ reporterInEvent: true, escalationEligible: true });
    // The case that motivated this: a genuine member whose Event was not live.
    expect(await read('report_archived')).toMatchObject({ reporterInEvent: true, escalationEligible: false });
    expect(await read('report_stranger')).toMatchObject({ reporterInEvent: false, escalationEligible: false });
    expect(await read('report_unknown')).toMatchObject({
      reporterInEvent: null,
      escalationEligible: false,
      escalationLookupFailed: true,
    });
    // `null`, not `false`, for a bug report: nothing was checked because there
    // was nothing to escalate.
    expect(await read('report_123')).toMatchObject({
      reporterInEvent: null,
      escalationEligible: null,
      escalationLookupFailed: null,
    });
  });

  it('fails closed on escalation metadata that is malformed OR incomplete', async () => {
    // Absent is malformed too, on an abuse report. Intake writes both booleans
    // on every abuse submission, so a missing one means a half-migrated or
    // hand-repaired record — and exporting it as `false` would make an unknown
    // decision indistinguishable from an explicit negative. `null` cannot stand
    // in for "unknown" here: it already means "not applicable" (a bug report).
    for (const [error, doc] of [
      ['Invalid reporterInEvent', { ...report(), kind: 'abuse', reporterInEvent: 'yes', escalationEligible: false, escalationLookupFailed: false }],
      ['Invalid escalationEligible', { ...report(), kind: 'abuse', reporterInEvent: true, escalationEligible: 'yes', escalationLookupFailed: false }],
      ['Missing reporterInEvent', { ...report(), kind: 'abuse', escalationEligible: false, escalationLookupFailed: false }],
      ['Missing escalationEligible', { ...report(), kind: 'abuse', reporterInEvent: true, escalationLookupFailed: false }],
      ['Missing escalationLookupFailed', { ...report(), kind: 'abuse', reporterInEvent: true, escalationEligible: true }],
      // A recorded decision alongside "we never got an answer" is incoherent.
      ['Unexpected reporterInEvent', { ...report(), kind: 'abuse', reporterInEvent: false, escalationEligible: false, escalationLookupFailed: true }],
    ] as const) {
      const summary = await exportReports({ reports: [doc], downloadScreenshot: async () => PNG, root });
      expect(summary.failed[0].error).toContain(error);
      await expect(stat(path.join(root, 'inbox/report_123'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('archives with an immutable GitHub receipt and prevents duplicate import', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    const receipt = await archiveReport({
      reportId: 'report_123',
      issueUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/200',
      root,
      now: new Date('2026-07-10T00:00:00Z'),
    });
    expect(receipt.issue).toBe(200);
    expect(JSON.parse(await readFile(path.join(root, 'imported/report_123/github-issue.json'), 'utf8'))).toEqual(receipt);
    await expect(archiveReport({ reportId: 'report_123', issueUrl: receipt.url, root })).resolves.toEqual(receipt);
    await expect(archiveReport({
      reportId: 'report_123',
      issueUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/201',
      root,
    })).rejects.toThrow('conflicting receipt');
  });

  it('does not overwrite a malformed pre-existing receipt', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    await writeFile(path.join(root, 'inbox/report_123/github-issue.json'), 'existing');
    await expect(archiveReport({
      reportId: 'report_123',
      issueUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/200',
      root,
    })).rejects.toThrow();
  });

  it('records a retryable failed or ambiguous disposition without moving the report', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    const disposition = await recordDisposition({
      reportId: 'report_123',
      status: 'ambiguous',
      reason: 'Screenshot and text describe different screens.',
      root,
      now: new Date('2026-07-10T00:00:00Z'),
    });
    expect(disposition.retryable).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, 'inbox/report_123/disposition.json'), 'utf8'))).toEqual(disposition);
    await expect(recordDisposition({
      reportId: 'report_123', status: 'ambiguous', reason: disposition.reason, root,
    })).resolves.toEqual(disposition);
    await expect(recordDisposition({
      reportId: 'report_123', status: 'failed', reason: 'Different outcome.', root,
    })).rejects.toThrow('conflicting disposition');
  });

  it('normalizes Firestore timestamps without letting malformed values abort a batch', () => {
    expect(normalizeSubmittedAt({ toDate: () => new Date('2026-07-09T00:00:00Z') })).toBe('2026-07-09T00:00:00.000Z');
    expect(normalizeSubmittedAt({ toDate: () => { throw new Error('bad timestamp'); } })).toBeNull();
    expect(normalizeSubmittedAt('2026-07-09')).toBeNull();
  });

  const LEDGER = 'imported-ledger.jsonl';
  const ISSUE_200 = 'https://github.com/nathanjohnpayne/fiveacross/issues/200';
  const ISSUE_200_OLD_SLUG = 'https://github.com/nathanjohnpayne/gaycruisebingo/issues/200';

  it('durable dedupe: skips a report recorded in the committed ledger even with no local inbox/imported tree', async () => {
    // Simulate a fresh clone or deleted worktree: only the committed ledger
    // survives, with no local inbox/imported directory for the report.
    await writeFile(
      path.join(root, LEDGER),
      `${JSON.stringify({ reportId: 'report_123', issue: 200, url: ISSUE_200, importedAt: '2026-07-10T00:00:00.000Z' })}\n`,
    );
    const summary = await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    expect(summary.skipped).toEqual(['report_123']);
    expect(summary.exported).toEqual([]);
  });

  it('durable dedupe: skips ledgered reports before validating mutable source fields', async () => {
    await writeFile(
      path.join(root, LEDGER),
      `${JSON.stringify({ reportId: 'report_123', issue: 200, url: ISSUE_200, importedAt: '2026-07-10T00:00:00.000Z' })}\n`,
    );
    const malformed = { ...report(), status: 'not-new' };
    const summary = await exportReports({ reports: [malformed], downloadScreenshot: async () => PNG, root });
    expect(summary.skipped).toEqual(['report_123']);
    expect(summary.failed).toEqual([]);
  });

  it('fails closed on malformed durable ledger JSON instead of re-exporting duplicates', async () => {
    await writeFile(path.join(root, LEDGER), '{"reportId":"report_123"\n');
    await expect(exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root })).rejects.toThrow('invalid JSON');
    await expect(stat(path.join(root, 'inbox/report_123'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on incomplete durable ledger entries instead of treating reportId alone as a receipt', async () => {
    await writeFile(path.join(root, LEDGER), `${JSON.stringify({ reportId: 'report_123' })}\n`);
    await expect(exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root })).rejects.toThrow('invalid ledger fields');
    await expect(stat(path.join(root, 'inbox/report_123'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('archive records the import in the committed ledger, which then dedupes even after the imported/ tree is wiped', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    await archiveReport({ reportId: 'report_123', issueUrl: ISSUE_200, root, now: new Date('2026-07-10T00:00:00Z') });

    const ledger = (await readFile(path.join(root, LEDGER), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger).toEqual([{ reportId: 'report_123', issue: 200, url: ISSUE_200, importedAt: '2026-07-10T00:00:00.000Z' }]);

    // Durability: blow away the local imported/ tree; the ledger still dedupes.
    await rm(path.join(root, 'imported'), { recursive: true, force: true });
    const rerun = await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    expect(rerun.skipped).toEqual(['report_123']);
  });

  it('keeps an archived report retryable in the inbox if the durable ledger append fails', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    await mkdir(path.join(root, LEDGER));

    await expect(archiveReport({
      reportId: 'report_123',
      issueUrl: ISSUE_200,
      root,
      now: new Date('2026-07-10T00:00:00Z'),
    })).rejects.toThrow();

    await expect(stat(path.join(root, 'inbox/report_123'))).resolves.toBeDefined();
    await expect(stat(path.join(root, 'imported/report_123'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a stale inbox archive when the durable ledger already records a different issue', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    await writeFile(
      path.join(root, LEDGER),
      `${JSON.stringify({ reportId: 'report_123', issue: 200, url: ISSUE_200, importedAt: '2026-07-10T00:00:00.000Z' })}\n`,
    );

    await expect(archiveReport({
      reportId: 'report_123',
      issueUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/201',
      root,
    })).rejects.toThrow('Ledger has a conflicting receipt');

    await expect(stat(path.join(root, 'inbox/report_123'))).resolves.toBeDefined();
    await expect(stat(path.join(root, 'imported/report_123'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the durable ledger receipt to clean up a stale inbox archive for the same issue', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    const ledgerReceipt = { reportId: 'report_123', issue: 200, url: ISSUE_200, importedAt: '2026-07-10T00:00:00.000Z' };
    await writeFile(path.join(root, LEDGER), `${JSON.stringify(ledgerReceipt)}\n`);

    const receipt = await archiveReport({ reportId: 'report_123', issueUrl: ISSUE_200, root });

    expect(receipt).toEqual(ledgerReceipt);
    expect(JSON.parse(await readFile(path.join(root, 'imported/report_123/github-issue.json'), 'utf8'))).toEqual(ledgerReceipt);
  });

  // --- repository-rename compatibility (gaycruisebingo -> fiveacross) -------
  // Every one of the 11 committed ledger rows predates the rename and carries the
  // old slug, and ISSUE_URL accepts both. These pin the three behaviours that
  // compatibility has to have, none of which the new-slug fixtures above exercise.

  it('accepts an old-slug ledger receipt written before the repository rename', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    const oldSlugReceipt = { reportId: 'report_123', issue: 200, url: ISSUE_200_OLD_SLUG, importedAt: '2026-07-10T00:00:00.000Z' };
    await writeFile(path.join(root, LEDGER), `${JSON.stringify(oldSlugReceipt)}\n`);

    const receipt = await archiveReport({ reportId: 'report_123', issueUrl: ISSUE_200_OLD_SLUG, root });

    expect(receipt).toEqual(oldSlugReceipt);
  });

  it('treats the old and new repository slugs as aliases for the same issue on retry', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    // The durable ledger row is pre-rename; the retry uses the documented new-slug
    // URL for the SAME issue. A byte-for-byte URL comparison read this as a
    // conflicting receipt and aborted the idempotent stale-inbox cleanup.
    const oldSlugReceipt = { reportId: 'report_123', issue: 200, url: ISSUE_200_OLD_SLUG, importedAt: '2026-07-10T00:00:00.000Z' };
    await writeFile(path.join(root, LEDGER), `${JSON.stringify(oldSlugReceipt)}\n`);

    const receipt = await archiveReport({ reportId: 'report_123', issueUrl: ISSUE_200, root });

    expect(receipt).toEqual(oldSlugReceipt);
    expect(JSON.parse(await readFile(path.join(root, 'imported/report_123/github-issue.json'), 'utf8'))).toEqual(oldSlugReceipt);
  });

  it('still rejects a different issue across the slug aliases, so alias-equality does not mask a real conflict', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    await writeFile(
      path.join(root, LEDGER),
      `${JSON.stringify({ reportId: 'report_123', issue: 200, url: ISSUE_200_OLD_SLUG, importedAt: '2026-07-10T00:00:00.000Z' })}\n`,
    );

    await expect(archiveReport({
      reportId: 'report_123',
      issueUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/201',
      root,
    })).rejects.toThrow('Ledger has a conflicting receipt');

    await expect(stat(path.join(root, 'inbox/report_123'))).resolves.toBeDefined();
  });

  it('ledger append is idempotent and self-heals a pre-ledger import on re-archive', async () => {
    await exportReports({ reports: [report()], downloadScreenshot: async () => PNG, root });
    await archiveReport({ reportId: 'report_123', issueUrl: ISSUE_200, root, now: new Date('2026-07-10T00:00:00Z') });

    // Simulate an import made before the ledger existed: drop the ledger but keep
    // the imported/ receipt. Re-archiving (the idempotent receipt path) back-fills
    // it, and repeating never duplicates the line.
    await rm(path.join(root, LEDGER), { force: true });
    await archiveReport({ reportId: 'report_123', issueUrl: ISSUE_200, root });
    await archiveReport({ reportId: 'report_123', issueUrl: ISSUE_200, root });

    const lines = (await readFile(path.join(root, LEDGER), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ reportId: 'report_123', issue: 200 });
  });
});
