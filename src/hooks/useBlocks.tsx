import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { onSnapshot, query, waitForPendingWrites, where } from 'firebase/firestore';
import { db as gameplayDb, EVENT_ID } from '../firebase';
import { capturePrivateFirestore, retryPrivateFirestoreSession } from '../privateFirestore';
import { usePrivateFirestore } from './usePrivateFirestore';
import { useOnline } from './useOnline';
import { blockPairsCol, blocksCol } from '../data/paths';
import { computeHiddenSet, hiddenUidsFromPairs, reconcileOrphanPair, repairMissingPairs, subscribePendingBlocks, pendingBlockTargets, observeConfirmedBlockTargets, retirePendingBlocksOutsideScope } from '../data/blocks';
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
  /** True only after gameplay queue drain and a confirmed private-memory answer for this UID/Event.
   * Mid-use offline retains that same scope's confirmed set in memory; cold
   * offline starts and unreadable first answers withhold Feed/Tally. */
  ready: boolean;
  /** A failed bridge, drain or first-answer budget is actionable instead of loading forever. */
  failed?: boolean;
  retry?: () => void;
}

// One visibility episode stays on its captured memory client. Ship Wi-Fi may
// drain slowly: later attempts allow more time without rotating private Auth.
const DRAIN_WAIT_MS = [5_000, 10_000, 20_000] as const;
const READINESS_BACKOFF_MS = [1_000, 2_000] as const;
const FIRST_ANSWER_WAIT_MS = 10_000;

const EMPTY: ReadonlySet<string> = new Set();

function readinessRetryable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code !== 'permission-denied' && code !== 'unauthenticated';
}

// Session publication and effect execution can straddle retirement. Refuse
// that race without starting a listener against a different account/database.
function captureMatchingLease(uid: string, database: ReturnType<typeof capturePrivateFirestore>['db'], allowRecovery = false) {
  try {
    const lease = capturePrivateFirestore(allowRecovery);
    lease.assertCurrent();
    return lease.uid === uid && lease.db === database ? lease : null;
  } catch {
    return null;
  }
}


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
  generation: number;
  hidden: ReadonlySet<string>;
  ready: boolean;
  failed?: boolean;
}

// Signed out: ready with nothing hidden. Signed in with no key (the shell has
// not admitted the viewer to Event watchers yet, or the listener has not
// answered): NOT ready, so a late admission flip cannot render the counterpart
// before the first pair snapshot lands.
const initial = (uid: string | null, key: string | null, generation: number): HiddenState => ({
  key, generation,
  hidden: EMPTY,
  ready: uid === null,
});

/** One private-memory pair listener per viewer/Event. Only confirmed answers
 * can establish visibility. Pending/cache answers preserve the confirmed union;
 * same-session offline retains that conservative set. Online rebootstrap waits
 * for the gameplay queue to drain before a fresh server answer. Private
 * pair listeners never populate the persistent read cache; the unchanged own
 * block batch still persists its direction/pair write payload for offline sync. */
