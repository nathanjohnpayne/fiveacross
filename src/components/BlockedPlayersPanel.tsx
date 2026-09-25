import { useEffect, useRef, useState } from 'react';
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
  const { players, hasServerData: rosterConfirmed } = useLeaderboard();
  const online = useOnline();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Targets whose unblock the server already confirmed, keyed to the record's
  // createdAt: the row stays hidden (and so can't be unblocked a second time)
  // even if the own-blocks listener is slow to deliver the deletion.
  const [unblocked, setUnblocked] = useState<Record<string, number>>({});
  const inFlight = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const unblockButtons = useRef(new Map<string, HTMLButtonElement>());
  const prevConfirming = useRef<string | null>(null);
  const occasion = editionBrand().lexicon.occasion;

  // "A player" is reserved for a target with no usable name on a server-confirmed
  // roster; until the roster resolves, an unnamed target is still loading and its
  // Unblock stays disabled so nobody reverses a block without knowing whose it is.
  // The name is read defensively: the Player row's rules validate ownership, not
  // the field's type, so a target could store a non-string (or a blank) name, and
  // neither may crash or unlock the one place a block is reversed.
  const rosterName = (target: string): string => {
    const raw: unknown = players.find((p) => p.uid === target)?.displayName;
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const nameKnown = (target: string) => rosterConfirmed || rosterName(target) !== '';
  const nameOf = (target: string) => rosterName(target) || (rosterConfirmed ? 'A player' : 'Loading…');
  const rows = [...blocks]
    .filter((b) => unblocked[b.targetUid] !== b.createdAt)
    .sort((a, b) => b.createdAt - a.createdAt);

  const doUnblock = async (target: string, createdAt: number) => {
    if (!uid || inFlight.current) return;
    inFlight.current = true;
    const actedEventId = EVENT_ID;
    const name = nameOf(target);
    setConfirming(null);
    setPending(target);
    setOutcome(null);
    try {
      const { stillHidden } = await unblockPlayer({ me: uid, target, eventId: actedEventId });
      setUnblocked((prev) => ({ ...prev, [target]: createdAt }));
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

  // Opening the inline confirmation unmounts the focused Unblock, and Cancel
  // unmounts the confirmation, so move focus with them: onto the confirmation's
  // Cancel when it opens, and back onto that row's Unblock when it is cancelled.
  // "Yes, unblock" also closes it, but sets `pending` in the same render, and the
  // effect below owns focus from there.
  useEffect(() => {
    const prev = prevConfirming.current;
    prevConfirming.current = confirming;
    if (confirming !== null) {
      confirmCancelRef.current?.focus();
    } else if (prev !== null && pending === null) {
      unblockButtons.current.get(prev)?.focus();
    }
  }, [confirming, pending]);

  // Confirming unmounts the focused "Yes, unblock", and a landed unblock removes
  // its whole row, so keyboard focus would drop to <body> behind the open panel.
  // Keep it inside: on the panel while the request runs, then on the outcome.
  useEffect(() => {
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || active === rootRef.current;
    if (!lost) return;
    (outcome ? statusRef : rootRef).current?.focus();
  }, [pending, outcome]);

  return (
    <div className="blocked-panel ph-no-capture" ref={rootRef} tabIndex={-1}>
      <p className="muted">
        A block hides you and the other player from each other for this {occasion}. Only you can undo a block you
        made.
      </p>
      {outcome && (
        <p
          className={outcome.kind === 'error' ? 'block-error' : 'block-outcome'}
          role="status"
          ref={statusRef}
          tabIndex={-1}
        >
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
                    ref={(el) => {
                      if (el) unblockButtons.current.set(b.targetUid, el);
                      else unblockButtons.current.delete(b.targetUid);
                    }}
                    aria-label={`Unblock ${name}`}
                    disabled={!online || pending !== null || !nameKnown(b.targetUid)}
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
                      <button type="button" className="btn" ref={confirmCancelRef} onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={!online || !nameKnown(b.targetUid)}
                        onClick={() => void doUnblock(b.targetUid, b.createdAt)}
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
