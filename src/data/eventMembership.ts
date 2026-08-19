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
 * LOCAL MIRROR plus a parity test (`functions/src/scoringVocab.ts` mirrors
 * `src/game/scoring.ts`, pinned by `tests/functions/finale-parity.test.ts`).
 * That precedent is deliberately NOT adopted here: drift in a scoring mirror
 * mis-ranks a podium, drift in this one is an authorization bug, and fixtures
 * only cover the cases someone enumerated. #803 must arrive at ONE
 * implementation — a shared build arrangement, or a mirror GENERATED from this
 * file — rather than a second hand-maintained copy. See
 * specs/event-membership.md § One document. Until then there is no second copy.
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
  MembershipBase,
  MembershipDoc,
  MembershipEnforcement,
  MembershipRole,
  MembershipStatus,
} from '../types';

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
 *
 * ANNOTATED, NOT INFERRED (Phase 4b P2 on PR #891). The type annotation is the
 * lockstep with `MembershipBase['schemaVersion']` that the contract's own
 * comment promises. Left inferred, the two `1`s were independent literals: a
 * writer could bump one and type-check, persisting records that AUTHORIZE —
 * `admits()` is version-blind by design — while `readMembership()` rejects
 * every one of them, and no test would fail because the fixtures derive their
 * version from THIS constant. Now a one-sided bump is a compile error.
 */
export const MEMBERSHIP_SCHEMA_VERSION: MembershipBase['schemaVersion'] = 1;

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
  // `null` is RESERVED for grants with no invitation (provisioner, backfill).
  // An empty string is neither a real invitation id nor that reserved value, so
  // accepting it would record an invitation-backed grant that cannot name the
  // single-use invitation it consumed — losing exactly the provenance #803
  // needs to diagnose reuse (Codex P2 on PR #891).
  if (!(d.invitationId === null || (typeof d.invitationId === 'string' && d.invitationId !== '')))
    return null;

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

  const base = {
    schemaVersion: MEMBERSHIP_SCHEMA_VERSION,
    eventId: d.eventId,
    uid: d.uid,
    role: d.role,
    grantedAt: d.grantedAt,
    grantedBy: d.grantedBy,
    invitationId: d.invitationId,
  } as const;

  return d.status === 'revoked'
    ? { ...base, status: 'revoked', revokedAt: d.revokedAt as number, revokedBy: d.revokedBy as string }
    : { ...base, status: 'active' };
}

