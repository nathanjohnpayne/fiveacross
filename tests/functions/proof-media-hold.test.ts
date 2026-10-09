import { describe, expect, it, vi } from 'vitest';
import {
  adminProofMediaHoldStore, assertHideCommitAllowed, HIDE_COMMIT_MARGIN_MS, MEDIA_HOLD_LEASE_MS,
  preHoldProofMedia, proofMediaVersion, reconcileProofMediaHold, runProofMediaHoldRepairs,
  wantedProofMediaHold, withProofMediaHideLease,
  type HoldMetadata, type HoldProof, type HoldRepairStore,
} from '../../functions/src/proofMediaHold';

const scope = { eventId: 'event', proofId: 'proof' };
const main = 'proofs/event/player/proof.jpg';
const thumb = 'proofs/event/player/proof_thumb.jpg';
const at = (nanoseconds: number) => ({ seconds: 100, nanoseconds });
const version = (n: number) => proofMediaVersion(at(n));
const active = (n = 1): HoldProof => ({ exists: true, updateTime: at(n), readTime: at(n + 1),
  data: { status: 'active', storagePath: main } });
function fixture() {
  let now = 1_000_000;
  let proof = active();
  const objects = new Map<string, HoldMetadata>([main, thumb].map(path => [path, {
    generation: '1', metageneration: '1', metadata: { faHold: 'true', firebaseStorageDownloadTokens: 'bearer', unrelated: 'kept' },
  }]));
  const jobs = new Map<string, { dueAt: number; revision: number; eventId: string; proofId: string }>();
  const store: HoldRepairStore = {
    now: () => now,
    proof: vi.fn(async () => structuredClone(proof)),
    objects: vi.fn(async () => [...objects.keys()]),
    metadata: vi.fn(async path => {
      if (!objects.has(path)) throw Object.assign(new Error('gone'), { code: 404 });
      return structuredClone(objects.get(path)!);
    }),
    patch: vi.fn(async (path, patch, generation, incarnation) => {
      const current = objects.get(path)!;
      if (current.metageneration !== generation || current.generation !== incarnation) throw Object.assign(new Error('CAS'), { code: 412 });
      const metadata = { ...current.metadata, ...patch.metadata };
      for (const [key, value] of Object.entries(metadata)) if (value === null) delete metadata[key];
      objects.set(path, { ...current, ...patch, metadata, metageneration: String(Number(generation) + 1) });
    }),
    enqueue: vi.fn(async (target, dueAt) => {
      jobs.set('job', { ...target, dueAt, revision: (jobs.get('job')?.revision ?? 0) + 1 });
    }),
    due: vi.fn(async () => [...jobs].filter(([, job]) => job.dueAt <= now)
      .map(([key, job]) => ({ ...job, key }))),
    defer: vi.fn(async (job, dueAt) => {
      const current = jobs.get(job.key);
      if (current?.revision === job.revision) jobs.set(job.key, { ...current, dueAt, revision: job.revision + 1 });
    }),
    acknowledge: vi.fn(async job => {
      if (jobs.get(job.key)?.revision === job.revision) jobs.delete(job.key);
    }),
  };
  return { store, objects, jobs, setNow: (value: number) => { now = value; },
    setProof: (value: HoldProof) => { proof = value; } };
}

