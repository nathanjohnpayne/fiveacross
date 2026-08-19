/**
 * Event membership — the non-self-writable admission record and its predicates
 * (specs/event-membership.md, epic #801, ticket #802).
 *
 * WHY THIS MODULE EXISTS. "Is this UID in this Event?" is about to be asked in
 * five places that cannot be allowed to disagree: `firestore.rules`, `storage.rules`,
 * the client, the Cloud Functions, and the emulator suites. Rules are not
 * importable, so the rules copy is transcribed rather than shared — which makes
 * this module the REFERENCE the transcription is checked against, and makes
 * every deviation from it a bug in one of the two. Tests here pin the answer;
 * ticket #804's emulator tests pin that the rules agree.
 *
 * PURE BY CONSTRUCTION. No Firebase import ever belongs here — not
 * `firebase/firestore`, not `firebase-admin`. The client and the rules suites
 * import it directly; a Firestore import would break the second, which runs in
 * a Node context with no app bundle.
 *
 * THE FUNCTIONS CONSUME A MIRROR, NOT THIS FILE (Codex P2 on PR #891). The
 * Functions project cannot import this module by relative path:
 * `functions/tsconfig.json` sets `rootDir: "src"`, so a RUNTIME import from
 * `../../src/**` fails with TS6059 — verified, not assumed. The two existing
 * cross-tree imports (`functions/src/dailyEmailContent.ts:19`,
 * `functions/src/finaleContent.ts:26`) work only because they are
 * `import type` from a declaration-only `.d.ts`, which emits nothing; they are
 * not a precedent for runtime code.
 *
 * The repo's established answer for runtime logic the Functions also need is a
 * LOCAL MIRROR plus a parity test — `functions/src/scoringVocab.ts` mirrors
 * `src/game/scoring.ts`, and `tests/functions/finale-parity.test.ts` feeds one
 * fixture to both and fails if either side moves alone, because (in that
 * mirror's own words) a mirror without a parity test is how the podium
 * implementations diverged in the first place. #803 adds
 * `functions/src/membershipVocab.ts` on exactly that pattern when the first
 * callable needs these predicates. Until then there is no second copy to drift.
 *
 * THE INVARIANT THIS FILE PROTECTS. A membership record is one a client cannot
 * write. Today's Event "membership" fails that test: `events/{eventId}/players/{uid}`
 * is `allow create, update: if isOwner(uid) || isAdmin(eventId)` with no
 * membership precondition, so any signed-in account mints its own row under any
 * `eventId` and then satisfies any gate keyed off it (#844; `specs/x-multi-event-schema.md`
 * § "Rules / indexes / hosting implications"). Nothing in this module treats a
 * Player row as evidence of admission, and nothing downstream may either.
 */

import type {
  AdmissionDecision,
  AdmissionOutcome,
  EventDoc,
  MembershipDoc,
  MembershipEnforcement,
  MembershipRole,
  MembershipStatus,
} from '../domainTypes';

/** The collection under an Event that holds its admission records. */
export const MEMBERSHIP_COLLECTION = 'memberships';

/**
 * The envelope version of the shape `readMembership` understands.
 *
 * Follows the versioned-envelope convention `src/eventResolution.ts` uses for
 * its hostname cache (`CACHE_VERSION`) and `cardCache.ts` for its snapshots: a
 * record written by a shape this build does not understand reads as a MISS,
 * never as coerced data.
 *
 * DELIBERATELY NOT AN AUTHORIZATION INPUT — see `admits` below.
 */
export const MEMBERSHIP_SCHEMA_VERSION = 1;

/**
 * The one path builder. Rules, Storage rules, the client, the Functions and the
 * seeds all derive the membership document from `(eventId, uid)` and nothing
 * else, because `storage.rules` can only reach Firestore through
 * `firestore.get()` on a fully-qualified path — it cannot run a query. A shape
 * that needed a lookup (a membership array on the Event doc, a subcollection
 * under `users/{uid}`) would be unreachable from Storage, which is what
 * eliminated those shapes. See specs/event-membership.md § "One get, no query".
 *
 * The document id IS the uid. That is not a convenience; it is the constraint.
 */
export function membershipPath(eventId: string, uid: string): string {
  return `events/${eventId}/${MEMBERSHIP_COLLECTION}/${uid}`;
}

/** The Firestore-rules absolute form of {@link membershipPath}, which is what
 *  `storage.rules` must pass to `firestore.get()`. Exported so the spec's
 *  reference predicate and the Storage transcription are generated from one
 *  string rather than two hand-copies. */
export function membershipRulesPath(eventId: string, uid: string): string {
  return `/databases/(default)/documents/${membershipPath(eventId, uid)}`;
}

const ROLES: readonly MembershipRole[] = ['member', 'admin'];

/** Role precedence, lowest first. `admin` satisfies a `member` requirement;
 *  `member` does not satisfy an `admin` one. Admin is the ONLY privileged role
 *  today (`CONTEXT.md` § People) — the lattice exists so adding a third role is
 *  a table edit rather than a rewrite of every call site. */
