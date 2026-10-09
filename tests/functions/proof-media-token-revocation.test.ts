import { describe, it, expect, vi } from 'vitest';
import { PROOF_MEDIA_CACHE_CONTROL } from '../../src/data/proofMediaCache';
import {
  PRIVATE_PROOF_MEDIA_POLICY, stripProofMediaTokens, sweepProofMediaTokens, adminProofMediaTokenStore,
  type ProofMediaTokenStore, type TokenSweepProgress,
} from '../../functions/src/proofMediaTokens';

const photo = 'proofs/A/alice/photo.jpg';
const thumb = 'proofs/A/alice/photo_thumb.jpg';
const audio = 'proofs/A/bob/sound.m4a';

function fakeStore(paths = [photo, thumb, audio]) {
  const objects = new Map(paths.map(path => [path, {
    metageneration: 1, generation: 'bytes-1', cacheControl: 'public',
    metadata: { firebaseStorageDownloadTokens: 'secret', faHold: 'true' },
  }]));
  const rows = new Map<string, TokenSweepProgress>();
  const writes: string[] = [];
  const store: ProofMediaTokenStore = {
    bucket: 'test-bucket',
    async metadata(path) {
      const value = objects.get(path);
      if (!value) throw { code: 404 };
      return structuredClone(value);
    },
    async strip(path, metageneration) {
      const value = objects.get(path);
      if (!value) throw { code: 404 };
      if (value.metageneration !== metageneration) throw { code: 412 };
      writes.push(path);
      value.metageneration++;
      delete (value.metadata as Partial<typeof value.metadata>).firebaseStorageDownloadTokens;
      value.cacheControl = PRIVATE_PROOF_MEDIA_POLICY;
    },
    async list(prefix, token) {
      const names = paths.filter(path => path.startsWith(prefix));
      const start = Number(token ?? 0);
      return { paths: names.slice(start, start + 2), next: start + 2 < names.length ? String(start + 2) : null };
    },
    async progress(key, update) {
      const next = update(rows.get(key) ?? null);
      rows.set(key, next);
      return next;
    },
  };
  return { store, objects, rows, writes };
}

