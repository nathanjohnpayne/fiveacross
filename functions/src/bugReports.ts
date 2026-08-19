import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import {
  BugReportInputError,
  nextRateState,
  validateBugReportInput,
  type RateState,
  type ValidBugReport,
} from './bugReportCore';
import { firestoreErrorCodeForLog, isAlreadyExists } from './firestoreErrors';

const REPORT_ID_DOMAIN = 'bug-report-v1\0';
const REQUEST_HASH_DOMAIN = 'bug-report-request-v1\0';
const CURRENT_REQUEST_HASH_VERSION = 1 as const;
export const BUG_REPORT_ESCALATION_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const BUG_REPORT_ESCALATION_PENDING_TTL_MARGIN_MS = 24 * 60 * 60 * 1_000;

export function deriveBugReportId(uid: string, submissionId: string): string {
  return createHash('sha256').update(REPORT_ID_DOMAIN).update(uid).update('\0').update(submissionId).digest('hex');
}

function requestHashV1(report: ValidBugReport): string {
  const screenshotSha256 = report.screenshot
    ? createHash('sha256').update(report.screenshot).digest('hex')
    : null;
  const tuple = [
    report.schemaVersion,
    report.kind,
    report.description,
    report.captureError,
    report.route,
    report.eventId,
    report.appVersion,
    report.browser,
    report.viewport.width,
    report.viewport.height,
    report.online,
    screenshotSha256,
  ];
  return createHash('sha256').update(REQUEST_HASH_DOMAIN, 'utf8').update(JSON.stringify(tuple), 'utf8').digest('hex');
}

const REQUEST_HASH_VERIFIERS = new Map<number, (report: ValidBugReport) => string>([[1, requestHashV1]]);

export function deriveBugReportRequestHash(report: ValidBugReport): { version: 1; value: string } {
  return { version: CURRENT_REQUEST_HASH_VERSION, value: requestHashV1(report) };
}

export function verifyBugReportRequestHash(report: ValidBugReport, version: number, value: string): boolean {
  const verifier = REQUEST_HASH_VERIFIERS.get(version);
  if (!verifier) return false;
  return verifier(report) === value;
}

interface IntakeSnapshot {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface IntakeDocRef {
  id: string;
  path: string;
  get(): Promise<IntakeSnapshot>;
  create(data: object): Promise<unknown>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
}

interface IntakeTransaction {
  get(ref: IntakeDocRef): Promise<IntakeSnapshot>;
  create(ref: IntakeDocRef, data: object): unknown;
  set(ref: IntakeDocRef, data: object): unknown;
  update(ref: IntakeDocRef, data: object): unknown;
}

interface IntakeFirestore extends ReporterLookupFirestore {
  doc(path: string): IntakeDocRef;
  collection(path: string): { doc(id?: string): IntakeDocRef };
  runTransaction<T>(work: (transaction: IntakeTransaction) => Promise<T>): Promise<T>;
}

interface IntakeFile {
  save(bytes: Buffer, options: Record<string, unknown>): Promise<unknown>;
  getMetadata(): Promise<[Record<string, unknown>]>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
}

export interface BugReportIntakeDependencies {
  db: IntakeFirestore;
  file(path: string): IntakeFile;
  nowMs(): number;
  randomUUID(): string;
  timestamp(ms: number): unknown;
  serverTimestamp(): unknown;
  sleep(ms: number): Promise<void>;
  resolveEscalation(db: ReporterLookupFirestore, eventId: string, uid: string): Promise<AbuseEscalation>;
}

type IntakeReceipt = { reportId: string; escalationEligible: boolean };
type Coordination = {
  reportId: string;
  reporterHash: string;
  submissionId: string;
  requestHashVersion: 1;
  requestHash: string;
  report: ValidBugReport;
};

const INTAKE_LEASE_MS = 60_000;
const FOLLOWER_POLL_MS = 100;
const FOLLOWER_MAX_POLLS = 50;

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: unknown } | null)?.toMillis;
  if (typeof toMillis === 'function') {
    const result = toMillis.call(value);
    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  }
  return null;
}

function verifyCoordination(data: Record<string, unknown> | undefined, expected: Coordination): Record<string, unknown> {
  if (!data || data.submissionId !== expected.submissionId || data.reporterHash !== expected.reporterHash) {
    throw new HttpsError('failed-precondition', 'Stored submission identity does not match this retry.');
  }
  if (typeof data.requestHashVersion !== 'number' || typeof data.requestHash !== 'string') {
    throw new HttpsError('failed-precondition', 'Stored submission hash version is not supported.');
  }
  if (!verifyBugReportRequestHash(expected.report, data.requestHashVersion, data.requestHash)) {
    throw new HttpsError('failed-precondition', 'This submission identity was already used for a different report.');
  }
  return data;
}

