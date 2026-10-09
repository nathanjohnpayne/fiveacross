import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  uid: 'alice', generation: 1, recovered: true, event: 'event-a',
  memoryDb: { kind: 'memory' }, durableDb: { kind: 'durable' }, privateStorage: { kind: 'private-storage', app: { options: { storageBucket: 'private-bucket' } } },
  capture: vi.fn(), get: vi.fn(), set: vi.fn(), delete: vi.fn(), run: vi.fn(),
  storageDelete: vi.fn(), metadata: vi.fn(), purge: vi.fn(),
}));
vi.mock('../firebase', () => ({ db: H.durableDb, storage: { app: { options: { storageBucket: 'durable-bucket' } } }, get EVENT_ID() { return H.event; } }));
vi.mock('../privateFirestore', () => ({ capturePrivateFirestore: H.capture }));
vi.mock('./storage', () => ({ uploadProofMedia: vi.fn(), deleteStoragePath: H.storageDelete, proofMediaGeneration: H.metadata }));
vi.mock('./proofMediaCache', () => ({ purgeProofMediaFromCaches: H.purge }));
vi.mock('./proofMediaUrl', () => ({ resolveProofMediaUrl: (value: unknown) => value }));
vi.mock('./reports', () => ({ reportContent: vi.fn() }));
vi.mock('firebase/firestore', async (original) => ({
  ...(await original<typeof import('firebase/firestore')>()),
  doc: (database: unknown, ...parts: string[]) => ({ database, path: parts.join('/') }),
  collection: (database: unknown, ...parts: string[]) => ({ database, path: parts.join('/') }),
  runTransaction: H.run,
}));
import { deleteProof, deleteProofAsAdmin as moderate } from './proofs';
const snap = (data: unknown) => ({ data: () => data });
const proof = { uid: 'owner', cellIndex: 0, dayIndex: 1, contentOnly: true, storagePath: 'proofs/event-a/owner/P.jpg', mediaURL: 'media-url' };
function retire() { H.uid = 'bob'; H.generation++; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  for (const value of Object.values(H)) if (vi.isMockFunction(value)) value.mockReset();
  H.uid = 'alice'; H.generation = 1; H.recovered = true; H.event = 'event-a';
  H.capture.mockImplementation(() => {
    const uid = H.uid, generation = H.generation;
    const assertCurrent = () => {
      if (!H.recovered || uid !== H.uid || generation !== H.generation) throw new Error('Private session expired.');
    };
    assertCurrent();
    return { db: H.memoryDb, storage: H.privateStorage, uid, generation, assertCurrent,
      guard: async <T>(operation: () => Promise<T>) => { assertCurrent(); const result = await operation(); assertCurrent(); return result; } };
  });
  H.metadata.mockResolvedValue('123'); H.storageDelete.mockResolvedValue(undefined); H.purge.mockResolvedValue(undefined);
  H.get.mockImplementation(async (ref: { path: string }) => {
    if (ref.path.endsWith('/proofs/P')) return snap(proof);
    if (ref.path.includes('/boards/')) return snap({ cells: [{ index: 0, marked: true, proofId: 'P', itemId: 'prompt', markedAt: 7 }] });
    return snap({});
  });
  H.run.mockImplementation(async (_db, callback) => callback({ get: H.get, set: H.set, delete: H.delete }));
});

