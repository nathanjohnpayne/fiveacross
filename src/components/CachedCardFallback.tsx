import type { CardSnapshot } from '../data/cardCache';
import { countMarked } from '../game/logic';
import SquareText from './SquareText';

/**
 * The durable-cache fallback for the Card tab (#434). When the client-driven
 * deal fails (offline, flaky ship wifi) BUT this device has a saved card
 * snapshot, App renders THIS read-only view of that card instead of the
 * full-screen "we couldn't deal your card" reload screen — so a Player who was
 * already dealt in still sees their squares, with a background Retry, rather
 * than a dead-end. The full reload screen (DealError) is reserved for a genuine
 * first-timer with nothing cached.
 *
 * Read-only on purpose: marking, Tally, and Doubts all need the LIVE board and
 * its writers, which the interactive <Board/> takes back over the instant the
 * deal recovers (`dealError` clears) and App swaps this out. This view only has
 * to answer "what does my card look like?" from the last snapshot, so it paints
 * the grid, the Day header, and the marked count — no live subscriptions, no
 * badges, no tap handlers.
 */
export default function CachedCardFallback({
  snapshot,
  onRetry,
  retrying,
}: {
  snapshot: CardSnapshot;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { cells, day, bingoCount } = snapshot;
  return (
    <div className="board-area cached-card" data-theme={day?.theme}>
      <div className="cached-card-banner" role="status">
        <span className="cached-card-banner-text">
          Showing your saved card—reconnecting to sync the latest.
        </span>
        <button type="button" className="btn primary" disabled={retrying} onClick={onRetry}>
          {retrying ? 'Dealing…' : 'Retry'}
        </button>
      </div>
      {day && (
        <div className="board-header daybar-block">
          <div className="daybar">
            <div className="daybar-name">
              Day {day.number} · {day.label}
            </div>
            <div className="daybar-meta">
              <span aria-hidden="true">{day.placeEmoji}</span> {day.place}
            </div>
          </div>
        </div>
      )}
      <div className="bingo-head" aria-hidden="true">
        {['B', 'I', 'N', 'G', 'O'].map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      <div className="grid">
        {cells.map((c) => (
          <div
            key={c.index}
            className={
              'cell' +
              (c.free ? ' free' : '') +
              (c.marked ? ' marked' : '') +
              // Mirror the live Board: an admin_confirmed claim that is still
              // marked-but-`pending` must read as unconfirmed (faded/dashed)
              // here too, so the cached card never overstates confirmed
              // progress (Codex P2, #438).
              (c.status === 'pending' ? ' pending' : '') +
              // "New from the group" (#559, Codex P2, PR #845 round 6): the
              // saved snapshot's cells carry `communityPrompt` same as the
              // live Board's (it's part of the `Cell` shape `saveCardSnapshot`
              // persists verbatim), so the durable offline/flaky-Wi-Fi view
              // — the one this fallback exists FOR — must not be the one
              // place the ring silently disappears.
              (!c.free && c.communityPrompt ? ' community' : '')
            }
            aria-label={c.free ? c.text : undefined}
          >
            {c.free ? (
              <>
                <span className="free-label" aria-hidden="true">
                  FREE
                </span>
                <span className="free-prompt">{c.text}</span>
              </>
            ) : (
              // Reuse Board's auto-fit guard so a long prompt SHRINKS to fit
              // rather than clipping under `.cell { overflow: hidden }` at the
              // Large text setting (Codex P2, #438) — the text-size contract
              // holds on this last-resort view too.
              <SquareText text={c.text} />
            )}
          </div>
        ))}
      </div>
      <div className="count">
        Marked <b>{countMarked(cells)}</b> · Bingos <b>{bingoCount}</b>
      </div>
    </div>
  );
}