function receiptFrom(data: Record<string, unknown>, reportId: string): IntakeReceipt {
  if (data.intakeState !== 'complete') {
    throw new HttpsError('failed-precondition', 'Stored submission is not a valid completed report.');
  }
  if (data.kind === 'bug') return { reportId, escalationEligible: false };
  if (data.kind !== 'abuse' || typeof data.escalationEligible !== 'boolean') {
    throw new HttpsError('failed-precondition', 'Stored submission has an invalid escalation outcome.');
  }
  return { reportId, escalationEligible: data.escalationEligible };
}

async function verifiedReadback(ref: IntakeDocRef, expected: Coordination): Promise<Record<string, unknown>> {
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('unavailable', 'Submission outcome is not yet readable. Try again.');
  return verifyCoordination(snapshot.data(), expected);
}

async function chargeLegacyRate(db: IntakeFirestore, reporterHash: string, nowMs: number): Promise<void> {
  const rateRef = db.doc(`bugReportRateLimits/${reporterHash}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(rateRef);
    transaction.set(rateRef, nextRateState(snapshot.exists ? snapshot.data() as unknown as RateState : undefined, nowMs));
  });
}

function reportDocument(
  report: ValidBugReport,
  reporterHash: string,
  screenshotPath: string | null,
  escalation: AbuseEscalation,
  submittedAt: unknown,
): Record<string, unknown> {
  const lookupFailed = escalation.member === null || escalation.eventActive === null;
  const escalationEligible = escalation.member === true && escalation.eventActive === true;
  return {
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    ...(report.kind === 'abuse'
      ? {
          ...(lookupFailed ? {} : { reporterInEvent: escalation.member }),
          escalationLookupFailed: lookupFailed,
          escalationEligible,
        }
      : {}),
    description: report.description,
    screenshotPath,
    captureError: report.captureError,
    route: report.route,
    eventId: report.eventId,
    appVersion: report.appVersion,
    browser: report.browser,
    viewport: report.viewport,
    online: report.online,
    reporterHash,
    submittedAt,
    status: 'new',
  };
}

function pendingEscalationDocument(
  report: ValidBugReport,
  uid: string,
  reporterHash: string,
  nowMs: number,
  timestamp: (ms: number) => unknown,
): Record<string, unknown> {
  const deadlineMs = nowMs + BUG_REPORT_ESCALATION_RETRY_WINDOW_MS;
  return {
    state: 'pending',
    eventId: report.eventId,
    reporterUid: uid,
    reporterHash,
    createdAt: timestamp(nowMs),
    nextAttemptAt: timestamp(nowMs),
    attemptCount: 0,
    deadlineAt: timestamp(deadlineMs),
    expiresAt: timestamp(deadlineMs + BUG_REPORT_ESCALATION_PENDING_TTL_MARGIN_MS),
  };
}

function escalationLookupUnknown(report: ValidBugReport, escalation: AbuseEscalation): boolean {
  return report.kind === 'abuse' && (escalation.member === null || escalation.eventActive === null);
}

async function submitLegacyBugReport(
  uid: string,
  report: ValidBugReport,
  deps: BugReportIntakeDependencies,
): Promise<IntakeReceipt> {
  const nowMs = deps.nowMs();
  const reporterHash = createHash('sha256').update(uid).digest('hex').slice(0, 20);
  await chargeLegacyRate(deps.db, reporterHash, nowMs);
  const escalation = report.kind === 'abuse'
    ? await deps.resolveEscalation(deps.db, report.eventId, uid)
    : { member: false, eventActive: false };
  const reportRef = deps.db.collection('bugReports').doc();
  const storagePath = report.screenshot ? `bug-reports/${reporterHash}/${reportRef.id}/screenshot.png` : null;
  const file = storagePath ? deps.file(storagePath) : null;
  if (file && report.screenshot) {
    await file.save(report.screenshot, {
      resumable: false,
      validation: 'crc32c',
      metadata: { contentType: 'image/png', cacheControl: 'private, max-age=0, no-store' },
    });
  }
  try {
    const finalDocument = reportDocument(report, reporterHash, storagePath, escalation, deps.serverTimestamp());
    if (escalationLookupUnknown(report, escalation)) {
      const escalationRef = deps.db.doc(`bugReportEscalations/${reportRef.id}`);
      await deps.db.runTransaction(async (transaction) => {
        transaction.create(reportRef, finalDocument);
        transaction.create(
          escalationRef,
          pendingEscalationDocument(report, uid, reporterHash, nowMs, deps.timestamp),
        );
      });
    } else {
      await reportRef.create(finalDocument);
    }
  } catch (error) {
    if (file) await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    throw error;
  }
  return {
    reportId: reportRef.id,
    escalationEligible: escalation.member === true && escalation.eventActive === true,
  };
}

async function releaseOwnedLease(
  deps: BugReportIntakeDependencies,
  ref: IntakeDocRef,
  expected: Coordination,
  leaseId: string,
): Promise<void> {
  await deps.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const data = verifyCoordination(snapshot.data(), expected);
    if (data.intakeState === 'pending' && data.leaseId === leaseId) {
      transaction.update(ref, { leaseExpiresAt: deps.timestamp(deps.nowMs()) });
    }
  }).catch(() => undefined);
}

async function followSubmission(
  deps: BugReportIntakeDependencies,
  ref: IntakeDocRef,
  expected: Coordination,
): Promise<IntakeReceipt> {
  for (let poll = 0; poll < FOLLOWER_MAX_POLLS; poll += 1) {
    await deps.sleep(FOLLOWER_POLL_MS);
    const data = await verifiedReadback(ref, expected);
    if (data.intakeState === 'complete') return receiptFrom(data, expected.reportId);
    if (data.intakeState !== 'pending') {
      throw new HttpsError('failed-precondition', 'Stored submission has an invalid intake state.');
    }
  }
  throw new HttpsError('unavailable', 'Submission is still being processed. Try again.');
}

export async function submitValidatedBugReport(
  uid: string,
  report: ValidBugReport,
  deps: BugReportIntakeDependencies,
): Promise<IntakeReceipt> {
  if (!report.submissionId) return submitLegacyBugReport(uid, report, deps);

  const nowMs = deps.nowMs();
  const reporterHash = createHash('sha256').update(uid).digest('hex').slice(0, 20);
  const reportId = deriveBugReportId(uid, report.submissionId);
  const hash = deriveBugReportRequestHash(report);
  const expected: Coordination = {
    reportId,
    reporterHash,
    submissionId: report.submissionId,
    requestHashVersion: hash.version,
    requestHash: hash.value,
    report,
  };
  const reportRef = deps.db.collection('bugReports').doc(reportId);
  const rateRef = deps.db.doc(`bugReportRateLimits/${reporterHash}`);
  const leaseId = deps.randomUUID();
  let role: 'owner' | 'follower' | 'complete';

  try {
    role = await deps.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reportRef);
      if (snapshot.exists) {
        const data = verifyCoordination(snapshot.data(), expected);
        if (data.intakeState === 'complete') return 'complete';
        if (data.intakeState !== 'pending' || typeof data.leaseId !== 'string' || timestampMs(data.leaseExpiresAt) === null) {
          throw new HttpsError('failed-precondition', 'Stored submission has invalid coordination state.');
        }
        if ((timestampMs(data.leaseExpiresAt) ?? 0) > nowMs) return 'follower';
        transaction.update(reportRef, { leaseId, leaseExpiresAt: deps.timestamp(nowMs + INTAKE_LEASE_MS) });
        return 'owner';
      }
      const rateSnapshot = await transaction.get(rateRef);
      const rate = nextRateState(rateSnapshot.exists ? rateSnapshot.data() as unknown as RateState : undefined, nowMs);
      transaction.set(rateRef, rate);
      transaction.create(reportRef, {
        submissionId: report.submissionId,
        reporterHash,
        requestHashVersion: hash.version,
        requestHash: hash.value,
        intakeState: 'pending',
        intakeStartedAt: deps.timestamp(nowMs),
        leaseId,
        leaseExpiresAt: deps.timestamp(nowMs + INTAKE_LEASE_MS),
      });
      return 'owner';
    });
  } catch (error) {
    let data: Record<string, unknown>;
    try {
      // A transaction result can be lost after commit. Read back before
      // deciding that this invocation is not the owner: if OUR lease is now
      // durable, continuing is the only path that does not strand it for 60s.
      // The same branch also closes the SDK/emulator ALREADY_EXISTS race.
      data = await verifiedReadback(reportRef, expected);
    } catch (readError) {
      // ALREADY_EXISTS asserts that some document won, so an absent readback is
      // itself an unavailable outcome. A malformed readback always wins over
      // the original error because accepting it would cross submission bounds.
      if (
        isAlreadyExists(error) ||
        (readError instanceof HttpsError && readError.code === 'failed-precondition')
      ) throw readError;
      throw error;
    }
    if (data.intakeState === 'complete') {
      role = 'complete';
    } else if (
      data.intakeState === 'pending' &&
      typeof data.leaseId === 'string' &&
      timestampMs(data.leaseExpiresAt) !== null
    ) {
      role = data.leaseId === leaseId ? 'owner' : 'follower';
    } else {
      throw new HttpsError('failed-precondition', 'Stored submission has invalid coordination state.');
    }
  }

  if (role === 'complete') return receiptFrom(await verifiedReadback(reportRef, expected), reportId);
  if (role === 'follower') return followSubmission(deps, reportRef, expected);

  const storagePath = report.screenshot ? `bug-reports/${reporterHash}/${reportId}/screenshot.png` : null;
  try {
    const escalation = report.kind === 'abuse'
      ? await deps.resolveEscalation(deps.db, report.eventId, uid)
      : { member: false, eventActive: false };
    if (storagePath && report.screenshot) {
      const file = deps.file(storagePath);
      try {
        await file.save(report.screenshot, {
          resumable: false,
          validation: 'crc32c',
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: 'image/png',
            cacheControl: 'private, max-age=0, no-store',
            metadata: { requestHashVersion: String(hash.version), requestHash: hash.value },
          },
        });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (!isAlreadyExists(error) && code !== 412 && code !== '412') throw error;
        const [metadata] = await file.getMetadata();
        const custom = metadata.metadata as Record<string, unknown> | undefined;
        if (custom?.requestHashVersion !== String(hash.version) || custom.requestHash !== hash.value) {
          throw new HttpsError('failed-precondition', 'Stored screenshot does not match this submission.');
        }
      }
    }

    const finalDocument = {
      ...reportDocument(report, reporterHash, storagePath, escalation, deps.serverTimestamp()),
      submissionId: report.submissionId,
      requestHashVersion: hash.version,
      requestHash: hash.value,
      intakeState: 'complete',
    };
    await deps.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reportRef);
      if (!snapshot.exists) throw new HttpsError('failed-precondition', 'Submission reservation disappeared.');
      const data = verifyCoordination(snapshot.data(), expected);
      if (data.intakeState !== 'pending' || data.leaseId !== leaseId) {
        throw new HttpsError('aborted', 'Submission ownership changed. Retry to read the stored outcome.');
      }
      transaction.set(reportRef, finalDocument);
      if (escalationLookupUnknown(report, escalation)) {
        transaction.create(
          deps.db.doc(`bugReportEscalations/${reportId}`),
          pendingEscalationDocument(report, uid, reporterHash, nowMs, deps.timestamp),
        );
      }
    });
    return receiptFrom(finalDocument, reportId);
  } catch (error) {
    try {
      const data = await verifiedReadback(reportRef, expected);
      if (data.intakeState === 'complete') return receiptFrom(data, reportId);
    } catch (readError) {
      if (readError instanceof HttpsError && readError.code === 'failed-precondition') throw readError;
    }
    await releaseOwnedLease(deps, reportRef, expected, leaseId);
    throw error;
  }
}

/** The minimal Firestore surface the participation check needs, so it can be
 *  exercised without an Admin SDK. */
export interface ReporterLookupFirestore {
  doc(path: string): { get(): Promise<{ exists?: boolean; data(): Record<string, unknown> | undefined }> };
}

/** How many times the escalation lookup is tried before it becomes durable
 *  UNKNOWN work. Back-to-back retries still resolve the cheapest transient
 *  blips without waiting for the scheduled sweep. */
export const ESCALATION_LOOKUP_ATTEMPTS = 3;

/** Both halves of the question "will this abuse report actually reach an admin?".
 *  They are separate fields because they are persisted and reported differently:
 *  membership is stored for the trigger to gate on, while activeness is only a
 *  prediction the receipt uses — the trigger re-checks it at enqueue time. */
export interface AbuseEscalation {
  /** Does the reporter belong to the Event they named? `null` when the lookup
   *  could not be completed — NOT `false`, because "we could not check" and "we
   *  checked and they do not" are different facts and only one of them is an
   *  authorization decision (Phase 4b P2). Persisted as `reporterInEvent` only
   *  when it is a real answer; `abuseAlertsForWrite` requires `true`, so an
   *  absent field still fails closed. */
  member: boolean | null;
  /** Is the Event one the digest sweep will actually visit? `null` when the
   *  lookup could not be completed. */
  eventActive: boolean | null;
}

/**
 * Will this abuse report escalate — and if not, which half failed?
 *
 * WHY MEMBERSHIP IS CHECKED AT ALL (#670, Codex P2). `eventId` is
 * CLIENT-SUPPLIED. That was harmless while it was only a label on an inbox row,
 * but an abuse report mails the named Event's admins — so the field stopped
 * being a label and became a DELIVERY ADDRESS. Nothing else in the flow stops a
 * signed-in player naming somebody else's Event and routing arbitrary text into
 * its digest; the rate limit caps the volume and does nothing about the
 * direction. A player document is the membership record
 * (`events/{eventId}/players/{uid}` is written when they join); an Event ADMIN
 * who never dealt a board has no such document but is plainly authorized, so the
 * roster answers first and saves the second read when it does.
 *
 * WHY ACTIVENESS IS CHECKED HERE TOO (Codex P2, round 5). `recordBugReportAlerts`
 * refuses to enqueue against a non-active Event, matching the sweep's own
 * precondition — so a member reporting against an ARCHIVED Event escalates to
 * nobody. Reporting success on the strength of membership alone would put the
 * sheet right back to telling somebody their report reached the admins when it
 * did not, which is the failure the receipt exists to prevent. The Event document is
 * read either way, so this costs nothing.
 *
 * It stays a PREDICTION rather than a guarantee: the Event could be archived
 * between this read and the trigger, and the trigger — not this — is the
 * authority on what was queued. It is the best answer available at the moment
 * the reporter is looking at the screen.
 *
 * FAILS CLOSED on both halves. An unreadable answer is not membership: the wrong
 * direction is mailing an Event's admins on the say-so of somebody who has no
 * relationship with it, and claiming a delivery that did not happen.
 */
export async function resolveAbuseEscalation(
  db: ReporterLookupFirestore,
  eventId: string,
  uid: string,
  attempts = ESCALATION_LOOKUP_ATTEMPTS,
): Promise<AbuseEscalation> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const event = (await db.doc(`events/${eventId}`).get()).data();
      const eventActive = event?.status === 'active';
      const admins = event?.admins;
      if (Array.isArray(admins) && admins.includes(uid)) return { member: true, eventActive };
      const player = await db.doc(`events/${eventId}/players/${uid}`).get();
      return { member: player.exists ?? player.data() !== undefined, eventActive };
    } catch (error) {
      lastError = error;
    }
  }
  // Every attempt failed, so the honest answer is "unknown" — NOT "no".
  //
  // Recording a backend failure as `reporterInEvent: false` made an
  // infrastructure problem indistinguishable from a confirmed non-member, which
  // is both wrong and unrecoverable: nothing downstream could tell that the
  // question had never actually been answered (Phase 4b P2). Back-to-back
  // retries help with a blip and do nothing during an outage.
  //
  // `null` propagates instead. The caller persists `escalationLookupFailed: true`
  // and writes NO `reporterInEvent` at all, so no authorization decision is
  // recorded, the trigger still fails closed (it requires a literal `true`), and
  // the export can show an operator the difference. Failing closed remains the
  // right direction — failing open would make an outage a window for routing
  // text into another Event's digest.
  console.error(
    `submitBugReport: escalation check failed after ${Math.max(1, attempts)} attempt(s); recording as unknown`,
    eventId,
    { code: firestoreErrorCodeForLog(lastError) },
  );
  return { member: null, eventActive: null };
}

function productionIntakeDependencies(): BugReportIntakeDependencies {
  const db = getFirestore() as unknown as IntakeFirestore;
  return {
    db,
    file: (path) => getStorage().bucket().file(path) as unknown as IntakeFile,
    nowMs: () => Date.now(),
    randomUUID: () => nodeRandomUUID(),
    timestamp: (ms) => new Date(ms),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    sleep: async (ms) => await new Promise<void>((resolve) => setTimeout(resolve, ms)),
    resolveEscalation: resolveAbuseEscalation,
  };
}

export async function handleSubmitBugReport(
  request: CallableRequest<unknown>,
  requireAppCheck: boolean,
  deps: BugReportIntakeDependencies = productionIntakeDependencies(),
): Promise<{ reportId: string; escalationEligible: boolean }> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before reporting a bug.');
  if (requireAppCheck && !request.app) throw new HttpsError('failed-precondition', 'App Check is required.');
  try {
    const report = validateBugReportInput(request.data);
    return await submitValidatedBugReport(uid, report, deps);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error instanceof BugReportInputError) throw new HttpsError(error.code, error.message);
    throw error;
  }
}
