import { describe, it, expect, vi, beforeEach } from 'vitest';

// specs/w2-ban-console.md, data layer. Two pins:
//   1. isBanned — the pure, fail-open ban predicate shared by every PUBLIC surface.
//   2. banUser / unbanUser — the admin writes MUST be arrayUnion/arrayRemove PARTIAL
//      updates on events/{EVENT_ID}.bannedUids, so a ban never clobbers other event
//      config and never touches owner-only users/{uid}. Consumes the #113 rules +
//      type contract (validated in tests/rules/w2-banned-uids.test.ts); here we
//      assert the WRITE SHAPE the rules accept.

const H = vi.hoisted(() => ({
  updateDoc: vi.fn(),
  arrayUnion: vi.fn((...a: unknown[]) => ({ __arrayUnion: a })),
  arrayRemove: vi.fn((...a: unknown[]) => ({ __arrayRemove: a })),
}));

// This closed Admin fixture supplies a recovered, current memory-session seam;
// actor retirement and distinct database binding are tested in private-admin-session.test.ts.
vi.mock('../privateFirestore', async () => {
  const { db } = await import('../firebase');
  return { capturePrivateFirestore: () => ({
    db, functions: {}, uid: 'admin-1', generation: 1, assertCurrent: () => {},
    guard: async <T,>(operation: () => Promise<T>) => operation(),
  }) };
});
vi.mock('../firebase', () => ({ db: { app: 'db' }, EVENT_ID: 'test-event' }));
vi.mock('firebase/firestore', () => ({
  doc: (...args: unknown[]) => ({ kind: 'doc', args }),
  updateDoc: (...a: unknown[]) => H.updateDoc(...a),
  deleteDoc: vi.fn(),
  runTransaction: vi.fn(),
  arrayUnion: (...a: unknown[]) => H.arrayUnion(...a),
  arrayRemove: (...a: unknown[]) => H.arrayRemove(...a),
}));

import { banUser, unbanUser } from './admin';
import { isBanned, isSystemAuthor, SYSTEM_AUTHOR_UIDS } from './moderation';

beforeEach(() => {
  H.updateDoc.mockReset();
  H.arrayUnion.mockClear();
  H.arrayRemove.mockClear();
});

describe('isBanned — the presentational ban predicate (specs/w2-ban-console.md)', () => {
  it('is true only when the uid is on the roster', () => {
    expect(isBanned('bob', ['bob'])).toBe(true);
    expect(isBanned('bob', ['alice', 'bob', 'carol'])).toBe(true);
    expect(isBanned('bob', ['alice'])).toBe(false);
  });

  it('fails OPEN on an empty, missing, or malformed roster — filters nothing', () => {
    // Mirrors isReportHidden's fail-open: a fresh event (converter default []),
    // a still-loading event doc, or an unexpected non-array must hide no one.
    expect(isBanned('bob', [])).toBe(false);
    expect(isBanned('bob', undefined)).toBe(false);
    // A non-array (defensive — the converter coerces, but the predicate is the
    // last line of defence) filters nothing rather than throwing.
    expect(isBanned('bob', 'bob' as unknown as string[])).toBe(false);
  });

  it('is false for an absent owner uid — un-owned content is never "banned"', () => {
    expect(isBanned(undefined, ['bob'])).toBe(false);
    expect(isBanned(null, ['bob'])).toBe(false);
    expect(isBanned('', ['bob'])).toBe(false);
  });
});

describe('banUser / unbanUser — arrayUnion/arrayRemove on the EVENT doc (specs/w2-ban-console.md)', () => {
  it('banUser adds the uid via arrayUnion on events/{EVENT_ID}.bannedUids', () => {
    banUser('bob-uid');

    expect(H.arrayUnion).toHaveBeenCalledWith('bob-uid');
    expect(H.arrayRemove).not.toHaveBeenCalled();
    expect(H.updateDoc).toHaveBeenCalledTimes(1);

    const [ref, payload] = H.updateDoc.mock.calls[0] as [{ args: unknown[] }, Record<string, unknown>];
    // The write targets the EVENT doc — events/{EVENT_ID} — NOT owner-only
    // users/{uid} and NOT a subcollection (exactly 3 path segments).
    expect(ref.args.slice(1)).toEqual(['events', 'test-event']);
    // The payload is a PARTIAL update touching ONLY bannedUids (arrayUnion), so it
    // never clobbers claimMode/defaultTheme/settings/admins — the rules validate
    // the resulting field state and accept this shape.
    expect(Object.keys(payload)).toEqual(['bannedUids']);
    expect(payload.bannedUids).toEqual({ __arrayUnion: ['bob-uid'] });
  });

  it('unbanUser removes the uid via arrayRemove on events/{EVENT_ID}.bannedUids', () => {
    unbanUser('bob-uid');

    expect(H.arrayRemove).toHaveBeenCalledWith('bob-uid');
    expect(H.arrayUnion).not.toHaveBeenCalled();
    expect(H.updateDoc).toHaveBeenCalledTimes(1);

    const [ref, payload] = H.updateDoc.mock.calls[0] as [{ args: unknown[] }, Record<string, unknown>];
    expect(ref.args.slice(1)).toEqual(['events', 'test-event']);
    expect(Object.keys(payload)).toEqual(['bannedUids']);
    expect(payload.bannedUids).toEqual({ __arrayRemove: ['bob-uid'] });
  });
});

describe('system/sentinel author guard (Codex P1, PR #122)', () => {
  it('isSystemAuthor flags the seed sentinel and only real system authors', () => {
    // 'seed' is the createdBy on every seeded default Prompt (scripts/seed.mjs).
    expect(SYSTEM_AUTHOR_UIDS).toContain('seed');
    expect(isSystemAuthor('seed')).toBe(true);
    expect(isSystemAuthor('a-real-player-uid')).toBe(false);
    expect(isSystemAuthor(undefined)).toBe(false);
    expect(isSystemAuthor(null)).toBe(false);
    expect(isSystemAuthor('')).toBe(false);
  });

  it('banUser REFUSES a sentinel — no write reaches bannedUids (the pool cannot be nuked)', async () => {
    // Banning 'seed' would hide the ENTIRE default pool from useItems AND the deal
    // path. banUser must no-op: no updateDoc, no arrayUnion — 'seed' never enters
    // bannedUids even via a programmatic/leaked call.
    await banUser('seed');
    expect(H.updateDoc).not.toHaveBeenCalled();
    expect(H.arrayUnion).not.toHaveBeenCalled();
  });

  it('unbanUser STILL removes a sentinel — the recovery path is not gated', () => {
    // The asymmetry: banUser refuses to ADD a sentinel, but unbanUser removes ANY
    // uid — so an admin who banned 'seed' on a pre-fix build can recover the pool.
    unbanUser('seed');
    expect(H.arrayRemove).toHaveBeenCalledWith('seed');
    expect(H.updateDoc).toHaveBeenCalledTimes(1);
    const [, payload] = H.updateDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.bannedUids).toEqual({ __arrayRemove: ['seed'] });
  });
});
