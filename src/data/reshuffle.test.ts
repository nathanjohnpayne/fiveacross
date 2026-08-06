import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cell, DayDef, EventDoc, ItemDoc } from '../types';

// Covers specs/reshuffle.md — the `reshuffleBoard` write path (#378). Proves the
// deal SOURCE (the same frozen Day Snapshot, never a live query), the exclusion
// posture (kept cards only — the discarded card's Prompts return to the pool),
// the write SHAPE (exactly three docs — board + counter + per-spend marker
// (#463) — in ONE transaction), the eligibility refusals, that it FAILS rather
// than queues offline, and that no other Player's card is touched. The
// sampling/stratification math itself is proven in src/game/logic.test.ts.

const EVENT_ID = 'test-event';

const H = vi.hoisted(() => ({
  event: null as { days?: DayDef[]; settings?: Partial<EventDoc['settings']> } | null,
  itemsById: new Map<string, Partial<ItemDoc>>(),
  dayBoards: new Map<number, { uid: string; seed?: number; cells: Cell[]; easyMixRatio?: number } | null>(),
  player: null as Record<string, unknown> | null,
  getDoc: vi.fn(),
  // Typed args so `mock.calls[n][0]` is reachable (a bare `vi.fn(async () => {})`
  // infers a zero-length tuple and every call-site index is a type error).
  setDoc: vi.fn(async (..._args: unknown[]) => {}),
  batchSet: vi.fn(),
  batchCommit: vi.fn(async () => {}),
  txSet: vi.fn(),
  txGet: vi.fn(),
  // `runTransaction` REJECTS offline rather than queueing — that failure mode is
  // the whole contract (Codex P1 on #383). `offline: true` makes this double
  // behave like the real SDK does with no connection.
  offline: false,
}));

vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));

vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref;
    return ref;
  };
  return {
    doc: (...args: unknown[]) => makeRef('doc', args),
    collection: (...args: unknown[]) => makeRef('collection', args),
    query: (...args: unknown[]) => ({ query: args }),
    where: (...args: unknown[]) => ({ where: args }),
    getDoc: H.getDoc,
    getDocFromCache: vi.fn(),
    getDocFromServer: vi.fn(),
    getDocs: vi.fn(),
    writeBatch: () => ({ set: H.batchSet, commit: H.batchCommit }),
    addDoc: vi.fn(),
    increment: vi.fn(),
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      if (H.offline) throw new Error('Failed to get document because the client is offline.');
      const tx = {
        get: async (ref: { args?: unknown[] }) => {
          H.txGet(ref);
          return route(ref);
        },
        set: H.txSet,
      };
      return fn(tx);
    },
    setDoc: H.setDoc,
    updateDoc: vi.fn(),
    deleteField: vi.fn(),
    onSnapshot: vi.fn(),
    serverTimestamp: vi.fn(),
    getFirestore: vi.fn(),
  };
});

import { cellsFromData } from '../game/cells';
import { resetAdultContentForTests, setActiveAdultContent } from '../adultContent';
import { joinAndDeal, reshuffleBoard, reshuffleSeed } from './api';

const snap = (exists: boolean, id = '', data: unknown = undefined) => ({
  exists: () => exists,
  id,
  data: () => data,
});

function route(ref: { args?: unknown[] }) {
  const a = (ref.args ?? []).filter((x): x is string => typeof x === 'string');
  if (a.length === 2 && a[0] === 'events') return H.event ? snap(true, EVENT_ID, H.event) : snap(false);
  if (a[2] === 'items') {
    const item = H.itemsById.get(a[3]);
    return item ? snap(true, a[3], item) : snap(false);
  }
  if (a[2] === 'days' && a[4] === 'boards') {
    const board = H.dayBoards.get(Number(a[3]));
    return board ? snap(true, a[5], board) : snap(false);
  }
  if (a[2] === 'players') return H.player ? snap(true, a[3], H.player) : snap(false);
  return snap(false);
}

const NOW = Date.now();
const PAST = NOW - 3_600_000;
const FUTURE = NOW + 3_600_000;

/** 60 snapshot Prompts. The size is load-bearing, not arbitrary: `dealBoard`
 *  RESETS the no-repeat exclusion when honoring it would leave fewer than
 *  MIN_POOL (24) drawable Prompts. With 60, excluding a kept 24-id card still
 *  leaves 36 — so an exclusion assertion below tests the exclusion, not the
 *  reset. (At 40 it silently tested the reset instead.) */
