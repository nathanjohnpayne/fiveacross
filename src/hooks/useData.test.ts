import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Codex P3 on PR #66: Board must not keep a live listener on the whole
// Prompt pool once a Player already has a frozen Board (it fans every other
// Player's prompt add/report out as a full-pool read + rerender for no
// reason). `useItems`'s `enabled` gate is the mechanism — this proves the
// hook itself opens no `onSnapshot` subscription when disabled, independent
// of how Board.tsx wires the flag (that wiring is covered separately in
// src/components/w1-board-deal-join.test.tsx via a useItems spy).
//
// Codex P2 on PR #66 round 4: with the ADR 0006 persistent cache, the first
// snapshot can be served from IndexedDB (`metadata.fromCache`), so the subs
// also expose a `hasServerData` latch — false until a server-confirmed
// snapshot arrives, then latched for the life of the subscription key. The
// latch tests below drive the captured onSnapshot callback with cache/server
// snapshots against the real hooks.

const H = vi.hoisted(() => ({ onSnapshot: vi.fn(), eventId: 'event-a' }));

vi.mock('../firebase', () => ({
  db: {},
  get EVENT_ID() {
    return H.eventId;
  },
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));

vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref; // paths.ts chains .withConverter on refs
    return ref;
  };
  return {
    doc: (...args: unknown[]) => makeRef('doc', args),
    collection: (...args: unknown[]) => makeRef('collection', args),
    query: (...args: unknown[]) => ({ query: args }),
    where: (...args: unknown[]) => ({ where: args }),
    onSnapshot: H.onSnapshot,
  };
});

// Real module under test — imported after the mocks are declared.
import { useItems, useBoard, useDayMetasStatus, useEventDoc, useLeaderboard, useMyUser } from './useData';
import { MAX_ARCHIVE_NUMBER, MAX_DAYS } from '../data/eventLimits';
// The archive's own roster normaliser and the shared First-to-BINGO selector, so
// the LIVE path's answer is compared against the frozen one rather than described
// separately (#1152, Codex P2 on PR #1165 round 4).
import { withReadableDayStats } from '../data/eventArchive';
import { cruiseFirstBingoUid, withReadableRanking } from '../game/logic';
import type { PlayerDoc } from '../types';

beforeEach(() => {
  H.eventId = 'event-a';
  H.onSnapshot.mockReset();
  H.onSnapshot.mockReturnValue(() => {}); // unsubscribe fn
});

// Capture the latest subscription's onNext callback so tests can deliver
// cache/server snapshots by hand. The real hooks call
// onSnapshot(target, options, onNext, onError).
type SnapCb = (snap: unknown) => void;
function captureOnNext(): { fire: (snap: unknown) => void } {
  const captured: { cb: SnapCb | null } = { cb: null };
  H.onSnapshot.mockImplementation(
    (_target: unknown, _options: unknown, onNext: SnapCb) => {
      captured.cb = onNext;
      return () => {};
    },
  );
  return {
    fire: (snap: unknown) => {
      if (!captured.cb) throw new Error('onSnapshot not subscribed');
      act(() => captured.cb!(snap));
    },
  };
}

// Capture BOTH callbacks of the latest doc subscription. The error leg is what
// separates `serverResolved` from `hasServerData` (#1152, Codex P2 on PR #1139
// round 5): an errored onSnapshot listener is terminal, so it can never deliver
// a server snapshot, and a gate that waited for one would never open.
function captureDocSub(): { fire: (snap: unknown) => void; fail: () => void } {
  const captured: { next: SnapCb | null; error: (() => void) | null } = {
    next: null,
    error: null,
  };
  H.onSnapshot.mockImplementation(
    (_target: unknown, _options: unknown, onNext: SnapCb, onError: () => void) => {
      captured.next = onNext;
      captured.error = onError;
      return () => {};
    },
  );
  return {
    fire: (snap: unknown) => {
      if (!captured.next) throw new Error('onSnapshot not subscribed');
      act(() => captured.next!(snap));
    },
    fail: () => {
      if (!captured.error) throw new Error('onSnapshot not subscribed');
      act(() => captured.error!());
    },
  };
}

const colSnap = (fromCache: boolean) => ({ docs: [], metadata: { fromCache } });
const docSnap = (fromCache: boolean) => ({
  exists: () => false,
  data: () => undefined,
  metadata: { fromCache },
});

const presentDocSnap = (value: object) => ({
  exists: () => true,
  data: () => value,
  metadata: { fromCache: false, hasPendingWrites: false },
});

