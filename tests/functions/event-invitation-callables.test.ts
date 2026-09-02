import { describe, expect, it } from "vitest";
import {
  createEventInvitationCallableHandlers,
  type EventInvitationCallableLogger,
  type EventInvitationCallableOperations,
} from "../../functions/src/eventInvitationCallables";
import type {
  EventInvitationDeps,
  EventInvitationPolicy,
  InvitationFirestore,
  MintInvitationReason,
  RedeemInvitationReason,
  RevokeInvitationReason,
  RevokeInvitationResult,
} from "../../functions/src/eventInvitations";

const CODE = "I".repeat(43);
const EVENT_ID = "summer-camp-2026";
const UID = "verified-auth-user";
const PAYLOAD_UID = "payload-selected-user";
const INVITATION_ID = "a".repeat(64);
const INVITATION_URL = `https://summer-camp.fiveacross.app/#fa_invite=${CODE}`;

const TEST_POLICY = {
  ttlMs: 60_000,
  grantRole: "member",
  maxUses: 1,
  revokeGrantedMemberships: true,
  rate: {
    mint: { windowMs: 60_000, maxAttempts: 2 },
    redeem: { windowMs: 60_000, maxAttempts: 2 },
    revoke: { windowMs: 60_000, maxAttempts: 2 },
  },
} satisfies EventInvitationPolicy;

const UNUSED_DB: InvitationFirestore = {
  doc: (path) => ({ path }),
  hostnamesForEvent: (eventId) => ({ eventId }),
  runTransaction: async <T>(): Promise<T> => {
    throw new Error("The stubbed callable operation must not use Firestore.");
  },
};

const DEPS: EventInvitationDeps = {
  db: UNUSED_DB,
  now: () => 1_700_000_000_000,
  timestamp: (ms) => ({ toMillis: () => ms }),
  policy: TEST_POLICY,
};

const MINT_SUCCESS = {
  ok: true,
  eventId: EVENT_ID,
  invitationId: INVITATION_ID,
  code: CODE,
  invitationUrl: INVITATION_URL,
  expiresAt: 1_700_000_060_000,
} as const;

const REDEEM_SUCCESS = {
  ok: true,
  eventId: EVENT_ID,
  outcome: "membership-created",
} as const;

const REVOKE_SUCCESS = {
  ok: true,
  eventId: EVENT_ID,
  invitationId: INVITATION_ID,
  outcome: "revoked",
  membershipAccess: "revoked",
} as const;

function operations(
  overrides: Partial<EventInvitationCallableOperations> = {},
): EventInvitationCallableOperations {
  return {
    mint: async () => MINT_SUCCESS,
    redeem: async () => REDEEM_SUCCESS,
    revoke: async () => REVOKE_SUCCESS,
    ...overrides,
  };
}

function request(
  data: unknown,
  uid: string | null = UID,
): Parameters<
  ReturnType<typeof createEventInvitationCallableHandlers>["mint"]
>[0] {
  return {
    data,
    auth: uid === null ? undefined : { uid },
  } as unknown as Parameters<
    ReturnType<typeof createEventInvitationCallableHandlers>["mint"]
  >[0];
}

function recordingLogger(): {
  logger: EventInvitationCallableLogger;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  return {
    calls,
    logger: {
      warn: (...args) => calls.push(args),
      error: (...args) => calls.push(args),
    },
  };
}

interface PublicHttpsError extends Error {
  code: string;
  details?: unknown;
}

async function rejectionOf(work: Promise<unknown>): Promise<PublicHttpsError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("code");
    return error as PublicHttpsError;
  }
  throw new Error("Expected the callable to reject.");
}

function invokeHandler(
  handlers: ReturnType<typeof createEventInvitationCallableHandlers>,
  operation: "mint" | "redeem" | "revoke",
): Promise<unknown> {
  switch (operation) {
    case "mint":
      return handlers.mint(request({ eventId: EVENT_ID }));
    case "redeem":
      return handlers.redeem(
        request({ code: CODE, expectedEventId: EVENT_ID }),
      );
    case "revoke":
      return handlers.revoke(
        request({ eventId: EVENT_ID, invitationId: INVITATION_ID }),
      );
  }
}

