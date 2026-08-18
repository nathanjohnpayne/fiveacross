import { describe, it, expect } from 'vitest';
import { lastCallStandingsCopy, type FinalePlayer } from '../../functions/src/finaleContent';
import { lastCallLineFromPlayers, type LastCallCopyPlayer } from '../../src/lastCallCopy';

// Parity guard for the client/functions last-call-line mirror (#800, ADR
// 0011, cf. the tutorial-day-index parity test in finale-parity.test.ts).
//
// `functions/src/finaleContent.ts`'s `lastCallStandingsCopy` (the scheduler's
// authoritative content builder) and `src/lastCallCopy.ts`'s
// `lastCallLineFromPlayers` (the Feed's ban-aware client reconstruction) are
// deliberately decoupled implementations of the SAME leader/margin sentence.
// They had already drifted once — both independently hardcoded the freeze-
// time phrase as the literal "8 a.m." regardless of the Event's actual
// closing-Day unlock (#800). Feeding one fixture set to both and asserting
// byte-identical output is intended to FAIL if either side changes alone.
//
// Fixtures deliberately avoid a two-way tie on BOTH bingoCount and
// squaresMarked except in the "neck and neck" case: the two implementations
// use different tie-break orders below that level (functions: earliest
// firstBingoAt; client: displayName) — a pre-existing, separately-scoped
// divergence that this test does not exercise, since neither tie-break
// affects the neck-and-neck sentence (it names no leader).

const FREEZE_PHRASE = 'standings freeze at 11 a.m';

function fnsPlayer(p: Partial<FinalePlayer> & Pick<FinalePlayer, 'uid'>): FinalePlayer {
  return { displayName: p.uid, bingoCount: 0, squaresMarked: 0, firstBingoAt: null, ...p };
}

function clientPlayer(p: Partial<LastCallCopyPlayer> & Pick<LastCallCopyPlayer, 'uid'>): LastCallCopyPlayer {
  return { displayName: p.uid, bingoCount: 0, squaresMarked: 0, ...p };
}

describe('client/functions parity — last-call standings line (#800)', () => {
  it('agrees on a bingo-margin leader, given the SAME injected freeze phrase', () => {
    const fns = lastCallStandingsCopy(
      [fnsPlayer({ uid: 'Jess', bingoCount: 4, squaresMarked: 30 }), fnsPlayer({ uid: 'Rex', bingoCount: 2, squaresMarked: 28 })],
      { freezePhrase: FREEZE_PHRASE },
    );
    const client = lastCallLineFromPlayers(
      [clientPlayer({ uid: 'Jess', bingoCount: 4, squaresMarked: 30 }), clientPlayer({ uid: 'Rex', bingoCount: 2, squaresMarked: 28 })],
      FREEZE_PHRASE,
    );
    expect(client).toBe(fns);
    expect(fns).toBe(`Jess leads by 2 bingos—${FREEZE_PHRASE}.`);
  });

  it('agrees on a square-margin leader when bingos tie', () => {
    const fns = lastCallStandingsCopy(
      [fnsPlayer({ uid: 'Jess', bingoCount: 1, squaresMarked: 22 }), fnsPlayer({ uid: 'Rex', bingoCount: 1, squaresMarked: 15 })],
      { freezePhrase: FREEZE_PHRASE },
    );
    const client = lastCallLineFromPlayers(
      [clientPlayer({ uid: 'Jess', bingoCount: 1, squaresMarked: 22 }), clientPlayer({ uid: 'Rex', bingoCount: 1, squaresMarked: 15 })],
      FREEZE_PHRASE,
    );
    expect(client).toBe(fns);
    expect(fns).toBe(`Jess leads by 7 squares—${FREEZE_PHRASE}.`);
  });

  it('agrees on a solo leader (board to themselves)', () => {
    const fns = lastCallStandingsCopy([fnsPlayer({ uid: 'Jess', bingoCount: 2, squaresMarked: 10 })], {
      freezePhrase: FREEZE_PHRASE,
    });
    const client = lastCallLineFromPlayers([clientPlayer({ uid: 'Jess', bingoCount: 2, squaresMarked: 10 })], FREEZE_PHRASE);
    expect(client).toBe(fns);
    expect(fns).toBe(`Jess has the board to themselves going into the final night—${FREEZE_PHRASE}.`);
  });

  it('agrees on an empty board', () => {
    const fns = lastCallStandingsCopy([], { freezePhrase: FREEZE_PHRASE });
    const client = lastCallLineFromPlayers([], FREEZE_PHRASE);
    expect(client).toBe(fns);
    expect(fns).toBe(`The board's wide open going into the final night—${FREEZE_PHRASE}.`);
  });

  it('agrees on a dead heat at the top', () => {
    const fns = lastCallStandingsCopy(
      [fnsPlayer({ uid: 'Jess', bingoCount: 2, squaresMarked: 20 }), fnsPlayer({ uid: 'Rex', bingoCount: 2, squaresMarked: 20 })],
      { freezePhrase: FREEZE_PHRASE },
    );
    const client = lastCallLineFromPlayers(
      [clientPlayer({ uid: 'Jess', bingoCount: 2, squaresMarked: 20 }), clientPlayer({ uid: 'Rex', bingoCount: 2, squaresMarked: 20 })],
      FREEZE_PHRASE,
    );
    expect(client).toBe(fns);
    expect(fns).toBe(`It's neck and neck at the top going into the final night—${FREEZE_PHRASE}.`);
  });

  it('agrees on the DEFAULT freeze phrase when neither side is given an override', () => {
    const fns = lastCallStandingsCopy([fnsPlayer({ uid: 'Jess', bingoCount: 1 })]);
    const client = lastCallLineFromPlayers([clientPlayer({ uid: 'Jess', bingoCount: 1 })]);
    expect(client).toBe(fns);
  });
});
