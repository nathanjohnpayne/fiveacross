import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { isEventInvitationCode, readEventInvitationCode } from '../pendingEventInvitation';

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const INVITATION_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface MintEventInvitationInput {
  eventId: string;
}

export interface RevokeEventInvitationInput {
  eventId: string;
  invitationId: string;
}

export type EventInvitationAdminFailureReason =
  | 'invalid-request'
  | 'authentication-required'
  | 'not-permitted'
  | 'rate-limited'
  | 'unavailable';

interface EventInvitationAdminFailure {
  ok: false;
  reason: EventInvitationAdminFailureReason;
}

export type MintEventInvitationResult =
  | {
      ok: true;
      eventId: string;
      invitationId: string;
      /** Complete server-built URL. The bearer is never exposed as a separate field. */
      invitationUrl: string;
      expiresAt: number;
    }
  | EventInvitationAdminFailure;

export type RevokeEventInvitationResult =
  | {
      ok: true;
      eventId: string;
      invitationId: string;
      outcome: 'revoked' | 'already-revoked';
    }
  | EventInvitationAdminFailure;

/** The only authority the browser contributes is the bearer and Event binding. */
export interface RedeemEventInvitationInput {
  code: string;
  expectedEventId: string;
}

export type RedeemEventInvitationOutcome = 'membership-created' | 'already-member';

export type RedeemEventInvitationFailureReason =
  | 'invitation-unavailable'
  | 'authentication-required'
  | 'rate-limited'
  | 'unavailable';

export type RedeemEventInvitationResult =
  | {
      ok: true;
      eventId: string;
      outcome: RedeemEventInvitationOutcome;
    }
  | {
      ok: false;
      reason: RedeemEventInvitationFailureReason;
    };

interface RedeemEventInvitationResponse {
  eventId: string;
  outcome: RedeemEventInvitationOutcome;
}

interface MintEventInvitationResponse {
  eventId: string;
  invitationId: string;
  invitationUrl: string;
  expiresAt: number;
}

interface RevokeEventInvitationResponse {
  eventId: string;
  invitationId: string;
  outcome: 'revoked' | 'already-revoked';
}

function isEventId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && EVENT_ID_PATTERN.test(value);
}

function safeErrorCode(error: unknown): string {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) return '';
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string') return '';
    return code.startsWith('functions/') ? code.slice('functions/'.length) : code;
  } catch {
    return '';
  }
}

function safeFailure(error: unknown): RedeemEventInvitationResult {
  switch (safeErrorCode(error)) {
    // The callable deliberately collapses unknown, expired, revoked,
    // cross-Event, and revoked-membership invitations into this same boundary.
    case 'permission-denied':
    case 'invalid-argument':
      return { ok: false, reason: 'invitation-unavailable' };
    case 'unauthenticated':
      return { ok: false, reason: 'authentication-required' };
    case 'resource-exhausted':
      return { ok: false, reason: 'rate-limited' };
    default:
      return { ok: false, reason: 'unavailable' };
  }
}

function safeAdminFailure(error: unknown): EventInvitationAdminFailure {
  switch (safeErrorCode(error)) {
    case 'invalid-argument':
      return { ok: false, reason: 'invalid-request' };
    case 'unauthenticated':
      return { ok: false, reason: 'authentication-required' };
    // Authorization failures and invitation existence/mismatch share this one
    // intentionally opaque callable boundary.
    case 'permission-denied':
      return { ok: false, reason: 'not-permitted' };
    case 'resource-exhausted':
      return { ok: false, reason: 'rate-limited' };
    default:
      return { ok: false, reason: 'unavailable' };
  }
}

function isSafeResponse(
  value: unknown,
  expectedEventId: string,
): value is RedeemEventInvitationResponse {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const { eventId, outcome } = value as Record<string, unknown>;
    return (
      eventId === expectedEventId &&
      (outcome === 'membership-created' || outcome === 'already-member')
    );
  } catch {
    return false;
  }
}

function isSafeInvitationUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      readEventInvitationCode(url.hash) !== null
    );
  } catch {
    return false;
  }
}

function isSafeMintResponse(
  value: unknown,
  expectedEventId: string,
): value is MintEventInvitationResponse {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const { eventId, invitationId, invitationUrl, expiresAt } = value as Record<string, unknown>;
    return (
      eventId === expectedEventId &&
      typeof invitationId === 'string' &&
      INVITATION_ID_PATTERN.test(invitationId) &&
      isSafeInvitationUrl(invitationUrl) &&
      typeof expiresAt === 'number' &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > 0
    );
  } catch {
    return false;
  }
}

function isSafeRevokeResponse(
  value: unknown,
  input: RevokeEventInvitationInput,
): value is RevokeEventInvitationResponse {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const { eventId, invitationId, outcome } = value as Record<string, unknown>;
    return (
      eventId === input.eventId &&
      invitationId === input.invitationId &&
      (outcome === 'revoked' || outcome === 'already-revoked')
    );
  } catch {
    return false;
  }
}

/** Mint a complete copy/share URL; never expose the raw bearer separately. */
export async function mintEventInvitation(
  input: MintEventInvitationInput,
): Promise<MintEventInvitationResult> {
  if (!isEventId(input.eventId)) return { ok: false, reason: 'invalid-request' };

  try {
    const callable = httpsCallable<MintEventInvitationInput, MintEventInvitationResponse>(
      functions,
      'mintEventInvitation',
    );
    const response = await callable({ eventId: input.eventId });
    if (!isSafeMintResponse(response.data, input.eventId)) {
      return { ok: false, reason: 'unavailable' };
    }
    return {
      ok: true,
      eventId: response.data.eventId,
      invitationId: response.data.invitationId,
      invitationUrl: response.data.invitationUrl,
      expiresAt: response.data.expiresAt,
    };
  } catch (error: unknown) {
    return safeAdminFailure(error);
  }
}

/**
 * Redeem without exposing server reasons, messages, details, or the bearer in
 * any result. Product code receives a closed union and never a Firebase error.
 */
export async function redeemEventInvitation(
  input: RedeemEventInvitationInput,
): Promise<RedeemEventInvitationResult> {
  if (!isEventInvitationCode(input.code) || !isEventId(input.expectedEventId)) {
    return { ok: false, reason: 'invitation-unavailable' };
  }

  try {
    const callable = httpsCallable<
      RedeemEventInvitationInput,
      RedeemEventInvitationResponse
    >(functions, 'redeemEventInvitation');
    const response = await callable({
      code: input.code,
      expectedEventId: input.expectedEventId,
    });
    if (!isSafeResponse(response.data, input.expectedEventId)) {
      return { ok: false, reason: 'unavailable' };
    }
    return {
      ok: true,
      eventId: response.data.eventId,
      outcome: response.data.outcome,
    };
  } catch (error: unknown) {
    return safeFailure(error);
  }
}

/** Revoke by opaque id; the browser cannot provide role or membership authority. */
export async function revokeEventInvitation(
  input: RevokeEventInvitationInput,
): Promise<RevokeEventInvitationResult> {
  if (!isEventId(input.eventId) || !INVITATION_ID_PATTERN.test(input.invitationId)) {
    return { ok: false, reason: 'invalid-request' };
  }

  try {
    const callable = httpsCallable<RevokeEventInvitationInput, RevokeEventInvitationResponse>(
      functions,
      'revokeEventInvitation',
    );
    const response = await callable({
      eventId: input.eventId,
      invitationId: input.invitationId,
    });
    if (!isSafeRevokeResponse(response.data, input)) {
      return { ok: false, reason: 'unavailable' };
    }
    return {
      ok: true,
      eventId: response.data.eventId,
      invitationId: response.data.invitationId,
      outcome: response.data.outcome,
    };
  } catch (error: unknown) {
    return safeAdminFailure(error);
  }
}
