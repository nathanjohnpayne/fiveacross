// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeApp: vi.fn(),
  initializeAuth: vi.fn(),
  setPersistence: vi.fn(),
  connectAuthEmulator: vi.fn(),
  signInWithCustomToken: vi.fn(),
  updateCurrentUser: vi.fn(),
  proveWritableIndexedDb: vi.fn(),
  fingerprintHandoffSession: vi.fn(),
  indexedDBLocalPersistence: { type: 'LOCAL' },
  inMemoryPersistence: { type: 'NONE' },
}));

vi.mock('firebase/app', () => ({ initializeApp: mocks.initializeApp }));
vi.mock('firebase/auth', () => ({
  connectAuthEmulator: mocks.connectAuthEmulator,
  indexedDBLocalPersistence: mocks.indexedDBLocalPersistence,
  inMemoryPersistence: mocks.inMemoryPersistence,
  initializeAuth: mocks.initializeAuth,
  setPersistence: mocks.setPersistence,
  signInWithCustomToken: mocks.signInWithCustomToken,
  updateCurrentUser: mocks.updateCurrentUser,
}));
vi.mock('./handoffIndexedDbProbe', () => ({
  proveWritableIndexedDb: mocks.proveWritableIndexedDb,
}));
vi.mock('./handoffSessionFingerprint', () => ({
  fingerprintHandoffSession: mocks.fingerprintHandoffSession,
}));

import { createFirebaseHandoffCommitWorkerAdapter } from './firebaseHandoffCommitWorkerAdapter';

const attempt = { transactionId: 'transaction', ownerNonce: 'owner' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.initializeApp
    .mockReturnValueOnce({ name: 'isolated' })
    .mockReturnValueOnce({ name: '[DEFAULT]' });
  mocks.initializeAuth
    .mockReturnValueOnce({ tenantId: null })
    .mockReturnValueOnce({ tenantId: null, authStateReady: vi.fn().mockResolvedValue(undefined) });
  mocks.setPersistence.mockResolvedValue(undefined);
  mocks.proveWritableIndexedDb.mockResolvedValue(undefined);
  mocks.signInWithCustomToken.mockResolvedValue({
    user: { uid: 'user', refreshToken: 'refresh-token' },
  });
  mocks.fingerprintHandoffSession.mockResolvedValue('session-digest');
  mocks.updateCurrentUser.mockResolvedValue(undefined);
  mocks.indexedDBLocalPersistence.type = 'LOCAL';
});

describe('Firebase handoff commit Worker adapter', () => {
  it('defers the persistent default Auth entirely until the locked commit phase', async () => {
    const indexedDb = {} as IDBFactory;
    const adapter = createFirebaseHandoffCommitWorkerAdapter(indexedDb);

    await adapter.initialize({
      attempt,
      firebaseOptions: { apiKey: 'api-key', projectId: 'project' },
      tenantId: 'tenant',
      emulatorUrl: 'http://127.0.0.1:9099',
    });
    expect(mocks.proveWritableIndexedDb).toHaveBeenCalledWith(indexedDb);
    expect(mocks.initializeApp).not.toHaveBeenCalled();
    expect(mocks.initializeAuth).not.toHaveBeenCalled();
    expect(mocks.setPersistence).not.toHaveBeenCalled();

    const candidate = await adapter.prepare({ attempt, customToken: 'custom-token' });

    expect(mocks.initializeApp.mock.calls[0]).toHaveLength(2);
    expect(mocks.initializeAuth).toHaveBeenNthCalledWith(
      1,
      { name: 'isolated' },
      { persistence: mocks.inMemoryPersistence, popupRedirectResolver: undefined },
    );
    expect(candidate).toEqual({ uid: 'user', refreshTokenDigest: 'session-digest' });
    expect(mocks.setPersistence).not.toHaveBeenCalled();

    await adapter.commit();
    expect(mocks.initializeApp).toHaveBeenNthCalledWith(2, {
      apiKey: 'api-key',
      projectId: 'project',
    });
    expect(mocks.initializeApp.mock.calls[1]).toHaveLength(1);
    expect(mocks.initializeAuth).toHaveBeenNthCalledWith(
      2,
      { name: '[DEFAULT]' },
      { persistence: mocks.indexedDBLocalPersistence, popupRedirectResolver: undefined },
    );
    expect(mocks.updateCurrentUser).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant' }),
      { uid: 'user', refreshToken: 'refresh-token' },
    );
    expect(mocks.connectAuthEmulator).toHaveBeenCalledTimes(2);
    expect(mocks.connectAuthEmulator).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tenantId: 'tenant' }),
      'http://127.0.0.1:9099',
      { disableWarnings: true },
    );
    expect(mocks.connectAuthEmulator).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tenantId: 'tenant' }),
      'http://127.0.0.1:9099',
      { disableWarnings: true },
    );
  });

  it('fails before Firebase initialization when IndexedDB is not really writable', async () => {
    mocks.proveWritableIndexedDb.mockRejectedValue(new Error('private mode'));
    const adapter = createFirebaseHandoffCommitWorkerAdapter({} as IDBFactory);

    await expect(
      adapter.initialize({
        attempt,
        firebaseOptions: { apiKey: 'api-key' },
        tenantId: null,
        emulatorUrl: null,
      }),
    ).rejects.toThrow('private mode');
    expect(mocks.initializeApp).not.toHaveBeenCalled();
  });

  it('refuses a Firebase persistence implementation that fell back from IndexedDB', async () => {
    mocks.indexedDBLocalPersistence.type = 'NONE';
    const adapter = createFirebaseHandoffCommitWorkerAdapter({} as IDBFactory);

    await expect(
      adapter.initialize({
        attempt,
        firebaseOptions: { apiKey: 'api-key' },
        tenantId: null,
        emulatorUrl: null,
      }),
    ).rejects.toThrow('handoff-worker-indexeddb-unavailable');
    expect(mocks.initializeApp).not.toHaveBeenCalled();
  });

  it('never reports a candidate with a blank refresh token', async () => {
    mocks.signInWithCustomToken.mockResolvedValue({ user: { uid: 'user', refreshToken: '' } });
    const adapter = createFirebaseHandoffCommitWorkerAdapter({} as IDBFactory);
    await adapter.initialize({
      attempt,
      firebaseOptions: { apiKey: 'api-key' },
      tenantId: null,
      emulatorUrl: null,
    });

    await expect(adapter.prepare({ attempt, customToken: 'custom-token' })).rejects.toThrow(
      'handoff-worker-token-missing',
    );
    expect(mocks.fingerprintHandoffSession).not.toHaveBeenCalled();
    await expect(adapter.commit()).rejects.toThrow('handoff-worker-not-prepared');
  });

  it('pins the Firebase Auth implementation whose persistence boundary is audited', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    expect(lock.packages['node_modules/firebase']?.version).toBe('12.18.0');
    expect(lock.packages['node_modules/@firebase/auth']?.version).toBe('1.13.5');
  });
});
