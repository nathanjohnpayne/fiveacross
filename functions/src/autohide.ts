/**
 * Server-authoritative reactive auto-hide (issue #43, ADR 0004 Phase 1).
 *
 * Promotes the Phase-0 client-side presentational hide (src/data/moderation.ts
 * `isReportHidden`, #107) to an AUTHORITATIVE removal: when a Proof or Prompt's
 * `reportCount` CROSSES up to its Event's `settings.reportHideThreshold`, a
 * Cloud Function (admin SDK, which BYPASSES security rules) flips its `status`
 * to `'hidden'`. The client filter stays as the Phase-0 fallback; this makes the
 * hide real for every reader, not just cooperating clients.
 *
 * Composition (the point, per #43): the `status → 'hidden'` transition THIS
 * writes is exactly the transition `notify.ts` `deriveReason` labels
 * `(reports >= threshold)`, so the #101 auto-hide admin email is the downstream
 * reaction to this write — this module never touches `notify.ts`/`moderateProof`.
 *
 * Every write goes through a TRANSACTIONAL re-read guard (`hideIfQualifies`) that
 * re-confirms the LIVE doc + threshold state before writing, so a delayed trigger
 * can never act on the stale event snapshot (round 2 F1). The Firestore surface
 * is injectable so the whole flow is unit-testable without a Functions runtime
 * (mirrors `notify.ts`).
 */

/** The subset of a Proof/Prompt doc the auto-hide reads. */
export interface ReportableDoc {
  status?: string;
  reportCount?: number;
}

/** A candidate doc surfaced by the backfill query (id + the two fields it gates on). */
export interface ReportableCandidate extends ReportableDoc {
  id: string;
}

/** The two collections whose report counts can trip the auto-hide. */
export type ModeratedCollection = 'items' | 'proofs';

/**
 * Pure predicate: does THIS write LOOK like a fresh reason to attempt a hide?
 *
 * True iff the doc is currently `'active'`, the threshold is POSITIVE, and
 * `reportCount` ROSE on this write to land at/over the threshold
 * (`before.reportCount < after.reportCount` AND `after.reportCount >= threshold`).
 * This is the SNAPSHOT-level gate (decides whether to attempt); the live
 * re-confirmation before the actual write is `stillQualifiesForHide` inside the
 * transaction. "Rose to at/over" — rather than a strict below→over CROSSING — is
 * deliberate: it covers BOTH the initial crossing AND a RETRY. If the first
 * crossing hit the swallowed best-effort catch (a transient threshold-read or
 * transaction failure) the doc stays `active` at/over the threshold, and under a
 * strict crossing the NEXT bump (`before` already >= threshold) would never
 * re-attempt, leaving an over-threshold doc readable (Codex R3 F2). Four
 * properties ride on this shape:
 *
 *   - Active-only (F2, Codex R1). ONLY an `'active'` doc is auto-hidden. A
 *     `'flagged'` (Vision) or `'pending'` (admin_confirmed claim) doc that a
 *     stale/queued report bump carries over the threshold is LEFT ALONE, so the
 *     stronger moderation state is never downgraded to a plain `'hidden'` — one
 *     an admin could Restore without ever learning the media was Vision-flagged.
 *     Moving a `'flagged'` doc to `'hidden'` belongs to the writer that knows why
 *     it is flagged and leaves `visionFlag` on the doc: `./visionHide` (#133).
 *     This gate is also the loop guard: our own hide write makes the doc
 *     `'hidden'` (not active), so the re-fired `onDocumentWritten` no-ops.
 *   - Rose, not a bare `count >= threshold`. Admin restore is preserved:
 *     `restoreItem`/`restoreProof` (src/data/admin.ts) set `status → 'active'`
 *     but deliberately leave `reportCount` over the threshold. That write does
 *     NOT raise `reportCount`, so it is not a rise and is NOT re-hidden — the
 *     restore sticks (until the community reports it AGAIN and the count rises).
 *   - Retry-safe under the transaction. Broadening to "rose" is safe because the
 *     actual write still goes through `hideIfQualifies`, which re-reads live state
 *     — a doc an admin Cleared below threshold between the bump and the write
 *     no-ops regardless.
 *   - Fail-safe. The `threshold > 0` guard mirrors `isReportHidden`: an unset /
 *     zero / negative / non-numeric threshold hides NOTHING, so a single admin
 *     typo can never server-hide the whole pool. `before` undefined (a create)
 *     counts as `reportCount` 0, so a create straight over the threshold is a rise.
 */
