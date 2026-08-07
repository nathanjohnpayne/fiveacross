/**
 * Admin moderation notifications — the DECISIONS and the roster (issue #101,
 * specs/w4-email-resend-admin-notify.md).
 *
 * A decoupled reader over the `status` transitions that `moderateProof`
 * (Vision), the threshold auto-hide (#43), and manual admin hides already
 * write. Reads `status` only — recomputes no stats, gates no play (ADR 0001).
 *
 * DELIVERY MOVED IN #638. This module used to compose and send one email per
 * transition (`notifyAdminsOfModeration`). It no longer sends anything: a
 * moderation transition is now one of three signals that enqueue an admin alert
 * (`adminAlerts.ts`), drained by a periodic Theme-styled digest
 * (`adminAlertDigest.ts`, specs/admin-notification-emails.md). The reason is
 * burst safety — an import or a report pile-on used to mean one email per
 * write — and format: the digest renders the wireframe's anatomy, which the old
 * bare `<table>` body did not.
 *
 * What survives here is what was worth keeping and is now reused by the digest:
 * WHEN a transition is notable (`shouldNotify`), WHAT caused it
 * (`deriveReason`), and WHO hears about it (`resolveAdminEmails`).
 *
 * The Firestore/Auth/params dependencies are lazy-loaded defaults that tests
 * replace via `deps`, so the whole flow is unit-testable without a Functions
 * runtime.
 */

/** The subset of a Proof/Prompt doc the notifier reads. */
export interface ModeratedDoc {
  status?: string;
  visionFlag?: string | null;
  reportCount?: number;
}

const MODERATION_STATES = ['flagged', 'hidden'];

/**
 * Pure predicate: notify only when `status` CHANGED into a moderation state.
 * Serves an onDocumentWritten source, so it covers create and delete: a create
 * (`before` undefined) INTO flagged/hidden notifies — moderateProof's merge-set
 * can create a proof doc already flagged in the upload-before-doc race (#101
 * Codex F2) — while a create INTO active, and any delete (`after` undefined),
 * do not.
 */
export function shouldNotify(before: ModeratedDoc | undefined, after: ModeratedDoc | undefined): boolean {
  const next = after?.status;
  return !!next && before?.status !== next && MODERATION_STATES.includes(next);
}

export interface ResolveDeps {
  /** Read `events/{eventId}.admins` (UID array). */
  getAdminUids?: (eventId: string) => Promise<string[]>;
  /** Resolve a UID to its verified email, or null if none. */
  getEmailForUid?: (uid: string) => Promise<string | null>;
  /** Comma-separated override roster; defaults to the ADMIN_NOTIFY_EMAIL param. */
  adminNotifyEmail?: string;
}

async function defaultGetAdminUids(eventId: string): Promise<string[]> {
  const { getFirestore } = await import('firebase-admin/firestore');
  const admins = (await getFirestore().doc(`events/${eventId}`).get()).data()?.admins;
  return Array.isArray(admins) ? admins.filter((u): u is string => typeof u === 'string') : [];
}

async function defaultGetEmailForUid(uid: string): Promise<string | null> {
  try {
    const { getAuth } = await import('firebase-admin/auth');
    const user = await getAuth().getUser(uid);
    return user.email && user.emailVerified ? user.email : null;
  } catch {
    return null; // a missing/broken UID must not sink the whole send
  }
}

/**
 * Resolve an Event's admin roster to a de-duped list of verified emails,
 * unioned with any ADMIN_NOTIFY_EMAIL override. Returns `[]` (never throws).
 *
 * BOTH SOURCES, deliberately, and #638 kept it that way rather than choosing
 * between them. The `admins` roster is the per-Event answer and needs no deploy
 * to change; `ADMIN_NOTIFY_EMAIL` is the deployment-level shared inbox and is
 * the only source that still resolves when the roster does not — an admin who
 * signed in with an unverified address, or a brand-new Event whose roster has
 * not been filled in yet. A union costs nothing and fails soft in both
 * directions.
 */
export async function resolveAdminEmails(eventId: string, deps: ResolveDeps = {}): Promise<string[]> {
  const getAdminUids = deps.getAdminUids ?? defaultGetAdminUids;
  const getEmailForUid = deps.getEmailForUid ?? defaultGetEmailForUid;
  let extra = deps.adminNotifyEmail;
  if (extra === undefined) extra = (await import('./params')).ADMIN_NOTIFY_EMAIL.value();

  const emails = new Set<string>();
  try {
    for (const uid of await getAdminUids(eventId)) {
      const email = await getEmailForUid(uid);
      if (email) emails.add(email);
    }
  } catch (err) {
    console.error('resolveAdminEmails: roster lookup failed', err);
  }
  for (const entry of (extra ?? '').split(',')) {
    if (entry.trim()) emails.add(entry.trim());
  }
  return [...emails];
}

/**
 * Derive the moderation cause from the ACTUAL doc state — never fabricate one
 * (#101 Codex R2 F1). A Vision flag names itself. A hide is a threshold hide
 * ONLY when reportCount and the event threshold are both known and the count is
 * at/over it; when both are known and the count is UNDER, the hide is an admin
 * action; when either is unknown, make no causal claim (neutral). Previously
 * every Vision-less hide was mislabelled "reports >= threshold", which lied
 * about a manual hide of an unreported prompt.
 *
 * Exported since #638: the digest labels its rows with this rather than
 * re-deriving the same three-way decision on the rendering side.
 */
export function deriveReason(after: ModeratedDoc, reportHideThreshold: number | null): string {
  if (after.visionFlag) return after.visionFlag;
  if (after.status !== 'hidden') return '';
  if (typeof after.reportCount === 'number' && typeof reportHideThreshold === 'number') {
    return after.reportCount >= reportHideThreshold ? 'reports >= threshold' : 'by an admin';
  }
  return ''; // threshold or count unknown — no fabricated cause
}
