import { Suspense, startTransition, useState } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { ClaimDoc, DayDef, DayMetaDoc, EventArchive, EventDoc, PlayerDoc } from '../types';
// The freeze's OWN schedule predicate, used by the honour-fan stub below so the
// console gate under test is asked the same question `archiveEvent` asks (Codex
// P2 on PR #1162). Referenced only from inside the stub's closure, which runs at
// render time, so the hoisted factory never touches it before this import lands.
import { usableDayIndexes } from '../data/eventArchive';
// The SHARED subscription's archive writer (#1152, Codex P2 on PR #1165). The
// persisted-confirmation cases below seed the record by calling the very
// function `useEventDoc` calls, so the writer and the Leaderboard's reader are
// pinned to one key rather than to two hand-written copies of it.
import { recordArchiveConfirmation } from '../data/archiveConfirmation';
import { MAX_DAYS } from '../data/eventLimits';

// specs/post-sailing-archive.md, RTL layer (#1149, #1151 and #1152, epic #134).
// Two surfaces:
//
//   1. The Admin console's three actions and the states they move between:
//
//        Close play → the quiesce (reversible, gameplay shut, nothing permanent)
//        Reopen play → lifting it, unconditionally, on the Event in front of the Admin
//        Archive → BOTH writes in order, behind the drain gate and a second tap
//
//   2. The archived Leaderboard, which renders the FROZEN record and nothing
//      else. The fixtures deliberately make the live roster DISAGREE with the
//      archive, so "reads from the snapshot" is proved rather than assumed — a
//      component that quietly kept deriving from `useLeaderboard` would show the
//      live numbers and fail here. The live hooks are `vi.fn()`s so the archived
//      render can assert it never CALLED them, not merely that it ignored what
//      they returned: "it subscribes to nothing" is a claim about listeners.
//
// The write functions are `vi.fn()`s because what is under test is the console's
// own behaviour, not Firestore: `src/data/post-sailing-archive.test.ts` pins what
// each write does, and `tests/rules/post-sailing-archive.test.ts` pins what the
// boundary accepts. The read hooks are stubbed (the `w2-leaderboard.test.tsx`
// precedent for isolating a presentational surface), but `../data/moderation` and
// `../data/eventArchive` deliberately are NOT: they own the drain gate
// (`claimsAwaitingAdmin`), the ban predicate, the size refusal and the finale
// predicate this file is about, and a stubbed gate would prove nothing about the
// gate.

const H = vi.hoisted(() => {
  const state = {
    event: null as EventDoc | null,
    /** Whether the Event snapshot beside it is fully SERVER-COMMITTED — the
     *  console's own `hasServerData && !fromCache && !hasPendingWrites`. Kept
     *  separate from `event` because that is exactly the distinction the gate
     *  turns on: the persistent cache supplies a document, not a confirmation. */
    eventConfirmed: true,
    players: [] as PlayerDoc[],
    /** `useLeaderboard`'s LIFETIME latch — the server has answered this roster
     *  at least once. Kept apart from the two per-snapshot flags below because
     *  that is exactly the distinction the gate turns on (Codex P2 on PR
     *  #1162): the latch never clears, so it cannot say whether the rows on
     *  screen right now are the ones the server sent. */
    rosterSeen: true,
    rosterFromCache: false,
    rosterPending: false,
    /** `useDayMetasStatus`'s CURRENT answer: every Day's latest snapshot is
     *  fully server-committed. Not a latch, for the same reason. */
    dayMetasServerConfirmed: true,
    /** The Day honour pins the fan delivered, so the preview the Admin approves
     *  is built from real pins rather than an empty map (#1151, Codex P2 on PR
     *  #1162). `../data/eventArchive` is deliberately NOT stubbed in this file,
     *  so what the console renders here is what the freeze would carry. */
    dayMetas: new Map<number, DayMetaDoc>(),
    pendingClaims: [] as ClaimDoc[],
    pendingClaimsLoaded: true,
    /** `useEventDoc`'s server-resolution latch. `false` is the COLD VISIT: the
     *  Event document has not been answered by the server yet, so whatever the
     *  ADR 0006 cache replayed cannot decide whether this Event is archived. */
    eventServerResolved: true,
    /** That snapshot's own optimistic-write flag. An Admin's archive flip is
     *  emitted locally before the rules decide it, and a refusal rolls it back. */
    eventPendingWrites: false,
    /** That snapshot's own ORIGIN. `false` is server-backed; with
     *  `eventPendingWrites` false beside it that is a fully committed snapshot,
     *  which is what confirms an archive for good (Codex P2 on PR #1165). */
    eventFromCache: false,
    /** `useEventDoc`'s per-subscription "nothing has arrived yet". `true` is the
     *  COLD MOUNT's first render — no snapshot, cache-served or otherwise — which
     *  the offline escape must not mistake for a settled answer (Codex P2 on PR
     *  #1165). `useDocSub` clears it on the first snapshot or on an error. */
    eventLoading: false,
    /** `useOnline`. A client the browser says is offline can never BE answered by
     *  the server, so the routing gate stops waiting on one. */
    online: true,
    /** The order the writes were issued in, so the quiesce-first contract is
     *  asserted on the SEQUENCE rather than on each spy alone. */
    writes: [] as string[],
    beginArchive: vi.fn(),
    abandonArchive: vi.fn(),
    archiveEvent: vi.fn(),
    useLeaderboard: vi.fn(() => ({
      players: state.players,
      loading: false,
      hasServerData: state.rosterSeen,
      fromCache: state.rosterFromCache,
      hasPendingWrites: state.rosterPending,
    })),
    /** At least one Day's honour subscription DIED. NOT the complement of
     *  `dayMetasServerConfirmed` — a Day answered before its listener died stays
     *  confirmed (Codex P2 and CodeRabbit on PR #1162). */
    dayMetasFailed: false,
    /** Stubbed, but FAITHFUL about which Days it was asked for (Codex P2 on PR
     *  #1162): it hands back only the pins for the indexes the console
     *  subscribed to. A stub that ignored its argument would render the same
     *  preview whatever the console asked for, which is exactly the property
     *  under test — the console used to ask for `days/0 … days/n-1` while the
     *  freeze reads `days/{d.index}`. */
    useDayMetasStatus: vi.fn((dayIndexes: readonly number[]) => ({
      metas: new Map(
        [...state.dayMetas].filter(([dayIndex]) => dayIndexes.includes(dayIndex)),
      ),
      loaded: true,
      // The latch is still on the hook for the consumers that ask "has the
      // server ever spoken"; the archive gate reads the current answer below.
      serverLoaded: state.dayMetasServerConfirmed,
      serverConfirmed: state.dayMetasServerConfirmed,
      failed: state.dayMetasFailed,
      // …and faithful about the SCHEDULE too (Codex P2 on PR #1162): the real
      // hook asks `archiveEvent`'s own `usableDayIndexes` of the list it was
      // handed, and so does this, rather than carrying a flag a test could set
      // independently of the schedule it rendered.
      scheduleUnusable: !usableDayIndexes(dayIndexes),
    })),
    useProofKindsByUid: vi.fn(() => ({ kindsByUid: {}, loading: false })),
  };
  return state;
});

vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));
// The archived surface pre-renders its Share Card on mount, and the real
// rasteriser walks pseudo-elements jsdom has never implemented. What the CARD
// contains is pinned in `w2-share-cards.test.tsx` § "ArchivedLeaderboard — share
// affordance", against the same component through the same routing gate; this
// file is about the page, so the rasteriser is a stub here.
vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async () => new Blob(['fake-png-bytes'], { type: 'image/png' })),
}));
vi.mock('../hooks/useData', () => ({
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: H.useDayMetasStatus,
  useLeaderboard: H.useLeaderboard,
  useEventDoc: () => ({
    data: H.event,
    loading: H.eventLoading,
    serverResolved: H.eventServerResolved,
    fromCache: H.eventFromCache,
    hasPendingWrites: H.eventPendingWrites,
  }),
  useProofKindsByUid: H.useProofKindsByUid,
  isBanned: (uid: string | null | undefined, bannedUids: readonly string[] | undefined) =>
    !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid),
}));
vi.mock('../hooks/useOnline', () => ({
  useOnline: () => H.online,
  readOnline: () => H.online,
}));
vi.mock('../data/admin', () => ({
  beginArchive: (...args: unknown[]) => {
    H.writes.push('begin');
    return H.beginArchive(...args);
  },
  abandonArchive: (...args: unknown[]) => {
    H.writes.push('abandon');
    return H.abandonArchive(...args);
  },
  archiveEvent: (...args: unknown[]) => {
    H.writes.push('archive');
    return H.archiveEvent(...args);
  },
}));

// eslint-disable-next-line import/first -- the components must load AFTER the mocks above.
import ArchiveEvent from './admin/ArchiveEvent';
// eslint-disable-next-line import/first -- same.
import Leaderboard, { CACHED_EVENT_SETTLE_MS } from './Leaderboard';

function mkEvent(over: Partial<EventDoc> = {}): EventDoc {
  // `finaleCompletedAt` present by default, so the FINALE gate is satisfied and
  // every case that is not about it reads as an ordinary post-finale archive.
  // It is the MARKER rather than the freeze stamp beside it, because the stamp
  // alone never proved the podium landed (#1151, Codex P1 on PR #1162).
  return {
    name: 'Test Event',
    status: 'active',
    frozenAt: 8_000,
    finaleCompletedAt: 8_100,
    ...over,
  } as EventDoc;
}

function mkPlayer(uid: string, over: Partial<PlayerDoc> = {}): PlayerDoc {
  return {
    uid,
    displayName: uid,
    photoURL: null,
    joinedAt: 0,
    bingoCount: 1,
    squaresMarked: 5,
    firstBingoAt: 1000,
    reshufflesUsed: 0,
    ...over,
  } as PlayerDoc;
}

function mkClaim(over: Partial<ClaimDoc> = {}): ClaimDoc {
  return {
    id: 'claim-1',
    uid: 'late-riser',
    displayName: 'Late Riser',
    cellIndex: 3,
    itemText: 'Something happened',
    status: 'pending',
    createdAt: 1_000,
    ...over,
  } as ClaimDoc;
}

function mkDay(index: number, over: Partial<DayDef> = {}): DayDef {
  return {
    index,
    date: `2026-07-${String(15 + index).padStart(2, '0')}`,
    place: 'Somewhere',
    placeEmoji: '🏖️',
    theme: 'neon-playground',
    tonight: [],
    pool: 'main',
    tutorial: false,
    unlockAt: 1_000 * (index + 1),
    ...over,
  } as DayDef;
}

// The LIVE roster says Late Riser is on top with 9 bingos. The FROZEN record says
// Early Bird won with 3. Every archived assertion below reads the frozen numbers.
const liveRoster: PlayerDoc[] = [
  mkPlayer('late-riser', {
    displayName: 'Late Riser',
    bingoCount: 9,
    squaresMarked: 24,
    firstBingoAt: 90_000,
  }),
  mkPlayer('early-bird', {
    displayName: 'Early Bird',
    bingoCount: 3,
    squaresMarked: 18,
    firstBingoAt: 1_000,
  }),
];

