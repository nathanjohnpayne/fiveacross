/**
 * Event Invitation decision layer (#803).
 *
 * This module owns no Firebase runtime objects. Firestore, time, timestamps,
 * entropy, and the unresolved product choices are injected so transaction
 * behavior can be proven without weakening the production seam. Invitation
 * codes are bearer capabilities: only their SHA-256 digest is stored, and the
 * raw code appears only in the fragment of the returned URL.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { MembershipRole } from '../../src/domainTypes';
import {
  MEMBERSHIP_SCHEMA_VERSION,
  mayAdministerMembership,
  membershipPath,
  readMembership,
} from './eventMembership.generated';

export const EVENT_INVITATION_COLLECTION = 'eventInvitations';
export const EVENT_INVITATION_RATE_COLLECTION = 'eventInvitationRateLimits';
export const EVENT_INVITATION_FRAGMENT_KEY = 'fa_invite';
export const EVENT_INVITATION_SCHEMA_VERSION = 1 as const;
export const EVENT_INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const EVENT_INVITATION_ID_PATTERN = /^[a-f0-9]{64}$/;
export const EVENT_INVITATION_EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const EVENT_INVITATION_MAX_EVENT_ID_LENGTH = 128;

const TOKEN_BYTES = 32;
const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_UID = 256;
/** Keeps cascade reads and writes comfortably below Firestore's 500-write cap. */
export const MAX_INVITATION_USES = 100;
const MAX_RATE_ATTEMPTS = 1_000;
const MAX_RATE_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_TTL_MS = 31 * 24 * 60 * 60 * 1_000;
const CODE_MINT_ATTEMPTS = 3;
const RATE_HASH_DOMAIN = 'event-invitation-rate-v1\0';

export type InvitationOperation = 'mint' | 'redeem' | 'revoke';

export interface InvitationRatePolicy {
  windowMs: number;
  maxAttempts: number;
}

/** No product choice is defaulted in the decision layer. */
export interface EventInvitationPolicy {
  ttlMs: number;
  grantRole: MembershipRole;
  maxUses: number;
  revokeGrantedMemberships: boolean;
  rate: Readonly<Record<InvitationOperation, InvitationRatePolicy>>;
}