export function shouldHideAtThreshold(
  before: ReportableDoc | undefined,
  after: ReportableDoc | undefined,
  threshold: number | null | undefined,
): boolean {
  if (!after) return false; // delete — nothing to hide
  if (after.status !== 'active') return false; // active-only (F2) + loop guard: never downgrade flagged/pending/hidden
  if (typeof threshold !== 'number' || threshold <= 0) return false; // fail-safe: unset/non-positive hides nothing
  const beforeCount = before?.reportCount ?? 0;
  const afterCount = after.reportCount ?? 0;
  return afterCount > beforeCount && afterCount >= threshold; // rose to at/over (initial crossing OR retry)
}

/**
 * Pure predicate: does the doc's CURRENT (live, transaction-read) state still
 * warrant a hide? True iff it is `'active'`, the threshold is positive, and
 * `reportCount` is at/over it. This is the write-time re-confirmation (round 2
 * F1): a delayed trigger or a racing sweep whose doc was cleared below threshold,
 * hidden, or deleted since the event snapshot no longer qualifies, so we never
 * undo an admin Clear-reports or re-hide a restored/deleted doc.
 */
export function stillQualifiesForHide(
  data: ReportableDoc | undefined,
  threshold: number | null | undefined,
): boolean {
  if (!data || data.status !== 'active') return false;
  if (typeof threshold !== 'number' || threshold <= 0) return false;
  return (data.reportCount ?? 0) >= threshold;
}

// --- Admin-SDK Firestore surface (minimal, injectable) --------------------------

/** A read snapshot: existence + id + the doc data. */
interface DocSnapshot {
  readonly exists: boolean;
  readonly id: string;
  data(): Record<string, unknown> | undefined;
}
interface DocRef {
  get(): Promise<DocSnapshot>;
}
interface QueryRef {
  get(): Promise<{ docs: DocSnapshot[] }>;
}
/** The transaction handle: reads (before writes) + a conditional update. */
interface Transaction {
  get(ref: DocRef): Promise<DocSnapshot>;
  update(ref: DocRef, data: Record<string, unknown>): void;
}
/** The minimal admin-SDK Firestore surface the defaults use. */
export interface AdminFirestore {
  doc(path: string): DocRef;
  collection(path: string): QueryRef & { where(field: string, op: string, value: unknown): QueryRef };
  runTransaction<T>(updateFunction: (tx: Transaction) => Promise<T>): Promise<T>;
}

function readThreshold(data: Record<string, unknown> | undefined): number | null {
  const settings = data?.settings as { reportHideThreshold?: unknown } | undefined;
  return typeof settings?.reportHideThreshold === 'number' ? settings.reportHideThreshold : null;
}

/**
 * The lazily-imported admin-SDK Firestore handle every default in this module
 * uses. EXPORTED (and only exported) so the sibling Vision hide (`./visionHide`,
 * #133) shares one handle factory and one `AdminFirestore` surface instead of
 * redeclaring them — the second server-authoritative writer must reach Firestore
 * exactly the way this one does. Nothing about the report-count path changes.
 */
export async function adminFirestore(): Promise<AdminFirestore> {
  const { getFirestore } = await import('firebase-admin/firestore');
  return getFirestore() as unknown as AdminFirestore;
}

/**
 * Initialize the default admin app if none exists — used only by the rollout
 * script. Mirrors `scripts/seed.mjs`'s credential logic (Codex R3 F1): when the
 * caller passes a parsed `serviceAccountKey.json`, authenticate with `cert(...)`;
 * otherwise fall back to Application Default Credentials. Runs inside the functions
 * package so `getFirestore()` (also functions-scoped) sees the app it initializes.
 */