const FROZEN: EventArchive = {
  // The frozen Event name (#1151): the Share Card's title comes out of the
  // record, never off the still-editable live document.
  eventName: 'Med 2026',
  standings: [
    {
      uid: 'early-bird',
      displayName: 'Early Bird',
      bingoCount: 3,
      squaresMarked: 18,
      blackout: true,
      firstBingoAt: 1_000,
    },
    {
      uid: 'steady',
      displayName: 'Steady Eddie',
      bingoCount: 1,
      squaresMarked: 12,
      blackout: false,
      firstBingoAt: 4_000,
    },
  ],
  playerCount: 2,
  firstBingo: { uid: 'early-bird', displayName: 'Early Bird', at: 1_000 },
  firstBingoRow: {
    uid: 'early-bird',
    displayName: 'Early Bird',
    bingoCount: 3,
    squaresMarked: 18,
    blackout: true,
    firstBingoAt: 1_000,
    rank: 1,
  },
  dailyHonors: [
    // The chip LABEL is part of the frozen record (#1151): the archived strip
    // renders it rather than looking the Day's theme up in the live schedule,
    // which the freeze deliberately leaves editable.
    {
      dayIndex: 0,
      uid: 'early-bird',
      displayName: 'Early Bird',
      firstBingoAt: 1_000,
      dayLabel: '🌈 D1',
    },
    {
      dayIndex: 1,
      uid: 'steady',
      displayName: 'Steady Eddie',
      firstBingoAt: 4_000,
      dayLabel: '🏋️ D2',
    },
  ],
  freezeAt: null,
  archivedAt: Date.UTC(2026, 6, 24, 12),
};

function archivedEvent(over: Partial<EventDoc> = {}): EventDoc {
  return mkEvent({
    name: 'Med 2026',
    status: 'archived',
    archivedAt: FROZEN.archivedAt,
    archive: FROZEN,
    days: [],
    bannedUids: [],
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  H.event = mkEvent();
  H.eventConfirmed = true;
  H.players = [mkPlayer('alice'), mkPlayer('bob', { squaresMarked: 3 })];
  H.rosterSeen = true;
  H.rosterFromCache = false;
  H.rosterPending = false;
  H.dayMetasServerConfirmed = true;
  H.dayMetasFailed = false;
  H.dayMetas = new Map();
  H.pendingClaims = [];
  H.pendingClaimsLoaded = true;
  H.eventServerResolved = true;
  H.eventPendingWrites = false;
  H.eventFromCache = false;
  H.eventLoading = false;
  H.online = true;
  H.writes = [];
  H.beginArchive.mockResolvedValue({
    result: 'closing',
    token: 1,
    created: true,
    eventId: 'test-event',
  });
  H.abandonArchive.mockResolvedValue('reopened');
  H.archiveEvent.mockResolvedValue('archived');
  // The archived Leaderboard pre-renders its Share Card on mount (#1152), and the
  // rasteriser only tears that offscreen host down when the render settles —
  // which is after a synchronous test has finished. Clear any host left behind so
  // a leaked card's text cannot answer the NEXT test's `screen` query.
  document.querySelectorAll('.share-card-host').forEach((host) => host.remove());
});

const props = (event: EventDoc | null = H.event) => ({
  event,
  eventConfirmed: H.eventConfirmed,
  pendingClaims: H.pendingClaims,
  pendingClaimsLoaded: H.pendingClaimsLoaded,
});
const renderConsole = () => render(<ArchiveEvent {...props()} />);
const renderLeaderboard = () =>
  render(
    <MemoryRouter>
      <Leaderboard />
    </MemoryRouter>,
  );

describe('ArchiveEvent — the two reversible lifecycle actions (#1149)', () => {
  it('offers Close play on a LIVE Event, and no way back yet', () => {
    renderConsole();
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen play' })).not.toBeInTheDocument();
  });

  it('takes the quiesce and nothing else when Close play is pressed', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    // Reversible on purpose: gameplay is shut, and nothing permanent happened.
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(H.writes).toEqual(['begin']);
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
  });

  it('offers Reopen play on a CLOSING Event, and no second Close play', () => {
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close play' })).not.toBeInTheDocument();
  });

  it('reopens UNCONDITIONALLY from the closing-state surface', async () => {
    // A deliberate act on the Event in front of the Admin, not an automatic
    // cleanup of a call that already failed — the token binding exists to stop a
    // STALE handler, and there is no stale handler at this button.
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen play' }));
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    expect(H.abandonArchive).toHaveBeenCalledWith();
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is open again/);
  });

  it('clears the action message when someone else moves the Event on (Codex P2, PR #1157)', async () => {
    // The message is a sentence about the state the action left the Event in.
    // It stays through the transition this Admin caused, and goes the moment
    // another Admin moves the Event somewhere the sentence no longer describes.
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
    // The subscription delivers the closing state this Admin produced: still true.
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Play is closed/);
    // Another Admin archives it: "Reopen play to put it back" is now false.
    view.rerender(
      <ArchiveEvent {...props(mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 }))} />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('records the state observed when the action RESOLVES, not the render it started in', async () => {
    // Codex P2, PR #1157 round 7. Another Admin closes the Event while this
    // Close play is still pending: the prop reaches `closing` and the phase
    // effect runs before any result exists. Reporting against the render the
    // click happened in would leave `from: 'open'`, and a later reopen would
    // then match it and keep "Play is closed" beside the open controls.
    let settle: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    settle({ result: 'closing', token: 1, created: false, eventId: 'test-event' });
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows nothing after a completed ROUND TRIP back to the starting phase', async () => {
    // Phase 4b P2, PR #1157 run 3. Close play commits, another Admin observes
    // it and reopens, and only then does beginArchive() settle: the Event is
    // back where the action started, but equality with the starting phase is
    // not evidence the message is true — the phase moved during the action.
    let settle: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    settle({ result: 'closing', token: 1, created: true, eventId: 'test-event' });
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('discards a superseded action’s outcome, whatever state it lands in', async () => {
    // The post-4b barrier round on PR #1157. The controls are swapped by the
    // LISTENER, not by the action: while this Close is pending, the closing
    // snapshot puts Reopen play on screen, the Admin presses it, and the Close
    // then resolves — restoring "Play is closed" beside the open controls,
    // because both actions shared one in-flight record.
    let settleClose: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settleClose = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));

    // The quiesce lands and the controls swap under the pending Close.
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reopen play' }));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is open again/);

    // …and only now does the superseded Close answer.
    settleClose({ result: 'closing', token: 1, created: true, eventId: 'test-event' });
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toHaveTextContent(/Play is open again/);
    expect(screen.getByRole('status')).not.toHaveTextContent(/Play is closed/);
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('records the round trip of the action that is still in flight, not of the one that finished', async () => {
    // The other half of the same shared-record bug (Codex round 10 on PR #1157).
    // A boolean "the phase moved" flag belongs to whichever action wrote it last
    // and is cleared by whichever finishes first, so the LATEST action's own
    // round trip went unrecorded. A monotonic count snapshotted at click time is
    // per-action, and cannot be reset out from under anyone.
    let settleClose: (value: unknown) => void = () => {};
    let settleReopen: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settleClose = resolve; }),
    );
    H.abandonArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settleReopen = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reopen play' }));

    // The first action finishes — and it is the one that used to clear the shared
    // record the second is still relying on.
    settleClose({ result: 'closing', token: 1, created: true, eventId: 'test-event' });
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));

    // A COMPLETED ROUND TRIP under the pending Reopen: someone else reopens, then
    // shuts the Event again. It ends where the Reopen started, so equality alone
    // cannot tell it from "nothing happened yet".
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 2 }))} />);

    settleReopen('reopened');
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    // "Play is open again" beside a CLOSED Event is exactly what must not appear.
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeInTheDocument();
  });

  it('shows nothing when the Event has moved somewhere the outcome does not describe', async () => {
    let settle: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    // Another Admin archives it outright while the close is in flight.
    view.rerender(
      <ArchiveEvent {...props(mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 }))} />,
    );
    settle({ result: 'closing', token: 1, created: true, eventId: 'test-event' });
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clears the closed message when someone else REOPENS the Event underneath it', async () => {
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    await screen.findByRole('status');
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Play is closed/);
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('retires the controls once the Event is archived, and still names the state', () => {
    H.event = mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000, archiving: false });
    renderConsole();
    expect(screen.queryByRole('button', { name: 'Close play' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen play' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive…' })).not.toBeInTheDocument();
    expect(screen.getByText(/^Archived /)).toBeInTheDocument();
  });

  it('reports the frozen record on an archived Event that carries one', () => {
    H.event = mkEvent({
      status: 'archived',
      archivedAt: 1_700_000_000_000,
      archiving: false,
      archive: {
        eventName: 'Test Event',
        standings: [],
        playerCount: 2,
        firstBingo: { uid: 'alice', displayName: 'Early Bird', at: 1000 },
        firstBingoRow: null,
        dailyHonors: [],
        freezeAt: null,
        archivedAt: 1_700_000_000_000,
      },
    } as Partial<EventDoc>);
    renderConsole();
    expect(screen.getByText(/2 players · first to BINGO Early Bird/)).toBeInTheDocument();
  });
});

