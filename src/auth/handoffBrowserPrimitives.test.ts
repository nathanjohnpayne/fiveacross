import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { HANDOFF_COMMIT_LOCK_NAME } from './handoffAttemptFence';
import {
  createBrowserHandoffLockRunner,
  createIndexedDbHandoffFenceStore,
} from './handoffBrowserPrimitives';

describe('browser handoff primitives', () => {
  it('persists and clears the versioned attempt fence in IndexedDB', async () => {
    const store = createIndexedDbHandoffFenceStore(new IDBFactory());
    const identity = { transactionId: 'transaction', ownerNonce: 'owner' };

    await store.write(identity);
    await expect(store.read()).resolves.toEqual(identity);
    await store.clear();
    await expect(store.read()).resolves.toBeNull();
  });

  it('requests the one named exclusive Web Lock with the caller deadline', async () => {
    const signal = new AbortController().signal;
    let request: { name: string; options: object } | null = null;
    const locks = createBrowserHandoffLockRunner({
      request: async <T>(name: string, options: object, work: () => T | Promise<T>) => {
        request = { name, options };
        return work();
      },
    });

    await expect(locks.withExclusive(signal, () => 'held')).resolves.toBe('held');
    expect(request).toEqual({
      name: HANDOFF_COMMIT_LOCK_NAME,
      options: { mode: 'exclusive', signal },
    });
  });
});
