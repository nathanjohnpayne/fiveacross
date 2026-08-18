/**
 * The client's own reconstruction of the last-call standings line (#266,
 * #800). `ProofFeed.tsx` cannot simply display the scheduler's persisted
 * `Moment.line` string: a Player banned AFTER the beat posted must still be
 * removable from a still-live leaderboard read, and the persisted string
 * cannot un-name a since-banned leader. So the Feed re-derives the sentence
 * from `Moment.lastCall.players`, filtered to exclude any now-banned uid.
 *
 * This MIRRORS `lastCallStandingsCopy` in `functions/src/finaleContent.ts` —
 * the same leader/margin phrasing rules, restated here because the app and
 * functions packages are deliberately decoupled (ADR 0011; the same posture
 * `autohide.ts` takes toward `moderation.ts`). A mirror without a parity test
 * is how two rendering paths drift apart, which is exactly what happened here
 * before #800: both sides independently hardcoded the freeze-time phrase as
 * the literal "8 a.m.", regardless of the Event's actual closing-Day unlock.
 * `tests/functions/lastcall-copy-parity.test.ts` feeds identical fixtures to
 * both implementations and asserts byte-identical output.
 *
 * `freezePhrase` is a plain parameter now (#800), not a hardcoded literal:
 * the scheduler computes it ONCE, from the real `farewellUnlockAt` formatted
 * in the Event's timezone (`freezePhraseForUnlock`), and writes it into the
 * Moment payload — this module just reads it back, so the two rendering paths
 * cannot independently drift on WHAT time to quote, only (if ever) on HOW the
 * sentence around it reads.
 */

export interface LastCallCopyPlayer {
  uid: string;
  displayName: string;
  bingoCount: number;
  squaresMarked: number;
}

/** Matches `functions/src/finaleContent.ts`'s `DEFAULT_FREEZE_PHRASE`
 *  verbatim — the fallback for a legacy `last_call` Moment posted before
 *  #800, whose payload carries no `freezePhrase`. */
export const DEFAULT_FREEZE_PHRASE = 'standings freeze at 8 a.m';

/**
 * The going-into-the-final-night last-call line. Names the current leader and
 * their margin over the runner-up — by bingos when they lead on bingos, else
 * by squares when the bingos tie — degrading gracefully:
 *
 *   - an empty board (nobody has marked anything) → a generic "wide open" line;
 *   - a solo leader (only one Player) → a "board to themselves" line;
 *   - a dead heat at the top (leader and runner-up tie on bingos AND squares) →
 *     a generic "neck and neck" line.
 *
 * Em dashes take no surrounding spaces (CMOS), matching the spec's example.
 */
export function lastCallLineFromPlayers(
  players: readonly LastCallCopyPlayer[],
  freezePhrase: string = DEFAULT_FREEZE_PHRASE,
): string {
  const ranked = [...players].sort((a, b) => {
    if (b.bingoCount !== a.bingoCount) return b.bingoCount - a.bingoCount;
    if (b.squaresMarked !== a.squaresMarked) return b.squaresMarked - a.squaresMarked;
    return a.displayName.localeCompare(b.displayName);
  });
  const leader = ranked[0];

  if (!leader || (leader.bingoCount === 0 && leader.squaresMarked === 0)) {
    return `The board's wide open going into the final night—${freezePhrase}.`;
  }
  const runnerUp = ranked[1];
  if (!runnerUp) {
    return `${leader.displayName} has the board to themselves going into the final night—${freezePhrase}.`;
  }

  const bingoMargin = leader.bingoCount - runnerUp.bingoCount;
  if (bingoMargin > 0) {
    return `${leader.displayName} leads by ${bingoMargin} bingo${bingoMargin === 1 ? '' : 's'}—${freezePhrase}.`;
  }
  const squareMargin = leader.squaresMarked - runnerUp.squaresMarked;
  if (squareMargin > 0) {
    return `${leader.displayName} leads by ${squareMargin} square${squareMargin === 1 ? '' : 's'}—${freezePhrase}.`;
  }
  return `It's neck and neck at the top going into the final night—${freezePhrase}.`;
}