describe('Proof-media hold ordering', () => {
  it.each(['hidden', 'flagged', 'pending', undefined])('holds %s Proofs', status => {
    expect(wantedProofMediaHold({ ...active(), data: { status } })).toBe('true');
  });
  it('lifts only active, existing Proofs without a safety hold', () => {
    expect(wantedProofMediaHold(active())).toBe('false');
    expect(wantedProofMediaHold({ ...active(), data: { status: 'active', safetyHide: true } })).toBe('true');
    expect(wantedProofMediaHold({ exists: false, readTime: at(2) })).toBe('true');
  });
  it('stores and compares timestamps losslessly across the full Firestore range', () => {
    expect(version(123456789)).toMatch(/^[0-9]{12}\.123456789$/);
    expect(version(123456789) < version(123456790)).toBe(true);
    expect(proofMediaVersion({ seconds: -1, nanoseconds: 999999999 })
      < proofMediaVersion({ seconds: 0, nanoseconds: 0 })).toBe(true);
    expect(() => proofMediaVersion(at(1_000_000_000))).toThrow();
  });
  it('lifts both bound objects, retains token state and skips an identical replay', async () => {
    const f = fixture();
    await reconcileProofMediaHold(scope, f.store);
    for (const object of f.objects.values()) {
      expect(object.metadata).toMatchObject({ faHold: 'false', faSrc: version(1), firebaseStorageDownloadTokens: 'bearer', unrelated: 'kept' });
    }
    vi.mocked(f.store.patch).mockClear();
    await reconcileProofMediaHold(scope, f.store);
    expect(f.store.patch).not.toHaveBeenCalled();
  });
  it('holds and strips tokens in the same CAS write without touching bytes', async () => {
    const f = fixture(); f.setProof({ ...active(), data: { status: 'hidden', storagePath: main } });
    await reconcileProofMediaHold(scope, f.store);
    for (const object of f.objects.values()) {
      expect(object.metadata).toEqual({ faHold: 'true', faSrc: version(1), unrelated: 'kept' });
      expect(object.cacheControl).toBe('private, no-store, max-age=0');
    }
    expect(f.store.patch).toHaveBeenCalledWith(main, expect.objectContaining({ metadata: expect.objectContaining({
      faHold: 'true', firebaseStorageDownloadTokens: null,
    }) }), '1', '1');
  });
  it('rejects strictly older snapshots even within the same millisecond', async () => {
    const f = fixture(); f.setProof(active(123456001));
    for (const object of f.objects.values()) object.metadata = { faHold: 'true', faSrc: version(123456999) };
    await reconcileProofMediaHold(scope, f.store);
    expect(f.store.patch).not.toHaveBeenCalled();
  });
  it('rejects a stale hold after a newer restore', async () => {
    const f = fixture(); f.setProof({ ...active(10), data: { status: 'hidden' } });
    for (const object of f.objects.values()) object.metadata = { faHold: 'false', faSrc: version(20) };
    await reconcileProofMediaHold(scope, f.store);
    expect(f.store.patch).not.toHaveBeenCalled();
  });
  it('restarts at a fresh Proof read on 412 and does not apply the stale lift', async () => {
    const f = fixture(); const original = f.store.patch;
    f.store.patch = vi.fn(async (...args) => {
      if (vi.mocked(f.store.patch).mock.calls.length === 1) {
        f.setProof({ ...active(3), data: { status: 'hidden' } });
        throw Object.assign(new Error('CAS'), { code: 412 });
      }
      return original(...args);
    });
    await reconcileProofMediaHold(scope, f.store);
    expect(f.store.proof).toHaveBeenCalledTimes(2);
    for (const object of f.objects.values()) expect(object.metadata).toMatchObject({ faHold: 'true', faSrc: version(3) });
  });
  it('refuses an ABA replacement whose metageneration restarted at the same value', async () => {
    const f = fixture(); const original = f.store.patch;
    f.store.patch = vi.fn(async (...args) => {
      if (vi.mocked(f.store.patch).mock.calls.length === 1) {
        f.objects.set(main, { generation: '2', metageneration: '1', metadata: { faHold: 'true' } });
        f.setProof({ exists: false, readTime: at(3) });
      }
      return original(...args);
    });
    await reconcileProofMediaHold(scope, f.store);
    expect(f.store.proof).toHaveBeenCalledTimes(2);
    expect(f.objects.get(main)?.metadata).toMatchObject({ faHold: 'true', faSrc: version(3) });
  });

  it('leaves later objects held after a partial lift fails', async () => {
    const f = fixture(); const original = f.store.patch;
    f.store.patch = vi.fn(async (...args) => {
      if (args[0] === thumb) throw new Error('bucket unavailable');
      return original(...args);
    });
    await expect(reconcileProofMediaHold(scope, f.store)).rejects.toThrow('unavailable');
    expect(f.objects.get(main)?.metadata?.faHold).toBe('false');
    expect(f.objects.get(thumb)?.metadata?.faHold).toBe('true');
  });
  it('uses the absent snapshot readTime, ordering delete and recreate correctly', async () => {
    const f = fixture();
    await reconcileProofMediaHold(scope, f.store);
    f.setProof({ exists: false, readTime: at(3) });
    await reconcileProofMediaHold(scope, f.store);
    expect(f.objects.get(main)?.metadata).toMatchObject({ faHold: 'true', faSrc: version(3) });
    f.setProof(active(5));
    await reconcileProofMediaHold(scope, f.store);
    expect(f.objects.get(main)?.metadata).toMatchObject({ faHold: 'false', faSrc: version(5) });
    f.setProof({ exists: false, readTime: at(3) });
    await reconcileProofMediaHold(scope, f.store);
    expect(f.objects.get(main)?.metadata?.faHold).toBe('false');
  });
  it('never lifts an orphan belonging to a different uploader or extension', async () => {
    const f = fixture(); f.objects.set('proofs/event/other/proof.jpg', { generation: '1', metageneration: '1' });
    f.objects.set('proofs/event/player/proof.webm', { generation: '1', metageneration: '1' });
    await reconcileProofMediaHold(scope, f.store);
    expect(f.objects.get('proofs/event/other/proof.jpg')?.metadata?.faHold).toBe('true');
    expect(f.objects.get('proofs/event/player/proof.webm')?.metadata?.faHold).toBe('true');
  });
  it.each([{ faSrc: '100.1' }, { faLease: 'garbage' }])('fails closed on malformed metadata %j', async metadata => {
    const f = fixture(); f.objects.get(main)!.metadata = metadata;
    await expect(reconcileProofMediaHold(scope, f.store)).rejects.toThrow('Invalid');
    expect(f.store.patch).not.toHaveBeenCalled();
  });
  it('bounds repeated conflicts and refuses out-of-scope paths', async () => {
    const f = fixture(); f.store.patch = vi.fn(async () => { throw Object.assign(new Error('CAS'), { code: 412 }); });
    await expect(reconcileProofMediaHold(scope, f.store)).rejects.toThrow('contention');
    expect(f.store.proof).toHaveBeenCalledTimes(8);
    f.store.objects = vi.fn(async () => ['avatars/player.jpg']);
    await expect(reconcileProofMediaHold(scope, f.store)).rejects.toThrow('outside');
  });
});

