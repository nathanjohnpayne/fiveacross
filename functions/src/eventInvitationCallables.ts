/**
 * Decision-neutral callable boundary for Event Invitations (#803).
 *
 * Production policy and Firebase runtime objects stay injected. This module
 * only translates the verified callable identity and untrusted payload into
 * the pure decision layer, then narrows its results to the public wire shapes.
 */
import {
  HttpsError,
  type CallableRequest,
  type FunctionsErrorCode,
} from "firebase-functions/v2/https";
import {
  EVENT_INVITATION_EVENT_ID_PATTERN,
  EVENT_INVITATION_FRAGMENT_KEY,
  EVENT_INVITATION_ID_PATTERN,
  EVENT_INVITATION_MAX_EVENT_ID_LENGTH,
  EVENT_INVITATION_TOKEN_PATTERN,
  invitationIdForCode,
  mintEventInvitation,
  redeemEventInvitation,
  revokeEventInvitation,
  type EventInvitationDeps,
  type MintInvitationReason,
  type RedeemInvitationReason,
  type RevokeInvitationReason,
} from "./eventInvitations";

export type EventInvitationCallableOperation = "mint" | "redeem" | "revoke";

export interface MintEventInvitationCallableResponse {
  eventId: string;
  invitationId: string;
  invitationUrl: string;
  expiresAt: number;
}

export interface RedeemEventInvitationCallableResponse {
  eventId: string;
  outcome: "membership-created" | "already-member";
}

export interface RevokeEventInvitationCallableResponse {
  eventId: string;
  invitationId: string;
  outcome: "revoked" | "already-revoked";
  membershipAccess: "invitation-only" | "pending-enforcement" | "revoked";
}

export interface EventInvitationCallableHandlers {
  mint(
    request: CallableRequest<unknown>,
  ): Promise<MintEventInvitationCallableResponse>;
  redeem(
    request: CallableRequest<unknown>,
  ): Promise<RedeemEventInvitationCallableResponse>;
  revoke(
    request: CallableRequest<unknown>,
  ): Promise<RevokeEventInvitationCallableResponse>;
}

export interface EventInvitationCallableLogger {
  warn(
    message: string,
    context: Readonly<{
      operation: EventInvitationCallableOperation;
      reason:
        MintInvitationReason | RedeemInvitationReason | RevokeInvitationReason;
    }>,
  ): void;
  error(
    message: string,
    context: Readonly<{ operation: EventInvitationCallableOperation }>,
  ): void;
}

export interface EventInvitationCallableOperations {
  mint: typeof mintEventInvitation;
  redeem: typeof redeemEventInvitation;
  revoke: typeof revokeEventInvitation;
}

export interface EventInvitationCallableOptions {
  /** Tests may replace the pure operations without replacing the public seam. */
  operations?: EventInvitationCallableOperations;
  logger?: EventInvitationCallableLogger;
}

interface PublicFailure {
  code: FunctionsErrorCode;
  message: string;
}

class PublicFailureSignal {
  constructor(readonly failure: PublicFailure) {}
}

const AUTHENTICATION_REQUIRED: PublicFailure = {
  code: "unauthenticated",
  message: "Sign in before using Event invitations.",
};
const INVALID_REQUEST: PublicFailure = {
  code: "invalid-argument",
  message: "The invitation request is invalid.",
};
const RATE_LIMITED: PublicFailure = {
  code: "resource-exhausted",
  message: "Too many invitation attempts. Try again later.",
};
const INTERNAL_FAILURE: PublicFailure = {
  code: "internal",
  message: "The invitation service is unavailable. Try again.",
};
const MINT_DENIED: PublicFailure = {
  code: "permission-denied",
  message: "This invitation cannot be created.",
};
const REVOKE_DENIED: PublicFailure = {
  code: "permission-denied",
  message: "This invitation cannot be revoked.",
};
const REDEMPTION_TERMINAL: PublicFailure = {
  code: "permission-denied",
  message:
    "This invitation is no longer valid. Ask the organizer for a new one.",
};

const MINT_FAILURES = {
  unauthenticated: AUTHENTICATION_REQUIRED,
  "invalid-event-id": INVALID_REQUEST,
  "invalid-policy": INTERNAL_FAILURE,
  "rate-limited": RATE_LIMITED,
  "event-unavailable": MINT_DENIED,
  "not-authorized": MINT_DENIED,
  "canonical-host-unavailable": MINT_DENIED,
  "invalid-generated-code": INTERNAL_FAILURE,
  "code-collision": INTERNAL_FAILURE,
} satisfies Record<MintInvitationReason, PublicFailure>;