const SNAPSHOT_IDS = Array.from({ length: 60 }, (_, i) => `s${i}`);

function seedItems() {
  H.itemsById.clear();
  for (const [i, id] of SNAPSHOT_IDS.entries()) {
    H.itemsById.set(id, { text: `Prompt ${id}`, spicy: i % 2 === 0, isFreeSpace: false });
  }
}

/** A 25-cell card carrying all 24 supplied ids around the free centre. The id
 *  cursor is separate from the cell index and SKIPS the centre — indexing `ids`
 *  by the cell index would burn ids[12] on the free space and run off the end at
 *  cell 24, leaving a junk `x24` id that the exclusion assertions then silently
 *  under-test (CodeRabbit, PR #383). */
function cardFrom(ids: string[], markedIndex?: number): Cell[] {
  let cursor = 0;
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : ids[cursor++],
    text: index === 12 ? 'FREE' : `Prompt ${index}`,
    free: index === 12,
    marked: index === 12 || index === markedIndex,
    markedAt: index === markedIndex ? 1 : null,
  }));
}

const day = (index: number, over: Partial<DayDef> = {}): DayDef =>
  ({
    index,
    date: '2026-07-16',
    port: 'Split',
    portEmoji: '🇭🇷',
    theme: 'get-sporty',
    pool: 'main',
    tutorial: false,
    unlockAt: PAST,
    snapshotItemIds: SNAPSHOT_IDS,
    ...over,
  }) as DayDef;

/** The cells the batch wrote for the day board. */
const writtenBoard = () => {
  const call = H.txSet.mock.calls.find((c) => {
    const a = ((c[0] as { args?: unknown[] }).args ?? []).filter((x) => typeof x === 'string');
    return a[2] === 'days' && a[4] === 'boards';
  });
  if (!call) return undefined;
  const payload = call[1] as { seed: number; cells: unknown; dayIndex: number; uid: string; easyMixRatio?: number };
  // The wire shape is the #457 cells MAP; assertions read the app shape.
  return { ...payload, cells: cellsFromData(payload.cells) };
};

const writtenPlayer = () => {
  const call = H.txSet.mock.calls.find((c) => {
    const a = ((c[0] as { args?: unknown[] }).args ?? []).filter((x) => typeof x === 'string');
    return a[2] === 'players';
  });
  return call?.[1] as { reshufflesUsed: number } | undefined;
};

/** The per-spend marker the transaction minted (#463) — path segments + payload. */
const writtenMarker = () => {
  const call = H.txSet.mock.calls.find((c) => {
    const a = ((c[0] as { args?: unknown[] }).args ?? []).filter((x) => typeof x === 'string');
    return a[2] === 'reshuffles';
  });
  if (!call) return undefined;
  const a = ((call[0] as { args?: unknown[] }).args ?? []).filter((x): x is string => typeof x === 'string');
  return { id: a[3], payload: call[1] as { uid: string; n: number; dayIndex: number } };
};

beforeEach(() => {
  resetAdultContentForTests();
  vi.clearAllMocks();
  seedItems();
  H.dayBoards = new Map();
  H.event = { days: [day(0), day(1)], settings: { spicyRatio: 0.4 } };
  H.player = { uid: 'u1', reshufflesUsed: 0 };
  // Day 1 holds a pristine card dealt from the first 24 snapshot ids.
  H.dayBoards.set(1, { uid: 'u1', seed: 111, cells: cardFrom(SNAPSHOT_IDS.slice(0, 24)) });
  H.getDoc.mockImplementation(async (ref: { args?: unknown[] }) => route(ref));
  H.offline = false;
});

