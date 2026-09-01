/**
 * Project-wide rollout control for Event-scoped Tally marker delivery (#1072).
 *
 * The compatibility window is global because the old Hosting bundle performs
 * one unfiltered `collectionGroup('markers')` query across the whole Firebase
 * project. A per-Event switch could not truthfully keep that query authorized:
 * one legacy marker anywhere in the project is enough for Firestore's
 * rules-are-not-filters check to reject the query after cutover.
 *
 * Clients cannot read or write this document. The rollout migration creates it
 * with a numeric `acceptLegacyUntil`; Security Rules consult that same cutoff
 * for old writes/queries, and this trigger consults it before repairing an old
 * client's full-set marker write. Keep the expired document for delayed trigger
 * delivery and auditability — closing the window means moving the cutoff into
 * the past, not deleting the evidence that an accepted write was once eligible.
 */
export const MARKER_DELIVERY_COMPATIBILITY_PATH =
  "markerDeliveryCompatibility/current";

// Rules decide legacy-write admission from request.time, while Firestore exposes
// only the later commit/update time to this trigger. Keep the bridge deliberately
// small and explicit: it is normalizer eligibility, not an extension of client
// admission past the cutoff.
export const MARKER_IDENTITY_COMMIT_GRACE_MS = 60_000;
const COMPATIBILITY_CUTOFF_UPPER_BOUND_MS = 4_102_444_800_000;

export type MarkerIdentityResult =
  | "repaired"
  | "already-scoped"
  | "invalid-marker-uid"
  | "mismatched-event-id"
  | "invalid-event-id"
  | "compatibility-closed"
  | "deleted";

export type MarkerIdentityDocumentReference = { path: string };

type MarkerIdentitySnapshot = {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
  updateTime?: { toMillis(): number };
};

type MarkerIdentityTransaction = {
  get(ref: MarkerIdentityDocumentReference): Promise<MarkerIdentitySnapshot>;
  update(
    ref: MarkerIdentityDocumentReference,
    data: Record<string, unknown>,
  ): void;
};

export type MarkerIdentityFirestore = {
  doc(path: string): MarkerIdentityDocumentReference;
  runTransaction<T>(
    work: (transaction: MarkerIdentityTransaction) => Promise<T>,
  ): Promise<T>;
};

function owns(data: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

/**
 * Re-read and repair one marker transactionally.
 *
 * Triggers are at-least-once and can arrive out of order. The event snapshot is
 * therefore not trusted as the write target. The transaction reads the marker's
 * current version and makes exactly one additive patch only when:
 *
 * - the document still exists;
 * - `eventId` is truly absent (a mismatched or malformed present value is never
 *   laundered into a valid one); and
 * - that current committed version landed no later than the server-owned
 *   compatibility cutoff plus the one-minute request-to-commit grace.
 *
 * A newer client write that already carries the right field is a cheap no-op and
 * does not read the control document. A later old-client rewrite after the
 * cutoff is denied by rules. The bounded commit grace exists only because Rules
 * see request.time while this trigger sees the later updateTime; an Admin-SDK
 * write that bypasses rules remains part of the trusted Admin-IAM boundary.
 */
export async function repairLegacyMarkerEventIdentity(
  db: MarkerIdentityFirestore,
  params: {
    projectId: string;
    eventId: string;
    itemId: string;
    markerUid: string;
  },
): Promise<MarkerIdentityResult> {
  const markerRef = db.doc(
    `events/${params.eventId}/tally/${params.itemId}/markers/${params.markerUid}`,
  );
  const compatibilityRef = db.doc(MARKER_DELIVERY_COMPATIBILITY_PATH);

  return db.runTransaction(async (transaction) => {
    const markerSnapshot = await transaction.get(markerRef);
    if (!markerSnapshot.exists) return "deleted";

    const marker = markerSnapshot.data() ?? {};
    // Client rules bind both identities, and the migration refuses a uid/path
    // mismatch. Preserve that invariant here too: the compatibility trigger is
    // not a general-purpose sanitizer for Admin-authored malformed rows.
    if (marker.uid !== params.markerUid) return "invalid-marker-uid";
    if (owns(marker, "eventId")) {
      if (typeof marker.eventId !== "string") return "invalid-event-id";
      return marker.eventId === params.eventId
        ? "already-scoped"
        : "mismatched-event-id";
    }

    const compatibilitySnapshot = await transaction.get(compatibilityRef);
    const compatibility = compatibilitySnapshot.data();
    const cutoff = compatibility?.acceptLegacyUntil;
    const committedAt = markerSnapshot.updateTime?.toMillis();
    if (
      !compatibilitySnapshot.exists ||
      compatibility?.schemaVersion !== 1 ||
      compatibility?.projectId !== params.projectId ||
      typeof cutoff !== "number" ||
      !Number.isFinite(cutoff) ||
      cutoff <= 0 ||
      cutoff >= COMPATIBILITY_CUTOFF_UPPER_BOUND_MS ||
      typeof committedAt !== "number" ||
      !Number.isFinite(committedAt) ||
      committedAt > cutoff + MARKER_IDENTITY_COMMIT_GRACE_MS
    ) {
      return "compatibility-closed";
    }

    transaction.update(markerRef, { eventId: params.eventId });
    return "repaired";
  });
}
