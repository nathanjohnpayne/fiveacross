import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onSnapshot, query, where } from 'firebase/firestore';
import { EVENT_ID } from '../firebase';
import { blockPairsCol, blocksCol } from '../data/paths';
import { computeHiddenSet, hiddenUidsFromPairs, reconcileOrphanPair, repairMissingPairs } from '../data/blocks';
import { eventScopeKey } from '../data/eventScope';
import type { BlockDoc } from '../types';

// Player blocking (#689, specs/player-blocking.md): the viewer's reciprocal
// hidden set, provided once from the app shell so every content hook and
// surface reads ONE listener. A LEAF module on purpose: it imports nothing
// from ./useData or ../auth, so AuthContext can mount the provider without a
// cycle (AuthContext imports ConfirmWinMoments, which imports useData), and
// the suites that close-mock ../hooks/useData keep working unmodified.

export interface HiddenUids {
  /** The uids the viewer hides and is hidden from in this Event. */
  hidden: ReadonlySet<string>;
  /** True once the first snapshot (cache or server) has arrived, the viewer is
   * signed out, or no provider is mounted. Content hooks gate their loading
   * state on this so a blocked Player never flashes in before the listener's
   * first answer. Deliberately not server-gated (ADR 0006 offline play): a
   * stale cached pair set shows until the server snapshot lands, the
   * staleness every cached read accepts (specs/player-blocking.md). */
  ready: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

// Pairs already offered to `reconcileOrphanPair` this session, keyed on the
// listener key and the counterpart, so each pair costs at most one (almost
// always denied) server-only delete per app session: durable, because every
// new session retries, and cheap, because it never repeats within one.
const reconcileAttempted = new Set<string>();
// Listener keys whose own directions have been checked by `repairMissingPairs`
// this session (once each; a failed server listing clears the mark to retry).
const repairAttempted = new Set<string>();

/** Test seam: forget which pairs this session has already reconciled. */
export function resetReconcileAttemptsForTests(): void {
  reconcileAttempted.clear();
  repairAttempted.clear();
}
// The DEFAULT: no provider means nothing is hidden and nothing waits, so every
// tree that predates the provider renders exactly as it did.
const NONE: HiddenUids = { hidden: EMPTY, ready: true };
const HiddenUidsContext = createContext<HiddenUids>(NONE);

interface HiddenState {
  key: string | null;
  hidden: ReadonlySet<string>;
  ready: boolean;
}

// Signed out: ready with nothing hidden. Signed in with no key (the shell has
// not admitted the viewer to Event watchers yet, or the listener has not
// answered): NOT ready, so a late admission flip cannot render the counterpart
// before the first pair snapshot lands.
const initial = (uid: string | null, key: string | null): HiddenState => ({
  key,
  hidden: EMPTY,
  ready: uid === null,
});

/**
 * ONE `includeMetadataChanges` listener on `where('uids', 'array-contains',
 * uid)`, keyed on the Event AND the uid so an Event or account switch drops
 * the old set before the new listener answers. `lastCommitted` is the set from
 * the latest snapshot without pending writes; see `computeHiddenSet` for why a
 * pending snapshot publishes the union. A pair only ever LEAVES this query
 * once the server has accepted its delete (`unblockPlayer` never deletes
 * locally), so no unblock, denied or pending, can reveal a counterpart early. The error path is EXPLICIT (unlike useColSub,
 * which swallows errors): it logs and resolves ready with the last set, so the
 * app renders unfiltered rather than blank. The same admission failure would
 * deny the content listeners too.
 */
export function useHiddenUidsSubscription(uid: string | null, enabled: boolean): HiddenUids {
  const eventId = EVENT_ID;
  const key = uid !== null && enabled ? eventScopeKey(eventId, 'block-pairs', uid) : null;
  const [state, setState] = useState<HiddenState>(() => initial(uid, key));
  useEffect(() => {
    setState(initial(uid, key));
    if (key === null || uid === null) return;
    let active = true;
    let lastCommitted: ReadonlySet<string> = EMPTY;
    const unsub = onSnapshot(
      query(blockPairsCol(eventId), where('uids', 'array-contains', uid)),
      { includeMetadataChanges: true },
      (snap) => {
        if (!active) return;
        const current = hiddenUidsFromPairs(snap.docs.map((d) => d.data()), uid);
        if (!snap.metadata.hasPendingWrites) lastCommitted = current;
        // Server-confirmed pairs only (offline the delete could not run, and
        // the attempt would be spent): offer each one to the reconciler once.
        if (!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) {
          for (const other of current) {
            const attempt = `${key}|${other}`;
            if (reconcileAttempted.has(attempt)) continue;
            reconcileAttempted.add(attempt);
            void reconcileOrphanPair({ me: uid, target: other, eventId });
          }
          // ...and, once, restore the pair behind any own direction that
          // lost it to a concurrent delete (see `repairMissingPairs`).
          if (!repairAttempted.has(key)) {
            repairAttempted.add(key);
            repairMissingPairs({ me: uid, knownCounterparts: current, eventId }).catch(() => {
              repairAttempted.delete(key);
            });
          }
        }
        setState({
          key,
          hidden: computeHiddenSet(current, lastCommitted, snap.metadata.hasPendingWrites),
          ready: true,
        });
      },
      (err) => {
        if (!active) return;
        console.error('[blocks] hidden-set listener failed; rendering unfiltered', err);
        setState((prev) => ({ key, hidden: prev.key === key ? prev.hidden : EMPTY, ready: true }));
      },
    );
    return () => {
      active = false;
      unsub();
    };
  }, [key, uid, eventId]);
  // With no key there is no listener, so the answer follows from `uid` alone,
  // derived on THIS render (Codex P1 on #1300): comparing keys would let a
  // sign-in while not yet enabled (null key before and after) return the
  // signed-out `ready: true` for the render before the effect resets it.
  if (key === null) return { hidden: EMPTY, ready: uid === null };
  return state.key === key ? { hidden: state.hidden, ready: state.ready } : { hidden: EMPTY, ready: false };
}

export function HiddenUidsProvider({
  uid,
  enabled,
  children,
}: {
  uid: string | null;
  enabled: boolean;
  children: ReactNode;
}) {
  const value = useHiddenUidsSubscription(uid, enabled);
  return <HiddenUidsContext.Provider value={value}>{children}</HiddenUidsContext.Provider>;
}

/** The viewer's hidden set. Without a provider: nothing hidden, ready. */
export function useHiddenUids(): HiddenUids {
  return useContext(HiddenUidsContext);
}

/**
 * The viewer's OWN direction records (`where('ownerUid', '==', uid)`), the
 * only readable ones: the Blocked-players panel lists these. Errors resolve
 * to an empty, settled list with a console.error, never a hung spinner.
 */
export function useMyBlocks(uid: string | null): { data: BlockDoc[]; loading: boolean } {
  const eventId = EVENT_ID;
  const key = uid !== null ? eventScopeKey(eventId, 'my-blocks', uid) : null;
  const [state, setState] = useState<{ key: string | null; data: BlockDoc[]; loading: boolean }>(
    () => ({ key, data: [], loading: uid !== null }),
  );
  useEffect(() => {
    setState({ key, data: [], loading: uid !== null });
    if (key === null || uid === null) return;
    let active = true;
    const unsub = onSnapshot(
      query(blocksCol(eventId), where('ownerUid', '==', uid)),
      (snap) => {
        if (!active) return;
        setState({ key, data: snap.docs.map((d) => d.data()), loading: false });
      },
      (err) => {
        if (!active) return;
        console.error('[blocks] own-blocks listener failed', err);
        setState({ key, data: [], loading: false });
      },
    );
    return () => {
      active = false;
      unsub();
    };
  }, [key, uid, eventId]);
  return state.key === key
    ? { data: state.data, loading: state.loading }
    : { data: [], loading: uid !== null };
}