describe("Event Invitation callable identity boundary", () => {
  it("derives every UID from verified auth and ignores payload-selected identity or role", async () => {
    const seen: Record<string, unknown>[] = [];
    const handlers = createEventInvitationCallableHandlers(DEPS, {
      operations: operations({
        mint: async (input) => {
          seen.push({ operation: "mint", ...input });
          return MINT_SUCCESS;
        },
        redeem: async (input) => {
          seen.push({ operation: "redeem", ...input });
          return REDEEM_SUCCESS;
        },
        revoke: async (input) => {
          seen.push({ operation: "revoke", ...input });
          return REVOKE_SUCCESS;
        },
      }),
    });
    const attackerFields = {
      uid: PAYLOAD_UID,
      role: "admin",
      grantRole: "admin",
    };

    await handlers.mint(request({ ...attackerFields, eventId: EVENT_ID }));
    await handlers.redeem(
      request({ ...attackerFields, code: CODE, expectedEventId: EVENT_ID }),
    );
    await handlers.revoke(
      request({
        ...attackerFields,
        eventId: EVENT_ID,
        invitationId: INVITATION_ID,
      }),
    );

    expect(seen).toEqual([
      { operation: "mint", uid: UID, eventId: EVENT_ID },
      {
        operation: "redeem",
        uid: UID,
        code: CODE,
        expectedEventId: EVENT_ID,
      },
      {
        operation: "revoke",
        uid: UID,
        eventId: EVENT_ID,
        invitationId: INVITATION_ID,
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain(PAYLOAD_UID);
  });

  it("does not let a payload UID stand in for missing callable auth", async () => {
    let seenUid: unknown = "not-called";
    const handlers = createEventInvitationCallableHandlers(DEPS, {
      operations: operations({
        mint: async (input) => {
          seenUid = input.uid;
          return { ok: false, reason: "unauthenticated" };
        },
      }),
    });

    const error = await rejectionOf(
      handlers.mint(request({ uid: PAYLOAD_UID, eventId: EVENT_ID }, null)),
    );

    expect(seenUid).toBeUndefined();
    expect(error.code).toBe("unauthenticated");
  });
});

describe("Event Invitation callable success responses", () => {
  it("copies exact public shapes and never returns the mint core raw code", async () => {
    const handlers = createEventInvitationCallableHandlers(DEPS, {
      operations: operations({
        mint: async () => ({ ...MINT_SUCCESS, internal: "not-public" }),
        redeem: async () => ({ ...REDEEM_SUCCESS, internal: "not-public" }),
        revoke: async () => ({ ...REVOKE_SUCCESS, internal: "not-public" }),
      }),
    });

    await expect(
      handlers.mint(request({ eventId: EVENT_ID })),
    ).resolves.toEqual({
      eventId: EVENT_ID,
      invitationId: INVITATION_ID,
      invitationUrl: INVITATION_URL,
      expiresAt: 1_700_000_060_000,
    });
    await expect(
      handlers.redeem(request({ code: CODE, expectedEventId: EVENT_ID })),
    ).resolves.toEqual({
      eventId: EVENT_ID,
      outcome: "membership-created",
    });
    await expect(
      handlers.revoke(
        request({ eventId: EVENT_ID, invitationId: INVITATION_ID }),
      ),
    ).resolves.toEqual({
      eventId: EVENT_ID,
      invitationId: INVITATION_ID,
      outcome: "revoked",
      membershipAccess: "revoked",
    });

    expect(
      await handlers.mint(request({ eventId: EVENT_ID })),
    ).not.toHaveProperty("code");
  });

  it.each(["invitation-only", "pending-enforcement", "revoked"] as const)(
    "copies the closed revoke membershipAccess value %s",
    async (membershipAccess) => {
      const handlers = createEventInvitationCallableHandlers(DEPS, {
        operations: operations({
          revoke: async () => ({ ...REVOKE_SUCCESS, membershipAccess }),
        }),
      });

      await expect(
        handlers.revoke(
          request({ eventId: EVENT_ID, invitationId: INVITATION_ID }),
        ),
      ).resolves.toMatchObject({ membershipAccess });
    },
  );

  it("fails closed when the core returns an unknown membershipAccess value", async () => {
    const unsafe = {
      ...REVOKE_SUCCESS,
      membershipAccess: "membership-still-active",
    } as unknown as RevokeInvitationResult;
    const handlers = createEventInvitationCallableHandlers(DEPS, {
      operations: operations({ revoke: async () => unsafe }),
    });

    const error = await rejectionOf(
      handlers.revoke(
        request({ eventId: EVENT_ID, invitationId: INVITATION_ID }),
      ),
    );

    expect(error.code).toBe("internal");
    expect(error.message).toBe(
      "The invitation service is unavailable. Try again.",
    );
  });

  it.each(["mint", "redeem", "revoke"] as const)(
    "sanitizes an undefined %s operation result",
    async (operation) => {
      const malformed = async (): Promise<never> => undefined as never;
      const operationSets: Record<
        typeof operation,
        EventInvitationCallableOperations
      > = {
        mint: operations({ mint: malformed }),
        redeem: operations({ redeem: malformed }),
        revoke: operations({ revoke: malformed }),
      };
      const { logger, calls } = recordingLogger();
      const handlers = createEventInvitationCallableHandlers(DEPS, {
        logger,
        operations: operationSets[operation],
      });

      const error = await rejectionOf(invokeHandler(handlers, operation));

      expect({ code: error.code, message: error.message }).toEqual({
        code: "internal",
        message: "The invitation service is unavailable. Try again.",
      });
      expect(calls).toEqual([
        ["Event invitation request failed.", { operation }],
      ]);
    },
  );

  it.each(["mint", "redeem", "revoke"] as const)(
    "sanitizes a malformed %s operation envelope",
    async (operation) => {
      const operationSets: Record<
        typeof operation,
        EventInvitationCallableOperations
      > = {
        mint: operations({ mint: async () => ({ ok: true }) as never }),
        redeem: operations({
          redeem: async () =>
            ({
              ok: true,
              eventId: EVENT_ID,
              outcome: "future-outcome",
            }) as never,
        }),
        revoke: operations({
          revoke: async () => ({ ok: false, reason: "future-reason" }) as never,
        }),
      };
      const { logger, calls } = recordingLogger();
      const handlers = createEventInvitationCallableHandlers(DEPS, {
        logger,
        operations: operationSets[operation],
      });

      const error = await rejectionOf(invokeHandler(handlers, operation));

      expect({ code: error.code, message: error.message }).toEqual({
        code: "internal",
        message: "The invitation service is unavailable. Try again.",
      });
      expect(calls).toEqual([
        ["Event invitation request failed.", { operation }],
      ]);
    },
  );
});

describe("Event Invitation callable public error mapping", () => {
  const mintCases: ReadonlyArray<
    readonly [MintInvitationReason, string, string]
  > = [
    [
      "unauthenticated",
      "unauthenticated",
      "Sign in before using Event invitations.",
    ],
    [
      "invalid-event-id",
      "invalid-argument",
      "The invitation request is invalid.",
    ],
    [
      "invalid-policy",
      "internal",
      "The invitation service is unavailable. Try again.",
    ],
    [
      "rate-limited",
      "resource-exhausted",
      "Too many invitation attempts. Try again later.",
    ],
    [
      "event-unavailable",
      "permission-denied",
      "This invitation cannot be created.",
    ],
    [
      "not-authorized",
      "permission-denied",
      "This invitation cannot be created.",
    ],
    [
      "canonical-host-unavailable",
      "permission-denied",
      "This invitation cannot be created.",
    ],
    [
      "invalid-generated-code",
      "internal",
      "The invitation service is unavailable. Try again.",
    ],
    [
      "code-collision",
      "internal",
      "The invitation service is unavailable. Try again.",
    ],
  ];

  it.each(mintCases)(
    "maps mint %s to safe %s",
    async (reason, code, message) => {
      const handlers = createEventInvitationCallableHandlers(DEPS, {
        operations: operations({ mint: async () => ({ ok: false, reason }) }),
      });
      const error = await rejectionOf(
        handlers.mint(request({ eventId: EVENT_ID })),
      );

      expect({
        code: error.code,
        message: error.message,
        details: error.details,
      }).toEqual({
        code,
        message,
        details: undefined,
      });
    },
  );

  const redeemCases: ReadonlyArray<
    readonly [RedeemInvitationReason, string, string]
  > = [
    [
      "unauthenticated",
      "unauthenticated",
      "Sign in before using Event invitations.",
    ],
    ["invalid-code", "invalid-argument", "The invitation request is invalid."],
    [
      "invalid-event-id",
      "invalid-argument",
      "The invitation request is invalid.",
    ],
    [
      "invalid-policy",
      "internal",
      "The invitation service is unavailable. Try again.",
    ],
    [
      "rate-limited",
      "resource-exhausted",
      "Too many invitation attempts. Try again later.",
    ],
    [
      "unknown-invitation",
      "permission-denied",
      "This invitation is no longer valid. Ask the organizer for a new one.",
    ],
    [
      "invalid-invitation",
      "permission-denied",
      "This invitation is no longer valid. Ask the organizer for a new one.",
    ],
    [
      "event-mismatch",
      "permission-denied",
      "This invitation is no longer valid. Ask the organizer for a new one.",
    ],
    [
      "event-unavailable",
      "permission-denied",
      "This invitation is no longer valid. Ask the organizer for a new one.",
    ],
    [
      "invitation-unavailable",
      "permission-denied",
      "This invitation is no longer valid. Ask the organizer for a new one.",
    ],
    [
      "membership-revoked",
      "permission-denied",
      "This invitation is no longer valid. Ask the organizer for a new one.",
    ],
    [
      "membership-unreadable",
      "permission-denied",
      "This invitation is no longer valid. Ask the organizer for a new one.",
    ],
  ];

  it.each(redeemCases)(
    "maps redeem %s to safe %s",
    async (reason, code, message) => {
      const handlers = createEventInvitationCallableHandlers(DEPS, {
        operations: operations({ redeem: async () => ({ ok: false, reason }) }),
      });
      const error = await rejectionOf(
        handlers.redeem(request({ code: CODE, expectedEventId: EVENT_ID })),
      );

      expect({
        code: error.code,
        message: error.message,
        details: error.details,
      }).toEqual({
        code,
        message,
        details: undefined,
      });
    },
  );

  it("makes every redemption lifecycle failure byte-identical", async () => {
    const reasons: RedeemInvitationReason[] = [
      "unknown-invitation",
      "invalid-invitation",
      "event-mismatch",
      "event-unavailable",
      "invitation-unavailable",
      "membership-revoked",
      "membership-unreadable",
    ];
    const publicFailures: string[] = [];

    for (const reason of reasons) {
      const handlers = createEventInvitationCallableHandlers(DEPS, {
        operations: operations({ redeem: async () => ({ ok: false, reason }) }),
      });
      const error = await rejectionOf(
        handlers.redeem(request({ code: CODE, expectedEventId: EVENT_ID })),
      );
      publicFailures.push(
        `${error.code}\0${error.message}\0${String(error.details)}`,
      );
    }

    expect(new Set(publicFailures)).toEqual(
      new Set([
        "permission-denied\0This invitation is no longer valid. Ask the organizer for a new one.\0undefined",
      ]),
    );
  });

  const revokeCases: ReadonlyArray<
    readonly [RevokeInvitationReason, string, string]
  > = [
    [
      "unauthenticated",
      "unauthenticated",
      "Sign in before using Event invitations.",
    ],
    [
      "invalid-event-id",
      "invalid-argument",
      "The invitation request is invalid.",
    ],
    [
      "invalid-invitation-id",
      "invalid-argument",
      "The invitation request is invalid.",
    ],
    [
      "invalid-policy",
      "internal",
      "The invitation service is unavailable. Try again.",
    ],
    [
      "rate-limited",
      "resource-exhausted",
      "Too many invitation attempts. Try again later.",
    ],
    [
      "event-unavailable",
      "permission-denied",
      "This invitation cannot be revoked.",
    ],
    [
      "not-authorized",
      "permission-denied",
      "This invitation cannot be revoked.",
    ],
    [
      "unknown-invitation",
      "permission-denied",
      "This invitation cannot be revoked.",
    ],
    [
      "invalid-invitation",
      "permission-denied",
      "This invitation cannot be revoked.",
    ],
    [
      "event-mismatch",
      "permission-denied",
      "This invitation cannot be revoked.",
    ],
    [
      "cascade-conflict",
      "permission-denied",
      "This invitation cannot be revoked.",
    ],
  ];

  it.each(revokeCases)(
    "maps revoke %s to safe %s",
    async (reason, code, message) => {
      const handlers = createEventInvitationCallableHandlers(DEPS, {
        operations: operations({ revoke: async () => ({ ok: false, reason }) }),
      });
      const error = await rejectionOf(
        handlers.revoke(
          request({ eventId: EVENT_ID, invitationId: INVITATION_ID }),
        ),
      );

      expect({
        code: error.code,
        message: error.message,
        details: error.details,
      }).toEqual({
        code,
        message,
        details: undefined,
      });
    },
  );
});

describe("Event Invitation callable secret handling", () => {
  it("does not return or log a bearer-bearing unexpected error", async () => {
    const { logger, calls } = recordingLogger();
    const sensitive = [CODE, INVITATION_URL, UID, EVENT_ID, INVITATION_ID];
    const thrown = Object.assign(new Error(sensitive.join(" :: ")), {
      details: { code: CODE, invitationUrl: INVITATION_URL },
    });
    const handlers = createEventInvitationCallableHandlers(DEPS, {
      logger,
      operations: operations({
        redeem: async () => {
          throw thrown;
        },
      }),
    });

    const error = await rejectionOf(
      handlers.redeem(request({ code: CODE, expectedEventId: EVENT_ID })),
    );
    const publicText = `${error.code} ${error.message} ${String(error.details)}`;
    const logText = JSON.stringify(calls);

    expect(error.code).toBe("internal");
    expect(error.message).toBe(
      "The invitation service is unavailable. Try again.",
    );
    expect(calls).toEqual([
      ["Event invitation request failed.", { operation: "redeem" }],
    ]);
    for (const value of sensitive) {
      expect(publicText).not.toContain(value);
      expect(logText).not.toContain(value);
    }
  });
});
