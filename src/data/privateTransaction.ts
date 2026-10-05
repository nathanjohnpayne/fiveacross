import { runTransaction, type Firestore, type Transaction } from 'firebase/firestore';

/** A captured private action supplies the actor/database fence. This facade
 * preserves SDK receivers, overloads and chaining across transaction retries. */
interface PrivateTransactionLease {
  db: Firestore;
  assertCurrent(): void;
  guard<T>(operation: () => Promise<T>): Promise<T>;
}

export function runPrivateTransaction<T>(
  lease: PrivateTransactionLease,
  operation: (transaction: Transaction) => Promise<T>,
  /** Observe actual commit for cleanup even if the actor retires before acknowledgment. */
  onCommitted?: () => void,
): Promise<T> {
  return lease.guard(async () => {
    const result = await runTransaction(lease.db, (tx) => {
      lease.assertCurrent();
      const guarded = new Proxy(tx, {
        get(target, key) {
          const method = Reflect.get(target, key, target);
          if (typeof method !== 'function') return method;
          return (...args: unknown[]) => {
            lease.assertCurrent();
            if (key === 'get') return lease.guard(async () => Reflect.apply(method, target, args));
            const result = Reflect.apply(method, target, args);
            return result === target ? guarded : result;
          };
        },
      });
      return lease.guard(() => operation(guarded));
    });
    onCommitted?.();
    return result;
  });
}
