// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { configForTarget } from './build-target.mjs';
import { deployInvocation } from './deploy-target.mjs';
import { PROOF_MEDIA_CORS, reconcileProofMediaCors } from './proof-media-cors.mjs';

function fixture(target = 'fiveacross', cors = []) {
  const config = configForTarget(target);
  let current = { name: config.identity.VITE_FIREBASE_STORAGE_BUCKET,
    projectNumber: config.identity.VITE_FIREBASE_MESSAGING_SENDER_ID, metageneration: '7', cors };
  const request = vi.fn(async options => {
    if (options.method === 'PATCH') {
      expect(options.params).toEqual({ ifMetagenerationMatch: '7' });
      expect(Object.keys(options.data)).toEqual(['cors']);
      current = { ...current, metageneration: '8', ...options.data };
    }
    return structuredClone(current);
  });
  return { request, set: metadata => { current = metadata; } };
}

describe('authenticated media bucket CORS readiness', () => {
  it.each(['gaycruisebingo', 'fiveacross'])('pins %s and preserves its existing CORS rules', async target => {
    const prior = { origin: ['https://existing.example'], method: ['PUT'], responseHeader: ['Content-Type'] };
    const { request } = fixture(target, [prior]);
    const result = await reconcileProofMediaCors(target, request);
    expect(result).toEqual({ bucket: configForTarget(target).identity.VITE_FIREBASE_STORAGE_BUCKET, changed: true });
    expect(request.mock.calls[1][0].data.cors).toEqual([prior, PROOF_MEDIA_CORS]);
    expect(request.mock.calls.map(([options]) => options.method)).toEqual(['GET', 'PATCH', 'GET']);
    expect(request.mock.calls[0][0].url).toBe(`https://storage.googleapis.com/storage/v1/b/${result.bucket}`);
  });

  it('does not mutate an already configured bucket', async () => {
    const { request } = fixture('fiveacross', [PROOF_MEDIA_CORS]);
    expect(await reconcileProofMediaCors('fiveacross', request)).toMatchObject({ changed: false });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([{ name: 'foreign-bucket' }, { projectNumber: 'foreign-project' }, { metageneration: undefined }, { cors: {} }])(
    'refuses invalid identity/metadata before any patch: %j', async mismatch => {
      const config = configForTarget('fiveacross');
      const request = vi.fn(async () => ({ name: config.identity.VITE_FIREBASE_STORAGE_BUCKET,
        projectNumber: config.identity.VITE_FIREBASE_MESSAGING_SENDER_ID, metageneration: '7', ...mismatch }));
      await expect(reconcileProofMediaCors('fiveacross', request)).rejects.toThrow('identity or CORS');
      expect(request).toHaveBeenCalledOnce();
    });

  it('fails closed on a concurrent bucket update without retrying the stale policy', async () => {
    const { request } = fixture();
    request.mockImplementationOnce(async () => ({ name: 'fiveacross.firebasestorage.app',
      projectNumber: configForTarget('fiveacross').identity.VITE_FIREBASE_MESSAGING_SENDER_ID, metageneration: '7' }));
    request.mockImplementationOnce(async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    await expect(reconcileProofMediaCors('fiveacross', request)).rejects.toMatchObject({ code: 412 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([{ after: [] }, { after: [PROOF_MEDIA_CORS] }])('requires readback of the new and preserved policies (%j)', async ({ after }) => {
    const prior = { origin: ['https://existing.example'], method: ['PUT'] };
    const { request } = fixture('fiveacross', [prior]);
    const original = request.getMockImplementation();
    request.mockImplementation(async options => {
      const result = await original(options);
      return request.mock.calls.length === 3 ? { ...result, cors: after } : result;
    });
    await expect(reconcileProofMediaCors('fiveacross', request)).rejects.toThrow('readback');
  });

  it('pins CORS readiness to each named target despite a stale ambient target', () => {
    for (const target of ['gaycruisebingo', 'fiveacross']) {
      expect(deployInvocation(target, [], { PROOF_MEDIA_CORS_TARGET: 'foreign' }).environment.PROOF_MEDIA_CORS_TARGET).toBe(target);
    }
  });
});
