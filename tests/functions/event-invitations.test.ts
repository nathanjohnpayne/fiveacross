import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  invitationIdForCode,
  invitationPath,
  invitationRatePath,
  mintEventInvitation,
  redeemEventInvitation,
  revokeEventInvitation,
  type EventInvitationDeps,
  type EventInvitationPolicy,
  type InvitationDocRef,
  type InvitationFirestore,
  type InvitationQuery,
  type InvitationQuerySnapshot,
  type InvitationSnapshot,
  type InvitationTransaction,
} from '../../functions/src/eventInvitations';
import { membershipPath } from '../../functions/src/eventMembership.generated';

const EVENT_ID = 'event-a';
const OTHER_EVENT_ID = 'event-b';
const ADMIN = 'admin-1';
const MEMBER = 'member-1';
const OTHER_MEMBER = 'member-2';
const CODE = 'a'.repeat(43);
const NOW = 1_000_000;

type Stored = { data: Record<string, unknown>; version: number };
type StagedWrite =
  | { kind: 'create'; ref: InvitationDocRef; data: Record<string, unknown> }
  | { kind: 'set'; ref: InvitationDocRef; data: Record<string, unknown> }
  | { kind: 'update'; ref: InvitationDocRef; data: Record<string, unknown> };

class FakeTimestamp {
  constructor(readonly milliseconds: number) {}

  toMillis(): number {
    return this.milliseconds;
  }
}

function copy<T>(value: T): T {
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.milliseconds) as T;
  if (Array.isArray(value)) return value.map((entry) => copy(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copy(entry)]),
    ) as T;
  }
  return value;
}

function timestamp(ms: number): FakeTimestamp {
  return new FakeTimestamp(ms);
}

/**
 * Conflict-retrying Firestore fake. It snapshots versions at read time, stages
 * every write, and reruns the callback when any read changed before commit.
 * The concurrency tests therefore exercise the same retry contract the core
 * relies on instead of serialising two calls and calling that a race.
 */
class RetryFirestore implements InvitationFirestore {
  readonly docs = new Map<string, Stored>();
  readonly reads: string[] = [];
  conflicts = 0;
  beforeCommit?: (attempt: number) => Promise<void> | void;

  constructor(seed: Record<string, Record<string, unknown>> = {}) {
    for (const [path, data] of Object.entries(seed)) this.docs.set(path, { data: copy(data), version: 1 });
  }

  doc(path: string): InvitationDocRef {
    return { path };
  }

  hostnamesForEvent(eventId: string): InvitationQuery {
    return { eventId };
  }

  writeOutsideTransaction(path: string, data: Record<string, unknown>): void {
    const previous = this.docs.get(path);
    this.docs.set(path, { data: copy(data), version: (previous?.version ?? 0) + 1 });
  }

  data(path: string): Record<string, unknown> | undefined {
    const value = this.docs.get(path)?.data;
    return value ? copy(value) : undefined;
  }

  async runTransaction<T>(work: (transaction: InvitationTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const reads = new Map<string, number>();
      const writes: StagedWrite[] = [];
      const getSnapshot = (ref: InvitationDocRef): InvitationSnapshot => {
        const stored = this.docs.get(ref.path);
        reads.set(ref.path, stored?.version ?? 0);
        this.reads.push(ref.path);
        return {
          exists: stored !== undefined,
          data: () => stored ? copy(stored.data) : undefined,
        };
      };
      const transaction: InvitationTransaction = {
        get: async (ref) => getSnapshot(ref),
        getQuery: async (query): Promise<InvitationQuerySnapshot> => {
          const docs = [...this.docs.entries()]
            .filter(([path, stored]) => path.startsWith('hostnames/') && stored.data.eventId === query.eventId)
            .map(([path, stored]) => {
              reads.set(path, stored.version);
              this.reads.push(path);
              return { id: path.slice('hostnames/'.length), data: () => copy(stored.data) };
            });
          return { docs };
        },
        create: (ref, data) => writes.push({ kind: 'create', ref, data: copy(data) }),
        set: (ref, data) => writes.push({ kind: 'set', ref, data: copy(data) }),
        update: (ref, data) => writes.push({ kind: 'update', ref, data: copy(data) }),
      };
      const result = await work(transaction);
      await this.beforeCommit?.(attempt);
      const conflicted = [...reads].some(([path, version]) => (this.docs.get(path)?.version ?? 0) !== version);
      if (conflicted) {
        this.conflicts += 1;
        continue;
      }
      for (const write of writes) {
        const previous = this.docs.get(write.ref.path);
        if (write.kind === 'create' && previous) throw new Error(`already exists: ${write.ref.path}`);
        if (write.kind === 'update' && !previous) throw new Error(`not found: ${write.ref.path}`);
        const data = write.kind === 'update'
          ? { ...copy(previous!.data), ...copy(write.data) }
          : copy(write.data);
        this.docs.set(write.ref.path, { data, version: (previous?.version ?? 0) + 1 });
      }
      return result;
    }
    throw new Error('transaction retry limit exceeded');
  }
}