export function useHiddenUidsSubscription(uid: string | null, enabled: boolean): HiddenUids {
  const session = usePrivateFirestore();
  const eventId = EVENT_ID;
  const key = uid !== null && enabled ? eventScopeKey(eventId, 'block-pairs', uid) : null;
  const [state, setState] = useState<HiddenState>(() => initial(uid, key, session.generation));
  const pending = useSyncExternalStore(subscribePendingBlocks, () => uid ? pendingBlockTargets(uid, eventId) : EMPTY);
  // The single shell provider retires other scopes only after committing a
  // scope change. Same-scope remounts keep process-local unfinished intent.
  useEffect(() => { retirePendingBlocksOutsideScope(uid, eventId); }, [uid, eventId]);
  const confirmed = useRef<{ key: string; generation: number; authGeneration: number; hidden: ReadonlySet<string> } | null>(null);
  const [retryEpisode, setRetryEpisode] = useState(0);
  const restart = useRef<{ key: string; generation: number; run: () => void } | null>(null);
  const retryReadiness = () => {
    const current = restart.current;
    if (current?.key === key && current.generation === session.generation) current.run();
  };
  // A discarded render cannot erase committed state. Only an actual connection
  // transition (or an offline session) may carry it across private generations;
  // actual Auth retirement requires a fresh answer from the replacement client.
  // The retained Auth stamp catches an offline retirement even if React misses
  // its publication. Keep rendering offline; re-confirm when back online.
  const witness = confirmed.current?.key === key && session.uid === uid && !session.failed &&
    (confirmed.current.authGeneration === session.authGeneration || !navigator.onLine) && (
    confirmed.current.generation === session.generation || session.transition === 'connection' || !navigator.onLine
  ) ? confirmed.current : null;
  useEffect(() => {
    const carried = confirmed.current?.key === key && session.uid === uid && !session.failed &&
      (confirmed.current.authGeneration === session.authGeneration || !navigator.onLine) && (
      confirmed.current.generation === session.generation || session.transition === 'connection' || !navigator.onLine
    ) ? confirmed.current : null;
    confirmed.current = carried;
    setState(carried ? { key, generation: session.generation, hidden: carried.hidden, ready: !navigator.onLine } : initial(uid, key, session.generation));
    if (key === null || uid === null || session.uid !== uid || session.failed || !session.db) return;
    // Filter bootstrap reads only the named memory client, never the legacy cache.
    // Ordinary own-block/private panels remain gated by attended recovery.
    const lease = captureMatchingLease(uid, session.db, true);
    if (!lease) return;
    let active = true;
    let visibilityFailed = false;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;
    let retireAttempt = () => {};
    const scopeCurrent = () => {
      if (!active || EVENT_ID !== eventId || !navigator.onLine) return false;
      try { lease.assertCurrent(); return true; } catch { return false; }
    };
    const stopEpisode = () => {
      active = false;
      if (backoffTimer !== null) clearTimeout(backoffTimer);
      backoffTimer = null;
      retireAttempt();
    };
    const restartHere = {
      key, generation: session.generation,
      run: () => {
        if (!scopeCurrent()) return;
        stopEpisode(); // Retire old continuations before React commits the retry.
        // A healthy local Retry does not erase known same-scope offline
        // filtering. It cannot admit online content without a fresh answer.
        setState(initial(uid, key, session.generation));
        setRetryEpisode((episode) => episode + 1);
      },
    };
    restart.current = restartHere;
    const startAttempt = (attempt: number) => {
      if (!scopeCurrent()) return;
      let current = true;
      let draining = true;
      let unsubscribe: (() => void) | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      const isCurrent = () => current && scopeCurrent();
      const clearDeadline = () => {
        if (deadline !== null) clearTimeout(deadline);
        deadline = null;
      };
      const retire = () => {
        current = false;
        draining = false;
        clearDeadline();
        clearRetry();
        unsubscribe?.();
      };
      retireAttempt = retire;
      const failAttempt = (retryable = true) => {
        if (!isCurrent()) return;
        visibilityFailed = true;
        if (!retryable) confirmed.current = null;
        setState({ key, generation: session.generation, hidden: EMPTY, ready: false, failed: true });
        retire();
        if (retryable && attempt < READINESS_BACKOFF_MS.length) {
          backoffTimer = setTimeout(() => {
            backoffTimer = null;
            startAttempt(attempt + 1);
          }, READINESS_BACKOFF_MS[attempt]);
        }
      };
      let confirmedThisSubscription = false;
      let lastCommitted: ReadonlySet<string> = carried?.hidden ?? EMPTY;
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
            if (!isCurrent()) return;
            retriesLeft = REPAIR_RETRY_ATTEMPTS;
            retryDelay = REPAIR_RETRY_BASE_MS;
          },
          () => {
            if (!isCurrent()) return;
            // Re-armed for the next server snapshot in every case...
            repairChecked = false;
            // ...and, while the listener is server-backed, retried on a
            // doubling timer (offline, the reconnection snapshot re-runs it).
            if (!serverBacked || retriesLeft <= 0 || retryTimer !== null) return;
            retriesLeft -= 1;
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (isCurrent() && serverBacked && !repairChecked) runRepair();
            }, retryDelay);
            retryDelay *= 2;
          },
        );
      };
      const subscribe = () => onSnapshot(
        query(blockPairsCol(eventId, lease.db), where('uids', 'array-contains', uid)),
        { includeMetadataChanges: true },
        (snap) => {
          if (!isCurrent()) return;
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
          const settled = !snap.metadata.fromCache && !snap.metadata.hasPendingWrites;
          if (settled) {
            clearDeadline();
            visibilityFailed = false;
            confirmedThisSubscription = true;
            lastCommitted = current;
            confirmed.current = { key, generation: session.generation, authGeneration: session.authGeneration, hidden: current };
            observeConfirmedBlockTargets(uid, eventId, current);
          }
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
            key, generation: session.generation,
            hidden: computeHiddenSet(current, lastCommitted, !settled),
            ready: settled || confirmedThisSubscription,
            ...(!confirmedThisSubscription && visibilityFailed ? { failed: true } : {}),
          });
        },
        (err) => {
          if (!isCurrent()) return;
          console.error('[blocks] hidden-set listener failed; withholding until a confirmed answer is available', err);
          // Denial cannot qualify a later offline witness. It is terminal for
          // automatic retry; an explicit local Retry may seek a new permitted answer.
          failAttempt(readinessRetryable(err));
        },
      );
      const subscribeAfterDrain = () => {
        if (!draining || !isCurrent()) return;
        draining = false;
        clearDeadline();
        deadline = setTimeout(() => failAttempt(), FIRST_ANSWER_WAIT_MS);
        try { unsubscribe = subscribe(); }
        catch (error) { failAttempt(readinessRetryable(error)); }
      };
      const failDrain = (error?: unknown) => { if (draining) failAttempt(readinessRetryable(error)); };
      // The persistent gameplay queue may contain reloaded block writes. Only
      // its drain followed by a fresh private answer can establish readiness.
      // Timed-out SDK waiters cannot be cancelled; their attempt fence retires them.
      deadline = setTimeout(failDrain, DRAIN_WAIT_MS[attempt]);
      try { void waitForPendingWrites(gameplayDb).then(subscribeAfterDrain, failDrain); }
      catch (error) { failDrain(error); }
    };
    startAttempt(0);
    return () => {
      stopEpisode();
      if (restart.current === restartHere) restart.current = null;
    };
  }, [key, uid, eventId, session.db, session.generation, session.authGeneration, session.transition, session.uid, session.recoveryRequired, session.failed, retryEpisode]);
  // With no key there is no listener, so the answer follows from `uid` alone,
  // derived on THIS render (Codex P1 on #1300): comparing keys would let a
  // sign-in while not yet enabled (null key before and after) return the
  // signed-out `ready: true` for the render before the effect resets it.
  if (key === null) return { hidden: EMPTY, ready: uid === null };
  if (session.failed) return { hidden: EMPTY, ready: false, failed: true, retry: retryPrivateFirestoreSession };
  const sameSession = session.uid === uid && !session.failed;
  if (!sameSession || (state.generation !== session.generation && (navigator.onLine || !witness))) return { hidden: EMPTY, ready: false };
  if (!session.db && (navigator.onLine || !witness)) return { hidden: EMPTY, ready: false };
  if (state.key === key && state.failed) return { hidden: EMPTY, ready: false, failed: true, retry: retryReadiness };
  return state.key === key
    ? { hidden: state.ready && pending.size > 0 ? computeHiddenSet(pending, state.hidden, true) : state.hidden, ready: state.ready }
    : { hidden: EMPTY, ready: false };
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

