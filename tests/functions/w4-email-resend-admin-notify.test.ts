import { describe, it, expect, vi } from 'vitest';
import { sendEmail, type EmailPayload } from '../../functions/src/email';
import { shouldNotify, resolveAdminEmails, notifyAdminsOfModeration } from '../../functions/src/notify';

// Exercises the pure/injectable seams of the moderation-notify pipeline (#101).
// The Resend transport, Admin-SDK roster/email lookups, and config params are
// substituted via `deps`/`sender`, so no live Resend key, Firestore, or Auth.

describe('shouldNotify', () => {
  it('fires only on a status change INTO a moderation state', () => {
    expect(shouldNotify({ status: 'active' }, { status: 'flagged' })).toBe(true);
    expect(shouldNotify({ status: 'active' }, { status: 'hidden' })).toBe(true);
  });

  it('is false when status is unchanged or the transition is non-moderation', () => {
    expect(shouldNotify({ status: 'active', reportCount: 1 }, { status: 'active', reportCount: 2 })).toBe(false); // report bump
    expect(shouldNotify({ status: 'pending' }, { status: 'active' })).toBe(false); // claim confirm
    expect(shouldNotify({ status: 'hidden' }, { status: 'active' })).toBe(false); // restore
    expect(shouldNotify({ status: 'flagged' }, { status: 'flagged' })).toBe(false); // same status re-write
  });

  it('handles create and delete (onDocumentWritten source)', () => {
    expect(shouldNotify(undefined, { status: 'flagged' })).toBe(true); // create-flagged (upload-before-doc race)
    expect(shouldNotify(undefined, { status: 'hidden' })).toBe(true); // create-hidden
    expect(shouldNotify(undefined, { status: 'active' })).toBe(false); // normal create — no notify
    expect(shouldNotify({ status: 'flagged' }, undefined)).toBe(false); // delete — no notify
  });
});

describe('resolveAdminEmails', () => {
  it('maps admin UIDs to verified emails, de-dupes, and unions ADMIN_NOTIFY_EMAIL', async () => {
    const roster: Record<string, string | null> = {
      u1: 'admin1@example.com',
      u2: 'admin2@example.com',
      u3: null, // no verified email — dropped
      u4: 'admin1@example.com', // duplicate — collapsed
    };
    const emails = await resolveAdminEmails('med-2026', {
      getAdminUids: async () => ['u1', 'u2', 'u3', 'u4'],
      getEmailForUid: async (uid) => roster[uid] ?? null,
      adminNotifyEmail: 'shared@example.com, admin1@example.com',
    });
    expect(emails).toEqual(['admin1@example.com', 'admin2@example.com', 'shared@example.com']);
  });

  it('returns [] (never throws) when the roster resolves to nothing', async () => {
    const emails = await resolveAdminEmails('med-2026', {
      getAdminUids: async () => [],
      getEmailForUid: async () => null,
      adminNotifyEmail: '',
    });
    expect(emails).toEqual([]);
  });
});

