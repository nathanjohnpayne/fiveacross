/**
 * Admin notification alerts — the QUEUE and the digest sweep (issue #638,
 * specs/admin-notification-emails.md).
 *
 * Admins need to hear about two things without opening the console: a community
 * Prompt has landed needing approval, and content has been reported or hidden.
 * Both are BURSTY by nature — a pool import writes eighty pending Prompts in a
 * second, and a pile-on can report the same Proof five times in a minute — so
 * the delivery shape is a QUEUE plus a periodic digest, never an email per
 * write. That is the whole reason this module exists as something other than a
 * second call to `sendEmail`:
 *
 *   PRODUCERS are the existing `events/{eventId}/{items,proofs}/{id}` triggers.
 *   They stay cheap and synchronous — `alertsForWrite` is a PURE function of the
 *   before/after snapshots, with no reads — and they only APPEND to
 *   `events/{eventId}/adminAlerts`.
 *
 *   The CONSUMER is `sendAdminDigestForEvent`, driven by a scheduled sweep. It
 *   reads the Event once, resolves the admin roster once, renders ONE email
 *   covering everything queued since the last drain, and replaces each drained
 *   row with a payload-free tombstone.
 *
 * So eighty seeded Prompts produce one email listing eighty, and the acceptance
 * criterion "seeding/imports produce at most one digest" holds structurally
 * rather than by a debounce timer someone can tune wrong.
 *
 * WHY THE FACTS ARE STORED RAW. An alert carries the doc's `status`,
 * `visionFlag` and `reportCount`, not a rendered sentence. Labelling a hide as
 * "reports >= threshold" versus "by an admin" needs the Event's
 * `settings.reportHideThreshold`, and reading it in the trigger would cost one
 * Firestore read per moderated write for a string nobody reads until the digest
 * goes out. The digest reads the Event once and calls `deriveReason` there.
 *
 * Best-effort throughout (ADR 0001): an enqueue failure is logged and swallowed
 * so it can never block the moderation write that triggered it, and one Event
 * or one send failing never crashes the sweep. The Firestore/roster/send
 * dependencies are injected, so the whole flow is unit-testable without a
 * Functions runtime (mirrors `dailyEmail.ts` and `autohide.ts`).
 */
import { createHash } from 'node:crypto';
import { resolveAdminEmails, type ResolveDeps } from './notify';
import { resolveEmailFrom, resolveEventOrigin } from './dailyEmail';
import { firestoreErrorCodeForLog, isAlreadyExists } from './firestoreErrors';
import {
  BUG_REPORT_ESCALATION_PENDING_TTL_MARGIN_MS,
  BUG_REPORT_ESCALATION_RETRY_WINDOW_MS,
} from './bugReports';
import {
  buildAdminDigestModel,
  renderAdminDigestHtml,
  renderAdminDigestText,
  type AdminAlertRecord,
  type DigestEvent,
} from './adminAlertDigest';
import type { sendEmail } from './email';

// --- Minimal admin-SDK Firestore surface ----------------------------------------

interface AlertSnapshot {
  readonly id: string;
  data(): Record<string, unknown> | undefined;
}
interface AlertDocRef {
  get(): Promise<{ data(): Record<string, unknown> | undefined }>;
  /** Unconditional write — used only to FREEZE a batch's outbound request. */
  set(data: Record<string, unknown>): Promise<unknown>;
  /** Admin-SDK `DocumentReference.create` — writes ONLY if the document does
   *  not exist, rejecting with ALREADY_EXISTS otherwise. Load-bearing for the
   *  immutable frozen request: two senders can render, but only one byte-for-
   *  byte request wins the batch id. */
  create(data: Record<string, unknown>): Promise<unknown>;
}
interface AlertQuery {
  where(field: string, op: string, value: unknown): AlertQuery;
  orderBy(field: string): AlertQuery;
  limit(count: number): AlertQuery;
  get(): Promise<{ docs: AlertSnapshot[] }>;
}
/** The minimal atomic-write surface the drain needs. An admin-SDK `WriteBatch`
 *  commits all-or-nothing, which is the whole reason the drain uses one. `set`
 *  WITHOUT merge, so the tombstone REPLACES the row rather than joining it. */
interface AlertWriteBatch {
  set(ref: AlertDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): void;
  delete(ref: AlertDocRef): void;
  commit(): Promise<unknown>;
}
/** The minimal transaction surface the exclusive claim needs. Mirrors the
 *  admin-SDK `Transaction`: reads inside it are serialized against concurrent
 *  writers, and the whole function re-runs on contention — which is what turns
 *  "check then claim" into one indivisible step. */
interface AlertTransaction {
  get(ref: AlertDocRef): Promise<{ data(): Record<string, unknown> | undefined }>;
  set(ref: AlertDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): void;
  delete(ref: AlertDocRef): void;
}
/** The minimal surface the queue and its sweep use. */
export interface AdminAlertFirestore {
  doc(path: string): AlertDocRef;
  collection(path: string): AlertQuery;
  batch(): AlertWriteBatch;
  runTransaction<T>(updateFunction: (tx: AlertTransaction) => Promise<T>): Promise<T>;
}

// --- The alert vocabulary --------------------------------------------------------

/**
 * What kind of admin attention an alert asks for. Deliberately three, not one
 * per producer: the digest groups by kind, and a reader scanning the email is
 * asking "what do I have to DO", not "which trigger fired".
 */
export type AdminAlertKind =
  /** A community Prompt landed `pending` and is waiting for approve/reject. */
  | 'item-created'
  /** Somebody reported this content — `reportCount` rose on this write. */
  | 'content-reported'
  /** The server moved this content into a moderation state (flagged/hidden). */
  | 'moderation'
  /** A reporter filed a bug report and marked it `abuse` (#670). Unlike the
   *  three above this is not a state a document is IN — it is a submission that
   *  happened — which is why it needs its own liveness rule and its own digest
   *  module rather than joining "Reported & hidden". */
  | 'abuse-reported';

/** The collections that live UNDER an Event, at `events/{eventId}/{collection}`.
 *  Everything the moderation producers touch, and the only paths the digest can
 *  re-read a row's live state from. */
export type EventScopedCollection = 'items' | 'proofs';

/** Every collection an alert can be about. `bugReports` is the odd one: a
 *  TOP-LEVEL collection carrying an `eventId` FIELD, so an alert about it is
 *  scoped to an Event without living inside one. */
export type AlertedCollection = EventScopedCollection | 'bugReports';

const EVENT_SCOPED: readonly AlertedCollection[] = ['items', 'proofs'];

/** Whether this collection can be re-read at `events/{eventId}/{collection}/{id}`.
 *  The digest asks before it spends a read — and before it lets `currentRowFor`
 *  interpret an absent document as "deleted since it was queued". */
export function isEventScoped(collection: AlertedCollection): collection is EventScopedCollection {
  return EVENT_SCOPED.includes(collection);
}

/** Where a row's live document ACTUALLY lives, which is the whole reason this
 *  function exists rather than an inline template: an Event-scoped collection
 *  nests under the Event, and `bugReports` is top-level. Reading a top-level
 *  report at the nested path would find nothing and read as "deleted". */
export function livePathFor(eventId: string, collection: AlertedCollection, docId: string): string {
  return isEventScoped(collection) ? `events/${eventId}/${collection}/${docId}` : `${collection}/${docId}`;
}

/** The subset of a Prompt/Proof doc the producers read. Everything is optional
 *  because this reads RAW Firestore snapshots with no converter. */
export interface AlertableDoc {
  status?: string;
  visionFlag?: string | null;
  reportCount?: number;
  /** A Prompt's own words — the only human-readable label an item carries. */
  text?: string;
  /** A Proof's Prompt text, denormalized onto the proof (`ProofDoc.itemText`). */
  itemText?: string;
}

/** One queued alert, before it is written. `createdAt`/`sentAt` are added by
 *  `enqueueAdminAlerts`, which owns the clock. */
export interface AdminAlertDraft {
  kind: AdminAlertKind;
  collection: AlertedCollection;
  docId: string;
  /** Human subject line for the row: the Prompt's words, else the doc id. */
  label: string;
  /** The doc's moderation state at the moment of the write — labelled at
   *  digest time by `deriveReason`, not here. */
  status: string;
  visionFlag: string | null;
  reportCount: number;
}

/** The one queue-row constructor shared by every producer. Its expiry is a
 *  Date because Firestore TTL ignores numeric fields. */
export function pendingAdminAlertRow(draft: AdminAlertDraft, now: number): Record<string, unknown> {
  return {
    ...draft,
    createdAt: now,
    sentAt: null,
    expiresAt: new Date(now + PENDING_TTL_MS),
  };
}

/** How long a Prompt's words may run in a digest row before they are clipped.
 *  `ItemDoc.text` is already clamped to 80 characters at every write path, so
 *  this only ever bites on legacy or hand-seeded data. */
export const LABEL_MAX = 80;

/**
 * Flatten a label to a single line before it is stored or rendered.
 *
 * HTML escaping is not enough here, because the digest also ships a plain-text
 * part and that part has no escaping — its structure IS its punctuation. A
 * Prompt is user-submitted and the item-create rule only requires a non-empty
 * string of at most 80 characters, so a newline inside one lets an unapproved
 * submission emit unprefixed lines into the text alternative that imitate a
 * section heading or the CTA line, complete with a URL the client auto-links.
 * The HTML consumer would still see one tidy escaped row, which is precisely
 * what makes it easy to miss.
 *
 * So every C0 control character (and the DEL) collapses to a space, and runs of
 * whitespace collapse with them. Applied at BOTH boundaries — when the producer
 * writes the label and when the digest reads it back — so a row queued before
 * this existed is flattened too.
 */