/** What `useMyBlocks` reports; see the hook for each field. */
export interface MyBlocks {
  data: BlockDoc[];
  loading: boolean;
  error: boolean;
  /** A committed server answer qualified this current memory listener. */
  confirmed: boolean;
  /** In-process pending block targets plus pending memory-snapshot rows; no direction rows are synthesized. */
  pendingTargets: ReadonlySet<string>;
  denied?: boolean;
  retry?: () => void;
}

const NO_PENDING: ReadonlySet<string> = new Set();

/**
 * Own directions stay quarantined until recovery. A current committed memory
 * answer qualifies rows; server-backed pending updates retain only that answer.
 * Cache, denial and scope retirement clear it. An unanswered online listener
 * becomes unavailable after ten seconds; Retry replaces only this listener.
 * Pending target IDs still come from the own snapshot and in-process batch relay,
 * never synthesized rows or the reciprocal filter's offline witness.
 */
export function useMyBlocks(uid: string | null): MyBlocks {
  const session = usePrivateFirestore();
  const online = useOnline();
  const eventId = EVENT_ID;
  const key = uid !== null ? `${eventScopeKey(eventId, 'my-blocks', uid)}|generation:${session.generation}` : null;
  const pending = useSyncExternalStore(subscribePendingBlocks, () => uid ? pendingBlockTargets(uid, eventId) : EMPTY);
  const [retryEpisode, setRetryEpisode] = useState(0);
  const retireCurrent = useRef<(() => void) | null>(null);
  const empty = (): MyBlocks => ({
    data: [], loading: uid !== null, error: false, confirmed: uid === null, pendingTargets: NO_PENDING,
  });
  const [state, setState] = useState(() => ({ ...empty(), key }));
  const retryRead = () => {
    // Fence callbacks immediately, before React installs the replacement effect.
    retireCurrent.current?.();
    setState({ ...empty(), key });
    setRetryEpisode(episode => episode + 1);
  };
  useEffect(() => {
    setState({ ...empty(), key });
    if (key === null || uid === null || !online || session.recoveryRequired || session.failed) return;
    let active = true;
    let unsubscribe: (() => void) | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const clearDeadline = () => { if (deadline !== null) clearTimeout(deadline); deadline = null; };
    const retire = () => { active = false; clearDeadline(); unsubscribe?.(); unsubscribe = null; };
    retireCurrent.current = retire;
    const fail = (denied = false) => {
      retire();
      setState({ key, data: [], loading: false, error: true, confirmed: false, pendingTargets: NO_PENDING, denied });
    };
    const awaitAnswer = () => { if (deadline === null) deadline = setTimeout(() => { if (active) fail(); }, FIRST_ANSWER_WAIT_MS); };
    awaitAnswer();
    // A not-yet-ready bridge is also bounded, but its Retry must restart the bridge.
    const lease = session.db && session.uid === uid ? captureMatchingLease(uid, session.db) : null;
    if (lease) {
      const current = () => {
        if (!active || navigator.onLine === false) return false;
        try { lease.assertCurrent(); return true; } catch { return false; }
      };
      unsubscribe = onSnapshot(
        query(blocksCol(eventId, lease.db), where('ownerUid', '==', uid)),
        { includeMetadataChanges: true },
        snap => {
          if (!current()) return;
          if (snap.metadata.fromCache) {
            setState({ ...empty(), key });
            awaitAnswer();
            return;
          }
          const pendingRows = snap.docs.filter(doc => doc.metadata.hasPendingWrites).map(doc => doc.data().targetUid);
          if (snap.metadata.hasPendingWrites || pendingRows.length > 0) {
            setState(prev => prev.key === key && prev.confirmed
              ? { ...prev, pendingTargets: pendingRows.length ? new Set(pendingRows) : NO_PENDING }
              : { ...empty(), key, pendingTargets: pendingRows.length ? new Set(pendingRows) : NO_PENDING });
            return;
          }
          clearDeadline();
          setState({ key, data: snap.docs.map(doc => doc.data()), loading: false, error: false, confirmed: true, pendingTargets: NO_PENDING });
        },
        error => {
          if (!current()) return;
          console.error('[blocks] own-blocks listener failed', error);
          fail(!readinessRetryable(error));
        },
      );
      if (!active) { unsubscribe(); unsubscribe = null; }
    }
    return () => { retire(); if (retireCurrent.current === retire) retireCurrent.current = null; };
  }, [key, uid, eventId, online, session.db, session.generation, session.uid, session.recoveryRequired, session.failed, retryEpisode]);
  const { key: _stateKey, ...answer } = state;
  if (uid !== null && session.failed && !session.recoveryRequired && online) {
    return { ...empty(), loading: false, error: true, retry: retryPrivateFirestoreSession };
  }
  if (state.key !== key || !online || session.uid !== uid || !session.db || session.recoveryRequired) {
    if (state.key === key && state.error && online && !session.recoveryRequired) {
      return { ...answer, retry: retryPrivateFirestoreSession };
    }
    return empty();
  }
  return {
    ...answer,
    ...(state.error ? { retry: retryRead } : {}),
    pendingTargets: pending.size > 0 ? computeHiddenSet(pending, state.pendingTargets, true) : state.pendingTargets,
  };
}
