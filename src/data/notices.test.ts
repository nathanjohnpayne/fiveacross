import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  auth: { currentUser: null as null | { uid: string; displayName: string; getIdTokenResult: () => Promise<{ claims: { name?: unknown } }> } },
  setDoc: vi.fn(() => Promise.resolve()),
}));
vi.mock('../firebase', () => ({ auth: H.auth, db: {}, EVENT_ID: 'cruise' }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})), doc: vi.fn(() => ({ id: 'notice-id' })),
  setDoc: H.setDoc, deleteDoc: vi.fn(), updateDoc: vi.fn(),
}));
import { postNotice } from './notices';

const args = { uid: 'admin', title: ' Title ', body: ' Body ', pinned: true, dayIndex: 7 };
const user = (name: unknown) => ({ uid: 'admin', displayName: 'Untrusted profile label', getIdTokenResult: async () => ({ claims: { name } }) });

describe('Notice token-bound attribution (specs/admin-messages.md, #1426)', () => {
  beforeEach(() => { H.setDoc.mockClear(); H.auth.currentUser = user('Google Admin'); });
  it('writes the exact token name, ignoring a caller label and User displayName', async () => {
    await expect(postNotice({ ...args, displayName: 'Forged' } as typeof args)).resolves.toBe('notice-id');
    expect(H.setDoc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      uid: 'admin', displayName: 'Google Admin', title: 'Title', body: 'Body', dayIndex: 7,
    }));
  });
  it('preserves a 100-character token name exactly without trimming or clamping', async () => {
    const name = ` ${'N'.repeat(98)} `;
    H.auth.currentUser = user(name);
    await postNotice(args);
    expect(H.setDoc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ displayName: name }));
  });
  it('accepts 50 astral characters at the measured 100 UTF-16-unit Rules boundary', async () => {
    const name = '😀'.repeat(50);
    H.auth.currentUser = user(name);
    await postNotice(args);
    expect(H.setDoc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ displayName: name }));
  });
  it('refuses 51 astral characters above the measured Rules boundary before writing', async () => {
    H.auth.currentUser = user('😀'.repeat(51));
    await expect(postNotice(args)).rejects.toThrow();
    expect(H.setDoc).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 42, '', 'x'.repeat(101)])('refuses unusable token name %j before writing', async name => {
    H.auth.currentUser = user(name);
    await expect(postNotice(args)).rejects.toThrow();
    expect(H.setDoc).not.toHaveBeenCalled();
  });
  it.each([null, { ...user('Other'), uid: 'other' }])('refuses absent or different authenticated account', async current => {
    H.auth.currentUser = current;
    await expect(postNotice(args)).rejects.toThrow();
    expect(H.setDoc).not.toHaveBeenCalled();
  });
  it('does not transfer a compose request to another account while token lookup is pending', async () => {
    let resolve!: (token: { claims: { name: string } }) => void;
    H.auth.currentUser = { ...user('Old'), getIdTokenResult: () => new Promise(r => { resolve = r; }) };
    const pending = postNotice(args);
    H.auth.currentUser = { ...user('New'), uid: 'other' };
    resolve({ claims: { name: 'Old' } });
    await expect(pending).rejects.toThrow();
    expect(H.setDoc).not.toHaveBeenCalled();
  });
});