export function flattenLabel(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Flatten, clip, and fall back — the one place a row's human subject line is
 *  derived, whatever kind of document it came from.
 *
 *  `unknown`, not `string | undefined`, because every caller feeds it a field
 *  read straight off a RAW Firestore snapshot with no converter. A hand-written,
 *  migrated or admin-written document can hold a number or an object there, and
 *  handing that to `flattenLabel`'s `.replace` throws — which, on the retryable
 *  abuse trigger, means one malformed document redelivered forever (Phase 4b
 *  P2). A non-string is simply not a label, so it takes the fallback. */
function clipLabel(text: unknown, fallback: string): string {
  const trimmed = flattenLabel(typeof text === 'string' ? text : '');
  if (!trimmed) return fallback;
  return trimmed.length > LABEL_MAX ? `${trimmed.slice(0, LABEL_MAX - 1)}…` : trimmed;
}

function labelFor(collection: EventScopedCollection, docId: string, doc: AlertableDoc): string {
  return clipLabel(collection === 'items' ? doc.text : doc.itemText, docId);
}

const MODERATION_STATES = ['flagged', 'hidden'];

/**
 * Pure: every alert THIS write earns, in the order a reader would want them.
 * Returns `[]` for the overwhelming majority of writes, which is what keeps the
 * producers cheap enough to sit on a hot trigger path.
 *
 * Three independent signals, and a single write can legitimately raise more
 * than one (an admin who hides an already-reported Prompt in one update):
 *
 *   - `item-created` — a Prompt is CURRENTLY `pending` and was not before. That
 *     is exactly the community-submission signal: `addItem` (the player path)
 *     writes `status: 'pending'`, while `adminAddItem` and every seed write
 *     `'active'`, so an admin adding their own Prompt correctly notifies
 *     nobody. It is also #533-proof — community Prompts will land in the same
 *     `pending` state, so this predicate does not change when they ship. Items
 *     only; a Proof has no approval queue.
 *   - `content-reported` — `reportCount` strictly ROSE. `reportItem`/
 *     `reportProof` increment it, so this is the explicit report action.
 *     Deliberately not a bare `reportCount > 0`: an admin Clear-reports (to 0)
 *     is not a rise, and neither is a restore, which leaves the count alone.
 *   - `moderation` — `status` CHANGED into `flagged`/`hidden`. The same
 *     transition `notify.ts`'s `shouldNotify` has always covered: Cloud Vision
 *     flagging a Proof, the threshold auto-hide (#43), and a manual admin hide.
 *
 * A DELETE (`after` undefined) earns nothing: there is nothing left to review.
 */
export function alertsForWrite(
  collection: EventScopedCollection,
  docId: string,
  before: AlertableDoc | undefined,
  after: AlertableDoc | undefined,
): AdminAlertDraft[] {
  if (!after) return [];
  const base = {
    collection,
    docId,
    label: labelFor(collection, docId, after),
    status: after.status ?? 'unknown',
    visionFlag: typeof after.visionFlag === 'string' && after.visionFlag ? after.visionFlag : null,
    reportCount: typeof after.reportCount === 'number' ? after.reportCount : 0,
  };
  const drafts: AdminAlertDraft[] = [];

  if (collection === 'items' && after.status === 'pending' && before?.status !== 'pending') {
    drafts.push({ kind: 'item-created', ...base });
  }

  const beforeCount = typeof before?.reportCount === 'number' ? before.reportCount : 0;
  if (base.reportCount > beforeCount) {
    drafts.push({ kind: 'content-reported', ...base });
  }

  if (before?.status !== after.status && MODERATION_STATES.includes(base.status)) {
    drafts.push({ kind: 'moderation', ...base });
  }

  return drafts;
}

// --- Producing (the trigger seam) ------------------------------------------------

export interface EnqueueDeps {
  /** Injectable clock, so a test can assert `createdAt` without freezing time. */
  now?: () => number;
  /**
   * Let a write failure ESCAPE instead of being logged and swallowed.
   *
   * Off by default, because the moderation producers ride a hot content-write
   * path and ADR 0001 says a queue failure must never fail the write that
   * triggered it — and their triggers are not retryable, so throwing would only
   * trade a log line for a louder log line.
   *
   * `notifyAbuseBugReport` opts IN, because its situation is the opposite on
   * both counts: it writes nothing but the queue row, so there is no other write
   * to protect, and it is declared `retry: true`. Swallowing there converts a
   * transient Firestore blip into a permanently lost report of harm, while
   * throwing hands the platform something it can retry — safely, because the
   * alert ids are deterministic and the enqueue transaction never overwrites
   * an existing row or tombstone.
   */
  rethrowWriteErrors?: boolean;
}

/**
 * A queue document id derived from the triggering write, NOT a random one.
 *
 * Firestore redelivers a document-write event on retry, and the retry carries
 * the SAME CloudEvent id. A random-id `add` would therefore mint a second alert
 * for one transition — appearing as a duplicate row before a drain, and, if the
 * redelivery lands after one, as a whole second email whose set (and therefore
 * whose Resend key) differs from the first. That is the same guarantee #101
 * bought by folding the CloudEvent id into its idempotency key, kept here.
 *
 * The kind is part of the id because one write can legitimately earn more than
 * one alert. The sanitizer is belt-and-braces: real CloudEvent ids are already
 * id-safe, but a `/` reaching a document id would silently reparent the write.
 */
export function alertDocId(transitionId: string, kind: AdminAlertKind): string {
  const safe = (transitionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
  return `${safe}-${kind}`;
}

/**
 * Append this write's alerts to the Event's queue. Best-effort by default and
 * NEVER throws (ADR 0001): a queue write failing must not fail the moderation
 * write that triggered it, exactly as the #101 notifier's mail failure never
 * did. Returns how many alerts it wrote. A caller whose trigger is retryable can
 * opt into propagation with `rethrowWriteErrors`.
 *
 * The Event and deterministic row are read in one transaction; a row is set
 * only when absent. That serializes enqueue against archive and makes a
 * redelivered trigger a no-op without overwriting a delivered or discarded
 * tombstone.
 *
 * `sentAt: null` is written EXPLICITLY rather than left absent, because the
 * sweep finds work with `where('sentAt', '==', null)` and Firestore's equality
 * filter matches a stored null but not a missing field — an alert without the
 * field would sit in the collection forever, invisible to the drain.
 *
 * EVERY ROW CARRIES AN `expiresAt` FROM THE MOMENT IT IS WRITTEN, not only once
 * it is tombstoned. A queue row holds a COPY of user content — a pending
 * Prompt's words, a hidden Proof's text, an abuse reporter's description — and
 * until this existed that copy had exactly one exit: being drained. Archive
 * settlement now deliberately discards uncommitted work, and TTL remains the
 * final retention bound if both the lifecycle trigger and scheduled backstop
 * cannot complete. `PENDING_TTL_MS` is generous enough that no ordinary backlog
 * is ever reaped — orders of magnitude past the five-minute sweep, and
 * comfortably inside the source-report retention window — so it only ever
 * collects rows that were genuinely stranded. Settlement REPLACES the document,
 * so a terminal row's shorter tombstone expiry supersedes this one rather than
 * competing with it.
 */
export async function enqueueAdminAlerts(
  db: AdminAlertFirestore,
  eventId: string,
  drafts: readonly AdminAlertDraft[],
  transitionId: string,
  deps: EnqueueDeps = {},
): Promise<number> {
  if (drafts.length === 0) return 0;
  const createdAt = (deps.now ?? Date.now)();
  try {
    return await db.runTransaction(async (tx) => {
      // The Event read and deterministic queue writes serialize with archive.
      // Archive-first means no row is created; enqueue-first means archive
      // settlement sees the committed row. There is no post-check write gap.
      const event = (await tx.get(db.doc(`events/${eventId}`))).data();
      if (event?.status !== 'active') return 0;

      const rows = drafts.map((draft) => ({
        draft,
        ref: db.doc(`events/${eventId}/adminAlerts/${alertDocId(transitionId, draft.kind)}`),
      }));
      const existing = await Promise.all(rows.map(({ ref }) => tx.get(ref)));
      let written = 0;
      rows.forEach(({ draft, ref }, index) => {
        // Redelivery, a delivered tombstone, and a discard tombstone all keep
        // the deterministic id. Never overwrite any of them.
        if (existing[index].data() !== undefined) return;
        tx.set(ref, pendingAdminAlertRow(draft, createdAt));
        written++;
      });
      return written;
    });
  } catch (err) {
    console.error('enqueueAdminAlerts: transaction failed', eventId, err);
    // Only a failure a retry could actually fix escapes. A permanent one is
    // logged and acknowledged, because redelivering it forever helps nobody.
    if (deps.rethrowWriteErrors && isRetryableFirestoreError(err)) throw err;
    return 0;
  }
}

/**
 * Is this failure worth retrying, or will it fail identically forever?
 *
 * A retryable trigger that rethrows EVERYTHING turns a permanent misconfiguration
 * — a service account without Firestore access, an invalid argument — into an
 * Eventarc redelivery loop that can never succeed, burning quota and burying the
 * real error in noise (Phase 4b P2). These are the gRPC statuses that mean "the
 * request itself is wrong", so retrying is pointless:
 *
 *   3 INVALID_ARGUMENT · 5 NOT_FOUND · 6 ALREADY_EXISTS · 7 PERMISSION_DENIED ·
 *   9 FAILED_PRECONDITION · 11 OUT_OF_RANGE · 12 UNIMPLEMENTED · 16 UNAUTHENTICATED
 *
 * Everything else — UNAVAILABLE, DEADLINE_EXCEEDED, ABORTED, INTERNAL, and any
 * code this does not recognise — is treated as retryable. The default leans that
 * way deliberately: retrying something permanent wastes invocations, while
 * acknowledging something transient silently loses a report of harm.
 */
const PERMANENT_STATUS_CODES = new Set([3, 5, 6, 7, 9, 11, 12, 16]);
const PERMANENT_STATUS_NAMES = new Set([
  'invalid-argument',
  'not-found',
  'already-exists',
  'permission-denied',
  'failed-precondition',
  'out-of-range',
  'unimplemented',
  'unauthenticated',
]);

export function isRetryableFirestoreError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'number') return !PERMANENT_STATUS_CODES.has(code);
  if (typeof code === 'string') return !PERMANENT_STATUS_NAMES.has(code.toLowerCase());
  return true;
}

/** The whole producer side in one call — the shape `index.ts`'s trigger seams
 *  use, so the seam stays three lines and the decision stays testable here.
 *  `transitionId` is the triggering write's CloudEvent id (#101 Codex F3),
 *  which makes a redelivered trigger idempotent rather than duplicative. */
export async function recordAdminAlerts(
  db: AdminAlertFirestore,
  collection: EventScopedCollection,
  eventId: string,
  docId: string,
  transitionId: string,
  before: AlertableDoc | undefined,
  after: AlertableDoc | undefined,
  deps: EnqueueDeps = {},
): Promise<number> {
  try {
    return await enqueueAdminAlerts(
      db,
      eventId,
      alertsForWrite(collection, docId, before, after),
      transitionId,
      deps,
    );
  } catch (err) {
    console.error('recordAdminAlerts failed', eventId, collection, docId, err);
    return 0;
  }
}

// --- Producing: abuse-marked bug reports (#670) ----------------------------------

/** The subset of a `bugReports/{reportId}` document the abuse producer reads.
 *  Everything is optional because this reads a RAW Firestore snapshot with no
 *  converter — and because a report written before #670 has no `kind` at all. */
export interface BugReportDoc {
  /** `'abuse'` or `'bug'`, normalised at intake by `bugReportContract.cjs`. */
  kind?: string;
  /** The reporter's own words — the only human-readable label a report has. */
  description?: string;
  /** The Event the report was filed from. `bugReports` is TOP-LEVEL, so this
   *  field is the ONLY link between a report and an Event's alert queue — and it
   *  is CLIENT-SUPPLIED, which is why `reporterInEvent` exists. */
  eventId?: string;
  /** Server-resolved at intake (`reporterBelongsToEvent`): did this reporter
   *  actually belong to the Event they named? Written only on abuse reports, so
   *  its presence means "checked" rather than "defaulted". */
  reporterInEvent?: boolean;
  escalationLookupFailed?: boolean;
  escalationEligible?: boolean;
  status?: string;
  intakeState?: string;
  submissionId?: string;
  reporterHash?: string;
  requestHashVersion?: number;
  requestHash?: string;
}

const BUG_REPORT_COORDINATION_KEYS: Array<keyof BugReportDoc> = [
  'submissionId',
  'reporterHash',
  'requestHashVersion',
  'requestHash',
];
const BUG_REPORT_IDEMPOTENCY_KEYS: Array<keyof BugReportDoc> = [
  'submissionId',
  'requestHashVersion',
  'requestHash',
];

function validCompleteBugReportCoordination(reportId: string, report: BugReportDoc): boolean {
  return (
    report.intakeState === 'complete' &&
    /^[a-f0-9]{64}$/.test(reportId) &&
    typeof report.submissionId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(report.submissionId) &&
    typeof report.reporterHash === 'string' && /^[a-f0-9]{20}$/.test(report.reporterHash) &&
    report.requestHashVersion === 1 &&
    typeof report.requestHash === 'string' && /^[a-f0-9]{64}$/.test(report.requestHash)
  );
}

function validLegacyBugReportCoordination(report: BugReportDoc): boolean {
  return report.intakeState === undefined && BUG_REPORT_IDEMPOTENCY_KEYS.every((key) => report[key] === undefined);
}

/** Validate and sanitize the report-derived portion of an abuse queue row. */
export function abuseAlertDraft(reportId: string, report: BugReportDoc | undefined): AdminAlertDraft | null {
  if (!report || report.kind !== 'abuse') return null;
  return {
    kind: 'abuse-reported',
    collection: 'bugReports',
    docId: reportId,
    label: clipLabel(report.description, reportId),
    status: typeof report.status === 'string' && report.status ? report.status : 'new',
    visionFlag: null,
    reportCount: 0,
  };
}

