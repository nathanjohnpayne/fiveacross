import {
  HANDOFF_COMMIT_LOCK_NAME,
  type HandoffAttemptIdentity,
  type HandoffFenceStore,
  type HandoffLockRunner,
} from './handoffAttemptFence';

const FENCE_DATABASE = 'fiveacrossAuthHandoff';
const FENCE_DATABASE_VERSION = 1;
const FENCE_STORE = 'attempts';
const CURRENT_ATTEMPT_KEY = 'current';
const FENCE_RECORD_VERSION = 1;

interface StoredFenceRecord extends HandoffAttemptIdentity {
  key: typeof CURRENT_ATTEMPT_KEY;
  version: typeof FENCE_RECORD_VERSION;
}

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; signal?: AbortSignal },
    work: () => T | Promise<T>,
  ): Promise<T>;
}

function openFenceDatabase(indexedDb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(FENCE_DATABASE, FENCE_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FENCE_STORE)) {
        database.createObjectStore(FENCE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('handoff-fence-open-failed'));
    request.onblocked = () => reject(new Error('handoff-fence-open-blocked'));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('handoff-fence-aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('handoff-fence-failed'));
  });
}

async function withFenceDatabase<T>(
  indexedDb: IDBFactory,
  work: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  const database = await openFenceDatabase(indexedDb);
  try {
    return await work(database);
  } finally {
    database.close();
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('handoff-fence-request-failed'));
  });
}

export function createIndexedDbHandoffFenceStore(indexedDb: IDBFactory): HandoffFenceStore {
  return {
    read: () =>
      withFenceDatabase(indexedDb, async (database) => {
        const transaction = database.transaction(FENCE_STORE, 'readonly');
        const valuePromise = requestResult(
          transaction.objectStore(FENCE_STORE).get(CURRENT_ATTEMPT_KEY),
        );
        const [value] = await Promise.all([valuePromise, waitForTransaction(transaction)]);
        if (typeof value !== 'object' || value === null) return null;
        const record = value as Partial<StoredFenceRecord>;
        if (
          record.version !== FENCE_RECORD_VERSION ||
          record.key !== CURRENT_ATTEMPT_KEY ||
          typeof record.transactionId !== 'string' ||
          typeof record.ownerNonce !== 'string'
        ) {
          return null;
        }
        return { transactionId: record.transactionId, ownerNonce: record.ownerNonce };
      }),

    write: (identity) =>
      withFenceDatabase(indexedDb, async (database) => {
        const transaction = database.transaction(FENCE_STORE, 'readwrite');
        transaction.objectStore(FENCE_STORE).put({
          key: CURRENT_ATTEMPT_KEY,
          version: FENCE_RECORD_VERSION,
          ...identity,
        } satisfies StoredFenceRecord);
        await waitForTransaction(transaction);
      }),

    clear: () =>
      withFenceDatabase(indexedDb, async (database) => {
        const transaction = database.transaction(FENCE_STORE, 'readwrite');
        transaction.objectStore(FENCE_STORE).delete(CURRENT_ATTEMPT_KEY);
        await waitForTransaction(transaction);
      }),
  };
}

export function createBrowserHandoffLockRunner(lockManager: LockManagerLike): HandoffLockRunner {
  return {
    withExclusive: (signal, work) =>
      lockManager.request(
        HANDOFF_COMMIT_LOCK_NAME,
        signal === undefined ? { mode: 'exclusive' } : { mode: 'exclusive', signal },
        work,
      ),
  };
}