// #1151. The irreversible flip returns to the console WITH the two things that
// make it safe to press: the pending-claim DRAIN GATE and the durable snapshot.
describe('ArchiveEvent — the Archive action (#1151)', () => {
  it('needs a second, explicit confirmation before it freezes anything', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Confirm archive' })).toBeInTheDocument();
    // The confirm states what is about to be frozen, from the same builder the
    // write uses, so the preview cannot drift from the record.
    expect(screen.getByText(/Freezing 2 players/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Archived. The final standings are frozen.',
    );
  });

  // #1151, Codex P2 on PR #1162. The console subscribed to `days/0 … days/n-1`
  // while `archiveEvent` reads `days/{d.index}/meta/{d.index}`, which is the same
  // fan only while the schedule is contiguous from zero — a property the setup
  // wizard enforces on a DRAFT and nothing enforces on a stored Event. On one
  // where they disagree the console confirmed a Day that does not exist, showed
  // the roster-derived honour (or none), and the freeze then froze the real pin:
  // a different record from the one the Admin approved, permanently.
  it('subscribes to the schedule’s own Day indexes, and previews the pin it finds there', async () => {
    H.event = mkEvent({ days: [mkDay(4)] });
    H.dayMetas = new Map<number, DayMetaDoc>([
      [4, { firstBingo: { uid: 'alice', displayName: 'Alice', at: 1_200 } }],
    ]);
    renderConsole();
    // The Day the schedule actually names — never `days/0`, which this Event has
    // no entry for at all.
    expect(H.useDayMetasStatus).toHaveBeenCalledWith([4]);
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    // One honour, and it is the PINNED one: the roster's own Day-4 evidence
    // would derive nothing here, so a fan pointed at `days/0` previews none.
    expect(screen.getByText(/Freezing 2 players and 1 daily honor\b/)).toBeInTheDocument();
    expect(screen.queryByText(/unreadable daily honor/)).not.toBeInTheDocument();
  });

  // #1151, Codex P2 on PR #1162. A Day honour pinned by an Admin — or by the
  // Admin SDK — can carry a `uid` the Day-meta rules arm never type-checked, and
  // the record cannot express it. The builder discards that pin and leaves the
  // Day with NO honour rather than handing it to the roster's runner-up, so the
  // strip the Admin approves is one honour shorter than the live one: the count
  // is what stops that being a discovery made after an irreversible write.
  it('states a daily honour the record cannot carry, beside the unreadable rows', async () => {
    H.event = mkEvent({ days: [mkDay(0), mkDay(1)] });
    H.dayMetas = new Map([
      [0, { firstBingo: { uid: 'alice', displayName: 'Alice', at: 1_200 } }],
      // The shape the admin branch admits: `uid` is not a string at all.
      [1, { firstBingo: { uid: 42, displayName: 'Nobody', at: 1_300 } }],
    ] as unknown as Iterable<[number, DayMetaDoc]>);
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(screen.getByText(/Freezing 2 players and 1 daily honor\b/)).toBeInTheDocument();
    expect(
      screen.getByText(/1 unreadable daily honor will not be included\./),
    ).toBeInTheDocument();
    // The control beside it: an Event whose pins are all usable says nothing.
    expect(screen.queryByText(/unreadable row/)).not.toBeInTheDocument();
  });

  // Codex P1, PR #1139. The flip reads ONE document and writes ONE document, so
  // it cannot serialize against a Board write or a Claim create in another
  // collection. The quiesce is what closes that: gameplay is shut server-side
  // FIRST, and only then is the record taken.
  it('shuts gameplay before it takes the record, never the other way round', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    // The flip is handed the generation the shut left in force, and the Event
    // the shut actually landed on (#1142 item 7) — never a roster the console
    // happened to be watching, which `archiveEvent` re-reads for itself.
    expect(H.archiveEvent).toHaveBeenCalledWith(1, {
      eventId: 'test-event',
      beforeFinale: false,
    });
  });

  it('takes no record at all when the Event cannot be shut', async () => {
    H.beginArchive.mockResolvedValue({
      result: 'no-event',
      token: null,
      created: false,
      eventId: 'test-event',
    });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin']));
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('No Event document to close.');
  });

  it('backs out cleanly when the Admin cancels', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Confirm archive' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeInTheDocument();
  });

  it('finishes an already-closing archive without shutting the Event a second time', async () => {
    // `beginArchive` is idempotent, so the closing-state surface JOINS the
    // quiesce in force rather than opening a new generation — which is what
    // gives the flip a token to be bound to.
    H.beginArchive.mockResolvedValue({
      result: 'closing',
      token: 4,
      created: false,
      eventId: 'test-event',
    });
    H.event = mkEvent({ archiving: true, archiveToken: 4 });
    renderConsole();
    expect(screen.queryByRole('button', { name: 'Archive…' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Freeze the record now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    expect(H.archiveEvent).toHaveBeenCalledWith(4, {
      eventId: 'test-event',
      beforeFinale: false,
    });
  });
});

// Codex P2, PR #1139. Resolving a Claim writes the claimant's Board and Player
// row, and the freeze denies both — so a Claim still pending at the moment of the
// flip is pending FOREVER, behind a Confirm/Reject pair that can now only fail.
describe('ArchiveEvent — the pending-claim drain gate (#1151)', () => {
  it('refuses to arm while a pending claim is in the Review queue', async () => {
    H.event = mkEvent({ claimMode: 'admin_confirmed' } as Partial<EventDoc>);
    H.pendingClaims = [mkClaim()];
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Resolve the 1 pending claim in the Review queue first/,
    );
    // Closing play is still available — it is the reversible half, and shutting
    // the Event is not what strands a Claim; freezing it is.
    expect(screen.getByRole('button', { name: 'Close play' })).toBeEnabled();
  });

  it('says so in the plural, and holds the CLOSING-state freeze shut too', () => {
    // The gate outlives the quiesce: a Claim resolution writes a Board, which is
    // denied from the moment gameplay shuts — so the only way to clear it is to
    // reopen play first, and the copy has to name that.
    H.event = mkEvent({
      archiving: true,
      archiveToken: 1,
      claimMode: 'admin_confirmed',
    } as Partial<EventDoc>);
    H.pendingClaims = [mkClaim(), mkClaim({ id: 'claim-2' })];
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Resolve the 2 pending claims/);
    expect(screen.getByRole('status')).toHaveTextContent(
      /Reopen play to drain the queue, then archive again\./,
    );
  });

  it('does not treat a not-yet-loaded claim queue as drained', () => {
    // A subscription reports only what it has DELIVERED, so an empty-and-unloaded
    // queue is indistinguishable from an empty one — and a gate that passes
    // vacuously is no gate at all.
    H.event = mkEvent({ claimMode: 'admin_confirmed' } as Partial<EventDoc>);
    H.pendingClaimsLoaded = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('ignores a stale claim outside admin-confirmed mode, which has no drain path', () => {
    // #269's mode gate, unchanged: outside `admin_confirmed` the Review queue
    // offers no Confirm/Reject, so blocking here would be a dead end rather than
    // a gate.
    H.event = mkEvent({ claimMode: 'honor' } as Partial<EventDoc>);
    H.pendingClaims = [mkClaim()];
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeEnabled();
  });

  it('reopens play when a Claim commits between the tap and the close', async () => {
    // The console's gate reads a passive listener; `archiveEvent` re-takes it
    // from the SERVER after the close. When that re-read refuses, this handler
    // shut the Event, so this handler puts it back.
    H.archiveEvent.mockResolvedValue('claims-pending');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    // CONDITIONAL on the generation this handler opened (Codex P2, PR #1139) and
    // on the Event it opened it on (#1142 item 7).
    expect(H.abandonArchive).toHaveBeenCalledWith(1, 'test-event');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'A claim arrived as play was closing, so nothing was frozen. Resolve the Review queue, then archive again.',
    );
  });

  it('keeps the explanation on the OPEN controls after its own automatic reopen', async () => {
    // Codex P2 on PR #1162. Every refusal was classified as describing a CLOSING
    // Event, but an open-phase archive reopens for all four of them when it
    // created the quiesce — so the Event ends up OPEN and the message was
    // discarded twice over: the handler's own reopen moved the phase away from
    // `closing`, and the phase having moved at all during the action disqualified
    // the still-where-it-started fallback. The Admin was left looking at reopened
    // controls with no explanation of why nothing was frozen.
    let settle: (value: unknown) => void = () => {};
    H.archiveEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    void userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    // The subscription delivers what this handler's OWN writes produced: the
    // quiesce it took…
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    settle('claims-pending');
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledWith(1, 'test-event'));
    // …and then the reopen it performed when the freeze refused.
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'A claim arrived as play was closing, so nothing was frozen. Resolve the Review queue, then archive again.',
    );
    // Against the controls the Admin is actually looking at.
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('still clears it when someone ELSE moves the Event after that reopen', async () => {
    // The reopen settles where the message belongs; it does not exempt it from
    // the staleness rule. Another Admin archiving afterwards makes "archive
    // again" false, so it goes.
    H.archiveEvent.mockResolvedValue('config-changed');
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    await screen.findByRole('status');
    view.rerender(
      <ArchiveEvent {...props(mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 }))} />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('leaves a quiesce it only JOINED closed, and says why', async () => {
    // #1142 item 6. `beginArchive` is idempotent, so a call that joined another
    // Admin's in-flight quiesce comes back holding a token that matches
    // perfectly — and a reopen keyed on the token alone would succeed at exactly
    // the write the binding exists to refuse.
    H.beginArchive.mockResolvedValue({
      result: 'closing',
      token: 4,
      created: false,
      eventId: 'test-event',
    });
    H.archiveEvent.mockResolvedValue('too-large');
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    expect(H.abandonArchive).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/Play was left closed/);
    // …and because no reopen was attempted, the explanation is a sentence about
    // a CLOSING Event and stays with the controls that describe one (Codex P2 on
    // PR #1162): the quiesce belongs to whoever opened it, and this Admin's way
    // out is **Reopen play** beside the message.
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 4 }))} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Play was left closed/);
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeInTheDocument();
  });

  it('does not reopen the token a NEWER freeze is committing against', async () => {
    // Codex P2 on PR #1165. The liveness check guarded only what a superseded
    // action REPORTED, leaving the automatic reopen — a write — unconditional.
    // While the first Archive is still reading the snapshot, its own closing
    // state puts **Freeze the record** on screen and the Admin starts a newer
    // freeze against the same token; the first action's refusal would then clear
    // exactly the quiesce that newer freeze is committing against, failing it
    // with `not-closing`. Neither the token nor the `created` guard can see it:
    // the generation matches, and this handler really did create it.
    let settleFirst: (value: unknown) => void = () => {};
    let settleSecond: (value: unknown) => void = () => {};
    H.archiveEvent
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleSecond = resolve;
          }),
      );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    void userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));

    // The quiesce this action took lands, and the Admin presses the control it
    // put on screen — a second action over the first.
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    void userEvent.click(screen.getByRole('button', { name: 'Freeze the record now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(2));

    // …and only now does the superseded Archive refuse.
    settleFirst('config-changed');
    settleSecond('archived');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Archived. The final standings are frozen.',
    );
    expect(H.abandonArchive).not.toHaveBeenCalled();
    expect(H.writes).toEqual(['begin', 'archive', 'begin', 'archive']);
  });

  it('still reopens for the action that is CURRENT — the control', async () => {
    // The same shape without the supersession, so the assertion above is about
    // the liveness check rather than about a refusal that never reopens.
    let settle: (value: unknown) => void = () => {};
    H.archiveEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    void userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    settle('config-changed');
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledWith(1, 'test-event'));
  });

  it('shuts the closing controls while the automatic reopen is in flight, and gives them back', async () => {
    // Codex P2 on PR #1165, round 5. Skipping the cleanup for a SUPERSEDED
    // invocation closes the interval before the reopen is issued; it cannot
    // touch the one after. The liveness check passes, `abandonArchive` goes out,
    // and the closing surface this action's own quiesce put on screen is still
    // offering **Freeze the record** — so a newer freeze can be started against
    // the generation this handler is a round trip away from lifting, and a
    // sequence number cannot recall a write already issued. The surface stops
    // offering the race for as long as it lasts, and says which write it is
    // waiting on.
    let settleReopen: (value: unknown) => void = () => {};
    H.archiveEvent.mockResolvedValueOnce('config-changed');
    H.abandonArchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleReopen = resolve;
        }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    void userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    // The closing snapshot this action's own quiesce produced — the surface the
    // Admin is looking at while the reopen is outstanding.
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeDisabled();
    expect(screen.getByText(/until that write settles/)).toBeInTheDocument();

    // …and the moment it settles they are the Admin's again. `quiesce-changed`
    // rather than `reopened` so the Event stays CLOSING and the same two
    // controls are still the ones on screen to assert against.
    settleReopen('quiesce-changed');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeEnabled(),
    );
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
    expect(screen.queryByText(/until that write settles/)).not.toBeInTheDocument();
  });

  it('shuts Close play and the armed confirm row too, for the surface a concurrent reopen swaps in', async () => {
    // The same window, reached from the other side (Codex P2 on PR #1165, round
    // 5). Another Admin lifting the quiesce while this cleanup is outstanding
    // puts the OPEN surface back — with the confirm row still armed, because
    // disarming is held to the same liveness check — so **Close play** and
    // **Archive now** are inside the window as well, and a quiesce taken by
    // either is one the in-flight reopen is about to lift.
    let settleReopen: (value: unknown) => void = () => {};
    H.archiveEvent.mockResolvedValueOnce('config-changed');
    H.abandonArchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleReopen = resolve;
        }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    void userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close play' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Archive the Event now' })).toBeDisabled();

    // Settling gives **Close play** back; the confirm row goes with the action
    // that armed it, which disarms itself on the way out.
    settleReopen('quiesce-changed');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close play' })).toBeEnabled());
    expect(screen.queryByText(/until that write settles/)).not.toBeInTheDocument();
  });

  it('leaves the Event shut when the quiesce it read was taken over by another', async () => {
    // `quiesce-changed` is deliberately outside the reopen set: the closing state
    // now in force is a DIFFERENT one, so clearing it would reopen an Event
    // underneath somebody else's in-flight freeze.
    H.archiveEvent.mockResolvedValue('quiesce-changed');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    expect(H.abandonArchive).not.toHaveBeenCalled();
  });

  it('says so when the settings moved underneath the record, and reopens play', async () => {
    H.archiveEvent.mockResolvedValue('config-changed');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /The Event settings changed while the record was being taken/,
    );
  });

  // Codex P2 on PR #1162. The fingerprint is taken after play has closed and
  // outside every `archiveRead` wrapper, so an Event document the canonicaliser
  // cannot walk used to throw out of `archiveEvent` entirely — past this
  // handler's cleanup, leaving a live Event shut with the generic `AsyncButton`
  // failure pill and no way back. As a typed refusal it takes the same route as
  // every other refusal that wrote nothing: stated, and play put back.
  it('reopens play when the Event could not be FINGERPRINTED, and says nothing was frozen', async () => {
    H.archiveEvent.mockResolvedValue('config-unreadable');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /could not be read closely enough to tell whether they changed.*nothing was frozen/,
    );
    // Play is back, so the Admin is looking at an OPEN Event's controls.
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });
});