/** The intake contract's own `eventId` shape (`bugReportContract.cjs`), restated
 *  here because this reads STORED documents rather than a live payload: a report
 *  written by hand, by a migration, or by an older contract has not been through
 *  that validator, and an id with a `/` in it would silently reparent the queue
 *  write. */
const EVENT_ID_SHAPE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Pure: the alerts one `bugReports/{reportId}` write earns.
 *
 * Idempotent intake first creates a coordination-only PENDING document. Its one
 * semantic creation event is the matching PENDING-to-COMPLETE replacement; the
 * staging create and later COMPLETE updates are silent. Legacy documents carry
 * no `intakeState` and retain their one absent-before abuse-create signal.
 *
 * A plain `bug` earns nothing, which is the entire point of the field — the
 * inbox is where bugs are answered, and mailing an admin about each one would
 * make the digest useless for the reports that need eyes now.
 *
 * A DELETE (`after` undefined) earns nothing, matching `alertsForWrite`.
 *
 * AND THE REPORTER HAS TO BELONG TO THE EVENT. `eventId` is client-supplied, so
 * without this an authenticated player could name any Event in the project and
 * route arbitrary text into ITS admins' digest — the rate limit caps how much,
 * not who it reaches. `reporterInEvent` is resolved at intake by
 * `reporterBelongsToEvent` (the only point in the flow that still has the uid;
 * by the time this runs the document carries an unresolvable `reporterHash`),
 * and it is compared STRICTLY to `true`: an absent field, a `'true'` string, or
 * a hand-written document that never went through intake all fail closed.
 */
export function abuseAlertsForWrite(
  reportId: string,
  before: BugReportDoc | undefined,
  after: BugReportDoc | undefined,
): AdminAlertDraft[] {
  if (!after) return [];
  const hasIntakeState = before?.intakeState !== undefined || after.intakeState !== undefined;
  if (hasIntakeState) {
    if (!before || before.intakeState !== 'pending' || after.intakeState !== 'complete') return [];
    if (BUG_REPORT_COORDINATION_KEYS.some((key) => before[key] === undefined || before[key] !== after[key])) return [];
    if (!validCompleteBugReportCoordination(reportId, after)) return [];
  } else if (before) {
    return [];
  } else if (!validLegacyBugReportCoordination(after)) {
    // The only state-less shape is a report written by the legacy intake,
    // which predates idempotency fields but already carries reporterHash. A
    // partially migrated idempotency row must not borrow that compatibility
    // path and manufacture an alert.
    return [];
  }
  if (after.kind !== 'abuse') return [];
  if (after.reporterInEvent !== true) return [];
  const draft = abuseAlertDraft(reportId, after);
  return draft ? [draft] : [];
}

/**
 * The Event an abuse report belongs to, or `null` when there is none to trust.
 *
 * `bugReports` is a TOP-LEVEL collection with an `eventId` field, while the
 * queue is `events/{eventId}/adminAlerts` — so the Event is READ OFF THE
 * DOCUMENT and never guessed. A report with no usable `eventId` is not filed
 * against some default Event, because "some default Event" would put a
 * stranger's abuse report in front of the wrong Event's admins.
 */
export function bugReportEventId(after: BugReportDoc | undefined): string | null {
  const eventId = typeof after?.eventId === 'string' ? after.eventId.trim() : '';
  return EVENT_ID_SHAPE.test(eventId) ? eventId : null;
}

/**
 * The whole abuse producer in one call — the shape `index.ts`'s
 * `notifyAbuseBugReport` trigger uses.
 *
 * NOT best-effort, unlike `recordAdminAlerts`, and the difference is deliberate.
 * That one guards a moderation write (ADR 0001: the queue must never fail the
 * content write that triggered it). This trigger writes nothing else — enqueuing
 * IS its whole job — so there is no other write to protect, and swallowing a
 * transient failure just loses the alert forever.
 *
 * THE EVENT MUST EXIST AND BE ACTIVE, and that read is not defensive
 * boilerplate. The sweep (`runAdminAlertSweep`) finds work with
 * `where('status', '==', 'active')`, so this precondition is written to match
 * the drain's precondition EXACTLY. A queue row under an `eventId` that resolves
 * to no Event — or to an archived one that may never be reactivated — would
 * never be visited, never drained and never tombstoned: an orphaned copy of a
 * report's text sitting in Firestore forever, which is precisely the retention
 * outcome the tombstone design exists to avoid. One read per ABUSE report (never
 * per bug: the predicate above runs first) is a cheap price for that.
 *
 * The archived case is genuinely reachable in a way it is not for the moderation
 * producers: those fire on writes to an Event's own content, which stops when
 * the Event does, while a player can open the app and file a report against an
 * Event long after it was archived. The report still lands in the inbox; nobody
 * is mailed about an Event that is over.
 *
 * A read that FAILS is treated as unresolvable rather than assumed-present. The
 * asymmetry with `currentRowFor`'s fail-open is deliberate: there, failing open
 * keeps an alert the admins should see; here, failing open would MINT one at a
 * path that may not exist. The report itself is already durably stored and
 * pullable through `npm run bugs:pull` either way, so the lost thing is a digest
 * row, not the report.
 */
export async function recordBugReportAlerts(
  db: AdminAlertFirestore,
  reportId: string,
  transitionId: string,
  before: BugReportDoc | undefined,
  after: BugReportDoc | undefined,
  deps: EnqueueDeps = {},
): Promise<number> {
  // EVERY EARLY RETURN BELOW IS A PERMANENT ANSWER, and every THROW is a
  // transient one. That split is the whole contract with `notifyAbuseBugReport`,
  // which is declared `retry: true` (Phase 4b P1).
  //
  // Returning 0 tells the platform "handled, do not retry", and it is correct
  // for the cases below because retrying changes nothing about them: the write
  // was not an abuse transition, the document names no usable Event, or it names
  // one that does not exist or is not active. Those are properties of the data.
  //
  // A failed READ or a failed WRITE is the opposite: nothing about the report is
  // wrong, Firestore was briefly unavailable, and the previous version of this
  // function swallowed exactly that into a silent, permanent loss of a report of
  // harm. Those now escape so the platform retries them, which is safe because
  // the alert id is derived from the CloudEvent id — a retry that lands after a
  // write already succeeded finds that deterministic row and is a no-op, never
  // a duplicate row.
  const drafts = abuseAlertsForWrite(reportId, before, after);
  if (drafts.length === 0) return 0;
  const eventId = bugReportEventId(after);
  if (!eventId) {
    console.error('recordBugReportAlerts: abuse report carries no usable eventId', reportId);
    return 0;
  }
  // A read failure PROPAGATES when a retry could fix it, and is acknowledged
  // when it could not — a permission error on this path will fail identically on
  // every redelivery, so looping on it only buries the real cause.
  let event: Record<string, unknown> | undefined;
  try {
    event = (await db.doc(`events/${eventId}`).get()).data();
  } catch (err) {
    if (isRetryableFirestoreError(err)) throw err;
    console.error('recordBugReportAlerts: permanent event-read failure; not retrying', eventId, reportId, err);
    return 0;
  }
  if (!event) {
    console.error('recordBugReportAlerts: abuse report names an unresolvable event', eventId, reportId);
    return 0;
  }
  if (event.status !== 'active') {
    console.log('recordBugReportAlerts: abuse report names a non-active event; not queueing', eventId, reportId);
    return 0;
  }
  return await enqueueAdminAlerts(db, eventId, drafts, transitionId, {
    ...deps,
    rethrowWriteErrors: true,
  });
}

// --- Durable abuse escalation ---------------------------------------------------

export const MAX_ABUSE_ESCALATIONS_PER_SWEEP = 50;
const ABUSE_ESCALATION_BACKOFF_BASE_MS = 5 * 60 * 1_000;
const ABUSE_ESCALATION_BACKOFF_MAX_MS = 6 * 60 * 60 * 1_000;

export type AbuseEscalationOutcome =
  | 'queued'
  | 'source-invalid'
  | 'alert-conflict'
  | 'event-missing'
  | 'event-inactive'
  | 'not-member'
  | 'retry-window-expired';

export interface AbuseEscalationSweepDeps {
  now?: () => number;
}

function firestoreTimeMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: unknown } | null)?.toMillis;
  if (typeof toMillis !== 'function') return null;
  const millis = toMillis.call(value);
  return typeof millis === 'number' && Number.isFinite(millis) ? millis : null;
}

function terminalEscalation(outcome: AbuseEscalationOutcome, now: number): Record<string, unknown> {
  return {
    state: 'terminal',
    outcome,
    resolvedAt: new Date(now),
    expiresAt: new Date(now + TOMBSTONE_TTL_MS),
  };
}

function validPendingEscalation(task: Record<string, unknown>): {
  eventId: string;
  reporterUid: string;
  reporterHash: string;
  attemptCount: number;
  deadlineAt: number;
} | null {
  const eventId = typeof task.eventId === 'string' ? task.eventId : '';
  const reporterUid = typeof task.reporterUid === 'string' ? task.reporterUid : '';
  const createdAt = firestoreTimeMs(task.createdAt);
  const deadlineAt = firestoreTimeMs(task.deadlineAt);
  const expiresAt = firestoreTimeMs(task.expiresAt);
  if (
    task.state !== 'pending' ||
    !EVENT_ID_SHAPE.test(eventId) ||
    !reporterUid || reporterUid.length > 128 ||
    typeof task.reporterHash !== 'string' || !/^[a-f0-9]{20}$/.test(task.reporterHash) ||
    !Number.isSafeInteger(task.attemptCount) || (task.attemptCount as number) < 0 ||
    createdAt === null ||
    firestoreTimeMs(task.nextAttemptAt) === null ||
    deadlineAt === null ||
    expiresAt === null ||
    deadlineAt !== createdAt + BUG_REPORT_ESCALATION_RETRY_WINDOW_MS ||
    expiresAt !== deadlineAt + BUG_REPORT_ESCALATION_PENDING_TTL_MARGIN_MS
  ) return null;
  return {
    eventId,
    reporterUid,
    reporterHash: task.reporterHash,
    attemptCount: task.attemptCount as number,
    deadlineAt,
  };
}

function reportMatchesEscalation(
  reportId: string,
  report: BugReportDoc | undefined,
  task: ReturnType<typeof validPendingEscalation>,
): report is BugReportDoc {
  if (!report || !task) return false;
  return (
    report.kind === 'abuse' &&
    report.escalationLookupFailed === true &&
    report.reporterInEvent === undefined &&
    report.escalationEligible === false &&
    (
      validLegacyBugReportCoordination(report) ||
      validCompleteBugReportCoordination(reportId, report)
    ) &&
    report.eventId === task.eventId &&
    report.reporterHash === task.reporterHash &&
    createHash('sha256').update(task.reporterUid).digest('hex').slice(0, 20) === task.reporterHash
  );
}