export interface InvitationSnapshot {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface InvitationDocRef {
  readonly path: string;
}

export interface InvitationQueryDoc {
  readonly id: string;
  data(): Record<string, unknown> | undefined;
}

export interface InvitationQuerySnapshot {
  readonly docs: readonly InvitationQueryDoc[];
}

/** Opaque to the core; the runtime adapter may wrap an Admin SDK Query. */
export interface InvitationQuery {
  readonly eventId: string;
}

export interface InvitationTransaction {
  get(ref: InvitationDocRef): Promise<InvitationSnapshot>;
  getQuery(query: InvitationQuery): Promise<InvitationQuerySnapshot>;
  create(ref: InvitationDocRef, data: Record<string, unknown>): void;
  set(ref: InvitationDocRef, data: Record<string, unknown>): void;
  update(ref: InvitationDocRef, data: Record<string, unknown>): void;
}

export interface InvitationFirestore {
  doc(path: string): InvitationDocRef;
  hostnamesForEvent(eventId: string): InvitationQuery;
  runTransaction<T>(work: (transaction: InvitationTransaction) => Promise<T>): Promise<T>;
}

export interface EventInvitationDeps {
  db: InvitationFirestore;
  /** Called inside every transaction attempt, never before it. */
  now(): number;
  timestamp(ms: number): unknown;
  mintCode?: () => string;
  policy: EventInvitationPolicy;
}

export type MintInvitationReason =
  | 'unauthenticated'
  | 'invalid-event-id'
  | 'invalid-policy'
  | 'rate-limited'
  | 'event-unavailable'
  | 'not-authorized'
  | 'canonical-host-unavailable'
  | 'invalid-generated-code'
  | 'code-collision';

export type MintInvitationResult =
  | {
      ok: true;
      eventId: string;
      invitationId: string;
      code: string;
      invitationUrl: string;
      expiresAt: number;
    }
  | { ok: false; reason: MintInvitationReason };

export type RedeemInvitationReason =
  | 'unauthenticated'
  | 'invalid-code'
  | 'invalid-event-id'
  | 'invalid-policy'
  | 'rate-limited'
  | 'unknown-invitation'
  | 'invalid-invitation'
  | 'event-mismatch'
  | 'event-unavailable'
  | 'invitation-unavailable'
  | 'membership-revoked'
  | 'membership-unreadable';

export type RedeemInvitationResult =
  | { ok: true; eventId: string; outcome: 'membership-created' | 'already-member' }
  | { ok: false; reason: RedeemInvitationReason };

export type RevokeInvitationReason =
  | 'unauthenticated'
  | 'invalid-event-id'
  | 'invalid-invitation-id'
  | 'invalid-policy'
  | 'rate-limited'
  | 'event-unavailable'
  | 'not-authorized'
  | 'unknown-invitation'
  | 'invalid-invitation'
  | 'event-mismatch'
  | 'cascade-conflict';

export type RevokeInvitationResult =
  | {
      ok: true;
      eventId: string;
      invitationId: string;
      outcome: 'revoked' | 'already-revoked';
      membershipAccess: 'invitation-only' | 'pending-enforcement' | 'revoked';
    }
  | { ok: false; reason: RevokeInvitationReason };

type InvitationStatus = 'active' | 'consumed' | 'revoked';

interface InvitationRecord {
  schemaVersion: 1;
  eventId: string;
  role: MembershipRole;
  createdBy: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: InvitationStatus;
  maxUses: number;
  remainingUses: number;
  grantedUids: string[];
  revokedAtMs: number | null;
  revokedBy: string | null;
}

function defaultMintCode(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function isSafePathPart(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isEventId(value: unknown): value is string {
  return isSafePathPart(value, EVENT_INVITATION_MAX_EVENT_ID_LENGTH) && EVENT_INVITATION_EVENT_ID_PATTERN.test(value);
}

function isUid(value: unknown): value is string {
  return isSafePathPart(value, MAX_UID);
}

function isRole(value: unknown): value is MembershipRole {
  return value === 'member' || value === 'admin';
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value > 0 && value <= maximum;
}

function policyIsValid(policy: EventInvitationPolicy): boolean {
  if (!Number.isFinite(policy.ttlMs) || policy.ttlMs <= 0 || policy.ttlMs > MAX_TTL_MS) return false;
  if (!isRole(policy.grantRole)) return false;
  if (!isPositiveInteger(policy.maxUses, MAX_INVITATION_USES)) return false;
  if (typeof policy.revokeGrantedMemberships !== 'boolean') return false;
  return (['mint', 'redeem', 'revoke'] as const).every((operation) => {
    const rate = policy.rate?.[operation];
    return (
      rate !== undefined &&
      Number.isFinite(rate.windowMs) &&
      rate.windowMs > 0 &&
      rate.windowMs <= MAX_RATE_WINDOW_MS &&
      isPositiveInteger(rate.maxAttempts, MAX_RATE_ATTEMPTS)
    );
  });
}

function readTimestampMillis(value: unknown): number | null {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis !== 'function') return null;
    try {
      const result = toMillis.call(value);
      return typeof result === 'number' && Number.isFinite(result) ? result : null;
    } catch {
      return null;
    }
  }
  return null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readInvitation(raw: unknown): InvitationRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (
    !exactKeys(data, [
      'schemaVersion',
      'eventId',
      'role',
      'createdBy',
      'createdAt',
      'expiresAt',
      'status',
      'maxUses',
      'remainingUses',
      'grantedUids',
      'revokedAt',
      'revokedBy',
    ])
  ) return null;
  if (data.schemaVersion !== EVENT_INVITATION_SCHEMA_VERSION) return null;
  if (!isEventId(data.eventId) || !isRole(data.role) || !isUid(data.createdBy)) return null;
  if (!isPositiveInteger(data.maxUses, MAX_INVITATION_USES)) return null;
  if (!Number.isInteger(data.remainingUses) || typeof data.remainingUses !== 'number') return null;
  if (data.remainingUses < 0 || data.remainingUses > data.maxUses) return null;
  if (!Array.isArray(data.grantedUids) || data.grantedUids.some((uid) => !isUid(uid))) return null;
  const grantedUids = [...data.grantedUids] as string[];
  if (new Set(grantedUids).size !== grantedUids.length) return null;
  if (grantedUids.length > data.maxUses || data.remainingUses !== data.maxUses - grantedUids.length) return null;
  const createdAtMs = readTimestampMillis(data.createdAt);
  const expiresAtMs = readTimestampMillis(data.expiresAt);
  if (createdAtMs === null || expiresAtMs === null || expiresAtMs <= createdAtMs) return null;
  if (data.status !== 'active' && data.status !== 'consumed' && data.status !== 'revoked') return null;
  if (data.status === 'active' && data.remainingUses === 0) return null;
  if (data.status === 'consumed' && data.remainingUses !== 0) return null;
  const revokedAtMs = data.revokedAt === null ? null : readTimestampMillis(data.revokedAt);
  const revokedBy = data.revokedBy === null ? null : data.revokedBy;
  if (data.status === 'revoked') {
    if (revokedAtMs === null || !isUid(revokedBy)) return null;
  } else if (data.revokedAt !== null || data.revokedBy !== null) {
    return null;
  }
  return {
    schemaVersion: EVENT_INVITATION_SCHEMA_VERSION,
    eventId: data.eventId,
    role: data.role,
    createdBy: data.createdBy,
    createdAtMs,
    expiresAtMs,
    status: data.status,
    maxUses: data.maxUses,
    remainingUses: data.remainingUses,
    grantedUids,
    revokedAtMs,
    revokedBy: typeof revokedBy === 'string' ? revokedBy : null,
  };
}

export function buildInvitationRecord(input: {
  eventId: string;
  role: MembershipRole;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  timestamp(ms: number): unknown;
}): Record<string, unknown> {
  return {
    schemaVersion: EVENT_INVITATION_SCHEMA_VERSION,
    eventId: input.eventId,
    role: input.role,
    createdBy: input.createdBy,
    createdAt: input.timestamp(input.createdAt),
    expiresAt: input.timestamp(input.expiresAt),
    status: 'active',
    maxUses: input.maxUses,
    remainingUses: input.maxUses,
    grantedUids: [],
    revokedAt: null,
    revokedBy: null,
  };
}

export function invitationIdForCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function invitationPath(invitationId: string): string {
  return `${EVENT_INVITATION_COLLECTION}/${invitationId}`;
}

export function invitationRatePath(operation: InvitationOperation, uid: string): string {
  const id = createHash('sha256')
    .update(RATE_HASH_DOMAIN, 'utf8')
    .update(operation, 'utf8')
    .update('\0', 'utf8')
    .update(uid, 'utf8')
    .digest('hex');
  return `${EVENT_INVITATION_RATE_COLLECTION}/${id}`;
}

function activeEvent(raw: unknown): {
  admins: string[];
  membershipEnforcement: 'off' | 'enforced';
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (data.status !== 'active' || !Array.isArray(data.admins) || data.admins.some((uid) => !isUid(uid))) return null;
  return {
    admins: [...data.admins] as string[],
    // This intentionally mirrors membershipEnforcementFor(): only the exact
    // rollout sentinel enables enforcement; absent or malformed values retain
    // the repository's fail-open migration posture.
    membershipEnforcement: data.membershipEnforcement === 'enforced' ? 'enforced' : 'off',
  };
}

function canonicalHost(snapshot: InvitationQuerySnapshot, eventId: string): string | null {
  const canonical = snapshot.docs.filter((doc) => doc.data()?.isCanonical === true);
  if (canonical.length !== 1) return null;
  const doc = canonical[0];
  const data = doc.data() ?? {};
  if (
    data.eventId !== eventId ||
    data.status !== 'active' ||
    typeof data.edition !== 'string' ||
    data.edition === '' ||
    typeof data.slug !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(data.slug) ||
    data.canonicalHost !== doc.id ||
    !HOST_PATTERN.test(doc.id)
  ) return null;
  return doc.id;
}

function nextRateDocument(
  raw: unknown,
  operation: InvitationOperation,
  now: number,
  policy: InvitationRatePolicy,
): Record<string, unknown> | null {
  let attempts: number[] = [];
  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object') return null;
    const data = raw as Record<string, unknown>;
    if (!exactKeys(data, ['schemaVersion', 'operation', 'attemptMs'])) return null;
    if (data.schemaVersion !== 1 || data.operation !== operation || !Array.isArray(data.attemptMs)) return null;
    if (data.attemptMs.some((ms) => typeof ms !== 'number' || !Number.isFinite(ms) || ms > now)) return null;
    attempts = [...data.attemptMs] as number[];
  }
  const cutoff = now - policy.windowMs;
  const recent = attempts.filter((ms) => ms > cutoff);
  if (recent.length >= policy.maxAttempts) return null;
  return { schemaVersion: 1, operation, attemptMs: [...recent, now] };
}

