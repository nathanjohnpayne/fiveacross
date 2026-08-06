import { describe, it, expect } from 'vitest';
import {
  proofFeedVisible,
  buildMostLovedPhotoAward,
  mostLovedDisplayWinners,
  mostLovedFrozenEventPayload,
  type MostLovedProofInput,
  type MostLovedHeartInput,
} from './mostLoved';
import type { MostLovedPhotoAward, ProofDoc } from '../types';

// specs/most-loved-photo.md, client layer (#534/#560): the Feed-visibility
// predicate, the client mirror of the award computation (the FULL eligibility
// matrix lives in tests/functions/most-loved-parity.test.ts, which runs both
// implementations against one fixture set), the render-time display gate for
// the hidden-after-freeze rule, and the analytics payload's no-media guarantee.

const CUTOFF = 10_000;
const OPTS = { bannedUids: [] as string[], reportHideThreshold: 5, cutoff: CUTOFF, computedAt: 20_000 };

const P = (id: string, over: Partial<MostLovedProofInput> = {}): MostLovedProofInput => ({
  id,
  uid: `u-${id}`,
  displayName: `Player ${id}`,
  type: 'photo',
  status: 'active',
  reportCount: 0,
  createdAt: 1_000,
  itemText: `Prompt ${id}`,
  dayIndex: 1,
  ...over,
});

const H = (
  uid: string,
  targetId: string,
  targetCreatedAt: number,
  over: Partial<MostLovedHeartInput> = {},
): MostLovedHeartInput => ({
  uid,
  targetKind: 'proof',
  targetId,
  targetCreatedAt,
  createdAt: 5_000,
  ...over,
});

/** A live ProofDoc slice as the Feed hook would deliver it to the display gate. */
const live = (id: string, over: Partial<ProofDoc> = {}): Pick<ProofDoc, 'id' | 'type' | 'createdAt'> & Partial<ProofDoc> => ({
  id,
  type: 'photo',
  createdAt: 1_000,
  ...over,
});

const award = (over: Partial<MostLovedPhotoAward> = {}): MostLovedPhotoAward => ({
  winners: [
    {
      proofId: 'p1',
      uid: 'u-p1',
      displayName: 'Sam',
      promptText: 'Golden hour on the bluff',
      dayIndex: 2,
      proofCreatedAt: 1_000,
    },
  ],
  heartCount: 4,
  frozenAt: CUTOFF,
  computedAt: 20_000,
  ...over,
});

describe('proofFeedVisible — the Feed filter as one named predicate', () => {
  it('accepts an active, unreported, unbanned proof', () => {
    expect(proofFeedVisible(P('p1'), 5, [])).toBe(true);
  });
  it('rejects every non-active status (the Feed query constraint)', () => {
    for (const status of ['hidden', 'pending', 'flagged'] as const) {
      expect(proofFeedVisible(P('p1', { status }), 5, [])).toBe(false);
    }
  });
  it('rejects a report-hidden proof AT the threshold and fails OPEN without one', () => {
    expect(proofFeedVisible(P('p1', { reportCount: 5 }), 5, [])).toBe(false);
    expect(proofFeedVisible(P('p1', { reportCount: 99 }), undefined, [])).toBe(true);
    expect(proofFeedVisible(P('p1', { reportCount: 99 }), 0, [])).toBe(true);
  });
  it('rejects a banned owner', () => {
    expect(proofFeedVisible(P('p1'), 5, ['u-p1'])).toBe(false);
  });
});

describe('buildMostLovedPhotoAward — client mirror sanity (full matrix in the parity test)', () => {
  it('excludes self-hearts and orders a tie earliest-posted first', () => {
    const result = buildMostLovedPhotoAward(
      [P('late', { createdAt: 3_000 }), P('early', { createdAt: 1_000 })],
      [
        H('u-late', 'late', 3_000), // self-heart — never counts
        H('a', 'late', 3_000),
        H('a', 'early', 1_000),
      ],
      OPTS,
    );
    expect(result.heartCount).toBe(1);
    expect(result.winners.map((w) => w.proofId)).toEqual(['early', 'late']);
    expect(result.frozenAt).toBe(CUTOFF);
  });

  it('returns the explicit no-award record when nothing is eligible', () => {
    expect(buildMostLovedPhotoAward([P('p1')], [H('u-p1', 'p1', 1_000)], OPTS)).toEqual({
      winners: [],
      heartCount: 0,
      frozenAt: CUTOFF,
      computedAt: 20_000,
    });
  });
});

