import { describe, it, expect, vi } from 'vitest';
import type { MomentDoc, ProofDoc, TallyCard } from '../types';

// `useData` pulls in `../firebase` (real getAuth) at import; stub both so this
// pure-function suite (deriveTallyCards / mergeFeed) never initializes Firebase.
// vi.mock is hoisted above the imports below, so the real module under test picks
// up these stubs (the same pattern as useData.test.ts).
vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));
vi.mock('firebase/firestore', () => ({
  doc: (...args: unknown[]) => ({ kind: 'doc', args, withConverter: () => ({}) }),
  collection: (...args: unknown[]) => ({ kind: 'collection', args, withConverter: () => ({}) }),
  collectionGroup: (...args: unknown[]) => ({ kind: 'collectionGroup', args }),
  query: (...args: unknown[]) => ({ query: args }),
  where: (...args: unknown[]) => ({ where: args }),
  onSnapshot: vi.fn(() => () => {}),
}));

import { deriveTallyCards, mergeFeed, type TallyMarkerRow } from './useData';
import { BUMP_DEBOUNCE_MS } from '../game/logic';

// specs/d15-tally-cards.md — the Feed's third stream (#216). Two pure pieces:
// `deriveTallyCards` folds a flat marker list into per-(itemId, dayIndex) live
// cards (count, names, derived bump), and `mergeFeed` interleaves Proofs, Moments,
// and Tally Cards newest-first. Both are Firestore/clock-free so the ordering,
// grouping, drop-empty, and debounce are unit-testable.

const T0 = 1_700_000_000_000;
const row = (over: Partial<TallyMarkerRow> & Pick<TallyMarkerRow, 'uid' | 'itemId'>): TallyMarkerRow => ({
  eventId: 'test-event',
  displayName: over.uid,
  markedAt: T0,
  dayIndex: 0,
  itemText: 'Balcony or porthole photo',
  ...over,
});

