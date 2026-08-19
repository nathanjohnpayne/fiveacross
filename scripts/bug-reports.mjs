#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { bugReportFirebaseConfig } from './bug-report-target.mjs';
import { archiveReport, exportReports, normalizeSubmittedAt, recordDisposition } from './bug-reports-lib.mjs';
import { prunePendingBugReports } from './bug-report-prune-lib.mjs';
import { createBugReportPruneStore } from './bug-report-prune-store.mjs';

const root = path.resolve('.github/bug-reports');

async function pull(target) {
  const config = bugReportFirebaseConfig(target);
  const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), ...config });
  const reports = [];
  let cursor = null;
  do {
    let query = getFirestore(app).collection('bugReports').orderBy(FieldPath.documentId()).limit(100);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      reports.push({ ...data, id: doc.id, submittedAt: normalizeSubmittedAt(data.submittedAt) });
    }
    cursor = snapshot.docs.length === 100 ? snapshot.docs.at(-1) : null;
  } while (cursor);
  const bucket = getStorage(app).bucket(config.storageBucket);
  const summary = await exportReports({
    reports,
    root,
    downloadScreenshot: async (storagePath) => (await bucket.file(storagePath).download())[0],
  });
  process.stdout.write(`${JSON.stringify({ ...config, ...summary }, null, 2)}\n`);
  if (summary.failed.length) process.exitCode = 1;
}

async function prunePending(target, apply) {
  const config = bugReportFirebaseConfig(target);
  const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), ...config });
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket(config.storageBucket);
  const nowMs = Date.now();
  const summary = await prunePendingBugReports({
    store: createBugReportPruneStore({ db, bucket, nowMs }),
    nowMs,
    apply,
    randomUUID,
  });
  process.stdout.write(`${JSON.stringify({ ...config, apply, ...summary }, null, 2)}\n`);
  if (summary.failed.length) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'pull') {
  if (args.length !== 1) throw new Error('Usage: npm run bugs:pull -- <gaycruisebingo|fiveacross>');
  await pull(args[0]);
} else if (command === 'archive') {
  if (args.length !== 2) throw new Error('Usage: npm run bugs:archive -- <report-id> <github-issue-url>');
  process.stdout.write(`${JSON.stringify(await archiveReport({ reportId: args[0], issueUrl: args[1], root }), null, 2)}\n`);
} else if (command === 'disposition') {
  if (args.length < 3) throw new Error('Usage: npm run bugs:disposition -- <report-id> <failed|ambiguous> <reason>');
  process.stdout.write(`${JSON.stringify(await recordDisposition({ reportId: args[0], status: args[1], reason: args.slice(2).join(' '), root }), null, 2)}\n`);
} else if (command === 'prune-pending') {
  const [target, ...options] = args;
  if (
    !target ||
    options.some((arg) => arg !== '--apply') ||
    options.filter((arg) => arg === '--apply').length > 1
  ) {
    throw new Error('Usage: npm run bugs:prune-pending -- <gaycruisebingo|fiveacross> [--apply]');
  }
  await prunePending(target, options.includes('--apply'));
} else {
  throw new Error('Usage: bug-reports.mjs <pull|archive|disposition|prune-pending>');
}
