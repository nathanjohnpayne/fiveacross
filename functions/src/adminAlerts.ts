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
  /** Admin-SDK `DocumentReference.create` — writes ONLY if the document does
   *  not exist, rejecting with ALREADY_EXISTS otherwise. Load-bearing: it is
   *  what makes the enqueue idempotent under trigger redelivery (see
   *  `enqueueAdminAlerts`). Mirrors `emailOptOut.ts`'s use of the same call. */
  create(data: Record<string, unknown>): Promise<unknown>;
}
interface AlertQuery {
  where(field: string, op: string, value: unknown): AlertQuery;
  limit(count: number): AlertQuery;
  get(): Promise<{ docs: AlertSnapshot[] }>;
}
/** The minimal atomic-write surface the drain needs. An admin-SDK `WriteBatch`
 *  commits all-or-nothing, which is the whole reason the drain uses one. `set`
 *  WITHOUT merge, so the tombstone REPLACES the row rather than joining it. */
interface AlertWriteBatch {
  set(ref: AlertDocRef, data: Record<string, unknown>): void;
  commit(): Promise<unknown>;
}
/** The minimal surface the queue and its sweep use. */
export interface AdminAlertFirestore {
  doc(path: string): AlertDocRef;
  collection(path: string): AlertQuery;
  batch(): AlertWriteBatch;
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
 * Append this write's alerts to the Event's queue. Best-effort and NEVER throws
 * (ADR 0001): a queue write failing must not fail the moderation write that
 * triggered it, exactly as the #101 notifier's mail failure never did. Returns
 * how many alerts it wrote.
 *
 * `create` rather than `set`, and a deterministic id rather than a random one,
 * so a redelivered trigger is a no-op. `set` would be wrong in the one case
 * that matters: a redelivery arriving after the digest drained would re-create
 * the alert and mail it a second time.
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
  transitionId: string,
  deps: EnqueueDeps = {},
): Promise<number> {
  if (drafts.length === 0) return 0;
  const createdAt = (deps.now ?? Date.now)();
  let written = 0;
  for (const draft of drafts) {
    const id = alertDocId(transitionId, draft.kind);
    try {
      await db
        .doc(`events/${eventId}/adminAlerts/${id}`)
        .create({ ...draft, createdAt, sentAt: null });
      written++;
    } catch (err) {
      // ALREADY_EXISTS is the redelivery path and is a SUCCESS: the alert this
      // call would have written is already queued. Anything else is a real
      // failure, logged and swallowed.
      if (isAlreadyExists(err)) continue;
      console.error('enqueueAdminAlerts: write failed', eventId, draft.kind, draft.docId, err);
    }
  }
  return written;
}

/** Firestore surfaces ALREADY_EXISTS as gRPC status 6; the emulator and some
 *  SDK versions only carry it in the message, so both are checked. */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 6 || code === 'already-exists') return true;
  return /already exists/i.test((err as { message?: string } | null)?.message ?? '');
}

/** The whole producer side in one call — the shape `index.ts`'s trigger seams
 *  use, so the seam stays three lines and the decision stays testable here.
 *  `transitionId` is the triggering write's CloudEvent id (#101 Codex F3),
 *  which makes a redelivered trigger idempotent rather than duplicative. */