const ROLE_RANK: Record<MembershipRole, number> = { member: 0, admin: 1 };

function isRole(value: unknown): value is MembershipRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is MembershipStatus {
  return value === 'active' || value === 'revoked';
}

/**
 * THE FROZEN CORE of the contract: a record is an admission iff it exists at
 * {@link membershipPath} and its `status` is exactly `'active'`.
 *
 * Deliberately version-BLIND, and deliberately reading one field. Both choices
 * are about keeping the rules transcription honest:
 *
 *  - **Version-blind** because gating authorization on `schemaVersion` would put
 *    a rules deploy in lockstep with every data migration: bump the version,
 *    and every already-written record stops authorizing until the rules catch
 *    up. That is the same deploy-ordering outage the per-Event enforcement
 *    switch exists to prevent, reintroduced one layer down. `status` and the
 *    path are therefore frozen forever; everything else on the document may
 *    version freely.
 *  - **One field** because every clause here is transcribed into
 *    `firestore.rules` AND `storage.rules`, and each costs evaluated
 *    expressions against a 1,000-expression budget the `events/{eventId}` rule
 *    has already blown (#850).
 *
 * Takes the raw document data rather than a parsed `MembershipDoc` precisely
 * BECAUSE rules see raw data. If this took a parsed value it would be testing a
 * different question than the one rules ask.
 */
export function isActiveMembershipData(raw: unknown): boolean {
  if (raw == null || typeof raw !== 'object') return false;
  return (raw as { status?: unknown }).status === 'active';
}

/**
 * The versioned parse, for consumers that need the whole record — the role, the
 * grant provenance, the revocation audit fields. Absent, corrupt, shape-drifted
 * and version-drifted all read as `null`, never as coerced data (ADR 0009's
 * cache convention).
 *
 * A `null` here does NOT mean "not admitted" — see the parity note on
 * {@link admits}. A newer-versioned record still authorizes; this build simply
 * cannot read its extra fields.
 */