describe('ArchiveEvent — the archive waits for its inputs to be server-confirmed', () => {
  // Codex P1: the write is permanent behind write-once rules. Until the server
  // has spoken, an empty roster and an unpinned Day are indistinguishable from a
  // cold ADR 0006 cache, and archiving on one would freeze empty standings and
  // missing honours forever.
  it('disables the control while the roster is still cache-only', () => {
    H.rosterSeen = false;
    H.rosterFromCache = true;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('disables the control while a Day-meta subscription is unconfirmed', () => {
    H.dayMetasServerConfirmed = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
  });

  it('disables the control while the Event document itself has not arrived', () => {
    H.event = null;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
  });

  // Codex P2 on PR #1162. A present Event is what the ADR 0006 persistent cache
  // delivers; it is not what the server said. The roster and the Day-meta
  // listeners latch INDEPENDENTLY, so both can confirm while the Event is still
  // the cached copy — and the schedule, name and ban list the preview is built
  // from are then whatever that cache held, on a write that cannot be undone.
  it('does NOT arm on a cached-only Event, however confirmed the other inputs are', () => {
    H.eventConfirmed = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('holds the CLOSING-state freeze shut on a cached-only Event too', () => {
    // The other surface that reaches the flip. An Admin who has already used
    // Close play cannot get back to the confirm row, so the gate has to hold
    // here on its own terms.
    H.eventConfirmed = false;
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
  });

  it('enables it once the Event, the roster and every Day-meta subscription are confirmed', () => {
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // Codex P2 on PR #1162. A day-meta listener that dies before any server
  // snapshot can never be confirmed, so "loading" would be a message that never
  // resolves — and the preview beside it is showing the roster-DERIVED honour,
  // or none, where the freeze's own server re-read may find the PINNED holder
  // and keep them instead.
  it('says the honours could not be READ when a Day subscription failed, not "loading"', () => {
    H.dayMetasFailed = true;
    H.dayMetasServerConfirmed = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      /The daily honours could not be read from the server/,
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(/Loading the final standings/);
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing has been closed\./);
  });

  it('holds the CLOSING-state freeze shut on unreadable honours, and says nothing was frozen', () => {
    H.dayMetasFailed = true;
    H.dayMetasServerConfirmed = false;
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      /The daily honours could not be read from the server.*Play is already closed—nothing has been frozen\./,
    );
  });

  // CodeRabbit, PR #1162. `failed` is not the complement of the confirmation: a
  // Day the server answered before its listener died stays confirmed, and
  // nothing clears it. So `failed` alone printed a TERMINAL "reload the console"
  // message beside an ENABLED control, sending the Admin after a problem that
  // was not standing in their way.
  it('says nothing about unreadable honours while every Day is still confirmed', () => {
    H.dayMetasFailed = true;
    H.dayMetasServerConfirmed = true;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // Codex P2 on PR #1162. `archiveEvent` refuses a stored schedule that names one
  // Day twice, exactly as it refuses one carrying an index it cannot address —
  // but the honour fan NORMALISES both away so it can still complete, so every
  // latch went true and this control armed. The Admin then closed play, the flip
  // refused, and the handler reopened it: a round trip through a shut Event for a
  // defect that was on screen the whole time.
  it('does NOT arm over a schedule the freeze would refuse, and names the repair', () => {
    H.event = mkEvent({ days: [mkDay(0), mkDay(1), mkDay(1)] });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/the same day is listed twice/);
    // The repair is the one the flip's own refusal names, at the surface the
    // Admin is already looking at — and it is stated INSTEAD of the loading
    // sentence, because nothing here is still arriving.
    expect(screen.getByRole('status')).toHaveTextContent(/Fix or re-save that day/);
    expect(screen.getByRole('status')).not.toHaveTextContent(/Loading the final standings/);
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing has been closed\./);
  });

  it('holds the CLOSING-state freeze shut on an unusable schedule too', () => {
    // The other surface that reaches the flip: an Admin who has already used
    // Close play cannot get back to the confirm row, so this gate has to hold
    // here on its own terms — and Reopen play is the way out.
    H.event = mkEvent({ archiving: true, archiveToken: 1, days: [mkDay(2), mkDay(2)] });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      /the same day is listed twice.*Play is already closed—nothing has been frozen\./,
    );
  });

  it('does NOT arm over a Day index outside the supported range', () => {
    // Codex P2 on PR #1162, round 7. `-1` and `MAX_DAYS` pass the integer test
    // the gate used to ask, and each addresses a REAL meta path — so the console
    // armed, the Admin closed play, and the freeze then refused a schedule that
    // was on screen the whole time. Same predicate on both sides now, so the
    // control is shut on exactly the schedules `archiveEvent` turns down.
    for (const index of [-1, MAX_DAYS, Number.MAX_SAFE_INTEGER + 2]) {
      H.event = mkEvent({ days: [mkDay(0), mkDay(1, { index })] });
      const { unmount } = renderConsole();
      expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
      expect(screen.getByRole('status')).toHaveTextContent(
        /is not a day this Event can have/,
      );
      expect(screen.getByRole('status')).toHaveTextContent(/Fix or re-save that day/);
      unmount();
    }
  });

  it('arms over a UNIQUE non-contiguous schedule — the control', () => {
    // The reason every day-scoped path keys on `DayDef.index`: a one-Day Event at
    // index 4 is a schedule the freeze reads correctly, not a broken one, and
    // this gate must not confuse the two.
    H.event = mkEvent({ days: [mkDay(4)] });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // Codex P2 on PR #1162. `hasServerData` and `serverLoaded` are LATCHES: they
  // say the server HAS spoken, never that this is what it says. They never
  // clear, so a console that confirmed its inputs and then went offline armed
  // Archive over a preview the persistent cache re-served — and the record the
  // freeze takes is permanent.
  it('disarms when a CONFIRMED roster starts coming back from the cache', () => {
    H.rosterSeen = true; // the latch holds — the server did answer, once
    H.rosterFromCache = true; // …and this is not that answer
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('disarms while a local roster write is still pending', () => {
    // Emitted server-backed but UNDECIDED, exactly as an Admin's own optimistic
    // `archiving: true` is on the Event document — and a refusal rolls it back.
    H.rosterSeen = true;
    H.rosterFromCache = false;
    H.rosterPending = true;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('holds the CLOSING-state freeze shut on a cache-served roster too', () => {
    // The other surface that reaches the flip, which an Admin who has already
    // used Close play cannot get back from.
    H.rosterSeen = true;
    H.rosterFromCache = true;
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
  });

  it('disarms when a CONFIRMED Day fan starts coming back from the cache', () => {
    // The Day-meta half of the same claim: the honour the preview shows has to
    // be the one the server is answering with now, because `archiveEvent`'s own
    // re-read may recover a PINNED holder the cached view never had.
    H.dayMetasServerConfirmed = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });
});

describe('ArchiveEvent — a record it could not store is refused before anything is shut', () => {
  // `players/{uid}` validates none of its fields, so a Player can leave a row the
  // record cannot carry. The builder coerces and skips what it can and REFUSES
  // what it cannot — and that refusal has to be read BEFORE the first write, or
  // every attempt closes play and then fails on the second one.
  const whale = () =>
    mkPlayer('whale', {
      dayStats: Object.fromEntries(
        Array.from({ length: 6_000 }, (_, i) => [
          i,
          { bingoCount: 1, squaresMarked: 1, firstBingoAt: 1_000 + i },
        ]),
      ),
    } as Partial<PlayerDoc>);

  /** An Event whose OWN retained fields have already spent the document budget —
   *  the reachable route to the ceiling, and since round 7 the only one (Codex P2
   *  on PR #1162). The record's own quarter cannot be filled by any roster the
   *  builder will carry: 200 bounded rows plus at most one honour per supported
   *  Day is ~74 KiB against a 256 KiB share, which `src/data/post-sailing-archive.test.ts`
   *  measures directly. */
  const bloatedEvent = (over: Partial<EventDoc> = {}) =>
    mkEvent({
      bannedUids: Array.from({ length: 25_000 }, (_, i) => `banned-uid-${i}`.padEnd(40, 'x')),
      ...over,
    } as Partial<EventDoc>);

  it('will not arm, and says so before anything is closed', () => {
    H.event = bloatedEvent();
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/too large to freeze onto the Event/);
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing has been closed\./);
  });

  // Codex P2 on PR #1162. The copy used to blame extra text on a Player row and
  // recommend banning that Player. The archive copies six SELECTED fields per
  // row, clips every name at 100 characters and pins each uid to a bounded
  // document id, so unrelated Player text contributes nothing — and banning is
  // the one remedy that can make the DOCUMENT bigger, because `bannedUids` is
  // stored on the very Event the record has to fit beside.
  it('names the levers that actually move the size, and does not recommend a ban', () => {
    H.event = bloatedEvent();
    renderConsole();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(
      /The record itself is bounded: 200 standings rows, at most one honour for each day the Event can have, and names clipped at 100 characters/,
    );
    expect(status).toHaveTextContent(
      /the Day schedule with each Day’s frozen Prompt list, the ban list, and the Most-Loved award/,
    );
    expect(status).toHaveTextContent(/Banning a Player does not/);
    expect(status).not.toHaveTextContent(/far more text than a name/);
    expect(status).not.toHaveTextContent(/ban that Player/);
  });

  it('ARMS over a roster naming thousands of Days — the record ceiling is not that lever', () => {
    // Codex P2 on PR #1162, round 7. This roster's `dayStats` mention 6,000 Day
    // indexes, and with no schedule on the Event the honours used to fall back to
    // one derived honour per index — which put the RECORD over its own quarter of
    // the budget, and made banning the one remedy the copy said would not help.
    // The supported-range filter closes that at the source: at most one honour
    // per Day the `DayDef` contract has, so a single Player can no longer move
    // the record's own size at all and the console arms exactly as it would over
    // an ordinary roster.
    H.event = mkEvent({ days: [] } as Partial<EventDoc>);
    H.players = [whale()];
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says WHICH ceiling refused it — the Event document, on an ordinary record', () => {
    // The reachable ceiling, and since round 7 the only one: two ordinary
    // Players, a record of a few hundred bytes, and an Event whose own retained
    // ban list has already spent the document's budget. Naming the record here
    // would send the Admin after the wrong thing entirely.
    H.event = bloatedEvent();
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/too large to freeze onto the Event/);
    expect(status).toHaveTextContent(
      /The record fits its own share; it is the Event document that has no room left for it\./,
    );
  });

  it('holds the closing-state freeze shut too, and says nothing was frozen', () => {
    H.event = bloatedEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Play is already closed—nothing has been frozen\./,
    );
    // …and never the ban the old copy sent an Admin after from here.
    expect(screen.getByRole('status')).not.toHaveTextContent(/ban that Player/);
  });

  it('reopens play when the record’s SHAPE is refused, and says so in its own words', async () => {
    // #1151, Codex P1 on PR #1162. The third precondition now has two refusals
    // behind it, and they send an Admin after entirely different things: the
    // ceiling names the Event data to trim, while a record the BOUNDARY would
    // refuse has nothing to trim at all. Folding them into one sentence would
    // give whichever fired the other one's advice.
    H.archiveEvent.mockResolvedValue('record-unwritable');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    // The same automatic cleanup the other flip refusals get, so a live Event is
    // never left shut over one.
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/did not produce a record the Event will accept/);
    expect(status).not.toHaveTextContent(/too large to freeze onto the Event/);
  });

  it('reopens play when the stored SCHEDULE has an unusable Day, and names the repair', async () => {
    // Codex P2 on PR #1162. `eventConverter` tolerates a `null` Day entry, so
    // this console arms over such an Event — and the freeze's own RAW read is
    // where it stops being tolerable. The refusal is what makes that a cleanup
    // the handler can perform rather than a throw that skips it, and its copy is
    // the one here with a repair the Admin can make from the surface this
    // control already sits at the bottom of.
    H.archiveEvent.mockResolvedValue('schedule-unusable');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    expect(H.abandonArchive).toHaveBeenCalledWith(1, 'test-event');
    // …and it names WHY the day is unusable (Codex P2 on PR #1162, round 7):
    // "could not be read" was false of `-1` and `${MAX_DAYS}`, which read
    // perfectly well and simply are not days this Event can have.
    expect(await screen.findByRole('status')).toHaveTextContent(
      `One of the days in the schedule above is not a day this Event can have—its number is missing, or outside the ${MAX_DAYS} a schedule holds—or the same day is listed twice, so the daily honours could not be looked up one per day and nothing was frozen. Fix or re-save that day, then archive again.`,
    );
  });

  it('still renders Game settings when a Player row is unreadable to the selectors', () => {
    // #1142 item 10 and #1145: the draft is built during RENDER, so a row that
    // threw out of the builder took the whole surface — and the Reopen play
    // control with it — down on an Event that may already be shut. The ROOT stat
    // is the other half of the same row, and it is pinned at the crash site in
    // `src/hooks/useData.test.ts` § "useLeaderboard makes the roster READABLE
    // before it ranks it", because the throw was inside the hook's own sort,
    // upstream of everything this console does.
    H.players = [
      { ...mkPlayer('broken'), dayStats: { 1: null } } as unknown as PlayerDoc,
      { ...mkPlayer('nameless'), uid: undefined } as unknown as PlayerDoc,
      { ...mkPlayer('unreadable'), bingoCount: { toString: null } } as unknown as PlayerDoc,
    ];
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeEnabled();
  });
});

// #1151, routed here from #1150's review. The quiesce only DELAYS the finale
// beats; the flip forgoes them for good, and nothing else would say so.
describe('ArchiveEvent — the pre-finale acknowledgement (#1151)', () => {
  const preFinale = (over: Partial<EventDoc> = {}) =>
    ({
      name: 'Test Event',
      status: 'active',
      standingsFreezeAt: 8_000,
      ...over,
    }) as EventDoc;

  it('will not archive before the scheduled freeze without an explicit acknowledgement', async () => {
    H.event = preFinale();
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    const confirm = screen.getByRole('button', { name: 'Archive the Event now' });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText(/the podium, the Most-Loved award and the freeze stamp will never arrive/))
      .toBeInTheDocument();
    expect(H.archiveEvent).not.toHaveBeenCalled();
  });

  it('archives once the Admin ticks it, and tells the writer they did', async () => {
    H.event = preFinale();
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    expect(H.archiveEvent).toHaveBeenCalledWith(1, {
      eventId: 'test-event',
      beforeFinale: true,
    });
  });

  it('asks nothing once the finale has run — the control', async () => {
    H.event = mkEvent({ frozenAt: 8_000, finaleCompletedAt: 8_100 });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive the Event now' })).toBeEnabled();
  });

  it('still asks when the freeze is stamped but the podium has not landed', async () => {
    // #1151, Codex P1 on PR #1162. `frozenAt` records the freeze transaction and
    // nothing else; the podium is a separate best-effort beat with its own retry
    // guard, so this is a real state an Event sits in — and the flip would forgo
    // that podium permanently, because a closed Event's finale is never retried.
    H.event = preFinale({ frozenAt: 8_000 });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive the Event now' })).toBeDisabled();
  });

  it('offers the same acknowledgement on the CLOSING surface, and archives once it is given', async () => {
    // Codex P2 on PR #1162. `ready` gates **Freeze the record** exactly as it
    // gates the confirm row, but the box was rendered only in the confirm row —
    // a surface an Admin who has already used Close play cannot reach. So the
    // button was permanently disabled and the only way forward was to reopen
    // gameplay on an Event they had deliberately shut, purely to tick a box.
    H.event = preFinale({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Freeze the record now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    expect(H.archiveEvent).toHaveBeenCalledWith(1, {
      eventId: 'test-event',
      beforeFinale: true,
    });
  });

  it('asks nothing on the closing surface once the marker is stamped — the control', () => {
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeEnabled();
  });

  it('asks nothing on an Event with no scheduled finale at all', async () => {
    // A legacy Event with no ceremonial Day and no stored freeze never freezes
    // on its own, so gating on one would ask the Admin to wait forever.
    H.event = { name: 'Test Event', status: 'active' } as EventDoc;
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive the Event now' })).toBeEnabled();
  });

  it('reopens play and names the finale when the writer refuses it anyway', async () => {
    // The server-side half: the finale can land — or fail to — between the
    // console's read and the commit, and the writer decides on the state the
    // flip actually meets.
    H.archiveEvent.mockResolvedValue('finale-pending');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /The scheduled standings freeze has not run yet/,
    );
  });
});

// CodeRabbit Major on PR #1162. The writer's server reads are taken after the
// quiesce, so one that does not answer used to throw straight out of
// `archiveEvent`: `runArchive` never saw a result, the automatic reopen never
// ran, and the Admin got "Freeze failed—try again." over an Event this handler
// had just shut and would now never put back.
describe('ArchiveEvent — a read that did not answer (#1162)', () => {
  it('reopens play, and says WHICH read did not answer', async () => {
    H.archiveEvent.mockResolvedValue('read-failed:roster');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    // The same cleanup the four stated refusals get, conditional on the
    // generation this handler opened and the Event it opened it on.
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    expect(H.abandonArchive).toHaveBeenCalledWith(1, 'test-event');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'The final standings could not be read back from the server after play closed, so nothing was frozen. Check the connection and archive again.',
    );
  });

  it('names each of the four reads in the Admin’s own vocabulary', async () => {
    // One sentence per read, so an Admin can tell a connection problem on the
    // roster from a Review queue they have lost access to.
    const subjects = [
      ['read-failed:event', 'The Event'],
      ['read-failed:claims', 'The Review queue'],
      ['read-failed:roster', 'The final standings'],
      ['read-failed:day-meta', 'The daily honours'],
    ] as const;
    for (const [outcome, subject] of subjects) {
      H.archiveEvent.mockResolvedValue(outcome);
      const view = renderConsole();
      await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
      await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
      expect(await screen.findByRole('status')).toHaveTextContent(
        `${subject} could not be read back from the server after play closed`,
      );
      view.unmount();
    }
  });

  it('keeps the explanation on the OPEN controls its own reopen produced', async () => {
    // The refusal describes where the Event ENDS UP, and the handler's reopen is
    // what put it there — the same `settledAt` path the four stated refusals take
    // (Codex P2 on PR #1162), so the message survives the phase move it caused.
    H.archiveEvent.mockResolvedValue('read-failed:claims');
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    expect(await screen.findByRole('status')).toHaveTextContent(/The Review queue could not be/);
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('leaves a quiesce it only JOINED closed, exactly as the stated refusals do', async () => {
    // #1142 item 6 applies unchanged: a handler that merely joined another
    // Admin's in-flight quiesce holds a matching token, and reopening on it would
    // clear a closing state it never took.
    H.beginArchive.mockResolvedValue({
      result: 'closing',
      token: 7,
      created: false,
      eventId: 'test-event',
    });
    H.archiveEvent.mockResolvedValue('read-failed:day-meta');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    expect(H.abandonArchive).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/Play was left closed/);
  });

  it('does NOT reopen from the closing surface, which never shut the Event', async () => {
    // **Freeze the record** is pressed on an Event that was already closed when
    // the Admin arrived, and **Reopen play** sits beside it — so the message is a
    // sentence about a CLOSING Event and stays with the controls that describe one.
    H.beginArchive.mockResolvedValue({
      result: 'closing',
      token: 4,
      created: false,
      eventId: 'test-event',
    });
    H.archiveEvent.mockResolvedValue('read-failed:event');
    H.event = mkEvent({ archiving: true, archiveToken: 4 });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Freeze the record now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    expect(H.abandonArchive).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/The Event could not be read back/);
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeInTheDocument();
  });
});

describe('ArchiveEvent — a superseded action keeps its hands off the surface (#1165)', () => {
  it('does not close the confirmation panel from a SUPERSEDED action', async () => {
    // CodeRabbit on PR #1165. Disarming is the invocation's own housekeeping, and
    // it ran unconditionally: an Admin who reopened play while an Archive was in
    // flight got the open controls back with the confirm row still armed, ready
    // for a second attempt — and the superseded action then closed it under them.
    let settleFirst: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve;
        }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    void userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));

    // The quiesce lands, the Admin reopens play — a second action over the first…
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reopen play' }));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    // …and the open controls come back with the confirm row still on screen.
    expect(screen.getByRole('group', { name: 'Confirm archive' })).toBeInTheDocument();

    settleFirst({ result: 'closing', token: 1, created: true, eventId: 'test-event' });
    await waitFor(() => expect(H.writes).toEqual(['begin', 'abandon', 'archive']));
    await act(async () => {});
    expect(screen.getByRole('group', { name: 'Confirm archive' })).toBeInTheDocument();
  });

  it('still closes it for the action that is CURRENT — the control', async () => {
    // The same flush, the opposite outcome: if the wait above were too short to
    // let the superseded continuation run, this would not close the row either.
    let settle: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    void userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));

    settle({ result: 'closing', token: 1, created: true, eventId: 'test-event' });
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    await act(async () => {});
    expect(screen.queryByRole('group', { name: 'Confirm archive' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeInTheDocument();
  });

  it('keeps a pending action’s status when a render for another phase never commits', async () => {
    // CodeRabbit on PR #1165, the render-purity half. `phaseRef`/`phaseSeqRef`
    // were written DURING render, so a pass React threw away left them naming a
    // phase the Event never reached and counting a move that never happened —
    // and the pending Close then failed BOTH of `report`'s tests and lost a
    // status that was true. The discarded pass here is a real one: a transition
    // renders `ArchiveEvent` with an ARCHIVED Event and then suspends on the
    // sibling beside it, so React keeps the committed OPEN tree and commits
    // nothing from that pass.
    const neverSettles = new Promise<void>(() => {});
    function Suspender({ suspend }: { suspend: boolean }) {
      if (suspend) throw neverSettles;
      return null;
    }
    let move: (next: { event: EventDoc; suspend: boolean }) => void = () => {};
    function Harness() {
      const [state, setState] = useState(() => ({ event: mkEvent(), suspend: false }));
      move = setState;
      return (
        <Suspense fallback={<p>loading</p>}>
          <ArchiveEvent {...props(state.event)} />
          <Suspender suspend={state.suspend} />
        </Suspense>
      );
    }

    let settle: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    render(<Harness />);
    void userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));

    await act(async () => {
      startTransition(() => {
        move({
          event: mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 }),
          suspend: true,
        });
      });
    });
    // Nothing from that pass reached the DOM: the Event is still open.
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();

    // So the Close resolved on an Event that never moved, and its message holds.
    settle({ result: 'closing', token: 1, created: true, eventId: 'test-event' });
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
  });
});