describe('private Admin proof moderation (#1411)', () => {
  it('uses one captured memory database for every read/write and preserves content-only credit', async () => {
    await moderate('alice', 'P', proof.storagePath, { daily: true });
    expect(H.capture).toHaveBeenCalledTimes(1);
    expect(H.run.mock.calls[0][0]).toBe(H.memoryDb);
    for (const [ref] of [...H.get.mock.calls, ...H.set.mock.calls, ...H.delete.mock.calls]) expect(ref.database).toBe(H.memoryDb);
    expect(H.set.mock.calls.some(([ref]) => ref.path.includes('/players/'))).toBe(false);
    expect(H.set.mock.calls.find(([ref]) => ref.path.includes('/boards/'))?.[1]).toMatchObject({ cells: { '0': { marked: true, markedAt: 7, proofId: null } } });
    expect(H.metadata).toHaveBeenCalledWith(proof.storagePath, H.privateStorage);
    expect(H.storageDelete).toHaveBeenCalledWith(proof.storagePath, H.privateStorage);
  });
  it('keeps ordinary credit cleanup and sibling reads on the same private database', async () => {
    H.get.mockImplementation(async (ref: { path: string }) => {
      if (ref.path.endsWith('/proofs/P')) return snap({ ...proof, contentOnly: false });
      if (ref.path.endsWith('/days/1/boards/owner')) return snap({ cells: [{ index: 0, marked: true, proofId: 'P', itemId: 'prompt', markedAt: 7 }] });
      if (ref.path.includes('/boards/')) return snap({ cells: [] });
      return snap({});
    });
    await moderate('alice', 'P', proof.storagePath, { daily: true, dayIndexes: [1, 2] });
    for (const [ref] of [...H.get.mock.calls, ...H.set.mock.calls, ...H.delete.mock.calls]) expect(ref.database).toBe(H.memoryDb);
    expect(H.get.mock.calls.some(([ref]) => ref.path.endsWith('/players/owner'))).toBe(true);
    expect(H.get.mock.calls.some(([ref]) => ref.path.endsWith('/days/2/boards/owner'))).toBe(true);
    expect(H.delete.mock.calls.some(([ref]) => ref.path.endsWith('/tally/prompt/markers/owner'))).toBe(true);
  });
  it('rejects retired post-commit media completion while preserving the local purge', async () => {
    H.storageDelete.mockImplementation(async (_path, client) => {
      retire();
      expect(client).toBe(H.privateStorage);
    });
    await expect(moderate('alice', 'P', proof.storagePath)).rejects.toThrow('expired');
    expect(H.purge).toHaveBeenCalledWith('media-url', 'https://firebasestorage.googleapis.com/v0/b/private-bucket/o/proofs%2Fevent-a%2Fowner%2FP.jpg');
  });
  it('rejects stale Admin attribution before metadata or transaction IO', async () => {
    await expect(moderate('bob', 'P', proof.storagePath)).rejects.toThrow('account changed');
    expect(H.metadata).not.toHaveBeenCalled(); expect(H.run).not.toHaveBeenCalled();
  });
  it('withholds moderation until attended recovery', async () => {
    H.recovered = false;
    await expect(moderate('alice', 'P', proof.storagePath)).rejects.toThrow('expired');
    expect(H.run).not.toHaveBeenCalled();
  });
  it('retires an action across an awaited metadata read before any private read', async () => {
    const pending = deferred<string>(); H.metadata.mockReturnValue(pending.promise);
    const action = moderate('alice', 'P', proof.storagePath);
    retire(); pending.resolve('123');
    await expect(action).rejects.toThrow('expired');
    expect(H.run).not.toHaveBeenCalled();
  });
  it('retires a returned private snapshot before a staged write', async () => {
    H.get.mockImplementationOnce(async () => { retire(); return snap({}); });
    await expect(moderate('alice', 'P')).rejects.toThrow('expired');
    expect(H.get).toHaveBeenCalledTimes(1); expect(H.set).not.toHaveBeenCalled(); expect(H.delete).not.toHaveBeenCalled();
  });
  it('fences a retried transaction before its first read', async () => {
    H.run.mockImplementation(async (_db, callback) => {
      const tx = { get: H.get, set: H.set, delete: H.delete };
      await callback(tx); H.get.mockClear(); H.set.mockClear(); H.delete.mockClear(); retire();
      return callback(tx);
    });
    await expect(moderate('alice', 'P')).rejects.toThrow('expired');
    expect(H.get).not.toHaveBeenCalled(); expect(H.delete).not.toHaveBeenCalled();
  });
  it('rejects retired SDK completion and leaves durable tombstone revocation to the server', async () => {
    H.run.mockImplementation(async (_db, callback) => { await callback({ get: H.get, set: H.set, delete: H.delete }); retire(); });
    await expect(moderate('alice', 'P', proof.storagePath)).rejects.toThrow('expired');
    expect(H.set.mock.calls.some(([ref]) => ref.path.endsWith('/proofStorageDeletes/P'))).toBe(true);
    expect(H.storageDelete).not.toHaveBeenCalled();
    expect(H.purge).toHaveBeenCalledWith('media-url', 'https://firebasestorage.googleapis.com/v0/b/private-bucket/o/proofs%2Fevent-a%2Fowner%2FP.jpg');
  });
  it('keeps the Event captured before metadata awaits', async () => {
    H.metadata.mockImplementation(async () => { H.event = 'event-b'; return '123'; });
    await moderate('alice', 'P', proof.storagePath);
    for (const [ref] of [...H.get.mock.calls, ...H.set.mock.calls, ...H.delete.mock.calls]) expect(ref.path === 'events/event-a' || ref.path.startsWith('events/event-a/')).toBe(true);
  });
  it('retains the existing owner gameplay database and credit cleanup', async () => {
    await deleteProof('P', proof.storagePath, { daily: true });
    expect(H.capture).not.toHaveBeenCalled(); expect(H.run.mock.calls[0][0]).toBe(H.durableDb);
    expect(H.storageDelete).toHaveBeenCalledWith(proof.storagePath);
  });
});
