import { beforeEach, describe, expect, it, vi } from 'vitest';

// specs/player-blocking.md — the write flows and the pure derivations
// (#689). Firestore is mocked: what is pinned is the EXACT batch contents,
// the unblock fallback's trigger and result, and the hidden-set arithmetic.

type Batch = { set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn> };

const H = vi.hoisted(() => ({
  eventId: 'event-a',
  batches: [] as Batch[],
  commitResults: [] as Array<'ok' | Error>,
}));

vi.mock('../firebase', () => ({
  db: { kind: 'db' },
  get EVENT_ID() {
    return H.eventId;
  },
}));
vi.mock('firebase/firestore', () => ({
  writeBatch: () => {
    const next = H.commitResults.shift() ?? 'ok';
    const batch: Batch = {
      set: vi.fn(),
      delete: vi.fn(),
      commit: vi.fn(() => (next === 'ok' ? Promise.resolve() : Promise.reject(next))),
    };
    H.batches.push(batch);
    return batch;
  },
}));
vi.mock('./paths', () => ({
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
  unblockPlayer,
} from './blocks';

const denied = Object.assign(new Error('Missing or insufficient permissions.'), {
  code: 'permission-denied',
});

beforeEach(() => {
  H.eventId = 'event-a';
  H.batches = [];
  H.commitResults = [];
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

  it('refuses a self-block or a missing uid before touching Firestore', () => {
    expect(() => blockPlayer({ me: 'bob', target: 'bob' })).toThrow(/themselves/);
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
    expect(H.batches[0].delete.mock.calls).toEqual([
      ['events/event-a/blocks/bob_alice'],
      ['events/event-a/blockPairs/alice_bob'],
    ]);
  });

  it('on permission-denied (the other direction stands) retries with the direction alone and reports stillHidden', async () => {
    H.commitResults = [denied, 'ok'];
    await expect(unblockPlayer({ me: 'bob', target: 'alice' })).resolves.toEqual({ stillHidden: true });
    expect(H.batches).toHaveLength(2);
    expect(H.batches[1].delete.mock.calls).toEqual([['events/event-a/blocks/bob_alice']]);
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