describe('hide leases and durable repairs', () => {
  it('repairs an aborted equal-version pre-hold after expiry, never before', async () => {
    const f = fixture(); await reconcileProofMediaHold(scope, f.store);
    const lease = await preHoldProofMedia(scope, f.store);
    expect(f.objects.get(main)?.metadata).toMatchObject({ faSrc: version(1), faHold: 'true' });
    expect(f.objects.get(main)?.metadata?.firebaseStorageDownloadTokens).toBeUndefined();
    expect(f.jobs.get('job')?.dueAt).toBe(lease.expiresAt);
    await reconcileProofMediaHold(scope, f.store);
    expect(f.objects.get(main)?.metadata?.faHold).toBe('true');
    f.setNow(lease.expiresAt);
    await runProofMediaHoldRepairs(f.store);
    expect(f.objects.get(main)?.metadata).toEqual({ faHold: 'false', faSrc: version(1), unrelated: 'kept' });
    expect(f.jobs.size).toBe(0);
  });
  it('allows equal-version hold repair and clears expired leases', async () => {
    const f = fixture(); f.setProof({ ...active(), data: { status: 'hidden' } });
    f.objects.get(main)!.metadata = { faHold: 'false', faSrc: version(1), faLease: '999999' };
    await reconcileProofMediaHold(scope, f.store);
    expect(f.objects.get(main)?.metadata).toEqual({ faHold: 'true', faSrc: version(1) });
  });
  it('preserves live pre-hold leases on authoritative hold writes across a restore', async () => {
    const f = fixture(); const lease = await preHoldProofMedia(scope, f.store);
    f.setProof({ ...active(2), data: { status: 'hidden' } });
    await reconcileProofMediaHold(scope, f.store);
    expect(f.objects.get(main)?.metadata?.faLease).toBe(String(lease.expiresAt));
    f.setProof(active(3)); await reconcileProofMediaHold(scope, f.store);
    expect(f.objects.get(main)?.metadata?.faHold).toBe('true');
  });
  it('persists repair before touching objects, including partial pre-hold failure', async () => {
    const f = fixture(); f.store.patch = vi.fn(async () => { throw new Error('offline'); });
    await expect(preHoldProofMedia(scope, f.store)).rejects.toThrow('offline');
    expect(f.jobs.size).toBe(1);
    expect(vi.mocked(f.store.enqueue).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(f.store.patch).mock.invocationCallOrder[0]);
  });
  it('refuses a hide commit after its margin, then pre-holds and prepares again', async () => {
    const f = fixture(); const commit = vi.fn(async () => undefined);
    const prepare = vi.fn(async lease => {
      if (prepare.mock.calls.length === 1) f.setNow(lease.commitBefore);
      return commit;
    });
    await withProofMediaHideLease(scope, f.store, prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
    expect(f.store.enqueue).toHaveBeenCalledTimes(2);
    expect(HIDE_COMMIT_MARGIN_MS).toBeGreaterThanOrEqual(120_000);
    expect(MEDIA_HOLD_LEASE_MS).toBeGreaterThan(HIDE_COMMIT_MARGIN_MS);
    expect(() => assertHideCommitAllowed({ expiresAt: 300, commitBefore: 200 }, 200)).toThrow('renewed');
  });
  it('backs off a failed revision while continuing other repairs', async () => {
    const f = fixture();
    f.jobs.set('bad', { ...scope, dueAt: 0, revision: 1 });
    f.store.proof = vi.fn(async () => { throw new Error('offline'); });
    await expect(runProofMediaHoldRepairs(f.store)).rejects.toThrow('pending');
    expect(f.jobs.get('bad')).toMatchObject({ dueAt: f.store.now() + 60_000, revision: 2 });
    expect(await f.store.due()).toEqual([]);
    await f.store.acknowledge({ ...scope, key: 'bad', revision: 1 });
    expect(f.jobs.has('bad')).toBe(true);
  });
  it('repairs a thumbnail saved after an earlier reconcile, including replacement redelivery', async () => {
    const f = fixture(); f.objects.delete(thumb);
    f.setProof({ ...active(), data: { status: 'hidden', storagePath: main } });
    await reconcileProofMediaHold(scope, f.store);
    for (const generation of ['1', '2']) {
      f.objects.set(thumb, { generation, metageneration: '1', metadata: { faHold: 'true' } });
      await reconcileProofMediaHold(scope, f.store);
      expect(f.objects.get(thumb)?.metadata).toMatchObject({ faHold: 'true', faSrc: version(1) });
    }
  });
  it('keeps a repair re-enqueued under a new lease instead of deleting its newer revision', async () => {
    const f = fixture(); const lease = await preHoldProofMedia(scope, f.store);
    f.setNow(lease.expiresAt);
    f.objects.get(main)!.metadata!.faLease = String(lease.expiresAt + 1000);
    await runProofMediaHoldRepairs(f.store);
    expect(f.jobs.get('job')?.dueAt).toBe(lease.expiresAt + 1000);
    expect(f.objects.get(main)?.metadata?.faHold).toBe('true');
    f.setNow(lease.expiresAt + 1000); await runProofMediaHoldRepairs(f.store);
    expect(f.jobs.size).toBe(0);
  });
});


describe('Storage hold adapter listing', () => {
  it('filters at the server and follows even empty pages while retaining exact path checks', async () => {
    const getFiles = vi.fn().mockResolvedValueOnce([[], { pageToken: 'next' }])
      .mockResolvedValueOnce([[{ name: main }, { name: thumb }, { name: 'proofs/event/player/other.jpg' }], null]);
    const store = adminProofMediaHoldStore({ getFiles } as never, {} as never);
    expect(await store.objects(scope)).toEqual([main, thumb]);
    const options = { prefix: 'proofs/event/', autoPaginate: false, maxResults: 100,
      matchGlob: 'proofs/event/*/proof{.jpg,.webm,.m4a,_thumb.jpg}' };
    expect(getFiles.mock.calls).toEqual([[options], [{ ...options, pageToken: 'next' }]]);
  });
  it.each([{ eventId: 'ev[ent', proofId: 'proof' }, { eventId: 'event', proofId: 'pr*of' },
    { eventId: 'event', proofId: 'p'.repeat(1024) }])('falls back without interpreting unsafe or oversized IDs: %j', async target => {
    const path = `proofs/${target.eventId}/player/${target.proofId}.jpg`;
    const getFiles = vi.fn().mockResolvedValue([[{ name: path }, { name: main }], null]);
    const store = adminProofMediaHoldStore({ getFiles } as never, {} as never);
    expect(await store.objects(target)).toEqual([path]);
    expect(getFiles).toHaveBeenCalledWith({ prefix: `proofs/${target.eventId}/`, autoPaginate: false, maxResults: 100 });
  });
});


describe('Durable repair adapter', () => {
  it('orders due work and retires only the malformed snapshot while returning valid jobs', async () => {
    const deleted = vi.fn(async () => undefined);
    const stamp = { seconds: 100, nanoseconds: 9 };
    const query = { where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), get: vi.fn(async () => ({ docs: [
      { id: 'bad', data: () => ({ eventId: 'bad/path', proofId: 'proof', revision: 1 }),
        ref: { delete: deleted }, updateTime: stamp },
      { id: 'good', data: () => ({ ...scope, revision: 2 }) },
    ] })) };
    query.where.mockReturnValue(query); query.orderBy.mockReturnValue(query); query.limit.mockReturnValue(query);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = adminProofMediaHoldStore({} as never, { collection: () => query } as never);
      expect(await store.due()).toEqual([{ ...scope, key: 'good', revision: 2 }]);
      expect(query.orderBy).toHaveBeenCalledWith('dueAt');
      expect(deleted).toHaveBeenCalledWith({ lastUpdateTime: stamp });
      expect(log).toHaveBeenCalledWith('Discarding malformed media hold repair', 'bad');
    } finally { log.mockRestore(); }
  });
  it('defers only the failed revision and cannot overwrite a newer scheduled repair', async () => {
    const ref = {}; let revision = 1;
    const tx = { get: vi.fn(async () => ({ data: () => ({ revision }) })), update: vi.fn() };
    const db = { collection: () => ({ doc: () => ref }), runTransaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) };
    const store = adminProofMediaHoldStore({} as never, db as never);
    await store.defer({ ...scope, key: 'job', revision: 1 }, 200);
    expect(tx.update).toHaveBeenCalledWith(ref, { dueAt: 200, revision: 2 });
    tx.update.mockClear(); revision = 3;
    await store.defer({ ...scope, key: 'job', revision: 1 }, 200);
    expect(tx.update).not.toHaveBeenCalled();
  });
});