async function resolveAbuseEscalationTask(
  db: AdminAlertFirestore,
  reportId: string,
  clock: () => number,
): Promise<void> {
  const taskRef = db.doc(`bugReportEscalations/${reportId}`);
  await db.runTransaction(async (tx) => {
    const task = (await tx.get(taskRef)).data();
    if (!task || task.state !== 'pending') return;
    // Read the clock inside the transaction attempt. A task can cross its
    // seven-day deadline while waiting behind the due query or an earlier row,
    // and Firestore can replay this callback after contention.
    const now = clock();
    const nextAttemptAt = firestoreTimeMs(task.nextAttemptAt);
    if (nextAttemptAt !== null && nextAttemptAt > now) return;

    const parsed = validPendingEscalation(task);
    if (!parsed) {
      tx.set(taskRef, terminalEscalation('source-invalid', now));
      return;
    }
    if (now >= parsed.deadlineAt) {
      tx.set(taskRef, terminalEscalation('retry-window-expired', now));
      return;
    }

    const reportRef = db.doc(`bugReports/${reportId}`);
    const report = (await tx.get(reportRef)).data() as BugReportDoc | undefined;
    if (!reportMatchesEscalation(reportId, report, parsed)) {
      tx.set(taskRef, terminalEscalation('source-invalid', now));
      return;
    }
    const draft = abuseAlertDraft(reportId, report);
    if (!draft) {
      tx.set(taskRef, terminalEscalation('source-invalid', now));
      return;
    }

    const alertRef = db.doc(
      `events/${parsed.eventId}/adminAlerts/${alertDocId(`bug-report-escalation-${reportId}`, draft.kind)}`,
    );
    const eventRef = db.doc(`events/${parsed.eventId}`);
    const [alert, eventSnapshot] = await Promise.all([tx.get(alertRef), tx.get(eventRef)]);
    if (alert.data() !== undefined) {
      tx.set(taskRef, terminalEscalation('alert-conflict', now));
      return;
    }
    const event = eventSnapshot.data();
    if (!event) {
      tx.set(taskRef, terminalEscalation('event-missing', now));
      return;
    }
    if (event.status !== 'active') {
      tx.set(taskRef, terminalEscalation('event-inactive', now));
      return;
    }

    const isAdmin = Array.isArray(event.admins) && event.admins.includes(parsed.reporterUid);
    const isPlayer = isAdmin
      ? false
      : (await tx.get(db.doc(`events/${parsed.eventId}/players/${parsed.reporterUid}`))).data() !== undefined;
    if (!isAdmin && !isPlayer) {
      tx.set(taskRef, terminalEscalation('not-member', now));
      return;
    }

    tx.set(alertRef, pendingAdminAlertRow(draft, now));
    tx.set(taskRef, terminalEscalation('queued', now));
  });
}

async function rescheduleAbuseEscalationTask(
  db: AdminAlertFirestore,
  reportId: string,
  observed: Record<string, unknown>,
  clock: () => number,
): Promise<void> {
  const taskRef = db.doc(`bugReportEscalations/${reportId}`);
  const observedAttempt = observed.attemptCount;
  const observedNext = firestoreTimeMs(observed.nextAttemptAt);
  await db.runTransaction(async (tx) => {
    const current = (await tx.get(taskRef)).data();
    if (
      !current || current.state !== 'pending' ||
      current.attemptCount !== observedAttempt ||
      firestoreTimeMs(current.nextAttemptAt) !== observedNext
    ) return;
    const now = clock();
    const parsed = validPendingEscalation(current);
    if (!parsed) {
      tx.set(taskRef, terminalEscalation('source-invalid', now));
      return;
    }
    if (now >= parsed.deadlineAt) {
      tx.set(taskRef, terminalEscalation('retry-window-expired', now));
      return;
    }
    const newAttemptCount = parsed.attemptCount + 1;
    const delay = Math.min(
      ABUSE_ESCALATION_BACKOFF_BASE_MS * 2 ** Math.min(newAttemptCount - 1, 16),
      ABUSE_ESCALATION_BACKOFF_MAX_MS,
    );
    tx.set(taskRef, {
      ...current,
      attemptCount: newAttemptCount,
      nextAttemptAt: new Date(Math.min(now + delay, parsed.deadlineAt)),
    });
  });
}

/** Re-evaluate due UNKNOWN abuse reports without allowing one row to sink the page. */
export async function runAbuseEscalationSweep(
  db: AdminAlertFirestore,
  deps: AbuseEscalationSweepDeps = {},
): Promise<void> {
  const clock = deps.now ?? Date.now;
  const queryNow = clock();
  const due = await db.collection('bugReportEscalations')
    .where('nextAttemptAt', '<=', new Date(queryNow))
    .orderBy('nextAttemptAt')
    .limit(MAX_ABUSE_ESCALATIONS_PER_SWEEP)
    .get();
  for (const task of due.docs) {
    try {
      await resolveAbuseEscalationTask(db, task.id, clock);
    } catch (err) {
      // Firestore errors may echo a Player document path. Log only the status
      // code so the task's raw reporter uid never escapes this server-only row.
      console.error('runAbuseEscalationSweep: task failed', task.id, { code: firestoreErrorCodeForLog(err) });
      try {
        await rescheduleAbuseEscalationTask(db, task.id, task.data() ?? {}, clock);
      } catch (rescheduleError) {
        console.error('runAbuseEscalationSweep: reschedule failed', task.id, {
          code: firestoreErrorCodeForLog(rescheduleError),
        });
      }
    }
  }
}

// --- Consuming (the digest sweep) ------------------------------------------------

/**
 * The exact outbound request a claimed batch was FROZEN as.
 *
 * This exists because Resend's idempotency is a promise about the request, not
 * just the key: replaying a key with a DIFFERENT body is rejected
 * (`409 invalid_idempotent_request`), not deduplicated. And a re-rendered
 * retry is different by construction — this digest deliberately renders from
 * live state, so any approval, report, roster change or hostname change between
 * the two attempts moves the bytes. Without freezing, the retry would 409,
 * `sendEmail` would surface that as `false`, the claimed rows could never be
 * cleaned up, and the batch would sit stuck until the key expired and then mail
 * a duplicate. So a claim does not merely reserve an identity: it reserves an
 * EMAIL. Live revalidation belongs to building a new batch; a retry re-sends
 * bytes that were already decided.
 */
export interface FrozenDigest {
  to: string[];
  subject: string;
  html: string;
  text: string;
  from: string;
  /** How many alerts the frozen email covers — the `sent` count on a retry. */
  alertCount: number;
}

const batchPath = (eventId: string, batchId: string) => `events/${eventId}/adminAlertBatches/${batchId}`;

/** The frozen request's own retention bound. It holds the fully rendered email —
 *  the densest copy of user content in the system — so it is written with an
 *  `expiresAt` of `PENDING_TTL_MS` from the freeze, which is never earlier than
 *  any row it claims; see the freeze site in `sendAdminDigestForEvent` for why
 *  an unbounded deadline orphans and a shorter one can duplicate a delivered
 *  digest. Needs its own collection-group TTL policy (docs/app/phase-1-deploy.md). */

/** Read back a frozen request, or `null` when there is none / it is unusable.
 *  A partial document is treated as absent: re-rendering is recoverable, while
 *  sending half a payload is not. */
function toFrozen(data: Record<string, unknown> | undefined): FrozenDigest | null {
  if (!data) return null;
  const { to, subject, html, text, from, alertCount } = data;
  if (!Array.isArray(to) || to.length === 0) return null;
  if (typeof subject !== 'string' || typeof html !== 'string' || typeof text !== 'string') return null;
  if (typeof from !== 'string') return null;
  return {
    to: to.filter((v): v is string => typeof v === 'string'),
    subject,
    html,
    text,
    from,
    alertCount: typeof alertCount === 'number' ? alertCount : to.length,
  };
}

/**
 * Alerts drained per Event per sweep. A ceiling, not a batch size: a bigger
 * backlog simply spans consecutive sweeps, because everything drained is
 * removed from the queue and the next run picks up where this one stopped. It
 * exists to bound a pathological queue (a runaway import), not to size normal
 * work.
 */
export const MAX_ALERTS_PER_DIGEST = 200;

/**
 * The drain's hard ceiling, and it is not decorative. The clean-up is ONE
 * atomic `WriteBatch`, which is what makes a failed clean-up leave the queue
 * exactly as it found it — the property the idempotency key relies on. An
 * admin-SDK batch caps at 500 writes, so a `maxAlerts` above that would split
 * into several commits and reintroduce the partial-failure case this design
 * exists to remove. Clamped rather than asserted, so a future config bump
 * degrades to "drains less per sweep" instead of "silently non-atomic".
 */
export const MAX_ATOMIC_WRITES = 450;

/**
 * How long a drained row's TOMBSTONE survives.
 *
 * Seven days, matching the outer bound on Cloud Functions event redelivery,
 * because the tombstone's entire job is to still be there when a delayed
 * redelivery of an already-mailed transition arrives. Enqueue refuses to
 * overwrite an existing deterministic id, so the tombstone is what keeps that
 * dedup honest once the payload row itself is gone.
 *
 * The document carries `expiresAt` so a Firestore TTL policy on that field
 * reaps it (a one-time per-project setup — see docs/app/phase-1-deploy.md).
 * Without the policy the tombstones simply accumulate, which is tolerable in a
 * way the un-reaped ALERTS were not: a tombstone holds no copy of user content.
 *
 * `expiresAt` MUST be written as a `Date`, never as epoch milliseconds.
 * Firestore's TTL service only considers a field whose value is a timestamp; a
 * number is silently ineligible, so a numeric deadline would leave the operator
 * with a configured policy that reaps nothing and a spec that says otherwise.
 * The admin SDK converts a JS `Date` to a `Timestamp` on write, which is how
 * this module states a timestamp without importing `firebase-admin`.
 */
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an UNDRAINED queue row may live before the same TTL policy reaps it.
 *
 * The tombstone TTL above protects the id, not the payload — by the time it
 * applies, the content is already gone. This one protects the payload, and it
 * exists because until now a queued row had exactly one exit: being drained.
 * Archive settlement now deliberately discards uncommitted rows, while TTL is
 * the final bound if both the lifecycle trigger and scheduled backstop cannot
 * complete. Without that bound, a COPY of user content — a pending Prompt's
 * words, a hidden Proof's text, a reporter's abuse description — could outlive
 * the source it describes and every decision anyone made about it.
 *
 * Thirty days is chosen to be uninteresting: the drain runs every five minutes,
 * an undeliverable backlog is meant to clear as soon as a recipient exists, and
 * the source reports themselves are retained ninety days. Anything still sitting
 * here after a month is stranded rather than pending, and holding a copy of
 * somebody's report indefinitely is the worse failure.
 */
export const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Extra life given to a FROZEN request on top of its rows' own deadline.
 *
 * A later `expiresAt` is not by itself an ordering guarantee. Firestore's TTL
 * deletion is asynchronous and best-effort, promises no ordering between two
 * documents, and here the two live in DIFFERENT collection groups under separate
 * policies — so a batch frozen shortly after its rows were enqueued has a
 * deadline only minutes later and can genuinely be deleted first (Phase 4b P1).
 *
 * That specific ordering is the dangerous one: a freeze deleted while its
 * claimed rows survive sends the next sweep down the missing-freeze rebuild
 * path, which re-renders and re-sends — and past Resend's 24-hour window that is
 * a second copy of a digest that may already have been delivered.
 *
 * A week of slack is far beyond the sub-day latency Firestore's TTL actually
 * exhibits, so the race stops being reachable rather than merely unlikely. The
 * cost is that the frozen bytes are the one thing in this queue retained past
 * `PENDING_TTL_MS`, and that is the right trade: keeping a rendered email a few
 * days longer is a bounded, self-collecting cost, while deleting it early is a
 * duplicate delivery.
 */