async function readRate(
  tx: InvitationTransaction,
  ref: InvitationDocRef,
  operation: InvitationOperation,
  now: number,
  policy: InvitationRatePolicy,
): Promise<Record<string, unknown> | null> {
  const snapshot = await tx.get(ref);
  return nextRateDocument(snapshot.exists ? snapshot.data() : undefined, operation, now, policy);
}

function writeRate(tx: InvitationTransaction, ref: InvitationDocRef, document: Record<string, unknown>): void {
  tx.set(ref, document);
}

export interface MintEventInvitationInput {
  uid: unknown;
  eventId: unknown;
}

export async function mintEventInvitation(
  input: MintEventInvitationInput,
  deps: EventInvitationDeps,
): Promise<MintInvitationResult> {
  if (!isUid(input.uid)) return { ok: false, reason: 'unauthenticated' };
  if (!isEventId(input.eventId)) return { ok: false, reason: 'invalid-event-id' };
  if (!policyIsValid(deps.policy)) return { ok: false, reason: 'invalid-policy' };
  const uid = input.uid;
  const eventId = input.eventId;

  for (let collisionAttempt = 0; collisionAttempt < CODE_MINT_ATTEMPTS; collisionAttempt += 1) {
    const code = (deps.mintCode ?? defaultMintCode)();
    if (!EVENT_INVITATION_TOKEN_PATTERN.test(code)) return { ok: false, reason: 'invalid-generated-code' };
    const invitationId = invitationIdForCode(code);
    const result = await deps.db.runTransaction(async (tx): Promise<MintInvitationResult | { collision: true }> => {
      const now = deps.now();
      const rateRef = deps.db.doc(invitationRatePath('mint', uid));
      const rateDocument = await readRate(tx, rateRef, 'mint', now, deps.policy.rate.mint);
      if (!rateDocument) return { ok: false, reason: 'rate-limited' };
      const eventRef = deps.db.doc(`events/${eventId}`);
      const issuerRef = deps.db.doc(membershipPath(eventId, uid));
      const invitationRef = deps.db.doc(invitationPath(invitationId));
      const eventSnapshot = await tx.get(eventRef);
      const issuerSnapshot = await tx.get(issuerRef);
      const invitationSnapshot = await tx.get(invitationRef);
      if (invitationSnapshot.exists) {
        // A collision is an implementation detail, not a free way around the
        // caller's request budget. Intermediate retries stay invisible because
        // they are still one public mint call; terminal exhaustion records that
        // call exactly once before returning its closed failure.
        if (collisionAttempt === CODE_MINT_ATTEMPTS - 1) {
          writeRate(tx, rateRef, rateDocument);
        }
        return { collision: true };
      }
      const event = eventSnapshot.exists ? activeEvent(eventSnapshot.data()) : null;
      if (!event) {
        writeRate(tx, rateRef, rateDocument);
        return { ok: false, reason: 'event-unavailable' };
      }
      if (!mayAdministerMembership({
        uid,
        isAdmin: event.admins.includes(uid),
        membership: issuerSnapshot.exists ? issuerSnapshot.data() : null,
      })) {
        writeRate(tx, rateRef, rateDocument);
        return { ok: false, reason: 'not-authorized' };
      }
      const hostSnapshot = await tx.getQuery(deps.db.hostnamesForEvent(eventId));
      const host = canonicalHost(hostSnapshot, eventId);
      if (!host) {
        writeRate(tx, rateRef, rateDocument);
        return { ok: false, reason: 'canonical-host-unavailable' };
      }
      const expiresAt = now + deps.policy.ttlMs;
      writeRate(tx, rateRef, rateDocument);
      tx.create(invitationRef, buildInvitationRecord({
        eventId,
        role: deps.policy.grantRole,
        createdBy: uid,
        createdAt: now,
        expiresAt,
        maxUses: deps.policy.maxUses,
        timestamp: deps.timestamp,
      }));
      return {
        ok: true,
        eventId,
        invitationId,
        code,
        invitationUrl: `https://${host}/#${EVENT_INVITATION_FRAGMENT_KEY}=${code}`,
        expiresAt,
      };
    });
    if (!('collision' in result)) return result;
  }
  return { ok: false, reason: 'code-collision' };
}