describe('proof-media token revocation (#1534)', () => {
  it('uses the existing private/no-store upload policy', () => {
    expect(PRIVATE_PROOF_MEDIA_POLICY).toBe(PROOF_MEDIA_CACHE_CONTROL);
  });

  it('the SDK adapter sends one conditional metadata patch and bounded prefix pagination', async () => {
    const file = {
      name: photo,
      getMetadata: vi.fn(async () => [{ metageneration: '7', metadata: { firebaseStorageDownloadTokens: 'secret' } }]),
      setMetadata: vi.fn(async () => []),
    };
    const bucket = {
      name: 'test-bucket', file: vi.fn(() => file),
      getFiles: vi.fn(async () => [[file], { pageToken: 'next-page' }]),
    };
    const store = adminProofMediaTokenStore(
      bucket as unknown as Parameters<typeof adminProofMediaTokenStore>[0],
      {} as Parameters<typeof adminProofMediaTokenStore>[1],
    );
    await stripProofMediaTokens(photo, store);
    expect(file.setMetadata).toHaveBeenCalledExactlyOnceWith({
      metadata: { firebaseStorageDownloadTokens: null }, cacheControl: PRIVATE_PROOF_MEDIA_POLICY,
    }, { ifMetagenerationMatch: '7' });
    expect(await store.list('proofs/A/', 'previous-page')).toEqual({ paths: [photo], next: 'next-page' });
    expect(bucket.getFiles).toHaveBeenCalledExactlyOnceWith({
      prefix: 'proofs/A/', pageToken: 'previous-page', autoPaginate: false, maxResults: 100,
    });
  });

  it('strips tokens once, preserving holds and byte generation; clean objects need no write', async () => {
    const f = fakeStore();
    await stripProofMediaTokens(photo, f.store);
    await stripProofMediaTokens(photo, f.store);
    expect(f.writes).toEqual([photo]);
    expect(f.objects.get(photo)).toMatchObject({ generation: 'bytes-1', metadata: { faHold: 'true' } });
    expect(f.objects.get(photo)?.metadata).not.toHaveProperty('firebaseStorageDownloadTokens');
  });

  it('rereads after a token is minted between read and write', async () => {
    const f = fakeStore();
    const original = f.store.strip;
    let first = true;
    f.store.strip = async (path, generation) => {
      if (first) {
        first = false;
        const object = f.objects.get(path)!;
        object.metageneration++;
        object.metadata.firebaseStorageDownloadTokens = 'new-secret';
      }
      await original(path, generation);
    };
    await stripProofMediaTokens(photo, f.store);
    expect(f.objects.get(photo)?.metadata).not.toHaveProperty('firebaseStorageDownloadTokens');
    expect(f.writes).toEqual([photo]);
  });

  it('treats a deleted object as done, including deletion between read and write', async () => {
    const f = fakeStore();
    f.store.strip = async path => { f.objects.delete(path); throw { code: 404 }; };
    await stripProofMediaTokens(photo, f.store);
    await stripProofMediaTokens(photo, f.store);
  });

  it('sweeps photos, thumbnails, audio and held media; a rerun performs no metadata writes', async () => {
    const f = fakeStore();
    expect(await sweepProofMediaTokens('A', 'migration', f.store)).toMatchObject({ status: 'complete', processed: 3 });
    await sweepProofMediaTokens('A', 'migration', f.store);
    await sweepProofMediaTokens('A', 'another-revocation', f.store);
    expect(f.writes).toEqual([photo, thumb, audio]);
  });

  it('resumes a crash mid-page without skipping the failed object or double counting', async () => {
    const f = fakeStore();
    const original = f.store.strip;
    f.store.strip = async (path, generation) => {
      if (path === thumb) throw new Error('crash');
      return original(path, generation);
    };
    await expect(sweepProofMediaTokens('A', 'migration', f.store)).rejects.toThrow('crash');
    expect([...f.rows.values()][0]).toMatchObject({ status: 'pending', pageToken: null, processed: 0 });
    f.store.strip = original;
    expect(await sweepProofMediaTokens('A', 'migration', f.store)).toMatchObject({ status: 'complete', processed: 3 });
    expect(f.writes).toEqual([photo, thumb, audio]);
  });

  it('two concurrent sweeps converge without advancing a stale page twice', async () => {
    const f = fakeStore();
    const outcomes = await Promise.all([
      sweepProofMediaTokens('A', 'migration', f.store),
      sweepProofMediaTokens('A', 'migration', f.store),
    ]);
    for (const result of outcomes) expect(result).toMatchObject({ status: 'complete', processed: 3 });
    expect(f.writes).toHaveLength(3);
  });

  it('a deleted object mid-sweep does not prevent completion', async () => {
    const f = fakeStore();
    f.objects.delete(thumb);
    expect(await sweepProofMediaTokens('A', 'migration', f.store)).toMatchObject({ status: 'complete', processed: 3 });
  });

  it('keeps progress pending on exhausted contention and refuses scope escapes', async () => {
    const f = fakeStore();
    f.store.strip = async () => { throw { code: 412 }; };
    await expect(sweepProofMediaTokens('A', 'migration', f.store)).rejects.toThrow('contention');
    expect([...f.rows.values()][0].status).toBe('pending');
    await expect(stripProofMediaTokens('avatars/alice.jpg', f.store)).rejects.toThrow('Not proof media');
    await expect(sweepProofMediaTokens('A/../B', 'migration', f.store)).rejects.toThrow('scope');
    f.store.list = async () => ({ paths: ['proofs/B/bob/photo.jpg'], next: null });
    await expect(sweepProofMediaTokens('A', 'migration', f.store)).rejects.toThrow('outside Event');
  });
});
