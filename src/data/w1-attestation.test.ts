import { describe, it, expect, vi, beforeEach } from 'vitest';

// Covers specs/w1-attestation.md — the data-layer half of the 18+ attestation
// (#23). Mock ONLY the Firestore boundary so the REAL data/api functions run:
// `runTransaction` is driven to model the transactional read-then-write that makes
// `attestAdult` create-only (an existing earlier stamp is never overwritten), and
// `getDoc` the point read `readAdultAttestation` uses for the re-prompt gate.
const { docMock, runTransactionMock, getDocMock, getDocFromServerMock, getDocFromCacheMock } = vi.hoisted(() => ({
  docMock: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
  runTransactionMock: vi.fn(),
  getDocMock: vi.fn(),
  getDocFromServerMock: vi.fn(),
  getDocFromCacheMock: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  doc: docMock,
  runTransaction: runTransactionMock,
  getDoc: getDocMock,
  getDocFromServer: getDocFromServerMock,
  getDocFromCache: getDocFromCacheMock,
}));
const privateState = vi.hoisted(() => ({ uid: 'sailor-1', generation: 0, projectId: 'test-project', privateDb: {} }));
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event', auth: { get currentUser() { return { uid: privateState.uid }; } }, firebaseConfig: { get projectId() { return privateState.projectId; } } }));
vi.mock('../privateFirestore', () => ({
  awaitPrivateFirestore: vi.fn(async (uid: string, allowRecovery = false) => {
    const generation = privateState.generation;
    const assertCurrent = () => { if (uid !== privateState.uid || generation !== privateState.generation) throw new Error('Private session expired.'); };
    assertCurrent();
    return { db: privateState.privateDb, uid, assertCurrent, allowRecovery, guard: async <T,>(op: () => Promise<T>) => { assertCurrent(); const value = await op(); assertCurrent(); return value; } };
  }),
}));

import type { User } from 'firebase/auth';
import { recordOfflineAttestation, hasOfflineAttestation } from '../auth/offlineAttestationWitness';
import { awaitPrivateFirestore } from '../privateFirestore';
import { attestAdult, readAdultAttestation, readAdultAttestationFromServer, readAdultAttestationFromCache, ensureUserProfile } from './api';

type FakeTx = { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };

// A minimal Firebase User double: attestAdult reads uid and — only when it wins
// the create race on an absent row — the bootstrap identity fields
// displayName/photoURL (shared with ensureUserProfile).
const userLike = (
  over: Partial<{ uid: string; displayName: string | null; photoURL: string | null }> = {},
) => ({ uid: 'sailor-1', displayName: 'Ada', photoURL: null, ...over }) as unknown as User;

// A Firestore-snapshot double: `data === null` models a MISSING doc.
const snap = (data: Record<string, unknown> | null) => ({
  exists: () => data !== null,
  data: () => data ?? undefined,
});

// Drive runTransaction with a single attempt whose transactional read of
// users/{uid} returns `snapshot`. Returns the tx double so a test can assert set.
function driveTransaction(snapshot: ReturnType<typeof snap>): FakeTx {
  const tx: FakeTx = { get: vi.fn(async () => snapshot), set: vi.fn() };
  runTransactionMock.mockImplementation(async (_db: unknown, fn: (tx: FakeTx) => Promise<void>) => {
    await fn(tx);
  });
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  privateState.uid = 'sailor-1';
  privateState.generation = 0;
  privateState.projectId = 'test-project';
  localStorage.clear();
});

describe('attestAdult persists the 18+ self-attestation create-only (#23)', () => {
  it('merges ONLY the stamp on a profile that already exists without one', async () => {
    const tx = driveTransaction(snap({ displayName: 'Ada', createdAt: 1 }));
    await attestAdult(userLike(), 1_720_000_000_000);
    expect(tx.set).toHaveBeenCalledTimes(1);
    expect(tx.set).toHaveBeenCalledWith(
      { path: 'users/sailor-1' },
      { attestedAdultAt: 1_720_000_000_000 },
      { merge: true }, // present row: never clobber displayName/photoURL/createdAt
    );
  });

  it('writes a COMPLETE profile (bootstrap + stamp) when it wins the create race on an absent row', async () => {
    // First-sign-in race (Codex P2, PR #112): the attestation transaction reaches
    // an absent users/{uid} before ensureUserProfile. A stamp-only write here would
    // strand the profile — the create-only bootstrap retry sees exists() and no-ops,
    // leaving displayName/photoURL/createdAt missing forever. So it writes the FULL
    // bootstrap shape ensureUserProfile would have, plus the stamp, in one create.
    const tx = driveTransaction(snap(null));
    await attestAdult(userLike({ displayName: 'Ada', photoURL: 'https://lh3.googleusercontent.com/ada/pic.jpg' }), 42);
    expect(tx.set).toHaveBeenCalledWith(
      { path: 'users/sailor-1' },
      { displayName: 'Ada', photoURL: 'https://lh3.googleusercontent.com/ada/pic.jpg', createdAt: 42, attestedAdultAt: 42 },
    );
  });

  it('never overwrites an existing EARLIER attestation', async () => {
    const tx = driveTransaction(snap({ attestedAdultAt: 111, displayName: 'Ada' }));
    await attestAdult(userLike(), 999);
    expect(tx.set).not.toHaveBeenCalled(); // the first stamp (111) survives
  });

  it('defaults the stamp to now when no explicit time is passed', async () => {
    const tx = driveTransaction(snap(null));
    const before = Date.now();
    await attestAdult(userLike());
    const after = Date.now();
    const payload = tx.set.mock.calls[0][1] as { attestedAdultAt: number };
    expect(payload.attestedAdultAt).toBeGreaterThanOrEqual(before);
    expect(payload.attestedAdultAt).toBeLessThanOrEqual(after);
  });
});

