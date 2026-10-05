import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpsCallable } from 'firebase/functions';

const H = vi.hoisted(() => ({
  uid: 'alice', generation: 1, recovered: true, online: true, eventId: 'event-a', callableEvent: null as string | null,
  privateDb: { kind: 'private-memory' }, defaultDb: { kind: 'durable-gameplay' },
  privateFunctions: { kind: 'private-functions' }, defaultFunctions: { kind: 'default-functions' },
  get: vi.fn(), update: vi.fn(), set: vi.fn(), delete: vi.fn(),
  getDoc: vi.fn(), getDocs: vi.fn(), updateDoc: vi.fn(), addDoc: vi.fn(), deleteDoc: vi.fn(),
  runTransaction: vi.fn(), callable: vi.fn(), capture: vi.fn(),
}));
vi.mock('../firebase', () => ({
  get EVENT_ID() { return H.eventId; }, db: H.defaultDb, functions: H.defaultFunctions,
}));
vi.mock('../privateFirestore', () => ({ capturePrivateFirestore: H.capture }));
vi.mock('./paths', () => ({
  playersCol: (event: string, database: unknown) => ({ database, path: `events/${event}/players` }),
  dayMetaRef: (day: number, event: string, database: unknown) => ({ database, path: `events/${event}/days/${day}/meta/${day}` }),
}));
vi.mock('firebase/functions', () => ({
  httpsCallable: vi.fn((functions: unknown) => {
    if (functions !== H.privateFunctions && functions !== H.defaultFunctions) throw new Error('unexpected callable client');
    if (H.callableEvent) H.eventId = H.callableEvent;
    return H.callable;
  }),
}));
vi.mock('firebase/firestore', async (original) => ({
  ...(await original<typeof import('firebase/firestore')>()),
  doc: (database: unknown, ...path: string[]) => ({ database, path: path.join('/') }),
  collection: (database: unknown, ...path: string[]) => ({ database, path: path.join('/') }),
  query: (ref: unknown, ...constraints: unknown[]) => ({ ref, constraints }),
  where: (...args: unknown[]) => ({ kind: 'where', args }),
  limit: (count: number) => ({ kind: 'limit', count }),
  getDoc: H.getDoc, getDocFromServer: H.getDoc, getDocs: H.getDocs, getDocsFromServer: H.getDocs,
  updateDoc: H.updateDoc, addDoc: H.addDoc, deleteDoc: H.deleteDoc, runTransaction: H.runTransaction,
}));
import { approveItems, archiveEvent, hideItem, restoreItem, deleteItem, rejectItem, restoreProof, hideProof, clearItemReports, clearProofReports, setClaimMode, setEventTheme, setPhotoProofSource, setStripPhotoExif, setVisionGate, setReportHideThreshold, setForceAdult, setEasyMixRatio, setItemSpicy, setDayTheme, setDayTonight, banUser, unbanUser, unlockDayNow, resnapshotDayNow } from './admin';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const snapshot = (data: Record<string, unknown>) => ({ exists: () => true, data: () => data });
function retire() { H.uid = 'bob'; H.generation += 1; }

beforeEach(() => {
  for (const value of Object.values(H)) {
    if (vi.isMockFunction(value)) value.mockReset();
  }
  vi.mocked(httpsCallable).mockClear();
  H.update.mockImplementation(() => undefined);
  H.set.mockImplementation(() => undefined);
  H.delete.mockImplementation(() => undefined);
  H.uid = 'alice'; H.generation = 1; H.recovered = true; H.online = true; H.eventId = 'event-a'; H.callableEvent = null;
  H.capture.mockImplementation(() => {
    const uid = H.uid, generation = H.generation;
    const assertCurrent = () => {
      if (!H.recovered || !H.online || uid !== H.uid || generation !== H.generation) throw new Error('Private session expired.');
    };
    assertCurrent();
    return {
      db: H.privateDb, functions: H.privateFunctions, uid, generation, assertCurrent,
      guard: async <T>(operation: () => Promise<T>) => { assertCurrent(); const value = await operation(); assertCurrent(); return value; },
    };
  });
  H.get.mockResolvedValue(snapshot({ status: 'pending', pool: 'main' }));
  H.getDoc.mockResolvedValue(snapshot({ uid: 'owner' }));
  H.getDocs.mockResolvedValue({ docs: [] });
  H.updateDoc.mockResolvedValue(undefined); H.addDoc.mockResolvedValue(undefined); H.deleteDoc.mockResolvedValue(undefined);
  H.callable.mockResolvedValue({ data: { placements: [] } });
  H.runTransaction.mockImplementation(async (_db, callback) => callback({
    get: H.get, update: H.update, set: H.set, delete: H.delete,
  }));
});

