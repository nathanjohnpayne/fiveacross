import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Actual ProfileEditor → useMyUser and updateDisplayName/updateAvatar (including
// uploadAvatar). Only the SDK transport and captured private lease are controlled.
const H = vi.hoisted(() => ({
  db: { name: 'private-memory' }, legacyDb: { name: 'gameplay-persistent' },
  storage: { name: 'private-storage' },
  saved: { displayName: 'Saved Alice', photoURL: 'https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app/o/avatars%2Falice.jpg?alt=media', customPhoto: true },
  listeners: [] as { next: (snapshot: unknown) => void; error: () => void; stop: ReturnType<typeof vi.fn> }[],
  rejectWrite: null as ((error: Error) => void) | null,
  setDoc: vi.fn(), getDoc: vi.fn(), updateDoc: vi.fn(),
  uploadBytes: vi.fn(), getDownloadURL: vi.fn(),
}));
vi.mock('../firebase', () => ({ db: H.legacyDb, EVENT_ID: 'event', auth: { currentUser: { uid: 'alice' } }, storage: {}, functions: {}, analytics: null }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'alice', displayName: 'Google Alice', photoURL: null }, loading: false }) }));
vi.mock('../hooks/usePrivateFirestore', () => ({ usePrivateFirestore: () => ({ uid: 'alice', db: H.db, generation: 1, recoveryRequired: false, failed: false }) }));
vi.mock('../privateFirestore', () => ({ awaitPrivateFirestore: async (uid: string) => {
  if (uid !== 'alice') throw new Error('Wrong private actor');
  return { uid, db: H.db, storage: H.storage, assertCurrent: () => {}, guard: async <T,>(operation: () => Promise<T>) => operation() };
} }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  const ref = (database: unknown, ...parts: string[]) => ({ database, path: parts.join('/'), withConverter() { return this; } });
  return { ...actual, doc: ref, collection: ref,
    onSnapshot: (target: { database: unknown; path: string }, _options: unknown, next: (snapshot: unknown) => void, error: () => void) => {
      expect(target.database).toBe(H.db); expect(target.path).toBe('users/alice');
      const stop = vi.fn(); H.listeners.push({ next, error, stop }); return stop;
    },
    setDoc: (...args: unknown[]) => H.setDoc(...args),
    getDoc: (...args: unknown[]) => H.getDoc(...args),
    updateDoc: (...args: unknown[]) => H.updateDoc(...args),
  };
});
vi.mock('firebase/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/storage')>();
  return { ...actual, ref: (client: unknown, path: string) => ({ client, path }),
    uploadBytes: (...args: unknown[]) => H.uploadBytes(...args),
    getDownloadURL: (...args: unknown[]) => H.getDownloadURL(...args),
  };
});
import ProfileEditor from './ProfileEditor';

const emit = (pending = false, value: object = H.saved) => H.listeners.at(-1)!.next({
  exists: () => true, data: () => value, metadata: { fromCache: false, hasPendingWrites: pending },
});
const trigger = () => screen.getByRole('button', { name: 'Edit profile' });

beforeEach(() => {
  vi.clearAllMocks(); H.listeners = []; H.rejectWrite = null;
  H.setDoc.mockImplementation((target: { database: unknown; path: string }, patch: object, options: unknown) => {
    expect(target.database).toBe(H.db); expect(target.path).toBe('users/alice');
    expect(options).toEqual({ merge: true });
    emit(true, { ...H.saved, ...patch });
    return new Promise<void>((_resolve, reject) => { H.rejectWrite = reject; });
  });
  H.getDoc.mockResolvedValue({ data: () => ({ status: 'archived' }), metadata: { fromCache: false, hasPendingWrites: false } });
  H.uploadBytes.mockResolvedValue({});
  H.getDownloadURL.mockResolvedValue('https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app/o/avatars%2Falice-new.jpg?alt=media');
});

describe('real profile callers retain committed private identity during pending writes (#1411)', () => {
  it('keeps the saved name and actual editor mounted through a held save and its server rejection', async () => {
    render(<ProfileEditor />); await act(async () => { emit(); });
    const originalTrigger = trigger();
    await userEvent.click(originalTrigger);
    const dialog = screen.getByRole('dialog', { name: 'Edit profile' });
    const draft = screen.getByRole('textbox', { name: 'Display name' });
    await userEvent.clear(draft); await userEvent.type(draft, 'Uncommitted Alice');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(H.rejectWrite).not.toBeNull());
    expect(trigger()).toBe(originalTrigger);
    expect(originalTrigger).toHaveTextContent('Saved Alice');
    expect(originalTrigger).toBeEnabled();
    expect(screen.getByRole('dialog', { name: 'Edit profile' })).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => { emit(); H.rejectWrite!(new Error('permission-denied')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your name—try again.');
    expect(trigger()).toHaveTextContent('Saved Alice');
    expect(draft).toHaveValue('Uncommitted Alice');
    expect(screen.getByRole('button', { name: 'Save name' })).toBeEnabled();
    expect(H.setDoc).toHaveBeenCalledOnce();
    expect(H.getDoc).not.toHaveBeenCalled(); expect(H.updateDoc).not.toHaveBeenCalled();
  });

  it('keeps the saved avatar through the actual upload/profile-write path and rejected profile update', async () => {
    render(<ProfileEditor />); await act(async () => { emit(); });
    await userEvent.click(trigger());
    const savedImages = screen.getAllByRole('img', { name: 'Saved Alice' });
    fireEvent.change(screen.getByLabelText('Upload avatar'), { target: { files: [new File(['image'], 'avatar.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(H.rejectWrite).not.toBeNull());
    expect(H.uploadBytes).toHaveBeenCalledWith(expect.objectContaining({ client: H.storage, path: 'avatars/alice.jpg' }), expect.any(Blob), { contentType: 'image/jpeg' });
    expect(H.getDownloadURL).toHaveBeenCalledOnce();
    expect(H.setDoc).toHaveBeenCalledWith(expect.objectContaining({ database: H.db, path: 'users/alice' }), expect.objectContaining({ customPhoto: true }), { merge: true });
    expect(screen.getAllByRole('img', { name: 'Saved Alice' })).toEqual(savedImages);
    for (const image of savedImages) expect(image).toHaveAttribute('src', H.saved.photoURL);
    expect(screen.getByRole('button', { name: 'Change avatar' })).toBeDisabled();
    await act(async () => { emit(); H.rejectWrite!(new Error('permission-denied')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed—try again.');
    expect(screen.getByRole('button', { name: 'Change avatar' })).toBeEnabled();
    expect(H.getDoc).not.toHaveBeenCalled(); expect(H.updateDoc).not.toHaveBeenCalled();
  });

  it('a pending-first profile cannot open the actual editor or start a name/avatar write', async () => {
    render(<ProfileEditor />); await act(async () => { emit(true, { displayName: 'Uncommitted Alice' }); });
    expect(trigger()).toBeDisabled(); await userEvent.click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(H.setDoc).not.toHaveBeenCalled(); expect(H.uploadBytes).not.toHaveBeenCalled();
    await act(async () => { emit(); });
    await userEvent.click(trigger());
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue('Saved Alice');
    expect(H.setDoc).not.toHaveBeenCalled();
  });
});