function policy(overrides: Partial<EventInvitationPolicy> = {}): EventInvitationPolicy {
  return {
    ttlMs: 60_000,
    grantRole: 'member',
    maxUses: 1,
    revokeGrantedMemberships: false,
    rate: {
      mint: { windowMs: 60_000, maxAttempts: 20 },
      redeem: { windowMs: 60_000, maxAttempts: 20 },
      revoke: { windowMs: 60_000, maxAttempts: 20 },
    },
    ...overrides,
  };
}

function baseSeed(): Record<string, Record<string, unknown>> {
  return {
    [`events/${EVENT_ID}`]: { status: 'active', admins: [ADMIN] },
    [membershipPath(EVENT_ID, ADMIN)]: {
      schemaVersion: 1,
      eventId: EVENT_ID,
      uid: ADMIN,
      role: 'admin',
      status: 'active',
      grantedAt: 1,
      grantedBy: 'system:backfill',
      invitationId: null,
    },
    'hostnames/event-a.fiveacross.app': {
      eventId: EVENT_ID,
      edition: 'fiveacross',
      slug: 'event-a',
      status: 'active',
      isCanonical: true,
      canonicalHost: 'event-a.fiveacross.app',
    },
  };
}

function deps(
  db: RetryFirestore,
  options: { now?: () => number; policy?: EventInvitationPolicy; mintCode?: () => string } = {},
): EventInvitationDeps {
  return {
    db,
    now: options.now ?? (() => NOW),
    timestamp,
    mintCode: options.mintCode ?? (() => CODE),
    policy: options.policy ?? policy(),
  };
}

async function minted(db: RetryFirestore, options: Parameters<typeof deps>[1] = {}) {
  const result = await mintEventInvitation({ uid: ADMIN, eventId: EVENT_ID }, deps(db, options));
  if (!result.ok) throw new Error(`mint failed: ${result.reason}`);
  return result;
}

describe('generated Functions membership mirror', () => {
  it('is byte-current with the marked canonical source blocks', () => {
    expect(() => execFileSync(
      process.execPath,
      [path.join(process.cwd(), 'scripts/materialize-event-membership-functions.mjs'), '--check'],
      { cwd: process.cwd(), stdio: 'pipe' },
    )).not.toThrow();
  });
});

describe('server-owned collection path inventory', () => {
  it('keeps Invitation and rate documents leaf-only and outside the reserved markers group', () => {
    const paths = [
      invitationPath('a'.repeat(64)),
      invitationRatePath('mint', ADMIN),
      invitationRatePath('redeem', MEMBER),
      invitationRatePath('revoke', ADMIN),
    ];

    for (const documentPath of paths) {
      expect(documentPath.split('/')).toHaveLength(2);
      expect(documentPath.split('/')).not.toContain('markers');
    }
    expect(paths[0]).toBe(`eventInvitations/${'a'.repeat(64)}`);
    expect(paths.slice(1).every((documentPath) => documentPath.startsWith('eventInvitationRateLimits/'))).toBe(true);
  });
});