const REDEEM_FAILURES = {
  unauthenticated: AUTHENTICATION_REQUIRED,
  "invalid-code": INVALID_REQUEST,
  "invalid-event-id": INVALID_REQUEST,
  "invalid-policy": INTERNAL_FAILURE,
  "rate-limited": RATE_LIMITED,
  "unknown-invitation": REDEMPTION_TERMINAL,
  "invalid-invitation": REDEMPTION_TERMINAL,
  "event-mismatch": REDEMPTION_TERMINAL,
  "event-unavailable": REDEMPTION_TERMINAL,
  "invitation-unavailable": REDEMPTION_TERMINAL,
  "membership-revoked": REDEMPTION_TERMINAL,
  "membership-unreadable": REDEMPTION_TERMINAL,
} satisfies Record<RedeemInvitationReason, PublicFailure>;

const REVOKE_FAILURES = {
  unauthenticated: AUTHENTICATION_REQUIRED,
  "invalid-event-id": INVALID_REQUEST,
  "invalid-invitation-id": INVALID_REQUEST,
  "invalid-policy": INTERNAL_FAILURE,
  "rate-limited": RATE_LIMITED,
  "event-unavailable": REVOKE_DENIED,
  "not-authorized": REVOKE_DENIED,
  "unknown-invitation": REVOKE_DENIED,
  "invalid-invitation": REVOKE_DENIED,
  "event-mismatch": REVOKE_DENIED,
  "cascade-conflict": REVOKE_DENIED,
} satisfies Record<RevokeInvitationReason, PublicFailure>;

const DEFAULT_OPERATIONS: EventInvitationCallableOperations = {
  mint: mintEventInvitation,
  redeem: redeemEventInvitation,
  revoke: revokeEventInvitation,
};

const INVITATION_FRAGMENT_PREFIX = `#${EVENT_INVITATION_FRAGMENT_KEY}=`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isEventId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= EVENT_INVITATION_MAX_EVENT_ID_LENGTH &&
    EVENT_INVITATION_EVENT_ID_PATTERN.test(value)
  );
}

function isInvitationId(value: unknown): value is string {
  return typeof value === "string" && EVENT_INVITATION_ID_PATTERN.test(value);
}

function invitationCodeFromUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const safeEnvelope =
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash.startsWith(INVITATION_FRAGMENT_PREFIX);
    if (!safeEnvelope) return null;
    const code = url.hash.slice(INVITATION_FRAGMENT_PREFIX.length);
    return EVENT_INVITATION_TOKEN_PATTERN.test(code) ? code : null;
  } catch {
    return null;
  }
}

function isPositiveEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isMappedReason<Reason extends string>(
  failures: Readonly<Record<Reason, PublicFailure>>,
  value: unknown,
): value is Reason {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(failures, value)
  );
}

function payloadOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function publicError(failure: PublicFailure): HttpsError {
  return new HttpsError(failure.code, failure.message);
}

function rejectWith(failure: PublicFailure): never {
  throw new PublicFailureSignal(failure);
}

function isMembershipAccess(
  value: unknown,
): value is RevokeEventInvitationCallableResponse["membershipAccess"] {
  return (
    value === "invitation-only" ||
    value === "pending-enforcement" ||
    value === "revoked"
  );
}

function safelyLogRejected(
  logger: EventInvitationCallableLogger,
  operation: EventInvitationCallableOperation,
  reason:
    MintInvitationReason | RedeemInvitationReason | RevokeInvitationReason,
): void {
  try {
    logger.warn("Event invitation request rejected.", { operation, reason });
  } catch {
    // Logging must never change the callable's closed public outcome.
  }
}

function safelyLogUnexpected(
  logger: EventInvitationCallableLogger,
  operation: EventInvitationCallableOperation,
): void {
  try {
    // Deliberately omit the thrown value: an SDK/adapter failure can include a
    // bearer or path in its message, stack, or structured details.
    logger.error("Event invitation request failed.", { operation });
  } catch {
    // Logging must never replace the intentionally generic public error.
  }
}

async function invokeCore<T>(
  logger: EventInvitationCallableLogger,
  operation: EventInvitationCallableOperation,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PublicFailureSignal) {
      throw publicError(error.failure);
    }
    safelyLogUnexpected(logger, operation);
    throw publicError(INTERNAL_FAILURE);
  }
}

