import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { useItems, useBoard, useDayMetasStatus, useLeaderboard, useMyUser } from './useData';
import { MAX_DAYS } from '../data/eventLimits';

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