export interface RedeemEventInvitationInput {
  uid: unknown;
  code: unknown;
  expectedEventId: unknown;
}

export async function redeemEventInvitation(
  input: RedeemEventInvitationInput,
  deps: EventInvitationDeps,
): Promise<RedeemInvitationResult> {
  if (!isUid(input.uid)) return { ok: false, reason: 'unauthenticated' };
  if (typeof input.code !== 'string' || !EVENT_INVITATION_TOKEN_PATTERN.test(input.code)) return { ok: false, reason: 'invalid-code' };
  if (!isEventId(input.expectedEventId)) return { ok: false, reason: 'invalid-event-id' };
  if (!policyIsValid(deps.policy)) return { ok: false, reason: 'invalid-policy' };
  const uid = input.uid;
  const expectedEventId = input.expectedEventId;
  const invitationId = invitationIdForCode(input.code);

  return deps.db.runTransaction(async (tx): Promise<RedeemInvitationResult> => {
    const now = deps.now();
    const rateRef = deps.db.doc(invitationRatePath('redeem', uid));
    const rateDocument = await readRate(tx, rateRef, 'redeem', now, deps.policy.rate.redeem);
    if (!rateDocument) return { ok: false, reason: 'rate-limited' };
    const invitationRef = deps.db.doc(invitationPath(invitationId));
    const invitationSnapshot = await tx.get(invitationRef);
    const refuse = (reason: RedeemInvitationReason): RedeemInvitationResult => {
      writeRate(tx, rateRef, rateDocument);
      return { ok: false, reason };
    };
    if (!invitationSnapshot.exists) {
      return refuse('unknown-invitation');
    }
    const invitation = readInvitation(invitationSnapshot.data());
    if (!invitation) {
      return refuse('invalid-invitation');
    }
    if (invitation.eventId !== expectedEventId) {
      return refuse('event-mismatch');
    }
    if (now < invitation.createdAtMs) return refuse('invalid-invitation');

    const eventRef = deps.db.doc(`events/${invitation.eventId}`);
    const membershipRef = deps.db.doc(membershipPath(invitation.eventId, uid));
    const eventSnapshot = await tx.get(eventRef);
    const membershipSnapshot = await tx.get(membershipRef);
    const event = eventSnapshot.exists ? activeEvent(eventSnapshot.data()) : null;
    if (!event) return refuse('event-unavailable');

    if (membershipSnapshot.exists) {
      const membership = readMembership(membershipSnapshot.data());
      if (!membership || membership.eventId !== invitation.eventId || membership.uid !== uid) {
        return refuse('membership-unreadable');
      }
      if (membership.status === 'active') {
        // Every active Membership is already admitted to the Event, regardless
        // of which grant created it or what later happened to this Invitation.
        // The idempotent check consumes no Invitation use but still spends
        // request budget so the public endpoint cannot amplify reads unbounded.
        writeRate(tx, rateRef, rateDocument);
        return { ok: true, eventId: invitation.eventId, outcome: 'already-member' };
      }
      return refuse('membership-revoked');
    }

    if (invitation.status !== 'active' || now >= invitation.expiresAtMs) {
      return refuse('invitation-unavailable');
    }
    const remainingUses = invitation.remainingUses - 1;
    const grantedUids = [...invitation.grantedUids, uid];
    writeRate(tx, rateRef, rateDocument);
    tx.create(membershipRef, {
      schemaVersion: MEMBERSHIP_SCHEMA_VERSION,
      eventId: invitation.eventId,
      uid,
      role: invitation.role,
      status: 'active',
      grantedAt: now,
      grantedBy: invitation.createdBy,
      invitationId,
    });
    tx.update(invitationRef, {
      status: remainingUses === 0 ? 'consumed' : 'active',
      remainingUses,
      grantedUids,
    });
    if (invitation.role === 'admin' && !event.admins.includes(uid)) {
      tx.update(eventRef, { admins: [...event.admins, uid] });
    }
    return { ok: true, eventId: invitation.eventId, outcome: 'membership-created' };
  });
}