describe('Event-scoped subscription lifecycle (#807)', () => {
  it('hides Event A synchronously, unsubscribes it, subscribes B, and ignores a queued A callback', () => {
    const subscriptions: Array<{
      target: { args?: unknown[] };
      onNext: SnapCb;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    H.onSnapshot.mockImplementation(
      (target: { args?: unknown[] }, _options: unknown, onNext: SnapCb) => {
        const unsubscribe = vi.fn();
        subscriptions.push({ target, onNext, unsubscribe });
        return unsubscribe;
      },
    );

    const frames: Array<ReturnType<typeof useBoard>> = [];
    const view = renderHook(() => {
      const frame = useBoard('u1');
      frames.push(frame);
      return frame;
    });
    expect(subscriptions[0].target.args).toContain('event-a');
    act(() => subscriptions[0].onNext(presentDocSnap({ uid: 'u1', event: 'A' })));
    expect(view.result.current.data).toMatchObject({ event: 'A' });

    H.eventId = 'event-b';
    const beforeSwitch = frames.length;
    view.rerender();

    // The very first render evaluated under B is neutral. This assertion does
    // not rely on the passive effect's reset render, which is too late to
    // prevent one painted frame of A under B.
    expect(frames[beforeSwitch].data).toBeNull();
    expect(view.result.current.data).toBeNull();
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriptions[1].target.args).toContain('event-b');

    act(() => subscriptions[0].onNext(presentDocSnap({ uid: 'u1', event: 'A-late' })));
    expect(view.result.current.data).toBeNull();

    act(() => subscriptions[1].onNext(presentDocSnap({ uid: 'u1', event: 'B' })));
    expect(view.result.current.data).toMatchObject({ event: 'B' });

    H.eventId = 'event-a';
    view.rerender();
    expect(view.result.current.data).toBeNull();
    expect(subscriptions).toHaveLength(3);

    // The retired first A subscription cannot repopulate the newly selected A
    // scope; only the fresh third subscription is authoritative.
    act(() => subscriptions[0].onNext(presentDocSnap({ uid: 'u1', event: 'A-stale' })));
    expect(view.result.current.data).toBeNull();
    act(() => subscriptions[2].onNext(presentDocSnap({ uid: 'u1', event: 'A-fresh' })));
    expect(view.result.current.data).toMatchObject({ event: 'A-fresh' });
  });

  it('keeps the global users/{uid} profile subscribed across an Event change', () => {
    const callbacks: SnapCb[] = [];
    H.onSnapshot.mockImplementation(
      (_target: unknown, _options: unknown, onNext: SnapCb) => {
        callbacks.push(onNext);
        return vi.fn();
      },
    );
    const view = renderHook(() => useMyUser('u1'));
    act(() => callbacks[0](presentDocSnap({ uid: 'u1', displayName: 'Global profile' })));

    H.eventId = 'event-b';
    view.rerender();

    expect(H.onSnapshot).toHaveBeenCalledTimes(1);
    expect(view.result.current.data).toMatchObject({ displayName: 'Global profile' });
  });
});

describe('useItems enabled gate (Codex P3)', () => {
  // useItems now also reads the ADR 0004 threshold from useEventDoc(), which
  // opens a SEPARATE subscription on the event DOC. The P3 gate is specifically
  // about the heavy POOL listener — the one that fans every Player's prompt
  // add/report out as a full-pool read + rerender. Since #43 F4 that pool read is
  // `query(itemsCol(), where('status','==','active'))` (server-gated to active),
  // so it arrives as a query WRAPPING the items COLLECTION — count those, not the
  // tiny event-doc read Board already makes anyway.
  const poolSubCount = () =>
    H.onSnapshot.mock.calls.filter((c) => {
      const inner = (c[0] as { query?: unknown[] } | null)?.query?.[0] as { kind?: string } | undefined;
      return inner?.kind === 'collection';
    }).length;

  it('subscribes to the pool by default (no Board yet)', () => {
    renderHook(() => useItems());

    expect(poolSubCount()).toBe(1);
  });

  it('opens no pool listener when disabled — a Player with a frozen Board', () => {
    renderHook(() => useItems(false));

    expect(poolSubCount()).toBe(0);
  });

  it('subscribes once more if `enabled` flips back to true', () => {
    const { rerender } = renderHook(({ enabled }) => useItems(enabled), {
      initialProps: { enabled: false },
    });
    expect(poolSubCount()).toBe(0);

    rerender({ enabled: true });

    expect(poolSubCount()).toBe(1);
  });
});

