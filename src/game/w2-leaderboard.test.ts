import { describe, it, expect } from 'vitest';
import { comparePlayers, sortPlayers, type Rankable } from './logic';

// specs/w2-leaderboard.md — issue #35. comparePlayers/sortPlayers already
// exist and ship the PRD tie-break (bingos desc -> squares desc -> earliest
// firstBingoAt); this file is the verification layer the ticket asks for
// ("under verification, not change"), not a rewrite. src/game/logic.test.ts
// already has a smaller 'leaderboard ordering' block — this file is the
// basename-aligned, more exhaustive tie-break table plus the null-last rule
// pinned in isolation. Issue #93 later fixed the one quirk #35 pinned: two
// null-firstBingoAt Players now compare as an explicit stable 0 (it used to
// be Infinity - Infinity = NaN), and the pins below assert that fixed rule.

function player(over: Partial<Rankable>): Rankable {
  return { bingoCount: 0, squaresMarked: 0, firstBingoAt: null, ...over };
}

describe('comparePlayers — bingos desc, then squares desc, then earliest firstBingoAt', () => {
  it('ranks strictly by bingoCount first, regardless of squares or firstBingoAt', () => {
    const more = player({ bingoCount: 3, squaresMarked: 1, firstBingoAt: 9000 });
    const fewer = player({ bingoCount: 2, squaresMarked: 20, firstBingoAt: 100 });
    expect(comparePlayers(more, fewer)).toBeLessThan(0); // `more` sorts first
    expect(comparePlayers(fewer, more)).toBeGreaterThan(0);
  });

  it('falls through to squaresMarked desc once bingoCount ties', () => {
    const moreSquares = player({ bingoCount: 1, squaresMarked: 10, firstBingoAt: 9000 });
    const fewerSquares = player({ bingoCount: 1, squaresMarked: 5, firstBingoAt: 100 });
    expect(comparePlayers(moreSquares, fewerSquares)).toBeLessThan(0);
    expect(comparePlayers(fewerSquares, moreSquares)).toBeGreaterThan(0);
  });

  it('falls through to earliest firstBingoAt once bingoCount AND squaresMarked both tie', () => {
    const earlier = player({ bingoCount: 2, squaresMarked: 8, firstBingoAt: 100 });
    const later = player({ bingoCount: 2, squaresMarked: 8, firstBingoAt: 200 });
    expect(comparePlayers(earlier, later)).toBeLessThan(0);
    expect(comparePlayers(later, earlier)).toBeGreaterThan(0);
  });

  it('is exactly 0 for two fully-tied Players', () => {
    const a = player({ bingoCount: 1, squaresMarked: 4, firstBingoAt: 500 });
    const b = player({ bingoCount: 1, squaresMarked: 4, firstBingoAt: 500 });
    expect(comparePlayers(a, b)).toBe(0);
    expect(comparePlayers(b, a)).toBe(0);
  });

  describe('a null firstBingoAt (no bingo yet) sorts LAST among an equal bingoCount/squaresMarked tie', () => {
    it('a null firstBingoAt sorts after a numeric one', () => {
      const noBingo = player({ bingoCount: 0, squaresMarked: 3, firstBingoAt: null });
      const hasBingo = player({ bingoCount: 0, squaresMarked: 3, firstBingoAt: 1 });
      expect(comparePlayers(noBingo, hasBingo)).toBeGreaterThan(0);
      expect(comparePlayers(hasBingo, noBingo)).toBeLessThan(0);
    });

    it('a null firstBingoAt sorts after even a very late numeric one (no Infinity-adjacent surprise)', () => {
      const noBingo = player({ bingoCount: 2, squaresMarked: 6, firstBingoAt: null });
      const veryLate = player({ bingoCount: 2, squaresMarked: 6, firstBingoAt: Number.MAX_SAFE_INTEGER });
      expect(comparePlayers(noBingo, veryLate)).toBeGreaterThan(0);
      expect(comparePlayers(veryLate, noBingo)).toBeLessThan(0);
    });

    it('two null-firstBingoAt Players: the comparator is exactly 0 both ways — a stable, engine-independent tie, never NaN (issue #93)', () => {
      // Until #93, the `?? Infinity` fallback computed Infinity - Infinity =
      // NaN for this pair, which hands Array.prototype.sort a formally
      // unspecified order (the old pin here asserted that NaN honestly).
      // comparePlayers now short-circuits the both-null tie to an explicit 0,
      // so sort stability — not engine-specific NaN tolerance — is what keeps
      // no-bingo-yet Players in their original relative order.
      const a = player({ bingoCount: 0, squaresMarked: 3, firstBingoAt: null });
      const b = player({ bingoCount: 0, squaresMarked: 3, firstBingoAt: null });
      expect(comparePlayers(a, b)).toBe(0);
      expect(comparePlayers(b, a)).toBe(0);
    });
  });
});

