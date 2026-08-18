import { describe, it, expect } from 'vitest';
import { lastCallLineFromPlayers, DEFAULT_FREEZE_PHRASE, type LastCallCopyPlayer } from './lastCallCopy';

// Extracted from src/components/ProofFeed.tsx (#800) so the client's last-call
// reconstruction is a pure, package-decoupled module — the same posture
// functions/src/finaleContent.ts takes, and importable from a parity test
// without pulling React/Firebase into a node-environment suite.

function player(p: Partial<LastCallCopyPlayer> & Pick<LastCallCopyPlayer, 'uid'>): LastCallCopyPlayer {
  return { displayName: p.uid, bingoCount: 0, squaresMarked: 0, ...p };
}

describe('lastCallLineFromPlayers', () => {
  it('defaults to the historical freeze phrase when none is given', () => {
    const line = lastCallLineFromPlayers([player({ uid: 'Jess', bingoCount: 1 })]);
    expect(line).toBe(`Jess has the board to themselves going into the final night—${DEFAULT_FREEZE_PHRASE}.`);
  });

  it('#800: uses the INJECTED freeze phrase instead of a hardcoded literal', () => {
    const line = lastCallLineFromPlayers(
      [player({ uid: 'Jess', bingoCount: 2, squaresMarked: 10 }), player({ uid: 'Rex', bingoCount: 1, squaresMarked: 10 })],
      'standings freeze at 11 a.m',
    );
    expect(line).toBe('Jess leads by 1 bingo—standings freeze at 11 a.m.');
  });

  it('degrades to a generic line on an empty board', () => {
    expect(lastCallLineFromPlayers([])).toContain('wide open going into the final night');
  });

  it('degrades to a generic line on a dead heat at the top', () => {
    const line = lastCallLineFromPlayers([
      player({ uid: 'Jess', bingoCount: 2, squaresMarked: 20 }),
      player({ uid: 'Rex', bingoCount: 2, squaresMarked: 20 }),
    ]);
    expect(line).toBe(`It's neck and neck at the top going into the final night—${DEFAULT_FREEZE_PHRASE}.`);
  });

  it('falls back to a square margin when bingos tie', () => {
    const line = lastCallLineFromPlayers([
      player({ uid: 'Jess', bingoCount: 1, squaresMarked: 22 }),
      player({ uid: 'Rex', bingoCount: 1, squaresMarked: 15 }),
    ]);
    expect(line).toContain('Jess leads by 7 squares—');
  });
});