describe('reshuffleBoard — the happy path', () => {
  it('writes exactly THREE docs: the day board, the counter, and the spend marker — nothing else', async () => {
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    expect(H.txSet).toHaveBeenCalledTimes(3);
  });

  it('mints the per-spend marker the rules demand: id {uid}-{n}, naming this Day (#463)', async () => {
    H.player = { uid: 'u1', reshufflesUsed: 1 };
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    const marker = writtenMarker()!;
    expect(marker.id).toBe('u1-2');
    expect(marker.payload).toMatchObject({ uid: 'u1', n: 2, dayIndex: 1 });
  });

  it('returns the resulting spend and bumps the counter by exactly 1', async () => {
    H.player = { uid: 'u1', reshufflesUsed: 1 };
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(2);
    expect(writtenPlayer()).toEqual({ reshufflesUsed: 2 });
  });

  it('deals a full 24-prompt card plus the free centre', async () => {
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    const board = writtenBoard()!;
    expect(board.cells).toHaveLength(25);
    expect(board.cells[12].free).toBe(true);
    expect(board.cells.filter((c) => !c.free && c.itemId).length).toBe(24);
  });

  it('draws ONLY from that Day\'s frozen snapshot', async () => {
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    const dealt = writtenBoard()!.cells.filter((c) => !c.free).map((c) => c.itemId!);
    for (const id of dealt) expect(SNAPSHOT_IDS).toContain(id);
  });

  it('withholds explicit snapshot Prompts until the 18+ posture is published', async () => {
    for (const [i, id] of SNAPSHOT_IDS.entries()) {
      H.itemsById.set(id, { text: `Prompt ${id}`, spicy: i >= 24, isFreeSpace: false });
    }
    setActiveAdultContent(false);

    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });

    const dealt = writtenBoard()!.cells.filter((cell) => !cell.free).map((cell) => cell.itemId!);
    expect(dealt).toHaveLength(24);
    expect(dealt.every((id) => SNAPSHOT_IDS.indexOf(id) < 24)).toBe(true);
  });

  it('preserves the card’s frozen easy-mix ratio instead of reading a later event setting', async () => {
    H.event = { days: [day(0), day(1, { snapshotEasyMixRatio: 0.5 })], settings: { spicyRatio: 0.4, easyMixRatio: 0.75 } };
    H.dayBoards.set(1, { uid: 'u1', seed: 111, easyMixRatio: 0.25, cells: cardFrom(SNAPSHOT_IDS.slice(0, 24)) });

    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });

    expect(writtenBoard()!.easyMixRatio).toBe(0.25);
  });

  it('changes the seed — the rules discriminate a reshuffle on exactly that', async () => {
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    expect(writtenBoard()!.seed).not.toBe(111);
  });

  it('leaves the card pristine (only the free centre marked)', async () => {
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    const cells = writtenBoard()!.cells;
    expect(cells.every((c) => c.free || !c.marked)).toBe(true);
  });

  it('a second reshuffle of the same Day deals a DIFFERENT card', async () => {
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    const first = writtenBoard()!;
    vi.clearAllMocks();
    H.player = { uid: 'u1', reshufflesUsed: 1 };
    H.dayBoards.set(1, { uid: 'u1', seed: first.seed, cells: first.cells });
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: first.seed });
    expect(writtenBoard()!.seed).not.toBe(first.seed);
  });
});

describe('reshuffleBoard — the exclusion is computed from KEPT cards only', () => {
  it('excludes Prompts held on OTHER Day Cards', async () => {
    // Day 0 (KEPT) holds s0..s23; Day 1 (being reshuffled) holds s24..s47. The
    // 60-id snapshot leaves 36 drawable after excluding Day 0, so the exclusion
    // is honored rather than reset.
    H.dayBoards.set(0, { uid: 'u1', seed: 7, cells: cardFrom(SNAPSHOT_IDS.slice(0, 24)) });
    H.dayBoards.set(1, { uid: 'u1', seed: 111, cells: cardFrom(SNAPSHOT_IDS.slice(24, 48)) });
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    const dealt = writtenBoard()!.cells.filter((c) => !c.free).map((c) => c.itemId!);
    for (const id of SNAPSHOT_IDS.slice(0, 24)) expect(dealt).not.toContain(id);
  });

  it("does NOT exclude the DISCARDED card's own Prompts — they return to the pool", async () => {
    // The ticket's decision, and the one that makes a reshuffle a genuine re-deal
    // rather than a narrowing one. Day 0 (kept) holds s0..s23, so the eligible
    // pool for Day 1 is s24..s59 (36 ids). Day 1's OWN discarded ids (s24..s47)
    // must stay eligible — if they were excluded too, only 12 would remain, below
    // MIN_POOL. So: some discarded id must reappear.
    H.dayBoards.set(0, { uid: 'u1', seed: 7, cells: cardFrom(SNAPSHOT_IDS.slice(0, 24)) });
    H.dayBoards.set(1, { uid: 'u1', seed: 111, cells: cardFrom(SNAPSHOT_IDS.slice(24, 48)) });
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    const dealt = writtenBoard()!.cells.filter((c) => !c.free).map((c) => c.itemId!);
    const reused = dealt.filter((id) => SNAPSHOT_IDS.slice(24, 48).includes(id));
    expect(reused.length).toBeGreaterThan(0);
  });

  it('never touches another Player\'s card', async () => {
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    for (const call of H.txSet.mock.calls) {
      const a = ((call[0] as { args?: unknown[] }).args ?? []).filter((x) => typeof x === 'string');
      expect(a).not.toContain('u2');
    }
  });
});