describe('readAdultAttestation reports the settled attestation for the gate (#23)', () => {
  it('returns the stamp when present', async () => {
    getDocMock.mockResolvedValue(snap({ attestedAdultAt: 555 }));
    await expect(readAdultAttestation('sailor-1')).resolves.toBe(555);
  });

  it('returns null when the field is absent', async () => {
    getDocMock.mockResolvedValue(snap({ displayName: 'Ada' }));
    await expect(readAdultAttestation('sailor-1')).resolves.toBeNull();
  });

  it('returns null when the profile row is missing', async () => {
    getDocMock.mockResolvedValue(snap(null));
    await expect(readAdultAttestation('sailor-1')).resolves.toBeNull();
  });
});

describe('readAdultAttestationFromServer is the SERVER-ONLY authority read (#117 r6)', () => {
  it('reads via getDocFromServer (never the cache-capable getDoc)', async () => {
    getDocFromServerMock.mockResolvedValue(snap({ attestedAdultAt: 777 }));
    await expect(readAdultAttestationFromServer('sailor-1')).resolves.toBe(777);
    // The authority read must NOT go through the cache-capable getDoc.
    expect(getDocFromServerMock).toHaveBeenCalledTimes(1);
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('returns null for a server row without the stamp (definitive)', async () => {
    getDocFromServerMock.mockResolvedValue(snap({ displayName: 'Ada' }));
    await expect(readAdultAttestationFromServer('sailor-1')).resolves.toBeNull();
  });

  it('REJECTS when the server is unreachable (never falls back to cache)', async () => {
    getDocFromServerMock.mockRejectedValue(new Error('Failed to reach server'));
    await expect(readAdultAttestationFromServer('sailor-1')).rejects.toThrow(/server/i);
  });
});


describe('private profile ownership and minimal offline witness (#1411)', () => {
  it('uses memory Firestore for bootstrap and server reads, including recovery bootstrap', async () => {
    driveTransaction(snap(null));
    await ensureUserProfile(userLike());
    expect(awaitPrivateFirestore).toHaveBeenCalledWith('sailor-1', true);
    expect(runTransactionMock.mock.calls[0][0]).toBe(privateState.privateDb);
    expect(docMock.mock.calls[0][0]).toBe(privateState.privateDb);
    getDocFromServerMock.mockResolvedValue(snap({ attestedAdultAt: 44 }));
    await readAdultAttestationFromServer('sailor-1');
    expect(hasOfflineAttestation('test-project', 'sailor-1')).toBe(true);
  });

  it('rejects another UID before acquiring any private session', async () => {
    privateState.uid = 'bob';
    await expect(ensureUserProfile(userLike())).rejects.toThrow(/account changed/i);
    expect(awaitPrivateFirestore).not.toHaveBeenCalled();
    expect(runTransactionMock).not.toHaveBeenCalled();
  });

  it('retired transaction read cannot write or record an offline witness', async () => {
    const tx = driveTransaction(snap(null));
    tx.get.mockImplementation(async () => { privateState.generation++; return snap(null); });
    await expect(attestAdult(userLike())).rejects.toThrow(/expired/i);
    expect(tx.set).not.toHaveBeenCalled();
    expect(hasOfflineAttestation('test-project', 'sailor-1')).toBe(false);
  });

  it('definitive server revocation removes the witness; a failed server read does not', async () => {
    recordOfflineAttestation('test-project', 'sailor-1', true);
    getDocFromServerMock.mockRejectedValueOnce(new Error('offline'));
    await expect(readAdultAttestationFromServer('sailor-1')).rejects.toThrow('offline');
    expect(hasOfflineAttestation('test-project', 'sailor-1')).toBe(true);
    getDocFromServerMock.mockResolvedValue(snap(null));
    await expect(readAdultAttestationFromServer('sailor-1')).resolves.toBeNull();
    expect(hasOfflineAttestation('test-project', 'sailor-1')).toBe(false);
  });

  it('requires both the current UID/project witness and an existing cached Board', async () => {
    recordOfflineAttestation('test-project', 'sailor-1', true);
    getDocFromCacheMock.mockRejectedValueOnce(new Error('cache miss'));
    await expect(readAdultAttestationFromCache('sailor-1')).resolves.toBeNull();
    getDocFromCacheMock.mockResolvedValue(snap({ uid: 'sailor-1' }));
    await expect(readAdultAttestationFromCache('sailor-1')).resolves.toBe(1);
    expect(docMock.mock.calls.filter((call) => call.slice(1).join('/').startsWith('users/'))).toHaveLength(0);
    privateState.projectId = 'other-project';
    await expect(readAdultAttestationFromCache('sailor-1')).resolves.toBeNull();
    privateState.uid = 'bob';
    await expect(readAdultAttestationFromCache('sailor-1')).rejects.toThrow(/account changed/i);
  });

  it('does not grant an old UID witness after an account switch during the Board probe', async () => {
    recordOfflineAttestation('test-project', 'sailor-1', true);
    getDocFromCacheMock.mockImplementation(async () => { privateState.uid = 'bob'; return snap({ uid: 'sailor-1' }); });
    await expect(readAdultAttestationFromCache('sailor-1')).rejects.toThrow(/account changed/i);
  });
});
