import { describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_COMMIT_LOCK_NAME,
  createHandoffAttemptFence,
  type HandoffLockRunner,
} from './handoffAttemptFence';

describe('handoff attempt fence', () => {
  it('does not let an older owner with the same transaction delete a newer attempt', async () => {
    const values = new Map<string, string>();
    const store = {
      read: async () => JSON.parse(values.get('attempt') ?? 'null') as unknown,
      write: async (value: unknown) => void values.set('attempt', JSON.stringify(value)),
      clear: async () => void values.delete('attempt'),
    };
    const acquiredNames: string[] = [];
    const locks: HandoffLockRunner = {
      withExclusive: async (_signal, work) => {
        acquiredNames.push(HANDOFF_COMMIT_LOCK_NAME);
        return work();
      },
    };
    const fence = createHandoffAttemptFence({ store, locks });
    const older = { transactionId: 'same-transaction', ownerNonce: 'older-tab' };
    const newer = { transactionId: 'same-transaction', ownerNonce: 'newer-tab' };
    const olderWork = vi.fn();

    expect(await fence.register(older)).toBe(true);
    expect(await fence.register(newer)).toBe(true);
    expect(await fence.withCurrentAttempt(older, undefined, olderWork)).toEqual({
      kind: 'superseded',
    });
    expect(olderWork).not.toHaveBeenCalled();
    expect(await fence.withCurrentAttempt(newer, undefined, async (lease) => lease.clear())).toEqual({
      kind: 'current',
      value: true,
    });
    expect(acquiredNames).toEqual([
      HANDOFF_COMMIT_LOCK_NAME,
      HANDOFF_COMMIT_LOCK_NAME,
      HANDOFF_COMMIT_LOCK_NAME,
      HANDOFF_COMMIT_LOCK_NAME,
    ]);
  });
});