describe('mintEventInvitation', () => {
  it.each([
    ['neither roster nor Membership authority', false],
    ['Membership authority without roster authority', true],
  ])('rejects a caller with %s', async (_label, hasMembership) => {
    const seed = baseSeed();
    if (hasMembership) {
      seed[membershipPath(EVENT_ID, MEMBER)] = {
        schemaVersion: 1,
        eventId: EVENT_ID,
        uid: MEMBER,
        role: 'member',
        status: 'active',
        grantedAt: 1,
        grantedBy: ADMIN,
        invitationId: null,
      };
    }
    const db = new RetryFirestore(seed);

    expect(await mintEventInvitation({ uid: MEMBER, eventId: EVENT_ID }, deps(db))).toEqual({
      ok: false,
      reason: 'not-authorized',
    });
    expect(db.data(invitationRatePath('mint', MEMBER))?.attemptMs).toEqual([NOW]);
    expect(db.data(invitationPath(invitationIdForCode(CODE)))).toBeUndefined();
  });

  it('authorizes from the live roster plus the issuer active membership and stores only a code hash', async () => {
    const db = new RetryFirestore(baseSeed());
    const result = await minted(db);

    expect(result).toMatchObject({
      eventId: EVENT_ID,
      invitationId: invitationIdForCode(CODE),
      invitationUrl: `https://event-a.fiveacross.app/#fa_invite=${CODE}`,
      expiresAt: NOW + 60_000,
    });
    const stored = db.data(invitationPath(invitationIdForCode(CODE)));
    expect(stored).toMatchObject({
      eventId: EVENT_ID,
      createdBy: ADMIN,
      role: 'member',
      status: 'active',
      remainingUses: 1,
      grantedUids: [],
    });
    expect(JSON.stringify(stored)).not.toContain(CODE);
  });

  it('rejects a live-roster Admin whose own membership is absent and commits the abuse charge', async () => {
    const seed = baseSeed();
    delete seed[membershipPath(EVENT_ID, ADMIN)];
    const db = new RetryFirestore(seed);

    expect(await mintEventInvitation({ uid: ADMIN, eventId: EVENT_ID }, deps(db))).toEqual({
      ok: false,
      reason: 'not-authorized',
    });
    expect(db.data(invitationRatePath('mint', ADMIN))?.attemptMs).toEqual([NOW]);
    expect(db.data(invitationPath(invitationIdForCode(CODE)))).toBeUndefined();
  });

  it('fails closed without a unique active canonical hostname', async () => {
    const seed = baseSeed();
    seed['hostnames/event-a.fiveacross.app'].status = 'disabled';
    const db = new RetryFirestore(seed);
    expect(await mintEventInvitation({ uid: ADMIN, eventId: EVENT_ID }, deps(db))).toEqual({
      ok: false,
      reason: 'canonical-host-unavailable',
    });
  });

  it.each([
    ['edition', undefined],
    ['slug', 'Not-A-Slug'],
  ])('fails closed when canonical-host %s metadata is malformed', async (field, value) => {
    const seed = baseSeed();
    if (value === undefined) delete seed['hostnames/event-a.fiveacross.app'][field];
    else seed['hostnames/event-a.fiveacross.app'][field] = value;
    const db = new RetryFirestore(seed);

    expect(await mintEventInvitation({ uid: ADMIN, eventId: EVENT_ID }, deps(db))).toEqual({
      ok: false,
      reason: 'canonical-host-unavailable',
    });
  });

  it('accepts an apex canonical host without deriving the Event slug from DNS', async () => {
    const seed = baseSeed();
    delete seed['hostnames/event-a.fiveacross.app'];
    seed['hostnames/gaycruisebingo.com'] = {
      eventId: EVENT_ID,
      edition: 'gcb',
      slug: 'med-2026',
      status: 'active',
      isCanonical: true,
      canonicalHost: 'gaycruisebingo.com',
    };
    const db = new RetryFirestore(seed);

    expect(await mintEventInvitation({ uid: ADMIN, eventId: EVENT_ID }, deps(db))).toMatchObject({
      ok: true,
      invitationUrl: `https://gaycruisebingo.com/#fa_invite=${CODE}`,
    });
  });

  it('takes server time inside each transaction attempt', async () => {
    const db = new RetryFirestore(baseSeed());
    let conflictInjected = false;
    db.beforeCommit = (attempt) => {
      if (attempt === 1 && !conflictInjected) {
        conflictInjected = true;
        db.writeOutsideTransaction(`events/${EVENT_ID}`, { status: 'active', admins: [ADMIN] });
      }
    };
    let clock = NOW;
    const result = await minted(db, { now: () => (clock += 1_000) });

    expect(db.conflicts).toBe(1);
    expect((db.data(invitationPath(result.invitationId))?.createdAt as FakeTimestamp).toMillis()).toBe(NOW + 2_000);
    expect(result.expiresAt).toBe(NOW + 62_000);
  });

  it('re-reads issuer authority after a transaction conflict', async () => {
    const db = new RetryFirestore(baseSeed());
    db.beforeCommit = (attempt) => {
      if (attempt === 1) {
        db.writeOutsideTransaction(membershipPath(EVENT_ID, ADMIN), {
          ...db.data(membershipPath(EVENT_ID, ADMIN)),
          status: 'revoked',
          revokedAt: NOW,
          revokedBy: ADMIN,
        });
      }
    };

    expect(await mintEventInvitation({ uid: ADMIN, eventId: EVENT_ID }, deps(db))).toEqual({
      ok: false,
      reason: 'not-authorized',
    });
    expect(db.conflicts).toBe(1);
    expect(db.data(invitationPath(invitationIdForCode(CODE)))).toBeUndefined();
  });

  it('re-reads the live Admin roster after a transaction conflict', async () => {
    const db = new RetryFirestore(baseSeed());
    db.beforeCommit = (attempt) => {
      if (attempt === 1) {
        db.writeOutsideTransaction(`events/${EVENT_ID}`, { status: 'active', admins: [] });
      }
    };

    expect(await mintEventInvitation({ uid: ADMIN, eventId: EVENT_ID }, deps(db))).toEqual({
      ok: false,
      reason: 'not-authorized',
    });
    expect(db.conflicts).toBe(1);
    expect(db.data(invitationPath(invitationIdForCode(CODE)))).toBeUndefined();
  });

  it('uses 32 bytes of default entropy and stores only its digest', async () => {
    const db = new RetryFirestore(baseSeed());
    const runtimeDeps = deps(db);
    delete runtimeDeps.mintCode;

    const result = await mintEventInvitation({ uid: ADMIN, eventId: EVENT_ID }, runtimeDeps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.invitationId).toBe(invitationIdForCode(result.code));
    expect(JSON.stringify(db.data(invitationPath(result.invitationId)))).not.toContain(result.code);
  });

  it('retries a digest collision with fresh entropy, then succeeds', async () => {
    const collisionCode = 'c'.repeat(43);
    const freshCode = 'd'.repeat(43);
    const seed = baseSeed();
    seed[invitationPath(invitationIdForCode(collisionCode))] = {
      occupied: true,
    };
    const db = new RetryFirestore(seed);
    const mintCode = vi.fn()
      .mockReturnValueOnce(collisionCode)
      .mockReturnValueOnce(freshCode);

    const result = await mintEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID },
      deps(db, { mintCode }),
    );

    expect(result).toMatchObject({ ok: true, code: freshCode });
    expect(mintCode).toHaveBeenCalledTimes(2);
    expect(db.data(invitationPath(invitationIdForCode(collisionCode)))).toEqual({ occupied: true });
  });

  it('bounds repeated digest collisions and charges the terminal mint attempt once', async () => {
    const seed = baseSeed();
    seed[invitationPath(invitationIdForCode(CODE))] = { occupied: true };
    const db = new RetryFirestore(seed);
    const mintCode = vi.fn(() => CODE);

    expect(await mintEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID },
      deps(db, { mintCode }),
    )).toEqual({ ok: false, reason: 'code-collision' });
    expect(mintCode).toHaveBeenCalledTimes(3);
    expect(db.data(invitationRatePath('mint', ADMIN))).toEqual({
      schemaVersion: 1,
      operation: 'mint',
      attemptMs: [NOW],
    });
  });

  it('rate-limits repeated mint abuse per authenticated caller', async () => {
    const limited = policy({
      rate: {
        mint: { windowMs: 60_000, maxAttempts: 1 },
        redeem: { windowMs: 60_000, maxAttempts: 20 },
        revoke: { windowMs: 60_000, maxAttempts: 20 },
      },
    });
    const db = new RetryFirestore(baseSeed());
    const attempt = () => mintEventInvitation(
      { uid: MEMBER, eventId: EVENT_ID },
      deps(db, { policy: limited }),
    );

    expect(await attempt()).toEqual({ ok: false, reason: 'not-authorized' });
    const readsBeforeExhaustedAttempt = db.reads.length;
    expect(await attempt()).toEqual({ ok: false, reason: 'rate-limited' });
    expect(db.reads.slice(readsBeforeExhaustedAttempt)).toEqual([
      invitationRatePath('mint', MEMBER),
    ]);
    expect(db.data(invitationRatePath('mint', MEMBER))?.attemptMs).toEqual([NOW]);
  });
});