describe('sortPlayers — purity and stability the presentational filter layer depends on', () => {
  it('returns a new array and never mutates the input array or its order', () => {
    const input: Rankable[] = [
      player({ bingoCount: 0, squaresMarked: 1, firstBingoAt: null }),
      player({ bingoCount: 2, squaresMarked: 1, firstBingoAt: null }),
    ];
    const before = [...input];

    const sorted = sortPlayers(input);

    expect(sorted).not.toBe(input);
    expect(input).toEqual(before); // the caller's array is untouched
  });

  it('is a stable sort: fully-tied Players keep their original relative order', () => {
    interface Tagged extends Rankable {
      id: string;
    }
    const a: Tagged = { id: 'a', bingoCount: 1, squaresMarked: 4, firstBingoAt: 500 };
    const b: Tagged = { id: 'b', bingoCount: 1, squaresMarked: 4, firstBingoAt: 500 };
    const c: Tagged = { id: 'c', bingoCount: 1, squaresMarked: 4, firstBingoAt: 500 };

    expect(sortPlayers([a, b, c]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(sortPlayers([c, b, a]).map((p) => p.id)).toEqual(['c', 'b', 'a']);
  });

  it('stays stable when two null-firstBingoAt Players tie (comparePlayers is exactly 0 for that pair)', () => {
    interface Tagged extends Rankable {
      id: string;
    }
    const a: Tagged = { id: 'a', bingoCount: 0, squaresMarked: 3, firstBingoAt: null };
    const b: Tagged = { id: 'b', bingoCount: 0, squaresMarked: 3, firstBingoAt: null };
    const c: Tagged = { id: 'c', bingoCount: 0, squaresMarked: 3, firstBingoAt: null };

    // The both-null tie compares as an explicit 0 (issue #93 — it used to be
    // NaN, which engines tolerated but the spec leaves unspecified), so the
    // input order survives by guaranteed sort stability, not engine goodwill.
    expect(sortPlayers([a, b, c]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(sortPlayers([c, b, a]).map((p) => p.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('sortPlayers — the full PRD tie-break table end to end (bingos desc, squares desc, earliest first-bingo, null last)', () => {
  it('orders a mixed roster through every tie-break level in one pass', () => {
    interface Tagged extends Rankable {
      id: string;
    }
    const mostBingos: Tagged = { id: 'most-bingos', bingoCount: 3, squaresMarked: 1, firstBingoAt: 9000 };
    const tieBingoMoreSquares: Tagged = {
      id: 'tie-bingo-more-squares',
      bingoCount: 1,
      squaresMarked: 20,
      firstBingoAt: 5000,
    };
    const tieBingoEarlier: Tagged = { id: 'tie-bingo-earlier', bingoCount: 1, squaresMarked: 10, firstBingoAt: 100 };
    const tieBingoLater: Tagged = { id: 'tie-bingo-later', bingoCount: 1, squaresMarked: 10, firstBingoAt: 200 };
    const tieBingoNull: Tagged = { id: 'tie-bingo-null', bingoCount: 1, squaresMarked: 10, firstBingoAt: null };
    const noBingoMoreSquares: Tagged = {
      id: 'no-bingo-more-squares',
      bingoCount: 0,
      squaresMarked: 15,
      firstBingoAt: null,
    };
    const noBingoFewerSquares: Tagged = {
      id: 'no-bingo-fewer-squares',
      bingoCount: 0,
      squaresMarked: 2,
      firstBingoAt: null,
    };

    // Shuffled input — sortPlayers must recover the canonical order below
    // regardless of input order.
    const shuffled = [
      noBingoFewerSquares,
      tieBingoLater,
      mostBingos,
      tieBingoNull,
      noBingoMoreSquares,
      tieBingoEarlier,
      tieBingoMoreSquares,
    ];

    const order = sortPlayers(shuffled).map((p) => p.id);

    expect(order).toEqual([
      'most-bingos', // bingoCount 3 beats everything
      'tie-bingo-more-squares', // bingoCount 1 tier, most squares (20)
      'tie-bingo-earlier', // bingoCount 1, squares 10, earlier firstBingoAt
      'tie-bingo-later', // bingoCount 1, squares 10, later firstBingoAt
      'tie-bingo-null', // bingoCount 1, squares 10, null firstBingoAt sorts LAST in this tier
      'no-bingo-more-squares', // bingoCount 0 tier, more squares
      'no-bingo-fewer-squares', // bingoCount 0 tier, fewer squares
    ]);
  });
});

// #1145 / #1142 item 10, routed to #1152. `players/{uid}` validates none of its
// fields, so `comparePlayers`' two subtractions were the one place an unreadable
// Player stat became a thrown TypeError — inside `sortPlayers`, which the whole
// roster and the archive builder both go through, taking the Admin console's Game
// settings (and its Reopen play control) down with them.
describe('comparePlayers — total over any row the rules will accept', () => {
  const unreadable = (over: Record<string, unknown>): Rankable =>
    ({ bingoCount: 0, squaresMarked: 0, firstBingoAt: null, ...over }) as unknown as Rankable;

  it('does not throw on a bingoCount that cannot be converted to a number', () => {
    // The exact shape #1145 names: an object whose `toString` is nulled, which
    // the subtraction cannot coerce.
    const broken = unreadable({ bingoCount: { toString: null } });
    const ok = player({ bingoCount: 2 });
    expect(() => comparePlayers(broken, ok)).not.toThrow();
    // Unreadable ranks as the 0 the row itself displays, so the real row wins.
    expect(comparePlayers(broken, ok)).toBeGreaterThan(0);
    expect(comparePlayers(ok, broken)).toBeLessThan(0);
  });

  it('does not throw on an unreadable squaresMarked either', () => {
    const broken = unreadable({ bingoCount: 1, squaresMarked: { toString: null } });
    const ok = player({ bingoCount: 1, squaresMarked: 5 });
    expect(() => comparePlayers(broken, ok)).not.toThrow();
    expect(comparePlayers(ok, broken)).toBeLessThan(0);
  });

  it('never returns NaN, so the sort order is never left unspecified', () => {
    // Every comparison against NaN is false, which leaves
    // `Array.prototype.sort` formally free to order the pair however it likes —
    // the #93 hazard, reached through a malformed stat rather than a double null.
    const nan = unreadable({ bingoCount: Number.NaN, firstBingoAt: Number.NaN });
    const ok = player({ bingoCount: 0, firstBingoAt: 1_000 });
    expect(comparePlayers(nan, ok)).not.toBeNaN();
    expect(comparePlayers(ok, nan)).not.toBeNaN();
    // A NaN instant is no instant: it sorts last, exactly as `null` does.
    expect(comparePlayers(nan, ok)).toBeGreaterThan(0);
  });

  it('sortPlayers orders a roster containing one unreadable row instead of throwing', () => {
    const roster = [
      unreadable({ bingoCount: { toString: null }, squaresMarked: 99 }),
      player({ bingoCount: 2, squaresMarked: 3 }),
      player({ bingoCount: 1, squaresMarked: 3 }),
    ];
    expect(() => sortPlayers(roster)).not.toThrow();
    // The unreadable row ranks last on its coerced 0, and — the point of the
    // guard — the two well-formed rows keep the order they always had.
    expect(sortPlayers(roster).map((r) => r.bingoCount)).toEqual([2, 1, roster[0].bingoCount]);
  });
});
