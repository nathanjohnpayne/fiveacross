import { setGlobalOptions } from 'firebase-functions/v2';
import { onObjectFinalized, type StorageEvent } from 'firebase-functions/v2/storage';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import vision from '@google-cloud/vision';
import sharp from 'sharp';
import { AUTH_HANDOFF_APP_CHECK, BUG_REPORT_APP_CHECK, RESEND_API_KEY } from './params';
import {
  recordAdminAlerts,
  recordBugReportAlerts,
  runAdminAlertCycle,
  settleAdminAlertsForArchivedEvent,
  shouldSettleAdminAlertsOnArchive,
  type AdminAlertFirestore,
  type AlertableDoc,
  type BugReportDoc,
} from './adminAlerts';
import { visionModerationEnabled, shouldScanProof, resolveProjectId } from './visionGate';
import { applyThresholdHide, applyThresholdBackfill, type ReportableDoc } from './autohide';
import {
  applyEventAdultContent,
  applyItemAdultContent,
  reconcileHostnameAdultContent,
} from './adultContent';
import { handleSubmitBugReport } from './bugReports';
import { exchangeHandoff, mintHandoff, type HandoffFirestore } from './authHandoff';
import {
  manualUnlockNow,
  resnapshotDayIfNoBoards,
  runScheduledUnlock,
  UnlockPermissionError,
  type AdminFirestore,
} from './unlockDay';
import { runDailyEmailSweep, type DailyEmailFirestore } from './dailyEmail';
import { handleUnsubscribeRequest } from './emailOptOut';
import { firestoreCommitOrder, recordDirectMarkAnalytics } from './directMarkAnalytics';
import {
  repairLegacyMarkerEventIdentity,
  type MarkerIdentityFirestore,
} from './markerEventIdentity';

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const db = getFirestore();
const visionClient = new vision.ImageAnnotatorClient();
// The Firestore/Storage-authorized runtime identity. The project's default Gen2
// compute account deliberately has NO Firestore or Storage data-plane access, so
// every Admin-SDK function that reads/writes those planes must pin this account.
//
// PER-PROJECT, not a constant (ADR 0008). This repo deploys to two Firebase
// projects, and a Service Account only exists inside its own project — pinning
// the `gaycruisebingo` account while deploying `fiveacross` fails the deploy
// outright with `iam.serviceaccounts.actAs` on a cross-project resource, and
// would be wrong even if it succeeded: it would run Bodega's functions under an
// identity holding gaycruisebingo's Firestore data-plane access, collapsing the
// very boundary ADR 0008 exists to draw.
//
// Derived from the project, NOT read from `functions/.env*`. `serviceAccount`
// is part of the endpoint manifest, so it is resolved during TRIGGER DISCOVERY,
// whose subprocess env firebase-tools seals — `.env` files are loaded only
// afterwards. A `process.env.ADMIN_SDK_SERVICE_ACCOUNT` override would read as
// `undefined` there and silently fall back, which is worse than not offering
// one. `resolveProjectId` reads the two things discovery DOES guarantee; see
// the long note in visionGate.ts for the full mechanics.
//
// This reproduces the previous literal exactly on `gaycruisebingo`. It assumes
// the Admin SDK account keeps the `firebase-adminsdk-fbsvc` id, which holds for
// both current projects; a project whose id differs would need the account read
// from disk at discovery, the way visionGate.ts reads its flag.
//
// The value must already be a FULL email here — firebase-functions v2's
// trailing-`@` shorthand (`firebase-adminsdk-fbsvc@`) is not safe: firebase-tools
// (verified against 15.25.1) expands the shorthand only on the Cloud Functions
// service-config path (gcp/cloudfunctionsv2.js → proto.formatServiceAccount),
// while gcp/cloudscheduler.js `jobFromEndpoint` copies `endpoint.serviceAccount`
// VERBATIM into the Cloud Scheduler OIDC token for `unlockDay`, so the raw
// shorthand would reach Cloud Scheduler as an invalid email and fail the deploy
// at the scheduler step (found on the sibling fix PR #590, closed for this one).
const RUNTIME_PROJECT_ID = resolveProjectId() ?? 'gaycruisebingo';
const ADMIN_SDK_SERVICE_ACCOUNT = `firebase-adminsdk-fbsvc@${RUNTIME_PROJECT_ID}.iam.gserviceaccount.com`;

/**
 * Private, authenticated bug intake; App Check enforcement follows #44's
 * toggle. Pin the runtime identity: the project's default Gen2 compute account
 * deliberately has no Firestore or Storage data-plane access.
 */
export const submitBugReport = onCall(
  { maxInstances: 10, timeoutSeconds: 30, serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT },
  (request) => handleSubmitBugReport(request, BUG_REPORT_APP_CHECK.value()),
);

// --- Centralised-auth handoff (#548, ADR 0010, specs/auth-handoff.md) -----------
//
// Two callables spanning one origin boundary: `mintAuthHandoff` runs at the
// central auth origin where the player has just signed in, `exchangeAuthHandoff`
// runs for the Event origin that has no session yet. The whole decision surface
// lives in `authHandoff.ts` — these are seams, and deliberately thin ones,
// because everything worth reviewing here should be reachable by a unit test
// rather than only by a deployed function.