describe('approveItems empty-input no-op (#1688)', () => {
  const unavailableStates = [
    { name: 'offline', arrange: () => { H.online = false; }, error: 'Private session' },
    { name: 'recovery quarantine', arrange: () => { H.recovered = false; }, error: 'Private session' },
    { name: 'same-account Auth rotation', arrange: () => {
      H.generation += 1;
      H.capture.mockImplementation(() => { throw new Error('Private session expired.'); });
    }, error: 'Private session' },
    { name: 'account rotation', arrange: retire, error: 'Admin account changed' },
  ];

  it.each(unavailableStates)('returns [] without private capture or IO during $name', async ({ arrange }) => {
    arrange();
    await expect(approveItems([], 'alice')).resolves.toEqual([]);
    expect(H.capture).not.toHaveBeenCalled();
    expect(httpsCallable).not.toHaveBeenCalled();
    expect(H.callable).not.toHaveBeenCalled();
    expect(H.runTransaction).not.toHaveBeenCalled();
    expect(H.updateDoc).not.toHaveBeenCalled();
  });

  it.each(unavailableStates)('still refuses nonempty input during $name', async ({ arrange, error }) => {
    arrange();
    await expect(approveItems([{ id: 'prompt' }], 'alice')).rejects.toThrow(error);
    expect(H.capture).toHaveBeenCalledOnce();
    expect(httpsCallable).not.toHaveBeenCalled();
    expect(H.callable).not.toHaveBeenCalled();
  });

  it('keeps nonempty approval on the captured private client and Event', async () => {
    H.callableEvent = 'event-b';
    const placements = [{ itemId: 'prompt', dayIndex: null, retained: false, outcome: 'untargeted' }];
    H.callable.mockResolvedValue({ data: { placements } });
    await expect(approveItems([{ id: 'prompt' }], 'alice')).resolves.toEqual(placements);
    expect(H.capture).toHaveBeenCalledOnce();
    expect(httpsCallable).toHaveBeenCalledWith(H.privateFunctions, 'approvePrompts');
    expect(H.callable).toHaveBeenCalledWith({ eventId: 'event-a', items: [{ id: 'prompt' }] });
  });
});

