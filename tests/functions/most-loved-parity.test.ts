import { describe, it, expect } from 'vitest';
import {
  buildMostLovedPhotoAward as clientBuild,
  type MostLovedProofInput,
  type MostLovedHeartInput,
  type MostLovedAwardOptions,
} from '../../src/data/mostLoved';
import { buildMostLovedPhotoAward as fnsBuild } from '../../functions/src/finaleContent';
import type { MostLovedPhotoAward } from '../../src/domainTypes';

// Parity guard for the client/functions Most-Loved Photo mirror (#534/#560,
// specs/most-loved-photo.md — the ADR 0011 pre-commitment, following the #551
// finale-parity pattern). `src/data/mostLoved.ts` and
// `functions/src/finaleContent.ts` are deliberately decoupled packages that
// re-state the same eligibility semantics; decoupling is fine, SILENT
// DIVERGENCE is not. Every case feeds ONE fixture set to BOTH builders,
// asserts deep-equal output, AND pins literal expected values — a parity test
// that only compares the two would still pass if both regressed the same way.

const CUTOFF = 10_000;
const COMPUTED_AT = 20_000;
const OPTS: MostLovedAwardOptions = {
  bannedUids: [],
  reportHideThreshold: 5,
  cutoff: CUTOFF,
  computedAt: COMPUTED_AT,
};

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
  serverCreatedAt: 5_000,
  ...over,
});

/** Run BOTH builders on the one fixture set; assert parity; return the result. */
function both(
  proofs: readonly MostLovedProofInput[],
  hearts: readonly MostLovedHeartInput[],
  opts: MostLovedAwardOptions = OPTS,
): MostLovedPhotoAward {
  const client = clientBuild(proofs, hearts, opts);
  const fns = fnsBuild(proofs, hearts, opts);
  expect(fns).toEqual(client);
  return client;
}

const NO_AWARD: MostLovedPhotoAward = {
  winners: [],
  heartCount: 0,
  frozenAt: CUTOFF,
  computedAt: COMPUTED_AT,
};