/**
 * Whether loopback return origins are acceptable. TRUE ONLY UNDER AN EMULATOR:
 * in a deployed function neither variable is set, so `http://localhost:5173`
 * fails the allowlist exactly like any other unregistered address. Reading the
 * environment at CALL time rather than at module load keeps it out of the
 * endpoint manifest, where a discovery-time read would be `undefined` anyway.
 */
function handoffAllowsLocalDev(): boolean {
  return (
    process.env.FIRESTORE_EMULATOR_HOST !== undefined || process.env.FUNCTIONS_EMULATOR === 'true'
  );
}

/**
 * Mint a single-use handoff code for the signed-in caller (#548).
 *
 * A CALLABLE, and that is the security property rather than a convenience: the
 * uid comes from `request.auth`, which the Functions runtime derives from a
 * verified Firebase ID token. A payload field would let any signed-in caller
 * mint a code bound to somebody else's UID.
 *
 * The response carries only the server-built `handoffUrl`. The caller supplies a
 * target origin and a deep-link path and gets back the exact URL to redirect to,
 * so it never gets to assemble a redirect target of its own — which is what
 * keeps the return leg from being an open redirect.
 */
export const mintAuthHandoff = onCall(
  { maxInstances: 10, timeoutSeconds: 30, serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT },
  async (request) => {
    const payload = (request.data ?? {}) as Record<string, unknown>;
    const result = await mintHandoff(
      {
        uid: request.auth?.uid,
        targetOrigin: payload.targetOrigin,
        transactionId: payload.transactionId,
        returnPath: payload.returnPath,
        appCheckPresent: request.app != null,
      },
      {
        db: db as unknown as HandoffFirestore,
        now: () => Date.now(),
        timestamp: (ms) => Timestamp.fromMillis(ms),
        policy: { allowLocalDev: handoffAllowsLocalDev() },
        requireAppCheck: AUTH_HANDOFF_APP_CHECK.value(),
      },
    );

    if (!result.ok) {
      if (result.reason === 'unauthenticated') {
        throw new HttpsError('unauthenticated', 'Sign in before starting a handoff.');
      }
      if (result.reason === 'app-check-required') {
        throw new HttpsError('failed-precondition', 'App Check is required.');
      }
      // The reason stays in the log, never in the response.
      console.warn('mintAuthHandoff rejected', { reason: result.reason });
      throw new HttpsError('invalid-argument', 'That is not a valid Event address to return to.');
    }

    return {
      handoffUrl: result.handoffUrl,
      targetOrigin: result.targetOrigin,
      expiresAt: result.expiresAt,
    };
  },
);

/**
 * Exchange a handoff code for a Firebase custom token (#548).
 *
 * UNAUTHENTICATED BY NECESSITY: the Event origin calling this has no session —
 * obtaining one is the entire point. Authorization is the code plus the private
 * transaction verifier, checked against a document that is consumed in the same
 * transaction. CORS stays open because the set of legitimate callers is every
 * registered Event hostname, which is dynamic; CORS is not the boundary here and
 * was never going to be, since a non-browser client ignores it. The boundary is
 * the code, the verifier, and the origin recorded at mint time.
 *
 * Every rejection returns the SAME error. A caller that could distinguish
 * "expired" from "already used" from "no such code" would learn whether a
 * guessed code was ever real.
 */
export const exchangeAuthHandoff = onCall(
  { maxInstances: 20, timeoutSeconds: 30, serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT },
  async (request) => {
    const payload = (request.data ?? {}) as Record<string, unknown>;
    const headerOrigin = request.rawRequest?.headers?.origin;
    const result = await exchangeHandoff(
      {
        code: payload.code,
        transactionVerifier: payload.transactionVerifier,
        origin: payload.origin,
        headerOrigin: typeof headerOrigin === 'string' ? headerOrigin : null,
        appCheckPresent: request.app != null,
      },
      {
        db: db as unknown as HandoffFirestore,
        now: () => Date.now(),
        timestamp: (ms) => Timestamp.fromMillis(ms),
        requireAppCheck: AUTH_HANDOFF_APP_CHECK.value(),
        createCustomToken: (uid) => getAuth().createCustomToken(uid),
        // Fails closed: `getUser` rejects for a deleted account, and a lookup
        // that errors must not be read as "the account is fine".
        isAccountUsable: async (uid) => {
          try {
            return !(await getAuth().getUser(uid)).disabled;
          } catch (err) {
            console.error('exchangeAuthHandoff account check failed', err);
            return false;
          }
        },
      },
    );

    if (!result.ok) {
      console.warn('exchangeAuthHandoff rejected', { reason: result.reason });
      throw new HttpsError(
        'permission-denied',
        'This sign-in link is no longer valid. Please sign in again.',
      );
    }

    return { customToken: result.customToken };
  },
);

