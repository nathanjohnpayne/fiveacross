#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { archiveReport, exportReports, normalizeSubmittedAt, recordDisposition } from './bug-reports-lib.mjs';
import { prunePendingBugReports } from './bug-report-prune-lib.mjs';

const root = path.resolve('.github/bug-reports');

async function firebaseConfig() {
  const projectFile = JSON.parse(await readFile('.firebaserc', 'utf8'));
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || projectFile.projects?.default;
  let storageBucket = process.env.BUG_REPORT_BUCKET;
  if (!storageBucket) {
    try {
      const env = await readFile('.env.local', 'utf8');
      storageBucket = /^VITE_FIREBASE_STORAGE_BUCKET=(.+)$/m.exec(env)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    } catch {
      // The explicit env below gives the operator a deterministic recovery path.
    }
  }
  if (!projectId || !storageBucket) {
    throw new Error('Set BUG_REPORT_BUCKET (or VITE_FIREBASE_STORAGE_BUCKET in .env.local) before operating on reports.');
  }
  return { projectId, storageBucket };
}

async function pull() {
  const config = await firebaseConfig();
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
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed.length) process.exitCode = 1;
}

function sameValue(left, right) {
  if (left && typeof left.isEqual === 'function') return left.isEqual(right);
  return left === right;
}

function pruneStore(db, bucket, nowMs) {
  return {
    list: async (state, cursor, limit) => {
      let query = db.collection('bugReports').where('intakeState', '==', state).orderBy(FieldPath.documentId()).limit(limit);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
    },
    claimPending: async (row, cleanupLeaseId, cleanupLeaseExpiresAt) => await db.runTransaction(async (transaction) => {
      const ref = db.doc(`bugReports/${row.id}`);
      const snapshot = await transaction.get(ref);
      const current = snapshot.data();
      if (
        current?.intakeState !== 'pending' ||
        current.requestHash !== row.requestHash ||
        current.leaseId !== row.leaseId ||
        !sameValue(current.intakeStartedAt, row.intakeStartedAt) ||
        !sameValue(current.leaseExpiresAt, row.leaseExpiresAt)
      ) return false;
      transaction.update(ref, { intakeState: 'deleting', cleanupLeaseId, cleanupLeaseExpiresAt: new Date(cleanupLeaseExpiresAt) });
      return true;
    }),
    claimDeleting: async (row, cleanupLeaseId, cleanupLeaseExpiresAt) => await db.runTransaction(async (transaction) => {
      const ref = db.doc(`bugReports/${row.id}`);
      const snapshot = await transaction.get(ref);
      const current = snapshot.data();
      const currentExpiry = normalizeSubmittedAt(current?.cleanupLeaseExpiresAt);
      if (
        current?.intakeState !== 'deleting' ||
        current.requestHash !== row.requestHash ||
        current.cleanupLeaseId !== row.cleanupLeaseId ||
        !sameValue(current.intakeStartedAt, row.intakeStartedAt) ||
        !sameValue(current.cleanupLeaseExpiresAt, row.cleanupLeaseExpiresAt) ||
        !currentExpiry || Date.parse(currentExpiry) > nowMs
      ) return false;
      transaction.update(ref, { cleanupLeaseId, cleanupLeaseExpiresAt: new Date(cleanupLeaseExpiresAt) });
      return true;
    }),
    deleteEvidence: async (storagePath) => {
      await bucket.file(storagePath).delete({ ignoreNotFound: true });
    },
    deleteIfOwned: async (row, cleanupLeaseId) => await db.runTransaction(async (transaction) => {
      const ref = db.doc(`bugReports/${row.id}`);
      const snapshot = await transaction.get(ref);
      const current = snapshot.data();
      if (
        current?.intakeState !== 'deleting' ||
        current.requestHash !== row.requestHash ||
        current.cleanupLeaseId !== cleanupLeaseId ||
        !sameValue(current.intakeStartedAt, row.intakeStartedAt)
      ) return false;
      transaction.delete(ref);
      return true;
    }),
  };
}

async function prunePending(apply) {
  const config = await firebaseConfig();
  const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), ...config });
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket(config.storageBucket);
  const nowMs = Date.now();
  const summary = await prunePendingBugReports({
    store: pruneStore(db, bucket, nowMs),
    nowMs,
    apply,
    randomUUID,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed.length) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'pull') {
  await pull();
} else if (command === 'archive') {
  if (args.length !== 2) throw new Error('Usage: npm run bugs:archive -- <report-id> <github-issue-url>');
  process.stdout.write(`${JSON.stringify(await archiveReport({ reportId: args[0], issueUrl: args[1], root }), null, 2)}\n`);
} else if (command === 'disposition') {
  if (args.length < 3) throw new Error('Usage: npm run bugs:disposition -- <report-id> <failed|ambiguous> <reason>');
  process.stdout.write(`${JSON.stringify(await recordDisposition({ reportId: args[0], status: args[1], reason: args.slice(2).join(' '), root }), null, 2)}\n`);
} else if (command === 'prune-pending') {
  if (args.some((arg) => arg !== '--apply') || args.filter((arg) => arg === '--apply').length > 1) {
    throw new Error('Usage: npm run bugs:prune-pending -- [--apply]');
  }
  await prunePending(args.includes('--apply'));
} else {
  throw new Error('Usage: bug-reports.mjs <pull|archive|disposition|prune-pending>');
}