export async function recordAdminAlerts(
  db: AdminAlertFirestore,
  collection: AlertedCollection,
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

// --- Consuming (the digest sweep) ------------------------------------------------

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
 * redelivery of an already-mailed transition arrives. `create` fails on an id
 * that exists, so the tombstone is what keeps the deterministic-id dedup honest
 * once the payload row itself is gone.
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

/** Minutes between digest sweeps, mirrored in `index.ts`'s cron. Stated here so
 *  the doc comment and the schedule cannot drift silently. */
export const DIGEST_INTERVAL_MINUTES = 5;

export interface AdminDigestDeps extends ResolveDeps, EnqueueDeps {
  /** Override the send transport (defaults to `sendEmail`). */
  send?: typeof sendEmail;
  /** Sender identity; defaults to the `EMAIL_FROM` param. */
  from?: string;
  /** Fallback origin when the Event has no hostname documents; defaults to the
   *  `APP_BASE_URL` param. */
  appBaseUrl?: string;
  /** Alerts drained per Event per run; defaults to `MAX_ALERTS_PER_DIGEST`,
   *  clamped to `MAX_ATOMIC_WRITES`. */
  maxAlerts?: number;
}

export interface AdminDigestResult {
  /** Alerts covered by a delivered email. */
  sent: number;
  /** Queue rows retired without a row in the email: resolved since they were
   *  queued, or unreadable. Tombstoned either way, so they stop consuming the
   *  drain limit forever. */
  retired: number;
  /** Why nothing was sent, when nothing was. */
  reason?: 'no-alerts' | 'no-event' | 'no-recipients' | 'send-failed' | 'nothing-current';
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
  const docId = typeof data.docId === 'string' ? data.docId : '';
  if (!docId) return null;
  return {
    id: snap.id,
    kind,
    collection,
    docId,
    label: typeof data.label === 'string' && data.label ? data.label : '(untitled)',
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
 * THE KEY IS DERIVED FROM THE RAW DRAINED PAGE, not from the revalidated rows.
 * Those are different sets, and only the first one is stable: if the send lands
 * but the clean-up does not, an admin can resolve one item before the next
 * sweep, and live revalidation would then drop that row and change a
 * `current`-derived key — so Resend would accept a SECOND email repeating every
 * unresolved row from the first. The queue page cannot move that way, because
 * the atomic clean-up leaves it byte-identical. It is reduced order-independently
 * (max id + count) because the drain query carries no `orderBy`.
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
export async function sendAdminDigestForEvent(
  db: AdminAlertFirestore,
  eventId: string,
  deps: AdminDigestDeps = {},
): Promise<AdminDigestResult> {
  const maxAlerts = Math.min(deps.maxAlerts ?? MAX_ALERTS_PER_DIGEST, MAX_ATOMIC_WRITES);
  const snap = await db
    .collection(`events/${eventId}/adminAlerts`)
    .where('sentAt', '==', null)
    .limit(maxAlerts)
    .get();
  if (snap.docs.length === 0) return { sent: 0, retired: 0, reason: 'no-alerts' };

  // Unreadable rows are RETIRED, not merely skipped. Skipping them leaves them
  // pending forever, and a page of malformed documents would then occupy the
  // whole drain limit on every sweep — starving valid alerts behind it
  // indefinitely. They are cleared alongside whatever is delivered.
  const unreadable: string[] = [];
  const alerts: AdminAlertRecord[] = [];
  for (const doc of snap.docs) {
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
  const live = new Map<string, { doc: AlertableDoc | undefined; failed: boolean }>();
  for (const key of new Set(alerts.map((a) => `${a.collection}/${a.docId}`))) {
    try {
      live.set(key, { doc: (await db.doc(`events/${eventId}/${key}`).get()).data() as AlertableDoc | undefined, failed: false });
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
    await tombstoneAlerts(db, eventId, retireOnly, (deps.now ?? Date.now)());
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
  const from = deps.from ?? (await import('./params')).EMAIL_FROM.value();
  const send = deps.send ?? (await import('./email')).sendEmail;
  const now = (deps.now ?? Date.now)();
  // A FAILED hostname read is not a confirmed absence: falling back would erase
  // the Event's Edition and put the legacy brand line on a Vacay/Five Across
  // digest. Let the sweep boundary log and skip; the next run retries safely.
  const { origin, edition } = await resolveEventOrigin(db, eventId, appBaseUrl);

  const model = buildAdminDigestModel({ event, eventId, alerts: current, edition, origin, now });
  const ok = await send({
    to,
    subject: model.subject,
    html: renderAdminDigestHtml(model),
    text: renderAdminDigestText(model),
    from,
    idempotencyKey: `admin-digest/${eventId}/${drainKey(snap.docs.map((d) => d.id))}`,
  });
  if (!ok) return { sent: 0, retired: 0, reason: 'send-failed' };

  await tombstoneAlerts(db, eventId, [...retireOnly, ...current.map((a) => a.id)], now);
  console.log(
    `sendAdminDigestForEvent ${eventId}: sent=${current.length} retired=${retireOnly.length} to=${to.length}`,
  );
  return { sent: current.length, retired: retireOnly.length };
}

/**
 * The delivery identity of one drain, reduced from the RAW queue page in a way
 * that does not depend on the order Firestore happened to return it in: the
 * greatest document id plus the count. The drain query carries no `orderBy`
 * (deliberately — an equality filter with a `limit` rides the automatic index),
 * so a position-sensitive reduction could shuffle between two sweeps over an
 * identical page and mint a different key for the same email.
 */
export function drainKey(ids: readonly string[]): string {
  const max = [...ids].sort().pop() ?? 'empty';
  return `${max}/${ids.length}`;
}

/**
 * Replace drained queue rows with tombstones in ONE atomic batch.
 *
 * `set` without merge, so the row's payload — including its copy of unapproved
 * or hidden user content — is REPLACED by two numbers rather than joined by
 * them. What survives is the document ID, which is the point: it is derived
 * from the triggering CloudEvent id, so a delayed redelivery of an
 * already-mailed transition still fails its `create` instead of queueing the
 * same alert a second time. `expiresAt` is a `Date` so the documented TTL
 * policy can actually reap it (see `TOMBSTONE_TTL_MS`).
 *
 * All-or-nothing is the other half (see `sendAdminDigestForEvent`), so a commit
 * failure is logged and swallowed rather than retried per-document: leaving
 * every row pending is the safe, self-healing outcome, and the next sweep
 * rebuilds the same key and dedupes at Resend.
 */
async function tombstoneAlerts(
  db: AdminAlertFirestore,
  eventId: string,
  ids: readonly string[],
  now: number,
): Promise<void> {
  if (ids.length === 0) return;
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
    await batch.commit();
  } catch (err) {
    console.error('sendAdminDigestForEvent: queue clean-up failed (alerts stay pending)', eventId, err);
  }
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