export const FROZEN_TTL_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an alert must sit still before it is eligible to be drained.
 *
 * The queue makes a burst cost ONE email; this is what stops the scheduler
 * boundary from splitting that email in two. A pool import or a report pile-on
 * that straddles a sweep would otherwise be snapshotted mid-write: the rows
 * already enqueued go out now, the rows written a second later go out five
 * minutes later, and the acceptance criterion ("seeding/imports produce at most
 * one digest") quietly fails on exactly the case it was written for.
 *
 * Sixty seconds is a settling period, not the batching mechanism — that
 * distinction matters, because a debounce is the thing this design deliberately
 * is NOT. The queue is what makes eighty writes one email; this only ensures
 * the eighty are all visible before the drain looks. It is bounded rather than
 * a true "wait for quiet", so a continuous stream of reports can never starve
 * delivery: an import that runs for longer than the settling period will still
 * split across sweeps, which is the honest limit of a poller.
 *
 * Applied in memory rather than as a query filter. A `createdAt <=` range
 * alongside the `sentAt ==` equality would need a composite index, and the
 * whole point of the drain query is that it rides the automatic single-field
 * one.
 */
export const QUIET_PERIOD_MS = 60 * 1000;

/**
 * The longest the settling period may hold a cohort back.
 *
 * The cohort rule ("if any row is still settling, the whole page waits") is
 * what stops a burst being cut in half — but taken alone it is a starvation
 * bug: a steady trickle of reports keeps something inside the window on every
 * sweep, and the queue would never drain at all. So the hold is bounded. Once
 * the oldest eligible row passes this, the eligible cohort goes out and the
 * stragglers follow in the next batch. Ten minutes is two sweeps' worth: long
 * enough that no realistic import is split, short enough that a busy Event's
 * moderation queue is never silently held.
 */
export const MAX_HOLD_MS = 10 * 60 * 1000;

/** Minutes between digest sweeps, mirrored in `index.ts`'s cron. Stated here so
 *  the doc comment and the schedule cannot drift silently. */
export const DIGEST_INTERVAL_MINUTES = 5;

export interface AdminDigestDeps extends ResolveDeps, EnqueueDeps {
  /** Override the send transport (defaults to `sendEmail`). */
  send?: typeof sendEmail;
  /** Sender identity override; wins outright over Edition resolution. Defaults
   *  to `resolveEmailFrom(edition)` — the Edition's `EMAIL_FROM_*` override if
   *  one is configured, else the project-wide `EMAIL_FROM` param (#671). */
  from?: string;
  /** Test-only injection point for `resolveEmailFrom`'s per-Edition lookup —
   *  see its doc comment in `dailyEmail.ts`. Ignored when `from` is set. */
  fromOverrides?: Readonly<Record<string, string | undefined>>;
  /** Fallback origin when the Event has no hostname documents; defaults to the
   *  `APP_BASE_URL` param. */
  appBaseUrl?: string;
  /** Alerts drained per Event per run; defaults to `MAX_ALERTS_PER_DIGEST`,
   *  clamped to `MAX_ATOMIC_WRITES`. */
  maxAlerts?: number;
  /** Settling period before an alert may be drained; defaults to
   *  `QUIET_PERIOD_MS`. Set to 0 in tests that are not about it. */
  quietMs?: number;
}

export interface AdminDigestResult {
  /** Alerts covered by a delivered email. */
  sent: number;
  /** Queue rows retired without a row in the email: resolved since they were
   *  queued, or unreadable. Tombstoned either way, so they stop consuming the
   *  drain limit forever. */
  retired: number;
  /** Why nothing was sent, when nothing was. */
  reason?:
    | 'no-alerts'
    | 'no-event'
    | 'no-recipients'
    | 'send-failed'
    | 'nothing-current'
    /** Everything queued is still inside its settling period — a burst may
     *  still be being written. It drains whole on the next sweep. */
    | 'settling'
    /** The batch identity could not be claimed, so nothing was sent: sending
     *  without one would risk a second email repeating this one. */
    | 'claim-failed'
    /** A concurrent drain claimed these rows first. This sweep steps aside and
     *  finds the winner's claim on the next one. */
    | 'claim-lost'
    /** Archive serialized before a new claim, so this invocation cannot mint a
     *  delivery identity for work the Event no longer exposes. */
    | 'inactive-event'
    /** The outbound request could not be recorded, so nothing was sent: a send
     *  whose bytes were never frozen cannot be safely retried under its key. */
    | 'freeze-failed'
    /** The authorized recipients changed under a frozen batch, so it was
     *  abandoned and its rows released to re-batch for whoever is authorized
     *  now. Never replayed to the stale set. */
    | 'rebatched';
}

export interface ArchiveSettlementResult {
  /** Pending rows replaced by payload-free discard tombstones. */
  discarded: number;
  /** Pending rows retained because their claimed request is already frozen. */
  preserved: number;
}

/** Pure trigger guard: archive settlement belongs to the lifecycle edge, not
 * every edit of an already-archived Event. The scheduled sweep is the retrying
 * backstop after that edge. */
export function shouldSettleAdminAlertsOnArchive(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean {
  return before?.status === 'active' && after?.status === 'archived';
}

/** Read one alert snapshot into the record the digest renders, dropping rows
 *  whose shape is unusable. A hand-written or half-migrated document must not
 *  throw here — one bad row would suppress the whole Event's digest. */
function toRecord(snap: AlertSnapshot): AdminAlertRecord | null {
  const data = snap.data();
  if (!data) return null;
  const kind = data.kind;
  const collection = data.collection;
  if (kind !== 'item-created' && kind !== 'content-reported' && kind !== 'moderation' && kind !== 'abuse-reported') {
    return null;
  }
  if (collection !== 'items' && collection !== 'proofs' && collection !== 'bugReports') return null;
  const docId = typeof data.docId === 'string' ? data.docId : '';
  if (!docId) return null;
  return {
    id: snap.id,
    kind,
    collection,
    docId,
    // Flattened on the way back out too, so a row queued before `flattenLabel`
    // existed cannot smuggle a newline into the plain-text part.
    label: (typeof data.label === 'string' && flattenLabel(data.label)) || '(untitled)',
    status: typeof data.status === 'string' ? data.status : 'unknown',
    visionFlag: typeof data.visionFlag === 'string' && data.visionFlag ? data.visionFlag : null,
    reportCount: typeof data.reportCount === 'number' ? data.reportCount : 0,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
  };
}

const MODERATION_STATES_LIVE = ['flagged', 'hidden'];

/**
 * Re-read the content an alert is about, and answer with the row the digest
 * should actually render — or `null` when there is nothing left to say.
 *
 * WHY THE QUEUE IS NOT THE SOURCE OF TRUTH AT SEND TIME. An alert records what
 * a write looked like; the email claims what is in the review queue NOW, and up
 * to a whole sweep separates the two. An admin who approves a Prompt two
 * minutes after it lands would otherwise still be mailed "pending approval" for
 * it, and a Prompt reported and then hidden inside one window could appear in
 * both sections at once.
 *
 * Rendering from live state also resolves the ordering hazard for free. The
 * report write and the auto-hide write reach two independent trigger
 * invocations whose handler wall-clocks can interleave, so `createdAt` cannot
 * be trusted to say which state is newer. The doc itself can: whatever it says
 * NOW is what the row says, whichever alert queued first.
 *
 * A FAILED read is not a resolution. The stored facts are kept and the row is
 * rendered from them, because for an admin notification the safe direction is
 * to over-report: a dropped moderation alert is a piece of flagged content
 * nobody is told about.
 */
export function currentRowFor(
  alert: AdminAlertRecord,
  live: AlertableDoc | undefined,
  readFailed: boolean,
): AdminAlertRecord | null {
  // AN ABUSE REPORT IS EXEMPT FROM THE MODERATION RULES, BUT NOT FROM EXISTENCE.
  //
  // It is a RECORD OF A SUBMISSION rather than a state a document is in, and
  // `bugReports/{id}` carries no `status`/`reportCount` vocabulary for the rules
  // below to read — so applying them would score every abuse row "resolved" and
  // drop it the moment it was drained: queued, claimed, tombstoned, never mailed
  // (#670). Nothing an admin does makes it stop being true, either; a report was
  // filed, and it stays filed.
  //
  // Deletion is the one thing that does end it, and the delay can be long: a
  // digest that cannot resolve a recipient leaves its alerts pending
  // indefinitely, and the documented 90-day retention sweep
  // (`docs/app/bug-reports.md`) can remove the source report in the meantime.
  // Mailing the copied description and a dead report id AFTER the private source
  // was deliberately deleted is exactly the retention promise this queue's
  // tombstones exist to keep, so an absent report retires the row. A FAILED read
  // still fails open, like every other kind.
  if (alert.kind === 'abuse-reported') return readFailed || live ? alert : null;
  if (readFailed) return alert; // fail-open: keep the stored facts rather than lose the alert
  if (!live) return null; // deleted since it was queued — nothing left to review
  const status = typeof live.status === 'string' ? live.status : 'unknown';
  const reportCount = typeof live.reportCount === 'number' ? live.reportCount : 0;
  const visionFlag = typeof live.visionFlag === 'string' && live.visionFlag ? live.visionFlag : null;
  const label = alert.label;

  if (alert.kind === 'item-created') {
    // Approved, rejected or hidden since it was queued — the approval work is
    // done, whoever did it.
    return status === 'pending' ? { ...alert, status, reportCount, visionFlag, label } : null;
  }
  // A report or a moderation transition still needs eyes while the content is
  // in a moderation state OR still carries reports. A restore that also cleared
  // the reports is the admin having handled it.
  if (!MODERATION_STATES_LIVE.includes(status) && reportCount <= 0) return null;
  return {
    ...alert,
    // The KIND follows the live document, not the queued alert: content that is
    // now hidden reads as hidden even if the alert that survived the collapse
    // was the earlier report.
    kind: MODERATION_STATES_LIVE.includes(status) ? 'moderation' : 'content-reported',
    status,
    reportCount,
    visionFlag,
    label,
  };
}

/**
 * Drain one Event's queue into a single digest.
 *
 * IDEMPOTENCY, precisely. The queue rows covered by a delivered email are
 * removed in ONE atomic `WriteBatch` after the send. So there are exactly two
 * outcomes: the batch commits and those alerts are gone, or it does not and
 * every one of them is still pending — never a partial subset. A retry after
 * the second outcome therefore rebuilds the IDENTICAL set, produces the
 * identical idempotency key, and Resend collapses the duplicate inside its 24h
 * window. A count-based key over a partially-drained subset would not have that
 * property, which is precisely the hole an atomic clean-up closes.
 *
 * THE KEY IS PERSISTED BEFORE THE SEND, not derived at send time. `claimDrain`
 * stamps the drained rows with a `batchId` and the email is keyed on that, so
 * the delivery identity is immutable from the moment it goes out. Nothing
 * derivable at send time has that property: the rendered rows shrink as admins
 * resolve items, and the raw pending page GROWS as new alerts arrive, so a
 * retry after a failed clean-up would compute a different key either way and
 * Resend would accept a second email repeating what it already delivered. With
 * a claim, the retry takes exactly the claimed rows, reuses their id, dedupes —
 * and the alerts queued since simply belong to the next batch.
 *
 * WHAT THE CLEAN-UP WRITES IS A TOMBSTONE, not a delete, and it has to be both
 * things at once. Deleting outright was the retention answer — a queue row
 * carries a copy of pending or hidden user content, and keeping it would outlive
 * the moderation decision and even the deletion of the content it describes —
 * but it also destroyed the deterministic-id dedup: a redelivered trigger whose
 * row had been deleted would `create` successfully and mail the same transition
 * twice. So the row is REPLACED by `{ sentAt, expiresAt }`: the payload is gone,
 * the id survives to keep failing `create`, and a Firestore TTL policy on
 * `expiresAt` reaps it after the redelivery window.
 */
/**
 * Does this claimed page carry an abuse row whose source report is GONE?
 *
 * The frozen-replay path deliberately re-derives nothing, because any difference
 * at all would 409 against the key the batch has already used. The roster was
 * the first exception (see `sendAdminDigestForEvent`), and a deleted bug report
 * is the second, for the same underlying reason: a freeze is written BEFORE the
 * send, so a crash or a rejected send leaves bytes that may never have been
 * delivered — and a batch that keeps failing is retried every sweep for as long
 * as it keeps failing, which is easily long enough for the 90-day retention
 * sweep to remove a report the frozen bytes quote.
 *
 * Scoped to abuse rows on purpose. A deleted Prompt or Proof is ordinary
 * moderation churn, and replaying a stale row about one is the trade #638 made
 * knowingly; a deleted bug report is a deliberate act of retention on private
 * evidence, and mailing it afterwards is the one thing the tombstone design
 * promises not to do.
 *
 * A FAILED read is not a deletion, matching `currentRowFor`'s fail-open.
 */
async function frozenAbuseSourceMissing(
  db: AdminAlertFirestore,
  eventId: string,
  page: readonly AlertSnapshot[],
): Promise<boolean> {
  for (const snapshot of page) {
    const data = snapshot.data();
    if (data?.kind !== 'abuse-reported') continue;
    const docId = typeof data.docId === 'string' ? data.docId : '';
    if (!docId) continue;
    try {
      const live = await db.doc(livePathFor(eventId, 'bugReports', docId)).get();
      if (live.data() === undefined) return true;
    } catch (err) {
      console.error('sendAdminDigestForEvent: frozen abuse source re-read failed', eventId, docId, err);
    }
  }
  return false;
}

/**
 * Confirm the frozen request still owns every row immediately before send.
 *
 * Archive cleanup can serialize after the claim but before the freeze create:
 * it then knows no send could have begun and replaces the rows with discard
 * tombstones. The create may still finish afterwards because it targets a
 * different document. This transaction closes that final gap: stale ownership
 * deletes the orphaned freeze and no external call begins.
 */
async function verifyFrozenClaim(
  db: AdminAlertFirestore,
  eventId: string,
  batchId: string,
  ids: readonly string[],
): Promise<'valid' | 'stale' | 'failed'> {
  try {
    return await db.runTransaction(async (tx) => {
      const refs = ids.map((id) => db.doc(`events/${eventId}/adminAlerts/${id}`));
      const rows = await Promise.all(refs.map((ref) => tx.get(ref)));
      const valid = rows.every((row) => {
        const data = row.data();
        return data?.sentAt === null && data.batchId === batchId;
      });
      if (valid) return 'valid' as const;
      tx.delete(db.doc(batchPath(eventId, batchId)));
      return 'stale' as const;
    });
  } catch (err) {
    console.error('sendAdminDigestForEvent: frozen-claim verification failed (nothing sent)', eventId, err);
    return 'failed';
  }
}

export async function sendAdminDigestForEvent(
  db: AdminAlertFirestore,
  eventId: string,
  deps: AdminDigestDeps = {},
): Promise<AdminDigestResult> {
  const maxAlerts = Math.min(deps.maxAlerts ?? MAX_ALERTS_PER_DIGEST, MAX_ATOMIC_WRITES);
  const quietMs = deps.quietMs ?? QUIET_PERIOD_MS;
  const now = (deps.now ?? Date.now)();
  const snap = await db
    .collection(`events/${eventId}/adminAlerts`)
    .where('sentAt', '==', null)
    .limit(maxAlerts)
    .get();
  if (snap.docs.length === 0) return { sent: 0, retired: 0, reason: 'no-alerts' };

  const claim = await claimDrain(db, eventId, snap.docs, now, quietMs);
  if (claim.reason) return { sent: 0, retired: 0, reason: claim.reason };
  const { batchId, page, frozen } = claim;

  // A RETRY of a batch that was already sent: replay the frozen bytes and clean
  // up. NOTHING here is re-derived — not the recipients, not the origin, not the
  // rows — because any difference at all would 409 against the key this batch
  // has already used, and a 409 surfaces as a failed send that can never be
  // cleaned up (see `FrozenDigest`).
  if (frozen) {
    // RECIPIENTS ARE REVALIDATED EVEN ON A REPLAY, and this is the one thing a
    // frozen request must not simply trust. A freeze is written BEFORE the
    // send, so a crash in between — or a definitively rejected send — leaves
    // bytes that may never have been delivered. If an admin has since been
    // removed from the roster, or `ADMIN_NOTIFY_EMAIL` has been corrected,
    // replaying verbatim would mail pending and hidden content to somebody who
    // is no longer authorized to see it, and would keep doing so forever
    // because the stale address is baked into the frozen request.
    //
    // So when the authorized set has changed, the batch is ABANDONED rather
    // than replayed: the freeze is dropped and the claim released, and the rows
    // re-batch from scratch under a new id on the next sweep, addressed to
    // whoever is authorized then. That can duplicate a digest if the original
    // send did land — to a currently-authorized recipient, and only when the
    // roster moved mid-flight, which is a strictly better outcome than mailing
    // a revoked one. It is also what lets a corrected deployment unblock a
    // batch its old configuration had wedged.
    const authorized = await resolveAdminEmails(eventId, deps);
    if (!sameRecipients(authorized, frozen.to)) {
      console.log(`sendAdminDigestForEvent: recipients changed under batch ${batchId}; re-batching`);
      const release = await releaseBatch(db, eventId, batchId, page.map((d) => d.id), now);
      if (release === 'released') return { sent: 0, retired: 0, reason: 'rebatched' };
      if (release === 'discarded') return { sent: 0, retired: 0, reason: 'inactive-event' };
      // Another invocation settled or re-batched this work first; do not let a
      // stale replay overwrite its newer claim. A failed transaction likewise
      // leaves the original frozen batch intact for a later safe retry.
      return { sent: 0, retired: 0, reason: release === 'stale' ? 'claim-lost' : 'claim-failed' };
    }
    // THE SECOND THING A FROZEN REQUEST MUST NOT SIMPLY TRUST: that the bug
    // report it quotes still exists (#670). Same escape hatch as the roster
    // above, and for the same reason — abandon rather than replay, so the rows
    // re-batch from scratch and `currentRowFor` retires the deleted one on the
    // way past. Re-rendering here instead would change the bytes under a key
    // that has already been used, which is the 409 that strands a batch forever.
    if (await frozenAbuseSourceMissing(db, eventId, page)) {
      console.log(`sendAdminDigestForEvent: an abuse source was deleted under batch ${batchId}; re-batching`);
      const release = await releaseBatch(db, eventId, batchId, page.map((d) => d.id), now);
      if (release === 'released') return { sent: 0, retired: 0, reason: 'rebatched' };
      if (release === 'discarded') return { sent: 0, retired: 0, reason: 'inactive-event' };
      return { sent: 0, retired: 0, reason: release === 'stale' ? 'claim-lost' : 'claim-failed' };
    }
    const verification = await verifyFrozenClaim(db, eventId, batchId, page.map((doc) => doc.id));
    if (verification !== 'valid') {
      return { sent: 0, retired: 0, reason: verification === 'stale' ? 'claim-lost' : 'claim-failed' };
    }
    const replayed = await (deps.send ?? (await import('./email')).sendEmail)({
      to: frozen.to,
      subject: frozen.subject,
      html: frozen.html,
      text: frozen.text,
      from: frozen.from,
      idempotencyKey: `admin-digest/${eventId}/${batchId}`,
    });
    if (!replayed) return { sent: 0, retired: 0, reason: 'send-failed' };
    await finishBatch(
      db,
      eventId,
      batchId,
      page.map((d) => d.id),
      now,
    );
    return { sent: frozen.alertCount, retired: 0 };
  }

  // A MISSING FREEZE ON PAST-DUE ROWS IS NOT A REBUILD, it is a retirement.
  //
  // The rebuild path exists for one legitimate case: the claim commits before
  // the freeze is written, so a crash in between leaves claimed rows with no
  // frozen document and — correctly, because no freeze means nothing was sent —
  // the batch is rebuilt. That case is SECONDS old.
  //
  // Rows that are already past their own retention deadline are the opposite
  // shape. A batch that keeps failing to send HAS a freeze (it is written before
  // the send), so an old claim with no freeze means the freeze existed and was
  // reaped — and rebuilding then re-sends bytes that may already have been
  // delivered, well outside Resend's 24-hour window, which is the one thing the
  // frozen-request design exists to prevent (Phase 4b P1). The margin above
  // makes this unreachable in practice; this is the second line, and it errs
  // toward silence only for rows whose retention window has already closed.
  if (!frozen && page.length > 0) {
    const stale = page.every((doc) => {
      const createdAt = doc.data()?.createdAt;
      return typeof createdAt === 'number' && createdAt > 0 && createdAt + PENDING_TTL_MS <= now;
    });
    if (stale) {
      console.error(
        `sendAdminDigestForEvent: claimed rows are past due with no frozen request; retiring rather than risking a duplicate`,
        eventId,
        batchId,
      );
      await finishBatch(db, eventId, batchId, page.map((d) => d.id), now);
      return { sent: 0, retired: page.length, reason: 'nothing-current' };
    }
  }

  // Unreadable rows are RETIRED, not merely skipped. Skipping them leaves them
  // pending forever, and a page of malformed documents would then occupy the
  // whole drain limit on every sweep — starving valid alerts behind it
  // indefinitely. They are cleared alongside whatever is delivered.
  const unreadable: string[] = [];
  const alerts: AdminAlertRecord[] = [];
  for (const doc of page) {
    const record = toRecord(doc);
    if (record) alerts.push(record);
    else unreadable.push(doc.id);
  }
  if (unreadable.length > 0) {
    console.error(`sendAdminDigestForEvent: retiring ${unreadable.length} unreadable alert(s)`, eventId);
  }

  const event = (await db.doc(`events/${eventId}`).get()).data() as DigestEvent | undefined;
  if (!event) return { sent: 0, retired: 0, reason: 'no-event' };

  // Re-read each piece of content ONCE, however many alerts point at it, then
  // render every row from what the document says now.
  // EVERY collection is re-read, at ITS OWN path — `livePathFor` is what keeps a
  // top-level `bugReports/{id}` from being looked up under the Event, where it
  // would read as absent and therefore as "deleted since it was queued". The map
  // key stays `{collection}/{docId}`, which is already unique across both
  // shapes. An abuse row consumes only the doc's PRESENCE (`currentRowFor` reads
  // no moderation field from it), so the `AlertableDoc` cast is a convenience
  // there rather than a claim about the document's shape.
  const live = new Map<string, { doc: AlertableDoc | undefined; failed: boolean }>();
  for (const key of new Set(alerts.map((a) => `${a.collection}/${a.docId}`))) {
    const [collection, docId] = [key.slice(0, key.indexOf('/')) as AlertedCollection, key.slice(key.indexOf('/') + 1)];
    try {
      const path = livePathFor(eventId, collection, docId);
      live.set(key, { doc: (await db.doc(path).get()).data() as AlertableDoc | undefined, failed: false });
    } catch (err) {
      console.error('sendAdminDigestForEvent: content re-read failed', eventId, key, err);
      live.set(key, { doc: undefined, failed: true });
    }
  }
  const current: AdminAlertRecord[] = [];
  const resolved: string[] = [];
  for (const alert of alerts) {
    const state = live.get(`${alert.collection}/${alert.docId}`) ?? { doc: undefined, failed: true };
    const row = currentRowFor(alert, state.doc, state.failed);
    if (row) current.push(row);
    else resolved.push(alert.id);
  }

  // Everything queued has been handled since. Clear the rows — they are answered
  // work, and leaving them would re-cost a re-read on every sweep — and send
  // nothing, because an email claiming a review queue that is empty is worse
  // than no email.
  const retireOnly = [...unreadable, ...resolved];
  if (current.length === 0) {
    await finishBatch(db, eventId, batchId, retireOnly, now);
    return { sent: 0, retired: retireOnly.length, reason: 'nothing-current' };
  }

  // The roster resolves from the Event's `admins` UIDs unioned with the
  // ADMIN_NOTIFY_EMAIL override — one lookup for the whole digest rather than
  // one per alert, which is the other half of why this is batched.
  const to = await resolveAdminEmails(eventId, deps);
  if (to.length === 0) {
    console.log(`sendAdminDigestForEvent: no admin emails for event ${eventId}; leaving ${current.length} queued`);
    return { sent: 0, retired: 0, reason: 'no-recipients' };
  }

  const appBaseUrl = deps.appBaseUrl ?? (await import('./params')).APP_BASE_URL.value();
  const send = deps.send ?? (await import('./email')).sendEmail;
  // A FAILED hostname read is not a confirmed absence: falling back would erase
  // the Event's Edition and put the legacy brand line on a Vacay/Five Across
  // digest. Let the sweep boundary log and skip; the next run retries safely.
  const { origin, edition } = await resolveEventOrigin(db, eventId, appBaseUrl);
  // Resolved after the Edition, not before: the sender is Edition-aware (#671).
  const from = deps.from ?? (await resolveEmailFrom(edition, deps.fromOverrides));

  const model = buildAdminDigestModel({ event, eventId, alerts: current, edition, origin, now });
  const payload: FrozenDigest = {
    to,
    subject: model.subject,
    html: renderAdminDigestHtml(model),
    text: renderAdminDigestText(model),
    from,
    alertCount: current.length,
  };
  // FREEZE BEFORE SENDING, and freeze with `create`, not `set`.
  //
  // A send whose bytes were never recorded is one a retry can only reconstruct
  // by guessing, and a wrong guess under the same key is the 409 that strands
  // the batch — so if this write fails, nothing goes out.
  //
  // CREATE-ONLY is what makes the claim and the freeze mutually exclusive. The
  // claim commits before the freeze is written, so a second invocation can see
  // claimed rows with no frozen document and — correctly, because no freeze
  // means nothing was sent — rebuild. Two unconditional `set`s would then race,
  // and the surviving freeze might not be the request Resend actually accepted.
  // With `create` exactly one render wins; the loser discards its own bytes and
  // replays the winner's, so one batch id can only ever name one request.
  //
  // IT CARRIES ITS OWN `expiresAt`. This document holds the FULLY RENDERED email
  // — every pending Prompt's words and every abuse description in the batch — so
  // it is the single densest copy of user content in the system, and until this
  // existed it had no expiry at all: repeated delivery failures keep a frozen
  // batch alive indefinitely, the pending TTL reaps the claimed rows underneath
  // it, and no later sweep can discover the batch to replay, release or delete
  // it — an orphaned copy of the text with nothing left pointing at it
  // (Phase 4b P1).
  //
  // THE FREEZE MUST OUTLIVE EVERY ROW IT CLAIMS, with room to spare. The rows
  // were created at or before this moment and carry the same span, so
  // `PENDING_TTL_MS` from now is already never earlier than any of theirs — but
  // "not earlier" is not enough on its own, because TTL deletion is asynchronous
  // and unordered across two collection groups, and a batch frozen minutes after
  // its rows would be racing them. `FROZEN_TTL_MARGIN_MS` turns that race into a
  // week of slack.
  //
  // Both directions here are hazards, and two earlier attempts each fell into
  // one of them (Phase 4b P1, twice). If the freeze expires EARLY relative to
  // its claimed rows, the next sweep finds claimed rows with no frozen document
  // and takes the missing-freeze rebuild path — re-rendering and re-sending
  // under a key that may still be live (a 409 that strands the batch) or one
  // whose 24-hour Resend window has closed (a second copy of a digest that was
  // already delivered, if the original send landed but its response or clean-up
  // was lost). Inheriting the earliest row's deadline caused the first; a fixed
  // week caused the second, because rows live thirty days.
  //
  // Outliving the rows is the safe direction, and it is bounded: the document
  // reaps itself on its own deadline whether or not anything ever finds it
  // again. It is the one thing here retained past `PENDING_TTL_MS`, by the
  // margin, and that is deliberate — see `FROZEN_TTL_MARGIN_MS`.
  //
  // This needs its OWN TTL policy. Firestore TTL is scoped to a collection
  // group, so the `adminAlerts` policy does not reach `adminAlertBatches`;
  // without the second policy this field is inert and the rendered email
  // persists (docs/app/phase-1-deploy.md § 1a).
  const batchExpiresAt = new Date(now + PENDING_TTL_MS + FROZEN_TTL_MARGIN_MS);
  let outbound = payload;
  try {
    await db.doc(batchPath(eventId, batchId)).create({ ...payload, createdAt: now, expiresAt: batchExpiresAt });
  } catch (err) {
    if (!isAlreadyExists(err)) {
      console.error('sendAdminDigestForEvent: freezing the outbound request failed (nothing sent)', eventId, err);
      return { sent: 0, retired: 0, reason: 'freeze-failed' };
    }
    const winner = toFrozen((await db.doc(batchPath(eventId, batchId)).get()).data());
    if (!winner) {
      console.error('sendAdminDigestForEvent: lost the freeze race but could not read the winner', eventId);
      return { sent: 0, retired: 0, reason: 'freeze-failed' };
    }
    console.log(`sendAdminDigestForEvent: another invocation froze ${batchId} first; replaying it`);
    outbound = winner;
  }

  const verification = await verifyFrozenClaim(db, eventId, batchId, page.map((doc) => doc.id));
  if (verification !== 'valid') {
    return { sent: 0, retired: 0, reason: verification === 'stale' ? 'claim-lost' : 'claim-failed' };
  }

  const ok = await send({
    to: outbound.to,
    subject: outbound.subject,
    html: outbound.html,
    text: outbound.text,
    from: outbound.from,
    idempotencyKey: `admin-digest/${eventId}/${batchId}`,
  });
  if (!ok) return { sent: 0, retired: 0, reason: 'send-failed' };

  await finishBatch(db, eventId, batchId, [...retireOnly, ...current.map((a) => a.id)], now);
  console.log(
    `sendAdminDigestForEvent ${eventId}: sent=${current.length} retired=${retireOnly.length} to=${to.length}`,
  );
  return { sent: outbound.alertCount, retired: retireOnly.length };
}

/**
 * The delivery identity of one drain, reduced from a set of queue-row ids in a
 * way that does not depend on the order Firestore happened to return them in:
 * the greatest id plus the count. The drain query carries no `orderBy`
 * (deliberately — an equality filter with a `limit` rides the automatic index),
 * so a position-sensitive reduction could shuffle between two sweeps over an
 * identical page and mint a different key for the same email.
 */
export function drainKey(ids: readonly string[], requeueGeneration = 0): string {
  const max = [...ids].sort().pop() ?? 'empty';
  // `__` rather than `/`: the batch id is also a DOCUMENT ID (the frozen
  // outbound request is stored under it), and a slash would reparent it.
  // A cohort released after recipient revalidation has to mint a NEW delivery
  // identity even when its rows have not changed. Reusing the old key with a
  // new recipient set would make Resend reject the different request as
  // `invalid_idempotent_request` (or suppress a genuinely fresh delivery).
  // Initial cohorts retain their compact historical form; only a released one
  // carries its persisted generation suffix.
  return `${max}__${ids.length}${requeueGeneration > 0 ? `__${requeueGeneration}` : ''}`;
}

/**
 * Pure: split a pending page into the rows a drain may take, and the identity
 * that drain should carry. Exported for its own tests — this is the whole
 * once-and-only-once decision, and it is worth exercising without a Firestore.
 *
 * TWO CASES, and the first is the one that makes retries safe.
 *
 * A PRIOR CLAIM EXISTS. Some rows carry a `batchId`, which means an earlier
 * sweep already sent an email for exactly those rows and failed to clean up
 * after itself. The drain takes ONLY those rows, and reuses their batch id — so
 * the retry re-sends the identical email under the identical key and Resend
 * collapses it. Crucially, work queued SINCE that attempt is left out: without
 * this, the growing page would mint a new key and Resend would accept a second
 * email repeating everything already delivered alongside the new alert.
 *
 * NO PRIOR CLAIM. The rows outside their settling period are claimed as a new
 * batch. Rows still settling are left for the next sweep, because a burst that
 * straddles the scheduler boundary would otherwise be snapshotted mid-write and
 * split across two emails.
 *
 * The lowest batch id wins when several are somehow present, purely so the
 * choice is deterministic across sweeps rather than order-dependent.
 */
export function planDrain(
  rows: ReadonlyArray<{ id: string; batchId?: unknown; createdAt?: unknown; requeueGeneration?: unknown }>,
  now: number,
  quietMs: number,
  maxHoldMs: number = MAX_HOLD_MS,
): { batchId: string; ids: string[]; claimNeeded: boolean } | { reason: 'settling' } {
  const claimedIds = rows
    .filter((r) => typeof r.batchId === 'string' && r.batchId)
    .map((r) => String(r.batchId));
  if (claimedIds.length > 0) {
    const batchId = [...claimedIds].sort()[0];
    return {
      batchId,
      ids: rows.filter((r) => r.batchId === batchId).map((r) => r.id),
      claimNeeded: false,
    };
  }
  const cutoff = now - quietMs;
  const at = (r: { createdAt?: unknown }) => (typeof r.createdAt === 'number' ? r.createdAt : 0);
  const ripe = rows.filter((r) => at(r) <= cutoff);
  if (ripe.length === 0) return { reason: 'settling' };

  // COHORT, not per-row. Filtering eligibility row by row defeats the guarantee
  // it exists for: a one-second import straddling the cutoff has its first rows
  // at 60.5s and its last at 59.5s, so the front of the burst goes out now and
  // the tail five minutes later — exactly the split the settling period was
  // added to prevent. If ANY row is still settling, the whole page waits.
  if (ripe.length < rows.length) {
    const oldest = Math.min(...ripe.map(at));
    // ...but not forever. A continuous trickle of reports would keep something
    // inside the window on every sweep and starve delivery outright, so the
    // hold is bounded: once the oldest ripe row passes `maxHoldMs`, the ripe
    // cohort goes out and the stragglers follow. Delivering late beats never.
    if (now - oldest < maxHoldMs) return { reason: 'settling' };
    console.log(`planDrain: max-hold reached with ${rows.length - ripe.length} row(s) still settling`);
  }
  const ids = ripe.map((r) => r.id);
  const generation = Math.max(
    0,
    ...ripe.map((r) =>
      typeof r.requeueGeneration === 'number' && Number.isInteger(r.requeueGeneration) && r.requeueGeneration > 0
        ? r.requeueGeneration
        : 0,
    ),
  );
  return { batchId: drainKey(ids, generation), ids, claimNeeded: true };
}

/**
 * Resolve the page a drain may take, claiming a batch identity FIRST when there
 * is not already one.
 *
 * The claim is written before the send, and that ordering is the point: the
 * delivery key has to be immutable from the moment the email goes out, and the
 * only way to make it immutable is to persist it. Deriving it from the page at
 * send time cannot work, because the page is not stable across a failed
 * clean-up — it shrinks as rows resolve and grows as new alerts arrive.
 *
 * A failed claim sends NOTHING. Sending under an unpersisted key would put the
 * system back in exactly the state this closes: a retry that cannot recognise
 * its own previous delivery.
 */
async function claimDrain(
  db: AdminAlertFirestore,
  eventId: string,
  docs: readonly AlertSnapshot[],
  now: number,
  quietMs: number,
): Promise<
  | { batchId: string; page: AlertSnapshot[]; frozen: FrozenDigest | null; reason?: undefined }
  | {
      reason: 'settling' | 'claim-failed' | 'claim-lost' | 'inactive-event';
      batchId?: undefined;
      page?: undefined;
      frozen?: undefined;
    }
> {
  const rows = docs.map((d) => {
    const data = d.data() ?? {};
    return {
      id: d.id,
      batchId: data.batchId,
      createdAt: data.createdAt,
      requeueGeneration: data.requeueGeneration,
    };
  });
  const plan = planDrain(rows, now, quietMs);
  if ('reason' in plan) return { reason: plan.reason };

  if (!plan.claimNeeded) {
    // A RETRY. Re-read the batch BY ITS ID rather than trusting the page that
    // surfaced it. The pending page is `limit`ed, so once it is full a newly
    // queued row can displace one of the claimed rows out of it — and retrying
    // the remainder under the original key would send a SMALLER payload that
    // Resend then treats as the same email. The displaced rows would come back
    // later under that same key, be suppressed as duplicates, and never be
    // delivered at all. A single equality filter needs no composite index, and
    // a tombstone carries no `batchId`, so this matches exactly the claimed
    // rows still outstanding.
    try {
      const claimed = await db
        .collection(`events/${eventId}/adminAlerts`)
        .where('batchId', '==', plan.batchId)
        .limit(MAX_ATOMIC_WRITES)
        .get();
      const pending = claimed.docs.filter((d) => (d.data() ?? {}).sentAt === null);
      if (pending.length > 0) {
        // Re-send the bytes this batch was frozen as, never a fresh render —
        // see `FrozenDigest`. A missing freeze (a crash between the claim and
        // the persist) falls through to a rebuild, which is safe precisely
        // because nothing was sent under that key yet.
        const frozen = toFrozen((await db.doc(batchPath(eventId, plan.batchId)).get()).data());
        return { batchId: plan.batchId, page: pending, frozen };
      }
    } catch (err) {
      console.error('sendAdminDigestForEvent: claimed-batch reload failed (nothing sent)', eventId, err);
      return { reason: 'claim-failed' };
    }
  }

  // A NEW batch. The claim is TRANSACTIONAL, not an unconditional merge,
  // because two overlapping invocations (Cloud Scheduler can double-fire) would
  // otherwise read slightly different pages, derive different batch ids, and
  // each overwrite the other's claim on the rows they share — then send their
  // own snapshot under their own key, so the overlap is mailed twice despite
  // the one-digest guarantee. Claiming only rows that are still unclaimed makes
  // "check, then claim" one indivisible step; the loser abandons this sweep and
  // finds the winner's claim on the next one.
  try {
    const outcome = await db.runTransaction(async (tx) => {
      const event = (await tx.get(db.doc(`events/${eventId}`))).data();
      if (event?.status !== 'active') return 'inactive' as const;
      const refs = plan.ids.map((id) => db.doc(`events/${eventId}/adminAlerts/${id}`));
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      for (const snap of snaps) {
        const data = snap.data();
        // Unclaimed AND still pending. `sentAt === null` is not redundant: an
        // overlapping drain that finished first REPLACED its rows with
        // tombstones, and a tombstone carries no `batchId` — so a
        // claimed-only check would read it as free, merge a new batch id onto
        // it, and mail the stale pre-tombstone snapshot a second time.
        if (!data || data.batchId || data.sentAt !== null) return 'lost' as const;
      }
      // MERGE — the claim annotates the row, it must not replace the payload
      // the digest is about to render.
      for (const ref of refs) tx.set(ref, { batchId: plan.batchId }, { merge: true });
      return 'won' as const;
    });
    if (outcome === 'inactive') return { reason: 'inactive-event' };
    if (outcome === 'lost') {
      console.log(`sendAdminDigestForEvent: another drain claimed these rows first; skipping ${eventId}`);
      return { reason: 'claim-lost' };
    }
  } catch (err) {
    console.error('sendAdminDigestForEvent: batch claim failed (nothing sent)', eventId, err);
    return { reason: 'claim-failed' };
  }
  const wanted = new Set(plan.ids);
  return { batchId: plan.batchId, page: docs.filter((d) => wanted.has(d.id)), frozen: null };
}

/**
 * Replace drained queue rows with tombstones in ONE atomic batch.
 *
 * `set` without merge, so the row's payload — including its copy of unapproved
 * or hidden user content — is REPLACED by two numbers rather than joined by
 * them. What survives is the document ID, which is the point: it is derived
 * from the triggering CloudEvent id, so a delayed redelivery of an
 * already-mailed transition still finds the occupied id instead of queueing
 * the same alert a second time. `expiresAt` is a `Date` so the documented TTL
 * policy can actually reap it (see `TOMBSTONE_TTL_MS`).
 *
 * All-or-nothing is the other half (see `sendAdminDigestForEvent`), so a commit
 * failure is logged and swallowed rather than retried per-document: leaving
 * every row pending is the safe, self-healing outcome, and the next sweep
 * rebuilds the same key and dedupes at Resend.
 */
/** Recipient sets compared as sets, since neither resolution order nor
 *  duplicates carry meaning — only who is authorized. */
export function sameRecipients(a: readonly string[], b: readonly string[]): boolean {
  const norm = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()))].sort();
  const [x, y] = [norm(a), norm(b)];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Abandon a frozen batch atomically. An active Event releases the rows back to
 * the pending pool; an archived Event replaces them with discard tombstones.
 * Reading the Event in the same transaction makes reactivation and discard
 * serialize, so exactly one lifecycle state wins. `batchId: null` rather than
 * a field delete keeps the active release free of `firebase-admin`'s
 * `FieldValue`.
 */
