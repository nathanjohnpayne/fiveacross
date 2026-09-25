import { useRef, useState } from 'react';
import { unblockPlayer } from '../data/blocks';
import { useMyBlocks } from '../hooks/useBlocks';
import { useLeaderboard } from '../hooks/useData';
import { useOnline } from '../hooks/useOnline';
import { trackIfCurrentEvent } from '../eventScopedAnalytics';
import { EVENT_ID } from '../firebase';
import { editionBrand } from '../editions';

type Outcome = { kind: 'done' | 'still-hidden' | 'error'; name: string };

/**
 * More → Blocked players (#689, specs/player-blocking.md § Block and unblock
 * controls): the viewer's OWN direction records, and the only way to reverse a
 * block. Only the blocker can reverse one, so a block someone else made on the
 * viewer never appears here (the rules keep it unreadable). Names come from the
 * RAW roster, since the counterpart is hidden everywhere else; a target with no
 * Player row reads "A player". The root carries `ph-no-capture` so session
 * replay never records who a Player has blocked.
 *
 * Unblocking is deliberately NOT optimistic: `unblockPlayer` sends server-only
 * transactions, so it needs a connection. While the browser reports offline the
 * button is disabled with a note rather than started (`useOnline` can only
 * trust a `false`); started online, the row reads "Unblocking…" until the
 * server answers. Every settle is reported here, at the panel level, because a
 * landed unblock removes its row from the listener: "Unblocked", the
 * `stillHidden` note (worded as likely, not proven, since an orphaned pair or an
 * unanswered listing reports the same), or, for any error `unblockPlayer`
 * rethrows (a dropped connection, a timeout, a denial on its last attempt), a
 * retry note with the row left in place.
 */
export default function BlockedPlayersPanel({ uid }: { uid: string | null }) {
  const { data: blocks, loading, error } = useMyBlocks(uid);
  const { players } = useLeaderboard();
  const online = useOnline();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const inFlight = useRef(false);
  const occasion = editionBrand().lexicon.occasion;

  const nameOf = (target: string) => players.find((p) => p.uid === target)?.displayName?.trim() || 'A player';
  const rows = [...blocks].sort((a, b) => b.createdAt - a.createdAt);

  const doUnblock = async (target: string) => {
    if (!uid || inFlight.current) return;
    inFlight.current = true;
    const actedEventId = EVENT_ID;
    const name = nameOf(target);
    setConfirming(null);
    setPending(target);
    setOutcome(null);
    try {
      const { stillHidden } = await unblockPlayer({ me: uid, target, eventId: actedEventId });
      trackIfCurrentEvent(actedEventId, 'unblock_player', { stillHidden });
      setOutcome({ kind: stillHidden ? 'still-hidden' : 'done', name });
    } catch (err) {
      console.error('[blocks] unblock failed', err);
      setOutcome({ kind: 'error', name });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  return (
    <div className="blocked-panel ph-no-capture">
      <p className="muted">
        A block hides you and the other player from each other for this {occasion}. Only you can undo a block you
        made.
      </p>
      {outcome && (
        <p className={outcome.kind === 'error' ? 'block-error' : 'block-outcome'} role="status">
          {outcome.kind === 'done' && `Unblocked ${outcome.name}.`}
          {outcome.kind === 'still-hidden' &&
            `Unblocked ${outcome.name}. You’re still hidden from each other for now—usually that means they’ve blocked you too.`}
          {outcome.kind === 'error' && `Couldn’t unblock ${outcome.name}. Check your connection and try again.`}
        </p>
      )}
      {!online && rows.length > 0 && <p className="muted">You&rsquo;re offline. Unblocking needs a connection.</p>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : error ? (
        <p className="block-error">Couldn&rsquo;t load your blocked players. Check your connection and try again.</p>
      ) : rows.length === 0 ? (
        <p className="muted">You haven&rsquo;t blocked anyone.</p>
      ) : (
        <div className="list">
          {rows.map((b) => {
            const name = nameOf(b.targetUid);
            return (
              <div className="row blocked-row" key={b.targetUid}>
                <div className="avatar" aria-hidden="true">
                  {(name[0] ?? '?').toUpperCase()}
                </div>
                <div className="grow">
                  <div className="name">{name}</div>
                </div>
                {confirming !== b.targetUid && (
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Unblock ${name}`}
                    disabled={!online || pending !== null}
                    onClick={() => setConfirming(b.targetUid)}
                  >
                    {pending === b.targetUid ? 'Unblocking…' : 'Unblock'}
                  </button>
                )}
                {confirming === b.targetUid && (
                  <div className="blocked-confirm">
                    <p className="sub">
                      Unblock {name}? You&rsquo;ll see each other again. If they&rsquo;ve also blocked you,
                      you&rsquo;ll stay hidden from each other.
                    </p>
                    <div className="sheet-actions">
                      <button type="button" className="btn" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={!online}
                        onClick={() => void doUnblock(b.targetUid)}
                      >
                        Yes, unblock
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