describe('Admin actions own a private Auth incarnation (#1411)', () => {
  it('binds direct writes to the memory database and captured Event', async () => {
    await hideItem('prompt');
    expect(H.updateDoc).toHaveBeenCalledWith({ database: H.privateDb, path: 'events/event-a/items/prompt' }, { status: 'hidden' });
    expect(H.capture).toHaveBeenCalledTimes(1);
  });
  it('refuses supplied Admin attribution from another account before a write', async () => {
    await expect(Promise.resolve().then(() => rejectItem('prompt', 'bob'))).rejects.toThrow('account changed');
    expect(H.updateDoc).not.toHaveBeenCalled();
  });
  it('refuses private writes until attended recovery is complete', async () => {
    H.recovered = false;
    await expect(Promise.resolve().then(() => hideItem('prompt'))).rejects.toThrow('Private session');
    expect(H.updateDoc).not.toHaveBeenCalled();
  });
  it('rejects a direct-write completion after the captured incarnation retires', async () => {
    const ack = deferred<void>(); H.updateDoc.mockReturnValue(ack.promise);
    const operation = hideItem('prompt'); retire(); ack.resolve();
    await expect(operation).rejects.toThrow('Private session');
    expect(H.capture).toHaveBeenCalledTimes(1);
  });
  it('rejects after a transaction read without staging a write as the next account', async () => {
    const read = deferred<ReturnType<typeof snapshot>>(); H.get.mockReturnValue(read.promise);
    const operation = setItemSpicy('prompt', true); retire(); read.resolve(snapshot({ status: 'pending', pool: 'main' }));
    await expect(operation).rejects.toThrow('Private session');
    expect(H.update).not.toHaveBeenCalled();
    expect(H.runTransaction.mock.calls[0][0]).toBe(H.privateDb);
  });
  it('fences SDK callback retries before another account can read', async () => {
    H.runTransaction.mockImplementation(async (_db, callback) => {
      const tx = { get: H.get, update: H.update, set: H.set, delete: H.delete };
      await callback(tx); retire(); return callback(tx);
    });
    await expect(setItemSpicy('prompt', true)).rejects.toThrow('Private session');
    expect(H.get).toHaveBeenCalledTimes(1);
    expect(H.update).toHaveBeenCalledTimes(1);
  });
  it('keeps the Event fixed across a transaction read', async () => {
    H.get.mockImplementation(async () => { H.eventId = 'event-b'; return snapshot({ status: 'pending', pool: 'main' }); });
    await setItemSpicy('prompt', true);
    expect(H.update.mock.calls[0][0]).toEqual({ database: H.privateDb, path: 'events/event-a/items/prompt' });
  });
  it('fences the actual staged write even when an accessor retires the session', async () => {
    H.get.mockResolvedValue({ exists: () => true, data: () => { retire(); return { status: 'pending', pool: 'main' }; } });
    await expect(setItemSpicy('prompt', true)).rejects.toThrow('Private session');
    expect(H.update).not.toHaveBeenCalled();
  });
  it('fences transaction completion separately from already staged operations', async () => {
    const commit = deferred<void>();
    H.runTransaction.mockImplementation(async (_db, callback) => {
      const value = await callback({ get: H.get, update: H.update, set: H.set, delete: H.delete });
      await commit.promise; return value;
    });
    const operation = setItemSpicy('prompt', true);
    await vi.waitFor(() => expect(H.update).toHaveBeenCalledTimes(1));
    retire(); commit.resolve();
    await expect(operation).rejects.toThrow('Private session');
  });
  it('keeps restore lookup and transaction on one captured action', async () => {
    const lookup = deferred<ReturnType<typeof snapshot>>(); H.getDoc.mockReturnValue(lookup.promise);
    const operation = restoreProof('proof'); retire(); lookup.resolve(snapshot({ uid: 'owner' }));
    await expect(operation).rejects.toThrow('Private session');
    expect(H.getDocs).not.toHaveBeenCalled(); expect(H.runTransaction).not.toHaveBeenCalled();
    expect(H.capture).toHaveBeenCalledTimes(1);
  });
  it('keeps stale restore-page retries on the original lease', async () => {
    H.getDoc.mockResolvedValueOnce(snapshot({ uid: 'owner' })).mockImplementationOnce(async () => {
      retire(); return snapshot({ uid: 'owner' });
    });
    H.getDocs.mockResolvedValue({ docs: Array.from({ length: 6 }, (_, i) => ({ id: `claim-${i}` })) });
    H.get.mockImplementation(async (ref: { path: string }) => ref.path.includes('/proofs/')
      ? snapshot({ uid: 'owner' })
      : snapshot({ uid: 'owner', proofId: 'proof', status: 'confirmed' }));
    await expect(restoreProof('proof')).rejects.toThrow('Private session');
    expect(H.capture).toHaveBeenCalledTimes(1);
    expect(H.getDoc).toHaveBeenCalledTimes(2);
    expect(H.getDocs).toHaveBeenCalledTimes(1);
    expect(H.runTransaction).toHaveBeenCalledTimes(1);
    expect(H.update).not.toHaveBeenCalled();
  });
  it('preserves the SDK method receiver when staging a transaction write', async () => {
    const tx = { get: H.get, update: H.update, set: H.set, delete: H.delete };
    H.update.mockImplementation(function (this: unknown) {
      expect(this).toBe(tx); return tx;
    });
    H.runTransaction.mockImplementation(async (_db, callback) => callback(tx));
    await setItemSpicy('prompt', true);
    expect(H.update).toHaveBeenCalledTimes(1);
  });
  it.each([
    { name: 'unlock', call: unlockDayNow, resnapshot: false },
    { name: 'resnapshot', call: resnapshotDayNow, resnapshot: true },
  ])('keeps the captured Event in the $name callable payload', async ({ call, resnapshot }) => {
    H.callableEvent = 'event-b';
    H.callable.mockResolvedValue({ data: { result: 'unlocked' } });
    await call(2);
    expect(H.callable).toHaveBeenCalledWith({ eventId: 'event-a', dayIndex: 2,
      ...(resnapshot ? { resnapshot: true } : {}),
    });
    expect(H.capture).toHaveBeenCalledTimes(1);
  });
  it('binds callables to the private app and rejects retired completion', async () => {
    const response = deferred<{ data: { placements: Array<{ itemId: string; dayIndex: null; retained: false; outcome: string }> } }>();
    H.callable.mockReturnValue(response.promise);
    const operation = approveItems([{ id: 'prompt' }], 'alice');
    retire(); response.resolve({ data: { placements: [{ itemId: 'prompt', dayIndex: null, retained: false, outcome: 'untargeted' }] } });
    await expect(operation).rejects.toThrow('Private session');
    expect(H.capture).toHaveBeenCalledTimes(1);
  });
  it('preserves the ordinary schedule write with a current lease', async () => {
    H.get.mockResolvedValue(snapshot({ days: [{ index: 0, theme: 'classic' }] }));
    await setDayTheme([], 0, 'welcome-aboard');
    expect(H.update).toHaveBeenCalledWith({ database: H.privateDb, path: 'events/event-a' }, { days: [{ index: 0, theme: 'welcome-aboard' }] });
  });
});