async function releaseBatch(
  db: AdminAlertFirestore,
  eventId: string,
  batchId: string,
  ids: readonly string[],
  now: number,
): Promise<'released' | 'discarded' | 'stale' | 'failed'> {
  try {
    const released = await db.runTransaction(async (tx) => {
      const event = (await tx.get(db.doc(`events/${eventId}`))).data();
      const refs = ids.map((id) => db.doc(`events/${eventId}/adminAlerts/${id}`));
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      const generations: number[] = [];
      for (const snap of snaps) {
        const data = snap.data();
        // A second retry can be running beside this one. Never erase a newer
        // claim (or a tombstone) after the first retry has settled or re-batched
        // these rows; ownership is the exact batch id, while `sentAt === null`
        // prevents a stale abandon from resurrecting delivered work.
        if (!data || data.batchId !== batchId || data.sentAt !== null) return false;
        generations.push(
          typeof data.requeueGeneration === 'number' && Number.isInteger(data.requeueGeneration)
            ? data.requeueGeneration
            : 0,
        );
      }
      if (event?.status === 'archived') {
        for (const ref of refs) {
          tx.set(ref, {
            discardedAt: now,
            expiresAt: new Date(now + TOMBSTONE_TTL_MS),
          });
        }
      } else {
        const nextGeneration = Math.max(0, ...generations) + 1;
        for (const ref of refs) {
          tx.set(ref, { batchId: null, requeueGeneration: nextGeneration }, { merge: true });
        }
      }
      tx.delete(db.doc(batchPath(eventId, batchId)));
      return event?.status === 'archived' ? ('discarded' as const) : ('released' as const);
    });
    if (!released) {
      console.log(`sendAdminDigestForEvent: batch ${batchId} changed before it could be released`, eventId);
      return 'stale';
    }
    return released;
  } catch (err) {
    console.error('sendAdminDigestForEvent: releasing the batch failed (it stays claimed)', eventId, err);
    return 'failed';
  }
}

