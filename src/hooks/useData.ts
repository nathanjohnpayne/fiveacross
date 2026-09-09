import { useEffect, useMemo, useRef, useState } from 'react';
import { collectionGroup, onSnapshot, query, where, type DocumentReference, type Query } from 'firebase/firestore';
import { db, EVENT_ID } from '../firebase';
import { eventRef, itemsCol, boardRef, dayBoardRef, dayMetaRef, playerRef, playersCol, proofsCol, claimsCol, userRef, tallyMarkersCol, momentsCol, noticesCol, doubtsCol, heartsCol } from '../data/paths';
import { isReportHidden, isBanned, isExplicitWithheld, isSystemAuthor } from '../data/moderation';
import { useAdultContent } from './useAdultContent';
import { beginDayBoardSeedWatch, recordDayBoardSeedSnapshot } from '../data/board-freshness';
import { eventScopeKey } from '../data/eventScope';
import { recordArchiveConfirmation, type SnapshotOrigin } from '../data/archiveConfirmation';
import { usableDayIndexes } from '../data/eventArchive';
import { supportedDayIndex } from '../data/eventLimits';
import { sortPlayers, withReadableRanking, dayDealState, type DayDealState, nextDisplayBumpTime, BUMP_DEBOUNCE_MS } from '../game/logic';
import type { EventDoc, ItemDoc, BoardDoc, DayDef, DayMetaDoc, PlayerDoc, ProofDoc, ClaimDoc, UserDoc, TallyEntry, TallyCard, MomentDoc, NoticeDoc, DoubtDoc, HeartDoc } from '../types';

// Both subs subscribe with includeMetadataChanges so the cache→server
// transition is always observable: with the ADR 0006 persistent cache, a cold
// or stale IndexedDB can deliver a first snapshot `fromCache` (e.g. an empty
// pool / missing board that the server would contradict), and WITHOUT metadata
// events Firestore never re-notifies when the server confirms byte-identical
// data — `hasServerData` would deadlock. The latch below turns true on the
// first server-backed snapshot and stays true for the life of the key, so
// consumers (Board's thin-pool guard) can tell "the server really says this"
// from "the local cache says this so far". Errors leave it false — failing
// toward the neutral loading state, never toward a false alert.
type DocSubscriptionState<T> = {
  key: string;
  data: T | null;
  loading: boolean;
  hasServerData: boolean;
  /**
   * "The server has answered for this key — or never can." `hasServerData` plus
   * the ERROR case, latched — the same pair `useDayMetasStatus` draws between
   * `loaded` and `serverLoaded`: an errored Day resolves that hook's `loaded` and
   * is deliberately kept OUT of its stricter `serverLoaded` (Codex P2 on PR
   * #1162), and `serverResolved`/`hasServerData` split the same way here
   * (#1152, Codex P2 on PR #1139 round 5).
   *
   * A caller that must not act on a cache replay needs "the server has spoken"
   * as a GATE, and the Leaderboard's routing half is that caller: it mounts a
   * listener fan the archived view promises never to open, so a cached `active`
   * replay of an Event the server is about to report as archived would open all
   * of it and tear it down a snapshot later. But a gate an ERRORED subscription
   * can never open is a surface stuck on a spinner forever — and an error is
   * terminal for an `onSnapshot` listener, so no server answer is ever coming.
   * It therefore RESOLVES the wait rather than prolonging it, and the caller
   * falls back to whatever it would have rendered before this latch existed.
   *
   * The distinction from `hasServerData` is the point: a consumer that reads the
   * DATA still learns, from that flag, that nothing was ever confirmed.
   */
  serverResolved: boolean;
  fromCache: boolean;
  hasPendingWrites: boolean;
};

const emptyDocState = <T,>(key: string, loading: boolean): DocSubscriptionState<T> => ({
  key,
  data: null,
  loading,
  hasServerData: false,
  serverResolved: false,
  fromCache: true,
  hasPendingWrites: false,
});

