import { beforeEach, describe, expect, it, vi } from 'vitest';
const H = vi.hoisted(() => ({
  primary: { app: 'primary' }, captured: { app: 'private-actor' }, ref: vi.fn(), metadata: vi.fn(), remove: vi.fn(),
}));
vi.mock('../firebase', () => ({ storage: H.primary, EVENT_ID: 'event-a' }));
vi.mock('firebase/storage', () => ({
  ref: H.ref, getMetadata: H.metadata, deleteObject: H.remove,
  uploadBytes: vi.fn(), getDownloadURL: vi.fn(),
}));
import { deleteStoragePath, proofMediaGeneration } from './storage';
import type { FirebaseStorage } from 'firebase/storage';
// Opaque transport handles: the real helpers must pass exactly the selected
// handle to SDK ref, whose internal Auth provider belongs to that app.
const captured = H.captured as unknown as FirebaseStorage;
beforeEach(() => {
  H.ref.mockReset().mockImplementation((client, path) => ({ client, path }));
  H.metadata.mockReset().mockResolvedValue({ generation: '123' });
  H.remove.mockReset().mockResolvedValue(undefined);
});
describe('proof deletion uses explicit captured Storage transport', () => {
  it('binds metadata and revocation to the supplied named app', async () => {
    expect(await proofMediaGeneration('proof-path', captured)).toBe('123');
    await deleteStoragePath('proof-path', captured);
    expect(H.ref.mock.calls).toEqual([[H.captured, 'proof-path'], [H.captured, 'proof-path']]);
    expect(H.metadata).toHaveBeenCalledWith({ client: H.captured, path: 'proof-path' });
    expect(H.remove).toHaveBeenCalledWith({ client: H.captured, path: 'proof-path' });
  });
  it('preserves primary transport for ordinary owner calls', async () => {
    await proofMediaGeneration('proof-path'); await deleteStoragePath('proof-path');
    expect(H.ref.mock.calls).toEqual([[H.primary, 'proof-path'], [H.primary, 'proof-path']]);
  });
  it('retains best-effort metadata and not-found deletion semantics', async () => {
    H.metadata.mockRejectedValue(new Error('metadata denied'));
    H.remove.mockRejectedValue({ code: 'storage/object-not-found' });
    expect(await proofMediaGeneration('proof-path', captured)).toBeNull();
    await expect(deleteStoragePath('proof-path', captured)).resolves.toBeUndefined();
  });
  it('keeps a real revocation failure visible to the caller', async () => {
    const error = new Error('permission denied'); H.remove.mockRejectedValue(error);
    await expect(deleteStoragePath('proof-path', captured)).rejects.toBe(error);
  });
});