export interface RevokeEventInvitationInput {
  uid: unknown;
  eventId: unknown;
  invitationId: unknown;
}

export async function revokeEventInvitation(
  input: RevokeEventInvitationInput,
  deps: EventInvitationDeps,
): Promise<RevokeInvitationResult> {
  if (!isUid(input.uid)) return { ok: false, reason: 'unauthenticated' };
  if (!isEventId(input.eventId)) return { ok: false, reason: 'invalid-event-id' };
  if (typeof input.invitationId !== 'string' || !EVENT_INVITATION_ID_PATTERN.test(input.invitationId)) {
    return { ok: false, reason: 'invalid-invitation-id' };
  }
  if (!policyIsValid(deps.policy)) return { ok: false, reason: 'invalid-policy' };
  const uid = input.uid;
  const eventId = input.eventId;
  const invitationId = input.invitationId;

  return deps.db.runTransaction(async (tx): Promise<RevokeInvitationResult> => {
    const now = deps.now();
    const rateRef = deps.db.doc(invitationRatePath('revoke', uid));
    const rateDocument = await readRate(tx, rateRef, 'revoke', now, deps.policy.rate.revoke);
    if (!rateDocument) return { ok: false, reason: 'rate-limited' };
    const eventRef = deps.db.doc(`events/${eventId}`);
    const issuerRef = deps.db.doc(membershipPath(eventId, uid));
    const invitationRef = deps.db.doc(invitationPath(invitationId));
    const eventSnapshot = await tx.get(eventRef);
    const issuerSnapshot = await tx.get(issuerRef);
    const invitationSnapshot = await tx.get(invitationRef);
    const event = eventSnapshot.exists ? activeEvent(eventSnapshot.data()) : null;
    if (!event) {
      writeRate(tx, rateRef, rateDocument);
      return { ok: false, reason: 'event-unavailable' };
    }
    if (!mayAdministerMembership({
      uid,
      isAdmin: event.admins.includes(uid),
      membership: issuerSnapshot.exists ? issuerSnapshot.data() : null,
    })) {
      writeRate(tx, rateRef, rateDocument);
      return { ok: false, reason: 'not-authorized' };
    }
    if (!invitationSnapshot.exists) {
      writeRate(tx, rateRef, rateDocument);
      return { ok: false, reason: 'unknown-invitation' };
    }
    const invitation = readInvitation(invitationSnapshot.data());
    if (!invitation) {
      writeRate(tx, rateRef, rateDocument);
      return { ok: false, reason: 'invalid-invitation' };
    }
    if (invitation.eventId !== eventId) {
      writeRate(tx, rateRef, rateDocument);
      return { ok: false, reason: 'event-mismatch' };
    }

    const cascadeSnapshots: Array<{
      uid: string;
      ref: InvitationDocRef;
      membership: { status: 'active' | 'revoked' };
    }> = [];
    if (deps.policy.revokeGrantedMemberships) {
      for (const grantedUid of invitation.grantedUids) {
        const ref = deps.db.doc(membershipPath(eventId, grantedUid));
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) {
          writeRate(tx, rateRef, rateDocument);
          return { ok: false, reason: 'cascade-conflict' };
        }
        const membership = readMembership(snapshot.data());
        if (
          !membership ||
          membership.eventId !== eventId ||
          membership.uid !== grantedUid ||
          membership.invitationId !== invitationId
        ) {
          writeRate(tx, rateRef, rateDocument);
          return { ok: false, reason: 'cascade-conflict' };
        }
        cascadeSnapshots.push({ uid: grantedUid, ref, membership });
      }
    }

    const wasRevoked = invitation.status === 'revoked';
    writeRate(tx, rateRef, rateDocument);
    if (!wasRevoked) {
      tx.update(invitationRef, {
        status: 'revoked',
        revokedAt: deps.timestamp(now),
        revokedBy: uid,
      });
    }
    if (deps.policy.revokeGrantedMemberships) {
      for (const membership of cascadeSnapshots) {
        if (membership.membership.status === 'active') {
          tx.update(membership.ref, { status: 'revoked', revokedAt: now, revokedBy: uid });
        }
      }
      const affected = new Set(cascadeSnapshots.map((membership) => membership.uid));
      const admins = event.admins.filter((adminUid) => !affected.has(adminUid));
      if (admins.length !== event.admins.length) tx.update(eventRef, { admins });
    }
    return {
      ok: true,
      eventId,
      invitationId,
      outcome: wasRevoked ? 'already-revoked' : 'revoked',
      membershipAccess:
        !deps.policy.revokeGrantedMemberships || invitation.grantedUids.length === 0
          ? 'invitation-only'
          : event.membershipEnforcement === 'enforced'
            ? 'revoked'
            : 'pending-enforcement',
    };
  });
}