describe('redeemEventInvitation', () => {
  it('creates the membership and consumes the invitation atomically', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);
    const result = await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db),
    );

    expect(result).toEqual({ ok: true, eventId: EVENT_ID, outcome: 'membership-created' });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))).toEqual({
      schemaVersion: 1,
      eventId: EVENT_ID,
      uid: MEMBER,
      role: 'member',
      status: 'active',
      grantedAt: NOW,
      grantedBy: ADMIN,
      invitationId: invitation.invitationId,
    });
    expect(db.data(invitationPath(invitation.invitationId))).toMatchObject({
      status: 'consumed',
      remainingUses: 0,
      grantedUids: [MEMBER],
    });
  });

  it('binds redemption to the Event resolved by the client without trusting it as authority', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);
    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: OTHER_EVENT_ID },
      deps(db),
    )).toEqual({ ok: false, reason: 'event-mismatch' });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))).toBeUndefined();
    expect(db.data(invitationPath(invitation.invitationId))?.remainingUses).toBe(1);
  });

  it('makes a same-caller retry idempotent without decrementing again while still bounding calls', async () => {
    const db = new RetryFirestore(baseSeed());
    const twoAttempts = policy({ rate: {
      mint: { windowMs: 60_000, maxAttempts: 20 },
      redeem: { windowMs: 60_000, maxAttempts: 2 },
      revoke: { windowMs: 60_000, maxAttempts: 20 },
    } });
    const invitation = await minted(db, { policy: twoAttempts });
    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { policy: twoAttempts }),
    )).toMatchObject({ ok: true });
    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { policy: twoAttempts }),
    )).toEqual({
      ok: true,
      eventId: EVENT_ID,
      outcome: 'already-member',
    });
    const readsBeforeExhaustedAttempt = db.reads.length;
    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { policy: twoAttempts }),
    )).toEqual({ ok: false, reason: 'rate-limited' });
    expect(db.reads.slice(readsBeforeExhaustedAttempt)).toEqual([
      invitationRatePath('redeem', MEMBER),
    ]);
    expect(db.data(invitationPath(invitation.invitationId))?.grantedUids).toEqual([MEMBER]);
    expect(db.data(invitationRatePath('redeem', MEMBER))?.attemptMs).toEqual([NOW, NOW]);
  });

  it.each([
    ['expired', (record: Record<string, unknown>) => record, NOW + 60_000],
    [
      'revoked',
      (record: Record<string, unknown>) => ({
        ...record,
        status: 'revoked',
        revokedAt: timestamp(NOW),
        revokedBy: ADMIN,
      }),
      NOW,
    ],
    [
      'consumed',
      (record: Record<string, unknown>) => ({
        ...record,
        status: 'consumed',
        remainingUses: 0,
        grantedUids: [OTHER_MEMBER],
      }),
      NOW,
    ],
  ] as const)(
    'treats an existing active member as idempotent when the Invitation is %s',
    async (_label, mutate, redemptionTime) => {
      const seed = baseSeed();
      seed[membershipPath(EVENT_ID, MEMBER)] = {
        schemaVersion: 1,
        eventId: EVENT_ID,
        uid: MEMBER,
        role: 'member',
        status: 'active',
        grantedAt: 1,
        grantedBy: 'system:backfill',
        invitationId: null,
      };
      const db = new RetryFirestore(seed);
      const invitation = await minted(db);
      db.writeOutsideTransaction(
        invitationPath(invitation.invitationId),
        mutate(db.data(invitationPath(invitation.invitationId))!),
      );

      expect(await redeemEventInvitation(
        { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
        deps(db, { now: () => redemptionTime }),
      )).toEqual({ ok: true, eventId: EVENT_ID, outcome: 'already-member' });
      expect(db.data(invitationPath(invitation.invitationId))?.grantedUids).not.toContain(MEMBER);
      expect(db.data(invitationRatePath('redeem', MEMBER))?.attemptMs).toEqual([
        redemptionTime,
      ]);
    },
  );

  it('never overwrites a revoked membership', async () => {
    const seed = baseSeed();
    seed[membershipPath(EVENT_ID, MEMBER)] = {
      schemaVersion: 1,
      eventId: EVENT_ID,
      uid: MEMBER,
      role: 'member',
      status: 'revoked',
      grantedAt: 1,
      grantedBy: ADMIN,
      invitationId: null,
      revokedAt: 2,
      revokedBy: ADMIN,
    };
    const db = new RetryFirestore(seed);
    await minted(db);
    expect(await redeemEventInvitation({ uid: MEMBER, code: CODE, expectedEventId: EVENT_ID }, deps(db))).toEqual({
      ok: false,
      reason: 'membership-revoked',
    });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))?.status).toBe('revoked');
  });

  it('uses the frozen active status even when versioned Membership fields are malformed', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);
    db.writeOutsideTransaction(membershipPath(EVENT_ID, MEMBER), { status: 'active' });

    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db),
    )).toEqual({ ok: true, eventId: EVENT_ID, outcome: 'already-member' });
    expect(db.data(invitationPath(invitation.invitationId))?.remainingUses).toBe(1);
  });

  it('terminally refuses a malformed non-active Membership', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);
    db.writeOutsideTransaction(membershipPath(EVENT_ID, MEMBER), { status: 'pending' });

    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db),
    )).toEqual({ ok: false, reason: 'membership-unreadable' });
    expect(db.data(invitationPath(invitation.invitationId))?.remainingUses).toBe(1);
  });

  it('keeps active Membership admission version-blind during schema rollout', async () => {
    const seed = baseSeed();
    seed[membershipPath(EVENT_ID, MEMBER)] = {
      schemaVersion: 2,
      eventId: EVENT_ID,
      uid: MEMBER,
      role: 'member',
      status: 'active',
      grantedAt: 1,
      grantedBy: 'system:migration',
      invitationId: null,
    };
    const db = new RetryFirestore(seed);
    const invitation = await minted(db);

    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db),
    )).toEqual({ ok: true, eventId: EVENT_ID, outcome: 'already-member' });
    expect(db.data(invitationPath(invitation.invitationId))?.remainingUses).toBe(1);
    expect(db.data(invitationRatePath('redeem', MEMBER))?.attemptMs).toEqual([NOW]);
  });

  it('re-evaluates a newer active Membership after a transaction conflict', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);
    db.beforeCommit = (attempt) => {
      if (attempt !== 1) return;
      db.writeOutsideTransaction(membershipPath(EVENT_ID, MEMBER), {
        schemaVersion: 2,
        status: 'active',
        migrationField: 'newer-schema',
      });
    };

    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db),
    )).toEqual({ ok: true, eventId: EVENT_ID, outcome: 'already-member' });
    expect(db.conflicts).toBe(1);
    expect(db.data(invitationPath(invitation.invitationId))?.remainingUses).toBe(1);
    expect(db.data(membershipPath(EVENT_ID, MEMBER))).toEqual({
      schemaVersion: 2,
      status: 'active',
      migrationField: 'newer-schema',
    });
    expect(db.data(invitationRatePath('redeem', MEMBER))?.attemptMs).toEqual([NOW]);
  });

  it.each([
    ['expired', NOW + 60_000],
    ['archived Event', NOW],
  ])('rejects an %s invitation', async (kind, redemptionTime) => {
    const db = new RetryFirestore(baseSeed());
    await minted(db);
    if (kind === 'archived Event') db.writeOutsideTransaction(`events/${EVENT_ID}`, { status: 'archived', admins: [ADMIN] });
    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { now: () => redemptionTime }),
    )).toMatchObject({ ok: false });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))).toBeUndefined();
    expect(db.data(invitationRatePath('redeem', MEMBER))?.attemptMs).toEqual([redemptionTime]);
  });

  it.each([
    [
      'revoked',
      (record: Record<string, unknown>) => ({
        ...record,
        status: 'revoked',
        revokedAt: timestamp(NOW),
        revokedBy: ADMIN,
      }),
      'invitation-unavailable',
    ],
    [
      'consumed',
      (record: Record<string, unknown>) => ({
        ...record,
        status: 'consumed',
        remainingUses: 0,
        grantedUids: [OTHER_MEMBER],
      }),
      'invitation-unavailable',
    ],
    [
      'shape-malformed',
      (record: Record<string, unknown>) => ({ ...record, expiresAt: NOW + 60_000 }),
      'invalid-invitation',
    ],
    [
      'internally exhausted but still active',
      (record: Record<string, unknown>) => ({ ...record, remainingUses: 0 }),
      'invalid-invitation',
    ],
  ] as const)(
    'charges and makes no partial grant for a %s Invitation',
    async (_label, mutate, reason) => {
      const db = new RetryFirestore(baseSeed());
      const invitation = await minted(db);
      db.writeOutsideTransaction(
        invitationPath(invitation.invitationId),
        mutate(db.data(invitationPath(invitation.invitationId))!),
      );

      expect(await redeemEventInvitation(
        { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
        deps(db),
      )).toEqual({ ok: false, reason });
      expect(db.data(membershipPath(EVENT_ID, MEMBER))).toBeUndefined();
      expect(db.data(invitationRatePath('redeem', MEMBER))?.attemptMs).toEqual([NOW]);
    },
  );

  it('fails closed on an otherwise valid invitation dated in the future', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);
    db.writeOutsideTransaction(invitationPath(invitation.invitationId), {
      ...db.data(invitationPath(invitation.invitationId)),
      createdAt: timestamp(NOW + 1),
    });

    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db),
    )).toEqual({ ok: false, reason: 'invalid-invitation' });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))).toBeUndefined();
  });

  it('fails closed when an Invitation timestamp is a plain number', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);
    db.writeOutsideTransaction(invitationPath(invitation.invitationId), {
      ...db.data(invitationPath(invitation.invitationId)),
      expiresAt: NOW + 60_000,
    });

    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db),
    )).toEqual({ ok: false, reason: 'invalid-invitation' });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))).toBeUndefined();
  });

  it('commits well-shaped unknown-code attempts and then rate-limits them', async () => {
    const db = new RetryFirestore(baseSeed());
    const limited = policy({ rate: {
      mint: { windowMs: 60_000, maxAttempts: 20 },
      redeem: { windowMs: 60_000, maxAttempts: 2 },
      revoke: { windowMs: 60_000, maxAttempts: 20 },
    } });
    const attempt = () => redeemEventInvitation(
      { uid: MEMBER, code: 'z'.repeat(43), expectedEventId: EVENT_ID },
      deps(db, { policy: limited }),
    );

    expect(await attempt()).toEqual({ ok: false, reason: 'unknown-invitation' });
    expect(await attempt()).toEqual({ ok: false, reason: 'unknown-invitation' });
    const readsBeforeExhaustedAttempt = db.reads.length;
    expect(await attempt()).toEqual({ ok: false, reason: 'rate-limited' });
    expect(db.reads.slice(readsBeforeExhaustedAttempt)).toEqual([
      invitationRatePath('redeem', MEMBER),
    ]);
    expect(db.data(invitationRatePath('redeem', MEMBER))?.attemptMs).toEqual([NOW, NOW]);
  });

  it('drops an attempt exactly at the rolling-window boundary', async () => {
    let now = NOW;
    const db = new RetryFirestore(baseSeed());
    const limited = policy({
      rate: {
        mint: { windowMs: 60_000, maxAttempts: 20 },
        redeem: { windowMs: 60_000, maxAttempts: 1 },
        revoke: { windowMs: 60_000, maxAttempts: 20 },
      },
    });
    const attempt = () => redeemEventInvitation(
      { uid: MEMBER, code: 'z'.repeat(43), expectedEventId: EVENT_ID },
      deps(db, { now: () => now, policy: limited }),
    );

    expect(await attempt()).toEqual({ ok: false, reason: 'unknown-invitation' });
    expect(await attempt()).toEqual({ ok: false, reason: 'rate-limited' });
    now += 60_000;
    expect(await attempt()).toEqual({ ok: false, reason: 'unknown-invitation' });
    expect(db.data(invitationRatePath('redeem', MEMBER))?.attemptMs).toEqual([now]);
  });

  it('allows exactly one of two different callers to consume a single-use invitation', async () => {
    const db = new RetryFirestore(baseSeed());
    await minted(db);
    let arrivals = 0;
    let release = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.beforeCommit = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
    };
    const outcomes = await Promise.all([
      redeemEventInvitation({ uid: MEMBER, code: CODE, expectedEventId: EVENT_ID }, deps(db)),
      redeemEventInvitation({ uid: OTHER_MEMBER, code: CODE, expectedEventId: EVENT_ID }, deps(db)),
    ]);

    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'invitation-unavailable' }]);
    expect([
      db.data(membershipPath(EVENT_ID, MEMBER)),
      db.data(membershipPath(EVENT_ID, OTHER_MEMBER)),
    ].filter(Boolean)).toHaveLength(1);
    expect(db.conflicts).toBeGreaterThan(0);
  });

  it('turns an admin-role grant into both membership and live-roster authority', async () => {
    const db = new RetryFirestore(baseSeed());
    await minted(db, { policy: policy({ grantRole: 'admin' }) });
    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { policy: policy({ grantRole: 'admin' }) }),
    )).toMatchObject({ ok: true });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))?.role).toBe('admin');
    expect(db.data(`events/${EVENT_ID}`)?.admins).toEqual([ADMIN, MEMBER]);
  });
});