describe('hasServerData latch (Codex P2, round 4 — persistent-cache cold start)', () => {
  it('subscribes with includeMetadataChanges so the cache→server transition is observable', () => {
    // Without metadata events, a cache snapshot followed by byte-identical
    // server data produces NO second event and the latch would deadlock.
    renderHook(() => useItems());

    expect(H.onSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeMetadataChanges: true }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('useItems: false over a cache-only snapshot, latched true once the server confirms', () => {
    const sub = captureOnNext();
    const { result } = renderHook(() => useItems());
    expect(result.current.hasServerData).toBe(false);

    // Cold persistent cache: first snapshot is cache-served and empty. The
    // data "loads" (loading false) but is NOT server truth yet.
    sub.fire(colSnap(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.hasServerData).toBe(false);

    // The backend confirms — latch on.
    sub.fire(colSnap(false));
    expect(result.current.hasServerData).toBe(true);

    // A later cache-served snapshot (offline flap) must not unlatch: the
    // subscription has seen server truth for this key.
    sub.fire(colSnap(true));
    expect(result.current.hasServerData).toBe(true);
  });

  it('useBoard: false over a cache-only missing doc, latched true once the server confirms', () => {
    const sub = captureOnNext();
    const { result } = renderHook(() => useBoard('sailor-1'));
    expect(result.current.hasServerData).toBe(false);

    sub.fire(docSnap(true)); // cache says "no board" — not trustworthy yet
    expect(result.current.loading).toBe(false);
    expect(result.current.hasServerData).toBe(false);

    sub.fire(docSnap(false)); // server agrees — now it is truth
    expect(result.current.hasServerData).toBe(true);
  });
});

// Codex P2 on PR #1162. `useDayMetasStatus` fans one subscription per Day, and
// `serverLoaded` is the strict LATCH: "every Day's honour has been answered by
// the SERVER at least once". An errored subscription used to satisfy it, which
// made the latch a lie in exactly the case it exists for — a listener that died
// before any server snapshot confirmed nothing, yet the archive read the Day as
// confirmed and armed over a preview that had fallen back to a DERIVED honour,
// or to none, while `archiveEvent`'s own server re-read could recover the PINNED
// one and freeze it instead. (The archive now gates on `serverConfirmed`, the
// stricter per-render answer pinned in the block below; an errored Day has to
// stay out of BOTH, for the same reason.)
describe('useDayMetasStatus — a failed honour subscription confirms nothing (#1151)', () => {
  /** Captures every per-Day subscription's `onNext`/`onError` pair, in fan
   *  order. The real hook calls onSnapshot(ref, options, onNext, onError). */
  function captureFan(): {
    next: (i: number, snap: unknown) => void;
    error: (i: number, err?: unknown) => void;
  } {
    const subs: Array<{ onNext: (s: unknown) => void; onError: (e: unknown) => void }> = [];
    H.onSnapshot.mockImplementation(
      (
        _target: unknown,
        _options: unknown,
        onNext: (s: unknown) => void,
        onError: (e: unknown) => void,
      ) => {
        subs.push({ onNext, onError });
        return () => {};
      },
    );
    return {
      next: (i, snap) => act(() => subs[i].onNext(snap)),
      error: (i, err) => act(() => subs[i].onError(err ?? new Error('permission-denied'))),
    };
  }

  const metaSnap = (fromCache: boolean) => ({
    exists: () => false,
    data: () => undefined,
    metadata: { fromCache },
  });

  it('resolves `loaded` but NOT `serverLoaded` when a Day subscription dies', () => {
    const fan = captureFan();
    const { result } = renderHook(() => useDayMetasStatus([0, 1]));

    fan.next(0, metaSnap(false)); // Day 0 answered by the server
    fan.error(1); // Day 1's listener dies before any snapshot

    // The live honours strip must not hang on a dead listener, so the Day is
    // RESOLVED…
    expect(result.current.loaded).toBe(true);
    // …but nothing about its honour was confirmed, so the archive gate stays
    // shut — and says why, because this latch can now never complete.
    expect(result.current.serverLoaded).toBe(false);
    expect(result.current.failed).toBe(true);
  });

  it('reports no failure, and the strict latch, when every Day is server-answered', () => {
    const fan = captureFan();
    const { result } = renderHook(() => useDayMetasStatus([0, 1]));

    fan.next(0, metaSnap(true)); // cold persistent cache — resolved, not confirmed
    fan.next(1, metaSnap(true));
    expect(result.current.loaded).toBe(true);
    expect(result.current.serverLoaded).toBe(false);
    expect(result.current.failed).toBe(false);

    fan.next(0, metaSnap(false));
    fan.next(1, metaSnap(false));
    expect(result.current.serverLoaded).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('does not unlatch a Day the server already confirmed when its listener later dies', () => {
    // The latch is per Day and for life. A subscription torn down after the
    // server has spoken has still spoken — but the failure is reported, because
    // the console should not present a dead fan as healthy.
    const fan = captureFan();
    const { result } = renderHook(() => useDayMetasStatus([0]));

    fan.next(0, metaSnap(false));
    expect(result.current.serverLoaded).toBe(true);

    fan.error(0);
    expect(result.current.serverLoaded).toBe(true);
    expect(result.current.failed).toBe(true);
    // …and `failed` overlaps the CURRENT answer for the same reason (CodeRabbit,
    // PR #1162): the last snapshot this Day delivered was server-committed and
    // the error callback removes nothing, so a consumer that read `failed` as
    // "not confirmed" would show a terminal message beside an armed control.
    expect(result.current.serverConfirmed).toBe(true);
  });
});

// Codex P2 on PR #1162. The fan used to take the schedule's LENGTH and subscribe
// to `days/0 … days/n-1`, which is the same set of documents only while the
// schedule is contiguous from zero — a property the setup wizard's draft
// validation enforces at authoring time and nothing enforces on a stored Event,
// while every day-scoped path in the estate keys on `DayDef.index` (the #447
// precedent). On a schedule the two disagree about, the archive console
// confirmed one Day's honour and the freeze then froze another's, permanently.
describe('useDayMetasStatus — the fan addresses the schedule’s own Day indexes (#1151)', () => {
  function captureFan(): { next: (i: number, snap: unknown) => void } {
    const subs: Array<{ onNext: (s: unknown) => void }> = [];
    H.onSnapshot.mockImplementation(
      (_target: unknown, _options: unknown, onNext: (s: unknown) => void) => {
        subs.push({ onNext });
        return () => {};
      },
    );
    return { next: (i, snap) => act(() => subs[i].onNext(snap)) };
  }

  /** The document paths this fan opened, in fan order. `paths.ts` builds every
   *  ref through the mocked `doc(db, …)`, so the segments after `db` ARE the
   *  path — which is the whole question here. */
  const subscribedPaths = () =>
    H.onSnapshot.mock.calls.map((call) =>
      ((call[0] as { args: unknown[] }).args.slice(1) as string[]).join('/'),
    );

  const pinSnap = (uid: string) => ({
    exists: () => true,
    data: () => ({ firstBingo: { uid, displayName: uid, at: 1_500 } }),
    metadata: { fromCache: false, hasPendingWrites: false },
  });

  it('subscribes to days/4/meta/4 for a one-Day schedule at index 4, never to days/0', () => {
    const fan = captureFan();
    const { result } = renderHook(() => useDayMetasStatus([4]));

    expect(subscribedPaths()).toEqual(['events/event-a/days/4/meta/4']);
    expect(subscribedPaths().some((path) => path.includes('/days/0/'))).toBe(false);

    // …and the confirmation keys on that Day too, so the archive gate cannot be
    // satisfied by a Day the schedule does not have.
    expect(result.current.serverConfirmed).toBe(false);
    fan.next(0, pinSnap('pinned'));
    expect(result.current.serverConfirmed).toBe(true);
    expect(result.current.metas.get(4)).toMatchObject({ firstBingo: { uid: 'pinned' } });
    expect(result.current.metas.has(0)).toBe(false);
  });

  it('collapses a repeated Day and addresses none with an unusable index', () => {
    const fan = captureFan();
    const { result } = renderHook(() =>
      // What a stored `EventDoc.days` can actually hold: the rules arm validates
      // no entry, and `migrateDayFields` reads a nullish one as `{}`, so an index
      // can be missing or fractional. `days/undefined/meta/undefined` is a
      // document that is not there, answered as an ordinary "no pin here".
      // …and an integer OUTSIDE the supported range is dropped by the same
      // clause (Codex P2 on PR #1162, round 7). Unlike the shapes above,
      // `days/-1/meta/-1` and `days/10/meta/10` are perfectly addressable — so
      // without this the fan opened real subscriptions on Days the `DayDef`
      // contract does not have, and confirmed the archive gate on them.
      useDayMetasStatus([
        2,
        2,
        Number.NaN,
        undefined as unknown as number,
        1.5,
        -1,
        MAX_DAYS,
        Number.MAX_SAFE_INTEGER + 2,
      ]),
    );
    expect(subscribedPaths()).toEqual(['events/event-a/days/2/meta/2']);

    // One distinct Day, so one answer completes the fan. Counting the raw list
    // instead would leave every latch permanently short and the archive control
    // disabled behind a message that never resolves.
    fan.next(0, pinSnap('pinned'));
    expect(result.current.loaded).toBe(true);
    expect(result.current.serverLoaded).toBe(true);
    expect(result.current.serverConfirmed).toBe(true);

    // …and NORMALISING IS NOT ACCEPTING (Codex P2 on PR #1162). Every shape it
    // just collapsed is one `archiveEvent` refuses as `schedule-unusable`, and
    // silently normalising them is what let the Archive control arm over a
    // schedule the freeze was going to turn down after the Event was already
    // shut. The fan still completes — it has to, or every gate on this hook hangs
    // — and reports that it had to.
    expect(result.current.scheduleUnusable).toBe(true);
  });

  it('reports an unusable schedule per SHAPE, and a unique non-contiguous one as fine', () => {
    captureFan();
    // A repeated Day: readable, but two entries for ONE Day — the freeze would
    // read one meta document twice and freeze that Day's honour twice.
    expect(renderHook(() => useDayMetasStatus([0, 1, 1])).result.current.scheduleUnusable).toBe(
      true,
    );
    // An index that names no Day at all.
    expect(
      renderHook(() => useDayMetasStatus([0, undefined as unknown as number])).result.current
        .scheduleUnusable,
    ).toBe(true);
    // …and an INTEGER that names no Day either (Codex P2 on PR #1162, round 7).
    // `-1`, `MAX_DAYS` and an unsafe large integer pass `Number.isInteger`, and
    // each is a real path this fan would otherwise subscribe to — on a Day the
    // `DayDef` contract does not have, and one the freeze refuses.
    for (const index of [-1, MAX_DAYS, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        renderHook(() => useDayMetasStatus([0, index])).result.current.scheduleUnusable,
      ).toBe(true);
    }
    // THE CONTROLS, and the reason the fan keys on `DayDef.index` at all: a
    // unique non-contiguous schedule is a schedule the freeze reads correctly,
    // and both ends of the supported range are Days.
    expect(renderHook(() => useDayMetasStatus([4])).result.current.scheduleUnusable).toBe(false);
    expect(renderHook(() => useDayMetasStatus([0, 3, 7])).result.current.scheduleUnusable).toBe(
      false,
    );
    expect(
      renderHook(() => useDayMetasStatus([0, MAX_DAYS - 1])).result.current.scheduleUnusable,
    ).toBe(false);
    // An Event with no schedule at all is not an unusable one — it is an Event
    // with nothing to fan over, which the completion tests already read as
    // vacuously satisfied.
    expect(renderHook(() => useDayMetasStatus([])).result.current.scheduleUnusable).toBe(false);
  });
});

// Codex P2 on PR #1162. `serverLoaded` above is a LATCH — "the server has spoken
// at least once" — and the archive gate needs the stricter question: is the
// preview on screen right now what the server said? A confirmed console that
// goes offline, or that has a local write in flight, keeps the latch while the
// ADR 0006 persistent cache re-serves every Day, and the freeze it takes is
// permanent.
describe('useDayMetasStatus — serverConfirmed is the CURRENT snapshot, not a latch (#1151)', () => {
  function captureFan(): { next: (i: number, snap: unknown) => void } {
    const subs: Array<{ onNext: (s: unknown) => void }> = [];
    H.onSnapshot.mockImplementation(
      (_target: unknown, _options: unknown, onNext: (s: unknown) => void) => {
        subs.push({ onNext });
        return () => {};
      },
    );
    return { next: (i, snap) => act(() => subs[i].onNext(snap)) };
  }

  const metaSnap = (fromCache: boolean, hasPendingWrites = false) => ({
    exists: () => false,
    data: () => undefined,
    metadata: { fromCache, hasPendingWrites },
  });

  it('falls FALSE again when a confirmed Day re-delivers from the cache', () => {
    const fan = captureFan();
    const { result } = renderHook(() => useDayMetasStatus([0, 1]));

    fan.next(0, metaSnap(false));
    fan.next(1, metaSnap(false));
    expect(result.current.serverConfirmed).toBe(true);

    // The admin goes offline: this Day is re-delivered from the persistent
    // cache. The LATCH holds, because the server did speak once…
    fan.next(1, metaSnap(true));
    expect(result.current.serverLoaded).toBe(true);
    // …and the current answer does not, because that is a different claim.
    expect(result.current.serverConfirmed).toBe(false);

    // Connectivity returns and the Day is confirmed again — it is not a latch
    // in either direction.
    fan.next(1, metaSnap(false));
    expect(result.current.serverConfirmed).toBe(true);
  });

  it('is FALSE while a local write on a Day meta is still pending', () => {
    const fan = captureFan();
    const { result } = renderHook(() => useDayMetasStatus([0]));

    // Emitted server-backed but UNDECIDED: `fromCache` is false and the write
    // has not been acked, so it can still roll back.
    fan.next(0, metaSnap(false, true));
    expect(result.current.serverLoaded).toBe(true);
    expect(result.current.serverConfirmed).toBe(false);

    fan.next(0, metaSnap(false, false));
    expect(result.current.serverConfirmed).toBe(true);
  });

  it('needs EVERY Day, and is vacuously true for a schedule with none', () => {
    const fan = captureFan();
    const { result } = renderHook(() => useDayMetasStatus([0, 1]));

    fan.next(0, metaSnap(false));
    expect(result.current.serverConfirmed).toBe(false);
    fan.next(1, metaSnap(false));
    expect(result.current.serverConfirmed).toBe(true);

    // No Days to confirm: the same vacuous answer `loaded`/`serverLoaded` give,
    // which is why the console gates the Event document separately.
    const { result: none } = renderHook(() => useDayMetasStatus([]));
    expect(none.current.serverConfirmed).toBe(true);
  });
});

// Codex P2 on PR #1162, the roster half of the same finding. `useColSub` already
// carries the current snapshot's metadata; this hook used to discard it, leaving
// the archive gate with the lifetime latch alone.
describe('useLeaderboard — the CURRENT snapshot beside the latch (#1151)', () => {
  const rosterSnap = (fromCache: boolean, hasPendingWrites = false) => ({
    docs: [],
    metadata: { fromCache, hasPendingWrites },
  });

  it('reports the latest snapshot’s origin and pending-write state', () => {
    const sub = captureOnNext();
    const { result } = renderHook(() => useLeaderboard());

    // Cold persistent cache.
    sub.fire(rosterSnap(true));
    expect(result.current.hasServerData).toBe(false);
    expect(result.current.fromCache).toBe(true);

    sub.fire(rosterSnap(false));
    expect(result.current.hasServerData).toBe(true);
    expect(result.current.fromCache).toBe(false);
    expect(result.current.hasPendingWrites).toBe(false);

    // Offline again: Board's ceremonial edge keeps the latch it reads, and the
    // archive gate gets the per-snapshot answer it needs beside it.
    sub.fire(rosterSnap(true));
    expect(result.current.hasServerData).toBe(true);
    expect(result.current.fromCache).toBe(true);

    // Server-backed but UNDECIDED — an optimistic local roster write.
    sub.fire(rosterSnap(false, true));
    expect(result.current.fromCache).toBe(false);
    expect(result.current.hasPendingWrites).toBe(true);
  });
});

// #1152 (specs/post-sailing-archive.md § "The surfaces"), Codex P2 on PR #1139
// round 5. The Leaderboard's routing half decides whether to mount the LIVE
// listener fan — the whole `players` roster, every Day's meta document and up to
// 60 Proofs — or the archived view, which opens none of them. That decision must
// not be taken against a cache replay, so it needs "the server has answered — or
// never will" as a gate. `hasServerData` alone cannot be that gate: an errored
// subscription leaves it false forever, which is a surface stuck on a spinner.
describe('serverResolved — the server has answered, or never can', () => {
  it('latches on the first server snapshot, exactly like hasServerData', () => {
    const sub = captureDocSub();
    const { result } = renderHook(() => useBoard('sailor-1'));
    expect(result.current.serverResolved).toBe(false);

    sub.fire(docSnap(true)); // cache-served: delivered, but not answered
    expect(result.current.serverResolved).toBe(false);

    sub.fire(docSnap(false));
    expect(result.current.serverResolved).toBe(true);

    // Latched: a later offline flap does not un-answer it, so a reconnect cannot
    // bounce an already-routed Leaderboard back through the spinner.
    sub.fire(docSnap(true));
    expect(result.current.serverResolved).toBe(true);
  });

  it('also resolves on an ERRORED subscription, which hasServerData deliberately does not', () => {
    const sub = captureDocSub();
    const { result } = renderHook(() => useBoard('sailor-1'));

    sub.fire(docSnap(true));
    sub.fail(); // permission-denied, signed out mid-flight — terminal
    expect(result.current.serverResolved).toBe(true);
    // The distinction is the point: nothing was ever confirmed BY the server, so
    // a consumer reading the DATA still knows it is unconfirmed.
    expect(result.current.hasServerData).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('resolves an error that arrives before any snapshot at all', () => {
    // The cold permission-denied: no snapshot was ever delivered, so the
    // previous state is the empty one and the latch has to survive being rebuilt
    // from it rather than being dropped with it.
    const sub = captureDocSub();
    const { result } = renderHook(() => useBoard('sailor-1'));

    sub.fail();
    expect(result.current.serverResolved).toBe(true);
    expect(result.current.hasServerData).toBe(false);
    expect(result.current.data).toBeNull();
  });
});

// #1152, Codex P2 on PR #1165. The Leaderboard's routing half reads a persisted
// per-generation record of a server-committed archive so a REMOUNT with an
// unrelated moderation write still queued reaches the frozen surface. Only a
// mounted Leaderboard used to WRITE that record, which made it useless in the
// case it exists for: an Admin receives the committed archive on the console,
// queues an offline ban there, and the Leaderboard's first snapshot is then a
// cached archive with `hasPendingWrites: true` and nothing persisted behind it —
// both latches false, and the live child mounted with every gameplay listener.
//
// The observation is a fact about the DEVICE, so the SHARED subscription every
// route holds records it, from the `onSnapshot` callback rather than from a
// render or an effect. These drive the real `useEventDoc` against hand-delivered
// snapshots; `EVENT_ID` is `'event-a'` (the `../firebase` stub above).
describe('useEventDoc records a server-committed archive for every route (#1152)', () => {
  const confirmedKey = 'gcb.archive.event-a.confirmedUnder';

  // jsdom leaves `window.localStorage` unset in this project (the `App.test.tsx`
  // / `useTextSize.test.ts` note), and recent Node runtimes ship a built-in
  // global of the same name that is present but non-functional. Bring our own.
  function createStorageStub(): Storage {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  }

  const eventSnap = (
    event: Record<string, unknown>,
    metadata: { fromCache: boolean; hasPendingWrites: boolean },
  ) => ({ exists: () => true, data: () => event, metadata });

  // The freeze writes `status`, the stamp, the generation and the record in one
  // update, so this is the shape a committed archive really arrives in.
  const archived = (over: Record<string, unknown> = {}) => ({
    name: 'Med 2026',
    status: 'archived',
    archivedAt: 9_000,
    archivedUnder: 4,
    archive: { standings: [], dailyHonors: [], freezeAt: null, archivedAt: 9_000 },
    ...over,
  });

  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the generation when the snapshot is server-backed and free of local writes', () => {
    const sub = captureDocSub();
    renderHook(() => useEventDoc());

    sub.fire(eventSnap(archived(), { fromCache: false, hasPendingWrites: false }));
    expect(window.localStorage.getItem(confirmedKey)).toBe('4');
  });

  it('writes nothing for a CACHE-served archived snapshot', () => {
    // The ADR 0006 persistent cache replaying the flip is not the server having
    // committed it — that is the whole distinction the record carries.
    const sub = captureDocSub();
    renderHook(() => useEventDoc());

    sub.fire(eventSnap(archived(), { fromCache: true, hasPendingWrites: false }));
    expect(window.localStorage.getItem(confirmedKey)).toBeNull();

    // …and the SAME document lands the moment the server serves it, so the
    // decline above is about the origin and not about the fixture.
    sub.fire(eventSnap(archived(), { fromCache: false, hasPendingWrites: false }));
    expect(window.localStorage.getItem(confirmedKey)).toBe('4');
  });

  it('writes nothing while the flip is still an unacked local write', () => {
    // An Admin's own optimistic `status: 'archived'` rolls back if the rules
    // refuse it, so vouching for it would confirm an archive that never was.
    const sub = captureDocSub();
    renderHook(() => useEventDoc());

    sub.fire(eventSnap(archived(), { fromCache: false, hasPendingWrites: true }));
    expect(window.localStorage.getItem(confirmedKey)).toBeNull();

    // …and it lands the moment that write is acked, so the decline above is
    // about the pending write and not about the fixture.
    sub.fire(eventSnap(archived(), { fromCache: false, hasPendingWrites: false }));
    expect(window.localStorage.getItem(confirmedKey)).toBe('4');
  });

  it('writes nothing for a committed snapshot of a LIVE Event, and then the flip', () => {
    // The subscription is on every route for the whole sailing, so the ordinary
    // case is an open Event: it records nothing until the freeze actually lands.
    const sub = captureDocSub();
    renderHook(() => useEventDoc());

    sub.fire(
      eventSnap({ name: 'Med 2026', status: 'active' }, { fromCache: false, hasPendingWrites: false }),
    );
    expect(window.localStorage.getItem(confirmedKey)).toBeNull();

    sub.fire(eventSnap(archived(), { fromCache: false, hasPendingWrites: false }));
    expect(window.localStorage.getItem(confirmedKey)).toBe('4');
  });

  it('writes nothing for an archived Event carrying no record, or no generation', () => {
    // Neither shape is one `archiveEvent` produces — both are hand-edited
    // documents — and the routing gate the record serves declines them anyway,
    // so a confirmation for either could only ever vouch for a page nobody can
    // reach.
    const sub = captureDocSub();
    renderHook(() => useEventDoc());

    sub.fire(
      eventSnap(archived({ archive: undefined }), { fromCache: false, hasPendingWrites: false }),
    );
    expect(window.localStorage.getItem(confirmedKey)).toBeNull();

    sub.fire(
      eventSnap(archived({ archivedUnder: undefined }), {
        fromCache: false,
        hasPendingWrites: false,
      }),
    );
    expect(window.localStorage.getItem(confirmedKey)).toBeNull();

    // The complete document — status, generation and record together, which is
    // the one update the freeze writes — is what the two above are missing.
    sub.fire(eventSnap(archived(), { fromCache: false, hasPendingWrites: false }));
    expect(window.localStorage.getItem(confirmedKey)).toBe('4');
  });

  // Codex P2 on PR #1165 round 4. `EVENT_ID` is a LIVE ESM binding, so an
  // observer that read it in the snapshot callback read whatever it said when
  // the snapshot LANDED. Between the active Event moving and this listener's
  // effect cleanup retiring it, that is already the NEW Event — so an Event A
  // snapshot was persisted under Event B's key, and a pending archive generation
  // in B that happened to match could then be read back as previously
  // server-confirmed. `specs/event-scoped-client-state.md`: A's state may never
  // persist under B.
  it('records the snapshot under the Event the subscription was opened for', () => {
    const sub = captureDocSub();
    renderHook(() => useEventDoc());

    // The active Event moves while A's listener is still live — the window
    // before effect cleanup runs, which is exactly when the binding is mutable
    // and the callback is still armed.
    H.eventId = 'event-b';
    sub.fire(eventSnap(archived(), { fromCache: false, hasPendingWrites: false }));

    expect(window.localStorage.getItem(confirmedKey)).toBe('4');
    expect(window.localStorage.getItem('gcb.archive.event-b.confirmedUnder')).toBeNull();
  });
});

// #1145 / #1142 item 10, routed to #1152. `players/{uid}` validates none of its
// fields, and `comparePlayers` SUBTRACTS two of them — so one Player's row could
// throw a TypeError out of `sortPlayers` and take down every consumer of this
// roster, the Admin console's Game settings and its Reopen play control included.
describe('useLeaderboard makes the roster READABLE before it ranks it', () => {
  const rosterSnap = (rows: unknown[]) => ({
    docs: rows.map((row) => ({ data: () => row })),
    metadata: { fromCache: false, hasPendingWrites: false },
  });
  const row = (over: Record<string, unknown>) => ({
    uid: 'p',
    displayName: 'P',
    photoURL: null,
    joinedAt: 0,
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    reshufflesUsed: 0,
    ...over,
  });

  it('sorts a row whose bingoCount cannot be converted to a number, instead of throwing', () => {
    const sub = captureOnNext();
    const { result } = renderHook(() => useLeaderboard());

    // The exact shape #1145 names: an object with a nulled `toString`, which the
    // comparator's subtraction cannot coerce.
    sub.fire(
      rosterSnap([
        row({ uid: 'broken', displayName: 'Broken', bingoCount: { toString: null } }),
        row({ uid: 'ok', displayName: 'Ok', bingoCount: 2, squaresMarked: 9 }),
      ]),
    );

    expect(result.current.players.map((p) => p.uid)).toEqual(['ok', 'broken']);
    // The unreadable count reads as the 0 the row already displayed for it —
    // nothing is invented, and nothing else on the row moves.
    const broken = result.current.players.find((p) => p.uid === 'broken');
    expect(broken?.bingoCount).toBe(0);
    expect(broken?.displayName).toBe('Broken');
  });

  it('reads a NaN stat as 0 and a NaN instant as null, so the sort order is never unspecified', () => {
    const sub = captureOnNext();
    const { result } = renderHook(() => useLeaderboard());

    // Every comparison against NaN is false, so a NaN row leaves the sort order
    // formally unspecified — the #93 hazard, one layer earlier.
    sub.fire(
      rosterSnap([
        row({ uid: 'nan', displayName: 'Nan', squaresMarked: Number.NaN, firstBingoAt: Number.NaN }),
        row({ uid: 'real', displayName: 'Real', squaresMarked: 4, firstBingoAt: 1_000 }),
      ]),
    );

    expect(result.current.players.map((p) => p.uid)).toEqual(['real', 'nan']);
    const nan = result.current.players.find((p) => p.uid === 'nan');
    expect(nan?.squaresMarked).toBe(0);
    expect(nan?.firstBingoAt).toBeNull();
  });

  it('returns a well-formed row by IDENTITY, so a healthy roster is untouched', () => {
    const sub = captureOnNext();
    const { result } = renderHook(() => useLeaderboard());

    const healthy = row({ uid: 'ok', displayName: 'Ok', bingoCount: 2, squaresMarked: 9 });
    sub.fire(rosterSnap([healthy]));

    // Not merely equal — the SAME object. The coercion is a repair, not a copy
    // pass over every snapshot.
    expect(result.current.players[0]).toBe(healthy);
  });
});

// #1152, Codex P2 on PR #1165 round 4. The roster is normalised BEFORE it is
// ranked — but "ranked" is two questions on this surface, and the root fields are
// only the first. The Leaderboard's First-to-BINGO pin resolves through
// `effectiveCruiseFirstBingoAt`, which PREFERS a row's per-Day `dayStats` buckets
// whenever it has any, and `players/{uid}` validates a bucket exactly as little as
// it validates the root. The freeze runs those buckets through
// `withReadableDayStats`; the live path ran the root-only `withReadableRanking`,
// so a bucket stamp outside the archive's magnitude bound survived here and was
// clamped there — and the frozen page could then name a First to BINGO the last
// live page did not. `useLeaderboard` therefore calls the archive's own function.
describe('useLeaderboard normalises the per-Day buckets the pin ranks by (#1152)', () => {
  const rosterSnap = (rows: unknown[]) => ({
    docs: rows.map((row) => ({ data: () => row })),
    metadata: { fromCache: false, hasPendingWrites: false },
  });
  // Root stamps stay `null` so the honour is decided by the BUCKETS alone, which
  // is the half the root-only normaliser cannot reach.
  const bucketRow = (uid: string, stamp: number): PlayerDoc =>
    ({
      uid,
      displayName: uid,
      photoURL: null,
      joinedAt: 0,
      bingoCount: 1,
      squaresMarked: 1,
      firstBingoAt: null,
      reshufflesUsed: 0,
      dayStats: { 1: { bingoCount: 1, squaresMarked: 1, firstBingoAt: stamp } },
    }) as unknown as PlayerDoc;

  const notTutorial = () => false;

  it('keeps the same First-to-BINGO holder live and frozen for two out-of-bound bucket stamps', () => {
    // Both stamps are below `-MAX_ARCHIVE_NUMBER` and DISTINCT, so they order one
    // way unclamped and tie under the clamp — where the tie-break is uid
    // ascending, which names the OTHER Player. The uid ordering is deliberately
    // the opposite of the raw stamp ordering, so the two answers differ.
    const rows = [
      bucketRow('a-later', -(MAX_ARCHIVE_NUMBER + 1_000)),
      bucketRow('z-earlier', -(MAX_ARCHIVE_NUMBER + 2_000)),
    ];
    const sub = captureOnNext();
    const { result } = renderHook(() => useLeaderboard());
    sub.fire(rosterSnap(rows));

    // The freeze's answer, taken through the builder's own normaliser.
    const frozenHolder = cruiseFirstBingoUid(rows.map(withReadableDayStats), notTutorial);
    expect(frozenHolder).toBe('a-later');
    expect(cruiseFirstBingoUid(result.current.players, notTutorial)).toBe(frozenHolder);

    // …and the root-only normaliser really does answer differently, so the
    // agreement above is about the buckets and not about the fixture.
    expect(cruiseFirstBingoUid(rows.map(withReadableRanking), notTutorial)).toBe('z-earlier');
  });

  it('returns a row whose buckets are already readable by IDENTITY', () => {
    // `useLeaderboard` runs this on every roster snapshot and every real Player
    // carries `dayStats`, so the ordinary case still has to cost one array and no
    // row copies — the property the root-only normaliser had, kept.
    const healthy = bucketRow('ok', 900);
    const sub = captureOnNext();
    const { result } = renderHook(() => useLeaderboard());
    sub.fire(rosterSnap([healthy]));

    expect(result.current.players[0]).toBe(healthy);
  });
});