// Invoke actual exported writers through their public Promise.catch contract,
// without deferring capture behind Promise.resolve().then in the test.
const plainWriters = [
  ['hideItem', () => hideItem('prompt')], ['restoreItem', () => restoreItem('prompt')],
  ['deleteItem', () => deleteItem('prompt')], ['rejectItem', () => rejectItem('prompt', 'alice')],
  ['hideProof', () => hideProof('proof')],
  ['clearItemReports', () => clearItemReports('prompt')], ['clearProofReports', () => clearProofReports('proof')],
  ['setClaimMode', () => setClaimMode('honor')], ['setEventTheme', () => setEventTheme('welcome-aboard')],
  ['setPhotoProofSource', () => setPhotoProofSource('camera_only')], ['setStripPhotoExif', () => setStripPhotoExif(true)],
  ['setVisionGate', () => setVisionGate(true)], ['setReportHideThreshold', () => setReportHideThreshold(3)],
  ['setForceAdult', () => setForceAdult(true)], ['setEasyMixRatio', () => setEasyMixRatio(0.5)],
  ['setDayTheme', () => setDayTheme([], 0, 'welcome-aboard')], ['setDayTonight', () => setDayTonight([], 0, [])],
  ['banUser', () => banUser('other')], ['unbanUser', () => unbanUser('other')],
] as const;

describe('Admin writer Promise rejection contract (#1411)', () => {
  it.each(plainWriters)('%s lets a direct catch handler observe unrecovered capture without a synchronous throw', async (_name, call) => {
    H.recovered = false;
    const report = vi.fn();
    let handled!: Promise<void | undefined>;
    expect(() => { handled = call().catch(report); }).not.toThrow();
    await handled;
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][0]).toEqual(expect.objectContaining({ message: 'Private session expired.' }));
    expect(H.capture).toHaveBeenCalledOnce();
    expect(H.updateDoc).not.toHaveBeenCalled(); expect(H.deleteDoc).not.toHaveBeenCalled();
    expect(H.runTransaction).not.toHaveBeenCalled(); expect(H.callable).not.toHaveBeenCalled();
  });
  it('also returns a rejected Promise when an offline settings capture is refused', async () => {
    H.online = false;
    const report = vi.fn();
    let handled!: Promise<void | undefined>;
    expect(() => { handled = setReportHideThreshold(4).catch(report); }).not.toThrow();
    await handled;
    expect(report).toHaveBeenCalledOnce(); expect(H.updateDoc).not.toHaveBeenCalled();
  });
});

