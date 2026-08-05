import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { track } from '../analytics';
import { canonicalOrigin } from '../canonicalHost';
import { useEventDoc } from '../hooks/useData';
import {
  confettiPieces,
  CONFETTI_COUNT_BINGO,
  CONFETTI_COUNT_BLACKOUT,
  type ConfettiPiece,
} from '../game/motion';
import { renderBingoShareCard, shareCardBlob, SHARE_CARD_APP_NAME } from './ShareCard';
import type { Cell } from '../types';

function celebrationCopy(kind: 'bingo' | 'blackout'): string {
  return kind === 'blackout' ? 'BLACKOUT. I win the boat. 🚢' : 'I got BINGO on the high seas 🚢';
}

/** The confetti gate (specs/motion-polish.md): decoration only, so a reduced-
 * motion preference (or an environment with no matchMedia at all failing
 * open to "render") skips the LAYER, not just its animation — the CSS kill
 * switch also hides `.confetti`, belt and braces. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export default function Celebration({
  kind,
  cells,
  playerName,
  contextLine,
  statLine,
  onClose,
}: {
  kind: 'bingo' | 'blackout';
  // The Player's own 25-cell board, exactly as Board.tsx has it at the
  // moment it opens this modal (Codex P2, PR #111 finding 1). Celebration
  // used to open its OWN `useBoard(uid)` listener and read `board?.cells ??
  // []`, which starts unset until that subscription's first snapshot
  // arrives — a fast Share tap could render and share a ZERO-CELL card even
  // though Board already had the real cells (its `!board` early-return
  // guarantees a loaded board before <Celebration> ever renders). Taking
  // the prop instead removes the race structurally: there is no second
  // subscription left to lose it.
  cells: Cell[];
  // The Player's RESOLVED public display name — Board.tsx's own
  // `resolveDisplayName(player, user?.displayName)` output, passed down only
  // when its identity tri-state says the saved row is KNOWN (`identityKnown`),
  // and `null` otherwise (Codex P2, PR #111 round 2 finding 1 — the identity
  // twin of the cells race above). Celebration used to run its own
  // `useMyPlayer(uid)` listener + resolveDisplayName, which starts `data:
  // null` on mount, so an immediate Share tap resolved the STALE auth
  // (Google) name for a returning Player with a saved custom name — exactly
  // the window in which Board's doMark deliberately withholds the name from
  // Tally markers. `null` here means "not yet known": the Share affordance
  // is disabled below (mirroring how the Moment broadcasts HOLD until the
  // identity gate opens) rather than ever stamping the auth fallback onto a
  // card. In practice the gate is belt-and-braces: identityKnown is true in
  // every online flow long before a win can be marked (the player-row
  // subscription resolves at app start); the reachable-null window is an
  // offline reload whose persistent cache holds the board but not the
  // player row (see Board.tsx's knownFirstBingoAt comment). The card
  // renders no avatar (BingoShareCardData has no photo field), so only the
  // name is threaded.
  playerName: string | null;
  // Optional card copy (issue #423), composed by Board.tsx from the day it
  // holds (day + port) and the Player's stats — the top context line and the
  // single stat/brag line. Both fall through to the renderer's own defaults
  // (bare event name / nothing) when absent, so this component and the
  // direct-render unit tests can omit them.
  contextLine?: string;
  statLine?: string;
  onClose: () => void;
}) {
  // Event name still resolves via the same hook Board.tsx itself reads: it
  // is not identity (no per-user staleness to leak) and has a benign
  // app-name fallback, pinned by the "falls back to the app name" test.
  const { data: event } = useEventDoc();
  const eventName = event?.name ?? SHARE_CARD_APP_NAME;

  // EAGER pre-render (Codex P2, PR #111 round 2 finding 2): rasterization
  // starts at MOUNT — the card's data is fixed by then — not at tap time. A
  // tap-time `await renderBingoShareCard(...)` could outlive the browser's
  // transient user-activation window on a slow device, making the later
  // `navigator.share` reject NotAllowedError (which the cancellation
  // classifier treats as terminal): the tap would do NOTHING — no sheet, no
  // fallback. With the render pre-started, the tap awaits a
  // usually-already-settled promise and `navigator.share` runs within the
  // activation window. The effect re-keys on the card's inputs, so a
  // late-arriving Event name re-renders the card once rather than baking
  // the stale fallback in. The `.catch(() => null)` lives INSIDE the cached
  // promise: a render failure (unsupported environment, html-to-image
  // throwing, or the 25-cell validity gate refusing a malformed board)
  // resolves to null — never an unhandled rejection when the Player closes
  // without ever tapping Share — and shareCardBlob then degrades to the
  // text/URL leg rather than ever sharing an empty/partial grid.
  //
  // `cardReady` completes the design (Codex P2, PR #111 round 3 finding 1):
  // pre-starting the render narrows the race but a tap can still land while
  // the mount render is UNSETTLED on a slow phone — the tap's await then
  // burns the activation window all the same. So the Share button stays
  // DISABLED until the cached promise SETTLES (resolved blob OR the caught
  // null — "settled", not "blob exists": a failed render must still enable
  // the button so the text/URL fallback stays reachable). A tap can then
  // only ever await an already-settled promise, keeping navigator.share
  // inside its activation window structurally. Visually this reuses the
  // exact identity-gate disable (round 2 finding 1). The `cardBlob.current
  // === promise` check keeps a STALE effect's settle (inputs changed, a new
  // render is in flight) from opening the gate for the newer render.
  const cardBlob = useRef<Promise<Blob | null> | null>(null);
  const [cardReady, setCardReady] = useState(false);

  // One confetti burst per celebration mount (lazy initializer — regenerating
  // on a re-render would restart the rain mid-fall); null under reduced
  // motion, which skips rendering the layer at all.
  const [confetti] = useState<ConfettiPiece[] | null>(() =>
    prefersReducedMotion()
      ? null
      : confettiPieces(kind === 'blackout' ? CONFETTI_COUNT_BLACKOUT : CONFETTI_COUNT_BINGO),
  );
  useEffect(() => {
    if (playerName == null) {
      // Identity not yet known (round 2 finding 1): nothing to pre-render —
      // the Share affordance is disabled until Board resolves the saved name.
      cardBlob.current = null;
      setCardReady(false);
      return;
    }
    setCardReady(false);
    const promise = renderBingoShareCard({
      kind,
      playerName,
      eventName,
      cells,
      contextLine,
      statLine,
    }).catch(() => null);
    cardBlob.current = promise;
    void promise.then(() => {
      if (cardBlob.current === promise) setCardReady(true);
    });
  }, [kind, playerName, eventName, cells, contextLine, statLine]);

  const share = async () => {
    const pending = cardBlob.current;
    // The disabled button (identity known + render settled) is the real
    // gate; this is belt-and-braces against a programmatic call.
    if (playerName == null || pending == null) return;
    const text = celebrationCopy(kind);
    // Canonical hostname (#556), not the raw origin — see Leaderboard's
    // shareLeaderboard for the rationale.
    const url = canonicalOrigin();

    // Settled by construction: the button only enables once `pending`
    // settled, so this await resolves on the microtask queue and
    // navigator.share below runs within the tap's activation window.
    const blob = await pending;

    try {
      await shareCardBlob({
        blob,
        filename: `gay-cruise-bingo-${kind}.png`,
        title: SHARE_CARD_APP_NAME,
        text,
        url,
      });
    } catch {
      // shareCardBlob is designed to never throw, but a share failure must
      // never crash the celebration UI regardless.
    } finally {
      // Fires on every path — image share, cancelled share, every fallback
      // leg, or a render failure — so a cancelled share still counts as a
      // tap (Codex P2, PR #111 finding 3): shareCardBlob's return value is
      // what distinguishes the outcomes, not whether this event fires.
      track('share_click', { surface: 'celebration' });
    }
  };

  const hero = kind === 'blackout' ? 'BLACKOUT' : 'BINGO!';

  return (
    <div className="celebrate" onClick={onClose}>
      {/* The jackpot rain (specs/motion-polish.md): generated once per mount,
          sized to the win (blackout gets the bigger burst), colored purely by
          theme tokens. Skipped entirely under reduced motion. */}
      {confetti && (
        <div className="confetti" aria-hidden="true">
          {confetti.map((p, i) => (
            <i
              key={i}
              style={
                {
                  left: `${p.leftPct}%`,
                  width: `${p.sizePx}px`,
                  height: `${Math.round(p.sizePx * 1.6)}px`,
                  '--confetti-c': p.color,
                  animationDelay: `${p.delayMs}ms`,
                  animationDuration: `${p.durationMs}ms`,
                  '--drift': `${p.driftPx}px`,
                  '--spin': `${p.spinDeg}deg`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      <div className="celebrate-card" onClick={(e) => e.stopPropagation()}>
        {/* The hero word slams in letter by letter (`.big-letter`, index.css).
            Screen readers get the intact word once; the animated letters are
            hidden from the a11y tree so nothing spells B-I-N-G-O aloud. The
            element's text content still CONTAINS the word, so the e2e
            `.big { hasText }` locators keep matching. */}
        <div className="big">
          <span className="visually-hidden">{hero}</span>
          <span aria-hidden="true">
            {hero.split('').map((letter, i) => (
              <span key={i} className="big-letter" style={{ '--letter-i': i } as CSSProperties}>
                {letter}
              </span>
            ))}
          </span>
        </div>
        <p className="muted" style={{ letterSpacing: '0.14em', textTransform: 'uppercase' }}>
          You've seen some things.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={share} disabled={playerName == null || !cardReady}>
            Share
          </button>
          <button className="btn" onClick={onClose}>
            Keep playing
          </button>
        </div>
      </div>
    </div>
  );
}