describe('mostLovedDisplayWinners — the render-time hidden-after-freeze gate', () => {
  it('joins a surviving winner to its live proof, preserving award order', () => {
    const a = award({
      winners: [
        { proofId: 'p2', uid: 'u-p2', displayName: 'B', promptText: 'x', dayIndex: null, proofCreatedAt: 2_000 },
        { proofId: 'p1', uid: 'u-p1', displayName: 'A', promptText: 'y', dayIndex: 1, proofCreatedAt: 1_000 },
      ],
    });
    // Live order differs — the AWARD order (earliest-posted first) must win.
    const out = mostLovedDisplayWinners(a, [live('p1'), live('p2', { createdAt: 2_000 })]);
    expect(out.map((d) => d.winner.proofId)).toEqual(['p2', 'p1']);
    expect(out[0].proof).toMatchObject({ id: 'p2', createdAt: 2_000 });
  });

  it('drops a hidden-after-freeze winner from DISPLAY while the award record stays untouched', () => {
    const a = award();
    Object.freeze(a);
    Object.freeze(a.winners);
    Object.freeze(a.winners[0]);
    // The winner no longer survives the Feed filter (hidden/deleted/banned) —
    // it is simply absent from the live, already-filtered proofs.
    expect(mostLovedDisplayWinners(a, [live('other')])).toEqual([]);
    // The frozen record itself is untouched — the award stays recorded and the
    // finale falls back to photo highlights for display.
    expect(a.winners).toHaveLength(1);
  });

  it('drops an incarnation-mismatched live proof (recreated at the same id)', () => {
    expect(mostLovedDisplayWinners(award(), [live('p1', { createdAt: 9_999 })])).toEqual([]);
  });

  it('drops a live proof that is somehow no longer a photo (defensive)', () => {
    expect(mostLovedDisplayWinners(award(), [live('p1', { type: 'text' })])).toEqual([]);
  });

  it('returns [] for an absent award or the explicit no-award record', () => {
    expect(mostLovedDisplayWinners(undefined, [live('p1')])).toEqual([]);
    expect(mostLovedDisplayWinners(null, [live('p1')])).toEqual([]);
    expect(mostLovedDisplayWinners(award({ winners: [] }), [live('p1')])).toEqual([]);
  });

  it('with co-winners, the surviving list still leads with the earliest STILL-VISIBLE winner', () => {
    const a = award({
      winners: [
        { proofId: 'gone', uid: 'u-g', displayName: 'G', promptText: 'x', dayIndex: null, proofCreatedAt: 500 },
        { proofId: 'p1', uid: 'u-p1', displayName: 'A', promptText: 'y', dayIndex: 1, proofCreatedAt: 1_000 },
      ],
    });
    const out = mostLovedDisplayWinners(a, [live('p1')]);
    expect(out.map((d) => d.winner.proofId)).toEqual(['p1']);
  });
});

describe('mostLovedFrozenEventPayload — ids and counts only, never media or names', () => {
  it('builds the award payload with exactly the six documented params', () => {
    const payload = mostLovedFrozenEventPayload(award());
    expect(payload).toEqual({
      winnersCount: 1,
      heartCount: 4,
      tie: false,
      award: true,
      proofId: 'p1',
      dayIndex: 2,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'award',
      'dayIndex',
      'heartCount',
      'proofId',
      'tie',
      'winnersCount',
    ]);
  });

  it('flags a tie and keeps the hero = winners[0]', () => {
    const a = award({
      winners: [
        { proofId: 'p1', uid: 'u-p1', displayName: 'A', promptText: 'x', dayIndex: null, proofCreatedAt: 1_000 },
        { proofId: 'p2', uid: 'u-p2', displayName: 'B', promptText: 'y', dayIndex: 2, proofCreatedAt: 2_000 },
      ],
    });
    expect(mostLovedFrozenEventPayload(a)).toMatchObject({ winnersCount: 2, tie: true, proofId: 'p1', dayIndex: null });
  });

  it('the no-award record is still a payload (award: false is signal)', () => {
    expect(mostLovedFrozenEventPayload(award({ winners: [], heartCount: 0 }))).toEqual({
      winnersCount: 0,
      heartCount: 0,
      tie: false,
      award: false,
      proofId: null,
      dayIndex: null,
    });
  });

  it('never carries media keys, storage paths, or display names', () => {
    const serialized = JSON.stringify(mostLovedFrozenEventPayload(award()));
    for (const banned of ['mediaURL', 'thumbURL', 'storagePath', 'displayName', 'photoURL', 'Sam']) {
      expect(serialized).not.toContain(banned);
    }
  });
});
