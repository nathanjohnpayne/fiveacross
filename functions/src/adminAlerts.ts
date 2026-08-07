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
 *   covering everything queued since the last drain, and stamps each alert
 *   `sentAt`.
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
import { resolveAdminEmails, type ResolveDeps } from './notify';
import { resolveEventOrigin } from './dailyEmail';
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
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
}
interface AlertQuery {
  where(field: string, op: string, value: unknown): AlertQuery;
  limit(count: number): AlertQuery;
  get(): Promise<{ docs: AlertSnapshot[] }>;
}
interface AlertCollectionRef extends AlertQuery {
  add(data: Record<string, unknown>): Promise<{ id: string }>;
}
/** The minimal surface the queue and its sweep use. */
export interface AdminAlertFirestore {
  doc(path: string): AlertDocRef;
  collection(path: string): AlertCollectionRef;
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
  | 'moderation';

/** The two collections an alert can be about. */
export type AlertedCollection = 'items' | 'proofs';

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

/** How long a Prompt's words may run in a digest row before they are clipped.
 *  `ItemDoc.text` is already clamped to 80 characters at every write path, so
 *  this only ever bites on legacy or hand-seeded data. */
export const LABEL_MAX = 80;

function labelFor(collection: AlertedCollection, docId: string, doc: AlertableDoc): string {
  const raw = (collection === 'items' ? doc.text : doc.itemText) ?? '';
  const trimmed = raw.trim();
  if (!trimmed) return docId;
  return trimmed.length > LABEL_MAX ? `${trimmed.slice(0, LABEL_MAX - 1)}…` : trimmed;
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
  collection: AlertedCollection,
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
}

/**
 * Append this write's alerts to the Event's queue. Best-effort and NEVER throws
 * (ADR 0001): a queue write failing must not fail the moderation write that
 * triggered it, exactly as the #101 notifier's mail failure never did. Returns
 * how many alerts it wrote.
 *
 * `sentAt: null` is written EXPLICITLY rather than left absent, because the
 * sweep finds work with `where('sentAt', '==', null)` and Firestore's equality
 * filter matches a stored null but not a missing field — an alert without the
 * field would sit in the collection forever, invisible to the drain.
 */
export async function enqueueAdminAlerts(
  db: AdminAlertFirestore,
  eventId: string,
  drafts: readonly AdminAlertDraft[],
  deps: EnqueueDeps = {},
): Promise<number> {
  if (drafts.length === 0) return 0;
  const createdAt = (deps.now ?? Date.now)();
  let written = 0;
  for (const draft of drafts) {
    try {
      await db.collection(`events/${eventId}/adminAlerts`).add({ ...draft, createdAt, sentAt: null });
      written++;
    } catch (err) {
      console.error('enqueueAdminAlerts: write failed', eventId, draft.kind, draft.docId, err);
    }
  }
  return written;
}

/** The whole producer side in one call — the shape `index.ts`'s trigger seams
 *  use, so the seam stays three lines and the decision stays testable here. */
export async function recordAdminAlerts(
  db: AdminAlertFirestore,
  collection: AlertedCollection,
  eventId: string,
  docId: string,
  before: AlertableDoc | undefined,
  after: AlertableDoc | undefined,
  deps: EnqueueDeps = {},
): Promise<number> {
  try {
    return await enqueueAdminAlerts(db, eventId, alertsForWrite(collection, docId, before, after), deps);
  } catch (err) {
    console.error('recordAdminAlerts failed', eventId, collection, docId, err);
    return 0;
  }
}

// --- Consuming (the digest sweep) ------------------------------------------------

/**
 * Alerts drained per Event per sweep. A ceiling, not a batch size: a bigger
 * backlog simply spans consecutive sweeps, because everything drained is
 * stamped `sentAt` and the next run picks up where this one stopped. It exists
 * to bound a pathological queue (a runaway import), not to size normal work.
 */
export const MAX_ALERTS_PER_DIGEST = 200;

/** Milliseconds between digest sweeps, mirrored in `index.ts`'s cron. Stated
 *  here so the doc comment and the schedule cannot drift silently. */
export const DIGEST_INTERVAL_MINUTES = 5;

export interface AdminDigestDeps extends ResolveDeps, EnqueueDeps {
  /** Override the send transport (defaults to `sendEmail`). */
  send?: typeof sendEmail;
  /** Sender identity; defaults to the `EMAIL_FROM` param. */
  from?: string;
  /** Fallback origin when the Event has no hostname documents; defaults to the
   *  `APP_BASE_URL` param. */
  appBaseUrl?: string;
  /** Alerts drained per Event per run; defaults to `MAX_ALERTS_PER_DIGEST`. */
  maxAlerts?: number;
}

export interface AdminDigestResult {
  /** Alerts covered by a delivered email. */
  sent: number;
  /** Why nothing was sent, when nothing was. */
  reason?: 'no-alerts' | 'no-event' | 'no-recipients' | 'send-failed';
}

/** Read one alert snapshot into the record the digest renders, dropping rows
 *  whose shape is unusable. A hand-written or half-migrated document must not
 *  throw here — one bad row would suppress the whole Event's digest. */
function toRecord(snap: AlertSnapshot): AdminAlertRecord | null {
  const data = snap.data();
  if (!data) return null;
  const kind = data.kind;
  const collection = data.collection;
  if (kind !== 'item-created' && kind !== 'content-reported' && kind !== 'moderation') return null;
  if (collection !== 'items' && collection !== 'proofs') return null;
  return {
    id: snap.id,
    kind,
    collection,
    docId: typeof data.docId === 'string' ? data.docId : '',
    label: typeof data.label === 'string' && data.label ? data.label : '(untitled)',
    status: typeof data.status === 'string' ? data.status : 'unknown',
    visionFlag: typeof data.visionFlag === 'string' && data.visionFlag ? data.visionFlag : null,
    reportCount: typeof data.reportCount === 'number' ? data.reportCount : 0,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
  };
}

/**
 * Drain one Event's queue into a single digest. Idempotent in the way that
 * matters: a run that sends but fails to stamp leaves the same alerts pending,
 * and the next run rebuilds the same set — which produces the same idempotency
 * key, so Resend collapses the duplicate inside its 24h window.
 */
export async function sendAdminDigestForEvent(
  db: AdminAlertFirestore,
  eventId: string,
  deps: AdminDigestDeps = {},
): Promise<AdminDigestResult> {
  const maxAlerts = deps.maxAlerts ?? MAX_ALERTS_PER_DIGEST;
  const snap = await db
    .collection(`events/${eventId}/adminAlerts`)
    .where('sentAt', '==', null)
    .limit(maxAlerts)
    .get();
  const alerts = snap.docs.map(toRecord).filter((a): a is AdminAlertRecord => a !== null);
  if (alerts.length === 0) return { sent: 0, reason: 'no-alerts' };

  const event = (await db.doc(`events/${eventId}`).get()).data() as DigestEvent | undefined;
  if (!event) return { sent: 0, reason: 'no-event' };

  // The roster resolves from the Event's `admins` UIDs unioned with the
  // ADMIN_NOTIFY_EMAIL override — one lookup for the whole digest rather than
  // one per alert, which is the other half of why this is batched.
  const to = await resolveAdminEmails(eventId, deps);
  if (to.length === 0) {
    console.log(`sendAdminDigestForEvent: no admin emails for event ${eventId}; leaving ${alerts.length} queued`);
    return { sent: 0, reason: 'no-recipients' };
  }

  const appBaseUrl = deps.appBaseUrl ?? (await import('./params')).APP_BASE_URL.value();
  const from = deps.from ?? (await import('./params')).EMAIL_FROM.value();
  const send = deps.send ?? (await import('./email')).sendEmail;
  const now = (deps.now ?? Date.now)();
  // A FAILED hostname read is not a confirmed absence: falling back would erase
  // the Event's Edition and put the legacy brand line on a Vacay/Five Across
  // digest. Let the sweep boundary log and skip; the next run retries safely.
  const { origin, edition } = await resolveEventOrigin(db, eventId, appBaseUrl);

  const model = buildAdminDigestModel({ event, eventId, alerts, edition, origin, now });
  // Stable for a given SET of alerts: a retry of the same drain dedupes at
  // Resend, while an alert arriving in between changes the set — a different
  // key, which delivers, because that genuinely is new news.
  const newest = alerts.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const ok = await send({
    to,
    subject: model.subject,
    html: renderAdminDigestHtml(model),
    text: renderAdminDigestText(model),
    from,
    idempotencyKey: `admin-digest/${eventId}/${newest.id}/${alerts.length}`,
  });
  if (!ok) return { sent: 0, reason: 'send-failed' };

  // Stamped only AFTER a clean send. Each stamp is independently caught so one
  // failure cannot strand the rest — the worst case is a repeat of an already
  // delivered row, which the idempotency key above already collapses.
  for (const alert of alerts) {
    try {
      await db.doc(`events/${eventId}/adminAlerts/${alert.id}`).set({ sentAt: now }, { merge: true });
    } catch (err) {
      console.error('sendAdminDigestForEvent: stamp failed', eventId, alert.id, err);
    }
  }
  console.log(`sendAdminDigestForEvent ${eventId}: sent=${alerts.length} to=${to.length}`);
  return { sent: alerts.length };
}

/**
 * One sweep across every active Event. Best-effort per Event: one Event's
 * failure is logged and skipped rather than crashing the run.
 *
 * Scoped to ACTIVE Events, mirroring `runDailyEmailSweep`. An archived Event
 * has no live surface to moderate, and its queue drains the moment it is
 * reactivated rather than being lost.
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
}