export function readMembership(raw: unknown): MembershipDoc | null {
  if (raw == null || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;

  if (d.schemaVersion !== MEMBERSHIP_SCHEMA_VERSION) return null;
  if (typeof d.eventId !== 'string' || d.eventId === '') return null;
  if (typeof d.uid !== 'string' || d.uid === '') return null;
  if (!isRole(d.role)) return null;
  if (!isStatus(d.status)) return null;
  if (typeof d.grantedAt !== 'number' || !Number.isFinite(d.grantedAt)) return null;
  if (typeof d.grantedBy !== 'string' || d.grantedBy === '') return null;
  if (!(d.invitationId === null || typeof d.invitationId === 'string')) return null;

  // Revocation is a PAIR, and its consistency with `status` is part of the
  // shape (Codex P2 on PR #891). A revoked record without usable audit fields
  // has lost the provenance the record exists to carry; an active record still
  // carrying them is a half-applied write. Either way the document is
  // internally inconsistent, and coercing it — silently dropping the unusable
  // half, or retaining a stale one beside `status: 'active'` — hands consumers
  // a "parsed" revocation with no author or date. Read both as a MISS.
  //
  // This is a PARSE decision, never an authorization one: `admits` reads
  // `status` and nothing else, so an inconsistent revoked record still denies
  // and an inconsistent active one still admits, exactly as the rules would.
  // Strictness here can only change what a consumer may READ, never who gets in.
  const revokedAtOk = typeof d.revokedAt === 'number' && Number.isFinite(d.revokedAt);
  const revokedByOk = typeof d.revokedBy === 'string' && d.revokedBy !== '';
  if (d.status === 'revoked' && !(revokedAtOk && revokedByOk)) return null;
  if (d.status === 'active' && (d.revokedAt !== undefined || d.revokedBy !== undefined)) {
    return null;
  }

  const parsed: MembershipDoc = {
    schemaVersion: MEMBERSHIP_SCHEMA_VERSION,
    eventId: d.eventId,
    uid: d.uid,
    role: d.role,
    status: d.status,
    grantedAt: d.grantedAt,
    grantedBy: d.grantedBy,
    invitationId: d.invitationId,
  };
  if (d.status === 'revoked') {
    parsed.revokedAt = d.revokedAt as number;
    parsed.revokedBy = d.revokedBy as string;
  }
  return parsed;
}

/** Does a held role satisfy a required one? Total over the role lattice. */
export function membershipRoleSatisfies(
  held: MembershipRole,
  required: MembershipRole,
): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

/**
 * The per-Event enforcement switch, resolved.
 *
 * ABSENT MEANS `'off'`, and that default is load-bearing rather than lax: every
 * Event document in existence predates this field, and both live cohorts joined
 * by self-creating `players` rows, so a deploy that read a missing field as
 * "enforce" would lock out every player of both Events mid-Event. Safety comes
 * from the rollout being explicit per Event (#805), not from the default.
 *
 * Read the same defensive way `dailyEmailEnabled` is read server-side — only an
 * EXPLICIT `'enforced'` enforces, so a half-written or partially-migrated Event
 * document degrades to today's behaviour rather than to an outage.
 */
export function membershipEnforcementFor(
  event: Pick<EventDoc, 'membershipEnforcement'> | null | undefined,
): MembershipEnforcement {
  return event?.membershipEnforcement === 'enforced' ? 'enforced' : 'off';
}

/**
 * THE decision. Every consumer asks this function rather than assembling the
 * clauses itself, so "is this UID in this Event?" has exactly one answer in the
 * codebase and one transcription target in the two rules files.
 *
 * PARITY WITH RULES IS THE POINT. This mirrors, clause for clause, the
 * predicate specs/event-membership.md § "The shared predicate" hands to #804
 * and #806. It therefore:
 *
 *  - reads the RAW membership data, not a parsed record (rules see raw data);
 *  - is version-blind (see {@link isActiveMembershipData});
 *  - does NOT treat Admin as implying admission. `EventDoc.admins` stays the
 *    sole authority on PRIVILEGE and `memberships` the sole authority on
 *    ADMISSION; the model instead requires every Admin to hold a membership,
 *    an invariant {@link adminsMissingMembership} checks and the grant path
 *    maintains. A disjunction here would make `admins` a second membership
 *    system, cost a second `firestore.get()` on every Storage media read, and
 *    still need the invariant anyway. The break-glass for an Admin locked out
 *    by a backfill miss is the enforcement switch, not a rules clause.
 *
 * BANNING IS DELIBERATELY NOT ADMISSION. `isBanned` is accepted and, by design,
 * changes nothing about the outcome. `EventDoc.bannedUids` is a presentational,
 * Event-scoped hide/mute of a Player's CONTENT (ADR 0004 Phase 0; the field's
 * own contract in `src/domainTypes.d.ts` says it is "NOT hard access
 * revocation"). A banned Player is still in the room. If the intent is to put
 * them OUT of the room, that is revocation, which is this record's `status`.
 * The parameter exists so the non-interaction is stated and TESTED here rather
 * than left as an accidental omission that a later reader might "fix".
 */
export function admits(input: {
  /**
   * The authenticated caller's uid, or `null`/`undefined` when there is no
   * authenticated identity.
   *
   * REQUIRED, and checked FIRST — before the enforcement switch (Codex P2 on
   * PR #891). The reference predicate's leading clause is `signedIn()`, so a
   * version of this function that answered from `enforcement` alone would
   * admit an UNAUTHENTICATED caller for every Event in the dark-rollout state,
   * which is every Event today. That is not what an unenforced Event means:
   * unenforced is open to any signed-in account, never to the public.
   *
   * Deliberately NOT compared against the membership record's own `uid`. The
   * document path encodes the uid, so the caller has already selected the
   * right record by construction, and rules perform no such comparison —
   * adding one here would be a divergence in the other direction.
   */
  uid: string | null | undefined;
  /** Resolved from the Event document by {@link membershipEnforcementFor}. */
  enforcement: MembershipEnforcement;
  /** Raw data at {@link membershipPath}; `null`/`undefined` when absent. */
  membership: unknown;
  /** Whether the uid appears in `EventDoc.bannedUids`. Does not affect admission. */
  isBanned?: boolean;
}): AdmissionDecision {
  const { uid, enforcement, membership } = input;

  if (typeof uid !== 'string' || uid === '') {
    return { admitted: false, outcome: 'denied-not-signed-in' };
  }
  if (enforcement !== 'enforced') {
    return { admitted: true, outcome: 'admitted-unenforced' };
  }
  if (membership == null || typeof membership !== 'object') {
    return { admitted: false, outcome: 'denied-not-a-member' };
  }
  if (isActiveMembershipData(membership)) {
    return { admitted: true, outcome: 'admitted' };
  }
  const status = (membership as { status?: unknown }).status;
  return {
    admitted: false,
    outcome: status === 'revoked' ? 'denied-revoked' : 'denied-unreadable',
  };
}

/**
 * The reconciliation check: which Admins hold no active membership?
 *
 * Non-empty is a violation of the model's central invariant — admission is a
 * precondition for privilege — and, once an Event is enforced, is exactly the
 * set of people locked out of an Event they administer. #805's backfill grants
 * these FIRST, before any enforcement flip, and this predicate is what makes
 * "first" checkable rather than merely instructed.
 *
 * Pure and order-independent: takes the Event's `admins` roster and whatever
 * membership records were read, and returns the uids in the first with no
 * ACTIVE record in the second. A revoked Admin counts as missing, because a
 * revoked membership does not admit.
 */
export function adminsMissingMembership(input: {
  admins: readonly string[];
  /** Raw membership data keyed by uid, as read from the `memberships` collection. */
  memberships: Readonly<Record<string, unknown>>;
}): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const uid of input.admins) {
    if (typeof uid !== 'string' || uid === '' || seen.has(uid)) continue;
    seen.add(uid);
    if (!isActiveMembershipData(input.memberships[uid])) missing.push(uid);
  }
  return missing;
}

export type { AdmissionDecision, AdmissionOutcome };