describe('reshuffleBoard — refusals', () => {
  it('refuses a card that is not pristine', async () => {
    H.dayBoards.set(1, { uid: 'u1', seed: 111, cells: cardFrom(SNAPSHOT_IDS.slice(0, 24), 0) });
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).rejects.toThrow(/pristine/);
    expect(H.txSet).not.toHaveBeenCalled();
  });

  it('refuses a card holding a PENDING mark — a Claim is queued against it', async () => {
    const cells = cardFrom(SNAPSHOT_IDS.slice(0, 24));
    cells[0] = { ...cells[0], marked: true, status: 'pending' };
    H.dayBoards.set(1, { uid: 'u1', seed: 111, cells });
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).rejects.toThrow(/pristine/);
  });

  it('refuses once the allowance is spent', async () => {
    H.player = { uid: 'u1', reshufflesUsed: 3 };
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).rejects.toThrow(/reshuffles left/);
    expect(H.txSet).not.toHaveBeenCalled();
  });

  it('refuses a LOCKED Day', async () => {
    H.event = { days: [day(0), day(1, { unlockAt: FUTURE })], settings: {} };
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).rejects.toThrow(/locked/);
    expect(H.txSet).not.toHaveBeenCalled();
  });

  it('refuses a Day whose snapshot is not yet stamped (waking)', async () => {
    H.event = { days: [day(0), day(1, { snapshotItemIds: undefined })], settings: {} };
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).rejects.toThrow(/waking/);
  });

  it('refuses when there is no card to reshuffle', async () => {
    H.dayBoards = new Map();
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).rejects.toThrow(/no Day Card/);
  });

  it('treats a legacy player row with no counter as 0 spent', async () => {
    H.player = { uid: 'u1' };
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
  });
});

describe('reshuffleBoard — tutorial Days', () => {
  it('deals a tutorial Day unstratified (its pool is all tame)', async () => {
    // All-tame snapshot: a stratified deal would throw trying to hit a spicy
    // target, so reaching a full card at all proves `stratify` was off.
    for (const id of SNAPSHOT_IDS) {
      H.itemsById.set(id, { text: `Prompt ${id}`, spicy: false, isFreeSpace: false });
    }
    H.event = { days: [day(0), day(1, { pool: 'embark', tutorial: true })], settings: {} };
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    expect(writtenBoard()!.cells.filter((c) => !c.free && c.itemId).length).toBe(24);
  });
});