const closingEvent = () => ({ status: 'active', archiving: true, archiveToken: 1, claimMode: 'honor', days: [], name: 'Test Event', bannedUids: [] });
describe('archiveEvent preserves known no-write refusals across private retirement (#1411)', () => {
  beforeEach(() => {
    H.getDoc.mockResolvedValue(snapshot(closingEvent()));
    H.get.mockResolvedValue(snapshot(closingEvent()));
  });
  it('returns a typed refusal when capture is already unavailable, before any IO', async () => {
    H.online = false;
    await expect(archiveEvent(1)).resolves.toBe('read-failed:event');
    expect(H.getDoc).not.toHaveBeenCalled(); expect(H.runTransaction).not.toHaveBeenCalled();
    expect(H.capture).toHaveBeenCalledOnce();
  });
  it('preserves a pre-read refusal after the read retires its captured actor', async () => {
    const read = deferred<ReturnType<typeof snapshot>>(); H.getDoc.mockReturnValue(read.promise);
    const freezing = archiveEvent(1); retire(); read.resolve(snapshot(closingEvent()));
    await expect(freezing).resolves.toBe('read-failed:event');
    expect(H.getDocs).not.toHaveBeenCalled(); expect(H.runTransaction).not.toHaveBeenCalled();
    expect(H.capture).toHaveBeenCalledOnce(); expect(H.update).not.toHaveBeenCalled();
  });
  it('preserves the queue-stage refusal without another actor read or cleanup mutation', async () => {
    const read = deferred<{ docs: [] }>(); H.getDocs.mockReturnValue(read.promise);
    const freezing = archiveEvent(1);
    await vi.waitFor(() => expect(H.getDocs).toHaveBeenCalledOnce());
    retire(); read.resolve({ docs: [] });
    await expect(freezing).resolves.toBe('read-failed:claims');
    expect(H.getDoc).toHaveBeenCalledOnce(); expect(H.runTransaction).not.toHaveBeenCalled();
    expect(H.capture).toHaveBeenCalledOnce(); expect(H.update).not.toHaveBeenCalled();
  });
  it('returns a no-write refusal if retirement precedes the SDK transaction callback', async () => {
    H.runTransaction.mockImplementation(async (_db, callback) => {
      retire(); return callback({ get: H.get, update: H.update, set: H.set, delete: H.delete });
    });
    await expect(archiveEvent(1)).resolves.toBe('read-failed:event');
    expect(H.get).not.toHaveBeenCalled(); expect(H.update).not.toHaveBeenCalled(); expect(H.capture).toHaveBeenCalledOnce();
  });
  it('keeps a known quiesce-changed refusal when its read-only transaction acknowledgement retires', async () => {
    H.get.mockResolvedValue(snapshot({ ...closingEvent(), archiveToken: 2 }));
    const ack = deferred<void>(); const completed = deferred<void>();
    H.runTransaction.mockImplementation(async (_db, callback) => {
      const result = await callback({ get: H.get, update: H.update, set: H.set, delete: H.delete });
      completed.resolve(); await ack.promise; return result;
    });
    const freezing = archiveEvent(1); await completed.promise; retire(); ack.resolve();
    await expect(freezing).resolves.toBe('quiesce-changed');
    expect(H.update).not.toHaveBeenCalled(); expect(H.capture).toHaveBeenCalledOnce();
  });
  it('refuses before staging when a transaction data accessor retires the actor', async () => {
    H.get.mockResolvedValue({ exists: () => true, data: () => { retire(); return closingEvent(); } });
    await expect(archiveEvent(1)).resolves.toBe('read-failed:event');
    expect(H.update).not.toHaveBeenCalled(); expect(H.capture).toHaveBeenCalledOnce();
  });
  it('still rejects a possibly committed archive after retirement, never reporting a safe refusal', async () => {
    const ack = deferred<void>(); const staged = deferred<void>();
    H.runTransaction.mockImplementation(async (_db, callback) => {
      const result = await callback({ get: H.get, update: H.update, set: H.set, delete: H.delete });
      staged.resolve(); await ack.promise; return result;
    });
    const freezing = archiveEvent(1); await staged.promise;
    expect(H.update).toHaveBeenCalledOnce(); retire(); ack.resolve();
    await expect(freezing).rejects.toThrow('Private session');
    expect(H.capture).toHaveBeenCalledOnce(); expect(H.update).toHaveBeenCalledOnce();
  });
  it('keeps a later retry read failure unknown after an earlier archive update attempt', async () => {
    const failedRead = new Error('retry read unavailable');
    H.runTransaction.mockImplementation(async (_db, callback) => {
      const tx = { get: H.get, update: H.update, set: H.set, delete: H.delete };
      await callback(tx);
      H.get.mockRejectedValueOnce(failedRead);
      return callback(tx);
    });
    await expect(archiveEvent(1)).rejects.toBe(failedRead);
    expect(H.update).toHaveBeenCalledOnce(); expect(H.get).toHaveBeenCalledTimes(2);
    expect(H.capture).toHaveBeenCalledOnce();
  });
  it('retains ordinary successful archive with one captured memory transaction', async () => {
    await expect(archiveEvent(1)).resolves.toBe('archived');
    expect(H.update).toHaveBeenCalledOnce(); expect(H.runTransaction.mock.calls[0][0]).toBe(H.privateDb);
    expect(H.capture).toHaveBeenCalledOnce();
  });
});