describe('revokeEventInvitation', () => {
  it.each([
    ['neither roster nor Membership authority', false],
    ['Membership authority without roster authority', true],
  ])('rejects a caller with %s', async (_label, hasMembership) => {
    const seed = baseSeed();
    if (hasMembership) {
      seed[membershipPath(EVENT_ID, MEMBER)] = {
        schemaVersion: 1,
        eventId: EVENT_ID,
        uid: MEMBER,
        role: 'member',
        status: 'active',
        grantedAt: 1,
        grantedBy: ADMIN,
        invitationId: null,
      };
    }
    const db = new RetryFirestore(seed);
    const invitation = await minted(db);

    expect(await revokeEventInvitation(
      { uid: MEMBER, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db),
    )).toEqual({ ok: false, reason: 'not-authorized' });
    expect(db.data(invitationPath(invitation.invitationId))?.status).toBe('active');
    expect(db.data(invitationRatePath('revoke', MEMBER))?.attemptMs).toEqual([NOW]);
  });

  it('requires the live roster and active issuer membership inside the transaction', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);
    db.writeOutsideTransaction(membershipPath(EVENT_ID, ADMIN), {
      ...db.data(membershipPath(EVENT_ID, ADMIN)),
      status: 'revoked',
      revokedAt: NOW,
      revokedBy: ADMIN,
    });

    expect(await revokeEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db),
    )).toEqual({ ok: false, reason: 'not-authorized' });
    expect(db.data(invitationPath(invitation.invitationId))?.status).toBe('active');
  });

  it.each(['roster', 'membership'] as const)(
    're-reads issuer %s authority after a transaction conflict',
    async (lostAuthority) => {
      const db = new RetryFirestore(baseSeed());
      const invitation = await minted(db);
      db.beforeCommit = (attempt) => {
        if (attempt !== 1) return;
        if (lostAuthority === 'roster') {
          db.writeOutsideTransaction(`events/${EVENT_ID}`, { status: 'active', admins: [] });
        } else {
          db.writeOutsideTransaction(membershipPath(EVENT_ID, ADMIN), {
            ...db.data(membershipPath(EVENT_ID, ADMIN)),
            status: 'revoked',
            revokedAt: NOW,
            revokedBy: ADMIN,
          });
        }
      };

      expect(await revokeEventInvitation(
        { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
        deps(db),
      )).toEqual({ ok: false, reason: 'not-authorized' });
      expect(db.conflicts).toBe(1);
      expect(db.data(invitationPath(invitation.invitationId))?.status).toBe('active');
    },
  );

  it('rate-limits repeated revoke abuse per authenticated caller', async () => {
    const limited = policy({
      rate: {
        mint: { windowMs: 60_000, maxAttempts: 20 },
        redeem: { windowMs: 60_000, maxAttempts: 20 },
        revoke: { windowMs: 60_000, maxAttempts: 1 },
      },
    });
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db, { policy: limited });
    const attempt = () => revokeEventInvitation(
      { uid: MEMBER, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db, { policy: limited }),
    );

    expect(await attempt()).toEqual({ ok: false, reason: 'not-authorized' });
    const readsBeforeExhaustedAttempt = db.reads.length;
    expect(await attempt()).toEqual({ ok: false, reason: 'rate-limited' });
    expect(db.reads.slice(readsBeforeExhaustedAttempt)).toEqual([
      invitationRatePath('revoke', MEMBER),
    ]);
    expect(db.data(invitationRatePath('revoke', MEMBER))?.attemptMs).toEqual([NOW]);
  });

  it('can revoke the link without changing memberships when cascade policy is off', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);
    await redeemEventInvitation({ uid: MEMBER, code: CODE, expectedEventId: EVENT_ID }, deps(db));
    expect(await revokeEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db),
    )).toMatchObject({
      ok: true,
      outcome: 'revoked',
      membershipAccess: 'invitation-only',
    });
    expect(db.data(invitationPath(invitation.invitationId))).toMatchObject({ status: 'revoked', revokedBy: ADMIN });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))?.status).toBe('active');
  });

  it('deterministically rejects and charges a stale link after revoke', async () => {
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db);

    expect(await revokeEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db),
    )).toMatchObject({ ok: true, outcome: 'revoked' });
    expect(await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db),
    )).toEqual({ ok: false, reason: 'invitation-unavailable' });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))).toBeUndefined();
    expect(db.data(invitationRatePath('redeem', MEMBER))?.attemptMs).toEqual([NOW]);
  });

  it('cascades by invitation provenance and removes affected UIDs from the live admin roster', async () => {
    const cascadePolicy = policy({ grantRole: 'admin', revokeGrantedMemberships: true });
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db, { policy: cascadePolicy });
    await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { policy: cascadePolicy }),
    );
    expect(db.data(`events/${EVENT_ID}`)?.admins).toEqual([ADMIN, MEMBER]);

    expect(await revokeEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db, { policy: cascadePolicy }),
    )).toMatchObject({ ok: true, membershipAccess: 'pending-enforcement' });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))).toMatchObject({
      status: 'revoked',
      revokedAt: NOW,
      revokedBy: ADMIN,
      invitationId: invitation.invitationId,
    });
    expect(db.data(`events/${EVENT_ID}`)?.admins).toEqual([ADMIN]);
  });

  it('reports a cascaded Membership as immediately revoked only on an enforced Event', async () => {
    const cascadePolicy = policy({ revokeGrantedMemberships: true });
    const seed = baseSeed();
    seed[`events/${EVENT_ID}`] = {
      ...seed[`events/${EVENT_ID}`],
      membershipEnforcement: 'enforced',
    };
    const db = new RetryFirestore(seed);
    const invitation = await minted(db, { policy: cascadePolicy });
    await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { policy: cascadePolicy }),
    );

    expect(await revokeEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db, { policy: cascadePolicy }),
    )).toMatchObject({ ok: true, membershipAccess: 'revoked' });
    expect(db.data(membershipPath(EVENT_ID, MEMBER))?.status).toBe('revoked');
  });

  it('treats a malformed enforcement sentinel as off when reporting cascade effect', async () => {
    const cascadePolicy = policy({ revokeGrantedMemberships: true });
    const seed = baseSeed();
    seed[`events/${EVENT_ID}`] = {
      ...seed[`events/${EVENT_ID}`],
      membershipEnforcement: 'unexpected',
    };
    const db = new RetryFirestore(seed);
    const invitation = await minted(db, { policy: cascadePolicy });
    await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { policy: cascadePolicy }),
    );

    expect(await revokeEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db, { policy: cascadePolicy }),
    )).toMatchObject({ ok: true, membershipAccess: 'pending-enforcement' });
  });

  it('fails the whole cascade closed when membership provenance conflicts', async () => {
    const cascadePolicy = policy({ revokeGrantedMemberships: true });
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db, { policy: cascadePolicy });
    await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { policy: cascadePolicy }),
    );
    db.writeOutsideTransaction(membershipPath(EVENT_ID, MEMBER), {
      ...db.data(membershipPath(EVENT_ID, MEMBER)),
      invitationId: 'f'.repeat(64),
    });

    expect(await revokeEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db, { policy: cascadePolicy }),
    )).toEqual({ ok: false, reason: 'cascade-conflict' });
    expect(db.data(invitationPath(invitation.invitationId))?.status).toBe('consumed');
    expect(db.data(membershipPath(EVENT_ID, MEMBER))?.status).toBe('active');
  });

  it('refuses to mutate a shape-invalid membership during cascade', async () => {
    const cascadePolicy = policy({ revokeGrantedMemberships: true });
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db, { policy: cascadePolicy });
    await redeemEventInvitation(
      { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
      deps(db, { policy: cascadePolicy }),
    );
    const malformed = { ...db.data(membershipPath(EVENT_ID, MEMBER)) };
    delete malformed.grantedBy;
    db.writeOutsideTransaction(membershipPath(EVENT_ID, MEMBER), malformed);

    expect(await revokeEventInvitation(
      { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
      deps(db, { policy: cascadePolicy }),
    )).toEqual({ ok: false, reason: 'cascade-conflict' });
    expect(db.data(invitationPath(invitation.invitationId))?.status).toBe('consumed');
    expect(db.data(membershipPath(EVENT_ID, MEMBER))?.status).toBe('active');
  });

  it('lets revoke and redeem serialize without leaving an active grant behind', async () => {
    const cascadePolicy = policy({ revokeGrantedMemberships: true });
    const db = new RetryFirestore(baseSeed());
    const invitation = await minted(db, { policy: cascadePolicy });
    let arrivals = 0;
    let release = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.beforeCommit = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
    };

    const [redeemed, revoked] = await Promise.all([
      redeemEventInvitation(
        { uid: MEMBER, code: CODE, expectedEventId: EVENT_ID },
        deps(db, { policy: cascadePolicy }),
      ),
      revokeEventInvitation(
        { uid: ADMIN, eventId: EVENT_ID, invitationId: invitation.invitationId },
        deps(db, { policy: cascadePolicy }),
      ),
    ]);

    expect(revoked).toMatchObject({ ok: true });
    expect(redeemed.ok || redeemed.reason === 'invitation-unavailable').toBe(true);
    expect(db.data(invitationPath(invitation.invitationId))?.status).toBe('revoked');
    expect(db.data(membershipPath(EVENT_ID, MEMBER))?.status).not.toBe('active');
    expect(db.conflicts).toBeGreaterThan(0);
  });
});
