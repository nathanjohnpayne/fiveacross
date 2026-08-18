import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import contract from '../functions/src/bugReportContract.cjs';

const { REPORT_KINDS, validateClientReportFields, validatePngBytes } = contract;

const REPORT_ID = /^[A-Za-z0-9_-]{6,100}$/;
const ISSUE_URL = /^https:\/\/github\.com\/nathanjohnpayne\/gaycruisebingo\/issues\/(\d+)$/;

// The durable dedupe ledger (issue #146's "export ledger" decision, made durable).
// One JSON object per line — {reportId, issue, url, importedAt} — recording every
// report already turned into a GitHub issue. Report IDs are opaque Firestore doc
// IDs (no PII), so unlike the gitignored inbox/imported trees this file IS
// committed: that is what makes dedupe survive a fresh clone or a deleted worktree.
const LEDGER_FILE = 'imported-ledger.jsonl';

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(target) {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeReceipt(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label}: invalid receipt`);
  if (!REPORT_ID.test(entry.reportId)) throw new Error(`${label}: invalid reportId`);
  if (!Number.isSafeInteger(entry.issue) || entry.issue <= 0) throw new Error(`${label}: invalid issue`);
  const urlMatch = typeof entry.url === 'string' ? ISSUE_URL.exec(entry.url) : null;
  if (!urlMatch || Number(urlMatch[1]) !== entry.issue) throw new Error(`${label}: invalid issue url`);
  if (typeof entry.importedAt !== 'string' || !Number.isFinite(Date.parse(entry.importedAt))) throw new Error(`${label}: invalid importedAt`);
  return {
    reportId: entry.reportId,
    issue: entry.issue,
    url: entry.url,
    importedAt: entry.importedAt,
  };
}

function validateLedgerEntry(entry, lineNumber) {
  const prefix = `${LEDGER_FILE}:${lineNumber}`;
  const keys = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry).sort() : [];
  const expected = ['importedAt', 'issue', 'reportId', 'url'];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error(`${prefix}: invalid ledger fields`);
  return normalizeReceipt(entry, prefix);
}

function sameReceipt(a, b) {
  return a.reportId === b.reportId && a.issue === b.issue && a.url === b.url && a.importedAt === b.importedAt;
}

function sameIssueTarget(a, b) {
  return a.reportId === b.reportId && a.issue === b.issue && a.url === b.url;
}

/**
 * Parse the committed dedupe ledger into its entries. A missing ledger is an
 * empty list; a malformed or conflicting line fails closed so a corrupt durable
 * record cannot silently re-open the door to duplicate imports.
 */
async function readLedger(root) {
  let raw;
  try {
    raw = await readFile(path.join(root, LEDGER_FILE), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  const seen = new Map();
  for (const [index, line] of raw.split('\n').entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`${LEDGER_FILE}:${lineNumber}: invalid JSON`);
    }
    const entry = validateLedgerEntry(parsed, lineNumber);
    const prior = seen.get(entry.reportId);
    if (prior) {
      if (sameReceipt(prior, entry)) throw new Error(`${LEDGER_FILE}:${lineNumber}: duplicate reportId`);
      throw new Error(`${LEDGER_FILE}:${lineNumber}: conflicting reportId`);
    }
    seen.set(entry.reportId, entry);
    entries.push(entry);
  }
  return entries;
}

async function ledgerReportIds(root) {
  return new Set((await readLedger(root)).map((entry) => entry.reportId));
}

/**
 * Append a receipt to the ledger, idempotently — a report already recorded is a
 * no-op. Called on every archive, INCLUDING the idempotent re-archive path, so a
 * report imported before the ledger existed is back-filled the next time archive
 * runs: the ledger self-heals rather than needing a separate migration.
 */
async function appendToLedger(root, receipt) {
  const existing = (await readLedger(root)).find((entry) => entry.reportId === receipt.reportId);
  if (existing) {
    if (sameIssueTarget(existing, receipt)) return;
    throw new Error(`Ledger has a conflicting receipt for ${receipt.reportId}`);
  }
  const entry = { reportId: receipt.reportId, issue: receipt.issue, url: receipt.url, importedAt: receipt.importedAt };
  await appendFile(path.join(root, LEDGER_FILE), `${JSON.stringify(entry)}\n`);
}

export function normalizeSubmittedAt(value) {
  try {
    const date = typeof value?.toDate === 'function' ? value.toDate() : value;
    return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

function safeReport(report) {
  if (!report || !REPORT_ID.test(report.id ?? '')) throw new Error('Invalid report id');
  const fields = validateClientReportFields(report);
  if (typeof report.reporterHash !== 'string' || !/^[a-f0-9]{20}$/.test(report.reporterHash)) throw new Error(`Invalid reporter hash for ${report.id}`);
  const expectedScreenshotPath = `bug-reports/${report.reporterHash}/${report.id}/screenshot.png`;
  if (report.screenshotPath !== null && report.screenshotPath !== expectedScreenshotPath) throw new Error(`Unsafe screenshot path for ${report.id}`);
  if (typeof report.submittedAt !== 'string' || !Number.isFinite(Date.parse(report.submittedAt))) throw new Error(`Invalid submittedAt for ${report.id}`);
  if (report.captureError != null && (typeof report.captureError !== 'string' || report.captureError.length > 200)) throw new Error(`Invalid capture error for ${report.id}`);
  if (report.status !== 'new') throw new Error(`Invalid status for ${report.id}`);
  // FAIL CLOSED on a stored `kind` the contract does not recognize, unlike the
  // intake path (#670 Codex P2). Normalizing an unknown value down to `bug` is
  // right at INTAKE, where the alternative is losing a report from a client that
  // cannot be forced to upgrade. Here the document has already been through that
  // normalizer, so a present-but-unrecognized value means the stored report was
  // hand-repaired, half-migrated, or written by a producer this checkout does not
  // know — and silently exporting it as `bug` would discard triage information
  // the operator is relying on. An ABSENT field is still the legacy default:
  // every report stored before #670 has none.
  if (report.kind !== undefined && !REPORT_KINDS.includes(report.kind)) {
    throw new Error(`Invalid kind for ${report.id}`);
  }
  // Both escalation fields fail closed, in BOTH directions. A wrong type is
  // malformed; an ABSENT one on an abuse report is malformed too, because every
  // abuse report intake writes persists both — so a missing value means a
  // half-migrated or hand-repaired record, and serializing it as `false` would
  // make an unknown decision indistinguishable from an explicit negative (#670).
  // `null` is not available to mean "unknown" here: it already means "not
  // applicable", which is what a bug report exports.
  for (const field of ['reporterInEvent', 'escalationEligible', 'escalationLookupFailed']) {
    if (report[field] !== undefined && typeof report[field] !== 'boolean') {
      throw new Error(`Invalid ${field} for ${report.id}`);
    }
  }
  if (fields.kind === 'abuse') {
    // Every abuse submission records whether the escalation lookup completed, so
    // a missing verdict is a malformed record rather than an old one.
    if (report.escalationLookupFailed === undefined) throw new Error(`Missing escalationLookupFailed for ${report.id}`);
    if (report.escalationEligible === undefined) throw new Error(`Missing escalationEligible for ${report.id}`);
    // `reporterInEvent` is present exactly when the lookup answered. Requiring
    // it unconditionally would reject the unanswered case; allowing it in the
    // unanswered case would mean an authorization decision was recorded when
    // none was made (#670, Phase 4b P2).
    if (!report.escalationLookupFailed && report.reporterInEvent === undefined) {
      throw new Error(`Missing reporterInEvent for ${report.id}`);
    }
    if (report.escalationLookupFailed && report.reporterInEvent !== undefined) {
      throw new Error(`Unexpected reporterInEvent for ${report.id}`);
    }
  }
  const metadata = {
    id: report.id,
    schemaVersion: fields.schemaVersion,
    // From the shared contract, so a report stored before #670 (no `kind` field)
    // exports as `bug` rather than as a hole an importer has to interpret.
    kind: fields.kind,
    // TWO fields, because escalation has two conditions and conflating them is
    // how an operator ends up assuming a suppressed report reached somebody
    // (#670). `null` on a bug report for both: nothing was checked, because
    // there was nothing to escalate.
    //
    //   `reporterInEvent` — did the reporter belong to the Event they named?
    //   This is the trigger's gate input: NECESSARY for an alert, not
    //   sufficient. On its own it does not mean an admin heard anything.
    //   `null` here means one of two things depending on `kind`: not applicable
    //   (a bug report), or NOT ANSWERED (the lookup failed) — which
    //   `escalationLookupFailed` is what distinguishes.
    reporterInEvent:
      fields.kind === 'abuse' && !report.escalationLookupFailed ? report.reporterInEvent === true : null,
    //   `escalationEligible` — did the submission MEET THE CONDITIONS to be
    //   escalated? Membership AND a live Event, the same answer the reporter's
    //   receipt gave. Deliberately not a claim that an alert exists, let alone
    //   that anyone read it: it is recorded before the trigger runs, that
    //   trigger re-checks Event status, and the digest beyond it may resolve no
    //   admin recipient. It is the closest thing the stored report can honestly
    //   assert about whether anyone was going to hear about it.
    escalationEligible: fields.kind === 'abuse' ? report.escalationEligible === true : null,
    //   `escalationLookupFailed` — could the question even be asked? An
    //   infrastructure failure must not read as a confirmed non-member: one is a
    //   decision about the reporter, the other is the absence of one.
    escalationLookupFailed: fields.kind === 'abuse' ? report.escalationLookupFailed === true : null,
    screenshotPath: report.screenshotPath,
    captureError: fields.captureError,
    route: fields.route,
    eventId: fields.eventId,
    appVersion: fields.appVersion,
    browser: fields.browser,
    viewport: fields.viewport,
    online: fields.online,
    reporterHash: report.reporterHash,
    submittedAt: report.submittedAt,
    status: report.status,
  };
  return { description: fields.description, metadata };
}

export async function exportReports({ reports, downloadScreenshot, root }) {
  const inbox = path.join(root, 'inbox');
  const imported = path.join(root, 'imported');
  await mkdir(inbox, { recursive: true });
  await mkdir(imported, { recursive: true });
  // Durable dedupe (#146): skip any report already recorded in the committed
  // ledger, even when this checkout has no local inbox/imported tree — a fresh
  // clone, a different machine, or after the import worktree was deleted.
  const alreadyImported = await ledgerReportIds(root);
  const summary = { exported: [], skipped: [], failed: [] };
  for (const report of reports) {
    const reportId = report?.id;
    if (REPORT_ID.test(reportId ?? '')) {
      const destination = path.join(inbox, reportId);
      if (await exists(destination) || await exists(path.join(imported, reportId)) || alreadyImported.has(reportId)) {
        summary.skipped.push(reportId);
        continue;
      }
    }
    let validated;
    try {
      validated = safeReport(report);
    } catch (error) {
      summary.failed.push({ id: report?.id ?? 'unknown', error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const destination = path.join(inbox, report.id);
    const staging = path.join(root, `.tmp-${report.id}-${process.pid}`);
    try {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      await writeFile(path.join(staging, 'report.json'), `${JSON.stringify(validated.metadata, null, 2)}\n`, { flag: 'wx' });
      await writeFile(path.join(staging, 'description.md'), `${validated.description}\n`, { flag: 'wx' });
      if (report.screenshotPath) {
        const image = await downloadScreenshot(report.screenshotPath);
        validatePngBytes(image);
        await writeFile(path.join(staging, 'screenshot.png'), image, { flag: 'wx' });
      }
      await rename(staging, destination);
      summary.exported.push(report.id);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      summary.failed.push({ id: report.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return summary;
}

export async function archiveReport({ reportId, issueUrl, root, now = new Date() }) {
  if (!REPORT_ID.test(reportId)) throw new Error('Invalid report id');
  const match = ISSUE_URL.exec(issueUrl);
  if (!match) throw new Error('Issue URL must point to nathanjohnpayne/gaycruisebingo');
  const source = path.join(root, 'inbox', reportId);
  const destination = path.join(root, 'imported', reportId);
  const requested = {
    reportId,
    issue: Number(match[1]),
    url: issueUrl,
  };
  const ledgerReceipt = (await readLedger(root)).find((entry) => entry.reportId === reportId);
  const importedReceiptRaw = await readJson(path.join(destination, 'github-issue.json'));
  if (importedReceiptRaw) {
    const importedReceipt = normalizeReceipt(importedReceiptRaw, `Imported report ${reportId} receipt`);
    if (sameIssueTarget(importedReceipt, requested)) {
      if (ledgerReceipt && !sameIssueTarget(ledgerReceipt, importedReceipt)) throw new Error(`Ledger has a conflicting receipt for ${reportId}`);
      await appendToLedger(root, importedReceipt); // self-heal: back-fill a pre-ledger import on re-archive
      return importedReceipt;
    }
    throw new Error(`Imported report ${reportId} has a conflicting receipt`);
  }
  const sourceExists = await exists(source);
  const receiptPath = path.join(source, 'github-issue.json');
  const existingReceiptRaw = sourceExists ? await readJson(receiptPath) : null;
  const existingReceipt = existingReceiptRaw ? normalizeReceipt(existingReceiptRaw, `Inbox report ${reportId} receipt`) : null;
  if (ledgerReceipt) {
    if (!sameIssueTarget(ledgerReceipt, requested)) throw new Error(`Ledger has a conflicting receipt for ${reportId}`);
    if (existingReceipt && !sameReceipt(existingReceipt, ledgerReceipt)) throw new Error(`Inbox report ${reportId} has a conflicting receipt`);
    if (!sourceExists) return ledgerReceipt;
    if (!existingReceipt) await writeFile(receiptPath, `${JSON.stringify(ledgerReceipt, null, 2)}\n`, { flag: 'wx' });
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
    return ledgerReceipt;
  }
  if (!sourceExists) throw new Error(`Inbox report ${reportId} does not exist`);
  if (existingReceipt && !sameIssueTarget(existingReceipt, requested)) {
    throw new Error(`Inbox report ${reportId} has a conflicting receipt`);
  }
  const receipt = existingReceipt ?? { ...requested, importedAt: now.toISOString() };
  if (!existingReceipt) await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  await mkdir(path.dirname(destination), { recursive: true });
  await appendToLedger(root, receipt);
  await rename(source, destination);
  return receipt;
}

export async function recordDisposition({ reportId, status, reason, root, now = new Date() }) {
  if (!REPORT_ID.test(reportId)) throw new Error('Invalid report id');
  if (!['failed', 'ambiguous'].includes(status)) throw new Error('Disposition must be failed or ambiguous');
  const trimmed = reason?.trim();
  if (!trimmed || trimmed.length > 1000) throw new Error('Disposition reason must be 1-1000 characters');
  const source = path.join(root, 'inbox', reportId);
  if (!(await exists(source))) throw new Error(`Inbox report ${reportId} does not exist`);
  const dispositionPath = path.join(source, 'disposition.json');
  const existingDisposition = await readJson(dispositionPath);
  if (existingDisposition) {
    if (existingDisposition.reportId === reportId && existingDisposition.status === status && existingDisposition.reason === trimmed) return existingDisposition;
    throw new Error(`Inbox report ${reportId} has a conflicting disposition`);
  }
  const disposition = { reportId, status, reason: trimmed, retryable: true, recordedAt: now.toISOString() };
  await writeFile(dispositionPath, `${JSON.stringify(disposition, null, 2)}\n`, { flag: 'wx' });
  return disposition;
}