async function finishBatch(
  db: AdminAlertFirestore,
  eventId: string,
  batchId: string,
  ids: readonly string[],
  now: number,
): Promise<void> {
  try {
    const batch = db.batch();
    for (const id of ids) {
      batch.set(db.doc(`events/${eventId}/adminAlerts/${id}`), {
        sentAt: now,
        // A Date, NOT epoch millis: Firestore's TTL service only considers a
        // timestamp-typed field, and the admin SDK converts a Date on write.
        expiresAt: new Date(now + TOMBSTONE_TTL_MS),
      });
    }
    // The frozen request dies WITH the batch, in the same commit. It holds a
    // rendered copy of unapproved content, so it must not outlive the delivery
    // it existed for — and it must not be released BEFORE the rows, or a retry
    // would find claimed rows with no frozen bytes and rebuild them.
    batch.delete(db.doc(batchPath(eventId, batchId)));
    await batch.commit();
  } catch (err) {
    console.error('sendAdminDigestForEvent: queue clean-up failed (alerts stay pending)', eventId, err);
  }
}

/**
 * Retire admin-alert work whose Event is archived.
 *
 * A frozen request is the delivery boundary: it may already have been accepted
 * by Resend even when the Function never observed success, so its rows retain
 * their exact claim for the ordinary replay path. Everything else is safe to
 * discard because this queue always freezes before sending.
 *
 * The Event, rows, and referenced freeze documents are read in one transaction.
 * That makes a concurrent reactivation or freeze creation invalidate the read
 * rather than letting archive cleanup erase newer live work or an externally
 * committed delivery identity.
 */
