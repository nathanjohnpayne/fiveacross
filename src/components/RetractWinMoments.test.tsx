import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import type { BoardDoc, EventDoc } from '../types';

// RetractWinMoments (#479), component layer: the WIRING between the app-shell
// mount and the unit-tested observer core (`createRetractionFallObserver`,
// src/data/w2-feed-moments.test.ts). What must hold here:
//   - one metadata-inclusive board subscription per scheduled Day (daily mode),
//     or exactly the single legacy board (no-days mode) — never the legacy board
//     on a daily Event (its day-less retraction arm is unconditional);
//   - NOTHING subscribes until the Event doc is known (which boards exist is a
//     function of the schedule);
//   - snapshots are forwarded with the observer's contract shape (per-snapshot
//     metadata + the doc's own uid + cells; a missing doc reads as no evidence);
//   - unmount and account switch tear the fan down (and a switch re-keys it, so
//     every observer re-baselines under the new uid).

interface FakeSnap {
  metadata: { fromCache: boolean; hasPendingWrites: boolean };
  exists: () => boolean;
  data: () => BoardDoc | undefined;
}
type SnapListener = (snap: FakeSnap) => void;

const H = vi.hoisted(() => ({
  eventId: 'event-a',
  uid: 'u1' as string | undefined,
  event: null as Partial<EventDoc> | null,
  // Every onSnapshot call: its ref path, options, listener, and unsubscribe spy.
  subs: [] as { path: string; options: unknown; listener: SnapListener; unsub: ReturnType<typeof vi.fn> }[],
  observers: [] as {
    uid: string;
    dayIndex: number | undefined;
    eventId: string;
    observe: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock('../firebase', () => ({
  db: {},
  get EVENT_ID() {
    return H.eventId;
  },
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: H.uid ? { uid: H.uid } : null }),
}));
vi.mock('../hooks/useData', () => ({
  useEventDoc: () => ({ data: H.event }),
}));
vi.mock('../data/paths', () => ({
  boardRef: (uid: string, eventId: string) => ({ path: `events/${eventId}/boards/${uid}` }),
  dayBoardRef: (dayIndex: number, uid: string, eventId: string) => ({
    path: `events/${eventId}/days/${dayIndex}/boards/${uid}`,
  }),
}));
vi.mock('firebase/firestore', () => ({
  onSnapshot: (
    ref: { path: string },
    options: unknown,
    listener: SnapListener,
    _onError?: (err: unknown) => void,
  ) => {
    const unsub = vi.fn();
    H.subs.push({ path: ref.path, options, listener, unsub });
    return unsub;
  },
}));
vi.mock('../data/moments', () => ({
  createRetractionFallObserver: (uid: string, dayIndex: number | undefined, eventId: string) => {
    const observe = vi.fn();
    H.observers.push({ uid, dayIndex, eventId, observe });
    return observe;
  },
}));

import RetractWinMoments from './RetractWinMoments';

const snap = (board: BoardDoc | null, meta: Partial<FakeSnap['metadata']> = {}): FakeSnap => ({
  metadata: { fromCache: false, hasPendingWrites: false, ...meta },
  exists: () => board != null,
  data: () => board ?? undefined,
});
const boardDoc = (uid: string): BoardDoc =>
  ({ uid, cells: [{ index: 0, itemId: 'i', text: 't', free: false, marked: true, markedAt: null }] }) as BoardDoc;

beforeEach(() => {
  H.eventId = 'event-a';
  H.uid = 'u1';
  H.event = null;
  H.subs = [];
  H.observers = [];
});

describe('RetractWinMoments — app-shell wiring for the #479 fall observers', () => {
  it('subscribes NOTHING until the Event doc is known — which boards exist is a schedule question', () => {
    render(<RetractWinMoments />);
    expect(H.subs).toHaveLength(0);
    expect(H.observers).toHaveLength(0);
  });

  it('daily mode: one metadata-inclusive subscription + observer per scheduled Day, none for the legacy board', () => {
    H.event = { days: [{ index: 0 }, { index: 3 }, { index: 7 }] } as Partial<EventDoc>;
    render(<RetractWinMoments />);
    expect(H.subs.map((s) => s.path)).toEqual([
      'events/event-a/days/0/boards/u1',
      'events/event-a/days/3/boards/u1',
      'events/event-a/days/7/boards/u1',
    ]);
    // `includeMetadataChanges` is load-bearing: a server ack for an unmark
    // usually delivers byte-identical cells, and only a metadata event tells the
    // observer the snapshot flipped to server-committed.
    for (const s of H.subs) expect(s.options).toEqual({ includeMetadataChanges: true });
    expect(H.observers.map((o) => [o.uid, o.dayIndex])).toEqual([
      ['u1', 0],
      ['u1', 3],
      ['u1', 7],
    ]);
  });

  it('legacy mode (a loaded Event with no days): exactly the single legacy board, with a day-less observer', () => {
    H.event = {} as Partial<EventDoc>;
    render(<RetractWinMoments />);
    expect(H.subs.map((s) => s.path)).toEqual(['events/event-a/boards/u1']);
    expect(H.observers.map((o) => [o.uid, o.dayIndex])).toEqual([['u1', undefined]]);
  });

  it('forwards snapshots in the observer contract shape — metadata, the doc’s own uid, cells; a missing doc is no evidence', () => {
    H.event = { days: [{ index: 3 }] } as Partial<EventDoc>;
    render(<RetractWinMoments />);
    const [sub] = H.subs;
    const [obs] = H.observers;
    const board = boardDoc('u1');

    act(() => sub.listener(snap(board, { fromCache: true, hasPendingWrites: true })));
    expect(obs.observe).toHaveBeenLastCalledWith({
      fromCache: true,
      hasPendingWrites: true,
      boardUid: 'u1',
      cells: board.cells,
    });

    act(() => sub.listener(snap(null)));
    expect(obs.observe).toHaveBeenLastCalledWith({
      fromCache: false,
      hasPendingWrites: false,
      boardUid: undefined,
      cells: [],
    });
  });

  it('tears the fan down on unmount, and an account switch re-keys it with fresh observers', () => {
    H.event = { days: [{ index: 0 }, { index: 1 }] } as Partial<EventDoc>;
    const { rerender, unmount } = render(<RetractWinMoments />);
    const firstSubs = [...H.subs];
    expect(firstSubs).toHaveLength(2);

    H.uid = 'u2';
    rerender(<RetractWinMoments />);
    for (const s of firstSubs) expect(s.unsub).toHaveBeenCalledTimes(1);
    const secondSubs = H.subs.slice(2);
    expect(secondSubs.map((s) => s.path)).toEqual([
      'events/event-a/days/0/boards/u2',
      'events/event-a/days/1/boards/u2',
    ]);
    // Fresh observers → fresh baselines: falls from before the switch are never
    // adjudicated against the new account's boards.
    expect(H.observers.slice(2).map((o) => o.uid)).toEqual(['u2', 'u2']);

    unmount();
    for (const s of secondSubs) expect(s.unsub).toHaveBeenCalledTimes(1);
  });

  it('renders nothing and subscribes nothing while signed out', () => {
    H.uid = undefined;
    H.event = { days: [{ index: 0 }] } as Partial<EventDoc>;
    const { container } = render(<RetractWinMoments />);
    expect(container.firstChild).toBeNull();
    expect(H.subs).toHaveLength(0);
  });

  it('rebuilds for Event B and ignores a queued Event A callback after cleanup', () => {
    H.event = { days: [{ index: 0 }] } as Partial<EventDoc>;
    const view = render(<RetractWinMoments />);
    const aSub = H.subs[0];
    const aObserver = H.observers[0].observe;

    H.eventId = 'event-b';
    view.rerender(<RetractWinMoments />);
    expect(aSub.unsub).toHaveBeenCalledTimes(1);
    expect(H.subs[1].path).toBe('events/event-b/days/0/boards/u1');
    expect(H.observers[1]).toMatchObject({ uid: 'u1', dayIndex: 0, eventId: 'event-b' });

    act(() => aSub.listener(snap(boardDoc('u1'))));
    expect(aObserver).not.toHaveBeenCalled();
  });
});