describe('sendEmail', () => {
  it('surfaces a Resend { error } as false without throwing, and passes the idempotencyKey through', async () => {
    let seenKey: string | undefined;
    const ok = await sendEmail({
      to: ['a@example.com'],
      subject: 's',
      html: '<p>h</p>',
      idempotencyKey: 'moderation-notify/e/proofs/p/flagged',
      from: 'from@example.com',
      sender: async (_p: EmailPayload, opts) => {
        seenKey = opts.idempotencyKey;
        return { error: { message: 'boom' } };
      },
    });
    expect(ok).toBe(false);
    expect(seenKey).toBe('moderation-notify/e/proofs/p/flagged');
  });

  it('returns false (never rejects) when real-path SETUP throws — e.g. an unresolved secret', async () => {
    // Mock the params module so the secret read throws at setup, exercising the
    // non-injected path (no sender, no from) — proving setup failures honor the
    // never-throw contract, not just send failures (#101 Codex R3 F3).
    vi.doMock('../../functions/src/params', () => ({
      RESEND_API_KEY: { value: () => { throw new Error('secret unresolved'); } },
      EMAIL_FROM: { value: () => 'Test <t@example.com>' },
      // Present so the throw under test is the SECRET's, not a missing mock
      // key's — the params destructure covers EMAIL_REPLY_TO too (#616).
      EMAIL_REPLY_TO: { value: () => '' },
      ADMIN_NOTIFY_EMAIL: { value: () => '' },
      APP_BASE_URL: { value: () => 'https://example.com' },
    }));
    const result = sendEmail({ to: ['a@example.com'], subject: 's', html: '<p>h</p>', idempotencyKey: 'k' });
    await expect(result).resolves.toBe(false); // resolves false, does NOT reject
    vi.doUnmock('../../functions/src/params');
  });

  // Reply-To (#616, at Nathan's request). `EMAIL_FROM` must be an address on a
  // Resend-verified sending domain; replies want a mailbox a human reads, and
  // on the Five Across deployment those are deliberately different hosts.
  //
  // Both cases drive the REAL param path — `sender` is injected to capture the
  // payload but `from` is not, so the params module is resolved exactly as it
  // is in the Functions runtime.
  const capturePayload = async (): Promise<EmailPayload> => {
    let seen: EmailPayload | undefined;
    await sendEmail({
      to: ['a@example.com'],
      subject: 's',
      html: '<p>h</p>',
      idempotencyKey: 'k',
      sender: async (payload: EmailPayload) => {
        seen = payload;
        return { error: null };
      },
    });
    return seen as EmailPayload;
  };

  const mockParams = (replyTo: string) =>
    vi.doMock('../../functions/src/params', () => ({
      RESEND_API_KEY: { value: () => 'key' },
      EMAIL_FROM: { value: () => 'Test <t@example.com>' },
      EMAIL_REPLY_TO: { value: () => replyTo },
      ADMIN_NOTIFY_EMAIL: { value: () => '' },
      APP_BASE_URL: { value: () => 'https://example.com' },
    }));

  it('omits replyTo ENTIRELY when EMAIL_REPLY_TO is empty (the shipped default)', async () => {
    // An empty `Reply-To:` is a malformed header, not an absent one, so the
    // key must not appear at all — a project that sets nothing sends exactly
    // what it sent before this param existed.
    mockParams('');
    const payload = await capturePayload();
    expect(payload).not.toHaveProperty('replyTo');
    expect(payload.from).toBe('Test <t@example.com>');
    vi.doUnmock('../../functions/src/params');
  });

  it('sends replyTo under the Resend SDK’s camelCase field when the param is set', async () => {
    // `replyTo`, verified against the installed resend@4.8.0 typings
    // (`CreateEmailOptions.replyTo`). The `reply_to` in those same typings is
    // the RESPONSE shape; sending it would be silently ignored.
    mockParams('fiveacross@nathanpayne.com');
    const payload = await capturePayload();
    expect(payload.replyTo).toBe('fiveacross@nathanpayne.com');
    expect(payload).not.toHaveProperty('reply_to');
    vi.doUnmock('../../functions/src/params');
  });

  it('lets an explicit argument override the param, like `from` does', async () => {
    mockParams('param@example.com');
    let seen: EmailPayload | undefined;
    await sendEmail({
      to: ['a@example.com'],
      subject: 's',
      html: '<p>h</p>',
      idempotencyKey: 'k',
      replyTo: 'explicit@example.com',
      sender: async (payload: EmailPayload) => {
        seen = payload;
        return { error: null };
      },
    });
    expect(seen?.replyTo).toBe('explicit@example.com');
    vi.doUnmock('../../functions/src/params');
  });

  it('stays free of the params module when both `from` and `sender` are injected', async () => {
    // The resolution guard's existing property, re-asserted because #616 added
    // a second param read inside it: a fully-injected call must not drag
    // firebase-functions into a unit test. A params mock that throws on ANY
    // access proves the module is never reached.
    vi.doMock('../../functions/src/params', () => {
      throw new Error('params must not be imported on the fully-injected path');
    });
    let seen: EmailPayload | undefined;
    const ok = await sendEmail({
      to: ['a@example.com'],
      subject: 's',
      html: '<p>h</p>',
      idempotencyKey: 'k',
      from: 'from@example.com',
      sender: async (payload: EmailPayload) => {
        seen = payload;
        return { error: null };
      },
    });
    expect(ok).toBe(true);
    expect(seen).not.toHaveProperty('replyTo');
    vi.doUnmock('../../functions/src/params');
  });
});