export async function ensureAdminApp(serviceAccountKey?: Record<string, unknown>): Promise<void> {
  const { getApps, initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  if (getApps().length > 0) return;
  initializeApp(
    serviceAccountKey
      ? { credential: cert(serviceAccountKey as Parameters<typeof cert>[0]) }
      : { credential: applicationDefault() },
  );
}

/**
 * Transactionally flip one doc to `'hidden'` ONLY if its LIVE state still
 * qualifies (round 2 F1). Reads the target doc and the Event threshold inside a
 * transaction, then writes `status: 'hidden'` with `tx.update` (never a
 * re-creating set) iff `stillQualifiesForHide`:
 *
 *   - a doc an admin Cleared below threshold since the trigger fired → no-op, so
 *     the admin's lift is not silently undone;
 *   - a doc already hidden / flagged / pending, or DELETED (snapshot missing) →
 *     no-op, no re-create (subsumes the round-1 F1 update-not-set guarantee);
 *   - a threshold raised past the count, or cleared to non-positive → no-op.
 *
 * `db` is a parameter so the read-then-conditional-write is unit-testable with a
 * fake transaction. Returns whether it wrote.
 */
export async function hideIfQualifies(
  db: AdminFirestore,
  collection: ModeratedCollection,
  eventId: string,
  docId: string,
): Promise<boolean> {
  const docRef = db.doc(`events/${eventId}/${collection}/${docId}`);
  const eventRef = db.doc(`events/${eventId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return false; // deleted since the snapshot — never re-create
    const eventSnap = await tx.get(eventRef);
    const threshold = readThreshold(eventSnap.data());
    if (!stillQualifiesForHide(snap.data() as ReportableDoc | undefined, threshold)) return false;
    tx.update(docRef, { status: 'hidden' });
    return true;
  });
}

async function defaultHideIfQualifies(collection: ModeratedCollection, eventId: string, docId: string): Promise<boolean> {
  return hideIfQualifies(await adminFirestore(), collection, eventId, docId);
}

export interface AutoHideDeps {
  /** Read the Event's `settings.reportHideThreshold`; defaults to an admin-SDK doc read. */
  getReportHideThreshold?: (eventId: string) => Promise<number | null>;
  /** Transactionally hide the doc iff its live state still qualifies; defaults to `hideIfQualifies`. */
  hideIfQualifies?: (collection: ModeratedCollection, eventId: string, docId: string) => Promise<boolean>;
}

async function defaultGetReportHideThreshold(eventId: string): Promise<number | null> {
  const db = await adminFirestore();
  return readThreshold((await db.doc(`events/${eventId}`).get()).data());
}

/**
 * Best-effort: read the Event threshold, decide via `shouldHideAtThreshold` on the
 * event snapshot, then hand off to the TRANSACTIONAL `hideIfQualifies`, which
 * re-confirms live state before writing (round 2 F1). Never throws — a read/write
 * failure is swallowed so the trigger never crashes the pipeline (ADR 0001;
 * mirrors `moderateProof` and the #101 notifier). Returns whether it hid the doc.
 *
 * Cheap short-circuits run BEFORE the threshold read so the common no-op re-fires
 * (deletes, non-active docs — flagged/pending/hidden — and writes that did not
 * raise `reportCount`: admin hides/restores, claim confirms, and our own hide
 * write) never pay for a read: a crossing is impossible unless the doc is active
 * AND `reportCount` strictly rose.
 */
export async function applyThresholdHide(
  collection: ModeratedCollection,
  eventId: string,
  docId: string,
  before: ReportableDoc | undefined,
  after: ReportableDoc | undefined,
  deps: AutoHideDeps = {},
): Promise<boolean> {
  try {
    if (!after || after.status !== 'active') return false; // active-only (F2) + loop guard
    const beforeCount = before?.reportCount ?? 0;
    const afterCount = after.reportCount ?? 0;
    if (afterCount <= beforeCount) return false; // reportCount did not rise — no crossing possible; skip the read
    const threshold = await (deps.getReportHideThreshold ?? defaultGetReportHideThreshold)(eventId);
    if (!shouldHideAtThreshold(before, after, threshold)) return false;
    // Snapshot says a fresh crossing; re-confirm LIVE state transactionally so a
    // delayed trigger cannot undo an admin Clear-reports (round 2 F1).
    return await (deps.hideIfQualifies ?? defaultHideIfQualifies)(collection, eventId, docId);
  } catch (err) {
    console.error('applyThresholdHide failed', err);
    return false;
  }
}

// --- Threshold-decrease backfill (F3, Codex R1) ---------------------------------
//
// The per-write hide above fires only on a fresh CROSSING, so LOWERING an Event's
// settings.reportHideThreshold below reports that already exist would never
// server-hide those already-over-threshold docs (no new crossing; later bumps
// no-op because beforeCount already exceeds the new threshold). For a
// server-AUTHORITATIVE hide that is a real hole. A light trigger on the Event doc
// closes it: when the threshold DECREASES (or is enabled from unset), sweep the
// Event's own items + proofs and hide the active docs that now meet the lower bar.

export interface BackfillDeps {
  /**
   * Candidate reported docs in one subcollection (id + status + reportCount).
   * Defaults to a `reportCount >= threshold` query (single-field auto-index — no
   * composite index); the active-only pre-filter happens in the caller and the
   * live re-confirm happens in `hideIfQualifies`, so no `status` clause is needed.
   */
  queryReportedDocs?: (
    collection: ModeratedCollection,
    eventId: string,
    threshold: number,
  ) => Promise<ReportableCandidate[]>;
  /** Transactionally hide one doc iff its live state still qualifies (round 2 F1). */
  hideIfQualifies?: (collection: ModeratedCollection, eventId: string, docId: string) => Promise<boolean>;
}

/**
 * Pure predicate: given the Event's before/after `reportHideThreshold`, does a
 * backfill sweep apply, and at what bar? A previously unset/non-positive threshold
 * counts as +Infinity, so ENABLING it (unset → 4) also sweeps; a NON-positive new
 * threshold never sweeps (fail-safe: it hides nothing). Returns the positive bar
 * to hide at, or null when no sweep is warranted (unchanged, raised, or disabled).
 */
export function backfillThreshold(
  beforeThreshold: number | null | undefined,
  afterThreshold: number | null | undefined,
): number | null {
  const next = typeof afterThreshold === 'number' && afterThreshold > 0 ? afterThreshold : null;
  if (next === null) return null; // unset/non-positive new threshold hides nothing
  const prev = typeof beforeThreshold === 'number' && beforeThreshold > 0 ? beforeThreshold : Infinity;
  return next < prev ? next : null; // only a DECREASE (incl. enable-from-disabled) sweeps
}

async function defaultQueryReportedDocs(
  collection: ModeratedCollection,
  eventId: string,
  threshold: number,
): Promise<ReportableCandidate[]> {
  const db = await adminFirestore();
  const snap = await db.collection(`events/${eventId}/${collection}`).where('reportCount', '>=', threshold).get();
  return snap.docs.map((d) => {
    const data = d.data() ?? {};
    return { id: d.id, status: data.status as string | undefined, reportCount: data.reportCount as number | undefined };
  });
}

/**
 * Best-effort: when the Event threshold DECREASED, hide the active items + proofs
 * whose `reportCount` now meets the lower bar. Bounded to the one Event's
 * subcollections. The query + active-only + count checks are a cheap pre-filter;
 * each actual write goes through the TRANSACTIONAL `hideIfQualifies` (round 2 F1),
 * so a sweep that races an admin Clear-reports re-confirms and no-ops rather than
 * undoing the lift. Each per-doc write is independently try/caught so one failure
 * never aborts the sweep; the outer try/catch keeps it from ever throwing (ADR
 * 0001). Returns how many docs it hid.
 *
 * The `status → 'hidden'` writes re-fire the per-write hide trigger, which no-ops
 * (the doc is now `'hidden'`, not active), so there is no loop; and this never
 * writes the Event doc, so it never re-fires ITSELF.
 */
export async function applyThresholdBackfill(
  eventId: string,
  beforeThreshold: number | null | undefined,
  afterThreshold: number | null | undefined,
  deps: BackfillDeps = {},
): Promise<number> {
  let hiddenCount = 0;
  try {
    const bar = backfillThreshold(beforeThreshold, afterThreshold);
    if (bar === null) return 0; // unchanged, raised, or disabled — nothing to sweep
    const queryReportedDocs = deps.queryReportedDocs ?? defaultQueryReportedDocs;
    const hideOne = deps.hideIfQualifies ?? defaultHideIfQualifies;
    for (const collection of ['items', 'proofs'] as const) {
      const candidates = await queryReportedDocs(collection, eventId, bar);
      for (const doc of candidates) {
        if (doc.status !== 'active') continue; // cheap pre-filter (F2); the transaction re-confirms
        if ((doc.reportCount ?? 0) < bar) continue; // defensive: query may over-return
        try {
          if (await hideOne(collection, eventId, doc.id)) hiddenCount++;
        } catch (err) {
          console.error('applyThresholdBackfill: per-doc hide failed', collection, doc.id, err);
        }
      }
    }
  } catch (err) {
    console.error('applyThresholdBackfill failed', err);
  }
  return hiddenCount;
}

// --- One-time rollout sweep (F2, Codex R2) --------------------------------------
//
// On the Phase-1 functions DEPLOY, content that already crossed the (unchanged)
// threshold under Phase 0 never crosses again and never triggers a threshold
// DECREASE, so it would stay `active` and directly readable despite meeting the
// server-hide bar. This operator-invokable sweep (scripts/backfill-hide.mjs, run
// once post-deploy) hides that pre-existing over-threshold content. It reuses the
// backfill core (DRY) with `before = null` (an enable-from-unset, so it sweeps at
// the event's CURRENT threshold) and the SAME transactional guard, so it is
// idempotent (a second run finds nothing active over threshold).

export interface RolloutDeps {
  /** Each Event's id + current `reportHideThreshold`; defaults to a `events` read (all, or one). */
  listEventThresholds?: (eventId?: string) => Promise<Array<{ id: string; threshold: number | null }>>;
  /** Sweep one Event; defaults to `applyThresholdBackfill(eventId, null, threshold)`. */
  sweepEvent?: (eventId: string, threshold: number | null) => Promise<number>;
}

async function defaultListEventThresholds(eventId?: string): Promise<Array<{ id: string; threshold: number | null }>> {
  const db = await adminFirestore();
  if (eventId) {
    const snap = await db.doc(`events/${eventId}`).get();
    return snap.exists ? [{ id: snap.id, threshold: readThreshold(snap.data()) }] : [];
  }
  const snap = await db.collection('events').get();
  return snap.docs.map((d) => ({ id: d.id, threshold: readThreshold(d.data()) }));
}

/** Rollout == enable-from-unset: `before = null` sweeps at the event's current bar. */
function defaultSweepEvent(eventId: string, threshold: number | null): Promise<number> {
  return applyThresholdBackfill(eventId, null, threshold);
}

/**
 * One-time rollout sweep across every Event (or one `eventId`): hide each Event's
 * active items + proofs whose `reportCount` already meets its current
 * `reportHideThreshold`. Best-effort and idempotent (re-running hides nothing new
 * — already-hidden docs no longer qualify). Returns the event + hidden counts.
 */
export async function runRolloutSweep(
  eventId?: string,
  deps: RolloutDeps = {},
): Promise<{ events: number; hidden: number }> {
  const listEventThresholds = deps.listEventThresholds ?? defaultListEventThresholds;
  const sweepEvent = deps.sweepEvent ?? defaultSweepEvent;
  const events = await listEventThresholds(eventId);
  let hidden = 0;
  for (const ev of events) hidden += await sweepEvent(ev.id, ev.threshold);
  return { events: events.length, hidden };
}
