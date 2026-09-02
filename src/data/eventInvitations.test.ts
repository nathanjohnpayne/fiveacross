import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ httpsCallable: vi.fn() }));
vi.mock('firebase/functions', () => ({ httpsCallable: mocks.httpsCallable }));
vi.mock('../firebase', () => ({ functions: {} }));

import {
  mintEventInvitation,
  redeemEventInvitation,
  revokeEventInvitation,
} from './eventInvitations';

const CODE = 'I'.repeat(43);
const EVENT_ID = 'summer-camp-2026';
const INVITATION_ID = 'a'.repeat(64);
const INVITATION_URL = `https://summer-camp.fiveacross.app/#fa_invite=${CODE}`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('redeemEventInvitation', () => {
  it.each(['membership-created', 'already-member'] as const)(
    'returns the safe public success outcome %s',
    async (outcome) => {
      const redeem = vi.fn().mockResolvedValue({ data: { eventId: EVENT_ID, outcome } });
      mocks.httpsCallable.mockReturnValue(redeem);

      await expect(redeemEventInvitation({ code: CODE, expectedEventId: EVENT_ID })).resolves.toEqual(
        { ok: true, eventId: EVENT_ID, outcome },
      );
      expect(redeem).toHaveBeenCalledWith({ code: CODE, expectedEventId: EVENT_ID });
    },
  );

  it('sends no client-selected role or identity authority', async () => {
    const redeem = vi.fn().mockResolvedValue({
      data: { eventId: EVENT_ID, outcome: 'membership-created' },
    });
    mocks.httpsCallable.mockReturnValue(redeem);

    await redeemEventInvitation({ code: CODE, expectedEventId: EVENT_ID });

    expect(mocks.httpsCallable).toHaveBeenCalledWith({}, 'redeemEventInvitation');
    expect(redeem).toHaveBeenCalledWith({ code: CODE, expectedEventId: EVENT_ID });
  });

  it.each([
    ['functions/permission-denied', 'invitation-unavailable'],
    ['functions/invalid-argument', 'invitation-unavailable'],
    ['functions/unauthenticated', 'authentication-required'],
    ['functions/failed-precondition', 'unavailable'],
    ['functions/resource-exhausted', 'rate-limited'],
    ['functions/unavailable', 'unavailable'],
    ['unknown-code', 'unavailable'],
  ] as const)('maps %s to %s without exposing server detail', async (code, reason) => {
    const redeem = vi.fn().mockRejectedValue({
      code,
      message: `server detail containing ${CODE}`,
      details: { invitation: CODE, internalReason: 'revoked-membership' },
    });
    mocks.httpsCallable.mockReturnValue(redeem);

    const result = await redeemEventInvitation({ code: CODE, expectedEventId: EVENT_ID });

    expect(result).toEqual({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(JSON.stringify(result)).not.toContain('revoked-membership');
  });

  it('fails closed on a malformed or cross-Event success response', async () => {
    const redeem = vi.fn().mockResolvedValue({
      data: { eventId: 'different-event', outcome: 'membership-created', secret: CODE },
    });
    mocks.httpsCallable.mockReturnValue(redeem);

    await expect(
      redeemEventInvitation({ code: CODE, expectedEventId: EVENT_ID }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('does not send malformed local input', async () => {
    const redeem = vi.fn();
    mocks.httpsCallable.mockReturnValue(redeem);

    await expect(
      redeemEventInvitation({ code: 'short', expectedEventId: EVENT_ID }),
    ).resolves.toEqual({ ok: false, reason: 'invitation-unavailable' });
    expect(redeem).not.toHaveBeenCalled();
  });

  it('has no telemetry, console, or URL dependency that could export the bearer value', () => {
    const source = readFileSync('src/data/eventInvitations.ts', 'utf8');
    expect(source).not.toMatch(/(?:analytics|posthog|console\.|window\.location|document\.)/i);
  });
});

describe('mintEventInvitation', () => {
  it('returns only the complete server-built URL, id, and expiry', async () => {
    const mint = vi.fn().mockResolvedValue({
      data: {
        eventId: EVENT_ID,
        invitationId: INVITATION_ID,
        invitationUrl: INVITATION_URL,
        expiresAt: 1_700_000_060_000,
        // Even a drifted server response cannot add the raw bearer to the
        // wrapper's closed output shape.
        code: CODE,
      },
    });
    mocks.httpsCallable.mockReturnValue(mint);

    const result = await mintEventInvitation({ eventId: EVENT_ID });

    expect(result).toEqual({
      ok: true,
      eventId: EVENT_ID,
      invitationId: INVITATION_ID,
      invitationUrl: INVITATION_URL,
      expiresAt: 1_700_000_060_000,
    });
    expect(result).not.toHaveProperty('code');
    expect(mocks.httpsCallable).toHaveBeenCalledWith({}, 'mintEventInvitation');
    expect(mint).toHaveBeenCalledWith({ eventId: EVENT_ID });
  });

  it.each([
    ['functions/invalid-argument', 'invalid-request'],
    ['functions/unauthenticated', 'authentication-required'],
    ['functions/permission-denied', 'not-permitted'],
    ['functions/resource-exhausted', 'rate-limited'],
    ['functions/failed-precondition', 'unavailable'],
    ['functions/internal', 'unavailable'],
  ] as const)('sanitizes %s as %s', async (code, reason) => {
    mocks.httpsCallable.mockReturnValue(
      vi.fn().mockRejectedValue({ code, message: INVITATION_URL, details: { rawCode: CODE } }),
    );

    const result = await mintEventInvitation({ eventId: EVENT_ID });

    expect(result).toEqual({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it.each([
    ['query credential', `https://summer-camp.fiveacross.app/?fa_invite=${CODE}#fa_invite=${CODE}`],
    ['unrelated query', `https://summer-camp.fiveacross.app/?source=admin#fa_invite=${CODE}`],
    ['non-root path', `https://summer-camp.fiveacross.app/join#fa_invite=${CODE}`],
    ['normalised dot path', `https://summer-camp.fiveacross.app/./#fa_invite=${CODE}`],
    ['username', `https://admin@summer-camp.fiveacross.app/#fa_invite=${CODE}`],
    ['password', `https://admin:secret@summer-camp.fiveacross.app/#fa_invite=${CODE}`],
    ['non-default port', `https://summer-camp.fiveacross.app:8443/#fa_invite=${CODE}`],
    // `URL.port` is empty after WHATWG normalises the default port. This case
    // proves validation is anchored to the raw response too, not parsed fields.
    ['explicit default port', `https://summer-camp.fiveacross.app:443/#fa_invite=${CODE}`],
    ['duplicate invitation key', `${INVITATION_URL}&fa_invite=${CODE}`],
    ['second fragment field', `${INVITATION_URL}&source=admin`],
    ['bearer copied into another fragment field', `${INVITATION_URL}&copy=${CODE}`],
    ['bearer copied into hostname', `https://${CODE}.example/#fa_invite=${CODE}`],
    ['non-canonical fragment encoding', `https://summer-camp.fiveacross.app/#fa_invite=${CODE}%20`],
    ['not a fragment', `https://summer-camp.fiveacross.app/?fa_invite=${CODE}`],
  ])('fails closed when the minted URL has %s', async (_description, invitationUrl) => {
    mocks.httpsCallable.mockReturnValue(
      vi.fn().mockResolvedValue({
        data: {
          eventId: EVENT_ID,
          invitationId: INVITATION_ID,
          invitationUrl,
          expiresAt: 1_700_000_060_000,
        },
      }),
    );

    await expect(mintEventInvitation({ eventId: EVENT_ID })).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

describe('revokeEventInvitation', () => {
  it.each(['revoked', 'already-revoked'] as const)(
    'returns the closed %s outcome',
    async (outcome) => {
      const revoke = vi.fn().mockResolvedValue({
        data: {
          eventId: EVENT_ID,
          invitationId: INVITATION_ID,
          outcome,
          membershipAccess: 'revoked',
        },
      });
      mocks.httpsCallable.mockReturnValue(revoke);

      await expect(
        revokeEventInvitation({
          eventId: EVENT_ID,
          invitationId: INVITATION_ID,
        }),
      ).resolves.toEqual({
        ok: true,
        eventId: EVENT_ID,
        invitationId: INVITATION_ID,
        outcome,
        membershipAccess: 'revoked',
      });
      expect(mocks.httpsCallable).toHaveBeenCalledWith({}, 'revokeEventInvitation');
      expect(revoke).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        invitationId: INVITATION_ID,
      });
    },
  );

  it.each(['invitation-only', 'pending-enforcement', 'revoked'] as const)(
    'preserves the closed membership access state %s',
    async (membershipAccess) => {
      mocks.httpsCallable.mockReturnValue(
        vi.fn().mockResolvedValue({
          data: {
            eventId: EVENT_ID,
            invitationId: INVITATION_ID,
            outcome: 'revoked',
            membershipAccess,
          },
        }),
      );

      await expect(
        revokeEventInvitation({
          eventId: EVENT_ID,
          invitationId: INVITATION_ID,
        }),
      ).resolves.toMatchObject({ ok: true, membershipAccess });
    },
  );

  it.each([undefined, null, 'membership-still-active', true])(
    'fails closed on membership access value %j',
    async (membershipAccess) => {
      mocks.httpsCallable.mockReturnValue(
        vi.fn().mockResolvedValue({
          data: {
            eventId: EVENT_ID,
            invitationId: INVITATION_ID,
            outcome: 'revoked',
            membershipAccess,
          },
        }),
      );

      await expect(
        revokeEventInvitation({
          eventId: EVENT_ID,
          invitationId: INVITATION_ID,
        }),
      ).resolves.toEqual({ ok: false, reason: 'unavailable' });
    },
  );

  it('collapses authorization and invitation-existence failures into one public result', async () => {
    mocks.httpsCallable.mockReturnValue(
      vi.fn().mockRejectedValue({
        code: 'functions/permission-denied',
        message: `unknown invitation ${INVITATION_ID}`,
        details: { internalReason: 'event-mismatch' },
      }),
    );

    const result = await revokeEventInvitation({
      eventId: EVENT_ID,
      invitationId: INVITATION_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'not-permitted' });
    expect(JSON.stringify(result)).not.toContain(INVITATION_ID);
    expect(JSON.stringify(result)).not.toContain('event-mismatch');
  });

  it('does not send a malformed invitation id', async () => {
    const revoke = vi.fn();
    mocks.httpsCallable.mockReturnValue(revoke);

    await expect(
      revokeEventInvitation({ eventId: EVENT_ID, invitationId: 'short' }),
    ).resolves.toEqual({ ok: false, reason: 'invalid-request' });
    expect(revoke).not.toHaveBeenCalled();
  });
});
