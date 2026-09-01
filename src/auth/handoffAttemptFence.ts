export const HANDOFF_COMMIT_LOCK_NAME = 'fiveacross:auth-handoff-commit';

export interface HandoffAttemptIdentity {
  transactionId: string;
  ownerNonce: string;
}

export interface HandoffAttemptLease {
  clear(): Promise<boolean>;
}

export interface HandoffLockRunner {
  withExclusive<T>(signal: AbortSignal | undefined, work: () => T | Promise<T>): Promise<T>;
}

export interface HandoffFenceStore {
  read(): Promise<unknown>;
  write(identity: HandoffAttemptIdentity): Promise<void>;
  clear(): Promise<void>;
}

interface HandoffAttemptFenceDependencies {
  store: HandoffFenceStore;
  locks: HandoffLockRunner;
}

function matchesAttempt(
  stored: HandoffAttemptIdentity | null,
  expected: HandoffAttemptIdentity,
): boolean {
  return (
    stored?.transactionId === expected.transactionId &&
    stored.ownerNonce === expected.ownerNonce
  );
}

async function readAttempt(store: HandoffFenceStore): Promise<HandoffAttemptIdentity | null> {
  const parsed = await store.read();
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Partial<HandoffAttemptIdentity>;
  return typeof value.transactionId === 'string' && typeof value.ownerNonce === 'string'
    ? { transactionId: value.transactionId, ownerNonce: value.ownerNonce }
    : null;
}

export function createHandoffAttemptFence({ store, locks }: HandoffAttemptFenceDependencies) {
  return {
    register(identity: HandoffAttemptIdentity, signal?: AbortSignal): Promise<boolean> {
      return locks.withExclusive(signal, async () => {
        await store.write(identity);
        return matchesAttempt(await readAttempt(store), identity);
      });
    },

    withCurrentAttempt<T>(
      identity: HandoffAttemptIdentity,
      signal: AbortSignal | undefined,
      work: (lease: HandoffAttemptLease) => T | Promise<T>,
    ): Promise<{ kind: 'superseded' } | { kind: 'current'; value: T }> {
      return locks.withExclusive(signal, async () => {
        if (!matchesAttempt(await readAttempt(store), identity)) {
          return { kind: 'superseded' } as const;
        }

        const lease: HandoffAttemptLease = {
          clear: async () => {
            if (!matchesAttempt(await readAttempt(store), identity)) return false;
            await store.clear();
            return true;
          },
        };

        return { kind: 'current', value: await work(lease) } as const;
      });
    },
  };
}
