const PROBE_STORE = 'probe';

export function waitForIndexedDbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('handoff-idb-probe-aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('handoff-idb-probe-failed'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('handoff-idb-probe-request-failed'));
  });
}

function openProbeDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PROBE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('handoff-idb-probe-open-failed'));
    request.onblocked = () => reject(new Error('handoff-idb-probe-open-blocked'));
  });
}

function deleteProbeDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('handoff-idb-probe-delete-failed'));
    request.onblocked = () => reject(new Error('handoff-idb-probe-delete-blocked'));
  });
}

function probeName(): string {
  const suffix =
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `fiveacrossAuthHandoffProbe-${suffix}`;
}

/**
 * Prove IndexedDB is actually writable, not merely present on the global.
 *
 * Every operation waits for its transaction's `complete` event. Request
 * success alone is not a commit boundary and is precisely the gap the Worker
 * isolation exists to close.
 */
export async function proveWritableIndexedDb(factory: IDBFactory): Promise<void> {
  const databaseName = probeName();
  const database = await openProbeDatabase(factory, databaseName);
  try {
    const write = database.transaction(PROBE_STORE, 'readwrite');
    write.objectStore(PROBE_STORE).put('value', 'key');
    await waitForIndexedDbTransaction(write);

    const read = database.transaction(PROBE_STORE, 'readonly');
    const valuePromise = requestResult(read.objectStore(PROBE_STORE).get('key'));
    const [value] = await Promise.all([valuePromise, waitForIndexedDbTransaction(read)]);
    if (value !== 'value') throw new Error('handoff-idb-probe-mismatch');

    const clear = database.transaction(PROBE_STORE, 'readwrite');
    clear.objectStore(PROBE_STORE).delete('key');
    await waitForIndexedDbTransaction(clear);
  } finally {
    database.close();
  }
  await deleteProbeDatabase(factory, databaseName);
}