/**
 * Build all three callable handlers from explicit server-owned dependencies.
 * No policy default exists here; `deps.policy` must be supplied by the caller.
 */
export function createEventInvitationCallableHandlers(
  deps: EventInvitationDeps,
  options: EventInvitationCallableOptions = {},
): EventInvitationCallableHandlers {
  const operations = options.operations ?? DEFAULT_OPERATIONS;
  const logger = options.logger ?? console;

  return {
    mint: (request) =>
      invokeCore(logger, "mint", async () => {
        const payload = payloadOf(request.data);
        const result: unknown = await operations.mint(
          {
            uid: request.auth?.uid,
            eventId: payload.eventId,
          },
          deps,
        );
        if (!isRecord(result) || typeof result.ok !== "boolean") {
          throw new Error("Malformed mint result.");
        }
        if (result.ok === false) {
          if (!isMappedReason(MINT_FAILURES, result.reason)) {
            throw new Error("Malformed mint failure.");
          }
          safelyLogRejected(logger, "mint", result.reason);
          rejectWith(MINT_FAILURES[result.reason]);
        }
        if (
          !isEventId(result.eventId) ||
          result.eventId !== payload.eventId ||
          !isInvitationId(result.invitationId) ||
          typeof result.code !== "string" ||
          !EVENT_INVITATION_TOKEN_PATTERN.test(result.code) ||
          typeof result.invitationUrl !== "string" ||
          invitationCodeFromUrl(result.invitationUrl) !== result.code ||
          invitationIdForCode(result.code) !== result.invitationId ||
          !isPositiveEpoch(result.expiresAt)
        ) {
          throw new Error("Malformed mint success.");
        }
        // Copy an exact wire shape. In particular, the raw `code` returned by
        // the decision layer is never exposed separately from the URL.
        return {
          eventId: result.eventId,
          invitationId: result.invitationId,
          invitationUrl: result.invitationUrl,
          expiresAt: result.expiresAt,
        };
      }),

    redeem: (request) =>
      invokeCore(logger, "redeem", async () => {
        const payload = payloadOf(request.data);
        const result: unknown = await operations.redeem(
          {
            uid: request.auth?.uid,
            code: payload.code,
            expectedEventId: payload.expectedEventId,
          },
          deps,
        );
        if (!isRecord(result) || typeof result.ok !== "boolean") {
          throw new Error("Malformed redeem result.");
        }
        if (result.ok === false) {
          if (!isMappedReason(REDEEM_FAILURES, result.reason)) {
            throw new Error("Malformed redeem failure.");
          }
          safelyLogRejected(logger, "redeem", result.reason);
          rejectWith(REDEEM_FAILURES[result.reason]);
        }
        if (
          !isEventId(result.eventId) ||
          result.eventId !== payload.expectedEventId ||
          (result.outcome !== "membership-created" &&
            result.outcome !== "already-member")
        ) {
          throw new Error("Malformed redeem success.");
        }
        return { eventId: result.eventId, outcome: result.outcome };
      }),

    revoke: (request) =>
      invokeCore(logger, "revoke", async () => {
        const payload = payloadOf(request.data);
        const result: unknown = await operations.revoke(
          {
            uid: request.auth?.uid,
            eventId: payload.eventId,
            invitationId: payload.invitationId,
          },
          deps,
        );
        if (!isRecord(result) || typeof result.ok !== "boolean") {
          throw new Error("Malformed revoke result.");
        }
        if (result.ok === false) {
          if (!isMappedReason(REVOKE_FAILURES, result.reason)) {
            throw new Error("Malformed revoke failure.");
          }
          safelyLogRejected(logger, "revoke", result.reason);
          rejectWith(REVOKE_FAILURES[result.reason]);
        }
        if (
          !isEventId(result.eventId) ||
          result.eventId !== payload.eventId ||
          !isInvitationId(result.invitationId) ||
          result.invitationId !== payload.invitationId ||
          (result.outcome !== "revoked" &&
            result.outcome !== "already-revoked") ||
          !isMembershipAccess(result.membershipAccess)
        ) {
          throw new Error("Malformed revoke success.");
        }
        return {
          eventId: result.eventId,
          invitationId: result.invitationId,
          outcome: result.outcome,
          membershipAccess: result.membershipAccess,
        };
      }),
  };
}