describe('notifyAdminsOfModeration', () => {
  it('composes ONE send to all resolved admins with a status-scoped idempotency key', async () => {
    const send = vi.fn(async () => true);
    const ok = await notifyAdminsOfModeration(
      'med-2026',
      'proofs',
      'proof123',
      { status: 'flagged', visionFlag: 'violence' },
      'evt-abc',
      {
        getAdminUids: async () => ['u1', 'u2'],
        getEmailForUid: async (uid) => `${uid}@example.com`,
        adminNotifyEmail: '',
        appBaseUrl: 'https://example.com',
        send,
      },
    );
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.to).toEqual(['u1@example.com', 'u2@example.com']);
    expect(arg.idempotencyKey).toBe('moderation-notify/med-2026/proofs/proof123/flagged/evt-abc');
    expect(arg.html).toContain('https://example.com/admin');
    expect(arg.subject).toBe('[GCB moderation] Proof flagged (violence)');
  });

  it('derives the cause from doc state: threshold, manual, and Vision — never a fabricated threshold', async () => {
    const subjects: string[] = [];
    const base = {
      getAdminUids: async () => ['u1'],
      getEmailForUid: async (uid: string) => `${uid}@example.com`,
      adminNotifyEmail: '',
      appBaseUrl: 'https://example.com',
      getReportHideThreshold: async () => 3,
      send: async (a: { subject: string }) => {
        subjects.push(a.subject);
        return true;
      },
    };
    // At/over threshold → threshold cause.
    await notifyAdminsOfModeration('e', 'items', 'i', { status: 'hidden', reportCount: 3 }, 't1', base);
    // Manual hide of an unreported/sub-threshold prompt → admin cause, NOT "reports >= threshold".
    await notifyAdminsOfModeration('e', 'items', 'i', { status: 'hidden', reportCount: 0 }, 't2', base);
    // Threshold unknown → no fabricated cause (neutral "hidden").
    await notifyAdminsOfModeration('e', 'items', 'i', { status: 'hidden', reportCount: 0 }, 't3', {
      ...base,
      getReportHideThreshold: async () => null,
    });
    // Vision flag names itself.
    await notifyAdminsOfModeration('e', 'proofs', 'p', { status: 'flagged', visionFlag: 'violence' }, 't4', base);
    expect(subjects).toEqual([
      '[GCB moderation] Prompt hidden (reports >= threshold)',
      '[GCB moderation] Prompt hidden (by an admin)',
      '[GCB moderation] Prompt hidden',
      '[GCB moderation] Proof flagged (violence)',
    ]);
  });

  it('keys per transition: same CloudEvent id is retry-stable, distinct ids differ (even into the same status)', async () => {
    const keys: string[] = [];
    const deps = {
      getAdminUids: async () => ['u1'],
      getEmailForUid: async (uid: string) => `${uid}@example.com`,
      adminNotifyEmail: '',
      appBaseUrl: 'https://example.com',
      getReportHideThreshold: async () => null,
      send: async (a: { idempotencyKey: string }) => {
        keys.push(a.idempotencyKey);
        return true;
      },
    };
    // A platform retry of ONE transition reuses the same CloudEvent id → same key.
    await notifyAdminsOfModeration('e', 'items', 'i9', { status: 'hidden' }, 'evt-1', deps);
    await notifyAdminsOfModeration('e', 'items', 'i9', { status: 'hidden' }, 'evt-1', deps);
    // A genuine re-hide after a restore is a distinct event id → distinct key.
    await notifyAdminsOfModeration('e', 'items', 'i9', { status: 'hidden' }, 'evt-2', deps);
    expect(keys[0]).toBe('moderation-notify/e/items/i9/hidden/evt-1');
    expect(keys[0]).toBe(keys[1]); // retry-stable → Resend dedupes
    expect(keys[2]).not.toBe(keys[0]); // distinct transition → delivers
  });

  it('sends nothing and returns false when no admin email resolves', async () => {
    const send = vi.fn(async () => true);
    const ok = await notifyAdminsOfModeration('med-2026', 'items', 'item9', { status: 'hidden' }, 'evt-x', {
      getAdminUids: async () => [],
      getEmailForUid: async () => null,
      adminNotifyEmail: '',
      appBaseUrl: 'https://example.com',
      send,
    });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
