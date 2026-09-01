import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../types';

const {
  activeEvent,
  batchCommitSpy,
  batchDeleteSpy,
  batchSetSpy,
  getDocFromCacheSpy,
  getDocFromServerSpy,
  getDocSpy,
  setDocSpy,
  writeBatchSpy,
} = vi.hoisted(() => {
  const batchCommitSpy = vi.fn();
  const batchDeleteSpy = vi.fn();
  const batchSetSpy = vi.fn();
  return {
    activeEvent: { id: 'event-a' },
    batchCommitSpy,
    batchDeleteSpy,
    batchSetSpy,
    getDocFromCacheSpy: vi.fn(),
    getDocFromServerSpy: vi.fn(),
    getDocSpy: vi.fn(),
    setDocSpy: vi.fn(),
    writeBatchSpy: vi.fn(() => ({
      commit: batchCommitSpy,
      delete: batchDeleteSpy,
      set: batchSetSpy,
    })),
  };
});

vi.mock('../firebase', () => ({
  db: { app: { name: 'event-scope-test' } },
  get EVENT_ID() {
    return activeEvent.id;
  },
}));

vi.mock('./dayMeta', () => ({ dropHeldHonorPins: vi.fn() }));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
    getDoc: getDocSpy,
    getDocFromCache: getDocFromCacheSpy,
    getDocFromServer: getDocFromServerSpy,
    setDoc: setDocSpy,
    writeBatch: writeBatchSpy,
  };
});

import {
  __resetPendingMomentsMemoryForTests,
  broadcastBingo,
  createRetractionFallObserver,
  drainRetractions,
  dropPendingWins,
  enqueueFirstBingoMoment,
  enqueueRetraction,
  enqueueWinMoments,
  getConfirmState,
  peekPendingMoments,
  peekRetractions,
  pendingActionGeneration,
  pendingBingoDayIndexes,
  resetConfirmStates,
  resetPendingMoments,
  resetRetractions,
} from './moments';

const flushMicrotasks = async (turns = 20): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const boardCells = (marked: readonly number[]): Cell[] =>
  Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `item-${index}`,
    text: `Square ${index}`,
    free: index === 12,
    marked: index === 12 || marked.includes(index),
    markedAt: index === 12 || marked.includes(index) ? 1 : null,
    status: 'confirmed',
  }));

beforeEach(() => {
  activeEvent.id = 'event-a';
  vi.clearAllMocks();
  getDocFromCacheSpy.mockRejectedValue(new Error('not cached'));
  getDocFromServerSpy.mockResolvedValue({ exists: () => false, data: () => ({}) });
  getDocSpy.mockResolvedValue({ exists: () => false, data: () => ({}) });
  setDocSpy.mockResolvedValue(undefined);
  batchCommitSpy.mockResolvedValue(undefined);
  resetConfirmStates();
  resetPendingMoments();
  resetRetractions();
});

