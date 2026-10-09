import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProofMediaUrls } from './useProofMedia';

const M = vi.hoisted(() => ({
  session: { uid: 'alice', db: {}, generation: 1, failed: false, recoveryRequired: false },
  load: vi.fn(), create: vi.fn(), revoke: vi.fn(),
}));
vi.mock('../firebase', () => ({ EVENT_ID: 'A' }));
vi.mock('./usePrivateFirestore', () => ({ usePrivateFirestore: () => M.session }));
vi.mock('../data/proofMedia', () => ({ loadProofMediaBlob: M.load }));
const path = 'proofs/A/alice/p.jpg';

beforeEach(() => {
  vi.clearAllMocks(); M.session = { uid: 'alice', db: {}, generation: 1, failed: false, recoveryRequired: false };
  M.load.mockResolvedValue(new Blob(['photo'])); M.create.mockReturnValue('blob:photo');
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: M.create, revokeObjectURL: M.revoke }));
});
afterEach(() => vi.unstubAllGlobals());

describe('proof object URL lifetime', () => {
  it('owns URLs until replacement or unmount and does not reload unchanged paths', async () => {
    const { result, rerender, unmount } = renderHook(({ paths }) => useProofMediaUrls(paths, 'alice'), { initialProps: { paths: [path] } });
    await waitFor(() => expect(result.current.urls.get(path)).toBe('blob:photo'));
    rerender({ paths: [path] });
    expect(M.load).toHaveBeenCalledOnce();
    rerender({ paths: ['proofs/A/alice/other.jpg'] });
    expect(result.current.urls.has(path)).toBe(false);
    expect(M.revoke).toHaveBeenCalledWith('blob:photo');
    await waitFor(() => expect(result.current.urls.size).toBe(1));
    unmount(); expect(M.revoke).toHaveBeenCalledTimes(2);
  });

  it.each(['storage/unauthorized', 'storage/object-not-found'])('withholds %s media', async code => {
    M.load.mockRejectedValue({ code });
    const { result } = renderHook(() => useProofMediaUrls([path], 'alice'));
    await act(async () => {});
    expect(result.current.urls.size).toBe(0); expect(M.create).not.toHaveBeenCalled();
  });

  it('withholds media for an explicitly signed-out viewer', async () => {
    const { result } = renderHook(() => useProofMediaUrls([path], null));
    await act(async () => {});
    expect(result.current.urls.size).toBe(0); expect(M.load).not.toHaveBeenCalled();
  });

  it('never publishes a late result after unmount', async () => {
    let finish!: (blob: Blob) => void;
    M.load.mockReturnValue(new Promise<Blob>(resolve => { finish = resolve; }));
    const { unmount } = renderHook(() => useProofMediaUrls([path], 'alice'));
    unmount(); await act(async () => finish(new Blob(['old'])));
    expect(M.create).not.toHaveBeenCalled();
  });

  it('hides and revokes old URLs when the account/transport retires', async () => {
    const { result, rerender } = renderHook(() => useProofMediaUrls([path], 'alice'));
    await waitFor(() => expect(result.current.urls.size).toBe(1));
    M.session = { ...M.session, uid: 'bob', generation: 2 }; rerender();
    expect(result.current.urls.size).toBe(0); expect(M.revoke).toHaveBeenCalledWith('blob:photo');
    expect(M.load).toHaveBeenCalledOnce();
  });
});