describe('reshuffleSeed', () => {
  it('is deterministic for the same (uid, day, spend)', () => {
    expect(reshuffleSeed('u1', 2, 1, 0)).toBe(reshuffleSeed('u1', 2, 1, 0));
  });

  it('differs per successive spend, so a second reshuffle is not the first card again', () => {
    expect(reshuffleSeed('u1', 2, 1, 0)).not.toBe(reshuffleSeed('u1', 2, 2, 0));
  });

  it('differs per Day and per Player', () => {
    expect(reshuffleSeed('u1', 2, 1, 0)).not.toBe(reshuffleSeed('u1', 3, 1, 0));
    expect(reshuffleSeed('u1', 2, 1, 0)).not.toBe(reshuffleSeed('u2', 2, 1, 0));
  });

  it('NEVER returns the current seed — an identical seed would spend an allowance for the same card', () => {
    const collide = reshuffleSeed('u1', 2, 1, 0);
    // Feed the derived seed back in as the CURRENT one: the nudge must move off it.
    expect(reshuffleSeed('u1', 2, 1, collide)).not.toBe(collide);
  });

  it('returns a uint32', () => {
    const seed = reshuffleSeed('u1', 9, 3, 0);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('joinAndDeal — seeding the allowance', () => {
  const user = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null } as never;

  /** The player-row payload joinAndDeal merged — a tx.set since #409 made the
   *  daily identity seed transactional (read-and-write of the row it guards). */
  const joinedPlayerWrite = () => {
    const call = H.txSet.mock.calls.find((c) => {
      const a = ((c[0] as { args?: unknown[] }).args ?? []).filter((x) => typeof x === 'string');
      return a[2] === 'players';
    });
    return call?.[1] as Record<string, unknown> | undefined;
  };

  it('seeds reshufflesUsed: 0 on a first join, alongside the other zeroed aggregates', async () => {
    H.player = null;
    await joinAndDeal(user);
    expect(joinedPlayerWrite()).toMatchObject({ reshufflesUsed: 0, bingoCount: 0 });
  });

  // The load-bearing half. joinAndDeal re-runs on every online/authority flip, so
  // an unguarded `reshufflesUsed: 0` would rewind a real spend — and because the
  // rules hold the counter monotonic, that write is DENIED, which fails the whole
  // join batch rather than just this field. Guarded, the key is simply absent.
  it('never rewinds a Player who has already spent reshuffles', async () => {
    H.player = { uid: 'u1', joinedAt: 1, bingoCount: 0, squaresMarked: 0, firstBingoAt: null, blackout: false, reshufflesUsed: 2 };
    await joinAndDeal(user);
    expect(joinedPlayerWrite()).not.toHaveProperty('reshufflesUsed');
  });
});

describe('reshuffleBoard — offline', () => {
  // The Codex P1 on #383. A `writeBatch` would QUEUE here and apply optimistically
  // to the local cache while its commit promise pends forever: the Player sees the
  // replacement card, starts marking it, and the whole thing rolls back when the
  // drain hits a server that now denies it. `runTransaction` is the primitive whose
  // failure mode matches the contract — it rejects rather than buffering, so the
  // reshuffle either lands against fresh server state or changes nothing at all.
  it('REJECTS rather than queueing, and writes nothing', async () => {
    H.offline = true;
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).rejects.toThrow(/offline/i);
    expect(H.txSet).not.toHaveBeenCalled();
    expect(H.batchSet).not.toHaveBeenCalled();
  });

  // The online gate on the chip is a hint, never the enforcement: navigator.onLine
  // reports the link, not reachability, and captive ship wifi reads as online. The
  // write path must be safe on its own.
  it('is not reliant on the caller having checked connectivity first', async () => {
    H.offline = true;
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).rejects.toThrow();
  });
});

describe('reshuffleBoard — the confirmed-card precondition', () => {
  // The Codex P2 on #383. Firestore retries the LOSER of a concurrent pair, and on
  // retry the board it re-reads is the winner's replacement — itself pristine and
  // freshly counted, so every other eligibility check passes and a second allowance
  // is silently burned. Pinning to the seed the Player actually confirmed turns
  // that retry into the refusal the spec promises.
  it('REFUSES when the stored card is no longer the one that was confirmed', async () => {
    // The board now carries a different seed — i.e. another tab already reshuffled it.
    H.dayBoards.set(1, { uid: 'u1', seed: 777, cells: cardFrom(SNAPSHOT_IDS.slice(0, 24)) });
    await expect(
      reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 }),
    ).rejects.toThrow(/changed underneath/);
    expect(H.txSet).not.toHaveBeenCalled();
  });

  it('proceeds when the stored card still matches the confirm', async () => {
    await expect(reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 })).resolves.toBe(1);
  });
});

describe('reshuffleBoard — the exclusion set is read inside the transaction', () => {
  // Codex P2 on #383: two tabs reshuffling DIFFERENT Days contend on the shared
  // counter, so the loser retries — and a peer set captured before the transaction
  // would still describe the winner's OLD card. Reading peers via tx.get is what
  // makes a retry rebuild the exclusion from committed state.
  it('reads every peer Day Card through the transaction, not before it', async () => {
    H.dayBoards.set(0, { uid: 'u1', seed: 7, cells: cardFrom(SNAPSHOT_IDS.slice(0, 24)) });
    H.dayBoards.set(1, { uid: 'u1', seed: 111, cells: cardFrom(SNAPSHOT_IDS.slice(24, 48)) });
    await reshuffleBoard({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    // Day 0's prompts are excluded, and that exclusion came from a tx read.
    const dealt = writtenBoard()!.cells.filter((c) => !c.free).map((c) => c.itemId!);
    for (const id of SNAPSHOT_IDS.slice(0, 24)) expect(dealt).not.toContain(id);
    expect(H.txGet.mock.calls.some((c) => {
      const a = ((c[0] as { args?: unknown[] }).args ?? []).filter((x) => typeof x === 'string');
      return a[2] === 'days' && a[3] === '0' && a[4] === 'boards';
    })).toBe(true);
  });
});