// ---------------------------------------------------------------------------
// The archived presentation (#1152)
// ---------------------------------------------------------------------------

/** An Event still open for play, carrying no record. */
const liveEvent = (over: Partial<EventDoc> = {}): EventDoc =>
  archivedEvent({ status: 'active', archivedAt: undefined, archive: undefined, ...over });

/** The names in the rendered standings list, scoped to the mount: the frozen
 *  names also appear in the hall of fame and in the offscreen Share Card host the
 *  archived surface rasterizes into `document.body`. */
const frozenNames = (container: HTMLElement): (string | null | undefined)[] =>
  [...container.querySelectorAll('.list .row .name')].map((n) => n.textContent);

describe('the archived Leaderboard renders the frozen record (#1152)', () => {
  beforeEach(() => {
    H.players = liveRoster;
    H.event = archivedEvent();
  });

  it('shows the frozen standings, not the live roster', () => {
    const { container } = renderLeaderboard();
    // Early Bird is rank 1 in the record even though the live roster ranks Late
    // Riser first — and Late Riser, who is on the live roster but not in the
    // record, does not appear at all.
    expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
    expect(screen.queryByText('Late Riser')).not.toBeInTheDocument();
    expect(screen.getByText(/3 bingos · 18 squares · BLACKOUT/)).toBeInTheDocument();
  });

  it('announces the archive and pins the hall of fame', () => {
    const { container } = renderLeaderboard();
    const banner = container.querySelector('.lb-archived-banner');
    expect(banner).toHaveTextContent('Final standings');
    expect(banner).toHaveTextContent(/is archived/i);
    const hall = screen.getByLabelText('Hall of fame');
    expect(hall).toHaveTextContent(/First to BINGO/);
    expect(hall).toHaveTextContent(/Early Bird · /);
    // The frozen daily honours render as their own chips, under the LABEL the
    // record carries — theme emoji and all.
    expect(hall).toHaveTextContent('🌈 D1');
    expect(hall).toHaveTextContent('🏋️ D2');
    // The badge on the standings row names the same holder.
    expect(container.querySelector('.list .row.leader .name')).toHaveTextContent('Early Bird');
  });

  // Codex P2, PR #1139 round 4. The strip used to resolve each Day's theme emoji
  // out of the LIVE `EventDoc.days`, which the freeze deliberately leaves editable
  // (the write-once clause covers `status`/`archivedAt`/`archivedUnder`/`archive`
  // and nothing else) — so an Admin re-theming a Day after the archive changed a
  // frozen honour's chip. The label is stored on the honour instead.
  it('keeps a frozen honour chip when the live Day theme is edited afterwards', () => {
    // The live schedule now says Day 1 is Get Sporty and Day 2 is Neon
    // Playground — the exact swap of the labels the record froze.
    H.event = archivedEvent({
      days: [
        { index: 0, theme: 'get-sporty' },
        { index: 1, theme: 'neon-playground' },
      ],
    } as unknown as Partial<EventDoc>);
    renderLeaderboard();
    const hall = screen.getByLabelText('Hall of fame');
    expect(hall).toHaveTextContent('🌈 D1');
    expect(hall).toHaveTextContent('🏋️ D2');
    // …and it is not merely showing the live labels by coincidence.
    expect(hall).not.toHaveTextContent('🏋️ D1');
    expect(hall).not.toHaveTextContent('🌈 D2');
  });

  it('labels a frozen honour by its ordinal when the record carries no label', () => {
    // A record written by hand rather than by the serializer — `eventConverter`
    // validates no field of a stored archive, so the absent `dayLabel` is
    // reachable whatever the contract declares. The fallback stays frozen-safe,
    // derived from the honour's own index, rather than reaching back into the live
    // schedule the way the bug did.
    H.event = archivedEvent({
      days: [{ index: 0, theme: 'get-sporty' }],
      archive: {
        ...FROZEN,
        dailyHonors: [
          { dayIndex: 0, uid: 'early-bird', displayName: 'Early Bird', firstBingoAt: 1_000 },
        ],
      },
    } as unknown as Partial<EventDoc>);
    renderLeaderboard();
    const hall = screen.getByLabelText('Hall of fame');
    expect(hall).toHaveTextContent('D1');
    expect(hall).not.toHaveTextContent('🏋️ D1');
  });

  it('offers no live controls — the archive is read-only', () => {
    renderLeaderboard();
    // The presentational filters belong to a live Leaderboard; a frozen record has
    // one shape.
    expect(screen.queryByRole('group', { name: 'Filter leaderboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'With BINGO' })).not.toBeInTheDocument();
    // The Share Card survives: a frozen leaderboard is the most shareable thing
    // the Event ever produced (#36, ADR 0005 — on-device, no crawler page).
    expect(screen.getByRole('button', { name: 'Share final standings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share leaderboard' })).not.toBeInTheDocument();
  });

  it('says so when the record retained only a prefix of a large roster', () => {
    H.event = archivedEvent({ archive: { ...FROZEN, playerCount: 240 } });
    const { container } = renderLeaderboard();
    expect(screen.getByText(/Showing the top 2 of 240 players/)).toBeInTheDocument();
    // With nothing hidden the sentence stays plain: the moderation clause is for
    // a record whose retained prefix is actually being narrowed, not a standing
    // "0 hidden" disclaimer on every truncated archive (#1152, Codex P3 on PR
    // #1165).
    expect(container.querySelector('.lb-footnote')).not.toHaveTextContent(
      /hidden by moderation/,
    );
  });

  // #1152, Codex P2 on PR #1165. The footnote used to promise that "nothing here
  // changes again" — which this page then contradicts on purpose, because the
  // freeze deliberately leaves `bannedUids` editable and the rows, honours,
  // headline and Share Card are all narrowed from the CURRENT roster. What is
  // permanent is the stored RECORD; what moderation can still move is which of
  // it is shown.
  it('scopes the permanence claim to the stored record, not to what is displayed', () => {
    const { container } = renderLeaderboard();
    expect(container.querySelector('.lb-footnote')).toHaveTextContent(
      'Frozen when the cruise was archived—the stored record never changes again, though moderation can still hide rows from view.',
    );
    expect(container.querySelector('.lb-footnote')).not.toHaveTextContent(
      /nothing here changes again/,
    );
  });

  it('falls back to the live Leaderboard when an archived Event carries no record', () => {
    // Not a state this app can produce — `archiveEvent` writes status, stamp and
    // record in one update — so a hand-edited document keeps rendering the live
    // view, which the rules have already made read-only on `status` alone.
    H.event = archivedEvent({ archive: undefined });
    renderLeaderboard();
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Filter leaderboard' })).toBeInTheDocument();
  });

  it('renders the live Leaderboard while the Event is still active', () => {
    H.event = liveEvent();
    renderLeaderboard();
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(screen.queryByText('Steady Eddie')).not.toBeInTheDocument();
  });
});

// A minimal in-memory `localStorage`, installed via `vi.stubGlobal`: jsdom
// leaves `window.localStorage` unset in this project (the `App.test.tsx` /
// `useTextSize.test.ts` note), and recent Node runtimes ship a built-in global
// of the same name that is present but non-functional without
// `--localstorage-file`. Bringing our own keeps the persisted-confirmation
// assertions below deterministic whichever one the runtime would resolve.
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

describe('the archived Leaderboard opens no live subscription (#1152)', () => {
  // specs/post-sailing-archive.md: "It subscribes to NOTHING." Asserting on the
  // rendered output cannot prove that — a component can ignore a hook's value and
  // still have opened its listener. These assert the hooks were never CALLED,
  // which is the only place the listener could come from.
  beforeEach(() => {
    H.players = liveRoster;
    H.event = archivedEvent();
    vi.stubGlobal('localStorage', createStorageStub());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never calls useLeaderboard, useDayMetasStatus or useProofKindsByUid', () => {
    renderLeaderboard();
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();
  });

  it('opens all three for a live Event, so the assertion above is not vacuous', () => {
    H.event = liveEvent();
    renderLeaderboard();
    expect(H.useLeaderboard).toHaveBeenCalled();
    expect(H.useDayMetasStatus).toHaveBeenCalled();
    expect(H.useProofKindsByUid).toHaveBeenCalled();
  });

  // Codex P2, PR #1139 round 5. The split only helps if the BRANCH is taken
  // against a status the server has confirmed. On a cold visit `useEventDoc`
  // starts at `data: null` and the ADR 0006 cache can then replay the Event as
  // `active` — so a routing half that fell through on either mounted the whole
  // listener fan on an archived Event and tore it down a snapshot later.
  it('opens nothing while the Event status is still unconfirmed by the server', () => {
    H.eventServerResolved = false;
    // The worst shape: a cached replay that says ACTIVE on an Event the server is
    // about to report as archived. Rendering it would open all three.
    H.event = liveEvent();
    renderLeaderboard();
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Tallying the leaderboard…');
  });

  it('renders the archive as soon as the server snapshot says archived', () => {
    // The same visit, one snapshot later. No live hook was ever called.
    H.eventServerResolved = false;
    H.event = liveEvent();
    const { container, rerender } = renderLeaderboard();
    H.eventServerResolved = true;
    H.event = archivedEvent();
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    // Read off the standings rows rather than by text: the frozen names also
    // appear in the hall of fame and in the offscreen Share Card host.
    expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();
  });

  it('mounts the live view once the server confirms the Event is not archived', () => {
    // The control: the wait ENDS, so the assertions above are about the gate
    // rather than about a Leaderboard that never renders anything.
    H.eventServerResolved = true;
    H.event = liveEvent();
    renderLeaderboard();
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(H.useLeaderboard).toHaveBeenCalled();
  });

  it('renders a cached archive without waiting for the server', () => {
    // `status: 'archived'` is write-once at the rules boundary, so a cached one
    // can never be contradicted — the archive is the one answer that needs no
    // confirmation, and making it wait would slow the surface the gate exists to
    // protect.
    H.eventServerResolved = false;
    H.eventFromCache = true;
    H.event = archivedEvent();
    const { container } = renderLeaderboard();
    expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
    expect(H.useLeaderboard).not.toHaveBeenCalled();
  });

  // The `App.tsx` Card-redirect rule (Codex P2 on PR #1157, round 9) applied to
  // the surface that redirect points AT: an Admin's own flip is emitted locally
  // before the rules decide it, and a refusal rolls it back to open.
  it('declines an archive this device has written but the server has not acked', () => {
    H.eventPendingWrites = true;
    H.event = archivedEvent();
    renderLeaderboard();
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(screen.queryByText('Steady Eddie')).not.toBeInTheDocument();
    expect(H.useLeaderboard).toHaveBeenCalled();
  });

  it('renders the archive the moment that write is acked', () => {
    H.eventPendingWrites = true;
    H.event = archivedEvent();
    const { container, rerender } = renderLeaderboard();
    H.eventPendingWrites = false;
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
  });

  // Codex P2 on PR #1165. `hasPendingWrites` is a flag on the WHOLE snapshot, so
  // a ban lands on it as loudly as the archive flip does — and the guard above
  // read that as "this archive is unconfirmed", dropped back to the live view and
  // reopened the three listeners over a record the server settled long ago.
  it('keeps the frozen surface mounted while a later moderation write is pending', () => {
    H.event = archivedEvent(); // server-backed, no local write: the flip is committed
    const { container, rerender } = renderLeaderboard();
    expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);

    // The Admin bans someone. Firestore marks the Event snapshot pending even
    // though only `bannedUids` moved, and offline it stays pending indefinitely.
    H.eventPendingWrites = true;
    H.event = archivedEvent({ bannedUids: ['steady'] });
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    // Still the frozen record, minus the banned row — never the live standings.
    expect(frozenNames(container)).toEqual(['Early Bird']);
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();
  });

  it('latches only a SERVER-COMMITTED archive, never the optimistic flip itself', () => {
    // The non-vacuity guard for the latch above: an Admin's own unacked flip must
    // still be declined however many times it re-renders, because a refusal rolls
    // it back to open.
    H.eventPendingWrites = true;
    H.event = archivedEvent();
    const { rerender } = renderLeaderboard();
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(H.useLeaderboard).toHaveBeenCalled();
  });

  // Codex P2 on PR #1165. The in-session latch above only covers moderation that
  // starts AFTER this mount has seen a clean server snapshot. A tab reloaded, or
  // the Leaderboard revisited, while an offline ban is still queued has no such
  // history — so the confirmation is persisted per archive GENERATION and read
  // back at mount. `EVENT_ID` is `'test-event'` (the `../firebase` stub above).
  const confirmedKey = 'gcb.archive.test-event.confirmedUnder';

  it('keeps a cached archive frozen on a FRESH mount with a moderation write pending', () => {
    // Seeded through the SHARED subscription's own writer rather than by hand
    // (Codex P2 on PR #1165): the route that observed the committed flip is
    // whichever one held `useEventDoc` at the time — the Admin console, here —
    // and driving `recordArchiveConfirmation` is what pins the writer and this
    // reader to one spelling of the key now that they live in different modules.
    recordArchiveConfirmation('test-event', archivedEvent({ archivedUnder: 3 }), {
      fromCache: false,
      hasPendingWrites: false,
    });
    expect(window.localStorage.getItem(confirmedKey)).toBe('3');
    H.eventPendingWrites = true; // the queued ban, not the flip
    H.eventFromCache = true;
    H.eventServerResolved = false;
    H.event = archivedEvent({ archivedUnder: 3 });
    const { container } = renderLeaderboard();
    expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();
  });

  it('still declines an optimistic flip on a fresh mount, with nothing persisted', () => {
    // The non-vacuity half: without a record of the server having committed it,
    // an Admin's own unacked flip is exactly the state the guard exists for. The
    // cached status has not settled yet either, so the decline shows up as the
    // live child one settle window later rather than immediately.
    vi.useFakeTimers();
    try {
      H.eventPendingWrites = true;
      H.eventFromCache = true;
      H.eventServerResolved = false;
      H.event = archivedEvent({ archivedUnder: 3 });
      renderLeaderboard();
      act(() => {
        vi.advanceTimersByTime(CACHED_EVENT_SETTLE_MS);
      });
      expect(screen.getByText('Late Riser')).toBeInTheDocument();
      expect(H.useLeaderboard).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not confirm an archive under a DIFFERENT generation from the persisted one', () => {
    // The generation is what makes the record mean "this archive", rather than
    // "some archive": a confirmation left by an earlier quiesce must not vouch
    // for a flip bound to another one.
    vi.useFakeTimers();
    try {
      window.localStorage.setItem(confirmedKey, '7');
      H.eventPendingWrites = true;
      H.eventFromCache = true;
      H.eventServerResolved = false;
      H.event = archivedEvent({ archivedUnder: 3 });
      renderLeaderboard();
      act(() => {
        vi.advanceTimersByTime(CACHED_EVENT_SETTLE_MS);
      });
      expect(screen.getByText('Late Riser')).toBeInTheDocument();
      expect(H.useLeaderboard).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the WRITE to the shared Event subscription, and records nothing itself', () => {
    // Codex P2 on PR #1165. The other end of the round trip is no longer this
    // component's: `useEventDoc` records a server-committed archive on whatever
    // route observes it, because the visit that NEEDS the record is exactly the
    // one where another route saw the commit — an Admin who receives it on the
    // console, queues an offline ban there, and only then opens the standings.
    // A Leaderboard that wrote its own record could never help that mount.
    //
    // `../hooks/useData` is stubbed in this file, so the shared writer is not
    // running here: a mount over a fully committed archive must leave the slot
    // untouched. (The subscription's own write is pinned against the real hook
    // in `src/hooks/useData.test.ts` § "useEventDoc records a server-committed
    // archive for every route (#1152)".)
    H.event = archivedEvent({ archivedUnder: 3 });
    renderLeaderboard();
    expect(window.localStorage.getItem(confirmedKey)).toBeNull();
  });

  it('stops waiting when the browser says the client is offline', () => {
    // ADR 0006: this app is offline-durable, and an offline client's Event
    // subscription is answered by the cache forever. A gate that waited for a
    // server snapshot anyway would leave the Leaderboard on a spinner for the
    // whole crossing, which is worse than the listeners it is avoiding.
    H.eventServerResolved = false;
    H.online = false;
    H.event = liveEvent();
    renderLeaderboard();
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(H.useLeaderboard).toHaveBeenCalled();
  });

  // Codex P2 on PR #1165. The escape above is read on the FIRST render of a cold
  // offline mount, where `useEventDoc` has not delivered anything yet — so
  // `!online` alone settled the status over `data: null` and mounted the live
  // child, opening the whole fan the archived surface exists not to open and
  // tearing it down one snapshot later. Offline has to wait for the CACHE.
  it('opens nothing on an offline cold mount, and renders the cached archive when it lands', () => {
    H.online = false;
    H.eventServerResolved = false;
    H.eventLoading = true; // the cache read is still in flight
    H.eventFromCache = true;
    H.event = null; // …so there is no Event to decide anything from yet
    const { container, rerender } = renderLeaderboard();
    expect(screen.getByRole('status')).toHaveTextContent('Tallying the leaderboard…');
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();

    H.eventLoading = false; // the cache answers: this Event was archived
    H.event = archivedEvent();
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();
  });

  it('still reaches the live child offline once the cache says the Event is live', () => {
    // The control: the offline wait ENDS at the cache result rather than at a
    // server snapshot that is never coming, so this is one render longer than it
    // used to be and not a spinner for the whole crossing.
    H.online = false;
    H.eventServerResolved = false;
    H.eventLoading = true;
    H.eventFromCache = true;
    H.event = null;
    const { rerender } = renderLeaderboard();
    expect(H.useLeaderboard).not.toHaveBeenCalled();

    H.eventLoading = false;
    H.event = liveEvent();
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(H.useLeaderboard).toHaveBeenCalled();
  });

  // Codex P1 on PR #1165. Behind a captive or partially routed portal — the
  // ship's ordinary Wi-Fi — Firestore cannot reach the server while the browser
  // still reports ONLINE: the cached Event arrives with `fromCache: true`, the
  // subscription retries rather than erroring, and neither `serverResolved` nor
  // `useOnline` ever moves. Both escapes above are shut, and the gate held its
  // spinner for the whole crossing. The bounded wait is the third escape.
  it('settles on a cached ACTIVE Event when the server never answers behind a portal', () => {
    vi.useFakeTimers();
    try {
      H.eventServerResolved = false; // the server has said nothing…
      H.eventFromCache = true; // …and the cache is what answered
      H.online = true; // …while the portal reports a perfectly good link
      H.event = liveEvent();
      renderLeaderboard();
      expect(screen.getByRole('status')).toHaveTextContent('Tallying the leaderboard…');
      expect(H.useLeaderboard).not.toHaveBeenCalled();

      // BOUNDED, not immediate: a slow server answer must still get its window.
      act(() => {
        vi.advanceTimersByTime(CACHED_EVENT_SETTLE_MS - 1);
      });
      expect(screen.getByRole('status')).toHaveTextContent('Tallying the leaderboard…');
      expect(H.useLeaderboard).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByText('Late Riser')).toBeInTheDocument();
      expect(H.useLeaderboard).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles on a cached ARCHIVED Event in that same state, and opens nothing', () => {
    // The other half of what "settle on the cached Event" means, and the guard
    // that the wait above cannot route a frozen Event to the live child. The
    // archived branch already sits ahead of the wait, so this passes with the
    // bounded wait removed too — it is here to keep it that way.
    vi.useFakeTimers();
    try {
      H.eventServerResolved = false;
      H.eventFromCache = true;
      H.online = true;
      H.event = archivedEvent();
      const { container } = renderLeaderboard();
      expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);

      act(() => {
        vi.advanceTimersByTime(CACHED_EVENT_SETTLE_MS * 2);
      });
      expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
      expect(H.useLeaderboard).not.toHaveBeenCalled();
      expect(H.useDayMetasStatus).not.toHaveBeenCalled();
      expect(H.useProofKindsByUid).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a server snapshot inside the window win over the cached one', () => {
    // The wait is a floor on how long a Player stares at a spinner, never a
    // deadline the truth has to beat: an answer inside the window resolves the
    // status outright and cancels the timer with it, so the cached `active`
    // replay never gets to settle anything. Also unchanged by the bounded wait —
    // it is what must stay true once the wait exists.
    vi.useFakeTimers();
    try {
      H.eventServerResolved = false;
      H.eventFromCache = true;
      H.online = true;
      H.event = liveEvent();
      const { container, rerender } = renderLeaderboard();
      expect(H.useLeaderboard).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(Math.floor(CACHED_EVENT_SETTLE_MS / 2));
      });
      // The server answers, and it contradicts the cache.
      H.eventServerResolved = true;
      H.eventFromCache = false;
      H.event = archivedEvent();
      rerender(
        <MemoryRouter>
          <Leaderboard />
        </MemoryRouter>,
      );
      expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);

      // …and the cancelled timer cannot fire the cached `active` back on later.
      act(() => {
        vi.advanceTimersByTime(CACHED_EVENT_SETTLE_MS * 2);
      });
      expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
      expect(H.useLeaderboard).not.toHaveBeenCalled();
      expect(H.useDayMetasStatus).not.toHaveBeenCalled();
      expect(H.useProofKindsByUid).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not bounce an already-routed live view back through the spinner on a reconnect', () => {
    // The latch is MONOTONE: unmounting `LiveLeaderboard` would drop its three
    // listeners and reset the Player's filter with them.
    H.eventServerResolved = false;
    H.online = false;
    H.event = liveEvent();
    const { rerender } = renderLeaderboard();
    expect(screen.getByText('Late Riser')).toBeInTheDocument();

    H.online = true; // reconnected; the server snapshot is still a round trip away
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(screen.queryByText('Tallying the leaderboard…')).not.toBeInTheDocument();
  });

  it('tears the live subscriptions down when the Event flips to archived', () => {
    H.event = liveEvent();
    const { rerender } = renderLeaderboard();
    expect(H.useLeaderboard).toHaveBeenCalled();
    H.useLeaderboard.mockClear();
    H.useDayMetasStatus.mockClear();
    H.useProofKindsByUid.mockClear();
    H.event = archivedEvent();
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    // The live child unmounts, taking its listeners with it — no further call.
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();
  });
});

describe('a ban still hides a Player after the freeze (#1152)', () => {
  // specs/w2-ban-console.md § Leaderboard, made permanent: every public
  // Leaderboard view hides a banned Player, and moderation deliberately stays
  // available after the freeze (`bannedUids` is outside the write-once clause).
  beforeEach(() => {
    H.players = liveRoster;
  });

  it('drops the banned row from the standings without promoting anyone', () => {
    H.event = archivedEvent({ bannedUids: ['early-bird'] });
    const { container } = renderLeaderboard();
    const rows = [...container.querySelectorAll('.list .row')];
    expect(rows.map((r) => r.querySelector('.name')?.textContent)).toEqual(['Steady Eddie']);
    // The list closes the gap exactly as the LIVE Leaderboard does when it hides a
    // banned row — leaving a hole at #1 would advertise that a row was removed,
    // which is the opposite of what hiding is for. What must NOT move is the
    // HONOUR: the runner-up is renumbered, never promoted into the star.
    expect(rows[0]?.querySelector('.rank')?.textContent).toBe('1');
    expect(rows[0]?.classList.contains('leader')).toBe(false);
    expect(screen.queryByText('⭐ First BINGO')).not.toBeInTheDocument();
    // And the stored record is untouched underneath: an unban restores the row
    // with its own numbers intact.
    expect(FROZEN.standings.map((r) => r.uid)).toEqual(['early-bird', 'steady']);
  });

  it('vacates the headline honour and the banned Player’s daily chip', () => {
    H.event = archivedEvent({ bannedUids: ['early-bird'] });
    renderLeaderboard();
    const hall = screen.getByLabelText('Hall of fame');
    // Vacated, never reassigned — Steady Eddie does not inherit the star.
    expect(hall).toHaveTextContent('No one got there.');
    expect(hall).not.toHaveTextContent('Early Bird');
    expect(hall).toHaveTextContent('D2');
    expect(hall).not.toHaveTextContent('D1');
  });

  it('keeps the truncation footnote keyed on the STORED pair, not on who is hidden', () => {
    // A ban is not a truncation: an un-truncated archive must not start claiming
    // it was cut short just because one row is currently hidden.
    H.event = archivedEvent({ bannedUids: ['early-bird'] });
    const { container } = renderLeaderboard();
    // The ban really did hide a row, so the absent footnote below is about the
    // stored pair rather than about an archive that never rendered.
    expect(frozenNames(container)).toEqual(['Steady Eddie']);
    expect(container.querySelector('.lb-footnote')).toHaveTextContent(
      /the stored record never changes again/,
    );
    expect(screen.queryByText(/Showing the top/)).not.toBeInTheDocument();
  });

  // Codex P3 on PR #1165 round 7. "The top N of M" is a claim about the frozen
  // RANK CUTOFF, and `standings.length` is the stored rows minus whoever is
  // banned right now — a different number and a different fact. Hiding rank 1 of
  // a 200-of-300 record made the note say "the top 199 of 300" while the rows on
  // screen still included the originally ranked #200, which is not the top 199 of
  // anything.
  it('reports the STORED prefix and counts the moderated rows separately', () => {
    // A truncated record — two stored rows standing in for the retained prefix of
    // a 240-Player roster — with rank 1 hidden after the freeze.
    H.event = archivedEvent({
      bannedUids: ['early-bird'],
      archive: { ...FROZEN, playerCount: 240 },
    });
    const { container } = renderLeaderboard();

    // The ban really did hide a row, so the cutoff below is the stored one rather
    // than a record nothing was removed from.
    expect(frozenNames(container)).toEqual(['Steady Eddie']);
    expect(container.querySelector('.lb-footnote')).toHaveTextContent(
      'Showing the top 2 of 240 players, 1 hidden by moderation.',
    );
    // The visible-row count is what the old sentence reported, and it is not the
    // cutoff: the one row still on screen was ranked #2 in the frozen record.
    expect(container.querySelector('.lb-footnote')).not.toHaveTextContent(
      /Showing the top 1 of 240/,
    );
  });

  it('keeps the whole record when nobody is banned', () => {
    H.event = archivedEvent({ bannedUids: ['someone-else'] });
    const { container } = renderLeaderboard();
    expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
    expect(screen.getByLabelText('Hall of fame')).toHaveTextContent('Early Bird');
  });

  // Codex P2 on PR #1165 round 4. When moderation hides EVERY visible row the
  // empty state used to say nobody was ever on the board — which the record
  // itself contradicts two elements down, where the frozen `playerCount` is
  // printed. A ban decides who is SHOWN; it never re-rules who took part, and the
  // archive's whole promise is that the participation history does not move.
  it('says the standings are hidden, not that nobody played, when every row is banned', () => {
    // A one-Player Event whose Player is banned after the freeze: the record
    // still counts them, and no row survives the filter.
    H.event = archivedEvent({
      bannedUids: ['solo'],
      archive: {
        ...FROZEN,
        standings: [
          {
            uid: 'solo',
            displayName: 'Solo Sailor',
            bingoCount: 2,
            squaresMarked: 9,
            blackout: false,
            firstBingoAt: 1_000,
          },
        ],
        playerCount: 1,
        firstBingo: null,
        firstBingoRow: null,
        dailyHonors: [],
      },
    });
    const { container } = renderLeaderboard();

    expect(frozenNames(container)).toEqual([]);
    expect(container.querySelector('.lb-empty')).toHaveTextContent(
      '1 player was on the board\u2014every row this record carries is hidden by moderation.',
    );
    expect(screen.queryByText('No players were on the board.')).not.toBeInTheDocument();
  });

  it('still says nobody was on the board for an archive that counted no players', () => {
    // The empty state the copy above must not replace: a record whose frozen
    // `playerCount` really is zero, where "nobody" is the truth rather than a
    // moderation artefact.
    H.event = archivedEvent({
      archive: {
        ...FROZEN,
        standings: [],
        playerCount: 0,
        firstBingo: null,
        firstBingoRow: null,
        dailyHonors: [],
      },
    });
    const { container } = renderLeaderboard();

    expect(container.querySelector('.lb-empty')).toHaveTextContent(
      'No players were on the board.',
    );
    expect(screen.queryByText(/hidden by moderation/)).not.toBeInTheDocument();
  });

  it('brings the row back on an unban, exactly as it was', () => {
    H.event = archivedEvent({ bannedUids: ['early-bird'] });
    const { container, rerender } = renderLeaderboard();
    expect(frozenNames(container)).toEqual(['Steady Eddie']);

    H.event = archivedEvent({ bannedUids: [] });
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    expect(frozenNames(container)).toEqual(['Early Bird', 'Steady Eddie']);
    expect(container.querySelector('.list .row.leader .name')).toHaveTextContent('Early Bird');
  });
});
