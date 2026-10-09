import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFirstAvailableProofMedia, useProofMediaUrls } from './useProofMedia';

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
  it('publishes a selected group only after its winner and fallback reads settle', async () => {
    let winner!: (blob: Blob) => void;
    M.load.mockImplementation((requested: string) => requested === path
      ? new Promise<Blob>(resolve => { winner = resolve; }) : Promise.resolve(new Blob(['fallback'])));
    const { result } = renderHook(() => useProofMediaUrls([path, 'proofs/A/alice/fallback.jpg'], 'alice'));
    await act(async () => {});
    expect(result.current.urls.size).toBe(0);
    await act(async () => winner(new Blob(['winner'])));
    expect(result.current.urls.size).toBe(2);
  });

  it('renders shared media during recovery without relaxing actor retirement', async () => {
    M.session = { ...M.session, recoveryRequired: true };
    const { result, rerender } = renderHook(() => useProofMediaUrls([path], 'alice'));
    await waitFor(() => expect(result.current.urls.get(path)).toBe('blob:photo'));
    M.session = { ...M.session, uid: 'bob', generation: 2 }; rerender();
    expect(result.current.urls.size).toBe(0);
    expect(M.revoke).toHaveBeenCalledWith('blob:photo');
    expect(M.load).toHaveBeenCalledOnce();
  });

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

describe('podium availability probe', () => {
  it('stops a 100-way tie at the first available winner without retaining object URLs', async () => {
    const paths = Array.from({ length: 100 }, (_, i) => `proofs/A/alice/${i}.jpg`);
    M.load.mockRejectedValueOnce(new Error('missing'));
    const { result } = renderHook(() => useFirstAvailableProofMedia(paths));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.path).toBe(paths[1]);
    expect(M.load.mock.calls.map(call => call[0])).toEqual(paths.slice(0, 2));
    expect(M.create).not.toHaveBeenCalled();
  });
  it('does not continue probing or publish across session retirement', async () => {
    let finish!: (blob: Blob) => void;
    M.load.mockReturnValue(new Promise<Blob>(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(() => useFirstAvailableProofMedia([path, 'proofs/A/alice/next.jpg']));
    M.session = { ...M.session, failed: true }; rerender();
    await act(async () => finish(new Blob(['old'])));
    expect(result.current.settled).toBe(false);
    expect(result.current.path).toBeUndefined();
    expect(M.load).toHaveBeenCalledOnce();
  });
});