/**
 * Does a held role satisfy a required one? Total over the role lattice.
 *
 * FOR REASONING ABOUT A GRANT, NEVER FOR AUTHORIZING AN ACTION (Codex P2 on
 * PR #891). `role` records what the grant conferred at grant time, and
 * `EventDoc.admins` is client-writable, so the two drift in both directions: an
 * array-edit promotion leaves `role: 'member'` on a real Admin, and an
 * array-edit demotion leaves `role: 'admin'` on someone who is no longer one.
 * Using this to decide whether a caller may issue an invitation would therefore
 * both admit demoted Admins and deny promoted ones. Anything deciding what a
 * caller may DO reads the live roster instead.
 */
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
 *  - does NOT treat Admin as implying admission IN THE FINAL POSTURE.
 *    `EventDoc.admins` stays the sole authority on PRIVILEGE and `memberships`
 *    the sole authority on ADMISSION; the model requires every Admin to hold a
 *    membership, an invariant {@link adminsMissingMembership} checks and the
 *    grant path maintains. A permanent disjunction would make `admins` a second
 *    membership system, cost a second `firestore.get()` on every Storage media
 *    read, and still need the invariant anyway.
 *
 * THE TRANSITIONAL EXCEPTION, AND WHY IT IS A PARAMETER. Decision D-A (ruled by
 * the owner 2026-08-18) ships exactly that disjunction — `|| isAdmin(eventId)` —
 * in #804 and removes it once #805's backfill is verified. The three objections
 * above are still true; they are why it is transitional rather than the design.
 * `transitionalAdminBypass` therefore selects the posture instead of the module
 * picking one, so parity can be pinned against whichever rules text is deployed
 * (Phase 4b P1 on PR #891: a reference that could not express D-A would force
 * #804 to contradict either the ruling or these tests, and could authorize one
 * UID differently across Firestore, Storage and Functions).
 *
 *    **The bypass admits a REVOKED Admin, and that is not an oversight.**
 *    `|| isAdmin(eventId)` is a pure disjunct in rules, so it fires no matter
 *    WHY the membership check failed — absent, revoked, or unreadable. Mirroring
 *    that faithfully re-opens the round 4 P1 on this PR ("revoked Admin still
 *    passes `isAdmin()`") for the duration of the rollout. Narrowing it here to
 *    exclude revocation would be safer in isolation and WORSE in aggregate: the
 *    reference would no longer match the deployed clause, which is the precise
 *    failure this parameter exists to prevent. If that residual is unacceptable,
 *    the fix belongs in D-A — a narrowed rules clause costing another `get()` —
 *    not in a reference that silently disagrees with the rules.
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
  /**
   * Whether the uid appears in `EventDoc.admins`. Consulted ONLY when
   * {@link transitionalAdminBypass} is in force; absent that flag this input is
   * inert, because the final posture denies an Admin who holds no membership.
   */
  isAdmin?: boolean;
  /**
   * Whether Decision D-A's transitional `|| isAdmin(eventId)` disjunct is
   * deployed (Phase 4b P1 on PR #891).
   *
   * A DEPLOY-TIME property, not data: it is the presence of a clause in the
   * rules text during rollout, and #804 ships it while a follow-up removes it.
   * It is a parameter here rather than a constant so the reference predicate
   * can be exercised in BOTH postures and pinned against whichever rules text
   * is actually deployed — the alternative, hard-coding one of them, is what
   * makes a reference and its rules drift.
   *
   * Defaults to `false`: the final posture is the contract, and the bypass is
   * the temporary deviation that has to be asked for explicitly.
   *
   * SCOPED TO THE TWO RULES SURFACES. `firestore.rules` (#804) and
   * `storage.rules` (#806) pass it during rollout; #803's invitation callable
   * does NOT, and that is a decision rather than an oversight — minting an
   * invitation is a deferred action rather than an outage, and a bypass there
   * would let a UID added to the client-writable `admins` array mint durable
   * memberships that survive the flip. Placement matters as much as presence:
   * on Storage this disjunct must precede the membership `get()`, whose
   * missing-document ERROR would otherwise deny before it is reached.
   */
  transitionalAdminBypass?: boolean;
}): AdmissionDecision {
  const { uid, enforcement, membership, isAdmin, transitionalAdminBypass } = input;

  if (typeof uid !== 'string' || uid === '') {
    return { admitted: false, outcome: 'denied-not-signed-in' };
  }
  if (enforcement !== 'enforced') {
    return { admitted: true, outcome: 'admitted-unenforced' };
  }
  if (membership == null || typeof membership !== 'object') {
    if (transitionalAdminBypass === true && isAdmin === true) {
      return { admitted: true, outcome: 'admitted-admin-transitional' };
    }
    return { admitted: false, outcome: 'denied-not-a-member' };
  }
  if (isActiveMembershipData(membership)) {
    return { admitted: true, outcome: 'admitted' };
  }
  if (transitionalAdminBypass === true && isAdmin === true) {
    return { admitted: true, outcome: 'admitted-admin-transitional' };
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
 * Pure, and order-independent in the strong sense: the returned array is
 * sorted, so the same Admin set yields a byte-identical result regardless of
 * roster order. Takes the Event's `admins` roster and whatever membership
 * records were read, and returns the uids in the first with no ACTIVE record in
 * the second. A revoked Admin counts as missing, because a revoked membership
 * does not admit.
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
  // Sorted, so the documented order-independence is a property of the RESULT
  // and not merely of the answer's membership (Phase 4b P3 on PR #891). Without
  // this the output followed `input.admins` order, so the same Admin set read
  // back in a different order produced a different array — and #805 compares
  // and logs this list across runs.
  return missing.sort();
}

/**
 * May this caller ISSUE an invitation, or REVOKE a membership — that is, act
 * on SOMEONE ELSE'S admission?
 *
 * A different question from {@link admits}, and the distinction is the whole
 * point of this function existing (Phase 4b P1, round 4).
 *
 * `admits()` answers ACCESS: may this caller read and write inside this Event
 * right now. It is deliberately permissive while an Event is unenforced —
 * `admitted-unenforced` is returned before `membership` is even inspected,
 * because that is what a dark rollout means. That is correct for gating reads
 * and writes, whose effects are confined to the window in which they happen.
 *
 * It is WRONG for authorizing a grant, because a membership OUTLIVES that
 * window. § Rollout step 3 enables #803's invitation callable while every Event
 * is still `'off'`, so a caller authorized by `admits()` alone needs no
 * membership at all — and a UID added to the client-writable `EventDoc.admins`
 * array could mint invitations whose memberships are still there, and now
 * decisive, after the flip to `'enforced'`. A transient permissiveness would
 * have written a permanent admission. That is round 7's P1 arriving through the
 * one door the enforcement switch cannot close behind it.
 *
 * **It does NOT cover invitation REDEMPTION, and conflating the two was a real
 * defect** (Phase 4b P1, round 5). An earlier version of this contract said
 * *anything* minting a membership asks this predicate. Redemption mints a
 * membership and is performed by the INVITEE, who by definition holds neither a
 * membership nor a place in `admins` — so that rule rejected every first-time
 * redemption and left only the provisioner and backfill paths. It was the same
 * circular bootstrap § Rollout step 2 exists to break, reintroduced one level
 * down: requiring prior admission for the act whose purpose is to create the
 * first admission.
 *
 * The two authorities are therefore distinct, and only the first is this
 * function's business:
 *
 *  - **Issuance and revocation** — acting on someone else's admission. Requires
 *    standing in the Event, which is what this predicate expresses.
 *  - **Redemption** — an invitee consuming a single-use invitation to gain
 *    their OWN admission. Authorized by the authenticated invitee plus a valid,
 *    unconsumed invitation bound to them, and by nothing about their prior
 *    membership, which is precisely nil. That check belongs to #803 alongside
 *    the invitation record itself; it is not specified here because the
 *    invitation's shape is still open (§ Decisions, D4) and a predicate written
 *    over an undecided type would be a guess wearing a contract's clothes.
 *
 * So this predicate is **enforcement-blind by construction**. It takes no
 * enforcement input, because there is no state of the switch in which issuing
 * or revoking admission without holding it is acceptable. It requires,
 * conjoined:
 *
 *  1. an authenticated caller;
 *  2. presence in the LIVE `EventDoc.admins` roster — not `MembershipRole`,
 *     which is grant-time and drifts both ways against the array (§ Decisions,
 *     D8);
 *  3. an ACTIVE membership of their own.
 *
 * Decision D-A's transitional bypass is deliberately absent: D-A is scoped to
 * the two rules surfaces, and a bypass here is exactly the durable-admission
 * hole described above. An Admin the backfill missed cannot mint invitations
 * until they are granted a membership server-side — a deferred action with a
 * known remedy, not an outage.
 */
export function mayAdministerMembership(input: {
  /** The authenticated caller's uid. */
  uid: string | null | undefined;
  /** Whether the uid appears in the LIVE `EventDoc.admins` array. */
  isAdmin: boolean;
  /** Raw data at the CALLER's own {@link membershipPath}. */
  membership: unknown;
}): boolean {
  if (typeof input.uid !== 'string' || input.uid === '') return false;
  if (input.isAdmin !== true) return false;
  return isActiveMembershipData(input.membership);
}

export type { AdmissionDecision, AdmissionOutcome };