describe('deriveTallyCards — per-(itemId, dayIndex) aggregation (specs/d15-tally-cards.md)', () => {
  it('groups markers of the same Prompt+Day into one live card, count = marker set', () => {
    const { cards } = deriveTallyCards([
      row({ uid: 'alice', itemId: 'p1', markedAt: T0 }),
      row({ uid: 'bob', itemId: 'p1', markedAt: T0 + 1000 }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ itemId: 'p1', dayIndex: 0, count: 2, lastMarkedAt: T0 + 1000 });
    // markers are chronological (earliest first) so the names line reads in order
    expect(cards[0].markers.map((m) => m.uid)).toEqual(['alice', 'bob']);
  });

  it('dedupes markers by uid within a card — a stray duplicate row never repeats a name', () => {
    // The write path is uid-keyed (tally/{itemId}/markers/{uid}), so a duplicate
    // row is always an anomaly (an unscoped subscription, a legacy overlap) —
    // the render fold must still never produce "Nathan Payne, Nathan Payne".
    const { cards } = deriveTallyCards([
      row({ uid: 'nathan', displayName: 'Nathan Payne', itemId: 'p1', markedAt: T0 + 5000 }),
      row({ uid: 'nathan', displayName: 'Nathan Payne', itemId: 'p1', markedAt: T0 }),
      row({ uid: 'sterling', displayName: 'Sterling Tadlock', itemId: 'p1', markedAt: T0 + 1000 }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].count).toBe(2);
    // Earliest row per uid wins, so the chronological names line is stable.
    expect(cards[0].markers.map((m) => m.uid)).toEqual(['nathan', 'sterling']);
    expect(cards[0].markers[0].markedAt).toBe(T0);
  });

  it('the SAME Prompt on two different Days is two independent cards, each with its day', () => {
    const { cards } = deriveTallyCards([
      row({ uid: 'alice', itemId: 'p1', dayIndex: 2 }),
      row({ uid: 'bob', itemId: 'p1', dayIndex: 4 }),
    ]);
    const byDay = Object.fromEntries(cards.map((c) => [c.dayIndex, c]));
    expect(cards).toHaveLength(2);
    expect(byDay[2].count).toBe(1);
    expect(byDay[4].count).toBe(1);
  });

  it('an emptied group produces no card — a Tally that drops to zero drops out', () => {
    // No rows for p1 (its last marker was deleted) → no card at all.
    const { cards } = deriveTallyCards([row({ uid: 'alice', itemId: 'p2' })]);
    expect(cards.map((c) => c.itemId)).toEqual(['p2']);
  });

  it('legacy per-Prompt markers (no dayIndex / itemText) never form a day-scoped card', () => {
    const legacy: TallyMarkerRow = { uid: 'x', displayName: 'X', markedAt: T0, itemId: 'p1' };
    const { cards } = deriveTallyCards([legacy]);
    expect(cards).toEqual([]);
  });

  it('debounces the display bump from the carried-forward map; count stays live', () => {
    // First snapshot: two markers, card appears at T0+1000.
    const first = deriveTallyCards([
      row({ uid: 'a', itemId: 'p1', markedAt: T0 }),
      row({ uid: 'b', itemId: 'p1', markedAt: T0 + 1000 }),
    ]);
    expect(first.cards[0].displayBump).toBe(T0 + 1000);

    // Second snapshot within the window: a THIRD marker lands. Count rises to 3
    // (live), but displayBump HOLDS at T0+1000 (position doesn't jump).
    const within = deriveTallyCards(
      [
        row({ uid: 'a', itemId: 'p1', markedAt: T0 }),
        row({ uid: 'b', itemId: 'p1', markedAt: T0 + 1000 }),
        row({ uid: 'c', itemId: 'p1', markedAt: T0 + 1000 + BUMP_DEBOUNCE_MS - 1 }),
      ],
      first.displayed,
    );
    expect(within.cards[0].count).toBe(3);
    expect(within.cards[0].displayBump).toBe(T0 + 1000);

    // Third snapshot past the window: a marker 10m+ after the displayed bump moves it.
    const beyond = deriveTallyCards(
      [
        row({ uid: 'a', itemId: 'p1', markedAt: T0 }),
        row({ uid: 'd', itemId: 'p1', markedAt: T0 + 1000 + BUMP_DEBOUNCE_MS }),
      ],
      within.displayed,
    );
    expect(beyond.cards[0].displayBump).toBe(T0 + 1000 + BUMP_DEBOUNCE_MS);
  });
});

describe('mergeFeed — 3-way Proofs + Moments + Tally Cards (specs/d15-tally-cards.md)', () => {
  const proof = (id: string, createdAt: number): ProofDoc =>
    ({ id, uid: id, displayName: id, type: 'text', cellIndex: 0, itemText: 't', createdAt, reportCount: 0, status: 'active' } as ProofDoc);
  const moment = (id: string, createdAt: number): MomentDoc =>
    ({ id, kind: 'bingo', uid: id, displayName: id, photoURL: null, createdAt } as MomentDoc);
  const tally = (itemId: string, displayBump: number, count = 1): TallyCard => ({
    itemId,
    dayIndex: 0,
    itemText: 't',
    count,
    markers: [],
    lastMarkedAt: displayBump,
    displayBump,
  });

  it('orders all three kinds newest-first by their activity time (Tally Card = displayBump)', () => {
    const merged = mergeFeed([proof('pr', 2000)], [moment('mo', 3000)], [tally('ta', 2500)]);
    expect(merged.map((e) => e.feedKind)).toEqual(['moment', 'tallyCard', 'proof']);
    expect(merged.map((e) => e.createdAt)).toEqual([3000, 2500, 2000]);
  });

  it('excludes a zero-count Tally Card — an emptied Tally is not in the merged stream', () => {
    const merged = mergeFeed([], [], [tally('gone', 9999, 0)]);
    expect(merged).toEqual([]);
  });

  it('stays backward-compatible: no Tally Cards yields the old Proofs+Moments stream', () => {
    const merged = mergeFeed([proof('pr', 1)], [moment('mo', 2)]);
    expect(merged.map((e) => e.feedKind)).toEqual(['moment', 'proof']);
  });
});