// Cloud Vision (moderateProof) stays deferred by default (#126): the gate keeps
// the export OFF until Vision is deliberately enabled (Cloud Vision API on +
// ENABLE_VISION_MODERATION=true), so a proof scanner isn't stood up before it's
// wanted. moderateProof is a Storage trigger on the default (us-east1) bucket,
// so the export below is pinned to `region: 'us-east1'`: a us-central1 function
// (the global default) on a us-east1 bucket is an invalid pairing that fails
// deploy-plan validation and would block the whole functions deploy, so the
// trigger region MUST match the bucket for the enabled path to deploy. The gate
// is `functions/.env.<projectId>` (ENABLE_VISION_MODERATION=true), honored at
// BOTH deploy trigger-discovery and runtime; see visionGate.ts for why a raw
// process.env / param read alone is NOT visible at discovery.
const VISION_ENABLED = visionModerationEnabled();

const LIKELIHOOD = ['UNKNOWN', 'VERY_UNLIKELY', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'];
const atLeast = (v: string | null | undefined, min: string) =>
  LIKELIHOOD.indexOf(v ?? 'UNKNOWN') >= LIKELIHOOD.indexOf(min);

/**
 * On proof image upload: make a thumbnail and run SafeSearch.
 * IMPORTANT: this app is intentionally racy, so we do NOT flag "adult"/"racy".
 * We only flag extreme signals (heavy violence / gore) for human review.
 * SafeSearch cannot detect minors — human reporting remains the primary control.
 */
async function moderateProofHandler(event: StorageEvent): Promise<void> {
  const path = event.data.name;
  if (!path || !path.startsWith('proofs/') || !path.endsWith('.jpg')) return;
  if (path.endsWith('_thumb.jpg')) return;

  const parts = path.split('/'); // proofs/{eventId}/{uid}/{proofId}.jpg
  const eventId = parts[1];
  const proofId = parts[3].replace(/\.[^.]+$/, '');

  const bucket = getStorage().bucket(event.data.bucket);
  const [buf] = await bucket.file(path).download();

  try {
    const thumb = await sharp(buf).resize(400, 400, { fit: 'inside' }).jpeg({ quality: 78 }).toBuffer();
    await bucket.file(path.replace(/\.jpg$/, '_thumb.jpg')).save(thumb, { contentType: 'image/jpeg' });
  } catch {
    /* thumbnail is best-effort */
  }

  // #268 (daily-cards-spec § "Admin console"): the event-level
  // `settings.visionGate` is the ADMIN toggle — consulted at RUNTIME
  // (shouldScanProof, visionGate.ts) so the console switch takes effect
  // without a redeploy. The deploy-time env flag (ENABLE_VISION_MODERATION)
  // stays the master kill-switch: it gates whether this function exists at
  // all; this read gates whether an existing deployment SCANS. Read AFTER the
  // thumbnail save (Codex P3): the thumbnail is a display asset, not
  // moderation — a degraded Firestore must not cost an upload its thumb.
  if (!(await shouldScanProof(db, eventId))) return;

  try {
    const [res] = await visionClient.safeSearchDetection({ image: { content: buf } });
    const s = res.safeSearchAnnotation;
    const flag = atLeast(s?.violence as string, 'LIKELY')
      ? 'violence'
      : atLeast(s?.adult as string, 'VERY_LIKELY') && atLeast(s?.violence as string, 'POSSIBLE')
        ? 'extreme'
        : null;
    if (flag) {
      await db.doc(`events/${eventId}/proofs/${proofId}`).set({ status: 'flagged', visionFlag: flag }, { merge: true });
    }
  } catch {
    /* Vision optional; reporting still covers moderation */
  }
}

// Gated per #126: only assign a CloudFunction when VISION_ENABLED. Firebase's
// export discovery (firebase-functions/lib/runtime/loader.js extractStack)
// walks Object.entries(module) and registers an export only when
// `typeof val === 'function' && val.__endpoint` — an `undefined` export fails
// that check and is silently skipped, so it is never validated or deployed.
// `region: 'us-east1'` pins the trigger to the default Storage bucket's region
// (the global default stays us-central1 for the Firestore-triggered notifiers)
// so the deploy-plan region check passes when the gate is on.
export const moderateProof = VISION_ENABLED
  ? onObjectFinalized(
      // `serviceAccount` (#268, Codex P2 on #284): the runtime visionGate read
      // + the flagged-proof write go through Firestore, and the default Gen2
      // compute identity has no data-plane access in this project — without
      // the Admin-SDK identity the toggle read would throw and FAIL OPEN,
      // silently ignoring an admin's visionGate: false.
      { memory: '512MiB', region: 'us-east1', serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT },
      moderateProofHandler,
    )
  : undefined;

/**
 * Queue an admin alert when a Proof/Prompt write earns one (issues #101, #638).
 * Decoupled from the writes that own the transition; reads the before/after
 * snapshots only. Best-effort — a queue failure is swallowed so the moderation
 * write is never blocked (ADR 0001).
 *
 * THESE USED TO SEND MAIL DIRECTLY (#101). They now only APPEND to
 * `events/{eventId}/adminAlerts`, and `adminAlertDigest` below drains the queue
 * into one Theme-styled email per Event per sweep. The reason is burst safety:
 * a pool import writing eighty `pending` Prompts, or a report pile-on, used to
 * mean one email per write (specs/admin-notification-emails.md). The export
 * NAMES are unchanged on purpose — renaming an exported Function deletes the
 * old one on the next deploy, and there is no behavioural reason to pay that.
 *
 * Uses onDocumentWritten (not onDocumentUpdated) so a proof CREATED already
 * flagged — moderateProof's merge-set can create the doc in the
 * upload-before-doc race (#101 Codex F2) — still alerts; `alertsForWrite`
 * ignores create-into-active and deletes (`after` undefined). `transitionId` is
 * the CloudEvent id, which is stable across platform retries of one delivery
 * and unique per distinct write — it becomes the queue document's id, so a
 * redelivered trigger is a no-op rather than a duplicate row (#101 Codex F3,
 * carried forward).
 *
 * BOTH NOW PIN `ADMIN_SDK_SERVICE_ACCOUNT`, and that is a fix rather than
 * boilerplate. They write Firestore now, which the default Gen2 compute
 * identity cannot reach at all — but they also always READ it: `#101`'s roster
 * lookup resolves `events/{eventId}.admins` through the Admin SDK, and
 * `resolveAdminEmails` swallows a permission error into an empty roster. So on
 * an unpinned deployment the `admins` half of the recipient model silently
 * never resolved, and only `ADMIN_NOTIFY_EMAIL` ever produced a recipient.
 * Neither writes anything under `events/{eventId}/{items,proofs}`, so neither
 * can re-fire itself. The RESEND_API_KEY binding moved to the digest, which is
 * now the only function here that sends.
 */
async function handleModeration(
  collection: 'items' | 'proofs',
  eventId: string,
  docId: string,
  transitionId: string,
  before: AlertableDoc | undefined,
  after: AlertableDoc | undefined,
): Promise<void> {
  await recordAdminAlerts(
    db as unknown as AdminAlertFirestore,
    collection,
    eventId,
    docId,
    transitionId,
    before,
    after,
  );
}

export const notifyProofModeration = onDocumentWritten(
  { document: 'events/{eventId}/proofs/{proofId}', serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT },
  (event) =>
    handleModeration(
      'proofs',
      event.params.eventId,
      event.params.proofId,
      event.id,
      event.data?.before.data(),
      event.data?.after.data(),
    ),
);

export const notifyItemModeration = onDocumentWritten(
  { document: 'events/{eventId}/items/{itemId}', serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT },
  (event) =>
    handleModeration(
      'items',
      event.params.eventId,
      event.params.itemId,
      event.id,
      event.data?.before.data(),
      event.data?.after.data(),
    ),
);

/**
 * The third producer for the same queue: a bug report the reporter marked
 * `abuse` (#670, specs/admin-notification-emails.md § Abuse reports).
 *
 * ITS DOCUMENT PATH IS TOP-LEVEL, unlike the two above, because `bugReports` is
 * — the callable writes one document per report with an `eventId` FIELD rather
 * than nesting it under an Event. So this trigger has no `{eventId}` wildcard to
 * read: `recordBugReportAlerts` takes the Event off the document, checks it
 * resolves, and refuses to enqueue otherwise rather than guessing one.
 *
 * It fires on EVERY bug report, which is the cost of the collection being flat,
 * but a plain `bug` is rejected by a pure predicate before any read — so the
 * common case costs one no-op invocation and nothing else. That predicate also
 * runs before anything that can throw, so `retry: true` never re-runs a bug.
 *
 * Pins `ADMIN_SDK_SERVICE_ACCOUNT` for the same reason the two above do: it
 * reads `events/{eventId}` and writes the queue, neither of which the project's
 * default Gen2 compute identity can reach (ADR 0008). It writes only under
 * `events/{eventId}/adminAlerts`, never back into `bugReports`, so it cannot
 * re-fire itself.
 */
export const notifyAbuseBugReport = onDocumentWritten(
  // `retry: true` (Phase 4b P1). `recordBugReportAlerts` acknowledges every
  // PERMANENT answer by returning normally and lets only TRANSIENT Firestore
  // failures escape, so retries are reserved for the case where retrying can
  // actually help. They are safe because the queue's document ids derive from
  // this event's own id: a retry landing after a write already succeeded finds
  // the occupied deterministic row and is a no-op, never a duplicate. Without
  // it, one blip silently and permanently loses a report of harm.
  { document: 'bugReports/{reportId}', serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT, retry: true },
  async (event) => {
    await recordBugReportAlerts(
      db as unknown as AdminAlertFirestore,
      event.params.reportId,
      event.id,
      event.data?.before.data() as BugReportDoc | undefined,
      event.data?.after.data() as BugReportDoc | undefined,
    );
  },
);

/**
 * Archive is a deliberate discard boundary for admin-alert work (#846, ADR
 * 0013). Unclaimed rows and claims that never acquired frozen bytes become
 * payload-free tombstones; a frozen claim keeps its original delivery identity
 * because Resend may already have accepted it.
 *
 * Retry is safe: settlement is transactional and idempotent, and the scheduled
 * digest performs the same archived-Event pass as a backstop for delayed
 * producers or a failed transition invocation. RESEND_API_KEY stays bound here
 * because a preserved frozen batch may need its exact request replayed.
 */
export const settleAdminAlertsOnArchive = onDocumentWritten(
  {
    document: 'events/{eventId}',
    serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT,
    secrets: [RESEND_API_KEY],
    retry: true,
  },
  async (event) => {
    if (!shouldSettleAdminAlertsOnArchive(event.data?.before.data(), event.data?.after.data())) return;
    await settleAdminAlertsForArchivedEvent(db as unknown as AdminAlertFirestore, event.params.eventId);
  },
);

/**
 * Board analytics must be derived from Firestore's committed before/after
 * state, rather than a browser continuation that can die while an offline
 * write is queued. This records both direct toggles and Echoes; the pure
 * detector rejects stale true→true and false→false rewrites even when they
 * carry a fresh client request token.
 *
 * The two paths deliberately have separate exports: daily Boards carry their
 * canonical path Day, while legacy Boards omit `dayIndex` rather than
 * inventing a misleading Day 0. The immutable row id is the CloudEvent id, so
 * Cloud Functions' at-least-once trigger delivery cannot duplicate it.
 */
export const recordLegacyDirectMarkAnalytics = onDocumentWritten(
  { document: 'events/{eventId}/boards/{uid}', serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT, retry: true },
  (event) => {
    const commitOrder = firestoreCommitOrder(event.data?.after.updateTime);
    if (!commitOrder) return;
    return recordDirectMarkAnalytics(db, {
      eventId: event.params.eventId,
      uid: event.params.uid,
      transitionId: event.id,
      commitOrder,
      before: event.data?.before.data(),
      after: event.data?.after.data(),
    });
  },
);

export const recordDayDirectMarkAnalytics = onDocumentWritten(
  {
    document: 'events/{eventId}/days/{dayIndex}/boards/{uid}',
    serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT,
    retry: true,
  },
  (event) => {
    const dayIndex = Number(event.params.dayIndex);
    const commitOrder = firestoreCommitOrder(event.data?.after.updateTime);
    if (!commitOrder) return;
    return recordDirectMarkAnalytics(db, {
      eventId: event.params.eventId,
      uid: event.params.uid,
      transitionId: event.id,
      commitOrder,
      before: event.data?.before.data(),
      after: event.data?.after.data(),
      ...(Number.isInteger(dayIndex) && dayIndex >= 0 ? { dayIndex } : {}),
    });
  },
);

/**
 * Time-boxed compatibility for pre-#1072 clients. Those bundles replace a
 * marker without `eventId`, so a one-off backfill is not durable while any old
 * tab remains open. This create+update trigger makes that legacy full-set write
 * converge to the path Event during the server-owned compatibility window.
 *
 * The event snapshot is only a cheap no-op/refusal gate. Missing-field repairs
 * re-read the live marker and cutoff transactionally in
 * `repairLegacyMarkerEventIdentity`, so an out-of-order retry cannot overwrite a
 * newer marker and a mismatched identity is never silently "corrected".
 */
export const repairLegacyMarkerEventIdentityOnWrite = onDocumentWritten(
  {
    document: 'events/{eventId}/tally/{itemId}/markers/{markerUid}',
    serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT,
    retry: true,
  },
  async (event) => {
    const after = event.data?.after.data();
    if (!after) return;

    if (Object.prototype.hasOwnProperty.call(after, 'eventId')) {
      if (after.eventId !== event.params.eventId) {
        console.error('marker Event identity refused', {
          eventId: event.params.eventId,
          itemId: event.params.itemId,
          markerUid: event.params.markerUid,
          markerEventId: after.eventId,
        });
      }
      return;
    }

    const result = await repairLegacyMarkerEventIdentity(
      db as unknown as MarkerIdentityFirestore,
      {
        projectId: RUNTIME_PROJECT_ID,
        eventId: event.params.eventId,
        itemId: event.params.itemId,
        markerUid: event.params.markerUid,
      },
    );
    if (result !== 'repaired' && result !== 'already-scoped' && result !== 'deleted') {
      console.error('legacy marker Event identity was not repaired', {
        eventId: event.params.eventId,
        itemId: event.params.itemId,
        markerUid: event.params.markerUid,
        result,
      });
    }
  },
);

/**
 * Server-authoritative reactive auto-hide (issue #43, ADR 0004 Phase 1). When a
 * Proof/Prompt's `reportCount` crosses its Event's `settings.reportHideThreshold`,
 * flip `status → 'hidden'` via the admin SDK (which bypasses security rules),
 * promoting the Phase-0 presentational hide (`isReportHidden`) to authoritative
 * removal. The decision (crossing predicate + fail-safe + loop guard) and its
 * best-effort wrapping live in `applyThresholdHide` (./autohide) so they are
 * unit-testable without a Functions runtime; these are the thin trigger seams.
 *
 * Both triggers share the `onDocumentWritten` path with the #101 notifiers: a
 * report bump that crosses the threshold fires THIS function, whose `hidden`
 * write then re-fires both — this one no-ops (loop-guarded), while
 * `notifyItemModeration`/`notifyProofModeration` REACTS to the `status → hidden`
 * transition and emails the admins. moderateProof and the notifiers are
 * untouched; no secrets are needed here. Firestore triggers stay on us-central1.
 */
export const hideProofAtThreshold = onDocumentWritten(
  'events/{eventId}/proofs/{proofId}',
  (event) =>
    applyThresholdHide(
      'proofs',
      event.params.eventId,
      event.params.proofId,
      event.data?.before.data() as ReportableDoc | undefined,
      event.data?.after.data() as ReportableDoc | undefined,
    ),
);

export const hideItemAtThreshold = onDocumentWritten(
  'events/{eventId}/items/{itemId}',
  (event) =>
    applyThresholdHide(
      'items',
      event.params.eventId,
      event.params.itemId,
      event.data?.before.data() as ReportableDoc | undefined,
      event.data?.after.data() as ReportableDoc | undefined,
    ),
);

/**
 * Threshold-decrease backfill (issue #43 F3, ADR 0004 Phase 1). The per-write
 * hides above fire only on a fresh crossing, so LOWERING an Event's
 * settings.reportHideThreshold below already-existing reportCounts would never
 * server-hide those already-over-threshold docs. This Event-doc trigger closes
 * that authoritative-hide gap: when reportHideThreshold decreases (or is enabled
 * from unset), applyThresholdBackfill sweeps the Event's own active items +
 * proofs and hides the ones that now meet the lower bar (active-only, update-based
 * writes; best-effort). It never writes the Event doc, so it never re-fires
 * itself; its status->hidden writes re-fire the per-write hides, which no-op.
 */
export const backfillHideOnThresholdDecrease = onDocumentWritten(
  'events/{eventId}',
  (event) =>
    applyThresholdBackfill(
      event.params.eventId,
      event.data?.before.data()?.settings?.reportHideThreshold,
      event.data?.after.data()?.settings?.reportHideThreshold,
    ),
);

/**
 * The Event's 18+ posture, derived server-side (#608). The decision predicates
 * and the idempotent stamp live in `adultContent.ts` so they are unit-testable
 * without a Functions runtime; these are the thin trigger seams, mirroring the
 * auto-hide pair above.
 *
 * WHY A FUNCTION AT ALL. The 18+ acknowledgement is on the sign-in gate —
 * pre-auth — and `events/{eventId}/items/{id}` requires `signedIn()`, so the one
 * client that must know whether the pool holds explicit Prompts is the one
 * client that can never read it. The derivation publishes the answer onto the
 * world-readable routing documents the resolver already fetches before mount.
 *
 * Both pin `ADMIN_SDK_SERVICE_ACCOUNT`: they read `hostnames` (a collection no
 * client may `list`) and write it (a collection no client may write at all), and
 * the project's default Gen2 compute identity has no Firestore data-plane
 * access, so an unpinned run would fail its first read. Neither writes anything
 * under `events/`, so neither can re-fire itself or the other.
 *
 * Both also set `retry: true`, and that is load-bearing rather than defensive
 * (Phase 4b P1). `adultContent.ts` deliberately THROWS on a failed stamp instead
 * of swallowing it — but event-driven Functions do not retry failed invocations
 * by default, so without this the throw bought nothing: a transient hostname
 * query or update failure would leave the routing document at `false`
 * indefinitely, and nothing would try again unless another qualifying Prompt
 * happened to be written. That is precisely the fail-open the throw was added to
 * close.
 *
 * Retrying is safe because both handlers are idempotent by construction: the
 * stamp skips documents already at `true`, and the cheap predicates short-circuit
 * before any read, so a redelivery on a write that never qualified cannot fail
 * and cannot loop. The one cost is that a PERMANENT failure (a broken IAM
 * binding) retries for up to seven days — which for a fail-closed security flag
 * is the behaviour you want, and is loud in the logs rather than silent.
 */
export const deriveAdultContentOnItem = onDocumentWritten(
  { document: 'events/{eventId}/items/{itemId}', serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT, retry: true },
  (event) => applyItemAdultContent(event.params.eventId, event.data?.after.data()),
);

export const deriveAdultContentOnEvent = onDocumentWritten(
  { document: 'events/{eventId}', serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT, retry: true },
  (event) => applyEventAdultContent(event.params.eventId, event.data?.after.data()),
);

/**
 * The third side of the same invariant (Phase 4b round 3).
 *
 * The two triggers above cover every way an Event can BECOME adult. This covers
 * the opposite order: a routing document that appears AFTER it already is — an
 * alias added to a running Event, or a document created concurrently with a
 * derivation run, after that run's `hostnames` query snapshot was taken. In both
 * cases no qualifying source document will ever change again, so nothing would
 * re-derive and the new host would serve the un-gated shell indefinitely.
 *
 * Watches `hostnames` itself, which is why it is the one trigger here whose own
 * writes land on the collection it observes. That is safe and needs no separate
 * loop guard: the handler returns before any read when the document is already
 * `adultContent: true`, which is exactly what its own stamp produces.
 */
export const reconcileHostnameOnWrite = onDocumentWritten(
  { document: 'hostnames/{host}', serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT, retry: true },
  (event) => reconcileHostnameAdultContent(event.params.host, event.data?.after.data()),
);

/**
 * Phase 1.5 scheduler (issue #202, daily-cards-spec § "Unlock mechanics" /
 * "Scoring and social surfaces"). The decision logic + idempotent writes live in
 * `unlockDay.ts` so they are unit-testable without a Functions runtime; this is
 * the thin trigger seam. Like the bug-report intake, it reads `events` and writes
 * snapshots / finale state through the Admin SDK, so it MUST pin
 * `ADMIN_SDK_SERVICE_ACCOUNT`: the project's default Gen2 compute identity has no
 * Firestore data-plane access, so an unpinned run would fail its first read.
 *
 * SCHEDULE (#552): ONE quarter-hourly UTC trigger drives every beat, calling this
 * same idempotent core for every active Event. Every beat is self-guarded
 * (`unlockAt` + `snapshotItemIds` for snapshots, `frozenAt` for the freeze, an
 * existing `last_call` Moment for last-call), so a run that lands when nothing is
 * due — or a retry — is a no-op. See `unlockDay` below for why the cadence is
 * what it is. Firestore-triggered functions stay us-central1 (the global
 * default).
 */
async function runScheduledUnlockForActiveEvents(): Promise<void> {
  const adminDb = db as unknown as AdminFirestore;
  const events = await db.collection('events').where('status', '==', 'active').get();
  for (const ev of events.docs) {
    try {
      await runScheduledUnlock(adminDb, ev.id);
    } catch (err) {
      console.error('runScheduledUnlock failed', ev.id, err);
    }
  }
}

/**
 * ONE quarter-hourly UTC trigger, replacing the two `Europe/Rome` ones (#552).
 *
 * The Rome pins were correct only for a Mediterranean sailing. In August they
 * fire at 23:00 and 11:00 Pacific, so a Bodega Day due at 06:00 PT would not
 * snapshot until 11:00 AM — a five-hour window with every card locked, on a
 * trip where the whole point is that the card is waiting when people wake up.
 * A per-timezone trigger per Event does not scale either: it would mean a
 * deploy every time an Event is created somewhere new.
 *
 * QUARTER-HOURLY, not hourly. An earlier revision used `0 * * * *` on the
 * reasoning that "unlock times are whole hours". That is only true in
 * whole-hour-offset zones. `unlockAt` is an absolute instant derived from the
 * Event's LOCAL schedule, so a 06:00 unlock in `Asia/Kolkata` (UTC+5:30) is
 * 00:30 UTC and `Pacific/Chatham` (UTC+12:45) lands on :45 — an hourly cron
 * would leave those Days locked for up to 59 minutes, which is the very
 * failure this trigger exists to remove, just relocated to other timezones.
 * Every real IANA offset is a multiple of 15 minutes, so a 15-minute cadence
 * covers all of them. (Written in prose deliberately: the cron literal contains
 * the block-comment terminator, so it belongs in the code below, not here.)
 *
 * SAFE TO RUN 96x A DAY because every beat is self-guarded, not schedule-timed
 * (`runScheduledUnlock`, functions/src/unlockDay.ts):
 *   - a Day snapshot writes only when `unlockAt` has passed AND
 *     `snapshotItemIds` is still absent, re-checked inside a transaction, so a
 *     second run is a no-op rather than a re-stamp;
 *   - the freeze is a transactional `frozenAt` flip, so exactly one run wins;
 *   - `last_call` and `podium` Moments dedupe on an existing-Moment check.
 * The schedule was never what made these fire once — it only decided how soon
 * they fired. Running every 15 minutes makes them prompt without repeating.
 *
 * This also retires the DST caveat in specs/d15-scheduler-unlock.md: with a
 * fixed-offset UTC schedule there is no local-time shift to reason about, and
 * the 12h last-call lead is derived from the Day schedule rather than a cron.
 *
 * DEPLOY NOTE. This revision REMOVES the `unlockDayFinaleLastCall` export, so
 * the deploy carrying it must delete an already-deployed function. The
 * canonical path runs `firebase deploy --non-interactive`, which REFUSES that
 * delete rather than prompting — so the first such deploy fails unless it is
 * given `--force` (firebase's `--force` = "delete Cloud Functions missing from
 * the current deploy"). `op-firebase-deploy` forwards extra args, so:
 *
 *     op-firebase-deploy <project> --only functions --force
 *
 * ONE-TIME, and deliberately not baked into the shared deploy script: a
 * standing `--force` would silently delete any function accidentally omitted
 * from any future deploy. Note this is a DIFFERENT flag from
 * `scripts/deploy.sh --force`, which only bypasses the branch/freshness guards.
 *
 * The admin "unlock now" callable (`unlockDayNow`, below) is unchanged and
 * remains the manual fallback for function lag or failure.
 */
export const unlockDay = onSchedule(
  { schedule: '*/15 * * * *', timeZone: 'Etc/UTC', serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT },
  () => runScheduledUnlockForActiveEvents(),
);

/**
 * Manual admin "unlock now" fallback for function lag/failure: force the SAME
 * idempotent snapshot for one Day on demand. Admin-gated in `manualUnlockNow`
 * (caller uid must be on the event's `admins` roster); a non-admin caller trips
 * `UnlockPermissionError`, mapped here to a `permission-denied` HttpsError.
 * Follows the `submitBugReport` callable shape, and like it pins
 * `ADMIN_SDK_SERVICE_ACCOUNT` — it reads/writes Firestore through the Admin SDK,
 * which the default Gen2 compute identity cannot reach.
 *
 * `resnapshot: true` (specs/easy-mix.md § "Deploy race") routes to the guarded
 * `resnapshotDayIfNoBoards` instead: it OVERWRITES the snapshot with the current
 * active pool (main + embark for a main day) but ONLY while zero Day Cards exist —
 * the recovery for a Day whose snapshot was stamped by the pre-easy-mix build. Same
 * admin gate; the zero-boards guard lives in the callee.
 */
export const unlockDayNow = onCall(
  { maxInstances: 10, timeoutSeconds: 30, serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before unlocking a Day.');
  const data = (request.data ?? {}) as { eventId?: unknown; dayIndex?: unknown; resnapshot?: unknown };
  if (typeof data.eventId !== 'string' || typeof data.dayIndex !== 'number') {
    throw new HttpsError('invalid-argument', 'eventId (string) and dayIndex (number) are required.');
  }
  const adminDb = db as unknown as AdminFirestore;
  try {
    const result =
      data.resnapshot === true
        ? await resnapshotDayIfNoBoards(adminDb, uid, data.eventId, data.dayIndex)
        : await manualUnlockNow(adminDb, uid, data.eventId, data.dayIndex);
    return { result };
  } catch (err) {
    if (err instanceof UnlockPermissionError) throw new HttpsError('permission-denied', err.message);
    throw err;
  }
});

// --- Daily themed engagement email (#616) ---------------------------------------
// Thin trigger seams only; the sweep, the content, the template and the consent
// store live in `dailyEmail.ts` / `dailyEmailContent.ts` / `dailyEmailTemplate.ts`
// / `emailOptOut.ts`, all pure + dependency-injected (specs/daily-engagement-email.md).

/**
 * The daily send. QUARTER-HOURLY, not daily, for the reason `unlockDay` above
 * is: the send must land at the Day's unlock in the EVENT's timezone, and a
 * cron is one fixed schedule for every Event a deployment serves. The sweep is
 * dumb and frequent; `dueDayForDailyEmail` is the real clock, and every beat is
 * self-guarded (admin toggle off by default, a six-hour due window, a
 * per-recipient `lastSentDayIndex`, and a Resend idempotency key), so running
 * 96× a day sends at most one email per participant per Day.
 *
 * Pins `ADMIN_SDK_SERVICE_ACCOUNT` — it reads Events, rosters and hostnames and
 * writes opt-out docs through the Admin SDK, which the default Gen2 compute
 * identity cannot reach — and binds `RESEND_API_KEY` like the moderation
 * notifiers. `timeoutSeconds` is generous because the fan-out is paced to stay
 * inside Resend's per-second limit.
 */
export const dailyEngagementEmail = onSchedule(
  {
    schedule: '*/15 * * * *',
    timeZone: 'Etc/UTC',
    serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT,
    secrets: [RESEND_API_KEY],
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  () => runDailyEmailSweep(db as unknown as DailyEmailFirestore),
);

// --- Admin notification digest (#638) --------------------------------------------

/**
 * Advance every Event's admin-alert lifecycle (specs/admin-notification-
 * emails.md). Active Events drain into ONE Theme-styled email; archived Events
 * discard uncommitted rows while preserving frozen requests. The producers are
 * the two `notify*Moderation` triggers above; everything about WHAT is queued,
 * WHO hears about it and HOW it reads lives in `adminAlerts.ts` /
 * `adminAlertDigest.ts`, all pure + dependency-injected.
 *
 * FIVE MINUTES is the whole burst guarantee, and it is a floor on batching
 * rather than a delay budget: an import that writes eighty `pending` Prompts in
 * one second produces eighty queued alerts and exactly one email. It is
 * deliberately tighter than `unlockDay`'s and the daily email's quarter-hourly
 * sweep, because those wait on a wall-clock moment in the Event's timezone
 * while this one waits only on work existing — and moderation is the one
 * notification where latency is a real cost. A sweep with nothing queued costs
 * one indexed `sentAt == null` query per active or archived Event and sends
 * nothing.
 *
 * Pins `ADMIN_SDK_SERVICE_ACCOUNT` (it reads Events, the alert queue, the
 * `admins` roster and `hostnames`, and stamps alerts, none of which the default
 * Gen2 compute identity can reach) and binds `RESEND_API_KEY`. The archive
 * lifecycle trigger binds the same secret because it can replay frozen work.
 */
export const adminAlertDigest = onSchedule(
  {
    schedule: '*/5 * * * *',
    timeZone: 'Etc/UTC',
    serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT,
    secrets: [RESEND_API_KEY],
    timeoutSeconds: 300,
  },
  () => runAdminAlertCycle(db as unknown as AdminAlertFirestore),
);

/**
 * The unsubscribe endpoint — the target of every daily email's visible
 * Unsubscribe link and of its `List-Unsubscribe` header.
 *
 * HTTP, not a callable, and it has to be: RFC 8058 one-click unsubscribe is a
 * plain POST issued by the mail client itself, with no Firebase SDK, no session
 * and no callable envelope, and the visible link is a URL a mail app opens in a
 * browser. Authorization is the per-user capability token in the URL, verified
 * in constant time by `applyOptOut`; the endpoint reveals nothing about whether
 * a uid exists. Pins the Admin-SDK identity because it writes the opt-out doc.
 */
export const emailUnsubscribe = onRequest(
  { serviceAccount: ADMIN_SDK_SERVICE_ACCOUNT, maxInstances: 10, timeoutSeconds: 30 },
  (req, res) => handleUnsubscribeRequest(db as unknown as DailyEmailFirestore, req, res),
);
