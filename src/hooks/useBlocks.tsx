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
// listener key and the counterpart, so a pair costs one (almost always denied)
// server-only delete per app session, plus one each time it REAPPEARS after a
// subscription's first server answer (the listener clears its entry then, so
// a reappearing pair that may be a fresh orphan is offered again): durable,
// because every new session retries, and cheap, because a pair that stays
// put is never asked about twice in one session.
const reconcileAttempted = new Set<string>();

// The missing-pair repair's retry backoff after a failure while the listener
// is server-backed. A failed write produces no snapshot, so without a timer a
// stable query would never retry it (Codex P1 on #1300). Bounded: after the
// last retry the repair waits for the next server snapshot, as before.
export const REPAIR_RETRY_BASE_MS = 5_000;
export const REPAIR_RETRY_ATTEMPTS = 5;

/** Test seam: forget which pairs this session has already reconciled. */
export function resetReconcileAttemptsForTests(): void {
  reconcileAttempted.clear();
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
 * which swallows errors): it logs and resolves ready with the last set it
 * published, never blank. Before a first answer that is the empty set, so the
 * app renders unfiltered (the same admission failure would deny the content
 * listeners too); after one, the last hidden set stays until a remount or
 * reload resubscribes.
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
    // The counterparts of the previous snapshot (pending or settled), so a
    // pair DISAPPEARING from a server-confirmed snapshot can be seen.
    let previous: ReadonlySet<string> = EMPTY;
    // Whether `repairMissingPairs` has checked the viewer's own directions in
    // THIS subscription's lifetime. Per subscription, not per session (Codex
    // P1 on #1300): a gap while unsubscribed (signed out, another Event) can
    // hide a lost pair that no later snapshot would show disappearing.
    let repairChecked = false;
    // Whether this subscription has had its first server-confirmed answer.
    let reconcileSeeded = false;
    // A pair disappearance seen on ANY snapshot, owed a repair on the next
    // server-confirmed one. `previous` advances on pending and cache
    // snapshots too, so a loss seen there would otherwise be forgotten before
    // a settled snapshot could act on it (Phase 4b on #1300).
    let repairOwed = false;
    // The latest server-confirmed counterparts and whether the listener is
    // server-backed now, for a timer-driven repair retry.
    let latestServer: ReadonlySet<string> = EMPTY;
    let serverBacked = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retriesLeft = REPAIR_RETRY_ATTEMPTS;
    let retryDelay = REPAIR_RETRY_BASE_MS;
    const clearRetry = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };
    const runRepair = () => {
      clearRetry();
      repairChecked = true;
      repairMissingPairs({ me: uid, knownCounterparts: latestServer, eventId }).then(
        () => {
          retriesLeft = REPAIR_RETRY_ATTEMPTS;
          retryDelay = REPAIR_RETRY_BASE_MS;
        },
        () => {
          if (!active) return;
          // Re-armed for the next server snapshot in every case...
          repairChecked = false;
          // ...and, while the listener is server-backed, retried on a
          // doubling timer (offline, the reconnection snapshot re-runs it).
          if (!serverBacked || retriesLeft <= 0 || retryTimer !== null) return;
          retriesLeft -= 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (active && serverBacked && !repairChecked) runRepair();
          }, retryDelay);
          retryDelay *= 2;
        },
      );
    };
    const unsub = onSnapshot(
      query(blockPairsCol(eventId), where('uids', 'array-contains', uid)),
      { includeMetadataChanges: true },
      (snap) => {
        if (!active) return;
        const current = hiddenUidsFromPairs(snap.docs.map((d) => d.data()), uid);
        if ([...previous].some((other) => !current.has(other))) repairOwed = true;
        // A pair that APPEARS after this subscription's first server answer
        // (a new block, or a repair write that landed after an unblock and so
        // recreated an orphan; Codex P1 on #1300) is offered to the orphan
        // reconciler again, whatever an earlier offer this session said.
        if (reconcileSeeded) {
          for (const other of current) {
            if (!previous.has(other)) reconcileAttempted.delete(`${key}|${other}`);
          }
        }
        previous = current;
        // A cache snapshot means the listener lost the server (an outage, or
        // the SDK's offline fallback). A pair created AND deleted during that
        // gap never shows as disappearing, so the direction check re-arms for
        // the next server snapshot (Codex P1 on #1300): one listing per
        // reconnection.
        if (snap.metadata.fromCache) repairChecked = false;
        serverBacked = !snap.metadata.fromCache;
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
          reconcileSeeded = true;
          // ...and restore the pair behind any own direction that lost it to
          // a concurrent delete (see `repairMissingPairs`): once per
          // subscription, and again whenever a pair has disappeared on any
          // snapshot since the last server-confirmed one, which is the only
          // way that race shows on a live listener (Codex P1 on #1300).
          // An ordinary unblock also removes a pair, so it costs one server
          // listing; a failed run re-arms the next snapshot and, while the
          // listener stays server-backed, a bounded backoff timer.
          latestServer = current;
          if (!repairChecked || repairOwed) {
            repairOwed = false;
            runRepair();
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
      clearRetry();
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
