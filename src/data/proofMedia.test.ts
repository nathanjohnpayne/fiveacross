import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProofMediaBlob } from './proofMedia';

const M = vi.hoisted(() => ({
  eventId: 'A', storage: {}, getBlob: vi.fn(), assertCurrent: vi.fn(), capture: vi.fn(),
}));
vi.mock('../firebase', () => ({ get EVENT_ID() { return M.eventId; } }));
vi.mock('../privateFirestore', () => ({ capturePrivateFirestore: M.capture }));
vi.mock('firebase/storage', () => ({ getBlob: M.getBlob, ref: (storage: unknown, path: string) => ({ storage, path }) }));

beforeEach(() => {
  vi.clearAllMocks(); M.eventId = 'A';
  M.capture.mockReturnValue({ storage: M.storage, assertCurrent: M.assertCurrent });
  M.getBlob.mockResolvedValue(new Blob(['photo'], { type: 'image/jpeg' }));
});
afterEach(() => vi.useRealTimers());

describe('authenticated proof media reads (#1532)', () => {
  it('downloads bounded bytes from the captured account’s Storage ref', async () => {
    const blob = await loadProofMediaBlob('proofs/A/alice/p.jpg');
    expect(blob.size).toBe(5);
    expect(M.capture).toHaveBeenCalledExactlyOnceWith(true);
    expect(M.getBlob).toHaveBeenCalledExactlyOnceWith({ storage: M.storage, path: 'proofs/A/alice/p.jpg' }, 12 * 1024 * 1024);
    expect(M.assertCurrent).toHaveBeenCalledOnce();
  });

  it.each(['storage/unauthorized', 'storage/object-not-found'])('propagates %s without a bearer fallback', async code => {
    M.getBlob.mockRejectedValue(Object.assign(new Error('denied'), { code }));
    await expect(loadProofMediaBlob('proofs/A/alice/p.jpg')).rejects.toMatchObject({ code });
    expect(M.getBlob).toHaveBeenCalledOnce();
  });

  it('never starts a download signed out or outside the current Event', async () => {
    M.capture.mockImplementation(() => { throw new Error('signed out'); });
    await expect(loadProofMediaBlob('proofs/A/alice/p.jpg')).rejects.toThrow('signed out');
    await expect(loadProofMediaBlob('proofs/B/alice/p.jpg')).rejects.toThrow('Invalid');
    await expect(loadProofMediaBlob('https://example.test/media?token=secret')).rejects.toThrow('Invalid');
    expect(M.getBlob).not.toHaveBeenCalled();
  });

  it('refuses downloaded bytes after account retirement or an Event change', async () => {
    M.assertCurrent.mockImplementationOnce(() => { throw new Error('retired'); });
    await expect(loadProofMediaBlob('proofs/A/alice/p.jpg')).rejects.toThrow('retired');
    M.getBlob.mockImplementationOnce(async () => { M.eventId = 'B'; return new Blob(['old']); });
    await expect(loadProofMediaBlob('proofs/A/alice/p.jpg')).rejects.toThrow('Event changed');
  });

  it('bounds a stalled SDK read', async () => {
    vi.useFakeTimers(); M.getBlob.mockReturnValue(new Promise(() => {}));
    const result = loadProofMediaBlob('proofs/A/alice/p.jpg');
    const check = expect(result).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(8_000);
    await check;
  });
});
