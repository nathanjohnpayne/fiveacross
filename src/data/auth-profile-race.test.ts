import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { User } from 'firebase/auth';

// Covers specs/auth-profile-race.md — the ensureUserProfile create path. Mock
// only the Firestore boundary so the REAL ensureUserProfile (data/api.ts) runs;
// `runTransaction` is driven to model the transactional read + Firestore's
// optimistic-concurrency retry, the two mechanisms that make the create
// create-only and unable to clobber a racing user save (#77).
const { docMock, runTransactionMock } = vi.hoisted(() => ({
  docMock: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
  runTransactionMock: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({ doc: docMock, runTransaction: runTransactionMock }));
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));

import { ensureUserProfile } from './api';

type FakeTx = { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };

// `runTransaction` invokes the update function once per attempt and RE-RUNS it
// when the commit's read set is stale (a racing write to a doc this attempt
// read). `existsSequence` supplies, per attempt, what the transactional read of
// users/{uid} observes — so `[false, true]` models "the create read the row
// absent, a user save then wrote it, and Firestore retried onto the saved row".
// Returns the per-attempt tx doubles so a test can assert whether `set` fired.
function driveTransaction(existsSequence: boolean[]): FakeTx[] {
  const txs: FakeTx[] = [];
  runTransactionMock.mockImplementation(
    async (_db: unknown, updateFn: (tx: FakeTx) => Promise<void>) => {
      for (const exists of existsSequence) {
        const tx: FakeTx = {
          get: vi.fn(async () => ({ exists: () => exists })),
          set: vi.fn(),
        };
        txs.push(tx);
        await updateFn(tx);
      }
    },
  );
  return txs;
}

const userFrom = (
  over: Partial<{ uid: string; displayName: string | null; photoURL: string | null }> = {},
) =>
  ({ uid: 'sailor-1', displayName: 'Sailor', photoURL: 'https://lh3.googleusercontent.com/sailor/pic.jpg', ...over }) as unknown as User;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureUserProfile create is exists-checked (#77 — never clobbers a racing save)', () => {
  it('no-ops when the profile row already exists — a racing save is never clobbered', async () => {
    const txs = driveTransaction([true]);
    await ensureUserProfile(userFrom());
    expect(txs).toHaveLength(1);
    expect(txs[0].get).toHaveBeenCalledTimes(1);
    expect(txs[0].set).not.toHaveBeenCalled();
  });

  it('creates the row from the Google-sourced defaults when it is absent', async () => {
    const txs = driveTransaction([false]);
    await ensureUserProfile(userFrom());
    expect(txs[0].set).toHaveBeenCalledTimes(1);
    expect(txs[0].set).toHaveBeenCalledWith(
      { path: 'users/sailor-1' },
      { displayName: 'Sailor', photoURL: 'https://lh3.googleusercontent.com/sailor/pic.jpg', createdAt: expect.any(Number) },
    );
  });

  it('defaults a missing displayName to Anonymous and a missing photo to null', async () => {
    const txs = driveTransaction([false]);
    await ensureUserProfile(userFrom({ displayName: null, photoURL: null }));
    expect(txs[0].set).toHaveBeenCalledWith(
      { path: 'users/sailor-1' },
      { displayName: 'Anonymous', photoURL: null, createdAt: expect.any(Number) },
    );
  });

  it('no-ops on the optimistic-concurrency retry after a save lands mid-transaction', async () => {
    // Attempt 1 read the row absent (so it tried to create); a user save then
    // wrote users/{uid}, making the commit's read stale, so Firestore re-runs
    // the function. Attempt 2 (the retry) reads the now-existing row and must
    // no-op — the committed outcome leaves the saved row intact.
    const txs = driveTransaction([false, true]);
    await ensureUserProfile(userFrom());
    expect(txs).toHaveLength(2);
    expect(txs[0].set).toHaveBeenCalledTimes(1); // the discarded first attempt
    expect(txs[1].set).not.toHaveBeenCalled(); // the retry sees the save and no-ops
  });
});