function useDocSub<T>(
  ref: DocumentReference<T> | null,
  key: string,
  /**
   * A side effect to run on every snapshot this subscription delivers, given the
   * document and that snapshot's own origin flags — the seam `useEventDoc` uses
   * to record a server-committed archive on whatever route observes it first
   * (Codex P2 on PR #1165, `../data/archiveConfirmation`).
   *
   * It runs inside the `onSnapshot` callback rather than in a render or an
   * effect, so the observation does not depend on the holding component
   * re-rendering or staying mounted — a route that subscribes to the Event and
   * shows nothing about it still records what it saw.
   *
   * MUST be a module-scope constant. The subscription effect below is keyed on
   * `key` alone (deliberately, see its own dependency note), so a callback whose
   * identity changed per render would be captured stale; every caller passes a
   * function defined once at module load.
   */
  observe?: (data: T | null, origin: SnapshotOrigin) => void,
) {
  const [state, setState] = useState<DocSubscriptionState<T>>(() => emptyDocState(key, ref !== null));
  // The per-snapshot halves of the same `{ includeMetadataChanges: true }`
  // discipline `useColSub` below already exposes, and for the same reason:
  // `hasServerData` is a LATCH ("the server has spoken at least once for this
  // key"), which cannot answer "is THIS snapshot server-committed?".
  // `fromCache` is cache-vs-server; `hasPendingWrites` is
  // local-optimistic-vs-server-acked. A snapshot is fully SERVER-COMMITTED only
  // when BOTH are false. Board's #377 retraction drain needs exactly that: a
  // retraction is PERMANENT, and `setMark` is fire-and-forget (its verdict is a
  // local fold, its batch still pending), so a rejected unmark — e.g. a
  // pre-#458 cells-array straggler whose per-cell patch the canonical-map gate
  // denies — is rolled back by the server while the local snapshot briefly
  // showed the win gone. Acting on that would irreversibly silence a STANDING
  // win. Waiting for both flags to clear means the rollback snapshot (win
  // standing) is what the drain sees.
  useEffect(() => {
    let active = true;
    // Drop the previous ref's document so stale data from another subscription
    // (e.g. a different signed-in uid) can't render under the new key.
    setState(emptyDocState(key, ref !== null));
    if (!ref) {
      return () => {
        active = false;
      };
    }
    const unsub = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        if (!active) return;
        const data = snap.exists() ? (snap.data() as T) : null;
        // Fail-open, on the same principle the persisted-state helpers it calls
        // already use: an observer is a passenger on this subscription, and a
        // throw from one must never stop the snapshot from reaching `setState`
        // — that would strand every consumer of this document on stale data.
        try {
          observe?.(data, snap.metadata);
        } catch {
          /* an observation is never worth the subscription */
        }
        setState((previous) => {
          const served =
            previous.key === key && previous.hasServerData ? true : !snap.metadata.fromCache;
          return {
            key,
            data,
            loading: false,
            hasServerData: served,
            serverResolved: served || (previous.key === key && previous.serverResolved),
            fromCache: snap.metadata.fromCache,
            hasPendingWrites: snap.metadata.hasPendingWrites,
          };
        });
      },
      () => {
        if (!active) return;
        setState((previous) =>
          previous.key === key
            ? { ...previous, loading: false, serverResolved: true }
            : { ...emptyDocState<T>(key, false), serverResolved: true },
        );
      },
    );
    return () => {
      active = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // Effects run after render. Tagging state with its effective key prevents the
  // first render for Event B from exposing Event A while React is still waiting
  // to run A's cleanup and B's subscription effect.
  return state.key === key
    ? state
    : emptyDocState<T>(key, ref !== null);
}

type CollectionSubscriptionState<T> = {
  key: string;
  data: T[];
  loading: boolean;
  hasServerData: boolean;
  fromCache: boolean;
  hasPendingWrites: boolean;
};

const emptyCollectionState = <T,>(key: string, loading: boolean): CollectionSubscriptionState<T> => ({
  key,
  data: [],
  loading,
  hasServerData: false,
  fromCache: true,
  hasPendingWrites: false,
});

function useColSub<T>(q: Query<T> | null, key: string) {
  const [state, setState] = useState<CollectionSubscriptionState<T>>(() =>
    emptyCollectionState(key, q !== null),
  );
  // `fromCache` is the LATEST snapshot's origin (per-snapshot, unlike the
  // `hasServerData` latch): true when the rows came from the persistent IndexedDB
  // cache, false when server-backed. Consumers that must distinguish an in-session
  // server-backed observation from a stale cache replay (e.g. `useMyClaims` seeding
  // the confirm-path freshness witness, #41 / Codex #116 R2 finding 2) read this.
  // `hasPendingWrites` is the LATEST snapshot's OPTIMISTIC-write flag (per-snapshot):
  // true when the snapshot reflects a LOCAL write this client issued that the server
  // has NOT yet acked. It is the OTHER half of the `{ includeMetadataChanges: true }`
  // discipline — `fromCache` is cache-vs-server, `hasPendingWrites` is
  // local-optimistic-vs-server-committed. A snapshot is fully SERVER-COMMITTED only
  // when both are false. The pool-recovery watcher (#70, Codex P2 on PR #124 round 2)
  // needs this: a local optimistic prompt-add arrives with `fromCache === false` AND
  // `hasPendingWrites === true`, so a `fromCache`-only gate would treat that
  // not-yet-committed local echo as a server crossing and fire before the write acks.
  useEffect(() => {
    let active = true;
    // Drop the previous query's rows when the key changes so stale results can't
    // render against the new subscription.
    setState(emptyCollectionState(key, q !== null));
    if (!q) {
      return () => {
        active = false;
      };
    }
    const unsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        if (!active) return;
        setState((previous) => ({
          key,
          data: snap.docs.map((d) => d.data() as T),
          loading: false,
          hasServerData: previous.key === key && previous.hasServerData
            ? true
            : !snap.metadata.fromCache,
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
        }));
      },
      () => {
        if (!active) return;
        setState((previous) =>
          previous.key === key ? { ...previous, loading: false } : emptyCollectionState(key, false),
        );
      },
    );
    return () => {
      active = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key
    ? state
    : emptyCollectionState<T>(key, q !== null);
}

const eventSubscriptionKey = (...parts: readonly (string | number)[]): string =>
  eventScopeKey(EVENT_ID, ...parts);

/**
 * The Event's archive observer, module-scope so `useDocSub` can capture it once
 * (Codex P2 on PR #1165). `EVENT_ID` is read at CALL time, not at module load,
 * so a build whose Event id resolves later still records under the right one.
 */
const observeEventArchive = (event: EventDoc | null, origin: SnapshotOrigin): void =>
  recordArchiveConfirmation(EVENT_ID, event, origin);

export function useEventDoc(enabled = true) {
  // `enabled` lets a pre-auth caller (main.tsx) skip the subscription: events
  // require sign-in, so subscribing while signed out only yields a
  // permission-denied error. Toggle the key (not just the ref) so the effect
  // re-runs and subscribes once auth arrives — useDocSub is keyed on `key`.
  //
  // This is the SHARED Event subscription — every route mounts it, and the
  // Admin console is routinely the first surface to receive a committed archive
  // — so it is where the device's archive confirmation is recorded (Codex P2 on
  // PR #1165). The Leaderboard's routing half only READS that record; leaving
  // the write on the one surface that reads it meant the case it exists for —
  // an archive first seen on another route, with a moderation write queued
  // behind it — had nothing persisted when the Leaderboard finally mounted.
  return useDocSub<EventDoc>(
    enabled ? eventRef() : null,
    eventSubscriptionKey(enabled ? 'event' : 'event:disabled'),
    observeEventArchive,
  );
}

// The ADR 0004 Phase 0 community auto-hide predicate lives in the Firestore-free,
// React-free ./moderation module (imported above) so the deal path (src/data/api.ts's
// joinAndDeal) can apply the EXACT same "is this community-hidden" test as these
// read hooks without importing React (Codex P2, PR #107 finding 1). Re-exported here
// so the existing importers (Admin.tsx, the hooks suite) keep importing it from
// useData. The predicate treats only a POSITIVE threshold as active (0 / negative /
// NaN / undefined → no filtering) — see ./moderation for the fail-open-unless-positive
// rationale (Codex P2, PR #107 finding 2).
export { isReportHidden };

// The ADR 0004 Phase 0 presentational ban predicate (#108) is also owned by the
// Firestore-free, React-free ./moderation module and re-exported here for the SAME
// reason as isReportHidden — the deal path (src/data/api.ts) applies it without
// importing React, and the console (Admin.tsx) + Leaderboard import it from here.
// `isSystemAuthor` (Codex P1, PR #122) rides along so the console can hide the Ban
// control for a system/sentinel author ('seed') that must never be banned.
export { isBanned, isSystemAuthor };

/**
 * The Event's shared moderation config, read ONCE from `useEventDoc()` so every
 * client computes the SAME presentational hides with no Admin online (ADR 0004
 * Phase 0):
 *
 *  - `threshold` — the community auto-hide `settings.reportHideThreshold` (seeded 4,
 *    `scripts/seed.mjs`), `undefined` while the event doc loads or the setting is
 *    unset so callers treat it as "no filtering" (see `isReportHidden`).
 *  - `bannedUids` — the Admin ban roster (#113 contract, #108 consumer), `[]` while
 *    loading or absent (the `eventConverter` defaults a missing field to `[]`) so
 *    `isBanned` filters nothing until a real roster arrives.
 *
 * Both are reads of SHARED config, not per-client knobs — the hides are bypassable
 * by design (a client can patch its bundle to ignore them); tamper-proof server
 * enforcement is deferred to #43/#44. Combined into one hook so a consumer that
 * needs both opens a SINGLE event-doc subscription rather than two.
 *
 * `enabled` mirrors `useEventDoc`'s gate: an id-scoped consumer (useTally /
 * useDoubts) passes `false` when its own id is null so it opens NO subscription at
 * all — preserving those hooks' "pass null to open no subscription" contract. When
 * disabled the config reads as unset (threshold `undefined`, bannedUids `[]`), which
 * both filters fail open on anyway.
 */
function useEventModeration(enabled = true): { threshold: number | undefined; bannedUids: string[] } {
  const { data: event } = useEventDoc(enabled);
  const threshold = event?.settings?.reportHideThreshold;
  return {
    threshold: typeof threshold === 'number' ? threshold : undefined,
    bannedUids: event?.bannedUids ?? [],
  };
}

export function useItems(enabled = true) {
  // `enabled` lets Board skip this subscription once a Board is frozen (Codex
  // P3 on PR #66): the pool only matters pre-deal, so a Player who already has
  // a Board has no use for a live listener that fans every other Player's
  // prompt add/report out as a full-pool read + rerender. Toggle the key (not
  // just the query) so the effect re-subscribes if `enabled` flips back to
  // true — mirrors useEventDoc's pre-auth gate above.
  const { threshold, bannedUids } = useEventModeration();
  const adultRequired = useAdultContent();
  // Scoped `where('status','==','active')` so every matched doc satisfies the item
  // read rule (#43 F4): non-admins may read only active Prompts, so an unconstrained
  // collection listen would now be DENIED — the SAME pattern the proof feed uses
  // (useProofFeed). A single-field equality — no composite index. `useAllItems`
  // (Admin) stays unconstrained and reads all statuses via the isAdmin arm.
  const { data, loading, hasServerData, fromCache, hasPendingWrites } = useColSub<ItemDoc>(
    enabled ? query(itemsCol(), where('status', '==', 'active')) : null,
    eventSubscriptionKey(enabled ? 'items' : 'items:disabled'),
  );
  // Two further presentational hides drop a Prompt from the live pool on top of the
  // now server-authoritative `status` gate (#43): the ADR 0004 community auto-hide
  // once `reportCount` reaches `reportHideThreshold` (the Phase-0 fallback that runs
  // before the Cloud Function catches up), and the Admin ban (#108) — a Prompt
  // authored by a banned uid (`createdBy` on `bannedUids`) is hidden by its OWNER,
  // mirroring `isReportHidden`. `useAllItems` (Admin) applies NEITHER, so an Admin
  // can still reach and restore/unban a threshold-hidden or banned Prompt. The
  // `status === 'active'` re-check is redundant with the query but harmless (guards
  // a stale cache row). Presentational only — the doc is untouched.
  // The third presentational hide (Phase 4b round 4): an explicit Prompt is
  // withheld while this session has not raised the 18+ gate, which closes the
  // window between an admin's approval write and the Cloud Function that
  // publishes the posture. See `isExplicitWithheld`.
  const items = data
    .filter(
      (i) =>
        i.status === 'active' &&
        (i.pool ?? 'main') === 'main' &&
        !isReportHidden(i.reportCount, threshold) &&
        !isExplicitWithheld(i.spicy, adultRequired) &&
        !isBanned(i.createdBy, bannedUids),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  // `hasServerData` is the LIFETIME latch (has a server snapshot EVER arrived);
  // `fromCache` and `hasPendingWrites` are THIS snapshot's per-snapshot metadata. The
  // pool-recovery watcher (#70) needs the per-snapshot flags, not the latch: once
  // latched, a later cache/local replay would otherwise read as a server-confirmed
  // pool crossing (Codex P2 on PR #124 round 1), so the edge detector gates on
  // `!fromCache && !hasPendingWrites` — fully server-committed, no local optimistic
  // prompt-add echo (Codex P2 round 2). Other `useItems` consumers ignore both.
  return { items, loading, hasServerData, fromCache, hasPendingWrites };
}

export function useBoard(uid: string | undefined) {
  return useDocSub<BoardDoc>(
    uid ? boardRef(uid) : null,
    eventSubscriptionKey('board', uid ?? 'none'),
  );
}

/**
 * A Player's Day Card for one Day: the day-scoped Board subscription at
 * events/{EVENT_ID}/days/{dayIndex}/boards/{uid} (daily-cards-spec § "Data
 * model"). Pass `undefined` for either arg to open no subscription (e.g. before
 * the viewer or the viewed Day is known). Named `useDayBoard` so the pre-1.5
 * `useBoard(uid)` keeps its single-Board callers unchanged while day-aware
 * surfaces move onto this one.
 */
export function useDayBoard(uid: string | undefined, dayIndex: number | undefined) {
  const enabled = uid !== undefined && dayIndex !== undefined;
  return useDocSub<BoardDoc>(
    enabled ? dayBoardRef(dayIndex, uid) : null,
    eventSubscriptionKey('dayboard', uid ?? 'none', dayIndex ?? 'none'),
  );
}

/**
 * ONE Day's meta doc — the write-once per-Day First to BINGO honor (#264,
 * daily-cards-spec § "Scoring and social surfaces"). `undefined` dayIndex (a
 * legacy event, or no Day viewed) opens no subscription. The returned doc is
 * tagged with the Day it was FETCHED FOR and returned only while that matches
 * the CURRENT request, so a day switch can never paint the prior Day's honor
 * under the new Day for a frame (Codex P3 on #280 — useDocSub clears state in
 * an effect, one paint too late for this).
 */
export function useDayMeta(dayIndex: number | undefined): { data: DayMetaDoc | null } {
  const { data } = useDocSub<DayMetaDoc>(
    dayIndex === undefined ? null : dayMetaRef(dayIndex),
    eventSubscriptionKey('day-meta', dayIndex ?? 'none'),
  );
  return { data };
}

/**
 * EVERY Day's meta doc, as a `Map<dayIndex, DayMetaDoc>` (#264 — the
 * Leaderboard honors strip reads the PINNED honors, with the roster-derived
 * `perDayHonors` as its fallback). Same bounded one-effect fan as
 * `useMyDayBoards` below, and it takes the same argument: the schedule's own
 * `days.map(d => d.index)`, not its length (Codex P2 on PR #1162).
 */
export function useDayMetas(dayIndexes: readonly number[]): ReadonlyMap<number, DayMetaDoc> {
  return useDayMetasStatus(dayIndexes).metas;
}

/**
 * The Day indexes a honour fan may address, from a caller's raw
 * `days.map(d => d.index)` (#1151, Codex P2 on PR #1162).
 *
 * Two normalisations, both of which the old `dayCount` argument got for free by
 * construction and neither of which survives taking real indexes:
 *
 *  - **Indexes that name no Day are dropped.** `EventDoc.days` is admin-written
 *    with no per-entry validation in its rules arm, and `eventConverter`
 *    tolerates an entry it cannot read (`migrateDayFields` treats a nullish one
 *    as `{}`), so an index can be `undefined` or fractional. `dayMetaRef` would
 *    then address `days/undefined/meta/undefined` — a document that is not
 *    there, delivered as a perfectly ordinary "no pin here". `-1`, `10` and an
 *    unsafe large integer are dropped by the same clause and for a sharper
 *    reason (Codex P2 on PR #1162, round 7): each is a REAL path this fan would
 *    otherwise subscribe to, on a Day the `DayDef` contract does not have, so
 *    the question is the shared `supportedDayIndex` rather than
 *    `Number.isInteger`.
 *  - **Duplicates are collapsed.** The completion tests below count DISTINCT
 *    Days answered against the list's length, so a schedule naming one index
 *    twice could never reach `seen.size >= length` and the archive control would
 *    sit disabled behind a message that never resolves.
 *
 * NORMALISING IS NOT THE SAME AS ACCEPTING (#1151, Codex P2 on PR #1162). Both
 * shapes above are ones `archiveEvent` REFUSES as `schedule-unusable` — a
 * non-integer index it cannot address, a repeated one it would freeze twice —
 * and normalising them away silently is exactly what let the console arm over a
 * schedule the freeze was going to turn down: the fan completed, every latch
 * went true, the Admin closed play, and the flip refused and reopened it. So the
 * normalisation stays (the fan still has to address SOMETHING, and a list it
 * cannot complete would hang every gate on this hook) and the fact that it was
 * needed is REPORTED beside it, through `useDayMetasStatus`' `scheduleUnusable`.
 * The question itself is the freeze's own `usableDayIndexes`, asked rather than
 * restated, so the two halves cannot drift.
 *
 * Order is preserved, because the fan's own key is the list's content and a
 * stable order keeps that key stable across renders.
 */
function canonicalDayIndexes(dayIndexes: readonly number[]): number[] {
  return Array.from(new Set(dayIndexes.filter(supportedDayIndex)));
}

/**
 * `loaded` vs `serverLoaded` vs `serverConfirmed` vs `failed`. `loaded` means
 * every Day's subscription has RESOLVED — delivered a snapshot, or died — which
 * is what the honours strip wants (it paints the pins it has and repaints when
 * better ones land). `serverLoaded` is the stricter LATCH: every Day has been
 * answered by the SERVER at least once. A surface that PERSISTS what it read
 * needs a strict one, because a cache-only "no pin here" is indistinguishable
 * from "the server says there is no pin" and freezing the wrong one is permanent
 * (#1151, Codex P1: `ArchiveEvent`'s preview is what an Admin decides to freeze
 * from).
 *
 * AND A LATCH IS NOT ENOUGH FOR THAT SURFACE (Codex P2 on PR #1162).
 * `serverLoaded` says the server HAS spoken; it cannot say the honours on screen
 * right now are what the server said. It never clears, so a console that
 * confirmed every Day and then went offline keeps reporting `true` while the fan
 * re-delivers each Day from the ADR 0006 persistent cache — and the archive
 * would arm over exactly the cached preview the latch exists to refuse. A local
 * write pending on a Day meta is the same hole from the other side: emitted
 * server-backed but undecided, and rolled back if it is refused.
 *
 * `serverConfirmed` is therefore the per-render test, not a latch: every Day's
 * LATEST snapshot is fully server-committed (`!fromCache && !hasPendingWrites`),
 * exactly the three-flag test `src/App.tsx` applies before it moves a Player off
 * their Card and `Admin.tsx` applies to the Event document. It can go false
 * again, which is the point. It implies `serverLoaded` by construction — a
 * server-committed snapshot is a server snapshot — so the archive gate needs
 * only this one, while the latch stays for the "seen once" question other
 * surfaces ask.
 *
 * The fan subscribes with `{ includeMetadataChanges: true }` for the same reason
 * `useDocSub`/`useColSub` do: without metadata events Firestore never re-notifies
 * when the server confirms data the cache already held byte-for-byte, so a
 * `!fromCache` latch would deadlock on exactly the docs that were cached. These
 * are write-once per-Day honour docs, so the extra notifications are a handful
 * per session, not a stream.
 *
 * AN ERRORED SUBSCRIPTION (permission-denied, signed out mid-flight) RESOLVES
 * THE DAY, AND CONFIRMS NOTHING (Codex P2 on PR #1162). It used to satisfy
 * `serverLoaded` as well, which made the strict latch a lie in exactly the case
 * it exists for: the listener died before any server snapshot, so the honour was
 * never confirmed, yet the archive gate read the Day as confirmed and armed —
 * over a preview that fell back to a DERIVED honour, or to none, while
 * `archiveEvent`'s later `getDocFromServer` could recover and freeze the PINNED
 * one. A different record from the one the Admin approved, permanently.
 *
 * It resolves `loaded` because it is terminal: the live honours strip must not
 * hang on a Day whose listener is dead, and it renders the same derived fallback
 * it always did. It stays out of `serverSeen` because a dead listener has
 * confirmed nothing. And it is reported on `failed`, because a latch that can
 * now never complete has to say WHY — otherwise the archive control sits
 * disabled behind a "loading" message that will never resolve, which is the
 * deadlock the old behaviour was avoiding by the wrong means.
 *
 * `failed` is NOT the complement of either confirmation, and its consumers have
 * to treat it as such (CodeRabbit, PR #1162). A Day the server answered before
 * its listener died is already latched and still current, so `failed` can be
 * true beside a true `serverLoaded` AND a true `serverConfirmed` — which is why
 * the archive console reports unreadable honours only when the confirmation is
 * actually missing, rather than showing a terminal message beside an armed
 * control.
 *
 * IT TAKES THE SCHEDULE'S OWN `DayDef.index` VALUES, NOT ITS LENGTH (Codex P2 on
 * PR #1162). It used to take a count and subscribe to `days/0 … days/n-1`, which
 * is the same fan only while the schedule is contiguous from zero — a property
 * `EventDraft` validation enforces at AUTHORING time (`dayCompletenessIssues`
 * requires `days[position].index === position`) and nothing enforces on a stored
 * Event: `EventDoc.days` is admin-written with no per-entry rules validation,
 * legacy and seeded Events were never put through the wizard, and every
 * day-scoped path in the estate keys on `DayDef.index` rather than on array
 * position (the #447 Phase 4b precedent, which `useMyDayBoards` below already
 * follows).
 *
 * On a schedule the two disagree about, the divergence was silent and permanent.
 * A one-Day schedule at `index: 4` had this fan confirm `days/0/meta/0` — a
 * document that does not exist, which the server answers as an ordinary "no pin
 * here" — so every gate passed, the console previewed the roster-DERIVED honour
 * (or none), and the Admin armed and archived. `archiveEvent` then re-read
 * `days/4/meta/4`, found the real pin, and froze a DIFFERENT honour from the one
 * on the screen the Admin approved. Irreversibly, because the record is
 * write-once.
 *
 * The fan therefore subscribes to exactly the indexes it is given, and `loaded`,
 * `serverLoaded`, `serverConfirmed` and `failed` all key on those same indexes.
 * `canonicalDayIndexes` is what the list is normalised through first.
 */
export function useDayMetasStatus(dayIndexes: readonly number[]): {
  metas: ReadonlyMap<number, DayMetaDoc>;
  loaded: boolean;
  serverLoaded: boolean;
  /** Every Day's LATEST snapshot is fully server-committed — not a latch, so it
   *  falls false again when the fan re-delivers a Day from the persistent cache
   *  or a local write is pending on one (Codex P2 on PR #1162). */
  serverConfirmed: boolean;
  /** At least one Day's subscription DIED (terminal `onSnapshot` error). It does
   *  NOT imply either confirmation is false: a Day answered by the server before
   *  its listener died stays latched and stays current. What it means is that a
   *  Day still MISSING one can never acquire it for this key. */
  failed: boolean;
  /** The SUPPLIED list is one `archiveEvent` would refuse as `schedule-unusable`
   *  — an index that is not an integer, or the same Day named twice (Codex P2 on
   *  PR #1162). The fan still runs, over the normalised list; this is what stops
   *  a surface that PERSISTS what it read from arming over a schedule the freeze
   *  is going to turn down after it has already shut the Event. */
  scheduleUnusable: boolean;
} {
  const eventId = EVENT_ID;
  // The DAYS this fan addresses, normalised (see `canonicalDayIndexes`). Derived
  // per render because callers rebuild `days.map(d => d.index)` every render;
  // the effect keys on its CONTENT, exactly as `useMyDayBoards` does.
  const indexes = canonicalDayIndexes(dayIndexes);
  // …and whether normalising it was NECESSARY, which is a different fact and the
  // one the archive gate needs. Asked through the freeze's own predicate so the
  // console and `archiveEvent` cannot disagree about which schedules are usable.
  const scheduleUnusable = !usableDayIndexes(dayIndexes);
  const dayCount = indexes.length;
  const key = eventScopeKey(eventId, 'day-metas', indexes.join(','));
  type State = {
    key: string;
    metas: ReadonlyMap<number, DayMetaDoc>;
    seen: ReadonlySet<number>;
    serverSeen: ReadonlySet<number>;
    /** Days whose LATEST snapshot was fully server-committed. Unlike `serverSeen`
     *  this is not a latch: a Day leaves it again the moment the fan re-delivers
     *  it from the persistent cache, or with a local write pending (Codex P2 on
     *  PR #1162). */
    serverCurrent: ReadonlySet<number>;
    /** Days whose subscription DIED. NOT disjoint from `serverSeen` or
     *  `serverCurrent` (CodeRabbit, PR #1162): a Day the server answered before
     *  its listener died is in both, and nothing here removes it — the error
     *  callback only records the failure. What the set means is that any Day
     *  still absent from those two can never join them for this key. */
    errored: ReadonlySet<number>;
  };
  const empty = (): State => ({
    key,
    metas: new Map(),
    seen: new Set(),
    serverSeen: new Set(),
    serverCurrent: new Set(),
    errored: new Set(),
  });
  const [state, setState] = useState<State>(empty);
  useEffect(() => {
    let active = true;
    setState(empty());
    if (dayCount <= 0) {
      return () => {
        active = false;
      };
    }
    const unsubs = indexes.map((dayIndex) =>
      onSnapshot(
        dayMetaRef(dayIndex, eventId),
        { includeMetadataChanges: true },
        (snap) => {
          if (!active) return;
          setState((previous) => {
            const current = previous.key === key ? previous : empty();
            const metas = new Map(current.metas);
            if (snap.exists()) metas.set(dayIndex, snap.data() as DayMetaDoc);
            else metas.delete(dayIndex);
            const seen = new Set(current.seen);
            seen.add(dayIndex);
            // A LATCH, like `hasServerData`: once the server has spoken for this
            // Day it has spoken, whatever a later cache-sourced snapshot says.
            const serverSeen = new Set(current.serverSeen);
            if (!snap.metadata.fromCache) serverSeen.add(dayIndex);
            // …and the CURRENT answer beside it, which is not a latch: this
            // snapshot is server-committed, or this Day is no longer confirmed
            // (Codex P2 on PR #1162). `hasPendingWrites` joins `fromCache` for
            // the reason it does everywhere else — an optimistic local write is
            // emitted server-backed but undecided, and rolls back if refused.
            const serverCurrent = new Set(current.serverCurrent);
            if (!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) {
              serverCurrent.add(dayIndex);
            } else {
              serverCurrent.delete(dayIndex);
            }
            return { ...current, key, metas, seen, serverSeen, serverCurrent };
          });
        },
        () => {
          if (!active) return;
          /* permission-denied (signed out mid-flight) — leave the day absent.
             RESOLVED for `loaded`, because the listener is dead and the live
             strip must not hang on it; NOT server-seen and NOT server-current,
             because a dead listener confirmed nothing; and RECORDED as a
             failure, so a caller that needs a strict answer can say why it will
             never arrive (Codex P2 on PR #1162). A Day already in either set
             is deliberately left there — the server did answer it, and this
             callback removes nothing. */
          setState((previous) => {
            const current = previous.key === key ? previous : empty();
            const seen = new Set(current.seen);
            seen.add(dayIndex);
            const errored = new Set(current.errored);
            errored.add(dayIndex);
            return { ...current, seen, errored };
          });
        },
      ),
    );
    return () => {
      active = false;
      unsubs.forEach((u) => u());
    };
    // `key` carries both Event identity and the CONTENT of the index list, so a
    // schedule whose Days move re-keys the fan and a caller that merely rebuilt
    // the same array does not (Codex P2 on PR #1162).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = state.key === key ? state : empty();
  // Every completion test counts the DISTINCT Days this fan actually addressed,
  // which is what makes them true of `days/4` on a schedule that has no `days/0`.
  return {
    metas: current.metas,
    loaded: dayCount <= 0 || current.seen.size >= dayCount,
    serverLoaded: dayCount <= 0 || current.serverSeen.size >= dayCount,
    serverConfirmed: dayCount <= 0 || current.serverCurrent.size >= dayCount,
    failed: current.errored.size > 0,
    scheduleUnusable,
  };
}

/**
 * ALL of a Player's dealt Day Cards, as a `Map<dayIndex, BoardDoc>` (#261 —
 * the Feed's Tally Card button gating needs the viewer's marked/unmarked
 * Prompt sets across every unlocked Day Card, and a Board doc exists exactly
 * for the dealt/unlocked Days). One effect owns the whole fan of per-day doc
 * subscriptions — `dayIndexes` is the Event's CANONICAL `days.map(d =>
 * d.index)` (bounded, ten on this sailing; canonical DayDef.index values, NOT
 * array positions — day-board paths key on d.index everywhere, the #447
 * Phase 4b precedent), so the fan is fixed-size per Event and re-keys only
 * when the schedule or the viewer changes. Days without a Board simply never
 * enter the map.
 *
 * This fan is also the feeder for the Echo seed-freshness registry (#474,
 * src/data/board-freshness.ts): each per-day subscription registers a watch
 * and reports every snapshot, so the mark-time Echo pass only stamps a
 * sibling's cached `seed` as `markSeed` once a live, fully server-committed
 * snapshot has confirmed it. `includeMetadataChanges: true` is load-bearing
 * for that (same rationale as useDocSub above): without metadata events,
 * Firestore never re-notifies when the server confirms byte-identical cached
 * data, and the registry would stay untrusted — silently skipping every echo
 * — despite a healthy listener. A listener that dies (the terminal error
 * callback) releases its watch immediately (Codex P2 on #482): a dead
 * listener can't observe a remote reshuffle, so its latched seed must stop
 * being trusted without waiting for the effect cleanup.
 */
export function useMyDayBoards(
  uid: string | undefined,
  dayIndexes: readonly number[],
): ReadonlyMap<number, BoardDoc> {
  // Effect-key the CONTENT of the index list, not the array identity —
  // callers rebuild the array every render.
  const fanKey = dayIndexes.join(',');
  const eventId = EVENT_ID;
  const key = eventScopeKey(eventId, 'my-day-boards', uid ?? 'none', fanKey);
  const [state, setState] = useState<{
    key: string;
    boards: ReadonlyMap<number, BoardDoc>;
  }>(() => ({ key, boards: new Map() }));
  useEffect(() => {
    let active = true;
    setState({ key, boards: new Map() });
    if (!uid || dayIndexes.length === 0) {
      return () => {
        active = false;
      };
    }
    const unsubs = dayIndexes.map((dayIndex) => {
      const releaseWatch = beginDayBoardSeedWatch(eventId, dayIndex, uid);
      const unsub = onSnapshot(
        dayBoardRef(dayIndex, uid, eventId),
        { includeMetadataChanges: true },
        (snap) => {
          if (!active) return;
          recordDayBoardSeedSnapshot(eventId, dayIndex, uid, snap);
          setState((previous) => {
            const boards = new Map(previous.key === key ? previous.boards : []);
            if (snap.exists()) boards.set(dayIndex, snap.data() as BoardDoc);
            else boards.delete(dayIndex);
            return { key, boards };
          });
        },
        () => {
          /* permission-denied (signed out mid-flight) — leave the day absent,
             and drop the seed-trust watch NOW: this listener is terminated and
             can no longer observe a remote reshuffle (idempotent with the
             cleanup below). */
          releaseWatch();
        },
      );
      return () => {
        releaseWatch();
        unsub();
      };
    });
    return () => {
      active = false;
      unsubs.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state.boards : new Map();
}

/**
 * The viewed Day's deal state for a Player: subscribes to the day-scoped Board
 * and folds it with the DayDef schedule + the current clock through
 * `dayDealState`, so a surface can distinguish `locked` (render the preview),
 * `waking` (snapshot pending — show the "waking up" wait), `ready` (deal), and
 * `dealt` (a Board exists) from ONE hook. The `board` and its `loading`/
 * `hasServerData` flags are passed through so the caller can render the card
 * once dealt. `state` is `undefined` until the DayDef and a server-backed Board
 * snapshot are both known, so a first cache miss never reads as `ready`.
 */
export function useDayCard(
  uid: string | undefined,
  day: DayDef | undefined,
  now: number = Date.now(),
) {
  const { data: board, loading, hasServerData } = useDayBoard(uid, day?.index);
  const state: DayDealState | undefined =
    day && hasServerData
      ? dayDealState({
          unlockAt: day.unlockAt,
          snapshotItemIds: day.snapshotItemIds,
          now,
          hasBoard: !!board,
        })
      : undefined;
  return { board, loading, hasServerData, state };
}

export function useMyPlayer(uid: string | undefined) {
  return useDocSub<PlayerDoc>(
    uid ? playerRef(uid) : null,
    eventSubscriptionKey('player', uid ?? 'none'),
  );
}

/**
 * A Prompt's public Tally (ADR 0002): the attributed list of Players who have
 * marked `itemId`, plus the derived `count` for the Square's badge. The count is
 * the marker-subcollection size (the aggregate tally/{itemId} doc is admin/Cloud-
 * Function-maintained in Phase 1, not client-written), and the who-list is sorted
 * by `markedAt` so it reads chronologically — earliest marker first. There is no
 * anonymity: every entry names its Player (ADR 0002). Pass `null`/`undefined` (e.g.
 * the free centre Square, which never tallies) to open no subscription.
 */
export function useTally(itemId: string | null | undefined) {
  const { bannedUids } = useEventModeration(!!itemId);
  const { data, loading, hasServerData } = useColSub<TallyEntry>(
    itemId ? tallyMarkersCol(itemId) : null,
    eventSubscriptionKey('tally', itemId ?? 'none'),
  );
  // The Admin ban (#108): a banned marker's entry drops from the PUBLIC who-list
  // AND from the derived `count` the Square badge shows — a banned Player's mark is
  // hidden from other Players, mirroring `isReportHidden` elsewhere. Presentational
  // only; the marker doc is untouched, and admin surfaces do not read this hook.
  const markers = [...data]
    .filter((m) => !isBanned(m.uid, bannedUids))
    .sort((a, b) => a.markedAt - b.markedAt);
  return { markers, count: markers.length, loading, hasServerData };
}

/** The signed-in User's global profile (`users/{uid}`) — display name + avatar. */
export function useMyUser(uid: string | undefined) {
  // Identity is global by contract: users/{uid} carries across Events.
  return useDocSub<UserDoc>(uid ? userRef(uid) : null, `user:${uid ?? 'none'}`);
}

export function useLeaderboard() {
  // `hasServerData` is the roster's server-confirmed latch (see useColSub): Board's
  // First-to-BINGO edge only claims the ceremonial Moment against a server-backed
  // roster, since an initial empty `players` from a still-loading (or cache-only)
  // subscription is not proof nobody has bingoed yet (Codex P2, PR #99). The
  // Leaderboard view ignores it and reads only `players`/`loading`.
  //
  // This roster is deliberately RAW — UNfiltered by the Admin ban (#108). It is the
  // SHARED source of BOTH the Leaderboard VIEW and Board's First-to-BINGO
  // determination, and those two need OPPOSITE treatment of a ban: filtering banned
  // players HERE would let a later Player retroactively become "first to BINGO"
  // after the original first Player is banned — rewriting a factual historical event
  // (a ban never changes who was first to BINGO; that already happened). So the ban
  // is a PRESENTATIONAL filter applied by the Leaderboard COMPONENT for display only
  // (src/components/Leaderboard.tsx, via `isBanned`), while this hook stays raw so
  // Board's ceremony reads the true roster. See specs/w2-ban-console.md § Leaderboard.
  //
  // `fromCache` and `hasPendingWrites` are the CURRENT snapshot's own metadata,
  // passed through beside the latch (Codex P2 on PR #1162). `useColSub` already
  // carries them; this hook used to discard them, which left every consumer with
  // "the server has spoken at least once" and no way to ask whether the rows on
  // screen right now are what it said. The archive gate is the caller that needs
  // the stricter question — it PERSISTS the roster it was shown, permanently —
  // so a confirmed Admin who then goes offline, or who has an optimistic local
  // write in flight, must not arm it over cached or undecided rows. Board and
  // ConfirmWinMoments keep reading the latch alone and are unchanged: their
  // ceremonial First-to-BINGO edge is a claim about a moment that has already
  // happened, not a record it freezes.
  const { data, loading, hasServerData, fromCache, hasPendingWrites } = useColSub<PlayerDoc>(
    playersCol(),
    eventSubscriptionKey('players'),
  );
  // READABLE BEFORE RANKED (#1145, #1142 item 10). `comparePlayers` subtracts two
  // Player-written fields the rules arm validates in no way, so a row carrying
  // (say) `bingoCount: { toString: null }` threw a TypeError out of `sortPlayers`
  // — taking down every consumer of this roster, the Admin console's Game settings
  // and its Reopen play control with them, on an Event that may already be shut.
  //
  // The guard goes HERE, before the sort, rather than inside the comparator — the
  // same mechanism `draftEventArchive` applies through `withReadableDayStats` on
  // the roster it re-reads (#1151, Codex P1 on PR #1162). One pass over the rows
  // about to be ranked keeps the ORDER and the row that is PRINTED reading the
  // same numbers, and the printing is the half no comparator guard reaches:
  // `Leaderboard` renders `{p.bingoCount}` into the DOM, where React throws on an
  // object child. `withReadableRanking` returns a well-formed row by IDENTITY, so
  // this costs one array and changes nothing for the rosters that were always
  // fine; it decides nothing about who won, and the frozen record is unaffected
  // because `toStandingRow` applies the identical coercion on the server re-read.
  return {
    players: sortPlayers(data.map((p) => withReadableRanking(p))),
    loading,
    hasServerData,
    fromCache,
    hasPendingWrites,
  };
}

/** A caller-owned, already-loaded moderation snapshot. Supplying this avoids a
 * second Event subscription and keeps a surface's proof visibility aligned with
 * the Event document that mounted it. */
export interface ProofFeedModeration {
  threshold: number | undefined;
  bannedUids: readonly string[];
}

/**
 * Visible proofs in newest-first order. `max: null` deliberately retains the
 * complete visible set for a frozen award's moderation-aware proof join; it is
 * a local display cap, not a Firestore query limit. A caller that already owns
 * a loaded Event snapshot can pass its moderation fields to avoid a separate
 * Event listener briefly failing open before it receives those fields.
 */
export function useProofFeed(max: number | null = 60, moderation?: ProofFeedModeration) {
  // Two layers hide a Proof from the public Feed. (1) The Admin hard-hide: only
  // 'active' proofs are readable by non-admins (firestore.rules), so a status
  // flip to 'hidden' removes it server-side — the Phase-0 override. (2) The ADR
  // 0004 Phase 0 community auto-hide, added here: a Proof whose `reportCount` has
  // reached the event's `reportHideThreshold` self-hides on EVERY client the
  // moment the counter crosses — a presentational emergency hide that works with
  // no Admin awake and is bypassable by design (tamper-proof server enforcement
  // is #43). The doc is untouched; `useReportedProofs` stays UNfiltered so an
  // Admin can still reach a threshold-hidden Proof to restore or delete it. This
  // one chokepoint also covers the merged Feed's proof side — `useFeed` composes
  // `useProofFeed`, so a Moment (no `reportCount`) is never touched.
  // Always call the hook so React's hook order remains stable. When a caller
  // supplies an authoritative snapshot, disable its listener and use that
  // snapshot verbatim — `undefined` is a meaningful fail-open threshold, not
  // a reason to fall back to a second, initially-unloaded Event read.
  const liveModeration = useEventModeration(moderation === undefined);
  const threshold = moderation === undefined ? liveModeration.threshold : moderation.threshold;
  const bannedUids = moderation === undefined ? liveModeration.bannedUids : moderation.bannedUids;
  const { data, loading } = useColSub<ProofDoc>(
    query(proofsCol(), where('status', '==', 'active')),
    eventSubscriptionKey('proofs'),
  );
  // `bannedUids` is a fresh array every render (`useEventModeration` returns
  // `event?.bannedUids ?? []`), so a plain array dep would defeat this memo on
  // every render regardless of whether the ban roster actually changed. Join it
  // into a stable string key — mirrors `useTallyCards`'s `bannedKey`.
  const bannedKey = bannedUids.join(',');
  // Plus the Admin ban (#108): a Proof authored by a banned uid drops from the
  // public Feed (and, through `useFeed`, the merged stream) by its OWNER — the same
  // presentational hide `useReportedProofs` (Admin) deliberately does NOT apply.
  const proofs = useMemo(
    () => {
      const visible = data
        .filter((p) => !isReportHidden(p.reportCount, threshold) && !isBanned(p.uid, bannedUids))
        .sort((a, b) => b.createdAt - a.createdAt);
      return max === null ? visible : visible.slice(0, max);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, threshold, bannedKey, max],
  );
  return { proofs, loading };
}

/**
 * The Feed's Moments (ADR 0002): the broadcast BINGO / Blackout / First-to-BINGO
 * beats. Subscribes through the SAME `useColSub` latch pattern as the proof
 * stream (`{ includeMetadataChanges: true }`, `hasServerData` latched on the
 * first server-backed snapshot), newest-first, capped to `max` so the Feed stays
 * light on ship wifi. Moments are public-read; unlike proofs there is no status
 * filter — a Moment has no lifecycle, it just happened.
 */
export function useMoments(max = 60) {
  const { bannedUids } = useEventModeration();
  const { data, loading } = useColSub<MomentDoc>(momentsCol(), eventSubscriptionKey('moments'));
  // Same fresh-array problem as `useProofFeed` — join to a stable dep key.
  const bannedKey = bannedUids.join(',');
  // The Admin ban (#108): a banned Player's broadcast beats drop from the public
  // Feed by their `uid`, mirroring the proof side above so the whole merged Feed
  // (`useFeed`) is consistent. Presentational only; admin surfaces do not read this.
  const moments = useMemo(
    () =>
      data
        .filter(hasCanonicalMomentId)
        .filter((m) => !isBanned(m.uid, bannedUids))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, max),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, bannedKey, max],
  );
  return { moments, loading };
}

/**
 * The Event's Notices (specs/admin-messages.md): admin-authored broadcasts, live
 * (includeMetadataChanges via `useColSub`), newest-first. UNCAPPED — the admin
 * sent-history and the Card-tab banner both need the full set; the Feed applies its
 * own cap in `mergeFeed`. No status/ban filter — a Notice is admin-authored, has no
 * lifecycle, and no report counter. Powers the merged Feed (`useFeed` → `mergeFeed`,
 * pinned-first), the Card-tab `NoticeBanner`, and the admin `MessagesPanel` history.
 */
export function useNotices() {
  const { data, loading } = useColSub<NoticeDoc>(noticesCol(), eventSubscriptionKey('notices'));
  const notices = useMemo(() => [...data].sort((a, b) => b.createdAt - a.createdAt), [data]);
  return { notices, loading };
}

/**
 * The rules intentionally allow caller-chosen Moment document ids, so the read
 * side enforces the deterministic ids the writer relies on before anything can
 * render in the public Feed.
 */
export function hasCanonicalMomentId(moment: MomentDoc): boolean {
  // Singleton, event-wide beats: one doc per Event, id === kind. `first_bingo`
  // is the Phase 1 cruise honor; `last_call`/`podium` are the Phase 1.5 finale
  // beats the scheduler (#202/#217) posts — without them here the finale
  // Moments would be dropped before ProofFeed ever renders them.
  if (
    moment.kind === 'first_bingo' ||
    moment.kind === 'last_call' ||
    moment.kind === 'podium'
  ) {
    return moment.id === moment.kind;
  }
  // The two PER-CARD kinds — blackout since #267, bingo since #372 — share one
  // id contract: the day-stamped `${uid}-${kind}-d${dayIndex}` form, valid only
  // when the id's Day MATCHES the doc's own dayIndex (a forged mismatch is
  // dropped), or the legacy day-less `${uid}-${kind}` that single-Board Events
  // and pre-per-card data still carry. Mirrors the create rule's arm exactly, so
  // read and write cannot diverge.
  if (moment.kind === 'bingo' || moment.kind === 'blackout') {
    if (moment.id === `${moment.uid}-${moment.kind}`) return true;
    return (
      typeof moment.dayIndex === 'number' &&
      moment.id === `${moment.uid}-${moment.kind}-d${moment.dayIndex}`
    );
  }
  return false;
}

/**
 * One Feed entry — a Proof, a Moment, a Tally Card (#216), or a Notice
 * (specs/admin-messages.md) — tagged so the renderer (ProofFeed) can branch, with
 * `createdAt` hoisted so the merge sorts one flat stream. A Proof keeps its
 * report/delete affordances; a Moment renders as a celebratory line; a Tally Card
 * renders as a lighter-weight one-line aggregation of bare Marks; a Notice renders
 * as an accent-bordered admin broadcast, pinned ones first (ADR 0002).
 */
export type FeedEntry =
  | { feedKind: 'proof'; createdAt: number; proof: ProofDoc }
  | { feedKind: 'moment'; createdAt: number; moment: MomentDoc }
  | { feedKind: 'tallyCard'; createdAt: number; card: TallyCard }
  | { feedKind: 'notice'; createdAt: number; notice: NoticeDoc };

const PINNED_NOTICE_MASTHEAD_LIMIT = 5;

/**
 * Merge Proofs, Moments, Tally Cards, and Notices into ONE Feed stream (ADR 0002 /
 * #216 / specs/admin-messages.md), capped to `max` — the honest Feed. Pure (no
 * Firestore, no clock) so the interleave/cap is unit-testable and shared as the
 * single source of Feed order. PINNED Notices sort to the very top, newest pinned
 * first, above every Proof/Moment/Tally Card regardless of time, with a capped
 * masthead that cannot evict the whole normal stream; everything else — including
 * UNPINNED Notices — interleaves newest-first below them. A Proof/Moment sorts by
 * its `createdAt`; a Tally Card sorts by its DEBOUNCED `displayBump` (not raw
 * `lastMarkedAt`), so a hot square can't churn the stream and bury photo proofs.
 * A zero-count Tally Card is excluded — an emptied Tally drops out of the Feed
 * entirely. With no Notices the output is byte-identical to the pre-Notice merge
 * (the `notices` default is `[]`, contributing no entries).
 */
export function mergeFeed(
  proofs: ProofDoc[],
  moments: MomentDoc[],
  tallyCards?: TallyCard[],
  max?: number,
): FeedEntry[];
export function mergeFeed(
  proofs: ProofDoc[],
  moments: MomentDoc[],
  tallyCards?: TallyCard[],
  notices?: NoticeDoc[],
  max?: number,
): FeedEntry[];
export function mergeFeed(
  proofs: ProofDoc[],
  moments: MomentDoc[],
  tallyCards: TallyCard[] = [],
  noticesOrMax: NoticeDoc[] | number = [],
  max = 60,
): FeedEntry[] {
  const notices = Array.isArray(noticesOrMax) ? noticesOrMax : [];
  const effectiveMax = typeof noticesOrMax === 'number' ? noticesOrMax : max;
  const noticeEntries = notices.map((notice) => ({
    feedKind: 'notice' as const,
    createdAt: notice.createdAt,
    notice,
  }));
  // Pinned Notices are the Feed's masthead: always on top, newest pinned first,
  // independent of the stream's newest-first ordering below.
  const pinned = noticeEntries
    .filter((e) => e.notice.pinned)
    .sort((a, b) => b.createdAt - a.createdAt);
  const cappedMax = Math.max(0, effectiveMax);
  const pinnedLimit = cappedMax <= 1 ? cappedMax : Math.min(PINNED_NOTICE_MASTHEAD_LIMIT, cappedMax - 1);
  const masthead = pinned.slice(0, pinnedLimit);
  const stream: FeedEntry[] = [
    ...proofs.map((proof) => ({ feedKind: 'proof' as const, createdAt: proof.createdAt, proof })),
    ...moments.map((moment) => ({ feedKind: 'moment' as const, createdAt: moment.createdAt, moment })),
    ...tallyCards
      .filter((card) => card.count > 0)
      .map((card) => ({ feedKind: 'tallyCard' as const, createdAt: card.displayBump, card })),
    ...noticeEntries.filter((e) => !e.notice.pinned),
  ].sort((a, b) => b.createdAt - a.createdAt);
  return [...masthead, ...stream.slice(0, cappedMax - masthead.length)];
}

/** One Tally marker row for the Feed derivation: the marker doc plus the `itemId`
 * lifted from its parent path (marker docs don't store it). */
export interface TallyMarkerRow extends TallyEntry {
  itemId: string;
}

/**
 * Fold a flat list of Tally markers into per-`(itemId, dayIndex)` Tally Cards
 * (#216) — the pure heart of the Feed's third stream. Only markers carrying BOTH a
 * `dayIndex` and an `itemText` form a card (legacy per-Prompt markers written
 * before #216 have neither, so they stay Square-badge-only). Each group's `count`
 * is its live marker count, `lastMarkedAt` the max marker time, and `displayBump`
 * the debounced sort key computed from the group's PREVIOUS displayed bump
 * (`prevDisplayed[key]`) via `nextDisplayBumpTime` — so the count updates live but
 * the Feed position holds for `windowMs`. Empty groups never exist here, so an
 * emptied Tally simply produces no card (it drops out). Returns the cards plus the
 * NEXT displayed-bump map for the caller to carry forward.
 */
export function deriveTallyCards(
  rows: TallyMarkerRow[],
  prevDisplayed: Record<string, number> = {},
  windowMs: number = BUMP_DEBOUNCE_MS,
): { cards: TallyCard[]; displayed: Record<string, number> } {
  const groups = new Map<string, TallyMarkerRow[]>();
  for (const r of rows) {
    if (typeof r.dayIndex !== 'number' || !r.itemText) continue;
    const key = `${r.itemId}::${r.dayIndex}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }
  const displayed: Record<string, number> = {};
  const cards: TallyCard[] = [];
  for (const [key, members] of groups) {
    // One row per Player per card: the marker write path is uid-keyed
    // (tally/{itemId}/markers/{uid}), but this render fold is the last line of
    // defense — a stray second row for the same uid (an unscoped source, a
    // legacy overlap) must never read "Nathan Payne, Nathan Payne got …".
    // Earliest markedAt wins so the chronological names line is stable.
    const byUid = new Map<string, TallyMarkerRow>();
    for (const m of members) {
      const seen = byUid.get(m.uid);
      if (!seen || m.markedAt < seen.markedAt) byUid.set(m.uid, m);
    }
    const markers = [...byUid.values()].sort((a, b) => a.markedAt - b.markedAt);
    const lastMarkedAt = markers.reduce((m, x) => Math.max(m, x.markedAt), 0);
    const displayBump = nextDisplayBumpTime(prevDisplayed[key], lastMarkedAt, windowMs);
    displayed[key] = displayBump;
    cards.push({
      itemId: markers[0].itemId,
      dayIndex: markers[0].dayIndex as number,
      itemText: markers[0].itemText as string,
      count: markers.length,
      markers,
      lastMarkedAt,
      displayBump,
    });
  }
  return { cards, displayed };
}

/**
 * The Feed's live Tally Cards (#216): one per `(itemId, dayIndex)` that anyone has
 * marked, derived from an Event-filtered `collectionGroup` query over Tally markers
 * (the same "count is the marker set" model the Square badge uses — no admin-
 * maintained aggregate doc). The banned-marker filter mirrors `useTally`: a banned
 * Player's Mark drops from the public card AND its count. The debounced display
 * bump is carried across snapshots in a ref so a card's Feed position holds for
 * `BUMP_DEBOUNCE_MS` even as its count updates live.
 */
export function useTallyCards() {
  const { bannedUids } = useEventModeration();
  const eventId = EVENT_ID;
  const key = eventScopeKey(eventId, 'tally-cards');
  const displayedRef = useRef<{ eventId: string; displayed: Record<string, number> }>({
    eventId,
    displayed: {},
  });
  const [state, setState] = useState<{ key: string; cards: TallyCard[]; loading: boolean }>(() => ({
    key,
    cards: [],
    loading: true,
  }));
  // Re-derive whenever the ban roster changes so a newly-banned marker drops.
  const bannedKey = bannedUids.join(',');
  useEffect(() => {
    let active = true;
    if (displayedRef.current.eventId !== eventId) {
      displayedRef.current = { eventId, displayed: {} };
    }
    setState((previous) =>
      previous.key === key ? { ...previous, loading: true } : { key, cards: [], loading: true },
    );
    // #1072: the predicate is part of the server query, so another Event's
    // markers are never delivered over the wire. Keep the callback's path guard
    // below through the migration/legacy-client compatibility window as a
    // fail-closed check against malformed or stale snapshots.
    const unsub = onSnapshot(
      query(collectionGroup(db, 'markers'), where('eventId', '==', eventId)),
      { includeMetadataChanges: true },
      (snap) => {
        if (!active) return;
        const rows: TallyMarkerRow[] = [];
        for (const d of snap.docs) {
          // Guard the collection group to THIS Event's Tally markers only:
          // events/{EVENT_ID}/tally/{itemId}/markers/{uid}. The parent.id check
          // alone would admit a sibling event's markers (a test event in the
          // same project), merging two events' marks into one card.
          const tallyDoc = d.ref.parent.parent;
          if (!tallyDoc || tallyDoc.parent.id !== 'tally') continue;
          if (tallyDoc.parent.parent?.id !== eventId) continue;
          const data = d.data() as TallyEntry;
          if (isBanned(data.uid, bannedUids)) continue;
          rows.push({ ...data, itemId: tallyDoc.id });
        }
        const { cards, displayed } = deriveTallyCards(rows, displayedRef.current.displayed);
        displayedRef.current = { eventId, displayed };
        setState({ key, cards, loading: false });
      },
      () => {
        if (!active) return;
        setState((previous) =>
          previous.key === key ? { ...previous, loading: false } : { key, cards: [], loading: false },
        );
      },
    );
    return () => {
      active = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bannedKey]);
  return state.key === key ? state : { key, cards: [], loading: true };
}

/**
 * The combined Feed (ADR 0002 / #216 / specs/admin-messages.md): Proofs +
 * Moments + Tally Cards + Notices merged newest-first (pinned Notices first),
 * capped to `max`. Composes `useProofFeed` + `useMoments` + `useTallyCards` +
 * `useNotices` (each with its own subscription) and folds them through
 * `mergeFeed`; it does not open a subscription of its own. `loading` stays true
 * until ALL four streams have delivered a first snapshot so the empty state
 * never flashes before one arrives.
 *
 * `max` is a WINDOW, not a ceiling (#441): `ProofFeed` grows it a page at a time
 * as the reader scrolls, and `hasMore` says whether growing it would actually
 * reveal anything. The window is purely presentational — every stream already
 * subscribes to its whole collection and slices client-side — so a bigger
 * window costs render work, never another read.
 *
 * `hasMore` comes from running the SAME merge one entry wider (`max + 1`) and
 * asking whether it yielded more. Counting the raw streams instead would
 * overcount: each sub-hook slices to its own `max` before `mergeFeed` sees it,
 * `mergeFeed` drops zero-count Tally Cards, and the pinned-Notice masthead has
 * its own limit that interacts with the cap. Asking `mergeFeed` itself, twice,
 * needs none of that reasoning to stay true as the merge rules evolve — it is
 * one extra sort of an already-`max`-bounded list, and `entries` is the plain
 * `mergeFeed(..., max)` it always was.
 */
export function useFeed(max = 60) {
  const { proofs, loading: proofsLoading } = useProofFeed(max + 1);
  const { moments, loading: momentsLoading } = useMoments(max + 1);
  const { cards, loading: tallyLoading } = useTallyCards();
  const { notices, loading: noticesLoading } = useNotices();
  const entries = useMemo(
    () => mergeFeed(proofs, moments, cards, notices, max),
    [proofs, moments, cards, notices, max],
  );
  const widerEntries = useMemo(
    () => mergeFeed(proofs, moments, cards, notices, max + 1),
    [proofs, moments, cards, notices, max],
  );
  return {
    entries,
    hasMore: widerEntries.length > entries.length,
    // The UNCAPPED tally stream (Codex P2 on #286): the proof-card pills
    // (itemId → text for the doubts derivation, itemText → live count) must be
    // derived from EVERY Tally Card, not just the ones that survived the
    // `max`-entry merge cap — a busy Feed would otherwise zero the pills on
    // any Proof whose Prompt's card fell outside the cap.
    tallyCards: cards,
    notices,
    loading: proofsLoading || momentsLoading || tallyLoading || noticesLoading,
  };
}

/**
 * The admin-confirmed claim queue, oldest first. `hasServerData` rides along
 * (#1151, Codex P2) because the archive control gates on this queue being EMPTY:
 * a cache-only (or not-yet-arrived) snapshot reads as zero pending claims, and a
 * gate that passes vacuously is no gate at all.
 */
export function usePendingClaims() {
  const { data, loading, hasServerData } = useColSub<ClaimDoc>(
    claimsCol(),
    eventSubscriptionKey('claims'),
  );
  const claims = data.filter((c) => c.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  return { claims, loading, hasServerData };
}

/**
 * The Admin Approvals queue (#210, daily-cards-spec § "Item pools and the
 * approval flow"): every main-pool Prompt awaiting an admin decision, oldest
 * first (so the longest-waiting submission floats to the top — mirrors
 * `usePendingClaims`'s shape, per the ticket's implementation note). Scoped
 * `where('status','==','pending')` so every matched doc satisfies the ADMIN arm
 * of the items read rule with a single-field equality — no composite index. This
 * is its own subscription (not a client-side filter over `useAllItems`) so the
 * Approvals tab does not re-filter the WHOLE items collection (every status,
 * every pool) on every render just to find the handful of pending rows.
 */
export function usePendingItems() {
  const { data, loading } = useColSub<ItemDoc>(
    query(itemsCol(), where('status', '==', 'pending')),
    eventSubscriptionKey('items-pending'),
  );
  const items = [...data].sort((a, b) => a.createdAt - b.createdAt);
  return { items, loading };
}

/**
 * The signed-in Player's OWN pending main-pool Prompts (#210): "a submitter's own
 * pending items should still render in their list, visibly marked pending, not
 * silently vanish after Add." `useItems` only reads `status == 'active'`, so a
 * fresh `pending` submission would otherwise disappear from ItemPool the instant
 * it is added. Scoped `where('createdBy','==',uid)` + `where('status','==',
 * 'pending')` — BOTH equality clauses (mirrors `useMyProofs`'s same two-equality
 * shape), so this rides the existing single-field indexes and needs NO composite
 * index, and every matched doc satisfies the read rule's submitter carve-out
 * (`status == 'pending' && createdBy == request.auth.uid`) without touching the
 * ADMIN arm. Pass `null`/`undefined` (signed-out) to open no subscription.
 */
export function useMyPendingItems(uid: string | null | undefined) {
  // `hasServerData` (#559, Codex P2, PR #845): ItemPool's submitter-state
  // derivation needs to tell "no matching doc" apart from "no CONFIRMED
  // answer yet" — an offline/cold-cache start clears `loading` on an empty
  // CACHE snapshot too, which would otherwise let a genuinely still-pending
  // submission read as `not_selected`. See `deriveMySubmissions`'s `ready`
  // doc comment.
  const { data, loading, hasServerData } = useColSub<ItemDoc>(
    uid ? query(itemsCol(), where('createdBy', '==', uid), where('status', '==', 'pending')) : null,
    eventSubscriptionKey('items-pending-mine', uid ?? 'none'),
  );
  const items = [...data].sort((a, b) => a.createdAt - b.createdAt);
  return { items, loading, hasServerData };
}

/**
 * The signed-in Player's OWN ACTIVE (approved) Prompts — the submitter-state
 * companion to `useMyPendingItems` above (#559, Codex P2, PR #845). Reads
 * are scoped `where('createdBy','==',uid) + where('status','==','active')`,
 * the same two-equality shape (no composite index), and satisfies the item
 * read rule's public `status == 'active'` arm.
 *
 * Deliberately its OWN unfiltered query rather than a client-side filter of
 * `useItems()`'s public pool: `useItems` additionally drops a Prompt that has
 * crossed the community auto-hide report threshold, is withheld by the
 * adult-content posture, or was authored by a since-banned uid — all three
 * are PRESENTATIONAL hides for the public pool, not a change to the
 * document's own `status`. A submitter whose approved Prompt got reported
 * into auto-hide is still genuinely `active` and should see `'approved'` (or
 * `'scheduled'`), not have it read as `'not_selected'` because the public
 * pool no longer lists it.
 */
export function useMyActiveItems(uid: string | null | undefined) {
  const { data, loading, hasServerData } = useColSub<ItemDoc>(
    uid ? query(itemsCol(), where('createdBy', '==', uid), where('status', '==', 'active')) : null,
    eventSubscriptionKey('items-active-mine', uid ?? 'none'),
  );
  const items = [...data].sort((a, b) => a.createdAt - b.createdAt);
  return { items, loading, hasServerData };
}

/**
 * The signed-in Player's OWN Claims (#41). Scoped `where('uid','==',uid)` so every
 * matched doc satisfies the claims read rule (`isOwner(resource.data.uid)`) — a
 * Player is NOT an admin, so an unconstrained collection read would be denied.
 * `ConfirmWinMoments` consumes this to notice when one of the Player's pending
 * Marks is confirmed by an Admin, so it can emit the win's Moment wherever the
 * Player is (the confirm-path edge Board's route-scoped detection misses). The
 * `hasServerData` latch gates the baseline: the first server-backed snapshot's
 * already-confirmed Claims are history, not fresh confirms to announce.
 */
export function useMyClaims(uid: string | undefined) {
  const { data, loading, hasServerData, fromCache } = useColSub<ClaimDoc>(
    uid ? query(claimsCol(), where('uid', '==', uid)) : null,
    eventSubscriptionKey('my-claims', uid ?? 'none'),
  );
  // `fromCache` lets `ConfirmWinMoments` seed its freshness witness ONLY from a
  // server-backed pending observation (Codex #116 R2 finding 2): a cache-only
  // pending snapshot on a fresh reload must not make a confirm that landed while
  // the app was closed look like an in-session pending→confirmed flip.
  return { claims: data, loading, hasServerData, fromCache };
}

/**
 * The count for the More menu's Admin row badge (#208, daily-cards-spec §
 * "More menu" § Admin): Prompts awaiting approval (`ItemDoc.status ===
 * 'pending'`, the #200 schema / #210 write-path approval flow). Deliberately
 * its OWN small subscription rather than reusing `useAllItems` — an admin-
 * only read (`firestore.rules`: "Pending/rejected items readable only by
 * admins + submitter") that More mounts unconditionally alongside the rest of
 * the menu, so it must stay cheap and must never open for a non-admin. Pass
 * `enabled=false` (a non-admin viewer) to open NO subscription — mirrors
 * `useItems`'s `enabled` gate. 0/hidden until #210 starts writing pending
 * items is expected, not broken (the field itself shipped with #200, before
 * anything writes it).
 */
export function usePendingItemCount(enabled = true) {
  const { data, loading } = useColSub<ItemDoc>(
    enabled ? query(itemsCol(), where('status', '==', 'pending')) : null,
    eventSubscriptionKey(enabled ? 'items-pending' : 'items-pending:disabled'),
  );
  return { count: data.length, loading };
}

/**
 * Admin views: everything, including hidden/reported. Deliberately applies
 * NEITHER hide — not the `status` hard-hide, not the ADR 0004 Phase 0 threshold
 * auto-hide — so an Admin can reach content the community auto-hide has removed
 * from every Player's pool and restore or delete it. Sorted most-reported-first
 * so the moderation-priority Prompts float to the top. If this view ALSO applied
 * the threshold filter, a threshold-hidden Prompt would vanish from the console
 * too and no Admin could ever act on it — the exact failure ADR 0004 warns of.
 */
export function useAllItems() {
  const { data, loading } = useColSub<ItemDoc>(itemsCol(), eventSubscriptionKey('items-admin'));
  return { items: data.sort((a, b) => b.reportCount - a.reportCount), loading };
}

/**
 * The Proof moderation queue: every Proof needing admin attention, most-reported-
 * first. Queue membership is reported (`reportCount > 0`) OR `flagged` OR
 * hard-hidden (`status === 'hidden'`) OR Vision-flagged (`visionFlag` set) —
 * hidden content belongs in the queue regardless of its count. The hidden arm is
 * load-bearing (Codex P2, PR #107
 * round 2): unlike Prompts, whose `useAllItems` lists EVERY Prompt, there is no
 * all-proofs admin list, so this queue is the ONLY admin surface for Proofs.
 * Without it, an admin who Clear-reports a doubly-hidden Proof (status 'hidden'
 * AND over the threshold) BEFORE restoring drops its reportCount to 0 and the
 * still-hidden Proof would vanish from the console with no UI path to restore or
 * delete it — the clear-then-restore ordering must never orphan anything.
 * The `visionFlag` arm (#133) closes the same orphaning trap one step later in the
 * Vision lifecycle. A Vision-hidden Proof is `status: 'hidden'` with `reportCount`
 * 0, so it queues on the hidden arm — but the admin's Restore writes
 * `status: 'active'` and deliberately leaves `visionFlag` set as the record of what
 * was overridden, and on the three older arms that restored Proof would drop out of
 * the ONLY admin surface for Proofs the moment it was restored, taking the AI
 * verdict with it and leaving no way to re-hide it short of a report. Membership on
 * the flag itself keeps every AI-screened Proof reachable for as long as the verdict
 * stands, so the override is visible and reversible.
 * Like `useAllItems` it is UNfiltered by the ADR 0004 Phase 0 threshold — a Proof
 * whose `reportCount` has crossed `reportHideThreshold` (and so self-hid on every
 * Player's Feed via `useProofFeed`) still surfaces here so an Admin can reach it
 * (any count at/over a POSITIVE threshold is > 0, so the reported arm is a strict
 * superset of the auto-hidden set). The subscription is the one broad admin read
 * of the whole collection (no `where()`), so the OR is a pure client-side filter —
 * no second listener, no composite index.
 */
export function useReportedProofs() {
  const { data, loading } = useColSub<ProofDoc>(proofsCol(), eventSubscriptionKey('proofs-admin'));
  const flagged = data
    .filter(
      (p) =>
        p.reportCount > 0 || p.status === 'flagged' || p.status === 'hidden' || !!p.visionFlag,
    )
    .sort((a, b) => b.reportCount - a.reportCount);
  return { flagged, loading };
}

/**
 * A Prompt's Doubts (ADR 0001): every "pics or it didn't happen" raised against
 * `itemId`, newest-last (sorted by `createdAt` so the who-list reads
 * chronologically, like `useTally`). Subscribes through the SAME `useColSub`
 * latch pattern as the Tally + Feed (`{ includeMetadataChanges: true }`, the
 * `hasServerData` latch on the first server-backed snapshot), filtered to the one
 * Prompt so the Square badge + Tally sheet read only what they render. Pass
 * `null`/`undefined` (e.g. the free centre Square, which never tallies or doubts)
 * to open no subscription. Whether a given Doubt is OPEN vs SATISFIED is a PURE
 * derivation over the Feed's Proofs (`openDoubts`/`doubtStatusFor` in
 * src/data/doubts.ts) — this hook only streams the raw Doubts; it never gates,
 * blocks, or mutates a Mark (a Doubt is social pressure, never a gate).
 *
 * `viewerUid` is the signed-in Player whose board this read serves (Board passes it
 * for both the per-Square DoubtBadge and the TallySheet). It makes the target-side
 * ban filter VIEWER-AWARE (see below).
 */
/**
 * EVERY Doubt in the event (#262 — the Feed's "👀 cleared N doubts" pill needs
 * cross-Prompt visibility, and the doubts collection is event-flat, so ONE
 * subscription serves every proof card). Same ban semantics as `useDoubts`:
 * a banned accuser's Doubts vanish for everyone; Doubts against a banned
 * target hide except from the target themselves.
 */
// The Feed's flat Hearts stream (specs/feed-hearts.md): one subscription
// feeding every card's count + the viewer's own hearted state, mirroring
// useAllDoubts. NO ban filter here — heartState (src/data/hearts.ts) applies
// it per post, because the own-content exception needs the viewer's uid at
// derivation time and the raw stream is shared across all cards.
export function useAllHearts(enabled = true) {
  const { data, loading, hasServerData } = useColSub<HeartDoc>(
    enabled ? heartsCol() : null,
    eventSubscriptionKey(enabled ? 'hearts:all' : 'hearts:none'),
  );
  return { hearts: data, loading, hasServerData };
}

export function useAllDoubts(viewerUid?: string | null) {
  const { bannedUids } = useEventModeration();
  const { data, loading, hasServerData } = useColSub<DoubtDoc>(
    doubtsCol(),
    eventSubscriptionKey('doubts:all'),
  );
  const doubts = data.filter(
    (d) =>
      !isBanned(d.fromUid, bannedUids) &&
      (!isBanned(d.targetUid, bannedUids) || d.targetUid === viewerUid),
  );
  return { doubts, loading, hasServerData };
}

export function useDoubts(itemId: string | null | undefined, viewerUid?: string | null) {
  const { bannedUids } = useEventModeration(!!itemId);
  const { data, loading, hasServerData } = useColSub<DoubtDoc>(
    itemId ? query(doubtsCol(), where('itemId', '==', itemId)) : null,
    eventSubscriptionKey('doubts', itemId ?? 'none'),
  );
  // The Admin ban (#108), with the own-content exception mirroring `useMyProofs`
  // (Codex P2, PR #122 round 2): a ban hides content from OTHERS, not from oneself.
  //  - `fromUid` banned → ALWAYS hidden (a banned accuser's Doubts vanish for
  //    everyone, themselves included — the accusation is content aimed at others).
  //  - `targetUid` banned → hidden EXCEPT when the target IS the current viewer.
  //    From another Player's board the banned target's presence stays hidden (their
  //    Mark is already gone from `useTally`, so a Doubt about it would dangle), but
  //    a banned Player viewing their OWN board must still SEE and be able to answer
  //    a Doubt raised against them — otherwise the ban would silence accusations
  //    against them in their own UI, which the own-content exception forbids.
  // Presentational only; admin surfaces do not read this hook.
  const doubts = [...data]
    .filter((d) => {
      if (isBanned(d.fromUid, bannedUids)) return false;
      if (isBanned(d.targetUid, bannedUids) && d.targetUid !== viewerUid) return false;
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
  return { doubts, count: doubts.length, loading, hasServerData };
}

/**
 * The signed-in viewer's OWN active Proofs (Codex P2 finding 4, #106). This is the
 * ONLY set a viewer-scoped `DoubtBadge` needs: a Doubt AGAINST THE VIEWER is
 * answered exactly when the viewer has a Proof for the doubted Prompt (by itemText)
 * at or after it, so the badge only ever consults the viewer's own Proofs. A
 * `where('uid','==',uid)` + `where('status','==','active')` query — BOTH equality
 * clauses, so it rides the existing single-field indexes and needs NO composite
 * index (firestore.indexes.json is untouched). The `status == 'active'` clause is
 * also required for the read to be ALLOWED (the proofs read rule gates non-admins
 * to active proofs, so an unfiltered own-proofs query would be rejected). Replaces
 * the Board-wide `useProofFeed` the badge used to consume — a Card mount no longer
 * opens an all-Players proof stream. Pass `null`/`undefined` (signed-out) to open
 * no subscription.
 *
 * Applies the SAME ADR 0004 community auto-hide as `useProofFeed` (`isReportHidden`
 * against `useReportHideThreshold` — Codex P2, PR #106 round 4): a Proof the group
 * can no longer see in the public Feed must not satisfy a Doubt either, or the
 * badge would clear ("answered") on evidence nobody can inspect — if the group
 * cannot see the proof, it cannot answer the accusation. Fail-open like #107: a
 * missing/non-positive threshold filters nothing.
 */
export function useMyProofs(uid: string | null | undefined) {
  // Threshold only, no ban filter (#108): this is the VIEWER'S OWN content shown in
  // the viewer's OWN Doubt-badge derivation, and a ban is PRESENTATIONAL — it hides
  // a Player's content from OTHERS, not from themselves. So a banned viewer's own
  // Proofs still answer Doubts against them in their own UI; the ban takes effect on
  // the PUBLIC-facing reads (useProofFeed / useProofsForItemText) where OTHERS see
  // this content. See specs/w2-ban-console.md § Filtered surfaces.
  const { threshold } = useEventModeration();
  const { data, loading, hasServerData } = useColSub<ProofDoc>(
    uid ? query(proofsCol(), where('uid', '==', uid), where('status', '==', 'active')) : null,
    eventSubscriptionKey('proofs:mine', uid ?? 'none'),
  );
  const proofs = data.filter((p) => !isReportHidden(p.reportCount, threshold));
  return { proofs, loading, hasServerData };
}

/**
 * The active Proofs for ONE Prompt (Codex P2 finding 4, #106), for the Tally
 * sheet's per-marker Doubt status. Joined by `itemText` — the SAME (uid, itemText)
 * key the Doubt derivation uses, because a ProofDoc carries no itemId (see
 * specs/w2-doubts.md) — via a `where('itemText','==',itemText)` +
 * `where('status','==','active')` query, BOTH equality, so NO composite index is
 * required. Mounted only WHILE the sheet is open (the sheet renders this hook), so
 * no proof listener exists per-cell or Board-wide. Pass `null`/`undefined` to open
 * no subscription.
 *
 * Applies the SAME ADR 0004 community auto-hide as `useProofFeed` (`isReportHidden`
 * against `useReportHideThreshold` — Codex P2, PR #106 round 4): the sheet must not
 * render "Proof shown ✓" for a Proof the public Feed has community-hidden — if the
 * group cannot see the proof, it cannot answer the accusation. Fail-open like
 * #107: a missing/non-positive threshold filters nothing.
 */
export function useProofsForItemText(itemText: string | null | undefined) {
  const { threshold, bannedUids } = useEventModeration();
  const { data, loading, hasServerData } = useColSub<ProofDoc>(
    itemText
      ? query(proofsCol(), where('itemText', '==', itemText), where('status', '==', 'active'))
      : null,
    eventSubscriptionKey('proofs:item', itemText ?? 'none'),
  );
  // This is a PUBLIC-facing read — the Tally sheet renders it for EVERY viewer to
  // show which markers have shown a Proof — so unlike `useMyProofs` it DOES apply
  // the Admin ban (#108): a banned Player's Proof must not render "Proof shown ✓" in
  // another Player's Tally sheet. Filtered by the Proof's owner `uid`, composed with
  // the community auto-hide.
  const proofs = data.filter(
    (p) => !isReportHidden(p.reportCount, threshold) && !isBanned(p.uid, bannedUids),
  );
  return { proofs, loading, hasServerData };
}

/** The distinct proof "kinds" a Leaderboard row's chip strip can show — one
 *  flag per chip, independent of `ProofDoc.type`/`source` naming so
 *  `proofChips` (Leaderboard.tsx) never has to re-inspect a raw Proof. */
export interface ProofKindFlags {
  photo: boolean;
  library: boolean;
  audio: boolean;
  text: boolean;
}

/**
 * Every proof "kind" each Player has actually used, across their active
 * Proofs (#604, daily-cards-spec § "Asking for proof — Doubts"): the
 * Leaderboard's per-row media chips are the UNION of kinds a Player has used
 * during the Event, not just their most recent Proof's kind (#218's original
 * "latest only" reading undercounted a Player who mixed live photos, library
 * photos, and written proof down to a single chip — reported in #604).
 * Presentational only — Leaderboard.tsx applies it strictly AFTER
 * `sortPlayers`, so it never feeds ranking/filter logic.
 *
 * Derived from `useProofFeed(max)` — the SAME newest-first, capped, filtered
 * list the public Feed's proof stream renders — rather than a new/unbounded
 * query (Codex P2, PR #243, carried forward by #604): a chip's `onClick`
 * navigates to `/feed`, and `ProofFeed` caps its merged entries at the same
 * `max` via `useFeed`, so the union is only ever built from Proofs that are
 * actually CANDIDATES for the page the chip navigates to. This also folds in
 * the same two PUBLIC-facing filters (community auto-hide + Admin ban, #108)
 * `useProofFeed` already applies, and shares its `'proofs'` subscription
 * cache key — one listener, not two.
 */
export function useProofKindsByUid(max = 60) {
  const { proofs, loading } = useProofFeed(max);
  const kindsByUid: Record<string, ProofKindFlags> = {};
  for (const p of proofs) {
    const flags = kindsByUid[p.uid] ?? (kindsByUid[p.uid] = { photo: false, library: false, audio: false, text: false });
    if (p.type === 'photo') flags.photo = true;
    if (p.type === 'photo' && p.source === 'library') flags.library = true;
    if (p.type === 'audio') flags.audio = true;
    if (p.type === 'text') flags.text = true;
  }
  return { kindsByUid, loading };
}