describe('client/functions parity — Most-Loved Photo eligibility (#560)', () => {
  it('a Player\'s own Heart on their own Proof does NOT count', () => {
    // heartState deliberately counts self-hearts for display; the award must not.
    const p1 = P('p1');
    const award = both([p1], [H('u-p1', 'p1', 1_000), H('fan', 'p1', 1_000)]);
    expect(award.heartCount).toBe(1); // the self-heart contributed nothing
    expect(award.winners.map((w) => w.proofId)).toEqual(['p1']);
    // Self-hearts alone → explicit no-award record, not a 1-heart win.
    expect(both([p1], [H('u-p1', 'p1', 1_000)])).toEqual(NO_AWARD);
  });

  it('a banned Player\'s Heart does NOT count — UNCONDITIONALLY (no display own-content exception)', () => {
    const opts = { ...OPTS, bannedUids: ['villain'] };
    // heartState's own-content exception keeps a banned viewer's heart visible
    // TO THEMSELVES; the award has no viewer, so the exclusion is absolute even
    // on content the banned Player could see it on.
    const award = both([P('p1')], [H('villain', 'p1', 1_000), H('fan', 'p1', 1_000)], opts);
    expect(award.heartCount).toBe(1);
    expect(both([P('p1')], [H('villain', 'p1', 1_000)], opts)).toEqual({
      ...NO_AWARD,
    });
  });

  it('a banned owner\'s Proof is excluded no matter how many Hearts it holds', () => {
    const opts = { ...OPTS, bannedUids: ['u-loud'] };
    const award = both(
      [P('loud'), P('quiet', { createdAt: 2_000 })],
      [H('a', 'loud', 1_000), H('b', 'loud', 1_000), H('c', 'loud', 1_000), H('a', 'quiet', 2_000)],
      opts,
    );
    expect(award.winners.map((w) => w.proofId)).toEqual(['quiet']);
    expect(award.heartCount).toBe(1);
  });

  it('hidden / pending / flagged Proofs are excluded (the Feed status filter)', () => {
    const award = both(
      [
        P('hid', { status: 'hidden' }),
        P('pen', { status: 'pending' }),
        P('flag', { status: 'flagged' }),
        P('ok', { createdAt: 2_000 }),
      ],
      [
        H('a', 'hid', 1_000),
        H('b', 'hid', 1_000),
        H('a', 'pen', 1_000),
        H('a', 'flag', 1_000),
        H('a', 'ok', 2_000),
      ],
    );
    expect(award.winners.map((w) => w.proofId)).toEqual(['ok']);
    expect(award.heartCount).toBe(1);
  });

  it('report-threshold hiding mirrors the Feed: hidden AT the threshold, fail-OPEN on undefined/0', () => {
    const reported = P('rep', { reportCount: 5 });
    const clean = P('ok', { createdAt: 2_000 });
    const hearts = [H('a', 'rep', 1_000), H('b', 'rep', 1_000), H('a', 'ok', 2_000)];
    // Threshold reached → excluded.
    expect(both([reported, clean], hearts).winners.map((w) => w.proofId)).toEqual(['ok']);
    // Fail-open: no threshold (event still loading / unset) or a zero threshold
    // filters NOTHING — the reported proof wins on hearts.
    for (const reportHideThreshold of [undefined, 0]) {
      const award = both([reported, clean], hearts, { ...OPTS, reportHideThreshold });
      expect(award.winners.map((w) => w.proofId)).toEqual(['rep']);
      expect(award.heartCount).toBe(2);
    }
  });

  it('non-photo Proofs are excluded — this award is for photos only', () => {
    const award = both(
      [P('txt', { type: 'text' }), P('aud', { type: 'audio' })],
      [H('a', 'txt', 1_000), H('b', 'txt', 1_000), H('a', 'aud', 1_000)],
    );
    expect(award).toEqual(NO_AWARD);
  });

  it('a Heart on a Moment never counts toward a Proof with the same id', () => {
    const award = both([P('p1')], [H('a', 'p1', 1_000, { targetKind: 'moment' })]);
    expect(award).toEqual(NO_AWARD);
  });

  it('an incarnation-mismatched Heart is ignored (the heartState rule)', () => {
    // The heart was given to a deleted earlier incarnation (same id, different
    // createdAt) — the recreated proof starts at zero.
    const award = both([P('p1', { createdAt: 3_000 })], [H('a', 'p1', 1_000)]);
    expect(award).toEqual(NO_AWARD);
  });

  it('the same Player cannot count twice on one Proof (unique uids per proof)', () => {
    // The deterministic slot id guarantees one doc per (Player, post) in prod;
    // the Set makes the pure function total over arbitrary fixtures.
    const award = both(
      [P('p1')],
      [H('a', 'p1', 1_000), H('a', 'p1', 1_000, { createdAt: 6_000 }), H('b', 'p1', 1_000)],
    );
    expect(award.heartCount).toBe(2);
  });

  it('a tie persists ALL co-winners, ordered earliest-posted first, then proofId', () => {
    const award = both(
      [
        P('late', { createdAt: 3_000 }),
        P('early', { createdAt: 1_000 }),
        P('loser', { createdAt: 500 }),
      ],
      [
        H('a', 'late', 3_000),
        H('b', 'late', 3_000),
        H('a', 'early', 1_000),
        H('b', 'early', 1_000),
        H('a', 'loser', 500),
      ],
    );
    expect(award.heartCount).toBe(2);
    expect(award.winners.map((w) => w.proofId)).toEqual(['early', 'late']); // winners[0] = share hero
    // Same createdAt → proofId ascending keeps the order total and deterministic.
    const sameInstant = both(
      [P('b2', { createdAt: 1_000 }), P('a1', { createdAt: 1_000 })],
      [H('x', 'b2', 1_000), H('x', 'a1', 1_000)],
    );
    expect(sameInstant.winners.map((w) => w.proofId)).toEqual(['a1', 'b2']);
  });

  it('zero eligible Hearts (or zero photo Proofs) yields the EXPLICIT no-award record', () => {
    expect(both([P('p1')], [])).toEqual(NO_AWARD);
    expect(both([], [H('a', 'p1', 1_000)])).toEqual(NO_AWARD);
  });

  it('Hearts after the freeze cutoff are excluded by their server creation time; AT the cutoff counts', () => {
    const award = both(
      [P('p1'), P('p2', { createdAt: 2_000 })],
      [
        H('a', 'p1', 1_000, { createdAt: CUTOFF - 1, serverCreatedAt: CUTOFF + 1 }),
        H('a', 'p2', 2_000, { serverCreatedAt: CUTOFF }),
      ],
    );
    expect(award.winners.map((w) => w.proofId)).toEqual(['p2']);
    expect(award.heartCount).toBe(1);
  });

  it('pins the full winner entry — denormalized proof fields only, no media, no roster join', () => {
    const award = both(
      [P('p1', { displayName: 'Sam', itemText: 'Golden hour on the bluff', dayIndex: 2, createdAt: 4_000 })],
      [H('fan', 'p1', 4_000)],
    );
    expect(award).toEqual({
      winners: [
        {
          proofId: 'p1',
          uid: 'u-p1',
          displayName: 'Sam',
          promptText: 'Golden hour on the bluff',
          dayIndex: 2,
          proofCreatedAt: 4_000,
        },
      ],
      heartCount: 1,
      frozenAt: CUTOFF,
      computedAt: COMPUTED_AT,
    });
    // A proof with no dayIndex persists an explicit null (never undefined —
    // Firestore rejects undefined field values).
    const noDay = both([P('p1', { dayIndex: null })], [H('fan', 'p1', 1_000)]);
    expect(noDay.winners[0].dayIndex).toBeNull();
  });
});