export async function settleAdminAlertsForArchivedEvent(
  db: AdminAlertFirestore,
  eventId: string,
  deps: AdminDigestDeps = {},
): Promise<ArchiveSettlementResult> {
  const now = (deps.now ?? Date.now)();
  const pending = await db
    .collection(`events/${eventId}/adminAlerts`)
    .where('sentAt', '==', null)
    .limit(MAX_ALERTS_PER_DIGEST)
    .get();
  if (pending.docs.length === 0) return { discarded: 0, preserved: 0 };

  const result = await db.runTransaction(async (tx) => {
    const event = (await tx.get(db.doc(`events/${eventId}`))).data();
    if (event?.status !== 'archived') return { discarded: 0, preserved: 0 };

    const rows = await Promise.all(
      pending.docs.map(async (snapshot) => ({
        id: snapshot.id,
        ref: db.doc(`events/${eventId}/adminAlerts/${snapshot.id}`),
      })),
    );
    const rowSnaps = await Promise.all(rows.map(({ ref }) => tx.get(ref)));
    const batchIds = [
      ...new Set(
        rowSnaps
          .map((snapshot) => snapshot.data()?.batchId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ];
    const frozen = new Set<string>();
    const batchSnaps = await Promise.all(batchIds.map((batchId) => tx.get(db.doc(batchPath(eventId, batchId)))));
    batchSnaps.forEach((snapshot, index) => {
      if (snapshot.data() !== undefined) frozen.add(batchIds[index]);
    });

    let discarded = 0;
    let preserved = 0;
    rows.forEach(({ ref }, index) => {
      const data = rowSnaps[index].data();
      if (!data || data.sentAt !== null) return;
      const batchId = typeof data.batchId === 'string' && data.batchId ? data.batchId : null;
      if (batchId && frozen.has(batchId)) {
        preserved++;
        return;
      }
      tx.set(ref, {
        discardedAt: now,
        expiresAt: new Date(now + TOMBSTONE_TTL_MS),
      });
      discarded++;
    });
    return { discarded, preserved };
  });
  if (result.preserved > 0) {
    const replay = await sendAdminDigestForEvent(db, eventId, deps);
    if (replay.reason === 'inactive-event') {
      return { discarded: result.discarded + result.preserved, preserved: 0 };
    }
  }
  return result;
}

/**
 * One sweep across every Event with relevant queue lifecycle work. Active
 * Events deliver pending alerts; archived Events deliberately discard
 * uncommitted work and replay frozen requests. Best-effort per Event: one
 * Event's failure is logged and skipped rather than crashing the run.
 *
 * The two status queries intentionally cover both live delivery and archive
 * cleanup. The archive pass is the retrying backstop for transition-trigger
 * failure and for any delayed producer that lost the archive race.
 */
export async function runAdminAlertSweep(
  db: AdminAlertFirestore,
  deps: AdminDigestDeps = {},
): Promise<void> {
  const events = await db.collection('events').where('status', '==', 'active').get();
  for (const ev of events.docs) {
    try {
      await sendAdminDigestForEvent(db, ev.id, deps);
    } catch (err) {
      console.error('runAdminAlertSweep: event failed', ev.id, err);
    }
  }
  const archived = await db.collection('events').where('status', '==', 'archived').get();
  for (const ev of archived.docs) {
    try {
      await settleAdminAlertsForArchivedEvent(db, ev.id, deps);
    } catch (err) {
      console.error('runAdminAlertSweep: archived event failed', ev.id, err);
    }
  }
}

/** One scheduler invocation, with the durable-retry and digest legs isolated. */
export async function runAdminAlertCycle(
  db: AdminAlertFirestore,
  deps: AdminDigestDeps & AbuseEscalationSweepDeps = {},
): Promise<void> {
  // Both legs share a scheduler timeout but not a liveness dependency. Run
  // them concurrently so a slow relationship lookup cannot consume the whole
  // invocation before ordinary moderation alerts begin draining.
  await Promise.all([
    runAbuseEscalationSweep(db, deps).catch((err) => {
      console.error('runAdminAlertCycle: abuse escalation sweep failed', err);
    }),
    runAdminAlertSweep(db, deps).catch((err) => {
      console.error('runAdminAlertCycle: admin digest sweep failed', err);
    }),
  ]);
}
