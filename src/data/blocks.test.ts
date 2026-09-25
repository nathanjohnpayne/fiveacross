import { beforeEach, describe, expect, it, vi } from 'vitest';

// specs/player-blocking.md — the write flows and the pure derivations
// (#689). Firestore is mocked: what is pinned is the EXACT batch contents,
// the unblock fallback's trigger and result, and the hidden-set arithmetic.

// `kind` records how each write was sent: 'batch' (a writeBatch, applied to
// the local cache optimistically) or 'transaction' (a runTransaction, which
// the SDK never applies locally before the server accepts it).
type Batch = {
  kind: 'batch' | 'transaction';
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
};

const H = vi.hoisted(() => ({
  eventId: 'event-a',
  batches: [] as Batch[],
  commitResults: [] as Array<'ok' | Error>,
  // The server listing `repairMissingPairs` reads: the caller's own direction
  // targets, or an Error for an offline read.
  ownTargets: [] as string[] | Error,
  ownQueries: [] as unknown[],
}));

vi.mock('../firebase', () => ({
  db: { kind: 'db' },
  get EVENT_ID() {
    return H.eventId;
  },
}));
vi.mock('firebase/firestore', () => {
  const open = (kind: Batch['kind']): Batch => {
    const next = H.commitResults.shift() ?? 'ok';
    const batch: Batch = {
      kind,
      set: vi.fn(),
      delete: vi.fn(),
      commit: vi.fn(() => (next === 'ok' ? Promise.resolve() : Promise.reject(next))),
    };
    H.batches.push(batch);
    return batch;
  };
  return {
    query: (...args: unknown[]) => ({ kind: 'query', args }),
    where: (...args: unknown[]) => ({ kind: 'where', args }),
    getDocsFromServer: async (q: unknown) => {
      H.ownQueries.push(q);
      if (H.ownTargets instanceof Error) throw H.ownTargets;
      return { docs: H.ownTargets.map((targetUid) => ({ data: () => ({ targetUid }) })) };
    },
    writeBatch: () => open('batch'),
    runTransaction: async (_db: unknown, update: (tx: Batch) => Promise<void>) => {
      const tx = open('transaction');
      await update(tx);
      return tx.commit();
    },
  };
});
vi.mock('./paths', () => ({
  blocksCol: (eventId: string) => `events/${eventId}/blocks`,
  blockRef: (owner: string, target: string, eventId: string) => `events/${eventId}/blocks/${owner}_${target}`,
  blockPairRef: (a: string, b: string, eventId: string) =>
    `events/${eventId}/blockPairs/${a < b ? `${a}_${b}` : `${b}_${a}`}`,
  blockPairId: (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`),
}));

import {
  blockPairId,
  blockPlayer,
  computeHiddenSet,
  hiddenUidsFromPairs,
  isPermissionDenied,
  reconcileOrphanPair,
  repairMissingPairs,
  unblockPlayer,
} from './blocks';

const denied = Object.assign(new Error('Missing or insufficient permissions.'), {
  code: 'permission-denied',
});

beforeEach(() => {
  H.eventId = 'event-a';
  H.batches = [];
  H.commitResults = [];
  H.ownTargets = [];
  H.ownQueries = [];
  vi.useFakeTimers({ now: 1_700_000_000_000 });
});

describe('blockPairId', () => {
  it('orders the two uids and is symmetric', () => {
    expect(blockPairId('alice', 'bob')).toBe('alice_bob');
    expect(blockPairId('bob', 'alice')).toBe('alice_bob');
  });
});

describe('blockPlayer', () => {
  it('commits the direction record and the ordered pair in ONE batch, under the captured Event', async () => {
    await blockPlayer({ me: 'bob', target: 'alice' });
    expect(H.batches).toHaveLength(1);
    const [batch] = H.batches;
    // A batch on purpose: a block queues durably offline (ADR 0006).
    expect(batch.kind).toBe('batch');
    expect(batch.set.mock.calls).toEqual([
      [
        'events/event-a/blocks/bob_alice',
        { ownerUid: 'bob', targetUid: 'alice', eventId: 'event-a', createdAt: 1_700_000_000_000 },
      ],
      ['events/event-a/blockPairs/alice_bob', { uids: ['alice', 'bob'], eventId: 'event-a' }],
    ]);
    expect(batch.delete).not.toHaveBeenCalled();
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it('addresses an explicit eventId rather than the live binding', async () => {
    await blockPlayer({ me: 'bob', target: 'alice', eventId: 'event-b' });
    expect(H.batches[0].set.mock.calls[1][0]).toBe('events/event-b/blockPairs/alice_bob');
  });

  it('refuses a self-block, the reserved system author, or a missing uid before touching Firestore', () => {
    expect(() => blockPlayer({ me: 'bob', target: 'bob' })).toThrow(/themselves/);
    expect(() => blockPlayer({ me: 'bob', target: 'system' })).toThrow(/server-written/);
    expect(() => blockPlayer({ me: '', target: 'bob' })).toThrow(/required/);
    expect(H.batches).toHaveLength(0);
  });

  it('propagates a rules denial (an online rejection is the caller’s to surface)', async () => {
    H.commitResults = [denied];
    await expect(blockPlayer({ me: 'bob', target: 'alice' })).rejects.toBe(denied);
  });
});

describe('unblockPlayer', () => {
  it('deletes the direction and the pair together when the block is one-way', async () => {
    await expect(unblockPlayer({ me: 'bob', target: 'alice' })).resolves.toEqual({ stillHidden: false });
    expect(H.batches).toHaveLength(1);
    // Server-only: a transaction, never an optimistic local batch delete.
    expect(H.batches[0].kind).toBe('transaction');
    expect(H.batches[0].delete.mock.calls).toEqual([
      ['events/event-a/blocks/bob_alice'],
      ['events/event-a/blockPairs/alice_bob'],
    ]);
  });

  it('on permission-denied (the other direction stands) retries with the direction alone and reports stillHidden', async () => {
    H.commitResults = [denied, 'ok', denied];
    await expect(unblockPlayer({ me: 'bob', target: 'alice' })).resolves.toEqual({ stillHidden: true });
    expect(H.batches).toHaveLength(3);
    expect(H.batches[1].delete.mock.calls).toEqual([['events/event-a/blocks/bob_alice']]);
    // The best-effort orphan cleanup, denied while Alice's direction stands.
    expect(H.batches[2].delete.mock.calls).toEqual([['events/event-a/blockPairs/alice_bob']]);
    expect(H.batches.map((b) => b.kind)).toEqual(['transaction', 'transaction', 'transaction']);
  });

  it('a concurrent mutual unblock: the pair left with no direction is deleted after the retry, and nothing stays hidden', async () => {
    H.commitResults = [denied, 'ok', 'ok'];
    await expect(unblockPlayer({ me: 'bob', target: 'alice' })).resolves.toEqual({ stillHidden: false });
    expect(H.batches).toHaveLength(3);
    expect(H.batches[2].delete.mock.calls).toEqual([['events/event-a/blockPairs/alice_bob']]);
  });

  it('a failed orphan cleanup never fails the unblock that already landed', async () => {
    const offline = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    H.commitResults = [denied, 'ok', offline];
    await expect(unblockPlayer({ me: 'bob', target: 'alice' })).resolves.toEqual({ stillHidden: true });
  });

  it('an interleaved mutual unblock: the direction-only retry denied (the other direction left meanwhile) retries the full batch once', async () => {
    H.commitResults = [denied, denied, 'ok'];
    await expect(unblockPlayer({ me: 'bob', target: 'alice' })).resolves.toEqual({ stillHidden: false });
    expect(H.batches).toHaveLength(3);
    expect(H.batches[2].delete.mock.calls).toEqual([
      ['events/event-a/blocks/bob_alice'],
      ['events/event-a/blockPairs/alice_bob'],
    ]);
  });

  it('a denial of that final full batch rethrows', async () => {
    H.commitResults = [denied, denied, denied];
    await expect(unblockPlayer({ me: 'bob', target: 'alice' })).rejects.toBe(denied);
    expect(H.batches).toHaveLength(3);
  });

  it('a failed direction-only retry rethrows and attempts no cleanup', async () => {
    const offline = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    H.commitResults = [denied, offline];
    await expect(unblockPlayer({ me: 'bob', target: 'alice' })).rejects.toBe(offline);
    expect(H.batches).toHaveLength(2);
  });

  it('rethrows any other error without a second attempt', async () => {
    const offline = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    H.commitResults = [offline];
    await expect(unblockPlayer({ me: 'bob', target: 'alice' })).rejects.toBe(offline);
    expect(H.batches).toHaveLength(1);
  });

  it('refuses a self-unblock', async () => {
    await expect(unblockPlayer({ me: 'bob', target: 'bob' })).rejects.toThrow(/themselves/);
    expect(H.batches).toHaveLength(0);
  });
});

describe('reconcileOrphanPair', () => {
  it('sends ONE server-only pair delete and reports whether it landed', async () => {
    await expect(reconcileOrphanPair({ me: 'bob', target: 'alice' })).resolves.toBe(true);
    expect(H.batches).toHaveLength(1);
    expect(H.batches[0].kind).toBe('transaction');
    expect(H.batches[0].delete.mock.calls).toEqual([['events/event-a/blockPairs/alice_bob']]);
  });

  it('never rejects: a denial (a direction still stands) or any other failure resolves false', async () => {
    H.commitResults = [denied, Object.assign(new Error('unavailable'), { code: 'unavailable' })];
    await expect(reconcileOrphanPair({ me: 'bob', target: 'alice' })).resolves.toBe(false);
    await expect(reconcileOrphanPair({ me: 'bob', target: 'alice' })).resolves.toBe(false);
    await expect(reconcileOrphanPair({ me: 'bob', target: 'bob' })).resolves.toBe(false);
    expect(H.batches).toHaveLength(2);
  });
});

describe('repairMissingPairs', () => {
  it('lists the caller’s own directions from the server and re-sets, server-only, only the pairs missing from the known set', async () => {
    H.ownTargets = ['alice', 'carol', 'dave'];
    await expect(
      repairMissingPairs({ me: 'bob', knownCounterparts: new Set(['alice']) }),
    ).resolves.toBe(2);
    expect(H.ownQueries).toEqual([
      { kind: 'query', args: ['events/event-a/blocks', { kind: 'where', args: ['ownerUid', '==', 'bob'] }] },
    ]);
    expect(H.batches.map((b) => b.kind)).toEqual(['transaction', 'transaction']);
    expect(H.batches.map((b) => b.set.mock.calls[0])).toEqual([
      ['events/event-a/blockPairs/bob_carol', { uids: ['bob', 'carol'], eventId: 'event-a' }],
      ['events/event-a/blockPairs/bob_dave', { uids: ['bob', 'dave'], eventId: 'event-a' }],
    ]);
  });

  it('a denied re-set (the direction left meanwhile) is skipped, not thrown; an offline listing or a transient re-set failure rejects so the caller can retry', async () => {
    H.ownTargets = ['alice', 'carol'];
    H.commitResults = [denied, 'ok'];
    await expect(repairMissingPairs({ me: 'bob', knownCounterparts: new Set() })).resolves.toBe(1);
    const offline = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    H.batches = [];
    H.commitResults = [offline, 'ok'];
    await expect(repairMissingPairs({ me: 'bob', knownCounterparts: new Set() })).rejects.toBe(offline);
    // Every target is still tried before the rejection.
    expect(H.batches).toHaveLength(2);
    H.ownTargets = offline;
    await expect(repairMissingPairs({ me: 'bob', knownCounterparts: new Set() })).rejects.toBe(offline);
  });
});

describe('isPermissionDenied', () => {
  it('matches only the FirebaseError code', () => {
    expect(isPermissionDenied(denied)).toBe(true);
    expect(isPermissionDenied({ code: 'unavailable' })).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
    expect(isPermissionDenied(new Error('permission-denied'))).toBe(false);
  });
});

describe('hiddenUidsFromPairs', () => {
  it('collects the counterpart of every pair naming the viewer and ignores malformed rows', () => {
    const hidden = hiddenUidsFromPairs(
      [
        { uids: ['alice', 'bob'] },
        { uids: ['bob', 'carol'] },
        { uids: ['alice', 'carol'] },
        { uids: ['bob'] as unknown as [string, string] },
        { uids: 'bob_dave' as unknown as [string, string] },
        { uids: ['bob', 7] as unknown as [string, string] },
      ],
      'bob',
    );
    expect([...hidden].sort()).toEqual(['alice', 'carol']);
  });
});

describe('computeHiddenSet', () => {
  const committed = new Set(['alice']);
  it('a settled snapshot publishes exactly the current set', () => {
    expect([...computeHiddenSet(new Set(['carol']), committed, false)]).toEqual(['carol']);
    expect([...computeHiddenSet(new Set(), committed, false)]).toEqual([]);
  });
  it('a pending block hides immediately, and a pending unblock keeps the last committed uid hidden', () => {
    expect([...computeHiddenSet(new Set(['alice', 'carol']), committed, true)].sort()).toEqual(['alice', 'carol']);
    expect([...computeHiddenSet(new Set(), committed, true)]).toEqual(['alice']);
  });
});