describe('Event-scoped Moment client state (#807)', () => {
  it('keeps pending flags, generations, hydration, and confirm state inside their captured Event', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    try {
      enqueueWinMoments({
        uid: 'u1',
        bingoTransition: true,
        blackoutTransition: false,
        dayIndex: 2,
        eventId: 'event-a',
      });
      enqueueFirstBingoMoment('u1', 2);
      const confirmA = getConfirmState('u1');
      confirmA.seenPending.add('claim-a');
      dropPendingWins('generation-owner', { bingo: true });
      expect(pendingActionGeneration('generation-owner')).toBe(1);

      activeEvent.id = 'event-b';
      expect(peekPendingMoments('u1')).toEqual({ bingo: false, blackout: false, firstBingo: false });
      expect(pendingActionGeneration('u1')).toBe(0);
      expect(pendingActionGeneration('generation-owner')).toBe(0);
      const confirmB = getConfirmState('u1');
      expect(confirmB).not.toBe(confirmA);
      expect(confirmB.seenPending).toEqual(new Set());
      expect(getConfirmState('u1', confirmA.eventId)).toBe(confirmA);

      // An API continuation that began under A may land after the live binding is
      // already B. Its captured Event must win over the mutable binding.
      enqueueWinMoments({
        uid: 'u1',
        bingoTransition: true,
        blackoutTransition: false,
        dayIndex: 5,
        eventId: 'event-a',
      });
      expect(peekPendingMoments('u1').bingo).toBe(false);
      expect(values.has('gcb:pending-moments:event-b:u1')).toBe(false);

      activeEvent.id = 'event-a';
      expect(peekPendingMoments('u1')).toEqual({ bingo: true, blackout: false, firstBingo: true });
      expect(pendingBingoDayIndexes('u1')).toEqual([2, 5]);
      expect(pendingActionGeneration('generation-owner')).toBe(1);
      expect(getConfirmState('u1')).toBe(confirmA);

      // Model a reload: Event B must not hydrate A's durable pending queue.
      __resetPendingMomentsMemoryForTests();
      activeEvent.id = 'event-b';
      expect(peekPendingMoments('u1').bingo).toBe(false);
      activeEvent.id = 'event-a';
      expect(peekPendingMoments('u1').bingo).toBe(true);
      expect(pendingBingoDayIndexes('u1')).toEqual([2, 5]);
    } finally {
      resetPendingMoments();
      vi.unstubAllGlobals();
    }
  });

  it('ignores a queued observer callback after its Event is no longer active', () => {
    const observeA = createRetractionFallObserver('u1', 3);
    observeA({
      fromCache: false,
      hasPendingWrites: false,
      boardUid: 'u1',
      cells: boardCells([0, 1, 2, 3, 4]),
    });

    activeEvent.id = 'event-b';
    observeA({
      fromCache: false,
      hasPendingWrites: false,
      boardUid: 'u1',
      cells: boardCells([0, 1, 2, 3]),
    });

    expect(pendingActionGeneration('u1')).toBe(0);
    expect(peekRetractions('u1')).toEqual([]);
    expect(getDocFromServerSpy).not.toHaveBeenCalled();
  });

  it('keeps a failed A retraction and its retry timer pinned to A while B is active', async () => {
    vi.useFakeTimers();
    const firstCommit = deferred<void>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      getDocFromServerSpy.mockImplementation((ref: { path: string }) => {
        if (ref.path === 'events/event-a/days/3/boards/u1') {
          return Promise.resolve({ exists: () => true, data: () => ({ uid: 'u1', cells: boardCells([]) }) });
        }
        if (ref.path === 'events/event-a/moments/u1-bingo-d3') {
          return Promise.resolve({
            exists: () => true,
            data: () => ({ kind: 'bingo', uid: 'u1', dayIndex: 3 }),
          });
        }
        return Promise.resolve({ exists: () => false, data: () => ({}) });
      });
      batchCommitSpy.mockImplementationOnce(() => firstCommit.promise);

      enqueueRetraction('u1', { bingo: true, bingoDayIndex: 3 });
      drainRetractions('u1', { dayIndex: 3, bingoStands: false, blackoutStands: false });
      await flushMicrotasks();
      expect(batchCommitSpy).toHaveBeenCalledTimes(1);

      activeEvent.id = 'event-b';
      firstCommit.reject(new Error('transient denial'));
      await flushMicrotasks();
      expect(peekRetractions('u1')).toEqual([]);

      activeEvent.id = 'event-a';
      expect(peekRetractions('u1')).toEqual(['bingo:3']);
      activeEvent.id = 'event-b';

      await vi.advanceTimersByTimeAsync(2_000);
      expect(getDocFromServerSpy.mock.calls.map(([ref]) => (ref as { path: string }).path)).toContain(
        'events/event-a/days/3/boards/u1',
      );
      expect(
        getDocFromServerSpy.mock.calls.some(([ref]) =>
          (ref as { path: string }).path.startsWith('events/event-b/'),
        ),
      ).toBe(false);
      expect(batchDeleteSpy).toHaveBeenCalledWith({
        path: 'events/event-a/moments/u1-bingo-d3',
      });
      expect(batchSetSpy).toHaveBeenCalledWith(
        { path: 'events/event-a/momentRetractions/u1-bingo' },
        expect.objectContaining({ uid: 'u1', kind: 'bingo', dayIndex: 3 }),
      );
      expect(batchSetSpy).toHaveBeenCalledWith(
        { path: 'events/event-a/momentRetractions/u1-bingo-d3' },
        expect.objectContaining({ uid: 'u1', kind: 'bingo', dayIndex: 3 }),
      );
      const writePaths = [...batchDeleteSpy.mock.calls, ...batchSetSpy.mock.calls].map(
        ([ref]) => (ref as { path: string }).path,
      );
      expect(writePaths.every((path) => path.startsWith('events/event-a/'))).toBe(true);
      expect(peekRetractions('u1')).toEqual([]);
      activeEvent.id = 'event-a';
      expect(peekRetractions('u1')).toEqual([]);
    } finally {
      consoleError.mockRestore();
      resetRetractions();
      vi.useRealTimers();
    }
  });

  it('pins a per-card broadcast to the Event active before its async legacy check', async () => {
    const legacyLookup = deferred<never>();
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) => {
      if (ref.path === 'events/event-a/moments/u1-bingo') return legacyLookup.promise;
      return Promise.reject(new Error('not cached'));
    });

    broadcastBingo({ uid: 'u1', displayName: 'Alice', photoURL: null }, 3);
    activeEvent.id = 'event-b';
    legacyLookup.reject(new Error('not cached'));
    await flushMicrotasks();

    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(setDocSpy.mock.calls[0][0].path).toBe('events/event-a/moments/u1-bingo-d3');
  });
});
