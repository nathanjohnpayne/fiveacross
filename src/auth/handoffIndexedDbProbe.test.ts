import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  proveWritableIndexedDb,
  waitForIndexedDbTransaction,
} from './handoffIndexedDbProbe';

describe('handoff IndexedDB capability proof', () => {
  it('completes a write/read/delete round trip', async () => {
    await expect(proveWritableIndexedDb(new IDBFactory())).resolves.toBeUndefined();
  });

  it('does not resolve on request success before the transaction completes', async () => {
    const transaction = {} as IDBTransaction;
    const settled = vi.fn();
    const completion = waitForIndexedDbTransaction(transaction).then(settled);

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    transaction.oncomplete?.call(transaction, new Event('complete'));
    await completion;
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(['abort', 'error'] as const)('rejects when the transaction emits %s', async (kind) => {
    const transaction = {} as IDBTransaction;
    const completion = waitForIndexedDbTransaction(transaction);

    if (kind === 'abort') transaction.onabort?.call(transaction, new Event('abort'));
    else transaction.onerror?.call(transaction, new Event('error'));

    await expect(completion).rejects.toThrow(/handoff-idb-probe-(aborted|failed)/);
  });
});
